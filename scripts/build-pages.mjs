#!/usr/bin/env node
/**
 * Assembles `dist-pages/` — the directory Cloudflare Pages deploys.
 *
 * A Pages project expects three things in its output directory:
 *
 *   `_worker.js`     the Function, bundled
 *   the static files exactly as they should be served
 *   `_routes.json`   which requests are the Function's business and which are not
 *
 * Nothing generates that shape for you, and the pieces come from different places, which
 * is the whole reason this script exists. Getting it wrong is quiet: a `_worker.js` that
 * is not a module, or a `_routes.json` that routes the fonts through the Function, both
 * deploy successfully and produce a site that is subtly incorrect.
 *
 * WHAT IT DOES
 *
 *   1. Regenerates the two derived asset sets — the fonts and the client script — so a
 *      deploy can never ship a `client.js` older than the markup it targets.
 *   2. Bundles the Worker with `wrangler deploy --dry-run --outdir`, which is the same
 *      bundler and the same config the runtime uses. Reimplementing the bundle with
 *      esbuild would be a second build whose output could differ from the deployed one.
 *   3. Copies the bundle to `_worker.js` and `public/` to the output root.
 *   4. Writes `_routes.json`.
 *
 * WHY NOTHING USES THE ASSETS BINDING
 *
 * Earlier revisions declared an `ASSETS` Fetcher and read static bytes through it. On
 * Pages the platform serves those files directly, before the Function is invoked, so a
 * binding would be dead weight — and the `_headers` file in `public/` already carries the
 * cache and security policy for them, which a Function-served response would have to
 * reproduce by hand and would eventually get wrong.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const BUNDLE_DIR = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'dist-pages');

/** Paths the platform serves itself. Everything else is the Function's. */
const STATIC_PREFIXES = ['/assets/*', '/fonts/*'];

/**
 * Runs a child process and stops the build if it fails.
 *
 * `shell` is passed only for `npx`, and this is not cosmetic: on Windows `npx` is a `.cmd`
 * shim that `spawnSync` cannot execute without a shell — but routing *node* through a
 * shell breaks the other way, because `process.execPath` is typically
 * `C:\Program Files\nodejs\node.exe` and the shell splits it at the space. So: no shell
 * for node, shell for npx.
 */
function run(label, command, args, options = {}) {
  // With a shell the command is a single string, not argv: mixing `shell: true` with an
  // args array makes Node concatenate unescaped values, which it warns about and which
  // would break on a path containing a space.
  const result = options.shell
    ? spawnSync([command, ...args].join(' '), { cwd: ROOT, stdio: 'inherit', shell: true })
    : spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) {
    console.error(`build-pages: ${label} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`build-pages: ${label} failed with exit code ${result.status ?? 'null'}`);
    process.exit(result.status ?? 1);
  }
}

/** Total bytes of a directory tree, for the size line at the end. */
function treeBytes(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? treeBytes(path) : statSync(path).size;
  }
  return total;
}

console.log('build-pages: fonts and client script');
run('fonts', process.execPath, ['scripts/sync-fonts.mjs']);
run('assets', process.execPath, ['scripts/build-assets.mjs']);

// Clean both directories. `dist/` is wiped too, because a stale `index.js` from an
// earlier build would be copied in place of a failed bundle and deploy silently.
rmSync(BUNDLE_DIR, { recursive: true, force: true });
rmSync(OUT_DIR, { recursive: true, force: true });

console.log('build-pages: bundling the worker');
// The companion Worker's config is used because it is the one that declares `main`
// without `pages_build_output_dir`; bundling with the Pages config would try to read the
// directory this script has not written yet.
run(
  'bundle',
  'npx',
  ['wrangler', 'deploy', '-c', 'wrangler.worker.jsonc', '--dry-run', '--outdir', 'dist'],
  { shell: true },
);

const bundlePath = join(BUNDLE_DIR, 'index.js');
if (!existsSync(bundlePath)) {
  console.error(`build-pages: wrangler produced no bundle at ${bundlePath}`);
  process.exit(1);
}
const bundle = readFileSync(bundlePath, 'utf8');

// Check the shape rather than trusting the bundler's flags. A `_worker.js` that is not a
// module — the older service-worker form — uploads fine and then fails at request time.
if (!bundle.includes('export default') && !bundle.includes('export{')) {
  console.error('build-pages: the bundle has no default export, so it is not a module worker');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, '_worker.js'), bundle, 'utf8');
console.log(`build-pages: _worker.js (${(Buffer.byteLength(bundle) / 1024).toFixed(1)} KiB)`);

// `public/` holds only immutable bytes, so it is copied wholesale rather than filtered.
// The `_headers` file inside it is a Pages primitive and is honoured where it lands.
cpSync(PUBLIC_DIR, OUT_DIR, { recursive: true });

/**
 * Routing.
 *
 * `include` everywhere and `exclude` the two asset trees: the Function is the only thing
 * that can render a page, so it has to be the default, and the assets are the only paths
 * where invoking it would be pure overhead on the one surface — the payment page — that a
 * customer loads on a phone over a bad connection.
 */
const routes = { version: 1, include: ['/*'], exclude: STATIC_PREFIXES };
writeFileSync(join(OUT_DIR, '_routes.json'), `${JSON.stringify(routes, null, 2)}\n`, 'utf8');

const files = [];
(function walk(directory, prefix) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
    else files.push(`${prefix}${entry.name}`);
  }
})(OUT_DIR, '');
files.sort();

console.log(
  `build-pages: dist-pages ready — ${files.length} files, ${(treeBytes(OUT_DIR) / 1024).toFixed(1)} KiB`,
);
console.log(`build-pages:   ${files.join('\nbuild-pages:   ')}`);
console.log('build-pages: deploy with `npm run deploy` (wrangler pages deploy dist-pages)');
