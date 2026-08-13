'use client'

/**
 * Bulk reconciliation — entering a paper roster after the power or network came back.
 *
 * Two steps, always, and the middle one is the point of the screen:
 *
 *   1. Paste or type identifiers.
 *   2. RESOLVE — see the names. Nothing has been written yet.
 *   3. Confirm — check them in, and see one result line per person including the failures.
 *
 * A single-step version of this screen would be shorter and would be wrong. Transcribing eighty
 * hand-ticked boxes at the end of a long day produces slips, and a slip that lands on the wrong
 * applicant is completely invisible unless a name is shown next to the number first.
 *
 * Refs: FR-CHK-017, FR-CHK-019, NFR-A11Y-003
 */

import { useCallback, useState } from 'react'

interface Matched {
  applicantId: string
  displayId: string
  fullName: string
}

interface ResolveResponse {
  matched: Matched[]
  unmatched: string[]
}

interface ReconcileResult {
  applicantId: string
  outcome: string
  queuePosition: number | null
}

type Phase =
  | { step: 'entry' }
  | { step: 'review'; matched: Matched[]; unmatched: string[] }
  | { step: 'done'; results: ReconcileResult[]; matched: Matched[] }

export function ReconcileForm({ stageId, stageName }: { stageId: string; stageName: string }) {
  const [raw, setRaw] = useState('')
  const [phase, setPhase] = useState<Phase>({ step: 'entry' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Split on anything a person might reasonably use between identifiers — a paper transcription
  // arrives as lines, as commas, or as whatever the person happened to type.
  const identifiers = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const post = useCallback(
    async (body: unknown) => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch(`/api/stages/${stageId}/reconcile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json()
        if (!res.ok) {
          setError(data?.error?.message ?? 'That did not work. Nobody was checked in.')
          return null
        }
        return data
      } catch {
        setError('No connection. Keep the paper roster — nothing has been recorded.')
        return null
      } finally {
        setBusy(false)
      }
    },
    [stageId],
  )

  const resolve = useCallback(async () => {
    const data = (await post({ identifiers })) as ResolveResponse | null
    if (data) setPhase({ step: 'review', matched: data.matched, unmatched: data.unmatched })
  }, [post, identifiers])

  const confirm = useCallback(async () => {
    if (phase.step !== 'review') return
    const data = (await post({
      applicantIds: phase.matched.map((m) => m.applicantId),
      confirm: true,
    })) as { results: ReconcileResult[] } | null
    if (data) setPhase({ step: 'done', results: data.results, matched: phase.matched })
  }, [post, phase])

  return (
    <div className="mx-auto max-w-3xl p-6 text-slate-100">
      <h1 className="text-2xl font-bold">Bulk reconcile — {stageName}</h1>
      <p className="mt-2 text-slate-300">
        For entering a printed roster after a power or network outage. Type or paste the
        identifiers that were ticked, one per line.
      </p>

      {error && (
        <div className="mt-4 rounded border-2 border-red-500 bg-red-950 p-3 font-medium" role="alert">
          {error}
        </div>
      )}

      {phase.step === 'entry' && (
        <div className="mt-6">
          <label htmlFor="ids" className="block font-medium">
            Identifiers
          </label>
          <p id="ids-help" className="mt-1 text-sm text-slate-400">
            Full form (SPH-2026-0042) or just the number (42). Separate with new lines, spaces
            or commas.
          </p>
          <textarea
            id="ids"
            aria-describedby="ids-help"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={12}
            className="mt-2 w-full rounded border border-slate-600 bg-slate-900 p-3 font-mono focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
          />
          <div className="mt-3 flex items-center gap-4">
            <button
              type="button"
              onClick={() => void resolve()}
              disabled={busy || identifiers.length === 0}
              className="min-h-[44px] rounded bg-sky-600 px-5 font-bold disabled:opacity-40"
            >
              {busy ? 'Checking…' : `Look up ${identifiers.length}`}
            </button>
            <span className="text-sm text-slate-400">Nothing is recorded at this step.</span>
          </div>
        </div>
      )}

      {phase.step === 'review' && (
        <div className="mt-6">
          {phase.unmatched.length > 0 && (
            <div className="mb-4 rounded border-2 border-red-500 bg-red-950 p-3" role="alert">
              <p className="font-bold">
                {phase.unmatched.length} identifier
                {phase.unmatched.length === 1 ? '' : 's'} matched nobody
              </p>
              <p className="mt-1 text-sm">
                These are shown so they are not lost. Check the paper roster — each one is a
                person who was in the building.
              </p>
              <p className="mt-2 font-mono text-sm">{phase.unmatched.join(', ')}</p>
            </div>
          )}

          <h2 className="text-lg font-bold">
            About to check in {phase.matched.length}{' '}
            {phase.matched.length === 1 ? 'person' : 'people'}
          </h2>
          <ul className="mt-3 divide-y divide-slate-700 rounded border border-slate-700">
            {phase.matched.map((m) => (
              <li key={m.applicantId} className="flex justify-between px-3 py-2">
                <span className="font-mono text-slate-300">{m.displayId}</span>
                <span>{m.fullName}</span>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy || phase.matched.length === 0}
              className="min-h-[44px] rounded bg-emerald-600 px-5 font-bold disabled:opacity-40"
            >
              {busy ? 'Checking in…' : `Check in ${phase.matched.length}`}
            </button>
            <button
              type="button"
              onClick={() => setPhase({ step: 'entry' })}
              disabled={busy}
              className="min-h-[44px] rounded border border-slate-500 px-5 font-medium"
            >
              Back to the list
            </button>
          </div>
        </div>
      )}

      {phase.step === 'done' && (
        <div className="mt-6">
          <h2 className="text-lg font-bold">Done</h2>
          <Summary results={phase.results} />
          <ul className="mt-3 divide-y divide-slate-700 rounded border border-slate-700">
            {phase.results.map((r) => {
              const person = phase.matched.find((m) => m.applicantId === r.applicantId)
              const failed = r.outcome.startsWith('error')
              return (
                <li
                  key={r.applicantId}
                  className={`flex items-center justify-between gap-3 px-3 py-2 ${
                    failed ? 'bg-red-950' : ''
                  }`}
                >
                  <span className="font-mono text-slate-300">
                    {person?.displayId ?? r.applicantId}
                  </span>
                  <span className="flex-1">{person?.fullName}</span>
                  {/* Wording, not just colour (R-060). "Already" is not a failure. */}
                  <span className="font-medium">
                    {failed
                      ? `Not checked in — ${r.outcome.replace(/^error:\s*/, '')}`
                      : r.outcome === 'already'
                        ? 'Was already checked in'
                        : `Checked in — queue position ${r.queuePosition ?? '—'}`}
                  </span>
                </li>
              )
            })}
          </ul>
          <button
            type="button"
            onClick={() => {
              setRaw('')
              setPhase({ step: 'entry' })
            }}
            className="mt-4 min-h-[44px] rounded border border-slate-500 px-5 font-medium"
          >
            Reconcile another batch
          </button>
        </div>
      )}
    </div>
  )
}

function Summary({ results }: { results: ReconcileResult[] }) {
  const failed = results.filter((r) => r.outcome.startsWith('error')).length
  const already = results.filter((r) => r.outcome === 'already').length
  const added = results.length - failed - already

  return (
    <p className="mt-2" role="status">
      {added} checked in, {already} already checked in,{' '}
      {/* Failures are stated even when zero, so "0 failed" is a fact the Coordinator read
          rather than an absence they had to infer. */}
      <strong className={failed > 0 ? 'text-red-400' : undefined}>{failed} failed</strong>.
    </p>
  )
}
