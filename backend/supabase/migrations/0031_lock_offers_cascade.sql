-- 0031 — Dual-control lock, snapshot, offers and the waitlist cascade
--
-- The lock is the moment the meeting's decisions stop being a discussion and become the
-- outcome. Dual control (FR-DEC-010) is ten extra seconds that removes an entire category of
-- "who published this" from the society's future, and RSK-007 rates accidental early
-- publication as low-likelihood, high-impact — exactly the shape of risk a cheap control is
-- worth having for.
--
-- Committee decisions in force: offers expire in 24 HOURS with a reminder at T−6h, and the
-- cascade runs HOURLY. The spec's 5-day expiry and T−48h reminder do not apply — a 48-hour
-- reminder against a 24-hour deadline would have to fire before the offer was sent.
--
-- Refs: FR-DEC-010..016, FR-OFF-001..006, DR-007

BEGIN;

-- ── Immutable snapshot (FR-DEC-011, DR-007) ─────────────────────────────────────────────
CREATE TABLE result_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id     uuid NOT NULL REFERENCES cycles(id),
  payload      jsonb NOT NULL,
  checksum     text  NOT NULL,
  decision_count int NOT NULL,
  locked_by    uuid NOT NULL REFERENCES users(id),
  confirmed_by uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- The same constraint as on cycles, restated here so the snapshot itself carries the
  -- evidence that two distinct people signed it off.
  CONSTRAINT snapshot_dual_control CHECK (confirmed_by <> locked_by)
);

CREATE INDEX idx_snapshots_cycle ON result_snapshots (cycle_id, created_at DESC);

-- Write-once. Post-publication corrections create a NEW decision version and a distinct
-- notice; the snapshot of what was published stays intact (FR-DEC-016). That is what you want
-- the first time someone disputes a result.
CREATE OR REPLACE FUNCTION fn_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'result_snapshots is write-once — corrections create a new decision version, never a rewrite (FR-DEC-016, DR-007)'
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER trg_snapshot_no_update BEFORE UPDATE ON result_snapshots
  FOR EACH ROW EXECUTE FUNCTION fn_snapshot_immutable();
CREATE TRIGGER trg_snapshot_no_delete BEFORE DELETE ON result_snapshots
  FOR EACH ROW EXECUTE FUNCTION fn_snapshot_immutable();


-- ── Step 1 of dual control ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_lock_results(p_cycle_id uuid)
RETURNS cycles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle cycles;
  v_actor uuid;
  v_undecided int;
BEGIN
  v_actor := fn_current_user_id();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'locking must be attributed to an authenticated Super Admin'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT fn_has_capability(p_cycle_id, 'results.lock') THEN
    RAISE EXCEPTION 'DUAL_CONTROL_REQUIRED: only a Super Admin may lock results'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO v_cycle FROM cycles WHERE id = p_cycle_id FOR UPDATE;

  IF v_cycle.state IN ('results_locked', 'published', 'archived') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: results are already locked'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- FR-DEC-014, checked before the lock rather than after: an interviewed applicant with no
  -- decision at all is an omission, and locking would make it permanent.
  SELECT count(*) INTO v_undecided
    FROM applicants a
   WHERE a.cycle_id = p_cycle_id
     AND a.state NOT IN ('withdrawn', 'screened_out', 'no_show')
     AND EXISTS (SELECT 1 FROM interviews i WHERE i.applicant_id = a.id AND i.status = 'complete')
     AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.applicant_id = a.id);

  IF v_undecided > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: % interviewed applicant(s) have no decision', v_undecided
      USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE cycles SET locked_by = v_actor, locked_at = now() WHERE id = p_cycle_id
  RETURNING * INTO v_cycle;

  PERFORM fn_audit(p_cycle_id, 'results.lock_requested', 'cycle', p_cycle_id,
    NULL, jsonb_build_object('locked_by', v_actor), NULL);

  RETURN v_cycle;
END $$;


