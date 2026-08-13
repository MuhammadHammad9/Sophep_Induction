/**
 * Staff sign-in.
 *
 * This route did not exist. Every staff page redirects here — `redirect('/staff/sign-in')` in
 * checkin, panel, interview, ops and fast-track — and the destination was a 404. Combined with
 * the bootstrap deadlock in `requireStaff` (migration 0037), no staff member could reach any
 * staff surface at all (audit H-6).
 *
 * WHY A MAGIC LINK RATHER THAN A PASSWORD FIELD.
 *
 * The people using this are student volunteers, on their own phones, in a noisy hall, having
 * had fifteen minutes of training. A password is one more thing to have forgotten at 8:50am on
 * the morning of the event, and a password reset flow is a support queue nobody is staffing.
 * An emailed link needs nothing memorised and nothing typed but an address they already know.
 *
 * It is also the option that keeps this file out of the credential business entirely: Supabase
 * Auth owns the token exchange, and nothing here ever sees or stores a secret.
 *
 * MFA (`domain/totp.ts`) is implemented and unit-tested but not yet wired to a route. It is
 * required for privileged roles by NFR-SEC-001, and the enrolment surface is the next piece —
 * `fn_record_totp_use` is already hardened so it cannot be used against another account
 * (migration 0038). Until that lands, this page is honest about it rather than implying a
 * second factor exists.
 *
 * Refs: FR-RBAC-001, FR-RBAC-002, NFR-USE-001, NFR-A11Y-003, NFR-A11Y-007, audit H-6
 */

import { redirect } from 'next/navigation'
import { requireStaff } from '@/lib/auth/session'
import { SignInForm } from './SignInForm'

export const dynamic = 'force-dynamic'

export default async function StaffSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams

  // Already signed in and holding a membership — go where they were headed.
  const staff = await requireStaff()
  if (staff) redirect(safeNext(next))

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-h1">Staff sign-in</h1>
      <p className="mt-2 text-text-muted">
        Enter the address your SOPHEP account uses. We will email you a link that signs you in —
        there is no password to remember.
      </p>

      <SignInForm next={safeNext(next)} />

      <p className="mt-8 text-small text-text-muted">
        Signing in does not grant access on its own. Your role is assigned per cycle, so an
        account from a previous induction will need a Coordinator to add it to this one.
      </p>
    </main>
  )
}

/**
 * Only same-origin, absolute paths.
 *
 * `next` comes from the query string, so it is attacker-controlled. Passing it through would
 * make this an open redirect: a link to our own real sign-in page that lands on someone else's
 * site afterwards — which is exactly the shape of a credible phishing hop, made more credible
 * by starting on the genuine domain.
 *
 * `//evil.com` is the case a naive `startsWith('/')` check misses: browsers read it as a
 * protocol-relative URL to another host.
 */
function safeNext(next: string | undefined): string {
  if (!next) return '/'
  if (!next.startsWith('/') || next.startsWith('//')) return '/'
  return next
}
