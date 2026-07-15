-- =============================================================================
-- 20260420000001_ota_match_schema.sql
-- Phase 2 — OTAAuditor: tables for 3-way matching
-- =============================================================================
-- Extends the existing ota_payout_reports + ota_payout_line_items + channel_fees
-- tables with the bank + GL + match + exception layers needed for the
-- 3-way match (OTA payout ↔ bank deposit ↔ Sage GL posting).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Classification enum for bank_deposits (what kind of transaction)
-- -----------------------------------------------------------------------------

CREATE TYPE bank_deposit_classification AS ENUM (
  'ota_deposit',             -- definitely an OTA payout
  'possible_ota_deposit',    -- looks like OTA but uncertain
  'merchant_deposit',        -- direct booking merchant processor (Stripe / Lynnbrook)
  'internal_transfer',       -- between our own accounts
  'owner_distribution',      -- owner payout outbound (shouldn't appear as a credit)
  'refund',                  -- refund issued
  'fee',                     -- bank/processor fee
  'unknown'                  -- needs classification
);

-- -----------------------------------------------------------------------------
-- Bank deposits — every credit/debit we observe in any bank account we watch.
-- Sourced from: Column Bank API (future), CSV import (today), manual entry.
-- -----------------------------------------------------------------------------

CREATE TABLE bank_deposits (
  deposit_id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_system             TEXT NOT NULL,              -- 'column_bank' | 'csv_import' | 'manual'
  bank_name                 TEXT,                        -- 'Column' | 'BofA' | 'Chase' | ...
  bank_account_id           TEXT NOT NULL,               -- external account id or last4
  bank_account_label        TEXT,                        -- e.g., "Coachella Valley Operating"
  bank_transaction_id       TEXT NOT NULL,               -- external txn id (unique per source)
  deposit_date              DATE NOT NULL,
  amount                    NUMERIC(14,2) NOT NULL,      -- positive = credit, negative = debit
  currency                  TEXT NOT NULL DEFAULT 'USD',
  memo                      TEXT,                        -- bank-provided memo / description
  counterparty              TEXT,                        -- e.g., "AIRBNB PAYOUT"
  -- Classification
  classification            bank_deposit_classification NOT NULL DEFAULT 'unknown',
  classification_confidence NUMERIC(4,2) CHECK (classification_confidence BETWEEN 0 AND 1),
  ota_source                ota_channel,                 -- if classified as OTA
  ota_source_confidence     NUMERIC(4,2) CHECK (ota_source_confidence BETWEEN 0 AND 1),
  -- Matching state (see ota_matches for the actual match record)
  match_status              TEXT NOT NULL DEFAULT 'unmatched'
                            CHECK (match_status IN ('unmatched','matched','partial_match','excluded','under_review')),
  match_id                  UUID,                        -- populated after match, soft FK to ota_matches
  -- Geography
  region                    region_code,
  market                    market_code,
  -- Audit
  raw_data                  JSONB NOT NULL,              -- original source row (CSV, API response, etc.)
  source_file_hash          TEXT,                        -- if CSV-imported, sha256 of source file
  ingested_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ingested_by               TEXT NOT NULL,               -- agent slug / user
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_system, bank_transaction_id)
);

CREATE INDEX bd_date_idx           ON bank_deposits (deposit_date DESC);
CREATE INDEX bd_classification_idx ON bank_deposits (classification, deposit_date DESC);
CREATE INDEX bd_ota_source_idx     ON bank_deposits (ota_source, deposit_date DESC)
  WHERE ota_source IS NOT NULL;
CREATE INDEX bd_match_status_idx   ON bank_deposits (match_status, deposit_date DESC)
  WHERE match_status = 'unmatched';
CREATE INDEX bd_market_idx         ON bank_deposits (market, deposit_date DESC);

CREATE TRIGGER bd_updated BEFORE UPDATE ON bank_deposits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE bank_deposits IS
  'All bank transactions we watch. Sourced from Column Bank API (future) or CSV imports from existing bank (today). match_status is the header; ota_matches is the join table.';

-- -----------------------------------------------------------------------------
-- OTA matches — the 3-way match record itself.
--   payout_ids[] and deposit_ids[] use arrays to support split / batched cases:
--     1-to-1    : one payout, one deposit (typical)
--     1-to-N    : one payout split across multiple deposits
--     N-to-1    : multiple payouts batched into one deposit
--     N-to-M    : rare, but the schema allows it
-- -----------------------------------------------------------------------------

