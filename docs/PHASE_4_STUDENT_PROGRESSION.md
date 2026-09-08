# Phase 4 — Student Learning & Session Progression

## Objective

Make the existing student learning progression **secure, deterministic and
server-enforced** end to end:

```
Student → Subscription/Enrollment → Course → Unit → Session
        → Live Session Link → Session Material → Session Video
        → Video ≥ 95% → Assignment → Session Quiz → Next Session Unlock
```

Review, correct and verify only. No second progression system, no schema
rewrite, no unrelated product work.

## Baseline

| Item | Value |
| --- | --- |
| Branch point | `main` @ `df81de487dccacf72bd400741cf42b08ce861c32` (`df81de4`) |
| Verified how | `git rev-parse main` and `git rev-parse origin/main` — both `df81de487…`; working tree clean |
| Phase | Phase 4 only. Phase 5 not started. |

## Existing Architecture

Everything below was read from the repository, not assumed.

* **Persistence** — Prisma 6.19.2 on SQLite (`prisma/schema.prisma`, 52 tables).
* **Progression source of truth** — `src/lib/session-progress.ts`.
  `getCourseSessionProgress(studentId, courseId)` computes, for every published
  lesson of a course in curriculum order, a `SessionStatusRow`
  (`{ completed, unlocked, video, quiz, assignment }`). `canAccessLesson()`
  is the single authorization entry point for lesson content.
* **Enrollment** — `src/lib/enrollment.ts`. There is an `Enrollment` model in
  the schema but the runtime does **not** use it for access: enrollment is
  `Student.groupId → Group.courseId` with `Group.isActive`. `Subscription.status`
  is deliberately *not* an access gate (documented in that file).
* **Video** — `Lesson.videoUrl` + `LessonProgress`
  (`videoDurationSec / videoWatchedSec / videoPercent / videoCompleted /
  lastHeartbeatAt`). Heartbeat route
  `POST /api/lessons/[id]/video-progress`.
* **Assignment** — `Homework` / `HomeworkSubmission`
  (`@@unique([homeworkId, studentId])`, `status ∈ PENDING|SUBMITTED|GRADED|LATE`).
* **Quiz** — `Quiz` → `Question`; `QuizAttempt` (+ `QuizAnswer`,
  `QuizAttemptEvidence`).
* **Batch session videos** — `SessionVideo` / `SessionVideoView` /
  `MediaAsset`, served through `GET /api/media/[id]`.
* **Edge layer** — `src/proxy.ts` (Next 16 name for middleware): cookie-presence
  401 for protected `/api/*` prefixes. Defense-in-depth only.

## Existing Student Flow (audited, pre-change)

