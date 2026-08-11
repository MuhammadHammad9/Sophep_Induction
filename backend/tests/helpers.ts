/**
 * Test helpers.
 *
 * The RLS and concurrency suites run against a REAL Postgres, never a mock. That is the whole
 * point: rules.md R-014 says the security boundary is a property of the database, and a mocked
 * boundary verifies nothing at all. CI provisions postgres:16 as a service for exactly this.
 */

import postgres from 'postgres'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, '..', 'supabase', 'migrations')

/**
 * The pooled client the tests run their assertions through.
 *
 * Two deliberate choices, both learned from running this against a real Supabase project:
 *
 * 1. **Transaction mode, not session mode.** Supabase's session pooler caps clients at 15, so
 *    the 20-actor concurrency test (FR-IDT-004, FR-QUE-002) cannot even be expressed there —
 *    it fails with EMAXCONNSESSION before proving anything. The transaction pooler handles it.
 *
 *    This is also the more faithful environment: transaction-mode pooling is exactly the
 *    configuration that produced errata E9, where a session-level SET either leaks into an
 *    unrelated request or vanishes. Testing the RLS boundary anywhere else would be testing
 *    the easy case.
 *
 * 2. **prepare: false.** Named prepared statements do not survive transaction-mode pooling,
 *    because consecutive statements may land on different backend connections.
 */
export function testDb(): postgres.Sql<Record<string, never>> {
  const raw = process.env['DATABASE_URL']
  if (!raw) {
    throw new Error(
      'DATABASE_URL is not set. These tests require a real Postgres — see .env.example. ' +
        'A mocked database cannot verify an RLS policy.',
    )
  }

  const url = new URL(raw)
  // Supabase exposes session pooling on 5432 and transaction pooling on 6543 for the same host.
  if (url.hostname.includes('pooler.supabase.com') && url.port === '5432') {
    url.port = '6543'
  }

  return postgres(url.toString(), { max: 25, prepare: false, onnotice: () => {} })
}

/**
 * A dedicated single-connection client for DDL.
 *
 * Migration files contain explicit BEGIN/COMMIT, and postgres.js refuses those on a pooled
 * connection (`UNSAFE_TRANSACTION`) because a pool could hand the COMMIT to a different
 * socket than the BEGIN. `max: 1` pins everything to one connection.
 */
function ddlClient(): postgres.Sql<Record<string, never>> {
  const url = process.env['DATABASE_URL']
  if (!url) throw new Error('DATABASE_URL is not set')
  return postgres(url, { max: 1, onnotice: () => {} })
}

/**
 * Apply every migration in order, recording each in the ledger.
 *
 * The ledger write is not decorative: `scripts/migrate.mjs` uses it to decide what is pending,
 * and migrations are NOT idempotent (`CREATE TYPE` fails on a second run). If the tests
 * migrated without recording, a database left behind by a test run would look unmigrated to
 * the ledger but already contain every object — and `npm run db:migrate` would fail on it
 * forever, for reasons that have nothing to do with the migration being run.
 */
export async function migrate(_sql?: postgres.Sql<Record<string, never>>): Promise<void> {
  const sql = ddlClient()
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()

    for (const file of files) {
      const body = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      await sql.unsafe(body)
      const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16)
      await sql`
        INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${checksum})
        ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum
      `
    }
  } finally {
    await sql.end()
  }
}

/**
 * Drop and recreate the public schema.
 *
 * ⚠ THIS DESTROYS EVERY TABLE AND ROW IN THE TARGET DATABASE.
 *
 * The suite needs a known-empty schema — several tests assert exact row counts, and a
 * half-migrated or partly-populated database produces failures that look like RLS bugs and
 * are not. But that makes pointing DATABASE_URL at a database anyone cares about
 * catastrophic, and the only signal would be the data being gone.
 *
 * So it refuses unless RMS_ALLOW_DESTRUCTIVE_TESTS=1 is set explicitly, and additionally
 * refuses if the database already holds applicant records — a schema with real applicants in
 * it is not a test database, whatever the flag says.
 *
 * Ideally the test database is a separate Supabase project (or a Supabase branch) from the
 * one used for development.
 */
