/**
 * Retention sweep (DR-006, NFR-PRIV-004).
 *
 * Cycles archived more than two years ago have their applicant PII redacted. Structural data —
 * scores, wait times, outcomes — stays, because it is what makes next year's capacity model
 * honest, and none of it identifies anyone once the names are gone.
 *
 * WHY THIS NO LONGER USES THE SUPABASE SERVICE-ROLE KEY.
 *
 * It did, and that was a latent hole rather than an active one. `SUPABASE_SERVICE_ROLE_KEY`
 * bypasses RLS entirely, and this module is an ordinary export in `backend/src/` — nothing
 * stopped a route handler importing `runAnonymisation` and, with it, dragging a BYPASSRLS
 * credential into a request path. That single import would undo migration 0010, which exists
 * precisely so that no request path can bypass a policy (rules.md R-014).
 *
 * It now goes through `asPrivileged`, the one place in the codebase already documented as "for
 * migrations, seeds and scheduled maintenance only". The connection authenticates as the owner
 * and never assumes `rms_app`, which is exactly the distinction `fn_anonymise_old_data` uses to
 * tell a scheduled sweep from a web request — and that distinction is a property of the
 * connection, not a flag the application can set.
 *
 * Refs: DR-006, NFR-PRIV-004, FR-AUD-001, rules.md R-014, R-031, audit H-2, S-9
 */

import { fileURLToPath } from 'node:url'
import { asPrivileged, closeDb } from '../services/db'

export interface AnonymisationResult {
  success: boolean
  applicantsAnonymised: number
  error?: string
}

/**
 * Run the sweep.
 *
 * `p_cycle_id` is optional: passing one scopes the sweep to a single cycle, which is what an
 * operator uses to satisfy an individual erasure request. Passing nothing sweeps every eligible
 * cycle, which is the cron form.
 *
 * The selection rule (`archived` and `archived_at < now() - 2 years`) lives in the function,
 * not here. Retention policy is not something a job script should be able to widen.
 */
export async function runAnonymisation(cycleId?: string): Promise<AnonymisationResult> {
  try {
    const count = await asPrivileged(async (tx) => {
      const rows = await tx<Array<{ fn_anonymise_old_data: number }>>`
        SELECT fn_anonymise_old_data(${cycleId ?? null}::uuid)
      `
      return Number(rows[0]?.fn_anonymise_old_data ?? 0)
    })

    // The function writes its own `data.redacted` audit row per cycle, inside the same
    // transaction as the redaction. This log line is operator convenience, not the record.
    console.log(`anonymisation complete: ${count} applicant record(s) redacted`)
    return { success: true, applicantsAnonymised: count }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('anonymisation failed:', message)
    return { success: false, applicantsAnonymised: 0, error: message }
  }
}

if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
  const cycleId = process.argv[2]
  runAnonymisation(cycleId)
    .then((r) => closeDb().then(() => process.exit(r.success ? 0 : 1)))
    .catch(async (e) => {
      console.error(e)
      await closeDb()
      process.exit(1)
    })
}
