# Cairn Demo Splunk Setup

This walkthrough sets up a Splunk environment that lets Cairn show its full agentic capabilities — most importantly, the **dependency chain demo**: a critical alert that references a macro and a lookup, so Cairn can trace `alert → SPL → macro + lookup → index` end to end.

Time estimate: **20–30 minutes** against a Splunk Enterprise instance you already have running.

---

## Prerequisites

- A working Splunk Enterprise instance (Free, Trial, or Developer License is fine — version 9.0+ recommended).
- Splunk Web reachable at `http://localhost:8000` (or wherever your instance lives).
- Admin credentials.
- The two CSV files from this directory: `known_bad_ips.csv` and `service_owners.csv`.
- (Optional, for the SPL-explanation demo) **AI Assistant for SPL** (`saia_*` tools) installed on the deployment. Cairn detects this automatically and falls back to its own LLM (Groq) if absent.

---

## 1. Create the indexes

In Splunk Web: **Settings → Indexes → New Index**. Create each of the following with the default event-index settings (regular index, default retention):

| Index name | Purpose |
|---|---|
| `web_logs` | HTTP access logs from web frontends |
| `firewall_logs` | Edge firewall allow/deny events |
| `auth_events` | Authentication successes and failures |
| `app_metrics` | Application performance metrics |
| `deploy_logs` | CI/CD deployment events |

---

## 2. Load the sample log data

The fastest way to populate the indexes is to paste the sample lines below into a one-shot `oneshot` upload — **Settings → Add Data → Upload** — and pick the matching index + sourcetype each time. Alternatively, drop them into `$SPLUNK_HOME/var/spool/splunk/` with the right `inputs.conf` stanzas.

### `web_logs` (sourcetype: `access_combined`)

```
2026-06-01 14:22:15 198.51.100.23 GET /api/login 401 124 "Mozilla/5.0" auth-api 0.142
2026-06-01 14:22:18 198.51.100.23 GET /api/login 401 124 "Mozilla/5.0" auth-api 0.131
2026-06-01 14:22:22 198.51.100.23 GET /api/login 401 124 "Mozilla/5.0" auth-api 0.118
2026-06-01 14:22:25 198.51.100.23 GET /api/login 401 124 "Mozilla/5.0" auth-api 0.125
2026-06-01 14:22:31 198.51.100.23 GET /api/login 401 124 "Mozilla/5.0" auth-api 0.144
2026-06-01 14:30:11 10.0.1.45 GET /api/orders 200 8842 "OrderClient/2.1" payments-api 0.092
2026-06-01 14:30:14 10.0.1.45 POST /api/orders 500 412 "OrderClient/2.1" payments-api 2.847
2026-06-01 14:30:15 10.0.1.45 POST /api/orders 500 412 "OrderClient/2.1" payments-api 3.102
2026-06-01 14:31:02 10.0.1.46 GET /api/search 200 12455 "WebFE/1.0" search-api 4.821
2026-06-01 14:31:08 10.0.1.46 GET /api/search 200 11203 "WebFE/1.0" search-api 5.103
2026-06-01 14:32:10 10.0.1.50 GET /healthz 200 12 "kube-probe/1.27" edge-gateway 0.004
2026-06-01 14:32:18 203.0.113.45 GET /admin 403 88 "curl/7.81" edge-gateway 0.012
2026-06-01 14:33:01 203.0.113.45 GET /wp-admin 404 88 "curl/7.81" edge-gateway 0.009
```

### `firewall_logs` (sourcetype: `cisco:asa`)

