# Phase 12 — Track Architecture & Cross-Track Enforcement: FINAL REPORT

**Date:** 2026-09-09 · **Repo:** `Muhammed-Fathi/codemind-academy` · **Status: COMPLETE — PR open, NOT merged**

---

## 1. Executive summary

Phase 12 is implemented, verified and pushed. The two target invariants — **ARABIC student → `SHARED` + `ARABIC` only**, **LANGUAGE student → `SHARED` + `LANGUAGE` only** — are now structurally true **server-side and fail-closed**, over the single existing shared course `programming-ai-2nd-sec`.

The mandatory prerequisite (the Phase 11 reconciler crash) was reproduced, root-caused and fixed first, with a regression gate that provably catches it.

| headline | value |
|---|---|
| Branch | `arena/01a085a4-codemind-academy` |
| Commit | `06a5f08` (base `66f56f5`) |
| PR | **#29 — OPEN, `merged_at: null`, not a draft, 9 commits** |
| Files changed | 42 (+3,621 / −126) |
| Offline test assertions | **2,111 passed, 0 failed** across 17 suites |
| `tsc --noEmit` | **0 errors** |
| `eslint` on Phase 12 files | **0 findings** |
| Real-database end-to-end (real client, real SQLite, unmodified source) | **37 passed, 0 failed** |
| Migration re-run against **real data** (scratch DB, pre-Phase-12 schema) | **30 checks, 0 failures** |
| **Live HTTP** (production build, real sessions, real DB) | **11 passed, 0 failed** |
| `npm run build` (production build) | **exit 0**, 0 warnings, 62/62 static pages |
| Merged? | **NO — stopped for pre-merge review, as instructed** |

---

## 2. Scope and acceptance criteria

**Delivered:** `TrackScope` enum + `Lesson/Quiz/Homework.trackScope`; constrained/normalised `Student.schoolType`; lesson, quiz (selection **and** grading), homework and video track isolation; `reconcileStudentBatch()` healing on all write paths; teacher question tagging; parent-follows-child track; track-safe analytics primitives; additive-only migration; backfill with 0 invalid values; `tests/track-architecture-phase12.test.js`; full Phase 11 + Phase 12 combined regression; `docs/PHASE_12_TRACK_ARCHITECTURE.md` + updated `docs/PROJECT_STATE.md`; PR opened and **not** merged.

**Explicitly not touched (Phase 13+):** PDF/material upload, publishing/lifecycle, notifications, admin publishing UI, PostgreSQL, Kodgy AI, security Phase 20, UI redesigns.

**Also not done, by design:** no second course, no second progression engine, no second enrollment gate, no new indexes, no rewrite of `Question.schoolType` semantics.

---

## 3. Branch, commit and PR identity

- Branch `arena/01a085a4-codemind-academy`, single commit `585f550`, based on `66f56f5` of `main`.
- `gh pr view 29` → `{"state":"OPEN","isDraft":false,"mergedAt":null,"baseRefName":"main","changedFiles":36,"additions":2958,"deletions":125}`.
- Local verification scratch was deliberately **excluded** from the commit: `.verify/`, `prisma.config.ts`, `.probe.cjs` remain untracked; `.env` and `prisma/db/custom.db` are covered by `.gitignore`.

---

## 4. Prerequisite — the Phase 11 defect, reproduced

Running the real, unmodified reconciler against a real database produced:

```
PrismaClientValidationError: Unknown argument `createdAt`
  at src/lib/official-curriculum.ts:313
```

captured at the time in `.verify/baseline-reconcile-failure.txt`.

---

## 5. Prerequisite — root cause

`reconcileOfficialCurriculum` ordered `Part` and `Unit` with `orderBy: [{ order: "asc" }, { createdAt: "asc" }]`. Neither model has a `createdAt` column — read directly out of `prisma/schema.prisma`:

| model | columns |
|---|---|
| `Part` | `id, courseId, title, titleAr, order, description` |
| `Unit` | `id, partId, title, titleAr, order, icon` |

(`Lesson` *does* have `createdAt`, which is presumably where the assumption came from.)

---

## 6. Prerequisite — the fix, as instructed

No `createdAt` was added to `Part`/`Unit`; no migration was created to satisfy the query. A shared, deterministic tie-breaker replaced it:

```ts
// src/lib/official-curriculum.ts
export const PART_UNIT_ORDER_BY = [{ order: "asc" }, { id: "asc" }] as const;
```

applied to both `part.findMany` and `unit.findMany`. `id` is the primary key, so `order ASC, id ASC` is a **total** order — positional adoption stays deterministic and idempotent.

Verified against the real database: two consecutive reconciler runs, both returning `partsReconciled: 2, partsCreated: 0, unitsReconciled: 7, unitsCreated: 0, lessonsCreated: 0, lessonsUpdated: 0, archivedLessonIds: []` — the second run performed **zero writes**.

---

## 7. Prerequisite — why 51 green assertions missed it

`tests/curriculum-reconciliation-phase11.test.js` drives a mock Prisma client that **ignored `orderBy` entirely** and even *synthesised* `createdAt` values in its own `sortByOrder` helper. The reconciler therefore only failed against a real database.

