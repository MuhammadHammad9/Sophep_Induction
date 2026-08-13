/**
 * Bulk reconciliation route — the recovery step after a paper fallback.
 *
 * Refs: FR-CHK-017, FR-CHK-019
 */

import { notFound, redirect } from 'next/navigation'
import { withContext } from '@sophep/backend'
import { requireStaff, hasCapability } from '@/lib/auth/session'
import { ReconcileForm } from './ReconcileForm'

export const dynamic = 'force-dynamic'

export default async function ReconcilePage({
  params,
}: {
  params: Promise<{ stageId: string }>
}) {
  const { stageId } = await params

  const staff = await requireStaff()
  if (!staff) redirect('/staff/sign-in')

  // Coordinator+. The route handler and `fn_bulk_reconcile` both check this too — this one is
  // only so the screen is not offered to someone who cannot use it (R-032: the database is the
  // enforcement point, the UI is ergonomics).
  if (!(await hasCapability(staff, 'checkin.reconcile'))) notFound()

  const stage = await withContext(staff.context, async (tx) => {
    const rows = await tx<Array<{ name: string }>>`
      SELECT name FROM stages WHERE id = ${stageId}::uuid
    `
    return rows[0] ?? null
  })

  if (!stage) notFound()

  return <ReconcileForm stageId={stageId} stageName={stage.name} />
}
