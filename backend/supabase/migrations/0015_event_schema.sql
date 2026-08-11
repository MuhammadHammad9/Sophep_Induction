-- 0015 — Event-day schema: check-ins, panels, queue entries, recusals, interviews
--
-- Two structural decisions here carry most of the weight:
--
-- ROOM ≠ PANEL ≠ INTERVIEWER. A Room is a place. A Panel is a SESSION — the interviewers
-- occupying a room for a shift, and the thing that pulls from the queue. An Interviewer sits
-- on many panels across a cycle. Collapsing these corrupts throughput statistics and the audit
-- trail on every rotation, and it is not recoverable after the fact.
--
-- queue_entries.state is AUTHORITATIVE for event-day state; applicants.state is a projection
-- of it (E5, rules.md R-012). v1 had both authoritative and they would drift — first symptom
-- being an applicant whose phone says "Position 4" while the panel screen says they are
-- mid-interview, during the event, in front of them.
--
-- Refs: FR-CHK-007, FR-INT-001, FR-INT-002, FR-QUE-001..020, DR-001, DR-009, E5, E10

BEGIN;

-- ── Panel state (E10) ───────────────────────────────────────────────────────────────────
-- v1's panel states were closed|open|busy|break, with no way to represent "cannot call next
-- until evaluations are in". An unrepresentable state is one the UI has to guess at, so
-- awaiting_evaluations is a real state here.
CREATE TYPE panel_status AS ENUM (
  'closed',
  'open',
  'busy',
  'awaiting_evaluations',
  'break'
);

CREATE TYPE queue_state AS ENUM (
  'waiting',
  'called',
  'in_interview',
  'done',
  'skipped',
  'parked',
  'withdrawn'
);

CREATE TYPE interview_status AS ENUM (
  'in_progress',
  'awaiting_evaluations',
  'complete',
  'abandoned',
  'flagged',
  'voided'
);


-- ── Check-ins ───────────────────────────────────────────────────────────────────────────
-- Owner of the "checked in for a stage" fact (§4). applicants.state is projected from it.
CREATE TABLE check_ins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id      uuid NOT NULL REFERENCES cycles(id),
  applicant_id  uuid NOT NULL REFERENCES applicants(id),
  stage_id      uuid NOT NULL REFERENCES stages(id),

  method        text NOT NULL CHECK (method IN ('qr', 'manual_search', 'register_and_checkin', 'bulk_reconcile')),
  checked_in_by uuid REFERENCES users(id),

  -- FR-CHK-016: SERVER timestamps are authoritative for all business logic. The client
  -- timestamp is persisted separately and used ONLY to order offline replay — a device with
  -- a skewed clock must not be able to reorder the queue.
  created_at    timestamptz NOT NULL DEFAULT now(),
  client_ts     timestamptz,
  client_request_id uuid,

  -- FR-CHK-007: at most one check-in per applicant per stage, enforced by the database.
  UNIQUE (applicant_id, stage_id)
);

CREATE INDEX idx_checkins_stage ON check_ins (stage_id, created_at DESC);

COMMENT ON TABLE check_ins IS
  'Owner of the checked-in fact. Server timestamp authoritative; client_ts is for replay ordering only. FR-CHK-016';


-- ── Panels ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE panels (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       uuid NOT NULL REFERENCES cycles(id),
  room_id        uuid NOT NULL REFERENCES rooms(id),
  name           text NOT NULL,
  status         panel_status NOT NULL DEFAULT 'closed',
  opened_at      timestamptz,
  closed_at      timestamptz,

  -- FR-INT-014/015: heartbeat every 30s while open/busy/awaiting_evaluations; 90 minutes of
  -- silence flags the interview. A panel device dying mid-interview otherwise leaves an
  -- applicant stuck forever with nobody noticing.
  last_heartbeat timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_panels_cycle_status ON panels (cycle_id, status);
CREATE INDEX idx_panels_heartbeat ON panels (last_heartbeat)
  WHERE status IN ('open', 'busy', 'awaiting_evaluations');

-- Locked decision: panel size 2, both interviewers evaluate.
CREATE TABLE panel_members (
  panel_id       uuid NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  interviewer_id uuid NOT NULL REFERENCES users(id),
  joined_at      timestamptz NOT NULL DEFAULT now(),
  left_at        timestamptz,
  PRIMARY KEY (panel_id, interviewer_id)
);

-- Which queue lanes a panel serves. Locked decision is ONE general track, but the model
-- supports per-department tracks without migration.
CREATE TABLE panel_tracks (
  panel_id uuid NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  track_id uuid NOT NULL REFERENCES tracks(id),
  PRIMARY KEY (panel_id, track_id)
);


-- ── Recusals ────────────────────────────────────────────────────────────────────────────
-- Student societies are small; an interviewer will meet their roommate. Declared freely,
-- honoured by the claim query, permanently recorded (FR-INT-017).
CREATE TABLE recusals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       uuid NOT NULL REFERENCES cycles(id),
  applicant_id   uuid NOT NULL REFERENCES applicants(id),
  interviewer_id uuid NOT NULL REFERENCES users(id),
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, interviewer_id)
);

