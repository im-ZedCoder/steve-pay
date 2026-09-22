/**
 * Concurrency and financial-invariant tests (§13, §53, §69, §72).
 *
 * These are the tests that justify the schema design. The unique payment amount is not
 * guaranteed by an application-level "is this free?" check — it is guaranteed by the
 * partial unique index `ux_invoices_active_amount`, and the application's job is only to
 * respond correctly when the database says no. So the test that matters is not "does the
 * generator return different numbers", it is "when a hundred requests race for the same
 * base amount, does every invoice end up with its own amount, and does anything get
 * through that should not".
 *
 * Real workerd, real D1, real indexes. A mocked database would pass all of this trivially
 * and prove nothing.
 */

import { env, SELF, createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { servicesFor, type ServiceContext } from '../src/routes/container';
import { createLogger } from '../src/obs/logger';
import { resolveConfig } from '../src/env';
import { id as newId } from '../src/core/ids';

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

/** A Luhn-valid card from a real Shetab BIN, computed rather than hard-coded. */
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
 * Takes a merchant all the way to "can call makePayment".
 *
 * Uses the services directly rather than the HTTP surface: registration and approval are
 * covered by the acceptance test, and here they are setup, not the subject.
 */
async function onboard(mobile: string, cardPrefix: string): Promise<{ merchantUserId: string; apiKey: string }> {
  const api = services();

  const created = await api.auth.register(
    {
      mobile,
      password: 'Concurrency-Pass-9',
      confirmPassword: 'Concurrency-Pass-9',
      businessType: 'SERVICES',
      displayName: `Load Test ${mobile.slice(-4)}`,
    },
    { ip: '127.0.0.1', userAgent: 'vitest' },
  );

  const admin = await env.DB.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1").first<{ id: string }>();
  await api.merchants.applyAction(
    created.userId,
    'APPROVE',
    {},
    { userId: admin?.id ?? created.userId, role: 'SUPER_ADMIN', ip: null },
  );

  const issued = await api.apiKeys.issue({
    merchantUserId: created.userId,
    environment: 'live',
    scopes: ['payments:create', 'payments:read', 'transactions:read'],
    actor: { userId: admin?.id ?? created.userId, role: 'SUPER_ADMIN', ip: null },
  });

  await api.cards.create(
    created.userId,
    { number: luhnValid(cardPrefix), title: 'Load card', bankName: 'بانک ملت', isDefault: true },
    { userId: created.userId, role: 'MERCHANT', ip: null },
  );

  return { merchantUserId: created.userId, apiKey: issued.fullKey };
}

const BASE_AMOUNT = '1000000'; // 1,000,000 Toman — a 4-digit suffix space of 9000 candidates.

describe('API rate limiting (§39)', () => {
  it('caps makePayment per merchant and reports how long to wait', async () => {
    const { apiKey } = await onboard('09121110006', '610433789012666');

    // The ceiling is pinned rather than inherited from the default, because Miniflare
    // persists D1 to .wrangler/state between runs and the test below deliberately raises
    // this setting. Reading "the default" here would make the test pass on a fresh machine
    // and fail on the second run — the worst kind of failure.
    //
    // The ceiling is far below the burst size on purpose. A fixed window is keyed on the
    // wall clock, and these 70 requests take several seconds to drain, so the batch can
    // straddle a minute boundary — that is exactly how this test used to fail about once
    // in ten runs by spreading ~35 requests into each window, both under a ceiling of 60.
    // With a ceiling of 8, though, zero refusals would need the batch to span nine
    // windows, which is eight minutes rather than seconds: the assertion now holds whatever
    // the clock says.
    await services().settings.set('rate_limit.make_payment_per_minute', '8', null);

    // 70 attempts against a ceiling of 8, so the overwhelming majority must be refused.
    const responses = await Promise.all(
      Array.from({ length: 70 }, (_unused, index) =>
        SELF.fetch('https://steve-pay.test/api/v1/payments', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'idempotency-key': `limit-${index}-${newId('req')}`,
          },
          body: JSON.stringify({ amount: '120000', description: `limit ${index}` }),
        }),
      ),
    );

    const limited = responses.filter((response) => response.status === 429);
    expect(limited.length, 'the per-merchant limit did not engage').toBeGreaterThan(0);

    // A bare 429 makes every well-behaved client retry immediately, which turns a limit
    // into an outage — so the response must carry the retry metadata.
    const sample = limited[0] as Response;
    expect(Number(sample.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await sample.json()) as { code: string; requestId: string };
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.requestId).toBeTruthy();
  });
});

