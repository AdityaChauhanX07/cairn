"""Splunk MCP client wrapper.

Wraps the Model Context Protocol client connection to a Splunk MCP server and
exposes one Python method per tool Cairn uses. The thin wrapper buys us:

- A single place to apply SPL guardrails (default time bounds, result caps).
- Tool-availability detection (the optional ``saia_*`` tools depend on the
  AI Assistant for SPL add-on being installed).
- Uniform error wrapping in ``SplunkMCPError`` so the agent layer doesn't
  have to handle every MCP-specific exception shape.
- Response normalization — MCP returns content blocks; downstream callers
  prefer plain dicts / strings.

The MCP Python SDK exposes ``ClientSession`` over a generic transport. For
the Splunk MCP server (which speaks HTTP), we use the ``streamable_http``
client transport.
"""

from __future__ import annotations

import inspect
import json
import logging
import re
import warnings
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Any

import httpx
from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamablehttp_client

# Valid values for the ``transport`` kwarg of :class:`SplunkMCPClient`.
TRANSPORT_STREAMABLE_HTTP = "streamable_http"
TRANSPORT_SSE = "sse"

# Splunk's management/MCP endpoint typically presents a self-signed certificate
# in local dev (and even in many production deployments behind an internal CA).
# Suppress the noisy per-request urllib3 / httpx warnings that result.
warnings.filterwarnings("ignore", message="Unverified HTTPS request")


def _make_insecure_http_client(
    headers: dict[str, str] | None = None,
    timeout: httpx.Timeout | None = None,
    auth: httpx.Auth | None = None,
) -> httpx.AsyncClient:
    """``HttpxClientFactory`` that returns a client with TLS verification off.

    The MCP SDK's transport clients accept a factory matching the signature
    ``(headers, timeout, auth) -> httpx.AsyncClient``. Returning a client
    constructed with ``verify=False`` is the canonical way to opt out of
    certificate validation for self-signed Splunk deployments.
    """
    return httpx.AsyncClient(
        verify=False,
        headers=headers or {},
        timeout=timeout if timeout is not None else httpx.Timeout(30.0),
        auth=auth,
        follow_redirects=True,
    )


def _insecure_transport_kwargs(transport_fn: Any) -> dict[str, Any]:
    """Pick the right kwarg name for disabling TLS on this MCP SDK version.

    Modern MCP SDKs expose ``httpx_client_factory`` (a callable). Older
    versions exposed ``httpx_client`` (an instance). If neither is present
    we return an empty dict and log a warning — the connection will then
    fall back to the SDK's default (verifying) client.
    """
    try:
        params = inspect.signature(transport_fn).parameters
    except (TypeError, ValueError):
        return {}
    if "httpx_client_factory" in params:
        return {"httpx_client_factory": _make_insecure_http_client}
    if "httpx_client" in params:
        return {"httpx_client": _make_insecure_http_client()}
    logging.getLogger(__name__).warning(
        "%s accepts neither httpx_client_factory nor httpx_client; "
        "cannot disable TLS verification — SSL errors against self-signed "
        "Splunk certs are likely.",
        getattr(transport_fn, "__name__", repr(transport_fn)),
    )
    return {}

logger = logging.getLogger(__name__)


# ---- Tool names --------------------------------------------------------------

# Core splunk_* tools — assumed to be available on every Splunk MCP deployment.
TOOL_GET_INFO = "splunk_get_info"
TOOL_GET_INDEXES = "splunk_get_indexes"
TOOL_GET_INDEX_INFO = "splunk_get_index_info"
TOOL_GET_METADATA = "splunk_get_metadata"
TOOL_GET_KNOWLEDGE_OBJECTS = "splunk_get_knowledge_objects"
TOOL_GET_USER_LIST = "splunk_get_user_list"
TOOL_GET_USER_INFO = "splunk_get_user_info"
TOOL_GET_KV_STORE_COLLECTIONS = "splunk_get_kv_store_collections"
TOOL_RUN_QUERY = "splunk_run_query"
TOOL_RUN_SAVED_SEARCH = "splunk_run_saved_search"

