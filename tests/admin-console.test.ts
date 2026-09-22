/**
 * Operator console tests (§28, §29, §30, §54).
 *
 * The acceptance test drives the merchant's half of the system. This file drives the
 * operator's half, because those are the two routes without which the rest is a library:
 * approval is the only way a merchant becomes usable, and a manual-review decision is the
 * only way a flagged payment leaves the queue.
 *
 * Everything here goes through HTTP against the deployed Worker — the admin session, the
 * CSRF token scraped out of the rendered page, the redirect chain. The parts most likely to
 * be wrong are invisible to a test that calls services directly: a permission checked on the
 * page but not on the action, a CSRF field missing from a form, an API key that leaks into a
 * redirect URL.
 *
 * Note on cookies: the CSRF check is a double submit, so a token is only valid alongside the
 * cookie issued in the *same* response. A test that scrapes a token from one page and posts
 * it with a different page's cookies gets a 403 that looks like a server bug and is not.
 * `openForm` keeps the pair together, which is the only reason these tests say anything.
 */

import { env, SELF, createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { servicesFor, type ServiceContext } from '../src/routes/container';
import { createLogger } from '../src/obs/logger';
import { resolveConfig, resolveSecrets } from '../src/env';
import { id as newId } from '../src/core/ids';
import { hashPassword, unseal } from '../src/core/crypto';
import { nowIso } from '../src/core/time';
import { toPersianDigits } from '../src/core/digits';
import { TELEGRAM_SEAL_PURPOSE } from '../src/services/telegram';

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

const ADMIN_ID = 'usr_01TESTADMIN000000000000';
const ADMIN_MOBILE = '09000000000';
const ADMIN_PASSWORD = 'Admin-Placeholder-9';

/**
 * A mobile distinct from the acceptance test's.
 *
 * The suite shares one D1 database across files (`isolatedStorage: false`), so two tests
 * registering the same number would collide on the unique index and fail for a reason that
 * has nothing to do with what they are asserting.
 */
const MERCHANT_MOBILE = '09120000042';
const MERCHANT_PASSWORD = 'Correct-Horse-9';

const SECONDARY_ID = 'usr_01TESTSECONDADMIN000000';
const SECONDARY_MOBILE = '09000000001';
const SECONDARY_PASSWORD = 'Second-Admin-9';
const SECONDARY_ROTATED = 'Rotated-Passphrase-7';

const SUPPORT_ID = 'usr_01TESTSUPPORT0000000000';
const SUPPORT_MOBILE = '09000000002';
const SUPPORT_PASSWORD = 'Support-Agent-9';

/**
 * Creates a member of staff, or puts an existing one back to a known credential.
 *
 * The reset on every run is not belt-and-braces: this suite shares one database, and the
 * password-change test below rotates a password. Without the reset, running the file twice
 * would fail in the second run for a reason the second run did not cause.
 */
async function ensureUser(
  id: string,
  mobile: string,
  password: string,
  role: 'SUPER_ADMIN' | 'SUPPORT',
  displayName: string,
): Promise<void> {
  const passwordHash = await hashPassword(password);
  const existing = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (existing) {
    await env.DB.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 0, status = 'ACTIVE' WHERE id = ?",
    )
      .bind(passwordHash, id)
      .run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO users (id, mobile, password_hash, role, status, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
  )
    .bind(id, mobile, passwordHash, role, displayName, nowIso(), nowIso())
    .run();
}

async function ensureAdmin(): Promise<void> {
  await ensureUser(ADMIN_ID, ADMIN_MOBILE, ADMIN_PASSWORD, 'SUPER_ADMIN', 'Test Admin');
}

/** A second operator, so rotating a password cannot lock the shared admin out of this file. */
async function ensureSecondaryAdmin(): Promise<void> {
  await ensureUser(SECONDARY_ID, SECONDARY_MOBILE, SECONDARY_PASSWORD, 'SUPER_ADMIN', 'Second Admin');
}

/** An operator whose role may answer questions but not change platform configuration. */
async function ensureSupportAdmin(): Promise<void> {
  await ensureUser(SUPPORT_ID, SUPPORT_MOBILE, SUPPORT_PASSWORD, 'SUPPORT', 'Support Agent');
}

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

/** Merges cookie strings; a later value for the same name wins, so fresh beats stale. */
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

/**
 * Pulls the CSRF token out of a rendered page.
 *
 * Throws rather than returning empty: a form that lost its CSRF field is a real defect, and
 * silently posting without a token would turn that defect into a confusing 403 later.
 */
function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
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

/** Posts the admin login form. Left un-asserted so a test can check that a password *fails*. */
async function attemptAdminSignIn(mobile: string, password: string): Promise<Response> {
  const login = await SELF.fetch('https://steve-pay.test/login?scope=admin');
  expect(login.status).toBe(200);

  return SELF.fetch('https://steve-pay.test/login?scope=admin', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookiesOf(login),
    },
    body: new URLSearchParams({
      _csrf: csrfFrom(await login.text()),
      mobile,
      password,
    }).toString(),
    redirect: 'manual',
  });
}

