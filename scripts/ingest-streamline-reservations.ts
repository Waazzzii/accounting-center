/**
 * ingest-streamline-reservations.ts — transform raw Streamline MCP payload
 * into reservations_cache rows.
 *
 * Usage:
 *   npx tsx scripts/ingest-streamline-reservations.ts <path-to-payload.json>
 *
 * Where payload.json is the full MCP response (the shape returned by
 * `mcp__*__get_reservations` with return_full=true). The file can contain
 * either the top-level response object OR just the reservations array.
 *
 * Phase 1: hand-invoked (Claude pulls via MCP, saves a fixture, runs this).
 * Phase 2: a streamline-sync agent replaces this with a cron-driven poller
 *          talking to the Streamline API directly via key/secret. Downstream
 *          contract (reservations_cache upserts keyed on reservation_id) is
 *          identical — the sync agent just becomes the writer.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient } from "@shared/supabase.js";
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "ingest-streamline" });

// ---------------------------------------------------------------------------
// Streamline payload shape (keys we actually read)
// ---------------------------------------------------------------------------
interface StreamlineTaxFee {
  name: string;
  value: number;
  percent: number;
  include_as_tax: number;
  taxable: number;
}

interface StreamlineReservation {
  id: number;
  confirmation_id: number | null;
  hash: string;
  email: string | null;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  mobile_phone: string | null;
  phone: string | null;
  unit_id: number | null;
  unit_name: string | null;
  location_name: string | null;
  occupants: number | null;
  occupants_small: number | null;
  price_total: number;
  status_id: number;
  maketype_id: number;
  maketype_name: string | null;
  maketype_description: string | null;
  type_name: string | null;
  hear_about_name: string | null;
  travelagent_name: string | null;
  creation_date: string;
  startdate: string;
  enddate: string;
  taxes_and_fees?: { tax_fee?: StreamlineTaxFee[] };
}

type OtaChannel = "airbnb" | "vrbo" | "booking_com" | "direct" | null;

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/** Infer booking channel from Streamline hints. */
function inferChannel(r: StreamlineReservation): OtaChannel {
  const hay = `${r.travelagent_name ?? ""} ${r.hear_about_name ?? ""}`.toLowerCase();
  if (/airbnb/.test(hay)) return "airbnb";
  if (/vrbo|homeaway|ha-olb|ha-?fam/.test(hay)) return "vrbo";
  if (/booking/.test(hay)) return "booking_com";
  // If none of the above, assume direct booking
  return "direct";
}

/** Streamline status_id → human-readable status for our cache. */
function mapStatus(statusId: number): string {
  switch (statusId) {
    case 1:  return "not_completed";
    case 3:  return "attempt_to_charge";
    case 4:  return "booked";
    case 5:  return "checked_out";
    case 6:  return "deleted";
    case 7:  return "modified";
    case 8:  return "cancelled";
    case 9:  return "non_blocked_request";
    case 10: return "blocked_request";
    case 12: return "no_show";
    case 13: return "quote_sent";
    case 99: return "bullpen";
    default: return `unknown_${statusId}`;
  }
}

/** Should we skip this reservation entirely? (owner/admin/quote/deleted etc.) */
function shouldSkip(r: StreamlineReservation): { skip: boolean; reason?: string } {
  // Deleted or quote — never a guest booking
  if (r.status_id === 6) return { skip: true, reason: "deleted" };
  if (r.status_id === 13) return { skip: true, reason: "quote_sent" };
  if (r.status_id === 10) return { skip: true, reason: "blocked_request" };

  // Owner / Admin / Property Hold reservations — not chargeback-eligible
  const ownerLike = /^(OWN|Property Hold)$/i.test(r.type_name ?? "");
  const adminLike = r.maketype_name === "A" || r.maketype_name === "O";
  if (ownerLike || adminLike) return { skip: true, reason: `owner_or_admin (${r.type_name ?? r.maketype_description ?? "?"})` };

  // No guest name = not usable for matching
  if (!r.first_name && !r.last_name) return { skip: true, reason: "no_guest_name" };

  return { skip: false };
}

