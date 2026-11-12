# Points K transfers and Link Pay: API boundary

Internal user transfers and Link Pay network processing belong to the API. ERPNext remains the
merchant invoice/accounting integration and the Quotation → Sales Order → Payment Request source
for Points K purchases. This change does not modify PSP credentials, purchase routing or approvals.

## Runtime

- A send uses `k_operations` with two balanced, immutable `ledger_entries`. Completion requires the
  matching Funded intent and authorization reference in the same transaction. Balance and history
  read these entries. KYC, session ownership, OTP, wallet controls, reservations and locks remain.
- Link Pay resolves its current approved terms in `link_pay_beneficiary_terms` and locks the reference
  during payment. The issued link keeps its frozen fees. No network ERPNext read or acknowledgment
  participates in confirmation. Confirmation requires the completed K operation and transaction.
- Only the merchant accounting webhook is queued, atomically with payment. Signed delivery,
  processing leases, backoff, dead letters and the authenticated redelivery endpoint are reused.
  Delivery failure never changes the ledger or the payment response/status.
- A network routing key may remain in `LINK_PAY_FRAPPE_SITES` for compatibility; it needs no ERP URL,
  service account or webhook secret. Merchant invoice authentication and webhook settings remain.

## Release order and existing data

1. Back up PostgreSQL and export the current approved collection terms/evidence using existing
   administrative access. Do not infer approval from an old link or invent a fee/payout configuration.
2. Pause Link Pay issuance/payment and the outbox worker during the migration/code cutover, avoiding
   delivery by an old worker while its leases/payloads are being migrated.
3. Apply migrations 238 and 239 with the normal migration runner. Migration 238 extends the existing
   K ledger; 239 adds the independent commercial reference, cancels outstanding network-only ERP
   projections and releases merchant deliveries only for completed ledger payments. Delivered
   history stays intact. Historical Link Pay outbox messages are consumed without network ERP calls.
4. Import the authorized, reviewed JSON export into the API reference:
   `node scripts/import-link-pay-terms.mjs /secure/path/approved-export.json` using the usual secured
   DATABASE_URL injection. Fields: network_site, beneficiary_site, beneficiary_name, country (ISO2),
   enabled, approved, approved_by, approved_on, terms_hash, fee_mode (Percentage/Exempt), fee_rate_bps,
   payout_ready. Flags are booleans; approved_on is ISO8601 with an explicit UTC offset. Preserve original approvals; the importer cannot create them.
   It rejects stale exports, audits before/after values and does not duplicate identical imports.
5. Deploy the validated API/worker together, restore processing and check ledger payment status
   separately from merchant delivery status. Existing approved references must be imported before
   enabling Link Pay. Missing or revoked configuration fails closed, without a network ERP fallback.

Rollback: retain the pre-release backup and previous image. Before any new K sends, a coordinated
code/data rollback is possible. After new operations complete, retain migrations and their ledger
proofs; pause the affected routes and correct forward. Never restore an old database over newer
financial operations or delete completed ledger entries. Old application code cannot execute the
new pure K-send path and must not be used as a transparent transfer rollback.

## Isolated verification

Run the normal typecheck and REST suite. On a disposable local `konektag_test` PostgreSQL database,
apply all migrations and run the four files listed by the `points-k-postgres` CI job. Financial fixture
opening balances are synthetic; commands under test use normal triggers and constraints. HTTP
Frappe doubles are local. No PSP transaction, live callback or shared ledger write is used.
