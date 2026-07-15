/**
 * env.ts — runtime environment loader + validator.
 *
 * All runtime config comes through here. Agents MUST NOT read process.env
 * directly; they import the typed `env` object so missing values fail fast.
 */

import { config } from "dotenv";
import { z } from "zod";

// override: true — ensures local .env values beat stale/empty shell vars.
// In production we never ship a .env file, so real process.env always wins.
config({ override: true });

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_DB_URL: z.string().url().optional(),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-5-20251101"),

  // MCP endpoints (optional at boot; agents validate what they need)
  COLUMN_BANK_API_KEY: z.string().optional(),
  COLUMN_BANK_API_URL: z.string().url().optional(),
  COLUMN_BANK_PLATFORM_ENTITY_ID: z.string().optional(),
  COLUMN_BANK_WEBHOOK_SECRET: z.string().optional(),
  COLUMN_BANK_MODE: z.enum(["live", "sandbox", "off"]).default("off"),
  STREAMLINE_API_KEY: z.string().optional(),
  STREAMLINE_API_SECRET: z.string().optional(),
  STREAMLINE_API_URL: z.string().url().optional(),
  INTACCT_API_URL: z.string().url().optional(),
  INTACCT_COMPANY_ID: z.string().optional(),
  INTACCT_USER_ID: z.string().optional(),
  INTACCT_USER_PASSWORD: z.string().optional(),
  INTACCT_SENDER_ID: z.string().optional(),
  INTACCT_SENDER_PASSWORD: z.string().optional(),
  AIRBNB_AZ_EMAIL: z.string().optional(),
  AIRBNB_AZ_PASSWORD: z.string().optional(),
  STRIPE_API_KEY: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  // Gmail — OAuth2 "Desktop" app flow
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  GMAIL_USER_EMAIL: z.string().email().default("accounting@acmehouseco.com"),
  GMAIL_INGEST_MODE: z.enum(["live", "fixture", "off"]).default("fixture"),
  GMAIL_FIXTURE_DIR: z.string().default("fixtures/gmail-prod"),

  // Ops
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3100),
  ORCHESTRATOR_TICK_SECONDS: z.coerce.number().int().positive().default(60),

  // Safety rails — every agent checks these.
  // NOTE: z.coerce.boolean() treats the string "false" as TRUTHY (any non-empty
  // string coerces to true). Use explicit string matching so KILL_SWITCH_GLOBAL=false
  // actually disables the kill switch.
  KILL_SWITCH_GLOBAL: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  MATURITY_DEFAULT: z.enum(["shadow", "assist", "accelerated"]).default("shadow"),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
