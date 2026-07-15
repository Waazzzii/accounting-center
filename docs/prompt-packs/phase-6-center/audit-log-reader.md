# Audit Log Reader — Prompt Pack

**Agent:** `audit-log-reader`
**Phase:** 6 (Dashboards & Cross-product)
**Parent Orchestrator:** `accounting-orchestrator`
**Trigger:** On-demand (human query via Slack / dashboard / API) + scheduled nightly integrity check
**Owner:** Jason (technical), Kimberly (compliance usage)
**SLA:** Query response < 5s for ≤ 30d windows; < 30s for larger; integrity check completes nightly within 15 min

---

## 1. Purpose

The Accounting Center writes an immutable audit log entry for **every financial action** across all five products. This agent is the **read-only query interface** over that log — the only sanctioned way to answer questions like:

- "Who approved the March owner payout for Coachella Canyon Retreat?"
- "Why did RevPost post this JE to account 4100 instead of 4200?"
- "Show me every action related to dispute DSP-2026-0411."
- "Did any TrustSync transfer over $10K happen outside business hours last quarter?"
- "Reconstruct the entire lifecycle of reservation R-5521 across all products."

Three audiences:
1. **Jason** — debugging production incidents, investigating edge cases
2. **Kimberly / Wendell (Accounting)** — reconciliation questions, audit prep, regulator responses
3. **External auditors** — annual audit sampling, SOC-2 controls review, state trust audits

Plus one non-human audience:
4. **Compliance automations** — nightly hash-chain integrity verification, retention policy enforcement

---

## 2. System Prompt

```
You are the Audit Log Reader for the ACME Accounting Center.

You have read-only access to the immutable audit log that captures every
financial action across TrustSync, OTAAuditor, RevPost, Chargeback Manager,
and Utility Bill Manager. You answer questions about the log.

You NEVER write. You NEVER modify. You NEVER delete. You do not mask data
(the log is the truth — filtering belongs to the query, not the storage).

Three query modes:
  1. DIRECT LOOKUP — precise entity query ("show all events for dispute X")
  2. RECONSTRUCTIVE — build a chronological narrative from multiple events
     ("tell me what happened with reservation Y")
  3. ANALYTICAL — aggregate patterns ("how many TrustSync transfers this
     quarter exceeded $10K?")

Rules:
- Every response includes the exact audit_log row IDs that back it.
- If asked to explain a decision, quote the actor, the decision, and the
  evidence row that justified it.
- NEVER guess or extrapolate. If the log doesn't say, the answer is "the
  log doesn't capture that — here's what it does capture."
- Access control: some queries require role (COO, Accounting, Auditor).
  If caller isn't authorized for a field, return metadata without the
  sensitive value.
- PII in audit logs is present by design (owner names, amounts); redact
  only at the query boundary for non-privileged callers.
- Hash chain integrity is sacred. If a query reveals broken hash chain,
  stop and alert Jason immediately — this could indicate tampering.

Voice for narrative reconstructions:
- Chronological, factual, neutral. Like a court stenographer.
- Actor, action, timestamp, amount, linked entities. In that order.
- "2026-04-11 14:22:07 PT — utility-draft-composer created Gmail draft
  msg_abc123 for owner owner_5521, property Coachella Canyon, template
  standard_monthly, word_count=118."
```

---

## 3. Task Prompt Template

```
Answer the audit question: {query}

Caller: {caller_identity}, role: {caller_role}
Time window: {window_start} to {window_end}
Products in scope: {products}
Return format: {summary | narrative | table | json_rows | csv_export}

Step 1: Parse the question into query parameters
Step 2: Verify role has access to the requested fields
Step 3: Execute the query against audit_log (+ related tables if needed)
Step 4: Format the response per mode
Step 5: Return with row IDs and query hash for reproducibility
```

---

## 4. Step-by-Step Workflow

### Step 1 — Audit Log Schema (shared across all products)

```
audit_log:
  audit_id              UUID        PK
  emitted_at            TIMESTAMP   (when the event happened, source-of-truth)
  logged_at             TIMESTAMP   (when the log row was written)
  product               TEXT        ('trustsync','otaauditor','revpost','chargeback','utility','center')
  agent                 TEXT        (which sub-agent emitted)
  actor_type            TEXT        ('ai_agent','human','system','external')
  actor_id              TEXT        (e.g., 'trustsync-transfer-agent' or '@kimberly' or 'column_bank_webhook')
  event_type            TEXT        (canonical event name)
  severity              TEXT        ('info','warn','error','critical')
  primary_entity_type   TEXT        ('reservation','dispute','transfer','je','bill','owner')
  primary_entity_id     TEXT
  related_entities      JSON        (list of {type,id,role})
  amount_usd            NUMERIC     NULL
  market                TEXT        NULL
  region                TEXT        NULL  ('socal','arizona',...)
  action_description    TEXT        (human-readable)
  payload               JSON        (full payload — what happened)
  evidence_refs         JSON        (list of {type,url,checksum} for supporting artifacts)
  decision_basis        TEXT        NULL  (which rule/threshold/human triggered this)
  idempotency_key       TEXT        NULL
  prev_hash             TEXT        (hash of previous row — chain integrity)
  row_hash              TEXT        (hash of this row including prev_hash)
  retention_policy      TEXT        ('7y','10y','permanent')
```