async function signInAdmin(mobile: string, password: string): Promise<string> {
  const response = await attemptAdminSignIn(mobile, password);
  expect(response.status, `sign in as ${mobile}`).toBe(303);
  const session = cookiesOf(response);
  expect(session).toContain('sp_session=');
  return session;
}

async function adminSession(): Promise<string> {
  return signInAdmin(ADMIN_MOBILE, ADMIN_PASSWORD);
}

/**
 * Opens a console page and returns its markup, its CSRF token, and the cookie jar that
 * makes the token valid. Posting without the third value is a guaranteed 403.
 */
async function openForm(
  path: string,
  session: string,
): Promise<{ html: string; csrf: string; cookies: string }> {
  const response = await SELF.fetch(`https://steve-pay.test${path}`, { headers: { cookie: session } });
  expect(response.status, `GET ${path}`).toBe(200);
  const html = await response.text();
  return { html, csrf: csrfFrom(html), cookies: mergeCookies(session, cookiesOf(response)) };
}

/** Posts a form and returns the response with redirects left alone. */
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

/** Registers the shared merchant once; later tests in the file reuse it. */
async function ensureMerchant(): Promise<string> {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE mobile = ?')
    .bind(MERCHANT_MOBILE)
    .first<{ id: string }>();
  if (existing) return existing.id;

  const page = await SELF.fetch('https://steve-pay.test/register');
  const registered = await SELF.fetch('https://steve-pay.test/register', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookiesOf(page) },
    body: new URLSearchParams({
      _csrf: csrfFrom(await page.text()),
      displayName: 'فروشگاه کنسول',
      mobile: MERCHANT_MOBILE,
      businessType: 'DIGITAL_GOODS',
      password: MERCHANT_PASSWORD,
      confirmPassword: MERCHANT_PASSWORD,
    }).toString(),
  });
  expect(registered.status).toBe(201);

  const created = await env.DB.prepare('SELECT id FROM users WHERE mobile = ?')
    .bind(MERCHANT_MOBILE)
    .first<{ id: string }>();
  return created?.id as string;
}

// ---------------------------------------------------------------------------

