/**
 * dossier-builder — assembles evidence from 9 systems into a
 * submission-ready chargeback dossier.
 *
 * Subscribes to:
 *   chargeback.match.auto       — high-confidence match, build immediately
 *   chargeback.match.confirmed  — human-confirmed match, build immediately
 *
 * Emits:
 *   chargeback.dossier.ready    — all critical evidence collected
 *   chargeback.dossier.blocked  — critical failure or validation mismatch
 *
 * Evidence sources (9 total, each mapped to an exhibit letter):
 *   A  Reservation Folio          — Streamline / reservations_cache
 *   B  Rental Agreement           — signed agreement (stub: Asana task)
 *   C  Guest ID Verification      — screening systems (stub: Asana task)
 *   D  Channel Booking Confirm.   — OTA booking detail (stub: Asana task)
 *   E  Guest Communications       — Akia thread (stub: Asana task)
 *   F  Smart Lock Logs            — ALWAYS manual (Asana subtask for Audrey)
 *   G  Inspection Photos          — work orders + photos from Streamline
 *   H  Payment Record             — Stripe transaction (stub Phase 1)
 *   I  Resolution Agreement       — prior refund/resolution search
 */

import {
  AgentBase,
  type AgentIdentity,
  serviceClient,
  sha256Hex,
} from "@shared/index.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const IDENTITY: AgentIdentity = {
  product: "chargeback",
  slug: "dossier-builder",
  display_name: "Chargeback Dossier Builder",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

type ExhibitStatus = "success" | "partial" | "failed" | "pending_human";

interface ExhibitResult {
  status: ExhibitStatus;
  source: string;
  exhibit_letter: string;
  exhibit_title: string;
  artifacts: string[];
  reason?: string;
}

type DisputeReason =
  | "fraud"
  | "service_not_rendered"
  | "not_as_described"
  | "duplicate"
  | "default";

interface CaseRecord {
  case_id: string;
  source: string;
  external_case_id: string;
  amount: number;
  currency: string;
  reason_code: string;
  guest_name: string;
  charge_date: string;
  processor_deadline: string;
  internal_deadline: string;
  streamline_reservation_id: string | null;
  stage: string;
}

interface ReservationMatch {
  reservation_id: string;
  guest_name: string;
  check_in: string;
  check_out: string;
  total_amount: number;
  channel: string | null;
  property_id: string | null;
  property_name?: string | null;
}

interface DossierManifest {
  dossier_key: string;
  case_id: string;
  reservation_id: string;
  dispute_reason: DisputeReason;
  exhibits: ExhibitResult[];
  exhibit_order: string[];
  gaps: ExhibitResult[];
  critical_failure: boolean;
  retrieval_log: Array<{ exhibit: string; status: ExhibitStatus; ms: number }>;
  built_at: string;
}