CREATE TABLE ota_matches (
  match_id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_type           TEXT NOT NULL
                       CHECK (match_type IN ('exact','fuzzy_high','fuzzy_medium','split_payout','batched_deposit','manually_matched')),
  confidence           INT NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  -- The two sides of the match
  payout_ids           UUID[] NOT NULL,                 -- ota_payout_reports.report_id
  deposit_ids          UUID[] NOT NULL,                 -- bank_deposits.deposit_id
  -- Financial reconciliation fields
  total_payout_amount  NUMERIC(14,2) NOT NULL,
  total_deposit_amount NUMERIC(14,2) NOT NULL,
  variance_amount      NUMERIC(14,2) GENERATED ALWAYS AS (total_deposit_amount - total_payout_amount) STORED,
  variance_pct         NUMERIC(6,4),                    -- signed; computed at insert time
  variance_date_days   INT,                              -- max payout.settlement_date − deposit.deposit_date diff
  -- Reasoning trail — every match carries a narrative
  reasoning            TEXT NOT NULL,
  score_breakdown      JSONB,                            -- {amount_var: 3, date_var: 2, ota_match: +0, ...}
  -- GL verification (gl-verifier fills this in)
  gl_verified          BOOLEAN NOT NULL DEFAULT FALSE,
  gl_posting_id        UUID,                             -- soft FK to ota_gl_postings
  gl_verified_at       TIMESTAMPTZ,
  -- Review state
  auto_verified        BOOLEAN NOT NULL DEFAULT FALSE,   -- confidence ≥ 95
  requires_review      BOOLEAN NOT NULL DEFAULT FALSE,   -- confidence 80-94 OR split/batched
  reviewed_by          TEXT,
  reviewed_at          TIMESTAMPTZ,
  review_decision      TEXT CHECK (review_decision IN ('approved','rejected','escalated','needs_info')),
  review_notes         TEXT,
  -- Geography
  region               region_code,
  market               market_code,
  -- Lifecycle
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           TEXT NOT NULL DEFAULT 'matching-engine',
  correlation_id       TEXT,
  -- Idempotency: same (sorted payout_ids + sorted deposit_ids) shouldn't dupe
  match_fingerprint    TEXT NOT NULL,                   -- sha256 of sorted(payout_ids) || sorted(deposit_ids)
  UNIQUE (match_fingerprint)
);

CREATE INDEX om_created_idx      ON ota_matches (created_at DESC);
CREATE INDEX om_match_type_idx   ON ota_matches (match_type, confidence DESC);
CREATE INDEX om_review_idx       ON ota_matches (requires_review, created_at DESC)
  WHERE requires_review AND reviewed_at IS NULL;
CREATE INDEX om_gl_verify_idx    ON ota_matches (gl_verified, created_at DESC)
  WHERE NOT gl_verified;
CREATE INDEX om_market_idx       ON ota_matches (market, created_at DESC);
-- GIN index on payout_ids array for reverse lookup ("what match is this payout in?")
CREATE INDEX om_payout_ids_gin   ON ota_matches USING gin (payout_ids);
CREATE INDEX om_deposit_ids_gin  ON ota_matches USING gin (deposit_ids);

CREATE TRIGGER om_updated BEFORE UPDATE ON ota_matches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ota_matches IS
  'The core match record. Each row links one or more OTA payouts to one or more bank deposits with a confidence score and reasoning trail. GL verification happens downstream.';

-- -----------------------------------------------------------------------------
-- OTA unmatched — items we could NOT match, categorized by age + severity
-- -----------------------------------------------------------------------------

