# Phase H — The Canonical Progression & Access Authority

> **Status:** implemented on branch `arena/01a0bccd-codemind-academy` · **Type:** cross-role
> architecture (student · parent · teacher · admin) · **Migrations:** additive,
> `20260920120000_phase_h_progression_authority` on **both** provider chains
> (SQLite + PostgreSQL) · **No merge / PR / deploy / Neon mutation performed.**
>
> One sentence: **there is now exactly one place that decides whether a student may open a
> session and why**, every screen reads it, and the only human exception is an audited
> Admin-only override that never invents an academic fact.

---

## 0. Why this phase exists

Before Phase H the academic rule *"what makes a session complete"* was implemented more than
once, and the surfaces that enforced it did not all agree with the surfaces that explained it:

* `src/lib/session-progress.ts` owned the live rule (video ≥ 95 % · quiz · homework) **and** the
  dual-chain universe **and** the access gates — 700+ lines mixing three concerns.
* `src/lib/progress.ts` recomputed a *second* video universe for dashboards.
* `/api/lessons/[id]`, `/api/courses/[slug]`, the student dashboard and the parent dashboard each
  rendered their own "requirements" shape.
* The **AbsenceHold** written by Phase F was a row in the database with **no reader**: nothing
  enforced it, so an unexcused absence had no academic consequence.
* A locked session answered the student with a bare padlock (a generic Arabic toast), never with
  *what to do next*.

Phase H does **not** rewrite the healthy lifecycle systems. It extracts the VERDICT into one
authority, delegates the writes it does not own, and makes every reader consume the same answer.

---

## 1. Discovery — the authority map

| Concern | Pre-Phase-H owner | Phase H decision |
|---|---|---|
| Requirement matrix (video / quiz / homework) | inline arithmetic inside `session-progress.ts` | **Extracted, pure** → `progression-requirements.ts` |
| Progression universe (dual chain, ordering, archived, lifecycle, track) | `session-progress.ts` (+ a private copy in `progress.ts`) | **Extracted** → `progression-universe.ts`; `progress.ts` now imports it |
| Access gate (`canAccessLesson` / quiz / homework / resources) | `session-progress.ts` | **Moved** → `progression-engine.ts`; `session-progress.ts` is a **facade** |
| AbsenceHold **writes** | Phase F `absence-review.ts` ✅ healthy | **Untouched.** Phase H only READS it |
| AbsenceHold **enforcement** | *nobody* | **Added** → `progression-holds.ts` (boundary) |
| Catch-up completion decision | *nobody* | **Added** → engine (`evaluateCatchUp`) |
| Catch-up **hold resolution** | Phase F | **Delegated** → `resolveAbsenceHoldForCatchUp` (new bridge in `absence-review.ts`) |
| Quiz lifecycle / passes | Phase 26D + G ✅ healthy | **Read-only.** The engine reads `QuizAttempt.passed` |
| Homework lifecycle / submissions | Phase G ✅ healthy | **Read-only.** The engine reads `HomeworkSubmission.submittedAt` |
| Attendance | Phase F ✅ healthy | **Never a completion signal** (see §2.4) |
| Manual unlock | *nobody* | **Added** → Admin-only `ProgressionOverride` |

**Discovery principle applied:** reuse / retire / delegate — never rewrite a healthy lifecycle
system merely to centralise it. Phase F (holds), 26D + G (quiz), G (homework) and 12 (tracks) keep
full ownership of their writes.

---

## 2. The canonical rules

### 2.1 VIDEO — ≥ 95 % of **server-tracked** progress

`VIDEO_COMPLETION_THRESHOLD = 95`, evaluated `percent >= threshold` (never `>`), OR the persisted
`LessonProgress.videoCompleted` flag. Both are written by the server-side heartbeat — a client
claiming "95 %" is never trusted. The threshold is exported from the matrix and re-exported by
`progress.ts`, so there is one constant, not three.

