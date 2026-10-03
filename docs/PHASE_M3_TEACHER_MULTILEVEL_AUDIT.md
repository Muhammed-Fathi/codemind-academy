# Phase M3 — Teacher Multi-Level UX & API Audit

- **Status (at original audit):** audit-only; implementation requires explicit approval
- **Audit date:** 2026-10-03 (UTC)
- **Baseline:** Phase M2 closed/merged at `8ab1972208acea756ae6fbf291481bd2ca7204c6` (`main` baseline)
- **Audited checkout:** `arena/01a101f9-codemind-academy`, `HEAD` at the baseline above

## 1. Executive summary

Phase L's core authority model is present: a teacher's academic-level scope is derived from **owned Group → Course → `Course.academicLevel`**; list filters narrow those owned groups/courses on the server; unknown levels are rejected; a level the teacher does not own cannot widen the result. The shared filter is shown only when the server-derived teacher scope spans both levels. The inspected M3 surfaces do not require a schema change or a new authority field.

The remaining problems are primarily **scope consistency and context**, not the absence of a level filter:

1. **Highest risk — dashboard history and per-group analytics do not consistently follow the selected group/course/level.** The dashboard loads quiz attempts and recent activity by the current roster's student IDs, not by the teacher's authorized quiz/homework course IDs, and it includes open quiz attempts in some of those reads. Analytics filters quizzes to courses represented in the selected level, but not to the individual group; attendance and homework aggregates use each student's unfiltered history. This can make a level-filtered list disagree with its KPIs and can surface historical records from another course/teacher for a student who is currently in the teacher's group. The intended definition of “per group” and “all levels” must be agreed before fixing the aggregation.
2. **The dashboard's recent-quiz activity CTA is not wired to the app's navigation model.** It renders `/teacher/sessions?quizId=…&attemptId=…`, but the inspected App Router tree has no `/teacher/sessions` page, the app uses `ViewKey` navigation, and neither `AppShell` nor `TeacherSessions` consumes those query parameters. Static inspection therefore indicates that this CTA cannot open the selected attempt. Runtime verification was not possible in this checkout because TypeScript is not installed.
3. **Live-session scheduling asks for a group-scoped lesson list, but the lesson API ignores `groupId`.** It returns the teacher-owned catalogue (with correct level labels), so a lesson from another owned course can be selected for the chosen group. The scheduling POST correctly refuses a lesson outside that group's course with `LESSON_NOT_IN_GROUP_COURSE` (409), making this a selector/wiring defect rather than a confirmed successful cross-course write.
4. **A few high-signal contexts disappear after a teacher makes a selection.** Homework/quiz cards omit the canonical academic-level label from their nested course payload; the curriculum-workspace overview, question/attempt dialogs, dashboard activity and upcoming-session rows also do not consistently repeat course/level context. This is especially confusing where the official course names and lesson codes are shared between levels.
5. **Readiness has a verified stale-options transition risk.** The selected lesson is cleared on level change, but the fetch effect does not re-enable loading or clear the previous lesson array. Old-level options can remain selectable while the new list is in flight. The readiness group filter also identifies groups by name rather than canonical group ID.
6. **The analytics client has no request sequencing/cancellation.** A slower response for an earlier level can replace the current selection's data; a network failure leaves the previous data visible. Separately, attendance GET accepts both group and session IDs but does not assert that the session belongs to that group; the attendance UI does not send its selected `academicLevel` to that endpoint.

The recommended M3 plan is: agree and enforce the KPI population; correct the group-scoped lesson selector and readiness transition; repair in-app attempt navigation and carry canonical level context through cards/dialogs; then close attendance-pairing and Arabic RTL/English LTR responsive gaps with regression and browser tests. Keep `Course.academicLevel` canonical, preserve teacher ownership first, and keep `Group.trackScope` limited to `ARABIC | LANGUAGE`.

## 2. Audit method, baseline and scope

This was a source audit of the Teacher UI, API route handlers, shared scope helpers, workspace/list payloads, and nearby test contracts. It did not assume that a passing test suite proves the user flow. Existing Phase L/Phase F tests were inspected as source contracts; a live app/browser review was not completed.

**Validation performed:**

- Confirmed current `HEAD` is `8ab1972208acea756ae6fbf291481bd2ca7204c6` on `arena/01a101f9-codemind-academy` and the worktree was clean before this audit document was created.
- Invoked `node tests/teacher-academic-level-phaseL.test.js`. It exited before assertions with `typescript is not installed — run npm install`; no test assertions ran. Dependencies were not installed as part of this audit.
- Did not start the Next.js app or perform browser/mobile runtime QA. The recent-activity path was checked against `src/app`, `src/components/app-shell.tsx`, `src/lib/store.ts`, `src/lib/view-roles.ts`, and `next.config.ts` instead; no matching app page or rewrite was found.

