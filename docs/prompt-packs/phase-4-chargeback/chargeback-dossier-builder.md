# Chargeback Dossier Builder — Prompt Pack

**Agent:** `chargeback-dossier-builder`
**Phase:** 4 (Chargeback Manager)
**Parent Orchestrator:** `chargeback-orchestrator`
**Trigger:** Event from `chargeback-reservation-matcher` after a match at confidence ≥ 75 is confirmed (auto-match ≥ 95 OR human-confirmed probable match).
**Owner:** Audrey (Support / Guest Services). Escalation: Jocelyn (Director of Support).
**SLA:** Dossier assembled within **3 business days** of case intake. Hard deadline: **5 business days**. Must complete at least **48 hours before** the processor's hard response deadline.

---

## 1. Purpose

Given a canonical chargeback case record (from inbox-monitor) plus a confirmed Streamline reservation match (from reservation-matcher), this agent autonomously assembles a **single, submission-ready evidence dossier** by pulling from nine upstream systems, orders evidence with the reason-code-specific lead page first, uploads the packaged PDF to Google Drive, logs gaps in Asana, and hands off to the narrative-drafter.

**Design principle from Audrey's SOP:**
> *"Silence on our side guarantees a loss."*

Never skip. Never submit nothing. When evidence is missing, log the gap, submit what we have, and feed the miss into the monthly trend review so we know where to invest (lock log access, ID capture consistency, inspection photo discipline, etc.).

**Second principle — Judy Crane voice:**
> *Factual, chronological, unemotional.*

Evidence is presented in time order. Every exhibit has a caption stating what it is and what it proves. No editorializing — the narrative-drafter adds voice; the dossier-builder presents facts.

---

## 2. System Prompt

```
You are the Chargeback Dossier Builder for ACME House Company, a vacation rental
management company operating across Arizona and California under Casago.

Your job: Given a matched chargeback case, autonomously assemble a single,
submission-ready PDF evidence dossier by pulling from Streamline, Akia,
rental guardian, Superhog, Autohost, Stripe, Lynnbrook, the channel platform
(Airbnb/VRBO), and Google Drive (smart lock logs while API access is manual).

You operate against a SOP owned by Audrey. The company target is to match
Judy Crane's win rate: 2 losses in 5 years. Every dossier you build is either
defending revenue or telling us where our operational evidence has gaps.

Your constraints:
- LEAD with reason-code-specific evidence. The first 2–3 pages of the dossier
  must directly rebut the dispute reason. Everything else supports.
- INCLUDE every item on the Standard Evidence Checklist that you can obtain.
  When an item is not available, do NOT skip silently — log it as a gap.
- ORDER evidence chronologically within each section.
- LABEL every exhibit with (a) Exhibit letter, (b) source system, (c) what it proves,
  (d) date/timestamp of the underlying event. The narrative-drafter will cite these.
- NEVER fabricate, edit, or crop evidence to favor our case. Redact only PII that
  is not relevant (e.g., bystander names on a shared lock log) and note all redactions.
- NEVER submit evidence from a different reservation. If you encounter any ambiguity
  while pulling (wrong dates, wrong property, wrong guest name on an exhibit), STOP
  and escalate back to the reservation-matcher.
- IDEMPOTENT: dossier_key = sha256("{dispute_id}-{reservation_id}"). Re-runs must
  not duplicate Drive uploads or Asana attachments.
- Never guess at data you cannot retrieve. Log every retrieval as success / partial /
  failed with a reason.

Your output is a Dossier Manifest JSON plus a single assembled PDF saved to
Google Drive at /Chargebacks/{YYYY}/{Processor}-{GuestLastName}-{DisputeID}/.
```

---

## 3. Task Prompt Template

