/**
 * Check-in.
 *
 * Critical test case 3: the same QR scanned on two devices at once must produce ONE check_in
 * row. Two volunteers working the same queue will scan the same person — it is not an edge
 * case, it is Tuesday.
 *
 * Refs: FR-CHK-006..011, FR-CHK-018, FR-IDT-011
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type postgres from 'postgres'
import { testDb, migrate, resetSchema, seedFixture, type Fixture } from '../helpers'
import { generateToken, hashToken } from '../../src/domain/identity'
import { generateCycleKeypair, signToken } from '../../src/domain/crypto'
import { verifyOffline, tokenHashB64 } from '../../src/domain/verification'
import { randomBytes } from 'node:crypto'

let sql: postgres.Sql<Record<string, never>>
let fx: Fixture
let stageId: string

const encKey = randomBytes(32)

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

  const kp = generateCycleKeypair(encKey)
  await sql`
    UPDATE cycles
       SET qr_public_key = ${kp.publicKey}::bytea,
           qr_private_key_enc = ${kp.privateKeyEncrypted}::bytea
     WHERE id = ${fx.cycleId}::uuid
  `
}, 300_000)

afterAll(async () => {
  await sql?.end()
})

let seq = 0

async function makeApplicant(name: string): Promise<{ id: string; rawToken: string }> {
  const n = ++seq
  const [a] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_register_applicant(
      ${fx.cycleId}::uuid, ${name},
      ${`checkin-${n}@example.com`},
      ${`0311${String(n).padStart(7, '0')}`},
      'online')
  `
  const token = generateToken()
  await sql`
    SELECT fn_issue_token(${a!.id}::uuid, ${token.hash}::bytea,
                          ${new Date(Date.now() + 86_400_000)}::timestamptz, 'test')
  `
  return { id: a!.id, rawToken: token.raw }
}

describe('check-in', () => {
  it('checks an applicant in and enqueues them in one transaction', async () => {
    const { id } = await makeApplicant('First Arrival')

    const [result] = await sql<
      Array<{ outcome: string; queue_position: number; queue_entry_id: string; display_id: string }>
    >`SELECT * FROM fn_check_in(${id}::uuid, ${stageId}::uuid)`

    expect(result!.outcome).toBe('checked_in')
    expect(result!.queue_entry_id).toBeTruthy()
    expect(Number(result!.queue_position)).toBeGreaterThanOrEqual(1)

    // The projection followed in the same transaction (E5).
    const [applicant] = await sql<Array<{ state: string }>>`
      SELECT state FROM applicants WHERE id = ${id}::uuid
    `
    expect(applicant!.state).toBe('queued')
  })

  /**
   * Critical test case 3. Two devices, same QR, same instant.
   */
  it('produces ONE check_in row when two devices scan simultaneously', async () => {
    const { id } = await makeApplicant('Double Scanned')

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        sql.begin(async (tx) => {
          const rows = await tx<Array<{ outcome: string; check_in_id: string }>>`
            SELECT outcome, check_in_id FROM fn_check_in(${id}::uuid, ${stageId}::uuid)
          `
          return rows[0]!
        }),
      ),
    )

    const rows = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM check_ins
       WHERE applicant_id = ${id}::uuid AND stage_id = ${stageId}::uuid
    `
    expect(rows[0]!.count).toBe('1')

    // Every caller sees the same check-in, and exactly one queue entry exists.
    expect(new Set(results.map((r) => r.check_in_id)).size).toBe(1)

    const entryRows = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM queue_entries WHERE applicant_id = ${id}::uuid
    `
    expect(entryRows[0]!.count).toBe('1')
  })

  /**
   * FR-CHK-006 / NFR-USE-004 / rules.md R-027. The repeat scan is the most common non-happy
   * path and it is NOT an error — the response carries the original time so the UI can show
   * amber with "Checked in at 10:14", never red.
   */
  it('reports a repeat scan as "already", with the original time', async () => {
    const { id } = await makeApplicant('Repeat Scanner')

    const [first] = await sql<Array<{ outcome: string; checked_in_at: Date }>>`
      SELECT outcome, checked_in_at FROM fn_check_in(${id}::uuid, ${stageId}::uuid)
    `
    const [second] = await sql<Array<{ outcome: string; checked_in_at: Date }>>`
      SELECT outcome, checked_in_at FROM fn_check_in(${id}::uuid, ${stageId}::uuid)
    `

    expect(first!.outcome).toBe('checked_in')
    expect(second!.outcome).toBe('already')
    expect(second!.checked_in_at.getTime()).toBe(first!.checked_in_at.getTime())
  })

  it('refuses a withdrawn applicant', async () => {
    const { id } = await makeApplicant('Gone Home')
    await sql`
      SELECT fn_application_transition(${id}::uuid, 'withdrawn'::applicant_state, 'left the venue')
    `

    await expect(
      sql`SELECT * FROM fn_check_in(${id}::uuid, ${stageId}::uuid)`,
    ).rejects.toThrow(/NOT_ELIGIBLE/)
  })

  it('refuses a closed stage', async () => {
    const { id } = await makeApplicant('Too Late')
    const [closed] = await sql<Array<{ id: string }>>`
      INSERT INTO stages (cycle_id, kind, name, starts_at, ends_at, closed_at)
      VALUES (${fx.cycleId}::uuid, 'interview', 'Closed Day', now() - interval '1 day',
              now() - interval '2 hours', now() - interval '1 hour')
      RETURNING id
    `

    await expect(
      sql`SELECT * FROM fn_check_in(${id}::uuid, ${closed!.id}::uuid)`,
    ).rejects.toThrow(/STAGE_CLOSED/)
  })

  /**
   * FR-CHK-011. Checking in must SUCCEED even with no panel — the applicant is in the
   * building and the system must record that. What it must not do is invent a wait estimate
   * from zero panels.
   */
  it('completes check-in with no open panel but suppresses the ETA', async () => {
    const { id } = await makeApplicant('No Panel Yet')

    const [result] = await sql<Array<{ outcome: string; eta_suppressed: boolean }>>`
      SELECT outcome, eta_suppressed FROM fn_check_in(${id}::uuid, ${stageId}::uuid)
    `

    expect(result!.outcome).toBe('checked_in')
    expect(result!.eta_suppressed).toBe(true)
  })
})

