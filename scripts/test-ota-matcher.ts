/**
 * test-ota-matcher.ts — synthetic 3-way fixture test for the OTA matching engine.
 *
 * Seeds 5 scenarios into ota_payout_reports + bank_deposits, runs the sweep,
 * inspects the resulting matches + unmatched + exceptions. Cleans up after.
 *
 * Scenarios:
 *   1. Clean exact match          (Airbnb $2,400.00 @ 2026-04-10)
 *   2. Fuzzy high match           (VRBO $3,679.00 → deposit $3,678.98, +1 day)
 *   3. Split payout               (1 payout $5,000 → 2 deposits $2,000 + $3,000)
 *   4. Batched deposit            (2 payouts $1,500 + $2,500 → 1 deposit $4,000)
 *   5. Orphan payout + orphan deposit (unmatched items to exercise aging)
 *
 * Expected outcome:
 *   6 matches (1 exact + 1 fuzzy + 1 split + 1 batched + duplicate detection maybe)
 *   2 unmatched (orphan payout, orphan deposit)
 */
import { serviceClient } from "@shared/supabase.js";
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "test-ota-matcher" });

// All fixture ids use a deterministic prefix so cleanup is surgical
const FIXTURE_TAG = "ota-matcher-test";

async function cleanup() {
  const sb = serviceClient();
  // Delete in dependency order
  await sb.from("ota_match_exceptions").delete().like("summary", "%ota-matcher-test%");
  // ota_matches references payout/deposit ids; delete matches whose payouts/deposits will go
  // (we'll delete by correlation_id below)
  await sb.from("ota_unmatched").delete().in("entity_type", ["payout","deposit"])
    .contains("reason", FIXTURE_TAG);
  // Wipe test payout_reports (CASCADE removes line items)
  await sb.from("ota_payout_reports").delete().eq("ingested_by", FIXTURE_TAG);
  // Wipe test deposits
  await sb.from("bank_deposits").delete().eq("ingested_by", FIXTURE_TAG);
  // Clear matches created for test correlation_ids
  await sb.from("ota_matches").delete().eq("created_by", "matching-engine")
    .contains("score_breakdown" as never, { test_fixture: FIXTURE_TAG });
}

