/**
 * Evaluation: blind scoring, immutability, waivers and the stage-close gate.
 *
 * Critical test case 6 lives here — an interviewer must not be able to read another
 * interviewer's evaluation VIA DIRECT SQL under their own RLS context. Testing that through
 * the API would only prove the API is careful; the claim in FR-INT-004 is that concealment is
 * a property of the database.
 *
 * Refs: FR-INT-004..013, FR-CYC-008..010, E10, E15, E17
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type postgres from 'postgres'
import { testDb, migrate, resetSchema, seedFixture, asUser, type Fixture } from '../helpers'

let sql: postgres.Sql<Record<string, never>>
let fx: Fixture
let stageId: string
let rubricId: string
let criteria: Array<{ id: string; weight: number }>
let interviewerA: string
let interviewerB: string

let seq = 0
const nextPhone = () => `03${String(700_000_000 + ++seq).padStart(9, '0')}`

beforeAll(async () => {
  sql = testDb()
  await resetSchema(sql)
  await migrate(sql)
  fx = await seedFixture(sql)
  interviewerA = fx.users['interviewer']!

  const [b] = await sql<Array<{ id: string }>>`
    INSERT INTO users (email, full_name) VALUES ('interviewer-b@test.sophep', 'Interviewer B')
    RETURNING id
  `
  interviewerB = b!.id
  await sql`
    INSERT INTO memberships (cycle_id, user_id, role)
    VALUES (${fx.cycleId}::uuid, ${interviewerB}::uuid, 'interviewer'::role_name)
  `

  const [stage] = await sql<Array<{ id: string }>>`
    INSERT INTO stages (cycle_id, kind, name, starts_at, ends_at)
    VALUES (${fx.cycleId}::uuid, 'interview', 'Day 1',
            now() - interval '1 hour', now() + interval '8 hours')
    RETURNING id
  `
  stageId = stage!.id

  const [rubric] = await sql<Array<{ id: string }>>`
    INSERT INTO rubrics (cycle_id, name, scale_min, scale_max)
    VALUES (${fx.cycleId}::uuid, 'General interview', 1, 5)
    RETURNING id
  `
  rubricId = rubric!.id

  criteria = await sql<Array<{ id: string; weight: number }>>`
    INSERT INTO rubric_criteria (rubric_id, code, name, weight, anchor_min, anchor_max, sort_order)
    VALUES
      (${rubricId}::uuid, 'COMM', 'Communication', 40,
       'Struggles to convey a simple idea clearly', 'Explains complex ideas so anyone follows', 1),
      (${rubricId}::uuid, 'FIT', 'Department fit', 35,
       'No demonstrated interest in the department', 'Deep, specific interest with evidence', 2),
      (${rubricId}::uuid, 'INIT', 'Initiative', 25,
       'Waits to be told what to do', 'Has independently started and finished real work', 3)
    RETURNING id, weight
  `

  await sql`SELECT fn_publish_rubric(${rubricId}::uuid)`
}, 300_000)

afterAll(async () => {
  await sql?.end()
})

/** Build an interview with both interviewers on the panel, ready to be evaluated. */
async function stagedInterview(name: string): Promise<{ interviewId: string; applicantId: string }> {
  const [a] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_register_applicant(
      ${fx.cycleId}::uuid, ${name}, ${`eval-${++seq}@example.com`}, ${nextPhone()}, 'online')
  `
  await sql`SELECT * FROM fn_check_in(${a!.id}::uuid, ${stageId}::uuid)`

  const [room] = await sql<Array<{ id: string }>>`
    INSERT INTO rooms (cycle_id, code, name) VALUES (${fx.cycleId}::uuid, ${'EV' + seq}, ${'Room ' + seq})
    RETURNING id
  `
  const [panel] = await sql<Array<{ id: string }>>`
    INSERT INTO panels (cycle_id, room_id, name, status, opened_at, last_heartbeat)
    VALUES (${fx.cycleId}::uuid, ${room!.id}::uuid, ${'Panel ' + seq}, 'open', now(), now())
    RETURNING id
  `
  await sql`INSERT INTO panel_tracks (panel_id, track_id) VALUES (${panel!.id}::uuid, ${fx.trackId}::uuid)`
  await sql`
    INSERT INTO panel_members (panel_id, interviewer_id) VALUES
      (${panel!.id}::uuid, ${interviewerA}::uuid),
      (${panel!.id}::uuid, ${interviewerB}::uuid)
  `

  // Head of queue so the claim is deterministic.
  await sql`
    UPDATE queue_entries SET priority = 100, priority_reason = 'test ordering',
                             enqueued_at = now() - interval '1 day'
     WHERE applicant_id = ${a!.id}::uuid
  `
  const [claimed] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_claim_next(${panel!.id}::uuid)
  `

  const [interview] = await sql<Array<{ id: string }>>`
    INSERT INTO interviews (cycle_id, applicant_id, panel_id, queue_entry_id, status, rubric_id)
    VALUES (${fx.cycleId}::uuid, ${a!.id}::uuid, ${panel!.id}::uuid, ${claimed!.id}::uuid,
            'in_progress', ${rubricId}::uuid)
    RETURNING id
  `
  await sql`
    SELECT fn_queue_transition(${claimed!.id}::uuid, 'in_interview'::queue_state)
  `

  return { interviewId: interview!.id, applicantId: a!.id }
}

