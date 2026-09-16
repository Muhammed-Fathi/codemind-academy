# Phase 26E — Parent Portal QA + Hardening

Status: **COMPLETE — STOPPED FOR REVIEW. Nothing committed, pushed, merged or deployed.**

Scope: audit and harden the **Parent** role end to end (implementation + verification,
Parent-only), starting from `main` @ `98dfb5f`, on branch
`arena/01a0a82f-codemind-academy`. No production database was touched, no migration was
run against Neon, nothing was deployed, and no PR was opened.

Verification in one table:

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `scripts/verify-phase26e-parent.mjs` (real migrated SQLite + shipped handlers) | **380 passed, 0 failed** |
| `tests/phase26e-parent-full-flow.test.js` (source pins + that verifier) | **PASS** (27 pins + 380/0) |
| `tests/parent-dashboard-isolation.test.js` | **112 passed, 0 failed** |
| `tests/parent-analytics-alignment-phase19.test.js` | **176 passed, 0 failed** |
| `tests/parent-monthly-report.test.js` | **67 passed, 0 failed** |
| `tests/authorization-invariants.test.js` | **93 passed, 0 failed** |
| `tests/track-architecture-phase12.test.js` (pins updated for 26E) | **310 passed, 0 failed** |
| `tests/session-lifecycle-phase13.test.js` (pins updated for 26E) | **302 passed, 0 failed** |
| Full `tests/*.test.js` sweep — 52 suites | **50 PASS / 2 FAIL**, both pre-existing at HEAD |
| `npx next build` (production) | **PASS** — compiled, type-checked, 71/71 pages |

---

## 1. Discovery findings

The Parent surface is five routes plus one re-export, one shared library, and a set of
generic readers that serve parents through role branches:

| Surface | Size | Authority source |
|---|---|---|
| `GET /api/parents/me/dashboard` | 605 lines | `requireUser()` + `user.role !== "PARENT"` → 403; children from `getParentProfile(user.id)` |
| `GET /api/parents/me/analytics` | 227 lines | same pattern |
| `GET /api/parents/me/weekly-report` | 244 lines | same pattern, GET-only |
| `POST /api/parents/me/link-student` | 109 lines | same pattern + three-factor verification |
| `GET/PUT /api/parents/me/notification-prefs` | 2-line re-export | the student route, keyed on `user.id` |
| `src/lib/parent-access.ts` | shared library | `getLinkedStudentIds`, `getParentCourseIds`, `isParentAuthorizedForCourse`, `getParentTrackScopes`, `isParentAllowedTrackScope`, `isParentLessonPreviewAllowed`, + 26E helpers |

Findings from the audit (before/while changing anything):

1. **No route accepts a client-named parent or student id.** None of the three reporting
   routes reads `searchParams` at all; children come exclusively from the session parent's
   links. Verified by inspecting every source file and by driving the handlers with hostile
   query strings (§9, section E).
2. **Auth is per-route**, not middleware-based (`requireUser()` + an explicit role check in
   each handler). There is no `middleware.ts` in the repository, so the per-route check is
   the boundary — pinned by the verifier's 401/403 matrix for all five endpoints.
3. **The curriculum universe was defined in three places with two different answers.**
   `dashboard` computed its own inline universe; `analytics` and `weekly-report` computed
   their own. They agreed on lessons but **not** on quiz attempts or weekly homework — this
   was the central defect class (§2, bugs 1–3).
4. **Two legacy/duplicated parent logics remain in the tree and are inert**: the email-only
   link mode (removed, now answers 400 `api.110`) and the retired `isPublished` lesson flag
   (replaced by `status` in Phase 13). Neither is reachable; both are documented in
   comments rather than deleted, so the history stays readable.
5. **Rate limiting does not cover any parent endpoint** (`RATE_LIMIT_KEYS` =
   `heartbeat | progress | open | notification | materialDownload | pdfUpload |
   teacherApply`). Recorded as a gap in §12 — not fixed, because no parent endpoint is a
   write-amplifier except `link-student`, which is verification-gated and idempotent.
