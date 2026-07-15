/**
 * approvals.ts — the single path agents use to request human sign-off.
 *
 * Every money-in-motion action (transfers, JE posting, large credits)
 * MUST go through here. The orchestrator will not dispatch the downstream
 * action until status flips to 'approved' or 'auto_approved'.
 */

import { serviceClient } from "./supabase.js";
import type { ApprovalRequest } from "./types.js";
import { publish } from "./bus.js";
import { record } from "./audit.js";
import { agentLogger } from "./logger.js";

const log = agentLogger("center", "approvals");

export interface ApprovalHandle {
  approval_id: string;
  status: "pending" | "auto_approved";
}

/**
 * Create a pending approval. Returns the approval_id; the downstream
 * action should reference this id and only execute after status flips.
 */
export async function request(req: ApprovalRequest): Promise<ApprovalHandle> {
  if (!req.suggested_action || req.suggested_action.trim() === "") {
    throw new Error(
      `Approval request missing suggested_action. All approvals must tell the reviewer what to do. Agent: ${req.requesting_agent}`,
    );
  }

  const sb = serviceClient();
  const { data, error } = await sb
    .from("approvals")
    .insert({
      requesting_agent: req.requesting_agent,
      product: req.product,
      action: req.action,
      entity_type: req.entity_type,
      entity_id: req.entity_id,
      summary: req.summary,
      detail: req.detail,
      suggested_action: req.suggested_action,
      risk_level: req.risk_level ?? "info",
      required_approver_role: req.required_approver_role,
      correlation_id: req.correlation_id ?? null,
      event_id: req.event_id ?? null,
      dollar_impact: req.dollar_impact ?? null,
      auto_approve_at: req.auto_approve_at?.toISOString() ?? null,
      expires_at: req.expires_at.toISOString(),
      region: req.region ?? "all",
    })
    .select("approval_id, status")
    .single();

  if (error) {
    log.error({ err: error, req }, "approval insert failed");
    throw new Error(`approval insert failed: ${error.message}`);
  }

  await record({
    actor_type: "ai_agent",
    actor_id: req.requesting_agent,
    product: req.product,
    action: "approval.requested",
    entity_type: "approval",
    entity_id: data.approval_id as string,
    correlation_id: req.correlation_id,
    event_id: req.event_id,
    severity: "info",
    reason: req.summary,
    evidence: { suggested_action: req.suggested_action, dollar_impact: req.dollar_impact },
    region: req.region,
  });

  await publish({
    event_type: "center.approval.requested",
    source_product: "center",
    source_agent: req.requesting_agent,
    correlation_id: req.correlation_id,
    idempotency_key: data.approval_id as string,
    payload: {
      approval_id: data.approval_id,
      summary: req.summary,
      suggested_action: req.suggested_action,
      risk_level: req.risk_level,
      required_approver_role: req.required_approver_role,
      dollar_impact: req.dollar_impact,
    },
    region: req.region,
  });

  return {
    approval_id: data.approval_id as string,
    status: data.status as "pending" | "auto_approved",
  };
}

/** Poll for a decision. Returns null if still pending and not expired. */
export async function checkDecision(
  approvalId: string,
): Promise<{ status: string; approver_id: string | null; decided_at: string | null } | null> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("approvals")
    .select("status, approver_id, decided_at")
    .eq("approval_id", approvalId)
    .single();
  if (error) throw new Error(`approval lookup failed: ${error.message}`);
  if (data.status === "pending") return null;
  return data as { status: string; approver_id: string | null; decided_at: string | null };
}