/**
 * Build the scores payload.
 *
 * `sql.json(...)` matters: postgres.js encodes a plain JS string as a jsonb STRING SCALAR, so
 * `${JSON.stringify(x)}::jsonb` yields `"[...]"` rather than `[...]` and every
 * jsonb_array_elements call fails with "cannot extract elements from a scalar".
 */
const scores = (values: number[]) =>
  sql.json(criteria.map((c, i) => ({ criterion_id: c.id, score: values[i] })))

describe('rubric constraints', () => {
  it('refuses to publish unless weights sum to exactly 100 (FR-INT-005)', async () => {
    const [r] = await sql<Array<{ id: string }>>`
      INSERT INTO rubrics (cycle_id, name) VALUES (${fx.cycleId}::uuid, 'Broken') RETURNING id
    `
    await sql`
      INSERT INTO rubric_criteria (rubric_id, code, name, weight, anchor_min, anchor_max)
      VALUES (${r!.id}::uuid, 'ONE', 'Only criterion', 60,
              'A clearly inadequate answer', 'A clearly excellent answer')
    `

    // 97 or 103 silently rescales every score computed from the rubric.
    await expect(sql`SELECT fn_publish_rubric(${r!.id}::uuid)`).rejects.toThrow(/sum to exactly 100/)
  })

  it('refuses a criterion without anchors (FR-INT-006)', async () => {
    const [r] = await sql<Array<{ id: string }>>`
      INSERT INTO rubrics (cycle_id, name) VALUES (${fx.cycleId}::uuid, 'Unanchored') RETURNING id
    `
    // An unanchored scale means five different things to five people, and no statistical
    // correction recovers from that.
    await expect(
      sql`
        INSERT INTO rubric_criteria (rubric_id, code, name, weight, anchor_min, anchor_max)
        VALUES (${r!.id}::uuid, 'X', 'Vague', 100, 'bad', 'good')
      `,
    ).rejects.toThrow()
  })

  it('refuses to edit a published rubric (E17)', async () => {
    // A rubric edited mid-session splits one panel across two scales, silently.
    await expect(
      sql`
        INSERT INTO rubric_criteria (rubric_id, code, name, weight, anchor_min, anchor_max)
        VALUES (${rubricId}::uuid, 'LATE', 'Added later', 10,
                'Not demonstrated at all here', 'Demonstrated thoroughly here')
      `,
    ).rejects.toThrow(/published and cannot be edited/)
  })
})

