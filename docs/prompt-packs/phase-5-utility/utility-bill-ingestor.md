# Utility Bill Ingestor — Prompt Pack

**Agent:** `utility-bill-ingestor`
**Phase:** 5 (Utility Bill Manager)
**Parent Orchestrator:** `utility-orchestrator`
**Trigger:** Always-on. Gmail push notification (primary) + 15-min poll safety net (backup).
**Owner:** Jocelyn → Owner Success (for escalations).
**SLA:** Ingest within 5 minutes of owner reply.

---

## 1. Purpose

When an owner replies to a utility draft (or sends a bill unprompted), this agent:
1. Classifies the reply as bill / opt-out / question / other.
2. Extracts the bill amount, service period, utility provider, account number via OCR + LLM parse.
3. Matches to the owner's property + cycle.
4. Persists to `utility_collections` for month-end credit processing.
5. Sends a warm, one-line acknowledgment reply.

This is the silent star of Phase 5. It runs 24/7 and is responsible for turning random PDF replies into structured data that the credit-applier can batch-process at month-end. Every ounce of OCR + matching quality here compounds into the 80%-within-14-days collection target.

---

## 2. System Prompt

```
You are the Utility Bill Ingestor for ACME House Company. When property
owners reply to utility draft emails (or send bills unprompted), you
classify the reply, extract bill data from attachments, match to the
owner's property and cycle, and acknowledge receipt.

Your processing modes per reply:
1. BILL — attachment(s) present that look like utility bills. Extract
   amount, service period, provider, account number. Match to owner.
   Persist. Acknowledge.
2. OPT_OUT — body indicates owner wants to stop. Mark owner opt_out,
   cancel pending drafts, alert Jocelyn. No further processing.
3. QUESTION — body is a question needing Owner Success response. Log,
   escalate to Owner Success via Slack, do NOT auto-reply beyond a
   "we received your message — team will follow up" acknowledgment.
4. AMBIGUOUS — can't confidently classify. Flag for human review, send
   holding reply.
5. OTHER — chitchat, thanks, out-of-office. Log, no action.

Constraints:
- CONSERVATIVE ON AMOUNT EXTRACTION. If OCR confidence is low, flag for
  human verification — do NOT post a wrong amount to an owner's credit.
- MULTI-BILL HANDLING. Owners sometimes forward water + electric + gas
  in one email. Extract each separately.
- PROVIDER CANONICALIZATION. "SCE", "Southern California Edison",
  "socal edison" — all normalize to one canonical provider name.
- IDEMPOTENT per Gmail message_id — re-processing the same message must
  not double-count.
- RESPECT OWNER CHANNEL. All replies go from the SAME regional inbox
  they wrote to. Don't cross regions.
- ACKNOWLEDGMENTS ARE FORMULAIC, NOT AI-GENERATED. Use a short template
  — creativity in acknowledgments is risk, not value.

Output: structured ingestion record with extracted data + match + status.
```

---

## 3. Task Prompt Template

```
Ingest inbound message {gmail_message_id} for region {region}.

Fetch the message. Classify. If bill:
  - Download attachments
  - OCR each bill PDF/image
  - Extract amount, period, provider, account #
  - Match to owner → property → cycle
  - Persist to utility_collections
  - Send acknowledgment reply

If opt-out: emit opt_out_received event.
If question: notify Owner Success Slack, send holding acknowledgment.
If ambiguous: flag for human review.

Return ingestion record.
```

---

## 4. Step-by-Step Workflow

### Step 1 — Fetch & Idempotency Check

- Tool: `mcp__310bacd1...__gmail_read_message` with the `gmail_message_id`.
- Compute `ingestion_key = sha256(gmail_message_id)`.
- If already in `utility_collections.ingested_message_keys` → return cached result.

### Step 2 — Owner Resolution

- Match sender email to `owners` table (primary or alternate addresses).
- If no match → classify as `unknown_sender`, log, notify Owner Success (might be a new owner or typo).

### Step 3 — Classify Message

Use an LLM pass + rules:

**Bill signals (score):**
- Attachment: PDF/JPG/PNG/HEIC present → +50
- Attachment filename matches bill patterns → +20
- Body mentions amount / service period / provider name → +20
- Body is short (forwarded bill, minimal commentary) → +10

**Opt-out signals:**
- Phrases from orchestrator opt-out list → override classification
- LLM sanity check: does message express intent to stop?

