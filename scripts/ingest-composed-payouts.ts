/**
 * ingest-composed-payouts.ts — turn Streamline Wholesale Payment records
 * into composition-anchored ota_payout_reports for the matching engine.
 *
 * Usage:
 *   npx tsx scripts/ingest-composed-payouts.ts fixtures/streamline/wholesale-payments-<window>.json [--channel airbnb]
 *
 * Method (proven in the 2026-05-26 pilot, see docs/reference/
 * streamline-api-probe-results.md):
 *   - One payout batch = records sharing a notification timestamp (±TOLERANCE_S)
 *   - ACH settles notification-date + 1 business day
 *   - Folio payment amounts are ground truth (NOT reservation totals —
 *     alterations pay in parts)
 *
 * These composed payouts REPLACE the synthetic per-reservation Airbnb
 * estimates from payout-scraper within the fixture window: synthetic
 * airbnb reports whose payout_date falls inside the window are deleted
 * before inserting composed ones (idempotent on source_file_hash).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { serviceClient } from "@shared/supabase.js";
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "ingest-composed-payouts" });

const TOLERANCE_S = 10;               // records within ±10s share a batch

interface WpRecord {
  reservation_id: string;
  guest_name?: string;
  check_in?: string;
  amount: number | string;
  transaction_timestamp: string;      // full ISO timestamp of payout notification
  source?: string;
}

interface Fixture {
  pulled_at: string;
  window: { start: string; end: string };
  records: WpRecord[];
}

function addBusinessDays(dateIso: string, n: number): string {
  const d = new Date(`${dateIso.slice(0, 10)}T12:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

async function main() {
  const path = process.argv[2];
  const channelFlag = process.argv.indexOf("--channel");
  const channel = channelFlag > -1 ? process.argv[channelFlag + 1]! : "airbnb";
  if (!path) {
    log.error("usage: ingest-composed-payouts.ts <fixture.json> [--channel airbnb]");
    process.exit(1);
  }
  const fixture = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as Fixture;
  log.info({ records: fixture.records.length, window: fixture.window, channel }, "fixture loaded");

  // ---- Group records by notification timestamp (±TOLERANCE_S) --------------
  const sorted = [...fixture.records].sort(
    (a, b) => new Date(a.transaction_timestamp).getTime() - new Date(b.transaction_timestamp).getTime(),
  );
  const groups: WpRecord[][] = [];
  for (const rec of sorted) {
    const last = groups[groups.length - 1];
    if (
      last &&
      Math.abs(
        new Date(rec.transaction_timestamp).getTime() -
        new Date(last[last.length - 1]!.transaction_timestamp).getTime(),
      ) <= TOLERANCE_S * 1000
    ) {
      last.push(rec);
    } else {
      groups.push([rec]);
    }
  }
  log.info({ groups: groups.length }, "timestamp groups formed");

  const sb = serviceClient();

  // ---- Replace synthetic scraper payouts in the affected settle window -----
  const settleStart = fixture.window.start;
  const settleEnd = addBusinessDays(fixture.window.end, 3);
  const { count: deleted } = await sb
    .from("ota_payout_reports")
    .delete({ count: "exact" })
    .eq("channel", channel)
    .eq("ingested_by", "payout-scraper")
    .gte("payout_date", settleStart)
    .lte("payout_date", settleEnd);
  log.info({ deleted, settleStart, settleEnd }, "synthetic scraper payouts removed from window");

  // ---- Insert composed payout reports (idempotent on source_file_hash) -----
  let created = 0;
  let lineItems = 0;
  for (const g of groups) {
    const notifDate = g[0]!.transaction_timestamp.slice(0, 10);
    const settleDate = addBusinessDays(notifDate, 1);
    const gross = g.reduce((s, r) => s + Number(r.amount), 0);
    const ids = g.map((r) => r.reservation_id).sort();
    const hash = createHash("sha256")
      .update(`${channel}|${g[0]!.transaction_timestamp}|${ids.join(",")}`)
      .digest("hex");

    const { data: report, error } = await sb
      .from("ota_payout_reports")
      .upsert(
        {
          channel,
          report_period_start: notifDate,
          report_period_end: notifDate,
          payout_date: settleDate,
          gross_amount: round2(gross),
          fees_amount: 0,
          adjustments_amount: 0,
          net_amount: round2(gross),
          currency: "USD",
          line_item_count: g.length,
          source_file_hash: hash,
          ingested_by: "payout-composer",
          status: "ingested",
        },
        { onConflict: "channel,source_file_hash", ignoreDuplicates: false },
      )
      .select("report_id")
      .single();

    if (error || !report) {
      log.error({ err: error?.message, notifDate }, "report upsert failed");
      continue;
    }
    created++;

    // line items — replace any existing for this report
    await sb.from("ota_payout_line_items").delete().eq("report_id", report.report_id);
    const items = g.map((r) => ({
      report_id: report.report_id,
      channel,
      guest_name: r.guest_name ?? null,
      check_in: r.check_in ?? null,
      gross_amount: round2(Number(r.amount)),
      channel_fee: 0,
      net_amount: round2(Number(r.amount)),
      raw_row: {
        source: "streamline_folio_wholesale_payment",
        reservation_id: r.reservation_id,
        notification_timestamp: r.transaction_timestamp,
      },
    }));
    const { error: liErr } = await sb.from("ota_payout_line_items").insert(items);
    if (liErr) log.error({ err: liErr.message }, "line item insert failed");
    else lineItems += items.length;
  }

  log.info({ created, lineItems }, "composed payout ingest complete");
  process.exit(0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const isDirect = process.argv[1]?.endsWith("ingest-composed-payouts.ts");
if (isDirect) {
  main().catch((err) => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "crashed");
    process.exit(1);
  });
}
