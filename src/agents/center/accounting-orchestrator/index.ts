/**
 * accounting-orchestrator — central event dispatcher for the Accounting Center.
 *
 * Subscribes to ALL events on the bus. For each event it:
 *  1. Matches against routing rules (priority order, first match wins unless continue_on_match)
 *  2. Checks orchestrator_flags for pause / kill_switch before dispatching
 *  3. Deduplicates by idempotency_key
 *  4. Emits a routed event or logs the routing decision
 *  5. Writes every decision to orchestrator_routing_log
 *
 * Also emits a heartbeat tick on a configurable interval.
 */

import {
  AgentBase,
  type AgentIdentity,
  publish,
  subscribe,
  type EventHandler,
  env,
  serviceClient,
  routingRules,
  type RoutingRule,
} from "@shared/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RoutingOutcome = "dispatched" | "paused" | "kill_switch" | "deduped" | "no_match" | "disabled" | "error";

interface RoutingLogEntry {
  event_id: string;
  event_type: string;
  rule_id: string | null;
  target_product: string | null;
  target_agent: string | null;
  outcome: RoutingOutcome;
  reason: string | null;
  dispatched_event_id: string | null;
  correlation_id: string | null;
}

interface FlagRow {
  flag_type: string;
  product: string | null;
  agent: string | null;
  value: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const IDENTITY: AgentIdentity = {
  product: "center",
  slug: "accounting-orchestrator",
  display_name: "Accounting Orchestrator",
  version: "1.0.0",
};

class AccountingOrchestrator extends AgentBase {
  private rules: RoutingRule[] = [];
  private unsubscribe: (() => void) | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private dispatchedKeys = new Set<string>();

  constructor() {
    super(IDENTITY);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    this.loadRules();

    // Subscribe to ALL events (no filter = everything).
    this.unsubscribe = subscribe({}, this.handleEvent);

    // Start the heartbeat tick.
    const tickMs = env.ORCHESTRATOR_TICK_SECONDS * 1_000;
    this.tickInterval = setInterval(() => void this.tick(), tickMs);

    this.log.info(
      { ruleCount: this.rules.length, tickSeconds: env.ORCHESTRATOR_TICK_SECONDS },
      "orchestrator online — listening for events",
    );
  }

  protected async onStop(): Promise<void> {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.dispatchedKeys.clear();
    this.log.info("orchestrator stopped");
  }

  // -------------------------------------------------------------------------
  // Rule loading
  // -------------------------------------------------------------------------

  private loadRules(): void {
    const config = routingRules();
    this.rules = [...config.rules]
      .filter((r) => r.enabled !== false)
      .sort((a, b) => a.priority - b.priority);

    this.log.debug({ count: this.rules.length }, "routing rules loaded");
  }

  // -------------------------------------------------------------------------
  // Core routing
  // -------------------------------------------------------------------------

  private handleEvent: EventHandler = async (ev) => {
    // Never route our own tick events to avoid infinite loops.
    if (ev.event_type === "center.orchestrator.tick") return;

    const matched = this.findMatchingRules(ev.event_type);

    if (matched.length === 0) {
      await this.writeLog({
        event_id: ev.event_id,
        event_type: ev.event_type,
        rule_id: null,
        target_product: null,
        target_agent: null,
        outcome: "no_match",
        reason: "no routing rule matched",
        dispatched_event_id: null,
        correlation_id: ev.correlation_id,
      });
      return;
    }

    for (const rule of matched) {
      await this.dispatchRule(rule, ev);
    }
  };

  /**
   * Find all rules that match the event_type. First-match wins, unless a
   * matching rule has continue_on_match: true — then we keep looking.
   */
  private findMatchingRules(eventType: string): RoutingRule[] {
    const hits: RoutingRule[] = [];

    for (const rule of this.rules) {
      if (!this.matchesEventType(rule.match_event_type, eventType)) continue;

      hits.push(rule);

      if (!rule.continue_on_match) break;
    }

    return hits;
  }

  private matchesEventType(pattern: string | undefined, eventType: string): boolean {
    if (!pattern) return false;
    if (pattern.endsWith("*")) {
      return eventType.startsWith(pattern.slice(0, -1));
    }
    return pattern === eventType;
  }

  // -------------------------------------------------------------------------
  // Dispatch a single matched rule
  // -------------------------------------------------------------------------

