#!/usr/bin/env node
/**
 * Exports the data needed to rebuild wallets and reconcile their ledgers.
 *
 * WHY THIS EXPORT AND NOT `wrangler d1 export`
 *
 *   The raw SQL dump is still the right tool for a full disaster recovery — see
 *   DEPLOYMENT.md — but it cannot be handed to an accountant, a support engineer or a
 *   migration script, because it contains every password hash, session token hash and
 *   sealed webhook secret in the platform. This export answers a narrower question:
 *   "what was every merchant's balance, and does it equal the sum of their ledger?"
 *
 *   So it deliberately includes the money tables and excludes every table that holds a
 *   credential. The exclusion list is an allow-list rather than a deny-list: a table has
 *   to be named to be exported, which means a future table cannot leak into a backup
 *   simply because nobody remembered to add it to a deny-list.
 *
 * Usage:
 *   npm run backup:export
 *   npm run backup:export -- --remote
 *   npm run backup:export -- --out ./backups --merchant usr_01J8...
 *
 * Output: <out>/steve-pay-<timestamp>.json, plus a <same>.sums.txt reconciliation report.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Tables worth exporting, and why each is here.
 *
 * Anything not listed is not exported. In particular this set excludes: users
 * (password_hash), sessions (token hash), api_keys (key_hash), webhook_endpoints
 * (sealed secret), telegram links, and login_attempts.
 */
const TABLES = [
  ['wallets', 'the balances themselves'],
  ['wallet_ledger', 'the movements that must sum to each balance'],
  ['invoices', 'the record of what was owed and what was paid'],
  ['transactions', 'confirmed settlements with bank references'],
  ['payments', 'payment identifiers and lifecycle'],
  ['merchant_profiles', 'merchant identity for the report, minus credentials'],
  ['system_settings', 'the configuration a restore must reproduce'],
];

/** Columns that must never leave the database, even from an exported table. */
const FORBIDDEN_COLUMNS = [
  'password_hash',
  'key_hash',
  'token_hash',
  'secret',
  'secret_encrypted',
  'totp_secret',
  'number_hash',
];

const REDACT = 'REDACTED';

/**
 * The D1 database this platform uses.
 *
 * One name, hard-coded, because there is one database: the application is a Pages project
 * with a single bindings block, so there is no wrangler environment to select between a
 * production and a staging copy. See the note in `scripts/create-admin.mjs`.
 */
const DATABASE = 'steve-pay';

function parseArgs(argv) {
  const args = { remote: false, out: join(ROOT, 'backups'), merchant: null, limit: 100_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--remote':
        args.remote = true;
        break;
      case '--local':
        args.remote = false;
        break;
      case '--out':
        args.out = argv[++index] ?? args.out;
        break;
      case '--merchant':
        args.merchant = argv[++index] ?? null;
        break;
      case '--limit':
        args.limit = Number(argv[++index] ?? args.limit);
        break;
      case '--help':
      case '-h':
        console.log(`
Export Steve Pay money tables to JSON, excluding every credential column.

  npm run backup:export [options]

Options:
  --out <dir>          Output directory (default ./backups)
  --merchant <id>      Export one merchant only
  --remote             Read the remote database instead of local
  --limit <n>          Row cap per table (default 100000)
  -h, --help           This message

Exported tables: ${TABLES.map(([name]) => name).join(', ')}
Never exported   : users, sessions, api_keys, webhook_endpoints, login_attempts
`);
        process.exit(0);
        break;
      default:
        if (token.startsWith('--')) {
          console.error(`Unknown option: ${token}`);
          process.exit(1);
        }
    }
  }
  return args;
}

/**
 * Runs a read-only query and parses wrangler's JSON output.
 *
 * `--json` prints a single JSON document; wrangler also writes progress text to stderr, so
 * only stdout is parsed and a non-zero exit is reported rather than being mistaken for an
 * empty result set.
 */
