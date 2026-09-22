/**
 * Time helpers.
 *
 * Two rules shape this module:
 *   1. Everything stored is an ISO-8601 UTC string. ISO text sorts the same way
 *      it sorts chronologically, so range scans stay index-friendly.
 *   2. Anything the platform *reports* as a day (revenue today, daily rollups,
 *      invoice counts) is a day in Iran local time, because that is the day a
 *      merchant and an admin both mean when they say "today".
 */

import { toPersianDigits } from './digits';
import { gregorianToJalali, jalaliMonthName } from './jalali';

/**
 * Iran abandoned daylight saving in 2022, so the offset is a constant +03:30.
 * It is a named constant rather than a literal so that if DST ever returns there
 * is exactly one place to change.
 */
export const TEHRAN_OFFSET_MINUTES = 210;
export const TEHRAN_OFFSET_MS = TEHRAN_OFFSET_MINUTES * 60_000;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Current instant, ISO-8601 UTC. Inject this everywhere; never call Date.now() directly in services. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: Date | number | string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  const parsed = new Date(value);
  return parsed.toISOString();
}

/** Epoch milliseconds from any stored representation. Returns NaN for garbage. */
export function epochMs(value: string | Date | number): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(epochMs(iso) + minutes * MINUTE_MS).toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(epochMs(iso) + seconds * 1000).toISOString();
}

export function addDays(iso: string, days: number): string {
  return new Date(epochMs(iso) + days * DAY_MS).toISOString();
}

/** True when `iso` is strictly in the past relative to `reference`. */
export function isPast(iso: string, reference: string | Date = new Date()): boolean {
  return epochMs(iso) < epochMs(reference);
}

export function isFuture(iso: string, reference: string | Date = new Date()): boolean {
  return epochMs(iso) > epochMs(reference);
}

/** Whole minutes between two instants, rounded down. Used for time-to-payment analytics. */
export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.floor((epochMs(toIso) - epochMs(fromIso)) / MINUTE_MS);
}

export function secondsBetween(fromIso: string, toIso: string): number {
  return Math.floor((epochMs(toIso) - epochMs(fromIso)) / 1000);
}

/**
 * The Iran-local calendar day for an instant, as 'YYYY-MM-DD'.
 * This is the key used by metrics_daily, api_usage_daily and every "today" query.
 */
export function tehranDayKey(instant: string | Date): string {
  const ms = epochMs(instant) + TEHRAN_OFFSET_MS;
  const shifted = new Date(ms);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Midnight at the start of an Iran-local day, returned as a UTC instant. */
export function startOfTehranDay(instant: string | Date): string {
  const key = tehranDayKey(instant);
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day) - TEHRAN_OFFSET_MS).toISOString();
}

/** Exclusive upper bound for "today" — the instant the next local day begins. */
export function endOfTehranDay(instant: string | Date): string {
  return new Date(epochMs(startOfTehranDay(instant)) + DAY_MS).toISOString();
}

export function tehranDayKeyOffset(days: number, from: string | Date = new Date()): string {
  return tehranDayKey(new Date(epochMs(from) - days * DAY_MS));
}

/** The seven day keys ending today, oldest first. Used by the dashboard sparkline. */
export function lastDayKeys(count: number, from: string | Date = new Date()): string[] {
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    keys.push(tehranDayKeyOffset(offset, from));
  }
  return keys;
}

/** Hour bucket key 'YYYY-MM-DDTHH' in Iran local time, used for hourly analytics. */
export function tehranHourKey(instant: string | Date): string {
  const shifted = new Date(epochMs(instant) + TEHRAN_OFFSET_MS);
  const hour = String(shifted.getUTCHours()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shifted.getUTCDate(),
  ).padStart(2, '0')}T${hour}`;
}

/**
 * Formats an instant as Jalali date + Iran-local clock time, in Persian digits.
 * This is what every human-facing timestamp in the UI goes through.
 */
export function formatJalaliDateTime(instant: string | Date): string {
  const shifted = new Date(epochMs(instant) + TEHRAN_OFFSET_MS);
  const jalali = gregorianToJalali({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
  const hour = String(shifted.getUTCHours()).padStart(2, '0');
  const minute = String(shifted.getUTCMinutes()).padStart(2, '0');
  return toPersianDigits(
    `${jalali.year}/${String(jalali.month).padStart(2, '0')}/${String(jalali.day).padStart(2, '0')} - ${hour}:${minute}`,
  );
}

export function formatJalaliDate(instant: string | Date): string {
  const shifted = new Date(epochMs(instant) + TEHRAN_OFFSET_MS);
  const jalali = gregorianToJalali({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
  return toPersianDigits(`${jalali.day} ${jalaliMonthName(jalali.month)} ${jalali.year}`);
}

export function formatClockTime(instant: string | Date): string {
  const shifted = new Date(epochMs(instant) + TEHRAN_OFFSET_MS);
  return toPersianDigits(
    `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`,
  );
}

/** "چند لحظه پیش" style relative time for activity feeds. */
export function formatRelativeFa(instant: string | Date, reference: string | Date = new Date()): string {
  const deltaSeconds = Math.max(0, Math.floor((epochMs(reference) - epochMs(instant)) / 1000));
  if (deltaSeconds < 60) return 'همین حالا';
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${toPersianDigits(minutes)} دقیقه پیش`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${toPersianDigits(hours)} ساعت پیش`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${toPersianDigits(days)} روز پیش`;
  return formatJalaliDate(instant);
}

/** mm:ss countdown for the payment page. */
export function formatCountdown(remainingMs: number): string {
  const clamped = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Exponential backoff schedule for webhook retries, in minutes.
 * The first attempt is immediate; these are the gaps that follow it.
 * Six attempts spanning roughly half a day is the sweet spot between "a merchant's
 * five-minute outage recovers on its own" and "a permanently broken endpoint
 * eventually stops burning someone's CPU".
 */
export const WEBHOOK_BACKOFF_MINUTES = [1, 5, 30, 120, 720, 1440] as const;

export function webhookBackoffMinutes(attempt: number): number {
  const index = Math.max(0, Math.min(attempt - 1, WEBHOOK_BACKOFF_MINUTES.length - 1));
  return WEBHOOK_BACKOFF_MINUTES[index] ?? 1440;
}
