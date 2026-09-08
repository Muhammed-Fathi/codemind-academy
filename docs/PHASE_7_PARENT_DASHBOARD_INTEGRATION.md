# Phase 7 — Parent Dashboard Integration

Status: completed (2026-09-08).

This phase **reviews, hardens and verifies** the Parent Dashboard and the
Parent → Student data-isolation flow on top of the approved Phase 4/5/6
architecture. It does **not** redesign Phase 4 progression, Phase 5 grading,
Phase 6 teacher analytics, or Mock Exams. Only genuine correctness and
authorization defects found during the audit were changed; everything else
was verified and documented.

## Objective

Make the existing Parent Dashboard a secure, accurate, child-isolated,
read-only view of the authoritative Student academic system:

```
Parent → Authenticated Parent → Linked Student → Authorized Student Data
  → Academic Dashboard → Progress → Assignments → Session Quiz Results
  → Mock Exam Results → Attendance → Academic Analytics
```

## Baseline

Latest approved baseline is `main` at `ae6d16f` (Merge PR #23, merged
Phase 6 implementation), verified with `git log` before any change was made.
Working tree was clean; all work was done on the Phase 7 branch.

## Existing Architecture

What already existed before this phase (verified, kept):

- Parent auth: cookie session (`cm_session`) resolved by `getCurrentUser()`,
  plus a `role === "PARENT"` check on every `/api/parents/me/*` route.
- Linking: `Parent` 1—N `ParentStudentLink` N—1 `Student`
  (`@@unique([parentId, studentId])`), created only through the verified
  path (student national ID + student code + parent phone) at registration
  (`POST /api/auth/register`) or afterwards (`POST
  /api/parents/me/link-student`), idempotently.
- Parent APIs take **no** `studentId`/`parentId`/`courseId` input: every row
  is derived from the server-side `Parent.children` links.
- Dashboard UI fetches `/api/parents/me/dashboard` once (all linked
  children) and selects the viewed child with client tabs; analytics and
  reports fetch their own endpoints. No `localStorage`/URL authoritative
  state anywhere in the parent surface.
- Monthly report is built client-side from one dashboard child payload
  (`buildReportData`); the weekly report and analytics render all linked
  children from their own endpoints.
- Teacher analytics (`/api/teacher/analytics`) already aggregate finished
  attempts only and are course-scoped (`attemptInQuizScope`) — untouched.

## Parent Authentication

Unchanged and re-verified: `requireUser()` (401 when anonymous) +
`user.role !== "PARENT"` → 403 on all five `/api/parents/me/*` routes
(dashboard, analytics, weekly-report, link-student, notification-prefs via
the shared user-scoped handler). The edge proxy (`src/proxy.ts`) additionally
rejects cookie-less calls to `/api/parents/*` with 401 before route code runs.

## Parent → Student Linking

Kept as-is except one security fix:

- Rule unchanged: national ID (14 digits) + student code (`CM-XXXXXX`) +
  parent phone must all match the student's registration data; legacy
  email-only linking stays rejected (400).
- Duplicate links stay idempotent (unique pair, `findUnique` guard /
  `upsert` at registration).
- **Fix (enumeration oracle):** a wrong code answered 404 "no student
  matches…" while a right code + wrong phone answered 404 "phone doesn't
  match…", so the two messages confirmed whether a guessed pair is real.
  Both branches now return the **identical** message and status
  (`api.113`/`api.114` same text in `link-student`, `api.073`/`api.074` same
  text at parent registration). Keys are kept (separate call sites); only
  the wording was unified.
- No unlink endpoint exists; none was invented.

## Student Isolation

- The dedicated parent APIs accept no ids, so there is no
  `?studentId=`-style bypass vector by construction. Verified live-in-harness:
  ParentA's payload contains zero Child C bytes and vice versa.
- **Fix (content scope):** `GET /api/courses/[slug]`, `GET /api/lessons/[id]`
  and `GET /api/quizzes/[id]` gated students (enrollment/session) but let
  **any** authenticated parent open **any** course/lesson/quiz — full video &
  PDF URLs, quiz/homework identities, and (per the documented Phase 1 staff
  rule) correct answers. All three routes now call the new
  `isParentAuthorizedForCourse()` (`src/lib/parent-access.ts`): a parent may
  preview only courses in which ≥1 linked child is enrolled (enrollment =
  the same `getEnrollment`/active-group rule the student surface uses).
  Denials: course → 403 + `code: "NOT_ENROLLED"` (slugs are public via the
  catalogue, mirroring the student denial); lesson/quiz → 404 identical to
  "not found" (unguessable ids, existence never confirmed). Teacher/admin
  previews and every student gate are byte-identical in behavior.
