/**
 * Merchant dashboard (§27, §32, §34, §35, §38).
 *
 * The console a merchant opens to answer four questions: did my money arrive, where is
 * my account stuck, what do I hand a developer, and how do I change something. Each
 * page here exists for one of those, and nothing is on a page that does not serve it.
 *
 * Rules, matching the operator console's discipline:
 *
 *   1. **No state change without an audit entry.** Every mutation goes through a service
 *      method that writes its own record. There is no direct SQL in this file except for
 *      reads that no service exposes yet.
 *
 *   2. **Ownership is checked before anything else.** A card id or invoice id from the
 *      request is resolved *for this merchant*; a miss is a 404, never a 403, because a
 *      403 would confirm that the id exists for somebody else.
 *
 *   3. **A secret is revealed in a response body, never in a redirect.** `?key=sk_live_…`
 *      would land a live credential in the access log, the browser history and the next
 *      request's `Referer`. The reveal is rendered, so it happens exactly once and leaves
 *      no trace behind it.
 *
 *   4. **Nothing from a request body becomes a status.** A form names an action, the action
 *      is looked up in a closed table, and only then does it reach a service.
 */

import type { Hono } from 'hono';
import type { AppEnv, RouteContext } from '../app';
import { escapeHtml, html, redirect } from '../core/http';
import { toPersianDigits } from '../core/digits';
import { formatCountdown, formatJalaliDateTime, formatRelativeFa } from '../core/time';
import { formatTomanFa, parseTomanInput } from '../core/money';
import {
  isPayable,
  statusLabelFa,
  type InvoiceStatus,
  type StatusFilter,
} from '../core/state-machine';
import { AppError, isAppError } from '../core/errors';
import { CSRF_FIELD } from '../core/csrf';
import { absoluteUrl } from '../core/origin';
import { bankCardFace } from '../ui/bank-card';
import { first } from '../db/client';
import {
  csrfForGet,
  messageFor,
  readForm,
  requireMerchant,
  withCsrfCookie,
  type ResolvedSession,
} from './session';
import {
  alert,
  badge,
  dashboardShell,
  emptyState,
  ident,
  panel,
  pipelineSpine,
  stat,
} from '../ui/layout';
import { API_KEY_SCOPES } from '../services/api-keys';
import { WEBHOOK_EVENTS } from '../services/webhooks';
import type { LedgerRow } from '../services/wallet';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A hidden CSRF input, built once per page and reused by every form on it. */
function csrfField(token: string): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(token)}">`;
}

/**
 * A label/value row.
 *
 * Most of this console is rows of facts, so this is most of its markup. `tone` colours the
 * value where the colour itself carries meaning — an amount that arrived, an amount owed.
 */
function row(label: string, value: string, tone: 'plain' | 'settle' | 'owed' | 'failed' = 'plain'): string {
  const color =
    tone === 'settle'
      ? 'var(--settled)'
      : tone === 'owed'
        ? 'var(--owed)'
        : tone === 'failed'
          ? 'var(--failed)'
          : 'var(--steel)';
  return `<div class="receipt-row"><dt>${escapeHtml(label)}</dt><dd class="num" style="color:${color}">${value}</dd></div>`;
}

const rows = (...items: string[]): string => `<dl class="receipt-rows">${items.join('')}</dl>`;

/** Toman, Persian digits, with the unit. */
const toman = (value: number): string => `${formatTomanFa(value)} <small style="color:var(--haze)">تومان</small>`;

const jalali = (iso: string | null): string =>
  iso ? `${formatJalaliDateTime(iso)} <small style="color:var(--haze)">(${formatRelativeFa(iso)})</small>` : '—';

/** A POST that succeeded lands on a GET, so a refresh cannot repeat it. */
const backTo = (path: string, code: string): Response => redirect(`${path}?ok=${code}`, 303);

const failTo = (path: string, code: string): Response => redirect(`${path}?err=${code}`, 303);

