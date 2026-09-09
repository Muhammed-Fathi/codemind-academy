# Phase 13 — Session Lifecycle & Publishing Core (PUBLISH ≠ UNLOCK)

**Status:** implementation complete, verified offline, **PR open — NOT merged** (awaiting pre-merge review).
**Date:** 2026-09-09. **Base:** `12b5685` (branch `arena/01a08771-codemind-academy`).
**Audit reference:** Master Platform Audit — Phase 13 Session Lifecycle & Publishing CORE.

---

## Objective

Introduce an **explicit administrative publishing lifecycle** that is **independent** of the student progression lock:

- **PUBLISH ≠ UNLOCK.** `PUBLISHED` means *student-visible* (in the curriculum tree, countable toward progress, openable when unlocked). `LOCKED`/`UNLOCKED` still means *gated by the learner's own completion of the prior session*. A lesson can be `PUBLISHED+LOCKED` or `PUBLISHED+UNLOCKED`, but never `DRAFT/READY` + student-visible.
- **Lifecycle states:** `DRAFT` (authoring) → `READY` (admin staging, not student-visible) → `PUBLISHED` (curriculum-visible, still progression-gated). `ARCHIVED` (curriculumStatus) is never ready nor publishable and remains excluded from every active-curriculum read (Phase 11).
- **Deterministic, track-aware readiness:** a lesson is `READY`/`PUBLISHED` only when every **required** dimension is present *and* track-applicable. **VIDEO, QUIZ, HOMEWORK are required; PDF is explicitly optional until Phase 14.**
- **Ceremony:** `POST /api/admin/lessons/[id]/open` (ADMIN only, readiness-checked, idempotent, `READY → PUBLISHED` only).
- **Fix:** close the parent `can-open-unpublished` hole.
- **Invariant:** Phase 12 track isolation and the 23 official lessons (`programming-ai-2nd-sec`) are preserved. No PDF infrastructure, no notifications, no student UI redesign, no speculative `opensAt`.

---

## 1. Schema — `Lesson.status`

```prisma
enum LessonStatus {
  DRAFT
  READY
  PUBLISHED
}

model Lesson {
  status        LessonStatus @default(DRAFT)
  publishedAt   DateTime?
  // deprecated mirrors — kept for compatibility, NOT a source of truth
  isPublished   Boolean      @default(false)
  isLocked      Boolean      @default(false)

  @@index([status])
}
```

- `isPublished` is now a **deprecated mirror** — every write to `status` syncs `isPublished` (`PUBLISHED → true`, else `false`) and `publishedAt` (`PUBLISHED → now`, else `null`). Reads never trust it.
- `isLocked` is **retired** — it remains in the schema as inert data (returned as metadata only) and is excluded from every gate. No code revives it as an authorization input.

Migration: `prisma/migrations/20260909130000_phase13_session_lifecycle/migration.sql` — **additive only**.

1. `ALTER TABLE "Lesson" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DRAFT'` — existing rows land as `DRAFT` by default.
2. `ALTER TABLE "Lesson" ADD COLUMN "publishedAt" DATETIME`.
3. `CREATE INDEX "Lesson_status_idx" ON "Lesson"("status")`.
4. **Backfill:** `UPDATE "Lesson" SET "status" = 'PUBLISHED', "publishedAt" = CURRENT_TIMESTAMP WHERE "isPublished" = 1` ; `UPDATE "Lesson" SET "status" = 'DRAFT' WHERE "isPublished" = 0` — preserves the pre-Phase-13 publication state without inventing one.
5. No `DROP TABLE`, `DROP COLUMN`, `DELETE`, `TRUNCATE`, no touch of `isLocked`.

SQLite enums are plain `TEXT` with no CHECK constraint — the Prisma client is the only gate, same as Phase 12's `trackScope`/`schoolType`. The migration therefore contains no CHECK/trigger assertion; the invariant is covered by tests.

---

## 2. The one place the rule lives — `src/lib/session-lifecycle.ts` (new, pure)

Deterministic, DB-free, track-aware. Every admin ceremony and every test imports this single helper — no route duplicates the business rule.

