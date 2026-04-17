# Utility Draft Composer — Prompt Pack

**Agent:** `utility-draft-composer`
**Phase:** 5 (Utility Bill Manager)
**Parent Orchestrator:** `utility-orchestrator`
**Trigger:** `collection_check_complete` event (Mon 7:20 AM region-local).
**Owner:** Jocelyn → Owner Success.
**SLA:** Complete within 10 minutes. All drafts must be in the regional Gmail drafts folder (or sent, for auto-send-eligible owners) by 7:30 AM local.

---

## 1. Purpose

For every owner the collection-checker flagged `not_collected`, produce a **personalized Gmail draft** that:
- Reflects the owner's actual stay data (property, check-in/check-out dates, guest-night count) — specific enough to prove we're not spam, generic enough to scale
- Matches the brand voice (warm, partnership-oriented, Unreasonable Hospitality)
- Respects the maturity-ladder mode (draft only vs send immediately)
- Is scannable — Owner Success should be able to review & send in < 30 seconds per draft

The draft-composer is the only agent in Phase 5 that writes any outbound owner communication. Every other agent either reads or decides.

---

## 2. System Prompt

```
You are the Utility Draft Composer for ACME House Company. You write
personalized emails asking property owners to submit their utility bills
so we can apply deposit credits.

Audience: property owners — sophisticated, mostly 1-3 property investors,
$500K-$2M asset values, expect professional partnership tone. NOT guests.

Voice rules:
- Warm and partnership-oriented — we're managing their asset, not
  demanding payment.
- Specific — reference their actual stay data (property, dates, nights).
  Generic-feeling emails get ignored or delete-on-sight.
- Concise — aim for ~120 words. Owner Success reviews in seconds.
- Action-clear — one ask, one CTA, easy to comply.
- NEVER apologize for asking. This is standard deposit-credit processing
  and owners know that. Apologetic tone undermines legitimacy.
- NEVER threaten or create urgency that doesn't exist. No "or else."
- Sign off from Owner Success team name (NOT the AI), regional.

Maturity-ladder aware:
- human_all / building_trust → Gmail DRAFT only
- auto_repeat → Gmail SEND (after sanity checks)
- auto_trusted → Gmail SEND (after sanity checks)
- opt_out → skip entirely (should never reach this agent)

Constraints:
- NEVER invent facts. All stay details come from the owner-identifier payload.
- NEVER include dollar amounts we expect — we don't know the utility amount
  until the owner sends it.
- NEVER include bank/payment URLs — this is a bill REQUEST, not a payment
  request.
- RESPECT opt-out list — if owner_id is in the opt_out set, fail loud
  (should have been filtered upstream).
- IDEMPOTENT per (owner_id, cycle_id) — never create duplicate drafts.

Output: array of drafts (created or sent), with Gmail message_id / thread_id
references.
```

---

## 3. Task Prompt Template

```
Compose drafts for region {region}, cycle {cycle_id}.

owners_to_draft: {owners_to_draft_json}
owner_automation_tiers: {map owner_id → tier}
maturity_mode_override: {optional, from orchestrator}

For each owner:
1. Select the right template based on owner history & cycle state
2. Personalize with owner's stay data
3. Create a Gmail draft in the regional inbox
4. If tier allows auto-send AND sanity checks pass → send instead
5. Log draft/send outcome to utility_collections table

Return drafts[] array, skipped[] array, errors[] array.
```

---

## 4. Step-by-Step Workflow

### Step 1 — Template Selection

Pick the appropriate template based on owner's history:

| Template | When |
|---|---|
| `first_time` | Owner's first ever utility outreach |
| `standard_monthly` | Owner has received drafts before, no outstanding issues |
| `gentle_reminder_unreimbursed` | Owner has an unreimbursed bill > 30 days old — reference it |
| `firm_reminder_overdue` | Owner has an unreimbursed bill > 60 days old — firmer tone, still partnership |
| `consolidated_multi_property` | Owner has 2+ properties with obligations this cycle |

