# KPI Computer — Prompt Pack

**Agent:** `kpi-computer`
**Phase:** 6 (Dashboards & Cross-product)
**Parent Orchestrator:** `accounting-orchestrator`
**Trigger:** Event-driven (recompute impacted KPIs on relevant events) + scheduled hourly / daily / monthly rollups
**Owner:** Jason (definitions), Kimberly (Tier 1 financial metrics)
**SLA:** Hourly rollups within 10 min of the hour; daily rollups by 08:30 PT; monthly rollups by BD+1 noon PT

---

## 1. Purpose

The **single source of truth for every KPI** in the Accounting Center. Every dashboard, every report, every alert that references a metric reads from the same `kpi_snapshots` table — written exclusively by this agent.

Why this exists: without a central computer, each dashboard reinvents the math. Five dashboards × 20 KPIs × 3 time windows = 300 opportunities for formulas to drift. One agent, one table, one truth.

Covers all three tiers from PRD-00 §16:
- **Tier 1 — Financial Impact:** manual hours saved, close cycle, chargeback net loss, transfer errors, late payouts
- **Tier 2 — Operational Efficiency:** match rate, exception aging, JE error rate, win rate, collection rate, compile time
- **Tier 3 — Compliance & Risk:** audit completeness, GL verification rate, deadline compliance, trust compliance, retention

---

## 2. System Prompt

```
You are the KPI Computer for the ACME House Company Accounting Center.

Your ONLY job is to compute metrics. You do not alert, you do not route,
you do not make decisions. You read product-level data, apply defined
formulas, and write immutable snapshots to kpi_snapshots.

Rules:
- FORMULAS ARE CONFIG, NOT CODE. Every metric has a named definition in
  kpi_definitions with its SQL / transform logic. Changing a formula means
  changing the definition row AND bumping its version.
- SNAPSHOTS ARE IMMUTABLE. Once written, a kpi_snapshot row is never updated.
  Corrections are new snapshots with corrected=true and a reference to the
  superseded row.
- EVERY SNAPSHOT IS REPRODUCIBLE. We record the exact SQL, inputs, and
  definition version so any snapshot can be regenerated from source truth.
- WINDOW DISCIPLINE. Every metric declares its window (hour / day / 7d /
  30d / 90d / MTD / QTD / YTD / trailing-N). No mixing.
- NEVER GUESS AT MISSING DATA. If a source is unavailable, emit
  `snapshot_deferred` and retry. Do NOT write a zero-filled snapshot.
- TIMEZONE: All daily/monthly windows use America/Los_Angeles for company-
  wide metrics. Region-specific metrics use region tz.

Output: rows in kpi_snapshots, plus `kpi_refreshed` events per metric.
```

---

## 3. Task Prompt Template

```
Compute KPI {kpi_name} for window {window_spec} ending at {window_end}.

Look up the definition from kpi_definitions (version {version}).
Execute the formula against the source table(s).
Validate the result against sanity bounds.
Write the snapshot to kpi_snapshots.
Emit kpi_refreshed event.
```

---

## 4. Step-by-Step Workflow

### Step 1 — Trigger Sources

Three trigger types:

**a) Event-driven recompute.** When the accounting-orchestrator emits certain events, recompute affected KPIs immediately:
| Event | KPIs to Recompute |
|---|---|
| `phase-2-otaauditor.match_complete` | `ota_automatch_rate_today`, `ota_exception_count_open` |
| `phase-3-revpost.je_posted` | `revpost_jes_posted_today`, `revpost_error_rate_30d` |
| `phase-4-chargeback.dispute_won|lost` | `chargeback_winrate_30d/60d/90d`, `chargeback_net_loss_mtd` |
| `phase-5-utility.credit_batch_approved` | `utility_credits_applied_mtd`, `utility_collection_rate_14d` |
| `phase-1-trustsync.transfer_completed` | `trust_transfer_volume_today`, `trust_transfer_error_rate_30d` |

**b) Scheduled hourly rollups** — lightweight KPIs that don't need real-time (queue depths, averages).

**c) Scheduled daily / monthly rollups** — heavy KPIs (cohort retention, multi-source joins), run at off-peak.

### Step 2 — Load Definition

Read the `kpi_definitions` row by name + version:
```
kpi_definitions:
  name               TEXT   PK part 1
  version            INT    PK part 2
  description        TEXT
  category           TEXT   ('financial','operational','compliance')
  tier               INT    (1,2,3)
  window_type        TEXT   ('hour','day','7d','30d','90d','mtd','qtd','ytd','trailing_N')
  formula_sql        TEXT   parameterized by window_start, window_end
  unit               TEXT   ('usd','count','pct','hours','bd')
  sanity_bounds      JSON   {min, max, flag_if_outside}
  dependencies       JSON   [list of other KPIs or source tables]
  owner              TEXT
  created_at         TIMESTAMP
  deprecated_at      TIMESTAMP NULL
```

