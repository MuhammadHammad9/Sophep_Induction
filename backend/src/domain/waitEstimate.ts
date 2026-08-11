/**
 * Wait estimation.
 *
 * This file fixes errata E11, which was a design failure rather than a bug.
 *
 * v1's rule: "never let the estimate increase while the applicant's queue position has not
 * worsened." If two of four panels break for lunch, the true wait doubles with position
 * unchanged — and v1 would keep displaying the old, now-wrong number. It prioritised the
 * APPEARANCE of stability over telling someone the truth about their afternoon. That is why
 * "never present a number you know is stale as if it were live" is now design principle 2.
 *
 * The correction: revise upward whenever the truth changes, and always say WHY.
 * "Two panels are on break — about 15 minutes longer." An explained increase costs far less
 * trust than a number that was quietly wrong.
 *
 *
 * RETUNED FOR VARIABLE-LENGTH INTERVIEWS.
 *
 * The spec seeds the EWMA at 12 minutes with smoothing 0.3, tuned for a FIXED 12-minute
 * interview. The committee chose 10–30 minutes — a 3× spread — and those constants applied to
 * that variance produce an estimate that visibly lurches after every interview. Since
 * FR-QUE-017 requires every upward revision to be shown with its cause, a jumpy estimate is
 * not merely untidy: it is a stream of alarming notifications to someone already nervous.
 *
 * So: seed 20 min (the midpoint), α 0.2 (slower, less reactive), and a deliberately wide
 * −30%/+50% band. All four are cycle config, tunable on the day without a deployment.
 *
 * Refs: FR-QUE-015..019, E11, rules.md R-026
 */

export interface WaitEstimateConfig {
  seedMinutes: number
  alpha: number
  rangeLowerPct: number
  rangeUpperPct: number
  suppressFirstMinutes: number
  suppressBelowPosition: number
}

export const DEFAULT_WAIT_CONFIG: WaitEstimateConfig = {
  seedMinutes: 20,
  alpha: 0.2,
  rangeLowerPct: 0.7,
  rangeUpperPct: 1.5,
  suppressFirstMinutes: 15,
  suppressBelowPosition: 3,
}

/**
 * Exponentially weighted moving average of observed service time.
 *
 * `ewma = α × latest + (1 − α) × previous`. With α = 0.2 a single unusually long interview
 * moves the estimate by only a fifth of its deviation, which is what keeps a 30-minute outlier
 * from telling everyone in the hall to expect 30 minutes.
 */
export function updateEwma(previousSeconds: number, latestSeconds: number, alpha: number): number {
  return alpha * latestSeconds + (1 - alpha) * previousSeconds
}

export function computeEwma(
  observationsSeconds: readonly number[],
  config: WaitEstimateConfig,
): number {
  let ewma = config.seedMinutes * 60
  for (const observation of observationsSeconds) {
    ewma = updateEwma(ewma, observation, config.alpha)
  }
  return ewma
}

export type SuppressionReason =
  | 'stage_just_started'   // the EWMA has no data yet
  | 'no_open_panel'        // dividing by zero panels is a fiction
  | 'almost_your_turn'     // below position 3, precision is impossible and unnecessary

export type RevisionCause = 'position' | 'panels' | 'service_time'

export type WaitEstimate =
  | { kind: 'suppressed'; reason: SuppressionReason; message: string }
  | {
      kind: 'range'
      lowerMinutes: number
      upperMinutes: number
      message: string
      /** Present only when this estimate is HIGHER than the last one shown (FR-QUE-017). */
      revision?: { cause: RevisionCause; message: string }
    }

export interface WaitEstimateInput {
  position: number
  activePanels: number
  serviceEwmaSeconds: number
  stageRunningMinutes: number
  /** The last value shown to THIS applicant, so an increase can be explained. */
  previousUpperMinutes?: number
  previousActivePanels?: number
  config?: WaitEstimateConfig
}

/**
 * Compute what to display.
 *
 * Returns a RANGE, never a point estimate (FR-QUE-016). A single number is read as a promise,
 * and every broken promise costs trust — "about 15–25 minutes" sets an expectation that the
 * system can actually keep.
 */
