-- =============================================================================
-- 20260415000008_reports.sql
-- Cross-Product Reporter: generated reports + distribution log
-- =============================================================================

CREATE TYPE report_cadence AS ENUM (
  'weekly',        -- Mon 07:30 PT
  'monthly',       -- BD+2 noon
  'quarterly',
  'on_demand'
);

CREATE TYPE report_format AS ENUM (
  'markdown',
  'html',
  'pdf',
  'slack',
  'email'
);

CREATE TABLE report_templates (
  template_id         TEXT PRIMARY KEY,            -- 'weekly-ops-digest', 'monthly-close-brief', etc.
  display_name        TEXT NOT NULL,
  description         TEXT,
  cadence             report_cadence NOT NULL,
  owning_agent        TEXT NOT NULL DEFAULT 'cross-product-reporter',
  section_spec        JSONB NOT NULL,              -- ordered sections, KPIs, narrative prompts
  kpi_refs            TEXT[] NOT NULL DEFAULT '{}', -- kpi_ids required
  audience_roles      TEXT[] NOT NULL DEFAULT '{}',
  default_format      report_format NOT NULL DEFAULT 'markdown',
  schedule_cron       TEXT,                        -- pg_cron expression
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER report_templates_updated BEFORE UPDATE ON report_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE report_templates IS
  'Report definitions. section_spec drives LLM narrative generation. Citations to kpi_snapshots are required.';

-- -----------------------------------------------------------------------------
-- Generated reports (immutable once delivered)
-- -----------------------------------------------------------------------------

CREATE TABLE reports_generated (
  report_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id         TEXT NOT NULL REFERENCES report_templates(template_id),
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_start        TIMESTAMPTZ NOT NULL,
  period_end          TIMESTAMPTZ NOT NULL,
  format              report_format NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,               -- rendered report
  body_hash           TEXT NOT NULL,               -- sha256 for dedup/integrity
  kpi_snapshot_ids    BIGINT[] NOT NULL DEFAULT '{}', -- snapshots cited
  citations           JSONB NOT NULL DEFAULT '[]'::JSONB, -- [{kpi_id, snapshot_id, value}]
  generated_by        TEXT NOT NULL DEFAULT 'cross-product-reporter',
  llm_model           TEXT,
  llm_tokens_input    INT,
  llm_tokens_output   INT,
  status              TEXT NOT NULL DEFAULT 'draft' -- 'draft' | 'delivered' | 'archived'
                      CHECK (status IN ('draft','delivered','archived')),
  delivered_at        TIMESTAMPTZ,
  correlation_id      UUID
);

CREATE INDEX reports_template_time_idx ON reports_generated (template_id, generated_at DESC);
CREATE INDEX reports_period_idx        ON reports_generated (period_end DESC);
CREATE INDEX reports_body_hash_idx     ON reports_generated (body_hash);

-- Forbid edits once delivered
CREATE OR REPLACE FUNCTION protect_delivered_report()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'delivered' AND TG_OP = 'UPDATE'
     AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.title IS DISTINCT FROM OLD.title) THEN
    RAISE EXCEPTION 'delivered report % is immutable', OLD.report_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reports_protect BEFORE UPDATE ON reports_generated
  FOR EACH ROW EXECUTE FUNCTION protect_delivered_report();

COMMENT ON TABLE reports_generated IS
  'Generated report artifacts. Immutable once status=delivered. Citations link back to kpi_snapshots.';

-- -----------------------------------------------------------------------------
-- Report distributions (who got what, when)
-- -----------------------------------------------------------------------------

CREATE TABLE report_distributions (
  distribution_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_id           UUID NOT NULL REFERENCES reports_generated(report_id),
  recipient_role      TEXT,
  recipient_email     TEXT,
  recipient_slack     TEXT,
  channel             TEXT NOT NULL,               -- 'email' | 'slack' | 'download'
  dispatched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at        TIMESTAMPTZ,
  opened_at           TIMESTAMPTZ,
  error_message       TEXT
);

CREATE INDEX report_dist_report_idx ON report_distributions (report_id);
CREATE INDEX report_dist_time_idx   ON report_distributions (dispatched_at DESC);

COMMENT ON TABLE report_distributions IS
  'Per-recipient delivery log. One report → N distributions. Tracks open state where available.';
