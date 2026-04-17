# Cross-Product Reporter — Prompt Pack

**Agent:** `cross-product-reporter`
**Phase:** 6 (Dashboards & Cross-product)
**Parent Orchestrator:** `accounting-orchestrator`
**Trigger:** Scheduled — weekly (Mon 07:00 PT), monthly (BD+2 noon PT), quarterly (second Monday of new quarter 08:00 PT); plus on-demand via Slack `/acct report`
**Owner:** Jason (technical), Mike + Kimberly + Larissa (audience)
**SLA:** Weekly report ready by 07:30 PT Mon; monthly by BD+2 13:00 PT; quarterly within 2 BD of quarter close

---

## 1. Purpose

Every week, Mike wants to know "how's the Accounting Center doing?" in 90 seconds. Every month, Kimberly needs the close-cycle narrative + Tier 1-3 metric trends for the L10. Every quarter, the leadership team needs an executive rollup with context on wins, losses, and what to invest in next.

Reading five product dashboards and cross-referencing KPI snapshots to answer those questions takes an hour. This agent does it automatically.

Output is the **narrative layer on top of the KPIs** — numbers + context + recommendations, formatted for the audience. The KPI computer gives us truth; this agent makes it legible.

---

## 2. System Prompt

```
You are the Cross-Product Reporter for the ACME Accounting Center.

Your job is to produce executive-grade reports combining KPIs, health
history, incident summaries, and audit-log highlights across all five
products and the center infrastructure. You write for humans, not machines.

Report types:
  1. WEEKLY — Monday 07:00 PT, audience: Jason + Larissa + Kimberly.
     Focus: last 7 days. Tone: operational.
  2. MONTHLY — BD+2 noon PT, audience: Mike + Larissa + Kimberly.
     Focus: last month. Tone: strategic. Ties to board narrative.
  3. QUARTERLY — second Monday of new quarter, audience: full exec team
     + board prep. Focus: trends, ROI, roadmap. Tone: strategic + investment.
  4. ON-DEMAND — Slack command, flexible window + scope.

Rules:
- NUMBERS COME FROM kpi_snapshots. Never recompute in the report.
- NARRATIVE IS HUMAN-WRITTEN-QUALITY. Don't just dump numbers; explain
  what they mean, why they changed, what to do.
- CONTEXT MATTERS MORE THAN PRECISION. "Win rate up 8 points on Stripe
  thanks to better evidence on NOT_AS_DESCRIBED disputes" beats "win
  rate: 68.42%."
- CALL OUT OUTLIERS AND ANOMALIES. If a KPI moved > 1σ, explain.
- RECOMMEND ACTIONS. Every report ends with 3-5 concrete next-week /
  next-month actions.
- EVERY NUMBER IS CITATION-BACKED. Link to kpi_snapshot or audit_log ID.
- RESPECT THE AUDIENCE. Mike wants strategic; Kimberly wants tactical;
  auditors want citations. Compose per audience.

Voice by report type:
  Weekly:   crisp, bullet-heavy, "here's what happened, here's what's next"
  Monthly:  narrative, "the month in one page" prose with supporting tables
  Quarterly: executive prose, tied to company strategy (1K property target,
             Unreasonable Hospitality, AI-first operating model)
```

---

## 3. Task Prompt Template

```
Generate {report_type} report for period {window_start} to {window_end}.
Audience: {audience_list}
Scope: {products_list | "all"}
Delivery: {slack_channel, email_list, drive_path}

Inputs:
- kpi_snapshots for the window
- health_daily_rollup for the window
- close_cycles (if monthly+ covers a close)
- chargeback_cases outcomes
- audit_log highlights (large transfers, overrides, incidents)
- prior period report (for trend comparison)

Produce:
1. Executive summary (1 paragraph)
2. Top-line metrics with trend indicators (↑ / ↓ / →)
3. Per-product sections with narrative
4. Outliers & anomalies with explanations
5. Wins & losses of the period
6. Recommended actions
7. Citations appendix (kpi_snapshot IDs, audit_log IDs, dashboard links)
```

---

## 4. Step-by-Step Workflow

### Step 1 — Data Assembly

Pull the full data set for the window:

| Source | What |
|---|---|
| `kpi_snapshots` | All snapshots with `window_end` within period, plus prior period for delta calc |
| `health_daily_rollup` | Health state daily summaries |
| `close_cycles` | Any close that completed in window (monthly+) |
| `chargeback_cases` | Cases opened/closed in window with outcomes |
| `utility_collections` | Cycle stats for weeks in window |
| `trustsync_transfers` | Transfer volume + error events |
| `revpost_jes` | Posted JE counts + any error rows |
| `audit_log` | Highlight query: transfers > $10K, overrides, critical events |
| `alert_deliveries` | Alert volume + ack timing |
| `orchestrator_flags` | Flag changes (audit-mode, pauses) |

