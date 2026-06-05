#!/usr/bin/env python3
"""Set up the Cairn demo data in a local Splunk instance.

Run after editing if you need:
    python demo-data/setup_splunk.py --password YOUR_SPLUNK_PASSWORD

Creates (idempotently — existing objects are skipped):
    1. 5 indexes
    2. ~36 sample events ingested across those indexes
    3. 3 search macros
    4. 2 lookup table files + their lookup definitions
    5. 5 saved searches
    6. 3 alerts
    7. 3 dashboards

Only dependency outside the stdlib: ``requests``.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

try:
    import requests
    import urllib3
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "This script requires the 'requests' package. Install it with:\n"
        "    pip install requests\n"
    )
    sys.exit(1)

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


# ============================================================================
# Data definitions
# ============================================================================

INDEXES: tuple[str, ...] = (
    "web_logs",
    "firewall_logs",
    "auth_events",
    "app_metrics",
    "deploy_logs",
    # Landmine: created but never fed any events. An alert points here, so Mode B
    # flags "alert on empty index". Keep it OUT of SAMPLE_EVENTS so it stays empty.
    "legacy_winlogs",
)

# Each entry: (index, sourcetype, [event_lines])
SAMPLE_EVENTS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (
        "auth_events",
        "auth_log",
        (
            '2026-06-01 08:15:22 action=success user=sarah.chen src_ip=10.0.1.50 dest=prod-auth-01 app=portal',
            '2026-06-01 08:15:45 action=failure user=admin src_ip=203.0.113.42 dest=prod-auth-01 app=portal reason="invalid_password"',
            '2026-06-01 08:16:01 action=failure user=admin src_ip=203.0.113.42 dest=prod-auth-01 app=portal reason="invalid_password"',
            '2026-06-01 08:16:18 action=failure user=admin src_ip=203.0.113.42 dest=prod-auth-01 app=portal reason="invalid_password"',
            '2026-06-01 08:16:35 action=failure user=admin src_ip=203.0.113.42 dest=prod-auth-01 app=portal reason="account_locked"',
            '2026-06-01 08:20:00 action=success user=mike.johnson src_ip=10.0.1.51 dest=prod-auth-01 app=api',
            '2026-06-01 09:00:12 action=success user=sarah.chen src_ip=10.0.1.50 dest=prod-auth-01 app=portal',
            '2026-06-01 22:45:00 action=success user=unknown_contractor src_ip=185.220.101.33 dest=prod-auth-01 app=portal',
            '2026-06-01 23:10:00 action=failure user=root src_ip=185.220.101.33 dest=prod-auth-02 app=ssh reason="no_such_user"',
            '2026-06-01 23:10:05 action=failure user=admin src_ip=185.220.101.33 dest=prod-auth-02 app=ssh reason="invalid_password"',
            '2026-06-01 23:10:10 action=failure user=test src_ip=185.220.101.33 dest=prod-auth-02 app=ssh reason="no_such_user"',
            '2026-06-01 23:10:15 action=failure user=deploy src_ip=185.220.101.33 dest=prod-auth-02 app=ssh reason="invalid_password"',
        ),
    ),
    (
        "web_logs",
        "access_log",
        (
            '2026-06-01 08:00:01 method=GET uri=/api/v2/users status=200 response_time=45 bytes=1250 src_ip=10.0.1.50 user_agent="Mozilla/5.0"',
            '2026-06-01 08:00:05 method=POST uri=/api/v2/orders status=201 response_time=320 bytes=890 src_ip=10.0.1.51 user_agent="Mozilla/5.0"',
            '2026-06-01 08:00:12 method=GET uri=/api/v2/products status=500 response_time=5200 bytes=0 src_ip=10.0.1.52 user_agent="Mozilla/5.0"',
            '2026-06-01 08:00:15 method=GET uri=/api/v2/products status=500 response_time=5100 bytes=0 src_ip=10.0.1.53 user_agent="Mozilla/5.0"',
            '2026-06-01 08:00:22 method=GET uri=/api/v2/checkout status=200 response_time=2800 bytes=3200 src_ip=10.0.1.50 user_agent="Mozilla/5.0"',
            '2026-06-01 08:01:00 method=GET uri=/api/v2/health status=200 response_time=12 bytes=50 src_ip=10.0.0.1 user_agent="HealthCheck/1.0"',
            '2026-06-01 08:01:30 method=GET uri=/api/v2/products status=200 response_time=150 bytes=4500 src_ip=10.0.1.54 user_agent="Mozilla/5.0"',
            '2026-06-01 08:02:00 method=POST uri=/api/v2/orders status=400 response_time=85 bytes=200 src_ip=10.0.1.55 user_agent="Mozilla/5.0"',
        ),
    ),
    (
        "firewall_logs",
        "firewall_log",
        (
            '2026-06-01 08:00:00 action=allowed src_ip=10.0.1.50 dest_ip=10.0.2.10 dest_port=443 protocol=TCP rule=allow_https',
            '2026-06-01 08:00:05 action=blocked src_ip=203.0.113.42 dest_ip=10.0.2.10 dest_port=22 protocol=TCP rule=deny_external_ssh',
            '2026-06-01 08:00:10 action=blocked src_ip=198.51.100.77 dest_ip=10.0.2.10 dest_port=3389 protocol=TCP rule=deny_rdp',
            '2026-06-01 08:00:15 action=allowed src_ip=10.0.1.51 dest_ip=10.0.3.5 dest_port=5432 protocol=TCP rule=allow_db_internal',
            '2026-06-01 08:00:20 action=blocked src_ip=185.220.101.33 dest_ip=10.0.2.10 dest_port=22 protocol=TCP rule=deny_external_ssh',
            '2026-06-01 08:00:25 action=blocked src_ip=185.220.101.33 dest_ip=10.0.2.11 dest_port=22 protocol=TCP rule=deny_external_ssh',
        ),
    ),
    (
        "app_metrics",
        "app_metrics",
        (
            '2026-06-01 08:00:00 service=checkout-api endpoint=/api/v2/checkout response_time=250 cpu_pct=45 memory_mb=512 error_rate=0.02',
            '2026-06-01 08:00:00 service=product-api endpoint=/api/v2/products response_time=5200 cpu_pct=95 memory_mb=1024 error_rate=0.35',
            '2026-06-01 08:00:00 service=auth-service endpoint=/api/v2/auth response_time=80 cpu_pct=20 memory_mb=256 error_rate=0.01',
            '2026-06-01 08:05:00 service=checkout-api endpoint=/api/v2/checkout response_time=280 cpu_pct=48 memory_mb=515 error_rate=0.02',
            '2026-06-01 08:05:00 service=product-api endpoint=/api/v2/products response_time=180 cpu_pct=40 memory_mb=520 error_rate=0.01',
            '2026-06-01 08:05:00 service=auth-service endpoint=/api/v2/auth response_time=75 cpu_pct=18 memory_mb=255 error_rate=0.00',
        ),
    ),
    (
        "deploy_logs",
        "deploy_log",
        (
            '2026-05-30 14:00:00 service=product-api version=2.4.1 status=success deployer=mike.johnson environment=production duration_sec=120',
            '2026-05-31 09:30:00 service=checkout-api version=3.1.0 status=failed deployer=sarah.chen environment=production duration_sec=45 error="health_check_timeout"',
            '2026-05-31 10:00:00 service=checkout-api version=3.1.0 status=success deployer=sarah.chen environment=production duration_sec=130',
            '2026-06-01 11:00:00 service=auth-service version=1.8.2 status=success deployer=mike.johnson environment=staging duration_sec=90',
        ),
    ),
)

MACROS: tuple[tuple[str, str], ...] = (
    ("high_severity_filter", 'severity IN ("critical", "high")'),
    (
        "business_hours_only",
        'date_hour>=8 AND date_hour<=18 AND date_wday!="saturday" AND date_wday!="sunday"',
    ),
    ("exclude_internal_traffic", 'NOT src_ip IN ("10.0.0.*", "192.168.*")'),
    # Landmine: referenced by no saved search / alert → Mode B flags "orphaned macro".
    ("deprecated_geoip_filter", 'cidrmatch("0.0.0.0/0", src_ip)'),
)

# (lookup_table_filename, lookup_definition_name, local_csv_path)
LOOKUPS: tuple[tuple[str, str, str], ...] = (
    ("known_bad_ips.csv", "known_bad_ips", "known_bad_ips.csv"),
    ("service_owners.csv", "service_owners", "service_owners.csv"),
)

# (name, spl, cron_schedule)
SAVED_SEARCHES: tuple[tuple[str, str, str], ...] = (
    (
        "Daily Failed Login Summary",
        "index=auth_events action=failure | stats count by user, src_ip, reason | sort -count",
        "0 7 * * *",
    ),
    (
        "Top 10 Error Codes Last 24h",
        'index=web_logs status>=400 | top 10 status | eval description=case(status=400, "Bad Request", status=401, "Unauthorized", status=403, "Forbidden", status=404, "Not Found", status=500, "Internal Server Error", 1=1, "Other")',
        "0 */4 * * *",
    ),
    (
        "Slow API Response Times",
        "index=app_metrics response_time>2000 | stats avg(response_time) as avg_response_time, max(response_time) as max_response_time, count by endpoint, service | sort -avg_response_time",
        "0 * * * *",
    ),
    (
        "Unusual After-Hours Access",
        "index=auth_events (date_hour<6 OR date_hour>22) NOT `exclude_internal_traffic` | stats count by user, src_ip, app | sort -count",
        "0 6 * * *",
    ),
    (
        "Deployment Failure Rate",
        'index=deploy_logs | stats count(eval(status="failed")) as failures, count as total by service, version | eval failure_rate=round(failures/total*100, 1) | sort -failure_rate',
        "0 0 * * *",
    ),
)

# (name, spl, cron_schedule, severity, alert_condition)
# Alert severity in Splunk: 1=Info, 2=Low, 3=Medium, 4=High, 5=Critical
# Each entry: (name, spl, cron, severity, alert_condition, actions)
# ``actions`` is the comma-separated alert action list ("" = no action → Mode B
# flags "alert with no action"). The three real alerts carry "email" so they read
# as healthy; only the Disk Space landmine is left actionless.
ALERTS: tuple[tuple[str, str, str, int, str, str], ...] = (
    (
        "Critical: Multiple Failed Logins from Same IP",
        "index=auth_events action=failure `high_severity_filter` | stats count by src_ip | where count > 5 | lookup known_bad_ips ip AS src_ip OUTPUT threat_type, confidence",
        "*/5 * * * *",
        5,
        "search count > 0",
        "email",
    ),
    (
        "Warning: API Latency Above Threshold",
        "index=app_metrics `business_hours_only` response_time>3000 | stats avg(response_time) as avg_latency, count by service, endpoint | where avg_latency > 3000",
        "*/15 * * * *",
        3,
        "search count > 0",
        "email",
    ),
    (
        "Critical: Firewall Rule Violations",
        "index=firewall_logs action=blocked | stats count by src_ip, dest_port, rule | where count > 10 | lookup known_bad_ips ip AS src_ip OUTPUT threat_type",
        "*/5 * * * *",
        5,
        "search count > 0",
        "email",
    ),
    # Landmine: reads from the empty legacy_winlogs index → "alert on empty index".
    # Has an action so it ONLY trips the empty-index finding, not no-action.
    (
        "Legacy Windows Event Monitor",
        "index=legacy_winlogs EventCode=4625 | stats count by host, user",
        "*/10 * * * *",
        3,
        "search count > 0",
        "email",
    ),
    # Landmine: no action configured → "alert with no action". The "Warning:"
    # prefix makes discovery classify it as an alert (the MCP object shape omits
    # alert_type, so the name prefix is the reliable signal).
    (
        "Warning: Low Disk Space",
        "index=app_metrics disk_pct>90 | stats max(disk_pct) as max_disk by host",
        "*/30 * * * *",
        3,
        "search count > 0",
        "",
    ),
)


# ----- Dashboard SimpleXML ----------------------------------------------------

_DASH_APP_HEALTH = """<dashboard>
  <label>Application Health Overview</label>
  <description>API response times, error rates, HTTP status, recent deploys.</description>
  <row>
    <panel>
      <title>API Response Times</title>
      <chart>
        <search>
          <query>index=app_metrics | timechart span=5m avg(response_time) as avg_response_time by service</query>
          <earliest>-24h</earliest>
          <latest>now</latest>
        </search>
        <option name="charting.chart">line</option>
      </chart>
    </panel>
    <panel>
      <title>Error Rate by Service</title>
      <chart>
        <search>
          <query>index=app_metrics | timechart span=5m avg(error_rate) as avg_error_rate by service</query>
          <earliest>-24h</earliest>
          <latest>now</latest>
        </search>
        <option name="charting.chart">line</option>
      </chart>
    </panel>
  </row>
  <row>
    <panel>
      <title>HTTP Status Codes</title>
      <chart>
        <search>
          <query>index=web_logs | timechart span=5m count by status</query>
          <earliest>-24h</earliest>
          <latest>now</latest>
        </search>
        <option name="charting.chart">column</option>
        <option name="charting.chart.stackMode">stacked</option>
      </chart>
    </panel>
    <panel>
      <title>Recent Deployments</title>
      <table>
        <search>
          <query>index=deploy_logs | table _time, service, version, status, deployer, environment, duration_sec | sort -_time</query>
          <earliest>-7d</earliest>
          <latest>now</latest>
        </search>
      </table>
    </panel>
  </row>
