/**
 * replay-toledo-chargeback.ts — inject the real Lynnbrook case
 * (Ref #144522240, Jason Toledo, $3,679, Coachella Valley ST) through the
 * chargeback pipeline in shadow mode.
 *
 * What it exercises:
 *   1. chargeback_cases row creation (using the ACTUAL schema, not inbox-monitor's)
 *   2. chargeback.case.notified event published to the bus
 *   3. case-tracker subscription fires → stage transition + asana intent log
 *   4. reservation-matcher subscription fires → searches empty reservations_cache
 *      → emits chargeback.match.ambiguous (expected, no data to match against)
 *   5. case-tracker handles the ambiguous event → further stage transition
 *
 * Known drift (surfaces here, to be fixed in a follow-up pass):
 *   - inbox-monitor uses columns that don't exist in the schema
 *     (reason_code, status, processor_deadline, inbox_message_id, id)
 *   - reservation-matcher.updateCaseMatch uses .eq("id") — schema PK is case_id.
 *     Not exercised in this replay because no candidates score > threshold.
 *   - source enum lacks 'lynnbrook' — falling back to 'other'
 */
import { randomUUID } from "node:crypto";
import { serviceClient } from "@shared/supabase.js";
import { publish } from "@shared/bus.js";
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "replay-toledo" });

// Deterministic external_case_id so reruns are idempotent on the upsert
const TOLEDO = {
  source: "other" as const,                // schema enum; 'lynnbrook' not yet in enum
  external_case_id: "144522240",           // real Lynnbrook reference
  notified_at: new Date().toISOString(),
  stage: "notified" as const,
  reason: "subscription_cancelled" as const, // closest enum for "Cancelled Merchandise/Services"
  reason_detail: "Lynnbrook via aptx.cm — Cancelled Merchandise/Services / Unresponded",
  amount: 3679.00,
  currency: "USD",
  guest_name: "Jason Toledo",
  guest_email: null as string | null,
  property_id: "coachella-valley-placeholder",
  channel: null,                            // Lynnbrook isn't an OTA channel
  charge_date: "2026-03-12",                // back-dated for realistic matching window
  evidence_due_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), // 3d (SOP for "Unresponded")
  auto_assembled: false,
};

async function main() {
  const sb = serviceClient();

  // ---- 0. Import + start the agents we want to observe reacting -----------
  log.info("starting case-tracker + reservation-matcher...");
  const trackerMod = (await import(
    "../src/agents/chargeback/case-tracker/index.ts"
  )) as { default: { start: () => Promise<void>; stop: () => Promise<void> } };
  const matcherMod = (await import(
    "../src/agents/chargeback/reservation-matcher/index.ts"
  )) as { default: { start: () => Promise<void>; stop: () => Promise<void> } };

  const tracker = trackerMod.default;
  const matcher = matcherMod.default;

  await Promise.all([tracker.start(), matcher.start()]);

  // Realtime WebSocket attach takes ~1-2s after .subscribe()
  log.info("waiting 3s for realtime subscriptions to attach...");
  await new Promise((r) => setTimeout(r, 3000));

  // ---- 1. Upsert case row --------------------------------------------------
  log.info({ external_case_id: TOLEDO.external_case_id }, "upserting chargeback_cases row");
  const { data: caseRow, error: upsertErr } = await sb
    .from("chargeback_cases")
    .upsert(TOLEDO, {
      onConflict: "source,external_case_id",
      ignoreDuplicates: false,
    })
    .select("case_id, stage, amount, guest_name, reason, evidence_due_at")
    .single();

  if (upsertErr || !caseRow) {
    log.fatal({ err: upsertErr }, "upsert failed");
    process.exit(1);
  }
  log.info({ caseRow }, "case row persisted");

  // ---- 2. Publish chargeback.case.notified event ---------------------------
  // NOTE: events.correlation_id is UUID-typed. Several agent files (outcome-analyst,
  // narrative-drafter, case-tracker) build correlation IDs from event_id+timestamps
  // as free-form strings — those will fail at publish() time the same way this did
  // on first run. Known drift to track.
  const correlationId = randomUUID();
  log.info({ correlationId, case_id: caseRow.case_id }, "publishing chargeback.case.notified");

  const eventPayload = {
    case_id: caseRow.case_id,
    processor: "lynnbrook",                   // what the agents expect
    external_case_id: TOLEDO.external_case_id,
    amount: TOLEDO.amount,
    currency: TOLEDO.currency,
    reason_code: "cancellation_refund",       // what inbox-monitor would normalize to
    guest_name: TOLEDO.guest_name,
    charge_date: TOLEDO.charge_date,
    processor_deadline: TOLEDO.evidence_due_at,
    internal_deadline: TOLEDO.evidence_due_at,
  };

  const eventId = await publish({
    event_type: "chargeback.case.notified",
    source_product: "chargeback",
    source_agent: "replay-script",
    correlation_id: correlationId,
    idempotency_key: `replay-${TOLEDO.external_case_id}-${Math.floor(Date.now() / 1000)}`,
    payload: eventPayload,
    region: "socal",
  });
  log.info({ eventId }, "event published");

  // ---- 3. Let handlers run -------------------------------------------------
  log.info("holding 8s for subscribers to react (case-tracker + reservation-matcher)");
  await new Promise((r) => setTimeout(r, 8000));

  // ---- 4. Inspect post-state ----------------------------------------------
  const { data: afterCase } = await sb
    .from("chargeback_cases")
    .select("case_id, stage, reservation_ref, guest_name, amount, evidence_due_at, updated_at")
    .eq("case_id", caseRow.case_id)
    .single();

  const { data: afterEvents } = await sb
    .from("events")
    .select("event_id, event_type, source_agent, occurred_at")
    .eq("correlation_id", correlationId)
    .order("occurred_at", { ascending: true });

  const { data: auditEntries } = await sb
    .from("audit_log")
    .select("audit_id, action, entity_type, entity_id, actor_id, occurred_at, reason")
    .eq("correlation_id", correlationId)
    .order("occurred_at", { ascending: true });

  log.info("\n==========================================================");
  log.info("REPLAY RESULT");
  log.info("==========================================================");
  log.info({ case: afterCase }, "final case state");
  log.info(
    { events: afterEvents?.map((e) => `${e.occurred_at}  ${e.event_type}  (by ${e.source_agent})`) },
    `events in this correlation: ${afterEvents?.length ?? 0}`,
  );
  log.info(
    { audit: auditEntries?.map((a) => `${a.occurred_at}  ${a.action} on ${a.entity_type}:${a.entity_id}  — ${a.reason}`) },
    `audit log entries: ${auditEntries?.length ?? 0}`,
  );

  // ---- 5. Shut down --------------------------------------------------------
  await Promise.all([tracker.stop(), matcher.stop()]);
  log.info("replay complete");
  process.exit(0);
}

main().catch((err) => {
  log.fatal(
    { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
    "replay crashed",
  );
  process.exit(1);
});
