/**
 * Queue operations.
 *
 * Thin wrappers over the SECURITY DEFINER functions in migration 0016. The state machine lives
 * in the database on purpose — it must hold for a direct SQL caller, a background job and a
 * route handler alike, not only for code that remembers to check.
 *
 * Refs: FR-QUE-001..020, FR-CHK-011
 */

import type { Tx } from './db'
import { RmsError, fromPostgresError } from '../domain/errors'
import {
  estimateWait,
  computeEwma,
  DEFAULT_WAIT_CONFIG,
  type WaitEstimate,
  type WaitEstimateConfig,
} from '../domain/waitEstimate'

export interface ClaimedApplicant {
  queueEntryId: string
  applicantId: string
  displayId: string
  fullName: string
  roomName: string
  calledAt: Date
  callCount: number
  graceExpiresAt: Date
}

/**
 * Call Next.
 *
 * Returns `null` when the queue is genuinely empty — a distinct condition from an error, and
 * the panel screen must say "nobody waiting" rather than showing a failure (FR-QUE-013).
 */
export async function callNext(tx: Tx, panelId: string): Promise<ClaimedApplicant | null> {
  try {
    const rows = await tx<
      Array<{
        id: string | null
        applicant_id: string
        display_id: string
        full_name: string
        room_name: string
        called_at: Date
        call_count: number
        grace_minutes: number
      }>
    >`
      WITH claimed AS (
        SELECT * FROM fn_claim_next(${panelId}::uuid)
      )
      SELECT c.id, c.applicant_id, a.display_id, a.full_name,
             r.name AS room_name, c.called_at, c.call_count,
             coalesce((cy.config ->> 'grace_window_minutes')::int, 5) AS grace_minutes
        FROM claimed c
        JOIN applicants a ON a.id = c.applicant_id
        JOIN cycles     cy ON cy.id = c.cycle_id
        JOIN panels     p ON p.id = ${panelId}::uuid
        JOIN rooms      r ON r.id = p.room_id
       WHERE c.id IS NOT NULL
    `

    const row = rows[0]
    if (!row?.id) return null

    return {
      queueEntryId: row.id,
      applicantId: row.applicant_id,
      displayId: row.display_id,
      fullName: row.full_name,
      roomName: row.room_name,
      calledAt: row.called_at,
      callCount: Number(row.call_count),
      graceExpiresAt: new Date(row.called_at.getTime() + row.grace_minutes * 60_000),
    }
  } catch (err) {
    const mapped = fromPostgresError(err)
    if (mapped) throw mapped

    const message = (err as { message?: string })?.message ?? ''
    if (message.includes('PANEL_AWAITING_EVALUATIONS')) {
      // FR-INT-013 / R-058: the caller must be able to say WHICH interviewer is outstanding.
      // A disabled button with no explanation is a defect, so the code carries enough for the
      // UI to go and look that up.
      throw new RmsError('STAGE_HAS_ACTIVE_INTERVIEWS', 'Submit the outstanding evaluation first')
    }
    if (message.includes('PANEL_NOT_OPEN')) {
      throw new RmsError('INVALID_TRANSITION', 'This panel is not open')
    }
    throw err
  }
}

export async function startInterview(tx: Tx, queueEntryId: string): Promise<string> {
  const rows = await tx<Array<{ id: string }>>`
    WITH moved AS (
      SELECT * FROM fn_queue_transition(${queueEntryId}::uuid, 'in_interview'::queue_state)
    )
    INSERT INTO interviews (cycle_id, applicant_id, panel_id, queue_entry_id, status)
    SELECT m.cycle_id, m.applicant_id, m.panel_id, m.id, 'in_progress'
      FROM moved m
    RETURNING id
  `
  const id = rows[0]?.id
  if (!id) throw new Error('failed to start interview')
  return id
}

/** Grace expiry: first miss requeues at priority 30, second parks (FR-QUE-010..012). */
export async function expireGrace(tx: Tx, queueEntryId: string): Promise<'requeued' | 'parked'> {
  const rows = await tx<Array<{ state: string }>>`
    SELECT state FROM fn_expire_grace(${queueEntryId}::uuid)
  `
  return rows[0]?.state === 'parked' ? 'parked' : 'requeued'
}

export async function extendGrace(tx: Tx, queueEntryId: string): Promise<void> {
  try {
    await tx`SELECT fn_extend_grace(${queueEntryId}::uuid)`
  } catch (err) {
    const message = (err as { message?: string })?.message ?? ''
    if (message.includes('GRACE_ALREADY_EXTENDED')) {
      throw new RmsError('INVALID_TRANSITION', 'You have already used your extra time')
    }
    const mapped = fromPostgresError(err)
    if (mapped) throw mapped
    throw err
  }
}

