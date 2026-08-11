# SOPHEP Recruitment Management System
## Architecture, Flows & Interface Specification — **Version 2.0**

*Supersedes v1.0. Section 0 lists every correction made to v1, including one security flaw.*

---

# 0. Errata — what was wrong in v1

You asked me to correct myself. I audited v1 against its own schema, its own arithmetic, and the flows I drew from it. Fifteen things were wrong. Three of them mattered a lot.

## 0.1 Critical

### E1. Offline QR verification was cryptographically broken

**v1 said:** the QR carries an HMAC signature, and the check-in device verifies it offline using "the cycle's HMAC public verification parameters."

**Why this is wrong:** HMAC is symmetric. There is no such thing as an HMAC public verification parameter. Verifying an HMAC requires *the signing secret itself*. So v1 required shipping the cycle's QR-signing secret to every volunteer's phone. Anyone who extracted it — a borrowed device, a rooted phone, cached local storage — could mint unlimited valid SOPHEP QR codes. I designed a key-distribution vulnerability and then described it as a resilience feature.

**Correction — and it turns out no cryptography is needed for the common case.** The device already caches the day's roster, which contains `sha256(token)` for every applicant. So offline verification is:

```
scanned token  ->  sha256  ->  is this hash in my cached roster?
```

A set-membership test. No secret leaves the server. A compromised device leaks the roster it was always going to hold, and leaks **no ability to forge**.

For applicants registered *after* the morning sync (walk-ins entered at another desk), add an **Ed25519** signature — asymmetric, so devices carry only the **public** key and can verify without being able to sign. That is precisely the thing HMAC could never do.

| | v1 (broken) | v2 (correct) |
|---|---|---|
| Primary offline check | HMAC verify with shared secret | `sha256(token)` membership in cached roster |
| Late registrations | — | Ed25519 signature, public key on device |
| Secret material on devices | **Yes — the signing key** | None |
| Forgery risk if a device is compromised | **Total** | None |

---

### E2. The normalisation scale and the score thresholds contradicted each other

**v1 said:** `normalised = 50 + 10z`, then set `minimum_score = 55` and `auto_shortlist_above = 75`.

**Why this is wrong:** that mapping forces the cohort to mean 50, standard deviation 10 — by construction. So `75` is +2.5σ, roughly the **top 0.6%**. Out of 200 applicants, auto-shortlist would fire for about one person. Meanwhile the 55–75 "manual review band" would swallow around 30% of the cohort — some 60 people to discuss individually, in a meeting I had described as covering 29.

I wrote thresholds calibrated for a raw 0–100 rubric scale and then silently applied them to a z-transformed scale where they mean something entirely different. The numbers looked reasonable and were nonsense.

**Correction — two changes:**

1. **Map to the cohort, not to an arbitrary 50/10.** `adjusted = cohort_mean + cohort_sd × z_within_interviewer`. Interviewer strictness is removed while the cohort's real distribution is preserved, so a score still means what a reader assumes it means.
2. **Express thresholds relative to capacity, not as absolute numbers.** The band that needs human discussion is the one straddling the capacity line — ranks `0.75 × capacity` through `2 × capacity` per department. This auto-scales to any cohort size and never needs recalibrating between cycles.

---

### E3. Averaging raw and normalised scores together is meaningless

**v1 said:** interviewers with fewer than 8 evaluations fall back to raw; then `final = mean(normalised across all evaluations)`.

**Why this is wrong:** those are different scales. An applicant seen by one experienced interviewer (normalised, cohort-centred) and one new interviewer (raw, perhaps averaging 78) receives the average of two incommensurable numbers. Worse, the rule creates a **cliff**: an interviewer's 8th evaluation retroactively rescales the previous seven. Two identically-scored applicants could rank differently based on how many *other* people their interviewer happened to see that day.

**Correction — empirical-Bayes shrinkage.** One formula, always applied, no cliff:

```
n         = evaluations completed by this interviewer so far
k         = 5                          (shrinkage constant)
w         = n / (n + k)                (confidence in this interviewer's bias estimate)

bias      = interviewer_mean - cohort_mean
adjusted  = raw - (w * bias)
```

At n=1, `w = 0.17` — almost no adjustment, correctly reflecting that one data point says little about a person's strictness. At n=20, `w = 0.80` — a strong correction. Continuous, never mixes scales, degrades gracefully instead of switching modes. The `σ ≥ 3` guard from v1 becomes unnecessary and is deleted.

---

## 0.2 Schema and correctness

### E4. The unique index on email made the documented override path impossible

v1 §4.5 said a duplicate can be overridden with a reason. v1 §13 then declared:

```sql
CREATE UNIQUE INDEX uq_applicant_email ON applicants (cycle_id, email_norm) ...
```

The override insert would fail on a constraint violation. Prose and schema directly contradicted each other, and Flow 04 documented a branch the database forbade.

**Correction:** application-layer dedupe, with the partial unique index excluding deliberately-overridden rows:

```sql
ALTER TABLE applicants ADD COLUMN dedupe_override_reason text;

CREATE UNIQUE INDEX uq_applicant_email ON applicants (cycle_id, email_norm)
  WHERE state NOT IN ('withdrawn','screened_out')
    AND dedupe_override_reason IS NULL;
```

The constraint still catches accidents. A deliberate, reasoned, audited override now works — which is what the flow always claimed.

### E5. Two sources of truth for applicant state

`applicants.state` and `queue_entries.state` both encoded *queued / called / in_interview*, with nothing keeping them consistent. They would drift, and the first symptom would be an applicant whose status page and whose panel screen disagree — during the event, in front of them.

**Correction — explicit state ownership (§4):** `queue_entries.state` is authoritative for event-day states. `applicants.state` is a projection written in the same transaction by the same function, never by anything else.

### E6. `email_norm` was a no-op that did not match its own description

```sql
email_norm citext GENERATED ALWAYS AS (lower(email)) STORED
```

`email` was already `citext` — case-insensitive by definition — so `lower()` did nothing. And the prose promised Gmail dot/plus-tag stripping the column never implemented, so `a.b+induction@gmail.com` and `ab@gmail.com` were treated as different people when v1 explicitly said they would not be.

**Correction:** a real `IMMUTABLE` normalisation function used by the generated column (§15.1).

### E7. `NOT IN` in the queue claim query

```sql
AND applicant_id NOT IN (SELECT applicant_id FROM recusals WHERE ...)
```

`NOT IN` returns **zero rows** if the subquery yields a single NULL — a silent, total queue stall that on the floor would look like "the system just stopped giving us applicants." It is also the slower plan.

**Correction:** `NOT EXISTS` (§8.1).

### E8. Deferred acceptance was non-deterministic

Departments ranked applicants by score. Scores tie — frequently, on a coarse rubric. So running allocation twice could produce two different valid stable matchings. In a disputed outcome, "the algorithm decided" is only a defence if the algorithm decides the **same thing every time**.

**Correction:** an explicit, total, deterministic tie-break chain (§11.2).

### E9. RLS depended on a session variable that never gets set under a pooler

The policies read `current_setting('app.applicant_id', true)`, and v1 never said how it is written. Under a transaction-mode connection pooler — Supabase's default — a session-level `SET` either leaks across unrelated requests or vanishes. Either the security boundary silently fails open, or nothing works at all.

**Correction:** derive from JWT claims, or `set_config(..., true)` inside the same transaction. Specified in §15.2.

### E10. The panel state machine could not represent "blocked"

I described panels unable to call the next applicant until all evaluations were in. But `panels.status` was `closed | open | busy | break` — no state for it. An unrepresentable state is one the UI has to guess at.

**Correction:** add `awaiting_evaluations`.

## 0.3 Behaviour and honesty

### E11. The wait-time clamp was designed to display a number I knew was false

v1: *"Never let the estimate increase while the applicant's queue position has not worsened."*

If two of four panels break for lunch, the true wait doubles with position unchanged. v1's rule would keep showing the old, now-wrong number. I wrote a rule that prioritised the *appearance* of stability over telling someone the truth about their afternoon.

**Correction:** revise upward whenever `active_panels` or observed service time changes materially — and always say why. *"Two panels are on break — about 15 minutes longer."* An explained increase costs far less trust than a number that was quietly wrong.

### E12–E15. Smaller corrections

| | Problem | Fix |
|---|---|---|
| E12 | Claimed the per-cycle counter sustains "thousands per second" — it serialises *all* registrations for a cycle, undercutting the stated 10,000-applicant goal | Honest numbers plus the sharded alternative (§20) |
| E13 | `memberships` permits several roles per user per cycle, but the permission gate assumed exactly one | Capabilities are the **union** across roles (§12.3) |
| E14 | No timezone policy — every "10:00" in the spec was ambiguous | `timestamptz` stored, rendered in the cycle's IANA zone, `Asia/Karachi` default (§15.4) |
| E15 | Undefined: what happens to `in_interview` applicants when a stage closes | Stage close blocks on in-flight interviews, with an explicit resolution path (§6.3) |

