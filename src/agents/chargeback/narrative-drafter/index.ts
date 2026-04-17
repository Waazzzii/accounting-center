/**
 * narrative-drafter — uses Claude to draft chargeback dispute response
 * narratives in "Judy Crane voice": factual, chronological, unemotional.
 *
 * Subscribes to:
 *   chargeback.dossier.ready — dossier manifest is complete, draft narrative
 *
 * Emits:
 *   chargeback.narrative.ready   — draft available for human review (ALWAYS)
 *   chargeback.narrative.blocked — evidence contradiction detected, draft refused
 *
 * The narrative is the cover letter a chargeback reviewer reads start-to-finish.
 * Judy Crane's style: 2 losses in 5 years. Never editorialize. Cite exhibits
 * by letter. Silence > unsupported assertion.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  AgentBase,
  type AgentIdentity,
  serviceClient,
} from "@shared/index.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const IDENTITY: AgentIdentity = {
  product: "chargeback",
  slug: "narrative-drafter",
  display_name: "Chargeback Narrative Drafter",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

type ExhibitStatus = "success" | "partial" | "failed" | "pending_human";

interface ExhibitResult {
  status: ExhibitStatus;
  source: string;
  exhibit_letter: string;
  exhibit_title: string;
  artifacts: string[];
  reason?: string;
}

interface DossierManifest {
  dossier_key: string;
  case_id: string;
  reservation_id: string;
  dispute_reason: string;
  exhibits: ExhibitResult[];
  exhibit_order: string[];
  gaps: ExhibitResult[];
  critical_failure: boolean;
  retrieval_log: Array<{ exhibit: string; status: ExhibitStatus; ms: number }>;
  built_at: string;
}

interface CaseRecord {
  case_id: string;
  source: string;
  external_case_id: string;
  amount: number;
  currency: string;
  reason: string;
  guest_name: string;
  charge_date: string;
  evidence_due_at: string;
  reservation_ref: string | null;
  property_id: string | null;
  stage: string;
}

interface ReservationMatch {
  reservation_id: string;
  guest_name: string;
  check_in: string;
  check_out: string;
  total_amount: number;
  channel: string | null;
  property_id: string | null;
  property_name: string | null;
}

interface NarrativeDraft {
  case_id: string;
  dossier_key: string;
  reason_code: string;
  processor: string;
  narrative: {
    opening: string;
    rebuttal: string;
    supporting: string;
    close: string;
  };
  full_text: string;
  word_count: number;
  exhibits_cited: string[];
  draft_notes: string;
  drafted_at: string;
  token_usage: { input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const MAX_WORDS_STANDARD = 600;
const MAX_WORDS_HIGH_VALUE = 900;
const HIGH_VALUE_THRESHOLD = 5000;

/** Phrases that Judy Crane would never use. */
const BANNED_PHRASES = [
  "we apologize",
  "sorry for any",
  "regrettably",
  "unfortunately",
  "clearly",
  "obviously",
  "we believe",
  "it appears",
  "likely",
  "we sincerely hope",
  "please consider",
];

