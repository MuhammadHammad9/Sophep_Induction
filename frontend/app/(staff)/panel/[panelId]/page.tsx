/**
 * Panel screen route.
 *
 * Server-renders the first snapshot so the interviewer sees a real state rather than a
 * spinner — NFR-USE-007 forbids a loading indicator without context on applicant-facing
 * surfaces, and the same courtesy is worth extending to someone about to interview a person.
 */

import { notFound, redirect } from 'next/navigation'
import { withContext } from '@sophep/backend'
import { requireStaff } from '@/lib/auth/session'
import { PanelConsole } from './PanelConsole'

export const dynamic = 'force-dynamic'

export default async function PanelPage({
  params,
}: {
  params: Promise<{ panelId: string }>
}) {
  const { panelId } = await params

  const staff = await requireStaff(new Request('http://internal/panel'))
  if (!staff) redirect('/staff/sign-in')

  const data = await withContext(staff.context, async (tx) => {
    const panels = await tx<Array<{ name: string; status: string }>>`
      SELECT name, status FROM panels WHERE id = ${panelId}::uuid
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

    return {
      name: panel.name,
      status: panel.status,
      waiting: Number(counts[0]?.waiting ?? 0),
      parked: Number(counts[0]?.parked ?? 0),
    }
  })

  if (!data) notFound()

  return (
    <PanelConsole
      panelId={panelId}
      panelName={data.name}
      initial={{ status: data.status, waiting: data.waiting, parked: data.parked }}
    />
  )
}
