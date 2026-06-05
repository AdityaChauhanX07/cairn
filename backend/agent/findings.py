"""
Mode B — Environment Hygiene Findings (Flag)

Turns the relationship graph into hygiene findings — the things a senior
engineer notices while walking an inherited Splunk: objects nobody references,
alerts pointed at empty indexes, alerts that fire into the void (no action) or
have no owner.

Each finding carries a ready-to-apply remediation (the Flag -> Fix bridge):
a deterministic templated ``fix`` always, plus an optional LLM-tuned ``fix_spl``
when a concrete query fix helps. The agent advises and generates the fix; the
human applies it. Nothing here mutates Splunk.

This module is intentionally I/O-free (pure dataclasses) so it can be
unit-tested without any Splunk or LLM connection — the detection logic lives in
``Orchestrator._run_generate_findings``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Finding categories (reliable tier — graph/metadata-derived, work on a fresh trial).
CATEGORY_ORPHAN = "orphaned_object"
CATEGORY_ALERT_EMPTY_INDEX = "alert_empty_index"
CATEGORY_ALERT_NO_ACTION = "alert_no_action"
CATEGORY_ALERT_NO_OWNER = "alert_no_owner"

# Severities.
SEV_HIGH = "high"
SEV_MEDIUM = "medium"
SEV_LOW = "low"


@dataclass
class Finding:
    """A single environment-hygiene finding with its remediation."""

    id: str                       # stable id, e.g. "orphan:lookup:service_owners"
    category: str                 # one of the CATEGORY_* constants
    severity: str                 # "high" | "medium" | "low"
    title: str                    # short headline, e.g. "Orphaned lookup: service_owners"
    summary: str                  # plain-English explanation of why it's flagged
    evidence: dict[str, Any] = field(default_factory=dict)  # the data that backs the flag
    affected_node_id: str = ""    # graph node id (for dead-node highlighting in the UI)
    fix: str = ""                 # ready-to-apply remediation (always present)
    fix_spl: str = ""             # optional tuned SPL remediation ("" when N/A)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "category": self.category,
            "severity": self.severity,
            "title": self.title,
            "summary": self.summary,
            "evidence": self.evidence,
            "affected_node_id": self.affected_node_id,
            "fix": self.fix,
            "fix_spl": self.fix_spl,
        }


@dataclass
class FindingsReport:
    """The complete Mode B output."""

    findings: list[Finding] = field(default_factory=list)
    # Graph node ids the UI should highlight as dead/orphaned in the relationship graph.
    dead_node_ids: list[str] = field(default_factory=list)

    @property
    def counts(self) -> dict[str, int]:
        """Findings tally — total plus a breakdown by category and severity."""
        by_category: dict[str, int] = {}
        by_severity: dict[str, int] = {}
        for f in self.findings:
            by_category[f.category] = by_category.get(f.category, 0) + 1
            by_severity[f.severity] = by_severity.get(f.severity, 0) + 1
        return {
            "total": len(self.findings),
            **{f"category:{k}": v for k, v in by_category.items()},
            **{f"severity:{k}": v for k, v in by_severity.items()},
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "findings": [f.to_dict() for f in self.findings],
            "dead_node_ids": list(self.dead_node_ids),
            "counts": self.counts,
        }
