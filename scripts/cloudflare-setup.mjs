#!/usr/bin/env node
/**
 * One-command Cloudflare provisioning for Steve Pay.
 *
 * Give it a Cloudflare API token and it creates everything the deployment needs, writes the
 * real resource IDs back into `wrangler.jsonc`, applies the migrations, pushes the secrets,
 * deploys, and creates the first admin — in that order, and safely re-runnable.
 *
 *     npm run cf:setup -- --token <token>
 *
 * WHY THIS EXISTS
 *
 * A first deployment means a manual tour of five dashboard pages — D1, KV, Queues, the Pages
 * project, and the secrets — followed by hand-editing two config files, three `secret put`
 * calls, a migration run, a fresh deploy, and only then the admin bootstrap. Every one of
 * those steps has a plausible way to go wrong quietly, and the quiet ones are the expensive
 * ones: a secret left unset falls back to a development placeholder, migrations applied to
 * the wrong database look identical from the outside, and a KV namespace bound to the wrong
 * id works fine until the first cache read.
 *
 * TWO DEPLOY TARGETS, AND THAT IS NOT AN ACCIDENT
 *
 * The web application is a Cloudflare **Pages** project. Pages Functions cannot run a
 * `scheduled()` handler and cannot be a queue consumer, so the cron sweeper and the webhook
 * retry queue live in a companion Worker (`wrangler.worker.jsonc`). Both bind the same D1
 * database and KV namespace. This script provisions and deploys both, in the order that
 * leaves a working site at the end of it: resources, schema, secrets, then Pages, then the
 * companion Worker.
 *
 * DESIGN DECISIONS
 *
 *   - **Idempotent, not one-shot.** Every resource is looked up by name before it is
 *     created, so running this twenty times is the same as running it once. It never deletes
 *     anything: no `destroy`, no `delete`, no overwrite of a resource it did not create.
 *
 *   - **The REST API for resources, wrangler for the deploy.** Resources are created over
 *     HTTP so the script can report precisely what exists and what it made; the deploy and
 *     the secret upload go through wrangler, because reimplementing bundle upload and
 *     secret sealing would be a second implementation of a solved problem.
 *
 *   - **Secrets are generated, never typed.** `SESSION_SECRET`, `API_KEY_PEPPER` and
 *     `WEBHOOK_SECRET` are generated here with 48 bytes of entropy and written once to a
 *     git-ignored file. The alternative — asking a human to invent three secrets — reliably
 *     produces one weak value reused three times, and `API_KEY_PEPPER` in particular cannot
 *     be rotated later without invalidating every stored API key hash.
 *
 *   - **Nothing is written to `wrangler.jsonc` until the resources exist.** The config patch
 *     is text-level and placeholder-based, on purpose: the file is heavily commented and
 *     re-serialising it through `JSON.parse` would delete every explanation in it.
 *
 * WHAT IT CANNOT DO
 *
 *   - Register the Telegram webhook. That is a Telegram API call, not a Cloudflare one.
 *   - Attach a custom domain. There is no domain anywhere in this repository: the platform
 *     reads its own origin from each request, so it answers correctly on
 *     `<project>.pages.dev` from the first deploy. Add the domain in the dashboard
 *     (Workers & Pages → your Pages project → Custom domains) whenever you like, and the
 *     application needs no redeploy and no configuration change when you do.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The Pages project config: bindings, vars and the output directory. */
const WRANGLER_PATH = join(ROOT, 'wrangler.jsonc');
/** The companion Worker config: the same bindings plus crons and the queue consumer. */
const WORKER_CONFIG_PATH = join(ROOT, 'wrangler.worker.jsonc');
// Overridable so `scripts/cloudflare-setup.selftest.mjs` can point the same code at a local
// mock and assert its behaviour without a real account. Nothing else should set it.
const API = process.env.CLOUDFLARE_API_BASE ?? 'https://api.cloudflare.com/client/v4';

/**
 * Resource names. These must match both config files; the config phase would otherwise
 * "verify" a deployment that points somewhere the script never created.
 *
 * `project` is the Pages project and `jobs` is the companion Worker, which is why they
 * differ — a Pages project and a Worker cannot share a name in the same account.
 */
const RESOURCES = {
  production: {
    project: 'steve-pay',
    jobs: 'steve-pay-jobs',
    d1: 'steve-pay',
    kv: 'steve-pay-cache',
    queue: 'steve-pay-webhooks',
    dlq: 'steve-pay-webhooks-dlq',
  },
};

/**
 * The phases, in the order they must run.
 *
 * `pages` comes after the resources because a Pages project cannot be created with its
 * bindings attached — they are pushed on the first deploy, from the config file. `config`
 * sits between the resources and the deploy because the deploy reads the ids that `config`
 * checks. `migrate` sits before `deploy` so the first request to the new deployment finds a
 * schema rather than a 500 — the code is not written to run against an empty database, and
 * it should not have to be.
 *
 * There is no `domain` phase. Nothing in this repository names a hostname, so there is
 * nothing for the script to attach or verify; the custom domain is added in the dashboard
 * and the application picks it up from the next request it serves.
 */
