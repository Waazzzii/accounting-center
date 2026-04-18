-- =============================================================================
-- 20260418000002_reservations_cache.sql
-- Denormalized Streamline reservation snapshot.
-- =============================================================================
-- Populated by a Streamline sync agent (Wave A of this build-out).
-- Read by: chargeback/reservation-matcher, dossier-builder, narrative-drafter,
-- and future OTA/Trust agents that need fast lookups without hitting Streamline.
-- =============================================================================

CREATE TABLE reservations_cache (
  reservation_id      TEXT PRIMARY KEY,            -- Streamline reservation id
  confirmation_code   TEXT,                         -- platform-facing (Airbnb, VRBO, direct)
  channel             ota_channel,                  -- airbnb | vrbo | booking_com | direct | ...
  property_id         TEXT NOT NULL,
  property_name       TEXT,
  owner_id            TEXT,
  -- Guest
  guest_name          TEXT NOT NULL,
  guest_email         TEXT,
  guest_phone         TEXT,
  -- Stay
  check_in            DATE NOT NULL,
  check_out           DATE NOT NULL,
  nights              INT GENERATED ALWAYS AS (check_out - check_in) STORED,
  adults              INT,
  children            INT,
  -- Money
  total_amount        NUMERIC(14,2) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'USD',
  -- Idempotency + audit
  folio_data          JSONB,                        -- line-item detail from Streamline
  status              TEXT,                         -- 'confirmed','cancelled','checked_out', etc.
  -- Sync metadata
  source_system       TEXT NOT NULL DEFAULT 'streamline',
  source_record_hash  TEXT,                         -- for change detection
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX resv_cache_guest_idx     ON reservations_cache (guest_name);
CREATE INDEX resv_cache_checkin_idx   ON reservations_cache (check_in);
CREATE INDEX resv_cache_property_idx  ON reservations_cache (property_id, check_in);
CREATE INDEX resv_cache_owner_idx     ON reservations_cache (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX resv_cache_confirmation  ON reservations_cache (confirmation_code) WHERE confirmation_code IS NOT NULL;
-- Trigram index on guest_name for fuzzy match (reservation-matcher uses Levenshtein/ratio)
CREATE INDEX resv_cache_guest_trgm    ON reservations_cache USING gin (guest_name gin_trgm_ops);

CREATE TRIGGER resv_cache_updated BEFORE UPDATE ON reservations_cache
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE reservations_cache IS
  'Streamline reservation snapshot — fast lookup for matching, evidence assembly, narrative. Synced by streamline-sync agent.';
