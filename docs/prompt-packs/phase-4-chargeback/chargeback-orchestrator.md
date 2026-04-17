# Chargeback Orchestrator — Prompt Pack

**Agent:** `chargeback-orchestrator`
**Phase:** 4 (Chargeback Manager)
**Role:** Parent agent coordinating all 6 Phase 4 sub-agents.
**Trigger:**
- Always-on: hosts the event bus for all Phase 4 sub-agents
- Gmail push notification → dispatches inbox-monitor
- Scheduled sweeps: 15-min poll safety net, daily 7 AM case-tracker digest, monthly/quarterly outcome-analyst reports
**Owner:** Audrey (operational), Jocelyn (escalation), Jason (strategic).
**Performance target:** Reverse-engineer Judy Crane's 2-losses-in-5-years win rate as company standard. Zero missed processor deadlines.

---

## 1. Purpose

The Chargeback Orchestrator is the **Claude SDK parent agent** that coordinates the Phase 4 sub-agents into a working chargeback response system. It:

1. Receives external triggers (Gmail notifications, schedules, manual kick-offs).
2. Dispatches the right sub-agent in the right sequence.
3. Routes events between sub-agents.
4. Enforces state machine transitions (delegates authority to case-tracker).
5. Holds at human-in-the-loop gates (match confirmation, narrative review, submission).
6. Surfaces failures and SLA risks.
7. Runs the scheduled sweeps (daily, monthly, quarterly).

**Philosophy:** The orchestrator is a **dispatcher, not a decider.** Every meaningful decision is made by a sub-agent or a human. The orchestrator makes sure the right one gets the work at the right time.

---

## 2. System Prompt

```
You are the Chargeback Orchestrator for ACME House Company. You coordinate
6 specialized sub-agents that together automate end-to-end chargeback
response.

The 6 sub-agents:
1. chargeback-inbox-monitor      — detects + parses incoming notices
2. chargeback-reservation-matcher — reverse-matches to Streamline reservation
3. chargeback-dossier-builder    — assembles evidence PDF from 9 systems
4. chargeback-narrative-drafter  — writes Judy-Crane-voiced response draft
5. chargeback-case-tracker       — state machine + SLAs + Asana sync + daily digest
6. chargeback-outcome-analyst    — per-case postmortem + monthly/quarterly reports

Your job is to:
- Receive triggers (Gmail push, schedule, manual)
- Dispatch the right sub-agent
- Route events between sub-agents on completion
- Hold at human gates (match confirmation, narrative review, submission)
- Monitor sub-agent health and SLAs
- Escalate systemic failures (not per-case failures — that's case-tracker's job)

Constraints:
- DO NOT make chargeback decisions. Sub-agents and humans decide; you route.
- RESPECT HUMAN GATES. Match confirmation (75–95 confidence), narrative review,
  submission are all human actions. Never auto-advance.
- IDEMPOTENCY IS DELEGATED. Each sub-agent maintains its own idempotency keys.
  You just ensure the right sub-agent sees each event exactly once.
- FAIL LOUD. If a sub-agent times out or errors, surface it to Audrey fast.
  Silent failures lose chargebacks.
- RESPECT THE SOP. Audrey owns operations; Jocelyn reviews >$2,500 and
  ambiguous; Jason reviews >$10,000. Never bypass escalation thresholds.

The company's target: match Judy Crane's 2-losses-in-5-years win rate as
company standard, with zero missed processor deadlines. Your coordination
makes that possible.
```

---

## 3. Event Flow — The Happy Path

