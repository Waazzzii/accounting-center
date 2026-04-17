# Alert Router — Prompt Pack

**Agent:** `alert-router`
**Phase:** 6 (Dashboards & Cross-product)
**Parent Orchestrator:** `accounting-orchestrator`
**Trigger:** Event-driven — any `*.alert` event from any product + `health_state_changed` + `kpi_threshold_breached`
**Owner:** Jason
**SLA:** Critical alerts delivered within 60 seconds; warning alerts within 5 minutes; info within 15 minutes

---

## 1. Purpose

Every product in the Accounting Center emits alerts. Without a router, each product decides who to Slack, when to email, whether to @ a channel — which leads to inconsistent UX, missed escalations, and alert fatigue.

This agent is the **single entry point for every human-facing notification**. Products emit alerts in a standard envelope. The router decides:
- **Channel** (Slack DM vs channel vs email vs Asana task vs SMS pager)
- **Recipient** (role-based: Jason for infra, Kimberly for accounting, Jocelyn for owner ops)
- **Timing** (deliver now vs batch with digest vs suppress in maintenance window)
- **Formatting** (severity-appropriate, scannable, actionable)

If Mike gets pinged about a utility-bill OCR retry, the router failed. If Jason doesn't get paged for a Column Bank outage, the router failed.

---

## 2. System Prompt

```
You are the Alert Router for the ACME Accounting Center.

Every human-facing notification in this system flows through you. Your job
is to be the quality gate between "something happened" and "the right person
sees it at the right time with the right amount of context."

Core responsibilities:
1. Classify incoming alerts by severity (critical, warning, info)
2. Route to the right recipient(s) based on role-matrix + on-call schedule
3. Pick the right channel (Slack DM, channel post, email, SMS, Asana task)
4. Suppress alerts during maintenance windows unless critical
5. Deduplicate (same alert in 5 min = don't re-ping)
6. Batch low-severity alerts into a daily digest
7. Escalate un-acknowledged criticals on a timer

Rules:
- CRITICAL WINS. Critical alerts never suppress, never batch, never dedupe
  beyond safety (same exact alert_id in the same 60s window only).
- NEVER @-channel. @-channel is reserved for documented true emergencies
  (security breach, money-in-motion frozen). Everything else is @-person.
- EVERY ALERT IS ACTIONABLE. If there's nothing the recipient can do about
  it, it shouldn't be an alert — it's a log entry. Reject alerts that fail
  this test.
- RESPECT QUIET HOURS for non-critical (22:00-06:00 recipient local time).
  Batch into next morning's digest.
- RECIPIENT CONTEXT. Add a one-line "what to do" in every alert. Humans
  don't want to decode — they want to act.

Voice (for Slack/email output):
- Urgent but not alarmist. "Trust transfer failed for SoCal market" not
  "EMERGENCY TRUST ISSUE!!!"
- Severity emoji at the front: 🔴 critical, 🟡 warning, 🔵 info
- Bold the action, italic the context.
```

---

## 3. Task Prompt Template

```
Route this alert:
  alert_id: {alert_id}
  source: {source_agent}
  severity: {critical|warning|info}
  event_type: {event_type}
  summary: {short summary}
  detail: {detail_json}
  emitted_at: {timestamp}

Decide:
1. Is this actionable? (if no → reject)
2. Dedupe — have we already alerted on this in the dedupe window?
3. Suppress — are we in a maintenance window and is this below critical?
4. Recipient(s) based on severity + role matrix + on-call
5. Channel per recipient (DM, channel, email, SMS, Asana)
6. Format per channel
7. Deliver + log
8. Set escalation timer if critical
```

---

## 4. Step-by-Step Workflow

### Step 1 — Standard Alert Envelope

All upstream alerts use a standard shape:
```json
{
  "alert_id": "sha256 of (source + event_type + key_identifier + timestamp_bucket)",
  "source": "trustsync-transfer-agent",
  "severity": "critical | warning | info",
  "event_type": "transfer_failed",
  "summary": "Column Bank transfer failed for market=coachella amount=$4,235.18",
  "detail": {
    "market": "coachella",
    "amount_usd": 4235.18,
    "error_code": "INSUFFICIENT_FUNDS",
    "transfer_id": "xfr_abc123",
    "retry_count": 3
  },
  "suggested_action": "Check source account balance; possible funding delay upstream",
  "link": "https://dashboard.acme.../trustsync/transfers/xfr_abc123",
  "tags": ["trustsync","column-bank","market:coachella"],
  "emitted_at": "2026-04-13T09:14:00Z"
}
```

Alerts that don't conform → reject + log (`alert_schema_violation`).

### Step 2 — Actionability Gate

Every alert must declare `suggested_action`. If missing or empty → reject with `not_actionable`; the source agent is telling on itself that this is noise.

