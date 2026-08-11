# Phase 4 — Scoring, allocation and decisions

**Status: planned, not started.** This is the phase that decides who gets in, so it is planned
in full and the open decisions are surfaced before any of it is written.

Phase 4 differs from 1–3 in one important way. Those phases could be wrong and then fixed —
a broken queue is embarrassing on the day and repairable the next. **A wrong allocation is
not repairable.** It produces a defensible-looking outcome that is wrong, someone is rejected
who should not have been, and the audit trail faithfully records the wrong answer. So this
phase is planned before it is built, and every arbitrary choice is written down rather than
buried in code.

---

## 1. What Phase 4 does, in order

```
evaluations (Phase 3)
      │
      ├─ 4A  compute shrinkage ──────► adjusted scores, cycle-wide
      │
      ├─ 4B  raise flags ────────────► HIGH_DISAGREEMENT, CRITERION_FLOOR,
      │                                LOW_CONFIDENCE, SINGLE_EVALUATOR
      │
      ├─ 4C  review bands ───────────► clear / discuss / below, relative to capacity
      │                                (a human meeting happens here)
      │
      ├─ 4D  allocation ─────────────► deferred acceptance, deterministic
      │
      ├─ 4E  dual-control lock ──────► immutable checksummed snapshot
      │
      ├─ 4F  dry run + publish ──────► notices dispatched
      │
      └─ 4G  offers + cascade ───────► 1-day expiry, hourly cascade
```

Each stage gates the next. `FR-DEC-001`–`003` make that explicit: allocation refuses to run
while any interview is incomplete, before shrinkage is computed, or while any active
department lacks a capacity.

---

## 2. Scoring (4A, 4B)

### Shrinkage — `FR-SCR-002`, errata E2/E3

```
cohort_mean = mean(raw) across EVERY evaluation in the cycle
n           = evaluations submitted by this interviewer
w           = n / (n + 5)
bias        = interviewer_mean − cohort_mean
adjusted    = raw − (w × bias)
```

| n | w | effect |
|---|---|---|
| 1 | 0.17 | almost none — one data point proves nothing about a person's strictness |
| 5 | 0.50 | half correction |
| 12 | 0.71 | substantial |
| 30 | 0.86 | near-full |

`adjusted` stays on the **same 0–100 scale as raw**, so the two are directly comparable and
both are stored and displayed side by side (`FR-SCR-004`, `FR-SCR-014`). Combining scores on
different scales is forbidden (`R-023`) — that was errata E3, and it created a cliff where an
interviewer's 8th evaluation retroactively rescaled the previous seven.

Computed at **review time** against the complete distribution, never at submission
(`FR-SCR-005`): the correction depends on data that does not exist until everyone has finished.

**Applicant final score** = arithmetic mean of adjusted across their evaluations (`FR-SCR-006`).

### Flags — `FR-SCR-007`–`010`

| Flag | Condition | Why it matters |
|---|---|---|
| `HIGH_DISAGREEMENT` | adjusted spread across the panel > 20 | the case where a human adds most value |
| `CRITERION_FLOOR` | any criterion in the bottom quarter of the scale | a strong signal a high average can hide |
| `LOW_CONFIDENCE` | every evaluator has n < 5 | the bias estimate is weak; read raw |
| `SINGLE_EVALUATOR` | only one evaluation exists | no agreement signal at all |

> **Deviation to note.** `FR-SCR-008` says "any criterion scored 2 or below on a 5-point scale".
> Our rubrics carry a configurable scale, so a literal `≤ 2` would mean different things on a
> 1–5 and a 0–10 rubric. I will implement it as `score ≤ min + 0.25 × (max − min)`, which is
> exactly `≤ 2` on the 1–5 scale the spec assumes and generalises correctly. Flagged as a
> deliberate reading of the requirement, not a silent change.

---

## 3. Review bands (4C) — `FR-SCR-011`, errata E2

Bands are **relative to department capacity `C`**, never absolute scores:

```
rank ≤ 0.75C          clear admit — no meeting time needed
0.75C < rank ≤ 2C     DISCUSS at the review meeting
rank > 2C             below the line
any flag              forced into DISCUSS          (FR-SCR-012)
CRITERION_FLOOR       auto-excluded, override only (FR-SCR-013)
```

For an 8-place department: ranks 1–6 clear, 7–16 discussed, 17+ below. Roughly ten
discussions per department — a review meeting that finishes.

