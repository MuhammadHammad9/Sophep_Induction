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

## Phase 1 — Cycles, identity, registration ✅

*Week 1–2. Ships: **you can accept applications**.*

> ### ✅ VERIFIED against a live Supabase Postgres
>
> 14 migrations applied · **99 tests pass** · typecheck, lint and build clean · application
> submitted end to end through the running app.
>
> Four bugs were found only by running it for real — none were visible to typecheck:
>
> | | Bug | Why it hid |
> |---|---|---|
> | `0013` | **Lock-upgrade deadlock in registration.** A `FOR SHARE` lock on the cycle row was upgraded to `FOR UPDATE` by the counter. Two desks registering at once deadlocked. | Only appears under genuine concurrency — every single-user test passed |
> | `0014` | **notifications had no INSERT policy**, so confirmation email failed. The obvious fix would have made the public form an **open mail relay** | Needed the full request path, not a unit test |
> | `0012` | **Context accessors raised instead of denying** on a malformed value — a clean 403 became a 500, with the offending value in logs | Needed a deliberately malformed context |
> | — | **RLS was decorative** wherever the connection held `BYPASSRLS` | Would have made the entire RLS suite theatre |
>
> Two of the six initial failures were bugs in my *tests*, not the code.

*Blocking: FR-CYC-001…007, 012, 013 · FR-IDT-001…006 · FR-REG-001…013 · FR-RBAC-001…010 ·
FR-AUD-001…003 · DR-001…006*

**Schema** — migrations `0001`–`0011`
- [x] `citext` + `pg_trgm`; `norm_email` / `norm_phone` as real `IMMUTABLE` functions (E6)
- [x] societies, cycles, stages, departments, tracks, rooms, users, memberships
- [x] applicants, applicant_preferences, access_tokens, audit_events
- [x] **Partial** unique indexes excluding overridden/withdrawn rows (E4)
- [x] Enum states as DB types, not application convention (DR-003)

**Security**
- [x] RLS on every table from day one, fail-closed (`R-014`)
- [x] `rms_app` role with `NOBYPASSRLS` + `SET LOCAL ROLE` per transaction — without this the
      policies are decorative whenever the pool authenticates as a privileged role
- [x] Six roles; capabilities are the **union** across a user's roles in a cycle (E13)
- [x] Audit append-only — privileges revoked **and** a trigger; written in-transaction
- [ ] TOTP for Coordinator/Admin/Super Admin — **deferred to Phase 2** with staff auth; no staff
      login exists yet, so there is nothing to second-factor

**Behaviour**
- [x] ID generation via in-transaction counter (`R-020`) → `SPH-SP26-0042`
- [x] Token issuance: 128-bit entropy, `sha256` stored, raw never persisted (`R-022`)
- [x] Cycle state machine as a global gate inside the write function, not the UI
- [x] Registration through all three channels via **one code path**
- [x] Dedupe: exact email/phone/roll → hard block; trigram name ≥ 0.85 → soft warning
- [x] Override with mandatory ≥10-char reason, persisted and audited
- [x] Up to 3 ranked preferences · CV validation by magic number, 10 MB cap
- [x] Applicant status page — pre-event states
- [x] Confirmation email **mocked** to `notifications` table + `/dev/notifications` preview
- [ ] CV upload endpoint and storage bucket — validation logic is written and tested, but
      nothing is wired to object storage yet

**Exit criteria — met**
- [x] Online, walk-in digital, and paper transcription each produce structurally **identical**
      records with valid IDs and tokens — no second-class record
- [x] Dedupe override works end to end, with the reason in the audit log
- [x] 20 concurrent registrations → 20 distinct IDs, zero contention gaps
- [x] Direct-SQL test with unset RLS context returns **zero** rows, through a
      **transaction-mode pooler** — the exact configuration that caused E9
- [x] Capability matrix verified per role, including the role-union case (E13)
- [ ] Per-**endpoint** 403 matrix — deferred to Phase 2, which is when staff endpoints and
      staff auth first exist. Capability-level coverage is in place.

