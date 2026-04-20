/**
 * gmail-oauth-setup.ts — one-time CLI helper to generate a Gmail refresh token.
 *
 * Prerequisites (Google Cloud Console steps — do these once, per workspace):
 *   1. Go to https://console.cloud.google.com/ → select or create a project
 *      (suggested name: "acme-accounting-center").
 *   2. APIs & Services → Library → search "Gmail API" → Enable.
 *   3. APIs & Services → OAuth consent screen:
 *        - User type: Internal (since accounting@acmehouseco.com is Workspace)
 *        - App name: "ACME Accounting Center"
 *        - Add scope: https://www.googleapis.com/auth/gmail.readonly
 *        - Test users: accounting@acmehouseco.com
 *   4. APIs & Services → Credentials → Create credentials → OAuth client ID:
 *        - Application type: Desktop app
 *        - Name: "Accounting Center Ingest"
 *        - Copy the Client ID + Client Secret
 *
 * Then in .env:
 *   GMAIL_CLIENT_ID=<paste>
 *   GMAIL_CLIENT_SECRET=<paste>
 *
 * Run this script:
 *   npx tsx scripts/gmail-oauth-setup.ts
 *
 * What it does:
 *   1. Prints a URL. Open it in a browser LOGGED IN AS accounting@acmehouseco.com.
 *   2. Click Allow. Google redirects to localhost:53682/oauth/callback.
 *   3. This script catches the callback, exchanges the code for a refresh token,
 *      and prints the refresh token.
 *   4. Paste the refresh token into .env as GMAIL_REFRESH_TOKEN.
 *   5. Flip GMAIL_INGEST_MODE from "fixture" → "live".
 *
 * The refresh token is long-lived (does not expire unless revoked) — you only
 * do this once.
 */
import { createServer } from "node:http";
import { URL } from "node:url";
import { google } from "googleapis";
import { env } from "@shared/env.js";

const REDIRECT_PORT = 53682;
const REDIRECT_PATH = "/oauth/callback";
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

async function main() {
  const clientId = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("❌ GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env first.");
    console.error("   See the header comment of this file for how to get them.");
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",        // force refresh_token issuance
    prompt: "consent",              // force consent screen (ensures refresh_token comes back)
    scope: SCOPES,
    login_hint: env.GMAIL_USER_EMAIL,
  });

  console.log("\n=========================================================");
  console.log("STEP 1 — Open this URL in a browser logged in as");
  console.log(`         ${env.GMAIL_USER_EMAIL}:`);
  console.log("=========================================================\n");
  console.log(authUrl);
  console.log("\n(Waiting for the redirect to localhost...)\n");

  const code = await new Promise<string>((resolvePromise, rejectPromise) => {
    const server = createServer((req, res) => {
      if (!req.url) return;
      const u = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (u.pathname !== REDIRECT_PATH) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const c = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      if (err) {
        res.writeHead(400);
        res.end(`oauth error: ${err}`);
        server.close();
        rejectPromise(new Error(err));
        return;
      }
      if (!c) {
        res.writeHead(400);
        res.end("missing code");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body style="font-family:system-ui;padding:40px">
        <h1>✅ Authorized</h1>
        <p>You can close this tab. Return to the terminal for your refresh token.</p>
      </body></html>`);
      server.close();
      resolvePromise(c);
    });

    server.listen(REDIRECT_PORT, () => {
      // ready to receive the redirect
    });
    server.on("error", rejectPromise);
  });

  console.log("✅ Got authorization code. Exchanging for tokens...\n");

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    console.error("❌ No refresh_token in response. This can happen if you've already");
    console.error("   authorized this client before. To force re-issue:");
    console.error("   https://myaccount.google.com/permissions → revoke ACME Accounting Center → retry.");
    process.exit(1);
  }

  console.log("=========================================================");
  console.log("STEP 2 — Paste this into your .env as GMAIL_REFRESH_TOKEN:");
  console.log("=========================================================\n");
  console.log(tokens.refresh_token);
  console.log("\n=========================================================");
  console.log("STEP 3 — Flip GMAIL_INGEST_MODE=fixture → GMAIL_INGEST_MODE=live");
  console.log("=========================================================\n");
  console.log("Then restart the gmail-ingest agent. Done.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ OAuth setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
