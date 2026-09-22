/**
 * Operator console (§28, §29, §30, §31, §33, §36).
 *
 * The routes a human uses when the automation declines to decide. Two of them carry the
 * whole design: approving a merchant is the only path from `PENDING_APPROVAL` to a working
 * API key, and deciding a `MANUAL_REVIEW` payment is the only path out of that state.
 * Without them the system is a library, not a gateway.
 *
 * Four rules hold across every handler here.
 *
 *   1. **No direct SQL.** A state change goes through a service method that writes its own
 *      audit entry, so an operator action cannot happen without a record. Needing raw SQL
 *      here would mean a missing service method, not a shortcut.
 *
 *   2. **Nothing from the request body becomes a status.** A POST names an action in its
 *      body, that action is looked up in a fixed table, and only then does it reach the
 *      service. A crafted form cannot invent a status or a transition.
 *
 *   3. **A reason is required to refuse, to suspend, and to move money.** Approving a
 *      merchant needs no justification; debiting their wallet, rejecting them, or refusing
 *      a payment does, and the reason is written to the ledger and the audit log where the
 *      merchant can eventually read it.
 *
 *   4. **CSRF is per-form, never global.** The token is issued once per page and injected
 *      into every form on it, so no form can be posted without one.
 */

import type { Hono } from 'hono';
import type { AppEnv, RouteContext } from '../app';
import { escapeHtml, html, redirect } from '../core/http';
import { toPersianDigits } from '../core/digits';
import { formatJalaliDateTime, formatRelativeFa } from '../core/time';
import { formatTomanFa, parseTomanInput } from '../core/money';
import { INVOICE_STATUSES, type InvoiceStatus } from '../core/state-machine';
import { hasPermission, type Permission, type Role } from '../core/roles';
import { AppError } from '../core/errors';
import { CSRF_FIELD } from '../core/csrf';
import { requirePermission, readForm, csrfForGet, withCsrfCookie, messageFor } from './session';
import { adminShell, alert, badge, barChart, emptyState, ident, panel, stat } from '../ui/layout';
import { ReportingService } from '../services/reporting';
import { confirmPayment } from '../services/confirm';
import { announceConfirmedPayment } from '../services/payment-events';
import { first } from '../db/client';

const toman = (value: number): string => formatTomanFa(value);

/** A hidden CSRF input, built once per page and reused by every form on it. */
function csrfField(token: string): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(token)}">`;
}

/**
 * The console's navigation.
 *
 * Only pages that exist appear. A rail that advertises a section which 404s is worse than a
 * shorter rail: an operator learns to distrust all of it, and the gaps stop reading as
 * "not built yet" and start reading as "broken".
 */
function adminNav(pendingReview: number): Array<{ group: string; links: Array<{ href: string; label: string }> }> {
  return [
    { group: 'مرور کلی', links: [{ href: '/admin', label: 'نمای کلی' }] },
    {
      group: 'پذیرندگان',
      links: [
        { href: '/admin/users', label: 'پذیرندگان' },
        { href: '/admin/revenue', label: 'درآمد' },
      ],
    },
    {
      group: 'پرداخت‌ها',
      links: [
        {
          href: '/admin/review',
          label: `صف بررسی${pendingReview > 0 ? ` (${toPersianDigits(pendingReview)})` : ''}`,
        },
        { href: '/admin/invoices', label: 'فاکتورها' },
      ],
    },
    { group: 'سیستم', links: [{ href: '/admin/audit-logs', label: 'گزارش رویدادها' }] },
  ];
}

interface PageInput {
  title: string;
  heading: string;
  subheading?: string;
  path: string;
  actions?: string;
  permission: Parameters<typeof requirePermission>[1];
}

/**
 * Renders a console page.
 *
 * `build` receives the CSRF input rather than a token string, so a page cannot forget to
 * include it: the only way to write a form is to use the field it is handed. The token is
 * issued before the body is composed, which is the ordering the previous version got wrong.
 */
async function renderAdmin(
  c: RouteContext,
  input: PageInput,
  build: (csrf: string) => string | Promise<string>,
): Promise<Response> {
  const url = new URL(c.req.url);
  const session = await requirePermission(c, input.permission);
  const context = c.get('appContext');

  const pendingReview = await first<{ count: number }>(
    context.env.DB,
    "SELECT COUNT(*) AS count FROM invoices WHERE status = 'MANUAL_REVIEW'",
  );

  const csrf = await csrfForGet(c);
  const notice =
    messageFor(url.searchParams.get('ok') ?? undefined) ??
    messageFor(url.searchParams.get('err') ?? undefined);

  const body = await build(csrfField(csrf.token));

  const page = adminShell(
    {
      title: input.title,
      currentPath: input.path,
      user: {
        displayName: session.user.displayName,
        mobile: session.user.mobile,
        role: session.user.role,
      },
      nav: adminNav(pendingReview?.count ?? 0),
      heading: input.heading,
      ...(input.subheading ? { subheading: input.subheading } : {}),
      ...(input.actions ? { actions: input.actions } : {}),
      pendingReview: pendingReview?.count ?? 0,
    },
    `${notice ? alert(notice.tone, notice.text) : ''}${body}`,
  );

  return withCsrfCookie(html(page, { noStore: true }), csrf.cookie);
}

function actor(c: RouteContext, session: { user: { id: string; role: string } }) {
  return { userId: session.user.id, role: session.user.role, ip: c.get('appContext').clientIp };
}

/** A label/value row. The console is mostly rows of facts, so this is most of its markup. */
function row(label: string, value: string, tone: 'plain' | 'settle' | 'amber' | 'reject' = 'plain'): string {
  const color =
    tone === 'settle'
      ? 'var(--settle)'
      : tone === 'amber'
        ? 'var(--amber)'
        : tone === 'reject'
          ? 'var(--reject)'
          : 'var(--faint)';
  return `<div class="receipt-row"><span>${escapeHtml(label)}</span><span class="num" style="color:${color}">${escapeHtml(value)}</span></div>`;
}

// ===========================================================================
// Overview (§28, §31, §33)
// ===========================================================================

