/**
 * CSRF protection for the HTML forms (§40).
 *
 * Double-submit cookie. The same random token lives in a cookie and in a hidden field
 * of every form; a POST is accepted only when the two match. An attacker's page can
 * cause the browser to *send* the cookie, but it cannot read it to fill in the field,
 * and it cannot set a matching pair because the token is not derivable.
 *
 * The cookie is deliberately **not** HttpOnly. That is the one place in this codebase
 * where a cookie is readable by script, and it is required: the SMS-forwarder setup
 * wizard and the dashboard issue some requests from `fetch()`, and those need the token
 * in a header. The cookie carries no authority by itself — it only means anything when
 * paired with a value the attacker cannot produce — so exposing it does not weaken the
 * mechanism. The session cookie stays HttpOnly, which is the one that matters.
 *
 * SameSite=Lax on the session cookie already blocks the simplest cross-site form posts.
 * This is the second lock: it also covers the cases Lax does not, and it means a future
 * decision to relax SameSite cannot silently open a CSRF hole.
 */

import { AppError } from './errors';
import { randomToken, constantTimeEqualHex, sha256Hex } from './crypto';
import { CSRF_COOKIE_NAME, parseCookies, serializeCookie } from './cookies';

/** Form field name. Shared so the page and the verifier cannot disagree. */
export const CSRF_FIELD = '_csrf';

/**
 * Issues the token that goes in the form and the cookie that carries its hash.
 *
 * The cookie holds `sha256(token)` and the form holds the token, so the value that
 * travels in the URL-encoded body is not the value stored in a header. This keeps the
 * raw token out of any log line that records headers, and the comparison is still a
 * constant-time hash comparison.
 *
 * @param secure Whether the request that is receiving this cookie arrived over TLS.
 *   Pass the connection's scheme, never the environment name — a `Secure` cookie the
 *   browser refuses to store turns every form on the site into a CSRF rejection.
 */
export async function issueCsrf(secure: boolean): Promise<{ token: string; cookie: string }> {
  const token = randomToken(32);
  const hashed = await sha256Hex(token);
  return {
    token,
    cookie: serializeCookie(CSRF_COOKIE_NAME, hashed, {
      // `httpOnly: false` is required for the fetch()-based flows to read the token,
      // and is safe here: the cookie alone grants nothing (see the module comment).
      httpOnly: false,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 12,
    }),
  };
}

/**
 * Verifies a submitted token against the cookie.
 *
 * Missing cookie, missing field and mismatched pair are all reported as the same
 * `FORBIDDEN`. Telling a caller which half was wrong only helps someone probing the
 * check.
 */
export async function assertCsrf(cookieHeader: string | null, submitted: unknown): Promise<void> {
  const cookies = parseCookies(cookieHeader);
  const expectedHash = cookies[CSRF_COOKIE_NAME];

  if (!expectedHash) {
    throw new AppError('FORBIDDEN', {
      message: 'نشست فرم منقضی شده است. صفحه را دوباره بارگذاری کنید و فرم را از نو پر کنید.',
    });
  }
  if (typeof submitted !== 'string' || submitted.length === 0) {
    throw new AppError('FORBIDDEN', {
      message: 'توکن امنیتی فرم ارسال نشده است. صفحه را دوباره بارگذاری کنید.',
    });
  }

  const actualHash = await sha256Hex(submitted);
  if (!constantTimeEqualHex(actualHash, expectedHash)) {
    throw new AppError('FORBIDDEN', {
      message: 'توکن امنیتی فرم نامعتبر است. صفحه را دوباره بارگذاری کنید.',
    });
  }
}
