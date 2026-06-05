# Splunk Environment Intelligence Agent — Project Plan (v4)

**Hackathon:** Splunk Agentic Ops Hackathon
**Track:** Platform & Developer Experience
**Bonus prizes targeted:** Best Use of Splunk MCP Server, Best Use of Splunk Developer Tools
**Deadline:** June 15, 2026 @ 11:00am CDT
**Working window:** ~11 days (June 4 → June 14, submit morning of June 15)
**Team size:** 2 people

**One-line positioning:**
> An agent that **maps, documents, and cleans up any Splunk environment** — and turns a brand-new engineer into a productive one in an hour instead of weeks. It reasons, explains, flags problems, and builds you a starter kit.

---

## What's New in v4

Small, deliberate deltas on top of v3. No new feature surface beyond these — see "Scope Freeze" below.

1. **MLTK / AI footprint surfacing (added).** The agent now surfaces the Machine Learning Toolkit models and algorithms deployed in the environment via `splunk_get_knowledge_objects(type=mltk_models / mltk_algorithms)`. This is read-only, uses a tool already in our list, and signals that we understand the *full* Splunk AI stack — at near-zero cost.
2. **Flag → Fix bridge made explicit.** Each Mode B finding now carries a ready-to-apply generated remediation from Mode C (e.g. a noisy alert comes with its tuned SPL). This gives the project an "actor" feel **without mutating Splunk state** — the agent advises and generates the exact fix; the human applies it.
3. **REST write-back formally rejected and locked.** Live write-back to Splunk via REST is an explicit non-goal (rationale recorded below). The "actor" feeling comes from the advisory layer + the live reasoning stream, not from mutation.
4. **Scope freeze + polish priorities elevated.** The single biggest risk at this stage is adding features instead of polishing the core. v4 makes "where every remaining hour goes" explicit and prominent.

---

## Locked Design Decisions (from the v2 → v3 redesign, still in force)

- **Onboarding is the memorable "face," not the whole product.** The headline demo is the newcomer story (an uncontested lane — the crowd is building SOC copilots in Security/Observability). The value story is "every team, every day": documenting and cleaning any inherited, messy Splunk.
- **Three modes — Explain → Flag → Build — all downstream of one relationship graph.** This lifts the weakest judging axis (Potential Impact) and strengthens the "agentic" claim, because the agent produces findings and assets, not just a document.
- **Verified, corrected tool list.** 9 `splunk_` + 4 `saia_` = 13 official MCP tools. `splunk_run_saved_search` is **not** claimed (not in the official tool list). The two real, previously-unused AI Assistant tools `saia_generate_spl` and `saia_optimize_spl` are in.
- **Version & environment honesty.** On the free **Enterprise on-prem** trial the MCP Server is effectively **v1.0** (v1.1 is the Splunk **Cloud** branch). Hosted Models (Foundation-Sec, Cisco Deep Time Series) are a **Cloud** feature and are explicitly out of scope — stated openly, not overclaimed.
- **MCP stays read-only.** The agent reads via MCP, reasons with Claude, and emits generated artifacts. It never mutates Splunk.

---

## The Problem

When a new engineer, analyst, or admin joins a team that uses Splunk, they face weeks of ramp-up — not because Splunk is hard, but because **every Splunk environment is unique**. Indexes, alerts, dashboards, macros, saved searches — the tribal knowledge that makes someone productive lives in people's heads or nowhere at all.

But this is a symptom of a bigger problem: **most real-world Splunk environments are undocumented, partially understood, and quietly accumulating cruft.** Saved searches nobody runs. Alerts with no owner and no action. Lookups referenced by nothing. ML models someone built once and forgot. This costs money (compute, storage), creates risk (alerts firing into the void), and slows everyone — not just newcomers.

There is no tool that looks at a Splunk environment, **explains it like a patient senior engineer**, **flags what's broken or dead**, and **builds you a starting point** — all by reasoning about what it actually finds.

---

## The Solution

**Splunk Environment Intelligence Agent** — an AI agent that connects to any Splunk instance via the official MCP Server and *explores* the environment the way a curious senior engineer would. It doesn't crawl and dump metadata. It reasons about what it finds, follows dependency chains, prioritizes what matters, and then does three things:

- **Explains** the environment as a personalized, workflow-organized guide (including its AI/ML footprint) with interactive Q&A.
- **Flags** problems it discovers along the way — orphaned objects, alerts on empty indexes, alerts with no action, stale ML models, (optionally) unused saved searches — each with a ready-to-apply fix.
- **Builds** a tailored starter kit — generated SPL for common tasks, a dashboard skeleton, and per-alert runbooks — that the newcomer or team can apply immediately.

