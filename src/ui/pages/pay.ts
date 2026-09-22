/**
 * Payment page (§8, §49, §50, §51, §74).
 *
 * This is the one screen a customer sees, and it is the screen the whole platform
 * exists to serve. Everything here is arranged around a single requirement: a person
 * on a phone must transfer an exact number of Toman to an exact card, and must find
 * out immediately whether it worked.
 *
 * THE DESIGN ARGUMENT
 *
 *   The page has exactly one hero, and it is the number. Not the merchant, not the
 *   brand, not a promotional message — the amount, at 2.35rem, in tabular figures, so
 *   the digits line up into a column that can be checked against a bank screen
 *   character by character. The Rial figure sits below a dashed rule as a subordinate
 *   line, because it is a conversion aid for someone whose bank app only speaks Rial,
 *   not a second amount of equal standing (§74).
 *
 *   The signature of the success page is the bank slip: the bank's *own* message,
 *   redacted, with the matched amount marked. This is not decoration, it is the
 *   product's entire claim made visible in one object — Steve Pay works by reading
 *   your bank's SMS, so here is the SMS it read. No other payment gateway can show
 *   this, and it is the most convincing possible answer to "did it actually arrive?".
 *
 *   Colour is only ever a financial state (see theme.ts), so a customer who does not
 *   read Persian can still see amber = still waiting, green = confirmed.
 *
 * DELIBERATE RESTRAINT
 *
 *   One decorative move on the whole page: the 2px hairline across the top of the card
 *   which takes the state colour. Everything else is type, rules and whitespace. The
 *   page ships two font faces and ~3 KB of script; there is no framework, no analytics
 *   tag, no image beyond the merchant's own small logo.
 */

import { escapeHtml } from '../../core/http';
import { toPersianDigits, groupCardDigits } from '../../core/digits';
import { formatTomanFa, formatRialFa } from '../../core/money';
import { formatCountdown, epochMs } from '../../core/time';
import type { InvoiceOpenability } from '../../core/state-machine';
import type { InvoiceRow } from '../../services/invoices';
import { shell } from '../layout';

/** Content the route resolved, kept as plain data so rendering stays a pure function. */
export interface PayPageInput {
  invoice: InvoiceRow;
  merchant: {
    displayName: string | null;
    logoUrl: string | null;
    supportContact: string | null;
    supportUrl: string | null;
    merchantCode: string;
  };
  card: {
    number: string;
    holder_name: string | null;
    bank_name: string | null;
    title: string;
  } | null;
  openability: InvoiceOpenability;
  transaction: { id: string; bank_reference: string | null; confirmed_at: string } | null;
  /**
   * Redacted bank SMS that confirmed this payment (§18 keeps the raw copy for audit).
   *
   * Already redacted by the SMS service: this renderer never sees the raw bank message,
   * so no future markup change here can leak a card number or a balance.
   */
  bankMessage: string | null;
}

/**
 * The state marker. One of four, each mapping to a CSS custom property so the card's
 * top hairline, the status dot and the countdown all take the same colour without
 * three separate class lists.
 */
type Tone = 'pending' | 'success' | 'failed' | 'review';

const TONE_CLASS: Record<Tone, string> = {
  pending: 'state-pending',
  success: 'state-success',
  failed: 'state-failed',
  review: 'state-review',
};

function metric(label: string, value: string, options: { mono?: boolean; copy?: string } = {}): string {
  const button = options.copy
    ? `<button class="btn" type="button" data-copy="${escapeHtml(options.copy)}" aria-label="کپی ${escapeHtml(label)}">کپی</button>`
    : '';
  return `<div class="receipt-row">
<dt>${escapeHtml(label)}</dt>
<dd${options.mono ? ' class="mono"' : ''}>${escapeHtml(value)}${button ? ` ${button}` : ''}</dd>
</div>`;
}

