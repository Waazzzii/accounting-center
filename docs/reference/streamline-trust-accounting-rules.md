# Streamline Trust Accounting — Reconciliation Rules Digest

**Sources** (page numbers cite the printed page number in each doc):

| Abbrev | Document |
|---|---|
| **OPM** | StreamTrust Accounting Operating Procedures Manual, Sep 2022 (62 pp) |
| **OM2** | Streamline Accounting Operation Manual v2.0 (48 pp — newer revision of OPM; where they conflict, OM2 wins) |
| **MEC** | BEST PRACTICE Month End Close To Do List, May 2022 (4 pp) |
| **DD** | The Do's and Don'ts of Accounting, 02/02/21 (6 pp) |
| **CvD** | Charging Rules -vs- Disbursing Rules QUICK Guide (3 pp) |
| **MDR** | Manage Distribution Funds Rules User Guide (7 pp) |
| **TFT** | Common Terms: Taxes and Fees (4 pp) |

**Context for our build:** Streamline (StreamTrust) tracks ONLY the trust account (Banc of California trust/escrow). The operating account lives outside Streamline (Sage Intacct). Lynnbrook is the payment gateway — it MUST be connected to the trust account (DD p.3). Streamline has a native "Lynnbrook Auto Bank Reconciliation" feature (OM2 p.9, KB reference).

---

## 1. Trust accounting model

Streamline models the trust account as **four liability sub-accounts** whose sum must always equal cash (bank + undeposited funds). The Trust Account Summary shows Beginning Balance / Deposits / Withdrawals / Ending Balance for each (OPM p.2, p.60; OM2 p.4, p.47):

