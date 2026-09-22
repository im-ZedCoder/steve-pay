/**
 * Session handling for the operator and merchant dashboards (§5, §59).
 *
 * One module so authorisation is decided in one place. Every dashboard route calls
 * `requirePermission`, which resolves the session, checks the account is usable, and
 * checks the permission against the role's matrix — in that order, because the cheapest
 * and most decisive check should fail first.
 *
 * Two deliberate non-features:
 *
 *   - **No flash-message storage.** A one-shot message is carried in the query string as
 *     a *code* (`?ok=user_approved`), never as literal text. Reflecting arbitrary text
 *     into a page would be a reflected-XSS sink, and a code also forces a fixed, audited
 *     vocabulary on every operator-facing message.
 *   - **No impersonation.** `merchants:impersonate` exists in the permission matrix, but
 *     nothing consumes it. Impersonation is the single easiest way to launder an
 *     unauthorised action into someone else's audit trail, so it stays unimplemented
 *     until there is a reason that justifies the risk.
 */

import type { RouteContext } from '../app';
import { servicesFor, type Services } from './container';
import { AppError } from '../core/errors';
import { SESSION_COOKIE_NAME, parseCookies } from '../core/cookies';
import { CSRF_FIELD, assertCsrf, issueCsrf } from '../core/csrf';
import { hasPermission, isAdminRole, type Permission, type Role } from '../core/roles';
import type { UserRow } from '../services/auth';

export interface SessionView {
  id: string;
  mobile: string;
  role: Role;
  displayName: string | null;
  status: string;
  mustChangePassword: boolean;
}

export interface ResolvedSession {
  services: Services;
  user: SessionView;
  sessionId: string;
}

export function sessionView(user: UserRow): SessionView {
  return {
    id: user.id,
    mobile: user.mobile,
    role: user.role,
    displayName: user.display_name,
    status: user.status,
    mustChangePassword: user.must_change_password === 1,
  };
}

/** Resolves the session cookie, or null when there is no valid session. */
export async function loadSession(c: RouteContext): Promise<ResolvedSession | null> {
  const context = c.get('appContext');
  const services = servicesFor(context);

  const cookies = parseCookies(c.req.header('cookie') ?? null);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  const resolved = await services.auth.resolveSession(token);
  if (!resolved) return null;

  return {
    services,
    user: sessionView(resolved.user),
    sessionId: resolved.session.id,
  };
}

/**
 * Requires a signed-in user whose account may still operate.
 *
 * `assertUsable` is called here as well as on the machine API, because the two paths are
 * independent: suspending a merchant must close their dashboard *and* stop their API keys,
 * and neither check can rely on the other having run.
 */
export async function requireSession(c: RouteContext): Promise<ResolvedSession> {
  const session = await loadSession(c);
  if (!session) {
    throw new AppError('UNAUTHENTICATED', {
      message: 'برای دیدن این صفحه باید وارد شوید.',
    });
  }

  if (session.user.role === 'MERCHANT') {
    await session.services.merchants.assertUsable(session.user.id);
  } else if (session.user.status !== 'ACTIVE') {
    // An admin whose account was suspended must not keep a working dashboard.
    throw new AppError('ACCOUNT_SUSPENDED', { message: 'حساب شما فعال نیست.' });
  }

  return session;
}

export async function requireMerchant(c: RouteContext): Promise<ResolvedSession> {
  const session = await requireSession(c);
  if (session.user.role !== 'MERCHANT') {
    throw new AppError('FORBIDDEN', { message: 'این بخش مخصوص پذیرندگان است.' });
  }
  return session;
}

/**
 * Requires an admin role holding `permission`.
 *
 * A `MERCHANT` has an empty permission set by design (see `ROLE_PERMISSIONS`), so a
 * merchant session can never satisfy an admin permission even if a route were mounted
 * under the wrong path. The explicit role check is the belt to that braces.
 */
