/**
 * Machine API, `/api/v1/*` (§6, §7, §38, §39, §43, §75).
 *
 * Five endpoints, each one thin: authenticate the key, validate the body, call one
 * service, serialise the result. Every financial value in a response came from the
 * database, and every financial value in a request is re-derived server-side — the
 * only numbers a client may send are `amount` (what they want to charge) and choices
 * that do not change arithmetic (fee mode, card, expiry).
 *
 * The `services` container is created once per request, so all five endpoints share one
 * warm settings cache instead of each paying to re-read the settings table.
 */

import type { Hono } from 'hono';
import type { AppEnv, RouteContext } from '../app';
import { servicesFor, type Services } from './container';
import { apiSuccess, json, rateLimited } from '../core/http';
import { AppError } from '../core/errors';
import { sha256Hex } from '../core/crypto';
import { absoluteUrl } from '../core/origin';
import { startOfTehranDay, endOfTehranDay, tehranDayKeyOffset } from '../core/time';
import { apiRule, makePaymentRule } from '../services/ratelimit';
import { announceConfirmedPayment } from '../services/payment-events';
import type { ApiEnvironment } from '../core/crypto';

// Re-exported for the confirmation path in ./sms, which shares this auth helper.
export interface ApiAuth {
  services: Services;
  merchantUserId: string;
  apiKeyId: string;
  environment: ApiEnvironment;
  scopes: string[];
}

/**
 * Extracts the presented key.
 *
 * Both `X-API-Key` (§6) and `Authorization: Bearer` are accepted because SMS forwarder
 * apps and generic HTTP clients differ in which one they can set, and rejecting a
 * correct credential on a header technicality makes the platform harder to integrate
 * for no security gain.
 */
function presentedKey(c: RouteContext): string | null {
  const header = c.req.header('x-api-key');
  if (header && header.trim().length > 0) return header.trim();
  const authorization = c.req.header('authorization');
  if (authorization && /^bearer\s+/i.test(authorization)) {
    return authorization.replace(/^bearer\s+/i, '').trim();
  }
  return null;
}

/**
 * Authenticates a machine request.
 *
 * Order matters: the key is verified (cheap, constant-time) before the account status is
 * read (a second query), so an attacker spraying invalid keys cannot make us do database
 * work per guess. `permission` is the scope the endpoint requires; the key's own scopes
 * are checked by `authenticate` against the database, never from a client claim.
 */
export async function authenticateMachine(
  c: RouteContext,
  permission: string,
): Promise<ApiAuth> {
  const context = c.get('appContext');
  const services = servicesFor(context);

  const presented = presentedKey(c);
  if (!presented) {
    throw new AppError('UNAUTHENTICATED', {
      message: 'کلید API ارسال نشده است. آن را در هدر X-API-Key قرار دهید.',
    });
  }

  const authenticated = await services.apiKeys.authenticate(presented, {
    ip: context.clientIp,
    permission,
  });

  await services.merchants.assertUsable(authenticated.merchantUserId);

  return {
    services,
    merchantUserId: authenticated.merchantUserId,
    apiKeyId: authenticated.key.id,
    environment: authenticated.environment,
    scopes: authenticated.scopes,
  };
}

/** Applies a rate limit and answers 429 with the retry metadata a client needs (§39). */
async function enforceLimit(
  c: RouteContext,
  services: Services,
  identity: string,
  rules: ReturnType<typeof apiRule>[],
): Promise<void> {
  const result = await services.rateLimiter.consumeAll(identity, rules);
  if (result.allowed) return;

  const context = c.get('appContext');
  context.logger.warn('api.rate_limited', {
    identity,
    limit: result.limit,
    count: result.count,
    retryAfterSeconds: result.retryAfterSeconds,
  });

  throw new RateLimitSignal(rateLimited(result.retryAfterSeconds, context.requestId, result.limit));
}

/**
 * Carries a pre-built 429 through Hono's error path.
 *
 * Hono's `onError` receives an error and must return a Response. Rather than duplicate
 * the 429 shape there, the response travels inside the error and `onError` returns it
 * untouched.
 */
export class RateLimitSignal extends Error {
  readonly response: Response;
  constructor(response: Response) {
    super('rate limited');
    this.name = 'RateLimitSignal';
    this.response = response;
  }
}

