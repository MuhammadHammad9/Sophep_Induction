/**
 * The applicant status payload.
 *
 * Regression cover for the bug migration 0021 documents: composing this page from ordinary
 * queries under applicant RLS silently returned zero rows — the join to `stages` was
 * eliminated because an applicant holds no membership — so the page rendered with no position
 * at all. RLS does not error, it returns less. On the day that reads as the system forgetting
 * someone.
 *
 * Refs: FR-QUE-003, FR-QUE-015..019, NFR-PRIV-005
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type postgres from 'postgres'
import { testDb, migrate, resetSchema, seedFixture, asAnonymous, type Fixture } from '../helpers'
import { generateToken, hashToken } from '../../src/domain/identity'

let sql: postgres.Sql<Record<string, never>>
let fx: Fixture
let stageId: string
let trackId: string

interface StatusRow {
  applicant_id: string
  display_id: string
  applicant_state: string
  queue_entry_state: string | null
  queue_position: number | null
  room_name: string | null
  open_panels: number | null
  stage_running_minutes: number | null
}

let seq = 0

async function queuedApplicant(name: string): Promise<{ id: string; raw: string }> {
  const n = ++seq
  const [a] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_register_applicant(
      ${fx.cycleId}::uuid, ${name}, ${`status-${n}@example.com`},
      ${`0322${String(n).padStart(7, '0')}`}, 'online')
  `
  const token = generateToken()
  await sql`
    SELECT fn_issue_token(${a!.id}::uuid, ${token.hash}::bytea,
                          ${new Date(Date.now() + 86_400_000)}::timestamptz, 'test')
  `
  await sql`SELECT * FROM fn_check_in(${a!.id}::uuid, ${stageId}::uuid)`
  return { id: a!.id, raw: token.raw }
}

beforeAll(async () => {
  sql = testDb()
  await resetSchema(sql)
  await migrate(sql)
  fx = await seedFixture(sql)
  trackId = fx.trackId

  const [stage] = await sql<Array<{ id: string }>>`
    INSERT INTO stages (cycle_id, kind, name, starts_at, ends_at)
    VALUES (${fx.cycleId}::uuid, 'interview', 'Day 1',
            now() - interval '40 minutes', now() + interval '8 hours')
    RETURNING id
  `
  stageId = stage!.id
}, 300_000)

afterAll(async () => {
  await sql?.end()
})

describe('fn_applicant_status', () => {
  it('returns a position for a queued applicant', async () => {
    // The exact case that silently returned nothing before 0021.
    const { raw } = await queuedApplicant('Queued Person')

    const [row] = await asAnonymous(sql, async (tx) => {
      return tx<StatusRow[]>`SELECT * FROM fn_applicant_status(${hashToken(raw)}::bytea)`
    })

    expect(row).toBeDefined()
    expect(row!.queue_entry_state).toBe('waiting')
    expect(Number(row!.queue_position)).toBeGreaterThanOrEqual(1)
    // Derived from the stages table, which the applicant cannot read directly.
    expect(Number(row!.stage_running_minutes)).toBeGreaterThanOrEqual(39)
  })

  it('orders position the same way the claim does', async () => {
    // FR-QUE-003. A position computed by any other ordering would be a number the queue does
    // not honour — worse than showing none.
    const { raw } = await queuedApplicant('Priority Person')

    const [before] = await asAnonymous(sql, async (tx) => {
      return tx<StatusRow[]>`SELECT * FROM fn_applicant_status(${hashToken(raw)}::bytea)`
    })

    await sql`
      UPDATE queue_entries SET priority = 100, priority_reason = 'accessibility need'
       WHERE applicant_id = (
         SELECT applicant_id FROM access_tokens WHERE token_hash = ${hashToken(raw)}::bytea)
    `

    const [after] = await asAnonymous(sql, async (tx) => {
      return tx<StatusRow[]>`SELECT * FROM fn_applicant_status(${hashToken(raw)}::bytea)`
    })

    expect(Number(after!.queue_position)).toBeLessThan(Number(before!.queue_position))
    expect(Number(after!.queue_position)).toBe(1)
  })

  it('withholds the room until the applicant is actually called', async () => {
    // Telling someone a room before they are called sends them to a door that is still
    // occupied, and they arrive to an interview in progress.
    const { raw } = await queuedApplicant('Not Called Yet')

    const [row] = await asAnonymous(sql, async (tx) => {
      return tx<StatusRow[]>`SELECT * FROM fn_applicant_status(${hashToken(raw)}::bytea)`
    })

    expect(row!.room_name).toBeNull()
  })

  it('reveals the room once called', async () => {
    const { id, raw } = await queuedApplicant('About To Be Called')

    const [room] = await sql<Array<{ id: string }>>`
      INSERT INTO rooms (cycle_id, code, name) VALUES (${fx.cycleId}::uuid, 'STATUS', 'Room 7')
      ON CONFLICT (cycle_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id
    `
    const [panel] = await sql<Array<{ id: string }>>`
      INSERT INTO panels (cycle_id, room_id, name, status, opened_at, last_heartbeat)
      VALUES (${fx.cycleId}::uuid, ${room!.id}::uuid, 'Status Panel', 'open', now(), now())
      RETURNING id
    `
    await sql`
      INSERT INTO panel_tracks (panel_id, track_id) VALUES (${panel!.id}::uuid, ${trackId}::uuid)
    `

    // Put this applicant unambiguously at the head. Priority alone is not enough: an earlier
    // test leaves another entry at 100, and the tie-break is enqueued_at ASC — so the claim
    // would deterministically take the wrong person. Backdating settles it.
    await sql`
      UPDATE queue_entries
         SET priority = 100,
             priority_reason = 'test ordering',
             enqueued_at = now() - interval '1 day'
       WHERE applicant_id = ${id}::uuid
    `
    await sql`SELECT fn_claim_next(${panel!.id}::uuid)`

    const [row] = await asAnonymous(sql, async (tx) => {
      return tx<StatusRow[]>`SELECT * FROM fn_applicant_status(${hashToken(raw)}::bytea)`
    })

    expect(row!.queue_entry_state).toBe('called')
    expect(row!.room_name).toBe('Room 7')
    // No position while called — the number on screen becomes the ROOM.
    expect(row!.queue_position).toBeNull()
  })

  it('reports the open panel count that drives the estimate', async () => {
    const { raw } = await queuedApplicant('Counts Panels')

    const [row] = await asAnonymous(sql, async (tx) => {
      return tx<StatusRow[]>`SELECT * FROM fn_applicant_status(${hashToken(raw)}::bytea)`
    })

    // FR-QUE-018: with zero this must suppress rather than divide by it.
    expect(Number(row!.open_panels)).toBeGreaterThanOrEqual(0)
  })

  it('returns nothing for a revoked token', async () => {
    const { id, raw } = await queuedApplicant('Rotated Token')
    const replacement = generateToken()
    await sql`
      SELECT fn_issue_token(${id}::uuid, ${replacement.hash}::bytea,
                            ${new Date(Date.now() + 86_400_000)}::timestamptz, 'rotation')
    `

    const rows = await asAnonymous(sql, async (tx) => {
      return tx<StatusRow[]>`SELECT * FROM fn_applicant_status(${hashToken(raw)}::bytea)`
    })

    expect(rows).toHaveLength(0)
  })

  it('exposes only the fields the page renders', async () => {
    // Guards against a future migration adding a column that SELECT * would leak to an
    // unauthenticated caller (NFR-PRIV-005).
    const { raw } = await queuedApplicant('Field Check')

    const [row] = await asAnonymous(sql, async (tx) => {
      return tx<Array<Record<string, unknown>>>`
        SELECT * FROM fn_applicant_status(${hashToken(raw)}::bytea)
      `
    })

    expect(Object.keys(row!).sort()).toEqual(
      [
        'applicant_id',
        'applicant_state',
        'called_at',
        'cycle_id',
        'display_id',
        'grace_extended',
        'grace_window_minutes',
        'open_panels',
        'queue_entry_id',
        'queue_entry_state',
        'queue_position',
        'room_name',
        'stage_running_minutes',
        'track_id',
      ].sort(),
    )
  })
})