This is the E2 correction. v1 used absolute thresholds calibrated for one scale and applied
them to another, so auto-shortlist fired for about one person in 200 while the "discuss" band
swallowed 30% of the cohort.

---

## 4. Allocation (4D) — `FR-DEC-005`–`007`, errata E8

**Applicant-proposing deferred acceptance** (Gale–Shapley). Applicants rank departments on
their form; departments rank applicants by a **total, deterministic** chain:

```
1. final adjusted score          descending
2. "recommend for this dept"     descending   (interviewer recommendation count)
3. panel score spread            ascending    (agreement breaks ties)
4. application submitted_at      ascending
5. applicant_id                  ascending    ← guarantees totality
```

Levels 4 and 5 are arbitrary, **and that is the point**. They make the ordering total, so the
algorithm returns an identical result every run. v1 stopped at level 1, and scores tie
frequently on a coarse rubric — so re-running could produce a different valid matching, which
is indefensible when someone asks why they ranked below a person with the same score.

**Pre-flight gates**, all four before anything runs:
1. every interview `complete` or explicitly voided (`FR-DEC-001`)
2. shrinkage computed (`FR-DEC-002`)
3. every active department has a capacity (`FR-DEC-003`)
4. no other allocation holds the advisory lock (`FR-DEC-004`)

**Determinism is a test, not a claim** — run twice, diff the output byte for byte (`FR-DEC-007`).

Every outcome is overridable by a Super Admin with a written reason, creating a **new decision
version** and retaining the prior one (`FR-DEC-009`, `DR-008`). The algorithm proposes, humans
decide — but the default is defensible and the overrides are visible.

---

## 5. Lock, dry run, publish (4E, 4F)

```
1. Coordinator marks review complete
2. President        → "Lock results"  → LOCK_PENDING
3. General Secretary → "Confirm"      → RESULTS_LOCKED   (must be a DIFFERENT user)
4. Immutable snapshot written, with checksum
5. Dry run
6. Publish
```

Dual control is already enforced by a database constraint on `cycles`
(`lock_confirmed_by <> locked_by`, migration 0003). Ten extra seconds removes an entire
category of "who published this" from the society's future.

**The dry run** (`FR-DEC-012`–`014`) reports recipient count, per-outcome breakdown, at least
three rendered sample messages, validates every recipient address and checks for prior hard
bounces, and verifies **no applicant in state `selected` lacks a department**.

Publication requires re-authentication with second factor and a typed confirmation
(`FR-DEC-015`). Post-publication corrections create a new decision version and a distinct
correction notice — **the snapshot is never mutated** (`FR-DEC-016`, `DR-007`).

---

## 6. Offers and cascade (4G)

Committee decisions already locked:

| | Value | Note |
|---|---|---|
| Offer expiry | **24 hours** | overrides the spec's 5 days |
| Reminder | **T−6h** | the spec's T−48h is impossible against a 24h expiry |
| Cascade interval | **hourly** | forced by the short expiry — a daily sweep would leave a released seat idle past the point anyone could accept |

```
Offer ─┬─ accept  → ACCEPTED → ONBOARDED
       │             └─ late withdrawal → DECLINED, seat released, cascade
       ├─ decline → cascade
       └─ expire  → cascade

Cascade for that department:
  1. take the top-ranked waitlisted applicant
  2. still eligible and not placed elsewhere? no → mark lapsed, take the next
  3. send offer, fresh 24-hour clock
  4. notify Super Admins, write an audit event
  stop: waitlist exhausted (department closes under capacity, notified) or manually paused
```

---

## 6a. DECISIONS TAKEN — and how they reshape this phase

These were answered before implementation began. Two of them change the shape of the phase,
not just its configuration.

| Decision | Answer |
|---|---|
| Walk-ins with no preferences | **Collect before review closes** — a fifth pre-flight gate |
| Publication | **The offline meeting decides.** The system stores scores and records outcomes |
| Email | **None for cycle one.** Status page only |
| Dual control | Two real Super Admins: President and General Secretary |

### The big one: allocation PROPOSES, the meeting DECIDES

The committee will hold an on-site meeting, choose who is in, and announce it themselves.
That is a legitimate and common way to run an induction, and the specification already
anticipates it — *"the algorithm proposes, humans decide"* (§11.2). But it changes what the
most important deliverable is.

**It is no longer the publish pipeline. It is the review meeting screen.**