async function seed() {
  const sb = serviceClient();
  const today = new Date().toISOString().slice(0, 10);
  const iso = (d: number) => {
    const t = new Date();
    t.setDate(t.getDate() - d);
    return t.toISOString().slice(0, 10);
  };

  // --- Scenario 1: Clean exact match ---------------------------------------
  // Airbnb $2,400.00 on 2026-04-10 → deposit same amount/date
  const { data: p1 } = await sb.from("ota_payout_reports").insert({
    channel: "airbnb",
    report_period_start: iso(12),
    report_period_end: iso(10),
    payout_date: iso(10),
    gross_amount: 2500,
    fees_amount: 100,
    adjustments_amount: 0,
    net_amount: 2400,
    currency: "USD",
    source_file_hash: `${FIXTURE_TAG}-p1-${Date.now()}`,
    ingested_by: FIXTURE_TAG,
    status: "ingested",
  }).select("report_id").single();

  await sb.from("bank_deposits").insert({
    source_system: "csv_import",
    bank_name: "Test Bank",
    bank_account_id: "test-account-cv",
    bank_transaction_id: `${FIXTURE_TAG}-d1-${Date.now()}`,
    deposit_date: iso(10),
    amount: 2400,
    currency: "USD",
    counterparty: "AIRBNB PAYMENTS",
    classification: "ota_deposit",
    classification_confidence: 0.98,
    ota_source: "airbnb",
    ota_source_confidence: 0.99,
    memo: "Airbnb payout ref 12345",
    raw_data: { scenario: "1-exact" },
    ingested_by: FIXTURE_TAG,
  });

  // --- Scenario 2: Fuzzy high match ----------------------------------------
  // VRBO $3,679.00 paid 2026-04-08 → deposit $3,678.98 on 2026-04-09
  // Expected: amount off by $0.02 (0.05%), date off by 1 day → ~97
  const { data: p2 } = await sb.from("ota_payout_reports").insert({
    channel: "vrbo",
    report_period_start: iso(10),
    report_period_end: iso(8),
    payout_date: iso(8),
    gross_amount: 3900,
    fees_amount: 221,
    adjustments_amount: 0,
    net_amount: 3679,
    currency: "USD",
    source_file_hash: `${FIXTURE_TAG}-p2-${Date.now()}`,
    ingested_by: FIXTURE_TAG,
    status: "ingested",
  }).select("report_id").single();

  await sb.from("bank_deposits").insert({
    source_system: "csv_import",
    bank_name: "Test Bank",
    bank_account_id: "test-account-cv",
    bank_transaction_id: `${FIXTURE_TAG}-d2-${Date.now()}`,
    deposit_date: iso(7),
    amount: 3678.98,
    currency: "USD",
    counterparty: "VRBO HOMEAWAY",
    classification: "ota_deposit",
    classification_confidence: 0.92,
    ota_source: "vrbo",
    ota_source_confidence: 0.90,
    memo: "VRBO-HA settlement",
    raw_data: { scenario: "2-fuzzy" },
    ingested_by: FIXTURE_TAG,
  });

  // --- Scenario 3: Split payout (1 payout → 2 deposits) --------------------
  // Booking.com $5,000 → deposits $2,000 + $3,000 on same day
  const { data: p3 } = await sb.from("ota_payout_reports").insert({
    channel: "booking_com",
    report_period_start: iso(8),
    report_period_end: iso(6),
    payout_date: iso(6),
    gross_amount: 5500,
    fees_amount: 500,
    adjustments_amount: 0,
    net_amount: 5000,
    currency: "USD",
    source_file_hash: `${FIXTURE_TAG}-p3-${Date.now()}`,
    ingested_by: FIXTURE_TAG,
    status: "ingested",
  }).select("report_id").single();

  await sb.from("bank_deposits").insert([
    {
      source_system: "csv_import",
      bank_name: "Test Bank",
      bank_account_id: "test-account-cv",
      bank_transaction_id: `${FIXTURE_TAG}-d3a-${Date.now()}`,
      deposit_date: iso(6),
      amount: 2000,
      currency: "USD",
      counterparty: "BOOKING.COM BV",
      classification: "ota_deposit",
      classification_confidence: 0.95,
      ota_source: "booking_com",
      ota_source_confidence: 0.95,
      memo: "Booking.com part 1",
      raw_data: { scenario: "3-split" },
      ingested_by: FIXTURE_TAG,
    },
    {
      source_system: "csv_import",
      bank_name: "Test Bank",
      bank_account_id: "test-account-cv",
      bank_transaction_id: `${FIXTURE_TAG}-d3b-${Date.now()}`,
      deposit_date: iso(6),
      amount: 3000,
      currency: "USD",
      counterparty: "BOOKING.COM BV",
      classification: "ota_deposit",
      classification_confidence: 0.95,
      ota_source: "booking_com",
      ota_source_confidence: 0.95,
      memo: "Booking.com part 2",
      raw_data: { scenario: "3-split" },
      ingested_by: FIXTURE_TAG,
    },
  ]);

  // --- Scenario 4: Batched deposit (2 payouts → 1 deposit) -----------------
  // 2 Airbnb payouts ($1,500 + $2,500) batched into 1 deposit of $4,000
  await sb.from("ota_payout_reports").insert([
    {
      channel: "airbnb",
      report_period_start: iso(6),
      report_period_end: iso(4),
      payout_date: iso(4),
      gross_amount: 1600,
      fees_amount: 100,
      adjustments_amount: 0,
      net_amount: 1500,
      currency: "USD",
      source_file_hash: `${FIXTURE_TAG}-p4a-${Date.now()}`,
      ingested_by: FIXTURE_TAG,
      status: "ingested",
    },
    {
      channel: "airbnb",
      report_period_start: iso(6),
      report_period_end: iso(4),
      payout_date: iso(4),
      gross_amount: 2700,
      fees_amount: 200,
      adjustments_amount: 0,
      net_amount: 2500,
      currency: "USD",
      source_file_hash: `${FIXTURE_TAG}-p4b-${Date.now()}`,
      ingested_by: FIXTURE_TAG,
      status: "ingested",
    },
  ]);

  await sb.from("bank_deposits").insert({
    source_system: "csv_import",
    bank_name: "Test Bank",
    bank_account_id: "test-account-cv",
    bank_transaction_id: `${FIXTURE_TAG}-d4-${Date.now()}`,
    deposit_date: iso(4),
    amount: 4000,
    currency: "USD",
    counterparty: "AIRBNB PAYMENTS",
    classification: "ota_deposit",
    classification_confidence: 0.97,
    ota_source: "airbnb",
    ota_source_confidence: 0.97,
    memo: "Airbnb batch settlement",
    raw_data: { scenario: "4-batched" },
    ingested_by: FIXTURE_TAG,
  });

  // --- Scenario 5: Orphan payout + orphan deposit --------------------------
  // Payout with no matching deposit; deposit with no matching payout
  await sb.from("ota_payout_reports").insert({
    channel: "vrbo",
    report_period_start: iso(5),
    report_period_end: iso(3),
    payout_date: iso(3),
    gross_amount: 1100,
    fees_amount: 100,
    adjustments_amount: 0,
    net_amount: 1000,
    currency: "USD",
    source_file_hash: `${FIXTURE_TAG}-p5-${Date.now()}`,
    ingested_by: FIXTURE_TAG,
    status: "ingested",
  });
  await sb.from("bank_deposits").insert({
    source_system: "csv_import",
    bank_name: "Test Bank",
    bank_account_id: "test-account-cv",
    bank_transaction_id: `${FIXTURE_TAG}-d5-${Date.now()}`,
    deposit_date: iso(3),
    amount: 777.77,
    currency: "USD",
    counterparty: "UNKNOWN",
    classification: "possible_ota_deposit",
    classification_confidence: 0.35,
    ota_source: null,
    ota_source_confidence: null,
    memo: "ACH CREDIT",
    raw_data: { scenario: "5-orphan" },
    ingested_by: FIXTURE_TAG,
  });

  return { p1: p1?.report_id, p2: p2?.report_id, p3: p3?.report_id, today };
}

