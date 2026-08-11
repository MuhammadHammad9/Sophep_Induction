'use client'

/**
 * The applicant status page, live.
 *
 * Two hundred anxious people stare at this for up to an hour. It answers three questions
 * without scrolling and without being read: am I in, where am I, what do I do now (§19.1).
 *
 * The rules that matter most here are about HONESTY, not layout:
 *
 *  - Never present a stale number as live (principle 2, R-026). Every state carries a
 *    last-updated instant and a connection indicator (NFR-AVAIL-004).
 *  - Never show a bare spinner. On reconnect the LAST KNOWN number stays visible with an
 *    explicit timestamp — blanking the screen on someone in position 3 is cruel, and
 *    NFR-USE-007 forbids a loading indicator without context.
 *  - An estimate that RISES appears with its cause (FR-QUE-017).
 *  - The CALLED state takes over the whole viewport. Missing your call because the room
 *    number sat in a corner is the worst avoidable outcome on this page.
 *
 * Degradation ladder (§13.2, NFR-AVAIL-003): polling with backoff, then cached data with an
 * explicit timestamp. Websockets land with Supabase Realtime; polling is the fallback that
 * must work regardless, so it is what ships first.
 */

import { useEffect, useState, useRef } from 'react'
import { StatusBand, type UiState } from '@/components/state/StateBadge'

export interface LiveSnapshot {
  state: string
  displayId: string
  position: number | null
  roomName: string | null
  estimate: {
    kind: 'suppressed' | 'range'
    message: string
    upperMinutes?: number
    revision?: { message: string }
  }
  activePanels?: number
  graceExpiresAt: string | null
  graceExtended: boolean
}

type Connection = 'live' | 'reconnecting' | 'offline'

const POLL_MS = 5000
const MAX_BACKOFF_MS = 30_000

export function LiveStatus({
  token,
  initial,
}: {
  token: string
  initial: LiveSnapshot
}) {
  const [snapshot, setSnapshot] = useState(initial)
  const [connection, setConnection] = useState<Connection>('live')
  const [updatedAt, setUpdatedAt] = useState(() => new Date())
  const [extending, setExtending] = useState(false)
  const backoffRef = useRef(POLL_MS)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // What was last DISPLAYED, so the server can explain a rise rather than let one appear
  // silently (FR-QUE-017).
  const previousRef = useRef<{ upperMinutes: number; activePanels: number } | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  /**
   * The polling loop, self-rescheduling with exponential backoff.
   *
   * Defined inside the effect rather than as a memoised callback so its lifetime is exactly
   * the component's — a loop that outlives its mount keeps hitting a rate-limited endpoint
   * for a page nobody is looking at.
   *
   * The previous range and panel count go up with the request so the server can explain an
   * INCREASE rather than letting one appear silently (FR-QUE-017).
   */
  useEffect(() => {
    let cancelled = false

    const run = async () => {
      try {
        const params = new URLSearchParams()
        const previous = previousRef.current
        if (previous) {
          params.set('prevUpper', String(previous.upperMinutes))
          params.set('prevPanels', String(previous.activePanels))
        }

        const res = await fetch(`/api/q/${token}/status?${params}`, { cache: 'no-store' })
        if (!res.ok) throw new Error(String(res.status))

        const next: LiveSnapshot = await res.json()
        if (cancelled) return

        if (next.estimate.kind === 'range' && next.estimate.upperMinutes) {
          previousRef.current = {
            upperMinutes: next.estimate.upperMinutes,
            activePanels: next.activePanels ?? 0,
          }
        }

        setSnapshot(next)
        setUpdatedAt(new Date())
        setConnection('live')
        backoffRef.current = POLL_MS
      } catch {
        if (cancelled) return
        // Step 3 of the ladder. The last known values STAY on screen — never cleared, never
        // replaced by a spinner (NFR-AVAIL-005, NFR-USE-007).
        setConnection((c) => (c === 'live' ? 'reconnecting' : 'offline'))
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS)
      } finally {
        if (!cancelled) {
          timerRef.current = setTimeout(() => void run(), backoffRef.current)
        }
      }
    }

    timerRef.current = setTimeout(() => void run(), POLL_MS)

    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [token, refreshNonce])

  function onMyWay() {
    setExtending(true)
    void fetch(`/api/q/${token}/on-my-way`, { method: 'POST' })
      .then(() => setRefreshNonce((n) => n + 1))
      .finally(() => setExtending(false))
  }

  const called = snapshot.state === 'called'

  // ── The called state takes over everything ────────────────────────────────────────────
  if (called && snapshot.roomName) {
    return (
      <div className="flex min-h-dvh flex-col justify-between bg-state-called p-6 text-white">
        <span className="id-text text-id-md opacity-90">{snapshot.displayId}</span>

        <div className="text-center">
          <p className="text-h2 uppercase tracking-widest opacity-90">Go now</p>
          {/* The single largest thing on the screen. */}
          <p className="mt-2 text-[18vw] font-bold leading-none">{snapshot.roomName}</p>
          <p className="mt-4 text-h2">You have 5 minutes</p>
        </div>

        <div>
          {/* FR-QUE-009: one 44px tap, once. Each avoided skip is an argument that never
              happens at the desk. */}
          <button
            onClick={onMyWay}
            disabled={snapshot.graceExtended || extending}
            className="min-h-touch w-full rounded-card bg-white px-6 py-4 text-h2 font-semibold text-state-called disabled:opacity-70"
          >
            {snapshot.graceExtended ? 'Extended — 2 extra minutes' : "I'm on my way"}
          </button>
          <Liveness connection={connection} updatedAt={updatedAt} inverted />
        </div>
      </div>
    )
  }

  const view = PRESENTATION[snapshot.state] ?? {
    state: 'live' as UiState,
    headline: 'In progress',
    guidance: 'This page updates automatically.',
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 p-5">
      <div className="flex items-center justify-between">
        <span className="id-text rounded-pill border border-border-strong bg-surface px-3 py-1 text-id-md">
          {snapshot.displayId}
        </span>
      </div>

      <StatusBand state={view.state} headline={view.headline} />

      {/* "The one number" — position, when there is one to show. */}
      {snapshot.position !== null ? (
        <div className="text-center">
          <p className="text-small uppercase tracking-wide text-text-muted">Your position</p>
          <p className="id-text text-[20vw] font-semibold leading-none text-text">
            {snapshot.position}
          </p>
        </div>
      ) : null}

      <div>
        <p className="text-body">{snapshot.estimate.message}</p>
        {/* FR-QUE-017: an increase never appears bare. "Two panels are on a break" is
            information; a number that silently grows is alarming. */}
        {snapshot.estimate.revision ? (
          <p className="mt-1 text-small text-state-called">{snapshot.estimate.revision.message}</p>
        ) : null}
      </div>

      <p className="text-body">{view.guidance}</p>

      <div className="mt-auto border-t border-border pt-4">
        <Liveness connection={connection} updatedAt={updatedAt} />
      </div>
    </div>
  )
}