| # | Question | Actual behaviour found |
| --- | --- | --- |
| 1 | How does a student become enrolled? | Admin assigns `Student.groupId` to an active `Group`; `getEnrollment()` derives the course from it. `syncStudentBatch()` lazily attaches the school-type `Batch`. |
| 2 | How is the first available Unit determined? | Not a unit-level concept. Ordering is `Part.order → Unit.order → Topic.order → Lesson.order`; the first row is always unlocked (`previousCompleted = true`). |
| 3 | How is the first Session determined? | First row of that ordering; `currentLessonId` = first `unlocked && !completed`. |
| 4 | How are locked sessions identified? | Strictly sequential: `unlocked[i] = completed[i-1]`, where `completed = videoDone && quizDone && assignmentDone`. A component that does not exist is not required. |
| 5 | How is session content access checked? | `canAccessLesson()` inside `GET /api/lessons/[id]`, `POST .../progress`, `POST .../video-progress`. **Not** in the quiz routes (see P1). |
| 6 | How is the live link exposed? | `LiveSession.meetingUrl` via `/api/students/me/dashboard → nextSession`. It is a **group calendar** item (next upcoming `LiveSession` of the student's group), not gated by lesson progression. Left as-is — see *Remaining Limitations*. |
| 7 | How is the PDF/material exposed? | `Lesson.pdfUrl`, returned by `/api/lessons/[id]` (gated) **and** by `/api/courses/[slug]` for every lesson including locked ones (P2). |
| 8 | How is video access granted? | `Lesson.videoUrl` in the same two responses; batch videos via `/api/students/me/session-videos` gated by `batchId + isPublished`. |
| 9 | How is video progress tracked? | Client heartbeat `{positionSec, durationSec}`; server credits `min(elapsedWallClock, 60s)` since `lastHeartbeatAt`, monotonic, capped by `positionSec` and `durationSec`. |
| 10 | How is 95% computed? | `percent = round(watchedSec/durationSec*100)`; `videoCompleted = already || percent >= 95` (`VIDEO_COMPLETION_THRESHOLD`). |
| 11 | How is assignment completion determined? | `HomeworkSubmission.submittedAt != null`. **Nothing could ever create that row for a student** — the only writer was the teacher grading route (P3). |
| 12 | How is quiz completion determined? | A `QuizAttempt` with `finishedAt != null` for every quiz of the lesson. |
| 13 | How is next-session unlock calculated? | `unlocked[N+1] = completed[N]`, i.e. video **AND** assignment **AND** quiz. Already configuration-free and component-optional; reused unchanged. |

## Problems Found

All five were reproduced against a running **production** build before any code
was changed (see *Manual Verification → Baseline*).

| ID | Severity | Problem |
| --- | --- | --- |
| **P1** | Critical | `GET /api/quizzes/[id]`, `POST .../start`, `POST .../submit` and `POST .../evidence` had **no session gate**. A student could `POST /api/quizzes/<id>/submit` with `{"answers":[]}` for a session two steps ahead. Verified: sessions 2 *and* 3 came back with `requirements.quiz.done = true` while still `locked`, so the quiz gate of every future session could be pre-satisfied without ever opening it — and the submit response returned every correct answer and explanation. |
| **P2** | High | `GET /api/courses/[slug]` returned `videoUrl`, `pdfUrl`, `summary`, `description`, the `quiz` object (id + title) and the `homework` object (id + title + deadline) for **locked** sessions. |
| **P3** | High (functional deadlock) | No student-side homework submission endpoint existed at all (`POST /api/students/me/homework` → **405**). Since `assignmentDone` is one of the three gates, any lesson carrying an assignment could never be completed by the student, so the next session could never unlock. |
| **P4** | Medium | `GET /api/lessons/[id]` returned the full `requirements` status row in its **403** body, disclosing which components a locked session contains. |
| **P5** | Medium | `GET /api/students/me/dashboard` and `GET /api/students/me/homework` ignored gating: `continueLesson` fell back to the *first not-completed* lesson (a locked one) and shipped its `videoUrl`; the homework list returned every assignment of the course with instructions. |

## Access Control

One definition of "may this student open this session":
`canAccessLesson()` in `src/lib/session-progress.ts`. Everything added in this
phase routes through it.

New helpers (same file):

* `canAccessQuiz(studentId, quizId)` → resolves `Quiz.lessonId` → `canAccessLesson`.
* `canAccessHomework(studentId, homeworkId)` → same via `Homework.lessonId`.
* `getUnlockedLessonIds(studentId, courseId)` → one `Set` for list endpoints, so
  a list request costs one progression computation (no N+1).

New uniform denial: `denyProgression(reason, notFoundMessage?)` in
`src/lib/api.ts`.

* `LESSON_NOT_FOUND` → **404**. A resource that does not exist and one that is
  not attached to a verifiable course are indistinguishable, so an id is never
  confirmed to be real.
* `NOT_ENROLLED` / `PREVIOUS_SESSION_INCOMPLETE` → **403** with a
  machine-readable `code`.
* Carries **no** requirement/status metadata. A `null` reason still refuses
  (403) rather than falling open.

## Session Locking

A locked session now exposes exactly: `id`, `title`, `titleAr`, `order`,
`duration`, `isLocked`, `status`, and two **presence booleans**
(`hasQuiz`, `hasAssignment`) so the course tree can keep its badges.

Removed for locked sessions: `videoUrl`, `pdfUrl`, `summary`, `description`,
`quiz`, `homework`, `requirements`, and any non-zero `progress`.

`src/components/course/student-course.tsx` reads `hasQuiz`/`hasAssignment`
(falling back to the old objects, so it is safe either way).

## Video Progress

**Unchanged architecture** — it is sound and was verified rather than replaced:

* credit = `min(wallClockSinceLastHeartbeat, 60s)`;
* `watchedSec` monotonic and capped by `min(previousWatched + credit, positionSec)` and `durationSec`;
* `durationSec <= 0` rejected;
* `videoCompleted` latches and never unsets;
* `POST /api/lessons/[id]/progress` cannot set `isCompleted` unless the video
  rule is already satisfied (both the `completed` flag and the `progress: 100`
  path are guarded).

Verified live: a single heartbeat with `positionSec=3600` credited **0%**;
after 11 s of real elapsed time the same video reached 100%. Four *simultaneous*
heartbeats all reported 0%.

## Assignment Completion

Definition (existing, unchanged): a `HomeworkSubmission` row with
`submittedAt != null`. Opening an assignment never completes it.

Added `POST /api/students/me/homework` (P3):

* `studentId` always comes from the session — never from the body;
* gated by `canAccessHomework`;
* `content` required, trimmed, ≤ 4000 chars;
* sets `SUBMITTED`, or `LATE` when past the deadline. **No grading** — grading
  stays teacher-only;
* an already-`GRADED` submission is immutable (`409`), so a grade cannot be
  reset by re-submitting; a re-submission clears `grade`/`feedback`;
* upsert on `@@unique([homeworkId, studentId])`, so concurrent submits converge
  on one row.

Minimal in-place submit UI added to the existing `HomeworkView`
(`student-dashboard.tsx`), otherwise the endpoint would be unreachable.

## Quiz Completion

Definition (existing, unchanged): a finished `QuizAttempt`
(`finishedAt != null`) for **every** quiz of the lesson. Attempts are always
created with the session's own `studentId`, so one student's attempt can never
satisfy another's requirement.

All four quiz routes now call `canAccessQuiz` before touching content. Answer
and explanation disclosure rules are unchanged (hidden until the student has a
finished attempt; staff always see them). The Question Bank / randomized-quiz
redesign was **not** started.

## Unlock Logic

Reused as-is: `unlocked[N+1] = videoDone && quizDone && assignmentDone` of
session N, strictly sequential, missing components not required. No new
configuration system was introduced.

## Future Content Leakage

Audited response-by-response against a live server, pattern-scanning for the
fixture's protected strings (`cdn.example.invalid`, "Secret summary/description/
instructions", "Secret prompt/explanation", the correct option value):

| Response | Before | After |
| --- | --- | --- |
| `GET /api/courses/[slug]` | video URL, PDF URL, summary, description, quiz+homework ids/titles/deadlines of locked sessions | clean (locked objects serialise to none of them) |
| `GET /api/lessons/{locked}` | 403 + full `requirements` row | 403, keys = `error,code` only |
| `GET /api/quizzes/{locked}` | **200** with questions, prompts, options | 403, clean |
| `POST /api/quizzes/{locked}/submit` | **200** with correct answers + explanations | 403, clean |
| `GET /api/students/me/dashboard` | `continueLesson.videoUrl` of a locked session | clean |
| `GET /api/students/me/homework` | instructions of every assignment in the course | only unlocked sessions |

## Refresh / Login Consistency

The server is the only source of truth — nothing is persisted in React state or
`localStorage`. Verified live:

* re-request (`refresh`): session 2 `current` both times;
* logout → login (new session row, new token): session 2 `current`, session 3
  `locked`;
* the course tree, the dashboard and the lesson route all derive from the same
  `getCourseSessionProgress()` call, so they cannot disagree.

## Edge Cases

* **Simultaneous heartbeats** — 4 parallel beats → all 0%. Watched time is
  derived from server timestamps, not from request ordering.
* **Repeated assignment submission** — 3 concurrent submits → 3× `200`, one row
  (unique pair + upsert).
* **Duplicate quiz start** — 2 parallel `/start` calls returned the **same**
  `attemptId` (`resumed=false` then `true`).
* **Unknown ids** — lesson/quiz → 404, identical for "does not exist" and "not
  in your course".
* **Deactivated group** — `canAccessLesson` → `NOT_ENROLLED` (consistent with
  `getEnrollment`).
* **Empty session** (no video/quiz/assignment) — counts as complete; can never
  lock a student forever.

## Edge Runtime Warning Review

**Carry-over:** `src/instrumentation.ts: process.exit(1) is not supported in the
Edge Runtime`.

**Root cause (confirmed, not assumed).** `src/proxy.ts` (Next 16 middleware)
runs on the Edge runtime, so Next compiles `instrumentation.ts` into *both*
server bundles. `middleware-plugin.js` hooks
`parser.hooks.callMemberChain.for('process')` and warns for any
`process.<member>` call in that layer — `process.env` is the only exemption
(`callee === 'env'`). The single offending statement was the literal
`process.exit(1)`.

**Real problem or bundler noise?** Bundler noise *behaviourally*: the
`process.env.NEXT_RUNTIME !== "nodejs"` guard means the statement cannot execute
in the Edge bundle. But a permanently-ignored warning is how a real one gets
missed, so it was worth removing.

**Fix.** The call now goes through `globalThis`:

```ts
const nodeProcess = (globalThis as { process?: NodeJS.Process }).process;
nodeProcess?.exit?.(1);
```

The member-chain root is `globalThis`, so the Edge bundle contains no direct
Node `process` API call. In the Node runtime `globalThis.process` **is**
`process`.

**Fail-fast preserved — verified:**

* `next build` **without** `SECURITY_HASH_SECRET` → build aborts:
  `[codemind] Refusing to start: production environment is not configured.`
* production server started **without** the secret → logs the same message and
  **exits with code 1**.

**Before/after, same tree, only `src/instrumentation.ts` swapped:**

* original file → `Turbopack build encountered 1 warning: ./src/instrumentation.ts:22:5 … process.exit at line: 22`
* fixed file → **0 warnings**.

## Changes Implemented

| File | Change |
| --- | --- |
| `src/lib/session-progress.ts` | `AccessReason`/`ResourceAccess` types; `canAccessQuiz`, `canAccessHomework`, `getUnlockedLessonIds`. |
| `src/lib/api.ts` | `ProgressionDenial` + `denyProgression()` (uniform 403/404, no metadata leak). |
| `src/app/api/quizzes/[id]/route.ts` | Gate `canAccessQuiz` (P1). |
| `src/app/api/quizzes/[id]/start/route.ts` | Gate `canAccessQuiz` (P1). |
| `src/app/api/quizzes/[id]/submit/route.ts` | Gate `canAccessQuiz` (P1). |
| `src/app/api/quizzes/[id]/evidence/route.ts` | Gate `canAccessQuiz` (defense in depth). |
| `src/app/api/courses/[slug]/route.ts` | Redact locked sessions; add `hasQuiz`/`hasAssignment` (P2). |
| `src/app/api/lessons/[id]/route.ts` | 403 via `denyProgression`, no `requirements` echo (P4). |
| `src/app/api/students/me/dashboard/route.ts` | `continueLesson`/`videoUrl`/`pendingHomework` gated (P5). |
| `src/app/api/students/me/homework/route.ts` | List gated; **new** `POST` submission (P3). |
| `src/components/course/student-course.tsx` | Read presence flags. |
| `src/components/student/student-dashboard.tsx` | `HomeworkSubmitForm`. |
| `src/lib/i18n-dict-2026.ts` | `api.221`–`api.225`, `student.240`–`student.242` (ar + en). |
| `src/instrumentation.ts` | Edge-safe process termination; fail-fast unchanged. |
| `tests/session-progression.test.js` | **New** — 89 assertions. |

No Prisma schema change. No dependency added or upgraded. No `.env`, secret or
generated client committed.

## Tests

New suite `tests/session-progression.test.js`, offline (no DB, no network, no
server), in the existing repository style:

* **Behavioural (layers 1–11)** — `src/lib/session-progress.ts` is compiled with
  `tsc` and run against a fake `@/lib/db` (a `Module._resolveFilename` hook
  redirects the `@/lib/db` alias). This executes the *real* progression
  arithmetic and the *real* access helpers: the AND-rule, the 94%/95% boundary,
  "video only", "video + assignment", "all three unlock", unfinished attempts,
  `canAccessLesson` denial reasons, `canAccessQuiz`/`canAccessHomework`, and the
  empty-session case.
* **Source invariants (layers 12–17)** — every quiz route is gated and denies
  through `denyProgression`; the denial never serialises a status row; the
  course tree redacts all six protected fields; the dashboard and homework list
  are gated; the 95% guards are still present; `instrumentation.ts` has no
  static `process.exit(` in code.

**Negative controls** (each was run by reverting the fix and re-running):

| Reverted | Result |
| --- | --- |
| `src/app/api/quizzes/**` | 12 failures |
| `src/app/api/courses/[slug]/route.ts` | 9 failures |
| `src/instrumentation.ts` | 2 failures |
| restored | **89 passed, 0 failed** |

Full suite:

```
tests/authorization-invariants.test.js         93 passed, 0 failed
tests/migration-sql.test.js                    15 passed, 0 failed
tests/mock-exam-grading-isolation.test.js      22 passed, 0 failed
tests/parent-monthly-report.test.js            67 passed, 0 failed
tests/platform-upgrade-2026-migration.test.js  98 passed, 0 failed
tests/registration-validators.test.js          24 passed, 0 failed
tests/security-hardening.test.js              242 passed, 0 failed
tests/seed-idempotency.test.js                 18 passed, 0 failed
tests/session-progression.test.js              89 passed, 0 failed   (new)
                                             --- 668 passed, 0 failed
```

## Manual Verification

Fixture: one course (`phase4-progression`) → part → unit → topic → 3 published
sessions, each with a video URL, a PDF URL, one quiz (1 question, answer
`opt2`) and one assignment; two students (A, B) in the same active group. Run
against the **production standalone build** on port 3000.

### Baseline (before the fix) — 8 failures

```
FAIL | course listing: no protected content leaked | LEAKED cdn.example.invalid, secret description, secret summary
FAIL | GET /api/quizzes/{locked} denied            | status=200
FAIL | GET /api/quizzes/{locked}: leaked           | secret prompt, opt2
FAIL | POST /api/quizzes/{locked}/start denied     | status=200
FAIL | POST /api/quizzes/{locked}/submit denied    | status=200
FAIL | POST /api/quizzes/{locked}/submit: leaked   | secret prompt, secret explanation, opt2
FAIL | dashboard: no protected content leaked      | cdn.example.invalid
FAIL | homework list: no protected content leaked  | secret instructions
```

plus, by direct probe:

```
submit L2 quiz -> 200   submit L3 quiz -> 200
L2 status=locked quizDone=true    L3 status=locked quizDone=true   ← gate pre-satisfied
POST /api/students/me/homework -> 405                              ← no way to submit
```

### After the fix — 62/62

| Scenario | Result |
| --- | --- |
| **Student A enrolled, first session available** | session 1 `current`, sessions 2–3 `locked`; session 1 exposes its own `videoUrl` |
| Locked session 2 metadata | `videoUrl=null`, `pdfUrl=null`, no summary/description, `quiz=null`, `homework=null`, title + `order=2` retained, `hasQuiz/hasAssignment=true` |
| `GET /api/lessons/{locked}` | 403 `PREVIOUS_SESSION_INCOMPLETE`, body keys `error,code` |
| `GET /api/quizzes/{locked}` | 403, no questions |
| `POST /api/quizzes/{locked}/start` | 403 |
| `POST /api/quizzes/{locked}/submit` | 403, no answers |
| Forged submits on sessions 2 **and** 3 | `s2quiz=undefined s3quiz=undefined` — gate not pre-satisfied |
| `POST /api/lessons/{locked}/video-progress` | 403 |
| `POST /api/lessons/{locked}/progress` | 403 |
| `POST /api/students/me/homework` for a locked session | 403 |
| Anonymous (no cookie) | 401 at the proxy |
| Unknown lesson / quiz id | 404 / 404 |
| **After video only** | `video.done=true`, session 2 **still locked** |
| **After video + assignment** | `assignment.done=true`, `quiz.done=false`, session 2 **still locked** |
| **After video + assignment + quiz** | session 1 `completed`, **session 2 `current`**, session 3 `locked`; session 2's `videoUrl` now present |
| Refresh (re-request) | session 2 `current` |
| Logout → login | session 2 `current`, session 3 `locked` |
| **Student B** | session 1 `current`, session 2 `locked`; cannot read session 2's quiz (403) or open session 2 (403) |
| Cross-student | B submits B's own session-1 quiz → 200; A's state unchanged (`current`); B's session 2 still locked |
| Dashboard / homework list | no session-3 content; homework list = sessions 1,2 only |
| Races | 3 concurrent submits → 200/200/200; 2 concurrent `/start` → same `attemptId`; 4 concurrent heartbeats → 0/0/0/0 |

## Remaining Limitations

1. **Live session link is not progression-gated.** `LiveSession.meetingUrl` is
   exposed on the dashboard as the student's *next scheduled group session*
   (a calendar item). Gating it by lesson progression would change the meaning
   of the group calendar and is a product decision, not a Phase 4 bug.
2. **`Lesson.isLocked` is inert legacy metadata.** It is stored (the curriculum
   seed sets `isLocked = lIdx > 0`) and surfaced to the UI, but nothing enforces
   it — the gate is `getCourseSessionProgress`. It was deliberately **not**
   turned into a hard lock: doing so would permanently lock every seeded lesson
   after the first. Removing the column is a later cleanup.
3. **`Enrollment` / `Subscription` are not access gates**, by pre-existing
   design (documented in `src/lib/enrollment.ts`). Phase 4 kept that contract.
4. **Lessons without a `topic` are unreachable by the gate.** `canAccessLesson`
   returns `LESSON_NOT_FOUND` when a lesson has no `topic → unit → part → course`
   chain. All 39 seeded lessons have a `topicId`, so this is latent, but the
   canonical curriculum uses `Lesson.unitId` — a future phase should widen the
   chain lookup.
5. **Assignment submission is text-only.** `HomeworkSubmission.fileUrl` stays
   null; a student file-upload pipeline (private storage + retention) does not
   exist and was out of scope.
6. **Batch `SessionVideo`s are gated by batch + `isPublished`, not by lesson
   progression.** That is an admin publication decision on a separate delivery
   channel (`SessionVideoView`, not `LessonProgress`), and `getCourseSessionProgress`
   does not consult it. Wiring the two together would create the second
   progression system this phase forbids.

## Deferred Work

* Question Bank redesign, randomized Session Quiz, Mock Exam redesign.
* Teacher analytics, parent dashboard expansion, PDF management redesign,
  calendar fixes, Kodgy redesign.
* SQLite → PostgreSQL.
* `Lesson.isLocked` cleanup and the `topic`/`unitId` chain widening (limitations
  2 and 4).
* Student assignment file uploads (limitation 5).
* Pre-existing lint debt: 44 problems (43 errors, 1 warning), all in
  `tests/*.test.js` (`@typescript-eslint/no-require-imports`) plus one
  React-Compiler memoization notice in `src/components/**`. Unchanged by this
  phase — the count is identical before and after.
