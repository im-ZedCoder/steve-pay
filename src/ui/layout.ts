/**
 * Document shell and shared components.
 *
 * Server-rendered HTML, no client framework. For a payment gateway this is not
 * minimalism for its own sake: the payment page has to render on a phone with a
 * poor connection, and a framework runtime is the largest thing on the page. The
 * interactive parts (copy, countdown, status polling) are ~1KB of vanilla script.
 *
 * Every page goes through `shell()`, so the document head — CSP-friendly inline
 * styles, RTL direction, the charset, the viewport — is defined once and cannot be
 * forgotten on a new page.
 */

import { escapeHtml } from '../core/http';
import { toPersianDigits } from '../core/digits';
import { formatTomanFa, formatTomanEn, type Toman } from '../core/money';
import { APP_CSS, PAY_CSS } from './theme';

export interface ShellOptions {
  title: string;
  lang?: string;
  /** Dashboard pages get the heavier stylesheet; public pages do not. */
  css?: 'pay' | 'app';
  /** Extra body classes, used by the payment card's state colour. */
  bodyClass?: string;
  /**
   * Load the interaction script. False for pages with nothing to interact with,
   * which saves the request entirely.
   *
   * It is served from `/assets/client.js` rather than inlined, because the CSP is
   * `script-src 'self'` with no `'unsafe-inline'` — an inline block would be blocked
   * by the browser with no server-side symptom (see scripts/build-assets.mjs).
   */
  script?: boolean;
  /** Canonical path, used for the nav's aria-current. */
  currentPath?: string;
  noindex?: boolean;
  /**
   * Page-specific rules, appended after the shared stylesheet.
   *
   * Exists so a single page can lay itself out without either polluting the shared
   * stylesheet with a rule nothing else uses, or reaching for an inline style attribute
   * on a wrapper. Appended last, so a page rule wins over the shared rule it refines.
   */
  extraCss?: string;
}

export function shell(options: ShellOptions, body: string): string {
  const css = options.css === 'app' ? APP_CSS : PAY_CSS;
  return `<!doctype html>
<html lang="${escapeHtml(options.lang ?? 'fa')}" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#060915">
<title>${escapeHtml(options.title)}</title>
${options.noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}
<style>${css}${options.extraCss ?? ''}</style>
</head>
<body${options.bodyClass ? ` class="${escapeHtml(options.bodyClass)}"` : ''}>
${body}
${options.script === false ? '' : '<script src="/assets/client.js" defer></script>'}
</body>
</html>`;
}

/** Dashboard shell with the navigation rail. */
export function dashboardShell(
  options: ShellOptions & {
    user: { displayName: string | null; mobile: string; role: string };
    unreadCount: number;
    nav: Array<{ group: string; links: Array<{ href: string; label: string }> }>;
    heading: string;
    subheading?: string;
    actions?: string;
  },
  body: string,
): string {
  const current = options.currentPath ?? '';
  const nav = options.nav
    .map(
      (group) => `<div class="nav-group">
<h2>${escapeHtml(group.group)}</h2>
${group.links
  .map(
    (link) =>
      `<a class="nav-link" href="${escapeHtml(link.href)}"${
        current === link.href ? ' aria-current="page"' : ''
      }>${escapeHtml(link.label)}</a>`,
  )
  .join('')}
</div>`,
    )
    .join('');

  return shell(
    { ...options, css: 'app' },
    `<div class="shell">
<nav class="nav" aria-label="ناوبری اصلی">
  <div class="nav-brand"><i aria-hidden="true"></i><b>Steve Pay</b></div>
  ${nav}
  <div class="nav-foot">
    <div>${escapeHtml(options.user.displayName ?? options.user.mobile)}</div>
    <div style="margin-top:.4rem"><a href="/dashboard/notifications">اطلاعیه‌ها${
      options.unreadCount > 0 ? ` (${toPersianDigits(options.unreadCount)})` : ''
    }</a></div>
    <form method="post" action="/logout" style="margin-top:.4rem">
      <button class="btn" type="submit" style="font-size:.7rem;padding:.3rem .55rem">خروج</button>
    </form>
  </div>
</nav>
<main class="main" id="main">
  <header class="top">
    <div>
      <h1>${escapeHtml(options.heading)}</h1>
      ${options.subheading ? `<p>${escapeHtml(options.subheading)}</p>` : ''}
    </div>
    ${options.actions ? `<div class="top-actions" style="display:flex;gap:.5rem;flex-wrap:wrap">${options.actions}</div>` : ''}
  </header>
  ${body}
</main>
</div>`,
  );
}