```
        ┌─────────────────────┐
  ┌────▶│ Gmail push (new    │
  │     │ chargeback notice) │
  │     └──────────┬──────────┘
  │                ▼
  │        inbox-monitor.parse()
  │                │
  │                ▼
  │        case record created
  │                │
  │      ┌─────────┴─────────┐
  │      ▼                   ▼
  │  case-tracker      reservation-matcher
  │  .create_task()    .match()
  │      │                   │
  │      │         ┌─────────┼─────────┐
  │      │    auto ▼    75-95 ▼   <75  ▼
  │      │    match     probable   ambiguous
  │      │      │          │           │
  │      │      │     human confirm    Jocelyn
  │      │      │     (Audrey)         escalate
  │      │      │          │           │
  │      │      └────┬─────┘           │
  │      │           ▼                 ▼
  │      │   dossier-builder      (blocked until
  │      │   .assemble()           resolved)
  │      │           │
  │      │           ▼
  │      │   narrative-drafter
  │      │   .draft()
  │      │           │
  │      │           ▼
  │      │   HUMAN REVIEW GATE
  │      │   (Audrey | Jocelyn | Jason
  │      │    by $ threshold)
  │      │           │
  │      │           ▼
  │      │   HUMAN SUBMITS
  │      │   via processor portal
  │      │           │
  │      │           ▼
  │      │   case-tracker monitors
  │      │   for processor decision
  │      │           │
  │      │           ▼
  │      │   outcome-analyst
  │      │   .postmortem()
  │      └───────────┘
  │
  │ (schedules)
  ├──15-min poll──▶ inbox-monitor (safety net)
  ├──daily 7 AM──▶ case-tracker (digest + SLA sweep)
  ├──monthly────▶ outcome-analyst (report)
  └──quarterly──▶ outcome-analyst (strategic review)
```

---

## 4. Event Bus — Event Types & Routing

```yaml
events:
  # From inbox-monitor
  - name: case_created
    emitter: inbox-monitor
    consumers: [case-tracker, reservation-matcher]
    payload: {case_record}

  - name: outcome_email_received
    emitter: inbox-monitor
    consumers: [case-tracker]
    payload: {case_id, outcome, stated_reason}

  # From reservation-matcher
  - name: match_auto
    emitter: reservation-matcher
    consumers: [case-tracker, dossier-builder]
    payload: {case_id, reservation_match, confidence: >=95}

  - name: match_probable
    emitter: reservation-matcher
    consumers: [case-tracker]  # awaits human confirmation
    payload: {case_id, reservation_match, confidence: 75-95}
    human_gate: true

  - name: match_ambiguous
    emitter: reservation-matcher
    consumers: [case-tracker]  # escalate to Jocelyn
    payload: {case_id, candidates}
    human_gate: true

  - name: match_confirmed  # fired by case-tracker on human confirmation
    emitter: case-tracker
    consumers: [dossier-builder]
    payload: {case_id, reservation_match}

  # From dossier-builder
  - name: dossier_ready
    emitter: dossier-builder
    consumers: [case-tracker, narrative-drafter]
    payload: {case_id, dossier_manifest}

  - name: dossier_blocked_validation_failure
    emitter: dossier-builder
    consumers: [case-tracker]  # escalate to matcher + Jocelyn
    payload: {case_id, reason}
    human_gate: true

  - name: dossier_blocked_total_failure
    emitter: dossier-builder
    consumers: [case-tracker]
    payload: {case_id, retrieval_log}
    human_gate: true

  # From narrative-drafter
  - name: narrative_ready
    emitter: narrative-drafter
    consumers: [case-tracker]
    payload: {case_id, draft}
    human_gate: true  # always — never auto-submits

  - name: narrative_blocked_evidence_contradiction
    emitter: narrative-drafter
    consumers: [case-tracker]
    payload: {case_id, contradiction_detail}
    human_gate: true

  # From case-tracker (human-triggered or scheduled)
  - name: human_submitted
    emitter: case-tracker  # on Asana status change → Submitted
    consumers: [case-tracker.poll]  # begin processor polling
    payload: {case_id, submitted_at, submitted_by}

  - name: case_decided
    emitter: case-tracker  # from Stripe/Lynnbrook poll or email
    consumers: [outcome-analyst]
    payload: {case_id, outcome, dollars, processor_reason}

  - name: sla_warning
    emitter: case-tracker
    consumers: [humans via Slack/Asana]
    payload: {case_id, threshold, urgency}

  # From outcome-analyst
  - name: postmortem_complete
    emitter: outcome-analyst
    consumers: [case-tracker]  # updates case library pointer
    payload: {case_id, drivers, takeaways}

  - name: learning_signal
    emitter: outcome-analyst
    consumers: [reservation-matcher | dossier-builder | narrative-drafter]
    payload: {target_agent, signal_type, weight}

  - name: monthly_report_published
    emitter: outcome-analyst
    consumers: [humans via Slack/Drive]
    payload: {report_url, metrics}
```