async function overviewPage(c: RouteContext): Promise<Response> {
  return renderAdmin(
    c,
    {
      title: 'نمای کلی مدیریت',
      heading: 'نمای کلی',
      subheading: 'وضعیت پرداخت‌ها، کیف پول‌ها و صف بررسی',
      path: '/admin',
      permission: 'merchants:read',
    },
    async (csrf) => {
      void csrf;
      const reporting = new ReportingService(c.get('appContext').env.DB);
      const [overview, feesByDay] = await Promise.all([reporting.adminOverview(), reporting.feesByDay(14)]);

      const queued = overview.invoices.manualReview;
      const reviewBanner =
        queued > 0
          ? alert(
              'warn',
              `${toPersianDigits(queued)} پرداخت منتظر تصمیم است. تا تصمیم نگرفتن، پول مشتری در هیچ‌کدام از دو طرف تسویه نمی‌شود.`,
            )
          : '';

      return `${reviewBanner}
<div class="grid-4">
${stat({ label: 'کارمزد امروز', value: toman(overview.money.feesToday), unit: 'تومان', sub: 'درآمد درگاه' })}
${stat({ label: 'حجم تأییدشده امروز', value: toman(overview.money.volumeToday), unit: 'تومان', sub: 'پرداخت‌های موفق' })}
${stat({ label: 'فاکتور امروز', value: toPersianDigits(overview.invoices.today), sub: `${toPersianDigits(overview.invoices.paidToday)} پرداخت‌شده` })}
${stat({
  label: 'در انتظار بررسی',
  value: toPersianDigits(queued),
  ...(queued > 0 ? { tone: 'amber' as const } : {}),
  sub: 'نیازمند تصمیم انسانی',
})}
</div>

<div class="grid-3" style="margin-top:1rem">
${stat({ label: 'پذیرندگان فعال', value: toPersianDigits(overview.merchants.active), sub: `از ${toPersianDigits(overview.merchants.total)} پذیرنده` })}
${stat({
  label: 'در انتظار تأیید',
  value: toPersianDigits(overview.merchants.pending),
  ...(overview.merchants.pending > 0 ? { tone: 'amber' as const } : {}),
  sub: 'ثبت‌نام تازه',
})}
${stat({ label: 'فاکتور معلق', value: toPersianDigits(overview.invoices.pending), sub: 'در جریان پرداخت' })}
</div>

<div class="grid-2" style="margin-top:1rem">
${panel('کارمزد ۱۴ روز گذشته', barChart(feesByDay.map((point) => ({ label: point.day.slice(5), value: point.amount }))))}
${panel(
  'سلامت زنجیره پرداخت',
  `<div class="stack" style="gap:.6rem">
${row('پیامک ۲۴ ساعت گذشته', toPersianDigits(overview.sms.last24h), overview.sms.last24h > 0 ? 'settle' : 'plain')}
${row('پیامک با قالب ناشناخته', toPersianDigits(overview.sms.unparsed), overview.sms.unparsed > 0 ? 'amber' : 'plain')}
${row('وب‌هوک ناموفق', toPersianDigits(overview.webhooks.failed), overview.webhooks.failed > 0 ? 'reject' : 'plain')}
${row('وب‌هوک در صف', toPersianDigits(overview.webhooks.pending))}
${row('فاکتور منقضی', toPersianDigits(overview.invoices.expired))}
</div>`,
)}
</div>

<div class="grid-2" style="margin-top:1rem">
${panel(
  'دفتر کل پلتفرم',
  `<div class="stack" style="gap:.6rem">
${row('کارمزد کل', `${toman(overview.money.feesTotal)} تومان`)}
${row('حجم تأییدشده کل', `${toman(overview.money.volumeTotal)} تومان`)}
${row('کل شارژ کیف پول‌ها', `${toman(overview.money.depositsTotal)} تومان`)}
${row('موجودی نزد پلتفرم', `${toman(overview.money.walletsHeld)} تومان`, 'amber')}
</div>
<p class="hint" style="margin-top:.75rem;font-size:.72rem;color:var(--faint);line-height:1.9">
ارقام از دفتر کل خوانده می‌شوند، نه از فاکتورها. دفتر کل ثبت می‌کند چه چیزی واقعاً جابه‌جا شد؛
فاکتور فقط ثبت می‌کند چه چیزی خواسته شده بود. «موجودی نزد پلتفرم» همان مبلغی است که پلتفرم به پذیرندگان بدهکار است.
</p>`,
)}
${panel('گزارش تفصیلی', emptyState({
  title: 'درآمد به تفکیک پذیرنده',
  body: 'کارمزد، حجم و تعداد پرداخت هر پذیرنده در صفحه درآمد آمده است.',
  action: { href: '/admin/revenue', label: 'دیدن درآمد' },
}))}
</div>`;
    },
  );
}

// ===========================================================================
// Merchants (§29)
// ===========================================================================

interface ActionSpec {
  action: 'APPROVE' | 'REJECT' | 'SUSPEND' | 'BAN' | 'REACTIVATE' | 'RESET';
  label: string;
  primary: boolean;
  needsReason: boolean;
  ok: string;
  /** The permission this specific action requires, checked separately from page access. */
  permission: Permission;
}

/**
 * The closed vocabulary of merchant lifecycle actions.
 *
 * The URL carries a key into this table, never a status. That is what makes "a crafted form
 * cannot suspend an account it was not entitled to suspend" structurally true rather than
 * something a validator has to remember to enforce.
 */
const MERCHANT_ACTIONS: Record<string, ActionSpec> = {
  approve: { action: 'APPROVE', label: 'تأیید پذیرنده', primary: true, needsReason: false, ok: 'user_approved', permission: 'merchants:approve' },
  reject: { action: 'REJECT', label: 'رد درخواست', primary: false, needsReason: true, ok: 'user_rejected', permission: 'merchants:approve' },
  suspend: { action: 'SUSPEND', label: 'تعلیق', primary: false, needsReason: true, ok: 'user_suspended', permission: 'merchants:suspend' },
  ban: { action: 'BAN', label: 'مسدود کردن', primary: false, needsReason: true, ok: 'user_banned', permission: 'merchants:suspend' },
  reactivate: { action: 'REACTIVATE', label: 'فعال‌سازی', primary: true, needsReason: true, ok: 'user_reactivated', permission: 'merchants:approve' },
  reset: { action: 'RESET', label: 'بازنشانی حساب', primary: false, needsReason: true, ok: 'user_reset', permission: 'merchants:reset' },
};

