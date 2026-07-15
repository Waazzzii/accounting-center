-- =============================================================================
-- 20260415000009_tiles.sql
-- Dashboard Builder: tile definitions + current state + subscription map
-- =============================================================================
-- Dashboards are composed of tiles. Each tile is a small data contract:
--   { tile_id, data_source (kpi_id or query), visualization, refresh cadence }
-- tile_state holds the latest rendered value; websocket pushes diffs to clients.
-- =============================================================================

CREATE TYPE tile_visualization AS ENUM (
  'number',         -- big single number
  'delta',          -- number with % vs prior period
  'sparkline',
  'trend_line',
  'bar',
  'stacked_bar',
  'gauge',
  'status_pill',    -- green/yellow/red
  'list',
  'table',
  'heatmap',
  'funnel',
  'timeline',
  'map'
);

CREATE TYPE tile_data_source AS ENUM (
  'kpi_snapshot',   -- read from kpi_latest / kpi_snapshots
  'query',          -- run defined SQL
  'event_stream',   -- tail events table
  'agent_output',   -- pulled from agent state
  'static'
);

CREATE TABLE tile_definitions (
  tile_id             TEXT PRIMARY KEY,            -- stable slug
  dashboard_id        TEXT NOT NULL,               -- which dashboard it belongs to
  display_name        TEXT NOT NULL,
  description         TEXT,
  visualization       tile_visualization NOT NULL,
  data_source         tile_data_source NOT NULL,
  kpi_id              TEXT,                        -- when data_source='kpi_snapshot'
  query_sql           TEXT,                        -- when data_source='query'
  event_filter        JSONB,                       -- when data_source='event_stream'
  refresh_seconds     INT NOT NULL DEFAULT 60,     -- min time between refreshes
  grid_x              INT NOT NULL DEFAULT 0,
  grid_y              INT NOT NULL DEFAULT 0,
  grid_w              INT NOT NULL DEFAULT 4,
  grid_h              INT NOT NULL DEFAULT 2,
  config              JSONB NOT NULL DEFAULT '{}'::JSONB, -- visualization-specific config
  audience_roles      TEXT[] NOT NULL DEFAULT '{}',
  region              region_code NOT NULL DEFAULT 'all',
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX tile_defs_dashboard_idx ON tile_definitions (dashboard_id) WHERE enabled;
CREATE INDEX tile_defs_kpi_idx       ON tile_definitions (kpi_id) WHERE kpi_id IS NOT NULL;

CREATE TRIGGER tile_defs_updated BEFORE UPDATE ON tile_definitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE tile_definitions IS
  'Tile layout + data contract. dashboard-builder agent reads these to render. Mobile-first grid.';

-- -----------------------------------------------------------------------------
-- tile_state: latest rendered value per tile (per region variant)
-- -----------------------------------------------------------------------------

CREATE TABLE tile_state (
  tile_id             TEXT NOT NULL REFERENCES tile_definitions(tile_id) ON DELETE CASCADE,
  region              region_code NOT NULL DEFAULT 'all',
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  value               JSONB NOT NULL,              -- payload the UI renders
  delta               JSONB,                       -- vs prior period, if applicable
  health              health_state,                -- green/yellow/red band
  narrative           TEXT,                        -- short "what it means" line
  stale               BOOLEAN NOT NULL DEFAULT FALSE,
  error               TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tile_id, region)
);

CREATE TRIGGER tile_state_updated BEFORE UPDATE ON tile_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Notify websocket fanout on state change
CREATE OR REPLACE FUNCTION notify_tile_state()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'tile_state_changed',
    json_build_object(
      'tile_id', NEW.tile_id,
      'region',  NEW.region,
      'computed_at', NEW.computed_at
    )::TEXT
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER tile_state_notify
  AFTER INSERT OR UPDATE ON tile_state
  FOR EACH ROW EXECUTE FUNCTION notify_tile_state();

COMMENT ON TABLE tile_state IS
  'Latest tile value per (tile, region). Websocket pushes diffs on change.';

-- -----------------------------------------------------------------------------
-- Dashboards (convenience grouping of tiles)
-- -----------------------------------------------------------------------------

CREATE TABLE dashboards (
  dashboard_id        TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  description         TEXT,
  primary_role        TEXT,                        -- intended audience
  layout              TEXT NOT NULL DEFAULT 'grid' -- 'grid' | 'single' | 'story'
                      CHECK (layout IN ('grid','single','story')),
  default_region      region_code NOT NULL DEFAULT 'all',
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER dashboards_updated BEFORE UPDATE ON dashboards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE dashboards IS
  'Top-level dashboard grouping. Tiles reference dashboard_id.';

-- -----------------------------------------------------------------------------
-- tile_subscription_map: which KPIs/events invalidate which tiles
-- -----------------------------------------------------------------------------

CREATE TABLE tile_subscription_map (
  subscription_id     BIGSERIAL PRIMARY KEY,
  tile_id             TEXT NOT NULL REFERENCES tile_definitions(tile_id) ON DELETE CASCADE,
  subscribes_to_kind  TEXT NOT NULL,               -- 'kpi' | 'event_type' | 'product_state'
  subscribes_to_id    TEXT NOT NULL,               -- kpi_id or event_type pattern
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tile_id, subscribes_to_kind, subscribes_to_id)
);

CREATE INDEX tile_sub_lookup_idx ON tile_subscription_map (subscribes_to_kind, subscribes_to_id);

COMMENT ON TABLE tile_subscription_map IS
  'Reverse lookup: when a KPI snapshot is written or an event fires, which tiles need to recompute? dashboard-builder uses this for efficient invalidation.';
