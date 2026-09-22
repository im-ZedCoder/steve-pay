/**
 * HTTP application.
 *
 * One Hono app serving four audiences on one origin:
 *   - public pages          /, /register, /login, /pay/:id, /status/:id, /docs/api
 *   - merchant dashboard    /dashboard/*
 *   - admin console         /admin/*
 *   - machine API           /api/v1/*, /sms, /telegram/webhook
 *
 * Routing is thin: a handler resolves a session, validates input, calls exactly one
 * service, and renders. No business logic lives here or in any mounted handler
 * (§71).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { resolveConfig, clientIp, type Env, type RuntimeConfig } from './env';
import { createLogger, type Logger } from './obs/logger';
import { apiFailure, html, json, securityHeaders } from './core/http';
import { AppError, isAppError } from './core/errors';
import { requestId as newRequestId } from './core/ids';
import { isSecureRequest, originOf, rememberOrigin } from './core/origin';
import { serverErrorPage } from './ui/pages/errors';

/**
 * Route modules.
 *
 * Mounted here in the order a request is most likely to need them:
 *
 *   ./routes/public     /, /docs, /pay/:invoiceId, /status/:invoiceId, /robots.txt
 *   ./routes/auth       /register, /login, /logout
 *   ./routes/dashboard  /dashboard/*   (merchant console)
 *   ./routes/admin      /admin/*       (operator console)
 *   ./routes/api        /api/v1/payments, /cards, /status, /wallet, /transactions/count
 *   ./routes/sms        POST /sms
 *
 * Not yet mounted, named so the gap stays visible rather than surprising:
 *
 *   ./routes/telegram   /telegram/webhook (TelegramService.registerWebhook exists)
 *
 * The two consoles are both load-bearing, in different directions: approving a merchant
 * is the only path out of `PENDING_APPROVAL`, and deciding a `MANUAL_REVIEW` payment is
 * the only path out of that state — while the dashboard is the only way a merchant can
 * register a receiving card, which is a precondition for creating an invoice at all.
 */

import { registerPublicRoutes } from './routes/public';
import { registerAuthRoutes } from './routes/auth';
import { registerDashboardRoutes } from './routes/dashboard';
import { registerApiRoutes } from './routes/api';
import { registerSmsRoutes } from './routes/sms';
import { registerAdminRoutes } from './routes/admin';
import { RateLimitSignal } from './routes/api';

/** Everything a handler needs about the request it is serving. */
export interface AppContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  requestId: string;
  logger: Logger;
  config: RuntimeConfig;
  clientIp: string | null;
  /**
   * Scheme and host the visitor actually used, e.g. `https://pay.example.com`.
   *
   * This is the only place an absolute URL comes from. Nothing is configured, so a
   * deployment answers correctly on its first request — before anyone has set a
   * hostname, or if the hostname later changes.
   */
  origin: string;
  /**
   * True when this request arrived over TLS.
   *
   * Separate from `config.isProduction` because it answers a different question, and
   * the two disagree in exactly the case that breaks login: a deployment labelled
   * production but reached over plain HTTP.
   */
  secure: boolean;
}

export interface Variables {
  appContext: AppContext;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
export type RouteContext = Context<AppEnv>;

/**
 * Per-request runtime context.
 *
 * The Worker entry owns the ExecutionContext and the real logger; Hono does not
 * hand either to middleware. Rather than allocate a new Hono instance per request
 * (which would also throw away the compiled router), the entry stashes its context
 * here keyed by the Request object and the middleware picks it up. A WeakMap means
 * the entry is collected with the request and nothing leaks between them.
 */
export const runtimeContext = new WeakMap<
  Request,
  { ctx: ExecutionContext; logger: Logger; requestId: string; config: RuntimeConfig }
>();

function isMachineRoute(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname === '/sms' || pathname.startsWith('/telegram/');
}

/**
 * `Strict-Transport-Security` is sent only over TLS, and only in production.
 *
 * Two independent reasons, and both have to hold. On plain HTTP the header is ignored
 * by browsers, so sending it is noise. And an HSTS header seen on a `localhost` or
 * preview origin is actively harmful: the browser refuses plain-HTTP requests to that
 * host for two years, which breaks local development in a way that is very hard to
 * diagnose — so a development deployment never sends it even when it is reached over
 * HTTPS. `securityHeaders` never sends it on its own; it is switched on explicitly here,
 * from the two facts this middleware is the only one able to see.
 */
function hstsFor(context: { config: RuntimeConfig; secure: boolean }): boolean {
  return context.config.isProduction && context.secure;
}

/**
 * Builds the app. The Worker entry attaches a real ExecutionContext and logger
 * after construction; when the app is invoked directly (tests, or a call from
 * another Worker) these fallbacks keep it working instead of throwing on a
 * missing context.
 */
export function createApp(appContext?: Partial<AppContext>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    if (!c.get('appContext')) {
      const existing = appContext ?? {};
      const runtime = runtimeContext.get(c.req.raw);
      const requestId =
        runtime?.requestId ?? existing.requestId ?? c.req.header('x-request-id') ?? newRequestId();
      // Read from the request rather than taken from an injected partial context:
      // these two are properties of the connection, and one derived from anything but
      // the connection is a value that looks right and is wrong.
      const origin = originOf(c.req.raw);
      c.set('appContext', {
        request: c.req.raw,
        env: c.env,
        ctx:
          runtime?.ctx ??
          existing.ctx ??
          ({ waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext),
        requestId,
        logger: runtime?.logger ?? existing.logger ?? createLogger({ base: { requestId } }),
        config: runtime?.config ?? existing.config ?? resolveConfig(c.env),
        clientIp: clientIp(c.req.raw),
        origin,
        secure: isSecureRequest(c.req.raw),
      });
    }

    // Record the host for the jobs that run without a request. Deliberately before
    // `next()` and not awaited: the KV write is bookkeeping for a background sweep,
    // and the page must not pay a round trip for it.
    if (c.env.CACHE) rememberOrigin(c.env.CACHE, c.get('appContext').origin);

    await next();
  });

