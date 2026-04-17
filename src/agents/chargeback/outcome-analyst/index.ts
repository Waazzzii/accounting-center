/**
 * outcome-analyst — post-decision analysis engine for the chargeback pipeline.
 *
 * Subscribes to:
 *   chargeback.case.decided              -> per-case postmortem
 *   chargeback.monthly.report.requested  -> monthly performance report
 *   chargeback.quarterly.review.requested -> quarterly strategic review
 *
 * Emits:
 *   chargeback.postmortem.complete  |  chargeback.learning.signal
 *   chargeback.reserve.recomputed   |  report.generated
 */

import Anthropic from "@anthropic-ai/sdk";
import { AgentBase, type AgentIdentity, serviceClient } from "@shared/index.js";

const IDENTITY: AgentIdentity = {
  product: "chargeback",
  slug: "outcome-analyst",
  display_name: "Chargeback Outcome Analyst",
  version: "1.0.0",
};

type LossRootCause = "missing_evidence" | "weak_evidence" | "procedural_deadline_missed" | "legitimate_guest_claim" | "insufficient_rebuttal";
type Row = Record<string, unknown>;
type BucketEntry = { wins: number; losses: number; total: number };

interface Postmortem {
  case_id: string; outcome: string; amount: number; days_to_respond: number | null;
  evidence_completeness: number; exhibits_present: string[]; exhibits_missing: string[];
  impactful_exhibits: string[]; root_cause: LossRootCause | null;
  gap_correlations: Array<{ exhibit: string; correlated_with_loss: boolean }>;
  narrative_summary: string; analyzed_at: string;
}

const ALL_EXHIBITS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
const HIGH_IMPACT: Record<string, string[]> = {
  fraud: ["C", "F", "H"], service_not_rendered: ["F", "G", "E"],
  not_as_described: ["G", "E", "D"], duplicate: ["A", "H"], default: ["A", "B", "E"],
};
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
class OutcomeAnalyst extends AgentBase {
  private unsubs: Array<() => void> = [];
  private ai: Anthropic | null = null;
  private claude() { return (this.ai ??= new Anthropic()); }

  constructor() { super(IDENTITY); }

  protected async onStart(): Promise<void> {
    const sub = (evt: string, fn: (ev: any) => Promise<void>) =>
      this.unsubs.push(this.on({ event_type: evt }, fn));
    sub("chargeback.case.decided", (ev) => this.handleCaseDecided(ev));
    sub("chargeback.monthly.report.requested", (ev) => this.handleMonthlyReport(ev));
    sub("chargeback.quarterly.review.requested", (ev) => this.handleQuarterlyReview(ev));
    this.log.info("outcome analyst online");
  }

  protected async onStop(): Promise<void> {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }

  // -- 1. Per-case postmortem ------------------------------------------------

  private async handleCaseDecided(ev: { event_id: string; correlation_id: string | null; payload: unknown }): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    const { case_id: caseId, decision, decided_at } = ev.payload as { case_id: string; decision: string; decided_at?: string };
    this.log.info({ cid, caseId, decision }, "running postmortem");
    const sb = serviceClient();

    const { data: cd } = await sb.from("chargeback_cases").select("*").eq("case_id", caseId).single();
    if (!cd) { this.log.error({ caseId }, "case not found"); return; }

    const { data: evRow } = await sb.from("chargeback_evidence").select("manifest")
      .eq("case_id", caseId).order("built_at", { ascending: false }).limit(1).single();
    const manifest = evRow?.manifest as { exhibits?: Array<{ exhibit_letter: string; status: string }> } | null;

    const { data: narRow } = await sb.from("chargeback_narratives").select("submitted_at")
      .eq("case_id", caseId).order("created_at", { ascending: false }).limit(1).single();

    const createdAt = new Date(cd.created_at as string);
    const daysToRespond = narRow?.submitted_at
      ? Math.round((new Date(narRow.submitted_at as string).getTime() - createdAt.getTime()) / DAY_MS)
      : null;

    const present = (manifest?.exhibits ?? [])
      .filter((e) => e.status === "success" || e.status === "partial")
      .map((e) => e.exhibit_letter);
    const missing = ALL_EXHIBITS.filter((l) => !present.includes(l));
    const completeness = present.length / ALL_EXHIBITS.length;
    const disputeType = (cd.reason_code as string) ?? "default";
    const impactful = (HIGH_IMPACT[disputeType] ?? HIGH_IMPACT["default"]!).filter((e) => present.includes(e));