---

## 5. Scheduled Workflows

### 5a. Real-time: Gmail Push Handler
```
On Gmail push notification for accounting@acmehouseco.com:
  1. Dispatch inbox-monitor with the new message_id(s)
  2. inbox-monitor classifies + parses; if chargeback, emits case_created
  3. Orchestrator routes to case-tracker + reservation-matcher in parallel
```

### 5b. Safety net: 15-minute Gmail poll
```
Every 15 min:
  inbox-monitor.poll_safety_net()
  # catches any missed push notifications
```

### 5c. Daily: 7 AM PT Operational Sweep
```
Business days at 07:00 PT:
  case-tracker.daily_sweep()
    - Recalc SLAs for all open cases
    - Fire due deadline warnings
    - Poll Stripe + Lynnbrook for submitted-case decisions
    - Detect stalls
    - Post digest to #chargebacks at 07:30 PT
```

### 5d. Monthly: Last business day 3 PM PT
```
On last business day at 15:00 PT:
  outcome-analyst.monthly_report()
    - Pull all cases decided in month
    - Compute win rate, $ defended, top gaps
    - Generate SOP §9 one-pager
    - Post to Slack + Drive + Asana L10 review task
    - Update EOS scorecard
```

### 5e. Quarterly: First business day of Jan/Apr/Jul/Oct
```
On first business day at 09:00 PT:
  outcome-analyst.quarterly_review()
    - Trend analysis
    - Pattern detection
    - Integration ROI updates
    - Playbook iteration recommendations
    - Distribute to Jason + Jocelyn for quarterly planning
```

---

## 6. Sub-agent Dispatch — Claude SDK Pattern

```python
# pseudocode for the orchestrator
async def handle_event(event):
    case_id = event.payload.get("case_id")

    # Log every event for audit
    audit_log.append(event)

    # Idempotency check — has this exact event_id been processed?
    if idempotency.seen(event.event_id):
        return

    # Route to consumers defined in event bus
    for consumer in event_bus[event.name].consumers:
        if consumer == "case-tracker":
            # Synchronous — tracker is always kept in sync first
            await tracker_agent.run(event)
        else:
            # Parallel dispatch for non-tracker consumers
            await parallel_dispatch(consumer, event)

    # Check human gates
    if event_bus[event.name].human_gate:
        # Do NOT auto-advance; tracker has already notified humans
        return

    # Automatic chaining (happy path)
    next_step = auto_chain_map.get(event.name)
    if next_step:
        await dispatch(next_step, event.payload)


auto_chain_map = {
    "case_created": "reservation-matcher.match",      # fan-out already handled
    "match_auto": "dossier-builder.assemble",          # auto-advance
    "match_confirmed": "dossier-builder.assemble",     # auto after human confirm
    "dossier_ready": "narrative-drafter.draft",        # auto-advance
    # narrative_ready → HUMAN GATE, no auto-chain
    # human_submitted → case-tracker monitoring, no auto-chain
    "case_decided": "outcome-analyst.postmortem",      # auto-advance
}
```

---

## 7. Human Gates — Where Automation Stops

Per SOP, three points always require human action:

### Gate 1: Match Confirmation (confidence 75–95)
- **Who:** Audrey (or Jocelyn if ambiguous <75)
- **Where:** Asana task
- **SLA:** 24h
- **Action:** Confirm or reject the proposed reservation match
- **Re-ping schedule:** 12h / 24h / escalate to Jocelyn

### Gate 2: Narrative Review
- **Who:** Audrey (<$2,500) | Jocelyn ($2,500–10,000) | Jason (>$10,000)
- **Where:** Asana task + draft link
- **SLA:** 24h
- **Action:** Approve / edit / reject draft
- **Re-ping schedule:** 12h / 24h / escalate up the chain

