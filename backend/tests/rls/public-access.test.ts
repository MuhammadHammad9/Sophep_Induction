/**
 * The two unauthenticated paths.
 *
 * Both exist because a public form and a token-scoped status page must read rows before any
 * security context can exist. Both are therefore holes in the boundary by construction, and
 * the job of this file is to prove they are exactly the size they are meant to be — no larger.
 *
 * Refs: FR-CYC-004, FR-IDT-006, FR-IDT-009, FR-IDT-012, NFR-PRIV-005
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type postgres from 'postgres'
import { testDb, migrate, resetSchema, seedFixture, asAnonymous, type Fixture } from '../helpers'
import { hashToken, generateToken } from '../../src/domain/identity'

let sql: postgres.Sql<Record<string, never>>
let fx: Fixture
let draftCycleId: string
let applicantId: string
let rawToken: string

beforeAll(async () => {
  sql = testDb()
  await resetSchema(sql)
  await migrate(sql)
  fx = await seedFixture(sql)

  const [draft] = await sql<Array<{ id: string }>>`
    INSERT INTO cycles (society_id, season, year, name, state)
    VALUES (${fx.societyId}::uuid, 'FA', 2026, 'Fall 2026', 'draft')
    RETURNING id
  `
  draftCycleId = draft!.id

  await sql`
    INSERT INTO departments (cycle_id, code, name, capacity)
    VALUES (${draftCycleId}::uuid, 'SECRET', 'Unannounced Department', 5)
  `

  const [applicant] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_register_applicant(
      ${fx.cycleId}::uuid, 'Token Holder', 'token@example.com', '03001234567', 'online')
  `
  applicantId = applicant!.id

  const token = generateToken()
  rawToken = token.raw
  await sql`
    SELECT fn_issue_token(
      ${applicantId}::uuid, ${token.hash}::bytea,
      ${new Date(Date.now() + 86_400_000)}::timestamptz, 'test')
  `
}, 60_000)

afterAll(async () => {
  await sql?.end()
})

describe('the public application form', () => {
  it('can see the open cycle', async () => {
    const rows = await asAnonymous(sql, async (tx) => {
      return tx<Array<{ id: string }>>`
        SELECT id FROM cycles WHERE state = 'registration_open'
      `
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(fx.cycleId)
  })

  it('cannot see a draft cycle', async () => {
    // A cycle being planned must not leak. Seeing that "Fall 2026" exists before it is
    // announced is a real disclosure, however small.
    const rows = await asAnonymous(sql, async (tx) => {
      return tx`SELECT id FROM cycles WHERE id = ${draftCycleId}::uuid`
    })

    expect(rows).toHaveLength(0)
  })

  it('can see active departments of the open cycle', async () => {
    const rows = await asAnonymous(sql, async (tx) => {
      return tx`SELECT id FROM departments WHERE cycle_id = ${fx.cycleId}::uuid`
    })

    expect(rows).toHaveLength(3)
  })

  it('cannot see departments of an unannounced cycle', async () => {
    const rows = await asAnonymous(sql, async (tx) => {
      return tx`SELECT id FROM departments WHERE cycle_id = ${draftCycleId}::uuid`
    })

    expect(rows).toHaveLength(0)
  })

  it('cannot read applicants', async () => {
    // The form writes; it must never read anyone (NFR-PRIV-005).
    const rows = await asAnonymous(sql, async (tx) => tx`SELECT id FROM applicants`)
    expect(rows).toHaveLength(0)
  })
})

describe('token resolution', () => {
  it('resolves a valid token to exactly one applicant', async () => {
    const rows = await asAnonymous(sql, async (tx) => {
      return tx<Array<{ applicant_id: string; display_id: string; state: string }>>`
        SELECT * FROM fn_resolve_token(${hashToken(rawToken)}::bytea)
      `
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.applicant_id).toBe(applicantId)
    expect(rows[0]!.state).toBe('submitted')
  })

  it('returns nothing for an unknown token', async () => {
    const rows = await asAnonymous(sql, async (tx) => {
      return tx`SELECT * FROM fn_resolve_token(${hashToken('not-a-real-token')}::bytea)`
    })
    expect(rows).toHaveLength(0)
  })

  it('returns nothing once the token is revoked', async () => {
    // FR-IDT-009: rotation revokes immediately. The old QR must stop working the instant a
    // new one is issued, not at the next cache expiry.
    const replacement = generateToken()
    await sql`
      SELECT fn_issue_token(
        ${applicantId}::uuid, ${replacement.hash}::bytea,
        ${new Date(Date.now() + 86_400_000)}::timestamptz, 'rotation test')
    `

    const old = await asAnonymous(sql, async (tx) => {
      return tx`SELECT * FROM fn_resolve_token(${hashToken(rawToken)}::bytea)`
    })
    const fresh = await asAnonymous(sql, async (tx) => {
      return tx`SELECT * FROM fn_resolve_token(${replacement.hash}::bytea)`
    })

    expect(old).toHaveLength(0)
    expect(fresh).toHaveLength(1)
  })

  it('returns nothing for an expired token', async () => {
    const [expiredApplicant] = await sql<Array<{ id: string }>>`
      SELECT id FROM fn_register_applicant(
        ${fx.cycleId}::uuid, 'Expired', 'expired@example.com', '03007654321', 'online')
    `
    const expired = generateToken()
    await sql`
      SELECT fn_issue_token(
        ${expiredApplicant!.id}::uuid, ${expired.hash}::bytea,
        ${new Date(Date.now() - 1000)}::timestamptz, 'already expired')
    `

    const rows = await asAnonymous(sql, async (tx) => {
      return tx`SELECT * FROM fn_resolve_token(${expired.hash}::bytea)`
    })
    expect(rows).toHaveLength(0)
  })

  it('does not expose the token table itself', async () => {
    // The function is the only route in. If access_tokens ever became readable, holding one
    // token would mean harvesting every hash in the cycle.
    const rows = await asAnonymous(sql, async (tx) => tx`SELECT id FROM access_tokens`)
    expect(rows).toHaveLength(0)
  })

  it('exposes only the fields the status page renders', async () => {
    // Guards against a future migration adding a column that a SELECT * would silently leak
    // to an unauthenticated caller.
    const [row] = await asAnonymous(sql, async (tx) => {
      return tx<Array<Record<string, unknown>>>`
        SELECT * FROM fn_resolve_token(${hashToken(rawToken + 'x')}::bytea)
      `.then(() => tx<Array<Record<string, unknown>>>`
        SELECT * FROM fn_resolve_token(
          (SELECT token_hash FROM access_tokens
            WHERE applicant_id = ${applicantId}::uuid AND revoked_at IS NULL))
      `)
    })

    expect(Object.keys(row!).sort()).toEqual(
      ['applicant_id', 'cycle_id', 'cycle_name', 'display_id', 'full_name', 'state'].sort(),
    )
  })
})