Parallel queries where possible (all sources independent).

### Step 2 — Trend Analysis

For each Tier 1-3 KPI, compute:
- Current period value
- Prior period value
- Delta (absolute + pct)
- Trailing-N periods for trend arrow
- Σ deviation from trailing mean

Flag for narrative emphasis:
- Any KPI with |delta| > 10% vs prior period
- Any KPI outside 1σ of trailing mean
- Any KPI crossing a target threshold (met or missed)

### Step 3 — Narrative Generation (LLM Layer)

This is where the agent earns its keep. For each flagged KPI, generate 1-2 sentences explaining the movement. Draw from:

- **Chargeback case outcomes** (audit-log events) — "Win rate up because 4 of 5 NOT_AS_DESCRIBED disputes were won this week."
- **Product incident history** (health-monitor) — "OTAAuditor dipped to yellow Tuesday for 2 hrs due to an Airbnb portal timeout."
- **Operational changes** (orchestrator flags, config changes) — "Utility auto-send guards were loosened Wednesday for trusted-tier owners."
- **Seasonality context** — "Occupancy up MTD tracks with Coachella Music Festival."

The LLM is constrained: it must cite the underlying event/snapshot. It cannot speculate about causes not present in the data. If a KPI moved and the agent can't find a cause in the data, the narrative says "moved X%; no identified driver — investigate."

### Step 4 — Weekly Report Template

Delivered: Slack DM to Jason + Larissa + Kimberly, Mon 07:30 PT.

```
📊 Accounting Center — Week of Apr 7-13, 2026

*Summary:* Green week overall. Chargeback win rate climbed to 72% (↑8pts
vs prior 7d) thanks to stronger evidence on 3 NOT_AS_DESCRIBED cases.
TrustSync had one transfer fail mid-week (Coachella, $4,235) — resolved
same-day. Utility collection rate holding at 81% (above 80% target).

*Top metrics (vs prior week):*
• Chargeback win rate 30d: 72% ↑ (vs 64%)
• OTA automatch rate: 94% → (vs 94%)
• RevPost JE error rate: 0.08% ↓ (vs 0.12%)
• Utility collection 14d: 81% ↑ (vs 78%)
• TrustSync transfer errors: 1 ↑ (vs 0)

*Wins this week:*
• First auto-sent utility draft in Arizona — owner_8821 (trusted tier)
• RevPost hit 0-error day Fri; 847 JEs, zero variance
• Chargeback response time down to 3.2 hr avg (target 4 hr)

*Needs attention:*
• 2 OTAAuditor exceptions aged past 7 days (market: tucson)
• Column Bank transfer failure Wed — root cause: upstream funding delay
• Utility bill in ambiguous state for owner_9944, 4 days pending review

*Next 7 days:*
1. Kimberly: resolve 2 Tucson OTA exceptions by EOD Tuesday
2. Jason: tune Column Bank retry backoff based on Wed incident
3. Jocelyn: manual review on owner_9944 partial-bill submission

_All numbers cite kpi_snapshots; see <dashboard link>. Full citations:
<drive link>_
```

### Step 5 — Monthly Report Template

Delivered: Slack DM + email + Drive-saved PDF to Mike + Larissa + Kimberly + Jason, BD+2 13:00 PT.

Structure:
1. **Executive Summary** (1 paragraph, CEO-grade prose)
2. **The Month in Numbers** (table — Tier 1 + Tier 2 KPIs, current vs prior vs target)
3. **Close Cycle Performance** (duration, variance, exceptions; from close-cycle data)
4. **Product-by-Product Narrative** (5 short sections)
5. **Incidents & Resolutions** (any red-health events + postmortem refs)
6. **Chargeback Case Library Highlights** (top 3 wins, any losses with learnings)
7. **Financial Impact** ($ saved, $ recovered, $ avoided)
8. **Recommended Actions for Next Month** (5-7 items)
9. **Citations Appendix** (links to kpi_snapshots, audit_log IDs, close archive bundle)

Length target: 3-5 pages. Scannable headings. Numbers + context + action.

### Step 6 — Quarterly Report Template

Delivered: Google Doc shared with full exec team + board prep pack, within 2 BD of quarter close.

Adds on top of monthly structure:
1. **Quarter-over-quarter trends** (4-quarter rolling view of Tier 1 metrics)
2. **ROI analysis** ($ saved / month × labor hours reduced → investment return on each product)
3. **Strategic progress vs North Star** ("on track to 1K properties by 2028" narrative)
4. **Roadmap adjustments recommended** (which Phase-2+ products to accelerate based on data)
5. **Risk review** (operational + compliance risks that emerged this quarter)
6. **Comparison to industry benchmarks** (where available; flag where not)

This report gets 3-4 hours of human polish by Jason before distribution. Agent delivers the 80%.

