/**
 * Unit tests for the pure domain core.
 *
 * These modules are where the brief's non-negotiables live (§42, §72): integer money, no
 * floating point, a unique amount that is never below the base, fee arithmetic that cannot
 * disagree with itself. Being pure, they need no database — which is exactly why they are
 * worth testing separately: a failure here is unambiguous, and it points at one function
 * rather than at a request that happened to be shaped a certain way.
 */

import { describe, expect, it } from 'vitest';

import {
  toRial,
  toTomanFromRial,
  parseTomanInput,
  formatTomanFa,
  formatRialFa,
  addToman,
  subtractToman,
  isSafeToman,
  tomanInWords,
} from '../src/core/money';
import { computeFees, requiredWalletReserve, isFeeMode } from '../src/core/fees';
import {
  planUniqueAmounts,
  suffixBounds,
  suffixFromPayable,
  payableFromSuffix,
  coprimeStride,
} from '../src/core/unique-amount';
import {
  toEnglishDigits,
  toPersianDigits,
  groupThousands,
  normalizeSmsBody,
  digitsOnly,
} from '../src/core/digits';
import {
  luhnCheck,
  luhnCheckDigit,
  validateCardNumber,
  maskCardNumber,
  cardLast4,
} from '../src/core/card';
import {
  canTransition,
  assertTransition,
  openability,
  isTerminal,
  holdsAmount,
  statusBucket,
} from '../src/core/state-machine';
import { gregorianToJalali, jalaliToGregorian, isJalaliLeapYear } from '../src/core/jalali';
import { bankNameFor, bankThemeFor, isKnownBank, UNKNOWN_BANK_THEME } from '../src/core/banks';

// ---------------------------------------------------------------------------

describe('money is integer Toman (§42)', () => {
  it('converts Toman to Rial by exactly ten', () => {
    expect(toRial(363706)).toBe(3637060);
    expect(toRial(0)).toBe(0);
    expect(toTomanFromRial(3637060 as never)).toBe(363706);
  });

  it('never loses precision on large amounts', () => {
    // The largest amount the platform accepts is 500,000,000 Toman. Multiplying by ten and
    // dividing back must be exact, which holds for integers well inside MAX_SAFE_INTEGER
    // and would not hold for a float representation of the same value.
    const amount = 500_000_000;
    expect(toTomanFromRial(toRial(amount) as never)).toBe(amount);
    expect(isSafeToman(amount)).toBe(true);
    expect(Number.isInteger(toRial(amount))).toBe(true);
  });

  it('parses Persian digits and every thousands separator a bank message might use', () => {
    // ASCII with a comma, Persian digits with the Arabic thousands separator U+066C, and
    // the same with U+066C replaced by an ordinary comma — all mean 363,706 Toman.
    expect(parseTomanInput('363,706')).toBe(363706);
    expect(parseTomanInput('۳۶۳٬۷۰۶')).toBe(363706);
    expect(parseTomanInput('۳۶۳,۷۰۶')).toBe(363706);
    expect(parseTomanInput('363706')).toBe(363706);
  });

  it('refuses a fractional amount rather than silently truncating it', () => {
    // 363,706.50 rounded to 363,706 would under-charge by half a Toman and, worse, produce
    // an amount that no longer matches what the customer saw. Rejecting is the only safe
    // answer for a value the platform did not generate.
    expect(() => parseTomanInput('363706.50')).toThrow();
    expect(() => parseTomanInput('363.5')).toThrow();
  });

  it('formats with the Arabic thousands separator and Persian digits', () => {
    expect(formatTomanFa(363706)).toBe('۳۶۳٬۷۰۶');
    expect(formatRialFa(3637060)).toBe('۳٬۶۳۷٬۰۶۰');
    expect(groupThousands(363706)).toBe('363,706');
  });

  it('adds and subtracts exactly', () => {
    expect(addToman(359000, 3000)).toBe(362000);
    expect(subtractToman(362000, 3000)).toBe(359000);
  });
});

