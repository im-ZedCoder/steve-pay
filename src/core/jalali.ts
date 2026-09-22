/**
 * Jalali (Solar Hijri) ⇄ Gregorian conversion.
 *
 * Bank SMS messages are usually stamped in the Jalali calendar ("1402/05/12 - 14:23")
 * but some banks send Gregorian stamps instead. The matcher compares SMS times
 * against payment windows, so both forms have to land on the same absolute
 * instant. Getting this wrong silently widens or narrows the time window, which
 * is exactly the kind of bug that shows up as "payments sometimes don't match".
 *
 * This uses the Khayyam / Borkowski arithmetic conversion with its 33-year cycle *break
 * table*, which is exact for 1178–1633 Jalali (1799–2256 Gregorian) — far beyond the
 * operational range. The break table is what makes it exact: the cycle is not uniform, and
 * the simplified rule that omits the table is off by a day for years including 1403–1404.
 *
 * Jalali months: 1-6 have 31 days, 7-11 have 30 days, month 12 has 29 days
 * (30 in a leap year).
 */

export interface JalaliDate {
  year: number;
  month: number;
  day: number;
}

export interface GregorianDate {
  year: number;
  month: number;
  day: number;
}

/** Julian Day Number for a Gregorian date. */
export function gregorianToJdn(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

/** Gregorian date from a Julian Day Number. */
export function jdnToGregorian(jdn: number): GregorianDate {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    year: 100 * b + d - 4800 + Math.floor(m / 10),
    month: m + 3 - 12 * Math.floor(m / 10),
    day: e - Math.floor((153 * m + 2) / 5) + 1,
  };
}

/**
 * The 33-year cycle break table.
 *
 * These are the years at which the cycle restarts, from the Borkowski/Khayyam algorithm
 * (`jalaali-js`, itself ported from Roozbeh Pournader's `jalali.c`). The cycle is genuinely
 * not uniform, and a purely arithmetic rule needs a correction the simple form cannot
 * express. The commonly-copied approximation `((year + 38) * 31) % 128 < 31` is wrong for
 * real years — it calls 1403 a common year, when the Iranian calendar makes it leap.
 *
 * That one-day error is not cosmetic in this system. Every date from 1404 onward shifts by
 * a day, so a bank SMS stamped `1404/01/01` would be placed a day early, potentially
 * outside the matching window, and a real transfer would go unmatched for no visible
 * reason. The table costs a few hundred bytes and removes the entire failure mode.
 */
const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324,
  2394, 2456, 3178,
] as const;

/** Supported Jalali range, the span over which the break table is exact. */
export const MIN_JALALI_YEAR = 1178;
export const MAX_JALALI_YEAR = 1633;

/** Truncating division and floored modulo, matching the reference implementation. */
const div = (a: number, b: number): number => Math.trunc(a / b);
const mod = (a: number, b: number): number => a - Math.floor(a / b) * b;

interface JalaliYearInfo {
  /** 0 when the year is leap; otherwise its position in the 33-year cycle. */
  leap: number;
  /** Gregorian year that contains 1 Farvardin of this Jalali year. */
  gy: number;
  /** Day of March on which 1 Farvardin falls. */
  march: number;
}

/**
 * Locates one Jalali year in the cycle: which Gregorian March 1 Farvardin lands on, and
 * whether the year is leap.
 */
function jalCal(jy: number): JalaliYearInfo {
  const first = BREAKS[0] as number;
  const last = BREAKS[BREAKS.length - 1] as number;
  if (jy < first || jy >= last) {
    throw new RangeError(`Jalali year ${jy} is outside the supported range (${first}..${last - 1})`);
  }

  const gy = jy + 621;
  let leapJ = -14;
  let jp = first;
  let jump = 0;

  for (let index = 1; index < BREAKS.length; index += 1) {
    const jm = BREAKS[index] as number;
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }

  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  // The four years straddling a break need one correction, or the count of leap years is
  // off by one and every date in that cycle lands a day late.
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;

  // Leap days in the Gregorian calendar up to the same point. A count of leap years is only
  // useful once turned into a day of March, which is what this subtraction does.
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;

  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;

  return { leap, gy, march };
}

/**
 * Whether a Jalali year has 366 days.
 *
 * The leap day is the 30th of Esfand (month 12). 1403 is leap; 1404, 1405, 1406 and 1407
 * are not; 1408 is.
 */
export function isJalaliLeapYear(year: number): boolean {
  return jalCal(year).leap === 0;
}

export function jalaliMonthLength(year: number, month: number): number {
  if (month <= 6) return 31;
  if (month <= 11) return 30;
  return isJalaliLeapYear(year) ? 30 : 29;
}

