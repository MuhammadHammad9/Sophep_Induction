// Channel scopes, from spec §20.1.
// "Real-time is a LAYER, not a foundation. It keeps the UI fresh; it is never the source of
//  truth. Postgres is."
//
// These are now SCOPE STRINGS for `/api/live` (an authenticated SSE endpoint), not Supabase
// Realtime topics. The audit (H-9) found the Realtime path could not work and lied about it:
// `postgres_changes` applies RLS using the subscriber's JWT, while every policy here
// authorises through `fn_current_user_id()`, which reads the transaction-local `app.user_id`
// bound by withContext. A websocket has no transaction, so every policy denied — and the UI
// rendered "Live" over a feed that was structurally empty (errata E11, R-026).
//
// Broadcast was not an alternative: its topics are joinable by anyone who knows the string,
// and these strings derive from the cycle id, which is printed in the public /display URL on
// the hall TV.
//
// SSE makes each subscription an ordinary authenticated request, so `requireStaff` and
// `withContext` apply and the SAME policies decide what a subscriber sees — one authorisation
// model instead of two that must agree forever.
//
// The display board keeps its own guarantee independently: `fn_display_board` excludes names
// and scores AT THE PUBLISHER (R-028), so that channel is incapable of carrying them whatever
// the transport.

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
