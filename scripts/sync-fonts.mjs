#!/usr/bin/env node
/**
 * Copies the exact font files the UI needs out of node_modules into `public/fonts`.
 *
 * Why self-host instead of a font CDN:
 *   1. Iranian networks routinely see large font CDNs degraded or blocked.
 *   2. A payment page must not depend on a third-party origin to render its amounts.
 *   3. Cloudflare caches the woff2 at the edge next to the Worker that needs it.
 *
 * Vazirmatn on Fontsource ships static weights, not a variable file, so the weight
 * set is a deliberate budget rather than "whatever is available":
 *
 *   payment page   arabic 400 + arabic 700          ~43 KB, two faces
 *   dashboard      + arabic 500, latin 400/700      adds the Latin identifier faces
 *   mono           IBM Plex Mono 400/500            API keys, invoice IDs, curl samples
 *
 * Everything is subset by script and by weight, so a page only ever downloads the
 * faces it actually renders. The payment page never downloads a Latin face.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const OUT = join(process.cwd(), 'public', 'fonts');

/** @param {string} pkg @param {string} file */
function resolveFontFile(pkg, file) {
  const pkgJson = require.resolve(`${pkg}/package.json`);
  return join(dirname(pkgJson), 'files', file);
}

const WANTED = [
  // [source package, source file, destination file]
  ['@fontsource/vazirmatn', 'vazirmatn-arabic-400-normal.woff2', 'vazirmatn-arabic-400.woff2'],
  ['@fontsource/vazirmatn', 'vazirmatn-arabic-500-normal.woff2', 'vazirmatn-arabic-500.woff2'],
  ['@fontsource/vazirmatn', 'vazirmatn-arabic-700-normal.woff2', 'vazirmatn-arabic-700.woff2'],
  ['@fontsource/vazirmatn', 'vazirmatn-latin-400-normal.woff2', 'vazirmatn-latin-400.woff2'],
  ['@fontsource/vazirmatn', 'vazirmatn-latin-700-normal.woff2', 'vazirmatn-latin-700.woff2'],
  ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2', 'plex-mono-400.woff2'],
  ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-500-normal.woff2', 'plex-mono-500.woff2'],
];

mkdirSync(OUT, { recursive: true });

let copied = 0;
const missing = [];

for (const [pkg, src, dest] of WANTED) {
  let from;
  try {
    from = resolveFontFile(pkg, src);
  } catch {
    missing.push(`${pkg} (package not installed)`);
    continue;
  }
  if (!existsSync(from)) {
    // Fontsource occasionally renames subsets between releases; report, don't crash the build.
    missing.push(`${pkg}/files/${src}`);
    continue;
  }
  const to = join(OUT, dest);
  if (existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs) continue;
  copyFileSync(from, to);
  copied += 1;
}

if (copied > 0) console.log(`fonts: copied ${copied} file(s) to public/fonts`);

if (missing.length > 0) {
  console.warn('fonts: could not resolve, UI will fall back to system fonts:');
  for (const m of missing) console.warn(`  - ${m}`);
  const available = existsSync(join(dirname(require.resolve('@fontsource/vazirmatn/package.json')), 'files'))
    ? readdirSync(join(dirname(require.resolve('@fontsource/vazirmatn/package.json')), 'files')).filter(
        (f) => f.startsWith('vazirmatn') && f.endsWith('.woff2'),
      )
    : [];
  if (available.length > 0) console.warn(`  vazirmatn files present: ${available.join(', ')}`);
}

// A missing font is a silent visual failure: the page still renders and nothing
// throws, so it ships looking like a default sans-serif. Fail the build instead.
if (missing.length > 0 && process.env.CI) {
  console.error('fonts: refusing to build with missing font files (CI=true)');
  process.exit(1);
}
