/**
 * Check-in desk route.
 *
 * NFR-USE-002: a volunteer with no prior exposure must complete a check-in within 60 seconds
 * of first opening this, without written instruction. That is why the page is the camera and
 * almost nothing else.
 */

import { notFound, redirect } from 'next/navigation'
import { withContext } from '@sophep/backend'
import { requireStaff } from '@/lib/auth/session'
import { Scanner } from './Scanner'

export const dynamic = 'force-dynamic'

export default async function CheckInPage({
  params,
}: {
  params: Promise<{ stageId: string }>
}) {
  const { stageId } = await params

  const staff = await requireStaff()
  if (!staff) redirect('/staff/sign-in')

  const stage = await withContext(staff.context, async (tx) => {
    const rows = await tx<Array<{ name: string; closed_at: Date | null }>>`
      SELECT name, closed_at FROM stages WHERE id = ${stageId}::uuid
    `
    return rows[0] ?? null
  })

  if (!stage) notFound()

  return <Scanner stageId={stageId} deskName={stage.name} />
}