```
CHARGEBACK CASE TO BUILD DOSSIER FOR:

Case record:
{case_record_json}

Reservation match (confirmed):
{reservation_match_json}

Reason code (normalized): {reason_code}
Processor: {processor}
Processor deadline: {processor_deadline_iso}
Internal deadline: {internal_deadline_iso}  # 48h earlier

Your task:
1. Fetch evidence from all nine upstream systems (see Step-by-Step §4).
2. Validate every exhibit belongs to THIS reservation (guest name, stay dates,
   property). Any mismatch → STOP + escalate.
3. Order evidence: reason-code lead pages → supporting timeline → reference data.
4. Assemble a single PDF. Each section starts with a cover page naming the
   Exhibit letters it contains and what they prove.
5. Upload to Google Drive. Attach to Asana task. Log gaps to the Asana
   "Evidence Gaps" custom field.
6. Return the Dossier Manifest so the narrative-drafter can cite exhibits.

Do not draft narrative text. That is the narrative-drafter's job.
```

---

## 4. Step-by-Step Workflow

### Step 1 — Load Case Context & Initialize Manifest

- Load `case_record` from the chargeback case store.
- Load `reservation_match` (Streamline reservation_id, property_id, stay_dates, owner_id, channel).
- Compute `dossier_key = sha256("{dispute_id}-{reservation_id}")`.
- Check idempotency: does a Google Drive folder already exist at the target path?
  - If yes and manifest is complete → return cached manifest (no work).
  - If partial → resume where prior run left off (track per-source success flags).
- Initialize manifest: `{case, match, exhibits: [], gaps: [], retrieval_log: []}`.

### Step 2 — Parallel Evidence Retrieval

Dispatch all retrievals concurrently. Each returns `{status: success|partial|failed, source, artifact_path?, reason?}`. The orchestrator waits for all to settle before ordering.

#### 2a. Streamline — Reservation + Folio
- Tool: `mcp__182489f5...__get_reservation_info`
- Pull: confirmation, full folio (line items), payment records, cancellation status, any refunds.
- Export folio as PDF.
- Exhibit label: `A — Reservation Folio (Streamline)`

#### 2b. Streamline / DocuSign / Rental Guardian — Signed Rental Agreement
- Primary: Streamline reservation → Documents tab.
- Fallback: rental guardian screening record.
- Capture: signature timestamp, IP address, audit trail.
- If agreement is missing → gap: `no_signed_rental_agreement`.
- Exhibit: `B — Signed Rental Agreement with Timestamp + IP`

#### 2c. Rental Guardian / Superhog / Autohost — Guest ID on File
- Pull: government-issued ID image, AVS match result, screening risk score, selfie match if available.
- Critical for Fraud / Card Not Present reason codes.
- If ID is missing and reason = fraud → gap: `no_guest_id_on_file` (HIGH severity, tag Jocelyn).
- Exhibit: `C — Guest Identity Verification`

#### 2d. Channel Platform — Booking Confirmation + Cancellation Policy
- Airbnb: Resolution Center + reservation detail page.
- VRBO: Traveler reservation detail.
- Direct: Streamline booking screen.
- Capture: booking confirmation screen, the cancellation policy the guest accepted at booking time (dated).
- If unavailable via API → flag for human screenshot capture (do NOT block dossier).
- Exhibit: `D — Channel Booking Confirmation + Accepted Policy`

#### 2e. Akia — Full Conversation Thread
- Tool: Akia API (guest profile → thread export as PDF).
- Capture: pre-arrival, in-stay, post-stay messages with timestamps.
- For Not As Described disputes: highlight absence of complaints, positive messages.
- For Service Not Rendered: highlight in-stay messages sent from the property.
- If thread is empty → gap: `no_akia_thread` (moderate severity).
- Exhibit: `E — Full Guest Communication Thread (Akia)`

#### 2f. Smart Lock Access Logs — PointCentral / Good Neighbor Tech
- **CURRENT STATE: MANUAL.** PointCentral + Good Neighbor Tech do not have API access scoped yet.
- Create an Asana sub-task: "Pull lock logs for {property} stay dates {check_in} to {check_out}"
  - Assigned to: Audrey
  - Due: 24h before internal deadline
  - Instructions embedded: which portal, what to screenshot, where to upload
- Mark this exhibit as `status: pending_human`.
- When human uploads to Drive → resume and ingest.
- Critical for Service Not Rendered + Fraud / CNP. If missing after human follow-up → gap: `no_lock_logs` (CRITICAL severity — flag for monthly trend review).
- Exhibit: `F — Smart Lock Access Logs for Stay Dates`

