import { NextResponse } from 'next/server'
import { withContext } from '@sophep/backend'
import { requireStaff } from '@/lib/auth/session'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ stageId: string }> }
) {
  const { stageId } = await params

  const staff = await requireStaff()
  if (!staff) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const data = await withContext(staff.context, async (tx) => {
      // Find all parked queue entries for tracks in this stage
      const rows = await tx<Array<{ parked_count: string }>>`
        SELECT count(*) AS parked_count
          FROM queue_entries q
          JOIN tracks t ON t.id = q.track_id
         WHERE t.stage_id = ${stageId}::uuid
           AND q.state = 'parked'
      `
      return { parked: Number(rows[0]?.parked_count ?? 0) }
    })
    return NextResponse.json(data)
  } catch (err) {
    console.error('Failed to fetch parked count', err)
    return NextResponse.json({ error: 'Failed to fetch' }, { status: 500 })
  }
}