export async function requirePermission(c: RouteContext, permission: Permission): Promise<ResolvedSession> {
  const session = await requireSession(c);

  if (!isAdminRole(session.user.role)) {
    throw new AppError('FORBIDDEN', { message: 'این بخش مخصوص مدیران است.' });
  }
  if (!hasPermission(session.user.role, permission)) {
    throw new AppError('PERMISSION_DENIED', {
      message: 'نقش شما اجازه این کار را ندارد.',
      details: { permission, role: session.user.role },
    });
  }

  return session;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export interface FormResult {
  body: Record<string, unknown>;
  value: (key: string) => string;
  csrfToken: string;
}

/**
 * Parses and CSRF-checks a form post.
 *
 * Returns a fresh CSRF token alongside the body, because every handler that re-renders a
 * form needs one and the previous token's cookie may be absent (a user who opened the page
 * in a second tab, or whose cookie expired while the form was open).
 */
export async function readForm(c: RouteContext): Promise<FormResult> {
  const context = c.get('appContext');
  const raw = (await c.req.parseBody()) as Record<string, unknown>;
  await assertCsrf(c.req.header('cookie') ?? null, raw[CSRF_FIELD]);

  const csrf = await issueCsrf(context.config.isProduction);

  const value = (key: string): string => {
    const found = raw[key];
    if (typeof found === 'string') return found.trim();
    if (typeof found === 'number') return String(found);
    return '';
  };

  return { body: raw, value, csrfToken: csrf.token };
}

/** Attaches the CSRF cookie to a response. */
export function withCsrfCookie(response: Response, cookie: string): Response {
  response.headers.append('set-cookie', cookie);
  return response;
}

/** Issues a token and cookie for a GET that renders a form. */
export async function csrfForGet(c: RouteContext): Promise<{ token: string; cookie: string }> {
  const context = c.get('appContext');
  const issued = await issueCsrf(context.config.isProduction);
  return { token: issued.token, cookie: issued.cookie };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * The fixed vocabulary of operator-facing outcome messages.
 *
 * A code that is not in this map renders nothing, so a crafted `?err=` cannot put words in
 * the interface's mouth — which is the same reason the message is not passed as text.
 */
const MESSAGES: Record<string, { tone: 'success' | 'error' | 'info' | 'warn'; text: string }> = {
  user_approved: { tone: 'success', text: 'پذیرنده تأیید شد و کلید API برای او ساخته شد.' },
  user_rejected: { tone: 'success', text: 'درخواست پذیرنده رد شد.' },
  user_suspended: { tone: 'success', text: 'پذیرنده معلق شد و دسترسی او بسته شد.' },
  user_banned: { tone: 'success', text: 'پذیرنده مسدود شد.' },
  user_reactivated: { tone: 'success', text: 'پذیرنده فعال شد.' },
  user_reset: { tone: 'success', text: 'حساب بازنشانی شد و گذرواژه موقت ساخته شد.' },
  wallet_credited: { tone: 'success', text: 'کیف پول افزایش یافت و در دفتر کل ثبت شد.' },
  wallet_debited: { tone: 'success', text: 'کیف پول کاهش یافت و در دفتر کل ثبت شد.' },
  review_confirmed: { tone: 'success', text: 'پرداخت تأیید شد و تسویه انجام شد.' },
  review_rejected: { tone: 'success', text: 'پرداخت رد شد و فاکتور بسته شد.' },
  reason_required: { tone: 'error', text: 'برای این کار نوشتن دلیل الزامی است.' },
  amount_invalid: { tone: 'error', text: 'مبلغ واردشده معتبر نیست.' },
  approval_not_allowed: { tone: 'error', text: 'این تغییر وضعیت از وضعیت فعلی پذیرنده مجاز نیست.' },
  wallet_insufficient: { tone: 'error', text: 'موجودی کیف پول برای این کاهش کافی نیست.' },
  no_sms_evidence: { tone: 'error', text: 'پیامک متناظر با این پرداخت پیدا نشد، بنابراین تأیید ممکن نیست.' },
  not_reviewable: { tone: 'error', text: 'این فاکتور در وضعیت بررسی دستی نیست.' },
  permission_denied: { tone: 'error', text: 'نقش شما اجازه این کار را ندارد.' },
};

export function messageFor(code: string | undefined): { tone: 'success' | 'error' | 'info' | 'warn'; text: string } | null {
  if (!code) return null;
  return MESSAGES[code] ?? null;
}

/** Keeps only the characters a URL query value may contain, so `?ok=` cannot carry markup. */
export function messageCode(ok: boolean, code: string): string {
  const value = ok ? `ok=${code}` : `err=${code}`;
  return /^[a-z_]+=[a-z_]+$/.test(value) ? value : '';
}
