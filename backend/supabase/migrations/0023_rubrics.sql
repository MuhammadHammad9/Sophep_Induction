-- 0023 — Rubrics, criteria and anchors
--
-- Two constraints here do most of the fairness work, and both are enforced by the DATABASE
-- rather than by review, because "fairness is enforced by the schema, not by policy"
-- (principle 5).
--
-- WEIGHTS MUST SUM TO EXACTLY 100 (FR-INT-005). A rubric whose weights sum to 97 silently
-- rescales every score computed from it, and nobody notices until someone recomputes a result
-- by hand during a dispute.
--
-- ANCHORS ARE MANDATORY (FR-INT-006). An unanchored 1–5 scale means five different things to
-- five different people: one interviewer's 3 is another's 5. No statistical correction fully
-- recovers from that — shrinkage removes a consistent bias, but it cannot repair a criterion
-- that was never measuring the same thing twice. Written anchors are the cheapest fairness
-- intervention available, which is why they are a constraint and not a guideline.
--
-- Refs: FR-INT-005, FR-INT-006, FR-INT-007, NFR-MAIN-001, E17

BEGIN;

-- Versioned per cycle, optionally overridden per department. A rubric is never edited in
-- place once used: FR-INT-007 pins a version at interview START, and mutating a live rubric
-- would retroactively change what a submitted score meant.
CREATE TABLE rubrics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id      uuid NOT NULL REFERENCES cycles(id),
  department_id uuid REFERENCES departments(id),   -- NULL = the cycle default
  version       int  NOT NULL DEFAULT 1,
  name          text NOT NULL,
  scale_min     smallint NOT NULL DEFAULT 1,
  scale_max     smallint NOT NULL DEFAULT 5,

  -- A rubric is editable only while draft. Publishing freezes it.
  published_at  timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (cycle_id, department_id, version),
  CHECK (scale_max > scale_min)
);

CREATE INDEX idx_rubrics_cycle ON rubrics (cycle_id, department_id, version DESC);

CREATE TABLE rubric_criteria (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric_id   uuid NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  description text,

  -- FR-INT-005: the sum across a rubric must be exactly 100, checked on publish.
  weight      smallint NOT NULL CHECK (weight > 0 AND weight <= 100),
  sort_order  smallint NOT NULL DEFAULT 0,

  -- FR-INT-006: anchors for AT LEAST the minimum and maximum scale values. Enforced as NOT
  -- NULL so a criterion cannot exist without them — "reject on save" in application code is
  -- a rule someone eventually routes around.
  anchor_min  text NOT NULL CHECK (length(btrim(anchor_min)) >= 10),
  anchor_max  text NOT NULL CHECK (length(btrim(anchor_max)) >= 10),
  -- Intermediate anchors are optional but strongly encouraged: {"3": "..."}.
  anchors     jsonb NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (rubric_id, code)
);

CREATE INDEX idx_criteria_rubric ON rubric_criteria (rubric_id, sort_order);

COMMENT ON COLUMN rubric_criteria.anchor_min IS
  'Mandatory. An unanchored scale means five different things to five people, and no statistical correction recovers from that. FR-INT-006';


-- ── Publishing gate ─────────────────────────────────────────────────────────────────────
-- The weight check happens HERE rather than as a table constraint because weights are
-- necessarily invalid while a rubric is being built — a single criterion at weight 40 is a
-- work in progress, not a defect.
CREATE OR REPLACE FUNCTION fn_publish_rubric(p_rubric_id uuid)
RETURNS rubrics
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rubric rubrics;
  v_total  int;
  v_count  int;
BEGIN
  SELECT * INTO v_rubric FROM rubrics WHERE id = p_rubric_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rubric % not found', p_rubric_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_rubric.published_at IS NOT NULL THEN
    RETURN v_rubric;   -- idempotent
  END IF;

  SELECT coalesce(sum(weight), 0), count(*) INTO v_total, v_count
    FROM rubric_criteria WHERE rubric_id = p_rubric_id;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'a rubric must have at least one criterion' USING ERRCODE = 'raise_exception';
  END IF;

  -- FR-INT-005.
  IF v_total <> 100 THEN
    RAISE EXCEPTION 'criterion weights must sum to exactly 100, got %', v_total
      USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE rubrics SET published_at = now() WHERE id = p_rubric_id RETURNING * INTO v_rubric;

  PERFORM fn_audit(
    v_rubric.cycle_id, 'rubric.published', 'rubric', p_rubric_id,
    NULL, jsonb_build_object('version', v_rubric.version, 'criteria', v_count), NULL
  );

  RETURN v_rubric;
END $$;


-- Prevent editing a published rubric. E17: a rubric edited mid-session splits one panel
-- across two scales, and the scores are then not comparable — silently.
CREATE OR REPLACE FUNCTION fn_guard_published_rubric() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_published timestamptz;
BEGIN
  SELECT published_at INTO v_published
    FROM rubrics WHERE id = coalesce(NEW.rubric_id, OLD.rubric_id);

  IF v_published IS NOT NULL THEN
    RAISE EXCEPTION
      'rubric % is published and cannot be edited — create a new version (FR-INT-007, E17)',
      coalesce(NEW.rubric_id, OLD.rubric_id)
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER trg_criteria_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON rubric_criteria
  FOR EACH ROW EXECUTE FUNCTION fn_guard_published_rubric();


-- ── Resolve the rubric in force ─────────────────────────────────────────────────────────
-- Department override first, cycle default second, highest published version of each.
CREATE OR REPLACE FUNCTION fn_active_rubric(p_cycle_id uuid, p_department_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id
    FROM rubrics r
   WHERE r.cycle_id = p_cycle_id
     AND r.published_at IS NOT NULL
     AND (r.department_id = p_department_id OR r.department_id IS NULL)
   ORDER BY (r.department_id IS NOT NULL) DESC, r.version DESC
   LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION fn_active_rubric(uuid, uuid) TO rms_app;


ALTER TABLE rubrics         ENABLE ROW LEVEL SECURITY;
ALTER TABLE rubric_criteria ENABLE ROW LEVEL SECURITY;

-- Interviewers must read the rubric and its anchors — the anchors are shown INLINE beside
-- each criterion so nobody has to remember what a 3 means (spec §19.3).
CREATE POLICY rubric_staff_select ON rubrics FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM memberships m
             WHERE m.cycle_id = rubrics.cycle_id
               AND m.user_id = fn_current_user_id()
               AND m.revoked_at IS NULL)
  );

CREATE POLICY rubric_manage ON rubrics FOR ALL
  USING (fn_has_capability(cycle_id, 'departments.manage'))
  WITH CHECK (fn_has_capability(cycle_id, 'departments.manage'));

CREATE POLICY criteria_staff_select ON rubric_criteria FOR SELECT
  USING (EXISTS (SELECT 1 FROM rubrics r
                  WHERE r.id = rubric_criteria.rubric_id
                    AND EXISTS (SELECT 1 FROM memberships m
                                 WHERE m.cycle_id = r.cycle_id
                                   AND m.user_id = fn_current_user_id()
                                   AND m.revoked_at IS NULL)));

CREATE POLICY criteria_manage ON rubric_criteria FOR ALL
  USING (EXISTS (SELECT 1 FROM rubrics r
                  WHERE r.id = rubric_criteria.rubric_id
                    AND fn_has_capability(r.cycle_id, 'departments.manage')))
  WITH CHECK (EXISTS (SELECT 1 FROM rubrics r
                       WHERE r.id = rubric_criteria.rubric_id
                         AND fn_has_capability(r.cycle_id, 'departments.manage')));

COMMIT;