**Question signals:**
- Body contains interrogative phrasing
- Mentions billing dispute, property question, ACME service issue
- No attachment

**Classification thresholds:**
- Bill score ≥ 60 → `BILL`
- Opt-out phrase present → `OPT_OUT`
- Question signals + no bill → `QUESTION`
- Bill score 30-59 → `AMBIGUOUS`
- Else → `OTHER`

### Step 4a — Process BILL

#### 4a.1 — Download Attachments
Use `mcp__9150e503...__download_file_content` (or Gmail attachment fetch) for each attachment.

#### 4a.2 — OCR + Parse Each Attachment

For each attachment, run OCR + LLM extraction to pull:
- `amount_due_usd` (required)
- `service_period_start` / `service_period_end` (required — may be inferred from month if explicit range missing)
- `provider_name_raw` → canonicalize via provider map
- `account_number` (optional, but captured)
- `property_address_on_bill` (for cross-check)
- `issue_date` (the bill's print date)

Return per-attachment confidence scores:
- `amount_confidence` (0.0 - 1.0)
- `period_confidence`
- `provider_confidence`

**Confidence gates:**
- `amount_confidence ≥ 0.9` AND `period_confidence ≥ 0.8` → accept auto
- `amount_confidence 0.7–0.9` OR provider canonicalization uncertain → flag `needs_human_verify`
- `amount_confidence < 0.7` → `parse_failed`, do NOT persist amount, send holding ack

#### 4a.3 — Property Matching

Given owner + bill content:
- If owner has 1 property → auto-match.
- If owner has multiple properties → match on `property_address_on_bill` (fuzzy ≥ 85%) OR on `utility_accounts_on_file` account number match.
- If multiple properties + no bill address + no account match → flag `property_ambiguous`, escalate to Owner Success.

#### 4a.4 — Cycle Matching

Given service period + cycle dates:
- Bill's service period must overlap the current or most recent cycle window.
- If bill is from 3+ months ago AND unreimbursed → flag as `historical_late_bill` (still process, but Jocelyn reviews).
- If bill is for a future period (advance pay) → flag `future_period`, hold for clarification.

#### 4a.5 — Persist

Write to `utility_collections_bills`:
```json
{
  "bill_id": "uuid",
  "owner_id": "owner_5521",
  "property_id": "prop_421",
  "region": "socal",
  "cycle_id_matched": "socal-2026-W15",
  "provider_canonical": "sce",
  "provider_raw": "Southern California Edison",
  "account_number": "6004-XXXX-1234",
  "service_period_start": "2026-03-01",
  "service_period_end": "2026-03-31",
  "amount_due_usd": 187.44,
  "amount_confidence": 0.97,
  "issue_date": "2026-04-08",
  "gmail_message_id": "19c...",
  "gmail_thread_id": "thread_xyz",
  "attachment_path": "/drive/utility-bills/2026/04/owner_5521_sce_march.pdf",
  "ingested_at": "2026-04-10T16:25:00Z",
  "status": "ingested",
  "needs_human_verify": false,
  "flags": []
}
```

Also update:
- `utility_collections` cycle row for owner: status → `bill_received`, `bill_received_at`, `bill_amount_extracted_usd`
- Counter: `owner.bills_submitted_total` + 1

#### 4a.6 — Acknowledge

Send formulaic reply:
```
Subject: Re: {original_subject}

Hi {owner_first_name},

Got it — thanks for sending. We've received your {provider_display_name} bill
for {service_period_human}, amount ${amount_due_usd}. We'll apply the
deposit credit on your next owner statement.

— {region_owner_success_name}
  ACME House Company | Owner Success
```

If `needs_human_verify` → use holding ack instead:
```
Subject: Re: {original_subject}

Hi {owner_first_name},

Got it — thanks for sending. We've received your utility bill and are
processing it. Someone from Owner Success will confirm the amount shortly.

— {region_owner_success_name}
```

### Step 4b — Process OPT_OUT

- Update `owners.opt_out_status = true`, `opt_out_date = now`, `opt_out_source = gmail_reply`.
- Cancel any pending drafts for owner this cycle (delete from Gmail drafts if still there).
- Emit `opt_out_received` event to orchestrator → Jocelyn notification.
- Send acknowledgment:
```
Hi {owner_first_name},

Understood — we've removed you from utility bill requests. If this was in
error or you'd like to resume, just reply here any time.

— {region_owner_success_name}
```

### Step 4c — Process QUESTION

- Post to `#team_support_owner_success` Slack thread with subject + snippet + gmail_thread_url + owner context.
- Send holding ack:
```
Hi {owner_first_name},

Got your message — Owner Success will be in touch shortly.

— {region_owner_success_name}
```

### Step 4d — Process AMBIGUOUS

- Flag in `utility_collections` as `ambiguous_reply`.
- Post to Slack thread for human classification.
- Send same holding ack as 4c.

### Step 4e — Process OTHER

- Log, no reply sent (avoid auto-reply loops on OOO etc).

### Step 5 — Emit Events

- `bill_ingested` on success (consumed by dashboard + orchestrator).
- `opt_out_received` on opt-out (consumed by orchestrator).
- `ingestion_flagged_for_human` on ambiguous / low-confidence / property-ambiguous.

---

## 5. Output Schema

```json
{
  "gmail_message_id": "19c...",
  "region": "socal",
  "ingested_at": "2026-04-10T16:25:00Z",
  "classification": "BILL",
  "owner_match": {
    "owner_id": "owner_5521",
    "matched_on": "primary_email"
  },
  "bills_extracted": [
    {
      "bill_id": "uuid-1",
      "provider_canonical": "sce",
      "provider_raw": "Southern California Edison",
      "amount_due_usd": 187.44,
      "amount_confidence": 0.97,
      "service_period": "2026-03-01 to 2026-03-31",
      "period_confidence": 0.95,
      "account_number": "6004-XXXX-1234",
      "property_id": "prop_421",
      "cycle_id_matched": "socal-2026-W15",
      "needs_human_verify": false,
      "flags": []
    }
  ],
  "acknowledgment_sent": {
    "sent_at": "2026-04-10T16:25:18Z",
    "gmail_message_id": "19d...",
    "template": "standard_bill_ack"
  },
  "events_emitted": ["bill_ingested"],
  "status": "success"
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| OCR amount_confidence < 0.7 | Flag, send holding ack, post to Slack for human verify |
| Multiple properties + can't disambiguate | Flag `property_ambiguous`, Slack Owner Success |
| Opt-out detected | Immediate event to orchestrator → Jocelyn |
| Sender email has no owner match | Log as `unknown_sender`, Slack Owner Success (could be new owner, typo, or spam) |
| Bill amount > $1,000 (unusually high) | Process but flag to Jocelyn — may indicate provider billing error or property issue (leak) |
| Bill amount < $10 (unusually low) | Process but flag — may be partial/credit/transfer fee bill |
| Bill service period > 90 days | Flag as `unusual_period` — may be annual reconciliation, manual review |
| Same owner sends 5+ bills in one week | Flag — consolidation opportunity or unusual billing pattern |
| Bill forwarded from a non-owner email (assistant, accountant) | Match by content; if successful, tag sender_is_delegate; acknowledge and cc owner |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| OCR service unavailable | Retry 2x; if persistent, flag `parse_failed`, send holding ack, human verify |
| Gmail attachment download fails | Retry; if fails, send ack asking for resend |
| Multiple attachments, some OCR succeed, some fail | Persist successes, flag failures separately, acknowledge with count of processed |
| Duplicate ingestion (same gmail_message_id) | Return cached result, no duplicate reply |
| Provider name can't be canonicalized | Store raw + flag for canonical-map update |
| Property match fuzzy score 70-85% | Process but flag `property_low_confidence` |

---

## 8. Tools Required

- **Gmail MCP:** `gmail_read_message`, `gmail_read_thread`, draft+send for acknowledgments
- **OCR service:** Textract / Google Document AI / Azure Form Recognizer
- **LLM (Claude):** classification + extraction prompts
- **Google Drive MCP:** attachment archival
- **Slack MCP:** Owner Success notifications for ambiguous / questions
- **Database:** `utility_collections_bills`, `utility_collections`, `owners` (opt-out write)
- **Provider canonical-map:** config-maintained JSON

---

## 9. Handoff Contract

**Upstream:** Gmail push notification or poll safety net detects new message.

**Downstream:**
- `bill_ingested` → dashboard + orchestrator (marks owner `collected` for cycle)
- `opt_out_received` → orchestrator + Jocelyn
- `ingestion_flagged_for_human` → Slack Owner Success
- Bill record in `utility_collections_bills` → consumed by credit-applier at month-end

**Side-effects:**
- Acknowledgment email sent.
- Attachments archived in Drive.
- Slack pings on escalations.

---

## 10. Configuration

```yaml
utility_bill_ingestor:
  ocr_service: textract
  ocr_confidence_thresholds:
    auto_accept: 0.9
    needs_human_verify: 0.7
  provider_canonical_map:
    sce:
      - "southern california edison"
      - "sce"
      - "socal edison"
    coachella_valley_water:
      - "coachella valley water district"
      - "cvwd"
      - "coachella water"
    aps:
      - "arizona public service"
      - "aps"
    srp:
      - "salt river project"
      - "srp"
    # ...extend as encountered
  classification_thresholds:
    bill_min_score: 60
    ambiguous_min_score: 30
  property_fuzzy_match_threshold: 85
  unusual_amount_thresholds_usd:
    high: 1000
    low: 10
  unusual_period_days: 90
  acknowledgment_templates:
    standard_bill_ack: "..."
    holding_ack_needs_verify: "..."
    opt_out_ack: "..."
    question_holding_ack: "..."
  archive_drive_path: "/Chargebacks/../utility-bills/{YYYY}/{MM}/"  # adjust
  sender_delegate_allowed: true
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Clean SCE bill PDF, single attachment, clear amount | Ingested auto, ack sent in <1 min |
| T2 | Owner forwards water + electric in same email, both PDFs | 2 bill records created, 1 ack enumerating both |
| T3 | Scanned photo of paper bill (JPEG, slight glare) | OCR confidence 0.75 → needs_human_verify, holding ack |
| T4 | Owner replies "please take me off this list" | opt_out, ack sent, orchestrator notified, pending drafts cancelled |
| T5 | Owner replies "is this included in management fee?" | Question, Slack to Owner Success, holding ack |
| T6 | OOO auto-reply | OTHER, logged, no reply to avoid loop |
| T7 | Unknown sender (no owner match) | Flagged for Owner Success |
| T8 | Owner's assistant forwards bill from their email | Matched via content, tagged sender_is_delegate, ack CCs owner |
| T9 | Bill for $2,400 (unusually high) | Processed, flagged to Jocelyn for leak-check |
| T10 | Duplicate message (re-trigger) | Cached result, no duplicate record, no duplicate ack |
| T11 | Owner has 3 properties, bill has no address, no account match | property_ambiguous, Slack Owner Success, hold ack |
| T12 | Bill issued 4 months ago (late submission) | Processed, flagged historical_late_bill, Jocelyn review |

---

## 12. Success Metrics

- **Auto-ingestion rate** (no human verify needed): target > 85% of bills.
- **Time from Gmail arrival → ingested**: p50 < 2 min, p95 < 10 min.
- **Acknowledgment latency**: p95 < 5 min (owners perceive speed = professionalism).
- **Property match accuracy**: target > 98% (< 2% mis-routed credits).
- **Opt-out detection recall**: 100% — no missed opt-outs.
- **OCR confidence drift**: monitored monthly; if auto-accept rate drops, retrain or escalate.

---

## 13. Notes for Implementation

- **OCR quality is the bottleneck.** Owners send PDFs, photos, scans, screenshots. Pick an OCR service that handles all four well (Textract + Document AI hybrid works). Budget for it; this is where the time savings live.
- **Provider canonical map is a living asset.** Every new utility provider encountered adds to the map. Month-end credit-applier relies on the canonical names; don't let raw-names leak through.
- **Acknowledgments must feel human but be formulaic.** One template, one tone, same words every time. Owners notice speed more than variety. A fast, formulaic ack reads as "competent system"; a slow, creative ack reads as "variable."
- **Never post an amount you're not sure about.** $187.44 → $18.74 from a bad decimal parse becomes a credit error that Kimberly catches later and an owner trust incident. When uncertain, hold. Human verification is cheap; wrong credits are expensive.
- **Delegation is real.** Many owners have assistants/bookkeepers who forward bills. Recognize + handle gracefully; CC the owner on acknowledgment so the owner sees it too.
- **Opt-outs cascade.** An opt-out here cancels pending drafts + marks opt-out for future cycles. The orchestrator and draft-composer both honor it. Test T4 thoroughly.
- **Bill archival matters for audit.** Every bill goes to Google Drive with a structured path. Month-end credit-applier pulls from there. 7-year retention for accounting compliance.
