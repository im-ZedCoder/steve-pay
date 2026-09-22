# Architecture

This document explains the decisions that shape the system, particularly the ones where the
obvious approach is wrong.

---

## The problem, stated precisely

A merchant wants money. They cannot integrate with an acquiring bank; what they *can* do is put
a card number on a page and let the customer transfer to it from their own banking app. The
transfer arrives in the merchant's account, and the merchant's phone gets an SMS about it.

So the platform has to answer one question reliably: **which invoice did this SMS pay for?**

There is no reference number from the merchant's side, no account number, and the SMS format
differs per bank and per device. Everything below follows from taking that question seriously.

---

## The unique amount is a database invariant

The answer is the amount itself. Every live invoice gets an amount nobody else has:

```
original    359,000   what the merchant asked for
gateway fee   3,000   (CUSTOMER mode: added to what the customer pays)
base        362,000
suffix        1,706   unique among live invoices
payable     363,706
```

Two live invoices can never share a payable amount, because of this index:

```sql
CREATE UNIQUE INDEX ux_invoices_active_amount
  ON invoices(payable_amount)
  WHERE status IN ('CREATED','PENDING','PAYMENT_DETECTED','CONFIRMING','MANUAL_REVIEW');
```

**Why an index and not a check.** The naive implementation is "look for a free amount, then
insert". Between the look and the insert, another request can take the same amount, and no
amount of application-level care closes that window — a check-then-act race is a check-then-act
race. So the application never decides that an amount is free. It *tries to take one* and is
told no. The insert is the check.

**Why `MANUAL_REVIEW` is in the index.** This is the subtle part. A suspicious payment keeps its
claim on the amount. If it did not, the amount would be freed while the payment was still under
review — the next invoice would take it, and an admin confirming the review would settle the
wrong merchant's invoice. The amount stays claimed for as long as the invoice could still
become paid.

**Why candidates are not random.** `planUniqueAmounts` walks the suffix space with a stride
coprime to the span. The span for 4 digits is `9 × 10³ = 9,000`, whose only prime factors are
2, 3 and 5, so a stride coprime to it visits *every* value exactly once before repeating. A
sequence of `k` candidates is therefore guaranteed `k` distinct amounts. Random-and-retry
degrades badly under contention by re-rolling values it already knows are taken, and it cannot
promise coverage.

**Expiry frees the amount**, which is what makes reuse safe: an amount only becomes available
when its invoice can no longer be paid by the normal path.

See [DATABASE.md](./DATABASE.md) for the full invariant list.

---

## Money is never a float

All amounts are integers in Toman. Rial is `toman × 10`, never a stored second amount that could
drift. `Rial` is a branded type, so passing a Rial value where Toman is expected is a type error
rather than a 10× overcharge.

Parsing is where the danger actually lives. Bank SMS messages contain:

- Persian digits `۰-۹` (U+06F0–U+06F9)
- Arabic-Indic digits `٠-٩` (U+0660–U+0669)
- thousands separators as `,`, `٬` (U+066C) and sometimes `.`
- the word تومان or ریال, or neither

`parseTomanInput` normalises all of it. Critically, it **rejects** `363,706.50` rather than
truncating: stripping the separator turns `363.706` into `363706` and `3.637` into `3637` — a
silent ten- or hundred-fold misreading of a payment. Refusing is the only safe answer for a
value the platform did not generate.

The fee engine floors percentage fees rather than rounding, because rounding can push a fee above
what the merchant agreed to, whereas a floor can only ever under-charge by less than one Toman.

---

## Two records of money, each answering one question

An invoice with `fee_mode = 'CUSTOMER'` — the default, and the one the brief describes — is paid by
the payer *on top of* the amount. No wallet is debited, so no `PAYMENT_FEE` row is ever written.
That makes `wallet_ledger` structurally unable to answer "what did this payment earn", however
carefully it is queried. With `fee_mode = 'MERCHANT'` the fee is recovered from the wallet instead,
and the ledger does have a row.

So revenue and volume are read from the paid invoice, and only wallet movements come from the
ledger:

| Question | Source | Why |
| --- | --- | --- |
| Revenue, volume, paid counts | `invoices` (`settled_fee`, `net_amount`) | Written in the same statement that sets `status = 'PAID'`, so it is complete for both fee modes |
| Top-ups, balances owed to merchants | `wallet_ledger` | A wallet movement exists nowhere else |

`ReportingService.revenueSummary` is the single definition of the first row, and `adminOverview`
delegates to it, so the overview and the revenue page cannot disagree about the same day's takings.

One consequence is worth naming, because it makes a correct fee engine look broken: `settled_fee` is
the platform's *take*, not the published fee. A uniquely-suffixed amount leaves a remainder, and by
default the platform keeps it — so ten payments at a 3,000 Toman fee can recognise well over 30,000.
The revenue screen therefore says «درآمد» and names the composition rather than saying «کارمزد».

---

## Confirmation and notification are separate

```
SMS arrives
  → authenticate → parse → match → risk
  → confirmPayment()          ← commits. One transaction. Done.
  → announceConfirmedPayment() ← best effort, afterwards
       → enqueue webhook (own retry schedule)
       → send Telegram   (fire and forget)
```

