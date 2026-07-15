# Utility Owner Identifier — Prompt Pack

**Agent:** `utility-owner-identifier`
**Phase:** 5 (Utility Bill Manager)
**Parent Orchestrator:** `utility-orchestrator`
**Trigger:** Monday 7:00 AM (region-local) via orchestrator `weekly_cycle_started` event.
**Owner:** Jocelyn → Owner Success team.
**SLA:** Complete within 5 minutes.

---

## 1. Purpose

Identify every owner who has an **active utility deposit obligation** this cycle — i.e., has had reservations in the trailing 30 days that consumed utility deposits and therefore needs to submit a bill for deposit credit processing.

The output is a deduplicated, enriched list of owners that the collection-checker (next agent) uses to filter out anyone who already sent a bill.

---

## 2. System Prompt

```
You are the Utility Owner Identifier for ACME House Company.

Your job is to query Streamline for every owner in the given region who had
reservations in the trailing 30 days consuming utility deposits, consolidate
multi-property owners into a single record, and enrich with the data the
draft-composer will need: owner name, email, properties, reservation dates,
guest nights, trust type, and known utility-bill history.

Constraints:
- Region-bound: only query the configured Streamline instance for the region.
- Honor opt-outs: exclude owners currently flagged opt_out.
- Honor trust type: only STrust (short-term) reservations drive utility
  obligations. LT reservations have utilities paid by long-term tenants.
- Idempotent: cycle_id scoped. Re-run returns identical result.
- Always return the full list — downstream agents decide who to skip. Don't
  make collection-status decisions here.

Output: a sorted, deduplicated array of owners with enriched detail.
```

---

## 3. Task Prompt Template

```
Identify utility deposit obligations for region {region}, cycle {cycle_id}.

Trailing window: {cycle_start_date} - 30 days through {cycle_start_date}.

For this region's Streamline instance:
1. Pull all ST reservations with check-out in the window (excludes in-progress)
2. Group by owner_id
3. For each owner: load owner profile, properties, contact info, opt-out flag
4. Filter out opt_out owners
5. Compute per-owner summary: properties touched, reservation count, total
   guest nights, earliest check-in, latest check-out
6. Return sorted by owner_last_name asc
```

---

## 4. Step-by-Step Workflow

### Step 1 — Query Reservations
- Tool: `mcp__182489f5...__get_reservations`
- Filters:
  - `region = {region}` (maps to Streamline instance)
  - `trust_type = ST` (short-term only)
  - `checkout_date BETWEEN cycle_start - 30d AND cycle_start`
  - `status IN ('completed', 'checked_out')` — exclude in-progress/cancelled
- Return fields needed: reservation_id, property_id, owner_id, check_in, check_out, guest_count, nights

### Step 2 — Enrich with Owner Data
- Tool: `mcp__182489f5...__get_owner_info` (bulk where possible)
- For each unique owner_id:
  - owner_name (first + last)
  - owner_email (primary + any alternates)
  - owner_phone
  - preferred_language (if set; defaults to English)
  - owner_automation_tier (from utility_collections table — see orchestrator maturity ladder)
  - opt_out_status + last_opt_out_date

### Step 3 — Enrich with Property Data
- Tool: `mcp__182489f5...__get_property_info`
- For each property referenced:
  - property_name (short display name)
  - property_address (street + city)
  - property_market (Coachella Valley, Phoenix, etc.)
  - utility_accounts_on_file (if Streamline carries any)
  - utility_pass_through_clause (boolean — is this property contractually set up for utility pass-through)

