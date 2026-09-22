/**
 * Post-confirmation fan-out (§20, §25).
 *
 * This is deliberately a separate step from `confirmPayment`, not part of it. The brief
 * is explicit that a failing callback must never reverse a successful payment, and the
 * cheapest way to guarantee that is structural: confirmation commits, and only then
 * does anyone try to tell the merchant about it. Nothing in this module can throw into
 * the confirmation path, and every failure here is contained to a log line or a delivery
 * row that the retry cron will pick up.
 *
 * Both notifications are best-effort by construction:
 *   - the webhook is *enqueued* (a delivery row plus, when available, a queue message),
 *     so its own retry schedule owns it from here;
 *   - Telegram is fire-and-forget, awaited only so the caller can report whether it
 *     succeeded, never to gate anything.
 */

import type { Logger } from '../obs/logger';
import { first } from '../db/client';
import { nowIso } from '../core/time';
import type { Toman } from '../core/money';
import type { WebhookService } from './webhooks';
import type { TelegramService } from './telegram';
import type { InvoiceRow } from './invoices';

export interface AnnounceInput {
  db: D1Database;
  webhooks: WebhookService;
  telegram: TelegramService;
  logger: Logger;
  baseUrl: string;
  invoice: InvoiceRow;
  transactionId: string | null;
  /** False when an admin confirmed by hand; the merchant's message says so. */
  automatic: boolean;
  requestId: string;
}

export interface AnnounceResult {
  deliveryId: string | null;
  webhookSkipped: boolean;
  telegramSent: boolean;
}

interface ConfirmedTransactionRow {
  id: string;
  amount: number;
  original_amount: number;
  net_amount: number;
  bank_reference: string | null;
  confirmed_at: string;
  confirmation: string;
  status: string;
}

/**
 * The merchant's verified Telegram chat, or null.
 *
 * Only a *verified* link is eligible (§25): a username typed at registration is an
 * unproven claim, and sending a merchant's payment notifications to whoever happens to
 * own that handle would leak their business. `telegram_alerts` is the merchant's own
 * switch — turning notifications off has to actually turn them off.
 */
async function telegramChatId(db: D1Database, merchantUserId: string): Promise<string | null> {
  const row = await first<{ telegram_user_id: string | null }>(
    db,
    `SELECT telegram_user_id FROM merchant_profiles
     WHERE user_id = ? AND telegram_verified = 1 AND telegram_alerts = 1
       AND telegram_user_id IS NOT NULL`,
    [merchantUserId],
  );
  return row?.telegram_user_id ?? null;
}

/**
 * Tells the merchant a payment landed.
 *
 * Returns a summary rather than throwing, because its caller (`POST /sms`) has already
 * committed the payment and must answer the SMS forwarder with a success either way.
 */
export async function announceConfirmedPayment(input: AnnounceInput): Promise<AnnounceResult> {
  const { db, invoice, logger, requestId } = input;

  const transaction = input.transactionId
    ? await first<ConfirmedTransactionRow>(
        db,
        `SELECT id, amount, original_amount, net_amount, bank_reference, confirmed_at, confirmation, status
         FROM transactions WHERE id = ?`,
        [input.transactionId],
      )
    : null;

  const paidAt = transaction?.confirmed_at ?? inboxFallback(invoice);

  // -------------------------------------------------------------------------
  // Webhook. Payload shape is §20 verbatim, because merchants write code against it.
  // -------------------------------------------------------------------------
  const payload: Record<string, unknown> = {
    event: 'payment.success',
    paymentId: invoice.payment_id,
    invoiceId: invoice.id,
    merchantId: invoice.merchant_user_id,
    status: 'paid',
    amount: invoice.payable_amount,
    originalAmount: invoice.original_amount,
    fee: invoice.customer_fee + invoice.merchant_fee,
    currency: invoice.currency,
    paidAt,
    referenceId: transaction?.bank_reference ?? null,
    metadata: safeMetadata(invoice.metadata),
  };

  let deliveryId: string | null = null;
  let webhookSkipped = true;
  try {
    const result = await input.webhooks.enqueue({
      merchantUserId: invoice.merchant_user_id,
      event: 'payment.success',
      data: payload,
      isTest: invoice.is_test === 1,
      sourceType: 'invoice',
      sourceId: invoice.id,
    });
    deliveryId = result.deliveryId;
    webhookSkipped = result.skipped;
  } catch (error) {
    // A merchant with a broken endpoint configuration must not cost us the payment
    // record. The delivery row either exists (and the retry cron owns it) or never got
    // created, in which case the merchant still sees the payment in their dashboard.
    logger.error('payment_event.webhook_enqueue_failed', {
      requestId,
      invoiceId: invoice.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // -------------------------------------------------------------------------
  // Telegram. Best effort, and skipped for test invoices: a merchant testing their
  // pipeline should not get a stream of "payment received" messages for fake money.
  // -------------------------------------------------------------------------
  let telegramSent = false;
  if (invoice.is_test !== 1) {
    try {
      const chatId = await telegramChatId(db, invoice.merchant_user_id);
      if (chatId) {
        const result = await input.telegram.notifyPaymentReceived({
          merchantUserId: invoice.merchant_user_id,
          chatId,
          payableAmount: invoice.payable_amount as Toman,
          originalAmount: invoice.original_amount as Toman,
          netAmount: (invoice.net_amount ?? invoice.original_amount) as Toman,
          invoiceId: invoice.id,
          reference: transaction?.bank_reference ?? null,
          confirmedAt: paidAt,
          baseUrl: input.baseUrl,
          automatic: input.automatic,
        });
        telegramSent = result.ok;
      }
    } catch (error) {
      logger.warn('payment_event.telegram_failed', {
        requestId,
        invoiceId: invoice.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { deliveryId, webhookSkipped, telegramSent };
}

/**
 * Fallback timestamp when the transaction row is not readable.
 *
 * `paid_at` is set by the confirmation transaction itself, so it is a truthful instant.
 * `nowIso()` is the last resort and only ever appears if a caller announces a payment
 * whose row has not been written yet, which would be a bug worth seeing in the logs.
 */
function inboxFallback(invoice: InvoiceRow): string {
  return invoice.paid_at ?? nowIso();
}

/** `metadata` is stored as JSON text; a malformed value must not break the callback. */
function safeMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
