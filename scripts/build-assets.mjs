#!/usr/bin/env node
/**
 * Emits the page interaction script as a static asset.
 *
 * Why this exists, because it is not obvious and it fixes a real bug:
 *
 *   The Content-Security-Policy in `src/core/http.ts` is `script-src 'self'` with no
 *   `'unsafe-inline'`. That is the correct policy — it means injected markup cannot
 *   execute even if an escaping bug slips through somewhere. But it also means an
 *   inline `<script>` block is *silently blocked by the browser*. The copy buttons,
 *   the countdown and the status polling would all stop working in production with
 *   nothing in the server logs, because the failure happens in the client.
 *
 *   So the script is served from `/assets/client.js` instead. That satisfies
 *   `script-src 'self'`, lets Cloudflare cache it immutably at the edge, and takes
 *   ~3 KB out of every page's HTML — which matters most on the payment page, the one
 *   surface a customer loads on a phone over a bad connection.
 *
 * The source of truth stays `CLIENT_JS` in `src/ui/theme.ts`, so the script is
 * linted and typechecked alongside the code that renders the elements it targets.
 * This script only copies it out; it never rewrites it.
 *
 * The types are stripped by `scripts/import-ts.mjs` rather than by the runtime. Node would
 * do it, but only from 22.18 onwards, and the Cloudflare Pages build image runs 22.16 —
 * where this import is what broke the deploy. See that file for the whole account.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTypeScript } from './import-ts.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'public', 'assets');
const OUT_FILE = join(OUT_DIR, 'client.js');

const { CLIENT_JS } = await importTypeScript(join(ROOT, 'src', 'ui', 'theme.ts'));

if (typeof CLIENT_JS !== 'string' || CLIENT_JS.trim().length === 0) {
  console.error('assets: CLIENT_JS is missing or empty; refusing to write an empty script');
  process.exit(1);
}

/**
 * The script is emitted inside an IIFE that already declares 'use strict'. A leading
 * newline is trimmed rather than stripped globally, so a blank line inside the source
 * still reads as a line break in the generated file.
 */
const banner = `/* Steve Pay client script. Generated from src/ui/theme.ts by scripts/build-assets.mjs.\n   Do not edit public/assets/client.js directly — edit CLIENT_JS and re-run \`npm run assets\`. */\n`;

const body = `${banner}${CLIENT_JS.trimStart()}`;

mkdirSync(OUT_DIR, { recursive: true });

// Skip the write when nothing changed, so a watch-mode rebuild does not touch the
// file's mtime and invalidate the asset on every run.
let previous = '';
try {
  previous = readFileSync(OUT_FILE, 'utf8');
} catch {
  previous = '';
}

if (previous === body) {
  console.log(`assets: client.js unchanged (${Buffer.byteLength(body)} bytes)`);
} else {
  writeFileSync(OUT_FILE, body, 'utf8');
  console.log(`assets: wrote public/assets/client.js (${Buffer.byteLength(body)} bytes)`);
}
