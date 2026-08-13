-- 0043 — Indexes for the paths that carry the event
--
-- The existing index coverage is genuinely good: `idx_queue_claim` is a partial index matching
-- fn_claim_next's predicate exactly, the trigram indexes back manual search, and the audit,
-- decision and evaluation lookups are all covered. This migration is deliberately small — it
-- adds four indexes for four specific queries that run at event scale and had none, and does
-- not pad the list with speculative ones that would only cost write throughput.
--
-- Scale being designed for (CLAUDE.md): 1,000 applicants, 20 panels, 30 interviewers.
--
-- Refs: NFR-PERF-002, NFR-PERF-004, NFR-SCALE-001, audit S-2

BEGIN;

-- ── 1. The applicant status poll: "my current queue entry" ──────────────────────────────
--
-- fn_applicant_status runs, for every poll:
--
--     SELECT q.* FROM queue_entries q
--      WHERE q.applicant_id = ? ORDER BY q.created_at DESC LIMIT 1
--
-- `idx_queue_applicant` is (applicant_id, state), which does not order by created_at — so this
-- sorts every entry the applicant has. That is small per applicant, but this is the single
-- highest-frequency query in the system: ~200 people watching their position, polling every
-- 5 seconds, for an hour. It is the query most likely to make the connection pool the
-- bottleneck, and the one nobody notices in testing because one developer polling is free.
CREATE INDEX IF NOT EXISTS idx_queue_applicant_recent
  ON queue_entries (applicant_id, created_at DESC);


-- ── 2. The waitlist cascade's eligibility check ─────────────────────────────────────────
--
-- fn_cascade_department excludes candidates who already hold a live offer:
--
--     NOT EXISTS (SELECT 1 FROM offers o WHERE o.applicant_id = cd.applicant_id
--                   AND (o.state = 'accepted' OR (o.state = 'pending' AND o.expires_at > now())))
--
-- Evaluated once per candidate, inside a loop, while an applicant waits for the response to
-- their decline. `idx_offers_department` is (department_id, state) and does not help a lookup
-- keyed on applicant_id. Partial, because the cascade only ever asks about live offers.
CREATE INDEX IF NOT EXISTS idx_offers_applicant_live
  ON offers (applicant_id, expires_at)
  WHERE state IN ('pending', 'accepted');


-- ── 3. Hard-bounce suppression, now that it is cycle-scoped ─────────────────────────────
--
-- Migration 0040 added the missing `cycle_id` filter to fn_enqueue_notification's suppression
-- check. `idx_notifications_bounced` is (cycle_id) WHERE state = 'bounced', which no longer
-- matches the predicate — the address is what the lookup is keyed on. This runs once per
-- outbound message, and results day sends one per applicant in a burst.
CREATE INDEX IF NOT EXISTS idx_notifications_bounce_lookup
  ON notifications (to_email, cycle_id)
  WHERE state = 'bounced';


-- ── 4. Manual search by phone ───────────────────────────────────────────────────────────
--
-- FR-CHK-009 allows searching on the last 4 digits of the phone number — the fallback when a
-- camera has failed and a volunteer is reading a number aloud across a desk. searchApplicants
-- issues `phone_norm LIKE '%1234'`, a trailing-wildcard match that no btree can serve and that
-- the existing trigram indexes do not cover, because they are on display_id and full_name.
--
-- A trigram index handles the leading wildcard that a btree cannot. This is the degraded-mode
-- path, so it matters most exactly when everything else has already gone wrong (principle 1).
CREATE INDEX IF NOT EXISTS idx_applicant_phone_trgm
  ON applicants USING gin (phone_norm gin_trgm_ops);

COMMIT;
