/**
 * feed-inbox.ts — drop a chargeback-inbox fixture into the staging table.
 *
 * Usage:
 *   npx tsx scripts/feed-inbox.ts fixtures/chargeback-inbox/toledo-144522240.json
 *
 * This is the Phase 1 ingester. Phase 2 replaces it with the gmail-ingest
 * agent that polls accounting@acmehouseco.com on a 15-min cadence; the
 * downstream contract (chargeback_inbox rows keyed on message_id, idempotent)
 * stays identical.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient } from "@shared/supabase.js";
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "feed-inbox" });

interface Fixture {
  message_id: string;
  source_system: string;
  subject: string;
  from_address: string;
  to_address?: string;
  received_at: string;
  body: string;
  body_html?: string | null;
  metadata?: Record<string, unknown>;
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    log.error("usage: feed-inbox.ts <fixture.json>");
    process.exit(1);
  }

  const fullPath = resolve(process.cwd(), path);
  const raw = readFileSync(fullPath, "utf8");
  const fixture = JSON.parse(raw) as Fixture;

  log.info(
    { message_id: fixture.message_id, subject: fixture.subject, from: fixture.from_address },
    "upserting chargeback_inbox fixture",
  );

  const sb = serviceClient();
  const { data, error } = await sb
    .from("chargeback_inbox")
    .upsert(
      {
        message_id: fixture.message_id,
        source_system: fixture.source_system,
        subject: fixture.subject,
        from_address: fixture.from_address,
        to_address: fixture.to_address ?? null,
        received_at: fixture.received_at,
        body: fixture.body,
        body_html: fixture.body_html ?? null,
        processed: false,                  // make sure re-feeds get re-processed
        processed_at: null,
        processed_by: null,
        metadata: fixture.metadata ?? {},
      },
      { onConflict: "message_id", ignoreDuplicates: false },
    )
    .select("inbox_id, message_id, subject, from_address, processed")
    .single();

  if (error || !data) {
    log.fatal({ err: error }, "upsert failed");
    process.exit(1);
  }

  log.info({ row: data }, "fixture staged — inbox-monitor will pick it up on next poll");
  process.exit(0);
}

main().catch((err) => {
  log.fatal(
    { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
    "feed-inbox crashed",
  );
  process.exit(1);
});
