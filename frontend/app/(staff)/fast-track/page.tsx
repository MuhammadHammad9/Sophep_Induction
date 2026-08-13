/**
 * Fast-track: register a walk-in and put them in the queue, at the desk, in one pass.
 *
 * This page was unauthenticated. Worse than merely being reachable, it ran its cycle and stage
 * lookup under an EMPTY security context and then handed both ids to the client — so it did not
 * just fail to stop an attacker, it told them exactly which cycle and stage to target
 * (audit C-1).
 *
 * It now resolves everything under the CALLER's context. That is the meaningful change: with
 * `staff.context` bound, the `cycles` and `stages` reads are subject to `cycle_member_select`
 * and `stage_member_select`, so a volunteer sees the cycle they belong to and nothing else.
 * The gate below produces a clear redirect; RLS is what actually holds (R-032).
 *
 * Refs: FR-CHK-010, FR-RBAC-004, rules.md R-032, R-058, audit C-1
 */

import { redirect } from 'next/navigation'
import { withContext } from '@sophep/backend'
import { requireStaff, hasCapability, mfaRedirect } from '@/lib/auth/session'
import { FastTrackForm } from './FastTrackForm'

export const dynamic = 'force-dynamic'

interface StageTarget {
  cycleId: string
  cycleName: string
  stageId: string
}

export default async function FastTrackPage() {
  const staff = await requireStaff()
  if (!staff) redirect('/staff/sign-in?next=/fast-track')
  
  // FR-RBAC-008: a privileged surface needs the second factor, not just a session.
  const mfa = mfaRedirect(staff, '/fast-track')
  if (mfa) redirect(mfa)

  // Both, matching the API route. A page that renders a form the endpoint will refuse is a
  // dead control, which R-058 treats as a defect rather than a style choice.
  const canRegister = await hasCapability(staff, 'applicant.register')
  const canCheckIn = await hasCapability(staff, 'checkin.perform')

  if (!canRegister || !canCheckIn) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <h1 className="text-h1">Fast-track is not available to your role</h1>
        <p className="mt-2 text-text-muted">
          Registering a walk-in and checking them in needs both{' '}
          <span className="id-text">applicant.register</span> and{' '}
          <span className="id-text">checkin.perform</span>. Your account is missing{' '}
          <span className="id-text">{!canRegister ? 'applicant.register' : 'checkin.perform'}</span>.
        </p>
        <p className="mt-2 text-text-muted">
          A Coordinator can grant this. In the meantime, send the applicant to a desk that has it.
        </p>
      </div>
    )
  }

  // Scoped to the caller's cycle rather than "the first open cycle anywhere". Two societies on
  // one deployment would otherwise cross-contaminate, and the previous LIMIT 1 over all cycles
  // picked an arbitrary one.
  const target = await withContext(staff.context, async (tx): Promise<StageTarget | null> => {
    // `stages` HAS NO `state` OR `start_time` COLUMN.
    //
    // It carries `starts_at`, `ends_at` and `closed_at`, and "active" is derived from them —
    // there is no status field to compare against. The previous query said
    // `s.state = 'active'` and `ORDER BY s.start_time`, both of which raise
    // `column does not exist` at runtime, so this page returned a 500 for every authenticated
    // staff member. It could not have been caught by typecheck (the SQL is a template string)
    // and was not caught by any test, because nothing had ever loaded this page while signed
    // in — the signed-in flow was the one gap in the browser suite.
    //
    // An open stage is one that has started and has not been closed. `ends_at` is the planned
    // finish; a stage running late is still open until somebody closes it, which is the
    // behaviour the floor actually needs (FR-OPS-006).
    const rows = await tx<Array<{ cycle_id: string; cycle_name: string; stage_id: string }>>`
      SELECT c.id AS cycle_id, c.name AS cycle_name, s.id AS stage_id
        FROM cycles c
        JOIN stages s ON s.cycle_id = c.id
       WHERE c.id = ${staff.cycleId}::uuid
         AND c.state IN ('registration_open', 'interviews_active')
         AND s.closed_at IS NULL
         AND s.starts_at <= now()
       ORDER BY s.starts_at DESC
       LIMIT 1
    `
    const row = rows[0]
    return row ? { cycleId: row.cycle_id, cycleName: row.cycle_name, stageId: row.stage_id } : null
  })

  if (!target) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <h1 className="text-h1">No active stage</h1>
        <p className="mt-2 text-text-muted">
          Fast-track registration is only available while a check-in stage is active. Nothing is
          running in this cycle right now.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="text-h1">Fast-Track</h1>
      <p className="mt-1 text-text-muted">
        Walk-in registration and check-in — {target.cycleName}
      </p>

      <div className="mt-8">
        <FastTrackForm cycleId={target.cycleId} stageId={target.stageId} />
      </div>
    </div>
  )
}