/** The merchant identity block that opens every state of the page. */
function head(input: PayPageInput, fallbackTitle: string, fallbackMeta: string): string {
  const { merchant } = input;
  const name = merchant.displayName ?? 'پذیرنده';
  const logo = merchant.logoUrl
    ? `<img src="${escapeHtml(merchant.logoUrl)}" alt="">`
    : escapeHtml(name.trim().charAt(0) || 'S');
  return `<div class="pay-head">
  <div class="pay-logo" aria-hidden="true">${logo}</div>
  <div>
    <div class="pay-merchant">${escapeHtml(name)}</div>
    <div class="pay-meta">${escapeHtml(fallbackMeta)}</div>
  </div>
</div>
<h2 class="pay-label" style="margin-top:1rem">${escapeHtml(fallbackTitle)}</h2>`;
}

/**
 * The amount plate.
 *
 * Both figures are rendered from integers — the Toman amount is the stored payable
 * amount and the Rial figure is that value multiplied by ten through the money module,
 * never a float and never re-formatted from a string. The customer checks this against
 * their bank app, so it is the one place rounding must be impossible.
 */
function plate(input: PayPageInput): string {
  const { invoice } = input;
  const copyTarget = String(invoice.payable_amount);
  return `<div class="plate">
  <div class="plate-amount">
    <span class="plate-value num">${formatTomanFa(invoice.payable_amount)}</span>
    <span class="plate-unit">تومان</span>
  </div>
  <div class="plate-rial">
    <span class="num">${formatRialFa(invoice.payable_amount_rial)}</span>
    <span>ریال</span>
  </div>
  <button class="btn copy-amount" type="button" data-copy="${escapeHtml(copyTarget)}">
    کپی مبلغ دقیق
  </button>
  <p class="plate-warning" role="note">
    <span aria-hidden="true">▲</span>
    <span>مبلغ دقیق نمایش‌داده‌شده را دقیقاً به همین مقدار واریز کنید.
    واریز کمتر یا بیشتر، شناسایی خودکار پرداخت را متوقف می‌کند و پرداخت شما به بررسی دستی می‌رود.</span>
  </p>
</div>`;
}

/** The receiving card, with the copy affordance inline because that is the next action. */
function cardBlock(input: PayPageInput): string {
  if (!input.card) {
    return `<div class="alert alert-warn" role="alert">
این فاکتور کارت مقصد ندارد. برای دریافت شماره کارت با پشتیبانی پذیرنده تماس بگیرید.
</div>`;
  }
  const { card } = input;
  const grouped = groupCardDigits(card.number);
  return `<div class="card-row">
  <p class="pay-label">مبلغ را به این کارت واریز کنید</p>
  <div class="card-line">
    <span class="card-digits num">${escapeHtml(grouped)}</span>
    <button class="btn" type="button" data-copy="${escapeHtml(card.number)}" aria-label="کپی شماره کارت">کپی شماره کارت</button>
  </div>
  <div class="card-holder">
    ${card.holder_name ? `<span>به نام ${escapeHtml(card.holder_name)}</span>` : ''}
    ${card.bank_name ? `<span>·</span><span>${escapeHtml(card.bank_name)}</span>` : ''}
  </div>
</div>`;
}

function countdown(input: PayPageInput): string {
  const remaining = Math.max(0, epochMs(input.invoice.expires_at) - Date.now());
  return `<div class="countdown" data-expires-at="${escapeHtml(input.invoice.expires_at)}">
  <div>
    <div class="countdown-label">زمان باقی‌مانده برای پرداخت</div>
    <div class="countdown-value num" data-countdown>${toPersianDigits(formatCountdown(remaining))}</div>
  </div>
  <div class="countdown-label">پس از پایان این زمان، مبلغ آزاد می‌شود.</div>
</div>`;
}

function statusLine(label: string): string {
  return `<div class="pay-status"><span class="dot" aria-hidden="true"></span><span>${escapeHtml(label)}</span></div>`;
}

function note(input: PayPageInput): string {
  if (!input.invoice.customer_message) return '';
  return `<div class="pay-note">${escapeHtml(input.invoice.customer_message)}</div>`;
}

function foot(input: PayPageInput): string {
  const { merchant } = input;
  const support = merchant.supportUrl
    ? `<a href="${escapeHtml(merchant.supportUrl)}" rel="noopener noreferrer">پشتیبانی پذیرنده</a>`
    : merchant.supportContact
      ? `<span>پشتیبانی: ${escapeHtml(merchant.supportContact)}</span>`
      : '';
  return `<div class="pay-foot">
  <span class="pay-brand"><i aria-hidden="true"></i>Steve Pay</span>
  <span class="mono">${escapeHtml(input.invoice.id)}</span>
</div>
${support ? `<div class="pay-foot" style="border-top:0;padding-top:0">${support}</div>` : ''}`;
}

