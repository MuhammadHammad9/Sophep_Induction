/**
 * Duplicate-detection normalisation — the TypeScript mirror of the SQL functions in
 * migration 0001.
 *
 * These exist so the client can warn about a likely duplicate before a round trip. The SQL
 * functions remain authoritative: they back the generated columns and the partial unique
 * indexes, and client-side validation is never the sole gate (FR-REG-003).
 *
 * Any divergence between these and the SQL is a defect. The parity tests in
 * tests/unit/normalisation.test.ts run the same table of cases through both.
 */

/**
 * Normalise an email address.
 *
 * Gmail ignores dots in the local part and treats `+suffix` as a tag, so
 * `A.B+induction@Gmail.com` and `ab@gmail.com` are one mailbox. Other providers are lowercased
 * and trimmed only — stripping dots for Outlook would merge two genuinely different people,
 * which is a far worse error than missing a duplicate.
 *
 * FR-REG-004
 */
export function normEmail(addr: string): string {
  const lowered = addr.trim().toLowerCase()
  const at = lowered.lastIndexOf('@')
  if (at === -1) return lowered

  const local = lowered.slice(0, at)
  const domain = lowered.slice(at + 1)

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const untagged = local.split('+')[0] ?? ''
    return `${untagged.replaceAll('.', '')}@gmail.com`
  }
  return `${local}@${domain}`
}

/**
 * Normalise a phone number to its final 9 digits.
 *
 * `0300-1234567`, `+92 300 1234567` and `923001234567` are the same person. The last 9 digits
 * are the part that stays stable across every spelling.
 *
 * FR-REG-005
 */
export function normPhone(phone: string): string {
  return phone.replace(/\D/g, '').slice(-9)
}

/** Uppercase, strip whitespace and hyphens. */
export function normRoll(roll: string): string {
  return roll.replace(/[\s-]/g, '').toUpperCase()
}
