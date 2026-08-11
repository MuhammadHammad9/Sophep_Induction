'use client'

/**
 * The panel screen. Three states, and the transitions between them are the whole design
 * (spec §19.3).
 *
 * Idle    — one enormous Call Next button and nothing else, so a tired interviewer cannot
 *           mis-tap into something destructive.
 * Called  — name, ID, a visible grace countdown, and exactly two actions.
 * Blocked — awaiting evaluations. Says WHO is outstanding, because a greyed-out control with
 *           no explanation is a defect (R-058, NFR-USE-006, FR-INT-013).
 *
 * FR-INT-019: this screen never auto-advances, auto-submits, or changes view without an
 * explicit action. An interviewer mid-sentence must never have the screen move under them.
 */

import { useState, useEffect, useCallback } from 'react'
import { StateBadge } from '@/components/state/StateBadge'

interface Claimed {
  queueEntryId: string
  applicantId: string
  displayId: string
  fullName: string
  roomName: string
  calledAt: string
  callCount: number
  graceExpiresAt: string
}

interface PanelSnapshot {
  status: string
  waiting: number
  parked: number
  blockedBy?: string[]
}

export function PanelConsole({
  panelId,
  panelName,
  initial,
}: {
  panelId: string
  panelName: string
  initial: PanelSnapshot
}) {
  const [snapshot, setSnapshot] = useState(initial)
  const [claimed, setClaimed] = useState<Claimed | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Drives the grace countdown only. Deliberately does not refetch or re-render anything the
  // interviewer is reading.
  useEffect(() => {
    if (!claimed) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [claimed])

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/panels/${panelId}/snapshot`, { cache: 'no-store' })
    if (res.ok) setSnapshot(await res.json())
  }, [panelId])

  async function callNext() {
    setBusy(true)
    setMessage(null)

    const res = await fetch(`/api/panels/${panelId}/call-next`, { method: 'POST' })
    const body = await res.json()
    setBusy(false)

    if (!res.ok) {
      // R-058: always say why. "Submit the outstanding evaluation first" is actionable;
      // a disabled button is not.
      setMessage(body?.error?.message ?? 'Could not call the next applicant')
      await refresh()
      return
    }

    if (body.outcome === 'queue_empty') {
      // FR-QUE-013: not an error. If people are parked, say so — otherwise panels sit idle
      // while applicants wait fifteen metres away.
      setMessage(
        snapshot.parked > 0
          ? `Nobody waiting. ${snapshot.parked} applicant(s) parked — a volunteer is looking for them.`
          : 'Nobody is waiting right now.',
      )
      await refresh()
      return
    }

    setClaimed(body.applicant)
    setNow(Date.now())
    await refresh()
  }

  async function markAbsent() {
    if (!claimed) return
    setBusy(true)
    await fetch(`/api/queue/${claimed.queueEntryId}/skip`, { method: 'POST' })
    setBusy(false)
    setClaimed(null)
    await refresh()
  }

  async function startInterview() {
    if (!claimed) return
    setBusy(true)
    await fetch(`/api/queue/${claimed.queueEntryId}/start`, { method: 'POST' })
    setBusy(false)
    setMessage(`Interview started with ${claimed.displayId}.`)
    setClaimed(null)
    await refresh()
  }

  // ── Blocked ───────────────────────────────────────────────────────────────────────────
  if (snapshot.status === 'awaiting_evaluations') {
    return (
      <Shell panelName={panelName} snapshot={snapshot}>
        <div className="rounded-card border border-state-blocked/30 bg-state-blocked-fill p-6">
          <StateBadge state="blocked">Waiting on evaluations</StateBadge>
          <p className="mt-4 text-body">
            You cannot call the next applicant until this panel&rsquo;s evaluations are in.
          </p>
          {snapshot.blockedBy?.length ? (
            <p className="mt-2 text-small text-text-muted">
              Outstanding: {snapshot.blockedBy.join(', ')}
            </p>
          ) : null}
          <p className="mt-4 text-small text-text-muted">
            A coordinator can waive a missing evaluation with a written reason.
          </p>
        </div>
      </Shell>
    )
  }

  // ── Called ────────────────────────────────────────────────────────────────────────────
  if (claimed) {
    const remainingMs = new Date(claimed.graceExpiresAt).getTime() - now
    const remaining = Math.max(0, Math.ceil(remainingMs / 1000))
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0')
    const ss = String(remaining % 60).padStart(2, '0')

    return (
      <Shell panelName={panelName} snapshot={snapshot}>
        <div className="rounded-card border-l-4 border-state-called bg-state-called-fill p-6">
          <StateBadge state="called">Called to {claimed.roomName}</StateBadge>

          <p className="id-text mt-4 text-id-xl">{claimed.displayId}</p>
          <p className="text-h2">{claimed.fullName}</p>

          <p className="mt-4 text-small text-text-muted">Grace remaining</p>
          <p
            className="id-text text-display"
            // NFR-A11Y-005: announce the countdown politely rather than on every tick.
            role="timer"
            aria-live="off"
          >
            {mm}:{ss}
          </p>
          {claimed.callCount > 1 ? (
            <p className="mt-1 text-small text-state-called">
              Called {claimed.callCount} times — parks if missed again.
            </p>
          ) : null}
        </div>

        {/* Large, well separated, and no confirmation on Start (NFR-USE-003). */}
        <div className="mt-6 grid grid-cols-2 gap-4">
          <button
            onClick={startInterview}
            disabled={busy}
            className="min-h-[56px] rounded-control bg-primary px-6 py-4 text-h2 font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
          >
            Start
          </button>
          <button
            onClick={markAbsent}
            disabled={busy}
            className="min-h-[56px] rounded-control border border-border-strong bg-surface px-6 py-4 text-h2 font-semibold hover:border-state-called disabled:opacity-60"
          >
            Mark absent
          </button>
        </div>
      </Shell>
    )
  }

  // ── Idle ──────────────────────────────────────────────────────────────────────────────
  return (
    <Shell panelName={panelName} snapshot={snapshot}>
      {message ? (
        <p role="status" className="mb-4 rounded-card border border-border bg-surface p-4">
          {message}
        </p>
      ) : null}

      <button
        onClick={callNext}
        disabled={busy}
        className="min-h-[56px] w-full rounded-card bg-primary px-8 py-10 text-display font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
      >
        {busy ? 'Calling…' : 'Call Next'}
      </button>

      <p className="mt-4 text-center text-body text-text-muted">
        <span className="id-text text-h2 text-text">{snapshot.waiting}</span> waiting
        {snapshot.parked > 0 ? (
          <>
            {' · '}
            <span className="id-text text-h2 text-state-called">{snapshot.parked}</span> parked
          </>
        ) : null}
      </p>
    </Shell>
  )
}

function Shell({
  panelName,
  snapshot,
  children,
}: {
  panelName: string
  snapshot: PanelSnapshot
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-h1">{panelName}</h1>
        {/* NFR-AVAIL-004: a connection indicator on every surface presenting live data. */}
        <StateBadge state={snapshot.status === 'busy' ? 'live' : 'waiting'}>
          {snapshot.status}
        </StateBadge>
      </header>
      {children}
    </div>
  )
}
