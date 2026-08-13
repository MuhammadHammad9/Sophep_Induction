/**
 * GET /api/live — authenticated server-sent events.
 *
 * ── WHY THIS EXISTS INSTEAD OF SUPABASE REALTIME ────────────────────────────────────────
 *
 * The audit (H-9) found that the Realtime path could not work and was dishonest about it.
 * `postgres_changes` applies RLS using the SUBSCRIBER'S JWT, while every policy in this schema
 * authorises through `fn_current_user_id()` — which reads the transaction-local `app.user_id`
 * bound by `withContext`. A websocket has no transaction and cannot set it, so every policy
 * denies and the subscription delivers nothing. Meanwhile the client rendered "Live".
 *
 * Showing a live badge over a feed that is structurally empty is the exact failure design
 * principle 2 and R-026 exist to forbid, and it is recorded as errata E11.
 *
 * The alternative was Supabase Realtime Authorization (`realtime.messages` policies), which
 * means maintaining a SECOND authorisation model, in the platform, that has to agree with the
 * one in `role_capabilities` forever. Two sources of truth for "who may see this" is the shape
 * of problem this codebase already fixed once (E5, single-writer state).
 *
 * SSE has none of that. It is an ordinary authenticated HTTP request, so `requireStaff` and
 * `withContext` apply exactly as they do everywhere else, and the SAME policies decide what a
 * subscriber sees. One authorisation model, one place to change it.
 *
 * ── WHAT IT IS HONEST ABOUT ─────────────────────────────────────────────────────────────
 *
 * The server polls and pushes; it is not listening to a WAL stream. The client still gets a
 * push rather than a poll, which is what matters for the UI — but every frame carries the
 * instant it was read, so no surface can present a number as fresher than it is
 * (NFR-AVAIL-004). The connection also carries an explicit heartbeat, so a client can tell
 * "nothing changed" from "the stream died" — which a silent connection cannot.
 *
 * Refs: FR-OPS-009, NFR-AVAIL-003, NFR-AVAIL-004, NFR-AVAIL-005, E11,
 *       rules.md R-026, R-028, R-032, audit H-9
 */

import { withContext, getPanelSnapshot } from '@sophep/backend'
import { requireStaff, hasCapability } from '@/lib/auth/session'

export const dynamic = 'force-dynamic'
// Node, not Edge: `withContext` opens a real Postgres transaction.
export const runtime = 'nodejs'

/** How often the server re-reads. Fast enough to feel live, slow enough not to be a load test. */
const TICK_MS = 3000
/** Sent when nothing changed, so a dead connection is distinguishable from a quiet one. */
const HEARTBEAT_MS = 15_000
/** Serverless functions are killed at some ceiling anyway; reconnecting is the client's job. */
const MAX_LIFETIME_MS = 5 * 60_000

type Scope = { kind: 'panel'; panelId: string } | { kind: 'stage'; stageId: string }

function parseScope(url: URL): Scope | null {
  const panelId = url.searchParams.get('panelId')
  const stageId = url.searchParams.get('stageId')
  const isUuid = (v: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)

  if (panelId && isUuid(panelId)) return { kind: 'panel', panelId }
  if (stageId && isUuid(stageId)) return { kind: 'stage', stageId }
  return null
}

export async function GET(req: Request) {
  const staff = await requireStaff()
  if (!staff) {
    return new Response('event: error\ndata: {"code":"TOKEN_INVALID"}\n\n', {
      status: 401,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  // Authorised ONCE at connect, and re-derived from the database on every read below — a
  // long-lived stream must not keep serving a capability that was revoked mid-event.
  if (!(await hasCapability(staff, 'applicant.view'))) {
    return new Response('event: error\ndata: {"code":"DUAL_CONTROL_REQUIRED"}\n\n', {
      status: 403,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  const scope = parseScope(new URL(req.url))
  if (!scope) {
    return new Response('event: error\ndata: {"code":"INVALID_TRANSITION"}\n\n', {
      status: 400,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  const encoder = new TextEncoder()
  const started = Date.now()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      let lastPayload = ''
      let lastSentAt = 0

      const send = (event: string, data: unknown) => {
        if (closed) return
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        )
      }

      const close = () => {
        if (closed) return
        closed = true
        clearInterval(timer)
        try {
          controller.close()
        } catch {
          // Already closed by the client disconnecting. Not an error.
        }
      }

      // The client aborts on navigation or tab close; without this the interval would keep
      // querying the database for a reader that no longer exists.
      req.signal.addEventListener('abort', close)

      const tick = async () => {
        if (closed) return

        if (Date.now() - started > MAX_LIFETIME_MS) {
          // Tell the client to come back rather than dying silently — a stream that stops
          // without saying so is a screen that quietly freezes (NFR-AVAIL-005).
          send('reconnect', { reason: 'max_lifetime' })
          close()
          return
        }

        try {
          const payload = await withContext(staff.context, async (tx) => {
            // Re-checked every tick, not just at connect. RLS is the real boundary — this is
            // the layer that turns a revoked capability into a clean close instead of an
            // empty result the UI would render as "nothing is happening".
            const stillAllowed = await tx<Array<{ ok: boolean }>>`
              SELECT fn_has_capability(${staff.cycleId}::uuid, 'applicant.view') AS ok
            `
            if (!stillAllowed[0]?.ok) return null

            if (scope.kind === 'panel') {
              return await getPanelSnapshot(tx, scope.panelId)
            }

            const rows = await tx<Array<{ waiting: string; parked: string }>>`
              SELECT
                count(*) FILTER (WHERE q.state = 'waiting')::text AS waiting,
                count(*) FILTER (WHERE q.state = 'parked')::text  AS parked
                FROM queue_entries q
                JOIN tracks t ON t.id = q.track_id
                JOIN stages s ON s.id = t.stage_id
               WHERE s.id = ${scope.stageId}::uuid
                 AND s.cycle_id = ${staff.cycleId}::uuid
            `
            return {
              waiting: Number(rows[0]?.waiting ?? 0),
              parked: Number(rows[0]?.parked ?? 0),
            }
          })

          if (payload === null) {
            send('error', { code: 'DUAL_CONTROL_REQUIRED', reason: 'capability_revoked' })
            close()
            return
          }

          const serialised = JSON.stringify(payload)
          const now = Date.now()

          // Only push on CHANGE. Re-sending an identical frame every three seconds would make
          // "last updated" meaningless — it would advance while nothing actually moved.
          if (serialised !== lastPayload) {
            lastPayload = serialised
            lastSentAt = now
            send('update', { data: payload, readAt: new Date(now).toISOString() })
          } else if (now - lastSentAt > HEARTBEAT_MS) {
            lastSentAt = now
            // NFR-AVAIL-004: carries the instant it was READ, so the client can show a true
            // "last updated" rather than the time it happened to receive a frame.
            send('heartbeat', { readAt: new Date(now).toISOString() })
          }
        } catch (err) {
          console.error('live stream tick failed', err)
          send('error', { code: 'INVALID_TRANSITION', retryable: true })
          close()
        }
      }

      const timer = setInterval(() => void tick(), TICK_MS)
      await tick() // first frame immediately, so the UI is never blank for a tick
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Connection: 'keep-alive',
      // Nginx and some CDNs buffer by default, which turns a stream into a long silence
      // followed by everything at once.
      'X-Accel-Buffering': 'no',
    },
  })
}
