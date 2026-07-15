# Utility Collection Checker — Prompt Pack

**Agent:** `utility-collection-checker`
**Phase:** 5 (Utility Bill Manager)
**Parent Orchestrator:** `utility-orchestrator`
**Trigger:** `owners_identified` event from `utility-owner-identifier` (Mon 7:10 AM region-local).
**Owner:** Jocelyn → Owner Success.
**SLA:** Complete within 5 minutes of being triggered.

---

## 1. Purpose

Given the list of owners with utility obligations this cycle, **scan the regional Gmail inbox for bills that have already arrived** and filter those owners out — we never ask an owner for a bill they already sent.

This agent is the politeness layer. The entire collection rate target (80% within 14 days) depends on owners NOT being re-pestered after they've already complied.

---

## 2. System Prompt

```
You are the Utility Collection Checker for ACME House Company.

Your job is to take a list of owners with utility deposit obligations and
classify each as:
  - already_collected  — we have a bill from them covering the current cycle
  - partial_collected  — we have a bill but it looks incomplete (missing
    account, wrong period, unclear amount)
  - not_collected      — nothing received yet for this cycle
  - opt_out            — owner explicitly opted out (safety net)

You scan the regional Gmail inbox (owner@casagosocal.com OR
owner@casagoarizona.com) for messages from each owner's email addresses
within the current cycle window (last 7 days + current Monday).

Constraints:
- MATCH CONSERVATIVELY. False positive (= don't contact an owner who should
  be contacted) is worse than false negative (= contact someone who already
  sent a bill). The former loses collection volume; the latter is recoverable
  through politeness.
- IDENTIFY BILL ATTACHMENTS by filename patterns + MIME type, not just
  subject line. Owners send "invoice.pdf", "bill.pdf", "IMG_1234.jpg",
  "water_march.pdf" — all legitimate.
- SAFETY NET for opt-outs: re-check each owner's opt_out_status and any
  recent message containing opt-out phrases.
- Idempotent: same cycle_id returns same classification.

Output: enriched owners[] array with classification, plus owners_to_draft[]
filtered list for the next agent.
```

---

## 3. Task Prompt Template

```
Check collection status for region {region}, cycle {cycle_id}.

Given owners[]: {owners_from_identifier}

For each owner:
1. Search regional Gmail inbox for messages FROM owner's email in window
   {window_start} to {now}
2. Classify each thread: is this a utility bill submission?
3. If bill present, validate: covers current cycle? amount parseable?
   attachment present?
4. Re-check opt_out_status via Gmail content and master record

Return owners[] with collection_status populated, plus:
- owners_to_draft[]: owners needing outreach this cycle
- owners_already_collected[]: owners already handled
- owners_opted_out[]: safety-net catches
```

---

## 4. Step-by-Step Workflow

### Step 1 — Build Gmail Search Queries (Per Owner)

For each owner, build a Gmail search query:
```
from:(owner_email_primary OR owner_email_alternates)
after:{cycle_window_start}
before:{now}
```

Use `mcp__310bacd1...__gmail_search_messages` with one query per owner (or batch via OR where Gmail syntax permits).

Window:
- `cycle_window_start` = last successful collection date for this owner, OR cycle_start - 14 days, whichever is later
- Rationale: if owner sent a bill 3 weeks ago, the bill for *this* cycle might still be coming — don't count old bills as current.

### Step 2 — Classify Each Matching Thread

For every thread returned:

**Signal checks (weighted):**
| Signal | Weight |
|---|---|
| Attachment: PDF, JPG, PNG, HEIC in thread | +50 |
| Filename contains: "bill", "invoice", "statement", "water", "electric", "gas", "utility", "account", month name, utility-provider name | +20 |
| Subject contains similar keywords | +15 |
| Body mentions dollar amount ($XXX.XX) | +15 |
| Body contains service period / month reference | +10 |
| Thread has a reply from Owner Success acknowledging receipt | +25 |
| Body contains opt-out phrase | -∞ (override to opt_out) |

