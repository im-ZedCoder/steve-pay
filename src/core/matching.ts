/**
 * Transaction matching (§18, §55).
 *
 * The matcher decides which invoice an incoming bank SMS belongs to, and whether
 * that decision is confident enough to settle automatically. It is deliberately
 * *not* `amount == invoice.amount`:
 *
 *   EXACT_AMOUNT        required    — the amount is the identifier; a near miss is
 *                                     never a match
 *   LIVE_INVOICE        required    — an invoice that has already settled cannot
 *                                     be paid twice
 *   NOT_DUPLICATE       required    — the bank reference or fingerprint must be new
 *   TIME_WINDOW         required    — money that arrived outside the window is a
 *                                     human's problem, not the matcher's
 *   CARD_MATCH          preferred   — configurable to required
 *   PARSER_CONFIDENCE   required    — a low-confidence parse must not move money
 *   AMBIGUITY           forbidden   — two candidates means nobody wins
 *
 * Every rule produces a named reason. The reasons are persisted and rendered on
 * the manual review screen, so an operator sees *why* the matcher hesitated rather
 * than just a score.
 *
 * The function is pure: candidates are supplied by the caller, the clock is
 * injected, and there is no database access. That is what makes the whole set of
 * rules testable without a fixture database.
 */

import type { InvoiceStatus } from './state-machine';
import type { ParsedSms } from './sms/types';
import { epochMs } from './time';
import { cardLast4 } from './card';

export interface MatchCandidate {
  invoiceId: string;
  merchantUserId: string;
  status: InvoiceStatus;
  payableAmount: number;
  baseAmount: number;
  /** Card the invoice is directing the customer to. */
  cardId: string | null;
  cardNumber: string | null;
  createdAt: string;
  expiresAt: string;
  isTest: boolean;
}

export interface MatchConfig {
  /** Minutes before invoice creation an SMS may still be accepted for it. */
  timeWindowMinutesBefore: number;
  /** Minutes after expiry an SMS may still be accepted — routed to review. */
  timeWindowMinutesAfter: number;
  requireCardMatch: boolean;
  minConfidenceAutoConfirm: number;
  autoConfirmEnabled: boolean;
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  timeWindowMinutesBefore: 10,
  timeWindowMinutesAfter: 90,
  requireCardMatch: false,
  minConfidenceAutoConfirm: 70,
  autoConfirmEnabled: true,
};

/** Version stamp recorded on every transaction so a rules change is traceable. */
export const MATCH_RULESET = 'ruleset-v1';

export type MatchReasonCode =
  | 'EXACT_AMOUNT'
  | 'NO_AMOUNT'
  | 'AMOUNT_NOT_FOUND'
  | 'AMBIGUOUS_AMOUNT'
  | 'INVOICE_LIVE'
  | 'INVOICE_EXPIRED_LATE_PAYMENT'
  | 'INVOICE_ALREADY_PAID'
  | 'INVOICE_CANCELLED'
  | 'INVOICE_ALREADY_UNDER_REVIEW'
  | 'TIME_WINDOW_BEFORE'
  | 'TIME_WINDOW_AFTER'
  | 'TIME_WINDOW_OK'
  | 'TIME_FROM_RECEIPT'
  | 'CARD_MATCH'
  | 'CARD_MISMATCH'
  | 'CARD_MATCH_REQUIRED'
  | 'CARD_UNKNOWN'
  | 'LOW_CONFIDENCE'
  | 'AUTO_CONFIRM_DISABLED'
  | 'DIRECTION_OUT'
  | 'DIRECTION_UNKNOWN'
  | 'RATE_UNIT_INFERRED'
  | 'TEST_MESSAGE';

export interface MatchReason {
  code: MatchReasonCode;
  /** Human sentence in Persian, shown on the review screen. */
  detail: string;
  /** True when this reason forces the decision to MANUAL_REVIEW. */
  blocking: boolean;
}

export type MatchDecisionType =
  | 'MATCH'          // confident: settle automatically
  | 'MANUAL_REVIEW'  // a plausible match that a human must confirm
  | 'NO_MATCH'       // nothing plausible
  | 'DUPLICATE'      // this bank transaction has already been settled
  | 'IGNORED';       // not an incoming payment at all

export interface MatchDecision {
  type: MatchDecisionType;
  invoiceId: string | null;
  /** 0-100. How sure the matcher is that this is the right invoice. */
  score: number;
  reasons: MatchReason[];
  ruleset: string;
  /** Candidates whose amount was close but not exact. Advisory, for the reviewer. */
  nearMisses: Array<{ invoiceId: string; payableAmount: number; difference: number }>;
}

