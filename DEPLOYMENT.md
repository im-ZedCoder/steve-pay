# Deployment

Two Cloudflare projects, and the second one exists because the first cannot do two things:

| | Project | What it is |
|---|---|---|
| The application | Pages project `steve-pay` | Every HTTP request. Built by `scripts/build-pages.mjs` into `dist-pages/`, uploaded with `wrangler pages deploy`. |
| The background half | Worker `steve-pay-jobs` | `wrangler.worker.jsonc`. Cron triggers and the webhook queue consumer. No public address. |

Pages Functions are HTTP-only: they have no `scheduled()` handler and cannot be a queue consumer,
and this platform depends on both — an invoice that never expires keeps its unique payable amount
claimed by a partial unique index, and a webhook whose retry never runs is a merchant who was
charged and never told. So the site runs on Pages and a companion Worker runs the schedule against
**the same** D1 database and KV namespace: one dataset, two readers, and no second object graph
because both run `src/index.ts`.

**There is no hostname in this repository.** No `routes` block, no `custom_domain`, no base-URL
variable. Each request's own origin is read from its URL (`src/core/origin.ts`) and used for every
absolute link the platform generates, with the last origin served remembered in KV for the
background jobs that have no request to read. The same build therefore answers correctly on
`localhost`, on `<project>.pages.dev`, on a preview alias and on a custom domain attached later,
with nothing to edit and nothing to keep in sync.

There is no VPS and nothing to keep running.

---

## Prerequisites

- A Cloudflare account. No domain is needed to deploy — the Pages project has an address the
  moment it goes up, and a custom domain is attached later in the dashboard.
- Node 20+ (developed on 26)
- `npm install`

```bash
npx wrangler login
```

---

## Fast path: one command

Steps 1 through 6 below can be done by hand — they are written out because you should be able
to read exactly what happens to your account — but `scripts/cloudflare-setup.mjs` does all of
them in the right order and is safe to re-run:

```bash
# Create an API token at https://dash.cloudflare.com/profile/api-tokens with:
#   Account → D1, Workers KV Storage, Queues, Workers Scripts, Cloudflare Pages   Edit
#   Account → Account Settings                                                     Read
#   User    → User Details                                                         Read
export CLOUDFLARE_API_TOKEN=...

npm run cf:setup -- --env production --yes
```

It creates the D1 database, the KV namespace, the queues and the Pages project; writes the real
IDs into `wrangler.jsonc` **and** `wrangler.worker.jsonc` without disturbing their comments;
applies the migrations and seeds; generates and pushes the crypto secrets to both projects;
builds and deploys the site, then the companion Worker; and creates the first admin if
`STEVE_PAY_ADMIN_MOBILE` and `STEVE_PAY_ADMIN_PASSWORD` are set.

The phases run in this order, and the order is load-bearing:

```
verify → d1 → kv → queues → pages → config → migrate → secrets → deploy → admin
```

`pages` comes after the resources because a Pages project cannot be created with its bindings
attached — they are pushed by the first deploy, from the config file. `migrate` sits before
`deploy` so the first request to the new deployment finds a schema rather than a 500. And the
Pages deploy happens **before** the companion Worker, because the Pages deploy is what creates
the queue producer: a consumer deployed first would be bound to a queue nothing writes to.

Useful flags: `--dry-run` reports what it would do and changes nothing, `--only`/`--skip` select
phases, and `--help` lists everything including the exact token permissions. `--env production`
is the only environment there is; anything else is refused rather than silently falling back to
production.

Three things it will not do, deliberately:

- **Register the Telegram webhook.** That is a Telegram API call, not a Cloudflare one.
- **Attach a domain.** Nothing in the project names a hostname, so there is nothing to attach.
  Add the custom domain in the dashboard; the next request is served on it.
- **Touch anything it did not create.** There is no `destroy` path in it. It also refuses to
  overwrite an id in either config file that it did not write unless you pass `--force-config`,
  so a re-run against the wrong account cannot silently redeploy over different data.

The generated secrets are written to `.cloudflare.secrets.production.json` (git-ignored). **Keep
that file.** A re-run reuses it rather than regenerating, because `API_KEY_PEPPER` cannot be
rotated without invalidating every API key hash in the database.

To verify the script itself without a Cloudflare account:

```bash
npm run cf:setup:test
```

That runs it against a local mock of the Cloudflare API and asserts idempotency, the config
patch, and that a dry run writes nothing. The mock's response shapes are checked against the
Cloudflare OpenAPI spec, not invented. One of its checks is that neither config file ends up
containing a hostname.

---

## 1. Create the resources

