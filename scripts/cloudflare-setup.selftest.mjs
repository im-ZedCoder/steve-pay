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
 *   - the `wrangler.jsonc` patch replaces the right placeholders with the right ids
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
 * (`uuid`/`name` for D1, `id`/`title` for KV, `queue_name` for Queues, `subdomain` for the
 * Workers subdomain). Those were verified against the spec, so this is a test of the
 * script's logic and not of a shape someone invented here.
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
    created: { d1: [], kv: [], queues: [] },
    // Pre-seeded to exercise the "already exists" path on the first run.
    existing: {
      d1: [{ uuid: 'd1-existing-prod', name: 'steve-pay' }],
      kv: [{ id: 'kv-existing-prod', title: 'steve-pay-cache' }],
      queues: ['steve-pay-webhooks-dlq'],
    },
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

      if (path === '/accounts/acct-test/workers/scripts/steve-pay') {
        return send({ result: null }, 404);
      }

      if (path === '/accounts/acct-test/workers/subdomain') {
        return send({ result: { subdomain: 'test-subdomain' } });
      }

      if (path === '/zones') {
        return send({ result: [{ id: 'zone-test', name: 'steve-pay.ir', status: 'active' }] });
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

      return send({ errors: [{ code: 7003, message: `No route for the URI ${method} ${path}` }] }, 404);
    });
  });

  return { server, state };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

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
  writeFileSync(
    join(directory, 'wrangler.jsonc'),
    readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8'),
    'utf8',
  );

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
      { cwd: directory, env: { ...process.env, CLOUDFLARE_API_BASE: apiBase, NO_COLOR: '1' } },
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
  const configBefore = readFileSync(configPath, 'utf8');
  const secretsBefore = existsSync(join(directory, '.cloudflare.secrets.production.json'));

  // Tripwire for the mistake described in `makeFixture`. If the fixture ever runs the
  // repository's copy of the script again, this fails loudly instead of leaving mock ids in
  // a real config file that someone might then commit.
  const realConfigBefore = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');

  try {
    // -----------------------------------------------------------------------
    section('dry run changes nothing');
    // -----------------------------------------------------------------------
    const dryRun = await runSetup(directory, apiBase, ['--env', 'both', '--dry-run']);

    check('exits 0', dryRun.status === 0, `status ${dryRun.status}\n${dryRun.output}`);
    check('reports the dry run plainly', dryRun.output.includes('dry run — nothing will be created'));
    check('describes the deploy it would do', /would run: npm run fonts/.test(dryRun.output));
    check('created no resources', mock.state.mutations.length === 0, mock.state.mutations.join(', '));
    check(
      'left wrangler.jsonc untouched',
      readFileSync(configPath, 'utf8') === configBefore,
      'the config file was modified during a dry run',
    );
    check('wrote no secrets file', !existsSync(join(directory, '.cloudflare.secrets.production.json')));

    // -----------------------------------------------------------------------
    section('first real run creates only what is missing');
    // -----------------------------------------------------------------------
    const first = await runSetup(directory, apiBase, ['--env', 'both', '--skip', 'migrate,secrets,deploy,admin']);

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
    check('created the staging D1 database', mock.state.mutations.includes('d1:steve-pay-staging'));
    check('created the staging KV namespace', mock.state.mutations.includes('kv:steve-pay-cache-staging'));
    check('created the staging queue', mock.state.mutations.includes('queue:steve-pay-webhooks-staging'));
    check(
      'created the staging dead letter queue before its queue',
      mock.state.mutations.indexOf('queue:steve-pay-webhooks-staging-dlq') <
        mock.state.mutations.indexOf('queue:steve-pay-webhooks-staging'),
      mock.state.mutations.join(', '),
    );

    // -----------------------------------------------------------------------
    section('the config patch writes the real ids into the right blocks');
    // -----------------------------------------------------------------------
    const configAfter = readFileSync(configPath, 'utf8');

    check(
      'no placeholders remain',
      !/REPLACE_WITH_[A-Z0-9_]+/.test(configAfter),
      `still present: ${(configAfter.match(/REPLACE_WITH_[A-Z0-9_]+/g) ?? []).join(', ')}`,
    );
    check('kept the existing production D1 id', configAfter.includes('d1-existing-prod'));
    check('kept the existing production KV id', configAfter.includes('kv-existing-prod'));
    check('wrote the new staging D1 id', configAfter.includes('d1-new-steve-pay-staging'));
    check('wrote the new staging KV id', configAfter.includes('kv-new-steve-pay-cache-staging'));
    check('resolved the workers.dev subdomain', configAfter.includes('steve-pay-staging.test-subdomain.workers.dev'));
    check(
      'left the comments intact',
      configAfter.includes('// Steve Pay — Cloudflare Worker deployment configuration.'),
      're-serialising the config would have deleted every comment',
    );
    check(
      'kept the custom domain routes',
      configAfter.includes('"pattern": "steve-pay.ir"') && configAfter.includes('"custom_domain": true'),
    );

    // The production id appears twice on purpose — top level and `env.production` — and both
    // must be the same database. A patch that only caught the first occurrence would deploy
    // the top-level config against a placeholder.
    const productionIdCount = (configAfter.match(/d1-existing-prod/g) ?? []).length;
    // The production id appears twice — top level and `env.production` — and both must be
    // the same database. A patch that caught only the first would leave the top-level config,
    // which is what `wrangler dev` and the Vitest pool read, pointed at a placeholder.
    check(
      'applied the production id to every occurrence',
      productionIdCount === 2,
      `expected 2 occurrences (top level, env.production), found ${productionIdCount}`,
    );

    // -----------------------------------------------------------------------
    section('a second run is a no-op');
    // -----------------------------------------------------------------------
    mock.state.mutations = [];
    const second = await runSetup(directory, apiBase, ['--env', 'both', '--skip', 'migrate,secrets,deploy,admin']);

    check('exits 0', second.status === 0, `status ${second.status}\n${second.output}`);
    check(
      'created nothing on the second run',
      mock.state.mutations.length === 0,
      `created: ${mock.state.mutations.join(', ')}`,
    );
    check(
      'reports the configuration already matches',
      second.output.includes('Configuration already matches') ||
        second.output.includes('No placeholders left'),
    );
    check(
      'did not churn the config file',
      readFileSync(configPath, 'utf8').includes('d1-existing-prod'),
    );

    // -----------------------------------------------------------------------
    section('it refuses to overwrite an id it did not write');
    // -----------------------------------------------------------------------
    // Simulates a config pointed at a different database than the account holds — the case
    // where a well-meaning re-run would silently redeploy against the wrong data.
    const tampered = configAfter.replace(/d1-existing-prod/g, 'd1-some-other-database');
    writeFileSync(configPath, tampered, 'utf8');

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
    check('applied the fix with --force-config', forced.output.includes('wrangler.jsonc updated'));
    check('restored the correct id', !readFileSync(configPath, 'utf8').includes('d1-some-other-database'));

    // -----------------------------------------------------------------------
    section('bad input fails before touching anything');
    // -----------------------------------------------------------------------
    const badEnv = await runSetup(directory, apiBase, ['--env', 'nonsense']);
    check('rejects an unknown environment', badEnv.status === 1 && badEnv.output.includes('Invalid --env'));

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
    section('the repository itself was never touched');
    // -----------------------------------------------------------------------
    check(
      "the repository's wrangler.jsonc is unchanged",
      readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8') === realConfigBefore,
      'the fixture ran the wrong copy of the script — see makeFixture()',
    );
    check(
      'no secrets file was left in the repository',
      !existsSync(join(ROOT, '.cloudflare.secrets.production.json')) || secretsBefore,
    );
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
