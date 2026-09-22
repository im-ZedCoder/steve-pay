/**
 * Test bootstrap.
 *
 * Runs the real migration SQL against the real D1 binding inside workerd. That
 * means the tests exercise the same partial unique indexes, CHECK constraints and
 * append-only triggers that production runs — which is the whole point of using
 * the Workers pool instead of mocking the database.
 */

import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.DB, env.TEST_SEEDS);
});
