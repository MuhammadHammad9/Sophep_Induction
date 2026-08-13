/**
 * Read-only readiness check for a target database.
 *
 * WHY THIS EXISTS. The 2026-08-12 remediation produced 17 new migrations, several of them
 * irreversible in practice: `DROP FUNCTION`, `DROP COLUMN secret_params_enc`, a data move into
 * `notification_secrets`, and privilege revocations that change who can call what. Applying
 * that set to a live database holding applicant PII is a decision, not a step — so this script
 * exists to make the decision an informed one rather than a leap.
 *
 * IT WRITES NOTHING. No DDL, no DML, no ledger row, not even a temp table. Every statement is a
 * SELECT against the catalogue. It is safe to run against production at any time, including
 * during an event.
 *
 * What it answers:
 *   1. Which migrations are already applied, and which would run.
 *   2. Whether any APPLIED migration has been edited since (R-053 — the thing that silently
 *      breaks a replay).
 *   3. Whether the security properties hold RIGHT NOW, so you can see the before state.
 *   4. Whether anything about the target looks unexpected — wrong encoding, missing app role.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/preflight.mjs
 *
 * Refs: NFR-MAIN-002, rules.md R-053, R-055, audit rollout
 */

import postgres from 'postgres'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set — see .env.example')
  process.exit(1)
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const sql = postgres(url, { max: 1, onnotice: () => {} })

const ok = (s) => `  [ok]   ${s}`
const warn = (s) => `  [WARN] ${s}`
const bad = (s) => `  [FAIL] ${s}`

let problems = 0
let warnings = 0

