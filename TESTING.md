# Testing

```bash
npm test              # everything
npm run test:watch
npx vitest run tests/pure-domain.test.ts
npm run check         # typecheck + lint + test + build
```

---

## Why the tests run inside workerd

The suite uses the Vitest Workers pool: tests execute in the real Workers runtime against a real D1
database, with the real migration SQL applied. Nothing is mocked.

That is a deliberate cost. A mocked database would be faster and would pass trivially — and it would
also prove nothing, because the correctness of this system lives in things a mock does not have:

- a **partial unique index** (`WHERE status IN (...)`) that cannot be expressed in a fake
- `CHECK` constraints that reject a `REAL` in an `INTEGER` column
- `BEFORE UPDATE`/`DELETE` triggers that make a table append-only
- `INSERT ... ON CONFLICT DO NOTHING RETURNING` semantics
- `db.batch()` atomicity, which the wallet's ledger-plus-balance write depends on
- the actual workerd globals: `crypto.subtle`, `TextEncoder`, the fetch pipeline

`tests/setup.ts` applies `migrations/` and `seeds/` once before the run via `applyD1Migrations`, so
every test exercises the exact SQL production will run.

---

## Suites

### `tests/pure-domain.test.ts` — 27 unit tests

The pure modules, where the brief's non-negotiables live. Fast, unambiguous, and each failure points
at one function.

| Area | What it pins down |
|---|---|
| Money | Toman↔Rial is exactly ×10; large amounts stay exact; no float; `isSafeToman` |
| Parsing | Persian digits (`۰-۹`), Arabic-Indic digits (`٠-٩`), separators `,` `٬`; a decimal amount is **rejected**, not truncated |
| Formatting | Arabic thousands separator U+066C and Persian digits on output |
| Fees | CUSTOMER adds to the base, MERCHANT takes from the wallet and leaves the base alone; percentage fees floor; wallet reserve is mode-aware; an unknown mode throws |
| Unique amount | never below base, always distinct, a full-span run is a permutation of the suffix space, the stride is coprime with the span, over-requesting is reported rather than truncated |
| Digits | script conversion, separator handling, `digitsOnly` returns null on a decimal point |
| Cards | Luhn check digit computed and verified, wrong digit rejected, wrong length rejected, masking never returns the full number |
| State machine | legitimate transitions allowed, terminal states not reopened, **`MANUAL_REVIEW` keeps its claim on the amount**, status bucketing |
| Jalali | known Nowruz dates, a leap year's last day, the leap-year series, and a **round-trip of every day across four years** |

The Jalali tests are not decoration. An earlier version used the common `((year + 38) * 31) % 128 < 31`
shortcut, which calls 1403 a common year; the calendar makes it leap, so every date from 1404 onward
was a day early. That shifts a bank SMS outside the matching window and a real transfer goes
unmatched. The round-trip test cannot catch a rule that is self-consistent but wrong — the Nowruz and
leap-year assertions are what catch that.

### `tests/acceptance.test.ts` — 3 tests, the §78 flow

Drives the **deployed Worker** through `SELF`, so every request passes through the real entry point,
router, middleware, security headers, service layer and database.

```
register (real CSRF token from the rendered form)
  → assert the account is PENDING_APPROVAL and cannot use the API
  → admin approves
  → API key issued; assert the raw key is NOT in the database and the stored hash is a peppermint HMAC
  → bank card added
  → makePayment: fee computed, payable ≥ base, Rial == Toman × 10
  → same Idempotency-Key replays the same invoice; a different body is 409; exactly one row exists
  → payment page: Toman amount, Rial amount, §74's exact-amount instruction, full card number,
    countdown and poll hooks present, noindex, no Turnstile origin in the CSP
  → bank SMS (Persian digits) → CONFIRMED, correct invoice, correct reference
  → status PAID, transaction row matches, audit log has the approval and the key creation
  → the same SMS forwarded again → DUPLICATE, still exactly one transaction
```