The newcomer is the demo's face. The ongoing value is for every team that has ever inherited a messy Splunk.

---

## The Three Modes

One discovery engine (reasoning loop + relationship graph), three outputs.

### Mode A — Explain  *(core)*
The agent traces dependency chains and explains each piece in plain English. Each alert is explained end-to-end: what it watches, why it matters, what feeds it, what to do when it fires. SPL is explained via `saia_explain_spl` (Claude fallback). **New in v4:** the guide includes a **"Your AI & ML Footprint"** section that lists the MLTK models/algorithms deployed in the environment and explains in plain English what each one does and where it's used.

### Mode B — Flag  *(cheap; biggest impact gain)*
The same graph that powers explanation reveals environment hygiene almost for free. Findings split into two reliability tiers:

**Reliable (graph- and metadata-derived — works on a fresh trial):**
- **Orphaned objects** — a macro/lookup with no incoming references in any SPL (pure graph property: a node with no incoming edges).
- **Alerts on empty/stale indexes** — graph traces alert → index; cross-reference `splunk_get_index_info` event count / recency.
- **Alerts with no action or no owner** — read directly from `splunk_get_knowledge_objects(type=alerts)` fields.
- **Stale ML models** — an MLTK model not referenced by any scheduled search / not applied anywhere.

**Bonus (usage-derived — needs `_internal`/`_audit` history; thin on a fresh trial):**
- **Unused saved searches** — "not run in N days" from `_internal` scheduler logs.
- **Heavily-used vs. abandoned dashboards** — from `_audit` activity.

> Build Mode B on the reliable tier first. Treat usage findings as a bonus that only fully shines if the demo environment has aged data (see Demo Data).

**Flag → Fix bridge (v4):** every finding carries a generated, ready-to-apply remediation produced by Mode C — e.g. a noisy alert is shown alongside its tuned SPL; an orphaned lookup gets a "safe to retire" note; an alert on an empty index gets a corrected index reference or a recommendation to decommission. The agent **advises and generates the exact fix; the human applies it.** No mutation of Splunk state.

### Mode C — Build  *(strengthens agentic + closes the Developer Tools bonus)*
After understanding the environment, the agent generates a tailored **starter kit**:
- Generated SPL for common tasks the newcomer will need (via `saia_generate_spl`; Claude fallback).
- A starter **dashboard skeleton** (generated panel SPL + a Dashboard Studio JSON / Simple XML scaffold).
- Per-alert **runbooks** ("when this fires, here's what it means and the first three things to check").
- The remediation artifacts that back the Flag → Fix bridge.

**Scope decision — generate-and-output only.** Mode C produces downloadable / copy-pasteable artifacts and keeps MCP strictly read-only.

**Explicitly out of scope: live write-back to Splunk via REST API.** Rationale (locked):
1. The MCP Server has **no write tool**, so writes would split the architecture into MCP-read + REST-write and dilute the clean "Best Use of MCP Server" story.
2. Mutating Splunk state is the **riskiest failure mode in a live demo**.
3. It is **scope creep** on an ~11-day timeline, stealing hours from the MUST-tier polish that actually wins this track.
4. It pulls the project toward the **crowded SOC/SRE-copilot lane** we deliberately avoided — making us a weaker closed-loop entry instead of the strongest intelligence entry.

The "actor" feeling is delivered by the advisory layer (generate the exact fix) + the live reasoning stream — not by mutation.

---

## Why This Is Agentic (Not Just a Pipeline)

A retrieval app would: discover everything → summarize → answer questions. This agent operates in a **reasoning loop** with visible decision-making, and it terminates in findings and assets, not just prose.

```
START
  │
  ▼
┌─────────────────────────────────────┐
│  1. Orient: high-level layout       │
│     (indexes, apps, users/roles)    │
└──────────────┬──────────────────────┘
               ▼
┌─────────────────────────────────────┐
│  2. Reason: what looks important?   │
│     volume? alerts attached? apps?  │
│     any ML models deployed?         │
└──────────────┬──────────────────────┘
               ▼
┌─────────────────────────────────────┐
│  3. Investigate: dig in, follow     │
│     the chains.                     │◄──────┐
│     alert → saved search → SPL      │       │
│     SPL → macro → lookup → index    │       │
│     explain complex SPL (saia_)     │       │
└──────────────┬──────────────────────┘       │
               ▼                              │
┌─────────────────────────────────────┐       │
│  4. Decide: explored enough?        │       │
│     referenced object not yet       ───Yes──┘
│     inspected? → keep going         │
│     No → synthesize                 │
└──────────────┬──────────────────────┘
               │ Done
               ▼
┌─────────────────────────────────────┐
│  5. Synthesize:                     │
│     A) Explain  → guide + AI footprint + Q&A
│     B) Flag     → hygiene findings (+ fix)  │
│     C) Build    → starter kit               │
└─────────────────────────────────────┘
```

