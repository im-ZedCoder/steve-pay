/**
 * Document shell and shared components.
 *
 * Server-rendered HTML, no client framework. For a payment gateway that is not
 * minimalism for its own sake: the payment page renders on a phone with a poor
 * connection, and a framework runtime would be the largest thing on it. The
 * interactive parts — copy, countdown, status polling, scroll reveal — are one
 * small vanilla bundle served from `/assets/client.js`.
 *
 * Every page goes through one of the four shells here, so the document head (RTL
 * direction, charset, viewport, theme colour, CSP-friendly styles), and the public
 * chrome, are defined once and cannot be forgotten on a new page.
 *
 * The components in this file are where the design system's discipline is actually
 * enforced. `badge` refuses a status word that is not in its tone map, `amount`
 * always puts Toman above Rial, and `pipelineSpine` renders a lit stage only when
 * the caller says the fact exists — so no page can invent a state or invert a unit.
 */

import { escapeHtml } from '../core/http';
import { toPersianDigits } from '../core/digits';
import { formatTomanFa, type Toman } from '../core/money';
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
  /**
   * Scheme and host of the request, e.g. `https://pay.example.com`.
   *
   * Only the footer uses it, to name the address the reader is actually on rather than
   * a domain written into the source. Optional so that a page rendered with no request
   * to read — and the tests that render one — still produce complete markup.
   */
  origin?: string;
  noindex?: boolean;
  /** Meta description. Only worth setting on the pages meant to be indexed. */
  description?: string;
  /**
   * Page-specific rules, appended after the shared stylesheet.
   *
   * Exists so a single page can lay itself out without either polluting the shared
   * stylesheet with a rule nothing else uses, or reaching for an inline style attribute
   * on a wrapper. Appended last, so a page rule wins over the shared rule it refines.
   */
  extraCss?: string;
  /**
   * Emit the drifting aurora layer behind the page.
   *
   * On for the surfaces someone reads — landing, docs, sign-in — and off everywhere
   * else. It is one fixed layer holding two blurred, drifting blobs, which is the nice
   * half of the background and also the half that costs GPU time; the payment page and
   * the consoles cover the ground with an opaque surface anyway, so neither gains
   * anything from paying for it. Both still get the static half (a radial ground and a
   * single still bloom), which is drawn by body pseudo-elements with no extra DOM.
   */
  aurora?: boolean;
}

