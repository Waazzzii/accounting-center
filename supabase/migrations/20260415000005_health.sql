-- =============================================================================
-- 20260415000005_health.sql
-- Health Monitor: current state + hysteresis samples + daily rollup
-- =============================================================================
-- Hysteresis rules (see health-monitor prompt pack §4):
--   green → yellow:  2 consecutive "bad" samples
--   yellow → red:    3 consecutive "bad" samples OR 1 critical
--   yellow → green:  5 consecutive "good" samples
--   red → yellow:    3 consecutive "good" samples
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Current health state (one row per product × dependency × region)
-- -----------------------------------------------------------------------------

CREATE TABLE health_current (
  health_key          TEXT PRIMARY KEY,            -- e.g. 'trustsync:column-bank:socal'
  product             product_code NOT NULL,
  dependency          TEXT NOT NULL,               -- 'column-bank', 'streamline', 'self', etc.
  region              region_code NOT NULL DEFAULT 'all',
  state               health_state NOT NULL DEFAULT 'unknown',
  state_since         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_good_sample_at TIMESTAMPTZ,
  last_bad_sample_at  TIMESTAMPTZ,
  consecutive_good    INT NOT NULL DEFAULT 0,
  consecutive_bad     INT NOT NULL DEFAULT 0,
  last_sample_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message        TEXT,
  current_metrics     JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX health_current_product_idx ON health_current (product, state);
CREATE INDEX health_current_state_idx   ON health_current (state)
  WHERE state IN ('yellow','red');

CREATE TRIGGER health_current_updated BEFORE UPDATE ON health_current
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE health_current IS
  'Current health per (product, dependency, region). Updated by health-monitor agent after each probe. Hysteresis counters live here.';

-- -----------------------------------------------------------------------------
-- Health samples (raw probe results; fuel for hysteresis + historical trends)
-- -----------------------------------------------------------------------------

CREATE TABLE health_samples (
  sample_id           BIGSERIAL PRIMARY KEY,
  sampled_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  health_key          TEXT NOT NULL,
  product             product_code NOT NULL,
  dependency          TEXT NOT NULL,
  region              region_code NOT NULL DEFAULT 'all',
  is_good             BOOLEAN NOT NULL,
  latency_ms          INT,
  error_rate          NUMERIC,
  sample_metrics      JSONB,
  probe_type          TEXT NOT NULL,               -- 'heartbeat' | 'synthetic' | 'passive'
  message             TEXT
);

CREATE INDEX health_samples_key_time ON health_samples (health_key, sampled_at DESC);
CREATE INDEX health_samples_time     ON health_samples (sampled_at DESC);

COMMENT ON TABLE health_samples IS
  'Raw probe samples. Driven into health_current via hysteresis evaluator. Retained 90 days for trend analysis.';

-- -----------------------------------------------------------------------------
-- Daily health rollup (one row per product × day)
-- -----------------------------------------------------------------------------

CREATE TABLE health_daily_rollup (
  rollup_date         DATE NOT NULL,
  product             product_code NOT NULL,
  region              region_code NOT NULL DEFAULT 'all',
  uptime_pct          NUMERIC(5,2) NOT NULL,
  green_minutes       INT NOT NULL,
  yellow_minutes      INT NOT NULL,
  red_minutes         INT NOT NULL,
  state_transitions   INT NOT NULL DEFAULT 0,
  incidents_opened    INT NOT NULL DEFAULT 0,
  incidents_closed    INT NOT NULL DEFAULT 0,
  worst_state         health_state NOT NULL,
  notes               TEXT,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (rollup_date, product, region)
);

CREATE INDEX health_rollup_product_date ON health_daily_rollup (product, rollup_date DESC);

COMMENT ON TABLE health_daily_rollup IS
  'Daily uptime and state-time rollup per product × region. Computed nightly by health-monitor.';

-- -----------------------------------------------------------------------------
-- Health incidents (durable record when state degrades)
-- -----------------------------------------------------------------------------

CREATE TABLE health_incidents (
  incident_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  opened_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at           TIMESTAMPTZ,
  health_key          TEXT NOT NULL,
  product             product_code NOT NULL,
  dependency          TEXT NOT NULL,
  region              region_code NOT NULL DEFAULT 'all',
  opened_state        health_state NOT NULL,
  worst_state         health_state NOT NULL,
  current_state       health_state NOT NULL,
  opened_reason       TEXT NOT NULL,
  acknowledged_by     TEXT,
  acknowledged_at     TIMESTAMPTZ,
  resolution          TEXT,
  mttr_minutes        INT,
  related_alerts      UUID[] NOT NULL DEFAULT '{}',
  related_events      UUID[] NOT NULL DEFAULT '{}'
);

CREATE INDEX health_incidents_open_idx    ON health_incidents (opened_at DESC)
  WHERE closed_at IS NULL;
CREATE INDEX health_incidents_product_idx ON health_incidents (product, opened_at DESC);

COMMENT ON TABLE health_incidents IS
  'Incident record opened on state degradation, closed on return to green. MTTR computed on close.';