#### 2g. Streamline Work Orders — Inspection + Housekeeping Photos
- Pull all work orders tied to the reservation (pre-arrival inspection, housekeeping completion, any mid-stay orders).
- Download attached media.
- For Not As Described: pre-arrival photos are the primary rebuttal.
- If no photos → gap: `no_inspection_photos` (moderate severity, trend indicator).
- Exhibit: `G — Pre-Arrival Inspection + Housekeeping Photos`

#### 2h. Stripe / Lynnbrook — Payment + Payout Record
- Tool: processor API (transaction detail page → export receipt).
- Capture: full transaction ID, authorization timestamp, AVS/CVV match codes, IP address at booking, device fingerprint if available, payout record, any refunds issued.
- For Fraud / CNP: AVS match + IP + device fingerprint are lead evidence.
- For Duplicate Charge: full folio + single transaction record is lead evidence.
- Exhibit: `H — Payment + Payout Record with Authentication Data`

#### 2i. Streamline / Email Archive — Resolution Agreement (if any)
- Search Streamline guest file and Gmail archive for any resolution agreement, refund, credit, or channel-level settlement offer.
- If any exists → pull it (this directly rebuts most "service" disputes because it shows we already addressed the issue).
- If none → note explicitly (NOT a gap — absence may be the point).
- Exhibit: `I — Resolution Agreement / Prior Refund (if applicable)`

#### 2j. Supplementary — Property Activity Signals (when available)
- Thermostat activity (if integrated), Wi-Fi connection logs (if available), pool/hot-tub heater activity.
- Strong supporting evidence for Service Not Rendered.
- Best-effort — do not block.
- Exhibit: `J — In-Stay Property Activity Signals`

### Step 3 — Exhibit Validation Pass

Before assembling, validate every exhibit:

| Check | Action if Fails |
|---|---|
| Guest name on exhibit matches reservation guest | STOP + escalate to matcher (possible wrong reservation) |
| Dates on exhibit fall within stay window | Flag in manifest, do not auto-fail (e.g., pre-arrival photos predate check-in by design) |
| Property on exhibit matches reservation property | STOP + escalate |
| Amounts on folio match disputed amount (or explain delta) | Note delta in manifest; folio total may differ from disputed amount if partial dispute |

Any STOP condition → do not upload partial dossier. Escalate to `chargeback-case-tracker` with `status: dossier_blocked_validation_failure`.

### Step 4 — Order the Dossier (Reason-Code-Driven)

Apply the SOP's lead-with table. The first section of the dossier is the reason-code rebuttal section; subsequent sections are supporting.

| Reason Code | Lead Section (Order) | Supporting Sections |
|---|---|---|
| `fraud` / Card Not Present | C (ID) → H (payment auth/AVS/IP/device) → F (lock logs) → E (Akia) | A, B, D, G, I, J |
| `service_not_rendered` | F (lock logs) → J (activity signals) → E (Akia in-stay) → G (inspection photos) | A, B, C, D, H, I |
| `not_as_described` | G (inspection photos) → E (Akia — no complaints) → D (listing as-booked) → reviews if positive | A, B, C, F, H, I, J |
| `duplicate_charge` | A (folio) → H (single transaction + payout) → I (no prior refund) | B, C, D, E, F, G, J |
| `cancellation_refund` | D (cancellation policy accepted) → I (resolution/refund history) → E (dated guest request) → A (folio) | B, C, F, G, H, J |
| `other` / unknown | A → B → D → E → H (standard order) | C, F, G, I, J |

Each section begins with a **section cover page**:
- Section title (e.g., "Section 1 — Direct Rebuttal: Fraud / Card Not Present")
- Bullet list of exhibits in this section with one-sentence captions
- The captions are factual, not argumentative — e.g., "Exhibit F: Smart lock code entry at 3/14 4:02 PM confirms physical entry by the cardholder."

### Step 5 — Assemble Single PDF

- Render section cover pages + exhibits in order.
- Add a front cover:
  - Case ID, processor, dispute ID, cardholder name, disputed amount
  - Reservation ID, property, stay dates, channel
  - Table of Contents listing every exhibit
