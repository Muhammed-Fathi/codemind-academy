# Phase 12 — Track Architecture & Cross-Track Enforcement

**Status:** implementation complete, verified, **PR open — NOT merged** (awaiting pre-merge review).
**Date:** 2026-09-09. **Base:** `66f56f5` (branch `arena/01a085a4-codemind-academy`).
**Prerequisite:** the Phase 11 reconciler defect is fixed first, in this same change (§1).

---

## Objective

Make these two statements **structurally true on the server**, not merely true in the UI:

- an **ARABIC** student may reach `SHARED` + `ARABIC` content, and nothing else;
- a **LANGUAGE** student may reach `SHARED` + `LANGUAGE` content, and nothing else;

…over **one shared course** (`programming-ai-2nd-sec`), without a second course, a second
progression engine, or a second enrollment gate.

Every decision is made server-side from a database lookup. No route accepts a track, a school
type, a locale or a URL/body parameter as an authorization input.

---

## 1. Prerequisite: the Phase 11 reconciler defect

**Symptom (reproduced):** `PrismaClientValidationError: Unknown argument 'createdAt'` at
`src/lib/official-curriculum.ts:313`.

**Cause:** `reconcileOfficialCurriculum` ordered `Part` and `Unit` with
`orderBy: [{ order: "asc" }, { createdAt: "asc" }]`. Neither model has a `createdAt` column —
verified against `prisma/schema.prisma`:

| model | columns |
|---|---|
| `Part` | `id, courseId, title, titleAr, order, description` |
| `Unit` | `id, partId, title, titleAr, order, icon` |

**Why 51 green assertions missed it:** the Phase 11 suite's mock Prisma client ignored
`orderBy` entirely and even synthesised `createdAt` values in its own `sortByOrder` helper.
The reconciler therefore only failed against a real database.

**Fix (as instructed):** no `createdAt` was added to `Part`/`Unit`, no migration was created to
satisfy the query. A shared, deterministic tie-breaker replaced it:

```ts
// src/lib/official-curriculum.ts
export const PART_UNIT_ORDER_BY = [{ order: "asc" }, { id: "asc" }] as const;
```

applied to both `part.findMany` and `unit.findMany`. `order ASC, id ASC` is a total order
(`id` is the primary key), so positional adoption stays deterministic and idempotent.

**Regression gate added:** `tests/curriculum-reconciliation-phase11.test.js` now parses the
field list of `Part` and `Unit` straight out of `prisma/schema.prisma` and rejects any
`orderBy` key that is not one of them, mirroring `PrismaClientValidationError`. Verified by
mutation: re-introducing `{ createdAt: "asc" }` crashes that suite with
`Unknown argument \`createdAt\` on part.orderBy`; restoring the fix returns it to 51/0.

---

## 2. Design decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **One shared `Course`.** Track is a property of *content*, not of the course. | Requirement. Avoids duplicating 23 official lessons per track. |
| D2 | New `enum TrackScope { SHARED ARABIC LANGUAGE }` with `trackScope TrackScope @default(SHARED)` on `Lesson`, `Quiz`, `Homework`. | `SHARED` default means every pre-existing row is immediately valid with no data rewrite. |
| D3 | `Student.schoolType` constrained `String?` → `SchoolType?`, **still nullable**. | "Unspecified" is a real state (admin UNSPECIFIED tab; students born outside registration). `NULL` fails closed to `SHARED`-only. |
| D4 | Session videos carry **no new column**. Track comes from the non-nullable `Batch.schoolType` (`@@unique([schoolType, courseId])`). | A video is already batch-scoped. A "shared" video is two published rows on one `MediaAsset`. |
| D5 | Question track stays `Question.schoolType SchoolType?`; **`NULL` means SHARED**. | Already existed (Phase 8). No new column, no rewrite. |
| D6 | Prisma `Track` / `Enrollment` models are formally documented as **DEPRECATED / DEAD SCHEMA** (zero references anywhere in `src/`). `Group → Course` via `getEnrollment` stays the *sole* access gate. | Requirement: no second enrollment gate. Documented in-schema so nobody re-animates them. |
| D7 | `schoolType = NULL` or unrecognised → **SHARED-only**, never a guess. | Fail closed. Unrecognised values are refused at write time and reported, never silently mapped (user constraint). |
| D8 | No new indexes. | The added columns are filters on already-indexed queries; SQLite rebuilds preserve existing indexes. |

---

## 3. The one place the rule lives — `src/lib/track-scope.ts` (new)

Single source of truth; every route and engine imports it. Nothing else may encode the matrix.

