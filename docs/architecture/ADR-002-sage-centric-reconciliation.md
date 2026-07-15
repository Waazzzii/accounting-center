# ADR-002: Sage-Centric Reconciliation (Column Bank Dropped)

**Date:** 2026-07-14
**Status:** Accepted
**Supersedes:** the Column Bank adapter plan in OTAAuditor Wave 3

## Context

The original OTAAuditor design assumed Column Bank as the future bank with
API/webhook access to deposit data. That migration is not happening. The
new reality:

- **Banc of California** holds all trust + operating accounts.
- **BofC bank feeds are connected to Sage Intacct** — every bank transaction
  auto-posts as a GL journal-entry line on the account's GL (verified live
  2026-07-14 via the Sage Intacct MCP).
- A **Sage Intacct MCP** now exists with `query` (universal object query),
  `get_journal_entries`, `get_chart_of_accounts`, and `call_sage_endpoint`
  (raw REST escape hatch).
- **Lynnbrook** remains the merchant account (cards, chargebacks). Its
  payouts appear in the bank feed as `MerchPayout SV9T 8662240369 Track
  Merchant` ACH credits; Amex settles separately as `AMERICAN EXPRESS
  SETTLEMENT` rows.

## Verified facts (probed live against production Sage)

1. `general-ledger/journal-entry-line` is queryable in REST v1 with filters
   on `glAccount.id`, `entryDate`, `txnType`; 866K+ lines exist.
2. Each line carries: `entryDate`, `txnType` (debit=cash in on asset
   accounts), `txnAmount`, `description` (full bank memo), dimensions
   (location/class/vendor/customer), `journalEntry.id`, `state`, and
   `reconciliationGroup.{cleared, clearingDate, reconciliationDate}`.
3. Bank-feed rows have rich memos; manual JEs typically have null
   descriptions. June 2026 on GL 102110 (ACME House Trust ST): 41 debit
   rows — Lynnbrook payouts, Amex settlements, Marriott direct pay, ZBA
   sweeps.
4. Trust account map (from "Cash-management_checking-account" workbook,
   all Banc of California, all bank-feed Connected):

   | Sage checking ID       | Bank acct # | GL     | Market / purpose            |
   |------------------------|-------------|--------|-----------------------------|
   | ACME CA INC-8890       | 7898468890  | 100070 | CA operating/income         |
   | ACME CA Trust - 9147   | 7898469147  | 100062 | CA trust                    |
   | ACME CA OC ST - 0593   | 7372510593  | 100075 | Orange County ST            |
   | Acme CA OC TA-3267     | 6731903267  | 100074 | Orange County trust         |
   | ACME ORG LTRM-1667     | 7835191667  | 102120 | ACME House trust — long-term|
   | ACME ORG ST -7272      | 6850827272  | 102110 | ACME House trust — short-term|
   | ACME PHX SCT-9773      | 7427919773  | 100011 | Phoenix/Scottsdale          |
   | ACME SED FSTF-1793     | 6566151793  | 100020 | Sedona/Flagstaff            |
   | ACME TUC AZ-3759       | 7189313759  | 100040 | Tucson                      |

   (One stale record: "ACME ORG STRM-7272" on GL 10211, feed disconnected,
   last reconciled 2025-12-31 — legacy, exclude.)

   Sweep accounts also exist in Sage: `ACME Sweep - 2721`,
   `ACME CA Sweep - 8906` — ZBA transfers reference them.

## Decision

**Sage Intacct becomes the single source for actual bank activity.** The
"bank deposit" side of the 3-way match is the set of journal-entry lines
on the 9 live bank GL accounts. Column Bank adapter work is dropped.

The reconciliation triangle becomes:

    Streamline (expected)      Sage GL bank lines (actual, via BofC feed)
         └────────── matching-engine ──────────┘
                          │
              trust-liability reconciliation
        (Streamline owner/guest/tax liability vs trust cash)

## Agent lineup (reoriented)

| Agent | Status | Role |
|---|---|---|
| `payout-scraper` | built (Wave 2) | Streamline → expected payouts by (channel, settlement date) |
| `sage-deposit-sync` | **next** | Sage journal-entry-lines on bank GLs → `bank_deposits` (source_system='sage_intacct'), memo-based classification (lynnbrook / amex / marriott / airbnb / vrbo / wire / zba_sweep / internal / unknown) |
| `matching-engine` | built (Wave 1) | expected ↔ actual matching, confidence scored |
| `trust-reconciler` | **new** | daily: Streamline trust liability vs Sage trust cash per account; shortfall = CRITICAL escalation (trust compliance, AZ/CA law) |
| `cash-position` | **new** | cash on hand by account/market; uncleared-item aging (Sage `reconciliationGroup`); sweep/ZBA integrity (transfers net to zero) |
| `exception-manager` | Wave 5 | routes variances/stale items to humans |

## Classification hints (from real June 2026 memos)

| Memo pattern | Classification |
|---|---|
| `MerchPayout SV9T 8662240369 Track Merchant` | lynnbrook merchant payout (direct + VRBO card volume) |
| `AMERICAN EXPRESS SETTLEMENT` | lynnbrook/amex settlement |
| `MARRIOTT PAYMENT DIRECT PAY` | marriott channel payout |
| `AIRBNB` (expected pattern) | airbnb payout |
| `ZBA CREDIT TRANSFER` / `FUNDS TRANSFER TO DEP` | internal transfer / sweep — EXCLUDE from OTA matching |
| `INCOMING WIRE ... VACASA` | acquisition-related transfer |
| `LYNNBROOK RECLASS` | inter-market reclass — internal |

## Consequences

- Wave 3 (bank-deposit-matcher) is replaced by `sage-deposit-sync` — simpler
  (no webhook infra, no CSV import UX) and works TODAY.
- Wave 4 (gl-verifier) largely collapses: the deposit row IS a GL row.
  What remains of GL verification moves into `trust-reconciler` +
  RevPost-side checks (was the revenue recognized correctly).
- The Sage MCP is session-scoped (Claude tooling). The standalone agents
  need their own Sage REST credentials for production. Until the Sender ID
  is issued, agents run via fixture files exported through the MCP.
- Lynnbrook payouts batch multiple reservations per ACH — the matching
  engine's batched-deposit pass (N payouts → 1 deposit) is now the primary
  match path, not the edge case. Streamline-side grouping must mirror
  Lynnbrook's payout batching cadence (daily batches per processor account).
