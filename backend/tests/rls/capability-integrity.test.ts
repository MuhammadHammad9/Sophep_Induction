/**
 * Capabilities must never be self-asserted.
 *
 * This file exists because a "fast path" was once added to fn_has_capability that read an
 * application-set GUC (`app.capabilities`) instead of querying memberships. `set_config` is
 * available to the application role, so any caller could assert
 * `evaluation.view_all,results.lock` and be granted both — with no membership and no user id.
 *
 * That is a total authorisation bypass, and critically it is INVISIBLE to every other test in
 * this suite, because they all bind `app.user_id` and never think to assert a capability. It
 * would have shipped green.
 *
 * FR-RBAC-004 puts the boundary in the database precisely so it does not depend on the
 * application telling the truth. These tests assert that property directly.
 *
 * Refs: FR-RBAC-004, FR-RBAC-005, FR-INT-004, rules.md R-014, R-032
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type postgres from 'postgres'
import { testDb, migrate, resetSchema, seedFixture, type Fixture } from '../helpers'

let sql: postgres.Sql<Record<string, never>>
let fx: Fixture

beforeAll(async () => {
  sql = testDb()
  await resetSchema(sql)
  await migrate(sql)
  fx = await seedFixture(sql)
}, 90_000)

afterAll(async () => {
  await sql?.end()
})

/** Run as the application role, asserting whatever the caller claims. */
async function asClaimant<T>(
  claims: string | null,
  fn: (tx: postgres.TransactionSql<Record<string, never>>) => Promise<T>,
  userId?: string,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE rms_app`
    if (userId) await tx`SELECT set_config('app.user_id', ${userId}, true)`
    if (claims !== null) await tx`SELECT set_config('app.capabilities', ${claims}, true)`
    return fn(tx as postgres.TransactionSql<Record<string, never>>)
  }) as Promise<T>
}

describe('a self-asserted capability grants nothing', () => {
  it.each([
    'evaluation.view_all',
    'results.lock',
    'allocation.run',
    'aggregates.view',
    'users.manage',
    'applicant.view',
  ])('refuses a claimed %s from a caller with no membership', async (capability) => {
    const [row] = await asClaimant(capability, (tx) =>
      tx<Array<{ allowed: boolean }>>`
        SELECT fn_has_capability(${fx.cycleId}::uuid, ${capability}) AS allowed
      `,
    )
    expect(row!.allowed).toBe(false)
  })

  it('refuses a comma-separated list of claims', async () => {
    const [row] = await asClaimant('evaluation.view_all,results.lock,allocation.run', (tx) =>
      tx<Array<{ scores: boolean; lock: boolean }>>`
        SELECT fn_has_capability(${fx.cycleId}::uuid, 'evaluation.view_all') AS scores,
               fn_has_capability(${fx.cycleId}::uuid, 'results.lock')        AS lock
      `,
    )
    expect(row!.scores).toBe(false)
    expect(row!.lock).toBe(false)
  })

  it('does not let a claim widen a real membership', async () => {
    // The Coordinator legitimately holds panel.manage and legitimately does NOT hold
    // evaluation.view_all — floor authority without score visibility is the reason that role
    // exists. Claiming the missing one must not grant it.
    const [row] = await asClaimant(
      'evaluation.view_all',
      (tx) =>
        tx<Array<{ real: boolean; claimed: boolean }>>`
          SELECT fn_has_capability(${fx.cycleId}::uuid, 'panel.manage')       AS real,
                 fn_has_capability(${fx.cycleId}::uuid, 'evaluation.view_all') AS claimed
        `,
      fx.users['coordinator']!,
    )

    expect(row!.real).toBe(true)
    expect(row!.claimed).toBe(false)
  })

  it('does not expose evaluations to a claimed capability', async () => {
    // The end-to-end consequence, not just the predicate: blind evaluation must hold.
    const rows = await asClaimant('evaluation.view_all', (tx) => tx`SELECT id FROM evaluations`)
    expect(rows).toHaveLength(0)
  })

  it('does not expose applicants to a claimed capability', async () => {
    const rows = await asClaimant('applicant.view', (tx) => tx`SELECT id FROM applicants`)
    expect(rows).toHaveLength(0)
  })
})

describe('the real path still works', () => {
  it('grants a capability that a held role actually confers', async () => {
    const [row] = await asClaimant(
      null,
      (tx) =>
        tx<Array<{ allowed: boolean }>>`
          SELECT fn_has_capability(${fx.cycleId}::uuid, 'evaluation.view_all') AS allowed
        `,
      fx.users['super_admin']!,
    )
    expect(row!.allowed).toBe(true)
  })

  it('still fails closed with no context at all', async () => {
    const [row] = await asClaimant(null, (tx) =>
      tx<Array<{ allowed: boolean }>>`
        SELECT fn_has_capability(${fx.cycleId}::uuid, 'applicant.view') AS allowed
      `,
    )
    expect(row!.allowed).toBe(false)
  })
})

describe('the function body itself', () => {
  it('does not read app.capabilities', async () => {
    // A behavioural test can only catch the shapes it imagines. This asserts the property
    // structurally: the predicate must not consult any caller-supplied capability claim,
    // whatever form a future "optimisation" takes.
    const [row] = await sql<Array<{ prosrc: string }>>`
      SELECT prosrc FROM pg_proc WHERE proname = 'fn_has_capability'
    `

    // Comments are part of prosrc, and the body deliberately DISCUSSES app.capabilities to
    // explain why it must not be trusted. Strip comments so this tests the code rather than
    // the prose — otherwise documenting the hazard would fail the test that guards it.
    const code = row!.prosrc
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')

    expect(code).not.toMatch(/app\.capabilities/)
    expect(code).not.toMatch(/current_setting\s*\(\s*'app\.cap/)
    expect(code).toMatch(/memberships/)
  })
})
