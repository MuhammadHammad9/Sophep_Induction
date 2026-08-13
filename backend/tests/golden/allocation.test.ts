/**
 * Allocation — the golden dataset.
 *
 * Critical test case 5: allocation run twice over identical input must produce byte-identical
 * output. That is not a nicety. Scores tie frequently on a coarse rubric, and v1's ordering
 * stopped at score — so two runs could return two different valid stable matchings, and the
 * honest answer to "why was I ranked below someone with my score" became "you weren't, until
 * we re-ran it" (E8).
 *
 * The fixture is hand-built with DELIBERATE TIES so the tie-break chain is actually exercised.
 * A fixture with distinct scores would pass against an implementation that ignores levels 2–5
 * entirely.
 *
 * Refs: FR-DEC-001..009, E8
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type postgres from 'postgres'
import { testDb, migrate, resetSchema, seedFixture, asUser, type Fixture } from '../helpers'

let sql: postgres.Sql<Record<string, never>>
let fx: Fixture
let stageId: string
let rubricId: string
let criteria: Array<{ id: string }>
let interviewerA: string
let interviewerB: string
let departments: Array<{ id: string; code: string }>

let seq = 0
const nextPhone = () => `03${String(800_000_000 + ++seq).padStart(9, '0')}`

beforeAll(async () => {
  sql = testDb()
  await resetSchema(sql)
  await migrate(sql)
  fx = await seedFixture(sql)
  interviewerA = fx.users['interviewer']!

  const [b] = await sql<Array<{ id: string }>>`
    INSERT INTO users (email, full_name) VALUES ('alloc-b@test.sophep', 'Interviewer B')
    RETURNING id
  `
  interviewerB = b!.id
  await sql`
    INSERT INTO memberships (cycle_id, user_id, role)
    VALUES (${fx.cycleId}::uuid, ${interviewerB}::uuid, 'interviewer'::role_name)
  `

  // Small capacities so the capacity constraint actually binds — with capacity 10 and 6
  // applicants, deferred acceptance never has to reject anyone and proves nothing.
  await sql`
    UPDATE departments SET capacity = 2 WHERE cycle_id = ${fx.cycleId}::uuid AND code = 'TECH'
  `
  await sql`
    UPDATE departments SET capacity = 1 WHERE cycle_id = ${fx.cycleId}::uuid AND code = 'MEDIA'
  `
  await sql`
    UPDATE departments SET capacity = 3 WHERE cycle_id = ${fx.cycleId}::uuid AND code = 'EVENTS'
  `
  departments = await sql<Array<{ id: string; code: string }>>`
    SELECT id, code FROM departments WHERE cycle_id = ${fx.cycleId}::uuid ORDER BY code
  `

  const [stage] = await sql<Array<{ id: string }>>`
    INSERT INTO stages (cycle_id, kind, name, starts_at, ends_at)
    VALUES (${fx.cycleId}::uuid, 'interview', 'Day 1',
            now() - interval '2 hours', now() + interval '8 hours')
    RETURNING id
  `
  stageId = stage!.id

  const [rubric] = await sql<Array<{ id: string }>>`
    INSERT INTO rubrics (cycle_id, name, scale_min, scale_max)
    VALUES (${fx.cycleId}::uuid, 'Allocation rubric', 1, 5) RETURNING id
  `
  rubricId = rubric!.id
  criteria = await sql<Array<{ id: string }>>`
    INSERT INTO rubric_criteria (rubric_id, code, name, weight, anchor_min, anchor_max)
    VALUES (${rubricId}::uuid, 'ONE', 'Overall', 100,
            'Did not demonstrate the requirement at all',
            'Demonstrated the requirement thoroughly')
    RETURNING id
  `
  await sql`SELECT fn_publish_rubric(${rubricId}::uuid)`
}, 300_000)

afterAll(async () => {
  await sql?.end()
})

/**
 * Create an applicant, interview them, and have both panel members score identically.
 *
 * Identical scores from both interviewers keeps the fixture predictable: the applicant's final
 * score is exactly the criterion fraction, so ties are constructed on purpose rather than by
 * accident.
 */
