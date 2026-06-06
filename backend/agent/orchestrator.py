"""Orchestrator — Cairn's agent brain.

Owns the relationship graph, drives the discovery engine, and calls Groq at
the moments where reasoning is needed (post-discovery observation, SPL
explanation, guide synthesis, follow-up Q&A).

Design notes:

- The exploration flow is **linear** rather than iterative. We previously
  ran a Decide → Reason → Investigate loop with multiple LLM round-trips per
  iteration; on Groq's free tier (30 req/min on Llama 3.3 70B) that ran us
  into rate limits quickly. The new flow runs each LLM-touching step once:
  Orient → Discover → Reason (1 call) → Enrich → Resolve → Usage → Explain
  alert SPL (~3 calls) → Done.
- Guide synthesis is **decoupled** from explore. Call ``generate_guide()``
  separately; it yields events for each of 5 sections, with one Groq call
  per section.
- All Groq calls funnel through ``_llm_call``, which acquires a slot from
  a process-wide rate limiter and retries on ``RateLimitError``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any
from xml.sax.saxutils import escape

from groq import AsyncGroq

try:
    from groq import RateLimitError  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover — older groq versions
    RateLimitError = Exception  # type: ignore[misc,assignment]

from config import Settings, get_settings
from mcp_client import SplunkMCPClient, SplunkMCPError

from .discovery import _ALLOWED_LOOKUPS, _ALLOWED_MACROS, DiscoveryEngine, Finding
from .findings import (
    CATEGORY_ALERT_EMPTY_INDEX,
    CATEGORY_ALERT_NO_ACTION,
    CATEGORY_ALERT_NO_OWNER,
    CATEGORY_ORPHAN,
    SEV_HIGH,
    SEV_LOW,
    SEV_MEDIUM,
    FindingsReport,
)
from .findings import Finding as HygieneFinding
from .graph import EdgeType, NodeType, RelationshipGraph, SPLParser
from .starter_kit import DashboardPanel, GeneratedSPL, Runbook, StarterKit

logger = logging.getLogger(__name__)


# Deliberately-planted Mode B landmines — these objects genuinely have no
# referrers and SHOULD surface as orphans. An object with zero incoming edges
# that is *not* in this set but *is* in our discovery allowlists is almost
# certainly a false positive from the MCP 100-item cap (its referrer never got
# discovered), so we suppress it. (See ``_run_generate_findings`` orphan scan.)
_EXPECTED_ORPHANS: frozenset[str] = frozenset({
    "deprecated_geoip_filter",  # orphaned macro (landmine)
    "service_owners.csv",       # orphaned lookup (landmine)
    "service_owners",           # same, without the file extension
})

# Cap on LLM-backed ``fix_spl`` generations during a single findings run, so a
# large/noisy environment can't exhaust the Groq rate limit on remediations.
_MAX_FINDING_FIX_SPL_CALLS = 4


# User-facing fallbacks shown when the LLM can't be reached (e.g. Groq's
# free-tier daily/RPM cap is hit and retries are exhausted). We never surface
# raw error JSON or stack traces as guide / answer content.
_RATE_LIMIT_SECTION_FALLBACK = (
    "[This section could not be generated due to API rate limits. "
    "Please wait a few minutes and try re-exploring.]"
)
_SECTION_UNAVAILABLE_MESSAGE = (
    "This section is temporarily unavailable. The AI service rate limit was "
    "reached. Please re-explore in a few minutes to generate this content."
)
_ASK_UNAVAILABLE_MESSAGE = (
    "I'm temporarily unable to answer — the AI service rate limit was reached. "
    "Please try again in a few minutes."
)


# ---- Events ---------------------------------------------------------------


class AgentPhase(str, Enum):
    ORIENT = "orient"
    REASON = "reason"
    INVESTIGATE = "investigate"
    SYNTHESIZE = "synthesize"
    DONE = "done"
    ERROR = "error"


@dataclass
class AgentEvent:
    """Streamed to the UI via SSE."""

    phase: AgentPhase
    message: str
    detail: str | None = None
    data: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "phase": self.phase.value,
            "message": self.message,
            "detail": self.detail,
            "data": self.data or {},
        }


# ---- Guide -----------------------------------------------------------------


@dataclass
class OnboardingGuide:
    """The final artifact Cairn produces."""

    markdown: str
    sections: dict[str, str] = field(default_factory=dict)
    graph_snapshot: dict[str, Any] = field(default_factory=dict)
    # The trimmed node / edge lists the frontend RelationshipGraph renders.
    # Separate from ``graph_snapshot`` (which carries the full, unfiltered
    # graph) so the UI can draw the dependency picture without re-filtering.
    graph_nodes: list[dict[str, Any]] = field(default_factory=list)
    graph_edges: list[dict[str, Any]] = field(default_factory=list)
    # MLTK footprint counts — surfaced so the UI can badge the "AI & ML
    # Footprint" nav item without re-parsing the section markdown. Both 0 when
    # the AI Toolkit isn't installed (and the section is then absent entirely).
    mltk_algorithm_count: int = 0
    mltk_model_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---- Rate limiter ----------------------------------------------------------


class RateLimiter:
    """Token-bucket-ish limiter for Groq's free tier.

    Default is 25 requests per 60 seconds — Groq's published Llama 3.3 70B
    free-tier limit is 30 RPM; we leave headroom for the occasional retry.
    The limiter is async-safe (``acquire`` awaits when the bucket is full).
    """

    def __init__(self, max_requests: int = 25, period: float = 60.0) -> None:
        self._max = max_requests
        self._period = period
        self._timestamps: list[float] = []
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            self._timestamps = [t for t in self._timestamps if now - t < self._period]
            if len(self._timestamps) >= self._max:
                sleep_for = self._period - (now - self._timestamps[0]) + 0.1
                logger.info("rate limit: sleeping %.2fs", sleep_for)
                await asyncio.sleep(sleep_for)
                now = time.monotonic()
                self._timestamps = [t for t in self._timestamps if now - t < self._period]
            self._timestamps.append(time.monotonic())


# ---- Orchestrator ---------------------------------------------------------


class Orchestrator:
    """Cairn's agent brain. Owns the loop, the graph, and the LLM client."""

    def __init__(
        self,
        mcp_client: SplunkMCPClient,
        *,
        settings: Settings | None = None,
        llm: AsyncGroq | None = None,
        rate_limiter: RateLimiter | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._mcp = mcp_client
        self._graph = RelationshipGraph()
        self._llm = llm or AsyncGroq(
            api_key=self._settings.groq_api_key.get_secret_value()
        )
        self._rate_limiter = rate_limiter or RateLimiter(max_requests=25, period=60.0)
        # Pass our rate-limited LLM helper into discovery so it can explain
        # SPL on user-facing artifacts without owning a Groq client itself.
        self._discovery = DiscoveryEngine(
            mcp_client,
            self._graph,
            parser=SPLParser(),
            llm_call=self._llm_call,
            explain_spl_call=self._explain_spl_with_fallback,
        )
        self._guide: OnboardingGuide | None = None
        self._starter_kit: StarterKit | None = None
        self._findings: FindingsReport | None = None
        # MLTK / AI-Toolkit footprint, populated during explore (empty when the
        # toolkit isn't installed — the guide section is skipped in that case).
        self._mltk_algorithms: list[dict[str, Any]] = []
        self._mltk_models: list[dict[str, Any]] = []
        self._lock = asyncio.Lock()

    # ---- public accessors ----

    @property
    def graph(self) -> RelationshipGraph:
        return self._graph

    @property
    def guide(self) -> OnboardingGuide | None:
        return self._guide

    @property
    def starter_kit(self) -> StarterKit | None:
        return self._starter_kit

    @property
    def findings(self) -> FindingsReport | None:
        return self._findings

    # ---- LLM call helper ----

    async def _llm_call(
        self,
        prompt: str,
        max_tokens: int = 1000,
        *,
        max_retries: int = 3,
    ) -> str:
        """Single funnel for every Groq call. Rate-limited + retried."""
        last_exc: Exception | None = None
        for attempt in range(max_retries):
            await self._rate_limiter.acquire()
            try:
                response = await self._llm.chat.completions.create(
                    model=self._settings.groq_model,
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=max_tokens,
                )
                return _extract_text(response)
            except RateLimitError as exc:
                last_exc = exc
                backoff = 5.0 * (attempt + 1)
                logger.warning(
                    "Groq rate-limit (attempt %d/%d); sleeping %.1fs",
                    attempt + 1,
                    max_retries,
                    backoff,
                )
                await asyncio.sleep(backoff)
            except Exception as exc:
                # Non-rate-limit errors get one quick retry; the second crash bubbles up.
                last_exc = exc
                if attempt + 1 == max_retries:
                    raise
                logger.warning("Groq call failed (attempt %d): %s — retrying", attempt + 1, exc)
                await asyncio.sleep(1.0)
        # Retries exhausted. If we got here it was rate-limit driven (other
        # exceptions bubble up above); return a user-friendly fallback rather
        # than raising raw error JSON up into guide / answer content.
        logger.error("Groq call exhausted retries (rate-limited): %s", last_exc)
        return _RATE_LIMIT_SECTION_FALLBACK

    # ---- SPL explanation (MCP-first, LLM fallback) ----

    async def _explain_spl_with_fallback(self, spl: str, max_tokens: int = 500) -> str:
        """Explain an SPL string, preferring the native ``saia_explain_spl`` tool.

        We try Splunk's AI Assistant for SPL first — it understands this
        deployment's own macros, lookups and indexes — and fall back to Groq
        only when the tool is unavailable on this instance or errors out. The
        LLM fallback is always present, so explanation never hard-fails.
        """
        if self._mcp.has_saia():
            try:
                explanation = (await self._mcp.explain_spl(spl)).strip()
                if explanation and "error" not in explanation.lower():
                    return explanation
                logger.warning(
                    "saia_explain_spl returned an empty/error result, falling back to LLM"
                )
            except Exception as exc:  # noqa: BLE001 - any failure routes to the LLM
                logger.warning("saia_explain_spl unavailable, falling back to LLM: %s", exc)

        return await self._llm_call(
            "Explain the following SPL query in plain English for a Splunk "
            "newcomer being onboarded onto this deployment. Identify what it "
            "searches, what fields it filters/aggregates, and what macros / "
            "lookups / indexes it depends on. Be concise — 3 short paragraphs "
            f"max.\n\nSPL:\n```\n{spl}\n```",
            max_tokens,
        )

    # ---- SPL generation (MCP-first, LLM fallback) ----

    async def _generate_spl_with_fallback(self, description: str) -> str:
        """Turn a natural-language task into SPL, preferring ``saia_generate_spl``.

        The native tool knows this deployment's own indexes and sourcetypes;
        we fall back to a rate-limited Groq call (grounded in the discovered
        user indexes) only when it's unavailable or returns nothing useful, so
        generation never hard-fails.
        """
        if self._mcp.has_saia():
            try:
                spl = (await self._mcp.generate_spl(description)).strip()
                if spl and "error" not in spl.lower():
                    return spl
                logger.warning(
                    "saia_generate_spl returned an empty/error result, falling back to LLM"
                )
            except Exception as exc:  # noqa: BLE001 - any failure routes to the LLM
                logger.warning("saia_generate_spl unavailable, falling back to LLM: %s", exc)

        indexes = self._user_index_summaries()
        prompt = (
            "You are a Splunk SPL expert. Generate an SPL query for this task. "
            "Respond with ONLY the SPL query, nothing else.\n\n"
            f"Task: {description}\n\n"
            f"Available indexes: {json.dumps(indexes, indent=2)}"
        )
        return _clean_spl_response((await self._llm_call(prompt, max_tokens=300)).strip())

    # ---- SPL optimization (MCP-first, LLM fallback) ----

    async def _optimize_spl_with_fallback(self, spl: str, max_tokens: int = 500) -> str:
        """Suggest a faster/cleaner version of ``spl``, preferring ``saia_optimize_spl``.

        Falls back to a rate-limited Groq call on failure. The result is a
        suggestion (a one-sentence rationale plus the optimized SPL), not a
        bare query, so we don't strip code fences the way generation does.
        """
        if self._mcp.has_saia():
            try:
                optimized = (await self._mcp.optimize_spl(spl)).strip()
                if optimized and "error" not in optimized.lower():
                    return optimized
                logger.warning(
                    "saia_optimize_spl returned an empty/error result, falling back to LLM"
                )
            except Exception as exc:  # noqa: BLE001 - any failure routes to the LLM
                logger.warning("saia_optimize_spl unavailable, falling back to LLM: %s", exc)

        prompt = (
            "You are a Splunk SPL expert. Suggest an optimized version of this "
            "query. Explain what you changed and why in one sentence, then give "
            f"the optimized SPL.\n\nOriginal SPL: {spl}"
        )
        return (await self._llm_call(prompt, max_tokens=max_tokens)).strip()

    # ---- Flag -> Fix: generated SPL remediations for findings ----

    async def _safe_generate_fix(self, description: str) -> str:
        """Best-effort generated SPL fix; never raises (returns '' on failure)."""
        try:
            return await self._generate_spl_with_fallback(description)
        except Exception as exc:  # noqa: BLE001 - a finding's fix_spl is optional
            logger.warning("fix_spl generation failed: %s", exc)
            return ""

    async def _safe_optimize_fix(self, spl: str) -> str:
        """Best-effort optimized SPL fix; never raises (returns '' on failure)."""
        try:
            return await self._optimize_spl_with_fallback(spl, max_tokens=300)
        except Exception as exc:  # noqa: BLE001 - a finding's fix_spl is optional
            logger.warning("fix_spl optimization failed: %s", exc)
            return ""

    def environment_counts(self) -> dict[str, int]:
        """User-facing object counts by type — backs the export quick-reference.

        Skips placeholders (referenced-but-undiscovered) and Splunk-internal
        ``_*`` indexes so the numbers match what the guide actually documents.
        """
        counts = {
            "index": 0,
            "alert": 0,
            "saved_search": 0,
            "macro": 0,
            "lookup": 0,
            "dashboard": 0,
        }
        for node in self._graph.nodes():
            if node.properties.get("placeholder"):
                continue
            kind = node.type.value
            if kind == "index" and node.name.startswith("_"):
                continue
            if kind in counts:
                counts[kind] += 1
        return counts

    # ---- The main exploration flow ----

    async def explore(self) -> AsyncIterator[AgentEvent]:
        """Run the linear exploration flow. Yields events as work progresses."""
        async with self._lock:
            try:
                async for event in self._run_explore():
                    yield event
            except Exception as exc:
                logger.exception("explore loop crashed")
                yield AgentEvent(
                    phase=AgentPhase.ERROR,
                    message="exploration failed",
                    detail=str(exc),
                )

    def _with_graph(self, event: AgentEvent) -> AgentEvent:
        """Attach the current relationship-graph snapshot to an event.

        The frontend accumulates these node / edge lists as exploration
        streams, so the graph visualization can build itself in real time.
        We send the full current view (not just the delta) — with demo-sized
        graphs it's a handful of KB, and the client just keeps the latest.
        """
        rel = self._graph.relationship_view()
        data = dict(event.data or {})
        data["graph_nodes"] = rel["nodes"]
        data["graph_edges"] = rel["edges"]
        event.data = data
        return event

    async def _run_explore(self) -> AsyncIterator[AgentEvent]:
        # ---- Orient ----
        yield AgentEvent(phase=AgentPhase.ORIENT, message="getting the lay of the land")
        async for finding in self._discovery.orient():
            yield self._with_graph(_finding_to_event(AgentPhase.ORIENT, finding))
            await self._discovery.yield_back()

        # ---- Discover knowledge objects ----
        yield AgentEvent(
            phase=AgentPhase.INVESTIGATE, message="enumerating knowledge objects"
        )
        async for finding in self._discovery.discover_knowledge_objects():
            yield self._with_graph(_finding_to_event(AgentPhase.INVESTIGATE, finding))
            await self._discovery.yield_back()

        # ---- Reason: high-level observation post-discovery (1 LLM call) ----
        yield AgentEvent(
            phase=AgentPhase.REASON,
            message="asking the LLM to summarize what stands out so far",
        )
        try:
            observation = await self._reason_about_discovery()
        except Exception as exc:
            yield AgentEvent(
                phase=AgentPhase.ERROR,
                message="reasoning step failed; continuing",
                detail=str(exc),
            )
            observation = ""
        if observation:
            yield AgentEvent(
                phase=AgentPhase.REASON,
                message="LLM observation",
                data={"observation": observation},
            )

        # ---- Enrich indexes ----
        yield AgentEvent(phase=AgentPhase.INVESTIGATE, message="profiling indexes")
        async for finding in self._discovery.enrich_indexes():
            yield self._with_graph(_finding_to_event(AgentPhase.INVESTIGATE, finding))
            await self._discovery.yield_back()

        # ---- Resolve placeholders ----
        unresolved = self._graph.placeholders()
        if unresolved:
            yield AgentEvent(
                phase=AgentPhase.INVESTIGATE,
                message=f"resolving {len(unresolved)} placeholder reference(s)",
                data={"placeholders": [p.name for p in unresolved][:20]},
            )
            async for finding in self._discovery.resolve_placeholders():
                yield self._with_graph(_finding_to_event(AgentPhase.INVESTIGATE, finding))

        # ---- Usage data ----
        yield AgentEvent(
            phase=AgentPhase.INVESTIGATE, message="reading _audit for real usage signals"
        )
        async for finding in self._discovery.gather_usage():
            yield _finding_to_event(AgentPhase.INVESTIGATE, finding)

        # ---- Explain SPL for alerts (saia_explain_spl first, LLM fallback) ----
        yield AgentEvent(
            phase=AgentPhase.INVESTIGATE,
            message="explaining alert SPL"
            + (" via saia_explain_spl" if self._mcp.has_saia() else " via the LLM"),
        )
        async for finding in self._discovery.explain_user_facing_spls(
            node_types=(NodeType.ALERT,),
            max_explanations=5,
        ):
            yield _finding_to_event(AgentPhase.INVESTIGATE, finding)

        # ---- AI / ML footprint (optional — the AI Toolkit may not be installed) ----
        await self._fetch_mltk_footprint()
        if self._mltk_algorithms or self._mltk_models:
            yield AgentEvent(
                phase=AgentPhase.INVESTIGATE,
                message=(
                    f"mapped the AI/ML footprint: {len(self._mltk_algorithms)} MLTK "
                    f"algorithm(s), {len(self._mltk_models)} trained model(s)"
                ),
                data={
                    "mltk_algorithms": len(self._mltk_algorithms),
                    "mltk_models": len(self._mltk_models),
                },
            )

        yield self._with_graph(
            AgentEvent(
                phase=AgentPhase.DONE,
                message="exploration complete; ready to generate guide",
                data={"summary": self._graph.summary()},
            )
        )

    # ---- MLTK / AI footprint ----

    async def _fetch_mltk_footprint(self) -> None:
        """Fetch the AI-Toolkit footprint (available algorithms + trained models).

        Best-effort: if MLTK isn't installed the MCP calls error or return
        nothing, leaving both lists empty — which makes ``_run_generate_guide``
        skip the "AI & ML Footprint" section entirely. The two kinds are probed
        independently so an empty ``mltk_models`` (common — algorithms ship with
        the app, trained models don't) doesn't suppress the algorithm list.
        """
        try:
            self._mltk_algorithms = await self._mcp.get_knowledge_objects(
                kind="mltk_algorithms"
            )
        except Exception as exc:  # noqa: BLE001 - toolkit absent / kind unsupported
            logger.info("mltk_algorithms unavailable (AI Toolkit not installed?): %s", exc)
            self._mltk_algorithms = []
        try:
            self._mltk_models = await self._mcp.get_knowledge_objects(kind="mltk_models")
        except Exception as exc:  # noqa: BLE001
            logger.info("mltk_models unavailable: %s", exc)
            self._mltk_models = []

    @staticmethod
    def _extract_mltk_names(data: Any) -> list[str]:
        """Pull algorithm/model names out of an MCP knowledge-objects response.

        The client already normalizes to a list of dicts, but we stay defensive
        against the raw ``{"results": [...]}`` / ``{"entries": [...]}`` shapes too.
        """
        if isinstance(data, list):
            return [
                item.get("name", str(item)) if isinstance(item, dict) else str(item)
                for item in data
            ]
        if isinstance(data, dict):
            items = data.get("results", data.get("entries", data.get("items", [])))
            return [
                item.get("name", str(item)) if isinstance(item, dict) else str(item)
                for item in items
            ]
        return []

    # ---- Reason step ----

    async def _reason_about_discovery(self) -> str:
        """One LLM call that summarizes the most notable findings so far.

        Returns the model's plain-text observation (not a structured plan —
        the new linear flow doesn't need machine-readable action lists).
        """
        summary = self._graph.summary()
        sample_alerts = [
            {"name": n.name, "spl": (n.properties.get("spl") or "")[:300]}
            for n in self._graph.nodes_by_type(NodeType.ALERT)[:5]
        ]
        sample_saved = [
            {"name": n.name, "spl": (n.properties.get("spl") or "")[:300]}
            for n in self._graph.nodes_by_type(NodeType.SAVED_SEARCH)[:5]
        ]
        prompt = (
            "You are analyzing a Splunk environment to onboard a new engineer. "
            "Based on what's been discovered so far, summarize what areas seem "
            "most important for a newcomer to understand and any patterns you "
            "notice (recurring macros / lookups, alerts that share dependencies, "
            "indexes that look load-bearing, etc.). Keep it to 4 short bullet "
            "points.\n\n"
            f"GRAPH SUMMARY:\n{json.dumps(summary, indent=2)}\n\n"
            f"SAMPLE ALERTS:\n{json.dumps(sample_alerts, indent=2)}\n\n"
            f"SAMPLE SAVED SEARCHES:\n{json.dumps(sample_saved, indent=2)}\n"
        )
        return (await self._llm_call(prompt, max_tokens=300)).strip()

    # ---- Guide generation (5 per-section LLM calls) ----

    async def generate_guide(self) -> AsyncIterator[AgentEvent]:
        """Produce the 5-section onboarding guide. One LLM call per section."""
        async with self._lock:
            try:
                async for event in self._run_generate_guide():
                    yield event
            except Exception as exc:
                logger.exception("guide generation crashed")
                yield AgentEvent(
                    phase=AgentPhase.ERROR,
                    message="guide generation failed",
                    detail=str(exc),
                )

    async def _run_generate_guide(self) -> AsyncIterator[AgentEvent]:
        graph_snapshot = self._graph.to_dict()
        sections: dict[str, str] = {}
        markdown_chunks: list[str] = []

        # The AI & ML Footprint section only makes sense when the AI Toolkit is
        # actually installed — skip it entirely otherwise rather than writing an
        # empty "0 algorithms" section.
        section_specs = [
            spec
            for spec in _GUIDE_SECTIONS
            if spec[0] != _MLTK_SECTION_TITLE
            or self._mltk_algorithms
            or self._mltk_models
        ]

        for title, context_fn, prompt_fn in section_specs:
            yield AgentEvent(
                phase=AgentPhase.SYNTHESIZE,
                message=f"writing section: {title}",
            )
            context = context_fn(self)
            prompt = prompt_fn(title, context)
            # The footprint section is meant to be concise.
            max_tokens = 800 if title == _MLTK_SECTION_TITLE else 1000
            try:
                body = (await self._llm_call(prompt, max_tokens=max_tokens)).strip()
            except Exception as exc:
                logger.warning("section %r failed: %s", title, exc)
                yield AgentEvent(
                    phase=AgentPhase.ERROR,
                    message=f"failed to write section {title}",
                    detail=str(exc),
                )
                body = f"_(generation failed: {exc})_"

            # Guard: never let a failed-generation marker or a raw rate-limit
            # error leak into the guide as content. Swap in a friendly message.
            if body.startswith("_(generation failed") or "rate_limit_exceeded" in body:
                body = _SECTION_UNAVAILABLE_MESSAGE

            # Some models will themselves prefix the title; strip a leading H2
            # so we don't double up when we add ours.
            body_stripped = _strip_leading_h2(body, title)

            # Append visual dependency trees to the alerts section. Done before
            # both stores below so the frontend section and the markdown export
            # pick them up from the same source.
            if title == _ALERTS_SECTION_TITLE:
                trees = self._render_alert_chain_trees()
                if trees:
                    body_stripped = f"{body_stripped}\n\n{trees}"

            sections[title] = body_stripped
            markdown_chunks.append(f"## {title}\n\n{body_stripped}\n")
            yield AgentEvent(
                phase=AgentPhase.SYNTHESIZE,
                message=f"section ready: {title}",
                data={"section": title, "preview": body_stripped[:200]},
            )

        markdown = "\n".join(markdown_chunks).strip()
        rel = self._graph.relationship_view()
        self._guide = OnboardingGuide(
            markdown=markdown,
            sections=sections,
            graph_snapshot=graph_snapshot,
            graph_nodes=rel["nodes"],
            graph_edges=rel["edges"],
            mltk_algorithm_count=len(self._mltk_algorithms),
            mltk_model_count=len(self._mltk_models),
        )
        yield AgentEvent(
            phase=AgentPhase.DONE,
            message="guide ready",
            data={"section_count": len(sections)},
        )

    # ---- Starter kit (Mode C) ----

    async def generate_starter_kit(self) -> AsyncIterator[AgentEvent]:
        """Generate the Mode C starter kit from the discovered environment.

        Wraps ``_run_generate_starter_kit`` with the orchestrator lock and a
        crash guard, matching ``explore`` / ``generate_guide``.
        """
        async with self._lock:
            try:
                async for event in self._run_generate_starter_kit():
                    yield event
            except Exception as exc:
                logger.exception("starter-kit generation crashed")
                yield AgentEvent(
                    phase=AgentPhase.ERROR,
                    message="starter kit generation failed",
                    detail=str(exc),
                )

    async def _run_generate_starter_kit(self) -> AsyncIterator[AgentEvent]:
        kit = StarterKit()

        # User-facing indexes only — skip placeholders and Splunk-internal `_*`.
        user_indexes = [
            n
            for n in self._graph.nodes_by_type(NodeType.INDEX)
            if not n.name.startswith("_") and not n.properties.get("placeholder")
        ]
        alerts = self._graph.nodes_by_type(NodeType.ALERT)

        # ---- 1. Generate common-task SPL queries ----
        yield AgentEvent(AgentPhase.SYNTHESIZE, "generating starter SPL queries...")

        # (task description, GeneratedSPL.category, index name)
        spl_tasks: list[tuple[str, str, str]] = []
        for idx in user_indexes:
            category = _categorize_index(idx.name)
            if category == "security":
                spl_tasks.append(("Find all failed login attempts in the last 24 hours", "security", idx.name))
                spl_tasks.append(("Show top source IPs with blocked firewall traffic", "security", idx.name))
            elif category == "application":
                spl_tasks.append(("Find HTTP 500 errors in the last hour", "application", idx.name))
                spl_tasks.append(("Show average response time by endpoint", "application", idx.name))
            elif category == "deployment":
                spl_tasks.append(("Show failed deployments in the last 7 days", "infrastructure", idx.name))

        for desc, cat, idx_name in spl_tasks:
            full_desc = f"{desc} from the {idx_name} index"
            spl = await self._generate_spl_with_fallback(full_desc)
            if spl and spl.strip().upper() != "NO_QUERY":
                kit.generated_queries.append(
                    GeneratedSPL(
                        title=desc,
                        description=f"Query against {idx_name}",
                        spl=spl.strip(),
                        category=cat,
                    )
                )

        yield AgentEvent(
            AgentPhase.SYNTHESIZE,
            f"generated {len(kit.generated_queries)} starter queries",
        )

        # ---- 2. Generate per-alert runbooks ----
        yield AgentEvent(AgentPhase.SYNTHESIZE, "generating alert runbooks...")

        for alert in alerts:
            chain = self._render_chain_tree(alert.id)
            spl = alert.properties.get("spl") or ""
            spl_explanation = alert.properties.get("spl_explanation") or ""
            owner = alert.properties.get("owner") or ""

            prompt = (
                "Generate a concise runbook for this Splunk alert. Respond in "
                "JSON format only, no markdown.\n"
                "{\n"
                '  "what_it_means": "one paragraph explanation",\n'
                '  "first_checks": ["check 1", "check 2", "check 3"],\n'
                '  "spl_to_run": "an investigative SPL query to run when this fires",\n'
                '  "who_to_contact": "guidance on who to contact"\n'
                "}\n\n"
                f"Alert name: {alert.name}\n"
                f"Alert SPL: {spl or 'N/A'}\n"
                f"SPL explanation: {spl_explanation or 'N/A'}\n"
                f"Owner: {owner or 'unknown'}\n"
                f"Dependency chain:\n{chain}\n"
            )
            runbook_json = await self._llm_call(prompt, max_tokens=500)

            severity = _runbook_severity(alert.name)
            default_contact = f"{owner} (alert owner)" if owner else "Check with your team lead"

            rb_data = _extract_json_object(runbook_json)
            if rb_data is not None:
                kit.runbooks.append(
                    Runbook(
                        alert_name=alert.name,
                        severity=severity,
                        what_it_means=str(rb_data.get("what_it_means", "")),
                        chain_summary=chain,
                        first_checks=_as_str_list(rb_data.get("first_checks")),
                        spl_to_run=str(rb_data.get("spl_to_run", "")) or spl,
                        who_to_contact=str(rb_data.get("who_to_contact") or default_contact),
                    )
                )
            else:
                # Defensive fallback: use the raw LLM text as the explanation.
                kit.runbooks.append(
                    Runbook(
                        alert_name=alert.name,
                        severity=severity,
                        what_it_means=runbook_json.strip()[:500],
                        chain_summary=chain,
                        first_checks=[
                            "Review the alert SPL",
                            "Check the source index",
                            "Contact the alert owner",
                        ],
                        spl_to_run=spl,
                        who_to_contact=default_contact,
                    )
                )

        yield AgentEvent(AgentPhase.SYNTHESIZE, f"generated {len(kit.runbooks)} runbooks")

        # ---- 3. Generate dashboard skeleton ----
        yield AgentEvent(AgentPhase.SYNTHESIZE, "generating dashboard skeleton...")

        # One event-volume timechart per non-empty index.
        for idx in user_indexes:
            if not idx.properties.get("totalEventCount"):
                continue
            kit.dashboard_panels.append(
                DashboardPanel(
                    title=f"{idx.name} — Event Volume",
                    spl=f"index={idx.name} | timechart count by sourcetype",
                    viz_type="timechart",
                )
            )

        # One table panel per alert that carries SPL.
        for alert in alerts:
            alert_spl = alert.properties.get("spl")
            if alert_spl:
                kit.dashboard_panels.append(
                    DashboardPanel(
                        title=f"Alert: {alert.name}",
                        spl=alert_spl,
                        viz_type="table",
                    )
                )

        kit.dashboard_xml = _generate_simple_xml(kit.dashboard_panels, "Cairn Starter Dashboard")

        yield AgentEvent(
            AgentPhase.SYNTHESIZE,
            f"generated dashboard with {len(kit.dashboard_panels)} panels",
        )

        self._starter_kit = kit
        yield AgentEvent(
            AgentPhase.DONE,
            "starter kit ready",
            data={
                "query_count": len(kit.generated_queries),
                "runbook_count": len(kit.runbooks),
                "panel_count": len(kit.dashboard_panels),
            },
        )

    # ---- Mode B: environment-hygiene findings (Flag) ----

    async def generate_findings(self) -> AsyncIterator[AgentEvent]:
        """Derive Mode B hygiene findings from the discovered graph.

        Wraps ``_run_generate_findings`` with the orchestrator lock and a crash
        guard, matching ``explore`` / ``generate_guide`` / ``generate_starter_kit``.
        """
        async with self._lock:
            try:
                async for event in self._run_generate_findings():
                    yield event
            except Exception as exc:
                logger.exception("findings generation crashed")
                yield AgentEvent(
                    phase=AgentPhase.ERROR,
                    message="findings generation failed",
                    detail=str(exc),
                )

    def _reachable_indexes(self, start_node_id: str) -> list[Any]:
        """All INDEX nodes reachable from ``start_node_id`` by following out-edges.

        Walks alert -> saved search / macro / lookup -> index so an alert whose
        index reference lives inside a macro still resolves to the real index.
        """
        seen: set[str] = set()
        indexes: list[Any] = []
        stack = [start_node_id]
        while stack:
            nid = stack.pop()
            if nid in seen:
                continue
            seen.add(nid)
            for edge in self._graph.out_edges(nid):
                target = self._graph.get_node(edge.target)
                if target is None:
                    continue
                if target.type == NodeType.INDEX and target.id not in seen:
                    indexes.append(target)
                stack.append(edge.target)
        return indexes

    async def _run_generate_findings(self) -> AsyncIterator[AgentEvent]:
        report = FindingsReport()
        dead: list[str] = []

        # ---- 1. Orphaned macros / lookups (zero incoming references) ----
        yield AgentEvent(AgentPhase.SYNTHESIZE, "scanning for orphaned objects...")
        for node_type, label, allowlist in (
            (NodeType.MACRO, "macro", _ALLOWED_MACROS),
            (NodeType.LOOKUP, "lookup", _ALLOWED_LOOKUPS),
        ):
            for node in self._graph.nodes_by_type(node_type):
                if node.properties.get("placeholder"):
                    continue
                if self._graph.in_edges(node.id):
                    continue
                # Zero incoming edges. That's a *real* orphan only if it's a
                # deliberately-planted landmine, or something we never
                # allowlisted (genuine junk in a production environment). An
                # allowlisted-but-not-planted object with no refs is almost
                # certainly a victim of the MCP 100-item cap — its referrer
                # (e.g. "Warning: API Latency Above Threshold" for
                # business_hours_only) sits past the pagination cutoff and never
                # got discovered. Suppress those to avoid false positives.
                if node.name not in _EXPECTED_ORPHANS and node.name in allowlist:
                    continue
                report.findings.append(
                    HygieneFinding(
                        id=f"orphan:{label}:{node.name}",
                        category=CATEGORY_ORPHAN,
                        severity=SEV_LOW,
                        title=f"Orphaned {label}: {node.name}",
                        summary=(
                            f"The {label} '{node.name}' is not referenced by any saved "
                            f"search, alert, or dashboard — it's dead weight."
                        ),
                        evidence={"object_type": label, "name": node.name, "incoming_refs": 0},
                        affected_node_id=node.id,
                        fix=(
                            f"No SPL references this {label}. Safe to retire "
                            f"(archive it first) after confirming nothing outside Splunk "
                            f"depends on it."
                        ),
                    )
                )
                dead.append(node.id)

        # ---- 2. Alerts: empty index / no action / no owner ----
        yield AgentEvent(AgentPhase.SYNTHESIZE, "auditing alerts for hygiene issues...")

        # Flag -> Fix: for alert findings we generate a tuned ``fix_spl`` via
        # saia_generate_spl / saia_optimize_spl (LLM fallback). Cap the number of
        # LLM round-trips so a noisy environment can't blow the rate limit — once
        # the budget is spent, findings still carry their deterministic text fix.
        fix_calls = 0
        populated_indexes = [
            n.name
            for n in self._graph.nodes_by_type(NodeType.INDEX)
            if not n.properties.get("placeholder")
            and not n.name.startswith("_")
            and int(n.properties.get("totalEventCount") or 0) > 0
        ]

        for alert in self._graph.nodes_by_type(NodeType.ALERT):
            name = alert.name
            alert_spl = alert.properties.get("spl") or ""

            # Only flag hygiene on *tracked* alerts. Scheduled reports surface as
            # alert nodes too (non-empty alert_type), but having no action / no
            # owner is normal for a report — flagging them would be noise.
            track = alert.properties.get("alert_track")
            is_tracked = track is True or (
                isinstance(track, str) and track.strip().lower() in ("1", "true")
            )
            if not is_tracked:
                continue

            # 2a. Alert on an empty index.
            for index_node in self._reachable_indexes(alert.id):
                if index_node.name.startswith("_"):
                    continue
                event_count = index_node.properties.get("totalEventCount")
                if event_count is None or int(event_count) != 0:
                    continue
                # Flag -> Fix: generate the alert's SPL repointed at a real index.
                fix_spl = ""
                if alert_spl and fix_calls < _MAX_FINDING_FIX_SPL_CALLS:
                    fix_calls += 1
                    populated = ", ".join(populated_indexes) or "(no populated index found)"
                    fix_spl = await self._safe_generate_fix(
                        f"Rewrite this Splunk alert to read from a populated index "
                        f"instead of the empty '{index_node.name}' (populated indexes "
                        f"in this environment: {populated}): {alert_spl}"
                    )
                report.findings.append(
                    HygieneFinding(
                        id=f"empty_index:{name}:{index_node.name}",
                        category=CATEGORY_ALERT_EMPTY_INDEX,
                        severity=SEV_HIGH,
                        title=f"Alert on empty index: {name}",
                        summary=(
                            f"Alert '{name}' reads from index '{index_node.name}', "
                            f"which currently holds 0 events — it can never fire."
                        ),
                        evidence={
                            "alert": name,
                            "index": index_node.name,
                            "totalEventCount": 0,
                        },
                        affected_node_id=index_node.id,
                        fix=(
                            f"Repoint alert '{name}' to a populated index, or decommission "
                            f"it if '{index_node.name}' is retired."
                        ),
                        fix_spl=fix_spl,
                    )
                )
                dead.append(index_node.id)

            # 2b. Alert with no action configured.
            actions = alert.properties.get("actions")
            if not (isinstance(actions, str) and actions.strip()):
                # Flag -> Fix: an alert action isn't expressed in SPL, so instead
                # offer a tuned version of the alert's query (a cleaner/faster
                # search to pair with the action they'll add).
                fix_spl = ""
                if alert_spl and fix_calls < _MAX_FINDING_FIX_SPL_CALLS:
                    fix_calls += 1
                    fix_spl = await self._safe_optimize_fix(alert_spl)
                report.findings.append(
                    HygieneFinding(
                        id=f"no_action:{name}",
                        category=CATEGORY_ALERT_NO_ACTION,
                        severity=SEV_HIGH,
                        title=f"Alert with no action: {name}",
                        summary=(
                            f"Alert '{name}' has no action configured — when it triggers, "
                            f"nothing happens and no human is notified."
                        ),
                        evidence={"alert": name, "actions": actions or ""},
                        affected_node_id=alert.id,
                        fix=(
                            f"Add an alert action to '{name}' (email, webhook, or a ticketing "
                            f"integration) so a trigger reaches a human."
                        ),
                        fix_spl=fix_spl,
                    )
                )

            # 2c. Alert with no owner.
            owner = alert.properties.get("owner")
            if not (isinstance(owner, str) and owner.strip() and owner.lower() != "nobody"):
                report.findings.append(
                    HygieneFinding(
                        id=f"no_owner:{name}",
                        category=CATEGORY_ALERT_NO_OWNER,
                        severity=SEV_MEDIUM,
                        title=f"Alert with no owner: {name}",
                        summary=(
                            f"Alert '{name}' has no clear owner — there's no obvious person "
                            f"to escalate to when it fires."
                        ),
                        evidence={"alert": name, "owner": owner or ""},
                        affected_node_id=alert.id,
                        fix=(
                            f"Assign an owner to '{name}' so on-call has a clear escalation path."
                        ),
                    )
                )

        report.dead_node_ids = list(dict.fromkeys(dead))  # de-dupe, keep order
        self._findings = report
        yield AgentEvent(
            AgentPhase.DONE,
            f"found {len(report.findings)} hygiene issue(s)",
            data=report.counts,
        )

    # ---- Section context builders ----
    # Each returns a JSON-friendly dict that becomes the section's grounding.

    def _ctx_critical_alerts(self) -> dict[str, Any]:
        return {"alerts": self._collect_alert_chains()}

    def _ctx_data_landscape(self) -> dict[str, Any]:
        indexes = []
        for node in self._graph.nodes_by_type(NodeType.INDEX):
            if node.properties.get("placeholder"):
                continue
            if node.name.startswith("_"):
                continue
            sourcetypes = [
                e.source.split(":", 1)[1] if ":" in e.source else e.source
                for e in self._graph.in_edges(node.id, EdgeType.SOURCETYPE_OF)
            ]
            indexes.append(
                {
                    "name": node.name,
                    "totalEventCount": node.properties.get("totalEventCount"),
                    "currentDBSizeMB": node.properties.get("currentDBSizeMB"),
                    "datatype": node.properties.get("datatype"),
                    "sourcetypes": sourcetypes[:10],
                }
            )
        return {"indexes": indexes}

    def _ctx_dashboards(self) -> dict[str, Any]:
        dashboards = []
        for node in self._graph.nodes_by_type(NodeType.DASHBOARD):
            dashboards.append(
                {
                    "name": node.name,
                    "owner": node.properties.get("owner"),
                    "app": node.properties.get("app"),
                    "panel_count": node.properties.get("panel_count"),
                    "panel_spls": (node.properties.get("panel_spls") or [])[:6],
                }
            )
        return {"dashboards": dashboards}

    def _ctx_shorthand(self) -> dict[str, Any]:
        macros = []
        for node in self._graph.nodes_by_type(NodeType.MACRO):
            used_by = [
                e.source.split(":", 1)[1] if ":" in e.source else e.source
                for e in self._graph.in_edges(node.id, EdgeType.REFERENCES_MACRO)
            ]
            macros.append(
                {
                    "name": node.name,
                    "definition": node.properties.get("definition"),
                    "used_by": used_by[:10],
                }
            )
        lookups = []
        for node in self._graph.nodes_by_type(NodeType.LOOKUP):
            used_by = [
                e.source.split(":", 1)[1] if ":" in e.source else e.source
                for e in self._graph.in_edges(node.id, EdgeType.REFERENCES_LOOKUP)
            ]
            lookups.append(
                {
                    "name": node.name,
                    "filename": node.properties.get("filename"),
                    "used_by": used_by[:10],
                }
            )
        return {"macros": macros, "lookups": lookups}

    def _ctx_ownership(self) -> dict[str, Any]:
        return {"signals": self._collect_ownership_signals()}

    def _ctx_mltk(self) -> dict[str, Any]:
        algorithms = self._extract_mltk_names(self._mltk_algorithms)
        models = self._extract_mltk_names(self._mltk_models)
        return {
            "algorithm_count": len(algorithms),
            "model_count": len(models),
            "algorithm_names": algorithms,
            "models": models,
        }

    # ---- Graph-derived context helpers ----

    def _collect_alert_chains(self) -> list[dict[str, Any]]:
        chains: list[dict[str, Any]] = []
        for alert in self._graph.nodes_by_type(NodeType.ALERT):
            paths = self._graph.trace_chain(alert.id, max_depth=6)
            chains.append(
                {
                    "name": alert.name,
                    "spl": alert.properties.get("spl"),
                    "spl_explanation": alert.properties.get("spl_explanation"),
                    "owner": alert.properties.get("owner"),
                    "alert_severity": alert.properties.get("alert_severity"),
                    "usage_count_24h": alert.properties.get("usage_count_24h"),
                    # An ASCII tree of this alert's dependency chain. Included in
                    # the LLM context so it can reference the structure, and
                    # re-rendered verbatim into the guide section / export below.
                    "chain_tree": self._render_chain_tree(alert.id),
                    "paths": [
                        [{"type": n.type.value, "name": n.name} for n in p]
                        for p in paths
                    ],
                }
            )
        return chains

    # ---- Dependency-chain rendering ----

    def _render_chain_tree(
        self,
        node_id: str,
        *,
        indent: int = 0,
        visited: frozenset[str] = frozenset(),
    ) -> str:
        """Render a node's dependency chain as an indented text tree.

        Walks the outgoing reference edges (alert → saved search → macro →
        lookup → index), skipping ownership / app-placement edges that aren't
        part of the dependency story. ``visited`` breaks cycles — the graph is
        not guaranteed acyclic.
        """
        node = self._graph.get_node(node_id)
        if node is None:
            return ""

        prefix = "  " * indent
        arrow = "→ " if indent > 0 else ""
        lines = [f"{prefix}{arrow}{node.type.value}: {node.name}"]

        visited = visited | {node_id}
        for edge in self._graph.out_edges(node_id):
            if edge.type in _CHAIN_SKIP_EDGES:
                continue
            if edge.target in visited:
                continue  # cycle — stop descending
            subtree = self._render_chain_tree(
                edge.target, indent=indent + 1, visited=visited
            )
            if subtree:
                lines.append(subtree)
        return "\n".join(lines)

    def _render_alert_chain_trees(self) -> str:
        """A Markdown block of every alert's dependency tree, fenced as code.

        Returns an empty string when no alert has any dependencies worth
        showing, so callers can skip appending an empty section.
        """
        blocks: list[str] = []
        for alert in self._graph.nodes_by_type(NodeType.ALERT):
            tree = self._render_chain_tree(alert.id)
            # A lone root line (no descendants) isn't a "chain" — skip it.
            if "\n" not in tree:
                continue
            blocks.append(f"**Dependency Chain:**\n\n```\n{tree}\n```")
        if not blocks:
            return ""
        return "### Dependency Chains\n\n" + "\n\n".join(blocks)

    def _collect_ownership_signals(self) -> list[dict[str, Any]]:
        signals: list[dict[str, Any]] = []
        for kind in (NodeType.ALERT, NodeType.SAVED_SEARCH, NodeType.DASHBOARD, NodeType.MACRO):
            for node in self._graph.nodes_by_type(kind):
                owner = node.properties.get("owner")
                if not owner:
                    continue
                signals.append(
                    {
                        "type": kind.value,
                        "name": node.name,
                        "owner": owner,
                        "app": node.properties.get("app"),
                        "usage_count_24h": node.properties.get("usage_count_24h"),
                    }
                )
        return signals

    # ---- Follow-up Q&A ----

    async def ask(self, question: str) -> dict[str, Any]:
        """Answer a follow-up question grounded in the discovered graph.

        When the question implies "fresh data" (e.g. *"how many failed logins
        in the last hour?"*), we also run a live Splunk query to ground the
        answer in current results. The flow is:

          1. Always include the discovered graph as ground-truth context.
          2. If the question contains live-data keywords, ask the LLM to
             generate a short SPL query against the known indexes. Run it
             via ``splunk_run_query`` and add the result rows to context.
          3. If the question names a known saved search, dispatch it via
             ``splunk_run_saved_search`` and add those rows too.
          4. Ask the LLM for the final answer with the (possibly enriched)
             context.

        Any MCP failure along the way falls back silently to context-only —
        we still return *some* answer rather than 500-ing on the user.

        Returns a dict ``{"answer": str, "live_queries": list}`` where each
        live-query entry records what was actually run against Splunk (an SPL
        string or a saved-search name) so the UI can show provenance.
        """
        # ---- conceptual Splunk-domain question → saia_ask_splunk_question ----
        # General "what is SPL / how does this command work" questions are best
        # answered by Splunk's own AI Assistant. Try it first; any failure (or
        # an unavailable tool) drops through to the graph-grounded LLM flow.
        if _is_conceptual_splunk_question(question) and self._mcp.has_saia():
            try:
                answer = (await self._mcp.ask_splunk_question(question)).strip()
                if answer and "error" not in answer.lower():
                    return {"answer": answer, "live_queries": []}
                logger.warning(
                    "saia_ask_splunk_question returned an empty/error result, "
                    "falling back to LLM"
                )
            except Exception as exc:  # noqa: BLE001 - any failure routes to the LLM
                logger.warning(
                    "saia_ask_splunk_question unavailable, falling back to LLM: %s", exc
                )

        snapshot = self._graph.to_dict()
        live_sections: list[str] = []
        # What we actually ran against Splunk, surfaced to the UI as provenance.
        live_queries: list[dict[str, Any]] = []

        # ---- live SPL query (if the question implies fresh data) ----
        if _wants_live_data(question):
            try:
                spl = await self._draft_live_spl(question)
            except Exception as exc:
                logger.info("live-SPL generation failed: %s", exc)
                spl = None
            if spl and spl.upper() != "NO_QUERY":
                try:
                    result = await self._mcp.run_query(spl, earliest="0")
                except SplunkMCPError as exc:
                    logger.info("live SPL %r failed: %s", spl, exc)
                else:
                    live_sections.append(
                        f"LIVE QUERY (`{spl}`):\n"
                        f"{json.dumps(result, indent=2, default=str)[:3000]}"
                    )
                    live_queries.append({"type": "spl_query", "query": spl})

        # ---- saved-search dispatch (if the question names one) ----
        named_search = self._match_known_search(question)
        if named_search is not None:
            try:
                ss_result = await self._mcp.run_saved_search(named_search)
            except SplunkMCPError as exc:
                logger.info("saved-search %r failed: %s", named_search, exc)
            else:
                live_sections.append(
                    f"SAVED SEARCH RESULTS (`{named_search}`):\n"
                    f"{json.dumps(ss_result, indent=2, default=str)[:3000]}"
                )
                live_queries.append({"type": "saved_search", "name": named_search})

        env = self._curated_env_context()
        prompt_parts = [
            "You are Cairn, an AI assistant that already explored this Splunk "
            "environment and can answer questions about it. Use the environment "
            "summary and the relationship graph below as ground truth. Where you "
            "reference an artifact, name it precisely. If the data doesn't "
            "contain the answer, say so explicitly rather than guessing. Write "
            "in a warm, direct style — you're talking to an engineer who just "
            "got paged.\n"
            "\n"
            "Guidance:\n"
            "- ENV_SUMMARY.user_indexes are the business/data indexes an "
            "engineer actually searches. ENV_SUMMARY.internal_indexes are "
            "Splunk's own system indexes (the `_*` ones) — never call these the "
            "'most important' just because they hold the most events.\n"
            "- When asked which indexes matter, prioritize user indexes that are "
            "load-bearing — those whose 'referenced_by' lists alerts or saved "
            "searches — over raw event volume.\n"
            "- To say what data lives in an index, use its 'sourcetypes' and the "
            "artifacts in 'referenced_by'. When sourcetypes are named, describe "
            "the data concretely instead of hedging with 'probably/likely'.\n",
            f"QUESTION: {question}\n",
            f"ENV_SUMMARY:\n{json.dumps(env, indent=2)[:6000]}",
            f"GRAPH:\n{json.dumps(snapshot, indent=2)[:12000]}",
        ]
        prompt_parts.extend(live_sections)
        prompt = "\n\n".join(prompt_parts)
        try:
            answer = (await self._llm_call(prompt, max_tokens=1000)).strip()
        except Exception as exc:
            logger.warning("ask() LLM call failed: %s", exc)
            return {"answer": _ASK_UNAVAILABLE_MESSAGE, "live_queries": live_queries}
        # _llm_call returns a fallback marker (rather than raising) when it
        # exhausts retries on a rate limit; translate it for the Q&A context.
        if not answer or answer == _RATE_LIMIT_SECTION_FALLBACK or "rate_limit_exceeded" in answer:
            return {"answer": _ASK_UNAVAILABLE_MESSAGE, "live_queries": live_queries}
        return {"answer": answer, "live_queries": live_queries}

    def _curated_env_context(self) -> dict[str, Any]:
        """Compact, onboarding-oriented view of the environment for Q&A.

        Separates user/business indexes (with sourcetypes, volume, and the
        artifacts that read them) from Splunk-internal ``_*`` indexes, and
        lists the knowledge objects by name. This grounds ``ask()`` so the LLM
        can answer "which indexes matter / what's in them" without inferring
        purpose from names alone, and without ranking Splunk's own plumbing as
        "most important" just because it holds more events.

        Read-only graph derivation — does not mutate state, so it can't affect
        any other mode.
        """
        user_indexes: list[dict[str, Any]] = []
        internal_indexes: list[str] = []
        for node in self._graph.nodes_by_type(NodeType.INDEX):
            if node.properties.get("placeholder"):
                continue
            if node.name.startswith("_"):
                internal_indexes.append(node.name)
                continue
            sourcetypes = [
                e.source.split(":", 1)[1] if ":" in e.source else e.source
                for e in self._graph.in_edges(node.id, EdgeType.SOURCETYPE_OF)
            ]
            referenced_by = [
                e.source.split(":", 1)[1] if ":" in e.source else e.source
                for e in self._graph.in_edges(node.id, EdgeType.READS_FROM_INDEX)
            ]
            user_indexes.append(
                {
                    "name": node.name,
                    "totalEventCount": node.properties.get("totalEventCount"),
                    "currentDBSizeMB": node.properties.get("currentDBSizeMB"),
                    "sourcetypes": sourcetypes[:10],
                    "referenced_by": referenced_by[:10],
                }
            )

        def _names(node_type: NodeType) -> list[str]:
            return [
                n.name
                for n in self._graph.nodes_by_type(node_type)
                if not n.properties.get("placeholder")
            ]

        return {
            "user_indexes": user_indexes,
            "internal_indexes": sorted(internal_indexes),
            "knowledge_objects": {
                "alerts": _names(NodeType.ALERT),
                "saved_searches": _names(NodeType.SAVED_SEARCH),
                "dashboards": _names(NodeType.DASHBOARD),
                "macros": _names(NodeType.MACRO),
                "lookups": _names(NodeType.LOOKUP),
            },
        }

    def _user_index_summaries(self) -> list[dict[str, Any]]:
        """User-facing indexes with their sourcetypes.

        Skips placeholders and Splunk-internal ``_*`` indexes — the set an
        engineer would actually search. Shared by live-SPL drafting and the
        ``saia_generate_spl`` LLM fallback so both ground on the same view.
        """
        summaries: list[dict[str, Any]] = []
        for node in self._graph.nodes_by_type(NodeType.INDEX):
            if node.properties.get("placeholder"):
                continue
            if node.name.startswith("_"):
                continue
            sourcetypes = [
                e.source.split(":", 1)[1] if ":" in e.source else e.source
                for e in self._graph.in_edges(node.id, EdgeType.SOURCETYPE_OF)
            ]
            summaries.append({"index": node.name, "sourcetypes": sourcetypes[:10]})
        return summaries

    async def _draft_live_spl(self, question: str) -> str:
        """Ask the LLM for an SPL query that answers ``question``.

        Returns the SPL string (or ``"NO_QUERY"`` if not answerable via SPL).
        """
        index_summaries = self._user_index_summaries()

        prompt = (
            "You are a Splunk SPL expert. Given this question about a Splunk "
            "environment, generate a short SPL query to answer it.\n\n"
            f"Available indexes:\n{json.dumps(index_summaries, indent=2)}\n\n"
            f"Question: {question}\n\n"
            "Respond with ONLY the SPL query, nothing else. Include `| head 100` "
            "at the end if the query would return raw events (omit for aggregations). "
            "If the question can't be answered with a query, respond with NO_QUERY."
        )
        text = (await self._llm_call(prompt, max_tokens=300)).strip()
        return _clean_spl_response(text)

    def _match_known_search(self, question: str) -> str | None:
        """Return the name of a saved search / alert mentioned in ``question``.

        Case-insensitive substring match against graph node names. Returns
        the longest match (so "Multiple Failed Logins" wins over "Logins").
        """
        haystack = question.lower()
        best: str | None = None
        best_len = 0
        for kind in (NodeType.ALERT, NodeType.SAVED_SEARCH):
            for node in self._graph.nodes_by_type(kind):
                if node.name and node.name.lower() in haystack and len(node.name) > best_len:
                    best = node.name
                    best_len = len(node.name)
        return best


# ---- Section definitions --------------------------------------------------


def _prompt_critical_alerts(title: str, ctx: dict[str, Any]) -> str:
    return (
        f"You are writing the '{title}' section of an onboarding guide for a "
        "Splunk newcomer. For each alert below, walk the dependency chain "
        "(alert → saved search → macro → lookup → index) and explain in 2-3 "
        "sentences: what triggers it, what data feeds it, and what the on-call "
        "engineer should do when it fires at 3am. Use the spl_explanation "
        "field if present — it's already a plain-English summary of the SPL. "
        "Each alert has a 'chain_tree' showing its dependency structure; you "
        "may reference it in prose, but do NOT reproduce the trees yourself — "
        "they are appended to this section automatically. "
        "Write in a warm, direct style. Output only Markdown body — do NOT "
        "include the H2 header, the orchestrator adds that.\n\n"
        f"ALERTS:\n{json.dumps(ctx, indent=2)[:6000]}"
    )


def _prompt_data_landscape(title: str, ctx: dict[str, Any]) -> str:
    return (
        f"You are writing the '{title}' section of an onboarding guide for a "
        "Splunk newcomer. Group the indexes below by inferred purpose (web "
        "traffic, auth, infra metrics, deploys, etc.). For each, mention "
        "event count, primary sourcetypes, and a one-line hint of what an "
        "engineer would search this index FOR. Output only Markdown body — "
        "do NOT include the H2 header.\n\n"
        f"INDEXES:\n{json.dumps(ctx, indent=2)[:5000]}"
    )


def _prompt_dashboards(title: str, ctx: dict[str, Any]) -> str:
    return (
        f"You are writing the '{title}' section of an onboarding guide for a "
        "Splunk newcomer. For each dashboard, describe what question it "
        "answers, and (in one short paragraph) what an engineer should look "
        "for on it. Skim the panel SPLs to ground your description. Output "
        "only Markdown body — do NOT include the H2 header.\n\n"
        f"DASHBOARDS:\n{json.dumps(ctx, indent=2)[:5000]}"
    )


def _prompt_shorthand(title: str, ctx: dict[str, Any]) -> str:
    return (
        f"You are writing the '{title}' section of an onboarding guide for a "
        "Splunk newcomer. Explain each macro and lookup IN CONTEXT — name the "
        "artifacts that use it (from the 'used_by' list) and what behavior it "
        "encodes. A macro is rarely interesting on its own; what matters is "
        "WHY it exists. Output only Markdown body — do NOT include the H2 "
        "header.\n\n"
        f"SHORTHAND:\n{json.dumps(ctx, indent=2)[:5000]}"
    )


def _prompt_ownership(title: str, ctx: dict[str, Any]) -> str:
    return (
        f"You are writing the '{title}' section of an onboarding guide for a "
        "Splunk newcomer. Map the ownership signals below into 'who to ask' "
        "guidance. Group by owner if possible; list which artifacts each owner "
        "touches. If usage_count_24h is populated, mention who runs what. "
        "Output only Markdown body — do NOT include the H2 header.\n\n"
        f"OWNERSHIP SIGNALS:\n{json.dumps(ctx, indent=2)[:4000]}"
    )


def _prompt_mltk(title: str, ctx: dict[str, Any]) -> str:
    algorithm_count = ctx.get("algorithm_count", 0)
    model_count = ctx.get("model_count", 0)
    algorithm_names = ", ".join(ctx.get("algorithm_names", [])) or "none"
    models = ctx.get("models", [])
    model_list_or_none = ", ".join(models) if models else "none"
    return (
        f"You are writing the '{title}' section of an onboarding guide for a newcomer. "
        f"This Splunk environment has the AI Toolkit (MLTK) installed with {algorithm_count} machine learning algorithms available "
        f"and {model_count} trained models deployed. "
        f"Algorithms available include: {algorithm_names}. "
        f"Trained models: {model_list_or_none}. "
        "Write a brief, practical overview for a newcomer: what ML capabilities are available in this environment, "
        "what the trained models do (if any), and what kinds of analysis the team could build with the available algorithms. "
        "Group the algorithms by purpose (anomaly detection, forecasting, clustering, classification, regression). "
        "If no models are trained, note that the toolkit is available but not yet utilized, and suggest 2-3 practical "
        "use cases based on the data in the environment (auth_events for login anomaly detection, app_metrics for forecasting, etc.). "
        "Output only Markdown body — do NOT include the H2 header."
    )


# Title of the alerts section — referenced both in the section table and in
# the synthesis loop (which appends dependency trees to this section only).
_ALERTS_SECTION_TITLE = "Critical Alerts & What They Mean"
# Title of the optional AI-Toolkit section — gated out in _run_generate_guide
# when no MLTK footprint was discovered.
_MLTK_SECTION_TITLE = "AI & ML Footprint"

# Edge types that describe metadata (ownership / app placement) rather than a
# data-dependency, so they're omitted from the dependency-chain tree view.
_CHAIN_SKIP_EDGES: frozenset[EdgeType] = frozenset(
    {EdgeType.LIVES_IN_APP, EdgeType.OWNED_BY}
)


# (section_title, context_builder, prompt_builder)
_GUIDE_SECTIONS: tuple[tuple[str, Any, Any], ...] = (
    (_ALERTS_SECTION_TITLE, Orchestrator._ctx_critical_alerts, _prompt_critical_alerts),
    ("Your Data Landscape", Orchestrator._ctx_data_landscape, _prompt_data_landscape),
    ("Your Team's Dashboards", Orchestrator._ctx_dashboards, _prompt_dashboards),
    ("The Shorthand", Orchestrator._ctx_shorthand, _prompt_shorthand),
    ("Who Knows What", Orchestrator._ctx_ownership, _prompt_ownership),
    (_MLTK_SECTION_TITLE, Orchestrator._ctx_mltk, _prompt_mltk),
)


# ---- helpers --------------------------------------------------------------


def _finding_to_event(phase: AgentPhase, finding: Finding) -> AgentEvent:
    return AgentEvent(
        phase=phase,
        message=finding.message,
        detail=finding.detail,
        data=finding.data,
    )


def _extract_text(response: Any) -> str:
    """Pull the assistant message text from a Groq chat-completion response."""
    choices = getattr(response, "choices", None) or []
    if not choices:
        return ""
    message = getattr(choices[0], "message", None)
    if message is None:
        return ""
    content = getattr(message, "content", None)
    return content if isinstance(content, str) else ""


# Keywords in a follow-up question that hint the user wants *current* data
# pulled from Splunk, not just a recap of what was discovered at explore time.
_LIVE_DATA_KEYWORDS: tuple[str, ...] = (
    "show me",
    "run",
    "how many",
    "latest",
    "recent",
    "current",
    "right now",
    "check",
    "look up",
    "what are the",
    "count of",
    "list the",
)


def _wants_live_data(question: str) -> bool:
    lower = question.lower()
    return any(kw in lower for kw in _LIVE_DATA_KEYWORDS)


# A conceptual *Splunk-domain* question (what SPL means, how a command works)
# rather than a question about THIS deployment's artifacts. These are exactly
# what the saia_ask_splunk_question tool is built to answer, so we route them
# there first and only fall back to the graph-grounded LLM flow on failure.
_CONCEPTUAL_PHRASES: tuple[str, ...] = (
    "what is spl",
    "what's spl",
    "how do i",
    "how do you",
    "explain the command",
    "explain the spl",
    "what does the command",
    "syntax for",
)

# "what does <X> mean in splunk", "what does <X> command do", etc.
_CONCEPTUAL_REGEX = re.compile(
    r"what\s+(?:does|do|is|are)\b.*\b(?:mean|do|work)\b.*\bsplunk\b"
    r"|what\s+(?:does|do)\b.*\bcommand\b.*\b(?:do|mean)\b",
    re.IGNORECASE,
)


def _is_conceptual_splunk_question(question: str) -> bool:
    lower = question.lower()
    if any(phrase in lower for phrase in _CONCEPTUAL_PHRASES):
        return True
    return bool(_CONCEPTUAL_REGEX.search(question))


def _clean_spl_response(text: str) -> str:
    """Strip code fences / language hints from an LLM-generated SPL response."""
    s = text.strip()
    if s.startswith("```"):
        # Drop the leading fence + optional language tag.
        s = s.lstrip("`")
        if s.lower().startswith("spl"):
            s = s[3:]
        elif s.lower().startswith("splunk"):
            s = s[6:]
        s = s.strip("`").strip()
    # Drop trailing fence if any.
    if s.endswith("```"):
        s = s[: -3].rstrip()
    return s.strip()


# ---- Starter-kit helpers --------------------------------------------------


def _categorize_index(name: str) -> str:
    """Bucket a demo index by purpose so we can pick relevant starter tasks."""
    if name in ("auth_events", "firewall_logs"):
        return "security"
    if name in ("web_logs", "app_metrics"):
        return "application"
    if name in ("deploy_logs",):
        return "deployment"
    return "other"


def _runbook_severity(alert_name: str) -> str:
    """Map an alert name to the runbook severity vocabulary."""
    lower = alert_name.lower()
    if "critical" in lower:
        return "critical"
    if "info" in lower:
        return "info"
    return "warning"


def _as_str_list(value: Any) -> list[str]:
    """Coerce an LLM-supplied ``first_checks`` value into a clean list of strings."""
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _extract_json_object(text: str) -> dict[str, Any] | None:
    """Best-effort parse of a JSON object from a possibly-fenced LLM reply.

    Strips ```` ```json ```` fencing and narrows to the outermost ``{...}`` so
    trailing prose doesn't break parsing. Returns ``None`` on any failure —
    callers always have a non-LLM fallback.
    """
    if not text:
        return None
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").strip()
        if cleaned[:4].lower() == "json":
            cleaned = cleaned[4:].strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        parsed = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _generate_simple_xml(panels: list[DashboardPanel], title: str) -> str:
    """Render panels as importable Splunk Simple XML.

    Titles and SPL are XML-escaped — alert SPL routinely contains ``<``, ``>``
    and ``&``, which would otherwise produce a malformed (non-importable)
    dashboard.
    """
    rows: list[str] = []
    for panel in panels:
        viz_element = {
            "table": "<table />",
            "timechart": "<chart />",
            "single": "<single />",
            "bar": "<chart />",
        }.get(panel.viz_type, "<table />")

        rows.append(
            f"""  <row>
    <panel>
      <title>{escape(panel.title)}</title>
      <search>
        <query>{escape(panel.spl)}</query>
        <earliest>-24h@h</earliest>
        <latest>now</latest>
      </search>
      {viz_element}
    </panel>
  </row>"""
        )

    body = "\n".join(rows)
    return (
        '<dashboard version="1.1">\n'
        f"  <label>{escape(title)}</label>\n"
        "  <description>Auto-generated by Cairn based on environment analysis</description>\n"
        f"{body}\n"
        "</dashboard>"
    )


def _strip_leading_h2(body: str, title: str) -> str:
    """If the model echoes the section title as an H2, strip it."""
    lines = body.lstrip().splitlines()
    if not lines:
        return body
    first = lines[0].strip()
    if first.startswith("## ") and title.lower() in first.lower():
        return "\n".join(lines[1:]).lstrip()
    if first.startswith("# ") and title.lower() in first.lower():
        return "\n".join(lines[1:]).lstrip()
    return body