### Step 7 — On-Demand Reports

Slack command: `/acct report {scope} {window}`
Examples:
- `/acct report chargeback last-30d`
- `/acct report utility socal mtd`
- `/acct report all q1-2026`

Returns same structure, audience auto-detected from caller role, delivered to caller's DM.

### Step 8 — Report Archive

Every generated report saved to:
- Google Drive: `/Accounting Center/Reports/{Year}/{Week|Month|Quarter}/{filename}.{md,pdf}`
- Database: `reports_generated` (metadata, kpi_snapshot IDs referenced, generation hash)

Auditable reproducibility: anyone can regenerate a prior report from the archived snapshot IDs.

### Step 9 — Quality Checks

Before delivery:
- Every number in the report traces to a kpi_snapshot ID (automated check)
- No "TBD" or unfilled placeholders
- Narrative word count within bounds (weekly < 400 words; monthly < 2000; quarterly < 5000)
- All recommended actions are concrete (have owner + timeframe)
- Tone matches audience (automated LLM voice-check)

Fail any check → delay delivery, alert Jason.

---

## 5. Output Schema

**Report metadata row (in `reports_generated`):**
```json
{
  "report_id": "rpt_2026_w15",
  "report_type": "weekly",
  "period_start": "2026-04-07T00:00:00-07:00",
  "period_end": "2026-04-13T23:59:59-07:00",
  "audience": ["@jason","@larissa","@kimberly"],
  "generated_at": "2026-04-14T07:12:44-07:00",
  "delivered_at": "2026-04-14T07:30:00-07:00",
  "delivery_channels": ["slack_dm","drive_archive"],
  "kpi_snapshots_referenced": ["snap_abc","snap_def","..."],
  "audit_log_highlights": ["audit_xyz"],
  "citations_count": 47,
  "word_count": 392,
  "quality_checks_passed": true,
  "drive_url": "https://drive.acme.../weekly-2026-w15.md",
  "generation_hash": "sha256:..."
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Quality check fails (number without citation) | Block delivery; alert Jason to review |
| KPI snapshot missing for referenced metric | Wait up to 15 min for kpi-computer; if still missing, note "data pending" in report |
| Anomaly detected that wasn't in any alert | Flag to alert-router with suggested_action "cross-product-reporter caught this during synthesis" |
| Monthly report detects close not yet completed by BD+2 noon | Delay report; notify Kimberly; close-cycle data is prerequisite |
| Narrative LLM produces speculative claim (can't be traced) | Reject that paragraph; regenerate with citation constraint |
| Quarterly report reveals strategic miss (target not hit) | Escalate to Jason before broader distribution; let him add framing |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Source table query times out | Retry once; if persistent, emit placeholder in report + flag Jason |
| Delivery to email fails | Slack still delivers; email retry 3x then alert |
| Drive archive fails | Report still delivers to Slack; Drive retry; don't block delivery on archive |
| LLM returns malformed markdown | Retry with narrower prompt; fallback to template-only if still broken |
| Citations don't resolve (kpi_snapshot deleted mid-gen) | Should never happen (snapshots immutable); if it does, hard fail + alert Jason |
| Report delivered before kpi-computer rollup complete | Detect via `window_end` vs latest snapshot time; delay if stale |

---

## 8. Tools Required

- **Database:** read `kpi_snapshots`, `health_daily_rollup`, `close_cycles`, `chargeback_cases`, `utility_collections`, `audit_log`, `reports_generated`
- **LLM (Claude):** narrative generation with citation constraint
- **Google Drive MCP:** archive to Drive
- **Email gateway:** monthly + quarterly email delivery
- **Slack MCP:** DM + channel posts, `/acct report` command handler
- **PDF generator:** for monthly + quarterly formal output

---

## 9. Handoff Contract

**Upstream:** Consumes from kpi-computer, health-monitor, month-end-close-orchestrator, audit-log-reader, chargeback products.

**Downstream:**
- Delivered reports → humans (Slack, email, Drive)
- `report_generated` event → audit-log-reader (logged for compliance)
- `anomaly_detected_in_synthesis` → alert-router (rare)

**Side-effects:** Reports saved to Drive; metadata to `reports_generated`.

---

## 10. Configuration

```yaml
cross_product_reporter:
  schedule:
    weekly:
      day: "Mon"
      time: "07:00"
      tz: "America/Los_Angeles"
      delivery_time: "07:30"
      audience: ["@jason","@larissa","@kimberly"]
      channels: ["slack_dm","drive_archive"]
      word_count_max: 400
    monthly:
      bd_offset: 2
      time: "12:00"
      delivery_time: "13:00"
      audience: ["@mike","@larissa","@kimberly","@jason"]
      channels: ["slack_dm","email","drive_archive"]
      word_count_max: 2000
    quarterly:
      dow: "second_monday"
      time: "08:00"
      audience: ["@mike","@larissa","@kimberly","@jason","@jocelyn"]
      channels: ["drive_shared_doc","email"]
      word_count_max: 5000
      board_prep: true
  slack_commands:
    on_demand: "/acct report {scope} {window}"
  archive:
    drive_folder: "Accounting Center/Reports"
    folder_structure: "{Year}/{Type}/{filename}"
    formats: ["md","pdf"]
  quality_checks:
    every_number_cited: true
    no_placeholders: true
    word_count_within_bounds: true
    all_recommendations_have_owner_and_date: true
    voice_check_per_audience: true
  kpi_delta_threshold_for_narrative_emphasis_pct: 10
  sigma_threshold_for_anomaly: 1.0
  trailing_periods_for_trend: 4
  llm_constraints:
    model: "claude-opus"
    require_citation_for_claims: true
    reject_speculation: true
    voice_by_audience:
      weekly: "crisp_bullet_operational"
      monthly: "narrative_strategic_kimberly_kimberly_mike"
      quarterly: "executive_prose_ceo_board"
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Standard weekly report Mon 07:00 | Report delivered by 07:30 PT; all KPIs cited; 3 action items |
| T2 | Monthly report on BD+2 | Delivered to Mike + exec team; includes close-cycle narrative; 3-5 pages |
| T3 | KPI moved > 10% — narrative emphasis | Narrative calls out the movement with cause from data |
| T4 | KPI movement with no identifiable cause | Narrative says "moved X%; no identified driver — investigate" |
| T5 | On-demand `/acct report chargeback last-30d` | Report delivered to caller DM within 2 min |
| T6 | Quality check fails (uncited number slipped in) | Delivery blocked; Jason alerted; report regenerated |
| T7 | Quarterly report | 5-page exec doc with ROI, trends, roadmap; Jason reviews before broad distribution |
| T8 | Close not complete by BD+2 noon | Monthly report delayed with note; Kimberly notified |
| T9 | Email delivery fails | Slack + Drive still deliver; email retries; no blocking |
| T10 | Caller asks for report on deprecated KPI | Returns with note "metric deprecated in version X; here's the successor metric" |
| T11 | Report generation reveals unalerted anomaly | Emits `anomaly_detected_in_synthesis` → alert-router |
| T12 | Archive succeeds but report scheduled to audit review | reports_generated row + audit_log entry + Drive path all linked |

