# Utility Credit Applier — Prompt Pack

**Agent:** `utility-credit-applier`
**Phase:** 5 (Utility Bill Manager)
**Parent Orchestrator:** `utility-orchestrator`
**Trigger:** Monthly — Business Day -2 at 9:00 AM (region-local). Plus event-driven re-runs for late-arriving bills (BD+1 catch-up).
**Owner:** Accounting (Kimberly / Wendell) approves; Jocelyn reviews edge cases; Jason visibility on monthly totals.
**SLA:** Credit batch ready by BD-2 EOD. Approval window BD-1. JE posted via RevPost on BD.

---

## 1. Purpose

At month-end, take every utility bill ingested this month, **compute the owner statement credit** for each, batch by owner, and hand off to **RevPost** (`revpost-je-builder` in Phase 3) to post the credit journal entries to Sage Intacct.

This is the loop-closing agent. Without it, Phase 5 is just "Claude drafts emails." With it, Phase 5 is a full revenue-recovery pipeline that recovers owner-owed utility costs into credits on the monthly owner statement automatically.

---

## 2. System Prompt

```
You are the Utility Credit Applier for ACME House Company. At month-end,
you process every utility bill ingested this month into owner statement
credits and hand them to RevPost (Phase 3) for Sage Intacct posting.

Your core calculation, per bill:
  credit = bill_amount × (guest_nights_in_service_period / total_nights_in_service_period)

This allocates the bill proportionally between guest-stay nights (owner
gets credit from the deposits) and owner-use nights (owner bears cost).

Examples:
- Bill = $200, service period = 30 nights, guest stays = 18 nights
  → credit = $200 × 18/30 = $120.00
- Bill = $200, service period = 30 nights, guest stays = 30 nights
  → credit = $200 (full pass-through)
- Bill = $200, service period = 30 nights, guest stays = 0 nights
  → credit = $0 (no outreach should have been made; flag)

Constraints:
- NEVER post an unverified bill. Any bill flagged needs_human_verify must
  be cleared first or excluded from this run.
- HANDOFF TO REVPOST — do NOT post JEs directly to Sage. Phase 3 owns Sage
  posting. You produce a structured batch; revpost-je-builder handles
  GL coding, dimensions, idempotency keys, and posting.
- IDEMPOTENT per (region, month, run_id). Re-runs within the same month
  must reconcile additions/reversals, not duplicate credits.
- HUMAN APPROVAL GATE is non-negotiable. Accounting approves the batch
  before RevPost posts. Even at maturity.
- PER-OWNER STATEMENT GROUPING. One credit entry per owner per month
  (summing all bills and properties), with line-item detail preserved
  in the memo.

Output: per-owner credit batch with line items, ready for Accounting
approval and RevPost handoff.
```

---

## 3. Task Prompt Template

```
Compute owner statement credit batch for region {region}, month {YYYY-MM}.

Pull all utility_collections_bills where:
  region = {region}
  service_period overlaps month
  status = ingested (not excluded: needs_human_verify, parse_failed,
    property_ambiguous, unless resolved)

For each bill:
1. Compute guest-night allocation (Streamline reservations overlap)
2. Compute credit amount = bill × (guest_nights / total_period_nights)
3. Validate credit <= bill (sanity)
4. Attach to owner's credit line

Aggregate per owner. Build the batch. Post to Slack for Accounting
approval. On approval → hand to revpost-je-builder.
```

---

## 4. Step-by-Step Workflow

### Step 1 — Load Candidate Bills

Query `utility_collections_bills`:
```sql
WHERE region = :region
  AND (service_period_start <= :month_end AND service_period_end >= :month_start)
  AND status = 'ingested'
  AND needs_human_verify = false
  AND flags NOT CONTAINING ('property_ambiguous', 'parse_failed', 'unresolved')
```

Separately surface excluded bills (needs verify, ambiguous, parse fail) in the batch summary so Accounting sees what's pending.

### Step 2 — Reservation Overlap Calculation

For each bill, query Streamline for all ST reservations at `bill.property_id` where:
- `check_out >= bill.service_period_start`
- `check_in <= bill.service_period_end`
- `status IN ('completed', 'checked_out')`

For each reservation, compute the **overlap nights** with the bill's service period:
```
overlap_start = max(reservation.check_in, bill.service_period_start)
overlap_end   = min(reservation.check_out, bill.service_period_end)
overlap_nights = max(0, (overlap_end - overlap_start).days)
```

Sum `overlap_nights` across all reservations → `total_guest_nights_in_period`.

Compute `total_nights_in_period = (service_period_end - service_period_start).days + 1`.

### Step 3 — Credit Calculation

```
guest_night_fraction = total_guest_nights_in_period / total_nights_in_period
credit_amount_usd    = round(bill.amount_due_usd × guest_night_fraction, 2)
owner_bears_usd      = bill.amount_due_usd - credit_amount_usd
```

