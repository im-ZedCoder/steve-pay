/**
 * Payment confirmation (§52, §53, §72).
 *
 * This is the function where money becomes committed. It is written so that
 * running it twice for the same bank transaction is harmless, because every path
 * that can reach it is a path that can run twice: a queue redelivery, a cron
 * retry, an admin clicking confirm while the automatic matcher is mid-flight.
 *
 * Three independent guards, in order, each sufficient on its own:
 *   1. The invoice must be in a settleable state. The status guard is in the
 *      UPDATE's WHERE clause, so a concurrent confirmation updates zero rows.
 *   2. `transactions.bank_reference` is UNIQUE among CONFIRMED rows, so the same
 *      bank reference can settle at most one transaction.
 *   3. `transaction_fingerprints` claims the composite transaction, covering the
 *      case where the bank supplied no reference number.
 *
 * The wallet fee is a *fourth* guard — `fee:<invoiceId>` on the ledger — because a
 * duplicate fee charge is a different failure from a duplicate settlement, and
 * needs its own protection.
 */

import { AppError } from '../core/errors';
import { id as newId } from '../core/ids';
import { nowIso, minutesBetween } from '../core/time';
import { computeSettlement } from '../core/fees';
import { compositeFingerprint } from '../core/matching';
import { all, first, run, isUniqueViolation, isCheckViolation } from '../db/client';
import { SettingsService } from './settings';
import { AuditService } from './audit';
import { WalletService } from './wallet';
import type { InvoiceService, InvoiceRow } from './invoices';
import type { ParsedSms } from '../core/sms/types';

export interface ConfirmInput {
  db: D1Database;
  settings: SettingsService;
  audit: AuditService;
  invoices: InvoiceService;
  invoice: InvoiceRow;
  parsed: ParsedSms;
  smsMessageId: string | null;
  receivedAt: string;
  matchScore: number;
  matchReasons: string[];
  confirmation: 'AUTOMATIC' | 'MANUAL';
  confirmedBy?: string | null;
  requestId: string;
}

export interface ConfirmResult {
  confirmed: boolean;
  outcome: 'CONFIRMED' | 'ALREADY_PAID' | 'DUPLICATE_TRANSACTION' | 'STATE_REJECTED' | 'ERROR';
  transactionId: string | null;
  detail: string;
  settlement?: { platformTake: number; merchantNet: number; feeCharged: boolean };
}

