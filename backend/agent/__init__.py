"""Cairn agent package.

The agent has three cooperating pieces:

- ``graph``        — the relationship graph + SPL parser (pure, no I/O).
- ``discovery``    — runs MCP tool calls and feeds findings into the graph.
- ``orchestrator`` — drives the agentic Orient/Reason/Investigate/Decide/Synthesize loop.
"""

from .graph import (
    EdgeType,
    NodeType,
    RelationshipGraph,
    SPLParser,
    SPLReferences,
)
from .discovery import DiscoveryEngine
from .orchestrator import AgentEvent, AgentPhase, Orchestrator

__all__ = [
    "AgentEvent",
    "AgentPhase",
    "DiscoveryEngine",
    "EdgeType",
    "NodeType",
    "Orchestrator",
    "RelationshipGraph",
    "SPLParser",
    "SPLReferences",
]