**Concrete agentic behavior:** the agent calls `splunk_get_knowledge_objects(type=alerts)` and finds "Critical: Multiple Failed Logins." It reads the SPL, sees a reference to macro `high_severity_filter` and lookup `known_bad_ips`, and *decides* to fetch both. It calls `saia_explain_spl` on the expanded SPL. In the same pass it notices lookup `service_owners` is referenced by *nothing* (orphan → Mode B flag, with a "safe to retire" note → Mode C), and it generates a starter "failed-login triage" search (Mode C). That is an agent following a trail and acting on what it finds.

---

## The Relationship Graph (the moat — and the visual centerpiece)

Instead of listing objects independently, the agent builds a dependency graph and **renders it interactively**, with dead/orphaned nodes highlighted.

```
                    ┌──────────────┐
                    │   ALERT      │
                    │ "Failed      │
                    │  Logins"     │
                    └──────┬───────┘
                           │ triggers from
                           ▼
                    ┌──────────────┐
                    │ SAVED SEARCH │
                    │ "Login       │
                    │  Monitor"    │
                    └──────┬───────┘
                           │ SPL contains
                    ┌──────┴───────┐
                    ▼              ▼
             ┌───────────┐  ┌───────────┐
             │   MACRO   │  │  LOOKUP   │
             │ severity_ │  │ known_    │
             │  filter   │  │  bad_ips  │
             └─────┬─────┘  └─────┬─────┘
                   ▼              ▼
             ┌───────────┐  ┌───────────┐
             │   INDEX   │  │   INDEX   │
             │ auth_     │  │ threat_   │
             │  events   │  │  intel    │
             └───────────┘  └───────────┘
```

**How it's built:** parse SPL from every saved search, alert, **and dashboard view/panel**; extract `` `macro_name` `` references, `lookup` / `inputlookup` / `outputlookup` references, and `index=` references; build typed edges. Orphan detection = any macro/lookup node with zero incoming edges. (MLTK models are attached as nodes too, so a model referenced by nothing surfaces as "stale.")

**Frontend:** render with `react-flow` or `cytoscape.js` (sane defaults out of the box). **Fallback:** a clean indented tree or a Mermaid diagram. The *content* (a correctly traced chain with a highlighted dead node) matters more than physics-based layout — do not sink days into polish.

**Why it matters for the demo:** when the newcomer asks "this alert paged me at 3am, what does it mean?", the agent traces the whole chain visually and explains every piece. That is the demo's money shot.

---

## MCP Tools Used (verified against the official tools reference)

> Tool namespacing is official: `splunk_` = Splunk core platform tools, `saia_` = Splunk AI Assistant tools. To make any `saia_` tool available, the **Splunk AI Assistant** app must be installed and entitled — verified in the Day 1 smoke test, with a Claude fallback if unavailable.

### `splunk_` — Core Platform (9 tools)
| Tool | How the Agent Uses It |
|------|----------------------|
| `splunk_get_info` | Orient — Splunk version, system info |
| `splunk_get_indexes` | Orient — what data repositories exist |
| `splunk_get_index_info` | Investigate / Flag — size, event count, time range (drives "empty/stale index" flags) |
| `splunk_get_metadata` | Investigate — hosts, sources, sourcetypes per index/time window |
| `splunk_get_knowledge_objects` | Investigate / Flag — saved searches, alerts, macros, lookups, field extractions, views, panels, data models, apps, **mltk_models, mltk_algorithms** |
| `splunk_get_user_list` | Orient — who's on the team, roles |
| `splunk_get_user_info` | Orient — current user's roles/permissions |
| `splunk_run_query` | Q&A + Flag — live SPL (guardrailed); `_internal`/`_audit` usage queries |
| `splunk_get_kv_store_collections` | Investigate — KV Store usage (size, count) |

