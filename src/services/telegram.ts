/**
 * Telegram bot (§25, §66).
 *
 * Used for the messages a merchant actually wants on their phone: approval,
 * payment received, invoice creation failed because the wallet ran out, low
 * balance, suspicious activity, webhook failure.
 *
 * Two rules keep it from becoming noise:
 *   1. Every message goes through `NotificationService.tryClaim`, so a topic has a
 *      cooldown. The low-balance warning in particular must not fire on every
 *      invoice attempt.
 *   2. Telegram failures never propagate. A notification is a courtesy; the payment
 *      it describes has already been confirmed by the time this runs.
 *
 * The bot token is a secret; it appears in the URL path, so this module is careful
 * never to log the full request URL.
 */

import { AppError } from '../core/errors';
import { nowIso, formatJalaliDateTime } from '../core/time';
import { formatTomanFa, estimatedInvoiceCapacity, type Toman } from '../core/money';
import { toPersianDigits } from '../core/digits';
import { absoluteUrl } from '../core/origin';
import { NotificationService } from './notifications';
import type { Logger } from '../obs/logger';

export interface TelegramConfig {
  botToken: string | null;
  adminChatId: string | null;
  enabled: boolean;
  webhookSecret: string | null;
}

export interface TelegramSendResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

/**
 * True for a URL Telegram will accept as an inline button target.
 *
 * Checked rather than assumed because the origin is learned at runtime: an empty one
 * produces a path, and Telegram answers a path with a 400 that discards the message.
 */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export class TelegramService {
  private readonly config: TelegramConfig;
  private readonly notifications: NotificationService;
  private readonly logger: Logger;

  constructor(config: TelegramConfig, notifications: NotificationService, logger: Logger) {
    this.config = config;
    this.notifications = notifications;
    this.logger = logger;
  }

  get available(): boolean {
    return this.config.enabled && this.config.botToken !== null;
  }

  /**
   * Low-level send. Returns a result rather than throwing, because every caller is
   * a notification path where a failure must not surface to a merchant.
   */
  async send(chatId: string, text: string, options: { markdown?: boolean; buttonUrl?: string; buttonLabel?: string } = {}): Promise<TelegramSendResult> {
    if (!this.available || !this.config.botToken) return { ok: false, skipped: true };

    try {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      };
      if (options.markdown !== false) body['parse_mode'] = 'HTML';
      // Telegram rejects the whole message — text and all — when an inline button's URL
      // is not absolute (`BUTTON_URL_INVALID`). A job that ran before any request recorded
      // the origin therefore has to drop the button rather than lose the notification.
      if (options.buttonUrl && options.buttonLabel && isAbsoluteHttpUrl(options.buttonUrl)) {
        body['reply_markup'] = {
          inline_keyboard: [[{ text: options.buttonLabel, url: options.buttonUrl }]],
        };
      }

      const response = await fetch(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        // The token is in the URL, so only the endpoint name and status are logged.
        this.logger.warn('telegram.send_failed', { status: response.status, detail: detail.slice(0, 200) });
        return { ok: false, error: `HTTP ${response.status}` };
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('telegram.send_error', { message });
      return { ok: false, error: message };
    }
  }

  async sendToAdmin(text: string): Promise<TelegramSendResult> {
    if (!this.config.adminChatId) return { ok: false, skipped: true };
    return this.send(this.config.adminChatId, text);
  }

  /** Registers the webhook so /telegram/webhook receives updates. */
  async registerWebhook(origin: string): Promise<TelegramSendResult> {
    if (!this.available || !this.config.botToken) return { ok: false, skipped: true };
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.config.botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: absoluteUrl(origin, '/telegram/webhook'),
          secret_token: this.config.webhookSecret ?? undefined,
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: false,
        }),
      });
      return { ok: response.ok, error: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // -------------------------------------------------------------------------
  // Templates (§25). Text lives here so wording is reviewable in one place, and
  // the accounting-bearing messages compute their numbers rather than asserting
  // them.
  // -------------------------------------------------------------------------

  async notifyRegistrationSubmitted(merchantUserId: string, merchantCode: string, mobile: string, businessType: string): Promise<void> {
    await this.sendToAdmin(
      [
        '<b>درخواست ثبت‌نام تازه</b>',
        '',
        `کد پذیرنده: <code>${escapeHtml(merchantCode)}</code>`,
        `موبایل: ${toPersianDigits(mobile)}`,
        `نوع کسب‌وکار: ${escapeHtml(businessType)}`,
        `زمان: ${formatJalaliDateTime(nowIso())}`,
        '',
        'برای بررسی به پنل مدیریت مراجعه کنید.',
      ].join('\n'),
    );
    void merchantUserId;
  }

  async notifyAccountApproved(chatId: string, merchantCode: string, origin: string): Promise<TelegramSendResult> {
    return this.send(
      chatId,
      [
        '<b>حساب شما تأیید شد</b>',
        '',
        `کد پذیرنده: <code>${escapeHtml(merchantCode)}</code>`,
        '',
        'کلید API ساخته شد. برای مشاهده آن وارد پنل شوید.',
        'برای پردازش خودکار، فورواردر پیامک را در صفحه «راه‌اندازی» تنظیم کنید.',
      ].join('\n'),
      { buttonUrl: absoluteUrl(origin, '/dashboard/setup'), buttonLabel: 'تکمیل راه‌اندازی' },
    );
  }

  async notifyAccountRejected(chatId: string, reason: string | null): Promise<TelegramSendResult> {
    return this.send(
      chatId,
      [
        '<b>درخواست حساب تأیید نشد</b>',
        '',
        reason ? `دلیل: ${escapeHtml(reason)}` : 'برای اطلاعات بیشتر با پشتیبانی تماس بگیرید.',
      ].join('\n'),
    );
  }

  async notifyAccountSuspended(chatId: string, reason: string | null): Promise<TelegramSendResult> {
    return this.send(
      chatId,
      [
        '<b>حساب شما موقتاً غیرفعال شد</b>',
        '',
        reason ? `دلیل: ${escapeHtml(reason)}` : 'کلیدهای API شما باطل شده‌اند.',
        '',
        'برای رفع مشکل با پشتیبانی تماس بگیرید.',
      ].join('\n'),
    );
  }

  /**
   * Invoice creation failed because the wallet could not cover the fee (§23).
   * The required and available figures come from the caller's real numbers.
   */
  async notifyInvoiceCreationFailed(input: {
    merchantUserId: string;
    chatId: string;
    required: Toman;
    available: Toman;
    feePerInvoice: Toman;
    description?: string | null;
  }): Promise<TelegramSendResult> {
    const capacity = estimatedInvoiceCapacity(input.available, input.feePerInvoice);
    return this.send(
      input.chatId,
      [
        '❌ <b>ساخت فاکتور ناموفق بود</b>',
        '',
        input.description ? `فاکتور: ${escapeHtml(input.description)}` : null,
        'دلیل: موجودی کیف پول کافی نیست.',
        `مورد نیاز: ${formatTomanFa(input.required)} تومان`,
        `موجودی قابل استفاده: ${formatTomanFa(input.available)} تومان`,
        '',
        capacity > 0
          ? `موجودی فعلی برای حدود ${toPersianDigits(capacity)} فاکتور دیگر کافی است.`
          : 'برای ادامه باید کیف پول را شارژ کنید.',
        '',
        'کیف پول را شارژ کنید و دوباره تلاش کنید.',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    );
  }

  /**
   * Low balance warning (§24). The invoice count is computed from the live fee, so
   * it never claims "three more invoices" when the fee has changed.
   */
  async notifyLowBalance(input: {
    merchantUserId: string;
    chatId: string;
    balance: Toman;
    feePerInvoice: Toman;
    threshold: Toman;
    cooldownMinutes: number;
  }): Promise<TelegramSendResult> {
    if (input.balance >= input.threshold) return { ok: false, skipped: true };

    // Claimed before sending so a burst of invoice attempts produces exactly one
    // warning per cooldown window.
    const claim = await this.notifications.tryClaim({
      merchantUserId: input.merchantUserId,
      channel: 'TELEGRAM',
      topic: 'low_balance',
      windowMinutes: input.cooldownMinutes,
      severity: 'WARNING',
      payload: { balance: input.balance, feePerInvoice: input.feePerInvoice },
    });
    if (!claim.claimed) return { ok: false, skipped: true };

    const capacity = estimatedInvoiceCapacity(input.balance, input.feePerInvoice);
    const result = await this.send(
      input.chatId,
      [
        '⚠️ <b>موجودی کیف پول کم است</b>',
        '',
        `موجودی فعلی: ${formatTomanFa(input.balance)} تومان`,
        capacity > 0
          ? `با کارمزد فعلی، این موجودی برای حدود ${toPersianDigits(capacity)} فاکتور دیگر کافی است.`
          : 'این موجودی برای ساخت فاکتور بعدی کافی نیست.',
        '',
        'برای جلوگیری از توقف ساخت فاکتور، کیف پول را شارژ کنید.',
      ].join('\n'),
    );

    if (!result.ok) {
      await this.notifications.markClaimFailed(claim.dedupeKey, result.error ?? 'unknown');
    }
    return result;
  }

  async notifyPaymentReceived(input: {
    merchantUserId: string;
    chatId: string;
    payableAmount: Toman;
    originalAmount: Toman;
    netAmount: Toman;
    invoiceId: string;
    reference: string | null;
    confirmedAt: string;
    origin: string;
    automatic: boolean;
  }): Promise<TelegramSendResult> {
    return this.send(
      input.chatId,
      [
        '✅ <b>پرداخت تأیید شد</b>',
        '',
        `مبلغ دریافتی: ${formatTomanFa(input.payableAmount)} تومان`,
        `مبلغ فاکتور: ${formatTomanFa(input.originalAmount)} تومان`,
        `سهم شما: ${formatTomanFa(input.netAmount)} تومان`,
        input.reference ? `شماره پیگیری بانک: <code>${escapeHtml(input.reference)}</code>` : null,
        `فاکتور: <code>${escapeHtml(input.invoiceId)}</code>`,
        `زمان: ${formatJalaliDateTime(input.confirmedAt)}`,
        input.automatic ? '' : 'تأیید به‌صورت دستی انجام شده است.',
      ]
        .filter((line) => line !== null)
        .join('\n'),
      { buttonUrl: absoluteUrl(input.origin, '/dashboard/invoices'), buttonLabel: 'مشاهده فاکتورها' },
    );
  }

  async notifySuspiciousPayment(input: {
    merchantUserId: string;
    chatId: string;
    payableAmount: Toman;
    invoiceId: string;
    reasons: string[];
    origin: string;
  }): Promise<TelegramSendResult> {
    return this.send(
      input.chatId,
      [
        '🔎 <b>پرداخت نیازمند بررسی دستی است</b>',
        '',
        `مبلغ: ${formatTomanFa(input.payableAmount)} تومان`,
        `فاکتور: <code>${escapeHtml(input.invoiceId)}</code>`,
        '',
        'دلایل:',
        ...input.reasons.slice(0, 5).map((reason) => `• ${escapeHtml(reason)}`),
        '',
        'پرداخت تا بررسی شما تأیید نشده است.',
      ].join('\n'),
      { buttonUrl: absoluteUrl(input.origin, '/dashboard/payments'), buttonLabel: 'بررسی پرداخت‌ها' },
    );
  }

  async notifyWebhookDisabled(input: {
    merchantUserId: string;
    chatId: string;
    url: string;
    failures: number;
    origin: string;
  }): Promise<TelegramSendResult> {
    return this.send(
      input.chatId,
      [
        '🔌 <b>ارسال وب‌هوک قطع شد</b>',
        '',
        `آدرس: <code>${escapeHtml(input.url)}</code>`,
        `تعداد خطاهای پیاپی: ${toPersianDigits(input.failures)}`,
        '',
        'پس از رفع مشکل، وب‌هوک را دوباره فعال کنید.',
      ].join('\n'),
      { buttonUrl: absoluteUrl(input.origin, '/dashboard/webhooks'), buttonLabel: 'تنظیمات وب‌هوک' },
    );
  }

  async notifyTicketReply(input: {
    chatId: string;
    ticketNumber: number;
    subject: string;
    origin: string;
    fromAdmin: boolean;
  }): Promise<TelegramSendResult> {
    return this.send(
      input.chatId,
      [
        '💬 <b>پیام تازه در تیکت</b>',
        '',
        `تیکت ${toPersianDigits(`#${input.ticketNumber}`)}: ${escapeHtml(input.subject)}`,
        input.fromAdmin ? 'پشتیبانی پاسخ داده است.' : 'پذیرنده پاسخ داده است.',
      ].join('\n'),
      { buttonUrl: absoluteUrl(input.origin, '/dashboard/tickets'), buttonLabel: 'مشاهده تیکت' },
    );
  }

  async notifySmsTestVerified(chatId: string, token: string): Promise<TelegramSendResult> {
    return this.send(
      chatId,
      [
        '📩 <b>فورواردر پیامک متصل شد</b>',
        '',
        `توکن آزمایشی <code>${escapeHtml(token)}</code> با موفقیت دریافت شد.`,
        'از این پس واریزها به‌صورت خودکار تأیید می‌شوند.',
      ].join('\n'),
    );
  }

  async notifyAdminSecurityAlert(input: { title: string; detail: string; merchantUserId?: string | null }): Promise<void> {
    await this.sendToAdmin(
      [
        '🚨 <b>هشدار امنیتی</b>',
        '',
        `<b>${escapeHtml(input.title)}</b>`,
        escapeHtml(input.detail),
        input.merchantUserId ? `پذیرنده: <code>${escapeHtml(input.merchantUserId)}</code>` : null,
        `زمان: ${formatJalaliDateTime(nowIso())}`,
      ]
        .filter((line) => line !== null)
        .join('\n'),
    );
  }

  /** Parses a Telegram update. Only the fields the linking flow needs. */
  parseUpdate(update: unknown): { chatId: string | null; text: string | null; username: string | null; userId: string | null } {
    if (!update || typeof update !== 'object') {
      return { chatId: null, text: null, username: null, userId: null };
    }
    const message = (update as { message?: unknown }).message;
    if (!message || typeof message !== 'object') {
      return { chatId: null, text: null, username: null, userId: null };
    }
    const from = (message as { from?: unknown }).from;
    const chat = (message as { chat?: unknown }).chat;
    const fromObj = from && typeof from === 'object' ? (from as Record<string, unknown>) : {};
    const chatObj = chat && typeof chat === 'object' ? (chat as Record<string, unknown>) : {};
    const id = fromObj['id'] ?? chatObj['id'];
    return {
      chatId: id !== undefined ? String(id) : null,
      userId: fromObj['id'] !== undefined ? String(fromObj['id']) : null,
      username: typeof fromObj['username'] === 'string' ? (fromObj['username'] as string) : null,
      text: typeof (message as { text?: unknown }).text === 'string' ? ((message as { text: string }).text) : null,
    };
  }

  /**
   * Verifies the secret Telegram echoes on every webhook call, so a request to
   * /telegram/webhook cannot be forged by anyone who learns the URL (§21).
   */
  verifyWebhookRequest(headerSecret: string | undefined): boolean {
    const expected = this.config.webhookSecret;
    if (!expected) {
      // Unconfigured secret means the endpoint must refuse, not accept.
      throw new AppError('FORBIDDEN', { message: 'وب‌هوک تلگرام پیکربندی نشده است.' });
    }
    if (!headerSecret || headerSecret !== expected) {
      throw new AppError('FORBIDDEN', { message: 'امضای درخواست تلگرام معتبر نیست.' });
    }
    return true;
  }
}

/**
 * Telegram uses HTML parse mode, so any merchant-supplied text interpolated into a
 * message must be escaped or a company name containing `<` silently breaks the
 * message — or worse, injects markup.
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
