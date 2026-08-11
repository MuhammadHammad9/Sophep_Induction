/**
 * POST /api/panels/:id/call-next — the atomic claim.
 *
 * Thin handler (R-003). The claim, its ordering, the recusal exclusion and the panel-state
 * gate all live in fn_claim_next (migration 0016) — this converts outcomes to HTTP.
 *
 * Refs: FR-QUE-001, FR-QUE-002, FR-QUE-013, FR-INT-013
 */

import { NextResponse } from 'next/server'
import { withContext, callNext, RmsError } from '@sophep/backend'
import { requireStaff, hasCapability, unauthorized, forbidden } from '@/lib/auth/session'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff(req)
  if (!staff) return unauthorized()

  if (!(await hasCapability(staff, 'queue.call_next'))) {
    return forbidden('queue.call_next')
  }

  const { id: panelId } = await ctx.params

  try {
    const claimed = await withContext(staff.context, (tx) => callNext(tx, panelId))

    // Genuinely empty is NOT an error. FR-QUE-013: the panel screen shows the waiting count
    // and, if any, the parked count so volunteers know to go and find those people — rather
    // than a failure message that suggests something is broken.
    if (!claimed) {
      return NextResponse.json({ outcome: 'queue_empty' }, { status: 200 })
    }

    return NextResponse.json({ outcome: 'called', applicant: claimed }, { status: 200 })
  } catch (err) {
    if (err instanceof RmsError) {
      return NextResponse.json(err.toBody(), { status: err.status })
    }
    console.error('call-next failed', err)
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_TRANSITION',
          message: 'Could not call the next applicant',
          retryable: true,
        },
      },
      { status: 500 },
    )
  }
}