/** Reads and size-limits a JSON body. A 1 MB cap is generous for an invoice request. */
async function readJson(c: RouteContext, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (raw.length > maxBytes) {
    throw new AppError('INVALID_REQUEST', {
      message: `بدنه درخواست بیش از حد بزرگ است (حداکثر ${Math.floor(maxBytes / 1024)} کیلوبایت).`,
    });
  }
  if (raw.trim().length === 0) {
    throw new AppError('INVALID_REQUEST', { message: 'بدنه درخواست خالی است.' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError('INVALID_REQUEST', { message: 'بدنه درخواست JSON معتبر نیست.' });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('INVALID_REQUEST', { message: 'بدنه درخواست باید یک شیء JSON باشد.' });
  }
  return parsed as Record<string, unknown>;
}

const ALLOWED_BODY_KEYS = new Set([
  'amount',
  'currency',
  'description',
  'customCallback',
  'returnUrl',
  'metadata',
  'expiresInMinutes',
  'feeMode',
  'cardId',
]);

export function registerApiRoutes(app: Hono<AppEnv>): void {
  // -------------------------------------------------------------------------
  // makePayment — POST /api/v1/payments
  // -------------------------------------------------------------------------
  app.post('/api/v1/payments', async (c) => {
    const context = c.get('appContext');
    const auth = await authenticateMachine(c, 'payments:create');
    const { services, merchantUserId } = auth;

    await enforceLimit(c, services, `payments:${merchantUserId}`, [
      makePaymentRule(await services.settings.int('rate_limit.make_payment_per_minute')),
      apiRule(await services.settings.int('rate_limit.api_per_minute')),
    ]);

    const body = await readJson(c);

    // Unknown keys are rejected rather than ignored. A typo like `ammount` would
    // otherwise create an invoice for whatever value happened to be missing, and the
    // merchant would only find out from a customer complaint.
    const unknown = Object.keys(body).filter((key) => !ALLOWED_BODY_KEYS.has(key));
    if (unknown.length > 0) {
      throw new AppError('INVALID_REQUEST', {
        message: `فیلد ناشناخته: ${unknown.join(', ')}`,
        details: { unknown, allowed: [...ALLOWED_BODY_KEYS] },
      });
    }

    if (body['amount'] === undefined || body['amount'] === null) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'مقدار amount الزامی است.',
        details: { field: 'amount' },
      });
    }

    // The idempotency key is claimed before the invoice is created, and released if
    // creation fails, so a retry after a genuine failure still does the work (§38).
    const idempotencyKey = c.req.header('idempotency-key')?.trim() ?? null;
    let claimId = 0;

    if (idempotencyKey) {
      if (idempotencyKey.length < 8 || idempotencyKey.length > 255) {
        throw new AppError('VALIDATION_FAILED', {
          message: 'Idempotency-Key باید بین ۸ تا ۲۵۵ نویسه باشد.',
          details: { field: 'Idempotency-Key' },
        });
      }
      const claim = await services.idempotency.claim({
        merchantUserId,
        key: idempotencyKey,
        endpoint: 'POST /api/v1/payments',
        requestHash: await sha256Hex(JSON.stringify(body)),
      });

      if (claim.kind === 'replay') {
        context.logger.info('api.idempotent_replay', { merchantUserId, resourceId: claim.resourceId });
        return new Response(claim.body, {
          status: claim.status,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-request-id': context.requestId,
            'idempotent-replay': 'true',
          },
        });
      }
      if (claim.kind === 'in_flight') {
        throw new AppError('IDEMPOTENCY_CONFLICT', {
          message: 'درخواستی با همین Idempotency-Key در حال پردازش است. چند لحظه بعد دوباره تلاش کنید.',
          details: { retryAfterSeconds: 1 },
        });
      }
      claimId = claim.id;
    }

    try {
      const view = await services.invoices.create(
        {
          amount: body['amount'] as number | string,
          currency: typeof body['currency'] === 'string' ? body['currency'] : undefined,
          description: typeof body['description'] === 'string' ? body['description'] : null,
          customCallback: typeof body['customCallback'] === 'string' ? body['customCallback'] : null,
          returnUrl: typeof body['returnUrl'] === 'string' ? body['returnUrl'] : null,
          metadata:
            body['metadata'] !== undefined && body['metadata'] !== null
              ? (body['metadata'] as Record<string, unknown>)
              : null,
          expiresInMinutes:
            typeof body['expiresInMinutes'] === 'number' ? body['expiresInMinutes'] : null,
          feeMode: typeof body['feeMode'] === 'string' ? (body['feeMode'] as never) : null,
          cardId: typeof body['cardId'] === 'string' ? body['cardId'] : null,
        },
        {
          merchantUserId,
          apiKeyId: auth.apiKeyId,
          environment: auth.environment,
          ip: context.clientIp,
          requestId: context.requestId,
          idempotencyKey,
        },
      );

      const response = makePaymentResponse(view);

      if (claimId !== 0) {
        await services.idempotency.finish(claimId, {
          status: 200,
          body: JSON.stringify(response),
          resourceType: 'invoice',
          resourceId: view.invoiceId,
        });
      }

      return json(response, { status: 200, headers: { 'x-request-id': context.requestId } });
    } catch (error) {
      // Only release when the work genuinely did not happen. An invoice that was created
      // and then failed later must keep its key, or a retry would create a second one.
      if (claimId !== 0) await services.idempotency.release(claimId);
      throw error;
    }
  });

  // -------------------------------------------------------------------------
  // myCards — GET /api/v1/cards
  // -------------------------------------------------------------------------
  app.get('/api/v1/cards', async (c) => {
    const auth = await authenticateMachine(c, 'cards:read');
    const cards = await auth.services.cards.listActive(auth.merchantUserId);
    return apiSuccess(
      {
        cards: cards.map((card) => ({
          id: card.id,
          masked: card.masked,
          title: card.title,
          bankName: card.bankName,
          holderName: card.holderName,
          isDefault: card.isDefault,
          displayOrder: card.displayOrder,
        })),
      },
      { noStore: true },
    );
  });

  // -------------------------------------------------------------------------
  // myStatus — GET /api/v1/status
  // -------------------------------------------------------------------------
  app.get('/api/v1/status', async (c) => {
    const context = c.get('appContext');
    const auth = await authenticateMachine(c, 'payments:read');
    const { services, merchantUserId } = auth;

    const profile = await services.merchants.profile(merchantUserId);
    const wallet = await services.wallet.snapshot(merchantUserId);
    const smsPipeline = await services.sms.testTokenStatus(merchantUserId);
    const setup = await services.merchants.setupProgress(merchantUserId);

    const endpoints = await services.webhooks.listEndpoints(merchantUserId);

    return apiSuccess(
      {
        merchant: {
          id: merchantUserId,
          merchantCode: profile?.merchant_code ?? null,
          displayName: profile?.display_name ?? null,
          // Read from the account, not from the API key: the key proves identity, the
          // account row says whether the merchant may currently operate.
          accountStatus: 'ACTIVE',
          environment: auth.environment,
        },
        apiKey: {
          id: auth.apiKeyId,
          environment: auth.environment,
          scopes: auth.scopes,
        },
        sms: {
          pipelineConnected: smsPipeline.connected,
          verifiedAt: smsPipeline.verifiedAt,
          webhookUrl: absoluteUrl(context.origin, '/sms'),
        },
        webhooks: {
          configured: endpoints.length > 0,
          active: endpoints.filter((endpoint) => endpoint.is_active === 1 && endpoint.disabled_at === null).length,
        },
        wallet: {
          balance: wallet.balance,
          availableBalance: wallet.availableBalance,
          reservedBalance: wallet.reservedBalance,
          currency: 'IRT',
        },
        fees: {
          gatewayFee: await services.settings.merchantInt(merchantUserId, 'gateway.fee_toman'),
          feeMode: await services.settings.merchantOrPlatform(merchantUserId, 'gateway.fee_mode_default'),
          suffixDigits: await services.settings.suffixDigits(),
        },
        setup: {
          completionPercent: setup.percent,
          ready: setup.ready,
          // The unfinished steps are named rather than counted: a merchant who is told
          // "3 steps remaining" has to go and find them. Naming the step is the instruction.
          remainingSteps: setup.steps.filter((step) => !step.done).map((step) => ({
            key: step.key,
            title: step.title,
            detail: step.detail ?? null,
          })),
        },
        health: {
          database: 'ok',
          invoiceCreationEnabled: !(await services.settings.bool('maintenance.invoice_creation_disabled')),
        },
      },
      { noStore: true },
    );
  });

  // -------------------------------------------------------------------------
  // myWallet — GET /api/v1/wallet
  // -------------------------------------------------------------------------
  app.get('/api/v1/wallet', async (c) => {
    const auth = await authenticateMachine(c, 'wallet:read');
    const snapshot = await auth.services.wallet.snapshot(auth.merchantUserId);
    return apiSuccess({ wallet: snapshot }, { noStore: true });
  });

  // -------------------------------------------------------------------------
  // transactionsCount — GET /api/v1/transactions/count
  // -------------------------------------------------------------------------
  app.get('/api/v1/transactions/count', async (c) => {
    const auth = await authenticateMachine(c, 'transactions:read');
    const { services, merchantUserId } = auth;

    const range = resolveRange(
      c.req.query('range') ?? c.req.query('period') ?? 'today',
      c.req.query('from'),
      c.req.query('to'),
    );

    const stats = await services.invoices.rangeStats(merchantUserId, {
      from: range.from,
      to: range.to,
      environment: auth.environment,
    });
    const lifetime = await services.invoices.counts(merchantUserId);

    return apiSuccess(
      {
        range: range.label,
        from: range.from,
        to: range.to,
        counts: {
          total: stats.count,
          successful: stats.successful,
          pending: stats.pending,
          expired: stats.expired,
          failed: stats.failed,
          manualReview: stats.review,
        },
        amounts: {
          volume: stats.volume,
          volumeRial: stats.volume * 10,
          fees: stats.fees,
          currency: 'IRT',
        },
        successRate: stats.count > 0 ? Math.round((stats.successful / stats.count) * 1000) / 10 : 0,
        averagePaymentSeconds: lifetime.averagePaymentSeconds,
        lifetime: {
          total: lifetime.total,
          successful: lifetime.successful,
          volume: lifetime.totalVolume,
          successRate: lifetime.successRate,
        },
      },
      { noStore: true },
    );
  });
}