The brief's rule is that a failing callback must never reverse a successful payment. The cheapest
way to guarantee that is structural rather than defensive: by the time anything tries to notify
anyone, the payment is already committed, and nothing in the notification path can throw into
the confirmation path. `announceConfirmedPayment` returns a summary; it never throws.

A merchant with no webhook endpoint configured gets `skipped: true` and still has a paid invoice.

---

## Idempotency is one statement

`makePayment` supports `Idempotency-Key`. The claim is:

```sql
INSERT INTO idempotency_keys (...) VALUES (...)
ON CONFLICT(merchant_user_id, idempotency_key) DO NOTHING
RETURNING id
```

- a row came back → we own the key, create the invoice
- no row → either the response is stored (replay it verbatim) or the work is still in flight (409)

A read-then-write would need a lock nobody can hold across a D1 round trip. Making the unique
index the arbiter means the database decides the winner and there is no window.

The same key with a *different* body is a 409, not a replay — answering with the first request's
result would hide a client bug, leaving the client believing it created the invoice it is now
looking at.

A failed request **releases** its claim, so the client's retry — the entire point of sending the
key — actually does the work.

---

## Rate limiting lives in D1, not KV

KV is eventually consistent. A burst of requests hitting different edge locations would each read
a stale count and the limit would leak exactly when it matters. So counters live in D1 in a
single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count`, which is atomic.

The trade-off is accepted deliberately: rate-limit writes cost database operations, and the
alternative is a limiter that does not limit.

Limits are per-identity and layered — a per-IP limit before authentication (cheap, stops an
unauthenticated flood) and a per-merchant limit after (catches a compromised key used from many
IPs). A 429 always carries `Retry-After`, `X-RateLimit-Limit` and `X-RateLimit-Remaining`,
because a bare 429 makes every well-behaved client retry immediately and turns a limit into an
outage.

---

## The payment page

The one screen a customer sees. It is server-rendered with no client framework, because a
framework runtime is the largest thing that would be on the page and the page has to render on a
phone on a bad connection.

- **Two font faces**, ~43 KB: Vazirmatn Arabic regular and bold. Latin text falls through to
  `system-ui`, which costs nothing.
- **~3 KB of JavaScript**, served as a cached static asset at `/assets/client.js`.
- It does three things: copy to clipboard, run the countdown against a server-provided absolute
  expiry, and poll `/status/:id` so the customer sees confirmation without refreshing.

**Why the script is a file and not inline.** The CSP is `script-src 'self'` with no
`'unsafe-inline'` — the correct policy, since it means injected markup cannot execute. But it also
means an inline `<script>` is *silently blocked by the browser*, with nothing in the server logs.
Copy buttons, countdown and polling would all stop working in production. `scripts/build-assets.mjs`
emits `CLIENT_JS` from `src/ui/theme.ts` to a static file so the policy stays strict and the script
still runs.

**Design.** Colour is money: each of the three accent hues is reserved for one financial state and
appears nowhere else. Amber means money is owed and time is running out; green means it arrived and
is confirmed. Nothing is tinted for decoration, so a colour on the screen always means something.
The base is `#060915` (blue-black, not neutral black) so the glass panels sit on banking
infrastructure rather than a void. The amount is set in tabular figures at display size, because
the exact figure is the thing a human must check digit by digit against their bank screen.

**The receipt shows the bank's own message**, redacted. It is the product's entire claim made
visible in one object: Steve Pay works by reading your bank's SMS, so here is the SMS it read.

Redaction happens in the layer that owns the raw message (`SmsService.publicConfirmationMessage`),
never at render time — so no future markup change can leak a card number or a balance. The raw
message is kept for audit and never returned.

---

## SMS intake order

```
1. IP allowlist (if configured)  reject before touching the database
2. rate limit by IP              a stuck forwarder hits this
3. API key                       prove identity
4. account status                prove they may still operate
5. rate limit by merchant        per-merchant ceiling, identity now known
6. body validation               shape, size, required field
7. ingest                        duplicate check → parse → match → risk → confirm
```

Cheap rejections first, database work last. The two rate limits sit at different points on
purpose: the IP limit stops an unauthenticated flood, and the merchant limit cannot run until
identity is known, where it catches a single key used from many addresses.

**Non-2xx means "not delivered"** to a forwarder, which will retry. So outcomes that mean "this
message will never be usable" — a wrong invoice, an unparseable body, a duplicate, a test token —
are `200` with an `outcome` field. Retrying cannot change the answer, and a retry storm against a
bank's SMS queue is worse than a silent no-op. Only an unparseable body is a `202`.

Nothing in the payload is trusted about the invoice, the amount owed, or whether a payment
happened. The message text is evidence to be parsed, not a claim to be believed.

---

## Defence in depth on the database

The system does not rely on application code to preserve financial invariants. Where a rule must
hold, it holds in SQL:

| Rule | Enforced by |
|---|---|
| No two live invoices share an amount | partial unique index |
| A bank reference settles exactly one transaction, platform-wide | partial unique index |
| A fee is charged at most once per invoice | unique idempotency key in the ledger |
| The wallet balance always equals the ledger sum | triggers + derived reads |
| Audit log and ledger rows are append-only | `BEFORE UPDATE`/`DELETE` triggers that raise |
| Rial is exactly ten times Toman | `CHECK` constraints |
| Terminal states cannot be reopened | state machine + `CHECK` on status |

`node scripts/verify-schema.mjs` proves all 30 of these against a real SQLite database.

One consequence worth knowing: `translate()` in `src/db/client.ts` wraps a constraint violation in
an `AppError`, keeping the driver text in `cause`. The `isUniqueViolation` family therefore walks
the `cause` chain. Without that, every constraint check silently returns false and callers fall
through to their generic error path instead of their retry or duplicate branch — which would break
the unique-amount retry loop, duplicate bank-reference detection and double-fee prevention at once.
`tests/concurrency.test.ts` covers this.

---

## Layers

```
routes/      thin: authenticate, validate, call ONE service, render. No business logic.
services/    all business logic. Owns transactions, audit writes and notifications.
core/        pure functions. No database, no clock, no network, no globals.
db/          D1 client, constraint-aware error translation.
ui/          design tokens, shell, page renderers. Pure functions of their input.
```

`core/` being pure is what makes the unit tests fast and unambiguous. `routes/` being thin is what
keeps the security decisions in one place per root.

**The service container** (`src/routes/container.ts`) assembles the object graph once per request
and memoises it on the request object. Two consequences: no handler can accidentally build a
second `SettingsService` and read a setting from a cold cache while another part of the same
request reads it from a warm one, and wiring is testable by passing a different `env`.

`resolveSecrets` is called per request, not at module load, so a misconfigured deployment fails
closed on every route rather than half-serving traffic from a partially initialised isolate.

---

## Cloudflare specifics

**D1 batch is a transaction.** D1 executes `db.batch([...])` as one transaction and rolls the whole
batch back if any statement fails. That is what lets the wallet ledger be written without an
interactive transaction: the ledger insert and the balance update go in one batch, and the ledger
insert's `SELECT` reads the balance it is about to change.

**Queues for webhooks.** Delivery is enqueued, so a slow merchant endpoint never delays a
confirmation. When the queue binding is absent (local development), delivery falls back to
`waitUntil`.

**Cron for the things that decay.** Invoice expiry every 2 minutes, webhook retries every 15,
daily reconciliation and cleanup.

**Two deployments, because Pages Functions are HTTP-only.** The application is a Pages project;
a Function has no `scheduled()` handler and cannot be a queue consumer, and this platform needs
both. So the cron triggers and the queue consumer live in a companion Worker
(`wrangler.worker.jsonc`) that binds the same D1 database and KV namespace — one dataset, two
readers, and no second object graph, because it runs the same entry point. The Worker has
`workers_dev: false` and no route, so it has no public address at all.

**The hostname is not configuration.** There is no `routes` block, no `custom_domain` and no base
URL variable anywhere. Each request's own origin is read from its URL and used for every absolute
link the platform generates, with the last-seen origin remembered in KV for the background work
that has no request to read from. That is why the same build answers on `localhost`, on
`*.pages.dev`, on a preview alias and on a custom domain attached later, with nothing to edit.

**Compatibility date.** Pinned to the newest date the bundled workerd supports. A date ahead of the
installed runtime makes `wrangler dev` and the Vitest Workers pool refuse to boot, which would mean
the test suite could not run against the same runtime configuration production uses.

---

## Known gaps

Stated plainly rather than left to be discovered:

- **The admin console does not cover every section of the brief.** Mounted: overview, revenue,
  merchants and their lifecycle actions, wallet adjustment, the manual-review queue, invoices, and
  the audit log. Not yet built: `/admin/transactions`, `/admin/wallets`, `/admin/tickets`,
  `/admin/notifications`, `/admin/webhooks`, `/admin/sms`, `/admin/settings`, `/admin/system-health`.
  The services behind all of them exist and are tested at the service layer; only the pages are
  missing, and the console's navigation deliberately links to nothing that is not built.
- **The merchant dashboard covers the account, not the whole brief.** Mounted: overview with a
  setup checklist, payments, payment detail, cards, API keys, the callback endpoint, fee mode,
  the SMS test token, notifications and the wallet ledger. Still missing: a merchant-side webhook
  delivery log, tickets, and self-service settlement reports.
- **The full-pipeline test has no HTTP surface.** `SmsService.issueTestToken` is reachable from
  the dashboard; the end-to-end pipeline run is service-layer only.
- **Telegram ownership verification** needs the webhook route mounted to complete the flow.
- **No percentage fee in the MVP**, though `percentageBasisPoints` is wired through the fee engine
  and tested.
- **Reports are read-only and queried live.** `ReportingService` runs indexed aggregates
  per request rather than reading a rollup table. That is the right trade at this volume — a rollup
  is one more thing that can silently disagree with its source table — but it is the first thing to change
  if the dashboard pages start showing up in slow-query logs.
- **CSV export is not implemented**, though `reports:export` is a permission and the report
  queries already return flat rows.
