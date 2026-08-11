-- 0009 — Cycle configuration defaults
--
-- NFR-MAIN-001 / rules.md R-050: everything tunable is DATA. A new cycle never requires a
-- deployment, and a Coordinator can retune a wait estimate at 11:00 on the day without an
-- engineer — who will have graduated (CON-001).
--
-- Several defaults here deliberately DIFFER from the specification, because the committee
-- chose a variable 10–30 minute interview and a 1-day offer expiry. Each divergence is
-- annotated with what the spec said and why it could not simply be kept.

BEGIN;

CREATE OR REPLACE FUNCTION fn_default_cycle_config() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    -- ── Registration ────────────────────────────────────────────────────────────────────
    'max_preferences',            3,        -- FR-REG-011, OI-3
    'cv_max_mb',                  10,       -- FR-REG-015
    'cv_allowed_types',           jsonb_build_array('pdf', 'docx', 'png', 'jpg'),
    'name_similarity_threshold',  0.85,     -- FR-REG-010, soft warning only
    'dedupe_override_min_chars',  10,       -- FR-REG-008

    -- Slot booking is DISABLED. Committee decision: no public booking. The Host team may
    -- still grant an arrival slot on request, which surfaces as queue priority 50 with a
    -- mandatory reason rather than as a self-service form (spec §6.3 recommended booking;
    -- this overrides it).
    'slot_booking_enabled',       false,

    -- ── Interview ───────────────────────────────────────────────────────────────────────
    'panel_size',                 2,        -- OI-1
    'interview_target_minutes',   20,       -- midpoint of the agreed 10–30 range
    'interview_min_minutes',      10,
    'interview_max_minutes',      30,

    -- ── Queue and wait estimation (Phase 2) ─────────────────────────────────────────────
    -- Spec §8.4 seeds the EWMA at 12 minutes with smoothing 0.3, tuned for a FIXED 12-minute
    -- interview. With a 10–30 minute spread those values produce estimates that visibly jump,
    -- and FR-QUE-017 REQUIRES every upward revision to be shown with its cause — so a jumpy
    -- estimate is not merely ugly, it is a stream of alarming notifications to someone already
    -- anxious. Slower smoothing and a wider band are the honest response to real variance.
    'grace_window_minutes',       5,        -- FR-QUE-008
    'grace_extension_minutes',    2,        -- FR-QUE-009, once only
    'service_ewma_seed_minutes',  20,       -- spec: 12
    'service_ewma_alpha',         0.2,      -- spec: 0.3
    'eta_range_lower_pct',        0.70,     -- −30%
    'eta_range_upper_pct',        1.50,     -- +50%
    'eta_suppress_first_minutes', 15,       -- FR-QUE-018
    'eta_suppress_below_position', 3,       -- FR-QUE-019 → "You're next"

    -- ── Evaluation (Phase 3) ────────────────────────────────────────────────────────────
    'evaluation_revision_window_minutes', 15,   -- FR-INT-009
    'heartbeat_interval_seconds',         30,   -- FR-INT-014
    'heartbeat_silence_minutes',          90,   -- FR-INT-015 → flagged
    'waiver_authority',                   'coordinator',  -- OI-10, audited

    -- ── Scoring (Phase 4) ───────────────────────────────────────────────────────────────
    'shrinkage_k',                5,        -- FR-SCR-002: w = n/(n+k)
    'disagreement_threshold',     20,       -- FR-SCR-007
    'criterion_floor_value',      2,        -- FR-SCR-008
    'low_confidence_n',           5,        -- FR-SCR-009
    'band_clear_multiplier',      0.75,     -- FR-SCR-011, relative to capacity
    'band_discuss_multiplier',    2.0,

    -- ── Offers (Phase 4) ────────────────────────────────────────────────────────────────
    -- Spec default is a 5-day expiry with a reminder 48h before. The committee chose 1 day,
    -- which makes a 48-hour reminder arithmetically impossible — it would fire before the
    -- offer was sent. Reminder moved to T−6h.
    --
    -- The short expiry also forces the cascade cadence: at 5 days a daily sweep is fine, but
    -- at 1 day a released seat would sit idle past the point anyone could still accept it.
    'offer_expiry_hours',         24,       -- spec: 120
    'offer_reminder_hours_before', 6,       -- spec: 48
    'cascade_interval_minutes',   60,       -- spec: daily

    -- ── Capacity model ──────────────────────────────────────────────────────────────────
    -- Reports a RANGE from min/max duration, not a single number. With a 3x spread, a point
    -- estimate would be a fiction, and planning against the optimistic end is exactly how an
    -- induction day runs three hours late.
    'capacity_utilisation',       0.80,     -- covers changeovers, no-shows, breaks, overruns

    -- ── Retention ───────────────────────────────────────────────────────────────────────
    'pii_retention_cycles',       2,        -- NFR-PRIV-003, then auto-anonymise
    'token_expiry_days_after_decisions', 60 -- FR-IDT-012
  )
$$;

ALTER TABLE cycles ALTER COLUMN config SET DEFAULT fn_default_cycle_config();

UPDATE cycles SET config = fn_default_cycle_config() || config
 WHERE config = '{}'::jsonb;

COMMENT ON COLUMN cycles.config IS
  'All tunable behaviour. Modifiable without deployment (NFR-MAIN-001, R-050). Defaults from fn_default_cycle_config().';

COMMIT;