/** Convert one Streamline reservation into the reservations_cache row shape. */
function toCacheRow(r: StreamlineReservation): Record<string, unknown> {
  const guestName = [r.first_name, r.middle_name, r.last_name]
    .filter((p) => p && p.trim().length > 0)
    .join(" ")
    .trim();

  // Build a simple folio_data from taxes_and_fees
  const taxes = r.taxes_and_fees?.tax_fee ?? [];
  const folioData: Record<string, unknown> = {
    streamline_hash: r.hash,
    price_total: r.price_total,
    line_items: taxes.map((t) => ({
      name: t.name,
      value: t.value,
      percent: t.percent,
      is_tax: t.include_as_tax === 1,
      taxable: t.taxable === 1,
    })),
    source_type: r.maketype_description,
    reservation_type: r.type_name,
  };

  return {
    reservation_id: String(r.id),
    streamline_internal_id: r.id,
    confirmation_code: r.confirmation_id ? String(r.confirmation_id) : null,
    channel: inferChannel(r),
    property_id: r.unit_id ? String(r.unit_id) : "unknown",
    property_name: r.unit_name ?? r.location_name ?? null,
    owner_id: null, // Streamline's owning_id requires a separate lookup; skip for now
    guest_name: guestName || "Unknown",
    guest_email: r.email,
    guest_phone: r.mobile_phone ?? r.phone ?? null,
    check_in: r.startdate,
    check_out: r.enddate,
    adults: r.occupants ?? null,
    children: r.occupants_small ?? null,
    total_amount: r.price_total,
    currency: "USD", // Casago is US-only; Streamline doesn't expose currency in list response
    folio_data: folioData,
    status: mapStatus(r.status_id),
    source_system: "streamline",
    source_record_hash: r.hash,
    booking_created_at: r.creation_date,
    maketype_code: r.maketype_name,
    reservation_type: r.type_name,
    synced_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const path = process.argv[2];
  if (!path) {
    log.error("usage: ingest-streamline-reservations.ts <payload.json>");
    process.exit(1);
  }

  const fullPath = resolve(process.cwd(), path);
  const raw = readFileSync(fullPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  // Accept either { data: { reservations: [...] } } or { reservations: [...] } or [...]
  let reservations: StreamlineReservation[] = [];
  if (Array.isArray(parsed)) {
    reservations = parsed as StreamlineReservation[];
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as { reservations?: unknown; data?: { reservations?: unknown } };
    if (Array.isArray(obj.reservations)) {
      reservations = obj.reservations as StreamlineReservation[];
    } else if (obj.data && Array.isArray(obj.data.reservations)) {
      reservations = obj.data.reservations as StreamlineReservation[];
    }
  }

  if (reservations.length === 0) {
    log.fatal("no reservations found in payload (expected { data: { reservations: [...] } } or [...])");
    process.exit(1);
  }

  log.info({ raw_count: reservations.length }, "loaded Streamline payload");

  const rowsToWrite: Record<string, unknown>[] = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  for (const r of reservations) {
    const decision = shouldSkip(r);
    if (decision.skip) {
      skipped.push({ id: r.id, reason: decision.reason ?? "unknown" });
      continue;
    }
    rowsToWrite.push(toCacheRow(r));
  }

  log.info(
    { ingested: rowsToWrite.length, skipped: skipped.length },
    `transformed: ${rowsToWrite.length} guest bookings, ${skipped.length} skipped`,
  );

  if (skipped.length > 0) {
    const reasonCounts: Record<string, number> = {};
    for (const s of skipped) reasonCounts[s.reason] = (reasonCounts[s.reason] ?? 0) + 1;
    log.info({ skip_breakdown: reasonCounts }, "skip reasons");
  }

  if (rowsToWrite.length === 0) {
    log.warn("no guest bookings to write — all rows filtered out");
    process.exit(0);
  }

  const sb = serviceClient();
  // Upsert in batches of 500 (Supabase REST has payload size limits)
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < rowsToWrite.length; i += BATCH) {
    const batch = rowsToWrite.slice(i, i + BATCH);
    const { error } = await sb
      .from("reservations_cache")
      .upsert(batch, { onConflict: "reservation_id", ignoreDuplicates: false });
    if (error) {
      log.fatal({ err: error, batch_start: i }, "batch upsert failed");
      process.exit(1);
    }
    written += batch.length;
    log.info({ written, total: rowsToWrite.length }, "batch written");
  }

  log.info({ written }, `ingest complete — ${written} reservations in cache`);
  process.exit(0);
}

main().catch((err) => {
  log.fatal(
    { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
    "ingest crashed",
  );
  process.exit(1);
});
