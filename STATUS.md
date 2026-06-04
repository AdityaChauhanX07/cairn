# Cairn — Audit STATUS

_Read-only audit, 2026-06-04. No code was modified._

## TL;DR

The repo is in good shape structurally and **both backend and frontend install and build cleanly**. The relationship graph, SPL parser, discovery engine, SSE streaming, and Q&A path are all real and reasonably well-built — the "spine" is mostly present in code. **But there are three hard-constraint violations that must be fixed before this is demo-honest against the stated rules:** (1) the LLM is **Groq/Llama, not Claude `claude-sonnet-4-6`**; (2) a **forbidden tool `splunk_run_saved_search`** is wired and actively called; (3) the **default time bound is "all time" (`earliest=0`)**, not `-24h`/`-7d`. None of the smoke tests could be run — there is no Splunk/MCP connection configured.

---

## 1. What exists and what actually runs

| Area | Status |
|---|---|
| Repo structure | ✅ Clean: `backend/` (FastAPI), `frontend/` (React+Vite+TS), `demo-data/`, `docs/`, README, LICENSE. |
| LICENSE | ✅ MIT (`LICENSE:1`). |
| `.gitignore` / secrets | ✅ `.env` ignored (`.gitignore:71`); no `.env` committed; secret scan found **no leaked keys/tokens**. |
| Backend install | ✅ `pip install -r requirements.txt` succeeds (Python 3.13). |
| Backend imports/app load | ✅ `import main` loads the FastAPI app; all modules `py_compile` clean. |
| Frontend install | ✅ `npm install` — 0 vulnerabilities. |
| Frontend build | ✅ `tsc -b && vite build` succeeds (208 kB JS bundle). |
| MCP client | ✅ Present, async, transport-flexible (SSE + streamable_http). |
| Relationship graph + SPL parser | ✅ Implemented and solid (see §5). |
| SSE streaming backend→frontend | ✅ Wired end-to-end. |
| Q&A / "3am alert" path | ✅ Present (`/api/ask`, alert-chain tracing, guide section). |
| Smoke tests against live Splunk | ⚠️ **Not run** — no connection configured (see §6). |

---

## 2. Hard-constraint compliance

### ❌ VIOLATION 1 — LLM is Groq/Llama, not Claude `claude-sonnet-4-6`
The entire reasoning/synthesis layer runs on **Groq-hosted Llama 3.3 70B**, not the Claude API.
- `backend/config.py:42-49` — `groq_api_key`, `groq_model="llama-3.3-70b-versatile"`.
- `backend/agent/orchestrator.py:34` — `from groq import AsyncGroq`; `:142-144` client init; `:182-186` `chat.completions.create(model=groq_model)`.
- `.env.example:9-14` — `GROQ_API_KEY`, `GROQ_MODEL`.
- `backend/requirements.txt:12` — `groq>=0.11.0`; **no `anthropic` SDK present.**
- `README.md:15,59-67,102-104,172` — architecture documents Groq throughout.
- **Impact:** Directly contradicts the constraint "Claude model string should be `claude-sonnet-4-6`." This is the single biggest gap and touches every LLM call site.

### ❌ VIOLATION 2 — Forbidden tool `splunk_run_saved_search` is wired and called
`splunk_run_saved_search` is **not in the 13 official tools** and dispatching a saved search executes it server-side (and can fire alert actions).
- `backend/mcp_client/client.py:105` (`TOOL_RUN_SAVED_SEARCH`), `:121` (in `CORE_TOOLS`), `:495-509` (`run_saved_search()` method, takes `trigger_actions`).
- **Called in the live Q&A path:** `backend/agent/orchestrator.py:668` (`self._mcp.run_saved_search(named_search)`).
- Also `backend/agent/discovery.py:739` (`sample_saved_search`, not on the main explore path) and `backend/smoke_test.py:209-210` (test t11).
- Documented as a used tool in `README.md:89`.
- **Impact:** Violates "Use ONLY the 13 official MCP tools." Note `trigger_actions=False` by default so it's not a *write* in the demo, but it is a non-existent/forbidden tool and a latent action-firing path.

