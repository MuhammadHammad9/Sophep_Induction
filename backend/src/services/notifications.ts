/**
 * Outbound notifications.
 *
 * FR-NOT-001: email is dispatched via an asynchronous queue with retry, and is NEVER sent
 * synchronously inside a request a user is waiting on. That rule is not about performance —
 * it is CON-004 and IR-006: no third-party service may sit in the synchronous path, because
 * the event must not stop when someone else's API is slow.
 *
 * No Resend account or verified sending domain exists yet, so the mock adapter is active: rows
 * are written and stop at `queued`, and render at the local preview route. Because the queue
 * contract holds either way, switching to Resend is an adapter swap rather than an
 * architecture change — and the asynchronous property is real from day one rather than
 * something to retrofit under deadline.
 *
 * FR-NOT-001..005, rules.md R-030, R-050
 */

import type { Tx } from './db'

export interface NotificationRequest {
  cycleId: string
  applicantId?: string
  userId?: string
  toEmail: string
  templateKey: string
  variables: Record<string, string>
}

export interface RenderedMessage {
  subject: string
  html: string
  text: string
}

/**
 * FR-NOT-004: templates are configuration, previewable and versioned. Content is never
 * hard-coded — a committee changes wording without a deployment.
 *
 * These seed defaults live here only until the templates table lands in Phase 4; the shape is
 * already the one that table will hold.
 */
export const TEMPLATES: Record<
  string,
  { version: number; subject: string; render: (v: Record<string, string>) => RenderedMessage }
> = {
  'registration.confirmation': {
    version: 1,
    subject: 'Your SOPHEP application — {{displayId}}',
    render: (v) => ({
      subject: `Your SOPHEP application — ${v['displayId']}`,
      text: [
        `Hello ${v['fullName']},`,
        ``,
        `Your application is received. Your applicant ID is ${v['displayId']}.`,
        ``,
        `Check your status any time: ${v['statusUrl']}`,
        ``,
        `On interview day, show the QR code on that page at the check-in desk.`,
        `You do not need to print anything.`,
        ``,
        `— SOPHEP`,
      ].join('\n'),
      html: [
        `<p>Hello ${escapeHtml(v['fullName'] ?? '')},</p>`,
        `<p>Your application is received. Your applicant ID is`,
        `<strong style="font-family:monospace;font-size:18px">${escapeHtml(v['displayId'] ?? '')}</strong>.</p>`,
        `<p><a href="${escapeHtml(v['statusUrl'] ?? '')}">Check your status</a></p>`,
        `<p>On interview day, show the QR code on that page at the check-in desk.`,
        `You do not need to print anything.</p>`,
        `<p>— SOPHEP</p>`,
      ].join('\n'),
    }),
  },
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Enqueue a message. Returns immediately — the row is picked up by the dispatch worker.
 *
 * FR-REG-012 promises a confirmation within 60 seconds of submission. That is a queue latency
 * target, not a reason to send inline.
 */
export async function enqueue(tx: Tx, req: NotificationRequest): Promise<string> {
  const template = TEMPLATES[req.templateKey]
  if (!template) {
    throw new Error(`unknown notification template "${req.templateKey}"`)
  }
  if (!req.applicantId) {
    throw new Error('enqueue requires an applicantId — the recipient is derived from it')
  }

  const rendered = template.render(req.variables)

  // Note what is NOT passed: the recipient address. fn_enqueue_notification reads it from the
  // applicant record, so a caller can never redirect a message to an address of their
  // choosing. Without that, the unauthenticated application form would be an open mail relay
  // sending from the society's verified domain (migration 0014).
  const rows = await tx<Array<{ fn_enqueue_notification: string }>>`
    SELECT fn_enqueue_notification(
      ${req.applicantId}::uuid,
      ${req.templateKey},
      ${template.version}::smallint,
      ${rendered.subject},
      ${rendered.html},
      ${rendered.text}
    )
  `

  const id = rows[0]?.fn_enqueue_notification
  if (!id) throw new Error('failed to enqueue notification')
  return id
}

/**
 * The dispatch adapter.
 *
 * `mock` is active while RESEND_API_KEY is unset. It marks messages `queued` rather than
 * `delivered`, because claiming delivery for a message that was never sent would make the ops
 * dashboard lie — and FR-NOT-003 puts bounces in front of a human precisely so that
 * undelivered results get chased.
 */
export interface NotificationProvider {
  readonly name: string
  send(message: {
    to: string
    subject: string
    html: string
    text: string
  }): Promise<{ providerId: string | null; delivered: boolean }>
}

export const MockProvider: NotificationProvider = {
  name: 'mock',
  async send(message) {
    console.log(`[MockProvider] Sending email to ${message.to}: ${message.subject}`)
    return { providerId: null, delivered: false }
  },
}

export const ResendProvider: NotificationProvider = {
  name: 'resend',
  async send(message) {
    const apiKey = process.env['RESEND_API_KEY']
    if (!apiKey) throw new Error('RESEND_API_KEY is not set')

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env['RESEND_FROM_EMAIL'] || 'onboarding@resend.dev',
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    })

    if (!res.ok) {
      throw new Error(`Resend API error: ${res.status} ${await res.text()}`)
    }

    const data = (await res.json()) as { id?: string }
    return { providerId: data.id ?? null, delivered: true }
  }
}

export function getProvider(): NotificationProvider {
  if (!process.env['RESEND_API_KEY']) return MockProvider
  return ResendProvider
}
