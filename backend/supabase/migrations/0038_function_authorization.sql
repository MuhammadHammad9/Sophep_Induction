-- 0038 — Authorisation inside the SECURITY DEFINER functions
--
-- Migration 0036 shut the door: PostgREST can no longer reach these at all. This migration
-- fixes the reason that door mattered — several functions that write decisions, issue offers,
-- export the cohort or destroy PII performed NO authorisation check of their own.
--
-- Both layers are needed, and it is worth being precise about why, because "0036 already fixed
-- it" is a tempting and wrong conclusion:
--
--   * 0036 is perimeter. It stops an ANONYMOUS caller reaching the function.
--   * This is authorisation. It stops an AUTHENTICATED one — a volunteer, an interviewer —
--     from performing an action their role does not carry.
--
-- Without this migration, every signed-in volunteer can overturn admission decisions, because
-- `SECURITY DEFINER` means RLS never applies inside these bodies. R-032 is explicit that
-- capability is enforced at the database first and the UI is ergonomics only. That promise was
-- unmet for the nine functions below.
--
-- Capability names are the ones already in `role_capabilities` (migration 0008). No new
-- capability is invented here — inventing one would silently change who may do what, which is
-- a committee decision and not an implementation detail (R-054).
--
-- ── The internal-caller problem, and the idiom used to solve it ─────────────────────────
--
-- `fn_cascade_department` calls `fn_issue_offer` on behalf of an APPLICANT who just declined.
-- That applicant holds no `allocation.run` capability and must not — yet the cascade must
-- proceed, immediately, or a released seat is never re-offered (FR-OFF-003).
--
-- So `fn_issue_offer` accepts either a capability OR a transaction-local marker set by the
-- cascade. This is the same idiom migration 0006 already uses for `app.state_writer`, where
-- `applicants.state` may only be written by named owning functions. Reusing it keeps one
-- concept in the reader's head instead of two, and the marker is `is_local` so it cannot
-- outlive the transaction that set it.
--
-- Refs: FR-DEC-006, FR-DEC-016, FR-OFF-003, FR-INT-004, FR-INT-008, FR-CHK-018,
--       rules.md R-011, R-029, R-032, audit C-2, C-4, M-8

BEGIN;

-- ── A shared guard, so the refusal reads identically everywhere ─────────────────────────
--
-- Raising a distinguishable message matters: IR-002 requires a machine-readable code, and the
-- route handlers map `DUAL_CONTROL_REQUIRED:` onto a 403 with the missing capability named, so
-- the interface can say WHY a control is unavailable rather than just disabling it (R-058).
CREATE OR REPLACE FUNCTION fn_require_capability(p_cycle_id uuid, p_capability text)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF fn_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'TOKEN_INVALID: this action must be attributed to an authenticated user'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT fn_has_capability(p_cycle_id, p_capability) THEN
    RAISE EXCEPTION 'DUAL_CONTROL_REQUIRED: missing capability %', p_capability
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

COMMENT ON FUNCTION fn_require_capability IS
  'Uniform capability gate for SECURITY DEFINER functions, which RLS does not apply to. '
  'Raises rather than returning false so a caller cannot forget to check the result (R-032).';

GRANT EXECUTE ON FUNCTION fn_require_capability(uuid, text) TO rms_app;


