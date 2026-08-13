/**
 * POST /api/queue/:entryId/skip — the applicant did not arrive within the grace window.
 *
 * The soft-penalty policy lives in fn_expire_grace (migration 0016): first miss requeues at
 * priority 30 with enqueued_at backdated 10 minutes, second parks. Sending someone from
 * position 3 to position 40 over a two-minute absence provokes an argument at the desk that
 * costs more time than the delay did.
 *
 * Refs: FR-QUE-010, FR-QUE-011, FR-QUE-012
 */

import { NextResponse } from 'next/server'
import { withContext, expireGrace, RmsError } from '@sophep/backend'
import { requireStaff, hasCapability, unauthorized, forbidden, invalid } from '@/lib/auth/session'

export async function POST(req: Request, ctx: { params: Promise<{ entryId: string }> }) {
  const staff = await requireStaff()
  if (!staff) return unauthorized()

  // Was authenticated-only, so ANY staff member — an interviewer, a volunteer — could skip
  // anyone in the queue. Skipping applies a real penalty (requeue at priority 30, then park),
  // and R-032 requires capability at the API layer, not just in the database (audit H-5).
  if (!(await hasCapability(staff, 'queue.adjust_priority'))) {
    return forbidden('queue.adjust_priority')
  }

  const { entryId } = await ctx.params
  if (!isUuid(entryId)) return invalid('That queue entry id is not valid')

  try {
    const outcome = await withContext(staff.context, (tx) => expireGrace(tx, entryId))
    return NextResponse.json({ outcome })
  } catch (err) {
    if (err instanceof RmsError) {
      return NextResponse.json(err.toBody(), { status: err.status })
    }
    return NextResponse.json(
      { error: { code: 'INVALID_TRANSITION', message: 'Could not skip', retryable: true } },
      { status: 500 },
    )
  }
}

/**
 * Route params are attacker-controlled. Without this an arbitrary string reached a `::uuid`
 * cast and Postgres raised 22P02, which surfaced as an unexplained 500 rather than a 400 —
 * and put the offending value into the server log (NFR-MAIN-006).
 */
function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
}