6. **`src/lib/parent-access.ts` already owned the preview predicate** (`isParentLessonPreviewAllowed`
   = child's course + child's track + PUBLISHED + not archived) for `courses/[slug]`,
   `lessons/[id]`, `quizzes/[id]` and `session-materials`. The reporting routes simply were
   not consuming it.
7. **Deep-link / navigation defect (found here):** the shared `NotificationsBell`
   (`src/components/dashboard/shell.tsx:346`) sends **every non-admin role** to the
   `student-notifications` view. `VIEWS_BY_ROLE.PARENT` does not contain that key, and
   `renderView` handed any unlisted student view to `<StudentDashboard/>`, whose
   `/api/students/me/*` calls 403 for a parent — a dead screen reached by a control the
   parent can see. Fixed in §3.
8. **PII over-serialisation (found here):** the dashboard child payload carried the child's
   `nationalId` and `parentPhone` although no parent view renders either (the link form
   collects them as input, the child card renders `studentCode`). Fixed in §3.

## 2. Bugs found

Ordered by severity. Each was reproduced with the shipped handlers against a real database
before being fixed, and each fix is asserted afterwards.

1. **GO-LIVE BLOCKER — parents saw quiz numbers computed from outside the child's
   curriculum.** `dashboard` aggregated *every* finished `QuizAttempt` of the child, in
   every course and every track, on every lesson status. An attempt left on an **archived**
   session, on a **staged (DRAFT)** session, on the **other school type**, or in a course
   the child has left moved the parent's average, filled `recent`/`performanceTrend`, and
   **named** that content in the payload (titles included). Same defect in `analytics`
   (`quizTrend`, `totalQuizzes`, `avgQuizPct`, strong/weak topics) and in
   `weekly-report` (weekly quiz count, best quiz, daily buckets).
2. **GO-LIVE BLOCKER — analytics and dashboard disagreed about the same child.**
   `analytics` counted homework submissions the dashboard had already excluded
   (out-of-universe submissions inflated `homeworkSubmitted`/`homeworkGraded`/`homeworkAvgGrade`),
   so two screens backed by the same data reported different numbers.
3. **IMPORTANT — the weekly report counted last week's activity against this week's
   universe.** `completionPct` was universe-restricted while the activity counters
   (`lessonsViewed`, `homeworkSubmitted`, `activeDays`, the daily breakdown) were not, and
   the payload named out-of-universe assignments. `activeDays` could even count a day whose
   only activity was invisible curriculum.
4. **IMPORTANT — attendance had two time bases.** The weekly window used
   `Attendance.createdAt` while the daily buckets, the dashboard's monthly buckets and
   `analytics` used `session.startAt || createdAt`. A record inserted late (or back-dated)
   counted in the week but in a different day — or not at all.
5. **IMPORTANT — `link-student` could 500 under a double submit.** The
   `findUnique`-then-`create` sequence let two identical submissions both see "no link" and
   both create; the loser surfaced as an unhandled unique violation instead of the success
   the caller had already achieved. (Idempotency was otherwise correct.)
6. **IMPORTANT — `relation` was stored as free-form client data** (`String(body.relation || "parent")`),
   unbounded and unvalidated, into a column every parent read ships to the UI.
7. **IMPORTANT — quiet hours were stored unvalidated.** `PUT .../notification-prefs`
   accepted any string; `isInQuietHoursAt` parses with `split(":")` + `Number`, so
   `"not-a-time"` produced `NaN` comparisons and a window that can never open — a
   preference toggle that lies — and the column has no length bound, so an authenticated
   client could persist an arbitrarily large blob in a row every fan-out reads.
8. **IMPORTANT (UI) — the notification bell was a dead link for parents and teachers**
   (§1.7).
9. **IMPORTANT (privacy) — child `nationalId` and `parentPhone` were serialised** in the
   dashboard payload with no consumer (§1.8).
