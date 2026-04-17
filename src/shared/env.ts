/**
 * env.ts — runtime environment loader + validator.
 *
 * All runtime config comes through here. Agents MUST NOT read process.env
 * directly; they import the typed `env` object so missing values fail fast.
 */

import { config } from "dotenv";
import { z } from "zod";

config();

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
  STREAMLINE_API_KEY: z.string().optional(),
  STREAMLINE_API_URL: z.string().url().optional(),
  INTACCT_API_USER: z.string().optional(),
  INTACCT_API_PASSWORD: z.string().optional(),
  INTACCT_COMPANY_ID: z.string().optional(),
  STRIPE_API_KEY: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),

  // Ops
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3100),
  ORCHESTRATOR_TICK_SECONDS: z.coerce.number().int().positive().default(60),

  // Safety rails — every agent checks these
  KILL_SWITCH_GLOBAL: z.coerce.boolean().default(false),
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