export async function confirmPayment(input: ConfirmInput): Promise<ConfirmResult> {
  const { db, invoice, parsed, receivedAt } = input;
  const wallet = new WalletService(db);

  if (invoice.status === 'PAID') {
    return {
      confirmed: false,
      outcome: 'ALREADY_PAID',
      transactionId: invoice.transaction_id,
      detail: 'این فاکتور قبلاً پرداخت شده است.',
    };
  }

  const receivedAmount = parsed.amountToman ?? invoice.payable_amount;
  const suffix = invoice.unique_suffix;
  const suffixOwner = await input.settings.suffixRemainderOwner();

  let settlement;
  try {
    settlement = computeSettlement({
      receivedAmount,
      originalAmount: invoice.original_amount,
      customerFee: invoice.customer_fee,
      merchantFee: invoice.merchant_fee,
      uniqueSuffix: suffix,
      feeMode: invoice.fee_mode,
      suffixRemainderOwner: suffixOwner,
    });
  } catch (error) {
    return {
      confirmed: false,
      outcome: 'ERROR',
      transactionId: null,
      detail: error instanceof AppError ? error.message : 'محاسبه تسویه انجام نشد.',
    };
  }

  const transactionId = newId('txn');
  const timestamp = nowIso();

  // --- guard 2: claim the bank reference ---------------------------------
  // The insert carries the reference, and the partial unique index on
  // transactions.bank_reference is what rejects a second settlement of the same
  // bank transaction. There is no read-then-write here to race against.
  try {
    await run(
      input.db,
      `INSERT INTO transactions (
         id, invoice_id, payment_id, merchant_user_id, sms_message_id, status, confirmation,
         amount, original_amount, fee_total, customer_fee, merchant_fee, net_amount, currency,
         bank_reference, matched_by, match_score, match_reasons, confirmed_by, card_id,
         is_test, created_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?, ?, ?, 'IRT', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transactionId,
        invoice.id,
        invoice.payment_id,
        invoice.merchant_user_id,
        input.smsMessageId,
        input.confirmation,
        receivedAmount,
        invoice.original_amount,
        invoice.gateway_fee,
        invoice.customer_fee,
        invoice.merchant_fee,
        settlement.merchantNet,
        parsed.reference,
        'ruleset-v1',
        input.matchScore,
        JSON.stringify(input.matchReasons),
        input.confirmedBy ?? null,
        invoice.card_id,
        invoice.is_test,
        timestamp,
        timestamp,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error, 'transactions.bank_reference')) {
      const existing = await first<{ id: string; invoice_id: string }>(
        input.db,
        `SELECT id, invoice_id FROM transactions WHERE bank_reference = ? AND status = 'CONFIRMED'`,
        [parsed.reference],
      );
      return {
        confirmed: false,
        outcome: 'DUPLICATE_TRANSACTION',
        transactionId: existing?.id ?? null,
        detail: 'این شماره پیگیری بانکی قبلاً تسویه شده است.',
      };
    }
    if (isUniqueViolation(error, 'payment_id')) {
      return {
        confirmed: false,
        outcome: 'DUPLICATE_TRANSACTION',
        transactionId: null,
        detail: 'برای این پرداخت قبلاً تراکنش ثبت شده است.',
      };
    }
    throw error;
  }

  // --- guard 3: claim the composite fingerprint --------------------------
  const fingerprint = compositeFingerprint({
    direction: parsed.direction,
    amountToman: receivedAmount,
    destinationCard: parsed.destinationCard,
    occurredAt: parsed.occurredAt,
    receivedAt,
  });

  try {
    await run(
      input.db,
      `INSERT INTO transaction_fingerprints (
         merchant_user_id, fingerprint, kind, transaction_id, sms_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        invoice.merchant_user_id,
        fingerprint,
        parsed.reference ? 'BANK_REFERENCE' : 'COMPOSITE',
        transactionId,
        input.smsMessageId,
        timestamp,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error, 'transaction_fingerprints')) {
      // Someone else claimed this exact transaction while we were inserting the
      // transaction row. Compensate rather than leave an orphan settlement: the
      // transaction is reversed, which keeps the ledger honest about what happened.
      await run(
        input.db,
        `UPDATE transactions SET status = 'REVERSED', match_reasons = ? WHERE id = ?`,
        [JSON.stringify([...input.matchReasons, 'FINGERPRINT_CLAIMED_ELSEWHERE']), transactionId],
      );
      return {
        confirmed: false,
        outcome: 'DUPLICATE_TRANSACTION',
        transactionId,
        detail: 'این تراکنش بانکی هم‌زمان توسط درخواست دیگری ثبت شد و این مورد ثبت نشد.',
      };
    }
    throw error;
  }

  // --- guard 1: settle the invoice ---------------------------------------
  // Status guard in the WHERE clause. Zero rows here means another writer got there
  // first, and the transaction we just wrote must be reversed.
  const settle = await run(
    input.db,
    `UPDATE invoices
     SET status = 'PAID', paid_at = ?, updated_at = ?, received_amount = ?, net_amount = ?,
         settled_fee = ?, transaction_id = ?, match_score = ?, match_reasons = ?
     WHERE id = ? AND status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING','MANUAL_REVIEW')`,
    [
      timestamp,
      timestamp,
      receivedAmount,
      settlement.merchantNet,
      settlement.platformTake,
      transactionId,
      input.matchScore,
      JSON.stringify(input.matchReasons),
      invoice.id,
    ],
  );

  if (settle.changes === 0) {
    await run(
      input.db,
      `UPDATE transactions SET status = 'REVERSED', match_reasons = ? WHERE id = ?`,
      [JSON.stringify([...input.matchReasons, 'INVOICE_STATE_GUARD_REJECTED']), transactionId],
    );
    return {
      confirmed: false,
      outcome: 'STATE_REJECTED',
      transactionId,
      detail: 'وضعیت فاکتور اجازه تأیید نداد؛ درخواست دیگری هم‌زمان آن را تغییر داده است.',
    };
  }

  await run(input.db, 'UPDATE payments SET status = ?, updated_at = ?, confirmed_at = ? WHERE invoice_id = ?', [
    'PAID',
    timestamp,
    timestamp,
    invoice.id,
  ]);

  // --- wallet: capture the fee or release the reservation -----------------
  let feeCharged = false;
  if (invoice.fee_mode === 'MERCHANT' && invoice.merchant_fee > 0) {
    // Charge first, then release the reservation. If the charge succeeds and the
    // release fails, the merchant is over-reserved rather than under-charged, and
    // the reconciliation sweep fixes the reservation. The reverse order would risk
    // releasing the reservation before the charge and leaving the fee uncollected.
    const charge = await wallet.chargeFee({
      merchantUserId: invoice.merchant_user_id,
      invoiceId: invoice.id,
      amount: invoice.merchant_fee,
    });
    feeCharged = charge.applied;

    if (!charge.applied && !charge.alreadyApplied) {
      // The invoice is settled and the customer has paid, so a failed fee charge
      // must never un-settle it (§72 rule 11). It becomes a receivable instead: the
      // debit is attempted, fails, and finance is alerted.
      await run(
        input.db,
        `INSERT INTO system_events (level, scope, message, metadata, created_at) VALUES ('ERROR', 'wallet.fee', ?, ?, ?)`,
        [
          'fee charge failed after settlement',
          JSON.stringify({
            invoiceId: invoice.id,
            merchantUserId: invoice.merchant_user_id,
            fee: invoice.merchant_fee,
            available: charge.snapshot.availableBalance,
          }),
          nowIso(),
        ],
      );
      await input.settings.set('wallet.last_fee_charge_failure', invoice.id, null);
    }
  }

  if (invoice.fee_mode === 'MERCHANT' && invoice.merchant_fee > 0) {
    try {
      await wallet.release({
        merchantUserId: invoice.merchant_user_id,
        invoiceId: invoice.id,
        amount: invoice.merchant_fee,
      });
    } catch {
      // Reconciled by cron; not worth failing a settled payment over.
    }
  }

  // --- card statistics ----------------------------------------------------
  if (invoice.card_id) {
    await run(
      input.db,
      'UPDATE bank_cards SET success_count = success_count + 1, updated_at = ? WHERE id = ?',
      [timestamp, invoice.card_id],
    );
  }

  // --- audit --------------------------------------------------------------
  await input.audit.record({
    event: input.confirmation === 'MANUAL' ? 'payment.manual_confirmed' : 'payment.confirmed',
    actor: { userId: input.confirmedBy ?? null },
    merchantUserId: invoice.merchant_user_id,
    targetType: 'transaction',
    targetId: transactionId,
    requestId: input.requestId,
    severity: input.confirmation === 'MANUAL' ? 'WARNING' : 'INFO',
    metadata: {
      invoiceId: invoice.id,
      receivedAmount,
      originalAmount: invoice.original_amount,
      merchantNet: settlement.merchantNet,
      platformTake: settlement.platformTake,
      feeMode: invoice.fee_mode,
      feeCharged,
      reference: parsed.reference,
      bank: parsed.bank,
      confirmation: input.confirmation,
      minutesToPayment: minutesBetween(invoice.created_at, timestamp),
      matchScore: input.matchScore,
    },
  });

  return {
    confirmed: true,
    outcome: 'CONFIRMED',
    transactionId,
    detail: 'پرداخت با موفقیت تأیید شد.',
    settlement: { platformTake: settlement.platformTake, merchantNet: settlement.merchantNet, feeCharged },
  };
}