  private async dispatchRule(
    rule: RoutingRule,
    ev: { event_id: string; event_type: string; source_product: string; source_agent: string; correlation_id: string | null; payload: unknown },
  ): Promise<void> {
    const idempotencyKey = `orch:${ev.event_id}:${rule.rule_id}`;

    // Dedup check — fast in-memory guard before hitting Supabase.
    if (this.dispatchedKeys.has(idempotencyKey)) {
      await this.writeLog({
        event_id: ev.event_id,
        event_type: ev.event_type,
        rule_id: rule.rule_id,
        target_product: rule.target_product,
        target_agent: rule.target_agent,
        outcome: "deduped",
        reason: "already dispatched (in-memory)",
        dispatched_event_id: null,
        correlation_id: ev.correlation_id,
      });
      return;
    }

    // Check orchestrator_flags for pause/kill_switch on target.
    const flagCheck = await this.checkFlags(rule.target_product, rule.target_agent);
    if (!flagCheck.allowed) {
      await this.writeLog({
        event_id: ev.event_id,
        event_type: ev.event_type,
        rule_id: rule.rule_id,
        target_product: rule.target_product,
        target_agent: rule.target_agent,
        outcome: flagCheck.outcome,
        reason: flagCheck.reason,
        dispatched_event_id: null,
        correlation_id: ev.correlation_id,
      });
      return;
    }

    // Dispatch: emit a new event targeting the agent.
    try {
      const dispatchedType = `${rule.target_product}.${rule.target_agent}.dispatch`;
      const dispatchedEventId = await publish({
        event_type: dispatchedType,
        source_product: "center",
        source_agent: this.identity.slug,
        correlation_id: ev.correlation_id ?? ev.event_id,
        causation_id: ev.event_id,
        idempotency_key: idempotencyKey,
        payload: {
          rule_id: rule.rule_id,
          original_event_type: ev.event_type,
          original_payload: ev.payload,
          target_agent: rule.target_agent,
          timeout_seconds: rule.timeout_seconds,
          max_retries: rule.max_retries,
          required_approvals: rule.required_approvals,
        },
      });

      this.dispatchedKeys.add(idempotencyKey);

      await this.writeLog({
        event_id: ev.event_id,
        event_type: ev.event_type,
        rule_id: rule.rule_id,
        target_product: rule.target_product,
        target_agent: rule.target_agent,
        outcome: "dispatched",
        reason: null,
        dispatched_event_id: dispatchedEventId,
        correlation_id: ev.correlation_id,
      });

      this.log.info(
        { rule: rule.rule_id, target: `${rule.target_product}.${rule.target_agent}`, eventId: ev.event_id },
        "event dispatched",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // If it was a dedup from the bus (idempotency_key collision), treat as dedup.
      if (message.includes("dedup")) {
        this.dispatchedKeys.add(idempotencyKey);
        await this.writeLog({
          event_id: ev.event_id,
          event_type: ev.event_type,
          rule_id: rule.rule_id,
          target_product: rule.target_product,
          target_agent: rule.target_agent,
          outcome: "deduped",
          reason: "idempotency_key collision in bus",
          dispatched_event_id: null,
          correlation_id: ev.correlation_id,
        });
        return;
      }

      this.log.error({ err, rule: rule.rule_id, eventId: ev.event_id }, "dispatch failed");

      await this.writeLog({
        event_id: ev.event_id,
        event_type: ev.event_type,
        rule_id: rule.rule_id,
        target_product: rule.target_product,
        target_agent: rule.target_agent,
        outcome: "error",
        reason: message,
        dispatched_event_id: null,
        correlation_id: ev.correlation_id,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Flag checks
  // -------------------------------------------------------------------------

  private async checkFlags(
    product: string,
    agent: string,
  ): Promise<{ allowed: boolean; outcome: RoutingOutcome; reason: string }> {
    try {
      const sb = serviceClient();
      const { data } = await sb
        .from("orchestrator_flags")
        .select("flag_type, product, agent, value")
        .or(`product.is.null,product.eq.${product}`)
        .or(`agent.is.null,agent.eq.${agent}`)
        .or("expires_at.is.null,expires_at.gt.now()");

      for (const row of (data ?? []) as FlagRow[]) {
        if (row.value?.enabled !== true) continue;

        if (row.flag_type === "kill_switch") {
          return { allowed: false, outcome: "kill_switch", reason: `kill_switch active for ${row.product ?? "all"}/${row.agent ?? "all"}` };
        }
        if (row.flag_type === "pause") {
          return { allowed: false, outcome: "paused", reason: (row.value?.reason as string) ?? "agent paused" };
        }
      }

      return { allowed: true, outcome: "dispatched", reason: "" };
    } catch (err) {
      this.log.error({ err, product, agent }, "flag check failed — allowing dispatch");
      return { allowed: true, outcome: "dispatched", reason: "" };
    }
  }

  // -------------------------------------------------------------------------
  // Routing log persistence
  // -------------------------------------------------------------------------

  private async writeLog(entry: RoutingLogEntry): Promise<void> {
    try {
      const sb = serviceClient();
      await sb.from("orchestrator_routing_log").insert({
        event_id: entry.event_id,
        event_type: entry.event_type,
        rule_id: entry.rule_id,
        target_product: entry.target_product,
        target_agent: entry.target_agent,
        outcome: entry.outcome,
        reason: entry.reason,
        dispatched_event_id: entry.dispatched_event_id,
        correlation_id: entry.correlation_id,
        routed_by: this.identity.slug,
      });
    } catch (err) {
      // Routing log failures are not fatal — log and continue.
      this.log.warn({ err, entry }, "failed to write orchestrator_routing_log");
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    try {
      await this.emit("center.orchestrator.tick", {
        ts: new Date().toISOString(),
        rules_loaded: this.rules.length,
        dispatched_keys_cached: this.dispatchedKeys.size,
      });
    } catch (err) {
      this.log.warn({ err }, "heartbeat tick failed");
    }
  }
}

export default new AccountingOrchestrator();
