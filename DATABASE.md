# Database

Cloudflare D1 (SQLite). Migrations live in `migrations/` and are applied with
`wrangler d1 migrations apply`. The schema is never edited by hand in production.

## The design principle

Where a financial rule must hold, it holds **in SQL**, not in application code. Application code
can be bypassed by a new code path, a migration script, an admin query or a bug; a unique index
cannot.

`node scripts/verify-schema.mjs` proves all 30 invariants against a real SQLite database and prints
what each one blocked. Run it after any migration change.

---

## Tables

### Identity and access

| Table | Purpose |
|---|---|
| `users` | Accounts. `role` ∈ MERCHANT / SUPER_ADMIN / ADMIN / SUPPORT / FINANCE / VIEWER. `status` ∈ PENDING_APPROVAL / ACTIVE / REJECTED / SUSPENDED / BANNED. |
| `merchant_profiles` | Business data, display name and logo, support contact, verified Telegram link, per-merchant settings overrides, setup progress. |
| `api_keys` | `lookup_id` (indexed), `key_hash` (peppered HMAC-SHA256), `key_hint`, environment, scopes, IP allowlist, last-used. The raw key exists only in the response that created it. |
| `sessions` | Hashed session tokens with expiry and revocation reason. |
| `login_attempts` | Every attempt, including for unknown mobiles — a spray against non-existent numbers is worth seeing. |

### Money

| Table | Purpose |
|---|---|
| `bank_cards` | Receiving cards. `number` is stored in full (it is displayed publicly so customers can transfer to it), plus `number_hash` for duplicate detection and `number_masked` for every list view. |
| `invoices` | The core record: original / customer fee / merchant fee / gateway fee / base / suffix / payable / received / net, plus status, expiry, environment and the matched transaction. |
| `payments` | Payment identifiers and lifecycle, one per invoice. |
| `transactions` | A confirmed settlement: amount received, fees, net, bank reference, match score and reasons, automatic vs manual. |
| `transaction_fingerprints` | Composite dedupe keys (`merchant + amount + time bucket + reference`) for when a bank sends no usable reference. |
| `wallets` | `balance`, `reserved_balance`, `total_deposited`, `total_fees_paid`, `total_adjustments`. |
| `wallet_ledger` | Append-only. Every movement with `balance_before`, `balance_after`, type, reference and an idempotency key. |
| `idempotency_keys` | One row per `(merchant, key)`, with the stored response so a replay is byte-identical. |

### SMS

| Table | Purpose |
|---|---|
| `sms_messages` | `raw_message` is never edited, never truncated. `message_hash` is `sha256(merchant ‖ normalised raw)` for duplicate detection. `parse_status`, `parser_used`, `client_received_at` (untrusted) and `server_received_at` (authoritative). |
| `sms_parser_results` | The extracted fields and confidence, kept separate so the parser can improve without rewriting evidence. |

### Operations

| Table | Purpose |
|---|---|
| `webhook_endpoints` | URL, encrypted secret, subscribed events, active/disabled state, consecutive failure count. |
| `webhook_deliveries` | One row per attempt: delivery ID, event, request/response, status, duration, retry count, next retry. |
| `webhook_delivery_attempts` | Per-attempt history for the delivery log. |
| `notifications`, `notification_reads` | In-app notification centre. |
| `notification_log` | Dedupe keys and cooldowns, so a low-balance warning is not sent on every invoice. |
| `tickets`, `ticket_messages` | Support conversation. |
| `audit_logs` | Append-only. Every sensitive action with actor, target, request ID and metadata. |
| `rate_limits` | D1-backed counters (see below). |
| `system_settings` | Platform settings with declared types, categories and validation. |
| `test_runs` | Full-pipeline test records, marked so they can be cleaned up. |

---

## The 30 enforced invariants

### 1. One live invoice per payable amount

```sql
CREATE UNIQUE INDEX ux_invoices_active_amount
  ON invoices(payable_amount)
  WHERE status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING','MANUAL_REVIEW');
```

Blocked by the database:

- a second `PENDING` invoice claiming an amount already held
- a `MANUAL_REVIEW` invoice claiming an amount already held — **the amount stays claimed while
  under review**, because an admin might still confirm it
- a zero or negative payable amount
- an unknown status value

Allowed, deliberately:

- a different amount
- reusing an amount once the previous holder is `EXPIRED` or `CANCELLED`
- a `PAID` invoice never blocking its amount again

### 2. A fee is charged at most once per invoice

