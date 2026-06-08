"""FastAPI entry point for Cairn."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import router as api_router
from api.routes import shutdown_session
from config import configure_logging, get_settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings)
    logger.info("Cairn starting on %s:%d (model=%s)", settings.host, settings.port, settings.groq_model)
    try:
        yield
    finally:
        logger.info("Cairn shutting down — closing MCP session")
        await shutdown_session()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Cairn",
        description=(
            "AI-powered Splunk onboarding agent. "
            "Connects to a Splunk MCP server, explores the environment, and "
            "produces a human-readable onboarding guide."
        ),
        version="0.1.0",
        lifespan=lifespan,
        # Don't 307-redirect /api/connect <-> /api/connect/. A redirect on the
        # CORS preflight (OPTIONS) is rejected by the browser ("Redirect is not
        # allowed for a preflight request"), so we match paths exactly instead.
        redirect_slashes=False,
    )

    # CORS first, so the preflight is answered here and never falls through to
    # routing. allow_origins=["*"] accepts any origin — the deployed frontend's
    # domain (e.g. the Vercel URL) isn't known at build time. Credentials are
    # disabled on purpose: the browser forbids "*" together with
    # Access-Control-Allow-Credentials, and the frontend authenticates with a
    # token in the request body rather than cookies, so credentialed CORS isn't
    # needed. Restrict allow_origins to specific domains if that ever changes.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_router)

    @app.get("/")
    async def root() -> dict[str, str]:
        return {
            "name": "Cairn",
            "tagline": "An AI agent that explores your Splunk environment and marks the path for newcomers.",
            "docs": "/docs",
            "api": "/api",
        }

    return app


app = create_app()


if __name__ == "__main__":
    import os

    import uvicorn

    # Bind 0.0.0.0 and honor $PORT so `python main.py` works on hosts like Render
    # (which injects PORT). Locally, PORT is usually unset and we fall back to the
    # configured settings port (default 8000).
    s = get_settings()
    port = int(os.environ.get("PORT", s.port))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