async function scoredApplicant(
  name: string,
  score: number,
  preferenceCodes: string[],
): Promise<string> {
  const [a] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_register_applicant(
      ${fx.cycleId}::uuid, ${name}, ${`alloc-${++seq}@example.com`}, ${nextPhone()}, 'online')
  `
  const applicantId = a!.id

  let rank = 1
  for (const code of preferenceCodes) {
    const dept = departments.find((d) => d.code === code)!
    await sql`
      INSERT INTO applicant_preferences (cycle_id, applicant_id, department_id, rank)
      VALUES (${fx.cycleId}::uuid, ${applicantId}::uuid, ${dept.id}::uuid, ${rank})
    `
    rank++
  }

  await sql`SELECT * FROM fn_check_in(${applicantId}::uuid, ${stageId}::uuid)`

  const [room] = await sql<Array<{ id: string }>>`
    INSERT INTO rooms (cycle_id, code, name)
    VALUES (${fx.cycleId}::uuid, ${'AL' + seq}, ${'Room ' + seq}) RETURNING id
  `
  const [panel] = await sql<Array<{ id: string }>>`
    INSERT INTO panels (cycle_id, room_id, name, status, opened_at, last_heartbeat)
    VALUES (${fx.cycleId}::uuid, ${room!.id}::uuid, ${'Panel ' + seq}, 'open', now(), now())
    RETURNING id
  `
  await sql`INSERT INTO panel_tracks (panel_id, track_id) VALUES (${panel!.id}::uuid, ${fx.trackId}::uuid)`
  await sql`
    INSERT INTO panel_members (panel_id, interviewer_id) VALUES
      (${panel!.id}::uuid, ${interviewerA}::uuid), (${panel!.id}::uuid, ${interviewerB}::uuid)
  `

  await sql`
    UPDATE queue_entries SET priority = 100, priority_reason = 'fixture ordering',
                             enqueued_at = now() - interval '1 day'
     WHERE applicant_id = ${applicantId}::uuid
  `
  const [claimed] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_claim_next(${panel!.id}::uuid)
  `
  const [interview] = await sql<Array<{ id: string }>>`
    INSERT INTO interviews (cycle_id, applicant_id, panel_id, queue_entry_id, status, rubric_id)
    VALUES (${fx.cycleId}::uuid, ${applicantId}::uuid, ${panel!.id}::uuid, ${claimed!.id}::uuid,
            'in_progress', ${rubricId}::uuid)
    RETURNING id
  `
  await sql`SELECT fn_queue_transition(${claimed!.id}::uuid, 'in_interview'::queue_state)`

  const payload = sql.json([{ criterion_id: criteria[0]!.id, score }])
  await asUser(sql, interviewerA, (tx) => tx`SELECT fn_submit_evaluation(${interview!.id}::uuid, ${interviewerA}::uuid, ${payload}::jsonb, NULL)`)
  await asUser(sql, interviewerB, (tx) => tx`SELECT fn_submit_evaluation(${interview!.id}::uuid, ${interviewerB}::uuid, ${payload}::jsonb, NULL)`)

  return applicantId
}

/**
 * Run allocation as somebody who is allowed to.
 *
 * Migration 0041 put `allocation.run` on `fn_run_allocation`, and only super_admin holds it.
 * These calls previously ran on the bare privileged connection with no bound identity, which
 * now raises TOKEN_INVALID before any pre-flight gate is reached — so the gate assertions were
 * passing for the wrong reason and the determinism checks were failing outright.
 */
async function runAllocation<T extends Record<string, unknown>>(): Promise<T[]> {
  return asUser(sql, fx.users['super_admin']!, (tx) =>
    tx<T[]>`SELECT * FROM fn_run_allocation(${fx.cycleId}::uuid)`,
  )
}

describe('pre-flight gates', () => {
  it('refuses to run before shrinkage is computed (FR-DEC-002)', async () => {
    await expect(
      runAllocation(),
    ).rejects.toThrow(/PREFLIGHT_FAILED/)
  })

  it('refuses while a department has no capacity (FR-DEC-003)', async () => {
    // EVENTS exists in the fixture; OUTREACH does not, and targeting a department that is not
    // there would make this test pass for the wrong reason.
    await sql`
      UPDATE departments SET capacity = NULL
       WHERE cycle_id = ${fx.cycleId}::uuid AND code = 'EVENTS'
    `
    const blockers = await sql<Array<{ blocker: string; detail: string }>>`
      SELECT blocker, detail FROM fn_allocation_preflight(${fx.cycleId}::uuid)
    `
    const gate = blockers.find((b) => b.blocker === 'department_without_capacity')
    expect(gate).toBeDefined()
    expect(gate!.detail).toBe('Events')

    // Restore. Deactivating would also be a legitimate answer — a department not running this
    // cycle needs no capacity, and forcing a made-up number would be worse.
    await sql`
      UPDATE departments SET capacity = 3
       WHERE cycle_id = ${fx.cycleId}::uuid AND code = 'EVENTS'
    `
  })

  /**
   * The gate that exists because of a gap in the specification.
   *
   * fn_register_and_checkin (FR-CHK-010) creates applicants with NO preferences — a walk-in
   * with a queue behind them cannot fill in a form. Deferred acceptance is applicant-proposing,
   * so an empty list means proposing to nobody: they would be interviewed, scored, and then
   * silently allocated nothing.
   */
  it('refuses while an interviewed applicant has no preferences', async () => {
    const noPrefs = await scoredApplicant('No Preferences', 4, [])

    const blockers = await sql<Array<{ blocker: string; entity_id: string }>>`
      SELECT blocker, entity_id FROM fn_allocation_preflight(${fx.cycleId}::uuid)
    `
    const gate = blockers.find((b) => b.blocker === 'applicant_without_preferences')

    expect(gate).toBeDefined()
    expect(gate!.entity_id).toBe(noPrefs)

    // Fix it the way the desk would: collect the preference.
    await sql`
      INSERT INTO applicant_preferences (cycle_id, applicant_id, department_id, rank)
      VALUES (${fx.cycleId}::uuid, ${noPrefs}::uuid,
              ${departments.find((d) => d.code === 'EVENTS')!.id}::uuid, 1)
    `
  })
})

