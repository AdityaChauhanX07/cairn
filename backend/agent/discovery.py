"""Agentic exploration engine.

The discovery engine is the *hands* of the agent: when the orchestrator
decides "go enumerate indexes" or "pull the SPL of every alert and trace
references", the discovery engine actually executes those MCP calls,
threads the results into the relationship graph, and yields events that
describe what it found.

Discovery is intentionally a thin layer — the *what to do next* decisions
live in the orchestrator (and the LLM). Discovery focuses on:

- Pacing MCP calls (kind-by-kind so the agent stays responsive).
- Normalizing inconsistent server responses into typed graph nodes.
- Parsing every SPL string it touches into the graph as references.
- Producing structured "finding" events the orchestrator can stream.

Several Splunk MCP response shapes vary by deployment / version. Where the
exact key names are uncertain, we use defensive lookups across a few
candidate keys and add a ``# TODO live-test`` marker — these should be
validated against a real environment before the demo.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from mcp_client import SplunkMCPClient, SplunkMCPError

from .graph import EdgeType, NodeType, RelationshipGraph, SPLParser

logger = logging.getLogger(__name__)


# ---- Finding events ---------------------------------------------------------


@dataclass
class Finding:
    """Something the discovery engine learned. Streamed to the orchestrator."""

    kind: str            # e.g. "indexes", "saved_search", "macro", "usage"
    message: str         # human-readable one-liner
    detail: str | None = None
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "message": self.message,
            "detail": self.detail,
            "data": self.data,
        }


# ---- Helpers ---------------------------------------------------------------

# Splunk uses inconsistent key names across endpoints; these candidate lists
# capture the variants we see most often.
_NAME_KEYS = ("name", "title", "label", "id")
_OWNER_KEYS = ("author", "owner", "eai:userName", "updated_by", "modified_by")
_APP_KEYS = ("app", "eai:acl.app", "acl.app")
_SPL_KEYS = ("search", "qualifiedSearch", "spl", "query", "definition")
_DESCRIPTION_KEYS = ("description", "summary", "comment")
_IS_ALERT_KEYS = ("is_scheduled", "alert.track", "alert_type")

# Apps Splunk ships internally — knowledge objects that live in them are
# almost never relevant to a team's onboarding ("how do I work in this
# Splunk?") so we filter them out before they pollute the graph. Apps not
# in this set — most notably ``search`` and ``launcher`` plus any custom
# user app — are kept.
_SYSTEM_APPS: frozenset[str] = frozenset({
    "SplunkDeploymentServerConfig",
    "splunk_monitoring_console",
    "splunk-dashboard-studio",
    "splunk_internal_metrics",
    "splunk_metrics_workspace",
    "learned",
    "introspection_generator_addon",
    "splunk_instrumentation",
    "splunk_secure_gateway",
    "Splunk_AI_Assistant_Cloud",
    "splunk_app_for_splunk_o11y_cloud",
    "splunk_gdi",
    "splunk_httpinput",
    "Splunk_MCP_Server",
    "python_upgrade_readiness_app",
    "alert_logevent",
    "alert_webhook",
    "appsbrowser",
    "audit_trail",
    "splunk-visual-exporter",
})


# Splunk default indexes that exist on every deployment with no team-specific
# content. Enriching them adds dozens of unrelated sourcetypes and pollutes
# the graph the LLM will reason over.
_SKIP_INDEX_DEFAULTS: frozenset[str] = frozenset({
    "history",
    "main",
    "splunklogger",
    "summary",
})


def _is_system_object(obj: dict[str, Any]) -> bool:
    """True iff ``obj`` belongs to a known Splunk system/built-in app."""
    app = _first(obj, _APP_KEYS)
    if not isinstance(app, str):
        return False  # No app info — keep it; better than dropping silently.
    return app in _SYSTEM_APPS


# ---- Per-kind system filters ----------------------------------------------
#
# The ``app`` field isn't always populated by the MCP server, and even when
# it is, many built-in objects live in the ``search`` app (which we keep).
# These name-pattern filters catch the most common system-shipped objects
# regardless of their declared app.

_SYSTEM_LOOKUP_NAMES: frozenset[str] = frozenset({
    "about_release.csv",
    "pura_mark_public_as_private.csv",
    "security_example_data.csv",
    "geomaps_data.csv",
})
_SYSTEM_LOOKUP_PREFIXES: tuple[str, ...] = ("geo_",)
_SYSTEM_LOOKUP_SUFFIXES: tuple[str, ...] = (
    "_example.csv",
    "_example",
    ".kmz",
)


def _is_system_lookup(obj: dict[str, Any]) -> bool:
    name = _first(obj, _NAME_KEYS)
    if not isinstance(name, str):
        return False
    lower = name.lower()
    if lower in _SYSTEM_LOOKUP_NAMES:
        return True
    if any(lower.startswith(p) for p in _SYSTEM_LOOKUP_PREFIXES):
        return True
    if any(lower.endswith(s) for s in _SYSTEM_LOOKUP_SUFFIXES):
        return True
    return False


_SYSTEM_MACRO_PREFIXES: tuple[str, ...] = ("audit_", "saias_", "splunk_")
# Splunk's built-in eval macros surface with parentheses in the name, e.g.
# ``comment(1)``, ``histperc(1)``. Filter by substring to catch all arities.
_SYSTEM_MACRO_SUBSTRINGS: tuple[str, ...] = (
    "comment(",
    "histperc(",
    "perc_to_pct(",
    "splunk_assist_",
)


def _is_system_macro(obj: dict[str, Any]) -> bool:
    name = _first(obj, _NAME_KEYS)
    if not isinstance(name, str):
        return False
    lower = name.lower()
    if any(lower.startswith(p) for p in _SYSTEM_MACRO_PREFIXES):
        return True
    if any(s in lower for s in _SYSTEM_MACRO_SUBSTRINGS):
        return True
    return False


def _is_system_dashboard(obj: dict[str, Any]) -> bool:
    name = _first(obj, _NAME_KEYS)
    if isinstance(name, str) and name.startswith("_"):
        return True
    # ``is_dashboard`` distinguishes dashboards from forms / HTML views.
    # Splunk returns string "0"/"1"; we also tolerate the boolean form.
    is_dashboard = obj.get("is_dashboard")
    if isinstance(is_dashboard, str) and is_dashboard.strip() == "0":
        return True
    if is_dashboard is False:
        return True
    return False


_PER_KIND_SYSTEM_FILTERS: dict[str, Any] = {
    "macros": _is_system_macro,
    "lookups": _is_system_lookup,
    "views": _is_system_dashboard,
}


def _is_system_for_kind(kind: str, obj: dict[str, Any]) -> bool:
    """Combine the app-based filter with kind-specific name patterns."""
    if _is_system_object(obj):
        return True
    per_kind = _PER_KIND_SYSTEM_FILTERS.get(kind)
    if per_kind is not None and per_kind(obj):
        return True
    return False


def _first(d: dict[str, Any], keys: tuple[str, ...], default: Any = None) -> Any:
    for k in keys:
        if k in d and d[k] not in (None, "", []):
            return d[k]
    return default


def _looks_like_alert(obj: dict[str, Any]) -> bool:
    """A saved search is "an alert" iff it carries alerting configuration.

    Splunk doesn't distinguish "alert" vs "report" at the object level — both
    are entries in ``saved/searches``. The discriminator is whether any of
    the alert-configuration fields are set to non-default values. We check
    several candidate signals; any one is sufficient.
    """
    # Primary signal — non-empty/non-"none" alert_type.
    alert_type = obj.get("alert_type")
    if isinstance(alert_type, str) and alert_type.lower() not in ("", "none"):
        return True

    # ``alert.track`` is set to "1"/"true" when alerts are tracked.
    track = obj.get("alert.track")
    if isinstance(track, str) and track.lower() in ("1", "true"):
        return True
    if isinstance(track, bool) and track:
        return True

    # Configured alert ``actions`` (e.g. "email,webhook"). Non-empty = alert.
    actions = obj.get("actions")
    if isinstance(actions, str) and actions.strip():
        return True

    # ``alert.suppress`` defaults to "0" on every saved search; only real
    # alerts flip it to "1"/"true".
    suppress = obj.get("alert.suppress")
    if isinstance(suppress, str) and suppress.strip().lower() in ("1", "true"):
        return True

    # ``alert.severity`` defaults to "3" everywhere — treat only severities
    # 4 (high) and 5 (critical) as a stand-alone alert indicator, since those
    # are never set by accident.
    severity = obj.get("alert.severity") or obj.get("alert_severity")
    if isinstance(severity, str) and severity.strip().isdigit():
        if int(severity.strip()) >= 4:
            return True

    return False


# ---- Engine ----------------------------------------------------------------


class DiscoveryEngine:
    """Coordinates MCP discovery calls and writes into the graph."""

    def __init__(
        self,
        client: SplunkMCPClient,
        graph: RelationshipGraph,
        *,
        parser: SPLParser | None = None,
    ) -> None:
        self._client = client
        self._graph = graph
        self._parser = parser or SPLParser()

    # ---- orient ----

    async def orient(self) -> AsyncIterator[Finding]:
        """High-level layout: deployment info, indexes, users, KV stores.

        Yields ``Finding``s as each chunk lands.
        """
        # Deployment info first — confirms connection and tells us version.
        try:
            info = await self._client.get_info()
            version = info.get("version") or info.get("generator", {}).get("version")
            yield Finding(
                kind="deployment",
                message=f"connected to Splunk {version or 'unknown version'}",
                data={"info": info},
            )
        except SplunkMCPError as exc:
            yield Finding(kind="error", message="failed to fetch deployment info", detail=str(exc))

        # Indexes.
        try:
            indexes = await self._client.get_indexes()
        except SplunkMCPError as exc:
            yield Finding(kind="error", message="failed to enumerate indexes", detail=str(exc))
            indexes = []

        for entry in indexes:
            name = _first(entry, _NAME_KEYS)
            if not isinstance(name, str):
                continue
            self._graph.add_node(NodeType.INDEX, name, _index_properties(entry))
        yield Finding(
            kind="indexes",
            message=f"found {len(indexes)} indexes",
            data={"indexes": [_first(e, _NAME_KEYS) for e in indexes if _first(e, _NAME_KEYS)]},
        )

        # Users.
        try:
            users = await self._client.get_user_list()
        except SplunkMCPError as exc:
            yield Finding(kind="error", message="failed to fetch user list", detail=str(exc))
            users = []

        for entry in users:
            name = _first(entry, ("name", "username", "userName"))
            if not isinstance(name, str):
                continue
            self._graph.add_node(
                NodeType.USER,
                name,
                {
                    "roles": entry.get("roles") or entry.get("role"),
                    "email": entry.get("email"),
                    "real_name": entry.get("realname") or entry.get("real_name"),
                },
            )
        yield Finding(kind="users", message=f"found {len(users)} users")

        # KV store collections.
        try:
            collections = await self._client.get_kv_store_collections()
        except SplunkMCPError as exc:
            yield Finding(
                kind="error",
                message="failed to fetch KV store collections",
                detail=str(exc),
            )
            collections = []

        for col in collections:
            name = _first(col, _NAME_KEYS)
            if not isinstance(name, str):
                continue
            self._graph.add_node(
                NodeType.KV_COLLECTION,
                name,
                {"app": _first(col, _APP_KEYS)},
            )
        yield Finding(
            kind="kv_collections",
            message=f"found {len(collections)} KV store collections",
        )

    # ---- deep-dive: indexes ----

    async def enrich_indexes(self) -> AsyncIterator[Finding]:
        """For each non-system, non-empty index, pull info + sourcetype metadata.

        Skipped indexes:
          - Any whose name starts with ``_`` (Splunk internal: _audit, _internal, ...)
          - The default empty indexes (``history``, ``main``, ``splunklogger``, ``summary``)
          - Anything still flagged ``placeholder`` (referenced but not in get_indexes)
          - After fetching info, indexes with ``totalEventCount == 0`` skip the
            sourcetype lookup — they'd add no useful structure to the graph.
        """
        index_nodes = self._graph.nodes_by_type(NodeType.INDEX)
        skipped = 0
        for node in index_nodes:
            if node.properties.get("placeholder"):
                continue
            if node.name.startswith("_"):
                skipped += 1
                continue
            if node.name in _SKIP_INDEX_DEFAULTS:
                skipped += 1
                continue

            try:
                info = await self._client.get_index_info(node.name)
                node.properties.update(_index_properties(info))
            except SplunkMCPError as exc:
                yield Finding(
                    kind="error",
                    message=f"failed to fetch info for index {node.name}",
                    detail=str(exc),
                )
                continue

            event_count = node.properties.get("totalEventCount") or 0
            if not event_count:
                yield Finding(
                    kind="index_detail",
                    message=f"profiled index {node.name} — empty, skipping sourcetypes",
                    data={"index": node.name, "totalEventCount": 0},
                )
                continue

            try:
                sts = await self._client.get_metadata(node.name, kind="sourcetypes")
            except SplunkMCPError as exc:
                yield Finding(
                    kind="error",
                    message=f"failed to fetch sourcetypes for index {node.name}",
                    detail=str(exc),
                )
                sts = []

            for st in sts:
                st_name = _first(st, _NAME_KEYS) or st.get("sourcetype")
                if not isinstance(st_name, str):
                    continue
                self._graph.add_node(
                    NodeType.SOURCETYPE,
                    st_name,
                    {"total_count": st.get("totalCount") or st.get("count")},
                )
                self._graph.add_edge(
                    self._graph.make_id(NodeType.SOURCETYPE, st_name),
                    node.id,
                    EdgeType.SOURCETYPE_OF,
                )

            yield Finding(
                kind="index_detail",
                message=f"profiled index {node.name}",
                data={
                    "index": node.name,
                    "totalEventCount": node.properties.get("totalEventCount"),
                    "currentDBSizeMB": node.properties.get("currentDBSizeMB"),
                    "sourcetype_count": len(sts),
                },
            )

        if skipped:
            yield Finding(
                kind="indexes_skipped",
                message=f"skipped {skipped} system / default indexes during enrichment",
            )

    # ---- knowledge objects ----

    async def discover_knowledge_objects(self) -> AsyncIterator[Finding]:
        """Pull saved searches, macros, lookups, dashboards, eventtypes.

        Each kind is fetched separately so the orchestrator can stream
        progress to the UI.
        """
        for kind, node_type, processor in _KNOWLEDGE_OBJECT_KINDS:
            try:
                objects = await self._client.get_knowledge_objects(kind=kind)
            except SplunkMCPError as exc:
                yield Finding(
                    kind="error",
                    message=f"failed to fetch {kind}",
                    detail=str(exc),
                )
                continue

            count = 0
            skipped_system = 0
            for obj in objects:
                if _is_system_for_kind(kind, obj):
                    skipped_system += 1
                    continue
                if processor(self, node_type, obj):
                    count += 1

            yield Finding(
                kind=kind,
                message=(
                    f"found {count} {kind}"
                    + (f" ({skipped_system} system objects filtered out)" if skipped_system else "")
                ),
                data={"count": count, "skipped_system": skipped_system, "total": len(objects)},
            )

    # ---- placeholders / chase down references ----

    async def resolve_placeholders(self) -> AsyncIterator[Finding]:
        """Try to flesh out nodes that were created as references only.

        Compares against canonical node IDs (via ``RelationshipGraph.make_id``)
        rather than raw names so lookups with file extensions like
        ``known_bad_ips.csv`` correctly match the ``known_bad_ips`` SPL
        reference placeholder.
        """
        placeholders = self._graph.placeholders()
        macro_placeholder_ids = {
            n.id for n in placeholders if n.type == NodeType.MACRO
        }
        lookup_placeholder_ids = {
            n.id for n in placeholders if n.type == NodeType.LOOKUP
        }

        if macro_placeholder_ids:
            try:
                macros = await self._client.get_knowledge_objects(kind="macros")
            except SplunkMCPError as exc:
                yield Finding(
                    kind="error",
                    message="failed to refetch macros while resolving placeholders",
                    detail=str(exc),
                )
                macros = []
            for obj in macros:
                if _is_system_for_kind("macros", obj):
                    continue
                name = _first(obj, _NAME_KEYS)
                if not isinstance(name, str):
                    continue
                if self._graph.make_id(NodeType.MACRO, name) in macro_placeholder_ids:
                    _process_macro(self, NodeType.MACRO, obj)

        if lookup_placeholder_ids:
            try:
                lookups = await self._client.get_knowledge_objects(kind="lookups")
            except SplunkMCPError as exc:
                yield Finding(
                    kind="error",
                    message="failed to refetch lookups while resolving placeholders",
                    detail=str(exc),
                )
                lookups = []
            for obj in lookups:
                if _is_system_for_kind("lookups", obj):
                    continue
                name = _first(obj, _NAME_KEYS)
                if not isinstance(name, str):
                    continue
                if self._graph.make_id(NodeType.LOOKUP, name) in lookup_placeholder_ids:
                    _process_lookup(self, NodeType.LOOKUP, obj)

        still_missing = [n.name for n in self._graph.placeholders()]
        yield Finding(
            kind="placeholders",
            message=(
                f"resolved {len(placeholders) - len(still_missing)} placeholder(s); "
                f"{len(still_missing)} still unresolved"
            ),
            data={"unresolved": still_missing},
        )

    # ---- usage data via _audit / _internal ----

    async def gather_usage(self) -> AsyncIterator[Finding]:
        """Pull search frequency from ``_audit`` so we know what's actually used.

        We use a single aggregated query rather than per-object lookups to
        stay friendly to the deployment. Results are written onto each saved
        search node as ``properties["usage_count_24h"]`` and
        ``properties["last_run"]``.
        """
        # _audit usage by saved search name.
        # TODO live-test: confirm the savedsearch_name field exists; older
        # Splunk versions surface it as `search_name`.
        usage_spl = (
            "search index=_audit action=search info=granted "
            'savedsearch_name=* | stats count as runs, '
            "max(_time) as last_run by savedsearch_name"
        )
        try:
            # earliest="0" — all time — because demo data may be older than
            # the last 24h and we'd otherwise show "no usage" for everything.
            res = await self._client.run_query(usage_spl, earliest="0")
        except SplunkMCPError as exc:
            yield Finding(
                kind="error",
                message="failed to query _audit for usage data",
                detail=str(exc),
            )
            return

        rows = _extract_rows(res)
        applied = 0
        for row in rows:
            name = row.get("savedsearch_name")
            if not isinstance(name, str):
                continue
            runs = _to_int(row.get("runs"))
            node = self._graph.get_node(self._graph.make_id(NodeType.SAVED_SEARCH, name))
            if node is None:
                node = self._graph.get_node(self._graph.make_id(NodeType.ALERT, name))
            if node is None:
                continue
            node.properties["usage_count_24h"] = runs
            node.properties["last_run"] = row.get("last_run")
            applied += 1

        yield Finding(
            kind="usage",
            message=f"attached usage counts to {applied} saved searches/alerts",
            data={"rows": len(rows), "applied": applied},
        )

    # ---- replay a saved search to see what it returns ----

    async def sample_saved_search(self, name: str) -> Finding:
        """Dispatch a saved search and capture a short summary of its output."""
        try:
            result = await self._client.run_saved_search(name)
        except SplunkMCPError as exc:
            return Finding(
                kind="error",
                message=f"failed to run saved search {name}",
                detail=str(exc),
            )
        rows = _extract_rows(result)
        return Finding(
            kind="saved_search_sample",
            message=f"sampled {name}: {len(rows)} rows",
            data={"name": name, "row_count": len(rows), "first_rows": rows[:3]},
        )

    # ---- gentle pacing helpers for the orchestrator ----

    async def yield_back(self) -> None:
        """Give the event loop a tick — used between bursts of MCP calls."""
        await asyncio.sleep(0)


# ---- Per-kind processors --------------------------------------------------


def _process_saved_search(
    engine: DiscoveryEngine, _node_type: NodeType, obj: dict[str, Any]
) -> bool:
    """A saved search may be an alert; we type it accordingly."""
    name = _first(obj, _NAME_KEYS)
    if not isinstance(name, str):
        return False

    node_type = NodeType.ALERT if _looks_like_alert(obj) else NodeType.SAVED_SEARCH
    spl = _first(obj, _SPL_KEYS) or ""
    props = {
        "spl": spl,
        "owner": _first(obj, _OWNER_KEYS),
        "app": _first(obj, _APP_KEYS),
        "description": _first(obj, _DESCRIPTION_KEYS),
        "cron_schedule": obj.get("cron_schedule"),
        "is_scheduled": obj.get("is_scheduled"),
        "alert_type": obj.get("alert_type"),
        "alert_severity": obj.get("alert.severity"),
        "placeholder": False,
    }
    node = engine._graph.add_node(node_type, name, props)

    # Link SPL references into the graph.
    if isinstance(spl, str):
        refs = engine._parser.parse(spl)
        engine._graph.link_spl_references(node.id, refs)

    # Ownership edge.
    owner = props.get("owner")
    if isinstance(owner, str) and owner:
        engine._graph.add_node(NodeType.USER, owner)
        engine._graph.add_edge(
            node.id,
            engine._graph.make_id(NodeType.USER, owner),
            EdgeType.OWNED_BY,
        )

    # App edge.
    app = props.get("app")
    if isinstance(app, str) and app:
        engine._graph.add_node(NodeType.APP, app)
        engine._graph.add_edge(
            node.id,
            engine._graph.make_id(NodeType.APP, app),
            EdgeType.LIVES_IN_APP,
        )
    return True


def _process_macro(
    engine: DiscoveryEngine, _node_type: NodeType, obj: dict[str, Any]
) -> bool:
    name = _first(obj, _NAME_KEYS)
    if not isinstance(name, str):
        return False
    definition = _first(obj, ("definition", "search", "value")) or ""
    props = {
        "definition": definition,
        "args": obj.get("args"),
        "owner": _first(obj, _OWNER_KEYS),
        "app": _first(obj, _APP_KEYS),
        "description": _first(obj, _DESCRIPTION_KEYS),
        "placeholder": False,
    }
    node = engine._graph.add_node(NodeType.MACRO, name, props)
    if isinstance(definition, str) and definition:
        refs = engine._parser.parse(definition)
        engine._graph.link_spl_references(node.id, refs)
    return True


def _process_lookup(
    engine: DiscoveryEngine, _node_type: NodeType, obj: dict[str, Any]
) -> bool:
    name = _first(obj, _NAME_KEYS)
    if not isinstance(name, str):
        return False
    # Lookups come in several flavors: file-based, KV-store-backed, external.
    # We capture the kind when the server tells us, otherwise leave it blank.
    props = {
        "type": obj.get("type") or obj.get("lookup_type"),
        "filename": obj.get("filename") or obj.get("collection"),
        "owner": _first(obj, _OWNER_KEYS),
        "app": _first(obj, _APP_KEYS),
        "fields": obj.get("fields") or obj.get("fields_list"),
        "placeholder": False,
    }
    engine._graph.add_node(NodeType.LOOKUP, name, props)
    return True


def _process_dashboard(
    engine: DiscoveryEngine, _node_type: NodeType, obj: dict[str, Any]
) -> bool:
    name = _first(obj, _NAME_KEYS)
    if not isinstance(name, str):
        return False

    # Dashboard SPL lives in panel search elements; the MCP server typically
    # surfaces it as an "eai:data" XML blob. We extract every `<search>...
    # </search>` block heuristically.
    # TODO live-test: confirm the exact field name on the connected server;
    # some versions use "data", some "eai:data".
    raw = obj.get("eai:data") or obj.get("data") or ""
    panel_spls = _extract_dashboard_spl(raw) if isinstance(raw, str) else []

    props = {
        "owner": _first(obj, _OWNER_KEYS),
        "app": _first(obj, _APP_KEYS),
        "description": _first(obj, _DESCRIPTION_KEYS),
        "panel_count": len(panel_spls),
        "panel_spls": panel_spls,
        "placeholder": False,
    }
    node = engine._graph.add_node(NodeType.DASHBOARD, name, props)
    for spl in panel_spls:
        refs = engine._parser.parse(spl)
        engine._graph.link_spl_references(node.id, refs)
    return True


def _process_eventtype(
    engine: DiscoveryEngine, _node_type: NodeType, obj: dict[str, Any]
) -> bool:
    name = _first(obj, _NAME_KEYS)
    if not isinstance(name, str):
        return False
    spl = _first(obj, ("search", "definition")) or ""
    props = {
        "spl": spl,
        "tags": obj.get("tags"),
        "owner": _first(obj, _OWNER_KEYS),
        "app": _first(obj, _APP_KEYS),
        "placeholder": False,
    }
    node = engine._graph.add_node(NodeType.EVENTTYPE, name, props)
    if isinstance(spl, str) and spl:
        refs = engine._parser.parse(spl)
        engine._graph.link_spl_references(node.id, refs)
    return True


# Order matters here: saved searches and dashboards are likely to reference
# macros and lookups, so we get the references in the graph either way (via
# placeholders) but it's nicer if the referenced object already exists when
# the SPL is parsed.
_KNOWLEDGE_OBJECT_KINDS: tuple[tuple[str, NodeType, Any], ...] = (
    ("macros", NodeType.MACRO, _process_macro),
    ("lookups", NodeType.LOOKUP, _process_lookup),
    ("eventtypes", NodeType.EVENTTYPE, _process_eventtype),
    # ``saved_searches`` (with underscore) is the kind name confirmed by the
    # live MCP server — it returns 100+ items including alerts, which we
    # then re-type via _looks_like_alert in the processor.
    ("saved_searches", NodeType.SAVED_SEARCH, _process_saved_search),
    ("views", NodeType.DASHBOARD, _process_dashboard),
)


# ---- Index properties ------------------------------------------------------


def _index_properties(entry: dict[str, Any]) -> dict[str, Any]:
    """Map a Splunk index dict to graph node properties.

    Keys are kept verbatim from Splunk's REST API (``totalEventCount``,
    ``currentDBSizeMB``, etc.) so that downstream consumers — most notably
    the LLM during synthesis — see the same field names a Splunk
    administrator would recognize.
    """
    return {
        "totalEventCount": _to_int(
            entry.get("totalEventCount")
            or entry.get("total_event_count")
            or entry.get("event_count")
        ),
        "currentDBSizeMB": _to_int(
            entry.get("currentDBSizeMB") or entry.get("current_db_size_mb")
        ),
        "frozenTimePeriodInSecs": _to_int(
            entry.get("frozenTimePeriodInSecs") or entry.get("frozen_time_period_in_secs")
        ),
        "minTime": entry.get("minTime") or entry.get("min_time"),
        "maxTime": entry.get("maxTime") or entry.get("max_time"),
        "datatype": entry.get("datatype"),
        "disabled": entry.get("disabled"),
        "placeholder": False,
    }


def _to_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# ---- Result row extraction -------------------------------------------------


def _extract_rows(result: Any) -> list[dict[str, Any]]:
    """Pull ``[{field: value, ...}, ...]`` out of an MCP run_query response."""
    if isinstance(result, list):
        return [r for r in result if isinstance(r, dict)]
    if isinstance(result, dict):
        for key in ("results", "rows", "data", "events"):
            inner = result.get(key)
            if isinstance(inner, list):
                return [r for r in inner if isinstance(r, dict)]
    return []


# ---- Dashboard SPL extraction ---------------------------------------------

_DASHBOARD_SEARCH_RE = re.compile(
    r"<search[^>]*>(.*?)</search>", re.DOTALL | re.IGNORECASE
)
_DASHBOARD_QUERY_RE = re.compile(
    r"<query[^>]*>(.*?)</query>", re.DOTALL | re.IGNORECASE
)


def _extract_dashboard_spl(xml_blob: str) -> list[str]:
    """Pull SPL strings out of a dashboard XML/JSON blob.

    Dashboards in classic Splunk XML put SPL inside ``<query>`` elements
    nested in ``<search>`` blocks. We grab every ``<query>`` we can find;
    if there are none we fall back to ``<search>`` contents.
    """
    queries = [m.strip() for m in _DASHBOARD_QUERY_RE.findall(xml_blob) if m.strip()]
    if queries:
        return queries
    return [m.strip() for m in _DASHBOARD_SEARCH_RE.findall(xml_blob) if m.strip()]
