-- 0003 — Core configuration tables
--
-- Everything except societies and users carries cycle_id (DR-001, rules.md R-010). A table
-- without it can never be scoped, archived, or made multi-tenant, and adding it later is a
-- destructive migration.
--
-- Refs: FR-CYC-001..013, FR-RBAC-002, DR-001, DR-002, DR-004, NFR-SCAL-005

BEGIN;

CREATE TABLE societies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{3}$'),  -- 'SPH'
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE societies IS
  'Tenant root. NFR-SCAL-005: multi-society tenancy is not implemented but the model accommodates it without destructive migration.';


-- Staff accounts. The ONLY entity besides societies that is not cycle-scoped: a person
-- persists across cycles even though their role does not (FR-CYC-002, FR-RBAC-002).
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  full_name     text NOT NULL,
  auth_user_id  uuid UNIQUE,          -- Supabase auth.users.id
  totp_enabled  boolean NOT NULL DEFAULT false,
  totp_secret_enc bytea,              -- app-layer encrypted, KMS key (NFR-SEC-002)
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);


CREATE TABLE cycles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id          uuid NOT NULL REFERENCES societies(id),
  season              char(2) NOT NULL CHECK (season IN ('SP', 'FA', 'SU')),
  year                smallint NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  name                text NOT NULL,
  state               cycle_state NOT NULL DEFAULT 'draft',

  -- Per-cycle sequence counter. Incremented IN-TRANSACTION (migration 0008).
  -- SELECT MAX(sequence)+1 is forbidden — two desks registering simultaneously WILL
  -- produce duplicate IDs (FR-IDT-003, rules.md R-020).
  applicant_seq       int NOT NULL DEFAULT 0,

  -- E14: every "10:00" in a spec is ambiguous without this. Instants are stored as
  -- timestamptz and RENDERED in this zone. Local wall-clock strings are never persisted.
  timezone            text NOT NULL DEFAULT 'Asia/Karachi',

  -- Ed25519, per cycle (FR-IDT-011). A token from a previous cycle fails verification
  -- against the current one. The PRIVATE key is app-layer encrypted and NEVER transmitted
  -- to any client device (E1, FR-IDT-007, NFR-SEC-003, rules.md R-021).
  -- Populated in Phase 2; nullable until then.
  qr_public_key       bytea,
  qr_private_key_enc  bytea,

  -- Everything tunable lives here so a new cycle never needs a deployment
  -- (NFR-MAIN-001, rules.md R-050). Defaults in migration 0009.
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Dual control (FR-DEC-010). The CHECK makes "one person locked and confirmed"
  -- unrepresentable rather than merely discouraged.
  locked_by           uuid REFERENCES users(id),
  lock_confirmed_by   uuid REFERENCES users(id),
  locked_at           timestamptz,
  published_at        timestamptz,
  archived_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (society_id, season, year),
  CONSTRAINT dual_control_distinct
    CHECK (lock_confirmed_by IS NULL OR lock_confirmed_by <> locked_by)
);

CREATE INDEX idx_cycles_society_state ON cycles (society_id, state);

COMMENT ON COLUMN cycles.applicant_seq IS
  'In-transaction counter. NEVER SELECT MAX()+1 — FR-IDT-003, rules.md R-020';
COMMENT ON CONSTRAINT dual_control_distinct ON cycles IS
  'FR-DEC-010: a single account cannot complete both lock steps.';


-- Role assignment is scoped to a cycle. A user may hold SEVERAL roles in one cycle —
-- a Coordinator who also interviews is normal — and capabilities are the UNION across
-- them (E13, FR-RBAC-003). v1's gate assumed exactly one role and silently denied the second.
CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id    uuid NOT NULL REFERENCES cycles(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        role_name NOT NULL,
  granted_by  uuid REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  UNIQUE (cycle_id, user_id, role)
);

CREATE INDEX idx_memberships_lookup ON memberships (user_id, cycle_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE memberships IS
  'Several roles per user per cycle permitted. Capabilities are the UNION across roles — E13, FR-RBAC-003';


CREATE TABLE stages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id    uuid NOT NULL REFERENCES cycles(id),
  kind        stage_kind NOT NULL,
  name        text NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  closed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX idx_stages_cycle ON stages (cycle_id, kind, starts_at);


CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id    uuid NOT NULL REFERENCES cycles(id),
  code        text NOT NULL,
  name        text NOT NULL,
  description text,
  -- FR-DEC-003 blocks allocation entirely if an active department has no capacity.
  -- Nullable here so a cycle can be drafted before capacities are agreed.
  capacity    smallint CHECK (capacity IS NULL OR capacity >= 0),
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, code)
);

COMMENT ON COLUMN departments.capacity IS
  'FR-DEC-003: allocation refuses to run while any active department lacks a capacity.';


-- A queue lane. Usually one per department, or a single shared 'general' track.
-- Locked decision: ONE GENERAL INTERVIEW, so the default configuration is a single
-- 'general' track and department fit is a rubric criterion instead.
CREATE TABLE tracks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id    uuid NOT NULL REFERENCES cycles(id),
  code        text NOT NULL,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, code)
);


-- A Room is a PLACE. A Panel is a SESSION — the interviewers occupying a room for a shift,
-- and the thing that pulls from the queue. Conflating them corrupts throughput statistics
-- and the audit trail on every rotation. Panels arrive in Phase 3.
CREATE TABLE rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id    uuid NOT NULL REFERENCES cycles(id),
  code        text NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, code)
);

COMMIT;
