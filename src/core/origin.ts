/**
 * The platform's own origin.
 *
 * Steve Gate is deployed under a hostname that does not exist when this code is
 * written: a Pages project, a custom domain, a preview alias. Nothing here is
 * configured and nothing is hard-coded, because a base URL in configuration is a
 * value that has to be correct in five places at once — the deploy config, three
 * environments and whatever the custom domain ends up being — and is silently wrong
 * everywhere until someone notices a payment link pointing at the wrong host.
 *
 * So the origin comes from the request that is being served, which is by definition
 * the host the visitor actually used. Two things then need care:
 *
 *   1. **Secure flags.** Whether to mark a cookie `Secure` and whether to send HSTS
 *      is a property of the *connection*, not of the environment name. Deriving it
 *      from `ENVIRONMENT` means a production-labelled deployment reached over plain
 *      HTTP marks its session cookie `Secure`, the browser silently refuses to store
 *      it, and the login page returns to itself forever with no error anywhere.
 *      `isSecureRequest` is the honest source for both.
 *
 *   2. **Work without a request.** Cron sweeps and the webhook delivery queue run
 *      with no request to read. They need the origin only to build a link a human
 *      will click (a Telegram button). The first request an isolate serves is
 *      written to KV, and background jobs read it back — so a fresh deployment
 *      self-configures on the first page view and no variable has to be set.
 */

/** Where the remembered origin lives. One key, one value, no namespacing needed. */
export const ORIGIN_CACHE_KEY = 'platform.origin';

/**
 * Thirty days. Long enough that a quiet deployment never loses the value between
 * cron runs, short enough that a stale remembered origin eventually stops being
 * served if the deployment moves and nothing ever visits the new one.
 */
const ORIGIN_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

/** The origin (scheme + host + port) the visitor actually used. */
export function originOf(request: Request): string {
  try {
    return new URL(request.url).origin;
  } catch {
    return '';
  }
}

/**
 * True when this request arrived over TLS.
 *
 * Cloudflare terminates TLS at the edge, so `request.url` carries the public scheme
 * and is trustworthy here — unlike a forwarded header, which a client could set.
 */
export function isSecureRequest(request: Request): boolean {
  return originOf(request).startsWith('https://');
}

/**
 * Last origin this isolate successfully wrote, so a warm isolate does not write on
 * every request. Module scope, not per-request: an isolate serving ten thousand
 * requests writes the key once.
 */
let writtenOrigin: string | null = null;

/** Test seam — lets a suite start from a known state between cases. */
export function resetOriginCacheForTests(): void {
  writtenOrigin = null;
}

/**
 * Records the origin for the parts of the system that have no request.
 *
 * Fire-and-forget by design: it is called from middleware on the response path and
 * the page must not wait on a KV write. Called only when the value actually changed,
 * which in steady state is once per isolate.
 */
export function rememberOrigin(kv: KVNamespace | undefined, origin: string): void {
  if (!kv || origin.length === 0 || writtenOrigin === origin) return;
  writtenOrigin = origin;
  void kv.put(ORIGIN_CACHE_KEY, origin, { expirationTtl: ORIGIN_CACHE_TTL_SECONDS }).catch(() => {
    // A cache that is down is not an error: the only consequence is that a
    // background job falls back to omitting a link it would otherwise send.
    writtenOrigin = null;
  });
}

/**
 * The remembered origin, or an empty string when nothing has been recorded yet.
 *
 * Callers must treat `''` as "no absolute link available" rather than as a value to
 * concatenate, which is why this returns `''` and not `'http://localhost'`: a
 * placeholder that looks like a host is how a development URL reaches a customer.
 */
export async function resolveOrigin(env: { CACHE?: KVNamespace }): Promise<string> {
  if (!env.CACHE) return '';
  try {
    const value = await env.CACHE.get(ORIGIN_CACHE_KEY);
    if (!value) return '';
    // Validate rather than trust: the value round-trips through KV, and a malformed
    // one must not become half of every outbound URL.
    const parsed = new URL(value);
    return parsed.origin;
  } catch {
    return '';
  }
}

/**
 * Joins an absolute path onto an origin, tolerating an unknown origin.
 *
 * With no origin it returns the path alone. That is a deliberate degradation for the
 * one caller that can hit it — a Telegram button on a deployment whose cron ran
 * before its first page view — where a relative path is useless but harmless.
 */
export function absoluteUrl(origin: string, path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return origin.length > 0 ? `${origin}${suffix}` : suffix;
}
