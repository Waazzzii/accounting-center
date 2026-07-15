/**
 * test-payout-scraper.ts — runs the OTA payout scraper against real
 * reservations_cache data and reports what it synthesized.
 *
 * What we expect against the existing 821 ingested Casago April 2026 stays:
 *   - groups by (channel, settlement_date)
 *   - one ota_payout_reports row per group, with line items per reservation
 *   - by-channel rollup (vrbo, airbnb, booking_com, direct)
 *   - The Toledo case (47421063, vrbo, $3,679, check_out 2026-04-13) should
 *     land in a vrbo synthetic payout dated 2026-04-15.
 */
import { serviceClient } from "@shared/supabase.js";
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "test-payout-scraper" });

async function main() {
  // Cleanup prior streamline-derived runs so the test is reproducible
  log.info("cleaning up prior streamline-derived runs...");
  const sb = serviceClient();
  await sb.from("ota_payout_reports").delete().eq("ingested_by", "payout-scraper");

  const scraperPath = "../src/agents/otaauditor/payout-scraper/index.ts";
  const mod = (await import(scraperPath)) as {
    default: {
      start: () => Promise<void>;
      stop: () => Promise<void>;
      runScrape: (opts?: { lookbackDays?: number }) => Promise<unknown>;
    };
  };
  await mod.default.start();
  await new Promise((r) => setTimeout(r, 500));

  log.info("running scrape with 90-day lookback...");
  const result = await mod.default.runScrape({ lookbackDays: 90 }) as {
    reservations_evaluated: number;
    reports_created: number;
    line_items_created: number;
    by_channel: Record<string, { reports: number; reservations: number; gross: number; net: number }>;
  };

  log.info("\n=========================================");
  log.info("SCRAPE SUMMARY");
  log.info("=========================================");
  log.info(`reservations evaluated     : ${result.reservations_evaluated}`);
  log.info(`payout reports created     : ${result.reports_created}`);
  log.info(`line items created         : ${result.line_items_created}`);
  for (const [channel, c] of Object.entries(result.by_channel)) {
    log.info(`${channel.padEnd(15)} reports=${c.reports.toString().padStart(3)}  reservations=${c.reservations.toString().padStart(4)}  gross=$${c.gross.toFixed(2).padStart(12)}  net=$${c.net.toFixed(2).padStart(12)}`);
  }

  // Look up the Toledo synthesized payout specifically
  const { data: toledoLineItems } = await sb
    .from("ota_payout_line_items")
    .select("line_item_id, channel, check_in, check_out, gross_amount, channel_fee, net_amount, ota_confirmation, raw_row, report_id")
    .eq("guest_name", "Jason Toledo")
    .order("check_in", { ascending: false })
    .limit(5);

  log.info("\n=========================================");
  log.info("TOLEDO LINE ITEM (real-data spot check)");
  log.info("=========================================");
  for (const li of toledoLineItems ?? []) {
    log.info(JSON.stringify(li, null, 2));
  }

  // Look up the synthesized vrbo payout report containing Toledo
  if (toledoLineItems && toledoLineItems.length > 0 && toledoLineItems[0]) {
    const reportId = toledoLineItems[0].report_id as string;
    const { data: report } = await sb
      .from("ota_payout_reports")
      .select("report_id, channel, payout_date, gross_amount, fees_amount, net_amount, line_item_count, status")
      .eq("report_id", reportId)
      .single();
    log.info("\nSynthesized payout containing Toledo:");
    log.info(JSON.stringify(report, null, 2));
  }

  await mod.default.stop();
  log.info("\nleaving synthesized payouts in DB so the matching engine can pick them up; rerun scraper to refresh");
  process.exit(0);
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err) }, "test crashed");
  process.exit(1);
});