export function estimateWait(input: WaitEstimateInput): WaitEstimate {
  const config = input.config ?? DEFAULT_WAIT_CONFIG

  // FR-QUE-018: no open panel → suppress entirely. An ETA computed from zero panels is not a
  // pessimistic estimate, it is a fabrication.
  if (input.activePanels < 1) {
    return {
      kind: 'suppressed',
      reason: 'no_open_panel',
      message: 'We’ll call you shortly — a panel is being assigned.',
    }
  }

  // FR-QUE-018: the first 15 minutes of a stage. The EWMA is still the seed, so any number
  // shown is really just the configured guess wearing a precise-looking hat.
  if (input.stageRunningMinutes < config.suppressFirstMinutes) {
    return {
      kind: 'suppressed',
      reason: 'stage_just_started',
      message: 'We’ll call you shortly.',
    }
  }

  // FR-QUE-019: below position 3, stop estimating. Precision there is impossible and
  // unnecessary — "You're next" is more useful than any number.
  if (input.position <= config.suppressBelowPosition) {
    return {
      kind: 'suppressed',
      reason: 'almost_your_turn',
      message: input.position <= 1 ? 'You’re next — stay nearby.' : 'Almost your turn — stay nearby.',
    }
  }

  const rounds = Math.ceil(input.position / Math.max(input.activePanels, 1))
  const centreMinutes = (rounds * input.serviceEwmaSeconds) / 60

  const lowerMinutes = Math.max(1, Math.round((centreMinutes * config.rangeLowerPct) / 5) * 5)
  const upperMinutes = Math.max(
    lowerMinutes + 5,
    Math.round((centreMinutes * config.rangeUpperPct) / 5) * 5,
  )

  const estimate: WaitEstimate = {
    kind: 'range',
    lowerMinutes,
    upperMinutes,
    message: `About ${lowerMinutes}–${upperMinutes} minutes`,
  }

  // FR-QUE-017 / R-026. Retaining a known-stale value is prohibited, and an increase must
  // arrive WITH its cause. Naming the cause is what makes the increase tolerable: "the queue
  // got worse" is frightening, "two panels are on break" is just information.
  if (input.previousUpperMinutes !== undefined && upperMinutes > input.previousUpperMinutes) {
    const panelsBefore = input.previousActivePanels
    const panelsDropped = panelsBefore !== undefined && input.activePanels < panelsBefore

    if (panelsDropped) {
      const lost = panelsBefore - input.activePanels
      estimate.revision = {
        cause: 'panels',
        message:
          lost === 1
            ? 'One panel is on a break — a little longer than we said.'
            : `${lost} panels are on a break — longer than we said.`,
      }
    } else {
      estimate.revision = {
        cause: 'service_time',
        message: 'Interviews are running a little longer than expected.',
      }
    }
  }

  return estimate
}

/**
 * The capacity model (FR-OPS-007, spec §14.2).
 *
 * Reports a RANGE, because the committee's 10–30 minute interview makes a single number
 * meaningless. `throughput = (60 / minutes) × panels × utilisation`.
 *
 * utilisation defaults to 0.80 to cover changeovers, no-shows, breaks and overruns. Planning
 * at 1.0 is how every induction day runs three hours late — and the number that matters is the
 * PESSIMISTIC one, because that is the day you actually have to survive.
 */
export interface CapacityInput {
  expectedApplicants: number
  panels: number
  minMinutes: number
  maxMinutes: number
  availableHours: number
  utilisation?: number
}

export interface CapacityVerdict {
  bestCaseHours: number
  worstCaseHours: number
  feasible: boolean
  /** Panels needed so that even the worst case fits the window. */
  panelsNeededWorstCase: number
  summary: string
}

export function modelCapacity(input: CapacityInput): CapacityVerdict {
  const utilisation = input.utilisation ?? 0.8
  const panels = Math.max(input.panels, 1)

  const throughput = (minutes: number) => (60 / minutes) * panels * utilisation
  const bestCaseHours = input.expectedApplicants / throughput(input.minMinutes)
  const worstCaseHours = input.expectedApplicants / throughput(input.maxMinutes)

  const perPanelPerHourWorst = (60 / input.maxMinutes) * utilisation
  const panelsNeededWorstCase = Math.ceil(
    input.expectedApplicants / (perPanelPerHourWorst * input.availableHours),
  )

  const feasible = worstCaseHours <= input.availableHours

  return {
    bestCaseHours: round1(bestCaseHours),
    worstCaseHours: round1(worstCaseHours),
    feasible,
    panelsNeededWorstCase,
    summary: feasible
      ? `${round1(bestCaseHours)}–${round1(worstCaseHours)} hours with ${panels} panel(s). ` +
        `Fits the ${input.availableHours}-hour window.`
      : `${round1(bestCaseHours)}–${round1(worstCaseHours)} hours with ${panels} panel(s). ` +
        `Does NOT fit ${input.availableHours} hours — you need ${panelsNeededWorstCase} panels, ` +
        `shorter interviews, or a shortlisting round first.`,
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
