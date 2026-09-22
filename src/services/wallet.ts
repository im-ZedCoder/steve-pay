/**
 * Wallet and ledger (§22, §23, §24, §30, §72).
 *
 * The rules this service exists to make impossible to break:
 *
 *   1. No balance changes without a ledger row. Every mutation is a ledger INSERT
 *      whose SELECT reads the very balance it is about to change, batched with the
 *      wallet UPDATE. They commit together or not at all.
 *
 *   2. No fee is ever charged twice. Fee charges carry the idempotency key
 *      `fee:<invoiceId>`, which is UNIQUE. A second attempt dies on the index
 *      rather than on a code path someone might forget to add.
 *
 *   3. No partial state. If the ledger insert or the wallet update fails, D1 rolls
 *      the whole batch back — so there is never a ledger row for money that did not
 *      move, nor money moved without a row.
 *
 * Why the ledger insert comes first in the batch: it is the statement that carries
 * both the idempotency key and the funding precondition. Putting it first means a
 * duplicate or an underfunded attempt is rejected before the wallet is touched, and
 * the rollback leaves nothing behind.
 *
 * `balance_before` / `balance_after` are computed inside SQL from the row being
 * read, so they cannot disagree with reality the way an application-computed value
 * could under concurrency.
 */

import { AppError } from '../core/errors';
import { isUniqueViolation } from '../db/client';
import { id as newId } from '../core/ids';
import { nowIso } from '../core/time';
import { assertToman, type Toman } from '../core/money';
import { first, all, batch } from '../db/client';

export type LedgerType =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'PAYMENT_FEE'
  | 'REFUND'
  | 'ADMIN_CREDIT'
  | 'ADMIN_DEBIT'
  | 'ADJUSTMENT'
  | 'REVERSAL'
  | 'RESERVE'
  | 'RELEASE';

export type LedgerDirection = 'CREDIT' | 'DEBIT';

export interface WalletSnapshot {
  merchantUserId: string;
  balance: Toman;
  reservedBalance: Toman;
  /**
   * balance - reservedBalance, computed at read time. Never stored: a stored
   * derivative is a number that eventually disagrees with its inputs.
   */
  availableBalance: Toman;
  totalDeposited: Toman;
  totalFeesPaid: Toman;
  totalWithdrawn: Toman;
  totalAdjustments: Toman;
  updatedAt: string;
}

export interface LedgerRow {
  id: string;
  merchant_user_id: string;
  type: LedgerType;
  direction: LedgerDirection;
  amount: number;
  balance_before: number;
  balance_after: number;
  reserved_before: number;
  reserved_after: number;
  reference: string | null;
  reference_type: string | null;
  description: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: string;
}

export interface MutationResult {
  /** True when this call actually moved money. */
  applied: boolean;
  /** True when an idempotent replay was detected and nothing changed. */
  alreadyApplied: boolean;
  /** Wallet state after the operation (or the current state when replayed). */
  snapshot: WalletSnapshot;
  ledgerId: string | null;
}

export interface MutationInput {
  merchantUserId: string;
  amount: Toman;
  type: LedgerType;
  reference?: string | null;
  referenceType?: string | null;
  description?: string | null;
  createdBy?: string | null;
  /** Guards against double application. Required for every fee charge. */
  idempotencyKey?: string | null;
}

export class WalletService {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  static feeIdempotencyKey(invoiceId: string): string {
    return `fee:${invoiceId}`;
  }

  static reserveIdempotencyKey(invoiceId: string): string {
    return `reserve:${invoiceId}`;
  }

  static releaseIdempotencyKey(invoiceId: string): string {
    return `release:${invoiceId}`;
  }

  /** Creates the wallet row if it does not exist yet. Idempotent by construction. */
  async ensure(merchantUserId: string): Promise<void> {
    const timestamp = nowIso();
    await this.db
      .prepare(
        `INSERT INTO wallets (merchant_user_id, balance, reserved_balance, created_at, updated_at)
         VALUES (?, 0, 0, ?, ?)
         ON CONFLICT(merchant_user_id) DO NOTHING`,
      )
      .bind(merchantUserId, timestamp, timestamp)
      .run();
  }

