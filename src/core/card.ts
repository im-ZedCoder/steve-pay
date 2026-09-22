/**
 * Iranian bank card numbers.
 *
 * Validation is deliberately layered, because an Iranian card number has three
 * independent properties and they are not equally reliable:
 *
 *   1. Shape      — 16 digits starting with 6 (Shetab range). Always enforced.
 *   2. Checksum   — the Luhn algorithm. Enforced by default; a handful of Iranian
 *                   issuers have historically issued numbers that fail Luhn, so
 *                   `cards.enforce_luhn` can relax it without disabling shape
 *                   validation.
 *   3. Issuer     — the BIN prefix. Advisory only: it prefills the bank name in
 *                   the dashboard, and an unknown prefix is never a reason to
 *                   reject a card. Bank prefix tables drift, and blocking a real
 *                   merchant because a table is stale would be worse than a
 *                   missing label.
 *
 * Nothing here hashes or persists: the persistence decisions (hashing for
 * duplicate detection, masking for logs) live with the card service.
 */

import { stripNonDigits, groupCardDigits } from './digits';

export interface CardIssuer {
  /** Bank name as it should appear in the UI. */
  bank: string;
  /** Short slug for icons and analytics grouping. */
  slug: string;
}

/**
 * Reference BIN data. Advisory: see the note above. Kept as a single ordered list
 * so it can be replaced wholesale from a data file without touching logic.
 */
const ISSUER_PREFIXES: ReadonlyArray<readonly [string, CardIssuer]> = [
  ['603799', { bank: 'بانک ملی ایران', slug: 'melli' }],
  ['603770', { bank: 'بانک ملی ایران', slug: 'melli' }],
  ['610433', { bank: 'بانک ملت', slug: 'mellat' }],
  ['991975', { bank: 'بانک ملت', slug: 'mellat' }],
  ['627412', { bank: 'بانک اقتصاد نوین', slug: 'eghtesad-novin' }],
  ['627381', { bank: 'بانک انصار', slug: 'ansar' }],
  ['505785', { bank: 'بانک آینده', slug: 'ayandeh' }],
  ['636214', { bank: 'بانک آینده', slug: 'ayandeh' }],
  ['627648', { bank: 'بانک توسعه صادرات ایران', slug: 'edbi' }],
  ['627961', { bank: 'بانک توسعه صادرات ایران', slug: 'edbi' }],
  ['639607', { bank: 'بانک سرمایه', slug: 'sarmayeh' }],
  ['639346', { bank: 'بانک سینا', slug: 'sina' }],
  ['502806', { bank: 'بانک شهر', slug: 'shahr' }],
  ['504706', { bank: 'بانک شهر', slug: 'shahr' }],
  ['603769', { bank: 'بانک صادرات ایران', slug: 'saderat' }],
  ['627760', { bank: 'بانک تجارت', slug: 'tejarat' }],
  ['585983', { bank: 'بانک پارسیان', slug: 'parsian' }],
  ['622106', { bank: 'بانک پارسیان', slug: 'parsian' }],
  ['621986', { bank: 'بانک سامان', slug: 'saman' }],
  ['639347', { bank: 'بانک پاسارگاد', slug: 'pasargad' }],
  ['502229', { bank: 'بانک پاسارگاد', slug: 'pasargad' }],
  ['627488', { bank: 'بانک کارآفرین', slug: 'karafarin' }],
  ['627353', { bank: 'بانک سپه', slug: 'sepah' }],
  ['589210', { bank: 'بانک سپه', slug: 'sepah' }],
  ['627648', { bank: 'بانک توسعه صادرات ایران', slug: 'edbi' }],
  ['639599', { bank: 'بانک کشاورزی', slug: 'keshavarzi' }],
  ['603770', { bank: 'بانک ملی ایران', slug: 'melli' }],
  ['628023', { bank: 'بانک مسکن', slug: 'maskan' }],
  ['627863', { bank: 'بانک شهر', slug: 'shahr' }],
  ['639370', { bank: 'بانک مهر اقتصاد', slug: 'mehr-eghtesad' }],
  ['606256', { bank: 'بانک مهر ایران', slug: 'mehr-iran' }],
  ['502938', { bank: 'بانک دی', slug: 'day' }],
  ['636949', { bank: 'بانک حکمت ایرانیان', slug: 'hekmat' }],
  ['636795', { bank: 'بانک مرکزی', slug: 'cbi' }],
  ['505416', { bank: 'بانک گردشگری', slug: 'gardeshgari' }],
  ['637160', { bank: 'بانک قوامین', slug: 'ghavamin' }],
  ['627493', { bank: 'بانک کشاورزی', slug: 'keshavarzi' }],
  ['639217', { bank: 'بانک کشاورزی', slug: 'keshavarzi' }],
  ['606373', { bank: 'بانک ایران زمین', slug: 'iranzamin' }],
];