-- ── Step 2 — a DIFFERENT Super Admin ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_confirm_lock(p_cycle_id uuid)
RETURNS result_snapshots
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle    cycles;
  v_actor    uuid;
  v_payload  jsonb;
  v_checksum text;
  v_count    int;
  v_snapshot result_snapshots;
BEGIN
  v_actor := fn_current_user_id();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'confirmation must be attributed to an authenticated Super Admin'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT fn_has_capability(p_cycle_id, 'results.lock') THEN
    RAISE EXCEPTION 'DUAL_CONTROL_REQUIRED: only a Super Admin may confirm'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO v_cycle FROM cycles WHERE id = p_cycle_id FOR UPDATE;

  IF v_cycle.locked_by IS NULL THEN
    RAISE EXCEPTION 'DUAL_CONTROL_REQUIRED: nobody has requested the lock yet'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The point of the whole mechanism. A single account must not be able to complete both
  -- steps — otherwise it is one person clicking twice, which is not a control.
  IF v_cycle.locked_by = v_actor THEN
    RAISE EXCEPTION
      'DUAL_CONTROL_REQUIRED: confirmation must come from a different Super Admin'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Freeze the decisions as they stand. Stored as data rather than regenerated on read: the
  -- point is to answer "what was published" years later, even if the code that produced it
  -- has changed beyond recognition.
  WITH agg AS (
    SELECT coalesce(jsonb_agg(row ORDER BY row->>'display_id'), '[]'::jsonb) as p,
           count(*) as c
      FROM (
        SELECT jsonb_build_object(
                 'applicant_id', a.id,
                 'display_id',   a.display_id,
                 'full_name',    a.full_name,
                 'outcome',      cd.outcome,
                 'department',   d.name,
                 'waitlist_rank', cd.waitlist_rank,
                 'final_score',  s.final_score,
                 'raw_mean',     s.raw_mean,
                 'flags',        s.flags,
                 'decided_by_human', NOT cd.is_proposal,
                 'reason',       cd.reason
               ) AS row
          FROM current_decisions cd
          JOIN applicants a ON a.id = cd.applicant_id
          LEFT JOIN departments d ON d.id = cd.department_id
          LEFT JOIN applicant_scores s ON s.applicant_id = a.id
         WHERE cd.cycle_id = p_cycle_id
      ) rows
  )
  INSERT INTO result_snapshots (
    cycle_id, payload, checksum, decision_count, locked_by, confirmed_by
  ) 
  SELECT p_cycle_id, p, encode(sha256(convert_to(p::text, 'UTF8')), 'hex'), c, v_cycle.locked_by, v_actor
    FROM agg
  RETURNING * INTO v_snapshot;

  UPDATE cycles
     SET lock_confirmed_by = v_actor, state = 'results_locked'
   WHERE id = p_cycle_id;

  PERFORM fn_audit(p_cycle_id, 'results.locked', 'result_snapshot', v_snapshot.id,
    NULL,
    jsonb_build_object('checksum', v_checksum, 'decisions', v_count,
                       'locked_by', v_cycle.locked_by, 'confirmed_by', v_actor),
    NULL);

  RETURN v_snapshot;
END $$;

COMMENT ON FUNCTION fn_confirm_lock IS
  'Second step of dual control. Refuses if the same account requested the lock — one person clicking twice is not a control. FR-DEC-010';