---

## 12. Success Metrics

- **On-time delivery:** 100% weekly, 100% monthly, 100% quarterly
- **Citation completeness:** 100% of numbers in every report trace to kpi_snapshot ID
- **Audience read rate:** > 80% Mike opens monthly email; > 90% Jason reacts to weekly Slack post
- **Action item follow-through:** > 70% of recommended actions have owner action within stated timeframe (tracked retro-actively by next report)
- **Anomaly catch:** cross-product-reporter catches ≥ 1 anomaly per quarter that no single product's alerting caught
- **Audit reproducibility:** 100% of archived reports can be regenerated bit-identical from snapshot IDs

---

## 13. Notes for Implementation

- **The narrative is where the value is.** Anyone can dump KPIs into a table. Saying "win rate up 8 points because evidence on NOT_AS_DESCRIBED improved" is what makes Mike pay attention. Invest in the LLM voice layer.
- **Citations are the trust contract.** Every number traces back. This is what separates an automated report from an "AI-generated report" — the auditor can reproduce every number.
- **Weekly is the habit-former.** If the Mon 07:30 post is reliable and useful, it becomes part of the leadership team's rhythm. That's where the Accounting Center becomes a product people depend on.
- **Monthly ties to board narrative.** Mike will forward the monthly report to investors eventually. Make sure the voice + framing hold up to external scrutiny.
- **Quarterly earns human polish.** 80/20: the agent delivers 80%; Jason spends 3-4 hours turning it into a board-ready deck. Don't try to automate 100% of the quarterly — the judgment overlay is high-value.
- **Outliers are the report's best feature.** Any single dashboard shows one metric. Only cross-product-reporter can say "chargeback win rate up AND utility collection rate up, coincident with the training day last Wednesday — correlation worth noting." Lean into that.
- **Never speculate.** "Win rate up because team morale is high" — unless morale is in a dataset, that's speculation. Kill it in review. Reports lose credibility fast when readers catch a guess.
- **The recommended-actions section is load-bearing.** A report without actions is a newsletter. With actions, it's a decision prompt. Make sure every report ends with 3-5 concrete next-step items, each with owner and timeframe.
- **This agent amplifies leadership.** It takes work Kimberly used to do for 8 hours every month and turns it into an artifact the whole exec team reads in 15 minutes. That time compounds. Over a year, it's hundreds of hours of leadership attention redirected from reporting to decisions.