describe('allocation', () => {
  let firstChecksum: string

  beforeAll(async () => {
    // A cohort with DELIBERATE TIES. Three applicants score exactly 75 and all want TECH,
    // which has capacity 2 — so the tie-break chain decides who is cut, and a fixture with
    // distinct scores would never test it.
    await scoredApplicant('Tie Alpha', 4, ['TECH', 'EVENTS'])
    await scoredApplicant('Tie Bravo', 4, ['TECH', 'EVENTS'])
    await scoredApplicant('Tie Charlie', 4, ['TECH', 'MEDIA'])
    await scoredApplicant('Top Scorer', 5, ['TECH'])
    await scoredApplicant('Media Only', 3, ['MEDIA'])
    await scoredApplicant('Events Person', 3, ['EVENTS'])

    await sql`SELECT fn_compute_adjustment(${fx.cycleId}::uuid)`
  }, 300_000)

  it('runs and records a checksum', async () => {
    const [run] = await runAllocation<{
      result_checksum: string
      selected_count: number
      waitlisted_count: number
    }>()

    expect(run!.result_checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(Number(run!.selected_count)).toBeGreaterThan(0)
    firstChecksum = run!.result_checksum
  })

  /**
   * Critical test case 5. The E8 regression.
   */
  it('produces a BYTE-IDENTICAL result when re-run over unchanged input', async () => {
    const [second] = await runAllocation<{ result_checksum: string }>()
    expect(second!.result_checksum).toBe(firstChecksum)

    const [third] = await runAllocation<{ result_checksum: string }>()
    expect(third!.result_checksum).toBe(firstChecksum)
  })

  it('never exceeds a department capacity', async () => {
    const rows = await sql<Array<{ code: string; capacity: number; selected: string }>>`
      SELECT d.code, d.capacity, count(*)::text AS selected
        FROM current_decisions cd
        JOIN departments d ON d.id = cd.department_id
       WHERE cd.outcome = 'selected' AND cd.cycle_id = ${fx.cycleId}::uuid
       GROUP BY d.code, d.capacity
    `

    for (const row of rows) {
      expect(Number(row.selected), `${row.code} over capacity`).toBeLessThanOrEqual(
        Number(row.capacity),
      )
    }
  })

  it('places each applicant in at most one department (OI-4)', async () => {
    const rows = await sql<Array<{ applicant_id: string; n: string }>>`
      SELECT applicant_id, count(*)::text AS n
        FROM current_decisions
       WHERE outcome = 'selected' AND cycle_id = ${fx.cycleId}::uuid
       GROUP BY applicant_id HAVING count(*) > 1
    `
    expect(rows).toHaveLength(0)
  })

  it('gives the highest scorer their first preference', async () => {
    // Applicant-optimal among stable matchings: nobody with a better score is displaced by
    // someone worse for a place they both wanted.
    const [top] = await sql<Array<{ code: string; outcome: string }>>`
      SELECT d.code, cd.outcome
        FROM current_decisions cd
        JOIN applicants a ON a.id = cd.applicant_id
        LEFT JOIN departments d ON d.id = cd.department_id
       WHERE a.full_name = 'Top Scorer'
    `
    expect(top!.outcome).toBe('selected')
    expect(top!.code).toBe('TECH')
  })

  it('cascades a displaced applicant to their next preference, not to nothing', async () => {
    // TECH has capacity 2 and four applicants want it. Whoever loses should hold a place at
    // their second choice rather than being dropped — that is the whole point of DEFERRED
    // acceptance over a greedy pass.
    const rows = await sql<Array<{ full_name: string; outcome: string; code: string | null }>>`
      SELECT a.full_name, cd.outcome, d.code
        FROM current_decisions cd
        JOIN applicants a ON a.id = cd.applicant_id
        LEFT JOIN departments d ON d.id = cd.department_id
       WHERE a.full_name LIKE 'Tie %'
    `

    expect(rows).toHaveLength(3)
    // Every tied applicant listed EVENTS or MEDIA second, so none should be simply rejected.
    for (const row of rows) {
      expect(['selected', 'waitlisted']).toContain(row.outcome)
    }
  })

  it('marks every decision a PROPOSAL until a human decides', async () => {
    // The committee decides in an on-site meeting. Nothing becomes an outcome because the
    // algorithm said so.
    const rows = await sql<Array<{ is_proposal: boolean }>>`
      SELECT is_proposal FROM current_decisions WHERE cycle_id = ${fx.cycleId}::uuid
    `
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.is_proposal)).toBe(true)
  })
})

