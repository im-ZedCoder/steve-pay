/**
 * Unique payment amounts (§11).
 *
 * The problem: two customers must never be asked to transfer the same Toman
 * figure while both invoices are live, because the incoming bank SMS only carries
 * an amount and a card — the amount *is* the identifier.
 *
 * The guarantee is enforced by the database (ux_invoices_active_amount, a partial
 * unique index over every live invoice status). This module's job is to propose
 * candidates that (a) never fall below the required base amount, and (b) spend
 * the suffix space efficiently so that retries after a collision actually explore
 * new values instead of repeatedly re-rolling the same handful.
 *
 * Naive approach: pick a uniform random suffix, try to insert, on collision pick
 * another random suffix. Under contention this degrades badly — with n values
 * already taken out of a range of size r, each retry succeeds with probability
 * (r-n)/r, and a burst of concurrent invoices can burn through the retry budget
 * while re-testing values that are already known to be taken.
 *
 * Approach used here: walk the suffix space with a fixed stride that is coprime
 * to the span. A stride coprime to the span visits *every* value exactly once
 * before repeating, so a sequence of k candidates is guaranteed to be k distinct
 * values, and the full range is covered without replacement. The starting point is
 * randomised so concurrent callers do not all probe the same neighbourhood, and
 * the stride is chosen per call so two simultaneous invoices do not march through
 * the space in lockstep.
 *
 * The span is always 9 * 10^(digits-1) — 900 for three digits, 9000 for four — so
 * its only prime factors are 2, 3 and 5, which makes finding a coprime stride
 * cheap.
 */

import { AppError } from './errors';
import type { Toman } from './money';
import { assertToman } from './money';

export type SuffixDigits = 3 | 4;

export interface SuffixBounds {
  min: number;
  max: number;
  /** Number of distinct suffixes available: max - min + 1. */
  span: number;
}

export const SUFFIX_DIGITS_SUPPORTED: readonly SuffixDigits[] = [3, 4];
export const DEFAULT_SUFFIX_DIGITS: SuffixDigits = 4;

/**
 * Three digits give 900 possible suffixes, four give 9,000.
 *
 * The minimum suffix is the smallest number with that many digits rather than 0,
 * which keeps the suffix visually separable from the base amount: a customer
 * reading "363706" for a 362000 base sees a 4-digit tail, not a trailing "6".
 */
export function suffixBounds(digits: SuffixDigits): SuffixBounds {
  const min = digits === 3 ? 100 : 1000;
  const max = digits === 3 ? 999 : 9999;
  return { min, max, span: max - min + 1 };
}

export function isSupportedSuffixDigits(value: unknown): value is SuffixDigits {
  return value === 3 || value === 4;
}

