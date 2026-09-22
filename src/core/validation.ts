/**
 * Input validation (§40).
 *
 * Every value that crosses the boundary is validated here rather than trusted. The
 * interesting part is not "is this a string" but the domain rules that quietly
 * decide correctness:
 *
 *   - Iranian mobiles arrive as 09…, +989…, 0098…, 98…, with Persian digits and
 *     spaces or dashes. One normal form is required because the mobile is the login
 *     identity and a duplicate account could otherwise be created with the same
 *     number written differently.
 *
 *   - Callback URLs are attacker-influenced data that our server then fetches. A
 *     URL pointing at 169.254.169.254 or a private range is a server-side request
 *     forgery primitive, not a configuration mistake, so it is rejected outright.
 */

import { AppError } from './errors';
import { stripNonDigits } from './digits';

// ---------------------------------------------------------------------------
// Mobile numbers
// ---------------------------------------------------------------------------

/** Iranian mobile operators issue prefixes 090x through 099x. */
const IRANIAN_MOBILE_PATTERN = /^09\d{9}$/;

/**
 * Normalises to the canonical `09XXXXXXXXX` form.
 *
 * Rejects anything that is not a plausible Iranian mobile, because the mobile is
 * the account identity: a landline that slips through becomes a login that can
 * never receive a verification and a duplicate that is hard to detect.
 */
export function normalizeMobile(input: string): string {
  const digits = stripNonDigits(input);

  let candidate = digits;
  if (digits.startsWith('0098')) candidate = digits.slice(4);
  else if (digits.startsWith('98') && digits.length === 12) candidate = digits.slice(2);

  if (candidate.length === 10 && candidate.startsWith('9')) candidate = `0${candidate}`;

  if (!IRANIAN_MOBILE_PATTERN.test(candidate)) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'شماره موبایل معتبر نیست. نمونه درست: ۰۹۱۲۳۴۵۶۷۸۹',
      details: { field: 'mobile' },
    });
  }
  return candidate;
}

export function isValidMobile(input: string): boolean {
  try {
    normalizeMobile(input);
    return true;
  } catch {
    return false;
  }
}

/** `0912 345 6789` for display. Never used as a key. */
export function formatMobile(input: string): string {
  const mobile = normalizeMobile(input);
  return `${mobile.slice(0, 4)} ${mobile.slice(4, 7)} ${mobile.slice(7)}`;
}

// ---------------------------------------------------------------------------
// Telegram identities
// ---------------------------------------------------------------------------

/**
 * Telegram usernames are 5-32 characters of letters, digits and underscores and
 * cannot begin with a digit or underscore. The value is stored as given but is not
 * trusted until the ownership flow completes (§25).
 */
export function normalizeTelegramUsername(input: string): string | null {
  const trimmed = input.trim().replace(/^@+/, '');
  if (trimmed.length === 0) return null;
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(trimmed)) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'نام کاربری تلگرام معتبر نیست.',
      details: { field: 'telegramUsername' },
    });
  }
  return trimmed;
}

export function normalizeTelegramUserId(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const digits = stripNonDigits(input);
  if (digits.length === 0) return null;
  if (!/^\d{5,15}$/.test(digits)) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'شناسه عددی تلگرام معتبر نیست.',
      details: { field: 'telegramUserId' },
    });
  }
  return digits;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Hostnames that must never be fetched by our server. A merchant-supplied callback
 * to one of these turns the webhook delivery system into an SSRF tool pointed at
 * Cloudflare's internal metadata endpoint or the merchant's own private network.
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^\[?::1\]?$/,
  /^\[?fc00:/i,
  /^\[?fe80:/i,
  /\.local$/i,
  /^metadata\./i,
];

export interface CallbackUrlOptions {
  /** Skip the https requirement. Development only. */
  allowInsecure?: boolean;
  /** When non-empty, the host must be in this list. */
  allowedHosts?: readonly string[];
}

/**
 * Validates a merchant-supplied callback URL.
 *
 * Returns a normalised URL with the fragment stripped (a fragment is never sent to
 * a server, so it is always a sign the merchant pasted the wrong thing).
 */
export function validateCallbackUrl(input: string, options: CallbackUrlOptions = {}): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError('CALLBACK_URL_NOT_ALLOWED', {
      message: 'آدرس بازگشت معتبر نیست.',
      details: { reason: 'PARSE_ERROR' },
    });
  }

  if (url.protocol !== 'https:' && !(options.allowInsecure && url.protocol === 'http:')) {
    throw new AppError('CALLBACK_URL_NOT_ALLOWED', {
      message: 'آدرس بازگشت باید با https شروع شود.',
      details: { reason: 'INSECURE_SCHEME' },
    });
  }

  if (url.username || url.password) {
    throw new AppError('CALLBACK_URL_NOT_ALLOWED', {
      message: 'آدرس بازگشت نباید نام کاربری یا گذرواژه داشته باشد.',
      details: { reason: 'CREDENTIALS_IN_URL' },
    });
  }

  const host = url.hostname;
  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new AppError('CALLBACK_URL_NOT_ALLOWED', {
      message: 'آدرس بازگشت به شبکه داخلی اشاره می‌کند و مجاز نیست.',
      details: { reason: 'PRIVATE_HOST' },
    });
  }

  if (url.port && url.port !== '443' && url.port !== '80') {
    throw new AppError('CALLBACK_URL_NOT_ALLOWED', {
      message: 'آدرس بازگشت باید روی پورت استاندارد باشد.',
      details: { reason: 'NON_STANDARD_PORT' },
    });
  }

  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const allowed = options.allowedHosts.some(
      (entry) => host === entry || host.endsWith(`.${entry}`),
    );
    if (!allowed) {
      throw new AppError('CALLBACK_URL_NOT_ALLOWED', {
        message: 'این دامنه در فهرست دامنه‌های مجاز شما نیست.',
        details: { reason: 'HOST_NOT_ALLOWED', host },
      });
    }
  }

  if (url.href.length > 2048) {
    throw new AppError('CALLBACK_URL_NOT_ALLOWED', {
      message: 'آدرس بازگشت بیش از حد طولانی است.',
      details: { reason: 'TOO_LONG' },
    });
  }

  url.hash = '';
  return url.toString();
}