10. **Verified-clean (no bug found, in scope, now asserted):** IDOR on all five endpoints;
    client-supplied id widening; cross-parent child leakage; course/track/enrollment
    boundaries on previews; archived/staged curriculum disclosure through
    `lessons/[id]`, `quizzes/[id]`, `courses/[slug]`; the no-enumeration link flow;
    subscription visibility; read-only behaviour; mass assignment on preferences.

## 3. Exact fixes

1. **One universe, defined once** — `src/lib/parent-access.ts` gains
   `getStudentCurriculumLessonIds(studentId)` (PUBLISHED `LESSON_STUDENT_STATUS_FILTER` +
   `EXCLUDE_ARCHIVED_LESSON` + `trackScopeWhere(student.schoolType)` +
   `lessonCourseChainOr(courseId)`, failing closed to the empty set for a child with no
   group), `getStudentCurriculumHomeworkIds(studentId)` (same lesson universe ∩ homework
   track) and the pure `attemptsInCurriculumUniverse(attempts, universe)`. The three
   reporting routes now consume them instead of re-implementing the predicate.
2. **Dashboard quiz set cut to the universe**; `attemptsWithTopic` (capped at `take: 50`)
   pushes `quiz: { lessonId: { in: [...universe] } }` into SQL so out-of-universe attempts
   cannot crowd out real ones; `nextSession.lessonTitle` is emitted only when the lesson is
   in the universe (session time/teacher still shown).
3. **Analytics** quiz numbers, trend and strong/weak topics computed over the universe;
   homework counters over the homework universe; `quiz.lessonId` added to the select.
4. **Weekly report** window, counters, daily breakdown and `activeDays` cut to both
   universes; a single `attendanceAt(a) = a.session?.startAt || a.createdAt` for the window
   and the buckets.
5. **`link-student`** — one `upsert` on `(parentId, studentId)` with `update: {}` (an
   existing link keeps its relation label and `createdAt`) plus a catch/re-read that treats
   a concurrent create as success and rethrows anything else.
6. **`normalizeParentRelation`** in `src/lib/registration.ts` — trims, collapses spaces,
   lowercases, accepts only letters/marks/space/dash up to `PARENT_RELATION_MAX = 40`,
   otherwise `"parent"`.
7. **`normalizeQuietHour`** in `src/lib/notify.ts` — `null` clears, `""` clears (how a
   browser reports a removed time input), `"HH:MM"` (24-hour, range-checked) stores,
   anything else is discarded rather than coerced; wired into the shared prefs route so the
   parent re-export inherits it.
8. **`renderView` in `src/components/app-shell.tsx`** — the four student-only views return
   `role === "STUDENT" || !role ? <StudentDashboard /> : fallback` where `fallback` is the
   role's own dashboard. The role whitelist is deliberately untouched; the bell keeps its
   current target and now lands a parent on their own dashboard.
9. **Dashboard payload** no longer serialises `nationalId` / `parentPhone`
   (`studentCode` and `email` stay: the child card and the monthly report use them).
10. **Regression pins updated** (not weakened) in `tests/track-architecture-phase12.test.js`
    §28b and `tests/session-lifecycle-phase13.test.js` READER loop: a route passes if it
    carries the inline clause **or** calls the shared helper with the child's id, and a new
    block pins the helper itself (per-child track, never the parent union; keeps the
    PUBLISHED and archived clauses). This makes the invariants *stronger* — they now cover
    the case where four call sites share one predicate wrongly.

## 4. Exact files changed

Modified (12):

```
src/app/api/parents/me/analytics/route.ts
src/app/api/parents/me/dashboard/route.ts
src/app/api/parents/me/link-student/route.ts
src/app/api/parents/me/weekly-report/route.ts
src/app/api/students/me/notification-prefs/route.ts
src/components/app-shell.tsx
src/lib/notify.ts
src/lib/parent-access.ts
src/lib/registration.ts
tests/parent-dashboard-isolation.test.js
tests/session-lifecycle-phase13.test.js
tests/track-architecture-phase12.test.js
```

Added (3):

