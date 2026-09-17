# Mock Exam Random/Fixed Audit Report

- **Scope**: Mock Exam question selection — Admin Question Bank (manual and AI-saved
  questions) → FIXED exam → RANDOM exam → candidate pool → attempt start → frozen paper →
  student attempt → submission → retry.
- **Branch**: `arena/01a0b089-codemind-academy` (base `main`); no PR, no merge, no deploy,
  no production data touched.
- **Verdict**: **READY FOR GIT DELIVERY** (round-2 review blockers closed — see
  `## Verdict` at the end).

---

## 0. Round-2 review questions — the actual final contract

**Q1 — How is a manual question scoped to a course?**

A manual question is created in the Question Bank as a plain `Question` row
(`POST /api/admin/question-bank`, ADMIN only):

| field | meaning for a manual question |
|---|---|
| `quizId` | `null` when the Admin adds a question from the Question Bank page without picking a quiz. **The `Question` table has no course column at all** — a free row belongs to the *school bank* of its `schoolType`, not to a course. |
| `schoolType` | `ARABIC` / `LANGUAGE` / `null` (shared). Explicit value wins, otherwise inherited from the owning quiz's track scope (`src/lib/track-scope.ts`). |

Therefore a manual question reaches a course **only through the exam**, never through a
course field:

- **Exam-bound rows (FIXED pins and RANDOM attachments)** live in `MockExamQuestion`
  (`mockExamId` + `questionId` | `examQuestionId`), i.e. they are scoped to exactly one
  exam, and that exam carries the course (`MockExam.courseId`).
- **Lesson-linked rows** (`Question.quizId` → `Quiz.lessonId`) are scoped through the
  lesson's course, across both curriculum chains (`unit.part.courseId` and
  `topic.unit.part.courseId`) — the same rule the student route uses.

`src/lib/mock-exam-pool.ts` expresses the rule once and every surface uses it: the student
attempt path, the Admin eligible-pool endpoint, the create route and the publish guard.

**Q2 — Can a free/manual question ever appear in another course?**

Never *automatically*. The old rule (`quizId = null` ⇒ eligible for every exam of the same
`schoolType`) is **deleted**. The final rule is:

```
eligible = bankFilter(schoolType)
           AND ( lessonLinked(question) inside the exam's course scope
                 OR ( question.quizId IS NULL AND question attached to THIS exam ) )
```

So a Course-B free manual row can only ever appear in a Course-A exam if an Admin
*explicitly* attached it to (RANDOM) or pinned it into (FIXED) that exam — an intentional,
per-exam, auditable act (the Admin exam list reports the pinned/attached counts, and the
eligible endpoint reports the per-question `attached` flag). It can never arrive through
sampling.

Residual boundary, reported explicitly: because `Question` has **no course column**, the
schema itself cannot record "this free row was written for Course B". `Question.quizId` and
`ExamQuestion.lessonId` are the only scope fields that exist. The smallest safe additive
design — **not implemented here, proposed only** — is one nullable column
`Question.bankCourseId String?` (`null` = school-wide shared bank, existing rows unchanged ⇒
no backfill), honoured as `OR: [{ bankCourseId: null }, { bankCourseId: exam.courseId }]`
inside the scope half of the rule, plus a course selector on the "Add question" dialog. That
is additive (no data migration, no rewrite of existing rows) and it removes even the
deliberate cross-course attach/pin. It needs a product decision about whether the Admin
should be allowed to pin a school-wide row into a course-bound exam, so it is left to review.

**Q3 — When exactly is a RANDOM paper frozen?**

At **attempt start** — the first authenticated `GET /api/exams/mock?mockExamId=…` of a
published exam opens the attempt. The sample is drawn once, server-side, from the eligible
pool and written to the attempt row in the same request; every later read of that attempt
replays it. Nothing is drawn at submit time.

**Q4 — Where are the selected IDs persisted?**

In `ExamAttempt.answers`, stored by the existing attempt row (no new table, no new attempt
model — the Phase26D lifecycle is reused):