function query(database, sql, { remote }) {
  const wranglerArgs = ['wrangler', 'd1', 'execute', database, '--json', '--command', sql];
  wranglerArgs.push(remote ? '--remote' : '--local');

  const result = spawnSync('npx', wranglerArgs, {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed: ${(result.stderr ?? '').trim() || `exit ${result.status}`}`);
  }

  const stdout = result.stdout ?? '';
  const start = stdout.indexOf('[');
  if (start < 0) throw new Error('wrangler returned no JSON payload');

  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch (error) {
    throw new Error(`could not parse wrangler output: ${error.message}`);
  }

  // `--json` returns one entry per statement; this script only ever sends one.
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return Array.isArray(first?.results) ? first.results : [];
}

/** Drops or masks any column that must not leave the database. */
function sanitise(table, rows) {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const forbidden = columns.filter((column) => FORBIDDEN_COLUMNS.some((name) => column.includes(name)));

  if (forbidden.length === 0) return { rows, redacted: [] };

  const cleaned = rows.map((row) => {
    const copy = { ...row };
    for (const column of forbidden) {
      if (copy[column] !== null && copy[column] !== undefined) copy[column] = REDACT;
    }
    return copy;
  });

  return { rows: cleaned, redacted: forbidden.map((column) => `${table}.${column}`) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const database = DATABASE;
  const connection = { remote: args.remote };

  mkdirSync(args.out, { recursive: true });

  console.log(`Exporting from ${database} [${args.remote ? 'remote' : 'local'}]`);
  console.log('');

  const exported = {};
  const redactedColumns = [];
  const rowCounts = {};

  for (const [table, purpose] of TABLES) {
    const where = args.merchant
      ? ` WHERE ${table === 'wallets' || table === 'merchant_profiles' ? 'user_id' : 'merchant_user_id'} = '${args.merchant.replace(/'/g, "''")}'`
      : '';

    try {
      const rows = query(database, `SELECT * FROM ${table}${where} LIMIT ${Math.floor(args.limit)}`, connection);
      const { rows: safeRows, redacted } = sanitise(table, rows);
      exported[table] = safeRows;
      rowCounts[table] = safeRows.length;
      redactedColumns.push(...redacted);
      console.log(`  ${String(safeRows.length).padStart(7)}  ${table.padEnd(20)} ${purpose}`);
    } catch (error) {
      // A missing table means a partial migration, which is worth seeing rather than
      // silently producing a backup with a hole in it.
      console.error(`  FAILED  ${table}: ${error.message}`);
      process.exitCode = 1;
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(args.out, `steve-pay-${stamp}`);

  const payload = {
    exportedAt: new Date().toISOString(),
    database,
    filter: args.merchant ?? null,
    redactedColumns: [...new Set(redactedColumns)],
    rowCounts,
    tables: exported,
  };

  writeFileSync(`${base}.json`, JSON.stringify(payload, null, 2), 'utf8');

  // The reconciliation report. A wallet whose balance does not equal the sum of its
  // ledger rows is either a bug or a manual edit that bypassed the service layer, and
  // either way it should not be discovered by a customer.
  const rebalanced = Object.entries(exported.wallet_ledger ?? []).reduce((acc, [, row]) => {
    if (!row || typeof row !== 'object') return acc;
    const id = row.merchant_user_id;
    if (!id) return acc;
    const signed = row.direction === 'CREDIT' ? Number(row.amount) : -Number(row.amount);
    acc.set(id, (acc.get(id) ?? 0) + signed);
    return acc;
  }, new Map());

  const lines = [
    `Steve Pay backup report`,
    `exported at : ${payload.exportedAt}`,
    `database    : ${database}`,
    `rows        : ${Object.entries(rowCounts).map(([table, count]) => `${table}=${count}`).join(' ')}`,
    `redacted    : ${payload.redactedColumns.join(', ') || '(none)'}`,
    '',
    'Wallet reconciliation (balance must equal the ledger sum):',
  ];

  let mismatches = 0;
  for (const wallet of exported.wallets ?? []) {
    const id = wallet.user_id;
    const balance = Number(wallet.balance ?? 0);
    const ledgerSum = rebalanced.get(id) ?? 0;
    const flag = balance === ledgerSum ? 'ok  ' : 'FAIL';
    if (balance !== ledgerSum) mismatches += 1;
    lines.push(`  ${flag} ${id}: balance=${balance} ledger=${ledgerSum}`);
  }

  lines.push('', mismatches === 0 ? 'All wallets reconcile.' : `${mismatches} wallet(s) do not reconcile — investigate before trusting this export.`);
  if (redactedColumns.length > 0) {
    lines.push('', `Columns redacted in this export: ${payload.redactedColumns.join(', ')}`);
  }

  writeFileSync(`${base}.sums.txt`, `${lines.join('\n')}\n`, 'utf8');

  console.log('');
  console.log(lines.slice(4).join('\n'));
  console.log('');
  console.log(`Wrote ${base}.json`);
  console.log(`Wrote ${base}.sums.txt`);
}

main();
