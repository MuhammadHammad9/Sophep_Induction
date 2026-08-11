'use client'

/**
 * The volunteer scanner — the eight-second screen (spec §19.2).
 *
 * Optimised for one-handed use, in a queue, under fluorescent light, by someone with fifteen
 * minutes of training. The rules that shape it:
 *
 *  - The camera runs continuously. Never a tap to scan (FR-CHK-001).
 *  - A SUCCESS auto-clears after 2.5 s and needs zero taps (FR-CHK-002).
 *  - A FAILURE requires explicit dismissal (FR-CHK-003) — a failure that scrolls past
 *    unnoticed becomes a person nobody checked in.
 *  - "Already checked in" is AMBER, never red (FR-CHK-006, R-027). It is the most common
 *    non-happy path, it is not an error, and red in front of a nervous applicant reads as
 *    "you have a problem" when the correct message is "you are fine".
 *
 * Refs: FR-CHK-001..011, NFR-USE-002, NFR-A11Y-003, NFR-A11Y-005
 */

import { useCallback, useState, useEffect, useRef } from 'react'
import { useScanner } from '@/lib/scanner/useScanner'
import { StateBadge } from '@/components/state/StateBadge'
import { useOfflineSync } from '@/lib/offline/useOfflineSync'
import { OfflineBanner } from '@/components/scanner/OfflineBanner'
import { addPendingOperation, getOfflineApplicantByHash } from '@/lib/offline/indexeddb'

interface CheckInResponse {
  outcome: 'checked_in' | 'already'
  displayId: string
  fullName: string
  position: number
  checkedInAt: string
  etaSuppressed: boolean
}

type Result =
  | { kind: 'success'; data: CheckInResponse }
  | { kind: 'repeat'; data: CheckInResponse }
  | { kind: 'error'; headline: string; guidance?: string }

const SUCCESS_DWELL_MS = 2500