/**
 * NFR-AVAIL-004 / NFR-AVAIL-005: a connection indicator and a last-updated instant on every
 * surface presenting live data, and cached data never rendered as if it were live.
 *
 * An applicant who knows a number is three minutes old is fine. One who trusts a frozen
 * number and misses their call is not.
 */
function Liveness({
  connection,
  updatedAt,
  inverted = false,
}: {
  connection: Connection
  updatedAt: Date
  inverted?: boolean
}) {
  const time = updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const tone = inverted ? 'text-white/80' : 'text-text-muted'

  return (
    <p className={`mt-3 flex items-center gap-2 text-caption ${tone}`}>
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${
          connection === 'live'
            ? 'bg-state-complete'
            : connection === 'reconnecting'
              ? 'bg-state-called'
              : 'bg-state-blocked'
        }`}
      />
      {connection === 'live'
        ? `Live · updated ${time}`
        : connection === 'reconnecting'
          ? `Reconnecting · last updated ${time}`
          : `Offline · last updated ${time}`}
    </p>
  )
}

const PRESENTATION: Record<string, { state: UiState; headline: string; guidance: string }> = {
  submitted: {
    state: 'waiting',
    headline: 'Application received',
    guidance: 'We will email you when interview day is confirmed.',
  },
  eligible: {
    state: 'waiting',
    headline: "You're registered",
    guidance: 'Check in at the desk when you arrive.',
  },
  checked_in: {
    state: 'live',
    headline: "You're checked in",
    guidance: "Stay in the building — we'll call you here.",
  },
  queued: {
    state: 'live',
    headline: "You're in the queue",
    guidance: "Stay in the building — we'll call you here.",
  },
  skipped: {
    state: 'called',
    headline: 'We called and missed you',
    guidance: 'See the desk and they will put you back in the queue.',
  },
  parked: {
    state: 'called',
    headline: 'We could not find you',
    guidance: 'Go to the desk — a volunteer is looking for you.',
  },
  in_interview: {
    state: 'live',
    headline: 'Interview in progress',
    guidance: 'Good luck.',
  },
  interview_complete: {
    state: 'complete',
    headline: 'Interview complete',
    guidance: 'Thank you. We will email you when results are published.',
  },
  no_show: {
    state: 'blocked',
    headline: 'Marked as no-show',
    guidance: 'Speak to a coordinator if you were here.',
  },
  withdrawn: {
    state: 'blocked',
    headline: 'Application withdrawn',
    guidance: 'Contact SOPHEP if you did not intend to withdraw.',
  },
}