```bash
npx wrangler d1 create steve-pay
npx wrangler kv namespace create CACHE
npx wrangler queues create steve-pay-webhooks
npx wrangler queues create steve-pay-webhooks-dlq
npx wrangler pages project create steve-pay --production-branch main
```

Each command prints an ID. Paste it where the placeholder is, in **both** files:

| Placeholder | `wrangler.jsonc` (Pages) | `wrangler.worker.jsonc` (jobs) |
|---|---|---|
| `REPLACE_WITH_PRODUCTION_D1_ID` | yes | yes |
| `REPLACE_WITH_PRODUCTION_KV_ID` | yes | yes |

Both files must name the same database and the same namespace; they are two readers of one
dataset, and pointing them at different ones produces a site whose invoices never expire and a
sweeper whose expiry sweep finds nothing.

Queues are referenced by name, so nothing to paste. The **producer** is declared in
`wrangler.jsonc` and the **consumer** (with its retry policy and dead-letter queue) in
`wrangler.worker.jsonc` — Pages Functions cannot consume.

---

## 2. Set secrets

Never commit secrets.

```bash
# Generate three independent high-entropy values
node -e "for (const k of ['SESSION_SECRET','API_KEY_PEPPER','WEBHOOK_SECRET']) console.log(k, require('crypto').randomBytes(48).toString('base64url'))"
```

Both projects need them, and they must be the same values on both — the Worker reads the same
database and signs with the same keys:

```bash
wrangler pages secret put SESSION_SECRET --project-name steve-pay
wrangler pages secret put API_KEY_PEPPER --project-name steve-pay
wrangler pages secret put WEBHOOK_SECRET --project-name steve-pay

wrangler secret put SESSION_SECRET -c wrangler.worker.jsonc
wrangler secret put API_KEY_PEPPER -c wrangler.worker.jsonc
wrangler secret put WEBHOOK_SECRET -c wrangler.worker.jsonc
```

`npm run cf:setup -- --only secrets` does all six, and is the easier way to keep them identical.
`wrangler pages secret bulk <file> --project-name steve-pay` and
`wrangler secret bulk <file> -c wrangler.worker.jsonc` take a JSON file if you prefer that to the
prompts.

Optional, per feature — same two projects:

```bash
TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_WEBHOOK_SECRET, TURNSTILE_SECRET,
SMS_IP_ALLOWLIST   # e.g. "203.0.113.4,198.51.100.0/24"
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
```

Verify the schema invariants before serving traffic:

```bash
node scripts/verify-schema.mjs
```

---

## 4. Create the first admin

There is no self-service admin signup, by design. The bootstrap script creates one:

```bash
npm run admin:create              # local D1
npm run admin:create -- --remote  # production
```

It prompts for a mobile number and a password, hashes it with PBKDF2, and writes a `SUPER_ADMIN`
row. For scripted use, set `STEVE_PAY_ADMIN_MOBILE` and `STEVE_PAY_ADMIN_PASSWORD` instead of
being prompted; that is what the setup script's `admin` phase does.

Then:

1. Log in at `/login?scope=admin`
2. Change the password immediately if you generated one
3. Approve the first merchant and walk the setup wizard with them

---

## 5. Deploy

The two halves deploy separately, because they are two projects:

```bash
npm run deploy        # build + wrangler pages deploy dist-pages --no-bundle   (the site)
npm run deploy:jobs   # wrangler deploy -c wrangler.worker.jsonc              (cron + queue)
```

`npm run build` is what assembles `dist-pages/` — the directory Pages uploads. It regenerates the
fonts and the client script (both git-ignored build outputs derived from `node_modules` and
`src/ui/theme.ts`), bundles the Worker with `wrangler deploy --dry-run --outdir`, copies the bundle
in as `_worker.js`, copies `public/` alongside it, and writes `_routes.json` so the assets bypass
the Function. `--no-bundle` matters: `_worker.js` was already produced by Wrangler's own bundler,
and running Pages' bundler over it would be a second build of a built file.

Deploy order is the site first, then the Worker. If the site is down, the cron jobs run expiry
sweeps and rollups for traffic that cannot arrive; if the Worker is down, the site keeps taking
payments and only the background work stalls.

After deploying, check what each one resolved:

```bash
npx wrangler deployments status -c wrangler.worker.jsonc
npx wrangler pages deployment list --project-name steve-pay
```

A missing binding is the most common deployment failure, and a producer bound to a queue with no
consumer is the quietest one.

For local development:

```bash
npm run dev   # wrangler dev -c wrangler.worker.jsonc --var ENVIRONMENT:development
```

It uses the companion Worker's config because that is the one with a `main` and the `assets`
directory, so a single `wrangler dev` serves both the routes and the static files.

