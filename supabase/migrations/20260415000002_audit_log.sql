-- =============================================================================
-- 20260415000002_audit_log.sql
-- Hash-chained, tamper-evident audit log + event bus
-- =============================================================================
-- Every material action taken by any agent (AI or human) in the Accounting
-- Center is written here. Each row hashes the previous row, so tampering
-- with any historical entry invalidates all subsequent hashes.
--
-- Retention: 7 years (SOX + Sage Intacct alignment).
-- Integrity: verified nightly by audit-log-reader agent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Event envelope (the bus).
-- Every cross-agent message lands here first; pg_notify fans out to listeners.
-- -----------------------------------------------------------------------------

CREATE TABLE events (
  event_id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type          TEXT NOT NULL,               -- e.g. 'trustsync.transfer.completed'
  source_product      product_code NOT NULL,
  source_agent        TEXT NOT NULL,               -- agent slug
  correlation_id      UUID,                        -- groups related events across agents
  causation_id        UUID,                        -- the event_id that caused this one
  idempotency_key     TEXT UNIQUE,                 -- dedup key; see sha256_hex()
  payload             JSONB NOT NULL,
  metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,
  status              event_status NOT NULL DEFAULT 'queued',
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at       TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  retry_count         INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  region              region_code NOT NULL DEFAULT 'all'
);

CREATE INDEX events_type_occurred_idx ON events (event_type, occurred_at DESC);
CREATE INDEX events_correlation_idx  ON events (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX events_status_idx       ON events (status) WHERE status IN ('queued', 'dispatched', 'failed');
CREATE INDEX events_source_idx       ON events (source_product, source_agent, occurred_at DESC);
CREATE INDEX events_payload_gin      ON events USING gin (payload jsonb_path_ops);

COMMENT ON TABLE events IS
  'Event bus. All cross-agent messages flow through here. pg_notify fans out to listeners. Indexed for correlation traversal and time-range queries.';

-- Trigger: notify listeners on insert
CREATE OR REPLACE FUNCTION notify_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'accounting_center_events',
    json_build_object(
      'event_id', NEW.event_id,
      'event_type', NEW.event_type,
      'source_product', NEW.source_product,
      'source_agent', NEW.source_agent,
      'correlation_id', NEW.correlation_id,
      'occurred_at', NEW.occurred_at
    )::TEXT
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER events_notify
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION notify_event();

-- -----------------------------------------------------------------------------
-- Audit log (hash-chained, immutable).
-- -----------------------------------------------------------------------------

CREATE TABLE audit_log (
  audit_id            BIGSERIAL PRIMARY KEY,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_type          actor_type NOT NULL,
  actor_id            TEXT NOT NULL,               -- agent slug, user email, or system id
  actor_display       TEXT,                        -- friendly name for UI
  product             product_code NOT NULL,
  action              TEXT NOT NULL,               -- verb, e.g. 'transfer.initiated'
  entity_type         TEXT NOT NULL,               -- e.g. 'reservation', 'transfer', 'journal_entry'
  entity_id           TEXT NOT NULL,               -- opaque id of the thing being acted on
  correlation_id      UUID,                        -- links to event bus
  event_id            UUID REFERENCES events(event_id),
  severity            severity NOT NULL DEFAULT 'info',
  before_state        JSONB,
  after_state         JSONB,
  diff                JSONB,                       -- computed at write-time if possible
  reason              TEXT,                        -- why the action was taken
  evidence            JSONB,                       -- supporting data (doc refs, query results)
  region              region_code NOT NULL DEFAULT 'all',
  prev_hash           TEXT,                        -- sha256 of prior row (NULL for genesis)
  row_hash            TEXT NOT NULL,               -- sha256 of this row's canonical repr
  CONSTRAINT audit_log_hash_format CHECK (row_hash ~ '^[a-f0-9]{64}$')
);

-- Forbid updates and deletes on the audit log.
CREATE OR REPLACE FUNCTION forbid_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is immutable (attempted %)', TG_OP;
END;
$$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

-- Chain-linking trigger: computes prev_hash and row_hash automatically.
CREATE OR REPLACE FUNCTION audit_log_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  last_hash TEXT;
  canonical TEXT;
BEGIN
  -- Lock the tail so concurrent inserts can't race
  SELECT row_hash INTO last_hash
  FROM audit_log
  ORDER BY audit_id DESC
  LIMIT 1
  FOR UPDATE;

  NEW.prev_hash := last_hash;

  -- Canonical representation: deterministic JSON of the row's logical content.
  canonical := COALESCE(NEW.prev_hash, '') || '|' ||
               NEW.occurred_at::TEXT       || '|' ||
               NEW.actor_type::TEXT        || '|' ||
               NEW.actor_id                || '|' ||
               NEW.product::TEXT           || '|' ||
               NEW.action                  || '|' ||
               NEW.entity_type             || '|' ||
               NEW.entity_id               || '|' ||
               COALESCE(NEW.correlation_id::TEXT, '') || '|' ||
               NEW.severity::TEXT          || '|' ||
               COALESCE(NEW.before_state::TEXT, '')  || '|' ||
               COALESCE(NEW.after_state::TEXT, '')   || '|' ||
               COALESCE(NEW.reason, '');

  NEW.row_hash := sha256_hex(canonical);
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_chain_trg BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- Hot-path indexes.
CREATE INDEX audit_log_occurred_idx    ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_actor_idx       ON audit_log (actor_type, actor_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx      ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_correlation_idx ON audit_log (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX audit_log_product_idx     ON audit_log (product, occurred_at DESC);
CREATE INDEX audit_log_severity_idx    ON audit_log (severity, occurred_at DESC) WHERE severity IN ('error','critical');
CREATE INDEX audit_log_reason_trgm     ON audit_log USING gin (reason gin_trgm_ops);
CREATE INDEX audit_log_evidence_gin    ON audit_log USING gin (evidence jsonb_path_ops);

COMMENT ON TABLE audit_log IS
  'Immutable, hash-chained audit log. prev_hash + row_hash form a tamper-evident chain. Updates/deletes raise exception. Retention 7 years. Verified nightly by audit-log-reader agent.';

-- -----------------------------------------------------------------------------
-- Audit chain verification log (nightly integrity check output)
-- -----------------------------------------------------------------------------

CREATE TABLE audit_chain_verification (
  verification_id     BIGSERIAL PRIMARY KEY,
  verified_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  from_audit_id       BIGINT NOT NULL,
  to_audit_id         BIGINT NOT NULL,
  rows_checked        BIGINT NOT NULL,
  chain_valid         BOOLEAN NOT NULL,
  first_break_at_id   BIGINT,
  expected_hash       TEXT,
  actual_hash         TEXT,
  duration_ms         INT,
  run_by              TEXT NOT NULL DEFAULT 'audit-log-reader'
);

CREATE INDEX audit_chain_verif_time_idx ON audit_chain_verification (verified_at DESC);

COMMENT ON TABLE audit_chain_verification IS
  'Results of nightly hash-chain integrity scan. chain_valid=false triggers critical alert.';
