#!/usr/bin/env python3
"""Offline unit test for Mode B (Flag) findings detection.

Builds a synthetic relationship graph with deliberately planted hygiene
"landmines" and asserts ``Orchestrator.generate_findings`` flags exactly them.
Runs with **no Splunk and no LLM** — the LLM-tuned ``fix_spl`` path is stubbed.

    python backend/test_findings.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from agent.graph import EdgeType, NodeType, RelationshipGraph  # noqa: E402
from agent.orchestrator import Orchestrator  # noqa: E402


def _build_graph() -> RelationshipGraph:
    g = RelationshipGraph()

    # Indexes — one populated, one empty (landmine).
    g.add_node(NodeType.INDEX, "auth_events", {"totalEventCount": 1000, "placeholder": False})
    g.add_node(NodeType.INDEX, "legacy_winlogs", {"totalEventCount": 0, "placeholder": False})

    # Macros — one referenced, one orphan (landmine).
    g.add_node(NodeType.MACRO, "high_severity_filter", {"placeholder": False})
    g.add_node(NodeType.MACRO, "deprecated_geoip_filter", {"placeholder": False})

    # Lookups — one referenced, one orphan (landmine).
    g.add_node(NodeType.LOOKUP, "known_bad_ips", {"placeholder": False})
    g.add_node(NodeType.LOOKUP, "service_owners", {"placeholder": False})

    # Healthy alert — references macro + lookup + populated index, owned, has action.
    a1 = g.add_node(
        NodeType.ALERT,
        "Critical: Multiple Failed Logins",
        {"spl": "index=auth_events ...", "owner": "admin", "actions": "email",
         "alert_track": True, "placeholder": False},
    )
    g.add_edge(a1.id, g.make_id(NodeType.MACRO, "high_severity_filter"), EdgeType.REFERENCES_MACRO)
    g.add_edge(a1.id, g.make_id(NodeType.LOOKUP, "known_bad_ips"), EdgeType.REFERENCES_LOOKUP)
    g.add_edge(a1.id, g.make_id(NodeType.INDEX, "auth_events"), EdgeType.READS_FROM_INDEX)

    # Alert on an empty index (landmine).
    a2 = g.add_node(
        NodeType.ALERT,
        "Legacy Windows Event Monitor",
        {"spl": "index=legacy_winlogs ...", "owner": "admin", "actions": "email",
         "alert_track": True, "placeholder": False},
    )
    g.add_edge(a2.id, g.make_id(NodeType.INDEX, "legacy_winlogs"), EdgeType.READS_FROM_INDEX)

    # Alert with no action and no owner (landmine x2).
    g.add_node(
        NodeType.ALERT,
        "Disk Space Warning",
        {"spl": "index=auth_events ...", "owner": "", "actions": "",
         "alert_track": True, "placeholder": False},
    )

    # Scheduled report (alert_type set but NOT tracked) — must be ignored by Mode B.
    g.add_node(
        NodeType.ALERT,
        "Weekly Usage Report",
        {"spl": "index=auth_events ...", "owner": "admin", "actions": "",
         "alert_track": False, "placeholder": False},
    )
    return g


async def _run() -> int:
    orch = Orchestrator(mcp_client=object(), llm=object())  # type: ignore[arg-type]
    orch._graph = _build_graph()  # swap in the synthetic graph

    async def _no_opt(spl: str) -> str:  # stub the LLM-tuned fix_spl path
        return ""

    orch._optimize_spl_with_fallback = _no_opt  # type: ignore[assignment]

    events = [ev async for ev in orch.generate_findings()]
    report = orch.findings
    assert report is not None, "findings report was not produced"

    by_id = {f.id: f for f in report.findings}
    print(f"produced {len(report.findings)} findings: {sorted(by_id)}")

    expected = {
        "orphan:macro:deprecated_geoip_filter",
        "orphan:lookup:service_owners",
        "empty_index:Legacy Windows Event Monitor:legacy_winlogs",
        "no_action:Disk Space Warning",
        "no_owner:Disk Space Warning",
    }
    missing = expected - set(by_id)
    assert not missing, f"missing expected findings: {missing}"

    # Healthy objects must NOT be flagged.
    for bad in (
        "orphan:macro:high_severity_filter",
        "orphan:lookup:known_bad_ips",
        "empty_index:Critical: Multiple Failed Logins:auth_events",
        "no_action:Critical: Multiple Failed Logins",
        # Untracked scheduled report must not be flagged.
        "no_action:Weekly Usage Report",
        "no_owner:Weekly Usage Report",
    ):
        assert bad not in by_id, f"false positive: {bad}"

    # Every finding carries a non-empty remediation.
    for f in report.findings:
        assert f.fix.strip(), f"finding {f.id} has empty fix"

    # Dead-node ids include the orphans + the empty index.
    assert report.dead_node_ids, "no dead_node_ids collected"
    assert any("legacy_winlogs" in n for n in report.dead_node_ids)

    # A DONE event closed the stream.
    assert events and events[-1].phase.value == "done", "no terminal done event"

    print("counts:", report.counts)
    print("✅ all assertions passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
