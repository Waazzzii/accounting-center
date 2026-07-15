-- =============================================================================
-- 20260418000001_enable_realtime.sql
-- Enable Supabase Realtime replication on tables the agents subscribe to.
-- =============================================================================
-- Without this, bus.ts subscribers never receive INSERTs because the
-- supabase_realtime publication only tracks opt-in tables.
-- Safe to run multiple times: ALTER PUBLICATION ADD TABLE is idempotent
-- via the DO-block guard below (PG raises duplicate_object otherwise).
-- =============================================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'public.events',
      'public.chargeback_cases',
      'public.chargeback_evidence',
      'public.approvals',
      'public.alert_deliveries',
      'public.tile_state',
      'public.health_state',
      'public.close_cycles',
      'public.close_steps'
    ])
  LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %s', t);
    EXCEPTION
      WHEN duplicate_object THEN NULL;             -- already in publication
      WHEN undefined_table THEN NULL;              -- table not yet created
    END;
  END LOOP;
END $$;
