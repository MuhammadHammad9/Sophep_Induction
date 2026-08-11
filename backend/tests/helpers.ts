/**
 * Test helpers.
 *
 * The RLS and concurrency suites run against a REAL Postgres, never a mock. That is the whole
 * point: rules.md R-014 says the security boundary is a property of the database, and a mocked
 * boundary verifies nothing at all. CI provisions postgres:16 as a service for exactly this.
 */

import postgres from 'postgres'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, '..', 'supabase', 'migrations')

export function testDb(): postgres.Sql<Record<string, never>> {
  const url = process.env['DATABASE_URL']
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. These tests require a real Postgres — see .env.example. ' +
        'A mocked database cannot verify an RLS policy.',
    )
  }
  return postgres(url, { max: 25, onnotice: () => {} })
}

/** Apply every migration in order, into a clean schema. */
export async function migrate(sql: postgres.Sql<Record<string, never>>): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const contents = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    await sql.unsafe(contents)
  }
}

export async function resetSchema(sql: postgres.Sql<Record<string, never>>): Promise<void> {
  await sql.unsafe(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO PUBLIC;
  `)
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
