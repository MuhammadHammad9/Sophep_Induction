-- 0037 — RLS on the five uncovered tables, FORCE everywhere, and the staff session bootstrap
--
-- Three related problems, fixed together because fixing the first two exposes the third.
--
--
-- PROBLEM 1 — five tables never had RLS enabled at all.
--
--   users · societies · role_capabilities · application_transitions · idempotency_keys
--
-- Every other table in the schema has it. `users` is the one that matters: it holds
-- `totp_secret_enc`, `email`, and `auth_user_id` for every staff member, and until migration
-- 0036 it was reachable over PostgREST with the anon key —
--
--     GET /rest/v1/users?select=*
--
-- — returning the complete staff directory. The encryption on the TOTP secret is
-- application-layer (NFR-SEC-002), so the ciphertext alone is not immediately usable; the email
-- list is a targeted-phishing kit aimed precisely at the accounts holding `results.lock`.
--
-- `idempotency_keys` is the subtler one. `fn_complete_idempotent` stores whole response bodies,
-- and a response body is whatever the endpoint returned — for a registration that has, at
-- times, included a status URL whose last path segment IS a raw access token (R-022). A table
-- that stores arbitrary prior responses must be readable by nobody at all.
--
--
-- PROBLEM 2 — nothing was ever FORCEd.
--
-- Migration 0010's header states: "Migration 0008 enables and FORCEs row-level security."
-- It does not. `FORCE ROW LEVEL SECURITY` appears nowhere in 0001–0035; only ENABLE does.
--
-- A table's OWNER is exempt from its own policies unless FORCEd. The application path is safe
-- regardless, because withContext does `SET LOCAL ROLE rms_app` and rms_app is NOBYPASSRLS —
-- that part of the design is sound and does the real work. But the comment asserts a property
-- the schema lacks, and a reviewer who trusts it will conclude a policy gap is covered when it
-- is not. The cheapest fix is to make the assertion true.
--
--
-- PROBLEM 3 — staff authentication is a bootstrap deadlock, and always has been.
--
-- `requireStaff()` (frontend/lib/auth/session.ts) resolves the caller like this:
--
--     withContext({}, tx => tx`SELECT ... FROM users u JOIN memberships m ...`)
--
-- An EMPTY context. Both policies on `memberships` compare against `fn_current_user_id()`,
-- which returns NULL when unset, and every comparison against NULL denies. So the query returns
-- zero rows, `requireStaff` returns null, and **every staff endpoint answers 401 — for
-- everyone, always.**
--
-- This is not a bug in the policies. They are correct and fail closed exactly as R-014 demands.
-- It is a genuine chicken-and-egg: the security context is derived from the caller's
-- memberships, and the memberships cannot be read without a security context.
--
-- Migration 0011 already solved this shape of problem for applicants. The status page must
-- resolve a token before any context can exist, so the lookup goes through a narrow
-- SECURITY DEFINER function keyed on the credential itself — `fn_resolve_token(sha256(token))`.
-- Nothing else is exposed and the caller must already hold the credential to get anything.
--
-- The staff equivalent is below, keyed on the Supabase `auth.users.id`, which the caller proved
-- by presenting a signed JWT that `supabase.auth.getUser()` verified against the auth server
-- BEFORE this is ever called. It is the same trust argument: the key is the credential.
--
-- Note what the function does NOT accept: an email address. The current implementation matches
-- `u.auth_user_id = $1 OR u.email = $2`, and that second branch is an account-takeover path if
-- the project ever permits unverified addresses or a provider that returns one — sign up as
-- coordinator@…, inherit their capabilities. Identity here is the verified auth uid and nothing
-- else (audit M-5).
--
-- Refs: FR-RBAC-002, FR-RBAC-004, FR-RBAC-005, FR-RBAC-006, NFR-SEC-002, E9, E13,
--       rules.md R-014, R-032, audit C-3, H-7, M-5

BEGIN;

-- ── 1. Enable RLS on the five uncovered tables ──────────────────────────────────────────

ALTER TABLE users                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE societies                ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_capabilities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_transitions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys         ENABLE ROW LEVEL SECURITY;

-- users — yourself, or someone who administers a cycle you belong to.
--
-- Deliberately NOT "any staff member may list all staff". A volunteer has no reason to
-- enumerate the coordinator list, and the directory is exactly what makes a phishing run
-- targeted rather than speculative (NFR-PRIV-005).
CREATE POLICY user_self_select ON users FOR SELECT
  USING (id = fn_current_user_id());