try {
  // ── 1. What is this, and is it the right shape ──────────────────────────────────────────
  console.log('\nTarget')
  const [info] = await sql`
    SELECT current_database() AS db,
           pg_encoding_to_char(encoding) AS encoding,
           current_user AS role,
           version() AS version
      FROM pg_database WHERE datname = current_database()
  `
  console.log(`  database: ${info.db}   encoding: ${info.encoding}   connected as: ${info.role}`)
  console.log(`  ${info.version.split(',')[0]}`)

  if (info.encoding !== 'UTF8') {
    // The migrations contain em dashes and box-drawing characters in comments. On a WIN1252
    // database they fail with "no equivalent in encoding", halfway through.
    console.log(bad(`encoding is ${info.encoding}, not UTF8 — migrations will fail part-way`))
    problems++
  }

  const [appRole] = await sql`SELECT 1 AS present FROM pg_roles WHERE rolname = 'rms_app'`
  console.log(appRole ? ok('rms_app role present') : warn('rms_app role absent (0010 will create it)'))
  if (!appRole) warnings++

  // ── 2. Ledger: what would actually run ──────────────────────────────────────────────────
  console.log('\nMigrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

  const [ledger] = await sql`
    SELECT 1 AS present FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'schema_migrations'
  `
  const applied = ledger
    ? new Map(
        (await sql`SELECT filename, checksum FROM schema_migrations`).map((r) => [
          r.filename,
          r.checksum,
        ]),
      )
    : new Map()

  const pending = []
  const drifted = []

  for (const file of files) {
    const checksum = createHash('sha256')
      .update(readFileSync(join(dir, file), 'utf8'))
      .digest('hex')
      .slice(0, 16)

    if (!applied.has(file)) pending.push(file)
    else if (applied.get(file) !== checksum) drifted.push(file)
  }

  console.log(`  ${applied.size} applied, ${pending.length} pending, ${files.length} on disk`)

  if (drifted.length) {
    // R-053: never edit a migration that has been applied. A drifted checksum means the file
    // and the database disagree about what ran, and no replay can reconcile them.
    console.log(bad(`${drifted.length} APPLIED migration(s) edited since — R-053 violation:`))
    drifted.forEach((f) => console.log(`         ${f}`))
    problems++
  } else {
    console.log(ok('no applied migration has been edited (R-053)'))
  }

  if (pending.length) {
    console.log(`\n  would apply, in this order:`)
    pending.forEach((f) => console.log(`         ${f}`))
  } else {
    console.log(ok('nothing pending — target is up to date'))
  }

  // ── 3. The security properties, as they stand RIGHT NOW ─────────────────────────────────
  //
  // Deliberately reported as the BEFORE picture. On an unmigrated production database these
  // are expected to fail — that failure is the audit finding, and seeing it here is how you
  // confirm the target is the database the audit was about.
  console.log('\nSecurity posture (current state of the target)')

  // Scoped to functions WE OWN, and this scoping is load-bearing.
  //
  // Supabase installs citext, pg_trgm and pgcrypto into `public`, owned by `supabase_admin`.
  // Those ~78 functions are EXECUTE-able by PUBLIC and must stay that way: they are pure
  // operators over text (citext_eq, citext_cmp, similarity) with no data access, and revoking
  // them would break every citext comparison and trigram index in the schema. We are not their
  // owner, so migration 0036's REVOKE cannot touch them anyway — it warns and moves on.
  //
  // An unscoped count reported "78 function(s) EXECUTE-able by PUBLIC" against a database
  // where C-2 was fully closed. A security check that cries wolf is worse than none: the
  // obvious reaction is to go and revoke them, which breaks the database.
  const leaked = await sql`
    SELECT count(*)::int AS n FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_userbyid(p.proowner) = current_user
       AND has_function_privilege('public', p.oid, 'EXECUTE')
  `
  console.log(
    leaked[0].n === 0
      ? ok('no application function is EXECUTE-able by PUBLIC')
      : warn(`${leaked[0].n} application function(s) EXECUTE-able by PUBLIC (audit C-2 — closed by 0036/0044)`),
  )
  if (leaked[0].n > 0) warnings++

  // The sharper form of the same question: a SECURITY DEFINER function bypasses RLS, so one
  // reachable by PUBLIC is the actual C-2 exploit regardless of who owns it.
  const secdef = await sql`
    SELECT count(*)::int AS n FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND has_function_privilege('public', p.oid, 'EXECUTE')
  `
  console.log(
    secdef[0].n === 0
      ? ok('no SECURITY DEFINER function is EXECUTE-able by PUBLIC')
      : bad(`${secdef[0].n} SECURITY DEFINER function(s) EXECUTE-able by PUBLIC — RLS is bypassable`),
  )
  if (secdef[0].n > 0) problems++

  // Supabase's PostgREST roles. Zero table grants plus no function access means the anon key
  // shipped in the browser bundle can reach nothing, which is the property C-2 was about.
  for (const role of ['anon', 'authenticated']) {
    const [present] = await sql`SELECT 1 AS p FROM pg_roles WHERE rolname = ${role}`
    if (!present) continue
    const [grants] = await sql`
      SELECT count(*)::int AS n FROM information_schema.role_table_grants
       WHERE grantee = ${role} AND table_schema = 'public'
    `
    const [fns] = await sql`
      SELECT count(*)::int AS n FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND pg_get_userbyid(p.proowner) = current_user
         AND has_function_privilege(${role}, p.oid, 'EXECUTE')
    `
    console.log(
      grants.n === 0 && fns.n === 0
        ? ok(`${role} can reach no application table or function`)
        : warn(`${role} holds ${grants.n} table grant(s) and ${fns.n} function grant(s)`),
    )
    if (grants.n > 0 || fns.n > 0) warnings++
  }

  const noRls = await sql`
    SELECT count(*)::int AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
       AND c.relname NOT IN ('schema_migrations', '_rms_test_database')
  `
  console.log(
    noRls[0].n === 0
      ? ok('every table has row-level security enabled')
      : warn(`${noRls[0].n} table(s) without RLS (audit C-3 — closed by 0037)`),
  )
  if (noRls[0].n > 0) warnings++

  const tokens = await sql`
    SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'notifications'
  `
  if (tokens[0].n) {
    const leakedTokens = await sql`
      SELECT count(*)::int AS n FROM notifications
       WHERE body_text ~ '/q/[A-Za-z0-9_-]{22}' OR body_html ~ '/q/[A-Za-z0-9_-]{22}'
    `
    console.log(
      leakedTokens[0].n === 0
        ? ok('no raw access token stored in a notification body')
        : warn(
            `${leakedTokens[0].n} notification(s) contain a RAW ACCESS TOKEN (audit C-5). ` +
              `0042/0047 stop new ones; EXISTING ROWS ARE NOT REWRITTEN — see the rollout note.`,
          ),
    )
    if (leakedTokens[0].n > 0) warnings++
  }

  // ── 4. Verdict ──────────────────────────────────────────────────────────────────────────
  console.log('\nVerdict')
  if (problems > 0) {
    console.log(`  ${problems} BLOCKING problem(s). Do not migrate until resolved.`)
    process.exit(1)
  }
  console.log(`  Safe to migrate: ${pending.length} migration(s) would run.`)
  if (warnings > 0) {
    console.log(`  ${warnings} finding(s) above are the AUDIT's own findings — expected on an`)
    console.log(`  unmigrated target, and what applying these migrations fixes.`)
  }
  console.log('\n  Take a backup first. Then:  npm run db:migrate')
  console.log('  Re-run this script afterwards; every [WARN] above should become [ok].\n')
} catch (err) {
  console.error('\npreflight failed:', err.message)
  process.exit(1)
} finally {
  await sql.end()
}