# Optional saia_* tools — require AI Assistant for SPL.
TOOL_EXPLAIN_SPL = "saia_explain_spl"
TOOL_ASK_SPLUNK_QUESTION = "saia_ask_splunk_question"

CORE_TOOLS: tuple[str, ...] = (
    TOOL_GET_INFO,
    TOOL_GET_INDEXES,
    TOOL_GET_INDEX_INFO,
    TOOL_GET_METADATA,
    TOOL_GET_KNOWLEDGE_OBJECTS,
    TOOL_GET_USER_LIST,
    TOOL_GET_USER_INFO,
    TOOL_GET_KV_STORE_COLLECTIONS,
    TOOL_RUN_QUERY,
    TOOL_RUN_SAVED_SEARCH,
)

OPTIONAL_TOOLS: tuple[str, ...] = (
    TOOL_EXPLAIN_SPL,
    TOOL_ASK_SPLUNK_QUESTION,
)


# ---- Errors / availability ---------------------------------------------------


class SplunkMCPError(RuntimeError):
    """Raised on any failure from the Splunk MCP server."""


@dataclass
class ToolAvailability:
    """Which tools the connected server actually exposes."""

    available: set[str] = field(default_factory=set)
    missing: set[str] = field(default_factory=set)

    @property
    def has_saia(self) -> bool:
        return TOOL_EXPLAIN_SPL in self.available or TOOL_ASK_SPLUNK_QUESTION in self.available

    def to_dict(self) -> dict[str, Any]:
        return {
            "available": sorted(self.available),
            "missing": sorted(self.missing),
            "has_saia": self.has_saia,
        }


# ---- SPL guardrails ----------------------------------------------------------

# Commands that produce aggregated output (no per-row need for `| head N`).
_AGG_COMMANDS = {
    "stats",
    "tstats",
    "chart",
    "timechart",
    "eventstats",
    "streamstats",
    "top",
    "rare",
    "transaction",
    "metasearch",
}

_HEAD_OR_TAIL_RE = re.compile(r"\|\s*(?:head|tail)\s+\d+", re.IGNORECASE)
_PIPE_TOKEN_RE = re.compile(r"\|\s*([a-zA-Z_]+)")


def _has_aggregation(spl: str) -> bool:
    return any(cmd in {c.lower() for c in _PIPE_TOKEN_RE.findall(spl)} for cmd in _AGG_COMMANDS)


def _apply_query_guardrails(
    spl: str,
    *,
    default_cap: int = 1000,
) -> str:
    """Ensure SPL has a sensible result cap. Aggregations are left alone."""
    stripped = spl.strip()
    if not stripped:
        return stripped
    if _HEAD_OR_TAIL_RE.search(stripped):
        return stripped
    if _has_aggregation(stripped):
        return stripped
    return f"{stripped} | head {default_cap}"


# ---- Client ------------------------------------------------------------------