/** Reverses a confirmed transaction, appending compensating ledger entries (§60). */
export async function reverseTransaction(input: {
  db: D1Database;
  audit: AuditService;
  transactionId: string;
  actorUserId: string;
  actorRole: string;
  reason: string;
  requestId: string;
}): Promise<void> {
  const txn = await first<{
    id: string;
    invoice_id: string;
    merchant_user_id: string;
    amount: number;
    merchant_fee: number;
    status: string;
  }>(
    input.db,
    'SELECT id, invoice_id, merchant_user_id, amount, merchant_fee, status FROM transactions WHERE id = ?',
    [input.transactionId],
  );
  if (!txn) throw new AppError('TRANSACTION_NOT_FOUND');
  if (txn.status !== 'CONFIRMED') {
    throw new AppError('STATE_TRANSITION_INVALID', { message: 'فقط تراکنش تأییدشده قابل بازگشت است.' });
  }

  await input.db.batch([
    input.db
      .prepare(`UPDATE transactions SET status = 'REVERSED' WHERE id = ?`)
      .bind(input.transactionId),
    input.db
      .prepare(`UPDATE invoices SET status = 'REFUNDED', updated_at = ? WHERE id = ?`)
      .bind(nowIso(), txn.invoice_id),
    input.db
      .prepare(`UPDATE payments SET status = 'REFUNDED', updated_at = ? WHERE invoice_id = ?`)
      .bind(nowIso(), txn.invoice_id),
  ]);

  // A reversal is a new ledger row, never a mutated one: the ledger is append-only.
  if (txn.merchant_fee > 0) {
    await new WalletService(input.db).credit({
      merchantUserId: txn.merchant_user_id,
      amount: txn.merchant_fee,
      type: 'REVERSAL',
      reference: input.transactionId,
      referenceType: 'transaction',
      description: 'بازگشت کارمزد پس از ابطال تراکنش',
      idempotencyKey: `reversal:${input.transactionId}`,
      createdBy: input.actorUserId,
    });
  }

  await input.audit.record({
    event: 'payment.refunded',
    actor: { userId: input.actorUserId, role: input.actorRole },
    merchantUserId: txn.merchant_user_id,
    targetType: 'transaction',
    targetId: input.transactionId,
    requestId: input.requestId,
    severity: 'CRITICAL',
    metadata: { reason: input.reason, invoiceId: txn.invoice_id, feeReturned: txn.merchant_fee },
  });
}

/** Aggregate stats for the admin health and analytics screens. */
export async function transactionStats(db: D1Database): Promise<Record<string, number>> {
  const row = await first<Record<string, number>>(
    db,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'CONFIRMED' THEN 1 ELSE 0 END) AS confirmed,
       SUM(CASE WHEN status = 'REVERSED' THEN 1 ELSE 0 END) AS reversed,
       SUM(CASE WHEN confirmation = 'MANUAL' THEN 1 ELSE 0 END) AS manual,
       COALESCE(SUM(CASE WHEN status = 'CONFIRMED' THEN amount ELSE 0 END), 0) AS volume,
       COALESCE(SUM(CASE WHEN status = 'CONFIRMED' THEN fee_total ELSE 0 END), 0) AS fees
     FROM transactions`,
  );
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(row ?? {})) out[key] = Number(value ?? 0);
  return out;
}

void all;
void isCheckViolation;
