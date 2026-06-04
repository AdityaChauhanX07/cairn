## Critical Alerts & What They Mean

### Critical Alerts & What They Mean
The `Critical: Firewall Rule Violations` alert is triggered when more than 10 blocked traffic events are detected from the same source IP, destination port, and rule in the `firewall_logs` index. This suggests potential malicious activity that is being repeatedly blocked by the firewall. When this alert fires at 3am, the on-call engineer should investigate the source IP address and the specific rule that triggered the block to determine if it's a genuine security threat.

The `Critical: Multiple Failed Logins from Same IP` alert is triggered when more than 5 failed authentication attempts are detected from the same IP address in the `auth_events` index, and the events match a predefined `high_severity_filter`. This could indicate a brute-force login attempt or other suspicious activity. When this alert fires, the on-call engineer should check the IP address and the type of threat it's associated with, using the `known_bad_ips` lookup table, to determine the best course of action to prevent further unauthorized access attempts.

### Dependency Chains

**Dependency Chain:**

```
alert: Critical: Firewall Rule Violations
  → lookup: known_bad_ips.csv
  → index: firewall_logs
```

**Dependency Chain:**

```
alert: Critical: Multiple Failed Logins from Same IP
  → macro: high_severity_filter
  → lookup: known_bad_ips.csv
  → index: auth_events
```

## Your Data Landscape

### Infra Metrics
* `app_metrics` (12 events, `app_metrics` sourcetype): Search for application performance and health metrics.
* `firewall_logs` (12 events, `firewall_log` sourcetype): Investigate network security and allowed/denied traffic.

### Authentication
* `auth_events` (24 events, `auth_log` sourcetype): Analyze login attempts, authentication failures, and user access patterns.

### Web Traffic
* `web_logs` (16 events, `access_log` sourcetype): Examine website usage, user behavior, and potential security issues.

### Deployment
* `deploy_logs` (8 events, `deploy_log` sourcetype): Monitor and troubleshoot deployment processes and outcomes.

### Uncategorized
* `main` (18886 events): A catch-all index, potentially containing diverse data types and requiring further filtering.
* `history`, `splunklogger`, `summary` (0 events each): Currently empty indexes with no defined purpose or sourcetypes.

## Your Team's Dashboards

### Application Health Overview
The Application Health Overview dashboard answers the question: "What is the overall health and performance of our application?" 
An engineer should look for any errors or anomalies in the application's performance, but since this dashboard is currently empty, they should work with the team to design and populate it with relevant panels and metrics.

### Infrastructure Performance
The Infrastructure Performance dashboard answers the question: "How is our infrastructure performing, and are there any resource bottlenecks or issues?" 
An engineer should review the dashboard for signs of infrastructure overload, such as high CPU usage or memory consumption, but as the dashboard is currently empty, they should collaborate with the team to create meaningful panels and visualizations.

### Security Posture Dashboard
The Security Posture Dashboard answers the question: "What is our current security posture, and are there any potential vulnerabilities or threats?" 
An engineer should examine the dashboard for any indications of security breaches, suspicious activity, or unpatched vulnerabilities, but given the empty state of the dashboard, they should work with the team to develop and add relevant security metrics and alerts.

## The Shorthand

The shorthand section in Splunk is used to define macros and lookups that can be reused throughout the application to simplify searches and provide additional context. 

A macro named `business_hours_only` is defined but not currently used by any artifacts. If used, it would filter results to only include events that occurred between 8am and 6pm, Monday through Friday, by checking the `date_hour` and `date_wday` fields.

The `exclude_internal_traffic` macro is also defined but not used by any artifacts. Its purpose is to exclude internal IP addresses (those starting with `10.0.0.` or `192.168.`) from search results by checking the `src_ip` field.

In contrast, the `high_severity_filter` macro is used by the "Critical: Multiple Failed Logins from Same IP" artifact. It filters events to only include those with a severity of "critical" or "high".

Two lookups are defined: `known_bad_ips.csv` and `service_owners.csv`. The `known_bad_ips.csv` lookup is used by the "Critical: Firewall Rule Violations" and "Critical: Multiple Failed Logins from Same IP" artifacts, implying that it contains a list of IP addresses known to be malicious. The `service_owners.csv` lookup is not currently used by any artifacts.

These macros and lookups provide a way to encode specific behaviors and knowledge about the data, making it easier to write effective searches and alerts in Splunk. By reusing these definitions, users can avoid duplicating effort and ensure consistency across different searches and applications.

## Who Knows What

Since there are no ownership signals provided, there is no specific guidance on who to ask for various topics. As you begin working with Splunk, it's likely that you'll discover key contacts and owners within your organization who can provide assistance on different aspects of Splunk usage. Keep in mind that typical roles might include:
- IT or Operations teams for infrastructure and system-related queries
- Data Analysts or Scientists for data manipulation and analysis questions
- Security teams for matters related to security information and event management (SIEM)
For now, it's recommended to reach out to your team lead, supervisor, or initial point of contact for guidance on who to ask for specific Splunk-related questions within your organization.