**Hash chain:** `row_hash = sha256(audit_id + emitted_at + product + agent + event_type + primary_entity_id + payload_hash + prev_hash)`. Every insert computes its hash from the previous row's hash. Any tampering breaks the chain.

### Step 2 — Access Control

Roles and field visibility:

| Role | Can See |
|---|---|
| `coo` (Jason) | All fields, all rows |
| `accounting_lead` (Kimberly, Wendell) | All fields except `security_events`, `credentials_access` rows |
| `auditor_external` | All financial rows; PII redacted (owner names → owner_id only) in non-financial rows |
| `ops_reviewer` (Jocelyn) | Utility + chargeback; no TrustSync or RevPost amounts |
| `system` (Phase 6 agents) | All fields, all rows, read-only |

Caller role resolved from auth context (Slack user ID mapped via `role_matrix`, API key mapped via `api_keys_roles`).

### Step 3 — Query Modes

**a) Direct Lookup** — the caller names a specific entity:
```
"Show all audit rows for dispute DSP-2026-0411"
→ SELECT * FROM audit_log
  WHERE primary_entity_id = 'DSP-2026-0411'
     OR related_entities @> '[{"id":"DSP-2026-0411"}]'
  ORDER BY emitted_at
```

**b) Reconstructive** — the caller asks for a narrative:
```
"Walk me through what happened with reservation R-5521"
→ Pull all rows where R-5521 is primary OR related.
→ Order by emitted_at.
→ Emit chronological narrative (see §5 output example).
→ Include cross-product interactions explicitly.
```

**c) Analytical** — the caller asks an aggregate question:
```
"How many TrustSync transfers > $10K occurred outside business hours last
quarter?"
→ SELECT COUNT(*), SUM(amount_usd)
  FROM audit_log
  WHERE product = 'trustsync'
    AND event_type = 'transfer_completed'
    AND amount_usd > 10000
    AND (HOUR(emitted_at) < 8 OR HOUR(emitted_at) > 18)
    AND emitted_at BETWEEN '2026-01-01' AND '2026-03-31'
```

LLM parses the natural language question, generates the parameterized SQL, executes, formats.

### Step 4 — Reconstructive Output

For narrative mode, structure as:

```
# Audit Trail — Reservation R-5521
# Generated 2026-04-13 14:22:00 PT by @jason (role: coo)
# Query hash: sha256:abc123...
# Rows included: 47

## Lifecycle

2026-03-14 14:02:11 PT  [trustsync/long-term-finder]
  Identified reservation R-5521 (29 nights, market=coachella) as LT.
  Amount: $4,235.18. Decision basis: nights >= 29.
  Audit ID: audit_001

2026-03-14 14:03:22 PT  [trustsync/transfer-agent]
  Initiated Column Bank transfer xfr_abc123.
  From: trust-coachella, To: operating-coachella, Amount: $4,235.18.
  Audit ID: audit_002

2026-03-14 14:04:07 PT  [column_bank_webhook]
  Transfer xfr_abc123 completed successfully.
  Audit ID: audit_003

...

## Cross-Product References
- Phase 2 OTAAuditor: 3 events related to OTA payout matching
- Phase 3 RevPost: 2 events related to JE posting
- Phase 5 Utility: 1 event related to utility bill for property

## Integrity
- Hash chain verified: PASS (all 47 rows)
- No gaps detected.
```

### Step 5 — Analytical Output

Table + optional CSV export:
```
| Month | Count | Sum USD | Avg USD |
|-------|-------|---------|---------|
| Jan   |   3   | 45,200  | 15,067  |
| Feb   |   1   | 12,800  | 12,800  |
| Mar   |   2   | 38,100  | 19,050  |

Query: SELECT ... (full SQL attached)
Query hash: sha256:...
Rows scanned: 12,847 | Rows matched: 6
Generated 2026-04-13 14:22:00 PT by @kimberly (role: accounting_lead)
```

### Step 6 — Nightly Integrity Check (22:00 PT)

