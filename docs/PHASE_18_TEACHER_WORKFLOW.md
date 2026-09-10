# Phase 18 — Teacher Workflow Completion

**Status:** implemented and verified (2026-09-10). Deliberately NOT merged (separate pre-merge audit follows, per the phase protocol).
**Depends on:** Phase 11 (official curriculum: `Lesson.unitId` / `officialCode` / `curriculumStatus`), Phase 12 (`TrackScope` + `canAccessTrackScope`/`resolveQuestionSchoolType`), Phase 13 (lifecycle `Lesson.status` + archived rule), Phase 4/5 (progression gate + frozen attempt question sets), Phase 6 (teacher analytics contract), Phase 8 (`MockExam.selectionMode = "FIXED"` pins).
**Verdict:** `PASS — SAFE TO MERGE` (with the documented sandbox limitations of §11).

---

## 1. The contract

Phase 18 finishes the **teacher authoring surface** on the canonical curriculum. One
question drives every decision in this phase:

> When a teacher writes something, which course does it belong to, which track may see
> it, and which existing assessment record would that write silently rewrite?

Every teacher write therefore resolves the same chain, in this order — and only the
route that shows it in that order may write:

```
authenticated (cm_session cookie)
  → role === TEACHER
  → Teacher profile for the session user
  → the teacher's OWN course ids (Group.courseId rows — never a request field)
  → the target lesson's course through Course → Part → Unit → Lesson
     (legacy Course → … → Topic → Lesson only as a fallback)
  → the resource belongs to that lesson (quiz of the lesson, question of the quiz)
  → the track scope is valid and contained
```

`src/lib/teacher-content.ts` is the single implementation of that chain
(`teacherCourseIds`, `loadOwnedLesson`, `lessonPlacement`, `LESSON_PLACEMENT_SELECT`)
plus the two lock tables and the one question validator. Routes call it; they do not
re-derive it. The reason is on the record: the Phase 12/13 audits found routes that
agreed on *five of the six* steps.

## 2. Canonical lesson coverage (the discovery finding)

The Phase 18 discovery over `src/app/api/teacher/**` found the *whole teacher surface*
resolving lessons through the **legacy topic chain only**:

| Reader | Before | After |
|---|---|---|
| `GET /api/teacher/lessons` | `{ topic: { unit: … } }` only | `lessonCoursesChainOr(courseIds)` (unit **or** topic) |
| `GET /api/teacher/homework` | topic chain only | both chains; payload resolves `unit ?? topic.unit` |
| `POST /api/teacher/homework` | *(did not exist)* | `loadOwnedLesson` (canonical first) |
| `POST /api/teacher/quizzes` | already dual-chain | unchanged contract, now shares the placement helper |
| `PATCH /api/teacher/homework/[id]/grade` | topic chain only | `LESSON_PLACEMENT_SELECT` + `lessonPlacement` |

Because official lessons carry `unitId` and a **NULL** `topicId` (Phase 11), a
topic-only resolver returns `null` for the entire official curriculum — the teacher
could not see, list or grade anything belonging to it. The picker now returns, for
every lesson the teacher owns: `id`, `title`, `titleRaw`, `officialCode`, `chain`
(`CANONICAL`/`LEGACY`), `trackScope`, `status`, `curriculumStatus`, `archived`, and
the full `course → part → unit` placement, plus a grouped `course → parts → units →
lessons` tree.

**Student visibility rules are NOT applied here.** `EXCLUDE_ARCHIVED_LESSON` and
`LESSON_STUDENT_STATUS_FILTER` appear nowhere in `src/app/api/teacher/**`: a `DRAFT`
lesson is what the teacher is about to finish, and an `ARCHIVED` lesson can still hold
an ungraded submission. Both are *labelled* (badges) instead of hidden. The authoring
rule that *does* apply is uniform and narrow: **no NEW content on an ARCHIVED lesson**
(409 `api.242`) — for homework, quizzes and appended questions alike.

## 3. Track scope: explicit, contained, never inferred

`resolveContentTrackScope(requested, lessonScope)` (in `src/lib/track-scope.ts`) is the
only decision, and `isTrackScopeWithinLesson` is the only containment test:

| `requested` | lesson `SHARED` | lesson `ARABIC` | lesson `LANGUAGE` |
|---|---|---|---|
| absent / `null` / `""` | inherits `SHARED` | inherits `ARABIC` | inherits `LANGUAGE` |
| `SHARED` | `SHARED` | `SHARED` | `SHARED` |
| `ARABIC` | `ARABIC` | `ARABIC` | **400** `OUT_OF_LESSON_SCOPE` |
| `LANGUAGE` | `LANGUAGE` | **400** | `LANGUAGE` |
| anything else | **400** `INVALID_SCOPE` | **400** | **400** |

