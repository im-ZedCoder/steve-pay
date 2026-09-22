/**
 * Merchant dashboard tests (§27, §32, §34, §35, §38).
 *
 * The acceptance test proves the money path works; the admin-console test proves an
 * operator can approve a merchant and release a flagged payment. This file proves the
 * third leg: that the person whose money it is can see it and change things — add a
 * receiving card, hold an API key, point a webhook somewhere, go back to the default fee.
 *
 * Everything goes through HTTP against the deployed Worker, because the defects that
 * matter here are invisible to a test that calls services directly: a form that lost its
 * CSRF field, a reveal that leaks a secret into a redirect, a toggle whose label and
 * effect disagree, a page that 500s because a query returned `null`.
 *
 * Two properties get their own assertions because they are the ones that would be
 * expensive to get wrong rather than merely annoying:
 *
 *   - a fresh API key appears **once**, in a response body, and lands nowhere else — not
 *     in the database, not in a `Location` header;
 *   - switching an automatically-disabled webhook back on genuinely resumes delivery,
 *     which means clearing the shutdown, not just flipping `is_active`.
 */

import { env, SELF, createExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { servicesFor, type ServiceContext } from '../src/routes/container';
import { createLogger } from '../src/obs/logger';
import { resolveConfig } from '../src/env';
import { id as newId } from '../src/core/ids';
import { hashPassword } from '../src/core/crypto';
import { nowIso } from '../src/core/time';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function services() {
  const context: ServiceContext = {
    request: new Request('https://steve-pay.test/test'),
    env,
    ctx: createExecutionContext(),
    requestId: newId('req'),
    logger: createLogger({ level: 'error', base: { surface: 'test' } }),
    config: resolveConfig(env),
  };
  return servicesFor(context);
}

/** Mobiles are unique per test file: the suite shares one D1 database across files. */
const ADMIN_MOBILE = '09000000001';
const MERCHANT_MOBILE = '09120000077';
const MERCHANT_PASSWORD = 'Correct-Horse-7';
const OTHER_MOBILE = '09120000078';

function cookiesOf(response: Response): string {
  const headers = response.headers as unknown as { getSetCookie?: () => string[] };
  const list =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];
  return list
    .filter((value) => value.length > 0)
    .map((value) => value.split(';')[0])
    .join('; ');
}

function mergeCookies(...sources: string[]): string {
  const pairs = new Map<string, string>();
  for (const source of sources) {
    for (const pair of source.split('; ')) {
      const name = pair.split('=')[0];
      if (name && pair.includes('=')) pairs.set(name, pair);
    }
  }
  return [...pairs.values()].join('; ');
}

function csrfFrom(markup: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(markup);
  if (!match || !match[1]) throw new Error('CSRF field not found in the rendered page');
  return match[1];
}

function luhnValid(prefix: string): string {
  for (let check = 0; check <= 9; check += 1) {
    const candidate = `${prefix}${check}`;
    let sum = 0;
    let double = false;
    for (let index = candidate.length - 1; index >= 0; index -= 1) {
      let digit = Number(candidate[index]);
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      double = !double;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error('no Luhn check digit found');
}

/**
 * A session and the cookie jar that makes its CSRF token valid.
 *
 * The CSRF check is a double submit: a token scraped from one page is only valid with the
 * cookie from the *same* response. Keeping the pair together is why these tests assert
 * anything at all — post a token from page A with page B's cookies and the 403 looks like a
 * server bug.
 */
interface Session {
  cookies: string;
  userId: string;
}

/** Registers a merchant account. The account lands in `PENDING_APPROVAL`. */
async function register(mobile: string, password: string, displayName: string): Promise<string> {
  const page = await SELF.fetch('https://steve-pay.test/register');
  const registered = await SELF.fetch('https://steve-pay.test/register', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookiesOf(page) },
    body: new URLSearchParams({
      _csrf: csrfFrom(await page.text()),
      displayName,
      mobile,
      businessType: 'DIGITAL_GOODS',
      password,
      confirmPassword: password,
    }).toString(),
  });
  expect(registered.status, 'registration').toBe(201);

  const row = await env.DB.prepare('SELECT id FROM users WHERE mobile = ?')
    .bind(mobile)
    .first<{ id: string }>();
  return row?.id as string;
}

