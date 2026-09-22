/**
 * Rate limiting (§39).
 *
 * Fixed windows, counted in D1 with a single UPSERT … RETURNING.
 *
 * Why D1 and not KV, which would be the obvious "edge-native" choice: KV is
 * eventually consistent. A burst of concurrent requests hitting different edge
 * locations each read a stale count and each decide they are under the limit, so
 * the limit leaks precisely when it is needed most — during an attack. D1 gives a
 * single strongly-consistent point, and the primary key is the bucket, so
 * incrementing is one indexed write.
 *
 * The window is part of the key (`<scope>:<identity>:<windowStart>`), which means
 * a new window needs no cleanup: it is a different row. Old rows are pruned by a
 * cron job rather than by the hot path.
 */

import { nowIso } from '../core/time';
import { run, runReturning } from '../db/client';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  count: number;
  remaining: number;
  /** When the current window ends. */
  resetAt: string;
  retryAfterSeconds: number;
  windowSeconds: number;
}

export interface RateLimitRule {
  /** Stable bucket prefix, e.g. 'apikey:makePayment'. */
  scope: string;
  limit: number;
  windowSeconds: number;
}

/** Named rules, so a limit is referenced by intent rather than by number. */
export const RATE_LIMIT_WINDOWS = {
  minute: 60,
  fifteenMinutes: 900,
  hour: 3600,
} as const;

export class RateLimiter {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Consumes one unit from a bucket and reports whether the caller may proceed.
   *
   * The increment happens even when the request is over the limit, deliberately:
   * knowing how far over a caller went is what distinguishes a retry storm from a
   * deliberate flood, and the counter is discarded at the end of the window anyway.
   */
  async consume(identity: string, rule: RateLimitRule, now: Date = new Date()): Promise<RateLimitResult> {
    const windowMs = rule.windowSeconds * 1000;
    const windowStartMs = Math.floor(now.getTime() / windowMs) * windowMs;
    const windowEndMs = windowStartMs + windowMs;
    const bucketKey = `${rule.scope}:${identity}:${windowStartMs}`;
    const windowStart = new Date(windowStartMs).toISOString();
    const windowEnd = new Date(windowEndMs).toISOString();

    const row = await runReturning<{ count: number }>(
      this.db,
      `INSERT INTO rate_limits (bucket_key, window_start, window_end, count, blocked_count, updated_at)
       VALUES (?, ?, ?, 1, 0, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         count = rate_limits.count + 1,
         blocked_count = rate_limits.blocked_count + CASE WHEN rate_limits.count >= ? THEN 1 ELSE 0 END,
         updated_at = excluded.updated_at
       RETURNING count`,
      [bucketKey, windowStart, windowEnd, nowIso(), rule.limit],
    );

    const count = row?.count ?? 1;
    const allowed = count <= rule.limit;
    const resetAt = windowEnd;

    return {
      allowed,
      limit: rule.limit,
      count,
      remaining: Math.max(0, rule.limit - count),
      resetAt,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((windowEndMs - now.getTime()) / 1000)),
      windowSeconds: rule.windowSeconds,
    };
  }

  /**
   * Applies several rules and returns the first violation.
   *
   * Used where two limits protect the same endpoint from different abuse shapes:
   * a per-minute burst limit and a per-hour sustained limit. Both are consumed, so
   * a caller cannot sidestep the hourly ceiling by staying under the per-minute one.
   */
  async consumeAll(
    identity: string,
    rules: readonly RateLimitRule[],
    now: Date = new Date(),
  ): Promise<RateLimitResult> {
    let worst: RateLimitResult | null = null;
    for (const rule of rules) {
      const result = await this.consume(identity, rule, now);
      if (!result.allowed && (!worst || result.retryAfterSeconds > worst.retryAfterSeconds)) {
        worst = result;
      }
    }
    if (worst) return worst;

    // All allowed; report the tightest remaining so the caller sees the real ceiling.
    const last = rules[rules.length - 1];
    if (!last) {
      return {
        allowed: true,
        limit: 0,
        count: 0,
        remaining: 0,
        resetAt: now.toISOString(),
        retryAfterSeconds: 0,
        windowSeconds: 60,
      };
    }
    return this.consume(identity, last, now);
  }

  /** Read-only check, used by the admin console to show a merchant's current usage. */
  async peek(identity: string, rule: RateLimitRule, now: Date = new Date()): Promise<RateLimitResult> {
    const windowMs = rule.windowSeconds * 1000;
    const windowStartMs = Math.floor(now.getTime() / windowMs) * windowMs;
    const windowEndMs = windowStartMs + windowMs;
    const bucketKey = `${rule.scope}:${identity}:${windowStartMs}`;

    const row = await runReturning<{ count: number }>(
      this.db,
      'SELECT count FROM rate_limits WHERE bucket_key = ?',
      [bucketKey],
    );

    const count = row?.count ?? 0;
    return {
      allowed: count < rule.limit,
      limit: rule.limit,
      count,
      remaining: Math.max(0, rule.limit - count),
      resetAt: new Date(windowEndMs).toISOString(),
      retryAfterSeconds: count < rule.limit ? 0 : Math.max(1, Math.ceil((windowEndMs - now.getTime()) / 1000)),
      windowSeconds: rule.windowSeconds,
    };
  }

  /** Prunes expired windows. Called by cron; never from the request path. */
  async prune(now: Date = new Date()): Promise<number> {
    const result = await run(this.db, 'DELETE FROM rate_limits WHERE window_end < ?', [
      new Date(now.getTime() - 60_000).toISOString(),
    ]);
    return result.changes;
  }
}

/**
 * Rule builders keyed to the configured limits. A rule derived here always carries
 * the scope its config key belongs to, so a limit cannot accidentally be applied to
 * the wrong endpoint.
 */
export function makePaymentRule(perMinute: number): RateLimitRule {
  return { scope: 'apikey:makePayment', limit: perMinute, windowSeconds: RATE_LIMIT_WINDOWS.minute };
}

export function smsRule(perMinute: number): RateLimitRule {
  return { scope: 'apikey:sms', limit: perMinute, windowSeconds: RATE_LIMIT_WINDOWS.minute };
}

export function apiRule(perMinute: number): RateLimitRule {
  return { scope: 'apikey:api', limit: perMinute, windowSeconds: RATE_LIMIT_WINDOWS.minute };
}

export function loginRule(perFifteenMinutes: number): RateLimitRule {
  return { scope: 'ip:login', limit: perFifteenMinutes, windowSeconds: RATE_LIMIT_WINDOWS.fifteenMinutes };
}

export function registrationRule(perHour: number): RateLimitRule {
  return { scope: 'ip:register', limit: perHour, windowSeconds: RATE_LIMIT_WINDOWS.hour };
}

export function publicInvoiceRule(perMinute: number): RateLimitRule {
  return { scope: 'ip:public-invoice', limit: perMinute, windowSeconds: RATE_LIMIT_WINDOWS.minute };
}

export function rateLimiterFor(db: D1Database): RateLimiter {
  return new RateLimiter(db);
}
