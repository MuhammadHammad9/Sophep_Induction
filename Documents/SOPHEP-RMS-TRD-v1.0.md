# Technical Requirements Document
## SOPHEP Recruitment Management System (RMS)

**Document ID:** SOPHEP-RMS-TRD-001
**Version:** 1.0
**Status:** Draft for review
**Conformance:** ISO/IEC/IEEE 29148:2018 (Requirements Engineering)
**Supersedes:** none
**Related:** SOPHEP-RMS-ARCH-002 (Architecture & UX Specification v2.0), SOPHEP-RMS-FLOWS-v2 (Figma, 11 boards)

---

## Document control

| Field | Value |
|---|---|
| Owner | SOPHEP President / General Secretary |
| Technical authority | Engineering lead |
| Review cycle | Per induction cycle, or on material scope change |
| Classification | Internal — contains no applicant PII |

### Revision history

| Ver | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-08-11 | Engineering | Initial issue, derived from Architecture Spec v2.0 |

### Approval

| Role | Name | Signature | Date |
|---|---|---|---|
| President | | | |
| General Secretary | | | |
| Engineering lead | | | |
| Faculty advisor (data protection) | | | |

**This document is not baselined until all four approvals are recorded.** Requirements marked `TBD` in §13 must be resolved before Phase 2 development begins.

---

## Conventions

**Requirement language** (RFC 2119 / ISO 29148 §5.2.4):

| Term | Meaning |
|---|---|
| **shall** | Mandatory. Absence is a defect. |
| **should** | Recommended. Omission requires a recorded justification. |
| **may** | Optional. |

Every requirement is **atomic** (one testable assertion), **uniquely identified**, **verifiable**, and **traceable**. Requirements containing "and/or", "etc.", "as appropriate", or "user-friendly" have been rejected during authoring as unverifiable.

**Identifier scheme:** `<TYPE>-<DOMAIN>-<NNN>`

**Priority (MoSCoW):** `M` Must (Phase 1–2 blocking) · `S` Should · `C` Could · `W` Won't this release

**Verification method (VM):**

| Code | Method | Evidence |
|---|---|---|
| **T** | Test | Automated test case, named in §12 |
| **D** | Demonstration | Witnessed execution against acceptance criteria |
| **I** | Inspection | Code, schema, or configuration review |
| **A** | Analysis | Load test report, model, or calculation |

---

# 1. Introduction

## 1.1 Purpose

This document specifies the complete set of technical requirements for the SOPHEP Recruitment Management System: a cycle-based, role-scoped, real-time platform for managing society induction from application through interview to department allocation and offer acceptance.

It is the contract between the SOPHEP committee and the implementing engineers. It defines *what* the system shall do and how each requirement is verified. It does not prescribe implementation beyond where a specific mechanism is itself a requirement (for example, the atomicity guarantees in FR-QUE-002).

## 1.2 Scope

**In scope:**

- Applicant registration via three channels (online, walk-in digital, walk-in paper transcription)
- Identity issuance: applicant IDs, access tokens, QR codes
- Event-day check-in, including operation without network connectivity
- Queue management, room and panel assignment, no-show handling
- Structured interview evaluation with bias correction
- Capacity-constrained department allocation
- Result publication, offers, and waitlist management
- Role-based access control and audit
- Multi-cycle historical record keeping

**Out of scope for this release:**

| Item | Rationale |
|---|---|
| Payment or fee collection | SOPHEP induction is free |
| Native mobile applications | PWA meets all stated needs at lower cost |
| Post-onboarding member management | Separate system; RMS exports a roster |
| Automated CV parsing or ML ranking | Fairness risk disproportionate to benefit at this scale |
| Multi-society tenancy | Schema accommodates it (§20 of ARCH-002); not implemented |
| SMS / WhatsApp notification | Deferred to Phase 6 |

## 1.3 Definitions

| Term | Definition |
|---|---|
| **Cycle** | One complete induction round (e.g. Spring 2027). Top-level container for all data. |
| **Stage** | A scheduled phase within a cycle (Registration, Interview Day 1, Review, Decisions). |
| **Track** | A queue lane. Usually one per department, or a single shared `general` track. |
| **Panel** | A session: the set of interviewers occupying a room for a shift. The unit that pulls from the queue. |
| **Room** | A physical location. Distinct from Panel. |
| **Grace window** | The period after an applicant is called before they are marked skipped. |
| **Parked** | Removed from the active queue after repeated non-attendance; requires manual reactivation. |
| **Shrinkage** | Empirical-Bayes correction of interviewer strictness (§10.2, ARCH-002). |
| **Dual control** | An action requiring confirmation by two distinct authenticated Super Admins. |
| **Projection** | A derived field written only by the owning transition function (§4, ARCH-002). |

## 1.4 References

| Ref | Document |
|---|---|
| R1 | SOPHEP-RMS-ARCH-002 — Architecture & UX Specification v2.0 |
| R2 | SOPHEP-RMS-FLOWS-v2 — Corrected flow diagrams, Figma (11 boards) |
| R3 | ISO/IEC/IEEE 29148:2018 — Requirements engineering |
| R4 | W3C WCAG 2.1 Level AA |
| R5 | OWASP Application Security Verification Standard v4.0, Level 2 |
| R6 | Pakistan Personal Data Protection Bill (draft) — applied as best practice |

---

# 2. Stakeholders and user classes

| Class | Population | Technical proficiency | Environment | Primary need |
|---|---|---|---|---|
| Applicant | 100–1,000/cycle | Mixed | Own phone, campus WiFi or cellular | Know their status without asking anyone |
| Volunteer | 6–20 | Low; trained on the day | Society or own phone, standing, noisy hall | Check someone in without thinking |
| Interviewer | 8–30 | Mixed | Laptop or tablet, seated | Evaluate without distraction or influence |
| Coordinator | 1–3 | Moderate | Laptop, mobile between rooms | See what needs a human, now |
| Admin (Head Batch) | 2–5 | Moderate | Laptop | Manage applicant data |
| Super Admin (President, GS) | 2 | Moderate | Laptop | Decide outcomes defensibly |
| Auditor (faculty advisor) | 0–2 | Low | Laptop | Verify without ability to alter |

**Design consequence:** the Volunteer class has the lowest proficiency, the highest time pressure, and the worst physical environment. Where requirements conflict, Volunteer ergonomics take precedence (see NFR-USE-001).

---

# 3. System context

```
                    ┌───────────────────────────┐
   Applicant ──────▶│                           │◀────── Volunteer (PWA, offline-capable)
   (token URL)      │                           │
                    │   SOPHEP RMS              │◀────── Interviewer (panel screen)
   Display board ◀──│                           │
   (read-only)      │   Postgres + RLS          │◀────── Coordinator (ops dashboard)
                    │   Realtime broadcast       │
   Email (Resend)◀──│   Object storage (CVs)     │◀────── Super Admin (decisions)
   + webhooks  ────▶│                           │
                    └───────────────────────────┘
                                 │
                          Auditor (read-only)
```

**External interfaces:** transactional email provider with delivery webhooks; object storage for CV files; identity provider (optional society SSO). No other external dependency is permitted in the critical event-day path — see CON-004.

---

