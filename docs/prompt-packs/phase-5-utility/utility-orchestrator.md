# Utility Bill Manager — Orchestrator — Prompt Pack

**Agent:** `utility-orchestrator`
**Phase:** 5 (Utility Bill Manager)
**Role:** Parent agent coordinating all 6 Phase 5 sub-agents across two regional instances.
**Trigger:**
- Weekly: Every Monday 7:00 AM (local region time) — runs full outreach pipeline
- Always-on: Gmail push + 15-min poll safety net for inbound bill replies
- Monthly: Business Day -2 at 9 AM — runs credit application to owner statements
**Owner:** Jocelyn (Director of Support) + Owner Success team (SoCal + AZ).
**Target outcome (from PRD-00 §3):** Utility bill collection rate within 14 days: 50% → **>80%.**

---

## 1. Purpose

Phase 5 automates the weekly owner utility bill collection cycle that Owner Success runs by hand today. The orchestrator is the Claude SDK parent that:

1. Dispatches the Monday pipeline across **two regional instances** (SoCal + Arizona).
2. Keeps the always-on bill-ingestion path alive (owners don't reply on a schedule).
3. Coordinates the **monthly** credit-application path into RevPost.
4. Enforces the **maturity ladder** — starts in human-review mode, graduates repeat owners to auto-send after confidence builds.
5. Reports health + collection metrics to the Accounting Center dashboard.

**Design principle:** This is the simplest product in the Accounting Center stack. Resist over-engineering. The value is in showing up every Monday, reliably, with scannable drafts Owner Success can send in 5 minutes.

---

## 2. System Prompt

```
You are the Utility Bill Manager Orchestrator for ACME House Company. You
coordinate 6 specialized sub-agents that together automate weekly owner
utility bill outreach, bill ingestion, and month-end statement credit
application.

The 6 sub-agents:
1. utility-owner-identifier    — pulls owners with utility deposit obligations from Streamline
2. utility-collection-checker  — checks Gmail for bills already received this cycle
3. utility-draft-composer      — creates personalized Gmail drafts
4. utility-slack-notifier      — posts Monday summary to Owner Success
5. utility-bill-ingestor       — parses owner-replied bill PDFs, extracts amounts
6. utility-credit-applier      — generates owner statement credits (hands off to RevPost)

You run TWO regional instances with identical pipeline logic:
- SoCal:    Gmail = owner@casagosocal.com    | Streamline = SoCal PMS   | TZ = America/Los_Angeles
- Arizona:  Gmail = owner@casagoarizona.com  | Streamline = Arizona PMS | TZ = America/Phoenix

Your job:
- Fire the Monday 7:00 AM pipeline per region, in region-local time
- Monitor the always-on bill inbox via Gmail push + 15-min poll safety net
- Fire the month-end credit application on BD-2
- Enforce the maturity ladder (human-review → auto-send for repeat owners)
- Surface failures to Jocelyn (operational) and to the dashboard

Constraints:
- NEVER send email without the drafted draft passing human review, UNLESS the
  owner is in the "auto-send approved" list per the maturity ladder.
- IDEMPOTENT: each weekly cycle has a cycle_id = "{region}-{YYYY-WW}".
  Re-runs in the same cycle must not create duplicate drafts.
- REGIONAL SEPARATION: SoCal and Arizona are completely independent runs.
  A failure in one must not block the other.
- RESPECT REGION TIME ZONES. SoCal 7 AM PT ≠ Arizona 7 AM AZ. Use local time.
- BILL INGESTION RESPECTS OWNER INTENT. If owner says "don't contact me for
  utilities" (opt-out) — honor it indefinitely until they opt back in.

Your outputs: regional dispatch events, Slack summaries, dashboard metrics,
escalations to Jocelyn for opt-outs and errors.
```

---

## 3. Event Flow — Three Pipelines

```
┌─────────────────────────── WEEKLY MONDAY PIPELINE ───────────────────────────┐
│                                                                              │
│  Mon 7:00 local                                                              │
│         ▼                                                                    │
│  owner-identifier    → returns [owners with utility deposit obligations]    │
│         ▼                                                                    │
│  Mon 7:10 local                                                              │
│         ▼                                                                    │
│  collection-checker  → scans Gmail, filters already-collected owners        │
│         ▼                                                                    │
│  Mon 7:20 local                                                              │
│         ▼                                                                    │
│  draft-composer      → creates Gmail drafts for remaining owners            │
│         ▼                                                                    │
│  Mon 7:30 local                                                              │
│         ▼                                                                    │
│  slack-notifier      → posts summary to #team_support_owner_success         │
│         ▼                                                                    │
│  HUMAN GATE: Owner Success reviews drafts, sends (or approves auto-send)    │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

┌───────────────── ALWAYS-ON BILL INGESTION PIPELINE ──────────────────────────┐
│                                                                              │
│  Gmail push → bill-ingestor (both regional inboxes)                         │
│         ▼                                                                    │
│  parse attachment, OCR amount, match to owner + property + reservation      │
│         ▼                                                                    │
│  persist to utility_collections table                                        │
│         ▼                                                                    │
│  auto-reply acknowledgment to owner                                          │
│         ▼                                                                    │
│  mark owner "collected" for current cycle                                    │
│                                                                              │
│  (15-min poll safety net catches missed pushes)                             │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────── MONTH-END CREDIT APPLICATION PIPELINE ───────────────────┐
│                                                                              │
│  BD-2 at 09:00 local                                                         │
│         ▼                                                                    │
│  credit-applier   → aggregates all collected bills this month               │
│         ▼                                                                    │
│  creates per-owner statement credit requests                                 │
│         ▼                                                                    │
│  handoff to revpost-je-builder (Phase 3) for Sage JE posting                │
│         ▼                                                                    │
│  HUMAN GATE: Accounting approves credit batch before posting                │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Event Bus

```yaml
events:
  # Weekly pipeline
  - name: weekly_cycle_started
    emitter: utility-orchestrator
    consumers: [utility-owner-identifier]
    payload: {region, cycle_id, triggered_at_local}

  - name: owners_identified
    emitter: utility-owner-identifier
    consumers: [utility-collection-checker]
    payload: {region, cycle_id, owners[]}

  - name: collection_check_complete
    emitter: utility-collection-checker
    consumers: [utility-draft-composer]
    payload: {region, cycle_id, owners_to_draft[], owners_already_collected[]}

  - name: drafts_ready
    emitter: utility-draft-composer
    consumers: [utility-slack-notifier]
    payload: {region, cycle_id, drafts[], skipped[], errors[]}

  - name: summary_posted
    emitter: utility-slack-notifier
    consumers: [dashboard]
    payload: {region, cycle_id, slack_thread_url, counts}

  # Always-on ingestion
  - name: inbound_bill_detected
    emitter: gmail_push | gmail_poll_safety_net
    consumers: [utility-bill-ingestor]
    payload: {region, gmail_message_id}

  - name: bill_ingested
    emitter: utility-bill-ingestor
    consumers: [dashboard, utility-orchestrator]  # orchestrator marks owner "collected"
    payload: {region, owner_id, amount, property_id, bill_period, gmail_message_id}

  - name: opt_out_received
    emitter: utility-bill-ingestor
    consumers: [utility-orchestrator, jocelyn]  # owner explicitly opts out
    payload: {region, owner_id, message}
    human_gate: true

  # Month-end
  - name: monthly_credit_run_started
    emitter: utility-orchestrator
    consumers: [utility-credit-applier]
    payload: {region, month, run_id}

  - name: credit_batch_ready
    emitter: utility-credit-applier
    consumers: [revpost-je-builder, accounting]  # handoff + human gate
    payload: {region, month, credits[], total_credit_usd}
    human_gate: true
```

---

## 5. Schedules

```yaml
schedules:
  # Weekly — per region in local time
  socal_monday_outreach:
    cron: "0 7 * * 1"
    tz: America/Los_Angeles
    pipeline: weekly
    region: socal

  arizona_monday_outreach:
    cron: "0 7 * * 1"
    tz: America/Phoenix
    pipeline: weekly
    region: arizona

  # Always-on — every 15 min both regions
  gmail_poll_safety_net_socal:
    cron: "*/15 * * * *"
    tz: America/Los_Angeles
    region: socal

  gmail_poll_safety_net_arizona:
    cron: "*/15 * * * *"
    tz: America/Phoenix
    region: arizona

  # Month-end — BD-2
  socal_monthly_credit:
    cron_bd: "09:00 BD-2"
    tz: America/Los_Angeles
    pipeline: monthly_credit
    region: socal

  arizona_monthly_credit:
    cron_bd: "09:00 BD-2"
    tz: America/Phoenix
    pipeline: monthly_credit
    region: arizona
```

---

## 6. Maturity Ladder

Per PRD-00 §9 Future Enhancements, the orchestrator supports progressive automation of the human-review gate:

| Mode | Draft → Send | When |
|---|---|---|
| `human_all` | Human reviews every draft, sends manually | Weeks 1–4. Baseline. |
| `assisted` | Human reviews, one-click-send from Slack summary | Week 5+. Owner Success faster. |
| `auto_repeat` | After 3 consecutive cycles of an owner receiving the same template unchanged, auto-send on cycle 4 unless opted-out | Month 3+. Per PRD. |
| `auto_trusted` | Specific owners (manually whitelisted by Jocelyn) auto-send from cycle 1 | For owners who have received 10+ consistent drafts and never had an edit flagged |

State per owner tracked in `utility_collections.owner_automation_tier`:
- `new` — first ever outreach → always `human_all`
- `building_trust` — cycles 1–3 for this template → `human_all`
- `eligible_auto_repeat` — 3+ consecutive unchanged → `auto_repeat` on next run
- `trusted` — whitelisted by Jocelyn → `auto_trusted`
- `opt_out` — owner requested no contact → skip entirely

The orchestrator decides per-owner per-cycle which mode applies and passes it to draft-composer, which then either (a) saves to drafts for review or (b) sends directly.

**Hard rule:** Any cycle where we would auto-send but the reservation count this cycle is atypical (> 2σ from owner's trailing 12-cycle mean) reverts to `human_all`. Unusual = human eyes.

---

## 7. Dispatch Patterns

### Weekly pipeline (per region, sequential)
```python
async def run_weekly_pipeline(region):
    cycle_id = f"{region}-{iso_year_week_now(region)}"
    if idempotency.seen(cycle_id):
        return  # already ran this week

    owners = await owner_identifier.run(region=region, cycle_id=cycle_id)
    check = await collection_checker.run(region=region, cycle_id=cycle_id, owners=owners)
    drafts = await draft_composer.run(region=region, cycle_id=cycle_id,
                                       owners_to_draft=check.owners_to_draft,
                                       owner_automation_tiers=fetch_tiers(check.owners_to_draft))
    await slack_notifier.run(region=region, cycle_id=cycle_id, drafts=drafts)
    emit("weekly_cycle_complete", region, cycle_id)
```

### Always-on bill ingestion (event-driven)
```python
async def on_inbound_bill_detected(event):
    if idempotency.seen(event.payload.gmail_message_id):
        return
    result = await bill_ingestor.run(region=event.payload.region,
                                      gmail_message_id=event.payload.gmail_message_id)
    if result.is_opt_out:
        await escalate_to_jocelyn(result)
    elif result.ingested:
        mark_owner_collected(result.owner_id, result.bill_period)
```

### Month-end credit application (per region)
```python
async def run_monthly_credit(region, month):
    run_id = f"credit-{region}-{month}"
    if idempotency.seen(run_id):
        return
    batch = await credit_applier.run(region=region, month=month, run_id=run_id)
    # Handoff to RevPost (Phase 3)
    await revpost_je_builder.handoff(batch)
    # Notify accounting
    await slack.post("#accounting-center-approvals", batch.summary())
```

---

## 8. Human Gates

Three gates per PRD-00 §9. None bypass in Phase 5 v1.

| Gate | Who | Where | SLA |
|---|---|---|---|
| **Draft review & send** | Owner Success team | Gmail drafts (regional inbox) + Slack summary | Same day (Monday) ideal; Tuesday EOD hard SLA |
| **Opt-out handling** | Jocelyn | Slack escalation + opt-out form | 24h — update owner record before next cycle |
| **Monthly credit batch approval** | Kimberly / Wendell (Accounting) | Slack + Asana approval task | BD-1 EOD (before reversing entries next month) |

---

## 9. Error Handling — Orchestrator-level

| Error | Handling |
|---|---|
| Sub-agent timeout | Retry once with 60s backoff; on fail, alert Jocelyn, log cycle as `partial`, preserve whatever drafts succeeded. |
| One region fails, other succeeds | Isolate — do NOT roll back the healthy region. Alert on the failing one. |
| Streamline API down | Skip weekly cycle, alert Jocelyn, fall back to "last good owner list" only for informational Slack post (no drafts created). |
| Gmail push silent > 3h | Rely on 15-min poll; alert if 3+ polls return empty when Gmail inbox activity visible in UI. |
| Idempotency collision (cycle re-run) | Drop silently, log, post info-level notice to Slack. |
| Opt-out detected mid-cycle | Immediately tag owner `opt_out`, cancel any pending draft for that owner, alert Jocelyn. |
| Month-end credit posting conflicts with RevPost reversal | Hold credit batch, alert Kimberly, resolve before posting. |

---

## 10. Observability

Metrics published to the Accounting Center dashboard:

- `utility.cycle.owners_identified{region}` — gauge per cycle
- `utility.cycle.owners_drafted{region}` — gauge
- `utility.cycle.owners_skipped_already_collected{region}` — gauge
- `utility.cycle.owners_opted_out{region}` — gauge (lifetime count)
- `utility.cycle.auto_sent_count{region}` — gauge
- `utility.bill.ingested_count{region}` — counter
- `utility.bill.amount_total_usd{region,month}` — gauge
- `utility.collection_rate_14d{region}` — gauge — **NORTH STAR METRIC** (target > 80%)
- `utility.time_to_first_bill_days{region}` — histogram p50/p90
- `utility.monthly_credits_applied_usd{region,month}` — gauge
- `utility.monthly_credits_count{region,month}` — gauge
- `utility.errors{agent,region}` — counter

Dashboard panel (Phase 6): one card per region + combined roll-up with 14-day collection rate as the headline.

---

## 11. Configuration

```yaml
utility_orchestrator:
  regions:
    socal:
      gmail_inbox: owner@casagosocal.com
      streamline_mcp: socal
      slack_channel: "#team_support_owner_success"
      tz: America/Los_Angeles
    arizona:
      gmail_inbox: owner@casagoarizona.com
      streamline_mcp: arizona
      slack_channel: "#team_support_owner_success"
      tz: America/Phoenix

  event_bus: redis://...
  audit_log: postgres://.../accounting_audit_log
  idempotency_store: redis://.../utility_idempotency

  subagents:
    owner_identifier:    {timeout_s: 120, retries: 2}
    collection_checker:  {timeout_s: 120, retries: 2}
    draft_composer:      {timeout_s: 180, retries: 1}
    slack_notifier:      {timeout_s: 30,  retries: 3}
    bill_ingestor:       {timeout_s: 90,  retries: 2}
    credit_applier:      {timeout_s: 600, retries: 1}

  maturity:
    default_mode: human_all
    promote_to_auto_repeat_after_unchanged_cycles: 3
    auto_trusted_whitelist: []          # Jocelyn-managed
    revert_if_reservation_count_sigma_over: 2.0

  safety:
    opt_out_phrases:
      - "don't contact"
      - "do not contact"
      - "stop sending"
      - "unsubscribe"
      - "remove me"
      - "please stop"
    atypical_reservation_sigma_threshold: 2.0

  sla:
    draft_review_same_day_pref: true
    draft_review_hard_deadline: tuesday_eod
    opt_out_processing_hours: 24
    monthly_credit_approval_bd: bd_minus_1

  metrics_prefix: "utility"
  dashboard_feed: accounting_center
```

---

## 12. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Clean Monday 7 AM SoCal run, 18 owners, 4 already collected | 14 drafts created, Slack summary posted, cycle logged. |
| T2 | Both regions run same Monday | SoCal fires at 7 AM PT, AZ fires at 7 AM AZ (1h later during DST); completely independent. |
| T3 | Streamline API outage during owner-identifier | Cycle marked partial, Jocelyn alerted, no drafts created, no Slack summary (since nothing to report). |
| T4 | Owner replies with bill PDF on Wednesday | Ingestor parses within 60s, acknowledgment sent, dashboard updates, owner marked collected. |
| T5 | Owner replies "please stop sending these" | Ingestor detects opt-out, sets `opt_out`, cancels any queued drafts, notifies Jocelyn. |
| T6 | Owner is on auto_repeat tier, cycle 4 of same template | Draft sends automatically; Slack summary includes "AUTO-SENT: 6 owners". |
| T7 | Owner is on auto_repeat but reservation count 5× typical | Reverts to human_all for this cycle, flags reason in Slack. |
| T8 | Orchestrator restarted Monday at 7:05 AM (during cycle) | Durable event replay; idempotency prevents duplicate drafts. |
| T9 | Owner@casagosocal.com mailbox full | Draft creation fails, alert Jocelyn, suggest archive/cleanup. |
| T10 | Month-end BD-2 credit run, 45 bills collected this month | Credit batch built, handoff to RevPost, Accounting approval task created. |
| T11 | Same owner, two properties, both have utility obligations | Single consolidated draft listing both properties + both bills requested. |
| T12 | Owner replies with bill PDF for the wrong property | Ingestor flags `property_mismatch`, holds bill, asks Owner Success to confirm manually. |

---

## 13. Success Metrics

- **14-day collection rate** — PRD-00 target >80%. Primary success metric.
- **Owner Success time per Monday cycle** — baseline ~2 hrs manual → target <15 min review.
- **Auto-send penetration by month 6** — target ≥ 40% of cycles auto-sent without human edit.
- **Month-end credit batch accuracy** — 100% of ingested bills applied; zero disputes.
- **Opt-out rate** — track but expect < 5% (owners who push back on utility pass-through are operationally significant).
- **Monday cycle reliability** — 100% fire-on-time rate across both regions.

---

## 14. Notes for Implementation

- **Phase 5 is the simplest product — resist gold-plating.** The PRD explicitly calls it out as "already validated" and the week-17–18 launch window. Ship it minimal and let the data drive enhancements.
- **Regional separation is non-negotiable.** Two Streamline instances, two Gmail inboxes, two time zones. One orchestrator, two isolated runs. Don't share state between regions beyond reporting.
- **Maturity ladder is the whole long-term story.** Week-one human-all is fine. By month six, auto-send should handle the majority of cycles. That's the labor-saving win.
- **Opt-outs matter more than volume.** An opted-out owner who gets another automated email is a relationship incident. Detection has to be aggressive (regex + LLM sanity check) and honored indefinitely.
- **Bill ingestion is the silent star.** The weekly outreach is visible; the 24/7 ingestion pipeline that extracts amounts from random utility PDFs is where the actual time savings live. Invest OCR quality there.
- **Month-end credit hand-off to RevPost closes the loop.** Without the credit-applier, this is just a "Claude drafts emails" tool. With it, it's a full revenue-recovery workflow that recovers owner-owed utility costs into cash automatically each month.
- **Future Phase 5.5:** proactive bill collection — fetch bills directly from utility provider accounts (many owners already pay-by-account, we could receive e-bills). That's a different scope — requires owner consent + credential vaulting. Park for now.
