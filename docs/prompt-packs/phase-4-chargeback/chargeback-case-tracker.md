# Chargeback Case Tracker — Prompt Pack

**Agent:** `chargeback-case-tracker`
**Phase:** 4 (Chargeback Manager)
**Parent Orchestrator:** `chargeback-orchestrator`
**Trigger:**
- New case event from `chargeback-inbox-monitor` (case created)
- State-change events from every downstream agent (matcher, dossier-builder, narrative-drafter)
- Daily scheduled sweep (every business day 7 AM PT)
- Webhook/poll of processor APIs for decision updates
**Owner:** Audrey is the primary human operator of the Asana "Chargebacks" project.
**SLA:** Real-time state sync. Deadline warnings fire at 72h / 48h / 24h / 4h before processor hard deadline.

---

## 1. Purpose

Be the **single source of truth for chargeback case state**. Every other agent in Phase 4 does narrow, event-driven work; this agent keeps the enterprise view — every open case, every state, every deadline, every escalation, every SLA breach risk — synchronized between the case store, Asana, Slack, and the processor portals.

If a case falls through the cracks, this is the agent that failed. Target: **zero missed deadlines.**

---

## 2. System Prompt

```
You are the Chargeback Case Tracker for ACME House Company. You maintain the
authoritative state of every chargeback case — from inbox arrival through
final decision logging — and ensure nothing misses a processor deadline.

The SOP target is zero missed deadlines. The business target is to match
Judy Crane's 2-losses-in-5-years record. Cases lost to missed deadlines are
the worst kind of loss — they're preventable.

Your job is to:
1. Persist the canonical case record (intake → match → dossier → draft →
   submitted → decided).
2. Reflect state changes into Asana in real time (project "Chargebacks").
3. Drive SLA alerts: 72h / 48h / 24h / 4h warnings to the case owner and
   escalation chain.
4. Drive escalation routing by dollar threshold and reason code.
5. Monitor processor portals (Stripe API, Lynnbrook portal) for status
   changes on submitted cases.
6. Produce the daily operational digest: open cases, deadlines, at-risk,
   blockers.

Your constraints:
- IDEMPOTENT: every event you process has a unique case_id + event_id.
  Re-processing the same event must not duplicate Asana tasks, Slack pings,
  or state changes.
- NEVER advance case state without the upstream event. You are a mirror,
  not an author. If matcher says "matched," you update state to matched.
  You do not decide matching.
- AUTHORITATIVE for DEADLINE CALCULATION. You compute and broadcast the
  next warning window. Other agents treat your deadline_status as truth.
- NEVER silently drop a case. If you haven't heard from a downstream agent
  in > SLA for that stage, you alert the human.
- RESPECT the SOP ownership map: Audrey owns all cases; Jocelyn reviews
  >$2,500 or ambiguous match; Jason reviews >$10,000.

Your outputs: Asana task updates, Slack pings, processor-portal polls,
daily digest.
```

---

## 3. Task Prompts (by trigger)

### 3a. Trigger: New case event (from inbox-monitor)
```
Create authoritative case record in the store:
{case_record_json}

Create Asana task in project "Chargebacks" with:
- Title: "[{processor}] Chargeback — {guest_name} — {property|TBD} — Due {deadline_date}"
- Due date = processor_deadline - 48h (internal deadline)
- Status: Intake
- Custom fields populated from case record
- Description: full original notice
- Tag @Jocelyn if disputed_amount > $2500
- Tag @Jason if disputed_amount > $10000
- Tag Accounting if reservation predates Vacasa acquisition

Schedule SLA warnings at 72h / 48h / 24h / 4h before processor deadline.
Emit "case_created" to orchestrator for downstream trigger.
```

### 3b. Trigger: Match event (from reservation-matcher)
```
Update case record with reservation_match result.
Advance state: Intake → Matching → Building Dossier (auto) OR
                Matching → Human Confirmation Needed (for 75–95 confidence) OR
                Matching → Ambiguous Escalation (for < 75).

Update Asana:
- Custom fields: Reservation ID, Property, Channel
- If auto-matched: status = Building Dossier
- If probable: status = Needs Match Confirmation, assign Audrey, require confirmation before dossier-builder fires
- If ambiguous: status = Match Escalation, tag Jocelyn
```

### 3c. Trigger: Dossier event (from dossier-builder)
```
Update case record with dossier_manifest pointer + evidence_gaps list.
Advance state: Building Dossier → Ready for Narrative (success) OR
                Building Dossier → Dossier Blocked (validation failure or total failure).

Update Asana:
- Attach dossier PDF + Drive folder link
- Populate Evidence Gaps multi-select from manifest
- Status: Ready for Narrative
- Tag Jocelyn if any CRITICAL gap
```

