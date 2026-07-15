/**
 * dashboard-builder — loads tile definitions, refreshes tile state on
 * cadence and in reaction to KPI snapshots, writes tile_state rows,
 * and emits events for downstream consumers (WebSocket fan-out, alerts).
 *
 * Data-source strategies per tile:
 *   kpi_snapshot  — reads kpi_latest view
 *   query         — executes tile's query_sql via Supabase RPC
 *   event_stream  — queries recent events matching event_filter
 *   agent_output  — placeholder (phase 2)
 *   static        — no-op
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
  slug: "dashboard-builder",
  display_name: "Dashboard Builder",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DataSource = "kpi_snapshot" | "query" | "event_stream" | "agent_output" | "static";
type HealthBand = "green" | "yellow" | "red" | "unknown";

interface TileDefinition {
  id: string;
  dashboard_id: string;
  slug: string;
  display_name: string;
  data_source: DataSource;
  kpi_id: string | null;
  query_sql: string | null;
  event_filter: Record<string, unknown> | null;
  refresh_seconds: number;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** Row shape in tile_subscription_map (kpi_id -> tile_id[]). */
interface TileSubscription {
  kpi_id: string;
  tile_definition_id: string;
}

interface TileState {
  tile_definition_id: string;
  dashboard_id: string;
  value: number | null;
  previous_value: number | null;
  delta: number | null;
  health: HealthBand;
  narrative: string | null;
  refreshed_at: string;
}

interface KpiLatestRow {
  kpi_definition_id: string;
  display_name: string;
  value: number;
  unit: string;
  target_direction: string;
  target_green: number | null;
  target_yellow: number | null;
  computed_at: string;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class DashboardBuilder extends AgentBase {
  private tiles: TileDefinition[] = [];
  private subscriptionMap = new Map<string, string[]>(); // kpi_id -> tile_id[]
  private refreshTimers: ReturnType<typeof setInterval>[] = [];
  private unsubscribers: (() => void)[] = [];

  constructor() {
    super(IDENTITY);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    // 1. Load enabled tile definitions.
    const sb = serviceClient();
    const { data: tileDefs, error: tileErr } = await sb
      .from("tile_definitions")
      .select("*")
      .eq("enabled", true);

    if (tileErr) {
      this.log.error({ err: tileErr }, "failed to load tile_definitions");
      throw new Error(`tile_definitions load failed: ${tileErr.message}`);
    }

    this.tiles = (tileDefs ?? []) as unknown as TileDefinition[];
    this.log.info({ count: this.tiles.length }, "tile definitions loaded");

    // 2. Build subscription map (kpi_id -> tile_ids).
    const { data: subs } = await sb.from("tile_subscription_map").select("*");
    for (const row of (subs ?? []) as unknown as TileSubscription[]) {
      const list = this.subscriptionMap.get(row.kpi_id) ?? [];
      list.push(row.tile_definition_id);
      this.subscriptionMap.set(row.kpi_id, list);
    }

    // 3. Subscribe to kpi.snapshot.written — refresh affected tiles.
    const unsub = this.on(
      { event_type: "kpi.snapshot.written" },
      async (ev) => {
        const payload = ev.payload as { kpi_definition_id?: string };
        const kpiId = payload.kpi_definition_id;
        if (!kpiId) return;

        const tileIds = this.subscriptionMap.get(kpiId);
        if (!tileIds || tileIds.length === 0) return;

        const affected = this.tiles.filter((t) => tileIds.includes(t.id));
        this.log.info(
          { kpiId, tileCount: affected.length },
          "kpi snapshot triggered tile refresh",
        );
        await this.refreshBatch(affected);
      },
    );
    this.unsubscribers.push(unsub);

    // 4. Subscribe to tile_state_changed pg_notify for WS fan-out (Phase 1: log only).
    const pgChannel = sb
      .channel("tile_state_changed_pgnotify")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "tile_state" },
        (msg) => {
          this.log.debug(
            { tile_definition_id: (msg.new as Record<string, unknown>).tile_definition_id },
            "tile_state_changed notification (ws fan-out deferred to wave 2)",
          );
        },
      )
      .subscribe();

