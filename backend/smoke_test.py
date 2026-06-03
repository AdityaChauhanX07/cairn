#!/usr/bin/env python3
"""Smoke-test the Splunk MCP client against a real deployment.

Run from the repo root:

    python backend/smoke_test.py

It loads settings from ``.env`` (via the same ``config.py`` the app uses),
opens an MCP session to ``SPLUNK_MCP_URL`` with ``SPLUNK_TOKEN``, and runs
twelve checks that exercise the tools Cairn relies on. Each test prints
status + a pretty-printed slice of the response. If one test fails the
script continues.

If the default ``streamable_http`` transport can't connect, the script
automatically retries with the ``sse`` transport before giving up.
"""

from __future__ import annotations

import asyncio
import json
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

# ---- Make ``backend/`` importable when run from the repo root --------------
_BACKEND_DIR = Path(__file__).resolve().parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from config import configure_logging, get_settings  # noqa: E402
from mcp_client import SplunkMCPClient, SplunkMCPError  # noqa: E402
from mcp_client.client import (  # noqa: E402
    TRANSPORT_SSE,
    TRANSPORT_STREAMABLE_HTTP,
)


# ---- Output helpers --------------------------------------------------------

_TRUNCATE = 2000


def _pretty(value: Any, *, limit: int = _TRUNCATE) -> str:
    """Pretty-print a value as JSON; truncate to ``limit`` characters."""
    try:
        text = json.dumps(value, indent=2, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        text = repr(value)
    if len(text) > limit:
        return text[:limit] + f"\n... (truncated, full response is {len(text)} chars)"
    return text


def _first_item(value: Any) -> Any:
    """Return the first element of a list response (or ``value`` unchanged)."""
    if isinstance(value, list):
        if not value:
            return {"_note": "empty list — Splunk returned no items of this kind"}
        return value[0]
    return value


def _header(num: int, total: int, name: str) -> None:
    print()
    print(f"═══ Test {num}/{total}: {name} ═══")


# ---- Result tracking -------------------------------------------------------


@dataclass
class _Result:
    name: str
    passed: bool
    error: str | None = None


@dataclass
class _Tracker:
    results: list[_Result] = field(default_factory=list)

    def record(self, name: str, passed: bool, error: str | None = None) -> None:
        self.results.append(_Result(name=name, passed=passed, error=error))

    @property
    def passed(self) -> int:
        return sum(1 for r in self.results if r.passed)

    @property
    def failed(self) -> int:
        return sum(1 for r in self.results if not r.passed)


# ---- Connection bootstrap (with transport fallback) ------------------------


async def _try_connect(url: str, token: str, transport: str) -> SplunkMCPClient | None:
    """Attempt a connection using ``transport``. Returns the client or None.

    The MCP transport that works depends on how the Splunk MCP server is
    configured: newer ``streamable_http`` is the default in recent SDKs;
    older deployments only expose ``sse``. We try both.
    """
    client = SplunkMCPClient(url, token, transport=transport)
    try:
        await client.connect()
        return client
    except SplunkMCPError as exc:
        print(f"  ! {transport} transport: {exc}")
    except Exception as exc:
        print(f"  ! {transport} transport raised {type(exc).__name__}: {exc}")
        traceback.print_exc()
    # Make sure we don't leak the half-open connection.
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


# ---- Individual tests ------------------------------------------------------


TestFn = Callable[[SplunkMCPClient], Awaitable[Any]]


async def t1_list_tools(client: SplunkMCPClient) -> Any:
    """List the tools the connected MCP server exposes."""
    avail = client.availability
    payload = {
        "available": sorted(avail.available),
        "missing": sorted(avail.missing),
        "has_saia": avail.has_saia,
        "saia_tools_available": sorted(
            t for t in avail.available if t.startswith("saia_")
        ),
        "saia_tools_missing": sorted(
            t for t in avail.missing if t.startswith("saia_")
        ),
    }
    return payload


async def t2_get_info(client: SplunkMCPClient) -> Any:
    return await client.get_info()


async def t3_get_indexes(client: SplunkMCPClient) -> Any:
    indexes = await client.get_indexes()
    names = []
    for entry in indexes:
        # The MCP server may emit "name" or "title" — show whatever's there.
        name = entry.get("name") or entry.get("title")
        if isinstance(name, str):
            names.append(name)
    return {"count": len(indexes), "names": names}


async def t4_get_index_info(client: SplunkMCPClient) -> Any:
    return await client.get_index_info("auth_events")


async def t5_knowledge_saved_searches(client: SplunkMCPClient) -> Any:
    items = await client.get_knowledge_objects(kind="saved_searches")
    return {"count": len(items), "first_item": _first_item(items)}


async def t6_knowledge_macros(client: SplunkMCPClient) -> Any:
    items = await client.get_knowledge_objects(kind="macros")
    return {"count": len(items), "first_item": _first_item(items)}


async def t7_knowledge_alerts(client: SplunkMCPClient) -> Any:
    items = await client.get_knowledge_objects(kind="alerts")
    return {"count": len(items), "first_item": _first_item(items)}


async def t8_knowledge_views(client: SplunkMCPClient) -> Any:
    items = await client.get_knowledge_objects(kind="views")
    return {"count": len(items), "first_item": _first_item(items)}


async def t9_knowledge_lookups(client: SplunkMCPClient) -> Any:
    items = await client.get_knowledge_objects(kind="lookups")
    return {"count": len(items), "first_item": _first_item(items)}


async def t10_run_query(client: SplunkMCPClient) -> Any:
    return await client.run_query(
        "index=auth_events action=failure | stats count by user, src_ip | head 5"
    )


async def t11_run_saved_search(client: SplunkMCPClient) -> Any:
    return await client.run_saved_search("Daily Failed Login Summary")


async def t12_user_list(client: SplunkMCPClient) -> Any:
    return await client.get_user_list()


TESTS: tuple[tuple[str, TestFn], ...] = (
    ("List available tools", t1_list_tools),
    ("splunk_get_info", t2_get_info),
    ("splunk_get_indexes", t3_get_indexes),
    ("splunk_get_index_info for 'auth_events'", t4_get_index_info),
    ("splunk_get_knowledge_objects: saved_searches", t5_knowledge_saved_searches),
    ("splunk_get_knowledge_objects: macros", t6_knowledge_macros),
    ("splunk_get_knowledge_objects: alerts", t7_knowledge_alerts),
    ("splunk_get_knowledge_objects: views", t8_knowledge_views),
    ("splunk_get_knowledge_objects: lookups", t9_knowledge_lookups),
    ("splunk_run_query (auth_events failures)", t10_run_query),
    ("splunk_run_saved_search 'Daily Failed Login Summary'", t11_run_saved_search),
    ("splunk_get_user_list", t12_user_list),
)


# ---- Main ------------------------------------------------------------------


async def _run_test(
    client: SplunkMCPClient, num: int, total: int, name: str, fn: TestFn
) -> _Result:
    _header(num, total, name)
    try:
        response = await fn(client)
    except SplunkMCPError as exc:
        print("Status: ✗ FAIL")
        print(f"Error: {exc}")
        return _Result(name=name, passed=False, error=str(exc))
    except Exception as exc:
        print("Status: ✗ FAIL")
        print(f"Error: {type(exc).__name__}: {exc}")
        traceback.print_exc()
        return _Result(name=name, passed=False, error=f"{type(exc).__name__}: {exc}")
    print("Status: ✓ PASS")
    print("Response:")
    print(_pretty(response))
    return _Result(name=name, passed=True)


async def _async_main() -> int:
    settings = get_settings()
    configure_logging(settings)

    token = settings.splunk_token.get_secret_value()
    url = settings.splunk_mcp_url
    if not token:
        print("ERROR: SPLUNK_TOKEN is empty. Set it in .env before running.")
        return 2
    if not url:
        print("ERROR: SPLUNK_MCP_URL is empty. Set it in .env before running.")
        return 2

    client = await _open_client(url, token)
    tracker = _Tracker()
    total = len(TESTS)
    try:
        for idx, (name, fn) in enumerate(TESTS, start=1):
            result = await _run_test(client, idx, total, name, fn)
            tracker.results.append(result)
    finally:
        await client.aclose()

    # ---- Summary ----
    print()
    print("=" * 60)
    print(f"Summary: {tracker.passed}/{total} passed, {tracker.failed} failed.")
    print("=" * 60)
    if tracker.failed:
        print("\nFailures:")
        for r in tracker.results:
            if not r.passed:
                print(f"  ✗ {r.name}")
                if r.error:
                    print(f"      {r.error}")
        return 1
    return 0


def main() -> int:
    try:
        return asyncio.run(_async_main())
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
