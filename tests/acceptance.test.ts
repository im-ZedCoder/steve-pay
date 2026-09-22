/**
 * Acceptance test for the end-to-end flow (§78).
 *
 * This drives the *deployed* Worker through `SELF`, so every request goes through the
 * real entry point, the real router, the real middleware, the real security headers and
 * the real service layer against a real D1 database with the real migration SQL applied.
 * Nothing is stubbed. That is the point: the things most likely to be wrong — a cookie
 * attribute, a CSP that blocks the page's own script, a route registered in the wrong
 * order, a partial unique index that does not fire — are exactly the things a mocked test
 * cannot see.
 *
 * The flow mirrors the brief:
 *
 *   register -> admin approves -> API key -> bank card -> makePayment -> payment page
 *   -> bank SMS -> parse -> match -> risk -> confirm -> status PAID
 */

import { env, SELF, createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { servicesFor, type ServiceContext } from '../src/routes/container';
import { ReportingService } from '../src/services/reporting';
import { createLogger } from '../src/obs/logger';
import { resolveConfig } from '../src/env';
import { id as newId } from '../src/core/ids';
import { hashPassword } from '../src/core/crypto';
import { nowIso } from '../src/core/time';
import { toPersianDigits } from '../src/core/digits';
import { formatRialFa, formatTomanFa } from '../src/core/money';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A service container for a synthetic request.
 *
 * Used only for the setup steps that have no HTTP surface yet (approving a merchant,
 * issuing a key, adding a card). Using the real container rather than hand-written SQL
 * means the test exercises the same validation, audit writes and idempotency guards that
 * the admin console will later call into.
 */
function services() {
  const context: ServiceContext = {
    request: new Request('https://steve-pay.test/test'),
    env,
    ctx: createExecutionContext(),
    requestId: newId('req'),
    logger: createLogger({ level: 'error', base: { surface: 'test' } }),
    config: resolveConfig(env),
  };
  return { services: servicesFor(context), context };
}

const ADMIN_ID = 'usr_01TESTADMIN000000000000';
const MERCHANT_MOBILE = '09123456789';
const MERCHANT_PASSWORD = 'Correct-Horse-9';

/** An active SUPER_ADMIN. Created directly: there is no self-service admin signup, by design. */
async function ensureAdmin(): Promise<void> {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(ADMIN_ID).first();
  if (existing) return;
  const hash = await hashPassword('Admin-Placeholder-9');
  await env.DB.prepare(
    `INSERT INTO users (id, mobile, password_hash, role, status, display_name, created_at, updated_at)
     VALUES (?, ?, ?, 'SUPER_ADMIN', 'ACTIVE', 'Test Admin', ?, ?)`,
  )
    .bind(ADMIN_ID, '09000000000', hash, nowIso(), nowIso())
    .run();
}

/**
 * A Luhn-valid card number built from a real Iranian BIN.
 *
 * Computed rather than hard-coded so the test states *why* the number is valid: the last
 * digit is the check digit that makes the whole string pass the Luhn algorithm, and 610433
 * is a genuine Shetab issuer prefix. If either validation changes, this test fails
 * loudly instead of depending on a magic constant someone once copied from a blog post.
 */
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

interface ResponseHeaders {
  getSetCookie?: () => string[];
}

function cookiesOf(response: Response): string {
  const headers = response.headers as unknown as ResponseHeaders;
  const list =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];
  return list
    .filter((value) => value.length > 0)
    .map((value) => value.split(';')[0])
    .join('; ');
}

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!match || !match[1]) throw new Error('CSRF field not found in the rendered form');
  return match[1];
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

