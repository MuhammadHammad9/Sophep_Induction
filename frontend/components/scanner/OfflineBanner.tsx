'use client'

/**
 * The connection banner — persistent, and honest about three different situations that a
 * single "offline" label would blur together:
 *
 *   OFFLINE          amber + diagonal stripes. Scans are being queued, not recorded.
 *   SYNCING          amber, no stripes. Back online, queue still draining. It clears only at
 *                    zero pending — never early, because the banner disappearing is the only
 *                    signal a volunteer has that their work actually landed.
 *   NEEDS ATTENTION  red. Operations the device could not resolve; a person must look at them.
 *
 * Colour is never the only signal: each state carries its own icon, its own wording, and
 * offline additionally carries a stripe pattern (R-060, NFR-A11Y-002).
 *
 * The roster warning is separate and deliberately alarming. A device that has never cached the
 * roster looks identical to one that has, right up to the moment the WiFi drops and every
 * single scan starts failing.
 *
 * Refs: FR-CHK-013, FR-CHK-017, NFR-A11Y-002, R-026, R-060
 */

export function OfflineBanner({
  isOffline,
  pendingCount,
  conflictCount = 0,
  rosterReady = true,
}: {
  isOffline: boolean
  pendingCount: number
  conflictCount?: number
  rosterReady?: boolean
}) {
  const needsAttention = conflictCount > 0

  return (
    <div className="relative z-50 w-full">
      {(isOffline || pendingCount > 0) && (
        <div
          className="relative flex w-full items-center gap-2 overflow-hidden bg-amber-500 px-4 py-2 font-bold text-black shadow-md"
          role="status"
          aria-live="polite"
        >
          {isOffline && (
            <div
              className="pointer-events-none absolute inset-0 opacity-20"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(45deg, transparent, transparent 10px, #000 10px, #000 20px)',
              }}
              aria-hidden="true"
            />
          )}

          <span className="relative flex items-center gap-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5 shrink-0"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              {isOffline ? (
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
                  clipRule="evenodd"
                />
              ) : (
                <path
                  fillRule="evenodd"
                  d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                  clipRule="evenodd"
                />
              )}
            </svg>

            {isOffline ? (
              <span>
                Offline — {pendingCount} queued, not yet recorded
              </span>
            ) : (
              // Explicitly "syncing", not "offline". Saying offline while the network is back
              // would be presenting a state we know to be stale (design principle 2).
              <span>Back online — syncing {pendingCount} queued</span>
            )}
          </span>
        </div>
      )}

      {needsAttention && (
        <div
          className="flex w-full items-center gap-2 bg-red-700 px-4 py-2 font-bold text-white shadow-md"
          role="alert"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 shrink-0"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
          <span>
            {conflictCount} check-in{conflictCount === 1 ? '' : 's'} could not sync — tell a
            Coordinator, they can enter these on the reconcile screen
          </span>
        </div>
      )}

      {!rosterReady && (
        <div
          className="flex w-full items-center gap-2 bg-red-700 px-4 py-2 font-bold text-white shadow-md"
          role="alert"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 shrink-0"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
          <span>No offline roster on this device — connect to WiFi before the event starts</span>
        </div>
      )}
    </div>
  )
}
