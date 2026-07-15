-- =============================================================================
-- 20260418000006_narrative_draft_column.sql
-- Column for the Claude-drafted dispute response narrative.
-- =============================================================================
-- narrative-drafter writes the JE-free dispute narrative here after receiving
-- chargeback.dossier.ready. The row stays in place forever — it's the draft
-- that Audrey reviews before submission.
-- =============================================================================

ALTER TABLE chargeback_cases
  ADD COLUMN IF NOT EXISTS narrative_draft JSONB;

COMMENT ON COLUMN chargeback_cases.narrative_draft IS
  'Claude-drafted dispute narrative. Shape: { dossier_key, narrative:{opening, rebuttal, supporting, close}, full_text, word_count, exhibits_cited[], draft_notes, drafted_at, token_usage }. Never auto-submitted — always reviewed by Audrey (or escalated to Jocelyn).';