class SplunkMCPClient:
    """Async client for the Splunk MCP server.

    Use as an async context manager::

        async with SplunkMCPClient(url, token) as client:
            info = await client.get_info()

    Or manually with ``connect()`` / ``aclose()``.
    """

    def __init__(
        self,
        url: str,
        token: str,
        *,
        default_earliest: str = "0",
        default_latest: str = "now",
        default_result_cap: int = 1000,
        transport: str = TRANSPORT_STREAMABLE_HTTP,
    ) -> None:
        self._url = url
        self._token = token
        self._default_earliest = default_earliest
        self._default_latest = default_latest
        self._default_result_cap = default_result_cap
        if transport not in (TRANSPORT_STREAMABLE_HTTP, TRANSPORT_SSE):
            raise ValueError(
                f"unknown transport {transport!r}; "
                f"expected one of {TRANSPORT_STREAMABLE_HTTP!r}, {TRANSPORT_SSE!r}"
            )
        self._transport = transport

        self._session: ClientSession | None = None
        self._exit_stack: AsyncExitStack | None = None
        self._availability: ToolAvailability | None = None

    # ---- lifecycle ----

    async def __aenter__(self) -> "SplunkMCPClient":
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.aclose()

    async def connect(self) -> ToolAvailability:
        """Open the MCP session and probe tool availability."""
        if self._session is not None:
            assert self._availability is not None
            return self._availability

        logger.info("connecting to Splunk MCP at %s", self._url)
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}

        self._exit_stack = AsyncExitStack()
        try:
            if self._transport == TRANSPORT_SSE:
                transport_cm = sse_client(
                    self._url,
                    headers=headers,
                    **_insecure_transport_kwargs(sse_client),
                )
            else:
                transport_cm = streamablehttp_client(
                    self._url,
                    headers=headers,
                    **_insecure_transport_kwargs(streamablehttp_client),
                )
            transport = await self._exit_stack.enter_async_context(transport_cm)
            # streamablehttp_client yields (read_stream, write_stream, _close);
            # sse_client yields (read_stream, write_stream). The ``*_`` handles both.
            read_stream, write_stream, *_ = transport
            session = await self._exit_stack.enter_async_context(
                ClientSession(read_stream, write_stream)
            )
            await session.initialize()
            self._session = session
            self._availability = await self._probe_tools()
            logger.info(
                "connected; %d tools available (saia: %s)",
                len(self._availability.available),
                self._availability.has_saia,
            )
            return self._availability
        except Exception as exc:
            await self._exit_stack.aclose()
            self._exit_stack = None
            raise SplunkMCPError(f"failed to connect to Splunk MCP: {exc}") from exc

    async def aclose(self) -> None:
        if self._exit_stack is not None:
            await self._exit_stack.aclose()
        self._exit_stack = None
        self._session = None
        self._availability = None

    @property
    def availability(self) -> ToolAvailability:
        if self._availability is None:
            raise SplunkMCPError("client is not connected — call connect() first")
        return self._availability

    async def _probe_tools(self) -> ToolAvailability:
        assert self._session is not None
        try:
            listing = await self._session.list_tools()
        except Exception as exc:
            raise SplunkMCPError(f"list_tools failed: {exc}") from exc

        names: set[str] = set()
        for tool in getattr(listing, "tools", []) or []:
            name = getattr(tool, "name", None)
            if isinstance(name, str):
                names.add(name)

        expected = set(CORE_TOOLS) | set(OPTIONAL_TOOLS)
        return ToolAvailability(
            available=names & expected,
            missing=expected - names,
        )

    # ---- core call helper ----

    async def _call(self, tool: str, arguments: dict[str, Any] | None = None) -> Any:
        if self._session is None:
            raise SplunkMCPError("client is not connected")
        if self._availability and tool not in self._availability.available:
            raise SplunkMCPError(f"tool {tool!r} is not available on this MCP server")

        try:
            result = await self._session.call_tool(tool, arguments or {})
        except Exception as exc:
            raise SplunkMCPError(f"{tool} failed: {exc}") from exc

        if getattr(result, "isError", False):
            raise SplunkMCPError(f"{tool} returned an error: {_render_content(result)}")

        return _normalize_result(result)

    # ---- splunk_* tools ----

    async def get_info(self) -> dict[str, Any]:
        """Return Splunk deployment info (version, build, server name, etc.).

        The Splunk MCP server wraps the row in ``{"results": [{...}], ...}``;
        we unwrap so callers always see a flat dict of fields.
        """
        raw = await self._call(TOOL_GET_INFO)
        unwrapped = _first_result_row(raw)
        if unwrapped is not None:
            return unwrapped
        return _expect_dict(raw)

    async def get_indexes(self) -> list[dict[str, Any]]:
        """List every index on the deployment.

        The Splunk MCP server returns ``{"count": N, "names": [str, ...]}``;
        we normalize to ``[{"name": <name>}, ...]`` so downstream code can
        iterate uniformly with the other dict-shaped knowledge-object lists.
        """
        raw = await self._call(TOOL_GET_INDEXES)
        if isinstance(raw, dict):
            names = raw.get("names")
            if isinstance(names, list):
                return [{"name": n} for n in names if isinstance(n, str)]
        return _expect_list_of_dicts(raw)

    async def get_index_info(self, index_name: str) -> dict[str, Any]:
        """Per-index metadata: total event count, size, retention, etc.

        Same ``results[0]`` unwrap as :py:meth:`get_info`.
        """
        raw = await self._call(TOOL_GET_INDEX_INFO, {"index_name": index_name})
        unwrapped = _first_result_row(raw)
        if unwrapped is not None:
            return unwrapped
        return _expect_dict(raw)

    async def get_metadata(
        self,
        index_name: str,
        *,
        kind: str = "sourcetypes",
    ) -> list[dict[str, Any]]:
        """``| metadata type=<kind> index=<index>`` results.

        ``kind`` is one of ``sources``, ``sourcetypes``, or ``hosts``.
        """
        return _expect_list_of_dicts(
            await self._call(TOOL_GET_METADATA, {"index": index_name, "type": kind})
        )

    async def get_knowledge_objects(
        self,
        *,
        kind: str | None = None,
        app: str | None = None,
        owner: str | None = None,
        count: int | None = 0,
    ) -> list[dict[str, Any]]:
        """Enumerate knowledge objects.

        ``kind`` selects the object class — ``saved_searches``, ``macros``,
        ``lookups``, ``views`` (dashboards), etc. If omitted, the server
        returns every kind it knows about.

        ``count=0`` follows Splunk's REST convention for "return all rows".
        Some MCP server builds honor it; others silently cap at 100. Callers
        that care about completeness (notably saved searches) should detect
        a 100-item result and fall back to :py:meth:`get_all_saved_searches`.
        """
        args: dict[str, Any] = {}
        if kind is not None:
            args["type"] = kind
        if app is not None:
            args["app"] = app
        if owner is not None:
            args["owner"] = owner
        if count is not None:
            args["count"] = count
        return _expect_list_of_dicts(await self._call(TOOL_GET_KNOWLEDGE_OBJECTS, args))

    async def get_all_saved_searches(self) -> dict[str, Any]:
        """REST-backed fallback to enumerate every saved search.

        ``splunk_get_knowledge_objects`` caps results at 100 on the current
        Splunk MCP server build, regardless of the ``count`` argument. When
        the team has more than 100 saved searches, important ones past the
        alphabetical cutoff disappear silently. This helper uses
        ``splunk_run_query`` to hit the REST endpoint directly via SPL,
        which honors ``count=0`` and returns everything.

        Returns the raw run_query response (``{"results": [...], ...}``);
        callers can use ``_extract_rows`` to unwrap.
        """
        # count=200 — explicit upper bound, not count=0. Some Splunk versions
        # interpret 0 as "use the endpoint default" (which is 30) rather than
        # "unlimited", so an explicit number is more portable.
        spl = (
            "| rest /services/saved/searches splunk_server=local count=200 "
            "| table title search \"eai:acl.app\" \"eai:acl.owner\" "
            "alert_type \"alert.severity\" \"alert.track\" actions "
            "cron_schedule disabled"
        )
        return await self.run_query(spl, earliest="0")

    async def get_user_list(self) -> list[dict[str, Any]]:
        """List all Splunk users."""
        return _expect_list_of_dicts(await self._call(TOOL_GET_USER_LIST))

    async def get_user_info(self, username: str) -> dict[str, Any]:
        """Per-user info: roles, capabilities, default app, email."""
        return _expect_dict(await self._call(TOOL_GET_USER_INFO, {"username": username}))

    async def get_kv_store_collections(
        self,
        *,
        app: str | None = None,
    ) -> list[dict[str, Any]]:
        """KV store collections; optionally scoped to ``app``."""
        args: dict[str, Any] = {}
        if app is not None:
            args["app"] = app
        return _expect_list_of_dicts(await self._call(TOOL_GET_KV_STORE_COLLECTIONS, args))

    async def run_query(
        self,
        spl: str,
        *,
        earliest: str | None = None,
        latest: str | None = None,
        max_results: int | None = None,
    ) -> dict[str, Any]:
        """Run ad-hoc SPL.

        Guardrails applied automatically:

        - If ``earliest`` is not given, the configured default (``-24h``) is used.
        - If ``latest`` is not given, ``now`` is used.
        - If the SPL has no ``head`` / ``tail`` and no aggregating command, a
          ``| head <default_result_cap>`` is appended to bound the result set.
        """
        if not spl or not spl.strip():
            raise SplunkMCPError("run_query: SPL cannot be empty")

        cap = max_results or self._default_result_cap
        bounded_spl = _apply_query_guardrails(spl, default_cap=cap)

        args: dict[str, Any] = {
            "query": bounded_spl,
            "earliest_time": earliest or self._default_earliest,
            "latest_time": latest or self._default_latest,
        }
        return _expect_dict(await self._call(TOOL_RUN_QUERY, args))

    async def run_saved_search(
        self,
        name: str,
        *,
        owner: str | None = None,
        app: str | None = None,
        trigger_actions: bool = False,
    ) -> dict[str, Any]:
        """Dispatch a saved search and return its results."""
        args: dict[str, Any] = {"saved_search_name": name, "trigger_actions": trigger_actions}
        if owner is not None:
            args["owner"] = owner
        if app is not None:
            args["app"] = app
        return _expect_dict(await self._call(TOOL_RUN_SAVED_SEARCH, args))

    # ---- saia_* tools (optional) ----

    def has_saia(self) -> bool:
        return self.availability.has_saia

    async def explain_spl(self, spl: str) -> str:
        """Natural-language explanation of ``spl``.

        Raises ``SplunkMCPError`` if AI Assistant for SPL isn't installed on
        the server. Callers should check :py:meth:`has_saia` first and route
        to an LLM fallback when False.
        """
        if not spl or not spl.strip():
            raise SplunkMCPError("explain_spl: SPL cannot be empty")
        result = await self._call(TOOL_EXPLAIN_SPL, {"spl": spl})
        return _expect_text(result)

    async def ask_splunk_question(self, question: str) -> str:
        """Free-form Splunk-domain Q&A via the SAIA tool."""
        if not question or not question.strip():
            raise SplunkMCPError("ask_splunk_question: question cannot be empty")
        result = await self._call(TOOL_ASK_SPLUNK_QUESTION, {"question": question})
        return _expect_text(result)


