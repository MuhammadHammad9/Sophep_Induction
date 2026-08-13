-- 0045 — MFA enrolment and challenge, with the secret reachable only by its owner
--
-- `domain/totp.ts` has been complete and unit-tested since Phase 2 — base32, provisioning URI,
-- HOTP, constant-time comparison, ±1 step drift, and a replay watermark. Nothing ever called
-- it. `grep -rn "verifyTotp|requiresMfa" frontend/` returned zero matches, so NFR-SEC-001's
-- second factor for privileged roles was unmet in practice (audit H-6).
--
-- Migration 0037 then made the naive wiring impossible on purpose: `users.totp_secret_enc` is
-- no longer SELECT-able by `rms_app` at all, because a staff directory that hands out
-- authentication material to any query is what made C-3 serious. So enabling MFA needs a
-- deliberate, narrow way back to that column.
--
-- ── WHY VERIFICATION IS NOT DONE INSIDE THE DATABASE ──
--
-- The instinct is to verify in SQL so the secret never leaves Postgres, and pgcrypto's `hmac()`
-- would make that straightforward. It cannot work here: the secret is encrypted with
-- AES-256-GCM at the application layer (NFR-SEC-002), and pgcrypto implements CBC and ECB but
-- not GCM. The database physically cannot decrypt it, which is the property NFR-SEC-002 wanted
-- — a database dump yields no usable secret because the key is not in the database.
--
-- So the split is: the DATABASE decides WHO may see a secret, and the APPLICATION, holding
-- APP_ENCRYPTION_KEY, does the arithmetic. `fn_totp_secret_for_self` returns exactly one
-- secret — the caller's own — and takes no arguments at all, so there is no parameter to point
-- at somebody else. That is strictly narrower than the pre-0037 state, where any query with
-- `applicant.view` could read every row of `users` including this column.
--
-- ── REPLAY, AND WHY THE WATERMARK IS WRITTEN BY THE DATABASE ──
--
-- RFC 6238 §5.2: a code must be accepted once. `verifyTotp` returns the matched step and
-- `fn_record_totp_use` moves the watermark forward with GREATEST, so a code observed over a
-- shoulder cannot be reused inside its 30-second window. That function was hardened in 0038 to
-- refuse advancing anyone else's watermark — without which the replay guard was itself a
-- permanent lockout primitive.
--
-- Refs: FR-RBAC-008, NFR-SEC-001, NFR-SEC-002, rules.md R-032, audit H-6, C-3

BEGIN;

/**
 * The caller's OWN encrypted TOTP secret, or NULL.
 *
 * No arguments by design: there is no identifier to tamper with. The row is chosen by
 * `fn_current_user_id()`, which reads only the transaction-local context bound by withContext
 * (0040), so an unbound caller gets NULL and an unauthenticated one cannot reach it at all
 * (0036 revoked EXECUTE from PUBLIC; 0044 keeps it revoked).
 */
CREATE OR REPLACE FUNCTION fn_totp_secret_for_self()
RETURNS bytea
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid;
  v_secret bytea;
BEGIN
  v_user := fn_current_user_id();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'TOKEN_INVALID: MFA requires an authenticated session'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT totp_secret_enc INTO v_secret
    FROM users WHERE id = v_user AND disabled_at IS NULL;

  RETURN v_secret;
END $$;

COMMENT ON FUNCTION fn_totp_secret_for_self IS
  'The calling user''s own encrypted TOTP secret. Takes no argument, so there is nothing to '
  'point at another account. The application decrypts it — pgcrypto cannot, because the '
  'scheme is AES-256-GCM (NFR-SEC-002, audit H-6).';

GRANT EXECUTE ON FUNCTION fn_totp_secret_for_self() TO rms_app;


/**
 * Stage a secret for enrolment.
 *
 * Deliberately does NOT set `totp_enabled`. Enrolment is two steps — store, then prove you can
 * generate a code — because a volunteer who scans the QR into an authenticator, gets it wrong,
 * and is immediately locked out has no way back in on the morning of the event. Confirmation is
 * what proves the authenticator actually works before it becomes required.
 */
