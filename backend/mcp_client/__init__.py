"""Splunk MCP client package.

Wraps the Model Context Protocol client connection to the Splunk MCP server
and exposes a typed API for each of the 12 tools Cairn uses.
"""

from .client import SplunkMCPClient, SplunkMCPError, ToolAvailability

__all__ = ["SplunkMCPClient", "SplunkMCPError", "ToolAvailability"]
