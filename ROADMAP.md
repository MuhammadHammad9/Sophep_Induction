# ROADMAP — SOPHEP RMS

Six phases. **Each ends at something demonstrable**, not at "the code is written." A phase is
complete only when its exit criteria demonstrably pass (`R-055`).

> **Phase 2 is the minimum viable induction.** The specification is emphatic: scoring can fall
> back to paper for one cycle, but the queue cannot be improvised on the floor. If time runs
> short, ship Phases 1–2 properly and defer 3–4 — never the reverse.

**Status legend:** ⬜ not started · 🟨 in progress · ✅ complete · ⛔ blocked

---

## Phase 0 — Foundations 🟨

*2–3 days. No product behaviour — just the ground everything else stands on.*

**Done**
- [x] `git init`, `.gitignore`, workspace `package.json`
- [x] `CLAUDE.md`, `rules.md`, `ROADMAP.md`
- [x] Directory skeleton for `frontend/` and `backend/`
- [x] Workspace manifests, `tsconfig` for both packages, path alias `@sophep/backend`
- [x] Tailwind config with §18.2 design tokens and §18.3 state colours
- [x] CI workflow — typecheck, lint, test, **plus RLS and concurrency gates against a real Postgres**
- [x] `.env.example` documenting every secret, none committed

- [x] `npm install` — **0 vulnerabilities** after upgrading Next 15→16 and Vitest 2→4
      (both carried high/critical transitive CVEs; NFR-SEC-010 fails a build on those)
- [x] Next.js app entry, PostCSS, ESLint flat config
- [x] Vitest configured for both workspaces
- [x] `npm run build` green — 6 routes
- [x] `npm run typecheck` and `npm run lint` green

**Remaining — needs credentials**
- [ ] Supabase project linked (`supabase link`) — needs your project ref and access token
- [ ] Playwright config + first e2e test
- [ ] Vercel project connected — needs your auth
- [ ] OneDrive sync exclusions verified against a clean `npm ci` + build

**Exit:** `npm run dev` serves a themed page · `npm run verify` green in CI · a trivial migration
applies and rolls back · a Vercel preview builds from a branch.

---

## Phase 1 — Cycles, identity, registration 🟨

*Week 1–2. Ships: **you can accept applications**.*

> ### ⚠ VERIFICATION STATUS — read before trusting anything below
>
> **Written and statically verified:** typecheck, lint and build are green; 48 unit tests pass.
>
> **NOT yet executed:** the 11 SQL migrations and the 45 database tests covering RLS, state
> ownership, audit immutability, dedupe override and concurrency. They need a real Postgres,
> and this machine has no Docker, no local Postgres, and no `DATABASE_URL`.
>
> So every checkbox below marked *(unverified)* means "the code exists and compiles", NOT
> "it works". Per R-055 a phase is complete only when its exit criteria demonstrably pass —
> **Phase 1 is not complete.**
>
> **First thing to do when a database is available:**
> ```
> npm run db:migrate && npm run db:seed && npm test
> ```
>
> **Top risk to check first:** `fn_register_applicant` is `SECURITY DEFINER` while `applicants`
> has `FORCE ROW LEVEL SECURITY`. It currently relies on its owning role holding `BYPASSRLS`
> to satisfy the insert policy. If the owner lacks that attribute, public registration will
> fail closed with a policy violation. This is the most likely first failure and the fix is a
> narrow insert policy for the definer path, not a broader grant.

*Blocking: FR-CYC-001…007, 012, 013 · FR-IDT-001…006 · FR-REG-001…013 · FR-RBAC-001…010 ·
FR-AUD-001…003 · DR-001…006*

**Schema** — migrations `0001`–`0011`
- [x] `citext` + `pg_trgm`; `norm_email` / `norm_phone` as real `IMMUTABLE` functions (E6) *(unverified)*
- [x] societies, cycles, stages, departments, tracks, rooms, users, memberships *(unverified)*
- [x] applicants, applicant_preferences, access_tokens, audit_events *(unverified)*
- [x] **Partial** unique indexes excluding overridden/withdrawn rows (E4) *(unverified)*
- [x] Enum states as DB types, not application convention (DR-003) *(unverified)*