`wallet_ledger.idempotency_key` is unique. `WalletService.chargeFee` derives the key from the
invoice ID, so "charge this invoice's fee twice" is not expressible — it is not something a caller
has to remember not to do.

### 3. A bank transaction settles at most once, platform-wide

```sql
CREATE UNIQUE INDEX ux_transactions_bank_reference
  ON transactions(bank_reference)
  WHERE bank_reference IS NOT NULL AND status = 'CONFIRMED';
```

This is what makes "the same SMS forwarded twice" harmless even if the message-level duplicate
check is bypassed. NULL references never collide, and a composite fingerprint index covers banks
that send no usable reference.

### 4. Wallet arithmetic cannot go negative or oversubscribe

- `balance >= 0`
- `reserved_balance <= balance`
- `balance_after >= 0` on every ledger row

### 5. Append-only financial and audit records

`wallet_ledger` and `audit_logs` reject `UPDATE` and `DELETE` with `BEFORE` triggers that raise.
Deleting or rewriting a row is a database error, not a code-review convention.

### 6. Money cannot be stored as a float

Every Toman column is `INTEGER` with a `CHECK`. SQLite refuses to store a `REAL` in an `INTEGER`
column, so a fractional amount is a type error at the storage layer.

### 7. Idempotency

`(merchant_user_id, idempotency_key)` is unique.

### 8. Referential integrity

Foreign keys are enforced — an invoice or card for a non-existent merchant is rejected on write.
`ON DELETE` is chosen per relationship: cascade for truly owned rows, `RESTRICT` for financial ones
(an invoice with a transaction cannot be deleted), `SET NULL` for soft references.

---

## Why rate limiting is in D1

Counters live in `rate_limits`, not KV. KV is eventually consistent, so a burst hitting different
edge locations would each read a stale count and the limit would leak exactly when it needs to hold.
The D1 increment is a single atomic statement:

```sql
INSERT INTO rate_limits (bucket_key, window_start, window_end, count, blocked_count, updated_at)
VALUES (?, ?, ?, 1, 0, ?)
ON CONFLICT(bucket_key) DO UPDATE SET
  count = rate_limits.count + 1,
  blocked_count = rate_limits.blocked_count + CASE WHEN rate_limits.count >= ? THEN 1 ELSE 0 END,
  updated_at = excluded.updated_at
RETURNING count
```

Note that the counter increments even when the request is refused. Knowing how far over a caller
went is what distinguishes a retry storm from a deliberate flood, and the row is discarded at the
end of the window anyway.

---

## Transactions

D1 has no interactive transactions, but `db.batch([...])` executes as one and rolls the whole batch
back if any statement fails. That is what the wallet depends on:

```ts
await batch(db, [
  // The ledger insert reads the balance it is about to change, so balance_before and
  // balance_after cannot drift from reality even under concurrency.
  db.prepare(`INSERT INTO wallet_ledger (...) SELECT ..., balance, balance + ? FROM wallets
              WHERE user_id = ? AND balance + ? >= 0`).bind(...),
  db.prepare(`UPDATE wallets SET balance = balance + ? WHERE user_id = ?`).bind(...),
]);
```

The funding precondition lives in the ledger insert's `WHERE` clause, so the check and the write
are inseparable.

---

## Migrations

| File | Contents |
|---|---|
| `0001_core.sql` | Identity, access, profiles, API keys, sessions, login attempts, settings |
| `0002_money.sql` | Cards, invoices, payments, transactions, fingerprints, wallets, ledger, idempotency |
| `0003_ops.sql` | SMS, webhooks, notifications, tickets, audit, rate limits, test runs |
| `seeds/0001_settings.sql` | 37 default settings |

```bash
npm run db:migrate:local      # local
npm run db:migrate:remote     # production (remote)
npm run db:seed:local
```

Verify after any change:

```bash
node scripts/verify-schema.mjs
```

---

## Backup and recovery

D1 is the only stateful component, plus KV (caches only — losing it is harmless) and R2 if
configured.

- **The ledger is immutable**, so a wallet balance is always reconstructible from its ledger rows
  alone: `SUM(credit) − SUM(debit)` must equal `balance`. `WalletService.reconcile` asserts this,
  and the daily cron job runs it for every merchant with activity.
- **Audit logs survive normal record changes** because they are append-only and reference targets
  by ID with `ON DELETE SET NULL` rather than cascade.
- **Export**: `npm run backup:export` (see [DEPLOYMENT.md](./DEPLOYMENT.md)).
- **Never delete financial records.** Invoices and transactions use `RESTRICT`, so this is enforced
  rather than remembered.

Test a restore before going live. A backup that has never been restored is a hypothesis.