describe('override (FR-DEC-009)', () => {
  it('creates a new version and retains the prior one', async () => {
    const [target] = await sql<Array<{ applicant_id: string; version: number }>>`
      SELECT applicant_id, version FROM current_decisions
       WHERE cycle_id = ${fx.cycleId}::uuid AND outcome = 'waitlisted' LIMIT 1
    `
    const tech = departments.find((d) => d.code === 'TECH')!

    await asUser(sql, fx.users['super_admin']!, (tx) =>
      tx`
        SELECT fn_override_decision(
          ${target!.applicant_id}::uuid, 'selected'::decision_outcome, ${tech.id}::uuid,
          'Committee agreed at the review meeting: strongest portfolio in the round')
      `,
    )

    const versions = await sql<Array<{ version: number; outcome: string; is_proposal: boolean }>>`
      SELECT version, outcome, is_proposal FROM decisions
       WHERE applicant_id = ${target!.applicant_id}::uuid ORDER BY version
    `

    expect(versions.length).toBeGreaterThanOrEqual(2)
    expect(versions[versions.length - 1]!.outcome).toBe('selected')
    // The human decision is marked as such, so "did a person decide this?" is answerable.
    expect(versions[versions.length - 1]!.is_proposal).toBe(false)
    // The proposal it replaced is still there.
    expect(versions[0]!.is_proposal).toBe(true)
  })

  it('demands a written reason', async () => {
    // Any decision will do — coupling this to `outcome = 'waitlisted'` made it depend on the
    // previous test not having consumed the only waitlisted row.
    const [target] = await sql<Array<{ applicant_id: string }>>`
      SELECT applicant_id FROM current_decisions
       WHERE cycle_id = ${fx.cycleId}::uuid ORDER BY applicant_id LIMIT 1
    `
    await expect(
      asUser(sql, fx.users['super_admin']!, (tx) =>
        tx`SELECT fn_override_decision(${target!.applicant_id}::uuid,
                                       'rejected'::decision_outcome, NULL, 'no')`,
      ),
    ).rejects.toThrow(/written reason is required/)
  })

  it('refuses an unattributed override', async () => {
    const [target] = await sql<Array<{ applicant_id: string }>>`
      SELECT applicant_id FROM current_decisions
       WHERE cycle_id = ${fx.cycleId}::uuid ORDER BY applicant_id LIMIT 1
    `
    await expect(
      sql`SELECT fn_override_decision(${target!.applicant_id}::uuid,
                                      'rejected'::decision_outcome, NULL,
                                      'nobody is signed in to answer for this')`,
    ).rejects.toThrow(/attributed to an authenticated user/)
  })
})

describe('the selected-needs-department constraint (FR-DEC-014)', () => {
  it('makes a selected applicant without a department unrepresentable', async () => {
    // Checked at the ROW, not only in the dry run — a data error of this kind must not be
    // possible to write in the first place.
    const [any] = await sql<Array<{ applicant_id: string; cycle_id: string }>>`
      SELECT applicant_id, cycle_id FROM current_decisions LIMIT 1
    `
    await expect(
      sql`
        INSERT INTO decisions (cycle_id, applicant_id, version, outcome, department_id)
        VALUES (${any!.cycle_id}::uuid, ${any!.applicant_id}::uuid, 999, 'selected', NULL)
      `,
    ).rejects.toThrow(/selected_needs_department/)
  })
})
