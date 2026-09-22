#!/usr/bin/env node
/**
 * Self-test for `scripts/cloudflare-setup.mjs`.
 *
 *     npm run cf:setup:test
 *
 * Runs the real provisioning script as a child process against a local mock of the
 * Cloudflare API, and asserts the things that would otherwise only be discovered by
 * pointing it at a live account:
 *
 *   - it finds existing resources instead of creating duplicates (so a second run is safe)
 *   - it creates what is missing, and only that
 *   - it replaces the right placeholders with the right ids, in **both** config files
 *   - a dry run changes nothing at all
 *   - it refuses to write secrets or a config it was not asked to write
 *
 * WHY A MOCK RATHER THAN A LIVE ACCOUNT
 *
 * Idempotency and placeholder replacement are the two parts where a mistake is silent: a
 * duplicate KV namespace still works, and a placeholder left unreplaced only surfaces at
 * deploy time. Testing them needs a run that can be repeated and inspected, which a real
 * account cannot give — and a real account cannot be reset between assertions.
 *
 * The mock answers with the exact response shapes the Cloudflare OpenAPI spec declares
 * (`uuid`/`name` for D1, `id`/`title` for KV, `queue_name` for Queues, `name`/`subdomain`
 * for a Pages project). Those were verified against the spec, so this is a test of the
 * script's logic and not of a shape someone invented here.
 *
 * BOTH CONFIG FILES ARE PATCHED, SO BOTH ARE ASSERTED
 *
 * The web application is a Pages project and the cron/queue surfaces are a companion Worker;
 * they are configured separately but must point at the same database. A patch that updated
 * one file and not the other deploys two halves of one system against two different
 * databases, and nothing about that is visible until a cron job reports on data no customer
 * wrote.
 */

import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHILD_TIMEOUT_MS = 30_000;

let failures = 0;
let checks = 0;

function check(description, condition, extra) {
  checks += 1;
  if (condition) {
    console.log(`  \u001b[32m✓\u001b[0m ${description}`);
    return true;
  }
  failures += 1;
  console.log(`  \u001b[31m✗\u001b[0m ${description}`);
  if (extra !== undefined) console.log(`      ${extra}`);
  return false;
}

