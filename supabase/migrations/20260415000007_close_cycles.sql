-- =============================================================================
-- 20260415000007_close_cycles.sql
-- Month-End Close Orchestrator: cycles + sequenced steps
-- =============================================================================
-- 11-step sequenced close (see month-end-close-orchestrator prompt pack):
--   1. Data cutoff                8. Trial balance (HARD GATE)
--   2. OTAAuditor final           9. Owner statements
--   3. RevPost                   10. Kimberly (COO) approval
--   4. Utility credits          11. Archive
--   5. TrustSync reconcile
--   6. Chargeback reserve
--   7. Accruals
-- =============================================================================

CREATE TYPE close_status AS ENUM (
  'scheduled',
  'running',
  'awaiting_human',
  'blocked',
  'failed',
  'completed',
  'rolled_back'
);

CREATE TYPE close_step_status AS ENUM (
  'pending',
  'running',
  'waiting_on_upstream',
  'awaiting_approval',
  'succeeded',
  'failed',
  'skipped'
);

CREATE TABLE close_cycles (
  cycle_id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  close_month         TEXT NOT NULL,               -- 'YYYY-MM' for UI
  status              close_status NOT NULL DEFAULT 'scheduled',
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  target_close_date   DATE NOT NULL,               -- BD+5 target
  actual_close_date   DATE,
  trial_balance_at_start NUMERIC(14,2),            -- unbalanced amount before close
  trial_balance_final NUMERIC(14,2),               -- unbalanced amount at gate check (should be 0)
  approved_by         TEXT,
  approved_at         TIMESTAMPTZ,
  rolled_back_by      TEXT,
  rolled_back_at      TIMESTAMPTZ,
  rollback_reason     TEXT,
  notes               TEXT,
  orchestrator_run_id UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (close_month)
);

CREATE INDEX close_cycles_status_idx  ON close_cycles (status, target_close_date);
CREATE INDEX close_cycles_period_idx  ON close_cycles (period_end DESC);

CREATE TRIGGER close_cycles_updated BEFORE UPDATE ON close_cycles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE close_cycles IS
  'One row per monthly close. Trial balance gate is hard — no advance to statements without TB=0.';

-- -----------------------------------------------------------------------------
-- Close steps: the 11-step plan, per cycle
-- -----------------------------------------------------------------------------

CREATE TABLE close_steps (
  step_id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cycle_id            UUID NOT NULL REFERENCES close_cycles(cycle_id) ON DELETE CASCADE,
  step_order          INT NOT NULL,                -- 1..11
  step_slug           TEXT NOT NULL,               -- 'data-cutoff', 'trial-balance-gate', etc.
  step_name           TEXT NOT NULL,
  owning_product      product_code,
  owning_agent        TEXT,
  depends_on_steps    INT[] NOT NULL DEFAULT '{}',
  status              close_step_status NOT NULL DEFAULT 'pending',
  is_gate             BOOLEAN NOT NULL DEFAULT FALSE, -- trial-balance = true
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  duration_ms         INT,
  output              JSONB,                       -- agent result payload
  error_message       TEXT,
  retry_count         INT NOT NULL DEFAULT 0,
  approval_id         UUID REFERENCES approvals(approval_id),
  correlation_id      UUID,
  UNIQUE (cycle_id, step_order)
);

CREATE INDEX close_steps_cycle_idx    ON close_steps (cycle_id, step_order);
CREATE INDEX close_steps_status_idx   ON close_steps (status);
CREATE INDEX close_steps_running_idx  ON close_steps (cycle_id)
  WHERE status IN ('running','waiting_on_upstream','awaiting_approval');

COMMENT ON TABLE close_steps IS
  'Sequenced steps per close cycle. is_gate=true means downstream steps block until success. Trial balance is the critical gate.';

-- -----------------------------------------------------------------------------
-- Close step events: fine-grained log of attempts/actions within a step
-- -----------------------------------------------------------------------------

CREATE TABLE close_step_events (
  event_id            BIGSERIAL PRIMARY KEY,
  step_id             UUID NOT NULL REFERENCES close_steps(step_id) ON DELETE CASCADE,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_kind          TEXT NOT NULL,               -- 'started' | 'retry' | 'blocked' | 'unblocked' | 'completed' | 'failed'
  message             TEXT,
  context             JSONB
);

CREATE INDEX close_step_events_step_idx ON close_step_events (step_id, occurred_at DESC);

COMMENT ON TABLE close_step_events IS
  'Fine-grained execution trail per close step. Feeds the close cycle timeline UI.';
