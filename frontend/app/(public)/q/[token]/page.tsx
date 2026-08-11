/**
 * The applicant status page.
 *
 * Two hundred anxious people stare at this for up to an hour. It must answer three questions
 * without scrolling and without being read: am I in, where am I, what do I do now (spec §19.1,
 * NFR-USE-005).
 *
 * Phase 1 covers the pre-event states. Queue position, the called state that takes over the
 * whole viewport, and live updates arrive in Phase 2 — but the structure below is already the
 * one those states slot into, because retrofitting the layout would mean redesigning the
 * highest-stakes screen under deadline.
 *
 * Refs: FR-IDT-006, NFR-PRIV-005, NFR-USE-005, NFR-USE-007
 */

import { notFound } from 'next/navigation'
import { hashToken, withContext } from '@sophep/backend'
import { StatusBand, type UiState } from '@/components/state/StateBadge'

export const dynamic = 'force-dynamic'

interface StatusView {
  displayId: string
  fullName: string
  state: string
  cycleName: string
}

/**
 * Resolve a raw token to its applicant.
 *
 * The token is hashed here and only the hash reaches the database (rules.md R-022).
 *
 * Resolution goes through fn_resolve_token rather than a direct join, because access_tokens
 * has no applicant-facing read policy and must not get one — a readable token table is a
 * credential-harvesting surface. The function is scoped by the hash, returns named columns
 * only, and enforces revocation and expiry itself (migration 0011).
 */
async function loadStatus(rawToken: string): Promise<StatusView | null> {
  // The QR payload is `<token>.<signature>` from Phase 2 onward. Strip any signature so a
  // Phase 2 QR still resolves here.
  const token = rawToken.split('.')[0] ?? ''
  if (!token) return null

  const tokenHash = hashToken(token)

  return withContext({}, async (tx) => {
    const rows = await tx<
      Array<{
        applicant_id: string
        display_id: string
        full_name: string
        state: string
        cycle_name: string
      }>
    >`SELECT * FROM fn_resolve_token(${tokenHash}::bytea)`

    const row = rows[0]
    if (!row) return null

    return {
      displayId: row.display_id,
      fullName: row.full_name,
      state: row.state,
      cycleName: row.cycle_name,
    }
  })
}

/** Phase 1 states. Phase 2 adds queued / called / in_interview with the position display. */
const PRESENTATION: Record<string, { state: UiState; headline: string; guidance: string }> = {
  submitted: {
    state: 'waiting',
    headline: 'Application received',
    guidance: 'We will email you when interview day is confirmed.',
  },
  eligible: {
    state: 'waiting',
    headline: "You're registered",
    guidance: 'Check in at the desk when you arrive on interview day.',
  },
  screened_out: {
    state: 'blocked',
    headline: 'Not eligible this cycle',
    guidance: 'Speak to a coordinator if you think this is a mistake.',
  },
  withdrawn: {
    state: 'blocked',
    headline: 'Application withdrawn',
    guidance: 'Contact SOPHEP if you did not intend to withdraw.',
  },
}

export default async function StatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const status = await loadStatus(token)

  // A revoked, expired or unknown token is a 404 rather than a distinct error. Confirming
  // that a token merely expired tells an attacker their guess was structurally valid.
  if (!status) notFound()

  const view = PRESENTATION[status.state] ?? {
    state: 'live' as UiState,
    headline: 'In progress',
    guidance: 'Your status page will update automatically.',
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 p-5">
      {/* 1. ID chip — mono, always visible, top of screen (§19.1) */}
      <div className="flex items-center justify-between">
        <span className="id-text rounded-pill border border-border-strong bg-surface px-3 py-1 text-id-md">
          {status.displayId}
        </span>
        <span className="text-caption uppercase text-text-muted">{status.cycleName}</span>
      </div>

      {/* 2. Status band — full width, state-coloured, icon + one line */}
      <StatusBand state={view.state} headline={view.headline} />

      {/* 3+4. "The one number" lands here in Phase 2: queue position, or the room number when
          called. Until a queue exists there is genuinely no number to show, and inventing one
          would violate the honesty principle this design is built on. */}

      {/* 5. Guidance — one sentence, plain language */}
      <p className="text-body">{view.guidance}</p>

      <div className="mt-auto space-y-1 border-t border-border pt-4">
        <p className="text-small text-text-muted">{status.fullName}</p>
        {/* 6. Liveness. Phase 1 is a static render, so it says so. Presenting a static page as
            live would be exactly the lie principle 2 exists to prevent. */}
        <p className="text-caption text-text-muted">
          Updated just now · live updates begin on interview day
        </p>
      </div>
    </div>
  )
}