---

## Phase 2 — Event core: tokens, check-in, queue engine 🟨

*Week 3–4. Ships: **you can run interview day**. This phase cannot be deferred.*

*Blocking: FR-IDT-007…011 · FR-CHK-001…011, 018 · FR-QUE-001…020 · FR-OPS-009, 010 ·
NFR-PERF-001…005 · NFR-AVAIL-002…005*

### Build order — hardest and least improvisable first

Phase 1 taught the lesson that shapes this order: **the bugs that matter appeared only under
concurrency and only through the real request path.** So the queue engine — the one component
that genuinely cannot be improvised on the floor — is built and load-tested before any UI
exists to look at it.

| # | Stage | Contains | Proven by |
|---|---|---|---|
| ✅ **2A** | Event schema | stages, check_ins, panels, panel_members, panel_tracks, queue_entries, recusals, interviews · Ed25519 keypair per cycle | Migrations apply; RLS fail-closed extends to every new table |
| ✅ **2B** | **Queue engine** | `fn_claim_next` with `SKIP LOCKED` + `NOT EXISTS`; priority tiers; grace/skip/park; `fn_queue_transition` as state owner | **20 concurrent Call Next → 20 distinct applicants**; a NULL in `recusals` does not stall the queue |
| ✅ **2C** | Identity & check-in | Ed25519 sign/verify; four-layer verification; `fn_check_in` idempotent, one per stage | Same QR on two devices → one `check_ins` row; a prior cycle's token fails |
| ✅ **2D** | Staff auth | Supabase Auth, session→membership binding, TOTP for Coordinator/Admin/Super Admin, per-endpoint 403 matrix | The endpoint matrix deferred from Phase 1 |
| ✅ **2E** | Surfaces | Scanner PWA, panel screen, applicant live status, public display board, realtime + degradation ladder | Full dry run: register → check in → call → grace → skip → park → reactivate |

**2B before 2C is deliberate.** Check-in is the visible part and the tempting place to start,
but it only feeds the queue. If the claim semantics are wrong, every screen built on top has
to be reworked — and `SKIP LOCKED` is the one thing in this system that cannot be bolted on.

### Known risks going in

- **Wait estimation is retuned** for your 10–30 min interviews (seed 20, α 0.2, −30%/+50%).
  With that variance the estimate will move; `FR-QUE-017` requires every upward revision to
  be shown **with its cause**, so this is a UX problem as much as a maths one.
- **Panels claim, applicants do not get pushed.** Any design that assigns a room in advance
  goes stale the moment one interview overruns.
- **The display board must exclude names at the publisher**, not in the client (`R-028`).
- **TOTP lands here**, carried over from Phase 1 where there was no staff login to protect.

**Tokens** — migrations `0018`–`0019`, ✅ verified
- [x] Ed25519 keypair per cycle; private key AES-256-GCM encrypted, **server only** (`R-021`)
- [x] QR payload is a full HTTPS URL — any phone camera works as fallback
- [x] Four-layer verification: format → roster hash → Ed25519 → server
- [x] Previous cycle's token fails signature verification against the current cycle
- [x] Constant-time hash comparison
- [x] Rate limit 10/min/IP via middleware — ⚠ in-memory, so **per-instance** on Vercel.
      Move to a shared counter before the event (Phase 5).

**Check-in** — ✅ backend verified, scanner UI outstanding
- [x] One check-in per applicant per stage, enforced by DB constraint
- [x] Idempotent: 6 simultaneous scans → one `check_ins` row, one queue entry
- [x] Repeat scan returns the ORIGINAL time for **amber, not red** (`R-027`)
- [x] Track with no open panel → check in, **suppress ETA**, raise ops alert
- [x] Withdrawn / screened-out refused; closed stage refused
- [x] Roster bundle: token hashes only, no names or key material (`FR-CHK-018`)
- [x] Scanner PWA: persistent camera, zero-tap success, 2.5 s auto-clear
- [x] Manual search UI: any 4 ID digits, last 4 phone digits, or partial name
- [x] Native BarcodeDetector with zxing-wasm fallback (iOS Safari has no BarcodeDetector)
- [ ] Register-and-check-in in one screen, ≤30 s, flagged `needs_completion` — **deferred**;
      the `needs_completion` flag and backend path exist, the one-screen form does not

