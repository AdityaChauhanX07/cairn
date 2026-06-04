## Critical Alerts & What They Mean

### Critical: Firewall Rule Violations
This alert is triggered when more than 10 blocked traffic events are detected from the same source IP address, destination port, and firewall rule within the `firewall_logs` index. The data feeding this alert comes from your firewall devices, which log blocked traffic events into the `firewall_logs` index. When this alert fires at 3am, the on-call engineer should investigate the source IP addresses and destination ports that are generating the blocked traffic, and check the `known_bad_ips` lookup table to see if these IP addresses are known to be malicious.

### Critical: Multiple Failed Logins from Same IP
This alert is triggered when more than 5 failed login attempts are detected from the same source IP address within the `auth_events` index, and the events pass the `high_severity_filter` macro. The data feeding this alert comes from authentication-related events, such as login attempts, which are logged into the `auth_events` index. When this alert fires at 3am, the on-call engineer should investigate the source IP addresses that are generating the failed login attempts, check the `known_bad_ips` lookup table to see if these IP addresses are known to be malicious, and consider blocking or blacklisting the IP addresses to prevent further brute-force login attacks.

## Your Data Landscape

### Authentication and Authorization
* **auth_events**: 24 events, sourcetype `auth_log`, search for login attempts or authentication failures.
* **firewall_logs**: 12 events, sourcetype `firewall_log`, search for blocked traffic or potential security threats.

### Infrastructure and Application Metrics
* **app_metrics**: 12 events, sourcetype `app_metrics`, search for performance issues or application errors.
* **main**: 18886 events, unknown sourcetype, search for general system logs or unknown data sources.

### Web Traffic
* **web_logs**: 16 events, sourcetype `access_log`, search for website usage patterns or potential issues.

### Deployment and Change Management
* **deploy_logs**: 8 events, sourcetype `deploy_log`, search for deployment history or issues during deployment.

### Unused or Internal Indexes
* **history**: 0 events, unknown sourcetype, ignored.
* **splunklogger**: 0 events, unknown sourcetype, ignored.
* **summary**: 0 events, unknown sourcetype, ignored.

## Your Team's Dashboards

### Application Health Overview
The Application Health Overview dashboard answers the question: "What is the overall health and performance of my application?" 
An engineer should look for indicators of application performance, such as error rates, response times, and system resource utilization, although with no panel SPLs available, there's no data to review.

### Infrastructure Performance
The Infrastructure Performance dashboard answers the question: "How is my infrastructure performing in terms of resource utilization and system health?" 
An engineer should look for metrics on CPU usage, memory utilization, disk usage, and network traffic, but since there are no panels, no specific data can be analyzed.

### Security Posture Dashboard
The Security Posture Dashboard answers the question: "What is my current security posture, and are there any potential vulnerabilities or threats?" 
An engineer should look for visualizations of security-related data, such as threat alerts, system vulnerabilities, and authentication attempts, but without any panels or SPLs, no assessment can be made.

## The Shorthand

### Shorthand Explanation
The shorthand section contains macros and lookups that simplify Splunk searches and provide reusable blocks of logic. 

The `business_hours_only` macro filters events to only those that occur between 8am and 6pm, Monday through Friday, based on the `date_hour` and `date_wday` fields. However, it is not currently used by any artifacts.

The `exclude_internal_traffic` macro filters out events with source IP addresses in the `10.0.0.*` and `192.168.*` ranges. Like `business_hours_only`, this macro is not currently used by any artifacts.

In contrast, the `high_severity_filter` macro is used by the "Critical: Multiple Failed Logins from Same IP" artifact to filter events with a severity of either "critical" or "high".

The `known_bad_ips.csv` lookup is used by the "Critical: Firewall Rule Violations" and "Critical: Multiple Failed Logins from Same IP" artifacts to check IP addresses against a list of known bad IPs.

The `service_owners.csv` lookup is not currently used by any artifacts, but can be used to map services to their respective owners.

## Who Knows What

There are no ownership signals defined, so there is no specific guidance on who to ask for help. As you navigate the onboarding process, you may need to reach out to various teams or individuals for support, but for now, please refer to general support channels for assistance.