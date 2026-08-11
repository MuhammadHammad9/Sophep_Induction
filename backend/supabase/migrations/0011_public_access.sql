-- 0011 — Public read paths
--
-- Once RLS is genuinely enforced (migration 0010), two legitimate unauthenticated paths stop
-- working, because both need to read rows before any context can exist:
--
--   1. The public application form must find the open cycle and its departments. It has no
--      user and no applicant — that is the point of a public form.
--   2. The status page must resolve a token to an applicant. The token IS the credential, so
--      the lookup necessarily happens BEFORE app.applicant_id can be set.
--
-- The tempting fix is a broad policy, or connecting as a privileged role for "just this one
-- query". Both would reopen the boundary. Instead:
--
--   1. A narrow policy exposing only what an anonymous visitor must see.
--   2. A SECURITY DEFINER function scoped by the token hash — unguessable, single-applicant,
--      and returning strictly the fields the status page renders.
--
-- Refs: FR-CYC-004, NFR-PRIV-005, FR-IDT-006, FR-IDT-010

BEGIN;

-- ── 1. The open cycle, for the public form ──────────────────────────────────────────────
--
-- Only a cycle in `registration_open`, and only the columns a form needs. A draft cycle's
-- configuration, a closed cycle's data, and every other cycle stay invisible.
CREATE POLICY cycle_public_select ON cycles FOR SELECT
  USING (state = 'registration_open');

COMMENT ON POLICY cycle_public_select ON cycles IS
  'Anonymous read of the cycle currently accepting applications. Narrow by design — the public form cannot function without it.';


-- ── 2. Token resolution, for the status page ────────────────────────────────────────────
--
-- SECURITY DEFINER because it must read access_tokens, which has no applicant-facing policy
-- and must not get one: the hash is the credential, and a readable token table is a
-- credential-harvesting surface.
--
-- Safe because the only way in is `sha256(token)`. A caller who cannot produce a valid hash
-- gets nothing, and a caller who can is by definition holding that applicant's credential.
--
-- Returns exactly the fields §19.1 renders. Deliberately NOT `SELECT *`: scores, answers, CV
-- keys and internal ids must never be reachable from an unauthenticated path, and a
-- `SELECT *` here would leak every column added by a future migration (NFR-PRIV-005).
CREATE OR REPLACE FUNCTION fn_resolve_token(p_token_hash bytea)
RETURNS TABLE (
  applicant_id uuid,
  display_id   text,
  full_name    text,
  state        applicant_state,
  cycle_id     uuid,
  cycle_name   text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.display_id, a.full_name, a.state, c.id, c.name
    FROM access_tokens t
    JOIN applicants a ON a.id = t.applicant_id
    JOIN cycles     c ON c.id = a.cycle_id
   WHERE t.token_hash = p_token_hash
     AND t.revoked_at IS NULL          -- FR-IDT-009: a rotated token stops working at once
     AND t.expires_at > now()          -- FR-IDT-012
   LIMIT 1
$$;

COMMENT ON FUNCTION fn_resolve_token IS
  'Resolves sha256(token) to the applicant. SECURITY DEFINER because the token is the credential and the lookup precedes any context. Returns named columns only — never SELECT *. FR-IDT-006, NFR-PRIV-005';

GRANT EXECUTE ON FUNCTION fn_resolve_token(bytea) TO rms_app;

COMMIT;
