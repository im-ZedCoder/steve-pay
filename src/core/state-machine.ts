/**
 * Payment state machine (§13).
 *
 * Every status change goes through `assertTransition`. There is no code path that
 * writes `invoices.status` without passing through here, and every transition is
 * written to the audit log by the caller.
 *
 *   CREATED ──> PENDING ──> PAYMENT_DETECTED ──> CONFIRMING ──> PAID
 *      │           │               │                 │
 *      │           │               │                 └──> MANUAL_REVIEW ──> PAID
 *      │           │               └──> MANUAL_REVIEW                      └──> FAILED
 *      │           └──> EXPIRED / CANCELLED
 *      └──> CANCELLED
 *
 *   PAID ──> REFUNDED   (a settled payment may be reversed, never un-paid)
 */

import { AppError } from './errors';

export type InvoiceStatus =
  | 'CREATED'
  | 'PENDING'
  | 'PAYMENT_DETECTED'
  | 'CONFIRMING'
  | 'PAID'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'MANUAL_REVIEW'
  | 'REFUNDED';

export const INVOICE_STATUSES: readonly InvoiceStatus[] = [
  'CREATED',
  'PENDING',
  'PAYMENT_DETECTED',
  'CONFIRMING',
  'PAID',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'MANUAL_REVIEW',
  'REFUNDED',
];

/**
 * Statuses during which an invoice holds its payable amount.
 *
 * THIS LIST MUST MATCH the WHERE clause of ux_invoices_active_amount in
 * migrations/0002_money.sql. If the index and this constant disagree, the database
 * will happily allow two live invoices to share an amount while the application
 * believes it is preventing it. `tests/unit/state-machine.test.ts` reads the
 * migration file and fails if the two drift apart.
 *
 * MANUAL_REVIEW is included deliberately: a payment under review has almost
 * certainly already been made, and releasing its amount would let a second invoice
 * claim the same figure before an admin resolves the first.
 */
export const ACTIVE_AMOUNT_STATUSES: readonly InvoiceStatus[] = [
  'CREATED',
  'PENDING',
  'PAYMENT_DETECTED',
  'CONFIRMING',
  'MANUAL_REVIEW',
];

/** Statuses from which no further transition is possible without a new invoice. */
export const TERMINAL_STATUSES: readonly InvoiceStatus[] = ['PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'];

/** A customer can still transfer money for an invoice in one of these states. */
export const PAYABLE_STATUSES: readonly InvoiceStatus[] = ['CREATED', 'PENDING', 'PAYMENT_DETECTED'];

const TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  CREATED: ['PENDING', 'CANCELLED', 'EXPIRED', 'FAILED'],
  PENDING: ['PAYMENT_DETECTED', 'CONFIRMING', 'MANUAL_REVIEW', 'EXPIRED', 'CANCELLED', 'FAILED'],
  PAYMENT_DETECTED: ['CONFIRMING', 'MANUAL_REVIEW', 'PAID', 'EXPIRED', 'FAILED'],
  CONFIRMING: ['PAID', 'MANUAL_REVIEW', 'FAILED'],
  // A PAID invoice may only be reversed through an explicit refund, which records
  // its own transaction. It can never quietly go back to an unpaid state.
  PAID: ['REFUNDED'],
  MANUAL_REVIEW: ['PAID', 'FAILED', 'EXPIRED', 'CANCELLED'],
  REFUNDED: [],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return typeof value === 'string' && (INVOICE_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function allowedTransitions(from: InvoiceStatus): readonly InvoiceStatus[] {
  return TRANSITIONS[from] ?? [];
}

/**
 * The guard every status write goes through. The message names both states so a
 * support conversation can quote it directly.
 */
export function assertTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (from === to) {
    throw new AppError('STATE_TRANSITION_INVALID', {
      message: `این فاکتور همین حالا در وضعیت ${statusLabelFa(from)} است.`,
      details: { from, to, reason: 'NOOP' },
    });
  }
  if (!canTransition(from, to)) {
    throw new AppError('STATE_TRANSITION_INVALID', {
      message: `تغییر وضعیت از ${statusLabelFa(from)} به ${statusLabelFa(to)} مجاز نیست.`,
      details: { from, to, allowed: allowedTransitions(from) },
    });
  }
}