</dashboard>
"""

_DASH_SECURITY = """<dashboard>
  <label>Security Posture Dashboard</label>
  <description>Failed logins, blocked traffic, top offending IPs, after-hours activity.</description>
  <row>
    <panel>
      <title>Failed Logins Over Time</title>
      <chart>
        <search>
          <query>index=auth_events action=failure | timechart span=15m count</query>
          <earliest>-24h</earliest>
          <latest>now</latest>
        </search>
        <option name="charting.chart">line</option>
      </chart>
    </panel>
    <panel>
      <title>Blocked Firewall Traffic</title>
      <chart>
        <search>
          <query>index=firewall_logs action=blocked | timechart span=15m count by rule</query>
          <earliest>-24h</earliest>
          <latest>now</latest>
        </search>
        <option name="charting.chart">column</option>
        <option name="charting.chart.stackMode">stacked</option>
      </chart>
    </panel>
  </row>
  <row>
    <panel>
      <title>Top Blocked IPs</title>
      <table>
        <search>
          <query>index=firewall_logs action=blocked | top 10 src_ip</query>
          <earliest>-24h</earliest>
          <latest>now</latest>
        </search>
      </table>
    </panel>
    <panel>
      <title>After-Hours Activity</title>
      <table>
        <search>
          <query>index=auth_events (date_hour&lt;6 OR date_hour&gt;22) | stats count by user, src_ip, app | sort -count</query>
          <earliest>-24h</earliest>
          <latest>now</latest>
        </search>
      </table>
    </panel>
  </row>