describe('Steve Pay end-to-end flow (§78)', () => {
  it('registers a merchant, gets approved, and settles a payment from a bank SMS', async () => {
    await ensureAdmin();
    const setup = services();

    // -----------------------------------------------------------------------
    // 1. Registration. The form is CSRF-protected, so the token is taken from the
    //    real rendered page exactly as a browser would.
    // -----------------------------------------------------------------------
    const registerForm = await SELF.fetch('https://steve-pay.test/register');
    expect(registerForm.status).toBe(200);

    const registerCookies = cookiesOf(registerForm);
    expect(registerCookies).toContain('sp_csrf=');
    const registerHtml = await registerForm.text();
    // The form's one interactive affordance is the password reveal, so the page loads the
    // client script — and above all it must not inline one, because the CSP is
    // `script-src 'self'` and an inline block would be blocked by the browser with no
    // server-side symptom. Every script tag on the page must therefore be external;
    // Turnstile is switched off in this environment, so the client script is the only one.
    expect(registerHtml).toContain('/assets/client.js');
    expect(registerHtml).not.toMatch(/<script(?![^>]*\ssrc=)/);
    // ...and what it loads has to be wired to a field that exists.
    expect(registerHtml).toContain('data-pw-toggle="f_password"');
    expect(registerHtml).toContain('id="f_password"');

    const registerBody = new URLSearchParams({
      _csrf: csrfFrom(registerHtml),
      displayName: 'فروشگاه تست',
      mobile: MERCHANT_MOBILE,
      businessType: 'DIGITAL_GOODS',
      businessDescription: 'تست پذیرش خودکار',
      password: MERCHANT_PASSWORD,
      confirmPassword: MERCHANT_PASSWORD,
    });

    const registered = await SELF.fetch('https://steve-pay.test/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: registerCookies,
      },
      body: registerBody.toString(),
    });
    expect(registered.status).toBe(201);

    const merchant = await env.DB.prepare(
      'SELECT id, status FROM users WHERE mobile = ?',
    )
      .bind(MERCHANT_MOBILE)
      .first<{ id: string; status: string }>();

    expect(merchant).not.toBeNull();
    // Registration must not self-activate (§4).
    expect(merchant?.status).toBe('PENDING_APPROVAL');
    const merchantUserId = merchant?.id as string;

    // -----------------------------------------------------------------------
    // 2. A pending merchant cannot reach the API at all, even if a key existed. The
    //    account-status gate is what makes approval meaningful rather than cosmetic.
    // -----------------------------------------------------------------------
    await expect(
      setup.services.merchants.assertUsable(merchantUserId),
    ).rejects.toMatchObject({ code: 'ACCOUNT_PENDING_APPROVAL' });

    // -----------------------------------------------------------------------
    // 3. Admin approval (§29), which is what issues credentials.
    // -----------------------------------------------------------------------
    const approval = await setup.services.merchants.applyAction(
      merchantUserId,
      'APPROVE',
      {},
      { userId: ADMIN_ID, role: 'SUPER_ADMIN', ip: null },
    );
    expect(approval.status).toBe('ACTIVE');

    // -----------------------------------------------------------------------
    // 4. API key (§6). Approval is what creates the credential, so an operator cannot
    //    leave a merchant active with no way to call the API. The full secret is returned
    //    exactly once, here, and never stored in recoverable form.
    // -----------------------------------------------------------------------
    const issued = approval.initialApiKey;
    expect(issued).toBeDefined();
    if (!issued) throw new Error('approval did not issue an API key');

    expect(issued.fullKey.startsWith('sk_live_')).toBe(true);

    // Approving again must not mint a second key — the guard is "has no live key", so a
    // repeated approval is a no-op rather than a slow accumulation of valid secrets.
    const reapproval = await setup.services.merchants.applyAction(
      merchantUserId,
      'APPROVE',
      {},
      { userId: ADMIN_ID, role: 'SUPER_ADMIN', ip: null },
    );
    expect(reapproval.initialApiKey).toBeUndefined();
    expect(await setup.services.apiKeys.list(merchantUserId)).toHaveLength(1);

    const stored = await env.DB.prepare('SELECT key_hash FROM api_keys WHERE id = ?')
      .bind(issued.view.id)
      .first<{ key_hash: string }>();

    // The raw key must not be recoverable from the database.
    expect(stored?.key_hash).not.toContain(issued.fullKey);
    // A 32-byte random secret is stored as a peppered HMAC-SHA256, not a slow KDF: a
    // password needs key stretching because it is guessable, whereas a generated key has
    // full entropy and only needs to be unrecoverable and compared in constant time.
    // Asserting the shape keeps that decision from silently becoming a `===` comparison.
    expect(stored?.key_hash).toMatch(/^[0-9a-f]{64}$/);

    // -----------------------------------------------------------------------
    // 5. Bank card (§9).
    // -----------------------------------------------------------------------
    const cardNumber = luhnValid('610433789012345');
    const card = await setup.services.cards.create(
      merchantUserId,
      {
        number: cardNumber,
        title: 'کارت اصلی',
        bankName: 'بانک ملت',
        holderName: 'فروشگاه تست',
        isDefault: true,
      },
      { userId: merchantUserId, role: 'MERCHANT', ip: null },
    );
    expect(card.masked).not.toBe(cardNumber);
    expect(card.masked).toContain('****');

    // -----------------------------------------------------------------------
    // 6. makePayment (§7, §75). The requested amount is 359000 Toman and the customer
    //    pays the fee, so the payable amount is the base plus a unique suffix — never
    //    equal to the requested amount, and never lower than it.
    // -----------------------------------------------------------------------
    const created = await SELF.fetch('https://steve-pay.test/api/v1/payments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': issued.fullKey,
        'idempotency-key': 'acceptance-order-1',
      },
      body: JSON.stringify({ amount: 359000, description: 'سفارش تست ۱' }),
    });

    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      success: boolean;
      invoiceId: string;
      paymentId: string;
      amount: number;
      amountRial: number;
      payment: { payableAmount: number; originalAmount: number; fee: number; uniqueSuffix: number };
    };

    expect(createdBody.success).toBe(true);
    // Arithmetic, checked against the brief's own worked example: 359000 + 3000 fee
    // becomes a base of 362000, and the payable amount adds a suffix on top.
    expect(createdBody.payment.originalAmount).toBe(359000);
    expect(createdBody.payment.fee).toBe(3000);
    expect(createdBody.amount).toBeGreaterThanOrEqual(362000);
    expect(createdBody.payment.uniqueSuffix).toBeGreaterThan(0);
    // Rial is exactly ten times Toman — never a float, never a rounded value.
    expect(createdBody.amountRial).toBe(createdBody.amount * 10);

    const invoiceId = createdBody.invoiceId;

    // -----------------------------------------------------------------------
    // 7. Idempotency (§38). The same key must return the same invoice, not a second one.
    // -----------------------------------------------------------------------
    const replayed = await SELF.fetch('https://steve-pay.test/api/v1/payments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': issued.fullKey,
        'idempotency-key': 'acceptance-order-1',
      },
      body: JSON.stringify({ amount: 359000, description: 'سفارش تست ۱' }),
    });

    expect(replayed.status).toBe(200);
    expect(replayed.headers.get('idempotent-replay')).toBe('true');
    const replayedBody = (await replayed.json()) as { invoiceId: string };
    expect(replayedBody.invoiceId).toBe(invoiceId);

    // A key reused with a *different* body is a client bug, not a replay.
    const conflicting = await SELF.fetch('https://steve-pay.test/api/v1/payments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': issued.fullKey,
        'idempotency-key': 'acceptance-order-1',
      },
      body: JSON.stringify({ amount: 999000 }),
    });
    expect(conflicting.status).toBe(409);

    const invoiceCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM invoices WHERE merchant_user_id = ?',
    )
      .bind(merchantUserId)
      .first<{ n: number }>();
    expect(invoiceCount?.n).toBe(1);

    // -----------------------------------------------------------------------
    // 8. The payment page (§8, §49, §74). The customer must be able to read the exact
    //    amount in Toman, in Persian digits, with the Rial figure secondary.
    // -----------------------------------------------------------------------
    const payResponse = await SELF.fetch(`https://steve-pay.test/pay/${invoiceId}`);
    expect(payResponse.status).toBe(200);

    const payHtml = await payResponse.text();
    expect(payHtml).toContain(formatTomanFa(createdBody.amount));
    // Rial is formatted by the money module, not by a hand-rolled conversion: the figure
    // is grouped with the Arabic thousands separator (U+066C), which is what a Persian
    // reader expects and what a naive `toPersianDigits` would get wrong.
    expect(payHtml).toContain(formatRialFa(createdBody.amountRial));
    // The exact-amount instruction from §74, verbatim.
    expect(payHtml).toContain('مبلغ دقیق نمایش‌داده‌شده را دقیقاً به همین مقدار واریز کنید');
    // The full receiving card, so the customer can actually make the transfer.
    expect(payHtml).toContain(cardNumber);
    // Countdown and polling hooks, and the external script that drives them. The script
    // is a separate cached asset rather than an inline block, because the CSP forbids
    // inline script — so the page must reference it by URL.
    expect(payHtml).toContain('data-expires-at');
    expect(payHtml).toContain(`/status/${invoiceId}`);
    expect(payHtml).toContain('<script src="/assets/client.js" defer></script>');
    // Invoice pages must never be indexed.
    expect(payHtml).toContain('noindex');
    // Turnstile origins are NOT in the default CSP; only the registration page adds them.
    expect(payResponse.headers.get('content-security-policy')).not.toContain('challenges.cloudflare.com');

    // -----------------------------------------------------------------------
    // 9. The bank SMS (§14, §17, §18). The message quotes the payable amount in Toman
    //    with Persian digits, which is what a real bank message looks like.
    // -----------------------------------------------------------------------
    const reference = '842190331';
    const smsBody = [
      `واریز به کارت ${cardNumber}`,
      `مبلغ ${toPersianDigits(createdBody.amount)} تومان`,
      `شماره پیگیری ${toPersianDigits(reference)}`,
      'بانک ملت',
    ].join('\n');

    const smsResponse = await SELF.fetch('https://steve-pay.test/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': issued.fullKey },
      body: JSON.stringify({ message: smsBody, sender: 'BANKMELLI', deviceId: 'acceptance-device' }),
    });

    expect(smsResponse.status).toBe(200);
    const smsResult = (await smsResponse.json()) as {
      success: boolean;
      outcome: string;
      invoiceId: string | null;
      parse: { parser: string; amountToman: number | null; reference: string | null } | null;
    };

    // If the parser read the message differently, this assertion prints what it saw
    // rather than only that it failed.
    expect(
      { outcome: smsResult.outcome, parse: smsResult.parse },
      `SMS outcome was ${smsResult.outcome} with parse ${JSON.stringify(smsResult.parse)}`,
    ).toMatchObject({ outcome: 'CONFIRMED' });

    expect(smsResult.invoiceId).toBe(invoiceId);
    expect(smsResult.parse?.amountToman).toBe(createdBody.amount);

    // -----------------------------------------------------------------------
    // 10. The invoice is PAID, the transaction exists, and the audit trail recorded it.
    // -----------------------------------------------------------------------
    const statusResponse = await SELF.fetch(`https://steve-pay.test/status/${invoiceId}`);
    expect(statusResponse.status).toBe(200);
    const statusBody = (await statusResponse.json()) as { status: string };
    expect(statusBody.status).toBe('PAID');

    const transaction = await env.DB.prepare(
      'SELECT amount, bank_reference, net_amount, fee_total, is_test FROM transactions WHERE invoice_id = ?',
    )
      .bind(invoiceId)
      .first<{
        amount: number;
        bank_reference: string;
        net_amount: number;
        fee_total: number;
        is_test: number;
      }>();

    expect(transaction).not.toBeNull();
    expect(transaction?.amount).toBe(createdBody.amount);
    expect(transaction?.bank_reference).toBe(reference);
    expect(transaction?.is_test).toBe(0);

    // -----------------------------------------------------------------------
    // 10b. The fee earned by that payment is visible to the platform (§31).
    //
    //      Regression guard. Fee revenue was summed from `wallet_ledger`, but the default
    //      `CUSTOMER` fee mode is paid by the payer on top of the amount, so no wallet is
    //      debited and no ledger row is written — the console reported zero revenue on a day
    //      when every payment earned a fee. The invoice is the record that is complete.
    // -----------------------------------------------------------------------
    const invoiceMoney = await env.DB.prepare(
      'SELECT settled_fee, fee_mode FROM invoices WHERE id = ?',
    )
      .bind(invoiceId)
      .first<{ settled_fee: number | null; fee_mode: string }>();

    expect(invoiceMoney?.fee_mode).toBe('CUSTOMER');
    expect(invoiceMoney?.settled_fee ?? 0).toBeGreaterThan(0);

    const ledgerFeeRows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM wallet_ledger WHERE type = 'PAYMENT_FEE' AND reference = ? AND reference_type = 'invoice'",
    )
      .bind(invoiceId)
      .first<{ n: number }>();
    // The wallet really was untouched — this is what made the ledger blind to the revenue.
    expect(ledgerFeeRows?.n).toBe(0);

    const revenue = await new ReportingService(env.DB).revenueSummary();
    expect(revenue.feesTotal).toBeGreaterThanOrEqual(invoiceMoney?.settled_fee ?? 0);
    expect(revenue.paidTotal).toBeGreaterThanOrEqual(1);

    const auditEvents = await env.DB.prepare(
      "SELECT DISTINCT event FROM audit_logs WHERE merchant_user_id = ? ORDER BY event",
    )
      .bind(merchantUserId)
      .all<{ event: string }>();
    const events = auditEvents.results.map((row) => row.event);
    expect(events).toContain('merchant.approved');
    expect(events).toContain('api_key.created');

    // -----------------------------------------------------------------------
    // 11. Never confirm the same transaction twice (§18, §72 rule 4). Re-forwarding the
    //     identical SMS must be recognised as a duplicate and must not touch anything.
    // -----------------------------------------------------------------------
    const duplicate = await SELF.fetch('https://steve-pay.test/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': issued.fullKey },
      body: JSON.stringify({ message: smsBody, sender: 'BANKMELLI', deviceId: 'acceptance-device' }),
    });
    expect(duplicate.status).toBe(200);
    const duplicateBody = (await duplicate.json()) as { outcome: string };
    expect(['DUPLICATE', 'DUPLICATE_TRANSACTION', 'NOT_A_PAYMENT']).toContain(duplicateBody.outcome);

    const transactionCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM transactions WHERE invoice_id = ?',
    )
      .bind(invoiceId)
      .first<{ n: number }>();
    expect(transactionCount?.n).toBe(1);
  });

  it('rejects an unauthenticated API call and an invalid key', async () => {
    const noKey = await SELF.fetch('https://steve-pay.test/api/v1/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 10000 }),
    });
    // A machine route answers JSON, never an HTML error page.
    expect(noKey.status).toBe(401);
    const noKeyBody = (await noKey.json()) as { success: boolean; code: string; requestId: string };
    expect(noKeyBody.success).toBe(false);
    expect(noKeyBody.code).toBe('UNAUTHENTICATED');
    expect(noKeyBody.requestId).toBeTruthy();

    const badKey = await SELF.fetch('https://steve-pay.test/api/v1/wallet', {
      headers: { 'x-api-key': 'sk_live_totally-made-up' },
    });
    expect(badKey.status).toBe(401);
    const badKeyBody = (await badKey.json()) as { code: string };
    expect(badKeyBody.code).toBe('INVALID_API_KEY');
  });

  it('answers health checks without requiring any secret', async () => {
    const response = await SELF.fetch('https://steve-pay.test/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; checks: { database: { status: string } } };
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('ok');
  });
});

