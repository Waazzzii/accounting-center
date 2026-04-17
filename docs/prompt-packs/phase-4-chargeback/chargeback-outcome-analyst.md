# Chargeback Outcome Analyst — Prompt Pack

**Agent:** `chargeback-outcome-analyst`
**Phase:** 4 (Chargeback Manager)
**Parent Orchestrator:** `chargeback-orchestrator`
**Trigger:**
- Event-driven: case decision logged by `chargeback-case-tracker` (per-case learning)
- Scheduled: last business day of each month at 3 PM PT (monthly report per SOP §9)
- Scheduled: quarterly on first business day of Jan/Apr/Jul/Oct (strategic trend review)
**Owner:** Audrey produces; Jason + Jocelyn consume in monthly Support L10.
**Purpose:** Convert individual outcomes into institutional learning. Close the feedback loop from dispute → evidence gap → operational investment.

---

## 1. Purpose

Chargebacks are expensive data. Every decision — win or loss — tells us something about our evidence, our operations, and our guests. This agent extracts the signal.

**Three jobs:**
1. **Per-case postmortem** — on every decision, capture what worked / what didn't and feed the library.
2. **Monthly report** (SOP §9) — count, win rate, dollars defended/lost, top 3 evidence gaps, operational recommendations.
3. **Quarterly strategic review** — multi-month trend lines, property/owner/market/channel patterns, investment case for integration gaps.

The goal is **institutional memory**. In 24 months, we should be able to look at any property, channel, or reason code and know exactly our historical win rate and what evidence matters most.

---

## 2. System Prompt

```
You are the Chargeback Outcome Analyst for ACME House Company. You turn
individual chargeback decisions into institutional knowledge.

The SOP target: reverse-engineer Judy Crane's 2-losses-in-5-years win rate
as the company standard. You are the feedback loop that makes that possible.

Your three jobs:
1. PER-CASE POSTMORTEM. For every decided case, extract the factors that
   drove the outcome: which evidence was cited by the processor, which gaps
   mattered, what would we do differently. Update the case library.

2. MONTHLY REPORT (last business day, per SOP §9). One-page report:
   count by processor + reason code, win rate, dollars defended vs lost,
   top 3 evidence gaps driving losses, concrete operational recommendations.
   Review with Jason + Jocelyn at monthly Support L10. Feeds EOS scorecard.

3. QUARTERLY STRATEGIC REVIEW. Multi-month trend analysis by market,
   channel, property, reason code, owner. Investment cases for integration
   gaps (the lock-log automation case, the ID capture case, etc.).

Your analytical constraints:
- EVIDENCE-BASED. Every finding cites case IDs. Never generalize from < 3
  cases without labeling as "anecdotal."
- OPERATIONALLY ACTIONABLE. Every insight has a recommended action with
  an owner and a dollar impact where possible.
- HONEST ABOUT SMALL SAMPLES. Early months will be low-data; flag when
  recommendations are directional vs conclusive.
- PATTERN-AWARE. Same property losing 3 chargebacks in a quarter is not a
  chargeback problem — it's an operational problem. Route accordingly.
- COST-AWARE. Dollars lost is half the story; dollars successfully defended
  is the other half (that's the value the chargeback process produced).

Your outputs: per-case postmortem notes, monthly one-pager, quarterly
strategic deck, case library updates.
```

---

## 3. Task Prompts (by trigger)

### 3a. Trigger: Per-case decision
```
Case {case_id} decided: {outcome} — {dollars}.
Case record: {case_record_json}
Dossier manifest: {dossier_manifest_json}
Narrative draft (as submitted): {final_submitted_text}
Processor stated reason (if provided): {processor_reason}

Produce the postmortem:
1. What drove the outcome?
2. Which exhibits were decisive (if processor cited any)?
3. Which gaps, if any, likely affected the result?
4. What would we do differently on the same case today?
5. Operational implication (if any): retrain, integrate, update template?

Update the case library with indexed tags:
  reason_code, processor, channel, market, property_id, owner_id,
  evidence_gaps, outcome, dollars, key_exhibits, takeaway_summary.
```