### 3d. Trigger: Narrative event (from narrative-drafter)
```
Update case record with draft pointer + reviewer assignment.
Advance state: Ready for Narrative → Ready for Review.

Update Asana:
- Attach draft narrative as Asana doc or Drive link
- Assign reviewer per strength + dollar threshold (Audrey | Jocelyn | Jason)
- Notify assignee via Slack DM with: case summary, draft link, internal deadline, any CRITICAL gaps
- Status: Ready for Review
```

### 3e. Trigger: Human submission event (manual status change in Asana to "Submitted")
```
Update case record: submitted_at, submitted_by, submission_confirmation_url.
Advance state: Ready for Review → Submitted — Awaiting Decision.

Begin processor-portal polling for this case (§4, Step 4).

Schedule outcome-check sweep every 72h until decision arrives
  (or processor_decision_window elapses — typically 30–90 days).
```

### 3f. Trigger: Processor decision polled
```
Update case record with outcome (Won / Lost / Partial) + stated reason.
Advance state: Submitted → Won | Lost | Partial.

Update Asana status, populate outcome notes, move to Monthly Review queue.
Emit decision event to outcome-analyst for trend capture.
Notify Audrey + Jocelyn + (if >$10k) Jason via Slack.
If Lost: notify Accounting for owner statement adjustment.
```

### 3g. Trigger: Daily sweep (7 AM PT)
```
For every open case:
- Recalculate time_to_processor_deadline.
- Fire SLA warnings due today.
- Detect stalls: any case in same state > stage_sla_hours → alert.
- Detect missing human actions: Review assignments untouched > 24h → re-ping reviewer.
- Poll processor portals for any submitted case not yet decided.

Produce daily digest and post to #chargebacks Slack channel at 7:30 AM PT.
```

---

## 4. Step-by-Step Workflow

### Step 1 — Case Record Schema (Source of Truth)

The case record is the authoritative document for every chargeback. All agents read/write through the tracker (the tracker is the only thing that writes to Asana for state changes — other agents emit events).

```json
{
  "case_id": "CB-2026-0142",
  "state": "ready_for_review",
  "processor": "lynnbrook",
  "dispute_id": "144522240",
  "processor_reason_raw": "Cancelled Merchandise/Services",
  "reason_code": "cancellation_refund",
  "disputed_amount": 3679.00,
  "currency": "USD",
  "cardholder_name": "Jason Toledo",
  "card_last4": "3008",
  "card_brand": "amex",
  "processor_received_at": "2026-04-11T09:14:00Z",
  "processor_deadline": "2026-04-21T23:59:59Z",
  "internal_deadline": "2026-04-19T23:59:59Z",
  "market": "Coachella Valley",
  "trust_type": "ST",
  "reservation": {
    "id": "SL-887341",
    "property_name": "Coachella Canyon Retreat",
    "stay_dates": {"check_in": "2026-03-14", "check_out": "2026-03-17"},
    "channel": "direct",
    "owner_id": "owner_5521",
    "match_confidence": 97,
    "match_tier": "auto"
  },
  "dossier": {
    "manifest_url": "...",
    "pdf_url": "...",
    "drive_folder_url": "...",
    "gaps": ["no_id_on_file"]
  },
  "narrative": {
    "draft_url": "...",
    "word_count": 487,
    "case_strength": "moderate",
    "approval_recommendation": "needs_jocelyn_review",
    "drafted_at": "2026-04-15T21:10:00Z"
  },
  "review": {
    "assigned_to": "jocelyn",
    "assigned_at": "2026-04-15T21:12:00Z",
    "approved_at": null,
    "edits_applied": null
  },
  "submission": {
    "submitted_at": null,
    "submitted_by": null,
    "confirmation_url": null
  },
  "outcome": {
    "decided_at": null,
    "result": null,
    "processor_stated_reason": null,
    "dollars_defended": null,
    "dollars_lost": null
  },
  "asana_task_id": "...",
  "gmail_thread_id": "...",
  "slack_thread_url": "...",
  "escalations": [
    {"level": "jocelyn", "reason": "amount_over_2500", "at": "2026-04-11T09:16:00Z"}
  ],
  "sla_alerts_fired": ["72h", "48h"],
  "state_history": [
    {"from": null, "to": "intake", "at": "2026-04-11T09:15:00Z"},
    {"from": "intake", "to": "matching", "at": "2026-04-11T09:18:00Z"},
    {"from": "matching", "to": "building_dossier", "at": "2026-04-11T09:31:00Z"},
    {"from": "building_dossier", "to": "ready_for_narrative", "at": "2026-04-15T17:30:00Z"},
    {"from": "ready_for_narrative", "to": "ready_for_review", "at": "2026-04-15T21:12:00Z"}
  ],
  "created_at": "2026-04-11T09:15:00Z",
  "updated_at": "2026-04-15T21:12:00Z"
}
```

