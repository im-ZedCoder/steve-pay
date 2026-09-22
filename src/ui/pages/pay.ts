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
 *   The page answers three questions, in the order they are asked — where do I send it,
 *   how much, and how long have I got — and the arrangement is that order made visible:
 *   a header that states the outcome, a step bar that states how far the payment has
 *   actually got, then three numbered sections. Numbering is justified here and only here,
 *   because this genuinely is a sequence the reader performs in order.
 *
 *   Both amounts are copy targets in full. The thing to tap is the thing being read, not a
 *   small chip beside it, because a customer who has just read a number on a phone is one
 *   thumb away from a chip they will miss. Under the Toman figure the same integer is
 *   rendered in Persian words: both realistic failures here are digit failures — dropping a
 *   zero, or reading ۳۲۴٬۵۵۵ as ۳۲۴٬۵۵۰ — and a second rendering catches both. Persian bank
 *   slips are written this way for the same reason.
 *
 *   The step bar can only ever report facts. A step lights when the row behind it exists in
 *   the database, so it cannot claim progress the platform does not have. A progress
 *   indicator on a payment page that flatters is worse than no progress indicator, and the
 *   reference implementation for this layout carried a comment about exactly that mistake.
 *
 *   Colour is only ever a financial state (see theme.ts), so a customer who does not read
 *   Persian can still see amber = still waiting, green = confirmed, rose = over. It is
 *   declared once, as a pair of custom properties per state, so a PAID page and a FAILED page
 *   cannot be drawn the same way.
 *
 * DELIBERATE RESTRAINT
 *
 *   The signature of the success page is the bank slip: the bank's *own* message, redacted,
 *   with the matched amount marked. This is not decoration, it is the product's entire claim
 *   made visible in one object — Steve Pay works by reading your bank's SMS, so here is the
 *   SMS it read. No other payment gateway can show this, and it is the most convincing
 *   possible answer to "did it actually arrive?".
 *
 *   The page ships two Persian weights, the display face, one mono face and one small script.
 *   There is no framework, no analytics tag, no image beyond the merchant's own small logo.
 */

import { escapeHtml } from '../../core/http';
import { toPersianDigits, groupCardDigits } from '../../core/digits';
import { formatTomanFa, formatRialFa, tomanInWords } from '../../core/money';
import { formatCountdown, epochMs, formatJalaliDateTime } from '../../core/time';
import type { InvoiceOpenability } from '../../core/state-machine';
import type { InvoiceRow } from '../../services/invoices';
import { shell } from '../layout';
import { bankCardFace } from '../bank-card';

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
 * The state marker. One of four, each mapping to a pair of CSS custom properties so the
 * status pill, the status dot and the deadline all take the same colour without three
 * separate class lists.
 */
type Tone = 'pending' | 'success' | 'failed' | 'review';

const TONE_CLASS: Record<Tone, string> = {
  pending: 'state-pending',
  success: 'state-success',
  failed: 'state-failed',
  review: 'state-review',
};

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** A labelled value, as a definition row. */
function factRow(
  label: string,
  value: string,
  options: { mono?: boolean; copy?: string } = {},
): string {
  const button = options.copy
    ? ` <button class="btn" type="button" data-copy="${escapeHtml(options.copy)}" aria-label="کپی ${escapeHtml(label)}">کپی</button>`
    : '';
  return `<div class="pay-fact">
  <dt>${escapeHtml(label)}</dt>
  <dd${options.mono ? ' class="mono"' : ''}>${escapeHtml(value)}${button}</dd>
</div>`;
}

/** The recipient, the bank's own warning, and the two actions every state offers. */
function brandMark(): string {
  return `<div class="pay-brandmark">
  <span class="brand-tile" aria-hidden="true">S</span>
  <div>
    <b>Steve Pay</b>
    <span>درگاه پرداخت کارت‌به‌کارت با تأیید خودکار</span>
  </div>
</div>`;
}

/**
 * The page's headline answer.
 *
 * The dot pulses only while the answer can still change. Once the payment is settled the
 * animation stops, because a thing that is still moving reads as a thing still happening.
 */
function statePill(label: string, live: boolean): string {
  return `<span class="pay-statepill"${live ? ' data-live="1"' : ''}>
  <i aria-hidden="true"></i>${escapeHtml(label)}
</span>`;
}

interface Step {
  title: string;
  hint: string;
  state: 'done' | 'active' | 'idle';
}

