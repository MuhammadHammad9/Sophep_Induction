/**
 * RLS fail-closed tests.
 *
 * These run DIRECT SQL, bypassing the API entirely. That is deliberate and is the only way
 * the assertion means anything: rules.md R-014 claims the boundary is a property of the
 * database, so a test that goes through the application layer would be testing the
 * application layer.
 *
 * Critical test cases 6 and 7 from the specification live here.
 *
 * Refs: FR-RBAC-005, FR-RBAC-006, FR-RBAC-009, NFR-PRIV-005, E9
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type postgres from 'postgres'
import {
  testDb,
  migrate,
  resetSchema,
  seedFixture,
  asUser,
  asApplicant,
  asAnonymous,
  type Fixture,
} from '../helpers'

let sql: postgres.Sql<Record<string, never>>
let fx: Fixture
let applicantA: string
let applicantB: string

beforeAll(async () => {
  sql = testDb()
  await resetSchema(sql)
  await migrate(sql)
  fx = await seedFixture(sql)

  // Registered with RLS bypassed (table owner during setup), so the tests below exercise
  // reading rather than writing.
  const [a] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_register_applicant(
      ${fx.cycleId}::uuid, 'Applicant A', 'a@example.com', '03001111111', 'online')
  `
  const [b] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_register_applicant(
      ${fx.cycleId}::uuid, 'Applicant B', 'b@example.com', '03002222222', 'online')
  `
  applicantA = a!.id
  applicantB = b!.id
}, 60_000)

afterAll(async () => {
  await sql?.end()
})

describe('the test harness itself', () => {
  /**
   * Guards the guard.
   *
   * Everything below is meaningless if the connection holds BYPASSRLS — the queries would
   * succeed, return everything, and an "RLS test suite" would be asserting nothing at all.
   * This asserts that dropping to rms_app genuinely removes that privilege, so a future
   * change to the harness cannot quietly turn the whole file into theatre.
   */
  it('runs as a role that cannot bypass RLS', async () => {
    const [row] = await asAnonymous(sql, async (tx) => {
      return tx<Array<{ role: string; bypass: boolean }>>`
        SELECT current_user AS role,
               (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass
      `
    })

    expect(row!.role).toBe('rms_app')
    expect(row!.bypass).toBe(false)
  })
})

describe('unset security context', () => {
  /**
   * Critical test case 7. The single most important assertion in the suite.
   *
   * The failure mode being guarded is not "returns an error" — it is "returns EVERYTHING".
   * A boundary that fails open under a pooler is E9, and it is silent.
   */
  it('returns zero rows, never all rows', async () => {
    // No set_config at all — exactly the state a pooled connection is in before binding.
    const rows = await asAnonymous(sql, async (tx) => tx`SELECT id FROM applicants`)

    expect(rows).toHaveLength(0)
  })

  it('returns zero rows for every RLS-protected table', async () => {
    const tables = [
      'applicants',
      'applicant_preferences',
      'access_tokens',
      'memberships',
      'cycles',
      'stages',
      'notifications',
    ]

    for (const table of tables) {
      const rows = await asAnonymous(sql, async (tx) => tx.unsafe(`SELECT * FROM ${table}`))
      expect(rows, `${table} leaked rows with no security context`).toHaveLength(0)
    }
  })

  it('grants no capability', async () => {
    const [row] = await asAnonymous(sql, async (tx) => {
      return tx<Array<{ has: boolean }>>`
        SELECT fn_has_capability(${fx.cycleId}::uuid, 'applicant.view') AS has
      `
    })
    expect(row!.has).toBe(false)
  })

  it('treats a garbage context as unset rather than erroring open', async () => {
    const rows = await asAnonymous(sql, async (tx) => {
      await tx`SELECT set_config('app.user_id', 'not-a-uuid', true)`
      return tx`SELECT id FROM applicants`
    })
    expect(rows).toHaveLength(0)
  })
})