/** Sorted longest-prefix-first so a 6-digit match always beats a 4-digit one. */
const ISSUER_INDEX: ReadonlyArray<readonly [string, CardIssuer]> = [...ISSUER_PREFIXES].sort(
  (a, b) => b[0].length - a[0].length,
);

export function identifyIssuer(cardNumber: string): CardIssuer | null {
  for (const [prefix, issuer] of ISSUER_INDEX) {
    if (cardNumber.startsWith(prefix)) return issuer;
  }
  return null;
}

/**
 * Luhn checksum. Doubles every second digit from the right, subtracting 9 above
 * 9, and requires the total to be a multiple of 10.
 */
export function luhnCheck(cardNumber: string): boolean {
  if (!/^\d+$/.test(cardNumber)) return false;
  let sum = 0;
  let double = false;
  for (let index = cardNumber.length - 1; index >= 0; index -= 1) {
    let digit = cardNumber.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Exposed for tests and for generating fixture card numbers. */
export function luhnCheckDigit(partial: string): number {
  let sum = 0;
  let double = true;
  for (let index = partial.length - 1; index >= 0; index -= 1) {
    let digit = partial.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

export type CardRejection =
  | 'EMPTY'
  | 'NOT_DIGITS'
  | 'WRONG_LENGTH'
  | 'NOT_SHETAB'
  | 'CHECKSUM_FAILED';

export interface CardValidation {
  ok: boolean;
  /** Normalised 16-digit form when `ok`; the cleaned digits otherwise. */
  number: string;
  reason?: CardRejection;
  issuer: CardIssuer | null;
}

export interface CardValidationOptions {
  /**
   * Enforce the Luhn checksum. Defaults to true, which is what the brief asks
   * for; relaxable per deployment via `cards.enforce_luhn`.
   */
  enforceLuhn?: boolean;
}

/**
 * Validates a card number typed by a merchant or supplied through the API.
 * Order matters: cheap structural checks run before the checksum so the error
 * the merchant sees names the actual problem.
 */
export function validateCardNumber(
  input: string,
  options: CardValidationOptions = {},
): CardValidation {
  const enforceLuhn = options.enforceLuhn !== false;
  const digits = stripNonDigits(input);

  if (digits.length === 0) return { ok: false, number: '', reason: 'EMPTY', issuer: null };
  if (digits !== input.replace(/[\s-]/g, '')) {
    // Letters or punctuation survived digit extraction: not a card number at all.
    return { ok: false, number: digits, reason: 'NOT_DIGITS', issuer: null };
  }
  if (digits.length !== 16) {
    return { ok: false, number: digits, reason: 'WRONG_LENGTH', issuer: null };
  }
  if (!digits.startsWith('6')) {
    return { ok: false, number: digits, reason: 'NOT_SHETAB', issuer: null };
  }
  if (enforceLuhn && !luhnCheck(digits)) {
    return { ok: false, number: digits, reason: 'CHECKSUM_FAILED', issuer: identifyIssuer(digits) };
  }
  return { ok: true, number: digits, issuer: identifyIssuer(digits) };
}

/** "6104337812345678" -> "6104-****-****-5678". Safe for logs, dashboards and webhooks. */
export function maskCardNumber(cardNumber: string): string {
  const digits = stripNonDigits(cardNumber);
  if (digits.length < 8) return '****';
  const first = digits.slice(0, 4);
  const last = digits.slice(-4);
  const hidden = '*'.repeat(Math.max(0, digits.length - 8));
  return groupCardDigits(`${first}${hidden}${last}`).replace(/ /g, '-');
}

/**
 * Same as maskCardNumber but with placeholder groups, so the payment page can
 * render a card in its natural four-group rhythm. Only the last group is real.
 */
export function maskCardGroups(cardNumber: string): string[] {
  const digits = stripNonDigits(cardNumber);
  if (digits.length !== 16) return ['****', '****', '****', digits.slice(-4) || '****'];
  return [digits.slice(0, 4), '••••', '••••', digits.slice(12)];
}

/** The last four digits, used in SMS matching and in support conversations. */
export function cardLast4(cardNumber: string): string {
  return stripNonDigits(cardNumber).slice(-4);
}

/**
 * Two card fields compare equal when the last four digits match and the length is
 * the same. Bank SMS messages commonly mask the middle groups, so a full-number
 * comparison would never match a real message.
 */
export function cardMatches(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const da = stripNonDigits(a);
  const db = stripNonDigits(b);
  if (da.length === 0 || db.length === 0) return false;
  return da.slice(-4) === db.slice(-4);
}