    this.unsubscribers.push(() => void sb.removeChannel(pgChannel));

    // 5. Set up per-tile refresh timers.
    for (const tile of this.tiles) {
      if (tile.data_source === "static") continue;

      const intervalMs = tile.refresh_seconds * 1_000;
      const timer = setInterval(() => void this.refreshTile(tile), intervalMs);
      this.refreshTimers.push(timer);
    }

    // 6. Fire an initial refresh for all tiles.
    await this.refreshBatch(this.tiles);

    this.log.info("dashboard-builder online");
  }

  protected async onStop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];

    for (const timer of this.refreshTimers) clearInterval(timer);
    this.refreshTimers = [];

    this.log.info("dashboard-builder stopped");
  }

  // -------------------------------------------------------------------------
  // Refresh orchestration
  // -------------------------------------------------------------------------

  private async refreshBatch(tiles: TileDefinition[]): Promise<void> {
    const results = await Promise.allSettled(
      tiles.map((t) => this.refreshTile(t)),
    );

    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      this.log.warn({ total: tiles.length, failed }, "some tile refreshes failed");
    }

    // Emit batch event.
    await this.emit(
      "tile.state.updated",
      {
        tile_ids: tiles.map((t) => t.id),
        refreshed_at: new Date().toISOString(),
        failed_count: failed,
      },
      { idempotency_key: `tile-batch:${Date.now()}` },
    );
  }

  // -------------------------------------------------------------------------
  // Per-tile refresh — delegates by data_source type
  // -------------------------------------------------------------------------

  private async refreshTile(tile: TileDefinition): Promise<void> {
    let value: number | null = null;

    switch (tile.data_source) {
      case "kpi_snapshot":
        value = await this.fetchKpiSnapshot(tile);
        break;
      case "query":
        value = await this.executeQuerySql(tile);
        break;
      case "event_stream":
        value = await this.fetchEventStream(tile);
        break;
      case "agent_output":
        // Placeholder — agent_output tiles will be implemented in Phase 2.
        this.log.debug({ tileId: tile.id }, "agent_output refresh is a no-op (phase 2)");
        return;
      case "static":
        return;
    }

    await this.writeTileState(tile, value);
  }

  // -------------------------------------------------------------------------
  // Data source: kpi_snapshot
  // -------------------------------------------------------------------------

  private async fetchKpiSnapshot(tile: TileDefinition): Promise<number | null> {
    if (!tile.kpi_id) {
      this.log.warn({ tileId: tile.id }, "kpi_snapshot tile missing kpi_id");
      return null;
    }

    const sb = serviceClient();
    const { data, error } = await sb
      .from("kpi_latest")
      .select("*")
      .eq("kpi_definition_id", tile.kpi_id)
      .limit(1)
      .maybeSingle();

    if (error) {
      this.log.error({ err: error, tileId: tile.id }, "kpi_latest query failed");
      return null;
    }

    if (!data) return null;
    const row = data as unknown as KpiLatestRow;
    return row.value;
  }

  // -------------------------------------------------------------------------
  // Data source: query
  // -------------------------------------------------------------------------

  private async executeQuerySql(tile: TileDefinition): Promise<number | null> {
    if (!tile.query_sql) {
      this.log.warn({ tileId: tile.id }, "query tile missing query_sql");
      return null;
    }

    const sb = serviceClient();
    const { data, error } = await sb.rpc("exec_sql", { query: tile.query_sql });

    if (error) {
      this.log.error({ err: error, tileId: tile.id }, "query tile exec_sql failed");
      return null;
    }

    const rows = data as Record<string, unknown>[] | null;
    if (!rows || rows.length === 0) return null;

    const raw = Object.values(rows[0])[0];
    const num = Number(raw);
    return Number.isNaN(num) ? null : num;
  }

  // -------------------------------------------------------------------------
  // Data source: event_stream
  // -------------------------------------------------------------------------

  private async fetchEventStream(tile: TileDefinition): Promise<number | null> {
    const filter = tile.event_filter;
    if (!filter) {
      this.log.warn({ tileId: tile.id }, "event_stream tile missing event_filter");
      return null;
    }

    const sb = serviceClient();
    const windowMinutes = (filter.window_minutes as number) ?? 60;
    const cutoff = new Date(Date.now() - windowMinutes * 60 * 1_000).toISOString();

    let query = sb
      .from("events")
      .select("*", { count: "exact", head: true })
      .gte("occurred_at", cutoff);

    if (filter.event_type) {
      query = query.eq("event_type", filter.event_type as string);
    }
    if (filter.source_product) {
      query = query.eq("source_product", filter.source_product as string);
    }

    const { count, error } = await query;

    if (error) {
      this.log.error({ err: error, tileId: tile.id }, "event_stream query failed");
      return null;
    }

    return count ?? 0;
  }

  // -------------------------------------------------------------------------
  // Write tile_state with delta, health band, and narrative
  // -------------------------------------------------------------------------

  private async writeTileState(
    tile: TileDefinition,
    value: number | null,
  ): Promise<void> {
    const sb = serviceClient();
    const now = new Date().toISOString();

    // Fetch prior state for delta computation.
    const { data: prior } = await sb
      .from("tile_state")
      .select("value")
      .eq("tile_definition_id", tile.id)
      .limit(1)
      .maybeSingle();

    const previousValue = (prior as { value: number | null } | null)?.value ?? null;
    const delta =
      value !== null && previousValue !== null ? value - previousValue : null;

    // Determine health band from KPI thresholds when available.
    const health = await this.computeHealthBand(tile, value);

    // Generate a short narrative.
    const narrative = this.generateNarrative(tile, value, delta, health);

    const row: TileState = {
      tile_definition_id: tile.id,
      dashboard_id: tile.dashboard_id,
      value,
      previous_value: previousValue,
      delta,
      health,
      narrative,
      refreshed_at: now,
    };

    const { error } = await sb
      .from("tile_state")
      .upsert(row, { onConflict: "tile_definition_id" });

    if (error) {
      this.log.error({ err: error, tileId: tile.id }, "tile_state upsert failed");
      return;
    }

    this.log.debug({ tileId: tile.id, value, delta, health }, "tile_state written");
  }

  // -------------------------------------------------------------------------
  // Health band derivation
  // -------------------------------------------------------------------------

  private async computeHealthBand(
    tile: TileDefinition,
    value: number | null,
  ): Promise<HealthBand> {
    if (value === null) return "unknown";
    if (!tile.kpi_id) return "unknown";

    const sb = serviceClient();
    const { data } = await sb
      .from("kpi_latest")
      .select("target_direction, target_green, target_yellow")
      .eq("kpi_definition_id", tile.kpi_id)
      .limit(1)
      .maybeSingle();

    if (!data) return "unknown";

    const row = data as unknown as Pick<
      KpiLatestRow,
      "target_direction" | "target_green" | "target_yellow"
    >;

    if (row.target_green === null || row.target_yellow === null) return "unknown";

    if (row.target_direction === "higher_is_better") {
      if (value >= row.target_green) return "green";
      if (value >= row.target_yellow) return "yellow";
      return "red";
    }

    if (row.target_direction === "lower_is_better") {
      if (value <= row.target_green) return "green";
      if (value <= row.target_yellow) return "yellow";
      return "red";
    }

    return "unknown";
  }

  // -------------------------------------------------------------------------
  // Narrative generation
  // -------------------------------------------------------------------------

  private generateNarrative(
    tile: TileDefinition,
    value: number | null,
    delta: number | null,
    health: HealthBand,
  ): string | null {
    if (value === null) return "No data available yet.";

    const name = tile.display_name;
    const parts: string[] = [`${name} is ${value.toLocaleString()}`];

    if (delta !== null && delta !== 0) {
      const direction = delta > 0 ? "up" : "down";
      const abs = Math.abs(delta);
      parts.push(`(${direction} ${abs.toLocaleString()} from prior)`);
    }

    if (health === "red") {
      parts.push("-- needs attention.");
    } else if (health === "yellow") {
      parts.push("-- approaching threshold.");
    } else if (health === "green") {
      parts.push("-- on track.");
    }

    return parts.join(" ");
  }
}

export default new DashboardBuilder();
