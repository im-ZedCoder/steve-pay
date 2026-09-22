/**
 * Field extraction primitives.
 *
 * These operate on *normalised* text (ASCII digits, folded letters) so they only
 * have to reason about structure, never about orthography.
 *
 * Each extractor returns null rather than a guess. A wrong amount is worse than a
 * missing one: a missing amount routes the message to manual review, while a wrong
 * amount silently transfers someone's money to the wrong invoice.
 */

import { digitsOnly } from '../digits';
import { parseSmsDateTime } from '../jalali';
import type { Currency, Direction } from './types';

// ---------------------------------------------------------------------------
// Amount
// ---------------------------------------------------------------------------

export interface AmountMatch {
  /** Integer amount in the unit the message used. */
  value: number;
  /** IRT = Toman, IRR = Rial. UNKNOWN when no unit word was present. */
  unit: Currency;
  /** The exact fragment that matched, for the audit trail. */
  raw: string;
}

const TOMAN_UNITS = ['تومان', 'تومن', 'توماني', 'toman', 'tmn'];
const RIAL_UNITS = ['ریال', 'ريال', 'ريال', 'rial', 'irr'];

function unitOf(word: string): Currency | null {
  const lower = word.toLowerCase();
  if (TOMAN_UNITS.some((unit) => lower.includes(unit))) return 'IRT';
  if (RIAL_UNITS.some((unit) => lower.includes(unit))) return 'IRR';
  return null;
}

/**
 * Finds monetary amounts in either word order:
 *   "363,706 تومان"   "مبلغ 363,706 تومان"   "مبلغ:363706ریال"
 *   "تومان 363,706"   "IRR 3,637,060"
 *
 * Results are returned in document order, deduplicated by position. The caller
 * decides which one is *the* amount; banks often also include a balance, so
 * choosing the first unit-qualified figure is not always right and the
 * higher-level parser makes that call using context words.
 */
export function extractAmounts(text: string): AmountMatch[] {
  const results: AmountMatch[] = [];
  const seen = new Set<string>();

  // Number followed (within a few characters) by a unit word.
  const afterUnit = /(\d[\d,]{2,})\s{0,3}(تومان|تومن|ریال|ريال|toman|rial|IRR|IRT|tmn)/gi;
  for (const match of text.matchAll(afterUnit)) {
    const rawNumber = match[1] ?? '';
    const rawUnit = match[2] ?? '';
    const digits = digitsOnly(rawNumber);
    if (digits === null) continue;
    const key = `${match.index}:${digits}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ value: Number(digits), unit: unitOf(rawUnit) ?? 'UNKNOWN', raw: `${rawNumber} ${rawUnit}` });
  }

  // Unit word followed by the number.
  const beforeUnit = /(تومان|تومن|ریال|ريال|toman|rial|IRR|IRT|tmn)\s{0,3}[:\s]{0,2}(\d[\d,]{2,})/gi;
  for (const match of text.matchAll(beforeUnit)) {
    const rawUnit = match[1] ?? '';
    const rawNumber = match[2] ?? '';
    const digits = digitsOnly(rawNumber);
    if (digits === null) continue;
    const key = `${match.index}:${digits}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ value: Number(digits), unit: unitOf(rawUnit) ?? 'UNKNOWN', raw: `${rawUnit} ${rawNumber}` });
  }

  return results;
}

/**
 * Amounts that carry no unit at all, found by looking immediately after a
 * money-word. Used as a last resort by the generic parser so a bank that omits
 * "تومان" still produces a parseable message.
 */
export function extractUnitlessAmount(text: string): AmountMatch | null {
  const pattern =
    /(?:مبلغ|واریز|واریزی|انتقال|افزایش|بستانکار|deposit|credit|amount)\s{0,3}[:\s]{0,3}(\d[\d,]{3,})/i;
  const match = pattern.exec(text);
  if (!match) return null;
  const raw = match[1] ?? '';
  const digits = digitsOnly(raw);
  if (digits === null) return null;
  return { value: Number(digits), unit: 'UNKNOWN', raw };
}

// ---------------------------------------------------------------------------
// Reference numbers
// ---------------------------------------------------------------------------

const REFERENCE_LABELS = [
  'شماره پيگيري',
  'شماره پیگیری',
  'پيگيري',
  'پیگیری',
  'کد رهگیری',
  'شماره مرجع',
  'مرجع',
  'شماره سند',
  'شماره رسيد',
  'شماره رسید',
  'رسید',
  'شماره تراکنش',
  'کد پیگیری',
  'tracking',
  'reference',
  'ref',
];

/**
 * Reference / tracking number. This is the strongest duplicate signal in the
 * whole pipeline, which is why it is worth several patterns: a bank that switches
 * from "شماره پیگیری" to "کد رهگیری" should not silently degrade deduplication.
 */
