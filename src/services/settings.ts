/**
 * Settings (§27, §57, §73).
 *
 * Two layers, deliberately separate:
 *   - `system_settings`    platform configuration an admin can change
 *   - `merchant_settings`  per-merchant preferences
 *
 * Reading goes through a typed accessor with a code default, so a deployment that
 * has not seeded its settings table still behaves identically to one that has, and
 * a test does not have to seed anything to exercise the fee engine.
 *
 * Writing validates the value against the declared type. The admin console has to
 * be able to change the gateway fee without a deploy, and "the fee is now the
 * string 'three thousand'" is the failure mode that validation exists to prevent.
 */

import { AppError } from '../core/errors';
import { first, all, run } from '../db/client';
import { nowIso } from '../core/time';
import { parseSuffixDigits, type SuffixDigits } from '../core/unique-amount';
import type { FeeMode, SuffixRemainderOwner } from '../core/fees';

export type SettingType = 'string' | 'int' | 'bool' | 'json' | 'csv';

export interface SettingRow {
  key: string;
  value: string;
  type: SettingType;
  category: string;
  label: string | null;
  description: string | null;
  is_secret: number;
  updated_at: string;
  updated_by: string | null;
}

export interface MerchantSettingRow {
  merchant_user_id: string;
  key: string;
  value: string;
  type: SettingType;
  updated_at: string;
}

/**
 * Code defaults. These mirror seeds/0001_settings.sql exactly, and
 * `tests/unit/settings.test.ts` asserts the two agree — a default that drifts from
 * the seed is a production deployment that behaves differently from a test run.
 */