- Add a back cover:
  - Submission timestamp placeholder (filled at submit time by submitter)
  - Authorized submitter: Audrey (or Jocelyn for > $2,500)
- Target file: `{Processor}-{GuestLastName}-{DisputeID}-Dossier.pdf`
- File size cap per processor:
  - Stripe: 4.5 MB per file, up to ~20 files
  - Lynnbrook: varies — keep under 10 MB single PDF
- If exceeds cap → split into main PDF + supporting attachments (photos, logs) as separate files, keep the main PDF under 4 MB.

### Step 6 — Upload to Google Drive

- Path: `/Chargebacks/{YYYY}/{Processor}-{GuestLastName}-{DisputeID}/`
- Files:
  - `Dossier.pdf` (the main packaged PDF)
  - `/exhibits/` subfolder with raw source files (original PDFs, images, screenshots)
  - `manifest.json` (the Dossier Manifest)
- Permissions: Audrey + Jocelyn + Jason (read/write); accounting@acmehouseco.com (read).

### Step 7 — Update Asana + Log Gaps

- Attach `Dossier.pdf` + Drive folder link to the Asana chargeback task.
- Populate "Evidence Gaps" multi-select field from the manifest `gaps[]` list using the canonical values:
  `no_lock_logs` | `no_id_on_file` | `no_inspection_photos` | `no_akia_thread` | `no_resolution_agreement` | `no_signed_rental_agreement` | `other`
- Move task status: `Building Dossier` → `Ready for Narrative`.
- If CRITICAL severity gap (e.g., `no_lock_logs` on a Service Not Rendered case): tag Jocelyn in a comment.

### Step 8 — Emit Handoff Event

Emit to the orchestrator with the Dossier Manifest (see §5). The orchestrator hands off to `chargeback-narrative-drafter`.

---

## 5. Dossier Manifest Schema

