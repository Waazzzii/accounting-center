-- =============================================================================
-- 20260415000012_revpost.sql
-- Phase 3 — RevPost: revenue posting to Sage Intacct
-- =============================================================================
-- RevPost owns turning reconciled activity (OTA packets, direct bookings,
-- adjustments) into journal entries and posting them to Sage Intacct.
-- Every JE is idempotent, human-approved, and audit-logged.
-- =============================================================================

CREATE TYPE je_status AS ENUM (
  'draft',
  'ready',
  'pending_approval',
  'approved',
  'posting',
  'posted',
  'failed',
  'reversed',
  'rejected'
);

CREATE TYPE je_source_kind AS ENUM (
  'ota_payout',
  'direct_booking',
  'refund',
  'chargeback',
  'utility_credit',
  'owner_payout',
  'fee_adjustment',
  'accrual',
  'trust_transfer',
  'manual'
);

-- -----------------------------------------------------------------------------
-- Journal entries
-- -----------------------------------------------------------------------------

CREATE TABLE journal_entries (
  je_id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  idempotency_key     TEXT NOT NULL UNIQUE,        -- sha256(source_kind|source_ref|period|amount)
  source_kind         je_source_kind NOT NULL,
  source_ref          TEXT NOT NULL,               -- opaque id of originating record
  source_product      product_code NOT NULL,
  posting_date        DATE NOT NULL,
  accounting_period   TEXT NOT NULL,               -- 'YYYY-MM'
  memo                TEXT NOT NULL,
  total_debits        NUMERIC(14,2) NOT NULL,
  total_credits       NUMERIC(14,2) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'USD',
  region              region_code NOT NULL,
  status              je_status NOT NULL DEFAULT 'draft',
  approval_id         UUID REFERENCES approvals(approval_id),
  approved_at         TIMESTAMPTZ,
  posted_at           TIMESTAMPTZ,
  intacct_je_id       TEXT,                        -- Sage Intacct document id
  intacct_batch_id    TEXT,
  reversed_by         UUID REFERENCES journal_entries(je_id),
  reversal_of         UUID REFERENCES journal_entries(je_id),
  correlation_id      UUID,
  event_id            UUID REFERENCES events(event_id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          TEXT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT je_balanced CHECK (total_debits = total_credits)
);

CREATE INDEX je_period_idx       ON journal_entries (accounting_period, posting_date);
CREATE INDEX je_status_idx       ON journal_entries (status, posting_date DESC);
CREATE INDEX je_source_idx       ON journal_entries (source_kind, source_ref);
CREATE INDEX je_intacct_idx      ON journal_entries (intacct_je_id) WHERE intacct_je_id IS NOT NULL;
CREATE INDEX je_correlation_idx  ON journal_entries (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TRIGGER je_updated BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE journal_entries IS
  'Journal entry header. Debits = credits (DB constraint). Idempotent by source_kind+source_ref+period+amount. Posted to Sage Intacct via RevPost agent.';

-- -----------------------------------------------------------------------------
-- JE line items
-- -----------------------------------------------------------------------------

CREATE TABLE journal_entry_lines (
  line_id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  je_id               UUID NOT NULL REFERENCES journal_entries(je_id) ON DELETE CASCADE,
  line_number         INT NOT NULL,
  account_code        TEXT NOT NULL,               -- Sage Intacct GL account
  account_name        TEXT,
  debit               NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit              NUMERIC(14,2) NOT NULL DEFAULT 0,
  memo                TEXT,
  property_id         TEXT,                        -- optional property dimension
  owner_id            TEXT,                        -- optional owner dimension
  market              market_code,
  channel             ota_channel,
  reservation_ref     TEXT,
  dimensions          JSONB NOT NULL DEFAULT '{}'::JSONB, -- additional Intacct dims
  CONSTRAINT je_line_dr_or_cr CHECK ((debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0)),
  UNIQUE (je_id, line_number)
);

CREATE INDEX je_lines_je_idx        ON journal_entry_lines (je_id, line_number);
CREATE INDEX je_lines_account_idx   ON journal_entry_lines (account_code);
CREATE INDEX je_lines_property_idx  ON journal_entry_lines (property_id) WHERE property_id IS NOT NULL;
CREATE INDEX je_lines_owner_idx     ON journal_entry_lines (owner_id) WHERE owner_id IS NOT NULL;

COMMENT ON TABLE journal_entry_lines IS
  'JE line items. Either debit or credit must be > 0, never both. Property/owner dims propagate to Intacct.';

-- -----------------------------------------------------------------------------
-- Posting attempts (audit trail of Intacct API calls)
-- -----------------------------------------------------------------------------

CREATE TABLE je_posting_attempts (
  attempt_id          BIGSERIAL PRIMARY KEY,
  je_id               UUID NOT NULL REFERENCES journal_entries(je_id),
  attempted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempt_number      INT NOT NULL,
  succeeded           BOOLEAN NOT NULL DEFAULT FALSE,
  intacct_request_id  TEXT,
  intacct_response    JSONB,
  http_status         INT,
  latency_ms          INT,
  error_code          TEXT,
  error_message       TEXT
);

CREATE INDEX je_posting_je_idx    ON je_posting_attempts (je_id, attempt_number);
CREATE INDEX je_posting_time_idx  ON je_posting_attempts (attempted_at DESC);
CREATE INDEX je_posting_errors    ON je_posting_attempts (attempted_at DESC) WHERE NOT succeeded;

COMMENT ON TABLE je_posting_attempts IS
  'Every Sage Intacct API call per JE. Preserves response for forensic replay.';

-- -----------------------------------------------------------------------------
-- GL account catalog (cached from Intacct)
-- -----------------------------------------------------------------------------

CREATE TABLE gl_accounts (
  account_code        TEXT PRIMARY KEY,
  account_name        TEXT NOT NULL,
  account_type        TEXT NOT NULL,               -- 'asset','liability','revenue','expense','equity'
  normal_balance      TEXT NOT NULL CHECK (normal_balance IN ('debit','credit')),
  is_trust            BOOLEAN NOT NULL DEFAULT FALSE,
  is_owner_liability  BOOLEAN NOT NULL DEFAULT FALSE,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX gl_accounts_type_idx ON gl_accounts (account_type);
CREATE INDEX gl_accounts_flags_idx ON gl_accounts (is_trust, is_owner_liability) WHERE active;

COMMENT ON TABLE gl_accounts IS
  'Cached Sage Intacct chart of accounts. Flags identify trust and owner-liability accounts for compliance checks.';