The mock now parses the field lists of `Part` and `Unit` straight out of `prisma/schema.prisma` and rejects any `orderBy` key that is not one of them, mirroring `PrismaClientValidationError`. The suite's assertion count is unchanged at **51/0** — the gate is a strengthening, not a rewrite.

---

## 8. Prerequisite — mutation proof

Re-introducing `{ createdAt: "asc" }` into the reconciler:

```
TEST CRASH: Error: Unknown argument `createdAt` on part.orderBy — not a column in
prisma/schema.prisma (available: id, courseId, title, titleAr, order, description, course, units)
```

Restoring the fix → back to `51 passed, 0 failed`. The gate is a detector, not decoration.

---

## 9. Phase 12 design decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **One shared `Course`.** Track is a property of *content*, not of the course. | Requirement; avoids duplicating 23 official lessons per track. |
| D2 | `enum TrackScope { SHARED ARABIC LANGUAGE }` + `@default(SHARED)` on Lesson/Quiz/Homework. | Every pre-existing row is immediately valid with **no** data rewrite. |
| D3 | `Student.schoolType` `String?` → `SchoolType?`, **still nullable**. | "Unspecified" is a real state (admin UNSPECIFIED tab; students born outside registration). `NULL` **fails closed** to SHARED-only. |
| D4 | Session videos get **no new column**; track derives from non-nullable `Batch.schoolType` (`@@unique([schoolType, courseId])`). | A video is already batch-scoped; a "shared" video is two published rows on one `MediaAsset`. |
| D5 | Question track stays `Question.schoolType SchoolType?`; **`NULL` means SHARED**. | Already existed (Phase 8). No new column, no rewrite. |
| D6 | Prisma `Track`/`Enrollment` documented as **DEPRECATED / DEAD SCHEMA** (0 references in `src/`); `Group → Course` via `getEnrollment` stays the **sole** gate. | Requirement: no second enrollment gate. Documented in-schema so nobody re-animates them. |
| D7 | `NULL` or unrecognised school type → **SHARED-only**, never a guess. | Fail closed; unrecognised values are refused at write time and reported, never silently mapped. |
| D8 | No new indexes. | The new columns filter already-indexed queries; SQLite rebuilds preserve existing indexes. |

---

## 10. Schema changes

- `enum TrackScope { SHARED ARABIC LANGUAGE }` (new)
- `Lesson.trackScope TrackScope @default(SHARED)`
- `Quiz.trackScope TrackScope @default(SHARED)`
- `Homework.trackScope TrackScope @default(SHARED)`
- `Student.schoolType String?` → `SchoolType?`
- Deprecation docblocks on `Track`, `Enrollment`, and `Course.trackId`
- `generator client` block left **byte-identical** to `HEAD` (verified — no `engineType`/`previewFeatures` leftovers)

`prisma/schema.prisma` diff: +71/−… lines; no existing field removed or renamed.

---

## 11. The migration

`prisma/migrations/20260909120000_phase12_track_architecture/migration.sql` (145 lines), **additive only**:

1. **Normalise first.** Three `UPDATE "Student" SET "schoolType" = CASE …` statements map the ARABIC aliases (`ARABIC`, `AR`, `عربي`) and the LANGUAGE aliases (`LANGUAGE`, `LANGUAGES`, `LANG`, `لغات`), and set anything else to `NULL` — *never* a guess. Running this before the DDL means the enum change cannot strand a value.
2. **Add the columns.** `trackScope TEXT NOT NULL DEFAULT 'SHARED'` on all three tables.
3. SQLite has no `ALTER COLUMN`, so Prisma emits table rebuilds. All **three** `INSERT INTO "new_…"` copy statements are present, indexes are recreated, **no row is deleted**, and **no historical migration was edited**.

`npx prisma migrate status` → **"5 migrations found in prisma/migrations / Database schema is up to date!"**

`SQLite RAISE(ABORT, …)` is only legal inside a trigger program, so the "0 invalid values" invariant is asserted in tests rather than in SQL.

---

## 12. Critical schema finding — SQLite enums have no CHECK constraint

**`Student.schoolType String?` → `SchoolType?` produces ZERO DDL.** Prisma maps a SQLite enum to plain `TEXT` with no `CHECK`; the constraint lives in the **client**, which throws when it *reads* an out-of-enum value.

Consequences, both recorded in the docs:
- the migration's normalisation step is the **real** safety mechanism, not the type change;
- a value written by raw SQL (or a future direct-SQL migration) can still be out-of-enum. The reconciler **fails closed** on such a value (`NO_SCHOOL_TYPE`, no batch assigned) rather than guessing, and the row must be fixed in data.

The same is true of `trackScope` — the application layer is the only gate.

---

## 13. `src/lib/track-scope.ts` — the single source of truth (new, 273 lines)

Every route and engine imports this; nothing else encodes the matrix.

