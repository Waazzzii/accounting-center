/**
 * case-tracker — the state machine and SLA enforcer for every chargeback case.
 *
 * Subscribes to ALL chargeback events to maintain authoritative case state:
 *   chargeback.case.notified      -> status = 'notified', create Asana task
 *   chargeback.match.auto         -> status = 'under_review'
 *   chargeback.match.probable     -> status = 'under_review', flag for human
 *   chargeback.match.ambiguous    -> status = 'under_review', flag for human
 *   chargeback.match.confirmed    -> status = 'evidence_collecting'
 *   chargeback.dossier.ready      -> status = 'evidence_submitted'
 *   chargeback.narrative.ready    -> status = 'awaiting_decision'
 *   chargeback.case.decided       -> status = won/lost/accepted
 *
 * Emits:
 *   chargeback.sla.warning        -> deadline approaching (50% / 75% / 90%)
 *   chargeback.digest.summary     -> daily digest for Slack / dashboard
 *   chargeback.state.changed      -> on every state transition
 *
 * The case store is the system of record, not Asana. Asana is a projection.
 * Target: zero missed deadlines.
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
  slug: "case-tracker",
  display_name: "Chargeback Case Tracker",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CaseStage =
  | "notified"
  | "under_review"
  | "evidence_collecting"
  | "evidence_submitted"
  | "awaiting_decision"
  | "won"
  | "lost"
  | "accepted"
  | "reversed";

interface CaseRecord {
  case_id: string;
  external_case_id: string;
  source: string;
  stage: CaseStage;
  amount: number;
  currency: string;
  guest_name: string;
  evidence_due_at: string | null;
  updated_at: string;
}

interface StateTransition {
  case_id: string;
  from_stage: CaseStage | null;
  to_stage: CaseStage;
  triggered_by: string;
  at: string;
}

type SlaLevel = "warning" | "critical" | "escalation";

// ---------------------------------------------------------------------------
// Valid state transitions — the state machine definition
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<CaseStage, CaseStage[]> = {
  notified:            ["under_review", "accepted"],
  under_review:        ["evidence_collecting", "accepted"],
  evidence_collecting: ["evidence_submitted", "under_review", "accepted"],
  evidence_submitted:  ["awaiting_decision", "evidence_collecting"],
  awaiting_decision:   ["won", "lost", "accepted", "reversed"],
  won:                 [],
  lost:                [],
  accepted:            [],
  reversed:            [],
};

const TERMINAL_STAGES = new Set<CaseStage>(["won", "lost", "accepted", "reversed"]);

// ---------------------------------------------------------------------------
// SLA configuration
// ---------------------------------------------------------------------------

/** Stage-level SLA in business hours. Used for stall detection. */
const STAGE_SLA_HOURS: Partial<Record<CaseStage, number>> = {
  notified: 6,
  under_review: 48,
  evidence_collecting: 120,
  evidence_submitted: 8,
  awaiting_decision: 24,
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class CaseTracker extends AgentBase {
  private unsubscribers: Array<() => void> = [];

  constructor() {
    super(IDENTITY);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    // 1. New case from inbox-monitor
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.case.notified" }, async (ev) => {
        await this.handleCaseNotified(ev);
      }),
    );

    // 2. Auto match — high confidence, proceed to under_review
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.match.auto" }, async (ev) => {
        await this.handleMatchEvent(ev, "under_review", false);
      }),
    );

    // 3. Probable match — needs human confirmation
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.match.probable" }, async (ev) => {
        await this.handleMatchEvent(ev, "under_review", true);
      }),
    );

    // 4. Ambiguous match — needs human escalation
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.match.ambiguous" }, async (ev) => {
        await this.handleMatchEvent(ev, "under_review", true);
      }),
    );

    // 5. Human confirmed match — proceed to evidence collecting
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.match.confirmed" }, async (ev) => {
        await this.handleStageAdvance(ev, "evidence_collecting");
      }),
    );

    // 6. Dossier ready — evidence submitted internally
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.dossier.ready" }, async (ev) => {
        await this.handleStageAdvance(ev, "evidence_submitted");
      }),
    );

    // 7. Narrative ready — awaiting human decision to submit
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.narrative.ready" }, async (ev) => {
        await this.handleStageAdvance(ev, "awaiting_decision");
      }),
    );

    // 8. Final decision from processor
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.case.decided" }, async (ev) => {
        await this.handleCaseDecided(ev);
      }),
    );

    // 9. Daily digest request from orchestrator
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.digest.requested" }, async (ev) => {
        await this.handleDigestRequest(ev);
      }),
    );

    this.log.info("case tracker online — listening for all chargeback events");
  }

  protected async onStop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.log.info("case tracker stopped");
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private async handleCaseNotified(ev: {
    event_id: string;
    correlation_id: string | null;
    payload: unknown;
  }): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    const payload = ev.payload as { case_id: string; amount?: number; guest_name?: string; processor_deadline?: string };
    const caseId = payload.case_id;

    this.log.info({ cid, caseId }, "new case notified — setting stage to notified");

    // Ensure stage is notified (inbox-monitor may have already set it)
    await this.transitionStage(caseId, "notified", "notified", "inbox-monitor", cid);

    // Create Asana task (Phase 1: log the intent)
    await this.logAsanaIntent(caseId, "create_task", {
      title: `Chargeback — ${payload.guest_name ?? "Unknown"} — $${payload.amount ?? 0}`,
      due_date: payload.processor_deadline,
      status: "Intake",
    });

    // Check SLA on initial creation
    await this.checkSla(caseId, cid);
  }

  private async handleMatchEvent(
    ev: { event_id: string; correlation_id: string | null; payload: unknown },
    targetStage: CaseStage,
    needsHumanFlag: boolean,
  ): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    const payload = ev.payload as { case_id: string; confidence?: number };
    const caseId = payload.case_id;

    this.log.info({ cid, caseId, needsHumanFlag, confidence: payload.confidence }, "match event received");

    await this.transitionStage(caseId, targetStage, targetStage, "reservation-matcher", cid);

    if (needsHumanFlag) {
      await this.logAsanaIntent(caseId, "update_task", {
        status: "Needs Match Confirmation",
        flag: "human_review_required",
        confidence: payload.confidence,
      });
    } else {
      await this.logAsanaIntent(caseId, "update_task", { status: "Under Review" });
    }

    await this.checkSla(caseId, cid);
  }

  private async handleStageAdvance(
    ev: { event_id: string; correlation_id: string | null; payload: unknown },
    targetStage: CaseStage,
  ): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    const payload = ev.payload as { case_id: string };
    const caseId = payload.case_id;

    this.log.info({ cid, caseId, targetStage }, "advancing case stage");

    await this.transitionStage(caseId, targetStage, targetStage, ev.event_id, cid);

    const stageLabel = targetStage.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    await this.logAsanaIntent(caseId, "update_task", { status: stageLabel });

    await this.checkSla(caseId, cid);
  }

  private async handleCaseDecided(ev: {
    event_id: string;
    correlation_id: string | null;
    payload: unknown;
  }): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    const payload = ev.payload as { case_id: string; decision: string };
    const caseId = payload.case_id;
    const decision = payload.decision as CaseStage;

    // Map decision string to valid terminal stage
    const terminalStage: CaseStage =
      decision === "won" ? "won"
      : decision === "lost" ? "lost"
      : decision === "reversed" ? "reversed"
      : "accepted";

    this.log.info({ cid, caseId, decision: terminalStage }, "case decided");

    await this.transitionStage(caseId, terminalStage, terminalStage, "processor", cid);

    await this.logAsanaIntent(caseId, "update_task", {
      status: terminalStage.charAt(0).toUpperCase() + terminalStage.slice(1),
      completed: true,
    });
  }

  // -------------------------------------------------------------------------
  // State transition engine
  // -------------------------------------------------------------------------

  private async transitionStage(
    caseId: string,
    targetStage: CaseStage,
    _label: string,
    triggeredBy: string,
    correlationId: string,
  ): Promise<boolean> {
    const sb = serviceClient();

    // Load current stage
    const { data: current, error: loadErr } = await sb
      .from("chargeback_cases")
      .select("case_id, stage, external_case_id, amount, evidence_due_at")
      .eq("case_id", caseId)
      .single();

    if (loadErr || !current) {
      this.log.error({ loadErr, caseId }, "cannot load case for state transition");
      return false;
    }

    const fromStage = current.stage as CaseStage;

    // Validate transition
    if (fromStage === targetStage) {
      this.log.debug({ caseId, stage: fromStage }, "already in target stage — idempotent skip");
      return true;
    }

    const allowed = VALID_TRANSITIONS[fromStage];
    if (!allowed || !allowed.includes(targetStage)) {
      this.log.error(
        { caseId, fromStage, targetStage },
        "invalid state transition rejected",
      );
      await this.audit({
        action: "state_transition.rejected",
        entity_type: "chargeback_case",
        entity_id: caseId,
        correlation_id: correlationId,
        severity: "error",
        before_state: { stage: fromStage },
        after_state: { attempted_stage: targetStage },
        reason: `Invalid transition: ${fromStage} -> ${targetStage}`,
      });
      return false;
    }

    // Perform the update
    const { error: updateErr } = await sb
      .from("chargeback_cases")
      .update({ stage: targetStage })
      .eq("case_id", caseId);

    if (updateErr) {
      this.log.error({ updateErr, caseId }, "failed to update case stage");
      return false;
    }

    // Audit the transition
    const transition: StateTransition = {
      case_id: caseId,
      from_stage: fromStage,
      to_stage: targetStage,
      triggered_by: triggeredBy,
      at: new Date().toISOString(),
    };

    await this.audit({
      action: "state_transition",
      entity_type: "chargeback_case",
      entity_id: caseId,
      correlation_id: correlationId,
      before_state: { stage: fromStage },
      after_state: { stage: targetStage },
      reason: `${fromStage} -> ${targetStage} (triggered by ${triggeredBy})`,
    });

    // Emit state change event
    await this.emit("chargeback.state.changed", transition, { correlation_id: correlationId });

    this.log.info({ caseId, fromStage, targetStage, triggeredBy }, "state transition complete");
    return true;
  }

  // -------------------------------------------------------------------------
  // SLA monitoring
  // -------------------------------------------------------------------------

  /**
   * Check if a case is on track for its processor deadline minus 2 business
   * days. Fires warnings at 50%, 75%, and 90% of remaining time consumed.
   */
  private async checkSla(caseId: string, correlationId: string): Promise<void> {
    const sb = serviceClient();

    const { data, error } = await sb
      .from("chargeback_cases")
      .select("case_id, external_case_id, stage, evidence_due_at, amount, updated_at")
      .eq("case_id", caseId)
      .single();

    if (error || !data) return;

    const stage = data.stage as CaseStage;
    if (TERMINAL_STAGES.has(stage)) return;
    if (!data.evidence_due_at) return;

    const now = new Date();
    const deadline = new Date(data.evidence_due_at);
    // Internal deadline: processor deadline minus 2 business days
    const internalDeadline = this.subtractBusinessDays(deadline, 2);
    const totalMs = internalDeadline.getTime() - new Date(data.updated_at).getTime();
    const elapsedMs = now.getTime() - new Date(data.updated_at).getTime();

    if (totalMs <= 0) return;

    const pctConsumed = elapsedMs / totalMs;

    let level: SlaLevel | null = null;
    if (pctConsumed >= 0.9) {
      level = "escalation";
    } else if (pctConsumed >= 0.75) {
      level = "critical";
    } else if (pctConsumed >= 0.5) {
      level = "warning";
    }

    if (level) {
      const hoursRemaining = Math.max(0, (internalDeadline.getTime() - now.getTime()) / (1000 * 60 * 60));

      this.log.warn(
        { caseId, level, pctConsumed: Math.round(pctConsumed * 100), hoursRemaining: Math.round(hoursRemaining) },
        "SLA warning triggered",
      );

      await this.emit("chargeback.sla.warning", {
        case_id: caseId,
        external_case_id: data.external_case_id,
        level,
        pct_consumed: Math.round(pctConsumed * 100),
        hours_remaining: Math.round(hoursRemaining),
        stage,
        amount: data.amount,
        evidence_due_at: data.evidence_due_at,
        internal_deadline: internalDeadline.toISOString(),
      }, { correlation_id: correlationId });

      await this.audit({
        action: `sla.${level}`,
        entity_type: "chargeback_case",
        entity_id: caseId,
        correlation_id: correlationId,
        severity: level === "escalation" ? "critical" : level === "critical" ? "error" : "warn",
        reason: `SLA ${level}: ${Math.round(pctConsumed * 100)}% of time consumed, ${Math.round(hoursRemaining)}h remaining`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Daily digest
  // -------------------------------------------------------------------------

  private async handleDigestRequest(ev: {
    event_id: string;
    correlation_id: string | null;
    payload: unknown;
  }): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    this.log.info({ cid }, "daily digest requested");

    const sb = serviceClient();

    // Query all open cases grouped by stage
    const { data: openCases, error } = await sb
      .from("chargeback_cases")
      .select("case_id, external_case_id, source, stage, amount, currency, guest_name, evidence_due_at, updated_at")
      .not("stage", "in", "(won,lost,accepted,reversed)")
      .order("evidence_due_at", { ascending: true });

    if (error) {
      this.log.error({ error }, "failed to query open cases for digest");
      return;
    }

    const cases = openCases ?? [];

    // Group by stage
    const byStage: Record<string, typeof cases> = {};
    for (const c of cases) {
      const stage = c.stage as string;
      if (!byStage[stage]) byStage[stage] = [];
      byStage[stage]!.push(c);
    }

    // Compute SLA status for each open case
    const now = new Date();
    const atRisk: Array<{ case_id: string; external_case_id: string; hours_remaining: number; stage: string; amount: number }> = [];

    for (const c of cases) {
      if (!c.evidence_due_at) continue;
      const deadline = new Date(c.evidence_due_at);
      const internalDeadline = this.subtractBusinessDays(deadline, 2);
      const hoursRemaining = (internalDeadline.getTime() - now.getTime()) / (1000 * 60 * 60);

      if (hoursRemaining < 48) {
        atRisk.push({
          case_id: c.case_id as string,
          external_case_id: c.external_case_id as string,
          hours_remaining: Math.round(hoursRemaining),
          stage: c.stage as string,
          amount: c.amount as number,
        });
      }
    }

    // Query recently decided cases (last 7 days) for win/loss stats
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentDecisions } = await sb
      .from("chargeback_cases")
      .select("case_id, stage, amount, decided_at")
      .in("stage", ["won", "lost", "accepted", "reversed"])
      .gte("decided_at", weekAgo);

    const decisions = recentDecisions ?? [];
    const wins = decisions.filter((d) => d.stage === "won").length;
    const losses = decisions.filter((d) => d.stage === "lost").length;
    const dollarsDefended = decisions
      .filter((d) => d.stage === "won")
      .reduce((sum, d) => sum + (d.amount as number ?? 0), 0);

    const summary = {
      digest_date: now.toISOString().slice(0, 10),
      open_cases_total: cases.length,
      by_stage: Object.fromEntries(
        Object.entries(byStage).map(([stage, items]) => [stage, items.length]),
      ),
      at_risk: atRisk,
      week_decisions: { wins, losses, dollars_defended: dollarsDefended },
    };

    await this.emit("chargeback.digest.summary", summary, { correlation_id: cid });

    await this.audit({
      action: "digest.generated",
      entity_type: "chargeback_digest",
      entity_id: summary.digest_date,
      correlation_id: cid,
      after_state: {
        open_cases: summary.open_cases_total,
        at_risk_count: atRisk.length,
      },
      reason: `Daily digest: ${cases.length} open, ${atRisk.length} at risk, ${wins}W/${losses}L this week`,
    });

    this.log.info(
      { openCases: cases.length, atRisk: atRisk.length, wins, losses },
      "daily digest emitted",
    );
  }

  // -------------------------------------------------------------------------
  // Asana intent logging (Phase 1: log only, actual MCP integration later)
  // -------------------------------------------------------------------------

  private async logAsanaIntent(
    caseId: string,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    this.log.info(
      { caseId, asanaAction: action, details },
      "Asana intent logged (Phase 1: MCP integration pending)",
    );

    const sb = serviceClient();
    await sb.from("chargeback_asana_intents").insert({
      case_id: caseId,
      action,
      details,
      status: "pending",
      created_at: new Date().toISOString(),
    }).then(({ error }) => {
      if (error) {
        // Table may not exist yet in Phase 1 — log but don't fail
        this.log.debug({ error }, "asana intent table write failed (expected in Phase 1)");
      }
    });
  }

  // -------------------------------------------------------------------------
  // Business-day arithmetic
  // -------------------------------------------------------------------------

  private subtractBusinessDays(from: Date, days: number): Date {
    const result = new Date(from);
    let remaining = days;

    while (remaining > 0) {
      result.setDate(result.getDate() - 1);
      const dow = result.getDay();
      if (dow !== 0 && dow !== 6) remaining--;
    }

    return result;
  }
}

export default new CaseTracker();