  // Belt and braces on headers: a handler that built its own Response still gets
  // the full policy, so a forgotten header on one route cannot open a hole (§40).
  app.use('*', async (c, next) => {
    await next();
    const response = c.res;
    if (!(response instanceof Response)) return;
    const headers = new Headers(response.headers);
    const context = c.get('appContext');
    for (const [key, value] of Object.entries(securityHeaders({ hsts: hstsFor(context) }))) {
      if (!headers.has(key)) headers.set(key, value);
    }
    if (!headers.has('x-request-id')) headers.set('x-request-id', context.requestId);
    c.res = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });

  // ---------------------------------------------------------------------------
  // Health. Unauthenticated on purpose: an uptime monitor and the admin health
  // page both poll it, and it must not depend on any secret being present.
  // ---------------------------------------------------------------------------
  app.get('/health', async (c) => {
    const context = c.get('appContext');
    const started = Date.now();
    let database: 'ok' | 'error' = 'ok';
    let databaseError: string | null = null;

    try {
      await c.env.DB.prepare('SELECT 1 AS ok').first();
    } catch (error) {
      database = 'error';
      databaseError = error instanceof Error ? error.message : String(error);
      context.logger.error('health.database_failed', { message: databaseError });
    }

    return json(
      {
        status: database === 'ok' ? 'ok' : 'degraded',
        environment: context.config.environment,
        requestId: context.requestId,
        checks: {
          database: { status: database, latencyMs: Date.now() - started, error: databaseError },
        },
        time: new Date().toISOString(),
      },
      { status: database === 'ok' ? 200 : 503, noStore: true },
    );
  });


  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    if (isMachineRoute(path)) {
      return apiFailure(
        new AppError('NOT_FOUND', { message: `مسیر ${path} وجود ندارد.` }),
        c.get('appContext')?.requestId ?? 'unknown',
      );
    }
    return html(serverErrorPage({ title: 'صفحه پیدا نشد', message: 'این آدرس روی Steve Pay وجود ندارد.', status: 404 }), {
      status: 404,
      noStore: true,
    });
  });

  app.onError((error, c) => {
    const context = c.get('appContext');
    const requestId = context?.requestId ?? 'unknown';
    const path = new URL(c.req.url).pathname;

    // A rate limit is a decision, not a failure, and it already carries a fully-formed
    // 429 with its Retry-After. Returning it here keeps the 429 shape in one place
    // (`rateLimited`) instead of duplicated in the error handler.
    if (error instanceof RateLimitSignal) return error.response;

    if (isAppError(error)) {
      // An AppError is a deliberate outcome, not a defect: log it at warn without
      // a stack, so the error log stays signal.
      context?.logger.warn('route.failed', { code: error.code, status: error.status, path });
    } else {
      context?.logger.error('route.unhandled', {
        path,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.split('\n').slice(0, 10).join('\n') : undefined,
      });
    }

    if (isMachineRoute(path)) return apiFailure(error, requestId);

    const publicMessage = isAppError(error) && error.public ? error.message : 'خطای غیرمنتظره در سرور رخ داد.';
    return html(
      serverErrorPage({
        title: publicMessage,
        message: 'اگر این خطا تکرار شد، شناسه زیر را برای پشتیبانی بفرستید.',
        status: isAppError(error) ? error.status : 500,
        requestId,
      }),
      { status: isAppError(error) ? error.status : 500, noStore: true },
    );
  });

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------
  registerPublicRoutes(app);
  registerAuthRoutes(app);
  registerDashboardRoutes(app);
  registerApiRoutes(app);
  registerSmsRoutes(app);
  registerAdminRoutes(app);

  return app;
}
