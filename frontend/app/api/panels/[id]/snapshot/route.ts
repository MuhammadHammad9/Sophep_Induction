/**
 * GET /api/panels/:id/snapshot — panel status and queue depth.
 *
 * Feeds the panel screen's idle and blocked states. Includes the PARKED count because
 * FR-QUE-013 requires panels to see it: otherwise a panel sits idle believing the queue is
 * empty while applicants wait fifteen metres away.
 */

import { NextResponse } from 'next/server'
import { withContext, getPanelSnapshot } from '@sophep/backend'
import {
  requireStaff,
  hasCapability,
  unauthorized,
  forbidden,
  invalid,
} from '@/lib/auth/session'

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff()
  if (!staff) return unauthorized()

  // Was authenticated-only. The snapshot carries queue depth and panel state, which is not
  // catastrophic to leak — but R-032 puts capability at the API layer for every endpoint, and
  // "this one is not very sensitive" is how the exceptions start (audit H-5).
  if (!(await hasCapability(staff, 'applicant.view'))) {
    return forbidden('applicant.view')
  }

  const { id: panelId } = await ctx.params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(panelId)) {
    return invalid('That panel id is not valid')
  }

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
