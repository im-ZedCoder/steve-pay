#!/usr/bin/env node
/**
 * Asserts that production is running the whole platform and not just its web half.
 *
 * WHAT THIS IS FOR
 *
 * The application is two Cloudflare projects: a Pages project that answers every request,
 * and a companion Worker that owns the cron triggers and the webhook queue consumer (see
 * DEPLOYMENT.md). A deploy is therefore not one operation but two, and the failure this
 * exists to catch is the quiet one: the site goes up, the Worker does not, every page
 * renders, payments are taken — and nothing expires an invoice, so each one holds its
 * unique payable amount claimed forever and the suffix space that makes amounts unique
 * silently runs out. Days later new payments stop being creatable, and the cause is a
 * deploy from days ago that looked fine.
 *
 * So a deploy is not finished when `wrangler` exits zero. It is finished when the account
 * agrees: the configured cron schedules exist on the deployed Worker, the webhook queue has
 * that Worker as its consumer, and its dead-letter queue is the configured one.
 *
 * THE EXPECTATIONS COME FROM THE CONFIG
 *
 * The worker name, the cron list, the queue and the dead-letter queue are read out of
 * `wrangler.worker.jsonc` rather than written here a second time, so this cannot pass
 * against a stale copy of the intent. Add a fourth cron, forget to deploy it, and this
 * fails — which is the point.
 *
 * ONE FIELD IS READ TWO WAYS
 *
 * A queue consumer names its Worker in `script` in the live API and in `script_name` in
 * Cloudflare's published response schema. Both are accepted. This was found the only way it
 * could be: the first version read `script_name` alone and reported a correctly deployed
 * Worker as missing on a real account — the mock in the self-test had been written from the
 * same documentation, so it agreed with the bug instead of catching it.
 *
 * ONE REQUEST PER THING
 *
 * The queue listing returns each queue's consumers inline, so the consumer check needs no
 * second call and no queue id to resolve first. Talking only to the documented REST API —
 * and honouring `CLOUDFLARE_API_BASE`, as `scripts/cloudflare-setup.mjs` does — is also
 * what lets `scripts/verify-deploy.selftest.mjs` run this against a mock and prove it fails
 * an incomplete deploy. A gate that cannot be shown to fail is not a gate.
 *
 * Usage:
 *   npm run deploy:verify
 *   npm run deploy:verify -- --host https://pay.example.com
 *
 * Credentials: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. "Workers Scripts Read" is
 * enough — every endpoint here accepts it. The token is never printed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4';

const args = { token: null, account: null, host: null };
{
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--token') args.token = argv[++index] ?? null;
    else if (flag === '--account') args.account = argv[++index] ?? null;
    else if (flag === '--host') args.host = argv[++index] ?? null;
    else if (flag === '--help' || flag === '-h') {
      console.log(`
Verify what production is actually running.

  npm run deploy:verify [options]

Options:
  --token <value>      Cloudflare API token (or CLOUDFLARE_API_TOKEN)
  --account <id>       Account id (or CLOUDFLARE_ACCOUNT_ID)
  --host <origin>      Also check <origin>/health — optional, nothing depends on it
  -h, --help           This message

Checks, all against wrangler.worker.jsonc rather than a copy of it:
  1. Every configured cron trigger is scheduled on the deployed Worker.
  2. The webhook queue's consumer is that Worker, not something else and not nothing.
  3. The consumer's dead-letter queue is the configured one.
  4. With --host: the site answers /health with status ok.

Exits non-zero if any check fails, so a deploy step cannot pass on half a system.
`);
      process.exit(0);
    } else {
      console.error(`Unknown option: ${flag}`);
      process.exit(1);
    }
  }
}

const token = args.token ?? process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? null;
const account = args.account ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? null;
const apiBase = (process.env.CLOUDFLARE_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
const hostArg = args.host ?? process.env.STEVE_PAY_HOST ?? null;

const failures = [];
const ok = (message) => console.log(`  \u2713 ${message}`);
const bad = (message) => {
  console.log(`  \u2717 ${message}`);
  failures.push(message);
};

/**
 * Reads the deployment's intent out of the companion Worker's config.
 *
 * The file is JSONC, so it cannot be `JSON.parse`d — and it is not deserialised here at all,
 * because what is needed is four values, not a data structure. Each is matched by shape:
 * cron expressions are the only quoted strings made only of cron characters, so prose in
 * the comments around them cannot be mistaken for one.
 */
const configPath = join(ROOT, 'wrangler.worker.jsonc');
const config = readFileSync(configPath, 'utf8');

const workerName = /"name"\s*:\s*"([^"]+)"/.exec(config)?.[1] ?? null;
const cronsBlock = /"crons"\s*:\s*\[([\s\S]*?)\]/.exec(config)?.[1] ?? '';
const crons = [...cronsBlock.matchAll(/"([\d*/,\- ]+)"/g)].map((match) => match[1]);
const consumersBlock = /"consumers"\s*:\s*\[([\s\S]*?)\n\s*\]/.exec(config)?.[1] ?? '';
const queue = /"queue"\s*:\s*"([^"]+)"/.exec(consumersBlock)?.[1] ?? null;
const deadLetterQueue = /"dead_letter_queue"\s*:\s*"([^"]+)"/.exec(consumersBlock)?.[1] ?? null;

