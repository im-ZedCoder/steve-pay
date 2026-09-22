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
import { serverErrorPage } from './ui/pages/errors';

/**
 * Route modules.
 *
 * Mounted here in the order a request is most likely to need them:
 *
 *   ./routes/public    /, /pay/:invoiceId, /pay/:invoiceId/success, /status/:invoiceId
 *   ./routes/auth      /register, /login, /logout
 *   ./routes/api       /api/v1/payments, /cards, /status, /wallet, /transactions/count
 *   ./routes/sms       POST /sms
 *
 * Not yet mounted, and named so the gap is visible rather than surprising:
 *
 *   ./routes/merchant  /dashboard/*      (services and UI components exist)
 *   ./routes/telegram  /telegram/webhook (TelegramService.registerWebhook exists)
 *   ./routes/docs      /docs/api         (documentation, not yet written)
 *
 * Mounted, listed above: ./routes/admin serves /admin/* — merchant approval and the
 * manual-review queue both live there, and both are load-bearing.
 */

import { registerPublicRoutes } from './routes/public';
import { registerAuthRoutes } from './routes/auth';
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
 * Every non-production response omits HSTS.
 *
 * `Strict-Transport-Security` on a `localhost` or `*.workers.dev` origin is not merely
 * useless, it is harmful: a browser that has seen it refuses plain-HTTP requests to that
 * host for two years, which breaks local development in a way that is very hard to
 * diagnose. `securityHeaders` defaults it on, so it is switched off explicitly here.
 */
function hstsFor(config: RuntimeConfig): boolean {
  return config.isProduction;
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
      });
    }
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
    for (const [key, value] of Object.entries(securityHeaders({ hsts: hstsFor(context.config) }))) {
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
  registerApiRoutes(app);
  registerSmsRoutes(app);
  registerAdminRoutes(app);

  return app;
}