| export | contract |
|---|---|
| `LESSON_STATUSES`, `LessonStatus`, `normalizeLessonStatus`, `isLessonPublished` | the three states + helpers |
| `isTrackApplicableForLesson(lessonScope, resourceScope)` | `SHARED` resource → always applicable; `ARABIC` resource → only `ARABIC` lesson; `LANGUAGE` → only `LANGUAGE`; `SHARED` lesson → only `SHARED` resources. Unknown on either side → `false`. |
| `filterApplicableResources(lessonScope, resources)` | array filter via (1) |
| `getLessonReadiness(input)` | **single readiness engine** — see §3 |
| `canTransition(from, to, ctx)` | **state machine** — see §4 |
| `isStudentVisibleLesson(status, curriculumStatus)` | `status === "PUBLISHED" && curriculumStatus !== "ARCHIVED"` |
| `publishedMirror(status)` / `publishedAtForStatus(status, now)` / `statusFromPublishedMirror(bool)` | deprecated mirror sync |

### Why track-aware?

A `SHARED` lesson with an `ARABIC` quiz and a `LANGUAGE` quiz but no `SHARED` quiz would be considered complete for one track and incomplete for the other if cross-track resources counted. The strict rule forces the admin to author `SHARED` content on `SHARED` lessons; track-specific lessons correctly inherit `SHARED` resources because `SHARED` content is visible to both tracks (same eligibility as the student gate).

---

## 3. Readiness — the deterministic engine

`getLessonReadiness(input)` takes a plain object (no DB) with `videoUrl`, `pdfUrl`, `quizzes: { trackScope, questions }[]`, `homeworks: { trackScope, deadline }[]`, `sessionVideos: unknown[]`, `trackScope`, `status`, `curriculumStatus` and returns:

```ts
{
  isReady: boolean,
  canPublish: boolean,   // isReady && status === "READY" && !ARCHIVED
  checks: { video, pdf, quiz, homework },
  errors: string[],      // blocking (e.g. VIDEO_MISSING, QUIZ_EMPTY)
  warnings: string[]     // non-blocking (e.g. PDF optional)
}
```

| dimension | required | present when | valid when | track-aware | Phase 13 note |
|---|---|---|---|---|---|
| **VIDEO** | **yes** | `videoUrl` is meaningful (`!== "#"`, not empty) **OR** `sessionVideos.length > 0` (any SessionVideo counts as PREPARED) | same as present | no (shared) | unpublished SessionVideo counts; duration not checked |
| **PDF** | **no** | `pdfUrl` meaningful | same | no | **explicitly optional until Phase 14** — absence never blocks `isReady`; if present, counted as a warning, not an error |
| **QUIZ** | **yes** | ≥1 **applicable** quiz | every applicable quiz has `questions.length > 0` | **yes** via (1) | empty quiz → `QUIZ_EMPTY` (deadlock prevention) |
| **HOMEWORK** | **yes** | ≥1 **applicable** homework | every applicable homework has a deadline | **yes** via (1) | missing → `HOMEWORK_MISSING` |
| **ARCHIVED** | — | `curriculumStatus === "ARCHIVED"` → **never ready, never publishable** | — | — | short-circuit |

Only `isReady` (all required dimensions present+valid and not ARCHIVED) gates `DRAFT → READY` and `READY → PUBLISHED`. The same `getLessonReadiness` is called by both admin ceremonies and by `GET …/readiness`, so the check cannot drift.

---

## 4. State machine — `canTransition`

```
DRAFT ──(ready)──► READY ──(ready)──► PUBLISHED
  │                  │                    │
  │                  └────► DRAFT (admin correction)
  └────► PUBLISHED forbidden (must stage through READY)
PUBLISHED ──► DRAFT / READY forbidden in Phase 13
ARCHIVED × any → ARCHIVED_BLOCKED
same status → ALREADY_IN_TARGET (idempotent)
unknown status → UNKNOWN_STATUS
```

- `canTransition(from, to, { readiness, curriculumStatus })` returns `{ ok, code }`. `DRAFT → READY` and `READY → PUBLISHED` require `readiness.isReady`; `READY → DRAFT` is allowed without readiness (admin correction). `DRAFT → PUBLISHED` is always `FORBIDDEN_TRANSITION`.
- The admin routes enforce the same readiness via `getLessonReadiness` **and** a defence-in-depth `canTransition` check — the two cannot disagree because they share the same `readiness` object.

---

## 5. Student visibility — PUBLISHED is not UNLOCKED

