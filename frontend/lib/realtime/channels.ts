// Channels definition from spec §20.1
// "Real-time is a LAYER, not a foundation. It keeps the UI fresh; it is never the source of truth. Postgres is."

/**
 * 1. applicant:{token_hash}
 * Subscribers: that applicant only
 * Payload: own state, position, ETA, room
 * Filter: RLS, single row
 */
export function getApplicantChannel(tokenHash: string) {
  return `applicant:${tokenHash}`
}

/**
 * 2. cycle:{id}:queue
 * Subscribers: Coordinator, Admin
 * Payload: queue deltas
 * Filter: RLS, staff roles
 */
export function getQueueChannel(cycleId: string) {
  return `cycle:${cycleId}:queue`
}

/**
 * 3. cycle:{id}:panel:{pid}
 * Subscribers: that panel's members
 * Payload: current applicant, panel state
 * Filter: RLS, panel membership
 */
export function getPanelChannel(cycleId: string, panelId: string) {
  return `cycle:${cycleId}:panel:${panelId}`
}

/**
 * 4. cycle:{id}:display
 * Subscribers: public display board
 * Payload: called IDs and room, waiting count
 * Filter: NO NAMES, NO SCORES. Evaluated at publish time.
 */
export function getDisplayChannel(cycleId: string) {
  return `cycle:${cycleId}:display`
}

/**
 * 5. cycle:{id}:ops
 * Subscribers: Super Admin, Coordinator
 * Payload: flags, stuck interviews, sync failures, bounces
 * Filter: RLS, staff
 */
export function getOpsChannel(cycleId: string) {
  return `cycle:${cycleId}:ops`
}