**Security**
- [x] RLS on every table from day one, fail-closed (`R-014`) *(unverified)*
- [x] `rms_app` role with `NOBYPASSRLS` + `SET LOCAL ROLE` per transaction — without this the
      policies are decorative whenever the pool authenticates as a privileged role *(unverified)*
- [x] Six roles; capabilities are the **union** across a user's roles in a cycle (E13) *(unverified)*
- [x] Audit append-only — privileges revoked **and** a trigger; written in-transaction *(unverified)*
- [ ] TOTP for Coordinator/Admin/Super Admin — **deferred to Phase 2** with staff auth; no staff
      login exists yet, so there is nothing to second-factor

**Behaviour**
- [x] ID generation via in-transaction counter (`R-020`) → `SPH-SP26-0042` *(unverified)*
- [x] Token issuance: 128-bit entropy, `sha256` stored, raw never persisted (`R-022`)
- [x] Cycle state machine as a global gate inside the write function, not the UI *(unverified)*
- [x] Registration through all three channels via **one code path** *(unverified)*
- [x] Dedupe: exact email/phone/roll → hard block; trigram name ≥ 0.85 → soft warning *(unverified)*
- [x] Override with mandatory ≥10-char reason, persisted and audited *(unverified)*
- [x] Up to 3 ranked preferences · CV validation by magic number, 10 MB cap
- [x] Applicant status page — pre-event states
- [x] Confirmation email **mocked** to `notifications` table + `/dev/notifications` preview
- [ ] CV upload endpoint and storage bucket — validation logic is written and tested, but
      nothing is wired to object storage yet

**Exit criteria** — none met until the suite runs
- [ ] Online, walk-in digital, and paper transcription each produce structurally **identical**
      records with valid IDs and tokens — no second-class record
- [ ] Dedupe override works end to end, with the reason in the audit log
- [ ] 20 concurrent registrations → 20 distinct IDs, zero contention gaps
- [ ] Per-role/per-endpoint matrix test: 403 for every denied capability
- [ ] Direct-SQL test with unset RLS context returns **zero** rows

---

## Phase 2 — Event core: tokens, check-in, queue engine ⬜

*Week 3–4. Ships: **you can run interview day**. This phase cannot be deferred.*

*Blocking: FR-IDT-007…011 · FR-CHK-001…011, 018 · FR-QUE-001…020 · FR-OPS-009, 010 ·
NFR-PERF-001…005 · NFR-AVAIL-002…005*

**Tokens**
- [ ] Ed25519 keypair per cycle; private key KMS-encrypted, **server only** (`R-021`)
- [ ] QR payload is a full HTTPS URL — any phone camera works as fallback
- [ ] Four-layer verification: format → roster hash → Ed25519 → server
- [ ] Rate limit 10/min/IP, constant-time comparison
- [ ] Previous cycle's token fails signature verification against the current cycle

**Check-in**
- [ ] Persistent live camera — **not** a tap-to-scan button
- [ ] Success: zero taps, auto-clear at 2.5 s · Failure: requires explicit dismissal
- [ ] All ten branches from spec §7.2, including **amber for already-checked-in** (`R-027`)
- [ ] Manual search: any 4 ID digits, last 4 phone digits, or partial name
- [ ] Register-and-check-in in one screen, ≤30 s, flagged `needs_completion`
- [ ] Track with no open panel → check in, **suppress ETA**, raise ops alert
- [ ] One check-in per applicant per stage, enforced by DB constraint
- [ ] Idempotency-Key on every mutation (`R-051`)

**Queue engine**
- [ ] Pull-based claim, `FOR UPDATE SKIP LOCKED` + `NOT EXISTS` recusals (`R-013`)
- [ ] Priority tiers 100/50/30/10/5; tier 50 granted by Coordinator only (no public booking)
- [ ] Coordinator priority override with mandatory reason, audited
- [ ] Grace window 5 min; one-time "I'm on my way" +2 min
- [ ] Skip → requeue at priority 30, `enqueued_at = now − 10 min` → park on second skip
- [ ] Parked count visible to panels; volunteers alerted when `waiting` empty but `parked` is not
- [ ] Withdrawal deletes the queue entry in the **same transaction** as the state change

