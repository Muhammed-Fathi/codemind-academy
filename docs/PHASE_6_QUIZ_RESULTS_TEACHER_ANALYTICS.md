# Phase 6 — Quiz Results & Teacher Analytics

Status: completed (2026-09-08).

This phase **reviews, hardens and verifies** the Quiz Results and Teacher
Analytics flow on top of the existing Phase 5 server-side assessment
architecture. It does **not** redesign Phase 5 grading, Phase 4 progression,
Mock Exams, or the database. Only genuine correctness and authorization
defects found during the audit were changed; the rest was verified and
documented.

## Objective

Make Quiz Results and Teacher Analytics accurate, secure, deterministic, and
derived from the authoritative Phase 5 assessment data:

- the official result stays the server-graded `QuizAttempt` (+ persisted
  `QuizAnswer` rows + question metadata);
- finished attempts are immutable and retakes remain separate;
- results and analytics are consistent across refresh / logout-login;
- student results are isolated per student;
- teacher analytics are scoped server-side to the courses/students/quizzes a
  teacher is actually authorized for;
- aggregation only ever reads authoritative persisted records;
- Session Quiz (`QuizAttempt`/`QuizAnswer`) and Mock Exam (`ExamAttempt`)
  stay fully separate;
- Phase 4 progression remains the single source of truth for unlocking.

## Baseline

