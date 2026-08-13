/**
 * Nightly consistency check.
 *
 * `applicants.state` is a projection, written only by the four owning functions (R-012). If it
 * ever disagrees with the event tables it is derived from, the first symptom on the day is an
 * applicant whose phone says "Position 4" while the panel screen says they are mid-interview —
 * in front of them, and unfixable afterwards because nothing recorded which was right.
 *
 * This job exists to make that discoverable overnight rather than discovered at the desk. It is
 * a safety net for an invariant that should already hold, not a substitute for it: if this ever
 * reports a drift, the projection has a bug and the drift is the symptom.
 *
 * Uses `asPrivileged` rather than the Supabase service-role key, for the same reason as
 * `anonymisation.ts` — a BYPASSRLS credential exported from `backend/src/` is one careless
 * import away from a request path, which would silently undo migration 0010.
 *
 * Refs: FR-OPS-001, FR-OPS-002, E5, rules.md R-012, R-014, audit S-9
 */

import { fileURLToPath } from 'node:url'
import { asPrivileged, closeDb } from '../services/db'

export interface ConsistencyResult {
  success: boolean
  /** Rows whose projection disagreed with the derived state, as observed BEFORE correction. */
  anomalies: Array<{ applicant_id: string; projected: string; derived: string }>
  /** How many fn_check_consistency actually corrected. */
  fixed: number
  error?: string
}

export async function runConsistencyCheck(cycleId: string): Promise<ConsistencyResult> {
  try {
    const { anomalies, fixed } = await asPrivileged(async (tx) => {
      // Detect first, then correct, in ONE transaction.
      //
      // fn_check_consistency returns only a count, and a count is not an incident report — a
      // drift is a defect in a projection that R-012 says cannot drift, so the specific rows
      // are the whole value. Reading fn_detect_state_drift first captures them before the
      // correction erases the evidence; sharing a transaction means nothing can change in
      // between, so the list and the count always describe the same set.
      const drift = await tx<Array<{ applicant_id: string; projected: string; derived: string }>>`
        SELECT applicant_id, projected, derived FROM fn_detect_state_drift(${cycleId}::uuid)
      `
      const rows = await tx<Array<{ fn_check_consistency: number }>>`
        SELECT fn_check_consistency(${cycleId}::uuid)
      `
      return { anomalies: [...drift], fixed: Number(rows[0]?.fn_check_consistency ?? 0) }
    })

    if (anomalies.length === 0) {
      console.log('consistency check: no drift')
    } else {
      // Loud on purpose. This should be impossible; if it happens it needs to reach a human
      // rather than be counted and forgotten.
      console.error(`consistency check: ${anomalies.length} anomaly(ies), ${fixed} corrected`)
      for (const a of anomalies) {
        console.error(`  ${a.applicant_id}: projected=${a.projected} derived=${a.derived}`)
      }
    }

    return { success: true, anomalies, fixed }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('consistency check failed:', message)
    return { success: false, anomalies: [], fixed: 0, error: message }
  }
}

if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
  const cycleId = process.argv[2]
  if (!cycleId) {
    console.error('Usage: node jobs/consistency.js <cycle_id>')
    process.exit(1)
  }
  runConsistencyCheck(cycleId)
    .then((r) => closeDb().then(() => process.exit(r.success && r.anomalies.length === 0 ? 0 : 1)))
    .catch(async (e) => {
      console.error(e)
      await closeDb()
      process.exit(1)
    })
}
