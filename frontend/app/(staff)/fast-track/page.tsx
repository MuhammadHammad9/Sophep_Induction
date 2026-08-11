import { withContext } from '@sophep/backend'
import { FastTrackForm } from './FastTrackForm'

export const dynamic = 'force-dynamic'

async function loadOpenCycleAndStage(): Promise<{
  cycleId: string
  cycleName: string
  stageId: string
} | null> {
  // Use public context to find open cycles and active stages
  return withContext({}, async (tx) => {
    const cycles = await tx<Array<{ id: string; name: string }>>`
      SELECT id, name FROM cycles WHERE state = 'registration_open' OR state = 'interviews_active' LIMIT 1
    `
    const cycle = cycles[0]
    if (!cycle) return null

    const stages = await tx<Array<{ id: string }>>`
      SELECT id FROM stages
       WHERE cycle_id = ${cycle.id}::uuid AND state = 'active'
       ORDER BY start_time ASC LIMIT 1
    `
    const stage = stages[0]
    if (!stage) return null

    return {
      cycleId: cycle.id,
      cycleName: cycle.name,
      stageId: stage.id,
    }
  })
}

export default async function FastTrackPage() {
  const data = await loadOpenCycleAndStage()

  if (!data) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <h1 className="text-h1">No active stage</h1>
        <p className="mt-2 text-text-muted">
          Fast-track registration is only available when there is an active check-in stage.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="text-h1">Fast-Track</h1>
      <p className="mt-1 text-text-muted">Walk-in Registration & Check-in</p>

      <div className="mt-8">
        <FastTrackForm
          cycleId={data.cycleId}
          stageId={data.stageId}
        />
      </div>
    </div>
  )
}