/** A GET filter form (search) needs no CSRF token; it changes nothing. */
function searchForm(action: string, value: string, placeholder: string): string {
  return `<form method="get" action="${escapeHtml(action)}" style="display:flex;gap:.5rem;flex-wrap:wrap">
<input class="input" type="search" name="q" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"
style="flex:1 1 14rem;min-width:0">
<button class="btn" type="submit">جست‌وجو</button>
</form>`;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * The rail.
 *
 * Only built pages appear. A link that 404s teaches a merchant to distrust the whole
 * navigation, and turns a deliberate gap into what looks like a broken product.
 */
function dashboardNav(unread: number): Array<{ group: string; links: Array<{ href: string; label: string }> }> {
  return [
    { group: 'مرور کلی', links: [{ href: '/dashboard', label: 'نمای کلی' }] },
    {
      group: 'پول',
      links: [
        { href: '/dashboard/payments', label: 'پرداخت‌ها' },
        { href: '/dashboard/wallet', label: 'کیف پول' },
      ],
    },
    {
      group: 'اتصال',
      links: [
        { href: '/dashboard/api-keys', label: 'کلیدهای API' },
        { href: '/dashboard/cards', label: 'کارت‌های مقصد' },
        { href: '/dashboard/sms', label: 'پیامک بانک' },
        { href: '/dashboard/webhooks', label: 'وب‌هوک' },
      ],
    },
    {
      group: 'حساب',
      links: [
        {
          href: '/dashboard/notifications',
          label: `اطلاعیه‌ها${unread > 0 ? ` (${toPersianDigits(unread)})` : ''}`,
        },
        { href: '/dashboard/settings', label: 'تنظیمات پرداخت' },
        { href: '/dashboard/profile', label: 'پروفایل فروشگاه' },
      ],
    },
  ];
}

interface PageInput {
  title: string;
  heading: string;
  subheading?: string;
  path: string;
  eyebrow?: string;
  actions?: string;
  /** An outcome for a POST that re-renders its own page. Overrides the query string. */
  notice?: { tone: 'success' | 'error' | 'info' | 'warn'; text: string } | null;
  /** Status for a re-rendered POST. Defaults to 200. */
  status?: number;
}

type PageBuilder = (csrf: string, session: ResolvedSession) => string | Promise<string>;

/**
 * Renders a dashboard page.
 *
 * `build` receives the session and the CSRF input rather than a token string, so a page
 * cannot ship a form without a token and cannot resolve the session a second time. This
 * runs for POST responses too, which is how the one-time secret reveals work: the POST
 * renders the page instead of redirecting to it.
 */
async function render(c: RouteContext, input: PageInput, build: PageBuilder): Promise<Response> {
  const url = new URL(c.req.url);

  // A signed-out browser navigation goes to the login form, carrying where it was headed.
  //
  // `requireMerchant` deliberately throws rather than redirecting, because the same guard
  // protects the API routes where a 302 is the wrong answer. The console is the opposite
  // case: an expired session there is a person with a stale tab, and the error page they
  // would otherwise get says "you must sign in" without offering anywhere to do it.
  let session: ResolvedSession;
  try {
    session = await requireMerchant(c);
  } catch (error) {
    if (isAppError(error) && (error.code === 'UNAUTHENTICATED' || error.code === 'SESSION_EXPIRED')) {
      return redirect(`/login?next=${encodeURIComponent(url.pathname)}`, 302);
    }
    throw error;
  }

  const [unread, csrf] = await Promise.all([
    session.services.notifications.unreadCount(session.user.id, session.user.role),
    csrfForGet(c),
  ]);

  const notice =
    input.notice !== undefined
      ? input.notice
      : (messageFor(url.searchParams.get('ok') ?? undefined) ??
        messageFor(url.searchParams.get('err') ?? undefined));

  const body = await build(csrfField(csrf.token), session);

  const page = dashboardShell(
    {
      title: input.title,
      currentPath: input.path,
      user: {
        displayName: session.user.displayName,
        mobile: session.user.mobile,
        role: session.user.role,
      },
      unreadCount: unread,
      nav: dashboardNav(unread),
      heading: input.heading,
      ...(input.subheading ? { subheading: input.subheading } : {}),
      ...(input.eyebrow ? { eyebrow: input.eyebrow } : {}),
      ...(input.actions ? { actions: input.actions } : {}),
    },
    `${notice ? alert(notice.tone, notice.text) : ''}${body}`,
  );

  const response = html(page, {
    noStore: true,
    ...(input.status ? { status: input.status } : {}),
  });
  return withCsrfCookie(response, csrf.cookie);
}

function actorOf(c: RouteContext, session: ResolvedSession) {
  return { userId: session.user.id, role: session.user.role, ip: c.get('appContext').clientIp };
}

/** Turns an AppError into the code for `?err=`, if it is one of the codes we publish. */
function errorCode(error: unknown, fallback: string): string {
  if (error instanceof AppError) {
    const map: Record<string, string> = {
      CARD_INVALID: 'card_invalid',
      CARD_DUPLICATE: 'card_duplicate',
      CARD_LIMIT_REACHED: 'card_limit',
      CARD_NOT_FOUND: 'card_not_found',
      WEBHOOK_NOT_FOUND: 'webhook_not_found',
      CALLBACK_URL_NOT_ALLOWED: 'webhook_url_invalid',
      INVOICE_NOT_FOUND: 'invoice_not_found',
      INVOICE_NOT_PAYABLE: 'invoice_not_cancellable',
      INVOICE_EXPIRED: 'invoice_not_cancellable',
      INVOICE_ALREADY_PAID: 'invoice_not_cancellable',
      NOT_FOUND: 'delivery_not_found',
      SETTING_INVALID: 'settings_invalid',
    };
    return map[error.code] ?? fallback;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const SETUP_HREF: Record<string, string> = {
  card: '/dashboard/cards',
  api_key: '/dashboard/api-keys',
  sms_test: '/dashboard/sms',
  webhook: '/dashboard/webhooks',
  wallet: '/dashboard/wallet',
  profile: '/dashboard/profile',
};

async function overviewPage(c: RouteContext): Promise<Response> {
  return render(
    c,
    {
      title: 'نمای کلی — Steve Pay',
      heading: 'نمای کلی',
      subheading: 'امروز چه اتفاقی افتاده و کجای راه‌اندازی مانده است',
      path: '/dashboard',
      eyebrow: 'MERCHANT CONSOLE',
    },
    async (_csrf, session) => {
      const services = session.services;
      const id = session.user.id;

      const [counts, recent, setup, wallet, smsStatus, smsCountsRaw, feePerInvoice, feeMode] = await Promise.all([
        services.invoices.counts(id),
        services.invoices.recent(id, 8),
        services.merchants.setupProgress(id),
        services.wallet.snapshot(id),
        services.sms.testTokenStatus(id),
        services.sms.counts(id),
        services.settings.merchantInt(id, 'gateway.fee_toman'),
        services.settings.merchantOrPlatform(id, 'gateway.fee_mode_default'),
      ]);

      const smsCounts = {
        parsed: smsCountsRaw['parsed'] ?? 0,
        failed: smsCountsRaw['failed'] ?? 0,
      };

      // The setup card is the first thing on the page while anything is unfinished, and it
      // disappears entirely when it is done. A permanent checklist that says "complete" is
      // a permanent piece of furniture.
      const setupCard = setup.ready
        ? ''
        : panel(
            'راه‌اندازی حساب',
            `<div class="bar-row" style="margin-bottom:1.1rem">
  <span class="bar"><span style="width:${Math.max(3, setup.percent)}%"></span></span>
</div>
<div class="stack" style="gap:.5rem">
${setup.steps
  .map(
    (step) => `<div class="setup-step">
  <span class="badge badge-${step.done ? 'paid' : 'pending'}"><i aria-hidden="true"></i>${
    step.done ? 'انجام شد' : 'باقی‌مانده'
  }</span>
  <div class="setup-step-body">
    <b style="color:${step.done ? 'var(--haze)' : 'var(--ice)'};font-weight:${
      step.done ? '400' : '600'
    }">${escapeHtml(step.title)}</b>
    ${
      step.detail
        ? `<small style="color:var(--haze);display:block;font-size:.74rem;line-height:1.9">${escapeHtml(
            step.detail,
          )}</small>`
        : ''
    }
  </div>
  ${
    step.done || !SETUP_HREF[step.key]
      ? ''
      : `<a class="btn" href="${escapeHtml(SETUP_HREF[step.key] ?? '')}" style="font-size:.74rem">انجام می‌دهم</a>`
  }
</div>`,
  )
  .join('')}
</div>
<p style="margin:1rem 0 0;font-size:.74rem;color:var(--haze);line-height:1.95">
تا وقتی پیامک بانک وصل نشود، پول واریز می‌شود ولی فاکتور خودکار تأیید نمی‌شود.
</p>`,
            `<span class="mono" style="font-size:.68rem;color:var(--haze)">${toPersianDigits(setup.percent)}٪</span>`,
          );

      return `${setupCard}
<div class="grid-4" style="margin-top:${setup.ready ? '0' : '1rem'}">
${stat({ label: 'پرداخت امروز', value: toPersianDigits(counts.todayInvoices), sub: `از ${toPersianDigits(counts.total)} فاکتور` })}
${stat({ label: 'حجم امروز', value: formatTomanFa(counts.todayVolume), unit: 'تومان', sub: 'پرداخت‌های تأییدشده' })}
${stat({
  label: 'کارمزد هر فاکتور',
  value: formatTomanFa(feePerInvoice),
  unit: 'تومان',
  sub: feeMode === 'MERCHANT' ? 'از کیف پول شما کسر می‌شود' : 'مشتری روی مبلغ می‌پردازد',
})}
${stat({
  label: 'نرخ موفقیت',
  value: `${toPersianDigits(String(counts.successRate))}٪`,
  sub: `${toPersianDigits(counts.successful)} پرداخت موفق`,
})}
</div>

<div class="grid-2" style="margin-top:1rem">
${panel(
  'آخرین پرداخت‌ها',
  recent.length === 0
    ? emptyState({
        title: 'هنوز پرداختی ثبت نشده',
        body: 'کلید API را بسازید و اولین فاکتور را از سرور خودتان ایجاد کنید. پرداخت‌ها همین‌جا ظاهر می‌شوند.',
        action: { href: '/dashboard/api-keys', label: 'ساخت کلید API' },
      })
    : `<div class="table-wrap"><table>
<thead><tr><th>مبلغ</th><th>وضعیت</th><th>زمان</th></tr></thead>
<tbody>${recent
        .map(
          (invoice) => `<tr>
<td><a href="/dashboard/payments/${escapeHtml(invoice.id)}" class="num">${formatTomanFa(invoice.payable_amount)}</a>
<div style="font-size:.68rem;color:var(--haze)" class="mono">${escapeHtml(invoice.id)}</div></td>
<td>${badge(invoice.status, statusLabelFa(invoice.status))}</td>
<td style="color:var(--steel);font-size:.75rem">${formatRelativeFa(invoice.created_at)}</td>
</tr>`,
        )
        .join('')}</tbody></table></div>`,
  `<a href="/dashboard/payments">همه پرداخت‌ها</a>`,
)}
<div class="stack">
${panel(
  'وضعیت اتصال',
  rows(
    row(
      'مسیر پیامک',
      smsStatus.connected
        ? '<span style="color:var(--settled)">وصل است</span>'
        : '<span style="color:var(--owed)">هنوز پیامکی نرسیده</span>',
      smsStatus.connected ? 'settle' : 'owed',
    ),
    row('پیامک پردازش‌شده', toPersianDigits(smsCounts.parsed)),
    row(
      'پیامک تجزیه‌نشده',
      toPersianDigits(smsCounts.failed),
      smsCounts.failed > 0 ? 'failed' : 'plain',
    ),
    row(
      'موجودی قابل استفاده',
      toman(wallet.availableBalance),
      wallet.availableBalance > 0 ? 'settle' : 'owed',
    ),
    row('رزرو‌شده', toman(wallet.reservedBalance)),
  ),
  '<a href="/dashboard/sms">اتصال پیامک</a>',
)}
${panel(
  'میان‌بر',
  `<div class="stack" style="gap:.5rem">
<a class="btn" href="/dashboard/api-keys">کلید API</a>
<a class="btn" href="/dashboard/docs" style="display:none"></a>
<a class="btn" href="/docs">مستندات فنی</a>
<a class="btn" href="/dashboard/webhooks">تنظیم وب‌هوک</a>
</div>`,
)}
</div>
</div>`;
    },
  );
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'همه' },
  { value: 'successful', label: 'موفق' },
  { value: 'pending', label: 'در جریان' },
  { value: 'MANUAL_REVIEW', label: 'در بررسی دستی' },
  { value: 'expired', label: 'منقضی' },
  { value: 'failed', label: 'ناموفق' },
];

/**
 * The statuses the URL may name.
 *
 * `MANUAL_REVIEW` is a raw status rather than one of the service's buckets: no bucket
 * contains it, because every bucket answers "how did this end" and a payment under review
 * has not ended. It still needs a filter, so it is named directly.
 */
type StatusParam = StatusFilter | 'MANUAL_REVIEW';

function statusParamOf(raw: string): StatusParam {
  const match = STATUS_FILTERS.find((filter) => filter.value === raw);
  return (match?.value ?? 'all') as StatusParam;
}

const PAGE_SIZE = 20;

async function paymentsPage(c: RouteContext): Promise<Response> {
  const url = new URL(c.req.url);
  const status: StatusParam = statusParamOf(url.searchParams.get('status') ?? 'all');
  const search = (url.searchParams.get('q') ?? '').trim();
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);

  return render(
    c,
    {
      title: 'پرداخت‌ها — Steve Pay',
      heading: 'پرداخت‌ها',
      subheading: 'هر فاکتوری که ساخته‌اید و سرنوشت مبلغ یکتای آن',
      path: '/dashboard/payments',
      eyebrow: 'PAYMENTS',
    },
    async (_csrf, session) => {
      const id = session.user.id;

      const [list, counts] = await Promise.all([
        session.services.invoices.list(id, {
          status,
          ...(search ? { search } : {}),
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        }),
        session.services.invoices.counts(id),
      ]);

      const chips = `<div class="spine" style="margin-bottom:1rem">${STATUS_FILTERS.map(
        (filter) =>
          `<a class="spine-node" href="/dashboard/payments?status=${escapeHtml(filter.value)}"${
            filter.value === status ? ' data-state="current"' : ''
          }><b>${escapeHtml(filter.label)}</b></a>`,
      ).join('')}</div>`;

      const body =
        list.length === 0
          ? emptyState({
              title: search ? 'چیزی با این جست‌وجو پیدا نشد' : 'در این دسته پرداختی نیست',
              body: search
                ? 'شناسه فاکتور، بخشی از توضیح، یا مبلغ دقیق را جست‌وجو کنید.'
                : 'با تغییر دسته در بالا، پرداخت‌های دسته‌های دیگر را ببینید.',
              action: { href: '/dashboard/payments', label: 'پاک‌کردن فیلترها' },
            })
          : `<div class="table-wrap"><table>
<thead><tr><th>مبلغ قابل پرداخت</th><th>وضعیت</th><th>توضیح</th><th>ساخته‌شده</th><th>شناسه</th></tr></thead>
<tbody>${list
              .map(
                (invoice) => `<tr>
<td class="num" style="white-space:nowrap">${formatTomanFa(invoice.payable_amount)} <small style="color:var(--haze)">تومان</small>
  <div style="font-size:.68rem;color:var(--haze)">سفارش: ${formatTomanFa(invoice.original_amount)}${
    invoice.unique_suffix > 0 ? ` · پسوند: ${formatTomanFa(invoice.unique_suffix)}` : ''
  }</div></td>
<td>${badge(invoice.status, statusLabelFa(invoice.status))}${
                  invoice.is_test === 1 ? ' <span class="badge">آزمایشی</span>' : ''
                }</td>
<td style="max-width:16rem;color:var(--steel);font-size:.78rem">${
                  invoice.description ? escapeHtml(invoice.description) : '<span style="color:var(--haze)">—</span>'
                }</td>
<td style="color:var(--steel);font-size:.75rem;white-space:nowrap">${formatRelativeFa(invoice.created_at)}</td>
<td>${ident(invoice.id)} <a href="/dashboard/payments/${escapeHtml(invoice.id)}" style="font-size:.72rem">جزئیات</a></td>
</tr>`,
              )
              .join('')}</tbody></table></div>
<div style="display:flex;justify-content:space-between;align-items:center;margin-top:1rem;gap:.75rem;flex-wrap:wrap">
  <span style="font-size:.74rem;color:var(--haze)">صفحه ${toPersianDigits(page)}${
              list.length === PAGE_SIZE ? '' : ' · آخرین صفحه'
            }</span>
  <span style="display:flex;gap:.5rem">
    ${
      page > 1
        ? `<a class="btn" href="/dashboard/payments?status=${escapeHtml(status)}&page=${page - 1}${
            search ? `&q=${encodeURIComponent(search)}` : ''
          }">صفحه قبل</a>`
        : ''
    }
    ${
      list.length === PAGE_SIZE
        ? `<a class="btn" href="/dashboard/payments?status=${escapeHtml(status)}&page=${page + 1}${
            search ? `&q=${encodeURIComponent(search)}` : ''
          }">صفحه بعد</a>`
        : ''
    }
  </span>
</div>`;

      return `${chips}
<div class="grid-4" style="margin-bottom:1rem">
${stat({ label: 'کل فاکتور', value: toPersianDigits(counts.total) })}
${stat({ label: 'موفق', value: toPersianDigits(counts.successful), tone: 'settle' })}
${stat({
  label: 'در بررسی دستی',
  value: toPersianDigits(counts.review),
  sub: 'منتظر تصمیم مدیر',
  ...(counts.review > 0 ? { tone: 'amber' as const } : {}),
})}
${stat({ label: 'حجم کل', value: formatTomanFa(counts.totalVolume), unit: 'تومان' })}
</div>
${searchForm('/dashboard/payments', search, 'شناسه فاکتور، توضیح یا مبلغ')}
<div style="margin-top:1rem">${panel('فهرست پرداخت‌ها', body)}</div>`;
    },
  );
}

async function paymentDetailPage(c: RouteContext): Promise<Response> {
  const invoiceId = c.req.param('invoiceId') ?? '';

  return render(
    c,
    {
      title: 'جزئیات پرداخت — Steve Pay',
      heading: 'جزئیات پرداخت',
      subheading: invoiceId,
      path: '/dashboard/payments',
      eyebrow: 'PAYMENT DETAIL',
      actions: `<a class="btn" href="/dashboard/payments">بازگشت به فهرست</a>`,
    },
    async (csrf, session) => {
      const services = session.services;
      const invoice = await services.invoices.getForMerchant(session.user.id, invoiceId);
      if (!invoice) throw new AppError('INVOICE_NOT_FOUND');

      const [smsContext, delivery] = await Promise.all([
        services.sms.reviewContext(invoice),
        first<{
          status: string;
          event: string;
          attempt_count: number;
          response_status: number | null;
          last_error: string | null;
          created_at: string;
        }>(
          c.get('appContext').env.DB,
          `SELECT status, event, attempt_count, response_status, last_error, created_at
             FROM webhook_deliveries
            WHERE merchant_user_id = ? AND source_id = ?
            ORDER BY created_at DESC LIMIT 1`,
          [session.user.id, invoice.id],
        ),
      ]);

      const payable = isPayable(invoice.status);
      const paymentUrl = absoluteUrl(c.get('appContext').origin, `/pay/${invoice.id}`);

      const spine = pipelineSpine({
        invoice: true,
        sms: smsContext !== null,
        match:
          invoice.status === 'MANUAL_REVIEW'
            ? 'review'
            : invoice.transaction_id
              ? 'matched'
              : 'none',
        confirmed: invoice.status === 'PAID',
        callback: delivery
          ? delivery.status === 'DELIVERED'
            ? 'delivered'
            : delivery.status === 'FAILED' || delivery.status === 'DEAD'
              ? 'failed'
              : 'pending'
          : 'none',
      });

      const cancelForm = payable
        ? `<form method="post" action="/dashboard/payments/${escapeHtml(invoice.id)}/cancel" style="margin:0">
${csrf}
<button class="btn" type="submit">لغو فاکتور</button>
</form>`
        : '';

      const evidence = smsContext
        ? `<div class="slip">
<div class="slip-head">پیامک بانک <span>${jalali(smsContext.receivedAt)}</span></div>
<div class="slip-body" dir="auto">${escapeHtml(smsContext.rawMessage)}</div>
<div class="slip-foot" style="display:flex;gap:.75rem;flex-wrap:wrap">
  <span>بانک: ${escapeHtml(smsContext.parsed.bank ?? 'نامشخص')}</span>
  <span>اطمینان: ${toPersianDigits(String(smsContext.parsed.confidence))}٪</span>
  ${
    smsContext.parsed.reference
      ? `<span>شماره پیگیری: <span class="mono">${escapeHtml(smsContext.parsed.reference)}</span></span>`
      : ''
  }
</div>
</div>
${
  smsContext.parsed.warnings.length > 0
    ? alert(
        'warn',
        `این پیامک با ${toPersianDigits(smsContext.parsed.warnings.length)} هشدار تجزیه شد و به همین دلیل ممکن است به بررسی دستی رفته باشد.`,
      )
    : ''
}`
        : alert(
            'info',
            'برای این مبلغ پیامک بانکی پیدا نشد. تا پیامک نرسد، پرداخت خودکار تأیید نمی‌شود — حتی اگر مشتری واقعاً واریز کرده باشد.',
          );

      return `<div class="panel" style="margin-bottom:1rem">
<div class="panel-head">
  <h2 class="num" style="font-size:1.35rem">${formatTomanFa(invoice.payable_amount)} <small style="font-size:.8rem;color:var(--steel)">تومان</small></h2>
  ${badge(invoice.status, statusLabelFa(invoice.status))}
</div>
<p style="margin:0;font-family:var(--mono);font-size:.72rem;color:var(--haze)">
${toPersianDigits(formatTomanFa(invoice.payable_amount_rial))} ریال
</p>
${spine}
<div style="display:flex;gap:.5rem;margin-top:1rem;flex-wrap:wrap">
  <button class="btn" type="button" data-copy="${escapeHtml(paymentUrl)}">کپی لینک پرداخت</button>
  ${
    payable
      ? `<a class="btn" href="/pay/${escapeHtml(invoice.id)}" target="_blank" rel="noopener">دیدن صفحه پرداخت</a>`
      : ''
  }
  ${cancelForm}
</div>
</div>

<div class="grid-2">
${panel(
  'تفکیک مبلغ',
  rows(
    row('مبلغ سفارش', toman(invoice.original_amount)),
    row(`کارمزد (${invoice.fee_mode === 'MERCHANT' ? 'از شما' : 'از مشتری'})`, toman(invoice.gateway_fee)),
    row('مبلغ پایه', toman(invoice.base_amount)),
    row('پسوند یکتا', `${formatTomanFa(invoice.unique_suffix)} <small style="color:var(--haze)">تومان</small>`),
    row('مبلغ قابل پرداخت', toman(invoice.payable_amount), 'settle'),
    row('واریزشده', invoice.received_amount === null ? '—' : toman(invoice.received_amount)),
  ) +
    `<p style="margin:.9rem 0 0;font-size:.73rem;color:var(--haze);line-height:1.95">
پسوند یکتا همان چیزی است که این فاکتور را از هر فاکتور زنده دیگری جدا می‌کند. مشتری باید دقیقاً همین مبلغ را واریز کند؛
کم یا زیاد واریز کردن، تأیید خودکار را ناموفق می‌گذارد.
</p>`,
)}
${panel(
  'زمان‌ها و مشخصات',
  rows(
    row('ساخته‌شده', jalali(invoice.created_at)),
    row('مهلت پرداخت', jalali(invoice.expires_at)),
    row('پرداخت‌شده', jalali(invoice.paid_at)),
    row('لغو‌شده', jalali(invoice.cancelled_at)),
    row('شناسه فاکتور', `<span class="mono" style="font-size:.72rem">${escapeHtml(invoice.id)}</span>`),
    row('شناسه پرداخت', `<span class="mono" style="font-size:.72rem">${escapeHtml(invoice.payment_id)}</span>`),
    row('محیط', invoice.environment === 'live' ? 'عملیاتی' : 'آزمایشی'),
    row('زمان باقی‌مانده', payable ? formatCountdown(services.invoices.remainingMs(invoice)) : '—'),
  ) +
    (invoice.custom_callback
      ? `<p style="margin:.9rem 0 0;font-size:.72rem;color:var(--haze);word-break:break-all">
آدرس وب‌هوک اختصاصی: <span class="mono">${escapeHtml(invoice.custom_callback)}</span></p>`
      : ''),
)}
</div>

<div class="grid-2" style="margin-top:1rem">
${panel('شاهد پرداخت', evidence)}
${panel(
  'تحویل وب‌هوک',
  delivery
    ? rows(
        row('رویداد', `<span class="mono" style="font-size:.72rem">${escapeHtml(delivery.event)}</span>`),
        row('وضعیت', delivery.status),
        row('تعداد تلاش', toPersianDigits(delivery.attempt_count)),
        row('کد پاسخ سرور شما', delivery.response_status === null ? '—' : toPersianDigits(delivery.response_status)),
        row('آخرین خطا', delivery.last_error ? escapeHtml(delivery.last_error) : '—'),
      )
    : emptyState({
        title: 'وب‌هوکی ثبت نشده',
        body: 'برای این پرداخت ارسالی ثبت نشده است؛ یا آدرسی تنظیم نکرده‌اید، یا فاکتور هنوز به وضعیت نهایی نرسیده است.',
        action: { href: '/dashboard/webhooks', label: 'تنظیم وب‌هوک' },
      }),
)}
</div>`;
    },
  );
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

const LEDGER_TYPE_FA: Record<string, string> = {
  DEPOSIT: 'شارژ',
  WITHDRAWAL: 'برداشت',
  PAYMENT_FEE: 'کارمزد فاکتور',
  REFUND: 'بازگشت',
  ADMIN_CREDIT: 'افزایش توسط مدیر',
  ADMIN_DEBIT: 'کاهش توسط مدیر',
  ADJUSTMENT: 'اصلاح',
  REVERSAL: 'برگشت',
  RESERVE: 'رزرو',
  RELEASE: 'آزادسازی',
};

function ledgerRow(entry: LedgerRow): string {
  const credit = entry.direction === 'CREDIT';
  return `<tr>
<td>${escapeHtml(LEDGER_TYPE_FA[entry.type] ?? entry.type)}
  <div style="font-size:.68rem;color:var(--haze)">${
    entry.description ? escapeHtml(entry.description) : `<span class="mono">${escapeHtml(entry.type)}</span>`
  }</div></td>
<td class="num" style="white-space:nowrap;color:${credit ? 'var(--settled)' : 'var(--failed)'}">
  ${credit ? '+' : '−'}${formatTomanFa(entry.amount)}
</td>
<td class="num" style="color:var(--steel)">${formatTomanFa(entry.balance_after)}</td>
<td style="color:var(--steel);font-size:.74rem;white-space:nowrap">${formatJalaliDateTime(entry.created_at)}</td>
</tr>`;
}

async function walletPage(c: RouteContext): Promise<Response> {
  return render(
    c,
    {
      title: 'کیف پول — Steve Pay',
      heading: 'کیف پول',
      subheading: 'کارمزد درگاه از این موجودی کسر می‌شود',
      path: '/dashboard/wallet',
      eyebrow: 'WALLET',
    },
    async (_csrf, session) => {
      const [snapshot, ledger, feePerInvoice, threshold] = await Promise.all([
        session.services.wallet.snapshot(session.user.id),
        session.services.wallet.ledger(session.user.id, { limit: 50 }),
        session.services.settings.merchantInt(session.user.id, 'gateway.fee_toman'),
        session.services.settings.int('wallet.low_balance_threshold_toman'),
      ]);

      const low = snapshot.availableBalance < threshold;
      const capacity = feePerInvoice > 0 ? Math.floor(snapshot.availableBalance / feePerInvoice) : 0;

      return `${
        low
          ? alert(
              'warn',
              `موجودی شما از حد هشدار (${toPersianDigits(formatTomanFa(threshold))} تومان) کمتر است. تا شارژ نکنید، ساخت فاکتور جدید متوقف می‌شود.`,
            )
          : ''
      }
<div class="grid-4">
${stat({ label: 'موجودی', value: formatTomanFa(snapshot.balance), unit: 'تومان' })}
${stat({
  label: 'قابل استفاده',
  value: formatTomanFa(snapshot.availableBalance),
  unit: 'تومان',
  tone: low ? 'amber' : 'settle',
  sub: 'بعد از کسر رزروها',
})}
${stat({ label: 'رزرو‌شده', value: formatTomanFa(snapshot.reservedBalance), unit: 'تومان', sub: 'برای فاکتورهای در جریان' })}
${stat({
  label: 'ظرفیت فاکتور',
  value: toPersianDigits(capacity),
  sub: `با کارمزد ${toPersianDigits(formatTomanFa(feePerInvoice))} تومان`,
})}
</div>

<div class="grid-2" style="margin-top:1rem">
${panel(
  'جمع‌های کل',
  rows(
    row('کل شارژ', toman(snapshot.totalDeposited)),
    row('کل کارمزد پرداخت‌شده', toman(snapshot.totalFeesPaid)),
    row('کل برداشت', toman(snapshot.totalWithdrawn)),
    row('کل اصلاحات', toman(snapshot.totalAdjustments)),
    row('آخرین تغییر', jalali(snapshot.updatedAt)),
  ),
)}
${panel(
  'دفتر کل',
  `<div class="table-wrap"><table>
<thead><tr><th>نوع</th><th>مبلغ</th><th>موجودی پس از آن</th><th>زمان</th></tr></thead>
<tbody>${ledger.map(ledgerRow).join('')}</tbody>
</table></div>${
    ledger.length === 0
      ? '<p style="color:var(--haze);font-size:.78rem;margin:.5rem 0 0">هنوز تراکنشی در دفتر کل ثبت نشده است.</p>'
      : ''
  }`,
  '<span class="mono" style="font-size:.68rem;color:var(--haze)">IMMUTABLE</span>',
)}
</div>
${panel(
  'چرا موجودی را شارژ می‌کنید',
  `<p style="margin:0;font-size:.83rem;line-height:2.1;color:var(--steel)">
کارمزد درگاه پیش از ساخت فاکتور از این موجودی رزرو و پس از تأیید پرداخت قطعی می‌شود.
برای شارژ، مبلغ را به کارت پشتیبانی واریز کنید و شماره پیگیری را برای پشتیبانی بفرستید؛
افزایش موجودی توسط مدیر ثبت می‌شود و در همین دفتر کل، با نام همان مدیر، دیده می‌شود.
</p>`,
)}`;
    },
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

async function cardsPage(c: RouteContext, notice?: PageInput['notice']): Promise<Response> {
  return render(
    c,
    {
      title: 'کارت‌های مقصد — Steve Pay',
      heading: 'کارت‌های مقصد',
      subheading: 'پول مشتری به این کارت‌ها واریز می‌شود',
      path: '/dashboard/cards',
      eyebrow: 'RECEIVING CARDS',
      ...(notice !== undefined ? { notice } : {}),
    },
    async (csrf, session) => {
      const id = session.user.id;
      const [cards, maxCards] = await Promise.all([
        session.services.cards.list(id),
        session.services.settings.int('cards.max_per_merchant'),
      ]);

      const list =
        cards.length === 0
          ? emptyState({
              title: 'هیچ کارتی ثبت نشده',
              body: 'بدون کارت فعال، ساخت فاکتور با خطای «کارت لازم است» رد می‌شود. شماره کارتی که پول به آن می‌رسد را اضافه کنید.',
            })
          : `<div class="stack">${cards
              .map((card) => {
                const idAttr = escapeHtml(card.id);
                // The card is drawn in the colours of the bank that issued it, derived from
                // the number's prefix. Printed masked, the way the panel has always shown
                // it; the theme is a fact about the issuer and does not depend on how much
                // of the number is on screen.
                const face = bankCardFace({
                  number: card.number,
                  display: card.masked,
                  bankName: card.bankName,
                  title: card.title,
                  holderName: card.holderName,
                  size: 'sm',
                  footer: `<button class="btn btn-sm" type="button" data-copy="${escapeHtml(
                    card.masked,
                  )}">کپی شماره</button>`,
                });

                return `<div class="panel">
<div class="panel-head">
  <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;min-width:0">
    <span class="mono" style="font-size:.9rem">${escapeHtml(card.bankName ?? 'کارت بانکی')}</span>
    ${card.isDefault ? badge('ACTIVE', 'پیش‌فرض') : ''}
    ${card.isActive ? '' : badge('SUSPENDED', 'غیرفعال')}
  </div>
  <div style="display:flex;gap:.4rem;flex-wrap:wrap">
    ${
      card.isDefault
        ? ''
        : `<form method="post" action="/dashboard/cards/${idAttr}/default" style="margin:0">${csrf}
<button class="btn" type="submit">پیش‌فرض کن</button></form>`
    }
    <form method="post" action="/dashboard/cards/${idAttr}/toggle" style="margin:0">${csrf}
<button class="btn" type="submit">${card.isActive ? 'غیرفعال کن' : 'فعال کن'}</button></form>
    <form method="post" action="/dashboard/cards/${idAttr}/delete" style="margin:0">${csrf}
<button class="btn" type="submit">حذف</button></form>
  </div>
</div>
<div class="card-slot card-slot-sm">${face}</div>
<dl class="receipt-rows">
${row('عنوان', escapeHtml(card.title))}
${row('صاحب حساب', escapeHtml(card.holderName ?? '—'))}
${row('واریزهای موفق', toPersianDigits(String(card.successCount)))}
</dl>
<form method="post" action="/dashboard/cards/${idAttr}/update" class="form" style="margin-top:.9rem">
  ${csrf}
  <div class="grid-3" style="gap:.75rem">
    <div class="field"><label for="title-${idAttr}">عنوان</label>
      <input class="input" id="title-${idAttr}" name="title" value="${escapeHtml(card.title)}" maxlength="60"></div>
    <div class="field"><label for="bank-${idAttr}">بانک</label>
      <input class="input" id="bank-${idAttr}" name="bankName" value="${escapeHtml(card.bankName ?? '')}" maxlength="60"></div>
    <div class="field"><label for="holder-${idAttr}">صاحب حساب</label>
      <input class="input" id="holder-${idAttr}" name="holderName" value="${escapeHtml(card.holderName ?? '')}" maxlength="80"></div>
  </div>
  <div><button class="btn btn-primary" type="submit">ذخیره تغییرات</button></div>
</form>
</div>`;
              })
              .join('')}</div>`;

      return `${list}
<div style="margin-top:1rem">
${panel(
  'افزودن کارت جدید',
  `<form method="post" action="/dashboard/cards/create" class="form">
${csrf}
<div class="field">
  <label for="number">شماره کارت</label>
  <input class="input" id="number" name="number" inputmode="numeric" autocomplete="off"
    placeholder="6104 3378 9012 3456" maxlength="32" style="direction:ltr;text-align:left;font-family:var(--mono)" required>
  <span class="hint">۱۶ رقم کارت شتابی که پول به آن واریز می‌شود. رقم کنترلی بررسی می‌شود.</span>
</div>
<div class="grid-3" style="gap:.75rem">
  <div class="field"><label for="new-title">عنوان</label>
    <input class="input" id="new-title" name="title" maxlength="60" placeholder="مثلاً کارت اصلی"></div>
  <div class="field"><label for="new-bank">بانک</label>
    <input class="input" id="new-bank" name="bankName" maxlength="60" placeholder="اختیاری"></div>
  <div class="field"><label for="new-holder">صاحب حساب</label>
    <input class="input" id="new-holder" name="holderName" maxlength="80" placeholder="اختیاری"></div>
</div>
<label style="display:flex;gap:.5rem;align-items:center;font-size:.8rem">
  <input type="checkbox" name="isDefault" value="1"> این کارت پیش‌فرض شود
</label>
<div><button class="btn btn-primary" type="submit">ثبت کارت</button></div>
</form>`,
  `<span class="mono" style="font-size:.68rem;color:var(--haze)">${toPersianDigits(cards.length)} / ${toPersianDigits(
    maxCards,
  )}</span>`,
)}
</div>
<p style="margin:1rem 0 0;font-size:.74rem;color:var(--haze);line-height:1.95">
شماره کارت شما رمزنگاری‌شده ذخیره می‌شود، چون باید کامل روی صفحه پرداخت به مشتری نشان داده شود.
هیچ کارتی از مشتری ذخیره نمی‌شود: پول با انتقال کارت‌به‌کارت معمولی می‌آید و همین است که این درگاه را از یک
درگاه PSP معمولی جدا می‌کند.
</p>`;
    },
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/** The scope checkboxes, with the Persian label a merchant can actually judge. */
const SCOPE_LABELS: Record<string, string> = {
  'payments:create': 'ساخت پرداخت',
  'payments:read': 'خواندن وضعیت پرداخت',
  'transactions:read': 'خواندن آمار تراکنش',
  'wallet:read': 'خواندن موجودی کیف پول',
  'cards:read': 'خواندن فهرست کارت‌ها',
  'sms:write': 'ارسال پیامک بانک',
};

async function apiKeysPage(
  c: RouteContext,
  notice?: PageInput['notice'],
  reveal?: { label: string; key: string } ,
): Promise<Response> {
  return render(
    c,
    {
      title: 'کلیدهای API — Steve Pay',
      heading: 'کلیدهای API',
      subheading: 'کلیدی که سرور شما با آن فاکتور می‌سازد و پیامک می‌فرستد',
      path: '/dashboard/api-keys',
      eyebrow: 'API KEYS',
      status: reveal ? 200 : undefined,
      ...(notice !== undefined ? { notice } : {}),
    },
    async (csrf, session) => {
      const id = session.user.id;
      const keys = await session.services.apiKeys.list(id);

      // The reveal. Rendered into the POST response rather than reached by a redirect:
      // a live secret in a query string would be written to the access log, kept in browser
      // history, and sent onward as a `Referer` header. This way it exists in exactly one
      // response body and nowhere else.
      const revealBlock = reveal
        ? `<div class="panel" style="margin-bottom:1rem;border-color:rgba(143,187,255,.4)">
<div class="panel-head"><h2>${escapeHtml(reveal.label)}</h2>
  <button class="btn" type="button" data-secret-dismiss>پنهان کن</button></div>
<div data-secret-once class="key-reveal">
  <span>${escapeHtml(reveal.key)}</span>
  <button class="btn" type="button" data-copy="${escapeHtml(reveal.key)}">کپی</button>
</div>
<p style="margin:.9rem 0 0;font-size:.76rem;color:var(--owed);line-height:1.95">
این کلید فقط همین یک‌بار نشان داده می‌شود. ما فقط هش آن را داریم، پس اگر گمش کردید باید بچرخانید.
همین حالا در متغیر محیطی سرورتان ذخیره کنید — نه در کد و نه در مخزن گیت.
</p>
</div>`
        : '';

      const list =
        keys.length === 0
          ? emptyState({
              title: 'کلیدی ساخته نشده',
              body: 'بدون کلید API نمی‌توانید فاکتور بسازید. کلید تازه بسازید و در سرور خودتان ذخیره کنید.',
            })
          : `<div class="table-wrap"><table>
<thead><tr><th>کلید</th><th>محیط</th><th>دسترسی‌ها</th><th>آخرین استفاده</th><th>درخواست‌ها</th><th>وضعیت</th><th></th></tr></thead>
<tbody>${keys
              .map(
                (key) => `<tr>
<td><span class="mono" style="font-size:.74rem">${escapeHtml(key.hint)}</span>
  ${key.label ? `<div style="font-size:.68rem;color:var(--haze)">${escapeHtml(key.label)}</div>` : ''}</td>
<td>${badge(key.environment === 'live' ? 'LIVE' : 'TEST', key.environment === 'live' ? 'عملیاتی' : 'آزمایشی')}</td>
<td style="font-size:.72rem;color:var(--steel)">${
                  key.scopes.length === 0
                    ? '—'
                    : key.scopes.map((scope) => escapeHtml(SCOPE_LABELS[scope] ?? scope)).join(' · ')
                }</td>
<td style="font-size:.72rem;color:var(--steel);white-space:nowrap">${
                  key.lastUsedAt ? formatRelativeFa(key.lastUsedAt) : '<span style="color:var(--haze)">هرگز</span>'
                }</td>
<td class="num">${toPersianDigits(key.requestCount)}</td>
<td>${key.active ? badge('ACTIVE', 'فعال') : badge('REVOKED', 'باطل')}</td>
<td style="white-space:nowrap">
  ${
    key.active
      ? `<form method="post" action="/dashboard/api-keys/${escapeHtml(key.id)}/rotate" style="margin:0;display:inline">${csrf}
<button class="btn" type="submit" style="font-size:.7rem">چرخش</button></form>
<form method="post" action="/dashboard/api-keys/${escapeHtml(key.id)}/revoke" style="margin:0;display:inline">${csrf}
<button class="btn" type="submit" style="font-size:.7rem">باطل کن</button></form>`
      : ''
  }
</td>
</tr>`,
              )
              .join('')}</tbody></table></div>`;

      return `${revealBlock}
${panel('کلیدهای شما', list)}

<div class="grid-2" style="margin-top:1rem">
${panel(
  'ساخت کلید جدید',
  `<form method="post" action="/dashboard/api-keys/create" class="form">
${csrf}
<div class="field">
  <label for="key-label">برچسب</label>
  <input class="input" id="key-label" name="label" maxlength="60" placeholder="مثلاً سرور فروشگاه">
  <span class="hint">برای اینکه بعداً بفهمید کدام کلید مال کجاست.</span>
</div>
<div class="field">
  <label for="key-env">محیط</label>
  <select class="input" id="key-env" name="environment">
    <option value="live">عملیاتی — فاکتور واقعی می‌سازد</option>
    <option value="test">آزمایشی — کیف پول را دست نمی‌زند</option>
  </select>
</div>
<fieldset style="border:1px solid var(--seam);border-radius:var(--radius);padding:.85rem 1rem;margin:0">
  <legend style="font-size:.75rem;color:var(--steel);padding:0 .35rem">دسترسی‌ها</legend>
  <div class="stack" style="gap:.4rem">
    ${API_KEY_SCOPES.map(
        (scope) => `<label style="display:flex;gap:.5rem;align-items:center;font-size:.79rem">
      <input type="checkbox" name="scopes" value="${escapeHtml(scope)}"> ${escapeHtml(SCOPE_LABELS[scope] ?? scope)}
      <span class="mono" style="font-size:.65rem;color:var(--haze);margin-inline-start:auto">${escapeHtml(scope)}</span>
    </label>`,
      )
      .join('')}
  </div>
</fieldset>
<div class="field">
  <label for="key-ip">IP مجاز</label>
  <textarea class="input" id="key-ip" name="ipAllowlist" rows="3" style="direction:ltr;text-align:left;font-family:var(--mono)"
    placeholder="۱.۲.۳.۴&#10;۵.۶.۷.۸"></textarea>
  <span class="hint">هر خط یک IP. خالی بگذارید تا از هر IP پذیرفته شود. اگر پر کنید، درخواست از IP دیگر رد می‌شود.</span>
</div>
<div><button class="btn btn-primary" type="submit">ساخت کلید</button></div>
</form>`,
)}
${panel(
  'نگهداری کلید',
  `<p style="margin:0;font-size:.82rem;line-height:2.1;color:var(--steel)">
کلید را در متغیر محیطی نگه دارید و آن را در مخزن گیت نگذارید. اگر جایی عمومی منتشر شد،
<b>چرخش</b> بزنید: کلید تازه ساخته می‌شود و کلید قدیمی در همان عملیات باطل می‌گردد، پس هیچ لحظه‌ای دو کلید زنده ندارید.
</p>
<p style="margin:.9rem 0 0;font-size:.82rem;line-height:2.1;color:var(--steel)">
شکل کلید: ${'<span class="mono" style="font-size:.75rem">sk_live_</span>'} به‌علاوه ۴۴ نویسه.
اگر گیت‌هاب کلید شما را به‌اشتباه «کلید Stripe» گزارش کرد، این گزارش نادرست است اما بی‌ضرر:
ما فقط هش کلید را داریم.
</p>`,
)}
</div>`;
    },
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** Whether an endpoint will actually be handed a delivery. */
function isDeliverable(endpoint: { is_active: number; disabled_at: string | null }): boolean {
  return endpoint.is_active === 1 && endpoint.disabled_at === null;
}

const DELIVERY_TONE: Record<string, string> = {
  DELIVERED: 'paid',
  PENDING: 'pending',
  FAILED: 'expired',
  DEAD: 'dead',
  SKIPPED: 'cancelled',
};

async function webhooksPage(
  c: RouteContext,
  notice?: PageInput['notice'],
  reveal?: { label: string; secret: string },
): Promise<Response> {
  return render(
    c,
    {
      title: 'وب‌هوک — Steve Pay',
      heading: 'وب‌هوک',
      subheading: 'رویدادهای پرداخت با امضای HMAC به سرور شما می‌روند',
      path: '/dashboard/webhooks',
      eyebrow: 'WEBHOOKS',
      ...(notice !== undefined ? { notice } : {}),
    },
    async (csrf, session) => {
      const services = session.services;
      const id = session.user.id;

      const [endpoints, deliveries, stats] = await Promise.all([
        services.webhooks.listEndpoints(id),
        services.webhooks.listDeliveries({ merchantUserId: id, limit: 25 }),
        services.webhooks.deliveryStats(id, new Date(Date.now() - 7 * 86_400_000).toISOString()),
      ]);

      const revealBlock = reveal
        ? `<div class="panel" style="margin-bottom:1rem;border-color:rgba(143,187,255,.4)">
<div class="panel-head"><h2>راز امضای ${escapeHtml(reveal.label)}</h2>
  <button class="btn" type="button" data-secret-dismiss>پنهان کن</button></div>
<div data-secret-once class="key-reveal">
  <span>${escapeHtml(reveal.secret)}</span>
  <button class="btn" type="button" data-copy="${escapeHtml(reveal.secret)}">کپی</button>
</div>
<p style="margin:.9rem 0 0;font-size:.76rem;color:var(--steel);line-height:1.95">
با همین راز، هدر <span class="mono">X-StevePay-Signature</span> را بررسی کنید. نمونه کد در
<a href="/docs#webhooks">مستندات</a> هست.
</p>
</div>`
        : '';

      const endpointList =
        endpoints.length === 0
          ? emptyState({
              title: 'آدرسی تنظیم نشده',
              body: 'بدون آدرس وب‌هوک، سفارش‌های شما فقط با مراجعه به پنل تأیید می‌شوند. آدرسی بسازید تا تأیید خودکار به سرورتان برسد.',
            })
          : `<div class="stack">${endpoints
              .map(
                (endpoint) => `<div class="panel">
<div class="panel-head">
  <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
    <span class="mono" style="font-size:.76rem;word-break:break-all">${escapeHtml(endpoint.url)}</span>
    ${endpoint.is_default === 1 ? badge('ACTIVE', 'پیش‌فرض') : ''}
    ${
      // "Active" means two columns, not one: delivery is skipped for an endpoint that is
      // switched on but was shut down automatically. Reading only `is_active` here made the
      // page show "فعال" next to a badge saying it had been disabled, which is how an
      // operator concludes the system is quietly broken.
      isDeliverable(endpoint)
        ? badge('ACTIVE', 'فعال')
        : endpoint.disabled_at
          ? badge('REJECTED', 'خودکار غیرفعال شده')
          : badge('SUSPENDED', 'غیرفعال')
    }
  </div>
  <div style="display:flex;gap:.4rem;flex-wrap:wrap">
    <form method="post" action="/dashboard/webhooks/${escapeHtml(endpoint.id)}/reveal" style="margin:0">${csrf}
<button class="btn" type="submit" style="font-size:.7rem">نمایش راز</button></form>
    <form method="post" action="/dashboard/webhooks/${escapeHtml(endpoint.id)}/rotate" style="margin:0">${csrf}
<button class="btn" type="submit" style="font-size:.7rem">چرخش راز</button></form>
    <form method="post" action="/dashboard/webhooks/${escapeHtml(endpoint.id)}/toggle" style="margin:0">${csrf}
<button class="btn" type="submit" style="font-size:.7rem">${isDeliverable(endpoint) ? 'غیرفعال کن' : 'فعال کن'}</button></form>
    <form method="post" action="/dashboard/webhooks/${escapeHtml(endpoint.id)}/delete" style="margin:0">${csrf}
<button class="btn" type="submit" style="font-size:.7rem">حذف</button></form>
  </div>
</div>
<dl class="receipt-rows">
${row('راز امضا', `<span class="mono">${escapeHtml(endpoint.secret_hint)}</span>`)}
${row('رویدادها', endpoint.eventsList.includes('*') ? 'همه رویدادها' : endpoint.eventsList.map((event) => escapeHtml(event)).join(' · '))}
${row('کل تحویل', toPersianDigits(endpoint.total_deliveries))}
${row('شکست‌های پیاپی', toPersianDigits(endpoint.consecutive_failures), endpoint.consecutive_failures > 0 ? 'failed' : 'plain')}
${endpoint.disabled_reason ? row('دلیل غیرفعالی', escapeHtml(endpoint.disabled_reason), 'failed') : ''}
</dl>
</div>`,
              )
              .join('')}</div>`;

      return `${revealBlock}
<div class="grid-3">
${stat({ label: 'تحویل موفق (۷ روز)', value: toPersianDigits(stats.delivered), tone: 'settle' })}
${stat({ label: 'در صف', value: toPersianDigits(stats.pending) })}
${stat({
  label: 'ناموفق (۷ روز)',
  value: toPersianDigits(stats.failed),
  ...(stats.failed > 0 ? { tone: 'reject' as const } : {}),
})}
</div>

<div style="margin-top:1rem">${panel('آدرس‌های شما', endpointList)}</div>

<div class="grid-2" style="margin-top:1rem">
${panel(
  'افزودن آدرس',
  `<form method="post" action="/dashboard/webhooks/create" class="form">
${csrf}
<div class="field">
  <label for="hook-url">آدرس</label>
  <input class="input" id="hook-url" name="url" type="url" placeholder="https://shop.example.com/pay/callback"
    style="direction:ltr;text-align:left;font-family:var(--mono)" required>
  <span class="hint">باید HTTPS باشد و روی دامنه‌ای باشد که مالکش هستید.</span>
</div>
<fieldset style="border:1px solid var(--seam);border-radius:var(--radius);padding:.85rem 1rem;margin:0">
  <legend style="font-size:.75rem;color:var(--steel);padding:0 .35rem">رویدادها</legend>
  <div class="stack" style="gap:.4rem">
    <label style="display:flex;gap:.5rem;align-items:center;font-size:.79rem">
      <input type="checkbox" name="events" value="*" checked> همه رویدادها
      <span class="mono" style="font-size:.65rem;color:var(--haze);margin-inline-start:auto">*</span>
    </label>
    ${WEBHOOK_EVENTS.map(
      (event) => `<label style="display:flex;gap:.5rem;align-items:center;font-size:.79rem">
      <input type="checkbox" name="events" value="${escapeHtml(event)}"> ${escapeHtml(event)}
    </label>`,
    ).join('')}
  </div>
</fieldset>
<div class="field"><label for="hook-desc">توضیح</label>
  <input class="input" id="hook-desc" name="description" maxlength="120" placeholder="اختیاری"></div>
<div><button class="btn btn-primary" type="submit">ثبت آدرس</button></div>
</form>`,
)}
${panel(
  'آزمایش اتصال',
  `${
    endpoints.length === 0
      ? alert('info', 'برای آزمایش، اول یک آدرس ثبت کنید.')
      : `<form method="post" action="/dashboard/webhooks/test" style="margin:0 0 1rem">${csrf}
<button class="btn btn-primary" type="submit">فرستادن رویداد آزمایشی</button></form>`
  }
<p style="margin:0;font-size:.82rem;line-height:2.1;color:var(--steel)">
رویداد <span class="mono">test.pipeline</span> با همان امضا و همان هدرها فرستاده می‌شود، پس اگر تحویلش موفق شد،
مسیر واقعی هم کار می‌کند. اگر سرور شما پاسخ ۲xx ندهد، دوباره تلاش می‌شود:
<span class="mono" style="font-size:.72rem">۱ دقیقه → ۵ دقیقه → ۳۰ دقیقه → ۲ ساعت → ۱۲ ساعت → ۲۴ ساعت</span>
</p>
<p style="margin:.9rem 0 0;font-size:.82rem;line-height:2.1;color:var(--steel)">
هندلر شما باید تحویل تکراری را تحمل کند: یک رویداد ممکن است بیش از یک‌بار برسد.
با <span class="mono" style="font-size:.72rem">X-StevePay-Delivery</span> تشخیصش دهید و بی‌صدا ۲۰۰ بدهید.
</p>`,
)}
</div>

<div style="margin-top:1rem">
${panel(
  'آخرین تحویل‌ها',
  deliveries.length === 0
    ? emptyState({
        title: 'تحویلی ثبت نشده',
        body: 'بعد از اولین پرداخت تأییدشده، ارسال‌ها و پاسخ سرور شما همین‌جا ثبت می‌شود.',
      })
    : `<div class="table-wrap"><table>
<thead><tr><th>رویداد</th><th>وضعیت</th><th>تلاش</th><th>پاسخ سرور شما</th><th>زمان</th><th></th></tr></thead>
<tbody>${deliveries
        .map(
          (delivery) => `<tr>
<td><span class="mono" style="font-size:.72rem">${escapeHtml(delivery.event)}</span>
  <div style="font-size:.68rem;color:var(--haze);word-break:break-all">${escapeHtml(delivery.url)}</div></td>
<td><span class="badge badge-${DELIVERY_TONE[delivery.status] ?? 'pending'}"><i aria-hidden="true"></i>${escapeHtml(
            delivery.status,
          )}</span></td>
<td class="num">${toPersianDigits(delivery.attempt_count)} / ${toPersianDigits(delivery.max_attempts)}</td>
<td>${
            delivery.response_status === null
              ? `<span style="color:var(--failed);font-size:.74rem">${escapeHtml(delivery.last_error ?? '—')}</span>`
              : `<span class="num">${toPersianDigits(delivery.response_status)}</span>`
          }
  ${
    delivery.response_body_preview
      ? `<div style="font-size:.66rem;color:var(--haze);max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" dir="ltr">${escapeHtml(
          delivery.response_body_preview,
        )}</div>`
      : ''
  }</td>
<td style="font-size:.74rem;color:var(--steel);white-space:nowrap">${formatJalaliDateTime(delivery.created_at)}</td>
<td>${
            delivery.status === 'DELIVERED'
              ? ''
              : `<form method="post" action="/dashboard/webhooks/deliveries/${escapeHtml(delivery.id)}/retry" style="margin:0">${csrf}
<button class="btn" type="submit" style="font-size:.7rem">تلاش دوباره</button></form>`
          }</td>
</tr>`,
        )
        .join('')}</tbody></table></div>`,
  '<span class="mono" style="font-size:.68rem;color:var(--haze)">LAST 25</span>',
)}
</div>`;
    },
  );
}

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

const SMS_STATUS_FA: Record<string, string> = {
  PARSED: 'تجزیه‌شده',
  FAILED: 'تجزیه‌نشده',
  IGNORED: 'نادیده',
  TEST: 'آزمایشی',
  DUPLICATE: 'تکراری',
};

async function smsPage(
  c: RouteContext,
  notice?: PageInput['notice'],
  token?: { token: string; message: string; expiresAt: string },
): Promise<Response> {
  return render(
    c,
    {
      title: 'پیامک بانک — Steve Pay',
      heading: 'پیامک بانک',
      subheading: 'تنها مسیری که یک پرداخت را تأیید می‌کند',
      path: '/dashboard/sms',
      eyebrow: 'BANK SMS',
      ...(notice !== undefined ? { notice } : {}),
    },
    async (csrf, session) => {
      const services = session.services;
      const id = session.user.id;

      const [status, match, messages, countsRaw] = await Promise.all([
        services.sms.testTokenStatus(id),
        services.sms.matchConfig(id),
        services.sms.list({ merchantUserId: id, limit: 25 }),
        services.sms.counts(id),
      ]);

      const counts = {
        total: countsRaw['total'] ?? 0,
        parsed: countsRaw['parsed'] ?? 0,
        failed: countsRaw['failed'] ?? 0,
        test: countsRaw['test'] ?? 0,
      };

      const webhookUrl = absoluteUrl(c.get('appContext').origin, '/sms');

      const tokenBlock = token
        ? `<div class="panel" style="margin-bottom:1rem;border-color:rgba(143,187,255,.4)">
<div class="panel-head"><h2>توکن آزمایشی</h2>
  <span class="mono" style="font-size:.68rem;color:var(--haze)">EXPIRES ${toPersianDigits(
    Math.max(0, Math.round((new Date(token.expiresAt).getTime() - Date.now()) / 60000)),
  )}m</span></div>
<p style="margin:0 0 .75rem;font-size:.82rem;color:var(--steel);line-height:1.95">
این پیامک را عیناً در برنامه فورواردر بگذارید و بفرستید. اگر رسید، مسیر درست است.
</p>
<div class="key-reveal"><span dir="auto">${escapeHtml(token.message)}</span>
  <button class="btn" type="button" data-copy="${escapeHtml(token.message)}">کپی پیامک</button></div>
</div>`
        : '';

      const connection = status.connected
        ? `<div class="panel" style="border-color:rgba(46,224,162,.34)">
<div class="panel-head"><h2>مسیر پیامک وصل است</h2>${badge('CONNECTED', 'وصل')}</div>
${rows(
  row('آخرین پیامک تأییدشده', jalali(status.verifiedAt)),
  row('آدرس ارسال', `<span class="mono" style="font-size:.72rem">${escapeHtml(webhookUrl)}</span>`),
)}
</div>`
        : `<div class="panel" style="border-color:rgba(255,180,36,.34)">
<div class="panel-head"><h2>هنوز پیامکی نرسیده</h2>${badge('PENDING', 'در انتظار')}</div>
<p style="margin:0;font-size:.83rem;line-height:2.05;color:var(--steel)">
تا این مرحله تکمیل نشود، پول مشتری واریز می‌شود ولی فاکتور خودکار تأیید نمی‌شود و باید دستی بررسی کنید.
</p>
</div>`;

      return `${tokenBlock}
<div class="grid-2">
${connection}
${panel(
  'چطور وصل می‌شود',
  `<ol style="margin:0;padding-inline-start:1.2rem;font-size:.83rem;line-height:2.1;color:var(--steel)">
<li>روی گوشی اندرویدی که پیامک بانک را می‌گیرد، یک برنامه فورواردر پیامک نصب کنید.</li>
<li>مقصد را به <span class="mono" style="font-size:.75rem">${escapeHtml(webhookUrl)}</span> تنظیم کنید، با روش POST.</li>
<li>هدر <span class="mono" style="font-size:.75rem">X-API-Key</span> را با کلید عملیاتی خودتان پر کنید.</li>
<li>بدنه را JSON بگذارید و فیلد <span class="mono" style="font-size:.75rem">message</span> را به متن پیامک نگاشت کنید.</li>
<li>فقط شماره‌های بانکی را فوروارد کنید، نه همه پیامک‌ها — رمزهای یک‌بارمصرف بانک هم پیامک هستند.</li>
</ol>
<div style="display:flex;gap:.5rem;margin-top:1rem;flex-wrap:wrap">
  <form method="post" action="/dashboard/sms/test-token" style="margin:0">${csrf}
  <button class="btn btn-primary" type="submit">ساخت توکن آزمایشی</button></form>
  <button class="btn" type="button" data-copy="${escapeHtml(webhookUrl)}">کپی آدرس</button>
  <a class="btn" href="/docs#sms">راهنمای کامل</a>
</div>`,
)}
</div>

<div class="grid-4" style="margin-top:1rem">
${stat({ label: 'کل پیامک', value: toPersianDigits(counts.total) })}
${stat({ label: 'تجزیه‌شده', value: toPersianDigits(counts.parsed), tone: 'settle' })}
${stat({
  label: 'تجزیه‌نشده',
  value: toPersianDigits(counts.failed),
  ...(counts.failed > 0 ? { tone: 'amber' as const } : {}),
})}
${stat({ label: 'آزمایشی', value: toPersianDigits(counts.test) })}
</div>

<div class="grid-2" style="margin-top:1rem">
${panel(
  'قواعد تطبیق',
  rows(
    row('پنجره زمانی قبل از فاکتور', `${toPersianDigits(match.timeWindowMinutesBefore)} دقیقه`),
    row('پنجره زمانی بعد از فاکتور', `${toPersianDigits(match.timeWindowMinutesAfter)} دقیقه`),
    row('تطبیق کارت مقصد', match.requireCardMatch ? 'اجباری' : 'اختیاری'),
    row('حداقل اطمینان برای تأیید خودکار', `${toPersianDigits(match.minConfidenceAutoConfirm)}٪`),
    row('تأیید خودکار', match.autoConfirmEnabled ? 'فعال' : 'غیرفعال', match.autoConfirmEnabled ? 'settle' : 'owed'),
  ) +
    `<p style="margin:.9rem 0 0;font-size:.73rem;color:var(--haze);line-height:1.95">
مبلغ باید دقیقاً برابر مبلغ قابل پرداخت یک فاکتور زنده باشد. پیامکی که دقیقاً به یک فاکتور نخورد،
تأیید نمی‌کند؛ اگر مشکوک باشد، پرداخت به صف بررسی دستی می‌رود و پول تا تصمیم مدیر معلق می‌ماند.
</p>`,
)}
${panel(
  'چرا فرستنده را محدود کنید',
  `<p style="margin:0;font-size:.82rem;line-height:2.1;color:var(--steel)">
متن پیامک بانک گاهی موجودی حساب شما را دارد. سامانه پیامک‌های بی‌ربط را جایی منتشر نمی‌کند،
اما هر پیامکی که بفرستید و ذخیره شود، داده‌ای است که باید مراقبش باشید.
</p>
<p style="margin:.9rem 0 0;font-size:.82rem;line-height:2.1;color:var(--steel)">
ساعت اعلامی برنامه فورواردر مبنای تطبیق نیست — مبنای ما زمان سرور است، چون گوشی با ساعت غلط
می‌توانست یک پرداخت را داخل پنجره زمانی بگذارد.
</p>`,
)}
</div>

<div style="margin-top:1rem">
${panel(
  'آخرین پیامک‌ها',
  messages.length === 0
    ? emptyState({
        title: 'پیامکی نرسیده',
        body: 'بعد از تنظیم فورواردر، پیامک‌های بانک با متن کامل و نتیجه تجزیه همین‌جا ثبت می‌شوند.',
      })
    : `<div class="table-wrap"><table>
<thead><tr><th>متن پیامک</th><th>وضعیت</th><th>مبلغ خوانده‌شده</th><th>پیگیری</th><th>زمان</th></tr></thead>
<tbody>${messages
        .map((message) => {
          const status0 = String(message['parse_status'] ?? '');
          const statusLabelFa = SMS_STATUS_FA[status0] ?? status0;
          const amount = message['amount_toman'] as number | null;
          const warnings = message['warnings'] as string | null;
          return `<tr>
<td style="max-width:24rem">
  <div dir="auto" style="font-size:.79rem;color:var(--ice);line-height:1.9;word-break:break-word">${escapeHtml(
    String(message['raw_message'] ?? '').slice(0, 240),
  )}</div>
  <div style="font-size:.66rem;color:var(--haze)">
    فرستنده: <span class="mono">${escapeHtml(String(message['sender'] ?? 'نامشخص'))}</span>
    ${warnings && warnings !== '[]' ? ` · <span style="color:var(--owed)">هشدار تجزیه</span>` : ''}
  </div>
</td>
<td><span class="badge badge-${
            status0 === 'PARSED' ? 'paid' : status0 === 'FAILED' ? 'pending' : 'review'
          }"><i aria-hidden="true"></i>${escapeHtml(statusLabelFa)}</span>
  ${
    message['bank'] ? `<div style="font-size:.66rem;color:var(--haze)">${escapeHtml(String(message['bank']))}</div>` : ''
  }</td>
<td class="num">${amount === null ? '<span style="color:var(--haze)">—</span>' : formatTomanFa(amount)}</td>
<td style="font-size:.72rem" class="mono">${
            message['reference'] ? escapeHtml(String(message['reference'])) : '—'
          }</td>
<td style="font-size:.72rem;color:var(--steel);white-space:nowrap">${formatJalaliDateTime(
            String(message['server_received_at'] ?? ''),
          )}</td>
</tr>`;
        })
        .join('')}</tbody></table></div>`,
  '<span class="mono" style="font-size:.68rem;color:var(--haze)">LAST 25</span>',
)}
</div>`;
    },
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function settingsPage(c: RouteContext, notice?: PageInput['notice']): Promise<Response> {
  return render(
    c,
    {
      title: 'تنظیمات پرداخت — Steve Pay',
      heading: 'تنظیمات پرداخت',
      subheading: 'پیش‌فرض‌هایی که روی فاکتورهای تازه اعمال می‌شوند',
      path: '/dashboard/settings',
      eyebrow: 'PAYMENT SETTINGS',
      ...(notice !== undefined ? { notice } : {}),
    },
    async (csrf, session) => {
      const services = session.services;
      const id = session.user.id;

      const [overrides, platformFee, platformMode, defaultExpiry, minExpiry, maxExpiry, minAmount, maxAmount] =
        await Promise.all([
          services.settings.merchantMap(id),
          services.settings.int('gateway.fee_toman'),
          services.settings.feeModeDefault(),
          services.settings.int('invoices.expiry_minutes_default'),
          services.settings.int('invoices.expiry_minutes_min'),
          services.settings.int('invoices.expiry_minutes_max'),
          services.settings.int('invoices.min_amount_toman'),
          services.settings.int('invoices.max_amount_toman'),
        ]);

      const feeOverride = overrides['invoices.gateway_fee'];
      const feeMode = overrides['invoices.fee_mode'];
      const expiry = overrides['invoices.expiry_minutes'];
      const customerMessage = overrides['invoices.customer_message'];

      return panel(
        'پیش‌فرض‌های فاکتور',
        `<form method="post" action="/dashboard/settings" class="form">
