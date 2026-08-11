import { defineConfig } from 'vitest/config'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Load DATABASE_URL from the repo-root .env.
 *
 * The RLS and concurrency suites need a real Postgres, so `npm test` must find the connection
 * string without the caller remembering a --env-file flag. Values already in the environment
 * win, so CI (which injects DATABASE_URL directly) is unaffected.
 *
 * Nothing is echoed: a mis-set variable surfaces as a connection error, never as a printed
 * credential (rules.md R-056).
 */
function loadRootEnv(): void {
  // `.env.local` first, matching the Next.js convention where it overrides `.env`. Keeping the
  // same precedence as the dev server matters: if the two files ever drift again, the tests
  // and the running app must fail together rather than one silently passing.
  for (const name of ['.env.local', '.env']) {
    const path = resolve(import.meta.dirname, '..', name)
    if (!existsSync(path)) continue

    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (!match) continue
      const [, key, rawValue] = match
      if (!key || process.env[key]) continue
      process.env[key] = rawValue!.trim().replace(/^["']|["']$/g, '')
    }
  }
}

loadRootEnv()

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],

    // The RLS and concurrency suites each reset the schema in beforeAll. Running files in
    // parallel would have them tearing down each other's fixtures, producing failures that
    // look like RLS bugs and are not. Correctness over speed: the whole suite is seconds.
    fileParallelism: false,

    testTimeout: 60_000,

    /**
     * Setup cost grows with the migration count, and it is paid PER TEST FILE.
     *
     * Each file's beforeAll drops the schema and replays every migration. That is ~30 round
     * trips against a database in another region, so the hook takes tens of seconds and gets
     * slower with every migration added — it crossed the original 60 s limit at migration 27
     * and presented as an intermittent failure rather than an obvious one.
     *
     * Raising the limit is a stopgap, not the fix. The real fix is a vitest globalSetup that
     * resets and migrates ONCE per run, with each file seeding its own uniquely-scoped cycle
     * rather than a shared fixture — tracked for Phase 5 alongside moving the suite to a
     * database that is not across an ocean.
     */
    hookTimeout: 300_000,

    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // NFR-MAIN-003 / R-055. The threshold applies to the logic that is expensive to get
      // wrong: state transitions, the queue claim path, scoring and allocation.
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
    },
  },
})