  async snapshot(merchantUserId: string): Promise<WalletSnapshot> {
    const row = await first<{
      merchant_user_id: string;
      balance: number;
      reserved_balance: number;
      available_balance: number;
      total_deposited: number;
      total_fees_paid: number;
      total_withdrawn: number;
      total_adjustments: number;
      updated_at: string;
    }>(this.db, 'SELECT * FROM v_wallet_overview WHERE merchant_user_id = ?', [merchantUserId]);

    if (!row) {
      // A merchant without a wallet row is a normal state immediately after
      // approval; report a zero wallet rather than failing the read.
      const timestamp = nowIso();
      return {
        merchantUserId,
        balance: 0,
        reservedBalance: 0,
        availableBalance: 0,
        totalDeposited: 0,
        totalFeesPaid: 0,
        totalWithdrawn: 0,
        totalAdjustments: 0,
        updatedAt: timestamp,
      };
    }

    return {
      merchantUserId: row.merchant_user_id,
      balance: row.balance,
      reservedBalance: row.reserved_balance,
      availableBalance: row.available_balance,
      totalDeposited: row.total_deposited,
      totalFeesPaid: row.total_fees_paid,
      totalWithdrawn: row.total_withdrawn,
      totalAdjustments: row.total_adjustments,
      updatedAt: row.updated_at,
    };
  }

  /** True when the wallet can cover `amount` on top of what is already reserved. */
  async canCover(merchantUserId: string, amount: Toman): Promise<{ ok: boolean; snapshot: WalletSnapshot }> {
    const snapshot = await this.snapshot(merchantUserId);
    return { ok: snapshot.availableBalance >= amount, snapshot };
  }

  // -------------------------------------------------------------------------
  // Money in
  // -------------------------------------------------------------------------

  /** Adds money. `DEPOSIT` and `ADMIN_CREDIT` also update the running totals. */
  async credit(input: MutationInput): Promise<MutationResult> {
    assertToman(input.amount, { field: 'amount' });
    await this.ensure(input.merchantUserId);

    const ledgerId = newId('wl');
    const timestamp = nowIso();
    const countsAsDeposit = input.type === 'DEPOSIT';
    const countsAsAdjustment = input.type === 'ADMIN_CREDIT' || input.type === 'ADJUSTMENT' || input.type === 'REVERSAL';

    const statements = [
      this.db
        .prepare(
          `INSERT INTO wallet_ledger (
             id, merchant_user_id, type, direction, amount, balance_before, balance_after,
             reserved_before, reserved_after, reference, reference_type, description,
             idempotency_key, created_by, created_at)
           SELECT ?, merchant_user_id, ?, 'CREDIT', ?, balance, balance + ?,
                  reserved_balance, reserved_balance, ?, ?, ?, ?, ?, ?
           FROM wallets
           WHERE merchant_user_id = ?`,
        )
        .bind(
          ledgerId,
          input.type,
          input.amount,
          input.amount,
          input.reference ?? null,
          input.referenceType ?? null,
          input.description ?? null,
          input.idempotencyKey ?? null,
          input.createdBy ?? null,
          timestamp,
          input.merchantUserId,
        ),
      this.db
        .prepare(
          `UPDATE wallets
           SET balance = balance + ?,
               total_deposited = total_deposited + ?,
               total_adjustments = total_adjustments + ?,
               version = version + 1,
               updated_at = ?
           WHERE merchant_user_id = ?`,
        )
        .bind(
          input.amount,
          countsAsDeposit ? input.amount : 0,
          countsAsAdjustment ? input.amount : 0,
          timestamp,
          input.merchantUserId,
        ),
    ];

    return this.execute(statements, input, ledgerId);
  }

  // -------------------------------------------------------------------------
  // Money out
  // -------------------------------------------------------------------------

