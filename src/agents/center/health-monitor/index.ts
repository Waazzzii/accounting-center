/**
 * health-monitor — probes internal and external dependencies on a cadence,
 * applies hysteresis logic to derive state (green/yellow/red), persists
 * samples and state transitions, and computes a nightly rollup.
 *
 * Dependencies probed: column-bank, streamline, intacct, stripe, self.
 * Phase 1 probes are Supabase table-reachability checks (placeholder for
 * real API pings in later phases).
 */

import {
  AgentBase,
  type AgentIdentity,
  serviceClient,
  thresholds,
} from "@shared/index.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const IDENTITY: AgentIdentity = {
  product: "center",
  slug: "health-monitor",
  display_name: "Health Monitor",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HealthState = "green" | "yellow" | "red";

interface ProbeResult {
  dependency: string;
  ok: boolean;
  critical: boolean;
  latency_ms: number;
  detail: string | null;
}

interface HealthCurrentRow {
  dependency: string;
  state: HealthState;
  consecutive_good: number;
  consecutive_bad: number;
  last_probed_at: string;
}

// Subset of thresholds().health we care about.
interface HealthThresholds {
  hysteresis: {
    green_to_yellow_bad_samples: number;
    yellow_to_red_bad_samples: number;
    red_to_yellow_good_samples: number;
    yellow_to_green_good_samples: number;
    critical_sample_forces_red: boolean;
  };
  probe_cadence_seconds: Record<string, number>;
}