describe('submission', () => {
  it('computes a weighted score normalised to 0–100 (FR-SCR-001)', async () => {
    const { interviewId } = await stagedInterview('Perfect Scores')

    const [evaluation] = await sql<Array<{ raw_score: string }>>`
      SELECT raw_score FROM fn_submit_evaluation(
        ${interviewId}::uuid, ${interviewerA}::uuid, ${scores([5, 5, 5])}::jsonb, 'Excellent')
    `
    // All maxima → 100.
    expect(Number(evaluation!.raw_score)).toBe(100)
  })

  it('normalises by the SCALE, so the minimum is 0 rather than 20', async () => {
    const { interviewId } = await stagedInterview('Minimum Scores')

    const [evaluation] = await sql<Array<{ raw_score: string }>>`
      SELECT raw_score FROM fn_submit_evaluation(
        ${interviewId}::uuid, ${interviewerA}::uuid, ${scores([1, 1, 1])}::jsonb, NULL)
    `
    // Dividing by max alone would give a 1–5 rubric a floor of 20%, making every applicant
    // look better than they scored.
    expect(Number(evaluation!.raw_score)).toBe(0)
  })

  it('blocks submission when a criterion is missing (FR-INT-020)', async () => {
    const { interviewId } = await stagedInterview('Partial Scores')

    const partial = sql.json([{ criterion_id: criteria[0]!.id, score: 4 }])
    await expect(
      sql`
        SELECT fn_submit_evaluation(
          ${interviewId}::uuid, ${interviewerA}::uuid, ${partial}::jsonb, NULL)
      `,
    ).rejects.toThrow(/every criterion must be scored/)
  })

  it('rejects a score outside the rubric scale', async () => {
    const { interviewId } = await stagedInterview('Out Of Range')

    await expect(
      sql`
        SELECT fn_submit_evaluation(
          ${interviewId}::uuid, ${interviewerA}::uuid, ${scores([9, 3, 3])}::jsonb, NULL)
      `,
    ).rejects.toThrow(/outside the rubric scale/)
  })

  it('refuses a second submission from the same interviewer (FR-INT-008)', async () => {
    const { interviewId } = await stagedInterview('Double Submit')
    await sql`
      SELECT fn_submit_evaluation(
        ${interviewId}::uuid, ${interviewerA}::uuid, ${scores([4, 4, 4])}::jsonb, NULL)
    `

    await expect(
      sql`
        SELECT fn_submit_evaluation(
          ${interviewId}::uuid, ${interviewerA}::uuid, ${scores([5, 5, 5])}::jsonb, NULL)
      `,
    ).rejects.toThrow(/already submitted/)
  })

  it('refuses someone who is not on the panel', async () => {
    const { interviewId } = await stagedInterview('Wrong Panel')

    await expect(
      sql`
        SELECT fn_submit_evaluation(
          ${interviewId}::uuid, ${fx.users['volunteer']!}::uuid, ${scores([3, 3, 3])}::jsonb, NULL)
      `,
    ).rejects.toThrow(/not a member of this panel/)
  })
})

