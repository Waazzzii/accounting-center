-- =============================================================================
-- 20260418000005_reservations_booking_date.sql
-- Record when a reservation was BOOKED (distinct from when it's stayed).
-- =============================================================================
-- Discovered while wiring the Streamline sync against the real Toledo case:
--   Chargeback notices quote the "Date" of the original card transaction,
--   which for VRBO/HomeAway bookings happens at reservation creation — often
--   weeks or months before check-in. The matcher's date-in-stay check misses
--   these because the charge date is outside the stay window.
--
-- Streamline field: `creation_date` (ISO timestamp with timezone).
-- =============================================================================

ALTER TABLE reservations_cache
  ADD COLUMN IF NOT EXISTS booking_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS streamline_internal_id BIGINT,
  ADD COLUMN IF NOT EXISTS maketype_code TEXT,
  ADD COLUMN IF NOT EXISTS reservation_type TEXT;

COMMENT ON COLUMN reservations_cache.booking_created_at IS
  'When the reservation was originally booked (Streamline creation_date). Used by chargeback-reservation-matcher to detect booking-time chargebacks where the charge date is far from the stay window.';

COMMENT ON COLUMN reservations_cache.streamline_internal_id IS
  'Streamline numeric reservation id (`id` field). reservation_id stores the same value as TEXT for cross-system joins.';

COMMENT ON COLUMN reservations_cache.maketype_code IS
  'Streamline maketype_name (A=Admin, O=Owner, 11=PDW, etc.). Used to distinguish guest bookings from owner/admin reservations.';

COMMENT ON COLUMN reservations_cache.reservation_type IS
  'Streamline type_name (e.g. HAFamOLB, OWN, Property Hold). Filter hint for agents that only care about guest stays.';

CREATE INDEX IF NOT EXISTS resv_cache_booking_created_idx
  ON reservations_cache (booking_created_at);
CREATE INDEX IF NOT EXISTS resv_cache_maketype_idx
  ON reservations_cache (maketype_code) WHERE maketype_code IS NOT NULL;
