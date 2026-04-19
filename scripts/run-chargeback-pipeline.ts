/**
 * run-chargeback-pipeline.ts — end-to-end chargeback pipeline test.
 *
 * Phases:
 *   1. Cleanup prior state for the Toledo case (idempotent re-runs)
 *   2. Reseed reservations_cache (matching candidates exist)
 *   3. Stage the real Lynnbrook email as a chargeback_inbox row
 *   4. Start inbox-monitor + reservation-matcher + case-tracker in-process
 *   5. Publish `chargeback.inbox.poll` to kick off processing
 *   6. Wait for the realtime-driven subscribers to react
 *   7. Inspect final state: case row, event stream, audit log
 *
 * Expected result:
 *   inbox-monitor parses the Lynnbrook email → creates case →
 *   emits chargeback.case.notified → reservation-matcher scores Jason
 *   Toledo at 100 → emits chargeback.match.auto → case-tracker advances
 *   stage to under_review.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient } from "@shared/supabase.js";
import { publish } from "@shared/bus.js";
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "run-pipeline" });

const TOLEDO_REF = "144522240";
const FIXTURE_PATH = "fixtures/chargeback-inbox/toledo-144522240.json";
const RESERVATION_IDS = [
  "SL-CV-2026-00417", "SL-CV-2026-00415", "SL-CV-2026-00201",
  "SL-CV-2026-00305", "SL-PHX-2026-00512",
];

async function main() {
  const sb = serviceClient();

  // ---- 1. Cleanup prior state ---------------------------------------------
  log.info("cleanup: removing prior Toledo case + inbox fixture if present");
  await sb.from("chargeback_cases").delete().eq("external_case_id", TOLEDO_REF);
  await sb.from("chargeback_inbox").delete().eq("message_id", "gmail-msg-f-1862520494500497507");

  // ---- 2. Reseed reservations_cache ----------------------------------------
  log.info("reseeding reservations_cache...");
  const seedModPath = "../scripts/seed-reservations-cache.ts";
  // We just run the seed data inline so this script is self-contained
  const seedPath = resolve(process.cwd(), "scripts/seed-reservations-cache.ts");
  const seedRaw = readFileSync(seedPath, "utf8");
  // Extract the SEEDS array via a fresh tsx import
  const { SEEDS } = await (async () => {
    // Eval-safe: dynamic import of the seed module, which exports SEEDS
    const mod = (await import(seedModPath)) as { SEEDS?: unknown };
    if (mod.SEEDS) return { SEEDS: mod.SEEDS as Array<Record<string, unknown>> };
    // Fallback: parse the array out of the source (doesn't currently export)
    void seedRaw;
    throw new Error("seed-reservations-cache.ts must export SEEDS");
  })();

  await sb.from("reservations_cache").upsert(SEEDS, { onConflict: "reservation_id" });
  // Re-select so we can verify the Toledo row has the right date window now
  const { data: toledoResv } = await sb
    .from("reservations_cache")
    .select("reservation_id, guest_name, check_in, check_out, total_amount, channel")
    .in("reservation_id", RESERVATION_IDS);
  log.info({ count: toledoResv?.length }, "reservations reseeded");

  // ---- 3. Stage the fixture into chargeback_inbox --------------------------
  log.info("staging Toledo email fixture in chargeback_inbox");
  const fixturePath = resolve(process.cwd(), FIXTURE_PATH);
  type Fixture = {
    message_id: string;
    source_system: string;
    subject: string;
    from_address: string;
    to_address?: string;
    received_at: string;
    body: string;
    body_html?: string | null;
    metadata?: Record<string, unknown>;
  };
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
  const { error: inboxErr } = await sb.from("chargeback_inbox").upsert(
    {
      message_id: fixture.message_id,
      source_system: fixture.source_system,
      subject: fixture.subject,
      from_address: fixture.from_address,
      to_address: fixture.to_address ?? null,
      received_at: fixture.received_at,
      body: fixture.body,
      body_html: fixture.body_html ?? null,
      processed: false,
      metadata: fixture.metadata ?? {},
    },
    { onConflict: "message_id" },
  );
  if (inboxErr) {
    log.fatal({ err: inboxErr }, "staging failed");
    process.exit(1);
  }

  // ---- 4. Start the three agents in-process --------------------------------
  log.info("starting inbox-monitor + reservation-matcher + case-tracker");
  const inboxPath = "../src/agents/chargeback/inbox-monitor/index.ts";
  const matcherPath = "../src/agents/chargeback/reservation-matcher/index.ts";
  const trackerPath = "../src/agents/chargeback/case-tracker/index.ts";
  type AgentModule = { default: { start: () => Promise<void>; stop: () => Promise<void> } };
  const inboxMod = (await import(inboxPath)) as AgentModule;
  const matcherMod = (await import(matcherPath)) as AgentModule;
  const trackerMod = (await import(trackerPath)) as AgentModule;

  await Promise.all([inboxMod.default.start(), matcherMod.default.start(), trackerMod.default.start()]);

  // Realtime channels need ~2-3s to finish handshake
  log.info("holding 3s for subscription handshakes...");
  await new Promise((r) => setTimeout(r, 3000));

  // ---- 5. Publish the poll event ------------------------------------------
  const correlationId = randomUUID();
  log.info({ correlationId }, "publishing chargeback.inbox.poll");
  await publish({
    event_type: "chargeback.inbox.poll",
    source_product: "center",
    source_agent: "run-chargeback-pipeline",
    correlation_id: correlationId,
    idempotency_key: `pipeline-run-${Date.now()}`,
    payload: { triggered_by: "manual_pipeline_test" },
  });

  // ---- 6. Wait for full chain to settle -----------------------------------
  log.info("holding 10s for inbox-monitor -> reservation-matcher -> case-tracker");
  await new Promise((r) => setTimeout(r, 10_000));

  // ---- 7. Inspect results -------------------------------------------------
  const { data: finalCase } = await sb
    .from("chargeback_cases")
    .select(
      "case_id, source, external_case_id, stage, guest_name, guest_email, amount, currency, reason, reason_code, charge_date, processor_deadline, internal_deadline, streamline_reservation_id, match_confidence, matched_at",
    )
    .eq("external_case_id", TOLEDO_REF)
    .single();

  const { data: inboxRow } = await sb
    .from("chargeback_inbox")
    .select("message_id, processed, processed_at, classification, parse_error")
    .eq("message_id", fixture.message_id)
    .single();

  const { data: allEvents } = await sb
    .from("events")
    .select("event_id, event_type, source_agent, correlation_id, occurred_at")
    .eq("correlation_id", correlationId)
    .order("occurred_at", { ascending: true });

  // Gather downstream events (triggered by inbox-monitor's emit, which generates
  // a new correlation_id — follow it by case_id)
  const downstreamEvents = finalCase
    ? (await sb
        .from("events")
        .select("event_id, event_type, source_agent, correlation_id, occurred_at, payload")
        .gt("occurred_at", new Date(Date.now() - 30_000).toISOString())
        .order("occurred_at", { ascending: true })
      ).data?.filter((e) => {
        const p = e.payload as { case_id?: string };
        return p?.case_id === finalCase.case_id;
      }) ?? []
    : [];

  const { data: auditEntries } = finalCase
    ? await sb
        .from("audit_log")
        .select("action, entity_type, entity_id, occurred_at, reason")
        .eq("entity_id", finalCase.case_id)
        .order("occurred_at", { ascending: true })
    : { data: [] };

  log.info("\n==========================================================");
  log.info("PIPELINE RESULT");
  log.info("==========================================================");
  log.info({ finalCase }, "final chargeback_cases row");
  log.info({ inboxRow }, "inbox row state");
  log.info(
    { pollEvents: allEvents?.map((e) => `${e.occurred_at}  ${e.event_type}  (by ${e.source_agent})`) },
    `events with the poll correlation_id: ${allEvents?.length ?? 0}`,
  );
  log.info(
    { downstreamEvents: downstreamEvents.map((e) => `${e.occurred_at}  ${e.event_type}  (by ${e.source_agent})`) },
    `downstream events keyed on case_id: ${downstreamEvents.length}`,
  );
  log.info(
    { auditEntries: auditEntries?.map((a) => `${a.occurred_at}  ${a.action} on ${a.entity_type}  — ${a.reason}`) },
    `audit entries: ${auditEntries?.length ?? 0}`,
  );

  // ---- 8. Shut down --------------------------------------------------------
  await Promise.all([inboxMod.default.stop(), matcherMod.default.stop(), trackerMod.default.stop()]);
  log.info("pipeline complete");
  process.exit(0);
}

main().catch((err) => {
  log.fatal(
    { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
    "pipeline crashed",
  );
  process.exit(1);
});
