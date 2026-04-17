# Month-End Close Orchestrator — Prompt Pack

**Agent:** `month-end-close-orchestrator`
**Phase:** 6 (Dashboards & Cross-product)
**Parent Orchestrator:** `accounting-orchestrator`
**Trigger:** Fired by accounting-orchestrator at BD-3 (3 business days before month-end) at 08:00 PT; also responds to `close_step_complete` events during the close window
**Owner:** Kimberly (Accounting Lead, primary), Jason (backup + technical)
**SLA:** Target monthly close cycle ≤ 2 business days (vs current 5-7 BD)

---

## 1. Purpose

The Accounting Center's month-end close involves every product: revenue posting, trust reconciliation, chargeback reserves, utility credits, owner statements, and final trial balance. Done manually, this takes Kimberly's team 5-7 business days. With products automated individually but uncoordinated, we'd shave time but still miss the compounding gains.

This agent **sequences the close across all products** with the right dependencies, approval gates, and fallback paths. Target: close the books in 2 business days with a clean trial balance, zero orphan entries, and a signed-off package ready for Mike.

It's a meta-orchestrator — it does not do accounting work itself; it **fires the right product-level agents in the right order with the right prerequisites**.

---

## 2. System Prompt

```
You are the Month-End Close Orchestrator for the ACME House Company
Accounting Center.

You coordinate the monthly close across five products: TrustSync, OTAAuditor,
RevPost, Chargeback Manager, Utility Bill Manager. You do not post JEs,
reconcile accounts, or generate statements yourself — you delegate to the
product-level agents and enforce the sequence.

Your sequence (high level):
  1. Data cutoff — freeze the period
  2. OTAAuditor final reconciliation
  3. RevPost final revenue decomposition + posting
  4. Utility credit batch (BD-2)
  5. TrustSync final reconciliation
  6. Chargeback reserve calculation
  7. Month-end accrual/deferral JEs (RevPost)
  8. Trial balance validation (MUST be zero variance before proceeding)
  9. Owner statement generation
  10. Final review package for Kimberly sign-off
  11. Close complete → emit close_completed event

Rules:
- NO STEP SKIPS. If step N fails, close halts. Kimberly decides to remediate
  and resume, or roll back.
- TRIAL BALANCE IS THE GATE. Never proceed past step 8 with non-zero variance.
- APPROVALS ARE HUMAN. Kimberly approves the final package; you cannot
  self-approve.
- TIME IS THE PRODUCT. Every step shows ETA, progress, blocker if any, on a
  live dashboard. The entire close cycle is visible from BD-3 through close.
- RESUMABLE. If the orchestrator or a product fails mid-cycle, resume from
  the last completed step — never restart from BD-3.
- IMMUTABLE HISTORY. Every close writes to close_cycles table with full
  step log, timings, approvers. Never overwrite.

Voice (for dashboard + Slack):
- Progress-oriented, precise timestamps, ETA transparency.
- "Step 3/10: RevPost Final Posting — in progress (start 14:02 PT,
  ETA 14:40 PT). 847 JEs processed, 0 errors."
```

---

## 3. Task Prompt Template

```
Drive the month-end close for period {period_yyyy_mm}, region {center|socal|arizona}.

Current step: {step_name}
Previous step result: {prev_step_result}
Cycle state: {cycle_state_json}

Decide:
1. Are we in the right place? (resume or fresh start)
2. Prerequisites for current step — all met?
3. Fire the step's product agent
4. Monitor completion
5. Record result, move to next step OR halt on failure

Return cycle_state update, Slack progress post, dashboard tile update.
```

---

## 4. Step-by-Step Workflow

### Step 0 — Close Calendar

Close windows defined in `close_calendar`:
- **BD-3 (3 business days before month-end):** cycle kickoff; products begin catch-up
- **BD-2:** Utility credit batch; owner-facing deadlines pass
- **BD-1:** OTA payout cutoffs; vendor bill cutoffs
- **BD 0 (last business day of month):** Data freeze at 23:59 PT
- **BD+1:** Final posting + trial balance; target close by 17:00 PT
- **BD+2:** Slack close announcement, package to Mike