export function shell(options: ShellOptions, body: string): string {
  const css = options.css === 'app' ? APP_CSS : PAY_CSS;
  return `<!doctype html>
<html lang="${escapeHtml(options.lang ?? 'fa')}" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#05070D">
<title>${escapeHtml(options.title)}</title>
${options.description ? `<meta name="description" content="${escapeHtml(options.description)}">` : ''}
${options.noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}
<meta property="og:title" content="${escapeHtml(options.title)}">
${options.description ? `<meta property="og:description" content="${escapeHtml(options.description)}">` : ''}
<meta property="og:type" content="website">
<style>${css}${options.extraCss ?? ''}</style>
</head>
<body${options.bodyClass ? ` class="${escapeHtml(options.bodyClass)}"` : ''}>
${options.aurora ? '<div class="bg-aurora" aria-hidden="true"><i></i><i></i></div>' : ''}
${body}
${options.script === false ? '' : '<script src="/assets/client.js" defer></script>'}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

/**
 * A section label.
 *
 * A wide-tracked label above a heading, marking where the region starts. It is a div, not
 * a paragraph, and that is load-bearing rather than cosmetic: the three places it appears
 * most — the operator page header, a band head, and the docs head — all style their own
 * paragraphs with a type-based descendant rule (.top p, .band-head p, .docs-head p). Those
 * are specificity 0-1-1 against .eyebrow's 0-1-0, so as a paragraph the label silently lost
 * its colour, size and weight to the body-copy rule of whichever container it sat in, and
 * the one device that is supposed to mark a section read as ordinary text. A div cannot be
 * reached by a p rule, which removes the collision at all four sites at once.
 */
export function eyebrow(text: string): string {
  return `<div class="eyebrow">${escapeHtml(text)}</div>`;
}

export function trace(live = false): string {
  return `<div class="${live ? 'trace-live' : 'trace'}" role="presentation"></div>`;
}

const SITE_LINKS: Array<{ href: string; label: string }> = [
  { href: '/docs', label: 'مستندات' },
  { href: '/dashboard', label: 'پنل پذیرنده' },
];

/**
 * Public chrome: the sticky top bar shared by the landing page and the docs.
 *
 * The bar floats rather than spanning the viewport: the sticky element is a plain
 * positioning frame and the glass panel inside it is capped to the page measure, so the
 * header lines up with the content column instead of running to the window edges.
 */
export function siteHeader(currentPath: string): string {
  const links = SITE_LINKS.map(
    (link) =>
      `<a href="${escapeHtml(link.href)}"${currentPath.startsWith(link.href) ? ' aria-current="page"' : ''}>${escapeHtml(link.label)}</a>`,
  ).join('');

  return `<header class="site-nav">
  <nav class="site-nav-inner" aria-label="ناوبری اصلی">
    <a class="site-brand" href="/"><span class="brand-tile" aria-hidden="true">S</span>Steve Gate</a>
    <div class="site-links">
      ${links}
      <a class="btn" href="/login">ورود</a>
      <a class="btn btn-primary" href="/register">ساخت حساب</a>
    </div>
  </nav>
</header>`;
}

/**
 * The footer's address line.
 *
 * Shows the host the visitor is on. It is a display of where they are, not a configured
 * value, so it is correct on a preview URL and on the custom domain at once, and there is
 * no domain in the source for anyone to update. With no origin the line is omitted rather
 * than filled with a placeholder.
 */
function footerHost(origin: string | undefined): string {
  if (!origin) return '';
  try {
    return `<span>${escapeHtml(new URL(origin).host)}</span>`;
  } catch {
    return '';
  }
}

export function siteFooter(origin?: string): string {
  const host = footerHost(origin);
  return `<footer class="site-foot">
  <div class="site-foot-inner">
    <div>
      <a class="site-brand" href="/" style="margin-bottom:.5rem">
        <span class="brand-tile" aria-hidden="true">S</span>Steve Gate
      </a>
      <div>درگاه پرداخت کارتی با تأیید خودکار از روی پیامک بانک.</div>
    </div>
    <div style="display:grid;gap:.4rem">
      <a href="/docs">مستندات API</a>
      <a href="/docs#sms">راه‌اندازی فورواردر پیامک</a>
      <a href="/dashboard">پنل پذیرنده</a>
      <a href="/login?scope=admin">ورود مدیران</a>
    </div>
    <div style="display:grid;gap:.4rem">
      ${host}
      <span>${escapeHtml(new Date().getFullYear().toString())}</span>
    </div>
  </div>
</footer>`;
}

/**
 * A complete public page: header, content, footer.
 *
 * aurora is resolved with a default rather than placed before the spread. Object spread
 * copies an explicit `undefined` over the earlier value, so a caller that simply does not
 * mention `aurora` — which is every caller — would switch the drifting layer off for the
 * whole public site, and the page would look correct in every respect except the one nobody
 * would think to check.
 */
export function publicShell(options: ShellOptions, body: string): string {
  return shell(
    { ...options, css: 'app', aurora: options.aurora ?? true },
    `${siteHeader(options.currentPath ?? '')}
${body}
${siteFooter(options.origin)}`,
  );
}

// ---------------------------------------------------------------------------
// Operator shells
// ---------------------------------------------------------------------------

interface NavGroup {
  group: string;
  links: Array<{ href: string; label: string }>;
}

/**
 * The account cluster: who is signed in, the queue count, and the way out.
 *
 * Emitted twice by each operator shell — once in the narrow layout's header row, once at the
 * foot of the desktop rail — because those two layouts want it in different places. A single
 * element cannot occupy both without `order`, and `order` would put what a sighted user sees
 * out of step with what the keyboard walks. So the markup lives here, once, and the copy a
 * given layout does not use is hidden by CSS, which also removes it from the accessibility
 * tree rather than leaving a second logout button for a screen reader to find.
 */
function navAccount(options: {
  place: 'rail' | 'bar';
  user: { displayName: string | null; mobile: string };
  unreadCount?: number;
  pendingReview?: number;
}): string {
  const notifications =
    options.unreadCount === undefined
      ? ''
      : `<a href="/dashboard/notifications">اطلاعیه‌ها${
          options.unreadCount > 0 ? ` (${toPersianDigits(options.unreadCount)})` : ''
        }</a>`;

  const queue =
    options.pendingReview === undefined
      ? ''
      : `<span style="color:${options.pendingReview > 0 ? 'var(--owed)' : 'var(--haze)'}">صف بررسی: ${toPersianDigits(
          options.pendingReview,
        )}</span>`;

  const name = options.user.displayName ?? options.user.mobile;

  return `<div class="${options.place === 'bar' ? 'nav-account' : 'nav-foot'}">
  <span class="nav-account-name">${escapeHtml(name)}</span>
  ${queue}
  ${notifications}
  <form method="post" action="/logout">
    <button class="btn" type="submit">خروج</button>
  </form>
</div>`;
}

function renderNav(groups: NavGroup[], currentPath: string): string {
  return groups
    .map(
      (group) => `<div class="nav-group">
<h2>${escapeHtml(group.group)}</h2>
${group.links
  .map(
    (link) =>
      `<a class="nav-link" href="${escapeHtml(link.href)}"${
        currentPath === link.href ? ' aria-current="page"' : ''
      }>${escapeHtml(link.label)}</a>`,
  )
  .join('')}
</div>`,
    )
    .join('');
}

/** The heading block shared by every operator page, with the trace beneath it. */
function pageHeader(options: {
  eyebrow?: string;
  heading: string;
  subheading?: string;
  actions?: string;
}): string {
  return `<header class="top">
  <div>
    ${options.eyebrow ? eyebrow(options.eyebrow) : ''}
    <h1>${escapeHtml(options.heading)}</h1>
    ${options.subheading ? `<p>${escapeHtml(options.subheading)}</p>` : ''}
  </div>
  ${options.actions ? `<div class="top-actions">${options.actions}</div>` : ''}
</header>
${trace(true)}`;
}

/** Merchant dashboard shell. */
export function dashboardShell(
  options: ShellOptions & {
    user: { displayName: string | null; mobile: string; role: string };
    unreadCount: number;
    nav: NavGroup[];
    heading: string;
    subheading?: string;
    eyebrow?: string;
    actions?: string;
  },
  body: string,
): string {
  const current = options.currentPath ?? '';

  return shell(
    { ...options, css: 'app' },
    `<div class="shell adm-root">
<nav class="nav" aria-label="ناوبری پنل پذیرنده">
  <div class="nav-top">
    <div class="nav-brand">
      <span class="brand-tile" aria-hidden="true">S</span>
      <div><b>Steve Gate</b><span>پنل پذیرنده</span></div>
    </div>
    ${navAccount({ place: 'bar', user: options.user, unreadCount: options.unreadCount })}
  </div>
  <div class="nav-links">
  ${renderNav(options.nav, current)}
  </div>
  ${navAccount({ place: 'rail', user: options.user, unreadCount: options.unreadCount })}
</nav>
<main class="main" id="main">
  ${pageHeader(options)}
  ${body}
</main>
</div>`,
  );
}

/** Admin console shell. */
export function adminShell(
  options: ShellOptions & {
    user: { displayName: string | null; mobile: string; role: string };
    nav: NavGroup[];
    heading: string;
    subheading?: string;
    eyebrow?: string;
    actions?: string;
    /** Rendered as a standing queue warning in the rail. */
    pendingReview: number;
  },
  body: string,
): string {
  const current = options.currentPath ?? '';

  return shell(
    { ...options, css: 'app' },
    `<div class="shell adm-root">
<nav class="nav" aria-label="ناوبری مدیریت">
  <div class="nav-top">
    <div class="nav-brand">
      <span class="brand-tile" aria-hidden="true">S</span>
      <div><b>Steve Gate</b><span>کنسول مدیریت</span></div>
    </div>
    ${navAccount({ place: 'bar', user: options.user, pendingReview: options.pendingReview })}
  </div>
  <div class="nav-links">
  ${renderNav(options.nav, current)}
  </div>
  ${navAccount({ place: 'rail', user: options.user, pendingReview: options.pendingReview })}
</nav>
<main class="main" id="main">
  ${pageHeader(options)}
  ${body}
</main>
</div>`,
  );
}

/** Documentation shell: a table-of-contents rail and a readable measure. */
export function docsShell(
  options: ShellOptions & {
    heading: string;
    subheading: string;
    nav: NavGroup[];
  },
  body: string,
): string {
  return publicShell(
    options,
    `<div class="shell docs-shell">
  <aside class="docs-nav" aria-label="فهرست مستندات">
    <div class="nav-links">
    ${renderNav(options.nav, options.currentPath ?? '')}
    </div>
  </aside>
  <div class="docs-body">
    <header class="docs-head">
      ${eyebrow('API REFERENCE')}
      <h1>${escapeHtml(options.heading)}</h1>
      <p>${escapeHtml(options.subheading)}</p>
    </header>
    ${body}
  </div>
</div>`,
  );
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

export function stat(options: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  tone?: 'amber' | 'settle' | 'reject';
}): string {
  return `<div class="stat${options.tone ? ` stat-${options.tone}` : ''}">
<p class="stat-label">${escapeHtml(options.label)}</p>
<p class="stat-value">${escapeHtml(options.value)}${
    options.unit ? `<small>${escapeHtml(options.unit)}</small>` : ''
  }</p>
${options.sub ? `<p class="stat-sub">${escapeHtml(options.sub)}</p>` : ''}
</div>`;
}

/**
 * Status tones.
 *
 * A status word that is not in this map renders in the neutral tone rather than
 * throwing, but the map is the complete set of statuses the state machine can emit —
 * so a new status arriving untoned is a signal that a transition was added without
 * deciding how it should read.
 */
const BADGE_TONE: Record<string, string> = {
  PAID: 'paid',
  ACTIVE: 'active',
  CONFIRMED: 'active',
  DELIVERED: 'delivered',
  CONNECTED: 'connected',
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
  DEAD_LETTER: 'dead',
  CANCELLED: 'cancelled',
  SUSPENDED: 'suspended',
  BANNED: 'banned',
  REJECTED: 'rejected',
  REVOKED: 'cancelled',
  REFUNDED: 'failed',
  PENDING_APPROVAL: 'pending',
  RESOLVED: 'active',
  CLOSED: 'cancelled',
  TEST: 'pending',
  LIVE: 'active',
  PARSED: 'delivered',
  UNPARSED: 'pending',
  IGNORED: 'pending',
};

/** Status badge. The tone comes from the status word, never from a URL. */
export function badge(status: string, label?: string): string {
  const tone = BADGE_TONE[status] ?? 'pending';
  return `<span class="badge badge-${tone}"><i aria-hidden="true"></i>${escapeHtml(label ?? status)}</span>`;
}

/**
 * Amount, formatted for the interface it appears in.
 *
 * The Toman figure is always primary and the Rial figure always secondary, in both
 * presentation and wording (§74). This component is what decides that, so no page
 * can invert it — which matters because a customer reading the wrong unit pays the
 * wrong amount.
 */
export function amount(
  toman: Toman,
  options: { size?: 'normal' | 'large'; showRial?: boolean } = {},
): string {
  const rial = toman * 10;
  const main = `<span class="num"${options.size === 'large' ? ' style="font-size:1.35rem;font-weight:700"' : ''}>${formatTomanFa(
    toman,
  )}</span> <span style="font-size:.72rem;color:var(--steel)">تومان</span>`;
  if (options.showRial === false) return main;
  return `${main}<div style="font-family:var(--mono);font-size:.68rem;color:var(--haze);margin-top:.2rem">${formatTomanFa(
    rial,
  )} ریال</div>`;
}

/** Monospace identifier, e.g. an invoice id or an API key hint. */
export function ident(value: string, options: { copy?: boolean } = {}): string {
  const copy = options.copy
    ? `<button class="btn" type="button" data-copy="${escapeHtml(value)}" style="padding:.12rem .4rem;font-size:.66rem">کپی</button>`
    : '';
  return `<span style="display:inline-flex;align-items:center;gap:.35rem">
<span class="mono" style="font-size:.72rem">${escapeHtml(value)}</span>${copy}</span>`;
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
    stages.match === 'matched'
      ? 'done'
      : stages.match === 'review' || stages.match === 'duplicate'
        ? 'blocked'
        : 'idle';
  const matchLabel =
    stages.match === 'matched'
      ? 'تطبیق'
      : stages.match === 'review'
        ? 'بررسی دستی'
        : stages.match === 'duplicate'
          ? 'تکراری'
          : 'تطبیق';

  const callbackState: 'done' | 'current' | 'idle' | 'blocked' =
    stages.callback === 'delivered'
      ? 'done'
      : stages.callback === 'pending'
        ? 'current'
        : stages.callback === 'failed'
          ? 'blocked'
          : 'idle';

  return `<div class="spine">
${node('فاکتور', stages.invoice ? 'done' : 'idle')}${sep}
${node('پیامک بانک', stages.sms ? 'done' : 'idle')}${sep}
${node(matchLabel, matchState)}${sep}
${node('تأیید پرداخت', stages.confirmed ? 'done' : 'idle')}${sep}
${node(
    stages.callback === 'delivered'
      ? 'وب‌هوک ارسال شد'
      : stages.callback === 'failed'
        ? 'وب‌هوک ناموفق'
        : 'وب‌هوک',
    callbackState,
  )}
</div>`;
}

/**
 * A bordered section with a heading.
 *
 * The title is escaped, which is the right default: most titles carry a merchant's own display
 * name. When a title genuinely needs inline markup — an invoice id that has to be rendered in
 * the monospace face and isolated from the RTL flow — pass `{ html }` instead, and escape the
 * interpolated values yourself. Passing markup as a plain string is what produced a heading
 * reading `فاکتور <span class="mono">inv_01M33…</span>` on a live page: silently escaped, so
 * the operator saw the markup rather than the identifier.
 */
export function panel(title: string | { html: string }, body: string, actions?: string): string {
  const heading = typeof title === 'string' ? escapeHtml(title) : title.html;
  return `<section class="panel">
<div class="panel-head"><h2>${heading}</h2>${actions ?? ''}</div>
${body}
</section>`;
}

export function emptyState(options: {
  title: string;
  body: string;
  action?: { href: string; label: string };
}): string {
  return `<div class="empty">
<h3>${escapeHtml(options.title)}</h3>
<p>${escapeHtml(options.body)}</p>
${options.action ? `<a class="btn btn-primary" href="${escapeHtml(options.action.href)}">${escapeHtml(options.action.label)}</a>` : ''}
</div>`;
}

/**
 * A daily series as a column sparkline.
 *
 * Distinct from `barChart` on purpose: this one answers "what shape was the week"
 * at a glance and deliberately carries no axis or value labels, because the shape is
 * the message. Quiet weeks stay visible as gaps rather than being compressed away.
 */
export function sparkline(series: Array<{ label: string; value: number }>): string {
  const max = Math.max(1, ...series.map((point) => point.value));
  return `<div class="spark" role="img" aria-label="نمودار ستونی روزانه">${series
    .map(
      (point) =>
        `<i style="height:${Math.max(4, Math.round((point.value / max) * 100))}%"${
          point.value === 0 ? ' data-zero="1"' : ''
        } title="${escapeHtml(`${point.label}: ${formatTomanFa(point.value)}`)}"></i>`,
    )
    .join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Landing and docs building blocks
// ---------------------------------------------------------------------------

/** A band heading: the title and its supporting paragraph on one baseline. */
export function bandHead(options: { eyebrow: string; title: string; lede: string }): string {
  return `<div class="band-head">
  <div>${eyebrow(options.eyebrow)}<h2>${escapeHtml(options.title)}</h2></div>
  <p>${escapeHtml(options.lede)}</p>
</div>`;
}

/**
 * A numbered process list.
 *
 * Numbering is justified here and only here: this is a sequence with a real order
 * that the reader must understand, because money moves through these stages in this
 * order and a reader who does not know that cannot debug their integration.
 */
export function stepList(items: Array<{ title: string; body: string }>): string {
  return `<ol class="steps">${items
    .map(
      (item, index) => `<li class="step">
<span class="step-num">${toPersianDigits(String(index + 1).padStart(2, '0'))}</span>
<div><h3>${escapeHtml(item.title)}</h3><p>${item.body}</p></div>
</li>`,
    )
    .join('')}</ol>`;
}

/**
 * A code surface.
 *
 * `html` is not escaped, because syntax colouring needs the markup. Every caller
 * passes a literal from this file's own page modules — no request data reaches here.
 * The `escapeHtml` on the label and note is what protects the parts that could
 * conceivably become dynamic.
 */
export function codeBlock(options: { label: string; note?: string; html: string }): string {
  return `<div class="code">
<div class="code-bar"><span>${escapeHtml(options.label)}</span>${
    options.note ? `<b>${escapeHtml(options.note)}</b>` : ''
  }<button class="code-copy" type="button" data-copy-code data-copy-label>کپی</button></div>
<pre class="code-body">${options.html}</pre>
</div>`;
}

export function factGrid(
  facts: Array<{ value: string; unit?: string; label: string; note?: string }>,
): string {
  return `<div class="facts">${facts
    .map(
      (fact) => `<div class="fact">
<b>${escapeHtml(fact.value)}${fact.unit ? `<em>${escapeHtml(fact.unit)}</em>` : ''}</b>
<span>${escapeHtml(fact.label)}</span>
${fact.note ? `<span style="color:var(--haze);font-size:.75rem">${fact.note}</span>` : ''}
</div>`,
    )
    .join('')}</div>`;
}

/** One documentation section, anchored for the rail. */
export function docsSection(options: { id: string; title: string; body: string }): string {
  return `<section class="docs-section" id="${escapeHtml(options.id)}">
<h2>${escapeHtml(options.title)}</h2>
${options.body}
</section>`;
}

/** An endpoint header. The method leads because it is what a reader scans for. */
export function endpoint(options: {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  note?: string;
}): string {
  const tone = options.method === 'POST' ? 'ep-post' : options.method === 'DELETE' ? 'ep-del' : 'ep-get';
  return `<div class="ep">
<span class="ep-method ${tone}">${escapeHtml(options.method)}</span>
<span class="ep-path">${escapeHtml(options.path)}</span>
${options.note ? `<span class="badge" style="margin-inline-start:auto">${escapeHtml(options.note)}</span>` : ''}
</div>`;
}

/** A note inside prose. */
export function docsNote(html: string): string {
  return `<div class="docs-note">${html}</div>`;
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
    { title: `${input.title} — Steve Gate`, noindex: true, script: false },
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
      ? `<div class="plate" style="margin-top:1.25rem"><span class="pay-label">شناسه پیگیری خطا</span>
<div class="mono" style="font-size:.73rem;word-break:break-all">${escapeHtml(input.requestId)}</div></div>`
      : ''
  }
  <a class="btn btn-primary btn-block" href="/">بازگشت به صفحه اصلی</a>
</div></div>`,
  );
}

export function notFoundPage(): string {
  return serverErrorPage({
    title: 'صفحه پیدا نشد',
    message: 'این آدرس روی Steve Gate وجود ندارد. اگر از یک لینک آمده‌اید، لینک را دوباره بررسی کنید.',
    status: 404,
  });
}

/** Alert box. Errors announce; everything else is a status update. */
export function alert(tone: 'error' | 'success' | 'info' | 'warn', message: string): string {
  return `<div class="alert alert-${tone}" role="${tone === 'error' ? 'alert' : 'status'}">${escapeHtml(message)}</div>`;
}
