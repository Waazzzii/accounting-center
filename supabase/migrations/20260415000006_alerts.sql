-- =============================================================================
-- 20260415000006_alerts.sql
-- Alert Router: role matrix, on-call schedule, alert deliveries, suppressions
-- =============================================================================
-- Dedup windows (see alert-router prompt pack §4):
--   critical: 60s  (collapse duplicates fired within 60s)
--   warn:    30min
--   info:     6h
-- Quiet hours: configurable per role; critical always delivers.
-- Escalation: +15min no-ack → next tier; +30min no-ack → COO.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Role matrix: which role owns which alert category
-- -----------------------------------------------------------------------------

CREATE TABLE role_matrix (
  role_id             TEXT PRIMARY KEY,            -- 'accounting-controller', 'coo', etc.
  display_name        TEXT NOT NULL,
  email               TEXT NOT NULL,
  slack_user_id       TEXT,
  sms_number          TEXT,
  escalates_to        TEXT REFERENCES role_matrix(role_id),
  escalation_minutes  INT NOT NULL DEFAULT 15,
  quiet_hours_start   TIME,                        -- local tz
  quiet_hours_end     TIME,
  local_tz            TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  accepts_critical_during_quiet BOOLEAN NOT NULL DEFAULT TRUE,
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER role_matrix_updated BEFORE UPDATE ON role_matrix
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE role_matrix IS
  'Role → contact info, escalation target, quiet hours. alert-router reads this on dispatch.';

-- -----------------------------------------------------------------------------
-- Alert routing policies: category × severity → role
-- -----------------------------------------------------------------------------

CREATE TABLE alert_routing_policies (
  policy_id           TEXT PRIMARY KEY,            -- e.g. 'trustsync.breach.critical'
  product             product_code NOT NULL,
  category            TEXT NOT NULL,               -- 'breach' | 'variance' | 'stuck_item' | ...
  min_severity        severity NOT NULL,
  primary_role        TEXT NOT NULL REFERENCES role_matrix(role_id),
  cc_roles            TEXT[] NOT NULL DEFAULT '{}',
  channels            TEXT[] NOT NULL DEFAULT '{slack,email}',
  dedup_window_seconds INT NOT NULL DEFAULT 1800,
  requires_ack        BOOLEAN NOT NULL DEFAULT FALSE,
  escalation_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX alert_policies_match_idx ON alert_routing_policies (product, category, min_severity)
  WHERE enabled;

CREATE TRIGGER alert_policies_updated BEFORE UPDATE ON alert_routing_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE alert_routing_policies IS
  'Category × severity → primary role + CC + channels. alert-router selects the most specific match.';

-- -----------------------------------------------------------------------------
-- On-call schedule (ops coverage rotations)
-- -----------------------------------------------------------------------------

CREATE TABLE on_call_schedule (
  schedule_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role_id             TEXT NOT NULL REFERENCES role_matrix(role_id),
  covering_role_id    TEXT NOT NULL REFERENCES role_matrix(role_id),
  starts_at           TIMESTAMPTZ NOT NULL,
  ends_at             TIMESTAMPTZ NOT NULL,
  reason              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oncall_time_order CHECK (ends_at > starts_at)
);

CREATE INDEX oncall_active_idx ON on_call_schedule (role_id, starts_at, ends_at);

COMMENT ON TABLE on_call_schedule IS
  'Overrides for role_matrix: "while I am out, route to Y". alert-router consults at dispatch time.';

-- -----------------------------------------------------------------------------
-- Alert deliveries (every outbound alert, dedup-aware)
-- -----------------------------------------------------------------------------

CREATE TABLE alert_deliveries (
  alert_id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fingerprint         TEXT NOT NULL,               -- sha256 of (policy_id, entity, severity, summary-kernel)
  product             product_code NOT NULL,
  category            TEXT NOT NULL,
  severity            severity NOT NULL,
  policy_id           TEXT REFERENCES alert_routing_policies(policy_id),
  title               TEXT NOT NULL,
  summary             TEXT NOT NULL,
  suggested_action    TEXT NOT NULL,               -- REQUIRED; rejected without this
  evidence            JSONB,
  correlation_id      UUID,
  event_id            UUID REFERENCES events(event_id),
  entity_type         TEXT,
  entity_id           TEXT,
  primary_role        TEXT REFERENCES role_matrix(role_id),
  dispatched_to       TEXT[] NOT NULL DEFAULT '{}',
  channels_used       TEXT[] NOT NULL DEFAULT '{}',
  deduped_from        UUID REFERENCES alert_deliveries(alert_id),
  ack_required        BOOLEAN NOT NULL DEFAULT FALSE,
  ack_by              TEXT,
  ack_at              TIMESTAMPTZ,
  escalated_from      UUID REFERENCES alert_deliveries(alert_id),
  escalation_level    INT NOT NULL DEFAULT 0,
  resolved_at         TIMESTAMPTZ,
  resolution_note     TEXT
);

CREATE INDEX alerts_fingerprint_window ON alert_deliveries (fingerprint, created_at DESC);
CREATE INDEX alerts_unack_idx          ON alert_deliveries (ack_required, created_at)
  WHERE ack_required AND ack_at IS NULL;
CREATE INDEX alerts_severity_idx       ON alert_deliveries (severity, created_at DESC);
CREATE INDEX alerts_role_idx           ON alert_deliveries (primary_role, created_at DESC);
CREATE INDEX alerts_unresolved_idx     ON alert_deliveries (created_at DESC)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE alert_deliveries IS
  'Every outbound alert. suggested_action is required. fingerprint enables dedup. Escalation chain via escalated_from.';

-- -----------------------------------------------------------------------------
-- Alert suppressions (planned maintenance, known issues)
-- -----------------------------------------------------------------------------

CREATE TABLE alert_suppressions (
  suppression_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fingerprint_glob    TEXT NOT NULL,               -- pattern or exact fingerprint
  product             product_code,
  category            TEXT,
  reason              TEXT NOT NULL,
  suppressed_by       TEXT NOT NULL,
  starts_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  max_severity        severity NOT NULL DEFAULT 'warn', -- critical always delivers
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT supp_time_order CHECK (expires_at > starts_at)
);

-- Full index on (starts_at, expires_at); runtime filters on expires_at > NOW().
-- Partial predicates using NOW() are rejected because NOW() is STABLE.
CREATE INDEX supp_active_idx ON alert_suppressions (starts_at, expires_at);

COMMENT ON TABLE alert_suppressions IS
  'Time-bounded alert suppressions. max_severity caps suppression: critical always breaks through.';
