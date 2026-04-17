# Accounting Center Orchestrator — Prompt Pack

**Agent:** `accounting-orchestrator`
**Phase:** 6 (Dashboards & Cross-product)
**Parent Orchestrator:** None — this IS the top-level orchestrator
**Trigger:** Always-on event bus listener + scheduled cron jobs
**Owner:** Jason (Author), Kimberly (Accounting approver), Jocelyn (Owner Success escalations)
**SLA:** Event routing within 30s of emission; daily/monthly cycles within ±5 min of scheduled fire time

---

## 1. Purpose

The **conductor** for the entire Accounting Center. Five products (TrustSync, OTAAuditor, RevPost, Chargeback Manager, Utility Bill Manager) each have their own product-level orchestrators. This agent sits one level above: it owns the **cross-product event bus**, coordinates handoffs between products, and drives the daily + monthly operating cadence.

If any product can be thought of as a specialized department, the accounting-orchestrator is the COO's chief-of-staff — routing work, sequencing dependencies, surfacing what needs attention, and keeping every product in lockstep.

---

## 2. System Prompt

```
You are the Accounting Center Orchestrator for ACME House Company.

Your job is to coordinate five financial products (TrustSync, OTAAuditor,
RevPost, Chargeback Manager, Utility Bill Manager) into a single coherent
accounting operation. You do NOT do the work of any individual product — you
route events, enforce ordering, and drive the daily/monthly cadence.

Core responsibilities:
1. Maintain the cross-product event bus — every event from every product
   flows through you for routing, logging, and fan-out
2. Enforce inter-product dependencies (e.g., OTAAuditor must finish before
   RevPost decomposition runs)
3. Drive the daily cycle — kick off agents at their scheduled times, verify
   upstream prerequisites, handle pause/resume commands
4. Drive the monthly close cycle (delegate to month-end-close-orchestrator)
5. Maintain system-wide pause flags (emergency stop, audit-mode, maintenance)
6. Publish cross-product events to the dashboard, KPI computer, and alert router

Design principles:
- NEVER do work that belongs to a product orchestrator. If it's TrustSync-
  internal, TrustSync handles it. You only touch events that cross product
  boundaries.
- NEVER skip audit logging. Every routing decision is logged.
- FAIL SAFE, NOT FAIL FAST. If a downstream product is unreachable, queue
  the event for retry; don't drop it.
- IDEMPOTENCY at the event level — (event_id, consumer) must be unique.
- The human approval gates owned by product orchestrators remain theirs.
  You don't override them.

Voice (for Slack/audit output):
- Operator's log — factual, timestamped, terse.
- "At 07:10 PT utility-collection-checker fired for region=socal; completed
  in 4m12s; 18 owners checked; 4 already_collected; emitted
  collection_check_complete → utility-draft-composer."
- No emojis in operational logs (emojis are for human-facing dashboards).
```

---

## 3. Task Prompt Template

```
You are handling {event_type} emitted by {source_agent} at {emitted_at}.

Event payload: {event_json}

Decide:
1. Which downstream consumers should receive this event (fan-out list)
2. Whether any prerequisites are met (e.g., "did OTAAuditor finish today?")
3. Whether any pause flag blocks routing
4. Whether this event requires cross-product side-effects (KPI update,
   dashboard refresh, alert emission)

Emit to the appropriate consumers, log the routing decision, update cycle
state.
```

---

## 4. Step-by-Step Workflow

### Step 1 — Event Ingress

Every product orchestrator emits events to a canonical bus topic per phase:
- `phase-1-trustsync.*`
- `phase-2-otaauditor.*`
- `phase-3-revpost.*`
- `phase-4-chargeback.*`
- `phase-5-utility.*`
- `phase-6-center.*`

The accounting-orchestrator subscribes to `*` (all topics) as the **system-wide consumer**.

For each event:
- Stamp `routing_id = sha256(event_id + consumer_list)`
- Idempotency check against `orchestrator_routing_log` table
- If duplicate → skip, increment dedup counter
- Else → proceed to routing

### Step 2 — Fan-Out Decision

Routing table (excerpt; full table in Configuration §10):

| Event | Standard Consumers | Conditional Consumers |
|---|---|---|
| `phase-3-revpost.je_posted` | kpi-computer, audit-log, dashboard-builder | chargeback-case-tracker (if `related_dispute_id`) |
| `phase-4-chargeback.dispute_won` | kpi-computer, audit-log, dashboard-builder, alert-router | revpost-decomposer (reversal entry) |
| `phase-5-utility.credit_batch_approved` | revpost-je-builder, kpi-computer, audit-log, dashboard-builder | — |
| `phase-2-otaauditor.exception_aged_7d` | alert-router (high severity) | month-end-close-orchestrator (if close-window) |
| `phase-1-trustsync.transfer_failed` | alert-router (critical), dashboard-builder | on-call-pager via alert-router |

