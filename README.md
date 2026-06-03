# Cairn

> *An AI agent that explores your Splunk environment and marks the path for newcomers.*

Cairn is an AI-powered Splunk onboarding agent built for the **Splunk Agentic Ops Hackathon 2026** (Platform & Developer Experience track). It connects to a Splunk deployment via the official Splunk MCP server, agentically explores the environment — indexes, saved searches, alerts, macros, lookups, dashboards, audit usage — and produces a human-readable onboarding guide that traces the *why* behind every artifact.

## The Problem

When a new engineer joins a team that runs on Splunk, they inherit a Splunk environment that has accreted over years. Hundreds of saved searches reference macros that reference lookups that reference indexes that may or may not still be populated. The institutional knowledge — *"this alert fires when an attacker hits us from a known-bad IP, and the SPL filter for that lives in `high_severity_filter`"* — lives in the heads of two senior engineers who are too busy to write it down.

Cairn writes it down. By tracing dependency chains and reading real audit usage instead of guessing from metadata, it produces a guide that reads like a senior engineer walking the newcomer through the deployment.

## How It Works

Cairn is **agentic, not pipelined.** Claude is in the loop at every step, deciding what to investigate next based on what it has already discovered.

```
+-------------------+
|   Orient          |   What indexes / apps / users exist?
+---------+---------+
          |
+---------v---------+
|   Reason          |   Claude: "what looks worth investigating?"
+---------+---------+
          |
+---------v---------+
|   Investigate     |   Pull saved searches, alerts, dashboards, macros,
|                   |   lookups. Follow dependency chains.
+---------+---------+
          |
+---------v---------+
|   Decide          |   Unresolved refs? Loop back. Otherwise synthesize.
+---------+---------+
          |
+---------v---------+
|   Synthesize      |   Generate the onboarding guide.
+-------------------+
```

The **relationship graph** is the core data structure. Cairn parses every SPL string it sees, extracts macro / lookup / index references, and builds an edge for each. The result is a navigable graph of how the environment actually fits together — the thing a senior engineer holds in their head.

## Features

- **Agentic exploration loop** — Claude orchestrates discovery; no fixed pipeline.
- **Relationship graph** — Traces chains: `alert → saved search → SPL → macro → lookup → index`.
- **SPL parser** — Extracts macro references (`` `macro_name` ``), lookup references (`| lookup ...`), and index references (`index=...`).
- **Audit-driven importance** — Uses `_audit` and `_internal` to see what's *actually* run, not what merely *exists*.
- **SPL explanations via `saia_explain_spl`** — Falls back to Claude when AI Assistant for SPL isn't installed.
- **Streamed exploration UI** — SSE events let the frontend show the agent's reasoning live.
- **Onboarding guide** — Markdown / HTML export, structured into the five sections a new engineer actually needs.
- **Follow-up Q&A** — Ask questions about the environment after the initial exploration completes.

## Architecture

```
+---------------+         +----------------+         +-----------------+
|   Frontend    |  SSE +  |  FastAPI       |   MCP   |  Splunk MCP     |
|   (React)     | <-----> |  backend       | <-----> |  server (12     |
|               |  REST   |  + Claude      |  JSON   |  tools)         |
+---------------+         +----------------+         +-----------------+
                                 |
                                 v
                          +--------------+
                          | Anthropic API|
                          | (claude-     |
                          |  sonnet-4-6) |
                          +--------------+
```

A full diagram lives in [`docs/architecture.png`](docs/) (placeholder — to be added).

## MCP Tools Used

Cairn uses **12 tools** across two namespaces exposed by the Splunk MCP server.

### `splunk_*` (core, always available)

| Tool | Purpose in Cairn |
|---|---|
| `splunk_get_info` | Confirm connection, capture deployment version. |
| `splunk_get_indexes` | Enumerate every index — the data landscape. |
| `splunk_get_index_info` | Per-index metadata: size, event count, retention. |
| `splunk_get_metadata` | Source / sourcetype / host distribution for an index. |
| `splunk_get_knowledge_objects` | Saved searches, alerts, dashboards, macros, lookups, eventtypes. |
| `splunk_get_user_list` | Who has access. |
| `splunk_get_user_info` | Roles and capabilities per user. |
| `splunk_get_kv_store_collections` | App-state collections that often back custom apps. |
| `splunk_run_query` | Ad-hoc SPL — guard-railed with `\| head 1000` and `earliest=-24h`. |
| `splunk_run_saved_search` | Replay a saved search to see what it actually returns. |

### `saia_*` (AI Assistant for SPL — optional)

| Tool | Purpose in Cairn |
|---|---|
| `saia_explain_spl` | Natural-language explanation of a SPL string. |
| `saia_ask_splunk_question` | General Splunk-domain Q&A fallback. |

If `saia_*` tools are unavailable on the connected deployment, Cairn detects this on connect and routes SPL explanation through Claude directly.

## Tech Stack

- **Backend:** Python 3.11+, FastAPI, Anthropic SDK, MCP Python SDK
- **Frontend:** React + Vite + TypeScript (scaffold lives in `frontend/`, planned)
- **AI:** Anthropic Claude (`claude-sonnet-4-6` by default)
- **Protocol:** Model Context Protocol over HTTPS to the Splunk MCP server

## Setup

### Prerequisites

- Python 3.11 or newer
- Node.js 20 or newer (for the frontend, when added)
- A reachable Splunk Enterprise / Cloud instance with the MCP server enabled
- A Splunk auth token with read access to the relevant indexes and knowledge objects
- An Anthropic API key

### 1. Clone

```bash
git clone https://github.com/<your-org>/cairn.git
cd cairn
```

### 2. Backend

```bash
cd backend
python -m venv .venv

# macOS / Linux
source .venv/bin/activate
# Windows (PowerShell)
.venv\Scripts\Activate.ps1

pip install -r requirements.txt
```

### 3. Configure

```bash
cp ../.env.example ../.env
# then edit ../.env and fill in:
#   SPLUNK_MCP_URL
#   SPLUNK_TOKEN
#   ANTHROPIC_API_KEY
```

### 4. (Optional) Load demo data

If you don't have a Splunk environment with realistic content to point Cairn at, follow [`demo-data/SETUP.md`](demo-data/SETUP.md). It walks through creating the indexes, lookups, macros, saved searches, alerts, and dashboards that make the demo dependency chain (`alert → high_severity_filter → known_bad_ips.csv`) visible.

### 5. Run

From `backend/`, with the venv activated:

```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

The API is now live at `http://127.0.0.1:8000`. Swagger docs at `/docs`.

### 6. Frontend (when scaffolded)

```bash
cd frontend
npm install
npm run dev
```

## How AI Is Used

Cairn uses Claude at three distinct levels of abstraction:

1. **Agentic reasoning loop** — Claude decides *what to investigate next*. After each round of discovery it gets a structured summary of what's been found so far and returns a prioritized list of follow-ups (e.g. *"three alerts reference an unknown macro — pull that macro before synthesizing"*).
2. **SPL understanding** — For every SPL string the agent encounters, it requests a natural-language explanation via `saia_explain_spl` when available, falling back to Claude with a tight, schema-aware prompt when not.
3. **Guide synthesis** — Once the relationship graph is complete, Claude is handed the full structured graph (alerts, their chains, ownership signals, usage data) and asked to produce a guide that reads like a senior engineer's walkthrough — not a metadata dump.

## License

[MIT](LICENSE).

## Hackathon

Built for the **Splunk Agentic Ops Hackathon 2026** — Platform & Developer Experience track.