describe('concurrent invoice creation (§11, §53, §72 rule 9)', () => {
  it('gives 100 simultaneous invoices 100 distinct payment amounts', async () => {
    const { merchantUserId, apiKey } = await onboard('09121110001', '610433789012345');

    // The rate limit is not the subject here — the amount allocator is. The ceiling is
    // asserted by the test above, so it is raised to let all 100 requests reach the
    // allocator instead of measuring the limiter twice.
    await services().settings.set('rate_limit.make_payment_per_minute', '1000', null);

    const PARALLEL = 100;

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_unused, index) =>
        SELF.fetch('https://steve-pay.test/api/v1/payments', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            // A distinct key per request: these are 100 *different* orders that happen to
            // share an amount, which is exactly the collision case the index must handle.
            'idempotency-key': `load-${index}-${newId('req')}`,
          },
          body: JSON.stringify({ amount: BASE_AMOUNT, description: `load ${index}` }),
        }),
      ),
    );

    // Every request must succeed. With a 9000-wide suffix space and 100 contenders, a
    // correct retry loop never exhausts it — so a single failure here means the retry
    // path is broken, not that the space ran out.
    const statuses = responses.map((response) => response.status);
    const failures = statuses.filter((status) => status !== 200);
    expect(failures, `non-200 responses: ${failures.join(', ')}`).toEqual([]);

    const bodies = await Promise.all(
      responses.map(
        (response) =>
          response.json() as Promise<{
            invoiceId: string;
            amount: number;
            payment: { baseAmount: number; uniqueSuffix: number; payableAmount: number };
          }>,
      ),
    );

    // Distinct invoices.
    const invoiceIds = new Set(bodies.map((body) => body.invoiceId));
    expect(invoiceIds.size).toBe(PARALLEL);

    // Distinct payable amounts — the whole point.
    const payableAmounts = new Set(bodies.map((body) => body.amount));
    expect(payableAmounts.size, 'duplicate payable amounts were issued').toBe(PARALLEL);

    // Every amount is above the base and inside the 4-digit suffix space.
    for (const body of bodies) {
      expect(body.payment.baseAmount).toBe(Number(BASE_AMOUNT) + 3000);
      expect(body.payment.payableAmount).toBeGreaterThanOrEqual(body.payment.baseAmount);
      expect(body.payment.uniqueSuffix).toBeGreaterThanOrEqual(1);
      expect(body.payment.uniqueSuffix).toBeLessThanOrEqual(9999);
      // The amount the customer pays is exactly base + suffix, with no float drift.
      expect(body.amount).toBe(body.payment.baseAmount + body.payment.uniqueSuffix);
    }

    // The database agrees, and nothing was silently written twice.
    const dbCheck = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT payable_amount) AS distinct_amounts
         FROM invoices
        WHERE merchant_user_id = ? AND status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING','MANUAL_REVIEW')`,
    )
      .bind(merchantUserId)
      .first<{ total: number; distinct_amounts: number }>();

    expect(dbCheck?.total).toBe(PARALLEL);
    expect(dbCheck?.distinct_amounts).toBe(PARALLEL);
  });

  it('rejects the same Idempotency-Key used concurrently, creating exactly one invoice', async () => {
    const { merchantUserId, apiKey } = await onboard('09121110002', '610411111111111');

    const PARALLEL = 20;
    const headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'idempotency-key': `same-key-${newId('req')}`,
    };

    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        SELF.fetch('https://steve-pay.test/api/v1/payments', {
          method: 'POST',
          headers,
          body: JSON.stringify({ amount: '250000', description: 'same key' }),
        }),
      ),
    );

    // Whoever wins the claim creates the invoice; the rest either replay the stored
    // response or are told the request is still in flight. What must never happen is two
    // invoices for one key.
    const statuses = responses.map((response) => response.status);
    for (const status of statuses) {
      expect([200, 409]).toContain(status);
    }

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM invoices WHERE merchant_user_id = ?')
      .bind(merchantUserId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    const keyRows = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM idempotency_keys WHERE merchant_user_id = ?',
    )
      .bind(merchantUserId)
      .first<{ n: number }>();
    expect(keyRows?.n).toBe(1);
  });

  it('refuses to add a card that is already registered to the same merchant', async () => {
    const { merchantUserId } = await onboard('09121110003', '610433789012345');
    const api = services();
    const number = luhnValid('610433789012345');

    // The first insert is the one `onboard` already made for this merchant.
    await expect(
      api.cards.create(
        merchantUserId,
        { number, title: 'Duplicate', isDefault: false },
        { userId: merchantUserId, role: 'MERCHANT', ip: null },
      ),
    ).rejects.toMatchObject({ code: 'CARD_DUPLICATE' });
  });
});

