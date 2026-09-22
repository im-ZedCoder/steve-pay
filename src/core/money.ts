/**
 * Money.
 *
 * Every amount in Steve Pay is an integer number of Toman. There is no float
 * anywhere in the money path: Toman has no sub-unit in practice, and a float that
 * can represent 0.1 inexactly has no business near a payment total.
 *
 * Rial is a derived display value (rial = toman * 10). It is branded with a
 * phantom type so that a Rial figure can never be passed where a Toman figure is
 * expected — mixing the two by a factor of ten is the single most likely
 * catastrophic bug in an Iranian payment product, and the type system is a cheap
 * place to stop it.
 *
 *   const t: Toman = 359_000;
 *   const r: Rial  = toRial(t);   // 3_590_000
 *   toRial(r);                    // compile error: Rial is not a Toman
 */

import { AppError } from './errors';
import { groupThousands, toPersianDigits } from './digits';

/** Toman. Integer, never negative in storage, always safe-integer range. */
export type Toman = number;

/** Rial = Toman x 10. Branded so the two units cannot be confused. */
export type Rial = number & { readonly __unit: 'Rial' };

export const RIAL_PER_TOMAN = 10;
export const CURRENCY_TOMAN = 'IRT' as const;
export const CURRENCY_RIAL = 'IRR' as const;

/**
 * Largest representable Toman figure. Number.MAX_SAFE_INTEGER / 10 is the real
 * ceiling because toRial multiplies by ten; bounding here means the Rial
 * conversion can never silently lose precision.
 */
export const MAX_SAFE_TOMAN = Math.floor(Number.MAX_SAFE_INTEGER / RIAL_PER_TOMAN);

/** Is this a usable Toman amount? Integer, finite, non-negative, inside safe range. */
export function isSafeToman(value: unknown): value is Toman {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SAFE_TOMAN
  );
}

/**
 * Guard for anything crossing into the money layer. Throws a merchant-visible
 * INVALID_AMOUNT rather than coercing: a coercion here would turn "359000.75"
 * into a different number than the merchant quoted.
 */
export function assertToman(
  value: unknown,
  options: { field?: string; allowZero?: boolean } = {},
): asserts value is Toman {
  const field = options.field ?? 'amount';
  if (!isSafeToman(value)) {
    throw new AppError('INVALID_AMOUNT', {
      message:
        typeof value === 'number' && !Number.isInteger(value)
          ? 'مبلغ باید عددی صحیح به تومان باشد؛ اعشار پشتیبانی نمی‌شود.'
          : `مقدار «${field}» نامعتبر است.`,
      details: { field, received: typeof value === 'number' ? value : typeof value },
    });
  }
  if (!options.allowZero && value === 0) {
    throw new AppError('INVALID_AMOUNT', {
      message: 'مبلغ باید بزرگ‌تر از صفر باشد.',
      details: { field },
    });
  }
}

/** Toman -> Rial. Overflow-proof because assertToman bounds the input. */
export function toRial(toman: Toman): Rial {
  assertToman(toman, { field: 'toman', allowZero: true });
  return (toman * RIAL_PER_TOMAN) as Rial;
}

/** Rial -> Toman. Only exact multiples of ten convert; a remainder means the
 *  caller mixed units somewhere upstream, which is worth failing loudly on. */
export function toTomanFromRial(rial: Rial | number): Toman {
  if (typeof rial !== 'number' || !Number.isFinite(rial) || !Number.isInteger(rial) || rial < 0) {
    throw new AppError('INVALID_AMOUNT', { message: 'مبلغ ریالی نامعتبر است.' });
  }
  if (rial % RIAL_PER_TOMAN !== 0) {
    throw new AppError('INVALID_AMOUNT', {
      message: 'مبلغ ریالی باید مضربی از ۱۰ باشد تا به تومان تبدیل شود.',
      details: { rial },
    });
  }
  return rial / RIAL_PER_TOMAN;
}

/** Integer addition that refuses to overflow into an imprecise value. */
export function addToman(...amounts: Toman[]): Toman {
  let total = 0;
  for (const amount of amounts) {
    assertToman(amount, { field: 'amount', allowZero: true });
    total += amount;
    if (total > MAX_SAFE_TOMAN) {
      throw new AppError('AMOUNT_ABOVE_MAXIMUM', { details: { total } });
    }
  }
  return total;
}