/**
 * Checks a permission beyond the one that opened the page.
 *
 * The console distinguishes reading from acting: a support role can open a merchant's page
 * and see why they were suspended, but cannot suspend anyone itself. The page-level
 * permission gets you in; this decides what the buttons do.
 */
function assertPermission(session: { user: { role: Role } }, permission: Permission): void {
  if (!hasPermission(session.user.role, permission)) {
    throw new AppError('PERMISSION_DENIED', {
      message: 'نقش شما اجازه این کار را ندارد.',
      details: { permission, role: session.user.role },
    });
  }
}

/** Which actions are offered from a given status. The service enforces the same rules. */
function allowedActions(status: string): string[] {
  switch (status) {
    case 'PENDING_APPROVAL':
      return ['approve', 'reject'];
    case 'ACTIVE':
      return ['suspend', 'ban', 'reset'];
    case 'SUSPENDED':
      return ['reactivate', 'ban', 'reset'];
    case 'BANNED':
      return ['reactivate', 'reset'];
    case 'REJECTED':
      return ['approve', 'reset'];
    default:
      return ['reset'];
  }
}

async function usersPage(c: RouteContext): Promise<Response> {
  const url = new URL(c.req.url);
  const status = url.searchParams.get('status') ?? '';
  const search = url.searchParams.get('q') ?? '';

  return renderAdmin(
    c,
    {
      title: 'پذیرندگان',
      heading: 'پذیرندگان',
      subheading: 'تأیید، تعلیق و بررسی حساب‌ها',
      path: '/admin/users',
      permission: 'merchants:read',
      actions: `<form method="get" action="/admin/users" style="display:flex;gap:.4rem">
<input class="input" name="q" value="${escapeHtml(search)}" placeholder="موبایل، کد پذیرنده یا نام" style="min-width:14rem">
${status ? `<input type="hidden" name="status" value="${escapeHtml(status)}">` : ''}
<button class="btn" type="submit">جست‌وجو</button>
</form>`,
    },
    async (csrf) => {
      void csrf;
      const { services } = await requirePermission(c, 'merchants:read');
      const filters: { status?: string; search?: string; limit: number } = { limit: 100 };
      if (status) filters.status = status;
      if (search) filters.search = search;

      const [rows, counts] = await Promise.all([
        services.merchants.list(filters),
        services.merchants.statusCounts(),
      ]);

      const chip = (label: string, value: string, count: number): string =>
        `<a class="btn${status === value ? ' btn-primary' : ''}" href="/admin/users${value ? `?status=${value}` : ''}">${escapeHtml(label)} <span class="num">${toPersianDigits(count)}</span></a>`;

      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

      const table =
        rows.length === 0
          ? emptyState({
              title: 'پذیرنده‌ای با این فیلتر نیست',
              body: 'فیلتر وضعیت را بردارید یا عبارت جست‌وجو را کوتاه‌تر کنید.',
              action: { href: '/admin/users', label: 'همه پذیرندگان' },
            })
          : `<div class="table-wrap"><table>
<thead><tr><th>پذیرنده</th><th>کد</th><th>وضعیت</th><th>موجودی</th><th>فاکتور</th><th>تلگرام</th><th>ثبت‌نام</th></tr></thead>
<tbody>
${rows
  .map(
    (merchant) => `<tr>
<td><a href="/admin/users/${encodeURIComponent(merchant.userId)}">${escapeHtml(merchant.displayName ?? merchant.mobile)}</a>
  <div class="mono" style="font-size:.7rem;color:var(--faint)">${escapeHtml(merchant.mobile)}</div></td>
<td class="mono" style="font-size:.74rem">${escapeHtml(merchant.merchantCode)}</td>
<td>${badge(merchant.status)}</td>
<td class="num">${escapeHtml(toman(merchant.walletBalance))}</td>
<td class="num">${toPersianDigits(merchant.invoiceCount)}</td>
<td style="font-size:.74rem">${merchant.telegramUsername ? escapeHtml(merchant.telegramUsername) : '—'}${merchant.telegramVerified ? ' ✓' : ''}</td>
<td style="color:var(--faint);font-size:.72rem">${escapeHtml(formatRelativeFa(merchant.createdAt))}</td>
</tr>`,
  )
  .join('')}
</tbody></table></div>`;

      return `<div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem">
${chip('همه', '', total)}
${chip('در انتظار تأیید', 'PENDING_APPROVAL', counts['PENDING_APPROVAL'] ?? 0)}
${chip('فعال', 'ACTIVE', counts['ACTIVE'] ?? 0)}
${chip('معلق', 'SUSPENDED', counts['SUSPENDED'] ?? 0)}
${chip('مسدود', 'BANNED', counts['BANNED'] ?? 0)}
${chip('ردشده', 'REJECTED', counts['REJECTED'] ?? 0)}
</div>
${panel('پذیرندگان', table)}`;
    },
  );
}

