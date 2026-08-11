-- 0007 — Identifier allocation, duplicate detection and registration
--
-- The identifier counter is the single most likely place for this system to produce a
-- production bug, because the failure only appears under concurrency: two registration desks
-- pressing Save in the same second. SELECT MAX(sequence)+1 passes every test written by one
-- person on one laptop and fails on the day (FR-IDT-003, rules.md R-020).
--
-- Refs: FR-IDT-001..006, FR-REG-001..011, E4, E6

BEGIN;

-- ── Identifier allocation ───────────────────────────────────────────────────────────────
-- SPH-SP26-0042. The season marker distinguishes Spring 2026 from Fall 2026 — the originally
-- proposed SP26 could not, so two cycles in one year collided semantically.
--
-- UPDATE ... RETURNING takes a row lock for the duration of the transaction, so concurrent
-- callers serialise on this one row and each receives a distinct value. Honest throughput is
-- a few hundred registrations per second, bounded by commit latency — roughly 100x the
-- realistic peak, and not the "thousands per second" v1 claimed (E12).
CREATE OR REPLACE FUNCTION fn_allocate_applicant_id(p_cycle_id uuid)
RETURNS TABLE (sequence int, display_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_seq     int;
  v_code    text;
  v_season  char(2);
  v_year    smallint;
BEGIN
  UPDATE cycles
     SET applicant_seq = applicant_seq + 1
   WHERE id = p_cycle_id
   RETURNING applicant_seq, season, year INTO v_seq, v_season, v_year;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cycle % not found', p_cycle_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT s.code INTO v_code
    FROM societies s JOIN cycles c ON c.society_id = s.id
   WHERE c.id = p_cycle_id;

  sequence   := v_seq;
  display_id := format('%s-%s%s-%s', v_code, v_season, right(v_year::text, 2),
                       lpad(v_seq::text, 4, '0'));
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION fn_allocate_applicant_id IS
  'In-transaction counter increment. SELECT MAX()+1 is forbidden — FR-IDT-003, rules.md R-020';


-- ── Duplicate detection ─────────────────────────────────────────────────────────────────
-- Runs in the APPLICATION LAYER against normalised values, with the partial unique indexes as
-- a backstop for accidents. This ordering is what makes E4's override branch possible: if the
-- index were the only gate, the documented "different person — override" action could never
-- succeed.
--
-- Hard block on exact email / phone / roll. Soft warning on trigram name similarity combined
-- with a shared department preference — a name match alone is far too common to block on
-- (there are several Muhammad Alis in any Pakistani university intake).
CREATE OR REPLACE FUNCTION fn_find_duplicates(
  p_cycle_id uuid,
  p_email    text,
  p_phone    text,
  p_roll     text DEFAULT NULL,
  p_name     text DEFAULT NULL,
  p_dept_ids uuid[] DEFAULT NULL
) RETURNS TABLE (
  applicant_id  uuid,
  display_id    text,
  full_name     text,
  state         applicant_state,
  match_kind    text,
  is_hard_block boolean,
  similarity    real
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- Exact matches on normalised values → hard block (FR-REG-006)
  SELECT a.id, a.display_id, a.full_name, a.state, 'email'::text, true, 1.0::real
    FROM applicants a
   WHERE a.cycle_id = p_cycle_id
     AND a.email_norm = norm_email(p_email)
     AND a.state NOT IN ('withdrawn', 'screened_out')

  UNION ALL
  SELECT a.id, a.display_id, a.full_name, a.state, 'phone'::text, true, 1.0::real
    FROM applicants a
   WHERE a.cycle_id = p_cycle_id
     AND a.phone_norm = norm_phone(p_phone)
     AND a.state NOT IN ('withdrawn', 'screened_out')

  UNION ALL
  SELECT a.id, a.display_id, a.full_name, a.state, 'roll'::text, true, 1.0::real
    FROM applicants a
   WHERE p_roll IS NOT NULL
     AND a.cycle_id = p_cycle_id
     AND a.roll_norm = norm_roll(p_roll)
     AND a.state NOT IN ('withdrawn', 'screened_out')

  -- Fuzzy name + shared preference → soft warning only (FR-REG-010)
  UNION ALL
  SELECT a.id, a.display_id, a.full_name, a.state, 'name_similarity'::text, false,
         similarity(a.full_name, p_name)
    FROM applicants a
   WHERE p_name IS NOT NULL
     AND p_dept_ids IS NOT NULL
     AND a.cycle_id = p_cycle_id
     AND a.state NOT IN ('withdrawn', 'screened_out')
     AND similarity(a.full_name, p_name) >= 0.85
     AND EXISTS (
           SELECT 1 FROM applicant_preferences p
            WHERE p.applicant_id = a.id
              AND p.department_id = ANY(p_dept_ids)
         )
$$;


-- ── Registration ────────────────────────────────────────────────────────────────────────
-- ONE code path for all three channels (FR-REG-002). Paper is an input method, not a separate
-- pipeline — one set of edge cases, and one thing for a volunteer to learn under pressure.
--
-- Duplicate checking happens in the service layer BEFORE this is called, because the resolution
-- is a human decision (FR-REG-007). This function receives the outcome of that decision as
-- p_override_reason.
CREATE OR REPLACE FUNCTION fn_register_applicant(
  p_cycle_id        uuid,
  p_full_name       text,
  p_email           text,
  p_phone           text,
  p_source          registration_channel,
  p_roll_number     text    DEFAULT NULL,
  p_answers         jsonb   DEFAULT '{}'::jsonb,
  p_preferences     uuid[]  DEFAULT NULL,   -- department ids, in rank order
  p_override_reason text    DEFAULT NULL,
  p_needs_completion boolean DEFAULT false
) RETURNS applicants
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle_state cycle_state;
  v_seq         int;
  v_display_id  text;
  v_applicant   applicants;
  v_dept        uuid;
  v_rank        smallint := 1;
  v_max_prefs   smallint;
BEGIN
  -- FR-CYC-004: the cycle state gate is checked HERE, at the write, not in the UI.
  -- A closed registration window must fail for a hand-crafted request too.
  SELECT state INTO v_cycle_state FROM cycles WHERE id = p_cycle_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cycle % not found', p_cycle_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_cycle_state = 'archived' THEN
    RAISE EXCEPTION 'CYCLE_ARCHIVED' USING ERRCODE = 'raise_exception';
  END IF;

  -- Walk-in channels stay open during interviews: someone arriving at the desk on the day
  -- with no prior application is a normal case, not an error (FR-CHK-010).
  IF v_cycle_state <> 'registration_open'
     AND NOT (p_source IN ('walkin_digital', 'walkin_paper')
              AND v_cycle_state IN ('registration_closed', 'interviews_active')) THEN
    RAISE EXCEPTION 'STAGE_CLOSED' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT coalesce((config ->> 'max_preferences')::smallint, 3)
    INTO v_max_prefs FROM cycles WHERE id = p_cycle_id;

  IF p_preferences IS NOT NULL AND array_length(p_preferences, 1) > v_max_prefs THEN
    RAISE EXCEPTION 'at most % department preferences may be ranked', v_max_prefs
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT sequence, display_id INTO v_seq, v_display_id
    FROM fn_allocate_applicant_id(p_cycle_id);

  INSERT INTO applicants (
    cycle_id, display_id, sequence, state, full_name, email, phone, roll_number,
    source, answers, dedupe_override_reason, dedupe_override_by, needs_completion, submitted_at
  ) VALUES (
    p_cycle_id, v_display_id, v_seq, 'submitted', btrim(p_full_name), btrim(p_email),
    btrim(p_phone), nullif(btrim(coalesce(p_roll_number, '')), ''),
    p_source, p_answers, p_override_reason,
    CASE WHEN p_override_reason IS NOT NULL
         THEN nullif(current_setting('app.user_id', true), '')::uuid END,
    p_needs_completion, now()
  )
  RETURNING * INTO v_applicant;

  IF p_preferences IS NOT NULL THEN
    FOREACH v_dept IN ARRAY p_preferences LOOP
      INSERT INTO applicant_preferences (cycle_id, applicant_id, department_id, rank)
      VALUES (p_cycle_id, v_applicant.id, v_dept, v_rank);
      v_rank := v_rank + 1;
    END LOOP;
  END IF;

  PERFORM fn_audit(
    p_cycle_id, 'applicant.registered', 'applicant', v_applicant.id,
    NULL,
    jsonb_build_object(
      'display_id', v_display_id,
      'source', p_source,
      'needs_completion', p_needs_completion,
      'preference_count', coalesce(array_length(p_preferences, 1), 0)
    ),
    p_override_reason
  );

  -- FR-REG-008: an override is its own audited event, distinct from the registration.
  -- It must be answerable later as "who decided these were different people, and why".
  IF p_override_reason IS NOT NULL THEN
    PERFORM fn_audit(
      p_cycle_id, 'applicant.dedupe_overridden', 'applicant', v_applicant.id,
      NULL, jsonb_build_object('display_id', v_display_id), p_override_reason
    );
  END IF;

  RETURN v_applicant;
END $$;

COMMENT ON FUNCTION fn_register_applicant IS
  'Single code path for all three channels. FR-REG-001, FR-REG-002';


-- ── Token issuance ──────────────────────────────────────────────────────────────────────
-- Receives sha256(token) already computed by the caller. The raw token is generated in the
-- application, returned to the user once, and NEVER sent to the database (rules.md R-022).
CREATE OR REPLACE FUNCTION fn_issue_token(
  p_applicant_id uuid,
  p_token_hash   bytea,
  p_expires_at   timestamptz,
  p_reason       text DEFAULT NULL
) RETURNS access_tokens
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle_id uuid;
  v_token    access_tokens;
BEGIN
  IF octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'token_hash must be a 32-byte sha256 digest'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT cycle_id INTO v_cycle_id FROM applicants WHERE id = p_applicant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'applicant % not found', p_applicant_id USING ERRCODE = 'no_data_found';
  END IF;

  -- FR-IDT-009: rotation revokes the previous token immediately and atomically. Same
  -- statement, same transaction — there is no instant at which two tokens are both valid.
  UPDATE access_tokens
     SET revoked_at = now(), revoked_reason = coalesce(p_reason, 'rotated')
   WHERE applicant_id = p_applicant_id AND revoked_at IS NULL;

  INSERT INTO access_tokens (cycle_id, applicant_id, token_hash, expires_at)
  VALUES (v_cycle_id, p_applicant_id, p_token_hash, p_expires_at)
  RETURNING * INTO v_token;

  PERFORM fn_audit(
    v_cycle_id, 'token.issued', 'access_token', v_token.id,
    NULL, jsonb_build_object('applicant_id', p_applicant_id, 'expires_at', p_expires_at),
    p_reason
  );

  RETURN v_token;
END $$;

COMMIT;
