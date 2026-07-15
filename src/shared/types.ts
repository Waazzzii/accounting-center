/**
 * types.ts — shared domain types.
 *
 * These mirror the Postgres enums and core entity shapes. When the
 * `db:types` script runs (`supabase gen types`), it writes a fuller
 * Database type to `./database.types.ts`. This file carries hand-curated
 * domain types that ride on top of those generated types.
 */

export type ProductCode =
  | "trustsync"
  | "otaauditor"
  | "revpost"
  | "chargeback"
  | "utility"
  | "center";

export type RegionCode = "socal" | "arizona" | "all";

export type MarketCode =
  | "coachella"
  | "central_coast"
  | "orange_county"
  | "phoenix"
  | "tucson"
  | "sedona_flagstaff"
  | "unknown";

export type Severity = "info" | "warn" | "error" | "critical";

export type HealthState = "green" | "yellow" | "red" | "unknown";

export type MaturityMode =
  | "shadow"
  | "assist"
  | "accelerated"
  | "auto_repeat"
  | "auto_trusted"
  | "human_all"
  | "building_trust"
  | "opt_out";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "auto_approved"
  | "expired";

export type ActorType = "ai_agent" | "human" | "system" | "external" | "webhook";

export type EventStatus =
  | "queued"
  | "dispatched"
  | "completed"
  | "failed"
  | "deduped"
  | "dead_lettered";

/** The canonical event envelope written to the `events` table. */
export interface EventEnvelope<P = unknown, M = Record<string, unknown>> {
  event_id?: string;
  event_type: string;
  source_product: ProductCode;
  source_agent: string;
  correlation_id?: string;
  causation_id?: string;
  idempotency_key?: string;
  payload: P;
  metadata?: M;
  region?: RegionCode;
}

/** Minimal audit-log insert shape. Hash chain computed by trigger. */
export interface AuditRecord {
  actor_type: ActorType;
  actor_id: string;
  actor_display?: string;
  product: ProductCode;
  action: string;
  entity_type: string;
  entity_id: string;
  correlation_id?: string;
  event_id?: string;
  severity?: Severity;
  before_state?: unknown;
  after_state?: unknown;
  diff?: unknown;
  reason?: string;
  evidence?: unknown;
  region?: RegionCode;
}

/** Approval request shape written by agents before acting on money-in-motion. */
export interface ApprovalRequest {
  requesting_agent: string;
  product: ProductCode;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  detail: Record<string, unknown>;
  suggested_action: string;
  risk_level?: Severity;
  required_approver_role: string;
  correlation_id?: string;
  event_id?: string;
  dollar_impact?: number;
  auto_approve_at?: Date;
  expires_at: Date;
  region?: RegionCode;
}