---

# 1. Design principles

Unchanged in substance from v1, with one addition promoted to the top after the E11 audit.

1. **The event never stops.** Every critical path has a degraded mode.
2. **Never present a number you know is stale as if it were live.** Honesty beats the appearance of stability. This is a principle now because I violated it in v1.
3. **Every state change is atomic, idempotent, and audited.**
4. **One writer per fact.** Projections are written in the same transaction as their source.
5. **Fairness is enforced by the schema, not by policy.**
6. **Applicants see only themselves** — at the row level in the database.
7. **Optimise for the fifteen seconds at the desk.**
8. **Configuration over code.** A new cycle never requires a deployment.
9. **Cycles are immutable once closed.**

---

# 2. Domain model

```
Society
 └── Cycle (Spring 2027)
      ├── Stage (Registration, Day 1, Day 2, Review, Decisions)
      ├── Department (capacity, interviewers, rubric override)
      ├── Track (queue lane)
      ├── Room ──┐
      ├── Panel ─┴── PanelMember
      ├── Rubric (versioned) ── Criterion (weight, anchors)
      ├── Applicant
      │    ├── Application (answers, ranked preferences, CV)
      │    ├── AccessToken
      │    ├── CheckIn (one per stage)
      │    ├── QueueEntry     <-- authoritative event-day state
      │    ├── Interview ── Evaluation ── ScoreItem
      │    ├── Decision (versioned)
      │    └── Offer
      ├── Notification
      └── AuditEvent (append-only)
```

**Room ≠ Panel ≠ Interviewer.** A Room is a place. A Panel is a *session* — the interviewers occupying a room for a shift, and the thing that pulls from the queue. An Interviewer sits on many panels across a cycle. Without the Panel entity, every rotation corrupts throughput statistics and the audit trail.

---

# 3. Identity, IDs and tokens

## 3.1 Applicant ID

```
SPH-SP26-0042
│   │    └── per-cycle sequence, zero-padded
│   └─────── season (SP/FA/SU) + two-digit year
└─────────── society code
```

Speakable across a noisy hall, sortable, never reused. The season marker distinguishes Spring 2026 from Fall 2026 — your original `SP26` could not.

**Generation**, collision-proof across concurrent desks:

```sql
UPDATE cycles SET applicant_seq = applicant_seq + 1
 WHERE id = $1 RETURNING applicant_seq;
```

Inside the same transaction as the insert. Honest throughput: **a few hundred registrations per second**, bounded by commit latency — not the thousands v1 claimed (E12). That is roughly 100× your realistic peak. §20 covers the sharded variant if you ever outgrow it.

## 3.2 Token model — corrected (E1)

```
token      : 16 random bytes, base64url          "kTn3xQ8vLp2wRb9Y"
signature  : Ed25519(token, cycle_private_key)   base64url
qr_payload : https://apply.sophep.org/q/kTn3xQ8vLp2wRb9Y.<sig>
```

The server stores `sha256(token)` only. A database leak yields no working QR codes and no working status links.

### Four-layer verification

| Layer | Runs | Requires | Catches |
|---|---|---|---|
| 1. Format | Device, offline | nothing | Garbage and other apps' QR codes |
| 2. Roster hash | Device, offline | cached roster | **Everyone registered before sync** — the 99% case |
| 3. Ed25519 | Device, offline | **public** key | Applicants registered after sync |
| 4. Server | Online | database | Revocation, cycle, state, single-use |

Layer 2 is the workhorse and needs no cryptography: hash what you scanned, look it up in the cached set. Layer 3 exists only because someone registering at Desk 2 at 11:00 will not appear in the roster Desk 1 downloaded at 09:30 — and Ed25519 lets Desk 1 verify them anyway **without holding a signing key**.

A full HTTPS URL means any phone camera opens the status page as a fallback. The custom scanner is an optimisation, not a dependency.

### Rules

- One active token per applicant; rotation revokes the old one immediately.
- Lookups rate-limited (10/min/IP), constant-time hash comparison.
- Cycle keypair rotated per cycle — a previous cycle's QR cannot validate against a new one.
- Tokens expire 60 days after final decisions.

## 3.3 Unified registration

Every applicant — online, walk-in digital, walk-in paper — receives an ID, a token, and a QR. Paper is an *input method*, not a separate pipeline. One code path, one set of edge cases, one thing for a volunteer to learn under pressure.

---

# 4. State ownership (new — fixes E5)

Every fact has exactly one owner. This table is normative.

| Fact | Owner | Projection | Written only by |
|---|---|---|---|
| Queue position, called / skipped / parked | `queue_entries.state` | `applicants.state` | `fn_queue_transition()` |
| Checked in for a stage | `check_ins` row exists | `applicants.state` | `fn_check_in()` |
| Interview progress | `interviews.status` | `applicants.state` | `fn_interview_transition()` |
| Final outcome | `decisions` (latest version) | `applicants.state` | `fn_apply_decision()` |
| Published record | `result_snapshots.payload` | — | immutable, write-once |

**Rules:**

1. `applicants.state` is **never** written directly by application code — only by the four functions above, in the same transaction as the owning row.
2. Every transition function writes an `audit_events` row in the same transaction. No audit, no commit.
3. A nightly consistency job re-derives `applicants.state` from its owners and alerts on any mismatch, making drift a monitored condition rather than a mystery.

Without this rule, the most likely production bug is an applicant whose phone says "Position 4" while the panel screen says they are mid-interview — and it is unfixable after the fact, because nothing records which was right.

---

# 5. State machines

Anything not listed is rejected with `409 INVALID_TRANSITION`. Ambiguous state is the root cause of most "the system did something weird" reports.

## 5.1 Applicant

```
                          ┌──────────────── withdrawn (any time pre-decision)
                          │
 DRAFT ──submit──▶ SUBMITTED ──screen──▶ ELIGIBLE ──check_in──▶ CHECKED_IN
                          │           └─▶ SCREENED_OUT              │ enqueue
                          │                                          ▼
                          │                                      QUEUED ◀─────────┐
                          │                                          │ call        │
                          │                                          ▼             │ requeue
                          │                                      CALLED ───────────┤
                          │                                     ┌────┴────┐        │
                          │                                     ▼         ▼        │
                          │                              IN_INTERVIEW  SKIPPED ────┘
                          │                                     │           │ 2nd skip
                          │                            complete │           ▼
                          │                                     ▼        PARKED
                          │                          INTERVIEW_COMPLETE     │ reactivate
                          │            (another round required? ─▶ QUEUED)  └─▶ QUEUED
                          │                                     │ all rounds done
                          └─────────────────────────────▶ UNDER_REVIEW
                                                               │ lock + publish
                          ┌────────────────────────────────────┼────────────────────┐
                          ▼                                    ▼                    ▼
                      SELECTED                            WAITLISTED            REJECTED
                          │ offer                              │ cascade
                          ▼                                    └─▶ SELECTED
                   OFFER_PENDING ──accept──▶ ACCEPTED ──▶ ONBOARDED
                          ├──decline──▶ DECLINED   (cascade)
                          └──expire───▶ LAPSED     (cascade)
                                       ACCEPTED ──late withdrawal──▶ DECLINED (cascade)
```

**Guards:**

| Transition | Guard | Trigger |
|---|---|---|
| `SUBMITTED → ELIGIBLE` | Required fields complete; window open | System or Admin |
| `ELIGIBLE → CHECKED_IN` | Interview stage active; token valid; not already checked in for this stage | Volunteer, Coordinator |
| `QUEUED → CALLED` | Panel open; panel serves this track; no recusal | Panel (pull) |
| `CALLED → IN_INTERVIEW` | Within grace window | Panel |
| `CALLED → SKIPPED` | Grace expired (auto) | System |
| `IN_INTERVIEW → INTERVIEW_COMPLETE` | **All** panel evaluations submitted **or** Coordinator waiver | System |
| `* → UNDER_REVIEW` | All required rounds complete | System |
| `UNDER_REVIEW → SELECTED/…` | Results locked by **two distinct** Super Admins | Super Admin ×2 |

**Post-check-in edit lock (refined).** Lock *substantive* fields — answers, preferences, CV. Keep *contact* fields (phone, email) editable by Admin: you will need to fix a mistyped email to deliver a result. Every edit audited.

## 5.2 Interview

```
IN_PROGRESS ──▶ AWAITING_EVALUATIONS ──all in──▶ COMPLETE
      │                    │
      │ abandon            │ no heartbeat 90 min
      ▼                    ▼
  ABANDONED ─────────▶ FLAGGED ──▶ Coordinator: void / requeue / force-complete
```

