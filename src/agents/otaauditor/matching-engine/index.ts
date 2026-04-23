/**
 * matching-engine — 3-way match between OTA payouts, bank deposits, and
 * (downstream) Sage GL postings.
 *
 * This agent implements Phases 1–8 of the algorithm specified in
 * docs/prompt-packs/phase-2-otaauditor/otaauditor-matching-engine.md.
 *
 * Flow:
 *   1. Query unmatched payouts + deposits from last N days (configurable).
 *   2. Segment by market (never cross-match between markets).
 *   3. Exact match pass   → confidence 100, auto-verified.
 *   4. Fuzzy match pass   → confidence-scored, auto-verify if ≥95,
 *                           human-review if 80–94, else leave unmatched.
 *   5. Split payout pass  → 1 payout → N deposits (subset-sum search).
 *   6. Batched deposit    → N payouts → 1 deposit (subset-sum search).
 *   7. Duplicate detection → flag suspicious patterns for review.
 *   8. Categorize leftover unmatched by age + severity.
 *
 * Triggers:
 *   - `otaauditor.sweep.poll` event (external)
 *   - Direct method call (for tests + manual sweeps)
 *
 * Emits:
 *   - `otaauditor.match.created` (one per match, with confidence + type)
 *   - `otaauditor.match.exception` (variance > threshold, duplicate, etc.)
 *   - `otaauditor.unmatched.aged` (any leftover with severity != info)
 */
import {
  AgentBase,
  type AgentIdentity,
  serviceClient,
  sha256Hex,
} from "@shared/index.js";
import type { MarketCode, RegionCode, Severity } from "@shared/types.js";

