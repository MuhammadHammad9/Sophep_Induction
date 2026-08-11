/**
 * GET /api/applicants/search — manual check-in fallback.
 *
 * FR-CHK-009: search on any 4 consecutive digits of the identifier, the last 4 digits of the
 * phone number, or a partial name. This runs when a camera has failed or a screen is cracked,
 * so it must work from whatever the volunteer can read off a slip or hear across a desk.
 *
 * Results are scoped by RLS to the caller's cycle — a volunteer cannot enumerate another
 * cycle's applicants even by guessing.
 */

import { NextResponse } from 'next/server'
import { withContext, searchApplicants } from '@sophep/backend'
import { requireStaff, hasCapability, unauthorized, forbidden } from '@/lib/auth/session'

export async function GET(req: Request) {
  const staff = await requireStaff(req)
  if (!staff) return unauthorized()

  if (!(await hasCapability(staff, 'checkin.perform'))) {
    return forbidden('checkin.perform')
  }

  const url = new URL(req.url)
  const q = url.searchParams.get('q')?.trim() ?? ''

  // Below two characters the result set is most of the cohort, which is slower to scan than
  // retyping and encourages picking the wrong person under pressure.
  if (q.length < 2) return NextResponse.json([])

  const results = await withContext(staff.context, (tx) =>
    searchApplicants(tx, staff.cycleId, q, 20),
  )

  return NextResponse.json(results)
}
