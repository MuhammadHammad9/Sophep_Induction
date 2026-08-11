/**
 * State ownership, audit integrity, and the dedupe override branch.
 *
 * Three errata are asserted here:
 *   E5 — applicants.state was writable from two places and would silently drift.
 *   E4 — a plain unique index made the documented override branch impossible.
 *   FR-AUD-003 — an audit log that can be edited is not an audit log.
 *
 * Refs: FR-OPS-001, FR-OPS-002, FR-AUD-001..003, FR-REG-006..009, E4, E5
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
}, 60_000)

afterAll(async () => {
  await sql?.end()
})

async function makeApplicant(suffix: string): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_register_applicant(
      ${fx.cycleId}::uuid,
      ${`Person ${suffix}`},
      ${`person${suffix}@example.com`},
      ${`0300${suffix.padStart(7, '0')}`},
      'online'
    )
  `
  return row!.id
}

describe('state ownership (E5)', () => {
  /**
   * The projection rule as a database property rather than a code-review convention.
   *
   * The bug being prevented: an applicant whose status page says "Position 4" while the panel
   * screen says they are mid-interview — during the event, in front of them, and unfixable
   * afterwards because nothing recorded which was right.
   */
  it('refuses a direct UPDATE of applicants.state', async () => {
    const id = await makeApplicant('100')

    await expect(
      sql`UPDATE applicants SET state = 'eligible' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/projection and cannot be written directly/i)
  })

  it('permits the change through the owning transition function', async () => {
    const id = await makeApplicant('101')

    await sql`SELECT fn_application_transition(${id}::uuid, 'eligible'::applicant_state)`

    const [row] = await sql<Array<{ state: string }>>`
      SELECT state FROM applicants WHERE id = ${id}::uuid
    `
    expect(row!.state).toBe('eligible')
  })

  it('allows non-state columns to be updated directly', async () => {
    // The guard must not become a blanket write lock — Admin has to fix a mistyped email to
    // deliver a result (spec §5.1).
    const id = await makeApplicant('102')

    await sql`UPDATE applicants SET email = 'corrected@example.com' WHERE id = ${id}::uuid`

    const [row] = await sql<Array<{ email: string; email_norm: string }>>`
      SELECT email, email_norm FROM applicants WHERE id = ${id}::uuid
    `
    expect(row!.email).toBe('corrected@example.com')
    expect(row!.email_norm).toBe('corrected@example.com')
  })

  it('rejects an undefined transition', async () => {
    const id = await makeApplicant('103')

    // submitted -> accepted is not in application_transitions. Anything unlisted is refused;
    // ambiguous state is the root cause of most "the system did something weird" reports.
    await expect(
      sql`SELECT fn_application_transition(${id}::uuid, 'accepted'::applicant_state)`,
    ).rejects.toThrow(/INVALID_TRANSITION/)
  })

  it('requires a reason to screen out or withdraw', async () => {
    const id = await makeApplicant('104')

    await expect(
      sql`SELECT fn_application_transition(${id}::uuid, 'screened_out'::applicant_state)`,
    ).rejects.toThrow(/reason is required/i)

    await sql`
      SELECT fn_application_transition(
        ${id}::uuid, 'screened_out'::applicant_state, 'Not a registered student')
    `
    const [row] = await sql<Array<{ state: string }>>`
      SELECT state FROM applicants WHERE id = ${id}::uuid
    `
    expect(row!.state).toBe('screened_out')
  })

  it('is idempotent for a no-op transition', async () => {
    const id = await makeApplicant('105')
    await sql`SELECT fn_application_transition(${id}::uuid, 'eligible'::applicant_state)`

    const before = await sql<Array<{ count: string }>>`
      SELECT count(*) FROM audit_events WHERE entity_id = ${id}::uuid
    `
    await sql`SELECT fn_application_transition(${id}::uuid, 'eligible'::applicant_state)`
    const after = await sql<Array<{ count: string }>>`
      SELECT count(*) FROM audit_events WHERE entity_id = ${id}::uuid
    `

    // No spurious audit row for a transition that changed nothing.
    expect(after[0]!.count).toBe(before[0]!.count)
  })
})

describe('audit integrity (FR-AUD-001..003)', () => {
  it('writes an audit row in the same transaction as the transition', async () => {
    const id = await makeApplicant('200')
    await sql`SELECT fn_application_transition(${id}::uuid, 'eligible'::applicant_state)`

    const rows = await sql<Array<{ action: string; before: unknown; after: unknown }>>`
      SELECT action, before, after FROM audit_events
       WHERE entity_id = ${id}::uuid AND action = 'applicant.state_changed'
    `

    expect(rows).toHaveLength(1)
    expect(rows[0]!.before).toEqual({ state: 'submitted' })
    expect(rows[0]!.after).toEqual({ state: 'eligible' })
  })

  it('records registration and the override as separate events', async () => {
    // "Who decided these were different people, and why" must be answerable on its own,
    // not inferred from a registration row (FR-REG-008).
    await sql`
      SELECT fn_register_applicant(
        ${fx.cycleId}::uuid, 'Twin One', 'twin@example.com', '03005550001', 'online')
    `
    const [twin] = await sql<Array<{ id: string }>>`
      SELECT id FROM fn_register_applicant(
        ${fx.cycleId}::uuid, 'Twin Two', 'twin@example.com', '03005550002',
        'walkin_digital', '{}'::jsonb, NULL,
        'Confirmed with both students at the desk, genuinely different people')
    `

    const actions = await sql<Array<{ action: string }>>`
      SELECT action FROM audit_events WHERE entity_id = ${twin!.id}::uuid ORDER BY id
    `
    expect(actions.map((a) => a.action)).toEqual([
      'applicant.registered',
      'applicant.dedupe_overridden',
    ])
  })

  it('rejects UPDATE and DELETE on audit_events', async () => {
    await expect(
      sql`UPDATE audit_events SET reason = 'tampered' WHERE id = (SELECT min(id) FROM audit_events)`,
    ).rejects.toThrow(/append-only/i)

    await expect(
      sql`DELETE FROM audit_events WHERE id = (SELECT min(id) FROM audit_events)`,
    ).rejects.toThrow(/append-only/i)
  })
})

describe('duplicate detection and the override branch (E4)', () => {
  it('detects an exact email match as a hard block', async () => {
    await sql`
      SELECT fn_register_applicant(
        ${fx.cycleId}::uuid, 'Original', 'dupe@example.com', '03006660001', 'online')
    `

    const rows = await sql<Array<{ match_kind: string; is_hard_block: boolean }>>`
      SELECT match_kind, is_hard_block
        FROM fn_find_duplicates(${fx.cycleId}::uuid, 'dupe@example.com', '03009990000')
    `

    expect(rows).toHaveLength(1)
    expect(rows[0]!.match_kind).toBe('email')
    expect(rows[0]!.is_hard_block).toBe(true)
  })

  it('detects the Gmail variant v1 missed (E6)', async () => {
    await sql`
      SELECT fn_register_applicant(
        ${fx.cycleId}::uuid, 'Gmail User', 'ab@gmail.com', '03006660002', 'online')
    `

    const rows = await sql<Array<{ match_kind: string }>>`
      SELECT match_kind
        FROM fn_find_duplicates(${fx.cycleId}::uuid, 'a.b+induction@gmail.com', '03009990001')
    `

    expect(rows.map((r) => r.match_kind)).toContain('email')
  })

  /**
   * The E4 assertion. In v1 this INSERT failed on a constraint violation, so the flow diagram
   * documented a branch the database forbade. The partial index is what makes it work.
   */
  it('allows a reasoned override to succeed', async () => {
    await sql`
      SELECT fn_register_applicant(
        ${fx.cycleId}::uuid, 'Sibling A', 'shared@example.com', '03007770001', 'online')
    `

    const [second] = await sql<Array<{ id: string; display_id: string }>>`
      SELECT id, display_id FROM fn_register_applicant(
        ${fx.cycleId}::uuid, 'Sibling B', 'shared@example.com', '03007770002',
        'walkin_digital', '{}'::jsonb, NULL,
        'Siblings sharing one family email address, confirmed at the desk')
    `

    expect(second!.display_id).toMatch(/^SPH-SP26-\d{4}$/)

    const both = await sql<Array<{ id: string }>>`
      SELECT id FROM applicants
       WHERE cycle_id = ${fx.cycleId}::uuid AND email_norm = 'shared@example.com'
    `
    expect(both).toHaveLength(2)
  })

  it('still blocks an accidental duplicate with no reason', async () => {
    // The constraint must keep catching accidents — the override is a deliberate act, and
    // the index is the backstop when the application-layer check is bypassed or raced.
    await sql`
      SELECT fn_register_applicant(
        ${fx.cycleId}::uuid, 'Accident A', 'accident@example.com', '03007770003', 'online')
    `

    await expect(
      sql`
        SELECT fn_register_applicant(
          ${fx.cycleId}::uuid, 'Accident B', 'accident@example.com', '03007770004', 'online')
      `,
    ).rejects.toThrow(/uq_applicant_email/)
  })

  it('frees the address again once the original withdraws', async () => {
    // DR-005: uniqueness excludes withdrawn and screened-out records, so someone who
    // withdrew can re-register without needing an override.
    const [first] = await sql<Array<{ id: string }>>`
      SELECT id FROM fn_register_applicant(
        ${fx.cycleId}::uuid, 'Withdrawer', 'withdraw@example.com', '03007770005', 'online')
    `
    await sql`
      SELECT fn_application_transition(
        ${first!.id}::uuid, 'withdrawn'::applicant_state, 'Changed their mind')
    `

    const [again] = await sql<Array<{ id: string }>>`
      SELECT id FROM fn_register_applicant(
        ${fx.cycleId}::uuid, 'Withdrawer', 'withdraw@example.com', '03007770006', 'online')
    `
    expect(again!.id).toBeTruthy()
  })
})

describe('cycle state gate (FR-CYC-004)', () => {
  it('rejects an online registration when registration is closed', async () => {
    const [closed] = await sql<Array<{ id: string }>>`
      INSERT INTO cycles (society_id, season, year, name, state)
      VALUES (${fx.societyId}::uuid, 'SU', 2026, 'Summer 2026', 'registration_closed')
      RETURNING id
    `

    // Enforced at the write, not in the UI — a hand-crafted request must fail too.
    await expect(
      sql`
        SELECT fn_register_applicant(
          ${closed!.id}::uuid, 'Too Late', 'late@example.com', '03008880001', 'online')
      `,
    ).rejects.toThrow(/STAGE_CLOSED/)
  })

  it('still allows a walk-in once registration has closed', async () => {
    // Someone arriving at the desk on the day with no prior application is a normal case,
    // not an error (FR-CHK-010).
    const [closed] = await sql<Array<{ id: string }>>`
      SELECT id FROM cycles WHERE season = 'SU' AND year = 2026
    `

    const [row] = await sql<Array<{ display_id: string }>>`
      SELECT display_id FROM fn_register_applicant(
        ${closed!.id}::uuid, 'Walk In', 'walkin@example.com', '03008880002', 'walkin_digital')
    `
    expect(row!.display_id).toBe('SPH-SU26-0001')
  })

  it('rejects every write to an archived cycle', async () => {
    const [archived] = await sql<Array<{ id: string }>>`
      INSERT INTO cycles (society_id, season, year, name, state)
      VALUES (${fx.societyId}::uuid, 'FA', 2025, 'Fall 2025', 'archived')
      RETURNING id
    `

    await expect(
      sql`
        SELECT fn_register_applicant(
          ${archived!.id}::uuid, 'Nope', 'nope@example.com', '03008880003', 'walkin_digital')
      `,
    ).rejects.toThrow(/CYCLE_ARCHIVED/)
  })
})
