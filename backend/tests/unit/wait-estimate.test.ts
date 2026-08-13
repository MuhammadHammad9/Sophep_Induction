/**
 * Wait estimation and the capacity model.
 *
 * The E11 assertions are the important ones here. v1 clamped estimates so they never rose,
 * which meant two panels going to lunch left the screen showing a number known to be wrong.
 *
 * Refs: FR-QUE-015..019, FR-OPS-007, E11, rules.md R-026
 */

import { describe, it, expect } from 'vitest'
import {
  estimateWait,
  computeEwma,
  updateEwma,
  modelCapacity,
  DEFAULT_WAIT_CONFIG,
} from '../../src/domain/waitEstimate'

const base = {
  position: 20,
  activePanels: 4,
  serviceEwmaSeconds: 20 * 60,
  stageRunningMinutes: 60,
}

describe('EWMA', () => {
  it('moves only fractionally on a single outlier', () => {
    // α = 0.2, so a 30-minute interview after a 20-minute average moves it by 2 minutes, not
    // 10. With a 10–30 minute spread this is what stops one long interview telling the whole
    // hall to expect 30.
    const next = updateEwma(20 * 60, 30 * 60, 0.2)
    expect(next / 60).toBeCloseTo(22, 1)
  })

  it('starts from the configured seed with no observations', () => {
    expect(computeEwma([], DEFAULT_WAIT_CONFIG) / 60).toBe(20)
  })

  it('converges towards a sustained new reality', () => {
    const observations = Array.from({ length: 30 }, () => 12 * 60)
    expect(computeEwma(observations, DEFAULT_WAIT_CONFIG) / 60).toBeCloseTo(12, 0)
  })
})

describe('suppression', () => {
  it('suppresses when no panel is open (FR-QUE-018)', () => {
    // Dividing by zero panels is not a pessimistic estimate, it is a fabrication.
    const e = estimateWait({ ...base, activePanels: 0 })
    expect(e.kind).toBe('suppressed')
    expect(e.kind === 'suppressed' && e.reason).toBe('no_open_panel')
  })

  it('suppresses for the first 15 minutes of a stage', () => {
    const e = estimateWait({ ...base, stageRunningMinutes: 5 })
    expect(e.kind === 'suppressed' && e.reason).toBe('stage_just_started')
  })

  it('says "you\'re next" below position 3 (FR-QUE-019)', () => {
    const e = estimateWait({ ...base, position: 2 })
    expect(e.kind === 'suppressed' && e.reason).toBe('almost_your_turn')
    expect(e.message).toMatch(/next|Almost/i)
  })
})

describe('range display', () => {
  it('always returns a range, never a point estimate (FR-QUE-016)', () => {
    const e = estimateWait(base)
    expect(e.kind).toBe('range')
    if (e.kind !== 'range') return
    // A single number is read as a promise, and every broken promise costs trust.
    expect(e.upperMinutes).toBeGreaterThan(e.lowerMinutes)
    expect(e.message).toMatch(/\d+–\d+ minutes/)
  })

  it('widens with the queue', () => {
    const near = estimateWait({ ...base, position: 8 })
    const far = estimateWait({ ...base, position: 40 })
    if (near.kind !== 'range' || far.kind !== 'range') throw new Error('expected ranges')
    expect(far.upperMinutes).toBeGreaterThan(near.upperMinutes)
  })

  it('shortens as panels are added', () => {
    const few = estimateWait({ ...base, activePanels: 2 })
    const many = estimateWait({ ...base, activePanels: 8 })
    if (few.kind !== 'range' || many.kind !== 'range') throw new Error('expected ranges')
    expect(many.upperMinutes).toBeLessThan(few.upperMinutes)
  })
})

describe('honest upward revision (E11)', () => {
  /**
   * The regression test for the design failure. v1 would have kept displaying the old number
   * here, because the applicant's POSITION had not worsened — only the world had.
   */
  it('revises upward and names panels as the cause when panels close', () => {
    const e = estimateWait({
      ...base,
      activePanels: 2,
      previousActivePanels: 4,
      previousUpperMinutes: 30,
    })

    expect(e.kind).toBe('range')
    if (e.kind !== 'range') return
    expect(e.upperMinutes).toBeGreaterThan(30)
    expect(e.revision?.cause).toBe('panels')
    // Naming the cause is what makes the increase tolerable: "two panels are on a break" is
    // information; a number that silently doubles is alarming.
    expect(e.revision?.message).toMatch(/panels are on a break/i)
  })

  it('attributes a rise to service time when panel count is unchanged', () => {
    const e = estimateWait({
      ...base,
      serviceEwmaSeconds: 28 * 60,
      previousActivePanels: 4,
      previousUpperMinutes: 30,
    })
    if (e.kind !== 'range') throw new Error('expected a range')
    expect(e.revision?.cause).toBe('service_time')
  })

  it('does not manufacture a revision when the estimate improves', () => {
    const e = estimateWait({
      ...base,
      activePanels: 8,
      previousActivePanels: 4,
      previousUpperMinutes: 90,
    })
    if (e.kind !== 'range') throw new Error('expected a range')
    expect(e.revision).toBeUndefined()
  })
})

describe('capacity model (FR-OPS-007)', () => {
  it('reports a RANGE, because a 10–30 minute interview has no single answer', () => {
    const v = modelCapacity({
      expectedApplicants: 200,
      panels: 4,
      minMinutes: 10,
      maxMinutes: 30,
      availableHours: 12,
    })

    expect(v.bestCaseHours).toBeLessThan(v.worstCaseHours)
  })

  it('reproduces the specification worked example', () => {
    // Spec §14.2: 12-minute interviews, 4 panels, 0.8 utilisation → 16/hour → 200 applicants
    // needs 12.5 hours, which is impossible in one day.
    const v = modelCapacity({
      expectedApplicants: 200,
      panels: 4,
      minMinutes: 12,
      maxMinutes: 12,
      availableHours: 8,
    })

    expect(v.worstCaseHours).toBeCloseTo(12.5, 1)
    expect(v.feasible).toBe(false)
  })

  it('judges feasibility on the WORST case, not the best', () => {
    // Planning against the optimistic end is how every induction day runs three hours late.
    const v = modelCapacity({
      expectedApplicants: 100,
      panels: 4,
      minMinutes: 10,
      maxMinutes: 30,
      availableHours: 8,
    })

    expect(v.bestCaseHours).toBeLessThan(8)
    expect(v.worstCaseHours).toBeGreaterThan(8)
    expect(v.feasible).toBe(false)
    expect(v.summary).toMatch(/does NOT fit/i)
  })

  it('says how many panels the worst case actually needs', () => {
    const v = modelCapacity({
      expectedApplicants: 200,
      panels: 4,
      minMinutes: 10,
      maxMinutes: 30,
      availableHours: 12,
    })

    expect(v.panelsNeededWorstCase).toBeGreaterThan(4)

    const fixed = modelCapacity({
      expectedApplicants: 200,
      panels: v.panelsNeededWorstCase,
      minMinutes: 10,
      maxMinutes: 30,
      availableHours: 12,
    })
    expect(fixed.feasible).toBe(true)
  })
})