Concretely:

- Deferred acceptance still runs, and still matters. It gives the meeting a **defensible
  starting point** that respects capacity and preference, computed identically every time.
  Without it, a meeting of tired people allocates 200 applicants across 4 departments by
  argument, and cannot answer "why them and not me" three weeks later.
- Its output is labelled a **proposal**, everywhere, in the UI and in the data. Nothing
  becomes an outcome because the algorithm said so.
- Every departure from the proposal is an **override with a written reason**, creating a new
  decision version and retaining the prior one (`FR-DEC-009`). The meeting's reasoning becomes
  the record.
- The **dual-control lock still applies**, and is now the moment the meeting's decisions
  become final and visible. It is not decoration: it is what separates "we discussed this" from
  "this is the outcome".

### What this removes from Phase 4

- **No email adapter.** Notices queue to the `notifications` table for the record, and nothing
  is dispatched. `FR-NOT-002` bounce handling is meaningless without a provider and is
  deferred with it.
- **No publication dry run against real recipients.** The `FR-DEC-014` check — that no
  applicant in state `selected` lacks a department — still runs, because that one catches a
  data error rather than a delivery error.

### What this ADDS

- **A results export** for the committee to build their announcement posts from — selected
  applicants per department, in decision order.
- **The review meeting screen** gets the care that would otherwise have gone into publishing:
  raw and adjusted side by side (`FR-SCR-014`), flags surfaced, bands pre-computed, and an
  override that demands a reason.

---

## 7. Decisions I need before building

These change the design, not just the copy. Defaults are recorded but I would rather not
assume on the ones marked **committee**.

### 7.1 ⚠ Walk-ins have no department preferences — a real gap I found

`fn_register_and_checkin` (the 30-second desk path, `FR-CHK-010`) creates an applicant with
**no ranked preferences**, because a walk-in with a queue behind them cannot fill in a form.

Deferred acceptance is **applicant-proposing**: an applicant with an empty preference list
proposes to nobody and is therefore **unmatchable**. They would be interviewed, scored,
and then silently allocated nothing.

Neither the spec nor the JSON addresses this. It needs a decision — options in the question below.

### 7.2 OI-6 — publication style *(committee)*

Individual notices only, or also a public list of selected identifiers? The spec calls this
"a privacy decision for your committee" and assumes individual only. A public list is
irreversible once posted.

### 7.3 Email has no provider

There is still no Resend account and no verified sending domain. Everything queues to the
mock adapter and renders at `/dev/notifications`. **Results cannot actually be delivered.**
How should cycle one publish?

### 7.4 Dual control needs two real Super Admin accounts

`FR-DEC-010` requires two *distinct* authenticated Super Admins, enforced by DB constraint.
If only one real account exists, results cannot be locked at all — by design.

### 7.5 Assumptions I will proceed on unless told otherwise

| ID | Assumption | Basis |
|---|---|---|
| OI-4 | An applicant is placed in **at most one** department | spec default |
| `FR-SCR-013` | `CRITERION_FLOOR` **auto-excludes**, subject to Super Admin override | spec default |
| `FR-SCR-008` | Floor = bottom quarter of the rubric scale | generalises the spec's "≤2 of 5" |
| Shrinkage `k` | 5 | `FR-SCR-002`, already in cycle config |
| Bands | 0.75C / 2C | `FR-SCR-011`, already in cycle config |
| Rounding | scores stored `numeric(5,2)`; comparisons on the stored value, never a float | determinism |

---

## 8. Build order

| # | Stage | Proven by |
|---|---|---|
| 4A | Shrinkage + flags | golden dataset with hand-computed expected values |
| 4B | Review bands + review queue | band boundaries at exactly 0.75C and 2C |
| 4C | **Allocation** | **run twice → byte-identical**; stability; a worked example by hand |
| 4D | Lock + snapshot | same Super Admin cannot do both steps |
| 4E | Dry run + publish | no `selected` applicant without a department |
| 4F | Offers + cascade | decline → next eligible promoted, placed-elsewhere skipped and lapsed |

**4C before 4D.** Allocation is the part that cannot be improvised or corrected later, and
everything downstream is meaningless if it is wrong.

Golden-dataset tests use a **fixed, hand-computed** fixture so the expected output is derived
from the specification rather than from whatever the code currently produces — a golden file
generated by the implementation only proves the implementation is stable, not correct.
