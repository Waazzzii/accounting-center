/**
 * chargeback-orchestrator — parent agent coordinating all 6 Phase 4
 * chargeback sub-agents.
 *
 * This agent is a DISPATCHER, not a DECIDER. It routes events between
 * sub-agents, enforces human gates, monitors SLAs, and runs scheduled
 * workflows. It never makes chargeback decisions itself.
 *
 * Sub-agents: inbox-monitor, reservation-matcher, case-tracker,
 *             dossier-builder, narrative-drafter, outcome-analyst
 */

import {
  AgentBase,
  type AgentIdentity,
} from "@shared/index.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const IDENTITY: AgentIdentity = {
  product: "chargeback",
  slug: "chargeback-orchestrator",
  display_name: "Chargeback Orchestrator",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INBOX_POLL_MS = 15 * 60 * 1_000;           // 15 minutes
const DAILY_DIGEST_HOUR = 7;                       // 7 AM PT
const DAILY_DIGEST_CHECK_MS = 60 * 1_000;         // check every minute
const MONTHLY_REPORT_DAY = 1;                      // 1st business day

/** Expected completion times per sub-agent (seconds). */
const SLA_LIMITS: Record<string, number> = {
  "inbox-monitor":       120,
  "reservation-matcher":  60,
  "case-tracker":        180,
  "dossier-builder":     300,
  "narrative-drafter":   180,
  "outcome-analyst":     120,
};

/** Dollar thresholds for narrative approval routing. */
const THRESHOLD_JOCELYN = 2_500;
const THRESHOLD_COO     = 10_000;

// ---------------------------------------------------------------------------
// Pending dispatch tracker — for SLA monitoring
// ---------------------------------------------------------------------------

interface PendingDispatch {
  agent: string;
  dispatchedAt: number;
  correlationId: string;
  eventType: string;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class ChargebackOrchestrator extends AgentBase {
  private unsubscribers: Array<() => void> = [];
  private inboxPollTimer: ReturnType<typeof setInterval> | null = null;
  private dailyCheckTimer: ReturnType<typeof setInterval> | null = null;
  private slaCheckTimer: ReturnType<typeof setInterval> | null = null;
  private pendingDispatches = new Map<string, PendingDispatch>();
  private lastDailyDigest: string | null = null;
  private lastMonthlyReport: string | null = null;

  constructor() {
    super(IDENTITY);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    this.registerEventRoutes();
    this.startScheduledWorkflows();

    this.log.info("chargeback orchestrator online — dispatching, never deciding");
  }

  protected async onStop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];

    if (this.inboxPollTimer) { clearInterval(this.inboxPollTimer); this.inboxPollTimer = null; }
    if (this.dailyCheckTimer) { clearInterval(this.dailyCheckTimer); this.dailyCheckTimer = null; }
    if (this.slaCheckTimer) { clearInterval(this.slaCheckTimer); this.slaCheckTimer = null; }