All templates share the same structure; language shifts tone only.

### Step 2 — Template Bodies (Base Voice)

#### `standard_monthly` — ~120 words
```
Subject: Utility Bill Request — {property_name_or_count} — {month}

Hi {owner_first_name},

We hope you're doing well. As you know, we pass through guest utility usage
on short-term stays for deposit-credit processing.

For the stays below at {property_name}:
  • {check_in_1} – {check_out_1}  ({nights_1} nights)
  • {check_in_2} – {check_out_2}  ({nights_2} nights)

Could you send us a copy of your {month} utility bill(s)? A PDF, photo, or
forwarded e-bill works — whatever's easiest. Once received we'll apply the
appropriate deposit credit on your next owner statement.

Thanks as always for the partnership.

— {region_owner_success_name}
  ACME House Company | Owner Success
```

#### `first_time` — ~150 words
Same as standard but adds a one-sentence explainer:
> "New to this cycle? Quick context: when guests stay at your property, the utility usage is their responsibility and gets covered from their deposit. We collect your actual utility bills each month to calculate the correct credit for your owner statement."

#### `consolidated_multi_property` — ~140 words
Same as standard but lists properties in an indented bullet structure with a per-property stay summary, single ask:
> "Could you send us your {month} utility bill(s) for each property? A separate forward for each works great."

#### `gentle_reminder_unreimbursed` — ~130 words
Standard body + brief reference:
> "We also want to flag that we haven't yet received your {prior_month} bill — no worries if it's still on your list; we're happy to batch-process both months together when it's convenient."

#### `firm_reminder_overdue` — ~130 words — **requires Jocelyn review before send even in auto modes**
Standard body + firmer reference:
> "Our records show the {prior_month} bill is still outstanding — we want to make sure you receive the full deposit credit you're entitled to, and that requires the bill on hand before we can apply it. Could you send both {prior_month} and {current_month} this week?"

### Step 3 — Personalization Fields

For each template, populate with owner-identifier data:
- `{owner_first_name}` — if missing, use full name; never "Hi there"
- `{property_name}` — short display form from property record
- `{month}` — human-readable, region-local ("March 2026")
- `{region_owner_success_name}` — from config: "SoCal Owner Success Team" / "Arizona Owner Success Team"
- Stay bullets — list all reservations this cycle, check-in to check-out, nights
- For multi-property owners — indent per-property blocks

### Step 4 — Sanity Checks Before Save/Send

Before creating draft or sending:

| Check | Action if Fails |
|---|---|
| Owner email present and valid format | Skip, log error, Owner Success alert |
| Owner is in opt-out list (safety re-check) | Skip, alert orchestrator (should not have reached here) |
| Stay data is empty (edge case) | Skip, log — identifier upstream should have filtered |
| Template personalization produced any `{placeholder}` remnants | Skip, log template error |
| Body length < 50 words | Skip, log template error |
| Body contains "TODO" / "FIXME" / "TBD" | Skip — indicates template bug |
| Same owner already has draft for this cycle in Gmail | Skip (idempotent), return existing draft reference |

### Step 5 — Create Gmail Draft

Tool: `mcp__310bacd1...__gmail_create_draft`

Parameters:
- `from`: regional inbox (owner@casagosocal.com / owner@casagoarizona.com)
- `to`: owner_email_primary
- `cc`: owner_email_alternates if configured to CC
- `subject`: from template
- `body`: personalized template (plain text + HTML variant)
- `thread_id`: if prior related thread exists for this owner, thread into it for continuity

Return draft's Gmail message_id + thread_id.

### Step 6 — Auto-Send Decision (Per Owner)

If `owner_automation_tier ∈ {auto_repeat, auto_trusted}` AND sanity checks all passed AND `maturity_mode_override != 'force_human_review'`:

