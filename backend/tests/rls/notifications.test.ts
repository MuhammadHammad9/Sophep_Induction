/**
 * Notification enqueueing.
 *
 * The property under test is that the public application form cannot be used as an open mail
 * relay. `notifications` deliberately has NO INSERT policy; the only write path is
 * fn_enqueue_notification, which derives the recipient from the applicant record rather than
 * accepting it from the caller.
 *
 * Without that, an unauthenticated caller could enqueue arbitrary subject and body content to
 * any address, sent from the society's verified sending domain — a phishing vector wearing
 * SOPHEP's name, which would pass every other test in this suite.
 *
 * Refs: FR-NOT-001, FR-NOT-005, NFR-PRIV-002
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type postgres from 'postgres'
import { testDb, migrate, resetSchema, seedFixture, asAnonymous, type Fixture } from '../helpers'

let sql: postgres.Sql<Record<string, never>>
let fx: Fixture
let applicantId: string

beforeAll(async () => {
  sql = testDb()
  await resetSchema(sql)
  await migrate(sql)
  fx = await seedFixture(sql)

  const [a] = await sql<Array<{ id: string }>>`
    SELECT id FROM fn_register_applicant(
      ${fx.cycleId}::uuid, 'Notify Me', 'notify@example.com', '03004440001', 'online')
  `
  applicantId = a!.id
}, 300_000)

afterAll(async () => {
  await sql?.end()
})

describe('the only write path', () => {
  it('refuses a direct INSERT even from the application role', async () => {
    // No INSERT policy exists, by design.
    await expect(
      asAnonymous(sql, async (tx) => {
        return tx`
          INSERT INTO notifications (
            cycle_id, applicant_id, template_key, template_version,
            to_email, subject, body_html, body_text, state
          ) VALUES (
            ${fx.cycleId}::uuid, ${applicantId}::uuid, 'evil', 1,
            'attacker@example.com', 'Reset your password',
            '<p>click here</p>', 'click here', 'pending'
          )
        `
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('sends to the applicant address, never one the caller supplies', async () => {
    // The function signature has no recipient parameter at all — that is the control.
    const [row] = await asAnonymous(sql, async (tx) => {
      return tx<Array<{ fn_enqueue_notification: string }>>`
        SELECT fn_enqueue_notification(
          ${applicantId}::uuid, 'registration.confirmation', 1::smallint,
          'Your SOPHEP application', '<p>hello</p>', 'hello')
      `
    })

    const [queued] = await sql<Array<{ to_email: string; state: string }>>`
      SELECT to_email, state FROM notifications
       WHERE id = ${row!.fn_enqueue_notification}::uuid
    `

    expect(queued!.to_email).toBe('notify@example.com')
    expect(queued!.state).toBe('pending')
  })

  it('rejects an unknown applicant', async () => {
    await expect(
      asAnonymous(sql, async (tx) => {
        return tx`
          SELECT fn_enqueue_notification(
            ${'00000000-0000-0000-0000-000000000000'}::uuid,
            'registration.confirmation', 1::smallint, 's', 'h', 't')
        `
      }),
    ).rejects.toThrow(/not found/i)
  })
})

describe('hard bounce suppression', () => {
  /**
   * FR-NOT-005 / FR-DEC-013. Re-sending to an address that hard bounced damages sending
   * reputation for the whole cohort — which on results day means other applicants never learn
   * their outcome.
   */
  it('refuses to enqueue to an address that has hard bounced', async () => {
    const [bouncer] = await sql<Array<{ id: string }>>`
      SELECT id FROM fn_register_applicant(
        ${fx.cycleId}::uuid, 'Bad Address', 'bounced@example.com', '03004440002', 'online')
    `

    const [n] = await sql<Array<{ fn_enqueue_notification: string }>>`
      SELECT fn_enqueue_notification(
        ${bouncer!.id}::uuid, 'registration.confirmation', 1::smallint, 's', 'h', 't')
    `
    await sql`
      UPDATE notifications
         SET state = 'bounced', bounce_type = 'hard', bounced_at = now()
       WHERE id = ${n!.fn_enqueue_notification}::uuid
    `

    await expect(
      sql`
        SELECT fn_enqueue_notification(
          ${bouncer!.id}::uuid, 'registration.confirmation', 1::smallint, 's', 'h', 't')
      `,
    ).rejects.toThrow(/SUPPRESSED_HARD_BOUNCE/)
  })

  it('still delivers to unaffected addresses', async () => {
    const [ok] = await sql<Array<{ fn_enqueue_notification: string }>>`
      SELECT fn_enqueue_notification(
        ${applicantId}::uuid, 'registration.confirmation', 1::smallint, 's', 'h', 't')
    `
    expect(ok!.fn_enqueue_notification).toBeTruthy()
  })
})

describe('applicant visibility', () => {
  it('lets an applicant see only their own messages', async () => {
    const [other] = await sql<Array<{ id: string }>>`
      SELECT id FROM fn_register_applicant(
        ${fx.cycleId}::uuid, 'Other Person', 'other@example.com', '03004440003', 'online')
    `
    await sql`
      SELECT fn_enqueue_notification(
        ${other!.id}::uuid, 'registration.confirmation', 1::smallint, 's', 'h', 't')
    `

    const rows = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE rms_app`
      await tx`SELECT set_config('app.applicant_id', ${applicantId}, true)`
      return tx<Array<{ applicant_id: string }>>`SELECT applicant_id FROM notifications`
    })

    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.applicant_id).toBe(applicantId)
    }
  })
})
