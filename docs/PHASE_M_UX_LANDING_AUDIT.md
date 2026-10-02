# PHASE M0 — MULTI-LEVEL UX & LANDING ARCHITECTURE AUDIT

**Type:** Discovery + architecture only. **No code, no schema, no migrations, no PR.**
**Baseline:** `87f11815294f6248edb0e9c590237bbf3d0ee0b6` (merge of Phase L / PR #105), branch `main`.
**Audit branch:** `arena/01a0fd7d-codemind-academy`.
**Date of audit:** 2026-10-02.
**Status:** awaiting owner approval before any Phase M implementation.

---

## 0. Executive summary

CodeMind is now a **two-level platform** (FIRST_SECONDARY, SECOND_SECONDARY) crossed with
**two tracks** (ARABIC, LANGUAGE). Phase K made the level a first-class database fact; Phase L
made it *usable* where the two levels collide. This audit finds that:

1. **The data model is sound and no cross-level data leak exists.** `Course.academicLevel` is the
   only curriculum authority; `Student.academicLevel` is the declared level; the active assignment
   chain is `Student.groupId → Group.courseId → Course.academicLevel`; `Lesson.academicLevel` is a
   derived cache; every meaningful read path (courses catalogue, groups picker, lessons, mock exams,
   progression) scopes through enrollment and fails closed. `Teacher.academicLevel` does not exist
   and must not be added.

2. **The UX is only ~60% level-aware.** Level *filters* exist on 5 admin surfaces and on 6 teacher
   surfaces; level *badges* exist on 9 admin surfaces; the rest is level-blind. The single most
   damaging structural fact is that **the two official courses share one display name**
   (`البرمجة والذكاء الاصطناعي`, slugs `programming-ai-1st-sec` / `programming-ai-2nd-sec`) *and*
   both curricula reuse printed `officialCode`s (`1-1 …`), so any list without a level label or a
   level filter is genuinely ambiguous — not merely inconsistent.

3. **Three concrete defects are more serious than "inconsistency":**
   * `progression-override-section.tsx` builds its lesson picker from
     `/api/admin/lessons?status=PUBLISHED&pageSize=200` — **both levels in one list, no level, no
     course, colliding officialCodes**. The server refuses a cross-course grant (422), so the admin
     simply picks a wrong "1-1" and gets an unexplained refusal.
   * The parent **child switcher** renders `courseName` only. A parent with one child in First and
     one in Second Secondary sees **two identical chips** — the exact scenario §7 of the brief
     forbids.
   * The Admin payment review drawer shows a group name and a raw `courseId` but **no academic
     level and no track**, so "approve this student into that group" cannot be sanity-checked.

4. **The landing page contains prohibited and unverifiable claims.** `landing.109`
   («أول Lesson مجانية!» / "First lesson free!"), `landing.110` and `i18n-core.nav.startFree`
   («ابدأ مجاناً» / "Start for free") contradict the no-free-trial business model; the hero stats
   («+500», «92%», «4.9★») and `landing.109`'s "500+ students" are unverifiable; the three
   testimonials are hardcoded names with 5-star ratings; and the **Curriculum Explorer's per-unit
   lesson counts are numerically wrong** (implied total 35 vs the real 23) and describe only the
   Second Secondary curriculum while the First Secondary curriculum (1 part / 13 units / 62 lessons)
   is live.

5. **The production release lesson is real and cheap to fix.** Phase L shipped green code with the
   Neon schema still behind. The repo already contains the machinery
   (`prisma/postgres/` + its own migrations directory, `docs/VERCEL_PRODUCTION_RUNBOOK.md` §1's
   pooled-vs-direct rule, the `migration-providers-postgres` hard-gate workflow) — what is missing
   is a **mandatory, written, per-phase release gate** (§O).

**Verdict:** Phase M is warranted. It should be executed as **7 sub-phases** (§L) starting from a
shared-vocabulary/primitives sub-phase, then admin, teacher, student/parent, money+notifications,
landing, and finally the responsive/RTL/design-system sweep plus the release gate. **No schema
change, no pricing change, no authorization change, no `Teacher.academicLevel`, no
`AcademicLevel.GENERAL`, no free-trial claim.**

---

## A. ADMIN SURFACE MATRIX

Legend — **Level vis.**: none / badge / label / filter. **Srv?**: does the narrowing happen in the
API query (required for correctness). **M?**: belongs in Phase M.

| # | Surface | Route / component | API / handler | Level visibility today | Level filter | Track context | Both levels coexist? | Current ambiguity | Recommended UX | Srv? | M? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 | Overview / Dashboard | `admin-dashboard.tsx` `OverviewView` (l.332) + `RevenueAnalyticsSection` (l.5359) + `RevenueForecastSection` (l.5733) | `/api/admin/overview`, `/api/admin/revenue-analytics`, `/api/admin/revenue-forecast` | **none** | none | none | yes (all totals sum both) | **HIGH** — "Group Distribution" is keyed by `course.nameAr`; the two official courses share that exact string, so the pie **merges two curricula under one slice**. Student/group counts silently sum both levels. | Level-aware KPI breakdown (students/groups/attendance per level) + level dimension on the distribution chart; label the aggregate "كل الصفوف". Keep one screen, no tabs. | yes | **yes** |
| A2 | Students | `StudentsView` (l.599), `AddStudentDialog` (l.875), `StudentProfileDrawer` (l.1013) | `/api/admin/students` GET/POST, `/api/admin/students/[id]` PATCH/DELETE, `/api/admin/export-progress` | filter select (l.744, server-side) + column (l.788) + editor (l.1301) + I1 mismatch banner (l.1289) | ✅ select | STUDENT_TABS ARABIC/LANGUAGE/UNSPECIFIED with counts (server-side) | yes | **MEDIUM** — the **group assignment Select (l.1337) renders `g.name` only**: no course, no level, no track. The server's I1 gate rejects the mistake, but the admin cannot see it coming. Tab counts and level filter compose correctly. | Group options must carry `course — level` + track; prefer filtering the group list to the student's level, keep an explicit "show other levels" escape for correction flows; keep the row badge. | partly (group list) | **yes** |
| A3 | Teachers | `TeachersView` (l.1444), `TeacherApplicationsPanel` (l.1626), `Add/EditTeacherDialog` (l.1716/1810) | `/api/admin/teachers` GET/POST, `/api/admin/teachers/[id]`, `/api/admin/teacher-applications*` | **none** (`groupsCount` only) | search only | none | n/a | **MEDIUM** — an admin cannot see which levels a teacher covers, although "this teacher owns groups in both levels" is now normal and operationally decisive (course-authoring, readiness, session scheduling). | Read-only derived level chips per row (`Teacher → Group → Course.academicLevel`) + an optional level filter derived from groups. **No `Teacher.academicLevel` column.** | yes (derive in query) | **yes** |
| A4 | Groups | `GroupsView` (l.1937), `CreateGroupDialog` (l.2051), `ManageGroupDialog` (l.2200) | `/api/admin/groups` GET/POST, `/api/admin/groups/[id]` PATCH/DELETE | badge per card (l.1985) + level in course select (l.2134) + context row (l.2144/2313) | **none** | badge in context row only | yes, freely mixed | **HIGH** — no search, no level, no track, no status filter on a card grid that mixes everything. Separately: the dialog's **member list is `/api/admin/students` page 1 (20 rows) filtered client-side**, so members beyond the first page are invisible. | Filter bar: search + `[level]` (segmented) + `[track]` + `[active]`; move the member list to a server query (`?groupId=&page=&pageSize=`); show level first in the card's identity row. | yes | **yes** |
| A5 | Courses / Curriculum | `CoursesView` (l.2476), `AddCourseDialog` (l.2788), `EditCourseDialog` (l.2910) | `/api/admin/courses` GET(`tree=1`)/POST, `/api/admin/courses/[id]` PATCH/DELETE, reconcile POST | filter select (l.2620) + badge (l.2638/2981) + required on create | ⚠️ select, **applied client-side** (`visibleCourses`, l.2492) | n/a (courses carry no track) | yes | **MEDIUM** — the only *client-side* level filter in the admin (Students/Lessons/Question Bank are SQL-side); two cards share the display name; the tree is entered per course so it is unambiguous. | Keep the filter but push it to the API (or document the client-side exception); always render the level badge adjacent to the name and expose the **slug** as machine identity; label counters with the active filter. | yes | **yes** |
| A6 | Session Management / Publishing | `session-workflow-view.tsx`, `session-detail-view.tsx`, `session-open-dialog.tsx`, `session-pdf-manager.tsx`, `session-workflow-shared.tsx` | `/api/admin/lessons` GET, `/api/admin/lessons/[id]/{readiness,mark-ready,open,open-override,unpublish,archive,materials,recipients}` | FilterSelect (l.214, server-side) + badge (l.404) + detail row "academic level" (l.421) | ✅ select | `trackScope` filter + badge; readiness covers audience coverage | yes | **LOW** — the best-covered admin surface. Only inconsistency: the level control is a labelled dropdown here, chips elsewhere. API already supports `courseId` but no UI uses it. | Adopt the shared **segmented** control for one visual language; add the already-supported course filter; keep readiness/publishing semantics untouched. | already | **yes (cosmetic)** |
| A7 | Session Videos | `session-videos-view.tsx` | `/api/admin/session-videos` GET/POST, `[id]`, `/eligible-sessions`, `/api/admin/batches`, `/api/admin/media-uploads/*` | segmented filter (l.912) + level-first option labels (l.138/150) + batch course badge (l.407) | ⚠️ narrows the **lesson picker only** | batch tabs ARABIC/LANGUAGE (independent axis) | yes — a **school-type pool batch spans both courses**, so the published list mixes levels | **MEDIUM** — the picker is safe; the **published videos list** of a pool batch is not level-filtered (rows do carry the level in their label, l.150). | Keep the segmented control; let it also narrow the **published list** (add `academicLevel` to the list endpoint); state the active level in the card header. | yes (list) | **yes** |
| A8 | Question Bank | `QuestionBankView` (l.3073), `Add/EditQuestionDialog` (l.3516/3720) | `/api/admin/question-bank` GET/POST, `[id]`, `/api/admin/ai-generate-quiz` | FilterSelect (l.3388, server-side, derived quiz→lesson) + badge on the lesson (l.3472) | ✅ select | bank tabs ARABIC / LANGUAGE / shared | yes | **LOW–MEDIUM** — free-bank questions (`quizId = NULL`) have no single level and are **excluded** by any level filter; that is truthful but currently only documented in code. | Keep the filter; surface an inline note when a level is active ("الأسئلة الحرة بلا صف مستبعدة") reusing `admin.650`; make the derived path visible. | already | **yes (copy)** |
| A9 | Mock Exams | `mock-exams-view.tsx` | `/api/admin/mock-exams` GET/POST, `[id]`, `/eligible` | badge per row (l.190) + level in the course selector (l.632) | **none** | school-type tabs (bank selector) | yes | **MEDIUM** — the list mixes both levels with identical course names; the only discriminator is a small badge. | Add the segmented level filter to the list; keep `courseId` required at creation and keep the pool course-scoped. | yes | **yes** |
| A10 | Quiz Review | `quiz-review-view.tsx` | `/api/admin/quiz-attempts`, `/quiz-evidence`, `/quiz-retries` | **none** | none | none | yes | **MEDIUM** — attempts/quizzes from both levels share titles and codes. | Level (and course) derived from quiz→lesson, as a column + optional filter. | yes | **yes** |
| A11 | Live Ops (live sessions / attendance / absences) | `live-ops-view.tsx` | `/api/admin/live-ops`, `/api/admin/groups`, `/api/admin/teachers`, `/api/admin/absence-reviews*` | **none** | none | group/teacher pickers carry `hint = courseName` (l.196/1157) | yes | **HIGH** — the only differentiator in the pickers is the shared course name; no level control on an operational console. | Put the canonical level in the option label (`level · group · course`) and add an optional level filter on the ops list; keep `groupId` as the authoritative filter value. | yes | **yes** |
| A12 | Payments | `PaymentsView` (l.3931), `payment-review-drawer.tsx` | `/api/admin/payments` GET, `/import`, `[id]/approve`, `[id]/reject` | **none** | status only | none | yes | **HIGH** (see §E) — the reviewer cannot see level/track of the requested or current group. | Add display-only `courseName + academicLevel + trackScope` for `requestedGroup` and `studentContext`; keep pricing level-agnostic and keep decisions server-authoritative. | yes | **yes** |
| A13 | Subscriptions | `SubscriptionsView` (l.4707), `PlanManagementCard` (l.4286), `PlanFormDialog` (l.4532) | `/api/admin/subscriptions`, `/api/admin/plans`, `/plans/[id]` | **none** | status only | none | yes | **MEDIUM** — a subscription row tells the admin nothing about which curriculum the money buys. | Add read-only student context (group / course / level) to each row + optional level filter. **Plans stay level-agnostic.** | yes | **yes** |
| A14 | Coupons | `CouponsView` (l.5133) | `/api/admin/coupons`, `[id]`, `/coupons/validate` | n/a | n/a | n/a | n/a | none — global codes | No change. Pricing remains level-agnostic. | n/a | no |
| A15 | Notifications | `NotificationsView` (l.4814), `NotificationCenterStats` (l.5561), `shared/notifications-panel.tsx` | `/api/admin/notifications` GET/POST, `/api/admin/notifications-center` | **none** | type filter only | none | yes | **HIGH** (see §F) — "students" means both levels; group options are names only. | Audience model = role × **level** × **track** × group with a truthful recipient-count preview; server-side derivation only; preferences + quiet hours preserved. | yes | **yes (design; staged impl.)** |
| A16 | Settings | `SettingsView` (l.5035) | `/api/admin/settings` | **none** | n/a | n/a | n/a | none | No level control. Optionally host the level-integrity diagnostics (see A20). | n/a | optional |
| A17 | Progression / Overrides | `progression-override-section.tsx` (inside `StudentProfileDrawer`) | `/api/admin/progression-overrides` GET/POST | **none** | none | none | yes | **HIGHEST** — the picker loads `/api/admin/lessons?status=PUBLISHED&pageSize=200`, i.e. **both levels, colliding codes, no course/level field in the option type**. | Load the **student's own course** lessons (server-scoped) or add level+course filters and label every option `level · code · title`. Keep the server's `LESSON_NOT_IN_COURSE` refusal. | yes | **yes** |
| A18 | Readiness / Recipients | `session-open-dialog.tsx`, `session-detail-view.tsx`, `/api/admin/lessons/[id]/recipients` | readiness/open/open-override/recipients | lesson-scoped (single lesson) | n/a | `trackScope` + audience coverage | n/a | **LOW** — a dialog about one lesson cannot be ambiguous, but the lesson's level is not stated in the dialog header. | Show the lesson's level next to its code in the dialog header. | no | yes (cosmetic) |
| A19 | Analytics / Reports | `RevenueAnalyticsSection`, `RevenueForecastSection`, `/api/admin/export-progress` CSV | `/api/admin/revenue-analytics`, `/api/admin/revenue-forecast`, `/api/admin/export-progress` | **none** | none | none | yes | **MEDIUM** — revenue is dimensioned by method only; the progress CSV has a "Course" column but no level/track, and the two courses share the name → two identical CSV rows. | Add `level` + `track` columns to the CSV and a level dimension to revenue/forecast; keep plan/method breakdowns. | yes | **yes** |
| A20 | Level diagnostics | (no UI) | `GET /api/admin/level-mismatches` (Phase K2) | n/a | n/a | n/a | n/a | **ORPHAN** — the endpoint has **zero UI consumers**; the I1/I2 integrity report is unreachable. | Surface it: a card on Overview or a section in Settings ("فحص سلامة الصفوف") with the counts and a deep link to the offending students. | n/a (read-only) | **yes** |

**Admin nav/IA note.** `NAV_BY_ROLE.ADMIN` (`dashboard/shell.tsx`) is a flat 16-item list with no
grouping, and it contains no dedicated "Analytics/Reports" entry (both live inside Overview). Phase M
should introduce **nav groups** (الأكاديمي / المحتوى / المالية / النظام) without renaming view keys —
`view-roles.ts`, `NAV_BY_ROLE` and `renderView` form a triad pinned by
`tests/post-launch-notifications.test.js`.

---

## B. TEACHER SURFACE MATRIX

Classification: **A** = already good · **B** = correct but UX-inconsistent · **C** = needs Phase M work.

| # | Surface | Component | Level behaviour today | Class | Notes / recommendation |
|---|---|---|---|---|---|
| B1 | Dashboard (overview) | `teacher-dashboard.tsx` `OverviewView` (l.614) | `OptionalAcademicLevelFilter` (l.652) → `?academicLevel=` on `/api/teacher/dashboard`; group cards carry the level | **A** | The reference implementation: UI control + server narrowing + `scope` metadata. Reuse this shape everywhere. |
| B2 | Groups & students | `OverviewView` drill (l.1245) | filter (l.1245); selector options labelled `level · name` (l.1261); rows show `AcademicLevelBadge` (l.927) | **B** | A group is single-level, so per-row level badges on students are redundant; the group-level label is the correct context. Keep. |
| B3 | Attendance | `AttendanceView` (l.1053) | filter (l.1053) → dashboard query; server pairs `groupId+level`, cross-level pair = 403 (`api.156`) | **A** | Strongest authorization story in the teacher surface. No change beyond vocabulary consistency. |
| B4 | Live Sessions | `live-sessions-workspace.tsx` | **no level filter**; badges on session rows (l.401/683/728) and the selected group (l.1425); lesson picker labels level-first (l.1337) | **C** | The list deliberately shows the teacher's whole live day and therefore mixes levels. Add `OptionalAcademicLevelFilter` + `?academicLevel=` on `/api/live-sessions` (currently **no level support**), or state the level in a header and keep "all". Badges are not a filter. |
| B5 | Quiz | `QuizzesView` (l.1709) | filter (l.1812) → `?academicLevel=` on `/api/teacher/quizzes`; group select resets on level change (l.1815); lesson picker has its own level control | **B** | Two level controls can be visible at once (list filter + picker filter inside the create dialog). They are independent states → a teacher can filter the list to First and create against a Second lesson. Recommend: **seed the picker from the list filter** and keep it overridable, or state the scope explicitly in the dialog. |
| B6 | Homework | `HomeworkView` (l.2584) | filter (l.2725) → `/api/teacher/homework`; same dual-control situation (l.2745) | **B** | Same recommendation as B5. |
| B7 | Question Bank (teacher authoring) | `teacher-authoring.tsx` (`useTeacherLessons(level)`, `LessonPicker`) | picker filter (l.327) + `teacher.312` explanation; option labels level-first | **A** | Good. This should become the *shared* picker contract when the admin override picker (A17) is fixed. |
| B8 | Templates | `teacher-dashboard.tsx` `TemplatesView` (l.3171) | **no level anywhere** | **A** (documented) | `LessonPlanTemplate` has **no course/level column** and `/api/teacher/templates` has no course scope — templates are pedagogical, not curriculum content. No filter is correct. Phase M should state this in the UI ("قوالب عامة") so its absence is not read as a bug. |
| B9 | Analytics | `AnalyticsView` (l.3470) | filter (l.3489) → `/api/teacher/analytics`; per-group rows print `level · course · students` (l.3575) | **A** | Good. |
| B10 | Readiness | `readiness-view.tsx` | `OptionalAcademicLevelFilter` (l.286) narrows the **lesson picker** via `/api/teacher/lessons?academicLevel=`; the results panel is per-lesson | **B** | Correct but the control's caption does not say it only filters the picker. Add the same micro-copy as B5/B6 or place the control inside the picker card. |
| B11 | Sessions workspace | `teacher-sessions.tsx` | filter (l.393) + course filter using `courseLabel(name, level)`; course filter resets on level change (l.398) | **A** | The best "level × course" filter composition on the platform; candidate to promote to a shared `CourseFilter`. |
| B12 | Materials / video context | `session-workflow-shared.tsx`, `session-detail-view.tsx`, `session-pdf-manager.tsx` | `TrackScopeBadge` everywhere; level comes from the lesson | **B** | Consistent; only the level is implicit. Add the lesson level next to the code in materials headers. |

**Teacher conclusion.** Phase L's authorization architecture is correct and must not change: level is
derived from the teacher's own groups, the filter can only narrow, unknown values 400, attendance
refuses cross-level group/level pairs. Phase M is a **usability** pass: one missing filter (B4), two
dual-control flows (B5/B6/B10), and micro-copy explaining when a control exists and what it narrows.

---

## C. STUDENT SURFACE MATRIX

The student belongs to exactly one level, enforced at enrollment (I1) and re-checked by every read
path. **No level switcher may be added.** The audit therefore checks *context clarity* and *truthful
empty states*.

| # | Surface | Component / API | Cross-level risk | Level context visible today | Finding |
|---|---|---|---|---|---|
| C1 | Dashboard | `student-dashboard.tsx` / `/api/students/me/dashboard` | none — enrollment-scoped | `brand.academicYear`, course name; `grade` exists in the payload (l.423) but is **never rendered** | **B** — the student cannot read their level in words; the course name is identical across levels. Show the canonical level label (from the course) as passive context. |
| C2 | Current course | `/api/students/me/current-course` | none (own row only) | id/slug/name/nameAr/color | **B** — add `academicLevel` (read-only) so headers can label it. |
| C3 | Curriculum / lessons | `course/student-course.tsx`, `/api/courses/[slug]` | none — 403 `NOT_ENROLLED` when `enrollment.courseId !== course.id` | course name; unit/lesson tree | **A** for isolation; **B** for labelling (header shows only the shared name). |
| C4 | Session videos | `course/session-videos-view.tsx`, `/api/students/me/session-videos` | none — batch resolved server-side from the student's own `schoolType` | batch-derived; level not shown | **B** — optional level label in the header; no control. |
| C5 | Homework | `/api/students/me/homework` | none — course + track scoped | none | **A** |
| C6 | Quizzes | `quiz-runner.tsx`, `session-quiz.ts` | none — track + course scoped | none | **A** |
| C7 | Mock exams | `student/mock-exam.tsx`, `/api/exams/mock` | none — `mockExam.courseId !== enrollment.courseId → 404` (never 403, so a foreign exam is not confirmed) | none | **A** (strongest isolation rule on the platform) |
| C8 | Study plan / Progression | `/api/students/me/study-plan`, `/students/me/progression` | none — `courseId` must equal the enrolled course, otherwise it is ignored | none | **A** |
| C9 | Payments | `student/payment-status.tsx` | none | `groupName`, `courseName` | **B** — add level/track to the summary for parity with the admin review drawer. |
| C10 | Notifications | `shared/notifications-panel.tsx` | none | n/a | **A** |

**Empty states.** `NO_ACTIVE_COURSE` is an explicit, documented state produced by the canonical
progress authority and rendered as an honest zero-universe (never a `LessonProgress` recount). This
is the model Phase M should keep; the landing and admin empty states should copy its truthfulness.

---

## D. PARENT SURFACE MATRIX

Parent scope is server-derived from active `ParentStudentLink` rows; every `/api/parents/me/*` route
re-verifies the link per call and returns 404 for a non-linked id (identical to a non-existent one).
**No global level authority may be added to Parent.**

| # | Surface | Component / API | Finding | Class |
|---|---|---|---|---|
| D1 | Linked children (switcher) | `parent/child-switcher.tsx` (`SwitcherChild = {id,name,courseName,avatarUrl}`) | **HIGH** — chips show `courseName`; with two children in different levels the two chips are textually identical. The selected child's level is not stated anywhere in the switcher. | **C** |
| D2 | Dashboard | `parent/parent-dashboard.tsx`; `/api/parents/me/dashboard` | Shows `child.grade` (the **display mirror** `Student.grade`, i.e. "1st Secondary"/"2nd Secondary", untranslated) + course name. The payload carries `grade` and `schoolType` but **no `academicLevel`**. | **B/C** — adopt canonical level labels; keep `grade` only as a mirror. |
| D3 | Academics | `parent/academic-followup.tsx`; `/api/parents/me/academics` | Snapshot returns `course: {name, track}` and `grade`; no level. Read-only, no ids/answers — the payload contract is exemplary. | **B** |
| D4 | Analytics | `parent/analytics-view.tsx`; `/api/parents/me/analytics` | Per-child tabs (by name) + `?studentId=`; no level. Correct isolation; add level to the child tab/header. | **B** |
| D5 | Weekly / Monthly reports | `parent/weekly-report.tsx`, `parent/monthly-report.tsx` | Course name + `grade`; `monthly-report.tsx` falls back to the literal `"2nd Secondary"` when `child.grade` is empty (l.81) — a **hardcoded level** and a latent lie for a First-Secondary child. | **C** (small, high value) |
| D6 | Notifications | `shared/notifications-panel.tsx` via `student-notifications` fallback | Informational; no level needed. | **A** |

**Parent conclusion.** The fix is *additive and read-only*: expose `academicLevel` on the child
payload (`dashboard`, `academics`, `analytics`, `weekly-report`) and render it next to the child's
name/chip; remove the `"2nd Secondary"` fallback. No switcher, no filter, no authority.

---

## E. PAYMENTS / SUBSCRIPTIONS FINDINGS

**Contract today.** `AdminPaymentRow` (`payment-review-drawer.tsx` l.73–129) carries amount, method,
status, reference, requested plan, `requestedGroup {id,name,isActive,capacity,courseId,schedule,
seatsUsed}` and `studentContext {groupId,groupName,courseId,currentPlanName,subscriptionStatus,
accessAllowed,state,dates}`. The server resolves the plan/group names defensively (FK-less by design)
and labels entitlement with the shared pure policy (`evaluateAccessDecision`,
`describeSubscriptionState`), so the queue can never disagree with the student's dashboard.

**Findings.**

1. **No academic level, no track anywhere in the payment or subscription read model.** The reviewer
   approving a payment cannot see whether the requested group is First or Second Secondary, nor
   which track. With one shared course name this is not a cosmetic gap.
2. `courseId` **is** returned but is a raw cuid: not rendered, and not resolvable to the level in the
   client.
3. **Subscriptions** (`/api/admin/subscriptions`) return `student {name,email}` + plan + payments —
   no group, no course, no level.
4. **Analytics** (`revenue-analytics`, `revenue-forecast`) have **no level dimension**; revenue is
   broken down by payment method (and the forecast is a single aggregate).
5. **Pricing is level-agnostic and must stay so.** `SubscriptionPlan` has no level column, plans
   differ by duration/price only, every plan includes the full platform (one shared
   `PRICING_FEATURES` list on the landing), and the admin plan editor manages availability, not
   curriculum. **No pricing model change is proposed or required.**

**Recommendation (display-only, no model change).** Extend the two read projections with resolved
display context — `academicLevel`, `trackScope`, `courseName`, and (for the payment drawer) the
group's level — computed server-side from `Group → Course`. Add a level dimension to the admin
revenue analytics and a level/group column to the subscriptions table. Add `level` + `track` columns
to the progress CSV export.

---

## F. NOTIFICATIONS FINDINGS

**Current architecture (verified).** `POST /api/admin/notifications` accepts
`target ∈ {user, group, students, parents, teachers, all}` + `title/message/type/link`. The link is
validated against the deep-link scheme (malformed → 400). Recipients are resolved server-side
(`group → students of that group`, `students → all students`, …), the audience is rate-limited
*before* derivation, and the fan-out honours the **Phase 17 preference contract** in bulk
(`partitionByNotificationPreferences`: per-type flag + quiet hours, one read, one clock), inserting
in chunks and returning a truthful `{sent, skipped}`. The admin UI offers those six targets; the
group picker is a plain Select of `g.name`; `NotificationCenterStats` lists a type filter only.

**Gaps.**

| Gap | Impact |
|---|---|
| No **Academic Level** audience | "Tell First Secondary parents about the new unit" is impossible; the only truthful workaround is per-group sends. |
| No **Track** audience | Same for Arabic-vs-Language announcements. |
| Group picker shows names only | With two levels and shared course names, the admin cannot verify the audience of a group send. |
| No recipient preview | The admin sees the count only **after** sending (`sent`). |
| Group targeting reaches students but not their parents | A "class cancelled" broadcast to a group's students misses the parent audience that the product promises elsewhere. |

**Recommended future behaviour (design now, implement in M5 only if approved).** Keep an explicit
audience enum, derive the recipient set server-side, and never accept a client-supplied user-id list:

```
target: ALL | ROLE(student|parent|teacher) | LEVEL(academicLevel) | TRACK(schoolType)
        | GROUP(groupId) | USER(userId)
filters (composable, AND): academicLevel?, schoolType?, groupId?
→ preview: { students, parents, teachers, total, skippedByPreference, skippedByQuietHours }
```

Composition rules: `parents` of a `GROUP` audience should be reachable via an explicit
`includeParents` flag; unclassified (`trackScope = null`) groups must never be silently included;
`QUIZ_RESULT`/`PAYMENT_*` transactional notifications are out of scope for broadcast targeting.
**Nothing in the targeting model may weaken the Phase 17 preference/quiet-hour enforcement.**

---

## G. QUESTION BANK / MOCK EXAM FINDINGS

**Preserved invariants (verified in code, must not change):**

* `MockExam.courseId` is **required** (K3) and `resolveMockExamCourse` refuses an unlevelled course
  (`api.375`, 409). A legacy course-less exam may be *repaired* by setting the course, never created.
* The **automatic (RANDOM) pool is course-scoped** (`mockExamLessonWhere` + `poolCourseId`): a
  lesson-linked question must belong to a student-visible lesson of *the exam's own course*; the
  former "every course" fallback was removed in K2 precisely because it spanned levels.
* Free-bank questions (`Question.quizId = NULL`) are **never global**: they are eligible only when the
  admin explicitly attached them to that exam (FIXED pins) or, for a course-less exam, through the
  documented legacy path — but always within the exam's course when one is set.
* Question-bank *listing* attributes a level only through `quiz → lesson → academicLevel`; a
  free-bank row has no single level and is excluded from any level-narrowed view (truthful, not a
  default).
* The student route returns **404 (not 403)** for an exam of another course, so a foreign course's
  exam is never confirmed.

**Findings.**

| # | Finding | Severity | Recommendation |
|---|---|---|---|
| G1 | The admin Mock Exams **list** has no level filter (rows carry a badge and the shared course name). | Medium | Add the segmented level filter; keep creation course-bound. |
| G2 | The exam **create/edit dialog** shows the course with its level (`courseWithLevelLabel`) — good — but the eligible-question list states the pool only as a count (`admin.244`). | Low | State pool scope as text: course + level + track + difficulty. |
| G3 | Question Bank free-bank exclusion from level-narrowed views is undocumented in the UI (`admin.650` exists but is only used in a dialog). | Low | Inline note when a level filter is active. |
| G4 | Same-code collisions are handled by **id identity** everywhere (lesson ids, question ids, `MockExamQuestion` pins); no code-based lookup exists. | — | Keep. Never resolve a lesson/question by `officialCode` alone. |

---

## H. REUSABLE ACADEMIC-LEVEL FILTER / COMPONENT STRATEGY

**What exists** (`src/components/admin/academic-level-ui.tsx`, 196 lines, keys `admin.642–648`):

| Export | Shape | Used by |
|---|---|---|
| `ACADEMIC_LEVEL_OPTIONS` | `["FIRST_SECONDARY","SECOND_SECONDARY"]` | all of the below |
| `academicLevelLabel(tr, level)` | canonical AR/EN label, `admin.645` for unknown | 9 files |
| `AcademicLevelBadge` | outline badge, `data-academic-level` attr, title=`admin.642` | 20 call sites |
| `AcademicLevelFilterSelect` | compact **dropdown**, `""` = all | Students, Courses, Question Bank |
| `AcademicLevelSegmentedFilter` | `[الكل][أولى][ثانية]` **chips**, `data-academic-level-filter` | Session Videos, teacher Optional wrapper |
| `OptionalAcademicLevelFilter` | renders **nothing** unless `scope.spansBothLevels` | 6 teacher surfaces |
| `courseWithLevelLabel(tr, c)` | `"name — level"` option text | group/mock-exam selectors |

**Assessment.** The vocabulary is genuinely shared — that is the Phase L win and it should be kept.
The duplication is in the *shells*: a dropdown and a chip group implement the same semantics twice;
three separate label builders exist (`courseWithLevelLabel`, `lessonLabel` in `teacher-authoring.tsx`,
`courseLabel` in `teacher-sessions.tsx`); and each consumer re-implements the empty/`all` string
handling (`("" | "all") → null`, 400 on unknown) inside its own API route.

**Consolidation proposal (M1, zero behaviour change):**

1. **One component, one flag.**
   `AcademicLevelFilter({ value, onChange, variant: "segmented" | "select", scope?, allLabelKey?, ariaLabelKey? })`.
   * `variant="select"` reproduces today's `AcademicLevelFilterSelect` DOM.
   * `variant="segmented"` reproduces today's chip group DOM.
   * `scope` (boolean | `{spansBothLevels}`) reproduces `OptionalAcademicLevelFilter`: when
     `spansBothLevels === false`, render `null`.
   * **Preserve `data-academic-level-filter` / `data-academic-level-scope` attributes and the
     aria-pressed chips** — Phase L tests pin them. Keep the three existing export names as thin
     aliases for one release so `session-videos-level-filter-phaseL` and
     `teacher-academic-level-phaseL` stay green.
2. **One pure label module** `src/lib/academic-level-labels.ts`:
   `levelLabel(level)`, `courseLabel({nameAr,name,academicLevel})`,
   `lessonOptionLabel({academicLevel, officialCode, titleAr, title, unitTitle})`. Consumed by
   `academic-level-ui.tsx`, `teacher-authoring.tsx`, `teacher-sessions.tsx`, `session-videos-view.tsx`
   and the mock-exam view. Pure ⇒ directly testable without DOM.
3. **One query-param helper** `parseAcademicLevelParam(searchParams) →
   { ok, level|null } | { ok:false }` wrapping `normalizeAcademicLevel`, referenced by every list
   route, so "unknown = 400, `all`/absent = no narrowing" is defined **once** for admin and teacher
   alike. (`src/lib/teacher-academic-level.ts` already implements exactly this for teachers —
   promote it, do not fork it.)
4. **One placement rule** (documented in the component's header comment and enforced in review):

| Situation | Control |
|---|---|
| Shared list that can contain both levels | `variant="segmented"` |
| Form/filter bar with many controls, both levels possible | `variant="select"` |
| Context already locked to one level (student, parent, single course, single group, single lesson) | **no control** |
| Teacher surface, scope may be single-level | `scope={payload.scope}` (self-hiding) |
| Selector where names/codes can collide (course, group, lesson pickers) | **always label** with `levelLabel`, even without a filter |
| Enrollment / registration / student pickers | never a free level choice — the server derives it |

5. **Server-side rule.** A filter is only real if it travels to the API as `?academicLevel=` and the
   route narrows the query with `groupsOfLevelWhere` / `Course.academicLevel` / the derived
   `Lesson.academicLevel` cache. Client-side row hiding is forbidden (the current CoursesView filter,
   A5, is the one exception to be removed or explicitly documented).

---

## I. LANDING PAGE — CURRENT-STATE CRITIQUE

**Structure today** (`app-shell.tsx` render order → `landing/hero.tsx` + `landing/sections.tsx`):

| Order | Section | Anchor | Notes |
|---|---|---|---|
| 0 | Hero + `LandingNav` | *(none)* | nav links to `#why #curriculum #features #pricing #faq`; hero CTA → `register`; secondary → `#curriculum` |
| 1 | Why | `#why` | 6 value cards (`landing.010–021`) |
| 2 | Journey | `#journey` | 5 steps (`landing.025–034`) |
| 3 | Curriculum | `#curriculum` | hardcoded 2 parts / 7 unit cards with hardcoded lesson counts |
| 4 | Features | `#features` | 8 feature cards |
| 5 | Parent | *(none)* | + one `MiniStat 92% Attendance` (l.395) |
| 6 | Pricing | `#pricing` | live from `/api/subscription-plans`; skeleton/retry/empty; closed plans struck through + disabled |
| 7 | Testimonials | *(none)* | 3 hardcoded people, 5-star each |
| 8 | FAQ | `#faq` | 5 Q&A (`landing.084–095`) |
| 9 | Final CTA | *(none)* | `landing.108–112` |
| 10 | Footer | *(none)* | `SUPPORT_CONTACTS` + tel/WhatsApp + brand block |

**Findings, ordered by severity.**

| # | Finding | Evidence | Severity |
|---|---|---|---|
| I1 | **Prohibited claim — free first lesson.** «أول Lesson مجانية!» / "First lesson free!" | `i18n-dict.ts:765` (`landing.109`), rendered by `FinalCtaSection` | **BLOCKER** |
| I2 | **Prohibited claim — "start for free"** in three places: hero nav CTA (`t.nav.startFree`), final CTA (`landing.110`), and the same string in `i18n-core.ts` (l.134 AR / l.181 EN) | `hero.tsx:300`, `sections.tsx` FinalCta | **BLOCKER** |
| I3 | **Unverifiable numbers**: hero stats «+500 طالب», «92% Attendance», «4.9★ تقييم»; `landing.109` repeats "500+ students"; `ParentSection` repeats 92% | `hero.tsx:103–104`, `sections.tsx:395`, `i18n-dict.ts:765` | **HIGH** |
| I4 | **Curriculum Explorer is factually wrong.** Part One units listed 4/4/4/4 (real 4/3/3/4), Part Two 6/6/7 (real 3/3/3) ⇒ implied total **35 lessons vs the real 23**. It also describes **only** Second Secondary while First Secondary (1 part / 13 units / 62 lessons) is live. | `sections.tsx:174–270` vs `docs/curriculum/*/knowledge-model.json` | **HIGH** |
| I5 | **Testimonials are hardcoded fictional identities** ("Mariam A.", "Mr. Adel", "Youssef M.") with 5-star ratings and a `4.9★` claim. "Social proof if truthful" is not satisfied. | `sections.tsx:741–800` | **HIGH** |
| I6 | **Level-blind positioning.** FAQ says "For 2nd-secondary students" (`landing.085`); `brand.description` says «الصف الثاني»; the curriculum section says "the official secondary-school curriculum" singular; meta description/OG speak generically. First Secondary students/parents are not addressed anywhere. | `i18n-dict.ts:742`, `brand.ts:68` | **HIGH** |
| I7 | **Trial-flavoured dictionary residue**: «لفترة محدودة — استفيد من العرض» (`landing.067`), «الأنسب للتجربة» (`landing.070`), «كل مميزات Early Bird» (`landing.071`) still exist in the dictionary although the PricingSection no longer renders them (verified: no component references). They are a latent re-introduction risk, and the pinned test forbids a hardcoded `Early Bird"` literal in the landing source. | `i18n-dict.ts:725/728/729` | **MEDIUM** (delete the residue in M6) |
| I8 | Operational claims stated as universal facts: "two sessions a week" (`landing.011/044`), "every session is recorded and available to all active subscribers" (`landing.089`), "subscription activates within 24 hours" (`landing.087`). | `i18n-dict.ts` | **MEDIUM** (verify with the owner or soften) |
| I9 | Payment phone is written into FAQ copy as text rather than read from `brand.payments` (`landing.093`). | `i18n-dict.ts:750` | **LOW** |
| I10 | Navigation is duplicated and inconsistent: the hero nav has 5 anchors; the footer has its own link set; the shell renders the landing from a hardcoded component list (adding a section means editing `app-shell.tsx`). | `app-shell.tsx:96–110` | **MEDIUM** (IA refactor) |
| I11 | No level selection anywhere pre-registration except the `register` form's cascading Level→Track selects (`auth-view.tsx:519–555`), which is the right place but is discovered only *after* clicking a CTA that promises something else ("Start for free"). | — | **MEDIUM** |

**Constraints to preserve (pinned by tests).** `tests/post-launch-notifications.test.js` asserts the
landing pricing section: must fetch `/api/subscription-plans`; must **not** contain a hardcoded plan
array or the literal `Early Bird"`; must flag closed plans with `plan.023`; must disable the CTA
(`disabled={closed}` + `if (!closed) setView("register")`); must keep `Skeleton` loading; must keep
the honest empty/failure states (`plan.034/035/036`); must never fall back to fake prices. The same
suite pins the footer's `SUPPORT_CONTACTS` + `telLink` + `whatsappLink`. **Any landing redesign must
keep these or update the pins deliberately and visibly.**

---

## J. PROPOSED LANDING-PAGE INFORMATION ARCHITECTURE (Phase M target)

Direction: **dark premium, emerald/teal/amber gradients, Cairo-first Arabic RTL, modern
programming/AI feel** — unchanged identity, new spine. Target order (12 blocks):

| # | Section | Purpose | Content source / rule |
|---|---|---|---|
| 1 | **Hero (brand-level)** | One sentence the whole brand owns + the two levels named explicitly | No counters, no ratings. Primary CTA: **«اعمل حسابك»** (register). Secondary CTA: **«شوف المنهج»** → #5. |
| 2 | **Choose Your Path** | The level×track decision made obvious before registration | Render **only offered pairs** from `GET /api/registration/options` (`computeRegistrationOfferings`): First Secondary + its tracks, Second Secondary + its tracks. Two cards, each listing its tracks, feeding `register?level=&track=`. |
| 3 | **Why CodeMind** | Differentiators (live classes, recordings, quizzes, homework, parent follow-up, small groups) | Existing `landing.010–021` copy, de-duplicated, no numbers. |
| 4 | **How It Works** | Account → group → subscribe → learn → track | `landing.025–034`, with the honest payment/approval wording (no free step). |
| 5 | **Curriculum Explorer (per level)** | Proof of academic seriousness | **Generated from the curriculum model**, not hardcoded: First = 1 part / 13 units / 62 lessons; Second = 2 parts / 7 units / 23 lessons. Tabs (First | Second) → unit cards → lesson counts. Single source module shared with any future admin/landing reuse. |
| 6 | **Platform Features** | The product, section by section | `landing.043–052` (features), each with a screenshot-free, truthful description. |
| 7 | **Parent Experience** | Parent dashboard, weekly/monthly reports, absence cases | `landing.056–065`; remove the 92% stat. |
| 8 | **Pricing** | The real, live plans | Unchanged implementation (live API, closed-plan treatment, honest states). **No trial language. Pricing stays level-agnostic.** |
| 9 | **Testimonials / social proof** | *Only if truthful* | **If no verifiable, consented quotes exist:** replace this slot with a **Product Proof** section (real screens/flow of the platform, "what you get inside") — never invented names, never a rating. Owner decision required. |
| 10 | **FAQ** | Two levels, payments, recordings, subscription expiry, level choice, parent access | Rewrite `landing.084–095`; explicitly answer "which level?" and "what happens when my subscription ends?"; no free lesson. |
| 11 | **Final CTA** | Register + WhatsApp | CTA copy must be `اعمل حسابك` / `ابدأ رحلتك`; **never** "مجاناً". |
| 12 | **Footer** | Contact roster, platform links, curriculum links, legal | Keep `SUPPORT_CONTACTS` + tel/WhatsApp behaviour (pinned by tests). |

**Cross-cutting landing requirements.**

* **F1** Single `landingSections` registry so `app-shell.tsx` no longer hardcodes the order (I10).
* **F2** Nav anchors stay stable (`#why`, `#curriculum`, `#features`, `#pricing`, `#faq`) and gain
  `#path`; add a mobile menu — today the nav links are `hidden lg:flex` and only reachable in the
  footer (documented Phase 26A workaround).
* **F3** Metadata/SEO per level: `layout.tsx` metadata + OG become level-aware (title/description
  mention both levels and the year), and `brand.description` is corrected.
* **F4** A **copy-truth test** (new, M6) that fails the build if any banned claim returns:
  `ابدأ مجان`, `Start for free`, `free trial`, `أول درس مجان`, `First lesson free`, and any
  `+NNN`/`NN%`/`N.N★` literal in `landing/*.tsx`.
* **F5** Fonts: today `--font-sans: Cairo, Geist Mono fallback` — **Inter is not installed**. Add a
  self-hosted Inter (OFL, subset) for Latin/numerals, keep Cairo for Arabic and as the first family,
  and keep the no-network-at-build property (the repo self-hosts Cairo in `src/fonts/`).

---

## K. DESIGN-SYSTEM INCONSISTENCIES

| # | Area | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| K1 | Loading / Error / Empty | Three private implementations (`admin-dashboard.tsx` 188/198/212, `student-dashboard.tsx` 1096/1119, `teacher-dashboard.tsx` 571/591) + per-view one-offs; `Skeleton` used 191 times with ad-hoc heights. | repo-wide | One `AsyncState` primitive set: `LoadingBlock` (rows/skeleton count), `ErrorBlock` (message + retry), `EmptyBlock` (icon + title + hint + optional action). Views pass shapes, not markup. |
| K2 | Filter bars | Five different patterns: plain `Select` (Students/Courses/Question Bank), `FilterSelect` with a visible label (Session workflow), segmented chips (Session Videos level, school-type tabs), counted tabs (Students, Mock exams), `EntitySelect` (Live Ops). | §A rows | One `FilterBar` + `FilterField` shell, with the level control from §H as a first-class citizen. |
| K3 | Card hierarchy | `glass`, `glass-strong`, `card-hover`, `card-lift`, `gradient-border`, plain `border` cards are combined ad hoc per page. | 18 files | Document 3 tiers: *surface* (default card), *interactive* (hover/lift), *hero* (glass/gradient) and enforce by review. |
| K4 | Tables | 15 tables, each wrapping its own `overflow-auto` + `max-h`; no shared table shell (no built-in empty/loading/pagination). `ManageGroupDialog` even paginates in the client (A4). | repo-wide | `DataTable` shell (sticky header, horizontal scroll, empty/loading slots, pagination footer). |
| K5 | Badges | Status/difficulty/track/level badges are re-declared per view; only `AcademicLevelBadge` and `TrackScopeBadge` are shared; label maps are duplicated. | 20+ sites | Shared `StatusBadge` + central label maps (`enumLabel(enum, value)`). |
| K6 | Destructive actions | Mixed: shared `ConfirmDialog`/`AlertDialog` in most admin flows, but **native `confirm()` survives in 4 places** (admin coupons l.5187, quiz-runner l.262, mock-exam l.355, teacher templates l.3192). | grep | Ban `window.confirm`; route all destructive actions through `ConfirmDialog` with the entity named (as `StudentProfileDrawer` already does). |
| K7 | RTL | Excellent overall — only 6 physical-utility sites remain (`ui/sheet.tsx` ×4, `ui/drawer.tsx` ×2, `support-card`, `entity-select`, `progression-override-section`), and they are deliberate (documented Radix anchoring). `flip-rtl` handles directional icons (`globals.css:371`). | grep | Finish the sweep; keep the documented exceptions in `sheet.tsx`/`drawer.tsx` and annotate them. |
| K8 | Long Arabic content | Truncation is inconsistent (`truncate` vs `line-clamp-2` vs none); `min-w-0` chains are manually maintained and fragile (the shell comments prove past breakage). | shell + views | Document the rule (any flex child containing user text gets `min-w-0`; Arabic titles truncate with a `title` attribute) and add a 360px AR visual check to the QA script. |
| K9 | Mobile navigation | Admin sidebar → `Sheet` drawer works; but **landing nav has no mobile menu** (links hidden below `lg`) and admin tables rely on horizontal scroll with no affordance. | `hero.tsx:283`, `shell.tsx` | Add a landing mobile menu; add a scroll hint/edge fade on wide tables. |
| K10 | Hardcoded English | Isolated but present: `admin-dashboard.tsx` l.1659 ("Teacher applications"), l.5457 ("Revenue by Month"), l.5888/5892 ("Expiring this month"/"Expected renewal"); several table headers ("Specialty", "Actions", "Lessons", "Parts", "Groups"). | grep | Route through the dict; add an AR/EN key-coverage check to the i18n audit gate. |
| K11 | Spacing rhythm | Section padding is consistent on the landing (`py-24 sm:py-32`) but dashboard pages mix `space-y-4` / `space-y-6` / `p-4` / `p-5` / `p-6` for equivalent blocks. | repo-wide | Declare a spacing scale in the design-system doc and apply per sub-phase. |
| K12 | Error boundaries | One global `ErrorBoundary` + a per-view error state story; no `error.tsx`/`loading.tsx` route files (the app is a single client shell, so this is by design). | `app/` | Keep; document the single-shell constraint so future contributors do not add route segments casually. |

---

## L. PROPOSED PHASE M SUB-PHASES

Each sub-phase is independently shippable, testable and revertible. No sub-phase changes the schema,
authorization semantics, pricing, or curriculum.

### M1 — Shared vocabulary & primitives (no visible behaviour change)
* Consolidate `AcademicLevelFilter` (§H.1–3) behind the existing export names; add
  `academic-level-labels.ts` and `parseAcademicLevelParam`.
* Extract `AsyncState` (`LoadingBlock`/`ErrorBlock`/`EmptyBlock`) into `src/components/shared/`.
* Add `FilterBar`/`FilterField`, `DataTable` shell, `StatusBadge` (opt-in adoption).
* **Exit criteria:** all existing Phase K/L source pins green; `tsc --noEmit`; zero DOM-attribute
  changes (`data-academic-level-filter`, `data-academic-level-scope`, `data-view`).

### M2 — Admin multi-level UX & filter consistency
* A2 group-assignment options (course + level + track, level-scoped list), A3 teacher level chips +
  filter, A4 groups filter bar + server-side member list, A5 server-side course level filter,
  A9 mock-exam level filter, A10 quiz-review level column/filter, A11 live-ops option labels +
  filter, A7 published-videos level narrowing, A20 surface `/api/admin/level-mismatches`.
* Overview (A1): level breakdown + fixed distribution labels.
* A17 progression-override picker (highest-severity fix).
* Nav grouping in `dashboard/shell.tsx` (view keys unchanged).

### M3 — Teacher multi-level polish
* B4 live-sessions filter + `?academicLevel=` support on `/api/live-sessions`.
* B5/B6/B10 unify list-filter ↔ picker scope (seed the picker from the list filter, allow override,
  state the scope in the dialog).
* Micro-copy for when/why the separator appears (`teacher.312` reuse).
* B12 level in materials/video headers.

### M4 — Student & Parent context clarity
* Student: expose `academicLevel` on `current-course` + dashboard payloads; render a passive level
  label in the course/dashboard header (C1–C4, C9).
* Parent: add `academicLevel` to the child payloads (`dashboard`, `academics`, `analytics`,
  `weekly-report`); render it in the child switcher, child card and report headers; **remove the
  `"2nd Secondary"` fallback** (D1–D5).
* **No switchers, no filters, no new authority.**

### M5 — Money, notifications & reports context
* Payments/subscriptions: display-only level + track + course context; revenue/CSV level dimensions
  (§E).
* Notifications: implement the audience model of §F **only after owner sign-off**, preserving the
  Phase 17 preference/quiet-hour contract; add the recipient preview.
* Analytics: level dimension on revenue/forecast; level+track columns in the progress CSV.

### M6 — Landing architecture & copy-truth pass
* Rebuild the landing on the §J IA; delete prohibited/unverifiable claims (§I1–I5); per-level
  Curriculum Explorer generated from the curriculum model; level-aware FAQ/metadata/OG;
  Cairo + Inter fonts; landing mobile menu; section registry.
* Add the copy-truth test (F4) and keep the pinned pricing/footer behaviour.

### M7 — Design system, responsive/RTL sweep & release gate
* Adopt §K primitives across the touched surfaces; finish the physical-utility sweep; add the 360px
  AR/EN visual check; document the spacing/truncation rules.
* Publish the release gate (§O) as an enforced checklist; wire it into the Phase M/N deploy runbook.

---

## M. EXACT FILES LIKELY TO CHANGE PER SUB-PHASE

> Paths are relative to the repo root. "NEW" = created in that sub-phase.

**M1 — primitives**
* `src/components/admin/academic-level-ui.tsx` (consolidate; keep export names)
* NEW `src/lib/academic-level-labels.ts`
* NEW `src/components/shared/async-state.tsx`
* NEW `src/components/shared/filter-bar.tsx`
* NEW `src/components/shared/data-table.tsx`
* NEW `src/components/shared/status-badge.tsx`
* `src/lib/teacher-academic-level.ts` (re-export `parseAcademicLevelParam`)
* NEW `tests/phase-m-primitives.test.js`; extensions to
  `tests/teacher-academic-level-phaseL.test.js`, `tests/session-videos-level-filter-phaseL.test.js`,
  `tests/academic-level-phaseK-manualqa.test.js`

**M2 — admin**
* `src/components/admin/admin-dashboard.tsx` (Students/Groups/Courses/Teachers/Overview/Question
  Bank/Mock subjects; the monolith is the main risk — consider extracting `views/*` modules)
* `src/components/admin/live-ops-view.tsx`, `mock-exams-view.tsx`, `quiz-review-view.tsx`,
  `session-videos-view.tsx`, `progression-override-section.tsx`, `session-workflow-shared.tsx`
* `src/components/dashboard/shell.tsx` (nav grouping)
* `src/app/api/admin/overview/route.ts`, `courses/route.ts`, `groups/route.ts`, `teachers/route.ts`,
  `mock-exams/route.ts`, `quiz-attempts/route.ts`, `session-videos/route.ts`, `revenue-analytics/route.ts`,
  `revenue-forecast/route.ts`, `export-progress/route.ts`, `students/route.ts`
* `src/lib/i18n-dict-2026.ts` (new admin keys)
* Tests: `tests/admin-course-counts-phaseL.test.js`, `tests/admin-student-track-phaseL.test.js`,
  `tests/phase26c-admin-full-flow.test.js`, `tests/post-launch-notifications.test.js`

**M3 — teacher**
* `src/components/teacher/live-sessions-workspace.tsx`, `teacher-dashboard.tsx`,
  `teacher-authoring.tsx`, `teacher-sessions.tsx`, `readiness-view.tsx`
* `src/app/api/live-sessions/route.ts` (level param), `src/app/api/teacher/*/route.ts` (reuse the
  shared param helper)
* Tests: `tests/teacher-academic-level-phaseL.test.js`, `tests/teacher-live-session-identity-phaseL.test.js`,
  `tests/phase-f-live-sessions.test.js`, `tests/teacher-workflow-phase18.test.js`

**M4 — student/parent**
* `src/components/student/student-dashboard.tsx`, `student/payment-status.tsx`,
  `course/student-course.tsx`, `course/session-videos-view.tsx`
* `src/components/parent/child-switcher.tsx`, `parent-dashboard.tsx`, `academic-followup.tsx`,
  `analytics-view.tsx`, `weekly-report.tsx`, `monthly-report.tsx`
* `src/app/api/students/me/current-course/route.ts`, `students/me/dashboard/route.ts`,
  `students/me/payments/route.ts`
* `src/app/api/parents/me/{dashboard,academics,analytics,weekly-report}/route.ts`,
  `src/lib/parent-academics.ts`
* Tests: `tests/parent-dashboard-isolation.test.js`, `tests/parent-analytics-alignment-phase19.test.js`,
  `tests/parent-academic-followup-phaseI.test.js`, `tests/parent-monthly-report.test.js`,
  `tests/phase26e-parent-full-flow.test.js`, `tests/phase26b-student-flow.test.js`

**M5 — money/notifications/reports**
* `src/components/admin/payment-review-drawer.tsx`, `admin-dashboard.tsx` (payments/subscriptions/
  notifications/analytics sections), `src/components/shared/notifications-panel.tsx`
* `src/app/api/admin/payments/route.ts`, `subscriptions/route.ts`, `notifications/route.ts`,
  `notifications-center/route.ts`, `revenue-analytics/route.ts`, `export-progress/route.ts`
* `src/lib/payment-ux.ts`, `src/lib/notify.ts` (read-only reuse + preview helper)
* Tests: `tests/payment-experience-phase25-pr3.test.js`, `tests/post-launch-notifications.test.js`,
  `tests/session-notifications-phase17.test.js`, `tests/phase-g-batch2-attempt-notifications.test.js`

**M6 — landing**
* `src/components/landing/hero.tsx`, `src/components/landing/sections.tsx` (+ NEW
  `landing/curriculum-explorer.tsx`, NEW `landing/sections-registry.ts`)
* `src/components/app-shell.tsx` (section registry)
* `src/lib/i18n-dict.ts` (landing.0xx rewrites/removals), `src/lib/i18n-core.ts` (`nav.*`),
  `src/lib/brand.ts`
* `src/app/layout.tsx` (metadata/OG), `src/app/globals.css` (+Inter family),
  NEW `src/fonts/Inter-*.woff2` + OFL notice
* NEW `src/lib/landing-curriculum.ts` (reads the curriculum model for the explorer)
* Tests: NEW `tests/landing-copy-truth-phaseM.test.js`; keep/extend
  `tests/post-launch-notifications.test.js` pins

**M7 — design system / release gate**
* `src/app/globals.css`, `src/components/ui/{sheet,drawer}.tsx` (annotated exceptions)
* Cross-cutting adoption files listed in §K
* NEW `docs/PHASE_M_RELEASE_GATE.md` (or a section in `docs/GO_LIVE_RUNBOOK.md`), updated
  `docs/VERCEL_PRODUCTION_RUNBOOK.md`, `.github/workflows/migration-providers-postgres.yml`
  (unchanged, referenced), `tests/phase25-pr4-release-gate.test.js` (extend)

---

## N. RISKS / REGRESSION AREAS

| # | Risk | Why it matters | Mitigation |
|---|---|---|---|
| N1 | **Source-pin test suites.** 113 test files; several assert exact component strings (`OptionalAcademicLevelFilter` wiring, `buildLessonGroups`, view-role triads, i18n keys, RTL). | A "clean" refactor can turn 20 suites red. | Land M1 with **aliases and preserved DOM attributes**; update pins only deliberately, in the same PR as the behaviour change, and record it. |
| N2 | **`admin-dashboard.tsx` is 5,902 lines.** Nearly every admin change touches it. | Merge conflicts, set-state-in-effect lint errors, review fatigue. | Extract per-view modules during M2 behind the existing `data-view`/`renderView` contract; do not rename view keys. |
| N3 | **Shared course display name.** | Every unlabelled course/group/lesson list is ambiguous; every "fix" that assumes names are unique is wrong. | Level labels everywhere names can collide; never resolve by name or `officialCode`. |
| N4 | **Landing is the public entry point.** | Copy/IA changes affect SEO, OG, conversion, and a pinned test. | Keep the pinned pricing/footer contracts; add the banned-claim test before rewriting copy; stage behind a preview deploy. |
| N5 | **Testimonials / numbers removal is a business decision.** | Only the owner can supply verifiable quotes/statistics. | Present as an explicit owner decision in §P; default to removal. |
| N6 | **Payments & entitlement.** | The review drawer is the money path; a projection change could desynchronise the queue from `evaluateAccessDecision`. | Additive display fields only; never compute entitlement in the client; extend the existing ledger/experience tests. |
| N7 | **Notification targeting.** | Preference/quiet-hour enforcement is a hard contract; a naive `createMany` bypass was already a fixed defect. | Route any new audience through `partitionByNotificationPreferences`; add tests for level/track audiences with prefs on/off. |
| N8 | **Parent payload additions.** | Parent suites pin payload shapes and privacy rules (no ids/answers, no nationalId/parentPhone). | Additive fields only; keep `studentId` the single id exception; re-run the parent privacy tests. |
| N9 | **RTL regressions.** | `phase-g-batch4b-rtl` and the sidebar docs exist because RTL/LTR anchoring broke before. | Logical properties only; keep the documented physical exceptions in `sheet.tsx`/`drawer.tsx`; visual check at 360px in AR and EN. |
| N10 | **Production schema drift (the Phase L lesson).** | Green app + green CI + stale Neon schema = runtime failures that no build catches. | Enforce §O on every phase containing migrations (Phase M itself should contain **none**). |
| N11 | **Scope creep into Phase N.** | The brief separates M (UX/landing) from N. | §P out-of-scope list is binding for M1–M7. |

---

## O. MANDATORY PRODUCTION RELEASE GATE (Phase M/N onward)

**The lesson:** after Phase L, the application deployed and Vercel CI was green while the Neon
production schema was still behind. Application code, CI, and database state are three independent
facts; a green build proves only the first.

**Therefore, every future phase that contains a DB migration MUST prove all eight steps, in order,
with captured evidence (command + output + timestamp) attached to the phase report:**

1. **Local migration verification.**
   `npx prisma migrate dev` (or `migrate deploy` on a disposable local DB) + `npx prisma migrate status`
   against the SQLite schema; regenerate and verify the PostgreSQL mirror:
   `node scripts/db/make-postgres-schema.mjs && node scripts/db/make-postgres-schema.mjs --check`.
   The `migration-providers-postgres` workflow must run **and not skip** (a skip is a failure).
2. **Production backup / restore point.**
   A fresh Neon branch (or documented PITR window) is created and its existence + retention window is
   recorded **before** any DDL. Offsite `pg_dump` per the runbook if the window is short.
3. **Production DB identity confirmed.**
   Print the target's project/branch/region and `SELECT current_database(), current_user, version()`.
   Confirm it is the **application** database — not a preview branch, not a local instance — and that
   the URL is redacted in the log.
4. **Direct Neon connection for migration operations.**
   `DATABASE_URL` for Prisma migrate must be the **direct** endpoint (host **without** `-pooler`,
   `sslmode=verify-full`). The runtime/Vercel connection stays **pooled**. DDL and
   `_prisma_migrations` bookkeeping must never run through transaction-mode pooling.
5. **`prisma migrate status` against Production** — before deploy, using
   `--schema prisma/postgres/schema.prisma` and the direct URL. It must report the exact pending set
   (or "up to date"); an unexpected pending/diverged state **stops the release**.
6. **`prisma migrate deploy` if needed** — same schema, same direct URL, migrations read only from
   `prisma/postgres/migrations` (never `prisma/migrations`). Never `migrate reset`, never
   `db push --accept-data-loss`, never `DROP`/`TRUNCATE`.
7. **Post-deploy production schema verification** — re-run `prisma migrate status` (must be "up to
   date") **and** verify the phase's own objects exist (columns/enums/indexes/constraints) with a
   read-only query or the repo's inspection script; confirm the ledger row for each new migration.
8. **Application runtime verification** — after the Vercel deploy: sign in as each affected role, run
   the phase's own flows against production, check server logs for the new code paths, confirm the
   cron still fires, and confirm the pooled runtime connection is healthy.

**Additional standing rules:** migrations are byte-frozen (checksum contract — never edit an applied
migration); the schema mirror is a generated artifact (`prisma/postgres/schema.prisma` must be
regenerated, never hand-edited); `SKIP_PRODUCTION_ENV_CHECK=1` is a **build-host** convenience only —
the runtime guard in `instrumentation.ts` still enforces the production secret contract.

*Phase M itself introduces no migration; this gate is written now so Phase N and every later phase
inherits it. Migration automation is explicitly out of scope for M0.*

---

## P. OUT-OF-SCOPE LIST (binding for Phase M)

Not to be done in Phase M — including M0:

1. **No schema change, no migration, no seed change, no data rewrite.**
2. **No `Teacher.academicLevel`** (and no teacher-level column under another name). Teacher scope
   stays derived `Teacher → Group → Course.academicLevel`.
3. **No `GENERAL`** (or any other new value) in `AcademicLevel`; no Program/Course-Type model.
   Phase M only avoids *hard-wiring* the UI so a future `SCHOOL_CURRICULUM` / `GENERAL_COURSE`
   program dimension can be added cleanly.
4. **No curriculum change** — no part/unit/lesson additions, no `officialCode` changes, no
   reconciliation runs altering content.
5. **No pricing-model change** — prices, plans, durations, promo flags, and the level-agnostic plan
   model stay as they are. No level-dependent pricing.
6. **No free trial / free first lesson** — and no copy implying one, anywhere (landing, auth, enroll,
   dashboard, notifications).
7. **No authorization weakening** — no filter may widen a scope; unknown `academicLevel` stays a 400;
   group/level and group/track pairing rules stay exactly as enforced today.
8. **No new level switcher for students or parents**; no level choice on student/parent surfaces
   beyond the existing registration/enrollment flows.
9. **No landing redesign before M6 approval**, and no invented testimonials, ratings or statistics.
10. **No Phase N work** (migration automation, production schema-drift automation, program model,
    general courses) in this phase.
11. **No `prisma db push` / `migrate reset` / destructive SQL** in any environment.
12. **No PR** is opened from M0; M0 ends with this audit and stops for approval.

---

## Appendix — Owner decisions required before M1 starts

| # | Decision | Default if no answer |
|---|---|---|
| D1 | Testimonials: replace with a product-proof section, or obtain verifiable, consented quotes? | Remove the section (product proof). |
| D2 | Which truthful platform numbers, if any, may appear (e.g. total lessons per level from the curriculum model, which *are* verifiable)? | Publish only curriculum-derived counts (62 / 23 lessons, 13 / 7 units). |
| D3 | Operational claims ("two sessions weekly", "recorded and available to all subscribers", "activation within 24 hours") — confirm or soften? | Soften to descriptive wording without cadence/guarantees. |
| D4 | Should the landing show prices before login? (Currently yes, from the public plans API.) | Keep as-is. |
| D5 | Notification targeting scope for M5 (level only, level+track, or full model incl. group+parents)? | Design the full model now; implement level+track+group in M5. |
| D6 | Should the admin "level integrity" diagnostics become a visible card (A20)? | Yes — Overview card. |
| D7 | Does Phase M include the `admin-dashboard.tsx` decomposition, or defer it? | Include it in M2 behind unchanged view keys. |

**STOP — awaiting approval before any implementation.**
