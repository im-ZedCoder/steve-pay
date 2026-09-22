/**
 * Persian / Arabic digit and text normalisation.
 *
 * This is not cosmetic. Bank SMS messages arrive with a mix of ASCII digits,
 * Persian digits (۰-۹, U+06F0-U+06F9) and Arabic-Indic digits (٠-٩, U+0660-U+0669),
 * frequently inside the same string. Amounts also carry thousands separators of
 * three different flavours (ASCII comma, Arabic comma U+060C, and the Persian
 * decimal separator U+066B used as a thousands mark). Matching a payment depends
 * on collapsing all of that into plain ASCII before anything is parsed.
 */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/**
 * Thousands separators: ASCII comma, Arabic comma (U+060C), Arabic thousands
 * separator (U+066C), non-breaking space and the zero-width non-joiner. These are
 * safe to delete outright because they carry no numeric meaning.
 */
const THOUSANDS_CHARS = /[\s,\u060C\u066C\u00A0\u200C]/g;

/**
 * Decimal separators: ASCII full stop and the Arabic decimal separator (U+066B).
 * These are NOT removable — see digitsOnly.
 */
const DECIMAL_CHARS = /[.\u066B]/;

/**
 * Converts every digit form to ASCII. Persian is tried first because its code
 * points are disjoint from Arabic-Indic, so order only matters for clarity.
 */
export function toEnglishDigits(input: string): string {
  let out = '';
  for (const char of input) {
    const persianIndex = PERSIAN_DIGITS.indexOf(char);
    if (persianIndex >= 0) {
      out += String(persianIndex);
      continue;
    }
    const arabicIndex = ARABIC_DIGITS.indexOf(char);
    if (arabicIndex >= 0) {
      out += String(arabicIndex);
      continue;
    }
    out += char;
  }
  return out;
}

export function toPersianDigits(input: string | number): string {
  const text = String(input);
  let out = '';
  for (const char of text) {
    const index = '0123456789'.indexOf(char);
    out += index >= 0 ? PERSIAN_DIGITS[index] : char;
  }
  return out;
}

export function toArabicDigits(input: string | number): string {
  const text = String(input);
  let out = '';
  for (const char of text) {
    const index = '0123456789'.indexOf(char);
    out += index >= 0 ? ARABIC_DIGITS[index] : char;
  }
  return out;
}

/**
 * Folds the orthographic variations that matter for keyword matching:
 * Arabic yeh/kaf to Persian, alef variants to bare alef, and the Arabic
 * thousands separator to a comma. Applied to SMS bodies before keyword search so
 * a parser does not miss "واریز" because the bank sent "واريز".
 */
export function normalizePersianText(input: string): string {
  return input
    .replace(/\u064A/g, '\u06CC') // ARABIC YEH -> FARSI YEH
    .replace(/\u0649/g, '\u06CC') // ALEF MAKSURA -> FARSI YEH
    .replace(/\u0643/g, '\u06A9') // ARABIC KAF -> KEHEH
    .replace(/\u0629/g, '\u0647') // TEH MARBUTA -> HEH
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // ALEF variants -> ALEF
    .replace(/\u064B|\u064C|\u064D|\u064E|\u064F|\u0650|\u0651|\u0652|\u0640/g, '') // harakat + tatweel
    .replace(/[\u200B\u200E\u200F\u202A-\u202E]/g, ''); // zero-width and bidi controls
}

/**
 * Full normalisation used by the SMS pipeline: orthography first, then digits,
 * then the Arabic numeric punctuation.
 *
 * That last step matters more than it looks. A bank writing "۳۶۳٬۷۰۶" uses U+066C
 * (Arabic thousands separator), which is a different code point from U+066B
 * (Arabic decimal separator) sitting one position away in the Unicode table and
 * meaning something 1000x different. Collapsing both to their ASCII equivalents
 * here means every downstream regex can assume plain `,` and `.`, and the
 * integer/decimal decision is made once, in digitsOnly.
 */
export function normalizeSmsBody(input: string): string {
  return toEnglishDigits(normalizePersianText(input))
    .replace(/\u066C/g, ',') // Arabic thousands separator
    .replace(/\u060C/g, ',') // Arabic comma
    .replace(/\u066B/g, '.') // Arabic decimal separator
    .replace(/[\u200B\u200E\u200F\u202A-\u202E]/g, '');
}

/**
 * Collapses a numeric fragment into a bare integer string.
 *
 * Returns null when the fragment carries a decimal point, so "363,706.50" is
 * REJECTED rather than being read as 36370650. Silently deleting a decimal
 * separator is a factor-of-100 money bug wearing a normalisation costume, which is
 * why U+066B is mapped to '.' upstream instead of being swept up with the
 * thousands separators.
 */
export function digitsOnly(input: string): string | null {
  if (DECIMAL_CHARS.test(input)) return null;
  const cleaned = input.replace(THOUSANDS_CHARS, '');
  if (cleaned.length === 0) return null;
  return /^\d+$/.test(cleaned) ? cleaned : null;
}

/** Groups an integer string with commas: "363706" -> "363,706". */
export function groupThousands(input: string | number): string {
  const text = String(input).trim();
  const sign = text.startsWith('-') ? '-' : '';
  const body = sign ? text.slice(1) : text;
  const [whole = '', fraction] = body.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/** "6104337812345678" -> "6104 3378 1234 5678" (Iranian cards are read in fours). */
export function groupCardDigits(input: string): string {
  return input.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** True when the string contains at least one digit in any supported script. */
export function containsDigits(input: string): boolean {
  return /[0-9\u06F0-\u06F9\u0660-\u0669]/.test(input);
}

/** Strips every non-digit character; used for card numbers and mobile numbers. */
export function stripNonDigits(input: string): string {
  return toEnglishDigits(input).replace(/\D/g, '');
}

/** Best-effort conversion for `id`-style strings so slugs stay ASCII and addressable. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}
