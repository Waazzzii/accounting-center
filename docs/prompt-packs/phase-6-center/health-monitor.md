# Health Monitor — Prompt Pack

**Agent:** `health-monitor`
**Phase:** 6 (Dashboards & Cross-product)
**Parent Orchestrator:** `accounting-orchestrator`
**Trigger:** Continuous (every 60s) + scheduled daily rollup at 08:00 PT
**Owner:** Jason
**SLA:** Health state transitions reflected on dashboard within 2 minutes of detection

---

## 1. Purpose

Continuously answer one question per product: **is this green, yellow, or red?**

Five products (TrustSync, OTAAuditor, RevPost, Chargeback Manager, Utility Bill Manager) plus the center-level infrastructure (orchestrator, event bus, Supabase). This agent computes a rolled-up health score for each, drives the "Product Health Indicators" row on the dashboard home, and emits state-transition events so the alert-router can notify when something turns yellow or red.

Crucially: health ≠ KPI. KPIs are business metrics. Health is **operational readiness** — can this product do its job right now? Queue depth, SLA compliance, error rate, upstream API availability.

---

## 2. System Prompt

```
You are the Health Monitor for the ACME Accounting Center.

Your job is to compute a green/yellow/red status for each product and its
key dependencies — every 60 seconds — based on operational signals.

Signals you read:
- Queue depth (pending work waiting)
- Error rate (last 15 min, last 1 hr)
- SLA compliance (% of agents completing within SLA)
- Upstream API health (Column Bank, Streamline, Sage, Gmail, Slack, Stripe)
- Event bus lag (unprocessed event count, oldest event age)
- Database connection health
- Scheduled-job drift (cron fires on time?)

You output:
- Per-product status: green | yellow | red
- Per-dependency status
- Rolled-up center status (worst of all products)
- Reason codes explaining why (not just "yellow" but "yellow because
  chargeback queue depth 18 > warning threshold 10")

Rules:
- SPEED OVER PRECISION. Better to flag yellow early than to miss a red.
- STABLE HYSTERESIS. Flip from green→yellow requires 2 consecutive bad
  samples. Flip from yellow→green requires 5 consecutive good samples.
  Prevents flapping.
- TRANSITIONS ARE EVENTS. Every state change emits health_state_changed
  for downstream consumption.
- NEVER AUTO-REMEDIATE. You observe and report. Remediation is a human
  decision or belongs to the affected product's orchestrator.
```

---

## 3. Task Prompt Template

```
Compute current health for {product|dependency} at {sampled_at}.

Signals: {signals_json}
Thresholds: {thresholds_from_config}
Previous state: {previous_state}
Hysteresis counter: {good_samples_streak | bad_samples_streak}

Return: new_state, reason_codes[], changed_from_previous (bool),
samples_streak_continues (bool).
```

---

## 4. Step-by-Step Workflow

### Step 1 — Sample Collection (every 60s)

For each **product**, gather:

| Signal | Source |
|---|---|
| Queue depth | Product's primary work queue (e.g., `chargeback_cases.status=pending`) |
| Error rate 15m | Product's error log, count where `severity>=warn` in last 15 min |
| Error rate 60m | Same, last 60 min |
| SLA compliance | Count of agent runs completed within SLA / total runs in last 60 min |
| Last successful run | Max(`completed_at`) across the product's scheduled agents |
| Upstream API status | Latest health-check on each external API this product uses |

For each **dependency**:

| Dependency | Health Check |
|---|---|
| Column Bank | `/health` endpoint or latest API call latency + status |
| Streamline | GET a lightweight reference endpoint |
| Sage Intacct | `/health` + last JE post result |
| Gmail MCP | Token validity + last successful action |
| Slack MCP | Token validity + last successful message post |
| Stripe | `/v1/balance` status + latency |
| Lynnbrook (aptx.cm) | Gmail filter returning results as expected |
| Supabase | Read + write micro-query, latency, connection pool |
| Event bus | Unprocessed message count + oldest message age |

### Step 2 — Threshold Evaluation

Each signal has green / yellow / red thresholds (Configuration §11):