    let rootCause: LossRootCause | null = null;
    if (decision === "lost") rootCause = this.classifyLoss(completeness, missing, impactful, cd);

    const postmortem: Postmortem = {
      case_id: caseId, outcome: decision, amount: cd.amount as number,
      days_to_respond: daysToRespond, evidence_completeness: Math.round(completeness * 100),
      exhibits_present: present, exhibits_missing: missing, impactful_exhibits: impactful,
      root_cause: rootCause,
      gap_correlations: ALL_EXHIBITS.map((l) => ({ exhibit: l, correlated_with_loss: decision === "lost" && missing.includes(l) })),
      narrative_summary: `Case ${cd.external_case_id}: ${decision} — $${cd.amount}, ${present.length}/${ALL_EXHIBITS.length} exhibits, ${daysToRespond ?? "N/A"}d`,
      analyzed_at: new Date().toISOString(),
    };

    await sb.from("chargeback_cases").update({ postmortem, postmortem_at: postmortem.analyzed_at }).eq("case_id", caseId);
    await this.emit("chargeback.postmortem.complete", postmortem, { correlation_id: cid });

    // Learning signals for losses with high-impact evidence gaps
    if (decision === "lost") {
      for (const ex of missing.filter((e) => (HIGH_IMPACT[disputeType] ?? []).includes(e))) {
        await this.emit("chargeback.learning.signal", {
          target_agent: "dossier-builder", signal_type: "evidence_gap_correlation",
          exhibit: ex, dispute_type: disputeType, case_id: caseId,
          message: `Exhibit ${ex} missing in lost ${disputeType} case ($${cd.amount}). Prioritize retrieval.`,
        }, { correlation_id: cid });
      }
    }

