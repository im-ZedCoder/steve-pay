#!/usr/bin/env node
/**
 * Creates the first admin account.
 *
 * There is no self-service admin signup, by design: an endpoint that can mint an
 * ADMIN would be the highest-value target in the system. Bootstrapping is therefore a
 * local operation that writes directly to the database.
 *
 * The password hash comes from `src/core/crypto.ts` — the same `hashPassword` the login
 * path verifies against, imported rather than reimplemented. A copy of the PBKDF2 format
 * here would be a second thing to keep in sync, and the first time they drifted the
 * admin would simply be unable to log in, with no error to explain why.
 *
 * Those two modules are `.ts`, and they are loaded through `scripts/import-ts.mjs` so the
 * command works on every Node the project claims to support, not only the ones that strip
 * types on import.
 *
 * Usage:
 *   npm run admin:create                       # local D1, interactive
 *   npm run admin:create -- --mobile 0912... --role ADMIN
 *   npm run admin:create -- --remote
 *
 * For non-interactive use (CI, scripted bootstrap) pass STEVE_GATE_ADMIN_MOBILE and
 * STEVE_GATE_ADMIN_PASSWORD instead of being prompted. Passing a password on the command
 * line is possible but discouraged: it lands in the shell history and the process list.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { importTypeScript } from './import-ts.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// --- the real implementations, not copies ------------------------------------
const { hashPassword } = await importTypeScript(join(ROOT, 'src', 'core', 'crypto.ts'));
const { id: newId } = await importTypeScript(join(ROOT, 'src', 'core', 'ids.ts'));

/**
 * The database to write to.
 *
 * There is one, and there is no `--env` flag. Wrangler environments were how a single
 * Worker config could describe two deployments; the application is a Pages project with a
 * single bindings block now, so `wrangler d1 execute --env production` names an environment
 * that does not exist in the config and fails before it touches the database. Adding a
 * second database back would mean adding a second environment back here as well — which is
 * the point at which a `--env` flag becomes worth having again.
 */
const ROLES = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'FINANCE', 'VIEWER'];
const DATABASE = 'steve-pay';

function parseArgs(argv) {
  const args = {
    remote: false,
    mobile: null,
    password: null,
    role: 'SUPER_ADMIN',
    name: null,
    yes: false,
    allowShortPassword: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--remote':
        args.remote = true;
        break;
      case '--local':
        args.remote = false;
        break;
      case '--yes':
      case '-y':
        args.yes = true;
        break;
      case '--mobile':
        args.mobile = argv[++index] ?? null;
        break;
      case '--password':
        args.password = argv[++index] ?? null;
        break;
      case '--role':
        args.role = argv[++index] ?? null;
        break;
      case '--name':
        args.name = argv[++index] ?? null;
        break;
      case '--allow-short-password':
        args.allowShortPassword = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (token.startsWith('--')) {
          console.error(`Unknown option: ${token}`);
          printUsage();
          process.exit(1);
        }
    }
  }
  return args;
}

function printUsage() {
  console.log(`
Create a Steve Gate admin account.

  npm run admin:create [options]

Options:
  --mobile <09XXXXXXXXX>     Admin mobile number
  --password <value>         Password (prefer the prompt; this is visible in history)
  --role <ROLE>              ${ROLES.join(' | ')} (default SUPER_ADMIN)
  --name <text>              Display name
  --remote                   Target the remote database instead of local
  --allow-short-password     Accept a password under ${MIN_PASSWORD_LENGTH} characters
  --yes, -y                  Skip the confirmation prompt
  -h, --help                 This message

About --allow-short-password:
  The console's own policy requires ${MIN_PASSWORD_LENGTH} characters, and the change-password
  form enforces it, so a credential shorter than that can be installed here but cannot be
  typed back into the console. The flag exists so an owner who insists on a specific
  credential gets it through the same audited path as every other bootstrap, instead of by
  pasting SQL into a shell where nothing records how the account was made. Composition rules
  still apply: a letter and a digit are required either way.

Environment variables (non-interactive):
  STEVE_GATE_ADMIN_MOBILE
  STEVE_GATE_ADMIN_PASSWORD
`);
}

/**
 * Normalises to the `09XXXXXXXXX` form the rest of the system stores.
 *
 * Mirrors `normalizeMobile` in src/core/validation.ts. Duplicated rather than imported
 * because validation.ts pulls in the error module and the whole HTTP surface for one
 * pure string transform; the format is asserted right after, so a drift cannot pass
 * silently.
 */
function normalizeMobile(input) {
  const digits = String(input)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\D/g, '');

  if (digits.startsWith('0098')) return `0${digits.slice(4)}`;
  if (digits.startsWith('98') && digits.length === 12) return `0${digits.slice(2)}`;
  if (digits.startsWith('9') && digits.length === 10) return `0${digits}`;
  return digits;
}

function isValidMobile(value) {
  return /^09\d{9}$/.test(value);
}

const MIN_PASSWORD_LENGTH = 10;

/**
 * `allowShort` waives only the length rule, and only when `--allow-short-password` was
 * passed. The composition rules stay: they are what the platform's own
 * `validatePasswordStrength` requires of every account, and a bootstrap that could install
 * `1234` would be a worse tool than one that refuses. See the flag's note in `--help`.
 */