${csrf}
<div class="field">
  <label for="fee-mode">کارمزد را چه کسی می‌دهد</label>
  <select class="input" id="fee-mode" name="feeMode">
    <option value=""${feeMode ? '' : ' selected'}>مطابق پیش‌فرض سامانه (${
      platformMode === 'MERCHANT' ? 'از پذیرنده' : 'از مشتری'
    })</option>
    <option value="CUSTOMER"${feeMode === 'CUSTOMER' ? ' selected' : ''}>مشتری روی مبلغ اضافه می‌کند</option>
    <option value="MERCHANT"${feeMode === 'MERCHANT' ? ' selected' : ''}>از کیف پول من کسر شود</option>
  </select>
  <span class="hint">این انتخاب «چه کسی می‌پردازد» را عوض می‌کند، نه «چقدر». مبلغ کارمزد یکسان است.</span>
</div>
<div class="field">
  <label for="fee">مبلغ کارمزد هر فاکتور (تومان)</label>
  <input class="input num" id="fee" name="gatewayFee" inputmode="numeric"
    value="${escapeHtml(feeOverride ?? '')}" placeholder="${toPersianDigits(formatTomanFa(platformFee))}">
  <span class="hint">خالی بگذارید تا پیش‌فرض سامانه (${toPersianDigits(
    formatTomanFa(platformFee),
  )} تومان) اعمال شود. صفر یعنی بدون کارمزد.</span>
