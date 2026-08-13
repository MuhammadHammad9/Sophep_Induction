/**
 * A stand-in for Supabase Auth, for end-to-end tests only.
 *
 * WHY THIS EXISTS RATHER THAN A TEST-ONLY BYPASS IN THE APP.
 *
 * `requireStaff` calls `supabase.auth.getUser()`, which verifies the caller's JWT against the
 * Supabase Auth server over HTTPS. Without one, no signed-in flow can be driven at all — which
 * is why the walk-in spec sat unverified while the anonymous half was fully covered.
 *
 * The tempting shortcut is a flag in the application: "if TEST_MODE, skip auth". That would put
 * a deliberate hole in the exact boundary this audit exists to close, one environment variable
 * away from production. Every audit finding here is ultimately about a check that could be
 * skipped; adding a supported way to skip them all is not a test strategy.
 *
 * So the APPLICATION IS UNCHANGED and the EXTERNAL DEPENDENCY is doubled instead — the same
 * approach `services/notifications.ts` already takes with the mock email provider. Point
 * `NEXT_PUBLIC_SUPABASE_URL` at this server and `getUser()` resolves a real user through the
 * real code path: real cookie parsing, real session handling, real `fn_resolve_staff_session`,
 * real RLS.
 *
 * The @supabase/ssr cookie name derives from the project ref, which it takes as the first label
 * of the URL host. Pointing at `http://127.0.0.1:<port>` therefore yields `sb-127-auth-token`,
 * which is deterministic and is what the test sets.
 *
 * Refs: audit H-6, C-1, rules.md R-032
 */

import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 54321)

/** The identity the tests sign in as. Must match `users.auth_user_id` in the seeded database. */
const USER = {
  id: process.argv[3] ?? '11111111-1111-4111-8111-111111111111',
  aud: 'authenticated',
  role: 'authenticated',
  email: process.argv[4] ?? 'volunteer@test.sophep',
  email_confirmed_at: new Date().toISOString(),
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

  // The only endpoint `getUser()` needs. Everything else 404s deliberately: a stub that
  // answers calls the app does not make would hide a real dependency.
  if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
    // Still requires a bearer token. Without this the stub would authenticate the ANONYMOUS
    // case too, and every "unauthenticated is refused" assertion would silently pass for the
    // wrong reason — a green suite proving nothing.
    const auth = req.headers.authorization ?? ''
    if (!/^Bearer\s+.+/i.test(auth)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'invalid claim: missing sub claim' }))
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(USER))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ message: `auth stub does not implement ${req.method} ${url.pathname}` }))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`auth stub listening on http://127.0.0.1:${PORT} as ${USER.email} (${USER.id})`)
})