Latest approved baseline is the merged Phase 5 implementation on `main`
(HEAD `66c2967`, PR #22). Phase 5 established the attempt-persisted,
server-graded Session Quiz model that this phase builds on and verifies.

## Existing Architecture

The assessment + analytics flow that already existed before this phase:

```
Question Bank (Question)
   → Session Quiz (Quiz → Question ownership)
   → QuizAttempt (persisted set as QuizAnswer rows at /start)
   → Server-side grading (src/lib/session-quiz.ts gradeAttemptQuestionSet)
   → Quiz Result (POST /api/quizzes/[id]/submit response + ResultScreen)
   → Phase 4 progression (a finished QuizAttempt completes the quiz gate)
```

Relevant endpoints:

- `GET  /api/quizzes/[id]` — quiz + question set. For a student it resolves
  `canAccessQuiz` (session unlocked), serves the open attempt's persisted set,
  reveals answers/explanations only after a finished attempt exists
  (`revealAnswers`), and returns a `bestAttempt` summary.
- `POST /api/quizzes/[id]/submit` — student-only, gated, grades the open
  attempt (or creates a fresh retake) server-side from the attempt's own
  frozen set; finished attempts are never written again.
- `GET  /api/teacher/analytics` — per-group teacher overview (attendance,
  quiz average/pass, homework, lesson completion, top/struggling students).
- `GET  /api/teacher/quizzes` — quizzes of the teacher's courses with
  question/attempt counts and an average; `POST` creates a quiz.

Relevant Prisma relationships:

- `Quiz.lesson → Lesson`, `Quiz.questions → Question`, `Quiz.attempts →
  QuizAttempt`
- `Lesson.unit → Unit → Part → Course` (canonical) and `Lesson.topic → Unit →
  Part → Course` (legacy); canonical link wins when both are set
  (`resolveLessonCourseId`).
- `QuizAttempt.student → Student`, `QuizAttempt.quiz → Quiz`, `QuizAttempt.
  answers → QuizAnswer` (`@@unique([attemptId, questionId])`)
- `QuizAnswer.question → Question` (`difficulty`, `marks`, `answer`, …)
- `Group.course → Course`, `Group.students → Student`; a `Teacher.groups`
  defines the teacher's authorized courses and students.

## Result Source of Truth

The authoritative result is the server-graded `QuizAttempt`:

- `score`, `totalMarks`, `percentage`, `passed` are written once by
  `gradeAttemptQuestionSet` at submit time and are never recomputed or trusted
  from the client.
- Per-question correctness lives on the persisted `QuizAnswer.isCorrect` rows
  of that attempt; difficulty analytics read the `Question.difficulty` of the
  question each persisted answer references.
- Question text/options/correct answer/explanation are read from `Question`
  metadata (deleted questions cascade their `QuizAnswer` rows away; edited
  questions keep their place).

No official result is derived from client/React/localStorage/submitted
score or percentage fields (Phase 5 already enforces this; verified).

## Student Results

The student sees, after submission on `QuizRunner`'s `ResultScreen`:
score, total marks, percentage, passed/failed, per-question correct/
incorrect, their selected option, the correct option on a miss, and the
explanation where present. Review data comes from the server's submit
response.

Answer leakage rules are intact and unchanged: `GET /api/quizzes/[id]` reveals
answers/explanations to a student only after at least one finished attempt,
and never exposes internal fields. Staff (teacher/admin/parent) see answers
for review/creation per the documented Phase 1 decision.

## Attempt History

Multiple attempts are represented by multiple `QuizAttempt` rows:

```
Quiz
 ├── Attempt 1   (QuizAnswer rows + graded result, immutable once finished)
 ├── Attempt 2   (fresh retake)
 └── Attempt 3
```

Verified:

- finished attempts are immutable — `POST /submit` only writes the open
  attempt or creates a brand-new one, never a finished one;
- a retake creates a fresh attempt with a fresh frozen question set; it does
  not overwrite an earlier attempt's `QuizAttempt`/`QuizAnswer` rows;
- each attempt belongs to the correct student (`studentId` derived from the
  authenticated session) and the correct quiz;
- an older attempt cannot be changed by a later one.

## Student Performance

This phase did **not** add a new student-performance dashboard. The existing
product exposes a student's `bestAttempt` summary through
`GET /api/quizzes/[id]` (score, percentage, passed, finishedAt). A broader
student performance surface (number of attempts, average, pass rate, best,
latest, weak sessions) is not implemented and is listed under
**Remaining Limitations / Deferred Work**.

## Question Analytics

Added for the teacher quiz surface. Per-quiz **question performance** is
computed from the persisted `QuizAnswer.isCorrect` rows of **finished**
attempts only:

- attempts on the question (one per finished attempt that included it),
- correct count, incorrect count,
- correctness percentage,
- ranked **weak questions** (lowest correctness first; ties by most attempts;
  `minAttempts` guards single-observation noise).

Implemented in `src/lib/quiz-analytics.ts` (`questionPerformance`,
`weakestQuestions`) and surfaced per quiz by `GET /api/teacher/quizzes`
(`weakQuestions`). Only authoritative persisted answers are counted; no
client-side review state is involved.

## Difficulty Analytics

`Question.difficulty` ∈ `EASY | MEDIUM | HARD`. Per-quiz difficulty
performance is computed from the persisted answers of finished attempts,
keyed to the difficulty of the question actually answered in the attempt (not
inferred from the student's score). The output always carries all three
difficulty slices, each with attempts / correct / incorrect / correctness%.

Implemented in `src/lib/quiz-analytics.ts` (`difficultyBreakdown`,
`difficultyBreakdownList`) and surfaced per quiz by `GET /api/teacher/quizzes`
(`difficulty`).

## Session Analytics

Session (lesson) level aggregation as a distinct teacher analytics view is
**not implemented** in this product (the existing `GET /api/teacher/quizzes`
groups per quiz and `GET /api/teacher/analytics` per group). See
**Remaining Limitations / Deferred Work**.

## Course Analytics

A dedicated course-level analytics view is **not implemented**. Per-quiz
analytics are course-scoped (see **Teacher Authorization**): `GET
/api/teacher/quizzes` only returns quizzes whose lesson resolves (canonical or
legacy chain) to a course the teacher's groups are bound to. See
**Remaining Limitations / Deferred Work**.

## Teacher Authorization

The server determines teacher scope. Verified and hardened:

- A teacher is authorized for the courses of their own `Group`s, the students
  in those groups, and the quizzes/lessons that resolve to those courses
  through **both** curriculum chains (canonical `Lesson.unitId` first, legacy
  `Lesson.topicId` fallback).
- **Changed (harden):** `GET /api/teacher/analytics` previously aggregated a
  student's *entire* `QuizAttempt` history regardless of which course a quiz
  belonged to. Because a student can carry historical attempts from a course
  taught by a *different* teacher (e.g. after a group/course change), those
  foreign attempts could leak into this teacher's numbers. The route now
  resolves the set of quizzes on the teacher's own courses (both chains) and
  drops any attempt whose `quizId` is not in that authorized set
  (`attemptInQuizScope`), before aggregation.
- `GET /api/teacher/quizzes` already scoped its queries to the teacher's
  courses through both chains; unchanged and verified.
- Manipulating a courseId/studentId/quizId in a request does not widen teacher
  visibility, because teacher identity comes from the authenticated session
  (`requireUser` + `getTeacherProfile`) and every query is anchored to the
  teacher's own groups — there are no arbitrary-id teacher analytics reads.

## Aggregation Rules

Explicit, deterministic rules recorded here and enforced by
`src/lib/quiz-analytics.ts` (see the module header for the same text):

- **Only finished attempts are counted.** An open attempt
  (`finishedAt = null`) is ungraded (its stored `percentage` is still the
  pre-submit default) and would deflate averages/pass rates. It is excluded in
  SQL (`finishedAt: { not: null }`) and defensively ignored by the helpers.
- **Averages and pass rates are over finished attempts, not over students.**
  Every finished attempt is one data point; retakes therefore each count (a
  three-time retaker contributes three points, not one "best score").
- **Percentage and `passed` come from the server-graded stored row.** A quiz
  with a different `passMark` already reflects its own pass boundary in the
  stored `passed` flag, so aggregation needs no per-quiz passMark guesswork.
- **Difficulty/question analytics derive from persisted answers** of finished
  attempts, keyed to the question answered; difficulty is the question's
  current metadata row (no per-answer difficulty snapshot). A deleted question
  no longer appears (its answer rows were cascade-deleted); an edited question
  keeps its historical correctness and is aggregated under the current
  difficulty. Zero-answer difficulties render as zeroed slices, never missing.
- **Analytics never mutate assessment state** — all helpers are pure reads;
  reporting endpoints never write `QuizAttempt`/`QuizAnswer`/`Question`.

## Phase 4 Integration

Unchanged. Progression stays in `src/lib/session-progress.ts`; the Phase 4
engine is the single source of truth for session unlocking and treats "a
finished `QuizAttempt` exists for every quiz of the lesson" as the quiz
requirement. This phase only **reads** finished attempts for analytics:

- submitting a quiz result completes the quiz requirement and leaves
  next-session unlocking to the Phase 4 engine;
- reading analytics / results does not mutate attempts and cannot alter
  progression state;
- no analytics route touches `LessonProgress` or writes to the progression
  tables.

## Mock Exam Isolation

Unchanged and re-asserted. Session Quiz uses `QuizAttempt`/`QuizAnswer`;
Mock Exams use `ExamAttempt` (with a JSON answer snapshot) and share only the
Question Bank. Verified:

- teacher analytics routes never read `ExamAttempt` rows;
- a Mock Exam result cannot mark a Session Quiz complete, unlock a session,
  appear as a Session Quiz attempt, or modify Session Quiz analytics.

## Database Changes

None. `prisma/schema.prisma` is untouched and no migration was created. The
phase inspects the schema and aggregates existing authoritative records only.
No `db:reset`, `db:push`, migration rewrite/delete, or history removal was
performed. Assessment history is preserved.

## Files Changed

- `src/lib/quiz-analytics.ts` — new pure analytics engine (finished-attempt
  summarising, difficulty breakdown, question performance / weak-question
  ranking, scope helper). DB-free and side-effect-free.
- `src/app/api/teacher/quizzes/route.ts` — restrict attempt analytics to
  finished attempts; surface per-quiz `passRate`, `difficulty` and
  `weakQuestions` derived from persisted answers.
- `src/app/api/teacher/analytics/route.ts` — restrict quiz aggregates to
  finished attempts **and** to the teacher's own authorized courses (both
  curriculum chains), closing a cross-course analytics scope leak.
- `tests/quiz-analytics.test.js` — new offline regression suite.
- `docs/PROJECT_STATE.md` — updated.
- `docs/PHASE_6_QUIZ_RESULTS_TEACHER_ANALYTICS.md` — this document.

## Tests

`tests/quiz-analytics.test.js` (44 assertions) covers, offline:

- Behavioural (real `quiz-analytics.ts` compiled and exercised): unfinished
  attempts excluded; retakes counted as separate attempt-weighted data points;
  empty/single/multi summaries; best/latest/participants; stored `passed`
  respected across differing pass marks; difficulty breakdown shape and
  correctness; question performance; weak-question ordering and `minAttempts`;
  scope membership.
- Route source invariants: `teacher/quizzes` and `teacher/analytics` restrict
  to `finishedAt != null`; `teacher/analytics` resolves authorized quizzes
  through both curriculum chains and filters via `attemptInQuizScope`;
  student answer-leak rules remain; no teacher analytics route reads
  `ExamAttempt`.

Full offline suite: **837 passed, 0 failed** (baseline 793 + 44 new).
Type-safety of the new pure module verified under `tsc --strict`; changed
files are lint-clean (no new findings vs. the deferred baseline).

## Production Verification

Full `typecheck` / `build` / production-startup / live-DB verification could
not be re-executed in this environment: `prisma generate` (required by the
build and by real `@prisma/client` types) downloads its schema engine from
`binaries.prisma.sh`, which is unreachable from this sandbox, so the real
Prisma client cannot be generated here. This is an environment limitation, not
a code change. The new module is pure and was verified in isolation; the route
changes were verified for syntax, lint cleanliness, and by the offline
route-invariant assertions. Live security/analytics matrix checks
(another-student denial, unauthorized-teacher denial, aggregation math against
a seeded DB) are therefore pending re-run in an environment with engine access
— see **Remaining Limitations**.

## Remaining Limitations

- No standalone student-performance dashboard (attempts / average / pass
  rate / best / latest / weak sessions for a single student).
- No separate session-level or course-level teacher analytics view; per-quiz
  difficulty/question analytics are surfaced through `GET /api/teacher/quizzes`
  only.
- No per-attempt historical review page for the student (review is shown
  immediately after submission; `GET /api/quizzes/[id]` returns only the
  `bestAttempt` summary afterward).
- No student attempt-history list endpoint.

## Deferred Work

- Student performance aggregation surface (attempt count, completed quizzes,
  average, pass rate, best/latest, weak sessions), gated by session identity
  and excluding unfinished / Mock Exam attempts.
- Session-level and course-level teacher analytics (average, pass rate,
  participating students, weak sessions) respecting the canonical and legacy
  curriculum chains.
- Weak-areas (difficulty) analytics rolled up to session/course level.
- Live-DB verification of the authorization and aggregation matrix in an
  environment where the Prisma engine can be downloaded.