  /**
   * Removes money, refusing to overdraw.
   *
   * The funding precondition lives in the ledger insert's WHERE clause, so the
   * check and the write cannot be separated by a concurrent request. If the wallet
   * cannot cover the amount, nothing is inserted, the wallet update matches no rows
   * either, and the batch leaves the database untouched.
   */
  async debit(input: MutationInput): Promise<MutationResult> {
    assertToman(input.amount, { field: 'amount' });
    await this.ensure(input.merchantUserId);

    const ledgerId = newId('wl');
    const timestamp = nowIso();
    const countsAsWithdrawal = input.type === 'WITHDRAWAL';
    const countsAsAdjustment =
      input.type === 'ADMIN_DEBIT' || input.type === 'ADJUSTMENT' || input.type === 'REVERSAL';

    const statements = [
      this.db
        .prepare(
          `INSERT INTO wallet_ledger (
             id, merchant_user_id, type, direction, amount, balance_before, balance_after,
             reserved_before, reserved_after, reference, reference_type, description,
             idempotency_key, created_by, created_at)
           SELECT ?, merchant_user_id, ?, 'DEBIT', ?, balance, balance - ?,
                  reserved_balance, reserved_balance, ?, ?, ?, ?, ?, ?
           FROM wallets
           WHERE merchant_user_id = ? AND balance - reserved_balance >= ?`,
        )
        .bind(
          ledgerId,
          input.type,
          input.amount,
          input.amount,
          input.reference ?? null,
          input.referenceType ?? null,
          input.description ?? null,
          input.idempotencyKey ?? null,
          input.createdBy ?? null,
          timestamp,
          input.merchantUserId,
          input.amount,
        ),
      this.db
        .prepare(
          `UPDATE wallets
           SET balance = balance - ?,
               total_fees_paid = total_fees_paid + ?,
               total_withdrawn = total_withdrawn + ?,
               total_adjustments = total_adjustments - ?,
               version = version + 1,
               updated_at = ?
           WHERE merchant_user_id = ? AND balance - reserved_balance >= ?`,
        )
        .bind(
          input.amount,
          input.type === 'PAYMENT_FEE' ? input.amount : 0,
          countsAsWithdrawal ? input.amount : 0,
          countsAsAdjustment ? input.amount : 0,
          timestamp,
          input.merchantUserId,
          input.amount,
        ),
    ];

    const result = await this.execute(statements, input, ledgerId);

    if (!result.applied && !result.alreadyApplied) {
      // Nothing moved and it was not a replay: the wallet could not cover it.
      throw new AppError('INSUFFICIENT_WALLET_BALANCE', {
        details: {
          required: input.amount,
          available: result.snapshot.availableBalance,
        },
      });
    }

    return result;
  }

  /**
   * Charges the gateway fee for a settled invoice.
   *
   * This is THE double-charge guard (§72 rule 5). The idempotency key is derived
   * from the invoice id, so no matter how many times a confirmation path runs, at
   * most one fee is ever taken.
   */
  async chargeFee(input: {
    merchantUserId: string;
    invoiceId: string;
    amount: Toman;
    createdBy?: string | null;
  }): Promise<MutationResult> {
    return this.debit({
      merchantUserId: input.merchantUserId,
      amount: input.amount,
      type: 'PAYMENT_FEE',
      reference: input.invoiceId,
      referenceType: 'invoice',
      description: 'کارمزد درگاه',
      idempotencyKey: WalletService.feeIdempotencyKey(input.invoiceId),
      createdBy: input.createdBy ?? 'system',
    });
  }

  // -------------------------------------------------------------------------
  // Reservation
  // -------------------------------------------------------------------------

