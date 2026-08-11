/**
 * Seed a demo cycle for local development.
 *
 * Creates a society, an open cycle, three departments, one general track, and one staff user
 * per role, so every RLS path can be exercised by hand.
 *
 * One general track is the committee's locked decision: a single interview with department fit
 * as a rubric criterion, rather than one interview per department preference.
 *
 * Safe to re-run — it refuses if the demo cycle already exists rather than duplicating it.
 */

import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set — see .env.example')
  process.exit(1)
}

const sql = postgres(url, { onnotice: () => {} })

try {
  const existing = await sql`
    SELECT c.id FROM cycles c
      JOIN societies s ON s.id = c.society_id
     WHERE s.code = 'SPH' AND c.season = 'SP' AND c.year = 2026
  `

  if (existing.length > 0) {
    console.log('Demo cycle already exists — nothing to do.')
    console.log(`  cycle_id: ${existing[0].id}`)
    process.exit(0)
  }

  const [society] = await sql`
    INSERT INTO societies (code, name) VALUES ('SPH', 'SOPHEP')
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `

  const [cycle] = await sql`
    INSERT INTO cycles (society_id, season, year, name, state)
    VALUES (${society.id}, 'SP', 2026, 'Spring 2026', 'registration_open')
    RETURNING id, config
  `

  await sql`
    INSERT INTO departments (cycle_id, code, name, capacity, sort_order) VALUES
      (${cycle.id}, 'TECH',   'Technology',      8, 1),
      (${cycle.id}, 'MEDIA',  'Media & Design',  6, 2),
      (${cycle.id}, 'EVENTS', 'Events',         10, 3),
      (${cycle.id}, 'OUTREACH', 'Outreach',      6, 4)
  `

  await sql`
    INSERT INTO tracks (cycle_id, code, name) VALUES (${cycle.id}, 'general', 'General')
  `

  await sql`
    INSERT INTO rooms (cycle_id, code, name) VALUES
      (${cycle.id}, 'R1', 'Room 1'),
      (${cycle.id}, 'R2', 'Room 2')
  `

  const roles = ['super_admin', 'coordinator', 'admin', 'volunteer', 'interviewer', 'auditor']
  for (const role of roles) {
    const [user] = await sql`
      INSERT INTO users (email, full_name)
      VALUES (${`${role}@sophep.local`}, ${role.replace('_', ' ')})
      ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
      RETURNING id
    `
    await sql`
      INSERT INTO memberships (cycle_id, user_id, role)
      VALUES (${cycle.id}, ${user.id}, ${role})
      ON CONFLICT DO NOTHING
    `
  }

  console.log('Seeded demo cycle.')
  console.log(`  cycle_id:  ${cycle.id}`)
  console.log(`  state:     registration_open`)
  console.log(`  offer:     ${cycle.config.offer_expiry_hours}h expiry, reminder at T-${cycle.config.offer_reminder_hours_before}h`)
  console.log(`  eta seed:  ${cycle.config.service_ewma_seed_minutes} min, alpha ${cycle.config.service_ewma_alpha}`)
  console.log('')
  console.log('Visit http://localhost:3000/apply')
} finally {
  await sql.end()
}