- Staff-only (`/api/admin/*`, `/api/teacher/*`), student-only
  (`/api/students/me/*`, `/api/quizzes/*/start|submit|evidence`,
  `/api/exams/*`, `/api/enroll`, lesson progress/video-progress, homework
  submit) and user-scoped (`/api/notifications/*`, notification prefs)
  routes were audited: parents are denied (403/404) or see only their own
  rows. No changes needed there.

## Multiple Children

- Dashboard: one server payload, tab-selected child, every card derived from
  the same `child` object — switching cannot leave stale sections (verified
  by construction; no per-child fetch, no cache).
- **Fix (wrong-child report):** `MonthlyReportView` always rendered
  `children[0]`. It now takes `studentId` (the dashboard passes the active
  tab) through the pure, unit-tested `selectReportChild()` (explicit id →
  match; unknown/omitted → first child; empty → null).
- Analytics view now takes `initialStudentId` so opening it from the
  dashboard no longer resets to child #1 (tab switching still allowed; the
  initial tab is render-derived, no effect).
- Weekly report renders every linked child's section (fresh fetch) —
  unchanged.

## Parent Dashboard

Per-child payload, all server-side from linked-student rows:

- Identity/group/course, course progress, video progress (shared
  `getVideoProgressForStudents` service), attendance + monthly buckets,
  session-quiz stats + recent + trend, **mock-exam stats + recent (new)**,
  **session unlock state from the Phase 4 engine (new)**,
  homework stats + recent, teacher notes, next live session, subscription,
  strong/weak topics, activity timeline.
- Unpublished lessons excluded from the course-lesson denominator (the
  engine excludes them too). The legacy topic chain is kept to match the
  student dashboard's own universe definition (see Limitations).
- Homework `recent[].maxGrade` now honors `Homework.maxMarks` (was hardcoded
  `10`).

## Progress Integration

- `courseProgress` keeps the student-dashboard definition (completed/total
  published course lessons + avg progress) so both surfaces keep agreeing.
- **New `sessionProgress` block** (null when the child is unenrolled):
  `{ total, completed, unlocked, locked, currentLessonId,
  currentLessonTitle }`, computed by calling `getCourseSessionProgress()`
  — the dashboard computes no unlock logic of its own. The UI shows the
  current session title under the progress ring.
- The Phase 4 engine itself is **unmodified** (zero diff in
  `src/lib/session-progress.ts`).

## Quiz Results Integration

Parent quiz numbers now follow the Phase 6 aggregation rule everywhere
(dashboard, analytics, topic stats):

- **Finished attempts only** (`finishedAt != null`). Open (ungraded)
  attempts previously deflated averages and fabricated failures.
- Counts/averages run over the **whole** finished set (the old `take: 20`
  cap silently corrupted `attempts/passed/failed` past 20 attempts); only
  displayed lists are sliced (recent 6, trend 6, analytics trend last 10
  chronological).
- `score/totalMarks/percentage/passed` are the stored server-graded values;
  nothing is recomputed. Retakes stay separate rows; history is never
  overwritten. No grading path was added or touched.

## Mock Exam Integration

- **New read-only `mockExams` block** per child: finished `ExamAttempt`s
  only (`{ attempts, average, best, passed, failed, recent[] }` with the
  linked mock-exam title or "Practice Exam" for ad-hoc exams).
- Strictly separate from session quizzes: neither average can move the
  other (asserted). `ExamAttempt` (JSON snapshot) and
  `QuizAttempt`/`QuizAnswer` stay fully separate models; no mock-exam write
  path was added.

## Attendance

Same source of truth (`Attendance` + `LiveSession`), same rows — but the
counting rule is now uniform: **PRESENT + LATE = attended** on the
dashboard, in analytics (overall + monthly buckets) and in the weekly
report, matching the student dashboard. (Teacher analytics keep their own
pre-existing PRESENT-only rule — untouched.)

## Analytics

`/api/parents/me/analytics` answers "what is happening with my linked
child" per child; it never aggregates across children or courses:

- Finished-only quiz trend (last 10, chronological — previously unordered
  and ungraded-inclusive) + finished-only totals/averages and topic stats.
- **Completion is course-based** (completed ÷ published course lessons;
  previously ÷ existing progress rows, so one finished lesson read as
  "100%"). Same fix in the weekly report's `completionPct`.
- One extra batched lesson-count query per request; still a fixed, small
  number of queries.

## Reports

- Weekly report: finished-only quizzes (as before), LATE-aware attendance,
  course-based completion; per-child sections, never mixed.
- Monthly report: same `buildReportData` + nullable-subscription contract
  (existing 67-assertion suite still green); now covers the **selected**
  child instead of `children[0]`.
- Reports are read-only views of the same records the dashboard shows.

## Security Model