/**
 * Cookie attributes follow the connection, not the environment name (§40, §59).
 *
 * This is a regression test for a login that could not work. The session cookie was marked
 * `Secure` whenever `ENVIRONMENT` said `production`, whatever scheme the request arrived on.
 * A `Secure` cookie sent over plain HTTP is not an error anywhere: the browser discards it
 * silently. The password was accepted, the server answered `303 /dashboard`, and the next
 * request arrived with no session — so the merchant saw the login page again, with nothing in
 * the logs and no message on the page.
 *
 * Both directions are asserted, because the failure mode of "just stop sending Secure" is a
 * session cookie that travels in the clear on the deployment that needs the flag most.
 */
describe('session cookie security attributes (§40, §59)', () => {
  it('marks the cookie Secure when the request arrived over TLS', async () => {
    const response = await SELF.fetch('https://steve-pay.test/login');
    const cookies = response.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
    }
  });

  it('omits Secure on a plain-HTTP request, so the cookie is actually stored', async () => {
    const response = await SELF.fetch('http://steve-pay.test/login');
    const cookies = response.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie).not.toContain('Secure');
    }
    // The CSRF cookie must stay readable by script: the dashboard's fetch() flows send it in
    // a header, and a HttpOnly CSRF cookie would break every one of them.
    const csrf = cookies.find((cookie) => cookie.startsWith('sp_csrf='));
    expect(csrf).toBeDefined();
    expect(csrf).not.toContain('HttpOnly');
  });

  it('does not send HSTS over plain HTTP, where a browser would ignore it anyway', async () => {
    const insecure = await SELF.fetch('http://steve-pay.test/health');
    expect(insecure.headers.get('strict-transport-security')).toBeNull();
  });
});