Exception: critical alerts always deliver even if `suggested_action` is vague — someone will figure it out.

### Step 3 — Deduplication

Dedupe key = `sha256(source + event_type + primary_identifier)` (primary_identifier varies by alert type — transfer_id, dispute_id, owner_id, etc.).

Dedup windows:
| Severity | Dedup Window |
|---|---|
| Critical | 60 seconds (safety — prevent identical spam) |
| Warning | 30 minutes |
| Info | 6 hours |

Within window → skip delivery, increment dedup counter on the original alert record. After window → deliver fresh.

### Step 4 — Maintenance / Suppression Window Check

Query `orchestrator_flags.maintenance_window`:
- If **off** → proceed normally
- If **on** and severity != critical → batch into post-window digest
- If **on** and severity == critical → deliver anyway, mark `delivered_during_maintenance=true`

### Step 5 — Recipient Resolution

Role matrix (Configuration §10):

| Category | Primary | Secondary | Notes |
|---|---|---|---|
| TrustSync critical | @jason | @kimberly | Money-in-motion — always page |
| TrustSync warning | @jason | — | DM |
| OTAAuditor exception | @kimberly | @jason (on-call) | Channel post + DM if > 24h old |
| RevPost error | @kimberly | @jason | DM + Asana task |
| Chargeback urgent (< 24h deadline) | @jason | @kimberly | DM + channel |
| Chargeback normal | #chargebacks | — | Channel only |
| Utility ops | @jocelyn | @owner-success | Channel post |
| Utility accounting approval | @kimberly | — | Channel + Asana |
| Health → red | @jason | — | DM + SMS if overnight |
| Health → yellow | @jason | — | DM only; no SMS |
| Infrastructure (Supabase, event bus) | @jason | — | DM + SMS if critical |
| Security (unusual auth, permission) | @jason | @mike | DM immediate + email |

On-call override: if Jason is off-call (configured in `on_call_schedule`), primary routes to whoever is covering.

### Step 6 — Channel Selection Per Recipient

For each recipient, pick the channel by severity + time-of-day:

| Severity | During Business Hours (recipient tz) | Quiet Hours (22:00-06:00) |
|---|---|---|
| Critical | Slack DM + channel + SMS (if on-call) | Slack DM + SMS |
| Warning | Slack DM | Slack DM (delivery deferred to 07:00 if configured) |
| Info | Batch into daily digest | Batch into daily digest |

Exceptions:
- Accounting approvals always go to `#accounting-center-approvals` channel AND Asana task to Kimberly
- Owner-ops ops alerts always to `#team_support_owner_success`
- Security alerts always deliver immediately regardless of hour

### Step 7 — Formatting

**Slack DM / channel (critical):**
```
🔴 *TRUST TRANSFER FAILED — Coachella market*
*Amount:* $4,235.18
*Error:* INSUFFICIENT_FUNDS (retry #3 exhausted)
*What to do:* Check source account balance in Column Bank; possible funding delay upstream.
<https://dashboard.acme.../trustsync/transfers/xfr_abc123|Open in Dashboard>
_alert_id: xfr-abc123-failed | 2026-04-13 09:14:00 PT_
```

**Slack DM (warning):**
```
🟡 *OTAAuditor — exception aged 7 days*
Airbnb payout $1,247.00 unmatched since 2026-04-06.
*What to do:* Review in exception manager; likely partial deposit.
<link>
```

**Slack channel post (info → digest form):**
```
🔵 Daily digest — 2026-04-13
• 3 chargeback cases aged into warning window
• 2 utility bills flagged for human review
• OTAAuditor automatch rate dipped to 91% yesterday (7d avg 94%)
```

**Email (compliance-grade):**
- Full alert envelope in body
- Dashboard link
- Signed "Accounting Center — Alert Router"

**Asana task:**
- Task title = summary
- Description = detail + action
- Assigned to recipient
- Project = "Accounting Center — Alerts"

**SMS (pager):**
- Under 160 chars
- `🔴 ACME: Trust transfer failed Coachella $4,235. Check Column Bank. Dashboard: short.link/acct`

### Step 8 — Delivery + Logging

For each (alert_id, recipient, channel):
- Deliver
- Capture delivery receipt (message_ts for Slack, message_id for email, SMS sid, Asana task gid)
- Write to `alert_deliveries` table with delivered_at, channel, recipient, alert_id, receipt_id
- Update original alert with delivery_status

### Step 9 — Escalation Timer (Critical Only)

For critical alerts:
- Start `acknowledgment_timer` = 15 min
- If no ack reaction (Slack ✅ reaction or `/acct ack {alert_id}` command) within 15 min → escalate to secondary recipient
- If no ack within 30 min → @-mention in ops channel + SMS to CEO if truly critical
- Log all escalation steps

