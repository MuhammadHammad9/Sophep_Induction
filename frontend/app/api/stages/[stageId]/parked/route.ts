/**
 * GET /api/stages/:stageId/parked — how many people are parked at this stage.
 *
 * FR-QUE-013: panels must see the parked count, or a panel sits idle believing the queue is
 * empty while applicants wait fifteen metres away.
 *
 * Three defects, all small and all the kind that only bite under pressure (audit H-5):
 *   - no capability check, only authentication;
 *   - `{ error: 'Unauthorized' }` and `{ error: 'Failed to fetch' }` as bare strings, which is
 *     not the IR-002 shape any client can act on (R-057);
 *   - `stageId` interpolated straight into a `::uuid` cast, so a non-UUID produced an
 *     unhandled 22P02 and a 500 instead of a 400.
 */

import { NextResponse } from 'next/server'
import { withContext } from '@sophep/backend'
import {
  requireStaff,
  hasCapability,
  unauthorized,
  forbidden,
  invalid,
} from '@/lib/auth/session'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ stageId: string }> },
) {
  const staff = await requireStaff()
  if (!staff) return unauthorized()

  if (!(await hasCapability(staff, 'applicant.view'))) {
    return forbidden('applicant.view')
  }

  const { stageId } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stageId)) {
    return invalid('That stage id is not valid')
  }

  try {
    const data = await withContext(staff.context, async (tx) => {
      // Scoped to the caller's cycle as well as the stage. RLS on queue_entries already
      // restricts this, but a stage id from another cycle should read as "nothing here"
      // rather than silently relying on the policy to make the count come out zero.
      const rows = await tx<Array<{ parked_count: string }>>`
        SELECT count(*) AS parked_count
          FROM queue_entries q
          JOIN tracks t ON t.id = q.track_id
          JOIN stages s ON s.id = t.stage_id
         WHERE s.id = ${stageId}::uuid
           AND s.cycle_id = ${staff.cycleId}::uuid
           AND q.state = 'parked'
      `
      return { parked: Number(rows[0]?.parked_count ?? 0) }
    })

    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('failed to fetch parked count', err)
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_TRANSITION',
          message: 'Could not read the parked count',
          // Retryable: this is a count on a panel screen, and a transient failure should
          // resolve itself on the next poll rather than needing a human.
          retryable: true,
        },
      },
      { status: 500 },
    )
  }
}