The existing `tests/teacher-academic-level-phaseL.test.js` documents coverage for server-filtered teacher lessons/homework/quizzes/sessions/dashboard/analytics/attendance, invalid levels, no-owned-level behavior, same printed codes across levels, and Track independence. The separate live-session identity suite and Phase F suite cover other session invariants. They do **not** establish that every UI flow has correct cross-level KPI scope, that `groupId` filters `/api/teacher/lessons`, or that the dashboard `quizId`/`attemptId` CTA opens an attempt.

## 3. Authority and identity contract to preserve

- **Teacher level authority:** `Teacher → Group (owned by `teacherId`) → Group.courseId → Course.academicLevel`. Do not add `Teacher.academicLevel`.
- **Students:** `Student.academicLevel` remains the student authority; do not derive or overwrite it from the teacher's view.
- **Groups and lessons:** group level comes from its Course; lesson level comes from its canonical curriculum placement (canonical unit chain first, legacy topic chain where applicable). Do not resolve a course or lesson by printed code, title, or display name. The same official lesson code can exist at both levels; the IDs and canonical relations distinguish them.
- **Invalid or unowned levels:** an unknown `academicLevel` is a 400 on the audited level-filtered list routes. Asking for a level outside the teacher's owned groups returns an empty/fail-closed result; it must never fall back to all levels.
- **Track remains independent:** `Group.trackScope` is `ARABIC | LANGUAGE`; do not add `SHARED` to groups or treat Track as another academic level. Content `trackScope` can still use its existing `SHARED | ARABIC | LANGUAGE` semantics.
- **Authorization:** preserve teacher role/profile checks and the existing ownership chain on every detail, write, upload, readiness, and attempt-review route. A client level/group selector is a narrowing hint, never authorization.
- **Non-goals:** no Student/Parent UX changes except a clearly documented shared-code dependency; no landing-page edits; no M4/M5/M6/M7; no migration/schema work absent a proven blocker.

## 4. Teacher surface and API-contract inventory