## 5.3 Cycle — and the stage-close gate (fixes E15)

```
DRAFT ▶ REGISTRATION_OPEN ▶ REGISTRATION_CLOSED ▶ INTERVIEWS_ACTIVE
      ▶ INTERVIEWS_CLOSED ▶ UNDER_REVIEW ▶ RESULTS_LOCKED ▶ PUBLISHED ▶ ARCHIVED
```

Cycle state is a **global gate** checked by every write endpoint. Registering during `INTERVIEWS_CLOSED` fails at the API, not merely in the UI (this was UI-only in v1).

**Closing an interview stage** — v1 left this undefined. The correct behaviour:

```
Coordinator requests stage close
  ├─ interviews still IN_PROGRESS?      → BLOCK. List them. "3 interviews still running."
  ├─ interviews AWAITING_EVALUATIONS?   → BLOCK, with a per-interviewer outstanding list
  │                                       and a "waive with reason" action per row
  ├─ applicants QUEUED or CALLED?       → warn, list them, offer bulk carry-forward
  │                                       to the next stage or bulk no-show
  └─ all clear                          → close; PARKED applicants auto-resolve to NO_SHOW
```

Blocking is deliberate. The alternative is discovering eleven missing evaluations three days later, when the interviewers no longer remember the candidates.

`ARCHIVED` makes the cycle read-only at the database level, so historical integrity is structural rather than a matter of discipline.

---

# 6. Registration

Pipeline: **validate → normalise → dedupe → allocate ID → persist → notify**.

## 6.1 Duplicate detection

Matching runs on normalised values (E6 — now genuinely implemented):

| Signal | Rule | Action |
|---|---|---|
| Email | Gmail dots and `+tags` stripped, lowercased | Exact → hard block |
| Phone | Last 9 digits after stripping non-digits | Exact → hard block |
| Roll number | Exact, case-insensitive | Exact → hard block |
| Name | Trigram similarity ≥ 0.85 **and** shared department preference | Soft warning |

Hard block shows the existing record with two actions: **"Same person — check them in"** or **"Different person — override"**. Override demands a written reason, sets `dedupe_override_reason`, and is audited (E4).

## 6.2 ID allocation

Per-cycle counter incremented in-transaction (§3.1). No `SELECT MAX()+1` anywhere in the codebase — that pattern produces duplicate IDs the first time two desks register simultaneously.

## 6.3 Slot booking

Optional but strongly recommended. Online applicants book a 60-minute arrival window; capacity per window is derived from the throughput model (§14.2). Walk-ins fill unbooked capacity.

This turns arrivals from Poisson into schedulable, which is the difference between an orderly hall and 200 people waiting eight hours. It also makes every wait estimate dramatically more accurate.

---

# 7. Check-in

## 7.1 Target: under 8 seconds, zero taps

Persistent live camera — not a "press to scan" button. Scan → verify → confirm → auto-clear after 2.5s. A confirmation tap across 200 scans is 200 chances to double-tap and 200 wasted seconds.

## 7.2 Every branch

| Situation | Response | Volunteer action |
|---|---|---|
| Success | Green, ID + name + track + position | None |
| Already checked in | **Amber, not red.** "Checked in at 10:14 · Position 12" | Reassure, move on |
| Fails roster hash and signature | Red: "Not a valid SOPHEP code" | Manual search |
| Previous cycle's token | Red: "This code is from Fall 2026" | Register as new |
| Withdrawn / screened out | Red: "Not eligible — see Coordinator" | Escalate |
| Stage not open | Amber: "Check-in opens at 10:00" | Wait, or Coordinator override |
| No record at all | Register-and-check-in on one screen | 30 seconds, flagged `needs_completion` |
| No camera / broken screen | Manual search: any 4 digits of ID, last 4 of phone, or name | — |
| Offline | Amber banner: "Offline · 3 pending sync" | Continue normally |
| **Track has no open panel** | Enqueue, **suppress ETA**, raise ops alert | Coordinator assigns a panel |

"Already checked in" being amber rather than red matters more than it looks. It is the single most common non-happy path, it is not an error, and a red screen in front of a nervous applicant reads as *you have a problem* when the correct message is *you are fine*.

## 7.3 Offline operation — corrected (E1)

**At stage start** the PWA downloads: applicant roster with `sha256(token)` (≈40 KB for 200), the cycle **Ed25519 public key**, and stage configuration.

**While offline:**
- Verify: format → roster hash → Ed25519. No secret on the device.
- Write to IndexedDB with a client-generated UUID and device timestamp.
- Unmistakable amber banner with a pending count — plus a diagonal stripe pattern, because colour alone must never be the only signal.
- Manual search works against the cached roster.
- Positions shown as approximate and explicitly labelled.

**On reconnect:** replay in timestamp order, each carrying its `client_request_id`; the server deduplicates through the idempotency table; conflicts resolve to the **earliest server-received** timestamp and are logged, not dropped. The banner clears only at zero pending.

**Hard fallback:** a printed roster sorted by ID and by surname, with tick boxes, recovered afterwards through a bulk-reconcile screen. Print it every morning. You will probably never use it, and the one time you do it will save the event.

---

# 8. Queue engine

## 8.1 Pull, not push — with the recusal bug fixed (E7)

A panel that is genuinely free presses **Call Next**. Assignment cannot go stale because it is created at the instant of readiness.

```sql
BEGIN;

WITH claimed AS (
  SELECT q.id
    FROM queue_entries q
   WHERE q.cycle_id = $cycle
     AND q.track_id = ANY($panel_tracks)
     AND q.state    = 'waiting'
     AND NOT EXISTS (                      -- was NOT IN: NULL-unsafe, could stall the queue
           SELECT 1 FROM recusals r
            WHERE r.applicant_id   = q.applicant_id
              AND r.interviewer_id = ANY($panel_members)
         )
   ORDER BY q.priority DESC, q.enqueued_at ASC
   FOR UPDATE SKIP LOCKED
   LIMIT 1
)
UPDATE queue_entries q
   SET state = 'called', panel_id = $panel,
       called_at = now(), call_count = call_count + 1
  FROM claimed
 WHERE q.id = claimed.id
RETURNING q.*;

COMMIT;
```

`FOR UPDATE SKIP LOCKED` is the whole trick: ten panels can press Call Next in the same millisecond and each receives a **different** applicant — no application locking, no retries, no possibility of a double assignment. Zero rows returned means the queue is genuinely empty.

## 8.2 Ordering

| Priority | Value | Applies to |
|---|---|---|
| Accessibility / medical need | 100 | Coordinator, with reason |
| Interview voided through no fault of theirs | 100 | System |
| Time-slot holder, arrived in window | 50 | Booked and punctual |
| Returning after a skip | 30 | Second chance, ahead of new walk-ins |
| Standard | 10 | Everyone else |
| Late for a booked slot | 5 | Missed their window |

Priority is **data, not code**. Coordinators can adjust any entry with a mandatory reason, visible in the audit log. Floor managers *will* need to bump someone; a system that forbids it is a system they stop using.

## 8.3 No-show handling

```
CALLED → 5-minute grace (configurable)
   ├── arrives                      → IN_INTERVIEW
   ├── taps "I'm on my way"         → +2 minutes, ONCE only
   └── expires                      → SKIPPED
                                        ├ 1st: requeue, priority 30,
                                        │      enqueued_at = now − 10 min
                                        └ 2nd: PARKED — off the queue,
                                               onto the volunteer worklist
                                               → auto NO_SHOW at stage close
```

A soft penalty rather than back-of-queue: sending someone from position 3 to position 40 over a two-minute absence provokes an argument at the desk that costs more time than the delay did.

`PARKED` keeps the queue clean. **When `waiting` is empty but `parked` is not, panels see the parked count and volunteers are alerted to go find them** — otherwise panels idle while people sit fifteen metres away.

## 8.4 Wait estimation — corrected (E11)

```
service_ewma(track) = 0.3 × last_duration + 0.7 × previous      seed 12 min
active_panels(track) = panels with status 'open' or 'busy'

eta = ceil(position / max(active_panels,1)) × service_ewma
      + remaining time on the in-flight interview
```

**Display rules — these matter more than the formula:**

1. **Always a range**, never a single number. "About 15–25 minutes." A single number is read as a promise.
2. **Revise upward when the truth changes** — a drop in `active_panels` or a material shift in service time — and **say why**: *"Two panels are on break — about 15 minutes longer."* v1 suppressed this and would have displayed a number it knew was wrong.
3. **Suppress entirely for the first 15 minutes** of a stage, and whenever the track has no open panel. The EWMA has no data; "We'll call you shortly" is more honest and more useful.
4. **Below position 3, stop estimating.** "You're next." Precision there is impossible and unnecessary.