# 4. Functional requirements — Cycle and stage management

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-CYC-001 | The system **shall** support an unbounded number of induction cycles, each identified by society code, season (SP/FA/SU) and year, unique in combination. | M | T | R1 §3.1 |
| FR-CYC-002 | Each cycle **shall** hold its own applicants, departments, tracks, rooms, panels, rubrics, queue entries, evaluations and decisions, with no data shared across cycles except user accounts. | M | I | R1 §2 |
| FR-CYC-003 | The system **shall** enforce a cycle state machine with the states: `draft`, `registration_open`, `registration_closed`, `interviews_active`, `interviews_closed`, `under_review`, `results_locked`, `published`, `archived`. | M | T | R1 §5.3 |
| FR-CYC-004 | Every write endpoint **shall** validate the cycle state before executing, and **shall** reject impermissible operations with HTTP 409 and code `STAGE_CLOSED` or `CYCLE_ARCHIVED`. Validation **shall not** rely on the user interface. | M | T | R2 v2-09 |
| FR-CYC-005 | A cycle in state `archived` **shall** be read-only at the database level. No API endpoint shall exist that hard-deletes a cycle or its child records. | M | I | R1 §5.3 |
| FR-CYC-006 | The system **shall** support scheduled stages of type `registration`, `interview`, `review`, `decision`, each with a start and end instant. | M | T | R1 §5.3 |
| FR-CYC-007 | Stage transitions **shall** occur automatically at their scheduled instant, and **shall** be manually overridable by a Coordinator or Super Admin at any time. | M | D | R1 §5.3 |
| FR-CYC-008 | The system **shall** block closure of an interview stage while any interview is in state `in_progress`, and **shall** return the list of blocking interviews with their room and panel. | M | T | R2 v2-08 |
| FR-CYC-009 | The system **shall** block closure of an interview stage while any interview is in state `awaiting_evaluations`, and **shall** return the outstanding evaluations grouped by interviewer. | M | T | R2 v2-08 |
| FR-CYC-010 | On stage closure, the system **shall** transition all `parked` applicants to `no_show` and **shall** record an audit event for each. | M | T | R2 v2-08 |
| FR-CYC-011 | On stage closure with applicants remaining in `queued` or `called`, the system **shall** present a bulk action to carry them forward to the next interview stage or mark them `no_show`. | S | D | R2 v2-08 |
| FR-CYC-012 | Departments **shall** be created, renamed, disabled and assigned a capacity through configuration, without code deployment. | M | D | R1 §2 |
| FR-CYC-013 | Each cycle **shall** store an IANA timezone, defaulting to `Asia/Karachi`. All instants shall be stored as `timestamptz` and rendered in the cycle timezone. | M | I | R1 §15.4 |

---

# 5. Functional requirements — Identity and tokens

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-IDT-001 | The system **shall** assign each applicant a human-readable identifier of the form `SSS-XXNN-NNNN` (society, season+year, zero-padded per-cycle sequence), e.g. `SPH-SP26-0042`. | M | T | R1 §3.1 |
| FR-IDT-002 | Applicant identifiers **shall** be unique within a cycle and **shall not** be reused across cycles. | M | T | R1 §3.1 |
| FR-IDT-003 | Sequence allocation **shall** be performed by an atomic in-transaction counter increment. Implementations using `SELECT MAX(sequence)+1` **shall** be rejected at code review. | M | I | R2 v2-02 |
| FR-IDT-004 | Under 20 concurrent registration requests, the system **shall** produce zero duplicate identifiers and zero sequence gaps attributable to contention. | M | A | R1 §3.1 |
| FR-IDT-005 | The system **shall** issue each applicant exactly one active access token of at least 128 bits of entropy, encoded URL-safe. | M | I | R1 §3.2 |
| FR-IDT-006 | The system **shall** store only `sha256(token)`. The raw token **shall not** be persisted in any database, log, or backup. | M | I | R1 §3.2 |
| FR-IDT-007 | Each token **shall** be signed with the cycle's Ed25519 private key. The private key **shall not** be transmitted to any client device under any circumstance. | M | I | R2 v2-01 |
| FR-IDT-008 | The QR code payload **shall** be a fully-qualified HTTPS URL of the form `https://<host>/q/<token>.<signature>`, resolvable by any standard camera application. | M | D | R1 §3.2 |
| FR-IDT-009 | Token rotation **shall** revoke the previous token immediately and atomically. | M | T | R1 §3.2 |
| FR-IDT-010 | Token lookup endpoints **shall** be rate-limited to 10 requests per minute per source IP and **shall** use constant-time comparison. | M | T | R1 §17 |
| FR-IDT-011 | Each cycle **shall** use a distinct Ed25519 keypair, such that a token issued in a prior cycle fails signature verification in the current cycle. | M | T | R1 §3.2 |
| FR-IDT-012 | Tokens **shall** expire 60 days after the cycle's final decision date. | S | T | R1 §3.2 |

---

# 6. Functional requirements — Registration

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-REG-001 | The system **shall** accept registrations through three channels: online self-service, walk-in digital entry by a volunteer, and walk-in paper transcription. | M | D | R2 v2-02 |
| FR-REG-002 | All three channels **shall** produce identical record structure, identifier format, token issuance and QR generation. No channel shall produce a second-class record. | M | I | R1 §3.3 |
| FR-REG-003 | All input **shall** be validated server-side against a schema. Client-side validation **shall not** be the sole gate. | M | T | R2 v2-02 |
| FR-REG-004 | The system **shall** normalise email addresses by lowercasing, trimming, and — for `gmail.com` and `googlemail.com` domains only — removing dots and `+`-suffixes from the local part. | M | T | R1 §15.1 |
| FR-REG-005 | The system **shall** normalise phone numbers to the final 9 digits after removing all non-numeric characters. | M | T | R1 §15.1 |
| FR-REG-006 | On exact match of normalised email, normalised phone, or roll number within the same cycle, the system **shall** block the registration and display the existing record. | M | T | R2 v2-02 |
| FR-REG-007 | A blocked registration **shall** offer two resolutions: proceed to check-in for the existing record, or override as a distinct person. | M | D | R2 v2-02 |
| FR-REG-008 | Override **shall** require a free-text reason of at least 10 characters, **shall** persist that reason on the record, and **shall** write an audit event. | M | T | R2 v2-02 |
| FR-REG-009 | Uniqueness constraints **shall** be implemented such that a reasoned override succeeds. A constraint that makes FR-REG-007 unsatisfiable is a defect. | M | I | R1 §0 E4 |
| FR-REG-010 | On trigram name similarity ≥ 0.85 combined with a shared department preference, the system **shall** display a dismissible warning without blocking. | S | T | R1 §6.1 |
| FR-REG-011 | Applicants **shall** be able to rank up to *N* department preferences, where *N* is cycle configuration (default 3). | M | T | §13 OI-3 |
| FR-REG-012 | Online registrants **shall** receive a confirmation email containing their identifier, QR code and status page link within 60 seconds of submission. | M | T | R1 §6 |
| FR-REG-013 | Walk-in registrations **shall** produce a printable slip bearing the identifier and QR code. | M | D | R2 v2-02 |
| FR-REG-014 | The system **should** allow online applicants to book a 60-minute arrival window, with per-window capacity derived from the throughput model. | S | D | R1 §6.3 |
| FR-REG-015 | CV upload **shall** accept only `pdf`, `docx`, `png`, `jpg`, **shall** enforce a 10 MB limit, **shall** verify content type by inspection rather than extension, and **shall** virus-scan before acceptance. | M | T | R1 §17 |

