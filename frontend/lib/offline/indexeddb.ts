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
      payload: any
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
      stageConfiguration: any
    }
    indexes: {
      'by-hash': string // For token scan lookups
    }
  }
}

let dbPromise: Promise<IDBPDatabase<SophepOfflineDB>> | null = null

function getDB() {
  if (typeof window === 'undefined') return null
  if (!dbPromise) {
    dbPromise = openDB<SophepOfflineDB>('sophep-offline', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('pending_operations')) {
          const store = db.createObjectStore('pending_operations', { keyPath: 'id' })
          store.createIndex('by-ts', 'clientTs')
        }
        if (!db.objectStoreNames.contains('roster')) {
          const store = db.createObjectStore('roster', { keyPath: 'applicantId' })
          store.createIndex('by-hash', 'tokenHash')
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
  payload: any
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

export async function cacheRoster(rosterData: any[]) {
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