function testFlag(input: PayPageInput): string {
  if (!input.invoice.is_test) return '';
  return `<div class="test-flag">حالت آزمایشی — این فاکتور پول واقعی جابه‌جا نمی‌کند</div>`;
}

function wrap(input: PayPageInput, tone: Tone, body: string, title: string): string {
  return shell(
    {
      title,
      bodyClass: TONE_CLASS[tone],
      currentPath: `/pay/${input.invoice.id}`,
      // The invoice id is the capability: the page is public by design but must not
      // be indexed, or a customer's invoice would show up in search results.
      noindex: true,
    },
    `<div class="pay-wrap">
<div class="pay-card ${TONE_CLASS[tone]}" style="--state:var(--state)">
${body}
${foot(input)}
</div></div>`,
  );
}

/** A state page that is not the live payment instruction (§51). */
function terminal(
  input: PayPageInput,
  tone: Tone,
  options: { title: string; meta: string; heading: string; body: string; detail?: string },
): string {
  return wrap(
    input,
    tone,
    `${head(input, options.heading, options.meta)}
<p class="pay-desc">${escapeHtml(options.body)}</p>
${options.detail ?? ''}
${statusLine(options.title)}
${note(input)}
${testFlag(input)}`,
    `${options.heading} — Steve Pay`,
  );
}

/**
 * Renders the page for whichever state the invoice is actually in.
 *
 * The state comes from the invoice row, never from the URL or a query parameter, so a
 * crafted link cannot show a customer a "paid" page for an unpaid invoice.
 */