| Surface | Current request / contract | Audit result |
|---|---|---|
| **Dashboard / groups** | `GET /api/teacher/dashboard?academicLevel=`. `scopedTeacherGroups` narrows the teacher's own groups; scope metadata is computed from the unfiltered owned set. Group rows include canonical course level. Unknown levels return 400. | Group cards and the group selectors label levels. Group-level pending homework and sessions are course/group scoped. Quiz averages and recent activity are not consistently resource/course scoped (Finding F1). Upcoming-session/activity payloads omit level context (F5). |
| **Attendance** | `GET /api/teacher/attendance?groupId=&sessionId=&academicLevel=` checks group ownership and, if supplied, that the group is in the requested level. `POST /api/teacher/attendance` accepts `{ sessionId, attendance: [{studentId,status,note?}] }` and delegates writes to the session authorization/window/lock service. | UI requests use `groupId` and `sessionId` but omit `academicLevel`. GET independently authorizes `sessionId` without proving it belongs to the supplied `groupId`; see F7. Attendance writes remain session-scoped and server-validated. Student-note action is hidden below `sm` with no equivalent mobile affordance (F8). |
| **Lesson catalogue / authoring picker** | `GET /api/teacher/lessons?academicLevel=` returns the teacher's canonical + legacy lesson catalogue, including `lesson.course.academicLevel`, course/part/unit identity, Track and lifecycle. Unknown levels return 400; no owned courses at a level return empty. The response is course-scoped from teacher-owned groups. | The endpoint does not read or apply `groupId`. The shared `LessonPicker` does clear an old lesson selection when its level changes and uses a server-filtered query, but it is given the parent query's loading state rather than the scoped query's loading/error state; it can look empty without loading/error/retry feedback. See F3/F6. |
| **Curriculum sessions list/workspace** | `GET /api/teacher/sessions?academicLevel=` uses the teacher-session list builder and returns canonical lesson/course level. `GET /api/teacher/sessions/[id]` treats `[id]` as a **lesson ID** and authorizes through the teacher's owned courses. | List rows distinguish courses by ID and level-prefixed labels. Workspace navigation is local component state, not URL state. The workspace overview shows course name, code and lesson metadata but no level badge; question and quiz dialogs inherit only partial context (F5). |
| **Live sessions / scheduling** | `GET /api/live-sessions` returns a Teacher's owned-group sessions and groups, with server-owned authorization; `POST /api/live-sessions` revalidates `groupId` ownership and ensures the lesson belongs to that group's canonical course. A mismatch is `LESSON_NOT_IN_GROUP_COURSE` (409). Attendance, reschedule, cancel and workspace routes are session-ID scoped. | Scheduler sends `/api/teacher/lessons?groupId=…`, but the catalogue ignores that parameter. The dialog displays the selected group's level and labels lesson options with their level, yet offers other owned-course lessons. POST prevents a bad write, so the UX surfaces a preventable refusal (F3). Existing Phase F UI assertions check that `groupId` is sent, not that the lesson API applies it. |
| **Homework list / authoring / grading** | `GET /api/teacher/homework?academicLevel=&groupId=` intersects the optional group and level with the teacher's owned groups/courses; canonical and legacy lessons are included. Create takes `lessonId`; edit/delete/grade and attachment routes re-resolve the owned lesson/course. `GET` returns the nested course name but its response mapper omits `academicLevel` even though the query selects it. | The group and level selectors narrow the list server-side and a level change clears the group filter. Homework cards show official code, unit, title and course name—but not level—so duplicate official identities remain visually ambiguous (F5). The list's scope is better than the dashboard's student-history KPI scope (F1). Homework attachments use a buffered teacher-owned route in the dialog; the shared presigned init/complete routes also support an authorized `homeworkId` leg. |
| **Quiz list / create / manage questions** | `GET /api/teacher/quizzes?academicLevel=&groupId=` intersects group/level and lists quizzes on lessons in teacher-owned courses. Per-quiz analytics count finished attempts. `POST /api/teacher/quizzes` takes a lesson ID and revalidates ownership; metadata/question routes load quiz → lesson → owned course. | Quiz list response includes course name and lesson identity but omits `course.academicLevel`; cards do not show a level badge. Shared dashboard authoring picker has level-aware lesson options. The curriculum-workspace create flow fixes `lessonId` to its workspace lesson (good), while the separate question-create editor defines `promptAr` but does not render an Arabic prompt input (F8). Question-manager dialogs show quiz title/Track/time limit but no explicit level/course context (F5). |
| **Attempt inspection / review** | `GET /api/teacher/quizzes/[id]/attempts` resolves the teacher-owned quiz and returns quiz/course summary plus attempt inspections; the server's shared inspection builder controls answer-key visibility for open attempts. Teacher retry authority is not added here. | `QuizAttemptsDialog` in `teacher-sessions.tsx` renders only student/attempt number/score/percentage/pass state/time, in hard-coded Arabic and `dir="rtl"`; it discards the per-question detail in the response and has no selected-attempt context. The dashboard's recent-attempt link is not a valid app-shell deep link (F2/F8). |
| **Readiness / reminder** | `GET /api/teacher/lessons/[id]/readiness` accepts a lesson ID; `loadLessonReadiness` resolves its canonical/legacy course and returns only students from this teacher's groups in that course. `POST /api/teacher/readiness/remind` rechecks teacher-owned student, lesson course and current not-ready state; audience is a controlled mode, never a client-supplied recipient list. | No level query is needed for a selected lesson ID; level is carried by the picker. On level change the selected lesson is cleared, but the old lesson array can remain selectable during the next request. Readiness rows expose `groupName` but no `groupId`; the filter deduplicates and matches by name, collapsing same-named groups (F6). |
| **Lesson materials / media uploads** | `GET/POST/DELETE /api/teacher/sessions/[id]/materials` is keyed by lesson ID despite the route segment name; the server rechecks the teacher's owned lesson. Lesson PDF UI uses `/api/teacher/media-uploads/init` and `/complete`; the init grant is teacher-bound and pinned to `LESSON_PDF`, completion verifies the signed lesson target and reauthorizes. Homework attachment init resolves `homework → lesson → course`; buffered fallback uses `/api/teacher/homework/[id]/attachment`. | Level is correctly derived from the selected lesson/course, not a client-supplied level. Teacher PDF management is manage-own; video publishing remains admin-owned. Preserve file validation, rate limits, private storage and signed intent semantics; no new media authority is needed. The selected curriculum workspace should retain its level context (F5). |
| **Student notes** | `GET /api/teacher/student-notes?groupId=&studentId=` scopes to the teacher's owned groups/students; `POST` accepts `{studentId,note}` and rechecks the student in those groups. Notes are append-only and fan out through the existing parent notification path. | Student ID is the correct resource identity; do not add a teacher-level field or turn notes into a cross-level/course selection surface. The note icon is `hidden sm:table-cell`, so it is unavailable on narrow mobile screens (F8). |
| **Templates** | `GET/POST /api/teacher/templates` serves public plus teacher-owned templates; `DELETE /api/teacher/templates/[id]` is owner-scoped. A template is generic reusable lesson-plan content, not attached to a lesson or course. | The level-agnostic behavior is coherent with the current model. Do not add academic-level template fields unless the product explicitly decides that templates should be curriculum-bound. |
| **Notifications / related links** | `GET /api/notifications` returns the caller's rows. Quiz submission sends teachers `QUIZ_RESULT` with `link: quiz:<id>`. Generic deep-link mapping sends `quiz:` to the student quiz view; role gating prevents a Teacher from navigating to that student-only view. | Teacher quiz-result notices are informational, not a review deep link, and do not include course/level. Do not broaden the shared role mapping accidentally; decide a Teacher-owned attempt-review destination and authorize the quiz/attempt there (F2/F5). |