</div>
<div class="field">
  <label for="expiry">مهلت پرداخت پیش‌فرض (دقیقه)</label>
  <input class="input num" id="expiry" name="expiryMinutes" inputmode="numeric"
    value="${escapeHtml(expiry ?? '')}" placeholder="${toPersianDigits(defaultExpiry)}">
  <span class="hint">بازه مجاز: ${toPersianDigits(minExpiry)} تا ${toPersianDigits(maxExpiry)} دقیقه.</span>
</div>
<div class="field">
  <label for="message">پیامی که به مشتری نشان داده می‌شود</label>
  <textarea class="input" id="message" name="customerMessage" rows="4" maxlength="500"
    placeholder="اختیاری">${escapeHtml(customerMessage ?? '')}</textarea>
  <span class="hint">روی صفحه پرداخت، زیر مبلغ، برای همه فاکتورهای شما نمایش داده می‌شود.</span>
</div>
<div><button class="btn btn-primary" type="submit">ذخیره تنظیمات</button></div>
</form>`,
        `<span class="mono" style="font-size:.68rem;color:var(--haze)">DEFAULTS</span>`,
      ) +
        `<div class="grid-2" style="margin-top:1rem">
${panel(
  'مقادیر سامانه',
  rows(
    row('کارمزد پایه سامانه', toman(platformFee)),
    row('حالت پیش‌فرض کارمزد', platformMode === 'MERCHANT' ? 'از پذیرنده' : 'از مشتری'),
    row('حداقل مبلغ فاکتور', toman(minAmount)),
    row('حداکثر مبلغ فاکتور', toman(maxAmount)),
    row('تعداد ارقام پسوند یکتا', toPersianDigits(4)),
  ),
)}
${panel(
  'آنچه اینجا تغییر نمی‌کند',
  `<p style="margin:0;font-size:.82rem;line-height:2.1;color:var(--steel)">
محدودیت نرخ، قواعد تطبیق پیامک و دامنه‌های مجاز وب‌هوک در سطح سامانه تعیین می‌شوند، نه در حساب شما.
اگر به مقدار دیگری نیاز دارید، از پشتیبانی بخواهید — تغییرشان برای همه پذیرندگان اثر دارد.
</p>
<p style="margin:.9rem 0 0;font-size:.78rem;color:var(--haze);line-height:1.95">
تنظیمات فقط روی فاکتورهای تازه اثر می‌گذارد. فاکتوری که ساخته شده، مبلغ و شرایطش ثبت شده است و
تغییر پیش‌فرض آن را عوض نمی‌کند.
</p>`,
)}
</div>`;
    },
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function notificationsPage(c: RouteContext): Promise<Response> {
  return render(
    c,
    {
      title: 'اطلاعیه‌ها — Steve Pay',
      heading: 'اطلاعیه‌ها',
      subheading: 'رویدادهایی که سامانه به شما خبر می‌دهد',
      path: '/dashboard/notifications',
      eyebrow: 'NOTIFICATIONS',
    },
    async (csrf, session) => {
      const feed = await session.services.notifications.feed(session.user.id, session.user.role, {
        limit: 50,
      });

      const markAll =
        feed.some((item) => !item.read) && feed.length > 0
          ? `<form method="post" action="/dashboard/notifications/read" style="margin:0">${csrf}