Example (Chargeback):
```
queue_depth:
  green:  0-5
  yellow: 6-15
  red:    > 15
sla_compliance_pct:
  green: >= 95
  yellow: 85-94
  red:   < 85
```

Compute each signal's color, then combine:
- **Any red** → product red
- **Any yellow, no red** → product yellow
- **All green** → product green

### Step 3 — Hysteresis Gate

Don't flip state on a single bad sample — flapping in a dashboard is worse than noise.

| From | To | Required |
|---|---|---|
| green | yellow | 2 consecutive samples at yellow or worse |
| green | red | 1 sample at red (urgent — no hysteresis) |
| yellow | red | 1 sample at red |
| yellow | green | 5 consecutive samples all green |
| red | yellow | 3 consecutive samples at yellow or better |
| red | green | 5 consecutive samples at green |

Track counter in `health_state` table.

### Step 4 — Reason Codes

For any non-green state, attach **reason codes** explaining which signals caused it:

```
{
  "product": "chargeback",
  "state": "yellow",
  "reasons": [
    {"signal": "queue_depth", "value": 18, "threshold": 15, "severity": "yellow"},
    {"signal": "sla_compliance_pct", "value": 88, "threshold": 94, "severity": "yellow"}
  ]
}
```

Dashboards display reason codes on hover; alerts include them in the body.

### Step 5 — State Persistence

Write to `health_state` table:
```
health_state:
  entity_type         TEXT   ('product','dependency','center')
  entity_name         TEXT
  state               TEXT   ('green','yellow','red')
  reasons             JSON
  signals_snapshot    JSON
  sampled_at          TIMESTAMP
  streak_count        INT
  previous_state      TEXT
  transitioned_at     TIMESTAMP NULL
  sample_id           UUID PK
```

Every 60s sample = 1 row (append-only). Current state = latest sample per entity.

### Step 6 — Emit Transition Events

When state changes (green→yellow, yellow→red, etc.):
```
Event: phase-6-center.health_state_changed
Payload:
  - entity_type, entity_name
  - from_state, to_state
  - transitioned_at
  - reasons[]
  - signals_snapshot
  - severity ('improvement' or 'degradation')
```

Consumed by: alert-router (notify humans), dashboard-builder (refresh tile), audit-log-reader (record for compliance).

### Step 7 — Center-Level Rollup

Compute overall Accounting Center state = worst of:
- All 5 product states
- All dependency states

Center red = at least one product or critical dependency is red. Center yellow = nothing red, but at least one yellow. Center green = all green.

Publishes `center_health_state` on a separate ticker for the dashboard home banner.

### Step 8 — Daily Rollup (08:00 PT)

Once a day, compute daily SLO compliance per entity:
- % of samples at green / yellow / red
- Mean time in yellow, red states
- Count of transitions
- Longest red streak

Write to `health_daily_rollup` table and feed cross-product-reporter.

---

## 5. Output Schema

**Per-sample row:**
```json
{
  "sample_id": "uuid-abc",
  "entity_type": "product",
  "entity_name": "chargeback",
  "state": "yellow",
  "previous_state": "green",
  "transitioned_at": "2026-04-13T09:14:00Z",
  "streak_count": 2,
  "reasons": [
    {"signal": "queue_depth", "value": 18, "threshold_yellow": 15, "severity": "yellow"}
  ],
  "signals_snapshot": {
    "queue_depth": 18,
    "error_rate_15m": 0.02,
    "error_rate_60m": 0.03,
    "sla_compliance_pct": 91,
    "last_successful_run_at": "2026-04-13T09:12:47Z",
    "upstream_api": {
      "stripe": "green",
      "gmail": "green",
      "lynnbrook": "green"
    }
  },
  "sampled_at": "2026-04-13T09:14:00Z"
}
```

