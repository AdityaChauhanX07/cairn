#!/usr/bin/env python3
"""Probe the Splunk MCP server for MLTK knowledge objects.

Run from the repo root:

    python backend/test_mltk.py

Same connection pattern as ``smoke_test.py``: loads ``.env`` via ``config.py``,
opens an MCP session to ``SPLUNK_MCP_URL`` with ``SPLUNK_TOKEN`` (trying the
``streamable_http`` transport first, then ``sse``), and calls
``splunk_get_knowledge_objects`` with ``type=mltk_models`` and
``type=mltk_algorithms``, printing both results.

This is a discovery probe for the planned "AI & ML Footprint" feature — it tells
us whether MLTK is installed and whether the MCP server understands these kinds.
"""

from __future__ import annotations

import asyncio
import json
import sys
import traceback
from pathlib import Path
from typing import Any

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

_TRUNCATE = 4000


def _pretty(value: Any, *, limit: int = _TRUNCATE) -> str:
    try:
        text = json.dumps(value, indent=2, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        text = repr(value)
    if len(text) > limit:
        return text[:limit] + f"\n... (truncated, full response is {len(text)} chars)"
    return text


async def _try_connect(url: str, token: str, transport: str) -> SplunkMCPClient | None:
    client = SplunkMCPClient(url, token, transport=transport)
    try:
        await client.connect()
        return client
    except SplunkMCPError as exc:
        print(f"  ! {transport} transport: {exc}")
    except Exception as exc:
        print(f"  ! {transport} transport raised {type(exc).__name__}: {exc}")
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


async def _probe(client: SplunkMCPClient, kind: str) -> None:
    print()
    print(f"═══ splunk_get_knowledge_objects: type={kind} ═══")
    try:
        items = await client.get_knowledge_objects(kind=kind)
    except SplunkMCPError as exc:
        print("Status: ✗ FAIL")
        print(f"Error: {exc}")
        return
    except Exception as exc:
        print("Status: ✗ FAIL")
        print(f"Error: {type(exc).__name__}: {exc}")
        traceback.print_exc()
        return
    print("Status: ✓ PASS")
    print(f"Count: {len(items)}")
    print("Response:")
    print(_pretty(items))


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
    try:
        await _probe(client, "mltk_models")
        await _probe(client, "mltk_algorithms")
    finally:
        await client.aclose()
    return 0


def main() -> int:
    try:
        return asyncio.run(_async_main())
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