---

## 6. Custom domain

Nothing in the project needs to change, and nothing needs redeploying.

1. Workers & Pages → your project → **Custom domains** → add the domain
2. Point the DNS record at the project (Cloudflare offers to create it)
3. Wait for the certificate

Every link the platform generates follows the host it is served on, so a payment page opened on the
new domain returns invoice URLs on that domain and a status poll stays on it. Two things are worth
knowing:

- **The origin is remembered in KV** (`platform.origin`) for the background jobs, which have no
  request to read. It is written by the first request the deployment serves, so a custom domain
  starts appearing in Telegram links after its first page view — not before.
- **HSTS is sent only when the deployment is production and the request arrived over TLS.** A
  `*.pages.dev` preview never sends it, and neither does localhost; see
  [SECURITY.md](./SECURITY.md). Enabling preload is a two-year commitment: do it only when every
  subdomain you will ever need is HTTPS.

Preview deployments get their own hostname per branch and work without configuration, but they
share the production database unless you give the project a preview environment — so treat a
preview URL as a window onto live data.

---

## 7. Cron Triggers

Declared in `wrangler.worker.jsonc`, and they are the reason the platform does not need a worker
process. They do **not** run on the Pages project:

| Schedule | Job |
|---|---|
| `*/2 * * * *` | Expire due invoices; release their unique amounts and wallet reservations |
| `*/15 * * * *` | Retry due webhook deliveries; re-enable or disable endpoints by failure count |
| `0 3 * * *` | Daily rollups, prune expired idempotency keys and sessions, reconcile wallets against the ledger |

Verify after deploying:

```bash
npx wrangler tail -c wrangler.worker.jsonc --format json | grep '"surface":"cron"'
```

---

## 8. Turnstile

1. Create a widget in the Cloudflare dashboard. Add the hostname you deployed on — the
   `*.pages.dev` address works for testing and can be swapped for the custom domain later
2. Put the **site key** in the `TURNSTILE_SITE_KEY` var of **both** `wrangler.jsonc` and
   `wrangler.worker.jsonc` (it is public and ships to the browser)
3. Put the **secret** in `TURNSTILE_SECRET` on both projects
4. Enable it: set the `platform.turnstile_required` setting to `true`

Leaving `TURNSTILE_SITE_KEY` empty disables the widget entirely and the registration page renders
without it. When it is set, that page's CSP is widened to allow Cloudflare's challenge origins —
and only that page.

---

## 9. Observability

Observability is enabled in both configs with full sampling. Every response carries a request ID,
and every log line includes it, so a merchant's quoted ID lines up with the logs.

```bash
npx wrangler pages deployment tail --project-name steve-pay --format pretty   # the site
npx wrangler tail -c wrangler.worker.jsonc --format pretty                    # cron + queue
```

Health check for an uptime monitor, on whatever host you deployed:

```bash
curl -s https://your-host/health
```

`{"status":"ok","checks":{"database":{"status":"ok",...}}}` with HTTP 200, or HTTP 503 and
`"status":"degraded"` if D1 is unreachable. `/health` requires no secret on purpose.

---

## 10. Backups

D1 has point-in-time recovery on paid plans. For a portable export:

```bash
npm run backup:export                       # writes ./backups
npx wrangler d1 export steve-pay --remote --output ./backups/steve-pay.sql
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

Two projects, two rollbacks.

```bash
# The site — dashboard, or the CLI:
#   Workers & Pages → steve-pay → Deployments → ⋯ → Rollback
npm run deploy            # re-deploy the last good commit instead

# The background Worker:
npx wrangler deployments list -c wrangler.worker.jsonc
npx wrangler rollback <version-id> -c wrangler.worker.jsonc
```

Rollback reverts code, not data. A migration that has already run stays applied, so **write
migrations to be backward compatible for one release**: add columns before using them, and do not
drop a column the previous version still reads.

---

## Environments

| | development | production |
|---|---|---|
| Database | local D1 | `steve-pay` |
| Runs as | `wrangler dev`, no deploy | Pages project + companion Worker |
| `ENVIRONMENT` | `development` | `production` |
| Secrets | fixed placeholders | real, generated once |
| HSTS | never | when the request is HTTPS |
| Cron | not run | run, in the companion Worker |
| Hostname | `localhost:8787` | from the request |

There is one deployed environment on purpose. A second one would be a second database to keep in
sync with the same migrations, and the failure it invites is a test run moving real balances. If
you add one later, it needs its own D1, its own KV, its own queues, its own Pages project and its
own copy of the crypto secrets — and `--env` stops being a validated list of one in
`scripts/cloudflare-setup.mjs`.
