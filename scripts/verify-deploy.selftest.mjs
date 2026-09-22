#!/usr/bin/env node
/**
 * Proves `scripts/verify-deploy.mjs` fails an incomplete deploy.
 *
 * WHY THIS TEST EXISTS
 *
 * The verification script is the last thing standing between a push and a system that looks
 * deployed and is not: the site answering every page while nothing expires an invoice and no
 * webhook is ever retried. A gate that only ever says yes is worse than no gate, because it
 * is believed.
 *
 * So this runs it against a mock of the Cloudflare API and asserts the cases that matter:
 *
 *   - a complete deploy passes;
 *   - a deploy missing a cron trigger fails, naming the cron;
 *   - a deploy whose queue consumer is absent, or is not this Worker, or has no dead-letter
 *     queue, fails;
 *   - a site whose Pages project is missing a secret it cannot resolve fails — the case this
 *     suite gained after a live deployment served every public page with both consoles
 *     answering 500, which `/health` reported as fine.
 *
 * It also asserts the token never reaches stdout — the script prints API error bodies, and
 * an authorization header is exactly the kind of thing that leaks into a build log.
 *
 * The API is mocked at the HTTP layer rather than by injecting a client, which is why
 * `verify-deploy.mjs` honours `CLOUDFLARE_API_BASE`: the process, its argument parsing, its
 * fetch calls and its exit code are all the real ones. Nothing about the code under test is
 * replaced.
 *
 * The mock's payloads are worth as much as its assertions, and they were wrong once: the
 * consumer entry was written from Cloudflare's documentation (`script_name`), while the live
 * API returns `script`. The mock therefore agreed with the bug and the check passed here
 * while reporting a correctly deployed Worker as missing on a real account. So the fixture
 * now uses the live spelling, and a case below asserts the documented one is accepted too —
 * the shapes are covered separately rather than assumed to be the same.
 *
 * Usage:
 *   npm run deploy:verify:test
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ACCOUNT = 'acct-selftest-0000000000000000';
const TOKEN = 'selftest-token-that-must-not-be-printed';
const WORKER = 'steve-pay-jobs';
const PAGES = 'steve-pay';
const QUEUE = 'steve-pay-webhooks';
const DLQ = 'steve-pay-webhooks-dlq';
const CRONS = ['*/2 * * * *', '*/15 * * * *', '0 3 * * *'];

/** The secret names the site cannot start without, and two more that are optional. */
const REQUIRED_SECRETS = ['SESSION_SECRET', 'API_KEY_PEPPER', 'WEBHOOK_SECRET'];

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failures.push(`${label}${detail ? ` \u2014 ${detail}` : ''}`);
    console.log(`  \u2717 ${label}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * What the mock answers with, per scenario. Mutated between cases rather than restarted,
 * because one server serves every scenario and the port has to stay stable for the child.
 */
const state = {
  schedules: [...CRONS],
  queues: null,
  schedulesStatus: 200,
  // The Pages project's production environment, as the API reports it: secrets carry no
  // value, plain variables do. An empty plain-text value is how a variable looks when it was
  // created and forgotten, and it must not pass for a secret the site can boot with.
  envVars: null,
};

function resetEnvVars() {
  state.envVars = {
    ENVIRONMENT: { type: 'plain_text', value: 'production' },
    GATEWAY_FEE_TOMAN: { type: 'plain_text', value: '3000' },
    TURNSTILE_SITE_KEY: { type: 'plain_text', value: '' },
    ...Object.fromEntries(REQUIRED_SECRETS.map((name) => [name, { type: 'secret_text' }])),
  };
}

resetEnvVars();

function resetQueues() {
  state.queues = [
    {
      queue_id: 'queue-selftest-00000000000000000',
      queue_name: QUEUE,
      consumers: [
        {
          consumer_id: 'consumer-selftest-00000000000000',
          // The live spelling. See the note at the top: `script_name` is what the docs say,
          // and reading only that reported a working deploy as broken.
          script: WORKER,
          dead_letter_queue: DLQ,
          type: 'worker',
        },
      ],
    },
  ];
}

resetQueues();

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const send = (status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };

  if (!request.headers.authorization?.startsWith('Bearer ')) {
    send(403, { success: false, errors: [{ code: 9106, message: 'Authentication failed' }] });
    return;
  }

  if (url.pathname === `/accounts/${ACCOUNT}/workers/scripts/${WORKER}/schedules`) {
    if (state.schedulesStatus !== 200) {
      send(state.schedulesStatus, {
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
        result: null,
      });
      return;
    }
    send(200, {
      success: true,
      result: { schedules: state.schedules.map((cron) => ({ cron })) },
      errors: [],
      messages: [],
    });
    return;
  }

  if (url.pathname === `/accounts/${ACCOUNT}/queues`) {
    send(200, { success: true, result: state.queues, errors: [], messages: [] });
    return;
  }

  if (url.pathname === `/accounts/${ACCOUNT}/pages/projects/${PAGES}`) {
    send(200, {
      success: true,
      result: {
        name: PAGES,
        production_branch: 'main',
        deployment_configs: { production: { env_vars: state.envVars } },
      },
      errors: [],
      messages: [],
    });
    return;
  }

  send(404, { success: false, errors: [{ code: 7003, message: `no route for ${url.pathname}` }] });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const apiBase = `http://127.0.0.1:${port}`;

/**
 * Runs the real script as a child process, exactly as a deploy step would.
 *
 * Asynchronously, and that is not a style choice: the mock server is this process, so a
 * synchronous spawn would block the event loop that has to answer the child's requests and
 * the two would wait for each other forever.
 */
function run(extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'verify-deploy.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CLOUDFLARE_API_BASE: apiBase,
        CLOUDFLARE_API_TOKEN: TOKEN,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
        STEVE_PAY_HOST: '',
        ...extraEnv,
      },
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (status) => resolve({ status, output }));
  });
}

