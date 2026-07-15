/**
 * audit-log-reader — serves audit-log queries for other agents and the
 * dashboard, reconstructs historical entity state from the audit trail,
 * provides analytical aggregations, and runs a nightly hash-chain
 * verification to guarantee tamper-evidence.
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
  product: "center",
  slug: "audit-log-reader",
  display_name: "Audit Log Reader",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueryOpts {
  limit?: number;
  offset?: number;
  since?: string;   // ISO timestamp
  until?: string;   // ISO timestamp
  action?: string;
  severity?: string;
}

interface AnalyticsOpts {
  since: string;
  until: string;
  group_by: "actor_id" | "product" | "action" | "severity";
  filter_product?: string;
  filter_action?: string;
  limit?: number;
}

interface AuditRow {
  id: string;
  row_hash: string;
  prev_hash: string | null;
  created_at: string;
  entity_type: string;
  entity_id: string;
  action: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class AuditLogReader extends AgentBase {
  private chainCheckTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: (() => void)[] = [];

  constructor() {
    super(IDENTITY);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    // Subscribe to events that downstream agents may use to trigger queries.
    const unsub1 = this.on(
      { event_type: "health.state.changed" },
      () => { /* available for on-demand audit trail queries */ },
    );
    const unsub2 = this.on(
      { event_type: "center.approval.decided" },
      () => { /* available for on-demand audit trail queries */ },
    );
    this.unsubscribers.push(unsub1, unsub2);

    // Nightly chain verification — check every 60 s if it's 2 AM PT.
    this.chainCheckTimer = setInterval(
      () => void this.maybeRunChainVerification(),
      60_000,
    );

    this.log.info("audit-log-reader online");
  }

  protected async onStop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    if (this.chainCheckTimer) {
      clearInterval(this.chainCheckTimer);
      this.chainCheckTimer = null;
    }
    this.log.info("audit-log-reader stopped");
  }

  // -------------------------------------------------------------------------
  // 1. Direct query
  // -------------------------------------------------------------------------

  async queryByEntity(
    entity_type: string,
    entity_id: string,
    opts: QueryOpts = {},
  ): Promise<AuditRow[]> {
    const sb = serviceClient();
    let query = sb
      .from("audit_log")
      .select("*")
      .eq("entity_type", entity_type)
      .eq("entity_id", entity_id)
      .order("created_at", { ascending: false });

    if (opts.since) query = query.gte("created_at", opts.since);
    if (opts.until) query = query.lte("created_at", opts.until);
    if (opts.action) query = query.eq("action", opts.action);
    if (opts.severity) query = query.eq("severity", opts.severity);
    query = query.range(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 100) - 1);

    const { data, error } = await query;
    if (error) {
      this.log.error({ error: error.message, entity_type, entity_id }, "queryByEntity failed");
      return [];
    }
    return (data ?? []) as AuditRow[];
  }

  // -------------------------------------------------------------------------
  // 2. Reconstructive — replay diffs to rebuild entity state at a point in time
  // -------------------------------------------------------------------------

  async reconstructState(
    entity_type: string,
    entity_id: string,
    asOf?: string,
  ): Promise<Record<string, unknown> | null> {
    const sb = serviceClient();
    let query = sb
      .from("audit_log")
      .select("before_state, after_state, created_at")
      .eq("entity_type", entity_type)
      .eq("entity_id", entity_id)
      .order("created_at", { ascending: true });

    if (asOf) query = query.lte("created_at", asOf);

    const { data, error } = await query;
    if (error) {
      this.log.error({ error: error.message, entity_type, entity_id }, "reconstructState failed");
      return null;
    }

    const rows = (data ?? []) as Pick<AuditRow, "before_state" | "after_state" | "created_at">[];
    if (rows.length === 0) return null;

    // Start from the first before_state, then layer each after_state on top.
    let state: Record<string, unknown> = rows[0].before_state
      ? { ...rows[0].before_state }
      : {};

    for (const row of rows) {
      if (row.after_state) {
        state = { ...state, ...row.after_state };
      }
    }

    return state;
  }

  // -------------------------------------------------------------------------
  // 3. Analytical — aggregated counts grouped by a dimension
  // -------------------------------------------------------------------------

  async queryAnalytics(
    opts: AnalyticsOpts,
  ): Promise<{ key: string; count: number }[]> {
    const sb = serviceClient();
    const groupCol = opts.group_by;

    let query = sb
      .from("audit_log")
      .select(`${groupCol}, id`)
      .gte("created_at", opts.since)
      .lte("created_at", opts.until);

    if (opts.filter_product) query = query.eq("product", opts.filter_product);
    if (opts.filter_action) query = query.eq("action", opts.filter_action);

    const { data, error } = await query;
    if (error) {
      this.log.error({ error: error.message }, "queryAnalytics failed");
      return [];
    }

    // Client-side aggregation (Supabase JS doesn't support GROUP BY natively).
    const counts = new Map<string, number>();
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const key = String(row[groupCol] ?? "unknown");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const results = Array.from(counts.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);

    return results.slice(0, opts.limit ?? 50);
  }

  // -------------------------------------------------------------------------
  // Nightly chain verification
  // -------------------------------------------------------------------------

  private lastVerificationDate: string | null = null;

  private async maybeRunChainVerification(): Promise<void> {
    // Fire at 2 AM Pacific Time, once per calendar day.
    const now = new Date();
    const ptHour = this.localHour(now, "America/Los_Angeles");
    if (ptHour !== 2) return;

    const today = now.toISOString().slice(0, 10);
    if (this.lastVerificationDate === today) return;
    this.lastVerificationDate = today;

    await this.verifyChain();
  }

  private async verifyChain(): Promise<void> {
    const sb = serviceClient();
    const startedAt = new Date().toISOString();
    let chainValid = true;
    let rowsChecked = 0;
    let firstBreakId: string | null = null;

    // Walk the chain in ascending order, batching to avoid memory pressure.
    const BATCH = 1_000;
    let lastId: string | null = null;
    let lastBatchHash: string | null = null;

    outer:
    while (true) {
      let query = sb
        .from("audit_log")
        .select("id, row_hash, prev_hash")
        .order("id", { ascending: true })
        .limit(BATCH);

      if (lastId) query = query.gt("id", lastId);

      const { data, error } = await query;
      if (error) {
        this.log.error({ error: error.message }, "chain verification query failed");
        chainValid = false;
        break;
      }

      const rows = (data ?? []) as Pick<AuditRow, "id" | "row_hash" | "prev_hash">[];
      if (rows.length === 0) break;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        rowsChecked++;

        // For the very first row in the table, prev_hash may be null.
        if (lastId !== null || i > 0) {
          const expectedPrev = i > 0 ? rows[i - 1].row_hash : lastBatchHash;
          if (row.prev_hash !== expectedPrev) {
            chainValid = false;
            firstBreakId = row.id;
            break outer;
          }
        }
      }

      lastBatchHash = rows[rows.length - 1].row_hash;
      lastId = rows[rows.length - 1].id;

      // If we got fewer than BATCH rows, we've reached the end.
      if (rows.length < BATCH) break;
    }

    const completedAt = new Date().toISOString();

    // Write result to audit_chain_verification.
    await sb.from("audit_chain_verification").insert({
      started_at: startedAt,
      completed_at: completedAt,
      rows_checked: rowsChecked,
      chain_valid: chainValid,
      first_break_id: firstBreakId,
    });

    if (!chainValid) {
      this.log.error(
        { firstBreakId, rowsChecked },
        "AUDIT CHAIN BROKEN — integrity violation detected",
      );
      await this.emit(
        "center.alert.raised",
        {
          category: "audit_chain",
          severity: "critical",
          summary: `Audit log hash chain broken at row ${firstBreakId}`,
          entity_type: "audit_log",
          entity_id: firstBreakId ?? "unknown",
          rows_checked: rowsChecked,
        },
        { idempotency_key: `chain-verify:${completedAt}` },
      );
    } else {
      this.log.info({ rowsChecked }, "audit chain verification passed");
    }

    await this.audit({
      action: "audit.chain.verified",
      entity_type: "audit_chain_verification",
      entity_id: completedAt,
      severity: chainValid ? "info" : "critical",
      after_state: { chain_valid: chainValid, rows_checked: rowsChecked, first_break_id: firstBreakId },
      reason: chainValid ? "chain intact" : `chain broken at ${firstBreakId}`,
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private localHour(date: Date, tz: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: tz,
    }).formatToParts(date);
    const hourPart = parts.find((p) => p.type === "hour");
    return parseInt(hourPart?.value ?? "0", 10);
  }
}

export default new AuditLogReader();
