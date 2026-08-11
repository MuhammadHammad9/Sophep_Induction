'use client'

/**
 * The interviewer evaluation form (spec §19.3, "In interview").
 *
 * What is deliberately ABSENT matters as much as what is present. There is no other
 * interviewer's score, no aggregate, no rank, no shortlist status, and no count of available
 * places (FR-INT-004). None of that is hidden by this component — RLS makes it unreachable
 * (migration 0024). This file simply has nothing to render.
 *
 * ANCHORS APPEAR INLINE beside every criterion. You should not have to remember what a 3
 * means, and an interviewer who is guessing at the scale is producing a number that no later
 * statistical correction can repair.
 *
 * FR-INT-019: never auto-advances, auto-submits, or changes view without an explicit action.
 * An interviewer mid-sentence must never have the screen move under them.
 *
 * Refs: FR-INT-003, FR-INT-004, FR-INT-019, FR-INT-020, NFR-A11Y-003
 */

import { useState, useEffect } from 'react'
import { z } from 'zod'
import { StateBadge } from '@/components/state/StateBadge'

const evaluationSchema = z.object({
  scores: z.array(z.object({ criterionId: z.string().uuid(), score: z.number().int() })).min(1),
  remarks: z.string().trim().max(4000).nullable().optional(),
})

export interface Criterion {
  id: string
  code: string
  name: string
  description: string | null
  weight: number
  anchorMin: string
  anchorMax: string
  anchors: Record<string, string>
}

export interface Applicant {
  displayId: string
  fullName: string
  phone?: string
  answers: Record<string, unknown>
  preferences: Array<{ name: string }>
}

