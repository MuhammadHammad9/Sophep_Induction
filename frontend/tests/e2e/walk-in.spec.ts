import { test, expect } from '@playwright/test'

/**
 * Walk-in registration — the fast-track desk.
 *
 * ⚠ THIS SPEC PREVIOUSLY ASSERTED A SECURITY HOLE AS THE EXPECTED BEHAVIOUR.
 *
 * It navigated straight to `/fast-track`, filled the form and submitted, with no authentication
 * anywhere in it — because at the time the page and its API route had none. That endpoint
 * registered an applicant AND checked them into the live interview queue for anyone on the
 * internet (audit C-1, the worst of the critical findings).
 *
 * A passing test for that flow is worse than no test: it is a standing statement that the
 * unauthenticated path is correct, and the next person to "fix the failing test" would have
 * reopened the hole to make it green again.
 *
 * So the unauthenticated case is now asserted as a REFUSAL, which is the actual requirement,
 * and the authenticated flow is marked `fixme` rather than deleted — deleting it would lose the
 * FR-CHK-010 coverage entirely and quietly reduce what this suite claims to check. It needs a
 * signed-in staff fixture (magic link + MFA challenge), which is the next piece of work.
 *
 * Refs: FR-CHK-010, FR-RBAC-004, rules.md R-032, audit C-1, H-6
 */

test.describe('fast-track is staff-only', () => {
  test('an anonymous visitor cannot reach the walk-in form', async ({ page }) => {
    await page.goto('/fast-track')

    // Redirected, not rendered. The form must never be reachable without a session.
    await expect(page).toHaveURL(/\/staff\/sign-in/)
    await expect(page.locator('input[name="full_name"]')).toHaveCount(0)
  })

  test('the API refuses an anonymous walk-in registration', async ({ request }) => {
    // The page redirect is ergonomics; this is the control (R-032). Posting directly bypasses
    // the UI entirely, which is exactly what the original attack did.
    const response = await request.post('/api/fast-track', {
      data: {
        cycleId: '00000000-0000-4000-8000-000000000000',
        stageId: '00000000-0000-4000-8000-000000000000',
        fullName: 'Ghost Applicant',
        email: 'ghost@example.com',
        phone: '03001234567',
      },
    })

    expect(response.status()).toBe(401)
    const body = (await response.json()) as { error?: { code?: string } }
    // IR-002: machine-readable, so a client can tell "sign in" from "try again" (R-057).
    expect(body.error?.code).toBe('TOKEN_INVALID')
  })
})

/**
 * The signed-in half of FR-CHK-010 now lives in `signed-in.spec.ts`, which drives it through
 * the real UI against a doubled auth server and asserts the resulting rows. It is not
 * duplicated here — a permanently-skipped test reads as missing coverage when the coverage
 * exists, which is its own kind of dishonest reporting.
 */