```json
{ "v": 1, "kind": "mock-exam-paper", "examId": "…", "selectionMode": "RANDOM|FIXED",
  "difficulty": "…", "requested": 5, "ids": ["q1","q2","q3","q4","q5"],
  "seed": "…", "startedAt": "…" }
```

`encodeFrozenPaper` / `readFrozenPaper` in `src/lib/mock-exam-pool.ts` are the only
serializer. The row stays **open** (`finishedAt = NULL`) until the student submits, and an
open row is never counted as an attempt anywhere (student list, parent dashboard, admin
counters, retry index all filter `finishedAt != null`). The `seed` is kept for
reproducibility/diagnostics only; the ids are what is served.

**Q5 — What happens if the bank changes during an active attempt?**

Nothing the student can observe. The frozen branch reads the questions by
`id IN (frozen.ids)` **without re-applying the bank/difficulty/schoolType filters**, in the
stored order, with the option order derived from the stored seed. Therefore:

- adding an eligible question → **no** injection into a running paper;
- detaching / de-publishing / moving a question out of the bank (`schoolType` change) or
  changing its difficulty → **no** swap, no disappearance;
- only **deleting** a row outright can shorten a running paper, and that is reported to the
  student through `api.311` ("you received {p1} of {p2}") instead of silently changing the
  paper.

After submission the new attempt (retry / next start) is drawn from the **current** pool, so
bank edits do take effect for future attempts — never for a running one.

**Q6 — What happens after a retry grant / a new attempt?**

Unchanged platform model. No new retry model, column or flag was introduced, and the
platform's existing Admin retry grant is untouched: that grant lives on the session-quiz side
(`/api/admin/quiz-retries`, `POST /api/quizzes/[id]/start`) and its one-attempt /
consume-once / audit lifecycle is still verified green (`session-quiz` **70/0**,
`phase26d-teacher-full-flow` **`PHASE26D_TEST_OK`**, `auth-cross-role-phase26f`
**`PHASE26F_VERIFIER_OK`**). Mock Exams keep the behaviour they already had: a submission is
its own attempt row with its own paper. What the fix changes is only *which* questions the
next attempt gets: the paper is frozen per attempt, and the run after a submission is drawn
**fresh** from the current pool with a new seed, while the earlier attempt keeps its own
frozen ids, score and review.

---

## 1. Root Cause

Round 1 (the original defect): eligibility for RANDOM/FIXED was *"school bank **or** shared
bank"* only — `Question` rows were sampled with a `schoolType` filter and nothing else, so a
question attached to no lesson (`quizId = null`) or an `ExamQuestion` with `lessonId = null`
was a candidate for **every** exam of that school type, in every course, and the AI Generator
was treated as the only "proper" producer of questions while manual rows were treated as
bank-wide filler.

Round 2 (the two review blockers, now closed):

1. **Cross-course over-reach.** The round-1 fix had reintroduced the same class of bug in a
   different shape: `quizId = null` (or `ExamQuestion.lessonId = null`) was treated as
   "belongs to the exam's course". Both branches are gone; free rows are now eligible for an
   exam only when that exam *attached* them (`MockExamQuestion`), and lesson-linked rows are
   eligible only when the lesson resolves to the exam's course (or to any course, for a
   course-less exam). Proven by section **J** of `tests/mock-exam-random-manual-bank.test.js`
   (Course A never receives a Course B row, in both directions, plus a cross-open 404).
2. **The freeze was determinism, not persistence.** The paper was recomputed on every read
   from an HMAC seed + the *current* candidate pool, so a bank edit mid-attempt could change
   the paper after a refresh, and no row recorded what the student had actually been served.
   The paper is now written to `ExamAttempt.answers` at start and replayed from there, and
   submission finalizes that same row. Proven by section **K**: add + detach + move out of
   bank + difficulty change all leave the ids **and their order** identical, while a *fresh*
   sample over the mutated pool is demonstrably different — i.e. the test proves persistence,
   not determinism.