export const SETTING_DEFAULTS = {
  'gateway.fee_toman': 3000,
  'gateway.fee_mode_default': 'CUSTOMER',
  'gateway.percentage_fee_basis_points': 0,
  'fees.suffix_remainder_belongs_to': 'PLATFORM',
  'unique_amount.suffix_digits': 4,
  'unique_amount.max_attempts': 12,
  'invoices.expiry_minutes_min': 15,
  'invoices.expiry_minutes_max': 60,
  'invoices.expiry_minutes_default': 30,
  'invoices.min_amount_toman': 1000,
  'invoices.max_amount_toman': 500_000_000,
  'invoices.max_live_per_merchant': 500,
  'wallet.low_balance_threshold_toman': 10_000,
  'wallet.notification_cooldown_minutes': 360,
  'wallet.auto_disable_invoice_creation': true,
  'security.session_ttl_hours': 168,
  'security.admin_session_ttl_hours': 12,
  'security.max_failed_logins': 8,
  'security.lockout_minutes': 15,
  'rate_limit.make_payment_per_minute': 60,
  'rate_limit.sms_per_minute': 120,
  'rate_limit.api_per_minute': 300,
  'rate_limit.login_per_15_minutes': 10,
  'rate_limit.register_per_hour': 5,
  'rate_limit.public_invoice_per_minute': 120,
  'webhooks.max_attempts': 6,
  'webhooks.timeout_seconds': 10,
  'webhooks.disable_after_consecutive_failures': 25,
  'matching.time_window_minutes_before': 10,
  'matching.time_window_minutes_after': 90,
  'matching.require_card_match': false,
  'matching.min_confidence_auto_confirm': 70,
  'matching.auto_confirm_enabled': true,
  'cards.enforce_luhn': true,
  'cards.max_per_merchant': 20,
  'maintenance.invoice_creation_disabled': false,
  'maintenance.message': 'سرویس در حال به‌روزرسانی است. چند دقیقه دیگر دوباره تلاش کنید.',
  'platform.name': 'Steve Pay',
  'platform.iran_timezone': 'Asia/Tehran',
  'platform.registration_enabled': true,
  'platform.turnstile_required': false,
  'platform.sms_templates': '[]',
  'callbacks.allow_custom_urls': true,
  'telegram.low_balance_message': 'موجودی کیف پول شما کم است.',
  'telegram.invoice_failed_message': 'ساخت فاکتور ناموفق بود.',
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

/** Settings that must never be returned to a non-admin caller. */
const ADMIN_ONLY_SETTINGS: ReadonlySet<string> = new Set([
  'cards.enforce_luhn',
  'callbacks.allow_custom_urls',
  'matching.require_card_match',
]);

export function isAdminOnlySetting(key: string): boolean {
  return ADMIN_ONLY_SETTINGS.has(key);
}

export class SettingsService {
  private readonly db: D1Database;
  /** Per-isolate memo. Settings change rarely and are read on every request. */
  private cache: Map<string, string> | null = null;
  private cacheLoadedAt = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(db: D1Database) {
    this.db = db;
  }

  private async load(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.cache && now - this.cacheLoadedAt < SettingsService.CACHE_TTL_MS) return this.cache;
    const rows = await all<{ key: string; value: string }>(this.db, 'SELECT key, value FROM system_settings');
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.key, row.value);
    this.cache = map;
    this.cacheLoadedAt = now;
    return map;
  }

  /** Drops the memo. Called after a write so the change is visible immediately. */
  invalidate(): void {
    this.cache = null;
    this.cacheLoadedAt = 0;
  }

  async raw<K extends SettingKey>(key: K): Promise<string> {
    const map = await this.load();
    const value = map.get(key);
    if (value !== undefined) return value;
    return String(SETTING_DEFAULTS[key]);
  }

  async int<K extends SettingKey>(key: K): Promise<number> {
    const fallback = SETTING_DEFAULTS[key];
    const raw = await this.raw(key);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return typeof fallback === 'number' ? fallback : 0;
    }
    return Math.floor(parsed);
  }

  async bool<K extends SettingKey>(key: K): Promise<boolean> {
    const raw = (await this.raw(key)).trim().toLowerCase();
    if (raw === 'true' || raw === '1' || raw === 'yes') return true;
    if (raw === 'false' || raw === '0' || raw === 'no') return false;
    return SETTING_DEFAULTS[key] === true;
  }

  async json<T>(key: SettingKey): Promise<T | null> {
    const raw = await this.raw(key);
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async suffixDigits(): Promise<SuffixDigits> {
    return parseSuffixDigits(await this.raw('unique_amount.suffix_digits'));
  }

  async feeModeDefault(): Promise<FeeMode> {
    const raw = await this.raw('gateway.fee_mode_default');
    return raw === 'MERCHANT' ? 'MERCHANT' : 'CUSTOMER';
  }

  async suffixRemainderOwner(): Promise<SuffixRemainderOwner> {
    const raw = await this.raw('fees.suffix_remainder_belongs_to');
    return raw === 'MERCHANT' ? 'MERCHANT' : 'PLATFORM';
  }

  /** Every setting, for the admin console. `is_secret` rows are masked. */
  async list(): Promise<SettingRow[]> {
    return all<SettingRow>(
      this.db,
      `SELECT key, value, type, category, label, description, is_secret, updated_at, updated_by
       FROM system_settings ORDER BY category, key`,
    );
  }

  async categories(): Promise<string[]> {
    const rows = await all<{ category: string }>(
      this.db,
      'SELECT DISTINCT category FROM system_settings ORDER BY category',
    );
    return rows.map((row) => row.category);
  }

  /**
   * Writes a setting after validating it against its declared type.
   *
   * Numeric settings are additionally range-checked against their code default's
   * neighbourhood where that matters (the suffix digit count, the expiry bounds),
   * because a typo there produces a platform that cannot issue invoices at all.
   */
  async set(
    key: string,
    value: string,
    actorUserId: string | null,
  ): Promise<{ before: string | null; after: string }> {
    const existing = await first<SettingRow>(this.db, 'SELECT * FROM system_settings WHERE key = ?', [key]);
    const type: SettingType = existing?.type ?? inferType(key);

    validateSettingValue(key, value, type);

    await run(
      this.db,
      `INSERT INTO system_settings (key, value, type, category, label, description, is_secret, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [
        key,
        value,
        type,
        existing?.category ?? categoryOf(key),
        existing?.label ?? null,
        existing?.description ?? null,
        nowIso(),
        actorUserId,
      ],
    );
    this.invalidate();
    return { before: existing?.value ?? null, after: value };
  }

  // --- merchant scope ------------------------------------------------------

  async merchantRaw(merchantUserId: string, key: string): Promise<string | null> {
    const row = await first<MerchantSettingRow>(
      this.db,
      'SELECT * FROM merchant_settings WHERE merchant_user_id = ? AND key = ?',
      [merchantUserId, key],
    );
    return row?.value ?? null;
  }

  async merchantMap(merchantUserId: string): Promise<Record<string, string>> {
    const rows = await all<MerchantSettingRow>(
      this.db,
      'SELECT key, value FROM merchant_settings WHERE merchant_user_id = ?',
      [merchantUserId],
    );
    const out: Record<string, string> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  }

  /** Merchant-scoped read with a platform fallback, which is the usual lookup order. */
  async merchantOrPlatform(merchantUserId: string, key: SettingKey): Promise<string> {
    const own = await this.merchantRaw(merchantUserId, key);
    if (own !== null) return own;
    return this.raw(key);
  }

  async merchantInt(merchantUserId: string, key: SettingKey): Promise<number> {
    const raw = await this.merchantOrPlatform(merchantUserId, key);
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
    const fallback = SETTING_DEFAULTS[key];
    return typeof fallback === 'number' ? fallback : 0;
  }

  async merchantBool(merchantUserId: string, key: SettingKey): Promise<boolean> {
    const raw = (await this.merchantOrPlatform(merchantUserId, key)).trim().toLowerCase();
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return SETTING_DEFAULTS[key] === true;
  }

  async setMerchant(
    merchantUserId: string,
    key: string,
    value: string,
    type: SettingType = 'string',
  ): Promise<void> {
    await run(
      this.db,
      `INSERT INTO merchant_settings (merchant_user_id, key, value, type, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(merchant_user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [merchantUserId, key, value, type, nowIso()],
    );
  }

  /**
   * Removes a merchant override so the key falls back to the platform default.
   *
   * This exists because the alternative is a real bug: `setMerchant(key, '')` is not
   * "unset", it is "set to the empty string", and every reader has to decide what that
   * means. For `invoices.gateway_fee` in particular, `Number('')` is `0`, which is a
   * perfectly valid fee — so a merchant clearing the fee field to go back to the platform
   * default would instead have silently set their own fee to zero. Setting a value and
   * clearing a value are two different operations and now look like two different calls.
   */
  async clearMerchant(merchantUserId: string, key: string): Promise<void> {
    await run(this.db, 'DELETE FROM merchant_settings WHERE merchant_user_id = ? AND key = ?', [
      merchantUserId,
      key,
    ]);
  }
}

function inferType(key: string): SettingType {
  if (key.startsWith('unique_amount.suffix_digits')) return 'int';
  if (key.includes('enabled') || key.includes('disabled') || key.includes('required')) return 'bool';
  if (key.includes('templates')) return 'json';
  if (key.includes('allowlist')) return 'csv';
  return 'string';
}

function categoryOf(key: string): string {
  const prefix = key.split('.')[0];
  return prefix && prefix.length > 0 ? prefix : 'general';
}

const BOOLEAN_STRINGS = new Set(['true', 'false', '1', '0']);

/**
 * Validates a value against its declared type. Intentionally strict: an admin
 * console that accepts "3000 تومان" for a fee is an admin console that has just
 * set the fee to zero.
 */
export function validateSettingValue(key: string, value: string, type: SettingType): void {
  switch (type) {
    case 'int': {
      if (!/^-?\d+$/.test(value.trim())) {
        throw new AppError('SETTING_INVALID', {
          message: `مقدار «${key}» باید عدد صحیح باشد.`,
          details: { key, value },
        });
      }
      break;
    }
    case 'bool': {
      if (!BOOLEAN_STRINGS.has(value.trim().toLowerCase())) {
        throw new AppError('SETTING_INVALID', {
          message: `مقدار «${key}» باید true یا false باشد.`,
          details: { key, value },
        });
      }
      break;
    }
    case 'json': {
      try {
        JSON.parse(value);
      } catch {
        throw new AppError('SETTING_INVALID', {
          message: `مقدار «${key}» باید JSON معتبر باشد.`,
          details: { key },
        });
      }
      break;
    }
    case 'csv':
    case 'string':
    default:
      break;
  }

  if (key === 'unique_amount.suffix_digits' && value !== '3' && value !== '4') {
    throw new AppError('SETTING_INVALID', {
      message: 'طول بخش یکتا باید ۳ یا ۴ رقم باشد.',
      details: { key, value },
    });
  }
  if (key === 'gateway.fee_mode_default' && value !== 'CUSTOMER' && value !== 'MERCHANT') {
    throw new AppError('SETTING_INVALID', {
      message: 'حالت کارمزد باید CUSTOMER یا MERCHANT باشد.',
      details: { key, value },
    });
  }
  if (key === 'fees.suffix_remainder_belongs_to' && value !== 'PLATFORM' && value !== 'MERCHANT') {
    throw new AppError('SETTING_INVALID', {
      message: 'مالک باقیمانده یکتا باید PLATFORM یا MERCHANT باشد.',
      details: { key, value },
    });
  }

  const numeric = Number(value);
  if (
    key === 'gateway.fee_toman' &&
    Number.isFinite(numeric) &&
    (numeric < 0 || numeric > 1_000_000)
  ) {
    throw new AppError('SETTING_INVALID', {
      message: 'کارمزد باید بین ۰ تا ۱٬۰۰۰٬۰۰۰ تومان باشد.',
      details: { key, value },
    });
  }
  if (
    key === 'unique_amount.max_attempts' &&
    Number.isFinite(numeric) &&
    (numeric < 1 || numeric > 9000)
  ) {
    throw new AppError('SETTING_INVALID', {
      message: 'تعداد تلاش باید بین ۱ تا ۹۰۰۰ باشد.',
      details: { key, value },
    });
  }
  if (
    (key === 'matching.min_confidence_auto_confirm') &&
    Number.isFinite(numeric) &&
    (numeric < 0 || numeric > 100)
  ) {
    throw new AppError('SETTING_INVALID', {
      message: 'حد اطمینان باید بین ۰ تا ۱۰۰ باشد.',
      details: { key, value },
    });
  }
}

/** Convenience constructor so callers do not each hold a settings instance. */
export function settingsFor(db: D1Database): SettingsService {
  return new SettingsService(db);
}