# ---- Response normalization --------------------------------------------------


def _render_content(result: Any) -> str:
    """Human-readable rendering of MCP content blocks (used in error messages)."""
    blocks = getattr(result, "content", None) or []
    pieces: list[str] = []
    for block in blocks:
        text = getattr(block, "text", None)
        if text:
            pieces.append(text)
    return "\n".join(pieces) if pieces else repr(result)


def _normalize_result(result: Any) -> Any:
    """Reduce an MCP ``CallToolResult`` to a plain Python value.

    Splunk's MCP server typically returns JSON in a single text content block.
    We try to parse JSON; if that fails we fall back to the raw text. If the
    server uses ``structuredContent``, we prefer that.
    """
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        return structured

    blocks = getattr(result, "content", None) or []
    if not blocks:
        return None

    text_pieces = [getattr(b, "text", "") for b in blocks if getattr(b, "text", None)]
    text = "\n".join(text_pieces).strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def _first_result_row(value: Any) -> dict[str, Any] | None:
    """If ``value`` is ``{"results": [row, ...], ...}``, return the first row.

    Returns ``None`` if the shape doesn't match — caller can fall back.
    """
    if not isinstance(value, dict):
        return None
    results = value.get("results")
    if isinstance(results, list) and results and isinstance(results[0], dict):
        return results[0]
    return None


def _expect_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    raise SplunkMCPError(f"expected dict response, got {type(value).__name__}: {value!r}")


def _expect_list_of_dicts(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [v for v in value if isinstance(v, dict)]
    if isinstance(value, dict):
        # Splunk often wraps lists under "entries" / "results" / "items".
        for key in ("entries", "results", "items", "data"):
            inner = value.get(key)
            if isinstance(inner, list):
                return [v for v in inner if isinstance(v, dict)]
    raise SplunkMCPError(f"expected list response, got {type(value).__name__}: {value!r}")


def _expect_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("explanation", "answer", "text", "response"):
            v = value.get(key)
            if isinstance(v, str):
                return v
        return json.dumps(value, indent=2)
    return str(value)