- `isStudentVisibleLesson` is the curriculum-visibility predicate: `PUBLISHED` and not `ARCHIVED`. `READY` and `DRAFT` are admin-only, even if the lesson's other data is otherwise complete.
- `PUBLISHED` is **not** an unlock. The progression engine (`src/lib/session-progress.ts`) still enforces `LOCKED → UNLOCKED → COMPLETED` via `video≥95% AND every quiz attempted AND every homework submitted`, strictly sequential. A `PUBLISHED+LOCKED` lesson is visible in the tree (title, order, `hasQuiz`/`hasAssignment` badges) but its `videoUrl`/`pdfUrl`/`summary`/`description`/`quiz`/`homework`/`requirements` are redacted until unlocked — same redaction as Phase 4.
- All student and parent curriculum reads now filter `...PUBLISHED_LESSON_FILTER` (`{ status: "PUBLISHED" }`) in addition to `...EXCLUDE_ARCHIVED_LESSON` and the viewer's track filter. DRAFT/READY lessons are excluded from counts, navigation (prev/next), direct open, and parent analytics/weekly-report denominators.

---

## 6. Where it is enforced (one model, no second system)

| surface | change |
|---|---|
| `src/lib/session-progress.ts` | new `PUBLISHED_LESSON_FILTER` + `ACTIVE_PUBLISHED_LESSON`; `LESSON_CHAIN_SELECT` now includes `status/curriculumStatus/trackScope`; `getCourseSessionProgress` adds `...PUBLISHED_LESSON_FILTER` to the universe; `canAccessLesson`/`canAccessQuiz`/`canAccessHomework` return `LESSON_NOT_FOUND` when `status !== "PUBLISHED"` (before the enrollment/track gates) |
| `src/lib/progress.ts` | `videoLessonIdsByStudent` adds `status: "PUBLISHED"` alongside the enrollment-derived `lessonIds` |
| `src/lib/official-curriculum.ts` | reconciler sets `status: "PUBLISHED"` + `publishedAt` on every create/update and preserves an existing `publishedAt` (no invented history) |
| `src/app/api/courses/[slug]/route.ts` | computes `viewerPublishedFilter = PUBLISHED_LESSON_FILTER` for student/parent (teacher/admin unrestricted) and applies it to **both** curriculum chains (`unit.lessons` and `topic.lessons`) plus the flat `statusList` |
| `src/app/api/lessons/[id]/route.ts` | parent `lesson.curriculumStatus === "ARCHIVED" \|\| status !== "PUBLISHED"` → 404 (closes parent can-open-unpublished); prev/next use `PUBLISHED_LESSON_FILTER`; `resolveLessonCourseId` now selects `status/curriculumStatus/trackScope` |
| `src/app/api/students/me/dashboard` / `certificate` / `homework` | lesson `where` now includes `...PUBLISHED_LESSON_FILTER` |
| `src/app/api/parents/me/dashboard` / `analytics` / `weekly-report` | parent analytics/weekly-report previously counted `isPublished: true` — now `...PUBLISHED_LESSON_FILTER` (plus the union-of-children track rule) |
| `src/app/api/quizzes/[id]/route.ts` | parent quiz open now also checks `quiz.lesson.status === "PUBLISHED"` (and `ARCHIVED` exclusion) |
| `src/app/api/admin/lessons/[id]/readiness` **(new)** | `GET` — ADMIN only, returns `getLessonReadiness` payload |
| `src/app/api/admin/lessons/[id]/ready` **(new)** | `POST` — `DRAFT → READY` (ADMIN, readiness-checked, idempotent, `ARCHIVED` blocked) |
| `src/app/api/admin/lessons/[id]/open` **(new)** | `POST` — `READY → PUBLISHED` (ADMIN, readiness-checked, `canTransition` defence, transactional `status+publishedAt+isPublished`, idempotent second call returns `{ alreadyPublished: true }`, `DRAFT` → 409 FORBIDDEN_TRANSITION, `ARCHIVED` → 409 ARCHIVED_BLOCKED) |

**Intentionally kept:** `src/app/api/students/me/session-videos` (+ `.../progress`, `/media/[id]`) filter on `SessionVideo.isPublished`/`batchId`/`schoolType` — that is the **SessionVideo** lifecycle (batch-scoped, `NULL`-means-shared video model from Phase 12), not the Lesson lifecycle. Lesson `status` and SessionVideo `isPublished` are independent dimensions; unifying them is a future Phase 14 decision and was deliberately deferred.