Always use the **latest non-deprecated** version unless explicitly versioned.

### Step 3 — Execute Formula

Parameterize the SQL with the window bounds. Execute against source tables (read-only replicas preferred for expensive KPIs).

Validate:
- Result is non-null (null → `snapshot_deferred`, retry)
- Result is within sanity bounds (outside → still write, but flag `sanity_warning=true` and alert)
- Numeric type matches declared unit

### Step 4 — Write Snapshot

Insert into `kpi_snapshots`:
```
kpi_snapshots:
  snapshot_id        UUID PK
  kpi_name           TEXT
  kpi_version        INT
  window_type        TEXT
  window_start       TIMESTAMP
  window_end         TIMESTAMP
  value_numeric      NUMERIC
  value_display      TEXT   (formatted for UI: "92.4%", "$1,247.00")
  unit               TEXT
  computed_at        TIMESTAMP
  source_query_hash  TEXT   (sha256 of parameterized SQL + bounds)
  source_rows_count  INT    (how many source rows fed the calc)
  sanity_warning     BOOLEAN
  corrected          BOOLEAN
  supersedes_id      UUID   NULL
  segment_key        TEXT   NULL  (e.g., "region:socal", "market:coachella")
  segment_value      TEXT   NULL
```

Snapshots are append-only.

### Step 5 — Segmented Snapshots

Some KPIs are computed both overall AND by segment:

| KPI | Segmentation |
|---|---|
| `ota_automatch_rate_today` | per OTA channel (airbnb, vrbo, booking), per market |
| `chargeback_winrate_30d` | per processor (stripe, lynnbrook), per reason code, per market |
| `utility_collection_rate_14d` | per region (socal, arizona) |
| `trust_transfer_volume_today` | per market |

One snapshot per segment + one for "all". Segments use `segment_key` / `segment_value` columns.

### Step 6 — Emit `kpi_refreshed`

For every snapshot written:
```
Event: phase-6-center.kpi_refreshed
Payload:
  - snapshot_id
  - kpi_name, kpi_version
  - window_type, window_end
  - value_numeric, value_display
  - segment (if any)
  - sanity_warning
```

Consumed by: dashboard-builder (refresh tiles), alert-router (threshold-based alerts), cross-product-reporter (aggregate for reports).

### Step 7 — Correction Flow

If a source data correction is detected (e.g., a chargeback reversal, a bill OCR correction):
1. Mark impacted snapshots with `superseded_by = new_snapshot_id`
2. Write new snapshot with `corrected = true`, `supersedes_id = old_snapshot_id`
3. Emit `kpi_corrected` event
4. Dashboard + reports re-read

**Never update in place.** Even typos in definition.

---

## 5. KPI Catalog (Initial)

### Tier 1 — Financial Impact

| Name | Window | Unit | Formula (sketch) |
|---|---|---|---|
| `manual_accounting_hours_monthly` | mtd | hours | Sum of time-tracked accounting-task entries from Asana |
| `month_end_close_cycle_bd` | per-close | bd | `close_completed_at` BD - `close_kickoff_at` BD |
| `chargeback_net_loss_mtd` | mtd | usd | Sum of `lost_disputes.amount` - won-but-refunded - fees |
| `trust_transfer_errors_monthly` | mtd | count | Count `transfer_events.status = 'failed'` |
| `late_owner_payouts_monthly` | mtd | count | Count `owner_payouts.paid_at > sla_deadline` |

### Tier 2 — Operational Efficiency

| Name | Window | Unit | Formula (sketch) |
|---|---|---|---|
| `ota_automatch_rate_today` | day | pct | matched / total × 100 |
| `ota_exception_aging_over_7d` | current | count | Count `exceptions.opened_at < now - 7d AND status = 'open'` |
| `revpost_je_error_rate_30d` | 30d | pct | Errored JEs / total JEs × 100 |
| `chargeback_winrate_30d` | 30d | pct | Won / (Won + Lost) × 100; exclude 'no-contest' |
| `utility_collection_rate_14d` | trailing_14d | pct | Collected within 14d / total requested × 100 |
| `chargeback_evidence_compile_minutes` | 30d | minutes | Avg (submitted_at - detected_at) in minutes, filtered for auto-compiled |

### Tier 3 — Compliance & Risk

