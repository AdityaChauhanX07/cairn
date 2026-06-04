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

from groq import AsyncGroq

try:
    from groq import RateLimitError  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover — older groq versions
    RateLimitError = Exception  # type: ignore[misc,assignment]

from config import Settings, get_settings
from mcp_client import SplunkMCPClient, SplunkMCPError

from .discovery import DiscoveryEngine, Finding
from .graph import EdgeType, NodeType, RelationshipGraph, SPLParser

logger = logging.getLogger(__name__)


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

        yield self._with_graph(
            AgentEvent(
                phase=AgentPhase.DONE,
                message="exploration complete; ready to generate guide",
                data={"summary": self._graph.summary()},
            )
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

        for title, context_fn, prompt_fn in _GUIDE_SECTIONS:
            yield AgentEvent(
                phase=AgentPhase.SYNTHESIZE,
                message=f"writing section: {title}",
            )
            context = context_fn(self)
            prompt = prompt_fn(title, context)
            try:
                body = (await self._llm_call(prompt, max_tokens=1000)).strip()
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

    async def ask(self, question: str) -> str:
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
        """
        # ---- conceptual Splunk-domain question → saia_ask_splunk_question ----
        # General "what is SPL / how does this command work" questions are best
        # answered by Splunk's own AI Assistant. Try it first; any failure (or
        # an unavailable tool) drops through to the graph-grounded LLM flow.
        if _is_conceptual_splunk_question(question) and self._mcp.has_saia():
            try:
                answer = (await self._mcp.ask_splunk_question(question)).strip()
                if answer and "error" not in answer.lower():
                    return answer
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

        prompt_parts = [
            "You are Cairn, an AI assistant that already explored this Splunk "
            "environment and can answer questions about it. Use the relationship "
            "graph below as ground truth. Where you reference an artifact, name "
            "it precisely. If the graph doesn't contain the answer, say so "
            "explicitly rather than guessing. Write in a warm, direct style — "
            "you're talking to an engineer who just got paged.\n",
            f"QUESTION: {question}\n",
            f"GRAPH:\n{json.dumps(snapshot, indent=2)[:12000]}",
        ]
        prompt_parts.extend(live_sections)
        prompt = "\n\n".join(prompt_parts)
        try:
            answer = (await self._llm_call(prompt, max_tokens=1000)).strip()
        except Exception as exc:
            logger.warning("ask() LLM call failed: %s", exc)
            return _ASK_UNAVAILABLE_MESSAGE
        # _llm_call returns a fallback marker (rather than raising) when it
        # exhausts retries on a rate limit; translate it for the Q&A context.
        if not answer or answer == _RATE_LIMIT_SECTION_FALLBACK or "rate_limit_exceeded" in answer:
            return _ASK_UNAVAILABLE_MESSAGE
        return answer

    async def _draft_live_spl(self, question: str) -> str:
        """Ask the LLM for an SPL query that answers ``question``.

        Returns the SPL string (or ``"NO_QUERY"`` if not answerable via SPL).
        """
        index_summaries: list[dict[str, Any]] = []
        for node in self._graph.nodes_by_type(NodeType.INDEX):
            if node.properties.get("placeholder"):
                continue
            if node.name.startswith("_"):
                continue
            sourcetypes = [
                e.source.split(":", 1)[1] if ":" in e.source else e.source
                for e in self._graph.in_edges(node.id, EdgeType.SOURCETYPE_OF)
            ]
            index_summaries.append({"index": node.name, "sourcetypes": sourcetypes[:10]})

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


# Title of the alerts section — referenced both in the section table and in
# the synthesis loop (which appends dependency trees to this section only).
_ALERTS_SECTION_TITLE = "Critical Alerts & What They Mean"

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