describe('fee arithmetic (§10)', () => {
  it('adds the fee to the customer payable amount in CUSTOMER mode', () => {
    const breakdown = computeFees({ originalAmount: 359000, gatewayFee: 3000, feeMode: 'CUSTOMER' });

    expect(breakdown.customerFee).toBe(3000);
    expect(breakdown.merchantFee).toBe(0);
    expect(breakdown.gatewayFee).toBe(3000);
    // The base the suffix is added to, per the brief's worked example.
    expect(breakdown.baseAmount).toBe(362000);
  });

  it('takes the fee from the merchant in MERCHANT mode, leaving the base untouched', () => {
    const breakdown = computeFees({ originalAmount: 359000, gatewayFee: 3000, feeMode: 'MERCHANT' });

    expect(breakdown.customerFee).toBe(0);
    expect(breakdown.merchantFee).toBe(3000);
    // The customer pays the original amount (plus suffix), not the original plus fee.
    expect(breakdown.baseAmount).toBe(359000);
  });

  it('reserves wallet balance only when the merchant is paying', () => {
    expect(requiredWalletReserve('CUSTOMER', 3000)).toBe(0);
    expect(requiredWalletReserve('MERCHANT', 3000)).toBe(3000);
  });

  it('floors a percentage fee so it can never exceed what was agreed', () => {
    // 1% of 359,999 is 3599.99, which must become 3599 and not 3600.
    const breakdown = computeFees({
      originalAmount: 359_999,
      gatewayFee: 0,
      percentageBasisPoints: 100,
      feeMode: 'CUSTOMER',
    });
    expect(breakdown.gatewayFee).toBe(3599);
  });

  it('rejects an unknown fee mode instead of guessing one', () => {
    expect(isFeeMode('CUSTOMER')).toBe(true);
    expect(isFeeMode('FREE')).toBe(false);
    expect(() =>
      computeFees({ originalAmount: 1000, gatewayFee: 3000, feeMode: 'FREE' as never }),
    ).toThrow();
  });
});

describe('unique payment amounts (§11)', () => {
  it('never proposes an amount below the base', () => {
    const plan = planUniqueAmounts({ baseAmount: 362000, attempts: 50 });
    for (const candidate of plan.candidates) {
      expect(candidate).toBeGreaterThan(362000);
    }
  });

  it('proposes only distinct candidates', () => {
    const plan = planUniqueAmounts({ baseAmount: 362000, attempts: 200 });
    expect(new Set(plan.candidates).size).toBe(200);
    expect(new Set(plan.suffixes).size).toBe(200);
  });

  it('covers the whole suffix space without repeating, which is what makes retries useful', () => {
    // The stride is chosen coprime with the span, so a sequence of `span` candidates is a
    // permutation of the entire space. If the stride were ever not coprime, this run would
    // repeat a value long before exhausting the space and the allocator would spin.
    const bounds = suffixBounds(4);
    expect(bounds.span).toBe(9000);

    const plan = planUniqueAmounts({ baseAmount: 362000, attempts: bounds.span });
    expect(plan.cappedBySpan).toBe(false);
    expect(new Set(plan.suffixes).size).toBe(bounds.span);

    const sorted = [...plan.suffixes].sort((a, b) => a - b);
    expect(sorted[0]).toBe(bounds.min);
    expect(sorted[sorted.length - 1]).toBe(bounds.max);
  });

  it('always derives a stride coprime with the span', () => {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    for (let seed = 0; seed < 200; seed += 1) {
      const stride = coprimeStride(9000, () => seed / 200);
      expect(gcd(stride, 9000)).toBe(1);
    }
  });

  it('reports when the request exceeds the available space instead of silently truncating', () => {
    const plan = planUniqueAmounts({ baseAmount: 1000, attempts: 50_000, suffixDigits: 3 });
    expect(plan.cappedBySpan).toBe(true);
    expect(plan.candidates).toHaveLength(suffixBounds(3).span);
  });

  it('round-trips a suffix through the payable amount', () => {
    expect(payableFromSuffix(362000, 1706)).toBe(363706);
    expect(suffixFromPayable(363706, 362000)).toBe(1706);
  });
});