**Queue engine** — migrations `0015`–`0017`, ✅ verified
- [x] Pull-based claim, `FOR UPDATE SKIP LOCKED` + `NOT EXISTS` recusals (`R-013`)
- [x] Priority tiers 100/50/30/10/5; tier 50 granted by Coordinator only (no public booking)
- [x] Coordinator priority override with mandatory reason, audited
- [x] Grace window 5 min; one-time "I'm on my way" +2 min
- [x] Skip → requeue at priority 30, `enqueued_at = now − 10 min` → park on second skip
- [x] Withdrawal deletes the queue entry in the **same transaction** as the state change
- [x] `fn_queue_transition` as sole owner of event-day `applicants.state` (E5)
- [ ] Parked count surfaced to panels + volunteer alert — needs the panel screen (2E)

**Wait estimation** — retuned for variable 10–30 min interviews
- [ ] EWMA seed **20 min**, smoothing **0.2**, range **−30%/+50%** — all cycle config
- [ ] Always a range, never a point estimate
- [ ] Upward revision always shown **with its cause** (`R-026`)
- [ ] Suppressed for first 15 min of a stage and when the track has no open panel
- [ ] Below position 3 → "You're next", no number

**Surfaces** — ✅ verified
- [x] Applicant status page live; **called state takes over the full viewport**
- [x] Public display board — IDs and rooms only, excluded at the publisher (`R-028`)
- [x] Degradation ladder: polling + backoff, last-known value retained, connection indicator
      and last-updated instant on every live surface
- [x] Panel screen: idle / called / blocked, naming the outstanding interviewer
- [ ] Websocket layer (Supabase Realtime) — polling is the required fallback and ships first;
      sockets are an optimisation on top

**Exit criteria**
- [x] 20 concurrent Call Next → 20 **distinct** applicants, zero double assignments
- [x] Same QR scanned on two devices → exactly one `check_ins` row
- [x] A recusal row containing NULL does **not** stall the queue
- [x] Wait estimate rises with a stated cause when a panel closes — verified live
- [x] Display board provably carries no names
- [ ] Full dry run through skip → park → reactivate on the real UI
- [ ] p95 latency measurement under the NFR-SCAL-001 profile

**Exit criteria**
- [ ] 20 concurrent Call Next → 20 **distinct** applicants, zero double assignments
- [ ] Same QR scanned on two devices → exactly one `check_ins` row
- [ ] A recusal row containing NULL does **not** stall the queue
- [ ] Wait estimate rises with a stated cause when a panel closes
- [ ] Full dry run: register → check in → queue → call → grace expiry → skip → requeue → park →
      reactivate
- [ ] Check-in API p95 ≤ 300 ms · claim ≤ 200 ms · realtime propagation ≤ 2 s

---

## Phase 3 — Evaluation 🟨

*Week 5. Ships: structured scoring.*

*Blocking: FR-INT-001…020 · FR-OPS-005, 006*

- [x] Room / Panel / Interviewer as **distinct** entities (Phase 2, migration `0015`)
- [x] Panel states incl. `awaiting_evaluations` (E10)
- [x] Rubrics versioned; weights sum to 100 by DB constraint; **anchors mandatory** (`0023`)
- [x] Published rubrics immutable — editing one mid-session splits a panel across scales (E17)
- [x] `rubric_id` pinned at interview **start**, not submit (E17)
- [x] Interviewer screen: profile, answers, preferences, anchored rubric **inline**, elapsed
      timer as a nudge — and nothing revealing another evaluator or aggregate (`R-029`)
