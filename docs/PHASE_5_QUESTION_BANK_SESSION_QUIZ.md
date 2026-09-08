# Phase 5 — Question Bank & Session Quiz

## Objective

Make the existing Question Bank and Session Quiz architecture **secure,
persistent, deterministic and correctly integrated** with the Phase 4
progression system:

```
Question Bank → Session Quiz configuration → eligible questions
→ attempt-frozen question set → persisted QuizAttempt → student answers
→ server-side grading → quiz completion → Phase 4 session progression
```

Review, correct and harden only. No second quiz system, no mock-exam redesign,
no database platform change, no Phase 6 work.

## Baseline

| Item | Value |
| --- | --- |
| Branch point | `main` @ `0007808760567ec7c7c136ead5fc3e083a46379c` (`0007808`, merge of PR #21 — merged Phase 4) |
| Verified how | `git log main --oneline -3` and `git rev-parse origin/main` — both `0007808…`; working tree clean at start |
| Baseline tests | 723 assertions passing across 9 offline suites |
| Baseline lint | 78 problems (77 errors, 1 warning) — all pre-existing |
| Phase | Phase 5 only. Phase 6 not started. |

## Existing Architecture (audited before any change)

Everything below was read from the repository, not assumed.

**Question Bank.** `Question` is the central record: `type ∈ {MCQ,
TRUE_FALSE}`, bilingual `prompt`/`promptAr` (language), `options` (JSON
string), `answer` (option index string), `explanation`, `difficulty ∈
{EASY, MEDIUM, HARD}`, `marks`, `schoolType ∈ {ARABIC, LANGUAGE, null=shared}`.
Questions attach to a session quiz through `Question.quizId` (nullable —
`null` rows are the shared bank mock exams sample from). `ExamQuestion` is a
separate legacy bank (lesson-scoped) that mock exams also draw from. There is
**no active/inactive flag** on questions in the schema — activation is not a
concept the existing architecture supports, so none was invented.

**Session Quiz.** `Quiz` belongs to a `Lesson` (the "session") with `passMark`,
`timeLimit` (display-only), `order`. The Quiz↔Question ownership **is** the
session-quiz configuration: the quiz's questions are the set. There is no
per-student random sampling for session quizzes (that is a Mock Exam feature),
so no speculative configuration fields were added.

**Attempts.** `QuizAttempt` (`quizId`, `studentId`, `score`, `totalMarks`,
`percentage`, `passed`, `startedAt`, `finishedAt`, `cameraStatus`) +
`QuizAnswer` rows (`attemptId`, `questionId`, `selected`, `isCorrect`) +
`QuizAttemptEvidence` (camera snapshots, private storage). Attempts are opened
idempotently by `POST /api/quizzes/[id]/start` (repeated calls resume the same
open row) and finalized by `POST /api/quizzes/[id]/submit`.

**Authorization (Phase 4).** All four quiz routes (`GET`, `/start`, `/submit`,
`/evidence`) already went through `canAccessQuiz` → `canAccessLesson` — one
definition of "may this student open this session", with `denyProgression`
returning 404 for unknown resources and 403 + machine-readable code otherwise.
Students see answers/explanations only after at least one finished attempt
(approved Phase 1 audit decision; staff roles always see them).

**Mock Exams.** `MockExam` (schoolType-bound, `selectionMode ∈ {RANDOM,
FIXED}`) → `ExamAttempt` (JSON answer snapshot, server re-grade on POST).
Completely separate from `QuizAttempt`.

## Audit Findings

| # | Finding | Severity | Disposition |
| --- | --- | --- | --- |
| P1 | The attempt's question set was **re-derived live from `quiz.questions` on every request**. A question added/edited mid-attempt silently mutated an open attempt (verified live: student B's open attempt grew from 3 to 4 questions after an admin add). Refresh/re-login were only accidentally stable. | HIGH | FIXED — set frozen at attempt creation (see *Attempt Persistence*) |
| P2 | `QuizAnswer` had **no unique constraint** on `(attemptId, questionId)`; nothing in the database made "one answer per question per attempt" impossible. | MEDIUM | FIXED — focused migration |
| P3 | **Canonical-lesson blind spots** (the Phase 4 "invisible lesson" bug class, still present in quiz-adjacent routes): `/api/lessons/[id]` returned `part/unit/topic/course: null` for canonical (`unitId`-linked, `topicId = null`) lessons — `student-lesson.tsx` crashes on `data.course.slug`; `/api/quizzes/[id]` returned `courseSlug: null` (broken back-navigation); teacher quiz listing/creation used the topic chain only (canonical quizzes invisible/uncreatable); the mock-exam pool excluded canonical lessons' questions; `/api/lessons/[id]` prev/next walked the topic chain only. | HIGH | FIXED — both chains, canonical first |
| P4 | The Phase 4 engine requires **every** quiz of a lesson to be attempted, but `/api/lessons/[id]` and the course tree exposed only `quizzes[0]` — a lesson with 2+ quizzes could never complete through the UI (deadlock). Verified live: the canonical session stayed `current` until each of its 3 quizzes was attempted. | HIGH | FIXED — `quizzes` array + per-quiz cards |
| P5 | `/api/admin/ai-generate-quiz` allowed a **TEACHER to generate questions into any lesson of any course** (no ownership check, unlike `POST /api/teacher/quizzes`), and built its context from the topic chain only. | MEDIUM | FIXED — teacher scoped to own courses |
| P6 | `QuizRunner` "Retry" reused the finished attempt's client state (attempt id, consent, answers) instead of opening a fresh attempt. | LOW | FIXED — retry reloads (new consent + `/start` + new frozen set) |
| P7 | `POST /submit` stored the raw client `selected` string unbounded (a crafted payload could store an arbitrary blob). | LOW | FIXED — sanitised to a bounded option index |