* **An absent value inherits the LESSON's scope — never `SHARED`.** Defaulting to
  `SHARED` on omission would *widen* a track-specific lesson's new content, which is
  exactly the ambiguity the roadmap forbids.
* **`SHARED` stays legal everywhere.** A `SHARED` child of an `ARABIC` lesson is
  narrower in practice (the lesson gate runs first via `gateTrackedResource`), and it
  is the stored state of every row that predates Phase 12. Forbidding it would make the
  phases contradict each other.
* **`LANGUAGE` under `ARABIC` is refused** rather than stored: it could never be opened
  by anyone, and storing unreachable content is how a teacher ends up believing they
  configured something.
* **Questions keep the Phase 12 precedence** (explicit → owning quiz's scope → SHARED),
  because `schoolType` is a *selection filter inside an already-gated container*. The
  ceiling is therefore the owning **quiz**: `isQuestionScopeWithinQuiz` accepts
  `SHARED` under any quiz and a matching track under a track-specific quiz.
* **Unknown values fail closed on both sides**, and the failure is a `400` — a scope
  that cannot be honoured is never silently rewritten.
* The UI mirrors the rule with an explicit **“Inherit from lesson”** option
  (`TRACK_INHERIT = "__inherit__"` sentinel → `""` at the request boundary, because
  Radix `SelectItem` cannot carry an empty value). The client never substitutes a
  default scope.

## 4. Homework: create + safe update

`POST /api/teacher/homework` — deterministic validation order (the same bad payload
always produces the same answer):

```
role → teacher profile → lessonId → title → instructions → deadline → maxMarks
     → ownership (canonical chain) → archived guard → track scope → create
```

* `instructions` are **required** (`api.237`): the Phase 13 readiness ceremony refuses
  a homework without them, so creating one would queue a session that can never open.
* Limits: title 160, instructions 4000, marks 1–100, deadline inside 2000–2100.
  Out-of-range input is **rejected, never clamped** — a teacher who typed `0` minutes
  must learn it was not stored, not discover later that the quiz runs untimed.
* Ownership runs **before** the archived/scope checks, so a teacher probing another
  teacher's lesson learns nothing about its lifecycle or scope (`api.179` + the
  loader's 403/404 status).

`PATCH /api/teacher/homework/[id]` — metadata may be corrected; history may not be
rewritten:

| Change | Result |
|---|---|
| `title`, `titleAr`, `instructions`, `deadline` | allowed, any time (no submission writes) |
| `lessonId` → a different lesson | **400** `api.241` (it would move graded work across curriculum nodes) |
| `maxMarks` below the highest stored grade | **409** `api.240` |
| `trackScope` change while a graded submission exists | **409** `api.239` |
| `trackScope` change with no graded work | allowed (contained by the lesson's scope) |
| empty patch | **400** `api.234` |

The response reports `gradedCount` and `preservedGrades`; the route performs **zero
writes to `HomeworkSubmission`**. No new versioning model was introduced — it was not
necessary: the destructive changes are simply refused.

## 5. Question lifecycle: frozen attempts and FIXED exams

A `Question` row is referenced by exactly two things, and both are read in **one query
each** (`loadQuestionReferences`, never N+1) so the counters cannot drift from the rows
the guards act on:

* `QuizAnswer` rows — the **frozen** question set of a `QuizAttempt` (Phase 5). The
  frozen rows pin the question's **id** and verdicts, *not* its text or answer key:
  serving and grading read the live row. An answer row of an open attempt means a
  student is answering it right now; a row of a finished attempt is graded history.
* `MockExamQuestion` pins — a `FIXED` exam serves its pinned set **as-is**.

| Action | Unreferenced | Open attempt | Graded attempt | FIXED pin |
|---|---|---|---|---|
| `DELETE` | allowed | **409** `api.247` | **409** `api.247` | **409** `api.246` |
| `PATCH` `answer` / `options` / `type` / `marks` | allowed | **409** `api.245` | **409** `api.245` | allowed¹ |
| `PATCH` `schoolType` | allowed | **409** `api.245` | **409** `api.245` | allowed¹ |
| `PATCH` `prompt` / `promptAr` / `explanation` / `difficulty` | allowed | allowed | allowed | allowed |

¹ A FIXED exam cannot *lose* the question through an edit — the pin is a row reference
and the exam keeps serving it; only deletion shrinks it, and deletion is the refused
case. `difficulty` re-labelling historical analytics is documented Phase 6 behaviour.

Additional rules:

* **Deletion cascades into `QuizAnswer`** (`onDelete: Cascade`), which would silently
  rewrite every attempt that ever contained the question — hence “delete rejected when
  referenced”. There is no soft-delete column and this phase deliberately adds none.
* **An omitted `schoolType` never re-tags an existing question** (`if (patch.schoolType
  !== undefined) data.schoolType = …`). Re-tagging is refused outright while any answer
  row exists, because the attempt loader re-applies eligibility when it loads the frozen
  set.
* **A refused edit writes nothing.** The lock is evaluated before the `update`.
* **PATCH re-validates the MERGED draft** with the same `validateQuestionDraft` used by
  creation, so a prompt-only edit need not restate the options, but a changed option
  list still answers to the full rule set (2–10 options, ≤500 chars, answer index in
  range, marks 1–100, tag contained by the quiz).
* **`POST /api/teacher/quizzes/[id]/questions` is additive by construction**: the new
  question joins *future* attempts only (an existing attempt's frozen set is its own
  `QuizAnswer` rows), the ceiling is `QUESTIONS_PER_QUIZ_MAX = 100`, and an `ARCHIVED`
  lesson takes no new question.
* **`DELETE /api/teacher/quizzes/[id]`** refuses while any `QuizAttempt` exists
  (`api.249`) or while any of its questions is FIXED-pinned (`api.246`), before any
  write.
* **FIXED-exam safety surfaces the evidence**: `GET /api/teacher/questions/[id]`
  returns `references` (`answers`, `openAttempts`, `gradedAttempts`, `fixedExamPins`,
  `randomExamPins`, `examPins`), `mockExamPins[]` (`mockExamId`, `title`, `schoolType`,
  `selectionMode`, `order`), `canDelete`, `deleteBlockers[]` and `canEditAnswerKey`, so
  the UI disables an action instead of discovering the 409. No teacher route ever
  deletes a pin row.

## 6. `timeLimit` verdict: **ENFORCE** (option a)

The Phase 18 brief allowed exactly one of “enforce server-side” or “remove/deprecate”.
`Quiz.timeLimit` was already accepted by the create route, stored, and rendered by the
UI while **nothing read it** — the archetypal misleading no-op configuration. It is now
enforced end-to-end (`src/lib/session-quiz.ts`):

```
deadline = QuizAttempt.startedAt + timeLimit(minutes) + TIME_LIMIT_GRACE_SECONDS (30)
```

* **The clock is the server's.** `startedAt` is written by the server on attempt
  creation; the deadline is computed server-side at every request and returned as
  `expiresAt`/`remainingSeconds` so the client renders a countdown it cannot forge.
  No quiz route reads `body.expiresAt` / `body.deadline` / `body.startedAt`.
* **The grace window is fixed and documented** (30 s) so a student pressing Submit with
  one second left is not failed by network latency.
* `null`, `0`, negative, or non-finite limits mean **no limit** (`normalizeTimeLimitMinutes`),
  which is every quiz that existed before this phase.
* **A late submit is refused**: 409 `TIME_LIMIT_EXCEEDED` (`api.256`) carrying
  `attemptId`, `score`, `totalMarks`, `percentage`, `passed`, `passMark`, `finishedAt`
  and the graded answers — and it is refused **before any grading happens**. Accepting
  late answers would make the limit decorative, which is the state this phase was told
  to resolve.
* **An expired attempt is finalised, never left open.** It is graded at its deadline
  from the answers the server already holds (the frozen set is seeded unanswered, so an
  abandoned attempt grades to 0) with `finishedAt = deadline`. This keeps the Phase 4
  progression rule (“a finished attempt exists”) exactly as an immediate empty submit
  would satisfy it — no new unlock path, and no student wedged with an attempt that can
  never be submitted.
* **Resuming an expired attempt never banks time**: `/start` finalises it and opens a
  **fresh** attempt with a fresh clock. `GET /api/quizzes/[id]` exposes `quiz.attemptWindow`
  (`startedAt`, `expiresAt`, `remainingSeconds`, `expired`) for the open attempt so a
  reloaded page renders the *same* countdown.
* `start` responses carry `timeLimitMinutes`, `startedAt`, `expiresAt`,
  `remainingSeconds`, `expired`; `timeLimit: ""` from the UI stores `null`.

## 7. Teacher analytics (Phase 6 preserved, one track cut added)

`GET /api/teacher/analytics` keeps the Phase 6 contract untouched — finished attempts
only (`finishedAt: { not: null }`), attempt-weighted aggregates, deterministic ordering,
no mutation, no `ExamAttempt` folding — and adds a **`trackSplit`** built from
`TRACK_BUCKETS` + `summarizeFinishedAttemptsByTrack` (Phase 12 helpers) on both
`overview` and every `groups[]` entry. `GET /api/teacher/quizzes` likewise returns each
quiz's own `trackScope` and a per-quiz `trackSummary` (the same bucket shape) plus
`lesson.trackScope`. No analytics UI was redesigned; no new aggregation SQL was written.

## 8. The teacher UI

`src/components/teacher/teacher-authoring.tsx` (new client module) +
`teacher-dashboard.tsx` (rewired):

* **`useTeacherLessons()`** — one shared React Query hook over `/api/teacher/lessons`
  (flat + grouped). It replaces the topic-only lesson dropdown that made every official
  lesson invisible.
* **`LessonPicker`** — searchable canonical picker showing `officialCode`, part, unit,
  track scope, lifecycle and archive state; `LessonMeta` renders the selected lesson's
  placement, and the quiz editor shows it before saving.
* **`TrackScopeSelect`** — explicit scope with an “Inherit from lesson” option
  (`TRACK_INHERIT` sentinel).
* **`HomeworkDialog`** — create (from the section header) and edit (per card) with
  `gradedCount`-driven disabling of destructive fields; it is remounted per target
  (`key={authoring?.homework?.id ?? "new-homework"}`) so its state is seeded from props
  instead of synchronised in an effect.
* **`QuestionManagerDialog` / `QuestionForm`** — list, append, edit and delete
  questions, surfacing `references`/`canDelete`/`deleteBlockers`/`canEditAnswerKey` and
  the per-question track tag; the same validator runs client- and server-side.
* **`TrackSplitRow`** — renders the server's `trackSummary` numbers.
* Quiz and homework cards show `StatusBadge` / `CurriculumBadge` / `TrackScopeBadge`
  (reused from `src/components/admin/session-workflow-shared.tsx`, so the two portals
  share one vocabulary).
* `teacher-authoring.tsx` imports UI primitives from their individual
  `@/components/ui/<file>` paths (no barrel), and the teacher UI calls **no admin
  endpoint**.

## 9. Explicitly out of scope (strict phase boundary)

Not implemented, not touched: parent portal redesign, Postgres migration, Phase 20
security overhaul, Phase 21 infrastructure, Phase 22 deployment, Phase 19 analytics
alignment, and **any schema migration** (Phase 18 adds none — asserted by the suite).
The student engine (progression gate, frozen sets, grading, mock exams, homework
submission) is unchanged except for the *additive* time-limit enforcement described in
§6.

## 10. Verification

| Layer | Artefact | Result |
|---|---|---|
| Pure functions (limits, placement, locks, validator, track containment, time-limit math) | `tests/teacher-workflow-phase18.test.js` §A–§C | included below |
| Source pins with negative controls (routes, UI, schema) | §D–§K | included below |
| **Real HTTP handlers over a real migrated SQLite DB with real auth** | `scripts/verify-phase18-teacher.mjs` (driven from §L) | **157 assertions, 0 failed** |
| Full regression | all 23 `tests/*.test.js` suites (incl. Phases 12/13/16/17, session-quiz, progression, analytics, parent, security) | **23/23 pass** |
| Typecheck | `npx tsc --noEmit` | exit 0 |
| Lint | `npx eslint .` | 117 problems — **identical to the `main` baseline** (all pre-existing; no new file/rule) |
| Build | `prisma generate && next build && copy-standalone-assets` | **compiled successfully** (exit 0; all four new `/api/teacher/*` routes in the route manifest) |

The end-to-end verifier drives the shipped handlers (compiled from `src/` with the
repo's own `tsc`) against real migration SQL and a real SQLite database, and walks:
lesson picker (canonical/draft/archived/legacy coverage) → homework create
(inheritance, containment, ownership, archived, every 400) → homework update (graded
history preserved, lesson move refused, marks floor, re-tag refusal, cross-teacher 403)
→ quiz create (`timeLimit` persisted, scope containment, archived 409) → question append
(quiz scope ceiling, answer/option validation) → question read (reference counters +
FIXED pins) → question PATCH (frozen-attempt locks, merge re-validation) → question
DELETE (referenced/pinned refusals, free question deleted) → quiz DELETE guards →
admin FIXED-exam creation → **student `/start` + `/submit` time-limit enforcement on the
real clock** (deadline math, late-submit 409, finalisation at the deadline, no banked
time on resume, untimed quiz unaffected) → student homework submission + track
isolation → teacher analytics `trackSplit`.

Notable real-DB assertions: the refused FIXED-pin delete leaves the exam's pin count at
1 and the question row intact; a refused answer-key edit leaves the stored answer `0`,
so the frozen attempt still grades correctly; the expired attempt's `finishedAt` equals
`startedAt + 60s + 30s` (not the late request's time).

## 11. Sandbox limitations (must be re-run where reachable)

* **Prisma engines are unreachable** from this sandbox (`binaries.prisma.sh` TLS), so
  `prisma generate` runs with `PRISMA_*_ENGINE_*=…` overrides and produces JS/types
  only — the client and schema are real, the downloaded query engine is not.
  `next build` additionally requires `SECURITY_HASH_SECRET` (the Phase 20 startup guard
  is intentional and was satisfied with a generated 64-hex secret). The end-to-end
  layer therefore executes the real schema +
  migration SQL + real route handlers through `scripts/lib/sqlite-prisma-lite.mjs`
  (real SQL, throws `UnsupportedQuery` rather than approximating).
* No browser host: RTL/mobile rendering of the new teacher dialogs was not visually
  reviewed (see §12).
* Lint is not clean at the repo level (116 pre-existing errors, mostly
  `react-hooks/set-state-in-effect`); Phase 18 adds none and fixes none — it holds the
  baseline exactly.

## 12. Browser verification checklist (for a browser host)

1. Teacher portal → Quizzes → **New quiz**: the lesson picker lists official lessons
   with `officialCode`/part/unit; select one, confirm the placement line appears.
2. Set a time limit (e.g. 1 minute) + a track scope; save; reopen the card and confirm
   the scope badge and the time limit persist.
3. **Manage questions** → append a question, edit its prompt, try to change a tag on a
   question with an attempt → the lock message appears from the server.
4. Homework → **New homework** on an ARCHIVED lesson → 409 message; on a normal lesson →
   created with inherited scope; edit a graded homework's marks downward → refusal.
5. Student side: open the timed quiz, confirm the countdown renders from
   `attemptWindow`, let it expire, submit → the timeout message, then reload → a fresh
   attempt.

## 13. Files

```
src/lib/teacher-content.ts                     (new — ownership chain, locks, validator, payloads)
src/lib/track-scope.ts                         (+ isTrackScopeWithinLesson, TrackScopeDecision,
                                                resolveContentTrackScope — Phase 12 rules preserved)
src/lib/session-quiz.ts                        (+ time-limit block: grace, normalize, state, gradeExpired)
src/app/api/teacher/homework/route.ts           (canonical both-chain listing + POST create)
src/app/api/teacher/homework/[id]/route.ts      (new — PATCH with history-preserving guards)
src/app/api/teacher/homework/[id]/grade/route.ts (canonical-first ownership fix)
src/app/api/teacher/quizzes/route.ts            (canonical placement, timeLimit, scope, shared stamp)
src/app/api/teacher/quizzes/[id]/route.ts       (new — GET detail + guarded DELETE)
src/app/api/teacher/quizzes/[id]/questions/route.ts (new — additive append)
src/app/api/teacher/questions/[id]/route.ts     (new — GET references / PATCH guard / DELETE guard)
src/app/api/teacher/lessons/route.ts            (canonical picker, archived visible, flat + grouped)
src/app/api/teacher/analytics/route.ts          (+ trackSplit on overview and groups)
src/app/api/quizzes/[id]/route.ts               (+ attemptWindow)
src/app/api/quizzes/[id]/start/route.ts         (+ enforcement: expired → finalised + fresh attempt)
src/app/api/quizzes/[id]/submit/route.ts        (+ pre-grading limit check, 409 TIME_LIMIT_EXCEEDED)
src/components/teacher/teacher-authoring.tsx    (new — picker, dialogs, question manager, badges)
src/components/teacher/teacher-dashboard.tsx    (rewired: picker, dialogs, timeLimit, trackScope)
src/lib/i18n-dict-2026.ts                       (api.233–257, teacher.173–204 — ar+en)
scripts/lib/sqlite-prisma-lite.mjs              (+ compound-unique expansion, nested create —
                                                test-adapter capabilities only, no product code)
scripts/verify-phase18-teacher.mjs              (new — real-DB e2e, 157 assertions)
tests/teacher-workflow-phase18.test.js          (new — 365 assertions)
docs/PHASE_18_TEACHER_WORKFLOW.md               (this file)
worklog.md                                      (Phase 18 entry)
```
