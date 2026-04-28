/**
 * payout-scraper — synthesizes "expected OTA payout reports" from data we
 * already have. Feeds the matching-engine.
 *
 * Adapter pattern (only one wired today; others slot in identically):
 *
 *   streamline-derived  ✅  Aggregates reservations_cache by (channel,
 *                          settlement_date). Works today with real Casago
 *                          data. Treats Streamline as the source of truth
 *                          for Airbnb payouts since Airbnb's public API
 *                          was discontinued (Streamline integrates as a
 *                          channel-manager partner).
 *
 *   csv-import          🚧  Pending. Drop-in adapter that parses Lynnbrook /
 *                          VRBO / Booking.com / Airbnb earnings statement
 *                          CSVs from `fixtures/ota-payouts/<channel>/*.csv`.
 *                          Same output shape; adapter files plug in here.
 *
 *   airbnb-api          ❌  Not viable — Airbnb killed the public API.
 *
 * Output shape: ota_payout_reports + ota_payout_line_items rows.
 * Idempotency: source_file_hash = sha256(channel + settlement_date + sorted ids)
 *
 * Triggers:
 *   - `otaauditor.scraper.poll` event
 *   - Direct method call (tests + manual sweeps)
 */
import {
  AgentBase,
  type AgentIdentity,
  serviceClient,
  sha256Hex,
} from "@shared/index.js";

