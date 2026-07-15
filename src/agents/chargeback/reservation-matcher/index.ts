/**
 * reservation-matcher — links chargeback cases to Streamline reservations
 * using a multi-signal scoring algorithm.
 *
 * Subscribes to:
 *   chargeback.case.notified   — new case needs a reservation match
 *   chargeback.match.confirmed — human confirmed a probable/ambiguous match
 *
 * Emits based on confidence score:
 *   >= 95  chargeback.match.auto      — proceed directly to dossier
 *   75-94  chargeback.match.probable   — hold for human confirmation
 *   < 75   chargeback.match.ambiguous  — escalate (may have candidates or none)
 *
 * Scoring weights:
 *   Guest name exact match    +40
 *   Guest name fuzzy match    +25
 *   Charge date within stay   +30
 *   Amount within 10%         +20
 *   Channel matches           +10
 */

import {
  AgentBase,
  type AgentIdentity,
  serviceClient,
} from "@shared/index.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const IDENTITY: AgentIdentity = {
  product: "chargeback",
  slug: "reservation-matcher",
  display_name: "Chargeback Reservation Matcher",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

const SCORE_NAME_EXACT       = 40;
const SCORE_NAME_FUZZY       = 25;
const SCORE_DATE_IN_STAY     = 30;    // charge during stay (refund disputes, service-not-rendered)
const SCORE_DATE_AT_BOOKING  = 25;    // charge near booking creation (original transaction disputes)
const SCORE_AMOUNT_CLOSE     = 20;
const SCORE_CHANNEL_MATCH    = 10;

const THRESHOLD_AUTO         = 95;
const THRESHOLD_PROBABLE     = 75;
const AMOUNT_TOLERANCE       = 0.10; // 10 %
const BOOKING_DATE_WINDOW_DAYS = 3;  // charge_date within ±N days of booking_created_at

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

interface CasePayload {
  case_id: string;
  processor: string;
  external_case_id: string;
  amount: number;
  currency: string;
  reason_code: string;
  guest_name: string;
  charge_date: string;
  processor_deadline: string;
  internal_deadline: string;
}

interface ReservationCandidate {
  reservation_id: string;
  guest_name: string;
  check_in: string;
  check_out: string;
  total_amount: number;
  channel: string | null;
  property_id: string | null;
  booking_created_at?: string | null;
}

interface ScoredCandidate extends ReservationCandidate {
  score: number;
  score_breakdown: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Channel mapping — maps processor to expected booking channel
// ---------------------------------------------------------------------------

// Lynnbrook is a VACATION-RENTAL payment processor — the underlying booking
// can be VRBO, HomeAway, or direct. Airbnb does NOT use Lynnbrook. So we
// give Lynnbrook credit for any of those channels.
const PROCESSOR_CHANNEL_MAP: Record<string, string[]> = {
  airbnb_resolutions: ["airbnb"],
  vrbo:               ["vrbo", "homeaway", "expedia"],
  stripe:             ["direct", "website"],
  lynnbrook:          ["vrbo", "homeaway", "direct", "website"],
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class ReservationMatcher extends AgentBase {
  private unsubscribers: Array<() => void> = [];

  constructor() {
    super(IDENTITY);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    // React to new cases that need matching
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.case.notified" }, async (ev) => {
        await this.handleCaseNotified(ev);
      }),
    );