Validations:
- `credit_amount_usd ≤ bill.amount_due_usd` (always true by math, sanity)
- `guest_night_fraction ≤ 1.0`
- If `total_guest_nights_in_period == 0` → credit = 0; FLAG bill (why did we collect it? likely data issue — maybe reservations not yet synced)
- If `guest_night_fraction == 1.0` → full pass-through, note in memo

### Step 4 — Aggregate Per Owner

Group all bills (across properties) by `owner_id`. For each owner:
```json
{
  "owner_id": "owner_5521",
  "owner_name": "Jason Toledo",
  "region": "socal",
  "month": "2026-04",
  "bills": [
    {
      "bill_id": "uuid-1",
      "property_id": "prop_421",
      "property_name": "Coachella Canyon Retreat",
      "provider_canonical": "sce",
      "service_period": "2026-03-01 to 2026-03-31",
      "bill_amount_usd": 187.44,
      "guest_nights": 18,
      "total_nights": 31,
      "guest_night_fraction": 0.5806,
      "credit_amount_usd": 108.82,
      "owner_bears_usd": 78.62,
      "bill_gmail_thread_url": "...",
      "archived_bill_pdf_url": "..."
    },
    {
      "bill_id": "uuid-2",
      "property_id": "prop_421",
      "provider_canonical": "coachella_valley_water",
      "service_period": "2026-03-01 to 2026-03-31",
      "bill_amount_usd": 42.18,
      "guest_nights": 18,
      "total_nights": 31,
      "credit_amount_usd": 24.49,
      "owner_bears_usd": 17.69
    }
  ],
  "owner_totals": {
    "bills_count": 2,
    "gross_bill_amount_usd": 229.62,
    "total_credit_amount_usd": 133.31,
    "total_owner_bears_usd": 96.31
  },
  "flags": []
}
```

### Step 5 — Build RevPost Handoff Payload

For each owner credit, construct the RevPost-ready JE request:

```json
{
  "owner_id": "owner_5521",
  "owner_payable_account_code": "2100-OWNER",  // from config
  "utility_expense_clearing_account": "5200-UTIL-CLEARING",  // from config
  "total_credit_usd": 133.31,
  "memo": "Utility deposit credit — April 2026 statement — owner_5521 — Coachella Canyon Retreat — 2 bills (SCE + CVWD) — 18/31 guest nights",
  "dimensions": {
    "entity": "casago-socal-st",
    "location": "coachella-valley",
    "department": "owner-services",
    "property": "prop_421",
    "owner": "owner_5521"
  },
  "line_items": [
    {
      "gl_account": "2100-OWNER",
      "dr_cr": "CR",  // credit to owner payable
      "amount_usd": 133.31,
      "memo_detail": "Utility credit - April 2026"
    },
    {
      "gl_account": "5200-UTIL-CLEARING",
      "dr_cr": "DR",  // debit clearing account (will be offset when bill paid / passed through)
      "amount_usd": 133.31,
      "memo_detail": "Utility credit offset - April 2026"
    }
  ],
  "idempotency_key": "util-credit-{owner_id}-{region}-{month}",
  "source": "utility-credit-applier",
  "supporting_docs": [
    "https://drive.google.com/.../bill_sce_march.pdf",
    "https://drive.google.com/.../bill_cvwd_march.pdf"
  ]
}
```

### Step 6 — Batch Summary & Accounting Approval

Build a summary:
- Total bills processed
- Total owners with credits
- Gross bill amount total
- Total credits to post
- Total owner-bears amount
- Excluded bills requiring human verify (list)
- Any flagged bills (zero-night, full-period, unusual)

Post to `#accounting-center-approvals` Slack with:
- Inline summary
- Link to Google Sheet with full line-item detail (auto-generated)
- Link to batch JSON for RevPost
- Approval buttons: `APPROVE BATCH` / `HOLD FOR REVIEW` / `REJECT`
- Create Asana task assigned Kimberly with BD-1 EOD due date

### Step 7 — Wait for Approval (Human Gate)

Block on Accounting decision. Possible outcomes:
- **APPROVE** → proceed to Step 8
- **HOLD FOR REVIEW** → Accounting edits specific line items (adjusts credit amounts, excludes bills) → re-run with edits applied → re-approve
- **REJECT** → cancel batch, log, escalate to Jocelyn for root-cause

No auto-posting without approval — this is the only financial-postings pathway in Phase 5 and gets the same rigor as RevPost's own gates.

### Step 8 — Handoff to RevPost

For each approved owner credit:
- Submit to `revpost-je-builder` via its event API.
- Include idempotency key — RevPost's own idempotency check should catch duplicates if re-submitted.
- Persist mapping: `utility_credit_run.revpost_je_id` when returned.

