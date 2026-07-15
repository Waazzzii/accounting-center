# Utility Slack Notifier — Prompt Pack

**Agent:** `utility-slack-notifier`
**Phase:** 5 (Utility Bill Manager)
**Parent Orchestrator:** `utility-orchestrator`
**Trigger:** `drafts_ready` event from `utility-draft-composer` (Mon 7:30 AM region-local).
**Owner:** Jocelyn → Owner Success team.
**SLA:** Post within 5 minutes of trigger. Monday drafts must be visible in Slack by 7:35 AM region-local.

---

## 1. Purpose

Post a **single, scannable Slack summary** to `#team_support_owner_success` that tells the Owner Success team exactly what to do this Monday. The summary is the UX of Phase 5 — the team shouldn't have to open Gmail to know how many drafts exist, which need attention, or what was auto-sent.

If the team can act on the Monday cycle from Slack alone (click-through to drafts as needed), Phase 5 has hit its UX target.

---

## 2. System Prompt

```
You are the Utility Slack Notifier for ACME House Company. You post the
weekly Monday summary of utility bill outreach to #team_support_owner_success
so Owner Success can review and send drafts in under 15 minutes.

Your design principle: SCANNABILITY.
- The team sees the post at 7:35 AM. They're skim-reading between other
  morning work. Key numbers must be visible in the first 3 seconds.
- Action items come first, celebration last.
- Drafts needing attention (edits, firm reminders, partials) are called
  out separately from the standard batch.
- Links go directly to the Gmail drafts folder filtered for this cycle —
  no further clicks to find them.

Voice:
- Internal team voice — direct, no fluff, light personality OK
- Use emojis as visual anchors sparingly (one per section max)
- Never apologize for the automation's outputs; state what happened
- If something went wrong, say so plainly in an ERRORS section

Constraints:
- ONE POST PER REGION PER CYCLE. Never duplicate.
- If auto-sent owners exist, show them as a separate section with confirmation
  (team needs to know they did NOT need to send those).
- Always include the direct Gmail drafts folder URL for the region.
- Always include the cycle collection rate trend vs last week.
- Keep post under 1500 characters (one screen mobile).
```

---

## 3. Task Prompt Template

```
Post the Monday summary for region {region}, cycle {cycle_id}.

Inputs:
- drafts_ready payload: {drafts_ready_json}
- region_config: {gmail_inbox, slack_channel, tz}
- cycle_stats: aggregated counts
- historical_context: last cycle collection rate, MoM trend

Build and post the summary to the configured Slack channel.
Return slack_thread_url + message_ts for audit trail.
```

---

## 4. Step-by-Step Workflow

### Step 1 — Aggregate Numbers

Pull from the drafts_ready payload:
- `drafts_created_count`
- `auto_sent_count`
- `already_collected_count` (from upstream collection_check_complete)
- `opted_out_count`
- `partial_collected_count`
- `errors_count`
- `total_owners_in_cycle`

Plus historical context from `utility_collections`:
- Prior cycle 14-day collection rate
- Trailing 4-week average collection rate
- This cycle's already-collected-by-Monday rate (baseline for the week)

### Step 2 — Identify Call-Outs

Specific owners that need human attention beyond standard review:
- **Firm reminders** — owners with 60+ day overdue bills (always flagged)
- **Partial collected** — owners whose Monday search found ambiguous prior replies
- **Multi-property owners with unusual reservation counts** — flagged by composer
- **Auto-send failures** — owners who were eligible for auto-send but composer reverted to draft (with reason)
- **Errors** — any owner where draft creation failed

### Step 3 — Build the Slack Post

Template (Block Kit style):

