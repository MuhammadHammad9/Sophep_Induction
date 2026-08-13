/**
 * POST /api/q/:token/on-my-way — the one-time grace extension.
 *
 * FR-QUE-009: +2 minutes, exactly once per call. Enforced in fn_extend_grace, not here — an
 * applicant refreshing the page must not be able to extend indefinitely.
 *
 * Worth the code: each avoided skip is an argument that never happens at the desk.
 */

import { NextResponse } from 'next/server'
import { withContext, hashToken, extendGrace, parseQrPayload, RmsError } from '@sophep/backend'

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token: rawParam } = await ctx.params
  const parsed = parseQrPayload(rawParam)
  if (!parsed) {
    return NextResponse.json(
      { error: { code: 'TOKEN_INVALID', message: 'Invalid link', retryable: false } },
      { status: 404 },
    )
  }

  try {
    let applicantId: string | undefined
    await withContext({}, async (tx) => {
      const resolved = await tx<Array<{ applicant_id: string }>>`
        SELECT applicant_id FROM fn_resolve_token(${hashToken(parsed.token)}::bytea)
      `
      applicantId = resolved[0]?.applicant_id
    })

    if (!applicantId) throw new RmsError('TOKEN_INVALID', 'Invalid link')

    // Narrowed once here so the closure below sees a definite string.
    const resolvedApplicantId: string = applicantId

    await withContext({ applicantId: resolvedApplicantId }, async (tx) => {
      const entries = await tx<Array<{ id: string }>>`
        SELECT id FROM queue_entries
         WHERE applicant_id = ${resolvedApplicantId}::uuid AND state = 'called'
         ORDER BY called_at DESC LIMIT 1
      `
      const entryId = entries[0]?.id
      if (!entryId) throw new RmsError('INVALID_TRANSITION', 'You have not been called yet')

      await extendGrace(tx, entryId)
    })

    return NextResponse.json({ extended: true })
  } catch (err) {
    if (err instanceof RmsError) {
      return NextResponse.json(err.toBody(), { status: err.status })
    }
    return NextResponse.json(
      { error: { code: 'INVALID_TRANSITION', message: 'Could not extend', retryable: false } },
      { status: 500 },
    )
  }
}
