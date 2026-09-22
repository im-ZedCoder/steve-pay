#!/usr/bin/env node
/**
 * Schema invariant smoke test.
 *
 * Applies every migration and seed to an in-memory SQLite database and then
 * attacks the schema: duplicate payable amounts, double fee charges, mutated
 * ledger rows, mutated audit rows, reused bank references, replayed idempotency
 * keys, and out-of-range money. Each attack must be rejected.
 *
 * This runs in a second, needs no Cloudflare account, and catches the class of
 * mistake that is most expensive to find later: an invariant that is only
 * enforced in application code. The Vitest suite re-checks the same invariants
 * against real D1, but this is the fast feedback loop.
 *
 *   node scripts/verify-schema.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const T = '2026-09-22T10:00:00.000Z';
const T_LATER = '2026-09-22T11:00:00.000Z';

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');

for (const dir of ['migrations', 'seeds']) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      db.exec(readFileSync(`${dir}/${file}`, 'utf8'));
      console.log(`applied  ${dir}/${file}`);
    } catch (error) {
      console.error(`FAILED   ${dir}/${file}\n         ${error.message}`);
      process.exit(1);
    }
  }
}

let failures = 0;

/** `expect('block', label, fn)` asserts fn() throws; `expect('allow', ...)` asserts it does not. */
function expect(behaviour, label, fn) {
  let threw = null;
  try {
    fn();
  } catch (error) {
    threw = error;
  }
  const ok = behaviour === 'block' ? threw !== null : threw === null;
  if (!ok) failures += 1;
  const verb = threw ? 'blocked' : 'allowed';
  const mark = ok ? 'pass' : 'FAIL';
  console.log(`  ${mark}  ${label.padEnd(58)} ${verb}${threw ? ` (${threw.message})` : ''}`);
}

const insertUser = db.prepare(
  `INSERT INTO users (id, mobile, password_hash, role, status, created_at, updated_at)
   VALUES (?, ?, 'pbkdf2-sha256$1$x$y', 'MERCHANT', 'ACTIVE', ?, ?)`,
);
const insertInvoice = db.prepare(
  `INSERT INTO invoices (
     id, payment_id, merchant_user_id, status, original_amount, customer_fee, merchant_fee,
     gateway_fee, base_amount, unique_suffix, payable_amount, payable_amount_rial, fee_mode,
     created_at, updated_at, expires_at)
   VALUES (?, ?, 'u1', ?, 359000, 3000, 0, 3000, 362000, 1706, ?, ? * 10, 'CUSTOMER', ?, ?, ?)`,
);
// (id, payment_id, status, payable_amount, amount-for-rial, created_at, updated_at, expires_at)
// `? * 10` consumes its own argument: the Rial figure is derived from the Toman one in SQL so the
// two can never disagree.
const makeInvoice = (id, status, amount) =>
  insertInvoice.run(id, `p_${id}`, status, amount, amount, T, T, T_LATER);

console.log('\nsetup');
insertUser.run('u1', '09120000001', T, T);
db.exec(
  `INSERT INTO wallets (merchant_user_id, balance, reserved_balance, created_at, updated_at)
   VALUES ('u1', 50000, 0, '${T}', '${T}')`,
);

console.log('\ninvariant 1 — one live invoice per payable amount');
expect('allow', 'first PENDING invoice claiming 363706', () => makeInvoice('i1', 'PENDING', 363706));
expect('block', 'a second PENDING invoice claiming 363706', () => makeInvoice('i2', 'PENDING', 363706));
expect('block', 'a MANUAL_REVIEW invoice claiming 363706 (amount stays held)', () =>
  makeInvoice('i3', 'MANUAL_REVIEW', 363706),
);
expect('allow', 'a different payable amount (363707)', () => makeInvoice('i4', 'PENDING', 363707));

db.exec(`UPDATE invoices SET status = 'EXPIRED' WHERE id = 'i1'`);
expect('allow', 'reusing 363706 once the previous holder is EXPIRED', () =>
  makeInvoice('i5', 'PENDING', 363706),
);
expect('allow', 'a PAID invoice never blocks its amount', () => makeInvoice('i6', 'PAID', 363706));
expect('block', 'an unknown invoice status', () => makeInvoice('i7', 'TOTALLY_BOGUS', 400001));
expect('block', 'a zero payable amount', () => makeInvoice('i8', 'PENDING', 0));

console.log('\ninvariant 2 — a fee is charged at most once per invoice');
const chargeFee = (id, key) =>
  db
    .prepare(
      `INSERT INTO wallet_ledger (
         id, merchant_user_id, type, direction, amount, balance_before, balance_after,
         idempotency_key, created_at)
       VALUES (?, 'u1', 'PAYMENT_FEE', 'DEBIT', 3000, 50000, 47000, ?, ?)`,
    )
    .run(id, key, T);
expect('allow', 'charging fee:i5 once', () => chargeFee('wl1', 'fee:i5'));
expect('block', 'charging fee:i5 a second time', () => chargeFee('wl2', 'fee:i5'));
expect('block', 'deleting a ledger row', () => db.exec(`DELETE FROM wallet_ledger WHERE id = 'wl1'`));
expect('block', 'rewriting a ledger amount', () =>
  db.exec(`UPDATE wallet_ledger SET amount = 1 WHERE id = 'wl1'`),
);