**Classification thresholds:**
- Score ≥ 60 AND attachment present → `already_collected`
- Score 30–59 OR no attachment but strong body signals → `partial_collected` (flag for human confirm)
- Score < 30 OR no matching thread → `not_collected`
- Opt-out phrase detected → `opt_out` (route to orchestrator for escalation to Jocelyn)

### Step 3 — Period Validation for `already_collected`

Parse the bill period from the thread (attachment OCR if needed, or body text):
- Extract service period: "March 2026" / "3/1 - 3/31" / etc.
- Match against current cycle's trailing-30 window.
- If bill period doesn't overlap the cycle window → downgrade to `not_collected` — it's an old bill, still need current one.
- If bill period overlaps ≥ 50% of the window → confirm `already_collected`.
- If OCR / parsing fails → `partial_collected`, flag for Owner Success manual confirm.

### Step 4 — Opt-Out Safety Net

Even if owner is not flagged opt_out in the master record, scan the thread bodies for opt-out phrases (configurable list from orchestrator §11 safety block):
- "don't contact" / "do not contact"
- "stop sending"
- "unsubscribe"
- "remove me"
- "please stop"
- LLM sanity check: does the message, read as a whole, express an intent to stop receiving these requests?

If detected → reclassify as `opt_out`, emit `opt_out_received` event to orchestrator for handling.

### Step 5 — Persist Classifications

