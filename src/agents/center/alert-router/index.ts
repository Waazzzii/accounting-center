/**
 * alert-router — receives alert-worthy events, deduplicates, checks
 * suppressions, resolves routing policies + on-call overrides, respects
 * quiet hours, dispatches delivery records, and manages escalation timers.
 *
 * Phase 1 dispatch = emit `alert.delivered` event. Actual Slack/email/SMS
 * integration arrives later via MCP tools.
 */

import {
  AgentBase,
  type AgentIdentity,
  serviceClient,
  thresholds,
} from "@shared/index.js";
import { sha256Hex } from "@shared/hash.js";
import { roleMatrix, type RoleDefinition } from "@shared/config.js";
import type { Severity } from "@shared/types.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const IDENTITY: AgentIdentity = {
  product: "center",
  slug: "alert-router",
  display_name: "Alert Router",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AlertEvent {
  event_id: string;
  event_type: string;
  source_product: string;
  source_agent: string;
  correlation_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
}

interface AlertThresholds {
  dedup_windows_seconds: Record<Severity, number>;
  escalation: {
    enabled: boolean;
    level_1_minutes: number;
    level_2_minutes: number;
    max_level: number;
  };
}

interface RoutingPolicy {
  id: string;
  product: string;
  category: string;
  min_severity: Severity;
  primary_role: string;
  cc_roles: string[];
  ack_required: boolean;
  escalation_minutes: number;
}

interface OnCallRow {
  role_id: string;
  override_role_id: string;
  starts_at: string;
  ends_at: string;
}

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  warn: 1,
  error: 2,
  critical: 3,
};