### ❌ VIOLATION 3 — Default time bound is "all time", not `-24h`/`-7d`
- `backend/config.py:61-68` — `default_earliest="0"` ("all time").
- `backend/mcp_client/client.py:490` — `run_query` falls back to `self._default_earliest` (= "0").
- `backend/agent/discovery.py:703` — `_audit` usage query forces `earliest="0"` (should be `-7d`).
- `backend/agent/orchestrator.py:655` — live Q&A SPL forces `earliest="0"`.
- **Impact:** Violates "default earliest=-24h; earliest=-7d for _internal/_audit." There's also **no `_internal`/`_audit`-specific `-7d` branch** anywhere. (The `| head 1000` cap *is* correct — see below.)

### ⚠️ PARTIAL — SSL verification is hardcoded off, not config-driven
- `backend/mcp_client/client.py:45-63` — `_make_insecure_http_client` always sets `verify=False`; `:66-88` wires it unconditionally into the transport.
- **Impact:** TLS verification can be disabled (good for self-signed local Splunk ✅) but it is **always** disabled — there is no config flag to re-enable verification for prod. Constraint asks for this to be "config-driven, not hardcoded for prod." Currently hardcoded *insecure*.

### ✅ CORRECT — `| head 1000` guardrail
- `backend/mcp_client/client.py:156-193` — appends `| head <cap=1000>` when SPL has no `head`/`tail` and no aggregating command. Aggregations correctly left alone. Cap is config-driven (`default_result_cap=1000`).

### ✅ CORRECT — Tool-name correctness (the other 11)
All other wired tool names match the official list: `splunk_get_info/get_indexes/get_index_info/get_metadata/get_knowledge_objects/get_user_list/get_user_info/get_kv_store_collections/run_query` and `saia_explain_spl/ask_splunk_question` (`client.py:96-127`). The two saia tools `generate_spl`/`optimize_spl` are simply unused (acceptable; not needed for the spine).

### ✅ CORRECT — Secrets/config hygiene
Keys come from env via `pydantic-settings` `SecretStr` (`config.py`); nothing committed; `.env` gitignored.

### ⚠️ Timeout / truncation / destructive-rejection handling
No proactive destructive-command rejection; the client relies on the MCP server's own 1-min/1000-event/non-destructive caps and wraps any error in `SplunkMCPError` (`client.py:329-337`), which callers catch and degrade gracefully. Acceptable but reactive, not defensive.

---

## 3. Read-only verification (write/mutation paths)

- **Agent runtime (MCP path): READ-ONLY ✅** — no REST POST/PUT/DELETE that creates/edits Splunk knowledge objects. The only quasi-exception is `run_saved_search` (Violation 2), which *dispatches* a search but does not mutate objects (and `trigger_actions=False`).
- **`| rest` fallback is read-only ✅** — `client.py:438-444` uses `| rest /services/saved/searches ... count=200`, a GET-style read.
- **⚠️ OUT-OF-BAND WRITE PATH — `demo-data/setup_splunk.py`** — this standalone seeding script **does** POST to `/services/data/indexes`, `/services/receivers/simple`, etc. (`setup_splunk.py:562,490,403`) to create indexes/macros/lookups/saved searches. It is **not** part of the agent and **not** MCP — it's dev-only demo prep run manually with a password. Flagging per the constraint's letter ("no code path that writes"), but it is intentional and isolated from the read-only agent.

---

## 4. MCP integration summary

- **Connection:** official `mcp` Python SDK via `ClientSession`. Supports both `streamable_http` (default) and `sse` (`client.py:31-33,245-287`). **Note:** the brief specified SSE transport; the default here is `streamable_http`, though SSE is selectable and `smoke_test.py` tries both.
- **Tool availability probing:** ✅ `_probe_tools` (`client.py:302-319`) detects which tools exist and exposes `has_saia` for fallback routing.
- **saia fallback:** ✅ `explain_spl`/`ask_splunk_question` try the native tool, fall back to the LLM (`orchestrator.py:209-235,629-641`).

---

## 5. The spine — implementation status