/** True when a transition is impossible, without throwing. For UI disabling. */
export function isTerminal(status: InvoiceStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function holdsAmount(status: InvoiceStatus): boolean {
  return ACTIVE_AMOUNT_STATUSES.includes(status);
}

export function isPayable(status: InvoiceStatus): boolean {
  return PAYABLE_STATUSES.includes(status);
}

/**
 * Whether a customer opening this invoice should see a live payment page.
 * Distinguishes the failure states so the page can explain what actually happened
 * instead of a generic error.
 */
export type InvoiceOpenability =
  | { kind: 'PAYABLE' }
  | { kind: 'PAID' }
  | { kind: 'EXPIRED' }
  | { kind: 'CANCELLED' }
  | { kind: 'REVIEW' }
  | { kind: 'FAILED' }
  | { kind: 'REFUNDED' };

export function openability(status: InvoiceStatus): InvoiceOpenability {
  switch (status) {
    case 'CREATED':
    case 'PENDING':
      return { kind: 'PAYABLE' };
    case 'PAYMENT_DETECTED':
    case 'CONFIRMING':
      // Money has arrived and is being verified. The page should say so rather
      // than invite a second transfer.
      return { kind: 'REVIEW' };
    case 'PAID':
      return { kind: 'PAID' };
    case 'EXPIRED':
      return { kind: 'EXPIRED' };
    case 'CANCELLED':
      return { kind: 'CANCELLED' };
    case 'MANUAL_REVIEW':
      return { kind: 'REVIEW' };
    case 'FAILED':
      return { kind: 'FAILED' };
    case 'REFUNDED':
      return { kind: 'REFUNDED' };
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return { kind: 'FAILED' };
    }
  }
}

const STATUS_LABELS_FA: Record<InvoiceStatus, string> = {
  CREATED: 'ایجاد شده',
  PENDING: 'در انتظار پرداخت',
  PAYMENT_DETECTED: 'پرداخت شناسایی شد',
  CONFIRMING: 'در حال تأیید',
  PAID: 'پرداخت شده',
  FAILED: 'ناموفق',
  EXPIRED: 'منقضی شده',
  CANCELLED: 'لغو شده',
  MANUAL_REVIEW: 'در بررسی دستی',
  REFUNDED: 'بازگشت داده شده',
};

export function statusLabelFa(status: InvoiceStatus): string {
  return STATUS_LABELS_FA[status] ?? status;
}

/**
 * The coarse bucket a status belongs to, for dashboard counters and charts where
 * six distinct words would be noise.
 */
export type StatusBucket = 'successful' | 'pending' | 'failed' | 'expired' | 'review' | 'cancelled';

export function statusBucket(status: InvoiceStatus): StatusBucket {
  switch (status) {
    case 'PAID':
      return 'successful';
    case 'CREATED':
    case 'PENDING':
    case 'PAYMENT_DETECTED':
    case 'CONFIRMING':
      return 'pending';
    case 'MANUAL_REVIEW':
      return 'review';
    case 'EXPIRED':
      return 'expired';
    case 'CANCELLED':
      return 'cancelled';
    case 'FAILED':
    case 'REFUNDED':
    default:
      return 'failed';
  }
}

/**
 * The `status` filter values the transactionsCount API accepts (§7).
 * These are buckets rather than raw statuses so a merchant can ask for
 * "successful" without knowing the internal state list.
 */
export type StatusFilter = 'successful' | 'pending' | 'expired' | 'failed' | 'all';

export function statusesForFilter(filter: StatusFilter): readonly InvoiceStatus[] {
  switch (filter) {
    case 'successful':
      return ['PAID'];
    case 'pending':
      return ['CREATED', 'PENDING', 'PAYMENT_DETECTED', 'CONFIRMING'];
    case 'expired':
      return ['EXPIRED'];
    case 'failed':
      return ['FAILED', 'CANCELLED', 'REFUNDED'];
    case 'all':
    default:
      return INVOICE_STATUSES;
  }
}
