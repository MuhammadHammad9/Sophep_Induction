/**
 * POST /api/queue/:entryId/start — the applicant arrived; begin the interview.
 *
 * Creates the interview row and moves the queue entry to in_interview in one transaction, so
 * an applicant can never be simultaneously "waiting" and "being interviewed".
 *
 * Refs: FR-INT-001, spec §5.2
 */

import { NextResponse } from 'next/server'
import { withContext, startInterview, RmsError } from '@sophep/backend'
import { requireStaff, hasCapability, unauthorized, forbidden, invalid } from '@/lib/auth/session'

export async function POST(req: Request, ctx: { params: Promise<{ entryId: string }> }) {
  const staff = await requireStaff()
  if (!staff) return unauthorized()

  // Starting an interview is the panel's action. `queue.call_next` is the capability the
  // claiming roles already hold, and it is the same set that should be able to say the person
  // arrived (audit H-5).
  if (!(await hasCapability(staff, 'queue.call_next'))) {
    return forbidden('queue.call_next')
  }

  const { entryId } = await ctx.params
  if (!isUuid(entryId)) return invalid('That queue entry id is not valid')

  try {
    const interviewId = await withContext(staff.context, (tx) => startInterview(tx, entryId))
    return NextResponse.json({ interviewId }, { status: 201 })
  } catch (err) {
    if (err instanceof RmsError) {
      return NextResponse.json(err.toBody(), { status: err.status })
    }
    return NextResponse.json(
      { error: { code: 'INVALID_TRANSITION', message: 'Could not start', retryable: true } },
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