-- ── fn_record_totp_use — anyone could brick anyone's MFA ────────────────────────────────
--
-- The watermark only ever moves forward (GREATEST), which correctly stops a replayed code
-- being re-spent. With no caller check, that same property is the weapon: set another user's
-- watermark to a far-future step and every real code they generate is rejected as already
-- used. A permanent, silent lockout of exactly the accounts that hold `results.lock`.
CREATE OR REPLACE FUNCTION fn_record_totp_use(p_user_id uuid, p_step bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- You may only spend your own code. There is no administrative reason to advance someone
  -- else's watermark — recovery is disenrolment, which is a different, audited action.
  IF p_user_id IS DISTINCT FROM fn_current_user_id() THEN
    RAISE EXCEPTION 'TOKEN_INVALID: a TOTP step may only be recorded for the calling user'
      USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE users
     SET totp_last_used_step = GREATEST(coalesce(totp_last_used_step, 0), p_step)
   WHERE id = p_user_id;
END $$;


-- ── fn_bulk_reconcile — mass check-in with no check ─────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_bulk_reconcile(
  p_stage_id uuid,
  p_applicant_ids uuid[]
) RETURNS TABLE (
  applicant_id uuid,
  outcome text,
  queue_position int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_rec record;
  v_cycle_id uuid;
BEGIN
  SELECT s.cycle_id INTO v_cycle_id FROM stages s WHERE s.id = p_stage_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stage % not found', p_stage_id USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM fn_require_capability(v_cycle_id, 'checkin.perform');

  -- Bounded. An unbounded array is a single transaction holding row locks across the whole
  -- cohort while the event is running — reconciliation is a recovery tool, not a bulk import,
  -- and 500 is already far past any real desk backlog (FR-CHK-014).
  IF array_length(p_applicant_ids, 1) > 500 THEN
    RAISE EXCEPTION 'RATE_LIMITED: reconcile at most 500 applicants per call, got %',
      array_length(p_applicant_ids, 1) USING ERRCODE = 'raise_exception';
  END IF;

  FOREACH v_id IN ARRAY p_applicant_ids
  LOOP
    BEGIN
      SELECT * INTO v_rec FROM fn_check_in(
        p_applicant_id := v_id,
        p_stage_id := p_stage_id,
        p_method := 'bulk_reconcile'
      );

      applicant_id := v_id;
      outcome := v_rec.outcome;
      queue_position := v_rec.queue_position;
      RETURN NEXT;
    EXCEPTION WHEN raise_exception OR unique_violation OR check_violation OR foreign_key_violation THEN
      -- In a bulk operation, one domain-level failure must not abort the rest.
      applicant_id := v_id;
      outcome := 'error: ' || SQLERRM;
      queue_position := NULL;
      RETURN NEXT;
    END;
  END LOOP;

  RETURN;
END $$;


-- ── The offline roster bundles — the whole cohort's identities ──────────────────────────
--
-- These return every applicant's name and identifier for a cycle. That is correct for a
-- check-in device (FR-CHK-018, spec.json offline.roster_bundle) and completely wrong for
-- anyone else. `checkin.perform` is the capability every desk role already holds.

CREATE OR REPLACE FUNCTION fn_roster_bundle(p_cycle_id uuid)
RETURNS TABLE (token_hash_b64 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM fn_require_capability(p_cycle_id, 'checkin.perform');

  RETURN QUERY
  SELECT encode(t.token_hash, 'base64')
    FROM access_tokens t
    JOIN applicants a ON a.id = t.applicant_id
   WHERE a.cycle_id = p_cycle_id
     AND t.revoked_at IS NULL
     AND t.expires_at > now()
     AND a.state NOT IN ('withdrawn', 'screened_out');
END $$;

CREATE OR REPLACE FUNCTION fn_roster_bundle_v2(p_cycle_id uuid)
RETURNS TABLE (
  applicant_id   uuid,
  display_id     text,
  full_name      text,
  token_hash_b64 text,
  preferences    text[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM fn_require_capability(p_cycle_id, 'checkin.perform');

  RETURN QUERY
  SELECT a.id,
         a.display_id,
         a.full_name,
         translate(encode(t.token_hash, 'base64'), '+/', '-_'),
         COALESCE(
           (SELECT array_agg(d.code ORDER BY p.rank)
              FROM applicant_preferences p
              JOIN departments d ON d.id = p.department_id
             WHERE p.applicant_id = a.id),
           ARRAY[]::text[]
         )
    FROM access_tokens t
    JOIN applicants a ON a.id = t.applicant_id
   WHERE a.cycle_id = p_cycle_id
     AND t.revoked_at IS NULL
     AND t.expires_at > now()
     AND a.state NOT IN ('withdrawn', 'screened_out')
   ORDER BY a.display_id;
END $$;

-- fn_cycle_public_key stays open to any bound context. It returns a PUBLIC key: it permits
-- verification and not signing, which is the entire reason the scheme is Ed25519 (E1, R-021).
-- Gating it would buy nothing and would break a device that legitimately re-fetches it.


-- ── fn_export_selected — the cohort export, ungated and unaudited ───────────────────────
--
-- Two defects. It had no capability check, and it wrote no audit row — while R-011 lists
-- "export" explicitly among the actions that must be audited in the same transaction.
--
-- Converted from `LANGUAGE sql STABLE` to plpgsql VOLATILE, because a STABLE function may not
-- write, and an unauditable export is not one this system is allowed to offer.
CREATE OR REPLACE FUNCTION fn_export_selected(p_cycle_id uuid)
RETURNS TABLE (department_name text, display_id text, full_name text, final_score numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
BEGIN
  PERFORM fn_require_capability(p_cycle_id, 'data.export');

  SELECT count(*) INTO v_count
    FROM current_decisions cd
   WHERE cd.cycle_id = p_cycle_id AND cd.outcome = 'selected';

  -- Written BEFORE the rows are returned, in the same transaction. If the audit insert fails
  -- the export does not happen — no audit, no commit (R-011).
  PERFORM fn_audit(
    p_cycle_id, 'results.exported', 'cycle', p_cycle_id,
    NULL, jsonb_build_object('row_count', v_count, 'export', 'selected'),
    'selected-applicant export'
  );

  RETURN QUERY
  SELECT d.name, a.display_id, a.full_name, s.final_score
    FROM current_decisions cd
    JOIN applicants a ON a.id = cd.applicant_id
    JOIN departments d ON d.id = cd.department_id
    LEFT JOIN applicant_scores s ON s.applicant_id = a.id
   WHERE cd.cycle_id = p_cycle_id AND cd.outcome = 'selected'
   ORDER BY d.name, s.final_score DESC NULLS LAST, a.display_id;
END $$;


-- ── fn_override_decision — any authenticated user could overturn any decision ───────────
--
-- It required an authenticated actor and a written reason, which is most of the way there. It
-- never checked capability, so an interviewer or a volunteer could rewrite an admission
-- outcome and the audit row would faithfully record them doing it.
CREATE OR REPLACE FUNCTION fn_override_decision(
  p_applicant_id  uuid,
  p_outcome       decision_outcome,
  p_department_id uuid,
  p_reason        text
) RETURNS decisions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_current decisions;
  v_new     decisions;
  v_actor   uuid;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a written reason is required to override a decision'
      USING ERRCODE = 'raise_exception';
  END IF;

  v_actor := fn_current_user_id();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'an override must be attributed to an authenticated user'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO v_current FROM decisions
   WHERE applicant_id = p_applicant_id ORDER BY version DESC LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no decision exists for applicant %', p_applicant_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- The check that was missing. Resolved against the decision's own cycle, not a caller-
  -- supplied one, so it cannot be pointed at a cycle the caller happens to administer.
  PERFORM fn_require_capability(v_current.cycle_id, 'allocation.run');

  IF EXISTS (
    SELECT 1 FROM cycles
     WHERE id = v_current.cycle_id AND state IN ('results_locked', 'published', 'archived')
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: results are locked — use the correction path'
      USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO decisions (
    cycle_id, applicant_id, version, outcome, department_id,
    is_proposal, decided_by, reason, allocation_run_id
  ) VALUES (
    v_current.cycle_id, p_applicant_id, v_current.version + 1, p_outcome, p_department_id,
    false, v_actor, p_reason, v_current.allocation_run_id
  )
  RETURNING * INTO v_new;

  PERFORM fn_audit(
    v_current.cycle_id, 'decision.overridden', 'decision', v_new.id,
    jsonb_build_object('outcome', v_current.outcome, 'department_id', v_current.department_id,
                       'version', v_current.version),
    jsonb_build_object('outcome', v_new.outcome, 'department_id', v_new.department_id,
                       'version', v_new.version),
    p_reason
  );

  RETURN v_new;
END $$;


-- ── fn_issue_offer — capability, or the cascade marker ──────────────────────────────────
CREATE OR REPLACE FUNCTION fn_issue_offer(
  p_applicant_id  uuid,
  p_department_id uuid,
  p_replaces      uuid DEFAULT NULL
) RETURNS offers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle_id uuid;
  v_hours    int;
  v_offer    offers;
BEGIN
  SELECT cycle_id INTO v_cycle_id FROM applicants WHERE id = p_applicant_id;
  IF v_cycle_id IS NULL THEN
    RAISE EXCEPTION 'applicant % not found', p_applicant_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Either a human with the capability, or the waitlist cascade acting for a declining
  -- applicant who holds no capability at all and must not need one (FR-OFF-003). The marker is
  -- transaction-local, so it cannot leak to the next request on a pooled connection.
  IF coalesce(current_setting('app.offer_writer', true), '') <> 'fn_cascade_department' THEN
    PERFORM fn_require_capability(v_cycle_id, 'allocation.run');
  END IF;

  SELECT coalesce((config ->> 'offer_expiry_hours')::int, 24)
    INTO v_hours FROM cycles WHERE id = v_cycle_id;

  INSERT INTO offers (cycle_id, applicant_id, department_id, expires_at, replaces_offer_id)
  VALUES (v_cycle_id, p_applicant_id, p_department_id,
          now() + make_interval(hours => v_hours), p_replaces)
  ON CONFLICT (applicant_id, department_id) DO UPDATE
    SET state = 'pending', expires_at = now() + make_interval(hours => v_hours),
        responded_at = NULL, reminder_sent_at = NULL
  RETURNING * INTO v_offer;

  PERFORM set_config('app.state_writer', 'fn_apply_decision', true);
  UPDATE applicants SET state = 'offer_pending' WHERE id = p_applicant_id;
  PERFORM set_config('app.state_writer', '', true);

  PERFORM fn_audit(v_cycle_id, 'offer.issued', 'offer', v_offer.id,
    NULL, jsonb_build_object('department_id', p_department_id, 'expires_at', v_offer.expires_at),
    CASE WHEN p_replaces IS NOT NULL THEN 'waitlist cascade' END);

  RETURN v_offer;
END $$;


-- ── fn_cascade_department — sets and clears the marker around its issuance loop ─────────
CREATE OR REPLACE FUNCTION fn_cascade_department(p_department_id uuid)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_dept       departments;
  v_taken      int;
  v_free       int;
  v_candidate  record;
  v_issued     int := 0;
BEGIN
  SELECT * INTO v_dept FROM departments WHERE id = p_department_id;

  SELECT count(*) INTO v_taken
    FROM offers
   WHERE department_id = p_department_id
     AND (state = 'accepted' OR (state = 'pending' AND expires_at > now()));

  v_free := coalesce(v_dept.capacity, 0) - v_taken;
  IF v_free <= 0 THEN
    RETURN 0;
  END IF;

  FOR v_candidate IN
    SELECT cd.applicant_id, cd.waitlist_rank
      FROM current_decisions cd
      JOIN applicants a ON a.id = cd.applicant_id
     WHERE cd.department_id = p_department_id
       AND cd.outcome = 'waitlisted'
       AND a.state NOT IN ('withdrawn', 'screened_out', 'no_show', 'accepted', 'onboarded')
       AND NOT EXISTS (
             SELECT 1 FROM offers o
              WHERE o.applicant_id = cd.applicant_id
                AND (o.state = 'accepted' OR (o.state = 'pending' AND o.expires_at > now())))
     ORDER BY cd.waitlist_rank NULLS LAST, cd.applicant_id
     LIMIT v_free
  LOOP
    -- Narrow window: set immediately before, cleared immediately after, so the marker is never
    -- in force across anything but the one call it authorises.
    PERFORM set_config('app.offer_writer', 'fn_cascade_department', true);
    PERFORM fn_issue_offer(v_candidate.applicant_id, p_department_id);
    PERFORM set_config('app.offer_writer', '', true);
    v_issued := v_issued + 1;
  END LOOP;

  IF v_issued < v_free THEN
    PERFORM fn_audit(v_dept.cycle_id, 'offer.waitlist_exhausted', 'department', p_department_id,
      NULL, jsonb_build_object('unfilled_seats', v_free - v_issued),
      'waitlist exhausted — department closes under capacity');
  END IF;

  RETURN v_issued;
END $$;


-- ── fn_respond_to_offer — the IDOR ──────────────────────────────────────────────────────
--
-- The worst of the authorisation defects, because it is destructive and irreversible.
--
-- It validated that the offer exists, is pending and is unexpired, and never checked WHO was
-- responding. Any caller holding an offer id could decline someone else's place; the function
-- then calls fn_cascade_department, which reassigns the seat to the next person on the
-- waitlist immediately. Once results are locked, fn_override_decision refuses to correct it,
-- and the audit row reads as though the applicant declined it themselves.
--
-- Two legitimate callers, and they are recorded differently on purpose: an applicant deciding
-- for themselves, and a staff member entering a response received by phone or in person. A
-- dispute months later turns on exactly that distinction.
CREATE OR REPLACE FUNCTION fn_respond_to_offer(p_offer_id uuid, p_accept boolean)
RETURNS offers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_offer     offers;
  v_applicant uuid;
  v_on_behalf boolean := false;
BEGIN
  SELECT * INTO v_offer FROM offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer % not found', p_offer_id USING ERRCODE = 'no_data_found';
  END IF;

  v_applicant := fn_current_applicant_id();

  IF v_applicant IS NOT NULL AND v_applicant = v_offer.applicant_id THEN
    v_on_behalf := false;                                   -- the applicant, for themselves
  ELSIF fn_current_user_id() IS NOT NULL
        AND fn_has_capability(v_offer.cycle_id, 'applicant.edit_contact') THEN
    v_on_behalf := true;                                    -- staff, recording a response
  ELSE
    -- Deliberately the same refusal for "not your offer" and "no such offer": distinguishing
    -- them would confirm that a guessed id is real (NFR-PRIV-005).
    RAISE EXCEPTION 'TOKEN_INVALID: this offer is not yours to answer'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF v_offer.state <> 'pending' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: this offer is already %', v_offer.state
      USING ERRCODE = 'raise_exception';
  END IF;

  IF v_offer.expires_at <= now() THEN
    RAISE EXCEPTION 'TOKEN_EXPIRED: this offer expired at %', v_offer.expires_at
      USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE offers
     SET state = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END::offer_state,
         responded_at = now()
   WHERE id = p_offer_id
   RETURNING * INTO v_offer;

  PERFORM set_config('app.state_writer', 'fn_apply_decision', true);
  UPDATE applicants
     SET state = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END::applicant_state
   WHERE id = v_offer.applicant_id;
  PERFORM set_config('app.state_writer', '', true);

  PERFORM fn_audit(v_offer.cycle_id, 'offer.' || v_offer.state::text, 'offer', p_offer_id,
    jsonb_build_object('state', 'pending'),
    jsonb_build_object('state', v_offer.state, 'on_behalf', v_on_behalf),
    CASE WHEN v_on_behalf THEN 'recorded by staff on the applicant''s behalf' END);

  IF NOT p_accept THEN
    PERFORM fn_cascade_department(v_offer.department_id);
  END IF;

  RETURN v_offer;
END $$;

COMMIT;
