/**
 * GET /api/panels/:id/snapshot — panel status and queue depth.
 *
 * Feeds the panel screen's idle and blocked states. Includes the PARKED count because
 * FR-QUE-013 requires panels to see it: otherwise a panel sits idle believing the queue is
 * empty while applicants wait fifteen metres away.
 */

import { NextResponse } from 'next/server'
import { withContext } from '@sophep/backend'
import { requireStaff, unauthorized } from '@/lib/auth/session'

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff(req)
  if (!staff) return unauthorized()

  const { id: panelId } = await ctx.params

  const snapshot = await withContext(staff.context, async (tx) => {
    const panels = await tx<Array<{ status: string; cycle_id: string }>>`
      SELECT status, cycle_id FROM panels WHERE id = ${panelId}::uuid
    `
    const panel = panels[0]
    if (!panel) return null

    // Counts scoped to the tracks THIS panel serves — a shared "waiting" number across
    // unrelated tracks would tell an interviewer their queue is busy when it is not.
    const counts = await tx<Array<{ waiting: string; parked: string }>>`
      SELECT
        count(*) FILTER (WHERE q.state = 'waiting') AS waiting,
        count(*) FILTER (WHERE q.state = 'parked')  AS parked
        FROM queue_entries q
       WHERE q.track_id IN (SELECT track_id FROM panel_tracks WHERE panel_id = ${panelId}::uuid)
    `

    // FR-INT-013: name who is outstanding, so the screen can explain rather than just refuse.
    const outstanding =
      panel.status === 'awaiting_evaluations'
        ? await tx<Array<{ full_name: string }>>`
            SELECT u.full_name
              FROM panel_members pm
              JOIN users u ON u.id = pm.interviewer_id
             WHERE pm.panel_id = ${panelId}::uuid AND pm.left_at IS NULL
          `
        : []

    return {
      status: panel.status,
      waiting: Number(counts[0]?.waiting ?? 0),
      parked: Number(counts[0]?.parked ?? 0),
      blockedBy: outstanding.map((o) => o.full_name),
    }
  })

  if (!snapshot) {
    return NextResponse.json(
      { error: { code: 'INVALID_TRANSITION', message: 'Panel not found', retryable: false } },
      { status: 404 },
    )
  }

  return NextResponse.json(snapshot)
}
