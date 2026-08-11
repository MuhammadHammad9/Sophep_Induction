-- 0012 — Harden the security-context accessors
--
-- Found by tests/rls/fail-closed.test.ts, "treats a garbage context as unset".
--
-- The accessors in migration 0008 do `nullif(current_setting(...), '')::uuid`. If the setting
-- holds anything that is not a valid UUID, the cast RAISES `invalid input syntax for type
-- uuid` rather than yielding NULL. Every query in that transaction then fails.
--
-- Why that matters beyond tidiness:
--
--   * It converts a would-be clean denial into a 500. The boundary still holds — nothing
--     leaks — but the failure is loud, unexplained, and looks like an outage rather than an
--     authorisation decision.
--   * The value is attacker-influenceable wherever context is derived from a token or header.
--     A malformed value should be indistinguishable from an absent one.
--   * Postgres raises the error with the offending value in the message, so a malformed
--     identifier can end up in logs (NFR-MAIN-006).
--
-- The correct behaviour for an unparseable context is exactly the behaviour for a missing
-- one: NULL, therefore zero rows, therefore fail closed.
--
-- Refs: FR-RBAC-005, FR-RBAC-006, rules.md R-014

BEGIN;

CREATE OR REPLACE FUNCTION fn_current_user_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_raw text;
BEGIN
  -- Pattern A: the verified JWT claim.
  BEGIN
    v_raw := nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'user_id', '');
  EXCEPTION WHEN others THEN
    v_raw := NULL;
  END;

  -- Pattern B: transaction-scoped set_config (E9).
  IF v_raw IS NULL THEN
    v_raw := nullif(current_setting('app.user_id', true), '');
  END IF;

  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  -- A malformed value is treated as absent, never as an error.
  BEGIN
    RETURN v_raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
END $$;

CREATE OR REPLACE FUNCTION fn_current_applicant_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_raw text;
BEGIN
  BEGIN
    v_raw := nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'applicant_id', '');
  EXCEPTION WHEN others THEN
    v_raw := NULL;
  END;

  IF v_raw IS NULL THEN
    v_raw := nullif(current_setting('app.applicant_id', true), '');
  END IF;

  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN v_raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
END $$;

COMMENT ON FUNCTION fn_current_user_id IS
  'Security context accessor. Returns NULL when unset OR malformed — both deny. Never raises. FR-RBAC-005';
COMMENT ON FUNCTION fn_current_applicant_id IS
  'Security context accessor. Returns NULL when unset OR malformed — both deny. Never raises. FR-RBAC-005';

-- fn_audit also casts a caller-supplied setting. Same failure mode: a malformed actor id
-- would abort the transaction it is auditing, so a bad header could block legitimate writes.
CREATE OR REPLACE FUNCTION fn_audit(
  p_cycle_id    uuid,
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_before      jsonb DEFAULT NULL,
  p_after       jsonb DEFAULT NULL,
  p_reason      text  DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id   bigint;
  v_role role_name;
  v_ip   inet;
BEGIN
  BEGIN
    v_role := nullif(current_setting('app.actor_role', true), '')::role_name;
  EXCEPTION WHEN others THEN
    v_role := NULL;
  END;

  BEGIN
    v_ip := nullif(current_setting('app.client_ip', true), '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  INSERT INTO audit_events (
    cycle_id, actor_id, actor_role, actor_label,
    action, entity_type, entity_id, before, after, reason, ip
  ) VALUES (
    p_cycle_id,
    fn_current_user_id(),
    v_role,
    nullif(current_setting('app.actor_label', true), ''),
    p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason,
    v_ip
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

COMMIT;