console.log('\ninvariant 3 — a bank transaction is claimed at most once');
db.exec(
  `INSERT INTO payments (id, invoice_id, merchant_user_id, status, amount, fee_mode, created_at, updated_at, expires_at)
   VALUES ('p_i6', 'i6', 'u1', 'PAID', 363706, 'CUSTOMER', '${T}', '${T}', '${T_LATER}')`,
);
const insertTxn = (id, reference) =>
  db
    .prepare(
      `INSERT INTO transactions (
         id, invoice_id, payment_id, merchant_user_id, status, confirmation, amount,
         original_amount, net_amount, bank_reference, created_at, confirmed_at)
       VALUES (?, 'i6', 'p_i6', 'u1', 'CONFIRMED', 'AUTOMATIC', 363706, 359000, 356000, ?, ?, ?)`,
    )
    .run(id, reference, T, T);
expect('allow', 'settling bank reference 77120395', () => insertTxn('t1', '77120395'));
expect('block', 'settling bank reference 77120395 again', () => insertTxn('t2', '77120395'));
expect('allow', 'two settlements without a reference (NULL never collides)', () => {
  insertTxn('t3', null);
  insertTxn('t4', null);
});
expect('allow', 'claiming a composite fingerprint', () =>
  db.exec(
    `INSERT INTO transaction_fingerprints (merchant_user_id, fingerprint, kind, created_at)
     VALUES ('u1', 'fp:in:363706:6104xxxx3456:1758535200', 'COMPOSITE', '${T}')`,
  ),
);
expect('block', 'claiming the same composite fingerprint twice', () =>
  db.exec(
    `INSERT INTO transaction_fingerprints (merchant_user_id, fingerprint, kind, created_at)
     VALUES ('u1', 'fp:in:363706:6104xxxx3456:1758535200', 'COMPOSITE', '${T}')`,
  ),
);

console.log('\nwallet arithmetic cannot go negative or oversubscribe');
expect('block', 'a negative balance', () => db.exec(`UPDATE wallets SET balance = -1 WHERE merchant_user_id = 'u1'`));
expect('block', 'reserved_balance above balance', () =>
  db.exec(`UPDATE wallets SET reserved_balance = 999999 WHERE merchant_user_id = 'u1'`),
);
expect('allow', 'reserving 5000 of a 50000 balance', () =>
  db.exec(`UPDATE wallets SET reserved_balance = 5000 WHERE merchant_user_id = 'u1'`),
);
expect('block', 'a ledger row ending in a negative balance', () =>
  db.exec(
    `INSERT INTO wallet_ledger (id, merchant_user_id, type, direction, amount, balance_before, balance_after, created_at)
     VALUES ('wl9', 'u1', 'ADJUSTMENT', 'DEBIT', 10, 10, -5, '${T}')`,
  ),
);

console.log('\nappend-only tables');
db.exec(`INSERT INTO audit_logs (event, created_at) VALUES ('login.success', '${T}')`);
expect('block', 'deleting audit rows', () => db.exec('DELETE FROM audit_logs'));
expect('block', 'rewriting audit rows', () => db.exec(`UPDATE audit_logs SET event = 'login.failed'`));

console.log('\nidempotency and money types');
const idem = db.prepare(
  `INSERT INTO idempotency_keys (merchant_user_id, idempotency_key, request_hash, endpoint, created_at, expires_at)
   VALUES ('u1', ?, 'h', '/api/v1/payments', ?, ?)`,
);
expect('allow', 'first use of idempotency key order_123', () => idem.run('order_123', T, T_LATER));
expect('block', 'a replay of idempotency key order_123', () => idem.run('order_123', T, T_LATER));
const rawInvoice = (id, payable, rial) =>
  db.exec(
    `INSERT INTO invoices (id, payment_id, merchant_user_id, status, original_amount, gateway_fee, base_amount,
       unique_suffix, payable_amount, payable_amount_rial, fee_mode, created_at, updated_at, expires_at)
     VALUES ('${id}','p_${id}','u1','PENDING',359000,3000,362000,1706,${payable},${rial},'CUSTOMER','${T}','${T}','${T_LATER}')`,
  );
expect('block', 'writing a fractional Toman amount', () => rawInvoice('i_frac', 363706.5, 3637065));
expect('block', 'writing a numeric string into a Toman column', () =>
  rawInvoice('i_str', `'363706'`, `'3637065'`),
);

console.log('\nreferential integrity');
expect('block', 'an invoice for a merchant that does not exist', () => {
  const stmt = db.prepare(
    `INSERT INTO invoices (id, payment_id, merchant_user_id, status, original_amount, gateway_fee, base_amount,
       unique_suffix, payable_amount, payable_amount_rial, fee_mode, created_at, updated_at, expires_at)
     VALUES ('i_ghost','p_ghost','nobody','PENDING',1000,0,1000,101,1101,11010,'CUSTOMER','${T}','${T}','${T_LATER}')`,
  );
  stmt.run();
});
expect('block', 'a card for a merchant that does not exist', () =>
  db.exec(
    `INSERT INTO bank_cards (id, merchant_user_id, number, number_hash, number_masked, title, created_at, updated_at)
     VALUES ('c1','nobody','6104337812345678','h','6104-****-****-5678','x','${T}','${T}')`,
  ),
);

console.log(failures === 0 ? '\nschema invariants: all checks passed' : `\nschema invariants: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
