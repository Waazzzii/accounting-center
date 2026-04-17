-- =============================================================================
-- 20260415000011_otaauditor.sql
-- Phase 2 — OTAAuditor: OTA payout reconciliation (Airbnb, VRBO, Booking.com)
-- =============================================================================
-- Ingests payout reports from OTA channels, matches line items to reservations
-- in Streamline, variance-checks vs expected earnings, produces payout
-- reconciliation packet that feeds RevPost.
-- =============================================================================

CREATE TYPE ota_channel AS ENUM (
  'airbnb',
  'vrbo',
  'booking_com',
  'direct',
  'other'
);

CREATE TYPE payout_status AS ENUM (
  'ingested',
  'parsing',
  'matched',
  'partial_match',
  'unmatched',
  'variance_flagged',
  'reconciled',
  'finalized',
  'disputed'
);

-- -----------------------------------------------------------------------------
-- Raw payout reports ingested from OTAs
-- -----------------------------------------------------------------------------

CREATE TABLE ota_payout_reports (
  report_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel             ota_channel NOT NULL,
  report_period_start DATE NOT NULL,
  report_period_end   DATE NOT NULL,
  payout_date         DATE NOT NULL,
  gross_amount        NUMERIC(14,2) NOT NULL,
  fees_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  adjustments_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_amount          NUMERIC(14,2) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'USD',
  line_item_count     INT NOT NULL DEFAULT 0,
  source_file_path    TEXT,                        -- original PDF/CSV in storage
  source_file_hash    TEXT,                        -- sha256 for dedup
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ingested_by         TEXT NOT NULL DEFAULT 'ota-payout-ingester',
  status              payout_status NOT NULL DEFAULT 'ingested',
  region              region_code,
  bank_account_id     TEXT,                        -- which account received the deposit
  bank_transaction_id TEXT,                        -- matched Column Bank txn
  UNIQUE (channel, source_file_hash)
);

CREATE INDEX ota_reports_channel_date ON ota_payout_reports (channel, payout_date DESC);
CREATE INDEX ota_reports_status_idx   ON ota_payout_reports (status, payout_date DESC);
CREATE INDEX ota_reports_bank_txn_idx ON ota_payout_reports (bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;

COMMENT ON TABLE ota_payout_reports IS
  'Raw payout report per OTA channel per payout. Idempotent on (channel, source_file_hash).';

-- -----------------------------------------------------------------------------
-- Line items (reservation-level) parsed from reports
-- -----------------------------------------------------------------------------

CREATE TABLE ota_payout_line_items (
  line_item_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_id           UUID NOT NULL REFERENCES ota_payout_reports(report_id) ON DELETE CASCADE,
  channel             ota_channel NOT NULL,
  ota_confirmation    TEXT,                        -- e.g. Airbnb confirmation code
  guest_name          TEXT,
  property_ref        TEXT,                        -- channel's property identifier
  check_in            DATE,
  check_out           DATE,
  nights              INT,
  gross_amount        NUMERIC(14,2) NOT NULL,
  channel_fee         NUMERIC(14,2) NOT NULL DEFAULT 0,
  taxes_collected     NUMERIC(14,2) NOT NULL DEFAULT 0,
  taxes_remitted      NUMERIC(14,2) NOT NULL DEFAULT 0,
  cleaning_fee        NUMERIC(14,2),
  resort_fee          NUMERIC(14,2),
  other_fees          JSONB,
  net_amount          NUMERIC(14,2) NOT NULL,
  adjustment_kind     TEXT,                        -- 'refund','cancellation_fee','host_fee', etc.
  raw_row             JSONB NOT NULL,              -- original parsed row
  -- Matching state
  match_status        TEXT NOT NULL DEFAULT 'unmatched'
                      CHECK (match_status IN ('unmatched','matched','fuzzy_matched','no_reservation','ambiguous','manually_matched')),
  streamline_reservation_id TEXT,
  match_confidence    NUMERIC CHECK (match_confidence BETWEEN 0 AND 1),
  match_reason        TEXT,
  expected_net        NUMERIC(14,2),
  variance            NUMERIC(14,2) GENERATED ALWAYS AS (net_amount - expected_net) STORED,
  variance_flagged    BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by         TEXT,
  reviewed_at         TIMESTAMPTZ
);

CREATE INDEX ota_li_report_idx       ON ota_payout_line_items (report_id);
CREATE INDEX ota_li_conf_idx         ON ota_payout_line_items (channel, ota_confirmation);
CREATE INDEX ota_li_reservation_idx  ON ota_payout_line_items (streamline_reservation_id)
  WHERE streamline_reservation_id IS NOT NULL;
CREATE INDEX ota_li_variance_idx     ON ota_payout_line_items (report_id)
  WHERE variance_flagged;

COMMENT ON TABLE ota_payout_line_items IS
  'Per-reservation rows from a payout report. Matched to Streamline reservations; variance flagged for review.';

-- -----------------------------------------------------------------------------
-- Reconciliation packets (the handoff to RevPost)
-- -----------------------------------------------------------------------------

CREATE TABLE ota_reconciliation_packets (
  packet_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_id           UUID NOT NULL REFERENCES ota_payout_reports(report_id),
  finalized_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_by        TEXT NOT NULL,
  total_gross         NUMERIC(14,2) NOT NULL,
  total_net           NUMERIC(14,2) NOT NULL,
  matched_count       INT NOT NULL,
  unmatched_count     INT NOT NULL,
  variance_count      INT NOT NULL,
  total_variance      NUMERIC(14,2) NOT NULL,
  ready_for_revpost   BOOLEAN NOT NULL DEFAULT FALSE,
  revpost_handoff_at  TIMESTAMPTZ,
  correlation_id      UUID,
  notes               TEXT
);

CREATE INDEX ota_packets_report_idx   ON ota_reconciliation_packets (report_id);
CREATE INDEX ota_packets_handoff_idx  ON ota_reconciliation_packets (ready_for_revpost, finalized_at)
  WHERE ready_for_revpost AND revpost_handoff_at IS NULL;

COMMENT ON TABLE ota_reconciliation_packets IS
  'Finalized reconciled payout ready for RevPost to turn into journal entries.';

-- -----------------------------------------------------------------------------
-- Channel fee catalog (expected fee % by channel / contract)
-- -----------------------------------------------------------------------------

CREATE TABLE ota_channel_fees (
  channel             ota_channel NOT NULL,
  fee_type            TEXT NOT NULL,               -- 'host_fee', 'guest_fee', 'payment_processing'
  effective_from      DATE NOT NULL,
  effective_to        DATE,
  percentage          NUMERIC(6,4),                -- 0.0300 = 3%
  flat_amount         NUMERIC(14,2),
  notes               TEXT,
  PRIMARY KEY (channel, fee_type, effective_from)
);

COMMENT ON TABLE ota_channel_fees IS
  'Expected fee schedules per channel. Used to compute expected_net for variance detection.';
