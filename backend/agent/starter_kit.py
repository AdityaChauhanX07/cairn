"""
Mode C — Starter Kit Generator

Produces:
1. Generated SPL for common tasks the newcomer will need
2. Per-alert runbooks (what it means, what to check, who to contact)
3. A dashboard skeleton (Simple XML with panel SPL)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class GeneratedSPL:
    """A generated SPL query for a common task."""

    title: str          # e.g. "Find failed login attempts in the last hour"
    description: str     # Plain English description of what this query does
    spl: str             # The actual SPL query
    category: str        # "security" | "application" | "infrastructure" | "troubleshooting"


@dataclass
class Runbook:
    """A per-alert runbook."""

    alert_name: str
    severity: str        # "critical" | "warning" | "info"
    what_it_means: str   # Plain English explanation
    chain_summary: str   # "reads from auth_events → uses macro high_severity_filter → lookups known_bad_ips"
    first_checks: list[str]  # First 3-5 things to check
    spl_to_run: str      # An investigative SPL to run when this fires
    who_to_contact: str  # Based on ownership data if available


@dataclass
class DashboardPanel:
    """A panel in the generated dashboard."""

    title: str
    spl: str
    viz_type: str        # "table" | "timechart" | "single" | "bar"


@dataclass
class StarterKit:
    """The complete starter kit output."""

    generated_queries: list[GeneratedSPL] = field(default_factory=list)
    runbooks: list[Runbook] = field(default_factory=list)
    dashboard_panels: list[DashboardPanel] = field(default_factory=list)
    dashboard_xml: str = ""  # The complete Simple XML dashboard

    def to_dict(self) -> dict[str, Any]:
        return {
            "generated_queries": [
                {"title": q.title, "description": q.description, "spl": q.spl, "category": q.category}
                for q in self.generated_queries
            ],
            "runbooks": [
                {
                    "alert_name": r.alert_name,
                    "severity": r.severity,
                    "what_it_means": r.what_it_means,
                    "chain_summary": r.chain_summary,
                    "first_checks": r.first_checks,
                    "spl_to_run": r.spl_to_run,
                    "who_to_contact": r.who_to_contact,
                }
                for r in self.runbooks
            ],
            "dashboard_panels": [
                {"title": p.title, "spl": p.spl, "viz_type": p.viz_type}
                for p in self.dashboard_panels
            ],
            "dashboard_xml": self.dashboard_xml,
        }