CREATE POLICY user_admin_select ON users FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.user_id = users.id
       AND m.revoked_at IS NULL
       AND fn_has_capability(m.cycle_id, 'users.manage')
  ));

CREATE POLICY user_self_update ON users FOR UPDATE
  USING (id = fn_current_user_id())
  WITH CHECK (id = fn_current_user_id());

-- societies — three columns of reference data (code, name). Readable by any BOUND context,
-- staff or applicant; still zero rows when unbound, which is the property that matters.
CREATE POLICY society_bound_select ON societies FOR SELECT
  USING (fn_current_user_id() IS NOT NULL OR fn_current_applicant_id() IS NOT NULL);

-- role_capabilities / application_transitions — the capability matrix and the legal state
-- graph. Readable by any bound context so the UI can explain what a role may do (R-058).
--
-- These are the two tables 0010 revoked INSERT and UPDATE on: they change through migrations,
-- which is what keeps the capability matrix reviewable in source control rather than editable
-- at runtime. RLS here adds "and unbound callers see nothing", completing that.
--
-- fn_has_capability reads role_capabilities and is SECURITY DEFINER, so authorisation itself is
-- unaffected by this policy — it must be, or enabling RLS here would deadlock every check.
CREATE POLICY role_capability_bound_select ON role_capabilities FOR SELECT
  USING (fn_current_user_id() IS NOT NULL OR fn_current_applicant_id() IS NOT NULL);

CREATE POLICY transition_bound_select ON application_transitions FOR SELECT
  USING (fn_current_user_id() IS NOT NULL OR fn_current_applicant_id() IS NOT NULL);

-- idempotency_keys — NO POLICY, deliberately.
--
-- RLS enabled with zero permissive policies means zero rows for every role, forever. The only
-- access is through fn_claim_idempotency / fn_complete_idempotent / fn_release_idempotency,
-- which are SECURITY DEFINER and therefore unaffected.
--
-- This is the correct shape for a table holding stored response bodies: there is no legitimate
-- reader, so there is no policy, and a future endpoint that tries to SELECT from it fails
-- loudly rather than leaking whatever a past response happened to contain.
REVOKE SELECT ON idempotency_keys FROM rms_app;

COMMENT ON TABLE idempotency_keys IS
  'RLS enabled with NO policy: unreadable by every role by design. Access only via the '
  'SECURITY DEFINER claim/complete/release functions. Stores prior response bodies, which may '
  'contain material no caller should be able to re-read (R-022, audit H-8).';


-- ── 2. Column-level protection for the TOTP secret ──────────────────────────────────────
--
-- Preferred over moving the column to a separate table: a column move is a destructive
-- migration on live data, and this achieves the same property — the application role cannot
-- read the secret even through a policy that permits the row.
--
-- MFA verification, when it is wired, must therefore go through a SECURITY DEFINER function
-- that compares inside the database and returns a boolean. The secret never crosses into
-- application memory, which is a stronger guarantee than the original design had.
-- ⚠ A COLUMN-LEVEL REVOKE DOES NOT WORK ON TOP OF A TABLE-LEVEL GRANT.
--
-- The obvious spelling — `REVOKE SELECT (totp_secret_enc) ON users FROM rms_app` — is a silent
-- no-op here, and an execution run against a real Postgres is the only reason we know. Column
-- privileges in Postgres are ADDITIVE: a table-level SELECT already covers every column, and
-- revoking one column does not carve a hole in it. Migration 0036 grants
-- `SELECT ON ALL TABLES TO rms_app`, so the revoke removed a privilege the role was not
-- relying on and the secret stayed readable.
--
-- The working form is to drop the table-level grant and re-grant column by column. That makes
-- the column list load-bearing: a column added to `users` later is NOT readable by the
-- application until it is added here, which is the correct default for a table holding
-- authentication material.
REVOKE SELECT ON users FROM rms_app;
REVOKE SELECT ON users FROM PUBLIC;

GRANT SELECT (
  id,
  email,
  full_name,
  auth_user_id,
  totp_enabled,           -- whether MFA is on is not secret; the secret itself is
  totp_last_used_step,    -- a replay watermark, useless without the secret
  totp_enrolled_at,
  disabled_at,
  created_at
) ON users TO rms_app;

