#!/usr/bin/env python3
"""End-to-end test of the Cairn agent — exploration + guide + Q&A.

Runs the full orchestrator pipeline against a real Splunk MCP server and a
real Groq API key. No mocks. Streams every ``AgentEvent`` as it lands and
finally prints each guide section preview + an answer to a follow-up
question.

Run from the repo root::

    python backend/e2e_test.py

Expected total LLM calls on the demo data:
    ~4 during explore   (1 reasoning + 3 SPL explanations for alerts)
  +  5 during guide gen (one per section)
  +  1 for the Q&A question
  =  ~10 calls
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
from agent.orchestrator import AgentEvent, AgentPhase, Orchestrator  # noqa: E402


# The question we'll pose after the guide is generated.
QA_QUESTION = (
    "This alert 'Critical: Multiple Failed Logins from Same IP' paged me at "
    "3am. What does it mean and what should I do?"
)


# ---- Output helpers --------------------------------------------------------


def _section(title: str) -> None:
    print()
    print("═" * 72)
    print(f" {title}")
    print("═" * 72)


def _truncate_json(value: Any, *, limit: int = 600) -> str:
    try:
        text = json.dumps(value, indent=2, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        text = repr(value)
    if len(text) > limit:
        return text[:limit] + f"\n... (truncated, {len(text)} chars)"
    return text


def _print_event(event: AgentEvent) -> None:
    tag = "✗" if event.phase == AgentPhase.ERROR else "•"
    print(f"  {tag} [{event.phase.value}] {event.message}")
    if event.detail:
        print(f"      detail: {event.detail}")
    if event.data:
        for line in _truncate_json(event.data, limit=400).splitlines():
            print(f"      {line}")


# ---- Connection bootstrap --------------------------------------------------


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


# ---- Main ------------------------------------------------------------------


async def _async_main() -> int:
    settings = get_settings()
    configure_logging(settings)

    url = settings.splunk_mcp_url
    token = settings.splunk_token.get_secret_value()
    groq_key = settings.groq_api_key.get_secret_value()

    if not url:
        print("ERROR: SPLUNK_MCP_URL is empty. Set it in .env.")
        return 2
    if not token:
        print("ERROR: SPLUNK_TOKEN is empty. Set it in .env.")
        return 2
    if not groq_key:
        print("ERROR: GROQ_API_KEY is empty. Set it in .env.")
        return 2

    print(f"Groq model: {settings.groq_model}")

    client = await _open_client(url, token)
    orchestrator = Orchestrator(client, settings=settings)

    try:
        # ---- Phase A: explore ----
        _section("Phase A: Orchestrator.explore()")
        async for event in orchestrator.explore():
            _print_event(event)

        _section("Graph summary after explore")
        print(_truncate_json(orchestrator.graph.summary(), limit=2000))

        # ---- Phase B: generate guide ----
        _section("Phase B: Orchestrator.generate_guide()")
        async for event in orchestrator.generate_guide():
            _print_event(event)

        guide = orchestrator.guide
        if guide is None:
            print("\n✗ guide was not produced; aborting before Q&A")
            return 1

        # ---- Section previews ----
        _section("Guide section previews")
        for i, (title, body) in enumerate(guide.sections.items(), start=1):
            print(f"\n  [{i}] ## {title}")
            preview = body.strip().splitlines()[:6]
            for line in preview:
                print(f"      {line[:120]}")
            if len(body) > 200:
                print(f"      … ({len(body)} chars total)")

        # ---- Write full markdown to disk for inspection ----
        out_path = _BACKEND_DIR.parent / "cairn-guide.md"
        try:
            out_path.write_text(guide.markdown, encoding="utf-8")
            print(f"\n  ✓ full guide written to {out_path}")
        except OSError as exc:
            print(f"\n  ! couldn't write {out_path}: {exc}")

        # ---- Phase C: Q&A ----
        _section("Phase C: Orchestrator.ask()")
        print(f"  Q: {QA_QUESTION}\n")
        try:
            answer = await orchestrator.ask(QA_QUESTION)
        except Exception as exc:
            print(f"  ✗ ask() raised {type(exc).__name__}: {exc}")
            traceback.print_exc()
            return 1
        print("  A:")
        for line in answer.splitlines():
            print(f"      {line}")

    finally:
        await client.aclose()

    print()
    print("=" * 72)
    print(" End-to-end test complete.")
    print("=" * 72)
    return 0


def main() -> int:
    try:
        return asyncio.run(_async_main())
    except KeyboardInterrupt:
        print("\nInterrupted.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