const PHASES = ['verify', 'd1', 'kv', 'queues', 'pages', 'config', 'migrate', 'secrets', 'deploy', 'admin'];

const TOKEN_PERMISSIONS = [
  ['Account', 'D1', 'Edit'],
  ['Account', 'Workers KV Storage', 'Edit'],
  ['Account', 'Queues', 'Edit'],
  ['Account', 'Workers Scripts', 'Edit'],
  ['Account', 'Cloudflare Pages', 'Edit'],
  ['Account', 'Account Settings', 'Read'],
  ['User', 'User Details', 'Read'],
];

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const useColour = Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined;
const paint = (code, text) => (useColour ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = (text) => paint('2', text);
const bold = (text) => paint('1', text);
const green = (text) => paint('32', text);
const yellow = (text) => paint('33', text);
const red = (text) => paint('31', text);
const cyan = (text) => paint('36', text);

let currentPhase = 'setup';

function phase(name) {
  currentPhase = name;
  console.log(`\n${cyan('▸')} ${bold(name)}`);
}

function log(message) {
  console.log(`  ${message}`);
}

function detail(message) {
  console.log(`  ${dim(message)}`);
}

function created(message) {
  console.log(`  ${green('+')} ${message}`);
}

function existed(message) {
  console.log(`  ${dim('=')} ${message} ${dim('(already existed)')}`);
}

function warn(message) {
  console.log(`  ${yellow('!')} ${message}`);
}

function fail(message) {
  console.error(`  ${red('✗')} ${message}`);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`
${bold('Provision Steve Pay on Cloudflare.')}

  npm run cf:setup -- --token <CLOUDFLARE_API_TOKEN> [options]

${bold('Options')}
  --token <value>          Cloudflare API token (or CLOUDFLARE_API_TOKEN / CF_API_TOKEN)
  --account <id>           Account id. Discovered from the token when omitted.
  --env <name>             production (the only configured environment)
  --secrets <path>         JSON file of secrets to push (see below)
  --turnstile-site-key <k> Public Turnstile site key, written into wrangler.jsonc vars
  --only <a,b>             Run only these phases
  --skip <a,b>             Skip these phases
  --dry-run                Report what would happen; change nothing
  --force-config           Overwrite non-placeholder ids in wrangler.jsonc
  --yes, -y                Do not prompt
  -h, --help               This message

${bold('Phases')} (run in this order)
  ${PHASES.join(', ')}

${bold('Secret sources')}
  crypto secrets   generated here and saved to .cloudflare.secrets.<env>.json
  optional ones    read from the environment, or from --secrets <path>:
                   TURNSTILE_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID,
                   TELEGRAM_WEBHOOK_SECRET, TELEGRAM_WEBHOOK_ENABLED, SMS_IP_ALLOWLIST,
                   MAINTENANCE_MODE

${bold('Container-admin bootstrap')}
  STEVE_PAY_ADMIN_MOBILE and STEVE_PAY_ADMIN_PASSWORD are passed through to
  scripts/create-admin.mjs. If they are absent, that phase prints the command to run.

${bold('Required token permissions')}
${TOKEN_PERMISSIONS.map(([scope, group, level]) => `  ${scope.padEnd(8)} ${group.padEnd(22)} ${level}`).join('\n')}

${bold('Example')}
  npm run cf:setup -- --token cf_xxx --env production --yes
`);
}

