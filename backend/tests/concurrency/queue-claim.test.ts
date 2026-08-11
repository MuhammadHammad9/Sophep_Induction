/**
 * The queue claim under concurrency.
 *
 * Critical test cases 2 and 4. This is the most important test in the system: a double
 * assignment sends two applicants to the same room, and no amount of shouting recovers from it
 * once both are sitting down.
 *
 * It only means anything if the claims are genuinely simultaneous, so they are issued on
 * separate connections and awaited together. A sequential loop would pass against a completely
 * broken implementation.
 *
 * Refs: FR-QUE-002, FR-QUE-003, FR-QUE-006, FR-QUE-007, E7, rules.md R-013
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type postgres from 'postgres'
import { testDb, migrate, resetSchema, seedFixture, type Fixture } from '../helpers'

let sql: postgres.Sql<Record<string, never>>
let fx: Fixture
let stageId: string

const PANELS = 20
const APPLICANTS = 40

beforeAll(async () => {
  sql = testDb()
  await resetSchema(sql)
  await migrate(sql)
  fx = await seedFixture(sql)

  const [stage] = await sql<Array<{ id: string }>>`
    INSERT INTO stages (cycle_id, kind, name, starts_at, ends_at)
    VALUES (${fx.cycleId}::uuid, 'interview', 'Day 1', now(), now() + interval '8 hours')
    RETURNING id
  `
  stageId = stage!.id
}, 90_000)

afterAll(async () => {
  await sql?.end()
})

/**
 * A process-wide counter so every generated phone number is unique.
 *
 * norm_phone keeps only the LAST 9 DIGITS, so a naive per-prefix scheme silently collides —
 * two different prefixes of the same length produce the same normalised number and the second
 * registration is rejected as a duplicate. Which is the dedupe working correctly, and a
 * thoroughly confusing way to discover it.
 */
let seq = 0

/**
 * Create `n` applicants queued on the general track.
 *
 * Batched into ONE round trip. The database is in another region, so 40 sequential registrations
 * is 40 × RTT — enough on its own to blow a 30-second test timeout and produce a failure that
 * looks like a queue bug.
 */
async function queueApplicants(n: number, prefix: string): Promise<void> {
  const names: string[] = []
  const emails: string[] = []
  const phones: string[] = []

  for (let i = 0; i < n; i++) {
    const id = ++seq
    names.push(`${prefix} ${i}`)
    emails.push(`${prefix.toLowerCase()}-${id}@example.com`)
    phones.push(`0300${String(id).padStart(7, '0')}`)
  }

  await sql`
    SELECT fn_enqueue(
      (fn_register_applicant(${fx.cycleId}::uuid, d.n, d.e, d.p, 'online')).id,
      ${fx.trackId}::uuid,
      ${stageId}::uuid
    )
    FROM unnest(${names}::text[], ${emails}::text[], ${phones}::text[]) AS d(n, e, p)
  `
}

/** Open a panel serving the general track, staffed by `interviewers`. */
async function openPanel(name: string, interviewers: string[] = []): Promise<string> {
  const [room] = await sql<Array<{ id: string }>>`
    INSERT INTO rooms (cycle_id, code, name)
    VALUES (${fx.cycleId}::uuid, ${name}, ${name})
    ON CONFLICT (cycle_id, code) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `
  const [panel] = await sql<Array<{ id: string }>>`
    INSERT INTO panels (cycle_id, room_id, name, status, opened_at, last_heartbeat)
    VALUES (${fx.cycleId}::uuid, ${room!.id}::uuid, ${name}, 'open', now(), now())
    RETURNING id
  `
  await sql`
    INSERT INTO panel_tracks (panel_id, track_id) VALUES (${panel!.id}::uuid, ${fx.trackId}::uuid)
  `
  for (const i of interviewers) {
    await sql`
      INSERT INTO panel_members (panel_id, interviewer_id) VALUES (${panel!.id}::uuid, ${i}::uuid)
    `
  }
  return panel!.id
}

