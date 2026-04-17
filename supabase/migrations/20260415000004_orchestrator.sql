-- =============================================================================
-- 20260415000004_orchestrator.sql
-- Accounting Orchestrator: routing rules, routing log, product flags
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Routing rules: declarative matchers that decide which agent(s) handle a given
-- event. Hot-reloadable — accounting-orchestrator queries this table on dispatch.
-- -----------------------------------------------------------------------------

CREATE TABLE orchestrator_routing_rules (
  rule_id             TEXT PRIMARY KEY,            -- stable slug
  description         TEXT NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  priority            INT NOT NULL DEFAULT 100,    -- lower = evaluated first
  match_event_type    TEXT,                        -- exact or glob: 'trustsync.*'
  match_source        product_code,
  match_expression    TEXT,                        -- optional SQL predicate over payload
  target_product      product_code NOT NULL,
  target_agent        TEXT NOT NULL,
  transform_template  TEXT,                        -- optional handlebars template to reshape payload
  required_approvals  INT NOT NULL DEFAULT 0,
  timeout_seconds     INT NOT NULL DEFAULT 300,
  max_retries         INT NOT NULL DEFAULT 3,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          TEXT NOT NULL,
  notes               TEXT
);

CREATE INDEX orch_rules_enabled_prio ON orchestrator_routing_rules (enabled, priority)
  WHERE enabled;
CREATE INDEX orch_rules_event_type ON orchestrator_routing_rules (match_event_type)
  WHERE match_event_type IS NOT NULL;

CREATE TRIGGER orch_rules_updated BEFORE UPDATE ON orchestrator_routing_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE orchestrator_routing_rules IS
  'Declarative event→agent routing. accounting-orchestrator evaluates in priority order. Hot-reloadable.';

-- -----------------------------------------------------------------------------
-- Routing log: every dispatch decision, for replay and debugging.
-- -----------------------------------------------------------------------------

CREATE TABLE orchestrator_routing_log (
  routing_id          BIGSERIAL PRIMARY KEY,
  event_id            UUID NOT NULL REFERENCES events(event_id),
  decided_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matched_rule_id     TEXT REFERENCES orchestrator_routing_rules(rule_id),
  target_product      product_code,
  target_agent        TEXT,
  decision            TEXT NOT NULL,               -- 'dispatched' | 'deduped' | 'paused' | 'dropped' | 'no_match'
  decision_reason     TEXT,
  payload_transformed JSONB,
  dispatch_attempt    INT NOT NULL DEFAULT 1,
  dispatched_at       TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  success             BOOLEAN,
  error_message       TEXT
);

CREATE INDEX orch_log_event_idx       ON orchestrator_routing_log (event_id);
CREATE INDEX orch_log_decided_idx     ON orchestrator_routing_log (decided_at DESC);
CREATE INDEX orch_log_target_idx      ON orchestrator_routing_log (target_product, target_agent, decided_at DESC);
CREATE INDEX orch_log_decision_idx    ON orchestrator_routing_log (decision, decided_at DESC);

COMMENT ON TABLE orchestrator_routing_log IS
  'Dispatch decision log. Every event → (matched rule, target, outcome). Replay and audit source.';

-- -----------------------------------------------------------------------------
-- Product/agent flags: pause, maturity mode, feature gates.
-- -----------------------------------------------------------------------------

CREATE TABLE orchestrator_flags (
  flag_id             TEXT PRIMARY KEY,            -- e.g. 'trustsync.transfer-initiator.paused'
  product             product_code NOT NULL,
  agent               TEXT,                        -- NULL = product-wide
  flag_type           TEXT NOT NULL,               -- 'pause' | 'maturity' | 'kill_switch' | 'feature'
  value               JSONB NOT NULL,              -- {enabled:bool, mode:'shadow', ...}
  reason              TEXT,
  set_by              TEXT NOT NULL,
  set_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX orch_flags_product_idx ON orchestrator_flags (product, agent);
CREATE INDEX orch_flags_active_idx  ON orchestrator_flags (flag_type)
  WHERE expires_at IS NULL OR expires_at > NOW();

CREATE TRIGGER orch_flags_updated BEFORE UPDATE ON orchestrator_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE orchestrator_flags IS
  'Pause/maturity/kill-switch flags. Orchestrator checks these before dispatching. Kimberly (COO) has override authority.';

-- -----------------------------------------------------------------------------
-- Approvals queue: gates requiring human sign-off
-- -----------------------------------------------------------------------------

CREATE TABLE approvals (
  approval_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requesting_agent    TEXT NOT NULL,
  product             product_code NOT NULL,
  action              TEXT NOT NULL,               -- what the agent wants to do
  entity_type         TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  summary             TEXT NOT NULL,               -- human-readable one-liner
  detail              JSONB NOT NULL,              -- full context for reviewer
  suggested_action    TEXT NOT NULL,               -- what to approve
  risk_level          severity NOT NULL DEFAULT 'info',
  required_approver_role TEXT NOT NULL,
  correlation_id      UUID,
  event_id            UUID REFERENCES events(event_id),
  status              approval_status NOT NULL DEFAULT 'pending',
  approver_id         TEXT,
  approver_display    TEXT,
  decided_at          TIMESTAMPTZ,
  decision_reason     TEXT,
  auto_approve_at     TIMESTAMPTZ,                 -- for policy-based auto-approve after N hours
  expires_at          TIMESTAMPTZ NOT NULL,
  dollar_impact       NUMERIC(14,2),
  region              region_code NOT NULL DEFAULT 'all'
);

CREATE INDEX approvals_pending_idx  ON approvals (expires_at)
  WHERE status = 'pending';
CREATE INDEX approvals_agent_idx    ON approvals (requesting_agent, status, requested_at DESC);
CREATE INDEX approvals_entity_idx   ON approvals (entity_type, entity_id);
CREATE INDEX approvals_correlation  ON approvals (correlation_id) WHERE correlation_id IS NOT NULL;

COMMENT ON TABLE approvals IS
  'Human approval queue. Every money-in-motion agent writes here before acting. suggested_action is required.';
