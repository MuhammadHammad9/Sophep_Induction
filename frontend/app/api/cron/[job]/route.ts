/**
 * GET /api/cron/hourly · /api/cron/nightly — the scheduled work, triggered by Vercel Cron.
 *
 * Thin handler (R-003): authenticate the trigger, delegate, report.
 *
 * Authentication is a shared secret in the Authorization header, compared in constant time.
 * Vercel sends `Authorization: Bearer $CRON_SECRET`. Without this check the endpoint is an
 * unauthenticated way for anyone on the internet to expire every pending offer in the system.
 *
 * Refs: FR-OFF-003, FR-OPS-003, NFR-SEC-001
 */

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { runHourlyJobs, runNightlyJobs } from '@sophep/backend'

// Long enough for a full cascade pass across every department.
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ job: string }> }) {
  const { job } = await params

  const secret = process.env['CRON_SECRET']
  if (!secret) {
    // Fail CLOSED. A missing secret must never mean "no authentication required" — that is the
    // shape of every accidental public endpoint (R-014).
    console.error('CRON_SECRET is not set; refusing to run scheduled jobs')
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  const provided = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${secret}`
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const reports =
      job === 'hourly'
        ? await runHourlyJobs()
        : job === 'nightly'
          ? await runNightlyJobs()
          : null

    if (!reports) {
      return NextResponse.json({ error: 'Unknown job' }, { status: 404 })
    }

    // Reported rather than merely logged, so a failing cycle is visible in the cron history
    // instead of being buried in a 200 that says nothing.
    const failed = reports.filter((r) => r.errors.length > 0)
    return NextResponse.json(
      { job, cycles: reports.length, reports },
      { status: failed.length > 0 ? 500 : 200 },
    )
  } catch (err) {
    console.error(`cron ${job} failed`, err)
    return NextResponse.json({ error: 'Job failed' }, { status: 500 })
  }
}