    // React to human-confirmed matches (probable/ambiguous that a human verified)
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.match.confirmed" }, async (ev) => {
        await this.handleMatchConfirmed(ev);
      }),
    );

    this.log.info("reservation matcher online — listening for case notifications and match confirmations");
  }

  protected async onStop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.log.info("reservation matcher stopped");
  }

  // -------------------------------------------------------------------------
  // Case notified — run the matching algorithm
  // -------------------------------------------------------------------------

  private async handleCaseNotified(ev: {
    event_id: string;
    correlation_id: string | null;
    payload: unknown;
  }): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    const caseData = ev.payload as CasePayload;

    this.log.info({ cid, caseId: caseData.case_id }, "matching reservation for chargeback case");

    // 1. Search for candidate reservations
    const candidates = await this.searchReservations(caseData);

    // 2. Score each candidate
    const scored = candidates
      .map((c) => this.scoreCandidate(c, caseData))
      .sort((a, b) => b.score - a.score);

    const best = scored[0] ?? null;
    const confidence = best?.score ?? 0;

    // 3. Update the case record with the best match
    if (best && confidence >= THRESHOLD_PROBABLE) {
      await this.updateCaseMatch(caseData.case_id, best.reservation_id, confidence);
    }

    // 4. Emit based on confidence tier
    await this.emitMatchResult(caseData, scored, confidence, cid);

    await this.audit({
      action: "match.scored",
      entity_type: "chargeback_case",
      entity_id: caseData.case_id,
      correlation_id: cid,
      after_state: {
        candidates_found: scored.length,
        best_score: confidence,
        best_reservation: best?.reservation_id ?? null,
      },
      reason: `Scored ${scored.length} candidates — best confidence: ${confidence}%`,
    });
  }

  // -------------------------------------------------------------------------
  // Human confirmed a match — persist it
  // -------------------------------------------------------------------------

  private async handleMatchConfirmed(ev: {
    event_id: string;
    correlation_id: string | null;
    payload: unknown;
  }): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    const payload = ev.payload as {
      case_id: string;
      reservation_id: string;
      confirmed_by?: string;
    };

    this.log.info({ cid, caseId: payload.case_id }, "human confirmed reservation match");

    await this.updateCaseMatch(payload.case_id, payload.reservation_id, 100);

    await this.audit({
      action: "match.confirmed_by_human",
      entity_type: "chargeback_case",
      entity_id: payload.case_id,
      correlation_id: cid,
      after_state: {
        reservation_id: payload.reservation_id,
        match_confidence: 100,
        confirmed_by: payload.confirmed_by ?? "unknown",
      },
      reason: "Human confirmed reservation match — confidence set to 100",
    });
  }

  // -------------------------------------------------------------------------
  // Reservation search
  // -------------------------------------------------------------------------

  private async searchReservations(caseData: CasePayload): Promise<ReservationCandidate[]> {
    const sb = serviceClient();
    const chargeDate = caseData.charge_date;

    // Two overlapping windows — any reservation matching EITHER is a candidate:
    //   (a) check_in ∈ [charge_date − 60d, charge_date + 180d]
    //       Captures refund / service-not-rendered disputes where the stay
    //       is near the charge date. Forward window is wide because VRBO
    //       bookings are often made months in advance.
    //   (b) booking_created_at ∈ [charge_date − 14d, charge_date + 7d]
    //       Captures original-transaction disputes where the charge date
    //       is the booking timestamp and the stay is far in the future.
    const stayStart = this.shiftDate(chargeDate, -60);
    const stayEnd = this.shiftDate(chargeDate, 180);
    const bookingStart = this.shiftDate(chargeDate, -14);
    const bookingEnd = this.shiftDate(chargeDate, 7);

    // Supabase REST: .or() takes a comma-separated filter expression.
    // `and()` groups the two-sided range per window.
    const orExpr = [
      `and(check_in.gte.${stayStart},check_in.lte.${stayEnd})`,
      `and(booking_created_at.gte.${bookingStart}T00:00:00Z,booking_created_at.lte.${bookingEnd}T23:59:59Z)`,
    ].join(",");

    const { data, error } = await sb
      .from("reservations_cache")
      .select("reservation_id, guest_name, check_in, check_out, total_amount, channel, property_id, booking_created_at")
      .or(orExpr)
      .limit(500);

    if (error) {
      this.log.error({ error, caseId: caseData.case_id }, "reservation search failed");
      return [];
    }

    return (data ?? []).map((row) => ({
      reservation_id: row.reservation_id,
      guest_name: row.guest_name,
      check_in: row.check_in,
      check_out: row.check_out,
      total_amount: row.total_amount,
      channel: row.channel,
      property_id: row.property_id,
      booking_created_at: row.booking_created_at,
    }));
  }

  private shiftDate(iso: string, days: number): string {
    const d = new Date(iso);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // -------------------------------------------------------------------------
  // Scoring algorithm
  // -------------------------------------------------------------------------

  private scoreCandidate(candidate: ReservationCandidate, caseData: CasePayload): ScoredCandidate {
    const breakdown: Record<string, number> = {};
    let total = 0;

    // --- Guest name ---
    const nameScore = this.scoreGuestName(candidate.guest_name, caseData.guest_name);
    if (nameScore > 0) {
      breakdown[nameScore === SCORE_NAME_EXACT ? "name_exact" : "name_fuzzy"] = nameScore;
      total += nameScore;
    }

    // --- Charge date within stay dates (refund / service-not-rendered disputes) ---
    if (this.isDateWithinStay(caseData.charge_date, candidate.check_in, candidate.check_out)) {
      breakdown["date_in_stay"] = SCORE_DATE_IN_STAY;
      total += SCORE_DATE_IN_STAY;
    } else if (
      candidate.booking_created_at &&
      this.isDateNearBooking(caseData.charge_date, candidate.booking_created_at)
    ) {
      // --- Charge date near booking creation (original-transaction disputes) ---
      // Covers VRBO/HomeAway chargebacks where customers dispute the initial payment,
      // which happens at booking time — often weeks before the stay.
      breakdown["date_at_booking"] = SCORE_DATE_AT_BOOKING;
      total += SCORE_DATE_AT_BOOKING;
    }

    // --- Amount proximity ---
    if (this.isAmountClose(caseData.amount, candidate.total_amount)) {
      breakdown["amount_close"] = SCORE_AMOUNT_CLOSE;
      total += SCORE_AMOUNT_CLOSE;
    }

    // --- Channel match ---
    if (this.isChannelMatch(caseData.processor, candidate.channel)) {
      breakdown["channel_match"] = SCORE_CHANNEL_MATCH;
      total += SCORE_CHANNEL_MATCH;
    }

    return { ...candidate, score: total, score_breakdown: breakdown };
  }

  private isDateNearBooking(chargeDate: string, bookingCreatedAt: string): boolean {
    const charge = new Date(chargeDate).getTime();
    const booking = new Date(bookingCreatedAt).getTime();
    if (isNaN(charge) || isNaN(booking)) return false;
    const diffDays = Math.abs(charge - booking) / 86_400_000;
    return diffDays <= BOOKING_DATE_WINDOW_DAYS;
  }

  private scoreGuestName(candidateName: string, caseName: string): number {
    const normCandidate = candidateName.toLowerCase().trim();
    const normCase = caseName.toLowerCase().trim();

    if (normCandidate === normCase) return SCORE_NAME_EXACT;

    // Fuzzy: check if all parts of the case name appear in the candidate (handles middle names, etc.)
    const caseParts = normCase.split(/\s+/).filter((p) => p.length > 1);
    const candidateParts = normCandidate.split(/\s+/).filter((p) => p.length > 1);

    if (caseParts.length === 0) return 0;

    // Check if last names match (most reliable signal)
    const caseLastName = caseParts[caseParts.length - 1];
    const candidateLastName = candidateParts[candidateParts.length - 1];

    if (!caseLastName || !candidateLastName) return 0;

    const lastNameMatch = caseLastName === candidateLastName
      || this.levenshteinDistance(caseLastName, candidateLastName) <= 2;

    if (!lastNameMatch) return 0;

    // Last name matches; check first name proximity
    const caseFirstName = caseParts[0] ?? "";
    const candidateFirstName = candidateParts[0] ?? "";

    if (caseFirstName === candidateFirstName) return SCORE_NAME_EXACT;
    if (this.levenshteinDistance(caseFirstName, candidateFirstName) <= 2) return SCORE_NAME_FUZZY;

    // Last name match alone counts as fuzzy
    return SCORE_NAME_FUZZY;
  }

  private isDateWithinStay(chargeDate: string, checkIn: string, checkOut: string): boolean {
    const charge = new Date(chargeDate).getTime();
    // Expand window slightly: charges can hit 1 day before check-in (pre-auth)
    const start = new Date(checkIn).getTime() - 86_400_000;
    const end = new Date(checkOut).getTime() + 86_400_000;
    return charge >= start && charge <= end;
  }

  private isAmountClose(caseAmount: number, reservationAmount: number): boolean {
    if (reservationAmount === 0) return false;
    const diff = Math.abs(caseAmount - reservationAmount);
    return diff / reservationAmount <= AMOUNT_TOLERANCE;
  }

  private isChannelMatch(processor: string, channel: string | null): boolean {
    if (!channel) return false;
    const expectedChannels = PROCESSOR_CHANNEL_MAP[processor];
    if (!expectedChannels) return false;
    return expectedChannels.some((ec) => channel.toLowerCase().includes(ec));
  }

  // -------------------------------------------------------------------------
  // Levenshtein distance (for fuzzy name matching)
  // -------------------------------------------------------------------------

  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

    for (let i = 0; i <= m; i++) dp[i]![0] = i;
    for (let j = 0; j <= n; j++) dp[0]![j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i]![j] = Math.min(
          dp[i - 1]![j]! + 1,
          dp[i]![j - 1]! + 1,
          dp[i - 1]![j - 1]! + cost,
        );
      }
    }

    return dp[m]![n]!;
  }

  // -------------------------------------------------------------------------
  // Emit match result based on confidence tier
  // -------------------------------------------------------------------------

  private async emitMatchResult(
    caseData: CasePayload,
    scored: ScoredCandidate[],
    confidence: number,
    correlationId: string,
  ): Promise<void> {
    const best = scored[0] ?? null;
    const topCandidates = scored.slice(0, 5).map((c) => ({
      reservation_id: c.reservation_id,
      guest_name: c.guest_name,
      score: c.score,
      score_breakdown: c.score_breakdown,
    }));

    const basePayload = {
      case_id: caseData.case_id,
      amount: caseData.amount,
      confidence,
      reservation_id: best?.reservation_id ?? null,
      candidates: topCandidates,
    };

    if (confidence >= THRESHOLD_AUTO) {
      await this.emit("chargeback.match.auto", basePayload, { correlation_id: correlationId });
      this.log.info({ caseId: caseData.case_id, confidence }, "auto-match emitted");
    } else if (confidence >= THRESHOLD_PROBABLE) {
      await this.emit("chargeback.match.probable", basePayload, { correlation_id: correlationId });
      this.log.info({ caseId: caseData.case_id, confidence }, "probable match — awaiting human confirmation");
    } else {
      await this.emit("chargeback.match.ambiguous", basePayload, { correlation_id: correlationId });
      this.log.warn(
        { caseId: caseData.case_id, confidence, candidateCount: scored.length },
        "ambiguous match — escalating",
      );
    }
  }

  // -------------------------------------------------------------------------
  // DB updates
  // -------------------------------------------------------------------------

  private async updateCaseMatch(
    caseId: string,
    reservationId: string,
    confidence: number,
  ): Promise<void> {
    const sb = serviceClient();
    const { error } = await sb
      .from("chargeback_cases")
      .update({
        streamline_reservation_id: reservationId,
        match_confidence: confidence,
        matched_at: new Date().toISOString(),
      })
      .eq("case_id", caseId);

    if (error) {
      this.log.error({ error, caseId, reservationId }, "failed to update case with match");
    }
  }
}

export default new ReservationMatcher();