---

# 7. Functional requirements — Check-in

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-CHK-001 | The check-in interface **shall** present a continuously active camera. It **shall not** require a tap to initiate scanning. | M | D | R1 §19.2 |
| FR-CHK-002 | A successful check-in **shall** require zero user taps and **shall** auto-dismiss its confirmation after 2.5 seconds. | M | D | R1 §19.2 |
| FR-CHK-003 | A failed check-in **shall** require explicit dismissal and **shall not** auto-clear. | M | D | R1 §19.2 |
| FR-CHK-004 | The device **shall** verify a scanned token offline by computing `sha256` and testing membership in the cached roster, without possessing any secret key. | M | T | R2 v2-01 |
| FR-CHK-005 | For tokens absent from the cached roster, the device **shall** verify the Ed25519 signature using the cycle public key. | M | T | R2 v2-01 |
| FR-CHK-006 | An applicant already checked in for the current stage **shall** receive a non-error (amber) response stating the original check-in time and current queue position. | M | D | R1 §19.2 |
| FR-CHK-007 | The system **shall** permit at most one check-in per applicant per stage, enforced by a database uniqueness constraint. | M | T | R1 §15.2 |
| FR-CHK-008 | Check-in **shall** be idempotent: repeated submission with the same `Idempotency-Key` **shall** return the original response without creating a second record. | M | T | R1 §13.3 |
| FR-CHK-009 | The system **shall** provide manual check-in by search on any 4 consecutive digits of the identifier, the final 4 digits of the phone number, or partial name. | M | D | R1 §19.2 |
| FR-CHK-010 | Where no applicant record exists, the system **shall** provide a combined register-and-check-in action completable within 30 seconds, flagging the record `needs_completion`. | M | D | R1 §7.2 |
| FR-CHK-011 | Where the applicant's track has no panel in status `open`, the system **shall** complete check-in, suppress the wait estimate, and raise an operations alert. | M | T | R1 §7.2 |
| FR-CHK-012 | Check-in **shall** function with no network connectivity for at least 8 continuous hours, buffering at least 500 pending operations locally. | M | T | R1 §7.3 |
| FR-CHK-013 | While offline, the interface **shall** display a persistent indicator using both colour and a non-colour visual treatment, showing the count of unsynchronised operations. | M | I | R1 §18.3 |
| FR-CHK-014 | On reconnection, pending operations **shall** replay in client-timestamp order, each carrying its original `Idempotency-Key`, achieving 100% reconciliation with zero duplicate records. | M | T | R2 v2-01 |
| FR-CHK-015 | Where an offline operation conflicts with one already recorded, the system **shall** retain the earliest server-received record and **shall** write an audit event for the conflict. Silent discard is prohibited. | M | T | R1 §7.3 |
| FR-CHK-016 | Server timestamps **shall** be authoritative for all business logic. Client timestamps **shall** be persisted separately and used only for replay ordering. | M | I | R1 §14.1 |
| FR-CHK-017 | The system **shall** provide a bulk reconciliation interface accepting a list of identifiers, for recovery from full paper fallback. | S | D | R1 §7.3 |
| FR-CHK-018 | The offline roster bundle **shall** contain token hashes and the cycle public key only. It **shall not** contain evaluations, scores, decisions, or any private key material. | M | I | R2 v2-01 |

---

# 8. Functional requirements — Queue management

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-QUE-001 | Applicants **shall** be assigned to a track on check-in. Assignment **shall** be pull-based: a panel requests the next applicant when free. Push assignment is prohibited. | M | I | R2 v2-04 |
| FR-QUE-002 | The claim operation **shall** be atomic. Under 20 concurrent claim requests, each panel **shall** receive a distinct applicant, with zero double assignments. | M | T | R2 v2-04 |
| FR-QUE-003 | Queue ordering **shall** be by priority descending, then enqueue time ascending. | M | T | R1 §8.2 |
| FR-QUE-004 | The system **shall** support the priority tiers: 100 accessibility/void-requeue, 50 punctual slot holder, 30 post-skip return, 10 standard, 5 late slot holder. | M | T | R1 §8.2 |
| FR-QUE-005 | A Coordinator **shall** be able to set any queue entry's priority, subject to a mandatory reason, recorded in the audit log. | M | T | R1 §8.2 |
| FR-QUE-006 | The claim query **shall** exclude applicants against whom any member of the requesting panel has recorded a recusal. | M | T | R2 v2-04 |
| FR-QUE-007 | Recusal exclusion **shall** be implemented such that a NULL in the recusal set cannot suppress the entire result set. | M | I | R1 §0 E7 |
| FR-QUE-008 | On being called, an applicant **shall** enter a grace window of configurable duration (default 5 minutes). | M | T | R1 §8.3 |
| FR-QUE-009 | An applicant **shall** be able to extend their grace window by 2 minutes exactly once per call, from their status page. | S | T | R1 §8.3 |
| FR-QUE-010 | On grace expiry, the entry **shall** transition to `skipped` and the panel **shall** be immediately eligible to claim the next applicant. | M | T | R1 §8.3 |
| FR-QUE-011 | A first skip **shall** requeue the applicant at priority 30 with an effective enqueue time of the current instant minus 10 minutes. | M | T | R1 §8.3 |
| FR-QUE-012 | A second skip **shall** transition the entry to `parked`, removing it from panel-visible queues and adding it to the volunteer worklist. | M | T | R1 §8.3 |
| FR-QUE-013 | Where no entries are in state `waiting` but entries exist in state `parked`, the panel interface **shall** display the parked count and the system **shall** alert volunteers to locate those applicants. | M | D | R2 v2-04 |
| FR-QUE-014 | A parked applicant **shall** be reactivatable by any Volunteer, returning them at priority 30. | M | T | R1 §8.3 |
| FR-QUE-015 | Wait estimates **shall** be computed as `ceil(position / active_panels) × EWMA(service_time)` with smoothing factor 0.3 and a configurable seed (default 12 minutes). | M | T | R1 §8.4 |
| FR-QUE-016 | Wait estimates **shall** be presented as a range. A single point estimate is prohibited. | M | I | R1 §8.4 |
| FR-QUE-017 | Where a recomputed estimate exceeds the previously displayed value, the system **shall** display the revised value together with the cause (position change, panel availability change, or service-time change). Retaining a known-stale value is prohibited. | M | T | R2 v2-05 |
| FR-QUE-018 | Wait estimates **shall** be suppressed during the first 15 minutes of an interview stage and whenever the track has no open panel. | M | T | R1 §8.4 |
| FR-QUE-019 | At queue position 3 or lower, the system **shall** display a qualitative message rather than a numeric estimate. | M | D | R1 §8.4 |
| FR-QUE-020 | Withdrawal of a queued applicant **shall** delete the queue entry within the same transaction as the state change. | M | T | R2 v2-10 |

---

