-- =============================================================================
-- 20260415000003_kpi.sql
-- KPI definitions (versioned formulas) + immutable snapshots
-- =============================================================================
-- Every metric in the Accounting Center flows through this pair of tables.
-- kpi_definitions: the formula (versioned, immutable once published).
-- kpi_snapshots:   a computed value at a point in time (immutable once written).
--
-- No agent writes a metric directly to a dashboard — everything comes from
-- kpi_snapshots so we have one source of truth and full replay capability.
-- =============================================================================

CREATE TYPE kpi_unit AS ENUM (
  'usd',
  'count',
  'percent',
  'days',
  'hours',
  'minutes',
  'ratio',
  'bool',
  'score'          -- composite 0..100
);

CREATE TYPE kpi_cadence AS ENUM (
  'realtime',      -- recomputed on event
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'on_demand'
);

CREATE TYPE kpi_tier AS ENUM (
  'operational',   -- Tier 1: frontline health, minute-to-hour cadence
  'tactical',      -- Tier 2: product performance, day-to-week cadence
  'strategic'      -- Tier 3: business outcomes, week-to-quarter cadence
);

-- -----------------------------------------------------------------------------
-- KPI definitions. Immutable once published; new versions supersede prior.
-- -----------------------------------------------------------------------------

CREATE TABLE kpi_definitions (
  kpi_id              TEXT NOT NULL,               -- stable slug, e.g. 'trustsync.transfer.cycle_time_hours'
  version             INT  NOT NULL,
  display_name        TEXT NOT NULL,
  description         TEXT NOT NULL,
  product             product_code NOT NULL,
  tier                kpi_tier NOT NULL,
  unit                kpi_unit NOT NULL,
  cadence             kpi_cadence NOT NULL,
  formula             TEXT NOT NULL,               -- SQL expression or DSL reference
  formula_language    TEXT NOT NULL DEFAULT 'sql', -- 'sql' | 'typescript' | 'pseudocode'
  source_tables       TEXT[] NOT NULL DEFAULT '{}',
  target_green        NUMERIC,                     -- threshold for green health
  target_yellow       NUMERIC,                     -- threshold for yellow health
  target_direction    TEXT NOT NULL DEFAULT 'higher_is_better'
                      CHECK (target_direction IN ('higher_is_better','lower_is_better','band')),
  band_low            NUMERIC,                     -- used when target_direction='band'
  band_high           NUMERIC,
  owner_role          TEXT NOT NULL,               -- who's accountable
  published_at        TIMESTAMPTZ,
  published_by        TEXT,
  superseded_by       INT,                         -- version that replaced this one
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tags                TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (kpi_id, version)
);

CREATE INDEX kpi_definitions_product_idx ON kpi_definitions (product, tier);
CREATE INDEX kpi_definitions_published_idx ON kpi_definitions (kpi_id, version DESC)
  WHERE published_at IS NOT NULL;

-- Forbid edits to published definitions (create a new version instead).
CREATE OR REPLACE FUNCTION protect_published_kpi()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.published_at IS NOT NULL AND TG_OP = 'UPDATE' THEN
    -- Only superseded_by can change on a published row
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      IF NEW.superseded_by IS DISTINCT FROM OLD.superseded_by
         AND (NEW.kpi_id, NEW.version, NEW.display_name, NEW.description,
              NEW.formula, NEW.target_green, NEW.target_yellow) IS NOT DISTINCT FROM
             (OLD.kpi_id, OLD.version, OLD.display_name, OLD.description,
              OLD.formula, OLD.target_green, OLD.target_yellow) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'published KPI definition %:v% is immutable. Create a new version.',
        OLD.kpi_id, OLD.version;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kpi_definitions_protect BEFORE UPDATE ON kpi_definitions
  FOR EACH ROW EXECUTE FUNCTION protect_published_kpi();

COMMENT ON TABLE kpi_definitions IS
  'Versioned KPI formulas. Immutable once published. New changes require a new version and supersede prior.';

-- -----------------------------------------------------------------------------
-- KPI snapshots. Immutable once written.
-- -----------------------------------------------------------------------------

CREATE TABLE kpi_snapshots (
  snapshot_id         BIGSERIAL PRIMARY KEY,
  kpi_id              TEXT NOT NULL,
  kpi_version         INT  NOT NULL,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_start        TIMESTAMPTZ NOT NULL,
  period_end          TIMESTAMPTZ NOT NULL,
  value_numeric       NUMERIC,                     -- primary numeric value
  value_bool          BOOLEAN,
  value_text          TEXT,
  value_json          JSONB,                       -- breakdowns, components
  dimensions          JSONB NOT NULL DEFAULT '{}'::JSONB,  -- {region, market, product, ...}
  sample_size         BIGINT,                      -- rows that went into the calc
  confidence          NUMERIC CHECK (confidence BETWEEN 0 AND 1),
  source_query_hash   TEXT,                        -- sha256 of query text
  source_event_id     UUID REFERENCES events(event_id),
  computed_by         TEXT NOT NULL DEFAULT 'kpi-computer',
  run_id              UUID,                        -- groups snapshots from same compute run
  FOREIGN KEY (kpi_id, kpi_version) REFERENCES kpi_definitions (kpi_id, version)
);

CREATE INDEX kpi_snapshots_id_time_idx  ON kpi_snapshots (kpi_id, computed_at DESC);
CREATE INDEX kpi_snapshots_period_idx   ON kpi_snapshots (kpi_id, period_end DESC);
CREATE INDEX kpi_snapshots_dimensions   ON kpi_snapshots USING gin (dimensions jsonb_path_ops);
CREATE INDEX kpi_snapshots_run_idx      ON kpi_snapshots (run_id) WHERE run_id IS NOT NULL;

-- Snapshots are immutable.
CREATE OR REPLACE FUNCTION forbid_kpi_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'kpi_snapshots is immutable (attempted %)', TG_OP;
END;
$$;

CREATE TRIGGER kpi_snapshots_no_update BEFORE UPDATE ON kpi_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_kpi_mutation();
CREATE TRIGGER kpi_snapshots_no_delete BEFORE DELETE ON kpi_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_kpi_mutation();

COMMENT ON TABLE kpi_snapshots IS
  'Immutable point-in-time metric values. Single source of truth for dashboards, alerts, and reporting.';

-- -----------------------------------------------------------------------------
-- Latest-snapshot convenience view
-- -----------------------------------------------------------------------------

CREATE VIEW kpi_latest AS
SELECT DISTINCT ON (kpi_id, dimensions)
  kpi_id,
  kpi_version,
  computed_at,
  period_start,
  period_end,
  value_numeric,
  value_bool,
  value_text,
  value_json,
  dimensions,
  sample_size,
  confidence
FROM kpi_snapshots
ORDER BY kpi_id, dimensions, computed_at DESC;

COMMENT ON VIEW kpi_latest IS
  'Latest snapshot per (kpi_id, dimensions). Use for dashboards that need "current value".';
