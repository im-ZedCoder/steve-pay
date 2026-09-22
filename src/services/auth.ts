/**
 * Authentication (§5).
 *
 * Sessions are opaque random tokens whose SHA-256 is stored; the raw token exists
 * only in the cookie. Losing the database does not hand over a live session, and a
 * session can be revoked instantly by marking the row.
 *
 * Login protection is two-layered: a per-IP rate limit (cheap, stops a flood) and a
 * per-account failed-attempt counter with a timed lockout (slower, stops a targeted
 * password spray). Both are needed; neither is sufficient alone.
 */

import { AppError } from '../core/errors';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  randomToken,
  verifyPassword,
  passwordNeedsRehash,
} from '../core/crypto';
import { id as newId } from '../core/ids';
import { nowIso, addMinutes, isPast } from '../core/time';
import { first, run, scalar } from '../db/client';
import { normalizeMobile } from '../core/validation';
import { SettingsService } from './settings';
import { AuditService } from './audit';
import type { Role } from '../core/roles';

export interface UserRow {
  id: string;
  mobile: string;
  email: string | null;
  password_hash: string;
  role: Role;
  status: 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED' | 'BANNED';
  display_name: string | null;
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
  must_change_password: number;
  totp_enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId?: string;
}

export interface RegistrationInput {
  mobile: string;
  password: string;
  confirmPassword: string;
  businessType: string;
  businessDescription?: string | null;
  telegramUsername?: string | null;
  telegramUserId?: string | null;
  displayName?: string | null;
  turnstileToken?: string | null;
}

export class AuthService {
  private readonly db: D1Database;
  private readonly settings: SettingsService;
  private readonly audit: AuditService;