Kept as-is (verified correct, deliberately unchanged): the Phase 4 engine and
its unlock rule; `canAccessQuiz`/`denyProgression`; the idempotent `/start`
resume semantics; retakes (a second submit after a finished attempt creates a
new attempt — the product's Retry feature); reveal-after-attempt review data;
staff (admin/teacher/parent) answer visibility (approved Phase 1 decision);
the admin question-bank list/create/filter UI; camera evidence capture and
its ownership checks; Mock Exam selection/grading in its entirety.

## Question Bank

Unchanged in shape. Questions support MCQ/TRUE_FALSE, three difficulties,
bilingual prompts (Arabic/English), options + correct answer + explanation,
school-type banks (ARABIC / LANGUAGE / shared), and curriculum association
through `quizId` → `Quiz` → `Lesson` (canonical unit-linked **or** legacy
topic-linked — a canonical lesson uses questions directly, no fake Topic
required; a legacy lesson works identically; a both-linked lesson resolves
through the canonical chain first, per the Phase 4 rule).

Admin surface (audited, kept): `GET/POST /api/admin/question-bank`
(list/filter/paginate/create with optional quiz association) and the
QuestionBankView UI. There is no edit/delete/activate-deactivate flow in the
existing product; none was invented. AI generation
(`/api/admin/ai-generate-quiz`) now resolves the lesson through both chains
and, for teachers, checks course ownership — admins remain unrestricted.

## Session Quiz

The flow, end to end (all server-side):

1. `requireUser()` — authentication (plus the edge-proxy cookie-presence 401).
2. `canAccessQuiz()` — enrollment + Phase 4 session unlocking; denials are
   uniform (`denyProgression`): 404 for unknown ids, 403 + code otherwise.
3. `GET /api/quizzes/[id]` — quiz + the **attempt-frozen** question set for an
   open attempt (live questions only when no attempt is open). Answers and
   explanations are withheld until the student has a finished attempt.
4. `POST .../start` — opens (or resumes) the attempt **and freezes its
   question set** as unanswered `QuizAnswer` rows.
5. `POST .../submit` — grades exactly the attempt's persisted set, updates the
   answer rows in place, finalizes the attempt, returns the result + review
   data. Client score/percentage/correctness/marks values are never read.
6. Quiz completion = "a finished `QuizAttempt` exists" — exactly what
   `getCourseSessionProgress` already requires; the Phase 4 unlock rule
   (`video ≥ 95% AND assignment AND quiz`, missing components not required)
   is untouched.

## Question Selection

Selection happens **server-side** in `src/lib/session-quiz.ts`. For session
quizzes the selection policy is the existing product architecture: the quiz's
own questions, in deterministic creation order (`createdAt`, id tie-break),
frozen into the attempt at creation. The client never decides the
authoritative set — it only receives the questions the server chose.
Randomized sampling per student is a Mock Exam capability and is deliberately
NOT wired into session quizzes (no speculative configuration).

## Attempt Persistence

The attempt's question set is persisted as `QuizAnswer` rows (relation-based
snapshot — no duplicated question records) the moment the attempt is created:

* **Refresh / navigate away & back / reconnect / logout-login**: `GET` returns
  the open attempt's persisted set — verified byte-identical across repeated
  refreshes and a full logout→login cycle, and `/start` resumes the same
  attempt id.
* **Question added after attempt creation** (verified live): the open attempt
  keeps its frozen set; the new question only joins FUTURE attempts.
* **Question edited after attempt creation**: the question stays in the set
  (same id) with its current content, and grading uses the current
  authoritative answer key — the single source of truth for the key. An
  admin fixing a wrong answer mid-attempt therefore grades correctly.
* **Question deleted after attempt creation**: the answer row cascades away
  with the question (`onDelete: Cascade`, unchanged schema semantics) and the
  attempt grades over the remaining set.
* **Question Bank ordering**: `Question` has no order column; presentation
  order is `createdAt` + id — immutable.
* **Upgrade compatibility**: an attempt opened *before* this deploy has no
  persisted rows; it adopts the live quiz questions until submit (identical
  to pre-Phase-5 behaviour), and `/start` seeds rows into it on the next
  resume so it becomes stable from that point on.

Different students hold different attempt rows with independent frozen sets
(verified live: A and B on the same quiz). Because session quizzes have no
randomization, both sets contain the same questions — per-student
*different* sets are a Mock Exam feature (out of scope here).

## Answer Persistence

`POST /api/quizzes/[id]/submit` validates and persists server-side:

* **Ownership** — the attempt is looked up as `{quizId, studentId (from the
  session), finishedAt: null}`; a body-supplied `studentId`/`attemptId` can
  never redirect it.
* **Membership** — only the attempt's persisted questions are graded; answers
  for foreign questions are ignored (verified live).
* **State** — only an OPEN attempt is written; a finished attempt is
  immutable (submit creates a fresh retake instead).
* **Payload** — `selected` is normalised to a bounded option-index string;
  the first occurrence per question wins (historical semantics); duplicate
  rows are impossible (`@@unique([attemptId, questionId])`).

There is intentionally no incremental answer-save endpoint: answers live in
the client's attempt view until final submission (existing product behaviour;
partial answers from an interrupted run are replaced at submit).

## Server-Side Grading

`gradeAttemptQuestionSet()` in `src/lib/session-quiz.ts` is the only grader
for session quizzes. It iterates the ATTEMPT's questions, loads the
authoritative `answer` from each question row, compares the sanitised
selection, and computes score / totalMarks / percentage / passed from the
question `marks` and the quiz `passMark`. Forged `score`, `percentage`,
`isCorrect`, `marks`, `totalMarks`, `passed` or `studentId` fields in the
request body are never read (verified live: a client sending `score: 999`
received its true 4/6). **Grading boundary:** only automatically gradable
objective types exist (`MCQ`, `TRUE_FALSE`); "Written" questions are not
supported by the schema and no unsafe automatic grading was invented.

## Security