### Step 1 — Data Cutoff (BD 0 at 23:59 PT)

Freeze the period in every source system:
- Streamline: mark period closed for read-only
- Column Bank: final balance snapshot at 23:59:59 PT
- Sage Intacct: period-lock guards against back-dated entries
- OTA portals: final payout register pull

Emit `period_frozen`. All subsequent product work references the frozen snapshot.

### Step 2 — OTAAuditor Final Reconciliation (BD+1 morning)

Fire `otaauditor-cycle` with `mode=close_final`:
- All 7 markets
- Reprocess any open exceptions
- Auto-match anything matchable
- Flag remaining exceptions for Kimberly manual resolution (hard gate — cannot proceed with open exceptions)

Wait for `otaauditor_close_complete` event.

Hard gate: `exceptions_open == 0` OR Kimberly explicitly approves carry-forward.

### Step 3 — RevPost Final Posting

Fire `revpost-decomposer` with `mode=close_final`:
- Decompose every reservation in the closed period
- Build JEs
- Fire `revpost-je-builder` → `revpost-sage-poster`
- All JEs tagged `close_period={period}`

Wait for `revpost_close_posting_complete`.

Sanity check: total revenue posted = sum of reservations × rates. Variance > $50 halts.

### Step 4 — Utility Credit Batch (actually runs at BD-2, result consumed here)

`utility-credit-applier` ran at BD-2 and emitted `credit_batch_approved` (after Kimberly signed off). The JE payload was queued for RevPost; at this step we verify:
- All utility credits for the period are now posted JEs in Sage (via RevPost)
- No utility bills remaining in `pending_review` status for the period

Hard gate: pending utility reviews == 0.

### Step 5 — TrustSync Final Reconciliation

Fire `trustsync-eod-reconcile` in `mode=month_end`:
- Match Column Bank trust account balance to Sage trust GL account
- Reconcile ST→LT transfers against reservations
- Reconcile LT→ST monthly reversals
- Produce reconciliation report

Wait for `trustsync_reconcile_complete`.

Hard gate: trust-account variance < $0.01. Any variance halts close (money-in-motion issue).

### Step 6 — Chargeback Reserve Calculation

Fire `chargeback-reserve-calc` (sub-agent of chargeback manager for close):
- Open disputes at period end × expected-loss-rate (historical)
- Write reserve JE request for Kimberly approval
- Post approved reserve JE via RevPost

Wait for `chargeback_reserve_posted`.