describe('the completion gate (FR-INT-011, E10)', () => {
  it('holds the interview at awaiting_evaluations until BOTH members submit', async () => {
    const { interviewId } = await stagedInterview('One Of Two')

    await sql`
      SELECT fn_submit_evaluation(
        ${interviewId}::uuid, ${interviewerA}::uuid, ${scores([4, 4, 4])}::jsonb, NULL)
    `

    const [afterFirst] = await sql<Array<{ status: string; panel_id: string }>>`
      SELECT status, panel_id FROM interviews WHERE id = ${interviewId}::uuid
    `
    expect(afterFirst!.status).toBe('awaiting_evaluations')

    // FR-INT-013: the panel is blocked from claiming, which is exactly why
    // awaiting_evaluations had to become a representable panel state (E10).
    const [panel] = await sql<Array<{ status: string }>>`
      SELECT status FROM panels WHERE id = ${afterFirst!.panel_id}::uuid
    `
    expect(panel!.status).toBe('awaiting_evaluations')
    await expect(
      sql`SELECT fn_claim_next(${afterFirst!.panel_id}::uuid)`,
    ).rejects.toThrow(/PANEL_AWAITING_EVALUATIONS/)

    await sql`
      SELECT fn_submit_evaluation(
        ${interviewId}::uuid, ${interviewerB}::uuid, ${scores([3, 3, 3])}::jsonb, NULL)
    `

    const [afterSecond] = await sql<Array<{ status: string }>>`
      SELECT status FROM interviews WHERE id = ${interviewId}::uuid
    `
    expect(afterSecond!.status).toBe('complete')

    // The panel is freed and can claim again.
    const [freed] = await sql<Array<{ status: string }>>`
      SELECT status FROM panels WHERE id = ${afterFirst!.panel_id}::uuid
    `
    expect(freed!.status).toBe('open')
  })

  it('records a service observation for the wait estimator', async () => {
    // Only for COMPLETED interviews — an abandoned one would poison the EWMA with a duration
    // that was never a real interview.
    const before = await sql<Array<{ id: string }>>`SELECT id FROM service_observations`

    const { interviewId } = await stagedInterview('Timed Interview')
    await sql`SELECT fn_submit_evaluation(${interviewId}::uuid, ${interviewerA}::uuid, ${scores([4, 4, 4])}::jsonb, NULL)`
    await sql`SELECT fn_submit_evaluation(${interviewId}::uuid, ${interviewerB}::uuid, ${scores([4, 4, 4])}::jsonb, NULL)`

    const after = await sql<Array<{ id: string }>>`SELECT id FROM service_observations`
    expect(after.length).toBe(before.length + 1)
  })

  it('completes on a waiver, so one absent interviewer cannot disable a panel', async () => {
    // FR-INT-012. Without this escape hatch, an interviewer going home at 16:00 blocks their
    // panel for the rest of the day.
    const { interviewId } = await stagedInterview('Waived Evaluation')
    await sql`
      SELECT fn_submit_evaluation(
        ${interviewId}::uuid, ${interviewerA}::uuid, ${scores([4, 4, 4])}::jsonb, NULL)
    `

    // Waived AS the coordinator. A waiver must be attributable — an unattributed one is
    // unauditable, and before migration 0026 it was silently ignored by the completion gate,
    // leaving the panel blocked for the rest of the day with no error anywhere.
    await asUser(sql, fx.users['coordinator']!, async (tx) => {
      return tx`
        SELECT fn_waive_evaluation(${interviewId}::uuid, ${interviewerB}::uuid,
                                   'Interviewer left for a lecture, confirmed with coordinator')
      `
    })

    const [interview] = await sql<Array<{ status: string }>>`
      SELECT status FROM interviews WHERE id = ${interviewId}::uuid
    `
    expect(interview!.status).toBe('complete')
  })

  it('demands a written reason for a waiver', async () => {
    const { interviewId } = await stagedInterview('Unreasoned Waiver')
    await expect(
      asUser(sql, fx.users['coordinator']!, (tx) =>
        tx`SELECT fn_waive_evaluation(${interviewId}::uuid, ${interviewerB}::uuid, 'x')`,
      ),
    ).rejects.toThrow(/written reason is required/)
  })

  it('refuses a waiver with no authenticated actor', async () => {
    // The regression guard for 0026. An unattributed waiver used to insert successfully and
    // then be ignored by the completion gate — a silent, total failure.
    const { interviewId } = await stagedInterview('Unattributed Waiver')

    await expect(
      sql`SELECT fn_waive_evaluation(${interviewId}::uuid, ${interviewerB}::uuid,
                                     'nobody is signed in to answer for this')`,
    ).rejects.toThrow(/attributed to an authenticated user/)
  })

  it('refuses to waive someone who already submitted', async () => {
    // Waiving a submitted evaluation would discard a real score.
    const { interviewId } = await stagedInterview('Already Submitted Waiver')
    await sql`
      SELECT fn_submit_evaluation(
        ${interviewId}::uuid, ${interviewerA}::uuid, ${scores([4, 4, 4])}::jsonb, NULL)
    `

    await expect(
      asUser(sql, fx.users['coordinator']!, (tx) =>
        tx`SELECT fn_waive_evaluation(${interviewId}::uuid, ${interviewerA}::uuid,
                                      'trying to waive a score that already exists')`,
      ),
    ).rejects.toThrow(/already submitted/)
  })
})

