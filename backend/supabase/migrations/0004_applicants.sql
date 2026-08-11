-- 0004 — Applicants, preferences and access tokens
--
-- Fixes errata E4. v1's prose said a duplicate could be overridden with a written reason, and
-- v1's schema then declared a plain UNIQUE index on (cycle_id, email_norm). The override INSERT
-- would fail on a constraint violation. Prose and schema directly contradicted each other, and
-- the flow diagram documented a branch the database forbade.
--
-- The fix is a PARTIAL unique index that excludes deliberately-overridden rows. The constraint
-- still catches accidents; a reasoned, audited override now actually works.
--
-- Refs: FR-IDT-001..006, FR-REG-001..011, DR-005, E4, E6

BEGIN;

CREATE TABLE applicants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id          uuid NOT NULL REFERENCES cycles(id),

  -- SPH-SP26-0042 — speakable across a noisy hall, sortable, never reused (FR-IDT-001/002).
  display_id        text NOT NULL,
  sequence          int  NOT NULL,

  -- PROJECTION ONLY. Never written by application code — only by the owning transition
  -- functions, in the same transaction as the owning row (E5, FR-OPS-002, rules.md R-012).
  -- Enforced by trigger in migration 0008, not merely by convention.
  state             applicant_state NOT NULL DEFAULT 'draft',

  full_name         text NOT NULL CHECK (length(btrim(full_name)) >= 2),
  email             text NOT NULL,
  phone             text NOT NULL,
  roll_number       text,

  -- Generated from the IMMUTABLE functions in 0001. v1 declared these but they were no-ops (E6).
  email_norm        text GENERATED ALWAYS AS (norm_email(email)) STORED,
  phone_norm        text GENERATED ALWAYS AS (norm_phone(phone)) STORED,
  roll_norm         text GENERATED ALWAYS AS (norm_roll(roll_number)) STORED,

  source            registration_channel NOT NULL,

  -- E4: set when a volunteer deliberately overrides a hard block. Presence of this value
  -- removes the row from the partial unique indexes below, which is what makes the documented
  -- override branch possible at all. FR-REG-008 requires >= 10 characters.
  dedupe_override_reason text CHECK (
    dedupe_override_reason IS NULL OR length(btrim(dedupe_override_reason)) >= 10
  ),
  dedupe_override_by     uuid REFERENCES users(id),

  -- FR-CHK-010: register-and-check-in in under 30 seconds leaves a partial record behind
  -- on purpose. Speed at the desk matters more than completeness; this flags the follow-up.
  needs_completion  boolean NOT NULL DEFAULT false,

  answers           jsonb NOT NULL DEFAULT '{}'::jsonb,
  cv_object_key     text,

  -- Post-check-in edit lock applies to SUBSTANTIVE fields (answers, preferences, CV).
  -- Contact fields stay editable by Admin — you will need to fix a mistyped email to
  -- deliver a result (spec 5.1).
  answers_locked_at timestamptz,

  submitted_at      timestamptz,
  screened_at       timestamptz,
  screened_by       uuid REFERENCES users(id),
  withdrawn_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (cycle_id, display_id),
  UNIQUE (cycle_id, sequence),
  CONSTRAINT override_needs_reason
    CHECK (dedupe_override_by IS NULL OR dedupe_override_reason IS NOT NULL)
);

-- E4 + DR-005. Partial on two axes:
--   1. state NOT IN (withdrawn, screened_out) — a withdrawn applicant should not block a
--      genuine re-registration by the same person.
--   2. dedupe_override_reason IS NULL — a deliberate, reasoned, audited override succeeds.
-- A constraint that makes FR-REG-007 unsatisfiable is a defect (FR-REG-009).
CREATE UNIQUE INDEX uq_applicant_email ON applicants (cycle_id, email_norm)
  WHERE state NOT IN ('withdrawn', 'screened_out') AND dedupe_override_reason IS NULL;

CREATE UNIQUE INDEX uq_applicant_phone ON applicants (cycle_id, phone_norm)
  WHERE state NOT IN ('withdrawn', 'screened_out') AND dedupe_override_reason IS NULL;

CREATE UNIQUE INDEX uq_applicant_roll ON applicants (cycle_id, roll_norm)
  WHERE roll_norm IS NOT NULL
    AND state NOT IN ('withdrawn', 'screened_out')
    AND dedupe_override_reason IS NULL;

-- FR-REG-010: trigram name similarity >= 0.85 raises a dismissible warning, never a block.
CREATE INDEX idx_applicant_name_trgm ON applicants USING gin (full_name gin_trgm_ops);

-- FR-CHK-009: manual search on any 4 consecutive digits of the ID, last 4 of the phone,
-- or partial name. Supports the volunteer whose camera has failed.
CREATE INDEX idx_applicant_display_id_trgm ON applicants USING gin (display_id gin_trgm_ops);
CREATE INDEX idx_applicant_cycle_state ON applicants (cycle_id, state);

COMMENT ON COLUMN applicants.state IS
  'PROJECTION. Written only by fn_application_transition / fn_check_in / fn_queue_transition / fn_interview_transition / fn_apply_decision. E5, FR-OPS-002, rules.md R-012';
COMMENT ON INDEX uq_applicant_email IS
  'PARTIAL by design — excludes overridden and withdrawn rows so the documented override branch works. E4, FR-REG-009';


-- Ranked department preferences. Locked decision: up to 3 (FR-REG-011, cycle-configurable).
CREATE TABLE applicant_preferences (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id      uuid NOT NULL REFERENCES cycles(id),
  applicant_id  uuid NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id),
  rank          smallint NOT NULL CHECK (rank >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Both constraints matter: you cannot rank the same department twice, and you cannot
  -- place two departments at the same rank. Allocation requires a total order over
  -- preferences (FR-DEC-005) and an ambiguous ranking would make it non-deterministic.
  UNIQUE (applicant_id, department_id),
  UNIQUE (applicant_id, rank)
);

CREATE INDEX idx_preferences_applicant ON applicant_preferences (applicant_id, rank);
CREATE INDEX idx_preferences_department ON applicant_preferences (department_id, rank);


-- FR-IDT-005/006: exactly one active token per applicant, >= 128 bits of entropy,
-- stored ONLY as sha256. The raw token is never persisted anywhere — not the database,
-- not logs, not backups (rules.md R-022, NFR-SEC-004).
CREATE TABLE access_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id      uuid NOT NULL REFERENCES cycles(id),
  applicant_id  uuid NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_reason text,
  expires_at    timestamptz NOT NULL
);

-- FR-IDT-009: rotation revokes the previous token immediately and atomically. This partial
-- unique index is what makes "exactly one active token" true rather than aspirational.
CREATE UNIQUE INDEX uq_active_token ON access_tokens (applicant_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_token_hash_lookup ON access_tokens (token_hash) WHERE revoked_at IS NULL;

COMMENT ON COLUMN access_tokens.token_hash IS
  'sha256(token). The raw token is NEVER stored. A database leak yields no working QR codes. FR-IDT-006, rules.md R-022';

COMMIT;