| export | contract |
|---|---|
| `TrackScope`, `TRACK_SCOPES`, `TRACK_SCOPE_LABELS` | the three values + AR/EN labels |
| `normalizeTrackScope(value)` | case-insensitive match → the value; **anything else → `null`, never `SHARED`** |
| `isTrackScope` | type guard |
| `eligibleTrackScopes(schoolType)` | `["SHARED", schoolType]`; unrecognised/`null` → `["SHARED"]` |
| `canAccessTrackScope(schoolType, scope)` | **the matrix**; unknown on either side → `false` except `scope === "SHARED"` |
| `trackScopeWhere` / `trackScopeInWhere` | `{ trackScope: { in: […] } }` — the Prisma predicate |
| `videoTrackFilter(schoolType)` | `{ batch: { schoolType } }`; unrecognised → an **empty** `in: []` (no videos, not both tracks) |
| `eligibleQuestionFilter` / `isQuestionEligible` | question selection **and** grading predicate |
| `resolveQuestionSchoolType` / `parseQuestionSchoolTypeInput` | teacher tagging precedence |

---

## 14. The cross-track matrix

| student | SHARED | ARABIC | LANGUAGE |
|---|---|---|---|
| **ARABIC** | ✅ | ✅ | ❌ |
| **LANGUAGE** | ✅ | ❌ | ✅ |
| **`NULL` / unrecognised** | ✅ | ❌ | ❌ |

Asserted cell-by-cell through `canAccessTrackScope`, `eligibleTrackScopes`, `trackScopeWhere`, `canAccessLesson`, `canAccessQuiz`, `canAccessHomework`, `seedAttemptQuestions`, `loadAttemptQuestionSet`, `loadQuizQuestionSet`, `gradeAttemptQuestionSet`, `videoTrackFilter` and `isParentAllowedTrackScope` — and again end-to-end against the real database.

---

## 15. Lesson & progression enforcement

`src/lib/session-progress.ts` — the **one** Phase 4 progression engine, semantics unchanged:

1. **Universe filter.** `getCourseSessionProgress` adds `...trackScopeWhere(resolvedSchoolType)` to the lesson `findMany`. An ineligible lesson never enters `sessions`, is absent from `byLessonId`, and can never be an unlock target or the continuation pointer.
2. **Explicit gate.** `canAccessLesson` re-checks `canAccessTrackScope(schoolType, lesson.trackScope)` *after* the enrollment check, so the rule stays correct even if a future reader widens the query.
3. **Non-oracle verdict.** A cross-track lesson returns exactly what a nonexistent id returns: `{ allowed: false, reason: "LESSON_NOT_FOUND", status: null }`. Probing ids from the other track cannot reveal that a lesson exists.
4. `getUnlockedLessonIds` inherits (1) for free.

Tested: the ARABIC universe excludes the LANGUAGE lesson and vice-versa; `currentLessonId` never lands on the other track; with all content SHARED the universe is **unchanged** by Phase 12.

---

## 16. Quiz selection, serving and grading enforcement

`src/lib/session-quiz.ts` gained a fourth `schoolType` parameter on all four entry points:

| function | effect |
|---|---|
| `seedAttemptQuestions(attemptId, quizId, schoolType)` | only eligible questions are frozen into the attempt |
| `loadAttemptQuestionSet(attemptId, schoolType)` | re-filters an **already frozen** set, so an attempt created before Phase 12 that holds a foreign-track question is still narrowed at serve time |
| `loadQuizQuestionSet(quizId, schoolType)` | the live/retake path applies the same predicate |
| `gradeAttemptQuestionSet(set, answers, passMark, schoolType)` | an ineligible question contributes to **neither `score` nor `totalMarks`** |

Selection and grading use the **same** predicate. Proven by test: grading a set containing only an ineligible question yields `totalMarks: 0, score: 0, graded: []`; grading the *selected* set and the *full* set give identical `score`/`totalMarks`; and because the denominator shrinks with the eligible set, the percentage is **not** deflated.

---

## 17. Homework, video and media enforcement

| surface | rule |
|---|---|
| `canAccessHomework` | resolves to the owning lesson, re-uses `canAccessLesson`, adds `gateTrackedResource` on the homework's own `trackScope` — so a LANGUAGE assignment on a SHARED lesson is still refused |
| Session videos | `...videoTrackFilter(enrollment.schoolType)` **alongside** the existing `isPublished: true` + `batchId` checks (both still enforced) |
| `media/[id]` | requires `v.batch.schoolType === studentSchoolType` **and** `v.isPublished` **and** `v.batchId === student.batchId` |

---

## 18. Route-by-route enforcement (21 route files changed)

`admin/ai-generate-quiz`, `admin/batches`, `admin/question-bank`, `admin/students`, `admin/students/[id]`, `auth/[action]`, `courses/[slug]`, `enroll`, `lessons/[id]`, `media/[id]`, `parents/me/analytics`, `parents/me/dashboard`, `parents/me/weekly-report`, `quizzes/[id]`, `quizzes/[id]/start`, `quizzes/[id]/submit`, `students/me/certificate`, `students/me/dashboard`, `students/me/homework`, `students/me/session-videos`, `teacher/quizzes`.

(Count verified against `git diff --name-only main..HEAD -- 'src/app/api/**/route.ts'` → 21.)