**Wait estimation** — retuned for variable 10–30 min interviews
- [ ] EWMA seed **20 min**, smoothing **0.2**, range **−30%/+50%** — all cycle config
- [ ] Always a range, never a point estimate
- [ ] Upward revision always shown **with its cause** (`R-026`)
- [ ] Suppressed for first 15 min of a stage and when the track has no open panel
- [ ] Below position 3 → "You're next", no number

**Surfaces**
- [ ] Applicant status page live; **called state takes over the full viewport**
- [ ] Public display board — IDs and rooms only, excluded at the publisher (`R-028`)
- [ ] Realtime with degradation ladder; connection indicator + last-updated on every live surface

**Exit criteria**
- [ ] 20 concurrent Call Next → 20 **distinct** applicants, zero double assignments
- [ ] Same QR scanned on two devices → exactly one `check_ins` row
- [ ] A recusal row containing NULL does **not** stall the queue
- [ ] Wait estimate rises with a stated cause when a panel closes
- [ ] Full dry run: register → check in → queue → call → grace expiry → skip → requeue → park →
      reactivate
- [ ] Check-in API p95 ≤ 300 ms · claim ≤ 200 ms · realtime propagation ≤ 2 s

---

## Phase 3 — Evaluation ⬜

*Week 5. Ships: structured scoring.*

*Blocking: FR-INT-001…020 · FR-OPS-005, 006*

- [ ] Room / Panel / Interviewer as **distinct** entities (a Panel is a session, not a place)
- [ ] Panel states incl. `awaiting_evaluations` (E10) — an unrepresentable state is one the UI
      has to guess at
- [ ] Rubrics versioned; weights sum to 100 by DB constraint; **anchors mandatory**
- [ ] `rubric_version_id` pinned at interview **start**, not submit (E17)
- [ ] Interviewer screen: profile, answers, preferences, CV, anchored rubric, elapsed timer as a
      nudge — and **nothing** revealing another evaluator, aggregate, rank, or seat count (`R-029`)
- [ ] One evaluation per (interview, interviewer); immutable on submit
- [ ] 15-min revision window with mandatory reason, original retained; Super Admin unlock after
- [ ] Submit blocked until every criterion is scored, missing ones marked **inline**
- [ ] Panel blocked from Call Next while awaiting evaluations, **naming the interviewer** (`R-058`)
- [ ] Coordinator waiver with written reason — the escape hatch for an interviewer who went home
- [ ] Recusals, freely declared, honoured by the claim query; auto-**suggest** only, never auto-create
- [ ] Heartbeat 30 s; 90 min silence → `flagged`; void requeues at priority 100
- [ ] Ops dashboard with **Action Required first**, saying "all clear" rather than rendering empty
- [ ] Stage close gate: blocks on in-progress and awaiting-evaluation interviews

**Exit criteria**
- [ ] Two-interviewer panels complete interviews end to end
- [ ] Panel cannot Call Next while `awaiting_evaluations`
- [ ] Interviewer A cannot read B's evaluation **via direct SQL** under A's RLS context
- [ ] Stage close blocked while an interview is `in_progress`, listing room and panel

---

## Phase 4 — Scoring, allocation, decisions ⬜

*Week 6. Ships: end-to-end recruitment.*

*Blocking: FR-SCR-001…014 · FR-DEC-001…016 · FR-OFF-001…006 · FR-NOT-001…005*

- [ ] Raw score = weighted mean, 0–100
- [ ] Shrinkage: `w = n/(n+5)`, `adjusted = raw − w × bias`, computed at **review time**
- [ ] Raw and adjusted both persisted, both displayed side by side (`R-023`)
- [ ] Flags: `HIGH_DISAGREEMENT`, `CRITERION_FLOOR`, `LOW_CONFIDENCE`, `SINGLE_EVALUATOR`
- [ ] Capacity-relative bands (`R-024`); flags force discussion; `CRITERION_FLOOR` auto-excludes
- [ ] Four pre-flight gates; advisory lock per cycle
- [ ] Deterministic deferred acceptance, full five-level tie-break (`R-025`)
- [ ] Override by Super Admin with reason → new decision version, prior retained
- [ ] **Dual-control lock** — two distinct Super Admins, enforced by DB constraint
- [ ] Immutable checksummed snapshot on lock
- [ ] Dry run: counts, per-outcome breakdown, 3 rendered samples, email validity + bounce
      history, and a check that no `selected` applicant lacks a department
