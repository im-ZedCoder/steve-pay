# Steve Pay

A card-transfer payment gateway for Iranian banks, running entirely on Cloudflare's edge.

A merchant calls `makePayment`, Steve Pay allocates a **unique payable amount** and returns a
payment page. The customer transfers that exact amount to the merchant's bank card. The
merchant's phone forwards the bank's confirmation SMS to `POST /sms`. Steve Pay parses it,
matches it to the invoice, confirms the payment, and calls the merchant back over a signed
webhook.

There is no card processor, no acquiring bank integration and no card data — the money moves
by bank transfer and the confirmation signal is the bank's own SMS.

---

## Why it is built this way

**The unique amount is the matching key.** Two invoices for 500,000 Toman cannot both be live,
because the second gets 500,171. That is what lets an incoming bank SMS be attributed to one
invoice with no reference number, no account number and no cooperation from the bank. The
guarantee is a partial unique index in SQLite, not an application check — see
[ARCHITECTURE.md](./ARCHITECTURE.md#the-unique-amount-is-a-database-invariant).

**Confirmation is separate from notification.** `confirmPayment` commits and returns. The
webhook is enqueued afterwards. A merchant whose endpoint is down cannot cost themselves a
payment, and a failing callback cannot roll back a successful one.

**Money arithmetic is integer-only, everywhere.** Amounts are integer Toman; Rial is `× 10`.
There is no float in any financial path, and the type system carries a branded `Rial` so the
two units cannot be silently interchanged.

---

## Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Cloudflare Workers | Edge latency, no VPS to run |
| HTTP | Hono | Tiny, typed router; no framework runtime on the client |
| Database | Cloudflare D1 (SQLite) | Real ACID transactions and real unique indexes |
| Queue | Cloudflare Queues | Webhook delivery must not block confirmation |
| Cron | Cloudflare Triggers | Expiry, retries, reconciliation, cleanup |
| Frontend | Server-rendered HTML + ~3 KB of vanilla JS | The payment page is opened on a phone with a poor connection |
| Tests | Vitest + Workers pool | Tests run in workerd against real D1, not against mocks |
| Validation | Zod | Used where a schema is genuinely declarative |

---

## What works today

The complete money path is implemented, wired and verified end to end:

```
register → admin approves → API key → bank card → makePayment → payment page
        → bank SMS → parse → match → risk → confirm → status PAID → duplicate protection
```

And the operator's half of the same story, from a flagged payment to a released one:

```
unrecognised bank SMS → match → risk declines → queue → operator reads the message
                     → confirms → PAID → fee charged → callback → audit trail
```

Verified by `tests/acceptance.test.ts` and `tests/admin-console.test.ts`, which drive the real
Worker through `SELF` and the real D1 database. Neither file calls a service to reach a state it
is asserting about.

**Implemented and mounted**

- `GET /` — landing page
- `GET /pay/:invoiceId`, `/pay/:invoiceId/success`, `/pay/:invoiceId/expired` — payment page
- `GET /status/:invoiceId` — polling endpoint for the payment page
- `GET|POST /register`, `GET|POST /login`, `POST|GET /logout` — session auth with CSRF
- `POST /api/v1/payments` — `makePayment` with `Idempotency-Key`
- `GET /api/v1/cards`, `/api/v1/status`, `/api/v1/wallet`, `/api/v1/transactions/count`
- `POST /sms` — SMS forwarder intake
- `GET /health` — liveness with a database probe
- `GET /robots.txt`

**Operator console** — `/admin` (overview, revenue, health), `/admin/users` (search and status
filters), `/admin/users/:id` (lifecycle actions, one-time API key reveal, wallet adjustment,
setup progress, ledger and key history), `/admin/review` (the manual-review queue, with the
bank message as evidence), `/admin/invoices`, `/admin/revenue`, `/admin/audit-logs`.

**Implemented as services and pure modules, not yet mounted**

- `/dashboard/*` — the service layer, permissions model and UI component library exist
  (`src/services/merchants.ts`, `src/ui/layout.ts`); only the request/render layer is missing.
  Until it is mounted, operator actions are the only way to reach a merchant account.
- `/telegram/webhook` — `TelegramService.registerWebhook` and `parseUpdate` exist.
- `/docs/api` — the documentation page.

**Verified invariants**

- 30 database-level financial invariants (`node scripts/verify-schema.mjs`)
- 48 tests: acceptance, operator console, concurrency, and pure-domain unit tests
- 100 simultaneous `makePayment` requests produce 100 distinct payable amounts
- A repeated `Idempotency-Key` produces exactly one invoice

---

## Quick start

```bash
npm install
npm run dev          # applies fonts + assets, then wrangler dev
```

The first run needs a local database:

```bash
npm run db:migrate:local
npm run db:seed:local
```

Then open <http://localhost:8787>.

### Checks

```bash
npm run typecheck    # tsc --noEmit, strict
npm run lint         # eslint
npm test             # vitest, real workerd + real D1
npm run build        # wrangler deploy --dry-run
npm run check        # all four
```

### Schema

```bash
node scripts/verify-schema.mjs   # proves the 30 financial invariants hold
```

---

## Configuration

Secrets are never committed. See [.env.example](./.env.example) for the full list and
[DEPLOYMENT.md](./DEPLOYMENT.md) for how to set them per environment.

The three that matter operationally are `SESSION_SECRET`, `API_KEY_PEPPER` and
`WEBHOOK_SECRET`. In production their absence is fatal at request time — the platform fails
closed rather than falling back to a development value.

---

## Documentation

| Document | Covers |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | The design decisions and why they were made |
| [API.md](./API.md) | Every endpoint, request, response and error code |
| [DATABASE.md](./DATABASE.md) | Schema, indexes, triggers and invariants |
| [SECURITY.md](./SECURITY.md) | Threat model and controls |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Cloudflare setup, secrets, migrations, domains |
| [SMS_PARSERS.md](./SMS_PARSERS.md) | How bank messages are parsed and how to add a parser |
| [WEBHOOKS.md](./WEBHOOKS.md) | Callback format, HMAC verification, retries |
| [TESTING.md](./TESTING.md) | What is tested and how to run it |
| [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) | The list to walk before going live |

---

## Layout

```
src/
  core/          pure domain: money, digits, jalali, card, fees, unique-amount,
                 state-machine, matching, risk, crypto, errors, validation, csrf
  core/sms/      parser library: templates, extractors, parsers, redaction
  services/      one module per bounded context; all business logic lives here
  routes/        thin request/validate/call/render layer + the service container
  ui/            design system, document shell, page renderers
  db/            D1 client with constraint-aware error translation
  queue/         webhook delivery consumer
  cron/          scheduled jobs
  obs/           structured logging
migrations/      SQL, applied by wrangler d1 migrations
seeds/           settings seed
tests/           Vitest suites (run inside workerd)
scripts/         font sync, asset build, schema verification
```

**Conventions**

- Business logic lives in `services/`, never in a route or a page renderer.
- Financial values are only ever computed server-side. A client may send `amount` (what to
  charge) and choices that do not change arithmetic (fee mode, card, expiry).
- Every response carries a request ID; every sensitive action is audited.
