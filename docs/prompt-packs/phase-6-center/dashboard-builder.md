# Dashboard Builder — Prompt Pack

**Agent:** `dashboard-builder`
**Phase:** 6 (Dashboards & Cross-product)
**Parent Orchestrator:** `accounting-orchestrator`
**Trigger:** Event-driven (`kpi_refreshed`, `health_state_changed`, `close_step_complete`, `alert_delivered`) + scheduled morning refresh 09:00 PT + on-demand via dashboard URL hit
**Owner:** Jason (technical), whole team (users)
**SLA:** Tile updates within 30s of underlying event; morning refresh by 09:05 PT; dashboard page load < 2s p95

---

## 1. Purpose

The Accounting Center Dashboard is the **UX of the entire Accounting Center**. Everything we've built — 39 sub-agents across 6 phases, thousands of events per week, millions of dollars in motion — condensed to a set of dashboard tiles a human can read in 60 seconds.

This agent does NOT do analytics, computation, or decisioning. It's a **rendering engine**:
- Reads from `kpi_snapshots`, `health_state`, `close_cycles`, `audit_log`, `alert_deliveries`, and a few product-specific read-models
- Shapes each data point into a tile, chart, or table with consistent styling
- Pushes updates to the live dashboard via websocket / server-sent events
- Generates drill-down pages on request

The dashboard hierarchy is defined in PRD-00 §12:
- **Home:** Cash position, Today's summary, Product health banner
- **Per-product:** TrustSync, OTAAuditor, RevPost, Chargeback, Utility
- **Cross-product:** Close progress, Cash forecast, Audit search

If the humans on the team can check the dashboard once a day and know everything is fine — or instantly see what's broken — the Accounting Center has succeeded as a product.

---

## 2. System Prompt

```
You are the Dashboard Builder for the ACME Accounting Center.

You render dashboards. You do not compute metrics (kpi-computer does that).
You do not decide severity (health-monitor does). You do not decide routing
(alert-router does). You read their outputs and turn them into tiles,
charts, tables, and drill-downs that humans actually look at.

Design principles:
- SCANNABILITY OVER COMPLETENESS. A dashboard that shows 50 metrics is worse
  than one that shows 8. Put the top signal at the top.
- COLOR IS MEANING. Green = good, yellow = attention, red = act now. Don't
  use color decoratively.
- EVERY NUMBER IS CLICKABLE. One click drills to the snapshot ID and the
  source data.
- FRESHNESS VISIBLE. Every tile shows "as of HH:MM" so users know if data
  is stale.
- MOBILE-FIRST. Jason checks this on his phone at 7 AM. Tiles must be
  legible on a 5" screen.
- LOAD IN UNDER 2 SECONDS. Heavy queries run server-side on push; the page
  reads pre-materialized tile state.

Rules:
- Tiles never compute; they read from tile_state table.
- Tile state is written by this agent in response to upstream events.
- A tile with stale data (> freshness_threshold) renders with a visible
  staleness indicator — never silently stale.
- The dashboard ships with BOTH an HTML render and a JSON API; every tile
  is consumable either way.
- Accessibility: color + text, never color alone. Screen-reader-friendly
  markup. Keyboard-navigable drill-downs.
```

---

## 3. Task Prompt Template

```
Event received: {event_type} with {payload}.

Identify which tiles are impacted by this event (from tile_subscription_map).

For each impacted tile:
1. Load the tile definition (tile_definitions table)
2. Compose updated tile state by reading relevant source tables
3. Render HTML fragment + JSON representation
4. Write to tile_state table (append-only with supersedes pointer)
5. Push via websocket to connected dashboard clients
6. Log render event

Return tiles_updated[] with render hashes.
```

---

## 4. Step-by-Step Workflow

### Step 1 — Dashboard Schema

