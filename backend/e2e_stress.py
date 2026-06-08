"""Deep end-to-end stress test for Cairn. Drives every endpoint against a live
backend (default http://localhost:8011) and prints a per-phase pass/fail report.

Run:  ./venv/Scripts/python.exe e2e_stress.py [base_url]
"""

from __future__ import annotations

import json
import sys
import xml.dom.minidom as minidom

import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8011").rstrip("/") + "/api"

# Long timeouts: explore/generate/findings/kit each fan out into many rate-limited
# Groq calls, so individual requests can legitimately take minutes.
LONG = httpx.Timeout(600.0, connect=10.0)
SHORT = httpx.Timeout(30.0, connect=10.0)

results: dict[str, list[tuple[bool, str]]] = {}
_current_phase = "?"


def phase(name: str) -> None:
    global _current_phase
    _current_phase = name
    results.setdefault(name, [])


def check(ok: bool, label: str, detail: str = "") -> bool:
    results[_current_phase].append((bool(ok), label + (f" — {detail}" if detail and not ok else "")))
    return bool(ok)


def sse(path: str, timeout=LONG) -> list[dict]:
    """Read an SSE stream to completion, returning the parsed event objects."""
    events: list[dict] = []
    with httpx.Client(timeout=timeout, verify=False) as c:
        with c.stream("GET", f"{BASE}{path}") as r:
            if r.status_code != 200:
                raise RuntimeError(f"SSE {path} -> HTTP {r.status_code}")
            buf = ""
            for chunk in r.iter_text():
                buf += chunk
                while "\n\n" in buf or "\r\n\r\n" in buf:
                    sep = "\r\n\r\n" if "\r\n\r\n" in buf and (
                        "\n\n" not in buf or buf.index("\r\n\r\n") < buf.index("\n\n")
                    ) else "\n\n"
                    block, buf = buf.split(sep, 1)
                    data = "".join(
                        ln[5:].strip() for ln in block.splitlines() if ln.startswith("data:")
                    )
                    if not data:
                        continue
                    try:
                        ev = json.loads(data)
                        events.append(ev)
                        if ev.get("phase") == "done":
                            return events
                    except json.JSONDecodeError:
                        pass
    return events


def msgs(events: list[dict]) -> str:
    return " || ".join(str(e.get("message", "")) for e in events)


def no_poison(events: list[dict]) -> tuple[bool, bool]:
    """Return (no_raw_error_json, no_rate_limit) across all event messages."""
    blob = json.dumps(events).lower()
    no_err = '{"error"' not in blob and '"traceback"' not in blob
    no_rl = "rate_limit_exceeded" not in blob
    return no_err, no_rl


# ============================================================ PHASE 1
def phase1():
    phase("1: Health & Connection")
    with httpx.Client(timeout=SHORT, verify=False) as c:
        h = c.get(f"{BASE}/health").json()
        check(h.get("connected") is False, "GET /health -> connected:false", str(h))

        # Wrong creds first (a failed connect leaves the session torn down, so we
        # do these before the good connect rather than after).
        try:
            r = c.post(f"{BASE}/connect", json={"token": "definitely-not-a-valid-token-xyz"})
            check(r.status_code != 200, "wrong token -> error not crash", f"HTTP {r.status_code}")
        except Exception as e:
            check(False, "wrong token -> error not crash", repr(e))
        try:
            r = c.post(f"{BASE}/connect", json={"splunk_url": "https://127.0.0.1:9/services/mcp/v1"})
            check(r.status_code != 200, "wrong URL -> error not crash", f"HTTP {r.status_code}")
        except Exception as e:
            check(False, "wrong URL -> error not crash", repr(e))

        # Good connect (empty body -> falls back to .env creds).
        r = c.post(f"{BASE}/connect", json={}, timeout=LONG)
        ok = check(r.status_code == 200, "POST /connect (env creds) -> 200", f"HTTP {r.status_code}: {r.text[:200]}")
        if ok:
            body = r.json()
            dep = body.get("deployment") or {}
            ver = dep.get("version") or (dep.get("generator") or {}).get("version")
            check(bool(ver), "connect response has version", str(dep)[:160])
            check(bool(dep), "connect response has deployment info")
            check(bool(body.get("tool_availability")), "connect response has tool_availability")
        h = c.get(f"{BASE}/health").json()
        check(h.get("connected") is True, "GET /health -> connected:true", str(h))


