## Critical Alerts & What They Mean

### Critical Alerts & What They Mean
The following alerts are critical and require immediate attention from the on-call engineer.

#### Critical: Firewall Rule Violations
This alert is triggered when the firewall blocks traffic more than 10 times from the same source IP address, destination port, and rule. The data for this alert comes from the `firewall_logs` index, which stores all firewall events, and is enriched by the `known_bad_ips` lookup table to identify potential threats. When this alert fires at 3am, the on-call engineer should investigate the source IP addresses and rules involved to determine if they are related to known malicious activity and take necessary actions to prevent further potential security breaches.

#### Critical: Multiple Failed Logins from Same IP
This alert is triggered when there are more than 5 failed login attempts from the same IP address, and the attempts are filtered by a macro called `high_severity_filter`. The data for this alert comes from the `auth_events` index, which stores all authentication events, and is enriched by the `known_bad_ips` lookup table to identify potential threats. When this alert fires at 3am, the on-call engineer should investigate the IP addresses involved to determine if they are related to known bad actors and take necessary actions to prevent further potential security breaches, such as blocking the IP address or notifying the security team.

## Your Data Landscape

### Web Traffic
* **web_logs**: 16 events, primary sourcetype `access_log`, search for website usage patterns and user engagement metrics.
### Authentication and Authorization
* **auth_events**: 24 events, primary sourcetype `auth_log`, search for login attempts, failed authentications, and user access control issues.
* **firewall_logs**: 12 events, primary sourcetype `firewall_log`, search for incoming traffic patterns, blocked requests, and potential security threats.
### Infrastructure Metrics
* **app_metrics**: 12 events, primary sourcetype `app_metrics`, search for performance issues, latency, and error rates in applications.
### Deployment Logs
* **deploy_logs**: 8 events, primary sourcetype `deploy_log`, search for deployment history, success/failure rates, and environmental changes.
### Misc
* **history**: 0 events, no primary sourcetype, search for nothing as this index is empty and not configured for data storage.
* **main**: 18886 events, no primary sourcetype, search for generic system events, but be aware that this index may contain a mix of different data types and sourcetypes.
* **splunklogger**: 0 events, no primary sourcetype, search for nothing as this index is empty and not configured for data storage.
* **summary**: 0 events, no primary sourcetype, search for nothing as this index is empty and not configured for data storage.

## Your Team's Dashboards

### Application Health Overview
The Application Health Overview dashboard answers the question: "What is the current health and performance of our application?" 
An engineer should look for any indications of errors, latency issues, or other performance problems on this dashboard, but since there are no panels or SPLs available, the dashboard is currently empty and not providing any useful information.

### Infrastructure Performance
The Infrastructure Performance dashboard answers the question: "How is our infrastructure performing in terms of resource utilization and throughput?" 
As there are no panels or SPLs, an engineer won't be able to find any meaningful data on this dashboard, and it should be populated with relevant metrics and logs to provide insights into infrastructure performance.

### Security Posture Dashboard
The Security Posture Dashboard answers the question: "What is our current security posture, and are there any potential vulnerabilities or threats?" 
This dashboard is also empty, with no panels or SPLs to provide information on security-related events, threats, or vulnerabilities, so an engineer should look for this dashboard to be populated with relevant security metrics and data in the future.

## The Shorthand

### Shorthand 
The shorthand section contains macros and lookups that simplify Splunk queries and improve readability. 

#### Macros
Macros are reusable pieces of code that encode specific behaviors. 
* `business_hours_only`: This macro filters events to only those occurring between 8am and 6pm on weekdays. Although it's not currently used in any searches, it's likely intended to help analyze traffic or usage patterns during typical working hours. 
* `exclude_internal_traffic`: This macro excludes events with source IP addresses within the private IP ranges (10.0.0.* and 192.168.*). It's not currently used, but its purpose is to ignore internal network traffic when analyzing data. 
* `high_severity_filter`: This macro filters events with high or critical severity levels. It's used in the "Critical: Multiple Failed Logins from Same IP" search to focus on severe security incidents.

#### Lookups
Lookups are reference tables that map values to additional information. 
* `known_bad_ips.csv`: This lookup contains a list of known malicious IP addresses. It's used in the "Critical: Firewall Rule Violations" and "Critical: Multiple Failed Logins from Same IP" searches to identify potential security threats. 
* `service_owners.csv`: This lookup maps services to their respective owners, but it's not currently used in any searches. Its purpose might be to facilitate communication or assignment of responsibilities when issues arise.

## Who Knows What

Since there are no ownership signals provided, there is no specific guidance on who to ask. If you have any questions or need help, you can try reaching out to your team lead or supervisor for more information on who to contact for specific topics. 

As more information becomes available, this section will be updated to include the relevant owners, the artifacts they are responsible for, and any specific tasks or reports they run, such as those related to `usage_count_24h`.