/**
 * Server-side database access for route handlers and server components.
 *
 * Route handlers are THIN (rules.md R-003): they authenticate, validate, delegate to
 * @sophep/backend, and shape the response. No business logic here.
 */

import { withContext, type SecurityContext, type Tx } from '@sophep/backend'

/**
 * Run a query with the caller's security context bound transaction-locally.
 *
 * Re-exported rather than reimplemented so there is exactly one place that binds RLS context.
 * A second implementation is how E9 comes back.
 */
export async function query<T>(ctx: SecurityContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withContext(ctx, fn)
}

/**
 * Build a security context from the incoming request.
 *
 * Phase 1 supports the public application form (no context at all) and an applicant token.
 * Staff sessions arrive in Phase 2 with Supabase Auth; until then staff endpoints are
 * explicitly unavailable rather than silently unguarded — an endpoint that accepts a
 * caller-supplied user id would be a hole, not a placeholder.
 */
export function contextFromRequest(req: Request, applicantId?: string): SecurityContext {
  const forwarded = req.headers.get('x-forwarded-for')
  const clientIp = forwarded?.split(',')[0]?.trim()

  return {
    ...(applicantId ? { applicantId } : {}),
    ...(clientIp ? { clientIp } : {}),
  }
}
