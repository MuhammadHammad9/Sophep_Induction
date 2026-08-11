import Link from 'next/link'

/**
 * Entry point. Deliberately plain — this is an internal operations tool, not a marketing site.
 *
 * The design system's source skill proposed an "Enterprise Gateway" pattern here (hero video,
 * client logos, "Contact Sales"). That was discarded: nobody signs up for an internal queue
 * console, and it would be the wrong artifact entirely (spec §18.1).
 */
export default function Home() {
  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="text-h1">SOPHEP Induction</h1>
      <p className="mt-2 text-text-muted">Recruitment management system</p>

      <nav className="mt-8 space-y-3">
        <Link
          href="/apply"
          className="block touch-target rounded-card border border-border bg-surface p-4 hover:border-border-strong"
        >
          <span className="font-semibold">Apply</span>
          <span className="block text-small text-text-muted">
            Submit an application to the open cycle
          </span>
        </Link>

        {process.env.NODE_ENV !== 'production' ? (
          <Link
            href="/dev/notifications"
            className="block touch-target rounded-card border border-border bg-surface p-4 hover:border-border-strong"
          >
            <span className="font-semibold">Outbound messages</span>
            <span className="block text-small text-text-muted">
              Mock email preview — development only
            </span>
          </Link>
        ) : null}
      </nav>

      <p className="mt-8 text-caption text-text-muted">
        Check-in, queue and panel screens arrive in Phase 2.
      </p>
    </div>
  )
}