---

# 9. Interviewing

## 9.1 Interviewer screen

**Visible:** profile, answers, ranked preferences, CV, the rubric with anchor descriptions, remarks, alternative-department recommendation, elapsed timer against target (a nudge, not a cutoff).

**Not visible, enforced server-side:** any other interviewer's scores or remarks, any aggregate or rank, any decision or shortlist status, the number of available places.

## 9.2 Rubric

Versioned per cycle, optionally overridden per department. Weights must sum to 100 (schema-enforced). **Anchors are mandatory** — an unanchored 1–5 scale means five different things to five people, and no statistical correction fully recovers from that. Written anchors are the cheapest fairness intervention available.

**`rubric_version_id` is pinned at interview *start*, not at submit.** Otherwise an edit mid-session splits one panel across two scales.

## 9.3 Submission

- One evaluation per (interview, interviewer), unique-constrained.
- Immutable on submit. Edits within 15 minutes create a **revision** with a mandatory reason; the original is retained.
- After 15 minutes, Super Admin unlock only, itself audited.
- Interview completes only when **every** panel member has submitted — **or** a Coordinator waives a specific missing evaluation with a written reason. Without that escape hatch, one interviewer going home permanently disables a panel.

## 9.4 Recusal

Student societies are small; an interviewer will meet their roommate. Recusals are declared freely, honoured by the claim query (§8.1), visible to the Coordinator, and permanently recorded. Auto-*suggest* recusal on surname or phone-prefix match — a prompt, never an automatic action.

---

# 10. Scoring — rebuilt (E2, E3)

## 10.1 Raw score

```
raw = Σ(criterion_score × weight) / Σ(weight)      → 0–100
```

## 10.2 Interviewer bias correction — shrinkage, not a cliff

```
cohort_mean = mean(raw) across every evaluation in the cycle
n           = evaluations by this interviewer
w           = n / (n + 5)
bias        = interviewer_mean − cohort_mean
adjusted    = raw − (w × bias)                     → same 0–100 scale as raw
```

| n | w | Effect |
|---|---|---|
| 1 | 0.17 | Almost none — one data point proves nothing |
| 5 | 0.50 | Half correction |
| 12 | 0.71 | Substantial |
| 30 | 0.86 | Near-full |

`adjusted` stays on the raw scale, so raw and adjusted are directly comparable and thresholds keep their plain meaning. Both are always stored and always displayed side by side — the review meeting must see what actually happened, not only what the maths concluded.

Computed at **review time**, not on submission: it depends on the full distribution.

## 10.3 Applicant score

```
final = mean(adjusted across all evaluations of that applicant)
```

Single scale throughout. No mode switching.

## 10.4 Flags for human attention

| Flag | Condition | Why |
|---|---|---|
| `HIGH_DISAGREEMENT` | spread across panel > 20 points | The case where a human adds most value |
| `CRITERION_FLOOR` | any criterion ≤ 2 of 5 | Strong signal a high average can hide |
| `LOW_CONFIDENCE` | all evaluators have n < 5 | Bias estimate is weak; read raw |
| `SINGLE_EVALUATOR` | only one evaluation exists | No agreement signal at all |

Averaging away disagreement hides exactly the information a committee exists to weigh.

## 10.5 Thresholds relative to capacity (E2)

Absolute cutoffs need recalibrating every cycle and were miscalibrated in v1. Rank within department instead:

```
rank r among applicants preferencing department d (capacity C):

  r ≤ 0.75 × C            → clear admit, no meeting time needed
  0.75C < r ≤ 2C          → DISCUSS at the review meeting
  r > 2C                  → below the line
  any CRITERION_FLOOR     → auto-exclude regardless of rank
  any flag from §10.4     → forced into DISCUSS
```

For an 8-place department: ranks 1–6 clear, 7–16 discussed, 17+ below. Roughly 10 discussions per department — a review meeting that finishes. It scales to any cohort automatically.

---

# 11. Decisions and allocation

## 11.1 Pre-flight gates

Allocation refuses to run unless: every interview is `COMPLETE` or explicitly voided; shrinkage has been computed; no other allocation holds the advisory lock; every active department has a capacity set.

## 11.2 Deferred acceptance — now deterministic (E8)

Applicant-proposing Gale–Shapley. Applicants rank departments on their form; departments rank applicants by:

```
1. final score (adjusted), descending
2. interviewer "recommend for this department" count, descending
3. score spread across the panel, ascending      (agreement breaks ties)
4. application submitted_at, ascending           (earlier applied)
5. applicant_id, ascending                       (total order guarantee)
```

Rules 4 and 5 are arbitrary — and that is the point. They make the ordering **total**, so the algorithm returns an identical result every run. v1 stopped at rule 1 and could produce different results on re-runs, which is indefensible when someone asks why they were ranked below a person with the same score.

**Properties:** stable (no applicant–department pair would both prefer each other); applicant-optimal among stable matchings; fully explainable — for any outcome you can name which department rejected them and why; runs in milliseconds at any scale you will reach.

**Every allocation is overridable** by dual-control Super Admin with a written reason. The algorithm proposes, humans decide — but the default is defensible and the overrides are visible.

## 11.3 Lock and publish

```
1. Coordinator marks review complete
2. President  → "Lock results"    → LOCK_PENDING
3. General Secretary → "Confirm"  → RESULTS_LOCKED   (must be a different user)
4. Immutable snapshot written with checksum
5. Dry run: recipient counts, per-outcome breakdown, three rendered samples,
   plus email-validity and bounce-history validation, plus a check that no
   selected applicant lacks a department
6. Publish → status pages update, emails dispatch through a rate-limited queue
```

Post-publication corrections never mutate the snapshot. They create a new versioned decision and a distinct correction notice. The record of what was published stays intact — which is what you want the first time someone disputes a result.

## 11.4 Offers and the waitlist cascade

```
Offer (5-day expiry, reminder at T−48h)
  ├─ accept  → ACCEPTED → ONBOARDED
  │              └─ late withdrawal → DECLINED, seat released, cascade
  ├─ decline → cascade
  └─ expire  → cascade

Cascade for that department:
  1. Take the top-ranked waitlisted applicant
  2. Still eligible and not placed elsewhere?  → no: skip, mark lapsed, take the next
  3. Send offer, fresh 5-day clock
  4. Notify Super Admins, write audit event
  Stop conditions: waitlist exhausted (department closes under capacity, notified),
                   or cascade manually paused near cycle end
```

---

# 12. Roles and permissions

## 12.1 Matrix

✅ full · 🔵 own/assigned only · ⚪ aggregate without identities · ❌ denied

| Capability | Super Admin | Coordinator | Admin | Volunteer | Interviewer | Auditor |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Create / configure cycle | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Manage departments, rubrics | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Advance cycle stage | ✅ | 🔵 interview stages | ❌ | ❌ | ❌ | ❌ |
| Manage users and roles | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Register applicant | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| View applicant profile | ✅ | ✅ | ✅ | 🔵 check-in fields | 🔵 assigned | ✅ |
| Edit application answers | ✅ | ❌ | ✅ pre-check-in | ❌ | ❌ | ❌ |
| Edit contact details | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Dedupe override | ✅ | ✅ | ✅ | 🔵 with reason | ❌ | ❌ |
| Check in / scan | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Adjust queue priority | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Reactivate parked applicant | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Open / close panels | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Call next applicant | ❌ | ✅ | ❌ | ❌ | 🔵 own panel | ❌ |
| Waive a missing evaluation | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Void / force-complete interview | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Submit evaluation | ❌ | ❌ | ❌ | ❌ | 🔵 own | ❌ |
| View others' evaluations | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| View aggregates | ✅ | ⚪ counts | ❌ | ❌ | ❌ | ✅ |
| Unlock a submitted evaluation | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Run / override allocation | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Lock and publish results | ✅ ×2 | ❌ | ❌ | ❌ | ❌ | ❌ |
| Export data | ✅ | ❌ | ⚪ non-score | ❌ | ❌ | ⚪ |
| View audit log | ✅ | 🔵 own | 🔵 own | 🔵 own | 🔵 own | ✅ |

## 12.2 Why Coordinator and Auditor exist

**Coordinator** — on the day, someone must reorder the queue, reassign panels and resolve stuck interviews *without being able to see a single score*. Your Volunteer cannot bump a priority; your Admin is a data role that should not be firefighting. Separating floor authority from scoring visibility is the entire point.

**Auditor** — read-only across everything including scores, write access nowhere. For a faculty advisor, an outgoing president, or a dispute. Being able to grant full visibility without granting any power is what makes disputes resolvable.

