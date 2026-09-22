/**
 * SMS intake, `POST /sms` (§14, §15, §18, §19).
 *
 * The endpoint a merchant's SMS forwarder app calls for every bank message. It is the
 * only write path into the matching engine, and it is authenticated exactly like the
 * machine API — a merchant may only forward messages that concern their own account.
 *
 * DEFENCE ORDER, and why it is this order:
 *
 *   1. IP allowlist (if configured)  — reject before touching the database at all
 *   2. rate limit by IP              — a forwarder stuck in a retry loop hits this
 *   3. API key                       — prove who it is
 *   4. account status                — prove they may still operate
 *   5. rate limit by merchant        — per-merchant ceiling, now that we know who they are
 *   6. body validation               — shape, size, required field
 *   7. ingest                        — parse, match, risk, confirm
 *
 * Cheap rejections first, database work last, and the two rate limits are at different
 * points on purpose: the IP limit stops an unauthenticated flood, the merchant limit
 * cannot run until identity is known and catches a compromised key used from many IPs.
 *
 * What this endpoint deliberately does NOT do: trust anything in the payload about the
 * invoice, the amount owed, or whether a payment happened. The message text is evidence
 * to be parsed, not a claim to be believed (§40).
 */

import type { Hono } from 'hono';
import type { AppEnv, RouteContext } from '../app';
import { servicesFor } from './container';
import { json, rateLimited } from '../core/http';
import { AppError } from '../core/errors';
import { parseIpAllowlist, ipMatchesAllowlist } from '../env';
import { smsRule, apiRule } from '../services/ratelimit';
import { announceConfirmedPayment } from '../services/payment-events';
import { authenticateMachine, RateLimitSignal } from './api';

/** Body cap. A bank SMS is under 1 KB; 16 KB leaves room for metadata and stops abuse. */
const MAX_BODY_BYTES = 16 * 1024;

export function registerSmsRoutes(app: Hono<AppEnv>): void {
  app.post('/sms', async (c) => {
    const context = c.get('appContext');
    const services = servicesFor(context);

    // 1. Optional IP allowlist (§21). Empty list means "not configured", not "deny all".
    const allowlist = parseIpAllowlist(context.env.SMS_IP_ALLOWLIST);
    if (allowlist.length > 0 && !ipMatchesAllowlist(context.clientIp, allowlist)) {
      context.logger.warn('sms.ip_not_allowed', { ip: context.clientIp });
      throw new AppError('IP_NOT_ALLOWED', { details: { ip: context.clientIp } });
    }

    // 2. IP-scoped limit, before authentication.
    const perMinute = await services.settings.int('rate_limit.sms_per_minute');
    const ipLimit = await services.rateLimiter.consume(`sms:ip:${context.clientIp ?? 'unknown'}`, smsRule(perMinute));
    if (!ipLimit.allowed) {
      context.logger.warn('sms.rate_limited_ip', {
        ip: context.clientIp,
        count: ipLimit.count,
        limit: ipLimit.limit,
      });
      throw new RateLimitSignal(rateLimited(ipLimit.retryAfterSeconds, context.requestId, ipLimit.limit));
    }

    // 3 & 4. API key, then account status.
    const auth = await authenticateMachine(c, 'sms:write');

    // 5. Per-merchant ceiling.
    const merchantLimit = await services.rateLimiter.consumeAll(`sms:merchant:${auth.merchantUserId}`, [
      smsRule(perMinute),
      apiRule(await services.settings.int('rate_limit.api_per_minute')),
    ]);
    if (!merchantLimit.allowed) {
      context.logger.warn('sms.rate_limited_merchant', {
        merchantUserId: auth.merchantUserId,
        count: merchantLimit.count,
        limit: merchantLimit.limit,
      });
      throw new RateLimitSignal(
        rateLimited(merchantLimit.retryAfterSeconds, context.requestId, merchantLimit.limit),
      );
    }

    // 6. Body.
    const payload = await readSmsBody(c);

    // 7. Ingest. Everything after this point is inside the service layer: parsing,
    // duplicate detection, matching, risk scoring and, when the rules pass, confirmation.
    const result = await services.sms.ingest({
      merchantUserId: auth.merchantUserId,
      apiKeyId: auth.apiKeyId,
      message: payload.message,
      sender: payload.sender,
      deviceId: payload.deviceId,
      clientReceivedAt: payload.receivedAt,
      sourceIp: context.clientIp,
      requestId: context.requestId,
      environment: auth.environment,
    });

    // Telling the merchant about a confirmed payment is deliberately outside the
    // confirmation itself (§20). It runs after the commit and cannot fail the request:
    // the forwarder must get a 200 for a payment that was genuinely recorded, whether
    // or not the merchant's callback endpoint is reachable.
    if (result.outcome === 'CONFIRMED' && result.invoiceId) {
      const invoice = await services.invoices.getById(result.invoiceId);
      if (invoice) {
        await announceConfirmedPayment({
          db: context.env.DB,
          webhooks: services.webhooks,
          telegram: services.telegram,
          logger: context.logger,
          baseUrl: context.config.baseUrl,
          invoice,
          transactionId: result.transactionId,
          automatic: true,
          requestId: context.requestId,
        });
      }
    }

    // A forwarder treats any non-2xx as "not delivered" and retries. Outcomes that mean
    // "we will never use this message" (a wrong invoice, an unparseable body, a test
    // token, a duplicate) are therefore 200s with a status field: retrying cannot change
    // the answer, and a retry storm against a bank SMS queue is worse than a silent no-op.
    const accepted = result.outcome !== 'UNPARSEABLE';

    return json(
      {
        success: accepted,
        // The outcome vocabulary is the contract the forwarder and the dashboard both
        // read, so it is returned verbatim rather than mapped to a boolean.
        outcome: result.outcome,
        requestId: context.requestId,
        smsMessageId: result.smsMessageId,
        invoiceId: result.invoiceId,
        transactionId: result.transactionId,
        detail: result.detail,
        parse: result.parse
          ? {
              parser: result.parse.parser,
              bank: result.parse.bank,
              confidence: result.parse.confidence,
              amountToman: result.parse.amountToman,
              reference: result.parse.reference,
              warnings: result.parse.warnings,
            }
          : null,
        // The reference number is echoed so a merchant debugging a mismatch can see what
        // we read, without exposing the raw bank message back over the wire.
        reference: result.parse?.reference ?? null,
      },
      {
        status: accepted ? 200 : 202,
        noStore: true,
        headers: { 'x-request-id': context.requestId },
      },
    );
  });
}