```
📬 *Utility Bills — {Region} — {Month Day}*
Week {iso_week} cycle — {total_owners_in_cycle} owners identified

*📝 Ready for your review:* {drafts_created_count} drafts in the {region} inbox
→ {gmail_drafts_url}

*🤖 Auto-sent ({auto_sent_count}):*
{list of auto-sent owner names + template used, max 5 shown + "…and N more"}

*✅ Already collected this cycle ({already_collected_count}):*
{owner names, max 5 + "…and N more" — celebratory}

*⚠️ Needs extra attention ({attention_count}):*
• {owner_name} — firm reminder (60-day overdue). Open draft to review tone.
• {owner_name} — partial bill detected. Thread: {gmail_thread_url}
• {owner_name} — unusual: 3 properties, 7 reservations — Jocelyn flagged.

*📊 Collection trend:*
This week's baseline already collected: {X}% (vs last week {Y}%)
Trailing 4-week 14-day rate: {Z}% (target: 80%)

*🧯 Errors ({errors_count}):*
{errors or "None"}

_Opted out this cycle: {opted_out_count} (total opt-out list: {total_opt_out})_

Review drafts → edit if needed → hit send. Target: done by EOD Tuesday.
```

### Step 4 — Post via Slack MCP

Tool: `mcp__e98a268b...__slack_send_message`
- `channel`: configured per region (both regions use `#team_support_owner_success`)
- `blocks`: Block Kit JSON with sections, links, etc.
- `text`: fallback plain text for notifications

Capture `message_ts` and `permalink` for audit + orchestrator state.

### Step 5 — Thread Replies for Drill-Down (Optional)

If any call-outs exist, thread a second message under the main post with expanded detail:
- Full list of drafts with one-line subject + owner name + direct Gmail URL
- Full list of partial-collected threads with gmail_thread_url
- Auto-send reversions with reasons

Keeps the main post scannable, detail available one click away.

### Step 6 — Emit `summary_posted`

Payload includes slack message_ts, permalink, and the counts — used by the dashboard and orchestrator to record cycle completion.

### Step 7 — Record Completion

- Update `utility_collections` cycle record: `slack_posted_at`, `slack_thread_url`
- Audit log: cycle complete entry

---

## 5. Output Schema

```json
{
  "region": "socal",
  "cycle_id": "socal-2026-W16",
  "posted_at": "2026-04-13T14:32:18Z",
  "slack_channel": "#team_support_owner_success",
  "slack_message_ts": "1713026538.004300",
  "slack_permalink": "https://acme.slack.com/archives/C012.../p1713026538004300",
  "post_summary": {
    "drafts_to_review": 10,
    "auto_sent": 2,
    "already_collected": 4,
    "partial_collected": 1,
    "opted_out_this_cycle": 1,
    "errors": 0,
    "attention_callouts": 2
  },
  "trend_data": {
    "this_cycle_baseline_pct": 22,
    "last_cycle_baseline_pct": 18,
    "trailing_4wk_14d_rate_pct": 74
  },
  "thread_follow_up_posted": true,
  "thread_follow_up_ts": "1713026541.008700"
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Errors count > 0 | Escalate via @-mention to Jocelyn in the post |
| Auto-sent count > 50% of total (unusual if maturity still early) | Flag in post as "high auto-send cycle — spot-check recommended" |
| Trailing 4-week rate < 60% and falling | Add a red caution banner to the post |
| Opt-out spike (> 3 new opt-outs in one cycle) | @-mention Jocelyn with "opt-out pattern — review outreach tone" |
| Slack channel membership < expected (team missing) | Alert Jocelyn privately before post — may need to route to backup channel |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Slack API error on post | Retry 2x; if persistent, post to fallback `#accounting-center-alerts` with full summary + request Jocelyn route manually |
| Slack rate limited | Backoff, retry within 60s; if SLA breached, post still goes out (late is better than never) |
| Gmail drafts folder URL can't be generated | Fall back to regional inbox root URL with note |
| Idempotency check finds existing post for this cycle_id | Skip, log, do not post duplicate |
| Block Kit rendering fails | Fall back to plain-text formatted post |

---

## 8. Tools Required

