/**
 * Staff sessions.
 *
 * FR-RBAC-004 requires three enforcement layers: row-level database policy, API middleware,
 * and the UI. This is the middle one. It is NOT the security boundary — RLS is (migrations
 * 0008 and 0017), and it holds even if this file is bypassed entirely. What this layer buys is
 * a clean 403 with a machine-readable reason instead of a confusing empty result set.
 *
 * The UI layer is ergonomics only, never security (rules.md R-032).
 *
 * Refs: FR-RBAC-004, FR-RBAC-006, FR-RBAC-007, IR-002
 */

import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { SecurityContext } from '@sophep/backend'
import { withContext, mfaStatus } from '@sophep/backend'

export interface StaffSession {
  userId: string
  email: string
  cycleId: string
  roles: string[]
  context: SecurityContext
  /** FR-RBAC-008: this account's roles require a second factor. */
  mfaRequired: boolean
  /** An authenticator is enrolled and enabled. */
  mfaEnrolled: boolean
  /** This browser has answered the challenge within the cookie's lifetime. */
  mfaSatisfied: boolean
}

/**
 * Marks a browser that has answered the MFA challenge.
 *
 * Convenience, never the control. `requireStaff` re-derives `mfaRequired` from memberships on
 * every request, so forging this cookie skips a prompt for a session that has already
 * authenticated — it grants nothing on its own. The actual gate is `requireMfa` below, and
 * underneath that, the database.
 */
export const MFA_COOKIE = 'sophep_mfa'

/**
 * Supabase client bound to the request's cookies.
 *
 * Deliberately does NOT use the service-role key: that key bypasses RLS entirely, and a
 * request path holding it would silently undo migration 0010's whole purpose.
 */
export async function supabaseServer() {
  const cookieStore = await cookies()

  const url = process.env['NEXT_PUBLIC_SUPABASE_URL']
  const key = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']
  if (!url || !key) {
    throw new Error('Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set')
  }

  return createServerClient(
    url,
    key,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => {
          try {
            for (const { name, value, options } of toSet) {
              cookieStore.set(name, value, options as never)
            }
          } catch {
            // Called from a Server Component, where cookies are read-only. Session refresh
            // happens in middleware instead; ignoring here is the documented pattern.
          }
        },
      },
    },
  )
}

/**
 * Resolve the caller to a staff member with a membership in the active cycle.
 *
 * Returns null rather than throwing, so callers decide the status code. A user who is
 * authenticated but holds no membership in this cycle is NOT staff here — role assignment is
 * cycle-scoped (FR-RBAC-002), and last year's volunteer is not this year's.
 */
export async function requireStaff(): Promise<StaffSession | null> {
  const supabase = await supabaseServer()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  // ── WHY THIS GOES THROUGH A SECURITY DEFINER FUNCTION ─────────────────────────────────
  //
  // The previous implementation ran an ordinary query under `withContext({})` — an EMPTY
  // security context — against `users` and `memberships`. Both policies on `memberships`
  // compare against `fn_current_user_id()`, which is NULL when unset, and every comparison
  // against NULL denies. So the query returned zero rows and `requireStaff` returned null for
  // everyone, always. Every staff endpoint answered 401.
  //
  // That is not a bug in the policies. They fail closed exactly as R-014 requires. It is a
  // genuine chicken-and-egg: the security context is BUILT FROM the caller's memberships, and
  // the memberships cannot be read without a security context.
  //
  // Migration 0011 solved the same shape of problem for applicants — the status page must
  // resolve a token before any context can exist, so it goes through `fn_resolve_token`,
  // scoped by the credential itself. `fn_resolve_staff_session` (migration 0037) is the staff
  // equivalent, scoped by the Supabase auth uid.
  //
  // The trust argument is the same in both cases: the key IS the credential. `getUser()` above
  // verifies the JWT against the auth server before we get here, so `user.id` is an identity
  // the caller has already proven rather than one they asserted.
  //
  // Note what is NOT passed: the email address. The old lookup matched
  // `auth_user_id = $1 OR email = $2`, and that second branch is an account-takeover path the
  // moment the project permits an unverified address or a provider returns one — sign up as
  // coordinator@…, inherit their capabilities. Identity is the verified uid and nothing else.
  type SessionRow = {
    user_id: string
    email: string
    full_name: string
    cycle_id: string
    cycle_name: string
    cycle_state: string
    role: string
    capabilities: string[]
  }

  const rows = await withContext({}, (tx) =>
    tx<SessionRow[]>`
      SELECT * FROM fn_resolve_staff_session(${user.id}::uuid)
    `.then((r) => [...r] as SessionRow[]),
  )

  // Authenticated but holding no membership in any live cycle is NOT staff here. Role
  // assignment is cycle-scoped (FR-RBAC-002) — last year's volunteer is not this year's.
  if (rows.length === 0) return null

  // The function orders by year then season CHRONOLOGICALLY (migration 0037). The previous
  // `ORDER BY c.year DESC, c.season` sorted season as text, so 'FA' < 'SP' < 'SU'
  // alphabetically — not calendar order — and a user with two live cycles was bound to
  // whichever happened to sort first.
  const active = rows[0]!
  const cycleId = active.cycle_id
  const userId = active.user_id

  // E13: capabilities are the UNION across every role held IN THIS CYCLE. A Coordinator who
  // also interviews is ordinary, and v1's gate silently denied the second role.
  const activeRows = rows.filter((r) => r.cycle_id === cycleId)
  const roles = activeRows.map((r) => r.role)
  const capabilities = Array.from(
    new Set(activeRows.flatMap((r) => r.capabilities ?? [])),
  ).join(',')

  const context: SecurityContext = {
    userId,
    // Recorded on every audit row so "which hat were they wearing" is answerable later.
    actorRole: roles[0] ?? 'volunteer',
    actorLabel: active.email,
    capabilities,
  }

  // Derived from memberships inside the database (migration 0045), never from the roles array
  // above — the two agree today, and the database is the one that still agrees if this file is
  // bypassed entirely (R-032).
  const mfa = await withContext(context, (tx) => mfaStatus(tx))

  const jar = await cookies()
  const mfaSatisfied = jar.get(MFA_COOKIE)?.value === userId

  return {
    userId,
    email: active.email,
    cycleId,
    roles,
    context,
    mfaRequired: mfa.required,
    mfaEnrolled: mfa.enrolled,
    mfaSatisfied,
  }
}