async function userDetailPage(c: RouteContext, userId: string): Promise<Response> {
  return renderAdmin(
    c,
    {
      title: 'جزئیات پذیرنده',
      heading: 'جزئیات پذیرنده',
      path: '/admin/users',
      permission: 'merchants:read',
    },
    async (csrf) => {
      const { services } = await requirePermission(c, 'merchants:read');

      const detail = await services.merchants.detail(userId);
      if (!detail) throw new AppError('NOT_FOUND', { message: 'پذیرنده پیدا نشد.' });

      const [invoices, ledger, keys, setup] = await Promise.all([
        services.invoices.list(userId, { limit: 10 }),
        services.wallet.ledger(userId, { limit: 10 }),
        services.apiKeys.list(userId),
        services.merchants.setupProgress(userId),
      ]);

      const status = String(detail['status'] ?? '');
      const wallet = detail['wallet'] as
        | { balance: number; availableBalance: number; reservedBalance: number }
        | undefined;
      const counts = (detail['invoiceCounts'] ?? {}) as Record<string, number>;

      const forms = allowedActions(status)
        .map((key) => {
          const spec = MERCHANT_ACTIONS[key];
          if (!spec) return '';
          return `<form method="post" action="/admin/users/${encodeURIComponent(userId)}/action" class="stack" style="gap:.4rem;border:1px solid var(--hairline-soft);border-radius:10px;padding:.7rem">
${csrf}
<input type="hidden" name="action" value="${escapeHtml(key)}">
<p style="margin:0;font-size:.8rem;font-weight:600">${escapeHtml(spec.label)}</p>
${
  spec.needsReason
    ? `<input class="input" name="reason" required minlength="3" maxlength="300" placeholder="دلیل (به پذیرنده نشان داده می‌شود)">`
    : ''
}
<button class="btn${spec.primary ? ' btn-primary' : ''}" type="submit">${escapeHtml(spec.label)}</button>
</form>`;
        })
        .join('');

      // The direction is a labelled control, not a minus sign in the amount box. An
      // operator picking "کاهش موجودی" from a list is choosing an intention; typing a
      // leading minus into a numeric field is a typo waiting to happen, and a minus that
      // silently fails to parse would look like a successful adjustment.
      const walletForm = `<form method="post" action="/admin/users/${encodeURIComponent(userId)}/wallet" class="stack" style="gap:.6rem">
${csrf}
<div class="field">
  <label for="wallet-direction">نوع تغییر</label>
  <select class="input" id="wallet-direction" name="direction">
    <option value="credit">افزایش موجودی</option>
    <option value="debit">کاهش موجودی</option>
  </select>
</div>
<div class="field">
  <label for="wallet-amount">مبلغ (تومان)</label>
  <input class="input num" id="wallet-amount" name="amount" required inputmode="numeric" placeholder="500000">
  <p class="hint">تغییر موجودی بدون ثبت در دفتر کل ممکن نیست؛ دلیل برای پذیرنده قابل مشاهده است.</p>
</div>
<div class="field">
  <label for="wallet-reason">دلیل</label>
  <input class="input" id="wallet-reason" name="reason" required minlength="3" maxlength="300" placeholder="شارژ بابت تسویه تیکت">
</div>
<button class="btn btn-primary" type="submit">ثبت در دفتر کل</button>
</form>`;

      const setupRows = setup.steps
        .map(
          (step) =>
            `<div class="receipt-row"><span>${step.done ? '✓' : '○'} ${escapeHtml(step.title)}</span><span style="color:var(--faint);font-size:.72rem">${escapeHtml(step.detail ?? '')}</span></div>`,
        )
        .join('');

      const ledgerRows =
        ledger.length === 0
          ? '<p class="hint">هنوز تراکنشی در دفتر کل ثبت نشده است.</p>'
          : `<div class="table-wrap"><table><thead><tr><th>نوع</th><th>مبلغ</th><th>مانده پس از</th><th>دلیل</th><th>زمان</th></tr></thead><tbody>
${ledger
  .map(
    (entry) => `<tr>
<td style="font-size:.74rem">${escapeHtml(entry.type)}</td>
<td class="num" style="color:${entry.direction === 'CREDIT' ? 'var(--settle)' : 'var(--reject)'}">${escapeHtml(toman(entry.amount))}</td>
<td class="num">${escapeHtml(toman(entry.balance_after))}</td>
<td style="font-size:.74rem;color:var(--muted)">${escapeHtml(entry.description ?? '—')}</td>
<td style="color:var(--faint);font-size:.72rem">${escapeHtml(formatJalaliDateTime(entry.created_at))}</td>
</tr>`,
  )
  .join('')}
</tbody></table></div>`;

      const keyRows =
        keys.length === 0
          ? '<p class="hint">هنوز کلید API ساخته نشده است. با تأیید پذیرنده کلید ساخته می‌شود.</p>'
          : `<div class="stack" style="gap:.7rem">${keys
              .map(
                (key) => `<div>
<div class="receipt-row">
  <span>${ident(key.hint)} <span style="font-size:.72rem;color:var(--faint)">${escapeHtml(key.environment)}</span></span>
  <span>${badge(key.active ? 'ACTIVE' : 'REVOKED', key.active ? 'فعال' : 'لغو‌شده')}</span>
</div>
<div style="font-size:.7rem;color:var(--faint)">
آخرین استفاده: ${key.lastUsedAt ? escapeHtml(formatRelativeFa(key.lastUsedAt)) : 'استفاده نشده'} ·
${toPersianDigits(key.requestCount)} درخواست
</div>
</div>`,
              )
              .join('')}</div>`;

      const invoiceRows =
        invoices.length === 0
          ? '<p class="hint">فاکتوری ثبت نشده است.</p>'
          : `<div class="table-wrap"><table><thead><tr><th>شناسه</th><th>مبلغ پرداختی</th><th>وضعیت</th><th>زمان</th></tr></thead><tbody>
${invoices
  .map(
    (invoice) => `<tr>
<td class="mono" style="font-size:.7rem">${escapeHtml(invoice.id)}</td>
<td class="num">${escapeHtml(toman(invoice.payable_amount))}</td>
<td>${badge(invoice.status)}</td>
<td style="color:var(--faint);font-size:.72rem">${escapeHtml(formatRelativeFa(invoice.created_at))}</td>
</tr>`,
  )
  .join('')}
</tbody></table></div>`;

      return `
<div class="grid-3">
${stat({ label: 'موجودی', value: toman(wallet?.balance ?? 0), unit: 'تومان', sub: `قابل استفاده ${toman(wallet?.availableBalance ?? 0)}` })}
${stat({ label: 'فاکتور پرداخت‌شده', value: toPersianDigits(counts['PAID'] ?? 0), sub: `از ${toPersianDigits(counts['PENDING'] ?? 0)} در جریان` })}
${stat({ label: 'آمادگی راه‌اندازی', value: `${toPersianDigits(setup.percent)}٪`, sub: setup.ready ? 'آماده دریافت پرداخت' : 'ناتمام' })}
</div>

<div class="grid-2" style="margin-top:1rem">
${panel(
  'مشخصات',
  `<div class="stack" style="gap:.5rem">
${row('وضعیت', status, status === 'ACTIVE' ? 'settle' : status === 'PENDING_APPROVAL' ? 'amber' : 'reject')}
${row('موبایل', String(detail['mobile'] ?? '—'))}
${row('کد پذیرنده', String(detail['merchant_code'] ?? '—'))}
${row('نوع کسب‌وکار', String(detail['business_type'] ?? '—'))}
${row('نام نمایشی', String(detail['display_name'] ?? '—'))}
${row('تلگرام', `${String(detail['telegram_username'] ?? '—')}${detail['telegram_verified'] ? ' (تأییدشده)' : ' (تأییدنشده)'}`)}
${row('آخرین ورود', detail['last_login_at'] ? formatJalaliDateTime(String(detail['last_login_at'])) : '—')}
${detail['approved_at'] ? row('تأیید در', formatJalaliDateTime(String(detail['approved_at'])), 'settle') : ''}
${detail['status_reason'] ? row('دلیل وضعیت', String(detail['status_reason']), 'amber') : ''}
</div>
${detail['business_description'] ? `<p class="hint" style="margin-top:.75rem;font-size:.76rem;color:var(--muted);line-height:1.9">${escapeHtml(String(detail['business_description']))}</p>` : ''}`,
)}
${panel('مراحل راه‌اندازی', `<div class="stack" style="gap:.4rem">${setupRows}</div>`)}
</div>

<div class="grid-2" style="margin-top:1rem">
${panel('اقدام‌ها', `<div class="grid-2" style="gap:.6rem">${forms}</div>`)}
${panel(
  'کیف پول',
  `<div class="stack" style="gap:.5rem">
${row('موجودی', `${toman(wallet?.balance ?? 0)} تومان`)}
${row('رزروشده', `${toman(wallet?.reservedBalance ?? 0)} تومان`, 'amber')}
${row('قابل استفاده', `${toman(wallet?.availableBalance ?? 0)} تومان`, 'settle')}
</div>
<div style="margin-top:.9rem">${walletForm}</div>`,
)}
</div>

<div class="grid-2" style="margin-top:1rem">
${panel('دفتر کل (۱۰ رویداد آخر)', ledgerRows)}
${panel('کلیدهای API', keyRows)}
</div>

<div style="margin-top:1rem">${panel('فاکتورهای اخیر', invoiceRows)}</div>`;
    },
  );
}

