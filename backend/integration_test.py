#!/usr/bin/env python3
"""Integration test for the Splunk MCP → discovery → graph pipeline.

Drives the discovery engine through every phase against a real Splunk MCP
server, prints every event as it streams, and dumps the resulting
relationship graph + alert dependency chains at the end.

**No LLM calls.** The orchestrator's Reason and Synthesize phases (which
invoke Groq) are intentionally skipped — this script tests data flow only.
We don't pass a mock LLM to the discovery engine because the discovery
engine has no LLM dependency; it's the orchestrator that owns the LLM
client. So we drive discovery directly in the same order the orchestrator
would, without instantiating it.

Run from the repo root::

    python backend/integration_test.py
"""

from __future__ import annotations

import asyncio
import json
import sys
import traceback
from pathlib import Path
from typing import Any

# ---- Make ``backend/`` importable when run from the repo root ----------------
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from config import configure_logging, get_settings  # noqa: E402
from mcp_client import SplunkMCPClient, SplunkMCPError  # noqa: E402
from mcp_client.client import (  # noqa: E402
    TRANSPORT_SSE,
    TRANSPORT_STREAMABLE_HTTP,
)
from agent.discovery import DiscoveryEngine, Finding  # noqa: E402
from agent.graph import NodeType, RelationshipGraph, SPLParser  # noqa: E402


_LLM_PLACEHOLDER = "[LLM call skipped in integration test]"


# ---- Output helpers ---------------------------------------------------------


def _truncate_json(value: Any, *, limit: int = 800) -> str:
    try:
        text = json.dumps(value, indent=2, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        text = repr(value)
    if len(text) > limit:
        return text[:limit] + f"\n... (truncated, {len(text)} chars total)"
    return text


def _print_finding(phase: str, finding: Finding) -> None:
    """One streamed discovery finding, indented for readability."""
    tag = "✗" if finding.kind == "error" else "•"
    print(f"  {tag} [{phase}] {finding.message}")
    if finding.detail:
        print(f"      detail: {finding.detail}")
    if finding.data:
        for line in _truncate_json(finding.data, limit=500).splitlines():
            print(f"      {line}")


def _section(title: str) -> None:
    print()
    print("═" * 70)
    print(f" {title}")
    print("═" * 70)


# ---- Connection w/ transport fallback ---------------------------------------


async def _try_connect(url: str, token: str, transport: str) -> SplunkMCPClient | None:
    client = SplunkMCPClient(url, token, transport=transport)
    try:
        await client.connect()
        return client
    except SplunkMCPError as exc:
        print(f"  ! {transport}: {exc}")
    except Exception as exc:
        print(f"  ! {transport} raised {type(exc).__name__}: {exc}")
        traceback.print_exc()
    try:
        await client.aclose()
    except Exception:
        pass
    return None


async def _open_client(url: str, token: str) -> SplunkMCPClient:
    print(f"Connecting to Splunk MCP at {url} ...")
    for transport in (TRANSPORT_STREAMABLE_HTTP, TRANSPORT_SSE):
        print(f"  • trying transport={transport}")
        client = await _try_connect(url, token, transport)
        if client is not None:
            print(f"  ✓ connected via {transport}")
            return client
    print("  ✗ could not connect with any transport. Exiting.")
    sys.exit(2)


# ---- Discovery driver -------------------------------------------------------


async def _drive_discovery(client: SplunkMCPClient, graph: RelationshipGraph) -> None:
    """Run every discovery phase in the same order the orchestrator would.

    Phases that would otherwise call the LLM (Reason, Synthesize) are
    replaced with a print statement noting the skip.
    """
    discovery = DiscoveryEngine(client, graph, parser=SPLParser())

    _section("Phase 1: Orient")
    async for finding in discovery.orient():
        _print_finding("ORIENT", finding)
        await discovery.yield_back()

    _section("Phase 2: Discover knowledge objects")
    async for finding in discovery.discover_knowledge_objects():
        _print_finding("DISCOVER", finding)
        await discovery.yield_back()

    _section("Phase 3: Enrich indexes")
    async for finding in discovery.enrich_indexes():
        _print_finding("ENRICH", finding)
        await discovery.yield_back()

    _section("Phase 4: Resolve placeholders")
    async for finding in discovery.resolve_placeholders():
        _print_finding("RESOLVE", finding)

    _section(f"Phase 5: Reason  —  {_LLM_PLACEHOLDER}")
    print(f"  • {_LLM_PLACEHOLDER}")

    _section("Phase 6: Gather usage (_audit)")
    async for finding in discovery.gather_usage():
        _print_finding("USAGE", finding)

    _section(f"Phase 7: Synthesize  —  {_LLM_PLACEHOLDER}")
    print(f"  • {_LLM_PLACEHOLDER}")


# ---- Graph reporting --------------------------------------------------------


def _print_graph_summary(graph: RelationshipGraph) -> None:
    _section("Graph Summary")
    summary = graph.summary()
    print(_truncate_json(summary, limit=4000))


def _print_alert_chains(graph: RelationshipGraph) -> None:
    _section("Alert Dependency Chains")
    alerts = graph.nodes_by_type(NodeType.ALERT)
    if not alerts:
        print("  (no alerts found in this deployment)")
        return
    for alert in alerts:
        print(f"\n  ● {alert.name}")
        spl = alert.properties.get("spl")
        if isinstance(spl, str) and spl:
            print(f"     SPL: {spl[:160]}{'...' if len(spl) > 160 else ''}")
        paths = graph.trace_chain(alert.id, max_depth=6)
        if not paths:
            print("     (no outgoing dependencies)")
            continue
        for i, path in enumerate(paths, 1):
            chain = " → ".join(f"{n.type.value}:{n.name}" for n in path)
            print(f"     {i}. {chain}")


def _print_node_breakdown(graph: RelationshipGraph) -> None:
    _section("Node breakdown by type")
    for node_type in NodeType:
        nodes = graph.nodes_by_type(node_type)
        if not nodes:
            continue
        names_sample = ", ".join(n.name for n in nodes[:10])
        more = f" ... (+{len(nodes) - 10} more)" if len(nodes) > 10 else ""
        print(f"  {node_type.value:14s} ({len(nodes):3d}): {names_sample}{more}")


# ---- Main -------------------------------------------------------------------


async def _async_main() -> int:
    settings = get_settings()
    configure_logging(settings)

    url = settings.splunk_mcp_url
    token = settings.splunk_token.get_secret_value()
    if not url:
        print("ERROR: SPLUNK_MCP_URL is empty. Set it in .env.")
        return 2
    if not token:
        print("ERROR: SPLUNK_TOKEN is empty. Set it in .env.")
        return 2

    client = await _open_client(url, token)
    graph = RelationshipGraph()

    try:
        try:
            await _drive_discovery(client, graph)
        except Exception as exc:
            print(f"\n✗ discovery pipeline raised {type(exc).__name__}: {exc}")
            traceback.print_exc()
            return 1
    finally:
        await client.aclose()

    _print_graph_summary(graph)
    _print_node_breakdown(graph)
    _print_alert_chains(graph)

    print()
    print("=" * 70)
    print(" Integration test complete.")
    print("=" * 70)
    return 0


def main() -> int:
    try:
        return asyncio.run(_async_main())
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