/**
 * The step bar, derived from the state the invoice is actually in.
 *
 * Three steps, because three is how many things happen: the invoice is created, the money is
 * transferred, the payment is confirmed. `moneyArrived` and `confirmed` are the only two
 * facts that can be true, and neither is guessed from the URL.
 */
function stepsFor(kind: InvoiceOpenability['kind']): Step[] {
  const moneyArrived = kind === 'PAID' || kind === 'REVIEW';
  const confirmed = kind === 'PAID';
  return [
    { title: 'فاکتور ساخته شد', hint: 'مبلغ رزرو شد', state: 'done' },
    {
      title: 'واریز به کارت مقصد',
      hint: 'به همان مبلغی که زیر آمده',
      state: moneyArrived ? 'done' : kind === 'PAYABLE' ? 'active' : 'idle',
    },
    {
      title: 'خواندن پیامک و تأیید',
      hint: 'بدون نیاز به تأیید دستی',
      state: confirmed ? 'done' : kind === 'REVIEW' ? 'active' : 'idle',
    },
  ];
}

function stepBar(steps: Step[]): string {
  return `<ol class="pay-steps" aria-label="مراحل پرداخت">${steps
    .map(
      (step, index) => `<li class="pay-step" data-state="${step.state}">
  <span class="pay-step-num" aria-hidden="true">${
    step.state === 'done'
      ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
      : toPersianDigits(index + 1)
  }</span>
  <span class="pay-step-text">
    <b>${escapeHtml(step.title)}</b><span>${escapeHtml(step.hint)}</span>
  </span>
</li>`,
    )
    .join('')}</ol>`;
}

function sectionHead(number: number, title: string, hint: string): string {
  return `<div class="pay-sec-head">
  <h2><span class="pay-num" aria-hidden="true">${toPersianDigits(number)}</span>${escapeHtml(title)}</h2>
  <span class="pay-sec-hint">${escapeHtml(hint)}</span>
</div>`;
}

function divider(): string {
  return '<hr class="pay-divider">';
}

// ---------------------------------------------------------------------------
// The instructions
// ---------------------------------------------------------------------------

/**
 * The amount, as two copy targets.
 *
 * The whole card is the button, and the copy affordance inside it is a span — a button
 * inside a button is invalid, and the client script swaps the text of the element marked
 * `data-copy-label` rather than the card's, which is what keeps the number on screen after
 * it has been copied.
 */
function amountBlock(input: PayPageInput): string {
  const { invoice } = input;
  const words = tomanInWords(invoice.payable_amount);

  return `<section class="pay-sec">
${sectionHead(2, 'مبلغ دقیق واریز', 'روی هر مبلغ بزنید تا کپی شود')}
<button class="amount-card" type="button" data-copy="${escapeHtml(String(invoice.payable_amount))}"
  aria-label="کپی مبلغ ${escapeHtml(formatTomanFa(invoice.payable_amount))} تومان">
  <span class="amount-card-head">
    <span class="amount-card-label">مبلغ واریزی (تومان)</span>
    <span class="copy-pill" data-copy-label>کپی مبلغ</span>
  </span>
  <span class="amount-card-value">
    <b>${formatTomanFa(invoice.payable_amount)}</b><span>تومان</span>
  </span>
  ${words ? `<span class="amount-words">${escapeHtml(words)} تومان</span>` : ''}
</button>
<button class="amount-card amount-card-sub" type="button"
  data-copy="${escapeHtml(String(invoice.payable_amount_rial))}"
  aria-label="کپی معادل ریالی">
  <span class="amount-card-head">
    <span class="amount-card-label">همان مبلغ به ریال</span>
    <span class="copy-pill" data-copy-label>کپی مبلغ</span>
  </span>
  <span class="amount-card-value">
    <b>${formatRialFa(invoice.payable_amount_rial)}</b><span>ریال</span>
  </span>
</button>
<p class="amount-warn" role="note">
  <span aria-hidden="true">▲</span>
  <span><b>مبلغ دقیق نمایش‌داده‌شده را دقیقاً به همین مقدار واریز کنید.</b>
  واریز کمتر یا بیشتر، شناسایی خودکار پرداخت را متوقف می‌کند و پرداخت شما به بررسی دستی می‌رود.</span>
</p>
</section>`;
}

