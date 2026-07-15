/**
 * seed-reservations-cache.ts — DEPRECATED as of Wave C (Streamline sync live).
 *
 * ⚠️  DO NOT RUN against dev or prod after 2026-04-18 ⚠️
 *
 * This script was the interim seed while the Streamline MCP was down. It
 * inserts 5 hand-crafted reservations (IDs prefixed SL-*) that shadow the
 * real data. After Wave C, we use ingest-streamline-reservations.ts instead,
 * which pulls real rows from Streamline via MCP.
 *
 * Kept in-tree as a reference for how to construct a reservations_cache row
 * shape, and for unit-test fixture setup where a throwaway in-memory DB
 * wants deterministic data.
 */
import { serviceClient } from "@shared/supabase.js";
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "seed-reservations" });

type ResvRow = {
  reservation_id: string;
  confirmation_code: string | null;
  channel: "airbnb" | "vrbo" | "booking_com" | "direct" | null;
  property_id: string;
  property_name: string;
  owner_id: string | null;
  guest_name: string;
  guest_email: string | null;
  guest_phone: string | null;
  check_in: string;
  check_out: string;
  adults: number | null;
  children: number | null;
  total_amount: number;
  currency: string;
  folio_data: Record<string, unknown> | null;
  status: string;
  source_system: string;
};

// Aligned to the REAL Lynnbrook email: "Date: 22 Mar 2026 ..." — the Toledo
// stay (SL-CV-2026-00417) covers 2026-03-20 to 2026-03-25 so date_in_stay scores.
export const SEEDS: ResvRow[] = [
  // 1. THE real match — aligned to the actual Lynnbrook email (charge date 22 Mar 2026).
  // Expected score: name_exact 40 + date_in_stay 30 + amount_close 20 + channel 10 = 100
  {
    reservation_id: "SL-CV-2026-00417",
    confirmation_code: "DIR-TOLEDO-0417",
    channel: "direct",
    property_id: "coachella-valley-placeholder",
    property_name: "Coachella Valley ST — Palm Oasis Unit 14",
    owner_id: "OWN-CV-0042",
    guest_name: "Jason Toledo",
    guest_email: "jrtoledo11@icloud.com", // matches the real email
    guest_phone: "+13124342268",           // matches the real email
    check_in: "2026-03-20",
    check_out: "2026-03-25",
    adults: 2,
    children: 2,
    total_amount: 3679.00,
    currency: "USD",
    folio_data: {
      rental: 3100,
      cleaning_fee: 245,
      guest_service_fee: 150,
      transient_tax: 184,
    },
    status: "checked_out",
    source_system: "streamline",
  },
  // 2. Same property, neighboring dates, different guest — NO name match → 0
  {
    reservation_id: "SL-CV-2026-00415",
    confirmation_code: "AIRBNB-HMX1234",
    channel: "airbnb",
    property_id: "coachella-valley-placeholder",
    property_name: "Coachella Valley ST — Palm Oasis Unit 14",
    owner_id: "OWN-CV-0042",
    guest_name: "Sarah Miller",
    guest_email: "sarah.m@example.com",
    guest_phone: "+14155559876",
    check_in: "2026-03-04",
    check_out: "2026-03-10",
    adults: 4,
    children: 0,
    total_amount: 2910.00,
    currency: "USD",
    folio_data: { rental: 2500, cleaning_fee: 245, guest_service_fee: 75, transient_tax: 90 },
    status: "checked_out",
    source_system: "streamline",
  },
  // 3. Different Toledo (same last name, diff first) — fuzzy name → 25 only
  {
    reservation_id: "SL-CV-2026-00201",
    confirmation_code: "VRBO-MT9987",
    channel: "vrbo",
    property_id: "coachella-valley-2",
    property_name: "Coachella Valley ST — Desert Horizon",
    owner_id: "OWN-CV-0071",
    guest_name: "Maria Toledo",
    guest_email: "mtoledo@example.com",
    guest_phone: null,
    check_in: "2026-01-20",
    check_out: "2026-01-27",
    adults: 2,
    children: 0,
    total_amount: 2400.00,
    currency: "USD",
    folio_data: { rental: 2000, cleaning_fee: 245, guest_service_fee: 55, transient_tax: 100 },
    status: "checked_out",
    source_system: "streamline",
  },
  // 4. Different last name (Rodriguez) — 0, validates that last-name gate holds
  {
    reservation_id: "SL-CV-2026-00305",
    confirmation_code: "DIR-JR1010",
    channel: "direct",
    property_id: "coachella-valley-3",
    property_name: "Coachella Valley ST — Indio Retreat",
    owner_id: "OWN-CV-0099",
    guest_name: "Jason Rodriguez",
    guest_email: "jr@example.com",
    guest_phone: null,
    check_in: "2026-02-15",
    check_out: "2026-02-21",
    adults: 3,
    children: 1,
    total_amount: 3400.00,
    currency: "USD",
    folio_data: { rental: 2800, cleaning_fee: 300, guest_service_fee: 100, transient_tax: 200 },
    status: "checked_out",
    source_system: "streamline",
  },
  // 5. Noise: Phoenix property, unrelated — shouldn't even be in the search window
  {
    reservation_id: "SL-PHX-2026-00512",
    confirmation_code: "AIRBNB-PX5150",
    channel: "airbnb",
    property_id: "phoenix-scottsdale-7",
    property_name: "Scottsdale — Old Town Casita",
    owner_id: "OWN-PHX-0015",
    guest_name: "David Chen",
    guest_email: "dchen@example.com",
    guest_phone: null,
    check_in: "2026-03-22",
    check_out: "2026-03-29",
    adults: 2,
    children: 0,
    total_amount: 2150.00,
    currency: "USD",
    folio_data: { rental: 1800, cleaning_fee: 200, guest_service_fee: 50, transient_tax: 100 },
    status: "confirmed",
    source_system: "streamline",
  },
];

async function main() {
  const sb = serviceClient();

  log.info({ count: SEEDS.length }, "upserting reservations_cache seeds");
  const { data, error } = await sb
    .from("reservations_cache")
    .upsert(SEEDS, { onConflict: "reservation_id", ignoreDuplicates: false })
    .select("reservation_id, guest_name, check_in, total_amount, channel, property_id");

  if (error) {
    log.fatal({ err: error }, "seed failed");
    process.exit(1);
  }

  log.info({ rows: data }, `seeded ${data?.length ?? 0} reservations`);
  log.info(
    "\nNOTE: The REAL match for the Toledo replay is SL-CV-2026-00417 — expect score ~90 (name_exact 40 + date_in_stay 30 + amount_close 20).",
  );
  process.exit(0);
}

// Only run main() when invoked directly — NOT when imported by other scripts
// (e.g. run-chargeback-pipeline.ts imports { SEEDS } and would otherwise trigger
// a runaway upsert + process.exit(0) mid-pipeline).
const isDirectInvocation = process.argv[1]?.endsWith("seed-reservations-cache.ts");
if (isDirectInvocation) {
  main().catch((err) => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "seed crashed");
    process.exit(1);
  });
}