/** Coerces configuration that may arrive as a string or a stray float. */
export function parseSuffixDigits(value: unknown, fallback: SuffixDigits = DEFAULT_SUFFIX_DIGITS): SuffixDigits {
  const numeric = typeof value === 'string' ? Number(value) : value;
  return isSupportedSuffixDigits(numeric) ? numeric : fallback;
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/**
 * A stride in [1, span-1] that is coprime to the span, found by searching outward
 * from a random starting point. Because the span's prime factors are only 2, 3 and
 * 5, a coprime value is always within a few steps (at most three consecutive
 * values can all share a factor with a 3-smooth number), so this loop is short and
 * always terminates.
 */
export function coprimeStride(span: number, random: () => number): number {
  if (span <= 2) return 1;
  const start = 1 + Math.floor(random() * (span - 1));
  for (let candidate = start; candidate < span; candidate += 1) {
    if (greatestCommonDivisor(candidate, span) === 1) return candidate;
  }
  for (let candidate = start - 1; candidate >= 1; candidate -= 1) {
    if (greatestCommonDivisor(candidate, span) === 1) return candidate;
  }
  return 1;
}

export interface UniqueAmountPlan {
  /** Candidate payable amounts in Toman, all strictly greater than baseAmount, all distinct. */
  candidates: Toman[];
  /** The suffix added to baseAmount to produce candidates[i]. */
  suffixes: number[];
  bounds: SuffixBounds;
  digits: SuffixDigits;
  /** True when the requested attempt count exceeded the available suffix space. */
  cappedBySpan: boolean;
}

export interface PlanOptions {
  baseAmount: Toman;
  suffixDigits?: SuffixDigits;
  /** How many distinct candidates to propose. The service retries the whole plan if all are taken. */
  attempts: number;
  /** Injectable for deterministic tests. Must return a value in [0, 1). */
  random?: () => number;
}

/**
 * Builds a collision-free candidate list. Pure: no database access, no clock, no
 * global RNG. Every candidate satisfies `candidate >= baseAmount + suffixMin`, so
 * the "never lower than the required base amount" rule holds by construction
 * rather than by a check that could be forgotten.
 */
export function planUniqueAmounts(options: PlanOptions): UniqueAmountPlan {
  const digits = options.suffixDigits ?? DEFAULT_SUFFIX_DIGITS;
  if (!isSupportedSuffixDigits(digits)) {
    throw new AppError('SETTING_INVALID', {
      message: 'طول بخش یکتا باید ۳ یا ۴ رقم باشد.',
      details: { suffixDigits: digits },
    });
  }
  assertToman(options.baseAmount, { field: 'baseAmount' });

  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new AppError('SETTING_INVALID', {
      message: 'تعداد تلاش برای تولید مبلغ یکتا باید عددی مثبت باشد.',
      details: { attempts: options.attempts },
    });
  }

  const bounds = suffixBounds(digits);
  const random = options.random ?? defaultRandom;
  const wanted = Math.min(options.attempts, bounds.span);
  const cappedBySpan = options.attempts > bounds.span;

  const startOffset = Math.floor(random() * bounds.span);
  const stride = coprimeStride(bounds.span, random);

  const suffixes: number[] = [];
  const candidates: Toman[] = [];
  for (let index = 0; index < wanted; index += 1) {
    const offset = (startOffset + index * stride) % bounds.span;
    const suffix = bounds.min + offset;
    suffixes.push(suffix);
    candidates.push(options.baseAmount + suffix);
  }

  return { candidates, suffixes, bounds, digits, cappedBySpan };
}

/** Recovers the suffix from a persisted pair. Used by receipts and reporting. */
export function suffixFromPayable(payableAmount: Toman, baseAmount: Toman): number {
  const suffix = payableAmount - baseAmount;
  if (suffix <= 0) {
    throw new AppError('INVALID_AMOUNT', {
      message: 'مبلغ نهایی باید از مبلغ پایه بزرگ‌تر باشد.',
      details: { payableAmount, baseAmount },
    });
  }
  return suffix;
}

export function payableFromSuffix(baseAmount: Toman, suffix: number): Toman {
  assertToman(baseAmount, { field: 'baseAmount' });
  if (!Number.isInteger(suffix) || suffix <= 0) {
    throw new AppError('INVALID_AMOUNT', { details: { suffix } });
  }
  return baseAmount + suffix;
}

/**
 * How much of the suffix space is still free, and whether it is time to tell the
 * operator. Surfaced on the admin health page: a four-digit space that is 95%
 * consumed is a capacity incident waiting to happen, and it is better seen on a
 * dashboard than discovered as a sudden run of AMOUNT_SPACE_EXHAUSTED errors.
 */
export function suffixSpaceUtilisation(digits: SuffixDigits, liveInvoices: number): {
  digits: SuffixDigits;
  capacity: number;
  used: number;
  utilisation: number;
  status: 'HEALTHY' | 'TIGHT' | 'CRITICAL';
} {
  const bounds = suffixBounds(digits);
  const used = Math.max(0, liveInvoices);
  const utilisation = Math.min(1, used / bounds.span);
  const status = utilisation >= 0.9 ? 'CRITICAL' : utilisation >= 0.7 ? 'TIGHT' : 'HEALTHY';
  return { digits, capacity: bounds.span, used, utilisation, status };
}

/**
 * Cryptographically uniform random in [0, 1).
 *
 * Math.random() would be fine for spreading load, but the suffix is part of what
 * distinguishes two customers' payments, and a predictable sequence is a small
 * free win for anyone trying to guess a live amount. This costs nothing and
 * removes the question.
 */
function defaultRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  const value = buffer[0] ?? 0;
  // 2^32 == 4294967296. Dividing by 2^32 maps to [0, 1) exactly.
  return value / 4294967296;
}
