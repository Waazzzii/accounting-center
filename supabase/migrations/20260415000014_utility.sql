-- =============================================================================
-- 20260415000014_utility.sql
-- Phase 5 — Utility Bill Manager: bill intake → repeat/new owner handling →
--           owner credit posting
-- =============================================================================
-- ACME fronts utility bills (power, water, gas, internet) on owner properties,
-- then passes through to owners via statement credits. This phase:
--   1. Ingests bills from email/upload
--   2. Matches to property + owner
--   3. Classifies: repeat owner (auto-apply) vs new owner (notify first)
--   4. Produces owner-credit JE payloads → RevPost
-- =============================================================================

CREATE TYPE utility_kind AS ENUM (
  'electricity',
  'gas',
  'water',
  'sewer',
  'trash',
  'internet',
  'tv_streaming',
  'security_monitoring',
  'pool_service',
  'landscape',
  'pest_control',
  'hoa',
  'other'
);

CREATE TYPE utility_bill_status AS ENUM (
  'ingested',
  'parsing',
  'parsed',
  'matched',
  'unmatched',
  'awaiting_owner_notification',
  'pending_approval',
  'approved',
  'applied',
  'disputed',
  'written_off',
  'void'
);

CREATE TYPE utility_owner_mode AS ENUM (
  'auto_repeat',            -- owner has approved recurring auto-apply
  'auto_trusted',
  'building_trust',         -- new owner; notify + wait for first approval
  'human_all',              -- every bill goes to owner for approval
  'opt_out'                 -- owner pays directly; do not apply
);

-- -----------------------------------------------------------------------------
-- Vendors (PG&E, Cox, SRP, etc.)
-- -----------------------------------------------------------------------------