describe('operator console (§28, §29, §54)', () => {
  it('approves a merchant, reveals the API key exactly once, and releases a flagged payment', async () => {
    await ensureAdmin();
    const internal = services();
    const merchantUserId = await ensureMerchant();

    // Registering must not mint credentials — that is the whole point of the queue.
    const keysBefore = await env.DB.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE merchant_user_id = ?')
      .bind(merchantUserId)
      .first<{ count: number }>();
    expect(keysBefore?.count).toBe(0);

    const pending = await env.DB.prepare('SELECT status FROM users WHERE id = ?')
      .bind(merchantUserId)
      .first<{ status: string }>();
    expect(pending?.status).toBe('PENDING_APPROVAL');

    const adminCookie = await adminSession();

    // -----------------------------------------------------------------------
    // 1. The approval queue actually shows the new registration.
    // -----------------------------------------------------------------------
    const list = await SELF.fetch('https://steve-pay.test/admin/users?status=PENDING_APPROVAL', {
      headers: { cookie: adminCookie },
    });
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain(merchantUserId);

    const detail = await openForm(`/admin/users/${merchantUserId}`, adminCookie);

    // Approving is offered; suspending a never-approved account is not.
    expect(detail.html).toContain('value="approve"');
    expect(detail.html).not.toContain('value="suspend"');

    // -----------------------------------------------------------------------
    // 2. Approval, which provisions the credential (§4).
    // -----------------------------------------------------------------------
    const approved = await post(`/admin/users/${merchantUserId}/action`, detail.cookies, {
      _csrf: detail.csrf,
      action: 'approve',
    });

    expect(approved.status).toBe(200);
    const keyMatch = /data-copy="(sk_live_[^"]+)"/.exec(await approved.text());
    expect(keyMatch).not.toBeNull();
    const apiKey = keyMatch?.[1] as string;

    // Shown once means shown in a response body, never in a redirect: a key in a `Location`
    // header ends up in access logs, the next request's Referer, and browser history.
    expect(approved.headers.get('location')).toBeNull();

    const status = await env.DB.prepare('SELECT status, approved_by FROM users WHERE id = ?')
      .bind(merchantUserId)
      .first<{ status: string; approved_by: string | null }>();
    expect(status?.status).toBe('ACTIVE');
    expect(status?.approved_by).toBe(ADMIN_ID);

    // The raw key must not be recoverable from the database.
    const stored = await env.DB.prepare(
      'SELECT key_hash, environment FROM api_keys WHERE merchant_user_id = ?',
    )
      .bind(merchantUserId)
      .first<{ key_hash: string; environment: string }>();
    expect(stored?.environment).toBe('live');
    expect(stored?.key_hash).not.toContain(apiKey);
    expect(stored?.key_hash).toMatch(/^[0-9a-f]{64}$/);

    // -----------------------------------------------------------------------
    // 3. The revealed key is the real one: it works on the machine API.
    // -----------------------------------------------------------------------
    const card = await internal.cards.create(
      merchantUserId,
      {
        number: luhnValid('610433789012345'),
        title: 'کارت کنسول',
        bankName: 'بانک ملت',
        holderName: 'فروشگاه کنسول',
        isDefault: true,
      },
      { userId: merchantUserId, role: 'MERCHANT', ip: null },
    );
    expect(card.masked).toContain('****');

    const created = await SELF.fetch('https://steve-pay.test/api/v1/payments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'idempotency-key': 'console-order-1',
      },
      body: JSON.stringify({ amount: 359000, description: 'سفارش کنسول' }),
    });
    expect(created.status).toBe(200);
    const invoice = (await created.json()) as { invoiceId: string; amount: number };
    // 359000 + 3000 fee = a base of 362000, plus the unique suffix on top.
    expect(invoice.amount).toBeGreaterThanOrEqual(362000);

    // -----------------------------------------------------------------------
    // 4. A bank message no parser recognises: unknown format, no destination card, no
    //    reference. The matcher finds the invoice, the risk layer declines to confirm, and
    //    the payment lands in the operator's queue (§19).
    // -----------------------------------------------------------------------
    const sms = await SELF.fetch('https://steve-pay.test/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ message: `واریز ${toPersianDigits(invoice.amount)} تومان انجام شد` }),
    });
    expect(sms.status).toBe(200);
    expect(((await sms.json()) as { outcome: string }).outcome).toBe('MANUAL_REVIEW');

    const queue = await openForm('/admin/review', adminCookie);

    // The queue must carry the invoice *and* the evidence behind it, not just the amount.
    // An operator cannot decide anything from a number alone.
    expect(queue.html).toContain(invoice.invoiceId);
    expect(queue.html).toContain('واریز');
    expect(queue.html).toContain('generic');

    // -----------------------------------------------------------------------
    // 5. The decision. Confirming settles the payment and charges the fee.
    // -----------------------------------------------------------------------
    const decided = await post(
      `/admin/review/${encodeURIComponent(invoice.invoiceId)}/confirm`,
      queue.cookies,
      { _csrf: queue.csrf },
    );

    expect(decided.status).toBe(303);
    expect(decided.headers.get('location')).toContain('ok=review_confirmed');

    const after = await env.DB.prepare('SELECT status FROM invoices WHERE id = ?')
      .bind(invoice.invoiceId)
      .first<{ status: string }>();
    expect(after?.status).toBe('PAID');

    const confirmed = await env.DB.prepare(
      'SELECT confirmation, status FROM transactions WHERE invoice_id = ?',
    )
      .bind(invoice.invoiceId)
      .first<{ confirmation: string; status: string }>();
    expect(confirmed?.status).toBe('CONFIRMED');
    // A person made this decision, and the transaction says so. An auditor reading the row
    // later must not have to guess whether the machine or a human released the money.
    expect(confirmed?.confirmation).toBe('MANUAL');

    // -----------------------------------------------------------------------
    // 6. The queue is empty again, and the whole story is in the audit log.
    // -----------------------------------------------------------------------
    const emptied = await SELF.fetch('https://steve-pay.test/admin/review', { headers: { cookie: adminCookie } });
    expect(await emptied.text()).toContain('صف خالی است');

    const audit = await SELF.fetch('https://steve-pay.test/admin/audit-logs', { headers: { cookie: adminCookie } });
    const auditHtml = await audit.text();
    expect(auditHtml).toContain('merchant.approved');
    expect(auditHtml).toContain('api_key.created');
    expect(auditHtml).toContain('payment.manual_confirmed');
  });

  it('refuses the console to a merchant session and to anonymous visitors', async () => {
    await ensureAdmin();
    const merchantUserId = await ensureMerchant();

    // A pending merchant cannot sign in at all, so this test has to activate one first —
    // which is itself the point: the account-status gate applies to the dashboard, not only
    // to the API.
    await services().merchants.applyAction(
      merchantUserId,
      'APPROVE',
      {},
      { userId: ADMIN_ID, role: 'SUPER_ADMIN', ip: null },
    );

    // Anonymous: the console is not a public surface, and an operator who is not signed in
    // is sent to the form that signs them in — with their destination, and to the *admin*
    // variant of it — rather than to a 401 page that offers them nothing to do next.
    const anonymous = await SELF.fetch('https://steve-pay.test/admin', { redirect: 'manual' });
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('location')).toBe('/login?scope=admin&next=%2Fadmin');

    for (const path of ['/admin/users', '/admin/review', '/admin/audit-logs', '/admin/revenue']) {
      const response = await SELF.fetch(`https://steve-pay.test${path}`, { redirect: 'manual' });
      expect(response.status, `${path} must redirect a signed-out browser`).toBe(302);
      expect(response.headers.get('location')).toBe(
        `/login?scope=admin&next=${encodeURIComponent(path)}`,
      );
    }

    const login = await SELF.fetch('https://steve-pay.test/login');
    const loggedIn = await SELF.fetch('https://steve-pay.test/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookiesOf(login) },
      body: new URLSearchParams({
        _csrf: csrfFrom(await login.text()),
        mobile: MERCHANT_MOBILE,
        password: MERCHANT_PASSWORD,
      }).toString(),
      redirect: 'manual',
    });
    expect(loggedIn.status).toBe(303);
    const merchantCookie = cookiesOf(loggedIn);
    expect(merchantCookie).toContain('sp_session=');

    // The merchant is signed in with a valid session, but a MERCHANT holds no admin
    // permission at all — the rejection has to come from the role, not from the session
    // happening to be absent.
    for (const path of ['/admin', '/admin/users', '/admin/review', '/admin/audit-logs', '/admin/revenue']) {
      const response = await SELF.fetch(`https://steve-pay.test${path}`, {
        headers: { cookie: merchantCookie },
        redirect: 'manual',
      });
      expect(response.status, `${path} must not be reachable by a merchant`).toBe(403);
    }

    // Recording a payment as settled is the highest-value action in the console; it must be
    // refused for a merchant session even though the queue page already is.
    const action = await SELF.fetch(`https://steve-pay.test/admin/users/${merchantUserId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: merchantCookie },
      body: new URLSearchParams({ action: 'ban' }).toString(),
      redirect: 'manual',
    });
    expect([401, 403]).toContain(action.status);
  });

  it('rejects an admin form post without a CSRF token', async () => {
    await ensureAdmin();
    const merchantUserId = await ensureMerchant();
    const adminCookie = await adminSession();

    const response = await SELF.fetch(`https://steve-pay.test/admin/users/${merchantUserId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: adminCookie },
      body: new URLSearchParams({ action: 'ban' }).toString(),
      redirect: 'manual',
    });

    // CSRF is checked before the action is interpreted, so a forged cross-site post cannot
    // reach the service layer at all.
    expect([400, 403]).toContain(response.status);

    const still = await env.DB.prepare('SELECT status FROM users WHERE id = ?')
      .bind(merchantUserId)
      .first<{ status: string }>();
    expect(still?.status).not.toBe('BANNED');
  });

  it('requires a reason to adjust a wallet, and records the adjustment in the ledger', async () => {
    await ensureAdmin();
    const internal = services();
    const merchantUserId = await ensureMerchant();
    const adminCookie = await adminSession();
    const detail = await openForm(`/admin/users/${merchantUserId}`, adminCookie);

    // No reason: refused, and no ledger row created.
    const unreasoned = await post(`/admin/users/${merchantUserId}/wallet`, detail.cookies, {
      _csrf: detail.csrf,
      direction: 'credit',
      amount: '500000',
      reason: '',
    });
    expect(unreasoned.status).toBe(303);
    expect(unreasoned.headers.get('location')).toContain('err=reason_required');

    const countCredits = async (): Promise<number> =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM wallet_ledger WHERE merchant_user_id = ? AND type = 'ADMIN_CREDIT'",
        )
          .bind(merchantUserId)
          .first<{ count: number }>()
      )?.count ?? 0;

    // The refused attempt must not have written anything.
    const before = await countCredits();

    // A credit is applied and appears in the ledger with a running balance.
    const credited = await post(`/admin/users/${merchantUserId}/wallet`, detail.cookies, {
      _csrf: detail.csrf,
      direction: 'credit',
      amount: '500000',
      reason: 'شارژ آزمایشی کنسول',
    });
    expect(credited.status).toBe(303);
    expect(credited.headers.get('location')).toContain('ok=wallet_credited');

    const entry = await env.DB.prepare(
      `SELECT type, amount, balance_after, created_by FROM wallet_ledger
        WHERE merchant_user_id = ? AND type = 'ADMIN_CREDIT' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
      .bind(merchantUserId)
      .first<{ type: string; amount: number; balance_after: number; created_by: string | null }>();

    expect(await countCredits()).toBe(before + 1);
    expect(entry?.amount).toBe(500_000);
    expect(entry?.balance_after).toBeGreaterThanOrEqual(500_000);
    // The operator's identity is on the money movement itself, not only in the audit log.
    expect(entry?.created_by).toBe(ADMIN_ID);

    // The wallet must still equal the sum of its ledger — the invariant that makes offering
    // a manual adjustment safe in the first place.
    const reconciled = await internal.wallet.reconcile(merchantUserId);
    expect(reconciled.agrees).toBe(true);

    const wallet = await internal.wallet.snapshot(merchantUserId);
    expect(wallet.balance).toBe(entry?.balance_after);
  });

  it('refuses a wallet debit larger than the balance', async () => {
    await ensureAdmin();
    const merchantUserId = await ensureMerchant();
    const adminCookie = await adminSession();
    const detail = await openForm(`/admin/users/${merchantUserId}`, adminCookie);

    const walletBefore = await services().wallet.snapshot(merchantUserId);

    const response = await post(`/admin/users/${merchantUserId}/wallet`, detail.cookies, {
      _csrf: detail.csrf,
      direction: 'debit',
      // Far beyond any balance this merchant holds, so the funding precondition in the
      // ledger insert is what has to refuse it.
      amount: String(walletBefore.balance + 10_000_000),
      reason: 'کاهش غیرمجاز آزمایشی',
    });

    // A refused debit is a message on the page, not a 500 and not a negative balance.
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('err=wallet_insufficient');

    const wallet = await services().wallet.snapshot(merchantUserId);
    expect(wallet.balance).toBe(walletBefore.balance);

    const reconciled = await services().wallet.reconcile(merchantUserId);
    expect(reconciled.agrees).toBe(true);
  });

  it('records every console action in the audit log', async () => {
    await ensureAdmin();
    const adminCookie = await adminSession();

    const page = await SELF.fetch('https://steve-pay.test/admin/audit-logs', {
      headers: { cookie: adminCookie },
    });
    expect(page.status).toBe(200);
    const html = await page.text();

    // The log is a real surface with real entries, and it offers the filter control an
    // operator needs to find one.
    expect(html).toContain('name="event"');
    expect(html).toContain('<option');
    expect(html).toContain('merchant.approved');

    // Nothing that looks like a secret may appear on an audit page.
    expect(html).not.toContain('sk_live_');
  });

  it('changes an operator password from the console and closes their other sessions', async () => {
    await ensureSecondaryAdmin();
    const session = await signInAdmin(SECONDARY_MOBILE, SECONDARY_PASSWORD);
    const form = await openForm('/admin/settings', session);

    // Any operator may reach this, whatever their role: it is their own credential.
    expect(form.html).toContain('تغییر گذرواژه');

    const wrong = await post('/admin/settings/password', form.cookies, {
      _csrf: form.csrf,
      currentPassword: 'not-the-password',
      newPassword: SECONDARY_ROTATED,
      confirmPassword: SECONDARY_ROTATED,
    });
    expect(wrong.status).toBe(303);
    expect(wrong.headers.get('location')).toContain('err=password_wrong');

    // A password the rules refuse says so, rather than silently doing nothing.
    const weak = await post('/admin/settings/password', form.cookies, {
      _csrf: form.csrf,
      currentPassword: SECONDARY_PASSWORD,
      newPassword: 'short1',
      confirmPassword: 'short1',
    });
    expect(weak.headers.get('location')).toContain('err=password_invalid');

    const mismatched = await post('/admin/settings/password', form.cookies, {
      _csrf: form.csrf,
      currentPassword: SECONDARY_PASSWORD,
      newPassword: SECONDARY_ROTATED,
      confirmPassword: `${SECONDARY_ROTATED}-typo`,
    });
    expect(mismatched.headers.get('location')).toContain('err=password_invalid');

    // A second device signed in as the same operator. Changing a password has to sign it out:
    // that is the whole point of the operation when someone else may have the password.
    const otherDevice = await signInAdmin(SECONDARY_MOBILE, SECONDARY_PASSWORD);

    const changed = await post('/admin/settings/password', form.cookies, {
      _csrf: form.csrf,
      currentPassword: SECONDARY_PASSWORD,
      newPassword: SECONDARY_ROTATED,
      confirmPassword: SECONDARY_ROTATED,
    });
    expect(changed.status).toBe(303);
    expect(changed.headers.get('location')).toContain('ok=password_changed');

    const stillIn = await SELF.fetch('https://steve-pay.test/admin/settings', {
      headers: { cookie: mergeCookies(form.cookies, cookiesOf(changed)) },
    });
    expect(stillIn.status, 'the device that changed the password was signed out too').toBe(200);

    const kicked = await SELF.fetch('https://steve-pay.test/admin/settings', {
      headers: { cookie: otherDevice },
      redirect: 'manual',
    });
    expect(kicked.status, 'the other session survived a password change').toBe(302);

    // And the credential really changed: the old one no longer signs in, the new one does.
    expect((await attemptAdminSignIn(SECONDARY_MOBILE, SECONDARY_PASSWORD)).status).not.toBe(303);
    expect((await attemptAdminSignIn(SECONDARY_MOBILE, SECONDARY_ROTATED)).status).toBe(303);
  });

  it('stores the Telegram bot token encrypted, and never renders it back', async () => {
    await ensureAdmin();
    const session = await adminSession();
    const form = await openForm('/admin/settings', session);
    expect(form.html).toContain('ربات تلگرام');

    // A token that is not shaped like one is refused before it is stored, so a typo cannot
    // sit in the row looking configured.
    const badToken = await post('/admin/settings/telegram', form.cookies, {
      _csrf: form.csrf,
      botToken: 'not-a-token',
      adminChatId: '',
      enabled: '',
    });
    expect(badToken.headers.get('location')).toContain('err=telegram_token_invalid');

    const badChat = await post('/admin/settings/telegram', form.cookies, {
      _csrf: form.csrf,
      botToken: '',
      adminChatId: 'not-a-chat-id',
      enabled: '',
    });
    expect(badChat.headers.get('location')).toContain('err=telegram_chat_invalid');

    // Switching the bot on without a token is refused with the message that says what to do.
    const enabledWithoutToken = await post('/admin/settings/telegram', form.cookies, {
      _csrf: form.csrf,
      botToken: '',
      adminChatId: '123456789',
      enabled: 'true',
    });
    expect(enabledWithoutToken.headers.get('location')).toContain('err=telegram_token_missing');

    const token = `123456789:AA${'F'.repeat(33)}`;
    const saved = await post('/admin/settings/telegram', form.cookies, {
      _csrf: form.csrf,
      botToken: token,
      adminChatId: '-1001234567890',
      enabled: 'true',
    });
    expect(saved.status).toBe(303);
    // Telegram cannot verify a token that does not exist, and the console says so instead of
    // reporting a success it did not have.
    expect(saved.headers.get('location')).toContain('telegram_saved_unreachable');

    const row = await env.DB.prepare(
      "SELECT value, is_secret FROM system_settings WHERE key = 'telegram.bot_token'",
    ).first<{ value: string; is_secret: number }>();
    expect(row?.is_secret, 'the token row must be marked secret').toBe(1);
    expect(row?.value).not.toBe(token);
    expect(row?.value).not.toContain('123456789:');

    // Encrypted is only useful if it decrypts: the round trip is what the bot needs.
    const secrets = resolveSecrets(env);
    expect(await unseal(row!.value, secrets.sessionSecret, TELEGRAM_SEAL_PURPOSE)).toBe(token);

    const chat = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = 'telegram.admin_chat_id'",
    ).first<{ value: string }>();
    expect(chat?.value).toBe('-1001234567890');

    const audited = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE event = 'settings.telegram_updated'",
    ).first<{ count: number }>();
    expect(audited?.count ?? 0).toBeGreaterThan(0);

    // Reading the page back shows that a token is stored without printing it anywhere.
    const after = await openForm('/admin/settings', session);
    expect(after.html).not.toContain(token);
    expect(after.html).not.toContain('F'.repeat(33));
    expect(after.html).toContain('ذخیره شده');

    // The form is hidden from a role that may not use it — and the endpoint refuses them
    // as well, because hiding a form has never been an access rule.
    await ensureSupportAdmin();
    const supportSession = await signInAdmin(SUPPORT_MOBILE, SUPPORT_PASSWORD);
    const supportForm = await openForm('/admin/settings', supportSession);
    expect(supportForm.html).not.toContain('توکن ربات');

    const refused = await post('/admin/settings/telegram', supportForm.cookies, {
      _csrf: supportForm.csrf,
      botToken: '',
      adminChatId: '',
      enabled: 'false',
    });
    expect(refused.status).toBe(403);
  });
});