  constructor(db: D1Database, settings: SettingsService, audit: AuditService) {
    this.db = db;
    this.settings = settings;
    this.audit = audit;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Creates a merchant account in PENDING_APPROVAL (§4).
   *
   * No API key, no wallet balance, no dashboard access until an admin approves.
   * The account cannot issue a single invoice while pending, which is what makes
   * approval a real gate rather than a notification.
   */
  async register(
    input: RegistrationInput,
    meta: RequestMeta,
  ): Promise<{ userId: string; merchantCode: string; status: string }> {
    const registrationEnabled = await this.settings.bool('platform.registration_enabled');
    if (!registrationEnabled) throw new AppError('REGISTRATION_DISABLED');

    const mobile = normalizeMobile(input.mobile);
    if (input.password !== input.confirmPassword) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'گذرواژه و تکرار آن یکسان نیستند.',
        details: { field: 'confirmPassword' },
      });
    }
    validatePasswordStrength(input.password);

    const existing = await first<{ id: string }>(this.db, 'SELECT id FROM users WHERE mobile = ?', [mobile]);
    if (existing) {
      // Registration is unauthenticated, so the response is deliberately the same
      // whether or not the number exists... except here it cannot be: the user has
      // to be told to log in instead. The trade-off is a mobile-enumeration oracle,
      // mitigated by the per-IP registration rate limit.
      throw new AppError('DUPLICATE_MOBILE');
    }

    const userId = newId('usr');
    const passwordHash = await hashPassword(input.password);
    const timestamp = nowIso();

    const merchantCode = await this.nextMerchantCode();

    // A single batch so a user without a profile row can never exist.
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO users (id, mobile, password_hash, role, status, display_name, created_at, updated_at)
           VALUES (?, ?, ?, 'MERCHANT', 'PENDING_APPROVAL', ?, ?, ?)`,
        )
        .bind(userId, mobile, passwordHash, input.displayName ?? null, timestamp, timestamp),
      this.db
        .prepare(
          `INSERT INTO merchant_profiles (
             user_id, merchant_code, business_type, business_description,
             telegram_username, telegram_user_id, telegram_verified, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .bind(
          userId,
          merchantCode,
          input.businessType,
          input.businessDescription ?? null,
          input.telegramUsername ?? null,
          // A Telegram user id supplied at signup is stored but NOT trusted: it is
          // only marked verified after the ownership flow runs (§25).
          input.telegramUserId ?? null,
          input.displayName ?? null,
          timestamp,
          timestamp,
        ),
      this.db
        .prepare(
          `INSERT INTO wallets (merchant_user_id, balance, reserved_balance, created_at, updated_at)
           VALUES (?, 0, 0, ?, ?)`,
        )
        .bind(userId, timestamp, timestamp),
    ]);

    await this.audit.record({
      event: 'auth.register',
      actor: { userId, role: 'MERCHANT', ip: meta.ip, userAgent: meta.userAgent },
      merchantUserId: userId,
      targetType: 'user',
      targetId: userId,
      requestId: meta.requestId ?? null,
      metadata: { businessType: input.businessType, merchantCode },
    });

    return { userId, merchantCode, status: 'PENDING_APPROVAL' };
  }

  /** Sequential, human-readable merchant code: SP-1001, SP-1002, … */
  async nextMerchantCode(): Promise<string> {
    const row = await first<{ value: number }>(
      this.db,
      `INSERT INTO sequences (name, value) VALUES ('merchant_code', 1001)
       ON CONFLICT(name) DO UPDATE SET value = sequences.value + 1
       RETURNING value`,
    );
    return `SP-${row?.value ?? 1001}`;
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async login(
    input: { mobile: string; password: string; adminOnly?: boolean },
    meta: RequestMeta,
  ): Promise<{ token: string; expiresAt: string; user: UserRow }> {
    const mobile = normalizeMobile(input.mobile);
    const user = await first<UserRow>(this.db, 'SELECT * FROM users WHERE mobile = ?', [mobile]);

    // Record every attempt, including for unknown accounts: a spray against
    // non-existent numbers is worth seeing.
    const recordFailure = async (reason: string): Promise<void> => {
      await run(
        this.db,
        `INSERT INTO login_attempts (identifier, user_id, ip, user_agent, success, reason, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
        [mobile, user?.id ?? null, meta.ip, meta.userAgent, reason, nowIso()],
      );
      await this.audit.record({
        event: 'auth.login_failed',
        actor: { userId: user?.id ?? null, role: user?.role ?? null, ip: meta.ip, userAgent: meta.userAgent },
        merchantUserId: user?.role === 'MERCHANT' ? user.id : null,
        targetType: 'user',
        targetId: user?.id ?? null,
        requestId: meta.requestId ?? null,
        severity: 'WARNING',
        metadata: { reason, mobile },
      });
    };

    if (!user) {
      await recordFailure('USER_NOT_FOUND');
      // Same error as a wrong password, so the response does not reveal which
      // mobile numbers exist.
      throw new AppError('INVALID_CREDENTIALS');
    }

    if (user.locked_until && !isPast(user.locked_until)) {
      await recordFailure('ACCOUNT_LOCKED');
      throw new AppError('ACCOUNT_LOCKED', {
        details: { lockedUntil: user.locked_until },
      });
    }

    const passwordOk = await verifyPassword(input.password, user.password_hash);
    if (!passwordOk) {
      const maxFailures = await this.settings.int('security.max_failed_logins');
      const lockoutMinutes = await this.settings.int('security.lockout_minutes');
      const nextCount = user.failed_login_count + 1;
      const shouldLock = nextCount >= maxFailures;

      await run(
        this.db,
        'UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?',
        [nextCount, shouldLock ? addMinutes(nowIso(), lockoutMinutes) : user.locked_until, nowIso(), user.id],
      );

      if (shouldLock) {
        await this.audit.record({
          event: 'auth.account_locked',
          actor: { userId: user.id, role: user.role, ip: meta.ip },
          merchantUserId: user.role === 'MERCHANT' ? user.id : null,
          targetType: 'user',
          targetId: user.id,
          severity: 'CRITICAL',
          metadata: { failedAttempts: nextCount, lockoutMinutes },
        });
      }

      await recordFailure('BAD_PASSWORD');
      throw new AppError('INVALID_CREDENTIALS', {
        details: shouldLock ? { lockedForMinutes: lockoutMinutes } : { attemptsRemaining: maxFailures - nextCount },
      });
    }

    // Password is correct; now the account state decides whether it matters.
    if (input.adminOnly && user.role === 'MERCHANT') {
      await recordFailure('NOT_ADMIN');
      throw new AppError('FORBIDDEN');
    }

    if (user.status !== 'ACTIVE') {
      await recordFailure(`STATUS_${user.status}`);
      const code =
        user.status === 'PENDING_APPROVAL'
          ? 'ACCOUNT_PENDING_APPROVAL'
          : user.status === 'REJECTED'
            ? 'ACCOUNT_REJECTED'
            : user.status === 'SUSPENDED'
              ? 'ACCOUNT_SUSPENDED'
              : 'ACCOUNT_BANNED';
      throw new AppError(code);
    }

    // Success: clear the counter, then mint a session.
    await run(
      this.db,
      `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ?, updated_at = ?
       WHERE id = ?`,
      [nowIso(), meta.ip, nowIso(), user.id],
    );

    await run(
      this.db,
      `INSERT INTO login_attempts (identifier, user_id, ip, user_agent, success, reason, created_at)
       VALUES (?, ?, ?, ?, 1, 'OK', ?)`,
      [mobile, user.id, meta.ip, meta.userAgent, nowIso()],
    );

    const session = await this.createSession(user, meta);

    await this.audit.record({
      event: 'auth.login',
      actor: { userId: user.id, role: user.role, ip: meta.ip, userAgent: meta.userAgent },
      merchantUserId: user.role === 'MERCHANT' ? user.id : null,
      targetType: 'user',
      targetId: user.id,
      requestId: meta.requestId ?? null,
    });

    if (passwordNeedsRehash(user.password_hash)) {
      // Transparent upgrade: the plaintext is only available right here, so this is
      // the only moment the stored work factor can be raised.
      await run(this.db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
        await hashPassword(input.password),
        nowIso(),
        user.id,
      ]);
    }

    return { token: session.token, expiresAt: session.expiresAt, user };
  }

  async createSession(
    user: UserRow,
    meta: RequestMeta,
  ): Promise<{ token: string; expiresAt: string; sessionId: string }> {
    const token = generateSessionToken();
    const tokenHash = await hashSessionToken(token);
    const sessionId = newId('ses');

    // Admins get a much shorter session than merchants: a merchant's dashboard is
    // their own business, an admin session can move other people's money.
    const ttlHours =
      user.role === 'MERCHANT'
        ? await this.settings.int('security.session_ttl_hours')
        : await this.settings.int('security.admin_session_ttl_hours');

    const expiresAt = addMinutes(nowIso(), ttlHours * 60);
    await run(
      this.db,
      `INSERT INTO sessions (id, user_id, token_hash, ip, user_agent, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, user.id, tokenHash, meta.ip, meta.userAgent, nowIso(), nowIso(), expiresAt],
    );

    return { token, expiresAt, sessionId };
  }

  /**
   * Resolves a session token. Returns null rather than throwing, so a page can
   * render a login prompt while an API route can answer 401.
   */
  async resolveSession(token: string | null): Promise<AuthContext | null> {
    if (!token) return null;
    const tokenHash = await hashSessionToken(token);

    const row = await first<SessionRow & { user_status: string }>(
      this.db,
      `SELECT s.*, u.status AS user_status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
      [tokenHash],
    );
    if (!row) return null;
    if (isPast(row.expires_at)) return null;
    if (row.user_status !== 'ACTIVE') return null;

    const user = await first<UserRow>(this.db, 'SELECT * FROM users WHERE id = ?', [row.user_id]);
    if (!user) return null;

    // Touch last_seen at most once a minute; a write on every request would turn
    // every dashboard poll into a database write.
    const lastSeenDelta = Date.now() - new Date(row.last_seen_at).getTime();
    if (lastSeenDelta > 60_000) {
      await run(this.db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', [nowIso(), row.id]);
    }

    return { user, session: row };
  }

  async revokeSession(sessionId: string, reason: string, actor?: Partial<{ userId: string; role: string; ip: string | null; userAgent: string | null }>): Promise<void> {
    await run(
      this.db,
      'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL',
      [nowIso(), reason, sessionId],
    );
    await this.audit.record({
      event: 'auth.logout',
      actor: { userId: actor?.userId ?? null, role: actor?.role ?? null, ip: actor?.ip ?? null, userAgent: actor?.userAgent ?? null },
      targetType: 'session',
      targetId: sessionId,
      metadata: { reason },
    });
  }

  /** Logout from all devices (§5). Used after a password change and by the user. */
  async revokeAllSessions(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const result = exceptSessionId
      ? await run(
          this.db,
          'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?',
          [nowIso(), reason, userId, exceptSessionId],
        )
      : await run(
          this.db,
          'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
          [nowIso(), reason, userId],
        );

    await this.audit.record({
      event: 'auth.logout_all',
      targetType: 'user',
      targetId: userId,
      merchantUserId: userId,
      severity: 'WARNING',
      metadata: { reason, revokedCount: result.changes },
    });
    return result.changes;
  }

  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string; confirmPassword: string },
    meta: RequestMeta,
    keepSessionId?: string,
  ): Promise<void> {
    const user = await first<UserRow>(this.db, 'SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) throw new AppError('NOT_FOUND');

    const ok = await verifyPassword(input.currentPassword, user.password_hash);
    if (!ok) {
      throw new AppError('INVALID_CREDENTIALS', {
        message: 'گذرواژه فعلی نادرست است.',
        details: { field: 'currentPassword' },
      });
    }
    if (input.newPassword !== input.confirmPassword) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'گذرواژه جدید و تکرار آن یکسان نیستند.',
        details: { field: 'confirmPassword' },
      });
    }
    validatePasswordStrength(input.newPassword);

    await run(
      this.db,
      'UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
      [await hashPassword(input.newPassword), nowIso(), nowIso(), userId],
    );

    // Changing a password invalidates every other session — the standard response
    // to "someone else may have my password".
    await this.revokeAllSessions(userId, 'PASSWORD_CHANGED', keepSessionId);

    await this.audit.record({
      event: 'auth.password_changed',
      actor: { userId, role: user.role, ip: meta.ip, userAgent: meta.userAgent },
      merchantUserId: user.role === 'MERCHANT' ? userId : null,
      targetType: 'user',
      targetId: userId,
      severity: 'WARNING',
      requestId: meta.requestId ?? null,
    });
  }

  /** Admin-initiated reset. Returns a one-time temporary password. */
  async resetPassword(
    userId: string,
    actor: { userId: string; role: string; ip: string | null },
    requestId?: string,
  ): Promise<string> {
    return resetUserPassword({ db: this.db, audit: this.audit }, userId, actor, requestId);
  }

  async countActiveSessions(userId: string): Promise<number> {
    return scalar(
      this.db,
      'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?',
      [userId, nowIso()],
    );
  }

  /** Removes expired and long-revoked sessions. Called by cron. */
  async pruneSessions(): Promise<number> {
    const result = await run(
      this.db,
      `DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
      [nowIso(), addMinutes(nowIso(), -60 * 24 * 7)],
    );
    return result.changes;
  }

  async pruneLoginAttempts(): Promise<number> {
    const result = await run(this.db, 'DELETE FROM login_attempts WHERE created_at < ?', [
      addMinutes(nowIso(), -60 * 24 * 90),
    ]);
    return result.changes;
  }
}

/**
 * Admin-initiated password reset, as a standalone function.
 *
 * Extracted from AuthService because the merchant admin actions need it too, and
 * having MerchantService reach into AuthService created a dependency cycle for the
 * sake of one operation. The dependencies it actually needs — a database and an
 * audit sink — are passed explicitly.
 *
 * The generated password is returned exactly once and never stored in plaintext;
 * `must_change_password` forces the user to replace it at next login.
 */
export async function resetUserPassword(
  deps: { db: D1Database; audit: AuditService },
  userId: string,
  actor: { userId: string; role: string; ip: string | null },
  requestId?: string,
): Promise<string> {
  // 16 characters from a base64url alphabet with the punctuation removed: long
  // enough to resist guessing, short enough to be transcribed from a message.
  const temporary = randomToken(12).replace(/[^A-Za-z0-9]/g, '').slice(0, 16).padEnd(16, '7x');

  await run(
    deps.db,
    `UPDATE users SET password_hash = ?, must_change_password = 1, failed_login_count = 0,
       locked_until = NULL, updated_at = ? WHERE id = ?`,
    [await hashPassword(temporary), nowIso(), userId],
  );

  // Every existing session dies: a reset is the standard response to a suspected
  // compromise, and leaving old sessions alive would defeat it.
  await run(
    deps.db,
    'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
    [nowIso(), 'PASSWORD_RESET', userId],
  );

  await deps.audit.record({
    event: 'auth.password_reset',
    actor: { userId: actor.userId, role: actor.role, ip: actor.ip },
    merchantUserId: userId,
    targetType: 'user',
    targetId: userId,
    severity: 'CRITICAL',
    requestId: requestId ?? null,
  });

  return temporary;
}

/**
 * Password policy. Length first, because length is what actually resists offline
 * cracking; composition rules are kept minimal so they do not push users toward
 * predictable substitutions.
 */
export function validatePasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < 10) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'گذرواژه باید حداقل ۱۰ کاراکتر باشد.',
      details: { field: 'password', minLength: 10 },
    });
  }
  if (password.length > 200) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'گذرواژه بیش از حد طولانی است.',
      details: { field: 'password', maxLength: 200 },
    });
  }
  const hasLetter = /[\p{L}]/u.test(password);
  const hasDigit = /\d/.test(password);
  if (!hasLetter || !hasDigit) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'گذرواژه باید شامل حرف و رقم باشد.',
      details: { field: 'password' },
    });
  }
  const common = ['password', '12345678', 'qwerty', 'iraniran', 'admin123', '1234567890'];
  const lower = password.toLowerCase();
  if (common.some((entry) => lower.includes(entry))) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'این گذرواژه بسیار حدس‌زدنی است. گذرواژه دیگری انتخاب کنید.',
      details: { field: 'password' },
    });
  }
}