| Name | Window | Unit | Formula (sketch) |
|---|---|---|---|
| `audit_log_completeness_pct` | day | pct | Events-with-audit-row / events-emitted × 100 |
| `gl_posting_verification_rate` | day | pct | OTAAuditor-verified postings / total postings × 100 |
| `chargeback_deadline_compliance_pct` | 90d | pct | Submitted-before-deadline / total-submitted × 100 |
| `trust_compliance_violations_mtd` | mtd | count | Count `trust_validations.result = 'fail'` |
| `audit_log_retention_days` | current | days | Oldest audit row age in days (target: ≥ 2555 = 7y) |

Full catalog lives in `kpi_definitions` — this is the launch set.

---

## 6. Output Schema

```json
{
  "snapshot_id": "b3e2a0d4-...",
  "kpi_name": "chargeback_winrate_30d",
  "kpi_version": 3,
  "window_type": "30d",
  "window_start": "2026-03-14T00:00:00-07:00",
  "window_end": "2026-04-13T00:00:00-07:00",
  "value_numeric": 68.42,
  "value_display": "68.4%",
  "unit": "pct",
  "computed_at": "2026-04-13T08:31:04-07:00",
  "source_query_hash": "sha256_abc...",
  "source_rows_count": 38,
  "sanity_warning": false,
  "corrected": false,
  "segment_key": "processor",
  "segment_value": "stripe"
}
```

And the emitted event:
```json
{
  "event_type": "phase-6-center.kpi_refreshed",
  "snapshot_id": "b3e2a0d4-...",
  "kpi_name": "chargeback_winrate_30d",
  "kpi_version": 3,
  "window_end": "2026-04-13T00:00:00-07:00",
  "value_numeric": 68.42,
  "value_display": "68.4%",
  "segment": {"key": "processor", "value": "stripe"},
  "sanity_warning": false
}
```

---

## 7. Escalation Triggers