Scheduled job — not a human query, but same agent:
1. Walk audit_log from genesis row to latest
2. Recompute each `row_hash` from `prev_hash + fields`
3. Compare to stored `row_hash`
4. Any mismatch → CRITICAL alert to Jason (possible tampering)
5. Log integrity check result to `audit_integrity_log` (the log's log)

Also:
- Check for gaps in sequence per product
- Check for rows beyond retention window (flag, don't delete — deletion is separate policy-enforced process)
- Verify evidence_refs still resolve (sample 1% of recent rows, fetch signed URLs, confirm checksums)

### Step 7 — Query Logging

Every query this agent executes is itself audited:
- `audit_queries` table (separate from audit_log to avoid recursion)
- Stores caller, role, parsed query, SQL executed, row count returned, query hash
- Retention: same as audit log (7y minimum)

Used for demonstrating who accessed what during compliance reviews.

### Step 8 — Slack Interface

Command: `/acct audit {question}`
- Parses question, runs query, posts formatted result as a thread reply
- For long narratives, renders first 20 events + link to full export
- For analytics, renders table + CSV download link

Dashboard interface:
- Search bar over audit log
- Entity-detail pages have "Full audit trail" button → reconstructive mode

### Step 9 — Export for Auditors

Auditor-role caller can export:
- CSV / Parquet bundle of query results
- Signed URL valid for 24 hours
- Bundle includes: query hash, SQL executed, row IDs, PII-redacted per auditor policy
- Export itself audit-logged

---

## 5. Output Schema

**Query response:**
```json
{
  "query_id": "aq_abc123",
  "caller": "@kimberly",
  "caller_role": "accounting_lead",
  "query_text": "Show all activity for dispute DSP-2026-0411",
  "query_mode": "direct_lookup",
  "parsed_sql_hash": "sha256:...",
  "executed_at": "2026-04-13T14:22:00-07:00",
  "rows_returned": 12,
  "row_ids": ["audit_a1", "audit_a2", "..."],
  "integrity_check": "passed",
  "response_format": "narrative",
  "response": "...rendered narrative here...",
  "export_url": null,
  "redactions_applied": []
}
```

**Nightly integrity check result:**
```json
{
  "check_id": "int_abc",
  "ran_at": "2026-04-13T22:00:00-07:00",
  "rows_verified": 184209,
  "hash_chain_status": "intact",
  "gaps_detected": [],
  "retention_flagged_rows": 0,
  "evidence_sample_verified": 1247,
  "evidence_sample_failures": 0,
  "duration_seconds": 612,
  "result": "pass"
}
```

---

## 6. Escalation Triggers

| Condition | Action |
|---|---|
| Hash chain break detected | CRITICAL alert to Jason immediately; freeze new writes if possible; open SEC-incident |
| Evidence ref unresolvable (checksum mismatch) | Alert Jason; investigate origin product |
| Query response exceeds 30s | Log slow query; if repeated, alert Jason to optimize index |
| Unauthorized role query attempt | Reject + log attempt; alert Jason for repeated offenders |
| Retention window exceeded row detected | Flag, notify Kimberly; do NOT auto-delete |
| Integrity check fails to run at scheduled time | Alert Jason: audit-log-reader degraded |

---

## 7. Error Handling

| Error | Handling |
|---|---|
| Natural language query can't be parsed | Return "I couldn't parse that — can you rephrase?" with examples |
| SQL execution error | Log, return generic "query failed" to caller, alert Jason with full error |
| Caller role unresolvable | Default to `read_only_minimal` (metadata only); alert Jason |
| Audit log row missing expected field | Return with `{field}: null`; flag schema-drift for investigation |
| Huge result set (> 50k rows) | Offer CSV export instead of inline; never inline massive responses |
| External auditor requests impossible data | "The audit log does not capture {X}. It does capture {Y}." — honest |

---

## 8. Tools Required

- **Database:** read-only access to `audit_log`, `audit_queries`, `audit_integrity_log`, `role_matrix`, `api_keys_roles`
- **LLM (Claude):** NL-to-SQL parsing, narrative rendering
- **Hashing library:** SHA-256 for integrity verification
- **CSV / Parquet writers:** for exports
- **Slack MCP:** for `/acct audit` command handler
- **Storage:** for signed-URL exports (S3 / equivalent)
- **Event bus:** emit `integrity_check_completed`, `integrity_violation_detected`

---

## 9. Handoff Contract

**Upstream:** Queries from humans (Slack, dashboard), auditors (API), and scheduled integrity checks.

**Downstream:**
- Query results → caller (Slack message, dashboard response, API JSON)
- `integrity_check_completed` → kpi-computer (contributes to compliance KPI), audit-log (self-referential — the check itself is logged)
- `integrity_violation_detected` (CRITICAL) → alert-router

**Side-effects:** Every query logged to `audit_queries`. NO writes to `audit_log` itself (that's the source products' job).

---

## 10. Configuration

```yaml
audit_log_reader:
  audit_log_table: "audit_log"
  queries_log_table: "audit_queries"
  integrity_log_table: "audit_integrity_log"
  nightly_integrity_check_time_pt: "22:00"
  nightly_integrity_sample_pct: 1.0
  hash_algorithm: "sha256"
  retention_policies:
    default: "7y"
    security_events: "10y"
    trust_transfers: "10y"
    chargeback_outcomes: "7y"
    minor_info_events: "3y"
  roles:
    coo:
      fields_allowed: "all"
      products_allowed: "all"
      export_allowed: true
      slack_user_ids: ["UJASON"]
    accounting_lead:
      fields_allowed: "all_except:[security_events,credentials_access]"
      products_allowed: "all"
      export_allowed: true
      slack_user_ids: ["UKIMBERLY","UWENDELL"]
    auditor_external:
      fields_allowed: "financial_only_pii_redacted"
      products_allowed: "all"
      export_allowed: true
      api_key_prefix: "auditor_"
    ops_reviewer:
      fields_allowed: "operational_only"
      products_allowed: ["utility","chargeback"]
      export_allowed: false
      slack_user_ids: ["UJOCELYN"]
  slack_commands:
    audit_query: "/acct audit {question}"
    audit_trace: "/acct trace {entity_type} {entity_id}"
    audit_integrity: "/acct integrity-status"
  max_inline_rows: 50
  max_query_response_seconds: 30
  huge_result_threshold_rows: 50000
  signed_export_ttl_hours: 24
  llm_model_for_nl_parsing: "claude-opus"
```

---

## 11. Testing Scenarios

| # | Scenario | Expected |
|---|---|---|
| T1 | Jason queries "show me all trust transfers over $10K last quarter" | Returns analytical table + CSV link; row IDs included |
| T2 | Kimberly asks for reservation R-5521 lifecycle | Narrative output with 47 events chronologically; cross-product references noted |
| T3 | Jocelyn asks for TrustSync data (outside her role) | Response denied with "not in your role scope"; query logged |
| T4 | External auditor queries Q1 chargeback data | Financial rows returned, PII redacted per policy, signed CSV URL generated |
| T5 | Nightly integrity check — all rows clean | `pass` result logged; no alerts |
| T6 | Nightly integrity check — detects hash mismatch on one row | CRITICAL alert to Jason; incident opened |
| T7 | Query references entity not in log | "No events found for {entity} in window {X}" — honest empty result |
| T8 | Slow query (large window, complex join) | Completes in < 30s or offers export path |
| T9 | NL query ambiguous ("show me the bad stuff") | Returns "I need more specifics" + suggested rephrasings |
| T10 | Same query run by Jason and auditor | Jason sees full; auditor sees redacted; both logged |
| T11 | `/acct trace dispute DSP-2026-0411` Slack command | Posts reconstructive trace as thread reply; link to full export |
| T12 | Hash chain break simulated | Integrity check catches; alert fires; query result flagged `integrity_violation_detected` |

---

## 12. Success Metrics

- **Query response p95:** < 5s for direct lookups, < 15s for reconstructive, < 30s for analytical
- **Nightly integrity check:** 100% on-time, 100% pass (any fail = incident)
- **Auditor satisfaction** (annual survey): "the audit log responded to every question we asked" — yes
- **Role compliance:** 0 unauthorized disclosures (every query scoped correctly)
- **Hash chain continuity:** 100% of rows verifiable against genesis (7-year history)
- **Self-auditability:** `audit_queries` log itself never tampered — verified in integrity check

---

## 13. Notes for Implementation

- **The audit log is the paper trail of the entire Accounting Center.** If it isn't trustworthy, nothing downstream is. Treat hash-chain integrity as mission-critical.
- **NL-to-SQL is high-leverage but dangerous.** An LLM that generates the wrong SQL returns wrong answers confidently. Always include the generated SQL in the response so the caller can verify. Log every SQL for regulator review.
- **Never delete.** Retention policy says "when to archive or migrate" — never "when to delete." A deleted row is indistinguishable from a tampered row.
- **Redaction happens at query time, not storage time.** Store truth; filter for the caller. The raw log is the source of truth for all downstream interpretations.
- **The integrity check is the cheapest insurance you'll ever buy.** A broken chain caught at 22:00 PT tonight is a manageable incident. Caught during a regulator audit 3 years later is catastrophic.
- **Auditors love well-formed exports.** Signed URL, CSV + PDF summary + query hash + SQL + row IDs = professional delivery. Make the bar high here; it shapes regulator perception of the whole operation.
- **Use this agent as the backbone of postmortems.** When something goes wrong, the first step is always "show me the trace." The more practiced the team is at reading audit narratives, the faster incidents get resolved.
- **Cross-product queries are the killer feature.** "What happened with reservation R-5521 across every product?" is impossible without this agent and trivial with it. This is the payoff for the unified audit log design.
- **Audit the auditor.** The `audit_queries` log ensures every query through this agent is itself logged. If someone asks "who looked at the March data?", we can answer.
