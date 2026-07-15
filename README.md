# Accounting Center

> The autonomous accounting operating system for ACME House Company.
> Built on the Claude Agent SDK + Supabase + MCP integrations.

## What this is

A coordinated network of **41 AI sub-agents** across **6 products** that together run the accounting operations of a vacation-rental management company:

| Phase | Product | Agents | Purpose |
|-------|---------|--------|---------|
| 1 | **TrustSync** | 6 | ST→LT trust transfers, compliance, monthly reversals |
| 2 | **OTA Auditor** | 6 | 3-way matching of OTA payouts, bank deposits, GL postings |
| 3 | **RevPost** | 7 | Revenue decomposition + journal entry posting to Sage Intacct |
| 4 | **Chargeback Manager** | 7 | Dispute detection, evidence dossier, narrative drafting, case tracking |
| 5 | **Utility Bill Manager** | 7 | Weekly owner outreach, bill ingestion, owner-statement credit allocation |
| 6 | **Center (Dashboards & Cross-product)** | 8 | Orchestration, KPIs, health, alerts, audit log, close cycle, reports, dashboards |

Full specifications live in `docs/prompt-packs/` (41 markdown files, one per agent).

## Design invariants (carried across every agent)

- **Event-driven** — every agent emits named events on a shared bus; nothing polls that could be pushed
- **Idempotent** — financial operations use deterministic hash keys; re-running never double-posts
- **Immutable audit log** — every action writes a SHA-256 hash-chained row; tamper-detectable, 7-year retention
- **Human-in-the-loop for money-in-motion** — approval gates on JE posting, utility credits, chargeback submissions, trial-balance signoff
- **Maturity ladder** — products launch in shadow → assist → accelerated modes; automation never outruns earned trust
- **Regional separation** — SoCal and Arizona run independently where regulation or time zones demand
- **KPI truth flows one way** — raw events → `kpi-computer` → `kpi_snapshots` → dashboards. No dashboard reinvents math
- **Alerts are actionable or they don't deliver** — every alert envelope requires `suggested_action` or gets rejected

## Architecture at a glance

```
                     ┌──────────────────────────────────┐
                     │   Accounting Orchestrator        │
                     │   (cross-product event bus)      │
                     └───┬──────┬──────┬──────┬──────┬──┘
                         │      │      │      │      │
                  ┌──────┘  ┌───┘  ┌───┘  ┌───┘  └──────┐
                  ▼         ▼      ▼      ▼             ▼
             TrustSync  OTAAuditor RevPost Chargeback Utility
                  │         │      │      │             │
                  └────┬────┴───┬──┴──┬───┴───┬─────────┘
                       ▼        ▼     ▼       ▼
                 ┌─────────────────────────────────┐
                 │  Phase 6 Infrastructure          │
                 │  ─ kpi-computer                  │
                 │  ─ health-monitor                │
                 │  ─ alert-router                  │
                 │  ─ audit-log-reader              │
                 │  ─ month-end-close-orchestrator  │
                 │  ─ cross-product-reporter        │
                 │  ─ dashboard-builder             │
                 └─────────────────────────────────┘
```

## Tech stack

| Layer | Technology |
|-------|-----------|
| Agents | Claude Agent SDK (TypeScript) |
| Database | Supabase (Postgres + RLS + realtime + functions) |
| Event bus | Supabase `pg_notify` + LISTEN/NOTIFY pattern (Phase 1) → NATS/Kafka later if needed |
| MCP integrations | Gmail, Slack, Column Bank, Streamline, Sage Intacct, Stripe, Asana, Ramp |
| Dashboard | React + server-side rendering, websockets for live updates |
| Scheduler | Supabase cron (`pg_cron`) + app-level scheduler for multi-region TZ awareness |
| Secrets | 1Password + `.env.local` (never committed) |
| Deployment | TBD (likely Fly.io or Railway for long-running; Supabase Edge Functions for event handlers) |

## Repo structure