## 5. Prioritized findings

Severity here is about the Teacher multi-level task: **P1** is a broken core flow or plausible cross-scope data exposure; **P2** is a substantial reporting/selector/context defect where the downstream write remains guarded; **P3** is a lower-risk product or polish question.

### F1 — P1: dashboard and analytics history do not match group/level scope

**Evidence**

- In `src/app/api/teacher/dashboard/route.ts`, the per-group quiz average queries `QuizAttempt` by `studentId` only (around lines 62–67), without quiz-course or `finishedAt` filters. Recent graded homework and quiz activity are also queried by the scoped roster's student IDs only (around lines 203–231): neither relation is constrained to the teacher's authorized lesson courses, and the quiz query can include open attempts. The level narrows the current groups/roster; it does not narrow those students' historic records.
- In `src/app/api/teacher/analytics/route.ts`, `s.attendances` and `s.homeworkSubmits` are included without a current-group/course predicate (around lines 38–61, 179–192). Quiz attempts are restricted to `authorizedQuizIds`, but that set is every teacher-owned course in the selected level, not the specific `g.courseId` whose card is being calculated (around lines 84–106, 181–245).
- By contrast, per-quiz list analytics use finished attempts, and lesson completion is scoped to the group course and student's Track. That makes the list and group KPI populations visibly different.

**Impact / decision needed**

The same student may retain attendance/homework/quiz history after changing group or course. Current code can fold that history into another group's card and, in the dashboard activity feed, can surface another teacher's course title/result. This conflicts with the dashboard route's own claim that each selected-level number/activity follows the level and with the stricter teacher-course filtering in the analytics and attempt routes. Confirm whether KPIs mean (a) records in this **group/course**, (b) records in any **teacher-owned course in the selected level**, or (c) student lifetime history. The first two options must remain teacher-owned; do not silently treat roster membership as authorization to reveal other-course history.

**Acceptance**: dashboard cards, analytics rows, list aggregates and recent activities have one documented population; prior-course records cannot contaminate another group's metrics unless a separately approved “lifetime” KPI explicitly labels that scope; open attempts never count as completed quiz outcomes.

### F2 — P1: dashboard attempt CTA targets no app-shell route and does not select an attempt

`RecentActivityRow` in `src/components/teacher/teacher-dashboard.tsx` (around line 1024) emits a literal `<a href="/teacher/sessions?quizId=…&attemptId=…">`. The inspected `src/app` tree has no `/teacher/sessions` page; teacher views are switched through `useApp.setView` (`src/lib/store.ts`, `src/components/app-shell.tsx`). No app-shell or `TeacherSessions` code consumes those query parameters. The teacher attempts API is quiz-scoped, but its current dialog is only a summary list and does not focus the `attemptId` from this CTA.

**Impact**: a teacher clicking a prominent “review this attempt” affordance cannot reach the requested attempt, and even a handoff to the sessions view would lack the target selection. This was statically confirmed; a server response/browser result was not tested because the local TypeScript/Next dependencies are unavailable.

**Acceptance**: use the existing in-app view-navigation model (or another real app route); the selected quiz and attempt are loaded through the teacher-authorized API; a forged/mismatched attempt ID fails closed; the UI shows the quiz/course/level and preserves the existing no-retry/no-open-answer-key limits.

### F3 — P2: live-session lesson selector is not narrowed to its selected group

`ScheduleDialog` in `src/components/teacher/live-sessions-workspace.tsx` requests `/api/teacher/lessons?groupId=${groupId}` and labels returned options with level. `src/app/api/teacher/lessons/route.ts` parses only `academicLevel`; `groupId` is ignored. The selector therefore shows lessons from every course the teacher owns. `buildSessionDraft` in `src/lib/live-sessions.ts` correctly rechecks the group and lesson course and rejects a mismatch with 409.

