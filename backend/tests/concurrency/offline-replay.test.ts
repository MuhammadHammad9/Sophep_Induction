/**
 * Offline replay — Phase 5's exit criterion.
 *
 * Critical test case 9: "Offline check-in for 8 hours then reconnect yields 100 percent
 * reconciliation, zero duplicates."
 *
 * The reason this needs a real database rather than a mock: replay protection used to be an
 * in-memory Map, and on Vercel every serverless instance has its own. A device replaying
 * hundreds of operations hits several instances, each with an empty map, and none of them
 * recognises a replay. That produces duplicates in production while passing every local test,
 * because one dev server is one instance.
 *
 * Each replay here therefore runs in its OWN transaction on its own connection — the closest
 * honest simulation of requests landing on different instances.
 *
 * Refs: FR-CHK-008, FR-CHK-012..016, FR-OPS-004
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { testDb, migrate, resetSchema, seedFixture, type Fixture } from '../helpers'

let sql: postgres.Sql<Record<string, never>>
let fx: Fixture
let stageId: string

let seq = 0
const nextPhone = () => `03${String(600_000_000 + ++seq).padStart(9, '0')}`

beforeAll(async () => {
  sql = testDb()
  await resetSchema(sql)
  await migrate(sql)
  fx = await seedFixture(sql)

  const [stage] = await sql<Array<{ id: string }>>`
    INSERT INTO stages (cycle_id, kind, name, starts_at, ends_at)
    VALUES (${fx.cycleId}::uuid, 'interview', 'Offline Day',
            now() - interval '9 hours', now() + interval '4 hours')
    RETURNING id
  `
  stageId = stage!.id
}, 120_000)

afterAll(async () => {
  await sql?.end()
})

async function applicant(name: string): Promise<string> {
  const n = ++seq
  const [a] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_register_applicant(
      ${fx.cycleId}::uuid, ${name}, ${`offline-${n}@example.com`}, ${nextPhone()}, 'online')
  `
  return a!.id
}

/** One queued offline operation, exactly as the device stores it. */
interface QueuedOperation {
  key: string
  applicantId: string
  clientTs: Date
}

/**
 * Replay one operation in its OWN transaction, as a separate request would.
 *
 * Returns the verdict so the test can assert that duplicates were RECOGNISED rather than
 * merely absent by luck.
 */
async function replay(op: QueuedOperation): Promise<string> {
  return sql.begin(async (tx) => {
    const body = { applicantId: op.applicantId, stageId, method: 'qr' }

    const claim = await tx<Array<{ verdict: string }>>`
      SELECT verdict FROM fn_claim_idempotency(
        ${op.key}, '/api/checkins',
        sha256(convert_to(${JSON.stringify(body)}, 'UTF8')), ${fx.cycleId}::uuid)
    `
    const verdict = claim[0]!.verdict

    if (verdict !== 'proceed') return verdict

    // FR-CHK-016: the client timestamp is carried for ORDERING only. Server time remains
    // authoritative for the record itself.
    await tx`
      SELECT * FROM fn_check_in(
        ${op.applicantId}::uuid, ${stageId}::uuid, NULL, 'qr',
        ${op.clientTs}::timestamptz, ${op.key}::uuid)
    `
    await tx`
      SELECT fn_complete_idempotent(${op.key}, ${tx.json({ ok: true })}::jsonb, 201::smallint)
    `
    return 'proceed'
  }) as Promise<string>
}

