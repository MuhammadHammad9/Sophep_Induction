import { openDB, DBSchema, IDBPDatabase } from 'idb'

/**
 * IndexedDB Schema for SOPHEP Offline Resilience (Phase 5).
 * - pending_operations: Mutating requests (check-ins, etc.) that failed network sync.
 * - roster: Cached participant roster for offline lookup and validation.
 */
interface SophepOfflineDB extends DBSchema {
  pending_operations: {
    key: string
    value: {
      id: string // Client-generated UUID (Idempotency-Key)
      endpoint: string
      method: string
      payload: Record<string, unknown>
      clientTs: string // For deterministic replay ordering
      // `conflict` is deliberately NOT terminal-and-forgotten: the server refused this
      // operation's request id as reused, meaning the operation never landed. Dropping it here
      // would be exactly the silent discard FR-CHK-015 forbids, so it is kept for a human.
      status: 'pending' | 'syncing' | 'failed' | 'conflict'
      error?: string
    }
    indexes: {
      'by-ts': string
    }
  }
  roster: {
    key: string // applicantId
    value: {
      applicantId: string
      displayId: string
      fullName: string
      phoneLast4: string // FINAL FOUR digits only — never the number (FR-CHK-009, RSK-006)
      tokenHash: string // sha256(token)
      departmentPreferences: string[]
      stageConfiguration: Record<string, unknown>
    }
    indexes: {
      'by-hash': string // For token scan lookups
    }
  }
  /**
   * Device-scoped bundle metadata: the cycle PUBLIC key and the sync timestamp.
   *
   * Public key only. FR-CHK-018 is explicit that a device holds token hashes and the public
   * key and nothing else — no scores, no decisions, and no private key material. A device lost
   * at the venue must leak neither identity nor the ability to forge.
   */
  meta: {
    key: string
    value: string
  }
}

/**
 * One cached roster row.
 *
 * Exactly what FR-CHK-009's three offline search modes need, and nothing beyond it: no scores,
 * no decisions, no key material, and the final four phone digits rather than the number. See
 * migration `0050_roster_bundle_decision.sql`.
 */
export interface RosterEntry {
  applicantId: string
  displayId: string
  fullName: string
  /** FINAL FOUR digits of the phone number. Never the number itself (RSK-006). */
  phoneLast4: string
  tokenHash: string
  departmentPreferences: string[]
  stageConfiguration: Record<string, unknown>
}

let dbPromise: Promise<IDBPDatabase<SophepOfflineDB>> | null = null

function getDB() {
  if (typeof window === 'undefined') return null
  if (!dbPromise) {
    // Version 2 adds the `meta` store. Bumping the version is what triggers `upgrade`; adding
    // a store without it means every existing device silently lacks the store and every read
    // throws NotFoundError — on the day, offline.
    dbPromise = openDB<SophepOfflineDB>('sophep-offline', 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('pending_operations')) {
          const store = db.createObjectStore('pending_operations', { keyPath: 'id' })
          store.createIndex('by-ts', 'clientTs')
        }
        if (!db.objectStoreNames.contains('roster')) {
          const store = db.createObjectStore('roster', { keyPath: 'applicantId' })
          store.createIndex('by-hash', 'tokenHash')
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta')
        }
      },
    })
  }
  return dbPromise
}

export async function addPendingOperation(operation: {
  id: string
  endpoint: string
  method: string
  payload: Record<string, unknown>
  clientTs: string
}) {
  const db = await getDB()
  if (!db) return
  await db.add('pending_operations', {
    ...operation,
    status: 'pending',
  })
}

export async function getPendingOperations() {
  const db = await getDB()
  if (!db) return []
  return db.getAllFromIndex('pending_operations', 'by-ts')
}

export async function updateOperationStatus(
  id: string,
  status: 'pending' | 'syncing' | 'failed' | 'conflict',
  error?: string,
) {
  const db = await getDB()
  if (!db) return
  const op = await db.get('pending_operations', id)
  if (op) {
    op.status = status
    if (error) op.error = error
    await db.put('pending_operations', op)
  }
}

/**
 * Operations that need a human: the server refused them, or they failed repeatedly.
 *
 * These are what the bulk reconciliation screen exists to show (FR-CHK-017). An operation the
 * device cannot resolve on its own must be visible to somebody, or a person who was physically
 * checked in at the desk simply never appears in the system.
 */
export async function getUnresolvedOperations() {
  const db = await getDB()
  if (!db) return []
  const all = await db.getAllFromIndex('pending_operations', 'by-ts')
  return all.filter((op) => op.status === 'conflict' || op.status === 'failed')
}

export async function removePendingOperation(id: string) {
  const db = await getDB()
  if (!db) return
  await db.delete('pending_operations', id)
}

// --- Roster Management ---

/**
 * How long a cached roster may live on a device.
 *
 * The roster is the full name and identifier of EVERY applicant in the cycle, sitting in
 * IndexedDB on a volunteer's personal phone. FR-CHK-018 permits that — a desk cannot work
 * offline without it — but nothing expired it, wiped it at stage close, or cleared it on sign
 * out, so the whole cohort stayed on that phone permanently after the event (audit M-11).
 *
 * Sixteen hours covers the longest plausible event day with room either side, and expires
 * before the volunteer wakes up the next morning. It is deliberately not configurable from the
 * client: a device deciding its own retention is a device that never forgets.
 */