const IDENTITY: AgentIdentity = {
  product: "otaauditor",
  slug: "payout-scraper",
  display_name: "OTA Payout Scraper",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How many days after check-out we expect each channel to settle.
 * These are estimates — real settlement varies by channel-manager rules,
 * weekends, and ACH cutoffs. The matching engine's date_variance_days
 * tolerance absorbs the slop.
 */
const CHANNEL_SETTLEMENT_LAG_DAYS: Record<string, number> = {
  airbnb:      1,    // ~24h after check-in (Airbnb policy)
  vrbo:        2,    // ~next business day after check-in via Lynnbrook
  booking_com: 30,   // monthly invoice in arrears
  direct:      1,    // Stripe / Lynnbrook next business day
};

/**
 * Estimated host fee per channel — applied to gross to derive expected net.
 * Real fees vary by host program (Airbnb host-only, Airbnb split-fee,
 * VRBO subscription vs pay-per-booking). These are placeholders;
 * ota_channel_fees table is the source of truth once populated per-property.
 */
const CHANNEL_HOST_FEE_PCT: Record<string, number> = {
  airbnb:      0.03,   // host-only fee model
  vrbo:        0.05,   // pay-per-booking
  booking_com: 0.15,   // commission model
  direct:      0.029,  // Stripe / Lynnbrook ~2.9% + $0.30
};

const DEFAULT_LOOKBACK_DAYS = 30;
const SUPPORTED_CHANNELS = ["airbnb", "vrbo", "booking_com", "direct"] as const;
type SupportedChannel = (typeof SUPPORTED_CHANNELS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReservationCacheRow {
  reservation_id: string;
  channel: string | null;
  check_in: string;
  check_out: string;
  total_amount: number;
  currency: string;
  property_id: string | null;
  property_name: string | null;
  guest_name: string;
  confirmation_code: string | null;
  status: string | null;
}

interface SynthesizedPayout {
  channel: SupportedChannel;
  settlement_date: string;       // estimated payout date
  period_start: string;          // earliest check_out in batch
  period_end: string;            // latest check_out in batch
  gross_amount: number;
  fees_amount: number;
  net_amount: number;
  line_items: Array<{
    reservation_id: string;
    confirmation_code: string | null;
    guest_name: string;
    property_id: string | null;
    check_in: string;
    check_out: string;
    nights: number;
    gross_amount: number;
    fee_amount: number;
    net_amount: number;
  }>;
  source_file_hash: string;      // deterministic for idempotency
}

interface ScrapeResult {
  run_id: string;
  reservations_evaluated: number;
  reports_created: number;
  reports_skipped_existing: number;
  line_items_created: number;
  by_channel: Record<string, { reports: number; reservations: number; gross: number; net: number }>;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class OtaPayoutScraper extends AgentBase {
  private unsubs: Array<() => void> = [];

  constructor() {
    super(IDENTITY);
  }

  protected async onStart(): Promise<void> {
    this.unsubs.push(
      this.on({ event_type: "otaauditor.scraper.poll" }, async (ev) => {
        const cid = ev.correlation_id ?? ev.event_id;
        const payload = ev.payload as { lookback_days?: number } | undefined;
        const days = payload?.lookback_days ?? DEFAULT_LOOKBACK_DAYS;
        this.log.info({ cid, days }, "scraper.poll received");
        await this.runScrape({ correlationId: cid, lookbackDays: days });
      }),
    );
    this.log.info("payout-scraper online — listening for otaauditor.scraper.poll");
  }

  protected async onStop(): Promise<void> {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.log.info("payout-scraper stopped");
  }

  // -------------------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------------------

  public async runScrape(opts: {
    correlationId?: string;
    lookbackDays?: number;
    sinceDate?: string;
  } = {}): Promise<ScrapeResult> {
    const cid = opts.correlationId ?? crypto.randomUUID();
    const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const since = opts.sinceDate ?? shiftDate(today(), -lookbackDays);
    const runId = `scrape-${today()}-${crypto.randomUUID().slice(0, 8)}`;

    this.log.info({ cid, runId, since }, "scrape starting (streamline-derived adapter)");

    // -- Phase 1: load reservations -------------------------------------------
    const reservations = await this.loadReservations(since);
    this.log.info({ count: reservations.length }, "reservations loaded");

    // -- Phase 2: synthesize payouts -----------------------------------------
    const synthesized = synthesizePayouts(reservations);

    // -- Phase 3: persist (idempotent on source_file_hash) -------------------
    const sb = serviceClient();
    const byChannel: Record<string, { reports: number; reservations: number; gross: number; net: number }> = {};
    let reportsCreated = 0;
    let reportsSkipped = 0;
    let lineItemsCreated = 0;

    for (const p of synthesized) {
      // Try to insert; if source_file_hash conflict, skip
      const { data: report, error: reportErr } = await sb
        .from("ota_payout_reports")
        .upsert(
          {
            channel: p.channel,
            report_period_start: p.period_start,
            report_period_end: p.period_end,
            payout_date: p.settlement_date,
            gross_amount: p.gross_amount,
            fees_amount: p.fees_amount,
            adjustments_amount: 0,
            net_amount: p.net_amount,
            currency: "USD",
            line_item_count: p.line_items.length,
            source_file_path: `streamline-derived://${runId}`,
            source_file_hash: p.source_file_hash,
            ingested_by: IDENTITY.slug,
            status: "ingested",
          },
          { onConflict: "channel,source_file_hash", ignoreDuplicates: false },
        )
        .select("report_id")
        .single();

      if (reportErr) {
        // Conflict (already exists) — skip line item insert
        this.log.debug({ err: reportErr.message, hash: p.source_file_hash }, "report skipped (likely existing)");
        reportsSkipped++;
        continue;
      }

      const reportId = report.report_id as string;
      reportsCreated++;

      // Insert line items
      const lineItemsRows = p.line_items.map((li) => ({
        report_id: reportId,
        channel: p.channel,
        ota_confirmation: li.confirmation_code,
        guest_name: li.guest_name,
        property_ref: li.property_id,
        check_in: li.check_in,
        check_out: li.check_out,
        nights: li.nights,
        gross_amount: li.gross_amount,
        channel_fee: li.fee_amount,
        taxes_collected: 0,
        taxes_remitted: 0,
        net_amount: li.net_amount,
        raw_row: {
          source: "streamline-derived",
          reservation_id: li.reservation_id,
          run_id: runId,
        },
        match_status: "unmatched",
      }));
      const { error: liErr } = await sb.from("ota_payout_line_items").insert(lineItemsRows);
      if (liErr) {
        this.log.warn({ err: liErr.message, reportId }, "line items insert failed");
      } else {
        lineItemsCreated += lineItemsRows.length;
      }

      // Emit event
      await this.emit("otaauditor.payout.ingested", {
        report_id: reportId,
        channel: p.channel,
        payout_date: p.settlement_date,
        net_amount: p.net_amount,
        line_item_count: p.line_items.length,
        source: "streamline-derived",
      }, { correlation_id: cid });

      // Roll up summary
      if (!byChannel[p.channel]) {
        byChannel[p.channel] = { reports: 0, reservations: 0, gross: 0, net: 0 };
      }
      const summary = byChannel[p.channel]!;
      summary.reports++;
      summary.reservations += p.line_items.length;
      summary.gross += p.gross_amount;
      summary.net += p.net_amount;
    }

    const result: ScrapeResult = {
      run_id: runId,
      reservations_evaluated: reservations.length,
      reports_created: reportsCreated,
      reports_skipped_existing: reportsSkipped,
      line_items_created: lineItemsCreated,
      by_channel: byChannel,
    };

    this.log.info({ runId, ...result }, "scrape complete");

    await this.audit({
      action: "scrape.run",
      entity_type: "otaauditor_scrape",
      entity_id: runId,
      correlation_id: cid,
      after_state: result,
      reason: `Scrape ${runId} — ${reportsCreated} reports, ${lineItemsCreated} line items, ${reportsSkipped} skipped (existing)`,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Streamline-derived adapter
  // -------------------------------------------------------------------------

  private async loadReservations(sinceDate: string): Promise<ReservationCacheRow[]> {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("reservations_cache")
      .select(
        "reservation_id, channel, check_in, check_out, total_amount, currency, property_id, property_name, guest_name, confirmation_code, status",
      )
      .gte("check_out", sinceDate)
      .lte("check_out", today())
      .in("channel", SUPPORTED_CHANNELS as readonly string[])
      // Only finalized reservations — skip cancellations and partial bookings
      .in("status", ["checked_out", "booked", "modified"]);

    if (error) {
      this.log.error({ err: error.message }, "loadReservations failed");
      return [];
    }
    return (data ?? []).map((r) => ({
      reservation_id: r.reservation_id as string,
      channel: r.channel as string | null,
      check_in: r.check_in as string,
      check_out: r.check_out as string,
      total_amount: Number(r.total_amount),
      currency: r.currency as string,
      property_id: r.property_id as string | null,
      property_name: r.property_name as string | null,
      guest_name: r.guest_name as string,
      confirmation_code: r.confirmation_code as string | null,
      status: r.status as string | null,
    }));
  }
}

// ---------------------------------------------------------------------------
// Pure aggregator (exported for tests)
// ---------------------------------------------------------------------------

export function synthesizePayouts(reservations: ReservationCacheRow[]): SynthesizedPayout[] {
  // Group by (channel, settlement_date)
  const groups = new Map<string, ReservationCacheRow[]>();
  for (const r of reservations) {
    const channel = r.channel as SupportedChannel | null;
    if (!channel || !SUPPORTED_CHANNELS.includes(channel)) continue;
    const settlementDate = estimateSettlementDate(r.check_out, channel);
    const key = `${channel}|${settlementDate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const out: SynthesizedPayout[] = [];
  for (const [key, items] of groups) {
    const [channelStr, settlementDate] = key.split("|");
    const channel = channelStr as SupportedChannel;
    const feePct = CHANNEL_HOST_FEE_PCT[channel] ?? 0;

    let gross = 0;
    let fees = 0;
    const lineItems = items.map((r) => {
      const itemGross = r.total_amount;
      const itemFee = round2(itemGross * feePct);
      const itemNet = round2(itemGross - itemFee);
      gross = round2(gross + itemGross);
      fees = round2(fees + itemFee);
      const nights = Math.max(1, Math.round(
        (new Date(r.check_out).getTime() - new Date(r.check_in).getTime()) / 86_400_000,
      ));
      return {
        reservation_id: r.reservation_id,
        confirmation_code: r.confirmation_code,
        guest_name: r.guest_name,
        property_id: r.property_id,
        check_in: r.check_in,
        check_out: r.check_out,
        nights,
        gross_amount: itemGross,
        fee_amount: itemFee,
        net_amount: itemNet,
      };
    });
    const net = round2(gross - fees);

    // Idempotency hash — deterministic per (channel, date, sorted reservation ids)
    const sortedIds = items.map((r) => r.reservation_id).sort().join(",");
    const fileHash = sha256Hex(`streamline-derived|${channel}|${settlementDate}|${sortedIds}`);

    // Period bounds = check_out range
    const checkOuts = items.map((r) => r.check_out).sort();
    const periodStart = checkOuts[0]!;
    const periodEnd = checkOuts[checkOuts.length - 1]!;

    out.push({
      channel,
      settlement_date: settlementDate!,
      period_start: periodStart,
      period_end: periodEnd,
      gross_amount: gross,
      fees_amount: fees,
      net_amount: net,
      line_items: lineItems,
      source_file_hash: fileHash,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateSettlementDate(checkOut: string, channel: SupportedChannel): string {
  const lag = CHANNEL_SETTLEMENT_LAG_DAYS[channel] ?? 1;
  return shiftDate(checkOut, lag);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default new OtaPayoutScraper();