    await this.audit({
      action: "postmortem.complete", entity_type: "chargeback_case", entity_id: caseId,
      correlation_id: cid, after_state: { outcome: decision, completeness: postmortem.evidence_completeness, root_cause: rootCause },
      reason: postmortem.narrative_summary,
    });
  }

  private classifyLoss(completeness: number, missing: string[], impactful: string[], cd: Row): LossRootCause {
    const deadline = cd.processor_deadline as string | null;
    const decidedAt = cd.decided_at as string | null;
    if (deadline && decidedAt && new Date(decidedAt) > new Date(deadline)) return "procedural_deadline_missed";
    if (completeness < 0.4 || missing.length >= 5) return "missing_evidence";
    const missingHigh = (HIGH_IMPACT[(cd.reason_code as string) ?? "default"] ?? []).filter((e) => missing.includes(e));
    if (missingHigh.length >= 2) return "missing_evidence";
    if (completeness >= 0.7 && impactful.length >= 2) return "insufficient_rebuttal";
    if (completeness >= 0.5) return "weak_evidence";
    return "legitimate_guest_claim";
  }

  // -- 2. Monthly report ----------------------------------------------------

  private async handleMonthlyReport(ev: { event_id: string; correlation_id: string | null; payload: unknown }): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    const period = ((ev.payload as any).period as string) ?? new Date().toISOString().slice(0, 7);
    this.log.info({ cid, period }, "generating monthly report");
    const sb = serviceClient();

    const { data: rows } = await sb.from("chargeback_cases")
      .select("case_id, stage, amount, reason_code, channel, market, property_id, property_name, created_at, decided_at, postmortem")
      .in("stage", ["won", "lost", "accepted"]).gte("decided_at", `${period}-01`).lte("decided_at", this.eom(period));
    const decided = rows ?? [];
    const wins = decided.filter((c) => c.stage === "won");
    const losses = decided.filter((c) => c.stage === "lost");

    const dollarsDefended = wins.reduce((s, c) => s + ((c.amount as number) ?? 0), 0);
    const dollarsLost = losses.reduce((s, c) => s + ((c.amount as number) ?? 0), 0);

    const nums = (field: string) => decided.map((c) => (c.postmortem as Postmortem | null)?.[field as keyof Postmortem]).filter((v): v is number => typeof v === "number");
    const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    // Property breakdown
    const pMap = new Map<string, { n: string; c: number; l: number }>();
    for (const c of decided) { const p = (c.property_id as string) ?? "?"; const e = pMap.get(p) ?? { n: (c.property_name as string) ?? p, c: 0, l: 0 }; e.c++; if (c.stage === "lost") e.l++; pMap.set(p, e); }
    const byProp = [...pMap.entries()].map(([id, v]) => ({ property_id: id, property_name: v.n, count: v.c, losses: v.l })).sort((a, b) => b.losses - a.losses).slice(0, 10);

    // Root cause tally
    const rcMap = new Map<string, number>();
    for (const c of losses) { const rc = (c.postmortem as Postmortem | null)?.root_cause ?? "unknown"; rcMap.set(rc, (rcMap.get(rc) ?? 0) + 1); }
    const topDrivers = [...rcMap.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`);

    // Trailing 90-day reserve inputs
    const { data: trail } = await sb.from("chargeback_cases").select("stage, amount").in("stage", ["won", "lost", "accepted"]).gte("decided_at", new Date(Date.now() - 90 * DAY_MS).toISOString());
    const tc = trail ?? []; const tl = tc.filter((c) => c.stage === "lost");
    const lossRate = tc.length ? Math.round((tl.length / tc.length) * 1000) / 1000 : 0;
    const lossTotal = tl.reduce((s, c) => s + ((c.amount as number) ?? 0), 0);

    const metrics = {
      period, total_decided: decided.length, wins: wins.length, losses: losses.length,
      accepted: decided.filter((c) => c.stage === "accepted").length,
      win_rate: decided.length ? Math.round((wins.length / (wins.length + losses.length || 1)) * 100) : 0,
      dollars_defended: dollarsDefended, dollars_lost: dollarsLost,
      avg_response_days: avg(nums("days_to_respond")), evidence_completeness_avg: avg(nums("evidence_completeness")),
      by_reason_code: this.groupBy(decided, "reason_code"), by_channel: this.groupBy(decided, "channel"),
      by_market: this.groupBy(decided, "market"), by_property: byProp, top_loss_drivers: topDrivers,
      reserve_inputs: { trailing_90d_loss_rate: lossRate, trailing_90d_loss_total: lossTotal },
    };

    const narrative = await this.narrativeCall(
      `Generate a concise monthly chargeback insights narrative (3-5 paragraphs). Focus on actionable takeaways.\n\nMetrics:\n${JSON.stringify(metrics, null, 2)}`,
      1024,
      `Monthly report ${period}: ${metrics.win_rate}% win rate, $${dollarsDefended} defended, $${dollarsLost} lost.`,
    );

    await sb.from("reports_generated").insert({ report_type: "chargeback_monthly", period, metrics, narrative, generated_by: this.identity.slug, generated_at: new Date().toISOString() });
    await this.emit("chargeback.reserve.recomputed", { period, trailing_90d_loss_rate: lossRate, trailing_90d_loss_total: lossTotal }, { correlation_id: cid });
    await this.emit("report.generated", { report_type: "chargeback_monthly", period, metrics_summary: { win_rate: metrics.win_rate, dollars_defended: dollarsDefended, dollars_lost: dollarsLost, total_decided: decided.length } }, { correlation_id: cid });
    this.log.info({ period, winRate: metrics.win_rate, decided: decided.length }, "monthly report generated");
  }

  // -- 3. Quarterly strategic review -----------------------------------------

  private async handleQuarterlyReview(ev: { event_id: string; correlation_id: string | null; payload: unknown }): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    const p = ev.payload as { quarter?: string; year?: number };
    const now = new Date();
    const year = p.year ?? now.getFullYear();
    const quarter = p.quarter ?? `Q${Math.ceil((now.getMonth() + 1) / 3)}`;
    this.log.info({ cid, quarter, year }, "quarterly review");
    const sb = serviceClient();

    const { data: reports } = await sb.from("reports_generated").select("period, metrics, narrative").eq("report_type", "chargeback_monthly").order("period", { ascending: false }).limit(12);
    const yearAgo = new Date(now.getTime() - 365 * DAY_MS).toISOString();
    const { data: allCases } = await sb.from("chargeback_cases").select("case_id, stage, amount, reason_code, channel, market, property_id, property_name, decided_at, postmortem").in("stage", ["won", "lost", "accepted"]).gte("decided_at", yearAgo);
    const cases = allCases ?? [];

    // Trends by quarter
    const qb = new Map<string, BucketEntry & { dollars: number }>();
    for (const c of cases) {
      const d = new Date(c.decided_at as string);
      const q = `${d.getFullYear()}-Q${Math.ceil((d.getMonth() + 1) / 3)}`;
      const b = qb.get(q) ?? { wins: 0, losses: 0, total: 0, dollars: 0 };
      b.total++; if (c.stage === "won") { b.wins++; b.dollars += (c.amount as number) ?? 0; } if (c.stage === "lost") b.losses++;
      qb.set(q, b);
    }

    const hotspots = this.detectHotspots(cases);
    const totalLosses = cases.filter((c) => c.stage === "lost").length;
    const bench = totalLosses <= 2
      ? "On track: meeting the Judy Crane benchmark (<=2 losses per period)."
      : `${totalLosses} losses trailing 12mo. Judy Crane benchmark: 2 losses in 5 years — gap to close.`;

    const narrative = await this.narrativeCall(
      `Generate a quarterly strategic chargeback review (5-8 paragraphs) for ACME House Company. Include trend analysis, pattern detection, operational recommendations, and Judy Crane benchmark comparison.\n\nContext:\n${JSON.stringify({ quarter: `${year}-${quarter}`, trends: Object.fromEntries(qb), hotspots, benchmarkNote: bench, recentReports: (reports ?? []).slice(0, 3), totalCases: cases.length, totalLosses }, null, 2)}`,
      2048,
      `Quarterly review ${year}-${quarter}: ${cases.length} cases, ${totalLosses} losses. ${bench}`,
    );

    await sb.from("reports_generated").insert({ report_type: "chargeback_quarterly", period: `${year}-${quarter}`, metrics: { trends: Object.fromEntries(qb), hotspots, totalLosses, benchmarkNote: bench }, narrative, generated_by: this.identity.slug, generated_at: new Date().toISOString() });
    await this.emit("report.generated", { report_type: "chargeback_quarterly", period: `${year}-${quarter}`, metrics_summary: { total_cases: cases.length, total_losses: totalLosses, benchmark: bench } }, { correlation_id: cid });
    this.log.info({ quarter: `${year}-${quarter}`, cases: cases.length }, "quarterly review generated");
  }

  // -- Shared helpers --------------------------------------------------------

  private async narrativeCall(prompt: string, maxTokens: number, fallback: string): Promise<string> {
    try {
      const r = await this.claude().messages.create({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, messages: [{ role: "user", content: `You are the Chargeback Outcome Analyst for a vacation rental management company. ${prompt}` }] });
      const b = r.content[0]; return b.type === "text" ? b.text : fallback;
    } catch (err) { this.log.error({ err }, "Claude call failed"); return fallback; }
  }

  private groupBy(cases: Row[], field: string): Record<string, BucketEntry> {
    const g: Record<string, BucketEntry> = {};
    for (const c of cases) { const k = (c[field] as string) ?? "unknown"; const e = g[k] ??= { wins: 0, losses: 0, total: 0 }; e.total++; if (c.stage === "won") e.wins++; if (c.stage === "lost") e.losses++; }
    return g;
  }

  private detectHotspots(cases: Row[]): Array<{ dimension: string; value: string; count: number; loss_rate: number }> {
    const out: Array<{ dimension: string; value: string; count: number; loss_rate: number }> = [];
    for (const dim of ["property_id", "market", "channel"]) {
      const m = new Map<string, { t: number; l: number }>();
      for (const c of cases) { const k = (c[dim] as string) ?? "unknown"; const e = m.get(k) ?? { t: 0, l: 0 }; e.t++; if (c.stage === "lost") e.l++; m.set(k, e); }
      for (const [v, s] of m) if (s.t >= 3 && s.l / s.t > 0.5) out.push({ dimension: dim, value: v, count: s.t, loss_rate: Math.round((s.l / s.t) * 100) });
    }
    return out.sort((a, b) => b.loss_rate - a.loss_rate);
  }

  private eom(period: string): string {
    const [y, m] = period.split("-").map(Number);
    return `${period}-${String(new Date(y!, m!, 0).getDate()).padStart(2, "0")}`;
  }
}

export default new OutcomeAnalyst();
