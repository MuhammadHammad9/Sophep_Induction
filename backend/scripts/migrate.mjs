/**
 * Apply pending migrations, tracked in a ledger.
 *
 * Uses a direct connection rather than the Supabase CLI, which needs Docker — not available
 * on every machine this has to run on.
 *
 * `max: 1` is required, not incidental: migration files contain explicit BEGIN/COMMIT, and
 * postgres.js refuses those on a pooled connection (UNSAFE_TRANSACTION) because a pool could
 * hand the COMMIT to a different backend than the BEGIN.
 *
 * The ledger exists because migrations are NOT idempotent — `CREATE TYPE cycle_state` fails
 * outright on a second run. Without it, `db:migrate` works exactly once per database and then
 * errors forever, which is indistinguishable from a broken migration. NFR-MAIN-002 and
 * rules.md R-053 both assume versioned, replayable migrations; this is what makes that true.
 *
 * Each file's checksum is recorded, so editing a migration that has already been applied is
 * detected rather than silently ignored (R-053: never edit an applied migration).
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

try {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `

  const applied = new Map(
    (await sql`SELECT filename, checksum FROM schema_migrations`).map((r) => [
      r.filename,
      r.checksum,
    ]),
  )

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  let count = 0
  let drift = 0

  for (const file of files) {
    const body = readFileSync(join(dir, file), 'utf8')
    const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16)
    const previous = applied.get(file)

    if (previous) {
      if (previous !== checksum) {
        // R-053. The database no longer matches what is in source control, and re-running
        // will not reconcile it — the change has to go in a NEW migration.
        console.error(`  DRIFT ${file} was modified after being applied`)
        drift++
      } else {
        console.log(`  skip  ${file}`)
      }
      continue
    }

    const started = Date.now()
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(body)
        await tx`
          INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${checksum})
        `
      })
      console.log(`  ok    ${file}  (${Date.now() - started}ms)`)
      count++
    } catch (err) {
      console.error(`  FAIL  ${file}`)
      console.error(`        ${err.message}`)
      if (err.hint) console.error(`        hint: ${err.hint}`)
      process.exitCode = 1
      break
    }
  }

  if (drift > 0) {
    console.error(
      `\n${drift} applied migration(s) have been edited. Revert them and add a new ` +
        'migration instead — an applied migration is history, not source (rules.md R-053).',
    )
    process.exitCode = 1
  } else if (process.exitCode !== 1) {
    console.log(count === 0 ? '\nAlready up to date.' : `\n${count} migration(s) applied.`)
  }
} finally {
  await sql.end()
}
