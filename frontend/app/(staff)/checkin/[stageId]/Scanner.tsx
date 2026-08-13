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
import { addPendingOperation, getOfflineRosterHashes } from '@/lib/offline/indexeddb'
import { syncRoster, getRosterSyncState, type RosterSyncState } from '@/lib/offline/roster'
import { verifyOfflineQR } from '@/lib/offline/verifyQR'

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
  /**
   * Queued locally because the network was unavailable. NOT a confirmed check-in.
   *
   * Spec §14.1 #8 is explicit: on a network drop the UI says PENDING, not done. Rendering this
   * as a success would be a number we know is provisional shown as final (principle 2,
   * NFR-AVAIL-005) — and a replay can still fail, for instance if the code was never valid.
   */
  | { kind: 'pending'; displayId: string | null; fullName: string | null; queuedAt: string }
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

  // The cached roster's token hashes. Loaded once and held in a ref so a scan never waits on
  // IndexedDB — the eight-second budget (NFR-PERF-003) has no room for it.
  const rosterRef = useRef<ReadonlySet<string>>(new Set())
  const [rosterState, setRosterState] = useState<RosterSyncState>({ syncedAt: null, count: 0 })
  const { isOffline, pendingCount, conflictCount } = useOfflineSync()

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
      } catch {
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

  // Refresh the offline bundle while there is still a network to refresh it from, then load
  // the hashes into memory. Re-run every ten minutes so applicants who registered after the
  // morning sync are recognised at layer 2 rather than needing the Ed25519 fallback.
  useEffect(() => {
    let active = true

    async function refresh() {
      // What a previous session already cached, read first so the banner is right immediately
      // rather than flashing "no roster" at a volunteer whose device is fine.
      if (active) setRosterState(getRosterSyncState())

      if (navigator.onLine) {
        const state = await syncRoster(stageId)
        if (active && state) setRosterState(state)
      }
      const hashes = await getOfflineRosterHashes()
      if (active) rosterRef.current = hashes
    }

    void Promise.resolve().then(refresh)

    const timer = setInterval(() => void refresh(), 10 * 60 * 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [stageId])

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
      } catch {
        // The network failed. Queue the operation locally and REPLAY it later with its
        // original Idempotency-Key, so a double-submit is harmless (FR-CHK-008, FR-CHK-014).
        const clientTs = (body.clientTs as string) || new Date().toISOString()
        const id = crypto.randomUUID()

        // Look the person up in the cached roster purely so the volunteer can confirm they
        // scanned the right applicant. This does NOT make the check-in confirmed.
        let offlineIdentity: { displayId: string; fullName: string } | null = null
        if (typeof body.scanned === 'string') {
          try {
            const verified = await verifyOfflineQR(body.scanned, rosterRef.current)
            offlineIdentity = verified.applicant
              ? { displayId: verified.applicant.displayId, fullName: verified.applicant.fullName }
              : null
          } catch {
            // Verification is best-effort here; the queued operation stands either way and the
            // server is the authority when it replays.
          }
        }
        
        await addPendingOperation({
          id,
          endpoint: '/api/checkins',
          method: 'POST',
          payload: { stageId, ...body },
          clientTs
        })

        // Queued, NOT checked in. Whatever the roster can tell us about this person is shown
        // so the volunteer can confirm they have the right applicant — but the outcome stays
        // explicitly provisional until the server confirms it.
        setResult({
          kind: 'pending',
          displayId: offlineIdentity?.displayId ?? null,
          fullName: offlineIdentity?.fullName ?? null,
          queuedAt: clientTs,
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
    // Errors AND pending both require explicit dismissal. A provisional outcome that
    // auto-clears is indistinguishable from a confirmed one (FR-CHK-003, NFR-AVAIL-005).
    if (result.kind === 'error' || result.kind === 'pending') return

    dismissTimer.current = setTimeout(clearResult, SUCCESS_DWELL_MS)
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current)
    }
  }, [result, clearResult])

  const { videoRef, state } = useScanner({ onScan, paused: result !== null || searchOpen })

  return (
    <div className="flex min-h-dvh flex-col bg-[#0F172A] text-white relative">
      <OfflineBanner
        isOffline={isOffline}
        pendingCount={pendingCount}
        conflictCount={conflictCount}
        rosterReady={rosterState.count > 0}
      />

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

  if (result.kind === 'pending') {
    const queued = new Date(result.queuedAt).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    })

    return (
      <div
        role="alert"
        className="stripe-offline absolute inset-0 flex flex-col items-center justify-center bg-state-offline p-6 text-center text-white"
      >
        {/* Colour is never the only signal (R-060): the offline state carries stripes and a
            distinct icon as well. */}
        <StateBadge state="offline">Saved — not yet confirmed</StateBadge>

        {result.displayId ? (
          <>
            <p className="id-text mt-4 text-id-xl">{result.displayId}</p>
            <p className="text-h2">{result.fullName}</p>
          </>
        ) : (
          <p className="mt-4 text-h2">Scan saved</p>
        )}

        <p className="mt-3 text-body">
          Queued at {queued}. It will be sent when the network returns.
        </p>
        <p className="mt-1 text-small opacity-90">
          Not checked in yet — check the pending count before the stage closes.
        </p>

        {/* Requires dismissal. A provisional outcome that auto-clears reads exactly like a
            confirmed one, which is the confusion this whole state exists to prevent. */}
        <button
          onClick={onDismiss}
          className="mt-8 min-h-touch rounded-control bg-white px-8 py-3 font-semibold text-state-offline"
        >
          Got it
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
