/**
 * Scoring: empirical-Bayes shrinkage, flags and review bands.
 *
 * This file exists because v1 got the maths wrong in two separate ways, and both errors
 * produced numbers that looked entirely reasonable.
 *
 * E3 — v1 fell back to RAW scores for interviewers with fewer than 8 evaluations and used
 * NORMALISED scores otherwise, then averaged the two together. Those are different scales, so
 * an applicant seen by one experienced and one new interviewer received the mean of two
 * incommensurable numbers. Worse, it created a CLIFF: an interviewer's 8th evaluation
 * retroactively rescaled the previous seven, so two identically-scored applicants could rank
 * differently based on how many OTHER people their interviewer happened to see that day.
 *
 * E2 — v1 mapped scores to mean 50, sd 10 and then applied thresholds calibrated for a raw
 * 0–100 rubric. `auto_shortlist_above = 75` is +2.5σ on that mapping: roughly the top 0.6%,
 * about one person in 200.
 *
 * The correction is one continuous formula, always applied, with no mode switching and no
 * cliff — and bands expressed relative to capacity rather than as absolute numbers.
 *
 * Refs: FR-SCR-001..014, E2, E3
 */

/**
 * Shrinkage constant. w = n/(n+k), so k is the number of evaluations at which we trust an
 * interviewer's measured bias half way.
 */
export const DEFAULT_SHRINKAGE_K = 5

export interface EvaluationInput {
  evaluationId: string
  applicantId: string
  interviewerId: string
  rawScore: number
  /** Criterion scores, normalised to 0–1 against the rubric scale. */
  criterionFractions: number[]
  recommendedDepartmentId?: string | null
}

export interface InterviewerBias {
  interviewerId: string
  n: number
  mean: number
  bias: number
  weight: number
}

export interface AdjustedEvaluation {
  evaluationId: string
  applicantId: string
  interviewerId: string
  rawScore: number
  adjustedScore: number
  shrinkageWeight: number
}

/**
 * Compute per-interviewer bias against the cohort.
 *
 * `cohort_mean` is the mean across EVERY evaluation in the cycle — not per department, not per
 * panel. An interviewer who only ever saw strong applicants would otherwise be measured
 * against a cohort of strong applicants and judged unbiased.
 */
export function computeBiases(
  evaluations: readonly EvaluationInput[],
  k: number = DEFAULT_SHRINKAGE_K,
): { cohortMean: number; biases: Map<string, InterviewerBias> } {
  const biases = new Map<string, InterviewerBias>()
  if (evaluations.length === 0) return { cohortMean: 0, biases }

  const cohortMean =
    evaluations.reduce((sum, e) => sum + e.rawScore, 0) / evaluations.length

  const byInterviewer = new Map<string, number[]>()
  for (const e of evaluations) {
    const list = byInterviewer.get(e.interviewerId) ?? []
    list.push(e.rawScore)
    byInterviewer.set(e.interviewerId, list)
  }

  for (const [interviewerId, scores] of byInterviewer) {
    const n = scores.length
    const mean = scores.reduce((a, b) => a + b, 0) / n

    biases.set(interviewerId, {
      interviewerId,
      n,
      mean,
      bias: mean - cohortMean,
      // At n=1, w≈0.17 — almost no adjustment, correctly reflecting that one data point says
      // very little about a person's strictness. At n=30, w≈0.86.
      weight: n / (n + k),
    })
  }

  return { cohortMean, biases }
}

/**
 * Apply shrinkage.
 *
 * `adjusted = raw − (w × bias)`, which stays on the SAME 0–100 scale as raw. That is what
 * makes raw and adjusted directly comparable and lets both be shown side by side
 * (FR-SCR-014) — the review meeting must see what actually happened, not only what the maths
 * concluded.
 *
 * Deliberately NOT clamped to 0–100. A lenient interviewer's 100 legitimately adjusts above
 * 100, and clamping would silently compress exactly the applicants the correction is meant to
 * separate. The value is a corrected measurement, not a percentage.
 */
export function applyShrinkage(
  evaluations: readonly EvaluationInput[],
  k: number = DEFAULT_SHRINKAGE_K,
): { cohortMean: number; adjusted: AdjustedEvaluation[] } {
  const { cohortMean, biases } = computeBiases(evaluations, k)

  const adjusted = evaluations.map((e) => {
    const b = biases.get(e.interviewerId)!
    return {
      evaluationId: e.evaluationId,
      applicantId: e.applicantId,
      interviewerId: e.interviewerId,
      rawScore: e.rawScore,
      adjustedScore: round2(e.rawScore - b.weight * b.bias),
      shrinkageWeight: round3(b.weight),
    }
  })

  return { cohortMean, adjusted }
}

