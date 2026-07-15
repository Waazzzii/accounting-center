/**
 * ingest-sage-deposits.ts — transform Sage Intacct journal-entry lines on
 * bank GL accounts into bank_deposits rows (the "actual" side of the match).
 *
 * Usage:
 *   npx tsx scripts/ingest-sage-deposits.ts fixtures/sage/bank-lines-<window>.json
 *
 * Fixture shape (written by the Sage MCP pull — see ADR-002):
 *   {
 *     "pulled_at": "ISO",
 *     "window": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
 *     "lines": [
 *       { "gl_account": "102110", "id": "3625183", "entryDate": "2026-06-30",
 *         "txnType": "debit", "txnAmount": "5601.36",
 *         "description": "PREAUTHORIZED ACH CREDIT ...",
 *         "journalEntryId": "304487", "cleared": "false" }
 *     ]
 *   }
 *
 * Phase 1: hand-invoked after an MCP pull. Phase 2: the sage-deposit-sync
 * agent replaces this with a direct Sage REST poller (needs the Intacct
 * Sender ID). Downstream contract (bank_deposits upserts keyed on
 * source_system + bank_transaction_id) is identical.
 *
 * Sign convention: on an asset (bank) account, GL debit = cash IN.
 * bank_deposits.amount: positive = deposit, negative = withdrawal.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient } from "@shared/supabase.js";
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "ingest-sage-deposits" });

// ---------------------------------------------------------------------------
// Bank GL account map (from "Cash-management_checking-account" workbook +
// ADR-002). market intentionally left null until the payout side is
// market-aware — the matching engine buckets strictly by market and we
// don't want deposits and payouts landing in different buckets.
// ---------------------------------------------------------------------------

const BANK_GL_MAP: Record<string, { label: string; bankAccountId: string; region: "socal" | "arizona" | "all" }> = {
  "100011": { label: "ACME PHX SCT-9773",              bankAccountId: "7427919773", region: "arizona" },
  "100020": { label: "ACME SED FSTF-1793",             bankAccountId: "6566151793", region: "arizona" },
  "100040": { label: "ACME TUC AZ-3759",               bankAccountId: "7189313759", region: "arizona" },
  "100062": { label: "ACME CA Trust - 9147",           bankAccountId: "7898469147", region: "socal" },
  "100070": { label: "ACME CA INC-8890",               bankAccountId: "7898468890", region: "socal" },
  "100074": { label: "ACME CA OC Trust - 3267",        bankAccountId: "6731903267", region: "socal" },
  "100075": { label: "ACME CA OC ST - 0593",           bankAccountId: "7372510593", region: "socal" },
  "102110": { label: "ACME House Trust ST - 7272",     bankAccountId: "6850827272", region: "socal" },
  "102120": { label: "ACME House Trust LT - 1667",     bankAccountId: "7835191667", region: "socal" },
};

// ---------------------------------------------------------------------------
// Memo classification — patterns observed in real BofC feed memos (ADR-002)
// ---------------------------------------------------------------------------

type Classification =
  | "ota_deposit" | "possible_ota_deposit" | "merchant_deposit"
  | "internal_transfer" | "owner_distribution" | "refund" | "fee"
  | "tax_remittance" | "vendor_payment" | "unknown";

interface ClassResult {
  classification: Classification;
  confidence: number;              // 0..1
  otaSource: "airbnb" | "vrbo" | "booking_com" | "direct" | "other" | null;
  otaConfidence: number | null;
  counterparty: string | null;
}

const RULES: Array<{ pattern: RegExp; result: ClassResult }> = [
  // Reversed transactions — surface for review, never match (the underlying
  // and the reversal must reconcile to zero; exception-manager territory)
  { pattern: /^Reversed\s*--/i,
    result: { classification: "unknown", confidence: 0.9, otaSource: null, otaConfidence: null, counterparty: "REVERSAL — needs review" } },
  // Owner payout ACH batches (cash out) — 849 rows / -$933K in the Jun-Jul sample.
  // May variant: "PREAUTHORIZED ACH DEBIT ACME House Compa Apr 26 ACM" (per-month batch)
  { pattern: /ACH DEBIT\s*-\s*Owner Payments|ACH DEBIT ACME House Compa/i,
    result: { classification: "owner_distribution", confidence: 0.98, otaSource: null, otaConfidence: null, counterparty: "Owner payout batch" } },
  // Checks written from trust (vendor/owner checks)
  { pattern: /CHECK PAID/i,
    result: { classification: "vendor_payment", confidence: 0.85, otaSource: null, otaConfidence: null, counterparty: "Check" } },
  // Utility / municipal ACH debits from trust (Mgmt-CO-unit expense per OPM)
  { pattern: /DESERT WATER AGENCY|City of La Quint|SO CAL EDISON|SOCALGAS|COACHELLA VALLEY WATER/i,
    result: { classification: "vendor_payment", confidence: 0.9, otaSource: null, otaConfidence: null, counterparty: "Utility / municipality" } },
  // Amex chargebacks + collections clawbacks (cash out via BPal-Amex rail)
  { pattern: /AMERICAN EXPRESS\s+(CHGBCK\/ADJ|COLLECTION|AXP DISCNT)/i,
    result: { classification: "refund", confidence: 0.9, otaSource: null, otaConfidence: null, counterparty: "BPal-Amex clawback/chargeback/fee" } },
  // Tax remittances
  { pattern: /AZ DEPT OF REV|CITYOFPALMSPRING|CA DEPT TAX|CDTFA|DEPT OF REV/i,
    result: { classification: "tax_remittance", confidence: 0.95, otaSource: null, otaConfidence: null, counterparty: "Tax authority" } },
  // Lynnbrook merchant fees (cash out)
  { pattern: /MERCHANT FEE PAYMENT/i,
    result: { classification: "fee", confidence: 0.95, otaSource: null, otaConfidence: null, counterparty: "Lynnbrook (merchant fees)" } },
  // Lynnbrook merchant payouts — direct + VRBO card volume batched daily
  { pattern: /MERCHPAYOUT|TRACK\s+MERCHANT/i,
    result: { classification: "merchant_deposit", confidence: 0.97, otaSource: null, otaConfidence: null, counterparty: "Lynnbrook (Track Merchant)" } },
  // Sage-side distribution of Lynnbrook batches to market accounts
  { pattern: /Lynnbrook Transfer/i,
    result: { classification: "merchant_deposit", confidence: 0.85, otaSource: null, otaConfidence: null, counterparty: "Lynnbrook (transfer/distribution)" } },
  // Smaller OTA channels observed in the feed
  { pattern: /WHIMSTAY/i,
    result: { classification: "ota_deposit", confidence: 0.9, otaSource: "other", otaConfidence: 0.9, counterparty: "Whimstay" } },
  { pattern: /HOPPER\s+SHQ|CURRENCY CLOUD HOPPER/i,
    result: { classification: "ota_deposit", confidence: 0.85, otaSource: "other", otaConfidence: 0.85, counterparty: "Hopper" } },
  // Partner trust transfers
  { pattern: /HIGHDESERTTRAVEL|HIGH DESERT TRAVEL/i,
    result: { classification: "internal_transfer", confidence: 0.9, otaSource: null, otaConfidence: null, counterparty: "High Desert Travel trust" } },
  // Hopper-named internal transfer memos (TRF HOPPER = inter-account transfer, NOT the OTA)
  { pattern: /FUNDS TRANSFER FRMDEP|TRF HOPPER/i,
    result: { classification: "internal_transfer", confidence: 0.9, otaSource: null, otaConfidence: null, counterparty: "Internal / sweep" } },
  // BPal-Amex: BookingPal channel volume settling via American Express
  // (confirmed by Jason 2026-07-14 — this is a CHANNEL, not Lynnbrook)
  { pattern: /AMERICAN EXPRESS\s+SETTLEMENT/i,
    result: { classification: "ota_deposit", confidence: 0.9, otaSource: "other", otaConfidence: 0.85, counterparty: "BPal-Amex (BookingPal)" } },
  // CrewDogs — crew-housing OTA channel
  { pattern: /CREWDOGS|CREW\s*DOGS/i,
    result: { classification: "ota_deposit", confidence: 0.9, otaSource: "other", otaConfidence: 0.9, counterparty: "CrewDogs" } },
  // Channel payouts
  { pattern: /AIRBNB/i,
    result: { classification: "ota_deposit", confidence: 0.95, otaSource: "airbnb", otaConfidence: 0.95, counterparty: "Airbnb" } },
  { pattern: /VRBO|HOMEAWAY/i,
    result: { classification: "ota_deposit", confidence: 0.9, otaSource: "vrbo", otaConfidence: 0.9, counterparty: "VRBO/HomeAway" } },
  { pattern: /BOOKING\.?COM|BOOKING\s+BV/i,
    result: { classification: "ota_deposit", confidence: 0.9, otaSource: "booking_com", otaConfidence: 0.9, counterparty: "Booking.com" } },
  { pattern: /MARRIOTT/i,
    result: { classification: "ota_deposit", confidence: 0.9, otaSource: "other", otaConfidence: 0.9, counterparty: "Boost-Marriott" } },
  { pattern: /EXPEDIA/i,
    result: { classification: "ota_deposit", confidence: 0.85, otaSource: "other", otaConfidence: 0.85, counterparty: "Expedia" } },
  // Internal movement — never OTA-matched
  { pattern: /ZBA\s+(CREDIT|DEBIT)\s+TRANSFER|FUNDS TRANSFER TO DEP|RECLASS|BOOK TRANSFER/i,
    result: { classification: "internal_transfer", confidence: 0.95, otaSource: null, otaConfidence: null, counterparty: "Internal / sweep" } },
  // Bank fees & interest
  { pattern: /ANALYSIS\s+(SERVICE\s+)?CHARGE|SERVICE CHARGE|WIRE FEE|MAINTENANCE FEE/i,
    result: { classification: "fee", confidence: 0.9, otaSource: null, otaConfidence: null, counterparty: "Banc of California" } },
  // Wires — flag for review (acquisitions, one-offs, owner contributions)
  { pattern: /INCOMING WIRE/i,
    result: { classification: "unknown", confidence: 0.5, otaSource: null, otaConfidence: null, counterparty: null } },
];

export function classifyMemo(memo: string | null, txnType: "debit" | "credit"): ClassResult {
  if (!memo || !memo.trim()) {
    // Null memo = manual JE, not a bank-feed row
    return { classification: "unknown", confidence: 0.2, otaSource: null, otaConfidence: null, counterparty: null };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(memo)) return rule.result;
  }
  // Unmatched memo: cash IN could plausibly be an OTA deposit (surface it for
  // matching + review); cash OUT with an unrecognized memo is just unknown.
  return txnType === "debit"
    ? { classification: "possible_ota_deposit", confidence: 0.3, otaSource: null, otaConfidence: null, counterparty: null }
    : { classification: "unknown", confidence: 0.3, otaSource: null, otaConfidence: null, counterparty: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface FixtureLine {
  gl_account: string;
  id: string;
  entryDate: string;
  txnType: "debit" | "credit";
  txnAmount: string | number;
  description: string | null;
  journalEntryId?: string | null;
  cleared?: string | boolean | null;
}

interface Fixture {
  pulled_at: string;
  window: { start: string; end: string };
  lines: FixtureLine[];
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    log.error("usage: ingest-sage-deposits.ts <fixture.json>");
    process.exit(1);
  }
  const fixture = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as Fixture;
  log.info({ lines: fixture.lines.length, window: fixture.window }, "fixture loaded");

  const sb = serviceClient();
  const rows = [];
  const skipped: Record<string, number> = {};

  for (const line of fixture.lines) {
    const acct = BANK_GL_MAP[line.gl_account];
    if (!acct) {
      skipped[`unmapped_gl_${line.gl_account}`] = (skipped[`unmapped_gl_${line.gl_account}`] ?? 0) + 1;
      continue;
    }
    const cls = classifyMemo(line.description, line.txnType);
    const amountRaw = Number(line.txnAmount);
    // GL debit on an asset account = cash IN → positive deposit amount
    const amount = line.txnType === "debit" ? amountRaw : -amountRaw;

    rows.push({
      source_system: "sage_intacct",
      bank_name: "Banc of California",
      bank_account_id: acct.bankAccountId,
      bank_account_label: acct.label,
      bank_transaction_id: `sage-jel-${line.id}`,
      deposit_date: line.entryDate,
      amount,
      currency: "USD",
      memo: line.description,
      counterparty: cls.counterparty,
      classification: cls.classification,
      classification_confidence: cls.confidence,
      ota_source: cls.otaSource,
      ota_source_confidence: cls.otaConfidence,
      region: acct.region,
      market: null,
      raw_data: {
        sage_gl_account: line.gl_account,
        sage_journal_entry_id: line.journalEntryId ?? null,
        sage_line_id: line.id,
        sage_cleared: line.cleared ?? null,
        txn_type: line.txnType,
      },
      ingested_by: "ingest-sage-deposits",
    });
  }

  // Batched idempotent upsert
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("bank_deposits")
      .upsert(batch, { onConflict: "source_system,bank_transaction_id", ignoreDuplicates: false });
    if (error) {
      log.fatal({ err: error.message, batch_start: i }, "upsert failed");
      process.exit(1);
    }
    written += batch.length;
  }

  // Classification report
  const report: Record<string, { count: number; total: number }> = {};
  for (const r of rows) {
    const key = `${r.classification}${r.ota_source ? `:${r.ota_source}` : ""}`;
    if (!report[key]) report[key] = { count: 0, total: 0 };
    report[key].count++;
    report[key].total += r.amount;
  }

  log.info({ written, skipped }, "ingest complete");
  console.log("\n=== Classification report (deposits + withdrawals) ===");
  for (const [key, v] of Object.entries(report).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`${key.padEnd(28)} count=${String(v.count).padStart(4)}  net=$${v.total.toFixed(2).padStart(13)}`);
  }
  process.exit(0);
}

const isDirect = process.argv[1]?.endsWith("ingest-sage-deposits.ts");
if (isDirect) {
  main().catch((err) => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "ingest crashed");
    process.exit(1);
  });
}