Additional guards before sending:
- Reservation count for this cycle within 2σ of trailing 12-cycle mean → else revert to draft
- Owner has no outstanding partial_collected from prior cycle → else revert to draft
- Current cycle has no "firm_reminder_overdue" template selected → firm reminders always human-reviewed
- Orchestrator hasn't flagged region-wide `pause_auto_send` for this run

If all pass → send the draft immediately. Otherwise → leave as draft.

### Step 7 — Persist & Emit

For each owner processed:
- Update `utility_collections` row:
  - `draft_created_at` / `draft_sent_at`
  - `gmail_draft_message_id` / `gmail_sent_message_id`
  - `template_used`
  - `auto_sent_flag`
- Log to audit log
- Increment `consecutive_unchanged_template_cycles` if same template as prior cycle (for future maturity promotion)

Emit `drafts_ready` to slack-notifier with counts and example drafts.

---

## 5. Output Schema

```json
{
  "region": "socal",
  "cycle_id": "socal-2026-W16",
  "composed_at": "2026-04-13T14:25:04Z",
  "drafts": [
    {
      "owner_id": "owner_5521",
      "owner_email": "jason.toledo@example.com",
      "template_used": "standard_monthly",
      "gmail_draft_message_id": "19a...",
      "gmail_thread_id": "thread_abc",
      "auto_sent": false,
      "draft_subject": "Utility Bill Request — Coachella Canyon Retreat — March 2026",
      "draft_preview": "Hi Jason, We hope you're doing well...",
      "word_count": 118,
      "personalization_fields_used": ["owner_first_name", "property_name", "stay_bullets", "month"]
    }
  ],
  "auto_sent": [
    {
      "owner_id": "owner_3344",
      "template_used": "standard_monthly",
      "gmail_sent_message_id": "19b...",
      "auto_sent": true,
      "tier": "auto_repeat",
      "reason_sent": "3 consecutive unchanged cycles + within reservation sigma"
    }
  ],
  "skipped": [
    {"owner_id": "owner_9999", "reason": "owner_email_invalid"},
    {"owner_id": "owner_1111", "reason": "existing_draft_found_for_cycle"}
  ],
  "errors": [
    {"owner_id": "owner_2222", "error": "gmail_api_timeout", "will_retry": true}
  ],
  "stats": {
    "total_processed": 13,
    "drafts_created": 10,
    "auto_sent": 2,
    "skipped": 1,
    "errors": 0
  }
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Auto-send would fire but owner had bill dispute last month | Force draft, flag for Jocelyn review |
| Template produces body > 200 words | Truncate, log template-bug alert |
| Multiple owners with same email address (data quality issue) | Group into one draft mentioning all relevant properties; flag Owner Success for data cleanup |
| Owner has > 5 properties in cycle | Create a draft but tag for Jocelyn's eyes — large owners warrant personal handling |
| Region inbox is over quota (can't create drafts) | Halt, alert Jocelyn immediately, don't retry blindly |
| `firm_reminder_overdue` template selected AND owner on auto-send tier | Revert to draft, flag Jocelyn |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Gmail draft creation fails (API error) | Retry 2x with backoff; if final fail, log to errors[], continue other owners |
| Template personalization KeyError (missing field) | Log template-bug alert, skip owner, continue |
| Owner has no valid email | Skip, alert Owner Success for data fix |
| Gmail quota exceeded | Pause batch, alert Jocelyn, resume after quota reset |
| Duplicate draft detected (idempotency) | Return existing reference, do not create new |
| Auto-send sanity check fails | Silently revert to draft mode, log reason |

---

## 8. Tools Required

- **Gmail MCP:** `gmail_create_draft`, `gmail_list_drafts` (idempotency), `gmail_search_messages` (thread_id lookup)
- **Gmail Send:** for auto_sent owners
- **Database:** write to `utility_collections`
- **LLM (Claude):** template personalization
- **Event bus:** emit `drafts_ready`

---

## 9. Handoff Contract

**Upstream:** `collection_check_complete` from collection-checker with `owners_to_draft[]`.

**Downstream:** `drafts_ready` to slack-notifier.

**Side-effects:**
- Gmail drafts/sends in regional inbox.
- `utility_collections` rows updated.
- Audit log entries.

---

## 10. Configuration

```yaml
utility_draft_composer:
  regional_owner_success_names:
    socal: "SoCal Owner Success"
    arizona: "Arizona Owner Success"
  target_word_count:
    standard: 120
    first_time: 150
    consolidated_multi_property: 140
    gentle_reminder_unreimbursed: 130
    firm_reminder_overdue: 130
  max_word_count: 200
  min_word_count: 50
  cc_alternates: false
  thread_continuity: true
  auto_send_guards:
    reservation_count_sigma_threshold: 2.0
    block_on_partial_collected_prior_cycle: true
    block_firm_reminder_template: true
    respect_orchestrator_pause_flag: true
  brand_voice_required:
    - warm
    - specific
    - concise
    - action_clear
    - partnership_oriented
  brand_voice_banned_phrases:
    - "we apologize"
    - "sorry to bother"
    - "act now"
    - "immediately required"
    - "failure to"
    - "or else"
  personalization_required_fields:
    - owner_first_name
    - property_name
    - month
    - stay_bullets
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Standard owner, cycle 4 on auto_repeat tier | Draft auto-sent, logged as auto_sent |
| T2 | First-time owner | `first_time` template used, human_all tier, draft only |
| T3 | Owner with 3 properties | `consolidated_multi_property` template, single draft with all 3 |
| T4 | Owner with 60-day-old unreimbursed bill | `firm_reminder_overdue` template, forced to draft even if auto tier |
| T5 | Owner email invalid | Skipped, error logged, Owner Success alerted |
| T6 | Duplicate Monday run same cycle | Existing drafts detected, no new drafts created |
| T7 | Reservation count 5× typical (outlier) | Auto-send reverted to draft with reason logged |
| T8 | Gmail quota exceeded mid-batch | Halt, alert, partial drafts persisted, resumable on retry |
| T9 | Template produces `{property_name}` remnant (bug) | Skip + log template-bug alert |
| T10 | Owner on auto_trusted, normal cycle | Auto-sent without incident |
| T11 | Owner has 2 emails, primary bounces silently on prior cycle | Draft goes to alternates if configured; else flag Owner Success |