# 9. Functional requirements — Interview and evaluation

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-INT-001 | The system **shall** model Room, Panel and Interviewer as distinct entities. A Panel **shall** reference exactly one Room and one or more Interviewers. | M | I | R1 §2 |
| FR-INT-002 | A panel **shall** hold one of the states: `closed`, `open`, `busy`, `awaiting_evaluations`, `break`. | M | I | R1 §15.2 |
| FR-INT-003 | The interviewer interface **shall** display the applicant's profile, application answers, ranked preferences and CV. | M | D | R1 §9.1 |
| FR-INT-004 | The interviewer interface **shall not** expose any other interviewer's scores or remarks, any aggregate score, any rank, any shortlist status, or the number of available places. Concealment **shall** be enforced by row-level database policy, not by the user interface alone. | M | T | R1 §12.4 |
| FR-INT-005 | Each rubric **shall** define criteria with weights summing to exactly 100, enforced by database constraint. | M | T | R1 §9.2 |
| FR-INT-006 | Each criterion **shall** carry written anchor descriptions for at least its minimum and maximum scale values. A criterion without anchors **shall** be rejected on save. | M | T | R1 §9.2 |
| FR-INT-007 | Rubrics **shall** be versioned. The version in force **shall** be recorded on each evaluation at interview **start**, not at submission. | M | T | R2 v2-06 |
| FR-INT-008 | An interviewer **shall** submit at most one evaluation per interview, enforced by database constraint. | M | T | R1 §15.2 |
| FR-INT-009 | A submitted evaluation **shall** be immutable. Amendment within 15 minutes **shall** create a new revision with a mandatory reason, retaining the original. | M | T | R1 §9.3 |
| FR-INT-010 | Amendment after 15 minutes **shall** require Super Admin unlock, itself recorded in the audit log. | M | T | R1 §9.3 |
| FR-INT-011 | An interview **shall** transition to `complete` only when every panel member has submitted an evaluation, or a Coordinator has waived a specific outstanding evaluation. | M | T | R2 v2-08 |
| FR-INT-012 | A waiver **shall** require a written reason, identify the waived interviewer, and be recorded in the audit log. | M | T | R2 v2-08 |
| FR-INT-013 | While a panel is `awaiting_evaluations`, the claim action **shall** be unavailable and the interface **shall** state which interviewer is outstanding. A disabled control without explanation is a defect. | M | D | R1 §19.3 |
| FR-INT-014 | Panels **shall** emit a heartbeat at 30-second intervals while in `open`, `busy` or `awaiting_evaluations`. | M | T | R1 §14.1 |
| FR-INT-015 | An interview with no panel heartbeat for 90 minutes **shall** transition to `flagged` and appear on the operations dashboard. | M | T | R1 §5.2 |
| FR-INT-016 | A Coordinator **shall** be able to void a flagged interview, requeuing the applicant at priority 100 with a recorded reason. | M | T | R1 §8.2 |
| FR-INT-017 | Any interviewer **shall** be able to record a recusal against any applicant, with an optional reason, at any time. | M | D | R1 §9.4 |
| FR-INT-018 | The system **should** suggest recusal on exact surname match or shared phone prefix. Suggestion **shall not** create a recusal automatically. | S | D | R1 §9.4 |
| FR-INT-019 | The interviewer interface **shall not** auto-advance, auto-submit, or change view without explicit user action. | M | D | R1 §18.4 |
| FR-INT-020 | Submission **shall** be blocked until every criterion is scored, with unscored criteria indicated inline at the point of omission. | M | D | R1 §19.3 |

---

# 10. Functional requirements — Scoring

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-SCR-001 | Raw score **shall** be computed as the weighted mean of criterion scores, normalised to a 0–100 range. | M | T | R1 §10.1 |
| FR-SCR-002 | The system **shall** correct interviewer strictness using empirical-Bayes shrinkage: `adjusted = raw − (w × bias)` where `w = n/(n+5)`, `n` is the interviewer's evaluation count, and `bias = interviewer_mean − cohort_mean`. | M | T | R2 v2-06 |
| FR-SCR-003 | The adjusted score **shall** occupy the same 0–100 scale as the raw score. Scores on differing scales **shall not** be combined in any aggregation. | M | I | R1 §0 E3 |
| FR-SCR-004 | The system **shall** persist raw score, adjusted score and shrinkage weight for every evaluation. | M | I | R1 §15.2 |
| FR-SCR-005 | Adjustment **shall** be computed at review time against the complete cycle distribution, not at submission. | M | T | R1 §10.2 |
| FR-SCR-006 | The applicant's final score **shall** be the arithmetic mean of adjusted scores across their evaluations. | M | T | R1 §10.3 |
| FR-SCR-007 | The system **shall** raise flag `HIGH_DISAGREEMENT` where the adjusted score spread across a panel exceeds 20 points. | M | T | R1 §10.4 |
| FR-SCR-008 | The system **shall** raise flag `CRITERION_FLOOR` where any criterion scored 2 or below on a 5-point scale. | M | T | R1 §10.4 |
| FR-SCR-009 | The system **shall** raise flag `LOW_CONFIDENCE` where every evaluator of an applicant has fewer than 5 evaluations. | S | T | R1 §10.4 |
| FR-SCR-010 | The system **shall** raise flag `SINGLE_EVALUATOR` where only one evaluation exists for an applicant. | S | T | R1 §10.4 |
| FR-SCR-011 | Review bands **shall** be expressed relative to department capacity `C`: rank ≤ 0.75C clear admit; 0.75C < rank ≤ 2C discuss; rank > 2C below line. Absolute score thresholds **shall not** be used as the primary band boundary. | M | T | R2 v2-06 |
| FR-SCR-012 | Any flagged applicant **shall** be forced into the discussion band irrespective of rank. | M | T | R1 §10.5 |
| FR-SCR-013 | An applicant with a `CRITERION_FLOOR` flag **shall** be auto-excluded irrespective of rank, subject to manual override. | M | T | R1 §10.5 |
| FR-SCR-014 | Both raw and adjusted scores **shall** be displayed side by side wherever scores are presented to a Super Admin or Auditor. | M | D | R1 §10.2 |

---

# 11. Functional requirements — Decisions, offers and notifications

## 11.1 Allocation

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-DEC-001 | The system **shall** refuse to run allocation while any interview is not `complete` or explicitly voided, returning `PREFLIGHT_FAILED` with the blocking records. | M | T | R2 v2-07 |
| FR-DEC-002 | The system **shall** refuse to run allocation before shrinkage adjustment has been computed. | M | T | R2 v2-07 |
| FR-DEC-003 | The system **shall** refuse to run allocation where any active department lacks a capacity value. | M | T | R2 v2-07 |
| FR-DEC-004 | Concurrent allocation runs **shall** be prevented by an advisory lock scoped to the cycle, returning `ALLOCATION_IN_PROGRESS`. | M | T | R1 §11.1 |
| FR-DEC-005 | Allocation **shall** use applicant-proposing deferred acceptance against department capacities. | M | T | R1 §11.2 |
| FR-DEC-006 | Department preference ordering **shall** be total and deterministic, resolving ties by: adjusted score desc, recommendation count desc, panel score spread asc, application time asc, applicant identifier asc. | M | T | R2 v2-07 |
| FR-DEC-007 | Repeated allocation runs over unchanged input **shall** produce byte-identical results. | M | T | R1 §0 E8 |
| FR-DEC-008 | Unmatched applicants above the line **shall** be waitlisted and ranked per department using the same ordering. | M | T | R1 §11.2 |
| FR-DEC-009 | Any allocation outcome **shall** be manually overridable by a Super Admin, subject to a mandatory written reason, creating a new decision version and retaining the prior version. | M | T | R1 §11.2 |