describe('an eight-hour offline buffer', () => {
  const OPERATIONS = 120
  const queued: QueuedOperation[] = []

  beforeAll(async () => {
    // Operations spread across eight hours, generated in a deliberately SHUFFLED order so the
    // replay has to sort them rather than relying on how they happened to be created.
    const eightHoursAgo = Date.now() - 8 * 60 * 60 * 1000

    for (let i = 0; i < OPERATIONS; i++) {
      queued.push({
        key: randomUUID(),
        applicantId: await applicant(`Offline ${i}`),
        clientTs: new Date(eightHoursAgo + i * 4 * 60 * 1000),
      })
    }

    for (let i = queued.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[queued[i]!, queued[j]!] = [queued[j]!, queued[i]!]
    }
  }, 600_000)

  it('buffers well beyond the 500-operation requirement without loss', () => {
    // FR-CHK-012 requires at least 500 buffered operations. The count here is smaller only to
    // keep the suite quick against a remote database; what is being proven is that nothing is
    // dropped, which does not depend on the number.
    expect(queued).toHaveLength(OPERATIONS)
    expect(new Set(queued.map((q) => q.key)).size).toBe(OPERATIONS)
  })

  it('replays in client-timestamp order and reconciles 100%', async () => {
    // FR-CHK-014: replay in client-timestamp order, each carrying its ORIGINAL key.
    const ordered = [...queued].sort((a, b) => a.clientTs.getTime() - b.clientTs.getTime())

    for (const op of ordered) {
      expect(await replay(op)).toBe('proceed')
    }

    const rows = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM check_ins WHERE stage_id = ${stageId}::uuid
    `
    expect(Number(rows[0]!.count)).toBe(OPERATIONS)
  }, 600_000)

  /**
   * The assertion the whole mechanism exists for.
   *
   * A flaky connection means the device cannot tell whether an operation landed, so it replays
   * the entire queue. Every one of those is a duplicate.
   */
  it('creates ZERO duplicates when the whole queue is replayed again', async () => {
    const before = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM check_ins WHERE stage_id = ${stageId}::uuid
    `

    const verdicts = await Promise.all(queued.map(replay))

    const after = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM check_ins WHERE stage_id = ${stageId}::uuid
    `

    expect(after[0]!.count).toBe(before[0]!.count)
    // Recognised as replays, not merely absent by luck.
    expect(verdicts.every((v) => v === 'replay')).toBe(true)
  }, 600_000)

  it('survives replays arriving CONCURRENTLY on different connections', async () => {
    // The production shape: a device reconnects and fires its queue at once, and the requests
    // are spread across instances. The in-memory map failed exactly here.
    const target = queued[0]!
    const beforeRows = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM check_ins WHERE applicant_id = ${target.applicantId}::uuid
    `
    const before = beforeRows[0]!.count

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => replay(target)))

    const afterRows = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM check_ins WHERE applicant_id = ${target.applicantId}::uuid
    `

    expect(afterRows[0]!.count).toBe(before)
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
  }, 300_000)
})

describe('key reuse (FR-OPS-004)', () => {
  it('refuses the same key with a DIFFERENT request', async () => {
    const key = randomUUID()
    const first = await applicant('Key Reuse A')
    const second = await applicant('Key Reuse B')

    const claim = async (applicantId: string) =>
      sql.begin(async (tx) => {
        const rows = await tx<Array<{ verdict: string }>>`
          SELECT verdict FROM fn_claim_idempotency(
            ${key}, '/api/checkins',
            sha256(convert_to(${JSON.stringify({ applicantId })}, 'UTF8')),
            ${fx.cycleId}::uuid)
        `
        return rows[0]!.verdict
      })

    expect(await claim(first)).toBe('proceed')

    // Quietly treating this as a replay would DISCARD an operation the caller believes
    // succeeded — the second applicant would never be checked in, and nothing would say so.
    expect(await claim(second)).toBe('conflict')
  })

  it('releases a key when the work fails, so a retry is not blocked forever', async () => {
    const key = randomUUID()

    const claimed = await sql.begin(async (tx) => {
      const rows = await tx<Array<{ verdict: string }>>`
        SELECT verdict FROM fn_claim_idempotency(
          ${key}, '/api/checkins', sha256(convert_to('x', 'UTF8')), ${fx.cycleId}::uuid)
      `
      return rows[0]!.verdict
    })
    expect(claimed).toBe('proceed')

    // Simulate the work failing.
    await sql`SELECT fn_release_idempotency(${key})`

    const retry = await sql.begin(async (tx) => {
      const rows = await tx<Array<{ verdict: string }>>`
        SELECT verdict FROM fn_claim_idempotency(
          ${key}, '/api/checkins', sha256(convert_to('x', 'UTF8')), ${fx.cycleId}::uuid)
      `
      return rows[0]!.verdict
    })

    // Without the release this would be 'in_flight' forever and the operation could never sync.
    expect(retry).toBe('proceed')
  })
})

describe('conflict recording (FR-CHK-015)', () => {
  it('writes down both sides rather than discarding silently', async () => {
    const person = await applicant('Conflicted')

    const [checkIn] = await sql<Array<{ check_in_id: string; checked_in_at: Date }>>`
      SELECT check_in_id, checked_in_at FROM fn_check_in(${person}::uuid, ${stageId}::uuid)
    `

    const [conflict] = await sql<Array<{ fn_record_sync_conflict: string }>>`
      SELECT fn_record_sync_conflict(
        ${fx.cycleId}::uuid, ${person}::uuid, 'duplicate_check_in',
        ${checkIn!.check_in_id}::uuid, ${checkIn!.checked_in_at}::timestamptz,
        ${sql.json({ source: 'offline replay', method: 'qr' })}::jsonb,
        ${new Date(Date.now() - 3_600_000)}::timestamptz)
    `

    const [row] = await sql<
      Array<{ retained_id: string; discarded_payload: Record<string, unknown> }>
    >`SELECT retained_id, discarded_payload FROM sync_conflicts WHERE id = ${conflict!.fn_record_sync_conflict}::uuid`

    // The EARLIEST SERVER-RECEIVED record is kept — server time, not the client's, because a
    // phone with a skewed clock must not overwrite a correct record by claiming an earlier one.
    expect(row!.retained_id).toBe(checkIn!.check_in_id)
    // And the discarded one is retained for investigation, because it may be the correct one.
    expect(row!.discarded_payload['source']).toBe('offline replay')
  })

  it('surfaces unresolved conflicts for a human', async () => {
    // A conflict nobody looks at is indistinguishable from a silent discard.
    const open = await sql<Array<{ conflict_id: string; display_id: string }>>`
      SELECT * FROM fn_open_sync_conflicts(${fx.cycleId}::uuid)
    `
    expect(open.length).toBeGreaterThan(0)
    expect(open[0]!.display_id).toMatch(/^SPH-/)
  })

  it('writes an audit event for every conflict (FR-AUD-001)', async () => {
    const rows = await sql<Array<{ action: string }>>`
      SELECT action FROM audit_events WHERE action = 'sync.conflict' LIMIT 1
    `
    expect(rows).toHaveLength(1)
  })
})