  /**
   * Reserves part of the balance for a live invoice.
   *
   * Reservation is not a balance change: it marks money as spoken for so a merchant
   * cannot spend the same Toman on two invoices. The ledger row is written with
   * balance unchanged and reserved increased, which is what makes the reservation
   * visible in the statement.
   */
  async reserve(input: {
    merchantUserId: string;
    invoiceId: string;
    amount: Toman;
  }): Promise<MutationResult> {
    if (input.amount <= 0) {
      return { applied: false, alreadyApplied: false, snapshot: await this.snapshot(input.merchantUserId), ledgerId: null };
    }
    await this.ensure(input.merchantUserId);

    const ledgerId = newId('wl');
    const timestamp = nowIso();
    const statements = [
      this.db
        .prepare(
          `INSERT INTO wallet_ledger (
             id, merchant_user_id, type, direction, amount, balance_before, balance_after,
             reserved_before, reserved_after, reference, reference_type, description,
             idempotency_key, created_by, created_at)
           SELECT ?, merchant_user_id, 'RESERVE', 'DEBIT', ?, balance, balance,
                  reserved_balance, reserved_balance + ?, ?, 'invoice', ?, ?, 'system', ?
           FROM wallets
           WHERE merchant_user_id = ? AND reserved_balance + ? <= balance
             AND balance - reserved_balance >= ?`,
        )
        .bind(
          ledgerId,
          input.amount,
          input.amount,
          input.invoiceId,
          'رزرو کارمزد فاکتور',
          WalletService.reserveIdempotencyKey(input.invoiceId),
          timestamp,
          input.merchantUserId,
          input.amount,
          input.amount,
        ),
      this.db
        .prepare(
          `UPDATE wallets
           SET reserved_balance = reserved_balance + ?, version = version + 1, updated_at = ?
           WHERE merchant_user_id = ? AND reserved_balance + ? <= balance AND balance - reserved_balance >= ?`,
        )
        .bind(input.amount, timestamp, input.merchantUserId, input.amount, input.amount),
    ];

    const result = await this.execute(statements, { ...input, amount: input.amount, type: 'RESERVE' }, ledgerId);
    if (!result.applied && !result.alreadyApplied) {
      throw new AppError('INSUFFICIENT_WALLET_BALANCE', {
        details: { required: input.amount, available: result.snapshot.availableBalance },
      });
    }
    return result;
  }

