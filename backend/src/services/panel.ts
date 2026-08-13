import type { Tx } from './db'

export interface PanelSnapshot {
  status: string
  waiting: number
  parked: number
  blockedBy: string[]
}

export async function getPanelSnapshot(
  tx: Tx,
  panelId: string
): Promise<PanelSnapshot | null> {
  const panels = await tx<Array<{ status: string; cycle_id: string }>>`
    SELECT status, cycle_id FROM panels WHERE id = ${panelId}::uuid
  `
  const panel = panels[0]
  if (!panel) return null

  const counts = await tx<Array<{ waiting: string; parked: string }>>`
    SELECT
      count(*) FILTER (WHERE q.state = 'waiting') AS waiting,
      count(*) FILTER (WHERE q.state = 'parked')  AS parked
      FROM queue_entries q
     WHERE q.track_id IN (SELECT track_id FROM panel_tracks WHERE panel_id = ${panelId}::uuid)
  `

  const outstanding =
    panel.status === 'awaiting_evaluations'
      ? await tx<Array<{ full_name: string }>>`
          SELECT u.full_name
            FROM panel_members pm
            JOIN users u ON u.id = pm.interviewer_id
           WHERE pm.panel_id = ${panelId}::uuid AND pm.left_at IS NULL
        `
      : ([] as Array<{ full_name: string }>)

  return {
    status: panel.status,
    waiting: Number(counts[0]?.waiting ?? 0),
    parked: Number(counts[0]?.parked ?? 0),
    blockedBy: outstanding.map((o) => o.full_name),
  }
}
