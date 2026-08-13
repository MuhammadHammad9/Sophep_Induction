import { test, expect, type BrowserContext } from '@playwright/test'

/**
 * The signed-in staff flow — the half of the suite that was never covered.
 *
 * Every other browser test asserts a REFUSAL. That is the important half, but on its own it is
 * also the half that a completely broken app would pass: a server returning 401 to everything
 * satisfies every "anonymous is refused" assertion perfectly. Until this file, nothing
 * demonstrated that a legitimate staff member can get in at all — and for most of this
 * project's life they could not, because `requireStaff` was a bootstrap deadlock that returned
 * null for everyone (audit H-6).
 *
 * HOW THE SESSION IS ESTABLISHED. `requireStaff` calls `supabase.auth.getUser()`, which
 * verifies the JWT against the Supabase Auth server. `tests/e2e/support/auth-stub.mjs` stands
 * in for that server; the APPLICATION IS UNCHANGED. Everything downstream is real: real cookie
 * parsing by @supabase/ssr, real `fn_resolve_staff_session`, real capability lookup, real RLS.
 *
 * The cookie name is not guesswork — supabase-js derives its storage key as
 * `sb-${hostname.split('.')[0]}-auth-token`, so an auth URL of `http://127.0.0.1:54321` gives
 * `sb-127-auth-token`, and @supabase/ssr reads a `base64-` prefixed JSON session.
 *
 * Refs: FR-CHK-010, FR-RBAC-002, FR-RBAC-004, audit C-1, H-6
 */

const AUTH_USER_ID = '11111111-1111-4111-8111-111111111111'

/** The shape @supabase/ssr expects to find in the cookie. */
function sessionCookieValue(): string {
  const session = {
    access_token: 'e2e-stub-access-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'e2e-stub-refresh-token',
    user: {
      id: AUTH_USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'volunteer@test.sophep',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  }
  return `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64')}`
}

async function signIn(context: BrowserContext, baseURL: string) {
  await context.addCookies([
    {
      name: 'sb-127-auth-token',
      value: sessionCookieValue(),
      url: baseURL,
      httpOnly: false,
      sameSite: 'Lax',
    },
  ])
}

test.describe('signed-in staff', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await signIn(context, baseURL!)
  })

  test('reaches the fast-track desk instead of being redirected', async ({ page }) => {
    // The counterpart to the C-1 assertions: the endpoint is closed to strangers AND open to
    // the people who need it. A fix that locked everyone out would pass those and fail this.
    await page.goto('/fast-track')

    await expect(page).not.toHaveURL(/\/staff\/sign-in/)
    await expect(page.getByRole('heading', { name: /fast-track/i })).toBeVisible()
  })

  test('the sign-in page sends an already-authenticated user onward', async ({ page }) => {
    await page.goto('/staff/sign-in')
    // Showing a sign-in form to someone already signed in is the kind of dead end that makes a
    // volunteer think the system is broken (R-058).
    await expect(page).not.toHaveURL(/\/staff\/sign-in$/)
  })

  test('registers a walk-in and checks them into the queue', async ({ page }) => {
    // FR-CHK-010 end to end, through the real UI: register a person who never applied online
    // and put them in the live queue in one pass.
    await page.goto('/fast-track')
    await expect(page.getByRole('heading', { name: /fast-track/i })).toBeVisible()

    const unique = Date.now()
    await page.getByLabel(/full name|name/i).first().fill(`E2E Walkin ${unique}`)
    await page.getByLabel(/email/i).first().fill(`walkin-${unique}@example.com`)
    await page.getByLabel(/phone/i).first().fill(`0300${String(unique).slice(-7)}`)

    await page.getByRole('button', { name: /register|check.?in|submit/i }).first().click()

    // The desk needs the identifier read back — it is what the applicant is called for.
    await expect(page.getByText(/SPH-[A-Z]{2}\d{2}-\d{4}/)).toBeVisible({ timeout: 15_000 })
  })

  test('an API write still requires a same-origin request', async ({ page, baseURL }) => {
    // Being signed in must NOT make CSRF irrelevant — an authenticated session is precisely
    // what a cross-origin write would be trying to borrow (audit C-7).
    const response = await page.request.post(`${baseURL}/api/fast-track`, {
      headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
      data: { fullName: 'CSRF Attempt', email: 'x@x.com', phone: '03001234567' },
    })
    expect(response.status()).toBe(403)
  })
})