### Gate 3: Submission
- **Who:** Same reviewer as Gate 2
- **Where:** Stripe portal / Lynnbrook portal
- **SLA:** 48h before processor hard deadline (internal deadline)
- **Action:** Submit dossier + narrative via processor UI
- **Tracking:** Reviewer updates Asana status to "Submitted" + attaches confirmation screenshot

**No automation bypasses these gates — ever.** Even at steady state, chargebacks are too high-consequence + too low-volume to fully automate submission.

---

## 8. Maturity Ladder — Automation Progression

The orchestrator supports three maturity modes, configurable:

| Mode | Description | Recommended timing |
|---|---|---|
| `shadow` | Agent drafts everything but humans do every step; agent output is suggestion only | Month 1: Audrey builds her first 10–15 cases using AI-suggested dossiers + drafts as starting points |
| `assist` | Agent auto-advances between stages; humans review at gates 1, 2, 3 | Month 2–3: most cases auto-flow to the review stage |
| `accelerated` | Below $500 with clean rubric + auto-match confidence: narrative-drafter can pre-submit draft to processor in draft state (not final submit) | Month 6+: only for very high-confidence cases, still human submit |

**Default at launch: `shadow`.** SOP §11 explicitly says to automate *after* Audrey has handled 10–15 live cases. The orchestrator respects that.

---

## 9. Dispatch Patterns

### Parallel fan-out on case creation
```
case_created event:
  → case-tracker.create_task()  [synchronous — must succeed before anything else]
  → reservation-matcher.match() [parallel]
```

### Sequential chain on match
```
match_auto:
  → case-tracker.update_state("building_dossier")
  → dossier-builder.assemble()
    → case-tracker.update_state("ready_for_narrative")
    → narrative-drafter.draft()
      → case-tracker.update_state("ready_for_review")
      → Slack DM reviewer + assign Asana task
      [HUMAN GATE]
```

### Long-running poll on submitted
```
human_submitted:
  → case-tracker.schedule_polls(cadence_per_processor)
  [30–90 days wait]
  → polling returns decision
  → case_decided event
  → outcome-analyst.postmortem()
```

---

## 10. Error Handling — Orchestrator-level

| Error | Handling |
|---|---|
| Sub-agent timeout | Retry 2x with exponential backoff. On final fail, emit `subagent_failure` to case-tracker, Slack-alert Audrey, preserve case state. |
| Sub-agent exception | Capture stack trace, log to audit, alert Audrey. Do NOT mark case as failed — case-tracker handles state. |
| Event bus failure | Persist events to durable queue; replay on recovery. Idempotency ensures no duplication. |
| Schedule missed (cron failure) | Backfill on recovery; alert if > 30 min late. |
| Gmail push missed | 15-min poll safety net catches; raise alert if > 3 hours between successful ingests. |
| Human gate SLA exceeded | case-tracker handles per-case escalation; orchestrator surfaces systemic pattern (e.g., > 50% of reviews missing SLA). |
| Idempotency collision (duplicate event) | Drop. Log. Increment metric. |

---

## 11. Monitoring & Observability

Orchestrator publishes health metrics:

- `chargeback.events.emitted{type}` — counter per event type
- `chargeback.events.routed_ok{type}` / `chargeback.events.routed_fail{type}`
- `chargeback.subagent.latency_ms{agent}` — p50, p95, p99
- `chargeback.subagent.error_rate{agent}` — rolling 1h / 24h
- `chargeback.case.time_in_state{state}` — p50, p95
- `chargeback.schedule.missed{job}` — counter
- `chargeback.human_gate.sla_breach{gate}` — counter by gate type
- `chargeback.win_rate.trailing_90d` — gauge
- `chargeback.deadline_miss_count.monthly` — the North Star metric (target: 0)

Dashboard in Phase 6 Accounting Center reads these.

---

## 12. Configuration