// Dependencies we probe and the Supabase table used as a reachability check.
const PROBE_TARGETS: Record<string, string> = {
  "column-bank": "column_bank_accounts",
  streamline: "streamline_reservations",
  intacct: "intacct_sync_log",
  stripe: "stripe_payouts",
  self: "events",
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class HealthMonitor extends AgentBase {
  private probeTimers: ReturnType<typeof setInterval>[] = [];
  private rollupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super(IDENTITY);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    const cfg = this.healthConfig();

    // Schedule a probe timer per dependency at its configured cadence.
    for (const [dep, cadenceSec] of Object.entries(cfg.probe_cadence_seconds)) {
      const timer = setInterval(
        () => void this.probeAndReconcile(dep),
        cadenceSec * 1_000,
      );
      this.probeTimers.push(timer);

      // Fire an initial probe immediately so we don't wait a full cadence.
      void this.probeAndReconcile(dep);
    }

    // Nightly rollup check every 60 s — fires the rollup once per calendar day.
    this.rollupTimer = setInterval(() => void this.maybeNightlyRollup(), 60_000);

    this.log.info(
      { dependencies: Object.keys(cfg.probe_cadence_seconds) },
      "health-monitor online — probing dependencies",
    );
  }

  protected async onStop(): Promise<void> {
    for (const t of this.probeTimers) clearInterval(t);
    this.probeTimers = [];
    if (this.rollupTimer) {
      clearInterval(this.rollupTimer);
      this.rollupTimer = null;
    }
    this.log.info("health-monitor stopped");
  }

  // -------------------------------------------------------------------------
  // Probe execution
  // -------------------------------------------------------------------------

  private async probe(dependency: string): Promise<ProbeResult> {
    const table = PROBE_TARGETS[dependency];
    if (!table) {
      return { dependency, ok: false, critical: false, latency_ms: 0, detail: "unknown dependency" };
    }

    const sb = serviceClient();
    const start = Date.now();

    try {
      if (dependency === "self") {
        // Self-check: are there events in the last 5 minutes?
        const cutoff = new Date(Date.now() - 5 * 60 * 1_000).toISOString();
        const { count, error } = await sb
          .from(table)
          .select("*", { count: "exact", head: true })
          .gte("created_at", cutoff);

        const latency = Date.now() - start;
        if (error) {
          return { dependency, ok: false, critical: false, latency_ms: latency, detail: error.message };
        }
        const ok = (count ?? 0) > 0;
        return { dependency, ok, critical: false, latency_ms: latency, detail: ok ? null : "no events in last 5 min" };
      }

      // External deps (Phase 1): just verify we can query the table.
      const { error } = await sb.from(table).select("*", { count: "exact", head: true }).limit(1);
      const latency = Date.now() - start;

      if (error) {
        return { dependency, ok: false, critical: false, latency_ms: latency, detail: error.message };
      }
      return { dependency, ok: true, critical: false, latency_ms: latency, detail: null };
    } catch (err) {
      const latency = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      return { dependency, ok: false, critical: true, latency_ms: latency, detail: msg };
    }
  }

  // -------------------------------------------------------------------------
  // Probe → sample → hysteresis → state update pipeline
  // -------------------------------------------------------------------------

  private async probeAndReconcile(dependency: string): Promise<void> {
    const result = await this.probe(dependency);
    const sb = serviceClient();
    const now = new Date().toISOString();

    // 1. Write sample to health_samples.
    await sb.from("health_samples").insert({
      dependency: result.dependency,
      ok: result.ok,
      critical: result.critical,
      latency_ms: result.latency_ms,
      detail: result.detail,
      sampled_at: now,
    });

    // 2. Load current state.
    const { data: rows } = await sb
      .from("health_current")
      .select("*")
      .eq("dependency", dependency)
      .limit(1);

    const current: HealthCurrentRow = (rows?.[0] as HealthCurrentRow) ?? {
      dependency,
      state: "green" as HealthState,
      consecutive_good: 0,
      consecutive_bad: 0,
      last_probed_at: now,
    };

    // 3. Apply hysteresis.
    const newState = this.applyHysteresis(current, result);

    // 4. Update counters.
    const consecutive_good = result.ok ? current.consecutive_good + 1 : 0;
    const consecutive_bad = result.ok ? 0 : current.consecutive_bad + 1;

    // 5. Upsert health_current.
    await sb.from("health_current").upsert(
      {
        dependency,
        state: newState,
        consecutive_good,
        consecutive_bad,
        last_probed_at: now,
      },
      { onConflict: "dependency" },
    );

    // 6. On state transition: emit event, manage incidents, audit.
    if (newState !== current.state) {
      await this.onStateTransition(dependency, current.state, newState, now);
    }
  }

  // -------------------------------------------------------------------------
  // Hysteresis logic
  // -------------------------------------------------------------------------

  private applyHysteresis(current: HealthCurrentRow, probe: ProbeResult): HealthState {
    const h = this.healthConfig().hysteresis;
    const { state, consecutive_good, consecutive_bad } = current;

    // Critical sample forces red regardless of current state.
    if (probe.critical && h.critical_sample_forces_red) return "red";

    if (probe.ok) {
      // Good sample — can we promote?
      const nextGood = consecutive_good + 1;
      if (state === "red" && nextGood >= h.red_to_yellow_good_samples) return "yellow";
      if (state === "yellow" && nextGood >= h.yellow_to_green_good_samples) return "green";
      return state; // hold
    }

    // Bad sample — can we demote?
    const nextBad = consecutive_bad + 1;
    if (state === "green" && nextBad >= h.green_to_yellow_bad_samples) return "yellow";
    if (state === "yellow" && nextBad >= h.yellow_to_red_bad_samples) return "red";
    return state; // hold
  }

  // -------------------------------------------------------------------------
  // State transition side-effects
  // -------------------------------------------------------------------------

  private async onStateTransition(
    dependency: string,
    from: HealthState,
    to: HealthState,
    ts: string,
  ): Promise<void> {
    const sb = serviceClient();
    const degraded = to === "yellow" || to === "red";
    const recovered = to === "green";

    // Emit bus event.
    await this.emit("health.state.changed", { dependency, from, to, ts }, {
      idempotency_key: `health:${dependency}:${from}->${to}:${ts}`,
    });

    // Incident management.
    if (degraded) {
      await sb.from("health_incidents").insert({
        dependency,
        state: to,
        opened_at: ts,
        closed_at: null,
      });
    }

    if (recovered) {
      // Close open incidents for this dependency.
      await sb
        .from("health_incidents")
        .update({ closed_at: ts })
        .eq("dependency", dependency)
        .is("closed_at", null);
    }

    // Audit log.
    await this.audit({
      action: "health.state.changed",
      entity_type: "health_current",
      entity_id: dependency,
      severity: to === "red" ? "warn" : "info",
      before_state: { state: from },
      after_state: { state: to },
      reason: `${dependency}: ${from} -> ${to}`,
    });

    this.log.info({ dependency, from, to }, "health state transition");
  }

  // -------------------------------------------------------------------------
  // Nightly rollup
  // -------------------------------------------------------------------------

  private lastRollupDate: string | null = null;

  private async maybeNightlyRollup(): Promise<void> {
    const now = new Date();
    // Run at 00:xx UTC — only once per calendar day.
    if (now.getUTCHours() !== 0) return;

    const today = now.toISOString().slice(0, 10);
    if (this.lastRollupDate === today) return;
    this.lastRollupDate = today;

    // Rollup yesterday.
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10);

    await this.computeDailyRollup(yesterday);
  }

  private async computeDailyRollup(date: string): Promise<void> {
    const sb = serviceClient();
    const dayStart = `${date}T00:00:00.000Z`;
    const dayEnd = `${date}T23:59:59.999Z`;

    for (const dependency of Object.keys(PROBE_TARGETS)) {
      const { data: samples } = await sb
        .from("health_samples")
        .select("ok, latency_ms")
        .eq("dependency", dependency)
        .gte("sampled_at", dayStart)
        .lte("sampled_at", dayEnd);

      const rows = (samples ?? []) as { ok: boolean; latency_ms: number }[];
      const total = rows.length;
      if (total === 0) continue;

      const okCount = rows.filter((r) => r.ok).length;
      const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
      const avgLatency = latencies.reduce((s, v) => s + v, 0) / total;
      const p95Index = Math.min(Math.floor(total * 0.95), total - 1);

      await sb.from("health_daily_rollup").upsert(
        {
          dependency,
          date,
          total_probes: total,
          ok_probes: okCount,
          uptime_pct: parseFloat(((okCount / total) * 100).toFixed(2)),
          avg_latency_ms: Math.round(avgLatency),
          p95_latency_ms: latencies[p95Index],
        },
        { onConflict: "dependency,date" },
      );
    }

    this.log.info({ date }, "daily health rollup computed");
  }

  // -------------------------------------------------------------------------
  // Config helper
  // -------------------------------------------------------------------------

  private healthConfig(): HealthThresholds {
    return thresholds().health as unknown as HealthThresholds;
  }
}

export default new HealthMonitor();
