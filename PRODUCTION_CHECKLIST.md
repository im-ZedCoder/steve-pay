# Production checklist

Walk this before taking real money. Each item states what to run or check and what "done" looks
like — a checklist whose items cannot fail is not a checklist.

---

## 1. Build and tests

- [ ] `npm ci` — clean install from the lockfile
- [ ] `npm run typecheck` — **0 errors**
- [ ] `npm run lint` — **0 errors**
- [ ] `npm test` — all suites pass
- [ ] `node scripts/verify-schema.mjs` — **30/30 invariants hold**
- [ ] `npm run build` — succeeds; note the gzip size and confirm it is well inside the plan's limit
      (currently ~84 KiB gzip)

## 2. Infrastructure

- [ ] Production D1 created; its ID written into **both** `wrangler.jsonc` and
      `wrangler.worker.jsonc` — one database, two readers, and they must name the same one
- [ ] KV namespace created and bound in both files too
- [ ] `steve-pay-webhooks` and `steve-pay-webhooks-dlq` queues created
- [ ] `wrangler.jsonc` declares the queue **producer** and `wrangler.worker.jsonc` the
      **consumer**. A producer with no consumer is a queue that grows
- [ ] No `REPLACE_WITH_*` placeholder remains in either config
- [ ] The Pages project exists and the companion Worker is deployed

```bash
grep -n 'REPLACE_WITH' wrangler.jsonc wrangler.worker.jsonc   # must print nothing
npx wrangler pages project list
```

## 3. Secrets

- [ ] `SESSION_SECRET`, `API_KEY_PEPPER`, `WEBHOOK_SECRET` each independently generated with ≥ 48
      bytes of randomness
- [ ] None of them is a development placeholder, and none is reused between environments
- [ ] Stored as Wrangler secrets, not in `wrangler.jsonc` and not in the repo
- [ ] Present on **both** projects, and the site deployed **after** they were set — Pages bakes
      the environment into each deployment, so a running deployment keeps the variables it was
      built with. `npm run deploy:verify` fails if any of the three is missing from the Pages
      project
- [ ] `/dashboard` and `/admin` answer `302` to `/login`, not `500`. A missing secret serves
      every public page and fails closed on these two, which is the shape to recognize

```bash
git log --all -p -- .env .dev.vars 2>/dev/null | grep -iE 'secret|pepper|token' | head
```

Rotating these later is destructive: `API_KEY_PEPPER` invalidates every issued API key, and
`SESSION_SECRET` logs everyone out. Decide who holds them before launch, not after.

- [ ] `TURNSTILE_SECRET` set **if** Turnstile is enabled, and `TURNSTILE_SITE_KEY` matches that widget
- [ ] `SMS_IP_ALLOWLIST` set if forwarders have stable egress addresses
- [ ] `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_ID` set if Telegram alerts are wanted

## 4. Database

- [ ] `npm run db:migrate:remote` — reports nothing pending afterwards
- [ ] `npm run db:seed:remote` — default settings present
- [ ] `SELECT COUNT(*) FROM system_settings` returns the expected number
- [ ] A scheduled/point-in-time backup is enabled **and a restore has actually been rehearsed**
      (`DATABASE.md` → Backup and recovery). An untested backup is a hypothesis.
- [ ] `npm run backup:export` produces a JSON export and its `.sums.txt` says *All wallets reconcile*

## 5. Admin access

- [ ] `npm run admin:create -- --remote` created exactly one `SUPER_ADMIN`
- [ ] That admin has logged in at `/login?scope=admin` and changed the bootstrap password
- [ ] No other `ADMIN`/`SUPER_ADMIN` row exists that nobody recognises

```sql
SELECT id, mobile, role, status, created_at FROM users WHERE role != 'MERCHANT';
```

- [ ] 2FA decided. It is opt-in and the architecture supports it; for a `SUPER_ADMIN` on a platform
      that approves merchants, enable it.

## 6. Platform settings

Review each of these against your business decisions rather than accepting the defaults:

- [ ] `gateway.fee_toman` — the actual fee
- [ ] `gateway.fee_mode_default` — `CUSTOMER` or `MERCHANT`
- [ ] `fees.suffix_remainder_belongs_to` — who keeps the uniqueness suffix
- [ ] `unique_amount.suffix_digits` — 3 or 4 (4 recommended: a 9,000-wide space instead of 900)
- [ ] `invoices.expiry_minutes_min` / `_max` / `_default` — 15–60, default inside that range
- [ ] `invoices.min_amount_toman` / `_max_amount_toman`
- [ ] `invoices.max_live_per_merchant` — how much each merchant may hold open
- [ ] `wallet.low_balance_threshold_toman` and `wallet.notification_cooldown_minutes`
- [ ] `wallet.auto_disable_invoice_creation` — keep `true` unless you want merchants to go negative
- [ ] `security.session_ttl_hours`, `security.admin_session_ttl_hours`, `security.max_failed_logins`,
      `security.lockout_minutes`
- [ ] `rate_limit.*` — sanity-check every ceiling against expected traffic
- [ ] `matching.min_confidence_auto_confirm` and `matching.auto_confirm_enabled`
- [ ] `matching.time_window_minutes_before` / `_after`
- [ ] `matching.require_card_match` — `false` by default; turn on if merchants commonly share cards
- [ ] `maintenance.invoice_creation_disabled` — **`false`**
- [ ] `platform.registration_enabled` — decide whether open registration is acceptable at launch
- [ ] `platform.turnstile_required` — **`true`** for open registration

## 7. Domain and TLS

The project ships with no hostname configured, so the first deployment is already live on its
`<project>.pages.dev` address and every link it generates points there. A custom domain is a
Cloudflare step, not a code change — nothing needs redeploying when you attach one:

```bash
npm run cf:setup -- --env production --domain pay.example.com --only pages,domain --yes
```

- [ ] The `*.pages.dev` address serves the platform and `/health` answers
- [ ] For a custom domain: its zone reports `active` in the account. An attached domain whose
      zone is still `pending` sits at `status: pending` and resolves nothing, which reads as a
      broken deployment and is a nameserver at the registrar
- [ ] The DNS record exists — `CNAME <host> → steve-pay.pages.dev`, proxied. Attaching the domain
      without it leaves `verification_data.error_message: "CNAME record not set"` and every
      request answering Cloudflare error 1016, and this is the half that gets missed
- [ ] `verification_data.status` is `active` and the certificate is issued — this is what
      `--domain` waits for, and `pending` after five minutes means the certificate, not a
      missing step
- [ ] The `www` host resolves, or is set to redirect to the apex
- [ ] Every generated link follows the host it is served on: open a payment page on both hosts and
      compare the invoice URL in the status response
- [ ] Old hostnames do not keep serving the platform — remove the previous custom domain if this
      is a move, or set an origin rule to redirect it
- [ ] HSTS is being sent with `preload` on the production host. It is sent only when the
      deployment is production **and** the request arrived over HTTPS, so a plain-HTTP host sends
      nothing — check the header on the HTTPS host, not on `localhost`
- [ ] Enabling the preload list is a real commitment — do it only when every subdomain you will ever
      need is HTTPS

```bash
HOST=https://your-domain.example   # or the *.pages.dev address
curl -sI "$HOST/" | grep -iE 'strict-transport|content-security|x-frame'
curl -s "$HOST/health"
```

- [ ] `/health` returns `200` with `"status":"ok"` and `database.status: "ok"`
- [ ] An uptime monitor polls `/health` and alerts to a channel someone reads
- [ ] `robots.txt` is served and disallows `/pay/`, `/status/`, `/api/`, `/dashboard/`, `/admin/`

## 8. End-to-end smoke test with a real payment

Do this with a small real amount. It is the only step that proves the whole thing.

- [ ] Register a test merchant through the real form
- [ ] Approve it from the admin account
- [ ] Add a real bank card
- [ ] Set the fee mode and expiry
- [ ] Configure the callback URL to a real endpoint you control
- [ ] Run the SMS pipeline test → **SMS Pipeline: Connected**
- [ ] Call `makePayment` with a small amount
- [ ] Open the payment page on an actual phone, on mobile data (not wifi)
- [ ] Transfer the **exact** amount, including the suffix
- [ ] The page flips to success without a manual refresh
- [ ] The bank's message appears on the receipt, correctly redacted
- [ ] The webhook arrived, the signature verified, `X-SteveGate-Delivery` present
- [ ] The Telegram notification arrived
- [ ] The transaction appears in the admin console with a matching bank reference
- [ ] The audit log contains every step

