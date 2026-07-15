/**
 * bus.ts — the event bus.
 *
 * Phase 1 implementation: Postgres as the bus. `publish()` inserts into
 * `events`, the `events_notify` trigger fires pg_notify, and listeners
 * subscribe via `subscribe()` (which uses Supabase Realtime or a raw
 * Postgres LISTEN connection).
 *
 * Designed so a swap to NATS/Kafka later is a local change to this file.
 */

import type { EventEnvelope } from "./types.js";
import { serviceClient } from "./supabase.js";
import { agentLogger } from "./logger.js";

const log = agentLogger("center", "bus");

/**
 * Publish an event. Returns the event_id. Idempotent when idempotency_key
 * is provided (duplicate insert is swallowed; existing event_id returned).
 */
export async function publish<P, M = Record<string, unknown>>(
  ev: EventEnvelope<P, M>,
): Promise<string> {
  const sb = serviceClient();

  const row = {
    event_type: ev.event_type,
    source_product: ev.source_product,
    source_agent: ev.source_agent,
    correlation_id: ev.correlation_id ?? null,
    causation_id: ev.causation_id ?? null,
    idempotency_key: ev.idempotency_key ?? null,
    payload: ev.payload,
    metadata: ev.metadata ?? {},
    region: ev.region ?? "all",
  };

  const { data, error } = await sb
    .from("events")
    .insert(row)
    .select("event_id")
    .single();

  if (error) {
    // Unique-violation on idempotency_key → fetch existing event_id.
    if (error.code === "23505" && ev.idempotency_key) {
      const existing = await sb
        .from("events")
        .select("event_id")
        .eq("idempotency_key", ev.idempotency_key)
        .single();
      if (existing.data) {
        log.debug(
          { event_type: ev.event_type, idempotency_key: ev.idempotency_key },
          "event deduped",
        );
        return existing.data.event_id as string;
      }
    }
    log.error({ err: error, event_type: ev.event_type }, "event publish failed");
    throw new Error(`event publish failed: ${error.message}`);
  }

  log.debug(
    { event_id: data.event_id, event_type: ev.event_type, source_agent: ev.source_agent },
    "event published",
  );
  return data.event_id as string;
}

/**
 * Subscribe to events matching a filter. The handler is invoked once per
 * matching event. Returns an unsubscribe function.
 *
 * Phase 1: uses Supabase Realtime. A future raw-LISTEN implementation
 * will swap in here without changing agent code.
 */
export interface SubscribeFilter {
  event_type?: string | string[];
  source_product?: string;
}

export type EventHandler = (ev: {
  event_id: string;
  event_type: string;
  source_product: string;
  source_agent: string;
  correlation_id: string | null;
  payload: unknown;
  occurred_at: string;
}) => void | Promise<void>;

export function subscribe(filter: SubscribeFilter, handler: EventHandler): () => void {
  const sb = serviceClient();
  const channel = sb
    .channel(`accounting_center_events_${Math.random().toString(36).slice(2, 8)}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "events" },
      async (msg) => {
        const row = msg.new as Record<string, unknown>;
        if (!matches(row, filter)) return;
        try {
          await handler({
            event_id: row.event_id as string,
            event_type: row.event_type as string,
            source_product: row.source_product as string,
            source_agent: row.source_agent as string,
            correlation_id: (row.correlation_id as string | null) ?? null,
            payload: row.payload,
            occurred_at: row.occurred_at as string,
          });
        } catch (err) {
          log.error({ err, event_id: row.event_id }, "subscriber handler threw");
        }
      },
    )
    .subscribe();

  return () => {
    void sb.removeChannel(channel);
  };
}

function matches(row: Record<string, unknown>, filter: SubscribeFilter): boolean {
  if (filter.source_product && row.source_product !== filter.source_product) return false;
  if (filter.event_type) {
    const want = Array.isArray(filter.event_type) ? filter.event_type : [filter.event_type];
    const type = row.event_type as string;
    const ok = want.some((w) => (w.endsWith("*") ? type.startsWith(w.slice(0, -1)) : type === w));
    if (!ok) return false;
  }
  return true;
}