<input type="hidden" name="scope" value="all">
<button class="btn" type="submit">همه را خوانده‌شده کن</button></form>`
          : '';

      return panel(
        'صندوق اطلاعیه‌ها',
        feed.length === 0
          ? emptyState({
              title: 'اطلاعیه‌ای نیست',
              body: 'خبرهای مربوط به پرداخت‌ها، موجودی کیف پول و وضعیت حساب همین‌جا می‌آید.',
            })
          : `<div class="stack">${feed
              .map(
                (item) => `<div class="panel" style="padding:.9rem 1rem;${
                  item.read ? '' : 'border-color:rgba(143,187,255,.3)'
                }">
<div style="display:flex;gap:.6rem;align-items:flex-start">
  <span class="dot" style="--state:${item.read ? 'var(--seam)' : 'var(--signal)'};margin-top:.45rem" aria-hidden="true"></span>
  <div style="flex:1;min-width:0">
    <div style="font-weight:${item.read ? '400' : '600'};font-size:.88rem">${escapeHtml(item.title)}</div>
    <p style="margin:.3rem 0 0;font-size:.8rem;line-height:1.95;color:var(--steel)">${escapeHtml(item.body)}</p>
    <div style="display:flex;gap:.75rem;align-items:center;margin-top:.5rem;flex-wrap:wrap">
      <span class="mono" style="font-size:.66rem;color:var(--haze)">${escapeHtml(item.type)} · ${escapeHtml(
        item.created_at,
      )}</span>
      ${item.link ? `<a href="${escapeHtml(item.link)}" style="font-size:.75rem">دیدن</a>` : ''}
      ${
        item.read
          ? ''
          : `<form method="post" action="/dashboard/notifications/read" style="margin:0">${csrf}
<input type="hidden" name="id" value="${escapeHtml(item.id)}">
<button class="btn" type="submit" style="font-size:.68rem;padding:.15rem .45rem">خوانده شد</button></form>`
      }
    </div>
  </div>
</div>
</div>`,
              )
              .join('')}</div>`,
        markAll,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

async function profilePage(c: RouteContext, notice?: PageInput['notice']): Promise<Response> {
  return render(
    c,
    {
      title: 'پروفایل فروشگاه — Steve Pay',
      heading: 'پروفایل فروشگاه',
      subheading: 'نام و اطلاعاتی که روی صفحه پرداخت دیده می‌شود',
      path: '/dashboard/profile',
      eyebrow: 'STORE PROFILE',
      ...(notice !== undefined ? { notice } : {}),
    },
    async (csrf, session) => {
      const profile = await session.services.merchants.profile(session.user.id);

      const value = (input: string | null | undefined): string => escapeHtml(input ?? '');

      return `<div class="grid-2">