Then the negative paths:

- [ ] Forward the same SMS again → `DUPLICATE`, no second transaction
- [ ] Send a SMS for an amount no invoice has → `NO_MATCH`
- [ ] Let an invoice expire, then pay it → `MANUAL_REVIEW`, never auto-confirmed
- [ ] Create an invoice with `MERCHANT` fee mode on an empty wallet → `INSUFFICIENT_WALLET_BALANCE`
- [ ] Retry a `makePayment` with the same `Idempotency-Key` → the same invoice, `Idempotent-Replay:
      true`
- [ ] Call the API with no key → `401 UNAUTHENTICATED` as JSON
- [ ] Call with an `sk_test_` key against a live invoice → `API_KEY_ENVIRONMENT_MISMATCH`

## 9. Observability

- [ ] Observability enabled in both configs, and both log streams are readable. They are two
      deployments, so there are two tails: the site's Functions and the companion Worker

```bash
npx wrangler pages deployment tail --project-name steve-pay --format pretty
npx wrangler tail -c wrangler.worker.jsonc --format json | grep '"surface":"cron"'
```

- [ ] Cron firing: the 2-minute expiry job and the 15-minute retry job both visible in the tail
- [ ] Log lines include `requestId`, so a merchant's quoted ID can be traced end to end
- [ ] An alert exists for `route.unhandled`, `config.insecure_defaults` and
      `payment_event.webhook_enqueue_failed`
- [ ] `config.insecure_defaults` **never** appears in production logs (it means a secret fell back to
      a placeholder)

## 10. Security review

- [ ] `CONTENT_SECURITY_POLICY` is the strict one — `script-src 'self'` with **no** `'unsafe-inline'`
- [ ] `/assets/client.js` is served with `cache-control: immutable` and `nosniff`
- [ ] Copy buttons, countdown and status polling **work in a real browser** with the strict CSP
      (an inline script would be silently blocked — this is the single easiest thing to break)
- [ ] Session, CSRF and API cookies are `Secure`
- [ ] Registration and login are rate-limited and CSRF-protected
- [ ] Rotating an API key works, and the old key stops working immediately
- [ ] Suspending a merchant stops their API calls immediately, not just their dashboard
- [ ] No secret appears in any response body, log line or export
- [ ] `/pay/:id` is `noindex` and not reachable from any public link

## 11. Operations readiness

- [ ] You know how to roll back each half. The site rolls back in the dashboard (Workers & Pages
      → your project → Deployments → Rollback), or by re-running `npm run deploy` from the last
      good commit; the companion Worker rolls back with
      `npx wrangler rollback <id> -c wrangler.worker.jsonc`
- [ ] You know that rollback reverts code and **not** data, and that migrations must therefore be
      backward compatible for one release
- [ ] Support has the escalation path: `requestId` → logs → audit log
- [ ] The manual-review queue is checked by a named person on a schedule, not "when noticed"
- [ ] Someone owns the wallet reconciliation report from the daily cron job
- [ ] Documentation reviewed: `ARCHITECTURE.md`, `API.md`, `SECURITY.md`, `SMS_PARSERS.md`,
      `WEBHOOKS.md`
- [ ] Legal: terms, privacy policy and refund policy published, and matched to what the platform
      actually does with bank SMS data

---

## Known gaps at launch

Be deliberate about these rather than discovering them (full list in
[ARCHITECTURE.md](./ARCHITECTURE.md#known-gaps)):

- `/dashboard/*` and `/admin/*` routes are **not mounted**. The services, permissions and UI
  components exist, but operator actions are reachable only through the service layer. Merchant
  approval and manual review currently need either those routes built or direct service access.
- The setup wizard and full-pipeline test have no HTTP surface.
- SMS parser coverage is one realistic message end to end, with no per-bank fixture table.
- Webhook delivery and retry have no test suite, despite being on the critical path for merchants.

Decide which of these block launch **before** the smoke test, because the smoke test exercises
approval and manual review.
