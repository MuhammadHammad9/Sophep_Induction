/**
 * GET /api/q/:token/status — the polling fallback for the applicant status page.
 *
 * Rate limited to 10/min/IP by middleware (FR-IDT-010). The page polls every 5 s with
 * exponential backoff, which stays inside that budget even while a connection is flapping.
 *
 * Everything is read through fn_applicant_status: one call, scoped by the token hash, named
 * columns only. Composing this from ordinary queries under applicant RLS is what produced the
 * silent empty-position bug that migration 0021 documents.
 *
 * Refs: FR-IDT-010, FR-QUE-015..019, NFR-PRIV-005
 */

import { NextResponse } from 'next/server'
import {
  withContext,
  hashToken,
  parseQrPayload,
  estimateWait,
  computeEwma,
  DEFAULT_WAIT_CONFIG,
} from '@sophep/backend'

interface StatusRow {
  applicant_id: string
  display_id: string
  applicant_state: string
  queue_entry_id: string | null
  queue_entry_state: string | null
  queue_position: number | null
  room_name: string | null
  called_at: Date | null
  grace_extended: boolean | null
  grace_window_minutes: number | null
  stage_running_minutes: number | null
  open_panels: number | null
  track_id: string | null
  cycle_id: string
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token: rawParam } = await ctx.params
  const parsed = parseQrPayload(rawParam)

  if (!parsed) {
    return NextResponse.json(
      { error: { code: 'TOKEN_INVALID', message: 'Invalid link', retryable: false } },
      { status: 404 },
    )
  }

  // The client tells us what it last displayed, so an INCREASE can be explained rather than
  // silently appearing (FR-QUE-017). Absent on first load, which is correct — the first
  // number shown is not a revision of anything.
  const url = new URL(req.url)
  const prevUpper = Number(url.searchParams.get('prevUpper'))
  const prevPanels = Number(url.searchParams.get('prevPanels'))

  const payload = await withContext({}, async (tx) => {
    const rows = await tx<StatusRow[]>`
      SELECT * FROM fn_applicant_status(${hashToken(parsed.token)}::bytea)
    `
    const row = rows[0]
    if (!row) return null

    const observations = row.track_id
      ? await tx<Array<{ duration_seconds: number }>>`
          SELECT duration_seconds FROM service_observations
           WHERE cycle_id = ${row.cycle_id}::uuid AND track_id = ${row.track_id}::uuid
           ORDER BY observed_at DESC LIMIT 50
        `
      : []

    // The defaults are already retuned for the committee's 10–30 minute interviews
    // (seed 20 min, α 0.2). Cycle config overrides them without a deployment (R-050).
    const serviceEwmaSeconds = computeEwma(
      observations.map((o) => Number(o.duration_seconds)).reverse(),
      DEFAULT_WAIT_CONFIG,
    )

    const estimate =
      row.queue_entry_state === 'waiting'
        ? estimateWait({
            position: row.queue_position ?? 1,
            activePanels: Number(row.open_panels ?? 0),
            serviceEwmaSeconds,
            stageRunningMinutes: Number(row.stage_running_minutes ?? 0),
            ...(Number.isFinite(prevUpper) && prevUpper > 0
              ? { previousUpperMinutes: prevUpper }
              : {}),
            ...(Number.isFinite(prevPanels) && prevPanels > 0
              ? { previousActivePanels: prevPanels }
              : {}),
          })
        : { kind: 'suppressed' as const, reason: 'almost_your_turn' as const, message: '' }

    return {
      state: row.applicant_state,
      displayId: row.display_id,
      position: row.queue_entry_state === 'waiting' ? row.queue_position : null,
      roomName: row.room_name,
      estimate,
      activePanels: Number(row.open_panels ?? 0),
      graceExpiresAt:
        row.called_at && row.grace_window_minutes
          ? new Date(
              new Date(row.called_at).getTime() + row.grace_window_minutes * 60_000,
            ).toISOString()
          : null,
      graceExtended: row.grace_extended ?? false,
    }
  })

  if (!payload) {
    // A revoked, expired or unknown token is a plain 404. Confirming that a token merely
    // expired tells an attacker their guess was structurally valid.
    return NextResponse.json(
      { error: { code: 'TOKEN_INVALID', message: 'Invalid link', retryable: false } },
      { status: 404 },
    )
  }

  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