// ===========================================================================
// Manual review (§19, §33, §54)
// ===========================================================================

async function reviewPage(c: RouteContext): Promise<Response> {
  return renderAdmin(
    c,
    {
      title: 'صف بررسی',
      heading: 'صف بررسی',
      subheading: 'پرداخت‌هایی که تأیید خودکار نشدند',
      path: '/admin/review',
      permission: 'review:read',
    },
    async (csrf) => {
      const { services } = await requirePermission(c, 'review:read');
      const queue = await services.invoices.listForReview(25);

      if (queue.length === 0) {
        return emptyState({
          title: 'صف خالی است',
          body: 'هیچ پرداختی منتظر تصمیم انسانی نیست. پرداخت‌هایی که موتور تطبیق به آن‌ها مطمئن نباشد، همین‌جا می‌آیند.',
        });
      }

      // Evidence for the whole page up front. An operator triaging a queue reads every row
      // in turn, and fetching proof per click would make the one surface that must feel
      // reliable stall on every decision.
      const evidence = await Promise.all(queue.map((invoice) => services.sms.reviewContext(invoice)));

      const cards = queue
        .map((invoice, index) => {
          const proof = evidence[index] ?? null;
          const confidence = proof ? Math.round(proof.parsed.confidence * 100) : 0;

          const facts = `<div class="stack" style="gap:.5rem">
${row('مبلغ پرداختی', `${toman(invoice.payable_amount)} تومان`, 'amber')}
${row('مبلغ اصلی', `${toman(invoice.original_amount)} تومان`)}
${row('کارمزد', `${toman(invoice.customer_fee + invoice.merchant_fee)} تومان`)}
${row('پسوند یکتا', toPersianDigits(invoice.unique_suffix))}
${row('وضعیت', invoice.status, 'amber')}
${row('امتیاز تطبیق', toPersianDigits(invoice.match_score ?? 0), 'amber')}
${row('ساخت', formatJalaliDateTime(invoice.created_at))}
${row('انقضا', formatJalaliDateTime(invoice.expires_at))}
</div>`;

          const proofPanel = proof
            ? `<div class="field">
  <label>پیامک دریافتی</label>
  <p class="hint" style="font-family:ui-monospace,monospace;background:var(--basalt);padding:.6rem;border-radius:9px;border:1px solid var(--hairline-soft);white-space:pre-wrap;direction:rtl">${escapeHtml(proof.rawMessage)}</p>
</div>
${row('قالب شناسایی‌شده', `${proof.parsed.parser}${proof.parsed.bank ? ` · ${proof.parsed.bank}` : ''}`)}
${row('اعتماد تحلیل', `${toPersianDigits(confidence)}٪`, proof.parsed.confidence >= 0.8 ? 'settle' : 'amber')}
${row('مبلغ استخراج‌شده', proof.parsed.amountToman === null ? 'استخراج نشد' : `${toman(proof.parsed.amountToman)} تومان`)}
${row('شماره پیگیری', proof.parsed.reference ?? '—')}
${row('کارت مقصد', proof.parsed.destinationCard ?? '—')}
${row('زمان پیامک', proof.parsed.occurredAt ? formatJalaliDateTime(proof.parsed.occurredAt) : '—')}
${
  proof.parsed.warnings.length > 0
    ? `<div class="alert alert-warn" style="font-size:.75rem">${proof.parsed.warnings.map((warning) => escapeHtml(warning)).join('<br>')}</div>`
    : ''
}
${invoice.match_reasons ? `<p class="hint" style="font-size:.72rem;line-height:1.9">دلایل ارجاع: ${escapeHtml(invoice.match_reasons)}</p>` : ''}`
            : alert('error', 'پیامک متناظر با این پرداخت پیدا نشد. بدون شواهد بانکی، تأیید ممکن نیست.');

          const decision = `<div style="display:flex;gap:.5rem;margin-top:1rem;flex-wrap:wrap;align-items:flex-start">
${
  proof
    ? `<form method="post" action="/admin/review/${encodeURIComponent(invoice.id)}/confirm">
${csrf}
<button class="btn btn-primary" type="submit">تأیید پرداخت و تسویه</button>
</form>`
    : ''
}
<form method="post" action="/admin/review/${encodeURIComponent(invoice.id)}/reject" style="display:flex;gap:.4rem;flex:1;min-width:18rem">
${csrf}
<input class="input" name="reason" required minlength="3" maxlength="300" placeholder="دلیل رد (در گزارش رویدادها ثبت می‌شود)">
<button class="btn" type="submit">رد پرداخت</button>
</form>
</div>`;

          return panel(
            `فاکتور <span class="mono" style="font-size:.78rem">${escapeHtml(invoice.id)}</span>`,
            `<div class="grid-2" style="gap:1rem"><div>${facts}</div><div>${proofPanel}</div></div>${decision}`,
            `<span style="font-size:.75rem;color:var(--faint)">${escapeHtml(formatRelativeFa(invoice.created_at))}</span>`,
          );
        })
        .join('');

      return `<div class="stack" style="gap:1rem">${cards}</div>`;
    },
  );
}

