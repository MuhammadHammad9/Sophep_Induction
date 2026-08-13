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
import { withContext, searchApplicants, applicantSearchSchema } from '@sophep/backend'
import { requireStaff, hasCapability, unauthorized, forbidden } from '@/lib/auth/session'

export async function GET(req: Request) {
  const staff = await requireStaff()
  if (!staff) return unauthorized()

  if (!(await hasCapability(staff, 'checkin.perform'))) {
    return forbidden('checkin.perform')
  }

  const url = new URL(req.url)

  // `applicantSearchSchema` already encodes these rules and was going unused: the route
  // hand-rolled the minimum length and never bounded the maximum, so an unbounded string
  // reached the trigram search (audit M-13). Validating through the schema keeps the client
  // and the server agreeing about what a search is, which is the same reason the registration
  // form shares its schema.
  const parsed = applicantSearchSchema.safeParse({
    cycleId: staff.cycleId,
    q: url.searchParams.get('q') ?? '',
    limit: Number(url.searchParams.get('limit') ?? 20),
  })

  // Below two characters the result set is most of the cohort, which is slower to scan than
  // retyping and encourages picking the wrong person under pressure. An empty array rather
  // than a 400: the volunteer is mid-word, not in error.
  if (!parsed.success) return NextResponse.json([])

  const results = await withContext(staff.context, (tx) =>
    searchApplicants(tx, staff.cycleId, parsed.data.q, parsed.data.limit),
  )

  return NextResponse.json(results)
}
