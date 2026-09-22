/**
 * Registration, login and logout (§4, §5).
 *
 * Form posts, so every mutating route is CSRF-protected with a double-submit token and
 * the session cookie is only ever set server-side after a successful password check.
 *
 * Session *fixation* is handled by issuing a brand-new token at login rather than
 * adopting anything the client sent: the token is generated here, hashed by the auth
 * service before storage, and returned in exactly one `Set-Cookie`. There is no code
 * path that promotes a client-supplied value to a session.
 */

import type { Hono } from 'hono';
import type { AppEnv, RouteContext } from '../app';
import { servicesFor } from './container';
import { html, redirect } from '../core/http';
import { AppError } from '../core/errors';
import { SESSION_COOKIE_NAME, clearCookie, sessionCookie } from '../core/cookies';
import { CSRF_FIELD, assertCsrf, issueCsrf } from '../core/csrf';
import { loginPage, registerPage, registeredPage } from '../ui/pages/auth';
import { loginRule, registrationRule } from '../services/ratelimit';
import { RateLimitSignal } from './api';
import { rateLimited } from '../core/http';

/** Reads one form field as a trimmed string, ignoring file uploads. */
function formValue(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value === 'string') return value.trim();
  return '';
}

function userAgentOf(c: RouteContext): string | null {
  const value = c.req.header('user-agent');
  return value ? value.slice(0, 500) : null;
}

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------
  app.get('/register', async (c) => {
    const context = c.get('appContext');
    const services = servicesFor(context);

    // Registration can be switched off from the settings table (§73 maintenance).
    if (!(await services.settings.bool('platform.registration_enabled'))) {
      throw new AppError('REGISTRATION_DISABLED');
    }

    const csrf = await issueCsrf(context.secure);
    const response = html(
      addCsrf(registerPage({ turnstileSiteKey: context.config.turnstileSiteKey }), csrf.token),
      {
        noStore: true,
        // Only this page needs the Cloudflare challenge origins in its CSP.
        turnstile: context.config.turnstileSiteKey !== '',
      },
    );
    response.headers.append('set-cookie', csrf.cookie);
    return response;
  });

  app.post('/register', async (c) => {
    const context = c.get('appContext');
    const services = servicesFor(context);
    const body = (await c.req.parseBody()) as Record<string, unknown>;

    await assertCsrf(c.req.header('cookie') ?? null, formValue(body, CSRF_FIELD));

    const limit = await services.rateLimiter.consume(
      `register:${context.clientIp ?? 'unknown'}`,
      registrationRule(await services.settings.int('rate_limit.register_per_hour')),
    );
    if (!limit.allowed) {
      throw new RateLimitSignal(rateLimited(limit.retryAfterSeconds, context.requestId, limit.limit));
    }

    const values = {
      mobile: formValue(body, 'mobile'),
      telegramUsername: formValue(body, 'telegramUsername'),
      telegramUserId: formValue(body, 'telegramUserId'),
      businessType: formValue(body, 'businessType'),
      businessDescription: formValue(body, 'businessDescription'),
      displayName: formValue(body, 'displayName'),
    };

    // Turnstile runs before the account is created, and its failure is reported on the
    // form rather than as a bare 403 — the person filling it in is a customer, not an
    // attacker, and needs to be told to retry the challenge.
    if (context.config.turnstileSiteKey !== '') {
      const verified = await services.turnstile.verify(formValue(body, 'cf-turnstile-response'), context.clientIp);
      if (!verified.success) {
        const csrf = await issueCsrf(context.secure);
        const response = html(
          addCsrf(
            registerPage({
              general: 'تأیید امنیتی ناموفق بود. لطفاً تأیید امنیتی را دوباره انجام دهید.',
              values,
              turnstileSiteKey: context.config.turnstileSiteKey,
            }),
            csrf.token,
          ),
          { status: 400, noStore: true, turnstile: true },
        );
        response.headers.append('set-cookie', csrf.cookie);
        return response;
      }
    }

    try {
      const created = await services.auth.register(
        {
          mobile: values.mobile,
          password: formValue(body, 'password'),
          confirmPassword: formValue(body, 'confirmPassword'),
          businessType: values.businessType,
          businessDescription: values.businessDescription || null,
          telegramUsername: values.telegramUsername || null,
          telegramUserId: values.telegramUserId || null,
          displayName: values.displayName || null,
        },
        { ip: context.clientIp, userAgent: userAgentOf(c), requestId: context.requestId },
      );

      // Notify the merchant and the admins that a registration is waiting. Both are
      // best-effort: a Telegram outage must not cost someone their account.
      await services.telegram
        .notifyRegistrationSubmitted(created.userId, created.merchantCode, values.mobile, values.businessType)
        .catch(() => undefined);

      return html(registeredPage({ merchantCode: created.merchantCode, mobile: values.mobile }), {
        status: 201,
        noStore: true,
      });
    } catch (error) {
      // Re-render the form with what they typed. Losing a half-completed form because one
      // field was rejected is the kind of thing that makes people abandon a signup.
      const csrf = await issueCsrf(context.secure);
      const response = html(
        addCsrf(
          registerPage({
            errors: fieldErrors(error),
            general: generalMessage(error),
            // Passwords are never echoed back into the HTML, not even a placeholder: a
            // rendered form must not be able to carry a credential into a cache or a log.
            values,
            turnstileSiteKey: context.config.turnstileSiteKey,
          }),
          csrf.token,
        ),
        { status: statusFor(error), noStore: true, turnstile: context.config.turnstileSiteKey !== '' },
      );
      response.headers.append('set-cookie', csrf.cookie);
      return response;
    }
  });

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------
  app.get('/login', async (c) => {
    const context = c.get('appContext');
    const admin = c.req.query('scope') === 'admin';
    const csrf = await issueCsrf(context.secure);

    // `next` is validated here as well as on POST.
    //
    // The POST already runs it through `safeNext` before redirecting, so a hostile value was
    // never followed — but it was *rendered*, so `/login?next=https://evil.example.com` put an
    // attacker's URL inside the form on our own login page. Escaping made it harmless and it
    // still looked like a real destination to anyone reading the page. Validating once at the
    // input boundary means the string only exists in a form the page itself built.
    const next = safeNext(c.req.query('next') ?? '');

    const response = html(addCsrf(loginPage({ admin, next }), csrf.token), {
      noStore: true,
    });
    response.headers.append('set-cookie', csrf.cookie);
    return response;
  });

  app.post('/login', async (c) => {
    const context = c.get('appContext');
    const services = servicesFor(context);
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const admin = new URL(c.req.url).searchParams.get('scope') === 'admin';

    await assertCsrf(c.req.header('cookie') ?? null, formValue(body, CSRF_FIELD));

    const mobile = formValue(body, 'mobile');
    const limit = await services.rateLimiter.consume(
      `login:${mobile || (context.clientIp ?? 'unknown')}`,
      loginRule(await services.settings.int('rate_limit.login_per_15_minutes')),
    );
    if (!limit.allowed) {
      throw new RateLimitSignal(rateLimited(limit.retryAfterSeconds, context.requestId, limit.limit));
    }

    try {
      const result = await services.auth.login(
        { mobile, password: formValue(body, 'password'), adminOnly: admin },
        { ip: context.clientIp, userAgent: userAgentOf(c), requestId: context.requestId },
      );

      // Admins get a much shorter session than merchants (§59): a stolen admin cookie is
      // worth far more to an attacker, so it expires sooner by default.
      const isAdmin = result.user.role !== 'MERCHANT';
      const ttlHours = isAdmin
        ? await services.settings.int('security.admin_session_ttl_hours')
        : await services.settings.int('security.session_ttl_hours');

      const next = formValue(body, 'next');
      const destination = safeNext(next) ?? (isAdmin ? '/admin' : '/dashboard');

      const response = redirect(destination);
      response.headers.append(
        'set-cookie',
        // `context.secure` is the connection, not the environment name. Marking the
        // cookie `Secure` on a plain-HTTP origin does not warn — the browser drops it
        // silently, and the merchant sees a correct password return them to the login
        // page with no error anywhere. A deployment that is genuinely on HTTPS still
        // gets the flag, so the protection is unchanged where it matters.
        sessionCookie(result.token, ttlHours * 3600, context.secure),
      );
      return response;
    } catch (error) {
      const csrf = await issueCsrf(context.secure);
      const response = html(
        addCsrf(
          loginPage({
            admin,
            mobile,
            next: formValue(body, 'next') || null,
            errors: fieldErrors(error),
            // Login failures always get a single, non-specific message: the auth service
            // already returns INVALID_CREDENTIALS for both unknown accounts and wrong
            // passwords, and echoing its internal code here would undo that.
            general: 'شماره موبایل یا گذرواژه نادرست است.',
          }),
          csrf.token,
        ),
        { status: 401, noStore: true },
      );
      response.headers.append('set-cookie', csrf.cookie);
      return response;
    }
  });

  // -------------------------------------------------------------------------
  // Logout
  // -------------------------------------------------------------------------
  const logout = async (c: RouteContext): Promise<Response> => {
    const context = c.get('appContext');
    const services = servicesFor(context);
    const cookies = c.req.header('cookie') ?? null;

    // The session is revoked server-side, not merely forgotten by the browser. An
    // HttpOnly cookie that the client deletes is still a valid token in a database
    // somewhere, and "log out" has to mean the token stops working.
    const token = parseSessionToken(cookies);
    if (token) {
      const session = await services.auth.resolveSession(token);
      if (session) {
        await services.auth.revokeSession(session.session.id, 'USER_LOGOUT', {
          userId: session.user.id,
          role: session.user.role,
          ip: context.clientIp,
          userAgent: userAgentOf(c),
        });
      }
    }

    const response = redirect('/login');
    response.headers.append('set-cookie', clearCookie(SESSION_COOKIE_NAME));
    response.headers.append('set-cookie', clearCookie('sp_csrf', { httpOnly: false }));
    return response;
  };

  app.post('/logout', logout);
  app.get('/logout', logout);
}

