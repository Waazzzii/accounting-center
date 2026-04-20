/**
 * gmail-ingest — polls accounting@acmehouseco.com for chargeback-related
 * emails and stages them in chargeback_inbox for inbox-monitor to pick up.
 *
 * Two transports (selected by env.GMAIL_INGEST_MODE):
 *   live    — Google Gmail API via googleapis SDK + OAuth2 refresh token
 *   fixture — reads JSON files from env.GMAIL_FIXTURE_DIR (same shape as
 *             fixtures/chargeback-inbox/*.json)
 *   off     — agent starts but the poll handler is a no-op (safe default)
 *
 * Polling cadence:
 *   - Internal setInterval every POLL_INTERVAL_MS (default 15 min)
 *   - Also subscribes to `chargeback.inbox.poll` events for manual triggers
 *
 * Upsert contract: chargeback_inbox rows keyed on message_id.
 *   live  : message_id = "gmail:" + Gmail msg id   (stable, idempotent)
 *   fixture: message_id from the fixture JSON     (hand-set)
 *
 * This agent DOES NOT parse chargeback fields — it only stages. The
 * downstream inbox-monitor handles classification + field extraction.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { google, type gmail_v1 } from "googleapis";
import {
  AgentBase,
  type AgentIdentity,
  serviceClient,
} from "@shared/index.js";
import { env } from "@shared/env.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const IDENTITY: AgentIdentity = {
  product: "chargeback",
  slug: "gmail-ingest",
  display_name: "Chargeback Gmail Ingest",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Senders we watch. Keep in sync with inbox-monitor's SENDER_PROCESSOR_MAP. */
const WATCHED_SENDERS = [
  "customerservice@aptx.cm",
  "notifications@stripe.com",
  "disputes@stripe.com",
  "resolutions@airbnb.com",
  "customerservice@lynnbrookgroup.com",
];

const POLL_INTERVAL_MS = 15 * 60 * 1_000;      // 15 minutes
const LOOKBACK_DAYS_LIVE = 7;                   // Gmail `newer_than:Nd` filter
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

// ---------------------------------------------------------------------------
// Types for the common internal shape
// ---------------------------------------------------------------------------