It also asserts that `/register` ships **no** `<script>` tag at all (nothing on that page is
interactive, and an inline block would be blocked by the CSP), that the payment page references
`/assets/client.js`, and that unauthenticated and invalid-key API calls return JSON error envelopes
with a request ID rather than an HTML page.

### `tests/concurrency.test.ts` — 6 tests

The tests that justify the schema. Real parallel requests.

| Test | Assertion |
|---|---|
| 100 simultaneous `makePayment` | **100 distinct payable amounts**; every amount = base + a suffix in range; the database agrees, with `COUNT(*) = COUNT(DISTINCT payable_amount) = 100` |
| 20 simultaneous requests with one `Idempotency-Key` | every response is `200` or `409`; exactly **one** invoice and **one** key row exist |
| Rate limiting | 70 requests in a minute produce 429s carrying `Retry-After`, `RATE_LIMITED` and a request ID |
| Duplicate card | adding the same card twice is `CARD_DUPLICATE`, not a database error |
| Fee once per invoice | `chargeFee` twice on one invoice applies once; the ledger has exactly one `PAYMENT_FEE` row; `net(ledger) === balance` |
| Debit beyond balance | `INSUFFICIENT_WALLET_BALANCE`, and the balance is untouched |

For the 100-request test the rate limit is deliberately raised first — the default ceiling of 60/min
is asserted by its own test above, and the subject here is the amount allocator.

The duplicate-card test also covers a bug class worth naming: `translate()` in `src/db/client.ts`
wraps a constraint violation in an `AppError`, keeping the driver text in `cause`. The
`isUniqueViolation` family therefore walks the `cause` chain. Without that, every constraint check
silently returns false and callers fall through to their generic error path instead of their retry
or duplicate branch — which breaks the unique-amount retry loop, duplicate bank-reference detection
and double-fee prevention at once.

---

## Schema invariants

```bash
node scripts/verify-schema.mjs
```

Not part of `npm test`, because it needs plain Node rather than workerd. It applies the migrations to
a real SQLite database and runs 30 adversarial statements, printing what the database allowed and
what it blocked. Run it after any migration change.

It is the check that the *schema* is right, where the Vitest suite checks that the *code* is.

---

## What is not covered yet

Named so the gap is a decision rather than a surprise:

- **Webhook delivery and retry.** `WebhookService.attemptDelivery` and the backoff schedule have no
  test. The signing and verification logic in `src/core/crypto.ts` is also untested.
- **SMS parser fixtures per bank.** The parser is exercised end to end through the acceptance test
  with one realistic Persian message, but there is no fixture table covering each bank template, and
  no cross-bank rejection test (that every fixture matches its own template and no other). This is
  the highest-value gap: a too-loose template silently steals another bank's messages and the symptom
  is a wrong amount rather than an error. See [SMS_PARSERS.md](./SMS_PARSERS.md#adding-a-bank).
- **Manual review** — the admin confirm/reject path, and specifically that a `MANUAL_REVIEW` invoice
  keeps its exclusive claim on its amount while under review.
- **Security suite** as its own file: replay attack, expired invoice paid late, SQL injection and XSS
  payloads through every text field, privilege escalation between roles.
- **Telegram notifications** — the dedupe and cooldown logic in `notification_log`.
- **Cron jobs** — invoice expiry releasing amounts and wallet reservations, wallet reconciliation.
- **Dashboard and admin routes**, which do not exist yet.

---

## Conventions

- **Assert the reason, not just the outcome.** `expect(outcome, \`parse was ${JSON.stringify(parse)}\`)`
  prints what was actually parsed, so one run tells you what to fix.
- **Compute values rather than hard-coding them.** The Luhn-valid card is derived in the test, and
  the expected formatted amounts come from the same money module the app uses. A test that restates
  a constant only proves the constant was copied twice.
- **Test the negative.** Every happy-path test has a counterpart: a decimal amount is rejected, a bad
  signature fails, a debit beyond the balance is refused, an inline script is absent.
- **Comments explain why the assertion exists**, particularly where a wrong-looking expectation is
  actually correct (Rial is grouped with U+066C; the register page genuinely has no script tag).
