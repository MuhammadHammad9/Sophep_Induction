import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'node:url'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

/**
 * Anonymisation Job (Phase 5C)
 * 
 * Enforces the data retention policy. Data from cycles older than 2 years
 * must have PII stripped (names, emails, phone numbers, CVs removed).
 * The structural data (scores, wait times, outcomes) remains for historical capacity modeling.
 */
export async function runAnonymisation() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)

  const { data: oldCycles, error: cyclesError } = await supabase
    .from('cycles')
    .select('id')
    .eq('state', 'archived')
    // Additional logic: created_at < now() - 2 years
    // This requires a DB-level function for secure execution.
    
  if (cyclesError) {
    console.error('Failed to fetch old cycles', cyclesError)
    return
  }

  // We rely on an RPC to do the actual anonymization in-database to ensure audit logs
  // are properly written and the operation is atomic.
  const { data, error } = await supabase.rpc('fn_anonymise_old_data')

  if (error) {
    console.error('Anonymisation failed:', error)
    return { success: false, error }
  }

  console.log('Anonymisation completed successfully:', data)
  return { success: true, rowsAffected: data }
}

if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
  runAnonymisation().catch(console.error)
}