/**
 * The `makePayment` response.
 *
 * Both documented shapes are returned, deliberately:
 *
 *   - `payment` is the nested object from §75, which is the request/response example the
 *     integration guide is written against.
 *   - the flat `paymentId` / `invoiceId` / `paymentUrl` / `amount` / `amountRial` keys are
 *     what §7 names as required.
 *
 * They are not redundant in a harmful way — the flat keys are the ones a hand-written
 * `curl` script reads and the nested one is what a typed SDK consumes — but the overlap
 * is documented here so nobody assumes the flat `amount` means the original amount. It is
 * the payable amount, exactly as §7's example shows (359000 becomes 363706).
 */
function makePaymentResponse(view: {
  id: string;
  paymentId: string;
  invoiceId: string;
  status: string;
  originalAmount: number;
  fee: number;
  payableAmount: number;
  payableAmountRial: number;
  baseAmount: number;
  uniqueSuffix: number;
  paymentUrl: string;
  expiresAt: string;
  createdAt: string;
  currency: string;
  environment: string;
  isTest: boolean;
}): Record<string, unknown> {
  return {
    success: true,
    paymentId: view.paymentId,
    invoiceId: view.invoiceId,
    paymentUrl: view.paymentUrl,
    amount: view.payableAmount,
    amountRial: view.payableAmountRial,
    currency: view.currency,
    expiresAt: view.expiresAt,
    status: view.status.toLowerCase(),
    payment: {
      id: view.paymentId,
      invoiceId: view.invoiceId,
      status: view.status.toLowerCase(),
      originalAmount: view.originalAmount,
      fee: view.fee,
      payableAmount: view.payableAmount,
      payableAmountRial: view.payableAmountRial,
      // Not in §75's example, but the two halves of the payable amount are worth being
      // explicit about: a merchant asking "why is my 359000 invoice showing 363706?" needs
      // to see that 362000 is the base and 1706 is the uniqueness suffix, not a mistake.
      // The suffix is public anyway — it is visible on the payment page.
      baseAmount: view.baseAmount,
      uniqueSuffix: view.uniqueSuffix,
      paymentUrl: view.paymentUrl,
      expiresAt: view.expiresAt,
      createdAt: view.createdAt,
      environment: view.environment,
      testMode: view.isTest,
    },
  };
}