### 2.2 QUIZ — **PASS**, not attempt, not submit

A required quiz is satisfied by `QuizAttempt.passed` on a **finished** attempt. Attempts, retries,
freezing and grading stay owned by Phase 26D / G. An attempt that was submitted but failed no
longer unlocks the next session (**this is a deliberate, approved behaviour change**).

### 2.3 HOMEWORK — **SUBMITTED**; grading is irrelevant

A required homework is satisfied by `HomeworkSubmission.submittedAt`. A GRADED submission and a
pending one are equally "done" for progression; marks stay assessment data.

### 2.4 ATTENDANCE — never completes a lesson

Attendance reaches progression **only** through the AbsenceHold boundary (§3). Being PRESENT adds
nothing to a lesson's completion.

### 2.5 A component that does not exist is not a requirement

A lesson with no quiz can never be blocked by a quiz. **Fail closed for future content, never
invent a requirement for legacy content** — an empty legacy session is COMPLETE the moment it is
reachable, so it can never lock a student forever.

### 2.6 The boundary

A session is reachable when (a) the previous session in the sequence is COMPLETE **and** (b) no
ACTIVE AbsenceHold blocks forward progression — unless a **valid Admin override** covers it.

### 2.7 The preserved Phase-4 booleans

`completed` stays **academic** ("every requirement that exists is satisfied") and `unlocked` stays
the **boundary**. They are *not* a projection of the tri-state: a locked session that has nothing
left to do keeps `completed: true`, exactly as it did before Phase H, so **no dashboard, parent
report or certificate sees its completion numbers move because of this phase.** The richer
`state` (`LOCKED | UNLOCKED | COMPLETED`) is the Phase H view that carries the reason.

---

## 3. Absence holds — the boundary rule

```
EXCUSED    ⇒ no hold                                  (Phase F decision, unchanged)
UNEXCUSED  ⇒ ACTIVE hold
```

An `ACTIVE` hold **blocks every session whose index is greater than the affected session's index**.

* the affected session itself stays open — video, recording, quiz, homework, history;
* everything **before** it stays open (history is never rewritten);
* the hold is a **forward-progression** fact, never a lesson requirement.

**Catch-up never traps the student.** The catch-up list is derived from the *same* matrix as
normal progression, so it only ever lists requirements that **actually exist** (a session with no
quiz never asks for a quiz pass) and never lists attendance. When the catch-up is satisfied the
block disappears — `resolveCatchUpIfSatisfied` writes through the Phase F authority
(`resolveAbsenceHoldForCatchUp`), so Phase F remains the only writer of hold state.

---

## 4. Admin overrides — the only human exception

| Property | Rule |
|---|---|
| Role | **ADMIN only.** `requireRole("ADMIN")` in the route **and** `canIssueProgressionOverride(actorRole)` inside the authority. A Teacher gets **no** unrestricted unlock of any kind. |
| Reason | **Mandatory**, server-validated (3–500 chars), never pre-filled |
| Attribution | actor user id + role + `createdAt` + student + lesson (+ derived `courseId`) |
| Expiry | optional; must be in the future; an expired row stops applying **without being deleted** |
| Revocation | `revokedAt` / `revokedByUserId` / `revokeReason` — never a delete, so the decision stays on the record |
| Idempotency | issuing twice returns the same row (`created: false`); revoking twice reports `ALREADY_RESOLVED`/unchanged, never a second audit event |
| Audit | `AuditLog` rows `PROGRESSION_OVERRIDE_CREATED` / `PROGRESSION_OVERRIDE_REVOKED` |
| **Never** | writes a quiz attempt, a homework submission, watch progress, attendance, `LessonProgress.isCompleted`, or an AbsenceHold. It is an **exception overlay on the boundary**, never an academic fact. |

HTTP surface:

```
GET  /api/admin/progression/overrides?studentId=…     the console (student + canonical state + history + actors)
POST /api/admin/progression/overrides                 { studentId, lessonId, reason, expiresAt? }
POST /api/admin/progression/overrides/[id]/revoke     { reason? }
GET  /api/students/me/catch-up                        the student's own hold + what its catch-up needs
POST /api/students/me/catch-up                        resolve it once it is genuinely complete (idempotent)
```

---

## 5. Architecture

```
                    ┌────────────────────────────────────────────┐
  readers           │  progression-engine.ts  (THE authority)    │
  lesson page   ──► │  evaluateCourseProgression · composeProgression
  course tree   ──► │  canAccessLesson(WithCourse) · gateTrackedResource
  student dash  ──► │  getUnlockedLessonIds · evaluateCatchUp    │
  parent dash   ──► │  toLesson/CourseProgressionPayload         │
  admin console ──► │  localizeProgression                       │
                    └───┬──────────┬──────────────┬──────────────┘
                        │          │              │
        progression-requirements  progression-universe  progression-holds  progression-overrides
        (PURE matrix: states,      (universe, ordering,  (AbsenceHold READ   (Admin override store:
         codes, thresholds)         dual chain, video)    bridge; Phase F     validation, expiry,
                                                          owns the writes)    audit, role gate)
```

* `src/lib/session-progress.ts` is now a **250-line facade** that re-exports the historical names
  (`EXCLUDE_ARCHIVED_LESSON`, `lessonCourseChainOr`, `VIDEO_COMPLETION_THRESHOLD`,
  `getCourseSessionProgress`, `canAccessQuiz`, `canAccessHomework`, `getUnlockedLessonIds`) and
  delegates every decision to the engine. No reader had to be rewritten; no second opinion exists.
* `additiveDelegate(client, name)` is the **degradation contract**: if the Phase F/H/G/A/B table
  delegate is missing (an older Prisma client, a legacy database, a test double), the answer is
  "no hold / no override / no modern recording" — the pre-Phase-H state — never a crash.
* `src/lib/api.ts::denyProgression` gained `ProgressionDenialDetail`, so a 403 can carry the
  Arabic reason **and** the structured unmet codes instead of a code alone.

---

## 6. Data model & migrations (additive only)

```prisma
model ProgressionOverride {
  id              String    @id @default(cuid())
  studentId       String
  courseId        String?                 // derived at write time; the lesson is authoritative
  lessonId        String                  // the lesson whose BOUNDARY is overridden
  reason          String                  // MANDATORY
  createdByUserId String
  createdAt       DateTime  @default(now())
  expiresAt       DateTime?               // NULL = valid until revoked
  revokedAt       DateTime?
  revokedByUserId String?
  revokeReason    String?
  lesson  Lesson  @relation(fields: [lessonId], references: [id], onDelete: Cascade)
  student Student @relation(fields: [studentId], references: [id], onDelete: Cascade)
  @@index([studentId, lessonId]) @@index([studentId, revokedAt])
  @@index([lessonId]) @@index([expiresAt])
}
```

* One migration per provider, **appended** to the frozen history (SQLite 16, PostgreSQL 6).
  No applied migration was edited; no destructive reset; no column dropped or retyped.
* `prisma/postgres/schema.prisma` and `scripts/db/postgres-baseline.sql` were **regenerated** with
  the repo's own generator (`scripts/db/make-postgres-schema.mjs`) — never hand-edited.
* `scripts/lib/migrate-sqlite.mjs` skip-table list updated so the Phase H table is created by its
  migration and not duplicated by the base DDL.
* `tests/migration-providers.test.js` pins the new migration's checksum on both chains.

---

## 7. Arabic-first UI

64 dictionary entries were added (Arabic + English): `progression.reason.*`,
`progression.unmet.*`, `progression.action.*`, `progression.state.*`, `progression.catchup.*`,
`progression.hold.*`, `progression.override.*`, `admin.progression.*`, `shell.h1`.

