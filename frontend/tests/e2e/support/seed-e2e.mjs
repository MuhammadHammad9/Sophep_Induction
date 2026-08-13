/**
 * The fixture the browser suite runs against.
 *
 * WHY THIS EXISTS. The signed-in specs failed in CI while passing locally, and the difference
 * was not the code — it was that locally the staff user had been inserted by hand. CI starts
 * from a migrated but EMPTY database, so `fn_resolve_staff_session` found no membership,
 * `requireStaff` correctly returned null, and every signed-in test was redirected to sign-in.
 *
 * That is the boundary working exactly as designed. The test setup was the thing that was
 * wrong, and hand-seeding is precisely the kind of step that works on one machine and nowhere
 * else. It runs from `playwright.config.ts` as a globalSetup so local and CI are the same.
 *
 * The auth uid MUST match `tests/e2e/support/auth-stub.mjs` — that pairing is what makes a
 * verified-JWT lookup resolve to a real staff row without weakening anything in the app.
 *
 * Idempotent throughout: the suite is re-run constantly, and a fixture that only works on a
 * virgin database is a fixture that fails the second time.
 */

import postgres from 'postgres'

const AUTH_USER_ID = '11111111-1111-4111-8111-111111111111'
const STAFF_EMAIL = 'volunteer@test.sophep'

export default async function seed() {
  const url = process.env.DATABASE_URL
  if (!url) {
    // Not fatal: the anonymous half of the suite needs no database at all, and failing here
    // would turn "you forgot an env var" into "the security tests are broken".
    console.warn('[e2e seed] DATABASE_URL not set — signed-in specs will be skipped')
    return
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} })

  try {
    await sql`
      INSERT INTO societies (code, name) VALUES ('SPH', 'SOPHEP')
      ON CONFLICT (code) DO NOTHING
    `
    const [society] = await sql`SELECT id FROM societies WHERE code = 'SPH'`

    await sql`
      INSERT INTO cycles (society_id, season, year, name, state)
      VALUES (${society.id}::uuid, 'SP', 2026, 'E2E Spring 2026', 'registration_open')
      ON CONFLICT (society_id, season, year) DO UPDATE SET state = 'registration_open'
    `
    const [cycle] = await sql`
      SELECT id FROM cycles WHERE society_id = ${society.id}::uuid AND season = 'SP' AND year = 2026
    `

    await sql`
      INSERT INTO departments (cycle_id, code, name, capacity)
      VALUES (${cycle.id}::uuid, 'TECH', 'Technology', 8)
      ON CONFLICT DO NOTHING
    `

    // `stages` has no `state` column — open means started and not closed. Getting this wrong
    // is what made the fast-track page 500 for every authenticated staff member.
    const [stage] = await sql`
      SELECT id FROM stages WHERE cycle_id = ${cycle.id}::uuid AND closed_at IS NULL LIMIT 1
    `
    if (!stage) {
      await sql`
        INSERT INTO stages (cycle_id, kind, name, starts_at, ends_at)
        VALUES (${cycle.id}::uuid, 'registration', 'E2E Check-in Desk',
                now() - interval '1 hour', now() + interval '8 hours')
      `
    }

    // A track, without which `fn_check_in` raises "no active track configured for this cycle"
    // and the walk-in never reaches the queue. One general track is the committee's locked
    // decision: a single interview with department fit as a rubric criterion, rather than one
    // interview per preference (CLAUDE.md, locked decisions).
    await sql`
      INSERT INTO tracks (cycle_id, code, name)
      VALUES (${cycle.id}::uuid, 'general', 'General')
      ON CONFLICT DO NOTHING
    `

    // The staff identity the auth stub vouches for. `auth_user_id` is the only thing
    // fn_resolve_staff_session matches on — never the email (audit M-5).
    await sql`
      INSERT INTO users (email, full_name, auth_user_id)
      VALUES (${STAFF_EMAIL}, 'E2E Volunteer', ${AUTH_USER_ID}::uuid)
      ON CONFLICT (email) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id, disabled_at = NULL
    `
    const [user] = await sql`SELECT id FROM users WHERE email = ${STAFF_EMAIL}`

    // Volunteer, deliberately: it holds applicant.register and checkin.perform (what
    // fast-track needs) and is NOT in MFA_REQUIRED_ROLES, so the suite exercises the desk
    // path rather than the second-factor challenge.
    await sql`
      INSERT INTO memberships (cycle_id, user_id, role)
      VALUES (${cycle.id}::uuid, ${user.id}::uuid, 'volunteer'::role_name)
      ON CONFLICT DO NOTHING
    `

    console.log(`[e2e seed] cycle ${cycle.id} · staff ${user.id} · ready`)
  } finally {
    await sql.end()
  }
}