### Step 9 — Confirm Posting + Notify

Once RevPost confirms JE posted in Sage:
- Update each bill's `status = credit_applied` + `revpost_je_number`.
- Update owner record with rolling total of credits applied.
- Post confirmation to `#team_support_owner_success`:
  > "Utility credits posted to Sage for April 2026 — 45 owners, $6,847 total. Detail: [Sheet link]"

### Step 10 — Late-Arriving Bills (BD+1 and later)

Bills ingested after BD-2 cutoff:
- Accumulate in `utility_collections_bills` with `pending_next_month_run` flag
- Roll into next month's credit-applier run
- Owner sees credit on the FOLLOWING month's statement with clear memo noting the late-arrival context

Never back-date credits into a closed month.

---

## 5. Output Schema

```json
{
  "region": "socal",
  "month": "2026-04",
  "run_id": "credit-socal-2026-04",
  "generated_at": "2026-04-29T09:15:00Z",
  "batch_summary": {
    "owners_with_credits": 42,
    "total_bills_included": 78,
    "gross_bill_amount_usd": 14239.87,
    "total_credits_to_post_usd": 8224.40,
    "total_owner_bears_usd": 6015.47,
    "excluded_bills_needs_verify": 3,
    "excluded_bills_property_ambiguous": 1,
    "flagged_zero_guest_nights": 2,
    "flagged_full_period_pass_through": 7
  },
  "owner_credits": [ /* array of owner credit records, see Step 4 */ ],
  "approval": {
    "submitted_at": "2026-04-29T09:30:00Z",
    "approver": null,
    "approved_at": null,
    "status": "pending",
    "asana_task_url": "..."
  },
  "revpost_handoff": {
    "submitted_at": null,
    "jes_submitted_count": 0,
    "jes_posted_count": 0,
    "errors": []
  },
  "status": "pending_approval"
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Zero-guest-night bill | Flag — collection should not have happened; Jocelyn reviews |
| Full-period (100% guest) pass-through | Not an error but always flag for audit visibility |
| Owner credit > $500 (unusually large) | Flag for Kimberly's eyes specifically |
| Region total > $20k monthly (capacity breakpoint) | Post visibility note to Jason — scaling signal |
| > 10% of ingested bills excluded due to verify flags | Systemic quality issue — Jocelyn coordinates with bill-ingestor OCR retraining |
| Late-arriving bill > 2 months old | Flag for Jocelyn before including — confirm legitimacy |
| Reservation data not yet synced (zero guest nights but cycle said they were there) | Retry in 24h before excluding |
| Owner has pending chargeback related to same property/stay | Coordinate with Chargeback Manager — may need to hold credit until chargeback resolves |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Streamline reservation lookup fails for a property | Retry 2x; if fails, exclude bills for that property, flag, continue others |
| RevPost returns JE posting error | Capture error, hold batch in `partial_posted` state, alert Accounting |
| Approval task times out (no decision by BD-1 EOD) | Escalate to Jason; default to NOT posting until explicit approval |
| Idempotency collision (re-submitting same run_id) | Return cached batch; do NOT re-hand-off to RevPost |
| Drive document link broken | Log, still post with note; Accounting can access via cycle ID |
| Bill service period spans 2 months | Allocate proportionally to each month's run (partial-month allocation math) |

---

## 8. Tools Required

- **Database:** `utility_collections_bills`, `owners`, `utility_credit_runs`
- **Streamline MCP:** `get_reservations` for overlap calc, `get_property_info`
- **RevPost interface:** emit JE request events to `revpost-je-builder` (Phase 3)
- **Slack MCP:** `slack_send_message` for approval request
- **Asana MCP:** `create_tasks` for approval task
- **Google Sheets API:** generate detail sheet for human review
- **Google Drive MCP:** surface archived bill PDFs in approval package
- **LLM (Claude):** memo composition, sanity checks

---

## 9. Handoff Contract

**Upstream:** Monthly BD-2 trigger from orchestrator + cumulative bills from bill-ingestor.

**Downstream:**
- Accounting approval (human gate)
- `revpost-je-builder` (Phase 3) — JE posting to Sage
- `#team_support_owner_success` confirmation post
- Dashboard metrics update

**Side-effects:**
- `utility_credit_runs` row per month per region
- `utility_collections_bills.status` updated to `credit_applied` post-success
- Sage Intacct JE posted (via RevPost)
- Owner statement credit reflected on next monthly owner statement (downstream of Sage)

---

## 10. Configuration