* The **server translates**: payloads carry `{ code, text }` where `text` is already localised for
  the request locale. A component never builds a sentence, so the tree, the lesson page and the
  console cannot disagree — and a missing key can never leak `student.198` into the UI.
* **Course tree** (`student-course.tsx`): a locked row now shows the canonical reason on the row
  itself (a tooltip is invisible on mobile) and the same sentence in the tap toast.
* **Admin console** (`components/admin/progression-overrides-view.tsx`): RTL-safe logical
  properties throughout, a warning card stating that an override changes no academic fact, a
  student picker, the canonical boundary, a reason-mandatory form with optional expiry, and a
  history that shows *who* issued/revoked *when* (names resolved from `User`, never invented).
* **Lesson workspace** (`student-lesson.tsx`): the absence hold and its catch-up list — only the
  requirements that exist — with an idempotent «أنا خلصت التعويض» action, plus a banner whenever an
  Admin override is in force, so an exception is never mistaken for completed work.
* **Student dashboard** (`student-dashboard.tsx`): the Continue card names the canonical *next
  action* in the student's language.
* **Parent dashboard** (`parent-dashboard.tsx`): the child's card shows *why* they are stopped.
* Wired in all four places that must agree: `store.ts` (ViewKey, appended last),
  `view-roles.ts` (**ADMIN only**, appended last — earlier suites pin the list's tail order),
  `dashboard/shell.tsx` (nav, appended last), `app-shell.tsx` (render).

---

## 8. Automated tests

| Suite | Result | What it pins |
|---|---|---|
| `tests/phase-h-progression.test.js` (**new**) | **169 / 0** | 38 enumerated cases in four layers: the pure matrix compiled and exercised; the ENGINE run against a fake DB for every rule (video ≥ 95 %, quiz PASS, homework SUBMITTED, attendance-never-completes, hold boundary, catch-up, overrides, determinism, reader agreement); `progression-overrides.ts` for real (reason, actor, expiry, role gate, idempotency, no fabrication); source invariants over the shipped HTTP surface |
| `session-progression` | 170 / 0 | the historical shape still agrees with the engine |
| `track-architecture-phase12` | 310 / 0 | track isolation of the universe |
| `curriculum-reconciliation-phase11` | 56 / 0 | the universe query applies the lifecycle filter |
| `production-storage-phase21` | **181 / 0** (was 179 / 2) | additive-only schema growth on both providers, live PostgreSQL rehearsal with a real `ProgressionOverride` row |
| `migration-providers` | 147 / 0 | both provider chains + checksums |
| `security-hardening` | 398 / 0 | admin routes are ADMIN-gated |
| `session-quiz` | 71 / 0 | the quiz gate is the canonical one |
| `payment-lifecycle-phase25-pr2a` | 169 / 0 | entitlement + progression interaction |
| `phase26a-public-auth` | 121 / 0 | unauthenticated surfaces |
| `presigned-uploads-phase23` | 327 / 0 | media gating through the same verdict |
| `session-media-publishing-audit` | 218 / 0 | recordings stay content, not requirements |
| `phase26e-parent-full-flow` | 380 / 0 | parent reads the canonical answer |
| `lesson-content-aggregation-phaseC` | 166 / 0 | the Phase C summary never restates the 95 % rule |

Three suites whose **source pins** pointed at `session-progress.ts` were repointed at the module
that now owns the rule (`curriculum-reconciliation-phase11`, `lesson-content-aggregation-phaseC`,
`session-lifecycle-phase13`). The pin's *meaning* is unchanged; only its location moved with the
code it protects. `calendar-i18n-phase9` gains 4 assertions (+1 nav label, checked as a dict key
that resolves in Arabic and in English) — the suite is designed to grow exactly that way.

**Full-suite comparison (87 suites, branch vs. the merged `main` commit `494b87e`):**

* **0 regressions** — no suite that passed on `main` fails on this branch, and no suite loses an
  assertion. Verified twice: by exit code **and** by comparing each suite's internal
  "N passed / M failed" count against the baseline run (a handful of suites exit 0 while reporting
  internal failures, so the exit code alone would have hidden them).
* 4 suites additionally **fixed** (`payment-lifecycle-phase25-pr2a` 168/1 → 169/0,
  `phase26a-public-auth` 120/1 → 121/0, `production-storage-phase21` 179/2 → 181/0, plus the new
  `phase-h-progression`).
* 17 suites fail **identically on both** — pre-existing and unrelated to Phase H (they need a live
  database, a browser, network, or a PostgreSQL instance). Verified pairwise, not assumed:
  `final-integration-phase22`, `group-track-recovery-postgres`, `media-storage-wiring`,
  `parent-analytics-alignment-phase19`, `parent-dashboard-isolation`,
  `payment-experience-phase25-pr3`, `payment-lifecycle-phase25-ledger`, `pg-baseline-inspection`,
  `phase25-pr4-release-gate`, `phase26b-group-track`, `phase26c-admin-full-flow`,
  `post-launch-admin-lifecycle`, `session-lifecycle-phase13`, `session-materials-phase14`,
  `session-notifications-phase17`, `student-locked-curriculum-phase16`,
  `student-session-media-alignment-phaseB`.

**ESLint (changed files only, no repo-wide cleanup, no blanket disables, no `--fix`):**

* New files (`progression-*.ts`, the three routes, the admin console, `phase-h-progression.test.js`)
  introduce **0** violations.
* Modified files report **exactly the baseline count**, file by file:
  `student-course.tsx` 1 → 1, `student-lesson.tsx` 2 → 2, `parent-dashboard.tsx` 1 → 1,
  `student-dashboard.tsx` 2 → 2 (all `react-hooks/set-state-in-effect`), and the seven test files
  with `@typescript-eslint/no-require-imports` are byte-identical in count
  (2 / 8 / 11 / 6 / 2 / 10 / 7). Total 52, all pre-existing.
* `react-hooks/set-state-in-effect` is a **repo-wide systemic** rule (57 occurrences in `src/`,
  including the canonical data-fetching components). The new admin console has **0**: it loads on
  **events** (pick a student / issue / revoke) instead of in an effect, which is also the pattern
  React recommends for data that depends on a user action.

---

## 9. Manual QA matrix (Arabic-first, RTL)

Run on a seeded course with ≥ 5 sessions, one quiz and one homework. **Every row must be executed
in Arabic (RTL) first**, then once in English.

| # | Precondition | Action | Expected |
|---|---|---|---|
| H1 | Session 1 video watched to 94 % | Open the course tree | Session 2 is LOCKED; the row reads «أكمل الفيديو الأول»; session 1, its quiz, its homework and its history stay open |
| H2 | Same, watch to 95 % | Reload | Session 2 unlocks; the reason disappears |
| H3 | Session 1 quiz **attempted and failed** (score < pass mark) | Reload the tree | Session 2 stays LOCKED with «لازم تنجح في الـQuiz» — submitting is **not** enough |
| H4 | Retake and **pass** | Reload | Session 2 unlocks |
| H5 | Session 1 homework **not submitted** | Reload | Session 2 LOCKED with «سلّم الـHomework الأول» |
| H6 | Submit (do **not** wait for grading) | Reload | Session 2 unlocks — grading is irrelevant |
| H7 | Session 1 has **no** quiz and **no** homework | Watch its video | Session 2 unlocks; no quiz/homework is ever mentioned (no invented requirement) |
| H8 | Session 1 has **no** video, quiz or homework | Open the tree | Session 1 is COMPLETED; it never locks anyone |
| H9 | Marked PRESENT in session 1's live session, nothing else done | Reload | Nothing completes. Attendance never completes a lesson |
| H10 | UNEXCUSED absence on session 3 (Phase F: review → UNEXCUSED → ACTIVE hold) | Open the tree | Session 4+ are LOCKED with «عندك غياب محتاج تعويض»; session 3 itself, its recording, quiz, homework and all history stay **open** |
| H11 | Same | Open `GET /api/students/me/catch-up` | The catch-up lists **only** requirements that exist for session 3 (no quiz ⇒ no quiz line; no attendance line) |
| H12 | Complete exactly the listed catch-up items | Open the tree | The block is gone; the student is never trapped |
| H13 | Same, click «أنا خلصت التعويض» twice | — | First call resolves; the second reports «التعويض كان متسجل قبل كده»; one audit row only |
| H14 | EXCUSED absence (Phase F) | Open the tree | **No** hold, no block, no catch-up banner |
| H15 | Student with an ACTIVE hold | `POST /api/admin/progression/overrides` as **TEACHER** | 403. A teacher has no unlock authority |
| H16 | Same, as **ADMIN**, empty reason | — | 400 «لازم تكتب سبب للاستثناء»; no row is written |
| H17 | Same, as **ADMIN**, valid reason | — | The session opens; the student sees «الإدارة فتحتلك الجلسة دي كاستثناء — الحالة الأكاديمية زي ما هي.» |
| H18 | Same | Re-issue the identical override | Idempotent — the same row, `created: false`, no second audit event |
| H19 | After H17 | Check the quiz/homework/video rows | **Nothing was fabricated**: no attempt, no submission, no watch progress; the hold still exists |
| H20 | Admin issues an override with `expiresAt` in the past | — | 400 «تاريخ الانتهاء لازم يكون في المستقبل» |
| H21 | Override with a future expiry; wait until it passes | Reload | The block returns **by itself**; the row still exists in the history as expired |
| H22 | Revoke an active override | Reload | The block returns; the history still shows who issued it, when, and who revoked it |
| H23 | Revoke the same override again | — | Idempotent, no duplicate audit row |
| H24 | Locked session, **mobile** width, Arabic | Open the course tree | The reason is visible **on the row** (not only in a tooltip); layout is RTL, no physical `left/right` |
| H25 | Parent dashboard | Open the child card | Session counts are **unchanged** from before Phase H (the `completed` flag stayed academic) and the blocked reason is shown in Arabic |
| H26 | Student on the ARABIC track | Open the tree | LANGUAGE-only sessions are invisible (404, never 403); guessing an id teaches nothing |
| H27 | Archived / DRAFT session | — | Never in the universe, never a boundary |
| H28 | Two browser tabs, both clicking «أنا خلصت التعويض» | — | One resolution, one audit row, no error |
| H29 | Admin console | Search a student by name and by code | Results come from the server; selecting one shows the canonical boundary of that student only |
| H30 | Admin console, RTL | Issuing and revoking | All controls read right-to-left; the warning card is visible **before** the form |

---

## 10. What Phase H deliberately does NOT do

* Does **not** rewrite Phase F (holds), 26D/G (quiz) or G (homework) — it reads their verdicts and
  delegates their writes.
* Does **not** move entitlement/subscription logic into progression (entitlement stays in
  `canAccessLesson` / `getUnlockedLessonIds`, where it already was — pushing it into the course
  evaluation blanked the dashboards during development and was reverted).
* Does **not** treat a modern `SessionVideo` recording as a progression requirement: recordings are
  published *after* the session and are batch-scoped, so the video requirement stays
  `Lesson.videoUrl` + the server heartbeat.
* Does **not** give any role other than ADMIN a manual unlock.
* Does **not** delete, migrate or rewrite any existing row.

## 11. Rollback

The change is additive and behaviour-preserving except for the approved rule changes (§2.2 / §2.3 /
§3). Rolling back the code — without rolling back the migration — leaves one unused table and
restores the pre-Phase-H "attempt is enough" rule. Rolling back the table is a single
`DROP TABLE "ProgressionOverride"` and destroys only administrative exception records (no academic
data lives in it). **No rollback has been performed; nothing was deployed.**