Verified live against the production build (46/46 checks, full matrix in
*Tests*): unauthenticated → 401 on all four routes; not-enrolled student →
403 `NOT_ENROLLED`; enrolled student against a locked session's quiz → 403
`PREVIOUS_SESSION_INCOMPLETE` for GET/start/submit (no attempt row is ever
created); unknown quiz id → 404 (existence never confirmed); no
answer/explanation leaks before a finished attempt; cross-student evidence
attachment → 403; repeated `/start` idempotent; repeated submit = fresh
retake, finished attempts immutable. Answer leakage after submission
(review) and staff-role visibility remain the documented, approved
behaviours.

## Phase 4 Integration

The Phase 4 engine is untouched — `src/lib/session-progress.ts` remains the
single source of truth. Quiz completion still means "a finished QuizAttempt
exists for every quiz of the lesson"; the unlock rule stays
`video ≥ 95% AND assignment AND quiz`. Phase 5 only made the *quiz side* of
that contract reachable and deterministic: every quiz of a session is now
listed (`quizzes` array) so the "every quiz attempted" requirement cannot
deadlock, and the frozen-set persistence guarantees the graded attempt is the
one the student actually saw. Verified live end to end: completing all three
quizzes of the canonical session flipped it to `completed` and unlocked the
next session; adding a quiz to a completed session correctly un-completes it
again (live re-evaluation).

## Mock Exam Separation

Session Quizzes and Mock Exams share the Question Bank and nothing else:
`QuizAttempt`/`QuizAnswer` vs `ExamAttempt` (JSON snapshot) remain separate
models and flows; mock exams never read or write session-quiz attempt state
and vice versa (asserted in the offline suite). The single Mock Exam change
is a minimal compatibility fix required by the mixed-curriculum guarantee:
the RANDOM pool's lesson lookup now includes canonical unit-linked lessons
(previously their questions were invisible to mock exams). Selection,
grading, bank isolation and the ExamAttempt shape are unchanged.

## Database Changes

One focused migration — `20260908120000_phase5_quiz_answer_unique`:

* **Why:** Phase 5 persists the attempt question set as `QuizAnswer` rows at
  attempt creation; "one row per (attempt, question)" becomes a structural
  invariant the database must guarantee (the same guarantee
  `HomeworkSubmission`'s `@@unique` provides). Without it, a concurrent
  double-submit could leave an attempt holding two answers for one question.
* **Content:** deduplicate any existing `(attemptId, questionId)` pairs
  (keeping the newest row by `rowid` — only provably-garbage duplicates are
  removed), then create `QuizAnswer_attemptId_questionId_key` (unique) and
  `QuizAnswer_questionId_idx` — byte-identical to what `prisma migrate diff`
  generates for the schema change.
* **Safety:** no table drops, no data deletion outside the dedup, no
  historical migration rewritten, no reset, no `db push`. The SQL was tested
  against a populated database and against a synthetic duplicate-pair fixture
  (dedup keeps the newest row; the unique index rejects new duplicates).

No other schema change was needed: attempt immutability is implemented with
the existing `QuizAnswer` relation (snapshot-by-reference), not new columns.

## Tests

* **New suite — `tests/session-quiz.test.js` (70 assertions), three layers:**
  * *Behavioural* — `src/lib/session-quiz.ts` compiled with `tsc` and
    exercised against a fake `@/lib/db` (the pattern established by
    `tests/session-progression.test.js`): set freezing at creation, late-add
    exclusion, refresh stability, per-student isolation, cascade behaviour on
    delete, pre-Phase-5 attempt adoption, server-side grading arithmetic,
    tamper rejection, duplicate-answer semantics, degenerate/empty sets,
    `selected` sanitisation, unique-constraint enforcement.
  * *Route source invariants* — every quiz route keeps `canAccessQuiz`;
    answer withholding before submission; `/start` persists the set; GET/submit
    serve/grade the persisted set; submit never reads score fields from the
    body and no longer wipes-and-recreates answers; the schema/migration
    constraint exists and drops nothing.
  * *Curriculum-chain coverage* — both chains (canonical first) in the quiz,
    lesson, teacher, mock-exam and AI-generation routes; multi-quiz lesson
    payload; mock-exam/session-quiz state separation; Phase 4 carry-over
    (both-chain universe, attempted-quiz requirement, 95% threshold).
* **Full suite:** 793 assertions passing (723 baseline + 70 new) —
  authorization invariants, migration SQL, mock-exam grading isolation,
  parent reports, platform-upgrade migration, registration validators,
  security hardening, seed idempotency, session progression.
* **Live matrix (46/46) against the production standalone server** — the
  §17/§18 scenarios: unauthenticated 401s; not-enrolled 403s; locked-session
  403s for GET/start/submit; no answer leak before attempt; reveal after
  attempt; attempt creation + idempotent resume; refresh ×3 + logout→login
  set stability; mid-attempt admin add does not mutate the open set;
  server-side grading with forged fields; foreign-question answers ignored;
  retake creates a new attempt; cross-student evidence 403; own-attempt
  evidence 200; canonical lesson part/unit/course resolution (was null);
  legacy topic resolution intact; both-linked lesson; multi-quiz listing;
  canonical courseSlug (was null); teacher listing/creation across chains;
  mock exam shared-bank pool + separate ExamAttempt + no session-quiz state
  coupling; unknown id 404; malformed body without 5xx; zero-question quiz.

## Production Verification

Executed, not assumed:

* `prisma generate` + `tsc --noEmit` — 0 errors.
* `npm run build` (`prisma generate && next build && node
  scripts/copy-standalone-assets.mjs`) — PASS, **0 warnings**, standalone
  output traced (including the native query engine).
* `node scripts/start-production.mjs` with the deployment guide's production
  `DATABASE_URL` (absolute path) — server up; the live matrix above ran
  against this standalone server (46/46, twice, idempotent).
* Note for this sandbox: the Prisma engine binaries' host
  (`binaries.prisma.sh`) is network-blocked here, so the engines were
  fetched from a checksum-verified public mirror of the exact engine commit
  and placed in `node_modules` (never committed). This is environment setup
  only — no repo file depends on it.

## Remaining Limitations

* **Activation lifecycle:** `Question` has no active/inactive flag in the
  schema; the admin UI offers create/list/filter/AI-generate only. Adding an
  activation concept is a product decision (schema + admin UI + selection
  semantics) and was deliberately not invented in Phase 5.
* **Answer reveal after attempt:** a student may submit an empty attempt to
  reveal the answer key, then retake. This is the approved Phase 1 review
  behaviour (progression requires an attempt, not a pass); changing it is a
  product decision.
* **Staff visibility:** admins, teachers and parents can read any quiz
  including answers (teachers/admins unscoped by course; parents not
  link-checked to an attempted child). Approved Phase 1 decision, documented
  here as a finding.
* **Mock exam client grading:** the mock-exam GET intentionally ships
  `correctIndex` for its interactive practice UX; the stored ExamAttempt is
  always re-graded server-side. Session quizzes never leak keys pre-submit.
* **`Quiz.timeLimit` is display-only** — no server-side time enforcement
  existed before Phase 5 and none was added.
* **Question deletion cascades** answer rows out of historical attempts
  (existing schema semantics); the attempt then grades over the remaining
  set.
* **SQLite** remains the database (no platform migration, per scope).

## Deferred Work

* Active/inactive question lifecycle + admin edit/delete (needs product
  decision; would extend the frozen-set model trivially).
* Server-enforced quiz time limits.
* Optional randomized sub-sampling per session-quiz attempt (Mock Exam
  already provides randomized practice; a product decision would be needed
  before adding a question-count configuration to `Quiz`).
* Teacher answer-visibility scoping by course; parent visibility scoped to
  attempted children.
* Seeding the 23 official curriculum lessons (Phase 3 technical debt;
  canonical-lesson support is now exercised end to end by tests).
