/**
 * Cookie helpers.
 *
 * Sessions are cookie-based, so the attribute defaults here are a security
 * control, not formatting. `httpOnly` keeps the token away from any script that
 * might be injected; `secure` keeps it off plaintext connections; `sameSite=Lax`
 * still sends it on top-level navigations (which a payment redirect needs) while
 * blocking it on cross-site form posts (which a CSRF attack needs).
 */

export const SESSION_COOKIE_NAME = 'sp_session';
/** Short-lived cookie carrying the CSRF token; readable by script on purpose. */
export const CSRF_COOKIE_NAME = 'sp_csrf';

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name.length === 0) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      out[name] = decodeURIComponent(rawValue);
    } catch {
      out[name] = rawValue;
    }
  }
  return out;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  // Secure defaults: a cookie is only insecure if a caller explicitly asks.
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure !== false) parts.push('Secure');
  if (options.httpOnly !== false) parts.push('HttpOnly');
  return parts.join('; ');
}

/** Clears a cookie by expiring it at the same path it was set on. */
export function clearCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...options, maxAge: 0, expires: new Date(0) });
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure = true): string {
  return serializeCookie(SESSION_COOKIE_NAME, token, {
    maxAge: maxAgeSeconds,
    httpOnly: true,
    secure,
    sameSite: 'Lax',
  });
}