console.log(`\nVerify deployment \u2014 ${workerName ?? 'unknown worker'}\n`);

if (!workerName || crons.length === 0 || !queue) {
  console.error(
    `Could not read the worker name, cron triggers and consumer queue from ${configPath}.\n` +
      'If the config was restructured, this script needs the same change.',
  );
  process.exit(1);
}

if (!token || !account) {
  console.error(
    'Missing credentials. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or pass\n' +
      '--token and --account. "Workers Scripts Read" is the only permission needed.',
  );
  process.exit(1);
}

/**
 * The Worker a consumer entry belongs to, under either spelling the API uses for it.
 *
 * `script` is what the live endpoints return today; `script_name` is what the published
 * schema documents. Reading only one of them made this script claim a working deploy was
 * missing its consumer, which is the failure mode a gate must not have.
 */
const consumerWorker = (entry) => entry?.script_name ?? entry?.script ?? null;

/**
 * One authenticated GET.
 *
 * The response body is included in the failure because it is the only place Cloudflare says
 * *which* permission is missing; a bare "403" sends people to the dashboard to guess.
 */
const api = async (path) => {
  const response = await fetch(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${path} \u2192 HTTP ${response.status}\n${body.slice(0, 400)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`GET ${path} returned something that is not JSON:\n${body.slice(0, 200)}`);
  }
};

// ---------------------------------------------------------------------------
// 1. Cron triggers
// ---------------------------------------------------------------------------

try {
  const body = await api(`/accounts/${account}/workers/scripts/${workerName}/schedules`);
  const scheduled = (body?.result?.schedules ?? []).map((entry) => entry.cron);

  for (const cron of crons) {
    if (scheduled.includes(cron)) ok(`cron scheduled: ${cron}`);
    else bad(`cron NOT scheduled: ${cron} \u2014 deployed: ${scheduled.join(', ') || 'none'}`);
  }
} catch (error) {
  bad(`could not read the cron schedules \u2014 ${error.message}`);
}

// ---------------------------------------------------------------------------
// 2. Queue consumer, and the dead-letter queue behind it
// ---------------------------------------------------------------------------

try {
  const body = await api(`/accounts/${account}/queues?per_page=100`);
  const queues = body?.result ?? [];
  const found = queues.find((entry) => entry.queue_name === queue);

  if (!found) {
    bad(`queue ${queue} does not exist in this account`);
  } else {
    // `consumers` is inline on the queue, so this needs no second request and no queue id.
    const consumers = Array.isArray(found.consumers) ? found.consumers : [];
    const mine = consumers.filter((entry) => consumerWorker(entry) === workerName);

    if (mine.length > 0) ok(`queue ${queue} is consumed by ${workerName}`);
    else {
      bad(
        `queue ${queue} has no consumer named ${workerName} \u2014 got: ` +
          `${consumers.map((entry) => consumerWorker(entry) ?? '(unnamed)').join(', ') || 'none'}`,
      );
    }

    if (deadLetterQueue) {
      // A consumer without its dead-letter queue retries and then discards. The message
      // that is lost is a merchant's payment callback, so this is worth asserting.
      const withDlq = mine.some((entry) => entry.dead_letter_queue === deadLetterQueue);
      if (withDlq) ok(`dead-letter queue is ${deadLetterQueue}`);
      else {
        bad(
          `consumer's dead-letter queue is not ${deadLetterQueue} \u2014 got: ` +
            `${mine.map((entry) => entry.dead_letter_queue || '(none)').join(', ') || 'no consumer'}`,
        );
      }
    }
  }
} catch (error) {
  bad(`could not list the queues \u2014 ${error.message}`);
}

// ---------------------------------------------------------------------------
// 3. The site, when a host is known
// ---------------------------------------------------------------------------

if (hostArg) {
  // A bare `host:port` is taken as https, which is what a real hostname wants. Loopback is
  // the exception, because `wrangler dev` serves plain HTTP and that is a legitimate thing
  // to point this at.
  const scheme = /^https?:\/\//.test(hostArg)
    ? ''
    : /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(hostArg)
      ? 'http://'
      : 'https://';
  const origin = `${scheme}${hostArg}`;

  try {
    const response = await fetch(`${origin}/health`);
    const body = await response.json().catch(() => ({}));
    if (response.ok && body?.status === 'ok') ok(`${origin}/health is ok`);
    else bad(`${origin}/health \u2192 HTTP ${response.status} ${JSON.stringify(body).slice(0, 200)}`);
  } catch (error) {
    bad(`could not reach ${origin}/health \u2014 ${error.message}`);
  }
} else {
  // Not a failure: the deployment deliberately has no configured hostname, so this script
  // has no way to know which address to ask.
  console.log('  - /health not checked (pass --host or set STEVE_PAY_HOST)');
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(
    `\n${failures.length} check(s) failed. The deploy is incomplete: the site may be live ` +
      'while invoices do not expire and webhook retries never run.\n',
  );
  process.exit(1);
}

console.log('\nEverything the deploy needs is live.\n');
