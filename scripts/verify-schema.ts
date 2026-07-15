/**
 * verify-schema.ts — sanity-check every expected table exists on the remote DB.
 */
import { serviceClient } from "@shared/supabase.js";

const sb = serviceClient();

const TABLES = [
  // backbone
  "audit_log", "audit_chain_verification", "events",
  "kpi_definitions", "kpi_snapshots", "kpi_formula_versions",
  "orchestrator_routing_rules", "orchestrator_routing_log", "orchestrator_flags", "approvals",
  "health_state", "health_samples", "health_daily_rollup", "health_incidents",
  "alert_deliveries", "alert_fingerprints", "alert_suppressions", "on_call_schedule", "alert_digest_items",
  "close_cycles", "close_steps", "close_step_transitions",
  "reports_generated", "report_subscriptions", "report_deliveries",
  "tile_definitions", "tile_state", "tile_subscription_map", "tile_refresh_log",
  // trustsync
  "trustsync_candidate_stays", "trustsync_transfers", "trustsync_operating_transfers", "trustsync_variance_flags", "trustsync_daily_rollup",
  // otaauditor
  "ota_payouts", "bank_deposits", "ota_matches", "ota_unmatched", "ota_gl_postings",
  // revpost
  "revpost_decompositions", "journal_entries", "je_lines", "je_post_attempts", "revpost_trial_balance", "month_end_accruals", "ramp_transactions",
  // chargeback
  "chargeback_cases", "chargeback_evidence", "chargeback_responses", "chargeback_outcomes", "chargeback_reserves",
  // utility
  "utility_bills", "utility_owner_preferences", "utility_variance_flags", "utility_credits_applied",
];

const missing: string[] = [];
let present = 0;
const warnings: string[] = [];

for (const t of TABLES) {
  const { error } = await sb.from(t).select("*", { count: "exact", head: true });
  if (error) {
    // Postgres "relation does not exist" = 42P01
    if ((error as { code?: string }).code === "42P01") missing.push(t);
    else warnings.push(`${t}: ${error.message} (${(error as { code?: string }).code ?? "?"})`);
  } else {
    present++;
  }
}

console.log(`present: ${present}/${TABLES.length}`);
if (warnings.length) {
  console.log(`\nwarnings (${warnings.length}):`);
  for (const w of warnings) console.log(`  - ${w}`);
}
if (missing.length) {
  console.log(`\nmissing (${missing.length}):`);
  for (const m of missing) console.log(`  - ${m}`);
  process.exit(1);
}
console.log("\nschema OK");
