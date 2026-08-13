'use client'

import { useState, useId } from 'react'

interface FieldErrors {
  [field: string]: string
}

export function FastTrackForm({
  cycleId,
  stageId,
}: {
  cycleId: string
  stageId: string
}) {
  const formId = useId()
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [banner, setBanner] = useState<string | null>(null)
  const [result, setResult] = useState<{ displayId: string; checkInOutcome: string; position: number } | null>(null)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitting(true)
    setErrors({})
    setBanner(null)

    const data = new FormData(e.currentTarget)

    try {
      const res = await fetch('/api/fast-track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cycleId,
          stageId,
          fullName: data.get('fullName'),
          email: data.get('email'),
          phone: data.get('phone'),
          rollNumber: data.get('rollNumber') || null,
          preferences: [],
          answers: {},
        }),
      })

      const body = await res.json().catch(() => null)
      
      if (res.ok) {
        setResult(body)
        return
      }

      if (body?.error?.detail && typeof body.error.detail === 'object') {
        setErrors(body.error.detail as FieldErrors)
      }

      setBanner(
        body?.error?.code === 'DUPLICATE_APPLICANT'
          ? 'Duplicate applicant detected.'
          : (body?.error?.message ?? 'Something went wrong. Please try again.'),
      )
    } catch {
      setBanner('Network error. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (result) {
    return (
      <div role="status" className="rounded-card border border-state-complete/30 bg-state-complete-fill p-6 success-message">
        <h2 className="text-h2 text-state-complete">Checked in!</h2>
        <p className="mt-2">Applicant ID:</p>
        <p className="id-text mt-1 text-id-xl text-text">{result.displayId}</p>
        <p className="mt-4 text-small">
          Outcome: {result.checkInOutcome === 'already' ? 'Already checked in' : 'Successfully checked in'} <br />
          Queue Position: {result.position}
        </p>
        <p className="mt-4 text-sm font-semibold text-warning">
          Note: Ask the applicant to visit the help desk later to complete their department preferences.
        </p>
        <button
          onClick={() => setResult(null)}
          className="mt-4 inline-flex touch-target items-center rounded-control bg-primary px-4 py-2 text-white hover:bg-primary-hover"
        >
          Register Another
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {banner ? (
        <div
          role="alert"
          className="rounded-card border border-state-blocked/30 bg-state-blocked-fill p-4 text-state-blocked"
        >
          {banner}
        </div>
      ) : null}

      <Field
        id={`${formId}-name`}
        name="fullName"
        label="Full name"
        autoComplete="name"
        required
        error={errors['fullName']}
      />

      <Field
        id={`${formId}-email`}
        name="email"
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        error={errors['email']}
      />

      <Field
        id={`${formId}-phone`}
        name="phone"
        label="Phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        required
        error={errors['phone']}
      />

      <Field
        id={`${formId}-roll`}
        name="rollNumber"
        label="Roll number"
        autoComplete="off"
        error={errors['rollNumber']}
        hint="Optional."
      />

      <button
        type="submit"
        disabled={submitting}
        className="w-full touch-target rounded-control bg-primary px-6 py-3 font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
      >
        {submitting ? 'Registering...' : 'Register & Check-in'}
      </button>
    </form>
  )
}

function Field({
  id,
  name,
  label,
  error,
  hint,
  ...rest
}: {
  id: string
  name: string
  label: string
  error?: string
  hint?: string
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined

  return (
    <div>
      <label htmlFor={id} className="block font-medium">
        {label}
        {rest.required ? <span aria-hidden="true"> *</span> : null}
      </label>

      {hint ? (
        <p id={hintId} className="mt-1 text-small text-text-muted">
          {hint}
        </p>
      ) : null}

      <input
        {...rest}
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        className={`mt-2 w-full touch-target rounded-control border px-3 py-2 ${
          error ? 'border-state-blocked' : 'border-border-strong'
        }`}
      />

      {error ? (
        <p id={errorId} className="mt-1 text-small text-state-blocked">
          {error}
        </p>
      ) : null}
    </div>
  )
}
