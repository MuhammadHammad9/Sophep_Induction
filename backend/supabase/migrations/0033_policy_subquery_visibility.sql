-- 0033 — A policy must not depend on the caller's visibility of another table
--
-- Found by tests/golden/lock-and-offers.test.ts: after publishing, an applicant still could
-- not see their own decision.
--
-- THE CAUSE, and it is the SECOND time this exact shape has bitten (see migration 0021):
--
--     CREATE POLICY decision_self_select ON decisions FOR SELECT
--       USING (applicant_id = fn_current_applicant_id()
--              AND EXISTS (SELECT 1 FROM cycles c
--                           WHERE c.id = decisions.cycle_id AND c.state = 'published'));
--
-- That inner SELECT is itself subject to the RLS on `cycles`. An applicant can only see cycles
-- through cycle_public_select, which matches `state = 'registration_open'` — so a PUBLISHED
-- cycle is invisible to them, the EXISTS is false, and the outer policy denies.
--
-- The failure is silent in the worst way: the policy is not wrong about who may read, it is
-- wrong about what it can see while deciding. Nothing errors, and the applicant is simply told
-- nothing on the day their result is published.
--
-- THE RULE this establishes: a policy predicate that queries another RLS-protected table must
-- go through a SECURITY DEFINER function. Otherwise the predicate silently inherits that
-- table's policies and evaluates against a different view of the world than the author meant.
--
-- Refs: FR-RBAC-005, FR-DEC-015, NFR-PRIV-005

BEGIN;

-- Deliberately minimal: answers one boolean about one cycle and exposes nothing else, so
-- making it SECURITY DEFINER widens the boundary by exactly one bit of already-public
-- information (whether results are out).
CREATE OR REPLACE FUNCTION fn_cycle_is_published(p_cycle_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM cycles WHERE id = p_cycle_id AND state = 'published')
$$;

GRANT EXECUTE ON FUNCTION fn_cycle_is_published(uuid) TO rms_app;

COMMENT ON FUNCTION fn_cycle_is_published IS
  'Used inside RLS predicates. A policy that queries cycles directly inherits cycles'' own RLS and evaluates against the caller''s view rather than the truth — see migration 0031.';

DROP POLICY IF EXISTS decision_self_select ON decisions;

CREATE POLICY decision_self_select ON decisions FOR SELECT
  USING (
    applicant_id = fn_current_applicant_id()
    AND fn_cycle_is_published(cycle_id)
  );

COMMIT;