function reason(code: MatchReasonCode, detail: string, blocking = false): MatchReason {
  return { code, detail, blocking };
}

/**
 * Score of a match on amount + time + card, 0-100.
 *
 * Weighted so that amount and liveness dominate, because those are the two things
 * that are actually required; a card match is a bonus and a stale timestamp is a
 * deduction.
 */
function scoreCandidate(
  candidate: MatchCandidate,
  parsed: ParsedSms,
  assessment: { timeDeltaMinutes: number; cardMatch: boolean | null; withinBefore: boolean },
): number {
  let score = 55; // exact amount, matched by the caller

  if (candidate.status === 'PENDING' || candidate.status === 'CREATED') score += 10;
  if (assessment.cardMatch === true) score += 15;
  if (assessment.cardMatch === null) score += 0;
  if (assessment.cardMatch === false) score -= 20;

  // Confidence in the parse itself carries through.
  score += Math.round((parsed.confidence / 100) * 15);

  // A stated timestamp that sits inside the live window is a good sign; a receipt
  // time standing in for a missing stamp is weaker.
  if (assessment.withinBefore && assessment.timeDeltaMinutes > -60) score += 5;

  if (parsed.direction === 'UNKNOWN') score -= 5;

  return Math.max(0, Math.min(100, score));
}

export interface MatchInput {
  parsed: ParsedSms;
  candidates: readonly MatchCandidate[];
  config: MatchConfig;
  /** Server time, injected so the rules are deterministic under test. */
  now: string;
  /**
   * True when this bank transaction has already been claimed — by bank reference
   * or by composite fingerprint. Checked before the matcher runs, but carried
   * through here so the decision can explain itself.
   */
  duplicateOf?: string | null;
  /** Set when the message carried a test marker (§15). Never settles anything. */
  isTestMessage?: boolean;
}

/**
 * Resolves an SMS against candidate invoices.
 *
 * The order of the checks is the order of certainty: "is this even a payment",
 * then "have we seen it", then "is there exactly one amount match", then "is that
 * match safe to settle automatically".
 */
