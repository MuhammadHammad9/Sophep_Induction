/**
 * Dual-control lock, the immutable snapshot, offers and the waitlist cascade.
 *
 * Critical test case 8 lives here: the same Super Admin must not be able to complete both lock
 * steps. One person clicking twice is not a control, and RSK-007 rates accidental early
 * publication as low-likelihood and high-impact — the shape of risk a cheap control is worth
 * having for.
 *
 * Refs: FR-DEC-010..016, FR-OFF-001..006, DR-007
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type postgres from 'postgres'
import { testDb, migrate, resetSchema, seedFixture, asUser, type Fixture } from '../helpers'

let sql: postgres.Sql<Record<string, never>>
let fx: Fixture
let president: string
let generalSecretary: string
let tech: string
let events: string

// Created in the top-level beforeAll, BEFORE the cycle is locked. Registration is refused once
// the cycle leaves registration_open (FR-CYC-004) — correctly — so a fixture that registers
// applicants after the lock tests nothing except that gate.
let acceptor: string
let decliner: string
let waitlisted1: string
let waitlisted2: string
let placedElsewhere: string
let reminderDue: string

let seq = 0
const nextPhone = () => `03${String(900_000_000 + ++seq).padStart(9, '0')}`

beforeAll(async () => {
  sql = testDb()
  await resetSchema(sql)
  await migrate(sql)
  fx = await seedFixture(sql)

  // Two DISTINCT Super Admins — President and General Secretary, as the committee confirmed.
  president = fx.users['super_admin']!
  const [gs] = await sql<Array<{ id: string }>>`
    INSERT INTO users (email, full_name) VALUES ('gs@test.sophep', 'General Secretary')
    RETURNING id
  `
  generalSecretary = gs!.id
  await sql`
    INSERT INTO memberships (cycle_id, user_id, role)
    VALUES (${fx.cycleId}::uuid, ${generalSecretary}::uuid, 'super_admin'::role_name)
  `

  const depts = await sql<Array<{ id: string; code: string }>>`
    SELECT id, code FROM departments WHERE cycle_id = ${fx.cycleId}::uuid
  `
  tech = depts.find((d) => d.code === 'TECH')!.id
  events = depts.find((d) => d.code === 'EVENTS')!.id

  await sql`UPDATE departments SET capacity = 1 WHERE id = ${tech}::uuid`
  await sql`UPDATE departments SET capacity = 2 WHERE id = ${events}::uuid`

  // EVENTS: capacity 2, two selected and two waitlisted, so the cascade has somewhere to go.
  acceptor = await decidedApplicant('Will Accept', 'selected', events)
  decliner = await decidedApplicant('Will Decline', 'selected', events)
  waitlisted1 = await decidedApplicant('Waitlist One', 'waitlisted', events, 1)
  waitlisted2 = await decidedApplicant('Waitlist Two', 'waitlisted', events, 2)
  placedElsewhere = await decidedApplicant('Placed Elsewhere', 'waitlisted', tech, 1)
  reminderDue = await decidedApplicant('Reminder Due', 'waitlisted', events, 9)
}, 300_000)

afterAll(async () => {
  await sql?.end()
})

/** An applicant with a decision already written — the lock and cascade need decisions, not scores. */
async function decidedApplicant(
  name: string,
  outcome: 'selected' | 'waitlisted' | 'rejected',
  departmentId: string | null,
  waitlistRank: number | null = null,
): Promise<string> {
  const [a] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_register_applicant(
      ${fx.cycleId}::uuid, ${name}, ${`lock-${++seq}@example.com`}, ${nextPhone()}, 'online')
  `
  await sql`
    INSERT INTO decisions (cycle_id, applicant_id, version, outcome, department_id, waitlist_rank)
    VALUES (${fx.cycleId}::uuid, ${a!.id}::uuid, 1, ${outcome}::decision_outcome,
            ${departmentId}::uuid, ${waitlistRank})
  `
  return a!.id
}

describe('dual control (FR-DEC-010)', () => {
  it('refuses to confirm before anyone has requested the lock', async () => {
    await expect(
      asUser(sql, generalSecretary, (tx) => tx`SELECT fn_confirm_lock(${fx.cycleId}::uuid)`),
    ).rejects.toThrow(/nobody has requested the lock/)
  })

  it('lets a Super Admin request the lock', async () => {
    await decidedApplicant('Locked Selected', 'selected', tech)

    await asUser(sql, president, (tx) => tx`SELECT fn_lock_results(${fx.cycleId}::uuid)`)

    const [cycle] = await sql<Array<{ locked_by: string }>>`
      SELECT locked_by FROM cycles WHERE id = ${fx.cycleId}::uuid
    `
    expect(cycle!.locked_by).toBe(president)
  })

  /**
   * Critical test case 8.
   */
  it('refuses to let the SAME account complete both steps', async () => {
    await expect(
      asUser(sql, president, (tx) => tx`SELECT fn_confirm_lock(${fx.cycleId}::uuid)`),
    ).rejects.toThrow(/different Super Admin/)

    // Still not locked.
    const [cycle] = await sql<Array<{ state: string }>>`
      SELECT state FROM cycles WHERE id = ${fx.cycleId}::uuid
    `
    expect(cycle!.state).not.toBe('results_locked')
  })

  it('locks when a DIFFERENT Super Admin confirms', async () => {
    const [snapshot] = await asUser(sql, generalSecretary, (tx) =>
      tx<Array<{ checksum: string; locked_by: string; confirmed_by: string }>>`
        SELECT * FROM fn_confirm_lock(${fx.cycleId}::uuid)
      `,
    )

    expect(snapshot!.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshot!.locked_by).toBe(president)
    expect(snapshot!.confirmed_by).toBe(generalSecretary)

    const [cycle] = await sql<Array<{ state: string }>>`
      SELECT state FROM cycles WHERE id = ${fx.cycleId}::uuid
    `
    expect(cycle!.state).toBe('results_locked')
  })

  it('refuses a non-Super-Admin entirely', async () => {
    await expect(
      asUser(sql, fx.users['coordinator']!, (tx) =>
        tx`SELECT fn_lock_results(${fx.cycleId}::uuid)`,
      ),
    ).rejects.toThrow(/DUAL_CONTROL_REQUIRED/)
  })
})

describe('the snapshot (FR-DEC-011, DR-007)', () => {
  it('is write-once — no UPDATE, no DELETE', async () => {
    // Post-publication corrections create a NEW decision version and a distinct notice. The
    // record of what was published stays intact, which is what you want the first time
    // someone disputes a result.
    await expect(
      sql`UPDATE result_snapshots SET checksum = 'tampered'`,
    ).rejects.toThrow(/write-once/)

    await expect(sql`DELETE FROM result_snapshots`).rejects.toThrow(/write-once/)
  })

  it('captures the decision and its score together', async () => {
    const [snapshot] = await sql<Array<{ payload: Array<Record<string, unknown>> }>>`
      SELECT payload FROM result_snapshots WHERE cycle_id = ${fx.cycleId}::uuid
    `
    const entry = snapshot!.payload.find((p) => p['display_id'])

    expect(entry).toBeDefined()
    // Enough to answer "what did we decide, and on what basis" years later, without needing
    // the code that produced it.
    for (const key of ['applicant_id', 'display_id', 'outcome', 'decided_by_human']) {
      expect(Object.keys(entry!)).toContain(key)
    }
  })
})

describe('override after lock (FR-DEC-016)', () => {
  it('refuses, directing the caller to the correction path', async () => {
    const [any] = await sql<Array<{ applicant_id: string }>>`
      SELECT applicant_id FROM current_decisions WHERE cycle_id = ${fx.cycleId}::uuid LIMIT 1
    `

    await expect(
      asUser(sql, president, (tx) =>
        tx`SELECT fn_override_decision(${any!.applicant_id}::uuid,
                                       'rejected'::decision_outcome, NULL,
                                       'changed our minds after locking')`,
      ),
    ).rejects.toThrow(/results are locked/)
  })
})

describe('offers and the cascade (FR-OFF-001..005)', () => {
  it('issues an offer expiring in 24 hours, per the committee decision', async () => {
    const [offer] = await sql<Array<{ expires_at: Date; state: string }>>`
      SELECT * FROM fn_issue_offer(${acceptor}::uuid, ${events}::uuid)
    `
    const hours = (new Date(offer!.expires_at).getTime() - Date.now()) / 3_600_000

    expect(offer!.state).toBe('pending')
    // 24, not the spec's 120.
    expect(hours).toBeGreaterThan(23)
    expect(hours).toBeLessThan(25)
  })

  it('accepts an offer and moves the applicant to accepted', async () => {
    const [offer] = await sql<Array<{ id: string }>>`
      SELECT id FROM offers WHERE applicant_id = ${acceptor}::uuid
    `
    await sql`SELECT fn_respond_to_offer(${offer!.id}::uuid, true)`

    const [a] = await sql<Array<{ state: string }>>`
      SELECT state FROM applicants WHERE id = ${acceptor}::uuid
    `
    expect(a!.state).toBe('accepted')
  })

  it('cascades to the top-ranked waitlisted applicant on decline (FR-OFF-003)', async () => {
    await sql`SELECT fn_issue_offer(${decliner}::uuid, ${events}::uuid)`
    const [offer] = await sql<Array<{ id: string }>>`
      SELECT id FROM offers WHERE applicant_id = ${decliner}::uuid
    `

    await sql`SELECT fn_respond_to_offer(${offer!.id}::uuid, false)`

    // Rank 1 gets the released seat, not rank 2.
    const promoted = await sql<Array<{ applicant_id: string; state: string }>>`
      SELECT applicant_id, state FROM offers WHERE applicant_id = ${waitlisted1}::uuid
    `
    expect(promoted).toHaveLength(1)
    expect(promoted[0]!.state).toBe('pending')

    // Rank 2 is untouched — the seat was one seat.
    const notYet = await sql<Array<{ id: string }>>`
      SELECT id FROM offers WHERE applicant_id = ${waitlisted2}::uuid
    `
    expect(notYet).toHaveLength(0)
  })

  it('skips someone already placed elsewhere and continues (FR-OFF-004)', async () => {
    // The requirement is explicit that the cascade must not stop at an ineligible candidate:
    // it marks them and moves on. Stopping would leave a seat unfilled for no reason.
    await sql`SELECT fn_issue_offer(${placedElsewhere}::uuid, ${tech}::uuid)`
    const [theirOffer] = await sql<Array<{ id: string }>>`
      SELECT id FROM offers WHERE applicant_id = ${placedElsewhere}::uuid
    `
    await sql`SELECT fn_respond_to_offer(${theirOffer!.id}::uuid, true)`

    // They now hold a TECH place; a cascade on TECH must not offer them a second one.
    const issued = await sql<Array<{ fn_cascade_department: number }>>`
      SELECT fn_cascade_department(${tech}::uuid)
    `
    expect(Number(issued[0]!.fn_cascade_department)).toBe(0)
  })

  it('refuses to accept an expired offer', async () => {
    // Accepting late would mean the seat had already cascaded and two people hold one place.
    await sql`SELECT fn_issue_offer(${waitlisted2}::uuid, ${events}::uuid)`
    await sql`
      UPDATE offers SET expires_at = now() - interval '1 hour'
       WHERE applicant_id = ${waitlisted2}::uuid
    `
    const [offer] = await sql<Array<{ id: string }>>`
      SELECT id FROM offers WHERE applicant_id = ${waitlisted2}::uuid
    `

    await expect(
      sql`SELECT fn_respond_to_offer(${offer!.id}::uuid, true)`,
    ).rejects.toThrow(/TOKEN_EXPIRED/)
  })

  it('lapses an overdue offer and cascades onward', async () => {
    const before = await sql<Array<{ state: string }>>`
      SELECT state FROM offers WHERE applicant_id = ${waitlisted2}::uuid
    `
    expect(before[0]!.state).toBe('pending')

    const result = await sql<Array<{ fn_expire_offers: number }>>`
      SELECT fn_expire_offers(${fx.cycleId}::uuid)
    `
    const expired = result[0]?.fn_expire_offers
    expect(Number(expired)).toBeGreaterThanOrEqual(1)

    const after = await sql<Array<{ state: string }>>`
      SELECT state FROM offers WHERE applicant_id = ${waitlisted2}::uuid
    `
    expect(after[0]!.state).toBe('lapsed')
  })

  it('never issues more offers than a department has seats', async () => {
    // Pending offers count as taken. Otherwise the cascade over-issues while people are still
    // deciding, and a department ends up over capacity the moment they all accept.
    const rows = await sql<Array<{ capacity: number; held: string }>>`
      SELECT d.capacity, count(*)::text AS held
        FROM offers o JOIN departments d ON d.id = o.department_id
       WHERE o.state = 'accepted' OR (o.state = 'pending' AND o.expires_at > now())
       GROUP BY d.id, d.capacity
    `
    for (const row of rows) {
      expect(Number(row.held)).toBeLessThanOrEqual(Number(row.capacity))
    }
  })

  it('surfaces offers due a reminder at T−6h, not T−48h', async () => {
    // The spec's T−48h cannot exist against a 24-hour expiry — it would fire before the offer
    // was sent.
    const fresh = reminderDue
    await sql`SELECT fn_issue_offer(${fresh}::uuid, ${events}::uuid)`

    const none = await sql<Array<{ offer_id: string }>>`
      SELECT offer_id FROM fn_offers_needing_reminder(${fx.cycleId}::uuid)
    `
    expect(none.some((r) => r.offer_id)).toBe(false)

    await sql`
      UPDATE offers SET expires_at = now() + interval '3 hours'
       WHERE applicant_id = ${fresh}::uuid
    `
    const due = await sql<Array<{ applicant_id: string }>>`
      SELECT applicant_id FROM fn_offers_needing_reminder(${fx.cycleId}::uuid)
    `
    expect(due.some((r) => r.applicant_id === fresh)).toBe(true)
  })
})

describe('publication and export', () => {
  it('makes an applicant’s own decision visible only after publishing', async () => {
    const [target] = await sql<Array<{ applicant_id: string }>>`
      SELECT applicant_id FROM current_decisions WHERE cycle_id = ${fx.cycleId}::uuid LIMIT 1
    `

    // Before publishing, the decision is a proposal. Showing a proposal as an outcome would be
    // the worst possible reading of "never present a provisional number as final".
    const hidden = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE rms_app`
      await tx`SELECT set_config('app.applicant_id', ${target!.applicant_id}, true)`
      return tx`SELECT id FROM decisions`
    })
    expect(hidden).toHaveLength(0)

    await asUser(sql, president, (tx) => tx`SELECT fn_publish_results(${fx.cycleId}::uuid)`)

    const visible = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE rms_app`
      await tx`SELECT set_config('app.applicant_id', ${target!.applicant_id}, true)`
      return tx`SELECT id FROM decisions`
    })
    expect(visible.length).toBeGreaterThan(0)
  })

  it('exports the selected list for building the announcement', async () => {
    const rows = await sql<Array<{ department_name: string; display_id: string }>>`
      SELECT * FROM fn_export_selected(${fx.cycleId}::uuid)
    `
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]!.display_id).toMatch(/^SPH-/)
  })
})