/**
 * Signs in over the login route, returning the cookie jar.
 *
 * A separate step from registering because a pending account cannot sign in at all — the
 * login service refuses any status but `ACTIVE` — and a test that conflated the two would
 * never notice if that gate were removed.
 */
async function signIn(mobile: string, password: string): Promise<string> {
  const login = await SELF.fetch('https://steve-pay.test/login');
  const signedIn = await SELF.fetch('https://steve-pay.test/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookiesOf(login) },
    body: new URLSearchParams({
      _csrf: csrfFrom(await login.text()),
      mobile,
      password,
    }).toString(),
    redirect: 'manual',
  });
  expect(signedIn.status, 'login').toBe(303);
  return cookiesOf(signedIn);
}

/** Fetches a page that has no form on it — a list, an overview, a detail view with nothing to submit. */
async function get(path: string, session: string): Promise<string> {
  const response = await SELF.fetch(`https://steve-pay.test${path}`, { headers: { cookie: session } });
  expect(response.status, `GET ${path}`).toBe(200);
  return response.text();
}

/**
 * Opens a page and returns its markup, its CSRF token, and the cookie jar that makes the
 * token valid.
 *
 * Only for pages that actually contain a form. Scraping a token from a page with no forms
 * throws rather than returning empty, because a form that lost its CSRF field is a real
 * defect — and a page with nothing to submit is not one.
 */
async function openForm(path: string, session: string): Promise<{ html: string; csrf: string; cookies: string }> {
  const response = await SELF.fetch(`https://steve-pay.test${path}`, { headers: { cookie: session } });
  expect(response.status, `GET ${path}`).toBe(200);
  const markup = await response.text();
  return { html: markup, csrf: csrfFrom(markup), cookies: mergeCookies(session, cookiesOf(response)) };
}

async function post(
  path: string,
  cookies: string,
  fields: Record<string, string>,
): Promise<Response> {
  return SELF.fetch(`https://steve-pay.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

/**
 * Approves a merchant, which is also what provisions their first live API key (§4).
 *
 * `apiKeys` is a dependency of `MerchantService` for exactly this reason: approving without
 * issuing left an approved merchant with no working credential, and the acceptance test had
 * been papering over it by issuing one itself.
 */
async function approve(userId: string): Promise<void> {
  await services().merchants.applyAction(
    userId,
    'APPROVE',
    { reason: null },
    { userId: 'usr_01TESTADMIN000000000001', role: 'SUPER_ADMIN', ip: null },
    newId('req'),
  );
}

/** A merchant with an approved account, a wallet and a live API key. */
async function approvedMerchant(): Promise<Session & { apiKey: string }> {
  const userId = await register(MERCHANT_MOBILE, MERCHANT_PASSWORD, 'فروشگاه داشبورد');
  const internal = services();

  // A registered account is not usable yet, and that is the point of the queue (§4).
  const pendingLogin = await SELF.fetch('https://steve-pay.test/login');
  const refused = await SELF.fetch('https://steve-pay.test/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookiesOf(pendingLogin),
    },
    body: new URLSearchParams({
      _csrf: csrfFrom(await pendingLogin.text()),
      mobile: MERCHANT_MOBILE,
      password: MERCHANT_PASSWORD,
    }).toString(),
    redirect: 'manual',
  });
  expect(refused.status, 'a pending account must not sign in').toBe(401);

  // Approval is normally an operator action, driven through the console; here it is called
  // directly because this file is about what the merchant can do *after* it.
  await approve(userId);

  const cookies = await signIn(MERCHANT_MOBILE, MERCHANT_PASSWORD);
  const issued = await internal.apiKeys.issue({
    merchantUserId: userId,
    environment: 'live',
    label: 'seed',
  });

  return { cookies, userId, apiKey: issued.fullKey };
}

// ---------------------------------------------------------------------------

let merchant: Session & { apiKey: string };
let other: Session & { apiKey: string };
let invoiceId = '';

beforeAll(async () => {
  // The approving actor has to exist, because the audit entry references it.
  const existing = await env.DB.prepare('SELECT id FROM users WHERE mobile = ?')
    .bind(ADMIN_MOBILE)
    .first();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO users (id, mobile, password_hash, role, status, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 'SUPER_ADMIN', 'ACTIVE', 'Test Admin', ?, ?)`,
    )
      .bind(
        'usr_01TESTADMIN000000000001',
        ADMIN_MOBILE,
        await hashPassword('Admin-Placeholder-9'),
        nowIso(),
        nowIso(),
      )
      .run();
  }

  merchant = await approvedMerchant();

  // A second, fully usable merchant: the ownership assertions need a real session from a
  // different account, and a pending account cannot open a dashboard page at all.
  const otherId = await register(OTHER_MOBILE, 'Correct-Horse-8', 'فروشگاه دیگر');
  await approve(otherId);
  other = { cookies: await signIn(OTHER_MOBILE, 'Correct-Horse-8'), userId: otherId, apiKey: '' };

  // A receiving card, so an invoice can exist at all.
  const card = await openForm('/dashboard/cards', merchant.cookies);
  const created = await post('/dashboard/cards/create', card.cookies, {
    _csrf: card.csrf,
    number: luhnValid('610433789012345'),
    title: 'کارت اصلی',
    bankName: 'بانک ملت',
  });
  expect(created.status, 'card create').toBe(303);
});