describe('digit normalisation (§17)', () => {
  it('converts Persian and Arabic-Indic digits to ASCII', () => {
    expect(toEnglishDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(toEnglishDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    // Digit mapping only: the Arabic thousands separator (U+066C) survives, because
    // rewriting punctuation is `normalizeSmsBody`'s job and the two concerns are kept
    // separate so a caller that only wants digits can get exactly that.
    expect(toEnglishDigits('مبلغ ۳۶۳٬۷۰۶ تومان')).toBe('مبلغ 363٬706 تومان');
  });

  it('converts back to Persian for display', () => {
    expect(toPersianDigits(363706)).toBe('۳۶۳۷۰۶');
  });

  it('normalises a bank message into one parseable form', () => {
    const normalised = normalizeSmsBody('واریز ۳۶۳٬۷۰۶ ریال');
    expect(normalised).toContain('363');
    // Separators must be gone, or an amount parse would read "363,706" as two numbers.
    expect(normalised).not.toContain('٬');
  });

  it('rejects a decimal point instead of stripping it, which would be a 100x error', () => {
    // Stripping the dot turns 363.706 into 363706 and 3.637 into 3637 — a silent ten- or
    // hundred-fold misreading of a payment amount. Returning null is the safe answer.
    expect(digitsOnly('363.706')).toBeNull();
    expect(digitsOnly('363706')).toBe('363706');
  });
});

describe('card validation (§9)', () => {
  it('computes and verifies the Luhn check digit', () => {
    const partial = '610433789012345';
    const checkDigit = luhnCheckDigit(partial);
    expect(luhnCheck(`${partial}${checkDigit}`)).toBe(true);
    // Any other final digit must fail.
    expect(luhnCheck(`${partial}${(checkDigit + 1) % 10}`)).toBe(false);
  });

  it('accepts a valid Iranian card and rejects a mistyped one', () => {
    const valid = '610433789012345' + String(luhnCheckDigit('610433789012345'));
    expect(validateCardNumber(valid, { enforceLuhn: true }).ok).toBe(true);

    const invalid = '610433789012345' + String((luhnCheckDigit('610433789012345') + 1) % 10);
    expect(validateCardNumber(invalid, { enforceLuhn: true }).ok).toBe(false);

    // Wrong length is rejected before any checksum work.
    expect(validateCardNumber('610433789012', { enforceLuhn: true }).ok).toBe(false);
  });

  it('masks all but the ends and never returns the full number', () => {
    const number = '6104337890123456';
    const masked = maskCardNumber(number);
    expect(masked).not.toBe(number);
    expect(masked).toContain('****');
    expect(cardLast4(number)).toBe('3456');
  });
});

/**
 * The issuer themes are cosmetic, but the lookup that selects them is a longest-match search
 * over a table of BINs, and a longest-match search that depends on the order of its input is
 * a bug that waits for the next person to add a bank to the end of the list.
 */
describe('bank issuer themes', () => {
  it('prefers the longer prefix when two overlap', () => {
    // 502910 is Karafarin and 502908 is Tose'e Ta'avon. A five-digit comparison would
    // resolve 5029xx against whichever of the two happened to be checked first.
    expect(bankNameFor('5029101234567890')).toBe('بانک کارآفرین');
    expect(bankNameFor("5029081234567890")).toBe('بانک توسعه تعاون');
  });

  it('resolves a card from its digits alone, whatever they are dressed in', () => {
    expect(bankNameFor('6104337890123456')).toBe('بانک ملت');
    expect(bankNameFor('6104 3378 9012 3456')).toBe('بانک ملت');
    expect(bankNameFor('6104-3378-9012-3456')).toBe('بانک ملت');
    // Persian digits, which is what a merchant pasting from a bank app produces.
    expect(bankNameFor('۶۱۰۴۳۳۷۸۹۰۱۲۳۴۵۶')).toBe('بانک ملت');
  });

  it('cannot identify an issuer from a masked number, and does not pretend to', () => {
    // Masking keeps the first four digits and the last four; the BIN is six. So this is a
    // real limit of the input, not a gap in the table — which is why the panel passes the
    // full number for the theme and the masked form only for what is printed.
    expect(bankNameFor('6104-****-****-0000')).toBe(UNKNOWN_BANK_THEME.name);
    // Not clipped digits, though: four digits of a real number must not match a BIN.
    expect(isKnownBank('61040000')).toBe(false);
  });

  it('never guesses an issuer it cannot identify', () => {
    // A prefix nobody claims renders as a plain card rather than as some other bank's colours.
    expect(isKnownBank('9999991234567890')).toBe(false);
    expect(isKnownBank('6104337890123456')).toBe(true);
    // Fewer than six digits is not a BIN yet.
    expect(isKnownBank('610')).toBe(false);
    expect(bankThemeFor('').name).toBe(UNKNOWN_BANK_THEME.name);
  });

  it('gives every card a complete theme', () => {
    // A missing colour would render as an invisible name on an invisible card, so the theme
    // is asserted to be whole rather than merely present.
    for (const number of ['6104337890123456', '6037991234567890', '9999991234567890']) {
      const theme = bankThemeFor(number);
      expect(theme.name.length).toBeGreaterThan(0);
      expect(theme.gradient).toContain('linear-gradient');
      expect(theme.brand).toMatch(/^(#[0-9a-f]{3,8}|rgba?\()/i);
      expect(theme.mark.length).toBeGreaterThan(0);
      expect(theme.mark.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('invoice state machine (§13)', () => {
  it('allows the legitimate forward transitions', () => {
    expect(canTransition('CREATED', 'PENDING')).toBe(true);
    expect(canTransition('PENDING', 'PAYMENT_DETECTED')).toBe(true);
    expect(canTransition('PAYMENT_DETECTED', 'CONFIRMING')).toBe(true);
    expect(canTransition('CONFIRMING', 'PAID')).toBe(true);
    expect(canTransition('PENDING', 'EXPIRED')).toBe(true);
    expect(canTransition('PENDING', 'MANUAL_REVIEW')).toBe(true);
  });

  it('refuses to reopen a terminal state', () => {
    expect(canTransition('PAID', 'PENDING')).toBe(false);
    expect(canTransition('EXPIRED', 'PAID')).toBe(false);
    expect(canTransition('CANCELLED', 'PENDING')).toBe(false);
    expect(() => assertTransition('PAID', 'PENDING')).toThrow();
  });

  it('keeps the unique amount claimed while an invoice is under review', () => {
    // This is the invariant that makes MANUAL_REVIEW safe: the amount stays reserved, so a
    // late confirmation cannot settle a later invoice that reused the same figure.
    expect(holdsAmount('MANUAL_REVIEW')).toBe(true);
    expect(holdsAmount('PENDING')).toBe(true);
    expect(holdsAmount('EXPIRED')).toBe(false);
    expect(holdsAmount('PAID')).toBe(false);
    expect(isTerminal('PAID')).toBe(true);
    expect(isTerminal('MANUAL_REVIEW')).toBe(false);
  });

  it('maps a status to what the payment page may offer', () => {
    expect(openability('PENDING').kind).toBe('PAYABLE');
    expect(openability('PAID').kind).toBe('PAID');
    expect(openability('EXPIRED').kind).toBe('EXPIRED');
    // Money has arrived; the page must not invite a second transfer.
    expect(openability('PAYMENT_DETECTED').kind).toBe('REVIEW');
    expect(openability('MANUAL_REVIEW').kind).toBe('REVIEW');
  });

  it('buckets statuses for reporting', () => {
    expect(statusBucket('PAID')).toBe('successful');
    expect(statusBucket('EXPIRED')).toBe('expired');
    expect(statusBucket('MANUAL_REVIEW')).toBe('review');
    expect(statusBucket('FAILED')).toBe('failed');
  });
});

describe('Jalali calendar (§17)', () => {
  it('converts known Nowruz dates', () => {
    // Nowruz is the one date everyone agrees on, which makes it the right anchor. These two
    // consecutive years are also the pair that catches the common arithmetic shortcut:
    // 1403 is leap, so 1404 begins a day later than a uniform 365-day cycle would predict.
    expect(gregorianToJalali({ year: 2024, month: 3, day: 20 })).toEqual({ year: 1403, month: 1, day: 1 });
    expect(gregorianToJalali({ year: 2025, month: 3, day: 21 })).toEqual({ year: 1404, month: 1, day: 1 });
    expect(jalaliToGregorian({ year: 1404, month: 1, day: 1 })).toEqual({ year: 2025, month: 3, day: 21 });
  });

  it('places the last day of a leap year correctly', () => {
    // 1403 is leap, so Esfand has 30 days and the year ends on 30 Esfand. A rule that calls
    // 1403 common would place the same Gregorian date in Farvardin of the next year.
    expect(jalaliToGregorian({ year: 1403, month: 12, day: 30 })).toEqual({ year: 2025, month: 3, day: 20 });
  });

  it('round-trips every day across four years', () => {
    // A conversion that is right at the year boundary but wrong mid-year would still pass a
    // spot check, so the whole range is walked.
    let cursor = Date.UTC(2023, 0, 1);
    const end = Date.UTC(2027, 0, 1);
    let checked = 0;

    while (cursor < end) {
      const date = new Date(cursor);
      const gregorian = {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
      };
      const back = jalaliToGregorian(gregorianToJalali(gregorian));
      expect(back).toEqual(gregorian);
      checked += 1;
      cursor += 24 * 60 * 60 * 1000;
    }

    expect(checked).toBeGreaterThan(1400);
  });

  it('knows the Iranian leap years', () => {
    // 1403, 1408 and 1412 are leap; the years between them are not. The simple
    // `((year + 38) * 31) % 128 < 31` approximation gets 1403 wrong, which shifts every
    // date from 1404 onward and would move a payment out of its matching window.
    expect(isJalaliLeapYear(1403)).toBe(true);
    expect(isJalaliLeapYear(1404)).toBe(false);
    expect(isJalaliLeapYear(1405)).toBe(false);
    expect(isJalaliLeapYear(1406)).toBe(false);
    expect(isJalaliLeapYear(1407)).toBe(false);
    expect(isJalaliLeapYear(1408)).toBe(true);
    expect(isJalaliLeapYear(1412)).toBe(true);
  });
});

/**
 * The amount in words, shown under the figure on the payment page.
 *
 * It is a second rendering of a number a customer is about to transfer, so a wrong word is
 * a wrong amount read out loud. Every case below is one the page can actually render.
 */
describe('amount in words', () => {
  it('says each place correctly', () => {
    expect(tomanInWords(1)).toBe('یک');
    expect(tomanInWords(9)).toBe('نه');
    expect(tomanInWords(10)).toBe('ده');
    expect(tomanInWords(15)).toBe('پانزده');
    expect(tomanInWords(19)).toBe('نوزده');
    expect(tomanInWords(20)).toBe('بیست');
    expect(tomanInWords(21)).toBe('بیست و یک');
    expect(tomanInWords(100)).toBe('صد');
    expect(tomanInWords(101)).toBe('صد و یک');
    expect(tomanInWords(999)).toBe('نهصد و نود و نه');
  });

  it('joins the scales with the Persian conjunction', () => {
    expect(tomanInWords(1000)).toBe('یک هزار');
    expect(tomanInWords(1001)).toBe('یک هزار و یک');
    expect(tomanInWords(1500)).toBe('یک هزار و پانصد');
    expect(tomanInWords(1_000_000)).toBe('یک میلیون');
    // The exact shape the payment page renders for a real invoice.
    expect(tomanInWords(324_555)).toBe('سیصد و بیست و چهار هزار و پانصد و پنجاه و پنج');
    expect(tomanInWords(3_655_450)).toBe('سه میلیون و ششصد و پنجاه و پنج هزار و چهارصد و پنجاه');
  });

  it('returns nothing rather than something wrong', () => {
    // Zero and negatives have no useful wording here, and the page omits the line.
    expect(tomanInWords(0)).toBe('');
    expect(tomanInWords(-1)).toBe('');
    // Past the scale table the only honest answer is silence.
    expect(tomanInWords(10 ** 16)).toBe('');
    expect(tomanInWords(1.5)).toBe('');
  });
});
