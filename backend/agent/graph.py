"""Relationship graph + SPL parser.

The graph is the central data structure Cairn builds while exploring. Every
knowledge object found in Splunk becomes a node; every reference one object
makes to another becomes an edge. After exploration, the graph is what the
synthesis step turns into a guide.

This module is intentionally I/O-free: it can be unit-tested without any
Splunk or LLM connection.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Iterator

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Node / edge typing
# ---------------------------------------------------------------------------


class NodeType(str, Enum):
    """The kinds of things that can appear as nodes in the graph."""

    INDEX = "index"
    SOURCETYPE = "sourcetype"
    SAVED_SEARCH = "saved_search"
    ALERT = "alert"
    DASHBOARD = "dashboard"
    MACRO = "macro"
    LOOKUP = "lookup"
    EVENTTYPE = "eventtype"
    USER = "user"
    APP = "app"
    KV_COLLECTION = "kv_collection"


class EdgeType(str, Enum):
    """The kinds of relationships between nodes."""

    REFERENCES_MACRO = "references_macro"
    REFERENCES_LOOKUP = "references_lookup"
    READS_FROM_INDEX = "reads_from_index"
    OWNED_BY = "owned_by"
    LIVES_IN_APP = "lives_in_app"
    POPULATES_DASHBOARD_PANEL = "populates_dashboard_panel"
    TRIGGERED_BY = "triggered_by"
    SOURCETYPE_OF = "sourcetype_of"


# ---------------------------------------------------------------------------
# SPL parsing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SPLReferences:
    """The set of references extracted from a single SPL string."""

    macros: tuple[str, ...] = ()
    lookups: tuple[str, ...] = ()
    indexes: tuple[str, ...] = ()
    sourcetypes: tuple[str, ...] = ()

    def is_empty(self) -> bool:
        return not (self.macros or self.lookups or self.indexes or self.sourcetypes)


class SPLParser:
    """Extracts macro / lookup / index / sourcetype references from SPL.

    The parser is regex-based and intentionally permissive: Splunk's SPL has
    no formal grammar that's easy to consume, so we aim for high recall on
    the patterns that matter for dependency tracing rather than a perfect
    AST.
    """

    # Macros are surrounded by backticks. Args (if any) follow in parentheses.
    # Example: `high_severity_filter`, `my_macro(foo,bar)`
    _MACRO_RE = re.compile(r"`([a-zA-Z_][\w]*)\s*(?:\([^`]*\))?\s*`")

    # `| lookup <name> ...` — the name is the first whitespace-delimited token
    # after `lookup`. We tolerate the optional `local=t` / `update=t` flags
    # that can sit between `lookup` and the name.
    _LOOKUP_RE = re.compile(
        r"\|\s*lookup\s+(?:(?:local|update)=\w+\s+)*([A-Za-z_][\w./-]*)",
        re.IGNORECASE,
    )

    # `index=<value>` — value may be quoted, unquoted, or contain wildcards.
    _INDEX_RE = re.compile(
        r"\bindex\s*=\s*(\"[^\"]+\"|'[^']+'|[A-Za-z_][\w*?-]*)",
        re.IGNORECASE,
    )

    # `sourcetype=<value>` — same shape as index.
    _SOURCETYPE_RE = re.compile(
        r"\bsourcetype\s*=\s*(\"[^\"]+\"|'[^']+'|[A-Za-z_][\w:*?-]*)",
        re.IGNORECASE,
    )

    # `inputlookup <name>` / `outputlookup <name>` — both reference a lookup.
    _INPUT_OUTPUT_LOOKUP_RE = re.compile(
        r"\|\s*(?:inputlookup|outputlookup)\s+(?:append=\w+\s+)?([A-Za-z_][\w./-]*)",
        re.IGNORECASE,
    )

    def parse(self, spl: str | None) -> SPLReferences:
        """Extract all references from ``spl``. Empty input -> empty result."""
        if not spl:
            return SPLReferences()

        macros = _unique(self._MACRO_RE.findall(spl))
        lookups = _unique(
            list(self._LOOKUP_RE.findall(spl))
            + list(self._INPUT_OUTPUT_LOOKUP_RE.findall(spl))
        )
        indexes = _unique(_strip_quotes(m) for m in self._INDEX_RE.findall(spl))
        sourcetypes = _unique(
            _strip_quotes(m) for m in self._SOURCETYPE_RE.findall(spl)
        )

        return SPLReferences(
            macros=tuple(macros),
            lookups=tuple(lookups),
            indexes=tuple(indexes),
            sourcetypes=tuple(sourcetypes),
        )


def _strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] in {'"', "'"} and value[-1] == value[0]:
        return value[1:-1]
    return value


# File extensions commonly used for Splunk lookup tables. The graph uses the
# stripped name as the canonical node ID so that SPL references (which never
# include the extension — ``| lookup known_bad_ips``) and MCP-discovered
# filenames (``known_bad_ips.csv``) collapse to the same node.
_LOOKUP_FILE_EXTS: tuple[str, ...] = (".csv.gz", ".csv", ".kmz", ".mmdb")


def _strip_lookup_extension(name: str) -> str:
    lower = name.lower()
    for ext in _LOOKUP_FILE_EXTS:
        if lower.endswith(ext):
            return name[: -len(ext)]
    return name


def _unique(items: Iterable[str]) -> list[str]:
    """De-dupe while preserving first-seen order."""
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------


@dataclass
class Node:
    """A graph node — a single Splunk artifact or entity."""

    id: str
    type: NodeType
    name: str
    properties: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type.value,
            "name": self.name,
            "properties": self.properties,
        }


@dataclass
class Edge:
    """A directed edge: ``source`` references ``target`` with ``type``."""

    source: str
    target: str
    type: EdgeType
    properties: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "target": self.target,
            "type": self.type.value,
            "properties": self.properties,
        }


class RelationshipGraph:
    """The graph of all Splunk knowledge objects Cairn has discovered.

    Nodes are keyed by a stable string ID formed from ``type:name`` so that
    a later discovery of the same object (e.g. a macro first seen as a
    reference, then later as a fully-loaded definition) updates the existing
    node rather than duplicating.
    """

    def __init__(self) -> None:
        self._nodes: dict[str, Node] = {}
        self._edges: list[Edge] = []
        self._edge_keys: set[tuple[str, str, str]] = set()
        # Index of edges by source / target for O(1) neighborhood lookups.
        self._out_edges: dict[str, list[Edge]] = defaultdict(list)
        self._in_edges: dict[str, list[Edge]] = defaultdict(list)

    # ---- mutation ----

    @staticmethod
    def make_id(node_type: NodeType, name: str) -> str:
        # Strip lookup file extensions so ``known_bad_ips`` (from SPL parsing)
        # and ``known_bad_ips.csv`` (from the MCP lookups listing) share an ID.
        if node_type == NodeType.LOOKUP:
            name = _strip_lookup_extension(name)
        return f"{node_type.value}:{name}"

    def add_node(
        self,
        node_type: NodeType,
        name: str,
        properties: dict[str, Any] | None = None,
    ) -> Node:
        """Insert or merge a node. Returns the canonical node.

        When merging into an existing placeholder node and the new add is
        explicitly non-placeholder, the display name is also upgraded — this
        matters most for lookups where the SPL ref ("known_bad_ips") creates
        the placeholder and the MCP discovery later supplies the richer
        filename ("known_bad_ips.csv").
        """
        node_id = self.make_id(node_type, name)
        existing = self._nodes.get(node_id)
        if existing is None:
            node = Node(id=node_id, type=node_type, name=name, properties=dict(properties or {}))
            self._nodes[node_id] = node
            return node
        if properties:
            if (
                properties.get("placeholder") is False
                and existing.properties.get("placeholder")
                and existing.name != name
            ):
                existing.name = name
            existing.properties.update(properties)
        return existing

    def add_edge(
        self,
        source_id: str,
        target_id: str,
        edge_type: EdgeType,
        properties: dict[str, Any] | None = None,
    ) -> Edge | None:
        """Insert an edge if one with the same (source, target, type) doesn't already exist."""
        if source_id not in self._nodes or target_id not in self._nodes:
            logger.debug(
                "skip edge %s -%s-> %s: missing endpoint",
                source_id,
                edge_type.value,
                target_id,
            )
            return None
        key = (source_id, target_id, edge_type.value)
        if key in self._edge_keys:
            return None
        edge = Edge(source=source_id, target=target_id, type=edge_type, properties=dict(properties or {}))
        self._edges.append(edge)
        self._edge_keys.add(key)
        self._out_edges[source_id].append(edge)
        self._in_edges[target_id].append(edge)
        return edge

    def link_spl_references(
        self,
        source_id: str,
        refs: SPLReferences,
        *,
        create_placeholders: bool = True,
    ) -> list[Edge]:
        """For a node owning some SPL, materialize edges to every referenced object.

        If ``create_placeholders`` is True (the default), referenced macros /
        lookups / indexes that haven't been discovered yet are added as
        placeholder nodes so the edge can be created. Placeholders carry
        ``properties["placeholder"] = True`` and the discovery loop can later
        flesh them out.
        """
        created: list[Edge] = []
        if source_id not in self._nodes:
            logger.debug("link_spl_references: source %s not in graph", source_id)
            return created

        def _ensure(node_type: NodeType, name: str) -> str | None:
            node_id = self.make_id(node_type, name)
            if node_id not in self._nodes:
                if not create_placeholders:
                    return None
                self.add_node(node_type, name, {"placeholder": True})
            return node_id

        for macro in refs.macros:
            target = _ensure(NodeType.MACRO, macro)
            if target:
                edge = self.add_edge(source_id, target, EdgeType.REFERENCES_MACRO)
                if edge:
                    created.append(edge)

        for lookup in refs.lookups:
            target = _ensure(NodeType.LOOKUP, lookup)
            if target:
                edge = self.add_edge(source_id, target, EdgeType.REFERENCES_LOOKUP)
                if edge:
                    created.append(edge)

        for index_name in refs.indexes:
            if "*" in index_name or "?" in index_name:
                # Wildcards aren't useful as graph endpoints; skip.
                continue
            target = _ensure(NodeType.INDEX, index_name)
            if target:
                edge = self.add_edge(source_id, target, EdgeType.READS_FROM_INDEX)
                if edge:
                    created.append(edge)

        for sourcetype in refs.sourcetypes:
            if "*" in sourcetype or "?" in sourcetype:
                continue
            target = _ensure(NodeType.SOURCETYPE, sourcetype)
            if target:
                edge = self.add_edge(source_id, target, EdgeType.SOURCETYPE_OF)
                if edge:
                    created.append(edge)

        return created

    # ---- read-only access ----

    def has_node(self, node_type: NodeType, name: str) -> bool:
        return self.make_id(node_type, name) in self._nodes

    def get_node(self, node_id: str) -> Node | None:
        return self._nodes.get(node_id)

    def nodes(self) -> Iterator[Node]:
        return iter(self._nodes.values())

    def nodes_by_type(self, node_type: NodeType) -> list[Node]:
        return [n for n in self._nodes.values() if n.type == node_type]

    def edges(self) -> Iterator[Edge]:
        return iter(self._edges)

    def out_edges(self, node_id: str, edge_type: EdgeType | None = None) -> list[Edge]:
        edges = self._out_edges.get(node_id, [])
        if edge_type is None:
            return list(edges)
        return [e for e in edges if e.type == edge_type]

    def in_edges(self, node_id: str, edge_type: EdgeType | None = None) -> list[Edge]:
        edges = self._in_edges.get(node_id, [])
        if edge_type is None:
            return list(edges)
        return [e for e in edges if e.type == edge_type]

    def placeholders(self) -> list[Node]:
        """Nodes that were referenced but not yet fully discovered."""
        return [n for n in self._nodes.values() if n.properties.get("placeholder")]

    def trace_chain(self, start_node_id: str, max_depth: int = 6) -> list[list[Node]]:
        """All dependency paths starting at ``start_node_id``.

        Each path is a list of nodes. Cycles are broken on revisit.
        """
        results: list[list[Node]] = []
        start = self._nodes.get(start_node_id)
        if start is None:
            return results

        def _walk(node: Node, trail: list[Node], visited: set[str]) -> None:
            children = self._out_edges.get(node.id, [])
            if not children or len(trail) >= max_depth:
                results.append(list(trail))
                return
            extended = False
            for edge in children:
                if edge.target in visited:
                    continue
                child = self._nodes.get(edge.target)
                if child is None:
                    continue
                extended = True
                _walk(child, trail + [child], visited | {child.id})
            if not extended:
                results.append(list(trail))

        _walk(start, [start], {start.id})
        return results

    def summary(self) -> dict[str, Any]:
        """Counts by node and edge type — handy for the agent's reasoning prompts."""
        node_counts: dict[str, int] = defaultdict(int)
        for node in self._nodes.values():
            node_counts[node.type.value] += 1

        edge_counts: dict[str, int] = defaultdict(int)
        for edge in self._edges:
            edge_counts[edge.type.value] += 1

        return {
            "node_total": len(self._nodes),
            "edge_total": len(self._edges),
            "nodes_by_type": dict(node_counts),
            "edges_by_type": dict(edge_counts),
            "placeholders": [n.name for n in self.placeholders()],
        }

    def to_dict(self) -> dict[str, Any]:
        """Serializable representation of the entire graph."""
        return {
            "nodes": [n.to_dict() for n in self._nodes.values()],
            "edges": [e.to_dict() for e in self._edges],
            "summary": self.summary(),
        }

    def relationship_view(self) -> dict[str, list[dict[str, Any]]]:
        """The trimmed graph the UI visualizes.

        Only the node types that tell the dependency story (alert → saved
        search → macro → lookup → index) and only the dependency edges between
        them. Placeholders (referenced but never discovered), Splunk-internal
        indexes (``_audit`` etc.), and metadata edges (ownership / app
        placement / sourcetype) are dropped so the picture stays legible.
        """
        node_ids: set[str] = set()
        nodes_out: list[dict[str, Any]] = []
        for node in self._nodes.values():
            if node.type not in _VIEW_NODE_TYPES:
                continue
            if node.properties.get("placeholder"):
                continue
            if node.type == NodeType.INDEX and node.name.startswith("_"):
                continue
            node_ids.add(node.id)
            node_dict: dict[str, Any] = {
                "id": node.id,
                "name": node.name,
                "type": node.type.value,
            }
            # Index nodes carry the data the tile view needs: event volume and
            # the sourcetypes flowing into them (reached via SOURCETYPE_OF edges).
            if node.type == NodeType.INDEX:
                node_dict["eventCount"] = node.properties.get("totalEventCount") or 0
                node_dict["sourcetypes"] = [
                    e.source.split(":", 1)[1] if ":" in e.source else e.source
                    for e in self.in_edges(node.id, EdgeType.SOURCETYPE_OF)
                ][:10]
            nodes_out.append(node_dict)

        edges_out: list[dict[str, Any]] = []
        for edge in self._edges:
            if edge.type not in _VIEW_EDGE_TYPES:
                continue
            if edge.source not in node_ids or edge.target not in node_ids:
                continue
            edges_out.append(
                {
                    "source": edge.source,
                    "target": edge.target,
                    "relationship": edge.type.value,
                }
            )

        return {"nodes": nodes_out, "edges": edges_out}


# Node / edge types that make it into ``relationship_view`` — the visual graph.
_VIEW_NODE_TYPES: frozenset[NodeType] = frozenset(
    {
        NodeType.ALERT,
        NodeType.SAVED_SEARCH,
        NodeType.MACRO,
        NodeType.LOOKUP,
        NodeType.INDEX,
    }
)
_VIEW_EDGE_TYPES: frozenset[EdgeType] = frozenset(
    {
        EdgeType.REFERENCES_MACRO,
        EdgeType.REFERENCES_LOOKUP,
        EdgeType.READS_FROM_INDEX,
    }
)