Consumer list is resolved from `orchestrator_routing_rules` — config, not code — so routing can change without redeploy.

### Step 3 — Prerequisite Enforcement

Certain events require upstream confirmations before firing downstream:

| Downstream Agent | Required Prerequisite | Check |
|---|---|---|
| `revpost-decomposer` (daily) | OTAAuditor cycle complete for yesterday | Query `otaauditor_runs.status = 'completed'` AND `completed_at` > today 03:00 |
| `utility-credit-applier` (monthly BD-2) | All in-flight utility bills in `utility_collections_bills` have `ingestion_status != 'pending_review'` | Query open-review queue; block if > 0 |
| `month-end-close-orchestrator` | Current-month RevPost postings have zero trial-balance variance | Query `revpost_trial_balance.last_run.variance_usd < 0.01` |
| `chargeback-narrative-drafter` | Dossier builder output validated | Not enforced by orchestrator — internal to Phase 4 |

If prerequisite fails → delay the downstream fire, emit `prerequisite_blocked` to alert-router, add to orchestrator watch-list.

### Step 4 — Daily Cycle Drive

Daily cron schedule (America/Los_Angeles default; region-specific where noted):

| Time | Trigger | Target Agent |
|---|---|---|
| 03:00 PT | Daily | OTAAuditor cycle start (all 7 markets) |
| 06:30 PT | Daily | RevPost decomposer (previous day, after OTAAuditor confirmed) |
| 07:00 MT/PT (Mon) | Weekly | utility-owner-identifier (per region) |
| 07:30 PT (Mon-Fri) | Daily | chargeback-case-tracker digest |
| 08:00 PT | Daily | health-monitor daily rollup |
| 08:30 PT | Daily | kpi-computer daily rollup |
| 09:00 PT | Daily | dashboard-builder morning refresh |
| 17:00 PT | Daily | TrustSync end-of-day reconciliation |
| 22:00 PT | Daily | audit-log integrity check (hash chain) |

Orchestrator fires each trigger, confirms prerequisites, logs kick-off. If any trigger fails to fire within ±5 min of scheduled time, emit `cycle_drift` alert.

### Step 5 — Monthly Cycle Drive

Delegated to `month-end-close-orchestrator`, but the accounting-orchestrator:
- Fires the monthly kickoff at BD-3 (3 business days before month end = start of close window)
- Tracks close progress
- Enforces the "no close without clean trial balance" rule
- Publishes close status to the dashboard

### Step 6 — Pause Flag Management

System-wide flags (stored in `orchestrator_flags` table, settable by Jason/Kimberly via Slack command):

| Flag | Effect |
|---|---|
| `global_pause` | All product orchestrators halt new work; in-flight finishes, new events queue |
| `pause_trustsync` | TrustSync halts; other products continue |
| `pause_utility_autosend` | Utility draft-composer reverts all auto-sends to drafts |
| `pause_chargeback_submissions` | Chargeback narratives stay in draft regardless of human approval |
| `audit_mode` | All events logged with extra detail; slower but forensic-grade |
| `maintenance_window` | Suppresses non-critical alerts; critical alerts still fire |

Orchestrator checks flags on every event before routing. Flag changes are themselves events — audit-logged and broadcast.

### Step 7 — Cross-Product Side-Effects

Certain events trigger side-effects beyond fan-out:

- **`phase-5-utility.credit_batch_approved`** → orchestrator inserts matching request into `revpost_je_queue` with `source=utility` + batch idempotency key; revpost-je-builder picks up from queue on next cycle.
- **`phase-4-chargeback.dispute_lost`** → orchestrator triggers revpost-decomposer to book the net loss JE + post to chargeback-recovery AR if owner-responsible.
- **`phase-2-otaauditor.payout_variance`** → orchestrator correlates to any open chargeback for the same reservation; if match, annotate dispute case.
- **`phase-1-trustsync.operating_transfer_completed`** → orchestrator emits `cash_position_changed` so the dashboard cash-position tile refreshes.

### Step 8 — Emit Routing Record

Every routing decision writes to `orchestrator_routing_log`:
- event_id, event_type, source_agent, emitted_at
- consumers_dispatched[]
- prerequisites_checked[]
- flags_evaluated[]
- routing_latency_ms
- result (dispatched / blocked / deduped / errored)