## 11.2 Locking and publication

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-DEC-010 | Result locking **shall** require confirmation by two distinct authenticated Super Admin accounts. A single account **shall not** be able to complete both steps. | M | T | R1 §11.3 |
| FR-DEC-011 | On lock, the system **shall** write an immutable snapshot of all decisions, scores and allocations, with a checksum. | M | T | R1 §11.3 |
| FR-DEC-012 | The system **shall** provide a publication dry run reporting recipient count, per-outcome breakdown, and at least three rendered sample messages. | M | D | R1 §11.3 |
| FR-DEC-013 | The dry run **shall** validate that every recipient address is syntactically valid and has no prior hard bounce, and **shall** report exceptions. | M | T | R1 §11.3 |
| FR-DEC-014 | The dry run **shall** verify that no applicant in state `selected` lacks a department assignment. | M | T | R1 §11.3 |
| FR-DEC-015 | Publication **shall** require re-authentication including second factor, and a typed confirmation. | M | D | R1 §17 |
| FR-DEC-016 | Post-publication corrections **shall** create a new decision version and a distinct correction notice. The published snapshot **shall not** be mutated. | M | T | R1 §11.3 |

## 11.3 Offers and waitlist

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-OFF-001 | Each selected applicant **shall** receive an offer with a configurable expiry (default 5 days). | M | T | R1 §11.4 |
| FR-OFF-002 | The system **shall** send a reminder 48 hours before expiry. | S | T | R1 §11.4 |
| FR-OFF-003 | Decline, expiry, or post-acceptance withdrawal **shall** release the seat and trigger the waitlist cascade for that department. | M | T | R1 §11.4 |
| FR-OFF-004 | The cascade **shall** skip waitlisted applicants who are no longer eligible or are placed elsewhere, marking them lapsed and continuing to the next candidate. | M | T | R1 §11.4 |
| FR-OFF-005 | Where a waitlist is exhausted, the system **shall** record the department as closed under capacity and notify Super Admins. | M | T | R1 §11.4 |
| FR-OFF-006 | A Super Admin **shall** be able to pause the cascade for a department. | S | D | R1 §11.4 |

## 11.4 Notifications

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-NOT-001 | All outbound email **shall** be dispatched via an asynchronous queue with retry. Email **shall not** be sent synchronously within a request that a user is waiting on. | M | I | R1 §17 |
| FR-NOT-002 | The system **shall** record per-recipient delivery state from provider webhooks: queued, delivered, bounced, complained. | M | T | R1 §11.3 |
| FR-NOT-003 | Hard bounces **shall** appear on the operations dashboard as actionable items. | M | D | R1 §19.4 |
| FR-NOT-004 | Message templates **shall** be stored as configuration, previewable, and versioned. Template content **shall not** be hard-coded. | M | I | R1 §18 |
| FR-NOT-005 | The system **shall** respect a suppression list for all non-transactional messages. | M | T | R1 §17 |

---

# 12. Functional requirements — Access control, audit and operations

## 12.1 Authentication and authorisation

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-RBAC-001 | The system **shall** implement six roles: Super Admin, Coordinator, Admin, Volunteer, Interviewer, Auditor. | M | I | R1 §12.1 |
| FR-RBAC-002 | Role assignment **shall** be scoped to a cycle. A user may hold different roles in different cycles. | M | T | R1 §12.1 |
| FR-RBAC-003 | Where a user holds multiple roles within one cycle, effective capabilities **shall** be the union of those roles. | M | T | R2 v2-09 |
| FR-RBAC-004 | Access control **shall** be enforced at three layers: row-level database policy, API middleware, and user interface. The interface layer **shall** be treated as ergonomics and **shall not** be the sole control for any capability. | M | I | R1 §12.4 |
| FR-RBAC-005 | Row-level policies **shall** fail closed: an unset or absent security context **shall** yield zero rows. | M | T | R2 v2-09 |
| FR-RBAC-006 | The security context binding **shall** be transaction-scoped or derived from a verified token claim, such that it remains correct under transaction-mode connection pooling. | M | T | R1 §0 E9 |
| FR-RBAC-007 | An applicant session **shall** be scoped to exactly one applicant record. | M | T | R1 §15.3 |
| FR-RBAC-008 | Coordinator, Admin and Super Admin accounts **shall** require a second authentication factor. | M | D | R1 §17 |
| FR-RBAC-009 | The Auditor role **shall** have read access to all cycle data including evaluations, and write access to nothing. | M | T | R1 §12.2 |
| FR-RBAC-010 | Session lifetimes **shall** be: applicant token 60 days, Volunteer and Interviewer 12 hours, Coordinator and Admin 8 hours, Super Admin 4 hours. | S | I | R1 §17 |

## 12.2 Audit

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-AUD-001 | Every state transition, override, waiver, priority change, unlock, export and publication **shall** write an audit event recording actor, role, action, entity, before-state, after-state, reason and instant. | M | T | R2 v2-03 |
| FR-AUD-002 | Audit events **shall** be written within the same transaction as the change they describe. A failed audit write **shall** roll back the change. | M | T | R2 v2-03 |
| FR-AUD-003 | The audit table **shall** be append-only. `UPDATE` and `DELETE` privileges **shall** be revoked at the database level. | M | I | R1 §15.2 |
| FR-AUD-004 | Audit records **shall** be retained for 3 years. | S | I | §13 |

## 12.3 State integrity

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-OPS-001 | Each item of state **shall** have exactly one owning table. Derived fields **shall** be written only by the owning transition function, within the same transaction. | M | I | R2 v2-03 |
| FR-OPS-002 | Application code **shall not** write `applicants.state` directly. | M | I | R2 v2-03 |
| FR-OPS-003 | A scheduled job **shall** re-derive projected state from owning tables daily and raise an alert on any divergence. | S | T | R2 v2-03 |
| FR-OPS-004 | All mutating endpoints **shall** accept an `Idempotency-Key`. Replay with a matching request hash **shall** return the stored response; replay with a differing hash **shall** return 409. | M | T | R1 §13.3 |

## 12.4 Operations

| ID | Requirement | Pri | VM | Trace |
|---|---|:--:|:--:|---|
| FR-OPS-005 | The operations dashboard **shall** present an Action Required section as its first element, listing flagged interviews, parked applicants, outstanding evaluations, tracks without open panels, and delivery bounces. | M | D | R1 §19.4 |
| FR-OPS-006 | Where no action is required, the Action Required section **shall** state so explicitly rather than rendering empty. | M | D | R1 §19.4 |
| FR-OPS-007 | The system **shall** provide a capacity model computing required hours from expected applicants, target interview duration, panel count and a utilisation factor, and **shall** report feasibility against the scheduled window. | S | T | R1 §14.2 |
| FR-OPS-008 | Data export **shall** be scope-limited by role, watermarked with the exporting user's identity, and recorded in the audit log. | M | T | R1 §17 |
| FR-OPS-009 | The public display board **shall** present applicant identifiers and room assignments only. It **shall not** transmit or render names, scores or decisions. | M | I | R1 §19.5 |
| FR-OPS-010 | The display channel **shall** exclude names at the publisher, not by client-side omission. | M | I | R1 §13.1 |