interface MatchPayload {
  case_id: string;
  reservation_id?: string;
  amount?: number;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Reason-code ordering — which exhibits matter most per dispute type
// ---------------------------------------------------------------------------

const REASON_ORDER: Record<DisputeReason, string[]> = {
  fraud:                ["C", "H", "F", "E", "A", "B", "D", "G", "I"],
  service_not_rendered: ["F", "I", "E", "G", "A", "B", "C", "D", "H"],
  not_as_described:     ["G", "E", "D", "A", "B", "C", "F", "H", "I"],
  duplicate:            ["A", "H", "I", "B", "C", "D", "E", "F", "G"],
  default:              ["A", "B", "D", "E", "H", "C", "F", "G", "I"],
};

/** Exhibits whose failure blocks the entire dossier. */
const CRITICAL_EXHIBITS = new Set(["A"]);

// ---------------------------------------------------------------------------
// Asana project for human-retrieval tasks (Phase 1 config)
// ---------------------------------------------------------------------------

const ASANA_PROJECT_ID = "chargeback_evidence_retrieval";
const ASANA_ASSIGNEE_AUDREY = "audrey";

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class DossierBuilder extends AgentBase {
  private unsubscribers: Array<() => void> = [];

  constructor() {
    super(IDENTITY);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.match.auto" }, async (ev) => {
        await this.handleBuildRequest(ev);
      }),
    );

    this.unsubscribers.push(
      this.on({ event_type: "chargeback.match.confirmed" }, async (ev) => {
        await this.handleBuildRequest(ev);
      }),
    );

    this.log.info("dossier builder online — listening for match.auto and match.confirmed");
  }

  protected async onStop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.log.info("dossier builder stopped");
  }

  // -------------------------------------------------------------------------
  // Main handler
  // -------------------------------------------------------------------------

  private async handleBuildRequest(ev: {
    event_id: string;
    correlation_id: string | null;
    payload: unknown;
  }): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    const payload = ev.payload as MatchPayload;
    const caseId = payload.case_id;

    this.log.info({ cid, caseId }, "dossier build request received");

    // 1. Load the case record
    const caseRecord = await this.loadCase(caseId);
    if (!caseRecord) {
      this.log.error({ caseId }, "case record not found — cannot build dossier");
      return;
    }

    // 2. Resolve reservation ID (from payload or case record)
    const reservationId = payload.reservation_id ?? caseRecord.streamline_reservation_id;
    if (!reservationId) {
      this.log.error({ caseId }, "no reservation ID available — cannot build dossier");
      await this.emitBlocked(caseId, "no_reservation_id", "No reservation ID on case or in match payload", cid);
      return;
    }

    // 3. Compute dossier key for idempotency
    const dossierKey = sha256Hex(`${caseRecord.external_case_id}-${reservationId}`);

    // 4. Check idempotency — return cached manifest if complete dossier exists
    const cached = await this.checkExistingDossier(dossierKey, caseId);
    if (cached) {
      this.log.info({ caseId, dossierKey }, "complete dossier already exists — returning cached manifest");
      await this.emit("chargeback.dossier.ready", cached, { correlation_id: cid });
      return;
    }

    // 5. Load the reservation match
    const reservation = await this.loadReservation(reservationId);
    if (!reservation) {
      this.log.error({ caseId, reservationId }, "reservation not found in cache");
      await this.emitBlocked(caseId, "reservation_not_found", `Reservation ${reservationId} not in reservations_cache`, cid);
      return;
    }

    // 6. Parallel evidence retrieval from 9 sources
    const retrievalLog: DossierManifest["retrieval_log"] = [];

    const retrievals = await Promise.all([
      this.timedRetrieve("A", () => this.fetchReservationFolio(reservationId), retrievalLog),
      this.timedRetrieve("B", () => this.fetchRentalAgreement(caseRecord, reservation), retrievalLog),
      this.timedRetrieve("C", () => this.fetchGuestIdVerification(caseRecord, reservation), retrievalLog),
      this.timedRetrieve("D", () => this.fetchChannelBookingConfirmation(caseRecord, reservation), retrievalLog),
      this.timedRetrieve("E", () => this.fetchGuestCommunications(caseRecord, reservation), retrievalLog),
      this.timedRetrieve("F", () => this.fetchSmartLockLogs(caseRecord, reservation), retrievalLog),
      this.timedRetrieve("G", () => this.fetchInspectionPhotos(reservation), retrievalLog),
      this.timedRetrieve("H", () => this.fetchPaymentRecord(caseRecord), retrievalLog),
      this.timedRetrieve("I", () => this.fetchResolutionAgreement(caseRecord, reservation), retrievalLog),
    ]);

    const exhibitMap = new Map<string, ExhibitResult>();
    for (const exhibit of retrievals) {
      exhibitMap.set(exhibit.exhibit_letter, exhibit);
    }

    // 7. Validation pass — check exhibits match the right guest, property, dates
    const validationError = this.validateExhibits(retrievals, caseRecord, reservation);
    if (validationError) {
      this.log.error({ caseId, validationError }, "exhibit validation failed — blocking dossier");
      await this.emitBlocked(caseId, "validation_failure", validationError, cid);
      return;
    }

    // 8. Reason-code ordering
    const disputeReason = this.mapDisputeReason(caseRecord.reason_code);
    const ordering = REASON_ORDER[disputeReason];
    const orderedExhibits = ordering.map((letter) => exhibitMap.get(letter)!).filter(Boolean);

    // 9. Build manifest
    const gaps = orderedExhibits.filter((e) => e.status === "failed" || e.status === "pending_human");
    const criticalFailure = orderedExhibits.some(
      (e) => CRITICAL_EXHIBITS.has(e.exhibit_letter) && e.status === "failed",
    );

    const manifest: DossierManifest = {
      dossier_key: dossierKey,
      case_id: caseId,
      reservation_id: reservationId,
      dispute_reason: disputeReason,
      exhibits: orderedExhibits,
      exhibit_order: ordering,
      gaps,
      critical_failure: criticalFailure,
      retrieval_log: retrievalLog,
      built_at: new Date().toISOString(),
    };

    // 10. Write evidence records to chargeback_evidence
    await this.persistEvidence(dossierKey, caseId, reservationId, orderedExhibits, manifest);

    // 11. Emit result
    if (criticalFailure) {
      this.log.warn({ caseId, dossierKey }, "dossier blocked — critical exhibit(s) failed");
      await this.emitBlocked(caseId, "critical_exhibit_failure",
        `Critical exhibits failed: ${gaps.filter((g) => CRITICAL_EXHIBITS.has(g.exhibit_letter)).map((g) => g.exhibit_letter).join(", ")}`,
        cid,
      );
    } else {
      this.log.info({ caseId, dossierKey, gapCount: gaps.length }, "dossier ready");
      await this.emit("chargeback.dossier.ready", manifest, { correlation_id: cid });
    }

    await this.audit({
      action: "dossier.built",
      entity_type: "chargeback_case",
      entity_id: caseId,
      correlation_id: cid,
      after_state: {
        dossier_key: dossierKey,
        exhibits_collected: orderedExhibits.filter((e) => e.status === "success").length,
        exhibits_partial: orderedExhibits.filter((e) => e.status === "partial").length,
        exhibits_pending: orderedExhibits.filter((e) => e.status === "pending_human").length,
        exhibits_failed: orderedExhibits.filter((e) => e.status === "failed").length,
        critical_failure: criticalFailure,
      },
      reason: `Dossier ${dossierKey} — ${orderedExhibits.filter((e) => e.status === "success").length}/9 exhibits collected`,
    });
  }

  // -------------------------------------------------------------------------
  // Evidence retrieval methods (9 sources)
  // -------------------------------------------------------------------------

  /** A — Reservation Folio from reservations_cache or Streamline */
  private async fetchReservationFolio(reservationId: string): Promise<ExhibitResult> {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("reservations_cache")
      .select("reservation_id, guest_name, check_in, check_out, total_amount, channel, property_id, folio_data")
      .eq("reservation_id", reservationId)
      .single();

    if (error || !data) {
      return {
        status: "failed",
        source: "reservations_cache",
        exhibit_letter: "A",
        exhibit_title: "Reservation Folio",
        artifacts: [],
        reason: error?.message ?? "Reservation not found in cache",
      };
    }

    const artifacts = [`reservation_folio:${reservationId}`];
    if (data.folio_data) artifacts.push(`folio_breakdown:${reservationId}`);

    return {
      status: "success",
      source: "reservations_cache",
      exhibit_letter: "A",
      exhibit_title: "Reservation Folio",
      artifacts,
    };
  }

  /** B — Rental Agreement / signed docs (stub: creates Asana task) */
  private async fetchRentalAgreement(caseRecord: CaseRecord, reservation: ReservationMatch): Promise<ExhibitResult> {
    const sb = serviceClient();

    // Try to find a signed agreement in documents table
    const { data } = await sb
      .from("chargeback_documents")
      .select("id, document_type, file_url")
      .eq("reservation_id", reservation.reservation_id)
      .eq("document_type", "rental_agreement")
      .limit(1);

    if (data && data.length > 0) {
      return {
        status: "success",
        source: "chargeback_documents",
        exhibit_letter: "B",
        exhibit_title: "Signed Rental Agreement",
        artifacts: data.map((d) => `document:${d.id}`),
      };
    }

    // Stub: create Asana task for manual retrieval
    await this.createHumanTask(
      `[CB-${caseRecord.external_case_id}] Retrieve signed rental agreement`,
      `Reservation: ${reservation.reservation_id}\nGuest: ${reservation.guest_name}\nProperty: ${reservation.property_id}\nDates: ${reservation.check_in} to ${reservation.check_out}\n\nPlease locate and upload the signed rental agreement for this reservation.`,
      caseRecord,
    );

    return {
      status: "pending_human",
      source: "asana_task",
      exhibit_letter: "B",
      exhibit_title: "Signed Rental Agreement",
      artifacts: [],
      reason: "Asana task created for manual retrieval",
    };
  }

  /** C — Guest ID Verification from screening systems (stub: creates Asana task) */
  private async fetchGuestIdVerification(caseRecord: CaseRecord, reservation: ReservationMatch): Promise<ExhibitResult> {
    const sb = serviceClient();

    // Check for existing ID verification records
    const { data } = await sb
      .from("chargeback_documents")
      .select("id, document_type, file_url")
      .eq("reservation_id", reservation.reservation_id)
      .eq("document_type", "guest_id")
      .limit(1);

    if (data && data.length > 0) {
      return {
        status: "success",
        source: "chargeback_documents",
        exhibit_letter: "C",
        exhibit_title: "Guest ID Verification",
        artifacts: data.map((d) => `document:${d.id}`),
      };
    }

    await this.createHumanTask(
      `[CB-${caseRecord.external_case_id}] Retrieve guest ID verification`,
      `Reservation: ${reservation.reservation_id}\nGuest: ${reservation.guest_name}\nProperty: ${reservation.property_id}\n\nPlease locate the guest's ID verification from the screening system (Autohost/Superhog) and upload it.`,
      caseRecord,
    );

    return {
      status: "pending_human",
      source: "asana_task",
      exhibit_letter: "C",
      exhibit_title: "Guest ID Verification",
      artifacts: [],
      reason: "Asana task created for manual retrieval",
    };
  }

  /** D — Channel Booking Confirmation (stub: creates Asana task) */
  private async fetchChannelBookingConfirmation(caseRecord: CaseRecord, reservation: ReservationMatch): Promise<ExhibitResult> {
    const sb = serviceClient();

    const { data } = await sb
      .from("chargeback_documents")
      .select("id, document_type, file_url")
      .eq("reservation_id", reservation.reservation_id)
      .eq("document_type", "booking_confirmation")
      .limit(1);

    if (data && data.length > 0) {
      return {
        status: "success",
        source: "chargeback_documents",
        exhibit_letter: "D",
        exhibit_title: "Channel Booking Confirmation",
        artifacts: data.map((d) => `document:${d.id}`),
      };
    }

    const channel = reservation.channel ?? caseRecord.source;
    await this.createHumanTask(
      `[CB-${caseRecord.external_case_id}] Retrieve ${channel} booking confirmation`,
      `Reservation: ${reservation.reservation_id}\nGuest: ${reservation.guest_name}\nChannel: ${channel}\nDates: ${reservation.check_in} to ${reservation.check_out}\n\nPlease screenshot or export the booking confirmation from ${channel} and upload it.`,
      caseRecord,
    );

    return {
      status: "pending_human",
      source: "asana_task",
      exhibit_letter: "D",
      exhibit_title: "Channel Booking Confirmation",
      artifacts: [],
      reason: "Asana task created for manual retrieval",
    };
  }

  /** E — Guest Communications from Akia (stub: creates Asana task) */
  private async fetchGuestCommunications(caseRecord: CaseRecord, reservation: ReservationMatch): Promise<ExhibitResult> {
    const sb = serviceClient();

    // Check for cached Akia threads
    const { data } = await sb
      .from("chargeback_documents")
      .select("id, document_type, file_url")
      .eq("reservation_id", reservation.reservation_id)
      .eq("document_type", "guest_communications")
      .limit(5);

    if (data && data.length > 0) {
      return {
        status: "success",
        source: "chargeback_documents",
        exhibit_letter: "E",
        exhibit_title: "Guest Communications",
        artifacts: data.map((d) => `document:${d.id}`),
      };
    }

    await this.createHumanTask(
      `[CB-${caseRecord.external_case_id}] Export Akia guest communication thread`,
      `Reservation: ${reservation.reservation_id}\nGuest: ${reservation.guest_name}\nDates: ${reservation.check_in} to ${reservation.check_out}\n\nPlease export the full Akia message thread for this guest/reservation and upload the PDF or screenshots.`,
      caseRecord,
    );

    return {
      status: "pending_human",
      source: "asana_task",
      exhibit_letter: "E",
      exhibit_title: "Guest Communications",
      artifacts: [],
      reason: "Asana task created for manual retrieval",
    };
  }

  /** F — Smart Lock Logs — ALWAYS creates Asana subtask for Audrey */
  private async fetchSmartLockLogs(caseRecord: CaseRecord, reservation: ReservationMatch): Promise<ExhibitResult> {
    await this.createHumanTask(
      `[CB-${caseRecord.external_case_id}] Pull smart lock access logs`,
      `Reservation: ${reservation.reservation_id}\nGuest: ${reservation.guest_name}\nProperty: ${reservation.property_id} — ${reservation.property_name ?? "N/A"}\nDates: ${reservation.check_in} to ${reservation.check_out}\n\nPlease pull the smart lock access logs for this property during the reservation dates. Export showing all access events (check-in, check-out, any mid-stay access).`,
      caseRecord,
      ASANA_ASSIGNEE_AUDREY,
    );

    return {
      status: "pending_human",
      source: "asana_task_audrey",
      exhibit_letter: "F",
      exhibit_title: "Smart Lock Access Logs",
      artifacts: [],
      reason: "Manual retrieval — Asana task assigned to Audrey",
    };
  }

  /** G — Inspection Photos from Streamline work orders */
  private async fetchInspectionPhotos(reservation: ReservationMatch): Promise<ExhibitResult> {
    if (!reservation.property_id) {
      return {
        status: "failed",
        source: "work_orders",
        exhibit_letter: "G",
        exhibit_title: "Inspection Photos",
        artifacts: [],
        reason: "No property_id on reservation — cannot query work orders",
      };
    }

    const sb = serviceClient();

    // Query work orders with photos for this property around the stay dates
    const { data, error } = await sb
      .from("work_orders_cache")
      .select("id, work_order_type, status, photos, completed_at")
      .eq("property_id", reservation.property_id)
      .gte("completed_at", reservation.check_in)
      .lte("completed_at", reservation.check_out)
      .in("work_order_type", ["inspection", "housekeeping", "turnover"])
      .order("completed_at", { ascending: false })
      .limit(20);

    if (error) {
      return {
        status: "failed",
        source: "work_orders_cache",
        exhibit_letter: "G",
        exhibit_title: "Inspection Photos",
        artifacts: [],
        reason: error.message,
      };
    }

    if (!data || data.length === 0) {
      return {
        status: "partial",
        source: "work_orders_cache",
        exhibit_letter: "G",
        exhibit_title: "Inspection Photos",
        artifacts: [],
        reason: "No work orders with photos found for this property/date range",
      };
    }

    const artifacts: string[] = [];
    for (const wo of data) {
      artifacts.push(`work_order:${wo.id}`);
      const photos = wo.photos as string[] | null;
      if (photos && photos.length > 0) {
        for (const photoUrl of photos) {
          artifacts.push(`photo:${photoUrl}`);
        }
      }
    }

    return {
      status: artifacts.some((a) => a.startsWith("photo:")) ? "success" : "partial",
      source: "work_orders_cache",
      exhibit_letter: "G",
      exhibit_title: "Inspection Photos",
      artifacts,
      reason: artifacts.some((a) => a.startsWith("photo:"))
        ? undefined
        : "Work orders found but no photos attached",
    };
  }

  /** H — Payment Record from Stripe (stub in Phase 1) */
  private async fetchPaymentRecord(caseRecord: CaseRecord): Promise<ExhibitResult> {
    const sb = serviceClient();

    // Check for cached payment records
    const { data } = await sb
      .from("chargeback_documents")
      .select("id, document_type, file_url, metadata")
      .eq("case_id", caseRecord.case_id)
      .eq("document_type", "payment_record")
      .limit(1);

    if (data && data.length > 0) {
      return {
        status: "success",
        source: "chargeback_documents",
        exhibit_letter: "H",
        exhibit_title: "Payment Transaction Record",
        artifacts: data.map((d) => `document:${d.id}`),
      };
    }

    // Phase 1 stub — Stripe integration not yet wired
    await this.createHumanTask(
      `[CB-${caseRecord.external_case_id}] Export Stripe/processor payment record`,
      `Case: ${caseRecord.external_case_id}\nProcessor: ${caseRecord.source}\nAmount: $${caseRecord.amount} ${caseRecord.currency}\nCharge Date: ${caseRecord.charge_date}\n\nPlease export the payment transaction detail from ${caseRecord.source} and upload it.`,
      caseRecord,
    );

    return {
      status: "pending_human",
      source: "asana_task",
      exhibit_letter: "H",
      exhibit_title: "Payment Transaction Record",
      artifacts: [],
      reason: "Phase 1 stub — Asana task created for manual Stripe export",
    };
  }

  /** I — Resolution Agreement — search for prior refund/resolution */
  private async fetchResolutionAgreement(caseRecord: CaseRecord, reservation: ReservationMatch): Promise<ExhibitResult> {
    const sb = serviceClient();

    // Search for any prior resolution or refund tied to this reservation
    const { data: resolutionDocs } = await sb
      .from("chargeback_documents")
      .select("id, document_type, file_url")
      .eq("reservation_id", reservation.reservation_id)
      .in("document_type", ["resolution_agreement", "refund_record", "credit_memo"])
      .limit(5);

    if (resolutionDocs && resolutionDocs.length > 0) {
      return {
        status: "success",
        source: "chargeback_documents",
        exhibit_letter: "I",
        exhibit_title: "Prior Resolution / Refund Agreement",
        artifacts: resolutionDocs.map((d) => `document:${d.id}`),
      };
    }

    // Also check if there are notes on the case about prior resolutions
    const { data: caseNotes } = await sb
      .from("chargeback_case_notes")
      .select("id, note_type, content")
      .eq("case_id", caseRecord.case_id)
      .ilike("content", "%refund%")
      .limit(5);

    if (caseNotes && caseNotes.length > 0) {
      return {
        status: "partial",
        source: "chargeback_case_notes",
        exhibit_letter: "I",
        exhibit_title: "Prior Resolution / Refund Agreement",
        artifacts: caseNotes.map((n) => `case_note:${n.id}`),
        reason: "Found case notes referencing refunds but no formal resolution document",
      };
    }

    // No prior resolution found — this is fine, not every case has one
    return {
      status: "success",
      source: "chargeback_documents",
      exhibit_letter: "I",
      exhibit_title: "Prior Resolution / Refund Agreement",
      artifacts: [],
      reason: "No prior resolution or refund found — none expected for this case",
    };
  }

  // -------------------------------------------------------------------------
  // Validation pass
  // -------------------------------------------------------------------------

  /**
   * Verify that collected exhibit data matches the case's guest, property,
   * and dates. Returns an error string if mismatch detected, null if OK.
   */
  private validateExhibits(
    exhibits: ExhibitResult[],
    caseRecord: CaseRecord,
    reservation: ReservationMatch,
  ): string | null {
    // Only validate exhibits that succeeded — failed/pending can't mismatch
    const folio = exhibits.find((e) => e.exhibit_letter === "A");

    if (folio && folio.status === "success") {
      // The folio artifacts reference the reservation ID — confirm it matches
      const folioResId = folio.artifacts
        .find((a) => a.startsWith("reservation_folio:"))
        ?.split(":")[1];

      if (folioResId && folioResId !== reservation.reservation_id) {
        return `Exhibit A reservation ID mismatch: folio has ${folioResId}, expected ${reservation.reservation_id}`;
      }
    }

    // Verify guest name consistency between case and reservation
    const caseNameNorm = caseRecord.guest_name.toLowerCase().trim();
    const resNameNorm = reservation.guest_name.toLowerCase().trim();

    if (caseNameNorm && resNameNorm) {
      // Extract last names for a basic sanity check
      const caseLast = caseNameNorm.split(/\s+/).pop() ?? "";
      const resLast = resNameNorm.split(/\s+/).pop() ?? "";

      if (caseLast.length > 2 && resLast.length > 2 && caseLast !== resLast) {
        // Allow fuzzy: if Levenshtein > 3, flag it
        if (this.levenshtein(caseLast, resLast) > 3) {
          return `Guest name mismatch: case has "${caseRecord.guest_name}", reservation has "${reservation.guest_name}"`;
        }
      }
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async loadCase(caseId: string): Promise<CaseRecord | null> {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("chargeback_cases")
      .select("case_id, source, external_case_id, amount, currency, reason_code, guest_name, charge_date, processor_deadline, internal_deadline, streamline_reservation_id, stage")
      .eq("case_id", caseId)
      .single();

    if (error || !data) {
      this.log.error({ error, caseId }, "failed to load case record");
      return null;
    }

    return data as CaseRecord;
  }

  private async loadReservation(reservationId: string): Promise<ReservationMatch | null> {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("reservations_cache")
      .select("reservation_id, guest_name, check_in, check_out, total_amount, channel, property_id, property_name")
      .eq("reservation_id", reservationId)
      .single();

    if (error || !data) {
      this.log.error({ error, reservationId }, "failed to load reservation");
      return null;
    }

    return data as ReservationMatch;
  }

  private async checkExistingDossier(dossierKey: string, caseId: string): Promise<DossierManifest | null> {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("chargeback_evidence")
      .select("manifest")
      .eq("dossier_key", dossierKey)
      .eq("case_id", caseId)
      .eq("status", "complete")
      .single();

    if (error || !data?.manifest) return null;

    return data.manifest as DossierManifest;
  }

  private async persistEvidence(
    dossierKey: string,
    caseId: string,
    reservationId: string,
    exhibits: ExhibitResult[],
    manifest: DossierManifest,
  ): Promise<void> {
    const sb = serviceClient();

    const allSuccess = exhibits.every((e) => e.status === "success");
    const hasFailure = exhibits.some((e) => e.status === "failed");

    const { error } = await sb
      .from("chargeback_evidence")
      .upsert(
        {
          dossier_key: dossierKey,
          case_id: caseId,
          reservation_id: reservationId,
          status: manifest.critical_failure ? "blocked" : allSuccess ? "complete" : hasFailure ? "partial" : "pending",
          exhibit_count: exhibits.length,
          exhibits_collected: exhibits.filter((e) => e.status === "success").length,
          exhibits_pending: exhibits.filter((e) => e.status === "pending_human").length,
          manifest,
          built_at: manifest.built_at,
        },
        { onConflict: "dossier_key" },
      );

    if (error) {
      this.log.error({ error, dossierKey }, "failed to persist evidence record");
    }
  }

  /**
   * Create an Asana task for human evidence retrieval.
   * Phase 1: writes to chargeback_human_tasks table (picked up by Asana sync).
   */
  private async createHumanTask(
    title: string,
    description: string,
    caseRecord: CaseRecord,
    assignee?: string,
  ): Promise<void> {
    const sb = serviceClient();

    const { error } = await sb.from("chargeback_human_tasks").insert({
      case_id: caseRecord.case_id,
      external_case_id: caseRecord.external_case_id,
      title,
      description,
      assignee: assignee ?? ASANA_ASSIGNEE_AUDREY,
      project: ASANA_PROJECT_ID,
      priority: "high",
      due_date: caseRecord.internal_deadline,
      status: "pending",
      created_at: new Date().toISOString(),
    });

    if (error) {
      this.log.error({ error, title }, "failed to create human task record");
    } else {
      this.log.info({ title, assignee: assignee ?? ASANA_ASSIGNEE_AUDREY }, "human task created for evidence retrieval");
    }
  }

  /** Timed retrieval wrapper — runs a fetch function and records elapsed time. */
  private async timedRetrieve(
    exhibitLetter: string,
    fn: () => Promise<ExhibitResult>,
    log: DossierManifest["retrieval_log"],
  ): Promise<ExhibitResult> {
    const start = Date.now();
    try {
      const result = await fn();
      log.push({ exhibit: exhibitLetter, status: result.status, ms: Date.now() - start });
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      this.log.error({ err, exhibit: exhibitLetter, elapsed }, "exhibit retrieval threw");
      log.push({ exhibit: exhibitLetter, status: "failed", ms: elapsed });
      return {
        status: "failed",
        source: "error",
        exhibit_letter: exhibitLetter,
        exhibit_title: `Exhibit ${exhibitLetter}`,
        artifacts: [],
        reason: err instanceof Error ? err.message : "Unknown retrieval error",
      };
    }
  }

  private async emitBlocked(
    caseId: string,
    blockReason: string,
    detail: string,
    correlationId: string,
  ): Promise<void> {
    await this.emit("chargeback.dossier.blocked", {
      case_id: caseId,
      block_reason: blockReason,
      detail,
    }, { correlation_id: correlationId });
  }

  private mapDisputeReason(reasonCode: string): DisputeReason {
    switch (reasonCode) {
      case "fraudulent":
        return "fraud";
      case "service_not_rendered":
        return "service_not_rendered";
      case "not_as_described":
        return "not_as_described";
      case "duplicate":
        return "duplicate";
      default:
        return "default";
    }
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
    for (let i = 0; i <= m; i++) dp[i]![0] = i;
    for (let j = 0; j <= n; j++) dp[0]![j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
      }
    }
    return dp[m]![n]!;
  }
}

export default new DossierBuilder();