Write to `utility_collections` for each owner this cycle:
- `status` = the classification
- `bill_gmail_thread_id` (if found)
- `bill_received_at` timestamp
- `bill_period_claimed`
- `bill_amount_extracted_usd` (if OCR'd in-line — otherwise left for bill-ingestor)
- `partial_reason` (if partial)

### Step 6 — Emit `collection_check_complete`

Return enriched array with classifications, plus filtered `owners_to_draft[]` for the draft-composer.

---

## 5. Output Schema

```json
{
  "region": "socal",
  "cycle_id": "socal-2026-W16",
  "checked_at": "2026-04-13T14:10:37Z",
  "owners": [
    {
      "owner_id": "owner_5521",
      "collection_status": "not_collected",
      "last_checked_gmail_query": "from:jason.toledo@example.com after:2026-03-30 before:2026-04-13",
      "threads_matched": 0
    },
    {
      "owner_id": "owner_2019",
      "collection_status": "already_collected",
      "bill_gmail_thread_id": "18d...",
      "bill_received_at": "2026-04-10T16:22:00Z",
      "bill_period_claimed": "2026-03",
      "bill_amount_extracted_usd": 187.44,
      "classification_score": 92,
      "attachments": ["water_bill_march.pdf"]
    },
    {
      "owner_id": "owner_3301",
      "collection_status": "partial_collected",
      "bill_gmail_thread_id": "18e...",
      "partial_reason": "attachment present but no parseable amount",
      "classification_score": 48,
      "human_confirmation_required": true
    },
    {
      "owner_id": "owner_7777",
      "collection_status": "opt_out",
      "detected_phrase": "please stop sending these",
      "gmail_thread_id": "18f...",
      "detected_at": "2026-04-11T08:14:00Z",
      "requires_orchestrator_escalation": true
    }
  ],
  "owners_to_draft": ["owner_5521", "owner_8822", "owner_9944", ...],
  "owners_already_collected": ["owner_2019", "owner_1155", ...],
  "owners_partial": ["owner_3301"],
  "owners_opted_out": ["owner_7777"],
  "stats": {
    "total_owners_checked": 18,
    "already_collected": 4,
    "partial_collected": 1,
    "not_collected": 12,
    "opt_out": 1
  }
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| New opt-out detected | Emit `opt_out_received` → orchestrator escalates to Jocelyn, updates master record |
| `partial_collected` case | Add to Slack summary separately so Owner Success eyes the thread and confirms/resolves |
| `already_collected` rate in cycle < 20% AND cycle count > 10 | Flag to Jocelyn — unusual, maybe last cycle's drafts didn't actually send |
| Owner's bill thread shows a reply from Owner Success but no acknowledgment reply from us in > 5 days | Flag for follow-up courtesy acknowledgment |
| Bill attachment filename matches another owner's bill pattern (possible mis-delivery) | Flag for human review, do NOT auto-classify |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Gmail search API rate limit | Batch queries, backoff, retry |
| Gmail search times out on large inbox | Narrow window to 7 days first, retry with longer only if needed |
| OCR for period extraction fails | Fall back to body-text date extraction; if that fails, `partial_collected` |
| Owner has 15 separate email addresses | Query each; OR them where syntax supports |
| Gmail inbox unavailable | Retry 2x; if persistent, mark cycle `partial` with all owners as `not_collected` (safest — outreach will go out, even if redundant to owners who already sent bills) |

---

## 8. Tools Required

- **Gmail MCP:** `gmail_search_messages`, `gmail_read_thread`, `gmail_read_message`
- **PDF/OCR library** (for lightweight period parsing only — full extraction is bill-ingestor's job)
- **Database:** write `utility_collections` status rows
- **Event bus:** emit `collection_check_complete`, `opt_out_received`

---

## 9. Handoff Contract

**Upstream:** `owners_identified` event with owners[] from identifier.

**Downstream:** `collection_check_complete` to draft-composer; `opt_out_received` to orchestrator (urgent path).

**Side-effects:**
- `utility_collections` rows updated per owner with classification.
- Audit log entries.

---

## 10. Configuration

```yaml
utility_collection_checker:
  gmail_search_window_days_default: 14
  classification_thresholds:
    already_collected_min_score: 60
    partial_min_score: 30
  bill_filename_keywords:
    - bill
    - invoice
    - statement
    - water
    - electric
    - gas
    - utility
    - account
    - january
    - february
    - march
    - april
    - may
    - june
    - july
    - august
    - september
    - october
    - november
    - december
  bill_body_keywords:
    - service period
    - billing period
    - amount due
    - statement
  opt_out_phrases:
    - "don't contact"
    - "do not contact"
    - "stop sending"
    - "unsubscribe"
    - "remove me"
    - "please stop"
    - "take me off"
  partial_flag_for_human: true
  conservative_mode: true  # bias toward sending when unsure
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Owner sent water_bill_march.pdf 3 days ago | Classified `already_collected`, score >= 80 |
| T2 | Owner sent a note saying "I'll send next week" with no attachment | `not_collected`, body signals don't meet threshold |
| T3 | Owner replied "please remove me from this list" | `opt_out`, orchestrator escalation event fired |
| T4 | Owner sent bill for February (outside current cycle window) | Downgraded to `not_collected`, current bill still needed |
| T5 | Owner has 2 emails on file, only sent from alternate address | Both emails queried, bill found, classified correctly |
| T6 | Owner replied with unclear PDF (maybe a receipt not a bill) | `partial_collected`, flagged for human |
| T7 | Gmail search rate limited | Batched with backoff, completes inside SLA |
| T8 | Owner sent two different bills (water + electric) in separate threads same week | Both counted; classification `already_collected` with both thread IDs |
| T9 | New owner never emailed us before | `not_collected`, score 0 |
| T10 | Same cycle re-run | Cached result; no duplicate DB writes |

---

## 12. Success Metrics

- **False positive rate** (we said `already_collected` but owner hadn't actually sent): target < 2%. Detected by Owner Success catching it during draft review.
- **False negative rate** (we said `not_collected` but owner did send): target < 5%. Detected by owner reply: "I already sent this."
- **Opt-out detection recall:** 100% — no missed opt-outs. Tested monthly by QA sample.
- **Run time:** p95 < 3 min.

---

## 13. Notes for Implementation

- **Conservative bias is the right default.** When in doubt, include in drafting. Owner Success edits/cancels in 10 seconds; an owner complaining "I already sent this" costs a relationship minute.
- **Opt-out detection is the safety-net-of-safety-nets.** The orchestrator also has opt-out detection. This agent catches it during Monday runs as a last chance before we email again.
- **Period matching is non-trivial.** Utility bills are dated by service period, not send date. A March bill sent April 3 is for current cycle; a February bill sent April 3 is not. Get this right or collection rate metrics lie.
- **Do NOT extract full bill amounts here.** Partial extraction for classification only. The `utility-bill-ingestor` agent is the canonical extractor — it runs async anyway. Duplicating that logic here creates drift.
