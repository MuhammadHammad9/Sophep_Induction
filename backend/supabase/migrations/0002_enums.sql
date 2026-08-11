-- 0002 — Enumerated types
--
-- DR-003: enumerated states are enforced by database type, not by application convention.
-- An application-level enum is a suggestion; a database type is a guarantee.
--
-- Refs: FR-CYC-003, FR-RBAC-001, DR-003

BEGIN;

-- Cycle lifecycle. Acts as a GLOBAL GATE checked by every write endpoint (FR-CYC-004).
CREATE TYPE cycle_state AS ENUM (
  'draft',
  'registration_open',
  'registration_closed',
  'interviews_active',
  'interviews_closed',
  'under_review',
  'results_locked',
  'published',
  'archived'
);

-- Applicant state. PROJECTION ONLY — see rules.md R-012 and migration 0008.
-- Written exclusively by the owning transition functions, never by application code.
CREATE TYPE applicant_state AS ENUM (
  -- Pre-event (owner: fn_application_transition)
  'draft',
  'submitted',
  'eligible',
  'screened_out',
  -- Event day (owner: fn_check_in, fn_queue_transition — Phase 2)
  'checked_in',
  'queued',
  'called',
  'in_interview',
  'skipped',
  'parked',
  'no_show',
  -- Post-interview (owner: fn_interview_transition — Phase 3)
  'interview_complete',
  'under_review',
  -- Outcome (owner: fn_apply_decision — Phase 4)
  'selected',
  'waitlisted',
  'rejected',
  'offer_pending',
  'accepted',
  'declined',
  'lapsed',
  'onboarded',
  -- Terminal, reachable at any point pre-decision
  'withdrawn'
);

-- Six roles (FR-RBAC-001). A user may hold SEVERAL of these in one cycle; effective
-- capabilities are the UNION across them (E13, FR-RBAC-003) — never a single-role lookup.
CREATE TYPE role_name AS ENUM (
  'super_admin',
  'coordinator',
  'admin',
  'volunteer',
  'interviewer',
  'auditor'
);

-- Registration channel. All three produce an IDENTICAL record structure — paper is an input
-- method, not a separate pipeline (FR-REG-002). No channel produces a second-class record.
CREATE TYPE registration_channel AS ENUM (
  'online',
  'walkin_digital',
  'walkin_paper'
);

CREATE TYPE stage_kind AS ENUM (
  'registration',
  'interview',
  'review',
  'decision'
);

-- Delivery state driven by provider webhooks (FR-NOT-002). While email is mocked, records
-- stop at 'queued' and are rendered at the local preview route.
CREATE TYPE notification_state AS ENUM (
  'pending',
  'queued',
  'delivered',
  'bounced',
  'complained',
  'failed'
);

COMMIT;
