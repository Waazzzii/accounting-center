# Streamline API Probe Results — Payout Composition & Trust Balances

**Date:** 2026-07-15
**Probe scope:** Read-only exploration via the Streamline MCP server (`call_streamline_method` passthrough + typed tools). ~30 calls.
**Key constraint discovered:** the API token has a method **allowlist**. `E0014 "Method is not allowed for this token"` is returned both for nonexistent methods and for real methods outside the allowlist (proven: the typed `get_unit_owner_balance` tool itself returns E0014, so real accounting methods are being blocked by token permissions, not absence).

---

## 1. Methods that WORK

### GetTransactionTypes (typed: `get_transaction_types`)
Params: none.
Returns the full owner-side charge/credit category list (~95 codes). Useful for classifying owner-ledger activity, incl. which categories route to vendor payables (`use_vendor_logic`).

```json
{ "data": { "transaction_codes": [
  { "id": 130445, "name": "B7DG", "description": "Management Fee", "use_vendor_logic": 1 },
  { "id": 130444, "name": "B7DF", "description": "Room Revenue", "use_vendor_logic": 1 },
  { "id": 130425, "name": "*Maintenance - Parts & Labor Vendor Payable", "use_vendor_logic": 1 },
  { "id": 134712, "name": "Vacasa Account Balance Transfer as of 2/28/26", "use_vendor_logic": 1 }
]}}
```

### GetReservationsFiltered (typed: `get_reservations_filtered`)
Params used: `{ "arriving_on": "05/15/2026", "return_full": true }` → 88 reservations. Also supports `arriving_after/before`, `departing_*`, `modified_since`, `unit_id`, `status_code`.
Fields per reservation (trimmed): `confirmation_id`, `unit_id`, `type_name` (channel: `SC-ABnB`, `VRBO - NI`, `SC-Booking.com`, `VACASA.COM`, `OWN`, …), `cross_reference_code` (**the OTA confirmation code**, e.g. `HMC3CRHP89`), `price_total`, `price_paidsum`, `price_balance`, `startdate`, `enddate`, `status_code`, `travelagent_name`.

```text
confirmation_id=17501  type=SC-ABnB  unit=1050966  xref=HMC3CRHP89  total=374.59  paid=374.59  balance=0
confirmation_id=17426  type=SC-ABnB  unit=1039450  xref=HM8WPADXXJ  total=4732.32 paid=4732.32 balance=0
```

### GetReservationInfo (typed: `get_reservation_info`)
Params used: `{ "confirmation_id": 17501, "show_payments_folio_history": true, "return_payments": true, "show_taxes_and_fees": true, "include_security_deposit": true, "show_owner_charges": true }`.
Returns full reservation detail + **folio/payment history**. The wholesale payment applied by the Airbnb payout IS visible:

```json
"payments_folio_history": { "record": [ {
  "date": "05/16/2026 16:27:08",
  "transaction_date": "05/16/2026 04:16:55",
  "type": "Wholesale Payment",
  "description": "Transaction by System Account",
  "amount": "-$374.59",
  "payment_description": "Airbnb Wholesale Payment via API payout_notification action"
} ] }
```

Also returns `expected_charges`, `taxes_and_fees` (each fee with `disburse_date`), `maketype_description: "Wholesale Reservation"`. **No payout reference / check number field is exposed.**

### GetReservationPrice (typed: `get_reservation_price`)
Params used: `{ "confirmation_id": 17501, "return_payments": true, "show_payments_folio_history": true, "show_owner_charges": true }`.
Adds: `is_wholesale: 1`, per-night breakdown, required/optional fees, owner charges, and the folio record **with an internal payment transaction id**:

```json
"payments_folio_history": { "record": {
  "id": 34399253, "date": "05/16/2026 16:27:08 MST",
  "type": "Wholesale Payment", "amount": "-$374.59" } },
"security_deposits": { "security_deposit": [
  { "ledger_id": 2506, "description": "Guest Security Deposit", "deposit_required": 0 },
  { "ledger_id": 2510, "description": "Refundable Utility Deposit", "deposit_required": 0 } ] },
"owner_charges": { "owner_charge": {
  "owner_transaction_date": "05/15/2026",
  "description": "AZ-Southern - APP for reservation # 17501 date:05/15/2026", "owner_amount": 12 } }
```

### GetMonthEndStatement (typed: `get_month_end_statement`) — allowed
Called with empty params via passthrough → `E0191 "Owners statements was not found"` (a data error, **not** a permission error, so the method is on the allowlist). Requires `owner_id` + `startdate`; returns statement metadata (id, location, date range, status 1=Pending/2=Confirmed/6=Expired) and **PDF links** — not structured line items.

