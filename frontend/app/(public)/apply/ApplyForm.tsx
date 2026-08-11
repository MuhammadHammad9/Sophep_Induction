'use client'

/**
 * The public application form.
 *
 * Accessibility is not decoration here — every control has a programmatically associated
 * label and an appropriate inputmode (R-066, NFR-A11Y-007), errors are announced via a live
 * region (R-064), and targets meet 44px (R-061).
 *
 * Client-side validation exists for immediate feedback only. The server re-validates
 * everything (FR-REG-003) — this is ergonomics, not a gate.
 */

import { useState, useId } from 'react'
import { registrationInputSchema } from '@sophep/backend'

export interface Department {
  id: string
  name: string
}

interface FieldErrors {
  [field: string]: string
}

export function ApplyForm({
  cycleId,
  departments,
  maxPreferences,
}: {
  cycleId: string
  departments: Department[]
  maxPreferences: number
}) {
  const formId = useId()
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [banner, setBanner] = useState<string | null>(null)
  const [result, setResult] = useState<{ displayId: string; statusUrl: string } | null>(null)
  const [preferences, setPreferences] = useState<string[]>([])

  function togglePreference(id: string) {
    setPreferences((prev) => {
      if (prev.includes(id)) return prev.filter((p) => p !== id)
      if (prev.length >= maxPreferences) return prev
      return [...prev, id]
    })
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitting(true)
    setErrors({})
    setBanner(null)

    const data = new FormData(e.currentTarget)

    const payload = {
      cycleId,
      fullName: data.get('fullName'),
      email: data.get('email'),
      phone: data.get('phone'),
      rollNumber: data.get('rollNumber') || null,
      preferences,
      answers: {},
      source: 'online',
    }

    const parsed = registrationInputSchema.safeParse(payload)
    if (!parsed.success) {
      const fieldErrors: FieldErrors = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as string
        if (key && !fieldErrors[key]) fieldErrors[key] = issue.message
      }
      setErrors(fieldErrors)
      setBanner('Please correct the highlighted fields.')
      setSubmitting(false)
      return
    }

    try {
      const res = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const body = await res.json().catch(() => null)
      
      if (res.ok) {
        setResult(body)
        return
      }

      if (body?.error?.detail && typeof body.error.detail === 'object') {
        setErrors(body.error.detail as FieldErrors)
      }

      // DUPLICATE_APPLICANT gets a specific message. Telling someone "you have already applied"
      // and pointing them at their existing record is far more useful than a generic failure,
      // and it is the most common non-happy path on this form.
      setBanner(
        body?.error?.code === 'DUPLICATE_APPLICANT'
          ? 'You have already applied with these details. Check your email for your applicant ID, or ask at the desk.'
          : (body?.error?.message ?? 'Something went wrong. Please try again.'),
      )
    } catch (err) {
      setBanner('Network error. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (result) {
    return (
      <div role="status" className="rounded-card border border-state-complete/30 bg-state-complete-fill p-6">
        <h2 className="text-h2 text-state-complete">Application received</h2>
        <p className="mt-2">Your applicant ID is</p>
        <p className="id-text mt-1 text-id-xl text-text">{result.displayId}</p>
        <p className="mt-4 text-small">
          We have emailed you a link to your status page. Open it on interview day and show the
          QR code at the check-in desk — there is nothing to print.
        </p>
        <a
          href={result.statusUrl}
          className="mt-4 inline-flex touch-target items-center rounded-control bg-primary px-4 py-2 text-white hover:bg-primary-hover"
        >
          Open my status page
        </a>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {/* R-064: announced to assistive technology the moment it appears. */}
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
        hint="We send your applicant ID and result here, so check it is correct."
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
        hint="Any format is fine — 0300-1234567 or +92 300 1234567."
      />

      <Field
        id={`${formId}-roll`}
        name="rollNumber"
        label="Roll number"
        autoComplete="off"
        error={errors['rollNumber']}
        hint="Optional."
      />

      <fieldset>
        <legend className="font-semibold">
          Department preferences{' '}
          <span className="font-normal text-text-muted">
            — choose up to {maxPreferences}, in order
          </span>
        </legend>

        <p className="mt-1 text-small text-text-muted">
          {preferences.length} of {maxPreferences} selected. Your first choice is the one you
          pick first.
        </p>

        <ul className="mt-3 space-y-2">
          {departments.map((d) => {
            const rank = preferences.indexOf(d.id)
            const selected = rank !== -1
            const full = !selected && preferences.length >= maxPreferences

            return (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => togglePreference(d.id)}
                  disabled={full}
                  aria-pressed={selected}
                  aria-label={
                    selected
                      ? `Remove ${d.name} (currently preference ${rank + 1})`
                      : full
                        ? `Limit reached, cannot select ${d.name}`
                        : `Select ${d.name} as preference ${preferences.length + 1}`
                  }
                  className={`flex w-full touch-target items-center justify-between rounded-control border px-4 py-3 text-left ${
                    selected
                      ? 'border-primary bg-state-live-fill'
                      : 'border-border bg-surface hover:border-border-strong'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <span>{d.name}</span>
                  {selected ? (
                    <span className="id-text rounded-pill bg-primary px-2 py-0.5 text-caption text-white">
                      {rank + 1}
                    </span>
                  ) : full ? (
                    // R-058 / NFR-USE-006: a disabled control always states why.
                    <span className="text-caption text-text-muted">Limit reached</span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      </fieldset>

      <button
        type="submit"
        disabled={submitting}
        className="w-full touch-target rounded-control bg-primary px-6 py-3 font-semibold text-white hover:bg-primary-hover disabled:opacity-60"
      >
        {submitting ? 'Submitting…' : 'Submit application'}
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