export function subtractToman(a: Toman, b: Toman): Toman {
  assertToman(a, { field: 'a', allowZero: true });
  assertToman(b, { field: 'b', allowZero: true });
  if (b > a) {
    throw new AppError('INVALID_AMOUNT', {
      message: 'نتیجه محاسبه مالی منفی می‌شود.',
      details: { a, b },
    });
  }
  return a - b;
}

/**
 * Parses a merchant-supplied amount. Accepts what a human or a loose client
 * actually sends — Persian digits, thousands separators, a trailing currency word
 * — and rejects anything that is not an exact integer.
 *
 * This is the only place a string becomes money, so the strictness lives here.
 */
export function parseTomanInput(input: string | number): Toman {
  if (typeof input === 'number') {
    assertToman(input, { field: 'amount' });
    return input;
  }

  let text = toPersianDigitsToAscii(input).trim();

  // Drop a currency word if the client sent one: "359000 تومان" / "359000 IRR".
  text = text.replace(/(تومان|ريال|ریال|toman|tmn|irr|irt|rial)/gi, '').trim();

  if (text.length === 0) {
    throw new AppError('INVALID_AMOUNT', { message: 'مبلغ خالی است.' });
  }

  // Thousands separators are tolerated: ASCII comma, Arabic thousands separator
  // (U+066C), and plain spaces. They are removed before the strict digit test.
  const withoutSeparators = text.replace(/[,\u066C\s]/g, '');

  // Reject decimals explicitly. Silently truncating "359000.99" would mean the
  // merchant is told one number and the customer another. Note that U+066B is the
  // Arabic DECIMAL separator: it is rejected here, while U+066C above (the
  // Arabic THOUSANDS separator) is accepted. Two code points one apart, opposite
  // meanings, and a factor-of-1000 difference if they are ever confused.
  if (/[.\u066B\u060C]/.test(withoutSeparators)) {
    throw new AppError('INVALID_AMOUNT', {
      message: 'مبلغ باید عددی صحیح به تومان باشد؛ اعشار پشتیبانی نمی‌شود.',
      details: { received: input },
    });
  }

  if (!/^\d+$/.test(withoutSeparators)) {
    throw new AppError('INVALID_AMOUNT', {
      message: 'مبلغ باید فقط شامل رقم باشد.',
      details: { received: input },
    });
  }

  const value = Number(withoutSeparators);
  assertToman(value, { field: 'amount' });
  return value;
}

/** Local alias so parseTomanInput reads cleanly without importing the whole digits module twice. */
function toPersianDigitsToAscii(input: string): string {
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  let out = '';
  for (const char of input) {
    const p = persian.indexOf(char);
    if (p >= 0) {
      out += String(p);
      continue;
    }
    const a = arabic.indexOf(char);
    if (a >= 0) {
      out += String(a);
      continue;
    }
    out += char;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting. Persian digits are the default for the UI; ASCII for API payloads
// and CSV exports.
// ---------------------------------------------------------------------------

/** "363706" -> "۳۶۳٬۷۰۶" (Persian digits with an Arabic thousands separator). */
export function formatTomanFa(toman: Toman): string {
  return toPersianDigits(groupThousands(toman)).replace(/,/g, '\u066C');
}

export function formatRialFa(rial: Rial | number): string {
  return toPersianDigits(groupThousands(rial)).replace(/,/g, '\u066C');
}

/** "363706" -> "363,706" — for JSON, CSV and monospace contexts. */
export function formatTomanEn(toman: Toman): string {
  return groupThousands(toman);
}

/** Verbose form for payment pages and notifications: "۳۶۳٬۷۰۶ تومان". */
export function formatTomanWithUnitFa(toman: Toman): string {
  return `${formatTomanFa(toman)} تومان`;
}

export function formatRialWithUnitFa(rial: Rial | number): string {
  return `${formatRialFa(rial)} ریال`;
}

/**
 * How many invoices a wallet balance still covers, for the low-balance warning.
 * Computed from the live fee so the message never claims three when the fee has
 * changed to something that only covers one.
 */
export function estimatedInvoiceCapacity(balance: Toman, feePerInvoice: Toman): number {
  if (!isSafeToman(feePerInvoice) || feePerInvoice <= 0) return 0;
  return Math.floor(balance / feePerInvoice);
}
