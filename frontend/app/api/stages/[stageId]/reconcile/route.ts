/**
 * Bulk reconciliation — the recovery path after a paper fallback (FR-CHK-017, FR-CHK-019).
 *
 * POST with `identifiers` (what a human typed) to resolve them WITHOUT checking anyone in, so
 * the Coordinator sees names before committing. POST with `applicantIds` and `confirm: true` to
 * actually check them in.
 *
 * The two-step shape is deliberate. Bulk-checking-in eighty people from a typed list is not an
 * action anyone should be able to take by accident, and a transcription slip that lands on the
 * wrong person is invisible unless the names are shown first.
 *
 * Thin handler (R-003).
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withContext, bulkReconcile, resolveDisplayIds, RmsError } from '@sophep/backend'
import { requireStaff, unauthorized, hasCapability, forbidden } from '@/lib/auth/session'

const bodySchema = z.union([
  z.object({
    identifiers: z.array(z.string().trim().min(1).max(64)).min(1).max(1000),
  }),
  z.object({
    applicantIds: z.array(z.string().uuid()).min(1).max(1000),
    confirm: z.literal(true),
  }),
])

export async function POST(req: Request, { params }: { params: Promise<{ stageId: string }> }) {
  const { stageId } = await params

  const staff = await requireStaff()
  if (!staff) return unauthorized()

  // Coordinator+, not volunteer. This writes many rows at once from a typed list; it is the one
  // check-in path with no applicant standing in front of anybody to notice a mistake.
  if (!(await hasCapability(staff, 'checkin.reconcile'))) {
    return forbidden('checkin.reconcile')
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_TRANSITION',
          message: parsed.error.issues[0]?.message ?? 'Invalid request',
          retryable: false,
        },
      },
      { status: 400 },
    )
  }

  try {
    const data = await withContext(staff.context, async (tx) => {
      const rows = await tx<Array<{ cycle_id: string }>>`
        SELECT cycle_id FROM stages WHERE id = ${stageId}::uuid
      `
      const cycleId = rows[0]?.cycle_id
      if (!cycleId) throw new RmsError('INVALID_TRANSITION', 'No such stage')

      if ('identifiers' in parsed.data) {
        // Preview only. Nothing is written.
        return resolveDisplayIds(tx, cycleId, parsed.data.identifiers)
      }

      return { results: await bulkReconcile(tx, stageId, parsed.data.applicantIds) }
    })

    return NextResponse.json(data)
  } catch (err) {
    if (err instanceof RmsError) {
      return NextResponse.json(err.toBody(), { status: err.status })
    }
    console.error('bulk reconcile failed', err)
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_TRANSITION',
          message: 'Reconciliation failed. Nobody was checked in — the paper roster is still the record.',
          retryable: true,
        },
      },
      { status: 500 },
    )
  }
}