**Acceptance**: accept a group ID only after checking it belongs to the teacher, derive its course ID on the server, and return only lessons in that course (plus valid level labels); never trust a client-supplied `courseId`. Keep the POST-side group/course guard.

### F4 — P2: analytics level requests can overwrite each other or leave stale numbers visible

`AnalyticsView` in `src/components/teacher/teacher-dashboard.tsx` fetches on `level` changes but does not abort or sequence requests. A slow earlier response can overwrite a later selection. On network rejection, it only shows a toast and retains `data`, so the previous level's cards can remain on screen after the active filter changed. There is no visible retry state for that path.

**Acceptance**: sequence/cancel requests; do not label stale data as current; provide explicit loading, error and retry states. Add a delayed-response regression (FS request slower than SS request, and vice versa).

### F5 — P2: canonical level context is dropped in cards, workspaces and review dialogs

The dashboard, homework and quiz list routes correctly select canonical `Course.academicLevel` where needed, but the homework/quiz response mappers serialize only course `id` and `name`. Cards show official code/title/course name without a level badge. The two official curricula share course names and can share printed official lesson codes. The curriculum workspace has level on its lesson payload/list identity but omits it from the workspace header; question manager, attempt summary, upcoming sessions and recent activity do not consistently carry a level/course stamp.

**Acceptance**: preserve `academicLevel` (derived from the existing lesson/course chain) in list DTOs and display a compact, localized level badge in cross-level cards, upcoming/recent activity and detail dialogs. Include course ID/level or equivalent context in question and attempt review. Do not infer level from a code or title.

### F6 — P2: readiness level transition keeps old options; group filter collapses duplicate names

`src/components/teacher/readiness-view.tsx` clears `lessonId` in the level-filter handler, which is correct. The lessons fetch effect, however, does not set `lessonsLoading` to `true` or clear the previous `lessons` array at request start; after the first fetch the old-level options remain rendered until the new response. The group filter builds a `Set` of `groupName` and compares the same display value. `loadLessonReadiness` returns `groupName` only, so same-named groups cannot be selected independently.

**Acceptance**: clear or disable the old catalogue immediately, show scoped loading/error/retry, guard out-of-order responses, keep selection cleared, and carry canonical group IDs alongside labels in the readiness DTO/filter. API still derives the student roster from the teacher's groups in the selected lesson's course.

### F7 — P2: attendance GET does not bind `sessionId` to `groupId` / selected level

`GET /api/teacher/attendance` validates the requested group is teacher-owned and checks it against `academicLevel` when supplied. It then fetches attendance rows by the independent `sessionId` and separately authorizes the session through `loadSessionForTeacher`; it does not assert `session.groupId === groupId`. The UI builds the session option from the selected group, but its GETs omit the already-selected academic level. A stale or tampered group/session pair can therefore combine one group's roster with another authorized session's summary; this is a data-integrity/context mismatch, not evidence that an unauthorized teacher can write attendance. Writes still pass the session authority and roster/write-window checks.

**Acceptance**: reject a session that does not belong to the selected group (unless a separately designed substitute view deliberately omits the group selector); pass the selected level as a narrowing check on GET; add cross-group/cross-level request tests. Keep POST authorization session-based and do not trust a client level for authority.

### F8 — P2/P3: English LTR and narrow-screen gaps remain in Teacher-only flows

- Attempt results and preview dialogs in `teacher-sessions.tsx` contain Arabic literals and force `dir="rtl"`; quiz create also contains Arabic-only camera copy. The grading feedback textarea in `teacher-dashboard.tsx` forces `dir="rtl"` even when the global locale is English/LTR.
- The legacy quiz editor renders both English and Arabic question prompts; the workspace `QuizCreateDialog` carries `promptAr` in its draft/payload but renders no Arabic prompt field. This creates different authoring capability depending on which Teacher surface is used.
- The student-note action cell is hidden below the `sm` breakpoint and has no alternate row action on mobile. Tables scroll horizontally, which preserves the remaining columns but does not restore the note affordance.
- Many surrounding surfaces use logical spacing and responsive flex/grid patterns, and the live-session dialogs include bounded viewport scrolling; still, no visual browser pass was possible. Do not claim full RTL/mobile correctness from source inspection alone.

**Acceptance**: localize teacher review/preview/create copy, remove hard-coded RTL from locale-neutral text areas, expose Arabic prompt authoring consistently or explicitly document a single-language question contract, and provide mobile access to student notes. Visually test Arabic RTL and English LTR on phone/tablet/desktop widths.