**Dual control** on locking and publishing only. Everything else stays unilateral. Ten extra seconds removes an entire category of "who published this" from your society's future.

## 12.3 Multiple roles (fixes E13)

`memberships` permits several roles per user per cycle — a Coordinator who also interviews is normal. **Capabilities are the union across all of a user's roles in that cycle**, computed once at session start. v1's gate assumed a single role and would have silently denied the second.

Deny rules do not exist; a capability is either granted by some role or absent. This keeps the model composable and avoids the classic "why can't I do this, I'm an admin" ambiguity.

## 12.4 Three-layer enforcement

1. **Database (RLS)** — the real boundary. An interviewer's connection cannot read another interviewer's evaluation rows regardless of what the API asks.
2. **API** — every endpoint declares a required capability; shared middleware enforces it and returns `403` with a machine-readable reason.
3. **UI** — hides what the user cannot do. **Ergonomics only. Never security.**

---

# 13. Real-time

## 13.1 A layer, not a foundation

Real-time keeps the UI fresh; it is never the source of truth. Postgres is.

| Channel | Subscribers | Payload | Filter |
|---|---|---|---|
| `applicant:{token_hash}` | that applicant | own state, position, ETA, room | RLS: one row |
| `cycle:{id}:queue` | Coordinator, Admin | queue deltas | RLS: staff |
| `cycle:{id}:panel:{pid}` | that panel | current applicant, panel state | RLS: membership |
| `cycle:{id}:display` | public TV | called IDs + room, waiting count | **no names, no scores** |
| `cycle:{id}:ops` | Super Admin, Coordinator | flags, stuck interviews, bounces | RLS: staff |

Channel design is a security boundary. The display channel physically cannot carry a name, because the publisher never puts one there — you are not trusting a client to omit it.

## 13.2 Degradation ladder

```
1. Websocket live                  instant, "Live" indicator
2. Dropped                         reconnect, backoff 1s→2s→4s… capped 30s
3. Failing > 10s                   poll every 5s, "Reconnecting" + last-updated time
4. Polling failing                 offline: cached data, explicit timestamp, local writes queue
5. Venue or power failure          printed roster + paper slips → bulk reconcile
```

Every real-time surface carries a connection indicator and a last-updated time. An applicant who knows a number is three minutes old is fine; one who trusts a frozen number and misses their call is not.

## 13.3 Idempotency

Every mutating request carries an `Idempotency-Key`. Same key + same request hash → replay the stored response. Same key + different hash → `409 IDEMPOTENCY_KEY_REUSED`. Keys expire after 24 hours.

This one mechanism makes the flaky-network double-tap harmless and offline replay safe by construction.

---

# 14. Failure modes

## 14.1 Concurrency matrix

| # | Scenario | Unhandled consequence | Mitigation |
|---|---|---|---|
| 1 | Two desks register simultaneously | Duplicate applicant ID | In-transaction per-cycle counter |
| 2 | Two volunteers scan the same QR at once | Doubled queue entry | Idempotency key + `UNIQUE(applicant_id, stage_id)` + state guard |
| 3 | Two panels press Call Next at once | Same applicant to two rooms | `FOR UPDATE SKIP LOCKED` — structurally impossible |
| 4 | Volunteer double-taps | Duplicate row | Same idempotency key → replay |
| 5 | Interviewer submits twice | Skewed average | `UNIQUE(interview_id, interviewer_id)` → revision flow |
| 6 | Registers online, then walks in | Interviewed twice | Dedupe on normalised email/phone/roll |
| 7 | Panel device dies mid-interview | Applicant stuck forever | Heartbeat 30s; 90 min silence → `FLAGGED`; void requeues at priority 100 |
| 8 | Network drops during check-in | Volunteer re-enters | Local write, UI says "pending" not "done" |
| 9 | Device clock skew | Out-of-order events | **Server timestamps authoritative**; client stored only for replay ordering |
| 10 | Applicant leaves mid-queue | Panel waits for a ghost | Grace → skip → park |
| 11 | Interviewer scores a friend | Compromised outcome | Recusal honoured in the claim query |
| 12 | Wrong email on a result | Applicant never learns their outcome | Delivery webhooks; bounces on the ops dashboard |
| 13 | Accidental early publish | Irreversible reputational damage | Dual control + dry run + typed confirmation + re-auth |
| 14 | Score edited after publication | Disputed integrity | Immutable snapshot; corrections are new versions |
| 15 | Cycle deleted | Loss of all history | `ARCHIVED` is read-only; no hard-delete endpoint exists |
| 16 | QR screenshot shared between friends | One person interviewed as another | One active token; single-use check-in; second scan shows the earlier time and the desk sees the mismatch |
| 17 | Rubric edited mid-cycle | Scores on silently different scales | Versioned; pinned at interview **start** |
| 18 | Mass-email rate limit | Half the cohort learns their result | Queue with retry, per-recipient delivery state |
| 19 | Two allocations run concurrently | Conflicting results | Advisory lock on `allocation:{cycle_id}` |
| 20 | Evaluations never submitted | Discovered days later | Panel blocked + ops counter + stage-close gate |
| 21 | Interviewer leaves without submitting | Panel disabled all day | Coordinator waiver with reason |
| 22 | Recusal subquery returns NULL | **Total silent queue stall** | `NOT EXISTS` (was `NOT IN` — E7) |
| 23 | Track with no open panel | Applicants wait on a fictional ETA | Detected at check-in; ETA suppressed; ops alert |
| 24 | Stage closed with interviews running | Orphaned records | Stage-close gate blocks and lists them |

## 14.2 Capacity model — run this before the event

```
throughput/hr = (60 / avg_minutes) × panels × utilisation

12-min interviews, 4 panels, 0.80 realistic utilisation
= (60/12) × 4 × 0.80 = 16 applicants per hour

200 applicants ÷ 16 = 12.5 hours  →  IMPOSSIBLE IN ONE DAY
```

`utilisation = 0.80` covers changeovers, no-shows, breaks and overruns. Planning at 1.0 is how every induction day runs three hours late.

Build this as a screen: enter expected applicants, interview length and panels; get required hours, a feasibility verdict, and the minimum panel count for the available window — then derive slot capacities from the same numbers. For the example: 200 applicants over two 6-hour days needs **≥ 6 panels**, or 8-minute interviews, or a shortlisting round first. Learning that a week ahead is planning. Learning it at 14:00 on the day is a crisis.

---

# 15. Data model — corrected

Grouped by concern for readability; real migrations create `users` before `cycles`, enable `citext` and `pg_trgm` first, and add circular references as deferred constraints.

## 15.1 Normalisation function (fixes E6)

```sql
CREATE OR REPLACE FUNCTION norm_email(addr text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
    WHEN split_part(lower(btrim(addr)), '@', 2) IN ('gmail.com','googlemail.com')
      THEN replace(split_part(split_part(lower(btrim(addr)),'@',1), '+', 1), '.', '')
           || '@gmail.com'
    ELSE split_part(lower(btrim(addr)), '@', 1) || '@'
         || split_part(lower(btrim(addr)), '@', 2)
  END
$$;

CREATE OR REPLACE FUNCTION norm_phone(p text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT right(regexp_replace(p, '[^0-9]', '', 'g'), 9)
$$;
```

Now `A.B+induction@Gmail.com` and `ab@gmail.com` genuinely collide, as v1 claimed but never implemented.

## 15.2 Core tables