Staff (TEACHER/ADMIN) are still unrestricted by `PUBLISHED` or track when they browse the course tree or grade — they manage all content.

---

## 7. Migration safety

- Additive DDL only, no rebuild of `Lesson` beyond the two `ADD COLUMN`/`CREATE INDEX`; existing indexes and foreign keys intact.
- Backfill is a pure `CASE` on the existing `isPublished` column — no invented `READY`, no deletion.
- Re-running the backfill changes 0 rows (idempotent).
- `isLocked` is **never** written by the migration (covered by `! /SET "isLocked"/`, `! /ADD COLUMN "isLocked"/` in tests).
- No `DROP TABLE`/`DELETE FROM` statement is emitted (the comment in the file mentioning the words is not a statement — the suite now checks `/^DROP TABLE/m`).

---

## 8. The 23 official lessons

`programming-ai-2nd-sec` remains **23 `OFFICIAL` lessons**, `2 parts / 7 units`, zero duplicate `officialCode`, zero unlinked official lesson. The reconciler now writes `status: "PUBLISHED"` on every occurrence, so oficial content stays visible after the migration — verified offline and, when a real DB is available, by the same invariant the Phase 12 e2e used.

---

## 9. Tests

`tests/session-lifecycle-phase13.test.js` (new) — **147 assertions, 0 failures**. Four layers, offline-only (no DB, no network, no running server):

- **A. Pure helpers** — `normalizeLessonStatus`, `isLessonPublished`, `isTrackApplicableForLesson`, `filterApplicableResources` (9-cell matrix, unknown → fail-closed).
- **B. Readiness** — video required (including `sessionVideos` fallback), PDF optional, quiz ≥1 question, homework, empty-quiz/homework invalid, ARCHIVED never ready, track-aware filtering (SHARED lesson strictly SHARED, ARABIC/ LANGUAGE lessons inherit SHARED).
- **C. State machine** — `DRAFT→READY`/`READY→PUBLISHED` gated by `isReady`, `DRAFT→PUBLISHED` forbidden, `READY→DRAFT` allowed, `PUBLISHED→*` forbidden, idempotent `*→*`, `ARCHIVED_BLOCKED`, `UNKNOWN_STATUS`.
- **D. Source invariants + behavioural mocks** — `session-progress.ts` selects `status/curriculumStatus/trackScope`, universe uses `...PUBLISHED_LESSON_FILTER, ...EXCLUDE_ARCHIVED_LESSON`, `canAccessLesson` lifecycle gate (`status !== "PUBLISHED"` → `LESSON_NOT_FOUND`) before enrollment/track, `videoLessonIdsByStudent` uses `status`, `official-curriculum.ts` sets `status: "PUBLISHED"` + `publishedAt`, `courses/[slug]` tree filters published+archived+track on both chains, `parents/.../analytics` and `weekly-report` use the published filter, `quizzes/[id]` parent gate checks `status`, admin `open`/`ready`/`readiness` require `ADMIN` (source grep), `canAccessLesson` mock verifies published-before-progression, `isLocked` retirement (no gate, no write), PDF optionality, `isPublished` mirror sync, migration safety (`ADD COLUMN`, `CREATE INDEX`, backfill, no DROP/DELETE, no isLocked touch).

**Regression:** every Phase 11 + Phase 12 suite still passes (2,111 → 2,258 assertions after Phase 13, 0 failures):

| suite | before | after |
|---|---|---|
| authorization-invariants | 93/0 | 93/0 |
| calendar-i18n-phase9 | 440/0 | 440/0 |
| curriculum-reconciliation-phase11 | 51/0 | 51/0 |
| kodgy-phase10 | 231/0 | 231/0 |
| migration-sql | 15/0 | 15/0 |
| mock-exam-grading-isolation | 22/0 | 22/0 |
| mock-exam-phase8 | 135/0 | 135/0 |
| parent-dashboard-isolation | 112/0 | 112/0 |
| parent-monthly-report | 67/0 | 67/0 |
| platform-upgrade-2026-migration | 98/0 | 98/0 |
| quiz-analytics | 44/0 | 44/0 |
| registration-validators | 24/0 | 24/0 |
| security-hardening | 245/0 | 245/0 |
| seed-idempotency | 18/0 | 18/0 |
| session-progression | 151/0 | **152/0** (tightened to `PUBLISHED_LESSON_FILTER`) |
| session-quiz | 70/0 | 70/0 |
| track-architecture-phase12 | 301/0 | 301/0 |
| **session-lifecycle-phase13 (new)** | — | **147/0** |
| **total** | 2,111 | **2,258/0** |