| export | contract |
|---|---|
| `TrackScope`, `TRACK_SCOPES`, `TRACK_SCOPE_LABELS` | the three values + AR/EN labels |
| `normalizeTrackScope(value)` | `"SHARED"/"ARABIC"/"LANGUAGE"` (case-insensitive) → the value; **anything else → `null`, never `SHARED`** |
| `eligibleTrackScopes(schoolType)` | `["SHARED", schoolType]`; unrecognised/`null` → `["SHARED"]` |
| `canAccessTrackScope(schoolType, scope)` | the matrix. Unknown on **either** side → `false` except `scope === "SHARED"` |
| `trackScopeWhere(schoolType)` | `{ trackScope: { in: [...] } }` — the Prisma predicate |
| `trackScopeInWhere(scopes)` | same, for a pre-resolved set (parents) |
| `videoTrackFilter(schoolType)` | `{ batch: { schoolType } }`; unrecognised → an empty `in: []` (no videos, not both tracks) |
| `eligibleQuestionFilter(schoolType)` | `{ OR: [{ schoolType }, { schoolType: null }] }` |
| `isQuestionEligible(schoolType, questionSchoolType)` | per-question predicate, same rule |
| `resolveQuestionSchoolType(explicit, quizTrackScope)` | teacher tagging precedence (§7) |
| `parseQuestionSchoolTypeInput(raw)` | `{ ok, specified, value }` — distinguishes *absent* from *explicit SHARED* |

**The matrix (asserted in tests, §10):**

| student | SHARED | ARABIC | LANGUAGE |
|---|---|---|---|
| ARABIC | ✅ | ✅ | ❌ |
| LANGUAGE | ✅ | ❌ | ✅ |
| `NULL` / unrecognised | ✅ | ❌ | ❌ |

---

## 4. Enforcement — lessons and the progression universe

`src/lib/session-progress.ts` (the **one** Phase 4 progression engine; unchanged semantics):

1. **Universe filter** — `getCourseSessionProgress` adds `...trackScopeWhere(resolvedSchoolType)`
   to the lesson `findMany`. An ineligible lesson never enters the universe, so it is absent
   from `sessions`, from `byLessonId`, and can never be an unlock target or the continuation
   pointer.
2. **Explicit gate** — `canAccessLesson` re-checks `canAccessTrackScope(schoolType, lesson.trackScope)`
   *after* the enrollment check, so the rule stays correct even if a future reader widens the query.
3. **Non-oracle verdict** — a cross-track lesson returns exactly what a nonexistent id returns:
   `{ allowed: false, reason: "LESSON_NOT_FOUND", status: null }`. Probing ids from the other
   track cannot reveal that a lesson exists.
4. `getUnlockedLessonIds` inherits (1) for free.

`canAccessQuiz` / `canAccessHomework` resolve to the owning lesson and re-use `canAccessLesson`,
with an additional `gateTrackedResource` check on the resource's own `trackScope` — so a
LANGUAGE quiz attached to a SHARED lesson is still refused to an ARABIC student.

---

## 5. Enforcement — quiz selection, serving and grading

`src/lib/session-quiz.ts` gained a fourth `schoolType` parameter on the three entry points:

| function | effect |
|---|---|
| `seedAttemptQuestions(attemptId, quizId, schoolType)` | only eligible questions are frozen into the attempt |
| `loadAttemptQuestionSet(attemptId, schoolType)` | re-filters an **already frozen** set, so an attempt created before Phase 12 that holds a foreign-track question is still narrowed at serve time |
| `loadQuizQuestionSet(quizId, schoolType)` | the live/retake path applies the same predicate |
| `gradeAttemptQuestionSet(set, answers, passMark, schoolType)` | an ineligible question contributes to **neither `score` nor `totalMarks`** |

Selection and grading use the **same** predicate, so `totalMarks` cannot drift between what was
served and what was scored, and a crafted answer row for a foreign-track question can never
earn credit.

---

## 6. Enforcement — videos, homework, routes