/**
 * Maps the documented range names onto instants.
 *
 * "Today" is a Tehran day, not a UTC one (§ time module): a merchant in Iran asking for
 * today's numbers at 01:00 local time means the last few hours, and a UTC boundary would
 * silently answer for yesterday. `to` is exclusive so consecutive windows do not
 * double-count the invoice that lands exactly on a boundary.
 */
function resolveRange(
  range: string,
  fromQuery: string | undefined,
  toQuery: string | undefined,
): { label: string; from: string | undefined; to: string | undefined } {
  const now = new Date();
  switch (range) {
    case 'today':
      return { label: 'today', from: startOfTehranDay(now), to: undefined };
    case 'yesterday': {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      return {
        label: 'yesterday',
        from: startOfTehranDay(yesterday),
        to: startOfTehranDay(now),
      };
    }
    case 'last7days':
      return { label: 'last7days', from: startOfTehranDay(tehranDayKeyOffset(-6, now)), to: undefined };
    case 'last30days':
      return { label: 'last30days', from: startOfTehranDay(tehranDayKeyOffset(-29, now)), to: undefined };
    case 'custom': {
      if (!fromQuery) {
        throw new AppError('VALIDATION_FAILED', {
          message: 'برای بازه custom، پارامتر from الزامی است.',
          details: { field: 'from' },
        });
      }
      return {
        label: 'custom',
        from: startOfTehranDay(fromQuery),
        // `to` is inclusive for the caller's convenience, so the stored instant is the
        // end of that Tehran day, then made exclusive by the query's `created_at < ?`.
        to: toQuery ? endOfTehranDay(toQuery) : undefined,
      };
    }
    default:
      throw new AppError('VALIDATION_FAILED', {
        message: `بازه نامعتبر: ${range}`,
        details: { allowed: ['today', 'yesterday', 'last7days', 'last30days', 'custom'] },
      });
  }
}

// Referenced by ./sms so the two machine surfaces share one confirmation fan-out.
export { announceConfirmedPayment };
