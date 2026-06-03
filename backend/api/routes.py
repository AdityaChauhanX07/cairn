"""REST + SSE endpoints for Cairn.

There is one orchestrator per process — Cairn is a single-tenant dev tool,
not a multi-user SaaS, so the simplest correct concurrency model is a
single ``Orchestrator`` instance plus an ``asyncio.Lock`` on the explore
endpoint.

Endpoints:

- ``POST /api/connect``   — connect to a Splunk MCP server
- ``GET  /api/explore``   — SSE stream of agent events
- ``GET  /api/guide``     — fetch the generated guide as JSON
- ``POST /api/ask``       — follow-up Q&A against the discovered graph
- ``GET  /api/export``    — export the guide (markdown | html)
- ``GET  /api/health``    — liveness probe
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from agent import AgentEvent, Orchestrator
from config import get_settings
from mcp_client import SplunkMCPClient, SplunkMCPError

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")


# ---- Session state --------------------------------------------------------


@dataclass
class _Session:
    """The (single) live orchestration session."""

    mcp_client: SplunkMCPClient
    orchestrator: Orchestrator
    splunk_url: str
    saia_available: bool


_session: _Session | None = None
_session_lock = asyncio.Lock()


def _current_session() -> _Session:
    if _session is None:
        raise HTTPException(
            status_code=409,
            detail="not connected — POST /api/connect first",
        )
    return _session


# ---- Request / response models -------------------------------------------


class ConnectRequest(BaseModel):
    splunk_url: str | None = Field(
        default=None,
        description="Splunk MCP URL. Defaults to the SPLUNK_MCP_URL env var.",
    )
    token: str | None = Field(
        default=None,
        description="Splunk auth token. Defaults to the SPLUNK_TOKEN env var.",
    )


class ConnectResponse(BaseModel):
    connected: bool
    splunk_url: str
    deployment: dict[str, Any] | None = None
    tool_availability: dict[str, Any]


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1)


class AskResponse(BaseModel):
    answer: str


# ---- Endpoints -----------------------------------------------------------


@router.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "connected": _session is not None,
        "guide_ready": _session is not None and _session.orchestrator.guide is not None,
    }


@router.post("/connect", response_model=ConnectResponse)
async def connect(req: ConnectRequest) -> ConnectResponse:
    """(Re)connect to the Splunk MCP server.

    Calling this while already connected replaces the previous session
    (after cleanly closing the old MCP connection).
    """
    global _session

    settings = get_settings()
    url = req.splunk_url or settings.splunk_mcp_url
    token = req.token or settings.splunk_token.get_secret_value()

    if not url:
        raise HTTPException(status_code=400, detail="splunk_url is required")
    if not token:
        raise HTTPException(status_code=400, detail="token is required")

    async with _session_lock:
        # Close any previous session.
        if _session is not None:
            try:
                await _session.mcp_client.aclose()
            except Exception:  # nosec - best-effort cleanup
                logger.exception("failed to close previous MCP session")
            _session = None

        client = SplunkMCPClient(
            url,
            token,
            default_earliest=settings.default_earliest,
            default_result_cap=settings.default_result_cap,
        )

        try:
            availability = await client.connect()
        except SplunkMCPError as exc:
            await client.aclose()
            raise HTTPException(status_code=502, detail=f"MCP connect failed: {exc}") from exc

        try:
            deployment = await client.get_info()
        except SplunkMCPError as exc:
            logger.warning("get_info failed during connect: %s", exc)
            deployment = None

        orchestrator = Orchestrator(client, settings=settings)
        _session = _Session(
            mcp_client=client,
            orchestrator=orchestrator,
            splunk_url=url,
            saia_available=availability.has_saia,
        )

        return ConnectResponse(
            connected=True,
            splunk_url=url,
            deployment=deployment,
            tool_availability=availability.to_dict(),
        )


@router.get("/explore")
async def explore() -> EventSourceResponse:
    """Stream agent events as Server-Sent Events.

    Each event has the JSON-encoded ``AgentEvent`` as its ``data`` field. The
    ``event`` field is the phase name, so frontends can use ``EventSource``'s
    typed listeners (e.g. ``source.addEventListener('synthesize', ...)``).
    """
    session = _current_session()

    async def event_stream() -> AsyncIterator[dict[str, Any]]:
        async for event in session.orchestrator.explore():
            yield {
                "event": event.phase.value,
                "data": json.dumps(event.to_dict()),
            }

    return EventSourceResponse(event_stream())


@router.get("/guide")
async def get_guide() -> dict[str, Any]:
    """Return the synthesized onboarding guide as JSON."""
    session = _current_session()
    guide = session.orchestrator.guide
    if guide is None:
        raise HTTPException(
            status_code=409,
            detail="guide not ready — run /api/explore first",
        )
    return guide.to_dict()


@router.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest) -> AskResponse:
    """Free-form follow-up Q&A grounded in the discovered graph."""
    session = _current_session()
    if session.orchestrator.guide is None:
        # We can still answer — the graph is populated even before synthesis —
        # but warn callers.
        logger.info("ask() called before guide synthesis completed")
    answer = await session.orchestrator.ask(req.question)
    return AskResponse(answer=answer)


@router.get("/export")
async def export_guide(
    format: str = Query("markdown", pattern="^(markdown|html)$"),
) -> Response:
    """Export the guide as markdown or a minimal HTML document."""
    session = _current_session()
    guide = session.orchestrator.guide
    if guide is None:
        raise HTTPException(status_code=409, detail="guide not ready")

    if format == "markdown":
        return PlainTextResponse(
            guide.markdown,
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="cairn-guide.md"'},
        )

    html_body = _markdown_to_minimal_html(guide.markdown)
    return Response(
        content=html_body,
        media_type="text/html; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="cairn-guide.html"'},
    )


# ---- HTML rendering helper ---------------------------------------------

# Intentionally minimal — we don't pull in a markdown library just for this.
# A tiny converter that handles headings, paragraphs, code fences, and lists
# is enough for the guide's structure. If the project later wants nicer
# output, drop in `markdown` or `markdown-it-py`.


def _markdown_to_minimal_html(md: str) -> str:
    import html

    lines = md.splitlines()
    out: list[str] = []
    in_code = False
    in_list = False
    for raw in lines:
        line = raw.rstrip()
        if line.startswith("```"):
            if in_code:
                out.append("</code></pre>")
                in_code = False
            else:
                out.append("<pre><code>")
                in_code = True
            continue
        if in_code:
            out.append(html.escape(line))
            continue

        if line.startswith("## "):
            if in_list:
                out.append("</ul>")
                in_list = False
            out.append(f"<h2>{html.escape(line[3:].strip())}</h2>")
        elif line.startswith("# "):
            if in_list:
                out.append("</ul>")
                in_list = False
            out.append(f"<h1>{html.escape(line[2:].strip())}</h1>")
        elif line.startswith("- ") or line.startswith("* "):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{html.escape(line[2:].strip())}</li>")
        elif not line.strip():
            if in_list:
                out.append("</ul>")
                in_list = False
            out.append("")
        else:
            if in_list:
                out.append("</ul>")
                in_list = False
            out.append(f"<p>{html.escape(line)}</p>")

    if in_list:
        out.append("</ul>")
    if in_code:
        out.append("</code></pre>")

    body = "\n".join(out)
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<title>Cairn Onboarding Guide</title>"
        "<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:780px;"
        "margin:2rem auto;padding:0 1rem;line-height:1.55;color:#222}"
        "h1,h2{border-bottom:1px solid #ddd;padding-bottom:.25rem}"
        "pre{background:#f6f8fa;padding:.75rem;overflow:auto;border-radius:6px}"
        "code{font-family:ui-monospace,Menlo,monospace}</style>"
        f"</head><body>{body}</body></html>"
    )


# ---- Shutdown -----------------------------------------------------------


async def shutdown_session() -> None:
    """Close any live MCP session. Called by ``main.py`` on app shutdown."""
    global _session
    if _session is not None:
        try:
            await _session.mcp_client.aclose()
        except Exception:
            logger.exception("error while closing MCP session on shutdown")
        _session = None