Two harness-level findings are worth recording, because they were the cause of a red
`mock-exam-phase8` run during this round and were fixed in the test rig, not by weakening the
contract:

- the phase-8 in-memory Prisma shim never materialised schema defaults, so
  `finishedAt` was `undefined` on rows created by GET, and the shim's filter emulation then
  read `finishedAt: null` as "no match" (resume never resumed) and `{ not: null }` as "match"
  (open papers counted as finished attempts). The shim now treats an unset nullable column as
  `NULL`, exactly like Prisma;
- the shim returned `true` for relation filters it does not model (e.g.
  `mockExamLinks: { some: … }`). The randomised-bank suite carries a faithful
  `question.mockExamLinks` / `examQuestion.mockExamLinks` mapping, which is what makes its
  attachment assertions meaningful.

---

## 2. Manual Question Eligibility (canonical Question Bank contract)

| case | eligible for this exam? |
|---|---|
| manual row, same bank, `quizId = null`, **attached to this exam** (RANDOM) or **pinned into it** (FIXED) | ✅ |
| manual row, same bank, `quizId = null`, not attached anywhere | ❌ (old behaviour: ✅ in every exam of the bank — removed) |
| manual row, shared bank (`schoolType = null`), attached to this exam | ✅ |
| question linked to a quiz → lesson of this exam's course, lesson student-visible | ✅ |
| question linked to a lesson of another course | ❌ |
| question linked to a DRAFT lesson | ❌ |
| different bank (`schoolType` mismatch) | ❌ |
| `ExamQuestion` twin (`lessonId = null`, attached to this exam) | ✅ |
| `ExamQuestion` twin, free and unattached | ❌ |
| difficulty / marks / tags / prompt language / **how the row was produced** | not eligibility inputs — difficulty is a *sampling filter* only |

Manual and AI-saved questions are the same `Question` rows with the same columns; there is
no `source`, `generator` or AI-metadata column, and no code path reads one. The only
structural difference is incidental: the AI generator always writes `quizId = <the quiz it
generated into>` (`src/app/api/admin/ai-generate-quiz/route.ts`), while a manual row may be
free (`quizId = null`). Free rows are first-class citizens of the pool once attached — that is
the whole point of the round-2 rule.

---

## 3. FIXED Flow

1. Admin creates the exam with `selectionMode = "FIXED"` and picks questions in the
   eligible list (`/api/admin/mock-exams/eligible?list=1`, ADMIN only, key-free: ids, prompts,
   metadata — never `answer`/`explanation`).
