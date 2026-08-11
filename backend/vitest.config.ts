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
  // NOTE the order: `.env` is read FIRST and wins, which is the opposite of the Next.js
  // convention where `.env.local` overrides `.env`.
  //
  // This is deliberate and temporary. The repo currently contains two .env files holding
  // DIFFERENT database passwords, and the one in `.env.local` does not authenticate. Reading
  // `.env` first keeps the suite runnable, but it papers over a real problem: the Next.js dev
  // server applies the opposite precedence, so the app will fail to connect even while tests
  // pass. Reconcile the two files (delete `.env.local`, or correct its password) and then
  // restore the conventional order here.
  for (const name of ['.env', '.env.local']) {
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

    // Schema reset plus every migration on a cold database.
    testTimeout: 30_000,
    hookTimeout: 60_000,

    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // NFR-MAIN-003 / R-055. The threshold applies to the logic that is expensive to get
      // wrong: state transitions, the queue claim path, scoring and allocation.
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
    },
  },
})