interface StagedMessage {
  message_id: string;             // "gmail:<id>" for live, raw id for fixture
  subject: string;
  from_address: string;
  to_address: string | null;
  body: string;
  body_html: string | null;
  received_at: string;            // ISO timestamp
  metadata: Record<string, unknown>;
  source_system: "gmail" | "fixture";
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class GmailIngest extends AgentBase {
  private unsubscribers: Array<() => void> = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private gmailClient: gmail_v1.Gmail | null = null;

  constructor() {
    super(IDENTITY);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    this.log.info(
      {
        mode: env.GMAIL_INGEST_MODE,
        user: env.GMAIL_USER_EMAIL,
        fixtureDir: env.GMAIL_INGEST_MODE === "fixture" ? env.GMAIL_FIXTURE_DIR : undefined,
      },
      "gmail-ingest starting",
    );

    if (env.GMAIL_INGEST_MODE === "off") {
      this.log.warn("gmail-ingest mode=off — poll handler will no-op");
      return;
    }

    if (env.GMAIL_INGEST_MODE === "live") {
      const authOk = await this.initGmailClient();
      if (!authOk) {
        this.log.error(
          "gmail-ingest falling back to no-op because Gmail auth failed. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.",
        );
        return;
      }
    }

    // Subscribe to manual poll triggers
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.inbox.poll" }, async (ev) => {
        const cid = ev.correlation_id ?? ev.event_id;
        this.log.info({ cid, trigger: "event" }, "poll triggered by chargeback.inbox.poll");
        await this.safePoll("event");
      }),
    );

    // Run an initial poll on start (so manual runs don't wait 15 min)
    await this.safePoll("startup");

    // Recurring scheduled poll
    this.pollTimer = setInterval(() => {
      void this.safePoll("interval");
    }, POLL_INTERVAL_MS);

    this.log.info(
      { pollIntervalMinutes: POLL_INTERVAL_MS / 60_000 },
      "gmail-ingest online — scheduled poll active",
    );
  }

  protected async onStop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.log.info("gmail-ingest stopped");
  }

  // -------------------------------------------------------------------------
  // Safe-poll wrapper
  // -------------------------------------------------------------------------

  private async safePoll(trigger: "startup" | "interval" | "event"): Promise<void> {
    try {
      const count = await this.runPoll();
      this.log.info({ trigger, staged: count }, "poll complete");
    } catch (err) {
      this.log.error(
        { err: err instanceof Error ? err.message : String(err), trigger },
        "poll failed",
      );
    }
  }

  private async runPoll(): Promise<number> {
    let messages: StagedMessage[];
    if (env.GMAIL_INGEST_MODE === "fixture") {
      messages = this.loadFixtures();
    } else if (env.GMAIL_INGEST_MODE === "live" && this.gmailClient) {
      messages = await this.fetchLive();
    } else {
      return 0;
    }

    if (messages.length === 0) return 0;

    // Idempotent batch upsert keyed on message_id
    const sb = serviceClient();
    const rows = messages.map((m) => ({
      message_id: m.message_id,
      source_system: m.source_system,
      subject: m.subject,
      from_address: m.from_address,
      to_address: m.to_address,
      body: m.body,
      body_html: m.body_html,
      received_at: m.received_at,
      processed: false,
      metadata: m.metadata,
    }));

    // ignoreDuplicates keeps already-processed rows intact (their processed=true
    // flag, processed_at, classification, parse_error). A new email with a new
    // message_id will insert; a re-seen one is a no-op.
    const { error } = await sb
      .from("chargeback_inbox")
      .upsert(rows, { onConflict: "message_id", ignoreDuplicates: true });

    if (error) {
      this.log.error({ err: error.message, count: rows.length }, "chargeback_inbox upsert failed");
      return 0;
    }

    // Emit chargeback.inbox.staged to signal inbox-monitor that new rows are
    // ready. NOTE: we emit .staged (not .poll) to avoid self-triggering —
    // gmail-ingest subscribes to .poll as an external trigger, so emitting
    // .poll ourselves would create a self-loop.
    await this.emit("chargeback.inbox.staged", {
      trigger: "gmail-ingest",
      staged_count: rows.length,
    });

    return rows.length;
  }

  // -------------------------------------------------------------------------
  // Fixture backend — dev / test
  // -------------------------------------------------------------------------

  private loadFixtures(): StagedMessage[] {
    const dir = resolve(process.cwd(), env.GMAIL_FIXTURE_DIR);
    if (!existsSync(dir)) {
      this.log.warn({ dir }, "fixture directory does not exist — nothing to ingest");
      return [];
    }

    const files = readdirSync(dir).filter((f) => extname(f) === ".json");
    if (files.length === 0) {
      this.log.debug({ dir }, "fixture directory is empty");
      return [];
    }

    const out: StagedMessage[] = [];
    for (const f of files) {
      try {
        const raw = readFileSync(resolve(dir, f), "utf8");
        const fx = JSON.parse(raw) as {
          message_id: string;
          subject: string;
          from_address: string;
          to_address?: string;
          body: string;
          body_html?: string | null;
          received_at: string;
          metadata?: Record<string, unknown>;
        };
        out.push({
          message_id: fx.message_id,
          subject: fx.subject,
          from_address: fx.from_address,
          to_address: fx.to_address ?? null,
          body: fx.body,
          body_html: fx.body_html ?? null,
          received_at: fx.received_at,
          metadata: fx.metadata ?? { fixture_file: f },
          source_system: "fixture",
        });
      } catch (err) {
        this.log.warn({ file: f, err: err instanceof Error ? err.message : String(err) }, "skipping malformed fixture");
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Live Gmail backend
  // -------------------------------------------------------------------------

  private async initGmailClient(): Promise<boolean> {
    const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = env;
    if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
      this.log.error(
        "missing Gmail OAuth creds — see scripts/gmail-oauth-setup.ts to generate GMAIL_REFRESH_TOKEN",
      );
      return false;
    }

    const oauth2 = new google.auth.OAuth2(
      GMAIL_CLIENT_ID,
      GMAIL_CLIENT_SECRET,
    );
    oauth2.setCredentials({
      refresh_token: GMAIL_REFRESH_TOKEN,
      scope: GMAIL_SCOPES.join(" "),
    });

    // Sanity-check the creds work
    try {
      const { token } = await oauth2.getAccessToken();
      if (!token) throw new Error("no access token returned");
    } catch (err) {
      this.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Gmail OAuth refresh failed",
      );
      return false;
    }

    this.gmailClient = google.gmail({ version: "v1", auth: oauth2 });
    this.log.info({ user: env.GMAIL_USER_EMAIL }, "Gmail client authenticated");
    return true;
  }

  private buildSearchQuery(): string {
    // `from:` accepts a single address; combine with OR for multiple senders.
    const fromClause = WATCHED_SENDERS.map((s) => `from:${s}`).join(" OR ");
    return `(${fromClause}) newer_than:${LOOKBACK_DAYS_LIVE}d`;
  }

  private async fetchLive(): Promise<StagedMessage[]> {
    if (!this.gmailClient) return [];
    const query = this.buildSearchQuery();

    const listResp = await this.gmailClient.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
    });
    const msgRefs = listResp.data.messages ?? [];
    if (msgRefs.length === 0) return [];

    this.log.info({ count: msgRefs.length, query }, "Gmail list returned matches");

    // Skip ids already in chargeback_inbox (cheap dedup before fetching bodies)
    const sb = serviceClient();
    const candidateIds = msgRefs.map((m) => `gmail:${m.id!}`);
    const { data: existing } = await sb
      .from("chargeback_inbox")
      .select("message_id")
      .in("message_id", candidateIds);
    const existingSet = new Set((existing ?? []).map((r: { message_id: string }) => r.message_id));

    const toFetch = msgRefs.filter((m) => !existingSet.has(`gmail:${m.id!}`));
    this.log.info({ total: msgRefs.length, new: toFetch.length }, "after dedup");

    const out: StagedMessage[] = [];
    for (const ref of toFetch) {
      try {
        const msgResp = await this.gmailClient.users.messages.get({
          userId: "me",
          id: ref.id!,
          format: "full",
        });
        const staged = this.gmailMessageToStaged(msgResp.data);
        if (staged) out.push(staged);
      } catch (err) {
        this.log.warn(
          { msgId: ref.id, err: err instanceof Error ? err.message : String(err) },
          "failed to fetch message body",
        );
      }
    }
    return out;
  }

  private gmailMessageToStaged(msg: gmail_v1.Schema$Message): StagedMessage | null {
    if (!msg.id) return null;

    const headers = msg.payload?.headers ?? [];
    const hdr = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;

    const subject = hdr("Subject") ?? "(no subject)";
    const from = hdr("From") ?? "(unknown)";
    const to = hdr("To");
    const dateHeader = hdr("Date");
    const receivedAt = dateHeader
      ? new Date(dateHeader).toISOString()
      : new Date(parseInt(msg.internalDate ?? String(Date.now()), 10)).toISOString();

    const { text, html } = this.extractBodies(msg.payload ?? {});

    return {
      message_id: `gmail:${msg.id}`,
      subject,
      from_address: this.extractEmailAddress(from),
      to_address: to ? this.extractEmailAddress(to) : null,
      body: text,
      body_html: html,
      received_at: receivedAt,
      metadata: {
        gmail_msg_id: msg.id,
        gmail_thread_id: msg.threadId,
        gmail_labels: msg.labelIds ?? [],
        snippet: msg.snippet,
      },
      source_system: "gmail",
    };
  }

  private extractBodies(part: gmail_v1.Schema$MessagePart): { text: string; html: string | null } {
    // Walk the MIME tree; return the first text/plain + text/html body found.
    let text = "";
    let html: string | null = null;

    const walk = (p: gmail_v1.Schema$MessagePart): void => {
      if (p.mimeType === "text/plain" && p.body?.data && !text) {
        text = Buffer.from(p.body.data, "base64url").toString("utf8");
      } else if (p.mimeType === "text/html" && p.body?.data && !html) {
        html = Buffer.from(p.body.data, "base64url").toString("utf8");
      }
      for (const child of p.parts ?? []) walk(child);
    };
    walk(part);

    // If we only got HTML, strip tags for the .body plain-text field
    if (!text && html) {
      // TS doesn't narrow `html` inside the closure-mutated scope; cast is safe.
      text = (html as string)
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+\n/g, "\n")
        .replace(/[ \t]+/g, " ")
        .trim();
    }

    return { text: text || "(empty body)", html };
  }

  private extractEmailAddress(raw: string): string {
    // "Friendly Name <email@example.com>" → "email@example.com"
    const m = raw.match(/<([^>]+)>/);
    return (m?.[1] ?? raw).trim().toLowerCase();
  }
}

export default new GmailIngest();