Used for SLA tracking, debugging, and the dashboard's "event flow" visualization.

---

## 5. Output Schema

```json
{
  "routing_id": "rt_sha256_abc123",
  "event_id": "evt_sha256_xyz789",
  "event_type": "phase-5-utility.credit_batch_approved",
  "source_agent": "utility-credit-applier",
  "emitted_at": "2026-04-13T22:04:11Z",
  "routed_at": "2026-04-13T22:04:11.240Z",
  "routing_latency_ms": 240,
  "consumers_dispatched": [
    {"consumer": "revpost-je-builder", "queue_entry_id": "qe_5521", "dispatched_at": "2026-04-13T22:04:11.180Z"},
    {"consumer": "kpi-computer", "dispatched_at": "2026-04-13T22:04:11.195Z"},
    {"consumer": "audit-log", "dispatched_at": "2026-04-13T22:04:11.220Z"},
    {"consumer": "dashboard-builder", "dispatched_at": "2026-04-13T22:04:11.240Z"}
  ],
  "prerequisites_checked": [
    {"prerequisite": "no_pending_review_bills", "result": "pass"}
  ],
  "flags_evaluated": [
    {"flag": "global_pause", "state": "off"},
    {"flag": "audit_mode", "state": "off"}
  ],
  "result": "dispatched",
  "errors": []
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Event routing latency p95 > 5s | Alert Jason: orchestrator degraded |
| Same `event_id` dedup hits > 10 in 1 hr (possible loop) | Pause affected topic, alert Jason |
| Prerequisite blocked for > 30 min | Alert owner of blocked pipeline (Kimberly for RevPost, Jocelyn for Utility) |
| `transfer_failed` event from TrustSync | IMMEDIATE critical alert to Jason via DM + fallback SMS |
| `global_pause` engaged for > 1 hr | Hourly reminder to Jason until cleared |
| Daily cron job missed fire window ±5 min | Alert Jason, retry fire, log `cycle_drift` |
| Event in `orchestrator_routing_log` with `result=errored` | Retry 3x with backoff; persistent fail → alert |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Consumer unreachable (API timeout / offline) | Queue event for retry with exponential backoff; max 6 retries over 2 hrs; after that, dead-letter |
| Event payload fails schema validation | Reject, emit `event_schema_violation` alert, do NOT guess at intent |
| Two consumers require mutually-exclusive state (rare) | Serialize — dispatch to first, wait for ack, then dispatch to second; log ordering |
| Orchestrator restart mid-cycle | On boot, replay `orchestrator_routing_log` from last 24h, reconcile in-flight events |
| Circular event loop detected (A → B → A within 60s) | Auto-engage `pause_{topic}` flag, alert Jason |
| Pause flag set during mid-cycle | In-flight events complete; new events queue; no mid-event abort |

---

## 8. Tools Required

- **Event bus:** read all topics, emit to any topic
- **Database:** `orchestrator_routing_log`, `orchestrator_routing_rules`, `orchestrator_flags`, `otaauditor_runs`, `utility_collections_bills`, `revpost_trial_balance` (read prerequisites)
- **Slack MCP:** command handler for flag changes, alert broadcasts
- **Cron / scheduler:** fires daily and monthly triggers
- **Audit log writer:** every routing decision

---

## 9. Handoff Contract

**Upstream:** All five product orchestrators emit events that this agent subscribes to.

**Downstream:** Every Phase 6 agent (kpi-computer, health-monitor, alert-router, audit-log-reader, dashboard-builder, month-end-close, cross-product-reporter) consumes events routed by this orchestrator.

**Side-effects:**
- `orchestrator_routing_log` append per event
- `orchestrator_flags` state changes
- Cron trigger firings

---

## 10. Configuration

```yaml
accounting_orchestrator:
  subscribed_topics:
    - "phase-1-trustsync.*"
    - "phase-2-otaauditor.*"
    - "phase-3-revpost.*"
    - "phase-4-chargeback.*"
    - "phase-5-utility.*"
    - "phase-6-center.*"
  routing_rules_table: "orchestrator_routing_rules"
  flags_table: "orchestrator_flags"
  routing_log_table: "orchestrator_routing_log"
  idempotency_window_hours: 24
  retry_policy:
    max_retries: 6
    backoff_seconds: [30, 120, 300, 900, 1800, 3600]
    dead_letter_topic: "phase-6-center.dead_letter"
  cron_schedule_timezone_default: "America/Los_Angeles"
  daily_triggers:
    - { time: "03:00", agent: "otaauditor-cycle", region: "all" }
    - { time: "06:30", agent: "revpost-decomposer", prereq: "otaauditor_cycle_complete" }
    - { time: "07:00", agent: "utility-owner-identifier", dow: "Mon", region: "socal", tz: "America/Los_Angeles" }
    - { time: "07:00", agent: "utility-owner-identifier", dow: "Mon", region: "arizona", tz: "America/Phoenix" }
    - { time: "07:30", agent: "chargeback-case-tracker" }
    - { time: "08:00", agent: "health-monitor" }
    - { time: "08:30", agent: "kpi-computer" }
    - { time: "09:00", agent: "dashboard-builder" }
    - { time: "17:00", agent: "trustsync-eod-reconcile" }
    - { time: "22:00", agent: "audit-log-integrity-check" }
  monthly_triggers:
    - { bd: -3, agent: "month-end-close-orchestrator", action: "kickoff" }
    - { bd: -2, agent: "utility-credit-applier", action: "monthly_run" }
    - { bd: 2, agent: "cross-product-reporter", action: "monthly_report" }
  slack_commands:
    flag_set: "/acct flag set {flag_name} {on|off}"
    cycle_status: "/acct status"
    pause_global: "/acct pause"
    resume_global: "/acct resume"
  cycle_drift_tolerance_min: 5
  escalation_contacts:
    trustsync_critical: "@jason"
    revpost_blocked: "@kimberly"
    utility_blocked: "@jocelyn"
    chargeback_blocked: "@jason"
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Standard weekday — all cron triggers fire in order | Routing log shows 9 fires, all within tolerance |
| T2 | OTAAuditor cycle fails | RevPost decomposer blocked, alert fires, routing log shows `prerequisite_blocked` |
| T3 | Duplicate event_id submitted | Dedup catches, no double-dispatch, dedup counter +1 |
| T4 | Consumer unreachable mid-dispatch | Retry schedule initiated, event persists, eventually succeeds |
| T5 | `global_pause` flag set | New events queue, in-flight complete, Slack confirmation posts |
| T6 | Utility credit batch approved | RevPost JE queue gets entry with correct idempotency key |
| T7 | Chargeback won event | KPI updated, dashboard refreshed, audit log written, no unintended side-effects |
| T8 | Circular loop detected (A→B→A) | Auto-pause affected topic, critical alert fires |
| T9 | Orchestrator restarts mid-cycle | Replay last 24h log, reconcile, resume clean |
| T10 | Schema-invalid event arrives | Reject + alert, no guess at intent |
| T11 | Month-end kickoff at BD-3 | month-end-close-orchestrator fires, tracks progress |
| T12 | Daily trigger missed by 10 min (scheduler hiccup) | `cycle_drift` alert, late fire still completes, next day clean |