CREATE OR REPLACE FUNCTION fn_totp_begin_enrolment(p_secret_enc bytea)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := fn_current_user_id();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'TOKEN_INVALID: enrolment requires an authenticated session'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Re-enrolling while already enabled would let anyone holding a live session replace the
  -- second factor with one they control, which defeats the point of having it. Disabling is a
  -- separate, administrative action.
  IF EXISTS (SELECT 1 FROM users WHERE id = v_user AND totp_enabled) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: MFA is already enabled for this account'
      USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE users
     SET totp_secret_enc = p_secret_enc,
         totp_enrolled_at = NULL,
         totp_last_used_step = NULL
   WHERE id = v_user;

  PERFORM fn_audit(NULL, 'mfa.enrolment_started', 'user', v_user, NULL, NULL, NULL);
END $$;

GRANT EXECUTE ON FUNCTION fn_totp_begin_enrolment(bytea) TO rms_app;


/**
 * Turn the second factor on, after the caller has proved a code.
 *
 * The proof happens in the application — it is the only party that can decrypt — so this
 * records the outcome and the first spent step together. Passing the step here rather than
 * calling fn_record_totp_use separately keeps "enabled" and "watermark initialised" in ONE
 * transaction: a crash between them would leave MFA on with a NULL watermark, which accepts a
 * replay of the enrolment code.
 */
CREATE OR REPLACE FUNCTION fn_totp_confirm_enrolment(p_step bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := fn_current_user_id();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'TOKEN_INVALID: enrolment requires an authenticated session'
      USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE users
     SET totp_enabled = true,
         totp_enrolled_at = now(),
         totp_last_used_step = GREATEST(coalesce(totp_last_used_step, 0), p_step)
   WHERE id = v_user AND totp_secret_enc IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: no staged secret — start enrolment first'
      USING ERRCODE = 'raise_exception';
  END IF;

  PERFORM fn_audit(NULL, 'mfa.enabled', 'user', v_user, NULL,
    jsonb_build_object('enrolled_at', now()), NULL);
END $$;

GRANT EXECUTE ON FUNCTION fn_totp_confirm_enrolment(bigint) TO rms_app;


/**
 * Whether the caller must present a second factor, and whether they have one.
 *
 * Both facts in one call because the interface needs them together: "you must enrol" and "you
 * must enter a code" are different screens, and deciding between them from two round trips
 * invites the two answers to disagree.
 *
 * The role set comes from MEMBERSHIPS, never from anything the caller supplies — same
 * reasoning as fn_has_capability.
 */
CREATE OR REPLACE FUNCTION fn_mfa_status()
RETURNS TABLE (required boolean, enrolled boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid;
BEGIN
  v_user := fn_current_user_id();
  IF v_user IS NULL THEN
    required := false; enrolled := false; RETURN NEXT; RETURN;
  END IF;

  -- FR-RBAC-008 / MFA_REQUIRED_ROLES in domain/totp.ts. Kept in step with that list
  -- deliberately: a role added there and not here would silently not be challenged.
  SELECT EXISTS (
    SELECT 1 FROM memberships m
      JOIN cycles c ON c.id = m.cycle_id
     WHERE m.user_id = v_user
       AND m.revoked_at IS NULL
       AND c.state <> 'archived'
       AND m.role IN ('super_admin', 'coordinator', 'admin')
  ) INTO required;

  SELECT coalesce(bool_or(totp_enabled), false) INTO enrolled
    FROM users WHERE id = v_user;

  RETURN NEXT;
END $$;

COMMENT ON FUNCTION fn_mfa_status IS
  'Whether the caller''s roles require a second factor and whether they hold one. Roles come '
  'from memberships, never from the caller (FR-RBAC-008).';

GRANT EXECUTE ON FUNCTION fn_mfa_status() TO rms_app;

COMMIT;