    this.pendingDispatches.clear();
    this.log.info("chargeback orchestrator stopped");
  }

  // -------------------------------------------------------------------------
  // Event routing — subscribe to domain events, dispatch sub-agents
  // -------------------------------------------------------------------------

  private registerEventRoutes(): void {
    // 1. New chargeback notification from inbox-monitor
    this.sub("chargeback.case.notified", async (ev) => {
      const cid = ev.correlation_id ?? ev.event_id;
      this.log.info({ cid }, "case notified — dispatching matcher + tracker in parallel");

      await Promise.all([
        this.dispatch("reservation-matcher", "chargeback.match.request", ev.payload, cid),
        this.dispatch("case-tracker", "chargeback.case.track", ev.payload, cid),
      ]);

      await this.audit({
        action: "orchestrator.routed",
        entity_type: "chargeback_case",
        entity_id: (ev.payload as Record<string, unknown>)?.case_id as string ?? "unknown",
        correlation_id: cid,
        reason: "Dispatched reservation-matcher and case-tracker in parallel",
      });
    });

    // 2. Auto match (confidence >= 95) — go straight to dossier
    this.sub("chargeback.match.auto", async (ev) => {
      const cid = ev.correlation_id ?? ev.event_id;
      const payload = ev.payload as Record<string, unknown>;
      this.log.info({ cid, confidence: payload?.confidence }, "auto-match — dispatching dossier-builder");

      await this.dispatch("dossier-builder", "chargeback.dossier.build", ev.payload, cid);
    });

    // 3. Probable match (75-95) — hold for human confirmation
    this.sub("chargeback.match.probable", async (ev) => {
      const cid = ev.correlation_id ?? ev.event_id;
      const payload = ev.payload as Record<string, unknown>;
      const caseId = payload?.case_id as string ?? "unknown";

      this.log.info({ cid, confidence: payload?.confidence }, "probable match — requesting human confirmation");

      await this.requestApproval({
        action: "match.confirm",
        entity_type: "chargeback_case",
        entity_id: caseId,
        summary: `Reservation match needs confirmation (${payload?.confidence}% confidence)`,
        detail: { ...payload as Record<string, unknown>, match_tier: "probable" },
        suggested_action: "Review the matched reservation and confirm or reject the match",
        risk_level: "warn",
        required_approver_role: "chargeback_specialist",
        correlation_id: cid,
        dollar_impact: payload?.amount as number,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000), // 24h
      });
    });

    // 4. Ambiguous match (<75) — escalate to Jocelyn
    this.sub("chargeback.match.ambiguous", async (ev) => {
      const cid = ev.correlation_id ?? ev.event_id;
      const payload = ev.payload as Record<string, unknown>;

      this.log.warn({ cid, confidence: payload?.confidence }, "ambiguous match — escalating to Jocelyn");

      await this.emit("chargeback.escalation.required", {
        escalation_target: "jocelyn",
        reason: `Ambiguous reservation match (${payload?.confidence}% confidence)`,
        case_id: payload?.case_id,
        original_payload: payload,
      }, { correlation_id: cid });

      await this.audit({
        action: "orchestrator.escalated",
        entity_type: "chargeback_case",
        entity_id: payload?.case_id as string ?? "unknown",
        correlation_id: cid,
        severity: "warn",
        reason: `Ambiguous match escalated to Jocelyn — confidence ${payload?.confidence}%`,
      });
    });

    // 5. Human confirmed a probable/ambiguous match — proceed to dossier
    this.sub("chargeback.match.confirmed", async (ev) => {
      const cid = ev.correlation_id ?? ev.event_id;
      this.log.info({ cid }, "match confirmed by human — dispatching dossier-builder");

      await this.dispatch("dossier-builder", "chargeback.dossier.build", ev.payload, cid);
    });

    // 6. Dossier ready — dispatch narrative drafter
    this.sub("chargeback.dossier.ready", async (ev) => {
      const cid = ev.correlation_id ?? ev.event_id;
      this.log.info({ cid }, "dossier ready — dispatching narrative-drafter");

      await this.dispatch("narrative-drafter", "chargeback.narrative.draft", ev.payload, cid);
    });

    // 7. Dossier blocked — escalate to case-tracker + Audrey
    this.sub("chargeback.dossier.blocked", async (ev) => {
      const cid = ev.correlation_id ?? ev.event_id;
      const payload = ev.payload as Record<string, unknown>;

      this.log.warn({ cid, reason: payload?.block_reason }, "dossier blocked — escalating");

      await this.dispatch("case-tracker", "chargeback.case.blocked", ev.payload, cid);

      await this.emit("chargeback.escalation.required", {
        escalation_target: "audrey",
        reason: `Dossier blocked: ${payload?.block_reason}`,
        case_id: payload?.case_id,
        original_payload: payload,
      }, { correlation_id: cid });

      await this.audit({
        action: "orchestrator.dossier_blocked",
        entity_type: "chargeback_case",
        entity_id: payload?.case_id as string ?? "unknown",
        correlation_id: cid,
        severity: "warn",
        reason: `Dossier blocked — escalated to case-tracker and Audrey`,
      });
    });

    // 8. Narrative ready — ALWAYS hold for human review. Route by dollar amount.
    this.sub("chargeback.narrative.ready", async (ev) => {
      const cid = ev.correlation_id ?? ev.event_id;
      const payload = ev.payload as Record<string, unknown>;
      const amount = (payload?.amount as number) ?? 0;
      const caseId = payload?.case_id as string ?? "unknown";

      const approver = this.resolveNarrativeApprover(amount);
      this.log.info({ cid, amount, approver }, "narrative ready — requesting human review (never auto-submits)");

      await this.requestApproval({
        action: "narrative.review",
        entity_type: "chargeback_case",
        entity_id: caseId,
        summary: `Chargeback response ready for review ($${amount.toLocaleString()})`,
        detail: {
          ...payload as Record<string, unknown>,
          approval_tier: approver,
          reminder: "This response must be reviewed and submitted by a human. Auto-submission is never permitted.",
        },
        suggested_action: "Review the drafted narrative, edit if needed, then submit to the processor",
        risk_level: amount >= THRESHOLD_COO ? "critical" : amount >= THRESHOLD_JOCELYN ? "error" : "warn",
        required_approver_role: approver,
        correlation_id: cid,
        dollar_impact: amount,
        expires_at: new Date(Date.now() + 48 * 60 * 60 * 1_000), // 48h — tight deadline
      });
    });

    // 9. Case decided (won/lost) — dispatch outcome analyst
    this.sub("chargeback.case.decided", async (ev) => {
      const cid = ev.correlation_id ?? ev.event_id;
      const payload = ev.payload as Record<string, unknown>;
      this.log.info({ cid, outcome: payload?.decision }, "case decided — dispatching outcome-analyst");

      await this.dispatch("outcome-analyst", "chargeback.outcome.analyze", ev.payload, cid);
    });

    // 10. Postmortem complete — log to case-tracker
    this.sub("chargeback.postmortem.complete", async (ev) => {
      const cid = ev.correlation_id ?? ev.event_id;
      this.log.info({ cid }, "postmortem complete — logging to case-tracker");

      await this.dispatch("case-tracker", "chargeback.case.postmortem", ev.payload, cid);
    });
  }

  // -------------------------------------------------------------------------
  // Scheduled workflows
  // -------------------------------------------------------------------------

  private startScheduledWorkflows(): void {
    // Every 15 minutes: safety-net Gmail poll
    this.inboxPollTimer = setInterval(() => {
      void this.dispatchInboxPoll();
    }, INBOX_POLL_MS);

    // Check every minute for daily digest (7 AM PT) and monthly report
    this.dailyCheckTimer = setInterval(() => {
      void this.checkScheduledTasks();
    }, DAILY_DIGEST_CHECK_MS);

    // SLA monitoring: check every 30 seconds
    this.slaCheckTimer = setInterval(() => {
      void this.checkSLAs();
    }, 30_000);

    // Fire an initial inbox poll on start
    void this.dispatchInboxPoll();
  }

  private async dispatchInboxPoll(): Promise<void> {
    try {
      await this.dispatch("inbox-monitor", "chargeback.inbox.poll", {
        trigger: "scheduled",
        ts: new Date().toISOString(),
      });
      this.log.debug("inbox poll dispatched (15-min safety net)");
    } catch (err) {
      this.log.error({ err }, "inbox poll dispatch failed");
    }
  }

  private async checkScheduledTasks(): Promise<void> {
    const now = new Date();
    // Convert to PT (UTC-7 or UTC-8 depending on DST — use Intl for accuracy)
    const ptTime = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const dateKey = ptTime.toISOString().slice(0, 10);
    const monthKey = ptTime.toISOString().slice(0, 7);

    // Daily digest at 7 AM PT
    if (ptTime.getHours() === DAILY_DIGEST_HOUR && this.lastDailyDigest !== dateKey) {
      this.lastDailyDigest = dateKey;
      this.log.info("7 AM PT — dispatching daily digest + SLA sweep");

      await this.dispatch("case-tracker", "chargeback.digest.daily", {
        trigger: "scheduled",
        date: dateKey,
      });
    }

    // Monthly report on 1st business day
    if (ptTime.getDate() === MONTHLY_REPORT_DAY && this.isBusinessDay(ptTime) && this.lastMonthlyReport !== monthKey) {
      this.lastMonthlyReport = monthKey;
      this.log.info("1st business day — dispatching monthly outcome report");

      await this.dispatch("outcome-analyst", "chargeback.report.monthly", {
        trigger: "scheduled",
        month: monthKey,
      });
    }
  }

  // -------------------------------------------------------------------------
  // SLA monitoring
  // -------------------------------------------------------------------------

  private async checkSLAs(): Promise<void> {
    const now = Date.now();

    for (const [key, pending] of this.pendingDispatches) {
      const limitSeconds = SLA_LIMITS[pending.agent] ?? 300;
      const elapsed = (now - pending.dispatchedAt) / 1_000;

      if (elapsed > limitSeconds) {
        this.log.warn(
          { agent: pending.agent, elapsed, limit: limitSeconds, cid: pending.correlationId },
          "SLA warning — sub-agent exceeded expected completion time",
        );

        await this.emit("chargeback.sla.warning", {
          agent: pending.agent,
          elapsed_seconds: Math.round(elapsed),
          limit_seconds: limitSeconds,
          correlation_id: pending.correlationId,
          original_event: pending.eventType,
        }, { correlation_id: pending.correlationId });

        // Remove so we don't re-alert every 30s
        this.pendingDispatches.delete(key);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Subscribe to a chargeback event and track the unsubscriber. */
  private sub(eventType: string, handler: (ev: {
    event_id: string;
    event_type: string;
    correlation_id: string | null;
    payload: unknown;
  }) => Promise<void>): void {
    const unsub = this.on({ event_type: eventType }, handler);
    this.unsubscribers.push(unsub);
  }

  /** Dispatch a sub-agent by emitting a targeted event. Tracks for SLA. */
  private async dispatch(
    agent: string,
    eventType: string,
    payload: unknown,
    correlationId?: string,
  ): Promise<string> {
    const eventId = await this.emit(eventType, payload, {
      correlation_id: correlationId,
      metadata: { dispatched_by: this.identity.slug, target_agent: agent },
    });

    // Track for SLA monitoring
    this.pendingDispatches.set(eventId, {
      agent,
      dispatchedAt: Date.now(),
      correlationId: correlationId ?? eventId,
      eventType,
    });

    return eventId;
  }

  /** Route narrative approval to the right person based on dollar amount. */
  private resolveNarrativeApprover(amount: number): string {
    if (amount > THRESHOLD_COO) return "coo";          // Jason >$10,000
    if (amount >= THRESHOLD_JOCELYN) return "director"; // Jocelyn $2,500-$10,000
    return "chargeback_specialist";                     // Audrey <$2,500
  }

  /** Naive business-day check (Mon-Fri). */
  private isBusinessDay(date: Date): boolean {
    const day = date.getDay();
    return day >= 1 && day <= 5;
  }
}

export default new ChargebackOrchestrator();