```sql
CREATE TYPE cycle_state AS ENUM (
  'draft','registration_open','registration_closed','interviews_active',
  'interviews_closed','under_review','results_locked','published','archived');

CREATE TABLE cycles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id        uuid NOT NULL REFERENCES societies(id),
  season            char(2) NOT NULL CHECK (season IN ('SP','FA','SU')),
  year              smallint NOT NULL,
  state             cycle_state NOT NULL DEFAULT 'draft',
  applicant_seq     int NOT NULL DEFAULT 0,
  timezone          text NOT NULL DEFAULT 'Asia/Karachi',   -- E14
  qr_public_key     bytea NOT NULL,                          -- Ed25519 public  (E1)
  qr_private_key_enc bytea NOT NULL,                         -- KMS-encrypted, server only
  config            jsonb NOT NULL DEFAULT '{}',
  locked_by         uuid REFERENCES users(id),
  lock_confirmed_by uuid REFERENCES users(id),
  UNIQUE (society_id, season, year),
  CHECK (lock_confirmed_by IS NULL OR lock_confirmed_by <> locked_by)
);

CREATE TABLE applicants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id          uuid NOT NULL REFERENCES cycles(id),
  display_id        text NOT NULL,
  sequence          int  NOT NULL,
  state             applicant_state NOT NULL DEFAULT 'draft',  -- PROJECTION ONLY (§4)
  full_name         text NOT NULL,
  email             text NOT NULL,
  phone             text NOT NULL,
  roll_number       text,
  email_norm        text GENERATED ALWAYS AS (norm_email(email)) STORED,
  phone_norm        text GENERATED ALWAYS AS (norm_phone(phone)) STORED,
  source            text NOT NULL CHECK (source IN ('online','walkin_digital','walkin_paper')),
  dedupe_override_reason text,                                 -- E4
  needs_completion  boolean NOT NULL DEFAULT false,
  answers           jsonb NOT NULL DEFAULT '{}',
  cv_object_key     text,
  answers_locked_at timestamptz,
  UNIQUE (cycle_id, display_id),
  UNIQUE (cycle_id, sequence)
);

-- E4: constraint still catches accidents, deliberate override still possible
CREATE UNIQUE INDEX uq_applicant_email ON applicants (cycle_id, email_norm)
  WHERE state NOT IN ('withdrawn','screened_out') AND dedupe_override_reason IS NULL;
CREATE UNIQUE INDEX uq_applicant_phone ON applicants (cycle_id, phone_norm)
  WHERE state NOT IN ('withdrawn','screened_out') AND dedupe_override_reason IS NULL;
CREATE INDEX idx_applicant_name_trgm ON applicants USING gin (full_name gin_trgm_ops);

CREATE TABLE access_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id uuid NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,        -- sha256(token); raw never stored
  issued_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  expires_at   timestamptz NOT NULL
);
CREATE UNIQUE INDEX uq_active_token ON access_tokens (applicant_id) WHERE revoked_at IS NULL;

CREATE TABLE panels (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       uuid NOT NULL REFERENCES cycles(id),
  room_id        uuid NOT NULL REFERENCES rooms(id),
  status         text NOT NULL DEFAULT 'closed'
                 CHECK (status IN ('closed','open','busy',
                                   'awaiting_evaluations',    -- E10
                                   'break')),
  opened_at      timestamptz,
  last_heartbeat timestamptz
);

CREATE TYPE queue_state AS ENUM ('waiting','called','in_interview','done','skipped','parked');

CREATE TABLE queue_entries (                 -- AUTHORITATIVE event-day state (§4)
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id        uuid NOT NULL REFERENCES cycles(id),
  applicant_id    uuid NOT NULL REFERENCES applicants(id),
  track_id        uuid NOT NULL REFERENCES tracks(id),
  round           smallint NOT NULL DEFAULT 1,
  state           queue_state NOT NULL DEFAULT 'waiting',
  priority        smallint NOT NULL DEFAULT 10,
  priority_reason text,
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  panel_id        uuid REFERENCES panels(id),
  called_at       timestamptz,
  grace_extended  boolean NOT NULL DEFAULT false,
  call_count      smallint NOT NULL DEFAULT 0,
  UNIQUE (applicant_id, track_id, round),
  CHECK (priority_reason IS NOT NULL OR priority IN (5,10,30,50))
);
CREATE INDEX idx_queue_claim ON queue_entries (cycle_id, track_id, priority DESC, enqueued_at)
  WHERE state = 'waiting';

CREATE TABLE evaluations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id        uuid NOT NULL REFERENCES interviews(id),
  interviewer_id      uuid NOT NULL REFERENCES users(id),
  rubric_id           uuid NOT NULL REFERENCES rubrics(id),   -- pinned at START
  raw_score           numeric(5,2),
  adjusted_score      numeric(5,2),                            -- shrinkage output (E3)
  shrinkage_weight    numeric(4,3),                            -- w, for auditability
  remarks             text,
  recommended_dept_id uuid REFERENCES departments(id),
  submitted_at        timestamptz,
  revision            int NOT NULL DEFAULT 1,
  waived_by           uuid REFERENCES users(id),
  waiver_reason       text,
  UNIQUE (interview_id, interviewer_id, revision),
  CHECK (waived_by IS NULL OR waiver_reason IS NOT NULL)
);

CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  cycle_id    uuid REFERENCES cycles(id),
  actor_id    uuid REFERENCES users(id),
  actor_role  role_name,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  reason      text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;   -- append-only, enforced
```

## 15.3 RLS — with the setting actually set (fixes E9)

Under a transaction-mode pooler, session-level `SET` is unsafe. Two supported patterns:

```sql
-- Pattern A (Supabase): read from the verified JWT
CREATE POLICY applicant_self ON applicants FOR SELECT
  USING (id = (auth.jwt() ->> 'applicant_id')::uuid);

-- Pattern B (own backend): set inside the SAME transaction, is_local = true
--   BEGIN;
--   SELECT set_config('app.applicant_id', $1, true);   -- true = transaction-scoped
--   ... queries ...
--   COMMIT;
CREATE POLICY applicant_self_local ON applicants FOR SELECT
  USING (id = nullif(current_setting('app.applicant_id', true), '')::uuid);

-- Interviewers see only their own evaluations
CREATE POLICY eval_own ON evaluations FOR SELECT
  USING (interviewer_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- Super Admin and Auditor see all, within their cycle
CREATE POLICY eval_privileged ON evaluations FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM memberships m JOIN interviews i ON i.id = evaluations.interview_id
     WHERE m.user_id  = nullif(current_setting('app.user_id', true), '')::uuid
       AND m.cycle_id = i.cycle_id
       AND m.role IN ('super_admin','auditor')));
```

**Fail-closed check:** if `app.user_id` is unset, `nullif(...)::uuid` is NULL and every comparison is NULL — no rows. The boundary fails closed, which is the only acceptable direction.

With these in place, "interviewers cannot see each other's scores" is a property of the database. A frontend bug cannot leak it; a rushed endpoint cannot leak it.

## 15.4 Time (fixes E14)

Store `timestamptz` everywhere. Render in `cycles.timezone` (default `Asia/Karachi`). Never store local wall-clock strings. Stage boundaries are absolute instants; "10:00" in any UI is a rendering of one.

---

# 16. API

```
── Applicant (token-scoped, no account) ──────────────────────────
POST   /api/apply
GET    /api/q/:token                     status page payload
GET    /api/q/:token/status              polling fallback
POST   /api/q/:token/on-my-way           one-time grace extension
POST   /api/q/:token/offer/respond
POST   /api/q/:token/withdraw

── Registration desk ─────────────────────────────────────────────
POST   /api/cycles/:id/applicants
GET    /api/cycles/:id/applicants/search ?q= (ID, name, phone, roll)
POST   /api/applicants/:id/dedupe-override        reason required

── Check-in ──────────────────────────────────────────────────────
POST   /api/checkins                     { token | applicant_id, stage_id, client_ts }
POST   /api/checkins/bulk-reconcile      paper-fallback recovery
GET    /api/cycles/:id/roster            offline bundle: hashes + public key

── Queue ─────────────────────────────────────────────────────────
GET    /api/cycles/:id/queue
POST   /api/panels/:id/call-next         atomic claim
POST   /api/queue/:eid/skip | /reactivate | /requeue
PATCH  /api/queue/:eid/priority          reason required

── Panels & interviews ───────────────────────────────────────────
POST   /api/panels/:id/open | /close | /break | /heartbeat
POST   /api/interviews/:id/start
POST   /api/interviews/:id/evaluations
PATCH  /api/evaluations/:id              revision within 15 min, reason required
POST   /api/evaluations/:id/waive        Coordinator, reason required
POST   /api/interviews/:id/void | /force-complete

── Review & decisions ────────────────────────────────────────────
POST   /api/cycles/:id/compute-adjustment
GET    /api/cycles/:id/review-queue      capacity-relative bands + flags
POST   /api/cycles/:id/allocate          advisory-locked, deterministic
PATCH  /api/decisions/:id                override, reason required
POST   /api/cycles/:id/lock | /lock/confirm
POST   /api/cycles/:id/publish/dry-run | /publish

── Ops ───────────────────────────────────────────────────────────
GET    /api/cycles/:id/ops               flags, stuck, pending evals, bounces
GET    /api/cycles/:id/capacity-model
POST   /api/cycles/:id/stage/:sid/close  gated (§5.3)
POST   /api/cycles/:id/export            scope-limited, audited
GET    /api/cycles/:id/audit
```

**Error contract** — machine-readable so clients can react, not just display a string:

```json
{ "error": {
    "code": "INVALID_TRANSITION",
    "message": "Applicant is already checked in",
    "detail": { "current_state": "queued", "attempted": "checked_in", "at": "10:14" },
    "retryable": false } }
```