Notables:
- `courses/[slug]` computes one `viewerTrackFilter` (the student's own school type, or `getParentTrackScopes` for a parent) and applies it to **both** curriculum chains;
- `lessons/[id]` applies it to quizzes, homework **and** prev/next;
- `quizzes/[id]` + `/start` + `/submit` derive the track via `getStudentSchoolType` server-side and gate parent preview via `isParentAllowedTrackScope`;
- `students/me/homework` applies `trackScopeWhere(schoolType)`.

---

## 19. Batch reconciliation contract

New `reconcileStudentBatch()` in `src/lib/enrollment.ts` (`syncStudentBatch` kept as an alias). `Batch.schoolType` is **required** and `@@unique([schoolType, courseId])`, so the batch is the join between a student's track and their course; before Phase 12 a `schoolType` or `groupId` change left a stale `batchId` behind.

- **deterministic + idempotent** — a re-run over unchanged state returns `changed: false` and writes nothing;
- **never assigns without a recognised school type** (`NO_SCHOOL_TYPE`, no write, nothing invented);
- preference order: an **ACTIVE course-specific** batch → an **ACTIVE course-less** batch → **never** another course's;
- **clears** a wrong-track/wrong-course batch when no correct one exists (`CLEARED`) rather than keeping it;
- reasons: `OK | ASSIGNED | REPLACED | CLEARED | NO_SCHOOL_TYPE | NO_BATCH | NO_ENROLLMENT`.

`attachUnassignedStudentsToBatch(batchId)` is assign-only (verified: it never reassigns an already-attached student, and re-running attaches nobody).

---

## 20. Write-path wiring

All five write paths now reconcile:

| path | change |
|---|---|
| `auth/[action]` (register) | `requireSchoolType` + `reconcileStudentBatch` |
| `admin/students` (create) | `requireSchoolType` + `reconcileStudentBatch` |
| `admin/students/[id]` (PATCH) | `requireSchoolType` + reconcile on **`schoolTypeChanged \|\| groupChanged`** |
| `api/enroll` | `reconcileStudentBatch(student.id)` (a course change) |
| `admin/batches` (create) | `attachUnassignedStudentsToBatch` |

---

## 21. School-type validation at write time

`requireSchoolType` (`src/lib/school-type.ts`) returns `{ ok, value?, reason? }`:

- accepts the documented legacy aliases — `AR`, `عربي`, `LANGUAGES`, `LANG`, `لغات` — plus case/whitespace variants;
- rejects everything else with `reason: "INVALID"` (or `"EMPTY"` for null/blank);
- routes answer **HTTP 400** using the new i18n keys `api.228` / `api.229`.

Unknown values are **reported and refused**, never silently mapped to SHARED (an explicit user constraint).

---

## 22. Teacher question tagging

`POST /api/teacher/quizzes` sets `Quiz.trackScope` explicitly and resolves each question's `schoolType` via `resolveQuestionSchoolType`, with this precedence:

1. an **explicit** payload value wins — including an explicit `SHARED`, stored as `NULL` (D5);
2. otherwise **inherit the owning quiz's `trackScope`** when it is `ARABIC`/`LANGUAGE`;
3. otherwise `NULL` (shared).

Inherited from the **quiz**, not the lesson, because a SHARED lesson may legitimately host both an ARABIC and a LANGUAGE quiz. An unrecognised value is **rejected** (`parseQuestionSchoolTypeInput` → `ok: false`, HTTP 400), never downgraded. `POST /api/admin/question-bank` and `/api/admin/ai-generate-quiz` follow the same rule.

---

## 23. Parents follow the child's track

`src/lib/parent-access.ts` gained `getParentTrackScopes(parentUserId)` and `isParentAllowedTrackScope(parentUserId, scope)`:

- the scope set is the **union** of the school types of the parent's **LINKED and ENROLLED** children, always including `SHARED` — the same population `getParentCourseIds` already uses;
- a parent of an unspecified child gets `SHARED` only;
- refusal is a bare **404**;
- an unrecognised or missing scope is refused, **not** treated as SHARED.

---

## 24. Track-safe analytics primitives

Additive to `src/lib/quiz-analytics.ts`: `TRACK_BUCKETS`, `trackBucketOf`, `partitionByTrack`, `summarizeFinishedAttemptsByTrack`.

Two deliberate asymmetries from authorization, recorded in the file:
- a **report** buckets an unknown tag as `SHARED` rather than **dropping the row** (a report must account for every attempt; authorization must not);
- every bucket re-uses `summarizeFinishedAttempts`, so a split can never disagree with its total.

Buckets are deliberately **not** summed back together, because an attempt set may span scopes. All Phase 6 rules (attempt-weighted averages, finished-attempts-only) are preserved — verified by the existing 44-assertion suite.

---

## 25. Security boundary

Asserted in the test suite as its own section:

- **no route** derives `trackScope` or `schoolType` from `body`, `params`, or `searchParams`;
- `track-scope.ts` never reads a UI locale, `Accept-Language`, or `headers()`.

Every authorization decision is made server-side from a database lookup. Frontend hiding is decoration only.

---

## 26. The new test suite

`tests/track-architecture-phase12.test.js` — **301 assertions, 0 failures**, four layers:

- **A. Pure contract** — `track-scope` + `school-type` compiled with `tsc` and exercised directly: every accepted spelling, every rejected value, the full matrix, fail-closed on both sides, tagging precedence, Prisma predicates.
- **B. Behavioural** — the *real* `session-progress`, `session-quiz`, `enrollment`, `parent-access`, `quiz-analytics` compiled and run against a fake `@/lib/db` modelling the Phase 12 schema: the 9-cell lesson matrix, progression-universe exclusion, unlock targets, quiz selection/serving/grading incl. crafted-answer and legacy-frozen-set cases, all batch-reconciliation cases, video semantics, parent scopes, analytics buckets.
- **C. Source invariants** — every track-sensitive route is read and asserted, plus the security-boundary section.
- **D. Schema + migration** — the enum, the three columns and their defaults, `Student.schoolType` no longer a `String`, the dead-schema docblocks, normalisation preceding the DDL, no data deletion, all three row-copy statements.

**Mutation-verified:** neutering `canAccessTrackScope` → **25 failures**; removing the progression universe filter → **6 failures**; restored → **0**.

---

## 27. Regression — combined Phase 11 + Phase 12

**Existing suites were repaired, never weakened.** Five suites' fixtures predate the new NOT NULL columns and were updated to carry the schema's real default (`trackScope: "SHARED"`); `parent-monthly-report`'s mock gained a `batch` stub so `reconcileStudentBatch` correctly observes "no matching batch"; mock clients were extended to resolve the new `@/lib/*` imports and to honour `where.trackScope.in`; **three source-invariant regexes in `session-progression` were tightened** to pin the new `trackScope` select and filter.

Baselines were captured with `git stash` **before** the changes and are identical **after**:

| suite | baseline | after |
|---|---|---|
| authorization-invariants | 93 / 0 | 93 / 0 |
| calendar-i18n-phase9 | 440 / 0 | 440 / 0 |
| curriculum-reconciliation-phase11 | 51 / 0 | 51 / 0 |
| kodgy-phase10 | 231 / 0 | 231 / 0 |
| migration-sql | 15 / 0 | 15 / 0 |
| mock-exam-grading-isolation | 22 / 0 | 22 / 0 |
| mock-exam-phase8 | 135 / 0 | 135 / 0 |
| parent-dashboard-isolation | 112 / 0 | 112 / 0 |
| parent-monthly-report | 67 / 0 | 67 / 0 |
| platform-upgrade-2026-migration | 98 / 0 | 98 / 0 |
| quiz-analytics | 44 / 0 | 44 / 0 |
| registration-validators | 24 / 0 | 24 / 0 |
| security-hardening | 239 / 0 | 239 / 0 |
| seed-idempotency | 18 / 0 | 18 / 0 |
| session-progression | 151 / 0 | 151 / 0 |
| session-quiz | 70 / 0 | 70 / 0 |
| **track-architecture-phase12 (new)** | — | **301 / 0** |
| **total** | **1,810** | **2,111 / 0 failures** |

`npm run typecheck` (`tsc --noEmit`) → **0 errors**. `eslint` on the Phase 12 lib files → **0 findings**, and the new test file is clean too (it carries
the same `no-require-imports` disable the other suites use). Measured properly rather than
asserted: a `git worktree` at the base commit `66f56f5` reports **83 lint problems**, and linting
**only the committed files** at HEAD also reports **83** — byte-identical, so Phase 12 introduces
**zero** new lint problems in anything that ships. (A full `npm run lint` reads 113 only because it
also scans the untracked local `.verify/` harness, which is not in the PR and not committed.) The
two pre-existing test files this phase edited are unchanged at 20 problems each.

---

## 27b. Completeness audit — every route that reads track-scoped content

Gating the obvious endpoints is not enough, so **all 80 route files** were audited for reads of
`Lesson` / `Quiz` / `Homework` / `SessionVideo` / `MediaAsset` / `Question`. Five further surfaces
needed slicing, and they are precisely the kind that a surface-level pass misses — **denominators
and embedded lists**:

| surface | defect found |
|---|---|
| `students/me/dashboard` | course-progress denominator counted the other track's lessons, and the **embedded homework list returned other-track rows and titles — an outright content leak** |
| `students/me/certificate` | the 80% threshold divided by lessons the student can never open, making the certificate unreachable in a mixed-track course |
| `parents/me/dashboard` | per-child universe and homework list unfiltered — now sliced to **that child's** track, not the parent's union |
| `parents/me/analytics` | universe unfiltered — now sliced to the union of the linked children's tracks |
| `parents/me/weekly-report` | same defect, same union rule |

Verified **already safe by construction** rather than assumed:
- `lessons/[id]/progress` → calls `canAccessLesson`, which carries the track gate;
- `students/me/session-videos/[id]/progress` → enforces `video.batchId === student.batchId`, and `Batch.schoolType` is non-nullable, so track follows automatically;
- `students/me/dashboard`'s unlocked-lesson set → comes from `getUnlockedLessonIds`, which inherits the filtered universe;
- quiz-attempt lists (student, parent, teacher) → restricted to the student's own attempts, which can only exist for quizzes they were allowed to open;
- `quizzes/[id]/evidence` → calls `canAccessQuiz` before any file write, then checks attempt ownership;
- `exams/mock` → Phase 8 already derives `studentSchoolType` from the database and refuses a `MockExam` whose `schoolType` differs (404); the question pool is restricted by `questionBankFilter(studentSchoolType)`. Its `lessons` query is deliberately **not** track-filtered — it only scopes which lessons may contribute questions, and the operative gate is the question's **own** `schoolType`. A question on an ARABIC-only lesson but tagged `NULL` is shared content by D5, so serving it is correct: `trackScope` governs *lesson access*, not question eligibility.

`teacher/*` and `admin/*` surfaces are deliberately **not** sliced: staff legitimately serve both
school types.

Nine new assertions pin all five fixes. **Mutation-verified:** deleting only the dashboard
homework filter → `FAIL: students/me/dashboard slices BOTH the lesson universe and the homework
list`; restored → 301/0.

## 27c. Pre-merge review — findings and fixes

A 22-section read-only review was run against the real database before the merge decision.
It reproduced every claim above independently rather than re-reading the report. Three findings.

### Finding 1 — FIXED: the admin-create write path did not heal the batch

`src/app/api/admin/students/route.ts` **imported** `reconcileStudentBatch` but never called it —
the import appeared exactly once in the file, on the import line. The call had been dropped while
wiring the write paths.

*Origin:* introduced by Phase 12. `git show 66f56f5:src/app/api/admin/students/route.ts` has no
occurrence of `reconcileStudentBatch` at all, so the unused import is a Phase 12 artefact, and
"healing on all write paths" is a Phase 12 deliverable. This was a defect in the Phase 12 work,
not a pre-existing one.

*Consequence, measured:* creating a student with `schoolType: "ARABIC"` and a valid `groupId`
persisted the school type correctly and left `batchId = null`. Track-scoped lessons, quizzes and
homework were unaffected — those are gated by `schoolType` through `eligibleTrackScopes`, which
still returned `["SHARED","ARABIC"]`. But `batchId` is the key for **batch-scoped** content, so
session videos and media were unreachable: the query returned `videos=0` for a published video in
the student's own ARABIC batch. The row healed on the student's next login (`auth/[action]` calls
the reconciler), but until then a parent reading the child's dashboard saw no videos.

*Fix:* call `reconcileStudentBatch(created.id)` immediately after `createStudentWithCode`, before
the row is re-read for the response.

*Verified end to end over real HTTP:* a production build was started, an admin session issued, and
`POST /api/admin/students` called with `schoolType: "ARABIC"` + `groupId`. Result — **9/9**: HTTP
200; `schoolType = ARABIC`; `batchId = V19H-b-ar` (non-null immediately, no login required); the
batch's `schoolType` matches the student; the batch belongs to the group's own course; the
published ARABIC session video is reachable (`videos=1`); the ARABIC lesson is in scope and the
LANGUAGE lesson is out.

*Pinned:* new section **28c** asserts all four student write paths actually call the primitive,
that the admin-create call sits **after** the row exists, and that the school type is validated
rather than silently nulled. **Mutation-verified:** replacing the call with a comment → `FAIL:
admin/students/route.ts actually CALLS reconcileStudentBatch` and `FAIL: heals AFTER the student
row exists`; restored → 301/0.

### Finding 2 — ~~PRE-EXISTING, reported not fixed~~: a parent can open an unpublished lesson

> **CLOSED by Phase 13 (2026-09-10).** `isParentLessonPreviewAllowed` in `src/lib/parent-access.ts` now combines the lifecycle clause with the track and course clauses, and is the single gate for `lessons/[id]` and `quizzes/[id]`. See `docs/PHASE_13_SESSION_LIFECYCLE.md` §5 and the `REAL CODE — the parent preview gate` section of `scripts/verify-phase13-db.mjs`. The analysis below is kept verbatim as the record of what was measured.

`GET /api/lessons/<id>` returns **200** to a parent whose child is eligible, with no `isPublished`
check on the parent branch.

**Measured at both commits, not inferred.** Base `66f56f5` was built in a throwaway worktree and
run against the same database and the same fixtures, then probed over HTTP alongside HEAD:

| Probe (same cookie, same fixture) | BASE `66f56f5` | HEAD `2206661` | |
| --- | --- | --- | --- |
| parent → UNPUBLISHED lesson, `trackScope: SHARED` | **200** | **200** | identical — the finding is unchanged |
| parent → UNPUBLISHED lesson, `trackScope: LANGUAGE` | **200** | **404** | HEAD is stricter |
| student → media id that EXISTS (`EXTERNAL_URL`) | **400** | **400** | identical |
| student → media id that does NOT exist | **404** | **404** | identical |

The exposure is therefore unchanged for the case that matters, and **strictly narrower** for a
LANGUAGE-tagged draft: Phase 12's new `isParentAllowedTrackScope` guard sits *after* the existing
`isParentAuthorizedForCourse` check, so it can only turn 200s into 404s. No `isPublished` predicate
was lost: across all 21 changed route files and all 9 changed lib files the per-file `isPublished`
count is identical at base and HEAD (delta `+0` everywhere).

*Nuance, stated precisely:* the full diff does contain **nine `-` lines that mention
`isPublished`** — so "Phase 12 removed zero `isPublished` lines" is literally false and was
corrected here. What is true is that every one of the nine is a modified-not-deleted line whose
replacement still enforces the predicate: three in source (`media/[id]` select list, `media/[id]`
authorization predicate — both *strengthened* by the added track clause; and
`students/me/session-videos` where `isPublished: true` is retained with the track filter layered
**on top**), and six in test fixtures where `trackScope: "SHARED"` was added. The fixtures'
`isPublished` value distributions are byte-identical before and after (`parent-dashboard-isolation`
1 false / 5 true at both; `session-progression` 4 true at both).

Publishing/lifecycle is explicitly Phase 13+ scope. Left for that phase.

### Finding 3 — PRE-EXISTING, reported not fixed: media reveals asset existence pre-auth

`/api/media/[id]` returns `400 "Not a stored asset"` **before** its authorization block, so any
authenticated user can distinguish an existing `EXTERNAL_URL` asset from a nonexistent id. It
leaks no track information — only that an id exists and is externally stored. Also out of Phase 12
scope (security Phase 20).

**Measured identical at both commits** (see Finding 2's table): existing `EXTERNAL_URL` id →
`400` at base and at HEAD; nonexistent id → `404` at base and at HEAD. The oracle is byte-for-byte
the same. The response sequence in that file is unchanged — `401` unauthenticated → `404` no such
asset → `400` not a stored asset → the role/track authorization block — at both commits; Phase 12
did not move the `400` and added nothing before it. Phase 12's only change to that file is inside
the `STUDENT` branch, *downstream* of the `400`, where it **tightens** the predicate from
`v.isPublished && v.batchId === student.batchId` to also require
`v.batch.schoolType === studentSchoolType`. The `PARENT` branch is byte-identical at both commits.

### No additional exposure from either issue

Beyond the two files above, the whole PR was audited for anything that could widen either surface:

- **No new or deleted API routes.** `git diff --name-status --diff-filter=ADR 66f56f5 2206661`
  lists exactly five additions — two docs, the migration, `src/lib/track-scope.ts` and the new test
  file. There is no new endpoint that could reach unpublished content or probe an asset id.
- **No lost publication check anywhere.** Per-file `isPublished` counts are identical at base and
  HEAD for all 21 changed route files and all 9 changed lib files (delta `+0` in every row).
- **The migration cannot affect either surface.** It touches only `Student`, `Lesson`, `Quiz` and
  `Homework` (the `isPublished` mentions in it are column names carried verbatim through the SQLite
  table rebuilds). It does not touch `MediaAsset` or `SessionVideo`.
- **Track gating cannot substitute for a publication check.** Every guard Phase 12 adds is an
  *additional* conjunct on an existing query, never a replacement, and each is keyed on the
  authenticated user's server-side state.

### Everything else in the review came back clean

| Section | Result |
| --- | --- |
| §2 Phase 11 real-DB baseline | 12/12 |
| §3 `Track`/`Enrollment` removal | 0 live references in `src/` |
| §4 NULL `schoolType` semantics | 12/12 |
| §6 progression fixture | 17/17 |
| §7 quiz selection + grading matrix | 38/38 |
| §8 frozen attempt | 8/8 |
| §9 media isolation | 7/7 |
| §10/§14 list endpoints | verified by body, not status |
| §11 parent flows | 15/16 (the 16th is Finding 2) |
| §12 batch healing | 15/15 |
| §13 analytics | 12/12 |
| §17 migrations | status up to date, `deploy` no-op, `diff` no drift |
| §18 data integrity | 15/15 |
| §19 write-path wiring | 9/9 after Finding 1's fix |

§13 initially read 11/12. The single failure was **the reviewer's fixture, not the code**: both
attempts were given the same `finishedAt`, so "latest" was a genuine tie and whichever row came
last in the array won. `latestPercentage` is pre-existing (present at base, lines 93/118/126/138)
and is timestamp-driven — with distinct timestamps the reversed input produced identical JSON, and
two attempts at different times yielded the same `latestPercentage` in both orders. 12/12.

## 28. Real-database verification, known limitations, and the merge decision

### Live HTTP verification (11/11)

Finally the matrix was exercised **end to end over real HTTP**: a production build was started
(`next start`, port 3000) against the real database, three published lessons (`SHARED`/`ARABIC`/
`LANGUAGE`) and one ARABIC + one LANGUAGE student were created with real `scrypt` password hashes,
and each logged in through `POST /api/auth/login` to obtain a real session cookie.

| request | ARABIC | LANGUAGE |
|---|---|---|
| `GET /api/lessons/LIVE-shared` | 200 | 200 |
| `GET /api/lessons/LIVE-ar` | 200 | **404** |
| `GET /api/lessons/LIVE-lang` | **404** | 200 |

Plus: the cross-track 404 is the **same status as a nonexistent lesson id** over the wire, and
`GET /api/courses/programming-ai-2nd-sec` **omits** the other track's lesson from each student's
served curriculum while including their own. All fixtures removed afterwards (`leftover=0`).

### Real-database verification

Because §26 runs against a mock, the whole matrix was also executed **end-to-end against a real SQLite database** through the real Prisma client and the **unmodified** repository source: **37 assertions, 0 failures**. It confirmed:

- reconciler run twice — both `2 parts / 7 units / 23 lessons`, **zero writes on the second run**, `archivedLessonIds: []`;
- curriculum intact — 23 official lessons, **0 duplicate `officialCode`**, **0** official lessons unlinked from a Unit, all `curriculumStatus: OFFICIAL`;
- `Lesson`/`Quiz`/`Homework.trackScope` present as **`NOT NULL` with default `'SHARED'`**; `Student.schoolType` nullable;
- **0** students holding an out-of-enum `schoolType`; re-running the backfill normalisation changes **0 rows** (idempotent);
- the full cross-track matrix through the real `canAccessLesson` / `canAccessQuiz` / `getCourseSessionProgress`, including a `NULL`-school-type student confined to SHARED;
- referencing rows (`lessonProgress`, `quizAttempt`, students) survived the migration; all fixtures cleaned up.

### Migration verified against REAL data (the earlier claim was vacuous)

The local development database held **0** `Quiz`, **0** `Homework` and **0** `Student` rows, so a
"no rows lost" claim checked against it proved nothing — there was nothing to lose. The migration
was therefore re-verified on a purpose-built scratch database:

1. the **pre-Phase-12** schema (`git show HEAD:prisma/schema.prisma`) was pushed to a fresh file,
   the four earlier migrations marked applied, leaving **only** the Phase 12 migration to run;
2. real rows were inserted — a course/part/unit, **3 lessons**, **1 quiz**, **1 homework**,
   1 question, 1 `QuizAnswer`, 1 `QuizAttempt`, 1 `LessonProgress`, 1 `HomeworkSubmission`, and
   **11 students covering every normalisation case** (`ARABIC`, `arabic`, `AR`, `عربي`,
   `LANGUAGE`, `LANGUAGES`, `LANG`, `لغات`, `FRENCH`, `NULL`, `"  language  "`);
3. `npx prisma migrate deploy` then applied the Phase 12 migration cleanly.

**30 checks, 0 failures:**

- **row preservation through all three table rebuilds** — 13/13 table counts unchanged, including
  `Lesson`, `Quiz` and `Homework` themselves;
- **backfill** — every pre-existing row carries `trackScope = 'SHARED'`; the column is `NOT NULL`
  with default literal `'SHARED'`; a row inserted afterwards with no `trackScope` still gets `SHARED`;
- **normalisation** — `ARABIC`/`arabic`/`AR`/`عربي` → `ARABIC`; `LANGUAGE`/`LANGUAGES`/`LANG`/`لغات`
  → `LANGUAGE`; `"  language  "` → `LANGUAGE` (trimmed); **`FRENCH` → `NULL`, never guessed**;
  `NULL` stays `NULL`; **0 out-of-enum values remain**;
- **referential integrity through the rebuild** — `LessonProgress`, `QuizAttempt`, `QuizAnswer` and
  `HomeworkSubmission` all still resolve to live parent rows, the attempt payload is byte-identical,
  official codes intact, `PRAGMA foreign_key_check` returns an empty set.

The scratch database was deleted afterwards and `.env` / `prisma/schema.prisma` were restored; the
main database was re-verified at 37/0 after the round trip.

### Production build

`npm run build` (`prisma generate && next build && node scripts/copy-standalone-assets.mjs`) →
**exit 0**. `next.config.ts` loaded, `✓ Compiled successfully`, the in-build TypeScript pass ran to
completion, `✓ Generating static pages (62/62)`, and the standalone bundle was produced
(`server.js`, `public`, `.next/static`). **0 warnings.** It was blocked by the missing
`SECURITY_HASH_SECRET` fail-fast (Phase 3 behaviour, working as designed) and by the unreachable
Prisma engine CDN; supplying a secret and a local engine mirror unblocked it. This is the first
successful production build since Phase 5.

One honest caveat: a `PrismaClientInitializationError` (`libquery_engine-…so.node: file too short`)
is *printed* during the "Collecting page data" step because this sandbox's query-engine binary is a
placeholder served by the mirror. **Environmental, not a code defect** — the build still exits 0
with the standalone output intact.

### Known limitations

1. **SQLite enums have no CHECK constraint** — `Student.schoolType` and `trackScope` are plain `TEXT`; the Prisma client is the only gate for values written by raw SQL. The reconciler fails closed (`NO_SCHOOL_TYPE`) rather than guessing.
2. The "0 invalid values" invariant cannot be asserted inside the migration (`RAISE(ABORT,…)` is trigger-only in SQLite); it is asserted in tests instead.
3. `Track` and `Enrollment` remain in the schema as dead models; deleting them is a separate destructive decision, deliberately deferred.
4. Local sandbox note: `binaries.prisma.sh` is unreachable, so `prisma generate`/`next build` need a local engine mirror and a WASM client patch. That harness lives in `.verify/` + an untracked `prisma.config.ts` and was **not committed**; no repository file was modified by it. `bun` is unavailable in this sandbox, so `bun run …` was executed as `npm run …` / `npx prisma …`.

### Merge decision

**STOP — PR #29 is OPEN and NOT MERGED** (`state: "OPEN"`, `mergedAt: null`), awaiting separate pre-merge review, exactly as instructed. Nothing was merged, no branch other than `arena/01a085a4-codemind-academy` was touched.