/** Admin shell. Same rail, different links, plus a live badge for the review queue. */
export function adminShell(
  options: ShellOptions & {
    user: { displayName: string | null; mobile: string; role: string };
    nav: Array<{ group: string; links: Array<{ href: string; label: string }> }>;
    heading: string;
    subheading?: string;
    actions?: string;
    pendingReview: number;
  },
  body: string,
): string {
  const current = options.currentPath ?? '';
  const nav = options.nav
    .map(
      (group) => `<div class="nav-group">
<h2>${escapeHtml(group.group)}</h2>
${group.links
  .map(
    (link) =>
      `<a class="nav-link" href="${escapeHtml(link.href)}"${
        current === link.href ? ' aria-current="page"' : ''
      }>${escapeHtml(link.label)}</a>`,
  )
  .join('')}
</div>`,
    )
    .join('');

  return shell(
    { ...options, css: 'app' },
    `<div class="shell">
<nav class="nav" aria-label="ناوبری مدیریت">
  <div class="nav-brand"><i aria-hidden="true"></i><b>Steve Pay · مدیریت</b></div>
  ${nav}
  <div class="nav-foot">
    <div>${escapeHtml(options.user.displayName ?? options.user.mobile)}</div>
    <div style="margin-top:.3rem;color:${options.pendingReview > 0 ? 'var(--amber)' : 'var(--faint)'}">
      صف بررسی: ${toPersianDigits(options.pendingReview)}
    </div>
    <form method="post" action="/logout" style="margin-top:.4rem">
      <button class="btn" type="submit" style="font-size:.7rem;padding:.3rem .55rem">خروج</button>
    </form>
  </div>
</nav>
<main class="main" id="main">
  <header class="top">
    <div>
      <h1>${escapeHtml(options.heading)}</h1>
      ${options.subheading ? `<p>${escapeHtml(options.subheading)}</p>` : ''}
    </div>
    ${options.actions ? `<div style="display:flex;gap:.5rem;flex-wrap:wrap">${options.actions}</div>` : ''}
  </header>
  ${body}
</main>
</div>`,
  );
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** A stat card. `tone` is one of the three reserved money colours, or neutral. */
export function stat(options: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  tone?: 'amber' | 'settle' | 'reject';
}): string {
  return `<div class="stat${options.tone ? ` stat-${options.tone}` : ''}">
<p class="stat-label">${escapeHtml(options.label)}</p>
<p class="stat-value num">${escapeHtml(options.value)}${
    options.unit ? `<small>${escapeHtml(options.unit)}</small>` : ''
  }</p>
${options.sub ? `<p class="stat-sub">${escapeHtml(options.sub)}</p>` : ''}
</div>`;
}

const BADGE_TONE: Record<string, string> = {
  PAID: 'paid',
  ACTIVE: 'active',
  DELIVERED: 'delivered',
  PENDING: 'pending',
  CREATED: 'pending',
  PAYMENT_DETECTED: 'pending',
  CONFIRMING: 'pending',
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  WAITING_FOR_USER: 'waiting_for_user',
  WAITING_FOR_ADMIN: 'waiting_for_admin',
  MANUAL_REVIEW: 'manual_review',
  EXPIRED: 'expired',
  FAILED: 'failed',
  DEAD: 'dead',
  CANCELLED: 'cancelled',
  SUSPENDED: 'suspended',
  BANNED: 'banned',
  REJECTED: 'rejected',
  REFUNDED: 'failed',
  PENDING_APPROVAL: 'pending',
  TEST: 'pending',
  PARSED: 'delivered',
  IGNORED: 'pending',
};

/** Status badge. The status word comes from the state machine, never from a URL. */
export function badge(status: string, label?: string): string {
  const tone = BADGE_TONE[status] ?? 'pending';
  return `<span class="badge badge-${tone}"><i aria-hidden="true"></i>${escapeHtml(label ?? status)}</span>`;
}

/**
 * Amount, formatted for the interface it appears in.
 *
 * The Toman figure is always primary and the Rial figure always secondary, in both
 * presentation and wording (§74). This is the component that decides that, so no
 * page can invert it.
 */
export function amount(
  toman: Toman,
  options: { size?: 'normal' | 'large'; showRial?: boolean } = {},
): string {
  const rial = toman * 10;
  const main = `<span class="num"${options.size === 'large' ? ' style="font-size:1.35rem;font-weight:700"' : ''}>${formatTomanFa(
    toman,
  )}</span> <span style="font-size:.72rem;color:var(--muted)">تومان</span>`;
  if (options.showRial === false) return main;
  return `${main}<div style="font-size:.7rem;color:var(--faint);margin-top:.15rem" class="num">${formatTomanFa(
    rial,
  )} ریال</div>`;
}

/** Monospace identifier, e.g. an invoice id or an API key hint. */
export function ident(value: string, options: { copy?: boolean } = {}): string {
  const copy = options.copy
    ? `<button class="btn" type="button" data-copy="${escapeHtml(value)}" style="padding:.15rem .4rem;font-size:.68rem">کپی</button>`
    : '';
  return `<span style="display:inline-flex;align-items:center;gap:.35rem">
<span class="mono" style="font-size:.74rem">${escapeHtml(value)}</span>${copy}</span>`;
}