---

## 12. Success Metrics

- **Owner Success review time per draft** — target < 30 seconds (i.e., draft feels ready-to-send).
- **Auto-send penetration by month 6** — target ≥ 40% of eligible owners.
- **Template edit rate by Owner Success** — target < 20% of drafts edited before send. Edits captured and analyzed monthly.
- **Draft creation success rate** — > 98%.
- **Word-count compliance** — 100% drafts within 50-200 range.

---

## 13. Notes for Implementation

- **The 120-word target is load-bearing.** Owners skim. Long drafts lose.
- **Specificity is the secret.** "Your stay 3/14-3/17, 3 nights" beats "your recent reservations." The owner-identifier payload has the data; use all of it.
- **Never let auto-send outrun trust.** The maturity ladder is conservative by design. One bad auto-send (e.g., contacting an owner after an opt-out) destroys months of earned autonomy.
- **Firm reminders stay human-reviewed indefinitely.** Overdue situations need human judgment — maybe there's context we don't have (property sold, owner death, dispute).
- **Feedback loop:** capture Owner Success's edit diffs each week. Feed to the composer's template tuning — if the team rewrites "partnership" to "working together" every time, the template should update.
- **Brand voice validates against guest-voice content too.** Even though this is an owner audience, the "partnership + specific + no-apology" framing maps cleanly to ACME's Unreasonable Hospitality principle applied to owners.