-- ── Publish (FR-DEC-015) ────────────────────────────────────────────────────────────────
-- No email for cycle one: outcomes become visible on each applicant's own status page, and the
-- committee announces selections themselves. Publishing is therefore the moment the decision
-- RLS policy starts returning rows, not the moment messages are dispatched.
CREATE OR REPLACE FUNCTION fn_publish_results(p_cycle_id uuid)
RETURNS cycles
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle cycles;
BEGIN
  IF NOT fn_has_capability(p_cycle_id, 'results.lock') THEN
    RAISE EXCEPTION 'DUAL_CONTROL_REQUIRED: only a Super Admin may publish'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO v_cycle FROM cycles WHERE id = p_cycle_id FOR UPDATE;

  IF v_cycle.state <> 'results_locked' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: results must be locked before publishing'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Applicant state catches up with the decision, through the owning function.
  PERFORM set_config('app.state_writer', 'fn_apply_decision', true);
  UPDATE applicants a
     SET state = CASE cd.outcome
                   WHEN 'selected'   THEN 'selected'
                   WHEN 'waitlisted' THEN 'waitlisted'
                   ELSE 'rejected'
                 END::applicant_state
    FROM current_decisions cd
   WHERE cd.applicant_id = a.id AND cd.cycle_id = p_cycle_id;
  PERFORM set_config('app.state_writer', '', true);

  UPDATE cycles SET state = 'published', published_at = now() WHERE id = p_cycle_id
  RETURNING * INTO v_cycle;

  PERFORM fn_audit(p_cycle_id, 'results.published', 'cycle', p_cycle_id,
    NULL, jsonb_build_object('published_at', now()), NULL);

  RETURN v_cycle;
END $$;


-- ── Export, for building the announcement (committee decision) ──────────────────────────
CREATE OR REPLACE FUNCTION fn_export_selected(p_cycle_id uuid)
RETURNS TABLE (department_name text, display_id text, full_name text, final_score numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.name, a.display_id, a.full_name, s.final_score
    FROM current_decisions cd
    JOIN applicants a ON a.id = cd.applicant_id
    JOIN departments d ON d.id = cd.department_id
    LEFT JOIN applicant_scores s ON s.applicant_id = a.id
   WHERE cd.cycle_id = p_cycle_id AND cd.outcome = 'selected'
   ORDER BY d.name, s.final_score DESC NULLS LAST, a.display_id
$$;

GRANT EXECUTE ON FUNCTION fn_export_selected(uuid) TO rms_app;


-- ── Offers (FR-OFF-001..006) ────────────────────────────────────────────────────────────
CREATE TYPE offer_state AS ENUM ('pending', 'accepted', 'declined', 'lapsed', 'withdrawn');

CREATE TABLE offers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id      uuid NOT NULL REFERENCES cycles(id),
  applicant_id  uuid NOT NULL REFERENCES applicants(id),
  department_id uuid NOT NULL REFERENCES departments(id),

  state         offer_state NOT NULL DEFAULT 'pending',
  -- 24 hours, the committee's decision. The spec's default is 5 days.
  expires_at    timestamptz NOT NULL,
  reminder_sent_at timestamptz,
  responded_at  timestamptz,

  -- A cascade offer records who it replaced, so a chain of promotions is traceable end to end.
  replaces_offer_id uuid REFERENCES offers(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (applicant_id, department_id)
);

CREATE INDEX idx_offers_expiring ON offers (expires_at) WHERE state = 'pending';
CREATE INDEX idx_offers_department ON offers (department_id, state);


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


CREATE OR REPLACE FUNCTION fn_respond_to_offer(p_offer_id uuid, p_accept boolean)
RETURNS offers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_offer offers;
BEGIN
  SELECT * INTO v_offer FROM offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer % not found', p_offer_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_offer.state <> 'pending' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: this offer is already %', v_offer.state
      USING ERRCODE = 'raise_exception';
  END IF;

  -- An expired offer cannot be accepted late. Allowing it would mean the seat had already
  -- cascaded to someone else and two people hold one place.
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
    jsonb_build_object('state', v_offer.state), NULL);

  -- FR-OFF-003: a decline releases the seat immediately.
  IF NOT p_accept THEN
    PERFORM fn_cascade_department(v_offer.department_id);
  END IF;

  RETURN v_offer;
END $$;