**Transition event:**
```json
{
  "event_type": "phase-6-center.health_state_changed",
  "entity_type": "product",
  "entity_name": "chargeback",
  "from_state": "green",
  "to_state": "yellow",
  "transitioned_at": "2026-04-13T09:14:00Z",
  "severity": "degradation",
  "reasons": [
    {"signal": "queue_depth", "value": 18, "threshold_yellow": 15}
  ]
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Any product → red | Alert-router critical path (DM Jason, channel alert) |
| Center → red | Page Jason + Kimberly (critical dependency compromised) |
| Any dependency red for > 15 min | Escalate to on-call (Jason) |
| Center yellow for > 4 hrs | Daily digest mention; otherwise monitor |
| Red streak > 30 min | Incident auto-opened (Asana task for Jason) |
| Flapping detected (>5 transitions in 1 hr) | Treat as red, alert — something is unstable |
| Health monitor itself unhealthy (no samples in 5 min) | Fail-over alarm — page Jason directly |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Signal source unavailable | Use last known + flag `stale=true`; if stale > 10 min, treat signal as worst-case |
| Threshold config missing for new entity | Default all signals to "green only if present and fresh"; alert Jason |
| Database write fails | Retain sample in memory buffer, retry, alert if > 5 min lag |
| Hysteresis counter corruption | Reset to 0 on detect; log; err toward "degraded" interpretation |
| Time skew between samples | Use clock offset detection; trust Supabase server time as canonical |
| Dependency returns ambiguous response | Treat as yellow, not green — conservative |

---

## 8. Tools Required

- **Database:** read product queues, error logs, agent runs; write `health_state`, `health_daily_rollup`
- **HTTP:** health-check endpoints for external APIs
- **Event bus:** emit `health_state_changed`, `center_health_state`
- **Cron:** 60s sampling loop + daily rollup at 08:00 PT
- **Slack MCP:** for Slack API health-checks (read-only)

---

## 9. Handoff Contract

**Upstream:** Product tables and external APIs (read-only probes).

**Downstream:**
- `health_state_changed` → alert-router, dashboard-builder, audit-log-reader
- `health_daily_rollup` → cross-product-reporter

**Side-effects:** `health_state` and `health_daily_rollup` table writes.

---

## 10. Configuration

```yaml
health_monitor:
  sample_interval_seconds: 60
  daily_rollup_time_pt: "08:00"
  hysteresis:
    green_to_yellow_samples: 2
    green_to_red_samples: 1
    yellow_to_red_samples: 1
    yellow_to_green_samples: 5
    red_to_yellow_samples: 3
    red_to_green_samples: 5
  product_thresholds:
    trustsync:
      queue_depth:        {green: [0,5],   yellow: [6,15],  red: 16}
      error_rate_15m_pct: {green: [0,1],   yellow: [1,5],   red: 5}
      sla_compliance_pct: {green: 98,      yellow: 90,      red: 89}
      max_minutes_since_last_run: {green: 30, yellow: 60, red: 90}
    otaauditor:
      queue_depth:        {green: [0,10],  yellow: [11,30], red: 31}
      error_rate_15m_pct: {green: [0,2],   yellow: [2,5],   red: 5}
      sla_compliance_pct: {green: 95,      yellow: 85,      red: 84}
    revpost:
      queue_depth:        {green: [0,5],   yellow: [6,20],  red: 21}
      trial_balance_variance_usd: {green: 0, yellow: 1, red: 10}
      error_rate_15m_pct: {green: [0,0.5], yellow: [0.5,2], red: 2}
    chargeback:
      queue_depth:        {green: [0,5],   yellow: [6,15],  red: 16}
      deadline_urgency_hours_min: {green: 48, yellow: 24, red: 4}
      sla_compliance_pct: {green: 95,      yellow: 85,      red: 84}
    utility:
      queue_depth:        {green: [0,10],  yellow: [11,25], red: 26}
      pending_review_bills:{green: [0,5],  yellow: [6,15],  red: 16}
      sla_compliance_pct: {green: 95,      yellow: 85,      red: 84}
  dependency_thresholds:
    column_bank:        {latency_p95_ms: {green: 800, yellow: 2000, red: 5000}}
    streamline:         {latency_p95_ms: {green: 1500, yellow: 4000, red: 10000}}
    sage_intacct:       {latency_p95_ms: {green: 2000, yellow: 5000, red: 15000}}
    gmail_mcp:          {latency_p95_ms: {green: 1500, yellow: 4000, red: 10000}}
    slack_mcp:          {latency_p95_ms: {green: 800, yellow: 2000, red: 5000}}
    stripe:             {latency_p95_ms: {green: 500, yellow: 1500, red: 4000}}
    supabase:           {latency_p95_ms: {green: 200, yellow: 800, red: 2000}}
    event_bus:          {oldest_unprocessed_seconds: {green: 30, yellow: 120, red: 300}}
  center_rollup_rule: "worst_of_all"
  alerting:
    critical_recipients: ["@jason", "@kimberly"]
    degradation_recipients: ["@jason"]
    improvement_post_to_channel: "#accounting-center-alerts"
    flapping_threshold_transitions_per_hour: 5
  self_health:
    no_sample_alarm_minutes: 5
    fallback_pager_target: "@jason-sms"
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | All systems nominal | All entities green; center green; no events |
| T2 | Chargeback queue depth jumps to 18 | 2 samples pass → flip to yellow; event emitted; dashboard reflects |
| T3 | Sage Intacct latency p95 = 20s (red) | Immediate flip to red; critical alert; center → red |
| T4 | Single blip of yellow on OTAAuditor (resolves in 1 sample) | No flip — hysteresis holds; no event |
| T5 | Column Bank returns 500s | Within 2 samples, dependency=red, TrustSync→red, center→red |
| T6 | Flapping product (5 transitions in 1 hr) | Treat as red, alert fires, manual review needed |
| T7 | Daily rollup at 08:00 PT | `health_daily_rollup` row per entity; cross-product-reporter picks up |
| T8 | Health monitor itself stops sampling | No-sample alarm after 5 min; @jason-sms pager fires |
| T9 | Threshold config missing for a new entity | Default conservative state; alert Jason to add config |
| T10 | Signal source unavailable for 15 min | Treat as worst-case yellow; flip to red after 30 min if persistent |
| T11 | Improvement: yellow → green | 5 good samples required; improvement event emitted with low severity |
| T12 | Event bus backed up (oldest unprocessed = 500s) | event_bus dependency → red; center → red; critical alert |