/** FR-SCR-006: the applicant's final score is the arithmetic mean of their adjusted scores. */
export function applicantFinalScore(adjusted: readonly AdjustedEvaluation[]): number {
  if (adjusted.length === 0) return 0
  return round2(adjusted.reduce((s, a) => s + a.adjustedScore, 0) / adjusted.length)
}

// ── Flags ───────────────────────────────────────────────────────────────────────────────

export type ScoreFlag =
  | 'HIGH_DISAGREEMENT'
  | 'CRITERION_FLOOR'
  | 'LOW_CONFIDENCE'
  | 'SINGLE_EVALUATOR'

export interface FlagConfig {
  /** FR-SCR-007: adjusted spread across the panel above this raises disagreement. */
  disagreementThreshold: number
  /**
   * FR-SCR-008 says "any criterion scored 2 or below on a 5-point scale". Our rubrics carry a
   * configurable scale, so a literal `<= 2` would mean different things on 1–5 and 0–10.
   * Expressed as a FRACTION of the scale: 0.25 is exactly "≤ 2" on 1–5 and generalises.
   */
  criterionFloorFraction: number
  /** FR-SCR-009: every evaluator having fewer than this raises low confidence. */
  lowConfidenceN: number
}

export const DEFAULT_FLAG_CONFIG: FlagConfig = {
  disagreementThreshold: 20,
  criterionFloorFraction: 0.25,
  lowConfidenceN: 5,
}

/**
 * Raise flags for one applicant.
 *
 * Flags exist because averaging away disagreement hides exactly the information a committee
 * exists to weigh. A 50 from two people who both said 50 is a very different case from a 50
 * that is the mean of 20 and 80 — and only the second one needs a conversation.
 */
export function flagsForApplicant(
  evaluations: readonly EvaluationInput[],
  adjusted: readonly AdjustedEvaluation[],
  biases: ReadonlyMap<string, InterviewerBias>,
  config: FlagConfig = DEFAULT_FLAG_CONFIG,
): ScoreFlag[] {
  const flags: ScoreFlag[] = []
  if (evaluations.length === 0) return flags

  // FR-SCR-010: no agreement signal at all.
  if (evaluations.length === 1) flags.push('SINGLE_EVALUATOR')

  // FR-SCR-007: the case where a human adds most value.
  if (adjusted.length >= 2) {
    const scores = adjusted.map((a) => a.adjustedScore)
    const spread = Math.max(...scores) - Math.min(...scores)
    if (spread > config.disagreementThreshold) flags.push('HIGH_DISAGREEMENT')
  }

  // FR-SCR-008: a strong signal that a high average can hide — someone can average well and
  // still have been rated near the floor on the one thing that matters for the role.
  const floored = evaluations.some((e) =>
    e.criterionFractions.some((f) => f <= config.criterionFloorFraction),
  )
  if (floored) flags.push('CRITERION_FLOOR')

  // FR-SCR-009: the bias estimate is weak, so read the raw score rather than the adjusted one.
  const allInexperienced = evaluations.every(
    (e) => (biases.get(e.interviewerId)?.n ?? 0) < config.lowConfidenceN,
  )
  if (allInexperienced) flags.push('LOW_CONFIDENCE')

  return flags
}

// ── Review bands ────────────────────────────────────────────────────────────────────────

export type ReviewBand = 'clear' | 'discuss' | 'below' | 'excluded'

export interface BandConfig {
  clearMultiplier: number   // FR-SCR-011: rank <= 0.75C
  discussMultiplier: number // FR-SCR-011: rank <= 2C
}

export const DEFAULT_BAND_CONFIG: BandConfig = {
  clearMultiplier: 0.75,
  discussMultiplier: 2.0,
}

/**
 * Which band an applicant falls into for a department.
 *
 * Relative to CAPACITY, never an absolute score (E2). Absolute cutoffs need recalibrating
 * every cycle and were miscalibrated in v1; rank scales automatically to any cohort size and
 * never needs touching between cycles.
 *
 * For an 8-place department: ranks 1–6 clear, 7–16 discussed, 17+ below — roughly ten
 * discussions per department, which is a review meeting that finishes.
 */
export function reviewBand(
  rank: number,
  capacity: number,
  flags: readonly ScoreFlag[],
  config: BandConfig = DEFAULT_BAND_CONFIG,
): ReviewBand {
  // FR-SCR-013: auto-excluded irrespective of rank, subject to manual override. Checked
  // FIRST — a criterion floor is a substantive concern that a high rank does not answer.
  if (flags.includes('CRITERION_FLOOR')) return 'excluded'

  if (rank > capacity * config.discussMultiplier) return 'below'

  // FR-SCR-012: any flag forces a discussion regardless of rank. A clear admit with high
  // disagreement is precisely the case a committee should look at.
  if (flags.length > 0) return 'discuss'

  return rank <= capacity * config.clearMultiplier ? 'clear' : 'discuss'
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