-- Supports the NOT EXISTS correlation in the claim query.
CREATE INDEX idx_recusals_lookup ON recusals (applicant_id, interviewer_id);

COMMENT ON TABLE recusals IS
  'Honoured by fn_claim_next via NOT EXISTS. NOT IN would return zero rows on a single NULL — a total silent queue stall (E7, rules.md R-013).';


-- ── Queue entries — AUTHORITATIVE event-day state ───────────────────────────────────────
CREATE TABLE queue_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id        uuid NOT NULL REFERENCES cycles(id),
  applicant_id    uuid NOT NULL REFERENCES applicants(id),
  track_id        uuid NOT NULL REFERENCES tracks(id),
  stage_id        uuid NOT NULL REFERENCES stages(id),

  -- Schema already supports a second interview round (OI-5 default: not required). The UI
  -- does not exist; the column means adding it later is not a migration.
  round           smallint NOT NULL DEFAULT 1,

  state           queue_state NOT NULL DEFAULT 'waiting',

  -- FR-QUE-003/004. Priority is DATA, not code — a floor manager will need to bump someone,
  -- and a system that forbids it is a system they stop using.
  --   100 accessibility / medical need, or an interview voided through no fault of theirs
  --    50 slot holder, arrived in window (granted by the Host team on request — no public booking)
  --    30 returning after a skip: a second chance ahead of new walk-ins
  --    10 standard
  --     5 late for a granted slot
  priority        smallint NOT NULL DEFAULT 10,
  priority_reason text,

  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  panel_id        uuid REFERENCES panels(id),
  called_at       timestamptz,

  -- FR-QUE-009: one "I'm on my way" extension per call, exactly once.
  grace_extended  boolean NOT NULL DEFAULT false,
  call_count      smallint NOT NULL DEFAULT 0,
  done_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (applicant_id, track_id, round),

  -- Any non-standard priority must carry a reason, so the audit log can answer "why was this
  -- person moved up" without anyone having to remember.
  CONSTRAINT priority_needs_reason
    CHECK (priority_reason IS NOT NULL OR priority IN (5, 10, 30, 50))
);

-- DR-009. The partial index is the claim path: only waiting entries, ordered exactly as the
-- claim orders them, so the plan is an index scan rather than a sort over the whole queue.
-- NFR-SCAL-003 requires claim latency not to degrade more than 20% from 50 to 1,000 entries.
CREATE INDEX idx_queue_claim ON queue_entries (cycle_id, track_id, priority DESC, enqueued_at ASC)
  WHERE state = 'waiting';

CREATE INDEX idx_queue_applicant ON queue_entries (applicant_id, state);
CREATE INDEX idx_queue_panel ON queue_entries (panel_id) WHERE state IN ('called', 'in_interview');
-- FR-QUE-013: when waiting is empty but parked is not, panels must see the parked count and
-- volunteers must be sent to find those people — otherwise panels idle while applicants sit
-- fifteen metres away.
CREATE INDEX idx_queue_parked ON queue_entries (cycle_id, track_id) WHERE state = 'parked';

COMMENT ON TABLE queue_entries IS
  'AUTHORITATIVE event-day state. applicants.state is projected from this by fn_queue_transition. E5, rules.md R-012';


-- ── Interviews ──────────────────────────────────────────────────────────────────────────
CREATE TABLE interviews (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       uuid NOT NULL REFERENCES cycles(id),
  applicant_id   uuid NOT NULL REFERENCES applicants(id),
  panel_id       uuid NOT NULL REFERENCES panels(id),
  queue_entry_id uuid NOT NULL REFERENCES queue_entries(id),

  status         interview_status NOT NULL DEFAULT 'in_progress',

  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,

  -- FR-INT-007 / E17: the rubric version is pinned at interview START, not at submission.
  -- An edit mid-session would otherwise split one panel across two scales.
  rubric_id      uuid,

  voided_by      uuid REFERENCES users(id),
  void_reason    text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT void_needs_reason CHECK (voided_by IS NULL OR void_reason IS NOT NULL)
);

CREATE INDEX idx_interviews_cycle_status ON interviews (cycle_id, status);
CREATE INDEX idx_interviews_panel ON interviews (panel_id, started_at DESC);


-- ── Service-time observations, for wait estimation ──────────────────────────────────────
-- FR-QUE-015. Kept as raw observations rather than only a running EWMA so the estimate can be
-- recomputed if the smoothing constants change — and they will, because the committee chose a
-- 10–30 minute interview and the spec's constants were tuned for a fixed 12.
CREATE TABLE service_observations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id     uuid NOT NULL REFERENCES cycles(id),
  track_id     uuid NOT NULL REFERENCES tracks(id),
  panel_id     uuid NOT NULL REFERENCES panels(id),
  duration_seconds int NOT NULL CHECK (duration_seconds > 0),
  observed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_service_obs ON service_observations (cycle_id, track_id, observed_at DESC);

COMMIT;