## 6. UX ambiguities to settle before implementation

1. **KPI population:** Does a group card represent records for that group's current sessions/course, all courses owned by the teacher at the selected level, or lifetime student records? Which value should “all levels” represent? Do not make this decision by changing queries silently.
2. **Filter persistence:** Each dashboard tab and standalone surface keeps local level state. Should a selected level persist when switching Teacher views, or should each view intentionally start at “All”? If persistent, define its reset on role/session change and whether the URL is involved.
3. **Readiness group filter:** Should same-named groups be distinct options? The current row DTO cannot distinguish them. Proposed default: yes, by group ID with name plus level/course context.
4. **Question/attempt modal identity:** Which stable context should appear together—academic level, course name, official code, lesson title and quiz title—and which language fields should be edited in both authoring entry points?
5. **Teacher quiz notifications:** Are completion notices intentionally informational, or should they open a Teacher-owned attempt review? The current `quiz:` deep link is Student-only for navigation; do not route teachers to student quiz execution.
6. **Templates:** Current templates are deliberately generic and course-independent. Confirm before considering any course/level scoping.
7. **Attendance substitute edge:** The normal Attendance tab selects an owned group, while live-session attendance can include an authorized substitute session. Confirm whether any UI ever needs a substitute session alongside a group selector before tightening the group/session assertion.

## 7. Proposed implementation sub-phases (approval required)

### M3.1 — KPI and history scope contract

- Agree the populations in question 1.
- Align dashboard overview/group stats, AnalyticsView, quiz/homework cards and recent activity to the selected teacher-owned groups/courses/level. Use canonical course relations, not student ID alone, for course-scoped history.
- Keep attendance tied to the intended group sessions; keep quiz outcomes finished-only; include only teacher-authorized quiz/homework records.
- Return enough canonical course/level context on each activity row for the UI to label it and for a target detail fetch to reauthorize.

### M3.2 — Selector and transition integrity

- Add safe `groupId` narrowing to `/api/teacher/lessons` for the live-session scheduler: resolve group ownership server-side, derive its `courseId`, and narrow the existing teacher course set.
- Repair `LessonPicker` loading/error/retry wiring for its level-scoped query; clear or disable old options during transitions.
- Repair readiness options race and include `groupId` in readiness rows/filter options. Keep lesson-ID authorization and current not-ready revalidation unchanged.
- Preserve existing group-ID selector identities and level-prefixed labels. Invalid values remain reject/empty; no fallback to “all”.

### M3.3 — Attempt navigation and detail context

- Replace the raw `/teacher/sessions?...` anchor with a real app-shell navigation action.
- Make the target flow open the authorized quiz and selected attempt, with the API validating quiz ownership and attempt-to-quiz membership. Do not use notification-link role mapping to send teachers to a student view.
- Render attempt/course/level context and meaningful per-question review where the existing API response supports it. Keep open-attempt answer-key rules and the explicit no-teacher-retry boundary.
- Carry level context into homework/quiz cards, question-manager/create/edit dialogs, curriculum workspace, upcoming sessions and recent activity.

### M3.4 — Attendance, i18n and responsive completion

- Bind attendance GET's group/session pair and optional selected level; add refusal tests for mismatched IDs without weakening the existing substitute-session contract.
- Localize Arabic-only review/preview/create strings and correct forced direction for English feedback. Bring workspace question-language controls into parity with the legacy editor or document an approved single-language rule.
- Restore student-notes access on mobile; manually check filters, table scroll, dialogs and action wrapping in RTL and LTR.

### M3.5 — Regression and acceptance gate

- Extend the existing Phase L/Phase F suites or add `tests/phase-m3-teacher-multilevel.test.js`; avoid a schema migration unless testable evidence proves an existing model cannot represent the contract.
- Run the route/integration suite and typecheck in a dependency-complete environment, then perform the visual/browser matrix below. M3 remains unmerged until cross-level no-widening and all role/Track constraints pass.

## 8. Test and manual-QA plan

### API / integration fixtures

