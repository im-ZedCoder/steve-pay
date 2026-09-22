# Security

## Threat model

This is a payment gateway holding other people's money and other people's API credentials. Four
questions decide the design:

1. **Can someone make money appear without money arriving?**
2. **Can someone make the same money count twice?**
3. **Can someone reach another merchant's money or data?**
4. **Can someone extract a credential from the system?**

Everything below is organised around those.

---

## 1. Making money appear without money arriving

The confirmation decision is the highest-value target, because a bug there mints money.

### The server never trusts the client about money

The API accepts `amount` (what the merchant wants to charge) and choices that do **not** change
arithmetic (`feeMode`, `cardId`, `expiresInMinutes`). It never accepts a fee, a payable amount, an
invoice status, a wallet balance or a merchant identity. Every financial value in a response was
computed by the server.

`feeMode` is safe to accept because it changes *who pays*, not *how much* — and the amount itself
comes from configuration, never from the request.

### The SMS body is evidence, not a claim

`POST /sms` carries a message. It is parsed. Nothing in the payload about the invoice, the amount
owed or whether a payment happened is believed. A forwarder cannot assert "invoice X is paid".

### A payment must satisfy several conditions, not one

The matching engine scores signals rather than testing `amount === invoice.amount`:

| Signal | Weight |
|---|---|
| Exact amount | required |
| Invoice active | required |
| Bank reference unused | forbidden if used |
| Inside the time window | required |
| Sender recognised | preferred |
| Card match | preferred |

Below `matching.min_confidence_auto_confirm` (default 70), the payment goes to `MANUAL_REVIEW`
instead of being confirmed. An admin decides. Money is never released on a low-confidence guess.

### The database refuses the dangerous writes

A code path that forgets a check still cannot:

- give two live invoices the same amount (partial unique index)
- settle one bank reference twice (partial unique index)
- charge a fee twice (unique ledger idempotency key)
- drive a wallet negative (`CHECK` constraints)
- rewrite the ledger or the audit log (append-only triggers)

---

## 2. Counting the same money twice

Three independent layers, so no single mistake is sufficient:

1. **Message level** — `sms_messages.message_hash` is unique per merchant, so a re-forwarded SMS is
   recognised before any matching happens.
2. **Reference level** — `ux_transactions_bank_reference` means a bank reference settles exactly one
   transaction platform-wide. If a message-level dedupe were bypassed, this still holds.
3. **Request level** — `Idempotency-Key` on `makePayment`, claimed with a single atomic
   `INSERT ... ON CONFLICT DO NOTHING RETURNING`.

The confirmation path itself is guarded by the invoice state machine: confirming an already-`PAID`
invoice is `ALREADY_PAID`, not a second settlement, and terminal states cannot be reopened.

---

## 3. Reaching another merchant's money or data

### Authentication

- **Sessions** — HttpOnly, Secure, SameSite=Lax cookies. The token is hashed before storage, so a
  database read does not yield a usable session. Logout revokes server-side; deleting a cookie is
  not logout.
- **Login** — every attempt recorded, including for unknown mobiles. After
  `security.max_failed_logins` (8), the account locks for `security.lockout_minutes` (15). Unknown
  account and wrong password return the same error, so the response does not reveal which mobile
  numbers exist.
- **API keys** — `X-API-Key` or `Authorization: Bearer`. The prefix (`sk_live_` / `sk_test_`) fixes
  the environment, so a test key cannot create live invoices.
- **Admin sessions** are shorter by default (12 hours vs 168), because a stolen admin cookie is
  worth much more.

### Authorisation

Every machine request passes `authenticateMachine`, which verifies the key, checks the endpoint's
scope against the key's scopes **as stored in the database**, and then checks the *account status*.

That last step is what makes suspension real: an API key outlives the account state it was issued
under, so suspending a merchant must stop their `makePayment` calls immediately rather than merely
hiding their dashboard. The error is specific (`ACCOUNT_SUSPENDED` vs `ACCOUNT_PENDING_APPROVAL`)
so a merchant can tell which conversation they are having.

### Isolation

Every service method takes a `merchantUserId` and every query filters on it. There is no
"get invoice by ID" that any authenticated merchant can call — the machine API only ever reads the
caller's own records. The public payment page is addressed by invoice ID, which is the capability
by design (that is how a payment link works), and discloses only what a payer needs.

### Injection

All SQL uses bound parameters through `src/db/client.ts`. There is no string interpolation of user
input into a query anywhere. Table and column names are never derived from input.

HTML is escaped through a single `escapeHtml` used by every renderer. **The CSP forbids inline
script entirely**, so even an escaping bug that slips through cannot execute — that is the reason
the page's own script is served as an external file rather than inlined.

---

## 4. Extracting a credential

### Storage

| Secret | Storage | Why |
|---|---|---|
| Passwords | PBKDF2-SHA256, 210,000 iterations, per-user salt | Low entropy, needs key stretching |
| API keys | Peppered HMAC-SHA256 | Full 32-byte entropy; stretching buys nothing, constant-time comparison is what matters |
| Session tokens | Hashed before storage | A DB read must not yield a usable session |
| Webhook secrets | Sealed with AES-GCM via HKDF from `WEBHOOK_SECRET` | Must be recoverable to sign, so sealed rather than hashed |
| TOTP secrets | Sealed | Opt-in 2FA |

