/**
 * verify-audit-chain.ts — walks the audit_log hash chain and reports
 * the first integrity break if any. Intended to run nightly via pg_cron
 * or external scheduler.
 *
 * Writes result to audit_chain_verification.
 */

import { createHash } from "node:crypto";
import { serviceClient } from "@shared/supabase.js";
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "verify-audit-chain" });

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function canonical(row: Record<string, unknown>): string {
  return [
    (row.prev_hash as string) ?? "",
    row.occurred_at,
    row.actor_type,
    row.actor_id,
    row.product,
    row.action,
    row.entity_type,
    row.entity_id,
    (row.correlation_id as string) ?? "",
    row.severity,
    row.before_state ? JSON.stringify(row.before_state) : "",
    row.after_state ? JSON.stringify(row.after_state) : "",
    (row.reason as string) ?? "",
  ].join("|");
}

async function main() {
  const sb = serviceClient();
  const start = Date.now();

  const { data: rows, error } = await sb
    .from("audit_log")
    .select(
      "audit_id, occurred_at, actor_type, actor_id, product, action, entity_type, entity_id, correlation_id, severity, before_state, after_state, reason, prev_hash, row_hash",
    )
    .order("audit_id", { ascending: true });

  if (error) {
    log.fatal({ err: error }, "failed to load audit_log");
    process.exit(1);
  }

  let lastHash: string | null = null;
  let firstBreak: { audit_id: number; expected: string; actual: string } | null = null;

  for (const row of rows ?? []) {
    const r = row as Record<string, unknown>;
    // chain check
    if ((r.prev_hash as string | null) !== lastHash) {
      firstBreak = {
        audit_id: r.audit_id as number,
        expected: lastHash ?? "",
        actual: (r.prev_hash as string) ?? "",
      };
      break;
    }
    // hash check
    const expected = sha256(canonical(r));
    if (expected !== (r.row_hash as string)) {
      firstBreak = {
        audit_id: r.audit_id as number,
        expected,
        actual: r.row_hash as string,
      };
      break;
    }
    lastHash = r.row_hash as string;
  }

  const rowsChecked = rows?.length ?? 0;
  const duration = Date.now() - start;

  await sb.from("audit_chain_verification").insert({
    from_audit_id: rows?.[0]?.audit_id ?? 0,
    to_audit_id: rows?.[rowsChecked - 1]?.audit_id ?? 0,
    rows_checked: rowsChecked,
    chain_valid: firstBreak === null,
    first_break_at_id: firstBreak?.audit_id ?? null,
    expected_hash: firstBreak?.expected ?? null,
    actual_hash: firstBreak?.actual ?? null,
    duration_ms: duration,
    run_by: "verify-audit-chain script",
  });

  if (firstBreak) {
    log.fatal({ firstBreak, rowsChecked, duration }, "audit chain INVALID");
    process.exit(2);
  }
  log.info({ rowsChecked, duration }, "audit chain valid");
}

main().catch((err) => {
  log.fatal({ err }, "chain verification crashed");
  process.exit(1);
});