export async function reactivateParked(
  tx: Tx,
  queueEntryId: string,
  reason?: string,
): Promise<void> {
  await tx`SELECT fn_reactivate_parked(${queueEntryId}::uuid, ${reason ?? null})`
}

export async function setPriority(
  tx: Tx,
  queueEntryId: string,
  priority: 5 | 10 | 30 | 50 | 100,
  reason: string,
): Promise<void> {
  await tx`SELECT fn_set_priority(${queueEntryId}::uuid, ${priority}::smallint, ${reason})`
}

// ── Live queue state ────────────────────────────────────────────────────────────────────

export interface TrackSnapshot {
  trackId: string
  waiting: number
  called: number
  inInterview: number
  parked: number
  openPanels: number
  serviceEwmaSeconds: number
}

export async function trackSnapshot(
  tx: Tx,
  cycleId: string,
  trackId: string,
  config: WaitEstimateConfig = DEFAULT_WAIT_CONFIG,
): Promise<TrackSnapshot> {
  const [counts] = await tx<
    Array<{ waiting: string; called: string; in_interview: string; parked: string }>
  >`
    SELECT
      count(*) FILTER (WHERE state = 'waiting')      AS waiting,
      count(*) FILTER (WHERE state = 'called')       AS called,
      count(*) FILTER (WHERE state = 'in_interview') AS in_interview,
      count(*) FILTER (WHERE state = 'parked')       AS parked
    FROM queue_entries
   WHERE cycle_id = ${cycleId}::uuid AND track_id = ${trackId}::uuid
  `

  const [panels] = await tx<Array<{ open_panels: string }>>`
    SELECT count(*) AS open_panels
      FROM panels p JOIN panel_tracks pt ON pt.panel_id = p.id
     WHERE pt.track_id = ${trackId}::uuid AND p.status IN ('open', 'busy')
  `

  // Most recent observations first, then reversed: the EWMA must fold oldest → newest or the
  // weighting is backwards and the "latest" reading ends up with the least influence.
  const observations = await tx<Array<{ duration_seconds: number }>>`
    SELECT duration_seconds FROM service_observations
     WHERE cycle_id = ${cycleId}::uuid AND track_id = ${trackId}::uuid
     ORDER BY observed_at DESC
     LIMIT 50
  `

  return {
    trackId,
    waiting: Number(counts?.waiting ?? 0),
    called: Number(counts?.called ?? 0),
    inInterview: Number(counts?.in_interview ?? 0),
    parked: Number(counts?.parked ?? 0),
    openPanels: Number(panels?.open_panels ?? 0),
    serviceEwmaSeconds: computeEwma(
      observations.map((o) => Number(o.duration_seconds)).reverse(),
      config,
    ),
  }
}

/** Position by the SAME ordering the claim uses — any other would show a number the queue ignores. */
export async function queuePosition(tx: Tx, queueEntryId: string): Promise<number | null> {
  const [row] = await tx<Array<{ position: string }>>`
    WITH me AS (
      SELECT track_id, priority, enqueued_at, state
        FROM queue_entries WHERE id = ${queueEntryId}::uuid
    )
    SELECT (SELECT count(*) + 1
              FROM queue_entries q
             WHERE q.track_id = me.track_id
               AND q.state = 'waiting'
               AND (q.priority > me.priority
                    OR (q.priority = me.priority AND q.enqueued_at < me.enqueued_at))) AS position
      FROM me
     WHERE me.state = 'waiting'
  `
  return row ? Number(row.position) : null
}

export interface ApplicantWaitView {
  position: number | null
  estimate: WaitEstimate
}

export async function applicantWait(
  tx: Tx,
  queueEntryId: string,
  stageRunningMinutes: number,
  previous?: { upperMinutes: number; activePanels: number },
): Promise<ApplicantWaitView> {
  const [entry] = await tx<Array<{ cycle_id: string; track_id: string }>>`
    SELECT cycle_id, track_id FROM queue_entries WHERE id = ${queueEntryId}::uuid
  `
  if (!entry) return { position: null, estimate: { kind: 'suppressed', reason: 'no_open_panel', message: 'We’ll call you shortly.' } }

  const position = await queuePosition(tx, queueEntryId)
  const snapshot = await trackSnapshot(tx, entry.cycle_id, entry.track_id)

  return {
    position,
    estimate: estimateWait({
      position: position ?? 1,
      activePanels: snapshot.openPanels,
      serviceEwmaSeconds: snapshot.serviceEwmaSeconds,
      stageRunningMinutes,
      ...(previous ? { previousUpperMinutes: previous.upperMinutes, previousActivePanels: previous.activePanels } : {}),
    }),
  }
}