export function extractReference(text: string, override?: RegExp): string | null {
  if (override) {
    const match = override.exec(text);
    const captured = match?.[1];
    if (captured) {
      const digits = digitsOnly(captured);
      if (digits && digits.length >= 4) return digits;
    }
  }

  for (const label of REFERENCE_LABELS) {
    const pattern = new RegExp(`${label}[^0-9]{0,14}(\\d{4,})`, 'i');
    const match = pattern.exec(text);
    const captured = match?.[1];
    if (captured) return captured;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * Card numbers, including the masked forms banks actually send:
 *   6104337812345678
 *   6104****3456
 *   6104-****-****-3456
 *   6104*1234
 *   6104xxxx1234
 *
 * Masks are collapsed to a canonical `first4` + '*' run + `last4` so downstream
 * comparison only has to look at the ends, which is all a bank ever reveals.
 */
export function extractCards(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  // Fully masked: four leading digits, a mask run, four trailing digits.
  const masked = /(\d{4})\s?[-*xX•]{2,}\s?(?:[-*xX•]{2,}\s?)?(\d{4})/g;
  for (const match of text.matchAll(masked)) {
    const first = match[1] ?? '';
    const last = match[2] ?? '';
    const canonical = `${first}****${last}`;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      found.push(canonical);
    }
  }

  // Unmasked 16-digit sequences, in either digit grouping.
  const plain = /\b(\d{16})\b|\b(\d{4})[- ](\d{4})[- ](\d{4})[- ](\d{4})\b/g;
  for (const match of text.matchAll(plain)) {
    const digits = match[1] ?? `${match[2] ?? ''}${match[3] ?? ''}${match[4] ?? ''}${match[5] ?? ''}`;
    if (!/^\d{16}$/.test(digits)) continue;
    // Reject long digit strings that are obviously something else (a national ID
    // plus a phone number jammed together by normalisation).
    if (!seen.has(digits)) {
      seen.add(digits);
      found.push(digits);
    }
  }

  return found;
}

/** Account numbers in شبا (IBAN) form: IR + 24 digits. */
export function extractSheba(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\bIR\s?(\d{2})\s?(\d{4})\s?(\d{4})\s?(\d{4})\s?(\d{4})\s?(\d{4})\b/g)) {
    found.push(`IR${match.slice(1).join('')}`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/**
 * Post-transaction balance (مانده). Deliberately kept apart from the amount: it
 * looks identical, and mistaking a 1,234,567 balance for a 1,234,567 payment is
 * exactly the failure mode a manual-review queue exists to catch.
 */
export function extractBalanceToman(text: string, override?: RegExp): number | null {
  const pattern = override ?? /(?:مانده|موجودی|balance)[^0-9]{0,12}(\d[\d,]{2,})\s{0,3}(تومان|تومن|ریال|ريال)?/i;
  const match = pattern.exec(text);
  if (!match) return null;
  const raw = match[1];
  if (!raw) return null;
  const digits = digitsOnly(raw);
  if (digits === null) return null;
  const value = Number(digits);
  const unitRaw = match[2];
  // A balance stated in Rial is converted; one with no unit is assumed to match
  // the message's own currency, which the parser decides separately.
  if (unitRaw && /ریال|ريال|rial|irr/i.test(unitRaw)) return Math.floor(value / 10);
  return value;
}

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

const DEFAULT_DIRECTION_IN = [
  'واریز',
  'واريز',
  'افزایش',
  'افزايش',
  'بستانکار',
  'بستانكاري',
  'deposit',
  'credit',
  'دریافت',
  'مبلغ به حساب',
  'به حساب شما',
];

const DEFAULT_DIRECTION_OUT = [
  'برداشت',
  'کسر',
  'بدهکار',
  'پرداخت شد',
  'انتقال از',
  'withdrawal',
  'debit',
  'خرید',
];

/**
 * In or out. Defaults to IN because the pipeline is fed by merchants forwarding
 * their *receiving* SMS — an unknown direction should not by itself reject a
 * message, but an explicit OUT must.
 */
export function extractDirection(
  text: string,
  keywords: { in?: readonly string[]; out?: readonly string[] } = {},
): Direction {
  const outWords = [...(keywords.out ?? []), ...DEFAULT_DIRECTION_OUT];
  for (const word of outWords) {
    if (text.includes(word)) return 'OUT';
  }
  const inWords = [...(keywords.in ?? []), ...DEFAULT_DIRECTION_IN];
  for (const word of inWords) {
    if (text.includes(word)) return 'IN';
  }
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

export interface DateExtraction {
  iso: string;
  /** True when the message carried no stamp and the server receipt time was used. */
  fromReceiptTime: boolean;
  warnings: string[];
}

/**
 * Timestamp of the transaction itself. When absent we fall back to the receipt
 * time, flagged so the matcher knows the value was inferred rather than stated —
 * the time window rules treat the two differently.
 */
export function extractOccurredAt(text: string, receivedAt: string): DateExtraction {
  const dateMatch = /(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[ ,\-T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (dateMatch) {
    const parsed = parseSmsDateTime(dateMatch[0]);
    if (parsed) {
      const warnings: string[] = [];
      // A stamp in the future by more than a couple of minutes means either a
      // device clock problem or a fabricated message.
      const skewMs = parsed.getTime() - new Date(receivedAt).getTime();
      if (skewMs > 2 * 60_000) warnings.push('SMS_TIMESTAMP_IN_FUTURE');
      return { iso: parsed.toISOString(), fromReceiptTime: false, warnings };
    }
  }

  // Time-only stamps: "ساعت 14:23" — pair with today's date in Iran local time.
  const timeOnly = /(?:ساعت|at)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (timeOnly) {
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    if (hour <= 23 && minute <= 59) {
      const base = new Date(receivedAt);
      const iso = parseSmsDateTime(
        `${new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(base)} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      );
      if (iso) {
        return {
          iso: iso.toISOString(),
          fromReceiptTime: true,
          warnings: ['SMS_TIME_INFERRED_FROM_RECEIPT'],
        };
      }
    }
  }

  return { iso: receivedAt, fromReceiptTime: true, warnings: ['SMS_DATE_MISSING'] };
}