const SUBSCRIBED_EVENTS = [
  "alert.raised",
  "health.state.changed",
  "trustsync.breach.detected",
  "center.approval.requested",
  "close.gate.failed",
];

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class AlertRouter extends AgentBase {
  private unsubscribers: (() => void)[] = [];
  private escalationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    super(IDENTITY);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    // Subscribe to named alert-worthy events.
    const unsub1 = this.on(
      { event_type: SUBSCRIBED_EVENTS },
      (ev) => void this.handleAlert(ev as AlertEvent),
    );
    this.unsubscribers.push(unsub1);

    // Subscribe to any event with severity error/critical (catch-all).
    const unsub2 = this.on(
      { event_type: "*" },
      (ev) => {
        const payload = (ev.payload ?? {}) as Record<string, unknown>;
        const severity = (payload.severity ?? "info") as Severity;
        if (severity === "error" || severity === "critical") {
          // Avoid double-handling named events already in the list.
          if (!SUBSCRIBED_EVENTS.includes(ev.event_type)) {
            void this.handleAlert(ev as AlertEvent);
          }
        }
      },
    );
    this.unsubscribers.push(unsub2);

    // Subscribe to ack events to clear escalation timers.
    const unsub3 = this.on(
      { event_type: "alert.acked" },
      (ev) => {
        const payload = (ev.payload ?? {}) as Record<string, unknown>;
        const deliveryId = payload.delivery_id as string | undefined;
        if (deliveryId) this.clearEscalation(deliveryId);
      },
    );
    this.unsubscribers.push(unsub3);

    this.log.info("alert-router online — listening for alert-worthy events");
  }

  protected async onStop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    for (const timer of this.escalationTimers.values()) clearTimeout(timer);
    this.escalationTimers.clear();
    this.log.info("alert-router stopped");
  }

  // -------------------------------------------------------------------------
  // Main alert pipeline
  // -------------------------------------------------------------------------

  private async handleAlert(ev: AlertEvent): Promise<void> {
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const product = (payload.product as string) ?? ev.source_product;
    const category = (payload.category as string) ?? ev.event_type;
    const entityId = (payload.entity_id as string) ?? ev.event_id;
    const severity = this.normalizeSeverity(payload.severity);
    const summary = (payload.summary as string) ?? ev.event_type;
    const now = new Date();

    // 2a. Compute fingerprint.
    const summaryKernel = summary.slice(0, 80).toLowerCase().replace(/\s+/g, "_");
    const fingerprint = sha256Hex(
      [product, category, entityId, severity, summaryKernel].join("|"),
    );

    const cfg = this.alertConfig();
    const sb = serviceClient();

    // 2b. Dedup check.
    const dedupWindowSec = cfg.dedup_windows_seconds[severity] ?? 300;
    const dedupCutoff = new Date(now.getTime() - dedupWindowSec * 1_000).toISOString();

    const { data: recentDups } = await sb
      .from("alert_deliveries")
      .select("id")
      .eq("fingerprint", fingerprint)
      .gte("created_at", dedupCutoff)
      .neq("status", "deduped")
      .limit(1);

    if (recentDups && recentDups.length > 0) {
      await sb.from("alert_deliveries").insert({
        fingerprint,
        event_id: ev.event_id,
        product,
        category,
        entity_id: entityId,
        severity,
        summary,
        status: "deduped",
        created_at: now.toISOString(),
      });
      this.log.debug({ fingerprint, severity }, "alert deduped");
      return;
    }

    // 2c. Suppression check (critical always breaks through).
    if (severity !== "critical") {
      const { data: suppressions } = await sb
        .from("alert_suppressions")
        .select("id")
        .or(
          `fingerprint.eq.${fingerprint},and(product.eq.${product},category.eq.${category})`,
        )
        .lte("starts_at", now.toISOString())
        .or(`ends_at.is.null,ends_at.gte.${now.toISOString()}`)
        .eq("active", true)
        .limit(1);

      if (suppressions && suppressions.length > 0) {
        this.log.info({ fingerprint, severity }, "alert suppressed");
        await sb.from("alert_deliveries").insert({
          fingerprint,
          event_id: ev.event_id,
          product,
          category,
          entity_id: entityId,
          severity,
          summary,
          status: "suppressed",
          created_at: now.toISOString(),
        });
        return;
      }
    }

    // 2d. Routing policy lookup.
    const { data: policies } = await sb
      .from("alert_routing_policies")
      .select("*")
      .eq("product", product)
      .eq("category", category)
      .order("min_severity", { ascending: false });

    const policy = (policies ?? []).find(
      (p: Record<string, unknown>) =>
        SEVERITY_ORDER[severity] >= SEVERITY_ORDER[(p.min_severity as Severity) ?? "info"],
    ) as RoutingPolicy | undefined;

    const primaryRole = policy?.primary_role ?? "coo";
    const ccRoles = policy?.cc_roles ?? [];
    const ackRequired = policy?.ack_required ?? severity === "critical" || severity === "error";
    const escalationMinutes = policy?.escalation_minutes ?? cfg.escalation.level_1_minutes;

    // 2e. On-call override.
    const resolvedPrimary = await this.resolveOnCall(primaryRole, now);

    // 2f. Quiet hours check.
    const held = this.isInQuietHours(resolvedPrimary, now) && severity !== "critical";

    // 2g. Dispatch: write delivery record.
    const deliveryRow = {
      fingerprint,
      event_id: ev.event_id,
      correlation_id: ev.correlation_id,
      product,
      category,
      entity_id: entityId,
      severity,
      summary,
      detail: payload,
      primary_role: resolvedPrimary,
      cc_roles: ccRoles,
      ack_required: ackRequired,
      escalation_minutes: escalationMinutes,
      escalation_level: 0,
      status: held ? "held" : "delivered",
      held_until: held ? this.quietHoursEnd(resolvedPrimary, now) : null,
      created_at: now.toISOString(),
      delivered_at: held ? null : now.toISOString(),
    };

    const { data: inserted } = await sb
      .from("alert_deliveries")
      .insert(deliveryRow)
      .select("id")
      .single();

    const deliveryId = (inserted?.id as string) ?? fingerprint;

    if (!held) {
      // Phase 1 dispatch: emit event (Slack/email integration comes later).
      await this.emit(
        "alert.delivered",
        {
          delivery_id: deliveryId,
          fingerprint,
          product,
          category,
          entity_id: entityId,
          severity,
          summary,
          primary_role: resolvedPrimary,
          cc_roles: ccRoles,
          ack_required: ackRequired,
        },
        {
          correlation_id: ev.correlation_id ?? undefined,
          causation_id: ev.event_id,
          idempotency_key: `alert-delivery:${deliveryId}`,
        },
      );

      this.log.info(
        { deliveryId, severity, primaryRole: resolvedPrimary },
        "alert dispatched",
      );
    } else {
      this.log.info(
        { deliveryId, severity, heldUntil: deliveryRow.held_until },
        "alert held for quiet hours",
      );
    }

    // 2h. Escalation timer.
    if (ackRequired && !held && cfg.escalation.enabled) {
      this.startEscalation(deliveryId, {
        fingerprint,
        product,
        category,
        entityId,
        severity,
        summary,
        primaryRole: resolvedPrimary,
        escalationMinutes,
        currentLevel: 0,
        maxLevel: cfg.escalation.max_level,
        correlationId: ev.correlation_id,
        eventId: ev.event_id,
      });
    }

    await this.audit({
      action: "alert.routed",
      entity_type: "alert_deliveries",
      entity_id: deliveryId,
      severity,
      after_state: { status: deliveryRow.status, primaryRole: resolvedPrimary },
      reason: `${severity} alert for ${category} routed to ${resolvedPrimary}`,
    });
  }

  // -------------------------------------------------------------------------
  // On-call resolution
  // -------------------------------------------------------------------------

  private async resolveOnCall(roleId: string, now: Date): Promise<string> {
    const sb = serviceClient();
    const { data } = await sb
      .from("on_call_schedule")
      .select("override_role_id")
      .eq("role_id", roleId)
      .lte("starts_at", now.toISOString())
      .gte("ends_at", now.toISOString())
      .limit(1);

    const row = data?.[0] as OnCallRow | undefined;
    return row?.override_role_id ?? roleId;
  }

  // -------------------------------------------------------------------------
  // Quiet hours
  // -------------------------------------------------------------------------

  private getRoleDef(roleId: string): RoleDefinition | undefined {
    return roleMatrix().roles.find((r) => r.role_id === roleId);
  }

  private isInQuietHours(roleId: string, now: Date): boolean {
    const role = this.getRoleDef(roleId);
    if (!role?.quiet_hours_start || !role?.quiet_hours_end) return false;

    const localHour = this.localHour(now, role.local_tz ?? "America/Phoenix");
    const start = parseInt(role.quiet_hours_start.split(":")[0], 10);
    const end = parseInt(role.quiet_hours_end.split(":")[0], 10);

    // Handle overnight windows (e.g. 22:00 - 07:00).
    if (start > end) {
      return localHour >= start || localHour < end;
    }
    return localHour >= start && localHour < end;
  }

  private quietHoursEnd(roleId: string, now: Date): string | null {
    const role = this.getRoleDef(roleId);
    if (!role?.quiet_hours_end) return null;

    const endHour = parseInt(role.quiet_hours_end.split(":")[0], 10);
    const endMin = parseInt(role.quiet_hours_end.split(":")[1] ?? "0", 10);

    // Approximate: advance to the next occurrence of quiet_hours_end.
    const target = new Date(now);
    target.setHours(endHour, endMin, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target.toISOString();
  }

  private localHour(date: Date, tz: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: tz,
    }).formatToParts(date);
    const hourPart = parts.find((p) => p.type === "hour");
    return parseInt(hourPart?.value ?? "0", 10);
  }

  // -------------------------------------------------------------------------
  // Escalation
  // -------------------------------------------------------------------------

  private startEscalation(
    deliveryId: string,
    ctx: {
      fingerprint: string;
      product: string;
      category: string;
      entityId: string;
      severity: Severity;
      summary: string;
      primaryRole: string;
      escalationMinutes: number;
      currentLevel: number;
      maxLevel: number;
      correlationId: string | null;
      eventId: string;
    },
  ): void {
    if (ctx.currentLevel >= ctx.maxLevel) return;

    const timer = setTimeout(
      () => void this.escalate(deliveryId, ctx),
      ctx.escalationMinutes * 60 * 1_000,
    );
    this.escalationTimers.set(deliveryId, timer);
  }

  private async escalate(
    deliveryId: string,
    ctx: {
      fingerprint: string;
      product: string;
      category: string;
      entityId: string;
      severity: Severity;
      summary: string;
      primaryRole: string;
      escalationMinutes: number;
      currentLevel: number;
      maxLevel: number;
      correlationId: string | null;
      eventId: string;
    },
  ): Promise<void> {
    this.escalationTimers.delete(deliveryId);

    // Check if already acked.
    const sb = serviceClient();
    const { data } = await sb
      .from("alert_deliveries")
      .select("status")
      .eq("id", deliveryId)
      .single();

    if ((data as Record<string, unknown>)?.status === "acked") return;

    const nextLevel = ctx.currentLevel + 1;
    const role = this.getRoleDef(ctx.primaryRole);
    const escalateTo = role?.escalates_to ?? "coo";

    // Update delivery record.
    await sb
      .from("alert_deliveries")
      .update({ escalation_level: nextLevel, status: "escalated" })
      .eq("id", deliveryId);

    // Emit escalated alert.
    await this.emit(
      "alert.delivered",
      {
        delivery_id: deliveryId,
        fingerprint: ctx.fingerprint,
        product: ctx.product,
        category: ctx.category,
        entity_id: ctx.entityId,
        severity: ctx.severity,
        summary: `[ESCALATION L${nextLevel}] ${ctx.summary}`,
        primary_role: escalateTo,
        cc_roles: [ctx.primaryRole],
        ack_required: true,
        escalation_level: nextLevel,
      },
      {
        correlation_id: ctx.correlationId ?? undefined,
        causation_id: ctx.eventId,
        idempotency_key: `alert-escalation:${deliveryId}:L${nextLevel}`,
      },
    );

    this.log.warn(
      { deliveryId, level: nextLevel, escalateTo },
      "alert escalated — no ack received",
    );

    // Chain the next escalation level.
    const cfg = this.alertConfig();
    this.startEscalation(deliveryId, {
      ...ctx,
      primaryRole: escalateTo,
      escalationMinutes: cfg.escalation.level_2_minutes,
      currentLevel: nextLevel,
    });
  }

  private clearEscalation(deliveryId: string): void {
    const timer = this.escalationTimers.get(deliveryId);
    if (timer) {
      clearTimeout(timer);
      this.escalationTimers.delete(deliveryId);
      this.log.info({ deliveryId }, "escalation timer cleared (acked)");
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private normalizeSeverity(raw: unknown): Severity {
    const s = String(raw ?? "info").toLowerCase();
    if (s === "critical" || s === "error" || s === "warn" || s === "info") {
      return s as Severity;
    }
    return "info";
  }

  private alertConfig(): AlertThresholds {
    return thresholds().alerts as unknown as AlertThresholds;
  }
}

export default new AlertRouter();
