/**
 * dashboard/server.ts — Hono HTTP + WebSocket server for Accounting Center
 * dashboards.
 *
 * Endpoints:
 *   GET  /api/dashboards           — list all dashboards
 *   GET  /api/dashboards/:id/tiles — tile_state rows for a dashboard
 *   GET  /api/health               — health_current summary
 *   GET  /api/kpis                 — kpi_latest view
 *   WS   /ws                       — real-time tile_state push via pg_notify
 *
 * Uses @hono/node-server for HTTP and `ws` for WebSocket upgrades.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import { env } from "@shared/env.js";
import { serviceClient } from "@shared/supabase.js";
import { agentLogger } from "@shared/logger.js";

const log = agentLogger("center", "dashboard-server");
const PORT = env.DASHBOARD_PORT;

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

app.use("/*", cors());

// Health check for the server itself.
app.get("/api/ping", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// ---- Dashboards -----------------------------------------------------------

app.get("/api/dashboards", async (c) => {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("dashboards")
    .select("*")
    .order("sort_order", { ascending: true });

  if (error) {
    log.error({ err: error }, "GET /api/dashboards failed");
    return c.json({ error: error.message }, 500);
  }

  return c.json(data);
});

// ---- Tiles for a dashboard ------------------------------------------------

app.get("/api/dashboards/:id/tiles", async (c) => {
  const dashboardId = c.req.param("id");
  const sb = serviceClient();

  const { data, error } = await sb
    .from("tile_state")
    .select(`
      tile_definition_id,
      dashboard_id,
      value,
      previous_value,
      delta,
      health,
      narrative,
      refreshed_at,
      tile_definitions (
        slug,
        display_name,
        data_source,
        config
      )
    `)
    .eq("dashboard_id", dashboardId)
    .order("refreshed_at", { ascending: false });

  if (error) {
    log.error({ err: error, dashboardId }, "GET /api/dashboards/:id/tiles failed");
    return c.json({ error: error.message }, 500);
  }

  return c.json(data);
});

// ---- Health current -------------------------------------------------------

app.get("/api/health", async (c) => {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("health_current")
    .select("*")
    .order("dependency", { ascending: true });

  if (error) {
    log.error({ err: error }, "GET /api/health failed");
    return c.json({ error: error.message }, 500);
  }

  return c.json(data);
});

// ---- KPI latest -----------------------------------------------------------

app.get("/api/kpis", async (c) => {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("kpi_latest")
    .select("*")
    .order("display_name", { ascending: true });

  if (error) {
    log.error({ err: error }, "GET /api/kpis failed");
    return c.json({ error: error.message }, 500);
  }

  return c.json(data);
});

// ---------------------------------------------------------------------------
// HTTP server + WebSocket upgrade
// ---------------------------------------------------------------------------

const httpServer = serve({ fetch: app.fetch, port: PORT }) as HttpServer;

const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws: WebSocket) => {
  clients.add(ws);
  log.info({ clients: clients.size }, "ws client connected");

  ws.on("close", () => {
    clients.delete(ws);
    log.debug({ clients: clients.size }, "ws client disconnected");
  });

  ws.on("error", (err) => {
    log.error({ err }, "ws client error");
    clients.delete(ws);
  });

  // Send a welcome frame so the client knows the connection is live.
  ws.send(JSON.stringify({ type: "connected", ts: new Date().toISOString() }));
});

// ---------------------------------------------------------------------------
// pg_notify → WebSocket fan-out
// ---------------------------------------------------------------------------

function broadcastToClients(message: Record<string, unknown>): void {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

function subscribeTileStateChanges(): void {
  const sb = serviceClient();

  sb.channel("tile_state_ws_fanout")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "tile_state" },
      (msg) => {
        const row = msg.new as Record<string, unknown>;
        broadcastToClients({
          type: "tile_state_changed",
          tile_definition_id: row.tile_definition_id,
          dashboard_id: row.dashboard_id,
          value: row.value,
          delta: row.delta,
          health: row.health,
          narrative: row.narrative,
          refreshed_at: row.refreshed_at,
        });
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "tile_state" },
      (msg) => {
        const row = msg.new as Record<string, unknown>;
        broadcastToClients({
          type: "tile_state_changed",
          tile_definition_id: row.tile_definition_id,
          dashboard_id: row.dashboard_id,
          value: row.value,
          delta: row.delta,
          health: row.health,
          narrative: row.narrative,
          refreshed_at: row.refreshed_at,
        });
      },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        log.info("tile_state pg_notify subscription active — broadcasting to ws clients");
      }
    });
}

subscribeTileStateChanges();

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(): void {
  log.info("dashboard server shutting down");

  for (const ws of clients) {
    ws.close(1001, "server shutting down");
  }
  clients.clear();

  wss.close(() => {
    httpServer.close(() => {
      log.info("dashboard server stopped");
      process.exit(0);
    });
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

log.info({ port: PORT }, "dashboard server listening");

export { app, httpServer, wss };