${panel(
  'شناسه حساب',
  rows(
    row('شماره موبایل', `<span class="mono">${escapeHtml(session.user.mobile)}</span>`),
    row('کد پذیرنده', `<span class="mono">${escapeHtml(profile?.merchant_code ?? '—')}</span>`),
    row('وضعیت حساب', escapeHtml(session.user.status)),
    row('نوع کسب‌وکار', escapeHtml(profile?.business_type ?? '—')),
    row('عضویت از', jalali(profile?.created_at ?? null)),
  ) +
    `<p style="margin:.9rem 0 0;font-size:.74rem;color:var(--haze);line-height:1.95">
شماره موبایل شناسه ورود شماست و از این صفحه تغییر نمی‌کند.
</p>`,
)}
${panel(
  'اطلاعات نمایشی',
  `<form method="post" action="/dashboard/profile" class="form">
${csrf}
<div class="field"><label for="display">نام فروشگاه</label>
  <input class="input" id="display" name="displayName" maxlength="80" value="${value(profile?.display_name)}">
  <span class="hint">روی صفحه پرداخت، بالای مبلغ دیده می‌شود.</span></div>
<div class="field"><label for="logo">نشانی لوگو</label>
  <input class="input" id="logo" name="logoUrl" type="url" maxlength="300" value="${value(profile?.logo_url)}"
    style="direction:ltr;text-align:left;font-family:var(--mono)" placeholder="https://…/logo.png">
  <span class="hint">تصویر مربعی، ترجیحاً PNG یا SVG.</span></div>
<div class="field"><label for="website">وب‌سایت</label>
  <input class="input" id="website" name="websiteUrl" type="url" maxlength="300" value="${value(profile?.website_url)}"
    style="direction:ltr;text-align:left;font-family:var(--mono)"></div>
<div class="field"><label for="support">راه تماس پشتیبانی</label>
  <input class="input" id="support" name="supportContact" maxlength="120" value="${value(profile?.support_contact)}"
    placeholder="شماره تلفن یا آدرس صفحه پشتیبانی"></div>
<div class="field"><label for="support-url">نشانی صفحه پشتیبانی</label>
  <input class="input" id="support-url" name="supportUrl" type="url" maxlength="300" value="${value(profile?.support_url)}"
    style="direction:ltr;text-align:left;font-family:var(--mono)"></div>
<div class="field"><label for="about">درباره کسب‌وکار</label>
  <textarea class="input" id="about" name="businessDescription" rows="4" maxlength="500">${value(
    profile?.business_description,
  )}</textarea>
  <span class="hint">برای بررسی حساب توسط مدیر و برای مشتری‌ای که می‌خواهد بداند پول را به که می‌دهد.</span></div>
<div class="field"><label for="tg">نام کاربری تلگرام</label>
  <input class="input" id="tg" name="telegramUsername" maxlength="64" value="${value(profile?.telegram_username)}"
    style="direction:ltr;text-align:left;font-family:var(--mono)" placeholder="بدون @">
  <span class="hint">عوض‌کردن این مقدار، تأیید مالکیت قبلی را باطل می‌کند و باید دوباره تأیید شود.</span></div>
<label style="display:flex;gap:.5rem;align-items:center;font-size:.8rem">
  <input type="checkbox" name="telegramAlerts" value="1"${profile?.telegram_alerts === 1 ? ' checked' : ''}>
  هشدارها را در تلگرام بگیرم
</label>
<div><button class="btn btn-primary" type="submit">ذخیره پروفایل</button></div>
</form>`,
)}
</div>`;
    },
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Splits a textarea of IPs into a list, discarding blanks. */
function splitList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function registerDashboardRoutes(app: Hono<AppEnv>): void {
  // --- reads --------------------------------------------------------------
  app.get('/dashboard', overviewPage);
  app.get('/dashboard/payments', paymentsPage);
  app.get('/dashboard/payments/:invoiceId', paymentDetailPage);
  app.get('/dashboard/wallet', walletPage);
  app.get('/dashboard/cards', (c) => cardsPage(c));
  app.get('/dashboard/api-keys', (c) => apiKeysPage(c));
  app.get('/dashboard/webhooks', (c) => webhooksPage(c));
  app.get('/dashboard/sms', (c) => smsPage(c));
  app.get('/dashboard/settings', (c) => settingsPage(c));
  app.get('/dashboard/notifications', notificationsPage);
  app.get('/dashboard/profile', (c) => profilePage(c));

  // --- invoice cancellation (§ the one merchant-side state change) ---------
  app.post('/dashboard/payments/:invoiceId/cancel', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);

    const invoice = await session.services.invoices.getForMerchant(
      session.user.id,
      c.req.param('invoiceId') ?? '',
    );
    if (!invoice) return failTo('/dashboard/payments', 'invoice_not_found');
    if (!isPayable(invoice.status)) return failTo(`/dashboard/payments/${invoice.id}`, 'invoice_not_cancellable');

    try {
      await session.services.invoices.transition(invoice.id, 'CANCELLED' as InvoiceStatus, {
        reason: 'لغو توسط پذیرنده',
        requestId: c.get('appContext').requestId,
        actorUserId: session.user.id,
        actorRole: 'MERCHANT',
      });
    } catch (error) {
      return failTo(`/dashboard/payments/${invoice.id}`, errorCode(error, 'invoice_not_cancellable'));
    }

    return backTo(`/dashboard/payments/${invoice.id}`, 'invoice_cancelled');
  });

  // --- cards --------------------------------------------------------------
  app.post('/dashboard/cards/create', async (c) => {
    const session = await requireMerchant(c);
    const form = await readForm(c);

    const number = form.value('number').replace(/[\s-]/g, '');
    const title = form.value('title') || 'کارت';
    if (!number) return cardsPage(c, { tone: 'error', text: 'شماره کارت را وارد کنید.' });

    try {
      await session.services.cards.create(
        session.user.id,
        {
          number,
          title,
          bankName: form.value('bankName') || null,
          holderName: form.value('holderName') || null,
          isDefault: form.value('isDefault') === '1',
        },
        actorOf(c, session),
        c.get('appContext').requestId,
      );
    } catch (error) {
      return cardsPage(c, {
        tone: 'error',
        text:
          error instanceof AppError && error.public
            ? error.message
            : (messageFor(errorCode(error, 'card_invalid'))?.text ?? 'ثبت کارت انجام نشد.'),
      });
    }

    return backTo('/dashboard/cards', 'card_created');
  });

  app.post('/dashboard/cards/:cardId/update', async (c) => {
    const session = await requireMerchant(c);
    const form = await readForm(c);

    try {
      await session.services.cards.update(
        session.user.id,
        c.req.param('cardId') ?? '',
        {
          title: form.value('title') || 'کارت',
          bankName: form.value('bankName') || null,
          holderName: form.value('holderName') || null,
        },
        actorOf(c, session),
        c.get('appContext').requestId,
      );
    } catch (error) {
      return failTo('/dashboard/cards', errorCode(error, 'card_not_found'));
    }

    return backTo('/dashboard/cards', 'card_updated');
  });

  app.post('/dashboard/cards/:cardId/default', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);
    try {
      await session.services.cards.setDefault(session.user.id, c.req.param('cardId') ?? '', actorOf(c, session));
    } catch (error) {
      return failTo('/dashboard/cards', errorCode(error, 'card_not_found'));
    }
    return backTo('/dashboard/cards', 'card_default');
  });

  /**
   * Deactivate, never delete.
   *
   * A card referenced by any invoice cannot be deleted — the invoice keeps the reference so
   * a historical receipt can still say where the money went, and cascading would erase an
   * audit trail. `CardService.remove` decides which of the two happened and the message says
   * which, rather than claiming a deletion that did not occur.
   */
  app.post('/dashboard/cards/:cardId/toggle', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);

    const cardId = c.req.param('cardId') ?? '';
    const card = (await session.services.cards.list(session.user.id)).find((entry) => entry.id === cardId);
    if (!card) return failTo('/dashboard/cards', 'card_not_found');

    try {
      await session.services.cards.update(
        session.user.id,
        cardId,
        { isActive: !card.isActive },
        actorOf(c, session),
        c.get('appContext').requestId,
      );
    } catch (error) {
      return failTo('/dashboard/cards', errorCode(error, 'card_not_found'));
    }

    return backTo('/dashboard/cards', card.isActive ? 'card_deactivated' : 'card_updated');
  });

  app.post('/dashboard/cards/:cardId/delete', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);

    try {
      const result = await session.services.cards.remove(
        session.user.id,
        c.req.param('cardId') ?? '',
        actorOf(c, session),
        c.get('appContext').requestId,
      );
      // The outcome is reported, not assumed: a card used by an invoice is deactivated
      // instead of deleted, and telling the merchant "deleted" would be a lie they would
      // only discover when the card reappeared in the list.
      return backTo('/dashboard/cards', result.deleted ? 'card_removed' : 'card_deactivated');
    } catch (error) {
      return failTo('/dashboard/cards', errorCode(error, 'card_not_found'));
    }
  });

  // --- API keys -----------------------------------------------------------
  app.post('/dashboard/api-keys/create', async (c) => {
    const session = await requireMerchant(c);
    const form = await readForm(c);

    const environment = form.value('environment') === 'test' ? 'test' : 'live';
    const scopes = (form.body['scopes'] as string[] | undefined) ?? [];
    const allowlist = splitList(form.value('ipAllowlist'));

    try {
      const issued = await session.services.apiKeys.issue({
        merchantUserId: session.user.id,
        environment,
        label: form.value('label') || null,
        ...(Array.isArray(scopes) && scopes.length > 0 ? { scopes } : {}),
        ...(allowlist.length > 0 ? { ipAllowlist: allowlist } : {}),
        createdBy: session.user.id,
        requestId: c.get('appContext').requestId,
        actor: actorOf(c, session),
      });

      return apiKeysPage(c, null, {
        label: environment === 'live' ? 'کلید عملیاتی جدید' : 'کلید آزمایشی جدید',
        key: issued.fullKey,
      });
    } catch (error) {
      return apiKeysPage(c, {
        tone: 'error',
        text:
          error instanceof AppError && error.public
            ? error.message
            : 'ساخت کلید انجام نشد. دوباره تلاش کنید.',
      });
    }
  });

  app.post('/dashboard/api-keys/:keyId/rotate', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);

    try {
      const issued = await session.services.apiKeys.rotate(
        session.user.id,
        c.req.param('keyId') ?? '',
        actorOf(c, session),
        c.get('appContext').requestId,
      );
      return apiKeysPage(c, { tone: 'success', text: 'کلید قبلی باطل شد. کلید تازه:' }, {
        label: 'کلید تازه — کلید قبلی دیگر کار نمی‌کند',
        key: issued.fullKey,
      });
    } catch (error) {
      return failTo('/dashboard/api-keys', errorCode(error, 'key_not_found'));
    }
  });

  app.post('/dashboard/api-keys/:keyId/revoke', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);
    try {
      await session.services.apiKeys.revokeByMerchant(
        session.user.id,
        c.req.param('keyId') ?? '',
        actorOf(c, session),
        c.get('appContext').requestId,
      );
    } catch (error) {
      return failTo('/dashboard/api-keys', errorCode(error, 'key_not_found'));
    }
    return backTo('/dashboard/api-keys', 'key_revoked');
  });

  // --- webhooks -----------------------------------------------------------
  app.post('/dashboard/webhooks/create', async (c) => {
    const session = await requireMerchant(c);
    const form = await readForm(c);

    const events = (form.body['events'] as string[] | undefined) ?? [];
    const url = form.value('url');
    if (!url) return webhooksPage(c, { tone: 'error', text: 'آدرس وب‌هوک را وارد کنید.' });

    let created: { secret: string; endpoint: { id: string } };
    try {
      created = await session.services.webhooks.createEndpoint(
        session.user.id,
        {
          url,
          events: Array.isArray(events) && events.length > 0 ? events : ['*'],
          description: form.value('description') || null,
        },
        actorOf(c, session),
        c.get('appContext').requestId,
      );
    } catch (error) {
      return webhooksPage(c, {
        tone: 'error',
        text:
          error instanceof AppError && error.public
            ? error.message
            : 'آدرس پذیرفته نشد. باید HTTPS و متعلق به دامنه شما باشد.',
      });
    }

    return webhooksPage(c, null, { label: 'وب‌هوک تازه', secret: created.secret });
  });

  app.post('/dashboard/webhooks/:endpointId/reveal', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);
    const endpointId = c.req.param('endpointId') ?? '';

    try {
      const secret = await session.services.webhooks.revealSecret(session.user.id, endpointId);
      return webhooksPage(c, null, { label: 'راز امضا', secret });
    } catch (error) {
      return failTo('/dashboard/webhooks', errorCode(error, 'webhook_not_found'));
    }
  });

  app.post('/dashboard/webhooks/:endpointId/rotate', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);

    try {
      const secret = await session.services.webhooks.rotateSecret(
        session.user.id,
        c.req.param('endpointId') ?? '',
        actorOf(c, session),
        c.get('appContext').requestId,
      );
      return webhooksPage(
        c,
        { tone: 'warn', text: 'راز قبلی از این لحظه نامعتبر است. سرور خود را با راز تازه به‌روز کنید.' },
        { label: 'راز امضای تازه', secret },
      );
    } catch (error) {
      return failTo('/dashboard/webhooks', errorCode(error, 'webhook_not_found'));
    }
  });

  app.post('/dashboard/webhooks/:endpointId/toggle', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);
    const endpointId = c.req.param('endpointId') ?? '';

    const endpoint = (await session.services.webhooks.listEndpoints(session.user.id)).find(
      (entry) => entry.id === endpointId,
    );
    if (!endpoint) return failTo('/dashboard/webhooks', 'webhook_not_found');

    try {
      await session.services.webhooks.updateEndpoint(
        session.user.id,
        endpointId,
        // The flip is computed from the same definition of "active" the page renders, so the
        // button always does what its label says. Re-enabling clears the automatic shutdown
        // inside the service (§ see `updateEndpoint`) — otherwise the label would change and
        // delivery would not resume.
        { isActive: !isDeliverable(endpoint) },
        actorOf(c, session),
        c.get('appContext').requestId,
      );
    } catch (error) {
      return failTo('/dashboard/webhooks', errorCode(error, 'webhook_not_found'));
    }

    return backTo('/dashboard/webhooks', 'webhook_updated');
  });

  app.post('/dashboard/webhooks/:endpointId/delete', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);
    try {
      await session.services.webhooks.deleteEndpoint(
        session.user.id,
        c.req.param('endpointId') ?? '',
        actorOf(c, session),
        c.get('appContext').requestId,
      );
    } catch (error) {
      return failTo('/dashboard/webhooks', errorCode(error, 'webhook_not_found'));
    }
    return backTo('/dashboard/webhooks', 'webhook_deleted');
  });

  app.post('/dashboard/webhooks/test', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);

    const endpoints = await session.services.webhooks.listEndpoints(session.user.id);
    if (endpoints.length === 0) return failTo('/dashboard/webhooks', 'webhook_none');

    const result = await session.services.webhooks.enqueue({
      merchantUserId: session.user.id,
      event: 'test.pipeline',
      isTest: true,
      force: true,
      data: {
        message: 'این یک رویداد آزمایشی است. اگر آن را دریافت کردید، مسیر وب‌هوک شما درست کار می‌کند.',
        merchantCode: 'TEST',
        sentAt: new Date().toISOString(),
      },
    });

    if (result.skipped || !result.deliveryId) return failTo('/dashboard/webhooks', 'webhook_none');

    // Delivered inline, so the merchant sees the real HTTP status of their own server on the
    // page they just clicked — not "queued" and then nothing.
    await session.services.webhooks.attemptDelivery(result.deliveryId);
    return backTo('/dashboard/webhooks', 'webhook_test_sent');
  });

  app.post('/dashboard/webhooks/deliveries/:deliveryId/retry', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);

    try {
      await session.services.webhooks.retryDelivery(
        c.req.param('deliveryId') ?? '',
        actorOf(c, session),
        // Scoped to this merchant, so a guessed delivery id from another account is a 404.
        session.user.id,
      );
    } catch (error) {
      return failTo('/dashboard/webhooks', errorCode(error, 'delivery_not_found'));
    }
    return backTo('/dashboard/webhooks', 'webhook_updated');
  });

  // --- SMS ----------------------------------------------------------------
  app.post('/dashboard/sms/test-token', async (c) => {
    const session = await requireMerchant(c);
    await readForm(c);
    const token = await session.services.sms.issueTestToken(session.user.id);
    return smsPage(c, null, token);
  });

  // --- settings -----------------------------------------------------------
  app.post('/dashboard/settings', async (c) => {
    const session = await requireMerchant(c);
    const form = await readForm(c);
    const services = session.services;
    const id = session.user.id;

    const feeMode = form.value('feeMode');
    const gatewayFee = form.value('gatewayFee');
    const expiryRaw = form.value('expiryMinutes');
    const customerMessage = form.value('customerMessage');

    try {
      // Fee mode: empty means "no override", which is a delete, not an empty string.
      if (feeMode === '') await services.settings.clearMerchant(id, 'invoices.fee_mode');
      else if (feeMode === 'CUSTOMER' || feeMode === 'MERCHANT') {
        await services.settings.setMerchant(id, 'invoices.fee_mode', feeMode, 'string');
      } else return failTo('/dashboard/settings', 'settings_invalid');

      if (gatewayFee === '') {
        await services.settings.clearMerchant(id, 'invoices.gateway_fee');
      } else {
        const parsed = parseTomanInput(gatewayFee);
        if (!Number.isInteger(parsed) || parsed < 0) return failTo('/dashboard/settings', 'settings_invalid');
        await services.settings.setMerchant(id, 'invoices.gateway_fee', String(parsed), 'int');
      }

      if (expiryRaw === '') {
        await services.settings.clearMerchant(id, 'invoices.expiry_minutes');
      } else {
        const minutes = Number(expiryRaw);
        const min = await services.settings.int('invoices.expiry_minutes_min');
        const max = await services.settings.int('invoices.expiry_minutes_max');
        if (!Number.isInteger(minutes) || minutes < min || minutes > max) {
          return failTo('/dashboard/settings', 'settings_invalid');
        }
        await services.settings.setMerchant(id, 'invoices.expiry_minutes', String(minutes), 'int');
      }

      if (customerMessage === '') {
        await services.settings.clearMerchant(id, 'invoices.customer_message');
      } else {
        await services.settings.setMerchant(
          id,
          'invoices.customer_message',
          customerMessage.slice(0, 500),
          'string',
        );
      }
    } catch (error) {
      void error;
      return failTo('/dashboard/settings', 'settings_invalid');
    }

    return backTo('/dashboard/settings', 'settings_saved');
  });

  // --- notifications ------------------------------------------------------
  app.post('/dashboard/notifications/read', async (c) => {
    const session = await requireMerchant(c);
    const form = await readForm(c);
    const notifications = session.services.notifications;

    if (form.value('scope') === 'all') {
      await notifications.markAllRead(session.user.id, session.user.role);
    } else {
      const id = form.value('id');
      if (id) await notifications.markRead(session.user.id, id);
    }

    return backTo('/dashboard/notifications', 'notifications_read');
  });

  // --- profile ------------------------------------------------------------
  app.post('/dashboard/profile', async (c) => {
    const session = await requireMerchant(c);
    const form = await readForm(c);

    try {
      await session.services.merchants.updateProfile(
        session.user.id,
        {
          displayName: form.value('displayName') || null,
          logoUrl: form.value('logoUrl') || null,
          websiteUrl: form.value('websiteUrl') || null,
          supportContact: form.value('supportContact') || null,
          supportUrl: form.value('supportUrl') || null,
          businessDescription: form.value('businessDescription') || null,
          telegramUsername: form.value('telegramUsername') || null,
          telegramAlerts: form.value('telegramAlerts') === '1',
        },
        actorOf(c, session),
        c.get('appContext').requestId,
      );
    } catch (error) {
      return profilePage(c, {
        tone: 'error',
        text: error instanceof AppError && error.public ? error.message : 'ذخیره پروفایل انجام نشد.',
      });
    }

    return backTo('/dashboard/profile', 'profile_saved');
  });
}