# ============================================================ PHASE 10a (pre-gen errors)
def phase10_pre():
    # Run the "before generating" error checks while the session is connected but
    # nothing has been explored/generated yet. Reported under Phase 10.
    phase("10: Edge Cases")
    with httpx.Client(timeout=SHORT, verify=False) as c:
        r = c.get(f"{BASE}/guide")
        check(r.status_code >= 400, "GET /guide before generate -> error", f"HTTP {r.status_code}")
        r = c.get(f"{BASE}/starter-kit/data")
        check(r.status_code >= 400, "GET /starter-kit/data before generate -> error", f"HTTP {r.status_code}")
        r = c.get(f"{BASE}/findings/data")
        check(r.status_code >= 400, "GET /findings/data before generate -> error", f"HTTP {r.status_code}")


# ============================================================ PHASE 2
def phase2():
    phase("2: Exploration")
    events = sse("/explore")
    phases = [e.get("phase") for e in events]
    check(any(p == "orient" for p in phases), "has >=1 orient event")
    check(any(p == "investigate" for p in phases), "has >=1 investigate event")
    reason_with_text = [e for e in events if e.get("phase") == "reason" and str((e.get("data") or {}).get("observation", "")).strip()]
    check(len(reason_with_text) >= 1, "has reason event w/ LLM reasoning content", f"{len(reason_with_text)} found")
    done = [e for e in events if e.get("phase") == "done"]
    check(len(done) >= 1, "has done event at end")
    check(len(events) > 20, "event count > 20", f"got {len(events)}")
    if done:
        summ = (done[-1].get("data") or {}).get("summary") or {}
        nt, et = summ.get("node_total", 0), summ.get("edge_total", 0)
        check(nt > 0 and et > 0, "done summary node/edge totals > 0", f"nodes={nt} edges={et}")
    ne, nrl = no_poison(events)
    check(ne, "no raw error JSON in events")
    check(nrl, "no rate_limit_exceeded in events")
    return events


# ============================================================ PHASE 3
def phase3():
    phase("3: Guide Generation")
    gen = sse("/generate")
    check(any(e.get("phase") == "synthesize" for e in gen), "generate emits synthesize events",
          f"phases={[e.get('phase') for e in gen][:8]}")
    ne, nrl = no_poison(gen)
    check(ne and nrl, "no error/rate-limit in generate stream")

    with httpx.Client(timeout=LONG, verify=False) as c:
        g = c.get(f"{BASE}/guide").json()
    secs = g.get("sections") or {}
    # sections is a dict title->markdown
    sec_items = list(secs.items()) if isinstance(secs, dict) else [(s.get("title"), s.get("content")) for s in secs]
    check(len(sec_items) == 6, "sections has 6 items", f"got {len(sec_items)}")
    nonempty = all(t and (cnt or "").strip() for t, cnt in sec_items)
    check(nonempty, "each section has title + non-empty content")
    poison = [t for t, cnt in sec_items if (cnt or "").startswith("_(generation failed") or "rate_limit_exceeded" in (cnt or "")]
    check(not poison, "no section poisoned (failed/rate-limit)", f"bad={poison}")

    st = g.get("structured") or {}
    for key in ("alerts", "indexes", "dashboards", "macros", "lookups"):
        check(isinstance(st.get(key), list), f"structured.{key} is array")
    al = st.get("alerts") or []
    check(len(al) >= 2, "structured.alerts >= 2", f"got {len(al)}")
    check(all(a.get("name") and a.get("severity") is not None and "spl" in a and isinstance(a.get("chain"), list) for a in al),
          "each alert has name/severity/spl/chain")
    idx = st.get("indexes") or []
    check(len(idx) >= 5, "structured.indexes >= 5", f"got {len(idx)}")
    check(all(i.get("name") and "eventCount" in i for i in idx), "each index has name/eventCount")
    check(len(st.get("dashboards") or []) >= 3, "structured.dashboards >= 3", f"got {len(st.get('dashboards') or [])}")
    check(len(st.get("macros") or []) >= 3, "structured.macros >= 3", f"got {len(st.get('macros') or [])}")
    check(len(st.get("lookups") or []) >= 1, "structured.lookups >= 1", f"got {len(st.get('lookups') or [])}")
    check(len(g.get("graph_nodes") or []) > 10, "graph_nodes > 10", f"got {len(g.get('graph_nodes') or [])}")
    check(len(g.get("graph_edges") or []) > 5, "graph_edges > 5", f"got {len(g.get('graph_edges') or [])}")
    check((g.get("mltk_algorithm_count") or 0) > 0, "mltk_algorithm_count > 0", f"got {g.get('mltk_algorithm_count')}")
    check(g.get("mltk_model_count") == 0, "mltk_model_count == 0", f"got {g.get('mltk_model_count')}")
    return g


