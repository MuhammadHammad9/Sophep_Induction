import { test, expect, type ConsoleMessage } from '@playwright/test'

/**
 * The guard for a class of defect that every other suite is blind to.
 *
 * WHY THIS FILE EXISTS.
 *
 * The 2026-08-12 remediation added a Content-Security-Policy for finding M-1. The header was
 * correct-looking, `curl` confirmed it byte for byte, and all 174 tests passed. It had also
 * broken the entire application: Next.js emits inline <script> tags carrying hydration data,
 * `script-src 'self'` blocked them, React never hydrated, and every client component was dead —
 * the scanner, the forms, the offline replay queue.
 *
 * Nothing caught it because nothing in the suite loads a page in a browser. A header test reads
 * the header; a route test reads the JSON; neither notices that the page arrived and then did
 * nothing. On the day that is a volunteer holding a phone at a check-in desk with a camera that
 * will not scan and a form that will not submit.
 *
 * So these tests assert the things only a browser can see:
 *   - the page HYDRATES (React actually took ownership)
 *   - ZERO CSP violations are reported by the browser itself
 *   - the security headers are present on a real navigation
 *   - the auth gates redirect rather than render
 *
 * Deliberately shallow and fast. This is not a feature suite — it is the tripwire that stops a
 * security header from silently disabling the product.
 *
 * Refs: NFR-SEC-008, NFR-AVAIL-003, audit M-1, and the browser run that found it
 */

/** Collect anything the browser objects to, so a violation cannot pass unnoticed. */
function watchConsole(messages: string[]) {
  return (msg: ConsoleMessage) => {
    if (msg.type() === 'error') messages.push(msg.text())
  }
}

const isCspViolation = (text: string) =>
  /Content Security Policy|violates the following/i.test(text)

/** React error #418/#423/#412 are all hydration failures; #412 is the one CSP caused. */
const isHydrationError = (text: string) =>
  /Minified React error #(412|418|423)|Hydration failed|hydrating/i.test(text)

test.describe('security smoke — the things only a browser can see', () => {
  for (const path of ['/', '/apply', '/staff/sign-in']) {
    test(`${path} loads with no CSP violation and actually hydrates`, async ({ page }) => {
      const errors: string[] = []
      page.on('console', watchConsole(errors))
      page.on('pageerror', (e) => errors.push(String(e.message)))

      const response = await page.goto(path, { waitUntil: 'networkidle' })
      expect(response?.status(), `${path} should render`).toBeLessThan(400)

      // THE ASSERTION THAT WOULD HAVE CAUGHT IT. `__next_f` is the RSC flight stream, populated
      // by exactly the inline scripts a too-strict script-src blocks. If it is missing, the
      // page is a static corpse: it looks right and nothing works.
      const hydrated = await page.evaluate(
        () => typeof (window as unknown as { __next_f?: unknown }).__next_f !== 'undefined',
      )
      expect(hydrated, `${path} did not hydrate — client components are dead`).toBe(true)

      expect(
        errors.filter(isCspViolation),
        `${path} reported CSP violations`,
      ).toEqual([])

      expect(
        errors.filter(isHydrationError),
        `${path} reported hydration errors`,
      ).toEqual([])
    })
  }

  test('security headers are present on a real navigation', async ({ page }) => {
    const response = await page.goto('/apply')
    const headers = response!.headers()

    // NFR-SEC-008. Asserted on a browser navigation rather than a curl, so a middleware matcher
    // that quietly stops covering a route shows up here (audit M-2).
    expect(headers['content-security-policy'], 'CSP missing').toBeTruthy()
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')

    const csp = headers['content-security-policy']!
    // These three are the load-bearing ones that survive the 'unsafe-inline' compromise on
    // scripts. If a future edit drops them, the CSP is decorative.
    expect(csp, "object-src must stay 'none'").toContain("object-src 'none'")
    expect(csp, "frame-ancestors must stay 'none'").toContain("frame-ancestors 'none'")
    expect(csp, "base-uri must stay 'self'").toContain("base-uri 'self'")
  })

  test('the status page refuses a malformed token without leaking', async ({ page }) => {
    const response = await page.goto('/q/not-a-real-token')
    expect(response?.status()).toBe(404)

    // A revoked, expired and unknown token must be indistinguishable. Confirming that a token
    // merely expired tells an attacker their guess was structurally valid (NFR-PRIV-005).
    const body = await page.content()
    expect(body).not.toMatch(/expired|revoked|not found in|stack/i)
  })
})