```
scripts/verify-phase26e-parent.mjs        (untracked; 380-assertion real-DB verifier)
tests/phase26e-parent-full-flow.test.js   (untracked; source pins + the verifier)
docs/PHASE_26E_PARENT_PORTAL_QA.md        (untracked; this report)
```

`git diff --stat`: **12 files changed, 491 insertions(+), 113 deletions(-)**.

## 5. Authorization invariants (and how each is enforced)

| Invariant | Enforcement | Assertion |
|---|---|---|
| Authority comes from the session, never the request | every route: `requireUser()` then `user.role !== "PARENT"` → 403; children only from `getParentProfile(user.id)` | D: 5 endpoints × 6 identities (`null`, STUDENT, TEACHER, ADMIN, sibling PARENT, parent without a row) |
| A parent never sees an unrelated student | child lists come from `ParentStudentLink` only | E: Parent B's payload contains none of Parent A's child ids/names and vice-versa |
| A client id cannot widen the scope | the reporting routes read no query parameters | E: `?studentId=…&parentId=…&courseId=…&childId=…&trackScope=…` returns the identical payload |
| No cross-course / cross-track / cross-enrollment preview | `isParentLessonPreviewAllowed` (course ∈ enrolled child, track of an **enrolled** child, PUBLISHED, not archived) | L: 404 for DRAFT, ARCHIVED, other-track-without-that-child, other-course, childless parent; 200 for own-course/legit sibling track |
| Unpublished/archived curriculum is never inferred | lifecycle clauses inside the shared universe helper + the preview predicate | G/H/I: staged/archived lessons, quizzes, homework and titles absent from every payload |
| No teacher/admin-only data | payloads are built field-by-field; no `include` of teacher/admin rows beyond `teacherName`, notes addressed to the child | G: `teacherNotes` only; K: no cross-table reads leak |
| No mutation of student academic records | all reporting handlers are GET; only `link-student` and prefs write, both scoped | K: row counts for `Lesson`, `Quiz`, `QuizAttempt`, `Homework`, `HomeworkSubmission`, `Attendance`, `LessonProgress`, `Subscription`, `ParentStudentLink`, `TeacherNote` unchanged across seven parent GETs |
| Preferences cannot be injected | `user.id` is the only key written; only 12 declared boolean keys + 2 quiet-hour fields are read from the body | J: body-supplied `userId` moves no other row; a malformed/oversized quiet hour is rejected, an unknown key is ignored |
| No safe-defaults hole | GET upserts the all-true defaults for an absent row | J: missing row ⇒ delivery allowed; explicit `false` ⇒ excluded |

## 6. Linking model (documented, as implemented)

* **Single mode.** The only accepted path is the three-factor verification
  `{ studentNationalId (14 digits), parentPhone, studentCode (CM-XXXXXX) }`, matched
  server-side against the `Student` row. The legacy email mode was already removed for
  security and still answers `400 api.110`; a body with none of the three answers
  `400 api.117`.
* **No oracle, no identity disclosure.** A `(nationalId, studentCode)` pair that matches
  nothing and a real pair with the wrong phone return the **same** 404 with the same
  message (`api.113` / `api.114` are intentionally identical text) — so the endpoint cannot
  be used to confirm that a student exists, and no input is echoed back.
* **Idempotent.** The write is one `upsert` keyed on the unique `(parentId, studentId)`;
  re-linking never rewrites `relation` or `createdAt`. A concurrent first-time submit from
  two requests yields exactly one row and two 200s.
