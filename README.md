# cairn.

An AI agent that maps, documents, and cleans up any Splunk environment. Built for the [Splunk Agentic Ops Hackathon 2026](https://splunk.devpost.com/) (Platform & Developer Experience track).

Point it at a Splunk instance. It explores the environment like a senior engineer would, traces every dependency chain, flags what's broken, and builds you a starter kit. A week of tribal knowledge transfer in ten minutes.

---

## What it does

Cairn connects to a Splunk deployment through the official MCP Server and runs three modes from a single exploration pass:

**Mode A: Explain.** Traces dependency chains (alert -> saved search -> macro -> lookup -> index), explains every SPL query in plain English, and generates a six-section onboarding guide organized by workflows. Includes an AI & ML Footprint section that surfaces the MLTK toolkit and any trained models.

**Mode B: Flag.** The same relationship graph that powers explanation reveals environment hygiene issues for free. Cairn detects orphaned macros and lookups (zero incoming references), alerts pointed at empty indexes, alerts with no action configured, and generates a ready-to-apply fix for each finding. It advises; you apply. Nothing is mutated.

**Mode C: Build.** After understanding the environment, Cairn generates a tailored starter kit: SPL queries for common tasks (via `saia_generate_spl` with LLM fallback), per-alert runbooks with first-check steps, and an importable Splunk dashboard skeleton in Simple XML.

All three modes are downstream of one agentic exploration loop with visible reasoning. The agent decides what to investigate based on what it finds. It is not a pipeline.

---

## The reasoning loop

```
Orient        What indexes, apps, users exist?
    |
Reason        LLM: "auth_events has 3 alerts and high volume. Investigate."
    |
Investigate   Pull saved searches, alerts, macros, lookups, dashboards.
              Follow dependency chains. Explain SPL.
    |
Decide        Unresolved references? Loop back. Otherwise synthesize.
    |
Synthesize    Generate guide (A), findings (B), starter kit (C).
```

The relationship graph is the core data structure. Cairn parses every SPL string it encounters, extracts macro references (`` `macro_name` ``), lookup references (`| lookup ...`), and index references (`index=...`), and builds typed edges. Orphan detection is a graph property: any node with zero incoming edges is dead weight.

---

## MCP tools used

Cairn exercises **14 tools** across both MCP namespaces. Each `saia_` tool is attempted first with an LLM fallback when the AI Assistant app is unavailable.

### splunk_ (10 tools)

| Tool | What Cairn does with it |
|------|------------------------|
| `splunk_get_info` | Confirm connection, capture version and system info |
| `splunk_get_indexes` | Map the data landscape |
| `splunk_get_index_info` | Per-index event count, size, retention (drives empty-index detection) |
| `splunk_get_metadata` | Sourcetype distribution per index |
| `splunk_get_knowledge_objects` | Saved searches, alerts, macros, lookups, dashboards, field extractions, apps, mltk_models, mltk_algorithms |
| `splunk_get_user_list` | Team structure and roles |
| `splunk_get_user_info` | Current user permissions |
| `splunk_get_kv_store_collections` | KV Store usage |
| `splunk_run_query` | Live SPL during Q&A (guardrailed: `| head 1000`, 1-min cap, non-destructive only) |
| `splunk_run_saved_search` | Execute an existing saved search to pull current rows during Q&A |

### saia_ (4 tools)

| Tool | What Cairn does with it |
|------|------------------------|
| `saia_explain_spl` | Plain-English explanation of saved search and alert SPL |
| `saia_generate_spl` | Generate starter queries and remediation SPL for findings |
| `saia_optimize_spl` | Suggest faster versions of alert SPL (populates fix_spl on findings) |
| `saia_ask_splunk_question` | Answer Splunk-concept questions during Q&A |

---

## Architecture

```
Frontend (React + Vite)
        |
        | SSE (streaming reasoning) + REST
        v
Backend (Python + FastAPI)
   |-- Agent Orchestrator
   |     |-- Reasoning Loop
   |     |-- Relationship Graph Builder + SPL Parser
   |     |-- Mode A Synthesizer (guide)
   |     |-- Mode B Findings Engine (orphans, empty-index, no-action)
   |     +-- Mode C Starter Kit Generator (SPL, runbooks, dashboard XML)
   |
   |-- Groq API (llama-3.3-70b-versatile)
   |     reasoning, synthesis, SPL generation
   |
   +-- MCP Client (read-only)
         |
         v
   Splunk Enterprise
   +-- MCP Server app (splunk_ tools)
   +-- AI Assistant for SPL (saia_ tools, optional)
   +-- AI Toolkit / MLTK (mltk_models, mltk_algorithms)
```

Data flow is strictly read-only. Cairn reads via MCP, reasons with the LLM, and emits generated artifacts to the user. It never writes to Splunk.

Full architecture diagram: [`architecture_diagram.png`](architecture_diagram.png)

---

## How it fits together (read this first)

Cairn is **three separate pieces**. Knowing who talks to whom saves a lot of confusion:

```
  Browser  ──────►  Frontend (React/Vite)  ──────►  Backend (FastAPI)  ──────►  Splunk MCP Server
   :5173            static UI, no secrets           does the real work          :8089 (your data)
                                                    holds the LLM key
```

1. **Frontend** is just the UI. It holds no secrets and never talks to Splunk directly. It calls the backend at the address in `VITE_API_URL`.
2. **Backend** is the brain. It connects to Splunk over MCP, runs the LLM, and streams reasoning back. The Splunk URL + token you type into the connect form are sent here, and **the backend** opens the connection.
3. **Splunk** runs the MCP Server app and exposes it on the management port (`:8089`).

> **The #1 gotcha: `localhost` is relative to the backend, not your browser.**
> When you type `https://localhost:8089/...` into the connect form, *the backend* resolves it. If the backend runs on your laptop next to Splunk, that's correct. If the backend is hosted in the cloud (e.g. Render/Vercel), `localhost` means *that cloud server* — it can never reach the Splunk on your machine. **To demo against a local Splunk, run the backend locally too** (or expose Splunk with a tunnel like `cloudflared`/`ngrok` and paste the public URL into the form).

### Ports at a glance

| Service          | Port   | Notes                                              |
|------------------|--------|----------------------------------------------------|
| Splunk Web       | `8000` | Taken by Splunk — **don't** run the backend here   |
| Splunk mgmt/MCP  | `8089` | What the connect form points at                    |
| Backend          | `8001` | Dev frontend expects it here (`.env.development`)   |
| Frontend (Vite)  | `5173` | Open this in the browser                            |

---

## Setup

### Prerequisites

- Python 3.11+
- Node.js 18+
- Splunk Enterprise (free trial with Developer License works)
- Splunk MCP Server app installed from Splunkbase
- A Splunk auth token with read access and `mcp_tool_execute` capability
- Groq API key (free at https://console.groq.com/keys)

### 1. Clone

```bash
git clone https://github.com/AdityaChauhanX07/cairn.git
cd cairn
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:
```
SPLUNK_MCP_URL=https://localhost:8089/services/mcp
SPLUNK_TOKEN=your-splunk-auth-token
GROQ_API_KEY=your-groq-api-key
GROQ_MODEL=llama-3.3-70b-versatile
```

> The MCP Server app rejects tokens whose JWT `audience` claim isn't `mcp`.
> Create one with: `Settings > Tokens > New Token` and set **Audience** to `mcp`
> (or via REST: `... /services/authorization/tokens -d name=admin -d audience=mcp`).

### 3. Backend (run on port 8001)

```bash
cd backend
python -m venv venv

# Windows
venv\Scripts\activate
# macOS / Linux
source venv/bin/activate

pip install -r requirements.txt

# Run on 8001 — 8000 is taken by Splunk Web, and the dev frontend expects 8001.
uvicorn main:app --port 8001
```

Backend is now at `http://localhost:8001`. Sanity check: `curl http://localhost:8001/api/health` returns `200`.

> `python main.py` would bind `8000` (the default), which collides with Splunk Web.
> Either run `uvicorn main:app --port 8001` as above, or add `PORT=8001` to your `.env`.

### 4. Frontend (port 5173)

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. In dev it reads `frontend/.env.development` and talks to the backend on `:8001` automatically.

> After pulling new changes, **always re-run `npm install`** — new dependencies
> (e.g. `three` for the landing animation) won't be in your `node_modules`
> otherwise, and Vite will throw `Failed to resolve import "three"`.

### 5. Load demo data (optional)

If you want to see Cairn work against a realistic environment with planted hygiene issues:

```bash
python demo-data/setup_splunk.py --password YOUR_SPLUNK_PASSWORD --username YOUR_SPLUNK_USERNAME
```

Then manually upload two lookup CSVs from `demo-data/` via Settings > Lookups > Lookup table files. Details in [`demo-data/SETUP.md`](demo-data/SETUP.md).

### 6. Splunk configuration

1. Install the MCP Server app from Splunkbase
2. Create an auth token: Settings > Tokens > New Token (set **Audience** to `mcp`)
3. Add `mcp_tool_execute` capability to your role
4. (Optional) Install AI Assistant for SPL to enable `saia_` tools
5. (Optional) Install Splunk AI Toolkit for MLTK surfacing

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| **"Load failed"** on the connect screen | Frontend can't reach the backend, or the backend can't reach Splunk | Confirm the backend is up (`curl localhost:8001/api/health` → `200`) and that you opened `localhost:5173`, not a cloud-hosted frontend |
| Connect works for someone else but **not with your Splunk** on a hosted site | The hosted backend resolves `localhost` as *itself*, not your machine | Run the backend locally, or tunnel your Splunk and paste the public URL into the form (see "How it fits together") |
| `Failed to resolve import "three"` | Dependencies out of date after a `git pull` | `cd frontend && npm install`, then restart `npm run dev` |
| Backend won't start / port in use | `8000`/`8001` already bound (often Splunk Web on 8000) | Run the backend on `8001`; free a stuck port with `lsof -ti:8001 \| xargs kill -9` |
| `Invalid token audience` (HTTP 403) | Token's JWT `audience` isn't `mcp` | Recreate the token with **Audience = `mcp`** |
| `connected: false` / TLS errors | Wrong MCP URL or unreachable Splunk | Verify `https://<host>:8089/services/mcp` returns `405` on a `GET` (405 = alive) |

> **macOS + local Docker Splunk shortcut:** there's a personal `./run.sh` helper that
> brings up the Splunk container, backend, and frontend together. It's gitignored —
> copy it as a starting point if you run Splunk in Docker locally.

---

## How AI is used

Cairn uses a Groq-hosted LLM (Llama 3.3 70B) at three levels:

1. **Agentic reasoning.** The LLM decides what to investigate next. After each discovery round it receives a structured summary of what has been found and returns a prioritized analysis. This is not a fixed script.

2. **SPL understanding.** Every SPL query the agent encounters is explained in plain English. Cairn tries `saia_explain_spl` first (Splunk's own AI). When that is unavailable, the LLM explains the query directly, grounded in the discovered environment context.

3. **Generation.** The LLM synthesizes the onboarding guide, generates starter SPL queries, writes per-alert runbooks, and produces remediation suggestions for hygiene findings. Each call is rate-limited and capped at specific token budgets to stay within Groq's free tier.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | React, Vite, TypeScript |
| Backend | Python, FastAPI, SSE streaming |
| LLM | Groq API (llama-3.3-70b-versatile) |
| MCP Client | mcp Python SDK (streamable HTTP transport) |
| Splunk | Enterprise 10.4.0 (free trial + Developer License) |
| MCP Server | Splunkbase app (token auth + mcp_tool_execute) |

---

## Project structure

```
cairn/
  backend/
    main.py                  FastAPI entry point
    config.py                Environment config
    mcp_client/
      client.py              MCP connection + all 13 tool wrappers
    agent/
      orchestrator.py        Reasoning loop, guide/findings/starter-kit generation, Q&A
      discovery.py           Agentic exploration engine
      graph.py               Relationship graph + SPL parser
      findings.py            Mode B finding types
      starter_kit.py         Mode C data structures
    api/
      routes.py              REST + SSE endpoints
  frontend/
    .env.development         Dev backend origin (VITE_API_URL=:8001)
    .env.production          Prod backend origin (set in Vercel project settings)
    src/
      components/
        LandingPage.tsx      Animated intro / hero screen
        Constellation.tsx    three.js background animation
        ConnectForm.tsx      Connection screen
        ExploreView.tsx      Live reasoning feed + discovery dashboard
        GuideView.tsx        Three-pane guide + findings + starter kit
        ChatView.tsx         Q&A chat panel
        RelationshipGraph.tsx Interactive dependency graph (SVG)
        FindingsView.tsx     Mode B findings panel
        StarterKitView.tsx   Mode C starter kit view
        IndexTiles.tsx       Data landscape visualization
        CairnMark.tsx        Stacking stone progress indicator
        Primitives.tsx       Shared UI primitives
        Skeleton.tsx         Loading placeholders
      context/
        CairnContext.tsx     Shared app state (connection, env, results)
      utils/
        api.ts               API client (connect, SSE streams, exports)
        env.ts               Splunk deployment identity helpers
        guide.ts             Guide data helpers
        markdown.ts          Markdown renderer
  demo-data/
    setup_splunk.py          Automated Splunk object creation
    SETUP.md                 Manual setup guide
    known_bad_ips.csv        Demo lookup
    service_owners.csv       Demo lookup
  docs/
    architecture.png         Architecture diagram
```

---

## Demo

[Watch the demo video](https://youtu.be/1XHlmRybZS4)

---

## License

[MIT](LICENSE)