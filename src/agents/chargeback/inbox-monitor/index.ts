/**
 * inbox-monitor — scans for chargeback-related emails/notifications and
 * creates (or updates) cases in the chargeback_cases table.
 *
 * Phase 1: listens for `chargeback.inbox.poll` events dispatched by the
 * orchestrator on a 15-minute cadence. Future phases will add push
 * webhooks from Stripe/Lynnbrook.
 *
 * Responsibilities:
 *  - Classify inbound messages (new chargeback, outcome, or unrelated)
 *  - Parse processor-specific fields into a canonical shape
 *  - Idempotently insert into chargeback_cases
 *  - Compute an internal deadline (processor deadline minus 2 biz days)
 *  - Emit chargeback.case.notified or chargeback.case.decided
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
  slug: "inbox-monitor",
  display_name: "Chargeback Inbox Monitor",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

type Processor = "stripe" | "lynnbrook" | "airbnb_resolutions" | "vrbo";

type ReasonCode =
  | "fraudulent"
  | "not_as_described"
  | "service_not_rendered"
  | "duplicate"
  | "credit_not_processed"
  | "subscription_cancelled"
  | "unrecognized"
  | "other";

type MessageClassification = "new_chargeback" | "outcome" | "unrelated";
type OutcomeDecision = "won" | "lost" | "partial";

interface ParsedChargeback {
  processor: Processor;
  external_case_id: string;
  amount: number;
  currency: string;
  reason_code: ReasonCode;
  guest_name: string;
  charge_date: string;           // ISO date
  processor_deadline: string;    // ISO date
  raw_subject?: string;
  raw_body_preview?: string;
}

interface ParsedOutcome {
  processor: Processor;
  external_case_id: string;
  decision: OutcomeDecision;
  net_amount?: number;
  processor_notes?: string;
}

interface InboxMessage {
  message_id: string;
  subject: string;
  body: string;
  from: string;
  received_at: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROCESSOR_PATTERNS: Record<Processor, RegExp> = {
  stripe:              /stripe/i,
  lynnbrook:           /lynnbrook/i,
  airbnb_resolutions:  /airbnb.*resol|resol.*airbnb/i,
  vrbo:                /vrbo|homeaway|expedia.*group.*dispute/i,
};

const REASON_CODE_MAP: Record<string, ReasonCode> = {
  fraudulent:              "fraudulent",
  fraud:                   "fraudulent",
  "not as described":      "not_as_described",
  "product not received":  "service_not_rendered",
  "service not rendered":  "service_not_rendered",
  duplicate:               "duplicate",
  "credit not processed":  "credit_not_processed",
  "subscription canceled": "subscription_cancelled",
  "subscription cancelled":"subscription_cancelled",
  unrecognized:            "unrecognized",
};

const INTERNAL_DEADLINE_BUFFER_DAYS = -2; // subtract 2 business days

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class InboxMonitor extends AgentBase {
  private unsubscribers: Array<() => void> = [];

  constructor() {
    super(IDENTITY);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    const unsub = this.on(
      { event_type: "chargeback.inbox.poll" },
      async (ev) => { await this.handlePoll(ev); },
    );
    this.unsubscribers.push(unsub);

    this.log.info("inbox monitor online — listening for chargeback.inbox.poll");
  }

  protected async onStop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.log.info("inbox monitor stopped");
  }

  // -------------------------------------------------------------------------
  // Poll handler
  // -------------------------------------------------------------------------

  private async handlePoll(ev: {
    event_id: string;
    correlation_id: string | null;
    payload: unknown;
  }): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    this.log.info({ cid }, "inbox poll triggered — scanning for chargeback messages");

    const messages = await this.fetchUnprocessedMessages();

    if (messages.length === 0) {
      this.log.debug({ cid }, "no unprocessed chargeback messages found");
      return;
    }

    this.log.info({ cid, count: messages.length }, "found unprocessed messages");

    for (const msg of messages) {
      try {
        await this.processMessage(msg, cid);
      } catch (err) {
        this.log.error({ err, messageId: msg.message_id, cid }, "failed to process message");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Message fetching
  // -------------------------------------------------------------------------

  private async fetchUnprocessedMessages(): Promise<InboxMessage[]> {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("chargeback_inbox")
      .select("message_id, subject, body, from_address, received_at, metadata")
      .eq("processed", false)
      .order("received_at", { ascending: true })
      .limit(50);

    if (error) {
      this.log.error({ error }, "failed to fetch inbox messages");
      return [];
    }

    return (data ?? []).map((row) => ({
      message_id: row.message_id,
      subject: row.subject,
      body: row.body,
      from: row.from_address,
      received_at: row.received_at,
      metadata: row.metadata as Record<string, unknown> | undefined,
    }));
  }

  // -------------------------------------------------------------------------
  // Classification + routing
  // -------------------------------------------------------------------------

  private async processMessage(msg: InboxMessage, correlationId: string): Promise<void> {
    const classification = this.classifyMessage(msg);

    await this.audit({
      action: "inbox.classified",
      entity_type: "inbox_message",
      entity_id: msg.message_id,
      correlation_id: correlationId,
      reason: `Classified as: ${classification}`,
      evidence: { subject: msg.subject, from: msg.from },
    });

    if (classification === "new_chargeback") {
      await this.handleNewChargeback(msg, correlationId);
    } else if (classification === "outcome") {
      await this.handleOutcome(msg, correlationId);
    }

    // Mark as processed regardless of classification
    await this.markProcessed(msg.message_id);
  }

  private classifyMessage(msg: InboxMessage): MessageClassification {
    const combined = `${msg.subject} ${msg.body}`.toLowerCase();

    const isChargeback = /chargeback|dispute|payment.*contest|claim.*filed/i.test(combined);
    if (!isChargeback) return "unrelated";

    const isOutcome = /resolved|decided|won|lost|closed|upheld|reversed|partial/i.test(combined);
    if (isOutcome) return "outcome";

    return "new_chargeback";
  }

  // -------------------------------------------------------------------------
  // New chargeback handling
  // -------------------------------------------------------------------------

  private async handleNewChargeback(msg: InboxMessage, correlationId: string): Promise<void> {
    const parsed = this.parseChargeback(msg);
    if (!parsed) {
      this.log.warn({ messageId: msg.message_id }, "could not parse chargeback fields — skipping");
      return;
    }

    // Idempotent upsert keyed on (processor, external_case_id)
    const sb = serviceClient();
    const internalDeadline = this.addBusinessDays(
      new Date(parsed.processor_deadline),
      INTERNAL_DEADLINE_BUFFER_DAYS,
    );

    const { data: upserted, error } = await sb
      .from("chargeback_cases")
      .upsert(
        {
          source: parsed.processor,
          external_case_id: parsed.external_case_id,
          notified_at: new Date().toISOString(),
          amount: parsed.amount,
          currency: parsed.currency,
          reason_code: parsed.reason_code,
          guest_name: parsed.guest_name,
          charge_date: parsed.charge_date,
          processor_deadline: parsed.processor_deadline,
          internal_deadline: internalDeadline.toISOString().slice(0, 10),
          // stage defaults to 'notified' at the schema level
          inbox_message_id: msg.message_id,
        },
        { onConflict: "source,external_case_id", ignoreDuplicates: false },
      )
      .select("case_id, source, external_case_id, amount, stage")
      .single();

    if (error) {
      this.log.error({ error, parsed }, "upsert into chargeback_cases failed");
      return;
    }

    const caseId = upserted.case_id as string;

    await this.audit({
      action: "case.created",
      entity_type: "chargeback_case",
      entity_id: caseId,
      correlation_id: correlationId,
      after_state: upserted,
      reason: `New chargeback from ${parsed.processor} — $${parsed.amount} (${parsed.reason_code})`,
    });

    await this.emit("chargeback.case.notified", {
      case_id: caseId,
      processor: parsed.processor,
      external_case_id: parsed.external_case_id,
      amount: parsed.amount,
      currency: parsed.currency,
      reason_code: parsed.reason_code,
      guest_name: parsed.guest_name,
      charge_date: parsed.charge_date,
      processor_deadline: parsed.processor_deadline,
      internal_deadline: internalDeadline.toISOString().slice(0, 10),
    }, { correlation_id: correlationId });

    this.log.info(
      { caseId, processor: parsed.processor, amount: parsed.amount },
      "chargeback case created and notified",
    );
  }

  // -------------------------------------------------------------------------
  // Outcome handling
  // -------------------------------------------------------------------------

  private async handleOutcome(msg: InboxMessage, correlationId: string): Promise<void> {
    const parsed = this.parseOutcome(msg);
    if (!parsed) {
      this.log.warn({ messageId: msg.message_id }, "could not parse outcome fields — skipping");
      return;
    }

    // Look up existing case
    const sb = serviceClient();
    const { data: existing } = await sb
      .from("chargeback_cases")
      .select("case_id, stage")
      .eq("source", parsed.processor)
      .eq("external_case_id", parsed.external_case_id)
      .single();

    if (!existing) {
      this.log.warn({ parsed }, "outcome received for unknown case — skipping");
      return;
    }

    const caseId = existing.case_id as string;

    await sb
      .from("chargeback_cases")
      .update({ stage: parsed.decision, decided_at: new Date().toISOString() })
      .eq("case_id", caseId);

    await this.audit({
      action: "case.decided",
      entity_type: "chargeback_case",
      entity_id: caseId,
      correlation_id: correlationId,
      before_state: { stage: existing.stage },
      after_state: { stage: parsed.decision },
      reason: `Outcome from ${parsed.processor}: ${parsed.decision}`,
    });

    await this.emit("chargeback.case.decided", {
      case_id: caseId,
      processor: parsed.processor,
      external_case_id: parsed.external_case_id,
      decision: parsed.decision,
      net_amount: parsed.net_amount,
      processor_notes: parsed.processor_notes,
    }, { correlation_id: correlationId });

    this.log.info({ caseId, decision: parsed.decision }, "chargeback outcome recorded");
  }

  // -------------------------------------------------------------------------
  // Parsing helpers
  // -------------------------------------------------------------------------

  private parseChargeback(msg: InboxMessage): ParsedChargeback | null {
    const combined = `${msg.subject} ${msg.body}`;
    const processor = this.detectProcessor(combined);
    if (!processor) return null;

    const externalId = this.extractPattern(combined, /(?:case|dispute|claim)[#:\s]*([A-Za-z0-9_-]{4,})/i);
    if (!externalId) return null;

    const amountStr = this.extractPattern(combined, /\$\s?([\d,]+\.?\d{0,2})/);
    const amount = amountStr ? parseFloat(amountStr.replace(/,/g, "")) : 0;

    const currency = this.extractPattern(combined, /\b(USD|CAD|EUR|GBP)\b/i)?.toUpperCase() ?? "USD";
    const reasonCode = this.normalizeReasonCode(combined);
    const guestName = this.extractPattern(combined, /(?:guest|cardholder|customer)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/i) ?? "Unknown";
    const chargeDate = this.extractDate(combined, /(?:charge|transaction)\s*date[:\s]*([\d/-]+)/i) ?? msg.received_at.slice(0, 10);
    const deadline = this.extractDate(combined, /(?:deadline|due|respond by|evidence due)[:\s]*([\d/-]+)/i) ?? this.defaultDeadline();

    return {
      processor,
      external_case_id: externalId,
      amount,
      currency,
      reason_code: reasonCode,
      guest_name: guestName,
      charge_date: chargeDate,
      processor_deadline: deadline,
      raw_subject: msg.subject,
      raw_body_preview: msg.body.slice(0, 500),
    };
  }

  private parseOutcome(msg: InboxMessage): ParsedOutcome | null {
    const combined = `${msg.subject} ${msg.body}`;
    const processor = this.detectProcessor(combined);
    if (!processor) return null;

    const externalId = this.extractPattern(combined, /(?:case|dispute|claim)[#:\s]*([A-Za-z0-9_-]{4,})/i);
    if (!externalId) return null;

    let decision: OutcomeDecision = "lost";
    if (/\b(won|reversed|favor.*merchant|resolved.*your.*favor)\b/i.test(combined)) {
      decision = "won";
    } else if (/\bpartial/i.test(combined)) {
      decision = "partial";
    }

    const amountStr = this.extractPattern(combined, /\$\s?([\d,]+\.?\d{0,2})/);
    const netAmount = amountStr ? parseFloat(amountStr.replace(/,/g, "")) : undefined;

    return {
      processor,
      external_case_id: externalId,
      decision,
      net_amount: netAmount,
      processor_notes: msg.body.slice(0, 1000),
    };
  }

  private detectProcessor(text: string): Processor | null {
    for (const [proc, pattern] of Object.entries(PROCESSOR_PATTERNS) as [Processor, RegExp][]) {
      if (pattern.test(text)) return proc;
    }
    return null;
  }

  private normalizeReasonCode(text: string): ReasonCode {
    const lower = text.toLowerCase();
    for (const [keyword, code] of Object.entries(REASON_CODE_MAP)) {
      if (lower.includes(keyword)) return code;
    }
    return "other";
  }

  private extractPattern(text: string, pattern: RegExp): string | null {
    const match = text.match(pattern);
    return match?.[1]?.trim() ?? null;
  }

  private extractDate(text: string, pattern: RegExp): string | null {
    const raw = this.extractPattern(text, pattern);
    if (!raw) return null;
    const parsed = new Date(raw);
    return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }

  private defaultDeadline(): string {
    // Default: 30 days from now
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  }

  // -------------------------------------------------------------------------
  // Business-day arithmetic
  // -------------------------------------------------------------------------

  /**
   * Add (or subtract) N business days from a date. Skips weekends.
   * Negative values subtract business days.
   */
  private addBusinessDays(start: Date, days: number): Date {
    const result = new Date(start);
    const direction = days >= 0 ? 1 : -1;
    let remaining = Math.abs(days);

    while (remaining > 0) {
      result.setDate(result.getDate() + direction);
      const dow = result.getDay();
      if (dow !== 0 && dow !== 6) remaining--;
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // DB helpers
  // -------------------------------------------------------------------------

  private async markProcessed(messageId: string): Promise<void> {
    const sb = serviceClient();
    await sb
      .from("chargeback_inbox")
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq("message_id", messageId);
  }
}

export default new InboxMonitor();