export async function resetSchema(_sql?: postgres.Sql<Record<string, never>>): Promise<void> {
  if (process.env['RMS_ALLOW_DESTRUCTIVE_TESTS'] !== '1') {
    throw new Error(
      'Refusing to drop the schema. These tests DELETE EVERYTHING in the database that ' +
        'DATABASE_URL points at.\n' +
        'If that database is genuinely disposable, set RMS_ALLOW_DESTRUCTIVE_TESTS=1.\n' +
        'Prefer a separate Supabase project or branch for testing.',
    )
  }

  const sql = ddlClient()
  try {
    // Second gate: a marker table this suite plants after its first successful reset.
    //
    // A plain "are there applicant rows?" check would be rerun-hostile — the previous run's
    // own fixtures would block the next one. The marker distinguishes "a database this suite
    // owns" from "a database with data we did not create", which is the case actually worth
    // refusing.
    const [marker] = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = '_rms_test_database'
      ) AS exists
    `

    if (!marker?.exists) {
      const [applicantsTable] = await sql<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'applicants'
        ) AS exists
      `

      if (applicantsTable?.exists) {
        const [applicants] = await sql<Array<{ count: string }>>`
          SELECT count(*)::text AS count FROM applicants
        `
        const n = Number(applicants?.count ?? 0)
        if (n > 0) {
          throw new Error(
            `Refusing to drop a schema containing ${n} applicant record(s) that this test ` +
              'suite did not create. This looks like a real database.\n' +
              'If it genuinely is disposable, drop the schema manually once and re-run — ' +
              'the suite will then mark it as its own.',
          )
        }
      }
    }

    await sql.unsafe(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO PUBLIC;
      COMMENT ON SCHEMA public IS 'RMS test schema — dropped and recreated by the test suite';
      CREATE TABLE _rms_test_database (note text);
    `)
  } finally {
    await sql.end()
  }
}

export interface Fixture {
  societyId: string
  cycleId: string
  departmentIds: string[]
  trackId: string
  users: Record<string, string>
}

/**
 * A cycle in `registration_open` with three departments and one general track.
 *
 * One general track is the committee's locked decision — a single interview, with department
 * fit as a rubric criterion, rather than one interview per department preference.
 */
export async function seedFixture(
  sql: postgres.Sql<Record<string, never>>,
): Promise<Fixture> {
  const [society] = await sql<Array<{ id: string }>>`
    INSERT INTO societies (code, name) VALUES ('SPH', 'SOPHEP') RETURNING id
  `
  const societyId = society!.id

  const [cycle] = await sql<Array<{ id: string }>>`
    INSERT INTO cycles (society_id, season, year, name, state)
    VALUES (${societyId}::uuid, 'SP', 2026, 'Spring 2026', 'registration_open')
    RETURNING id
  `
  const cycleId = cycle!.id

  const departments = await sql<Array<{ id: string }>>`
    INSERT INTO departments (cycle_id, code, name, capacity) VALUES
      (${cycleId}::uuid, 'TECH',    'Technology',  8),
      (${cycleId}::uuid, 'MEDIA',   'Media',       6),
      (${cycleId}::uuid, 'EVENTS',  'Events',     10)
    RETURNING id
  `

  const [track] = await sql<Array<{ id: string }>>`
    INSERT INTO tracks (cycle_id, code, name)
    VALUES (${cycleId}::uuid, 'general', 'General')
    RETURNING id
  `

  const roles = [
    'super_admin',
    'coordinator',
    'admin',
    'volunteer',
    'interviewer',
    'auditor',
  ] as const

  const users: Record<string, string> = {}
  for (const role of roles) {
    const [u] = await sql<Array<{ id: string }>>`
      INSERT INTO users (email, full_name)
      VALUES (${`${role}@test.sophep`}, ${role})
      RETURNING id
    `
    users[role] = u!.id
    await sql`
      INSERT INTO memberships (cycle_id, user_id, role)
      VALUES (${cycleId}::uuid, ${u!.id}::uuid, ${role}::role_name)
    `
  }

  return {
    societyId,
    cycleId,
    departmentIds: departments.map((d) => d.id),
    trackId: track!.id,
    users,
  }
}

/**
 * Run a callback as the application role with a transaction-scoped security context.
 *
 * `SET LOCAL ROLE rms_app` is not optional here and is the difference between a real test and
 * a meaningless one. The test suite connects as the database superuser, which holds BYPASSRLS
 * — so without dropping to a non-privileged role, every policy in migration 0008 is skipped
 * and an "RLS test" would be asserting nothing whatsoever.
 *
 * This mirrors withContext() exactly, on purpose: the tests must exercise the same mechanism
 * production uses, not a parallel one that happens to agree.
 */
export async function asUser<T>(
  sql: postgres.Sql<Record<string, never>>,
  userId: string | null,
  fn: (tx: postgres.TransactionSql<Record<string, never>>) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE rms_app`
    await tx`SELECT set_config('app.user_id', ${userId ?? ''}, true)`
    return fn(tx as postgres.TransactionSql<Record<string, never>>)
  }) as Promise<T>
}

export async function asApplicant<T>(
  sql: postgres.Sql<Record<string, never>>,
  applicantId: string | null,
  fn: (tx: postgres.TransactionSql<Record<string, never>>) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE rms_app`
    await tx`SELECT set_config('app.applicant_id', ${applicantId ?? ''}, true)`
    return fn(tx as postgres.TransactionSql<Record<string, never>>)
  }) as Promise<T>
}

/** The application role with NO context bound — the fail-closed case. */
export async function asAnonymous<T>(
  sql: postgres.Sql<Record<string, never>>,
  fn: (tx: postgres.TransactionSql<Record<string, never>>) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE rms_app`
    return fn(tx as postgres.TransactionSql<Record<string, never>>)
  }) as Promise<T>
}
