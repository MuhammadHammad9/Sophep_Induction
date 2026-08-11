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
import { withContext } from '@sophep/backend'

export interface StaffSession {
  userId: string
  email: string
  cycleId: string
  roles: string[]
  context: SecurityContext
}

/**
 * Supabase client bound to the request's cookies.
 *
 * Deliberately does NOT use the service-role key: that key bypasses RLS entirely, and a
 * request path holding it would silently undo migration 0010's whole purpose.
 */
export async function supabaseServer() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
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
export async function requireStaff(_req: Request): Promise<StaffSession | null> {
  const supabase = await supabaseServer()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user?.email) return null

  // Map the Supabase auth user onto our own users row and its memberships. The two are
  // deliberately separate: `users` predates auth and carries the cycle-scoped roles.
  const email = user.email

  type MembershipRow = { user_id: string; cycle_id: string; role: string }

  const rows = await withContext({}, (tx) =>
    tx<MembershipRow[]>`
      SELECT u.id AS user_id, m.cycle_id, m.role
        FROM users u
        JOIN memberships m ON m.user_id = u.id AND m.revoked_at IS NULL
        JOIN cycles c ON c.id = m.cycle_id
       WHERE (u.auth_user_id = ${user.id}::uuid OR u.email = ${email})
         AND u.disabled_at IS NULL
         AND c.state <> 'archived'
       ORDER BY c.year DESC, c.season
    `.then((r) => [...r] as MembershipRow[]),
  )

  if (rows.length === 0) return null

  const cycleId = rows[0]!.cycle_id
  const userId = rows[0]!.user_id

  // E13: capabilities are the UNION across every role held in this cycle. A Coordinator who
  // also interviews is normal, and v1's gate would have silently denied the second role.
  const roles = rows.filter((r) => r.cycle_id === cycleId).map((r) => r.role)

  return {
    userId,
    email,
    cycleId,
    roles,
    context: {
      userId,
      // Recorded on every audit row so "which hat were they wearing" is answerable later.
      actorRole: roles[0] ?? 'volunteer',
      actorLabel: email,
    },
  }
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