---

# 13. Non-functional requirements

## 13.1 Performance

Measured at the 95th percentile unless stated, under the load profile in NFR-SCAL-001.

| ID | Requirement | Target | Pri | VM |
|---|---|---|:--:|:--:|
| NFR-PERF-001 | QR decode latency, camera frame to decoded payload | ≤ 500 ms | M | T |
| NFR-PERF-002 | Check-in API response, receipt to response | ≤ 300 ms | M | A |
| NFR-PERF-003 | End-to-end check-in, applicant presents code to confirmation displayed | ≤ 8 s | M | D |
| NFR-PERF-004 | Queue claim operation | ≤ 200 ms | M | A |
| NFR-PERF-005 | Real-time event propagation, commit to client render | ≤ 2 s | M | T |
| NFR-PERF-006 | Applicant status page Largest Contentful Paint, throttled 3G | ≤ 2.5 s | M | T |
| NFR-PERF-007 | Operations dashboard initial render, 500 queue entries | ≤ 1.5 s | S | T |
| NFR-PERF-008 | Allocation execution, 1,000 applicants across 10 departments | ≤ 5 s | M | A |
| NFR-PERF-009 | Offline roster bundle size, 500 applicants | ≤ 100 KB | M | T |
| NFR-PERF-010 | Result publication dispatch, 1,000 messages enqueued | ≤ 60 s | S | A |

## 13.2 Scalability

| ID | Requirement | Pri | VM |
|---|---|:--:|:--:|
| NFR-SCAL-001 | The system **shall** sustain, concurrently: 250 applicant status sessions, 30 authenticated staff sessions, 10 active panels, 4 check-in devices. | M | A |
| NFR-SCAL-002 | The system **shall** support 1,000 applicants per cycle without architectural change. | M | A |
| NFR-SCAL-003 | Queue claim latency **shall not** degrade more than 20% as queue depth grows from 50 to 1,000 waiting entries. | M | A |
| NFR-SCAL-004 | The system **shall** support at least 20 concurrent panels without contention-related failures. | S | A |
| NFR-SCAL-005 | The data model **shall** accommodate multi-society tenancy without destructive migration, even though tenancy is not implemented in this release. | S | I |

## 13.3 Availability and resilience

| ID | Requirement | Pri | VM |
|---|---|:--:|:--:|
| NFR-AVAIL-001 | Availability during scheduled interview stage windows **shall** be ≥ 99.5%. | M | A |
| NFR-AVAIL-002 | No single component failure — network, server, device, or individual — **shall** prevent applicant check-in from continuing. | M | D |
| NFR-AVAIL-003 | Clients **shall** degrade in the defined order: websocket, polling at 5-second interval, cached offline operation, documented paper fallback. | M | D |
| NFR-AVAIL-004 | Every surface presenting live data **shall** display a connection indicator and a last-updated instant. | M | I |
| NFR-AVAIL-005 | No surface **shall** present cached data in a manner indistinguishable from live data. | M | I |
| NFR-AVAIL-006 | Recovery Point Objective **shall** be ≤ 5 minutes during an active interview stage and ≤ 24 hours otherwise. | M | A |
| NFR-AVAIL-007 | Recovery Time Objective **shall** be ≤ 4 hours. | S | D |
| NFR-AVAIL-008 | A backup restore **shall** be performed and verified within the 7 days preceding each cycle's first interview stage. | M | D |

## 13.4 Security

Verified against OWASP ASVS v4.0 Level 2 [R5].

| ID | Requirement | Pri | VM |
|---|---|:--:|:--:|
| NFR-SEC-001 | All transport **shall** use TLS 1.3 with HSTS enabled. | M | I |
| NFR-SEC-002 | Signing keys, TOTP secrets and equivalent material **shall** be encrypted at the application layer with keys held in a managed key service, in addition to storage encryption. | M | I |
| NFR-SEC-003 | No private key material **shall** be transmitted to any client device. | M | I |
| NFR-SEC-004 | Access tokens **shall** be stored only as cryptographic hashes. | M | I |
| NFR-SEC-005 | Rate limits **shall** be enforced: token lookup 10/min/IP, application submission 3/hour/IP, authentication 5 attempts per 15 minutes per account with progressive backoff. | M | T |
| NFR-SEC-006 | The public application form **shall** be protected against automated submission. | M | D |
| NFR-SEC-007 | CV files **shall** be served exclusively via signed URLs with a maximum lifetime of 15 minutes, generated per request, each generation audited, with `Content-Disposition: attachment`. | M | T |
| NFR-SEC-008 | The system **shall** set Content Security Policy, `X-Frame-Options: DENY`, and a restrictive CORS policy. | M | I |
| NFR-SEC-009 | Secrets **shall** be held in a secrets manager and **shall not** appear in source control, logs or error output. | M | I |
| NFR-SEC-010 | A dependency vulnerability scan **shall** run on every build; builds with unresolved critical findings **shall** fail. | S | T |

## 13.5 Privacy and data protection

| ID | Requirement | Pri | VM |
|---|---|:--:|:--:|
| NFR-PRIV-001 | The system **shall** collect only data required by a defined process step. National identity numbers, dates of birth and home addresses **shall not** be collected. | M | I |
| NFR-PRIV-002 | Recruitment data **shall not** be used for marketing. Marketing consent **shall** be a separate, explicit, opt-in choice. | M | I |
| NFR-PRIV-003 | Personally identifying data **shall** be retained for 2 cycles, then automatically anonymised, retaining scores and aggregates without identity. | M | T |
| NFR-PRIV-004 | An applicant **shall** be able to request export or deletion of their own data via their access link. | S | D |
| NFR-PRIV-005 | An applicant **shall not**, under any circumstance, be able to view another applicant's name, status, score or outcome. | M | T |
| NFR-PRIV-006 | Public display surfaces **shall not** carry names. | M | I |

## 13.6 Accessibility

Conformance target: WCAG 2.1 Level AA [R4].

| ID | Requirement | Pri | VM |
|---|---|:--:|:--:|
| NFR-A11Y-001 | Text contrast **shall** be ≥ 4.5:1; large text and user-interface boundaries ≥ 3:1. | M | T |
| NFR-A11Y-002 | Colour **shall not** be the sole means of conveying any state. Every state **shall** carry an icon or shape distinction in addition to colour. | M | I |
| NFR-A11Y-003 | Interactive targets **shall** be ≥ 44 × 44 px with ≥ 8 px separation. | M | I |
| NFR-A11Y-004 | All staff interfaces **shall** be fully operable by keyboard, with a visible focus indicator on every focusable element. | M | T |
| NFR-A11Y-005 | Scan results and error conditions **shall** be announced to assistive technology using `role="alert"` or an equivalent live region. | M | T |
| NFR-A11Y-006 | The system **shall** honour `prefers-reduced-motion`, removing non-essential animation. | M | T |
| NFR-A11Y-007 | Every form control **shall** have a programmatically associated label and an appropriate `inputmode`. | M | I |
| NFR-A11Y-008 | Interfaces **shall** render without horizontal scroll at 375 px, 768 px, 1024 px and 1440 px viewport widths. | M | T |