console.log('\nverify-deploy: it must fail a half-deployed system, not just pass a good one');

// ---------------------------------------------------------------------------
section('a complete deploy passes');
// ---------------------------------------------------------------------------
resetQueues();
state.schedules = [...CRONS];
state.schedulesStatus = 200;

{
  const { status, output } = await run();
  check('exits 0', status === 0, `got ${status}\n${output}`);
  check('reports every cron', CRONS.every((cron) => output.includes(cron)));
  check('confirms the consumer', output.includes(`consumed by ${WORKER}`));
  check('confirms the dead-letter queue', output.includes(DLQ));
  check('says the site it serves has the secrets it needs', output.includes(`Pages project ${PAGES} has the secrets`));
  check('the token is nowhere in the output', !output.includes(TOKEN));
}

// ---------------------------------------------------------------------------
section('the documented spelling of the consumer field also passes');
// ---------------------------------------------------------------------------
resetQueues();
state.schedules = [...CRONS];
state.queues[0].consumers[0].script_name = state.queues[0].consumers[0].script;
delete state.queues[0].consumers[0].script;

{
  const { status, output } = await run();
  check('exits 0 when the API says script_name', status === 0, `got ${status}\n${output}`);
  check('confirms the consumer', output.includes(`consumed by ${WORKER}`));
}

// ---------------------------------------------------------------------------
section('a Worker deployed without one of its cron triggers fails');
// ---------------------------------------------------------------------------
state.schedules = CRONS.filter((cron) => cron !== '*/2 * * * *');

{
  const { status, output } = await run();
  check('exits non-zero', status !== 0);
  check('names the missing cron', output.includes('cron NOT scheduled: */2 * * * *'));
  check('still confirms the crons that are live', output.includes('cron scheduled: 0 3 * * *'));
  check('says the deploy is incomplete', output.includes('deploy is incomplete'));
}

// ---------------------------------------------------------------------------
section('a queue with no consumer fails');
// ---------------------------------------------------------------------------
resetQueues();
state.schedules = [...CRONS];
state.queues[0].consumers = [];

{
  const { status, output } = await run();
  check('exits non-zero', status !== 0);
  check('says no consumer named the Worker', output.includes(`no consumer named ${WORKER}`));
  check('reports the dead-letter queue as unverifiable', output.includes('no consumer'));
}

// ---------------------------------------------------------------------------
section('a consumer that is a different Worker fails');
// ---------------------------------------------------------------------------
resetQueues();
state.queues[0].consumers[0].script = 'some-other-worker';

{
  const { status, output } = await run();
  check('exits non-zero', status !== 0);
  check('names what it found instead', output.includes('some-other-worker'));
}

// ---------------------------------------------------------------------------
section('a consumer with no dead-letter queue fails');
// ---------------------------------------------------------------------------
resetQueues();
state.queues[0].consumers[0].dead_letter_queue = '';

{
  const { status, output } = await run();
  check('exits non-zero', status !== 0);
  check('says which queue was expected', output.includes(`is not ${DLQ}`));
}

// ---------------------------------------------------------------------------
section('a missing webhook queue fails');
// ---------------------------------------------------------------------------
resetQueues();
state.queues = [];

{
  const { status, output } = await run();
  check('exits non-zero', status !== 0);
  check('says the queue does not exist', output.includes(`queue ${QUEUE} does not exist`));
}

// ---------------------------------------------------------------------------
section('a site that cannot resolve its secrets fails');
// ---------------------------------------------------------------------------
// The live failure this case was written from: every public page rendered, `/health` reported
// `ok`, and both consoles answered 500, because the Pages project had its plain variables and
// none of the three secrets `resolveSecrets` requires in production.
resetQueues();
state.schedules = [...CRONS];
resetEnvVars();
delete state.envVars.SESSION_SECRET;

{
  const { status, output } = await run();
  check('exits non-zero', status !== 0);
  check('names the missing secret', output.includes('missing SESSION_SECRET'));
  check(
    'says the environment is baked into a deployment, so a redeploy is needed',
    output.includes('deploy the site again'),
  );
  check('says the deploy is incomplete', output.includes('deploy is incomplete'));
}

// A variable that exists and is empty is not a secret the site can boot with, and the two are
// worth telling apart: one is a missing piece, the other is a half-finished step.
resetEnvVars();
state.envVars.WEBHOOK_SECRET = { type: 'plain_text', value: '' };

{
  const { status, output } = await run();
  check('exits non-zero for an empty variable in a secret slot', status !== 0);
  check('names it', output.includes('missing WEBHOOK_SECRET'));
}

// ---------------------------------------------------------------------------
section('an unusable token fails, and shows no credential');
// ---------------------------------------------------------------------------
resetQueues();
state.schedulesStatus = 403;

{
  const { status, output } = await run();
  check('exits non-zero', status !== 0);
  check('reports the API failure', output.includes('HTTP 403'));
  check('the token is still not in the output', !output.includes(TOKEN));
}

// ---------------------------------------------------------------------------
section('missing credentials fail before any request');
// ---------------------------------------------------------------------------
{
  const { status, output } = await run({ CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' });
  check('exits non-zero', status !== 0);
  check('says what to set', output.includes('Missing credentials'));
}

// `close()` alone waits for open sockets, and the child's keep-alive connections are still
// pooled. `closeAllConnections()` drops them; `exit` then makes the result unambiguous
// rather than leaving the process to decide when it is finished.
server.closeAllConnections();
server.close();

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`${passed} checks passed.\n`);
process.exit(0);