### Step 2 — State Machine

```
        ┌─────────┐
        │ intake  │  (inbox-monitor created case)
        └────┬────┘
             ▼
        ┌─────────┐
        │matching │──ambiguous──▶ match_escalation (Jocelyn)
        └────┬────┘                        │
   probable  │  auto                       └──manually resolved──┐
      ▼      ▼                                                    ▼
┌────────────────────┐                              ┌───────────────────┐
│ match_confirmation │◀────────confirmed────────────┤ building_dossier  │
└──────────┬─────────┘                              └─────────┬─────────┘
           │ confirmed                                         │
           ▼                                                   ▼
   ┌───────────────────┐                         dossier_blocked_validation
   │ building_dossier  │                                 (Jocelyn)
   └─────────┬─────────┘
             ▼
   ┌────────────────────┐
   │ ready_for_narrative│
   └──────────┬─────────┘
              ▼
   ┌───────────────────┐
   │ ready_for_review  │
   └──────────┬────────┘
              │ human approves + submits
              ▼
   ┌──────────────────────────┐
   │ submitted_awaiting_decision│
   └──────────┬───────────────┘
              │ processor decides
              ▼
        ┌────────────┐
        │ won/lost/  │ ─▶ outcome-analyst
        │  partial   │
        └────────────┘
```

Terminal states: `won`, `lost`, `partial`, `withdrawn_by_cardholder`.
Blocked states: `match_escalation`, `dossier_blocked`, `narrative_blocked_evidence_contradiction`.

### Step 3 — SLA & Deadline Warning System

For every open case, compute:
- `hours_to_processor_deadline`
- `hours_to_internal_deadline` (processor - 48h)
- `stage_hours_elapsed` (how long in current state)

Warning schedule (fired once per case per threshold):

| Trigger | Who gets notified | Channel |
|---|---|---|
| 72h before processor deadline | Audrey | Slack DM + Asana comment |
| 48h before processor deadline (= internal deadline) | Audrey + Jocelyn (if > $2,500) | Slack DM + Asana comment |
| 24h before processor deadline | Audrey + Jocelyn + Jason (if > $10,000) | Slack DM + #chargebacks channel |
| 4h before processor deadline (EMERGENCY) | Audrey + Jocelyn + Jason regardless of amount | Slack DM + #chargebacks channel + @channel |
| Stage stall: state unchanged > stage_sla | Case owner | Slack DM |

Stage SLAs (from SOP §6):

| State | Expected duration | Alert threshold |
|---|---|---|
| intake | < 4 business hours | 6 business hours |
| matching | < 1 business day | 2 business days |
| match_confirmation | < 1 business day | 2 business days |
| building_dossier | < 3 business days | 5 business days |
| ready_for_narrative | < 4 hours | 8 hours |
| ready_for_review | reviewer-dependent | 24 hours w/o action |
| submitted_awaiting_decision | 30–90 days (processor) | poll cadence, no stall alert |

### Step 4 — Processor Portal Polling

For every case in `submitted_awaiting_decision`:

#### Stripe
- Use `disputes.retrieve(dispute_id)`.
- Check `status` field: `needs_response`, `under_review`, `won`, `lost`.
- Cadence: every 24h for first 30 days, every 72h thereafter.
- On status change → update case, emit decision event.

#### Lynnbrook
- API if available; else portal-scrape / email-ingestion (customerservice@aptx.cm decision emails have their own parser).
- Poll daily for cases in `submitted_awaiting_decision`.
- Decision emails land in accounting@acmehouseco.com and are detected by the inbox-monitor as outcome notifications (separate label: `Chargeback — Decided`).

### Step 5 — Asana Sync (Write)

The tracker is the ONLY agent that writes Asana state fields. Other agents emit events. This keeps Asana consistent.

On every state change:
- Update the task's Status custom field.
- Update the Stage description in the task (freeform, human-readable).
- Add a comment noting state transition + timestamp + which agent triggered it.
- Reassign task if reviewer changed.
- Update due date if internal deadline shifted.

### Step 6 — Daily Digest

Posted to `#chargebacks` Slack channel every business day at 7:30 AM PT:

```
🧾 Chargeback Daily Digest — Wednesday, April 15 2026

OPEN CASES: 8  |  IN REVIEW: 2  |  SUBMITTED: 3  |  DECIDED THIS WEEK: 1W / 0L

🔥 NEEDS ACTION TODAY:
• CB-2026-0142 — Toledo / Coachella Canyon — $3,679 — Lynnbrook
    State: Ready for Review (assigned Jocelyn, 22h idle)
    Internal deadline: 4 days
    [Link]
• CB-2026-0138 — Rivera / Sedona Saguaro — $8,410 — Stripe
    State: Building Dossier (Day 4 of 5)
    Evidence gap: no_lock_logs (CRITICAL)
    [Link]

📬 SUBMITTED AWAITING DECISION:
• CB-2026-0131 — Stripe — Day 12 of ~45
• CB-2026-0127 — Lynnbrook — Day 18 of ~60
• CB-2026-0115 — Stripe — Day 42 of ~45 ⚠️ decision imminent

✅ RECENT WINS:
• CB-2026-0122 — WON — $2,840 defended (fraud)

📊 MTD: 5 decided → 4W / 1L — 80% win rate — $9,220 defended / $1,450 lost

Top evidence gap this month: no_inspection_photos (3 cases)
```

### Step 7 — Escalation Routing

| Trigger | Action |
|---|---|
| New case > $2,500 | Auto-tag Jocelyn on Asana task, Slack DM with summary |
| New case > $10,000 | Auto-tag Jason + Jocelyn, Slack DM to both |
| Match confidence 75–95 | Assign match_confirmation to Audrey, 24h SLA |
| Match confidence < 75 | Assign match_escalation to Jocelyn |
| Dossier blocked | Alert Jocelyn via Slack + Asana tag |
| Evidence contradiction (narrative-blocked) | Alert Jocelyn + freeze case, no auto-advance |
| Reservation predates Vacasa acquisition | Tag Accounting + Jocelyn |
| Processor threatens account-level penalty | Page Jason immediately (Slack DM + email + phone via Twilio if configured) |
| Pattern detected: 3+ chargebacks same channel/property same month | Alert Jason (strategic risk) |

---

## 5. Output Events

Emits to orchestrator and other agents:

```json
{
  "event_type": "case_state_changed",
  "case_id": "CB-2026-0142",
  "from_state": "building_dossier",
  "to_state": "ready_for_narrative",
  "at": "2026-04-15T17:30:00Z",
  "triggered_by": "chargeback-dossier-builder",
  "next_expected_agent": "chargeback-narrative-drafter",
  "sla": {
    "hours_to_processor_deadline": 152,
    "hours_to_internal_deadline": 104,
    "stage_sla_ok": true
  }
}
```

```json
{
  "event_type": "sla_warning",
  "case_id": "CB-2026-0142",
  "threshold": "48h",
  "assignees_notified": ["audrey", "jocelyn"],
  "channels": ["slack_dm", "asana_comment"],
  "at": "2026-04-17T23:59:59Z"
}
```

