/**
 * Downloading and caching the offline roster bundle.
 *
 * This is the step the event-day checklist calls "roster synced", and it is the one that
 * decides whether the desk keeps working when the WiFi drops. Until it has run at least once
 * on a device, layer-2 verification has an empty set to compare against and every scan falls
 * through to the network — so a device that has never synced has no offline mode at all, while
 * looking exactly like one that has.
 *
 * That is why `getRosterSyncState` exists and why the scanner shows it. A volunteer must be
 * able to see the difference before the network goes away, not after.
 *
 * Refs: FR-CHK-012, FR-CHK-018, NFR-PERF-009
 */

import { cacheRoster, setOfflineCyclePublicKey, type RosterEntry } from './indexeddb'

interface RosterBundleResponse {
  cycleId: string
  stageId: string
  applicants: Array<{
    applicantId: string
    displayId: string
    fullName: string
    phoneLast4: string
    tokenHash: string
    preferences: string[]
  }>
  publicKey: string
  generatedAt: string
}

const SYNCED_AT_KEY = 'sophep.roster.syncedAt'
const SYNCED_COUNT_KEY = 'sophep.roster.count'

export interface RosterSyncState {
  syncedAt: Date | null
  count: number
}

export function getRosterSyncState(): RosterSyncState {
  if (typeof window === 'undefined') return { syncedAt: null, count: 0 }
  const at = window.localStorage.getItem(SYNCED_AT_KEY)
  return {
    syncedAt: at ? new Date(at) : null,
    count: Number(window.localStorage.getItem(SYNCED_COUNT_KEY) ?? 0),
  }
}

/**
 * Fetch and cache the bundle for a stage.
 *
 * Returns null when it could not be refreshed. A failure is deliberately NON-destructive: the
 * previously cached roster stays exactly as it was, because a stale roster from this morning is
 * enormously more useful at the desk than no roster at all.
 */
export async function syncRoster(stageId: string): Promise<RosterSyncState | null> {
  try {
    const res = await fetch(`/api/stages/${stageId}/roster`, { cache: 'no-store' })
    if (!res.ok) return null

    const bundle = (await res.json()) as RosterBundleResponse
    if (!Array.isArray(bundle.applicants) || !bundle.publicKey) return null

    const entries: RosterEntry[] = bundle.applicants.map((a) => ({
      applicantId: a.applicantId,
      displayId: a.displayId,
      fullName: a.fullName,
      phoneLast4: a.phoneLast4 ?? '',
      tokenHash: a.tokenHash,
      departmentPreferences: a.preferences ?? [],
      stageConfiguration: {},
    }))

    await cacheRoster(entries)
    // Public key only. There is no code path on any client that could store the private half,
    // because the server has no code path that would send it (E1, R-021).
    await setOfflineCyclePublicKey(bundle.publicKey)

    const syncedAt = new Date()
    const state: RosterSyncState = { syncedAt, count: entries.length }
    window.localStorage.setItem(SYNCED_AT_KEY, syncedAt.toISOString())
    window.localStorage.setItem(SYNCED_COUNT_KEY, String(state.count))
    return state
  } catch {
    return null
  }
}