function passwordProblem(password, { allowShort = false } = {}) {
  if (!allowShort && password.length < MIN_PASSWORD_LENGTH) {
    return `must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (!/[a-z]/.test(password)) return 'must contain a lowercase letter';
  if (!/[A-Z]/.test(password)) return 'must contain an uppercase letter';
  if (!/\d/.test(password)) return 'must contain a digit';
  return null;
}

async function prompt(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Asks without echoing. Falls back to a visible prompt on a terminal that cannot hide input. */
async function promptHidden(question) {
  if (!stdin.isTTY) return prompt(question);

  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const onData = (char) => {
      // Redraw a mask so nothing is left on screen, and keep the cursor on the same line.
      if (String(char) === '\r' || String(char) === '\n') return;
      stdout.write(`\r${question}${'*'.repeat(rl.line.length)}`);
    };
    stdin.on('data', onData);
    rl.question(question)
      .then((answer) => resolve(answer.trim()))
      .finally(() => {
        stdin.off('data', onData);
        rl.close();
        stdout.write('\n');
      });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const role = args.role ?? 'SUPER_ADMIN';
  if (!ROLES.includes(role)) {
    console.error(`Invalid --role "${role}". Expected one of: ${ROLES.join(', ')}`);
    process.exit(1);
  }

  let mobile = normalizeMobile(args.mobile ?? process.env.STEVE_GATE_ADMIN_MOBILE ?? '');
  if (!mobile) mobile = normalizeMobile(await prompt('Admin mobile (09XXXXXXXXX): '));
  if (!isValidMobile(mobile)) {
    console.error(`Invalid mobile number "${mobile}". Expected 09 followed by 9 digits.`);
    process.exit(1);
  }

  let password = args.password ?? process.env.STEVE_GATE_ADMIN_PASSWORD ?? '';
  if (!password) password = await promptHidden('Password: ');
  const problem = passwordProblem(password, { allowShort: args.allowShortPassword });
  if (problem) {
    console.error(`Password ${problem}.`);
    process.exit(1);
  }
  if (!args.password && !process.env.STEVE_GATE_ADMIN_PASSWORD) {
    const confirm = await promptHidden('Confirm password: ');
    if (confirm !== password) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
  }

  const database = DATABASE;
  const target = args.remote ? 'remote' : 'local';

  console.log('');
  console.log(`  database : ${database} [${target}]`);
  console.log(`  mobile   : ${mobile}`);
  console.log(`  role     : ${role}`);
  console.log(`  name     : ${args.name ?? '(none)'}`);
  console.log('');

  if (args.allowShortPassword && password.length < MIN_PASSWORD_LENGTH) {
    console.warn(
      `  ! Password is ${password.length} characters, under the ${MIN_PASSWORD_LENGTH}-character\n` +
        '  ! policy. Sign-in will work. The console will not let this value be set again,\n' +
        '  ! so changing it later means choosing a longer one.\n',
    );
  }

  if (!args.yes) {
    const answer = (await prompt('Create this admin? [y/N] ')).toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Aborted. Nothing was written.');
      return;
    }
  }

  const userId = newId('usr');
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  const displayName = args.name ?? 'Administrator';

  // The password hash contains `$` characters, which SQLite would treat as a parameter
  // placeholder in some contexts and which are painful to quote correctly. It goes in as
  // a bound-free literal only after being checked against the exact expected alphabet,
  // so no adversarial value can reach the statement.
  if (!/^pbkdf2-sha256\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(passwordHash)) {
    console.error('Refusing to write: password hash did not match the expected format.');
    process.exit(1);
  }

  const sql = `-- Steve Gate admin bootstrap. Generated ${now}.
INSERT INTO users (id, mobile, password_hash, role, status, display_name, must_change_password, created_at, updated_at)
VALUES (
  '${userId}',
  '${mobile}',
  '${passwordHash}',
  '${role}',
  'ACTIVE',
  '${displayName.replace(/'/g, "''")}',
  0,
  '${now}',
  '${now}'
);
`;

  // A temp file rather than `--command`, so the hash is never part of a shell command
  // line where it would appear in the process list and in shell history.
  const directory = mkdtempSync(join(tmpdir(), 'steve-pay-admin-'));
  const sqlPath = join(directory, 'admin.sql');
  writeFileSync(sqlPath, sql, { encoding: 'utf8', mode: 0o600 });

  try {
    const wranglerArgs = ['wrangler', 'd1', 'execute', database, '--file', sqlPath];
    wranglerArgs.push(args.remote ? '--remote' : '--local');

    const result = spawnSync('npx', wranglerArgs, { stdio: 'inherit', shell: process.platform === 'win32' });

    if (result.status !== 0) {
      console.error('\nAdmin creation failed. The SQL that was attempted:');
      console.error(sql);
      process.exit(result.status ?? 1);
    }

    console.log(`
Admin created.

  id       : ${userId}
  mobile   : ${mobile}
  role     : ${role}

Sign in at /login?scope=admin
`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

await main();
