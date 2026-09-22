/**
 * HTTP response helpers and the security header policy (§40).
 *
 * The header policy lives in one place because it has to be applied to every
 * response, including error responses and asset responses. A CSP that is set on
 * the page route but forgotten on the error route is a hole, not an oversight.
 */

import { toApiErrorBody } from './errors';

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
export const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * Content Security Policy.
 *
 * `'unsafe-inline'` for styles is required because the payment page inlines its
 * critical CSS to avoid a render-blocking round trip. Scripts are NOT given
 * 'unsafe-inline': the pages use small external modules, and keeping inline script
 * out means injected markup cannot execute even if an escaping bug slips through.
 *
 * `frame-ancestors 'none'` blocks clickjacking — relevant here because a payment
 * page is a high-value target for an overlay attack that rewrites the visible
 * amount.
 */
/**
 * Content Security Policy.
 *
 * A function rather than a constant because exactly one page needs one extra origin:
 * the registration form, when Turnstile is switched on, must load Cloudflare's
 * challenge widget. Widening `script-src` for the whole site to satisfy one optional
 * field would hand every other page a weaker policy for no benefit, so the widget
 * origins are added only where the widget is actually rendered.
 *
 * @param options.turnstile include the Cloudflare Turnstile origins
 */
export function contentSecurityPolicy(options: { turnstile?: boolean } = {}): string {
  const turnstile = options.turnstile === true;
  return [
    "default-src 'self'",
    turnstile
      ? "script-src 'self' https://challenges.cloudflare.com"
      : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    turnstile
      ? "connect-src 'self' https://challenges.cloudflare.com"
      : "connect-src 'self'",
    "form-action 'self'",
    ...(turnstile ? ['frame-src https://challenges.cloudflare.com'] : []),
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** The default policy: no third-party origins and no inline script. */
export const CONTENT_SECURITY_POLICY = contentSecurityPolicy();

/**
 * Two years, with preload.
 *
 * Exported so the two call sites that decide whether to send it — the app's header middleware
 * and the Worker's outermost error handler — cannot drift apart on the value.
 */
export const HSTS_VALUE = 'max-age=63072000; includeSubDomains; preload';

export interface SecurityHeaderOptions {
  /**
   * Send `Strict-Transport-Security`.
   *
   * Only set from a call site that knows the request arrived over TLS and that the
   * deployment is a real one. See the note in `securityHeaders`.
   */
  hsts?: boolean;
  /** Payment and auth pages must never be cached by a shared cache. */
  noStore?: boolean;
  /** Set on pages rendering the Turnstile widget; see contentSecurityPolicy. */
  turnstile?: boolean;
}

export function securityHeaders(options: SecurityHeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': contentSecurityPolicy({ turnstile: options.turnstile }),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=()',
    'cross-origin-opener-policy': 'same-origin',
  };
  // Off unless asked for.
  //
  // These helpers build a response and do not know what connection it will travel over, so
  // the safe default is to send nothing — a browser ignores HSTS on plain HTTP, and an
  // HSTS header seen on a localhost or preview origin is actively harmful, because the
  // browser then refuses plain-HTTP requests to that host for two years. The middleware in
  // `app.ts` is the one place that can see the request, and it is the one place that turns
  // this on.
  if (options.hsts === true) {
    headers['strict-transport-security'] = HSTS_VALUE;
  }
  if (options.noStore) {
    headers['cache-control'] = 'no-store, no-cache, must-revalidate, private';
    headers['pragma'] = 'no-cache';
  }
  return headers;
}

export interface JsonResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  noStore?: boolean;
  turnstile?: boolean;
}

export function json(data: unknown, options: JsonResponseOptions = {}): Response {
  return new Response(JSON.stringify(data), {
    status: options.status ?? 200,
    headers: {
      'content-type': JSON_CONTENT_TYPE,
      ...securityHeaders({ noStore: options.noStore, turnstile: options.turnstile }),
      ...options.headers,
    },
  });
}

export function html(body: string, options: JsonResponseOptions = {}): Response {
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      'content-type': HTML_CONTENT_TYPE,
      ...securityHeaders({ noStore: options.noStore, turnstile: options.turnstile }),
      ...options.headers,
    },
  });
}

export function text(body: string, options: JsonResponseOptions = {}): Response {
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      ...securityHeaders({ noStore: options.noStore, turnstile: options.turnstile }),
      ...options.headers,
    },
  });
}

export function redirect(location: string, status: 302 | 303 | 307 | 308 = 303): Response {
  return new Response(null, {
    status,
    headers: { location, ...securityHeaders({ noStore: true }) },
  });
}

/**
 * Consistent success envelope. Every 2xx API response is shaped like this, so a
 * client can branch on `success` alone without inspecting the status code.
 */
export function apiSuccess<T>(data: T, options: JsonResponseOptions = {}): Response {
  return json({ success: true, ...(data as object) }, options);
}

/** Consistent failure envelope (§43). The request id is always included. */
export function apiFailure(error: unknown, requestId: string, extraHeaders?: Record<string, string>): Response {
  const { status, body } = toApiErrorBody(error, requestId);
  const headers: Record<string, string> = { 'x-request-id': requestId, ...extraHeaders };
  return json(body, { status, headers, noStore: true });
}

export function noContent(status = 204): Response {
  return new Response(null, { status, headers: securityHeaders({ noStore: true }) });
}

/**
 * 429 with the metadata a client needs to back off correctly. Returning a bare
 * 429 makes every well-behaved client retry immediately, which turns a limit into
 * an outage.
 */
export function rateLimited(retryAfterSeconds: number, requestId: string, limit: number): Response {
  return json(
    {
      success: false,
      code: 'RATE_LIMITED',
      message: 'تعداد درخواست‌ها از حد مجاز بیشتر است.',
      requestId,
      details: { limit, retryAfterSeconds },
    },
    {
      status: 429,
      noStore: true,
      headers: {
        'retry-after': String(Math.max(1, retryAfterSeconds)),
        'x-ratelimit-limit': String(limit),
        'x-ratelimit-remaining': '0',
        'x-request-id': requestId,
      },
    },
  );
}

/** Percent-encodes a value for safe interpolation into an HTML attribute or path. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON embedded in an HTML <script> tag must not be able to close the tag. */
export function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
