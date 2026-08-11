/**
 * State indicators.
 *
 * This product is a queue. Every screen answers "what state am I in?", so state must be
 * legible BEFORE anyone reads a word (spec §18.3).
 *
 * Colour is never the sole signal (rules.md R-060, NFR-A11Y-002). Each state carries a
 * distinct icon AND a distinct shape in addition to its colour. About 1 in 12 men has a
 * colour-vision deficiency, which at a university induction is several people in the hall —
 * including, statistically, one of the volunteers running it.
 */

export type UiState = 'waiting' | 'live' | 'called' | 'complete' | 'blocked' | 'offline'

interface StateVisual {
  label: string
  /** Distinct SHAPE, not merely a distinct colour. */
  icon: React.ReactNode
  className: string
  dotClassName: string
}

const HollowDot = () => (
  <span
    aria-hidden="true"
    className="inline-block h-2.5 w-2.5 rounded-full border-2 border-current"
  />
)

const PulsingDot = () => (
  <span aria-hidden="true" className="relative inline-flex h-2.5 w-2.5">
    {/* Removed entirely under prefers-reduced-motion — see globals.css */}
    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-current" />
  </span>
)

const SolidBar = () => (
  <span aria-hidden="true" className="inline-block h-4 w-1 rounded-sm bg-current" />
)

const Check = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current stroke-2">
    <path d="M3 8.5l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const Cross = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current stroke-2">
    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
  </svg>
)

const Stripes = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-none stroke-current stroke-2">
    <path d="M1 11L11 1M5 15L15 5" strokeLinecap="round" />
  </svg>
)

const VISUALS: Record<UiState, StateVisual> = {
  waiting: {
    label: 'Waiting',
    icon: <HollowDot />,
    className: 'bg-state-waiting-fill text-state-waiting border-state-waiting/30',
    dotClassName: 'text-state-waiting',
  },
  live: {
    label: 'In progress',
    icon: <PulsingDot />,
    className: 'bg-state-live-fill text-state-live border-state-live/30',
    dotClassName: 'text-state-live',
  },
  called: {
    label: 'Called',
    icon: <SolidBar />,
    className: 'bg-state-called-fill text-state-called border-l-4 border-state-called',
    dotClassName: 'text-state-called',
  },
  complete: {
    label: 'Complete',
    icon: <Check />,
    className: 'bg-state-complete-fill text-state-complete border-state-complete/30',
    dotClassName: 'text-state-complete',
  },
  blocked: {
    label: 'Blocked',
    icon: <Cross />,
    className: 'bg-state-blocked-fill text-state-blocked border-state-blocked/30',
    dotClassName: 'text-state-blocked',
  },
  offline: {
    label: 'Offline',
    icon: <Stripes />,
    className: 'bg-state-offline-fill text-state-offline border-state-offline/30 stripe-offline',
    dotClassName: 'text-state-offline',
  },
}

export function StateBadge({
  state,
  children,
  className = '',
}: {
  state: UiState
  children?: React.ReactNode
  className?: string
}) {
  const v = VISUALS[state]
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-pill border px-3 py-1 text-small font-medium ${v.className} ${className}`}
    >
      {v.icon}
      <span>{children ?? v.label}</span>
    </span>
  )
}

/**
 * The full-width status band on the applicant status page.
 *
 * `role="status"` announces changes to assistive technology without stealing focus, which
 * matters on a page someone leaves open for an hour (NFR-A11Y-005).
 */
export function StatusBand({
  state,
  headline,
  detail,
}: {
  state: UiState
  headline: string
  detail?: string
}) {
  const v = VISUALS[state]
  return (
    <div role="status" className={`flex items-center gap-3 rounded-card border p-4 ${v.className}`}>
      <span className={v.dotClassName}>{v.icon}</span>
      <div>
        <p className="font-semibold">{headline}</p>
        {detail ? <p className="text-small opacity-90">{detail}</p> : null}
      </div>
    </div>
  )
}