```
tile_definitions:
  tile_id              TEXT PK
  tile_name            TEXT
  dashboard_path       TEXT   ('/home', '/trustsync', '/close', '/audit/search')
  category             TEXT   ('kpi','health','feed','chart','table','cta')
  render_template      TEXT   (Handlebars / JSX snippet)
  data_sources         JSON   [{table, query_template, refresh_trigger_events}]
  freshness_threshold_sec INT
  visibility_roles     JSON   (who can see this tile)
  position             JSON   {page, row, col, width, height}
  drill_down_path      TEXT   NULL
  mobile_render_mode   TEXT   ('full','compact','hide')
```

```
tile_state:
  snapshot_id          UUID PK
  tile_id              TEXT
  rendered_at          TIMESTAMP
  data_as_of           TIMESTAMP  (freshness timestamp)
  state_json           JSON       (canonical state)
  html_fragment        TEXT
  supersedes_id        UUID NULL
  render_hash          TEXT       (sha256 of state_json)
  trigger_event_id     TEXT NULL
```

```
tile_subscription_map:
  tile_id              TEXT
  trigger_event_type   TEXT   (what event causes this tile to refresh)
  debounce_seconds     INT    (coalesce rapid-fire events)
```

### Step 2 — Home Dashboard Tiles

| Tile | Category | Source | Freshness SLA |
|---|---|---|---|
| `cash_position` | KPI | Column Bank balance aggregation | 60s |
| `center_health_banner` | Health | `health_state` entity=center | 120s |
| `today_summary` | Feed | orchestrator_routing_log + alert_deliveries for today | 60s |
| `product_health_row` | Health | `health_state` per product | 120s |
| `pending_approvals` | Feed | Asana tasks in "Accounting Center — Approvals" | 180s |
| `top_alerts_live` | Feed | `alert_deliveries` where severity≥warn, last 2h | 30s |
| `active_close_banner` | Status | `close_cycles` where status=in_progress | 30s |
| `weekly_trend_mini_chart` | Chart | Rolling 7-day sparklines for 3 headline KPIs | 300s |

### Step 3 — Product Dashboards

Each of the five products has its own dashboard. Tile inventory per PRD-00 §12.

**TrustSync (`/trustsync`):**
- Today's transfers (count, amount, status)
- Monthly transfer volume by market (stacked bar)
- Transfer error rate 30-day trend (line chart)
- Pending transfers awaiting approval (feed)
- Last reconciliation status (green/yellow/red tile)

**OTAAuditor (`/otaauditor`):**
- Today's match rate (gauge)
- Exception aging (bucketed: 0-1d, 2-3d, 4-7d, >7d)
- Unmatched items feed with confidence suggestions (drill to exception manager)
- Monthly reconciliation trend (line)
- Per-channel automatch rate (small-multiples)

**RevPost (`/revpost`):**
- JEs posted today (count + total amount)
- Pending entries (awaiting approval, missing mapping — two separate feeds)
- Trial balance status (indicator + last run timestamp)
- Month-end close progress tile (if close active)
- Error rate 30d trend

**Chargeback (`/chargeback`):**
- Open disputes (count, total amount, soonest deadline)
- Win rate 30 / 60 / 90d (three gauges)
- Disputes by market (bar)
- Disputes by reason code (bar)
- Repeat-offender properties table (top 10)
- Case library highlights (3 most recent won + lost with narrative snippet)

**Utility (`/utility`):**
- This week's cycle status (per region: drafted / sent / collected / pending)
- Collection rate 14d by region (two gauges)
- Outstanding bills aging
- Monthly credits applied MTD
- Auto-send penetration rate

### Step 4 — Cross-Product Views

**Close Progress (`/close`):**
- Live step-by-step progress of active close cycle
- Historical close cycle table (duration, variance, approver)
- Close cycle trend chart (BD-to-close over 12 months)

**Cash Forecast (`/forecast`):**
- 30-day cash projection by market (from TrustSync transfer cadence + expected payouts)
- Stress-test scenarios