interface SmsBody {
  message: string;
  sender: string | null;
  deviceId: string | null;
  receivedAt: string | null;
}

async function readSmsBody(c: RouteContext): Promise<SmsBody> {
  const raw = await c.req.text();

  if (raw.length > MAX_BODY_BYTES) {
    throw new AppError('SMS_TOO_LARGE', {
      message: `بدنه درخواست بیش از حد بزرگ است (حداکثر ${Math.floor(MAX_BODY_BYTES / 1024)} کیلوبایت).`,
    });
  }
  if (raw.trim().length === 0) {
    throw new AppError('SMS_INVALID_PAYLOAD', { message: 'بدنه درخواست خالی است.' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError('SMS_INVALID_PAYLOAD', { message: 'بدنه درخواست JSON معتبر نیست.' });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('SMS_INVALID_PAYLOAD', { message: 'بدنه درخواست باید یک شیء JSON باشد.' });
  }

  const body = parsed as Record<string, unknown>;
  const message = body['message'];

  if (typeof message !== 'string') {
    throw new AppError('SMS_INVALID_PAYLOAD', {
      message: 'فیلد message الزامی است و باید متن پیامک باشد.',
      details: { field: 'message' },
    });
  }
  if (message.trim().length === 0) {
    throw new AppError('SMS_INVALID_PAYLOAD', {
      message: 'متن پیامک خالی است.',
      details: { field: 'message' },
    });
  }

  // The claimed timestamp is stored but never trusted for matching: it is the
  // forwarder's clock, and a phone with a wrong clock would otherwise be able to place a
  // payment inside the matching window. The service compares against server time.
  const receivedAt = typeof body['receivedAt'] === 'string' ? body['receivedAt'] : null;

  return {
    message,
    sender: typeof body['sender'] === 'string' ? body['sender'].slice(0, 64) : null,
    deviceId: typeof body['deviceId'] === 'string' ? body['deviceId'].slice(0, 128) : null,
    receivedAt: receivedAt && !Number.isNaN(Date.parse(receivedAt)) ? receivedAt : null,
  };
}