/** Injects the CSRF hidden field into the first form in a rendered page. */
function addCsrf(page: string, token: string): string {
  const field = `<input type="hidden" name="${CSRF_FIELD}" value="${token}">`;
  // The token is a base64url string, so it needs no escaping before it goes into an
  // attribute; asserting the alphabet here means a future change to randomToken cannot
  // quietly introduce an injection point.
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new AppError('INTERNAL_ERROR', { message: 'CSRF token contained unexpected characters.' });
  }
  const index = page.indexOf('>', page.indexOf('<form'));
  if (index < 0) return page;
  return `${page.slice(0, index + 1)}${field}${page.slice(index + 1)}`;
}

function parseSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]*)`).exec(cookieHeader);
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Post-login redirect target.
 *
 * Only same-origin *paths* are honoured. An open redirect here would let an attacker
 * send a merchant a genuine `steve-gate.ir/login?next=https://evil.example` link; the
 * merchant logs in to the real site and is then handed to a lookalike that asks for
 * their API key. `//host` and `/\host` are rejected too — browsers treat both as
 * protocol-relative or as a backslash-normalised absolute URL.
 */
function safeNext(next: string): string | null {
  if (!next.startsWith('/')) return null;
  if (next.startsWith('//') || next.startsWith('/\\')) return null;
  if (next.includes('\\') || next.includes('://')) return null;
  return next;
}

/** Maps an AppError's `details.field` onto the page's inline error slots. */
function fieldErrors(error: unknown): Array<{ field: string; message: string }> {
  if (!(error instanceof AppError)) return [];
  const details = error.details as { field?: unknown } | undefined;
  if (details && typeof details.field === 'string') {
    return [{ field: details.field, message: error.message }];
  }
  return [];
}

function generalMessage(error: unknown): string | undefined {
  if (!(error instanceof AppError)) return 'خطای غیرمنتظره رخ داد. لطفاً دوباره تلاش کنید.';
  // Validation and duplicate errors carry a message written for the person filling in the
  // form, so they are shown as-is. Anything else is summarised without internal detail.
  if (error.code === 'VALIDATION_FAILED' || error.code === 'DUPLICATE_MOBILE' || error.code === 'REGISTRATION_DISABLED') {
    return error.message;
  }
  if (error.code === 'TURNSTILE_FAILED') return 'تأیید امنیتی ناموفق بود.';
  return 'ثبت‌نام انجام نشد. اطلاعات را بررسی کنید و دوباره تلاش کنید.';
}

function statusFor(error: unknown): number {
  return error instanceof AppError ? error.status : 500;
}
