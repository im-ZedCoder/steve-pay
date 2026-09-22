/**
 * Webhook delivery queue consumer (§2).
 *
 * Webhook delivery is the one operation in the system that talks to a
 * merchant-controlled endpoint, and therefore the one operation whose latency we do
 * not control. Isolating it in a consumer means a merchant's 10-second timeout
 * costs a queue slot, not a payment confirmation.
 *
 * A message is acknowledged when the attempt produced a definitive answer
 * (delivered, or failed with a retry already scheduled). It is retried by the queue
 * only for *our* failures — a database error writing the attempt log, for example.
 * Application-level delivery failures are handled by the delivery row's own
 * backoff schedule, not by the queue's retry, so the two retry systems do not
 * multiply each other.
 */

import { createLogger } from '../obs/logger';
import { AuditService } from '../services/audit';
import { SettingsService } from '../services/settings';
import { WebhookService } from '../services/webhooks';
import { resolveConfig, resolveSecrets, type Env, type WebhookQueueMessage } from '../env';

export async function handleWebhookBatch(
  batch: MessageBatch<WebhookQueueMessage>,
  env: Env,
  logger = createLogger({ base: { surface: 'queue' } }),
): Promise<void> {
  const config = resolveConfig(env);
  const secrets = resolveSecrets(env);
  const audit = new AuditService(env.DB);
  const settings = new SettingsService(env.DB);

  const webhooks = new WebhookService({
    db: env.DB,
    rootSecret: secrets.webhookSecret,
    audit,
    settings,
    // The consumer must not re-enqueue; it delivers.
    queue: null,
    logger,
    baseUrl: config.baseUrl,
  });

  for (const message of batch.messages) {
    const { deliveryId, attempt } = message.body ?? { deliveryId: '', attempt: 0 };
    if (!deliveryId) {
      message.ack();
      continue;
    }

    try {
      const result = await webhooks.attemptDelivery(deliveryId);

      logger.info('webhook.attempt', {
        deliveryId,
        attempt,
        ok: result.ok,
        status: result.status,
        durationMs: result.durationMs,
      });

      // The delivery row already knows whether to retry; acknowledge either way.
      message.ack();
    } catch (error) {
      // An infrastructure failure (database unavailable, secret unreadable). Let the
      // queue's own retry handle it, with the dead-letter queue as the backstop.
      logger.error('webhook.attempt_failed', {
        deliveryId,
        attempt,
        message: error instanceof Error ? error.message : String(error),
      });
      message.retry({ delaySeconds: Math.min(60 * attempt + 30, 600) });
    }
  }
}
