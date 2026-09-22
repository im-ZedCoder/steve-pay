/**
 * Worker entry point.
 *
 * Three surfaces on one Worker:
 *   - fetch      HTTP: public pages, merchant and admin dashboards, the v1 API,
 *                the /sms ingestion webhook and the Telegram webhook.
 *   - queue      asynchronous webhook delivery, so a merchant's slow endpoint never
 *                delays a payment confirmation.
 *   - scheduled  cron: expiry, retries, rollups, cleanup, low-balance sweeps.
 *
 * All three funnel into the same service layer; none of them contain business
 * logic. The router is built once per isolate and the per-request context is passed
 * through a WeakMap, so a warm isolate does not rebuild the route table.
 */

import { AppError, isAppError } from './core/errors';
import { apiFailure, html, HSTS_VALUE } from './core/http';
import { requestId as newRequestId } from './core/ids';
import { createLogger } from './obs/logger';
import { resolveConfig, type Env, type WebhookQueueMessage } from './env';
import { isSecureRequest } from './core/origin';
import { createApp, runtimeContext } from './app';
import { serverErrorPage } from './ui/pages/errors';
import { handleWebhookBatch } from './queue/handler';
import { runScheduled } from './cron';

const app = createApp();

function isMachineRoute(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname === '/sms' || pathname.startsWith('/telegram/');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = request.headers.get('x-request-id') ?? newRequestId();
    const config = resolveConfig(env);
    const logger = createLogger({
      level: config.isProduction ? 'info' : 'debug',
      base: {
        requestId,
        environment: config.environment,
        method: request.method,
        path: new URL(request.url).pathname,
      },
    });

    runtimeContext.set(request, { ctx, logger, requestId, config });
    const started = Date.now();

    try {
      const response = await app.fetch(request, env, ctx);
      // Every response carries the request id, so a merchant can quote one value and
      // have it line up with the logs and the audit trail (§44).
      if (!response.headers.has('x-request-id')) {
        const headers = new Headers(response.headers);
        headers.set('x-request-id', requestId);
        logger.info('request.completed', { status: response.status, durationMs: Date.now() - started });
        return new Response(response.body, { status: response.status, headers });
      }
      logger.info('request.completed', { status: response.status, durationMs: Date.now() - started });
      return response;
    } catch (error) {
      logger.error('request.failed', {
        durationMs: Date.now() - started,
        code: isAppError(error) ? error.code : 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });

      if (isMachineRoute(new URL(request.url).pathname)) return apiFailure(error, requestId);

      const publicMessage =
        isAppError(error) && error.public ? error.message : 'خطای غیرمنتظره در سرور رخ داد.';
      // This path builds a response without going through the app's middleware, so it is the
      // one place that has to decide HSTS for itself — and the same rule applies: only when
      // the request arrived over TLS, and only in production.
      const hsts = config.isProduction && isSecureRequest(request);
      return html(
        serverErrorPage({
          title: publicMessage,
          message: 'اگر این خطا ادامه داشت، شناسه زیر را برای پشتیبانی بفرستید.',
          status: isAppError(error) ? error.status : 500,
          requestId,
        }),
        {
          status: isAppError(error) ? error.status : 500,
          noStore: true,
          ...(hsts ? { headers: { 'strict-transport-security': HSTS_VALUE } } : {}),
        },
      );
    }
  },

  async queue(batch: MessageBatch<WebhookQueueMessage>, env: Env): Promise<void> {
    const logger = createLogger({
      level: 'info',
      base: { surface: 'queue', batchSize: batch.messages.length },
    });
    await handleWebhookBatch(batch, env, logger);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const logger = createLogger({
      level: 'info',
      base: { surface: 'cron', cron: controller.cron, scheduledTime: controller.scheduledTime },
    });
    await runScheduled({ cron: controller.cron, env, ctx, logger });
  },
} satisfies ExportedHandler<Env, WebhookQueueMessage>;

// Re-exported so tests and tooling can construct the same error shapes the Worker
// produces without importing the entry point.
export { AppError };
