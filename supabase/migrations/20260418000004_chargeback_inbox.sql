-- =============================================================================
-- 20260418000004_chargeback_inbox.sql
-- Staging table for inbound chargeback-related messages.
-- =============================================================================
-- The inbox-monitor agent (see src/agents/chargeback/inbox-monitor/index.ts)
-- polls this table when it receives a `chargeback.inbox.poll` event.
--
-- Rows are written by an upstream ingester:
--   Phase 1: scripts/feed-inbox.ts   (CLI, fixture-driven)
--   Phase 2: gmail-ingest agent       (Gmail API push + 15-min poll)
--   Phase 3: webhook receiver         (Stripe / Lynnbrook webhooks, future)
--
-- The ingester writes; inbox-monitor reads + marks processed.
-- =============================================================================

CREATE TABLE chargeback_inbox (
  inbox_id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id          TEXT NOT NULL UNIQUE,          -- Gmail msg id / webhook event id / fixture slug
  source_system       TEXT NOT NULL,                 -- 'gmail', 'stripe_webhook', 'lynnbrook_webhook', 'fixture'
  subject             TEXT NOT NULL,
  body                TEXT NOT NULL,                 -- plain text; HTML stripped at ingest
  body_html           TEXT,                          -- optional original HTML for archival
  from_address        TEXT NOT NULL,
  to_address          TEXT,
  received_at         TIMESTAMPTZ NOT NULL,
  processed           BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at        TIMESTAMPTZ,
  processed_by        TEXT,                          -- agent slug that handled it
  classification      TEXT,                          -- 'new_chargeback' | 'outcome' | 'unrelated'
  parse_error         TEXT,                          -- last parse error if any
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX cb_inbox_unprocessed_idx
  ON chargeback_inbox (received_at)
 WHERE processed = FALSE;

CREATE INDEX cb_inbox_source_idx
  ON chargeback_inbox (source_system, received_at DESC);

CREATE TRIGGER cb_inbox_updated BEFORE UPDATE ON chargeback_inbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE chargeback_inbox IS
  'Staging table: inbound messages awaiting classification. Ingesters write, inbox-monitor reads + marks processed.';

COMMENT ON COLUMN chargeback_inbox.message_id IS
  'Stable id from the source system (Gmail msg id, Stripe event id, webhook event id). UNIQUE enforces idempotent ingest.';

-- Realtime: inbox-monitor may choose to subscribe to inserts directly
-- instead of waiting for chargeback.inbox.poll events.
ALTER PUBLICATION supabase_realtime ADD TABLE chargeback_inbox;
