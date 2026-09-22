/**
 * Suspicious payment protection (§19).
 *
 * A separate layer from matching, on purpose. The matcher answers "is this the
 * right invoice"; risk answers "should a machine be allowed to settle this at all".
 * Keeping them apart means a risk rule can be added without touching match logic,
 * and the review screen can show two independent verdicts.
 *
 * The posture is asymmetric by design: a false positive costs an operator thirty
 * seconds in the review queue, a false negative moves money that was never sent
 * there. Every rule therefore escalates rather than blocks, and the admin can
 * always confirm manually.
 */

import type { ParsedSms } from './sms/types';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RiskSignal {
  code: RiskCode;
  level: RiskLevel;
  /** Persian sentence rendered on the review screen. */
  detail: string;
  /** Weight contributed to the score. */
  weight: number;
}

export type RiskCode =
  | 'DUPLICATE_SMS'
  | 'DUPLICATE_BANK_REFERENCE'
  | 'DUPLICATE_FINGERPRINT'
  | 'AMOUNT_MATCHES_EXPIRED_INVOICE'
  | 'SIMILAR_AMOUNTS_MANY'
  | 'TIMESTAMP_OUT_OF_WINDOW'
  | 'TIMESTAMP_IN_FUTURE'
  | 'TIMESTAMP_MISSING'
  | 'UNKNOWN_SENDER'
  | 'UNSUPPORTED_BANK_FORMAT'
  | 'AMOUNT_MISMATCH'
  | 'CARD_MISMATCH'
  | 'MERCHANT_CARD_MISMATCH'
  | 'LOW_PARSER_CONFIDENCE'
  | 'DIRECTION_OUT'
  | 'RIAL_TOMAN_AMBIGUOUS'
  | 'SMS_VOLUME_SPIKE'
  | 'INVOICE_ALREADY_PAID'
  | 'UNKNOWN_DEVICE'
  | 'TEST_MESSAGE';

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  signals: RiskSignal[];
  /** True when a human must look before money moves. */
  requiresReview: boolean;
}

export interface RiskInput {
  parsed: ParsedSms;
  /** Server receipt time. */
  now: string;
  /** Parsed occurredAt is more than two minutes in the future. */
  timestampInFuture: boolean;
  /** The message body hash has been seen for this merchant before. */
  duplicateMessage: boolean;
  /** The bank reference has already been claimed by a settled transaction. */
  duplicateReference: boolean;
  /** The fingerprint has already been claimed. */
  duplicateFingerprint: boolean;
  /** No bank recognised the format; only the generic parser handled it. */
  unsupportedFormat: boolean;
  /** Amount matched an invoice that is no longer live. */
  matchedExpiredInvoice: boolean;
  /** Amount matched an invoice that has already settled. */
  matchedPaidInvoice: boolean;
  /** Destination card in the SMS does not match the invoice's card. */
  cardMismatch: boolean;
  /** The shortlist contained several invoices with neighbouring amounts. */
  similarAmountCount: number;
  /** SMS arrivals for this merchant in the last 10 minutes. */
  recentSmsCount: number;
  /** Device id was supplied and has not been seen for this merchant before. */
  unknownDevice: boolean;
  /** Sender id was supplied and has not been seen for this merchant before. */
  unknownSender: boolean;
}

/**
 * Score boundaries. Named rather than inlined so the tuning is reviewable, and
 * because `requiresReview` reads as a policy statement instead of a magic number.
 *
 * There is no HIGH constant: individual signals carry their own weights, and a
 * signal's severity and its weight are separate concepts (a MEDIUM signal can be
 * heavy enough on its own to trigger review).
 */
export const RISK_REVIEW_THRESHOLD = 30;
export const RISK_HIGH_THRESHOLD = 60;

function signal(code: RiskCode, level: RiskLevel, detail: string, weight: number): RiskSignal {
  return { code, level, detail, weight };
}