---

## 2. Methods that do NOT work (`E0014` — blocked or nonexistent)

**Wholesale / payout family:** GetWholesaleStatements, GetWholesaleStatementsList, GetWholesaleReservations, GetTravelAgentsList, GetTravelAgentStatements

**Payments / ledger family:** GetReservationPayments, GetPayments, GetPaymentsFiltered, GetTransactionsFiltered, GetFolioTransactions, GetChecksList, GetDepositsList, GetBankDeposits, GetStatementsList, GetInvoicesList

**Owner / trust family:** **GetUnitOwnerBalance (blocked even via its typed MCP tool)**, GetOwnerBalances, GetOwnerTransactions, GetOwnerCharges, GetOwnerStatementsList, GetAccountSummary*, GetTrustAccountSummary*, GetAdvanceDeposits, GetGuestAdvancedDeposits, GetGuestsDeposits, GetSecurityDepositsHeld, GetVendorInvoices, GetVendorsList

\* Cannot distinguish "doesn't exist" from "not allowlisted". The `get_unit_owner_balance` case proves at least some of these are real methods blocked by token permissions.

---

## 3. Assessment

### A. Per-payout reservation composition — PARTIAL, workaround viable
- **What we get:** every OTA reservation's folio shows a `Wholesale Payment` record with exact amount and the payout-notification timestamp (`transaction_date`), plus `cross_reference_code` (Airbnb HM-code) and paid/balance status. So we know *which reservations were paid, when, and for how much*.
- **What we don't get:** the wholesale-statement / check reference number that groups reservations into one ACH. No accessible endpoint returns statement-level objects.
- **Best path:** sweep reservations (`get_reservations_filtered` by date window, `return_full`) → per-reservation `get_reservation_info` with `show_payments_folio_history` → **group Wholesale Payment records by channel + `transaction_date` (payout date)** → match the group sum to a BofC bank line (sage-deposit-sync data). The payout scraper (wave 2) supplies the Airbnb-side payout reference to close the loop. Caveat: N+1 call pattern (no bulk payments endpoint is allowed), so scope sweeps to the reconciliation window.

### B. Trust-liability components — 1 of 4 computable today
| Component | Status | How / gap |
|---|---|---|
| Guest advanced deposits (GAD) | **Computable** | Sweep future-arrival reservations via `get_reservations_filtered`; sum `price_paidsum` where arrival > today. |
| Owner balances | **Blocked** | `GetUnitOwnerBalance` exists but is off the token allowlist. Only fallback is parsing month-end statement PDFs (`get_month_end_statement`) — fragile. |
| Security deposits held | **Partial** | Per-reservation `security_deposits` ledgers visible via `get_reservation_price` (portfolio mostly uses damage waiver, `deposit_required: 0`). No bulk `GetSecurityDepositsHeld`. |
| Vendor liability | **Blocked** | No vendor invoice/payable endpoint allowed. Only signal: transaction types flagged `use_vendor_logic`. |

### What's missing / next action
Ask Streamline support to add to the token allowlist: `GetUnitOwnerBalance` (and any owner-balance bulk variant), owner-ledger transaction methods, and whatever method backs the Accounting > Wholesale Statements screen (exact name unknown — the screen may be UI/report-only). Until then: GAD and payout composition come from the reservation-level API; owner balance, vendor liability, and the payout reference # must come from Sage / the payout scraper / statement PDFs.

---

## Pilot results (2026-05-26 batch)

**Question:** can Wholesale Payment folio records reconstruct which reservations compose each Airbnb bank deposit? **Target:** the ten "AIRBNB PAYMENTST" ACHs on GL 102110 dated 2026-05-26 (39,490.22 / 29,979.09 / 26,612.15 / 16,127.47 / 7,909.53 / 6,404.89 / 2,958.21 / 1,720.38 / 970.38 / 882.14 — total $133,054.46).

**Data pulled (2026-07-15):** 254 airbnb reservations in `reservations_cache` with check_in 2026-05-18..05-26. Folio history fetched via MCP `get_reservation_info(show_payments_folio_history)` for 74 of them — complete coverage of the 05-23/05-24/05-25 check-in cohorts + 10 spot checks in earlier cohorts (call budget stopped a full sweep; ci 05-21 has 45 and ci 05-22 has 111 unfetched). 78 Wholesale Payment records extracted → `fixtures/streamline/wholesale-payments-pilot.json`. (Direct-API sweep was attempted first but the `.env` STREAMLINE_API_KEY/SECRET are rejected with E0010 "Token is invalid" at `web.streamlinevrs.com/api/json` — stale creds; the MCP connector works.)

