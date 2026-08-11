/**
 * POST /api/interviews/:interviewId/evaluations — submit an evaluation.
 *
 * Thin handler (R-003). The weighted score is computed by fn_submit_evaluation from the
 * criterion scores; the client never supplies a score, because a caller-supplied score is a
 * caller-chosen outcome.
 *
 * Refs: FR-INT-008, FR-INT-020, FR-SCR-001
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withContext, RmsError, fromPostgresError } from '@sophep/backend'
import { requireStaff, hasCapability, unauthorized, forbidden } from '@/lib/auth/session'

const bodySchema = z.object({
  scores: z
    .array(z.object({ criterionId: z.string().uuid(), score: z.number().int() }))
    .min(1),
  remarks: z.string().trim().max(4000).nullable().optional(),
  recommendedDepartmentId: z.string().uuid().nullable().optional(),
})

export async function POST(req: Request, ctx: { params: Promise<{ interviewId: string }> }) {
  const staff = await requireStaff(req)
  if (!staff) return unauthorized()

  if (!(await hasCapability(staff, 'evaluation.submit'))) {
    return forbidden('evaluation.submit')
  }

  const { interviewId } = await ctx.params

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
    const result = await withContext(staff.context, async (tx) => {
      const rows = await tx<Array<{ id: string; raw_score: string }>>`
        SELECT id, raw_score FROM fn_submit_evaluation(
          ${interviewId}::uuid,
          ${staff.userId}::uuid,
          ${tx.json(
            parsed.data.scores.map((s) => ({ criterion_id: s.criterionId, score: s.score })),
          )}::jsonb,
          ${parsed.data.remarks ?? null},
          ${parsed.data.recommendedDepartmentId ?? null}::uuid
        )
      `
      return rows[0]
    })

    // The raw score is deliberately NOT returned. FR-INT-004: an interviewer must not see an
    // aggregate, and their own computed total is the first step towards calibrating against
    // one — which is exactly what blind evaluation exists to prevent.
    return NextResponse.json({ evaluationId: result?.id, submitted: true }, { status: 201 })
  } catch (err) {
    const mapped = err instanceof RmsError ? err : fromPostgresError(err)
    if (mapped) {
      return NextResponse.json(mapped.toBody(), { status: mapped.status })
    }

    const message = (err as { message?: string })?.message ?? ''
    if (/every criterion must be scored|outside the rubric scale|already submitted|not a member/.test(message)) {
      return NextResponse.json(
        {
          error: {
            code: 'INVALID_TRANSITION',
            message: message.replace(/^[A-Z_]+:\s*/, ''),
            retryable: false,
          },
        },
        { status: 409 },
      )
    }

    console.error('evaluation submit failed', err)
    return NextResponse.json(
      { error: { code: 'INVALID_TRANSITION', message: 'Could not submit', retryable: true } },
      { status: 500 },
    )
  }
}
