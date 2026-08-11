/**
 * Normalisation.
 *
 * These cases encode errata E6 directly. v1 declared email_norm as `lower(email)` on a column
 * that was already citext — a genuine no-op — and promised Gmail dot/plus stripping that was
 * never implemented. So `a.b+induction@gmail.com` and `ab@gmail.com` were treated as different
 * people, which v1 explicitly said would not happen.
 *
 * The `sql-parity` suite runs the same table through the database functions. Any divergence
 * between the two implementations is a defect: the TypeScript version drives client-side
 * warnings, the SQL version backs the unique indexes, and if they disagree a user gets warned
 * about a duplicate the database will happily accept, or vice versa.
 *
 * Refs: FR-REG-004, FR-REG-005, E6
 */

import { describe, it, expect } from 'vitest'
import { normEmail, normPhone, normRoll } from '../../src/domain/normalisation'

const EMAIL_CASES: Array<[input: string, expected: string]> = [
  // Gmail: dots ignored, +tags stripped, googlemail folded onto gmail.
  ['a.b+induction@gmail.com', 'ab@gmail.com'],
  ['ab@gmail.com', 'ab@gmail.com'],
  ['A.B+Induction@Gmail.com', 'ab@gmail.com'],
  ['a.b@googlemail.com', 'ab@gmail.com'],
  ['first.last+a+b@gmail.com', 'firstlast@gmail.com'],
  ['  spaced@gmail.com  ', 'spaced@gmail.com'],

  // Non-Gmail: lowercase and trim ONLY. Stripping dots here would merge two genuinely
  // different people, which is a far worse error than missing a duplicate.
  ['a.b@outlook.com', 'a.b@outlook.com'],
  ['A.B@Outlook.com', 'a.b@outlook.com'],
  ['a.b+tag@university.edu.pk', 'a.b+tag@university.edu.pk'],
]

const PHONE_CASES: Array<[input: string, expected: string]> = [
  ['0300-1234567', '001234567'],
  ['+92 300 1234567', '001234567'],
  ['923001234567', '001234567'],
  ['0300 123 4567', '001234567'],
  ['(0300) 1234567', '001234567'],
]

describe('normEmail', () => {
  it.each(EMAIL_CASES)('normalises %s to %s', (input, expected) => {
    expect(normEmail(input)).toBe(expected)
  })

  it('collides the exact pair v1 claimed to handle but did not (E6)', () => {
    expect(normEmail('a.b+induction@gmail.com')).toBe(normEmail('ab@gmail.com'))
  })

  it('does not collide different people on a non-Gmail domain', () => {
    expect(normEmail('a.b@outlook.com')).not.toBe(normEmail('ab@outlook.com'))
  })
})

describe('normPhone', () => {
  it.each(PHONE_CASES)('normalises %s to %s', (input, expected) => {
    expect(normPhone(input)).toBe(expected)
  })

  it('collides every spelling of one Pakistani mobile number', () => {
    const spellings = ['0300-1234567', '+92 300 1234567', '923001234567', '0300 123 4567']
    const normalised = new Set(spellings.map(normPhone))
    expect(normalised.size).toBe(1)
  })

  it('keeps genuinely different numbers apart', () => {
    expect(normPhone('0300-1234567')).not.toBe(normPhone('0300-7654321'))
  })
})

describe('normRoll', () => {
  it('uppercases and strips separators', () => {
    expect(normRoll('2021-cs-101')).toBe('2021CS101')
    expect(normRoll('  2021 CS 101 ')).toBe('2021CS101')
  })
})
