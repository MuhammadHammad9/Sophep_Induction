-- 0029 — Compute the allocation checksum without depending on pgcrypto's search path
--
-- Found by tests/golden/allocation.test.ts: "function digest(text, unknown) does not exist".
--
-- fn_run_allocation is declared `SET search_path = public`, which is deliberate — a
-- SECURITY DEFINER function with a mutable search path is a privilege-escalation vector, since
-- a caller could shadow any unqualified name it resolves. But Supabase installs pgcrypto into
-- the `extensions` schema rather than `public`, so `digest()` is simply not visible.
--
-- The tempting fixes are both bad:
--   * adding `extensions` to the search path re-opens the resolution surface the pinned path
--     exists to close
--   * schema-qualifying `extensions.digest` hard-codes a Supabase-specific layout into a
--     function that also has to run against the plain postgres:16 image CI uses
--
-- `sha256(bytea)` has been a Postgres BUILT-IN since 11 and needs no extension at all, so the
-- dependency disappears rather than being worked around.
--
-- Refs: FR-DEC-007, NFR-SEC-009

BEGIN;

CREATE OR REPLACE FUNCTION fn_allocation_checksum(p_allocation_run_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- Ordered by applicant_id so the digest is independent of the order rows happened to be
  -- inserted — otherwise "byte-identical" would be testing insertion order, not the matching.
  SELECT encode(
           sha256(
             convert_to(
               coalesce(string_agg(
                 d.applicant_id::text || ':' || d.outcome::text || ':' ||
                 coalesce(d.department_id::text, '-') || ':' ||
                 coalesce(d.waitlist_rank::text, '-'),
                 '|' ORDER BY d.applicant_id
               ), ''),
               'UTF8'
             )
           ),
           'hex'
         )
    FROM decisions d
   WHERE d.allocation_run_id = p_allocation_run_id
$$;

GRANT EXECUTE ON FUNCTION fn_allocation_checksum(uuid) TO rms_app;

COMMENT ON FUNCTION fn_allocation_checksum IS
  'sha256 over the ordered decision set. Uses the Postgres built-in rather than pgcrypto, which Supabase installs outside the pinned search_path. FR-DEC-007';


-- Point fn_run_allocation at the helper. Replacing only the checksum step keeps the matching
-- logic untouched, so this migration cannot change any allocation OUTCOME - only how the
-- result is digested.
CREATE OR REPLACE FUNCTION fn_set_allocation_checksum(p_run_id uuid)
RETURNS allocation_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run allocation_runs;
BEGIN
  UPDATE allocation_runs
     SET result_checksum = fn_allocation_checksum(p_run_id),
         selected_count   = (SELECT count(*) FROM decisions
                              WHERE allocation_run_id = p_run_id AND outcome = 'selected'),
         waitlisted_count = (SELECT count(*) FROM decisions
                              WHERE allocation_run_id = p_run_id AND outcome = 'waitlisted'),
         rejected_count   = (SELECT count(*) FROM decisions
                              WHERE allocation_run_id = p_run_id
                                AND outcome IN ('rejected', 'excluded'))
   WHERE id = p_run_id
   RETURNING * INTO v_run;

  RETURN v_run;
END $$;

GRANT EXECUTE ON FUNCTION fn_set_allocation_checksum(uuid) TO rms_app;

COMMIT;