- [ ] Publish behind re-auth + typed confirmation; corrections never mutate the snapshot
- [ ] Offers: **1-day expiry, reminder at T−6h**
- [ ] Waitlist cascade **hourly** — required by the short expiry
- [ ] Notifications async with per-recipient delivery state; hard bounces on the ops dashboard

**Exit criteria**
- [ ] Allocation run twice over identical input → **byte-identical** output
- [ ] The same Super Admin **cannot** both lock and confirm
- [ ] Dry run demonstrated with real sample renders
- [ ] Declined offer cascades to the next eligible waitlisted applicant, skipping one placed
      elsewhere and marking them lapsed

---

## Phase 5 — Resilience ⬜

*Week 7, before the event. Ships: confidence.*

*Blocking: FR-CHK-012…017 · FR-INT-014…016 · FR-OPS-003 · NFR-AVAIL-006…008*

- [ ] Offline check-in, 8 continuous hours, ≥500 buffered operations in IndexedDB
- [ ] Roster bundle: token hashes + public key **only** — no scores, no decisions, no private key
- [ ] Replay in client-timestamp order with original idempotency keys
- [ ] Conflicts resolve to earliest server-received record and are **logged, never discarded**
- [ ] Offline indicator: colour **and** diagonal stripes, with live pending count
- [ ] Bulk reconciliation screen; printed roster by ID and by surname
- [ ] Nightly job re-derives `applicants.state` from owners, alerts on drift
- [ ] Backup restore tested and verified
- [ ] Load test at NFR-SCAL-001 · full `axe` + keyboard + screen-reader pass
- [ ] **Event-day runbook drill** — all 13 pre-event checklist items, WiFi genuinely switched off

**Exit criteria**
- [ ] 8-hour partition then reconnect → 100% reconciliation, zero duplicates
- [ ] Restore verified within 7 days of the event
- [ ] Load test passes at the full concurrency profile
- [ ] Three untrained participants each complete a check-in within 60 s, no written instruction

---

## Phase 6 — Refinement ⬜

*Post-event. Explicitly out of scope for the first induction.*

- [ ] Capacity simulator taking **min and max** duration, reporting a feasibility range
- [ ] Analytics, scope-limited watermarked exports
- [ ] Second interview round UI (schema already supports it via `queue_entries.round`)
- [ ] SMS / WhatsApp notification
- [ ] Public slot booking, if the committee ever wants it

---

## Continuous verification gates

| Gate | What runs |
|---|---|
| **Every build** | Full state-transition matrix incl. rejection of undefined transitions · per-role/per-endpoint 403 matrix · **direct-SQL RLS tests bypassing the API** · golden-dataset scoring and allocation with determinism re-runs |
| **Pre-release** | `axe` scan + manual keyboard and screen-reader pass |
| **Pre-cycle** | 20-actor concurrency test · scripted 8-hour network partition · NFR-SCAL-001 load profile · timed usability observation with 3 untrained participants |

Coverage target **≥ 80%** on state transitions, the queue claim path, scoring, and allocation.

### The twelve critical test cases

From `sophep-rms-spec.json → testing.critical_test_cases`. These are not a sample — each traces
to a real defect found during design review, and each becomes a named test citing its requirement.

1. 20 concurrent registrations → 20 distinct IDs, no contention gaps
2. 20 concurrent Call Next → 20 distinct applicants
3. Same QR on two devices → one `check_in` row
4. A NULL in `recusals` does not suppress the queue
5. Allocation twice over identical input → byte-identical output
6. Interviewer A cannot SELECT B's evaluation via direct SQL under A's RLS context
7. Unset RLS context returns zero rows, never all rows
8. The same Super Admin cannot both lock and confirm
9. 8 hours offline then reconnect → 100% reconciliation, zero duplicates
10. Stage close blocked while an interview is `in_progress`
11. Panel cannot Call Next while `awaiting_evaluations`
12. Wait estimate rises **with a stated cause** when a panel closes
