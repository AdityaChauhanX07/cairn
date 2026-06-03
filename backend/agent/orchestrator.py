"""Orchestrator — the agentic Orient/Reason/Investigate/Decide/Synthesize loop.

This is the *brain* of Cairn. It owns the relationship graph, drives the
discovery engine, and hands the graph to Claude at the moments where
reasoning is needed (deciding what to investigate next, explaining SPL,
synthesizing the final guide).

Key design choice: the loop is **agentic, not pipelined**. After each round
of discovery, we ask Claude to inspect a structured summary of the graph
and tell us what looks most worth investigating next. The orchestrator
acts on those recommendations until either the agent says "done" or we hit
``max_agent_iterations``.

The orchestrator emits ``AgentEvent``s. The API layer turns those into SSE
frames. Each event carries enough context that the UI can render the
agent's reasoning live without needing further round-trips.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any

from anthropic import AsyncAnthropic
from anthropic.types import MessageParam

from config import Settings, get_settings
from mcp_client import SplunkMCPClient, SplunkMCPError

from .discovery import DiscoveryEngine, Finding
from .graph import EdgeType, NodeType, RelationshipGraph, SPLParser

logger = logging.getLogger(__name__)


# ---- Events ---------------------------------------------------------------


class AgentPhase(str, Enum):
    ORIENT = "orient"
    REASON = "reason"
    INVESTIGATE = "investigate"
    DECIDE = "decide"
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


# ---- Guide data class -----------------------------------------------------


@dataclass
class OnboardingGuide:
    """The final artifact Cairn produces."""

    markdown: str
    sections: dict[str, str] = field(default_factory=dict)
    graph_snapshot: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ---- Orchestrator ---------------------------------------------------------


class Orchestrator:
    """Cairn's agent brain. Owns the loop, the graph, and the Claude client."""

    def __init__(
        self,
        mcp_client: SplunkMCPClient,
        *,
        settings: Settings | None = None,
        anthropic: AsyncAnthropic | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._mcp = mcp_client
        self._graph = RelationshipGraph()
        self._discovery = DiscoveryEngine(mcp_client, self._graph, parser=SPLParser())
        self._anthropic = anthropic or AsyncAnthropic(
            api_key=self._settings.anthropic_api_key.get_secret_value()
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

    # ---- the main loop ----

    async def explore(self) -> AsyncIterator[AgentEvent]:
        """Run the full Orient -> Reason -> Investigate -> Decide -> Synthesize loop."""
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
        yield AgentEvent(
            phase=AgentPhase.ORIENT,
            message="getting the lay of the land",
        )
        async for finding in self._discovery.orient():
            yield _finding_to_event(AgentPhase.ORIENT, finding)
            await self._discovery.yield_back()

        # ---- Investigate (first sweep) ----
        yield AgentEvent(
            phase=AgentPhase.INVESTIGATE,
            message="enumerating knowledge objects",
        )
        async for finding in self._discovery.discover_knowledge_objects():
            yield _finding_to_event(AgentPhase.INVESTIGATE, finding)
            await self._discovery.yield_back()

        yield AgentEvent(
            phase=AgentPhase.INVESTIGATE,
            message="profiling indexes",
        )
        async for finding in self._discovery.enrich_indexes():
            yield _finding_to_event(AgentPhase.INVESTIGATE, finding)
            await self._discovery.yield_back()

        # ---- Decide -> Reason loop ----
        for iteration in range(self._settings.max_agent_iterations):
            yield AgentEvent(
                phase=AgentPhase.DECIDE,
                message=f"iteration {iteration + 1}: checking for unresolved references",
                data={"summary": self._graph.summary()},
            )

            unresolved = self._graph.placeholders()
            if unresolved:
                yield AgentEvent(
                    phase=AgentPhase.INVESTIGATE,
                    message=f"resolving {len(unresolved)} placeholder reference(s)",
                    data={"placeholders": [p.name for p in unresolved][:20]},
                )
                async for finding in self._discovery.resolve_placeholders():
                    yield _finding_to_event(AgentPhase.INVESTIGATE, finding)

            # ---- Reason: ask Claude what to do next ----
            yield AgentEvent(
                phase=AgentPhase.REASON,
                message="asking Claude what looks worth investigating",
            )
            try:
                plan = await self._reason_next_step()
            except Exception as exc:
                logger.warning("reasoning step failed: %s", exc)
                yield AgentEvent(
                    phase=AgentPhase.ERROR,
                    message="reasoning step failed; continuing with default plan",
                    detail=str(exc),
                )
                plan = {"actions": [], "done": True, "rationale": "fallback after reasoning error"}

            yield AgentEvent(
                phase=AgentPhase.REASON,
                message=plan.get("rationale") or "Claude responded",
                data={"plan": plan},
            )

            actions = plan.get("actions") or []
            if plan.get("done") or not actions:
                break

            # ---- Investigate: execute Claude's suggested actions ----
            for action in actions:
                async for event in self._execute_action(action):
                    yield event

        # ---- Usage data ----
        yield AgentEvent(
            phase=AgentPhase.INVESTIGATE,
            message="reading _audit for real usage signals",
        )
        async for finding in self._discovery.gather_usage():
            yield _finding_to_event(AgentPhase.INVESTIGATE, finding)

        # ---- Synthesize ----
        yield AgentEvent(
            phase=AgentPhase.SYNTHESIZE,
            message="writing the onboarding guide",
            data={"summary": self._graph.summary()},
        )
        try:
            guide = await self._synthesize_guide()
            self._guide = guide
            yield AgentEvent(
                phase=AgentPhase.SYNTHESIZE,
                message="guide ready",
                data={"section_count": len(guide.sections)},
            )
        except Exception as exc:
            logger.exception("synthesis failed")
            yield AgentEvent(
                phase=AgentPhase.ERROR,
                message="synthesis failed",
                detail=str(exc),
            )

        yield AgentEvent(
            phase=AgentPhase.DONE,
            message="exploration complete",
            data={"summary": self._graph.summary()},
        )

    # ---- Reason step ----

    async def _reason_next_step(self) -> dict[str, Any]:
        """Ask Claude to inspect the graph and propose next actions.

        Returns ``{"actions": [...], "done": bool, "rationale": str}``.
        Action shapes are:
            {"type": "sample_saved_search", "name": "..."}
            {"type": "explain_spl", "spl": "..."}
            {"type": "investigate_index", "name": "..."}
        """
        summary = self._graph.summary()
        # Pick a few representative artifacts so Claude has something concrete
        # to react to without us shipping the whole graph every iteration.
        sample_alerts = [
            {"name": n.name, "spl": (n.properties.get("spl") or "")[:400]}
            for n in self._graph.nodes_by_type(NodeType.ALERT)[:5]
        ]
        sample_saved = [
            {
                "name": n.name,
                "usage_count_24h": n.properties.get("usage_count_24h"),
                "spl": (n.properties.get("spl") or "")[:400],
            }
            for n in self._graph.nodes_by_type(NodeType.SAVED_SEARCH)[:5]
        ]

        prompt = (
            "You are guiding an agentic exploration of a Splunk deployment. "
            "Below is a summary of what's been discovered so far. Decide what "
            "the agent should investigate next, or say it's done.\n\n"
            f"GRAPH SUMMARY:\n{json.dumps(summary, indent=2)}\n\n"
            f"SAMPLE ALERTS:\n{json.dumps(sample_alerts, indent=2)}\n\n"
            f"SAMPLE SAVED SEARCHES:\n{json.dumps(sample_saved, indent=2)}\n\n"
            "Return STRICT JSON with this shape:\n"
            '{"done": bool, "rationale": "<one sentence>", '
            '"actions": [{"type": "sample_saved_search"|"explain_spl"|"investigate_index", '
            '"name": "<for sample/investigate>", "spl": "<for explain>"}]}\n'
            "Cap actions at 5. Prefer actions that resolve dependency chains "
            "the user would care about (alerts + their macros/lookups)."
        )

        messages: list[MessageParam] = [{"role": "user", "content": prompt}]
        response = await self._anthropic.messages.create(
            model=self._settings.claude_model,
            max_tokens=1024,
            messages=messages,
        )
        text = _join_text(response)
        return _parse_json_or_default(
            text,
            default={"done": True, "rationale": "no parseable plan; stopping", "actions": []},
        )

    # ---- Action dispatch ----

    async def _execute_action(self, action: dict[str, Any]) -> AsyncIterator[AgentEvent]:
        action_type = action.get("type")
        if action_type == "sample_saved_search":
            name = action.get("name")
            if not isinstance(name, str) or not name:
                return
            yield AgentEvent(
                phase=AgentPhase.INVESTIGATE,
                message=f"sampling saved search {name}",
            )
            finding = await self._discovery.sample_saved_search(name)
            yield _finding_to_event(AgentPhase.INVESTIGATE, finding)

        elif action_type == "explain_spl":
            spl = action.get("spl")
            if not isinstance(spl, str) or not spl.strip():
                return
            yield AgentEvent(
                phase=AgentPhase.INVESTIGATE,
                message="explaining SPL",
                detail=spl[:200],
            )
            explanation = await self._explain_spl(spl)
            yield AgentEvent(
                phase=AgentPhase.INVESTIGATE,
                message="got SPL explanation",
                data={"spl": spl, "explanation": explanation},
            )

        elif action_type == "investigate_index":
            name = action.get("name")
            if not isinstance(name, str) or not name:
                return
            yield AgentEvent(
                phase=AgentPhase.INVESTIGATE,
                message=f"investigating index {name}",
            )
            try:
                info = await self._mcp.get_index_info(name)
                sts = await self._mcp.get_metadata(name, kind="sourcetypes")
            except SplunkMCPError as exc:
                yield AgentEvent(
                    phase=AgentPhase.ERROR,
                    message=f"failed to investigate index {name}",
                    detail=str(exc),
                )
                return
            yield AgentEvent(
                phase=AgentPhase.INVESTIGATE,
                message=f"index {name}: {len(sts)} sourcetypes",
                data={"info": info, "sourcetypes": sts},
            )
        else:
            logger.warning("unknown action type from Claude: %r", action_type)

    # ---- SPL explanation w/ fallback ----

    async def _explain_spl(self, spl: str) -> str:
        """Prefer the SAIA tool; fall back to Claude when it's unavailable."""
        if self._mcp.has_saia():
            try:
                return await self._mcp.explain_spl(spl)
            except SplunkMCPError as exc:
                logger.info("saia explain_spl failed, falling back to Claude: %s", exc)

        prompt = (
            "Explain the following SPL query in plain English for a Splunk newcomer. "
            "Identify what it searches, what fields it filters/aggregates, and what "
            "macros / lookups / indexes it depends on. Be concise — 3 short paragraphs max.\n\n"
            f"SPL:\n```\n{spl}\n```"
        )
        response = await self._anthropic.messages.create(
            model=self._settings.claude_model,
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        return _join_text(response)

    # ---- Synthesis ----

    async def _synthesize_guide(self) -> OnboardingGuide:
        """Hand the full graph to Claude and ask for the onboarding guide."""
        graph_snapshot = self._graph.to_dict()
        alerts = self._collect_alert_chains()
        ownership_signals = self._collect_ownership_signals()

        prompt = (
            "You are writing an onboarding guide for an engineer who just joined "
            "a team that runs on Splunk. They have access to the deployment but no "
            "context about why anything was built. Below is the relationship graph "
            "Cairn discovered. Write the guide in Markdown with EXACTLY these five "
            "H2 sections, in order:\n\n"
            "## Critical Alerts & What They Mean\n"
            "## Your Data Landscape\n"
            "## Your Team's Dashboards\n"
            "## The Shorthand\n"
            "## Who Knows What\n\n"
            "For each alert in section 1, walk the dependency chain "
            "(alert -> saved search -> macro -> lookup -> index) and explain what "
            "would trigger it. For section 2, group indexes by inferred purpose. "
            "For section 3, describe what each dashboard answers and how often it's "
            "actually used. For section 4, explain macros and lookups in the context "
            "of WHERE they appear. For section 5, infer ownership from creation/"
            "modification metadata and audit usage.\n\n"
            f"ALERT CHAINS:\n{json.dumps(alerts, indent=2)[:8000]}\n\n"
            f"OWNERSHIP SIGNALS:\n{json.dumps(ownership_signals, indent=2)[:4000]}\n\n"
            f"GRAPH SUMMARY:\n{json.dumps(graph_snapshot['summary'], indent=2)}\n\n"
            "Write the guide now. No preamble, just the five H2 sections."
        )

        response = await self._anthropic.messages.create(
            model=self._settings.claude_model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        markdown = _join_text(response).strip()
        sections = _split_sections(markdown)
        return OnboardingGuide(
            markdown=markdown,
            sections=sections,
            graph_snapshot=graph_snapshot,
        )

    def _collect_alert_chains(self) -> list[dict[str, Any]]:
        chains: list[dict[str, Any]] = []
        for alert in self._graph.nodes_by_type(NodeType.ALERT):
            paths = self._graph.trace_chain(alert.id, max_depth=6)
            chains.append(
                {
                    "name": alert.name,
                    "spl": alert.properties.get("spl"),
                    "owner": alert.properties.get("owner"),
                    "alert_severity": alert.properties.get("alert_severity"),
                    "usage_count_24h": alert.properties.get("usage_count_24h"),
                    "paths": [[{"type": n.type.value, "name": n.name} for n in p] for p in paths],
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
        """Answer a follow-up question using the graph + Claude."""
        snapshot = self._graph.to_dict()
        prompt = (
            "You are Cairn, an AI assistant that already explored this Splunk "
            "environment and can answer questions about it. Use the relationship "
            "graph below as ground truth. If the graph doesn't contain the answer, "
            "say so explicitly rather than guessing.\n\n"
            f"QUESTION: {question}\n\n"
            f"GRAPH:\n{json.dumps(snapshot, indent=2)[:12000]}"
        )
        response = await self._anthropic.messages.create(
            model=self._settings.claude_model,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        return _join_text(response).strip()


# ---- helpers -------------------------------------------------------------


def _finding_to_event(phase: AgentPhase, finding: Finding) -> AgentEvent:
    return AgentEvent(
        phase=phase,
        message=finding.message,
        detail=finding.detail,
        data=finding.data,
    )


def _join_text(response: Any) -> str:
    """Concatenate every text block in an Anthropic Message response."""
    pieces: list[str] = []
    for block in getattr(response, "content", []) or []:
        text = getattr(block, "text", None)
        if isinstance(text, str):
            pieces.append(text)
    return "\n".join(pieces)


def _parse_json_or_default(text: str, *, default: dict[str, Any]) -> dict[str, Any]:
    """Tolerant JSON extraction — handles Claude wrapping JSON in code fences."""
    if not text:
        return default
    stripped = text.strip()
    # Strip markdown code fences if present.
    if stripped.startswith("```"):
        stripped = stripped.strip("`")
        # Possibly leading "json\n"
        if stripped.lower().startswith("json"):
            stripped = stripped[4:]
        stripped = stripped.strip("`").strip()

    # Find the outermost JSON object.
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return default
    candidate = stripped[start : end + 1]
    try:
        result = json.loads(candidate)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        pass
    return default


def _split_sections(markdown: str) -> dict[str, str]:
    """Split a markdown document by H2 headers into a {header: body} dict."""
    sections: dict[str, str] = {}
    current_header: str | None = None
    current_body: list[str] = []
    for line in markdown.splitlines():
        if line.startswith("## "):
            if current_header is not None:
                sections[current_header] = "\n".join(current_body).strip()
            current_header = line[3:].strip()
            current_body = []
        else:
            current_body.append(line)
    if current_header is not None:
        sections[current_header] = "\n".join(current_body).strip()
    return sections