1. **Teacher scope:** a teacher with First and Second Secondary groups; same course display name and same official lesson code across levels but distinct IDs; a second teacher with a same-level group; plus a teacher with only one level. Assert absent/`all`, each canonical level, unknown level 400, unowned level empty, foreign group never visible, and scope metadata based on the unfiltered owned set.
2. **History/KPIs:** a current-level student with current-group records plus older homework, attendance and quiz attempts from another course/level/teacher; include an open attempt and a same-level other-course attempt. Assert the agreed KPI population, list/KPI parity, no out-of-scope activity title/result, and no unfinished result treated as pass/fail.
3. **Group/course lesson picker:** `GET /api/teacher/lessons?groupId=<owned>` only returns that group's course; a foreign group returns a fail-closed result; `academicLevel` plus `groupId` intersects; scheduler POST still returns 409 for a mismatched lesson and succeeds for the selected course.
4. **Attendance:** owned group + same-group session succeeds; owned group + other owned-level session refuses; optional level/group mismatch refuses; foreign group refuses; POST cannot mark a student outside the session roster or outside the authorized session. Preserve the separately approved substitute path if applicable.
5. **Readiness:** lesson ID from another teacher returns the existing fail-closed status; only owned groups in its canonical course appear; reminder rechecks current readiness. Duplicate group names are distinct by ID. A delayed old-level response cannot restore stale options/data after a level switch.
6. **Homework/quizzes/authoring:** list GET group/level intersection; create/edit/delete/grade/upload stays inside teacher-owned canonical course chains; same official code in two levels never collides; quiz analytics are finished-only and follow the approved group/level population; Track scope is tested separately from Academic Level.
7. **Attempt inspection:** owned vs foreign quiz; open attempt does not reveal answer key; mismatched attempt/quiz IDs refuse; selected attempt opens in Teacher app navigation; no Teacher retry grant is created.
8. **Materials and notes:** direct presigned lesson-PDF init/complete plus local/buffered fallback; homework attachment direct/buffered ownership and file checks; foreign/archived/closed targets refuse as before. Student notes remain group/student-scoped; no teacher-level field or new student/parent surface is introduced.

### Browser / visual matrix

| Locale / direction | Phone | Tablet | Desktop |
|---|---:|---:|---:|
| Arabic / RTL | 320–390 px | 768 px | 1280–1440 px |
| English / LTR | 320–390 px | 768 px | 1280–1440 px |

Exercise: dashboard level filter and group cards; attendance group/session changes; live-session schedule wrong/right course; homework/quiz list, create/edit and cards; question manager and attempt review; readiness level switch and same-name groups; notes; materials upload/progress/error. Check focus order, keyboard selection, direction of mixed Arabic/Latin codes and numbers, no clipped dialogs/buttons, horizontal table scroll, mobile notes action, loading/retry states, and that the visible badge matches the selected server data. Include a slow-network/out-of-order analytics and readiness scenario.

### Existing checks to rerun once dependencies are present

- `node tests/teacher-academic-level-phaseL.test.js`
- `node tests/teacher-live-session-identity-phaseL.test.js`
- `node tests/phase-f-live-sessions.test.js`
- Teacher full-flow checks documented in `docs/PHASE_26D_TEACHER_FULL_FLOW_LESSON_QUIZ.md` / `scripts/verify-phase26d-teacher.mjs`
- Repository typecheck and the app's relevant browser/manual QA after the API and UI changes.

## 9. Likely implementation files

This is a planning map only; none of these code files were changed for this audit.

| Concern | Likely files |
|---|---|
| Dashboard history and Analytics KPI scope / request races | `src/app/api/teacher/dashboard/route.ts`, `src/app/api/teacher/analytics/route.ts`, `src/components/teacher/teacher-dashboard.tsx`, `src/lib/quiz-analytics.ts` (only if the agreed aggregation needs a shared helper) |
| Group-scoped lesson catalogue / live scheduler | `src/app/api/teacher/lessons/route.ts`, `src/components/teacher/live-sessions-workspace.tsx`, `src/lib/live-sessions.ts` (preserve POST guard), `tests/phase-f-live-sessions.test.js`, `tests/teacher-academic-level-phaseL.test.js` |
| Shared lesson picker / readiness transition and group identity | `src/components/teacher/teacher-authoring.tsx`, `src/components/teacher/readiness-view.tsx`, `src/app/api/teacher/lessons/[id]/readiness/route.ts`, `src/lib/lesson-readiness.ts` |
| Attendance group/session identity | `src/app/api/teacher/attendance/route.ts`, `src/components/teacher/teacher-dashboard.tsx`, Phase L/Phase F route tests |
| Attempt review navigation and context | `src/components/teacher/teacher-dashboard.tsx`, `src/components/teacher/teacher-sessions.tsx`, `src/components/teacher/teacher-authoring.tsx`, `src/app/api/teacher/quizzes/[id]/attempts/route.ts`, and only if necessary `src/components/app-shell.tsx` / `src/lib/store.ts` / `src/lib/view-roles.ts` |
| DTO labels, workspace, homework/quiz cards | `src/app/api/teacher/homework/route.ts`, `src/app/api/teacher/quizzes/route.ts`, `src/lib/teacher-sessions.ts`, `src/components/teacher/teacher-dashboard.tsx`, `src/components/teacher/teacher-sessions.tsx` |
| RTL/LTR and mobile affordances | Teacher-owned files above; any shared UI change must document impact and avoid Student/Parent behavior changes |
| Regression coverage | `tests/teacher-academic-level-phaseL.test.js`, `tests/teacher-live-session-identity-phaseL.test.js`, `tests/phase-f-live-sessions.test.js`, `scripts/verify-phase26d-teacher.mjs`, likely new `tests/phase-m3-teacher-multilevel.test.js` |