/**
 * The pipeline spine (§ signature).
 *
 * Encodes the real processing lifecycle: invoice created, SMS received, matched,
 * confirmed, callback delivered. A stage is lit only when the corresponding fact
 * exists in the database — it reflects state, it does not decorate it.
 */
export function pipelineSpine(stages: {
  invoice: boolean;
  sms: boolean;
  match: 'none' | 'matched' | 'review' | 'duplicate';
  confirmed: boolean;
  callback: 'none' | 'delivered' | 'pending' | 'failed';
}): string {
  const node = (label: string, state: 'done' | 'current' | 'idle' | 'blocked'): string =>
    `<span class="spine-node" data-state="${state}"><b>${escapeHtml(label)}</b></span>`;
  const sep = '<span class="spine-sep" aria-hidden="true"></span>';

  const matchState: 'done' | 'current' | 'idle' | 'blocked' =
    stages.match === 'matched' ? 'done' : stages.match === 'review' || stages.match === 'duplicate' ? 'blocked' : 'idle';
  const matchLabel =
    stages.match === 'matched' ? 'تطبیق' : stages.match === 'review' ? 'بررسی دستی' : stages.match === 'duplicate' ? 'تکراری' : 'تطبیق';

  const callbackState: 'done' | 'current' | 'idle' | 'blocked' =
    stages.callback === 'delivered' ? 'done' : stages.callback === 'pending' ? 'current' : stages.callback === 'failed' ? 'blocked' : 'idle';

  return `<div class="spine">
${node('فاکتور', stages.invoice ? 'done' : 'idle')}${sep}
${node('پیامک بانک', stages.sms ? 'done' : 'idle')}${sep}
${node(matchLabel, matchState)}${sep}
${node('تأیید پرداخت', stages.confirmed ? 'done' : 'idle')}${sep}
${node(
    stages.callback === 'delivered' ? 'وب‌هوک ارسال شد' : stages.callback === 'failed' ? 'وب‌هوک ناموفق' : 'وب‌هوک',
    callbackState,
  )}
</div>`;
}

export function panel(title: string, body: string, actions?: string): string {
  return `<section class="panel">
<div class="panel-head"><h2>${escapeHtml(title)}</h2>${actions ?? ''}</div>
${body}
</section>`;
}

export function emptyState(options: { title: string; body: string; action?: { href: string; label: string } }): string {
  return `<div class="empty">
<h3>${escapeHtml(options.title)}</h3>
<p>${escapeHtml(options.body)}</p>
${options.action ? `<a class="btn btn-primary" href="${escapeHtml(options.action.href)}">${escapeHtml(options.action.label)}</a>` : ''}
</div>`;
}

/** A simple bar chart. No charting library: the data is a handful of numbers. */
export function barChart(series: Array<{ label: string; value: number }>): string {
  const max = Math.max(1, ...series.map((point) => point.value));
  return `<div class="stack" style="gap:.5rem">${series
    .map(
      (point) => `<div class="bar-row">
<span style="min-width:4.5rem;color:var(--muted)">${escapeHtml(point.label)}</span>
<span class="bar"><span style="width:${Math.round((point.value / max) * 100)}%"></span></span>
<span class="val num">${toPersianDigits(formatTomanEn(point.value))}</span>
</div>`,
    )
    .join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Error pages (used by app.ts, which must not depend on the page modules)
// ---------------------------------------------------------------------------

export function serverErrorPage(input: {
  title: string;
  message: string;
  status: number;
  requestId?: string;
}): string {
  return shell(
    { title: `${input.title} — Steve Pay`, noindex: true, script: false },
    `<div class="pay-wrap">
<div class="pay-card state-${input.status === 404 ? 'review' : 'failed'}">
  <div class="pay-head">
    <div class="pay-logo" aria-hidden="true">!</div>
    <div><div class="pay-merchant">${escapeHtml(input.title)}</div>
    <div class="pay-meta">کد وضعیت: ${toPersianDigits(input.status)}</div></div>
  </div>
  <p class="pay-desc">${escapeHtml(input.message)}</p>
  ${
    input.requestId
      ? `<div class="plate" style="margin-top:1.25rem"><p class="pay-label">شناسه پیگیری خطا</p>
<div class="mono" style="font-size:.75rem;word-break:break-all">${escapeHtml(input.requestId)}</div></div>`
      : ''
  }
  <a class="btn btn-primary btn-block" href="/">بازگشت به صفحه اصلی</a>
</div></div>`,
  );
}

export function notFoundPage(): string {
  return serverErrorPage({
    title: 'صفحه پیدا نشد',
    message: 'این آدرس روی Steve Pay وجود ندارد. اگر از یک لینک آمده‌اید، لینک را دوباره بررسی کنید.',
    status: 404,
  });
}

/** Alert box. */
export function alert(tone: 'error' | 'success' | 'info' | 'warn', message: string): string {
  return `<div class="alert alert-${tone}" role="${tone === 'error' ? 'alert' : 'status'}">${escapeHtml(message)}</div>`;
}