### 3b. Trigger: Monthly report
```
Pull all cases decided in {month}. Produce the SOP §9 one-pager:
- Count by processor and reason code
- Win rate (won / total decided)
- Total $ defended, total $ lost
- Top 3 evidence gaps driving losses (with case citations)
- 2–3 operational recommendations (owner, cost, expected impact)

Format: one page, scannable, data-backed. Post to:
- Asana monthly review task (assigned Audrey + Jason + Jocelyn)
- #chargebacks Slack channel
- Google Drive /Chargebacks/{YYYY}/Monthly-Reports/
- EOS scorecard entry for win rate

Also: update trend charts in the chargeback dashboard.
```

### 3c. Trigger: Quarterly strategic review
```
Pull the last 3 months of decided cases. Produce:
- Trend lines: win rate, volume, $ defended over time
- Pattern analysis: by property, channel, owner, reason code
- Integration-gap ROI: for the top evidence gap, calculate:
    $ lost attributable to the gap / estimated integration cost
    (e.g., PointCentral API: $X lost on no_lock_logs / $Y integration cost)
- Playbook updates: new dossier templates for under-represented reason codes
- Team performance: individual win rates if multiple humans submit
- Recommendations ranked by expected impact

Review with Jason in quarterly planning.
```

---

## 4. Step-by-Step Workflow

### Step 1 — Per-Case Postmortem

For each decision event:

1. **Pull the full case record, dossier manifest, submitted narrative, and processor decision.**
2. **Classify outcome drivers** using the taxonomy:
   - **WINS:**
     - `clean_evidence_cited` — processor explicitly referenced evidence we provided
     - `strong_lead_rebuttal` — reason-code-specific lead evidence present and decisive
     - `weak_cardholder_claim` — cardholder provided minimal counter-evidence
     - `full_documentation` — no gaps in standard checklist
     - `fast_response` — submitted with > 7 days to spare
   - **LOSSES:**
     - `critical_gap_lead_evidence` — missing lock logs for SNR, ID for fraud, etc.
     - `processor_favored_cardholder` — processor sided with cardholder despite our evidence
     - `evidence_contradiction` — our exhibits contradicted each other
     - `narrative_weakness` — response unclear, too long, emotional
     - `late_submission` — submitted < 48h before deadline
     - `wrong_reservation_matched` — catastrophic — escalate to matcher for retraining
     - `processor_rule` — cardholder used a reason code where merchant evidence is rarely sufficient (e.g., "I did not recognize the charge" — low-bar refunds)
   - **PARTIALS:**
     - `partial_refund_accepted` — we offered/accepted mid-dispute
     - `pro_rata_occupancy` — processor split on half-stay scenarios
3. **Tag the case library record** with driver codes.
4. **Calculate lessons:**
   - If lost to `critical_gap_lead_evidence`, what would we need to win next time? (specific tool / process change)
   - If won by `clean_evidence_cited`, which specific exhibit mattered? (so we double-down on capturing it)
5. **Emit learning event** if driver is high-signal:
   - Property pattern (same property lost 2+ cases) → ops flag
   - Channel pattern (Airbnb disputes winning at different rate than direct) → routing flag
   - Narrative pattern (Jocelyn always edits X phrasing) → narrative-drafter training signal

### Step 2 — Monthly Report (SOP §9)

Output format — one page, exact structure:

```
ACME CHARGEBACK MONTHLY REPORT — {Month Year}
Prepared by: Chargeback Outcome Analyst | For review: Audrey → Jocelyn → Jason

═══════════════════════════════════════════════════════════

📊 VOLUME & OUTCOMES

Received:      {N} cases ({$X,XXX} disputed)
Decided:       {N} cases
Win rate:      {XX}% ({W} won / {L} lost / {P} partial)
$ Defended:    ${XX,XXX}
$ Lost:        ${XX,XXX}
Net ROI:       ${XX,XXX} saved vs $0 defense scenario

vs. prior month: win rate {+/-X}pp | $ defended {+/-X}%
vs. 6-mo avg:   win rate {+/-X}pp | volume {+/-X}%

─────────────────────────────────────────────

BY PROCESSOR
Stripe:        {N} received | {XX}% win rate | ${XX,XXX} defended
Lynnbrook:     {N} received | {XX}% win rate | ${XX,XXX} defended

BY REASON CODE
Service Not Rendered:   {N} | {XX}% win
Not As Described:       {N} | {XX}% win
Fraud / CNP:            {N} | {XX}% win
Cancellation/Refund:    {N} | {XX}% win
Duplicate Charge:       {N} | {XX}% win

─────────────────────────────────────────────

🔍 TOP 3 EVIDENCE GAPS DRIVING LOSSES

1. {gap_code} — present in {N} of {L} losses — ${X,XXX} lost
     Cases: CB-2026-0XXX, CB-2026-0XXX
     Recommendation: {specific action, owner, timeline}

2. {gap_code} — present in {N} losses — ${X,XXX} lost
     Cases: CB-2026-0XXX
     Recommendation: {action}

3. {gap_code} — present in {N} losses — ${X,XXX} lost
     Recommendation: {action}

─────────────────────────────────────────────

✅ WHAT WORKED THIS MONTH

- {Specific wins with driver patterns, e.g., "Pre-arrival inspection photos
   cited by Stripe in 3 of 4 Not As Described wins."}
- {Narrative or process improvements that moved the needle}

─────────────────────────────────────────────

🎯 OPERATIONAL RECOMMENDATIONS

1. {Recommendation} — Owner: {name} — Est. impact: {$ or %} — Due: {date}
2. {Recommendation} — Owner: {name} — Est. impact: {$ or %} — Due: {date}
3. {Recommendation} — Owner: {name} — Est. impact: {$ or %} — Due: {date}

─────────────────────────────────────────────

📌 ESCALATED PATTERNS (to Jason)

- {Property/Owner/Channel patterns requiring strategic decision}

═══════════════════════════════════════════════════════════

EOS Scorecard metric this month: Win rate = {XX}% (target: {YY}%)
```

### Step 3 — Case Library

Maintain an indexed library of every decided case for future retrieval + narrative-drafter training:

```json
{
  "case_id": "CB-2026-0142",
  "decided_at": "2026-04-25T...",
  "outcome": "won",
  "dollars": 3679.00,
  "reason_code": "cancellation_refund",
  "processor": "lynnbrook",
  "channel": "direct",
  "market": "Coachella Valley",
  "property_id": "prop_421",
  "owner_id": "owner_5521",
  "tags": {
    "drivers_win": ["clean_evidence_cited", "strong_lead_rebuttal"],
    "drivers_loss": [],
    "decisive_exhibits": ["D", "I"],
    "gaps_present": []
  },
  "decisive_quote_from_processor": "Merchant provided clear evidence of cancellation policy acceptance at booking.",
  "narrative_submitted": "...",
  "reviewer_edits_from_draft": ["tightened opening", "removed one adjective"],
  "takeaway_summary": "Cancellation policy + booking timestamp + any prior refund record is the 1-2-3 combination that wins this reason code. Direct-booking path delivers all three cleanly via Streamline.",
  "retrievable_for_similar_cases": true
}
```

Indexed for retrieval by: reason_code × processor × channel, property_id, owner_id, market, narrative-drafter for template refinement.

### Step 4 — Quarterly Strategic Review

Three things the monthly cannot deliver:

1. **Integration investment ROI.** Concrete dollar case for each top evidence gap. Example output:
   > **PointCentral API Integration — Recommended**
   > 18 service_not_rendered cases in Q1. 14 won, 4 lost. Of the 4 losses, 3 cited missing lock access logs as material. Cases lost: $7,820. Same cases had PointCentral data pullable manually but not in time or not in the dossier. Engineering estimate for API integration: 40 hours / $8,000 one-time. Expected annual savings: $31,280 (4 cases/quarter × 4). **Payback: 3.1 months.**

2. **Pattern detection at scale.** Which properties, owners, channels are over-represented in losses. Requires ≥ 3 months of data.
   > Property "Sedona Saguaro" (prop_318) — 5 chargebacks in 90 days (vs avg 0.7). Host rating dropped 3.2 → 2.8. Two losses on Not As Described. Escalate to Larissa for listing audit.

3. **Playbook iteration.** Which dossier templates need updating based on what's actually working.
   > Not As Described rebuttal template — current order leads with inspection photos. Data shows Akia thread showing no in-stay complaint is cited by Stripe 3x more often. Recommend swap order: E → G instead of G → E.

### Step 5 — Feedback to Other Agents

Emit structured learning signals back to upstream agents:

- **To `chargeback-reservation-matcher`:** wrong-match cases become training data (never happen again).
- **To `chargeback-dossier-builder`:** gap severity rankings get updated (if `no_lock_logs` wins anyway 70% of the time on fraud cases, severity is "moderate" not "critical" — but on service_not_rendered it's still critical).
- **To `chargeback-narrative-drafter`:** reviewer-edit diffs get aggregated — if Jocelyn rewrites "We note that" to "The records show" in 80% of drafts, the template updates.
- **To `chargeback-orchestrator`:** stage SLA calibration based on actual duration data.

### Step 6 — Dashboard Feed

Publish to the Accounting Center dashboard (Phase 6) as structured metrics:
- Rolling 90-day win rate (line chart)
- Volume by reason code (stacked bar)
- $ defended / $ lost (waterfall)
- Top evidence gaps (heatmap by reason × gap)
- Property heat-list (highest chargeback rate properties, with owner context)

---

## 5. Output Schemas

### Per-case postmortem
```json
{
  "case_id": "CB-2026-0142",
  "postmortem_at": "2026-04-25T14:30:00Z",
  "outcome": "won",
  "drivers": {
    "win": ["clean_evidence_cited", "strong_lead_rebuttal"],
    "loss": [],
    "partial": []
  },
  "decisive_exhibits": ["D", "I"],
  "gaps_material": [],
  "would_do_differently": null,
  "operational_implication": null,
  "learning_signals_emitted": [
    {"to": "narrative-drafter", "signal": "cancellation_refund_template_working", "weight": 0.1}
  ]
}
```

### Monthly report (metadata)
```json
{
  "report_month": "2026-04",
  "generated_at": "2026-04-30T15:00:00Z",
  "volume": {
    "received": 12,
    "decided": 9,
    "won": 7,
    "lost": 2,
    "partial": 0
  },
  "financials": {
    "disputed_total": 34720.00,
    "defended_total": 21840.00,
    "lost_total": 4580.00,
    "pending_decision": 8300.00
  },
  "win_rate_pct": 77.8,
  "win_rate_vs_prior_month_pp": 12.8,
  "top_gaps": [
    {"gap": "no_lock_logs", "loss_count": 1, "dollars": 2840.00},
    {"gap": "no_inspection_photos", "loss_count": 1, "dollars": 1740.00}
  ],
  "recommendations": [
    {"rec": "...", "owner": "Larissa", "impact_usd": 11000, "due": "2026-06-01"}
  ],
  "eos_scorecard_metric": 77.8,
  "report_url": "https://drive.google.com/..."
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Win rate drops > 15 pp vs 6-mo baseline | Immediate Slack alert to Jocelyn + Jason, out-of-cycle review |
| Single property/owner > 3 losses in quarter | Escalate to Larissa + Jason with property profile |
| Single reason code win rate < 50% with > 5 cases | Playbook review — current dossier template isn't working |
| Processor changes their decision pattern (e.g., Stripe suddenly siding with cardholders more) | Flag strategic — possible rule change, adjust dossier approach |
| Integration-gap ROI > 2.0 payback year-1 | Formal investment recommendation to Jason for next budget cycle |
| Wrong-reservation-matched loss detected | Immediate postmortem to matcher team, this is a catastrophic failure |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Processor doesn't provide a stated decision reason | Postmortem classifies driver from case attributes alone; flag as `driver_inferred` |
| Case library corruption / missing record | Rebuild from case store + dossier manifest history |
| Monthly report fails to generate | Retry 3x, alert Audrey if still failing, use last known good template as fallback |
| Statistical significance too low (first 2 months) | Label all recommendations "directional" not "conclusive"; avoid over-indexing on small samples |
| Reviewer edits were not captured | Analyze against aggregate; flag missing review data as a process gap |

---

## 8. Tools Required

- **Case store** — read all decided cases
- **Dossier Drive** — read manifests + submitted narratives
- **Asana MCP** — create monthly review task, attach report
- **Slack MCP** — post report to #chargebacks, DM key stakeholders
- **Google Drive MCP** — save reports to /Chargebacks/YYYY/Monthly-Reports/
- **Dashboard API** — publish metrics to Accounting Center dashboard
- **LLM (Claude)** — driver classification, takeaway summarization, recommendation generation

---

## 9. Handoff Contract

**Upstream (from case-tracker):**
- Decision events (case_decided).
- Scheduled triggers (monthly, quarterly).

**Downstream:**
- To humans: Audrey (operational), Jocelyn (review), Jason (strategic), Larissa (operational patterns)
- To other agents: reservation-matcher (training signals), dossier-builder (gap severity), narrative-drafter (reviewer-edit patterns), orchestrator (SLA calibration)
- To dashboards: metrics feed for Accounting Center (Phase 6)
- To EOS: win-rate scorecard entry

---

## 10. Configuration

```yaml
chargeback_outcome_analyst:
  monthly_report_day: "last_business_day"
  monthly_report_time_pt: "15:00"
  quarterly_review_months: [1, 4, 7, 10]
  quarterly_review_day: "first_business_day"
  slack_channel: "#chargebacks"
  monthly_report_recipients:
    - audrey
    - jocelyn
    - jason
  report_drive_path: "/Chargebacks/{YYYY}/Monthly-Reports/"
  eos_scorecard_metric_id: "chargeback_win_rate"
  significance_thresholds:
    min_cases_for_recommendation: 3
    min_months_for_trend: 3
  anomaly_alerts:
    win_rate_drop_pp: 15
    property_loss_count_q: 3
    single_reason_code_win_rate_floor: 50
    min_cases_for_anomaly: 5
  roi_payback_threshold_years: 2.0
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | 10 cases decided in April, 8 won, 2 lost (SNR + NAD), $ defended $32k / lost $5.8k | Monthly report shows 80% win, top gap analysis, 2-3 recs |
| T2 | First month (only 2 cases decided) | Report labels recommendations "directional," flags low-sample caveat |
| T3 | Property prop_318 has 4 losses in Q1 | Quarterly flags to Larissa + Jason with property profile |
| T4 | PointCentral integration ROI calc | Investment case output with specific payback |
| T5 | Win rate drops from 82% (6-mo avg) to 65% in May | Out-of-cycle alert to Jocelyn/Jason |
| T6 | Wrong-reservation-matched loss | Immediate postmortem routed to matcher team with case details |
| T7 | Case won but processor cited no evidence | Driver classified as `weak_cardholder_claim` + `driver_inferred` flag |
| T8 | Quarterly review — narrative-drafter reviewer-edit diffs | Top 5 recurring edits aggregated, template update recommendations |
| T9 | Airbnb-channel win rate 45%, direct-channel 88% | Pattern surfaced with channel routing flag |
| T10 | Monthly report generation fails (Drive outage) | Retries, alerts Audrey, uses fallback template, manual posting |

---

## 12. Success Metrics

- **Institutional memory compounding:** by month 12, case library holds ≥ 100 indexed cases searchable by any tag combination.
- **Recommendation follow-through:** % of monthly recommendations that are acted on within 60 days — target > 60%.
- **ROI validation:** when we implement an integration, does lost-$ on that gap actually drop? Track pre/post.
- **Win rate trajectory:** month-6 win rate vs month-1 — target +10 pp improvement from operational changes.
- **Judy Crane parity:** trailing 12-month loss rate vs Judy's 5-year baseline (2 losses / ~50 cases = ~4%). Target by month 18.

---

## 13. Notes for Implementation

- **The monthly report is the whole reason this agent exists.** Everything else supports it. Audrey's hour assembling the SOP §9 report manually is exactly what should be automated end-to-end.
- **Don't overclaim on small samples.** In months 1–3, recommendations should read as hypotheses, not conclusions. Call out sample size explicitly.
- **The integration ROI case is the strategic lever.** PointCentral + Good Neighbor Tech API access is the #1 gap per the SOP. Every quarterly review should update the ROI math — eventually it becomes undeniable and we fund it.
- **Feedback loops are underrated.** Per-case signals to upstream agents create compounding improvement. Without them, the system's win rate plateaus at initial performance.
- **Pattern detection routes to ops.** Three chargebacks from the same property isn't a Support problem — it's a property problem. The outcome-analyst's job is to surface; Larissa + Jason decide what to do.
- **Keep the monthly report to ONE page.** If it needs two pages, it's too long. Scannable in 3 minutes at the L10 meeting.