```
2026-06-01 14:21:50 src_ip=198.51.100.23 dst_ip=10.0.1.10 dst_port=22 action=deny rule=block_ssh_external
2026-06-01 14:22:00 src_ip=198.51.100.47 dst_ip=10.0.1.11 dst_port=22 action=deny rule=block_ssh_external
2026-06-01 14:22:30 src_ip=203.0.113.12 dst_ip=10.0.1.50 dst_port=443 action=allow rule=allow_https
2026-06-01 14:22:35 src_ip=203.0.113.12 dst_ip=10.0.1.50 dst_port=4444 action=deny rule=block_high_ports
2026-06-01 14:22:40 src_ip=192.0.2.5 dst_ip=10.0.1.50 dst_port=22 action=deny rule=block_ssh_external
2026-06-01 14:23:11 src_ip=91.219.236.220 dst_ip=10.0.1.51 dst_port=3389 action=deny rule=block_rdp_external
2026-06-01 14:23:45 src_ip=185.220.101.34 dst_ip=10.0.1.50 dst_port=443 action=deny rule=block_tor_exits
2026-06-01 14:24:01 src_ip=45.79.13.21 dst_ip=10.0.1.51 dst_port=443 action=allow rule=allow_https
2026-06-01 14:24:02 src_ip=45.79.13.21 dst_ip=10.0.1.51 dst_port=443 action=allow rule=allow_https
2026-06-01 14:24:03 src_ip=45.79.13.21 dst_ip=10.0.1.51 dst_port=443 action=allow rule=allow_https
```

### `auth_events` (sourcetype: `json`)

```json
{"_time":"2026-06-01T14:22:15Z","src_ip":"198.51.100.23","user":"admin","action":"login","result":"failure","reason":"invalid_password","service":"auth-api","severity":"high"}
{"_time":"2026-06-01T14:22:18Z","src_ip":"198.51.100.23","user":"admin","action":"login","result":"failure","reason":"invalid_password","service":"auth-api","severity":"high"}
{"_time":"2026-06-01T14:22:22Z","src_ip":"198.51.100.23","user":"root","action":"login","result":"failure","reason":"unknown_user","service":"auth-api","severity":"high"}
{"_time":"2026-06-01T14:22:25Z","src_ip":"198.51.100.23","user":"root","action":"login","result":"failure","reason":"unknown_user","service":"auth-api","severity":"high"}
{"_time":"2026-06-01T14:22:31Z","src_ip":"198.51.100.23","user":"alice.chen","action":"login","result":"failure","reason":"invalid_password","service":"auth-api","severity":"critical"}
{"_time":"2026-06-01T22:14:02Z","src_ip":"10.0.5.12","user":"bob.martinez","action":"login","result":"success","service":"auth-api","severity":"info"}
{"_time":"2026-06-01T23:47:55Z","src_ip":"10.0.5.12","user":"bob.martinez","action":"login","result":"success","service":"auth-api","severity":"info"}
{"_time":"2026-06-02T03:11:20Z","src_ip":"203.0.113.78","user":"backup","action":"login","result":"success","service":"auth-api","severity":"high"}
{"_time":"2026-06-02T03:11:45Z","src_ip":"203.0.113.78","user":"backup","action":"sudo","result":"success","service":"auth-api","severity":"critical"}
```

### `app_metrics` (sourcetype: `json`)

```json
{"_time":"2026-06-01T14:30:11Z","service":"payments-api","endpoint":"/api/orders","method":"GET","response_time_ms":92,"status":200}
{"_time":"2026-06-01T14:30:14Z","service":"payments-api","endpoint":"/api/orders","method":"POST","response_time_ms":2847,"status":500}
{"_time":"2026-06-01T14:30:15Z","service":"payments-api","endpoint":"/api/orders","method":"POST","response_time_ms":3102,"status":500}
{"_time":"2026-06-01T14:31:02Z","service":"search-api","endpoint":"/api/search","method":"GET","response_time_ms":4821,"status":200}
{"_time":"2026-06-01T14:31:08Z","service":"search-api","endpoint":"/api/search","method":"GET","response_time_ms":5103,"status":200}
{"_time":"2026-06-01T14:32:01Z","service":"search-api","endpoint":"/api/search","method":"GET","response_time_ms":6240,"status":200}
{"_time":"2026-06-01T14:33:00Z","service":"catalog-svc","endpoint":"/api/catalog","method":"GET","response_time_ms":312,"status":200}
{"_time":"2026-06-01T14:35:00Z","service":"recommendations-svc","endpoint":"/api/recommend","method":"GET","response_time_ms":1842,"status":200}
```

