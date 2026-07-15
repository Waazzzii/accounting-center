/**
 * pilot-wholesale-payments.ts — PILOT: can Streamline "Wholesale Payment"
 * folio records reconstruct which reservations compose each Airbnb bank ACH?
 *
 * Target batch: 2026-05-26, GL 102110 (ACME House Trust ST-7272), ten
 * "AIRBNB PAYMENTST" ACHs. Airbnb releases payouts ~24h after check-in, so
 * contributing reservations should have check_in 2026-05-18..2026-05-26.
 *
 * Usage:  npx tsx scripts/pilot-wholesale-payments.ts
 *
 * Read-only: reservations_cache (Supabase) + Streamline GetReservationInfo
 * with show_payments_folio_history (same call shape as the MCP probe — see
 * docs/reference/streamline-api-probe-results.md).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient } from "@shared/supabase.js";
import { env } from "@shared/env.js";

const CHECK_IN_START = "2026-05-18";
const CHECK_IN_END = "2026-05-26";
const MAX_FETCH = 80;

// The ten AIRBNB PAYMENTST ACHs on GL 102110, 2026-05-26 (cents).
const ACH_AMOUNTS_CENTS = [
  3949022, 2997909, 2661215, 1612747, 790953, 640489, 295821, 172038, 97038, 88214,
];

// ACME House market (Coachella Valley) — fetch these first.
const PRIORITY_MARKETS =
  /palm springs|palm desert|la quinta|indio|rancho mirage|cathedral city/i;

// ---------------------------------------------------------------------------
// Streamline JSON API (same GetReservationInfo shape the MCP probe validated)
// ---------------------------------------------------------------------------

const API_BASE = env.STREAMLINE_API_URL ?? "https://api.streamlinevrs.com";

async function slCall(methodName: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API_BASE}/api/json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      methodName,
      params: {
        token_key: env.STREAMLINE_API_KEY,
        token_secret: env.STREAMLINE_API_SECRET,
        ...params,
      },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${methodName}`);
  return res.json();
}

function parseMoneyToCents(s: string): number {
  // "-$1,234.56" -> 123456 (abs)
  const n = Number(s.replace(/[$,\s]/g, ""));
  if (Number.isNaN(n)) throw new Error(`unparseable amount: ${s}`);
  return Math.abs(Math.round(n * 100));
}

interface WholesaleRecord {
  reservation_id: string;
  confirmation_id: string;
  guest_name: string | null;
  property_name: string | null;
  check_in: string;
  amount: number; // dollars, positive
  amount_cents: number;
  folio_date: string | null; // when Streamline posted it
  transaction_date: string | null; // payout-notification timestamp
  payment_description: string | null;
}

// ---------------------------------------------------------------------------
// 1. List candidate reservations from reservations_cache
// ---------------------------------------------------------------------------

async function listCandidates() {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("reservations_cache")
    .select("reservation_id, confirmation_code, guest_name, check_in, total_amount, property_name, status")
    .eq("channel", "airbnb")
    .gte("check_in", CHECK_IN_START)
    .lte("check_in", CHECK_IN_END)
    .order("check_in", { ascending: true });
  if (error) throw new Error(`reservations_cache query failed: ${error.message}`);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// 2. Per-reservation folio fetch → Wholesale Payment records
// ---------------------------------------------------------------------------

async function fetchWholesale(resv: any): Promise<WholesaleRecord[] | { error: string }> {
  const json = await slCall("GetReservationInfo", {
    confirmation_id: Number(resv.confirmation_code),
    show_payments_folio_history: true,
    return_payments: true,
  });
  const d = json?.data;
  if (!d || d.status?.code && d.status.code !== "E0000" && !d.confirmation_id) {
    return { error: JSON.stringify(d?.status ?? json).slice(0, 200) };
  }
  let recs = d.payments_folio_history?.record ?? [];
  if (!Array.isArray(recs)) recs = [recs];
  return recs
    .filter((r: any) => r.type === "Wholesale Payment")
    .map((r: any) => {
      const cents = parseMoneyToCents(String(r.amount));
      return {
        reservation_id: String(resv.reservation_id),
        confirmation_id: String(resv.confirmation_code),
        guest_name: resv.guest_name ?? null,
        property_name: resv.property_name ?? null,
        check_in: resv.check_in,
        amount: cents / 100,
        amount_cents: cents,
        folio_date: r.date ?? null,
        transaction_date: r.transaction_date ?? null,
        payment_description: r.payment_description ?? null,
      };
    });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// 3. Subset-sum matcher: which records compose each ACH?
//    Partition approach: largest ACH first, records used at most once.
// ---------------------------------------------------------------------------

interface AchMatch {
  ach_amount: number;
  status: "matched" | "unexplained";
  delta_cents: number | null;
  reservation_ids: string[];
  sum: number | null;
}

function subsetSum(records: WholesaleRecord[], targetCents: number, toleranceCents: number):
  { indices: number[]; sum: number } | null {
  const max = targetCents + toleranceCents;
  const reach = new Uint8Array(max + 1);
  const usedItem = new Int32Array(max + 1).fill(-1);
  reach[0] = 1;
  records.forEach((rec, idx) => {
    const a = rec.amount_cents;
    if (a === 0 || a > max) return;
    for (let s = max; s >= a; s--) {
      if (!reach[s] && reach[s - a]) {
        reach[s] = 1;
        usedItem[s] = idx;
      }
    }
  });
  // Prefer exact, then nearest within tolerance.
  let best = -1;
  for (let d = 0; d <= toleranceCents; d++) {
    if (targetCents - d >= 0 && reach[targetCents - d]) { best = targetCents - d; break; }
    if (targetCents + d <= max && reach[targetCents + d]) { best = targetCents + d; break; }
  }
  if (best <= 0) return null;
  const indices: number[] = [];
  let s = best;
  while (s > 0) {
    const idx = usedItem[s];
    if (idx < 0) return null; // shouldn't happen
    indices.push(idx);
    s -= records[idx].amount_cents;
  }
  return { indices, sum: best };
}

function decompose(records: WholesaleRecord[]): { matches: AchMatch[]; usedIdx: Set<number> } {
  const remaining = records.map((_, i) => i);
  const usedIdx = new Set<number>();
  const matches: AchMatch[] = [];
  const targets = [...ACH_AMOUNTS_CENTS].sort((a, b) => b - a);
  for (const target of targets) {
    const pool = remaining.filter((i) => !usedIdx.has(i));
    const poolRecs = pool.map((i) => records[i]);
    const hit = subsetSum(poolRecs, target, 100); // within $1
    if (hit) {
      const globalIdx = hit.indices.map((j) => pool[j]);
      globalIdx.forEach((i) => usedIdx.add(i));
      matches.push({
        ach_amount: target / 100,
        status: "matched",
        delta_cents: hit.sum - target,
        reservation_ids: globalIdx.map((i) => records[i].reservation_id),
        sum: hit.sum / 100,
      });
    } else {
      matches.push({ ach_amount: target / 100, status: "unexplained", delta_cents: null, reservation_ids: [], sum: null });
    }
  }
  return { matches, usedIdx };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * cache mode: the direct-API creds in .env are stale (E0010), so folio pulls
 * go through the Streamline MCP instead. This mode does the cache-side work:
 * list candidates and decompose the ten ACHs against reservation totals
 * (probe evidence: Wholesale Payment amount == price_total == cache
 * total_amount). Folio validation of matched members happens via MCP.
 */
