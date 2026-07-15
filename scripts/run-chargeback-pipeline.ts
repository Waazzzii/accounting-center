/**
 * run-chargeback-pipeline.ts — end-to-end chargeback pipeline test.
 *
 * Phases:
 *   1. Cleanup prior state for the Toledo case (idempotent re-runs)
 *   2. Verify reservations_cache populated (Wave C)
 *   3. Start all 6 chargeback agents (gmail-ingest + 5 downstream)
 *   4. gmail-ingest's startup poll stages the fixture + emits the poll event
 *   5. Wait for the chain to settle
 *   6. Inspect final state: case row, event stream, audit log
 *
 * Expected chain:
 *   gmail-ingest (fixture mode) → chargeback_inbox row + chargeback.inbox.poll
 *   → inbox-monitor → chargeback.case.notified
 *   → reservation-matcher → chargeback.match.auto (Toledo @ 95)
 *   → case-tracker → state.changed (notified → under_review)
 *   → dossier-builder → chargeback.dossier.ready
 *   → case-tracker → state.changed (under_review → evidence_collecting)
 *   → narrative-drafter → chargeback.narrative.ready or .blocked
 *
 * Gmail fixture at fixtures/gmail-prod/toledo-144522240.json — edit env
 * GMAIL_INGEST_MODE=live and populate OAuth creds to ingest real email.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient } from "@shared/supabase.js";
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "run-pipeline" });

const TOLEDO_REF = "144522240";
const TOLEDO_GMAIL_MSG_ID = "gmail:1862520494500497507";
const FIXTURE_PATH = "fixtures/gmail-prod/toledo-144522240.json";

async function main() {
  const sb = serviceClient();

  // ---- 1. Cleanup prior state ---------------------------------------------
  log.info("cleanup: removing prior Toledo case + inbox rows if present");
  await sb.from("chargeback_cases").delete().eq("external_case_id", TOLEDO_REF);
  // Clean up BOTH the old chargeback-inbox fixture id AND the gmail-ingest id
  await sb.from("chargeback_inbox").delete().in("message_id", [
    "gmail-msg-f-1862520494500497507",
    TOLEDO_GMAIL_MSG_ID,
  ]);

  // ---- 2. Verify reservations_cache has data -------------------------------
  // After Wave C, reservations_cache is populated by the Streamline ingest
  // (scripts/ingest-streamline-reservations.ts). We no longer reseed synthetic
  // rows — we rely on real data being there.
  const { count: cacheCount } = await sb
    .from("reservations_cache")
    .select("*", { count: "exact", head: true });
  log.info({ cache_rows: cacheCount }, "reservations_cache population check");
  if (!cacheCount || cacheCount === 0) {
    log.fatal("reservations_cache is empty — run ingest-streamline-reservations first");
    process.exit(1);
  }

  // ---- 3. Verify fixture is in place (gmail-ingest will read it) ----------
  const fixturePath = resolve(process.cwd(), FIXTURE_PATH);
  try {
    JSON.parse(readFileSync(fixturePath, "utf8"));
    log.info({ fixturePath: FIXTURE_PATH }, "gmail fixture present — gmail-ingest will stage it on startup");
  } catch (err) {
    log.fatal(
      { err: err instanceof Error ? err.message : String(err), fixturePath: FIXTURE_PATH },
      "fixture missing or invalid — cannot run pipeline",
    );
    process.exit(1);
  }

  // ---- 4. Start the six agents in-process ---------------------------------
  // Full chargeback pipeline: gmail-ingest → intake → match → track → dossier → narrative.
  // gmail-ingest runs in fixture mode (env.GMAIL_INGEST_MODE=fixture) and
  // stages the Toledo email + emits chargeback.inbox.poll on startup.
  // Narrative-drafter will fail gracefully if ANTHROPIC_API_KEY isn't set.
  log.info("starting all 6 chargeback agents (gmail-ingest first so subscribers are ready when it polls)");
  const gmailPath = "../src/agents/chargeback/gmail-ingest/index.ts";
  const inboxPath = "../src/agents/chargeback/inbox-monitor/index.ts";
  const matcherPath = "../src/agents/chargeback/reservation-matcher/index.ts";
  const trackerPath = "../src/agents/chargeback/case-tracker/index.ts";
  const dossierPath = "../src/agents/chargeback/dossier-builder/index.ts";
  const narrativePath = "../src/agents/chargeback/narrative-drafter/index.ts";
  type AgentModule = { default: { start: () => Promise<void>; stop: () => Promise<void> } };
  const gmailMod = (await import(gmailPath)) as AgentModule;
  const inboxMod = (await import(inboxPath)) as AgentModule;
  const matcherMod = (await import(matcherPath)) as AgentModule;
  const trackerMod = (await import(trackerPath)) as AgentModule;
  const dossierMod = (await import(dossierPath)) as AgentModule;
  const narrativeMod = (await import(narrativePath)) as AgentModule;

  // Start downstream agents FIRST (so their realtime subscriptions are live)
  // before gmail-ingest fires its startup poll.
  await Promise.all([
    inboxMod.default.start(),
    matcherMod.default.start(),
    trackerMod.default.start(),
    dossierMod.default.start(),
    narrativeMod.default.start(),
  ]);

  // Realtime channels need ~2-3s to finish handshake
  log.info("holding 3s for subscription handshakes...");
  await new Promise((r) => setTimeout(r, 3000));

  // Now start gmail-ingest, which immediately runs a startup poll, stages
  // the fixture, and emits chargeback.inbox.poll. The downstream chain cascades.
  log.info("starting gmail-ingest — startup poll will kick off the chain");
  await gmailMod.default.start();

  // ---- 5. Wait for full chain to settle -----------------------------------
  log.info("holding 20s for gmail-ingest -> inbox-monitor -> reservation-matcher -> case-tracker -> dossier-builder -> narrative-drafter");
  await new Promise((r) => setTimeout(r, 20_000));

  // ---- 6. Inspect results -------------------------------------------------
  const { data: finalCase } = await sb
    .from("chargeback_cases")
    .select(
      "case_id, source, external_case_id, stage, guest_name, guest_email, amount, currency, reason, reason_code, charge_date, processor_deadline, internal_deadline, streamline_reservation_id, match_confidence, matched_at",
    )
    .eq("external_case_id", TOLEDO_REF)
    .single();

  const { data: inboxRow } = await sb
    .from("chargeback_inbox")
    .select("message_id, source_system, processed, processed_at, classification, parse_error")
    .eq("message_id", TOLEDO_GMAIL_MSG_ID)
    .single();

  // Correlation is chained from gmail-ingest's emit — inspect events since
  // the pipeline started (trailing 60s window) rather than filtering by a
  // pre-known correlation_id.
  const { data: allEvents } = await sb
    .from("events")
    .select("event_id, event_type, source_agent, correlation_id, occurred_at")
    .gt("occurred_at", new Date(Date.now() - 60_000).toISOString())
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
    { pipelineEvents: allEvents?.map((e) => `${e.occurred_at}  ${e.event_type}  (by ${e.source_agent})`) },
    `events in the last 60s: ${allEvents?.length ?? 0}`,
  );
  log.info(
    { downstreamEvents: downstreamEvents.map((e) => `${e.occurred_at}  ${e.event_type}  (by ${e.source_agent})`) },
    `downstream events keyed on case_id: ${downstreamEvents.length}`,
  );
  log.info(
    { auditEntries: auditEntries?.map((a) => `${a.occurred_at}  ${a.action} on ${a.entity_type}  — ${a.reason}`) },
    `audit entries: ${auditEntries?.length ?? 0}`,
  );

  // ---- 7. Shut down --------------------------------------------------------
  await Promise.all([
    gmailMod.default.stop(),
    inboxMod.default.stop(),
    matcherMod.default.stop(),
    trackerMod.default.stop(),
    dossierMod.default.stop(),
    narrativeMod.default.stop(),
  ]);
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