const SYSTEM_PROMPT = `You are writing a chargeback dispute response for a vacation rental management company. Your voice is factual, chronological, unemotional. Never editorialize. Cite exhibits by letter.

Voice rules — follow these exactly:
- FACTUAL: Every sentence states something the records show. If the records don't show it, it doesn't go in.
- CHRONOLOGICAL: Events are presented in the order they happened.
- UNEMOTIONAL: No adjectives of judgment. No "clearly," "obviously," "regrettably," "unfortunately."
- UN-APOLOGETIC: Never "we apologize for any confusion." Apologies read as admissions of fault.
- UN-SPECULATIVE: Never "the guest likely..." or "this appears to be..." State what the records show and cite the exhibit.
- EXHIBIT-CITING: Every factual claim is followed by "(see Exhibit X)." Reviewers who skim read the citations.

Structure every response in 4 sections separated by blank lines:
1. OPENING (2-3 sentences, <60 words): Who booked, what, when, how much. One assertion of legitimacy.
2. REBUTTAL (200-350 words): Lead with the reason-code-specific evidence. Chronological within section. Every claim cites an exhibit.
3. SUPPORTING (100-200 words): Remaining exhibits reinforcing the timeline. No new arguments.
4. CLOSE (1-2 sentences): "We respectfully request the dispute be decided in our favor." No pleading.

After the narrative, include a [DRAFT NOTES] section for the human reviewer:
- Case strength: Strong / Moderate / Weak with one-sentence rationale
- Evidence gaps and their impact
- Claims cut for lack of support
- Approval recommendation: submit_as_is / needs_jocelyn_review / needs_jason_review

Return your response as valid JSON with this exact structure:
{
  "opening": "...",
  "rebuttal": "...",
  "supporting": "...",
  "close": "...",
  "draft_notes": "...",
  "exhibits_cited": ["A", "B", ...]
}`;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class NarrativeDrafter extends AgentBase {
  private unsubscribers: Array<() => void> = [];
  private anthropic: Anthropic;

  constructor() {
    super(IDENTITY);
    this.anthropic = new Anthropic();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected async onStart(): Promise<void> {
    this.unsubscribers.push(
      this.on({ event_type: "chargeback.dossier.ready" }, async (ev) => {
        await this.handleDossierReady(ev);
      }),
    );

    this.log.info("narrative drafter online — listening for chargeback.dossier.ready");
  }

  protected async onStop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.log.info("narrative drafter stopped");
  }

  // -------------------------------------------------------------------------
  // Main handler
  // -------------------------------------------------------------------------

  private async handleDossierReady(ev: {
    event_id: string;
    correlation_id: string | null;
    payload: unknown;
  }): Promise<void> {
    const cid = ev.correlation_id ?? ev.event_id;
    const manifest = ev.payload as DossierManifest;
    const caseId = manifest.case_id;

    this.log.info({ cid, caseId, dossierKey: manifest.dossier_key }, "narrative draft request received");

    // 1. Load case record
    const caseRecord = await this.loadCase(caseId);
    if (!caseRecord) {
      this.log.error({ caseId }, "case record not found — cannot draft narrative");
      return;
    }

    // 2. Load reservation match
    const reservation = manifest.reservation_id
      ? await this.loadReservation(manifest.reservation_id)
      : null;

    // 3. Check for evidence contradictions before drafting
    const contradiction = this.detectContradictions(manifest, caseRecord);
    if (contradiction) {
      this.log.warn({ caseId, contradiction }, "evidence contradiction detected — blocking narrative");
      await this.emit("chargeback.narrative.blocked", {
        case_id: caseId,
        dossier_key: manifest.dossier_key,
        reason: "evidence_contradiction",
        detail: contradiction,
      }, { correlation_id: cid });

      await this.audit({
        action: "narrative.blocked",
        entity_type: "chargeback_case",
        entity_id: caseId,
        correlation_id: cid,
        reason: `Evidence contradiction: ${contradiction}`,
        severity: "warn",
      });
      return;
    }

    // 4. Build the Claude prompt with case context
    const userPrompt = this.buildUserPrompt(manifest, caseRecord, reservation);
    const maxWords = caseRecord.amount > HIGH_VALUE_THRESHOLD
      ? MAX_WORDS_HIGH_VALUE
      : MAX_WORDS_STANDARD;

    // 5. Call Claude API
    let draft: NarrativeDraft;
    try {
      draft = await this.callClaude(userPrompt, maxWords, manifest, caseRecord);
    } catch (err) {
      this.log.error({ err, caseId }, "Claude API call failed");
      return;
    }

    // 6. Validate the draft — check for banned phrases
    const violations = this.checkBannedPhrases(draft.full_text);
    if (violations.length > 0) {
      this.log.warn({ caseId, violations }, "draft contains banned phrases — noted in draft_notes");
      draft.draft_notes += `\n\nVOICE VIOLATIONS (reviewer should fix): ${violations.join(", ")}`;
    }

    // 7. Persist the draft
    await this.persistDraft(caseId, manifest.dossier_key, draft);

    // 8. Emit narrative.ready — ALWAYS goes to human review
    await this.emit("chargeback.narrative.ready", {
      case_id: caseId,
      dossier_key: manifest.dossier_key,
      draft,
    }, { correlation_id: cid });

    await this.audit({
      action: "narrative.drafted",
      entity_type: "chargeback_case",
      entity_id: caseId,
      correlation_id: cid,
      after_state: {
        word_count: draft.word_count,
        exhibits_cited: draft.exhibits_cited,
        token_usage: draft.token_usage,
      },
      reason: `Narrative drafted — ${draft.word_count} words, ${draft.exhibits_cited.length} exhibits cited`,
    });

    this.log.info(
      { caseId, wordCount: draft.word_count, tokens: draft.token_usage },
      "narrative draft complete — emitted for human review",
    );
  }

  // -------------------------------------------------------------------------
  // Contradiction detection
  // -------------------------------------------------------------------------

  /**
   * Scan dossier exhibits for contradictions that would undermine our case.
   * If guest communications show complaints that contradict our position,
   * we refuse to draft a misleading narrative.
   */
  private detectContradictions(
    manifest: DossierManifest,
    caseRecord: CaseRecord,
  ): string | null {
    const exhibits = manifest.exhibits;
    const commsExhibit = exhibits.find((e) => e.exhibit_letter === "E");
    const lockExhibit = exhibits.find((e) => e.exhibit_letter === "F");

    // Contradiction: service_not_rendered but lock logs show zero entries
    // AND guest comms show guest said they never arrived
    if (caseRecord.reason === "service_not_rendered") {
      if (
        lockExhibit?.status === "success" &&
        lockExhibit.artifacts.length === 0 &&
        commsExhibit?.status === "success" &&
        commsExhibit.reason?.toLowerCase().includes("never arrived")
      ) {
        return "Lock logs empty AND guest communications indicate guest claims they never arrived. Cannot rebut service_not_rendered.";
      }
    }

    // Contradiction: fraud claim but guest comms show the actual cardholder
    // messaged us acknowledging the stay
    if (caseRecord.reason === "fraudulent") {
      if (
        lockExhibit?.status === "success" &&
        lockExhibit.artifacts.length > 0 &&
        commsExhibit?.status === "success" &&
        commsExhibit.reason?.toLowerCase().includes("guest denied booking")
      ) {
        return "Lock logs show entry but guest communications contain denial of booking. Evidence is contradictory for fraud rebuttal.";
      }
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Prompt construction
  // -------------------------------------------------------------------------

  private buildUserPrompt(
    manifest: DossierManifest,
    caseRecord: CaseRecord,
    reservation: ReservationMatch | null,
  ): string {
    const exhibitList = manifest.exhibits
      .filter((e) => e.status === "success" || e.status === "partial")
      .map((e) => `  Exhibit ${e.exhibit_letter}: ${e.exhibit_title} [${e.status}] — ${e.reason ?? "Available"}`)
      .join("\n");

    const gapList = manifest.gaps.length > 0
      ? manifest.gaps.map((g) => `  Exhibit ${g.exhibit_letter}: ${g.exhibit_title} — ${g.reason ?? "Missing"}`).join("\n")
      : "  None";

    return `CASE CONTEXT:
Reason code: ${caseRecord.reason}
Processor: ${caseRecord.source}
Disputed amount: $${caseRecord.amount} ${caseRecord.currency}
Guest name: ${caseRecord.guest_name}
Charge date: ${caseRecord.charge_date}
Evidence deadline: ${caseRecord.evidence_due_at}
${reservation ? `Property: ${reservation.property_name ?? reservation.property_id ?? "Unknown"}
Check-in: ${reservation.check_in}
Check-out: ${reservation.check_out}
Reservation total: $${reservation.total_amount}
Channel: ${reservation.channel ?? "Unknown"}` : "Reservation: Not yet matched"}

AVAILABLE EXHIBITS:
${exhibitList}

EVIDENCE GAPS:
${gapList}

EXHIBIT ORDER (frontload rebuttal evidence for this reason code):
${manifest.exhibit_order.join(", ")}

Draft the 4-section narrative now. For each reason code, frontload the rebuttal evidence:
- fraud: Lead with ID verification, payment auth, lock logs
- service_not_rendered: Lead with lock logs, in-stay activity, guest comms
- not_as_described: Lead with inspection photos, guest comms, listing match
- duplicate: Lead with folio showing single charge, payment record

Cite ONLY exhibits that appear in the AVAILABLE EXHIBITS list above. Never fabricate an exhibit.
Return valid JSON as specified in the system prompt.`;
  }

  // -------------------------------------------------------------------------
  // Claude API call
  // -------------------------------------------------------------------------

  private async callClaude(
    userPrompt: string,
    maxWords: number,
    manifest: DossierManifest,
    caseRecord: CaseRecord,
  ): Promise<NarrativeDraft> {
    const response = await this.anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT + `\n\nWord limit for this case: ${maxWords} words.`,
      messages: [{ role: "user", content: userPrompt }],
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    this.log.info(
      { inputTokens, outputTokens, model: CLAUDE_MODEL },
      "Claude API token usage",
    );

    // Extract text content from response
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text content in Claude response");
    }

    // Parse JSON from response — handle markdown code fences
    let rawJson = textBlock.text.trim();
    if (rawJson.startsWith("```")) {
      rawJson = rawJson.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(rawJson) as {
      opening: string;
      rebuttal: string;
      supporting: string;
      close: string;
      draft_notes: string;
      exhibits_cited: string[];
    };

    const fullText = [
      parsed.opening,
      parsed.rebuttal,
      parsed.supporting,
      parsed.close,
    ].join("\n\n");

    const wordCount = fullText.split(/\s+/).filter(Boolean).length;

    return {
      case_id: caseRecord.case_id,
      dossier_key: manifest.dossier_key,
      reason_code: caseRecord.reason,
      processor: caseRecord.source,
      narrative: {
        opening: parsed.opening,
        rebuttal: parsed.rebuttal,
        supporting: parsed.supporting,
        close: parsed.close,
      },
      full_text: fullText,
      word_count: wordCount,
      exhibits_cited: parsed.exhibits_cited,
      draft_notes: parsed.draft_notes,
      drafted_at: new Date().toISOString(),
      token_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private checkBannedPhrases(text: string): string[] {
    const lower = text.toLowerCase();
    return BANNED_PHRASES.filter((phrase) => lower.includes(phrase));
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async persistDraft(
    caseId: string,
    dossierKey: string,
    draft: NarrativeDraft,
  ): Promise<void> {
    const sb = serviceClient();

    const { error } = await sb
      .from("chargeback_cases")
      .update({
        narrative_draft: {
          dossier_key: dossierKey,
          narrative: draft.narrative,
          full_text: draft.full_text,
          word_count: draft.word_count,
          exhibits_cited: draft.exhibits_cited,
          draft_notes: draft.draft_notes,
          drafted_at: draft.drafted_at,
          token_usage: draft.token_usage,
        },
      })
      .eq("case_id", caseId);

    if (error) {
      this.log.error({ error, caseId }, "failed to persist narrative draft");
    }
  }

  // -------------------------------------------------------------------------
  // Data loaders
  // -------------------------------------------------------------------------

  private async loadCase(caseId: string): Promise<CaseRecord | null> {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("chargeback_cases")
      .select("case_id, source, external_case_id, amount, currency, reason, guest_name, charge_date, evidence_due_at, reservation_ref, property_id, stage")
      .eq("case_id", caseId)
      .single();

    if (error || !data) {
      this.log.error({ error, caseId }, "failed to load case record");
      return null;
    }
    return data as CaseRecord;
  }

  private async loadReservation(reservationId: string): Promise<ReservationMatch | null> {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("reservations_cache")
      .select("reservation_id, guest_name, check_in, check_out, total_amount, channel, property_id, property_name")
      .eq("reservation_id", reservationId)
      .single();

    if (error || !data) {
      this.log.error({ error, reservationId }, "failed to load reservation");
      return null;
    }
    return data as ReservationMatch;
  }
}

export default new NarrativeDrafter();
