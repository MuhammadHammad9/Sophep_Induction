import { defineConfig } from 'vitest/config'

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