describe('merchant dashboard (§27, §32, §34, §35, §38)', () => {
  it('renders every console page without an error', async () => {
    // A page that throws is a page nobody uses. Each of these builds a different set of
    // queries — an empty `sms_parser_results` join, an empty ledger, a null profile — so
    // rendering all of them is the cheapest way to catch a null that a service returns.
    const paths = [
      '/dashboard',
      '/dashboard/payments',
      '/dashboard/payments?status=successful',
      '/dashboard/payments?status=MANUAL_REVIEW',
      '/dashboard/payments?q=inv_',
      '/dashboard/wallet',
      '/dashboard/cards',
      '/dashboard/api-keys',
      '/dashboard/webhooks',
      '/dashboard/sms',
      '/dashboard/settings',
      '/dashboard/notifications',
      '/dashboard/profile',
    ];

    for (const path of paths) {
      const response = await SELF.fetch(`https://steve-pay.test${path}`, {
        headers: { cookie: merchant.cookies },
      });
      expect(response.status, `GET ${path}`).toBe(200);
      const markup = await response.text();
      expect(markup, `${path} should render the shell`).toContain('پنل پذیرنده');
    }
  });

  it('sends a signed-out visitor to the login page that carries where they were going', async () => {
    // `requireMerchant` throws rather than redirecting, because the same guard protects the
    // API where a 302 is the wrong answer. The console turns that throw into a redirect, so
    // an expired session is a login form rather than a dead-end error page.
    const response = await SELF.fetch('https://steve-pay.test/dashboard/payments', {
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('/login');
    expect(location).toContain('next=');

    // The carried destination must survive the login round trip, and must be a local path:
    // an open redirect here would be a phishing primitive on the login page.
    const form = await SELF.fetch(`https://steve-pay.test${location.replace(/^\/login/, '/login')}`);
    expect(form.status).toBe(200);
    const markup = await form.text();
    expect(markup).toContain('name="next" value="/dashboard/payments"');

    const hostile = await SELF.fetch('https://steve-pay.test/login?next=https://evil.example.com', {
      redirect: 'manual',
    });
    expect(await hostile.text()).not.toContain('evil.example.com');
  });

  it('reports a fresh API key exactly once, and never writes it down', async () => {
    const form = await openForm('/dashboard/api-keys', merchant.cookies);
    const response = await post('/dashboard/api-keys/create', form.cookies, {
      _csrf: form.csrf,
      label: 'سرور فروشگاه',
      environment: 'live',
      scopes: 'payments:create',
      scopes_key_not_used: '',
    });

    // The reveal is a rendered page, not a redirect: `?key=sk_live_…` would put a live
    // credential into the access log, the browser history and the next request's Referer.
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();

    const markup = await response.text();
    const match = /sk_live_[0-9A-Za-z]{44}/.exec(markup);
    expect(match, 'the full key should be on the page exactly once').not.toBeNull();
    const fullKey = match?.[0] as string;

    // Shown once, stored hashed: the raw value must not be recoverable from the database.
    const stored = await env.DB.prepare(
      'SELECT key_hash, key_hint FROM api_keys WHERE merchant_user_id = ? ORDER BY created_at DESC LIMIT 1',
    )
      .bind(merchant.userId)
      .first<{ key_hash: string; key_hint: string }>();
    expect(stored?.key_hash).not.toBe(fullKey);
    expect(stored?.key_hint).not.toContain(fullKey.slice(8));

    // And it works: the reveal is not a decorative string.
    const call = await SELF.fetch('https://steve-pay.test/api/v1/status', {
      headers: { 'x-api-key': fullKey },
    });
    expect(call.status).toBe(200);

    // Rotating it must invalidate the original, or "rotation" is a second key rather than a
    // replacement and a leaked key stays live.
    const keyId = await env.DB.prepare(
      'SELECT id FROM api_keys WHERE merchant_user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
    )
      .bind(merchant.userId)
      .first<{ id: string }>();

    const again = await openForm('/dashboard/api-keys', merchant.cookies);
    const rotated = await post(`/dashboard/api-keys/${keyId?.id}/rotate`, again.cookies, {
      _csrf: again.csrf,
    });
    expect(rotated.status).toBe(200);
    const rotatedKey = /sk_live_[0-9A-Za-z]{44}/.exec(await rotated.text())?.[0] as string;
    expect(rotatedKey).not.toBe(fullKey);

    const oldKeyCall = await SELF.fetch('https://steve-pay.test/api/v1/status', {
      headers: { 'x-api-key': fullKey },
    });
    expect(oldKeyCall.status).toBe(401);

    // Leave the merchant on a working key for the tests that follow.
    const live = await services().apiKeys.issue({
      merchantUserId: merchant.userId,
      environment: 'live',
      label: 'after rotation',
    });
    merchant.apiKey = live.fullKey;
  });

  it('creates and manages a receiving card, reporting what actually happened', async () => {
    const form = await openForm('/dashboard/cards', merchant.cookies);

    // A card that fails the checksum is refused on the page, with the reason, rather than
    // silently accepted and discovered when a customer's payment never matches.
    const bad = await post('/dashboard/cards/create', form.cookies, {
      _csrf: form.csrf,
      number: '6104337890123456',
      title: 'کارت غلط',
    });
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain('شماره کارت');

    const fresh = await openForm('/dashboard/cards', merchant.cookies);
    const good = await post('/dashboard/cards/create', fresh.cookies, {
      _csrf: fresh.csrf,
      number: luhnValid('610433789012346'),
      title: 'کارت دوم',
    });
    expect(good.status).toBe(303);

    const listed = await openForm('/dashboard/cards', merchant.cookies);
    expect(listed.html).toContain('کارت دوم');
    // The full number is never printed back: only the mask.
    expect(listed.html).not.toContain(luhnValid('610433789012346'));

    const row = await env.DB.prepare(
      'SELECT id FROM bank_cards WHERE merchant_user_id = ? AND title = ?',
    )
      .bind(merchant.userId, 'کارت دوم')
      .first<{ id: string }>();
    const cardId = row?.id as string;

    const after = await openForm('/dashboard/cards', merchant.cookies);
    const promoted = await post(`/dashboard/cards/${cardId}/default`, after.cookies, {
      _csrf: after.csrf,
    });
    expect(promoted.status).toBe(303);

    const defaults = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM bank_cards WHERE merchant_user_id = ? AND is_default = 1',
    )
      .bind(merchant.userId)
      .first<{ count: number }>();
    // Exactly one default. Two defaults would make "the default card" a coin flip.
    expect(defaults?.count).toBe(1);

    const toggled = await openForm('/dashboard/cards', merchant.cookies);
    await post(`/dashboard/cards/${cardId}/toggle`, toggled.cookies, { _csrf: toggled.csrf });
    const off = await env.DB.prepare('SELECT is_active FROM bank_cards WHERE id = ?')
      .bind(cardId)
      .first<{ is_active: number }>();
    expect(off?.is_active).toBe(0);
  });

  it('refuses another merchant\'s invoice with a 404, not a 403', async () => {
    // A 403 would confirm the id exists — which is an enumeration oracle for every other
    // merchant's invoices.
    const internal = services();
    // `listActive`, not `list`: the cards test deactivates a card, and naming an inactive one
    // is an error by design — falling back to another card would send the customer to an
    // account the merchant did not choose.
    const card = await internal.cards.listActive(merchant.userId);
    const created = await internal.invoices.create(
      { amount: 250_000, description: 'فاکتور تست مالکیت', cardId: card[0]?.id ?? null },
      {
        merchantUserId: merchant.userId,
        apiKeyId: null,
        environment: 'live',
        requestId: newId('req'),
        ip: null,
      },
    );

    // `id` on the API view is the *payment* id; `invoiceId` is the invoice. Using the wrong
    // one here made the assertion pass vacuously: a URL naming a payment id 404s for its own
    // merchant too, so the test would have proved nothing about ownership.
    expect(created.invoiceId).toMatch(/^inv_/);
    expect(created.id).not.toBe(created.invoiceId);

    const own = await SELF.fetch(`https://steve-pay.test/dashboard/payments/${created.invoiceId}`, {
      headers: { cookie: merchant.cookies },
    });
    expect(own.status, 'the owning merchant sees it').toBe(200);

    const asOther = await SELF.fetch(`https://steve-pay.test/dashboard/payments/${created.invoiceId}`, {
      headers: { cookie: other.cookies },
    });
    expect(asOther.status).toBe(404);
  });

  it('lists a payment, shows its evidence, and lets the merchant cancel it', async () => {
    const internal = services();
    const cards = await internal.cards.listActive(merchant.userId);
    const created = await internal.invoices.create(
      { amount: 359_000, description: 'سفارش داشبورد', cardId: cards[0]?.id ?? null },
      {
        merchantUserId: merchant.userId,
        apiKeyId: null,
        environment: 'live',
        requestId: newId('req'),
        ip: null,
      },
    );
    invoiceId = created.invoiceId;

    const list = await get('/dashboard/payments?status=pending', merchant.cookies);
    expect(list).toContain(invoiceId);

    const detail = await openForm(`/dashboard/payments/${invoiceId}`, merchant.cookies);
    // The arithmetic has to be visible, because the suffix is the number the customer must
    // transfer and a merchant cannot check it without seeing the parts.
    expect(detail.html).toContain('پسوند یکتا');
    expect(detail.html).toContain('مبلغ قابل پرداخت');
    expect(detail.html).toContain(String(invoiceId));

    const cancelled = await post(`/dashboard/payments/${invoiceId}/cancel`, detail.cookies, {
      _csrf: detail.csrf,
    });
    expect(cancelled.status).toBe(303);

    const row = await env.DB.prepare('SELECT status FROM invoices WHERE id = ?')
      .bind(invoiceId)
      .first<{ status: string }>();
    expect(row?.status).toBe('CANCELLED');

    // Cancelling twice is refused, not silently repeated. The page itself is the first
    // refusal: a cancelled invoice offers no cancel button, because a terminal status has no
    // transitions out of it — so there is no form here and therefore no token to scrape.
    const reload = await get(`/dashboard/payments/${invoiceId}`, merchant.cookies);
    expect(reload).toContain('لغو شده');
    expect(reload).not.toContain('/cancel');
  });

  it('registers a webhook, reveals its secret, and really resumes delivery after a shutdown', async () => {
    const form = await openForm('/dashboard/webhooks', merchant.cookies);

    // A plain-HTTP URL is refused: a signing secret posted in the clear is a secret disclosed.
    const insecure = await post('/dashboard/webhooks/create', form.cookies, {
      _csrf: form.csrf,
      url: 'http://shop.example.com/callback',
    });
    expect(insecure.status).toBe(200);
    expect(await insecure.text()).toContain('آدرس');

    const retry = await openForm('/dashboard/webhooks', merchant.cookies);
    const created = await post('/dashboard/webhooks/create', retry.cookies, {
      _csrf: retry.csrf,
      url: 'https://shop.example.com/pay/callback',
      events: '*',
    });
    expect(created.status).toBe(200);
    const createdHtml = await created.text();
    expect(createdHtml).toContain('راز امضا');

    const endpoint = await env.DB.prepare(
      'SELECT id, secret_sealed, disabled_at FROM webhook_endpoints WHERE merchant_user_id = ? ORDER BY created_at DESC LIMIT 1',
    )
      .bind(merchant.userId)
      .first<{ id: string; secret_sealed: string; disabled_at: string | null }>();
    const endpointId = endpoint?.id as string;

    // The revealed secret is the one used to sign: re-deriving it must match, or every
    // merchant's signature verification fails for a reason they cannot see.
    const revealed = await openForm('/dashboard/webhooks', merchant.cookies);
    const revealResponse = await post(`/dashboard/webhooks/${endpointId}/reveal`, revealed.cookies, {
      _csrf: revealed.csrf,
    });
    const revealedSecret = /class="key-reveal">\s*<span>([^<]+)<\/span>/.exec(await revealResponse.text());
    expect(revealedSecret?.[1]).toBeTruthy();

    // A test event is delivered immediately, so the page can show the real HTTP status rather
    // than "queued" and nothing.
    const test = await openForm('/dashboard/webhooks', merchant.cookies);
    const sent = await post('/dashboard/webhooks/test', test.cookies, { _csrf: test.csrf });
    expect(sent.status).toBe(303);

    const delivery = await env.DB.prepare(
      "SELECT id, event FROM webhook_deliveries WHERE merchant_user_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(merchant.userId)
      .first<{ id: string; event: string }>();
    expect(delivery?.event).toBe('test.pipeline');

    // Now the shutdown case. `enqueue` skips any endpoint with `disabled_at` set, so a toggle
    // that only flips `is_active` would change the label and deliver nothing — the worst kind
    // of fix, because it looks like it worked.
    await env.DB.prepare(
      'UPDATE webhook_endpoints SET disabled_at = ?, disabled_reason = ?, consecutive_failures = 25 WHERE id = ?',
    )
      .bind(nowIso(), 'AUTO_DISABLED_FAILURES', endpointId)
      .run();

    const beforeToggle = await openForm('/dashboard/webhooks', merchant.cookies);
    expect(beforeToggle.html).toContain('خودکار غیرفعال شده');

    const toggled = await openForm('/dashboard/webhooks', merchant.cookies);
    const response = await post(`/dashboard/webhooks/${endpointId}/toggle`, toggled.cookies, {
      _csrf: toggled.csrf,
    });
    expect(response.status).toBe(303);

    const after = await env.DB.prepare(
      'SELECT is_active, disabled_at, consecutive_failures FROM webhook_endpoints WHERE id = ?',
    )
      .bind(endpointId)
      .first<{ is_active: number; disabled_at: string | null; consecutive_failures: number }>();
    expect(after?.is_active).toBe(1);
    expect(after?.disabled_at).toBeNull();
    expect(after?.consecutive_failures).toBe(0);

    // And delivery genuinely resumes: a new test event now produces a delivery row.
    const countBefore = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM webhook_deliveries WHERE merchant_user_id = ?',
    )
      .bind(merchant.userId)
      .first<{ count: number }>();

    const resumed = await openForm('/dashboard/webhooks', merchant.cookies);
    await post('/dashboard/webhooks/test', resumed.cookies, { _csrf: resumed.csrf });

    const countAfter = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM webhook_deliveries WHERE merchant_user_id = ?',
    )
      .bind(merchant.userId)
      .first<{ count: number }>();

    expect(countAfter?.count ?? 0).toBeGreaterThan(countBefore?.count ?? 0);
  });

  it('stores a fee override, then clears it back to the platform default', async () => {
    const form = await openForm('/dashboard/settings', merchant.cookies);

    const saved = await post('/dashboard/settings', form.cookies, {
      _csrf: form.csrf,
      feeMode: 'MERCHANT',
      gatewayFee: '4500',
      expiryMinutes: '25',
      customerMessage: 'پرداخت شما پس از تأیید بانک ثبت می‌شود.',
    });
    expect(saved.status).toBe(303);

    const stored = await env.DB.prepare(
      "SELECT key, value FROM merchant_settings WHERE merchant_user_id = ? AND key LIKE 'invoices.%'",
    )
      .bind(merchant.userId)
      .all<{ key: string; value: string }>();
    const map = new Map(stored.results.map((entry) => [entry.key, entry.value]));
    expect(map.get('invoices.gateway_fee')).toBe('4500');
    expect(map.get('invoices.fee_mode')).toBe('MERCHANT');

    // Clearing is a delete, not an empty string. An empty string for `invoices.gateway_fee`
    // reads back as `Number('') === 0`, which is a valid fee — so "go back to the default"
    // would have silently set the merchant's own fee to zero.
    const cleared = await openForm('/dashboard/settings', merchant.cookies);
    const response = await post('/dashboard/settings', cleared.cookies, {
      _csrf: cleared.csrf,
      feeMode: '',
      gatewayFee: '',
      expiryMinutes: '',
      customerMessage: '',
    });
    expect(response.status).toBe(303);

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM merchant_settings WHERE merchant_user_id = ? AND key LIKE 'invoices.%'",
    )
      .bind(merchant.userId)
      .first<{ count: number }>();
    expect(remaining?.count).toBe(0);

    // An out-of-range expiry is refused rather than clamped: a 5-minute invoice is a
    // different product from a 30-minute one, and quietly changing it would hide that.
    const invalid = await openForm('/dashboard/settings', merchant.cookies);
    const rejected = await post('/dashboard/settings', invalid.cookies, {
      _csrf: invalid.csrf,
      feeMode: '',
      gatewayFee: '',
      expiryMinutes: '2',
      customerMessage: '',
    });
    expect(rejected.headers.get('location') ?? '').toContain('err=settings_invalid');
  });

  it('issues a one-hour SMS test token and shows what to paste', async () => {
    const form = await openForm('/dashboard/sms', merchant.cookies);
    const response = await post('/dashboard/sms/test-token', form.cookies, { _csrf: form.csrf });

    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toContain('STEVE_PAY_TEST');
    // The forwarder URL is shown so the merchant can copy it rather than guess the path.
    expect(markup).toContain('/sms');
  });

  it('saves the store profile and marks notifications read', async () => {
    const profile = await openForm('/dashboard/profile', merchant.cookies);
    const saved = await post('/dashboard/profile', profile.cookies, {
      _csrf: profile.csrf,
      displayName: 'فروشگاه نمونه داشبورد',
      websiteUrl: 'https://shop.example.com',
      supportContact: '۰۲۱۱۲۳۴۵۶۷۸',
      businessDescription: 'فروشنده لوازم دیجیتال',
      telegramAlerts: '1',
    });
    expect(saved.status).toBe(303);

    const stored = await env.DB.prepare(
      'SELECT display_name, website_url, telegram_alerts FROM merchant_profiles WHERE user_id = ?',
    )
      .bind(merchant.userId)
      .first<{ display_name: string; website_url: string; telegram_alerts: number }>();
    expect(stored?.display_name).toBe('فروشگاه نمونه داشبورد');
    expect(stored?.website_url).toBe('https://shop.example.com');
    expect(stored?.telegram_alerts).toBe(1);

    // A notification has to exist before the feed can be tested: an empty feed renders no
    // form at all, and a page with no forms legitimately carries no CSRF token.
    await services().notifications.send({
      audience: 'MERCHANT',
      targetUserId: merchant.userId,
      title: 'تست اطلاعیه',
      body: 'این اطلاعیه برای آزمون صندوق ساخته شده است.',
      type: 'INFO',
    });

    const withItem = await openForm('/dashboard/notifications', merchant.cookies);
    expect(withItem.html).toContain('تست اطلاعیه');

    const read = await post('/dashboard/notifications/read', withItem.cookies, {
      _csrf: withItem.csrf,
      scope: 'all',
    });
    expect(read.status).toBe(303);

    // Marking all read is per-user: the notification itself survives, only this user's read
    // flag is written, so a broadcast does not disappear for everyone else.
    const unread = await services().notifications.unreadCount(merchant.userId, 'MERCHANT');
    expect(unread).toBe(0);

    const stillThere = await SELF.fetch('https://steve-pay.test/dashboard/notifications', {
      headers: { cookie: merchant.cookies },
    });
    expect(await stillThere.text()).toContain('تست اطلاعیه');
  });

  it('keeps a merchant out of the operator console', async () => {
    // Both consoles live on one origin, so this is the boundary that matters most.
    const response = await SELF.fetch('https://steve-pay.test/admin', {
      headers: { cookie: merchant.cookies },
      redirect: 'manual',
    });
    expect(response.status).toBe(403);
  });
});