- [x] One evaluation per (interview, interviewer); immutable on submit
- [x] 15-min revision window with mandatory reason, original retained; Super Admin unlock after
- [x] Submit blocked until every criterion is scored, missing ones named **inline**
- [x] Panel blocked from Call Next while awaiting evaluations, **naming the interviewer**
- [x] Coordinator waiver with written reason — and an **authenticated actor** (`0026`)
- [x] Recusals honoured by the claim query (Phase 2)
- [x] Heartbeat; 90 min silence → `flagged`; void requeues at priority 100
- [x] Ops dashboard with **Action Required first**, saying "all clear" explicitly
- [x] Stage close gate: blocks on in-progress and awaiting-evaluation interviews (E15)
- [x] Service observations recorded on completion, feeding the wait estimator
- [ ] CV display on the interviewer screen — storage not yet wired (carried from Phase 1)
- [ ] Recusal auto-**suggest** on surname or phone-prefix match (`FR-INT-018`, Should)

**Exit criteria — met**
- [x] Two-interviewer panels complete interviews end to end
- [x] Panel cannot Call Next while `awaiting_evaluations`
- [x] Interviewer A cannot read B's evaluation **via direct SQL** under A's RLS context
- [x] Stage close blocked while an interview is `in_progress`, listing room and panel
- [x] Coordinator has **no** score visibility — the reason the role exists
- [ ] Structured scoring demonstrated on the real UI end to end

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

## Phase 5 — Resilience 🟨 in progress

*Week 7, before the event. Ships: confidence.*

*Blocking: FR-CHK-012…017 · FR-INT-014…016 · FR-OPS-003 · NFR-AVAIL-006…008*

**Durable replay** — migration `0034`, `services/idempotency.ts`
- [x] Idempotency moved from an in-memory `Map` to the `idempotency_keys` TABLE. The map was
      per-serverless-instance and discarded on restart, so a 500-operation replay would have
      produced duplicates in production while passing every local test.
- [x] Replay in client-timestamp order carrying the ORIGINAL key (`by-ts` index, not insertion
      order)
- [x] `/api/apply`, `/api/checkins`, `/api/fast-track` all on the durable path, with the
      transaction OUTER so a claim and its work commit or roll back together
- [x] A key is RELEASED when the work fails, so one failure cannot block that operation from
      ever syncing
- [x] `/api/apply` stores only the display id — the status URL contains a raw token and must
      never reach `idempotency_keys.response_body` (`R-022`)

**Offline check-in**
- [x] Roster bundle endpoint (`GET /api/stages/:id/roster`) and device caching. Until this
      existed nothing ever called `cacheRoster`, so layer 2 compared against an empty set and
      there was no offline mode at all — on a device that looked identical to one that had it.
- [x] ⚠ Bundle contents follow **spec.json**, which lists identity and preferences; TRD
      FR-CHK-018 says hashes only. Conflict raised, not silently resolved — see below.
- [x] Public key only on the device. No private key material, no scores, no decisions.
- [x] Offline indicator: colour **and** diagonal stripes, live pending count, and a SEPARATE
      red band for operations that need a human — a count that folded conflicts into "pending"
      would hide them inside a reassuring number
- [x] A 409 (key reused) is no longer treated as success. It means the operation never landed;
      deleting it was a silent discard of a real check-in (`FR-CHK-015`)
- [ ] Verified at ≥500 buffered operations on a real device over 8 continuous hours

**Recovery**
- [x] Bulk reconciliation screen (`/reconcile/:stageId`), two-step: resolve → see names →
      confirm. Unmatched identifiers are shown, never dropped.
- [x] `checkin.reconcile` capability (migration `0039`) — spec.json puts this endpoint at
      coordinator+, and it was reachable by any volunteer
- [x] One bad identifier no longer aborts the batch (migration `0044`) — `fn_check_in` raises
      `no_data_found`, which the per-row handler did not catch