async function mainCacheOnly() {
  const candidates = await listCandidates();
  console.log(`\n=== reservations_cache airbnb check_in ${CHECK_IN_START}..${CHECK_IN_END}: ${candidates.length} rows ===`);
  for (const r of candidates) {
    console.log(
      `${r.reservation_id}\tconf=${r.confirmation_code}\t${r.check_in}\t$${Number(r.total_amount).toFixed(2)}\t${r.status}\t${r.guest_name}\t${r.property_name}`,
    );
  }
  const records: WholesaleRecord[] = candidates
    .filter((r) => r.confirmation_code)
    .map((r) => {
      const cents = Math.round(Number(r.total_amount) * 100);
      return {
        reservation_id: String(r.reservation_id),
        confirmation_id: String(r.confirmation_code),
        guest_name: r.guest_name ?? null,
        property_name: r.property_name ?? null,
        check_in: r.check_in,
        amount: cents / 100,
        amount_cents: cents,
        folio_date: null,
        transaction_date: null,
        payment_description: null,
      };
    });
  console.log(`\n=== ACH decomposition on cache total_amount (exact-cent first, then $1 tolerance) ===`);
  const { matches, usedIdx } = decompose(records);
  for (const m of matches.sort((a, b) => b.ach_amount - a.ach_amount)) {
    if (m.status === "matched") {
      const members = m.reservation_ids
        .map((id) => records.find((r) => r.reservation_id === id)!)
        .sort((a, b) => a.check_in.localeCompare(b.check_in));
      console.log(`ACH $${m.ach_amount.toFixed(2)}  MATCHED sum=$${m.sum!.toFixed(2)} delta=${m.delta_cents}c  n=${members.length}`);
      for (const r of members) {
        console.log(`   conf=${r.confirmation_id}\t$${r.amount.toFixed(2)}\tci=${r.check_in}\t${r.property_name}`);
      }
    } else {
      console.log(`ACH $${m.ach_amount.toFixed(2)}  UNEXPLAINED`);
    }
  }
  const unused = records.filter((_, i) => !usedIdx.has(i));
  console.log(`\nUnassigned reservations: ${unused.length} of ${records.length}`);
  const matchedTotal = matches.filter((m) => m.status === "matched").reduce((a, m) => a + Math.round(m.ach_amount * 100), 0);
  const achTotal = ACH_AMOUNTS_CENTS.reduce((a, b) => a + b, 0);
  console.log(`ACH total $${(achTotal / 100).toFixed(2)}; explained $${(matchedTotal / 100).toFixed(2)} (${((matchedTotal / achTotal) * 100).toFixed(1)}%)`);
}