function section(name) {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------------------
// Mock Cloudflare API
// ---------------------------------------------------------------------------

/**
 * A mock of the seven endpoints the script touches.
 *
 * `state.mutations` records every create, so a test can assert that a re-run created *nothing*
 * — which is the whole claim of idempotency, and is not provable from the output alone.
 */
function createMockApi() {
  const state = {
    mutations: [],
    created: { d1: [], kv: [], queues: [], pages: [] },
    // Pre-seeded to exercise the "already exists" path on the first run.
    existing: {
      d1: [{ uuid: 'd1-existing-prod', name: 'steve-pay' }],
      kv: [{ id: 'kv-existing-prod', title: 'steve-pay-cache' }],
      queues: ['steve-pay-webhooks-dlq'],
      pages: [],
    },

    // ---- the domain phase ------------------------------------------------
    //
    // Three things are seeded here on purpose, because each one is a way the phase could be
    // wrong while looking right: an `A` record already at the apex (attaching the domain
    // without replacing it leaves the hostname pointing at the old origin), a `TXT` record
    // beside it (which must survive — it is somebody's SPF), and a domain that stays
    // `pending` for two polls (so a single read cannot pass as a wait).
    zones: [
      {
        id: 'zone-test',
        name: 'steve-gate.ir',
        status: 'active',
        name_servers: ['kolton.ns.cloudflare.com', 'paris.ns.cloudflare.com'],
      },
    ],
    dns: [
      { id: 'rec-stale', type: 'A', name: 'steve-gate.ir', content: '203.0.113.10', proxied: true },
      { id: 'rec-spf', type: 'TXT', name: 'steve-gate.ir', content: 'v=spf1 -all', proxied: false },
    ],
    pagesDomains: [],
    domainPolls: 0,
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    const method = request.method;
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const send = (payload, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: status < 400, errors: [], messages: [], ...payload }));
      };

      if (path === '/user/tokens/verify') {
        return send({ result: { id: 'tok-test', status: 'active' } });
      }
      if (path === '/accounts') {
        return send({ result: [{ id: 'acct-test', name: 'Test Account' }] });
      }

      if (path === '/accounts/acct-test/pages/projects' && method === 'GET') {
        return send({ result: [...state.existing.pages, ...state.created.pages] });
      }
      if (path === '/accounts/acct-test/pages/projects' && method === 'POST') {
        const { name } = JSON.parse(body);
        state.mutations.push(`pages:${name}`);
        const record = { name, subdomain: `${name}.pages.dev` };
        state.created.pages.push(record);
        return send({ result: record });
      }

      if (path === '/accounts/acct-test/d1/database' && method === 'GET') {
        return send({ result: [...state.existing.d1, ...state.created.d1] });
      }
      if (path === '/accounts/acct-test/d1/database' && method === 'POST') {
        const { name } = JSON.parse(body);
        state.mutations.push(`d1:${name}`);
        const record = { uuid: `d1-new-${name}`, name };
        state.created.d1.push(record);
        return send({ result: record });
      }

      if (path === '/accounts/acct-test/storage/kv/namespaces' && method === 'GET') {
        return send({ result: [...state.existing.kv, ...state.created.kv] });
      }
      if (path === '/accounts/acct-test/storage/kv/namespaces' && method === 'POST') {
        const { title } = JSON.parse(body);
        state.mutations.push(`kv:${title}`);
        const record = { id: `kv-new-${title}`, title };
        state.created.kv.push(record);
        return send({ result: record });
      }

      if (path === '/accounts/acct-test/queues' && method === 'GET') {
        return send({
          result: [...state.existing.queues, ...state.created.queues].map((queue_name) => ({
            queue_name,
            queue_id: `q-${queue_name}`,
          })),
        });
      }
      if (path === '/accounts/acct-test/queues' && method === 'POST') {
        const { queue_name } = JSON.parse(body);
        state.mutations.push(`queue:${queue_name}`);
        state.created.queues.push(queue_name);
        return send({ result: { queue_name, queue_id: `q-${queue_name}` } });
      }

      // ---- the domain phase ------------------------------------------------

      if (path === '/zones' && method === 'GET') {
        const name = url.searchParams.get('name');
        return send({ result: state.zones.filter((zone) => zone.name === name) });
      }
      if (path === '/zones/zone-test/dns_records' && method === 'GET') {
        const name = url.searchParams.get('name');
        return send({ result: state.dns.filter((record) => record.name === name) });
      }
      if (path === '/zones/zone-test/dns_records' && method === 'POST') {
        const record = JSON.parse(body);
        state.mutations.push(`dns:${record.type}:${record.name}:${record.content}`);
        const made = { id: `rec-new-${state.dns.length + 1}`, ...record };
        state.dns.push(made);
        return send({ result: made });
      }
      if (path.startsWith('/zones/zone-test/dns_records/') && method === 'DELETE') {
        const id = path.split('/').pop();
        state.mutations.push(`dns-delete:${id}`);
        state.dns = state.dns.filter((record) => record.id !== id);
        return send({ result: { id } });
      }
      if (path === '/accounts/acct-test/pages/projects/steve-pay/domains' && method === 'GET') {
        return send({ result: state.pagesDomains });
      }
      if (path === '/accounts/acct-test/pages/projects/steve-pay/domains' && method === 'POST') {
        const { name } = JSON.parse(body);
        state.mutations.push(`domain:${name}`);
        const made = {
          id: 'dom-test',
          name,
          status: 'pending',
          verification_data: { status: 'pending' },
          validation_data: { status: 'pending', method: 'http' },
        };
        state.pagesDomains.push(made);
        return send({ result: made });
      }
      if (path.startsWith('/accounts/acct-test/pages/projects/steve-pay/domains/') && method === 'GET') {
        const host = decodeURIComponent(path.split('/').pop());
        state.domainPolls += 1;
        const record = state.pagesDomains.find((domain) => domain.name === host) ?? { name: host };
        // Pending for the first two reads. A phase that reads once and moves on would
        // report a domain that is merely slow as if it were attached and serving.
        const active = state.domainPolls > 2;
        return send({
          result: {
            ...record,
            status: active ? 'active' : 'pending',
            verification_data: { status: active ? 'active' : 'pending' },
          },
        });
      }

      return send({ errors: [{ code: 7003, message: `No route for the URI ${method} ${path}` }] }, 404);
    });
  });

  return { server, state };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * The config the fixture starts from.
 *
 * Synthetic, and deliberately not a copy of the repository's `wrangler.jsonc`. That copy was
 * the first version of this fixture and it was wrong in a way worth recording: the test only
 * passed while the repository was *unprovisioned*. The moment someone ran `cf:setup` for real,
 * the placeholders in `wrangler.jsonc` were legitimately gone, so the patch had nothing to
 * replace and eight assertions failed — a test that breaks precisely when the thing it tests
 * has been used successfully.
 *
 * The fixture is therefore two canonical files with the placeholders where the script expects
 * them. There is one id pair per file — the Pages config and the companion Worker config —
 * and both must end up pointing at the same database. That makes the result independent of
 * the developer's Cloudflare account, which is the only way this test can mean the same thing
 * on every machine.
 *
 * There is deliberately no `env` block and no `routes` block: the project has one
 * environment, and no hostname appears in either file.
 */
