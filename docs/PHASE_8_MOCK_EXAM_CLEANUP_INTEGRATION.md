# Phase 8 — Mock Exam Cleanup & Integration

## Objective

Review, correct, harden, and fully verify the existing Mock Exam
architecture without creating a second system and without redesigning
Phases 4/5/6/7:

```text
Question Bank
      ↓
Session Quiz  →  QuizAttempt / QuizAnswer

Question Bank
      ↓
Mock Exam     →  ExamAttempt
```

The Question Bank may be shared. Attempt lifecycle, grading state, access
rules, and progression effects stay separate.

## Baseline

- `main` HEAD `99b7331` (merge of PR #24, Phase 7), working tree clean.
- All 12 pre-existing suites green before changes (949 assertions total).
- `tsc --noEmit`: 22 pre-existing errors, all "missing generated Prisma
  client" fallout (the sandbox cannot reach `binaries.prisma.sh`) plus
  their downstream `{}`-type noise — byte-identical set to the Phase 7
  baseline, none in mock-exam files.
- ESLint: 78 pre-existing problems (77 errors, 1 warning).

## Existing Architecture

One Mock Exam system, reused as-is:

| Piece | Implementation |
|---|---|
| Definition | `MockExam` (one `schoolType` bank, optional `courseId`, `questionCount`, `durationMin`, `passMark`, `difficulty`, `selectionMode` RANDOM/FIXED, `isPublished`) |
| FIXED pins | `MockExamQuestion` → `Question?` + `ExamQuestion?` + `order` |
| Attempt | `ExamAttempt` with JSON `answers` snapshot, server `score/totalMarks/percentage/passed`, `startedAt/finishedAt` |
| Serve | `GET /api/exams/mock` (practice draft or linked exam) |
| Grade | `POST /api/exams/mock` (creates the finished attempt atomically) |
| Admin | `GET/POST /api/admin/mock-exams`, `PATCH/DELETE /api/admin/mock-exams/[id]` |
| Student UI | `MockExamRunner` (`src/components/student/mock-exam.tsx`) |
| Parent | `mockExams` block in `GET /api/parents/me/dashboard` (finished attempts, separate from quizzes) |
| Teacher | no mock surface (verified; kept as-is) |

### Audit classification

- KEEP AS-IS: `MockExam`/`ExamAttempt`/`MockExamQuestion` models (no
  migration), submit-atomic attempt lifecycle (no server in-progress
  state), server-side re-grading core, bank-filter helper, parent `mockExams`
  block, teacher analytics (already mock-free), display-only timing, unlimited
  retakes, orphan-question exclusion from RANDOM pools (safe direction).
- MODIFY: answer-key disclosure (GET), client selected-index bug, FIXED
  determinism, POST enrollment gate, input clamping/whitelists, linked-exam
  attribution checks, admin combined-pool guards, stale-pin sweep, student
  exam discovery.
- No REFACTOR and no second system.

## Question Sources

Mock exams draw from BOTH tables, always through
`questionBankFilter(studentSchoolType)` (own type OR shared `null`):

- `Question` (session-quiz bank) via `quiz.lessonId`, both curriculum
  chains: canonical `unit → part → course` and legacy
  `topic → unit → part → course`.
- `ExamQuestion` (legacy exam pool) via `lessonId`, same two chains.

Standalone questions (`quizId: null` / `lessonId: null`) are excluded from
RANDOM pools — they carry no course binding, so including them would break
course scoping. They remain usable through FIXED pins (id-addressed). This
is the pre-existing safe direction; Phase 8 documents it instead of
changing pool semantics.

## RANDOM Selection

Contract (unchanged semantics, hardened edges):

- Selection happens server-side per request: difficulty filter (with
  full-pool fallback) → Fisher–Yates shuffle → slice to `count`.
- `count` is clamped to 1–100 (was: unbounded client int); `difficulty`
  and `examType` are whitelisted (unknown → `mixed` / `MOCK`).
- Every request re-samples. There is no server-side in-progress attempt:
  GET mints a draft; POST creates the finished attempt atomically. A
  refresh before submit drafts a fresh set — this is the existing
  lightweight-practice design, now documented rather than redesigned.
- Linked RANDOM exams use the exam's `questionCount`/`difficulty`/
  `durationMin`/`passMark`.

## FIXED Selection

Fixed (was: broken). GET used to shuffle, difficulty-filter, and slice the
pinned set, so a "fixed" exam served a random subset in random order.

Contract now:

- Serve the pinned set AS-IS: every pinned in-bank question, in pinned
  `order`. No difficulty filter, no shuffle, no slicing.
- The exam's `questionCount`/`difficulty` do not alter the set (pins rule).
  A FIXED exam with zero pins (or zero surviving in-bank pins) returns
  `exam: null` with the standard no-questions message — never a crash,
  never foreign-bank padding.
- Verified: 3 refetches byte-identical in id order.

## Attempt Persistence

Submit-atomic by design (unchanged):

- GET creates nothing (write-tracked: zero academic writes across all
  read tests). POST creates exactly one finished `ExamAttempt`
  (`finishedAt` set, immutable JSON snapshot of the graded rows).
- Refresh / navigate away / logout-login before submit discards the
  client-side draft; after submit the attempt is permanent history.
- Retakes are new rows; finished attempts are never overwritten or
  re-graded. Same-student, same-exam attempts accumulate.
- POST is the only `ExamAttempt` writer in the codebase (verified by
  grep + write tracking).

## Server-Side Grading

Unchanged core, extended edges:

- The server re-grades every row from the DB answer key looked up under
  the grading bank filter. Client `isCorrect`/`marks` are always
  overwritten; out-of-bank and unknown ids score 0 with 0 marks.
- The client reports the selected option TEXT (display order is shuffled
  per request, so an index is meaningless). **Bug fixed:** the client used
  to send the shuffled option INDEX, which the server compared against the
  unshuffled key — correctness was coincidental. The client now sends
  `q.options[selected]`, matching the documented server contract.
- POST returns a per-question `review` (`isCorrect`, `marks`,
  `correctText`, `explanation`) — the ONLY post-submit key reveal, feeding
  the result-phase answer review. Out-of-bank rows get nulls.
- POST now enforces the same enrollment gate as GET (was: unenrolled
  students could craft-submit attempts), caps submissions at 200 rows,
  drops non-string ids from the key lookup (grade as unknown, no 500),
  and whitelists `examType`.
- Linked attempts inherit `durationMin`/`passMark` from the exam row;
  free practice echoes a clamped client duration (display-only).

## School-Type Isolation

- Serve path and grading path both filter by the DB-backed
  `Student.schoolType`; shared (`null`) questions serve both banks.
- Linked-exam access requires `exam.schoolType === studentSchoolType`
  (403 otherwise) in GET and in POST attribution.
- POST attribution additionally requires the exam to be published and
  (when course-bound) bound to the student's enrolled course; anything
  else silently falls back to an unlinked practice attempt.
- A student with no school type gets no exam (400) and grades against
  shared-only keys (pre-existing narrowing, kept).
- Verified live-matrix style: ARABIC/LANGUAGE/shared pools, mixed
  submissions (only the in-bank part counts), forged cross-bank ids (0),
  both directions.

## Admin Flow

- List (optional `schoolType` filter) with pin/attempt counts; pool sizes
  per bank; create with title/type/count/duration/passMark/difficulty/
  mode/course; publish toggle; delete (attempts detached, history
  survives — explicit `updateMany` + `delete` in one transaction, pins
  cascade by schema FK).
- **Fixed:** pool-availability guards counted only the `Question` table
  while serving draws from both, so satisfiable exams were rejected. The
  create guard, publish guard, and reported pool sizes now count
  `Question + ExamQuestion` (shared rows count toward both banks).
- **Fixed:** a `schoolType` change swept stale pins only from `Question`
  links; `ExamQuestion` links survived and then silently shorted FIXED
  sets. Both link types are swept now; shared pins survive (SQL `not`
  never matches NULL — asserted behaviourally).
- **Added:** `courseId` is validated at create (unknown id → 400, no
  dangling binding that nobody could open).
- FIXED pins are auto-sampled from the matching bank at create (existing
  mechanism — there is deliberately no pin-management UI in this phase).

## Student Flow

```text
eligible published exam → start → draft (no key) → answer → submit → review
```

- **Added:** `GET /api/students/me/mock-exams` lists published exams of
  the student's bank bound to no course or her own course, with her own
  finished attempt count + best percentage. Previously the `mockExamId`
  plumbing existed server-side but was unreachable from any UI.
- **Added:** the setup phase renders the assigned-exams list (title,
  count, duration, attempts, best) with per-exam Start; submit carries
  `mockExamId` back for attribution.
- Eligibility re-checked at serve time: unpublished → 404, foreign bank
  → 403, foreign course → 404, unenrolled → 400, no school type → 400.
- Refresh-while-answering discards the draft (documented contract);
  double-submit creates two history rows (attempts are history, not
  upserts) — the client disables the button while submitting.

## Teacher Flow

No teacher Mock Exam surface exists (no routes, no UI). Verified that
`GET /api/teacher/analytics` and the quiz-review surfaces reference no
`ExamAttempt`/`MockExam` rows. KEEP AS-IS per the phase rules; documented
here instead of built.

## Parent Flow

KEEP AS-IS (Phase 7, verified intact):

- `GET /api/parents/me/dashboard` accepts no ids; every row derives from
  server-side Parent→Student links (Parent A sees Child A, never
  unlinked Child C; Parent B never sees Child A).
- The `mockExams` block aggregates finished `ExamAttempt`s only, strictly
  separate from session-quiz stats and from Phase 4 session progress.
- Read-only (no `db.*` writes in the handler — asserted).
- Behavioural isolation remains guarded by
  `tests/parent-dashboard-isolation.test.js` (112/112 green).

## Result / Retake Semantics

Unchanged, verified:

- Finished attempts are permanent; a new submit never overwrites.
- Attempts belong to exactly one student and at most one mock exam
  (nullable link; `SetNull` + explicit detach on exam delete).
- Unlimited retakes preserved (no limits invented).
- Score/percentage/passed are server-computed at submit and stored.

## Timing

Display-only (documented contract, no new system):

- The client countdown auto-submits at zero; the server does not track
  start time or enforce elapsed time. `ExamAttempt.durationMin` stores the
  configured duration (exam row for linked attempts, clamped echo for
  practice), not measured time.
- Verified: no open-attempt lookup exists in the mock route (`findFirst`
  absent), so there is nothing to time out server-side.

## Security

Tested against the real handlers (mock Prisma):

- Unauthenticated → 401 on all four mock surfaces.
- TEACHER/PARENT/ADMIN on student routes → 403; STUDENT on admin
  routes → denied.
- Cross-bank exam access → 403 (serve) / silent unlink (submit).
- Cross-course exam access → 404 (existence not confirmed).
- Crafted `isCorrect`/`marks`/`percentage`/`studentId`-style forgery →
  overridden or impossible (student comes from the session).
- Forged `mockExamId` (unknown/unpublished/foreign) → unlinked practice
  attempt, never attribution.
- Oversized (201 rows) and malformed (`12345`, `null`, objects as ids)
  submissions → 400 / graded-as-unknown, never 500, never keyed.
- No key material in GET drafts, list payloads, or error messages
  (localized generic errors only).
- Read-only surfaces tracked: GET exam, student list, admin list —
  zero academic writes.

## Session Quiz Separation

Architectural invariant, verified both directions:

- Mock routes never reference `QuizAttempt`/`QuizAnswer`/`LessonProgress`
  (grep) and behavioral write-tracking shows zero such writes across
  every submit test. Mock exams never unlock sessions (no progression
  writes anywhere in the flow).
- Session-quiz routes (`start`/`submit`) never reference
  `ExamAttempt`/`MockExam` (grep). Session quizzes never alter mock state.
- Teacher analytics and parent quiz stats aggregate `QuizAttempt` only;
  parent `mockExams` aggregates `ExamAttempt` only. The suites for
  Phases 4/5/6/7 all pass unmodified.

## Phase 4/5/6/7 Integration

- Phase 4: progression engine untouched; 144/144 progression tests pass.
- Phase 5: question-bank sharing untouched; grading contract unchanged
  (the client fix aligns the client TO the server, not vice versa);
  70/70 session-quiz + 22/22 grading-isolation tests pass.
- Phase 6: teacher analytics untouched and mock-free; 44/44 pass.
- Phase 7: parent dashboard untouched; 112/112 isolation + 67/67 monthly
  report tests pass.

## Database Changes

None. No migration, no schema edit, no `db:push`/`db:reset`, no history
deletion. All fixes fit the current schema. Exam delete still relies on
the schema `Cascade` for pins (asserted in the migration SQL) plus the
pre-existing explicit detach transaction for attempts.

## Tests

New: `tests/mock-exam-phase8.test.js` — 135 assertions, real route
handlers + in-memory mock Prisma (the Phase 7 offline pattern), covering
the auth matrix, key-free drafts, bank isolation (both banks + shared),
canonical+legacy pools, linked-exam gates, FIXED determinism, server
grading + review, attribution rules, malformed/oversized input,
retake/history semantics, student list scoping, admin guards/sweep/
delete, and cross-phase separation invariants.

Full results after changes (1085 assertions, 0 failures):

| Suite | Result |
|---|---|
| mock-exam-phase8 (new) | 135/135 |
| mock-exam-grading-isolation | 22/22 |
| authorization-invariants | 93/93 |
| session-progression (Ph4) | 144/144 |
| session-quiz (Ph5) | 70/70 |
| quiz-analytics (Ph6) | 44/44 |
| parent-dashboard-isolation (Ph7) | 112/112 |
| parent-monthly-report (Ph7) | 67/67 |
| security-hardening | 243/243 (242 baseline + 1: the suite enumerates every `route.ts` and the new student endpoint passes the own-authorization check) |
| migration-sql | 15/15 |
| registration-validators | 24/24 |
| seed-idempotency | 18/18 |
| platform-upgrade-2026-migration | 98/98 |

- `tsc --noEmit`: 22 errors before and after — the identical pre-existing
  missing-generated-client set; zero in Phase 8 files.
- ESLint: 78 problems (77/1) before and after — byte-identical finding
  set modulo one pre-existing line shift in `mock-exam.tsx`.
- `npm run build`: blocked at `prisma generate` — `binaries.prisma.sh`
  is unreachable from this sandbox (same environmental limitation as
  Phases 6 and 7). Must be re-run where engines are reachable.
- Production startup / live-server checks: blocked by the same cause;
  the executable matrix below ran against the real handlers instead.

## Production Verification

Not claimable from this sandbox (no Prisma engines, no network route to
fetch them). Deploys must re-run: `prisma generate`, `npm run build`,
production startup, and one smoke pass of
`GET /api/students/me/mock-exams` → `GET /api/exams/mock?mockExamId=…` →
`POST /api/exams/mock` before marking Phase 8 production-verified.

## Remaining Limitations

- Timing is display-only (no server enforcement) — a deliberate
  non-requirement, kept.
- No server-side in-progress attempt: refresh-before-submit discards the
  draft. Documented contract, not a bug.
- FIXED pins are auto-sampled at create; no admin UI to curate/re-pin
  questions, and `selectionMode`/`difficulty`/`courseId` are immutable
  after create (PATCH covers title/text/counts/duration/passMark/
  schoolType/publish only).
- Admin pool sizes and guards are bank-global, while RANDOM serving is
  course-scoped: a per-course shortfall still serves a short exam
  gracefully rather than failing.
- No student mock-history endpoint (result shown at submit; history
  visible to parents). No teacher mock-reporting surface.
- Double-submit yields two history rows (by design — attempts are
  append-only history).

## Deferred Work

- Any server-enforced timing (requires an in-progress attempt design —
  explicitly not invented here).
- Admin pin curation UI + `selectionMode` migration path for existing
  exams.
- Student attempt-history endpoint; teacher mock-reporting (if the
  product wants it — Phase 8 prescribes KEEP AS-IS).
- Per-course pool reporting in the admin view.
- Production build/startup/live verification where Prisma engines are
  reachable.