2. `POST /api/admin/mock-exams` validates **every** submitted id against
   `mockExamFixedPinWhere(schoolType, lessonIds)` = bank filter AND (free-bank row OR
   lesson-linked inside the exam's course). A mismatching id ⇒ `api.309` 400; duplicates or an
   empty selection ⇒ `api.307`; a count that disagrees with the selection ⇒ `api.308`. Pins
   are written in the Admin's order (`MockExamQuestion.order = index`).
3. Student start: the pinned rows are read in `order` and frozen into the attempt at start
   like any other paper. A FIXED exam serves its pins — not `questionCount`, not the exam's
   difficulty.
4. Zero pins ⇒ `exam: null` + "no eligible questions" message (`api.310`); the publish guard
   refuses to publish a FIXED exam whose pin count is below the requested count (`api.312`).

Evidence: `mock-exam-random-manual-bank` §D (pinned manual rows served unchanged, in order),
`mock-exam-phase8` §D (3 refetches → identical pinned sequence, difficulty ignored).

---

## 4. RANDOM Flow

1. Pool = `bankFilter(exam.schoolType)` AND (lesson-linked inside the exam's course scope OR
   free row attached to this exam), computed over **both** tables (`Question` and
   `ExamQuestion`) by `countMockExamEligiblePool`.
2. Admin creates the exam with `questionCount` and, optionally, ids to attach
   (`POST /api/admin/mock-exams` → `attachedQuestionIds`): each id must be eligible
   (`api.309`), then the route creates the exam as a draft, writes the attachments
   (`createMany`, order = index), **re-measures the pool with `mockExamId`** and only then
   publishes. If the pool is still short it deletes the draft and returns `api.213`
   (Arabic: "the bank has only X eligible questions — reduce the count"), including the
   free-bank breakdown. An exam without an explicit selection is measured against the same
   pool before it is created (`servable`), and `POST /api/admin/mock-exams/[id]` applies the
   same guard on publish.
3. The Admin UI shows the eligible-pool count for the chosen bank + difficulty (+ course), and
   the attach picker lists the free bank rows of that bank with their `attached` state.
4. Student start: the pool is sampled with the exam's difficulty filter, deduplicated by id,
   capped by `questionCount` and frozen (Q3/Q4). The response also reports the exam's eligible
   pool size, so the student side can never silently serve fewer questions than configured:
   if the pool shrank after publication, the student gets the available questions **and**
   `api.311` saying so.
5. No duplicates: ids are unique per paper (the unique key on `MockExamQuestion` prevents a
   duplicate attachment, and the sampler dedupes across the two tables). A count larger than
   the pool is refused at creation/publish (Arabic `api.213`), never silently padded.

Evidence: `mock-exam-random-manual-bank` §A/§C/§C2/§E (attachment-only entry, create+publish
guards, count/no-dups/no-AI-metadata), §I (bank emptied after publication), `mock-exam-phase8`
§C (RANDOM sample stays in-bank, unknown/unpublished/foreign-course exams 404/403).

---

## 5. Retry / Attempt Behavior

- The platform's attempt model is unchanged: the one-attempt default and the Admin retry
  grant live on the session-quiz side (`/api/admin/quiz-retries`) and were not touched; no
  second attempt model, table or flag was introduced, and `ExamAttempt` keeps its columns and
  lifecycle.
- An attempt row is created when the student starts, not when they submit. Open rows are
  invisible to every counter (`finishedAt != null` filters), so attempt counts are measured on
  finished attempts exactly as before.
- Submission: if the submit answers a frozen paper of an open attempt, that row is
  **finalized in place** (same id, same `startedAt`, result attached). A submission that never
  started a paper (API client, free practice) creates a finished row exactly as before.
- After submission, the next start draws a **new** paper from the current pool (new seed), and
  the earlier attempt keeps its frozen ids, score and review — Mock Exams keep their existing
  "each submission is its own attempt row" behaviour.

Evidence: `mock-exam-random-manual-bank` §F/§K (finalize-in-place, then a fresh paper for the
next start), `mock-exam-phase8` §E (5 submits → 4 new rows + 1 finalized, no open paper left,
no `QuizAttempt`/`QuizAnswer`/`LessonProgress` writes), §F (history counts finished attempts
only, `bestPercentage`), §H (parent dashboard stays finished-only).

---

## 6. Security

- **No key material before submit**: the start/resume response carries prompts, options and
  ids only; `answer`, `explanation` and `isCorrect` are absent (`mock-exam-phase8` §B/§C,
  `mock-exam-grading-isolation` 22/0).
- **Grading is server-side**: submitted `isCorrect`/`marks` are ignored; the score, the total
  and the review are computed from the DB key (`phase8` §E: client `marks: 9999` → DB `2`;
  forged `isCorrect: true` → `false`).
- **No client-chosen ids**: a submitted `questionId` outside the exam's eligible key space is
  graded as unknown (0 marks, no key revealed) and does not link the exam
  (`phase8` §E, `mock-exam-random-manual-bank` §G).
- **Cross-role / cross-user mutation blocked**: the Admin endpoints require ADMIN
  (`requireRole("ADMIN")`), the eligible endpoint requires ADMIN, students can only read their
  own attempts (`security-hardening` 375/0, `security-audit-gate` 116/0,
  `auth-cross-role-phase26f` `PHASE26F_VERIFIER_OK`, §B of the randomised suite).
- **Scope respected**: `schoolType` bank isolation, course scope, unpublished exams (404) and
  cross-course opens (404) are all asserted; archived/ineligible material (DRAFT lessons,
  wrong bank, unattached free rows) is excluded by construction (§J above, `phase8` §C).
- **Deletion safety** (`src/app/api/teacher/questions/[id]/route.ts`): a question referenced by
  frozen history, an open/graded attempt, or a FIXED pin cannot be deleted, and `schoolType`
  cannot be edited while answer rows exist — so the "only deletion can shorten a running
  paper" path is itself guarded.
- **Auditability**: the paper stored on the attempt makes what a student was served
  reconstructible from the DB alone.

---

## 7. Files Changed

New:

| file | purpose |
|---|---|
| `src/lib/mock-exam-pool.ts` (638) | the single eligibility/pool/freeze contract: scope fragments, pool counts, sampling, frozen-paper codec, option order, frozen-row picker |
| `src/app/api/admin/mock-exams/eligible/route.ts` (158) | Admin eligible-pool endpoint (`?mockExamId=` validated against bank+course, `list=1` FIXED picker, `list=pool` RANDOM attach picker, per-item `attached`, key-free) |
| `tests/mock-exam-random-manual-bank.test.js` (1141) | the scratch-fixture suite: manual bank questions only, ≥10 rows, FIXED exact + RANDOM count/no-dups/no-AI-metadata, cross-course isolation (§J), freeze under mutation (§K) |
| `docs/MOCK_EXAM_RANDOM_FIXED_AUDIT_REPORT.md`, `docs/MOCK_EXAM_WORKFLOW_GUIDE_AR.md` | this report and the Arabic workflow guide |

Modified (tracked): `src/app/api/exams/mock/route.ts` (+378/−…, start/resume + freeze +
finalize + pool integration), `src/app/api/admin/mock-exams/route.ts` (+274, dual-mode create,
attachments, pool guards, eligible counts, finished-only attempt counters),
`src/app/api/admin/mock-exams/[id]/route.ts` (+35, publish guard + stale-attachment sweep),
`src/components/admin/mock-exams-view.tsx` (+354, course scope, eligible counter, FIXED/RANDOM
picker, attached marker), `src/components/student/mock-exam.tsx` (+27, resume/shortfall
messaging; submission contract unchanged — option **text**), `src/lib/i18n-dict-2026.ts`
(+134/−…, new Arabic/English messages `api.213/307–312`, `admin.541/545/554/556–561`; the dead
`api.306` "FIXED only" key was **removed** because RANDOM accepts explicit attachments now),
`tests/mock-exam-phase8.test.js` (+68, rewritten sections E/G/H + faithful shim NULL
semantics), `tests/authorization-invariants.test.js` (+11, the pool-sufficiency invariant now
pins `countMockExamEligiblePool({…schoolType…})` and `questionBankFilter(schoolType)` inside
the pool library).

`git diff --stat` (tracked files): 8 files changed, 1161 insertions(+), 120 deletions(-).

---

## 8. Tests (exact totals, this round)

| suite | result |
|---|---|
| `tests/mock-exam-phase8.test.js` | **142 passed, 0 failed** |
| `tests/mock-exam-random-manual-bank.test.js` | **121 passed, 0 failed** |
| `tests/mock-exam-grading-isolation.test.js` | **22 passed, 0 failed** |
| `tests/authorization-invariants.test.js` | **94 passed, 0 failed** |
| `tests/session-quiz.test.js` (Phase 26D quiz/attempt) | **70 passed, 0 failed** |
| `tests/security-hardening.test.js` | **375 passed, 0 failed** |
| `tests/security-audit-gate.test.js` | **116 passed, 0 failed** |
| `tests/auth-cross-role-phase26f.test.js` | **`PHASE26F_VERIFIER_OK`** |
| `tests/phase26d-teacher-full-flow.test.js` (Phase 26D attempts) | **136 passed, 0 failed — `PHASE26D_TEST_OK`** |
| `tests/admin-publishing-phase15.test.js` | **386 passed, 0 failed** |
| `tests/calendar-i18n-phase9.test.js` | **460 passed, 0 failed** |
| `tests/production-storage-phase21.test.js` | **180 passed, 0 failed** |

- **TypeScript**: `npx tsc --noEmit` → **74 errors, none in the mock-exam/exams-mock code**.
  All 16 errors inside touched/new files are `TS2694 ... Prisma has no exported member
  'QuestionWhereInput'` — the local generated client is an offline stub
  (`node_modules/.prisma/client/index.d.ts`, 3,989 bytes, contains no model types), because
  `prisma generate` cannot reach the engine download in this sandbox. The authoritative check
  is CI, which runs `npx prisma generate && npx tsc --noEmit && npm run build:postgres`
  (`.github/workflows/migration-providers-postgres.yml`). The remaining 58 errors are
  pre-existing/environmental in untouched files (parents dashboards 45, teacher/quizzes,
  session-quiz lib).
- **ESLint**: 3 errors in the touched components — 2 `react-hooks/set-state-in-effect` and 1
  `react-hooks/immutability` (in `mock-exam.tsx`, pre-existing `submitExam` hoisting). The
  same 3 errors with the same rules exist at the base commit for those two files (verified by
  stashing the working-tree versions), so this change adds no lint debt.
- Whole-repo sweep (59 suites) was run: everything green except
  `tests/final-integration-phase22.test.js`, which crashes on `scandir 'backups'` — the
  `backups/` directory is git-ignored, so the failure is environmental and unrelated
  (`/backups/`, `.gitignore` line 91).

---

## 9. DB / Migration Impact

**None.** No `prisma/schema.prisma` change, no migration, no data backfill:

- the paper lives in the existing `ExamAttempt.answers` text column (the JSON envelope of
  Q4), and the attempt row keeps its existing columns and lifecycle;
- FIXED pins and RANDOM attachments reuse the existing `MockExamQuestion` table
  (`questionId?` / `examQuestionId?`, `order`, unique `[mockExamId, questionId]` and
  `[mockExamId, examQuestionId]`), whose back-relations `Question.mockExamLinks` and
  `ExamQuestion.mockExamLinks` are already part of the committed schema;
- no production data was read or written; `prisma/` is unmodified in the working tree.

The only schema change proposed anywhere in this report is the *optional* future
`Question.bankCourseId` (Q2), which is additive and would not migrate existing rows.

---

## 10. Arabic Guide

`docs/MOCK_EXAM_WORKFLOW_GUIDE_AR.md` — written for the Admin/teacher: creating a manual
question, FIXED vs RANDOM, what makes a question eligible, how to attach free-bank questions
to a RANDOM exam, eligible-pool counts, the Arabic insufficient-pool messages, what the
student sees, freezing during an attempt, retry behaviour, troubleshooting table, and the
explicit statement that the AI Generator is never required.

---

## 11. Verdict

**READY FOR GIT DELIVERY.**

- Blocker 1 (cross-course over-reach): closed by the per-exam attachment rule; the residual
  schema limitation is reported and the minimal additive design is proposed, not silently
  hacked in.
- Blocker 2 (determinism instead of a frozen paper): closed by persisting the ordered ids in
  the attempt row at start and finalizing that row at submit; the freeze survives
  add/detach/move/difficulty mutation, and the test proves persistence rather than
  determinism.
- Nothing was weakened: the platform's one-attempt default and Admin retry grant (session
  quizzes), attempt start/consumption semantics, attempt history, server-side grading and
  answer-key secrecy are all asserted by the suites above.
- Remaining, deliberately not done in this round: no PR, no deploy, no production data
  changes; the optional `Question.bankCourseId` scope column awaits a product decision; the
  local `tsc`/`prisma generate` limitation is environmental and is covered by CI.