</dashboard>
"""

_DASH_INFRA = """<dashboard>
  <label>Infrastructure Performance</label>
  <description>CPU, memory, and endpoint latency by service.</description>
  <row>
    <panel>
      <title>CPU Usage by Service</title>
      <chart>
        <search>
          <query>index=app_metrics | timechart span=5m avg(cpu_pct) as avg_cpu by service</query>
          <earliest>-24h</earliest>
          <latest>now</latest>
        </search>
        <option name="charting.chart">line</option>
      </chart>
    </panel>
    <panel>
      <title>Memory Usage</title>
      <chart>
        <search>
          <query>index=app_metrics | timechart span=5m avg(memory_mb) as avg_memory by service</query>
          <earliest>-24h</earliest>
          <latest>now</latest>
        </search>
        <option name="charting.chart">line</option>
      </chart>
    </panel>
  </row>
  <row>
    <panel>
      <title>Slow Endpoints</title>
      <table>
        <search>
          <query>index=app_metrics response_time&gt;1000 | stats count, avg(response_time) as avg_response_time by endpoint | sort -avg_response_time</query>
          <earliest>-24h</earliest>
          <latest>now</latest>
        </search>
      </table>
    </panel>
  </row>
</dashboard>
"""

# (dashboard_name, simple_xml)
DASHBOARDS: tuple[tuple[str, str], ...] = (
    ("application_health_overview", _DASH_APP_HEALTH),
    ("security_posture_dashboard", _DASH_SECURITY),
    ("infrastructure_performance", _DASH_INFRA),
)


# ============================================================================
# Splunk REST client
# ============================================================================


class SplunkAuthError(RuntimeError):
    """Raised when token login against Splunk fails."""


class SplunkClient:
    """Thin wrapper over ``requests.Session`` for the Splunk management API.

    Authentication is token-based: ``login()`` POSTs the credentials to
    ``/services/auth/login`` and stores the returned session key as a
    persistent ``Authorization: Splunk <key>`` header on the session. We
    avoid HTTP Basic Auth because Splunk has known interop quirks with it
    for passwords that contain certain ASCII characters (notably ``@``).
    """

    APP_NAMESPACE = "/servicesNS/nobody/search"

    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        *,
        scheme: str = "https",
    ) -> None:
        self.base = f"{scheme}://{host}:{port}"
        self._username = username
        # Stored verbatim — the value is sent in a form-encoded POST body
        # (application/x-www-form-urlencoded), which requests handles
        # correctly for any ASCII characters including '@', '&', ':', '/', etc.
        # No manual URL-encoding is needed (and doing it would double-encode).
        self._password = password
        self.session = requests.Session()
        self.session.verify = False
        # JSON for all GETs; some POSTs return XML by default — we don't care
        # about the response body when creating, only the status code.

    # ---- authentication ----

    def login(self) -> str:
        """Exchange username/password for a session key. Sets the auth header.

        Returns the session key (also stored on ``self.session.headers``).
        Raises :class:`SplunkAuthError` on any failure, with the HTTP status
        code and (truncated) response body included for debugging.
        """
        url = f"{self.base}/services/auth/login"
        try:
            r = self.session.post(
                url,
                data={
                    "username": self._username,
                    "password": self._password,
                    "output_mode": "json",
                },
                timeout=30,
            )
        except requests.RequestException as exc:
            raise SplunkAuthError(f"network error contacting {url}: {exc}") from exc

        if r.status_code != 200:
            body = r.text.strip()
            if len(body) > 500:
                body = body[:500] + "..."
            raise SplunkAuthError(
                f"login failed: HTTP {r.status_code}\n"
                f"  URL : {url}\n"
                f"  body: {body or '(empty)'}"
            )

        try:
            payload = r.json()
        except ValueError as exc:
            raise SplunkAuthError(
                f"login returned non-JSON body (status {r.status_code}): {r.text[:300]}"
            ) from exc

        session_key = payload.get("sessionKey") or payload.get("session_key")
        if not session_key:
            raise SplunkAuthError(
                f"login succeeded but no sessionKey in response: {payload!r}"
            )

        self.session.headers["Authorization"] = f"Splunk {session_key}"
        return session_key

    # ---- basic verbs ----

    def get_json(self, path: str, **params: Any) -> dict[str, Any]:
        params.setdefault("output_mode", "json")
        params.setdefault("count", 0)
        r = self.session.get(f"{self.base}{path}", params=params, timeout=30)
        r.raise_for_status()
        return r.json()

    def post(
        self,
        path: str,
        data: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        timeout: int = 60,
    ) -> requests.Response:
        # Splunk wants form-encoded list values as repeated keys. requests
        # handles that natively when you pass a list value.
        return self.session.post(
            f"{self.base}{path}",
            data=data,
            files=files,
            params=params,
            timeout=timeout,
        )

    # ---- listing ----

    def list_names(self, path: str) -> set[str]:
        try:
            data = self.get_json(path)
        except Exception as exc:
            print(f"    (warning: failed to list {path}: {exc})")
            return set()
        return {e["name"] for e in data.get("entry", []) if isinstance(e, dict) and "name" in e}

    # ---- specialty: event ingestion ----

    def ingest_event(self, index: str, sourcetype: str, source: str, body: str) -> None:
        """POST a single raw event to ``/services/receivers/simple``.

        The body is treated as one event. We POST per-event so that newly
        defined sourcetypes don't need explicit line-breaking rules.
        """
        params = {"index": index, "sourcetype": sourcetype, "source": source}
        r = self.session.post(
            f"{self.base}/services/receivers/simple",
            params=params,
            data=body.encode("utf-8"),
            headers={"Content-Type": "text/plain"},
            timeout=30,
        )
        r.raise_for_status()

    # ---- connection sanity check ----

    def check_connection(self) -> str:
        """Hit ``/services/server/info`` to confirm auth + reachability."""
        info = self.get_json("/services/server/info")
        entries = info.get("entry", [])
        if not entries:
            return "unknown"
        content = entries[0].get("content", {})
        version = content.get("version") or "unknown"
        server = content.get("serverName") or "unknown"
        return f"Splunk {version} on {server}"


# ============================================================================
# Counter
# ============================================================================


@dataclass
class Counter:
    created: int = 0
    skipped: int = 0
    failed: int = 0
    failures: list[str] = field(default_factory=list)

    def ok(self) -> None:
        self.created += 1

    def skip(self) -> None:
        self.skipped += 1

    def fail(self, what: str, exc: Exception) -> None:
        self.failed += 1
        self.failures.append(f"{what}: {exc}")


# ============================================================================
# Step functions
# ============================================================================


def _describe_response(r: requests.Response) -> str:
    body = r.text.strip()
    if len(body) > 240:
        body = body[:240] + "..."
    return f"HTTP {r.status_code} — {body}"


def _is_already_exists(r: requests.Response) -> bool:
    if r.status_code != 409:
        return False
    return "already exists" in r.text.lower()


def step_indexes(client: SplunkClient, counter: Counter) -> None:
    print("[1/7] Creating indexes...")
    existing = client.list_names("/services/data/indexes")
    for name in INDEXES:
        if name in existing:
            print(f"  - {name} already exists (skipped)")
            counter.skip()
            continue
        try:
            r = client.post("/services/data/indexes", data={"name": name})
            if r.status_code in (200, 201):
                print(f"  ✓ {name} created")
                counter.ok()
            elif _is_already_exists(r):
                print(f"  - {name} already exists (skipped)")
                counter.skip()
            else:
                raise RuntimeError(_describe_response(r))
        except Exception as exc:
            print(f"  ✗ {name} failed: {exc}")
            counter.fail(f"index {name}", exc)


def step_ingest(client: SplunkClient, counter: Counter) -> None:
    print("[2/7] Ingesting sample events...")
    for index, sourcetype, events in SAMPLE_EVENTS:
        source = f"cairn-demo:{index}"
        sent = 0
        errors = 0
        for line in events:
            try:
                client.ingest_event(index, sourcetype, source, line)
                sent += 1
            except Exception as exc:
                errors += 1
                if errors == 1:
                    # Only log the first error per index — avoids screen spam.
                    print(f"    (warning: ingest error for {index}: {exc})")
        if sent > 0 and errors == 0:
            print(f"  ✓ {index}: {sent} events ingested (sourcetype={sourcetype})")
            counter.ok()
        elif sent > 0:
            print(f"  ~ {index}: {sent} ok, {errors} failed")
            counter.ok()
        else:
            print(f"  ✗ {index}: 0 ingested ({errors} errors)")
            counter.fail(f"ingest {index}", RuntimeError(f"{errors} errors"))


def step_macros(client: SplunkClient, counter: Counter) -> None:
    print("[3/7] Creating macros...")
    path = f"{client.APP_NAMESPACE}/admin/macros"
    existing = client.list_names(path)
    for name, definition in MACROS:
        if name in existing:
            print(f"  - {name} already exists (skipped)")
            counter.skip()
            continue
        try:
            r = client.post(path, data={"name": name, "definition": definition})
            if r.status_code in (200, 201):
                print(f"  ✓ {name} created")
                counter.ok()
            elif _is_already_exists(r):
                print(f"  - {name} already exists (skipped)")
                counter.skip()
            else:
                raise RuntimeError(_describe_response(r))
        except Exception as exc:
            print(f"  ✗ {name} failed: {exc}")
            counter.fail(f"macro {name}", exc)


def step_lookups(client: SplunkClient, counter: Counter) -> None:
    print("[4/7] Uploading lookup CSVs and creating lookup definitions...")
    csv_dir = Path(__file__).resolve().parent
    files_path = f"{client.APP_NAMESPACE}/data/lookup-table-files"
    defs_path = f"{client.APP_NAMESPACE}/data/transforms/lookups"

    existing_files = client.list_names(files_path)
    existing_defs = client.list_names(defs_path)

    for csv_filename, def_name, local_filename in LOOKUPS:
        csv_path = csv_dir / local_filename
        if not csv_path.is_file():
            print(f"  ✗ {csv_filename} skipped: source file {csv_path} not found")
            counter.fail(f"lookup file {csv_filename}", FileNotFoundError(str(csv_path)))
            continue

        # ---- upload the CSV ----
        # Splunk requires the destination filename in the URL path (not the
        # form body) for this endpoint. The file content is sent as the
        # ``eai:data`` multipart field.
        if csv_filename in existing_files:
            print(f"  - lookup file {csv_filename} already exists (skipped)")
            counter.skip()
        else:
            upload_path = f"{files_path}/{csv_filename}"
            try:
                with csv_path.open("rb") as fh:
                    r = client.post(upload_path, files={"eai:data": (csv_filename, fh)})
                if r.status_code in (200, 201):
                    print(f"  ✓ lookup file {csv_filename} uploaded")
                    counter.ok()
                elif _is_already_exists(r):
                    print(f"  - lookup file {csv_filename} already exists (skipped)")
                    counter.skip()
                else:
                    raise RuntimeError(_describe_response(r))
            except Exception as exc:
                print(f"  ✗ lookup file {csv_filename} failed: {exc}")
                counter.fail(f"lookup file {csv_filename}", exc)
                continue

        # ---- create the lookup definition (transforms) ----
        if def_name in existing_defs:
            print(f"  - lookup def {def_name} already exists (skipped)")
            counter.skip()
            continue
        try:
            r = client.post(
                defs_path,
                data={
                    "name": def_name,
                    "filename": csv_filename,
                },
            )
            if r.status_code in (200, 201):
                print(f"  ✓ lookup def {def_name} created")
                counter.ok()
            elif _is_already_exists(r):
                print(f"  - lookup def {def_name} already exists (skipped)")
                counter.skip()
            else:
                raise RuntimeError(_describe_response(r))
        except Exception as exc:
            print(f"  ✗ lookup def {def_name} failed: {exc}")
            counter.fail(f"lookup def {def_name}", exc)


def step_saved_searches(client: SplunkClient, counter: Counter) -> None:
    print("[5/7] Creating saved searches...")
    path = f"{client.APP_NAMESPACE}/saved/searches"
    existing = client.list_names(path)
    for name, spl, cron in SAVED_SEARCHES:
        if name in existing:
            print(f"  - {name!r} already exists (skipped)")
            counter.skip()
            continue
        try:
            r = client.post(
                path,
                data={
                    "name": name,
                    "search": spl,
                    "cron_schedule": cron,
                    "is_scheduled": 1,
                    "dispatch.earliest_time": "-24h",
                    "dispatch.latest_time": "now",
                },
            )
            if r.status_code in (200, 201):
                print(f"  ✓ {name!r} created")
                counter.ok()
            elif _is_already_exists(r):
                print(f"  - {name!r} already exists (skipped)")
                counter.skip()
            else:
                raise RuntimeError(_describe_response(r))
        except Exception as exc:
            print(f"  ✗ {name!r} failed: {exc}")
            counter.fail(f"saved search {name}", exc)


def step_alerts(client: SplunkClient, counter: Counter) -> None:
    print("[6/7] Creating alerts...")
    path = f"{client.APP_NAMESPACE}/saved/searches"
    existing = set(client.list_names(path))
    for name, spl, cron, severity, alert_cond, actions in ALERTS:
        # Editable fields. ``actions`` is enabled via per-action flags so the
        # saved search's computed ``actions`` field reports them — that's what
        # Mode B reads. An empty ``actions`` leaves the alert action-less.
        data: dict[str, Any] = {
            "search": spl,
            "cron_schedule": cron,
            "is_scheduled": 1,
            "alert_type": "always",
            "alert.severity": severity,
            "alert.suppress": 0,
            "alert_condition": alert_cond,
            "alert.track": 1,
            "dispatch.earliest_time": "-15m",
            "dispatch.latest_time": "now",
        }
        if actions:
            # Set the ``actions`` summary field directly — this Splunk build
            # accepts it and reports it back, whereas ``action.<name>=1/true``
            # is silently dropped. That field is what Mode B reads.
            data["actions"] = actions
            if "email" in actions:
                data["action.email.to"] = "soc@demo.local"
        try:
            # Create, or update in place so a re-run cleans previously
            # action-less / nobody-owned alerts (the step used to skip existing).
            if name in existing:
                r = client.post(f"{path}/{quote(name, safe='')}", data=data)
                verb = "updated"
            else:
                r = client.post(path, data={"name": name, **data})
                verb = "created"
            if r.status_code in (200, 201):
                # Give it a real owner so healthy alerts don't trip "no owner".
                client.post(
                    f"{path}/{quote(name, safe='')}/acl",
                    data={"owner": "admin", "sharing": "app"},
                )
                print(f"  ✓ {name!r} {verb} (severity={severity}, actions={actions or 'none'})")
                counter.ok()
            elif _is_already_exists(r):
                print(f"  - {name!r} already exists (skipped)")
                counter.skip()
            else:
                raise RuntimeError(_describe_response(r))
        except Exception as exc:
            print(f"  ✗ {name!r} failed: {exc}")
            counter.fail(f"alert {name}", exc)


def step_dashboards(client: SplunkClient, counter: Counter) -> None:
    print("[7/7] Creating dashboards...")
    path = f"{client.APP_NAMESPACE}/data/ui/views"
    existing = client.list_names(path)
    for name, xml in DASHBOARDS:
        if name in existing:
            print(f"  - {name} already exists (skipped)")
            counter.skip()
            continue
        try:
            r = client.post(path, data={"name": name, "eai:data": xml})
            if r.status_code in (200, 201):
                print(f"  ✓ {name} created")
                counter.ok()
            elif _is_already_exists(r):
                print(f"  - {name} already exists (skipped)")
                counter.skip()
            else:
                raise RuntimeError(_describe_response(r))
        except Exception as exc:
            print(f"  ✗ {name} failed: {exc}")
            counter.fail(f"dashboard {name}", exc)


# ============================================================================
# Main
# ============================================================================


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Set up the Cairn demo data in a local Splunk instance.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--scheme", default="https", choices=("https", "http"),
                   help="URL scheme for the Splunk management port")
    p.add_argument("--host", default="localhost", help="Splunk management host")
    p.add_argument("--port", type=int, default=8089, help="Splunk management port")
    p.add_argument("--username", default="admin", help="Splunk admin username")
    p.add_argument("--password", required=True, help="Splunk admin password")
    return p.parse_args(list(argv) if argv is not None else None)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    client = SplunkClient(
        args.host,
        args.port,
        args.username,
        args.password,
        scheme=args.scheme,
    )

    print(f"Authenticating to {args.scheme}://{args.host}:{args.port} as {args.username}...")
    try:
        client.login()
    except SplunkAuthError as exc:
        print(f"  ✗ authentication failed.\n{exc}")
        return 2
    except Exception as exc:
        print(f"  ✗ unexpected error during login: {exc}")
        return 2
    print("  ✓ session key acquired")

    try:
        descr = client.check_connection()
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "?"
        body = exc.response.text.strip()[:300] if exc.response is not None else ""
        print(f"  ✗ /services/server/info failed (HTTP {status}): {body}")
        return 2
    except Exception as exc:
        print(f"  ✗ /services/server/info failed: {exc}")
        return 2
    print(f"  ✓ connected — {descr}\n")

    counter = Counter()
    steps = (
        step_indexes,
        step_ingest,
        step_macros,
        step_lookups,
        step_saved_searches,
        step_alerts,
        step_dashboards,
    )
    for step in steps:
        try:
            step(client, counter)
        except Exception as exc:
            # A step crashed entirely (shouldn't happen — each step catches
            # per-object errors — but be defensive).
            print(f"  ✗ step {step.__name__} crashed: {exc}")
            counter.fail(step.__name__, exc)
        print()

    print("=" * 60)
    print(
        f"Done. {counter.created} created, "
        f"{counter.skipped} skipped, "
        f"{counter.failed} failed."
    )
    if counter.failures:
        print("\nFailures:")
        for f in counter.failures:
            print(f"  - {f}")
    print("=" * 60)
    return 0 if counter.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
