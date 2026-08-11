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
import { requireStaff, unauthorized } from '@/lib/auth/session'

export async function POST(req: Request, ctx: { params: Promise<{ entryId: string }> }) {
  const staff = await requireStaff(req)
  if (!staff) return unauthorized()

  const { entryId } = await ctx.params

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