### `deploy_logs` (sourcetype: `json`)

```json
{"_time":"2026-06-01T09:14:00Z","service":"payments-api","version":"v2.14.1","environment":"prod","status":"success","duration_s":312,"actor":"ivan.petrov"}
{"_time":"2026-06-01T11:02:00Z","service":"search-api","version":"v3.7.0","environment":"prod","status":"failure","duration_s":89,"actor":"ivan.petrov","error":"smoke_test_failed"}
{"_time":"2026-06-01T11:18:00Z","service":"search-api","version":"v3.7.1","environment":"prod","status":"failure","duration_s":102,"actor":"ivan.petrov","error":"smoke_test_failed"}
{"_time":"2026-06-01T11:35:00Z","service":"search-api","version":"v3.7.2","environment":"prod","status":"success","duration_s":287,"actor":"ivan.petrov"}
{"_time":"2026-06-01T13:00:00Z","service":"auth-api","version":"v1.42.0","environment":"prod","status":"success","duration_s":201,"actor":"alice.chen"}
{"_time":"2026-06-01T15:11:00Z","service":"catalog-svc","version":"v4.1.3","environment":"prod","status":"success","duration_s":178,"actor":"eve.nakamura"}
```

> **Tip:** to make the demo more visually interesting, re-upload each file a few times with adjusted timestamps so usage data spans more than 24 hours.

---

## 3. Upload the lookups

**Settings → Lookups → Lookup table files → New Lookup Table File**. Upload the two CSVs from this directory:

| Lookup file | Source CSV |
|---|---|
| `known_bad_ips.csv` | `demo-data/known_bad_ips.csv` |
| `service_owners.csv` | `demo-data/service_owners.csv` |

Then create **Lookup definitions** of the same name pointing at each file. Set both to "Available globally" so the demo alerts can reference them without app-scope headaches.

---

## 4. Create the macros

**Settings → Advanced search → Search macros → New**. Create three macros with no arguments:

| Name | Definition |
|---|---|
| `high_severity_filter` | `severity IN ("critical", "high")` |
| `business_hours_only` | `date_hour>=8 AND date_hour<=18 AND date_wday!="saturday" AND date_wday!="sunday"` |
| `exclude_internal_traffic` | `NOT src_ip IN ("10.0.0.*", "192.168.*")` |

---

## 5. Create the saved searches

**Settings → Searches, reports, and alerts → New Report**.

### 1. Daily Failed Login Summary

```spl
index=auth_events action=login result=failure
| stats count by user, src_ip
| sort -count
```

Schedule: daily at 08:00.

### 2. Top 10 Error Codes Last 24h

```spl
index=web_logs status>=400
| stats count by status, uri
| sort -count
| head 10
```

Schedule: daily at 09:00.

### 3. Slow API Response Times

```spl
index=app_metrics response_time_ms>1000
| stats avg(response_time_ms) as avg_ms, max(response_time_ms) as max_ms, count by service, endpoint
| sort -avg_ms
```

Schedule: hourly.

### 4. Unusual After-Hours Access

```spl
index=auth_events action=login result=success `exclude_internal_traffic`
| where date_hour<8 OR date_hour>20
| stats count by user, src_ip
```

> Note the macro reference. **Cairn will trace this dependency.**

Schedule: daily at 07:00.

### 5. Deployment Failure Rate

```spl
index=deploy_logs
| stats count(eval(status="failure")) as failures, count as total by service
| eval failure_rate=round(failures/total*100, 1)
| sort -failure_rate
```

Schedule: every 6 hours.

---

## 6. Create the alerts (the money shot)

**Settings → Searches, reports, and alerts → New Alert**.

### 1. Critical: Multiple Failed Logins from Same IP  ★ *the demo dependency-chain alert* ★