| Caller | Target | Result |
|---|---|---|
| Anonymous | any `/api/parents/*`, content routes | 401 |
| STUDENT | parent APIs | 403 |
| ParentA | own dashboard/analytics/reports | 200, only linked children |
| ParentA | Child C (unlinked) data | absent from every payload |
| ParentA | child's course tree | 200 |
| ParentA | foreign course tree | 403 + `NOT_ENROLLED` |
| ParentA | foreign lesson / quiz | 404 (existence hidden) |
| Parent, no links | dashboard / analytics / reports | 200 with `[]` |
| Parent, no links | any course tree | 403 |
| TEACHER / ADMIN | content previews | 200 (unchanged) |
| STUDENT | own / foreign course | 200 / 403 (unchanged) |
| Any | link with bad triple | 404, message identical for both failure modes |

## Read-Only Guarantees

`dashboard`, `analytics` and `weekly-report` handlers perform no
create/update/upsert/delete — asserted by a write-tracking mock across all
three GETs (0 academic writes). Quiz/answer/progress/homework/attendance/
exam state can only change through the existing student/teacher/admin write
paths, which parents cannot reach (role-gated). `link-student` is the only
parent write path and touches only `ParentStudentLink`.

## Tests

- Baseline before changes: **837 passing** (all 11 suites green).
- Updated `tests/parent-monthly-report.test.js` harness only (added the
  `examAttempt` empty-table stub + `findUnique` on the empty stub for the
  new dashboard queries): **67 passing**.
- New `tests/parent-dashboard-isolation.test.js`: **112 passing**. Real
  compiled handlers + mock Prisma: auth gates, cross-parent isolation,
  finished-only/uncapped quiz stats, LATE attendance, course-based
  completion, mock-exam separation, engine-derived session state, real
  `maxMarks`, linking (verified/idempotent/enumeration-safe), content-scope
  gates incl. unchanged staff/student behavior, read-only tracking, and
  `selectReportChild` units.
- Total: **949 passing, 0 failing**.

## Production Verification

- `tsc --noEmit`: identical to baseline (22 pre-existing errors, all
  "Module '@prisma/client' has no exported member …" from the missing
  generated client — see below; zero new).
- `eslint .`: **78 problems (77 errors, 1 warning), per-file identical to
  baseline** (remaining findings are pre-existing; new code adds none).
- `prisma generate` / `next build` / production startup / live-HTTP matrix
  **could not be executed in this sandbox**: engine downloads from
  `binaries.prisma.sh` fail at TLS (no Prisma engines are vendored), so no
  client can be generated and noDB-backed server can start. Same environment
  limitation Phase 6 documented. Mitigation: every changed handler was
  executed for real (compiled TypeScript, real auth/session/i18n/enrollment/
  progression modules) against a relational mock in the 112-assertion
  suite, including the full 401/403/404/status-code matrix above. Build +
  live-server verification must be re-run where engines are reachable.

## Remaining Limitations

- Legacy-chain universe: parent lesson/homework denominators use the legacy
  `Topic` chain, exactly like the student dashboard. Canonical
  (`unitId`-only) lessons are gated correctly by the Phase 4 engine (and are
  now visible in the parent's engine-derived `sessionProgress` block) but
  are not counted in the legacy `courseProgress.total`. Changing the shared
  universe would alter student/teacher/admin numbers and is out of scope.
- Parent quiz visibility keeps the documented Phase 1 rule (in-scope
  parents see answers); Phase 7 only scoped *which* quizzes/lessons/courses
  a parent may open.
- No unlink endpoint (none existed); no parent quiz-review UI beyond the
  dashboard aggregates; no push/email delivery for reports.

## Deferred Work

- Canonical-chain denominators shared by all dashboards (joint Phase 4
  follow-up, affects every surface).
- Parent quiz-attempt review screen (per-question, from persisted
  `QuizAnswer` rows with the existing visibility rules).
- Daily parent digest / report delivery.
- Re-running `prisma generate`, `next build`, production startup and the
  live-HTTP parent matrix where Prisma engines are reachable.

## Files Changed

- Added: `src/lib/parent-access.ts`,
  `tests/parent-dashboard-isolation.test.js`
- Modified: `src/app/api/courses/[slug]/route.ts`,
  `src/app/api/lessons/[id]/route.ts`, `src/app/api/quizzes/[id]/route.ts`,
  `src/app/api/parents/me/dashboard/route.ts`,
  `src/app/api/parents/me/analytics/route.ts`,
  `src/app/api/parents/me/weekly-report/route.ts`,
  `src/app/api/parents/me/link-student/route.ts` (comment),
  `src/app/api/auth/[action]/route.ts` (comment),
  `src/lib/i18n-dict.ts` (2 message texts),
  `src/components/parent/parent-dashboard.tsx`,
  `src/components/parent/monthly-report.tsx`,
  `src/components/parent/analytics-view.tsx`,
  `tests/parent-monthly-report.test.js` (harness stubs),
  `docs/PROJECT_STATE.md`, this file
- No schema change, no migration, no dependency change, no `.env`/secrets.