/** The receiving card, as one tap target. */
function cardBlock(input: PayPageInput): string {
  if (!input.card) {
    return `<section class="pay-sec">
${sectionHead(1, 'کارت مقصد', '')}
<div class="alert alert-warn" role="alert">
این فاکتور کارت مقصد ندارد. برای دریافت شماره کارت با پشتیبانی پذیرنده تماس بگیرید.
</div>
</section>`;
  }
  const { card } = input;
  // The face is drawn by the shared renderer, so this page and the merchant's panel show the
  // same card. The bank's own colours come from the card number's prefix; nothing here
  // announces that, because the colours are the announcement.
  const face = bankCardFace({
    number: card.number,
    bankName: card.bank_name,
    title: card.title,
    holderName: card.holder_name,
    interactive: true,
    copy: {
      value: card.number,
      ariaLabel: `کپی شماره کارت ${groupCardDigits(card.number)}`,
    },
    footer: '<span class="copy-pill" data-copy-label>کپی شماره کارت</span>',
  });

  return `<section class="pay-sec">
${sectionHead(1, 'کارت مقصد', 'روی کارت بزنید تا شماره کپی شود')}
<div class="card-slot">${face}</div>
</section>`;
}

/**
 * The deadline.
 *
 * The figure is rendered server-side from the stored expiry so it is correct before any
 * script runs, and the fill is rendered from the fraction of the window still left — so a
 * page opened with two minutes remaining shows a bar that is nearly gone, not a full one
 * waiting to jump.
 */
function timerBlock(input: PayPageInput): string {
  const { invoice } = input;
  const expiresAt = epochMs(invoice.expires_at);
  const remaining = Math.max(0, expiresAt - Date.now());
  const total = Math.max(1, expiresAt - epochMs(invoice.created_at));
  const percent = Math.max(0, Math.min(100, (remaining / total) * 100));
  const tone = remaining < 120_000 ? 'urgent' : remaining < 300_000 ? 'soon' : 'ok';

  return `<section class="pay-sec">
${sectionHead(3, 'زمان باقی‌مانده', '')}
<div class="timer" data-expires-at="${escapeHtml(invoice.expires_at)}" data-total-ms="${total}"
  data-tone="${tone}">
  <div class="timer-head">
    <span class="timer-label"><i aria-hidden="true"></i>مهلت پرداخت این فاکتور</span>
    <span class="timer-value" data-countdown>${toPersianDigits(formatCountdown(remaining))}</span>
  </div>
  <div class="timer-track"><span class="timer-fill" data-timer-fill
    style="width:${percent.toFixed(2)}%"></span></div>
  <p class="timer-msg">${
    tone === 'urgent'
      ? 'کمتر از ۲ دقیقه مانده — هرچه سریع‌تر واریز کنید'
      : 'کمتر از ۵ دقیقه مانده — مبلغ را دقیق واریز کنید'
  }</p>
</div>
<p class="pay-live"><i aria-hidden="true"></i>این صفحه هر چند ثانیه خودکار بررسی می‌شود — نیازی به رفرش نیست</p>
<div class="pay-actions">
  <a class="btn" href="/pay/${escapeHtml(invoice.id)}">بررسی دوباره وضعیت</a>
  ${
    invoice.return_url
      ? `<a class="btn btn-primary" href="${escapeHtml(invoice.return_url)}" rel="noopener noreferrer">بازگشت به فروشگاه</a>`
      : ''
  }
</div>
</section>`;
}

function note(input: PayPageInput): string {
  if (!input.invoice.customer_message) return '';
  return `<div class="pay-note">${escapeHtml(input.invoice.customer_message)}</div>`;
}

function testFlag(input: PayPageInput): string {
  if (!input.invoice.is_test) return '';
  return `<div class="test-flag">حالت آزمایشی — این فاکتور پول واقعی جابه‌جا نمی‌کند</div>`;
}

// ---------------------------------------------------------------------------
// The aside
// ---------------------------------------------------------------------------

/**
 * The second column: what is behind the form, plus a way to reach a human.
 *
 * Nothing here repeats the main column. The reference implementation for this layout says
 * the same about its own aside, and it is the rule that keeps a two-column page from being
 * one column printed twice.
 */