  /** Releases a reservation without touching the balance. Safe to call repeatedly. */
  async release(input: {
    merchantUserId: string;
    invoiceId: string;
    amount: Toman;
  }): Promise<MutationResult> {
    if (input.amount <= 0) {
      return { applied: false, alreadyApplied: false, snapshot: await this.snapshot(input.merchantUserId), ledgerId: null };
    }

    const ledgerId = newId('wl');
    const timestamp = nowIso();
    const statements = [
      this.db
        .prepare(
          `INSERT INTO wallet_ledger (
             id, merchant_user_id, type, direction, amount, balance_before, balance_after,
             reserved_before, reserved_after, reference, reference_type, description,
             idempotency_key, created_by, created_at)
           SELECT ?, merchant_user_id, 'RELEASE', 'CREDIT', ?, balance, balance,
                  reserved_balance, MAX(reserved_balance - ?, 0), ?, 'invoice', ?, ?, 'system', ?
           FROM wallets
           WHERE merchant_user_id = ? AND reserved_balance >= ?`,
        )
        .bind(
          ledgerId,
          input.amount,
          input.amount,
          input.invoiceId,
          'آزادسازی رزرو فاکتور',
          WalletService.releaseIdempotencyKey(input.invoiceId),
          timestamp,
          input.merchantUserId,
          input.amount,
        ),
      this.db
        .prepare(
          `UPDATE wallets
           SET reserved_balance = MAX(reserved_balance - ?, 0), version = version + 1, updated_at = ?
           WHERE merchant_user_id = ? AND reserved_balance >= ?`,
        )
        .bind(input.amount, timestamp, input.merchantUserId, input.amount),
    ];

    return this.execute(statements, { ...input, amount: input.amount, type: 'RELEASE' }, ledgerId);
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  async ledger(
    merchantUserId: string,
    options: { limit?: number; offset?: number; type?: LedgerType } = {},
  ): Promise<LedgerRow[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    if (options.type) {
      return all<LedgerRow>(
        this.db,
        `SELECT * FROM wallet_ledger WHERE merchant_user_id = ? AND type = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
        [merchantUserId, options.type, limit, offset],
      );
    }
    return all<LedgerRow>(
      this.db,
      `SELECT * FROM wallet_ledger WHERE merchant_user_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [merchantUserId, limit, offset],
    );
  }

  async ledgerEntryFor(idempotencyKey: string): Promise<LedgerRow | null> {
    return first<LedgerRow>(this.db, 'SELECT * FROM wallet_ledger WHERE idempotency_key = ?', [idempotencyKey]);
  }

  /**
   * Verifies that a wallet's stored balance equals the sum of its ledger.
   *
   * This is the reconciliation query that makes the ledger worth having: if the two
   * ever disagree, something wrote to `wallets` without going through this service,
   * and the admin health page should say so loudly.
   */
  async reconcile(merchantUserId: string): Promise<{
    storedBalance: number;
    ledgerBalance: number;
    agrees: boolean;
    storedReserved: number;
    ledgerReserved: number;
    reservedAgrees: boolean;
  }> {
    const row = await first<{
      stored_balance: number;
      stored_reserved: number;
      ledger_balance: number | null;
      ledger_reserved: number | null;
    }>(
      this.db,
      `SELECT
         w.balance AS stored_balance,
         w.reserved_balance AS stored_reserved,
         COALESCE((
           SELECT SUM(CASE WHEN l.direction = 'CREDIT' AND l.type NOT IN ('RESERVE','RELEASE') THEN l.amount
                           WHEN l.direction = 'DEBIT' AND l.type NOT IN ('RESERVE','RELEASE') THEN -l.amount
                           ELSE 0 END)
           FROM wallet_ledger l WHERE l.merchant_user_id = w.merchant_user_id
         ), 0) AS ledger_balance,
         COALESCE((
           SELECT SUM(CASE WHEN l.type = 'RESERVE' THEN l.amount WHEN l.type = 'RELEASE' THEN -l.amount ELSE 0 END)
           FROM wallet_ledger l WHERE l.merchant_user_id = w.merchant_user_id
         ), 0) AS ledger_reserved
       FROM wallets w WHERE w.merchant_user_id = ?`,
      [merchantUserId],
    );

    if (!row) {
      return {
        storedBalance: 0,
        ledgerBalance: 0,
        agrees: true,
        storedReserved: 0,
        ledgerReserved: 0,
        reservedAgrees: true,
      };
    }

    const ledgerBalance = row.ledger_balance ?? 0;
    const ledgerReserved = Math.max(0, row.ledger_reserved ?? 0);
    return {
      storedBalance: row.stored_balance,
      ledgerBalance,
      agrees: row.stored_balance === ledgerBalance,
      storedReserved: row.stored_reserved,
      ledgerReserved,
      reservedAgrees: row.stored_reserved === ledgerReserved,
    };
  }

  /**
   * Runs a two-statement mutation and interprets the outcome.
   *
   * A UNIQUE violation on `wallet_ledger.idempotency_key` is the replay signal —
   * and because the batch rolled back, no money moved, which is exactly the
   * behaviour required for a retried fee charge.
   */
  private async execute(
    statements: D1PreparedStatement[],
    input: MutationInput,
    ledgerId: string,
  ): Promise<MutationResult> {
    try {
      const results = await batch(this.db, statements);
      const ledgerInserted = (results[0]?.meta?.changes ?? 0) > 0;
      const walletUpdated = (results[1]?.meta?.changes ?? 0) > 0;
      const snapshot = await this.snapshot(input.merchantUserId);

      // Both must have taken effect. If the ledger row landed but the wallet update
      // did not, something is wrong with the pair and the batch should have rolled
      // back; report it rather than pretending success.
      if (ledgerInserted && !walletUpdated && input.type !== 'RESERVE' && input.type !== 'RELEASE') {
        throw new AppError('LEDGER_CONFLICT', {
          message: 'سازگاری دفتر کل و موجودی کیف پول برقرار نشد.',
          details: { ledgerId, merchantUserId: input.merchantUserId, type: input.type },
        });
      }

      return { applied: ledgerInserted, alreadyApplied: false, snapshot, ledgerId: ledgerInserted ? ledgerId : null };
    } catch (error) {
      if (isUniqueViolation(error, 'wallet_ledger.idempotency_key')) {
        const snapshot = await this.snapshot(input.merchantUserId);
        const existing = input.idempotencyKey
          ? await this.ledgerEntryFor(input.idempotencyKey)
          : null;
        return { applied: false, alreadyApplied: true, snapshot, ledgerId: existing?.id ?? null };
      }
      throw error;
    }
  }
}

export function walletFor(db: D1Database): WalletService {
  return new WalletService(db);
}