function parseArgs(argv) {
  const args = {
    token: null,
    account: null,
    env: 'production',
    secrets: null,
    turnstileSiteKey: null,
    only: null,
    skip: null,
    dryRun: false,
    forceConfig: false,
    yes: false,
  };

  const need = (flag, index) => {
    const value = argv[index];
    if (value === undefined || value.startsWith('--')) {
      console.error(`Missing value for ${flag}`);
      process.exit(1);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--token':
        args.token = need(token, ++index);
        break;
      case '--account':
        args.account = need(token, ++index);
        break;
      case '--env':
        args.env = need(token, ++index);
        break;
      case '--secrets':
        args.secrets = need(token, ++index);
        break;
      case '--turnstile-site-key':
        args.turnstileSiteKey = need(token, ++index);
        break;
      case '--only':
        args.only = need(token, ++index)
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        break;
      case '--skip':
        args.skip = need(token, ++index)
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--force-config':
        args.forceConfig = true;
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${token}`);
        printUsage();
        process.exit(1);
    }
  }

  // Staging used to be a second named environment in wrangler.jsonc. It is gone: the config
  // now describes one Pages project and one companion Worker. A silent fallback to
  // production would be the worst possible answer to `--env staging`, so it is refused.
  if (args.env !== 'production') {
    console.error(`Invalid --env "${args.env}". Only "production" is configured.`);
    console.error('For a staging deployment, add an `env.staging` block to both config files first.');
    process.exit(1);
  }

  for (const list of [args.only, args.skip]) {
    if (!list) continue;
    for (const name of list) {
      if (!PHASES.includes(name)) {
        console.error(`Unknown phase "${name}". Known: ${PHASES.join(', ')}`);
        process.exit(1);
      }
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Cloudflare REST client
// ---------------------------------------------------------------------------

class CloudflareError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

/**
 * Calls the Cloudflare API v4.
 *
 * Retries only what is worth retrying: rate limits and 5xx. A 4xx that is not 429 is a
 * decision by the API — a missing permission, a name already taken, a malformed body — and
 * repeating it just makes the same failure slower and harder to read.
 */
async function cf(path, options = {}) {
  const { method = 'GET', body, token, attempt = 1 } = options;
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body means we are not talking to the API — a proxy, a captive portal, a
    // wrong base URL. Reported as-is rather than as a parse error, because the body is the
    // clue and losing it is how this becomes a mystery.
    if (!response.ok) {
      throw new CloudflareError(`Non-JSON response (${response.status}): ${text.slice(0, 200)}`, response.status, []);
    }
  }

  const retryable = response.status === 429 || response.status >= 500;
  if (retryable && attempt < 4) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
    detail(`retrying ${method} ${path} in ${Math.round(waitMs)}ms (HTTP ${response.status})`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return cf(path, { ...options, attempt: attempt + 1 });
  }

  if (!response.ok || payload?.success === false) {
    const errors = payload?.errors ?? [];
    const message = errors.map((entry) => `${entry.code}: ${entry.message}`).join('; ') || `HTTP ${response.status}`;
    throw new CloudflareError(message, response.status, errors);
  }

  return payload?.result ?? null;
}

/** Turns a Cloudflare failure into an actionable message rather than a stack trace. */
function reportApiFailure(error, what) {
  if (!(error instanceof CloudflareError)) throw error;

  fail(`${what} failed — ${error.message}`);

  if (error.status === 401 || error.status === 403) {
    console.log(`\n  ${bold('The token is missing a permission or is not valid. Verify it has:')}`);
    for (const [scope, group, level] of TOKEN_PERMISSIONS) {
      log(`${scope} → ${group} → ${level}`);
    }
    console.log('');
  } else if (error.status === 404) {
    detail('A 404 from the API usually means the token is scoped to a different account');
    detail('than the one being used. Re-run with --account <id>.');
  }
}

// ---------------------------------------------------------------------------
// wrangler.jsonc patching
// ---------------------------------------------------------------------------

/**
 * Replaces exact strings in one of the project's wrangler configs.
 *
 * Text-level on purpose. Both config files are the primary explanation of this deployment —
 * why the compatibility date is pinned, why KV holds only cache, why the queue has a dead
 * letter queue, why the companion Worker exists at all — and round-tripping them through
 * `JSON.parse`/`JSON.stringify` would delete every one of those comments to save writing
 * eight lines of string replacement.
 */
function patchConfig(replacements, { dryRun, path = WRANGLER_PATH }) {
  const original = readFileSync(path, 'utf8');
  let next = original;
  const applied = [];
  const missing = [];

  for (const [from, to] of replacements) {
    if (!next.includes(from)) {
      missing.push(from);
      continue;
    }
    // `split`/`join` rather than a regex: the values contain characters (`/`, `.`, `:`) that
    // would need escaping, and a typo in that escaping is a silent no-op.
    next = next.split(from).join(to);
    applied.push([from, to]);
  }

  if (applied.length === 0) return { changed: false, applied, missing };

  if (!dryRun) writeFileSync(path, next, 'utf8');
  return { changed: true, applied, missing };
}

/**
 * The ids each config file currently points at.
 *
 * Both files bind the same database and the same KV namespace, so both are read: a run that
 * patched one and not the other would deploy a Pages project and a companion Worker reading
 * two different databases, and nothing about that failure is visible until a cron job
 * reports on data no customer ever wrote.
 */
function currentConfigIds(path = WRANGLER_PATH) {
  const text = readFileSync(path, 'utf8');
  const read = (key) => {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text);
    return match?.[1] ?? null;
  };
  const placeholders = [...text.matchAll(/REPLACE_WITH_[A-Z0-9_]+/g)].map((match) => match[0]);
  return {
    d1: read('database_id'),
    kv: read('id'),
    hasPlaceholders: placeholders.length > 0,
    placeholders: [...new Set(placeholders)],
  };
}

// ---------------------------------------------------------------------------
// wrangler / npm child processes
// ---------------------------------------------------------------------------

function runChild(command, commandArgs, { env = {}, input, quiet = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: input === undefined ? (quiet ? 'pipe' : 'inherit') : ['pipe', 'inherit', 'inherit'],
    input,
    // Windows resolves `npx`/`npm` through the shell; POSIX does not need it.
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const err = new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}`);
    err.status = result.status;
    throw err;
  }

  return result.stdout ?? '';
}