export function payPage(input: PayPageInput): string {
  const { invoice, openability } = input;

  switch (openability.kind) {
    // -----------------------------------------------------------------------
    // Payable: the live instruction.
    // -----------------------------------------------------------------------
    case 'PAYABLE':
      return wrap(
        input,
        'pending',
        `${head(input, 'پرداخت فاکتور', `کد پذیرنده ${input.merchant.merchantCode}`)}
${invoice.description ? `<p class="pay-desc">${escapeHtml(invoice.description)}</p>` : ''}
${plate(input)}
${cardBlock(input)}
${countdown(input)}
${note(input)}
<!-- Polls /status/:id and reloads the moment the state becomes final, so the
     customer sees confirmation without refreshing. -->
<div data-poll-url="/status/${escapeHtml(invoice.id)}" hidden></div>
${statusLine('در انتظار واریز — پس از واریز، این صفحه خودکار به‌روز می‌شود.')}
${testFlag(input)}`,
        'پرداخت فاکتور — Steve Pay',
      );

    // -----------------------------------------------------------------------
    // Paid: the receipt, with the bank's own message.
    // -----------------------------------------------------------------------
    case 'PAID': {
      const reference = input.transaction?.bank_reference ?? '—';
      const paidAt = input.transaction?.confirmed_at
        ? new Date(input.transaction.confirmed_at).toLocaleString('fa-IR')
        : null;
      const slip = input.bankMessage
        ? `<div class="slip">
  <div class="slip-head">پیامک بانک<span>خوانده‌شده توسط Steve Pay</span></div>
  <div class="slip-body">${escapeHtml(input.bankMessage)}</div>
  <div class="slip-foot">این همان پیامکی است که تأیید پرداخت را ممکن کرد. شماره کارت مبدأ برای حفاظت از حریم خصوصی پوشانده شده است.</div>
</div>`
        : '';

      return wrap(
        input,
        'success',
        `${head(input, 'پرداخت موفق', `کد پذیرنده ${input.merchant.merchantCode}`)}
<div class="plate" style="text-align:center">
  <div class="plate-amount">
    <span class="plate-value num">${formatTomanFa(invoice.payable_amount)}</span>
    <span class="plate-unit">تومان</span>
  </div>
  <p class="pay-label" style="margin:.6rem 0 0">مبلغ دریافتی</p>
</div>
${slip}
<dl class="receipt-rows" style="margin-top:1.25rem">
${metric('شناسه پرداخت', invoice.payment_id, { mono: true, copy: invoice.payment_id })}
${metric('شماره پیگیری بانک', reference, { mono: true, copy: reference === '—' ? undefined : reference })}
${metric('مبلغ', `${formatTomanFa(invoice.payable_amount)} تومان`)}
${metric('معادل ریالی', `${formatRialFa(invoice.payable_amount_rial)} ریال`)}
${metric('پذیرنده', input.merchant.displayName ?? input.merchant.merchantCode)}
${paidAt ? metric('زمان تأیید', paidAt) : ''}
</dl>
${statusLine('پرداخت تأیید شد. نیازی به اقدام دیگری نیست.')}
${note(input)}
${testFlag(input)}`,
        'پرداخت موفق — Steve Pay',
      );
    }

    // -----------------------------------------------------------------------
    // Expired, cancelled, failed, refunded.
    // -----------------------------------------------------------------------
    case 'EXPIRED':
      return terminal(input, 'failed', {
        title: 'زمان پرداخت به پایان رسید',
        meta: `کد پذیرنده ${input.merchant.merchantCode}`,
        heading: 'فاکتور منقضی شد',
        body: 'مهلت پرداخت این فاکتور به پایان رسیده است و مبلغ رزروشده آزاد شده است. اگر مبلغ را پس از انقضا واریز کرده‌اید، پرداخت شما به بررسی دستی می‌رود و به‌صورت خودکار تأیید نمی‌شود.',
        detail: `<div class="alert alert-warn" role="alert">برای پرداخت مجدد، از پذیرنده بخواهید یک فاکتور تازه بسازد. به فاکتور منقضی‌شده واریز نکنید.</div>`,
      });

    case 'CANCELLED':
      return terminal(input, 'failed', {
        title: 'فاکتور لغو شده است',
        meta: `کد پذیرنده ${input.merchant.merchantCode}`,
        heading: 'فاکتور لغو شد',
        body: 'این فاکتور توسط پذیرنده لغو شده است. به آن واریز نکنید.',
      });

    case 'FAILED':
      return terminal(input, 'failed', {
        title: 'پرداخت ناموفق بود',
        meta: `کد پذیرنده ${input.merchant.merchantCode}`,
        heading: 'پرداخت ناموفق',
        body: 'این پرداخت تأیید نشد. اگر مبلغی از حساب شما کسر شده است، با پشتیبانی پذیرنده تماس بگیرید و شناسه پرداخت زیر را اعلام کنید.',
        detail: `<dl class="receipt-rows">${metric('شناسه پرداخت', invoice.payment_id, { mono: true, copy: invoice.payment_id })}</dl>`,
      });

    case 'REFUNDED':
      return terminal(input, 'review', {
        title: 'پرداخت بازگردانده شد',
        meta: `کد پذیرنده ${input.merchant.merchantCode}`,
        heading: 'پرداخت بازگردانده شد',
        body: 'مبلغ این پرداخت بازگردانده شده است.',
        detail: `<dl class="receipt-rows">${metric('شناسه پرداخت', invoice.payment_id, { mono: true, copy: invoice.payment_id })}</dl>`,
      });

    // -----------------------------------------------------------------------
    // Money has arrived but is not yet confirmed (PAYMENT_DETECTED, CONFIRMING,
    // MANUAL_REVIEW). The page must not invite a second transfer.
    // -----------------------------------------------------------------------
    case 'REVIEW':
    default:
      return terminal(input, 'review', {
        title: 'پرداخت در حال بررسی است',
        meta: `کد پذیرنده ${input.merchant.merchantCode}`,
        heading: 'پرداخت در حال بررسی',
        body: 'واریزی شما دریافت شده و در حال تطبیق با این فاکتور است. به این کارت دوباره واریز نکنید. نتیجه به‌صورت خودکار به پذیرنده اعلام می‌شود.',
        detail: `<dl class="receipt-rows">${metric('شناسه پرداخت', invoice.payment_id, { mono: true, copy: invoice.payment_id })}${metric(
          'مبلغ مورد انتظار',
          `${formatTomanFa(invoice.payable_amount)} تومان`,
        )}</dl>`,
      });
  }
}
