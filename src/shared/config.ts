/**
 * config.ts — YAML config loader.
 *
 * Loads events.yaml, kpi-definitions.yaml, role-matrix.yaml, routing-rules.yaml,
 * and thresholds.yaml once at boot and exposes typed accessors.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const CONFIG_DIR = resolve(process.cwd(), "config");

function loadYaml<T>(filename: string): T {
  const path = resolve(CONFIG_DIR, filename);
  return parse(readFileSync(path, "utf8")) as T;
}

// ---------------------------------------------------------------------------
// Events catalog
// ---------------------------------------------------------------------------
export interface EventDefinition {
  type: string;
  source: string;
  version: number;
  description: string;
  payload?: string;
  consumers?: string[];
  idempotency?: string;
  severity?: string;
}

export interface EventsCatalog {
  version: number;
  schema_version: number;
  events: EventDefinition[];
}

let _events: EventsCatalog | null = null;
export function eventsCatalog(): EventsCatalog {
  if (!_events) _events = loadYaml<EventsCatalog>("events.yaml");
  return _events;
}

export function assertEventType(type: string): void {
  const known = eventsCatalog().events.some((e) => e.type === type);
  if (!known) throw new Error(`Unknown event_type "${type}". Add it to config/events.yaml.`);
}

// ---------------------------------------------------------------------------
// KPI definitions
// ---------------------------------------------------------------------------
export interface KpiDefinition {
  id: string;
  version: number;
  display_name: string;
  tier: "operational" | "tactical" | "strategic";
  unit: string;
  cadence: string;
  product: string;
  owner_role: string;
  formula_language?: string;
  formula: string;
  source_tables?: string[];
  target_direction: "higher_is_better" | "lower_is_better" | "band";
  target_green?: number;
  target_yellow?: number;
  band_low?: number;
  band_high?: number;
  description?: string;
}

export interface KpiCatalog {
  version: number;
  kpis: KpiDefinition[];
}

let _kpis: KpiCatalog | null = null;
export function kpiCatalog(): KpiCatalog {
  if (!_kpis) _kpis = loadYaml<KpiCatalog>("kpi-definitions.yaml");
  return _kpis;
}

// ---------------------------------------------------------------------------
// Role matrix
// ---------------------------------------------------------------------------
export interface RoleDefinition {
  role_id: string;
  display_name: string;
  email: string;
  slack_user_id?: string;
  sms_number?: string | null;
  escalates_to?: string | null;
  escalation_minutes?: number;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  local_tz?: string;
  accepts_critical_during_quiet?: boolean;
  enabled?: boolean;
}

export interface RoleMatrix {
  version: number;
  roles: RoleDefinition[];
}

let _roles: RoleMatrix | null = null;
export function roleMatrix(): RoleMatrix {
  if (!_roles) _roles = loadYaml<RoleMatrix>("role-matrix.yaml");
  return _roles;
}

// ---------------------------------------------------------------------------
// Routing rules
// ---------------------------------------------------------------------------
export interface RoutingRule {
  rule_id: string;
  description?: string;
  priority: number;
  match_event_type?: string;
  match_source?: string;
  target_product: string;
  target_agent: string;
  required_approvals?: number;
  timeout_seconds?: number;
  max_retries?: number;
  continue_on_match?: boolean;
  enabled?: boolean;
}

export interface RoutingRules {
  version: number;
  rules: RoutingRule[];
}

let _routing: RoutingRules | null = null;
export function routingRules(): RoutingRules {
  if (!_routing) _routing = loadYaml<RoutingRules>("routing-rules.yaml");
  return _routing;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------
export interface Thresholds {
  version: number;
  health: Record<string, unknown>;
  alerts: Record<string, unknown>;
  close: Record<string, unknown>;
  trustsync: Record<string, unknown>;
  otaauditor: Record<string, unknown>;
  revpost: Record<string, unknown>;
  chargeback: Record<string, unknown>;
  utility: Record<string, unknown>;
  events: Record<string, unknown>;
  kpi: Record<string, unknown>;
}

let _thresh: Thresholds | null = null;
export function thresholds(): Thresholds {
  if (!_thresh) _thresh = loadYaml<Thresholds>("thresholds.yaml");
  return _thresh;
}

/** Force reload (tests, long-running servers). */
export function reloadConfig(): void {
  _events = null;
  _kpis = null;
  _roles = null;
  _routing = null;
  _thresh = null;
}