# ============================================================ PHASE 4
def phase4():
    phase("4: Findings")
    sse("/findings")
    with httpx.Client(timeout=LONG, verify=False) as c:
        d = c.get(f"{BASE}/findings/data").json()
    f = d.get("findings") or []
    check(len(f) == 4, "exactly 4 findings", f"got {len(f)}: {[x.get('category') for x in f]}")

    def find(cat_sub, name_sub):
        for x in f:
            blob = (str(x.get("category", "")) + " " + str(x.get("title", "")) + " " +
                    str(x.get("affected_node_id", "")) + " " + json.dumps(x.get("evidence", {}))).lower()
            if cat_sub in blob and name_sub in blob:
                return x
        return None

    geoip = find("orphan", "deprecated_geoip_filter")
    owners = find("orphan", "service_owners")
    empty = find("empty_index", "legacy windows") or find("empty", "legacy windows")
    noact = find("no_action", "low disk") or find("no_action", "disk")
    check(bool(geoip), "orphan finding: deprecated_geoip_filter present")
    check(bool(owners), "orphan finding: service_owners present")
    check(bool(empty), "empty_index finding: Legacy Windows present")
    check(bool(noact), "no_action finding: Low Disk present")
    if empty:
        check(bool((empty.get("fix_spl") or "").strip()), "empty_index finding has fix_spl")
    if noact:
        check(bool((noact.get("fix_spl") or "").strip()), "no_action finding has fix_spl")
    if geoip:
        check(not (geoip.get("fix_spl") or "").strip(), "geoip orphan has empty fix_spl")
    if owners:
        check(not (owners.get("fix_spl") or "").strip(), "service_owners orphan has empty fix_spl")
    check(len(d.get("dead_node_ids") or []) >= 3, "dead_node_ids >= 3", f"got {len(d.get('dead_node_ids') or [])}")
    blob = json.dumps(f).lower()
    check("business_hours_only" not in blob, "no false positive: business_hours_only")
    check("exclude_internal_traffic" not in blob, "no false positive: exclude_internal_traffic")


