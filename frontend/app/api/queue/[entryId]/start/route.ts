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
import { requireStaff, unauthorized } from '@/lib/auth/session'

export async function POST(req: Request, ctx: { params: Promise<{ entryId: string }> }) {
  const staff = await requireStaff(req)
  if (!staff) return unauthorized()

  const { entryId } = await ctx.params

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
