/**
 * Mock email preview.
 *
 * No Resend account or verified sending domain exists yet, so nothing is actually delivered.
 * Rather than silently dropping messages — which would make Phase 1 untestable and hide
 * template bugs until the day results go out — every queued message renders here.
 *
 * This also satisfies FR-NOT-004 early: templates must be previewable.
 *
 * Development only. Refuses to render in production, because it displays applicant email
 * addresses and would be an unauthenticated PII leak (NFR-PRIV-005).
 */

import { notFound } from 'next/navigation'
import { withContext, getProvider } from '@sophep/backend'

export const dynamic = 'force-dynamic'

interface QueuedMessage {
  id: string
  to_email: string
  subject: string
  body_text: string
  state: string
  template_key: string
  created_at: Date
}

export default async function NotificationsPreview() {
  if (process.env.NODE_ENV === 'production') notFound()

  const messages = await withContext({}, async (tx) => {
    return tx<QueuedMessage[]>`
      SELECT id, to_email, subject, body_text, state, template_key, created_at
        FROM notifications
       ORDER BY created_at DESC
       LIMIT 50
    `
  })

  const adapter = getProvider()

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-h1">Outbound messages</h1>

      <div className="mt-2 rounded-card border border-state-called/30 bg-state-called-fill p-4 text-small text-state-called">
        <strong>Adapter: {adapter.name}.</strong>{' '}
        {adapter.name === 'mock'
          ? 'Nothing is being delivered. Messages stop at "queued" — they are not marked delivered, because claiming delivery for a message that was never sent would make the ops dashboard lie.'
          : 'Live provider active.'}
      </div>

      {messages.length === 0 ? (
        <p className="mt-6 text-text-muted">
          No messages yet. Submit an application to generate one.
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {messages.map((m) => (
            <li key={m.id} className="rounded-card border border-border bg-surface p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-semibold">{m.subject}</h2>
                <span className="id-text text-caption uppercase text-text-muted">{m.state}</span>
              </div>
              <p className="mt-1 text-small text-text-muted">
                To {m.to_email} · {m.template_key}
              </p>
              <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-control bg-background p-3 text-small">
                {m.body_text}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