```spl
index=auth_events action=login result=failure `high_severity_filter`
| lookup known_bad_ips ip as src_ip OUTPUT threat_type, confidence
| where isnotnull(threat_type)
| stats count by src_ip, threat_type, confidence
| where count >= 3
```

- Severity: **Critical**
- Schedule: every 5 minutes, search the last 15 minutes
- Trigger: when number of results > 0
- Action: send email to `secops-oncall@example.com`

> This single alert is what makes the demo land. Cairn will trace:
> `Alert → SPL → high_severity_filter (macro) → severity field`
> `Alert → SPL → known_bad_ips.csv (lookup) → ip / threat_type / confidence`
> `Alert → SPL → index=auth_events`
> …and surface ownership from the saved search metadata.

### 2. Warning: API Latency Above Threshold

```spl
index=app_metrics response_time_ms>2000 `business_hours_only`
| stats avg(response_time_ms) as avg_ms by service
| where avg_ms > 2500
```

- Severity: **Medium**
- Schedule: every 15 minutes, search the last 30 minutes
- Trigger: when number of results > 0

### 3. Critical: Firewall Rule Violations

```spl
index=firewall_logs action=deny
| lookup known_bad_ips ip as src_ip OUTPUT threat_type, confidence
| where isnotnull(threat_type) AND confidence IN ("high", "critical")
| stats count by src_ip, threat_type, rule
```

- Severity: **Critical**
- Schedule: every 10 minutes, search the last 30 minutes
- Trigger: when number of results > 0

---

## 7. Create the dashboards

**Dashboards → Create new dashboard** (Classic / XML). Create three dashboards. Each panel uses a single inline SPL search.

### Application Health Overview

Panels:

- **Request volume by service** (timechart)
  ```spl
  index=web_logs | timechart count by sourcetype
  ```
- **Error rate by service** (column)
  ```spl
  index=app_metrics | stats count(eval(status>=500)) as errors, count as total by service | eval err_pct=round(errors/total*100,2) | sort -err_pct
  ```
- **Slowest endpoints** (table)
  ```spl
  index=app_metrics | stats avg(response_time_ms) as avg_ms by service, endpoint | sort -avg_ms | head 10
  ```

### Security Posture Dashboard

Panels:

- **Failed login attempts** (timechart)
  ```spl
  index=auth_events action=login result=failure `high_severity_filter` | timechart count by reason
  ```
- **Hits from known-bad IPs** (table)
  ```spl
  index=firewall_logs OR index=auth_events | lookup known_bad_ips ip as src_ip OUTPUT threat_type, confidence | where isnotnull(threat_type) | stats count by src_ip, threat_type, confidence | sort -count
  ```
- **After-hours admin activity** (table)
  ```spl
  index=auth_events user IN ("admin","root") action=login result=success | where date_hour<8 OR date_hour>20 | stats count by user, src_ip
  ```

### Infrastructure Performance

Panels:

- **Deploy outcomes** (column)
  ```spl
  index=deploy_logs | stats count by service, status
  ```
- **p95 response time** (timechart)
  ```spl
  index=app_metrics | timechart p95(response_time_ms) by service
  ```
- **Firewall denials by rule** (table)
  ```spl
  index=firewall_logs action=deny | stats count by rule | sort -count
  ```

---

## 8. (Optional) Pre-seed `_audit` so usage data shows up

Cairn pulls real usage data from `_audit`. To make the demo feel lived-in, run each of the saved searches and alerts **manually a few times** before recording the demo. That seeds `_audit` with `savedsearch_name=...` events Cairn can show as "this is what your team actually runs."

---

## 9. Verify

Run this one-liner in Splunk's search bar to confirm everything's in place:

```spl
| rest /servicesNS/-/-/saved/searches
| search title IN ("Critical: Multiple Failed Logins from Same IP", "Warning: API Latency Above Threshold", "Critical: Firewall Rule Violations")
| table title, search, alert.severity
```

You should see all three alerts.

You're ready. Point Cairn at this deployment and watch it trace the chain.
