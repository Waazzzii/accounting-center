/**
 * kpi-computer — reactive and scheduled KPI computation engine.
 *
 * Listens for accounting events that affect KPI values (journal entries posted,
 * reconciliations completed, chargebacks recomputed, etc.), determines which
 * KPI definitions are affected, executes the SQL formula for each, writes an
 * immutable snapshot row to `kpi_snapshots`, and emits `kpi.snapshot.written`.
 *
 * Also runs periodic recomputes on each KPI's declared cadence (hourly, daily,
 * etc.) with jitter to avoid thundering-herd on the database.
 */

import {
  AgentBase,
  type AgentIdentity,
  serviceClient,
  kpiCatalog,
  type KpiDefinition,
  thresholds,
} from "@shared/index.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const IDENTITY: AgentIdentity = {
  product: "center",
  slug: "kpi-computer",
  display_name: "KPI Computer",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Event types that trigger recomputes — mapped to source product.
// ---------------------------------------------------------------------------

const TRIGGER_EVENTS = [
  "kpi.recompute.requested",
  "revpost.je.posted",
  "trustsync.reconciliation.completed",
  "otaauditor.reconciliation.finalized",
  "chargeback.reserve.recomputed",
  "utility.credit.applied",
  "close.cycle.completed",
] as const;

/** Derive the source product from an event type prefix (e.g. "revpost.je.posted" -> "revpost"). */
function sourceProductFromEvent(eventType: string): string {
  const dot = eventType.indexOf(".");
  return dot > 0 ? eventType.slice(0, dot) : eventType;
}

// ---------------------------------------------------------------------------
// Cadence helpers
// ---------------------------------------------------------------------------

const CADENCE_MS: Record<string, number> = {
  hourly: 60 * 60 * 1_000,
  daily: 24 * 60 * 60 * 1_000,
  weekly: 7 * 24 * 60 * 60 * 1_000,
  monthly: 30 * 24 * 60 * 60 * 1_000,
};

