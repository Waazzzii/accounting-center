-- =============================================================================
-- 20260418000003_chargeback_reconcile.sql
-- Reconcile schema with column names the agent code actually uses.
-- =============================================================================
-- Discovered during the first end-to-end replay (scripts/replay-toledo-chargeback.ts):
--   inbox-monitor and reservation-matcher expected columns the schema didn't have.
-- Additive-only: no renames, no drops. Existing data untouched.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enum extensions
--
-- ALTER TYPE ... ADD VALUE IF NOT EXISTS (PG10+) works inside a transaction
-- as long as the new value isn't USED in the same transaction.
-- -----------------------------------------------------------------------------

ALTER TYPE chargeback_source  ADD VALUE IF NOT EXISTS 'lynnbrook';
ALTER TYPE chargeback_reason  ADD VALUE IF NOT EXISTS 'cancellation_refund';

-- -----------------------------------------------------------------------------
-- 2. chargeback_cases: add columns the code expects
-- -----------------------------------------------------------------------------

ALTER TABLE chargeback_cases
  ADD COLUMN IF NOT EXISTS reason_code              TEXT,                -- raw processor reason string
  ADD COLUMN IF NOT EXISTS processor_deadline       TIMESTAMPTZ,         -- hard deadline from processor
  ADD COLUMN IF NOT EXISTS internal_deadline        TIMESTAMPTZ,         -- our self-imposed 48h-before deadline
  ADD COLUMN IF NOT EXISTS inbox_message_id         TEXT,                -- Gmail message id of the notification
  ADD COLUMN IF NOT EXISTS streamline_reservation_id TEXT,               -- the matched reservation
  ADD COLUMN IF NOT EXISTS match_confidence         INT,                 -- 0..100, from reservation-matcher
  ADD COLUMN IF NOT EXISTS matched_at               TIMESTAMPTZ;         -- when the match was decided

COMMENT ON COLUMN chargeback_cases.reason_code IS
  'Raw reason string from the processor notice (e.g. "cancellation_refund", "not_as_described"). ENUM `reason` is our bucketed classification; reason_code preserves the literal.';
COMMENT ON COLUMN chargeback_cases.processor_deadline IS
  'Hard deadline from the processor. internal_deadline is our self-imposed earlier deadline.';
COMMENT ON COLUMN chargeback_cases.internal_deadline IS
  'Our self-imposed deadline (SOP: 48 hours before processor_deadline) to guarantee buffer for review/submission.';
COMMENT ON COLUMN chargeback_cases.match_confidence IS
  'Score 0..100 from reservation-matcher. >=95 auto, 75-94 probable (needs human confirm), <75 ambiguous.';

-- Backfill: existing rows get processor_deadline = evidence_due_at so downstream queries don't get NULLs
UPDATE chargeback_cases
   SET processor_deadline = evidence_due_at
 WHERE processor_deadline IS NULL AND evidence_due_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. Indexes that support the new columns
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS cb_cases_processor_deadline_idx
  ON chargeback_cases (processor_deadline)
 WHERE stage IN ('notified','under_review','evidence_collecting');

CREATE INDEX IF NOT EXISTS cb_cases_streamline_reservation_idx
  ON chargeback_cases (streamline_reservation_id)
 WHERE streamline_reservation_id IS NOT NULL;