### Step 4 — Filter & Dedupe
- Drop owners where opt_out_status = true (orchestrator already hinted at this; double-check here).
- Drop owners whose properties do NOT have utility_pass_through_clause = true.
  - Reason: some contracts bundle utilities; those owners should NOT receive outreach.
  - Log excluded owners for audit (but don't return them).
- Consolidate multi-property owners into one record with a `properties[]` array.

### Step 5 — Compute Per-Owner Summary
For each owner, compute:
- `reservation_count` — # of distinct reservations this cycle
- `total_nights` — sum of guest nights
- `earliest_checkin` / `latest_checkout` — window dates
- `properties[]` — one entry per property with its own nights/reservations
- `priority_score` — used by draft-composer to order outputs; higher = more guest nights = more likely significant utility usage
- `trailing_12_cycles_count` — how many times this owner has received a draft in the last 12 weeks (for maturity-ladder calc)

### Step 6 — Historical Context
- Load from `utility_collections` table:
  - Last bill submitted date
  - Last bill amount
  - Consecutive unchanged-template cycle count (for auto_repeat tier eligibility)
  - Any outstanding unreimbursed bills > 30 days old (flag in output)

### Step 7 — Emit `owners_identified` event

---

## 5. Output Schema

```json
{
  "region": "socal",
  "cycle_id": "socal-2026-W16",
  "cycle_start_date": "2026-04-13",
  "window_start_date": "2026-03-14",
  "window_end_date": "2026-04-13",
  "identified_at": "2026-04-13T14:00:12Z",
  "owners": [
    {
      "owner_id": "owner_5521",
      "owner_name": "Jason Toledo",
      "owner_first_name": "Jason",
      "owner_email": "jason.toledo@example.com",
      "owner_email_alternates": [],
      "preferred_language": "en",
      "owner_automation_tier": "building_trust",
      "opt_out_status": false,
      "properties": [
        {
          "property_id": "prop_421",
          "property_name": "Coachella Canyon Retreat",
          "property_address": "1234 Canyon Dr, Palm Desert CA 92260",
          "property_market": "Coachella Valley",
          "reservation_count": 3,
          "total_nights": 11,
          "earliest_checkin": "2026-03-16",
          "latest_checkout": "2026-04-11",
          "utility_pass_through_clause": true,
          "utility_accounts_on_file": ["Coachella Valley Water", "SCE"]
        }
      ],
      "aggregate": {
        "property_count": 1,
        "reservation_count": 3,
        "total_nights": 11,
        "earliest_checkin": "2026-03-16",
        "latest_checkout": "2026-04-11"
      },
      "priority_score": 11.0,
      "history": {
        "last_bill_submitted_date": "2026-03-18",
        "last_bill_amount_usd": 214.88,
        "consecutive_unchanged_template_cycles": 2,
        "outstanding_unreimbursed_count": 0
      }
    }
  ],
  "excluded_owners": [
    {"owner_id": "owner_2019", "reason": "opt_out"},
    {"owner_id": "owner_4404", "reason": "no_utility_pass_through_clause"}
  ],
  "stats": {
    "total_identified": 18,
    "total_excluded_opt_out": 2,
    "total_excluded_no_clause": 4,
    "total_reservations": 52,
    "total_guest_nights": 164
  }
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Streamline returns 0 reservations for region (highly unusual) | Flag to Jocelyn, do NOT emit zero-length owners list as success — mark cycle `suspicious_empty_result`. |
| Owner has outstanding unreimbursed bills > 60 days old | Tag in output; draft-composer adjusts tone and Jocelyn reviews personally before send. |
| Property has utility_pass_through_clause = null (not explicitly set) | Exclude AND log to Jocelyn as "data hygiene gap — set pass-through flag in Streamline." |
| Owner with opt_out_status = true appeared in results filter stage | Expected — confirms filter working. Log count for dashboard. |
| Owner has > 5 properties — first time hitting this owner | Flag for Jocelyn's eyes; draft-composer may need custom handling. |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Streamline API timeout | Retry 2x with exponential backoff. On final failure, return partial with `status: partial`, alert orchestrator. |
| Owner record has no email | Exclude, log to `excluded_owners` with `reason: no_email_on_file`, alert Owner Success for data fix. |
| Property record missing utility_pass_through_clause field entirely (legacy data) | Treat as null, exclude, log. |
| Rate-limited by Streamline | Batch & backoff; cycle tolerates up to 5 min wait. |

---

## 8. Tools Required

- **Streamline MCP:** `get_reservations`, `get_owner_info`, `get_owner_list`, `get_property_info`, `get_owner_units`
- **Database:** read `utility_collections` (historical cycle data per owner)
- **Orchestrator event bus:** emit `owners_identified`

---

## 9. Handoff Contract

**Upstream:** `weekly_cycle_started` from orchestrator with `{region, cycle_id}`.

**Downstream:** `owners_identified` event consumed by `utility-collection-checker`, carrying the full owners[] payload.

**Side-effects:**
- Write to `utility_collections` a cycle-start row per owner with status = `pending_check`.
- Audit log entry per owner in `accounting_audit_log`.

---

## 10. Configuration

```yaml
utility_owner_identifier:
  trailing_window_days: 30
  trust_type_included: [ST]
  reservation_statuses_included: [completed, checked_out]
  require_utility_pass_through_clause: true
  exclude_opt_out: true
  priority_score_formula: "total_nights"   # future: weight by property_rate
  outstanding_bills_flag_age_days: 60
  partial_result_tolerated: true
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | SoCal cycle, 22 owners with obligations, 3 opted out, 1 no clause | Output 18 owners; excluded list has 4 entries. |
| T2 | Multi-property owner (3 properties, different markets same region) | Single owner record with properties[] length 3. |
| T3 | Owner had LT reservation only in window | Not in output — LT excluded. |
| T4 | Owner has reservation still in-progress (check-out future) | Not in output — only completed. |
| T5 | Streamline returns 0 reservations | Flagged `suspicious_empty_result`, Jocelyn alerted. |
| T6 | Owner email missing | Excluded, Owner Success data-fix alert. |
| T7 | Same owner, cycle N+1 (trailing window overlaps prior cycle) | Included again — cycle is about CURRENT window; history fields show last bill. |
| T8 | Owner has unreimbursed bill 75 days old | Flagged; draft-composer will use firm-reminder template. |
| T9 | Idempotent re-run of same cycle_id | Returns cached result; no duplicate DB rows. |
| T10 | Property pass-through clause null (unset legacy record) | Excluded + data-fix alert. |

---

## 12. Success Metrics

- **Accuracy of owner list:** % of cycles where Owner Success does NOT have to manually add/remove owners — target > 98%.
- **Run time:** p95 < 3 min.
- **Data hygiene signal:** count of `no_utility_pass_through_clause` exclusions — should trend to 0 as Streamline property setup cleans up.

---

## 13. Notes for Implementation

- **Source of truth is Streamline.** If a property doesn't have the utility_pass_through_clause flag set, we cannot infer it — flag for human setup.
- **Keep this agent dumb.** It identifies, enriches, returns. No decisions about who to contact — that's collection-checker + draft-composer + orchestrator.
- **Priority score is a hint, not a rule.** Draft-composer uses it for ordering but every eligible owner still gets a draft.
- **Historical context matters for maturity ladder.** The `consecutive_unchanged_template_cycles` field is the gateway to auto-send. Accurate computation here unlocks Phase 5's long-term labor savings.