async function main() {
  if (process.argv[2] === "--cache-only") {
    await mainCacheOnly();
    return;
  }
  // ---- Step 1: candidates -------------------------------------------------
  const candidates = await listCandidates();
  console.log(`\n=== Step 1: reservations_cache airbnb check_in ${CHECK_IN_START}..${CHECK_IN_END}: ${candidates.length} rows ===`);
  for (const r of candidates) {
    console.log(
      `${r.reservation_id}\tconf=${r.confirmation_code}\t${r.check_in}\t$${Number(r.total_amount).toFixed(2)}\t${r.status}\t${r.guest_name}\t${r.property_name}`,
    );
  }

  // ---- Step 2: prioritize ACME market, cap MAX_FETCH ----------------------
  const withConf = candidates.filter((r) => r.confirmation_code);
  const priority = withConf.filter((r) => PRIORITY_MARKETS.test(r.property_name ?? ""));
  const rest = withConf.filter((r) => !PRIORITY_MARKETS.test(r.property_name ?? ""));
  const toFetch = [...priority, ...rest].slice(0, MAX_FETCH);
  console.log(`\n=== Step 2: fetching folio history for ${toFetch.length} (priority-market: ${priority.length}) ===`);

  const errors: Record<string, string> = {};
  const results = await mapLimit(toFetch, 5, async (r) => {
    try {
      const out = await fetchWholesale(r);
      if ("error" in out) { errors[String(r.reservation_id)] = out.error; return []; }
      return out;
    } catch (e: any) {
      errors[String(r.reservation_id)] = e.message;
      return [];
    }
  });
  const records = results.flat();
  console.log(`Wholesale Payment records extracted: ${records.length} (errors: ${Object.keys(errors).length})`);
  for (const [id, msg] of Object.entries(errors)) console.log(`  ERROR ${id}: ${msg}`);

  // ---- Step 3: fixture -----------------------------------------------------
  const fixture = {
    pulled_at: new Date().toISOString(),
    window: {
      check_in_start: CHECK_IN_START,
      check_in_end: CHECK_IN_END,
      ach_settlement_date: "2026-05-26",
      gl_account: "102110",
    },
    records,
  };
  const outPath = resolve("fixtures/streamline/wholesale-payments-pilot.json");
  mkdirSync(resolve("fixtures/streamline"), { recursive: true });
  writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`\nFixture written: ${outPath}`);

  // ---- Step 4: group by payout-notification timestamp ---------------------
  console.log(`\n=== Step 4: records grouped by transaction_date (payout notification) ===`);
  const byTs = new Map<string, WholesaleRecord[]>();
  for (const rec of records) {
    const key = rec.transaction_date ?? "(none)";
    if (!byTs.has(key)) byTs.set(key, []);
    byTs.get(key)!.push(rec);
  }
  const tsKeys = [...byTs.keys()].sort();
  for (const k of tsKeys) {
    const g = byTs.get(k)!;
    const sum = g.reduce((a, r) => a + r.amount_cents, 0);
    console.log(`${k}\tn=${g.length}\tsum=$${(sum / 100).toFixed(2)}`);
  }

  // ---- Step 5: decompose the ten ACHs --------------------------------------
  console.log(`\n=== Step 5: ACH decomposition (subset-sum within $1, each record used once) ===`);
  const { matches, usedIdx } = decompose(records);
  for (const m of matches.sort((a, b) => b.ach_amount - a.ach_amount)) {
    if (m.status === "matched") {
      const members = m.reservation_ids
        .map((id) => records.find((r) => r.reservation_id === id))
        .map((r) => `${r!.reservation_id}($${r!.amount.toFixed(2)}, ci ${r!.check_in})`);
      console.log(`ACH $${m.ach_amount.toFixed(2)}  MATCHED sum=$${m.sum!.toFixed(2)} delta=${m.delta_cents}c  n=${m.reservation_ids.length}`);
      console.log(`   ${members.join(", ")}`);
    } else {
      console.log(`ACH $${m.ach_amount.toFixed(2)}  UNEXPLAINED`);
    }
  }
  const unused = records.filter((_, i) => !usedIdx.has(i));
  const unusedSum = unused.reduce((a, r) => a + r.amount_cents, 0);
  console.log(`\nRecords not assigned to any ACH: ${unused.length} (sum $${(unusedSum / 100).toFixed(2)})`);
  for (const r of unused) {
    console.log(`  ${r.reservation_id}\t$${r.amount.toFixed(2)}\ttxn=${r.transaction_date}\tci=${r.check_in}\t${r.property_name}`);
  }
  const achTotal = ACH_AMOUNTS_CENTS.reduce((a, b) => a + b, 0);
  const matchedTotal = matches.filter((m) => m.status === "matched").reduce((a, m) => a + Math.round(m.ach_amount * 100), 0);
  console.log(`\nACH total $${(achTotal / 100).toFixed(2)}; explained $${(matchedTotal / 100).toFixed(2)} (${((matchedTotal / achTotal) * 100).toFixed(1)}%)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