export function decideMatch(input: MatchInput): MatchDecision {
  const { parsed, candidates, config, now } = input;
  const reasons: MatchReason[] = [];

  if (input.isTestMessage) {
    return {
      type: 'IGNORED',
      invoiceId: null,
      score: 0,
      reasons: [reason('TEST_MESSAGE', 'این پیامک آزمایشی است و تراکنش واقعی ایجاد نمی‌کند.', true)],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  // A withdrawal or a purchase notification is not money arriving.
  if (parsed.direction === 'OUT') {
    return {
      type: 'IGNORED',
      invoiceId: null,
      score: 0,
      reasons: [reason('DIRECTION_OUT', 'این پیامک برداشت از حساب است، نه واریز.', true)],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  if (parsed.amountToman === null || parsed.amountToman <= 0) {
    return {
      type: 'NO_MATCH',
      invoiceId: null,
      score: 0,
      reasons: [reason('NO_AMOUNT', 'در متن پیامک مبلغ قابل استخراجی پیدا نشد.', true)],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  // Already-settled bank transaction. The reference or fingerprint claim is the
  // authority; this decision only reports it.
  if (input.duplicateOf) {
    return {
      type: 'DUPLICATE',
      invoiceId: input.duplicateOf,
      score: 100,
      reasons: [
        reason('INVOICE_ALREADY_PAID', 'این تراکنش بانکی قبلاً ثبت و تسویه شده است.', true),
      ],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  const exact = candidates.filter((candidate) => candidate.payableAmount === parsed.amountToman);

  if (exact.length === 0) {
    // Provide the reviewer with the closest things, which is what turns "no match"
    // from a dead end into a five-second decision.
    const nearMisses = candidates
      .map((candidate) => ({
        invoiceId: candidate.invoiceId,
        payableAmount: candidate.payableAmount,
        difference: candidate.payableAmount - (parsed.amountToman ?? 0),
      }))
      .filter((entry) => Math.abs(entry.difference) <= 20_000)
      .sort((a, b) => Math.abs(a.difference) - Math.abs(b.difference))
      .slice(0, 5);

    return {
      type: 'NO_MATCH',
      invoiceId: null,
      score: 0,
      reasons: [
        reason(
          'AMOUNT_NOT_FOUND',
          `مبلغ ${parsed.amountToman} تومان به هیچ فاکتور فعالی تعلق ندارد.`,
          true,
        ),
      ],
      ruleset: MATCH_RULESET,
      nearMisses,
    };
  }

  // Two live invoices cannot share an amount — the partial unique index forbids it.
  // Reaching this branch means an amount was released and reclaimed, or the index
  // was bypassed. Either way, picking one would be a coin flip with someone's
  // money, so it goes to a human.
  if (exact.length > 1) {
    return {
      type: 'MANUAL_REVIEW',
      invoiceId: null,
      score: 0,
      reasons: [
        reason(
          'AMBIGUOUS_AMOUNT',
          `${exact.length} فاکتور با مبلغ یکسان پیدا شد. انتخاب خودکار انجام نشد.`,
          true,
        ),
      ],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  const candidate = exact[0] as MatchCandidate;
  reasons.push(reason('EXACT_AMOUNT', `مبلغ ${parsed.amountToman} تومان دقیقاً با این فاکتور می‌خواند.`));

  // --- liveness -------------------------------------------------------------
  if (candidate.status === 'PAID') {
    return {
      type: 'DUPLICATE',
      invoiceId: candidate.invoiceId,
      score: 100,
      reasons: [
        ...reasons,
        reason('INVOICE_ALREADY_PAID', 'این فاکتور قبلاً پرداخت شده است.', true),
      ],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  if (candidate.status === 'CANCELLED') {
    return {
      type: 'MANUAL_REVIEW',
      invoiceId: candidate.invoiceId,
      score: 30,
      reasons: [...reasons, reason('INVOICE_CANCELLED', 'این فاکتور لغو شده است.', true)],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  if (candidate.status === 'MANUAL_REVIEW') {
    return {
      type: 'MANUAL_REVIEW',
      invoiceId: candidate.invoiceId,
      score: 40,
      reasons: [
        ...reasons,
        reason('INVOICE_ALREADY_UNDER_REVIEW', 'این فاکتور از قبل در بررسی دستی است.', true),
      ],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  if (candidate.status === 'EXPIRED') {
    // §12: a late payment never auto-confirms an expired invoice.
    return {
      type: 'MANUAL_REVIEW',
      invoiceId: candidate.invoiceId,
      score: 35,
      reasons: [
        ...reasons,
        reason(
          'INVOICE_EXPIRED_LATE_PAYMENT',
          'این فاکتور منقضی شده و واریز پس از انقضا انجام شده است. بررسی دستی لازم است.',
          true,
        ),
      ],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  if (candidate.status !== 'CREATED' && candidate.status !== 'PENDING' && candidate.status !== 'PAYMENT_DETECTED' && candidate.status !== 'CONFIRMING') {
    return {
      type: 'MANUAL_REVIEW',
      invoiceId: candidate.invoiceId,
      score: 30,
      reasons: [
        ...reasons,
        reason('INVOICE_ALREADY_UNDER_REVIEW', `وضعیت فاکتور (${candidate.status}) برای تأیید خودکار مناسب نیست.`, true),
      ],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  reasons.push(reason('INVOICE_LIVE', 'فاکتور در وضعیت قابل پرداخت است.'));

  // --- timing ---------------------------------------------------------------
  const windowStart = epochMs(candidate.createdAt) - config.timeWindowMinutesBefore * 60_000;
  const windowEnd = epochMs(candidate.expiresAt) + config.timeWindowMinutesAfter * 60_000;
  const occurredAt = parsed.occurredAt ? epochMs(parsed.occurredAt) : epochMs(now);

  if (occurredAt < windowStart) {
    return {
      type: 'MANUAL_REVIEW',
      invoiceId: candidate.invoiceId,
      score: 25,
      reasons: [
        ...reasons,
        reason(
          'TIME_WINDOW_BEFORE',
          'زمان پیامک پیش از بازه مجاز این فاکتور است؛ ساعت دستگاه یا بانک مشکوک است.',
          true,
        ),
      ],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  if (occurredAt > windowEnd) {
    return {
      type: 'MANUAL_REVIEW',
      invoiceId: candidate.invoiceId,
      score: 25,
      reasons: [
        ...reasons,
        reason('TIME_WINDOW_AFTER', 'زمان پیامک بسیار دیرتر از بازه مجاز این فاکتور است.', true),
      ],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  const timeDeltaMinutes = Math.round((occurredAt - epochMs(candidate.createdAt)) / 60_000);
  const withinBefore = occurredAt >= epochMs(candidate.createdAt);
  reasons.push(reason('TIME_WINDOW_OK', 'زمان پیامک داخل بازه مجاز است.'));
  if (!parsed.occurredAt) reasons.push(reason('TIME_FROM_RECEIPT', 'پیامک تاریخ نداشت؛ زمان دریافت در سرور ملاک است.'));

  // --- live but past its stated expiry within tolerance ---------------------
  const expiredButTolerable = epochMs(candidate.expiresAt) < epochMs(now);
  if (expiredButTolerable) {
    reasons.push(
      reason(
        'INVOICE_EXPIRED_LATE_PAYMENT',
        'فاکتور منقضی شده اما واریز در بازه ارفاقی است؛ بررسی دستی لازم است.',
        true,
      ),
    );
  }

  // --- card ------------------------------------------------------------------
  let cardMatch: boolean | null = null;
  if (parsed.destinationCard && candidate.cardNumber) {
    cardMatch = cardLast4(parsed.destinationCard) === cardLast4(candidate.cardNumber);
    reasons.push(
      cardMatch
        ? reason('CARD_MATCH', `کارت مقصد (${cardLast4(candidate.cardNumber)}) با پیامک می‌خواند.`)
        : reason('CARD_MISMATCH', `کارت مقصد فاکتور با کارت پیامک یکسان نیست.`, config.requireCardMatch),
    );
  } else {
    reasons.push(reason('CARD_UNKNOWN', 'اطلاعات کارت در پیامک یا فاکتور ناقص است.'));
  }

  if (config.requireCardMatch && cardMatch !== true) {
    return {
      type: 'MANUAL_REVIEW',
      invoiceId: candidate.invoiceId,
      score: 40,
      reasons: [...reasons, reason('CARD_MATCH_REQUIRED', 'تطابق کارت برای این حساب الزامی است.', true)],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  // --- confidence ------------------------------------------------------------
  const score = scoreCandidate(candidate, parsed, { timeDeltaMinutes, cardMatch, withinBefore });

  if (parsed.confidence < config.minConfidenceAutoConfirm) {
    return {
      type: 'MANUAL_REVIEW',
      invoiceId: candidate.invoiceId,
      score,
      reasons: [
        ...reasons,
        reason(
          'LOW_CONFIDENCE',
          `اطمینان تجزیه پیامک ${parsed.confidence}٪ است و از حد مجاز ${config.minConfidenceAutoConfirm}٪ کمتر است.`,
          true,
        ),
      ],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  if (!config.autoConfirmEnabled) {
    return {
      type: 'MANUAL_REVIEW',
      invoiceId: candidate.invoiceId,
      score,
      reasons: [
        ...reasons,
        reason('AUTO_CONFIRM_DISABLED', 'تأیید خودکار غیرفعال است.', true),
      ],
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  // Any blocking reason accumulated above (expired-but-tolerable) still wins.
  const blocking = reasons.filter((entry) => entry.blocking);
  if (blocking.length > 0) {
    return {
      type: 'MANUAL_REVIEW',
      invoiceId: candidate.invoiceId,
      score,
      reasons,
      ruleset: MATCH_RULESET,
      nearMisses: [],
    };
  }

  return { type: 'MATCH', invoiceId: candidate.invoiceId, score, reasons, ruleset: MATCH_RULESET, nearMisses: [] };
}

/**
 * The fingerprint used to claim a bank transaction when no reference number is
 * available.
 *
 * Minute granularity, not second: two banks can stamp the same transfer a few
 * seconds apart, and a second-level bucket would let a duplicate slip through.
 * Everything that identifies the transfer is included, so a genuinely distinct
 * second payment of the same amount to the same card in the same minute is the
 * only false positive — and that case is rare enough that a five-minute-wide
 * window is worth it to guarantee no double settlement.
 */
export function compositeFingerprint(input: {
  direction: string;
  amountToman: number;
  destinationCard: string | null;
  occurredAt: string | null;
  receivedAt: string;
}): string {
  const stamp = input.occurredAt ?? input.receivedAt;
  const minuteBucket = Math.floor(epochMs(stamp) / 60_000);
  const card = input.destinationCard ? cardLast4(input.destinationCard) : 'noc';
  return `cf:${input.direction}:${input.amountToman}:${card}:${minuteBucket}`;
}
