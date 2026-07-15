-- =============================================================================
-- 20260415000013_chargeback.sql
-- Phase 4 — Chargeback Manager: dispute intake, evidence, reserve ledger
-- =============================================================================
-- Ingests chargeback notifications from Stripe/OTAs, assembles evidence packet,
-- tracks deadlines, maintains chargeback reserve, writes reserve JEs.
-- =============================================================================

CREATE TYPE chargeback_source AS ENUM (
  'stripe',
  'airbnb_resolutions',
  'vrbo_resolutions',
  'booking_com',
  'bank_ach',
  'other'
);

CREATE TYPE chargeback_stage AS ENUM (
  'notified',
  'under_review',
  'evidence_collecting',
  'evidence_submitted',
  'awaiting_decision',
  'won',
  'lost',
  'accepted',               -- we chose not to contest
  'reversed'
);

CREATE TYPE chargeback_reason AS ENUM (
  'fraudulent',
  'not_as_described',
  'service_not_rendered',
  'duplicate',
  'credit_not_processed',
  'subscription_cancelled',
  'unrecognized',
  'other'
);

-- -----------------------------------------------------------------------------
-- Chargeback cases
-- -----------------------------------------------------------------------------

CREATE TABLE chargeback_cases (
  case_id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source              chargeback_source NOT NULL,
  external_case_id    TEXT NOT NULL,               -- Stripe dispute id, etc.
  notified_at         TIMESTAMPTZ NOT NULL,
  stage               chargeback_stage NOT NULL DEFAULT 'notified',
  reason              chargeback_reason NOT NULL DEFAULT 'other',
  reason_detail       TEXT,
  amount              NUMERIC(14,2) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'USD',
  -- Subject of dispute
  reservation_ref     TEXT,
  guest_name          TEXT,
  guest_email         TEXT,
  property_id         TEXT,
  owner_id            TEXT,
  channel             ota_channel,
  charge_date         DATE,
  -- Deadlines
  evidence_due_at     TIMESTAMPTZ,
  decision_expected_at TIMESTAMPTZ,
  decided_at          TIMESTAMPTZ,
  -- Outcome
  outcome             TEXT,                        -- 'won','lost','accepted','partial'
  recovered_amount    NUMERIC(14,2),
  final_loss          NUMERIC(14,2),
  -- State
  assigned_to         TEXT,
  auto_assembled      BOOLEAN NOT NULL DEFAULT FALSE,
  correlation_id      UUID,
  event_id            UUID REFERENCES events(event_id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, external_case_id)
);

CREATE INDEX cb_cases_stage_idx     ON chargeback_cases (stage, notified_at DESC);
CREATE INDEX cb_cases_due_idx       ON chargeback_cases (evidence_due_at)
  WHERE stage IN ('notified','under_review','evidence_collecting');
CREATE INDEX cb_cases_reservation   ON chargeback_cases (reservation_ref)
  WHERE reservation_ref IS NOT NULL;
CREATE INDEX cb_cases_owner_idx     ON chargeback_cases (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX cb_cases_channel_idx   ON chargeback_cases (channel, notified_at DESC);

CREATE TRIGGER cb_cases_updated BEFORE UPDATE ON chargeback_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE chargeback_cases IS
  'Dispute cases. Idempotent on (source, external_case_id). Deadline tracking drives escalations.';

-- -----------------------------------------------------------------------------
-- Evidence items (docs, communications, screenshots)
-- -----------------------------------------------------------------------------

CREATE TABLE chargeback_evidence (
  evidence_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id             UUID NOT NULL REFERENCES chargeback_cases(case_id) ON DELETE CASCADE,
  evidence_kind       TEXT NOT NULL,               -- 'reservation_confirmation','guest_message','check_in_log','cleaning_log','rental_agreement','screenshot','ota_policy', etc.
  title               TEXT NOT NULL,
  description         TEXT,
  storage_path        TEXT,                        -- path in object storage
  content_hash        TEXT,                        -- sha256
  source_system       TEXT,                        -- 'streamline','akia','google_drive', etc.
  collected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  collected_by        TEXT NOT NULL,
  submitted_to_source BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at        TIMESTAMPTZ,
  metadata            JSONB
);

CREATE INDEX cb_evidence_case_idx ON chargeback_evidence (case_id, collected_at DESC);
CREATE INDEX cb_evidence_kind_idx ON chargeback_evidence (evidence_kind);

COMMENT ON TABLE chargeback_evidence IS
  'Evidence items assembled for dispute response. Hashed for integrity.';

-- -----------------------------------------------------------------------------
-- Reserve ledger (trailing-90-day loss estimate → JE accrual)
-- -----------------------------------------------------------------------------

CREATE TABLE chargeback_reserves (
  reserve_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  as_of_date          DATE NOT NULL,
  region              region_code NOT NULL DEFAULT 'all',
  method              TEXT NOT NULL,               -- 'rolling_90d_loss_rate', etc.
  method_version      INT NOT NULL DEFAULT 1,
  period_gross        NUMERIC(14,2) NOT NULL,      -- revenue in lookback window
  period_losses       NUMERIC(14,2) NOT NULL,
  loss_rate           NUMERIC(6,4) NOT NULL,
  forward_gross       NUMERIC(14,2) NOT NULL,      -- expected next-period revenue
  reserve_required    NUMERIC(14,2) NOT NULL,
  current_reserve     NUMERIC(14,2) NOT NULL,
  delta               NUMERIC(14,2) GENERATED ALWAYS AS (reserve_required - current_reserve) STORED,
  je_id               UUID REFERENCES journal_entries(je_id),
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computed_by         TEXT NOT NULL DEFAULT 'chargeback-reserve-calculator',
  UNIQUE (as_of_date, region, method, method_version)
);

CREATE INDEX cb_reserves_date_idx ON chargeback_reserves (as_of_date DESC);

COMMENT ON TABLE chargeback_reserves IS
  'Monthly chargeback reserve calc. delta → JE to adjust accrued reserve liability.';

-- -----------------------------------------------------------------------------
-- Dispute outcomes → owner passthroughs (if chargeback was owner-attributable)
-- -----------------------------------------------------------------------------

CREATE TABLE chargeback_owner_impacts (
  impact_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id             UUID NOT NULL REFERENCES chargeback_cases(case_id),
  owner_id            TEXT NOT NULL,
  property_id         TEXT NOT NULL,
  impact_amount       NUMERIC(14,2) NOT NULL,
  applied_in_period   TEXT NOT NULL,               -- 'YYYY-MM'
  applied_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  statement_line_ref  TEXT,
  je_id               UUID REFERENCES journal_entries(je_id),
  reason              TEXT NOT NULL,
  approved_by         TEXT NOT NULL,
  notes               TEXT
);

CREATE INDEX cb_owner_impact_owner_idx ON chargeback_owner_impacts (owner_id, applied_at DESC);
CREATE INDEX cb_owner_impact_case_idx  ON chargeback_owner_impacts (case_id);

COMMENT ON TABLE chargeback_owner_impacts IS
  'When a dispute loss flows through to an owner (cleaning damage dispute, etc.), record it for statement transparency.';