# ============================================================ PHASE 5
def phase5():
    phase("5: Starter Kit")
    sse("/starter-kit")
    with httpx.Client(timeout=LONG, verify=False) as c:
        d = c.get(f"{BASE}/starter-kit/data").json()
    q = d.get("generated_queries") or []
    check(len(q) > 5, "generated_queries > 5", f"got {len(q)}")
    check(all(x.get("title") and x.get("spl") and x.get("category") for x in q), "each query has title/spl/category")
    cats = {x.get("category") for x in q}
    check({"security", "application"} <= cats, "queries cover security + application", f"cats={cats}")
    rb = d.get("runbooks") or []
    check(len(rb) > 1, "runbooks > 1", f"got {len(rb)}")
    check(all(r.get("alert_name") and r.get("severity") and r.get("what_it_means")
              and isinstance(r.get("first_checks"), list) and r.get("spl_to_run") for r in rb),
          "each runbook has required fields")
    check(len(d.get("dashboard_panels") or []) > 5, "dashboard_panels > 5", f"got {len(d.get('dashboard_panels') or [])}")
    xml = d.get("dashboard_xml") or ""
    check(xml.strip().startswith("<dashboard") or xml.strip().startswith("<form"), "dashboard_xml starts with <dashboard", xml[:40])
    try:
        minidom.parseString(xml)
        check(True, "dashboard_xml parses as valid XML")
    except Exception as e:
        check(False, "dashboard_xml parses as valid XML", repr(e))


# ============================================================ PHASE 6 + 10b
def phase6():
    phase("6: Q&A")
    with httpx.Client(timeout=LONG, verify=False) as c:
        q1 = "What does Critical: Multiple Failed Logins from Same IP mean and what should I do when it fires?"
        r = c.post(f"{BASE}/ask", json={"question": q1}).json()
        ans = r.get("answer") or ""
        check(bool(ans.strip()), "answer non-empty")
        check(("auth_events" in ans.lower()) or ("failed login" in ans.lower()), "answer mentions auth_events/failed login")
        check(isinstance(r.get("live_queries"), list), "live_queries is a list")
        check(not ans.lstrip().startswith("`"), "answer not backtick-wrapped SPL")
        check('{"error"' not in ans.lower() and '"traceback"' not in ans.lower(), "answer has no raw error JSON")

        r2 = c.post(f"{BASE}/ask", json={"question": "What indexes exist in this environment?"}).json()
        a2 = (r2.get("answer") or "").lower()
        known = ["auth_events", "firewall_logs", "web_logs", "app_metrics", "deploy_logs"]
        hits = sum(1 for n in known if n in a2)
        check(hits >= 3, "index answer mentions >= 3 index names", f"matched {hits}")

    # Phase 10 edge cases that need a live explored session
    phase("10: Edge Cases")
    with httpx.Client(timeout=LONG, verify=False) as c:
        r = c.post(f"{BASE}/ask", json={"question": ""})
        check(r.status_code >= 400, "empty question -> error not crash", f"HTTP {r.status_code}")
        long_q = "What does this alert mean? " * 60  # ~1500 chars
        try:
            r = c.post(f"{BASE}/ask", json={"question": long_q})
            ok = r.status_code == 200 and bool((r.json().get("answer") or "").strip())
            check(ok, "very long question -> answer not crash", f"HTTP {r.status_code}")
        except Exception as e:
            check(False, "very long question -> answer not crash", repr(e))


# ============================================================ PHASE 7
def phase7():
    phase("7: Graph")
    with httpx.Client(timeout=SHORT, verify=False) as c:
        g = c.get(f"{BASE}/graph").json()
    nodes = g.get("nodes") or []
    edges = g.get("edges") or []
    check(isinstance(nodes, list) and isinstance(edges, list), "graph has nodes + edges arrays")
    types = {n.get("type") for n in nodes}
    check({"alert", "saved_search", "macro", "lookup", "index"} <= types, "node types include core 5", f"types={types}")
    ids = [n.get("id") for n in nodes]
    idset = set(ids)
    check(len(ids) == len(idset), "no duplicate node IDs", f"{len(ids)} ids / {len(idset)} unique")
    dangling = [e for e in edges if e.get("source") not in idset or e.get("target") not in idset]
    check(not dangling, "all edges reference existing node IDs", f"{len(dangling)} dangling")


