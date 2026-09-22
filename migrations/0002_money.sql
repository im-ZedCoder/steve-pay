-- =============================================================================
-- Steve Pay — migration 0002: money
-- =============================================================================
-- The financial core. Three invariants are enforced by the database itself
-- rather than by application code, because application code is what changes:
--
--   1. No two live invoices may share a payable amount.
--      -> ux_invoices_active_amount (partial unique index)
--   2. A merchant fee may be charged at most once per invoice.
--      -> ux_wallet_ledger_idempotency on wallet_ledger.idempotency_key
--   3. A bank transaction may be claimed at most once, with or without a
--      reference number.
--      -> ux_transactions_bank_reference + transaction_fingerprints
-- =============================================================================

-- -----------------------------------------------------------------------------
-- bank_cards — the merchant's receiving cards. These are shown to the customer,
-- so the number is not a secret; it is still masked in every log line and never
-- echoed into webhook payloads.
-- -----------------------------------------------------------------------------
CREATE TABLE bank_cards (
  id               TEXT PRIMARY KEY,
  merchant_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number           TEXT NOT NULL,                       -- 16 digits, validated by Luhn + Shetab issuer
  number_hash      TEXT NOT NULL,                       -- sha256, for duplicate detection
  number_masked    TEXT NOT NULL,                       -- 6104-****-****-3456
  title            TEXT NOT NULL,                       -- merchant's own label: "Main", "Saman #2"
  bank_name        TEXT,
  holder_name      TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  is_default       INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  display_order    INTEGER NOT NULL DEFAULT 0,
  success_count    INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count    INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_bank_cards_number ON bank_cards(merchant_user_id, number_hash);
-- At most one default card per merchant, and it must be active. Enforced here so
-- a race between two dashboard tabs cannot leave a merchant with two defaults.
CREATE UNIQUE INDEX ux_bank_cards_default ON bank_cards(merchant_user_id)
  WHERE is_default = 1;
CREATE INDEX ix_bank_cards_merchant ON bank_cards(merchant_user_id, display_order);

-- -----------------------------------------------------------------------------
-- invoices — the commercial document handed to the customer.
-- Amount decomposition is stored field-by-field rather than derived later,
-- because the fee configuration can change after the invoice is issued and a
-- historical invoice must keep reporting the numbers it was issued with.
--   payable_amount = original_amount + customer_fee + unique_suffix
--   gateway_fee    = customer_fee + merchant_fee
-- -----------------------------------------------------------------------------
CREATE TABLE invoices (
  id                 TEXT PRIMARY KEY,
  payment_id         TEXT NOT NULL,
  merchant_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  api_key_id         TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  card_id            TEXT REFERENCES bank_cards(id) ON DELETE SET NULL,

  status             TEXT NOT NULL DEFAULT 'CREATED'
                       CHECK (status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING','PAID',
                                         'FAILED','EXPIRED','CANCELLED','MANUAL_REVIEW','REFUNDED')),
  currency           TEXT NOT NULL DEFAULT 'IRT' CHECK (currency IN ('IRT')),

  original_amount    INTEGER NOT NULL CHECK (original_amount > 0),
  customer_fee       INTEGER NOT NULL DEFAULT 0 CHECK (customer_fee >= 0),
  merchant_fee       INTEGER NOT NULL DEFAULT 0 CHECK (merchant_fee >= 0),
  gateway_fee        INTEGER NOT NULL DEFAULT 0 CHECK (gateway_fee >= 0),
  base_amount        INTEGER NOT NULL CHECK (base_amount > 0),
  unique_suffix      INTEGER NOT NULL CHECK (unique_suffix > 0),
  payable_amount     INTEGER NOT NULL CHECK (payable_amount > 0),
  payable_amount_rial INTEGER NOT NULL CHECK (payable_amount_rial > 0),
  fee_mode           TEXT NOT NULL CHECK (fee_mode IN ('CUSTOMER','MERCHANT')),

  received_amount    INTEGER CHECK (received_amount IS NULL OR received_amount >= 0),
  net_amount         INTEGER CHECK (net_amount IS NULL OR net_amount >= 0),
  settled_fee        INTEGER CHECK (settled_fee IS NULL OR settled_fee >= 0),

  description        TEXT,
  customer_message   TEXT,                              -- snapshot of the merchant's page message
  metadata           TEXT,                              -- JSON object supplied by the merchant
  custom_callback    TEXT,
  return_url         TEXT,                              -- validated against the merchant's config

  environment        TEXT NOT NULL DEFAULT 'live' CHECK (environment IN ('live','test')),
  is_test            INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),

  transaction_id     TEXT,
  match_score        INTEGER,
  match_reasons      TEXT,                              -- JSON array of human-readable reasons

  created_ip         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  paid_at            TEXT,
  failed_at          TEXT,
  expired_at         TEXT,
  cancelled_at       TEXT,
  review_at          TEXT
) STRICT;