function wrangler(commandArgs, env, options = {}) {
  return runChild('npx', ['wrangler', ...commandArgs], { env, ...options });
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** 48 bytes of entropy, base64url — the length `.env.example` asks for. */
function generateSecret() {
  return randomBytes(48).toString('base64url');
}

const GENERATED_SECRETS = ['SESSION_SECRET', 'API_KEY_PEPPER', 'WEBHOOK_SECRET'];

/** Optional secrets, pushed only when a value was actually supplied. */
const OPTIONAL_SECRETS = [
  'TURNSTILE_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ADMIN_CHAT_ID',
  'TELEGRAM_WEBHOOK_SECRET',
  'TELEGRAM_WEBHOOK_ENABLED',
  'SMS_IP_ALLOWLIST',
  'MAINTENANCE_MODE',
];

function readSecretsFile(path) {
  if (!path) return {};
  if (!existsSync(path)) {
    fail(`Secrets file not found: ${path}`);
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed;
  } catch (error) {
    fail(`Could not read ${path}: ${error.message}`);
    process.exit(1);
  }
}

function secretsFilePath(envName) {
  return join(ROOT, `.cloudflare.secrets.${envName}.json`);
}

/**
 * Loads the secrets for one environment.
 *
 * Order of precedence: the generated file from a previous run, then an explicit
 * `--secrets` file, then the process environment, then freshly generated. Reusing the file
 * across runs is what makes a second `cf:setup` safe: rotating `API_KEY_PEPPER` would
 * invalidate every API key hash already in the database, so it must never be regenerated
 * just because the script ran again.
 */
function resolveSecrets(envName, supplied) {
  const path = secretsFilePath(envName);
  const stored = existsSync(path) ? readSecretsFile(path) : {};
  const secrets = { ...supplied };

  for (const name of GENERATED_SECRETS) {
    if (!secrets[name] && stored[name]) secrets[name] = stored[name];
    if (!secrets[name] && process.env[name]) secrets[name] = process.env[name];
    if (!secrets[name]) secrets[name] = generateSecret();
  }

  for (const name of OPTIONAL_SECRETS) {
    if (secrets[name] === undefined && process.env[name]) secrets[name] = process.env[name];
  }

  return { secrets, path };
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function phaseVerify(state) {
  phase('verify');

  const identity = await cf('/user/tokens/verify', { token: state.token });
  log(`token: ${identity.status === 'active' ? green('active') : red(identity.status)} ${dim(`(id ${identity.id})`)}`);

  const accounts = await cf('/accounts?per_page=50', { token: state.token });
  if (!accounts || accounts.length === 0) {
    fail('This token cannot see any account. Add the "Account Settings: Read" permission.');
    process.exit(1);
  }

  if (state.account) {
    const match = accounts.find((account) => account.id === state.account);
    if (!match) {
      fail(`Account ${state.account} is not visible to this token. Visible: ${accounts.map((a) => a.name).join(', ')}`);
      process.exit(1);
    }
    state.accountName = match.name;
  } else {
    if (accounts.length > 1) {
      warn(`Token can see ${accounts.length} accounts; using "${accounts[0].name}". Pass --account to choose.`);
    }
    state.account = accounts[0].id;
    state.accountName = accounts[0].name;
  }

  log(`account: ${state.accountName} ${dim(state.account)}`);
  if (process.env.CLOUDFLARE_API_BASE) {
    warn(`API base overridden to ${process.env.CLOUDFLARE_API_BASE}`);
    detail('This is only expected when running the self-test.');
  }

  // A project that already exists tells us this is a re-run. That changes the tone of the
  // rest of the output but not the behaviour: every phase is idempotent.
  const projects = await listPagesProjects(state);
  const existing = projects.find((project) => project.name === RESOURCES.production.project);
  if (existing) {
    state.alreadyDeployed = true;
    detail(`Pages project '${existing.name}' already exists — this looks like a re-run.`);
    if (existing.subdomain) state.pagesUrl = `https://${existing.subdomain}`;
  }
}

/**
 * Every Pages project in the account.
 *
 * The API paginates; one page of a hundred is the practical ceiling for an account and
 * asking for more in a loop here would be code that never runs.
 */
async function listPagesProjects(state) {
  return (await cf(`/accounts/${state.account}/pages/projects?per_page=100`, { token: state.token })) ?? [];
}

/**
 * Ensures the Pages project exists.
 *
 * Created empty on purpose. Pages attaches D1, KV and queue bindings from the Wrangler
 * configuration on the first deploy rather than at project creation, so there is nothing to
 * pass here — and a project created with bindings set through this API would be a second
 * source of truth that the config file could disagree with.
 */
async function phasePages(state) {
  phase('pages');

  const name = RESOURCES.production.project;
  const projects = await listPagesProjects(state);
  const found = projects.find((project) => project.name === name);

  if (found) {
    existed(`Pages project ${name}`);
    if (found.subdomain) {
      state.pagesUrl = `https://${found.subdomain}`;
      log(`url: ${bold(state.pagesUrl)}`);
    }
    return;
  }

  if (state.dryRun) {
    log(`would create Pages project ${name}`);
    return;
  }

  const made = await cf(`/accounts/${state.account}/pages/projects`, {
    method: 'POST',
    token: state.token,
    body: { name, production_branch: 'main' },
  });
  created(`Pages project ${name}`);

  const subdomain = made?.subdomain ?? `${name}.pages.dev`;
  state.pagesUrl = `https://${subdomain}`;
  log(`url: ${bold(state.pagesUrl)}`);
  detail('This is the address the application already answers on — no domain is configured.');
}

async function phaseD1(state) {
  phase('d1');

  const existing = (await cf(`/accounts/${state.account}/d1/database?per_page=100`, { token: state.token })) ?? [];
  state.d1 = {};

  for (const envName of state.environments) {
    const name = RESOURCES[envName].d1;
    const found = existing.find((database) => database.name === name);

    if (found) {
      existed(`D1 ${name} ${dim(found.uuid)}`);
      state.d1[envName] = found.uuid;
      continue;
    }

    if (state.dryRun) {
      log(`would create D1 ${name}`);
      state.d1[envName] = `(new id for ${name})`;
      continue;
    }

    const created_ = await cf(`/accounts/${state.account}/d1/database`, {
      method: 'POST',
      token: state.token,
      body: { name },
    });
    created(`D1 ${name} ${dim(created_.uuid)}`);
    state.d1[envName] = created_.uuid;
  }
}

async function phaseKv(state) {
  phase('kv');

  const existing = (await cf(`/accounts/${state.account}/storage/kv/namespaces?per_page=100`, { token: state.token })) ?? [];
  state.kv = {};

  for (const envName of state.environments) {
    const title = RESOURCES[envName].kv;
    const found = existing.find((namespace) => namespace.title === title);

    if (found) {
      existed(`KV ${title} ${dim(found.id)}`);
      state.kv[envName] = found.id;
      continue;
    }

    if (state.dryRun) {
      log(`would create KV ${title}`);
      state.kv[envName] = `(new id for ${title})`;
      continue;
    }

    const made = await cf(`/accounts/${state.account}/storage/kv/namespaces`, {
      method: 'POST',
      token: state.token,
      body: { title },
    });
    created(`KV ${title} ${dim(made.id)}`);
    state.kv[envName] = made.id;
  }
}

async function phaseQueues(state) {
  phase('queues');

  const existing = (await cf(`/accounts/${state.account}/queues?per_page=100`, { token: state.token })) ?? [];
  const names = new Set(existing.map((queue) => queue.queue_name));

  for (const envName of state.environments) {
    for (const name of [RESOURCES[envName].dlq, RESOURCES[envName].queue]) {
      if (names.has(name)) {
        existed(`Queue ${name}`);
        continue;
      }
      if (state.dryRun) {
        log(`would create queue ${name}`);
        continue;
      }
      await cf(`/accounts/${state.account}/queues`, {
        method: 'POST',
        token: state.token,
        body: { queue_name: name },
      });
      created(`Queue ${name}`);
      names.add(name);
    }
  }

  // The staging block in wrangler.jsonc has no `queues` key, and a named environment does not
  // inherit one. Staging therefore runs without a queue binding and falls back to
  // `waitUntil` for webhook delivery — correct, but slower, and worth saying out loud rather
  // than leaving as a surprise when delivery logs look different between environments.
  if (state.environments.includes('staging')) {
    detail('Staging has no queue binding by design; webhook delivery there uses waitUntil.');
  }
}

/**
 * Points both config files at the resources this run resolved.
 *
 * The ids are the one thing that cannot be committed for someone else's account, so this is
 * the phase that makes a first deploy work on a fresh Cloudflare account. It is written to
 * handle three states honestly:
 *
 *   placeholders present  → replace them
 *   ids present and equal → report and move on
 *   ids present and wrong → report, and refuse to overwrite without --force-config
 *
 * The third case matters: the ids in this repository belong to a real account, and a script
 * that silently rewrote them would move a live deployment's database without saying so.
 */
async function phaseConfig(state) {
  phase('config');

  const targets = [
    { label: 'wrangler.jsonc (Pages)', path: WRANGLER_PATH },
    { label: 'wrangler.worker.jsonc (companion Worker)', path: WORKER_CONFIG_PATH },
  ];

  const d1Id = state.d1?.production ?? null;
  const kvId = state.kv?.production ?? null;

  for (const target of targets) {
    const before = currentConfigIds(target.path);
    const replacements = [];

    for (const placeholder of before.placeholders) {
      if (placeholder.includes('D1') && d1Id) replacements.push([placeholder, d1Id]);
      if (placeholder.includes('KV') && kvId) replacements.push([placeholder, kvId]);
    }

    if (state.turnstileSiteKey) {
      replacements.push([
        '"TURNSTILE_SITE_KEY": ""',
        `"TURNSTILE_SITE_KEY": "${state.turnstileSiteKey}"`,
      ]);
    }

    if (replacements.length === 0) {
      if (before.hasPlaceholders) {
        warn(`${target.label} still has placeholders this run could not resolve: ${before.placeholders.join(', ')}`);
      } else if (d1Id && before.d1 && before.d1 !== d1Id) {
        warn(`${target.label} points at D1 ${before.d1} but the account has ${d1Id}.`);
        if (state.forceConfig) {
          replacements.push([before.d1, d1Id]);
          if (kvId && before.kv) replacements.push([before.kv, kvId]);
        } else {
          detail('Refusing to overwrite ids this script did not write. Re-run with --force-config.');
        }
      } else {
        log(`${target.label}: already matches the provisioned resources.`);
      }
    }

    if (replacements.length === 0) continue;

    const result = patchConfig(replacements, { dryRun: state.dryRun, path: target.path });

    if (!result.changed) {
      warn(`${target.label}: nothing to patch, which is unexpected — check it for placeholder drift.`);
      continue;
    }

    if (state.dryRun) {
      log(`${target.label}: would replace ${result.applied.length} value(s)`);
      continue;
    }

    log(`${green(`${target.label} updated`)} ${dim(`(${result.applied.length} value(s)`)}${dim(')')}`);
    for (const from of result.missing) detail(`not present, skipped: ${from}`);
  }
}

async function phaseMigrate(state) {
  phase('migrate');

  const database = RESOURCES.production.d1;

  if (state.dryRun) {
    log(`would apply migrations + seeds to ${database} (remote)`);
    return;
  }

  // Migrations are read from `migrations_dir` in the config, so the command needs a config
  // file even though it names the database explicitly. The Pages config is used because it
  // is the file `wrangler d1` resolves without an `--env`.
  log(`migrations → ${bold(database)} ${dim('(--remote)')}`);
  try {
    wrangler(['d1', 'migrations', 'apply', database, '--remote'], state.childEnv);
  } catch (error) {
    fail(`Migrations failed for ${database}.`);
    detail('Refusing to continue: deploying code against an unmigrated database is how a');
    detail('schema mismatch becomes a 500 on the first live payment.');
    process.exit(error.status ?? 1);
  }

  // The settings seed is idempotent (`ON CONFLICT DO NOTHING`), so running it on an existing
  // database is a no-op rather than a duplicate-key failure.
  log(`seeds → ${bold(database)}`);
  try {
    wrangler(['d1', 'execute', database, '--remote', '--file', 'seeds/0001_settings.sql'], state.childEnv);
  } catch (error) {
    warn('Seed failed. The schema is in place, so the app will boot with default settings.');
    detail(String(error.message));
  }
}

/**
 * Pushes the secrets to both deploy targets.
 *
 * Both, and this is not belt-and-braces: the Pages project verifies sessions and the
 * companion Worker opens the same encrypted columns. A `WEBHOOK_SECRET` present on one and
 * not the other means signatures verify in the request path and deliveries enqueued from
 * cron do not, which reads as "webhooks work except the retries".
 */
async function pushSecrets(state, names, payload, target) {
  // Pages and Workers have separate secret commands: `wrangler pages secret` addresses a
  // Pages project by name, while `wrangler secret` addresses whatever Worker the config file
  // describes. Running the Worker command for both would write the secrets onto the
  // companion Worker twice and leave the Pages project — the one that serves every request —
  // with none of them.
  const prefix = target === 'pages' ? ['pages', 'secret'] : ['secret'];
  const scope =
    target === 'pages'
      ? ['--project-name', RESOURCES.production.project]
      : ['-c', 'wrangler.worker.jsonc'];

  const bulkPath = join(ROOT, `.cloudflare-secrets-${target}.tmp.json`);
  writeFileSync(bulkPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });

  try {
    wrangler([...prefix, 'bulk', bulkPath, ...scope], state.childEnv);
    created(`${names.length} secret(s) uploaded to ${target}`);
  } catch {
    warn(`bulk upload failed for ${target}; falling back to one \`secret put\` each.`);
    for (const name of names) {
      try {
        wrangler([...prefix, 'put', name, ...scope], state.childEnv, { input: `${payload[name]}\n` });
        detail(`pushed ${name}`);
      } catch {
        fail(`Could not push ${name} to ${target}.`);
      }
    }
  } finally {
    // The temp file must not survive the run: it holds live production secrets.
    writeFileSync(bulkPath, '');
    try {
      const { rmSync } = await import('node:fs');
      rmSync(bulkPath, { force: true });
    } catch {
      warn(`Could not delete ${bulkPath}. Delete it by hand — it contains secrets.`);
    }
  }
}

async function phaseSecrets(state) {
  phase('secrets');

  for (const envName of state.environments) {
    const { secrets, path } = resolveSecrets(envName, state.suppliedSecrets);

    const names = Object.keys(secrets).filter((name) => secrets[name] !== undefined && secrets[name] !== '');
    const generated = GENERATED_SECRETS.filter((name) => secrets[name]);
    const payload = Object.fromEntries(names.map((name) => [name, String(secrets[name])]));

    log(`${bold(envName)}: ${names.length} secret(s) ${dim('→')} ${names.join(', ')}`);

    if (state.dryRun) {
      log(`would push ${names.length} secret(s) to the Pages project and the companion Worker`);
    } else {
      // Pages secrets are not read from `.dev.vars`-style files and `wrangler pages secret`
      // has its own subcommand; `secret bulk --project-name` targets the Pages project.
      await pushSecrets(state, names, payload, 'pages');
      await pushSecrets(state, names, payload, 'worker');
    }

    // `secret bulk` takes a JSON file. A temp file inside the project would risk being
    // committed; one `secret put` per secret would put each value on a command line and in
    // the shell history. The file is written to the project root with 0600 and matched by
    // .gitignore, which is the narrowest option that keeps the values off every command line.

    // The generated file is kept so a re-run does not rotate the crypto secrets, which would
    // invalidate every session cookie and every stored API key hash.
    if (!state.dryRun && generated.length > 0) {
      const toSave = Object.fromEntries(
        [...GENERATED_SECRETS, ...OPTIONAL_SECRETS]
          .filter((name) => secrets[name] !== undefined && secrets[name] !== '')
          .map((name) => [name, String(secrets[name])]),
      );
      writeFileSync(path, `${JSON.stringify(toSave, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      log(`${green('Secrets saved')} → ${bold(path.replace(ROOT, '.'))}`);
      detail('Keep this file. API_KEY_PEPPER cannot be rotated without invalidating every API key.');
    }
  }
}

/**
 * Deploys the Pages project, then the companion Worker.
 *
 * That order, and it matters. The Pages deploy pushes the bindings into the project, which
 * is what creates the queue producer. If the consumer went up first it would be bound to a
 * queue with no producer and a cron schedule whose jobs write rows nothing reads — harmless
 * for a minute, but it makes a failed Pages deploy look like a successful one.
 */
async function phaseDeploy(state) {
  phase('deploy');

  if (state.dryRun) {
    log('would run: npm run build  (fonts + assets + bundle → dist-pages/)');
    log(`would run: wrangler pages deploy dist-pages --no-bundle --project-name ${RESOURCES.production.project}`);
    log('would run: wrangler deploy -c wrangler.worker.jsonc');
    return;
  }

  // `npm run build` regenerates the fonts and the client script first. They are generated,
  // not committed, and a deploy without them ships pages whose stylesheet 404s — which
  // renders as unstyled HTML rather than as an error, so it fails quietly.
  log('building dist-pages/');
  try {
    runChild('npm', ['run', 'build'], { quiet: true });
  } catch (error) {
    fail('The build failed. Nothing was deployed.');
    detail(String(error.message));
    process.exit(error.status ?? 1);
  }

  // `--no-bundle`: the artifact in `dist-pages/_worker.js` was produced by Wrangler's own
  // bundler, so running Pages' bundler over it would be a second build of an already-built
  // file — slower, and a chance for the two to disagree about the output.
  log(`deploying Pages project ${bold(RESOURCES.production.project)}`);
  try {
    wrangler(
      ['pages', 'deploy', 'dist-pages', '--no-bundle', '--project-name', RESOURCES.production.project],
      state.childEnv,
    );
    created('Pages deployment live');
  } catch (error) {
    fail('Pages deploy failed. The companion Worker was not deployed.');
    detail('Deploying the cron jobs against a site that is not live would run rollups and');
    detail('expiry sweeps for traffic that cannot arrive.');
    process.exit(error.status ?? 1);
  }

  log(`deploying companion Worker ${bold(RESOURCES.production.jobs)} ${dim('(cron + queue consumer)')}`);
  try {
    wrangler(['deploy', '-c', 'wrangler.worker.jsonc'], state.childEnv);
    created('cron triggers and the webhook queue consumer are live');
  } catch (error) {
    fail('The companion Worker failed to deploy.');
    detail('The site itself is live, but invoices will not expire and failed webhook');
    detail('deliveries will not be retried until this is fixed.');
    process.exit(error.status ?? 1);
  }
}

async function phaseAdmin(state) {
  phase('admin');

  const mobile = process.env.STEVE_PAY_ADMIN_MOBILE;
  const password = process.env.STEVE_PAY_ADMIN_PASSWORD;

  if (!state.environments.includes('production')) {
    detail('Skipped: the production environment was not part of this run.');
    return;
  }

  if (!mobile || !password) {
    warn('No admin created: STEVE_PAY_ADMIN_MOBILE and STEVE_PAY_ADMIN_PASSWORD are not set.');
    detail('There is no self-service admin signup by design — an endpoint that mints an');
    detail('ADMIN would be the highest-value target in the system. Run:');
    log('');
    detail('  STEVE_PAY_ADMIN_MOBILE=09xxxxxxxxx STEVE_PAY_ADMIN_PASSWORD=... \\');
    detail('    npm run admin:create -- --remote');
    log('');
    return;
  }

  if (state.dryRun) {
    log(`would create admin ${mobile}`);
    return;
  }

  const args = ['scripts/create-admin.mjs', '--remote', '--yes', '--name', 'Administrator'];
  try {
    runChild('node', args, {
      env: { ...state.childEnv, STEVE_PAY_ADMIN_MOBILE: mobile, STEVE_PAY_ADMIN_PASSWORD: password },
    });
    log(`${green('Admin created.')} ${dim('Sign in at /login?scope=admin')}`);
  } catch (error) {
    fail('Admin creation failed.');
    detail(String(error.message));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function confirm(state) {
  if (state.yes) return;
  if (!stdin.isTTY) {
    fail('Not a terminal and --yes was not passed. Refusing to change a live account.');
    detail('Re-run with --yes to proceed non-interactively.');
    process.exit(1);
  }

  console.log(`\n${bold('About to provision:')}`);
  console.log(`  account     ${state.accountName} ${dim(state.account)}`);
  console.log(`  environments ${state.environments.join(', ')}`);
  console.log(`  phases      ${state.plan.join(' → ')}`);
  if (state.dryRun) console.log(`  ${yellow('dry run — nothing will be created or changed')}`);

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question('\nProceed? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Aborted. Nothing was created.');
      process.exit(0);
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const token = args.token ?? process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? null;
  if (!token) {
    fail('No API token. Pass --token, or set CLOUDFLARE_API_TOKEN.');
    console.log(`\n  Create one at ${bold('https://dash.cloudflare.com/profile/api-tokens')}`);
    console.log(`  with the permissions listed under ${bold('--help')}.\n`);
    process.exit(1);
  }
  if (args.token) {
    detail('A token passed on the command line is visible in your shell history and process list.');
    detail('Prefer CLOUDFLARE_API_TOKEN in the environment.');
  }

  const state = {
    token,
    account: args.account,
    accountName: null,
    dryRun: args.dryRun,
    yes: args.yes,
    forceConfig: args.forceConfig,
    turnstileSiteKey: args.turnstileSiteKey,
    suppliedSecrets: readSecretsFile(args.secrets),
    // One environment. `parseArgs` refuses anything else, so this is a list of one to keep
    // the `for (const envName of state.environments)` loops honest rather than a vestige.
    environments: [args.env],
    pagesUrl: null,
    // Both wrangler and the REST client authenticate from the environment, so a child
    // process can never pick up a *different* token than the one verified above.
    childEnv: { CLOUDFLARE_API_TOKEN: token },
    plan: args.only ?? PHASES.filter((name) => !(args.skip ?? []).includes(name)),
  };

  console.log(`\n${bold('Steve Pay')} ${dim('· Cloudflare provisioning')}`);
  if (state.dryRun) console.log(yellow('dry run — nothing will be created or changed'));

  const runners = {
    verify: phaseVerify,
    d1: phaseD1,
    kv: phaseKv,
    queues: phaseQueues,
    pages: phasePages,
    config: phaseConfig,
    migrate: phaseMigrate,
    secrets: phaseSecrets,
    deploy: phaseDeploy,
    admin: phaseAdmin,
  };

  // `verify` must run before anything else: it discovers the account id that every later
  // phase depends on, and a token without permissions should fail before it creates half
  // an account's worth of resources.
  if (!state.plan.includes('verify')) state.plan.unshift('verify');

  if (!state.plan.includes('config') && state.plan.some((name) => ['migrate', 'deploy'].includes(name))) {
    warn('Running migrate/deploy without the config phase may deploy against placeholder ids.');
  }

  try {
    await phaseVerify(state);
    state.childEnv.CLOUDFLARE_ACCOUNT_ID = state.account;

    await confirm(state);

    for (const name of state.plan) {
      if (name === 'verify') continue;

      // `confirm` printed the plan before the account was known; re-print it now with ids.
      const runner = runners[name];
      if (!runner) continue;
      await runner(state);
    }
  } catch (error) {
    console.error('');
    reportApiFailure(error, `phase "${currentPhase}"`);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log(`\n${bold(green('Done.'))}\n`);

  const row = (label, value) => console.log(`  ${label.padEnd(14)} ${value}`);

  row('account', `${state.accountName} ${dim(state.account)}`);
  if (state.d1) {
    for (const [envName, id] of Object.entries(state.d1)) row(`d1 ${envName}`, id);
  }
  if (state.kv) {
    for (const [envName, id] of Object.entries(state.kv)) row(`kv ${envName}`, id);
  }
  row('pages project', RESOURCES.production.project);
  row('companion', RESOURCES.production.jobs);
  if (state.pagesUrl) row('url', state.pagesUrl);

  console.log(`\n${bold('Next')}`);
  log(`1. Check the deployment health probe: ${state.pagesUrl ?? ''}/health should return {"status":"ok"}`);
  log('2. Open the site and confirm the pages render — that address is the origin every link uses');
  log('3. Attach your custom domain in the dashboard when you have one: Workers & Pages → your');
  detail('   Pages project → Custom domains. Nothing in the project needs to change; the next');
  detail('   request is served on the new host and every generated link follows it.');
  log(`4. Commit the config changes: ${dim('git add wrangler.jsonc wrangler.worker.jsonc && git commit')}`);
  log('5. Sign in at /login?scope=admin and approve the first merchant');
  if (!state.turnstileSiteKey) {
    log(`6. Turnstile is switched off until a site key is set: ${dim('--turnstile-site-key <key>')} plus the secret`);
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    log(`${state.turnstileSiteKey ? '7' : '5'}. Telegram is off until TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID are set,`);
    detail('   then register the webhook with the Telegram API — the script does not call Telegram.');
  }
  console.log('');
  console.log(`  ${yellow('Keep .cloudflare.secrets.*.json')} — losing API_KEY_PEPPER invalidates every API key.`);
  console.log('');
}

await main();
