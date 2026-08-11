/**
 * Database access and security-context binding.
 *
 * This file is where errata E9 is actually fixed, so it deserves reading carefully.
 *
 * v1's RLS policies read `current_setting('app.applicant_id', true)` and never specified how
 * that value gets written. Under a transaction-mode connection pooler — Supabase's default —
 * a session-level `SET` either leaks into an unrelated request that inherits the connection,
 * or vanishes before the query runs. The first outcome is a security breach; the second is an
 * outage. Both are silent.
 *
 * The fix is `set_config(key, value, true)`. The third argument is `is_local`: the setting
 * lives and dies with the transaction, so a pooled connection handed to the next request
 * carries nothing at all. Because every context accessor returns NULL when unset and every
 * policy comparison against NULL denies, the boundary FAILS CLOSED (rules.md R-014).
 *
 * The practical consequence for callers: a query that needs RLS context MUST run inside
 * `withContext`. There is deliberately no way to set context outside a transaction.
 *
 * Refs: FR-RBAC-005, FR-RBAC-006, E9
 */

import postgres from 'postgres'

export type Sql = postgres.Sql<Record<string, never>>
export type Tx = postgres.TransactionSql<Record<string, never>>

let client: Sql | undefined

export function getDb(connectionString?: string): Sql {
  if (client) return client

  const url = connectionString ?? process.env['DATABASE_URL']
  if (!url) {
    throw new Error('DATABASE_URL is not set — see .env.example')
  }

  client = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connection: {
      // A runaway query must never hold a connection through the whole event. This is a
      // Postgres runtime parameter, so it belongs in `connection`, not at the top level.
      statement_timeout: 15_000,
    },
    // Raw tokens and CV contents must never reach a log (NFR-MAIN-006, R-022).
    debug: false,
    transform: { undefined: null },
  })

  return client
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end()
    client = undefined
  }
}

/**
 * Who is making this request.
 *
 * Exactly one of `userId` (staff) or `applicantId` (token-scoped) should be set. An applicant
 * session is scoped to exactly one applicant record (FR-RBAC-007); staff scope comes from
 * their memberships in the cycle.
 *
 * A context with neither is legitimate — it represents the public application form — and it
 * yields almost nothing, which is correct.
 */
export interface SecurityContext {
  userId?: string
  applicantId?: string
  /** Which of a multi-role user's roles they are acting as. Recorded on audit rows. */
  actorRole?: string
  actorLabel?: string
  clientIp?: string
}

/**
 * Run `fn` inside a transaction with the security context bound transaction-locally.
 *
 * Every setting uses `is_local = true`. Nothing here is session-scoped, by design.
 */
export async function withContext<T>(
  ctx: SecurityContext,
  fn: (tx: Tx) => Promise<T>,
  sql: Sql = getDb(),
): Promise<T> {
  return sql.begin(async (tx) => {
    // Drop to the non-privileged application role for the duration of this transaction.
    //
    // Without this, a pool that authenticated as a superuser or any BYPASSRLS role would skip
    // every policy in migration 0008 — silently, with queries succeeding and data flowing.
    // `SET LOCAL` reverts at COMMIT, so the connection returns to the pool unchanged.
    await tx`SET LOCAL ROLE rms_app`

    await tx`SELECT set_config('app.user_id',      ${ctx.userId ?? ''},      true)`
    await tx`SELECT set_config('app.applicant_id', ${ctx.applicantId ?? ''}, true)`
    await tx`SELECT set_config('app.actor_role',   ${ctx.actorRole ?? ''},   true)`
    await tx`SELECT set_config('app.actor_label',  ${ctx.actorLabel ?? ''},  true)`
    await tx`SELECT set_config('app.client_ip',    ${ctx.clientIp ?? ''},    true)`

    return fn(tx as Tx)
  }) as Promise<T>
}

/**
 * Run as the application role with NO security context bound.
 *
 * Used by the RLS test suite to prove the fail-closed property. It still assumes `rms_app`,
 * because the assertion being made is "an unauthenticated APPLICATION query sees nothing" —
 * running it as a superuser would prove nothing at all.
 *
 * Named unmistakably so its appearance in application code is obvious in review.
 */
export async function withoutContext<T>(fn: (tx: Tx) => Promise<T>, sql: Sql = getDb()): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE rms_app`
    return fn(tx as Tx)
  }) as Promise<T>
}

/**
 * Run with full privileges, bypassing RLS.
 *
 * For migrations, seeds and scheduled maintenance only. Never reachable from a request path.
 * If you find yourself reaching for this to make a feature work, the policy is wrong — fix
 * the policy (rules.md R-014, FR-RBAC-004).
 */
export async function asPrivileged<T>(fn: (tx: Tx) => Promise<T>, sql: Sql = getDb()): Promise<T> {
  return sql.begin(async (tx) => fn(tx as Tx)) as Promise<T>
}

const idempotencyCache = new Map<string, any>()

export async function withIdempotency<T>(
  key: string | null | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!key) return fn()
  if (idempotencyCache.has(key)) {
    return idempotencyCache.get(key) as T
  }
  const result = await fn()
  // Ensure the map doesn't grow indefinitely in serverless environment
  if (idempotencyCache.size > 10_000) {
    const firstKey = idempotencyCache.keys().next().value
    if (firstKey) idempotencyCache.delete(firstKey)
  }
  idempotencyCache.set(key, result)
  return result
}
