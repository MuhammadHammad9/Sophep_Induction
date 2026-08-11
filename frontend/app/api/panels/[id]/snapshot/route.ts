/**
 * GET /api/panels/:id/snapshot — panel status and queue depth.
 *
 * Feeds the panel screen's idle and blocked states. Includes the PARKED count because
 * FR-QUE-013 requires panels to see it: otherwise a panel sits idle believing the queue is
 * empty while applicants wait fifteen metres away.
 */

import { NextResponse } from 'next/server'
import { withContext, getPanelSnapshot } from '@sophep/backend'
import { requireStaff, unauthorized } from '@/lib/auth/session'

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff(req)
  if (!staff) return unauthorized()

  const { id: panelId } = await ctx.params

  const snapshot = await withContext(staff.context, async (tx) => {
    return await getPanelSnapshot(tx, panelId)
  })

  if (!snapshot) {
    return NextResponse.json(
      { error: { code: 'INVALID_TRANSITION', message: 'Panel not found', retryable: false } },
      { status: 404 },
    )
  }

  return NextResponse.json(snapshot)
}