| Condition | Action |
|---|---|
| Sanity warning fires (value outside defined bounds) | Alert KPI owner; still write snapshot with flag |
| KPI missing scheduled rollup (cron didn't fire) | Alert Jason: kpi-computer degraded |
| Formula raises SQL error | Alert Jason + definition owner; block dependent rollups |
| Source table unavailable for > 30 min | Emit `snapshot_deferred`; alert if > 2 hrs |
| Definition version deprecated but still referenced | Warn weekly until migrated |
| Corrected snapshot cascade triggers > 100 downstream recomputes | Throttle to prevent storm; notify Jason |

---

## 8. Error Handling

| Error | Handling |
|---|---|
| Source data missing for window | Emit `snapshot_deferred`, retry every 15 min up to 2 hrs; escalate if persistent |
| Definition row not found | Fail loud, alert Jason — never fall back to a "default" formula |
| Division by zero (e.g., 0 disputes in window → winrate) | Write snapshot as `null` value with `reason_code = "no_data"`; dashboard displays "—" |
| Segment value contains null | Treat as segment "unknown"; still compute |
| Write to `kpi_snapshots` fails | Retry 3x; persistent fail → DLQ + alert |
| Out-of-order event triggers recompute of already-current snapshot | Dedup by (kpi_name, window_end, segment); skip if snapshot already current |

---

## 9. Tools Required

- **Database:** read source tables across all products; write to `kpi_snapshots`, `kpi_definitions`
- **Event bus:** subscribe to recompute triggers, emit `kpi_refreshed` + `kpi_corrected`
- **Cron / scheduler:** for scheduled rollups
- **SQL executor** with parameterized query support + read-replica routing

---

## 10. Handoff Contract

**Upstream:**
- All product-level events (via accounting-orchestrator routing)
- Cron scheduler for rollups
- Manual recompute commands (via Slack `/kpi recompute {name} {window}`)

**Downstream:**
- `kpi_refreshed` → dashboard-builder, alert-router, cross-product-reporter
- `kpi_corrected` → same consumers + audit-log-reader

**Side-effects:**
- `kpi_snapshots` append-only writes
- Audit log per snapshot (lightweight — just id + hash)

---

## 11. Configuration

```yaml
kpi_computer:
  definitions_table: "kpi_definitions"
  snapshots_table: "kpi_snapshots"
  default_timezone: "America/Los_Angeles"
  regional_kpis_tz_map:
    socal: "America/Los_Angeles"
    arizona: "America/Phoenix"
  rollup_schedule:
    hourly:
      - "ota_exception_aging_over_7d"
      - "revpost_jes_pending_queue_depth"
      - "chargeback_open_dispute_count"
    daily_08_30:
      - "ota_automatch_rate_today"
      - "gl_posting_verification_rate"
      - "utility_collection_rate_14d"
      - "chargeback_winrate_30d"
      - "trust_transfer_volume_today"
      - "audit_log_completeness_pct"
    monthly_bd1_noon:
      - "manual_accounting_hours_monthly"
      - "month_end_close_cycle_bd"
      - "chargeback_net_loss_mtd"
      - "trust_transfer_errors_monthly"
      - "late_owner_payouts_monthly"
      - "utility_credits_applied_mtd"
  event_triggers:
    "phase-2-otaauditor.match_complete": ["ota_automatch_rate_today","ota_exception_count_open"]
    "phase-3-revpost.je_posted": ["revpost_jes_posted_today","revpost_error_rate_30d"]
    "phase-4-chargeback.dispute_won": ["chargeback_winrate_30d","chargeback_net_loss_mtd"]
    "phase-4-chargeback.dispute_lost": ["chargeback_winrate_30d","chargeback_net_loss_mtd"]
    "phase-5-utility.credit_batch_approved": ["utility_credits_applied_mtd"]
    "phase-1-trustsync.transfer_completed": ["trust_transfer_volume_today","trust_transfer_error_rate_30d"]
  deferred_snapshot_retry_minutes: [15, 30, 60, 120]
  sanity_alert_recipients: ["@jason", "@kimberly"]
  slack_commands:
    recompute: "/kpi recompute {name} {window}"
    list_deferred: "/kpi deferred"
    show_definition: "/kpi def {name}"
```

---

## 12. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Standard 08:30 daily rollup | All declared daily KPIs have a new snapshot row; events emitted |
| T2 | Chargeback win event fires mid-day | `chargeback_winrate_30d` and `_net_loss_mtd` recomputed within 60s |
| T3 | OTAAuditor source table unavailable | Snapshot deferred, retry, eventually succeeds; no zero-fill |
| T4 | Sanity warning on KPI (e.g., automatch rate jumps to 100% = suspicious) | Snapshot written with `sanity_warning=true`; alert fires |
| T5 | Data correction triggers recompute | New snapshot with `corrected=true`, old one marked `superseded_by` |
| T6 | Division by zero (no disputes this month → winrate) | Snapshot value=null, reason_code=no_data; dashboard shows "—" |
| T7 | Definition version bumped | New version used from next run; old snapshots retain old version ID |
| T8 | Same event fires twice (dedup test) | Only one snapshot written per (name, window, segment) |
| T9 | Segmented rollup | One snapshot per segment + one overall; all emitted |
| T10 | SQL formula error | Fail loud, alert; no snapshot written; downstream consumers see no refresh |
| T11 | Monthly rollup at BD+1 noon | All monthly KPIs computed; report-generator downstream sees them ready |
| T12 | KPI deprecated mid-cycle | Rollup stops producing new snapshots; dashboard shows last value + "deprecated" label |

---

## 13. Success Metrics (meta)

- **Snapshot write latency p95:** < 5 sec from trigger to DB
- **Deferred snapshots resolved within SLA:** > 99%
- **Formula correctness** (spot-check vs manual recompute): 100% parity
- **Zero-fill incidents:** 0 (we never write fake data)
- **Definition coverage:** every dashboard tile + every report number traces to a definition row
- **Downstream consumer happiness:** dashboard-builder never has to implement math

---

## 14. Notes for Implementation

- **Build the definitions table first, formulas second.** If you can't write down the formula in a definition row with a window and a unit, you don't know the KPI well enough yet.
- **Immutability is a feature.** When Mike or Kimberly asks "what was our chargeback win rate on March 15?" we can answer exactly, with the formula version, the source rows, and the SQL — no "best guess."
- **Segments are how the operational team uses this.** A global chargeback winrate of 65% hides that Stripe is at 82% and Lynnbrook is at 41%. Always segment where the business decision requires it.
- **Sanity bounds catch definition drift.** When OTAAuditor adds a new channel, match rates dip until the channel is tuned — the sanity bound tells us instantly instead of weeks later from a Mike email.
- **Resist "just one dashboard query that joins raw tables."** Every such query is a formula that will drift. Add it as a KPI definition.
- **Version aggressively.** Changing a numerator or denominator = new version. Old snapshots retain old version so historical dashboards stay coherent. Never mutate a formula in place.
- **This is the backbone of the CEO-facing story.** When Mike needs a board-deck metric, the path is: `kpi_definitions` → exact formula → `kpi_snapshots` → exact value → `audit_log` → exact source. One path. Every time.