### Mechanics confirmed
- Every paid-out reservation carries a `Wholesale Payment` record with exact payout amount and `transaction_date` = the payout_notification timestamp. Records written by one notification batch share a timestamp to within a few seconds (e.g. `05/25/2026 02:03:29` ×4, `05/24/2026 03:46:31` ×8).
- **Settlement lag:** notification day + 1 business day. Memorial-day weekend notifications (Fri 05/22–Mon 05/25) all settled Tue 05/26 — hence ten ACHs on one day. Check-in 05/25 reservations notified 05/26 and are correctly *absent* from this batch (negative control ✓).
- **Payout amount ≠ reservation total** in general: alterations/extensions pay out in parts (e.g. conf 18202: 556.01 + 154.87 on different days; conf 18375: 2,025.60 + 368.59; conf 18042 (45-night stay): 3,539.73 + monthly installments in June). The folio record amounts are the ground truth.
- **Not all payouts land in GL 102110.** In-window notifications for AZ-market units (e.g. the 05/25 04:12 cluster: Pine House, Flagstaff Fantasy, Canyon Lookout… = $1,767.04) match none of the ten ACHs — they route to other bank accounts. The folio record does NOT expose the payout bank account, so multi-account mornings must be resolved by sum-matching.

### Decomposition of the ten ACHs (timestamp-cluster method)
| ACH 05/26 | Status | Composition |
|---|---|---|
| $6,404.89 | **MATCHED exact** | notify 05/25 01:51:51 — conf 17658 ($2,300.30), 18375 ($2,025.60 partial), 18377 ($2,078.99) |
| $7,909.53 | **MATCHED exact** | notify 05/25 02:03:29 — conf 16125 ($1,879.23), 16126 ($1,770.18), 16217 ($1,696.22), 16423 ($2,563.90) |
| $1,720.38 | **MATCHED exact** | notify 05/25 05:25:21 — conf 17936 ($1,720.38) |
| $2,958.21 | **MATCHED exact*** | notify 05/23 04:14:46–51 — conf 16068 ($1,327.20), 15676 ($598.41), 15978 ($407.15), 16591 ($625.45). *Exact sum, but the 05-22 cohort is only spot-checked, so membership is high-confidence-not-proven |
| $26,612.15 | Partially explained | notify 05/25 02:14:51 cluster: 23 records summing $21,541.66 (81%) identified; residual $5,070.49 must be delayed/split payouts from unfetched ci ≤ 05-22 folios |
| $16,127.47 | Partially explained | 05/24 notify clusters: $14,371.52 of member records identified (02:13/02:46/03:46/04:13/11:51 timestamps); residual $1,755.95 unfetched |
| $39,490.22 | Unexplained (data gap) | composition sits in the unfetched ci 05-21/05-22 folios (notify 05/22–05/23) |
| $29,979.09 | Unexplained (data gap) | same |
| $970.38 | Unexplained | likely includes conf 17937 ($242.99, notify 05/25 05:25:20); remainder unfetched |
| $882.14 | Unexplained | unfetched |

Fully decomposed: **4 of 10 ACHs**; member records identified for ~$55k of the $133k batch (≈41% of dollars, limited purely by fetch budget, not by the method).

### Key negative finding — subset-sum on cache totals is NOT safe
A naive subset-sum of `reservations_cache.total_amount` against the ten ACH amounts "explained" 9/10 ACHs to the cent — and the folio data proved at least two of those compositions **wrong** (the true $7,909.53 and $6,404.89 members are different reservations sharing a payout timestamp). With 254 candidates the combinatorics produce exact-cent false positives. Composition must be timestamp-anchored folio records, with subset-sum only *within* a notification-day pool (to split same-morning multi-account batches).

### Verdict & scaling
The approach works and scales, with one requirement: **full folio sweep of the check-in window** (check_in from settlement−5d to settlement−1d, ≈250 reservations/week, N+1 `GetReservationInfo` calls — no bulk endpoint on the allowlist). Recommended production shape: nightly incremental job pulls folios for reservations with check_in in the last 7 days (plus open long-stays), upserts a `wholesale_payments` table keyed on (confirmation_id, transaction_date, amount), then the matcher groups by notification day, subset-sums against each bank ACH within that day, and flags residuals. The unresolved gap remains the payout→bank-account mapping (folio has no account field); the Airbnb payout scraper (wave 2) or per-listing payout-routing config is needed to pre-partition multi-account mornings.