```yaml
utility_credit_applier:
  schedule_day: bd_minus_2
  schedule_time_local: "09:00"
  approval_deadline: bd_minus_1_eod
  approval_channel: "#accounting-center-approvals"
  confirmation_channel: "#team_support_owner_success"
  approval_asana_project: "Accounting / Month-End"
  approval_assignees:
    primary: kimberly
    backup: wendell
  gl_accounts:
    socal:
      owner_payable: "2100-OWNER-SOCAL"
      utility_clearing: "5200-UTIL-CLEARING-SOCAL"
    arizona:
      owner_payable: "2100-OWNER-AZ"
      utility_clearing: "5200-UTIL-CLEARING-AZ"
  dimensions_template:
    socal:
      entity: "casago-socal-st"
      department: "owner-services"
    arizona:
      entity: "casago-arizona-st"
      department: "owner-services"
  unusual_credit_threshold_usd: 500
  region_capacity_flag_usd: 20000
  verify_excluded_max_pct_acceptable: 10
  late_bill_max_age_months_auto: 2
  partial_month_allocation: proportional
  handoff_target: revpost-je-builder
  revpost_idempotency_key_template: "util-credit-{owner_id}-{region}-{month}"
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Clean month, 40 owners, 78 bills, all verified | Batch computed, posted for approval, approved, RevPost posts 40 JEs |
| T2 | Bill with 18/31 guest nights | credit = bill × 18/31, rounded to cents |
| T3 | Bill with 0 guest nights | credit = 0, flagged, excluded from RevPost handoff unless Jocelyn approves inclusion |
| T4 | Bill spanning 2 months (Mar 15 - Apr 14) | Proportional split across March and April runs |
| T5 | Owner with 3 properties, 5 bills total | Single owner credit entry aggregating all 5; line detail preserved |
| T6 | 3 bills flagged needs_human_verify | Excluded from batch, surfaced in summary for resolution |
| T7 | Accounting rejects batch (data issue) | Batch held, root-cause to Jocelyn, next-day re-run |
| T8 | Accounting edits: exclude 1 owner, reduce another | Re-batch with edits, re-approval, RevPost post adjusted set |
| T9 | RevPost fails on 2 of 40 JEs (GL account issue) | 38 posted successfully, 2 held, Accounting alerted, partial-posted status |
| T10 | Late bill (3 months old) arrives Apr 5 | Held; flagged for Jocelyn confirmation; if approved, rolled into April run |
| T11 | Re-run of same month run_id | Idempotent — returns cached batch, no duplicate RevPost submissions |
| T12 | Owner has chargeback tied to same property same stay dates | Credit held; coordinate with Chargeback Manager |

---

## 12. Success Metrics

- **Monthly credit batch on-time completion** — 100% ready by BD-2 EOD.
- **Approval latency** — Accounting approves ≤ BD-1 EOD in > 95% of runs.
- **RevPost posting success rate** — > 99% of JEs post first-try (failures indicate GL coding drift).
- **Verify-exclusion rate** — < 5% of bills excluded for verify issues (quality signal on bill-ingestor).
- **Owner statement accuracy** — 0 post-statement disputes about utility credits (the ultimate test).
- **Credit-to-collection efficiency** — % of ingested bill amount that ends up as owner credit (vs owner-bears) — target baseline ~55-70% depending on guest-night mix.

---

## 13. Notes for Implementation

- **The guest-night math is the whole product.** Everything else is plumbing. A wrong allocation lands an owner either over-credited (chargeback risk) or under-credited (relationship hit). Unit-test the math with edge cases.
- **Partial-month overlap is subtle.** Bills don't respect calendar months. A March 15 – April 14 bill must split. Proportional by actual overlap days with each month's cycle reservations.
- **Never bypass Accounting approval.** The entire Accounting Center stack treats financial postings with human gates at maturity. This is correct even after 12 months. $10k+ monthly credits flowing to owner statements unchecked is not a trust position we want.
- **RevPost handoff is the clean handoff pattern.** Do not replicate Sage logic here. `revpost-je-builder` owns GL coding, dimensions, idempotency, posting. Produce clean batch data and let it do its job.
- **Coordinate with Chargeback Manager (Phase 4).** If an owner has an active chargeback at the same property during the bill period, consider whether the credit should wait — winning the chargeback may affect what the owner is owed.
- **Late-arriving bills are normal.** Don't chase perfection of "every bill this month in this month's run." Roll-forward to next month is acceptable and honest. Over-engineering same-month enforcement creates bugs.
- **The monthly confirmation post is free marketing for Phase 5.** "Utility credits posted: 45 owners, $6,847 this month" — that's the visible loop-closure that demonstrates the automation earning its keep. Post it every month even if the team doesn't need the info.
- **Phase 5 ends here.** Bills collected, credits applied, owners happy, Accounting trail clean. This is the full loop. Any enhancement beyond this point (proactive bill fetching, cost-anomaly detection, leak-proxy alerting) is Phase 5.5 territory.
