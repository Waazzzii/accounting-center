/**
 * agent-base.ts — the smallest useful base for every Accounting Center agent.
 *
 * All agents (TrustSync, OTAAuditor, RevPost, etc.) extend this. It wires
 * up logging, bus publish/subscribe, audit recording, approval requests,
 * and checks the kill-switch + product maturity before each run.
 */

import type { ProductCode, RegionCode } from "./types.js";
import { agentLogger, type Logger } from "./logger.js";
import { publish, subscribe, type SubscribeFilter, type EventHandler } from "./bus.js";
import { record } from "./audit.js";
import { request as requestApproval } from "./approvals.js";
import { serviceClient } from "./supabase.js";
import { env } from "./env.js";
import type { ApprovalRequest, AuditRecord, EventEnvelope } from "./types.js";

export interface AgentIdentity {
  product: ProductCode;
  slug: string;                 // e.g. 'transfer-initiator'
  display_name: string;
  version: string;
}

export abstract class AgentBase {
  readonly identity: AgentIdentity;
  readonly log: Logger;

  constructor(identity: AgentIdentity) {
    this.identity = identity;
    this.log = agentLogger(identity.product, identity.slug);
  }

  // ---------------------------------------------------------------------------
  // Safety checks — EVERY agent checks these before acting.
  // ---------------------------------------------------------------------------

  /** Returns true if the agent is allowed to act right now. */
  async isEnabled(): Promise<{ allowed: boolean; reason?: string; mode?: string }> {
    if (env.KILL_SWITCH_GLOBAL) {
      return { allowed: false, reason: "global kill switch is set" };
    }
    const sb = serviceClient();
    const { data } = await sb
      .from("orchestrator_flags")
      .select("flag_type, value")
      .eq("product", this.identity.product)
      .or(`agent.is.null,agent.eq.${this.identity.slug}`)
      .or("expires_at.is.null,expires_at.gt.now()");

    for (const row of data ?? []) {
      const value = row.value as Record<string, unknown>;
      if (row.flag_type === "pause" && value?.enabled === true) {
        return { allowed: false, reason: (value?.reason as string) ?? "paused" };
      }
      if (row.flag_type === "kill_switch" && value?.enabled === true) {
        return { allowed: false, reason: "kill_switch" };
      }
    }
    return { allowed: true, mode: env.MATURITY_DEFAULT };
  }

  // ---------------------------------------------------------------------------
  // Thin wrappers so agent code reads well.
  // ---------------------------------------------------------------------------

  protected async emit<P>(
    event_type: string,
    payload: P,
    opts: {
      correlation_id?: string;
      causation_id?: string;
      idempotency_key?: string;
      region?: RegionCode;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const env: EventEnvelope<P> = {
      event_type,
      source_product: this.identity.product,
      source_agent: this.identity.slug,
      payload,
      ...opts,
    };
    return publish(env);
  }

  protected on(filter: SubscribeFilter, handler: EventHandler): () => void {
    return subscribe(filter, handler);
  }

  protected async audit(
    entry: Omit<AuditRecord, "actor_type" | "actor_id" | "product">,
  ): Promise<bigint> {
    return record({
      ...entry,
      actor_type: "ai_agent",
      actor_id: this.identity.slug,
      actor_display: this.identity.display_name,
      product: this.identity.product,
    });
  }

  protected async requestApproval(
    req: Omit<ApprovalRequest, "requesting_agent" | "product">,
  ): Promise<string> {
    const handle = await requestApproval({
      ...req,
      requesting_agent: this.identity.slug,
      product: this.identity.product,
    });
    return handle.approval_id;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle — subclass decides structure.
  // ---------------------------------------------------------------------------

  /** Called once at boot. */
  async start(): Promise<void> {
    const check = await this.isEnabled();
    if (!check.allowed) {
      this.log.warn({ reason: check.reason }, "agent start blocked");
      return;
    }
    this.log.info({ version: this.identity.version, mode: check.mode }, "agent started");
    await this.onStart();
  }

  /** Called on graceful shutdown. */
  async stop(): Promise<void> {
    this.log.info("agent stopping");
    await this.onStop();
  }

  protected abstract onStart(): Promise<void>;
  protected abstract onStop(): Promise<void>;
}
