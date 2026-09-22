#!/usr/bin/env node
/**
 * Imports a TypeScript module from a plain Node script.
 *
 * WHY THIS EXISTS
 *
 * Three build and operator scripts need a value that lives in a `.ts` module: the client
 * script in `src/ui/theme.ts`, and `hashPassword`/`id` in `src/core/crypto.ts` and
 * `src/core/ids.ts`. The obvious `await import('./theme.ts')` works — but only on a Node
 * that strips types at import time, which is 22.18+ and 23.6+ and later. The Cloudflare
 * Pages build image runs **22.16**, where the same import throws:
 *
 *   TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"
 *     for /opt/buildhome/repo/src/ui/theme.ts
 *
 * That is the worst shape a build failure can have: it works on the developer's machine
 * and fails in the deploy environment, with a stack trace about the module loader rather
 * than about the project. `node --no-experimental-strip-types script.mjs` reproduces it on
 * a newer Node, which is how this file was tested.
 *
 * So the types are stripped here instead, by the TypeScript compiler the project already
 * depends on and already typechecks with. No new dependency, and no assumption about what
 * the runtime does with a `.ts` file.
 *
 * WHY A `data:` URL
 *
 * The stripped output is imported from a `data:` URL rather than written to a temp file:
 * nothing is created on disk, nothing can be left behind, and there is no window in which a
 * file containing project source sits in a shared temp directory.
 *
 * The one thing a `data:` URL cannot do is resolve a module specifier — it has no
 * directory, so `./sibling` has no meaning and a bare package name has no `node_modules`
 * to search. That is checked before the import and reported as the limitation it is, rather
 * than surfacing as an unresolved-module crash. Every module this loader is used for is a
 * leaf today; the check is what keeps that a requirement instead of a coincidence.
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * A module specifier on an `import`/`export …from` statement.
 *
 * Anchored to the start of a line so that `import` inside a string literal — the client
 * script in `theme.ts` contains hundreds of lines of JavaScript as text — cannot match.
 */
const MODULE_SPECIFIER = /(?:^|\n)[ \t]*(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/;

/**
 * Loads a TypeScript module and returns its exports.
 *
 * The path must be absolute. Pass it through `join(ROOT, ...)` in the caller: a relative
 * path would resolve against this script's directory, not the caller's.
 */
export async function importTypeScript(absolutePath) {
  const source = readFileSync(absolutePath, 'utf8');

  const specifier = MODULE_SPECIFIER.exec(source)?.[1];
  if (specifier !== undefined) {
    throw new Error(
      `import-ts: ${absolutePath} imports "${specifier}", and a data: URL cannot resolve a module ` +
        'specifier. Load this file with the bundler instead, or inline the value it needs.',
    );
  }

  const { outputText } = ts.transpileModule(source, {
    fileName: absolutePath,
    compilerOptions: {
      // Strip the types, change nothing else. `ESNext`/`ES2022` match `tsconfig.json`, so
      // the module this evaluates is the same shape the Worker bundle contains.
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      // `transpileModule` compiles one file at a time with no type information, which is
      // exactly the contract `isolatedModules` describes. Nothing here is typechecked:
      // that is what `npm run typecheck` is for, over the whole project.
      isolatedModules: true,
    },
  });

  // Base64 rather than the raw source: a `data:` URL is opaque text, and base64 avoids
  // having to escape `%`, `#` and newlines that the template literals are full of.
  const encoded = Buffer.from(outputText, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}
