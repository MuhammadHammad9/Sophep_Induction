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
      status: 'pending' | 'syncing' | 'failed'
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
 * One cached roster row. FR-CHK-018: hashes and identity for matching a scan, and nothing
 * else — no scores, no decisions, no key material.
 */
export interface RosterEntry {
  applicantId: string
  displayId: string
  fullName: string
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

export async function updateOperationStatus(id: string, status: 'pending' | 'syncing' | 'failed', error?: string) {
  const db = await getDB()
  if (!db) return
  const op = await db.get('pending_operations', id)
  if (op) {
    op.status = status
    if (error) op.error = error
    await db.put('pending_operations', op)
  }
}

export async function removePendingOperation(id: string) {
  const db = await getDB()
  if (!db) return
  await db.delete('pending_operations', id)
}

// --- Roster Management ---

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
}

export async function getOfflineApplicantByHash(hash: string) {
  const db = await getDB()
  if (!db) return null
  return db.getFromIndex('roster', 'by-hash', hash)
}

export async function searchOfflineRoster(query: string) {
  const db = await getDB()
  if (!db) return []
  const all = await db.getAll('roster')
  const q = query.toLowerCase()
  return all.filter((a) => {
    return (
      a.fullName.toLowerCase().includes(q) ||
      a.displayId.toLowerCase().includes(q)
    )
  })
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
  const all = await db.getAll('roster')
  return new Set(all.map((entry) => entry.tokenHash))
}