```yaml
chargeback_orchestrator:
  mode: shadow  # shadow | assist | accelerated
  event_bus: redis://...
  audit_log: postgres://.../chargeback_events
  idempotency_store: redis://.../chargeback_idempotency

  subagents:
    inbox_monitor:       {timeout_s: 60, retries: 2}
    reservation_matcher: {timeout_s: 120, retries: 2}
    dossier_builder:     {timeout_s: 900, retries: 1}  # long — 9 source retrievals
    narrative_drafter:   {timeout_s: 180, retries: 2}
    case_tracker:        {timeout_s: 30, retries: 3}
    outcome_analyst:     {timeout_s: 600, retries: 1}  # long — report generation

  schedules:
    gmail_poll_safety_net: "*/15 * * * *"
    daily_sweep_pt:        "0 7 * * 1-5"
    daily_digest_pt:       "30 7 * * 1-5"
    monthly_report_pt:     "0 15 L * *"          # last day of month
    quarterly_review_pt:   "0 9 1 1,4,7,10 *"    # first day of quarter

  human_gates:
    match_confirmation:
      sla_hours: 24
      re_ping: [12]
      escalate_to: jocelyn
    narrative_review:
      sla_hours: 24
      re_ping: [12]
      escalate_up_the_chain: true
    submission:
      internal_deadline_buffer_hours: 48
      re_ping: [72, 48, 24, 4]
      final_escalation: [audrey, jocelyn, jason]

  escalation_thresholds_usd:
    jocelyn: 2500
    jason: 10000

  slack_channel: "#chargebacks"

  metrics_prefix: "chargeback"

  fail_fast_events:
    - dossier_blocked_total_failure
    - narrative_blocked_evidence_contradiction
    - subagent_failure
    - schedule_missed_gt_30m
```

---

## 13. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | New Lynnbrook chargeback via aptx.cm at 09:15 | Parsed, case created in ~30s, matcher + tracker both notified in parallel, Audrey sees Asana task in < 1 min. |
| T2 | Match auto-confidence 97 | Auto-advances to dossier; Audrey sees "Building Dossier" by minute 2. |
| T3 | Match confidence 82 | Holds at human gate; Audrey prompted to confirm; dossier does NOT start. |
| T4 | Match confidence 60 | Escalates to Jocelyn; Asana tagged; no auto-advance. |
| T5 | Dossier builder succeeds with no gaps | Narrative drafted same day; ready_for_review assigned to Audrey (case < $2,500) or Jocelyn ($2,500–10K). |
| T6 | Dossier validation fails (wrong reservation fetched) | Event emitted, matcher re-invoked, case frozen at "Dossier Blocked", Jocelyn notified. |
| T7 | Evidence contradiction detected by narrative-drafter | Narrative not drafted; case-tracker freezes, Jocelyn notified. |
| T8 | Human submits, decision arrives 40 days later via Stripe API | outcome-analyst runs postmortem, updates case library, monthly report includes this case. |
| T9 | Decision arrives via Lynnbrook decision email (customerservice@aptx.cm) | inbox-monitor parses outcome, emits outcome_email_received, case-tracker advances state, outcome-analyst runs. |
| T10 | Sub-agent dossier-builder times out at 900s | Retry 1x, then emit subagent_failure, Audrey Slack-alerted, case state preserved at "Building Dossier" for manual intervention. |
| T11 | Gmail push silent for 4 hours | Safety net 15-min polls catch lag, alert at 3h if no successful ingest. |
| T12 | Two chargebacks same property within 30 days | Case-tracker flags pattern to outcome-analyst; outcome-analyst surfaces to Jason in quarterly (or sooner if 3+). |
| T13 | Orchestrator restarted mid-event (crash recovery) | Durable queue replays; idempotency ensures no duplicate Asana task or Drive upload. |
| T14 | Monthly schedule fires on last business day | outcome-analyst monthly report generated + posted; EOS scorecard updated. |
| T15 | Maturity mode changed shadow → assist after 15 cases | Auto-advances kick in on next case; previously-suggested drafts now auto-emit to reviewers. |

---

## 14. Success Metrics (Orchestrator-level)