/**
 * Scores a candidate payment.
 *
 * Thresholds: 60+ is HIGH (always reviewed), 30-59 is MEDIUM (reviewed, and
 * surfaced in the security feed), below 30 is LOW (may settle automatically if the
 * matcher agreed).
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  const signals: RiskSignal[] = [];

  // --- duplicate detection: the most important class of rule -----------------
  if (input.duplicateMessage) {
    signals.push(
      signal('DUPLICATE_SMS', 'HIGH', 'متن این پیامک قبلاً برای همین حساب پردازش شده است.', 60),
    );
  }
  if (input.duplicateReference) {
    signals.push(
      signal('DUPLICATE_BANK_REFERENCE', 'HIGH', 'شماره پیگیری این تراکنش قبلاً تسویه شده است.', 80),
    );
  }
  if (input.duplicateFingerprint) {
    signals.push(
      signal('DUPLICATE_FINGERPRINT', 'HIGH', 'این تراکنش بانکی قبلاً ثبت شده است.', 70),
    );
  }

  // --- invoice state ---------------------------------------------------------
  if (input.matchedPaidInvoice) {
    signals.push(signal('INVOICE_ALREADY_PAID', 'HIGH', 'این فاکتور قبلاً پرداخت شده است.', 55));
  }
  if (input.matchedExpiredInvoice) {
    signals.push(
      signal('AMOUNT_MATCHES_EXPIRED_INVOICE', 'HIGH', 'مبلغ با فاکتوری منقضی‌شده می‌خواند.', 45),
    );
  }

  // --- timing ---------------------------------------------------------------
  if (input.timestampInFuture) {
    signals.push(
      signal('TIMESTAMP_IN_FUTURE', 'HIGH', 'زمان پیامک در آینده است؛ ساعت منبع نامعتبر است.', 45),
    );
  }
  if (!input.parsed.occurredAt || input.parsed.warnings.includes('SMS_DATE_MISSING')) {
    signals.push(signal('TIMESTAMP_MISSING', 'MEDIUM', 'پیامک تاریخ تراکنش نداشت.', 18));
  } else if (input.parsed.warnings.includes('SMS_TIME_INFERRED_FROM_RECEIPT')) {
    signals.push(signal('TIMESTAMP_OUT_OF_WINDOW', 'MEDIUM', 'زمان تراکنش از زمان دریافت حدس زده شده است.', 15));
  }

  // --- parse quality --------------------------------------------------------
  if (input.unsupportedFormat) {
    signals.push(
      signal('UNSUPPORTED_BANK_FORMAT', 'MEDIUM', 'قالب این پیامک با هیچ بانک شناخته‌شده‌ای مطابقت ندارد.', 22),
    );
  }
  if (input.parsed.confidence < 45) {
    signals.push(
      signal('LOW_PARSER_CONFIDENCE', 'MEDIUM', `اطمینان تجزیه پیامک پایین است (${input.parsed.confidence}٪).`, 25),
    );
  }
  if (input.parsed.warnings.includes('SMS_AMOUNT_UNIT_INFERRED')) {
    signals.push(
      signal('RIAL_TOMAN_AMBIGUOUS', 'MEDIUM', 'واحد مبلغ در پیامک ذکر نشده و بر اساس پیش‌فرض بانک فرض گرفته شده است.', 30),
    );
  }
  if (input.parsed.warnings.includes('SMS_RIAL_NOT_DIVISIBLE_BY_10')) {
    signals.push(
      signal('RIAL_TOMAN_AMBIGUOUS', 'HIGH', 'مبلغ ریالی بر ۱۰ بخش‌پذیر نیست؛ احتمال خطای خواندن وجود دارد.', 35),
    );
  }

  // --- source integrity -----------------------------------------------------
  if (input.unknownSender) {
    signals.push(signal('UNKNOWN_SENDER', 'MEDIUM', 'این شماره فرستنده برای حساب شما تازه است.', 20));
  }
  if (input.unknownDevice) {
    signals.push(signal('UNKNOWN_DEVICE', 'MEDIUM', 'این دستگاه فرستنده برای حساب شما تازه است.', 20));
  }

  // --- payment shape --------------------------------------------------------
  if (input.parsed.direction === 'OUT') {
    signals.push(signal('DIRECTION_OUT', 'HIGH', 'این پیامک برداشت از حساب است.', 50));
  }
  if (input.cardMismatch) {
    signals.push(
      signal('CARD_MISMATCH', 'MEDIUM', 'کارت مقصد در پیامک با کارت فاکتور یکسان نیست.', 28),
    );
  }

  // --- volume ---------------------------------------------------------------
  if (input.similarAmountCount >= 5) {
    signals.push(
      signal(
        'SIMILAR_AMOUNTS_MANY',
        'MEDIUM',
        `${input.similarAmountCount} فاکتور با مبالغ نزدیک به هم در بازه فعال هستند.`,
        22,
      ),
    );
  }
  if (input.recentSmsCount > 40) {
    signals.push(
      signal('SMS_VOLUME_SPIKE', 'MEDIUM', `حجم پیامک در ۱۰ دقیقه گذشته غیرعادی است (${input.recentSmsCount}).`, 24),
    );
  }

  const score = Math.min(100, signals.reduce((total, entry) => total + entry.weight, 0));
  const level: RiskLevel =
    score >= RISK_HIGH_THRESHOLD ? 'HIGH' : score >= RISK_REVIEW_THRESHOLD ? 'MEDIUM' : 'LOW';

  return {
    score,
    level,
    signals,
    // MEDIUM escalates too. The whole point of a review queue is to catch the
    // uncertain cases, and a MEDIUM payment that settles automatically is a rule
    // that exists only on paper.
    requiresReview: score >= RISK_REVIEW_THRESHOLD,
  };
}

/**
 * Detects an unusual run of arrivals, used by the security feed (§67) rather than
 * by a single payment's risk score.
 */
export function detectVolumeAnomaly(
  timeline: readonly { at: string; count: number }[],
  baselinePerBucket: number,
  multiplier = 5,
): { anomalous: boolean; peak: number; threshold: number } {
  const threshold = Math.max(1, Math.floor(baselinePerBucket * multiplier));
  const peak = timeline.reduce((max, bucket) => Math.max(max, bucket.count), 0);
  return { anomalous: peak > threshold, peak, threshold };
}