```json
{
  "event_type": "case_decided",
  "case_id": "CB-2026-0115",
  "outcome": "won",
  "dollars_defended": 2840.00,
  "processor_stated_reason": "merchant provided compelling evidence",
  "at": "2026-04-15T14:22:00Z",
  "handoff": "chargeback-outcome-analyst"
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Any case with < 4h to processor deadline still not submitted | Page Audrey + Jocelyn + Jason (@channel in #chargebacks) |
| Any case missed its processor deadline | Immediate post-mortem task created, assigned to Jocelyn, root cause required |
| Same guest files second chargeback within 60 days | Flag pattern to Jason |
| Same property triggers 3+ chargebacks in a quarter | Flag to Jason + Larissa (operational issue) |
| Processor portal API unreachable > 4h | Fall back to manual portal check, alert Audrey |
| Case record inconsistent with Asana task state | Auto-reconcile in favor of case record, audit log it, alert Audrey |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Asana API error | Retry 3x with backoff. On persistent failure, enqueue state change, keep trying, alert Audrey after 30 min. |
| Slack notification fails | Retry 2x. Fall back to email. Log failure. |
| Processor poll returns inconsistent data | Use most recent timestamp; if contradictory, hold state, alert Audrey. |
| Event received for unknown case_id | Log and discard; possible stale replay. Alert only if > 5 in an hour. |
| State transition violates state machine | Reject transition. Log. Alert orchestrator. |
| Duplicate event (same event_id) | Drop. Log. |

---

## 8. Tools Required

- **Case store** — Postgres / DynamoDB table keyed by case_id
- **Asana MCP** — `get_task`, `create_tasks`, `update_tasks`, `add_comment`
- **Slack MCP** — `slack_send_message` (DM + channel), `slack_schedule_message`
- **Stripe API** — `disputes.retrieve`
- **Lynnbrook API / portal scraper**
- **Gmail MCP** — read decision emails (via inbox-monitor label `Chargeback — Decided`)
- **Scheduler** — daily 7 AM sweep, deadline warning timers

---

## 9. Handoff Contract

**Upstream (from all Phase 4 agents):**
- State-change events with case_id, event_id, new state, payload.

**Downstream:**
- To orchestrator: state events, SLA events, decision events.
- To outcome-analyst: decision events for trend capture.
- To Asana: state-synced tasks (authoritative writer).
- To Slack: assignments, warnings, daily digest.
- To humans: Audrey, Jocelyn, Jason, Accounting — via Slack DM + Asana.

---

## 10. Configuration

```yaml
chargeback_case_tracker:
  asana_project: "Chargebacks"
  slack_channel: "#chargebacks"
  daily_digest_time_pt: "07:30"
  sla_warning_thresholds_hours: [72, 48, 24, 4]
  stage_sla_hours:
    intake: 6
    matching: 48
    match_confirmation: 48
    building_dossier: 120
    ready_for_narrative: 8
    ready_for_review: 24
  review_thresholds_usd:
    audrey_auto: 0
    jocelyn_required_over: 2500
    jason_required_over: 10000
  processor_poll_cadence_hours:
    stripe_first_30d: 24
    stripe_after_30d: 72
    lynnbrook: 24
  reservation_pre_vacasa_cutoff: "2025-10-01"
  pattern_detection:
    same_property_quarterly_threshold: 3
    same_channel_monthly_threshold: 5
    same_guest_60d_threshold: 2
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | New case $3,679 Lynnbrook | Asana task created, Jocelyn tagged, 72h/48h/24h/4h alerts scheduled. |
| T2 | Case idle in ready_for_review for 25h | Reviewer re-pinged with increasing urgency. |
| T3 | Case at 3h before processor deadline, still not submitted | @channel alert in #chargebacks, DMs to Audrey + Jocelyn + Jason. |
| T4 | Case submitted, Stripe poll returns `won` on day 22 | Case → won, outcome-analyst notified, Audrey + Jocelyn Slack DM, daily digest updated. |
| T5 | Duplicate event received (replay) | Dropped silently, logged. |
| T6 | Two chargebacks for same property in 90 days | Pattern flag to Jason on second case. |
| T7 | Asana outage 10 min during state transition | State change queued, Asana synced when API returns. |
| T8 | Reservation predates 2025-10-01 (pre-Vacasa) | Accounting tagged on creation. |
| T9 | Case enters match_escalation | Jocelyn assigned, 48h SLA, daily digest highlights. |
| T10 | Processor portal unreachable 6h | Fall back to manual check instruction to Audrey, alert, resume when API returns. |
| T11 | Missed deadline (operational failure) | Post-mortem task auto-created, Jocelyn assigned, root-cause template attached. |

---

## 12. Success Metrics

- **Missed deadline rate:** target 0.
- **Stage stall rate:** < 5% of cases breach a stage SLA.
- **Review response time:** median reviewer action < 12h from assignment.
- **Decision capture latency:** < 24h from processor decision to outcome logged.
- **Digest reliability:** 100% daily digest posted by 7:35 AM PT.
- **Pattern detection value:** # of property/channel/guest patterns surfaced → # that led to operational changes (tracked with outcome-analyst).

---

## 13. Notes for Implementation

- **The case store is the system of record, not Asana.** Asana is a projection. If they disagree, case store wins. This matters because Asana custom field updates occasionally fail silently.
- **SLA warnings are your superpower.** The SOP's 2-losses-in-5-years target is achievable only if deadlines never slip. Over-warn rather than under-warn in early months.
- **The daily digest is Audrey's cockpit.** It must be scannable in 30 seconds. Resist the urge to add metrics — if something isn't actionable at 7:30 AM, it belongs in the monthly review.
- **Pattern detection is strategic.** Three chargebacks from the same property in a quarter isn't a chargeback problem — it's a property problem. Flag to Jason so operations can investigate (owner, listing accuracy, cleaning quality).
- **Processor poll is fragile.** Lynnbrook especially — the `customerservice@aptx.cm` email channel may be more reliable than portal scraping. Prefer the email decision notice over the portal status where both exist.
