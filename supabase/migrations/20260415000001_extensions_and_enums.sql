-- =============================================================================
-- 20260415000001_extensions_and_enums.sql
-- Foundation: extensions + shared enum types used across the Accounting Center
-- =============================================================================

-- Extensions we rely on
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";        -- for digest()/hmac() hashing
CREATE EXTENSION IF NOT EXISTS "pg_trgm";         -- fuzzy search on audit log
CREATE EXTENSION IF NOT EXISTS "btree_gin";       -- composite indexes on JSONB
CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA extensions;  -- scheduled jobs

-- -----------------------------------------------------------------------------
-- Shared enum types
-- -----------------------------------------------------------------------------

CREATE TYPE product_code AS ENUM (
  'trustsync',
  'otaauditor',
  'revpost',
  'chargeback',
  'utility',
  'center'
);

CREATE TYPE region_code AS ENUM (
  'socal',
  'arizona',
  'all'
);

CREATE TYPE market_code AS ENUM (
  'coachella',           -- Coachella Valley, CA
  'central_coast',       -- Central Coast, CA
  'orange_county',       -- Orange County, CA (expanding)
  'phoenix',             -- Phoenix / Scottsdale, AZ
  'tucson',              -- Tucson, AZ
  'sedona_flagstaff',    -- Sedona / Flagstaff, AZ
  'unknown'
);

CREATE TYPE severity AS ENUM (
  'info',
  'warn',
  'error',
  'critical'
);

CREATE TYPE health_state AS ENUM (
  'green',
  'yellow',
  'red',
  'unknown'
);

CREATE TYPE maturity_mode AS ENUM (
  'shadow',              -- agent runs but takes no action; humans do everything
  'assist',              -- agent produces output; humans approve before action
  'accelerated',         -- agent acts; humans review after
  'auto_repeat',         -- specific to utility: repeat owners auto-sent
  'auto_trusted',        -- fully trusted automation
  'human_all',           -- all actions human-approved
  'building_trust',      -- early maturity
  'opt_out'              -- excluded from automation
);

CREATE TYPE approval_status AS ENUM (
  'pending',
  'approved',
  'rejected',
  'auto_approved',
  'expired'
);

CREATE TYPE actor_type AS ENUM (
  'ai_agent',
  'human',
  'system',
  'external',
  'webhook'
);

CREATE TYPE event_status AS ENUM (
  'queued',
  'dispatched',
  'completed',
  'failed',
  'deduped',
  'dead_lettered'
);

-- -----------------------------------------------------------------------------
-- Helper: canonical sha256 hashing used for hash chains + idempotency keys
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sha256_hex(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(digest(input, 'sha256'), 'hex');
$$;

COMMENT ON FUNCTION sha256_hex(TEXT) IS
  'Canonical hashing function used for audit-log hash chains, idempotency keys, and content hashes across the Accounting Center. Deterministic; identical input ⇒ identical output.';

-- -----------------------------------------------------------------------------
-- Helper: business-day math (America/Los_Angeles default)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION is_business_day(d DATE)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT EXTRACT(isodow FROM d) < 6;  -- Mon-Fri
$$;

CREATE OR REPLACE FUNCTION add_business_days(d DATE, n INT)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  result DATE := d;
  step INT := SIGN(n);
  remaining INT := ABS(n);
BEGIN
  WHILE remaining > 0 LOOP
    result := result + step;
    IF is_business_day(result) THEN
      remaining := remaining - 1;
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

-- -----------------------------------------------------------------------------
-- Helper: updated_at trigger (idiomatic)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