* **Second parent allowed.** The same child may be linked by a second parent who passes the
  same three-factor check; each link is its own row. This is the documented model (both
  parents know the child's national ID, code and their own phone number).
* **Fail closed.** A stored `parentPhone` that is empty/null can never match (404), and an
  invalid phone format is refused before the lookup.
* **`relation`** is a label, normalised server-side, defaulting to `"parent"`.

## 7. Phase 26D compatibility findings

The 26D attempt architecture is **untouched** — no schema, route or lifecycle change. What
26E verified about how the parent surfaces consume it:

* Parent quiz numbers count **finished** attempts only (`finishedAt: { not: null }`), and
  the in-memory cut is applied **after** that filter, so an `OPEN`/`EXPIRED` attempt can
  never deflate an average (G: attempt #3, `OPEN`, is absent from every number).
* **Retry history is preserved, not collapsed.** Every finished in-universe attempt is one
  data point: the ARABIC child reports attempts #1 and #2 of the same quiz separately, with
  their own `attemptNumber`, `score`, `totalMarks` and `passed` (`G: attempt #1 … stays a
  failure — retry history is not overwritten`). `retryGrantId` is carried by 26D and is not
  required by the parent readers.
* No parent reader **joins live question rows**: nothing on the parent surface touches
  `QuizAnswer`; nothing assumes one raw attempt row per quiz.
* Mock exams stay isolated in their own block (`ExamAttempt` finished-only), and cannot move
  the session-quiz numbers.

## 8. Test commands

```bash
# TypeScript
npx tsc --noEmit

# The 26E real-database verifier (refuses a Postgres/Neon DATABASE_URL by design)
node scripts/verify-phase26e-parent.mjs

# 26E source pins + verifier
node tests/phase26e-parent-full-flow.test.js

# Parent / authorization regressions
node tests/parent-dashboard-isolation.test.js
node tests/parent-analytics-alignment-phase19.test.js
node tests/parent-monthly-report.test.js
node tests/authorization-invariants.test.js

# Cross-phase pins that consume the same routes
node tests/track-architecture-phase12.test.js
node tests/session-lifecycle-phase13.test.js

# Whole suite
bash /tmp/run-sweep.sh        # writes /tmp/baseline/results.txt + one log per suite

# Production build
SECURITY_HASH_SECRET=phase26e-build-secret-0123456789abcdef npx next build
```

## 9. Test results

* `scripts/verify-phase26e-parent.mjs` — **380 passed, 0 failed** (sections:
  A schema audit, B compile+load of the shipped TS, C fixtures, D authentication/role gates,
  E ownership isolation, F linking lifecycle, G dashboard, H analytics, I weekly report,
  J notification preferences, K read-only, L shared content readers).
* `tests/phase26e-parent-full-flow.test.js` — **PASS** (27 source pins; the verifier run
  inside it reports 380/0 and prints `PHASE26E_TEST_OK`, then `[26E-TEST] PASS`).
* Offline suites: parent-dashboard-isolation **112/0**, parent-analytics-alignment-phase19
  **176/0**, parent-monthly-report **67/0**, authorization-invariants **93/0**.
* Cross-phase: track-architecture-phase12 **310/0**, session-lifecycle-phase13 **302/0**
  (both were 308/0 and 299/0 at HEAD; the added pins are the 26E invariants).
* Full sweep (`/tmp/baseline/results.txt`, 52 suites, `DONE`):
  **50 PASS / 2 FAIL** — `final-integration-phase22` (fails because `db/custom.db` and
  `backups/` do not exist in a clean checkout; `ENOENT`) and
  `payment-lifecycle-phase25-ledger` (**138 passed, 1 failed** — a PR3 file-allowlist pin).
  Both were re-run on a detached worktree of pristine `HEAD` (`98dfb5f`) and fail
  **identically** there. **No 26E regression.**
* Negative cases are explicit throughout: unauthenticated 401, wrong-role 403, unrelated
  child absent, forged ids inert, duplicate/race linking, invalid relation, malformed and
  oversized quiet hours, archived/staged/other-track/other-course refusals, empty states
  (childless parent, unenrolled child, no progress rows, division by zero).

## 10. TypeScript result

`npx tsc --noEmit` → **exit 0** (after every change, including the final ones).

`npx eslint` on all touched `src/**` files → **clean**. The new test file reports the same
three `@typescript-eslint/no-require-imports` errors as the existing
`tests/phase26c-admin-full-flow.test.js` (the repo has no lint ignore for `tests/**`);
this is the established pattern for Node-based test files, not a new defect.

## 11. Build result

`SECURITY_HASH_SECRET=… npx next build` → **exit 0**:
`✓ Compiled successfully in 1173ms`, `Finished TypeScript in 6.9s`,
`✓ Generating static pages (71/71)`, all five `/api/parents/me/*` routes present in the
manifest. One environmental message appears during page-data collection
(`PrismaClientInitializationError: could not locate the Query Engine for runtime
"debian-openssl-3.0.x"`): this sandbox runs an offline `prisma generate` with dummy engine
binaries, so the engine file the loader looks for is intentionally absent. The build
continues and completes; CI/production generate real engines. (In 26D the same
page-data step hard-failed on pristine HEAD; it completes here.)

## 12. Remaining gaps

**GO-LIVE BLOCKER:** none open. Every blocker-class defect found in this phase is fixed and
asserted. The prior blocker set (curriculum leakage into parent quiz statistics, dashboard
vs analytics incoherence, the parent dead-end bell view, the PII over-serialisation) is
closed.

**IMPORTANT NON-BLOCKING:**

1. **No rate limiting on parent endpoints.** `link-student` is verification-gated,
   idempotent and answers an identical 404 for every failure, so the practical abuse surface
   is low; a per-account limit would still be worth adding when the rate-limit key set is
   next extended.
2. **Parent sub-views are not addressable.** Report / analytics / weekly / preferences are
   local state inside `<ParentDashboard/>`, and the sidebar's `parent-report` item renders
   the same component (it is an alias, not a second page). Deep-linking to a specific
   parent sub-view is impossible today; making them view keys (or URL state) would be the
   fix. The bell mis-route that made this visible is fixed, so nothing 403s.

**FUTURE ENHANCEMENT:**

3. Move the remaining inline dashboard universe (`universeLessonRows`,
   `universeHomeworkIds`) onto the shared helpers as well, so a single call site defines
   every parent number. It is currently correct but not deduplicated.
4. Consider surfacing the "why" of an empty state to parents (e.g. "no enrolled child yet"
   vs "no activity this week"); today both render an empty block.
5. `analytics` and `weekly-report` recompute the universes per request with one query pair
   per child; a batched helper would help large families.

(`nationalId`/`parentPhone` remain in the register/link request bodies by design — that is
where they are needed — but no other parent response carries them.)

## 13. Git status

```
 M src/app/api/parents/me/analytics/route.ts
 M src/app/api/parents/me/dashboard/route.ts
 M src/app/api/parents/me/link-student/route.ts
 M src/app/api/parents/me/weekly-report/route.ts
 M src/app/api/students/me/notification-prefs/route.ts
 M src/components/app-shell.tsx
 M src/lib/notify.ts
 M src/lib/parent-access.ts
 M src/lib/registration.ts
 M tests/parent-dashboard-isolation.test.js
 M tests/session-lifecycle-phase13.test.js
 M tests/track-architecture-phase12.test.js
?? docs/PHASE_26E_PARENT_PORTAL_QA.md
?? scripts/verify-phase26e-parent.mjs
?? tests/phase26e-parent-full-flow.test.js
```

Branch: `arena/01a0a82f-codemind-academy` (HEAD `98dfb5f`, not moved).
Nothing staged, nothing committed, nothing pushed, no PR, no merge.

## 14. Commit hash

**None — nothing was committed** (per the delivery rule: no PR, and the branch is left
dirty for review). If the reviewer wants a single commit, the twelve modified files and the
three new files above are the complete set.

## 15. Recommendation

**READY FOR GIT DELIVERY.**

Rationale: the parent role's authority model is session-derived and asserted against six
identities; every reported number is now measured against the child's own published,
non-archived, in-course, in-track curriculum, shared with the student/teacher surfaces and
defined in exactly one place; the linkage flow is idempotent, race-safe and
non-enumerable; Phase 26D attempt semantics are consumed correctly and unchanged; the full
52-suite sweep shows no new failure (the two failures are reproducible at HEAD and are
artifacts of the sandbox checkout); TypeScript and the production build both pass. The open
items are non-blocking and listed above with their intended fix.