Codes: `INVALID_TRANSITION`, `IDEMPOTENCY_KEY_REUSED`, `QUEUE_EMPTY`, `RECUSAL_CONFLICT`, `STAGE_CLOSED`, `STAGE_HAS_ACTIVE_INTERVIEWS`, `DUPLICATE_APPLICANT`, `DUAL_CONTROL_REQUIRED`, `CYCLE_ARCHIVED`, `RATE_LIMITED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `ALLOCATION_IN_PROGRESS`, `PREFLIGHT_FAILED`.

---

# 17. Security and privacy

| Actor | Auth | Session |
|---|---|---|
| Applicant | Token URL, no account; optional emailed OTP to view results | Token-scoped, 60 days |
| Volunteer / Interviewer | Password or society SSO | 12 h, device-bound |
| Coordinator / Admin | Password + TOTP | 8 h |
| Super Admin | Password + TOTP, re-auth to lock/publish | 4 h |

- TLS 1.3, HSTS. Database encrypted at rest; `qr_private_key_enc` and TOTP secrets additionally encrypted at the application layer with a KMS-held key. **The Ed25519 private key never leaves the server** (E1).
- CVs in private storage; 15-minute signed URLs generated per request, each generation audited; served `Content-Disposition: attachment`.
- Uploads: extension allowlist, MIME sniffing, 10 MB cap, virus scan.
- Rate limits: token lookup 10/min/IP, applications 3/h/IP, login 5/15min with backoff. Bot protection on the public form.
- **Minimum collection.** No CNIC, date of birth or home address unless a process step genuinely requires it.
- **Retention:** full PII for 2 cycles, then automatic anonymisation — scores and aggregates retained for year-over-year analysis, identities stripped. Institutional memory without an ever-growing pile of student PII.
- Exports audited and watermarked with the exporter's identity; score exports are Super Admin only.
- Backups daily, encrypted, **restore tested before each cycle**. An untested backup is not a backup.

---

# 18. Interface design system

Generated with the `ui-ux-pro-max` skill, then corrected where its output conflicted with its own rules or with this product. Overrides are stated with reasons — an unexamined design system is as dangerous as an unexamined schema.

## 18.1 What the skill returned, and what I changed

| Element | Skill output | Decision |
|---|---|---|
| Style | **Data-Dense Dashboard** — KPI cards, tables, minimal padding, maximum data visibility, WCAG AA | ✅ **Adopted.** Correct for an operations tool. |
| Pattern | *Enterprise Gateway* — hero video, solutions by industry, client logos, "Contact Sales" | ❌ **Discarded.** That is a marketing site pattern. Nobody signs up for an internal queue console. Wrong artifact entirely. |
| Primary / Secondary | `#1E40AF` / `#3B82F6` | ✅ Adopted. |
| Background | `#F8FAFC` | ✅ Adopted. |
| Text | `#1E3A8A` (navy **blue**) | ⚠️ **Overridden → `#0F172A`.** The skill's own Common Rules require `#0F172A` for light-mode body text and `#475569` minimum for muted. Blue body text fails both, and at 14 px on a phone in a bright hall it is measurably harder to read. |
| CTA | `#F59E0B` (amber) | ⚠️ **Overridden → primary blue.** Amber must be reserved for **warning** semantics. This product is a state machine; using one amber for "primary button" and "you are offline" would create exactly the confusion we are trying to eliminate. |
| Typography | Fira Code headings + Fira Sans body | ⚠️ **Refined.** Fira Sans for *all* interface text. Fira **Mono** reserved for applicant IDs, clock times and counts. Monospace headings look like a terminal; monospace IDs make `SPH-SP26-0042` instantly scannable and stop digits jittering as counters tick. |
| State colours | *(not provided)* | ➕ **Added.** The single most important decision here, and the skill has no state system. See 18.3. |

## 18.2 Tokens

```
COLOUR
  primary          #1E40AF     primary-hover   #1D4ED8
  secondary        #3B82F6     focus-ring      #3B82F6 @ 3px offset 2px
  background       #F8FAFC     surface         #FFFFFF
  border           #E2E8F0     border-strong   #CBD5E1
  text             #0F172A     text-muted      #475569

TYPE   Fira Sans (UI) · Fira Mono (IDs, times, counts)
  display 32/40 600     h1 24/32 600      h2 20/28 600
  body    16/24 400     small 14/20 400   caption 12/16 500 tracking .04em
  id-xl   28 mono 500   id-md 18 mono 500 id-sm 14 mono 500

SPACE  4 · 8 · 12 · 16 · 24 · 32 · 48        RADIUS 8 · 12 (cards) · 999 (pills)
TOUCH  44 px minimum target · 8 px minimum gap
MOTION 150–250 ms ease-out · honours prefers-reduced-motion
```

## 18.3 State colours — the core of the interface

This product is a queue. Every screen answers "what state am I in?" So state must be legible **before anyone reads a word**.

| State | Colour | Fill | Shape signal |
|---|---|---|---|
| Waiting | `#64748B` slate | `#F1F5F9` | Dot, hollow |
| Live / in progress | `#2563EB` blue | `#EFF6FF` | Dot, pulsing |
| Called — act now | `#D97706` amber | `#FFFBEB` | Solid bar, left edge 4 px |
| Complete | `#059669` emerald | `#ECFDF5` | Check |
| Blocked / error | `#DC2626` red | `#FEF2F2` | Cross |
| Offline / degraded | `#B45309` dark amber | diagonal stripes | Banner + stripe pattern |

**Colour is never the only indicator.** Each state carries a distinct icon *and* a distinct shape. This is a WCAG requirement, and it is also just correct: about 1 in 12 men has a colour-vision deficiency, and at a university induction that is several people in the hall — including, statistically, one of your volunteers.

## 18.4 Anti-patterns for this product

The skill flags *ornate design* and *no filtering* generically. These are the ones specific to a live event:

| Never | Why |
|---|---|
| Confirmation dialog on check-in | 200 scans × one tap = 200 chances to double-tap and 200 wasted seconds |
| Red for "already checked in" | It is not an error; red in front of a nervous applicant reads as *you have a problem* |
| Spinner with no context on the applicant page | Someone waiting 40 minutes needs "we are reconnecting," not an ambiguous circle |
| A single precise ETA ("14 minutes") | Read as a promise; every broken promise costs trust |
| Names on the public display board | Avoidable privacy leak, and social pressure in a room full of peers |
| Score or rank anywhere an interviewer can see | Destroys independence, which is the entire point of blind evaluation |
| Auto-advancing the panel screen | An interviewer mid-sentence must never have the screen change under them |

---

# 19. Screen specifications

## 19.1 Applicant status page — the highest-stakes screen

Two hundred anxious people will stare at this for up to an hour. It must answer three questions **without scrolling and without being read**: *Am I in? Where am I? What do I do now?*

**Structure, top to bottom:**

```
1  ID chip        SPH-SP26-0042   — mono, always visible, top of the screen
2  Status band    full-width, state-coloured, icon + one line
3  The one number position, or room number when called — the largest thing on screen
4  Supporting     estimated range, or the instruction when called
5  Guidance       one sentence, plain language
6  Liveness       "Live · updated just now" or "Reconnecting · updated 10:41"
```

**States:**

| State | Band | The one number | Guidance |
|---|---|---|---|
| Registered | Slate | — | "Check in at the desk when you arrive" |
| Checked in | Blue, pulsing | **12** | "Stay in the building — we'll call you here" |
| Position ≤ 3 | Blue, pulsing | **2** | "Almost your turn — stay nearby" |
| **Called** | **Amber, full bleed** | **ROOM 2** | "Go now — 5 minutes" + "I'm on my way" button |
| Skipped | Amber | — | "We called and missed you — see the desk" |
| In interview | Blue | — | "Good luck" |
| Complete | Emerald | — | "Results by 18 March" |
| Result | Emerald / slate | Department | Accept / Decline, deadline visible |

**Micro-decisions that carry real weight:**

- **The called state takes over the whole screen.** Colour, size, and the only button. Missing your call because the room number sat in a corner is the worst avoidable outcome on the page.
- **"I'm on my way" is one 44 px tap**, disabled after use with the text changed to "Extended — 2 extra minutes." It reduces skips, and each avoided skip is an argument that never happens at the desk.
- **Never show a spinner alone.** Every reconnecting state keeps the last known number visible with an explicit timestamp. Blanking the screen on someone in position 3 is cruel.
- **No other applicant's data appears anywhere** — enforced by RLS, not by the template.
- **The ETA is a range**, and if it rises the reason appears with it.

## 19.2 Volunteer scanner

The eight-second screen. Optimised for one-handed use, in a queue, under fluorescent light.

```
┌────────────────────────────┐
│ Desk 1 · Day 1   ● Live    │   connection state, always visible
│                            │
│    [ live camera, always   │   NOT a "tap to scan" button
│      running, 60% height ] │
│                            │
│ ─────────────────────────  │
│  [ Search by name or ID ]  │   44 px, always reachable by thumb
└────────────────────────────┘
```