---

## 12. Success Metrics

- **Event routing p95 latency:** < 1 second
- **Dead-letter rate:** < 0.1% of events
- **Cron drift:** < 5 min on every scheduled trigger, 100% of days
- **Prerequisite enforcement accuracy:** 100% — no downstream agent ever fires without its upstream confirmed
- **Pause flag honored:** 100% — zero events processed while flag was on
- **Audit log completeness:** 100% — every event has a matching routing log entry

---

## 13. Notes for Implementation

- **This is the load-bearing agent of the entire Accounting Center.** Everything else degrades gracefully; this one has to stay up. Deploy with redundancy (active-passive pair minimum) and a health-check endpoint.
- **Keep routing rules in a table, not code.** Finance work evolves; you will add new consumer hookups quarterly. Config-driven routing lets Jason change the wiring without a deploy.
- **Idempotency is sacred.** Double-posting a JE or double-transferring an owner payout is the nightmare scenario. Every event, every consumer, every dispatch — idempotent.
- **The orchestrator is not a dashboard.** It emits events; the dashboard reads them. Resist the temptation to add "just one query" that serves a UI purpose. That's dashboard-builder's job.
- **Pause flags are the emergency brake.** Jason and Kimberly need to be able to pause via Slack in 3 seconds during an incident. Test this quarterly.
- **Month-end delegation is deliberate.** Month-end-close-orchestrator owns the close cadence; accounting-orchestrator only fires the kickoff and enforces the trial-balance gate. Separation keeps the daily cadence from bloating with monthly logic.
- **The audit log is the paper trail.** When a regulator asks "why did this happen?" the routing_log + audit_log join tells the complete story. Never skip logging, even for "trivial" routes.
- **This agent should feel boring.** If accounting-orchestrator is doing novel things, something upstream is wrong. Its job is to be reliable, predictable, and auditable — not clever.
