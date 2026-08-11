/**
 * Identifier allocation under concurrency.
 *
 * Critical test case 1. This is the test that would have caught the single most common bug in
 * systems of this shape: `SELECT MAX(sequence)+1` passes every test written by one person on
 * one laptop, and produces duplicate identifiers the first time two registration desks press
 * Save in the same second.
 *
 * It only fails under genuine parallelism, so these requests are issued on separate
 * connections and awaited together — a sequential loop proves nothing.
 *
 * Refs: FR-IDT-003, FR-IDT-004, rules.md R-020
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type postgres from 'postgres'
import { testDb, migrate, resetSchema, seedFixture, type Fixture } from '../helpers'
import { parseDisplayId } from '../../src/domain/identity'

let sql: postgres.Sql<Record<string, never>>
let fx: Fixture

beforeAll(async () => {
  sql = testDb()
  await resetSchema(sql)
  await migrate(sql)
  fx = await seedFixture(sql)
}, 60_000)

afterAll(async () => {
  await sql?.end()
})

describe('concurrent registration', () => {
  const CONCURRENCY = 20

  it('produces 20 distinct identifiers with no gaps from contention', async () => {
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        sql.begin(async (tx) => {
          const rows = await tx<Array<{ display_id: string; sequence: number }>>`
            SELECT display_id, sequence FROM fn_register_applicant(
              ${fx.cycleId}::uuid,
              ${`Concurrent ${i}`},
              ${`concurrent${i}@example.com`},
              ${`0300${String(i).padStart(7, '0')}`},
              'online'
            )
          `
          return rows[0]!
        }),
      ),
    )

    const displayIds = results.map((r) => r.display_id)
    const sequences = results.map((r) => r.sequence).sort((a, b) => a - b)

    // FR-IDT-004: zero duplicates.
    expect(new Set(displayIds).size).toBe(CONCURRENCY)

    // FR-IDT-004: zero gaps attributable to contention. A gap would mean the counter was
    // incremented for a transaction that then rolled back — recoverable, but it means the
    // increment is not where we think it is.
    expect(sequences).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i + 1))
  })

  it('formats every identifier correctly', async () => {
    const rows = await sql<Array<{ display_id: string }>>`
      SELECT display_id FROM applicants WHERE cycle_id = ${fx.cycleId}::uuid
    `

    for (const { display_id } of rows) {
      const parsed = parseDisplayId(display_id)
      expect(parsed, `${display_id} did not parse`).not.toBeNull()
      expect(parsed!.societyCode).toBe('SPH')
      expect(parsed!.season).toBe('SP')
      expect(parsed!.year).toBe(2026)
    }
  })

  it('keeps sequences distinct across cycles without reusing identifiers', async () => {
    // FR-IDT-002: identifiers are unique within a cycle and never reused across cycles. The
    // season marker is what makes SP26 and FA26 distinguishable — the originally proposed
    // format could not tell them apart.
    const [fall] = await sql<Array<{ id: string }>>`
      INSERT INTO cycles (society_id, season, year, name, state)
      VALUES (${fx.societyId}::uuid, 'FA', 2026, 'Fall 2026', 'registration_open')
      RETURNING id
    `

    const [row] = await sql<Array<{ display_id: string }>>`
      SELECT display_id FROM fn_register_applicant(
        ${fall!.id}::uuid, 'Fall Applicant', 'fall@example.com', '03009999999', 'online')
    `

    expect(row!.display_id).toBe('SPH-FA26-0001')

    const spring = await sql<Array<{ display_id: string }>>`
      SELECT display_id FROM applicants
       WHERE cycle_id = ${fx.cycleId}::uuid AND sequence = 1
    `
    expect(spring[0]!.display_id).toBe('SPH-SP26-0001')
  })
})

describe('token issuance', () => {
  it('keeps exactly one active token per applicant through rotation', async () => {
    const [applicant] = await sql<Array<{ id: string }>>`
      SELECT id FROM fn_register_applicant(
        ${fx.cycleId}::uuid, 'Rotate Me', 'rotate@example.com', '03008888888', 'online')
    `

    const hash = (n: number) =>
      Buffer.from(Array.from({ length: 32 }, (_, i) => (i + n) % 256))

    for (let i = 0; i < 3; i++) {
      await sql`
        SELECT fn_issue_token(
          ${applicant!.id}::uuid, ${hash(i)}::bytea,
          ${new Date(Date.now() + 86_400_000)}::timestamptz, 'test rotation')
      `
    }

    const active = await sql<Array<{ id: string }>>`
      SELECT id FROM access_tokens
       WHERE applicant_id = ${applicant!.id}::uuid AND revoked_at IS NULL
    `
    const all = await sql<Array<{ id: string }>>`
      SELECT id FROM access_tokens WHERE applicant_id = ${applicant!.id}::uuid
    `

    // FR-IDT-009: rotation revokes the previous token immediately and atomically. There is
    // never an instant at which two tokens would both verify.
    expect(active).toHaveLength(1)
    expect(all).toHaveLength(3)
  })
})
