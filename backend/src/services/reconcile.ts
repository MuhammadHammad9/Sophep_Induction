/**
 * Paper-fallback recovery, and the conflicts that need a human.
 *
 * This is the bottom of the degradation ladder (spec §19.6). When power or the network is gone
 * long enough that the devices are useless, the desk switches to a printed roster with tick
 * boxes. Afterwards a Coordinator enters what was ticked, all at once.
 *
 * The spec's own note on the printed roster is worth keeping in mind while reading this file:
 * "Print every morning. You will probably never use it, and the one time you do it will save
 * the event."
 *
 * Refs: FR-CHK-015, FR-CHK-017, FR-CHK-019
 */

import type { Tx } from './db'

export interface ReconcileOutcome {
  applicantId: string
  /** `checked_in` · `already` · `error: …` — one row per input, always. */
  outcome: string
  queuePosition: number | null
}

/**
 * Check a list of applicants in as one operation.
 *
 * Every input gets an output row, including the failures. A bulk operation that returns only
 * its successes leaves the Coordinator comparing two lists by hand to find who is missing —
 * at the exact moment when they have least time to do that.
 */
export async function bulkReconcile(
  tx: Tx,
  stageId: string,
  applicantIds: string[],
): Promise<ReconcileOutcome[]> {
  if (applicantIds.length === 0) return []

  const rows = await tx<
    Array<{ applicant_id: string; outcome: string; queue_position: number | null }>
  >`
    SELECT applicant_id, outcome, queue_position
      FROM fn_bulk_reconcile(${stageId}::uuid, ${applicantIds}::uuid[])
  `

  return rows.map((r) => ({
    applicantId: r.applicant_id,
    outcome: r.outcome,
    queuePosition: r.queue_position,
  }))
}

/**
 * Resolve identifiers a human typed into applicant ids.
 *
 * Accepts display ids in either the printed form (`SPH-2026-0042`) or just the digits, because
 * somebody transcribing eighty rows from paper will not type the prefix eighty times.
 * Unmatched entries are RETURNED, not dropped — an identifier that silently matched nothing is
 * a person who was physically present and does not exist in the system.
 */
export async function resolveDisplayIds(
  tx: Tx,
  cycleId: string,
  identifiers: string[],
): Promise<{ matched: Array<{ applicantId: string; displayId: string; fullName: string }>; unmatched: string[] }> {
  const cleaned = identifiers.map((i) => i.trim()).filter(Boolean)
  if (cleaned.length === 0) return { matched: [], unmatched: [] }

  const rows = await tx<
    Array<{ id: string; display_id: string; full_name: string; supplied: string }>
  >`
    SELECT a.id, a.display_id, a.full_name, i.supplied
      FROM unnest(${cleaned}::text[]) AS i(supplied)
      JOIN applicants a
        ON a.cycle_id = ${cycleId}::uuid
       AND (upper(a.display_id) = upper(i.supplied)
            OR a.display_id LIKE '%-' || lpad(regexp_replace(i.supplied, '\\D', '', 'g'), 4, '0'))
     WHERE i.supplied <> ''
  `

  const matchedSupplied = new Set(rows.map((r) => r.supplied.toLowerCase()))

  return {
    matched: rows.map((r) => ({
      applicantId: r.id,
      displayId: r.display_id,
      fullName: r.full_name,
    })),
    unmatched: cleaned.filter((c) => !matchedSupplied.has(c.toLowerCase())),
  }
}

export interface OpenConflict {
  conflictId: string
  displayId: string | null
  kind: string
  createdAt: string
}

/**
 * Conflicts nobody has looked at yet.
 *
 * FR-CHK-015 forbids silent discard. A conflict that is written down and then never surfaced
 * anywhere is a silent discard with extra steps, so this feeds the ops dashboard's Action
 * Required section.
 */
export async function openConflicts(tx: Tx, cycleId: string): Promise<OpenConflict[]> {
  const rows = await tx<
    Array<{ conflict_id: string; display_id: string | null; kind: string; created_at: Date }>
  >`
    SELECT conflict_id, display_id, kind, created_at
      FROM fn_open_sync_conflicts(${cycleId}::uuid)
  `

  return rows.map((r) => ({
    conflictId: r.conflict_id,
    displayId: r.display_id,
    kind: r.kind,
    createdAt: r.created_at.toISOString(),
  }))
}
