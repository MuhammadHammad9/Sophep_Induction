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
import { randomUUID } from 'node:crypto'
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
       SET qr_public_key_jwk = ${sql.json({
         kty: 'OKP',
         crv: 'Ed25519',
         x: kp.publicKey.toString('base64url'),
       })}::jsonb,
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

/**
 * Read the roster bundle the way a check-in device does — as a signed-in volunteer.
 *
 * Migration 0038 added `fn_require_capability(cycle, 'checkin.perform')` inside the function,
 * so an unbound privileged call now raises TOKEN_INVALID. That is the point of the guard: the
 * bundle is every applicant's identity, and reaching it must require being somebody.
 */
async function asVolunteer<T>(fn: (tx: postgres.TransactionSql<Record<string, never>>) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE rms_app`
    await tx`SELECT set_config('app.user_id', ${fx.users['volunteer']!}, true)`
    return fn(tx as postgres.TransactionSql<Record<string, never>>)
  }) as Promise<T>
}

describe('offline roster bundle (FR-CHK-018)', () => {
  it('contains token hashes and nothing else', async () => {
    const rows = await asVolunteer((tx) => tx<Array<Record<string, unknown>>>`
      SELECT * FROM fn_roster_bundle(${fx.cycleId}::uuid) LIMIT 1
    `)

    // A device lost at the venue must leak a set of opaque hashes — no names, no states,
    // no scores, and certainly no key material.
    expect(Object.keys(rows[0]!)).toEqual(['token_hash_b64'])
  })

  it('excludes withdrawn applicants', async () => {
    const { id, rawToken } = await makeApplicant('Withdrawn Roster')
    await sql`
      SELECT fn_application_transition(${id}::uuid, 'withdrawn'::applicant_state, 'withdrew')
    `

    const rows = await asVolunteer((tx) => tx<Array<{ token_hash_b64: string }>>`
      SELECT token_hash_b64 FROM fn_roster_bundle(${fx.cycleId}::uuid)
    `)
    const hashes = new Set(
      rows.map((r) => Buffer.from(r.token_hash_b64, 'base64').toString('base64url')),
    )

    expect(hashes.has(tokenHashB64(rawToken))).toBe(false)
  })

  it('lets a device verify a real token offline, and reject a forged one', async () => {
    const { rawToken } = await makeApplicant('Offline Verified')

    const rows = await asVolunteer((tx) => tx<Array<{ token_hash_b64: string }>>`
      SELECT token_hash_b64 FROM fn_roster_bundle(${fx.cycleId}::uuid)
    `)
    const roster = new Set(
      rows.map((r) => Buffer.from(r.token_hash_b64, 'base64').toString('base64url')),
    )

    const [cycle] = await sql<Array<{ qr_public_key_jwk: { x: string } }>>`
      SELECT qr_public_key_jwk FROM cycles WHERE id = ${fx.cycleId}::uuid
    `
    // Stored as a JWK, verified as raw 32 bytes — the single conversion point lives in
    // services/checkin.ts (jwkToRawPublicKey).
    const rawPublic = Buffer.from(cycle!.qr_public_key_jwk.x, 'base64url')

    // Real token, no network, no secret on the device.
    expect(verifyOffline(rawToken, roster, rawPublic).valid).toBe(true)

    // Someone who holds the roster and the public key still cannot mint a working code.
    // That is the entire correction to E1.
    const forged = generateToken()
    const forgedSig = signToken(forged.raw, generateCycleKeypair(encKey).privateKeyEncrypted, encKey)
    expect(
      verifyOffline(`${forged.raw}.${forgedSig}`, roster, rawPublic).valid,
    ).toBe(false)
  })
})

/**
 * The bundle a device actually caches (spec.json offline.roster_bundle).
 *
 * ⚠ The two specs disagree here and the disagreement is recorded rather than resolved silently:
 * TRD FR-CHK-018 says "token hashes and the cycle public key only", while spec.json lists
 * identity and preferences too. The JSON wins on precedence, and it is the only self-consistent
 * reading — the same object requires manual search to work against the cached roster, which a
 * set of opaque hashes cannot support.
 *
 * What these tests pin down is the half both documents agree on, which is also the half that
 * matters if a device is left on a chair.
 */
describe('offline roster bundle v2 (spec.json offline.roster_bundle)', () => {
  it('carries identity and preferences, and NOTHING evaluative', async () => {
    await makeApplicant('Bundle Shape')

    const rows = await asVolunteer((tx) => tx<Array<Record<string, unknown>>>`
      SELECT * FROM fn_roster_bundle_v2(${fx.cycleId}::uuid) LIMIT 1
    `)

    // Asserted as an exact set, not a subset. A subset assertion would still pass on the day
    // somebody adds `final_score` to the query, which is the failure this test exists for.
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        'applicant_id',
        'display_id',
        'full_name',
        'phone_last4',
        'preferences',
        'token_hash_b64',
      ].sort(),
    )
  })

  it('emits base64URL hashes, matching what a device computes from a scan', async () => {
    const { rawToken } = await makeApplicant('Bundle Alphabet')

    const rows = await asVolunteer((tx) => tx<Array<{ token_hash_b64: string }>>`
      SELECT token_hash_b64 FROM fn_roster_bundle_v2(${fx.cycleId}::uuid)
    `)
    const hashes = new Set(rows.map((r) => r.token_hash_b64))

    // Plain base64 differs from base64url in exactly two characters, so a mismatch here would
    // fail roughly one lookup in eight — silently, offline, at the desk.
    expect(hashes.has(tokenHashB64(rawToken))).toBe(true)
    expect(rows.every((r) => !/[+/=]/.test(r.token_hash_b64))).toBe(true)
  })

  it('carries the final FOUR phone digits and not the number', async () => {
    // FR-CHK-009 asks for the final four, so the final four is the whole budget. A lost device
    // must not hand over a reachable contact detail for every applicant in the cycle (RSK-006).
    const rows = await asVolunteer((tx) => tx<Array<{ phone_last4: string }>>`
      SELECT phone_last4 FROM fn_roster_bundle_v2(${fx.cycleId}::uuid)
    `)

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => /^\d{4}$/.test(r.phone_last4))).toBe(true)
  })

  it('matches the digits the ONLINE search compares against', async () => {
    // Both paths must agree on which digits count. If they disagree, a volunteer who searched
    // successfully while online gets nothing for the same query offline — and has no way to
    // tell that from the applicant not existing.
    const { id } = await makeApplicant('Phone Parity')

    const [expected] = await sql<Array<{ last4: string }>>`
      SELECT right(phone_norm, 4) AS last4 FROM applicants WHERE id = ${id}::uuid
    `
    const rows = await asVolunteer((tx) => tx<Array<{ applicant_id: string; phone_last4: string }>>`
      SELECT applicant_id, phone_last4 FROM fn_roster_bundle_v2(${fx.cycleId}::uuid)
    `)

    const mine = rows.find((r) => r.applicant_id === id)
    expect(mine!.phone_last4).toBe(expected!.last4)
  })

  it('refuses a caller with no bound identity', async () => {
    // Fail-closed (R-014): the bundle is the whole cohort's names.
    await expect(
      sql`SELECT * FROM fn_roster_bundle_v2(${fx.cycleId}::uuid)`,
    ).rejects.toThrow(/TOKEN_INVALID/)
  })
})

describe('bulk reconcile authority (FR-CHK-017)', () => {
  async function reconcileAs(role: string, applicantIds: string[]) {
    return sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE rms_app`
      await tx`SELECT set_config('app.user_id', ${fx.users[role]!}, true)`
      return tx<Array<{ outcome: string }>>`
        SELECT outcome FROM fn_bulk_reconcile(${stageId}::uuid, ${applicantIds}::uuid[])
      `
    })
  }

  it('refuses a volunteer', async () => {
    const { id } = await makeApplicant('Reconcile Denied')

    // spec.json puts this endpoint at "coordinator+". Every other check-in path has an
    // applicant standing in front of somebody; this one takes a typed list, so a mistake — or
    // a bored volunteer — is invisible until the queue fills with people who are not present.
    await expect(reconcileAs('volunteer', [id])).rejects.toThrow(/DUAL_CONTROL_REQUIRED/)
  })

  it('allows a coordinator, and reports one row per input including failures', async () => {
    const { id } = await makeApplicant('Reconcile Allowed')

    const rows = await reconcileAs('coordinator', [id, randomUUID()])

    // Two in, two out. A bulk operation that returned only its successes would leave the
    // Coordinator diffing two lists by hand to find who is missing.
    expect(rows).toHaveLength(2)
    expect(rows[0]!.outcome).toBe('checked_in')
    expect(rows[1]!.outcome).toMatch(/^error/)
  })
})