function aside(input: PayPageInput, kind: InvoiceOpenability['kind']): string {
  const { merchant, invoice } = input;

  const facts = [
    factRow('پذیرنده', merchant.displayName ?? 'پذیرنده'),
    ...(merchant.displayName ? [factRow('کد پذیرنده', merchant.merchantCode, { mono: true })] : []),
    factRow('شناسه فاکتور', invoice.id, { mono: true, copy: invoice.id }),
    ...(kind === 'PAYABLE'
      ? [factRow('مهلت پرداخت', formatJalaliDateTime(invoice.expires_at))]
      : kind === 'PAID' && input.transaction
        ? [
            factRow('معادل ریالی', formatRialFa(invoice.payable_amount_rial)),
            factRow('زمان تأیید', formatJalaliDateTime(input.transaction.confirmed_at)),
          ]
        : []),
  ].join('');

  // The guide is instructions, so it is only shown while there are instructions to follow.
  const guide =
    kind === 'PAYABLE'
      ? `<section class="pay-side-card">
<h2>پرداخت در سه گام</h2>
<ol class="pay-guide">
  <li><b aria-hidden="true">۱</b><span>مبلغ را از همین صفحه کپی کنید و به کارت مقصد واریز کنید.</span></li>
  <li><b aria-hidden="true">۲</b><span>پیامک واریز که بانک برایتان می‌فرستد، توسط Steve Pay خوانده می‌شود.</span></li>
  <li><b aria-hidden="true">۳</b><span>این صفحه خودکار تأیید می‌شود؛ نیازی به فرستادن رسید نیست.</span></li>
</ol>
</section>`
      : '';

  const support = merchant.supportUrl
    ? `<a href="${escapeHtml(merchant.supportUrl)}" rel="noopener noreferrer">پشتیبانی پذیرنده</a>`
    : merchant.supportContact
      ? `<span>پشتیبانی: ${escapeHtml(merchant.supportContact)}</span>`
      : '';

  return `<aside class="pay-side">
<section class="pay-side-card">
<h2>اطلاعات پرداخت</h2>
<dl class="pay-facts">${facts}</dl>
</section>
${guide}
<section class="pay-side-card">
<h2>نکته امنیتی</h2>
<p class="pay-note-sm">
شماره کارت و مبلغ را از همین صفحه کپی کنید تا جابه‌جا نشوند.
<b>Steve Pay شماره کارت شما را ذخیره نمی‌کند</b>؛ برای تأیید، فقط پیامک واریز بانک خوانده می‌شود.
${support ? `<br>${support}` : ''}
</p>
</section>
</aside>`;
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

interface Frame {
  title: string;
  /** The headline state, in the pill. */
  stateLabel: string;
  /** Whether the answer can still change, which is what makes the pill's dot pulse. */
  live: boolean;
  body: string;
}

function page(input: PayPageInput, tone: Tone, frame: Frame): string {
  const { invoice, openability } = input;

  return shell(
    {
      title: frame.title,
      bodyClass: TONE_CLASS[tone],
      currentPath: `/pay/${invoice.id}`,
      // The invoice id is the capability: the page is public by design but must not
      // be indexed, or a customer's invoice would show up in search results.
      noindex: true,
    },
    `<div class="pay-shell ${TONE_CLASS[tone]}">
<div class="pay-bg" aria-hidden="true"></div>
<header class="pay-top">
${brandMark()}
${statePill(frame.stateLabel, frame.live)}
</header>
${stepBar(stepsFor(openability.kind))}
<div class="pay-grid">
<div class="pay-main">
${frame.body}
</div>
${aside(input, openability.kind)}
</div>
</div>${
      // Polls /status/:id and reloads the moment the state becomes final, so the customer
      // sees confirmation without refreshing.
      openability.kind === 'PAYABLE'
        ? `<div data-poll-url="/status/${escapeHtml(invoice.id)}" hidden></div>`
        : ''
    }`,
  );
}

/** A state that is not the live payment instruction (§51). */
function terminal(
  input: PayPageInput,
  tone: Tone,
  options: { stateLabel: string; heading: string; body: string; detail?: string },
): string {
  return page(input, tone, {
    title: `${options.heading} — Steve Pay`,
    stateLabel: options.stateLabel,
    live: false,
    body: `<p class="pay-desc">${escapeHtml(options.body)}</p>
${options.detail ?? ''}
${note(input)}
${testFlag(input)}`,
  });
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
      return page(input, 'pending', {
        title: 'پرداخت فاکتور — Steve Pay',
        stateLabel: 'در انتظار واریز',
        live: true,
        body: `${
          invoice.description
            ? `<p class="pay-desc" style="margin:0 0 .2rem">${escapeHtml(invoice.description)}</p>`
            : ''
        }
${cardBlock(input)}
${divider()}
${amountBlock(input)}
${divider()}
${timerBlock(input)}
${note(input)}
${testFlag(input)}`,
      });

    // -----------------------------------------------------------------------
    // Paid: the receipt, with the bank's own message.
    // -----------------------------------------------------------------------
    case 'PAID': {
      const reference = input.transaction?.bank_reference ?? null;
      const slip = input.bankMessage
        ? `<div class="slip">
  <div class="slip-head">پیامک بانک<span>خوانده‌شده توسط Steve Pay</span></div>
  <div class="slip-body">${escapeHtml(input.bankMessage)}</div>
  <div class="slip-foot">این همان پیامکی است که تأیید پرداخت را ممکن کرد. شماره کارت مبدأ برای حفاظت از حریم خصوصی پوشانده شده است.</div>
</div>`
        : '';

      return page(input, 'success', {
        title: 'پرداخت موفق — Steve Pay',
        stateLabel: 'پرداخت تأیید شد',
        live: false,
        body: `<div class="pay-sec" style="text-align:center">
  <div class="amount-card-value" style="justify-content:center">
    <b>${formatTomanFa(invoice.payable_amount)}</b><span>تومان</span>
  </div>
  <p class="pay-label" style="margin:.5rem 0 0">مبلغ دریافتی</p>
</div>
${slip}
<dl class="receipt-rows" style="margin-top:1.25rem">
${factRow('شناسه پرداخت', invoice.payment_id, { mono: true, copy: invoice.payment_id })}
${
  reference
    ? factRow('شماره پیگیری بانک', reference, { mono: true, copy: reference })
    : ''
}
${factRow('مبلغ', `${formatTomanFa(invoice.payable_amount)} تومان`)}
${factRow('معادل ریالی', `${formatRialFa(invoice.payable_amount_rial)} ریال`)}
${factRow('پذیرنده', input.merchant.displayName ?? input.merchant.merchantCode)}
${note(input)}
${testFlag(input)}`,
      });
    }

    // -----------------------------------------------------------------------
    // Expired, cancelled, failed, refunded.
    // -----------------------------------------------------------------------
    case 'EXPIRED':
      return terminal(input, 'failed', {
        stateLabel: 'مهلت پرداخت تمام شد',
        heading: 'فاکتور منقضی شد',
        body: 'مهلت پرداخت این فاکتور به پایان رسیده است و مبلغ رزروشده آزاد شده است. اگر مبلغ را پس از انقضا واریز کرده‌اید، پرداخت شما به بررسی دستی می‌رود و به‌صورت خودکار تأیید نمی‌شود.',
        detail: `<div class="alert alert-warn" role="alert">برای پرداخت مجدد، از پذیرنده بخواهید یک فاکتور تازه بسازد. به فاکتور منقضی‌شده واریز نکنید.</div>`,
      });

    case 'CANCELLED':
      return terminal(input, 'failed', {
        stateLabel: 'فاکتور لغو شد',
        heading: 'فاکتور لغو شد',
        body: 'این فاکتور توسط پذیرنده لغو شده است. به آن واریز نکنید.',
      });

    case 'FAILED':
      return terminal(input, 'failed', {
        stateLabel: 'پرداخت ناموفق',
        heading: 'پرداخت ناموفق',
        body: 'این پرداخت تأیید نشد. اگر مبلغی از حساب شما کسر شده است، با پشتیبانی پذیرنده تماس بگیرید و شناسه پرداخت زیر را اعلام کنید.',
        detail: `<dl class="receipt-rows">${factRow('شناسه پرداخت', invoice.payment_id, { mono: true, copy: invoice.payment_id })}</dl>`,
      });

    case 'REFUNDED':
      return terminal(input, 'review', {
        stateLabel: 'پرداخت بازگردانده شد',
        heading: 'پرداخت بازگردانده شد',
        body: 'مبلغ این پرداخت بازگردانده شده است.',
        detail: `<dl class="receipt-rows">${factRow('شناسه پرداخت', invoice.payment_id, { mono: true, copy: invoice.payment_id })}</dl>`,
      });

    // -----------------------------------------------------------------------
    // Money has arrived but is not yet confirmed (PAYMENT_DETECTED, CONFIRMING,
    // MANUAL_REVIEW). The page must not invite a second transfer.
    // -----------------------------------------------------------------------
    case 'REVIEW':
    default:
      return terminal(input, 'review', {
        stateLabel: 'در حال بررسی',
        heading: 'پرداخت در حال بررسی',
        body: 'واریزی شما دریافت شده و در حال تطبیق با این فاکتور است. به این کارت دوباره واریز نکنید. نتیجه به‌صورت خودکار به پذیرنده اعلام می‌شود.',
        detail: `<dl class="receipt-rows">${factRow('شناسه پرداخت', invoice.payment_id, { mono: true, copy: invoice.payment_id })}${factRow(
          'مبلغ مورد انتظار',
          `${formatTomanFa(invoice.payable_amount)} تومان`,
        )}</dl>`,
      });
  }
}
