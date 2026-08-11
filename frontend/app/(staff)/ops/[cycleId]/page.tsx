/**
 * Coordinator operations dashboard.
 *
 * Data-dense by design (spec §19.4). Everything needing a human, ranked by urgency, on one
 * screen.
 *
 * ACTION REQUIRED IS THE TOP OF THE PAGE, and when there is nothing to do it says so
 * EXPLICITLY rather than rendering empty (FR-OPS-006). A blank area is ambiguous — a
 * coordinator cannot tell "nothing wrong" from "not loaded". "All clear" is information.
 *
 * The Coordinator sees no scores anywhere on this page, and cannot: `evaluation.view_all` is
 * not among their capabilities and RLS enforces it (migration 0024). Floor authority without
 * score visibility is the entire reason the role exists.
 *
 * Refs: FR-OPS-005, FR-OPS-006, FR-QUE-013, NFR-PERF-007
 */

import { redirect } from 'next/navigation'
import { withContext } from '@sophep/backend'
import { requireStaff } from '@/lib/auth/session'
import { StateBadge } from '@/components/state/StateBadge'

export const dynamic = 'force-dynamic'

interface ActionRow {
  urgency: number
  kind: string
  entity_id: string
  label: string
  detail: string | null
}

interface Kpis {
  waiting: number
  called: number
  in_interview: number
  parked: number
  completed: number
  open_panels: number
}

const ACTION_COPY: Record<string, { title: string; why: string }> = {
  interview_flagged: {
    title: 'Interview flagged — no panel heartbeat',
    why: 'Someone may be sitting in a room with a dead device. Void it to requeue them.',
  },
  track_without_panel: {
    title: 'Track has no open panel',
    why: 'Applicants are waiting with no one to see them, and no wait estimate can be shown.',
  },
  applicant_parked: {
    title: 'Applicant parked — needs locating',
    why: 'They missed two calls. A volunteer should find them before the stage closes.',
  },
  evaluation_outstanding: {
    title: 'Evaluation outstanding',
    why: 'This blocks the panel from calling anyone else. Chase it, or waive it with a reason.',
  },
  delivery_bounced: {
    title: 'Email hard-bounced',
    why: 'This applicant will never receive their result. Correct the address.',
  },
  needs_completion: {
    title: 'Registration incomplete',
    why: 'Registered at the desk in a hurry. Collect the missing details before decisions.',
  },
}

export default async function OpsDashboard({
  params,
}: {
  params: Promise<{ cycleId: string }>
}) {
  const { cycleId } = await params

  const staff = await requireStaff(new Request('http://internal/ops'))
  if (!staff) redirect('/staff/sign-in')

  const { actions, kpis } = await withContext(staff.context, async (tx) => {
    const actions = await tx<ActionRow[]>`SELECT * FROM fn_action_required(${cycleId}::uuid)`

    const kpiRows = await tx<Kpis[]>`
      SELECT
        count(*) FILTER (WHERE q.state = 'waiting')::int      AS waiting,
        count(*) FILTER (WHERE q.state = 'called')::int       AS called,
        count(*) FILTER (WHERE q.state = 'in_interview')::int AS in_interview,
        count(*) FILTER (WHERE q.state = 'parked')::int       AS parked,
        count(*) FILTER (WHERE q.state = 'done')::int         AS completed,
        (SELECT count(*)::int FROM panels p
          WHERE p.cycle_id = ${cycleId}::uuid AND p.status IN ('open', 'busy')) AS open_panels
      FROM queue_entries q
     WHERE q.cycle_id = ${cycleId}::uuid
    `

    return { actions, kpis: kpiRows[0] }
  })

  const updatedAt = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Karachi',
  })

  // Grouped so eight parked applicants are one heading with eight rows, not eight headings.
  const grouped = actions.reduce<Record<string, ActionRow[]>>((acc, row) => {
    ;(acc[row.kind] ??= []).push(row)
    return acc
  }, {})

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-h1">Operations</h1>
        <span className="text-caption text-text-muted">Updated {updatedAt}</span>
      </header>

      {/* Row 1 — KPI strip */}
      <dl className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Waiting" value={kpis?.waiting ?? 0} />
        <Kpi label="Called" value={kpis?.called ?? 0} />
        <Kpi label="In interview" value={kpis?.in_interview ?? 0} />
        <Kpi label="Parked" value={kpis?.parked ?? 0} tone={kpis?.parked ? 'called' : undefined} />
        <Kpi label="Completed" value={kpis?.completed ?? 0} />
        <Kpi
          label="Panels open"
          value={kpis?.open_panels ?? 0}
          tone={kpis?.open_panels === 0 ? 'blocked' : undefined}
        />
      </dl>

      {/* Row 2 — ACTION REQUIRED, first on the page and never empty by omission */}
      <section aria-labelledby="action-required">
        <h2 id="action-required" className="text-h2">
          Action required
        </h2>

        {actions.length === 0 ? (
          // FR-OPS-006. "All clear" is information; a blank area is ambiguous.
          <div className="mt-3 rounded-card border border-state-complete/30 bg-state-complete-fill p-6">
            <StateBadge state="complete">All clear</StateBadge>
            <p className="mt-3 text-body">
              Nothing needs a human right now. If panels are busy, the system is working — go
              and talk to applicants rather than watching this screen.
            </p>
          </div>
        ) : (
          <div className="mt-3 space-y-4">
            {Object.entries(grouped).map(([kind, rows]) => {
              const copy = ACTION_COPY[kind] ?? { title: kind, why: '' }
              const urgent = (rows[0]?.urgency ?? 9) <= 2

              return (
                <div
                  key={kind}
                  className={`rounded-card border p-4 ${
                    urgent
                      ? 'border-state-blocked/40 bg-state-blocked-fill'
                      : 'border-state-called/40 bg-state-called-fill'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-semibold">{copy.title}</h3>
                    <span className="id-text text-h2">{rows.length}</span>
                  </div>
                  {/* R-058: never a bare list. Say what it means and what to do. */}
                  <p className="mt-1 text-small text-text-muted">{copy.why}</p>

                  <ul className="mt-3 space-y-1">
                    {rows.slice(0, 8).map((row) => (
                      <li key={row.entity_id} className="flex gap-3 text-small">
                        <span className="id-text">{row.label}</span>
                        {row.detail ? (
                          <span className="text-text-muted">{row.detail}</span>
                        ) : null}
                      </li>
                    ))}
                    {rows.length > 8 ? (
                      <li className="text-small text-text-muted">
                        …and {rows.length - 8} more
                      </li>
                    ) : null}
                  </ul>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'called' | 'blocked'
}) {
  return (
    <div
      className={`rounded-card border p-3 ${
        tone === 'blocked'
          ? 'border-state-blocked/40 bg-state-blocked-fill'
          : tone === 'called'
            ? 'border-state-called/40 bg-state-called-fill'
            : 'border-border bg-surface'
      }`}
    >
      <dt className="text-caption uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="id-text text-h1">{value}</dd>
    </div>
  )
}