-- INVARIANT 1 -----------------------------------------------------------------
-- Only one live invoice may own a given payable amount. The partial index covers
-- every non-terminal state, MANUAL_REVIEW included: an amount under review must
-- stay claimed, otherwise the next invoice could reuse it and a late admin
-- confirmation would settle the wrong merchant.
CREATE UNIQUE INDEX ux_invoices_active_amount ON invoices(payable_amount)
  WHERE status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING','MANUAL_REVIEW');

CREATE UNIQUE INDEX ux_invoices_payment_id ON invoices(payment_id);
CREATE INDEX ix_invoices_merchant_created ON invoices(merchant_user_id, created_at DESC);
CREATE INDEX ix_invoices_merchant_status ON invoices(merchant_user_id, status, created_at DESC);
CREATE INDEX ix_invoices_status_expires ON invoices(status, expires_at);
CREATE INDEX ix_invoices_expires ON invoices(expires_at);
CREATE INDEX ix_invoices_transaction ON invoices(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX ix_invoices_test ON invoices(is_test, created_at DESC) WHERE is_test = 1;

-- -----------------------------------------------------------------------------
-- payments — one row per payment attempt against an invoice. Today an invoice
-- has exactly one payment; the split exists so a future retry or a second
-- method (PSP redirect, wallet debit) can attach without reshaping invoices.
-- -----------------------------------------------------------------------------
CREATE TABLE payments (
  id               TEXT PRIMARY KEY,
  invoice_id       TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  merchant_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status           TEXT NOT NULL
                     CHECK (status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING','PAID',
                                       'FAILED','EXPIRED','CANCELLED','MANUAL_REVIEW','REFUNDED')),
  method           TEXT NOT NULL DEFAULT 'CARD_TRANSFER'
                     CHECK (method IN ('CARD_TRANSFER','PSP','WALLET')),
  amount           INTEGER NOT NULL CHECK (amount > 0),
  currency         TEXT NOT NULL DEFAULT 'IRT',
  fee_mode         TEXT NOT NULL CHECK (fee_mode IN ('CUSTOMER','MERCHANT')),
  is_test          INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  confirmed_at     TEXT,
  expires_at       TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_payments_invoice ON payments(invoice_id);
CREATE INDEX ix_payments_merchant_created ON payments(merchant_user_id, created_at DESC);
CREATE INDEX ix_payments_status ON payments(status, created_at DESC);

-- -----------------------------------------------------------------------------
-- sms_messages — every raw bank SMS is preserved verbatim for audit. Duplicate
-- delivery from a flaky forwarder is rejected by the hash of the message body
-- scoped to the merchant.
-- -----------------------------------------------------------------------------
CREATE TABLE sms_messages (
  id                 TEXT PRIMARY KEY,
  merchant_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  api_key_id         TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  raw_message        TEXT NOT NULL,                     -- never edited, never truncated
  message_hash       TEXT NOT NULL,                     -- sha256(merchant || normalised raw)
  sender             TEXT,
  device_id          TEXT,
  client_received_at TEXT,                              -- claimed by the forwarder, untrusted
  server_received_at TEXT NOT NULL,                     -- authoritative
  source_ip          TEXT,
  message_length     INTEGER NOT NULL,
  parse_status       TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (parse_status IN ('PENDING','PARSED','FAILED','IGNORED','TEST')),
  parser_used        TEXT,
  is_test            INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),
  duplicate_of       TEXT REFERENCES sms_messages(id) ON DELETE SET NULL,
  processed_at       TEXT,
  created_at         TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_sms_messages_hash ON sms_messages(merchant_user_id, message_hash);
CREATE INDEX ix_sms_messages_merchant ON sms_messages(merchant_user_id, server_received_at DESC);
CREATE INDEX ix_sms_messages_status ON sms_messages(parse_status, server_received_at DESC);
CREATE INDEX ix_sms_messages_created ON sms_messages(created_at DESC);

-- -----------------------------------------------------------------------------
-- sms_parser_results — what the parser understood. Kept beside the raw message
-- rather than replacing it, so a parser bug can be replayed against history
-- without the original inbound payload still being available.
-- -----------------------------------------------------------------------------
CREATE TABLE sms_parser_results (
  id               TEXT PRIMARY KEY,
  sms_message_id   TEXT NOT NULL REFERENCES sms_messages(id) ON DELETE CASCADE,
  merchant_user_id TEXT NOT NULL,
  parser           TEXT NOT NULL,
  bank             TEXT,
  confidence       INTEGER NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  amount_raw       TEXT,
  amount_toman     INTEGER CHECK (amount_toman IS NULL OR amount_toman >= 0),
  amount_rial      INTEGER CHECK (amount_rial IS NULL OR amount_rial >= 0),
  currency         TEXT CHECK (currency IS NULL OR currency IN ('IRT','IRR','UNKNOWN')),
  reference        TEXT,
  source_card      TEXT,
  destination_card TEXT,
  balance_toman    INTEGER CHECK (balance_toman IS NULL OR balance_toman >= 0),
  occurred_at      TEXT,
  direction        TEXT CHECK (direction IS NULL OR direction IN ('IN','OUT','UNKNOWN')),
  warnings         TEXT,                                -- JSON array
  extracted        TEXT,                                -- JSON: everything the parser saw
  created_at       TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_sms_parser_results_message ON sms_parser_results(sms_message_id);
CREATE INDEX ix_sms_parser_results_bank ON sms_parser_results(bank, created_at DESC);
CREATE INDEX ix_sms_parser_results_reference ON sms_parser_results(reference)
  WHERE reference IS NOT NULL;

-- -----------------------------------------------------------------------------
-- transactions — the settled money movement. A transaction is created only when
-- a payment is confirmed, either automatically by the matcher or manually by an
-- admin resolving a MANUAL_REVIEW.
-- -----------------------------------------------------------------------------
CREATE TABLE transactions (
  id                TEXT PRIMARY KEY,
  invoice_id        TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  payment_id        TEXT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  merchant_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sms_message_id    TEXT REFERENCES sms_messages(id) ON DELETE SET NULL,

  status            TEXT NOT NULL CHECK (status IN ('CONFIRMED','REJECTED','REVERSED')),
  confirmation      TEXT NOT NULL CHECK (confirmation IN ('AUTOMATIC','MANUAL')),
  amount            INTEGER NOT NULL CHECK (amount > 0),          -- received, in Toman
  original_amount   INTEGER NOT NULL CHECK (original_amount > 0), -- merchant's ask
  fee_total         INTEGER NOT NULL DEFAULT 0 CHECK (fee_total >= 0),
  customer_fee      INTEGER NOT NULL DEFAULT 0 CHECK (customer_fee >= 0),
  merchant_fee      INTEGER NOT NULL DEFAULT 0 CHECK (merchant_fee >= 0),
  net_amount        INTEGER NOT NULL CHECK (net_amount >= 0),     -- what the merchant keeps
  currency          TEXT NOT NULL DEFAULT 'IRT',
  bank_reference    TEXT,
  matched_by        TEXT,                                         -- ruleset version that decided
  match_score       INTEGER,
  match_reasons     TEXT,
  confirmed_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  card_id           TEXT REFERENCES bank_cards(id) ON DELETE SET NULL,
  is_test           INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),
  created_at        TEXT NOT NULL,
  confirmed_at      TEXT NOT NULL
) STRICT;

-- INVARIANT 3a ----------------------------------------------------------------
-- A bank reference number settles at most one transaction, platform-wide. This is
-- what makes "the same SMS forwarded twice" harmless even if the SMS-level
-- duplicate check is bypassed.
CREATE UNIQUE INDEX ux_transactions_bank_reference ON transactions(bank_reference)
  WHERE bank_reference IS NOT NULL AND status = 'CONFIRMED';
CREATE INDEX ix_transactions_merchant_created ON transactions(merchant_user_id, created_at DESC);
CREATE INDEX ix_transactions_invoice ON transactions(invoice_id);
CREATE INDEX ix_transactions_status_created ON transactions(status, created_at DESC);
CREATE INDEX ix_transactions_sms ON transactions(sms_message_id) WHERE sms_message_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- transaction_fingerprints — the second half of INVARIANT 3. When a bank does not
-- provide a usable reference number we fall back to a fingerprint over
-- (direction, amount, destination card, minute bucket). Inserting the fingerprint
-- is the act of claiming the transaction; a UNIQUE violation means somebody else
-- already claimed it and this delivery is a duplicate.
-- -----------------------------------------------------------------------------
CREATE TABLE transaction_fingerprints (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_user_id TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('BANK_REFERENCE','COMPOSITE')),
  transaction_id   TEXT REFERENCES transactions(id) ON DELETE CASCADE,
  sms_message_id   TEXT REFERENCES sms_messages(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_transaction_fingerprints ON transaction_fingerprints(merchant_user_id, fingerprint);
CREATE INDEX ix_transaction_fingerprints_created ON transaction_fingerprints(created_at DESC);

-- -----------------------------------------------------------------------------
-- wallets — one per merchant. available_balance is deliberately NOT stored: it is
-- always balance - reserved_balance, computed at read time. A stored derivative
-- is a number that will eventually disagree with its inputs.
-- -----------------------------------------------------------------------------
CREATE TABLE wallets (
  merchant_user_id  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance           INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  reserved_balance  INTEGER NOT NULL DEFAULT 0 CHECK (reserved_balance >= 0),
  total_deposited   INTEGER NOT NULL DEFAULT 0 CHECK (total_deposited >= 0),
  total_fees_paid   INTEGER NOT NULL DEFAULT 0 CHECK (total_fees_paid >= 0),
  total_withdrawn   INTEGER NOT NULL DEFAULT 0 CHECK (total_withdrawn >= 0),
  total_adjustments INTEGER NOT NULL DEFAULT 0,               -- may be negative
  version           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (reserved_balance <= balance)
) STRICT;

-- -----------------------------------------------------------------------------
-- wallet_ledger — the immutable truth about a wallet. Every change to
-- wallets.balance happens in the same statement that appends here, and the row
-- records balance_before/balance_after so the running total can be audited
-- without replaying the whole history.
--
-- idempotency_key is the double-charge guard: charging a fee writes a row keyed
-- 'fee:<invoice_id>', so the second attempt to charge the same invoice hits a
-- UNIQUE violation instead of taking more money.
-- -----------------------------------------------------------------------------
CREATE TABLE wallet_ledger (
  id               TEXT PRIMARY KEY,
  merchant_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type             TEXT NOT NULL
                     CHECK (type IN ('DEPOSIT','WITHDRAWAL','PAYMENT_FEE','REFUND','ADMIN_CREDIT',
                                     'ADMIN_DEBIT','ADJUSTMENT','REVERSAL','RESERVE','RELEASE')),
  direction        TEXT NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
  amount           INTEGER NOT NULL CHECK (amount > 0),
  balance_before   INTEGER NOT NULL,
  balance_after    INTEGER NOT NULL,
  reserved_before  INTEGER NOT NULL DEFAULT 0,
  reserved_after   INTEGER NOT NULL DEFAULT 0,
  reference        TEXT,
  reference_type   TEXT,
  description      TEXT,
  idempotency_key  TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  CHECK (balance_after >= 0),
  CHECK (reserved_after >= 0)
) STRICT;

CREATE UNIQUE INDEX ux_wallet_ledger_idempotency ON wallet_ledger(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX ix_wallet_ledger_merchant ON wallet_ledger(merchant_user_id, created_at DESC);
CREATE INDEX ix_wallet_ledger_type ON wallet_ledger(type, created_at DESC);
CREATE INDEX ix_wallet_ledger_reference ON wallet_ledger(reference) WHERE reference IS NOT NULL;

CREATE TRIGGER trg_wallet_ledger_no_update BEFORE UPDATE ON wallet_ledger
BEGIN SELECT RAISE(ABORT, 'wallet_ledger is append-only'); END;
CREATE TRIGGER trg_wallet_ledger_no_delete BEFORE DELETE ON wallet_ledger
BEGIN SELECT RAISE(ABORT, 'wallet_ledger is append-only'); END;

-- -----------------------------------------------------------------------------
-- idempotency_keys — makePayment replay protection. The stored response is
-- replayed verbatim, which is what a merchant's retry logic expects to see.
-- request_hash lets us answer 409 when the same key arrives with a different
-- body, instead of silently returning an unrelated payment.
-- -----------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key  TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  endpoint         TEXT NOT NULL,
  resource_type    TEXT,
  resource_id      TEXT,
  response_status  INTEGER,
  response_body    TEXT,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_idempotency_merchant_key ON idempotency_keys(merchant_user_id, idempotency_key);
CREATE INDEX ix_idempotency_expiry ON idempotency_keys(expires_at);

-- -----------------------------------------------------------------------------
-- Convenience view: the wallet shape the API and dashboard actually report.
-- -----------------------------------------------------------------------------
CREATE VIEW v_wallet_overview AS
SELECT
  w.merchant_user_id                AS merchant_user_id,
  w.balance                         AS balance,
  w.reserved_balance                AS reserved_balance,
  w.balance - w.reserved_balance    AS available_balance,
  w.total_deposited                 AS total_deposited,
  w.total_fees_paid                 AS total_fees_paid,
  w.total_withdrawn                 AS total_withdrawn,
  w.total_adjustments               AS total_adjustments,
  w.updated_at                      AS updated_at
FROM wallets w;