describe('applicant isolation', () => {
  /**
   * NFR-PRIV-005: an applicant shall not, under ANY circumstance, view another applicant's
   * name, status, score or outcome.
   */
  it('lets an applicant see only their own row', async () => {
    const rows = await asApplicant(sql, applicantA, async (tx) => {
      return tx<Array<{ id: string }>>`SELECT id FROM applicants`
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(applicantA)
  })

  it('cannot reach another applicant even by explicit id', async () => {
    const rows = await asApplicant(sql, applicantA, async (tx) => {
      return tx`SELECT id FROM applicants WHERE id = ${applicantB}::uuid`
    })

    expect(rows).toHaveLength(0)
  })

  it('cannot read access_tokens at all', async () => {
    // No applicant-facing SELECT policy exists on this table by design: an applicant
    // authenticates WITH the token and never needs to read the row.
    const rows = await asApplicant(sql, applicantA, async (tx) => {
      return tx`SELECT id FROM access_tokens`
    })

    expect(rows).toHaveLength(0)
  })
})

describe('staff roles', () => {
  it('lets a volunteer see applicants but not manage users', async () => {
    const [caps] = await asUser(sql, fx.users['volunteer']!, async (tx) => {
      return tx<Array<{ can_register: boolean; can_manage: boolean }>>`
        SELECT fn_has_capability(${fx.cycleId}::uuid, 'applicant.register') AS can_register,
               fn_has_capability(${fx.cycleId}::uuid, 'users.manage')       AS can_manage
      `
    })

    expect(caps!.can_register).toBe(true)
    expect(caps!.can_manage).toBe(false)
  })

  /**
   * The Coordinator exists precisely so that someone can run the floor WITHOUT score
   * visibility. If this assertion ever inverts, the role has lost its reason to exist.
   */
  it('denies the coordinator any score visibility', async () => {
    const [caps] = await asUser(sql, fx.users['coordinator']!, async (tx) => {
      return tx<Array<{ priority: boolean; evaluations: boolean }>>`
        SELECT fn_has_capability(${fx.cycleId}::uuid, 'queue.adjust_priority') AS priority,
               fn_has_capability(${fx.cycleId}::uuid, 'evaluation.view_all')   AS evaluations
      `
    })

    expect(caps!.priority).toBe(true)
    expect(caps!.evaluations).toBe(false)
  })

  /** FR-RBAC-009: read everything, write nothing. */
  it('gives the auditor read access and no write capability', async () => {
    const [caps] = await asUser(sql, fx.users['auditor']!, async (tx) => {
      return tx<Array<{ view: boolean; evaluations: boolean; register: boolean; allocate: boolean }>>`
        SELECT fn_has_capability(${fx.cycleId}::uuid, 'applicant.view')     AS view,
               fn_has_capability(${fx.cycleId}::uuid, 'evaluation.view_all') AS evaluations,
               fn_has_capability(${fx.cycleId}::uuid, 'applicant.register')  AS register,
               fn_has_capability(${fx.cycleId}::uuid, 'allocation.run')      AS allocate
      `
    })

    expect(caps!.view).toBe(true)
    expect(caps!.evaluations).toBe(true)
    expect(caps!.register).toBe(false)
    expect(caps!.allocate).toBe(false)
  })

  /**
   * E13. v1's gate assumed exactly one role per user and would have silently denied the
   * second — a Coordinator who also interviews is entirely normal in a society this size.
   */
  it('unions capabilities across multiple roles', async () => {
    const [u] = await sql<Array<{ id: string }>>`
      INSERT INTO users (email, full_name) VALUES ('dual@test.sophep', 'Dual Role') RETURNING id
    `
    await sql`
      INSERT INTO memberships (cycle_id, user_id, role) VALUES
        (${fx.cycleId}::uuid, ${u!.id}::uuid, 'coordinator'::role_name),
        (${fx.cycleId}::uuid, ${u!.id}::uuid, 'interviewer'::role_name)
    `

    const [caps] = await asUser(sql, u!.id, async (tx) => {
      return tx<Array<{ coordinator_cap: boolean; interviewer_cap: boolean }>>`
        SELECT fn_has_capability(${fx.cycleId}::uuid, 'panel.manage')       AS coordinator_cap,
               fn_has_capability(${fx.cycleId}::uuid, 'evaluation.submit')  AS interviewer_cap
      `
    })

    expect(caps!.coordinator_cap).toBe(true)
    expect(caps!.interviewer_cap).toBe(true)
  })

  it('scopes roles to a cycle', async () => {
    const [other] = await sql<Array<{ id: string }>>`
      INSERT INTO cycles (society_id, season, year, name, state)
      VALUES (${fx.societyId}::uuid, 'FA', 2026, 'Fall 2026', 'draft')
      RETURNING id
    `

    const [caps] = await asUser(sql, fx.users['super_admin']!, async (tx) => {
      return tx<Array<{ here: boolean; there: boolean }>>`
        SELECT fn_has_capability(${fx.cycleId}::uuid, 'allocation.run')  AS here,
               fn_has_capability(${other!.id}::uuid, 'allocation.run')   AS there
      `
    })

    expect(caps!.here).toBe(true)
    expect(caps!.there).toBe(false)
  })
})
