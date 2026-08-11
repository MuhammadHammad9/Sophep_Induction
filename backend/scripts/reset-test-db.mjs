/**
 * Drop the schema and mark the database as this suite's own.
 *
 * The test suite refuses to destroy a schema containing applicant records it did not create
 * (tests/helpers.ts), which is deliberate — pointing DATABASE_URL at a database anyone cares
 * about would otherwise delete it silently. This script is the explicit "yes, wipe it" action.
 *
 * ⚠ If DEV and TEST share one Supabase project, running this destroys your demo data, and
 * running `db:seed` afterwards re-arms the guard. Use a separate project or a Supabase branch
 * for tests to stop the two fighting.
 */

import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set — see .env.example')
  process.exit(1)
}

const sql = postgres(url, { max: 1, onnotice: () => {} })

try {
  const [existing] = await sql`
    SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'applicants'
  `

  if (existing.n > 0) {
    const [applicants] = await sql`SELECT count(*)::int AS n FROM applicants`
    if (applicants.n > 0) {
      console.log(`About to destroy ${applicants.n} applicant record(s).`)
    }
  }

  await sql.unsafe(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO PUBLIC;
    CREATE TABLE _rms_test_database (note text);
  `)

  console.log('Schema dropped and marked as a test database.')
  console.log('Run: npm test')
} finally {
  await sql.end()
}