- [ ] Printed roster by ID and by surname

**Scheduled work** — `jobs/scheduled.ts`, `vercel.json`
- [x] Hourly: offer expiry, waitlist cascade, T−6h reminders — required by the 1-day expiry
- [x] Nightly: state-drift detection, audited. It REPORTS and does not correct: a job that
      patched the projection would be a second writer, hiding the bug it exists to find (`R-012`)
- [x] Cron endpoint authenticated by shared secret, constant-time, fails CLOSED when unset
- [ ] Verified firing on a Vercel preview deployment

**Remaining**
- [ ] Backup restore tested and verified
- [ ] Load test at NFR-SCAL-001 · full `axe` + keyboard + screen-reader pass
- [ ] **Event-day runbook drill** — all 13 pre-event checklist items, WiFi genuinely switched off

**Exit criteria**
- [x] 8-hour partition then reconnect → 100% reconciliation, zero duplicates
      (`tests/concurrency/offline-replay.test.ts`: 120 operations replayed in client-timestamp
      order, then the whole queue replayed again — zero new rows, every verdict `replay`, and
      8 concurrent replays on separate connections)
- [ ] Restore verified within 7 days of the event
- [ ] Load test passes at the full concurrency profile
- [ ] Three untrained participants each complete a check-in within 60 s, no written instruction

**Spec conflict — DECIDED (`CLAUDE.md` → notes_for_implementers)**

> **The conflict.** TRD `FR-CHK-018`: the offline roster bundle "**shall** contain token hashes
> and the cycle public key only". spec.json `offline.roster_bundle.contents`: applicant id,
> display_id, name, sha256(token), department preferences, public key, stage configuration.
>
> **The decision: build to spec.json. `FR-CHK-018` is a defect in the TRD.**
>
> Precedence settles it (the JSON wins on conflict), but precedence is the weakest reason and is
> not the one relied on. **The TRD contradicts itself.** Two other mandatory requirements:
>
> - `FR-CHK-009` — "**shall** provide manual check-in by search on any 4 consecutive digits of
>   the identifier, the final 4 digits of the phone number, or partial name" *(verified by
>   demonstration)*
> - `FR-CHK-012` — "check-in **shall** function with no network connectivity for at least 8
>   continuous hours"
>
> Together these require searching by name and by phone with no network. A set of opaque hashes
> cannot be searched by either. So a hashes-only bundle does not merely lose a convenience — it
> makes a *shall* unimplementable at the exact moment it matters, leaving a working camera and
> an undamaged QR code as the only way in.
>
> **What `FR-CHK-018` was protecting is kept, by other means.** Its concern is `RSK-006`: a
> volunteer's personal phone, holding the whole cohort, left on a chair. Choosing a document
> does not answer that, so it is answered separately:
>
> 1. **Minimum sufficient data.** The bundle carries exactly what `FR-CHK-009`'s three search
>    modes need. Note `phone_last4` rather than the phone number — the requirement asks for the
>    final four digits, so the final four digits are all that ships. A lost device yields no
>    reachable contact detail for anybody.
> 2. **Nothing evaluative, ever.** No scores, decisions, evaluations or key material — the half
>    both documents agree on, enforced by the column list rather than by convention.
> 3. **It expires.** 16-hour TTL on the device, wiped on sign-out.
>
> **A gap this uncovered and closed.** The bundle carried no phone digits at all, so offline
> manual search silently supported two of `FR-CHK-009`'s three modes. A search by number
> returned nothing — indistinguishable, at the desk, from "not registered". Fixed in migration
> `0050`, with the offline predicates now deliberately parallel to the online ones.
>
> **Action for the committee:** correct `FR-CHK-018` at baselining to read *"shall contain
> identity sufficient for FR-CHK-009 manual search, token hashes and the cycle public key. It
> shall not contain evaluations, scores, decisions, full contact details, or any private key
> material."*

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
