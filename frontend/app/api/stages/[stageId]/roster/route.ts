/**
 * GET /api/stages/:stageId/roster — the offline bundle a check-in device caches.
 *
 * Keyed by STAGE rather than by cycle (the spec's path is `/api/cycles/:id/roster`) because a
 * device is opened on a stage and never on a cycle; the cycle is derived here. Same data, one
 * fewer thing for a volunteer to get wrong at 8am.
 *
 * Thin handler (R-003): authenticate, delegate, cache-control.
 *
 * Refs: FR-CHK-012, FR-CHK-018, NFR-PERF-009
 */

import { NextResponse } from 'next/server'
import { withContext, buildRosterBundle } from '@sophep/backend'
import { requireStaff, unauthorized, hasCapability, forbidden } from '@/lib/auth/session'

export async function GET(_req: Request, { params }: { params: Promise<{ stageId: string }> }) {
  const { stageId } = await params

  const staff = await requireStaff()
  if (!staff) return unauthorized()

  // volunteer+ — the same people who run the desk. The bundle carries names, so it is not
  // public, but withholding it from the volunteers who need it would just mean no offline mode.
  if (!(await hasCapability(staff, 'checkin.perform'))) {
    return forbidden('checkin.perform')
  }

  try {
    const bundle = await withContext(staff.context, async (tx) => {
      const rows = await tx<Array<{ cycle_id: string }>>`
        SELECT cycle_id FROM stages WHERE id = ${stageId}::uuid
      `
      const cycleId = rows[0]?.cycle_id
      if (!cycleId) return null

      return buildRosterBundle(tx, cycleId, stageId)
    })

    if (!bundle) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'No such stage', retryable: false } },
        { status: 404 },
      )
    }

    return NextResponse.json(bundle, {
      headers: {
        // Never cached by anything in between. This body carries applicant names, and a shared
        // cache is exactly the sort of place they must not accumulate (NFR-PRIV-006).
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    console.error('roster bundle failed', err)
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_TRANSITION',
          message: 'Could not build the offline roster. Retry while you still have signal.',
          retryable: true,
        },
      },
      { status: 500 },
    )
  }
}