The full API key is returned **exactly once**, at creation. It cannot be recovered afterwards.

### Exposure

- API keys, webhook secrets and session tokens are never logged. The Telegram bot token lives in a
  URL path, so only the endpoint name and status are logged on failure.
- Public error responses never include a stack trace.
- SQLite constraint text is kept in `cause` for the log and never serialised into a response body.
- The success page shows the bank's SMS **redacted**: the balance sentence is removed outright, and
  card numbers keep only their ends. Redaction happens in the service that owns the raw message, so
  no renderer can leak it.
- PII is minimised: card numbers are the merchant's own receiving cards, which are public by
  necessity, with `number_hash` for duplicate detection so hashes are never exposed.

### Replay

- **Inbound**: `Idempotency-Key` (24-hour window), SMS message hash, bank reference.
- **Outbound**: every webhook carries `X-StevePay-Timestamp` and `X-StevePay-Delivery`. The
  signature covers the timestamp, so a captured request cannot be replayed later; merchants should
  reject a timestamp outside a few minutes.

---

## Transport and browser headers

Applied to every response, including errors and 404s, by one middleware — a header policy set only
on the happy path is a hole, not an oversight.

```
Content-Security-Policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self';
  connect-src 'self'; form-action 'self'; frame-ancestors 'none';
  base-uri 'none'; object-src 'none'
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()
Cross-Origin-Opener-Policy: same-origin
```

Two notes:

- `style-src` needs `'unsafe-inline'` because the payment page inlines its critical CSS to avoid a
  render-blocking round trip. `script-src` does **not**, and that is the one that matters.
- `frame-ancestors 'none'` blocks clickjacking, which is specifically relevant here: a payment page
  is a high-value target for an overlay attack that rewrites the visible amount.
- HSTS is only sent in production. On `localhost` or `*.workers.dev` it would break local
  development for two years in a way that is very hard to diagnose.

---

## CSRF

Double-submit cookie. The same token lives in a cookie and in a hidden field of every form; a POST
is accepted only if they match. An attacker's page can make the browser *send* the cookie but cannot
read it to fill in the field.

The CSRF cookie is deliberately **not** HttpOnly, because the setup wizard and dashboard issue some
requests from `fetch()`. That is safe: the cookie carries no authority alone, and the comparison is
constant-time against a hash.

SameSite=Lax on the session cookie already blocks the simplest cross-site form posts. CSRF tokens
are the second lock, so a future decision to relax SameSite cannot silently open a hole.

---

## Request forgery and open redirects

- `customCallback` and `returnUrl` are validated against the merchant's configured hosts and must be
  `https` in production (`CALLBACK_URL_NOT_ALLOWED` otherwise). This stops a merchant (or someone
  who compromised a merchant account) turning the gateway into an open redirector for phishing.
- Post-login `next` accepts same-origin **paths** only. `//evil.example` and `/\evil.example` are
  rejected, because browsers treat both as absolute URLs.
- Webhook delivery refuses loopback, link-local and private address ranges, so a merchant cannot
  point a callback at internal infrastructure.

---

## Abuse controls

- Rate limits on every public and machine surface (see [API.md](./API.md#rate-limits)).
- `POST /sms` supports an IP allowlist and enforces a 16 KB body cap.
- Turnstile is available for registration, switched on per environment from the settings table. Its
  origins are added to the CSP **only on the registration page** — widening `script-src` site-wide
  for one optional field would weaken every other page for no benefit.
- Registration is a gate, not a notification: a `PENDING_APPROVAL` account has no API key, no wallet
  and cannot create an invoice.

---

## Security events

Recorded to the audit log with `WARNING`/`CRITICAL` severity for admin alerting: repeated failed API
authentication, unusual SMS volume, excessive invoice creation, repeated callback failures,
unusual login activity, and any admin action on a wallet or an account's status.

Every sensitive admin action is audited with actor, target, request ID and metadata. `audit_logs`
is append-only at the database level.

---

## Reporting a vulnerability

Do not open a public issue. Send details to the address on the site, including a request ID if you
have one. Please do not test against merchant accounts you do not own, and do not run automated
scans that would consume a merchant's rate-limit budget.

---

## Deliberate trade-offs

Stated so they are decisions rather than oversights:

- **`style-src 'unsafe-inline'`** — accepted for critical CSS on the payment page. The alternative is
  a render-blocking request on the surface most sensitive to latency. CSS cannot exfiltrate a
  session or execute code.
- **Card numbers are stored in full.** They must be displayed to customers to complete a transfer, so
  they are not secrets in the way a PAN on a card-processing system is. Only the merchant's own
  receiving cards are stored, there is no cardholder data, and the platform is not in PCI scope.
- **The CSRF cookie is script-readable** — required for `fetch()`-based flows, and harmless because
  the cookie alone grants nothing.
- **Rate-limit counters cost database writes.** Accepted: a limiter that does not limit is worse than
  no limiter, because it is trusted.
