/**
 * Service container.
 *
 * One place assembles the object graph, so no handler ever constructs a service and
 * no service reaches for a global. Two consequences that matter:
 *
 *   1. A handler cannot accidentally build a second `SettingsService` and read a
 *      settings value from a cold cache while another part of the same request reads
 *      it from a warm one. Instances are shared for the life of a request.
 *   2. Wiring is testable. Passing a different `env` or `logger` is the whole
 *      injection mechanism; there is nothing to monkey-patch.
 *
 * `resolveSecrets` is called here rather than at module load because it *throws* in
 * production when a required secret is missing — and it must throw per request, not
 * once at boot, so a misconfigured deployment fails closed on every route instead of
 * half-serving traffic from a partially initialised isolate.
 *
 * This module deliberately does not import from `app.ts`. The container takes the
 * request context it needs as a plain object, which keeps the dependency direction
 * one-way (routes → container → services) and avoids an import cycle back through the
 * app that mounts the routes.
 */

import type { Env, RuntimeConfig, ResolvedSecrets } from '../env';
import { resolveSecrets } from '../env';
import { isSecureRequest, originOf } from '../core/origin';
import type { Logger } from '../obs/logger';
import { SettingsService, settingsFor } from '../services/settings';
import { AuditService, auditFor } from '../services/audit';
import { WalletService, walletFor } from '../services/wallet';
import { CardService } from '../services/cards';
import { InvoiceService } from '../services/invoices';
import { SmsService } from '../services/sms';
import { ApiKeyService } from '../services/api-keys';
import { AuthService } from '../services/auth';
import { MerchantService } from '../services/merchants';
import { WebhookService } from '../services/webhooks';
import { NotificationService } from '../services/notifications';
import { TelegramService } from '../services/telegram';
import { TurnstileService } from '../services/turnstile';
import { RateLimiter, rateLimiterFor } from '../services/ratelimit';
import { IdempotencyService } from '../services/idempotency';

/** The subset of `AppContext` the container needs. Structural, not imported. */
export interface ServiceContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  requestId: string;
  logger: Logger;
  config: RuntimeConfig;
}

export interface Services {
  settings: SettingsService;
  audit: AuditService;
  wallet: WalletService;
  cards: CardService;
  invoices: InvoiceService;
  sms: SmsService;
  apiKeys: ApiKeyService;
  auth: AuthService;
  merchants: MerchantService;
  webhooks: WebhookService;
  notifications: NotificationService;
  telegram: TelegramService;
  turnstile: TurnstileService;
  rateLimiter: RateLimiter;
  idempotency: IdempotencyService;
  secrets: ResolvedSecrets;
}

/**
 * Per-request memo keyed by the `Request` object.
 *
 * A `WeakMap` rather than a field on the Hono context because the same `Services`
 * object is also needed by code that only has a `Request` (the queue consumer, and
 * the queue fallback path that runs inside `waitUntil`). Entries are collected with
 * the request, so nothing survives between requests.
 */
const servicesByRequest = new WeakMap<Request, Services>();

export function servicesFor(context: ServiceContext): Services {
  const cached = servicesByRequest.get(context.request);
  if (cached) return cached;

  const { env, logger, requestId, config } = context;
  // Derived from the request rather than passed in. The request is already here, so
  // there is no reason to make every caller carry the origin, and no way for one to
  // carry a different one than the host it is actually serving: a service that built
  // links for the wrong host would be a bug with no visible symptom until a customer
  // clicked a payment link and landed somewhere that does not resolve.
  const origin = originOf(context.request);
  const secure = isSecureRequest(context.request);
  const db = env.DB;
  const secrets = resolveSecrets(env);

  const settings = settingsFor(db);
  const audit = auditFor(db);
  const wallet = walletFor(db);
  const notifications = new NotificationService(db, audit);

  const telegram = new TelegramService(
    {
      botToken: secrets.telegramBotToken,
      adminChatId: secrets.telegramAdminChatId,
      enabled: secrets.telegramEnabled,
      webhookSecret: secrets.telegramWebhookSecret,
    },
    notifications,
    logger,
  );

  const cards = new CardService(db, audit, settings);
  const apiKeys = new ApiKeyService(db, secrets.apiKeyPepper, audit);
  const invoices = new InvoiceService({
    db,
    settings,
    audit,
    wallet,
    cards,
    origin,
    secure,
  });

  const services: Services = {
    settings,
    audit,
    wallet,
    cards,
    invoices,
    sms: new SmsService({ db, settings, audit, invoices, telegram, logger }),
    apiKeys,
    auth: new AuthService(db, settings, audit),
    // `apiKeys` is a dependency because approving a merchant is what issues their first
    // credential (§4); leaving that to a separate operator step allowed an approved
    // merchant with no working key.
    merchants: new MerchantService(db, audit, wallet, apiKeys),
    webhooks: new WebhookService({
      db,
      rootSecret: secrets.webhookSecret,
      audit,
      settings,
      queue: env.WEBHOOK_QUEUE ?? null,
      logger,
      // Used for the `user-agent` contact URL and to decide whether a merchant
      // endpoint must be HTTPS.
      origin,
      secure,
    }),
    notifications,
    telegram,
    // Turnstile is opt-in per environment: the `required` closure lets an operator
    // switch it on from the settings table without a redeploy, and `assert()` then
    // fails registration/payment creation closed when it is on.
    turnstile: new TurnstileService(env, () => settings.bool('platform.turnstile_required')),
    rateLimiter: rateLimiterFor(db),
    idempotency: new IdempotencyService(db),
    secrets,
  };

  // A secret placeholder in production is a misconfiguration, not a developer
  // convenience. Surfacing it once per request at warn level means it shows up in the
  // logs of the deployment that has the problem, and only there.
  if (secrets.usingDevelopmentFallbacks) {
    logger.warn('config.insecure_defaults', {
      requestId,
      environment: config.environment,
      detail: 'Session/API-key/webhook secrets fell back to development placeholders.',
    });
  }

  servicesByRequest.set(context.request, services);
  return services;
}