| Account | Definition | Healthy state |
|---|---|---|
| **Guest Advanced Deposit (GAD)** | Guest payments received but not yet disbursed (not yet recognized as revenue). "START HERE: guest payments are recorded here." | Should contain only future / not-yet-recognized reservations. No reservation past its revenue-recognition date should remain here (OPM p.43, p.61). |
| **Owner Balance** | Money owed to owners (or owed by owners to the PMC). Populated AFTER disbursement. | Must equal the sum of owner balances on generated owner statements (OM2 p.47). |
| **Vendor Liability** | Total invoices payable to vendors INCLUDING the management company (this is how the PMC's own fees/commissions sit in trust until swept to operating). "The account summary name for operating liability is Vendor Liability" (OM2 p.4). | **Should be $0.00 after all invoices are paid** (OPM p.42, p.60; OM2 p.47). Negative = unpayable negative invoice; positive = unpaid invoice OR revenue that never generated an invoice (typically housekeeper-costing config issues). |
| **Security Deposits Held (Escrow)** | Guest security deposits on hand. **Not impacted by disbursing** (OPM p.2). | Must equal the Security Deposits Held Report. Funds must be MANUALLY transferred from Security Deposit to the guest folio before they can be retained or refunded (OPM p.7). |

**When money is "earned" (revenue recognition):**
- A guest payment sits in GAD until the reservation's **disbursement/revenue-recognition rule** fires — generally check-in or check-out (CvD p.2; the company-wide logic is set at onboarding, MDR p.2). Only then do funds become available to pay owners, vendors, taxes, and management commissions.
- **Charging rules** (when the guest must pay — e.g. 50% at booking, balance 30 days before arrival) are entirely separate from **disbursing rules** (when the PMC may use the money) (CvD pp.2-3).
- Disbursement is driven by BOTH conditions: (1) a payment exists on the reservation, AND (2) revenue recognition has occurred/passed (OPM p.17). A reservation will not disburse without funds (DD p.4).
- **Payment date matters as much as stay date**: a reservation that checked out 1/31 but was paid on 2/5 will NOT appear on the January disbursement/owner statement unless the payment transaction date is backdated into January and a REDISBURSE is run — only possible if NO February disbursement has run yet (OPM p.21-22; OM2 p.17). This is the root cause of most month-boundary mismatches.
- The **disbursement itself moves no cash** — "You are NOT actually paying owners or vendors by completing disbursements" (OM2 p.14-15). It is a ledger re-allocation from GAD into Owner Balance / Vendor Liability / tax liability. Cash leaves the bank only at Pay Owners / Pay Vendors / tax remittance.
- Once disbursed, transactions for that timeframe are **locked**; later reservation modifications post on the NEXT disbursement (OPM p.18). Once a re-disbursement completes, the disbursement can never be deleted (OPM p.18).
- Owner charges not tied to a reservation ("Blue Fees" in OM2 p.14) do NOT flow through disbursement — they post directly to Owner Balance / Vendor Liability.

## 2. Money movement flows

Canonical flow (OPM p.2; OM2 p.4):

```
1. Guest payment made (Lynnbrook card charge, OTA payout, check, wholesale)
     ├── Security deposit portion → Security Deposits Held (escrow; untouched by disbursement)
     └── Everything else → Guest Advanced Deposits
2. Payment appears in Undeposited Funds Register → batched into Deposits
   to match actual bank deposits / processor batches (OPM p.8-9)
3. MANUAL disbursement runs (SuperUser only) for a specific past date:
   GAD is split per reservation into:
     • Room rent → owner share (per commission split) → Owner Balance
     • Management commission → Vendor Liability (payable to Mgmt Co)
     • Taxes → Tax vendor liability
     • Fees → fee vendor liability (cleaning vendor, PMC margin vendor, etc.)
4. Pay owners (ACH/check via owner statements), pay vendors (ACH/checks/NACHA),
   pay tax vendors — cash actually leaves the trust bank account
```

**Direct card payments vs OTA payouts:**
- Direct/Lynnbrook card payments post per-transaction; group them in Undeposited Funds to match **processor batch reports** (OPM p.8 explicitly says to match "batch reports from your credit card processor") — a Lynnbrook batch ≠ one reservation; it's N transactions minus timing.
- **OTA/wholesale payouts** (Airbnb, VRBO, Booking.com) arrive as lump-sum payments covering many reservations. They are applied via **Process Wholesale Statements** (Wholesale Payments → Generate Reports/Receive Money): pick the travel agent, check off the reservations covered, enter amount + check# (**Airbnb reference # can be used as the check#**), and set a **posting date that matches the bank statement** (OPM p.48-49; OM2 p.39-40). The posting date becomes the payment transaction date — on check-out recognition, a 10/31 checkout posted 11/1 will not disburse until November (OPM p.49). Save-and-approve makes payments appear on reservations.
- **Airbnb Resolution payouts** are applied via Folio Add-Ons using Travel Agent logic (OM2 p.7).
- **PDWTA / Post-deduct travel agents** (OTAs that deduct commission before paying) are paid/reconciled as vendors via PDWTA Statements Manager and Pay Invoices (OPM p.50; OM2 p.40-41).
- **Where Lynnbrook sits:** gateway between guest cards and the trust bank account. Every Lynnbrook batch deposit at Banc of California must decompose into Streamline undeposited-funds items; Lynnbrook merchant fees deducted from the account are recorded via the Mgmt–Bank Fee OTC (see §6 item R9).

**Non-owner transactions** (interest, bank fees, processing fees hitting the trust account) are recorded against a dummy unit **"Mgmt CO"** owned by **"Company Owner"** (OPM p.52; OM2 p.42):
- Interest earned → Post an Owner Charge, OTC "Mgmt - Interest earned into Trust Account" → shows as a deposit on the bank rec.
- Withdraw interest → OTC "Mgmt - Interest Earned - to Vendor" → creates invoice payable to the PMC, zeroes the Mgmt CO unit.
- Bank/CC-processing fees → OTC "Mgmt – Bank Fee – Charge to Trust Account" → shows as an expense on the bank rec.
- Bank fee refunds → Credit an Owner Account on Mgmt CO.
- Tax bill rounding variance → Transfer Vendor Funds on Mgmt CO (OPM p.54). **Warning:** vendor-fund transfers cannot be seen in any report; errors require an equal-and-opposite offsetting transfer (OPM p.37).

## 3. Charging vs disbursing rules (CvD guide)

- **Charging rule** = the portion of the reservation the guest must pay by a given time ("50% at booking, balance 30 days prior to arrival"). Collected funds sit as Guest Advanced Deposits until disbursement (CvD p.2).
- **Disbursement rule** = the moment GAD is recognized as revenue and becomes available to pay owners/vendors. Generally check-in or check-out (CvD p.2).
- Standard example (check-out recognition): guest pays in full Jan 27, arrives Feb 27, departs Mar 3 → all monies become disbursable Mar 3 (CvD p.2-3).
- Complex example: PMC wants its booking fee at time of booking → booking fee disburses immediately at first payment; remainder disburses at check-out (CvD p.3). Streamline warns this setup needs training review before use.

## 4. Distribution rules (MDR guide)

Distribution Funds Rules decide **where and when guest advance deposits flow** at disbursement:

- Defaults: a Default Rule (short term) and a Default Rule for Long Term, both following the system-wide revenue recognition logic (MDR p.2).
- **Remainder Amount Logic** — when the balance that didn't disburse at first payment disburses. Common override: check-out-logic PMCs with long-term rentals set Long Term to "Less than 1 day before Check-In" so monthly rent disburses at the start of the month (MDR p.2).
- **Rule enabled for** — short-term vs long-term reservation applicability (MDR p.3).
- **The First Payment area** — OVERRULES revenue recognition: sets a priority-ordered list of taxes/fees/rent/commissions and the % of each to disburse immediately from the guest's first payment (MDR p.3). Order matters: with $500 received, "Processing Fee 50% then Trip Insurance 100%" pays $125 + $375 (insurance short $25), while "Trip Insurance 100% then Processing Fee 50%" pays $400 + $100 (fee short $25). The next guest payment first tops up first-payment shortfalls, then the remainder follows Remainder Amount Logic (MDR pp.5-7).
- Custom rules are attached per unit on the House Details tab (two dropdowns: Distribution Funds Rule, and …for Long Term) (MDR p.5).
- Streamline's own warnings: numerous rules become "cumbersome to track and could cause trust issues"; always consult Streamline Accounting before changing (MDR p.1, p.3).
- Per-fee override: each tax/fee has "Disburse Fee at" = **Standard** (revenue recognition) or **Reservation Creation Date** (disbursable after first payment) (TFT p.3).

## 5. Month-end close checklist (MEC, ordered; near-verbatim)

Legend from doc: Blue = do frequently all month; Rust = a few times a month; Green = month-end only. Complete IN ORDER at close.

1. Post **Wholesale Payments**.
2. Run the **Checked Out with Balances Report** for the past 60 days; process needed payments / refund security deposits.
3. Run the **Housekeeper Cleaning Report** for the entire month; ensure all cleans are closed.
4. Run **predisbursement** for the day PRIOR to the last day of the month.
5. Review transactions using the **Nightly Receipts Report**.
6. Manage **Undeposited Funds**, making deposits in batches to match your bank deposits.
7. Review the predisbursement for accuracy.
8. Make any payment/fee corrections on reservations prior to disbursing.
9. If errors were corrected: delete the predisbursement and predisburse again to review.
10. Run the **Reservation Flags Report** — review cancelled reservations where funds are held indefinitely; modify/remove flags to allow disbursement where appropriate.
11. Run the **Guest Advanced Deposit Report** for the day of this last disbursement — review for reservations that should NOT appear given your revenue recognition; correct.
12. Run the **Reservation Owner Commission Discrepancy Report** for the same day — find reservations not following the expected owner commission split; correct.
13. Review **work orders** in the pending-final-close queue — values must match actual owner/guest charges AND vendor invoices received; then close-charge. If a work order charged the guest, process the payment on that reservation (it will resurface on Checked Out with Balances).
14. If corrections were made: delete and re-run the predisbursement.
15. **Complete the disbursement** (for day prior to month end).
16. Check **recurring owner charges** that should post; match values to vendor invoices.
17. Post additional **owner charges/credits** to generate invoices matching vendor invoices received.
18. Process **held owner charges** to approve for payment based on owner's available revenue.
19. **Regenerate owner statements** for the month; review via PDF. Do this BEFORE moving on — once a vendor or owner is paid the disbursement is locked.
20. Correct any owner-statement errors now (owner charge amounts can be fixed on the unit's owner balance tab — but NOT if the charge was already paid).
21. Run **predisbursement for the LAST day of the month**; review; correct; then **complete the disbursement**.
22. Process **held owner charges** a final time. If desired, receive an owner payment to cover expenses that lack revenue.
23. Run **trust reports** and review for accuracy — all dated the last day of the month: Account Summary; Guest Advance Deposit; Property Trial Balance; Security Deposit (if applicable).
24. Regenerate owner statements a final time; review PDFs.
25. **Approve, pay, and email owner statements** (ACH first, then checks — OPM p.51).
26. Pay **travel agents**.
27. Pay **booking/commissioned agents**.
28. Pay any remaining **vendor invoices** (Pay Invoices area).
29. Post **bank fees / interest**.
30. Complete **bank reconciliation** to match the month-end bank statement.
31. Final check: re-run the four trust reports for month end (Account Summary, GAD, Property Trial Balance, Security Deposit — all last-day-of-month).
32. **Close the accounting period** so historical financials are locked; any later corrections must be made in the present period.

OM2 p.6 additions to monthly list: review Flags Report; review GAD report after disbursement; "Pay Vendors → process tax payments and record any variances."

Timing rule (OPM p.50; OM2 p.41): on the 1st of the month, confirm a disbursement exists for the second-to-last day, then predisburse/disburse for the last day of the prior month. **Do not run ANY next-month disbursement until the prior month is closed** (OPM p.18) — doing so permanently forfeits the REDISBURSE window for late payments.

## 6. Reconciliation points (exhaustive)

Every X↔Y match the manuals demand. These are the assertions our agents should test.

**R1. Bank statement ↔ Streamline bank register (the Bank Reconciliation).**
"There should never be transactions on the bank statement that cannot be accounted for in Streamline" (OPM p.12). Key element to pass an audit; auditors expect recs to balance AND adjusted ledger = ledger (OPM p.12). Mechanics: enter statement begin/end dates + actual beginning/ending balances; check off each Streamline deposit/expense found on the bank statement; do NOT check items not on the statement (OPM p.13). Recommended at least 1×/week, required monthly (OPM p.3).
- **R1a.** Difference = Calculated Ending Bank Balance − Actual Ending Bank Balance must be **$0.00** to process (Calculated = Beginning + Deposits Cleared − Expenses Cleared) (OPM p.14-15). OM2 p.13: the system will not let you process unless Difference is $0.
- **R1b.** **Adjusted Bank Balance ↔ Ledger Balance** must match. OPM p.15: the rec WILL still process if they don't match — "you must research and fix this variance, as this is an indicator that your system is out of trust." This is the single most load-bearing trust check.
- **R1c.** Uncleared items become Deposits-in-transit / Expenses-in-transit and auto-carry into next month's rec (no "load past history" needed) (OPM p.13-15).

**R2. Undeposited Funds batches ↔ actual bank deposits (and processor batches).**
Group undeposited payments so each posted Deposit equals a bank-record deposit and matches credit-card processor batch reports (OPM p.8). Selected-transactions total (green) must match the amount deposited at the bank (OPM p.9). Post as one grouped entry or individually — "select the one that will match your bank statement" (OPM p.9). Deposits can be deleted (trash can) which reverts items to undeposited without touching the reservations (OPM p.10).

**R3. Trust Account Summary top ↔ bottom (liabilities ↔ cash).**
The ending-balance total of the top portion (Owner Balance + GAD + Vendor Liability + Security Deposits Held) must exactly match the ending-balance total of the bottom portion (undeposited funds + cash ledger accounts) (OPM p.43, p.61; OM2 p.31, p.47). = "total liability vs total cash," the trust equation.

**R4. Account Summary ↔ Property Trial Balance.**
Same date, include INACTIVE units; totals of every account must match. Discrepancy → drill in with Account Summary Detail (OPM p.54, p.61; OM2 p.43, p.48). Per-unit rule: **no negative balances for any unit** unless intentionally overdrawn (OM2 p.48).

**R5. Account Summary GAD ↔ Guest Advanced Deposits Report.**
Same date; totals must match; "all 3 reports must match" (Account Summary, Property Trial Balance, GAD Report) (OPM p.61).
- **R5a.** No reservation on the GAD report whose check-in/check-out (per your revenue recognition) is before the report date — past reservations here mean undisbursed money; review and correct (OPM p.43, p.61; MEC p.2).
- **R5b.** No negative Advanced Deposits Balance for any reservation — sole exception: a refund issued after disbursement, which self-corrects at the next disbursement's reversal entries (OM2 p.48).

**R6. Account Summary Owner Balance ↔ owner statements.**
Owner Account Balance must equal the total of the owner-balance column across all generated statements for the timeframe; mismatch typically = an inactive unit holding funds with no statement generated (OM2 p.47).

**R7. Account Summary Vendor Liability ↔ outstanding vendor invoices.**
Must equal total outstanding invoices; **$0.00 after all invoices are paid** (OPM p.42, p.60; OM2 p.47). Negative → an unpayable negative invoice; positive → unpaid invoice or revenue that generated no invoice (housekeeper-costing config) — investigate immediately.

**R8. Account Summary Security Deposits Held ↔ Security Deposits Held Report.**
Must match; discrepancy investigated immediately (OM2 p.47; OPM p.54).

**R9. Bank fees & interest ↔ Streamline postings.**
Every interest credit and bank/processor fee on the bank statement must be posted (Mgmt CO unit OTCs) so the bank rec balances (OPM pp.52-54; OM2 pp.42-43; MEC p.3).

**R10. Wholesale/OTA payout ↔ covered reservations.**
Each OTA lump payment must be fully allocated across its reservations at the exact payout amount, posting date matching the bank statement date (OPM p.48-49). Checked Out with Balances is the verification report that all wholesale payments got applied (OPM p.6). Tax variances on tax payments recorded via Transfer Vendor Funds (OM2 p.6, p.43).

**R11. Checked-out reservations ↔ $0 folio balance.**
Checked Out with Balances (past 60 days at close) must be empty of: unpaid folios, guest-charged work orders without payment, and unapplied wholesale payments; also run with negative balances shown to catch guest refunds due (OPM p.6; OM2 p.7; MEC p.1). Daily variant: Check-in (or Check-out) Range Report — balance due must be $0 before disbursing (OPM p.5).

**R12. Reservation commission splits ↔ unit commission splits.**
Reservation Owner Commission Discrepancy Report, run for the disbursement date range (date type matching revenue recognition): any reservation listed deviates from its unit's split; fix before disbursing (OPM p.44; MEC p.2; OM2 daily task p.5).

**R13. Pre-disbursement ↔ expected amounts.**
Always predisburse first; review room revenue / owner payable / mgmt-co payable / fees / taxes / travel-insurance subtotals per reservation before disbursing; delete + re-predisburse after any correction (OPM pp.18-20; MEC pp.1-3).

**R14. Work orders ↔ vendor invoices ↔ owner/guest charges.**
Pending-final-close values must match actual charges AND vendor invoices before close-charge (MEC p.2). Never modify labor/parts on a closed WO without rolling it back to pending; never delete a closed WO that created an invoice (OPM p.27; OM2 p.24).

**R15. Recurring & posted owner charges ↔ vendor invoices received.**
Match recurring-charge values to the actual vendor invoices each month; post additional charges/credits so Streamline invoices equal vendor paper (MEC p.2).

**R16. Held owner charges ↔ owner available funds.**
Vendor invoices are held until the owner/unit has funds; releasing with negative balance "could cause your Trust Account to overdraw" (OPM p.36; OM2 p.25 — company variable "Allow to Process with Negative Balance" exists but is not recommended).

**R17. Flags Report ↔ held cancelled-reservation funds.**
Monthly: find reservations flagged Block Distribution / Money Held; confirm funds should still be held or release (MEC p.2; OM2 p.6). Cancellations with "refund if rebooked" policies require daily tape-chart checks; refund MUST occur prior to revenue recognition (OM2 p.22).

**R18. Housekeeping cleans ↔ closed status** for the month being closed (MEC p.1).

**R19. Nightly Receipts ↔ payments taken.**
Totals all guest/owner/client payments by payment type for a period — the payments-side audit trail feeding R2 (OPM pp.10-11).

**R20. Account Summary Detail (Audit Summary) — transaction-level debit=credit.**
When any of R3–R8 fail, export Account Summary Detail to Excel, pivot on Description/Deposits/Withdrawals: "Every transaction should have a debit and a credit. Any transaction that does not balance to $0 is a discrepancy" (OPM p.55; OM2 p.44). Streamline KB has dedicated articles per mismatch type: Total Cash vs Total Liability, Owner Liability, Guest Advanced Deposit, Vendor Liability, Security Deposit (OPM p.55).

**R21. Period close gate.**
Close the accounting period only after bank rec + trust reports pass; closing locks historical reports, prevents backdating, and restricts disbursing to between period-close dates (OPM p.56; OM2 p.44). Imbalances discovered later are managed in the NEW month (OPM p.4).

## 7. Dos and Don'ts (DD, condensed)

**DO**
- Know your state trust laws; never commingle company and owner funds; two bank accounts (operating + trust); Streamline tracks ONLY the trust account (p.3).
- Payment gateway must be connected to the (new) trust bank account (p.3).
- Verify owner/management commission splits on ALL units — wrong splits force per-reservation fixes (p.4).
- **ALWAYS disburse on the last day of the month** — otherwise revenue disburses wrong and owner statements are wrong. Best practice: disburse day-prior, adjust, then disburse the last day (p.4).
- Apply payments to reservations BEFORE disbursing — no funds, no disbursement. Backdate the payment transaction date when the owner should be paid in a prior month (p.4).

**DON'T / NEVER**
- Don't put payments on pre-go-live reservations (checkout before go-live = historical only) (p.5).
- **Never pay vendors before reviewing owner statements** — a paid vendor invoice can never be corrected (only a visible negative owner charge) (p.5).
- Never close/charge a work order without verifying charges — it can't be reopened after close-charge-and-pay (p.5).
- Never unapprove an owner statement after paying owners (p.5).

Related hard rules from OPM/OM2: never disburse "today"; can't disburse into the future; can't disburse before the last disbursement date (a later run sweeps everything owed since) (OPM p.18). Only SuperUsers can disburse (OPM p.17). Owner charges can't post to closed statements; modified charges reflect on the change date, not the original posting date (OPM p.29). Owner-fund transfers can't be deleted — only offset (OPM p.48).

## 8. Tax & fee terminology glossary (TFT)

- **Tax** — %-based, calculates on room rate + any item marked taxable (p.1).
- **Fee Tax** — %-based tax applied only to specific fees, not room rate (e.g. county tax applying to fees where state tax doesn't) (p.1).
- **Per Pet / Per Extra Guest / Per Guest / Nightly Fees** — multipliers on pets, guests over standard occupancy, all guests, nights respectively (p.1).
- **Add-On / Folio Item** — PMC-posted fee added to a folio after booking (p.1). **Optional Fee** — guest-selectable at booking (p.1). **Purchasable Amenity** — optional fee variant with its own checkout page (p.2).
- **Unique Per Unit** — one fee, per-unit values (typical for cleaning fees) (p.2). **Base Rules** — length-of-stay limits on when a fee charges (p.2). **Periods** — date-ranged fee value changes (p.2). **Middle/Long Term tab** — charge frequency for stays crossing months (p.2).
- **Tax/Fee Recipients** (who gets the money — this drives disbursement routing) (p.2-3): **Vendor** (often the PMC → operating account); **Vendor + margin vendor** (external vendor with a PMC margin slice); **Owner** (all to owner); **Owner w/ Margin to Vendor**; **Include in Gross Rent Payout** (split by the owner's commission %).
- **Disburse Fee at** — Standard (revenue recognition) vs Reservation Creation Date (after first payment) (p.3).
- **Reservation types** (p.3): STA standard; OWN owner block (no rent); NPG non-paying guest of owner; PGO paying guest of owner; OWN-SC owner self-clean (no cleaning generated/charged); HAFamL & Airbnb-NI = pre-go-live VRBO/Airbnb imports (onboarding only); HAFamOLB = VRBO instant booking; SC-ABnB = Airbnb integrated booking.
- **Reservation sources** (p.4): FDR front desk; ADM admin; OWN owner app; WSR wholesale (TA/OTA); NET website/XML API; PDWTA post-deduct wholesale TA. Best practice: don't limit fees by source; limit by reservation type.
- **OTC (Owner Transaction Code)** — the transaction-type config behind every owner charge; determines whether a vendor is required and whether an invoice is generated (OPM p.28). No-vendor OTCs (bank fee, interest) post straight to the bank rec.
- **Margin / Markup** — the slice of a vendor charge that pays to the PMC's margin vendor; invisible to the owner (owner sees vendor cost + markup as one total) (OPM p.26, p.29).
- **PDWTA** — Post-Deduct Wholesale Travel Agent (OTA that nets out its commission); paid as a vendor (OPM p.50).
- **GAD** — Guest Advanced Deposit. **FAE** — Fund At Event: payments received at reservation-time vs pay-time filter on Undeposited Funds (OPM p.8).

## 9. Automation opportunities (synthesis)

**Fully mechanical — automatable now (deterministic rule + data match):**
1. **Bank rec matching (R1, R2)** — match Banc of California bank-feed lines (via Intacct) to Streamline deposits/expenses; batch undeposited funds to equal actual deposits; compute Difference and Adjusted-vs-Ledger deltas. This is set arithmetic + fuzzy date/amount matching. Streamline's Lynnbrook Auto Bank Reconciliation shows the vendor itself considers it automatable.
2. **The trust equation (R3) and cross-report ties (R4, R5, R6, R7, R8)** — run the 4 trust reports for the same date and diff totals. Pure report-scrape + compare; every check has a binary pass/fail defined in the manuals.
3. **Exception screens (R5a, R5b, R11, R12, R18)** — "no past-dated reservations on GAD," "no negative unit balances," "no checked-out folios with balances," "no commission discrepancies," "all cleans closed." Each is an empty-set assertion on a filtered report.
4. **OTA payout 3-way match (R10)** — bank deposit ↔ OTA payout report (Airbnb/VRBO/Booking CSVs) ↔ Streamline reservations covered. Deterministic on confirmation codes + amounts; this is the core of our OTA auditor.
5. **Nightly receipts ↔ processor batch tie-out (R19 → R2)** — Lynnbrook batch totals vs Streamline payments by type/day.
6. **Drift sentinels** — daily watch for: disbursement not run for day-prior at month end; disbursements run into a new month before prior close; bank fees/interest on the bank feed not yet posted to Mgmt CO; wholesale payments received but not applied; flags (Block Distribution) older than N days.
7. **Account Summary Detail debit/credit sweep (R20)** — the manual literally prescribes an Excel pivot to find non-$0 transactions; a script does this perfectly and points at the exact offending transaction IDs.

**Automatable with human approval gate (agent prepares, human clicks):**
8. **Pre-disbursement review (R13)** — agent diffs predisbursement vs expected model (commission splits, fee routing, tax rates) and flags anomalies; a human approves the actual Disburse because it locks transactions and sequencing errors (disbursing into a new month) are irreversible.
9. **Held owner charge release (R16)** — agent computes which charges have covering funds; human approves release (overdraw risk).
10. **Month-end orchestration (§5)** — agent runs the checklist as a state machine, executes the read-only steps, queues the mutating steps (disburse, approve statements, pay owners/vendors, close period) for one-click human sign-off. The ordering constraints (statements before vendor pay; disburse before statements; close before next-month disburse) are exactly the kind of sequencing humans get wrong and machines don't.

**Genuinely needs human judgment:**
11. **Root-causing an out-of-trust condition (R1b failure)** — the manuals themselves punt to KB articles + investigation; causes range from config to fraud. Agent's job: detect on day 1 (not day 30), assemble the Account Summary Detail evidence, and propose hypotheses.
12. **Cancellation fund dispositions** — retain vs refund vs hold-for-rebooking is policy + guest-relations judgment (OM2 pp.18-22); agent can enforce the mechanics (refund before revenue recognition, folio ends at $0).
13. **Work-order charge verification (R14)** — comparing a plumber's paper invoice to the WO is judgment until we have invoice OCR + vendor history; irreversible once paid.
14. **Distribution-rule changes (§4)** — Streamline says consult their accounting team first; config changes ripple across all existing reservations. Never automate; alert when actual disbursement routing deviates from documented rules.
15. **Backdating decisions** — backdating a payment transaction date to pull revenue into a prior month (DD p.4; OPM p.21) is legitimate but audit-sensitive; agent flags candidates, human decides.

**Design implication for the Accounting Center:** the manuals define ~21 named reconciliation assertions (R1–R21), almost all of which are report-diff operations Streamline expects a human to eyeball monthly. Our reconciliation agents should run R1–R12 + R18–R20 daily, not monthly — every assertion is cheap, and the manuals' own refrain is that "catching these issues early allows for faster remedies" (OPM p.62). The month-end close then becomes a verification that 30 green days accumulated, not a discovery exercise.