### `saia_` — Splunk AI Assistant (4 tools)
| Tool | How the Agent Uses It |
|------|----------------------|
| `saia_explain_spl` | Explain complex SPL from saved searches/alerts in plain English (Mode A) |
| `saia_generate_spl` | Generate starter SPL + remediations from natural language (Mode C, Flag→Fix) |
| `saia_optimize_spl` | Suggest faster/cleaner versions of existing SPL (Mode B/C "improvement" findings) |
| `saia_ask_splunk_question` | Answer Splunk-concept questions during Q&A |

**Knowledge-object types** `splunk_get_knowledge_objects` supports (name-drop in README/video to signal depth): `saved_searches, alerts, field_extractions, field_aliases, calculated_fields, lookups, automatic_lookups, lookup_transforms, macros, tags, data_models, workflow_actions, views, panels, apps, mltk_models, mltk_algorithms`.

> **Not used / avoided:** `splunk_run_saved_search` is **not** in the official tool list. We do not claim it. If we ever need to run a saved search's logic, we run its SPL through `splunk_run_query`.

---

## Guardrails for `splunk_run_query`

Official guardrails: searches must be safe/non-destructive, execution capped at **1 minute**, response capped at **1000 events**.

- All live queries append `| head 1000`.
- Time-bound by default (`earliest=-24h` for Q&A, `earliest=-7d` for `_internal`/`_audit` usage queries).
- On failure (destructive command rejected, timeout, truncation), the agent **explains why** and suggests a narrower alternative.
- Truncated results are flagged: "Showing top 1000 results out of ~X."

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                     User Interface (React + Vite)           │
│                                                             │
│  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐ │
│  │ Live Agent │ │ Relation │ │ Guide +  │ │ Q&A Chat    │ │
│  │ Reasoning  │ │ Graph    │ │ Findings │ │ (3am alert) │ │
│  │ Stream     │ │ (viz)    │ │ + Starter│ │             │ │
│  │            │ │          │ │ Kit      │ │             │ │
│  └─────┬──────┘ └────┬─────┘ └────┬─────┘ └──────┬──────┘ │
└────────┼─────────────┼────────────┼──────────────┼────────┘
         │   SSE / WebSocket (streaming reasoning)  │
         ▼             ▼            ▼               ▼
┌───────────────────────────────────────────────────────────┐
│                Backend (Python + FastAPI)                   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                Agent Orchestrator                    │  │
│  │  ┌────────────┐ ┌──────────────┐ ┌───────────────┐  │  │
│  │  │ Reasoning  │ │ Relationship │ │ Synthesizer   │  │  │
│  │  │ Loop       │ │ Graph Builder│ │ A / B / C     │  │  │
│  │  └─────┬──────┘ └──────┬───────┘ └───────┬───────┘  │  │
│  └────────┼───────────────┼─────────────────┼──────────┘  │
│     ┌─────┴──────┐  ┌──────┴───────┐         │             │
│     │ Claude API │  │ MCP Client   │   (artifacts out:     │
│     │ sonnet-4-6 │  │ (read-only)  │    SPL, fixes,        │
│     │ reason +   │  │ splunk_ +    │    dashboard, runbook,│
│     │ synthesize │  │ saia_        │    report)            │
│     └────────────┘  └──────┬───────┘                       │
└────────────────────────────┼───────────────────────────────┘
                             ▼
                ┌────────────────────────────┐
                │  Splunk Enterprise (on-prem)│
                │  + MCP Server app (Splunkbase)
                │  + AI Assistant (if entitled)
                │  Indexes, Knowledge Objects, │
                │  MLTK models, _internal, _audit
                └────────────────────────────┘
