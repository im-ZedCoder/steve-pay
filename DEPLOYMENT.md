# Deployment

Target: Cloudflare Workers with a custom domain, D1, KV, Queues and Cron Triggers. There is no VPS
and nothing to keep running.

---

## Prerequisites

- A Cloudflare account with `steve-pay.ir` on it
- Node 20+ (developed on 26)
- `npm install`

```bash
npx wrangler login
```

---

## 1. Create the resources

```bash
# Production
npx wrangler d1 create steve-pay
npx wrangler kv namespace create CACHE
npx wrangler queues create steve-pay-webhooks
npx wrangler queues create steve-pay-webhooks-dlq

# Staging
npx wrangler d1 create steve-pay-staging
npx wrangler kv namespace create CACHE --env staging
```

Each command prints an ID. Paste them into `wrangler.jsonc` where the placeholders are:

| Placeholder | Appears in |
|---|---|
| `REPLACE_WITH_PRODUCTION_D1_ID` | top-level `d1_databases`, `env.production` |
| `REPLACE_WITH_STAGING_D1_ID` | `env.staging` |
| `REPLACE_WITH_PRODUCTION_KV_ID` | top-level `kv_namespaces`, `env.production` |
| `REPLACE_WITH_STAGING_KV_ID` | `env.staging` |

Queues are referenced by name, so nothing to paste.

Set `BASE_URL` in `wrangler.jsonc` for staging to the real staging hostname.

---

## 2. Set secrets

Never commit secrets, and never reuse them across environments.

```bash
# Generate three independent high-entropy values
node -e "for (const k of ['SESSION_SECRET','API_KEY_PEPPER','WEBHOOK_SECRET']) console.log(k, require('crypto').randomBytes(48).toString('base64url'))"
```

```bash
npx wrangler secret put SESSION_SECRET --env production
npx wrangler secret put API_KEY_PEPPER --env production
npx wrangler secret put WEBHOOK_SECRET --env production
```

Optional, per feature:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN --env production
npx wrangler secret put TELEGRAM_ADMIN_CHAT_ID --env production
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --env production
npx wrangler secret put TURNSTILE_SECRET --env production
npx wrangler secret put SMS_IP_ALLOWLIST --env production   # "203.0.113.4,198.51.100.0/24"
```

### What happens if a secret is missing

`resolveSecrets` throws in production when any of the three required secrets is absent or shorter
than 16 characters. That is deliberate: the platform fails closed on every request instead of
half-serving traffic with a development placeholder. Non-production environments fall back to fixed
obvious placeholders so local data survives a restart — and log `config.insecure_defaults` at warn
so the mistake is visible in the deployment that has it.

Rotating `API_KEY_PEPPER` invalidates every issued API key. Rotating `SESSION_SECRET` logs everyone
out. Rotating `WEBHOOK_SECRET` requires re-sealing endpoint secrets — see
[WEBHOOKS.md](./WEBHOOKS.md).

---

## 3. Migrate and seed

```bash
npm run db:migrate:remote     # production
npm run db:seed:remote        # default settings

npm run db:migrate:staging    # staging
```

Verify the schema invariants before serving traffic:

```bash
node scripts/verify-schema.mjs
```

---

## 4. Create the first admin

There is no self-service admin signup, by design. The bootstrap script creates one:

```bash
npm run admin:create
```

It prompts for a mobile number and a password, hashes it with PBKDF2, and writes a `SUPER_ADMIN`
row. Run it against local D1 by default; pass `--remote --env production` for production.

Then:

1. Log in at `/login?scope=admin`
2. Change the password immediately if you generated one
3. Approve the first merchant and walk the setup wizard with them

---

## 5. Deploy

```bash
npm run deploy              # production
npm run deploy:staging      # staging
```

`deploy` runs the font sync and the asset build first, so `public/fonts/` and
`public/assets/client.js` are present. Both directories are gitignored: they are build outputs
derived from `node_modules` and `src/ui/theme.ts`.

`wrangler deploy` prints the upload size and the resolved bindings. Check both — a missing binding
is the most common deployment failure.

---

## 6. Domain

`wrangler.jsonc` already declares the production routes:

```jsonc
"routes": [
  { "pattern": "steve-pay.ir",     "custom_domain": true },
  { "pattern": "www.steve-pay.ir", "custom_domain": true }
]
```

Cloudflare creates the DNS records and certificates. `workers_dev` is `false` in production so the
`*.workers.dev` hostname does not serve the platform; staging sets it to `true`.

Once TLS is live, HSTS is sent with `preload`. Do not enable preload until you are certain every
subdomain you will ever need is HTTPS — it is a two-year commitment.

---

## 7. Cron Triggers

Already declared, and they are the reason the platform does not need a worker process:

| Schedule | Job |
|---|---|
| `*/2 * * * *` | Expire due invoices; release their unique amounts and wallet reservations |
| `*/15 * * * *` | Retry due webhook deliveries; re-enable or disable endpoints by failure count |
| `0 3 * * *` | Daily rollups, prune expired idempotency keys and sessions, reconcile wallets against the ledger |

Verify after deploying:

```bash
npx wrangler tail --env production --format json | grep '"surface":"cron"'
```

---

## 8. Turnstile

1. Create a widget in the Cloudflare dashboard for `steve-pay.ir`
2. Put the **site key** in `wrangler.jsonc` → `TURNSTILE_SITE_KEY` (it is public and ships to the
   browser)
3. Put the **secret** in `TURNSTILE_SECRET`
4. Enable it: set the `platform.turnstile_required` setting to `true`

Leaving `TURNSTILE_SITE_KEY` empty disables the widget entirely and the registration page renders
without it. When it is set, that page's CSP is widened to allow Cloudflare's challenge origins —
and only that page.

---

## 9. Observability

Workers Logs is enabled in `wrangler.jsonc` with full sampling. Every response carries a request ID,
and every log line includes it, so a merchant's quoted ID lines up with the logs.

```bash
npx wrangler tail --env production --format pretty
```

Health check for an uptime monitor:

```bash
curl -s https://steve-pay.ir/health
```

`{"status":"ok","checks":{"database":{"status":"ok",...}}}` with HTTP 200, or HTTP 503 and
`"status":"degraded"` if D1 is unreachable. `/health` requires no secret on purpose.

---

## 10. Backups

D1 has point-in-time recovery on paid plans. For a portable export:

```bash
npm run backup:export                       # writes ./backups
npx wrangler d1 export steve-pay --remote --env production --output ./backups/steve-pay.sql
```

`backup:export` writes a JSON export of the tables needed to rebuild a wallet and reconcile its
ledger, and refuses to include any table containing a secret or a hash.

Restore drill, which should be done before going live rather than during an incident:

```bash
npx wrangler d1 execute steve-pay --local --file ./backups/steve-pay.sql
node scripts/verify-schema.mjs
```

---

## Rollback

```bash
npx wrangler deployments list --env production
npx wrangler rollback <deployment-id> --env production
```

Workers rollback reverts code, not data. A migration that has already run stays applied, so **write
migrations to be backward compatible for one release**: add columns before using them, and do not
drop a column the previous version still reads.

---

## Environment separation

| | development | staging | production |
|---|---|---|---|
| Database | local D1 | `steve-pay-staging` | `steve-pay` |
| `ENVIRONMENT` | `development` | `staging` | `production` |
| Secrets | fixed placeholders | real, separate | real, separate |
| `workers_dev` | n/a | `true` | `false` |
| HSTS | not sent | not sent | preload |
| Cron | not run | run | run |

Never point staging at the production database. The test suite and any manual testing will create
invoices and move wallet balances.