Sanity check: reserve ≤ 5% of monthly gross revenue (otherwise flag for review — something's wrong).

### Step 7 — Accrual / Deferral JEs

Fire `revpost-monthend`:
- Prepaid guest bookings (deferred revenue)
- Unbilled owner fees (accrued revenue)
- Prepaid vendor bills (prepaid expense)
- Accrued operational expenses

Wait for `monthend_accruals_posted`.

All entries tagged `adjustment=true` and `reversing=true` (auto-reverse at BD+1 of next month).

### Step 8 — Trial Balance Validation (HARD GATE)

Fire `revpost-trial-balance` in `mode=close_validation`:
- Pull full trial balance from Sage
- Validate debits = credits to the penny
- Validate all intercompany balances = 0
- Validate trust accounts reconcile to prior step

Three outcomes:
- **Balanced** → proceed to step 9
- **Variance < $1.00** → Kimberly decides (usually round/post to variance account, proceed)
- **Variance ≥ $1.00** → HALT. Create Asana investigation task. Close does not proceed.

This is the non-negotiable gate.

### Step 9 — Owner Statement Generation

Fire `owner-statement-generator` (future product; stub for now):
- One statement per owner with prior-month activity
- Revenue, expenses, fees, utility credits, chargebacks, net payout
- PDF + online portal + email
- Batch generation, parallel workers

Wait for `statements_generated_complete`.

If owner-statement-generator not yet built (pre-launch), generate via existing manual process and mark step as `human_completed`.

### Step 10 — Final Review Package

Assemble closing package for Kimberly:
- Trial balance (final)
- P&L summary (vs prior month, vs budget)
- Balance sheet snapshot
- Variance analysis narrative (cross-product-reporter feeds this)
- Exception log (anything carried forward to next period)
- Audit-log summary (cross-product-reporter + audit-log-reader)
- One-click `/close approve` or `/close halt` commands

Delivered via Slack DM + dashboard modal. Kimberly reviews, approves or sends back for fix.

### Step 11 — Close Complete

On Kimberly approval:
- Mark period closed in Sage
- Lock period in Streamline (write-protect)
- Generate archive bundle (PDF + JSON of all approved docs + audit log)
- Emit `close_completed` event
- Post celebration message in `#accounting-center-alerts` with stats (cycle duration, JE count, variance = $0.00)
- Clear the dashboard's "close in progress" banner
- Schedule next month's close kickoff (BD-3 of next month)

---

## 5. Cycle State Schema

```json
{
  "cycle_id": "close-2026-04",
  "period": "2026-04",
  "kickoff_at": "2026-04-28T08:00:00-07:00",
  "target_complete_by": "2026-05-04T17:00:00-07:00",
  "current_step": 4,
  "status": "in_progress | halted | completed | rolled_back",
  "steps": [
    {
      "step": 1,
      "name": "data_cutoff",
      "started_at": "2026-04-30T23:59:00-07:00",
      "completed_at": "2026-04-30T23:59:47-07:00",
      "result": "success",
      "actor": "system",
      "audit_refs": ["audit_c1","audit_c2"]
    },
    {
      "step": 2,
      "name": "otaauditor_final",
      "started_at": "2026-05-01T08:00:00-07:00",
      "completed_at": "2026-05-01T09:14:22-07:00",
      "result": "success",
      "actor": "otaauditor-orchestrator",
      "exceptions_open": 0,
      "audit_refs": ["audit_c3"]
    },
    {
      "step": 3,
      "name": "revpost_final",
      "started_at": "2026-05-01T09:14:30-07:00",
      "status": "in_progress",
      "je_count_so_far": 847,
      "eta": "2026-05-01T11:30:00-07:00"
    }
  ],
  "kimberly_approval_at": null,
  "jason_escalation_at": null,
  "total_duration_hours": null,
  "variance_final_usd": null,
  "rollback_history": []
}
```

---

## 6. Output Schema

**Close cycle completion:**
```json
{
  "cycle_id": "close-2026-04",
  "period": "2026-04",
  "kickoff_at": "2026-04-28T08:00:00-07:00",
  "completed_at": "2026-05-04T16:42:18-07:00",
  "total_business_days": 2.1,
  "approved_by": "@kimberly",
  "approved_at": "2026-05-04T16:40:03-07:00",
  "trial_balance_variance_usd": 0.00,
  "je_count": 4127,
  "statements_generated": 487,
  "exceptions_carried_forward": 0,
  "archive_bundle_url": "https://drive.acme.../close-2026-04.zip",
  "archive_bundle_checksum": "sha256:...",
  "steps_summary": [...],
  "kpi_impacts": {
    "close_cycle_bd_actual": 2.1,
    "close_cycle_bd_target": 2.0,
    "improvement_vs_prior": -0.3
  }
}
```

---

## 7. Escalation Triggers

| Condition | Action |
|---|---|
| Trial balance variance ≥ $1.00 | HALT close; CRITICAL alert to Kimberly + Jason; Asana investigation task |
| Any product step fails 3 retries | HALT; alert product owner; Kimberly decides to skip-with-note or wait for fix |
| Close not complete by BD+2 17:00 PT | Slack warning + escalate to Jason; daily progress posts until done |
| Kimberly unavailable at approval step | Fallback to Jason; approval required within 4 hrs of step 10 completion |
| Trust reconciliation variance > $0.01 | HALT + CRITICAL — money-in-motion issue; same-day resolution required |
| Chargeback reserve > 5% of revenue | Flag for Kimberly review before posting; likely data anomaly |
| Orchestrator itself crashes mid-close | Resume from `current_step` on restart; alert Jason |
| Rollback requested by Kimberly | Execute rollback plan per step (reverse JEs, un-lock period); log full trail |

---

## 8. Error Handling

| Error | Handling |
|---|---|
| Product agent timeout (> step SLA) | Retry once with fresh input; if still times out, HALT with detailed reason |
| Sage Intacct period-lock interferes | Unlock briefly with elevated credential, re-lock post-posting; audit-log the unlock |
| OTA portal data not yet final by BD+1 | Wait up to 4 hrs, then escalate to OTA vendor; carry-forward if truly unavailable (rare) |
| Duplicate JE detected | Idempotency check catches; do not double-post; log dedup |
| Close restarted after crash | Replay cycle state; skip completed steps; resume at first non-completed step |
| Kimberly rejects final package | Roll back to step specified in her rejection note; re-run from there |

---

## 9. Tools Required

- **Event bus:** subscribe to all product close-events; emit `close_kickoff`, `close_step_complete`, `close_completed`, `close_halted`, `close_rolled_back`
- **Database:** read/write `close_cycles`, `close_steps`, `close_approvals`
- **Sage Intacct:** period lock/unlock (elevated credential)
- **Slack MCP:** progress posts, approval commands, Kimberly DM
- **Dashboard:** live close-progress tile
- **Archive storage:** bundle assembly + signed URLs
- **Asana MCP:** investigation task creation on halt

---

## 10. Handoff Contract

**Upstream:** Fired by `accounting-orchestrator` at BD-3; receives product completion events.

**Downstream:**
- `close_completed` → kpi-computer (close cycle metric), cross-product-reporter (monthly report), dashboard-builder (archive home)
- `close_halted` → alert-router (CRITICAL)
- `close_step_complete` → dashboard-builder (progress update)

**Side-effects:**
- `close_cycles` + `close_steps` table writes (immutable per cycle)
- Sage period lock/unlock (audited)
- Streamline period write-protect
- Archive bundle in Drive

---

## 11. Configuration

```yaml
month_end_close_orchestrator:
  close_calendar_table: "close_calendar"
  cycles_table: "close_cycles"
  steps_table: "close_steps"
  timezone: "America/Los_Angeles"
  kickoff_bd_offset: -3
  target_complete_bd_offset: 2
  target_complete_time: "17:00"
  data_cutoff_time: "23:59"
  steps:
    - name: "data_cutoff"
      agent: "system"
      sla_minutes: 5
      hard_gate: false
    - name: "otaauditor_final"
      agent: "otaauditor-orchestrator"
      agent_mode: "close_final"
      sla_minutes: 180
      hard_gate: true
      gate_condition: "exceptions_open == 0 OR human_approved_carry_forward"
    - name: "revpost_final"
      agent: "revpost-decomposer"
      agent_mode: "close_final"
      sla_minutes: 240
      hard_gate: true
      gate_condition: "variance_usd < 50"
    - name: "utility_credit_check"
      agent: "system"
      sla_minutes: 10
      hard_gate: true
      gate_condition: "pending_review_bills == 0"
    - name: "trustsync_reconcile"
      agent: "trustsync-eod-reconcile"
      agent_mode: "month_end"
      sla_minutes: 120
      hard_gate: true
      gate_condition: "variance_usd < 0.01"
    - name: "chargeback_reserve"
      agent: "chargeback-reserve-calc"
      sla_minutes: 60
      hard_gate: false
      human_sanity_check: "reserve_pct_of_revenue < 0.05"
    - name: "accruals_deferrals"
      agent: "revpost-monthend"
      sla_minutes: 90
      hard_gate: false
    - name: "trial_balance"
      agent: "revpost-trial-balance"
      agent_mode: "close_validation"
      sla_minutes: 30
      hard_gate: true
      gate_condition: "variance_usd < 1.00"
      hardest_gate: true
    - name: "owner_statements"
      agent: "owner-statement-generator"
      sla_minutes: 180
      hard_gate: false
      fallback: "human_completed"
    - name: "final_review_package"
      agent: "cross-product-reporter"
      sla_minutes: 30
      hard_gate: false
    - name: "kimberly_approval"
      agent: "human"
      approver_slack: "@kimberly"
      backup_approver_slack: "@jason"
      sla_minutes: 240
      hard_gate: true
  archive:
    drive_folder: "Accounting Center — Close Archives"
    bundle_format: "zip_with_pdf_and_json"
    retention: "7y"
  rollback_policy:
    allowed_steps: ["accruals_deferrals","chargeback_reserve","trial_balance"]
    requires_approval: "@kimberly"
    logs_to: "close_rollbacks"
  dashboard:
    tile_name: "Month-End Close"
    update_frequency_seconds: 30
  slack:
    progress_channel: "#accounting-center-alerts"
    celebration_emoji: ":chart_with_upwards_trend:"
    approval_dm: "@kimberly"
```

---

## 12. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Clean close, no exceptions | Completes in ~2 BD, zero variance, Kimberly approves; archive bundle generated |
| T2 | OTAAuditor has 3 open exceptions at BD+1 | Halts at step 2; Kimberly resolves, resumes |
| T3 | Trial balance variance of $4.23 detected | HALT at step 8; CRITICAL alert; Asana investigation; does not proceed |
| T4 | Trust variance of $0.02 detected | HALT at step 5; same-day resolution required |
| T5 | Orchestrator crashes after step 3 | On restart, resumes at step 4; no double-work |
| T6 | Kimberly on PTO at approval step | Falls back to Jason after 4 hrs |
| T7 | Rollback requested after step 8 (variance found post-hoc) | Reverses JEs from step 7, resume at step 7; full audit trail |
| T8 | Close extends to BD+3 (slow) | Daily progress posts; Jason escalation; completes eventually |
| T9 | Utility bills have 2 in `pending_review` | Halts at step 4; bill-ingestor completes reviews; resumes |
| T10 | Owner-statement-generator not yet built | Step 9 auto-marks `human_completed`; manual process runs in parallel |
| T11 | Chargeback reserve calc returns 8% of revenue (anomaly) | Flag for Kimberly review; she investigates data, approves corrected number |
| T12 | First-ever close using this orchestrator | Shadow-mode: runs alongside manual close; compare outputs; promote after 2 clean cycles |

---

## 13. Success Metrics

- **Close cycle duration:** ≤ 2.0 business days (target), ≤ 2.5 (yellow), > 2.5 (red)
- **Trial balance variance at close:** $0.00 (target), < $1.00 (acceptable), ≥ $1.00 (fail)
- **Exceptions carried forward:** 0 target, ≤ 2 acceptable
- **Owner statement generation completeness:** 100%
- **Kimberly time spent during close:** ≤ 4 hrs total (vs 20-30 hrs manual) — measured by Asana time tracking
- **Close cycle consistency:** variance between months in cycle duration < 0.5 BD
- **Rollback incidents:** < 1 per quarter (if higher, step gates need tightening)

---

## 14. Notes for Implementation

- **Launch in shadow mode for 2 cycles.** Run alongside the existing manual close; compare final trial balance, JE counts, statements generated. Promote to lead-orchestrator only when parity holds twice.
- **The trial balance gate is sacred.** Every other gate can be human-overridden in edge cases. Trial balance cannot. If it doesn't balance, something is wrong and the close doesn't finish. Period.
- **Resumability is the difference between 2 BD and 5 BD.** If the orchestrator has to restart from step 1 every time something hiccups, you've lost the gains. Engineer for "resume from last completed step."
- **Kimberly owns the approval.** This is not a technical decision — she's accountable to the CEO and to regulators for the books. The orchestrator makes her job faster; it doesn't replace her judgment.
- **Rollback is a first-class operation.** When something gets caught post-posting (wrong reserve, missed accrual), rollback + re-run from step X is the answer. Full audit trail of rollbacks.
- **Celebration matters.** Close days are stressful. A Slack post when the cycle completes — with stats, the archive link, and a thank-you — makes it feel like the win it is. This was one of the largest pain points in the business; celebrate beating it.
- **The cycle log is gold for the CFO narrative.** "We closed April in 2.1 BD with zero variance" is a board-deck line. Preserve the full step log for trend analysis.
- **Connect to the Streamline migration carefully.** March 2026 is the migration; the first close after migration will be extra scrutiny. Plan for it — maybe run the migration-month close with extra shadow-mode checks.
- **This is where the 80% automation of accounting promise gets delivered.** The CFO doesn't feel the daily savings — they feel it at close. If the close is fast and clean, the entire Accounting Center investment pays off.