CREATE TABLE ota_unmatched (
  unmatched_id    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('payout','deposit')),
  entity_id       UUID NOT NULL,                       -- FK to ota_payout_reports OR bank_deposits (soft)
  category        TEXT NOT NULL
                  CHECK (category IN (
                    'timing_variance','unmatched_payout','missing_deposit',
                    'unmatched_deposit','unknown_source_deposit','duplicate_suspected',
                    'amount_mismatch','cross_market_suspected'
                  )),
  severity        severity NOT NULL,                    -- info | warn | error | critical (shared enum)
  age_days        INT NOT NULL,
  reason          TEXT NOT NULL,
  -- Lifecycle
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  resolution_type TEXT CHECK (resolution_type IN ('matched','written_off','manual_intervention','invalid_data','duplicate_confirmed')),
  resolution_match_id UUID,                             -- if resolved by a match, point at it
  resolution_notes TEXT,
  assigned_to     TEXT,                                 -- role id from role-matrix
  -- Geography
  region          region_code,
  market          market_code,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ou_open_idx           ON ota_unmatched (detected_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX ou_severity_idx       ON ota_unmatched (severity, detected_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX ou_entity_idx         ON ota_unmatched (entity_type, entity_id);
CREATE INDEX ou_market_idx         ON ota_unmatched (market, detected_at DESC)
  WHERE resolved_at IS NULL;

CREATE TRIGGER ou_updated BEFORE UPDATE ON ota_unmatched
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ota_unmatched IS
  'Payouts or deposits we could not match. Categorized by why and how old. Drives the daily aging review + exception alerts.';

-- -----------------------------------------------------------------------------
-- OTA GL postings — what Sage Intacct says about this OTA revenue event.
-- gl-verifier writes these after querying Sage for the matching journal entry.
-- -----------------------------------------------------------------------------

CREATE TABLE ota_gl_postings (
  gl_posting_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id             UUID REFERENCES ota_matches(match_id) ON DELETE CASCADE,
  -- Sage identifiers
  sage_je_number       TEXT NOT NULL UNIQUE,
  sage_batch_id        TEXT,
  posting_date         DATE NOT NULL,
  entity_id            TEXT,                           -- Sage entity dimension
  location_id          TEXT,                           -- Sage location dimension
  class_id             TEXT,                           -- Sage class dimension (for market)
  -- JE lines
  dr_accounts          JSONB NOT NULL,                 -- [{account, amount, memo}, ...]
  cr_accounts          JSONB NOT NULL,
  total_amount         NUMERIC(14,2) NOT NULL,
  -- Verification results
  verified             BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at          TIMESTAMPTZ,
  variance_vs_payout   NUMERIC(14,2),                  -- JE total − payout total
  variance_vs_deposit  NUMERIC(14,2),                  -- JE total − deposit total
  verification_notes   TEXT,
  -- Source
  raw_sage_response    JSONB,
  pulled_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pulled_by            TEXT NOT NULL DEFAULT 'gl-verifier',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ogp_match_idx      ON ota_gl_postings (match_id);
CREATE INDEX ogp_posting_date   ON ota_gl_postings (posting_date DESC);
CREATE INDEX ogp_verified_idx   ON ota_gl_postings (verified, posting_date DESC);

COMMENT ON TABLE ota_gl_postings IS
  'Sage Intacct JE snapshots for an OTA revenue event. Populated by gl-verifier. Closes the 3-way match: payout ↔ deposit ↔ GL.';

-- -----------------------------------------------------------------------------
-- Exception queue — human-actionable items from the match pipeline
-- -----------------------------------------------------------------------------

CREATE TABLE ota_match_exceptions (
  exception_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exception_type       TEXT NOT NULL
                       CHECK (exception_type IN (
                         'variance_threshold','stale_unmatched','duplicate_suspected',
                         'gl_mismatch','gl_missing','wrong_gl_account','wrong_entity',
                         'fx_conversion_variance','owner_statement_risk'
                       )),
  severity             severity NOT NULL,
  summary              TEXT NOT NULL,
  detail               JSONB NOT NULL,                 -- full context for the reviewer
  -- Pointers
  related_payout_id    UUID REFERENCES ota_payout_reports(report_id) ON DELETE SET NULL,
  related_deposit_id   UUID REFERENCES bank_deposits(deposit_id) ON DELETE SET NULL,
  related_match_id     UUID REFERENCES ota_matches(match_id) ON DELETE SET NULL,
  related_unmatched_id UUID REFERENCES ota_unmatched(unmatched_id) ON DELETE SET NULL,
  -- SLA + routing
  detected_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_to          TEXT,                           -- role_id (audrey | jocelyn | kimberly | coo)
  status               TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','acknowledged','in_progress','resolved','escalated','dismissed')),
  ack_at               TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  resolution_notes     TEXT,
  -- Geography
  region               region_code,
  market               market_code,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ome_open_idx       ON ota_match_exceptions (status, detected_at DESC)
  WHERE status IN ('open','acknowledged','in_progress');
CREATE INDEX ome_severity_idx   ON ota_match_exceptions (severity, detected_at DESC)
  WHERE status != 'resolved' AND status != 'dismissed';
CREATE INDEX ome_assigned_idx   ON ota_match_exceptions (assigned_to, detected_at DESC);
CREATE INDEX ome_type_idx       ON ota_match_exceptions (exception_type, detected_at DESC);
CREATE INDEX ome_market_idx     ON ota_match_exceptions (market, detected_at DESC);

CREATE TRIGGER ome_updated BEFORE UPDATE ON ota_match_exceptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE ota_match_exceptions IS
  'Human-actionable exceptions from the 3-way match pipeline. Routes to Audrey / Jocelyn / Kimberly by severity + type.';

-- -----------------------------------------------------------------------------
-- Realtime — matching-engine subscribes to bank_deposits and payout_reports
-- to trigger match runs; exception-manager subscribes to unmatched inserts.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'public.bank_deposits', 'public.ota_matches', 'public.ota_unmatched',
    'public.ota_gl_postings', 'public.ota_match_exceptions'
  ]) LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %s', t);
    EXCEPTION
      WHEN duplicate_object THEN NULL;
      WHEN undefined_table  THEN NULL;
    END;
  END LOOP;
END $$;