**Audit Search (`/audit`):**
- Search bar → audit-log-reader NL query
- Recent high-severity events feed
- Integrity-check history

**Reports Archive (`/reports`):**
- Weekly / monthly / quarterly report browser (from `reports_generated` archive)

### Step 5 — Tile Update Flow

Event arrives (e.g., `phase-4-chargeback.dispute_won`):
1. Look up `tile_subscription_map` → find tiles subscribed
2. For each tile, check `debounce_seconds` — if a render happened within the window, coalesce
3. For each tile due for refresh:
   a. Load tile_definition
   b. Execute the query template(s) in `data_sources` (read-only)
   c. Compose the `state_json`
   d. Render `html_fragment` from template + state
   e. Compute `render_hash`
   f. If `render_hash` differs from current → write new `tile_state` row, set prior's `supersedes_id`
   g. Push websocket update to connected clients subscribed to this tile
   h. Log render event

### Step 6 — Mobile Render Modes

Three modes per tile: `full`, `compact`, `hide`.
- **full:** desktop view, all details
- **compact:** essential number + trend arrow, no sparkline
- **hide:** not shown on phone (e.g., wide tables)

Media query on viewport width decides which render to serve. Server decides based on `User-Agent` + viewport hint.

### Step 7 — Drill-Downs

Every tile has a `drill_down_path` (optional):
- KPI tile → snapshot detail page with SQL, source rows, version history
- Feed tile → full feed with filters
- Chart tile → raw time-series data + export CSV
- Health tile → list of signals + reasons + recent transitions

Drill-down pages reuse the same dashboard-builder render pipeline — just richer templates.

### Step 8 — Access Control

Tile `visibility_roles` restricts who sees what:
- Mike: all
- Kimberly / Wendell: all except security-events
- Jocelyn: utility + chargeback + related health
- Jason: all (admin)
- Operations team: non-financial tiles on product dashboards
- Auditor: audit search + compliance tiles only, PII-redacted

Server-side enforcement: never render unauthorized state, even as HTML.

### Step 9 — Morning Refresh (09:00 PT)

Scheduled full refresh of all tiles:
- Ensures anything missed by event-driven updates is caught
- Recomputes tiles that have no trigger event (e.g., rolling averages that advance daily)
- Logs as `morning_refresh_complete` event

### Step 10 — Self-Health

Dashboard-builder emits its own health signals:
- Tile render p95 latency
- Websocket connection count
- Stale-tile count (tiles past freshness threshold)
- Page load times

Consumed by health-monitor for the `center` entity state.

---

## 5. Output Schema

**tile_state row:**
```json
{
  "snapshot_id": "ts_abc",
  "tile_id": "home.cash_position",
  "rendered_at": "2026-04-13T09:00:14-07:00",
  "data_as_of": "2026-04-13T09:00:00-07:00",
  "state_json": {
    "total_usd": 2847291.44,
    "by_account": [
      {"account": "operating-coachella", "balance_usd": 412887.11},
      {"account": "trust-coachella", "balance_usd": 284192.47},
      {"account": "operating-scottsdale", "balance_usd": 398021.66},
      "..."
    ],
    "as_of_source": "column_bank_snapshot_balance_1418",
    "trend_7d": [2.81, 2.83, 2.85, 2.84, 2.86, 2.84, 2.85]
  },
  "html_fragment": "<div class='tile tile-kpi'><div class='tile-header'>Cash Position</div>...</div>",
  "render_hash": "sha256:...",
  "trigger_event_id": "evt_cash_refresh_09_00",
  "supersedes_id": "ts_prev"
}
```