| surface | change |
|---|---|
| `/api/students/me/session-videos` | `...videoTrackFilter(enrollment.schoolType)` alongside the existing `isPublished` + `batchId` checks |
| `/api/media/[id]` | requires `v.batch.schoolType === studentSchoolType` **and** `v.isPublished` **and** `v.batchId === student.batchId` |
| `/api/students/me/homework` | `...trackScopeWhere(schoolType)` |
| `/api/courses/[slug]` | computes `viewerTrackFilter` (student's own school type, or `getParentTrackScopes` for a parent) and applies it to **both** curriculum chains |
| `/api/lessons/[id]` | `viewerTrackFilter` on quizzes, homework and prev/next; parent preview gated by `isParentAllowedTrackScope` |
| `/api/quizzes/[id]`, `/start`, `/submit` | `isQuestionEligible` on the served list; `getStudentSchoolType` server-side; parent preview gated |

### 6b. Completeness audit of every route that reads track-scoped content

All 80 route files were audited for reads of `Lesson` / `Quiz` / `Homework` / `SessionVideo` /
`MediaAsset` / `Question`. Beyond the routes above, five further surfaces were found to need
slicing — they are **denominators and embedded lists**, which is exactly why an audit was needed
rather than a list of the obvious endpoints:

| surface | why it needed fixing |
|---|---|
| `/api/students/me/dashboard` | the course-progress denominator counted the other track's lessons, and the **embedded homework list returned other-track rows and titles** — an outright content leak |
| `/api/students/me/certificate` | the 80% threshold divided by lessons the student can never open, making the certificate unreachable in a mixed course |
| `/api/parents/me/dashboard` | per-child universe and homework list — sliced to **that child's** track, not the parent's union |
| `/api/parents/me/analytics` | universe sliced to the union of the linked children's tracks |
| `/api/parents/me/weekly-report` | same union rule |

Already safe by construction, verified rather than assumed:
- `/api/lessons/[id]/progress` → calls `canAccessLesson`, which carries the track gate;
- `/api/students/me/session-videos/[id]/progress` → enforces `video.batchId === student.batchId`, and `Batch.schoolType` is non-nullable, so track follows automatically;
- `/api/students/me/dashboard`'s unlocked-lesson set → comes from `getUnlockedLessonIds`, which inherits the filtered universe;
- quiz-attempt lists (student, parent, teacher) → restricted to the student's own attempts, which can only exist for quizzes they were allowed to open;
- `/api/quizzes/[id]/evidence` → calls `canAccessQuiz` before any file write, then checks attempt ownership;
- `/api/exams/mock` → Phase 8 already derives `studentSchoolType` from the database and refuses a `MockExam` whose `schoolType` differs (404); the question pool is restricted by `questionBankFilter(studentSchoolType)`.

  Its `lessons` query is deliberately **not** track-filtered: it only scopes which *lessons* may
  contribute questions, and the operative gate is the question's **own** `schoolType`. A question
  sitting on an ARABIC-only lesson but tagged `NULL` is shared content by D5, so serving it is
  correct — the lesson's `trackScope` governs *lesson access*, not question eligibility.

`teacher/*` and `admin/*` surfaces are deliberately **not** sliced: staff legitimately serve both
school types.

---

## 7. Teacher question tagging

`POST /api/teacher/quizzes` sets `Quiz.trackScope` explicitly and resolves each question's
`schoolType` via `resolveQuestionSchoolType`, with this precedence:

1. an **explicit** payload value wins — including an explicit `SHARED`, which is stored as
   `NULL` (D5);
2. otherwise **inherit the owning quiz's `trackScope`** when it is `ARABIC`/`LANGUAGE`;
3. otherwise `NULL` (shared).

Inherited from the *quiz*, not the lesson, because a SHARED lesson may legitimately host both an
ARABIC and a LANGUAGE quiz. An unrecognised value is **rejected** (`parseQuestionSchoolTypeInput`
→ `ok: false`, HTTP 400 with `api.228`/`api.229`), never downgraded to SHARED.
`POST /api/admin/question-bank` and `/api/admin/ai-generate-quiz` follow the same rule.

---

## 8. Batch reconciliation (`reconcileStudentBatch`)

`src/lib/enrollment.ts`. `Batch.schoolType` is **required** and `@@unique([schoolType, courseId])`,
so a student's batch is the join between their track and their course. Before Phase 12 a
`schoolType` or `groupId` change left a stale `batchId` behind.

Contract:

- **deterministic + idempotent** — a re-run over unchanged state returns `changed: false` and writes nothing;
- **never assigns without a recognised school type** (`reason: "NO_SCHOOL_TYPE"`, no write, no invention);
- preference order: an **ACTIVE course-specific** batch → an **ACTIVE course-less** batch → never another course's batch;
- **clears** a wrong-track/wrong-course batch when no correct one exists (`reason: "CLEARED"`) rather than keeping it;
- reasons: `OK | ASSIGNED | REPLACED | CLEARED | NO_SCHOOL_TYPE | NO_BATCH | NO_ENROLLMENT`.

`syncStudentBatch` is kept as an alias. `attachUnassignedStudentsToBatch(batchId)` is assign-only
and used when a batch is created.

Wired into **all** write paths: `auth/[action]` (register), `admin/students` (create),
`admin/students/[id]` (PATCH — on `schoolTypeChanged || groupChanged`), `api/enroll`,
`admin/batches` (create).

Registration and admin create/update additionally validate with `requireSchoolType`, which
accepts the documented legacy aliases (`AR`, `عربي`, `LANGUAGES`, `LANG`, `لغات`, case/whitespace
variants) and **rejects** anything else.

---

## 9. Parents and analytics

**Parents** (`src/lib/parent-access.ts`): `getParentTrackScopes(parentUserId)` returns the union
of the school types of the parent's **LINKED and ENROLLED** children, always including `SHARED` —
the same population `getParentCourseIds` already uses. `isParentAllowedTrackScope` refuses a bare
404. A parent of an unspecified child gets `SHARED` only.

**Analytics** (`src/lib/quiz-analytics.ts`, additive): `TRACK_BUCKETS`, `trackBucketOf`,
`partitionByTrack`, `summarizeFinishedAttemptsByTrack`. Two deliberate asymmetries from
authorization, recorded in the file:

- bucketing reports an unknown tag as `SHARED` **rather than dropping the row** (a report must
  account for every attempt; authorization must not);
- every bucket re-uses `summarizeFinishedAttempts`, so a split can never disagree with its total.

Buckets are deliberately **not** summed back together, because an attempt set may span scopes.

---

## 10. Migration

`prisma/migrations/20260909120000_phase12_track_architecture/migration.sql` — **additive only**.

1. **Normalise first, then constrain.** Three `UPDATE "Student"` statements map the ARABIC
   aliases (`ARABIC`, `AR`, `عربي`), the LANGUAGE aliases (`LANGUAGE`, `LANGUAGES`, `LANG`, `لغات`),
   and set anything else to `NULL` — *never* a guess. Running this before the DDL means the enum
   change cannot strand a value.
2. **`trackScope` columns** on `Lesson`, `Quiz`, `Homework`: `TEXT NOT NULL DEFAULT 'SHARED'`.
3. SQLite has no `ALTER COLUMN`, so Prisma emits table rebuilds. All three
   `INSERT INTO "new_…"` copy statements are present; existing indexes are recreated; no row is
   deleted and no historical migration was touched.

`SQLite RAISE(ABORT, …)` is only legal inside a trigger program, so the "0 invalid values"
invariant is asserted in tests, not in SQL.

**Critical finding:** a SQLite enum maps to plain `TEXT` with **no CHECK constraint** — the
`String? → SchoolType?` change produces **zero DDL**. The constraint lives in the Prisma client,
which throws when it *reads* an out-of-enum value. Normalisation is therefore the real safety
step, and a direct-SQL write of a bad value remains a **documented limitation** (§13).

Applied: `npx prisma migrate status` → **"5 migrations found / Database schema is up to date!"**

### 10b. Migration verified against real data

The local development database held **0** `Quiz`, `Homework` and `Student` rows, so a "no rows
lost" claim checked against it would have been **vacuous** — there was nothing to lose. The
migration was therefore re-verified on a purpose-built scratch database:

1. the **pre-Phase-12** schema (`git show HEAD:prisma/schema.prisma`) was pushed to a fresh file,
   the four earlier migrations were marked applied, and `prisma migrate deploy` was left with
   **only** the Phase 12 migration to run;
2. real rows were inserted: a course/part/unit, **3 lessons**, **1 quiz**, **1 homework**,
   1 question, 1 `QuizAnswer`, 1 `QuizAttempt`, 1 `LessonProgress`, 1 `HomeworkSubmission`, and
   **11 students covering every normalisation case** (`ARABIC`, `arabic`, `AR`, `عربي`,
   `LANGUAGE`, `LANGUAGES`, `LANG`, `لغات`, `FRENCH`, `NULL`, `"  language  "`);
3. `prisma migrate deploy` then applied the Phase 12 migration cleanly.

Result — **all 30 checks passed, 0 failed**:

- **row preservation through all three table rebuilds:** 13/13 table counts unchanged, including
  `Lesson`, `Quiz` and `Homework` themselves;
- **backfill:** every pre-existing `Lesson`/`Quiz`/`Homework` row carries `trackScope = 'SHARED'`,
  the column is `NOT NULL` with default literal `'SHARED'`, and a row inserted afterwards with no
  `trackScope` still gets `SHARED`;
- **normalisation:** `ARABIC`/`arabic`/`AR`/`عربي` → `ARABIC`; `LANGUAGE`/`LANGUAGES`/`LANG`/`لغات`
  → `LANGUAGE`; `"  language  "` → `LANGUAGE` (trimmed); **`FRENCH` → `NULL`, never guessed**;
  `NULL` stays `NULL`; **0 out-of-enum values remain**;
- **referential integrity through the rebuild:** `LessonProgress`, `QuizAttempt`, `QuizAnswer` and
  `HomeworkSubmission` all still resolve to live parent rows, the attempt's
  `score/totalMarks/percentage/passed` payload is byte-identical, official codes intact, and
  `PRAGMA foreign_key_check` returns an empty set.

---

## 11. Tests

`tests/track-architecture-phase12.test.js` (new) — **291 assertions, 0 failures**. Four layers:

- **A. Pure contract** — `track-scope` + `school-type` compiled with `tsc` and exercised directly: the full matrix, fail-closed on both sides, question-tagging precedence, Prisma predicates.
- **B. Behavioural** — the *real* `session-progress`, `session-quiz`, `enrollment`, `parent-access`, `quiz-analytics` compiled and run against a fake `@/lib/db` modelling the Phase 12 schema. Covers the 9-cell lesson matrix, progression-universe exclusion, unlock targets, quiz selection/serving/grading, live-quiz sets, all batch-reconciliation cases incl. idempotency, video semantics, parent scopes, analytics buckets.
- **C. Source invariants** — every track-sensitive route is read and asserted (`viewerTrackFilter` on both chains, `seedAttemptQuestions(…, schoolType)`, `gradeAttemptQuestionSet(…, schoolType)`, `reconcileStudentBatch` on each write path, …), plus a **security-boundary** section asserting no route derives `trackScope`/`schoolType` from `body`/`params`/`searchParams` and that `track-scope.ts` never reads a locale or `headers()`.
- **D. Schema + migration** — the enum, the three columns and their defaults, `Student.schoolType` no longer a `String`, the dead-schema docblocks, and that normalisation precedes the DDL with no data deletion.

**Mutation-verified** (the suite is a detector, not decoration): neutering
`canAccessTrackScope` → **25 failures**; removing the universe filter → **6 failures**; restored → 0.

**Existing suites were repaired, never weakened.** Five suites' fixtures predate the new NOT NULL
columns and were updated to carry the schema's real default (`trackScope: "SHARED"`); their
mock clients were extended to resolve the new `@/lib/*` imports and to honour `where.trackScope.in`.
Three source-invariant regexes in `session-progression` were **tightened** to pin the new
`trackScope` select and filter. Baseline counts were captured before and after:

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
| **track-architecture-phase12 (new)** | — | **291 / 0** |
| **total** | **1810** | **2092 / 0 failures** |

`npm run typecheck` (`tsc --noEmit`) → **0 errors**.

### Real-database verification

Because the matrix above runs against a mock, it was also executed end-to-end against a real
SQLite database through the real Prisma client and the **unmodified** repository source
(`.verify/e2e-track.cjs`, local harness, not committed): **37 assertions, 0 failures** —
reconciler run twice (zero writes on the second), curriculum intact at 2 parts / 7 units /
23 official lessons with no duplicate `officialCode` and no unlinked official lesson, the three
`trackScope` columns present as `NOT NULL DEFAULT 'SHARED'`, `0` students holding an
out-of-enum `schoolType`, the backfill normalisation re-run changing `0` rows, and the full
cross-track matrix through the real `canAccessLesson` / `canAccessQuiz` /
`getCourseSessionProgress`.

---

## 12. What was deliberately NOT done

Out of scope for Phase 12 and untouched: PDF/material upload, publishing/lifecycle,
notifications, admin publishing UI, PostgreSQL migration, Kodgy AI, security Phase 20, UI redesigns.

Also not done, by design: no second course, no second progression engine, no second enrollment
gate, no new indexes, no rewrite of `Question.schoolType` semantics.

---

## 13. Known limitations

1. **SQLite enums have no CHECK constraint.** `Student.schoolType` is plain `TEXT` in the
   database; the Prisma client enforces the enum and throws when it reads a bad value. A write
   made by raw SQL (or a future direct-SQL migration) can still store an out-of-enum value. The
   reconciler fails closed on such a value (`NO_SCHOOL_TYPE`, no batch assigned) rather than
   guessing, and the value must be fixed in data.
2. **`trackScope` cannot be validated by the database either** — same reason. Application code is
   the only gate.
3. **No CHECK/trigger assertion in the migration** (SQLite restriction, §10); covered by tests.
4. `Track` and `Enrollment` remain in the schema as dead models. Removing them is a separate,
   destructive decision and was deliberately deferred.

---

## 14. Merge status

**The Phase 12 PR is open and has NOT been merged.** Per instruction, the work stops here for
pre-merge review.