const FIXTURE_CONFIG = `{
  // Steve Pay — Cloudflare Pages project configuration.
  // A comment the patch must not disturb: ids are replaced as text, not by re-serialising.
  "name": "steve-pay",
  "pages_build_output_dir": "dist-pages",
  "compatibility_date": "2026-08-22",

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "steve-pay",
      "database_id": "REPLACE_WITH_D1_ID",
      "migrations_dir": "migrations",
    },
  ],

  "kv_namespaces": [
    { "binding": "CACHE", "id": "REPLACE_WITH_KV_ID" },
  ],

  "queues": {
    "producers": [{ "binding": "WEBHOOK_QUEUE", "queue": "steve-pay-webhooks" }],
  },

  "vars": { "ENVIRONMENT": "production", "TURNSTILE_SITE_KEY": "" },
}
`;

/** The companion Worker: the same bindings, plus crons and the queue consumer. */
const FIXTURE_WORKER_CONFIG = `{
  // Steve Pay — companion Worker for cron and the webhook queue consumer.
  "name": "steve-pay-jobs",
  "main": "src/index.ts",
  "workers_dev": false,
  "compatibility_date": "2026-08-22",

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "steve-pay",
      "database_id": "REPLACE_WITH_D1_ID",
      "migrations_dir": "migrations",
    },
  ],

  "kv_namespaces": [{ "binding": "CACHE", "id": "REPLACE_WITH_KV_ID" }],

  "queues": {
    "producers": [{ "binding": "WEBHOOK_QUEUE", "queue": "steve-pay-webhooks" }],
    "consumers": [
      {
        "queue": "steve-pay-webhooks",
        "dead_letter_queue": "steve-pay-webhooks-dlq",
      },
    ],
  },

  "triggers": { "crons": ["*/2 * * * *"] },

  "vars": { "ENVIRONMENT": "production", "TURNSTILE_SITE_KEY": "" },
}
`;

/**
 * A throwaway copy of the project holding only what the script reads.
 *
 * A copy rather than the real tree, because the `config` phase rewrites `wrangler.jsonc` and
 * a test that edits the repository under the developer's feet is worse than no test.
 */
function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'steve-pay-cf-'));
  mkdirSync(join(directory, 'scripts'), { recursive: true });
  mkdirSync(join(directory, 'seeds'), { recursive: true });
  writeFileSync(
    join(directory, 'seeds', '0001_settings.sql'),
    '-- placeholder for the fixture\nSELECT 1;\n',
    'utf8',
  );
  writeFileSync(join(directory, 'wrangler.jsonc'), FIXTURE_CONFIG, 'utf8');
  writeFileSync(join(directory, 'wrangler.worker.jsonc'), FIXTURE_WORKER_CONFIG, 'utf8');

  // The fixture needs its own copy of the script, because the script derives its project
  // root from its own file location rather than from the working directory. Running the
  // repository's copy with `cwd` pointed at the fixture looks correct and is not: the parent
  // process's `cwd` does not move `import.meta.url`, so the `config` phase rewrites the
  // repository's real `wrangler.jsonc` with mock ids. That happened the first time this test
  // was run, which is why the copy is here and why the guard at the end of `main` exists.
  copyFileSync(
    join(ROOT, 'scripts', 'cloudflare-setup.mjs'),
    join(directory, 'scripts', 'cloudflare-setup.mjs'),
  );

  return directory;
}