-- ── The cascade (FR-OFF-003..005) ───────────────────────────────────────────────────────
--
-- Runs HOURLY, which the 24-hour expiry forces. At the spec's 5-day expiry a daily sweep would
-- be fine; at 24 hours a released seat would sit idle past the point anyone could still accept.
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

  -- Seats held: accepted offers plus still-live pending ones. Counting pending offers as taken
  -- is what stops the cascade over-issuing while people are still deciding.
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
       -- FR-OFF-004: skip anyone no longer eligible or already placed elsewhere. They are
       -- marked lapsed and the cascade continues rather than stopping.
       AND a.state NOT IN ('withdrawn', 'screened_out', 'no_show', 'accepted', 'onboarded')
       AND NOT EXISTS (
             SELECT 1 FROM offers o
              WHERE o.applicant_id = cd.applicant_id
                AND (o.state = 'accepted' OR (o.state = 'pending' AND o.expires_at > now())))
     ORDER BY cd.waitlist_rank NULLS LAST, cd.applicant_id
     LIMIT v_free
  LOOP
    PERFORM fn_issue_offer(v_candidate.applicant_id, p_department_id);
    v_issued := v_issued + 1;
  END LOOP;

  -- FR-OFF-005: an exhausted waitlist means the department closes under capacity, and someone
  -- must be told rather than it being discovered later.
  IF v_issued < v_free THEN
    PERFORM fn_audit(v_dept.cycle_id, 'offer.waitlist_exhausted', 'department', p_department_id,
      NULL, jsonb_build_object('unfilled_seats', v_free - v_issued),
      'waitlist exhausted — department closes under capacity');
  END IF;

  RETURN v_issued;
END $$;


-- Expire overdue offers and cascade. Scheduled hourly (FR-OFF-003).
CREATE OR REPLACE FUNCTION fn_expire_offers(p_cycle_id uuid)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_expired int := 0;
  v_row     record;
BEGIN
  FOR v_row IN
    SELECT id, applicant_id, department_id FROM offers
     WHERE cycle_id = p_cycle_id AND state = 'pending' AND expires_at <= now()
  LOOP
    UPDATE offers SET state = 'lapsed', responded_at = now() WHERE id = v_row.id;

    PERFORM set_config('app.state_writer', 'fn_apply_decision', true);
    UPDATE applicants SET state = 'lapsed' WHERE id = v_row.applicant_id;
    PERFORM set_config('app.state_writer', '', true);

    PERFORM fn_audit(p_cycle_id, 'offer.lapsed', 'offer', v_row.id,
      jsonb_build_object('state', 'pending'), jsonb_build_object('state', 'lapsed'),
      'no response before expiry');

    PERFORM fn_cascade_department(v_row.department_id);
    v_expired := v_expired + 1;
  END LOOP;

  RETURN v_expired;
END $$;


-- FR-OFF-002, retimed: a reminder at T−6h. The spec's T−48h cannot exist against a 24-hour
-- expiry — it would have to fire before the offer was sent.
CREATE OR REPLACE FUNCTION fn_offers_needing_reminder(p_cycle_id uuid)
RETURNS TABLE (offer_id uuid, applicant_id uuid, display_id text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id, o.applicant_id, a.display_id, o.expires_at
    FROM offers o
    JOIN applicants a ON a.id = o.applicant_id
    JOIN cycles c ON c.id = o.cycle_id
   WHERE o.cycle_id = p_cycle_id
     AND o.state = 'pending'
     AND o.reminder_sent_at IS NULL
     AND o.expires_at <= now()
        + make_interval(hours => coalesce((c.config ->> 'offer_reminder_hours_before')::int, 6))
$$;

GRANT EXECUTE ON FUNCTION fn_offers_needing_reminder(uuid) TO rms_app;


ALTER TABLE offers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY offer_self_select ON offers FOR SELECT
  USING (applicant_id = fn_current_applicant_id());

CREATE POLICY offer_privileged ON offers FOR SELECT
  USING (fn_has_capability(cycle_id, 'aggregates.view'));

CREATE POLICY snapshot_privileged ON result_snapshots FOR SELECT
  USING (fn_has_capability(cycle_id, 'aggregates.view'));

COMMIT;