```json
{
  "dossier_key": "sha256_hash",
  "case_id": "CB-2026-0142",
  "dispute_id": "dp_1NxYzABCDEF",
  "processor": "lynnbrook",
  "reason_code": "service_not_rendered",
  "reservation_id": "SL-887341",
  "property": {
    "id": "prop_421",
    "name": "Coachella Canyon Retreat",
    "market": "Coachella Valley"
  },
  "guest": {
    "name": "Jason Toledo",
    "email_redacted": "j***@example.com",
    "card_last4": "3008"
  },
  "stay_dates": {"check_in": "2026-03-14", "check_out": "2026-03-17"},
  "channel": "direct",
  "disputed_amount": 3679.00,
  "drive_folder": "https://drive.google.com/drive/folders/...",
  "dossier_pdf": "https://drive.google.com/file/d/.../view",
  "exhibits": [
    {
      "letter": "A",
      "title": "Reservation Folio",
      "source": "streamline",
      "file_path": "/exhibits/A_folio.pdf",
      "pages_in_dossier": [4, 5, 6],
      "proves": "Reservation total $3,679 matches disputed amount; no refunds issued.",
      "timestamp": "2026-02-10T14:22:00Z",
      "validation": {"guest_match": true, "dates_match": true, "property_match": true, "amount_match": true}
    },
    {
      "letter": "F",
      "title": "Smart Lock Access Logs",
      "source": "pointcentral_manual",
      "file_path": "/exhibits/F_lock_logs.pdf",
      "pages_in_dossier": [1, 2],
      "proves": "Guest-assigned code entered property 14 times between 3/14 4:02 PM and 3/17 10:43 AM.",
      "timestamp_range": {"start": "2026-03-14T16:02:00Z", "end": "2026-03-17T10:43:00Z"},
      "validation": {"guest_match": true, "dates_match": true, "property_match": true, "amount_match": null}
    }
  ],
  "section_order": ["rebuttal_service_not_rendered", "communication_timeline", "booking_records", "payment_records"],
  "gaps": [
    {
      "code": "no_id_on_file",
      "severity": "moderate",
      "note": "Guest booked direct pre-screening rollout; no Superhog record."
    }
  ],
  "retrieval_log": [
    {"source": "streamline", "status": "success", "duration_ms": 1420},
    {"source": "akia", "status": "success", "duration_ms": 2100},
    {"source": "pointcentral", "status": "pending_human", "asana_subtask": "..."},
    {"source": "rental_guardian", "status": "partial", "reason": "ID captured but selfie match missing"}
  ],
  "validation_status": "passed",
  "pdf_size_bytes": 3842156,
  "assembled_at": "2026-04-15T17:30:00Z",
  "assembled_by_agent": "chargeback-dossier-builder",
  "next_handoff": "chargeback-narrative-drafter"
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Any exhibit fails `guest_match` or `property_match` validation | STOP. Do not upload. Emit `dossier_blocked_validation_failure` to case-tracker. Escalate to reservation-matcher + Jocelyn. |
| CRITICAL gap on lead-section evidence (e.g., `no_lock_logs` on Service Not Rendered) | Tag Jocelyn in Asana. Proceed with dossier (do not silently skip) but flag for executive review before submission. |
| Disputed amount > $2,500 | Tag @Jocelyn on completion — she reviews before submission per SOP §3. |
| Disputed amount > $10,000 | Tag @Jason on completion. |
| Reservation predates Vacasa acquisition | Tag Accounting — payout status may differ. |
| Processor hard deadline < 72h away when case arrives | Flag `expedited: true` in manifest. Narrative-drafter must parallelize. |
| PDF exceeds processor size cap even after splitting | Escalate to Audrey with recommendation on what to drop (always drop supplementary J first, never lead evidence). |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Streamline API unavailable | Retry 3x with backoff. On failure, log retrieval as `failed`, continue with other sources, flag for human folio pull. |
| Akia thread export returns empty | Verify via direct API: does guest profile exist? If yes but no messages, record as legitimate empty thread (some guests never message); if no profile, log as integration error. |
| Rental Guardian record exists but ID image corrupt | Log partial; request Audrey re-pull. |
| PointCentral / Good Neighbor Tech sub-task unassigned > 24h | Auto-escalate to Jocelyn. |
| Google Drive upload fails | Retry 3x. On failure, store PDF in staging S3 and alert Audrey. Do NOT emit handoff until upload succeeds. |
| PDF assembly fails (corrupt source file) | Isolate the corrupt exhibit, assemble without it, log as retrieval failure with source. |
| Idempotency collision (re-run sees existing complete manifest) | Return cached manifest. Do not re-upload. |

---

## 8. Tools Required

- **Streamline MCP** — `get_reservation_info`, `get_work_orders`, `get_property_info`
- **Akia API** — thread export (PDF)
- **Rental Guardian / Superhog / Autohost** — screening record fetch
- **Stripe API** — `disputes.retrieve`, `charges.retrieve`, transaction detail
- **Lynnbrook API / portal scraper** — dispute + transaction detail
- **Channel APIs** — Airbnb Resolution Center, VRBO traveler reservation detail
- **Google Drive MCP** — `create_file`, folder creation, permissions management
- **Asana MCP** — `get_task`, `update_tasks`, `add_comment`, `create_tasks` (for manual lock log sub-task)
- **Gmail MCP** — `gmail_search_messages` (for resolution agreement email archive)
- **PDF library** — assembly, stamping, page numbering, redaction
- **Hashing** — SHA-256 for idempotency

---

## 9. Handoff Contract

**Upstream (from reservation-matcher):**
- Confirmed `reservation_match` with confidence ≥ 75 and human confirmation if 75–95.

**Downstream (to narrative-drafter):**
- Dossier Manifest JSON (§5).
- Path to assembled PDF + raw exhibits folder in Google Drive.
- Exhibit letters map (so narrative can cite "See Exhibit F — lock access logs showing code entry on 3/14 at 4:02 PM").
- `section_order` array — narrative structure mirrors dossier structure.

**Side-effects:**
- Google Drive folder created with PDF + exhibits + manifest.
- Asana task updated: status = `Ready for Narrative`, evidence gaps logged, escalation tags applied.
- Case Tracker notified of state transition.

---

## 10. Configuration

```yaml
chargeback_dossier_builder:
  drive_root: /Chargebacks
  folder_template: "{processor}-{guest_last_name}-{dispute_id}"
  pdf_filename_template: "{processor}-{guest_last_name}-{dispute_id}-Dossier.pdf"
  max_pdf_size_mb:
    stripe: 4.5
    lynnbrook: 10.0
  retrieval_timeout_seconds: 30
  retrieval_max_retries: 3
  parallel_retrievals: true
  critical_gap_codes:
    - no_lock_logs          # on service_not_rendered, fraud
    - no_id_on_file         # on fraud, card_not_present
    - no_signed_rental_agreement  # on any
  manual_source_sla_hours: 24  # how long to wait for PointCentral sub-task
  escalation_thresholds:
    jocelyn_review_usd: 2500
    jason_review_usd: 10000
  judy_voice_rules:
    - factual
    - chronological
    - unemotional
    - never_apologize
    - never_speculate
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Clean service_not_rendered case, all sources return, lock logs present | Dossier PDF assembled in < 10 min, F/J/E/G lead section, no gaps. |
| T2 | Fraud case, no ID on file (pre-Superhog booking) | Manifest includes `no_id_on_file` (high severity), proceeds, tags Jocelyn. |
| T3 | Not as described, Akia thread shows 3 positive in-stay messages | Akia section includes message quotes with timestamps in cover captions. |
| T4 | PointCentral lock logs require manual pull | Asana sub-task created, status `pending_human`, orchestrator pauses handoff until resolved. |
| T5 | Guest name on fetched Akia thread is "Jason Tolodeo" but reservation says "Jason Toledo" | Fuzzy match ≥ 95 → passes validation. If < 95 → STOP + escalate. |
| T6 | Property on a work-order photo is "Coachella Canyon" but reservation property is "Coachella Canyon Retreat" (same, different short name) | Confirm via property_id match, not name match. If property_id differs → STOP. |
| T7 | PDF exceeds 4.5 MB for Stripe submission | Split: lead sections in main PDF, supplementary photos as attachments. |
| T8 | Re-run (idempotent) | Return cached manifest, zero new Drive uploads. |
| T9 | Disputed amount $8,200, cancellation_refund reason | Tags Jocelyn, leads with D + I + E. |
| T10 | All nine sources fail simultaneously (outage) | Dossier not assembled, emits `dossier_blocked_total_failure`, pages Audrey. |
| T11 | Reservation was refunded in full two weeks before chargeback (should never have gone to dispute) | Manifest flags `prior_full_refund: true`, narrative-drafter will lead with that — likely processor error. |
| T12 | Long-term stay (≥ 29 nights) under Lynnbrook | Dossier notes LT trust account; lock logs span 30+ entries (expected). |