/**
 * The MFA gate for a privileged surface.
 *
 * Returns a redirect target when the caller still owes a second factor, or null when they do
 * not. Split from `requireStaff` on purpose: an unauthenticated caller and a caller who simply
 * has not typed their code yet need completely different treatment, and collapsing them would
 * bounce a signed-in coordinator back to sign-in with no explanation (R-058).
 *
 * NFR-SEC-001 requires the second factor for privileged roles. A volunteer is deliberately not
 * challenged — they are the lowest-proficiency, highest-time-pressure class, and an
 * authenticator app at a check-in desk costs more than it protects (NFR-USE-001, §7 priority 2).
 */
export function mfaRedirect(staff: StaffSession, next: string): string | null {
  if (!staff.mfaRequired) return null
  if (!staff.mfaEnrolled) return `/staff/mfa?next=${encodeURIComponent(next)}`
  if (!staff.mfaSatisfied) return `/staff/mfa?challenge=1&next=${encodeURIComponent(next)}`
  return null
}

/** The API-layer equivalent: a machine-readable 403 rather than a redirect. */
export function mfaRequiredResponse() {
  return NextResponse.json(
    {
      error: {
        code: 'DUAL_CONTROL_REQUIRED',
        message: 'This action needs your authenticator code',
        detail: { reason: 'mfa_required' },
        retryable: false,
      },
    },
    { status: 403 },
  )
}

/**
 * Check a capability before acting.
 *
 * Mirrors fn_has_capability so the API can return a clear 403 rather than letting RLS return
 * an empty set that the UI would have to interpret. RLS remains the actual control.
 */
export async function hasCapability(
  session: StaffSession,
  capability: string,
): Promise<boolean> {
  return withContext(session.context, async (tx) => {
    const rows = await tx<Array<{ allowed: boolean }>>`
      SELECT fn_has_capability(${session.cycleId}::uuid, ${capability}) AS allowed
    `
    return rows[0]?.allowed ?? false
  })
}

export function unauthorized() {
  return NextResponse.json(
    {
      error: {
        code: 'TOKEN_INVALID',
        message: 'Sign in to continue',
        retryable: false,
      },
    },
    { status: 401 },
  )
}

/**
 * A malformed request, in the IR-002 shape.
 *
 * Exists because several routes were returning bare `{ error: 'Unauthorized' }` strings, or
 * letting an invalid route param reach a `::uuid` cast and answering 500. R-057 allows exactly
 * fourteen codes and requires `code`, `message`, `detail` and `retryable` — a client that has
 * to distinguish "your input was wrong" from "the server broke" by reading prose cannot decide
 * whether to retry, and the offline queue's replay logic turns on precisely that.
 */
export function invalid(message: string, detail?: Record<string, unknown>) {
  return NextResponse.json(
    {
      error: {
        code: 'INVALID_TRANSITION',
        message,
        ...(detail ? { detail } : {}),
        retryable: false,
      },
    },
    { status: 400 },
  )
}

export function forbidden(capability: string) {
  // NFR-USE-006 / R-058: never a bare denial. The response says which capability was missing
  // so the interface can explain rather than showing a dead control.
  return NextResponse.json(
    {
      error: {
        code: 'DUAL_CONTROL_REQUIRED',
        message: 'You do not have permission to do that',
        detail: { required_capability: capability },
        retryable: false,
      },
    },
    { status: 403 },
  )
}