const IDENTITY: AgentIdentity = {
  product: "otaauditor",
  slug: "matching-engine",
  display_name: "OTA Matching Engine",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Scoring constants (from the prompt pack)
// ---------------------------------------------------------------------------

const THRESHOLD_AUTO            = 95;   // ≥95 = auto-verified
const THRESHOLD_REVIEW          = 80;   // 80..94 = human review
const SPLIT_BATCHED_CONFIDENCE  = 85;   // fixed cap for subset-sum matches

// Amount tolerance for exact match (cents)
const EXACT_AMOUNT_TOLERANCE_USD = 0.01;

// Split / batched: allow $1 slack on subset sums
const SUBSET_SUM_TOLERANCE_USD   = 1.00;

// Rejection window for fuzzy
const MAX_FUZZY_AMOUNT_USD       = 50.00;
const MAX_FUZZY_AMOUNT_PCT       = 0.02;
const MAX_FUZZY_DATE_DAYS        = 5;

// Subset-sum: cap the number of elements to avoid O(2^N) explosion.
const MAX_SUBSET_ELEMENTS        = 4;

// Default sweep window (days)
const DEFAULT_SWEEP_DAYS         = 7;

// Severity thresholds (days since settlement/deposit with no match)
const UNMATCHED_GREEN_DAYS       = 2;
const UNMATCHED_YELLOW_DAYS      = 5;
// Anything older = red

// Variance threshold that triggers an exception event (regardless of match conf)
const VARIANCE_EXCEPTION_USD     = 50.00;
const VARIANCE_EXCEPTION_PCT     = 0.05;

// ---------------------------------------------------------------------------
// Domain types — the flat, normalized shape the algorithm operates on
// ---------------------------------------------------------------------------

interface Payout {
  report_id: string;
  channel: string;                     // 'airbnb' | 'vrbo' | 'booking_com' | 'direct'
  payout_date: string;                  // YYYY-MM-DD
  net_amount: number;                   // USD
  market: MarketCode | null;
  region: RegionCode | null;
  line_item_count: number;
  reservation_refs: string[];           // confirmation codes from line items (for memo match bonus)
}

interface Deposit {
  deposit_id: string;
  source_system: string;                // 'column_bank' | 'csv_import' | 'manual'
  deposit_date: string;                 // YYYY-MM-DD
  amount: number;                       // USD
  market: MarketCode | null;
  region: RegionCode | null;
  ota_source: string | null;            // 'airbnb' | 'vrbo' | ... | null
  ota_source_confidence: number | null; // 0..1
  classification_confidence: number | null;
  memo: string | null;
  counterparty: string | null;
}

interface ScoredMatch {
  payout_ids: string[];
  deposit_ids: string[];
  match_type: "exact" | "fuzzy_high" | "fuzzy_medium" | "split_payout" | "batched_deposit";
  confidence: number;
  total_payout_amount: number;
  total_deposit_amount: number;
  variance_amount: number;
  variance_pct: number;
  variance_date_days: number;
  reasoning: string;
  score_breakdown: Record<string, number>;
  market: MarketCode | null;
  region: RegionCode | null;
}

interface SweepResult {
  run_id: string;
  started_at: string;
  completed_at: string;
  payouts_evaluated: number;
  deposits_evaluated: number;
  matches_created: number;
  unmatched_created: number;
  exceptions_created: number;
  summary_by_type: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class MatchingEngine extends AgentBase {
  private unsubs: Array<() => void> = [];

  constructor() {
    super(IDENTITY);
  }

  protected async onStart(): Promise<void> {
    this.unsubs.push(
      this.on({ event_type: "otaauditor.sweep.poll" }, async (ev) => {
        const cid = ev.correlation_id ?? ev.event_id;
        const payload = ev.payload as { window_days?: number } | undefined;
        const windowDays = payload?.window_days ?? DEFAULT_SWEEP_DAYS;
        this.log.info({ cid, windowDays }, "sweep.poll received");
        await this.runSweep({ correlationId: cid, windowDays });
      }),
    );
    this.log.info("matching-engine online — listening for otaauditor.sweep.poll");
  }

  protected async onStop(): Promise<void> {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.log.info("matching-engine stopped");
  }

  // -------------------------------------------------------------------------
  // Public entry point — also callable directly from tests / pipeline scripts
  // -------------------------------------------------------------------------

  public async runSweep(opts: {
    correlationId?: string;
    windowDays?: number;
    sinceDate?: string;            // YYYY-MM-DD override for reproducible tests
  } = {}): Promise<SweepResult> {
    const cid = opts.correlationId ?? crypto.randomUUID();
    const windowDays = opts.windowDays ?? DEFAULT_SWEEP_DAYS;
    const runId = `match-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const since = opts.sinceDate ?? shiftDate(today(), -windowDays);

    this.log.info({ cid, runId, since }, "sweep starting");

    // -- Phase 1: load unmatched data -----------------------------------------
    const payouts = await this.loadUnmatchedPayouts(since);
    const deposits = await this.loadUnmatchedDeposits(since);
    this.log.info({ payouts: payouts.length, deposits: deposits.length }, "loaded unmatched data");

    const byMarket = segmentByMarket(payouts, deposits);

    // -- Phases 2–5 per market ------------------------------------------------
    const allMatches: ScoredMatch[] = [];
    const unmatchedPayouts = new Set(payouts.map((p) => p.report_id));
    const unmatchedDeposits = new Set(deposits.map((d) => d.deposit_id));

    for (const [marketKey, bucket] of byMarket.entries()) {
      // Phase 2: exact
      for (const exact of exactMatchPass(bucket.payouts, bucket.deposits, unmatchedPayouts, unmatchedDeposits)) {
        allMatches.push(exact);
      }

      // Phase 3: fuzzy
      const remainingP = bucket.payouts.filter((p) => unmatchedPayouts.has(p.report_id));
      const remainingD = bucket.deposits.filter((d) => unmatchedDeposits.has(d.deposit_id));
      for (const fuzzy of fuzzyMatchPass(remainingP, remainingD, unmatchedPayouts, unmatchedDeposits)) {
        allMatches.push(fuzzy);
      }

      // Phase 4: split payout (1 → N)
      const stillUnmatchedP = bucket.payouts.filter((p) => unmatchedPayouts.has(p.report_id));
      const stillUnmatchedD = bucket.deposits.filter((d) => unmatchedDeposits.has(d.deposit_id));
      for (const split of splitPayoutPass(stillUnmatchedP, stillUnmatchedD, unmatchedPayouts, unmatchedDeposits)) {
        allMatches.push(split);
      }

      // Phase 5: batched deposit (N → 1)
      const leftoverP = bucket.payouts.filter((p) => unmatchedPayouts.has(p.report_id));
      const leftoverD = bucket.deposits.filter((d) => unmatchedDeposits.has(d.deposit_id));
      for (const batched of batchedDepositPass(leftoverP, leftoverD, unmatchedPayouts, unmatchedDeposits)) {
        allMatches.push(batched);
      }

      this.log.debug({ market: marketKey, matches: allMatches.length }, "market sweep complete");
    }

    // -- Phase 6: duplicate detection across all remaining items -------------
    const duplicatesDetected = duplicateDetection(
      payouts.filter((p) => unmatchedPayouts.has(p.report_id)),
      deposits.filter((d) => unmatchedDeposits.has(d.deposit_id)),
    );

    // -- Persist matches + emit events ---------------------------------------
    let matchesCreated = 0;
    const summaryByType: Record<string, number> = {};
    for (const m of allMatches) {
      const matchId = await this.persistMatch(m, cid);
      if (matchId) {
        matchesCreated++;
        summaryByType[m.match_type] = (summaryByType[m.match_type] ?? 0) + 1;
      }
    }

    // -- Persist unmatched (Phase 7 — age + severity categorization) ---------
    const todayStr = today();
    let unmatchedCreated = 0;
    for (const p of payouts.filter((p) => unmatchedPayouts.has(p.report_id))) {
      const age = daysBetween(p.payout_date, todayStr);
      const { category, severity } = categorizeUnmatchedPayout(age);
      if (await this.persistUnmatched("payout", p.report_id, category, severity, age, p.market, p.region)) {
        unmatchedCreated++;
      }
    }
    for (const d of deposits.filter((d) => unmatchedDeposits.has(d.deposit_id))) {
      const age = daysBetween(d.deposit_date, todayStr);
      const { category, severity } = categorizeUnmatchedDeposit(age);
      if (await this.persistUnmatched("deposit", d.deposit_id, category, severity, age, d.market, d.region)) {
        unmatchedCreated++;
      }
    }

    // -- Exceptions (variance, duplicate) ------------------------------------
    let exceptionsCreated = 0;
    for (const dup of duplicatesDetected) {
      if (await this.persistException(dup, cid)) exceptionsCreated++;
    }
    for (const m of allMatches) {
      if (Math.abs(m.variance_amount) >= VARIANCE_EXCEPTION_USD ||
          Math.abs(m.variance_pct) >= VARIANCE_EXCEPTION_PCT) {
        if (await this.persistVarianceException(m, cid)) exceptionsCreated++;
      }
    }

    // -- Summary -------------------------------------------------------------
    const result: SweepResult = {
      run_id: runId,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      payouts_evaluated: payouts.length,
      deposits_evaluated: deposits.length,
      matches_created: matchesCreated,
      unmatched_created: unmatchedCreated,
      exceptions_created: exceptionsCreated,
      summary_by_type: summaryByType,
    };

    this.log.info({ runId, ...result }, "sweep complete");

    // Audit
    await this.audit({
      action: "sweep.run",
      entity_type: "otaauditor_sweep",
      entity_id: runId,
      correlation_id: cid,
      after_state: result,
      reason: `Sweep ${runId} — ${matchesCreated} matches, ${unmatchedCreated} unmatched, ${exceptionsCreated} exceptions`,
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Data loaders
  // -------------------------------------------------------------------------

  private async loadUnmatchedPayouts(sinceDate: string): Promise<Payout[]> {
    const sb = serviceClient();
    const { data: reports, error } = await sb
      .from("ota_payout_reports")
      .select("report_id, channel, payout_date, net_amount, region")
      .eq("status", "ingested")
      .gte("payout_date", sinceDate);
    if (error) {
      this.log.error({ err: error.message }, "failed to load payouts");
      return [];
    }

    // Also look up line item confirmation codes for each report (for memo-match bonus)
    const reportIds = (reports ?? []).map((r) => r.report_id as string);
    if (reportIds.length === 0) return [];
    const { data: lineItems } = await sb
      .from("ota_payout_line_items")
      .select("report_id, ota_confirmation")
      .in("report_id", reportIds);
    const refsByReport = new Map<string, string[]>();
    for (const li of lineItems ?? []) {
      const rid = (li as { report_id: string }).report_id;
      const conf = (li as { ota_confirmation: string | null }).ota_confirmation;
      if (!conf) continue;
      if (!refsByReport.has(rid)) refsByReport.set(rid, []);
      refsByReport.get(rid)!.push(conf);
    }

    return (reports ?? []).map((r): Payout => ({
      report_id: r.report_id as string,
      channel: r.channel as string,
      payout_date: r.payout_date as string,
      net_amount: Number(r.net_amount),
      market: null, // Phase 2: market derivation from bank_account_id — not wired yet; all "unknown"
      region: r.region as RegionCode | null,
      line_item_count: 0,
      reservation_refs: refsByReport.get(r.report_id as string) ?? [],
    }));
  }

  private async loadUnmatchedDeposits(sinceDate: string): Promise<Deposit[]> {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("bank_deposits")
      .select(
        "deposit_id, source_system, deposit_date, amount, market, region, ota_source, ota_source_confidence, classification_confidence, memo, counterparty, classification",
      )
      .eq("match_status", "unmatched")
      .in("classification", ["ota_deposit", "possible_ota_deposit"])
      .gte("deposit_date", sinceDate);
    if (error) {
      this.log.error({ err: error.message }, "failed to load deposits");
      return [];
    }
    return (data ?? []).map((d): Deposit => ({
      deposit_id: d.deposit_id as string,
      source_system: d.source_system as string,
      deposit_date: d.deposit_date as string,
      amount: Number(d.amount),
      market: d.market as MarketCode | null,
      region: d.region as RegionCode | null,
      ota_source: d.ota_source as string | null,
      ota_source_confidence: d.ota_source_confidence !== null ? Number(d.ota_source_confidence) : null,
      classification_confidence: d.classification_confidence !== null ? Number(d.classification_confidence) : null,
      memo: d.memo as string | null,
      counterparty: d.counterparty as string | null,
    }));
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async persistMatch(match: ScoredMatch, correlationId: string): Promise<string | null> {
    const sb = serviceClient();
    const fingerprint = sha256Hex(
      [...match.payout_ids].sort().join(",") + "||" + [...match.deposit_ids].sort().join(","),
    );

    const { data, error } = await sb
      .from("ota_matches")
      .upsert(
        {
          match_type: match.match_type,
          confidence: match.confidence,
          payout_ids: match.payout_ids,
          deposit_ids: match.deposit_ids,
          total_payout_amount: match.total_payout_amount,
          total_deposit_amount: match.total_deposit_amount,
          variance_pct: match.variance_pct,
          variance_date_days: match.variance_date_days,
          reasoning: match.reasoning,
          score_breakdown: match.score_breakdown,
          auto_verified: match.confidence >= THRESHOLD_AUTO,
          requires_review: match.confidence >= THRESHOLD_REVIEW && match.confidence < THRESHOLD_AUTO,
          region: match.region,
          market: match.market,
          correlation_id: correlationId,
          match_fingerprint: fingerprint,
          created_by: IDENTITY.slug,
        },
        { onConflict: "match_fingerprint", ignoreDuplicates: false },
      )
      .select("match_id")
      .single();

    if (error) {
      this.log.error({ err: error.message, fingerprint }, "persistMatch failed");
      return null;
    }
    const matchId = data.match_id as string;

    // Mark underlying payouts + deposits as matched
    await sb
      .from("ota_payout_reports")
      .update({ status: "matched" })
      .in("report_id", match.payout_ids);
    await sb
      .from("bank_deposits")
      .update({ match_status: "matched", match_id: matchId })
      .in("deposit_id", match.deposit_ids);

    // Emit event
    await this.emit("otaauditor.match.created", {
      match_id: matchId,
      match_type: match.match_type,
      confidence: match.confidence,
      payout_ids: match.payout_ids,
      deposit_ids: match.deposit_ids,
      variance_amount: match.variance_amount,
      market: match.market,
    }, { correlation_id: correlationId });

    await this.audit({
      action: "match.created",
      entity_type: "ota_match",
      entity_id: matchId,
      correlation_id: correlationId,
      after_state: {
        match_type: match.match_type,
        confidence: match.confidence,
        payout_ids: match.payout_ids.length,
        deposit_ids: match.deposit_ids.length,
        variance_amount: match.variance_amount,
      },
      reason: `${match.match_type} (confidence ${match.confidence}): ${match.reasoning}`,
    });

    return matchId;
  }

  private async persistUnmatched(
    entityType: "payout" | "deposit",
    entityId: string,
    category: string,
    severity: Severity,
    ageDays: number,
    market: MarketCode | null,
    region: RegionCode | null,
  ): Promise<boolean> {
    const sb = serviceClient();

    // Check if there's already an open (unresolved) unmatched row for this entity
    const { data: existing } = await sb
      .from("ota_unmatched")
      .select("unmatched_id, severity")
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .is("resolved_at", null)
      .maybeSingle();

    if (existing) {
      // Update the existing row with the latest age + severity
      const { error } = await sb
        .from("ota_unmatched")
        .update({ age_days: ageDays, severity, category })
        .eq("unmatched_id", existing.unmatched_id);
      if (error) {
        this.log.warn({ err: error.message }, "unmatched update failed");
        return false;
      }
    } else {
      const { error } = await sb
        .from("ota_unmatched")
        .insert({
          entity_type: entityType,
          entity_id: entityId,
          category,
          severity,
          age_days: ageDays,
          reason: `${entityType} unmatched for ${ageDays} days — category: ${category}`,
          market,
          region,
        });
      if (error) {
        this.log.warn({ err: error.message, entityType, entityId }, "unmatched insert failed");
        return false;
      }
    }

    // Emit event if severity elevated
    if (severity !== "info") {
      await this.emit("otaauditor.unmatched.aged", {
        entity_type: entityType,
        entity_id: entityId,
        category,
        severity,
        age_days: ageDays,
      });
    }
    return true;
  }

  private async persistVarianceException(match: ScoredMatch, correlationId: string): Promise<boolean> {
    const sb = serviceClient();
    const { error } = await sb
      .from("ota_match_exceptions")
      .insert({
        exception_type: "variance_threshold",
        severity: Math.abs(match.variance_pct) >= 0.10 ? "error" : "warn",
        summary: `Match variance $${match.variance_amount.toFixed(2)} (${(match.variance_pct * 100).toFixed(2)}%) exceeds threshold`,
        detail: {
          match_type: match.match_type,
          total_payout_amount: match.total_payout_amount,
          total_deposit_amount: match.total_deposit_amount,
          variance_amount: match.variance_amount,
          variance_pct: match.variance_pct,
          payout_ids: match.payout_ids,
          deposit_ids: match.deposit_ids,
          reasoning: match.reasoning,
        },
        region: match.region,
        market: match.market,
      });
    if (error) {
      this.log.error({ err: error.message }, "persistVarianceException failed");
      return false;
    }
    await this.emit("otaauditor.match.exception", {
      exception_type: "variance_threshold",
      variance_amount: match.variance_amount,
      variance_pct: match.variance_pct,
      payout_ids: match.payout_ids,
      deposit_ids: match.deposit_ids,
    }, { correlation_id: correlationId });
    return true;
  }

  private async persistException(
    dup: DuplicateCandidate,
    correlationId: string,
  ): Promise<boolean> {
    const sb = serviceClient();
    const { error } = await sb
      .from("ota_match_exceptions")
      .insert({
        exception_type: "duplicate_suspected",
        severity: "warn",
        summary: `Duplicate ${dup.entity_type}s suspected: ${dup.entity_ids.join(", ")}`,
        detail: {
          entity_type: dup.entity_type,
          entity_ids: dup.entity_ids,
          amount: dup.amount,
          date: dup.date,
          market: dup.market,
        },
        market: dup.market,
      });
    if (error) {
      this.log.error({ err: error.message }, "persistException failed");
      return false;
    }
    await this.emit("otaauditor.match.exception", {
      exception_type: "duplicate_suspected",
      entity_type: dup.entity_type,
      entity_ids: dup.entity_ids,
    }, { correlation_id: correlationId });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Pure algorithm functions (exported for tests)
// ---------------------------------------------------------------------------

interface MarketBucket {
  payouts: Payout[];
  deposits: Deposit[];
}

function segmentByMarket(payouts: Payout[], deposits: Deposit[]): Map<string, MarketBucket> {
  const buckets = new Map<string, MarketBucket>();
  const key = (m: MarketCode | null) => m ?? "unknown";
  for (const p of payouts) {
    const k = key(p.market);
    if (!buckets.has(k)) buckets.set(k, { payouts: [], deposits: [] });
    buckets.get(k)!.payouts.push(p);
  }
  for (const d of deposits) {
    const k = key(d.market);
    if (!buckets.has(k)) buckets.set(k, { payouts: [], deposits: [] });
    buckets.get(k)!.deposits.push(d);
  }
  // Stable sort: payouts by settlement date ascending, deposits by deposit date ascending
  for (const b of buckets.values()) {
    b.payouts.sort((a, b) => a.payout_date.localeCompare(b.payout_date));
    b.deposits.sort((a, b) => a.deposit_date.localeCompare(b.deposit_date));
  }
  return buckets;
}

function* exactMatchPass(
  payouts: Payout[],
  deposits: Deposit[],
  unmatchedP: Set<string>,
  unmatchedD: Set<string>,
): Generator<ScoredMatch> {
  for (const p of payouts) {
    if (!unmatchedP.has(p.report_id)) continue;
    for (const d of deposits) {
      if (!unmatchedD.has(d.deposit_id)) continue;
      if (p.payout_date !== d.deposit_date) continue;
      if (Math.abs(p.net_amount - d.amount) > EXACT_AMOUNT_TOLERANCE_USD) continue;
      if (d.ota_source && d.ota_source !== p.channel) {
        if ((d.ota_source_confidence ?? 0) >= 0.90) continue;
      }
      unmatchedP.delete(p.report_id);
      unmatchedD.delete(d.deposit_id);
      yield {
        payout_ids: [p.report_id],
        deposit_ids: [d.deposit_id],
        match_type: "exact",
        confidence: 100,
        total_payout_amount: p.net_amount,
        total_deposit_amount: d.amount,
        variance_amount: d.amount - p.net_amount,
        variance_pct: (d.amount - p.net_amount) / p.net_amount,
        variance_date_days: 0,
        reasoning: `Exact: amount $${p.net_amount.toFixed(2)} on ${p.payout_date}, channel ${p.channel}`,
        score_breakdown: { amount: 0, date: 0, ota_source: 0 },
        market: p.market,
        region: p.region,
      };
      break;
    }
  }
}

function* fuzzyMatchPass(
  payouts: Payout[],
  deposits: Deposit[],
  unmatchedP: Set<string>,
  unmatchedD: Set<string>,
): Generator<ScoredMatch> {
  for (const p of payouts) {
    if (!unmatchedP.has(p.report_id)) continue;
    const candidates: Array<{ deposit: Deposit; score: number; breakdown: Record<string, number>; dateDays: number }> = [];
    for (const d of deposits) {
      if (!unmatchedD.has(d.deposit_id)) continue;
      const amountVar = Math.abs(p.net_amount - d.amount);
      const amountVarPct = p.net_amount > 0 ? amountVar / p.net_amount : 1;
      const dateDays = Math.abs(daysBetween(p.payout_date, d.deposit_date));
      // Rejection gates
      if (amountVar > MAX_FUZZY_AMOUNT_USD && amountVarPct > MAX_FUZZY_AMOUNT_PCT) continue;
      if (dateDays > MAX_FUZZY_DATE_DAYS) continue;
      if (d.ota_source && d.ota_source !== p.channel && (d.ota_source_confidence ?? 0) >= 0.80) continue;
      const { score, breakdown } = calculateFuzzyConfidence(p, d, amountVar, dateDays);
      candidates.push({ deposit: d, score, breakdown, dateDays });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || best.score < THRESHOLD_REVIEW) continue;

    unmatchedP.delete(p.report_id);
    unmatchedD.delete(best.deposit.deposit_id);
    yield {
      payout_ids: [p.report_id],
      deposit_ids: [best.deposit.deposit_id],
      match_type: best.score >= THRESHOLD_AUTO ? "fuzzy_high" : "fuzzy_medium",
      confidence: best.score,
      total_payout_amount: p.net_amount,
      total_deposit_amount: best.deposit.amount,
      variance_amount: best.deposit.amount - p.net_amount,
      variance_pct: p.net_amount > 0 ? (best.deposit.amount - p.net_amount) / p.net_amount : 0,
      variance_date_days: best.dateDays,
      reasoning: `Fuzzy (score ${best.score}): $${best.deposit.amount.toFixed(2)} vs $${p.net_amount.toFixed(2)} on ${best.deposit.deposit_date} vs ${p.payout_date}`,
      score_breakdown: best.breakdown,
      market: p.market,
      region: p.region,
    };
  }
}

function calculateFuzzyConfidence(
  p: Payout,
  d: Deposit,
  amountVar: number,
  dateDays: number,
): { score: number; breakdown: Record<string, number> } {
  let score = 100;
  const breakdown: Record<string, number> = {};
  // Amount penalty
  const amountVarPct = p.net_amount > 0 ? amountVar / p.net_amount : 1;
  let amountPenalty: number;
  if (amountVarPct <= 0.005) amountPenalty = 0;
  else if (amountVarPct <= 0.01) amountPenalty = 3;
  else if (amountVarPct <= 0.02) amountPenalty = 8;
  else if (amountVarPct <= 0.05) amountPenalty = 20;
  else amountPenalty = 40;
  score -= amountPenalty;
  breakdown.amount_penalty = -amountPenalty;
  // Date penalty
  let datePenalty: number;
  if (dateDays === 0) datePenalty = 0;
  else if (dateDays === 1) datePenalty = 2;
  else if (dateDays === 2) datePenalty = 5;
  else if (dateDays <= 3) datePenalty = 10;
  else if (dateDays <= 5) datePenalty = 20;
  else datePenalty = 35;
  score -= datePenalty;
  breakdown.date_penalty = -datePenalty;
  // OTA source confidence adjustment
  let otaAdj = 0;
  if (d.ota_source_confidence !== null) {
    if (d.ota_source_confidence >= 0.95) otaAdj = 0;
    else if (d.ota_source_confidence >= 0.80) otaAdj = -3;
    else if (d.ota_source_confidence < 0.50) otaAdj = -10;
  }
  score += otaAdj;
  breakdown.ota_source = otaAdj;
  // Reference match bonus (reservation code in memo)
  const memoLower = (d.memo ?? "").toLowerCase();
  const memoMatch = p.reservation_refs.some((r) => r && memoLower.includes(r.toLowerCase()));
  if (memoMatch) {
    score += 5;
    breakdown.memo_match = 5;
  }
  return { score: Math.max(0, Math.min(100, score)), breakdown };
}

function* splitPayoutPass(
  payouts: Payout[],
  deposits: Deposit[],
  unmatchedP: Set<string>,
  unmatchedD: Set<string>,
): Generator<ScoredMatch> {
  for (const p of payouts) {
    if (!unmatchedP.has(p.report_id)) continue;
    const candidates = deposits.filter(
      (d) => unmatchedD.has(d.deposit_id) && Math.abs(daysBetween(p.payout_date, d.deposit_date)) <= 3,
    );
    for (let size = 2; size <= Math.min(MAX_SUBSET_ELEMENTS, candidates.length); size++) {
      const subset = findSubsetSum(
        candidates.map((d) => d.amount),
        p.net_amount,
        size,
        SUBSET_SUM_TOLERANCE_USD,
      );
      if (!subset) continue;
      const matchedDeposits = subset.map((idx) => candidates[idx]!);
      unmatchedP.delete(p.report_id);
      for (const d of matchedDeposits) unmatchedD.delete(d.deposit_id);
      const totalDep = matchedDeposits.reduce((sum, d) => sum + d.amount, 0);
      yield {
        payout_ids: [p.report_id],
        deposit_ids: matchedDeposits.map((d) => d.deposit_id),
        match_type: "split_payout",
        confidence: SPLIT_BATCHED_CONFIDENCE,
        total_payout_amount: p.net_amount,
        total_deposit_amount: totalDep,
        variance_amount: totalDep - p.net_amount,
        variance_pct: p.net_amount > 0 ? (totalDep - p.net_amount) / p.net_amount : 0,
        variance_date_days: Math.max(
          ...matchedDeposits.map((d) => Math.abs(daysBetween(p.payout_date, d.deposit_date))),
        ),
        reasoning: `Split payout: 1 payout → ${matchedDeposits.length} deposits, sum within $${SUBSET_SUM_TOLERANCE_USD}`,
        score_breakdown: { subset_size: matchedDeposits.length },
        market: p.market,
        region: p.region,
      };
      break;
    }
  }
}

function* batchedDepositPass(
  payouts: Payout[],
  deposits: Deposit[],
  unmatchedP: Set<string>,
  unmatchedD: Set<string>,
): Generator<ScoredMatch> {
  for (const d of deposits) {
    if (!unmatchedD.has(d.deposit_id)) continue;
    const candidates = payouts.filter(
      (p) => unmatchedP.has(p.report_id) && Math.abs(daysBetween(p.payout_date, d.deposit_date)) <= 5,
    );
    for (let size = 2; size <= Math.min(MAX_SUBSET_ELEMENTS, candidates.length); size++) {
      const subset = findSubsetSum(
        candidates.map((p) => p.net_amount),
        d.amount,
        size,
        SUBSET_SUM_TOLERANCE_USD,
      );
      if (!subset) continue;
      const matchedPayouts = subset.map((idx) => candidates[idx]!);
      unmatchedD.delete(d.deposit_id);
      for (const p of matchedPayouts) unmatchedP.delete(p.report_id);
      const totalPay = matchedPayouts.reduce((sum, p) => sum + p.net_amount, 0);
      yield {
        payout_ids: matchedPayouts.map((p) => p.report_id),
        deposit_ids: [d.deposit_id],
        match_type: "batched_deposit",
        confidence: SPLIT_BATCHED_CONFIDENCE,
        total_payout_amount: totalPay,
        total_deposit_amount: d.amount,
        variance_amount: d.amount - totalPay,
        variance_pct: totalPay > 0 ? (d.amount - totalPay) / totalPay : 0,
        variance_date_days: Math.max(
          ...matchedPayouts.map((p) => Math.abs(daysBetween(p.payout_date, d.deposit_date))),
        ),
        reasoning: `Batched deposit: ${matchedPayouts.length} payouts → 1 deposit, sum within $${SUBSET_SUM_TOLERANCE_USD}`,
        score_breakdown: { subset_size: matchedPayouts.length },
        market: d.market,
        region: d.region,
      };
      break;
    }
  }
}

/**
 * Find a subset of `amounts` of exactly `size` that sums to within `tolerance`
 * of `target`. Returns the indices of the subset if found, null otherwise.
 * O(C(n, size)) — capped by MAX_SUBSET_ELEMENTS.
 */
function findSubsetSum(
  amounts: number[],
  target: number,
  size: number,
  tolerance: number,
): number[] | null {
  const n = amounts.length;
  if (size > n) return null;
  const indices = Array.from({ length: size }, (_, i) => i);
  while (true) {
    const sum = indices.reduce((s, i) => s + amounts[i]!, 0);
    if (Math.abs(sum - target) <= tolerance) return indices.slice();
    // Next combination (lexicographic)
    let i = size - 1;
    while (i >= 0 && indices[i] === n - size + i) i--;
    if (i < 0) return null;
    indices[i] = indices[i]! + 1;
    for (let j = i + 1; j < size; j++) indices[j] = indices[j - 1]! + 1;
  }
}

interface DuplicateCandidate {
  entity_type: "payout" | "deposit";
  entity_ids: string[];
  amount: number;
  date: string;
  market: MarketCode | null;
}

function duplicateDetection(payouts: Payout[], deposits: Deposit[]): DuplicateCandidate[] {
  const out: DuplicateCandidate[] = [];
  const depKey = (d: Deposit) => `${d.market ?? "unknown"}|${d.deposit_date}|${d.amount.toFixed(2)}`;
  const payKey = (p: Payout) => `${p.market ?? "unknown"}|${p.payout_date}|${p.net_amount.toFixed(2)}|${p.channel}`;
  const depGroups = new Map<string, Deposit[]>();
  const payGroups = new Map<string, Payout[]>();
  for (const d of deposits) {
    const k = depKey(d);
    if (!depGroups.has(k)) depGroups.set(k, []);
    depGroups.get(k)!.push(d);
  }
  for (const p of payouts) {
    const k = payKey(p);
    if (!payGroups.has(k)) payGroups.set(k, []);
    payGroups.get(k)!.push(p);
  }
  for (const [, deps] of depGroups) {
    if (deps.length >= 2) {
      out.push({
        entity_type: "deposit",
        entity_ids: deps.map((d) => d.deposit_id),
        amount: deps[0]!.amount,
        date: deps[0]!.deposit_date,
        market: deps[0]!.market,
      });
    }
  }
  for (const [, pays] of payGroups) {
    if (pays.length >= 2) {
      out.push({
        entity_type: "payout",
        entity_ids: pays.map((p) => p.report_id),
        amount: pays[0]!.net_amount,
        date: pays[0]!.payout_date,
        market: pays[0]!.market,
      });
    }
  }
  return out;
}

function categorizeUnmatchedPayout(ageDays: number): { category: string; severity: Severity } {
  if (ageDays <= UNMATCHED_GREEN_DAYS) return { category: "timing_variance", severity: "info" };
  if (ageDays <= UNMATCHED_YELLOW_DAYS) return { category: "unmatched_payout", severity: "warn" };
  return { category: "missing_deposit", severity: "error" };
}

function categorizeUnmatchedDeposit(ageDays: number): { category: string; severity: Severity } {
  if (ageDays <= UNMATCHED_GREEN_DAYS) return { category: "timing_variance", severity: "info" };
  if (ageDays <= UNMATCHED_YELLOW_DAYS) return { category: "unmatched_deposit", severity: "warn" };
  return { category: "unknown_source_deposit", severity: "error" };
}

// ---------------------------------------------------------------------------
// Date utilities (ISO YYYY-MM-DD, no time)
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.round((db - da) / 86_400_000);
}

export default new MatchingEngine();