| Spine element | Status | Notes |
|---|---|---|
| Orient → Reason → Investigate → **Decide** loop | ⚠️ **Partial** | The flow is **linear, not iterative** — `orchestrator.py:9-19,253-329` runs orient → discover → **one** reason call → enrich → resolve → usage → explain. The decision/loop-back step was **removed** (docstring `:8-13`) to dodge Groq rate limits. README still advertises a full agentic loop. The LLM influences narrative but does **not** drive what gets investigated next. |
| Relationship graph builder | ✅ **Solid** | `graph.py` — typed nodes/edges, placeholder→resolve merge, cycle-safe `trace_chain`. |
| SPL parsing (macro/lookup/index) | ✅ **Solid** | `graph.py:76-135` — backtick `` `macro` ``, `\| lookup`, `inputlookup`/`outputlookup`, `index=`, `sourcetype=`. |
| Dependency-chain tracing (alert→…→index) | ✅ | `orchestrator.py:508-584` builds chains + ASCII trees per alert. |
| Streaming (SSE) backend→frontend | ✅ | `routes.py:189-233` (`EventSourceResponse`), `frontend/src/utils/api.ts:17-115` (robust SSE parser). |
| Q&A / "3am alert" path | ✅ | `/api/ask` (`routes.py:243-254`), graph-grounded answer + optional live SPL; alerts section prompt explicitly answers "what to do at 3am" (`orchestrator.py:740-754`). |

---

## 6. Smoke tests — NOT RUN (nothing configured)

There is no `.env` and no Splunk/MCP endpoint or Groq key available, so I could not run `backend/smoke_test.py`, `integration_test.py`, or `e2e_test.py`. **To run them, provide:**

```
# .env at repo root (copy from .env.example)
SPLUNK_MCP_URL=https://<host>:8089/services/mcp/v1
SPLUNK_TOKEN=<splunk auth token with read access>
GROQ_API_KEY=<groq key>          # (currently Groq — see Violation 1)
```
Then: `python backend/smoke_test.py` (12 checks; auto-tries both transports).
⚠️ Note `smoke_test.py:188-190` calls `get_knowledge_objects(kind="alerts")`, but `discovery.py:998` states the live server rejects `alerts` (it uses `saved_searches`) — t7 will likely fail even on a good connection. t11 exercises the forbidden `run_saved_search`.

---

## 7. Top 5 risks / gaps

1. **Wrong LLM (Groq/Llama, not Claude `claude-sonnet-4-6`).** Pervasive; every reasoning/synthesis/Q&A call. Biggest constraint break.
2. **Forbidden `splunk_run_saved_search` wired and called** in the live Q&A path — both a non-official-tool violation and a latent action-firing path.
3. **Time bounds default to "all time" (`earliest=0`)** with no `-24h`/`-7d` policy — every guarded query is wider than the rules allow and risks slow/timed-out queries in the demo.
4. **Agentic loop is actually a fixed linear pipeline** — README/architecture oversell "the LLM decides what to investigate next." For a "live autonomous exploration" demo this is the credibility risk.
5. **TLS verification hardcoded off** (no prod-safe config toggle) + **untested against a real MCP server** (no smoke run, plus the known `kind="alerts"` mismatch) — integration correctness is unproven on live data.

---

## 8. Prioritized next steps — complete THE SPINE first

> Spine = live autonomous exploration + dependency-chain tracing → "this alert paged me at 3am, what is it and what do I do?" Do these in order; do **not** add new features/modes until the spine runs end-to-end against a real (or demo-seeded) Splunk.

1. **Stand up a runnable target & prove the connection.** Create `.env`; run `demo-data/setup_splunk.py` against a local Splunk; run `smoke_test.py` and fix what breaks (start with the `kind="alerts"` mismatch, `smoke_test.py:188`). _Nothing else matters until connect + `get_indexes` + one guarded `run_query` + one `saia_` call succeed live._
2. **Fix Violation 1 — swap Groq → Claude `claude-sonnet-4-6`.** Replace `AsyncGroq` with the Anthropic SDK behind the single `_llm_call` funnel (`orchestrator.py:170-205`); update `config.py`, `.env.example`, `requirements.txt`, README. (The `claude-api` skill can scaffold this with prompt caching.)
3. **Fix Violation 3 — correct time bounds.** Set `default_earliest=-24h`; add a `-7d` branch for `_internal`/`_audit` queries (`discovery.py:703`, `client.py:465-493`); stop forcing `earliest=0` in the Q&A live path.
4. **Fix Violation 2 — remove `splunk_run_saved_search`.** Drop it from `CORE_TOOLS`/the client and remove the `ask()` dispatch (`orchestrator.py:664-675`); replace any "replay a saved search" need with a guarded `run_query` of the saved search's SPL (already in the graph).
5. **Make the loop actually agentic (or stop claiming it is).** Either reinstate a bounded Decide→Investigate iteration driven by `_reason_about_discovery` output (now affordable on Claude with prompt caching), or update README/architecture to honestly describe the linear flow. For a "live autonomous exploration" track, restoring at least one real decision-driven loop iteration is the higher-value choice.