describe('wallet ledger integrity (§22, §72 rules 5 and 6)', () => {
  it('charges a given invoice a gateway fee at most once (§72 rule 5)', async () => {
    const { merchantUserId, apiKey } = await onboard('09121110004', '610433789012999');
    const api = services();

    await api.wallet.ensure(merchantUserId);

    // Fund the wallet through the ledger, not by writing a balance directly. There is no
    // code path that can set a balance without a matching ledger row (§72 rule 6).
    await api.wallet.credit({
      merchantUserId,
      amount: 50_000,
      type: 'ADMIN_CREDIT',
      description: 'test funding',
      idempotencyKey: `funding-${merchantUserId}`,
      createdBy: 'test',
    });

    const before = await api.wallet.snapshot(merchantUserId);
    expect(before.balance).toBe(50_000);

    // A real invoice, because the fee's idempotency key is derived from its id — that is
    // the mechanism: "charge this invoice's fee twice" is not expressible, rather than
    // being something a caller has to remember not to do.
    const created = await SELF.fetch('https://steve-pay.test/api/v1/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ amount: '10000', description: 'fee idempotency' }),
    });
    const invoiceId = ((await created.json()) as { invoiceId: string }).invoiceId;

    const first = await api.wallet.chargeFee({ merchantUserId, invoiceId, amount: 3000 });
    expect(first.applied).toBe(true);

    const second = await api.wallet.chargeFee({ merchantUserId, invoiceId, amount: 3000 });
    expect(second.applied).toBe(false);

    const after = await api.wallet.snapshot(merchantUserId);
    expect(after.balance).toBe(47_000);

    // One ledger row per movement, and the running balance is consistent with the sum.
    const ledger = await api.wallet.ledger(merchantUserId, { limit: 50 });
    const feeRows = ledger.filter((row) => row.type === 'PAYMENT_FEE');
    expect(feeRows).toHaveLength(1);

    const net = ledger.reduce(
      (total, row) => total + (row.direction === 'CREDIT' ? row.amount : -row.amount),
      0,
    );
    expect(net).toBe(after.balance);
  });

  it('refuses a debit larger than the available balance', async () => {
    const { merchantUserId } = await onboard('09121110005', '610433789012777');
    const api = services();
    await api.wallet.ensure(merchantUserId);

    await expect(
      api.wallet.debit({
        merchantUserId,
        amount: 1_000_000,
        type: 'ADMIN_DEBIT',
        description: 'overdraft attempt',
        idempotencyKey: `overdraft-${newId('req')}`,
        createdBy: 'test',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_WALLET_BALANCE' });

    const snapshot = await api.wallet.snapshot(merchantUserId);
    expect(snapshot.balance).toBe(0);
  });
});