## 10. Explicit scope guard

- **Audit only until approval.** This document does not authorize implementation, PR creation, or starting another phase.
- No schema or migration for M3 unless a specific, reproducible blocker proves the existing Course/Group/Lesson relations cannot meet acceptance.
- Never add `Teacher.academicLevel`; preserve `Course.academicLevel` and `Student.academicLevel` as their existing canonical fields.
- Do not infer course/lesson identity from display name or official code; same codes may exist at both levels.
- Keep teacher ownership as the first boundary. A requested level/group narrows owned rows only; it never widens them. Preserve existing auth, readiness, lifecycle, and upload checks.
- Keep Track separate from Academic Level. `Group.trackScope` remains `ARABIC | LANGUAGE`; do not introduce `SHARED` for groups.
- Do not touch Student/Parent UX except when a necessary shared-code change is documented and tested; do not touch the landing page.
- Do not begin M4/M5/M6/M7 or alter Teacher retry authority, admin-owned video lifecycle, student/parent notification semantics, or generic templates without separate approval.

## 11. M3 completion and final regression status (2026-10-03)

This section records current delivery status. Sections 1–10 remain the original audit baseline, including their historical findings; completed work below does not erase or reframe those findings.

- **M3.1 — KPI/activity scoping: completed and accepted.** Dashboard and analytics now use teacher-owned group/course/level populations; finished quiz attempts and authorized course activity remain the outcome boundary.
- **M3.2 — selector/transition integrity: completed and accepted.** Group selection is owner-checked and narrows the lesson catalogue through the group's canonical course; level/group changes clear stale selections and options, with scoped loading/error/retry coverage.
- **M3.3 — attempt navigation/context: completed and accepted.** Teacher navigation opens the selected quiz and attempt by canonical IDs through an authorized read-only review route. Open attempts continue to hide answer keys, and Teacher retry-grant authority was not added.
- **M3.4 — attendance/i18n/responsive: completed and accepted.** The legacy group-selected attendance GET binds the session to that group and selected level; the separate substitute-session path remains session-scoped. Targeted Teacher dialogs use locale direction/translations, Arabic prompts use the existing `promptAr` contract, and mobile attendance notes remain reachable.
- **Phase 17 verifier compatibility:** The old real-database verifier fixture treated legacy `Lesson.videoUrl` as sufficient publication readiness, while the current readiness contract requires published session-video resources and the other readiness resources. The fixture now seeds current `SessionVideo` rows per audience/track plus material, quiz/question and homework; nullable notification/publication results are guarded so a readiness failure reports the real response instead of crashing the verifier. The child harness now invokes local TypeScript/Node files with `process.execPath`/`execFileSync`, avoiding shell quoting and platform-specific `npx` behavior. These are fixture/runner compatibility fixes only: production notification fan-out, eligibility, preference, deduplication and link semantics were not changed. The Phase 17 suite passed 323 checks in the M3.5 run.
- **M3.5 regression gate:** All 17 requested Node test runners passed (1,767 assertions/subtests total), and `git diff --check` passed. `npx tsc --noEmit` could not complete because Prisma Client generation was unavailable; the normal production build stopped at `prisma generate` for the same engine-download blocker. No successful TypeScript or Next production build is claimed; rerun both in an environment that can reach Prisma's engine host.

### Deferred / out of scope

- No schema or migration change, no `Teacher.academicLevel`, and no Student, Parent, Admin, landing-page or M4 work was included in M3.
- Track remains independent of Academic Level; generic lesson-plan templates remain level-agnostic because they are not course-bound.
- Teacher quiz-result notifications retain their existing informational/role-gated behavior; no notification deep-link or retry-authority changes were made.
- The broader visual matrix in §8 (tablet and desktop widths and phone widths other than 390px) remains outside this regression command set. M3.4's recorded browser smoke covered Arabic and English at 390×844 with 20/20 checks.