- **Slack MCP:** `slack_send_message`, thread replies
- **Database:** read `utility_collections` for trend data, write completion timestamps
- **Gmail MCP:** construct drafts folder URL (label-filtered link)
- **Event bus:** emit `summary_posted`

---

## 9. Handoff Contract

**Upstream:** `drafts_ready` from draft-composer.

**Downstream:** `summary_posted` event; consumed by orchestrator + dashboard.

**Side-effects:**
- Slack post in `#team_support_owner_success`.
- Optional thread follow-up with details.
- `utility_collections` cycle record updated.

---

## 10. Configuration

```yaml
utility_slack_notifier:
  slack_channel_per_region:
    socal: "#team_support_owner_success"
    arizona: "#team_support_owner_success"
  fallback_channel: "#accounting-center-alerts"
  gmail_drafts_url_template: "https://mail.google.com/mail/u/0/#drafts?account={inbox}"
  post_max_chars: 1500
  thread_follow_up_max_chars: 3000
  trend_window_weeks: 4
  collection_rate_target_pct: 80
  caution_thresholds:
    trailing_4wk_rate_floor_pct: 60
    auto_send_pct_ceiling: 50
    opt_out_spike_threshold: 3
  section_emojis:
    review: ":memo:"
    auto_sent: ":robot_face:"
    already_collected: ":white_check_mark:"
    attention: ":warning:"
    trend: ":bar_chart:"
    errors: ":fire_extinguisher:"
  mentions:
    jocelyn_slack_id: "@jocelyn"
    owner_success_group_id: "@owner-success"
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Standard cycle, 10 drafts / 2 auto-sent / 0 errors | Single clean post, thread not needed, sections populated. |
| T2 | Cycle with firm-reminder callout and partial-collected | Main post has Attention section with those owners; thread follow-up lists details. |
| T3 | 0 owners identified (unusual) | Post still goes out with "No outreach this cycle" message, flags if unexpected. |
| T4 | Trailing 4-wk rate drops to 55% | Caution banner included in post. |
| T5 | Slack API 500 on first try | Retry succeeds, post lands on time. |
| T6 | Slack API down 10 min | Fallback channel gets summary, Jocelyn notified to route. |
| T7 | 8 new opt-outs in one cycle | Main post flags, @Jocelyn tagged, retrospective prompt included. |
| T8 | Duplicate notification attempt same cycle | Idempotency catches, no duplicate post. |
| T9 | Region has no drafts but 12 already-collected | Celebratory post (all handled this cycle), short form. |
| T10 | Block Kit rendering fails | Falls back to plain text, legibility preserved. |

---

## 12. Success Metrics

- **Slack post on-time rate:** 100% posted by 7:35 AM region-local.
- **Owner Success click-through rate:** > 90% of posts result in drafts actioned same day (tracked by send timestamps).
- **Post engagement (reactions/replies):** trending — team treats the post as an active daily signal, not noise.
- **Time-to-drafts-sent** from post: target median < 2 hrs Monday morning.

---

## 13. Notes for Implementation

- **This is the team's UX for Phase 5.** Every design choice here should pass the "would Owner Success pay attention to this at 7:35 AM Monday?" test.
- **Emojis are signposts, not decoration.** One per section. If people start turning them into GIFs in replies, that's good — engagement.
- **The thread follow-up is the escape valve.** Main post stays under 1500 chars; detail goes to thread. Don't merge them.
- **Rate trends are the motivator.** Showing the team their week-over-week improvement is how you get them to keep the tempo. Celebrate wins in the Already Collected section (list names, "Nice work team, already 4 in the bag.").
- **@-mentions are surgical.** Only Jocelyn for escalations. Don't @channel — that's reserved for real emergencies.
- **Do not post on non-Monday schedules.** Ad-hoc bill ingestion (when owners reply mid-week) does NOT ping Slack — that would create noise. The bill-ingestor updates the dashboard silently; team sees results in next Monday's post.