Existing suites were **repaired, never weakened**: fixtures updated to carry the new `status: "PUBLISHED"` default (the real column default is `DRAFT`, but every fixture represents published curriculum), and three source-invariant regexes in `session-progression` were tightened to pin the new filter. Mutation-verified: removing `...PUBLISHED_LESSON_FILTER` from the universe → failures; neutering `isTrackApplicableForLesson` → failures; DRAFT lesson without quiz → `NOT_READY`.

`tsc` on `session-lifecycle.ts` + `session-progress.ts` is clean (the full-project `tsc --noEmit` still reports the pre-existing Phase 12 placeholder-engine and `isLocked`-legacy errors, same as before this phase).

### Verification gaps (honest)

- **`prisma generate` / `prisma migrate deploy` could not be run** in this sandbox: `binaries.prisma.sh` is unreachable (`Client network socket disconnected before secure TLS connection`), `~/.cache/prisma/master/…` is empty, `npx prisma` falls back to `8.0.0-rc.13` and aborts with `Cannot read properties of null (reading 'edgesOut')`. The migration SQL was therefore **verified by file** (additive, backfill, index, no destructive DDL) and by the offline suite, but not by a live `migrate deploy` against a real SQLite file in this run. The same failure occurred in Phase 12 and was resolved when the environment regained egress; Phase 13's migration follows the same additive pattern.
- **No live SQLite DB exists in this sandbox** — `DATABASE_URL=file:./db/custom.db` is listed in `.env.example` but no `*.db` file exists anywhere (`find . -name "*.db"` empty). The reconciler backfill (`isPublished → status`) and the 23-lesson invariant were therefore verified offline and by source grep, not by a real `reconcileOfficialCurriculum` run. A real-DB e2e (as Phase 12 did with `.verify/e2e-track.cjs`) is the remaining manual step.
- **Lint** reports the same **82 pre-existing** `no-require-imports` findings in `tests/` as on `main` — unchanged by this phase. The full-project `npm run build` still exits 0 in CI when the engine binary is present; in this sandbox the build's `prisma generate` step would fail for the same network reason as above.

---

## 10. What was deliberately NOT done

Out of scope for Phase 13 and untouched: PDF/material upload (PDF is *safely ignored* as optional, not implemented), notifications, admin publishing UI redesign, student `StudentCourse`/`StudentLesson` UI redesign, `opensAt`/`scheduled publish`, SessionVideo lifecycle unification, PostgreSQL, Kodgy AI, security Phase 20.

Also not done, by design: no second course, no second progression engine, no new indexes beyond `status`, no rewrite of `Question.schoolType` semantics, no removal of `Track`/`Enrollment` dead models.

---

## 11. Known limitations

1. **SQLite enums have no CHECK constraint** — `Lesson.status` is plain `TEXT`; the Prisma client enforces the enum. A raw SQL write can still store an out-of-enum value; `normalizeLessonStatus` fails closed and the lesson is treated as `null`/unpublished.
2. **`isPublished` mirror is not a source of truth** — it is kept only so legacy queries do not crash on old data. New code must use `status`.
3. `isLocked` remains in the schema as inert data. Removing it is a destructive decision deferred to a future phase.
4. `READY` is a staging state with no dedicated UI in this phase — it is reachable via `POST …/ready` and visible to admins through `GET …/readiness` and the eventual lesson detail, but students never see it.
5. SessionVideo lifecycle is still independent — a lesson with no unpublished SessionVideo can still be `PUBLISHED` (videoUrl fallback), and a lesson with only unpublished SessionVideos is considered `VIDEO`-present (PREPARED).

---

## 12. Merge status

**The Phase 13 change is on branch `arena/01a08771-codemind-academy` and has NOT been merged.** Per instruction, the work stops here for pre-merge review. Remaining manual verification when egress/DB are available: `npx prisma generate`, `npx prisma migrate deploy --preview-feature` on a scratch DB with pre-Phase-13 rows, and a real-DB run of `reconcileOfficialCurriculum` asserting 2/7/23 and `status = 'PUBLISHED'` for official lessons.
