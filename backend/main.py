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
    logger.info("Cairn starting on %s:%d (model=%s)", settings.host, settings.port, settings.claude_model)
    try:
        yield
    finally:
        logger.info("Cairn shutting down — closing MCP session")
        await shutdown_session()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Cairn",
        description=(
            "AI-powered Splunk onboarding agent. "
            "Connects to a Splunk MCP server, explores the environment, and "
            "produces a human-readable onboarding guide."
        ),
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
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
    import uvicorn

    s = get_settings()
    uvicorn.run("main:app", host=s.host, port=s.port, reload=True)
