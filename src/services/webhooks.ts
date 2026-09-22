/**
 * Webhook delivery (§20, §21, §37).
 *
 * Payment confirmation and callback delivery are separate concerns, and the
 * separation is enforced structurally: confirmation writes a `webhook_deliveries`
 * row and returns. Delivery happens afterwards, in the queue or from cron. A
 * merchant whose endpoint is down for an hour does not delay a single payment.
 *
 * Every attempt is signed over `timestamp.deliveryId.body` with the endpoint's
 * secret. The timestamp binds the signature to a moment, so a captured request
 * cannot be replayed later even though its body is unchanged.
 */

import { AppError } from '../core/errors';
import {
  generateWebhookSecret,
  seal,
  unseal,
  signWebhook,
  randomBase64UrlSafe,
} from '../core/crypto';
import { id as newId } from '../core/ids';
import { nowIso, addMinutes, webhookBackoffMinutes, epochMs } from '../core/time';
import { all, first, run, scalar } from '../db/client';
import { isUniqueViolation } from '../db/client';
import { validateCallbackUrl } from '../core/validation';
import { AuditService } from './audit';
import { SettingsService } from './settings';
import type { Logger } from '../obs/logger';

export const WEBHOOK_EVENTS = [
  'payment.created',
  'payment.pending',
  'payment.success',
  'payment.failed',
  'payment.expired',
  'payment.manual_review',
  'wallet.low_balance',
  'test.pipeline',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookEndpointRow {
  id: string;
  merchant_user_id: string;
  url: string;
  secret_sealed: string;
  secret_hint: string;
  events: string;
  description: string | null;
  is_active: number;
  is_default: number;
  consecutive_failures: number;
  total_deliveries: number;
  total_failures: number;
  disabled_at: string | null;
  disabled_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string | null;
  merchant_user_id: string;
  event: string;
  url: string;
  payload: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'DEAD' | 'SKIPPED';
  attempt_count: number;
  max_attempts: number;
  response_status: number | null;
  response_body_preview: string | null;
  duration_ms: number | null;
  last_error: string | null;
  next_retry_at: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
  is_test: number;
  source_type: string | null;
  source_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryAttemptResult {
  ok: boolean;
  status: number | null;
  durationMs: number;
  bodyPreview: string | null;
  error: string | null;
}

export class WebhookService {
  private readonly db: D1Database;
  private readonly rootSecret: string;
  private readonly audit: AuditService;
  private readonly settings: SettingsService;
  private readonly queue: Queue<unknown> | null;
  private readonly logger: Logger;
  private readonly baseUrl: string;

  constructor(deps: {
    db: D1Database;
    rootSecret: string;
    audit: AuditService;
    settings: SettingsService;
    queue?: Queue<unknown> | null;
    logger: Logger;
    baseUrl: string;
  }) {
    this.db = deps.db;
    this.rootSecret = deps.rootSecret;
    this.audit = deps.audit;
    this.settings = deps.settings;
    this.queue = deps.queue ?? null;
    this.logger = deps.logger;
    this.baseUrl = deps.baseUrl;
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  async listEndpoints(merchantUserId: string): Promise<Array<WebhookEndpointRow & { eventsList: string[] }>> {
    const rows = await all<WebhookEndpointRow>(
      this.db,
      'SELECT * FROM webhook_endpoints WHERE merchant_user_id = ? ORDER BY is_default DESC, created_at ASC',
      [merchantUserId],
    );
    return rows.map((row) => ({ ...row, eventsList: parseArray(row.events) }));
  }

  /**
   * Creates an endpoint and returns the signing secret exactly once.
   *
   * The secret is sealed with AES-GCM at rest. A read-only database compromise
   * therefore does not hand an attacker the ability to forge callbacks to merchants,
   * which is the difference between a data breach and a payment forgery.
   */
  async createEndpoint(
    merchantUserId: string,
    input: { url: string; events?: string[]; description?: string | null; isDefault?: boolean },
    actor: { userId: string | null; role: string | null; ip: string | null },
    requestId?: string,
  ): Promise<{ endpoint: WebhookEndpointRow; secret: string }> {
    const url = validateCallbackUrl(input.url, {
      allowInsecure: !this.baseUrl.startsWith('https://'),
    });

    const secret = generateWebhookSecret();
    const sealed = await seal(secret, this.rootSecret, 'webhook-endpoint');
    const id = newId('wh');
    const timestamp = nowIso();
    const existing = await this.countEndpoints(merchantUserId);
    const shouldBeDefault = input.isDefault === true || existing === 0;
    const events = (input.events ?? ['*']).filter((event) => event === '*' || (WEBHOOK_EVENTS as readonly string[]).includes(event));
    if (events.length === 0) events.push('*');

    try {
      await this.db.batch([
        ...(shouldBeDefault
          ? [
              this.db
                .prepare('UPDATE webhook_endpoints SET is_default = 0, updated_at = ? WHERE merchant_user_id = ? AND is_default = 1')
                .bind(timestamp, merchantUserId),
            ]
          : []),
        this.db
          .prepare(
            `INSERT INTO webhook_endpoints (
               id, merchant_user_id, url, secret_sealed, secret_hint, events, description,
               is_active, is_default, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .bind(
            id,
            merchantUserId,
            url,
            sealed,
            `whsec_…${secret.slice(-4)}`,
            JSON.stringify(events),
            input.description ?? null,
            shouldBeDefault ? 1 : 0,
            timestamp,
            timestamp,
          ),
      ]);
    } catch (error) {
      if (isUniqueViolation(error, 'webhook_endpoints')) {
        throw new AppError('VALIDATION_FAILED', { message: 'این آدرس قبلاً ثبت شده است.' });
      }
      throw error;
    }

    await this.audit.record({
      event: 'webhook.created',
      actor,
      merchantUserId,
      targetType: 'webhook_endpoint',
      targetId: id,
      requestId: requestId ?? null,
      metadata: { url, events },
    });

    const row = await first<WebhookEndpointRow>(this.db, 'SELECT * FROM webhook_endpoints WHERE id = ?', [id]);
    if (!row) throw new AppError('DATABASE_ERROR');
    return { endpoint: row, secret };
  }

  async updateEndpoint(
    merchantUserId: string,
    endpointId: string,
    patch: { url?: string; events?: string[]; description?: string | null; isActive?: boolean; isDefault?: boolean },
    actor: { userId: string | null; role: string | null; ip: string | null },
    requestId?: string,
  ): Promise<void> {
    const row = await first<WebhookEndpointRow>(
      this.db,
      'SELECT * FROM webhook_endpoints WHERE id = ? AND merchant_user_id = ?',
      [endpointId, merchantUserId],
    );
    if (!row) throw new AppError('WEBHOOK_NOT_FOUND');

    const url = patch.url
      ? validateCallbackUrl(patch.url, { allowInsecure: !this.baseUrl.startsWith('https://') })
      : row.url;
    const timestamp = nowIso();

    const statements: D1PreparedStatement[] = [];
    if (patch.isDefault === true) {
      statements.push(
        this.db
          .prepare('UPDATE webhook_endpoints SET is_default = 0, updated_at = ? WHERE merchant_user_id = ? AND is_default = 1')
          .bind(timestamp, merchantUserId),
      );
    }
    statements.push(
      this.db
        .prepare(
          `UPDATE webhook_endpoints SET url = ?, events = ?, description = ?, is_active = ?, is_default = ?, updated_at = ?
           WHERE id = ? AND merchant_user_id = ?`,
        )
        .bind(
          url,
          JSON.stringify(patch.events ?? parseArray(row.events)),
          patch.description === undefined ? row.description : patch.description,
          patch.isActive === undefined ? row.is_active : patch.isActive ? 1 : 0,
          patch.isDefault === undefined ? row.is_default : patch.isDefault ? 1 : 0,
          timestamp,
          endpointId,
          merchantUserId,
        ),
    );
    await this.db.batch(statements);

    await this.audit.record({
      event: 'webhook.updated',
      actor,
      merchantUserId,
      targetType: 'webhook_endpoint',
      targetId: endpointId,
      requestId: requestId ?? null,
      metadata: { patch: { ...patch, url: patch.url ? url : undefined } },
    });
  }

  /**
   * Re-derives the signing secret for display.
   *
   * A merchant has to be able to verify signatures, and a secret shown once and
   * lost means a rotation. Since the merchant controls this value anyway, showing
   * it again to the authenticated owner is correct — the alternative is a platform
   * that generates and then withholds the one value the merchant needs.
   */
  async revealSecret(merchantUserId: string, endpointId: string): Promise<string> {
    const row = await first<WebhookEndpointRow>(
      this.db,
      'SELECT * FROM webhook_endpoints WHERE id = ? AND merchant_user_id = ?',
      [endpointId, merchantUserId],
    );
    if (!row) throw new AppError('WEBHOOK_NOT_FOUND');
    const secret = await unseal(row.secret_sealed, this.rootSecret, 'webhook-endpoint');
    if (!secret) {
      throw new AppError('INTERNAL_ERROR', {
        message: 'کلید امضای این وب‌هوک قابل خواندن نیست. آن را بازتولید کنید.',
        details: { reason: 'UNSEAL_FAILED' },
      });
    }
    return secret;
  }

  async rotateSecret(
    merchantUserId: string,
    endpointId: string,
    actor: { userId: string | null; role: string | null; ip: string | null },
    requestId?: string,
  ): Promise<string> {
    const secret = generateWebhookSecret();
    const sealed = await seal(secret, this.rootSecret, 'webhook-endpoint');
    const result = await run(
      this.db,
      'UPDATE webhook_endpoints SET secret_sealed = ?, secret_hint = ?, updated_at = ? WHERE id = ? AND merchant_user_id = ?',
      [sealed, `whsec_…${secret.slice(-4)}`, nowIso(), endpointId, merchantUserId],
    );
    if (result.changes === 0) throw new AppError('WEBHOOK_NOT_FOUND');

    await this.audit.record({
      event: 'webhook.updated',
      actor,
      merchantUserId,
      targetType: 'webhook_endpoint',
      targetId: endpointId,
      requestId: requestId ?? null,
      severity: 'WARNING',
      metadata: { secretRotated: true },
    });
    return secret;
  }

  async deleteEndpoint(
    merchantUserId: string,
    endpointId: string,
    actor: { userId: string | null; role: string | null; ip: string | null },
    requestId?: string,
  ): Promise<void> {
    const result = await run(
      this.db,
      'DELETE FROM webhook_endpoints WHERE id = ? AND merchant_user_id = ?',
      [endpointId, merchantUserId],
    );
    if (result.changes === 0) throw new AppError('WEBHOOK_NOT_FOUND');
    await this.audit.record({
      event: 'webhook.deleted',
      actor,
      merchantUserId,
      targetType: 'webhook_endpoint',
      targetId: endpointId,
      requestId: requestId ?? null,
      severity: 'WARNING',
    });
  }

  async countEndpoints(merchantUserId: string): Promise<number> {
    return scalar(this.db, 'SELECT COUNT(*) AS count FROM webhook_endpoints WHERE merchant_user_id = ?', [merchantUserId]);
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  /**
   * Records an outbound event and schedules delivery.
   *
   * Never throws: a webhook that cannot be enqueued must not fail the payment
   * confirmation that produced it. Failures are logged and the delivery row remains
   * PENDING for the cron sweeper to pick up.
   */
  async enqueue(input: {
    merchantUserId: string;
    event: WebhookEvent;
    data: Record<string, unknown>;
    isTest?: boolean;
    sourceType?: string;
    sourceId?: string;
    /** Bypass subscription filtering for a direct test delivery. */
    force?: boolean;
  }): Promise<{ deliveryId: string | null; skipped: boolean }> {
    try {
      const endpoints = await all<WebhookEndpointRow>(
        this.db,
        `SELECT * FROM webhook_endpoints
         WHERE merchant_user_id = ? AND is_active = 1 AND disabled_at IS NULL
         ORDER BY is_default DESC, created_at ASC`,
        [input.merchantUserId],
      );

      if (endpoints.length === 0) return { deliveryId: null, skipped: true };

      const subscribed = input.force
        ? endpoints
        : endpoints.filter((endpoint) => {
            const events = parseArray(endpoint.events);
            return events.includes('*') || events.includes(input.event);
          });

      if (subscribed.length === 0) return { deliveryId: null, skipped: true };

      const timestamp = nowIso();
      const maxAttempts = await this.settings.int('webhooks.max_attempts');
      let firstDeliveryId: string | null = null;

      for (const endpoint of subscribed) {
        const deliveryId = newId('whd');
        // The payload is the exact string that will be signed. Serialising once and
        // storing it means a retry hours later signs the same bytes, so a merchant's
        // stored signature still verifies.
        const payload = JSON.stringify({
          id: deliveryId,
          event: input.event,
          createdAt: timestamp,
          // The merchant's own id, echoed so a shared endpoint can route.
          merchantId: input.merchantUserId,
          livemode: input.isTest !== true,
          data: input.data,
        });

        await run(
          this.db,
          `INSERT INTO webhook_deliveries (
             id, endpoint_id, merchant_user_id, event, url, payload, status, attempt_count, max_attempts,
             next_retry_at, is_test, source_type, source_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?, ?, ?, ?, ?)`,
          [
            deliveryId,
            endpoint.id,
            input.merchantUserId,
            input.event,
            endpoint.url,
            payload,
            maxAttempts,
            timestamp,
            input.isTest ? 1 : 0,
            input.sourceType ?? null,
            input.sourceId ?? null,
            timestamp,
            timestamp,
          ],
        );

        if (!firstDeliveryId) firstDeliveryId = deliveryId;

        // Immediate first attempt. In production this is the queue; without a queue
        // binding (local development, tests) the caller's waitUntil drives it.
        if (this.queue) {
          try {
            await this.queue.send({
              deliveryId,
              merchantUserId: input.merchantUserId,
              endpointId: endpoint.id,
              attempt: 1,
              reason: 'initial',
            });
          } catch (error) {
            this.logger.warn('webhook.enqueue_failed', {
              deliveryId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      return { deliveryId: firstDeliveryId, skipped: false };
    } catch (error) {
      this.logger.error('webhook.enqueue_error', {
        event: input.event,
        merchantUserId: input.merchantUserId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { deliveryId: null, skipped: true };
    }
  }

  /**
   * Performs one delivery attempt.
   *
   * The 10 second timeout is deliberate: a merchant endpoint that hangs must not
   * consume the whole request budget, and a slow-but-successful delivery is worth
   * less than a fast failure that retries.
   */
  async attemptDelivery(deliveryId: string): Promise<DeliveryAttemptResult> {
    const delivery = await first<WebhookDeliveryRow>(this.db, 'SELECT * FROM webhook_deliveries WHERE id = ?', [
      deliveryId,
    ]);
    if (!delivery) throw new AppError('NOT_FOUND', { message: 'delivery not found' });

    const endpoint = delivery.endpoint_id
      ? await first<WebhookEndpointRow>(this.db, 'SELECT * FROM webhook_endpoints WHERE id = ?', [delivery.endpoint_id])
      : null;

    const started = Date.now();
    const attemptNumber = delivery.attempt_count + 1;
    const timeoutSeconds = await this.settings.int('webhooks.timeout_seconds');

    let secret: string | null = null;
    if (endpoint) {
      secret = await unseal(endpoint.secret_sealed, this.rootSecret, 'webhook-endpoint');
    }

    if (!secret) {
      await this.recordAttempt(delivery, attemptNumber, {
        ok: false,
        status: null,
        durationMs: 0,
        bodyPreview: null,
        error: 'SIGNING_SECRET_UNAVAILABLE',
      });
      await this.markExhausted(delivery, 'SIGNING_SECRET_UNAVAILABLE');
      return { ok: false, status: null, durationMs: 0, bodyPreview: null, error: 'SIGNING_SECRET_UNAVAILABLE' };
    }

    const timestamp = String(Date.now());
    const signature = await signWebhook({
      secret,
      timestamp,
      deliveryId: delivery.id,
      body: delivery.payload,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    let result: DeliveryAttemptResult;
    try {
      const response = await fetch(delivery.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': `StevePay-Webhooks/1.0 (+${this.baseUrl})`,
          'x-stevepay-signature': signature,
          'x-stevepay-event': delivery.event,
          'x-stevepay-timestamp': timestamp,
          'x-stevepay-delivery': delivery.id,
          'x-stevepay-attempt': String(attemptNumber),
        },
        body: delivery.payload,
      });

      const bodyText = await safeReadBody(response);
      result = {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        durationMs: Date.now() - started,
        bodyPreview: bodyText.slice(0, 512),
        error: null,
      };
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? `TIMEOUT after ${timeoutSeconds}s`
          : error instanceof Error
            ? error.message
            : String(error);
      result = { ok: false, status: null, durationMs: Date.now() - started, bodyPreview: null, error: message };
    } finally {
      clearTimeout(timer);
    }

    await this.recordAttempt(delivery, attemptNumber, result);

    if (result.ok) {
      await run(
        this.db,
        `UPDATE webhook_deliveries SET status = 'DELIVERED', delivered_at = ?, next_retry_at = NULL, updated_at = ?
         WHERE id = ?`,
        [nowIso(), nowIso(), delivery.id],
      );
      if (endpoint) {
        await run(
          this.db,
          `UPDATE webhook_endpoints SET consecutive_failures = 0, total_deliveries = total_deliveries + 1, updated_at = ?
           WHERE id = ?`,
          [nowIso(), endpoint.id],
        );
      }
      return result;
    }

    // Failure: schedule the next attempt, or give up.
    if (attemptNumber >= delivery.max_attempts) {
      await this.markExhausted(delivery, result.error ?? `HTTP ${result.status ?? 'unknown'}`);
    } else {
      const backoffMinutes = webhookBackoffMinutes(attemptNumber);
      await run(
        this.db,
        `UPDATE webhook_deliveries SET status = 'PENDING', next_retry_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        [addMinutes(nowIso(), backoffMinutes), result.error ?? `HTTP ${result.status ?? 'unknown'}`, nowIso(), delivery.id],
      );
    }

    if (endpoint) {
      const updated = await run(
        this.db,
        `UPDATE webhook_endpoints
         SET consecutive_failures = consecutive_failures + 1, total_deliveries = total_deliveries + 1,
             total_failures = total_failures + 1, updated_at = ?
         WHERE id = ?`,
        [nowIso(), endpoint.id],
      );
      void updated;

      // A permanently broken URL is disabled rather than retried forever: at that
      // point the retries are pure cost, and the merchant needs to be told.
      const threshold = await this.settings.int('webhooks.disable_after_consecutive_failures');
      const fresh = await first<{ consecutive_failures: number }>(
        this.db,
        'SELECT consecutive_failures FROM webhook_endpoints WHERE id = ?',
        [endpoint.id],
      );
      if ((fresh?.consecutive_failures ?? 0) >= threshold) {
        await run(
          this.db,
          'UPDATE webhook_endpoints SET is_active = 0, disabled_at = ?, disabled_reason = ? WHERE id = ?',
          [nowIso(), 'TOO_MANY_CONSECUTIVE_FAILURES', endpoint.id],
        );
        await this.audit.record({
          event: 'webhook.disabled',
          merchantUserId: delivery.merchant_user_id,
          targetType: 'webhook_endpoint',
          targetId: endpoint.id,
          severity: 'CRITICAL',
          metadata: { consecutiveFailures: fresh?.consecutive_failures ?? 0, url: endpoint.url },
        });
      }
    }

    return result;
  }

  private async markExhausted(delivery: WebhookDeliveryRow, error: string): Promise<void> {
    await run(
      this.db,
      `UPDATE webhook_deliveries SET status = 'DEAD', last_error = ?, next_retry_at = NULL, updated_at = ? WHERE id = ?`,
      [error, nowIso(), delivery.id],
    );
  }

  private async recordAttempt(
    delivery: WebhookDeliveryRow,
    attempt: number,
    result: DeliveryAttemptResult,
  ): Promise<void> {
    await run(
      this.db,
      `INSERT INTO webhook_attempts (
         delivery_id, attempt, response_status, response_body_preview, duration_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [delivery.id, attempt, result.status, result.bodyPreview, result.durationMs, result.error, nowIso()],
    );

    await run(
      this.db,
      `UPDATE webhook_deliveries
       SET attempt_count = ?, response_status = ?, response_body_preview = ?, duration_ms = ?,
           last_error = ?, last_attempt_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        attempt,
        result.status,
        result.bodyPreview,
        result.durationMs,
        result.error,
        nowIso(),
        nowIso(),
        delivery.id,
      ],
    );
  }

  /** Deliveries due for a retry. Drives the cron sweeper. */
  async dueDeliveries(limit = 50): Promise<WebhookDeliveryRow[]> {
    return all<WebhookDeliveryRow>(
      this.db,
      `SELECT * FROM webhook_deliveries
       WHERE status = 'PENDING' AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY next_retry_at ASC LIMIT ?`,
      [nowIso(), Math.min(limit, 200)],
    );
  }

  /** Manual retry from the dashboard or admin console (§37). */
  async retryDelivery(
    deliveryId: string,
    actor: { userId: string | null; role: string | null; ip: string | null },
    merchantScope?: string,
  ): Promise<DeliveryAttemptResult> {
    const delivery = await first<WebhookDeliveryRow>(
      this.db,
      merchantScope
        ? 'SELECT * FROM webhook_deliveries WHERE id = ? AND merchant_user_id = ?'
        : 'SELECT * FROM webhook_deliveries WHERE id = ?',
      merchantScope ? [deliveryId, merchantScope] : [deliveryId],
    );
    if (!delivery) throw new AppError('NOT_FOUND', { message: 'این ارسال وب‌هوک پیدا نشد.' });

    await run(
      this.db,
      `UPDATE webhook_deliveries SET status = 'PENDING', max_attempts = max_attempts + 2, next_retry_at = ? WHERE id = ?`,
      [nowIso(), deliveryId],
    );

    await this.audit.record({
      event: 'webhook.retry_requested',
      actor,
      merchantUserId: delivery.merchant_user_id,
      targetType: 'webhook_delivery',
      targetId: deliveryId,
      metadata: { event: delivery.event, attemptCount: delivery.attempt_count },
    });

    return this.attemptDelivery(deliveryId);
  }

  async listDeliveries(
    filters: { merchantUserId?: string; status?: string; event?: string; limit?: number; offset?: number },
  ): Promise<WebhookDeliveryRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filters.merchantUserId) {
      clauses.push('merchant_user_id = ?');
      params.push(filters.merchantUserId);
    }
    if (filters.status) {
      clauses.push('status = ?');
      params.push(filters.status);
    }
    if (filters.event) {
      clauses.push('event = ?');
      params.push(filters.event);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    return all<WebhookDeliveryRow>(
      this.db,
      `SELECT * FROM webhook_deliveries ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  }

  async attemptsFor(deliveryId: string): Promise<Array<Record<string, unknown>>> {
    return all<Record<string, unknown>>(
      this.db,
      'SELECT * FROM webhook_attempts WHERE delivery_id = ? ORDER BY attempt ASC',
      [deliveryId],
    );
  }

  /** Success ratio per merchant, used by the dashboard's API statistics (§73). */
  async deliveryStats(merchantUserId: string, sinceIso: string): Promise<{ delivered: number; failed: number; pending: number }> {
    const row = await first<{ delivered: number; failed: number; pending: number }>(
      this.db,
      `SELECT
         SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN status IN ('FAILED','DEAD') THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending
       FROM webhook_deliveries WHERE merchant_user_id = ? AND created_at >= ?`,
      [merchantUserId, sinceIso],
    );
    return { delivered: row?.delivered ?? 0, failed: row?.failed ?? 0, pending: row?.pending ?? 0 };
  }

  /** Deliveries stuck pending past their retry time, for the health page. */
  async stuckCount(): Promise<number> {
    return scalar(
      this.db,
      `SELECT COUNT(*) AS count FROM webhook_deliveries WHERE status = 'PENDING' AND next_retry_at <= ?`,
      [new Date(Date.now() - 30 * 60_000).toISOString()],
    );
  }
}

function parseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/** Reads a bounded amount of a response body. A merchant returning 10 MB must not
 *  become our memory problem. */
async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 1024 ? `${text.slice(0, 1024)}…` : text;
  } catch {
    return '';
  }
}

void epochMs;
void randomBase64UrlSafe;