**Result overlay** — covers the camera for 2.5 s, then auto-clears:

| Outcome | Colour | Content | Dwell |
|---|---|---|---|
| Success | Emerald | ID (mono, 28 px) · name · track · position | 2.5 s auto |
| Already checked in | **Amber** | "Checked in 10:14 · Position 12" | 2.5 s auto |
| Not eligible | Red | Reason + "See Coordinator" | **Requires dismissal** |
| Invalid code | Red | "Not a valid SOPHEP code" + Search button | Requires dismissal |
| No record | Blue | "Register & check in" primary action | Requires dismissal |

Successes auto-clear so the volunteer never taps. Failures require a dismissal, because a failure that scrolls past unnoticed becomes a person nobody checked in.

**Offline banner** is persistent, amber, striped, with a live pending count and a "3 pending sync" tap target that lists them. It is the difference between a volunteer who trusts the device and one who starts keeping a paper list in parallel out of anxiety.

## 19.3 Panel screen

Three states, and the transitions between them are the whole design.

**Idle** — one enormous **Call Next** button (minimum 56 px tall), with waiting count for this track, and the parked count if any. Nothing else, so a tired interviewer cannot mis-tap into something destructive.

**Called** — applicant name and ID, a visible countdown of the grace window, and two actions: **Start** and **Mark absent**. Both large, well separated, no confirmation on Start.

**In interview** — profile and answers on the left, rubric on the right. Each criterion shows its anchors inline; you should not have to remember what 3 means. Elapsed timer against target, amber past target, but **never blocking**. Submit is disabled until every criterion is scored, with missing ones marked inline rather than by a single error at the bottom.

**Awaiting evaluations** — this state exists because it is now representable (E10). It shows exactly who has not submitted, and the Coordinator waiver action. The panel cannot Call Next, and the screen says *why* in one sentence — never a greyed-out button with no explanation.

## 19.4 Coordinator ops dashboard

Data-dense by design. Everything that needs a human, ranked by urgency, on one screen.

```
Row 1  Waiting · In interview · Completed · Parked · Panels open       KPI strip
Row 2  ACTION REQUIRED                                                 red / amber
       - 2 panels flagged, no heartbeat 90+ min
       - 3 applicants parked, need locating
       - 1 evaluation outstanding (Room 3, A. Khan)
       - Track "Design" has no open panel
Row 3  Live queue, sortable, with priority-bump action per row
Row 4  Panels: status, current applicant, elapsed, throughput
```

**Action Required is the top of the page and never empty-by-omission** — when there is nothing to do it says so explicitly. A blank area is ambiguous; "All clear" is information.

## 19.5 Public display board

IDs only. No names. Large mono type readable at 15 metres, high contrast, no animation beyond a gentle fade on change — motion on a wall screen in peripheral vision is a distraction to everyone waiting.

```
        NOW CALLING
   SPH-SP26-0042  →  ROOM 2
   SPH-SP26-0043  →  ROOM 4

   Waiting 23  ·  Average wait ~20 min
```

## 19.6 Accessibility floor

- Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI boundaries.
- Every state carries an icon and a shape, not only a colour.
- Touch targets ≥ 44 px with ≥ 8 px gaps.
- Visible focus rings; full keyboard operation of every staff screen.
- `role="alert"` on scan results and errors, so screen readers announce them.
- `prefers-reduced-motion` removes the pulse and all transitions.
- Correct `inputmode` on every field: `tel` for phone, `email` for email, `numeric` for ID search.

---

# 20. Scale path

Honest limits at each stage, correcting v1's overstated claims (E12).

| Applicants | Architecture | Bottleneck |
|---|---|---|
| ≤ 500 (today) | Single Postgres, Supabase Realtime, Vercel | None — this is small |
| ≤ 5,000 | Add read replica for analytics; queue index already correct | Realtime fan-out |
| ≤ 50,000 | Shard `applicant_seq` into 8 counters per cycle, ID becomes `SPH-SP26-3-0041`; partition `audit_events` by month | Registration counter, audit table growth |
| Multi-society | `society_id` on every root table; RLS extended to society scope; per-society Ed25519 keys | Tenant isolation review |

**What does not need to change at any of these:** the queue claim query (`SKIP LOCKED` scales linearly with panels, not applicants), the state machines, the permission model, the audit design. Those are the expensive things to retrofit, which is why they are correct from day one.

**What is genuinely hard to retrofit later** — build these right now: cycle scoping on every table, the append-only audit log, state ownership (§4), and the queue claim semantics.

---

# 21. Build phases

| Phase | Weeks | Contents | Ships |
|---|---|---|---|
| 1 Foundations | 1–2 | Cycles, stages, departments, roles, RLS, audit, ID generation, online form, status page | You can accept applications |
| 2 Event core | 3–4 | Tokens + QR, check-in (all three sources), dedupe, **queue engine**, panels, skip/park, display board | **You can run interview day** |
| 3 Evaluation | 5 | Rubrics with anchors, interviewer screen, submission, revisions, recusals, waiver, ops dashboard | Structured scoring |
| 4 Decisions | 6 | Shrinkage, flags, review queue, allocation, dual-control lock, dry run, publish, offers, cascade | End-to-end recruitment |
| 5 Resilience | 7 | Offline PWA, reconciliation, heartbeats, failure drills | Confidence |
| 6 Refinement | 8+ | Slot booking, capacity simulator, analytics, exports, SMS nudge | Polish |

**If you only have three weeks:** build Phases 1 and 2, run scoring on paper for one cycle, add 3–4 before the next induction. Do **not** skip Phase 2's queue engine to build the scoring UI first — the queue is what makes the day survivable, and it is the one part you cannot improvise on the floor.

---

# 22. Event-day runbook

**Pre-event checklist** — every item has a real failure behind it.

- [ ] Stages configured; interview stage **not** yet active
- [ ] Departments, capacities, rubric versions confirmed
- [ ] All interviewers logged in once, TOTP set up
- [ ] Panels created, rooms mapped, panel–track assignments verified
- [ ] **Capacity model run** — throughput vs applicant count is feasible (§14.2)
- [ ] Devices charged; roster synced; **offline mode tested by switching WiFi off**
- [ ] **Printed roster produced** (by ID and by surname)
- [ ] Display board tested on the actual TV at the actual resolution
- [ ] Email templates previewed; a test send read on a phone
- [ ] Backup restore tested within 7 days
- [ ] Coordinator identified; escalation path written on the desk
- [ ] Spare device available and logged in
- [ ] Dry run: register a fake applicant → check in → interview → score → complete → delete

**On the day:** open the stage; open panels; confirm every panel shows "Live"; watch the ops dashboard's Action Required block, not the queue. If Action Required is empty and panels are busy, the system is working and you should be talking to applicants, not looking at a screen.

---

# 23. Open questions

Defaults are assumed so nothing blocks, but these change the build.

1. **Panel size** — 1, 2 or 3 interviewers? Drives throughput more than any other decision. *Assumed: 2.*
2. **Interview structure** — one general interview, or one per department preference? *Assumed: one general, department fit as a rubric criterion plus recommendation.*
3. **Preferences** — how many departments may be ranked? *Assumed: up to 3.*
4. **Multi-department placement** — can one person join two? *Assumed: no.*
5. **Second round** — needed? Schema supports it via `queue_entries.round`; the UI does not exist yet.
6. **Publication style** — individual emails only, or a public list of selected IDs? *Assumed: individual only. A public list is a privacy decision for your committee.*
7. **Offer deadline** — *Assumed: 5 days.*
8. **Slot booking** — adopt it? *Strongly recommended; highest-value single addition.*
9. **Interview length target** — feeds every estimate and the capacity model. *Assumed: 12 minutes.*
10. **Waiver policy** — may a Coordinator waive a missing evaluation, or must a Super Admin? *Assumed: Coordinator, audited.*

---

# 24. Summary

v2 corrects fifteen defects in v1, three of them serious: a QR scheme that would have shipped the signing secret to every volunteer's phone; a scoring scale whose thresholds were calibrated for a different scale entirely; and an averaging rule that mixed two incommensurable number systems.

What the design is now:

- **Structurally safe:** IDs that cannot collide, a queue that cannot double-assign, an audit log that cannot be edited, and a security boundary that fails closed.
- **Honest under stress:** estimates that revise when the truth changes and say why; a check-in path that keeps working with no network and no secret on the device.
- **Fair by construction:** blind evaluation enforced at the row level, interviewer strictness corrected without cliffs, disagreement surfaced rather than averaged away, and an allocation that returns the same answer every time it runs.
- **Legible under pressure:** an interface where state is visible before a word is read, where the highest-stakes moment takes over the whole screen, and where colour is never the only signal.

Build Phases 1 and 2 properly. The rest can follow at your own pace.