---

## 12. Success Metrics

- **Dossier completion time:** median < 6 hours from match confirmation, p95 < 2 business days.
- **Evidence completeness rate:** % of cases where all nine source categories return something (not gap) — target 80% → 95% as integrations mature.
- **Validation pass rate:** % of dossiers where all exhibits pass guest/property/date validation first try — target 98%.
- **Gap concentration:** top 3 gap codes reported monthly drive the next operational investment (e.g., if `no_lock_logs` is #1 three months running → prioritize PointCentral API integration).
- **Downstream signal:** % of won cases where the dossier was rated "complete" by Audrey in the outcome log — target > 90%.

---

## 13. Notes for Implementation

- **PointCentral + Good Neighbor Tech are the single biggest automation gap.** Until API access is scoped, every Service Not Rendered and Fraud case requires a human sub-task. Track the count of these sub-tasks as a KPI — it quantifies the business case for lock vendor integration investment.
- **The validation pass is non-negotiable.** Judy's rule: "Never submit evidence for the wrong reservation." One wrong-reservation submission can lose a case outright and damage processor trust.
- **Judy's voice applies to exhibit captions too.** "Guest entered property at 4:02 PM" — not "Guest clearly entered and enjoyed the property at 4:02 PM."
- **Redaction rules:** Only redact PII of non-parties (other guests in group chats, bystanders in photos). Never redact the cardholder's own information — that's the whole point of the evidence.
- **The narrative-drafter is the next stop — do not write prose here.** This agent produces a fact pack. Prose is Step 4 of the SOP.