describe('concurrent Call Next', () => {
  it('gives 20 simultaneous panels 20 DISTINCT applicants', async () => {
    await queueApplicants(APPLICANTS, 'Queued')

    const panels: string[] = []
    for (let i = 0; i < PANELS; i++) {
      panels.push(await openPanel(`P${i}`))
    }

    // The whole point: issued together, on separate connections.
    const claimed = await Promise.all(
      panels.map((panelId) =>
        sql.begin(async (tx) => {
          const rows = await tx<Array<{ id: string; applicant_id: string }>>`
            SELECT id, applicant_id FROM fn_claim_next(${panelId}::uuid)
          `
          return rows[0] ?? null
        }),
      ),
    )

    const got = claimed.filter((c): c is { id: string; applicant_id: string } => c !== null)

    // Every panel got someone — there were 40 waiting for 20 panels.
    expect(got).toHaveLength(PANELS)

    // FR-QUE-002: zero double assignments. This is the assertion that matters.
    expect(new Set(got.map((g) => g.applicant_id)).size).toBe(PANELS)
    expect(new Set(got.map((g) => g.id)).size).toBe(PANELS)
  }, 120_000)

  it('respects priority then enqueue time', async () => {
    // FR-QUE-003. Ordering is priority DESC, then enqueued_at ASC.
    const [late] = await sql<Array<{ id: string }>>`
      SELECT id FROM fn_register_applicant(
        ${fx.cycleId}::uuid, 'Accessibility Need', 'access@example.com', '03009990001', 'online')
    `
    await sql`
      SELECT fn_enqueue(${late!.id}::uuid, ${fx.trackId}::uuid, ${stageId}::uuid,
                        100::smallint, 'wheelchair access, cannot wait in the hall')
    `

    const panel = await openPanel('PriorityTest')
    const [claimed] = await sql<Array<{ applicant_id: string }>>`
      SELECT applicant_id FROM fn_claim_next(${panel}::uuid)
    `

    // Enqueued last, called first — priority 100 beats everyone still waiting at 10.
    expect(claimed!.applicant_id).toBe(late!.id)
  })

  it('returns no row when the queue is genuinely empty', async () => {
    // A distinct condition from an error: QUEUE_EMPTY means "nobody is waiting", and the
    // panel screen must say so rather than showing a failure.
    await sql`UPDATE queue_entries SET state = 'done' WHERE state = 'waiting'`

    const panel = await openPanel('EmptyTest')
    const rows = await sql<Array<{ id: string | null }>>`
      SELECT id FROM fn_claim_next(${panel}::uuid)
    `

    expect(rows[0]?.id ?? null).toBeNull()
  })
})

describe('recusals (E7)', () => {
  /**
   * The E7 regression test.
   *
   * v1 used `NOT IN`, which returns ZERO ROWS if its subquery yields a single NULL. On the
   * floor that presents as "the system just stopped giving us applicants" — a total, silent
   * stall with no error anywhere.
   */
  it('does not stall the queue when the recusals table contains a NULL', async () => {
    await sql`UPDATE queue_entries SET state = 'done' WHERE state <> 'done'`
    await queueApplicants(3, 'Recusal')

    // A recusal row with a NULL reason. Under NOT IN over a nullable column this is the shape
    // that empties the entire result set.
    const [someone] = await sql<Array<{ applicant_id: string }>>`
      SELECT applicant_id FROM queue_entries WHERE state = 'waiting' LIMIT 1
    `
    await sql`
      INSERT INTO recusals (cycle_id, applicant_id, interviewer_id, reason)
      VALUES (${fx.cycleId}::uuid, ${someone!.applicant_id}::uuid,
              ${fx.users['interviewer']!}::uuid, NULL)
    `

    const panel = await openPanel('NullRecusal', [fx.users['interviewer']!])
    const [claimed] = await sql<Array<{ applicant_id: string | null }>>`
      SELECT applicant_id FROM fn_claim_next(${panel}::uuid)
    `

    // The queue still yields someone — just not the recused applicant.
    expect(claimed?.applicant_id).toBeTruthy()
    expect(claimed!.applicant_id).not.toBe(someone!.applicant_id)
  })

  it('excludes an applicant any panel member has recused against', async () => {
    await sql`UPDATE queue_entries SET state = 'done' WHERE state <> 'done'`
    await queueApplicants(1, 'OnlyOne')

    const [only] = await sql<Array<{ applicant_id: string }>>`
      SELECT applicant_id FROM queue_entries WHERE state = 'waiting' LIMIT 1
    `
    await sql`
      INSERT INTO recusals (cycle_id, applicant_id, interviewer_id, reason)
      VALUES (${fx.cycleId}::uuid, ${only!.applicant_id}::uuid,
              ${fx.users['interviewer']!}::uuid, 'my flatmate')
      ON CONFLICT DO NOTHING
    `

    const conflicted = await openPanel('Conflicted', [fx.users['interviewer']!])
    const rows = await sql<Array<{ applicant_id: string | null }>>`
      SELECT applicant_id FROM fn_claim_next(${conflicted}::uuid)
    `
    // The only waiting applicant is invisible to this panel.
    expect(rows[0]?.applicant_id ?? null).toBeNull()

    // ...but another panel, with no recusal, can still take them. The applicant is not
    // stranded — they are just not interviewed by someone who knows them.
    const clean = await openPanel('CleanPanel', [fx.users['coordinator']!])
    const [ok] = await sql<Array<{ applicant_id: string }>>`
      SELECT applicant_id FROM fn_claim_next(${clean}::uuid)
    `
    expect(ok!.applicant_id).toBe(only!.applicant_id)
  })
})

describe('panel gating', () => {
  it('refuses to claim while awaiting evaluations', async () => {
    // FR-INT-013. The block is here, in the database — not a disabled button.
    const panel = await openPanel('Blocked')
    await sql`UPDATE panels SET status = 'awaiting_evaluations' WHERE id = ${panel}::uuid`

    await expect(
      sql`SELECT fn_claim_next(${panel}::uuid)`,
    ).rejects.toThrow(/PANEL_AWAITING_EVALUATIONS/)
  })

  it('refuses to claim while closed', async () => {
    const panel = await openPanel('Closed')
    await sql`UPDATE panels SET status = 'closed' WHERE id = ${panel}::uuid`

    await expect(sql`SELECT fn_claim_next(${panel}::uuid)`).rejects.toThrow(/PANEL_NOT_OPEN/)
  })
})
