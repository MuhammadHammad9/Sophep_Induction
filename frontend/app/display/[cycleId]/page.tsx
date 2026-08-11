/**
 * The public display board.
 *
 * Shown on a TV in the hall. Read at 15 metres by people who are anxious and not looking
 * directly at it.
 *
 * IDs only, never names (FR-OPS-009, R-028) — enforced at the publisher in fn_display_board,
 * not by this template omitting a field. Large mono type, high contrast, and no animation
 * beyond a gentle fade: motion on a wall screen sits in the peripheral vision of everyone
 * waiting, and is a distraction to all of them at once.
 *
 * Refs: FR-OPS-009, FR-OPS-010, NFR-PRIV-006, spec §19.5
 */

import { withContext } from '@sophep/backend'

export const dynamic = 'force-dynamic'
// Polled rather than live: a wall screen has no user to notice a dropped socket, so a simple
// refresh is more reliable than a connection nobody is watching (NFR-AVAIL-003).
export const revalidate = 0

interface BoardRow {
  display_id: string
  room_name: string
  called_at: Date
}

interface Summary {
  waiting: number
  in_interview: number
  open_panels: number
}

export default async function DisplayBoard({
  params,
}: {
  params: Promise<{ cycleId: string }>
}) {
  const { cycleId } = await params

  const { rows, summary } = await withContext({}, async (tx) => {
    const rows = await tx<BoardRow[]>`SELECT * FROM fn_display_board(${cycleId}::uuid)`
    const summaryRows = await tx<Summary[]>`SELECT * FROM fn_display_summary(${cycleId}::uuid)`
    return { rows, summary: summaryRows[0] }
  })

  const updatedAt = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Karachi',
  })

  return (
    <div className="min-h-dvh bg-[#0F172A] p-8 text-white">
      <h1 className="text-center text-[3vw] font-semibold uppercase tracking-[0.2em] text-slate-300">
        Now Calling
      </h1>

      {rows.length === 0 ? (
        <p className="mt-[10vh] text-center text-[3vw] text-slate-400">
          No one is being called right now
        </p>
      ) : (
        <ul className="mt-[6vh] space-y-[2vh]">
          {rows.map((row) => (
            <li
              key={`${row.display_id}-${row.called_at}`}
              className="flex items-center justify-center gap-[4vw]"
            >
              {/* Mono + tabular figures: the ID must be readable and stable at distance. */}
              <span className="id-text text-[5vw] font-medium tracking-wider">
                {row.display_id}
              </span>
              <span aria-hidden="true" className="text-[3vw] text-slate-500">
                →
              </span>
              <span className="text-[5vw] font-semibold text-state-called">{row.room_name}</span>
            </li>
          ))}
        </ul>
      )}

      <footer className="fixed inset-x-0 bottom-0 flex items-baseline justify-center gap-[4vw] border-t border-slate-700 bg-[#0F172A] p-[2vh] text-[2vw] text-slate-400">
        <span>
          Waiting <span className="id-text text-white">{summary?.waiting ?? 0}</span>
        </span>
        <span>
          In interview <span className="id-text text-white">{summary?.in_interview ?? 0}</span>
        </span>
        <span>
          Panels <span className="id-text text-white">{summary?.open_panels ?? 0}</span>
        </span>
        {/* NFR-AVAIL-004: every surface presenting live data carries a last-updated instant.
            A number someone knows is three minutes old is fine; a frozen one they trust is not. */}
        <span className="text-[1.5vw]">Updated {updatedAt}</span>
      </footer>
    </div>
  )
}
