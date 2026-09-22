/**
 * Cloudflare Turnstile (§2, §40).
 *
 * Protects the two unauthenticated, abusable surfaces: registration and public
 * invoice pages. Bot signups are cheap to produce and expensive to review, and a
 * public invoice page is a free URL for anyone wanting to hammer our database.
 *
 * The posture is fail-closed and explicit: if a deployment turns the requirement on
 * but has not configured the secret, verification fails rather than silently
 * passing. A protection that disables itself when misconfigured is worse than no
 * protection, because nobody goes looking for the hole.
 */

import { AppError } from '../core/errors';
import { AppError as _unused } from '../core/errors';
import type { Env } from '../env';

const VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileResult {
  success: boolean;
  errorCodes: string[];
  skipped: boolean;
}

export class TurnstileService {
  private readonly secret: string | null;
  private readonly required: () => Promise<boolean>;
  private readonly isProduction: boolean;

  constructor(env: Env, required: () => Promise<boolean>) {
    this.secret = env.TURNSTILE_SECRET && env.TURNSTILE_SECRET.length > 0 ? env.TURNSTILE_SECRET : null;
    this.required = required;
    this.isProduction = (env.ENVIRONMENT ?? 'development') === 'production';
  }

  /**
   * Verifies a token from the client.
   *
   * `remoteIp` is optional but recommended: it lets Turnstile correlate the
   * challenge with the request origin.
   */
  async verify(token: string | null | undefined, remoteIp: string | null): Promise<TurnstileResult> {
    const required = await this.required();

    if (!required) return { success: true, errorCodes: [], skipped: true };

    if (!this.secret) {
      // Required but unconfigured. In production this is a hard failure; in
      // development it degrades to a skip so the wizard remains usable offline.
      if (this.isProduction) {
        console.error(
          JSON.stringify({
            level: 'critical',
            scope: 'turnstile',
            message: 'Turnstile is required but TURNSTILE_SECRET is not configured',
          }),
        );
        return { success: false, errorCodes: ['missing-secret'], skipped: false };
      }
      return { success: true, errorCodes: ['missing-secret-dev'], skipped: true };
    }

    if (!token || token.length === 0) {
      return { success: false, errorCodes: ['missing-input-response'], skipped: false };
    }

    const body = new URLSearchParams();
    body.set('secret', this.secret);
    body.set('response', token);
    if (remoteIp) body.set('remoteip', remoteIp);

    try {
      const response = await fetch(VERIFY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });

      if (!response.ok) {
        // A 5xx from the challenge service is not evidence that the visitor is a
        // bot. Fail open here rather than locking every visitor out of paying,
        // because the cost of a false rejection on a payment page is a lost sale.
        return { success: true, errorCodes: [`upstream-${response.status}`], skipped: true };
      }

      const payload = (await response.json()) as { success?: boolean; 'error-codes'?: string[] };
      return {
        success: payload.success === true,
        errorCodes: payload['error-codes'] ?? [],
        skipped: false,
      };
    } catch {
      return { success: true, errorCodes: ['network-error'], skipped: true };
    }
  }

  /** Throws the merchant-visible error when a challenge fails. */
  async assert(token: string | null | undefined, remoteIp: string | null): Promise<void> {
    const result = await this.verify(token, remoteIp);
    if (!result.success) {
      throw new AppError('TURNSTILE_FAILED', { details: { errorCodes: result.errorCodes } });
    }
  }
}

void _unused;