CREATE TABLE utility_vendors (
  vendor_id           TEXT PRIMARY KEY,            -- stable slug
  display_name        TEXT NOT NULL,
  utility_kind        utility_kind NOT NULL,
  region              region_code,
  ap_vendor_id        TEXT,                        -- Ramp/Intacct vendor id
  default_memo_prefix TEXT,
  ingest_mailbox      TEXT,                        -- email we pull from
  parser_version      TEXT,
  notes               TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER utility_vendors_updated BEFORE UPDATE ON utility_vendors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE utility_vendors IS
  'Utility vendor catalog. Drives parser selection and AP linkage.';

-- -----------------------------------------------------------------------------
-- Bills
-- -----------------------------------------------------------------------------

CREATE TABLE utility_bills (
  bill_id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id           TEXT NOT NULL REFERENCES utility_vendors(vendor_id),
  account_number      TEXT,                        -- vendor-side account number
  service_address     TEXT,
  service_period_start DATE,
  service_period_end  DATE,
  bill_date           DATE NOT NULL,
  due_date            DATE,
  amount              NUMERIC(14,2) NOT NULL,
  previous_balance    NUMERIC(14,2),
  current_charges     NUMERIC(14,2),
  late_fees           NUMERIC(14,2) NOT NULL DEFAULT 0,
  usage_quantity      NUMERIC(14,4),
  usage_unit          TEXT,
  source_file_path    TEXT,
  source_file_hash    TEXT,
  parsed_payload      JSONB,
  -- Matching
  property_id         TEXT,
  owner_id            TEXT,
  region              region_code,
  market              market_code,
  match_confidence    NUMERIC CHECK (match_confidence BETWEEN 0 AND 1),
  match_reason        TEXT,
  -- State
  status              utility_bill_status NOT NULL DEFAULT 'ingested',
  owner_mode_at_intake utility_owner_mode,
  idempotency_key     TEXT NOT NULL UNIQUE,        -- sha256(vendor|account|service_period|amount)
  approval_id         UUID REFERENCES approvals(approval_id),
  applied_je_id       UUID REFERENCES journal_entries(je_id),
  correlation_id      UUID,
  event_id            UUID REFERENCES events(event_id),
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ingested_by         TEXT NOT NULL DEFAULT 'utility-bill-ingester',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX utility_bills_status_idx     ON utility_bills (status, bill_date DESC);
CREATE INDEX utility_bills_owner_idx      ON utility_bills (owner_id, bill_date DESC) WHERE owner_id IS NOT NULL;
CREATE INDEX utility_bills_property_idx   ON utility_bills (property_id, bill_date DESC) WHERE property_id IS NOT NULL;
CREATE INDEX utility_bills_vendor_idx     ON utility_bills (vendor_id, bill_date DESC);
CREATE INDEX utility_bills_due_idx        ON utility_bills (due_date)
  WHERE status NOT IN ('applied','void','written_off');

CREATE TRIGGER utility_bills_updated BEFORE UPDATE ON utility_bills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE utility_bills IS
  'Utility bills ACME fronts on behalf of owners. Idempotent on vendor+account+period+amount.';

-- -----------------------------------------------------------------------------
-- Owner utility preferences (maturity mode + auto-apply policy)
-- -----------------------------------------------------------------------------

CREATE TABLE utility_owner_preferences (
  owner_id            TEXT NOT NULL,
  property_id         TEXT,                        -- NULL = applies to all owner's properties
  utility_kind        utility_kind,                -- NULL = applies to all kinds
  mode                utility_owner_mode NOT NULL DEFAULT 'building_trust',
  max_auto_amount     NUMERIC(14,2),               -- auto-apply ceiling
  notify_email        TEXT,
  notify_sms          TEXT,
  consecutive_auto_count INT NOT NULL DEFAULT 0,
  last_auto_at        TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, COALESCE(property_id, ''), COALESCE(utility_kind::TEXT, ''))
);

CREATE TRIGGER utility_owner_prefs_updated BEFORE UPDATE ON utility_owner_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE utility_owner_preferences IS
  'Per-owner (optional: per-property, per-kind) auto-apply policy. Most-specific row wins.';

-- -----------------------------------------------------------------------------
-- Variance flags (anomaly detection vs history)
-- -----------------------------------------------------------------------------

CREATE TABLE utility_variance_flags (
  flag_id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bill_id             UUID NOT NULL REFERENCES utility_bills(bill_id),
  flagged_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rule_slug           TEXT NOT NULL,               -- 'amount_gt_p95_trailing_12mo', etc.
  rule_description    TEXT NOT NULL,
  baseline_value      NUMERIC(14,2),
  observed_value      NUMERIC(14,2),
  variance_pct        NUMERIC(6,2),
  severity            severity NOT NULL DEFAULT 'warn',
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','dismissed','confirmed_escalated')),
  reviewed_by         TEXT,
  reviewed_at         TIMESTAMPTZ,
  notes               TEXT
);

CREATE INDEX utility_variance_bill_idx ON utility_variance_flags (bill_id);
CREATE INDEX utility_variance_open_idx ON utility_variance_flags (flagged_at DESC) WHERE status = 'open';

COMMENT ON TABLE utility_variance_flags IS
  'Anomaly signals on utility bills (sudden spikes, atypical amounts). Drives human review prompts.';

-- -----------------------------------------------------------------------------
-- Credit applications (bill → owner statement credit)
-- -----------------------------------------------------------------------------

CREATE TABLE utility_credit_applications (
  application_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bill_id             UUID NOT NULL REFERENCES utility_bills(bill_id),
  owner_id            TEXT NOT NULL,
  property_id         TEXT NOT NULL,
  period              TEXT NOT NULL,               -- 'YYYY-MM' applied period
  amount              NUMERIC(14,2) NOT NULL,
  method              TEXT NOT NULL,               -- 'auto_repeat','approved_bt','human_all'
  approval_id         UUID REFERENCES approvals(approval_id),
  je_id               UUID REFERENCES journal_entries(je_id),
  applied_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by          TEXT NOT NULL,
  notes               TEXT,
  UNIQUE (bill_id)     -- one application per bill
);

CREATE INDEX utility_credit_owner_idx  ON utility_credit_applications (owner_id, applied_at DESC);
CREATE INDEX utility_credit_period_idx ON utility_credit_applications (period);

COMMENT ON TABLE utility_credit_applications IS
  'The pass-through: bill → owner statement credit in a specific period. 1:1 with utility_bills.';