## 13.7 Usability

| ID | Requirement | Pri | VM |
|---|---|:--:|:--:|
| NFR-USE-001 | Where requirements conflict, Volunteer task efficiency **shall** take precedence, that class having the lowest proficiency and highest time pressure. | M | I |
| NFR-USE-002 | A volunteer with no prior exposure **shall** complete a successful check-in within 60 seconds of first opening the application, without written instruction. | M | D |
| NFR-USE-003 | Successful routine operations **shall not** require a confirmation dialog. | M | I |
| NFR-USE-004 | Conditions that are expected and non-erroneous — notably repeat check-in — **shall not** be presented using error styling. | M | I |
| NFR-USE-005 | The applicant status page **shall** answer status, position and required action within a single viewport at 375 px without scrolling. | M | D |
| NFR-USE-006 | Where an action is unavailable, the interface **shall** state the reason. A disabled control without explanation is a defect. | M | I |
| NFR-USE-007 | The system **shall not** present a loading indicator without accompanying context on any applicant-facing surface. | M | I |

## 13.8 Maintainability and observability

| ID | Requirement | Pri | VM |
|---|---|:--:|:--:|
| NFR-MAIN-001 | Departments, rubrics, criteria, weights, anchors, stages, capacities, grace windows, thresholds and message templates **shall** be modifiable as configuration without deployment. | M | D |
| NFR-MAIN-002 | Database schema changes **shall** be applied by versioned, reversible migrations held in source control. | M | I |
| NFR-MAIN-003 | Automated test coverage **shall** be ≥ 80% for state transition logic, the queue claim path, scoring computation and allocation. | S | T |
| NFR-MAIN-004 | Errors **shall** be reported to a monitoring service with sufficient context to identify cycle, actor and endpoint, and without recording PII. | M | I |
| NFR-MAIN-005 | The system **shall** expose health metrics for queue depth, panel utilisation, evaluation backlog and pending sync count. | S | D |
| NFR-MAIN-006 | Structured logs **shall** be retained for 90 days and **shall not** contain raw tokens, passwords or CV content. | M | I |

## 13.9 Compatibility

| ID | Requirement | Pri | VM |
|---|---|:--:|:--:|
| NFR-COMP-001 | Applicant and volunteer interfaces **shall** function on the current and one prior major version of Chrome, Safari, Firefox and Edge, on iOS 15+ and Android 10+. | M | T |
| NFR-COMP-002 | The QR payload **shall** resolve correctly in the default camera application of iOS 15+ and Android 10+. | M | D |
| NFR-COMP-003 | The check-in application **shall** be installable as a Progressive Web App with an offline-capable service worker. | M | D |

---

# 14. Data requirements

| ID | Requirement | Pri | VM |
|---|---|:--:|:--:|
| DR-001 | Every entity except Society and User **shall** carry a cycle reference. | M | I |
| DR-002 | Referential integrity **shall** be enforced by foreign key constraints. | M | I |
| DR-003 | Enumerated states **shall** be enforced by database type or check constraint, not by application convention. | M | I |
| DR-004 | Time values **shall** be stored as `timestamptz`. Local wall-clock strings **shall not** be persisted. | M | I |
| DR-005 | Uniqueness constraints affecting applicant identity **shall** be partial, excluding withdrawn, screened-out and deliberately overridden records. | M | I |
| DR-006 | Deletion **shall** be implemented as state transition. No destructive delete endpoint shall exist for applicants, evaluations, decisions or audit records. | M | I |
| DR-007 | The published result snapshot **shall** be immutable and checksummed. | M | T |
| DR-008 | Decisions **shall** be versioned; superseded versions **shall** be retained. | M | I |
| DR-009 | The queue claim path **shall** be supported by a partial index on waiting entries ordered by priority and enqueue time. | M | I |

---

# 15. Interface requirements

