/**
 * The public application page.
 *
 * Departments are read server-side. RLS permits an unauthenticated read of ACTIVE departments
 * belonging to a cycle whose registration is genuinely open — so a draft cycle's configuration
 * stays private even though this page needs no login (see migration 0008).
 */

import { withContext } from '@sophep/backend'
import { ApplyForm, type Department } from './ApplyForm'

export const dynamic = 'force-dynamic'

async function loadOpenCycle(): Promise<{
  cycleId: string
  cycleName: string
  departments: Department[]
  maxPreferences: number
} | null> {
  // No security context: this is the public form, and it should see exactly what an
  // anonymous visitor is permitted to see. Nothing more.
  return withContext({}, async (tx) => {
    const cycles = await tx<Array<{ id: string; name: string; config: Record<string, unknown> }>>`
      SELECT id, name, config FROM cycles WHERE state = 'registration_open' LIMIT 1
    `
    const cycle = cycles[0]
    if (!cycle) return null

    const departments = await tx<Array<{ id: string; name: string }>>`
      SELECT id, name FROM departments
       WHERE cycle_id = ${cycle.id}::uuid AND is_active
       ORDER BY sort_order, name
    `

    return {
      cycleId: cycle.id,
      cycleName: cycle.name,
      departments,
      maxPreferences: Number(cycle.config['max_preferences'] ?? 3),
    }
  })
}

export default async function ApplyPage() {
  const data = await loadOpenCycle()

  // FR-CYC-004 is enforced at the API too. This is the human-readable half of the same rule —
  // and it says WHEN, not just "closed", because "closed" alone sends someone to ask a person.
  if (!data) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <h1 className="text-h1">Applications are closed</h1>
        <p className="mt-2 text-text-muted">
          There is no induction cycle accepting applications right now. Follow SOPHEP for the
          announcement of the next one.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="text-h1">Apply to SOPHEP</h1>
      <p className="mt-1 text-text-muted">{data.cycleName}</p>

      <p className="mt-4 text-small text-text-muted">
        Takes about two minutes. You will get an applicant ID and a status page link by email.
      </p>

      <div className="mt-8">
        <ApplyForm
          cycleId={data.cycleId}
          departments={data.departments}
          maxPreferences={data.maxPreferences}
        />
      </div>
    </div>
  )
}