describe('token resolution at the desk', () => {
  it('resolves a valid token', async () => {
    const { id, rawToken } = await makeApplicant('Scannable')

    const [row] = await sql<Array<{ applicant_id: string; revoked: boolean; expired: boolean }>>`
      SELECT * FROM fn_resolve_token_for_checkin(${hashToken(rawToken)}::bytea)
    `

    expect(row!.applicant_id).toBe(id)
    expect(row!.revoked).toBe(false)
    expect(row!.expired).toBe(false)
  })

  it('reports revocation rather than hiding it', async () => {
    // The desk needs to distinguish "not ours" from "rotated" — the second means the
    // applicant has a newer QR on their phone and should just refresh the page.
    const { id, rawToken } = await makeApplicant('Rotated')
    const replacement = generateToken()
    await sql`
      SELECT fn_issue_token(${id}::uuid, ${replacement.hash}::bytea,
                            ${new Date(Date.now() + 86_400_000)}::timestamptz, 'rotation')
    `

    const [row] = await sql<Array<{ revoked: boolean }>>`
      SELECT * FROM fn_resolve_token_for_checkin(${hashToken(rawToken)}::bytea)
    `
    expect(row!.revoked).toBe(true)
  })
})

describe('offline roster bundle (FR-CHK-018)', () => {
  it('contains token hashes and nothing else', async () => {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM fn_roster_bundle(${fx.cycleId}::uuid) LIMIT 1
    `

    // A device lost at the venue must leak a set of opaque hashes — no names, no states,
    // no scores, and certainly no key material.
    expect(Object.keys(rows[0]!)).toEqual(['token_hash_b64'])
  })

  it('excludes withdrawn applicants', async () => {
    const { id, rawToken } = await makeApplicant('Withdrawn Roster')
    await sql`
      SELECT fn_application_transition(${id}::uuid, 'withdrawn'::applicant_state, 'withdrew')
    `

    const rows = await sql<Array<{ token_hash_b64: string }>>`
      SELECT token_hash_b64 FROM fn_roster_bundle(${fx.cycleId}::uuid)
    `
    const hashes = new Set(
      rows.map((r) => Buffer.from(r.token_hash_b64, 'base64').toString('base64url')),
    )

    expect(hashes.has(tokenHashB64(rawToken))).toBe(false)
  })

  it('lets a device verify a real token offline, and reject a forged one', async () => {
    const { rawToken } = await makeApplicant('Offline Verified')

    const rows = await sql<Array<{ token_hash_b64: string }>>`
      SELECT token_hash_b64 FROM fn_roster_bundle(${fx.cycleId}::uuid)
    `
    const roster = new Set(
      rows.map((r) => Buffer.from(r.token_hash_b64, 'base64').toString('base64url')),
    )

    const [cycle] = await sql<Array<{ qr_public_key: Buffer }>>`
      SELECT qr_public_key FROM cycles WHERE id = ${fx.cycleId}::uuid
    `

    // Real token, no network, no secret on the device.
    expect(verifyOffline(rawToken, roster, Buffer.from(cycle!.qr_public_key)).valid).toBe(true)

    // Someone who holds the roster and the public key still cannot mint a working code.
    // That is the entire correction to E1.
    const forged = generateToken()
    const forgedSig = signToken(forged.raw, generateCycleKeypair(encKey).privateKeyEncrypted, encKey)
    expect(
      verifyOffline(`${forged.raw}.${forgedSig}`, roster, Buffer.from(cycle!.qr_public_key)).valid,
    ).toBe(false)
  })
})
