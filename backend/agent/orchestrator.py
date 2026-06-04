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
import time
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any

from groq import AsyncGroq

try:
    from groq import RateLimitError  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover — older groq versions
    RateLimitError = Exception  # type: ignore[misc,assignment]

from config import Settings, get_settings
from mcp_client import SplunkMCPClient

from .discovery import DiscoveryEngine, Finding
from .graph import EdgeType, NodeType, RelationshipGraph, SPLParser

logger = logging.getLogger(__name__)


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
        )
        self._guide: OnboardingGuide | None = None
        self._lock = asyncio.Lock()

    # ---- public accessors ----

    @property
    def graph(self) -> RelationshipGraph:
        return self._graph

    @property
    def guide(self) -> OnboardingGuide | None:
        return self._guide

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
        raise RuntimeError(f"Groq call exhausted retries: {last_exc}")

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

    async def _run_explore(self) -> AsyncIterator[AgentEvent]:
        # ---- Orient ----
        yield AgentEvent(phase=AgentPhase.ORIENT, message="getting the lay of the land")
        async for finding in self._discovery.orient():
            yield _finding_to_event(AgentPhase.ORIENT, finding)
            await self._discovery.yield_back()

        # ---- Discover knowledge objects ----
        yield AgentEvent(
            phase=AgentPhase.INVESTIGATE, message="enumerating knowledge objects"
        )
        async for finding in self._discovery.discover_knowledge_objects():
            yield _finding_to_event(AgentPhase.INVESTIGATE, finding)
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
            yield _finding_to_event(AgentPhase.INVESTIGATE, finding)
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
                yield _finding_to_event(AgentPhase.INVESTIGATE, finding)

        # ---- Usage data ----
        yield AgentEvent(
            phase=AgentPhase.INVESTIGATE, message="reading _audit for real usage signals"
        )
        async for finding in self._discovery.gather_usage():
            yield _finding_to_event(AgentPhase.INVESTIGATE, finding)

        # ---- Explain SPL for alerts (~3 LLM calls) ----
        yield AgentEvent(
            phase=AgentPhase.INVESTIGATE,
            message="explaining alert SPL via the LLM",
        )
        async for finding in self._discovery.explain_user_facing_spls(
            node_types=(NodeType.ALERT,),
            max_explanations=5,
        ):
            yield _finding_to_event(AgentPhase.INVESTIGATE, finding)

        yield AgentEvent(
            phase=AgentPhase.DONE,
            message="exploration complete; ready to generate guide",
            data={"summary": self._graph.summary()},
        )

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
        return (await self._llm_call(prompt, max_tokens=500)).strip()

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

        for title, context_fn, prompt_fn in _GUIDE_SECTIONS:
            yield AgentEvent(
                phase=AgentPhase.SYNTHESIZE,
                message=f"writing section: {title}",
            )
            context = context_fn(self)
            prompt = prompt_fn(title, context)
            try:
                body = (await self._llm_call(prompt, max_tokens=1500)).strip()
            except Exception as exc:
                logger.warning("section %r failed: %s", title, exc)
                yield AgentEvent(
                    phase=AgentPhase.ERROR,
                    message=f"failed to write section {title}",
                    detail=str(exc),
                )
                body = f"_(generation failed: {exc})_"

            # Some models will themselves prefix the title; strip a leading H2
            # so we don't double up when we add ours.
            body_stripped = _strip_leading_h2(body, title)
            sections[title] = body_stripped
            markdown_chunks.append(f"## {title}\n\n{body_stripped}\n")
            yield AgentEvent(
                phase=AgentPhase.SYNTHESIZE,
                message=f"section ready: {title}",
                data={"section": title, "preview": body_stripped[:200]},
            )

        markdown = "\n".join(markdown_chunks).strip()
        self._guide = OnboardingGuide(
            markdown=markdown,
            sections=sections,
            graph_snapshot=graph_snapshot,
        )
        yield AgentEvent(
            phase=AgentPhase.DONE,
            message="guide ready",
            data={"section_count": len(sections)},
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
                    "paths": [
                        [{"type": n.type.value, "name": n.name} for n in p]
                        for p in paths
                    ],
                }
            )
        return chains

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

    async def ask(self, question: str) -> str:
        """Answer a follow-up question grounded in the discovered graph."""
        snapshot = self._graph.to_dict()
        prompt = (
            "You are Cairn, an AI assistant that already explored this Splunk "
            "environment and can answer questions about it. Use the relationship "
            "graph below as ground truth. Where you reference an artifact, name "
            "it precisely. If the graph doesn't contain the answer, say so "
            "explicitly rather than guessing. Write in a warm, direct style — "
            "you're talking to an engineer who just got paged.\n\n"
            f"QUESTION: {question}\n\n"
            f"GRAPH:\n{json.dumps(snapshot, indent=2)[:12000]}"
        )
        return (await self._llm_call(prompt, max_tokens=1000)).strip()


# ---- Section definitions --------------------------------------------------


def _prompt_critical_alerts(title: str, ctx: dict[str, Any]) -> str:
    return (
        f"You are writing the '{title}' section of an onboarding guide for a "
        "Splunk newcomer. For each alert below, walk the dependency chain "
        "(alert → saved search → macro → lookup → index) and explain in 2-3 "
        "sentences: what triggers it, what data feeds it, and what the on-call "
        "engineer should do when it fires at 3am. Use the spl_explanation "
        "field if present — it's already a plain-English summary of the SPL. "
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


# (section_title, context_builder, prompt_builder)
_GUIDE_SECTIONS: tuple[tuple[str, Any, Any], ...] = (
    ("Critical Alerts & What They Mean", Orchestrator._ctx_critical_alerts, _prompt_critical_alerts),
    ("Your Data Landscape", Orchestrator._ctx_data_landscape, _prompt_data_landscape),
    ("Your Team's Dashboards", Orchestrator._ctx_dashboards, _prompt_dashboards),
    ("The Shorthand", Orchestrator._ctx_shorthand, _prompt_shorthand),
    ("Who Knows What", Orchestrator._ctx_ownership, _prompt_ownership),
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
