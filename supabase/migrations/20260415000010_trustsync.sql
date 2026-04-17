-- =============================================================================
-- 20260415000010_trustsync.sql
-- Phase 1 — TrustSync: trust account compliance + bank transfers
-- =============================================================================
-- TrustSync enforces that guest funds stay in the trust account until earned.
-- Daily: compute required trust balance, reconcile against Column Bank,
-- initiate transfers for over/under, flag breaches for human review.
--
-- Compliance-critical. Every transfer requires approval. Breach = critical alert.
-- =============================================================================

CREATE TYPE trust_breach_kind AS ENUM (
  'commingling',          -- operating funds in trust account
  'shortfall',            -- trust balance < required
  'unauthorized_debit',
  'stale_holding',        -- funds held past expected release
  'reconciliation_gap'
);

CREATE TYPE transfer_status AS ENUM (
  'proposed',
  'pending_approval',
  'approved',
  'submitted',
  'in_flight',
  'settled',
  'reversed',
  'failed',
  'cancelled'
);

CREATE TYPE transfer_direction AS ENUM (
  'trust_to_operating',   -- releasing earned funds
  'operating_to_trust',   -- covering shortfall
  'trust_to_owner',       -- owner payout (RevPost bridges this too)
  'trust_internal'        -- between trust sub-accounts
);

-- -----------------------------------------------------------------------------
-- Trust balance snapshot (daily, per region)
-- -----------------------------------------------------------------------------

CREATE TABLE trust_balance_snapshots (
  snapshot_id         BIGSERIAL PRIMARY KEY,
  snapshot_date       DATE NOT NULL,
  region              region_code NOT NULL,
  bank_account_id     TEXT NOT NULL,               -- Column Bank account id
  bank_balance        NUMERIC(14,2) NOT NULL,
  required_balance    NUMERIC(14,2) NOT NULL,      -- sum of unearned guest funds + reserves
  variance            NUMERIC(14,2) GENERATED ALWAYS AS (bank_balance - required_balance) STORED,
  breach_detected     BOOLEAN NOT NULL DEFAULT FALSE,
  breach_kind         trust_breach_kind,
  components          JSONB NOT NULL,              -- breakdown: pending guest deposits, reservations, etc.
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  computed_by         TEXT NOT NULL DEFAULT 'trust-balance-calculator',
  UNIQUE (snapshot_date, region, bank_account_id)
);

CREATE INDEX trust_snap_date_idx    ON trust_balance_snapshots (snapshot_date DESC);
CREATE INDEX trust_snap_region_idx  ON trust_balance_snapshots (region, snapshot_date DESC);
CREATE INDEX trust_snap_breach_idx  ON trust_balance_snapshots (snapshot_date DESC)
  WHERE breach_detected;

COMMENT ON TABLE trust_balance_snapshots IS
  'Daily immutable snapshot of trust account balance vs required. Breach = critical alert + human review.';

-- -----------------------------------------------------------------------------
-- Transfer proposals + execution
-- -----------------------------------------------------------------------------

CREATE TABLE trust_transfers (
  transfer_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  idempotency_key     TEXT NOT NULL UNIQUE,        -- sha256(direction|amount|source|dest|reason|date)
  direction           transfer_direction NOT NULL,
  amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  source_account_id   TEXT NOT NULL,
  dest_account_id     TEXT NOT NULL,
  region              region_code NOT NULL,
  status              transfer_status NOT NULL DEFAULT 'proposed',
  proposed_by         TEXT NOT NULL,
  proposed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason              TEXT NOT NULL,
  supporting_evidence JSONB,                       -- snapshot_id refs, reservation ids, etc.
  approval_id         UUID REFERENCES approvals(approval_id),
  approved_at         TIMESTAMPTZ,
  submitted_at        TIMESTAMPTZ,
  settled_at          TIMESTAMPTZ,
  bank_transfer_id    TEXT,                        -- Column Bank reference
  reversal_of         UUID REFERENCES trust_transfers(transfer_id),
  failure_reason      TEXT,
  correlation_id      UUID,
  event_id            UUID REFERENCES events(event_id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX trust_xfer_status_idx   ON trust_transfers (status, proposed_at DESC);
CREATE INDEX trust_xfer_region_idx   ON trust_transfers (region, proposed_at DESC);
CREATE INDEX trust_xfer_bank_ref_idx ON trust_transfers (bank_transfer_id) WHERE bank_transfer_id IS NOT NULL;
CREATE INDEX trust_xfer_correlation  ON trust_transfers (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TRIGGER trust_xfer_updated BEFORE UPDATE ON trust_transfers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE trust_transfers IS
  'All trust-related transfers. Idempotent by sha256 key. No transfer executes without approval_id.';

-- -----------------------------------------------------------------------------
-- Breaches (compliance incidents requiring human action)
-- -----------------------------------------------------------------------------

CREATE TABLE trust_breaches (
  breach_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  breach_kind         trust_breach_kind NOT NULL,
  region              region_code NOT NULL,
  severity            severity NOT NULL DEFAULT 'critical',
  amount_at_risk      NUMERIC(14,2),
  summary             TEXT NOT NULL,
  evidence            JSONB NOT NULL,
  related_snapshot_id BIGINT REFERENCES trust_balance_snapshots(snapshot_id),
  alert_id            UUID REFERENCES alert_deliveries(alert_id),
  status              TEXT NOT NULL DEFAULT 'open' -- 'open' | 'acknowledged' | 'remediated' | 'false_positive'
                      CHECK (status IN ('open','acknowledged','remediated','false_positive')),
  remediation_transfer_id UUID REFERENCES trust_transfers(transfer_id),
  resolved_at         TIMESTAMPTZ,
  resolved_by         TEXT,
  resolution_notes    TEXT
);

CREATE INDEX trust_breaches_open_idx   ON trust_breaches (detected_at DESC) WHERE status = 'open';
CREATE INDEX trust_breaches_region_idx ON trust_breaches (region, detected_at DESC);

COMMENT ON TABLE trust_breaches IS
  'Compliance breaches requiring documentation + remediation. SOX/audit evidence.';

-- -----------------------------------------------------------------------------
-- Reconciliation runs: Column Bank ↔ internal ledger
-- -----------------------------------------------------------------------------

CREATE TABLE trust_reconciliations (
  reconciliation_id   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  as_of_date          DATE NOT NULL,
  region              region_code NOT NULL,
  bank_account_id     TEXT NOT NULL,
  bank_balance        NUMERIC(14,2) NOT NULL,
  ledger_balance      NUMERIC(14,2) NOT NULL,
  variance            NUMERIC(14,2) GENERATED ALWAYS AS (bank_balance - ledger_balance) STORED,
  in_transit          NUMERIC(14,2) NOT NULL DEFAULT 0,
  unreconciled_items  JSONB,
  matched_count       INT NOT NULL DEFAULT 0,
  unmatched_count     INT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'complete'
                      CHECK (status IN ('running','complete','failed')),
  completed_at        TIMESTAMPTZ,
  run_by              TEXT NOT NULL DEFAULT 'trust-reconciler'
);

CREATE INDEX trust_recon_date_idx   ON trust_reconciliations (as_of_date DESC);
CREATE INDEX trust_recon_region_idx ON trust_reconciliations (region, as_of_date DESC);

COMMENT ON TABLE trust_reconciliations IS
  'Daily bank ↔ ledger reconciliation runs. Feeds trust_balance_snapshots.';