/** Same rules as a callback, used for the customer-facing return URL (§50). */
export function validateReturnUrl(input: string, options: CallbackUrlOptions = {}): string {
  return validateCallbackUrl(input, options);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Strips control characters and truncates. Applied to every free-text field before
 * storage: control characters are how a payload smuggles itself into a log line or
 * a terminal, and an unbounded length is how a single request inflates a row.
 */
export function sanitizeText(input: string | null | undefined, maxLength = 500): string | null {
  if (input === null || input === undefined) return null;
  // Control characters are stripped because they are how a payload smuggles itself
  // into a log line or a terminal; the range is written numerically rather than as
  // a literal so the intent is visible.
  const cleaned = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

export function requireText(input: string | null | undefined, field: string, options: { min?: number; max?: number } = {}): string {
  const min = options.min ?? 1;
  const max = options.max ?? 500;
  const cleaned = sanitizeText(input, max);
  if (cleaned === null || cleaned.length < min) {
    throw new AppError('VALIDATION_FAILED', {
      message: `مقدار «${field}» الزامی است.`,
      details: { field, min },
    });
  }
  return cleaned;
}

export function optionalText(input: string | null | undefined, maxLength = 500): string | null {
  return sanitizeText(input, maxLength);
}

// ---------------------------------------------------------------------------
// Enumerations and numbers
// ---------------------------------------------------------------------------

export function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new AppError('VALIDATION_FAILED', {
      message: `مقدار «${field}» باید یکی از ${allowed.join('، ')} باشد.`,
      details: { field, allowed },
    });
  }
  return value as T;
}

export function assertIntegerInRange(value: unknown, min: number, max: number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError('VALIDATION_FAILED', {
      message: `مقدار «${field}» باید عددی صحیح بین ${min} و ${max} باشد.`,
      details: { field, min, max },
    });
  }
  return parsed;
}

export function isValidEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.trim()) && input.length <= 254;
}

/**
 * Validates a `starts with` filter used in list endpoints. Only the well-known id
 * prefixes are accepted, so a filter cannot be used to probe for row shapes.
 */
export function assertIdPrefix(input: string, prefixes: readonly string[], field: string): string {
  const trimmed = input.trim();
  const found = prefixes.some((prefix) => trimmed.startsWith(`${prefix}_`));
  if (!found) {
    throw new AppError('VALIDATION_FAILED', {
      message: `شناسه «${field}» معتبر نیست.`,
      details: { field, expectedPrefixes: prefixes },
    });
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Business metadata
// ---------------------------------------------------------------------------

export const BUSINESS_TYPES = [
  'DIGITAL_GOODS',
  'SOFTWARE',
  'EDUCATION',
  'SERVICES',
  'RETAIL',
  'FOOD',
  'TRAVEL',
  'CRYPTO_EXCHANGE',
  'CHARITY',
  'ENTERTAINMENT',
  'OTHER',
] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  DIGITAL_GOODS: 'کالای دیجیتال',
  SOFTWARE: 'نرم‌افزار و اشتراک',
  EDUCATION: 'آموزش',
  SERVICES: 'خدمات',
  RETAIL: 'فروشگاهی',
  FOOD: 'رستوران و مواد غذایی',
  TRAVEL: 'گردشگری',
  CRYPTO_EXCHANGE: 'صرافی ارز دیجیتال',
  CHARITY: 'خیریه',
  ENTERTAINMENT: 'سرگرمی',
  OTHER: 'سایر',
};

export function businessTypeLabel(type: string): string {
  return BUSINESS_TYPE_LABELS[type as BusinessType] ?? type;
}