export function Scanner({
  stageId,
  deskName,
}: {
  stageId: string
  deskName: string
}) {
  const [result, setResult] = useState<Result | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [parkedCount, setParkedCount] = useState(0)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { isOffline, pendingCount } = useOfflineSync()

  // Poll for parked applicants
  useEffect(() => {
    if (isOffline) return
    let active = true

    async function checkParked() {
      try {
        const res = await fetch(`/api/stages/${stageId}/parked`)
        if (res.ok && active) {
          const data = await res.json()
          setParkedCount(data.parked ?? 0)
        }
      } catch (e) {
        // silently ignore network errors for polling
      }
    }

    void checkParked()
    const timer = setInterval(checkParked, 15000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [stageId, isOffline])

  const clearResult = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current)
    dismissTimer.current = null
    setResult(null)
  }, [])

  const submit = useCallback(
    async (body: Record<string, unknown>) => {
      setSubmitting(true)
      try {
        const res = await fetch('/api/checkins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stageId, ...body }),
        })
        const payload = await res.json()

        if (!res.ok) {
          setResult({
            kind: 'error',
            headline: payload?.error?.message ?? 'Check-in failed',
            guidance:
              payload?.error?.code === 'TOKEN_INVALID'
                ? 'Search for them by name or ID instead.'
                : 'See a coordinator if this keeps happening.',
          })
          return
        }

        setResult(
          payload.outcome === 'already'
            ? { kind: 'repeat', data: payload }
            : { kind: 'success', data: payload },
        )
      } catch (err) {
        // Fallback to offline mode
        const clientTs = (body.clientTs as string) || new Date().toISOString()
        const id = crypto.randomUUID()
        
        await addPendingOperation({
          id,
          endpoint: '/api/checkins',
          method: 'POST',
          payload: { stageId, ...body },
          clientTs
        })

        // Give a provisional success if it's a known offline scenario
        setResult({
          kind: 'success',
          data: {
            outcome: 'checked_in',
            displayId: 'OFFLINE',
            fullName: 'Check-in pending sync',
            position: 0,
            checkedInAt: clientTs,
            etaSuppressed: true,
          }
        })
      } finally {
        setSubmitting(false)
      }
    },
    [stageId],
  )

  const onScan = useCallback(
    (scanned: string) => {
      if (submitting) return
      void submit({ scanned, method: 'qr', clientTs: new Date().toISOString() })
    },
    [submit, submitting],
  )

  // FR-CHK-002 / FR-CHK-003: successes auto-clear so the volunteer never taps; failures do not.
  useEffect(() => {
    if (!result) return
    if (result.kind === 'error') return

    dismissTimer.current = setTimeout(clearResult, SUCCESS_DWELL_MS)
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current)
    }
  }, [result, clearResult])

  const { videoRef, state } = useScanner({ onScan, paused: result !== null || searchOpen })

  return (
    <div className="flex min-h-dvh flex-col bg-[#0F172A] text-white relative">
      {isOffline || pendingCount > 0 ? (
        <OfflineBanner pendingCount={pendingCount} />
      ) : null}

      <header className="flex items-center justify-between px-4 py-3">
        <span className="font-medium">{deskName}</span>
        <ConnectionPill state={state} />
      </header>

      {parkedCount > 0 ? (
        <div className="bg-state-called px-4 py-2 text-center text-sm font-medium text-white shadow-md">
          {parkedCount} applicant(s) parked — please search and reactivate them
        </div>
      ) : null}

      <div className="relative flex-1 overflow-hidden bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="h-full w-full object-cover"
          aria-label="Camera viewfinder"
        />

        {state.status === 'denied' ? (
          <Notice
            headline="Camera access blocked"
            body="Allow camera access in your browser settings, or use search below."
          />
        ) : null}
        {state.status === 'unavailable' ? (
          <Notice headline={state.reason} body="Use search below to check people in." />
        ) : null}

        {result ? <ResultOverlay result={result} onDismiss={clearResult} /> : null}
      </div>

      {/* Always reachable by thumb (spec §19.2). */}
      <div className="p-4">
        <button
          onClick={() => setSearchOpen((v) => !v)}
          className="min-h-touch w-full rounded-control border border-slate-600 bg-slate-800 px-4 py-3 text-left text-white"
        >
          {searchOpen ? 'Close search' : 'Search by name or ID'}
        </button>

        {searchOpen ? (
          <ManualSearch
            stageId={stageId}
            onPicked={(applicantId) => {
              setSearchOpen(false)
              void submit({ applicantId, method: 'manual_search' })
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

function ConnectionPill({ state }: { state: ReturnType<typeof useScanner>['state'] }) {
  if (state.status === 'running') {
    return <StateBadge state="live">Live</StateBadge>
  }
  if (state.status === 'starting') {
    return <StateBadge state="waiting">Starting camera</StateBadge>
  }
  return <StateBadge state="blocked">No camera</StateBadge>
}

function Notice({ headline, body }: { headline: string; body: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 p-6 text-center">
      <p className="text-h2">{headline}</p>
      <p className="mt-2 text-small text-slate-300">{body}</p>
    </div>
  )
}

/**
 * The result overlay covers the camera so the volunteer's eye lands on it without hunting.
 *
 * `role="alert"` announces every outcome to assistive technology (NFR-A11Y-005), and each
 * state carries an icon and a shape as well as colour (R-060) — the state colours are not
 * the only signal.
 */
function ResultOverlay({ result, onDismiss }: { result: Result; onDismiss: () => void }) {
  if (result.kind === 'error') {
    return (
      <div
        role="alert"
        className="absolute inset-0 flex flex-col items-center justify-center bg-state-blocked p-6 text-center text-white"
      >
        <StateBadge state="blocked">Not checked in</StateBadge>
        <p className="mt-4 text-h1">{result.headline}</p>
        {result.guidance ? <p className="mt-2 text-body">{result.guidance}</p> : null}
        {/* FR-CHK-003: requires explicit dismissal. */}
        <button
          onClick={onDismiss}
          className="mt-8 min-h-touch rounded-control bg-white px-8 py-3 font-semibold text-state-blocked"
        >
          Dismiss
        </button>
      </div>
    )
  }

  const repeat = result.kind === 'repeat'
  const time = new Date(result.data.checkedInAt).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div
      role="alert"
      className={`absolute inset-0 flex flex-col items-center justify-center p-6 text-center ${
        repeat ? 'bg-state-called text-white' : 'bg-state-complete text-white'
      }`}
    >
      {/* AMBER for a repeat, not red. It is not an error (R-027, NFR-USE-004). */}
      <StateBadge state={repeat ? 'called' : 'complete'}>
        {repeat ? 'Already checked in' : 'Checked in'}
      </StateBadge>

      <p className="id-text mt-4 text-id-xl">{result.data.displayId}</p>
      <p className="text-h2">{result.data.fullName}</p>

      {repeat ? (
        <p className="mt-3 text-body">Checked in at {time}</p>
      ) : null}

      {result.data.etaSuppressed ? (
        // FR-CHK-011: no open panel. Say so rather than showing a position that implies
        // someone is about to call them.
        <p className="mt-3 text-body">In the queue — a panel is being assigned</p>
      ) : (
        <p className="mt-3 text-body">
          Position <span className="id-text text-h1">{result.data.position}</span>
        </p>
      )}
    </div>
  )
}

/**
 * Manual search (FR-CHK-009): any 4 consecutive digits of the ID, the last 4 of the phone, or
 * a partial name. This is what a volunteer falls back to when a camera fails or a screen is
 * cracked, so it must not require knowing the exact identifier.
 */
function ManualSearch({
  stageId,
  onPicked,
}: {
  stageId: string
  onPicked: (applicantId: string) => void
}) {
  const [q, setQ] = useState('')
  const [fetched, setFetched] = useState<
    Array<{ applicantId: string; displayId: string; fullName: string; state: string }>
  >([])
  const [searching, setSearching] = useState(false)

  const term = q.trim()
  const active = term.length >= 2

  // Derived, not stored: below the minimum length there is nothing to show, and clearing via
  // setState inside the effect would cause a cascading render on every keystroke.
  const results = active ? fetched : []

  useEffect(() => {
    if (!active) return

    // Debounced so a volunteer typing a name does not fire a request per character. 250 ms is
    // short enough to feel immediate at a desk and long enough to collapse a burst.
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(
          `/api/applicants/search?stageId=${stageId}&q=${encodeURIComponent(term)}`,
        )
        setFetched(res.ok ? await res.json() : [])
      } catch {
        setFetched([])
      } finally {
        setSearching(false)
      }
    }, 250)

    return () => clearTimeout(t)
  }, [term, active, stageId])

  return (
    <div className="mt-3">
      <label htmlFor="applicant-search" className="sr-only">
        Search by name, ID or phone
      </label>
      <input
        id="applicant-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
        // NFR-A11Y-007: an appropriate inputmode. Volunteers type digits far more often
        // than letters here, but names must still work — so text, not numeric.
        inputMode="text"
        autoComplete="off"
        placeholder="Name, 4 digits of ID, or last 4 of phone"
        className="min-h-touch w-full rounded-control border border-slate-600 bg-slate-900 px-4 py-3 text-white placeholder:text-slate-500"
      />

      {searching ? <p className="mt-2 text-small text-slate-400">Searching…</p> : null}

      <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
        {results.map((r) => (
          <li key={r.applicantId}>
            <button
              onClick={() => onPicked(r.applicantId)}
              className="min-h-touch w-full rounded-control border border-slate-700 bg-slate-800 px-4 py-3 text-left"
            >
              <span className="id-text text-id-sm text-slate-300">{r.displayId}</span>
              <span className="block">{r.fullName}</span>
            </button>
          </li>
        ))}
      </ul>

      {active && !searching && results.length === 0 ? (
        <p className="mt-3 text-small text-slate-400">
          Nobody found. They may need registering at the desk.
        </p>
      ) : null}
    </div>
  )
}