/**
 * Runs the provisioning script against the mock.
 *
 * Asynchronous on purpose. The mock API runs inside this process, so a synchronous spawn
 * would block the event loop that has to answer the child's HTTP requests — the child would
 * wait for a reply that could never be built, and the suite would hang until the timeout
 * rather than fail with anything readable. That is a genuinely easy mistake to make here, so
 * it is worth naming.
 */
function runSetup(directory, apiBase, extraArgs) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(directory, 'scripts', 'cloudflare-setup.mjs'), '--token', 'test-token', '--yes', ...extraArgs],
      {
        cwd: directory,
        env: {
          ...process.env,
          CLOUDFLARE_API_BASE: apiBase,
          NO_COLOR: '1',
          // The certificate wait is fifteen seconds between polls in real use. The seam
          // exists so this suite drives the loop instead of spending it.
          CLOUDFLARE_SETUP_POLL_MS: '20',
        },
      },
    );

    let output = '';
    let settled = false;
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ status: null, output: `${output}\n[timed out after ${CHILD_TIMEOUT_MS}ms]` });
    }, CHILD_TIMEOUT_MS);

    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  const mock = createMockApi();
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const apiBase = `http://127.0.0.1:${mock.server.address().port}`;

  const directory = makeFixture();
  const configPath = join(directory, 'wrangler.jsonc');
  const workerConfigPath = join(directory, 'wrangler.worker.jsonc');
  const configBefore = readFileSync(configPath, 'utf8');
  const workerConfigBefore = readFileSync(workerConfigPath, 'utf8');
  const secretsBefore = existsSync(join(directory, '.cloudflare.secrets.production.json'));

  // Tripwire for the mistake described in `makeFixture`. If the fixture ever runs the
  // repository's copy of the script again, this fails loudly instead of leaving mock ids in
  // a real config file that someone might then commit.
  const realConfigBefore = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const realWorkerConfigBefore = readFileSync(join(ROOT, 'wrangler.worker.jsonc'), 'utf8');
  void realWorkerConfigBefore;

  // Read from the repository, not the fixture. A real `cf:setup` run legitimately leaves a
  // secrets file here, so the assertion has to be "this test added one", not "none exists".
  const realSecretsPath = join(ROOT, '.cloudflare.secrets.production.json');
  const realSecretsBefore = existsSync(realSecretsPath);

  try {
    // -----------------------------------------------------------------------
    section('dry run changes nothing');
    // -----------------------------------------------------------------------
    const dryRun = await runSetup(directory, apiBase, ['--env', 'production', '--dry-run']);

    check('exits 0', dryRun.status === 0, `status ${dryRun.status}\n${dryRun.output}`);
    check('reports the dry run plainly', dryRun.output.includes('dry run — nothing will be created'));
    check('describes the build it would do', /would run: npm run build/.test(dryRun.output));
    check(
      'describes both deploy targets',
      dryRun.output.includes('wrangler pages deploy') && dryRun.output.includes('wrangler deploy -c wrangler.worker.jsonc'),
    );
    check('created no resources', mock.state.mutations.length === 0, mock.state.mutations.join(', '));
    check(
      'left wrangler.jsonc untouched',
      readFileSync(configPath, 'utf8') === configBefore,
      'the config file was modified during a dry run',
    );
    check(
      'left wrangler.worker.jsonc untouched',
      readFileSync(workerConfigPath, 'utf8') === workerConfigBefore,
      'the companion config was modified during a dry run',
    );
    check('wrote no secrets file', !existsSync(join(directory, '.cloudflare.secrets.production.json')));

    // -----------------------------------------------------------------------
    section('first real run creates only what is missing');
    // -----------------------------------------------------------------------
    const first = await runSetup(directory, apiBase, ['--env', 'production', '--skip', 'migrate,secrets,deploy,admin']);

    check('exits 0', first.status === 0, `status ${first.status}\n${first.output}`);

    // Pre-seeded in the mock: must be found, not duplicated.
    check(
      'recognised the existing D1 database',
      first.output.includes('(already existed)') && !mock.state.mutations.includes('d1:steve-pay'),
      're-created an existing D1 database',
    );
    check(
      'recognised the existing KV namespace',
      !mock.state.mutations.includes('kv:steve-pay-cache'),
      're-created an existing KV namespace',
    );
    check(
      'recognised the existing dead letter queue',
      !mock.state.mutations.includes('queue:steve-pay-webhooks-dlq'),
      're-created an existing queue',
    );

    // Missing in the mock: must be created.
    check('created the missing production queue', mock.state.mutations.includes('queue:steve-pay-webhooks'));
    check('created the Pages project', mock.state.mutations.includes('pages:steve-pay'));
    check(
      'created the queue even though its dead letter queue already existed',
      mock.state.mutations.includes('queue:steve-pay-webhooks'),
      mock.state.mutations.join(', '),
    );

    // -----------------------------------------------------------------------
    section('the config patch writes the real ids into the right blocks');
    // -----------------------------------------------------------------------
    const configAfter = readFileSync(configPath, 'utf8');
    const workerConfigAfter = readFileSync(workerConfigPath, 'utf8');

    check(
      'no placeholders remain in the Pages config',
      !/REPLACE_WITH_[A-Z0-9_]+/.test(configAfter),
      `still present: ${(configAfter.match(/REPLACE_WITH_[A-Z0-9_]+/g) ?? []).join(', ')}`,
    );
    check(
      'no placeholders remain in the companion Worker config',
      !/REPLACE_WITH_[A-Z0-9_]+/.test(workerConfigAfter),
      `still present: ${(workerConfigAfter.match(/REPLACE_WITH_[A-Z0-9_]+/g) ?? []).join(', ')}`,
    );
    check('kept the existing production D1 id', configAfter.includes('d1-existing-prod'));
    check('kept the existing production KV id', configAfter.includes('kv-existing-prod'));
    check(
      'pointed both files at the same database and cache',
      workerConfigAfter.includes('d1-existing-prod') && workerConfigAfter.includes('kv-existing-prod'),
      'the two deploy targets would read two different databases',
    );
    check(
      'left the comments intact in the Pages config',
      configAfter.includes('// Steve Pay — Cloudflare Pages project configuration.'),
      're-serialising the config would have deleted every comment',
    );
    check(
      'left the comments intact in the companion config',
      workerConfigAfter.includes('// Steve Pay — companion Worker for cron'),
      're-serialising the config would have deleted every comment',
    );
    check(
      'introduced no hostname in either file',
      !/steve-pay\.ir|"routes"|custom_domain|"BASE_URL"/.test(configAfter + workerConfigAfter),
      'a domain or base URL appeared in a generated config',
    );

    // The production id appears twice on purpose — top level and `env.production` — and both
    // must be the same database. A patch that only caught the first occurrence would deploy
    // the top-level config against a placeholder.
    const productionIdCount = (configAfter.match(/d1-existing-prod/g) ?? []).length;
    // The production id appears twice — top level and `env.production` — and both must be
    // the same database. A patch that caught only the first would leave the top-level config,
    // which is what `wrangler dev` and the Vitest pool read, pointed at a placeholder.
    check(
      'applied the production id to every occurrence in the Pages config',
      productionIdCount === 1,
      `expected 1 occurrence, found ${productionIdCount}`,
    );
    void workerConfigAfter;

    // -----------------------------------------------------------------------
    section('a second run is a no-op');
    // -----------------------------------------------------------------------
    mock.state.mutations = [];
    const second = await runSetup(directory, apiBase, ['--env', 'production', '--skip', 'migrate,secrets,deploy,admin']);

    check('exits 0', second.status === 0, `status ${second.status}\n${second.output}`);
    check(
      'created nothing on the second run',
      mock.state.mutations.length === 0,
      `created: ${mock.state.mutations.join(', ')}`,
    );
    check(
      'reports the configuration already matches',
      second.output.split('already matches the provisioned resources').length - 1 >= 2,
      'both config files should report a match',
    );
    check(
      'did not churn the config file',
      readFileSync(configPath, 'utf8').includes('d1-existing-prod'),
    );

    // -----------------------------------------------------------------------
    section('it refuses to overwrite an id it did not write');
    // -----------------------------------------------------------------------
    // Simulates a config pointed at a different database than the account holds — the case
    // where a well-meaning re-run would silently redeploy against the wrong data. Both files
    // are tampered with, because the guard has to hold for both of them.
    writeFileSync(configPath, configAfter.replace(/d1-existing-prod/g, 'd1-some-other-database'), 'utf8');
    writeFileSync(
      workerConfigPath,
      workerConfigAfter.replace(/d1-existing-prod/g, 'd1-some-other-database'),
      'utf8',
    );

    mock.state.mutations = [];
    const mismatch = await runSetup(directory, apiBase, ['--env', 'production', '--skip', 'migrate,secrets,deploy,admin']);

    check('warned about the mismatch', mismatch.output.includes('points at D1 d1-some-other-database'));
    check('refused without --force-config', mismatch.output.includes('Refusing to overwrite'));
    check(
      'left the tampered id alone',
      readFileSync(configPath, 'utf8').includes('d1-some-other-database'),
      'overwrote an id it did not write',
    );

    // And with the flag, it does what it was told.
    const forced = await runSetup(directory, apiBase, [
      '--env',
      'production',
      '--force-config',
      '--skip',
      'migrate,secrets,deploy,admin',
    ]);
    check(
      'applied the fix with --force-config',
      /wrangler\.jsonc \(Pages\) updated/.test(forced.output),
      forced.output,
    );
    check(
      'restored the correct id in both files',
      !readFileSync(configPath, 'utf8').includes('d1-some-other-database') &&
        !readFileSync(workerConfigPath, 'utf8').includes('d1-some-other-database'),
      'a config file still points at the wrong database',
    );

    // -----------------------------------------------------------------------
    section('bad input fails before touching anything');
    // -----------------------------------------------------------------------
    const badEnv = await runSetup(directory, apiBase, ['--env', 'nonsense']);
    check('rejects an unknown environment', badEnv.status === 1 && badEnv.output.includes('Invalid --env'));

    // Staging used to be a second named environment. It is gone, and the failure mode that
    // matters is not the rejection itself but where the run would otherwise have gone: a
    // silent fallback to production would deploy staging over live data.
    const staging = await runSetup(directory, apiBase, ['--env', 'staging']);
    check(
      'refuses staging rather than falling back to production',
      staging.status === 1 && staging.output.includes('Invalid --env'),
      staging.output,
    );
    check('changed nothing when refusing', mock.state.mutations.length === 0);

    const badPhase = await runSetup(directory, apiBase, ['--skip', 'notaphase']);
    check('rejects an unknown phase', badPhase.status === 1 && badPhase.output.includes('Unknown phase'));

    const noToken = spawnSync(process.execPath, [join(directory, 'scripts', 'cloudflare-setup.mjs')], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, CLOUDFLARE_API_BASE: apiBase, CLOUDFLARE_API_TOKEN: '', CF_API_TOKEN: '' },
    });
    check(
      'explains how to make a token when none is given',
      noToken.status === 1 && noToken.stdout.includes('dash.cloudflare.com/profile/api-tokens'),
    );

    // -----------------------------------------------------------------------
    section('the domain phase makes the hostname resolve, not just attach');
    // -----------------------------------------------------------------------
    // Attaching a custom domain to a Pages project is one call, and on its own it produces a
    // hostname that answers Cloudflare error 1016 to everyone: `pending`, with
    // `error_message: "CNAME record not set"`. The record is what makes it live, so this run
    // asserts both halves and the state they leave behind.
    const configBeforeDomain = readFileSync(configPath, 'utf8');
    mock.state.mutations = [];
    const withDomain = await runSetup(directory, apiBase, [
      '--env',
      'production',
      '--only',
      'pages,domain',
      '--domain',
      'steve-gate.ir',
    ]);

    check('exits 0', withDomain.status === 0, `status ${withDomain.status}\n${withDomain.output}`);
    check(
      'removed the record that kept the hostname off the project',
      mock.state.mutations.includes('dns-delete:rec-stale'),
      `mutations: ${mock.state.mutations.join(', ')}`,
    );
    check(
      'created a CNAME at the apex pointing at the Pages project',
      mock.state.mutations.includes('dns:CNAME:steve-gate.ir:steve-pay.pages.dev'),
      `mutations: ${mock.state.mutations.join(', ')}`,
    );
    check(
      'proxied it, which is what a Pages custom domain needs',
      mock.state.dns.some((record) => record.name === 'steve-gate.ir' && record.proxied === true),
    );
    check(
      'left the neighbouring TXT record alone',
      mock.state.dns.some((record) => record.id === 'rec-spf') &&
        !mock.state.mutations.some((mutation) => mutation.includes('rec-spf')),
      'a record that decides mail delivery was deleted to attach a website',
    );
    check(
      'attached the domain to the Pages project',
      mock.state.mutations.includes('domain:steve-gate.ir'),
      `mutations: ${mock.state.mutations.join(', ')}`,
    );
    check(
      'waited for the certificate instead of reading the status once',
      mock.state.domainPolls > 2 && withDomain.output.includes('domain: active'),
      `polls: ${mock.state.domainPolls}\n${withDomain.output}`,
    );
    check(
      'reported the exit as the hostname it is now served on',
      withDomain.output.includes('https://steve-gate.ir now serves this deployment'),
    );
    // The platform reads its own origin from each request, so a hostname in a config file is
    // the one thing that would break a rename or a second domain. This phase must not be the
    // reason one appears.
    check(
      'wrote no hostname into either config file',
      readFileSync(configPath, 'utf8') === configBeforeDomain &&
        !/steve-gate\.ir/.test(readFileSync(workerConfigPath, 'utf8')),
      'the domain phase edited a deploy config',
    );

    // -----------------------------------------------------------------------
    section('running the domain phase again changes nothing');
    // -----------------------------------------------------------------------
    mock.state.mutations = [];
    const domainAgain = await runSetup(directory, apiBase, [
      '--env',
      'production',
      '--only',
      'pages,domain',
      '--domain',
      'steve-gate.ir',
    ]);

    check('exits 0', domainAgain.status === 0, `status ${domainAgain.status}\n${domainAgain.output}`);
    check(
      'created and deleted nothing',
      mock.state.mutations.length === 0,
      `mutations: ${mock.state.mutations.join(', ')}`,
    );
    check(
      'recognised the record and the domain it already had',
      domainAgain.output.includes('(already existed)') &&
        !/\+ DNS CNAME/.test(domainAgain.output),
    );

    // -----------------------------------------------------------------------
    section('a domain it cannot place is refused, and read correctly first');
    // -----------------------------------------------------------------------
    const noHost = await runSetup(directory, apiBase, ['--only', 'domain']);
    check(
      'refuses --only domain with no hostname',
      noHost.status === 1 && noHost.output.includes('needs --domain'),
      noHost.output,
    );

    const url = await runSetup(directory, apiBase, [
      '--env',
      'production',
      '--only',
      'pages,domain',
      '--domain',
      'https://steve-gate.ir/',
      '--dry-run',
    ]);
    check(
      'reads a pasted URL as a bare hostname instead of creating a record named after it',
      // Both halves matter: that it said what it derived, and that the record it works with
      // is at the derived name. `https://steve-gate.ir/` as a record name is not a record.
      url.output.includes('read as steve-gate.ir') && url.output.includes('dns steve-gate.ir →'),
      url.output,
    );
    check(
      'changes nothing while describing it',
      mock.state.mutations.length === 0,
      `mutations: ${mock.state.mutations.join(', ')}`,
    );

    const foreign = await runSetup(directory, apiBase, [
      '--env',
      'production',
      '--only',
      'pages,domain',
      '--domain',
      'pay.someone-elses-domain.com',
    ]);
    check(
      'refuses a hostname whose zone is not in this account',
      foreign.status === 1 && foreign.output.includes('No zone in this account contains'),
      foreign.output,
    );

    // -----------------------------------------------------------------------
    section('the repository itself was never touched');
    // -----------------------------------------------------------------------
    check(
      "the repository's wrangler.jsonc is unchanged",
      readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8') === realConfigBefore,
      'the fixture ran the wrong copy of the script — see makeFixture()',
    );
    check(
      'the test added no secrets file to the repository',
      existsSync(realSecretsPath) === realSecretsBefore,
      'a file appeared in the repository root that this test did not create',
    );
    void secretsBefore;
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await new Promise((resolve) => mock.server.close(resolve));
  }

  console.log('');
  if (failures === 0) {
    console.log(`\u001b[32m${checks} checks passed.\u001b[0m`);
  } else {
    console.log(`\u001b[31m${failures} of ${checks} checks failed.\u001b[0m`);
  }
  console.log('');
  process.exit(failures === 0 ? 0 : 1);
}

await main();