describe('blind evaluation (FR-INT-004)', () => {
  /**
   * Critical test case 6, run as DIRECT SQL under each interviewer's own context. The claim
   * is that concealment is a property of the database — so testing it through the API would
   * prove only that the API is careful.
   */
  it('hides one interviewer’s evaluation from the other', async () => {
    const { interviewId } = await stagedInterview('Blind Test')

    await sql`SELECT fn_submit_evaluation(${interviewId}::uuid, ${interviewerA}::uuid, ${scores([5, 5, 5])}::jsonb, 'A remarks')`
    await sql`SELECT fn_submit_evaluation(${interviewId}::uuid, ${interviewerB}::uuid, ${scores([1, 1, 1])}::jsonb, 'B remarks')`

    const seenByA = await asUser(sql, interviewerA, async (tx) => {
      return tx<Array<{ interviewer_id: string }>>`
        SELECT interviewer_id FROM evaluations WHERE interview_id = ${interviewId}::uuid
      `
    })

    expect(seenByA).toHaveLength(1)
    expect(seenByA[0]!.interviewer_id).toBe(interviewerA)
  })

  it('hides the other interviewer’s individual scores too', async () => {
    const { interviewId } = await stagedInterview('Blind Scores')
    await sql`SELECT fn_submit_evaluation(${interviewId}::uuid, ${interviewerA}::uuid, ${scores([5, 5, 5])}::jsonb, NULL)`
    await sql`SELECT fn_submit_evaluation(${interviewId}::uuid, ${interviewerB}::uuid, ${scores([2, 2, 2])}::jsonb, NULL)`

    const items = await asUser(sql, interviewerA, async (tx) => {
      return tx<Array<{ score: number }>>`
        SELECT si.score FROM score_items si
          JOIN evaluations e ON e.id = si.evaluation_id
         WHERE e.interview_id = ${interviewId}::uuid
      `
    })

    // Three criteria, one evaluation — never six.
    expect(items).toHaveLength(3)
    expect(items.every((i) => i.score === 5)).toBe(true)
  })

  it('denies the Coordinator any score visibility', async () => {
    // Floor authority WITHOUT score visibility is the entire reason the Coordinator role
    // exists. If this ever inverts, the separation has been lost.
    const rows = await asUser(sql, fx.users['coordinator']!, async (tx) => {
      return tx`SELECT id FROM evaluations`
    })
    expect(rows).toHaveLength(0)
  })

  it('lets the Auditor read everything (FR-RBAC-009)', async () => {
    const rows = await asUser(sql, fx.users['auditor']!, async (tx) => {
      return tx`SELECT id FROM evaluations`
    })
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('revisions (FR-INT-009)', () => {
  it('creates a new revision and RETAINS the original', async () => {
    const { interviewId } = await stagedInterview('Revised Evaluation')
    const [original] = await sql<Array<{ id: string; raw_score: string }>>`
      SELECT id, raw_score FROM fn_submit_evaluation(
        ${interviewId}::uuid, ${interviewerA}::uuid, ${scores([2, 2, 2])}::jsonb, NULL)
    `

    await sql`
      SELECT fn_revise_evaluation(${original!.id}::uuid, ${scores([4, 4, 4])}::jsonb,
                                  'Mis-keyed the first criterion during the interview')
    `

    const all = await sql<Array<{ revision: number; raw_score: string }>>`
      SELECT revision, raw_score FROM evaluations
       WHERE interview_id = ${interviewId}::uuid ORDER BY revision
    `

    // An amended score with no trace of what it replaced is indistinguishable from a
    // rewritten one.
    expect(all).toHaveLength(2)
    expect(Number(all[0]!.raw_score)).toBe(25)
    expect(Number(all[1]!.raw_score)).toBe(75)
  })

  it('demands a written reason', async () => {
    const { interviewId } = await stagedInterview('Unreasoned Revision')
    const [evaluation] = await sql<Array<{ id: string }>>`
      SELECT id FROM fn_submit_evaluation(
        ${interviewId}::uuid, ${interviewerA}::uuid, ${scores([3, 3, 3])}::jsonb, NULL)
    `

    await expect(
      sql`SELECT fn_revise_evaluation(${evaluation!.id}::uuid, ${scores([5, 5, 5])}::jsonb, '')`,
    ).rejects.toThrow(/written reason is required/)
  })
})

describe('the stage-close gate (FR-CYC-008..010, E15)', () => {
  it('blocks while an interview is in progress, naming room and panel', async () => {
    await stagedInterview('Still Running')

    const blocks = await sql<Array<{ severity: string; kind: string; detail: string }>>`
      SELECT * FROM fn_stage_close_preflight(${stageId}::uuid) WHERE severity = 'block'
    `

    expect(blocks.some((b) => b.kind === 'interview_in_progress')).toBe(true)
    // "3 interviews still running" without saying WHERE is not actionable.
    expect(blocks.find((b) => b.kind === 'interview_in_progress')!.detail).toMatch(/Room/)

    await expect(sql`SELECT fn_close_stage(${stageId}::uuid)`).rejects.toThrow(
      /STAGE_HAS_ACTIVE_INTERVIEWS/,
    )
  })

  it('lists outstanding evaluations by the interviewer who owes them', async () => {
    const { interviewId } = await stagedInterview('Half Evaluated')
    await sql`
      SELECT fn_submit_evaluation(
        ${interviewId}::uuid, ${interviewerA}::uuid, ${scores([4, 4, 4])}::jsonb, NULL)
    `

    const blocks = await sql<Array<{ kind: string; label: string }>>`
      SELECT * FROM fn_stage_close_preflight(${stageId}::uuid)
       WHERE severity = 'block' AND kind = 'evaluation_outstanding'
    `

    expect(blocks.some((b) => b.label === 'Interviewer B')).toBe(true)
  })

  it('treats waiting applicants as a warning, not a block', async () => {
    // Blocking on them would strand a coordinator at the end of a long day with no way to
    // close. It is a decision — carry forward or no-show — not an error.
    const warnings = await sql<Array<{ severity: string; kind: string }>>`
      SELECT * FROM fn_stage_close_preflight(${stageId}::uuid) WHERE severity = 'warn'
    `
    expect(warnings.every((w) => w.kind === 'applicant_waiting')).toBe(true)
  })
})

describe('void and heartbeat (FR-INT-015, FR-INT-016)', () => {
  it('flags an interview whose panel has gone silent', async () => {
    const { interviewId } = await stagedInterview('Dead Device')
    const [interview] = await sql<Array<{ panel_id: string }>>`
      SELECT panel_id FROM interviews WHERE id = ${interviewId}::uuid
    `
    await sql`
      UPDATE panels SET last_heartbeat = now() - interval '2 hours'
       WHERE id = ${interview!.panel_id}::uuid
    `

    const flagCount = await sql<Array<{ count: number }>>`
      SELECT fn_flag_stale_interviews(${fx.cycleId}::uuid) AS count
    `
    expect(Number(flagCount[0]!.count)).toBeGreaterThanOrEqual(1)

    const [flagged] = await sql<Array<{ status: string }>>`
      SELECT status FROM interviews WHERE id = ${interviewId}::uuid
    `
    expect(flagged!.status).toBe('flagged')
  })

  it('requeues at priority 100 when voided', async () => {
    // The interview failed through no fault of the applicant; making them queue from the back
    // would punish them for a device failure.
    const { interviewId, applicantId } = await stagedInterview('To Be Voided')

    await sql`
      SELECT fn_void_interview(${interviewId}::uuid, 'Panel tablet died mid-interview')
    `

    const [entry] = await sql<Array<{ state: string; priority: number }>>`
      SELECT state, priority FROM queue_entries WHERE applicant_id = ${applicantId}::uuid
    `
    expect(entry!.state).toBe('waiting')
    expect(Number(entry!.priority)).toBe(100)
  })
})

describe('Action Required (FR-OPS-005)', () => {
  it('surfaces flagged interviews above parked applicants', async () => {
    // Ranked by urgency: someone may be sitting in a room with a dead device.
    const rows = await sql<Array<{ urgency: number; kind: string }>>`
      SELECT * FROM fn_action_required(${fx.cycleId}::uuid)
    `

    expect(rows.length).toBeGreaterThan(0)

    const urgencies = rows.map((r) => Number(r.urgency))
    expect([...urgencies]).toEqual([...urgencies].sort((a, b) => a - b))
  })
})