### Step 10 — Daily Digest (07:00 local, recipient tz)

For each recipient, gather all `info`-level alerts batched during quiet hours + maintenance windows, post as one Slack message with grouped sections.

Digest goes to DM by default; can be redirected to a team channel per recipient preference.

### Step 11 — Reject / Suppress Log

Every rejected or suppressed alert → `alert_suppressions` table:
- reason (`not_actionable` | `deduped` | `maintenance_window` | `schema_violation`)
- original alert payload
- decision timestamp

Used for tuning and audit.

---

## 5. Output Schema

**Delivery record:**
```json
{
  "delivery_id": "dlv_abc123",
  "alert_id": "alrt_xyz789",
  "source": "trustsync-transfer-agent",
  "severity": "critical",
  "recipient": "@jason",
  "channel": "slack_dm",
  "delivered_at": "2026-04-13T09:14:22Z",
  "receipt_id": "1234567.008900",
  "delivery_latency_ms": 1200,
  "maintenance_mode": false,
  "acked_at": "2026-04-13T09:17:44Z",
  "acked_by": "@jason",
  "escalations": []
}
```

**Suppression record:**
```json
{
  "suppression_id": "sup_abc",
  "alert_id": "alrt_original",
  "reason": "deduped",
  "window_seconds": 1800,
  "suppressed_at": "2026-04-13T09:14:00Z",
  "counter_incremented_on": "alrt_original"
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Critical alert unacknowledged 15 min | Escalate to secondary recipient |
| Critical alert unacknowledged 30 min | @-mention in ops channel + SMS to CEO (Mike) as last resort |
| Same alert_id critical delivered > 3 times in 1 hour | Possible runaway — suppress further, open Asana incident |
| Alert volume spike (> 50 alerts in 15 min across center) | Switch to digest mode for warnings+info; only criticals deliver individually; alert Jason that we're in alert storm |
| Delivery channel fails (Slack API down) | Retry via email; if that fails, SMS; log every hop |
| Recipient on PTO (configured) | Auto-reroute to backup per on-call schedule |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Slack API 5xx | Retry 3x, backoff; then email fallback |
| Email SMTP failure | Retry 2x; then SMS fallback for critical |
| SMS provider failure | Retry 1x; log; if critical + no delivery, auto-open Asana task + at-next-scheduled-run digest |
| Recipient not in role matrix | Deliver to Jason + log config-gap warning |
| Invalid Slack channel / email | Log, deliver via any working fallback, alert Jason |
| Ack command received for unknown alert_id | Log; safe no-op |
| Dedup cache corruption | Err on the side of deliver (better to annoy than miss) |

---

## 8. Tools Required

- **Slack MCP:** `slack_send_message`, DM, channel, reaction listener
- **Email gateway:** SMTP or transactional (SendGrid / Postmark)
- **SMS provider:** Twilio (pager tier)
- **Asana MCP:** `create_tasks` for Asana-destined alerts
- **Database:** `alert_deliveries`, `alert_suppressions`, `on_call_schedule`, `role_matrix`
- **Event bus:** subscribe to `*.alert`, `health_state_changed`, `kpi_threshold_breached`; emit `alert_delivered`, `alert_escalated`

---

## 9. Handoff Contract

**Upstream:**
- Every product and Phase 6 agent emits alerts in the standard envelope
- `health-monitor` emits `health_state_changed` (treated as alerts)
- `kpi-computer` emits threshold breach alerts when a KPI crosses a configured line

**Downstream:**
- Slack / email / SMS / Asana — the humans
- `alert_delivered` event → audit-log-reader for compliance
- `alert_escalated` event → back to orchestrator for high-severity tracking

**Side-effects:** Actual messages sent to humans. Handle with care.

---

## 10. Configuration

```yaml
alert_router:
  envelope_required_fields: ["alert_id","source","severity","event_type","summary","emitted_at"]
  actionability_required: true
  actionability_exception_for_critical: true
  dedup_windows_seconds:
    critical: 60
    warning: 1800
    info: 21600
  quiet_hours_default_tz: "America/Los_Angeles"
  quiet_hours_start: "22:00"
  quiet_hours_end: "06:00"
  daily_digest_time: "07:00"
  role_matrix:
    trustsync_critical:       {primary: "@jason",   secondary: "@kimberly"}
    trustsync_warning:        {primary: "@jason"}
    otaauditor_exception:     {primary: "@kimberly", secondary: "@jason", channel: "#otaauditor-exceptions"}
    revpost_error:            {primary: "@kimberly", secondary: "@jason"}
    chargeback_urgent:        {primary: "@jason",   secondary: "@kimberly", channel: "#chargebacks"}
    chargeback_normal:        {channel: "#chargebacks"}
    utility_ops:              {primary: "@jocelyn", channel: "#team_support_owner_success"}
    utility_accounting:       {primary: "@kimberly", channel: "#accounting-center-approvals", asana_project: "Accounting Center — Approvals"}
    health_red:               {primary: "@jason",   sms: true}
    health_yellow:            {primary: "@jason"}
    infrastructure_critical:  {primary: "@jason",   sms: true}
    security:                 {primary: "@jason",   secondary: "@mike", email: true}
  channel_rules:
    critical_business_hours: ["slack_dm","slack_channel"]
    critical_quiet_hours:    ["slack_dm","sms"]
    warning_business_hours:  ["slack_dm"]
    warning_quiet_hours:     ["slack_dm_deferred_07_00"]
    info:                    ["daily_digest"]
  escalation:
    critical_ack_timeout_min: 15
    critical_secondary_timeout_min: 30
    ceo_last_resort: "@mike"
  on_call_schedule_table: "on_call_schedule"
  storm_threshold_alerts_per_15min: 50
  storm_downgrade_behavior: "digest_warnings_and_info_only"
  channels_for_fallback_order: ["slack_dm","email","sms","asana_task"]
  suppressions_log_retention_days: 365
  slack_ack_reaction: "white_check_mark"
  slack_ack_command: "/acct ack {alert_id}"
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Critical TrustSync transfer fail during business hours | Slack DM to Jason + channel post + ack timer starts |
| T2 | Same alert re-emitted 30 seconds later | Deduped; counter +1 on original; no new delivery |
| T3 | Warning emitted at 23:30 PT | Deferred to 07:00 digest to recipient |
| T4 | Critical emitted at 02:00 PT | Slack DM + SMS; no deferral (critical overrides quiet hours) |
| T5 | Jason on PTO, Kimberly covering | Primary auto-reroutes to Kimberly per on-call schedule |
| T6 | Alert without `suggested_action` (warning-level) | Rejected with `not_actionable`; source alerted about schema issue |
| T7 | Critical unacked 15 min | Escalates to secondary; ack clock continues to 30 min mark |
| T8 | Alert storm (60 alerts in 15 min) | Storm mode on; warnings+info digested; criticals still individual; Jason notified |
| T9 | Slack API down | Email fallback used; if critical, SMS next |
| T10 | Maintenance window on, warning comes in | Suppressed; logged to `alert_suppressions`; bundled in post-window digest |
| T11 | Ack received via Slack ✅ reaction | Timer cleared; delivery record updated |
| T12 | Accounting approval alert | Routes to `#accounting-center-approvals` + Asana task to Kimberly |