| ID | Requirement | Pri | VM |
|---|---|:--:|:--:|
| IR-001 | The API **shall** be HTTPS REST with JSON request and response bodies. | M | I |
| IR-002 | Errors **shall** return a machine-readable body containing `code`, `message`, `detail` and `retryable`. | M | T |
| IR-003 | The defined error codes **shall** be: `INVALID_TRANSITION`, `IDEMPOTENCY_KEY_REUSED`, `QUEUE_EMPTY`, `RECUSAL_CONFLICT`, `STAGE_CLOSED`, `STAGE_HAS_ACTIVE_INTERVIEWS`, `DUPLICATE_APPLICANT`, `DUAL_CONTROL_REQUIRED`, `CYCLE_ARCHIVED`, `RATE_LIMITED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `ALLOCATION_IN_PROGRESS`, `PREFLIGHT_FAILED`. | M | I |
| IR-004 | Real-time channels **shall** be scoped by row-level policy such that a subscriber cannot receive data they could not retrieve by direct query. | M | T |
| IR-005 | The email provider integration **shall** consume delivery webhooks and persist per-recipient state. | M | T |
| IR-006 | No external service **shall** be a synchronous dependency of check-in, queue claim or evaluation submission. | M | I |

---

# 16. Constraints and assumptions

## 16.1 Constraints

| ID | Constraint |
|---|---|
| CON-001 | The system is maintained by student volunteers with turnover at graduation. Operational complexity is a first-order cost, not a secondary concern. |
| CON-002 | Campus network reliability cannot be assumed at any point during an event. |
| CON-003 | Volunteers receive at most 15 minutes of training, on the day. |
| CON-004 | No third-party service may sit in the synchronous path of check-in, queue claim or evaluation submission. |
| CON-005 | Budget assumes free or education-tier hosting; the architecture must remain within those limits at 1,000 applicants. |
| CON-006 | Interviewer availability is the binding throughput constraint and is outside system control. |

## 16.2 Assumptions

| ID | Assumption | If false |
|---|---|---|
| ASM-001 | Applicants carry an internet-capable phone | Manual search and printed slips already cover this; no change |
| ASM-002 | One general interview round is sufficient | Second-round UI required; schema already supports it |
| ASM-003 | Panels comprise 2 interviewers | Throughput model and capacity screen require recalibration |
| ASM-004 | Departments have fixed capacities before allocation | Allocation cannot run; FR-DEC-003 blocks it by design |
| ASM-005 | Interview target duration is 12 minutes | Wait estimate seed and capacity model require reconfiguration only |
| ASM-006 | Venue has mains power for the display board and desks | Paper fallback per FR-CHK-017 |

---

# 17. Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Residual |
|---|---|:--:|:--:|---|:--:|
| RSK-001 | Network failure during peak check-in | High | High | Offline PWA (FR-CHK-012), paper fallback (FR-CHK-017) | Low |
| RSK-002 | Interviewer capacity below applicant volume | High | High | Capacity model (FR-OPS-007), slot booking (FR-REG-014) | Medium |
| RSK-003 | Evaluations not submitted by end of day | Medium | High | Panel blocking (FR-INT-013), stage-close gate (FR-CYC-009) | Low |
| RSK-004 | Volunteer error under pressure | Medium | Medium | Zero-tap success path (FR-CHK-002), non-error styling for expected conditions (NFR-USE-004) | Low |
| RSK-005 | Disputed result | Medium | High | Deterministic allocation (FR-DEC-007), append-only audit (FR-AUD-003), Auditor role (FR-RBAC-009) | Low |
| RSK-006 | Device loss or theft during event | Low | Medium | No secrets on device (FR-IDT-007), roster contains hashes only (FR-CHK-018) | Low |
| RSK-007 | Accidental early publication | Low | High | Dual control (FR-DEC-010), dry run (FR-DEC-012), re-authentication (FR-DEC-015) | Low |
| RSK-008 | Knowledge loss at committee handover | High | Medium | Configuration over code (NFR-MAIN-001), this document, versioned migrations | Medium |
| RSK-009 | Interviewer bias | Medium | Medium | Blind evaluation (FR-INT-004), shrinkage (FR-SCR-002), disagreement flagging (FR-SCR-007), recusal (FR-INT-017) | Medium |
| RSK-010 | Applicant PII exposure | Low | High | Row-level policy (FR-RBAC-005), no names on display (NFR-PRIV-006), retention limit (NFR-PRIV-003) | Low |

---

# 18. Verification and traceability

## 18.1 Verification strategy

| Requirement class | Primary method | Gate |
|---|---|---|
| State transitions | Automated tests over the full transition matrix, including rejection of undefined transitions | Every build |
| Concurrency (FR-IDT-004, FR-QUE-002) | Load test at 20 concurrent actors, asserting zero duplicates | Pre-release, per cycle |
| Offline (FR-CHK-012 to 015) | Scripted network-partition test, 8-hour buffer, replay reconciliation assertion | Pre-cycle |
| Access control | Automated per-role, per-endpoint matrix test asserting 403 for every denied capability | Every build |
| Row-level policy | Direct database test bypassing the API, asserting zero rows for unauthorised context | Every build |
| Scoring and allocation | Golden-dataset tests with fixed expected output; determinism verified by repeated runs | Every build |
| Accessibility | Automated axe scan plus manual keyboard and screen-reader pass | Pre-release |
| Performance | Load test at NFR-SCAL-001 profile | Pre-cycle |
| Usability (NFR-USE-002) | Timed observation with three untrained participants | Pre-cycle |

## 18.2 Definition of done

A requirement is closed only when all of the following hold:

1. Implementation merged.
2. Verification evidence recorded against the stated method.
3. Traceability link to architecture section and flow diagram confirmed accurate.
4. For any requirement with priority `M`, no known defect remains open.

## 18.3 Traceability summary

| Requirement group | Architecture (R1) | Flow diagram (R2) |
|---|---|---|
| FR-CYC | §5.3 | v2-08 Stage Close Gate |
| FR-IDT | §3.1, §3.2 | v2-01 Token Verification |
| FR-REG | §6, §15.1 | v2-02 Registration and Dedupe |
| FR-CHK | §7 | v2-01 Token Verification |
| FR-QUE | §8 | v2-04 Queue Claim, v2-05 Wait Estimate |
| FR-INT | §9 | v2-08 Stage Close Gate |
| FR-SCR | §10 | v2-06 Scoring Shrinkage |
| FR-DEC, FR-OFF | §11 | v2-07 Deterministic Allocation |
| FR-RBAC | §12 | v2-09 Permission Gate |
| FR-AUD, FR-OPS | §4, §19.4 | v2-03 State Ownership |
| DR | §15 | v2-11 Data Model |
| NFR-A11Y, NFR-USE | §18, §19 | — |

**Coverage:** every requirement traces to at least one architecture section. Requirements without a flow diagram reference are non-behavioural (data, accessibility, usability) and are verified by inspection or test rather than by flow.

---

# 19. Release gating

| Phase | Blocking requirements | Exit criterion |
|---|---|---|
| 1 Foundations | FR-CYC-001 to 007, FR-CYC-012 to 013, FR-IDT-001 to 006, FR-REG-001 to 013, FR-RBAC-001 to 010, FR-AUD-001 to 003, DR-001 to 006 | Applications accepted end to end; access control matrix test passes |
| 2 Event core | FR-IDT-007 to 011, FR-CHK-001 to 018, FR-QUE-001 to 020, FR-OPS-009 to 010, NFR-PERF-001 to 005, NFR-AVAIL-002 to 005 | **Interview day is runnable.** Concurrency and offline tests pass |
| 3 Evaluation | FR-INT-001 to 020, FR-OPS-005 to 006 | Structured scoring in production use |
| 4 Decisions | FR-SCR-001 to 014, FR-DEC-001 to 016, FR-OFF-001 to 006, FR-NOT-001 to 005 | Determinism test passes; dry run demonstrated |
| 5 Resilience | FR-CHK-012 to 017, FR-INT-014 to 016, FR-OPS-003, NFR-AVAIL-006 to 008 | Network-partition drill passes; restore verified |
| 6 Refinement | FR-REG-014, FR-OPS-007, FR-OFF-002, FR-OFF-006 | — |

**Phase 2 is the minimum viable induction.** Phase 3 may be deferred for one cycle with scoring conducted on paper; Phase 2 may not be deferred, because the queue cannot be improvised on the floor.

---

# 20. Open issues

Each must be closed before the phase indicated. Assumed defaults are in effect until then.

| ID | Issue | Default | Blocks |
|---|---|---|---|
| OI-1 | Panel size: 1, 2 or 3 interviewers | 2 | Phase 3 — drives throughput more than any other variable |
| OI-2 | One general interview, or one per department preference | One general | Phase 2 — determines track configuration |
| OI-3 | Maximum ranked department preferences | 3 | Phase 1 — form design |
| OI-4 | May an applicant be placed in more than one department | No | Phase 4 — allocation semantics |
| OI-5 | Is a second interview round required | No | Phase 3 — UI scope |
| OI-6 | Publication: individual notices only, or also a public list of selected identifiers | Individual only | Phase 4 — privacy decision for the committee |
| OI-7 | Offer expiry period | 5 days | Phase 4 |
| OI-8 | Adopt booked arrival windows | Recommended, not assumed | Phase 6 — but changes Phase 1 form |
| OI-9 | Target interview duration | 12 minutes | Phase 2 — seeds wait estimation |
| OI-10 | Waiver authority: Coordinator or Super Admin | Coordinator, audited | Phase 3 |
| OI-11 | Confirmed hosting tier and data residency | Not determined | Phase 1 — affects NFR-SEC-002, NFR-PRIV-003 |
| OI-12 | Whether faculty approval is required for data retention policy | Assumed yes | Phase 1 — baseline approval |

---

# 21. Requirement count summary

| Class | Must | Should | Could | Total |
|---|:--:|:--:|:--:|:--:|
| Functional | 137 | 21 | 0 | 158 |
| Non-functional | 52 | 13 | 0 | 65 |
| Data | 9 | 0 | 0 | 9 |
| Interface | 6 | 0 | 0 | 6 |
| **Total** | **204** | **34** | **0** | **238** |

No requirement is classified `Could`. Anything that did not earn `Must` or `Should` was removed during authoring rather than retained as aspiration — an unprioritised requirement is a requirement nobody will verify.

---

*End of document. Baseline requires the four approvals recorded in Document Control.*