# ============================================================ PHASE 8
def phase8():
    phase("8: Export")
    with httpx.Client(timeout=LONG, verify=False) as c:
        md = c.get(f"{BASE}/export", params={"format": "markdown"}).text
        check(bool(md.strip()), "markdown export non-empty")
        check("## Table of Contents" in md, "markdown has Table of Contents")
        check("## Environment at a Glance" in md, "markdown has Environment at a Glance")
        check("Generated by Cairn on" in md, "markdown has 'Generated by Cairn on'")
        titles = ["Critical Alerts & What They Mean", "Your Data Landscape", "Your Team's Dashboards",
                  "The Shorthand", "Who Knows What", "AI & ML Footprint"]
        missing = [t for t in titles if t not in md]
        check(not missing, "markdown contains all 6 section titles", f"missing={missing}")
        html = c.get(f"{BASE}/export", params={"format": "html"}).text
        check(bool(html.strip()) and "<table" in html, "html export non-empty + has <table")


# ============================================================ PHASE 9
def phase9():
    phase("9: Dashboard XML Download")
    with httpx.Client(timeout=SHORT, verify=False) as c:
        r = c.get(f"{BASE}/starter-kit/dashboard-xml")
        cd = r.headers.get("content-disposition", "")
        check("attachment" in cd.lower(), "Content-Disposition attachment", cd)
        body = r.text
        check(body.strip().startswith("<dashboard") or body.strip().startswith("<form"), "body starts with <dashboard", body[:40])
        check(body.count("<panel") >= 5, "body has >= 5 <panel> tags", f"got {body.count('<panel')}")


# ============================================================ PHASE 11
def phase11():
    phase("11: SPL Cleaning")
    from agent.orchestrator import _clean_spl_response as clean
    c1 = clean("`index=auth_events | stats count`")
    check(c1 == "index=auth_events | stats count", "unwraps query backticks", repr(c1))
    c2 = clean("```spl\nindex=auth_events\n```")
    check(c2 == "index=auth_events", "strips ```spl fences", repr(c2))
    c3 = clean("`high_severity_filter`")
    check(c3 == "`high_severity_filter`", "leaves real macro alone", repr(c3))
    c4 = clean("index=web_logs status=500 | stats count by uri")
    check(c4 == "index=web_logs status=500 | stats count by uri", "plain SPL unchanged", repr(c4))


def main():
    steps = [phase1, phase10_pre, phase2, phase3, phase4, phase5, phase6, phase7, phase8, phase9, phase11]
    for step in steps:
        try:
            step()
        except Exception as e:
            phase(_current_phase)
            check(False, f"PHASE CRASHED: {step.__name__}", repr(e))

    print("\n" + "=" * 70)
    print("CAIRN E2E STRESS TEST REPORT  (base: %s)" % BASE)
    print("=" * 70)
    total_ok = total = 0
    order = ["1: Health & Connection", "2: Exploration", "3: Guide Generation", "4: Findings",
             "5: Starter Kit", "6: Q&A", "7: Graph", "8: Export", "9: Dashboard XML Download",
             "10: Edge Cases", "11: SPL Cleaning"]
    crit_fail = []
    for name in order:
        checks = results.get(name, [])
        ok = sum(1 for p, _ in checks if p)
        n = len(checks)
        total_ok += ok
        total += n
        mark = "PASS" if ok == n else "FAIL"
        print(f"\n[{mark}] PHASE {name} — {ok}/{n} checks passed")
        for passed, label in checks:
            print(f"    {'OK ' if passed else 'XX '} {label}")
            if not passed:
                crit_fail.append(f"PHASE {name}: {label}")
    print("\n" + "=" * 70)
    print(f"OVERALL: {total_ok}/{total} checks passed")
    print("=" * 70)
    if crit_fail:
        print("\nFAILURES:")
        for f in crit_fail:
            print("  - " + f)


if __name__ == "__main__":
    main()