**Websocket push message:**
```json
{
  "type": "tile_update",
  "tile_id": "home.cash_position",
  "render_hash": "sha256:...",
  "html_fragment": "...",
  "state_json": { "..." },
  "pushed_at": "2026-04-13T09:00:14.220-07:00"
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Tile stale > 2x freshness threshold | Tile renders with warning indicator; alert Jason if persistent |
| Dashboard page load p95 > 2s | Performance alert to Jason |
| Websocket disconnect rate > 5% | Infrastructure alert |
| User reports wrong number in tile (via feedback) | Priority alert; investigate whether tile or upstream KPI |
| A tile fails to render 3x in a row | Fall back to "tile unavailable — click to retry" state + alert |
| Role-based access violation attempt (someone tries to drill to unauthorized) | Log as security event; surface in audit log |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Upstream query times out | Render tile with last-known state + stale indicator; retry in background |
| Template render fails | Fall back to JSON-only view; alert Jason with broken template |
| State JSON too large (> 100KB) | Truncate with "view full data" link to drill-down |
| Client disconnects mid-push | Drop update; client reconnects and requests full refresh |
| Simultaneous updates race | Idempotent writes (render_hash unique); whichever arrives last wins; log both |
| Morning refresh misses scheduled time | Catch-up run within 15 min + log `morning_refresh_drift` |

---

## 8. Tools Required

- **Database:** read `kpi_snapshots`, `health_state`, `close_cycles`, `alert_deliveries`, `orchestrator_routing_log`, `audit_log` (filtered); write `tile_definitions`, `tile_state`
- **Event bus:** subscribe to refresh triggers, emit `tile_rendered`, `dashboard_self_health`
- **Websocket server:** push updates to connected clients
- **HTTP server:** serve dashboard HTML + JSON API
- **Template engine:** Handlebars, JSX, or server components
- **Asana MCP:** read pending approvals for `pending_approvals` tile
- **Column Bank API:** real-time balance refresh (rate-limited)

---

## 9. Handoff Contract

**Upstream:** Every Phase 6 agent emits events this agent subscribes to:
- `kpi_refreshed` (kpi-computer)
- `health_state_changed` (health-monitor)
- `alert_delivered` (alert-router)
- `close_step_complete` / `close_completed` (month-end-close)
- `report_generated` (cross-product-reporter)

Plus product-level events (via accounting-orchestrator) where relevant for feeds.

**Downstream:**
- HTML + websocket updates → humans (browsers, phones)
- `tile_rendered` → kpi-computer (dashboard usage metrics, optional)
- `dashboard_self_health` → health-monitor

**Side-effects:** `tile_state` table writes; websocket messages; cached HTML.

---

## 10. Configuration

```yaml
dashboard_builder:
  definitions_table: "tile_definitions"
  state_table: "tile_state"
  subscription_map_table: "tile_subscription_map"
  morning_refresh_time_pt: "09:00"
  default_freshness_threshold_sec: 300
  default_debounce_seconds: 10
  default_mobile_mode: "compact"
  max_state_size_kb: 100
  websocket:
    port: 8081
    auth_method: "slack_oauth"
    heartbeat_seconds: 30
  http:
    port: 8080
    tls_required: true
    page_load_target_ms: 2000
  caching:
    html_cache_ttl_seconds: 10
    json_api_cache_ttl_seconds: 5
  role_visibility_table: "role_matrix"
  access_control:
    deny_default: true
    log_all_denials: true
  home_layout:
    rows:
      - [ "center_health_banner" ]
      - [ "cash_position", "today_summary", "pending_approvals" ]
      - [ "product_health_row" ]
      - [ "active_close_banner", "top_alerts_live" ]
      - [ "weekly_trend_mini_chart" ]
  product_dashboards:
    - path: "/trustsync"
      role_minimum: "accounting_lead"
    - path: "/otaauditor"
      role_minimum: "accounting_lead"
    - path: "/revpost"
      role_minimum: "accounting_lead"
    - path: "/chargeback"
      role_minimum: "ops_reviewer"
    - path: "/utility"
      role_minimum: "ops_reviewer"
  cross_product_dashboards:
    - path: "/close"
      role_minimum: "accounting_lead"
    - path: "/forecast"
      role_minimum: "coo"
    - path: "/audit"
      role_minimum: "accounting_lead"
    - path: "/reports"
      role_minimum: "accounting_lead"
  accessibility:
    require_aria_labels: true
    require_text_alongside_color: true
    keyboard_nav_paths: true
  mobile:
    breakpoint_px: 768
    compact_mode_below: 480
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | `kpi_refreshed` for chargeback winrate | Tile updates within 30s; websocket push delivered to connected clients |
| T2 | Home dashboard load (desktop) | Page renders < 2s; all tiles populated from tile_state |
| T3 | Home dashboard load (mobile 5" screen) | Compact layout; essential tiles visible; load < 2s |
| T4 | Jocelyn loads home | Utility + chargeback-related tiles visible; TrustSync tiles hidden |
| T5 | Stale tile (upstream KPI source offline) | Tile renders last-known + stale indicator; no error state |
| T6 | Close in progress | `active_close_banner` tile prominent on home; updates with each step completion |
| T7 | Alert delivered | `top_alerts_live` tile updates in real-time |
| T8 | Drill into cash_position | Shows per-account breakdown + Column Bank snapshot ID + audit link |
| T9 | Auditor loads `/audit` | Sees search bar + integrity log; PII-redacted where applicable |
| T10 | Morning refresh at 09:00 PT | All tiles rendered fresh; morning_refresh_complete event emitted |
| T11 | 20 events fire in 5s (burst) | Debounce coalesces; tiles update once; no flooding |
| T12 | Template fails on a tile | Tile shows "unavailable — retry" with fallback JSON; alert Jason |

---

## 12. Success Metrics

- **Page load p95:** < 2 seconds (home and per-product)
- **Tile update latency:** < 30s from upstream event to rendered push
- **Stale-tile rate:** < 1% of tile views served stale data (> freshness threshold)
- **Morning refresh on-time:** 100% within 5 min of 09:00 PT
- **Usage (daily active users):** 100% of leadership team + accounting (Mike, Larissa, Jason, Kimberly, Wendell, Jocelyn) visit at least once per weekday
- **Mobile usage:** > 40% of sessions on phone (especially Jason's 7 AM check)
- **Time-to-insight:** users report "I can tell if things are OK in 30 seconds" (qualitative survey)
- **Accessibility audit:** pass WCAG 2.1 AA

---

## 13. Notes for Implementation

- **Start with the home banner and the 5 product health tiles.** If that subset works, the rest is straightforward elaboration. If that subset doesn't work, nothing else matters.
- **Don't try to render the whole hierarchy before shipping.** Phase 6 week 19-22 per the PRD: cash position first, per-product views next, cross-product last. Each week ships a real, usable thing.
- **Tile state is append-only by design.** A tile at 09:00 yesterday should be reproducible today. This is essential for "what did the dashboard show when the decision was made" audits.
- **The websocket push is the magic.** The moment Kimberly sees a number update live — without refreshing — the Accounting Center feels alive. That perception matters.
- **Resist the temptation to put computation in the dashboard.** Every time a tile does math, drift starts. Put the math in kpi-computer; read the result here. Sacred.
- **Mobile is first, not last.** Jason reads this in bed at 7 AM. If the mobile experience is bad, adoption dies.
- **Accessibility from day one.** Adding keyboard nav and ARIA labels retroactively is painful. Build them in.
- **The dashboard is the demo.** When Mike gives a board tour, when we pitch a franchisee, when we onboard a new accountant — this is what they see. Polish matters.
- **Fast is a feature.** A dashboard that takes 8 seconds to load loses users. A dashboard that loads in 1.2 seconds becomes part of everyone's morning routine. Engineer for speed from the start.
- **Archive tile renders for the close package.** When a close completes, snapshot the entire dashboard state at close time. That becomes part of the immutable close archive — "here's exactly what the Accounting Center looked like when we signed off on April."
- **This is the product's face.** Everything we built only matters if someone looks at it. Make it worth looking at.