export function EvaluationForm({
  interviewId,
  applicant,
  criteria,
  scaleMin,
  scaleMax,
  targetMinutes,
  startedAt,
  recusalSuggestion,
}: {
  interviewId: string
  applicant: Applicant
  criteria: Criterion[]
  scaleMin: number
  scaleMax: number
  targetMinutes: number
  startedAt: string
  /**
   * FR-INT-018: a human-readable conflict-of-interest prompt, or null.
   *
   * Computed on the SERVER. The comparison needs both parties' details, and the answer is a
   * single sentence — sending the raw inputs to the browser to derive it would be needless
   * exposure (NFR-PRIV-001, minimum collection).
   */
  recusalSuggestion: string | null
  interviewerName?: string
  interviewerPhone?: string | null
}) {
  const [scores, setScores] = useState<Record<string, number>>({})
  const [remarks, setRemarks] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const missing = criteria.filter((c) => scores[c.id] === undefined)

  // Ticks once a minute rather than being read during render — reading the clock in the
  // render body is impure AND would leave the timer frozen at whatever it said on mount.
  const [elapsedMinutes, setElapsedMinutes] = useState(() =>
    Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000),
  )

  useEffect(() => {
    const t = setInterval(() => {
      setElapsedMinutes(Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000))
    }, 30_000)
    return () => clearInterval(t)
  }, [startedAt])

  async function submit() {
    // FR-INT-020: blocked until every criterion is scored. The server enforces this too — a
    // partially-scored evaluation silently changes what the weighted mean means.
    if (missing.length > 0) return

    setSubmitting(true)
    setError(null)

    const payload = {
      scores: criteria.map((c) => ({ criterionId: c.id, score: scores[c.id] as number })),
      remarks: remarks.trim() || null,
    }

    const parsed = evaluationSchema.safeParse(payload)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid evaluation data.')
      setSubmitting(false)
      return
    }

    try {
      const res = await fetch(`/api/interviews/${interviewId}/evaluations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setError(body?.error?.message ?? 'Could not submit')
        return
      }

      setDone(true)
    } catch {
      setError('Network error. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="rounded-card border border-state-complete/30 bg-state-complete-fill p-6">
          <StateBadge state="complete">Evaluation submitted</StateBadge>
          <p className="mt-3 text-body">
            Thank you. You can amend it for the next 15 minutes if you mis-keyed something.
          </p>
          <p className="mt-2 text-small text-text-muted">
            The interview completes once every panel member has submitted.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <span className="id-text text-id-md text-text-muted">{applicant.displayId}</span>
          <h1 className="text-h1">{applicant.fullName}</h1>
        </div>
        {/* A nudge against the target, never a cutoff (spec §9.1). Amber past target so an
            interviewer notices, but nothing is blocked — cutting someone off mid-answer to
            satisfy a timer is worse than running late. */}
        <span
          className={`id-text rounded-pill border px-3 py-1 text-small ${
            elapsedMinutes > targetMinutes
              ? 'border-state-called bg-state-called-fill text-state-called'
              : 'border-border bg-surface text-text-muted'
          }`}
        >
          {elapsedMinutes} min / {targetMinutes} target
        </span>
      </header>

      {/* FR-INT-018: SUGGEST a recusal, never create one. Student societies are small and an
          interviewer will meet their roommate — but a suggestion is a prompt for a human, and
          auto-recusing would silently remove applicants from panels with no one deciding.

          The match is computed on the SERVER: comparing a surname or phone prefix here would
          mean shipping both parties' phone numbers into the browser bundle to answer a
          question the server can answer alone (NFR-PRIV-001, minimum collection). */}
      {recusalSuggestion ? (
        <div className="mb-6 rounded-card border-l-4 border-state-called bg-state-called-fill p-4">
          <StateBadge state="called">Possible conflict of interest</StateBadge>
          <p className="mt-2 text-body">{recusalSuggestion}</p>
          <p className="mt-1 text-small text-text-muted">
            If you know this applicant personally, tell your coordinator and record a recusal
            rather than scoring them. Nothing has been recorded automatically.
          </p>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: what the applicant said */}
        <section aria-labelledby="profile">
          <h2 id="profile" className="text-h2">
            Application
          </h2>

          {applicant.preferences.length > 0 ? (
            <p className="mt-2 text-small text-text-muted">
              Preferences: {applicant.preferences.map((p) => p.name).join(' · ')}
            </p>
          ) : null}

          <dl className="mt-4 space-y-4">
            {Object.entries(applicant.answers).map(([question, answer]) => (
              <div key={question}>
                <dt className="font-medium">{question}</dt>
                <dd className="mt-1 whitespace-pre-wrap text-body text-text-muted">
                  {String(answer)}
                </dd>
              </div>
            ))}
          </dl>

          {Object.keys(applicant.answers).length === 0 ? (
            <p className="mt-4 text-small text-text-muted">
              No written answers — they registered at the desk.
            </p>
          ) : null}
        </section>

        {/* Right: the rubric */}
        <section aria-labelledby="rubric">
          <h2 id="rubric" className="text-h2">
            Evaluation
          </h2>

          <div className="mt-4 space-y-6">
            {criteria.map((criterion) => (
              <fieldset key={criterion.id}>
                <legend className="font-semibold">
                  {criterion.name}{' '}
                  <span className="font-normal text-text-muted">({criterion.weight}%)</span>
                </legend>

                {criterion.description ? (
                  <p className="mt-1 text-small text-text-muted">{criterion.description}</p>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  {Array.from(
                    { length: scaleMax - scaleMin + 1 },
                    (_, i) => scaleMin + i,
                  ).map((value) => {
                    const selected = scores[criterion.id] === value
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() =>
                          setScores((prev) => ({ ...prev, [criterion.id]: value }))
                        }
                        aria-pressed={selected}
                        // NFR-A11Y-003: 44px minimum target, used repeatedly on a tablet.
                        className={`min-h-touch min-w-touch rounded-control border px-4 text-h2 ${
                          selected
                            ? 'border-primary bg-primary text-white'
                            : 'border-border-strong bg-surface hover:border-primary'
                        }`}
                      >
                        {value}
                      </button>
                    )
                  })}
                </div>

                {/* The anchors, inline. This is the cheapest fairness intervention available
                    (FR-INT-006) and it only works if they are visible AT THE MOMENT OF
                    SCORING — a rubric in a folder is a rubric nobody reads. */}
                <dl className="mt-3 space-y-1 text-caption text-text-muted">
                  <div className="flex gap-2">
                    <dt className="id-text shrink-0">{scaleMin}</dt>
                    <dd>{criterion.anchorMin}</dd>
                  </div>
                  {Object.entries(criterion.anchors).map(([value, text]) => (
                    <div key={value} className="flex gap-2">
                      <dt className="id-text shrink-0">{value}</dt>
                      <dd>{text}</dd>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <dt className="id-text shrink-0">{scaleMax}</dt>
                    <dd>{criterion.anchorMax}</dd>
                  </div>
                </dl>
              </fieldset>
            ))}

            <div>
              <label htmlFor="remarks" className="font-semibold">
                Remarks <span className="font-normal text-text-muted">(optional)</span>
              </label>
              <textarea
                id="remarks"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                rows={4}
                className="mt-2 w-full rounded-control border border-border-strong p-3"
              />
            </div>

            {error ? (
              <p role="alert" className="rounded-card border border-state-blocked/30 bg-state-blocked-fill p-3 text-state-blocked">
                {error}
              </p>
            ) : null}

            {/* FR-INT-020 / R-058: the missing criteria are named INLINE rather than shown as
                one error at the bottom, so the interviewer knows which control to go to. */}
            {missing.length > 0 ? (
              <p className="text-small text-text-muted">
                Still to score: {missing.map((c) => c.name).join(', ')}
              </p>
            ) : null}

            <button
              type="button"
              onClick={submit}
              disabled={missing.length > 0 || submitting}
              className="min-h-[56px] w-full rounded-control bg-primary px-6 py-3 text-h2 font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {submitting ? 'Submitting…' : 'Submit evaluation'}
            </button>

            <p className="text-caption text-text-muted">
              Once submitted this is final, but you can amend it for 15 minutes with a reason.
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
