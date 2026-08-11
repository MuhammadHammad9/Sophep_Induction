import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'node:url'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

/**
 * Nightly Consistency Job (Phase 5C)
 * 
 * Verifies that the projected `applicants.state` matches the true state
 * derived from the event tables (check_ins, queue_entries, interviews, decisions).
 * 
 * If a discrepancy is found (which should be impossible per R-012, but this is the
 * Resilience phase), it corrects it and logs an ops alert.
 */
export async function runConsistencyCheck(cycleId: string) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)

  // This relies on an RPC function that would do the actual cross-checking in a transaction
  // to avoid race conditions. 
  // Let's call the rpc 'fn_check_consistency' (assuming we'd write this migration next).
  
  const { data, error } = await supabase.rpc('fn_check_consistency', { p_cycle_id: cycleId })
  
  if (error) {
    console.error('Consistency check failed:', error)
    return { success: false, error }
  }

  console.log('Consistency check completed:', data)
  return { success: true, anomaliesFixed: data }
}

if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
  const cycleId = process.argv[2]
  if (!cycleId) {
    console.error('Usage: ts-node consistency.ts <cycle_id>')
    process.exit(1)
  }
  runConsistencyCheck(cycleId).catch(console.error)
}