test.describe('auth gates redirect rather than render', () => {
  // These encode the fix for audit C-1: `/fast-track` was completely unauthenticated and would
  // register an applicant AND check them into the live queue for anyone on the internet.
  for (const path of ['/fast-track', '/ops/00000000-0000-4000-8000-000000000000']) {
    test(`${path} sends an anonymous visitor to sign-in`, async ({ page }) => {
      await page.goto(path)
      await expect(page).toHaveURL(/\/staff\/sign-in/)
    })
  }

  test('the sign-in page it redirects to actually exists', async ({ page }) => {
    // It did not. Every staff page redirected to `/staff/sign-in` and that route was a 404,
    // so no staff member could reach any staff surface at all (audit H-6).
    const response = await page.goto('/staff/sign-in')
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: /staff sign-in/i })).toBeVisible()

    // rules.md §6 is BLOCKING: the control must have a programmatically associated label, and
    // the result must reach a screen reader rather than only appearing on screen.
    await expect(page.getByLabel(/email address/i)).toBeVisible()
    // At least one live region, not exactly one: the page carries its own and the layout may
    // add another. Pinning the count would fail on an unrelated layout change while proving
    // nothing extra — what matters is that a result can reach a screen reader at all.
    expect(await page.locator('[role="alert"]').count()).toBeGreaterThanOrEqual(1)
  })
})

test.describe('offline capability — the PWA actually installs', () => {
  test('the service worker registers and takes control', async ({ page }) => {
    // FR-CHK-012 requires check-in to work with no network for 8 continuous hours, and the
    // service worker is what makes that possible. It had never been verified: the embedded
    // preview browser disables service workers, so registration failed there with a generic
    // error that told us nothing about the app.
    //
    // This matters beyond installability. The worker is deliberately NETWORK-FIRST for
    // navigations and never touches /api/* — a cache-first worker would serve a queue position
    // from an hour ago as though it were current, which is what NFR-AVAIL-005 forbids and what
    // design principle 2 exists to prevent. A worker that fails to register silently is a desk
    // with no offline mode on the day.
    await page.goto('/')

    const result = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false }
      try {
        const reg = await navigator.serviceWorker.register('/sw.js')
        await navigator.serviceWorker.ready
        return { supported: true, registered: true, scope: reg.scope }
      } catch (e) {
        return { supported: true, registered: false, error: String((e as Error).message) }
      }
    })

    expect(result.supported, 'browser lacks service worker support').toBe(true)
    expect(result.registered, `registration failed: ${result.error ?? ''}`).toBe(true)
    // Scope must be the origin root, or it cannot control the check-in routes.
    expect(result.scope).toMatch(/^https?:\/\/[^/]+\/$/)
  })

  test('the worker never caches /api/*', async ({ page }) => {
    // The rule that keeps offline honest: mutations replay through IndexedDB with idempotency
    // keys, never through a cache that would hand back a stale answer as a fresh one.
    const sw = await page.request.get('/sw.js')
    const source = await sw.text()

    expect(source).toMatch(/\/api\//)
    // The worker must bail out of API requests rather than serving them from cache.
    expect(source).toMatch(/pathname\.startsWith\(['"]\/api\/?['"]\)|url\.pathname\.startsWith/)
  })
})