```

Data flow is read-only from Splunk: the agent **reads** via MCP, **reasons** with Claude, and **emits** generated artifacts to the user (it never mutates Splunk).

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React (Vite) | SPA; streaming reasoning feed; graph viz |
| Graph viz | `react-flow` or `cytoscape.js` | Out-of-the-box layout; **fallback**: indented tree / Mermaid |
| Backend | Python + FastAPI | Best MCP client support; SSE/WebSocket streaming |
| MCP Client | `mcp` Python SDK (SSE transport) | Connects to the MCP Server app's endpoint |
| AI / LLM | Claude API (`claude-sonnet-4-6`) | Fast, good for many tool-calling turns; optional Opus pass for final synthesis quality |
| Splunk | Splunk Enterprise (free trial + dev license) | On-prem |
| Splunk MCP | MCP Server app from Splunkbase (Enterprise = v1.0) | Token auth + `mcp_tool_execute` capability |
| Splunk AI | AI Assistant for SPL (if entitled on trial) | Enables `saia_` tools; Claude fallback if not |
| Export | Markdown / HTML report + downloadable starter kit | |

---

## Scope Freeze & Where Every Remaining Hour Goes

**The biggest risk now is adding features instead of polishing the core.** A clean, working version of this plan beats a feature-stuffed broken demo — judges reward "it works and the story is clear," not "look how many things we bolted on."

**Locked: no new feature surface beyond this document.** Specifically: no REST write-back, no second LLM/model integration, no extra connectors, no multi-agent rework.

**After Day 1 passes, every spare hour goes here (in priority order):**
1. The **live reasoning stream** looks like genuine decision-making, not a status ticker.
2. The **3am-alert trace** runs flawlessly, end to end, every time.
3. The **graph** draws the chain and clearly highlights dead/orphaned nodes.
4. **Three to four Mode B findings** are visibly on screen (this is what the planted "landmines" in Demo Data are for).
5. The **< 3-minute video** is cut so a judge understands everything on first watch.

If something must be cut, cut from the bottom of the MUST tier up — never cut the reasoning stream or the 3am trace.

---

## Team Split (2 people)

| Person A — Backend / Agent | Person B — Frontend / Experience |
|----------------------------|----------------------------------|
| Day 1 smoke test + MCP/auth/SSL | Day 1 repo scaffold + React shell |
| MCP client + Claude wiring | Streaming plumbing (SSE → UI) |
| Reasoning loop orchestrator | Live reasoning feed |
| Relationship graph builder + SPL parsing | Graph viz component (+ fallback) |
| Mode A synthesis (guide + saia explanations + AI footprint) | Guide display (sectioned, collapsible) |
| Mode B flags (orphans, empty-index, no-action, stale ML) | Findings panel + dead-node highlighting |
| Mode C generation (starter kit + remediations) | Starter-kit UI + download |
| Q&A endpoint + guardrails | Q&A chat UI |
| (Both) integration, demo data, video |  |

If the team ends up solo, drop the interactive graph to the fallback tree and treat Mode B usage-findings + MLTK surfacing as cuttable.

---

## Build Plan (~11 days · June 4 → June 15)

Calendar assumes Day 1 = June 4. Shift uniformly if you start later; keep the smoke test first and the freeze/record days last.

### Phase 1 — De-risk & Foundation (Days 1–2)

**Day 1 (Jun 4) — CRITICAL: verify everything works**
- [ ] Install Splunk Enterprise free trial; apply Developer License
- [ ] Install the **Splunk MCP Server** app from Splunkbase on the search head
- [ ] Enable token authentication; add `mcp_tool_execute` capability to your role; allow REST/API access
- [ ] **Handle self-signed SSL** on the mgmt port (disable TLS verification for the local dev client / `NODE_TLS_REJECT_UNAUTHORIZED=0` for any node bridge) — known Day-1 gotcha on on-prem
- [ ] **SMOKE TEST 1:** connect via the `mcp` Python SDK, call `splunk_get_indexes` — works?
- [ ] **SMOKE TEST 2:** `splunk_run_query` with a simple search — works within guardrails?
- [ ] **SMOKE TEST 3:** install **AI Assistant for SPL**, call `saia_explain_spl` and `saia_generate_spl` — available on the trial? If not → Claude fallback, adjust talking points
- [ ] **SMOKE TEST 4:** install the **AI Toolkit (MLTK)** app and create one sample model so `splunk_get_knowledge_objects(type=mltk_models)` returns something
- [ ] Load sample data (Buttercup Games, etc.)
- [ ] Decision gate: MCP works → commit to MCP. MCP fully fails → pivot to Splunk REST API on Day 2 (single biggest risk)
- [ ] (Person B) Init GitHub repo (MIT), React + Vite shell, basic CI

**Day 2 (Jun 5) — Scaffolding + realistic demo data**
- [ ] (A) FastAPI backend with MCP client connection (SSE); wire Claude (`claude-sonnet-4-6`); bare reasoning-loop skeleton
- [ ] (B) Connection screen (Splunk URL + MCP token); app layout; SSE/WebSocket streaming plumbing to UI
- [ ] (Both) Create realistic Splunk objects **including hygiene "landmines" and at least one MLTK model** (see Demo Data)
- [ ] README skeleton

### Phase 2 — Core Engine (Days 3–7)

**Day 3 (Jun 6) — Reasoning loop**
- [ ] (A) Orient → Reason → Investigate → Decide; "follow the chain" logic
- [ ] (A) Stream each reasoning step to the frontend
- [ ] (B) Live reasoning feed UI ("Found 3 alerts on auth_events, investigating…")

**Day 4 (Jun 7) — Relationship graph**
- [ ] (A) Graph data structure; parse SPL across saved searches, alerts, **and views/panels** for `` `macro` ``, `lookup`/`inputlookup`/`outputlookup`, `index=`
- [ ] (A) Orphan detection (no incoming edges); attach MLTK model nodes
- [ ] (B) Graph viz component reading the graph JSON; fallback tree ready

**Day 5 (Jun 8) — Mode A synthesis**
- [ ] (A) Prompt chain: graph + raw data → workflow-organized guide
- [ ] (A) `saia_explain_spl` (Claude fallback) per alert/saved-search SPL
- [ ] (A) **"Your AI & ML Footprint"** section: list + plain-English explain each MLTK model/algorithm
- [ ] (B) Guide display: Critical Alerts, Data Landscape, Team Dashboards, The Shorthand, Who Knows What, AI & ML Footprint

**Day 6 (Jun 9) — Mode B (Flag)**
- [ ] (A) Reliable tier: orphaned objects, alerts on empty/stale indexes, alerts with no action/owner, stale ML models
- [ ] (A) Bonus tier (if `_internal`/`_audit` data exists): unused saved searches, dashboard usage — guardrailed
- [ ] (A) Flag → Fix: attach a generated remediation to each finding
- [ ] (B) Findings panel; highlight dead/orphaned nodes in the graph

**Day 7 (Jun 10) — Mode C (Build)**
- [ ] (A) `saia_generate_spl` (Claude fallback) → starter SPL for common tasks
- [ ] (A) Dashboard skeleton (panel SPL + Studio JSON / Simple XML scaffold); per-alert runbooks
- [ ] (A) Optional: `saia_optimize_spl` "you could write this faster" suggestions
- [ ] (B) Starter-kit UI + download (copy/paste + file)

### Phase 3 — Q&A, Polish, Submission (Days 8–11)

**Day 8 (Jun 11) — Q&A + the 3am-alert money shot**
- [ ] (A) Chat endpoint with full environment context; live `splunk_run_query` (guardrailed); `saia_ask_splunk_question`
- [ ] (A) "3am alert trace": user names an alert → agent traces the full chain → explains what happened and what to do
- [ ] (B) Q&A chat UI

**Day 9 (Jun 12) — Integration + edge cases + export**
- [ ] (Both) End-to-end: connect → explore → guide → findings → starter kit → Q&A → export
- [ ] (Both) Edge cases: empty environment, large environment, missing permissions, MCP drop, query timeout/auth failure
- [ ] (B) Report export (Markdown/HTML): TOC, all sections, text-based relationship diagrams, quick-reference tables, regeneration date
- [ ] Graph viz: polish OR commit to the fallback — decide today

**Day 10 (Jun 13) — Architecture diagram + README + dry run**
- [ ] Architecture diagram (PNG in repo root): User → Frontend → Backend → Claude + MCP Client → MCP Server (`splunk_` + `saia_`) → Splunk Enterprise; show the agentic loop and labeled data-flow arrows
- [ ] Finalize README: overview, problem, the three modes, features, architecture diagram, tech stack, **step-by-step setup**, screenshots, how AI is used, license
- [ ] **FEATURE FREEZE.** Full dry-run of the demo

**Day 11 (Jun 14) — Video + submit prep**
- [ ] Record + edit demo video (< 3 min); upload to YouTube
- [ ] Write Devpost description (new positioning); link video + repo
- [ ] Verify all submission requirements
- [ ] **Verify bonus opt-in requirements** on the official rules page (MCP Server + Developer Tools)
- [ ] Fill the hackathon **Feedback Form** (Most Valuable Feedback, $200 × 5 — easy extra + goodwill)

**Jun 15 (morning) — final submit buffer**

---

## Demo Data Setup

Create these before Day 3. Name them realistically. **Deliberately plant hygiene "landmines"** so Mode B has real findings.

**Indexes:**
- `web_logs` — application access logs (load Buttercup Games data here)
- `firewall_logs` — network security events
- `auth_events` — authentication / login events
- `app_metrics` — application performance data
- `deploy_logs` — CI/CD deployment records
- `legacy_winlogs` — **landmine: leave EMPTY** (an alert will point here → "alert on empty index")

**Saved searches (real SPL):**
- "Daily Failed Login Summary" — `index=auth_events action=failure | stats count by user, src_ip | sort -count`
- "Top 10 Error Codes Last 24h" — `index=web_logs status>=400 | top 10 status`
- "Slow API Response Times" — `index=app_metrics response_time>2000 | stats avg(response_time) by endpoint`
- "Unusual After-Hours Access" — `` index=auth_events date_hour<6 OR date_hour>22 NOT `exclude_internal_traffic` | stats count by user ``
- "Deployment Failure Rate" — `index=deploy_logs status=failed | stats count by service, version`
- "OLD - Quarterly VPN Report v2" — **landmine: never schedule / never run** (usage-tier "unused saved search," if `_internal` data exists)

**Alerts (with dependencies):**
- "Critical: Multiple Failed Logins from Same IP" — references macro `high_severity_filter` + lookup `known_bad_ips` (the 3am-alert chain)
- "Warning: API Latency Above Threshold" — references macro `business_hours_only`
- "Critical: Firewall Rule Violations" — reads from `firewall_logs`
- "Legacy Windows Event Monitor" — **landmine: reads from `legacy_winlogs` (empty)** → "alert on empty index"
- "Disk Space Warning" — **landmine: no alert action configured** → "alert with no action"

**Macros:**
- `high_severity_filter` — `severity IN ("critical", "high")`
- `business_hours_only` — `date_hour>=8 AND date_hour<=18 AND date_wday!="saturday" AND date_wday!="sunday"`
- `exclude_internal_traffic` — `NOT src_ip IN ("10.0.0.*", "192.168.*")`
- `deprecated_geoip_filter` — **landmine: referenced by nothing** → "orphaned macro"

**Lookups:**
- `known_bad_ips.csv` — suspicious IPs (used by the 3am alert)
- `service_owners.csv` — service → owner mapping. **landmine: referenced by nothing** → "orphaned lookup"

**MLTK models (AI Toolkit):**
- `login_volume_outliers` — an outlier/DensityFunction model on `auth_events` (used by a scheduled search) → shown in "AI & ML Footprint"
- `old_capacity_forecast` — **landmine: not referenced / not scheduled** → "stale ML model"

**Dashboards:**
- "Application Health Overview"
- "Security Posture Dashboard"
- "Infrastructure Performance"

**Why:** the "Multiple Failed Logins" chain (alert → macro → lookup → index) drives the 3am money shot. The empty index, the no-action alert, the two orphans, and the stale ML model give Mode B concrete, on-screen wins that don't depend on `_internal` history. The active MLTK model gives the "AI & ML Footprint" section something real to show.

---

## Risk Table

| Risk | Mitigation | When |
|------|-----------|------|
| MCP Server doesn't install/auth on the free Enterprise trial | Day 1 smoke test. Fallback: Splunk REST API directly. | Day 1, first thing |
| Self-signed SSL blocks the MCP connection | Disable TLS verification on the dev client / use the URL the MCP app provides | Day 1 |
| MCP Server on Enterprise is v1.0, not v1.1 | Don't claim v1.1 features; build only on the documented 13 tools | Day 1 / messaging |
| `saia_` tools not entitled on the trial | Claude fallback for explain/generate; reframe as "AI-assisted," keep features | Day 1 |
| `_internal`/`_audit` data sparse on a fresh install | Mode B reliable tier doesn't need it; age the data for the usage-tier bonus | Day 6 |
| `splunk_run_query` timeout/truncation in the demo | `| head 1000`, `earliest=-7d`; agent explains truncation; test Day 9 | Day 9 |
| Graph viz eats polish time | Use a library; commit to the fallback tree by Day 9 | Day 9 |
| **Temptation to add features** | **The answer is no. Polish the MUST tier instead (see Scope Freeze).** | Every day |
| Mode C tempts live write-back | **Generate-and-output only.** No REST write. MCP stays read-only. | Always |
| Scope creep | **This plan is the scope.** Finish early → polish the 3am Q&A, the graph, the video. | Every day |
| Bonus opt-in requirements missed | Check official rules before submitting (MCP + Developer Tools) | Day 11 |
| Model string outdated | `claude-sonnet-4-6` (current as of June 2026) | Day 2 |

---

## Fallback Ladder (nothing hard-blocks the submission)

1. MCP fails entirely → Splunk REST API for discovery (same engine, different transport).
2. `saia_` unavailable → Claude explains and generates SPL (lose the talking point, keep the feature).
3. Interactive graph not polished → clean indented tree / Mermaid (content over physics).
4. `_internal` usage data thin → Mode B ships on graph-derived findings only.
5. MLTK app won't install on the trial → drop the "AI & ML Footprint" section; everything else stands.
6. Mode C dashboard scaffold too heavy → ship generated SPL + runbooks only.
7. Time crunch → MUST tier (Mode A + 3am money shot + live reasoning stream) is the demo; everything else is additive.

---

## Judging Positioning

### Quality of the Idea
- Uncontested wedge: an onboarding / environment-intelligence agent in Platform & DevEx, while the crowd builds SOC copilots in Security/Observability.
- Different persona (the newcomer) **and** a universal ongoing job (documenting + cleaning any environment).

### Technological Implementation
- Genuine reasoning loop with visible decisions, not a pipeline.
- Relationship graph built by parsing SPL across objects and dashboards; orphan detection as a graph property.
- 13 official MCP tools across `splunk_` + `saia_`, used correctly, with a clean read-only data model and a Claude fallback path.

### Design
- Live reasoning stream (you can watch the agent think).
- Interactive relationship graph with dead-node highlighting as the visual centerpiece.
- Output organized by **workflows**, not object types; findings carry ready-to-apply fixes; helpful error states.

### Potential Impact
- Not just onboarding: **every team with an inherited, undocumented Splunk** benefits — hygiene findings cut cost and risk; the starter kit shortens ramp-up from weeks to an hour.
- Re-runnable as living documentation when the environment changes.

### Bonus prizes
- **Best Use of Splunk MCP Server:** 13 tools across both namespaces; correct guardrail handling; read-only, RBAC-respecting design.
- **Best Use of Splunk Developer Tools:** the whole project is a developer-experience play, and Mode C generates real Splunk assets from natural language.
- **Leverages the full Splunk AI stack:** MCP + AI Assistant (`saia_`) + AI Toolkit/MLTK surfacing. (Hosted Models are explicitly out of scope — a Cloud feature not available on the on-prem trial; Foundation-sec-8b and the Cisco Time Series Model are open-weight on Hugging Face, but self-hosting via DSDL is a deliberate non-goal for 11 days.)

---

## Demo Video Script (< 3 minutes)

- **0:00–0:15 — THE WALL.** Open Splunk's raw UI. The overwhelming list of indexes, saved searches, dashboards. "You just joined the team. Day one. You open Splunk. Where do you even start? And no one's documented any of this in years."
- **0:15–0:30 — THE SOLUTION.** "Splunk Environment Intelligence Agent connects to your environment and explores it like a senior engineer — following trails, connecting the dots. It explains it, flags what's broken, and builds you a starting point."
- **0:30–1:20 — LIVE EXPLORATION.** Show the connection, then the **live reasoning stream**: "Found 6 indexes… auth_events has 3 alerts and high volume, investigating… alert 'Multiple Failed Logins' references macro `high_severity_filter` and lookup `known_bad_ips`, fetching those… explaining the SPL…" Show the **relationship graph** drawing itself.
- **1:20–1:50 — EXPLAIN + FLAG.** Scroll the guide briefly (incl. the AI & ML footprint). Then cut to **Findings**: "It also caught that 'Legacy Windows Event Monitor' reads from an empty index, 'Disk Space Warning' has no action, two objects are orphaned, and one ML model is stale — each with a ready-to-apply fix." Show the graph highlighting the dead nodes.
- **1:50–2:15 — BUILD.** "And it generated a starter kit." Show generated SPL for a common task + a per-alert runbook + the dashboard skeleton.
- **2:15–2:45 — THE MONEY SHOT.** Q&A: "This alert paged me at 3am — what does it mean and what should I do?" The agent traces the full chain (alert → saved search → SPL → macro → lookup → index) and gives actionable guidance.
- **2:45–3:00 — WRAP.** "Built with the Splunk MCP Server, Splunk AI Assistant, and Claude. 13 MCP tools across both namespaces. Read-only, RBAC-respecting, open source." Show the report export.

---

## Submission Checklist

- [ ] Public open-source repo (MIT), full source, assets, run instructions
- [ ] Clear README: setup + run, screenshots, how AI is used
- [ ] Architecture diagram in repo root (Splunk interaction + AI/agent integration + data flow)
- [ ] Demo video < 3 min on YouTube (working product, AI usage, problem + value); no unlicensed music/trademarks
- [ ] Devpost text description (new positioning)
- [ ] Track selected: Platform & Developer Experience
- [ ] Bonus opt-in verified: MCP Server, Developer Tools
- [ ] Feedback Form submitted

---

## The One Rule

**If it's not in this plan, don't build it.** Finish early → polish the demo video, perfect the 3am-alert trace, clean up the reasoning stream and the graph. Not new features. The MUST tier is the demo; B and C are the impact multipliers; everything else is cuttable.