function cadenceToMs(cadence: string): number | null {
  return CADENCE_MS[cadence.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class KpiComputer extends AgentBase {
  private definitions: KpiDefinition[] = [];
  private unsubscribers: (() => void)[] = [];
  private cadenceTimers: ReturnType<typeof setInterval>[] = [];

  constructor() {
    super(IDENTITY);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    // 1. Load KPI definitions from YAML config.
    const catalog = kpiCatalog();
    this.definitions = catalog.kpis;
    this.log.info({ count: this.definitions.length }, "kpi definitions loaded");

    // 2. Subscribe to triggering events.
    const unsub = this.on(
      { event_type: [...TRIGGER_EVENTS] },
      async (ev) => {
        await this.handleTrigger(ev.event_type, ev.event_id, ev.correlation_id);
      },
    );
    this.unsubscribers.push(unsub);

    // 3. Schedule periodic cadence-based recomputes.
    this.scheduleCadences();

    this.log.info("kpi-computer online — listening for triggers and cadences");
  }

  protected async onStop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];

    for (const timer of this.cadenceTimers) clearInterval(timer);
    this.cadenceTimers = [];

    this.log.info("kpi-computer stopped");
  }

  // -------------------------------------------------------------------------
  // Event-driven recompute
  // -------------------------------------------------------------------------

  private async handleTrigger(
    eventType: string,
    eventId: string,
    correlationId: string | null,
  ): Promise<void> {
    const sourceProduct = sourceProductFromEvent(eventType);

    // "kpi.recompute.requested" is a wildcard — recompute all KPIs.
    const affected =
      eventType === "kpi.recompute.requested"
        ? this.definitions
        : this.definitions.filter((d) => d.product === sourceProduct);

    if (affected.length === 0) {
      this.log.debug({ eventType, sourceProduct }, "no kpis affected by event");
      return;
    }

    this.log.info(
      { eventType, sourceProduct, kpiCount: affected.length },
      "recomputing affected kpis",
    );

    const results = await Promise.allSettled(
      affected.map((kpi) => this.computeAndSnapshot(kpi, eventId, correlationId)),
    );

    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      this.log.warn({ eventType, total: affected.length, failed }, "some kpi recomputes failed");
    }
  }

  // -------------------------------------------------------------------------
  // Cadence scheduling
  // -------------------------------------------------------------------------

  private scheduleCadences(): void {
    const jitterSeconds = (thresholds().kpi as Record<string, number>).recompute_jitter_seconds ?? 30;

    // Group definitions by cadence.
    const byCadence = new Map<string, KpiDefinition[]>();
    for (const kpi of this.definitions) {
      const group = byCadence.get(kpi.cadence) ?? [];
      group.push(kpi);
      byCadence.set(kpi.cadence, group);
    }

    for (const [cadence, kpis] of byCadence) {
      const intervalMs = cadenceToMs(cadence);
      if (!intervalMs) {
        this.log.warn({ cadence }, "unknown cadence — skipping scheduled recomputes");
        continue;
      }

      // Add jitter per-cadence group so they don't all fire at once.
      const jitterMs = Math.floor(Math.random() * jitterSeconds * 1_000);

      const timer = setInterval(async () => {
        this.log.info({ cadence, kpiCount: kpis.length }, "cadence tick — recomputing");
        const results = await Promise.allSettled(
          kpis.map((kpi) => this.computeAndSnapshot(kpi, null, null)),
        );
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          this.log.warn({ cadence, total: kpis.length, failed }, "cadence recompute partial failure");
        }
      }, intervalMs + jitterMs);

      this.cadenceTimers.push(timer);
      this.log.debug({ cadence, kpiCount: kpis.length, intervalMs, jitterMs }, "cadence scheduled");
    }
  }

  // -------------------------------------------------------------------------
  // Core: execute formula, write snapshot, emit event
  // -------------------------------------------------------------------------

  private async computeAndSnapshot(
    kpi: KpiDefinition,
    triggerEventId: string | null,
    correlationId: string | null,
  ): Promise<void> {
    const sb = serviceClient();
    const computedAt = new Date().toISOString();

    // Execute the formula SQL via RPC.
    let value: number;
    try {
      const { data, error } = await sb.rpc("exec_sql", { query: kpi.formula });

      if (error) {
        // RPC not set up yet — log warning and bail. This is expected during
        // early development before the exec_sql function is deployed.
        this.log.warn(
          { kpiId: kpi.id, error: error.message },
          "formula execution via rpc failed — exec_sql may not be deployed yet",
        );
        return;
      }

      // exec_sql returns an array of rows; we expect a single-row, single-column result.
      const rows = data as Record<string, unknown>[] | null;
      if (!rows || rows.length === 0) {
        this.log.warn({ kpiId: kpi.id }, "formula returned no rows");
        return;
      }

      const firstRow = rows[0];
      const rawValue = Object.values(firstRow)[0];
      value = Number(rawValue);

      if (Number.isNaN(value)) {
        this.log.error({ kpiId: kpi.id, rawValue }, "formula returned non-numeric value");
        return;
      }
    } catch (err) {
      this.log.error({ err, kpiId: kpi.id }, "formula execution threw");
      return;
    }

    // Write immutable snapshot.
    const snapshotRow = {
      kpi_definition_id: kpi.id,
      kpi_version: kpi.version,
      value,
      unit: kpi.unit,
      computed_at: computedAt,
      trigger_event_id: triggerEventId,
      formula_hash: simpleHash(kpi.formula),
      metadata: {
        cadence: kpi.cadence,
        product: kpi.product,
        tier: kpi.tier,
        target_direction: kpi.target_direction,
      },
    };

    const { error: insertError } = await sb.from("kpi_snapshots").insert(snapshotRow);

    if (insertError) {
      this.log.error({ err: insertError, kpiId: kpi.id }, "failed to write kpi snapshot");
      return;
    }

    // Emit event.
    await this.emit("kpi.snapshot.written", {
      kpi_definition_id: kpi.id,
      display_name: kpi.display_name,
      value,
      unit: kpi.unit,
      computed_at: computedAt,
      trigger_event_id: triggerEventId,
    }, {
      correlation_id: correlationId ?? triggerEventId ?? undefined,
      idempotency_key: `kpi-snap:${kpi.id}:${computedAt}`,
    });

    // Audit trail.
    await this.audit({
      action: "kpi.computed",
      entity_type: "kpi_snapshot",
      entity_id: kpi.id,
      event_id: triggerEventId ?? undefined,
      correlation_id: correlationId ?? undefined,
      severity: "info",
      after_state: { value, unit: kpi.unit, computed_at: computedAt },
      reason: triggerEventId ? `triggered by event ${triggerEventId}` : `cadence: ${kpi.cadence}`,
    });

    this.log.debug({ kpiId: kpi.id, value, unit: kpi.unit }, "kpi snapshot written");
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Fast non-crypto hash for formula fingerprinting. */
function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export default new KpiComputer();