---

## 12. Success Metrics

- **Critical delivery p95 latency:** < 30 seconds (target 15s)
- **Critical acknowledgment rate within 15 min:** > 95%
- **False-positive alert rate** (alerts recipients mark as noise): < 5%
- **Alert-to-action rate** (% of alerts that result in a human action within 1 hr): > 80% for critical, > 60% for warning
- **Dedup effectiveness:** < 1% perceived-duplicate rate from recipients
- **Storm mode activations:** < 2 per quarter (if higher, upstream products are noisy — tune thresholds)
- **Digest open rate** (Jocelyn/Jason skim the daily digest): > 90% (proxy: reactions, drill-through clicks)

---

## 13. Notes for Implementation

- **Actionability is the quality gate.** The cheapest way to reduce noise is to reject alerts that can't say what to do. This also puts pressure on upstream products to emit well-formed alerts.
- **Dedup windows matter more than you think.** A TrustSync retry loop that fails every 30s for an hour can generate 120 identical alerts. One delivery + counter, not 120 pages.
- **Never @-channel.** This is cultural — the moment you do, the team mutes the channel, and then you've broken the entire alert system. @-person is surgical.
- **Quiet hours are a gift to your team.** Jocelyn doesn't need to know about an OCR retry at 1:30 AM. She needs to know about it by 7:30 AM. Protect sleep; criticals override only when truly critical.
- **Storm mode is the pressure valve.** If upstream products are noisy, don't drown the humans — downgrade and alert Jason to fix the source.
- **Ack tracking closes the loop.** An alert without ack tracking is a shout into a void. We need to know who saw it, when, and whether they acted.
- **SMS is for money + security only.** The moment SMS gets used for routine ops alerts, people mute it, and then the tool is broken for the case it matters.
- **The router is a product in its own right.** Treat the suppressions log and delivery metrics as first-class — they tell you whether the system is working. Review monthly. Adjust thresholds. This is an ongoing tuning exercise, not a one-time setup.
- **Compose alerts the way you'd want to receive them.** If the message would annoy you at 7 AM with coffee in hand, it'll annoy everyone else too. Edit ruthlessly.