_Then, and only then:_ make the SSL toggle config-driven, broaden SPL explanations, polish the guide UI.

---

## Overnight fixes applied

_Branch `fix/forbidden-tool-and-time-bounds` (not merged to main). Unsupervised run — scope limited to the two surgical fixes below. LLM provider, agentic loop, SSL, frontend, and demo-data were intentionally left untouched._

### Fix 1 — Removed forbidden tool `splunk_run_saved_search`
- `backend/mcp_client/client.py` — removed the `TOOL_RUN_SAVED_SEARCH` constant, removed it from `CORE_TOOLS`, and deleted the `run_saved_search()` method.
- `backend/agent/orchestrator.py` — the live Q&A path no longer dispatches a saved search. It now replays the saved search's **own SPL** (read from the graph node's `properties["spl"]`) through the existing guarded `run_query`; if no SPL is captured it degrades gracefully with a logged message + `# TODO` (no fabricated SPL). Added `_saved_search_spl()` helper. Updated the `ask()` docstring.
- `backend/agent/discovery.py` — `sample_saved_search()` (off the main path) rerouted to replay the node's SPL via guarded `run_query`, with graceful degradation when no SPL exists.
- `backend/smoke_test.py` — removed test t11 (it exercised the forbidden tool); renamed `t12_user_list`→`t11_user_list`, updated the TESTS table and the "twelve checks"→"eleven checks" docstring. Display numbering is via `enumerate`, so it stays consistent.
- `README.md` — removed the `splunk_run_saved_search` row from the tool table (no other README claims touched).
- **Verification:** `grep -rn "run_saved_search\|RUN_SAVED_SEARCH"` across `*.py/*.md/*.ts` → **zero references in code** (remaining hits are only in this STATUS.md audit narrative above).

### Fix 2 — Corrected time bounds (was "all time" / `earliest=0`)
- `backend/config.py` — `default_earliest` changed `"0"` → `"-24h"` (description updated).
- `backend/mcp_client/client.py` — constructor `default_earliest` literal default changed `"0"` → `"-24h"` (used by `smoke_test.py`, which constructs the client without settings). `run_query` already falls back to `self._default_earliest`; docstring already said `-24h`.
- `backend/agent/discovery.py` — the `_audit` usage query now uses `earliest="-7d"` (was forced `"0"`).
- `backend/agent/orchestrator.py` — the live Q&A SPL no longer forces `earliest="0"`; it uses the client default (`-24h`).
- **Intentionally left:** `client.py` `get_all_saved_searches()` still passes `earliest="0"` to its `| rest /services/saved/searches …` call. `| rest` is a generating command that does not search event time, so the bound is inert there; it was also outside the stated scope.

### Validation (all terminate, all passed)
- `python -m py_compile` on all changed backend files → OK.
- `import main` loads the FastAPI app (`app.title == "Cairn"`) → OK.
- `get_settings().default_earliest == "-24h"` → confirmed.
- `npm run build` (frontend) → still succeeds (unchanged).
- No live Splunk connection used (not required for these fixes).

## Needs you awake (NOT done this run)
1. **Live integration:** stand up Splunk, create `.env` (`SPLUNK_MCP_URL`, `SPLUNK_TOKEN`, `GROQ_API_KEY`), seed via `demo-data/setup_splunk.py`, and run `backend/smoke_test.py` against the live/seeded server. Also fix the known `get_knowledge_objects(kind="alerts")` mismatch in `smoke_test.py` (the live server uses `saved_searches`).
2. **Agentic loop + LLM:** decide whether to reinstate the Decide→Investigate iteration (currently a linear pipeline) and how to handle Groq rate limits. LLM provider stays Groq for now per your instruction — revisit only in a supervised session.
3. **README honesty pass:** reconcile the README/architecture "the LLM decides what to investigate next" claim with the actual linear flow.
