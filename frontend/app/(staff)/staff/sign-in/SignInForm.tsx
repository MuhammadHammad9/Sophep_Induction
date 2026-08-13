'use client'

/**
 * The sign-in form itself.
 *
 * Accessibility is not decoration here (rules.md §6, all BLOCKING): a programmatically
 * associated label, `inputmode="email"` so the phone offers the right keyboard, a 44px target,
 * a visible focus ring, and the result announced through `role="alert"` so it reaches a screen
 * reader rather than only appearing on screen.
 *
 * The success and failure states deliberately read the SAME. Distinguishing them would turn
 * this box into an oracle for which addresses hold SOPHEP accounts, and the staff list is
 * precisely what makes a phishing run targeted (NFR-PRIV-005).
 */

import { useState, type FormEvent } from 'react'
import { createClient } from '@/lib/supabase/client'

export function SignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (status === 'sending') return
    setStatus('sending')

    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        // No self-service account creation. Membership is granted by a Coordinator per cycle
        // (FR-RBAC-002); an unknown address must not be able to mint itself a user row.
        shouldCreateUser: false,
      },
    })

    // `error` is not surfaced to the user for the reason in the file header — but it is worth
    // having in the console when a volunteer is on the phone to whoever set this up.
    if (error) console.warn('sign-in request failed', error.message)

    setStatus('sent')
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
      <div>
        <label htmlFor="staff-email" className="block text-small font-medium">
          Email address
        </label>
        <input
          id="staff-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={status === 'sending' || status === 'sent'}
          className="mt-1 min-h-[44px] w-full rounded-control border border-border bg-surface px-3
                     text-body focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
                     focus-visible:ring-state-called disabled:opacity-60"
        />
      </div>

      <button
        type="submit"
        disabled={status === 'sending' || status === 'sent' || email.trim().length < 3}
        className="min-h-[44px] w-full rounded-control bg-state-called px-4 font-medium text-white
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
                   focus-visible:ring-state-called disabled:opacity-50"
      >
        {status === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
      </button>

      {/* NFR-A11Y-005: announced, not merely rendered. */}
      <div role="alert" aria-live="polite">
        {status === 'sent' && (
          <div className="rounded-card border border-state-called/30 bg-state-called-fill p-4">
            <p className="font-medium">Check your email</p>
            <p className="mt-1 text-small text-text-muted">
              If <span className="id-text">{email.trim()}</span> belongs to a SOPHEP staff
              account, a sign-in link is on its way. It is valid for one hour and can be used
              once.
            </p>
          </div>
        )}
      </div>
    </form>
  )
}
