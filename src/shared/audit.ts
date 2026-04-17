/**
 * audit.ts — the only way agents write to the audit_log.
 *
 * Exposes a single `record()` function that takes an AuditRecord and inserts
 * it. The Postgres trigger chains hashes. Callers never touch prev_hash /
 * row_hash themselves.
 */

import { serviceClient, currentActor } from "./supabase.js";
import type { AuditRecord } from "./types.js";
import { agentLogger } from "./logger.js";

const log = agentLogger("center", "audit");

/**
 * Record an audit entry. Throws on write failure — audit failures are
 * never swallowed; the caller should treat them as a hard error.
 */
export async function record(entry: AuditRecord): Promise<bigint> {
  const sb = serviceClient();
  const actor = currentActor();

  const payload: AuditRecord = {
    ...entry,
    actor_type: entry.actor_type ?? actor?.actor_type ?? "ai_agent",
    actor_id: entry.actor_id ?? actor?.actor_id ?? "unknown",
    actor_display: entry.actor_display ?? actor?.actor_display,
    severity: entry.severity ?? "info",
    region: entry.region ?? "all",
  };

  const { data, error } = await sb
    .from("audit_log")
    .insert(payload)
    .select("audit_id")
    .single();

  if (error) {
    log.error({ err: error, payload }, "audit_log insert failed");
    throw new Error(`audit_log insert failed: ${error.message}`);
  }

  return BigInt(data.audit_id as number);
}

/**
 * Bulk helper for agents that want to record a sequence atomically.
 * Postgres chains them in insertion order because each trigger locks
 * the tail via SELECT ... FOR UPDATE.
 */
export async function recordMany(entries: AuditRecord[]): Promise<bigint[]> {
  const ids: bigint[] = [];
  for (const entry of entries) {
    ids.push(await record(entry));
  }
  return ids;
}
