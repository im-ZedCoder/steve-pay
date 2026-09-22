/**
 * Vitest configuration.
 *
 * The Workers pool runs the tests *inside workerd* against real bindings — a real D1
 * database with the real migration SQL applied, real KV and real Queues. Nothing is
 * mocked. That matters more here than in most projects: the correctness of this system
 * lives in partial unique indexes, CHECK constraints, append-only triggers and `INSERT ...
 * ON CONFLICT` semantics, and a fake D1 would test a different program than the one that
 * ships.
 *
 * Note on the API shape: this version of `@cloudflare/vitest-pool-workers` exposes the pool
 * as the `cloudflareTest()` Vite plugin rather than the older `defineWorkersConfig()`
 * helper, so the plugin array — not `test.poolOptions` — is where the pool is configured.
 */

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  // Migrations and seeds are read at config time and handed to the runtime as bindings, so
  // every test run applies the exact SQL production will apply. `readD1Migrations` splits
  // each file into statements, which is what `applyD1Migrations` replays.
  const migrations = await readD1Migrations('migrations');
  const seeds = await readD1Migrations('seeds');

  return {
    plugins: [
      cloudflareTest({
        // The **companion Worker** config, not the Pages one. Workerd needs a `main` to
        // build an entrypoint, and the Pages config deliberately has none — its entry point
        // is assembled into `dist-pages/_worker.js` at build time. The companion config
        // names the same `src/index.ts` and declares the same D1 and KV bindings, so the
        // tests still run against a deployment-shaped runtime with the real bindings, the
        // real compatibility date and the real compatibility flags.
        wrangler: { configPath: './wrangler.worker.jsonc' },
        // One worker and no storage isolation keeps the migration setup paid once and lets
        // several tests observe the same database, which the concurrency tests rely on.
        singleWorker: true,
        isolatedStorage: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_SEEDS: seeds,
            // Deterministic secrets so tokens produced in one test are readable in the
            // next, and so no test depends on the development fallbacks being present.
            SESSION_SECRET: 'test-session-secret-value-0123456789',
            API_KEY_PEPPER: 'test-api-key-pepper-value-0123456789',
            WEBHOOK_SECRET: 'test-webhook-secret-value-0123456789',
            ENVIRONMENT: 'development',
            // No BASE_URL. There is no such variable any more: the platform reads its own
            // origin from each request, so the tests get it from the request URLs they
            // build (`https://steve-pay.test/...`) exactly as a deployment gets it from the
            // host the visitor used.
            GATEWAY_FEE_TOMAN: '3000',
            UNIQUE_SUFFIX_DIGITS: '4',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.test.ts'],
      // A failed expectation must not leave a half-written invoice behind that makes the
      // next file fail for an unrelated reason; the file's own assertions own its state.
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  };
});