export function isValidJalali(year: number, month: number, day: number): boolean {
  // The range is checked before the month length, because the month length consults the
  // break table and would throw for an out-of-range year instead of returning false.
  if (year < MIN_JALALI_YEAR || year > MAX_JALALI_YEAR) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= jalaliMonthLength(year, month);
}

/** Julian Day Number of 1 Farvardin of a Jalali year. */
function jdnOfFarvardin1(jy: number): number {
  const info = jalCal(jy);
  return gregorianToJdn(info.gy, 3, info.march);
}

/**
 * Jalali -> Gregorian.
 *
 * Derived from the year's own 1 Farvardin rather than from a fixed epoch constant, so
 * there is no magic number whose sign or off-by-one could be wrong. The month arithmetic
 * uses the closed form for the Jalali month lengths — months 1-6 have 31 days, 7-11 have
 * 30, and Esfand has 29 or 30 — which is exactly what
 * `(month - 1) * 31 - floor(month / 7) * (month - 7)` encodes.
 */
export function jalaliToGregorian(date: JalaliDate): GregorianDate {
  if (!isValidJalali(date.year, date.month, date.day)) {
    throw new RangeError(`Invalid Jalali date: ${date.year}/${date.month}/${date.day}`);
  }
  const jdn =
    jdnOfFarvardin1(date.year) +
    (date.month - 1) * 31 -
    div(date.month, 7) * (date.month - 7) +
    date.day -
    1;
  return jdnToGregorian(jdn);
}

/**
 * Gregorian -> Jalali. Used for rendering dates in the Persian UI.
 *
 * Out-of-range Gregorian years are clamped into the supported span rather than throwing.
 * This function runs inside page rendering, and a corrupt or hostile timestamp must not be
 * able to turn a dashboard into a 500 — a wrong date in 1700 is harmless, an exception on
 * the way to the response is not.
 */
export function gregorianToJalali(date: GregorianDate): JalaliDate {
  const jdn = gregorianToJdn(date.year, date.month, date.day);
  let jy = Math.min(Math.max(date.year - 621, MIN_JALALI_YEAR), MAX_JALALI_YEAR);

  const info = jalCal(jy);
  let k = jdn - jdnOfFarvardin1(jy);

  if (k >= 0) {
    // Months 1-6 are 31 days each, so the first 186 days of the year are the summer half.
    if (k <= 185) return { year: jy, month: 1 + div(k, 31), day: mod(k, 31) + 1 };
    k -= 186;
  } else {
    // Before 1 Farvardin: the tail of the previous Jalali year, which is 179 or 180 days
    // depending on whether the year just ended was leap.
    jy -= 1;
    k += 179;
    if (info.leap === 1) k += 1;
  }

  return { year: jy, month: 7 + div(k, 30), day: mod(k, 30) + 1 };
}

/**
 * Parses the date/time fragments banks actually send:
 *   1402/05/12 - 14:23      1402-05-12 14:23:45      1402/05/12
 *   2023/08/03 14:23        2023-08-03T14:23:00
 * Returns an absolute instant, or null when nothing usable was present.
 * Assumes the timestamp is already in Iran local time and converts to UTC.
 */
export function parseSmsDateTime(
  input: string,
  options: { offsetMinutes?: number } = {},
): Date | null {
  const offsetMinutes = options.offsetMinutes ?? 210; // +03:30
  const text = input.replace(/[T_]/g, ' ').replace(/\s+/g, ' ').trim();

  const match = /(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[ ,\-]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
    text,
  );
  if (!match) return null;

  const [, yRaw, mRaw, dRaw, hRaw, minRaw, sRaw] = match;
  const year = Number(yRaw);
  const month = Number(mRaw);
  const day = Number(dRaw);
  const hour = hRaw ? Number(hRaw) : 0;
  const minute = minRaw ? Number(minRaw) : 0;
  const second = sRaw ? Number(sRaw) : 0;

  if (hour > 23 || minute > 59 || second > 59) return null;

  let gregorian: GregorianDate;
  if (year < 1700) {
    // Jalali stamp.
    if (!isValidJalali(year, month, day)) return null;
    gregorian = jalaliToGregorian({ year, month, day });
  } else {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    gregorian = { year, month, day };
  }

  const utcMs =
    Date.UTC(gregorian.year, gregorian.month - 1, gregorian.day, hour, minute, second) -
    offsetMinutes * 60_000;
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date;
}

const JALALI_MONTH_NAMES = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
];

export function jalaliMonthName(month: number): string {
  return JALALI_MONTH_NAMES[month - 1] ?? '';
}
