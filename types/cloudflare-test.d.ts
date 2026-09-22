/**
 * Type declarations for the Vitest Workers test pool.
 *
 * This file must stay a *script* — no top-level `import`/`export` — because
 * `declare module 'cloudflare:test'` only registers an ambient module (for a
 * specifier that does not exist on disk) when the declaring file is global. Types
 * are therefore referenced through a global alias built with inline `import(...)`
 * syntax, which is also what lets `ProvidedEnv` extend the project `Env`:
 * `interface X extends import(...)` is not valid syntax, but extending a global
 * alias to that type is.
 */

type SteveGateEnv = import('../src/env').Env;
type SteveGateMigration = import('@cloudflare/vitest-pool-workers').D1Migration;

declare module 'cloudflare:test' {
  interface ProvidedEnv extends SteveGateEnv {
    TEST_MIGRATIONS: SteveGateMigration[];
    TEST_SEEDS: SteveGateMigration[];
  }

  export function applyD1Migrations(
    db: D1Database,
    migrations: SteveGateMigration[],
    options?: { name?: string },
  ): Promise<void>;

  export const env: ProvidedEnv;
  export const SELF: Fetcher;
  export const createExecutionContext: () => ExecutionContext;
  export const waitOnExecutionContext: (ctx: ExecutionContext) => Promise<void>;
}