- **Zero missed processor deadlines** — primary success metric.
- **Case intake → reservation match** — median < 5 min (auto) / < 1 business day (probable).
- **Match → narrative ready** — median < 1 business day.
- **Narrative ready → human submitted** — median < 24h.
- **Sub-agent success rate** — > 98% per agent per month.
- **Event replay rate** — < 0.1% (indicates idempotency working).
- **Human gate SLA breach rate** — < 5% of cases breach any gate.
- **Win rate trajectory** — trailing 90-day win rate trending toward Judy's baseline (96%+).

---

## 15. Notes for Implementation

- **The orchestrator is the plumbing.** Its job is invisible when it works. Success means Audrey's cases flow naturally from inbox to decision without her ever thinking about event buses.
- **Respect SOP §11 sequencing.** The SOP explicitly says: handle 10–15 cases manually first, *then* automate. The orchestrator ships in `shadow` mode. Don't flip to `assist` until Audrey signs off.
- **Human gates are features, not bugs.** Chargebacks are low-volume (dozens/month) and high-consequence ($ thousands each). The ROI on full automation here is low; the ROI on *augmentation* is enormous. Keep the humans decisive.
- **Event bus durability matters.** A missed event = a lost case = a lost chargeback. Use a durable queue (Redis Streams, SQS, or Kafka) with at-least-once delivery + idempotency keys.
- **The 15-min Gmail poll is a cheap safety net.** Push notifications from Gmail are best-effort. The poll costs nothing and catches everything.
- **The orchestrator does NOT learn.** It routes. Learning lives in outcome-analyst, which emits `learning_signal` events to the other agents. Keep the orchestrator dumb and reliable.
- **Phase 4.5 (future):** once win rate stabilizes and volume grows, consider adding `chargeback-intake-prevention` — a proactive agent that flags high-risk reservations *before* the chargeback arrives (weak ID, short-notice cancellation policy, known-risky guest). That's a different roadmap item.

---

## 16. Phase 4 Summary — What This Stack Delivers

**Before the stack (Audrey's manual SOP):**
- Audrey checks inbox daily, opens notices, extracts fields by hand.
- Searches Streamline by cardholder name + amount + date.
- Pulls evidence from 9 different systems manually — Streamline, DocuSign, rental guardian, Superhog, Autohost, Akia, PointCentral, Good Neighbor Tech, Stripe/Lynnbrook, Google Drive.
- Drafts narrative from scratch following Judy's voice rules.
- Submits, tracks, logs outcome in Google Sheet.
- Generates monthly report manually.
- Estimated time per case: **6–10 hours.**

**After the stack (Phase 4 at steady state):**
- Gmail push → case created, parsed, matched, dossier assembled, narrative drafted: **all before Audrey sees it.**
- Audrey opens Asana task. Reviews proposed match (if not auto). Reviews dossier + narrative + draft notes. Edits if needed. Submits via portal. Done.
- Estimated human time per case: **30–60 minutes** (primarily at the two human gates).
- Monthly report generated automatically, delivered 3 PM last business day.
- Quarterly strategic review delivered with integration-ROI investment cases.
- **Outcome:** Audrey handles 3–4x case volume at 2 losses / ~50 cases rate (matching Judy's baseline), evidence gaps systematically identified, monthly operational feedback drives property/process improvements.

**Net business impact (illustrative, pending real data):**
- ~100 chargebacks/year × avg $1,800 disputed = $180K exposure annually
- Win-rate lift from industry avg (~65%) to Judy baseline (96%) = $55K/year additional recovered
- Audrey time saved: 7 hrs/case × 100 cases = 700 hrs/year reallocated to owner success
- Integration ROI signals compound — each gap closed raises the baseline further

**Phase 4 pack inventory:**
1. `chargeback-inbox-monitor.md`
2. `chargeback-reservation-matcher.md`
3. `chargeback-dossier-builder.md`
4. `chargeback-narrative-drafter.md`
5. `chargeback-case-tracker.md`
6. `chargeback-outcome-analyst.md`
7. `chargeback-orchestrator.md` (this file)

Next: **Phase 5 — Utility Bill Manager** (3 sub-agents), then **Phase 6 — Dashboards & Cross-product**.