// ===========================================================================
// Registration
// ===========================================================================

export function registerAdminRoutes(app: Hono<AppEnv>): void {
  app.get('/admin', (c) => overviewPage(c));

  app.get('/admin/users', (c) => usersPage(c));

  app.get('/admin/users/:id', (c) => userDetailPage(c, c.req.param('id')));

  app.get('/admin/review', (c) => reviewPage(c));

  // --- Revenue (§31) -------------------------------------------------------

  app.get('/admin/revenue', (c) =>
    renderAdmin(
      c,
      {
        title: 'درآمد',
        heading: 'درآمد درگاه',
        subheading: 'کارمزد، بر پایه دفتر کل کیف پول‌ها',
        path: '/admin/revenue',
        permission: 'reports:read',
      },
      async () => {
        const reporting = new ReportingService(c.get('appContext').env.DB);
        const [byMerchant, byDay] = await Promise.all([
          reporting.revenueByMerchant(50),
          reporting.feesByDay(30),
        ]);

        const table =
          byMerchant.length === 0
            ? emptyState({
                title: 'درآمدی ثبت نشده',
                body: 'هنوز کارمزدی از هیچ پذیرنده‌ای دریافت نشده است. کارمزد فقط روی پرداخت تأییدشده ثبت می‌شود.',
              })
            : `<div class="table-wrap"><table><thead><tr><th>پذیرنده</th><th>کد</th><th>کارمزد</th><th>حجم تأییدشده</th><th>پرداخت موفق</th></tr></thead><tbody>
${byMerchant
  .map(
    (merchant) => `<tr>
<td><a href="/admin/users/${encodeURIComponent(merchant.userId)}">${escapeHtml(merchant.displayName ?? merchant.merchantCode)}</a></td>
<td class="mono" style="font-size:.74rem">${escapeHtml(merchant.merchantCode)}</td>
<td class="num">${escapeHtml(toman(merchant.fees))}</td>
<td class="num">${escapeHtml(toman(merchant.volume))}</td>
<td class="num">${toPersianDigits(merchant.paidCount)}</td>
</tr>`,
  )
  .join('')}
</tbody></table></div>`;

        return `${panel('کارمزد ۳۰ روز گذشته', barChart(byDay.map((point) => ({ label: point.day.slice(5), value: point.amount }))))}
<div style="margin-top:1rem">${panel('کارمزد به تفکیک پذیرنده', table)}</div>`;
      },
    ),
  );

  // --- Invoices (§32) ------------------------------------------------------

  app.get('/admin/invoices', (c) =>
    renderAdmin(
      c,
      {
        title: 'فاکتورها',
        heading: 'همه فاکتورها',
        subheading: 'فیلتر بر اساس وضعیت، جست‌وجو بر اساس شناسه یا مبلغ',
        path: '/admin/invoices',
        permission: 'invoices:read',
        actions: `<form method="get" action="/admin/invoices" style="display:flex;gap:.4rem">
<input class="input" name="q" value="${escapeHtml(new URL(c.req.url).searchParams.get('q') ?? '')}" placeholder="شناسه، مبلغ یا موبایل" style="min-width:14rem">
<button class="btn" type="submit">جست‌وجو</button>
</form>`,
      },
      async () => {
        const { services } = await requirePermission(c, 'invoices:read');
        const url = new URL(c.req.url);
        const status = url.searchParams.get('status') ?? '';
        const search = url.searchParams.get('q') ?? '';

        const filters: Parameters<typeof services.invoices.listAll>[0] = { limit: 100 };
        // Validated against the state machine rather than cast, so `?status=<anything>`
        // cannot reach a query with an unknown value.
        if (status && (INVOICE_STATUSES as readonly string[]).includes(status)) {
          filters.status = status as InvoiceStatus;
        }
        if (search) filters.search = search;

        const rows = await services.invoices.listAll(filters);

        const table =
          rows.length === 0
            ? emptyState({
                title: 'فاکتوری پیدا نشد',
                body: 'فیلتر را عوض کنید یا عبارت جست‌وجو را کوتاه‌تر کنید.',
              })
            : `<div class="table-wrap"><table><thead><tr>
<th>شناسه</th><th>پذیرنده</th><th>مبلغ پرداختی</th><th>ریال</th><th>وضعیت</th><th>محیط</th><th>ساخت</th>
</tr></thead><tbody>
${rows
  .map(
    (invoice) => `<tr>
<td class="mono" style="font-size:.68rem">${escapeHtml(invoice.id)}</td>
<td><a href="/admin/users/${encodeURIComponent(invoice.merchant_user_id)}">${escapeHtml(invoice.merchant_code ?? invoice.merchant_mobile)}</a></td>
<td class="num">${escapeHtml(toman(invoice.payable_amount))}</td>
<td class="num" style="color:var(--faint)">${escapeHtml(toman(invoice.payable_amount * 10))}</td>
<td>${badge(invoice.status)}</td>
<td style="font-size:.72rem;color:var(--faint)">${escapeHtml(invoice.environment)}</td>
<td style="color:var(--faint);font-size:.72rem">${escapeHtml(formatRelativeFa(invoice.created_at))}</td>
</tr>`,
  )
  .join('')}
</tbody></table></div>`;

        const chip = (label: string, value: string): string =>
          `<a class="btn${status === value ? ' btn-primary' : ''}" href="/admin/invoices${value ? `?status=${value}` : ''}">${escapeHtml(label)}</a>`;

        return `<div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem">
${chip('همه', '')}${chip('پرداخت‌شده', 'PAID')}${chip('معلق', 'PENDING')}${chip('منقضی', 'EXPIRED')}${chip('بررسی دستی', 'MANUAL_REVIEW')}${chip('ناموفق', 'FAILED')}
</div>
${panel('فاکتورها', table)}`;
      },
    ),
  );

  // --- Merchant lifecycle actions (§29) -----------------------------------

  app.post('/admin/users/:id/action', async (c) => {
    const session = await requirePermission(c, 'merchants:read');
    const form = await readForm(c);
    const userId = c.req.param('id');
    const spec = MERCHANT_ACTIONS[form.value('action')];

    if (!spec) throw new AppError('VALIDATION_FAILED', { message: 'اقدام ناشناخته است.' });
    assertPermission(session, spec.permission);

    const reason = form.value('reason');
    if (spec.needsReason && reason.length < 3) {
      return redirect(`/admin/users/${encodeURIComponent(userId)}?err=reason_required`);
    }

    const result = await session.services.merchants.applyAction(
      userId,
      spec.action,
      { reason: reason || null },
      actor(c, session),
      c.get('appContext').requestId,
    );

    // A freshly issued key is shown here and then gone. It is deliberately NOT carried
    // through a redirect: a query parameter would put a live secret into access logs, the
    // Referer header of the next request, and the operator's history — three places an API
    // key must never be. Rendering the response directly is the only way to show it once
    // and keep it out of all three.
    if (result.initialApiKey) {
      const key = result.initialApiKey;
      return renderAdmin(
        c,
        {
          title: 'کلید API ساخته شد',
          heading: 'کلید API ساخته شد',
          subheading: 'این کلید فقط همین یک بار نمایش داده می‌شود',
          path: '/admin/users',
          permission: 'merchants:read',
        },
        () =>
          `${alert('warn', 'این کلید را همین حالا کپی کنید. پایگاه‌داده فقط هش آن را نگه می‌دارد و بازیابی کلید ممکن نیست.')}
${panel(
  'کلید پذیرنده',
  `<div class="field">
<label>کلید API</label>
<div class="key-reveal">
  <span>${escapeHtml(key.fullKey)}</span>
  <button class="btn" type="button" data-copy="${escapeHtml(key.fullKey)}">کپی کلید</button>
</div>
<p class="hint">پذیرنده این کلید را در هدر <code>X-API-Key</code> می‌فرستد.</p>
</div>
<div class="stack" style="gap:.5rem;margin-top:.9rem">
${row('شناسه کلید', key.view.id)}
${row('شناسه کوتاه', key.view.hint)}
${row('محیط', key.view.environment)}
</div>
<div style="margin-top:1rem"><a class="btn" href="/admin/users/${encodeURIComponent(userId)}">بازگشت به پروفایل پذیرنده</a></div>`,
)}`,
      );
    }

    return redirect(`/admin/users/${encodeURIComponent(userId)}?ok=${spec.ok}`);
  });

  // --- Manual wallet adjustment (§30) -------------------------------------

  app.post('/admin/users/:id/wallet', async (c) => {
    const session = await requirePermission(c, 'merchants:read');
    const form = await readForm(c);
    const userId = c.req.param('id');
    const base = `/admin/users/${encodeURIComponent(userId)}`;

    const reason = form.value('reason');
    if (reason.length < 3) return redirect(`${base}?err=reason_required`);

    let amount: number;
    try {
      amount = parseTomanInput(form.value('amount'));
    } catch {
      return redirect(`${base}?err=amount_invalid`);
    }
    if (amount <= 0) return redirect(`${base}?err=amount_invalid`);

    // The form names a direction and the amount is always positive, so the ledger type
    // follows from an explicit choice rather than from the sign of a parsed number.
    // `ADMIN_CREDIT` and `ADMIN_DEBIT` are distinct ledger types and the running totals in
    // `v_wallet_overview` key off them; deriving the type in one place is what keeps
    // "manual adjustments" a meaningful figure rather than a net one.
    const decreasing = form.value('direction') === 'debit';
    assertPermission(session, decreasing ? 'wallets:debit' : 'wallets:credit');

    const credentials = actor(c, session);
    const requestId = c.get('appContext').requestId;

    try {
      await session.services.wallet[decreasing ? 'debit' : 'credit']({
        merchantUserId: userId,
        amount,
        type: decreasing ? 'ADMIN_DEBIT' : 'ADMIN_CREDIT',
        referenceType: 'admin_adjustment',
        description: reason,
        createdBy: credentials.userId,
      });
    } catch (error) {
      // An over-debit is a refused request, not a server fault. Showing the balance is more
      // useful to the operator than an error page, and the attempt is still logged.
      c.get('appContext').logger.warn('admin.wallet_adjust_failed', {
        merchantUserId: userId,
        direction: decreasing ? 'DEBIT' : 'CREDIT',
        code: error instanceof AppError ? error.code : 'UNKNOWN',
        requestId,
      });
      return redirect(`${base}?err=wallet_insufficient`);
    }

    await session.services.audit.record({
      event: 'wallet.adjusted',
      severity: 'WARNING',
      actor: credentials,
      merchantUserId: userId,
      targetType: 'wallet',
      targetId: userId,
      metadata: { amount, reason, direction: decreasing ? 'DEBIT' : 'CREDIT' },
      requestId,
    });

    return redirect(`${base}?ok=${decreasing ? 'wallet_debited' : 'wallet_credited'}`);
  });

  // --- Manual review decisions (§19, §54) ---------------------------------

  app.post('/admin/review/:invoiceId/confirm', async (c) => {
    const session = await requirePermission(c, 'review:read');
    assertPermission(session, 'transactions:confirm');
    await readForm(c);

    const context = c.get('appContext');
    const invoiceId = c.req.param('invoiceId');
    const invoice = await session.services.invoices.getById(invoiceId);

    if (!invoice || invoice.status !== 'MANUAL_REVIEW') {
      return redirect('/admin/review?err=not_reviewable');
    }

    const proof = await session.services.sms.reviewContext(invoice);
    if (!proof) {
      // Refusing here is the point of the queue. Confirming without the bank message would
      // mean releasing money on the strength of an invoice row alone — which is precisely
      // the claim the system exists to verify.
      return redirect('/admin/review?err=no_sms_evidence');
    }

    const result = await confirmPayment({
      db: context.env.DB,
      settings: session.services.settings,
      audit: session.services.audit,
      invoices: session.services.invoices,
      invoice,
      parsed: proof.parsed,
      smsMessageId: proof.smsMessageId,
      receivedAt: proof.receivedAt,
      matchScore: invoice.match_score ?? 0,
      matchReasons: invoice.match_reasons ? invoice.match_reasons.split(' · ') : [],
      confirmation: 'MANUAL',
      confirmedBy: session.user.id,
      requestId: context.requestId,
    });

    if (!result.confirmed) {
      context.logger.warn('admin.review_confirm_rejected', {
        invoiceId,
        outcome: result.outcome,
        detail: result.detail,
        requestId: context.requestId,
      });
      return redirect(
        `/admin/review?err=${result.outcome === 'ALREADY_PAID' ? 'not_reviewable' : 'no_sms_evidence'}`,
      );
    }

    // Announcement happens after the money is committed, and its result is not consulted
    // (§20). A merchant whose endpoint is down must not leave the payment in limbo, so a
    // failing callback is a webhook-log problem, never a payment problem.
    await announceConfirmedPayment({
      db: context.env.DB,
      webhooks: session.services.webhooks,
      telegram: session.services.telegram,
      logger: context.logger,
      baseUrl: context.config.baseUrl,
      invoice,
      transactionId: result.transactionId,
      automatic: false,
      requestId: context.requestId,
    });

    return redirect('/admin/review?ok=review_confirmed');
  });

  app.post('/admin/review/:invoiceId/reject', async (c) => {
    const session = await requirePermission(c, 'review:read');
    assertPermission(session, 'transactions:reject');
    const form = await readForm(c);
    const invoiceId = c.req.param('invoiceId');
    const reason = form.value('reason');

    if (reason.length < 3) return redirect('/admin/review?err=reason_required');

    const invoice = await session.services.invoices.getById(invoiceId);
    if (!invoice || invoice.status !== 'MANUAL_REVIEW') {
      return redirect('/admin/review?err=not_reviewable');
    }

    // Rejection is a transition, never a deletion. The invoice keeps its claimed amount
    // until the expiry sweep releases it, so a payment refused for a bad reason can be
    // found again in the audit log instead of vanishing.
    await session.services.invoices.transition(invoiceId, 'FAILED', {
      reason,
      requestId: c.get('appContext').requestId,
      actorUserId: session.user.id,
      actorRole: session.user.role,
    });

    return redirect('/admin/review?ok=review_rejected');
  });

  // --- Audit log (§36) ----------------------------------------------------

  app.get('/admin/audit-logs', (c) =>
    renderAdmin(
      c,
      {
        title: 'گزارش رویدادها',
        heading: 'گزارش رویدادها',
        subheading: 'هر اقدام حساس روی پلتفرم، فقط خواندنی',
        path: '/admin/audit-logs',
        permission: 'audit:read',
      },
      async () => {
        const session = await requirePermission(c, 'audit:read');
        const url = new URL(c.req.url);
        const event = url.searchParams.get('event') ?? '';
        const merchantUserId = url.searchParams.get('merchant') ?? '';

        const filters: Parameters<typeof session.services.audit.list>[0] = { limit: 100 };
        if (event) filters.event = event;
        if (merchantUserId) filters.merchantUserId = merchantUserId;

        const [entries, eventTypes] = await Promise.all([
          session.services.audit.list(filters),
          session.services.audit.eventTypes(),
        ]);

        // Grouped by prefix so the filter stays navigable as events accumulate. A flat list
        // of two hundred names is not a control anyone can actually use.
        const grouped = new Map<string, string[]>();
        for (const type of eventTypes) {
          const dot = type.indexOf('.');
          const prefix = dot > 0 ? type.slice(0, dot) : 'سایر';
          const bucket = grouped.get(prefix) ?? [];
          bucket.push(type);
          grouped.set(prefix, bucket);
        }

        const filterBar = `<form method="get" action="/admin/audit-logs" style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem">
<select class="input" name="event" style="min-width:15rem">
<option value="">همه رویدادها</option>
${[...grouped.entries()]
  .map(
    ([prefix, types]) =>
      `<optgroup label="${escapeHtml(prefix)}">${types
        .map(
          (type) =>
            `<option value="${escapeHtml(type)}"${event === type ? ' selected' : ''}>${escapeHtml(type)}</option>`,
        )
        .join('')}</optgroup>`,
  )
  .join('')}
</select>
<button class="btn" type="submit">فیلتر</button>
${event || merchantUserId ? '<a class="btn" href="/admin/audit-logs">پاک کردن</a>' : ''}
</form>`;

        const severityStatus = (severity: string): string =>
          severity === 'CRITICAL' ? 'FAILED' : severity === 'WARNING' ? 'MANUAL_REVIEW' : 'ACTIVE';

        const table =
          entries.length === 0
            ? emptyState({ title: 'رویدادی ثبت نشده', body: 'با این فیلتر چیزی پیدا نشد.' })
            : `<div class="table-wrap"><table><thead><tr>
<th>رویداد</th><th>شدت</th><th>کنشگر</th><th>پذیرنده</th><th>هدف</th><th>زمان</th><th>درخواست</th>
</tr></thead><tbody>
${entries
  .map((entry) => {
    const severity = String(entry['severity'] ?? 'INFO');
    const merchant = entry['merchant_user_id'];
    return `<tr>
<td style="font-size:.75rem">${escapeHtml(String(entry['event']))}</td>
<td>${badge(severityStatus(severity), severity)}</td>
<td style="font-size:.72rem;color:var(--muted)">${escapeHtml(String(entry['actor_role'] ?? '—'))}</td>
<td style="font-size:.72rem">${
      merchant
        ? `<a href="/admin/users/${encodeURIComponent(String(merchant))}">${escapeHtml(String(merchant).slice(0, 10))}</a>`
        : '—'
    }</td>
<td style="font-size:.72rem;color:var(--faint)">${escapeHtml(String(entry['target_type'] ?? '—'))}</td>
<td style="font-size:.72rem;color:var(--faint)">${escapeHtml(formatJalaliDateTime(String(entry['created_at'])))}</td>
<td class="mono" style="font-size:.68rem;color:var(--faint)">${escapeHtml(String(entry['request_id'] ?? '—').slice(0, 12))}</td>
</tr>`;
  })
  .join('')}
</tbody></table></div>`;

        return `${filterBar}${panel('رویدادها', table)}
<p class="hint" style="margin-top:.75rem;font-size:.72rem;color:var(--faint);line-height:1.9">
این رکوردها از سمت برنامه فقط خواندنی‌اند: تریگرهای پایگاه‌داده هر تلاش برای تغییر یا حذف را رد می‌کنند.
</p>`;
      },
    ),
  );
}