COMMENT ON COLUMN users.totp_secret_enc IS
  'AES-256-GCM, application layer (NFR-SEC-002). Column-level SELECT revoked from rms_app: '
  'reachable only inside SECURITY DEFINER verification. Never load this into application '
  'memory (audit C-3).';


-- ── 3. FORCE row-level security on every table ──────────────────────────────────────────
--
-- Guarded. FORCE makes the OWNER subject to policies, and if the owner holds neither SUPERUSER
-- nor BYPASSRLS this would lock every SECURITY DEFINER function out of its own tables — seeds,
-- migrations and the whole event, all at once. Better to skip loudly than to brick the schema.
DO $$
DECLARE
  v_owner_exempt boolean;
  v_table text;
  v_count int := 0;
BEGIN
  SELECT rolsuper OR rolbypassrls INTO v_owner_exempt
    FROM pg_roles WHERE rolname = current_user;

  IF NOT coalesce(v_owner_exempt, false) THEN
    RAISE WARNING
      'Skipping FORCE ROW LEVEL SECURITY: current_user % holds neither SUPERUSER nor '
      'BYPASSRLS, so FORCE would lock SECURITY DEFINER functions out of their own tables. '
      'Grant BYPASSRLS to the owner and re-run this block.', current_user;
    RETURN;
  END IF;

  FOR v_table IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relrowsecurity            -- only tables that already ENABLEd it
       AND NOT c.relforcerowsecurity
       AND c.relname <> 'schema_migrations'
  LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table);
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'FORCE ROW LEVEL SECURITY applied to % table(s)', v_count;
END $$;


-- ── 4. The staff session bootstrap ──────────────────────────────────────────────────────

/**
 * Resolve a VERIFIED Supabase auth user to their cycle-scoped memberships and capabilities.
 *
 * SECURITY DEFINER for the same reason fn_resolve_token is (migration 0011): this runs BEFORE
 * any security context exists, because its whole purpose is to produce the values that context
 * is built from. Reading `memberships` under RLS here is impossible by construction.
 *
 * Safe because the argument is not a guess. `supabase.auth.getUser()` verifies the JWT against
 * the auth server before the caller reaches this, so p_auth_user_id is an identity the caller
 * has already proven. Anyone who can supply a valid one is that user.
 *
 * E13: capabilities are the UNION across every role held in the cycle. A Coordinator who also
 * interviews is ordinary, and v1's gate silently denied the second role.
 *
 * Returns one row per (cycle, role). The caller picks the active cycle and unions the
 * capabilities; that shaping stays in the application because "which cycle am I working in"
 * is a UI concern, while "which cycles MAY I work in" is this function's answer.
 */
CREATE OR REPLACE FUNCTION fn_resolve_staff_session(p_auth_user_id uuid)
RETURNS TABLE (
  user_id      uuid,
  email        text,
  full_name    text,
  cycle_id     uuid,
  cycle_name   text,
  cycle_state  cycle_state,
  role         role_name,
  capabilities text[]
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id,
         u.email::text,
         u.full_name,
         c.id,
         c.name,
         c.state,
         m.role,
         coalesce(
           (SELECT array_agg(rc.capability ORDER BY rc.capability)
              FROM role_capabilities rc WHERE rc.role = m.role),
           ARRAY[]::text[]
         )
    FROM users u
    JOIN memberships m ON m.user_id = u.id AND m.revoked_at IS NULL
    JOIN cycles     c ON c.id = m.cycle_id
   WHERE u.auth_user_id = p_auth_user_id      -- verified uid ONLY; never an email (M-5)
     AND u.disabled_at IS NULL
     AND c.state <> 'archived'
   -- Deterministic and chronological. The previous ordering was `c.year DESC, c.season`, and
   -- season is text — 'FA' < 'SP' < 'SU' alphabetically, which is not calendar order. A user
   -- with two live cycles was bound to whichever sorted first (audit M-6).
   ORDER BY c.year DESC,
            CASE c.season WHEN 'FA' THEN 3 WHEN 'SU' THEN 2 WHEN 'SP' THEN 1 ELSE 0 END DESC,
            c.name
$$;

COMMENT ON FUNCTION fn_resolve_staff_session IS
  'Staff session bootstrap. SECURITY DEFINER because it runs before any security context can '
  'exist — it produces the values that context is made of. Keyed on the VERIFIED Supabase auth '
  'uid, never an email address (FR-RBAC-002, E13, audit M-5, H-6).';

GRANT EXECUTE ON FUNCTION fn_resolve_staff_session(uuid) TO rms_app;

COMMIT;
