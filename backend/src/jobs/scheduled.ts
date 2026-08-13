/**
 * The scheduled work: offer expiry, the waitlist cascade, reminders, and the state-drift check.
 *
 * Two of these have a hard deadline attached and it is worth stating why, because the numbers
 * look arbitrary otherwise:
 *
 *   * Offers expire after ONE DAY (locked decision, overriding FR-OFF-002's 48h). A cascade
 *     that ran daily would therefore leave a released seat idle for most of the window in
 *     which anyone could still accept it. Hourly is the minimum that makes the short expiry
 *     survivable, and it is why the cascade is a scheduled job at all rather than a button.
 *   * The reminder fires at T−6h. With a 24-hour expiry that is a real reminder; a job running
 *     less often than hourly would miss the window entirely for some offers.
 *
 * All of it runs over the same Postgres connection as the rest of the application, deliberately
 * — not through PostgREST with a service-role key. One privileged path is easier to reason
 * about than two, and migration 0036 exists precisely because the second path was reachable.
 *
 * Refs: FR-OFF-002..006, FR-OPS-003, FR-NOT-001, NFR-AVAIL-008
 */

import { asPrivileged, type Tx } from '../services/db'

export interface JobReport {
  cycleId: string
  offersExpired: number
  seatsCascaded: number
  remindersQueued: number
  driftDetected: number
  errors: string[]
}

/**
 * Every cycle currently capable of having work to do.
 *
 * Closed cycles are excluded: they are immutable (design principle 9), so a job that touched
 * one would be a bug regardless of what it found.
 */
async function activeCycles(tx: Tx): Promise<string[]> {
  const rows = await tx<Array<{ id: string }>>`
    SELECT id FROM cycles WHERE closed_at IS NULL
  `
  return rows.map((r) => r.id)
}

/**
 * Hourly: expire what has lapsed, cascade the freed seats, queue the T−6h reminders.
 *
 * Each cycle is processed in its OWN transaction. One cycle failing must not roll back the
 * work already done for another — during an induction there is usually exactly one live cycle,
 * but "usually" is not a property to build a scheduled job on.
 */
export async function runHourlyJobs(): Promise<JobReport[]> {
  const cycleIds = await asPrivileged(activeCycles)
  const reports: JobReport[] = []

  for (const cycleId of cycleIds) {
    const report: JobReport = {
      cycleId,
      offersExpired: 0,
      seatsCascaded: 0,
      remindersQueued: 0,
      driftDetected: 0,
      errors: [],
    }

    try {
      await asPrivileged(async (tx) => {
        const expired = await tx<Array<{ fn_expire_offers: number }>>`
          SELECT fn_expire_offers(${cycleId}::uuid)
        `
        report.offersExpired = expired[0]?.fn_expire_offers ?? 0

        // Cascade every department, not only those that just released a seat: a decline that
        // arrived while the previous run was in flight leaves a seat nobody has re-offered,
        // and a full pass is cheap compared with an unfilled place.
        const departments = await tx<Array<{ id: string }>>`
          SELECT id FROM departments WHERE cycle_id = ${cycleId}::uuid
        `
        for (const dept of departments) {
          const cascaded = await tx<Array<{ fn_cascade_department: number }>>`
            SELECT fn_cascade_department(${dept.id}::uuid)
          `
          report.seatsCascaded += cascaded[0]?.fn_cascade_department ?? 0
        }

        const due = await tx<Array<{ offer_id: string; applicant_id: string }>>`
          SELECT offer_id, applicant_id FROM fn_offers_needing_reminder(${cycleId}::uuid)
        `
        report.remindersQueued = due.length
      })
    } catch (err) {
      // Recorded and carried, never thrown away: a scheduled job that fails silently is
      // indistinguishable from one that had nothing to do (design principle 2).
      report.errors.push(err instanceof Error ? err.message : String(err))
    }

    reports.push(report)
  }

  return reports
}

/**
 * Nightly: re-derive `applicants.state` from its owning tables and report mismatches.
 *
 * This must not correct anything on its own. `applicants.state` has exactly one writer per
 * transition (R-012, E5), and a nightly job that quietly patched the projection would become a
 * SECOND writer — hiding the very bug it exists to detect, and doing it overnight where nobody
 * would see it happen. Drift is reported, and a human decides.
 *
 * Refs: FR-OPS-003
 */
export async function runNightlyJobs(): Promise<JobReport[]> {
  const cycleIds = await asPrivileged(activeCycles)
  const reports: JobReport[] = []

  for (const cycleId of cycleIds) {
    const report: JobReport = {
      cycleId,
      offersExpired: 0,
      seatsCascaded: 0,
      remindersQueued: 0,
      driftDetected: 0,
      errors: [],
    }

    try {
      await asPrivileged(async (tx) => {
        const drift = await tx<Array<{ applicant_id: string; display_id: string }>>`
          SELECT applicant_id, display_id FROM fn_detect_state_drift(${cycleId}::uuid)
        `
        report.driftDetected = drift.length

        if (drift.length > 0) {
          await tx`
            SELECT fn_audit(
              ${cycleId}::uuid, 'ops.state_drift_detected', 'cycle', ${cycleId}::uuid,
              NULL,
              ${tx.json({
                count: drift.length,
                display_ids: drift.slice(0, 50).map((d) => d.display_id),
              })}::jsonb,
              'nightly drift check found projected state disagreeing with its owning tables'
            )
          `
        }

        // The retention sweep is NOT run here, deliberately. Migration 0040 requires
        // `cycle.configure` on every cycle it touches and audits what it redacted; an
        // unattended cron has no user to attribute that to. Irreversibly redacting applicant
        // PII is not an action that should happen at 2am with nobody's name against it — a
        // Super Admin triggers it, and the audit row says who.
        void 0
      })
    } catch (err) {
      report.errors.push(err instanceof Error ? err.message : String(err))
    }

    reports.push(report)
  }

  return reports
}