---

## 12. Success Metrics

- **Detection latency:** state transitions caught within 120 seconds of true change (green→yellow or yellow→red)
- **False-positive rate:** < 5% of red transitions (measured by postmortem: was the underlying issue real?)
- **False-negative rate:** < 1% (every real incident was preceded by a health-monitor alert)
- **Flapping incidents:** < 2 per month (threshold tuning is working)
- **Dashboard freshness:** health tiles never > 2 min stale
- **Self-health uptime:** 99.9% — the monitor itself is monitored by a dead-man switch

---

## 13. Notes for Implementation

- **Hysteresis is the quality bar.** A dashboard that flickers green/yellow/green every 30 seconds is worse than one that says "yellow" honestly for 10 minutes while you investigate.
- **Reason codes are the forensic trail.** When health-monitor flips chargeback to yellow, the alert must say WHY — "queue depth 18 > threshold 15" — not just "yellow." This is the difference between actionable alerts and noise.
- **Never auto-remediate.** It's tempting to say "if queue depth > X, auto-trigger catch-up agent." Resist. Remediation requires context (why did the queue back up?) — observe, notify, let a human or product orchestrator decide.
- **The center banner is load-bearing.** When Jason opens the dashboard at 7 AM, a single glance at the top banner should tell him: green (drink your coffee), yellow (poke around), red (all hands).
- **Tune thresholds quarterly.** As products mature, thresholds tighten. An automatch rate of 80% was fine at launch — it should be yellow a year in. Document every threshold change in `health_config_history`.
- **Self-health is non-negotiable.** A silent monitor is worse than no monitor. The dead-man-switch SMS fallback is the backstop.
- **Health is different from KPIs.** KPIs tell you how the business is doing. Health tells you whether the systems are working. A product can have great KPIs yesterday and a red health state today — both are true and both matter.
- **Green doesn't mean perfect.** Green means "within operating tolerance." Keep that discipline or the word loses meaning.