```
accounting-center/
├── README.md
├── package.json / tsconfig.json        # TypeScript agents
├── pyproject.toml                      # Python utilities (OCR, etc.)
├── supabase/
│   ├── migrations/                     # SQL schema migrations
│   ├── functions/                      # Supabase Edge Functions
│   └── seed.sql
├── src/
│   ├── agents/                         # Implementation of all 41 agents
│   │   ├── phase-1-trustsync/
│   │   ├── phase-2-otaauditor/
│   │   ├── phase-3-revpost/
│   │   ├── phase-4-chargeback/
│   │   ├── phase-5-utility/
│   │   └── phase-6-center/
│   ├── shared/                         # Event bus, audit log, idempotency, Supabase client
│   ├── mcp/                            # MCP server wrappers + custom servers
│   └── dashboard/                      # Web UI
├── config/
│   ├── events.yaml                     # Canonical event catalog (every event_type)
│   ├── kpi-definitions.yaml            # KPI formulas + thresholds
│   ├── role-matrix.yaml                # Who gets what alerts
│   ├── routing-rules.yaml              # Orchestrator event routing
│   └── thresholds.yaml                 # Health-monitor green/yellow/red bounds
├── scripts/
│   ├── migrate.sh
│   ├── seed.sh
│   └── dev.sh
├── tests/                              # Mirrors src/
└── docs/
    ├── prompt-packs/                   # The 41 agent specs (canonical)
    ├── architecture.md
    ├── event-catalog.md
    ├── schema.md
    └── deployment.md
```

## Getting started (developer)

```bash
# 1. Install dependencies
npm install

# 2. Start local Supabase
supabase start

# 3. Apply migrations
./scripts/migrate.sh

# 4. Seed definitions (KPIs, routing rules, role matrix)
./scripts/seed.sh

# 5. Run a single agent locally
npm run agent -- --name accounting-orchestrator --region socal

# 6. Run the dashboard dev server
npm run dashboard:dev
```

## Implementation roadmap

Follows PRD-00 §14 (Weeks 1-22) and maps to the phase-numbered prompt packs.

- **Weeks 1-2:** Foundation — Supabase schema, event bus, audit log, MCP wrappers, test harness
- **Weeks 3-4:** Phase 1 (TrustSync) — compliance-critical, simplest scope
- **Weeks 5-8:** Phase 2 (OTAAuditor) — reconciliation engine
- **Weeks 9-12:** Phase 3 (RevPost) — Sage Intacct posting
- **Weeks 13-16:** Phase 4 (Chargeback Manager) — dispute workflow
- **Weeks 17-18:** Phase 5 (Utility Bill Manager) — owner outreach (simplest product, already validated manually)
- **Weeks 19-22:** Phase 6 — dashboards, cross-product orchestration, month-end close

Each phase launches in **shadow mode** (human reviews every action) for 2 weeks before promotion to automated.

## Current status

**Stage:** Foundation build — repo scaffolded, schema migrations in progress, first agents pending.

| Component | Status |
|-----------|--------|
| Prompt packs (41) | ✅ Complete (all in `docs/prompt-packs/`) |
| Shared schema SQL | 🚧 In progress |
| Event catalog | 🚧 In progress |
| KPI definitions | 🚧 In progress |
| Phase 6 backbone (orchestrator, KPI, audit, alert, dashboard) | ⏳ Next |
| Phase 1 TrustSync | ⏳ Queued |
| Phases 2-5 | ⏳ Queued |

## Governance & approvals

Per PRD-00 §19:

| Role | Name |
|------|------|
| Author (COO) | Jason Pratts |
| CEO | Mike Flannery |
| VP Operations | Larissa Pederson |
| Accounting Lead | Kimberly / Wendell |
| Director of Support | Jocelyn Gutierrez (Utility Bill Manager) |

Every automated posting / transfer / message requires a documented approval gate owned by the accountable human — see individual prompt packs for specifics.

## License & confidentiality

**Proprietary to ACME House Company.** Internal use only. Not for distribution.

Contains sensitive operational logic, API credentials (never committed — stored in `.env.local` and 1Password), and reproductions of Casago franchise workflows.

---

*Built as part of ACME's North Star: "By 2028, the best vacation rental management company in the Southwest, powered by an AI-first operating model."*