async function main() {
  log.info("cleaning up prior test fixtures...");
  await cleanup();

  log.info("seeding 5 test scenarios...");
  await seed();

  log.info("starting matching-engine...");
  // Path as variable so tsc doesn't flag the .ts extension
  const matcherPath = "../src/agents/otaauditor/matching-engine/index.ts";
  const mod = (await import(matcherPath)) as {
    default: {
      start: () => Promise<void>;
      stop: () => Promise<void>;
      runSweep: (opts?: { windowDays?: number }) => Promise<unknown>;
    };
  };
  await mod.default.start();
  await new Promise((r) => setTimeout(r, 500));

  log.info("triggering sweep...");
  const result = await mod.default.runSweep({ windowDays: 30 });
  log.info({ result }, "sweep result");

  // Inspect outcomes
  const sb = serviceClient();
  const { data: matches } = await sb
    .from("ota_matches")
    .select("match_id, match_type, confidence, total_payout_amount, total_deposit_amount, variance_amount, payout_ids, deposit_ids, reasoning")
    .eq("created_by", "matching-engine")
    .order("created_at", { ascending: false })
    .limit(20);

  // Unmatched: query by recent rather than FIXTURE_TAG (reason text doesn't carry the tag)
  const recentCutoff = new Date(Date.now() - 60_000).toISOString();
  const { data: recentUnmatched } = await sb
    .from("ota_unmatched")
    .select("entity_type, entity_id, category, severity, age_days, reason")
    .gte("detected_at", recentCutoff)
    .order("detected_at", { ascending: false })
    .limit(20);

  const { data: exceptions } = await sb
    .from("ota_match_exceptions")
    .select("exception_type, severity, summary")
    .gte("detected_at", recentCutoff)
    .order("detected_at", { ascending: false })
    .limit(20);

  log.info("\n===========================================");
  log.info("MATCHES");
  log.info("===========================================");
  for (const m of matches ?? []) {
    log.info(
      `${m.match_type.padEnd(18)} confidence=${m.confidence} payout=${m.total_payout_amount} deposit=${m.total_deposit_amount} variance=${m.variance_amount}  [${(m.payout_ids as string[]).length} payouts → ${(m.deposit_ids as string[]).length} deposits]`,
    );
    log.info(`   reasoning: ${m.reasoning}`);
  }

  log.info("\n===========================================");
  log.info("UNMATCHED (recent 60s)");
  log.info("===========================================");
  for (const u of recentUnmatched ?? []) {
    log.info(`${u.entity_type.padEnd(8)} ${u.category.padEnd(28)} severity=${u.severity} age=${u.age_days}d  ${u.reason}`);
  }

  log.info("\n===========================================");
  log.info("EXCEPTIONS");
  log.info("===========================================");
  for (const e of exceptions ?? []) {
    log.info(`${e.exception_type.padEnd(20)} severity=${e.severity}  ${e.summary}`);
  }

  await mod.default.stop();
  // Keep data in-place so user can inspect; run with --cleanup to wipe
  if (process.argv.includes("--cleanup")) {
    log.info("cleaning up fixtures...");
    await cleanup();
  } else {
    log.info("leaving fixtures in DB for inspection; rerun with --cleanup to wipe");
  }
  process.exit(0);
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "test crashed");
  process.exit(1);
});
