"""REST + SSE endpoints for Cairn.

There is one orchestrator per process — Cairn is a single-tenant dev tool,
not a multi-user SaaS, so the simplest correct concurrency model is a
single ``Orchestrator`` instance. The orchestrator owns its own
``asyncio.Lock`` for explore / generate_guide; routes don't add another.

Endpoints (call order: connect → explore → generate → guide/ask/export):

- ``POST /api/connect``    — connect to a Splunk MCP server
- ``GET  /api/explore``    — SSE: stream agent events from the discovery flow
- ``GET  /api/generate``   — SSE: stream events as the onboarding guide is written
- ``GET  /api/guide``      — fetch the generated guide as JSON
- ``GET  /api/graph``      — fetch the current relationship graph (for the viz)
- ``POST /api/ask``        — follow-up Q&A (optionally runs live SPL)
- ``GET  /api/export``     — export the guide (markdown | html)
- ``GET  /api/health``     — liveness probe
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
    has_explored: bool = False


_session: _Session | None = None
_session_lock = asyncio.Lock()


def _current_session(
    *,
    require_explored: bool = False,
    require_guide: bool = False,
    require_starter_kit: bool = False,
    require_findings: bool = False,
) -> _Session:
    """Return the live session, validating prerequisite state.

    Raises 400 with a precise next-step message if the caller is out of order.
    """
    if _session is None:
        raise HTTPException(
            status_code=400,
            detail="not connected — POST /api/connect first",
        )
    if require_explored and not _session.has_explored:
        raise HTTPException(
            status_code=400,
            detail="no exploration data yet — open GET /api/explore (SSE) first",
        )
    if require_guide and _session.orchestrator.guide is None:
        raise HTTPException(
            status_code=400,
            detail="no guide generated yet — open GET /api/generate (SSE) first",
        )
    if require_starter_kit and _session.orchestrator.starter_kit is None:
        raise HTTPException(
            status_code=400,
            detail="no starter kit yet — open GET /api/starter-kit (SSE) first",
        )
    if require_findings and _session.orchestrator.findings is None:
        raise HTTPException(
            status_code=400,
            detail="no findings yet — open GET /api/findings (SSE) first",
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


class LiveQuery(BaseModel):
    type: str
    query: str | None = None
    name: str | None = None


class AskResponse(BaseModel):
    answer: str
    live_queries: list[LiveQuery] = Field(default_factory=list)


# ---- Endpoints -----------------------------------------------------------


@router.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "connected": _session is not None,
        "has_explored": _session is not None and _session.has_explored,
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
    """Stream agent exploration events as Server-Sent Events.

    Each event has the JSON-encoded ``AgentEvent`` as its ``data`` field. The
    ``event`` field is the phase name, so frontends can use ``EventSource``
    typed listeners (e.g. ``source.addEventListener('investigate', ...)``).

    Only runs the exploration pipeline — guide generation is a separate call
    to ``GET /api/generate``.
    """
    session = _current_session()

    async def event_stream() -> AsyncIterator[dict[str, Any]]:
        async for event in session.orchestrator.explore():
            yield {
                "event": event.phase.value,
                "data": json.dumps(event.to_dict()),
            }
        # Mark explored only after the stream completes successfully — if the
        # client drops mid-stream we'd rather they re-run than have stale state.
        session.has_explored = True

    return EventSourceResponse(event_stream())


@router.get("/generate")
async def generate() -> EventSourceResponse:
    """Stream guide-generation events as Server-Sent Events.

    Runs ``Orchestrator.generate_guide()`` — one Groq call per section, five
    sections total. Each event's ``event`` field is the phase name; ``data``
    is the serialized ``AgentEvent``. When the stream closes, the guide is
    available via ``GET /api/guide``.
    """
    session = _current_session(require_explored=True)

    async def event_stream() -> AsyncIterator[dict[str, Any]]:
        async for event in session.orchestrator.generate_guide():
            yield {
                "event": event.phase.value,
                "data": json.dumps(event.to_dict()),
            }

    return EventSourceResponse(event_stream())


@router.get("/guide")
async def get_guide() -> dict[str, Any]:
    """Return the synthesized onboarding guide as JSON."""
    session = _current_session(require_guide=True)
    return session.orchestrator.guide.to_dict()  # type: ignore[union-attr]


@router.get("/graph")
async def get_graph() -> dict[str, Any]:
    """Return the current relationship graph (trimmed for visualization).

    Available as soon as a session exists; before exploration runs it simply
    returns empty node / edge lists. The frontend uses this for the static
    graph in the guide view (the live explore view builds its graph from the
    SSE event stream instead).
    """
    session = _current_session()
    return session.orchestrator.graph.relationship_view()


@router.get("/starter-kit")
async def starter_kit_stream() -> EventSourceResponse:
    """Stream Mode C starter-kit generation as Server-Sent Events.

    Runs ``Orchestrator.generate_starter_kit()`` — generates common-task SPL,
    per-alert runbooks, and a dashboard skeleton. Each event's ``event`` field
    is the phase name; ``data`` is the serialized ``AgentEvent``. When the
    stream closes, the kit is available via ``GET /api/starter-kit/data``.
    """
    session = _current_session(require_explored=True)

    async def event_stream() -> AsyncIterator[dict[str, Any]]:
        async for event in session.orchestrator.generate_starter_kit():
            yield {
                "event": event.phase.value,
                "data": json.dumps(event.to_dict()),
            }

    return EventSourceResponse(event_stream())


@router.get("/starter-kit/data")
async def get_starter_kit() -> dict[str, Any]:
    """Return the generated starter kit as JSON."""
    session = _current_session(require_explored=True, require_starter_kit=True)
    return session.orchestrator.starter_kit.to_dict()  # type: ignore[union-attr]


@router.get("/starter-kit/dashboard-xml")
async def get_starter_kit_dashboard_xml() -> Response:
    """Return the generated dashboard as raw Splunk Simple XML for download."""
    session = _current_session(require_explored=True, require_starter_kit=True)
    kit = session.orchestrator.starter_kit
    assert kit is not None  # require_starter_kit check above guarantees this
    return PlainTextResponse(
        kit.dashboard_xml,
        media_type="application/xml; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="cairn-starter-dashboard.xml"'},
    )


@router.get("/findings")
async def findings_stream() -> EventSourceResponse:
    """Stream Mode B hygiene-findings generation as Server-Sent Events.

    Runs ``Orchestrator.generate_findings()`` — orphaned objects, alerts on
    empty indexes, alerts with no action / no owner, each with a remediation.
    Each event's ``event`` field is the phase name; ``data`` is the serialized
    ``AgentEvent``. When the stream closes, findings are available via
    ``GET /api/findings/data``.
    """
    session = _current_session(require_explored=True)

    async def event_stream() -> AsyncIterator[dict[str, Any]]:
        async for event in session.orchestrator.generate_findings():
            yield {
                "event": event.phase.value,
                "data": json.dumps(event.to_dict()),
            }

    return EventSourceResponse(event_stream())


@router.get("/findings/data")
async def get_findings() -> dict[str, Any]:
    """Return the generated Mode B findings report as JSON."""
    session = _current_session(require_explored=True, require_findings=True)
    return session.orchestrator.findings.to_dict()  # type: ignore[union-attr]


@router.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest) -> AskResponse:
    """Free-form follow-up Q&A grounded in the discovered graph.

    Requires a prior ``/api/explore`` for graph context. The orchestrator's
    ``ask`` will also run live SPL / dispatch a named saved search when the
    question implies fresh data — those MCP calls happen inline and fall back
    to context-only on failure.
    """
    session = _current_session(require_explored=True)
    result = await session.orchestrator.ask(req.question)
    return AskResponse(
        answer=result["answer"],
        live_queries=result.get("live_queries", []),
    )


@router.get("/export")
async def export_guide(
    format: str = Query("markdown", pattern="^(markdown|html)$"),
) -> Response:
    """Export the guide as markdown or a minimal HTML document."""
    session = _current_session(require_guide=True)
    guide = session.orchestrator.guide
    assert guide is not None  # require_guide check above guarantees this

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