const ROSTER_TTL_MS = 16 * 60 * 60 * 1000

export async function cacheRoster(rosterData: RosterEntry[]) {
  const db = await getDB()
  if (!db) return
  const tx = db.transaction('roster', 'readwrite')
  // Clear old roster
  await tx.objectStore('roster').clear()
  for (const item of rosterData) {
    await tx.objectStore('roster').add(item)
  }
  await tx.done
  // Stamped AFTER the write commits, so a half-written roster is never treated as fresh.
  await setRosterCachedAt(Date.now())
}

async function setRosterCachedAt(ts: number): Promise<void> {
  const db = await getDB()
  if (!db) return
  await db.put('meta', String(ts), 'rosterCachedAt')
}

export async function getRosterCachedAt(): Promise<number | null> {
  const db = await getDB()
  if (!db) return null
  const value = await db.get('meta', 'rosterCachedAt')
  const ts = Number(value)
  return Number.isFinite(ts) && ts > 0 ? ts : null
}

/**
 * Age out a roster that has outlived the event it was cached for.
 *
 * Called before every read rather than on a timer: a timer does not run while the tab is
 * closed, and the case that matters is a phone put in a pocket on Saturday and picked up on
 * Tuesday.
 *
 * Returns true when it wiped something, so a caller can tell "no roster yet" from "the roster
 * expired" and say so — an empty roster presented as a working one would have a volunteer
 * telling real applicants they are not registered (design principle 2, R-026).
 */
export async function purgeExpiredRoster(now = Date.now()): Promise<boolean> {
  const cachedAt = await getRosterCachedAt()
  if (cachedAt === null) return false
  if (now - cachedAt < ROSTER_TTL_MS) return false

  await clearRoster()
  return true
}

/**
 * Remove every trace of the cohort from this device.
 *
 * Sign-out and stage-close both call this. Pending operations are deliberately NOT touched —
 * an unsynced check-in is somebody who stood at the desk, and discarding it to tidy up storage
 * is precisely the silent discard FR-CHK-015 prohibits.
 */
export async function clearRoster(): Promise<void> {
  const db = await getDB()
  if (!db) return
  const tx = db.transaction('roster', 'readwrite')
  await tx.objectStore('roster').clear()
  await tx.done
  await db.delete('meta', 'rosterCachedAt')
  await db.delete('meta', 'cyclePublicKey')
}

export async function getOfflineApplicantByHash(hash: string) {
  const db = await getDB()
  if (!db) return null
  await purgeExpiredRoster()
  return db.getFromIndex('roster', 'by-hash', hash)
}

/**
 * Offline manual search — all THREE modes FR-CHK-009 mandates.
 *
 * The phone mode was missing entirely: the bundle carried no phone digits, so a search by
 * number returned nothing, which at the desk is indistinguishable from "not registered". It is
 * the last route available for an applicant whose QR code is damaged and whose name the
 * volunteer cannot spell, and it only failed offline.
 *
 * Kept deliberately parallel to the ONLINE predicates in `services/registration.ts`: identifier
 * substring, name substring, and — at four or more digits — the identifier's digits or the
 * phone's final four. Two search paths that disagree about which digits count is a bug nobody
 * finds until somebody is standing at the desk.
 */
export async function searchOfflineRoster(query: string) {
  const db = await getDB()
  if (!db) return []
  await purgeExpiredRoster()
  const all = await db.getAll('roster')

  const q = query.trim().toLowerCase()
  if (!q) return []
  const digits = q.replace(/\D/g, '')

  return all.filter(
    (a) =>
      a.fullName.toLowerCase().includes(q) ||
      a.displayId.toLowerCase().includes(q) ||
      // Four is the floor the requirement sets. Below it a single digit would match most of the
      // cohort, which is not a search result — it is a list.
      (digits.length >= 4 &&
        (a.displayId.replace(/\D/g, '').includes(digits) || a.phoneLast4.endsWith(digits))),
  )
}

/**
 * The cycle's Ed25519 PUBLIC key, base64url, as shipped in the roster bundle.
 *
 * Public by definition — it permits verification and not signing, which is the whole reason
 * the scheme is Ed25519 rather than HMAC (E1, FR-CHK-018). No private key material is ever
 * stored on a device.
 */
export async function getOfflineCyclePublicKey(): Promise<string | null> {
  const db = await getDB()
  if (!db) return null
  const value = await db.get('meta', 'cyclePublicKey')
  return typeof value === 'string' ? value : null
}

export async function setOfflineCyclePublicKey(base64Url: string): Promise<void> {
  const db = await getDB()
  if (!db) return
  await db.put('meta', base64Url, 'cyclePublicKey')
}

/**
 * Every cached token hash, as a Set for O(1) membership.
 *
 * Layer 2 of verification is a set-membership test and nothing more — that is the whole reason
 * offline check-in needs no secret on the device (E1).
 */
export async function getOfflineRosterHashes(): Promise<ReadonlySet<string>> {
  const db = await getDB()
  if (!db) return new Set()
  await purgeExpiredRoster()
  const all = await db.getAll('roster')
  return new Set(all.map((entry) => entry.tokenHash))
}
