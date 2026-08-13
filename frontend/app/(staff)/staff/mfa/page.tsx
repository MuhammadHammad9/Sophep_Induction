/**
 * MFA enrolment and challenge.
 *
 * One route, two states, because they are the same conversation at different points: "set up
 * your authenticator" and "prove you still have it". Splitting them into two URLs would mean a
 * volunteer bounced between them by a stale redirect.
 *
 * WHO IS CHALLENGED, AND WHO IS NOT. `MFA_REQUIRED_ROLES` is super_admin, coordinator and
 * admin. Volunteers and interviewers are deliberately excluded: they are the
 * lowest-proficiency, highest-time-pressure class working in the worst physical conditions, and
 * an authenticator app at a check-in desk costs more than it protects. rules.md §7 puts
 * volunteer ergonomics above everything except correctness, and this is exactly that trade
 * (NFR-USE-001, FR-RBAC-008).
 *
 * Refs: FR-RBAC-008, NFR-SEC-001, NFR-USE-001, NFR-A11Y-003, NFR-A11Y-007, audit H-6
 */

import { redirect } from 'next/navigation'
import { requireStaff } from '@/lib/auth/session'
import { MfaForm } from './MfaForm'

export const dynamic = 'force-dynamic'

export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; challenge?: string }>
}) {
  const { next, challenge } = await searchParams

  const staff = await requireStaff()
  if (!staff) redirect('/staff/sign-in?next=/staff/mfa')

  const target = safeNext(next)

  // Already done, or never needed. Sending them on rather than showing a form for a factor
  // they do not owe — a page that asks for something unnecessary trains people to ignore it.
  if (!staff.mfaRequired || (staff.mfaEnrolled && staff.mfaSatisfied)) {
    redirect(target)
  }

  const mode = staff.mfaEnrolled || challenge === '1' ? 'challenge' : 'enrol'

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-h1">
        {mode === 'enrol' ? 'Set up your authenticator' : 'Enter your code'}
      </h1>

      <p className="mt-2 text-text-muted">
        {mode === 'enrol' ? (
          <>
            Your role can change results, so it needs a second factor as well as your email
            link. This takes about a minute and you only do it once.
          </>
        ) : (
          <>
            Open your authenticator app and enter the current six-digit code for SOPHEP.
          </>
        )}
      </p>

      <MfaForm mode={mode} next={target} email={staff.email} />

      {mode === 'challenge' && (
        <p className="mt-8 text-small text-text-muted">
          Lost your authenticator? A Super Admin can reset it for you — it cannot be recovered
          from this screen, which is what makes it a second factor.
        </p>
      )}
    </main>
  )
}

/** Same-origin absolute paths only. `//host` is not one — browsers read it as another site. */
function safeNext(next: string | undefined): string {
  if (!next) return '/'
  if (!next.startsWith('/') || next.startsWith('//')) return '/'
  return next
}
