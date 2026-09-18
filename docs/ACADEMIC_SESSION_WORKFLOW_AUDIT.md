# CodeMind Academy — End-to-End Academic Workflow Audit
## Session / Curriculum / Media / Teacher / Student / Progression

**Date:** 2026-09-17
**Branch:** `arena/01a0b179-codemind-academy` (baseline `ffaee07`)
**Phase:** AUDIT & PLANNING ONLY — no implementation, no schema change, no migration, no production changes.
**Method:** full read of `prisma/schema.prisma`, all academic `src/lib/*` domain modules, all academic API routes under `src/app/api`, the client components that render the four portals, phase design docs, and the offline test suite (61 suites run; see §22). Every claim below is anchored to a file/route/model.

---

## 1. Executive Summary

The platform has **one coherent academic skeleton** (Course → Part → Unit → Lesson, with a
reconciled official 2-Part / 7-Unit / 23-Lesson curriculum, a strict `DRAFT → READY → PUBLISHED`
lifecycle on `Lesson`, a single derived progression engine, and one track-isolation system) and
**two parallel, half-connected "session" satellites** that break the end-to-end academic workflow:

| # | Finding | Severity |
|---|---------|----------|
| F1 | **Video identity is split across three readers that use different relations.** Progression reads `Lesson.videoUrl` (legacy column, no longer writable by any API). Readiness reads `Lesson.sessionVideos` (requires `SessionVideo.lessonId` + `isPublished`). The student reader reads `SessionVideo` via `Student.batchId`. The admin upload UI **never sends `lessonId`**, so every video created through the UI is a lesson-less batch video: visible to students as a generic recording, counted by **no** readiness check, and gated by **no** progression check. | CRITICAL |
| F2 | **The "watch video ≥ 95%" progression gate is inert for all lessons staged after Phase 15**, because it only triggers when `Lesson.videoUrl` is non-null and that column is read-only. The modern 95% rule (`SessionVideo.requiredPercent`, watched via `SessionVideoView`) feeds **nothing** downstream: not progression, not readiness, not dashboards, not reports. The "watched the video" requirement of the documented unlock rule does not exist for new lessons. | CRITICAL |
| F3 | **PDFs attach to `Lesson` (Material) but student visibility requires the lesson to be PUBLISHED + unlocked**, while batch videos can be published while the lesson is still DRAFT. Result: an admin can hold a perfectly staged PDF that students cannot see, next to a video that students *can* see — the exact "PDF exists for Admin but not for Student" symptom, fully supported by the code (by design of lifecycle isolation, operator-confusing in practice). | HIGH |
| F4 | **Attendance belongs to `LiveSession` (teacher-scheduled group meeting), not to `Lesson`.** `LiveSession.lessonId` is optional and never enforced. There is **no production API that creates a LiveSession** — only seed scripts do. Teachers can therefore only record attendance for pre-seeded meetings; "session attendance" in the student/teacher/parent dashboards measures a schedule that production workflows cannot extend. | HIGH |
| F5 | **A `SHARED` lesson requires published SessionVideos in BOTH the ARABIC and LANGUAGE batches** to pass readiness (unless a legacy `videoUrl` exists). Publishing one video to one batch shows `VIDEO_TRACK_INCOMPLETE` + `SHARED_VIDEO_MISSING_BATCH:<track>` even though students of that track watch it fine. | HIGH |
| F6 | **Readiness can see a video the student never sees, and the student can see a video readiness never sees.** Readiness counts `Lesson.sessionVideos` regardless of the student's batch/enrollment; the student reader only serves videos of `Student.batchId`. A lesson-linked video published to a batch a given student is not attached to (stale/missing `batchId`) is "READY" from the admin's view while invisible to that student. Conversely a lesson-less batch video is student-visible but readiness-invisible. | HIGH |
| F7 | The student **lesson page renders a video player only from `Lesson.videoUrl`** (`student-lesson.tsx` L450). For lessons with batch SessionVideos (the normal admin flow), the lesson page has no player; the recordings section (fetched by `?lessonId=`) renders nothing because `lessonId` was never set at upload. The course tree's `hasVideo` badge is also `!!lesson.videoUrl` — false for the same lessons. This is the concrete mechanism behind "after uploading videos the course/sessions look empty". | HIGH |
| F8 | Two independent video-watch tracking systems coexist: `LessonProgress.videoWatchedSec/Percent/Completed` (legacy heartbeat, gates progression when `videoUrl` set) and `SessionVideoView` (batch video heartbeat, read only by the recordings list). A student can be "complete" in one world and 0% in the other; dashboards/parents/reports read only the legacy one (`src/lib/progress.ts` filters `videoUrl: { not: null }`). | HIGH |
| F9 | Teacher scope = `Group.teacherId → Group.courseId → lessons of that course` (all lifecycle states). Teachers can create Quiz/Homework/Questions on **DRAFT** lessons — so a teacher-created empty quiz makes the admin's Mark Ready fail (`QUIZ_EMPTY`) with no teacher-side visibility of that coupling. Teachers cannot create lessons, upload media, schedule LiveSessions, mark ready, publish, or grade mock exams. | MEDIUM |
| F10 | No Admin/Teacher override exists to complete a student's lesson or satisfy a gate. The only progression-related override in the platform is the Admin `QuizRetryGrant` (one extra quiz attempt). "Should Admin override unlock a session?" is currently **unanswerable in code** — no such path exists. | MEDIUM |

**Answer to the central question (full detail in §3):** `Lesson` **is** the canonical academic
Session (option A). But the platform simultaneously uses **three other entities whose names contain
"Session"** — `SessionVideo` (batch-published video), `LiveSession` (teacher meeting/attendance),
`SessionPublication` (publication anchor) — so the *facets* of a "session" (its media, its live
attendance, its publication) live on three different entities, two of which only *optionally* link
back to the `Lesson`. The curriculum, lifecycle, readiness, quiz, homework, progression and parent
surfaces all agree on `Lesson`; the **media** and **attendance** facets do not. That split is the
root cause of essentially every observed symptom.

**Verdict (preview, full §24):** the curriculum half of the platform is well-architected and
defensively built (single lifecycle engine, single progression engine, fail-closed track isolation,
frozen quiz attempts). The media/attendance half was built as a *batch publishing system* (Phase
12/23) and a *group meeting system* (Phase 1) that were never joined to the canonical `Lesson`
identity. The fix is **alignment, not a new Session entity**: make `Lesson` the single anchor for
video and (optionally) live attendance, deprecate the legacy `videoUrl`/`pdfUrl` columns, and route
readiness/progression through the same relations the student readers already use.

---

## 2. Current Domain Model

### 2.1 Relationship map (academic core)

```
                              AUTH / IDENTITY
   User ──1:1── Student ──┬──N:1── Group ──N:1── Course
                          ├──N:1── Batch (schoolType × course; media audience)
                          ├──N:1── Subscription (entitlement)
                          └──1:1── Parent? ──via ParentStudentLink──> Student

   User ──1:1── Teacher ──N:1── Group (Group.teacherId; the ONLY teacher scope)
   User ──1:1── Admin  (no extra profile model)

   COURSE SKELETON (one shared course: programming-ai-2nd-sec)
   Course
    └── Part (order)
         └── Unit (order)
              ├── Lesson            ← CANONICAL CHAIN (Lesson.unitId, officialCode)
              │    (23 official lessons 1-1..7-3, CurriculumStatus=OFFICIAL)
              └── Topic (order)     ← LEGACY CHAIN (Lesson.topicId)
                   └── Lesson       (R1 synthetic content; archived after Phase 11)

   FACETS HANGING OFF A Lesson (all canonical, all lesson-anchored)
   Lesson
    ├── status: DRAFT|READY|PUBLISHED   (the ONLY lifecycle source of truth, Phase 13)
    ├── curriculumStatus: OFFICIAL|LEGACY|ARCHIVED   (Phase 11)
    ├── trackScope: SHARED|ARABIC|LANGUAGE           (Phase 12)
    ├── videoUrl / pdfUrl  — legacy string columns, NOT writable by any current API
    ├── SessionPublication (1:0..1, publication anchor + notification counters)
    ├── Quiz (N) ── Question (N) ── QuizAttempt (per student) ── QuizAnswer (frozen)
    │        └── QuizRetryGrant (Admin-only, per student+quiz)
    ├── Homework (N) ── HomeworkSubmission (per student)
    ├── Material (N) ── MediaAsset (DOCUMENT, private)     ← PDF
    ├── SessionVideo (N) ── MediaAsset (VIDEO)             ← see 2.2 for the split
    │        ├── batchId  (REQUIRED — the video's "home")
    │        └── lessonId (OPTIONAL — the admin UI never sets it)
    ├── LessonProgress (per student) — incl. legacy video watch fields
    ├── LiveSession (N) — teacher meeting, lessonId OPTIONAL   ← attendance home
    │        └── Attendance (per student, unique per pair)
    ├── LessonBookmark / LessonNote (per student)
    └── ExamQuestion (N, mostly unused; bank for mock exams)

   BATCH PUBLISHING UNIVERSE (Phase 12/23)
   Batch (unique schoolType × courseId)
    ├── students: Student[]  (Student.batchId — sticky, reconciled lazily)
    └── videos:   SessionVideo[]  (isPublished flag = its own mini-lifecycle)
   MediaAsset (storage: LOCAL_PRIVATE | S3 | EXTERNAL_URL)
    ├── SessionVideo[]
    ├── Material[]
    └── QuizAttemptEvidence[]

   MOCK EXAM UNIVERSE (separate domain, §10)
   MockExam (schoolType, courseId, isPublished, selectionMode)
    └── MockExamQuestion ── Question | ExamQuestion
   ExamAttempt (student, mockExamId nullable, frozen paper)
```

### 2.2 Model inventory

For every relevant model: purpose, parent, children, scope/lifecycle/ownership fields,
canonical vs legacy, and production use.

| Model | Primary purpose | Parent | Children | Scope / lifecycle / ownership fields | Canonical? | Used by production routes? |
|---|---|---|---|---|---|---|
| `Course` | The single shared course | — | Part, Group, Batch, MockExam | `slug` unique | Canonical | Yes (admin courses, student course tree) |
| `Part` / `Unit` | Curriculum structure | Course / Part | Unit / (Topic, Lesson) | `order` | Canonical | Yes |
| `Topic` | Legacy mid-layer | Unit | Lesson | `order` | **Legacy** (kept for R1 content) | Yes (dual-chain reads only) |
| `Lesson` | **THE canonical academic session** | Unit and/or Topic | Quiz, Homework, Material, SessionVideo, LiveSession, LessonProgress, bookmarks, notes, ExamQuestion | `officialCode` (unique), `trackScope`, `status` (lifecycle), `curriculumStatus`, `videoUrl`/`pdfUrl` (legacy, read-only), `isPublished` (deprecated mirror), `isLocked` (retired/inert) | **Canonical** | Yes — every academic route |
| `SessionPublication` | Publication anchor + Phase 17 notification counters | Lesson (1:1 unique) | — | `segment` (audit only), `publishedAt`, `publishedByUserId`, `notifiedCount/At` | Canonical | Yes (open ceremony, notifications, recipients preview) |
| `Batch` | Media audience = school type × course | Course (nullable) | Student, SessionVideo | `schoolType` (non-null), `isActive`, unique(schoolType, courseId) | Canonical (media dimension) | Yes (admin batches, student video reader) |
| `Group` | Teaching group; the enrollment gate; the teacher scope | Course | Student, LiveSession | `teacherId`, `trackScope` (audience, Phase 26B), `isActive`, `schedule` | Canonical | Yes (enrollment, teacher scope, attendance) |
| `Enrollment` | (intended) student↔course enrollment | Student, Course, Track | — | `status`, `startsAt/endsAt` | **DEAD SCHEMA** (documented: never read/written; the `Enrollment` TYPE in `src/lib/enrollment.ts` is an unrelated in-memory projection) | **No** |
| `Track` | (intended) track entity | — | Course, Enrollment | `code`, `nameAr` | **DEAD SCHEMA** (Phase 12 verdict; `Course.trackId`/`Enrollment.trackId` always NULL) | **No** |
| `Student` | Student profile | User (1:1) | Attendance, QuizAttempt, HomeworkSubmission, LessonProgress, SessionVideoView, bookmarks, notes | `schoolType` (track truth), `groupId`, `batchId`, `studentCode` | Canonical | Yes |
| `Teacher` | Teacher profile | User (1:1) | Group, LiveSession, LessonPlanTemplate, TeacherNote | `specialty`, `bio` | Canonical | Yes |
| `Parent` / `ParentStudentLink` | Parent↔child linkage | User / (Parent, Student) | — | `relation` | Canonical | Yes |
| `SessionVideo` | A video **published to a batch**, optionally linked to a lesson | **Batch (required)**, Lesson (optional), MediaAsset | SessionVideoView | `requiredPercent` (default 95), `isPublished`/`publishedAt` (its own flag), `trackScope` intentionally absent — track IS `batch.schoolType` | Canonical for the *batch-publishing* system; **the lesson link is vestigial in practice** (UI never sets it) | Yes (admin session-videos, student session-videos, media streaming) |
| `MediaAsset` | Stored bytes (or external URL) | — | SessionVideo, Material, QuizAttemptEvidence | `kind` (VIDEO/IMAGE/DOCUMENT), `storage` (LOCAL_PRIVATE/S3/EXTERNAL_URL), `storageKey`, `isPrivate` | Canonical | Yes (`/api/media/[id]`, `/api/materials/[id]`) |
| `Material` | A session PDF/document attached to a lesson | **Lesson** | MediaAsset | `kind` (GENERATED/ADMIN_UPLOADED), `trackScope`, `isActive` | Canonical | Yes (admin materials, student/parent readers) |
| `Quiz` | Lesson quiz (blueprint over question bank) | **Lesson** | Question, QuizAttempt, QuizRetryGrant | `trackScope`, `passMark`, `timeLimit`, `quizMode` (FIXED/BLUEPRINT), `questionCount`, `maxAttempts` (default 1), `shuffleOptions`, `difficultyPlan` | Canonical | Yes (teacher authoring, student start/submit) |
| `Question` | Question bank row | Quiz (nullable) | QuizAnswer, MockExamQuestion | `schoolType` (NULL=SHARED), `difficulty`, `marks`, `type` | Canonical | Yes |
| `QuizAttempt` | One attempt (frozen question set) | Quiz, Student | QuizAnswer, QuizAttemptEvidence | `attemptNumber`, `status` (OPEN/SUBMITTED/EXPIRED), `passed`, `retryGrantId`, `cameraStatus` | Canonical | Yes |
| `QuizAnswer` | Frozen snapshot of one question in an attempt | Attempt, Question | — | full snapshot columns (Phase 26D) | Canonical | Yes |
| `QuizRetryGrant` | Admin-issued one-time extra attempt | Student, Quiz, User (grantor) | QuizAttempt (lineage) | `consumedAt`, `reason` | Canonical | Yes (`/api/admin/quiz-retries`) |
| `Homework` | Assignment attached to a lesson | **Lesson** | HomeworkSubmission | `trackScope`, `deadline`, `maxMarks` | Canonical | Yes (teacher create/grade, student submit) |
| `HomeworkSubmission` | One student's answer | Homework, Student | — | `status` (PENDING/SUBMITTED/LATE/GRADED), `grade`, `feedback`, `submittedAt` | Canonical | Yes |
| `LiveSession` | **Teacher-scheduled group meeting** (calendar + attendance container) | **Group**, Teacher (opt), Lesson (opt) | Attendance | `startAt`, `duration`, `status` (SCHEDULED/LIVE/COMPLETED/CANCELLED), `meetingUrl`, `recordingUrl`, `lessonId?` | Canonical for *meetings*; **the ONLY production creators are seed scripts** | Yes (read: teacher/student/parent dashboards; write: teacher attendance only) |
| `Attendance` | One student's status in one LiveSession | LiveSession, Student | — | `status` (PRESENT/ABSENT/LATE/EXCUSED), `note`, unique(studentId, sessionId) | Canonical | Yes (teacher read/write; student/parent read aggregates) |
| `LessonProgress` | Per-student lesson state + **legacy** video watch tracking | Lesson, Student | — | `progress`, `isCompleted`, `videoDurationSec`, `videoWatchedSec`, `videoPercent`, `videoCompleted`, `lastHeartbeatAt` | Canonical (progression reads it) | Yes |
| `SessionVideoView` | Per-student watch tracking of a **batch** video | SessionVideo, Student | — | `watchedSec`, `percent`, `isCompleted`, `requiredPercent` via parent | Canonical for the batch system; **dead for progression/readiness/dashboards** | Yes (only `/api/students/me/session-videos*`) |
| `MockExam` / `MockExamQuestion` / `ExamAttempt` / `ExamQuestion` | Admin-controlled mock exam domain | Course (opt), Question/ExamQuestion bank | — | `schoolType`, `selectionMode` (RANDOM/FIXED), `isPublished` | Canonical (separate domain) | Yes (admin mock-exams, `/api/exams/mock`) |
| `TeacherNote`, `LessonBookmark`, `LessonNote`, `StudyTask`, `StudentBadge` | Per-student soft artifacts | Student/(Lesson) | — | — | Canonical | Yes (minor) |
| `Notification`, `NotificationPreference`, `AuditLog`, `SecurityEvent` | Cross-cutting | User | — | `type` enum incl. NEW_LESSON/NEW_QUIZ/NEW_HOMEWORK/LOW_ATTENDANCE… | Canonical | Yes |
| `UserSession`, `PasswordResetToken`, `SecurityRateLimit` | Auth/security (NOT academic sessions) | User | — | — | Canonical | Yes |

**Naming hazard, explicitly flagged:** `Session` appears in `SessionVideo`, `SessionVideoView`,
`LiveSession`, `SessionPublication`, and `UserSession` — five unrelated meanings. The schema's own
comments acknowledge that "a session video is published ONCE and resolved for all eligible
students" (Batch doc) while `Lesson` doc comments call the lesson "the session" ("the
administrative lifecycle of the session"). Both are "the session". This is the linguistic root of
the feature-island perception.

---

## 3. Lesson vs Session — the Answer

> **Question: A) Lesson IS the canonical academic Session; B) Lesson and Session are separate
> entities; C) multiple conflicting representations?**

### Answer: **A — with a split-facet caveat (A + C at the facet level, not at the curriculum level).**

**A holds for the curriculum/lifecycle/readiness/progression/quiz/homework/parent universe.**
Every one of these systems is anchored on `Lesson`:

| System | Anchor relation (verified in code) |
|---|---|
| Curriculum tree | `Lesson.unitId → Unit → Part → Course` (canonical) with `Lesson.topicId` fallback — `src/app/api/courses/[slug]/route.ts` |
| Official curriculum | 23 lessons `1-1..7-3` via `officialCode`, `curriculumStatus=OFFICIAL` — `src/lib/official-curriculum.ts` |
| Lifecycle DRAFT→READY→PUBLISHED | `Lesson.status` — the ONLY lifecycle source of truth; `src/lib/session-lifecycle.ts` |
| Readiness | `computeLessonReadiness` over the Lesson row + its `quizzes/homeworks/sessionVideos/materials` — same module |
| Publication anchor | `SessionPublication.lessonId` (unique) — created by the OPEN ceremony on a Lesson |
| Progression | `getCourseSessionProgress` iterates **lessons**; `canAccessLesson` gates a lesson id — `src/lib/session-progress.ts` |
| Quiz | `Quiz.lessonId` (required FK) |
| Homework | `Homework.lessonId` (required FK) |
| PDF | `Material.lessonId` (required FK) |
| Video (progression side) | `Lesson.videoUrl` (legacy column) + `LessonProgress` |
| Video (readiness side) | `Lesson.sessionVideos` (i.e. `SessionVideo.lessonId`) |
| Parent preview | `isParentLessonPreviewAllowed(parentId, lesson…, courseId)` — lesson-scoped |

There is exactly **one** progression engine, **one** lifecycle engine, **one** track-isolation
module, and one enrollment rule (`Student.groupId → Group.courseId` + subscription entitlement).
The schema comments state this repeatedly and the offline test suite pins it
(`tests/session-progression.test.js`, `tests/session-lifecycle-phase13.test.js`,
`tests/session-media-publishing-audit.test.js`).

**The caveat (why the platform *feels* like C):** three other models carry "session" semantics and
only optionally join back to the canonical `Lesson`:

| Entity | What it really is | Link to Lesson | Consequence |
|---|---|---|---|
| `SessionVideo` | A video published to a **Batch** (the video's home is `batchId`) | `lessonId` — nullable, **never written by the admin UI** | Media facet detached from the lesson identity in practice |
| `LiveSession` | A teacher **meeting** for a Group (calendar + attendance) | `lessonId` — nullable, never enforced, not set by any current write path | Attendance facet detached from the lesson identity in practice |
| `SessionPublication` | The OPEN ceremony's anchor | `lessonId` — required, unique | Fully canonical; no issue |

So: **one academic Session entity (`Lesson`) exists; its two satellite facets (recorded media,
live attendance) live on separate entities whose back-pointers to the Lesson are optional and, for
videos, effectively unused by the production UI.** This is not three curricula — it is one
curriculum plus two loosely-coupled facets. The recommended target model (§18) keeps `Lesson` as
the single source of truth and makes the facet links mandatory, rather than inventing a new
`Session` entity.

### Where the lifecycle lives

- **`Lesson.status`** (`LessonStatus` enum: `DRAFT/READY/PUBLISHED`) is the administrative
  lifecycle — stored, written only by `transitionLesson` in `src/lib/session-lifecycle.ts`.
- **`SessionPublication`** is the publication *anchor* (idempotency key + Phase 17 notification
  counters). It does not gate anything itself.
- **`Lesson.isPublished`** — deprecated boolean mirror, written only by the lifecycle module,
  reported to admin payloads, obeyed by nothing.
- **`Lesson.isLocked`** — retired, inert, not serialized by any API.
- **Student LOCKED/UNLOCKED/COMPLETED** — never stored; derived per student by
  `src/lib/session-progress.ts` (`unlocked = eligibility`).
- `SessionVideo.isPublished` — a **second, independent** publication flag for the batch media
  world. It is the video's own lifecycle and is *not* part of the lesson lifecycle (readiness
  consumes it; the student reader consumes it; progression does not).
- `MockExam.isPublished`, `Group.isActive`, `Batch.isActive` — domain-local flags, unrelated.

---

## 4. Current Curriculum Flow

### 4.1 Student curriculum read path (authoritative reader)

```
Student login (User role=STUDENT, Student profile 1:1)
  → GET /api/students/me/dashboard        (continueLesson, nextSession=LiveSession,
                                          attendance %, latest quiz, pending homework)
  → GET /api/courses/[slug]               THE course tree reader
       viewer slice  = student.schoolType  → trackScopeWhere (SHARED + own track, fail closed)
       lifecycle slice = status: PUBLISHED (LESSON_STUDENT_STATUS_FILTER)
       archive slice   = curriculumStatus != ARCHIVED (EXCLUDE_ARCHIVED_LESSON)
       enrollment      = getEnrollment(): Student.group → Group.isActive → Group.courseId
                         AND subscription-entitlement (Phase 25 PR2a, evaluateAccessDecision)
       tree            = course.parts[].units[].{lessons[], topics[].lessons[]}
                         (canonical unit-linked lessons + legacy topic lessons;
                          unit-linked wins when both links exist)
       status per row  = getCourseSessionProgress(studentId, courseId)
                         → "locked" | "current" | "completed" | "available"
       redaction       = locked rows: no videoUrl/pdfUrl/summary/quiz/homework/materials ids
                         (presence booleans + officialCode remain)
  → GET /api/lessons/[id]                 lesson page (canAccessLesson gate; prev/next from the
                                          same ordered universe; quizzes/homework/materials lists)
```

**Official vs legacy filtering:** `curriculumStatus` is not a student filter per se — the archive
sweep (Phase 11) moved all code-less R1 lessons to `ARCHIVED`, so the active universe is the 23
official lessons plus any `OFFICIAL`/`LEGACY` lessons an admin has re-added. Both chains
(`unitId` / `topicId`) are queried everywhere a lesson universe is built
(`lessonCourseChainOr`), with the canonical chain winning on dual-linked rows — the same
precedence the progression engine and the admin picker use.

**LOCKED / UNLOCKED / COMPLETED:** derived, §13. `PUBLISHED + LOCKED` is a normal state
(visible skeleton, redacted content). `DRAFT/READY` lessons are invisible to students, parents,
and the course tree — visible only to admin (full lifecycle) and teacher (management scope).

**Publication / group / batch / track / archive filters — where each is applied:**

| Filter | Student tree | Student lesson | Homework list | Quiz gates | Materials | Progression universe | Parent preview |
|---|---|---|---|---|---|---|---|
| PUBLISHED (`status`) | ✔ | ✔ | ✔ | ✔ (via lesson) | ✔ | ✔ | ✔ |
| not ARCHIVED | ✔ | ✔ (prev/next) | ✔ | ✔ (via lesson) | ✔ | ✔ | ✔ |
| trackScope (own schoolType) | ✔ | ✔ | ✔ + own track | ✔ (lesson + quiz) | ✔ (lesson + material) | ✔ | ✔ (union of children) |
| enrollment (active group → course + entitlement) | ✔ (route) | ✔ (`canAccessLesson`) | ✔ (`getUnlockedLessonIds`) | ✔ (via lesson) | ✔ | ✔ | ✔ (child enrollment) |
| progression (unlocked) | ✔ (status) | ✔ | ✔ (only unlocked lessons) | ✔ | ✔ | — (it IS the engine) | ✖ (parent sees skeleton only) |
| **batch (Student.batchId)** | ✖ | ✖ (tree) | ✖ | ✖ | ✖ | ✖ | ✖ |
| **Batch video publication** | ✖ | ✖ (tree) | — | — | — | ✖ | ✖ |
| **LiveSession / Attendance** | ✖ (dashboard only) | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ (dashboard only) |

Key structural fact: **the course tree never includes `sessionVideos`.** The student's lesson page
adds a separate "recordings" block fetched from `/api/students/me/session-videos?lessonId=…`, and
there is a separate "session videos" view fetching the same endpoint without the lesson filter.
Video/PDF/Quiz/Homework on the curriculum tree come from the same `Lesson` node (quizzes, homeworks,
materials are inlined in the tree query) — **except videos**, which come from a second,
batch-keyed API. That single asymmetry is the source of symptoms 3, 5 and 6.

### 4.2 "After adding new videos, the student's course may look empty" — exact trace

Video upload writes **only** `MediaAsset` + `SessionVideo` rows (batch-keyed). It cannot, and does
not, change the course tree. The "empty" perception has four code-supported mechanisms, in order
of likelihood:

1. **No player on the lesson page** (F7). The player renders `data.lesson.videoUrl` only
   (`src/components/course/student-lesson.tsx` L450). For lessons whose video was uploaded through
   the modern flow, `videoUrl` is NULL (the column is not writable — `src/lib/admin-sessions.ts`
   L24, L95-96 reject it), so the lesson opens with **no video player**. The recordings section
   fetches `?lessonId=<id>`; since the upload UI never sent `lessonId`, the list is empty. The
   session "lost" its visible video content from the student's point of view.
2. **Tree badge mismatch** (F7). `hasVideo: !!lesson.videoUrl` in `/api/courses/[slug]` is false
   for the same lessons, so the course tree shows no video indicator either.
3. **Stale/missing `Student.batchId`** → the recordings list returns `[]` (the reader resolves
   `batchId = student.batchId || syncStudentBatch(...)`, then returns empty when none exists).
   A student with an unrecognised `schoolType` also gets an unsatisfiable
   `videoTrackFilter` (fail-closed by design). Batch reconciliation can actively CLEAR a stale
   batch (`reconcileStudentBatch` rule 3), so a batch/course change can make previously visible
   recordings disappear.
4. **Lifecycle isolation** — if the admin added *new lessons* (DRAFT, created via
   `POST /api/admin/lessons`) while staging videos, those lessons are simply not in the student
   universe until `mark-ready` + `open` succeed. To the operator it reads as "I uploaded content,
   the course shrank/emptied"; to the engine it is correct behavior (DRAFT/READY are
   admin-only). A re-run of the official-curriculum reconciler would additionally archive
   code-less legacy lessons, shrinking the tree to the 23 official sessions.

None of these is a crash or data loss; the tree itself is only ever affected by
lifecycle/track/archive/enrollment state. The dominant mechanism is #1 (a UI/relation gap, not a
filter bug).

---

## 5. Current Media Flow — Video (end-to-end)

### 5.1 Write path (Admin)

```
Admin UI (session-videos-view.tsx)                    API                                   DB rows
─────────────────────────────────────   ─────────────  ───────────────────────────────────  ─────────────────────────────
pick Batch (GET /api/admin/batches)     POST /api/admin/session-videos      (buffered)
  fields: batchId, title, titleAr,                ↳ MediaAsset{kind:VIDEO, storage:
         description, [file|videoUrl], publish      LOCAL_PRIVATE|S3, storageKey, isPrivate}
                                                    OR MediaAsset{storage:EXTERNAL_URL,
  (presigned variant)                      POST /api/admin/media-uploads/init    normalized externalUrl}
   purpose: SESSION_VIDEO, batchId            (HMAC intent token, presigned PUT
   ↳ browser PUTs bytes straight to R2           to private bucket)
                                      POST /api/admin/media-uploads/complete
   (fallback on PRESIGNED_UNSUPPORTED:           ↳ same MediaAsset verification, then
    multipart POST /api/admin/session-videos)
  ⚠ NO lessonId FIELD IN THE UI — the API accepts
    `lessonId` but the form never sends it

                                              SessionVideo{ batchId,            ← REQUIRED
                                                            lessonId: null,     ← ALWAYS (via UI)
                                                            mediaAssetId,
                                                            title, titleAr,
                                                            isPublished: <publish checkbox>,
                                                            publishedAt,
                                                            requiredPercent: 95 (default) }
```

`PATCH /api/admin/session-videos/[id]` can later set `lessonId`, `requiredPercent`,
`isPublished` (publish/unpublish) — i.e. the link *can* be repaired manually — but the admin list
UI exposes only the publish/unpublish toggles, not a lesson picker. `DELETE` removes the row and
reference-count-cleans the `MediaAsset` bytes.

### 5.2 Read paths — THREE different relations

**(a) Student list** — `GET /api/students/me/session-videos[?lessonId=]`
```
student = Student by userId
enrollment = getEnrollment(student.id)          (group→course + entitlement)
batchId = student.batchId || syncStudentBatch(student.id)   // lazy mutation in a GET!
videos = SessionVideo WHERE batchId = <that batch>
                            AND isPublished = true
                            AND (lessonId param if given)
                            AND batch.schoolType = student.schoolType     // videoTrackFilter
                            AND (lessonId IS NULL OR lesson.status = PUBLISHED)
```
→ The relation used is **`Student.batchId`**, not the lesson. A video with `lessonId = null`
is visible here (as a generic batch recording); a video with `lessonId` is only visible if the
lesson is PUBLISHED. Progress shown comes from `SessionVideoView` (per-student, per-video).

**(b) Student watch heartbeat** — `POST /api/students/me/session-videos/[id]/progress`
Server-verified, wall-clock-credited, monotonic; writes `SessionVideoView`
(unique `sessionVideoId+studentId`); completion at `SessionVideo.requiredPercent` (default 95).
Authorization: video published AND `video.batchId === student.batchId`.

**(c) Readiness** — `computeLessonReadiness` (called by `GET /api/admin/lessons/[id]/readiness`,
`mark-ready`, `open`)
```
VIDEO satisfied ⟺ usableUrl(Lesson.videoUrl)                     [legacy, track-agnostic]
                OR ∃ SessionVideo with lessonId = L.id
                   AND isPublished = true
                   AND batch.schoolType applies to L.trackScope:
                      L.trackScope=SHARED  → both ARABIC and LANGUAGE batches must be covered
                      L.trackScope=ARABIC  → ARABIC batch
                      L.trackScope=LANGUAGE→ LANGUAGE batch
```

**(d) Progression** — `getCourseSessionProgress`
```
hasVideo = !!lesson.videoUrl          ← legacy column ONLY
videoDone = !hasVideo || LessonProgress.videoCompleted || LessonProgress.videoPercent >= 95
(SessionVideo and SessionVideoView are NOT read anywhere in the progression engine.)
```

**(e) Student lesson page** — `LessonRecordingsSection` → same endpoint as (a) with `?lessonId=`;
main player → `lesson.videoUrl` only.

**(f) Dashboards/parents/reports** — `src/lib/progress.ts`
`videoLessonIdsByStudent` filters lessons by `videoUrl: { not: null }` (legacy again) and reads
`LessonProgress` rows only. `SessionVideoView` is never read by any dashboard, report, certificate
or parent surface.

### 5.3 Precise answers

- **DB rows created on upload:** `MediaAsset` + `SessionVideo` (and `SessionVideoView` rows only
  later, per watching student).
- **Foreign keys written:** `SessionVideo.batchId` (always), `SessionVideo.mediaAssetId` (always),
  `SessionVideo.lessonId` (never, via UI).
- **Attached to Batch, Lesson, Group, or more than one?** Batch (required). Lesson (optional,
  unused in practice). Never a Group. One row per (batch, media, title) — a single video can be
  re-published per batch as separate `SessionVideo` rows sharing one `MediaAsset`.
- **How does the student query find it?** By `Student.batchId` + `isPublished` + batch track.
- **How does readiness find it?** By `lessonId` + `isPublished` + batch track (both batches if SHARED).
- **How does progression find it?** It doesn't — it reads `Lesson.videoUrl`/`LessonProgress`.
- **Same relationship in all three?** **No.** Student reader: `(Student.batchId)`. Readiness:
  `(Lesson.sessionVideos)`. Progression: `(Lesson.videoUrl)`. Three different joins, three
  different truths.

### 5.4 "Video visible to Student while readiness says missing" — the exact disconnect

Supported and reproducible from the code:

- **Visible-but-not-ready (the observed symptom):** admin uploads video to batch B, publish=true,
  lesson link absent. Student in B's school type sees it (5.2a). Readiness for lesson L sees
  `L.sessionVideos = ∅` → `VIDEO_MISSING` (or, if a *different* lesson's video is linked,
  still missing for L). Mark Ready fails although the student watches the video. Root cause:
  readiness joins on `lessonId`; the student reader joins on `batchId`; the writer leaves
  `lessonId = null`.
- **Ready-but-not-visible:** lesson L linked to a published SessionVideo in batch B (manual
  `lessonId` set) → readiness OK. A student whose `Student.batchId` is stale/NULL (school type
  changed, batch recreated for the course, reconciliation cleared it) gets no videos at all, yet
  the lesson remains READY/PUBLISHED and even *unlocked-able without any video* (see §13: no
  videoUrl ⇒ video gate inactive).
- **SHARED lesson one-sided staging:** one batch covered → `VIDEO_TRACK_INCOMPLETE` with note
  `SHARED_VIDEO_MISSING_BATCH:<other>` even though students of the covered track watch fine.

---

## 6. Current Media Flow — PDF (end-to-end)

### 6.1 Write path (Admin)

```
Admin session detail → PDF manager (session-pdf-manager.tsx)
  fields: lessonId (implicit), trackScope (default = lesson scope), file
     │
     ├─ buffered:   POST /api/admin/lessons/[id]/materials
     │              validatePdfUpload (MIME/ext/%PDF- magic/size) → writePrivateFile
     │              → finalizeLessonPdfMaterial (tx)
     └─ presigned:  POST /api/admin/media-uploads/init  {purpose: LESSON_PDF, lessonId, …}
                    browser PUT → complete → same finalize
     │
     ▼ DB rows
  MediaAsset{ kind: DOCUMENT, storage: LOCAL_PRIVATE|S3, storageKey, isPrivate: true }
  Material{   lessonId,            ← REQUIRED (the PDF is lesson-anchored, unlike video)
              kind: ADMIN_UPLOADED,
              trackScope (default = lesson.trackScope),
              mediaAssetId,
              isActive: true }
  (replace = deactivate prior active Material of same lesson×trackScope + refcount cleanup)
  ⚠ NEVER writes Lesson.pdfUrl (read-only legacy column, seeded placeholder "#" for most rows)
```

`DELETE /api/admin/lessons/[id]/materials?materialId=` deactivates the Material (bytes cleaned
only when unreferenced).

### 6.2 Read paths — ONE relation (Lesson), same as the curriculum tree

- **Student course tree** (`/api/courses/[slug]`): inlines `materials { isActive: true }` per
  lesson, filtered by the viewer's eligible scopes; descriptors built by
  `buildMaterialDescriptors`; locked lessons get `[]` (no ids leak) but a lock-independent
  `hasPdf`/`materialCount` badge.
- **Student lesson page** (`/api/lessons/[id]`): same descriptors after the `canAccessLesson`
  gate; `pdfUrl` field = first material's `/api/materials/[id]` (or legacy external URL only when
  no material exists).
- **Download** (`GET /api/materials/[id]`): the 10-check contract of
  `authorizeMaterialDownload` — for students: full lesson gate (enrollment + course + track +
  lifecycle PUBLISHED + progression unlock) + material's own trackScope; for parents:
  `isParentLessonPreviewAllowed` + parent track union; staff (teacher/admin): any active material
  (lifecycle NOT a barrier for staging review).
- **`/api/media/[id]`** refuses DOCUMENT assets for non-admins (PDFs only flow through
  `/api/materials/[id]`).

### 6.3 Why a PDF can exist for Admin but not for Student (code-supported)

The PDF *storage* is lesson-anchored and shared; what differs is the **visibility predicate**:

1. **Lesson not PUBLISHED** (DRAFT/READY) → the lesson itself is invisible to students, so its
   materials are too. The admin can upload/replace PDFs on a DRAFT lesson as part of staging —
   that is by design ("a teacher/admin configures a session precisely so that the admin ceremony
   can publish it afterwards"), but it means "PDF uploaded + video visible" is a *possible*
   mid-staging state: the batch video is published (its own flag) while the lesson (and its PDF)
   are not yet opened.
2. **Track mismatch**: material `trackScope` ≠ student's eligible scope (e.g. LANGUAGE PDF on a
   SHARED lesson for an ARABIC student; or the admin explicitly uploaded a track-specific PDF).
3. **Material deactivated** (replaced, or `isActive=false`) or **no `mediaAssetId`** —
   `buildMaterialDescriptors` skips it.
4. **Locked lesson**: student hasn't unlocked the session yet → materials redacted (by design).

Unlike video, the PDF has **no second batch-based reader** — so there is no "PDF in a different
universe" drift; the disconnect is purely lifecycle/track/lock, plus the admin UI's
"session detail" shows the PDF while the student tree shows the same lesson only after `open`.
**The PDF side is the healthier of the two media flows**; its symptoms are ordering confusion,
not relation drift.

---
## 7. Readiness & Publishing

### 7.1 State machine (stored, on `Lesson.status`)

```
            MARK_READY                OPEN (the ONLY publish path)
   DRAFT ─────────────────> READY ─────────────────────────> PUBLISHED
     ^  ▲                     ▲  ▲                              │
     │  └── ILLEGAL ─────────┘  └──────────────────────────────┘
     └────── PUBLISHED→DRAFT forbidden; OPEN requires from=READY ──── UNPUBLISH ────┘
```

- `ALLOWED_TRANSITIONS` (data, tested): `DRAFT:[READY]`, `READY:[PUBLISHED, DRAFT]`,
  `PUBLISHED:[READY]`. `DRAFT → PUBLISHED` is impossible by construction (READY cannot be
  bypassed); no transition on `ARCHIVED` lessons.
- Every mutation goes through `transitionLesson` (single ceremony engine,
  `src/lib/session-lifecycle.ts`): transactional, idempotent (`NO_OP_ALREADY_IN_STATE`),
  readiness-revalidating at OPEN, conditional `updateMany` (concurrency-safe), AuditLog row
  (`LESSON_MARK_READY` / `LESSON_OPEN` / `LESSON_UNPUBLISH`), and — on OPEN — a
  `SessionPublication` upsert (unique per lesson) + Phase 17 `NEW_LESSON` notification fan-out
  (targeted: active-group students of the lesson's course whose schoolType matches the lesson
  trackScope; "GROUP IS NOT TRACK").
- OPEN additionally requires the lesson to be in a course (`unitId` or `topicId` chain →
  `LESSON_NOT_IN_COURSE` 409) and re-evaluates readiness live (`READINESS_BLOCKED` 409).
- UNPUBLISH (PUBLISHED→READY) **deletes** the `SessionPublication` row (withdraws the
  publication; no notification fan-out ever fires for it).
- ARCHIVE / RESTORE (`curriculumStatus`) is a separate admin ceremony; archived lessons are
  excluded from every student/parent read but retained for teacher grading/history.

### 7.2 Readiness contract — exact conditions (from `computeLessonReadiness`)

| Resource | Required? | Satisfied when | Blocking when |
|---|---|---|---|
| **VIDEO** | **YES** | `usableUrl(Lesson.videoUrl)` (legacy, counts for every track) OR ≥1 PUBLISHED `SessionVideo` whose `batch.schoolType` applies to the lesson track: SHARED lesson ⇒ **both** ARABIC and LANGUAGE batches covered; track lesson ⇒ its own batch | `VIDEO_MISSING` (nothing present), `VIDEO_TRACK_INCOMPLETE` (present but not for the whole claimed audience) |
| **PDF** | **NO** (NOT_APPLICABLE; informational) | `usableUrl(Lesson.pdfUrl)` OR active `Material` (kind ADMIN_UPLOADED/DOCUMENT or with mediaAssetId) applicable to the lesson track | never |
| **QUIZ** | NO — but if present must be valid | ≥1 quiz applicable to the track, every applicable quiz has ≥1 question (count known) | `QUIZ_EMPTY` (a present-but-empty quiz blocks) |
| **HOMEWORK** | NO — but if present must be valid | ≥1 assignment applicable to the track with usable instructions | `HOMEWORK_INSTRUCTIONS_EMPTY` |
| Lifecycle | — | not ARCHIVED | `CURRICULUM_ARCHIVED` |

Readiness is a **pure function** over live rows (`getLessonReadiness` is the single loader). The
readiness endpoint, the admin list (`includeReadiness=1`), the Mark Ready ceremony, and the OPEN
ceremony all evaluate the *same* function — there is no second implementation (pinned by
`tests/session-lifecycle-phase13.test.js` and `tests/session-media-publishing-audit.test.js`).

**What entity is marked READY?** The `Lesson` row (`status = READY`).
**What entity is published?** The `Lesson` row (`status = PUBLISHED`) + a `SessionPublication`
anchor row. Nothing else changes: no copies, no per-student or per-batch publication state.

### 7.3 Answers to the Phase-4 questions

1. **Exact conditions enabling Mark Ready:** not ARCHIVED AND (VIDEO satisfied per 7.2) AND no
   blocking quiz/homework items AND `status ∈ {DRAFT, READY}`. (OPEN additionally requires
   `from = READY` + lesson in a course.)
2. **DB relations readiness inspects:** `Lesson.videoUrl`, `Lesson.pdfUrl`,
   `Lesson.sessionVideos → SessionVideo.batch.schoolType` (+ `isPublished`),
   `Lesson.quizzes → Question._count`, `Lesson.homeworks.instructions`,
   `Lesson.materials` (active, with media), `Lesson.publication` (reported only).
3. **Can a video be visible to a student while readiness considers the session missing a video?**
   **Yes — three concrete ways**, all code-supported (§5.4): (i) video published to a batch with
   `lessonId = null` (the default UI state) — student-visible, readiness-invisible; (ii) SHARED
   lesson with one batch only — students of that batch watch it, readiness reports
   `VIDEO_TRACK_INCOMPLETE`; (iii) student's batch stale/missing — readiness OK, student sees
   nothing.
4. **The exact architectural disconnect:** readiness joins **Lesson → SessionVideo**
   (`lessonId`), the student joins **Student → Batch → SessionVideo** (`batchId`), the admin
   writer fills **`batchId` only**. The two join paths meet only when a human manually patches
   `lessonId`. There is no invariant, no UI field, and no API validation forcing the two halves
   of the video world to agree.
5. **Entity marked READY:** `Lesson` (status). 6. **Entity published:** `Lesson` (status) +
   `SessionPublication` anchor.

### 7.4 Publication / open / unpublish / archive behavior (routes)

| Route | Method | Effect |
|---|---|---|
| `/api/admin/lessons/[id]/readiness` | GET | live checklist (same computation) |
| `/api/admin/lessons/[id]/mark-ready` | POST | DRAFT/READY → READY (readiness-gated) |
| `/api/admin/lessons/[id]/open` | POST | READY → PUBLISHED + SessionPublication + notification fan-out |
| `/api/admin/lessons/[id]/unpublish` | POST | PUBLISHED/READY/DRAFT → READY + SessionPublication deleted |
| `/api/admin/lessons/[id]/archive` | POST | `curriculumStatus` ARCHIVE / RESTORE |
| `/api/admin/lessons/[id]/recipients` | GET | notification-recipient preview for the open dialog |

---

## 8. Teacher Workflow (what the code actually does)

### 8.1 Teacher scope

The ONLY teacher scope in the platform:

```
Teacher.groups (Group.teacherId = teacher.id)  →  Group.courseId set  →  "own courses"
```

Resolved server-side from the authenticated teacher (`teacherCourseIds`, never a client-supplied
course id) in `src/lib/teacher-content.ts`. Lesson ownership for writes:
`loadOwnedLesson(lessonId, courseIds)` — lesson → placement (canonical chain first, legacy
fallback) → course ∈ own courses (`NOT_OWNED` 403 otherwise; no-chain → 404).

- **What lessons can a Teacher see?** ALL lessons of own courses — **including DRAFT, READY and
  ARCHIVED** (`/api/teacher/lessons` deliberately applies no lifecycle/archive filter: "a teacher
  manages the whole catalogue").
- **By what relation does the Teacher gain access?** `Group.teacherId` → `Group.courseId`.
  (Not Batch, not explicit assignment, not Course directly — though with one course in the
  platform, course-level ≈ platform-level for any assigned teacher.)
- **Does the Teacher see published sessions only?** No — all lifecycle states (flagged as
  intentional in the route header).
- **Can the Teacher create a Quiz for any Lesson?** Only for lessons of own courses
  (`POST /api/teacher/quizzes` → `loadOwnedLesson`). Archived lessons refuse new quizzes.
  TrackScope inherited from the lesson (Phase 18 containment rules).
- **Can the Teacher create Homework for any Lesson?** Same answer (`POST /api/teacher/homework`).
- **Where is Attendance attached?** To `LiveSession` (per Group). Not to Lesson (see §12).
- **Can the Teacher take Attendance per Session?** Yes — per `LiveSession` of own groups
  (`POST /api/teacher/attendance`), but only for LiveSession rows that exist; **no production
  route creates LiveSession rows** (only `scripts/seed.ts`, `scripts/seed-parent-demo.ts` and
  verification scripts do), so in production a teacher can only record attendance for
  pre-seeded meetings.

### 8.2 Full inventory of teacher surfaces

| Surface | Route(s) | Scope | Notes |
|---|---|---|---|
| Dashboard | `GET /api/teacher/dashboard` | own groups | per-group video progress (legacy `LessonProgress`-based), attendance %, quiz averages, pending homework, upcoming LiveSessions, recent submissions/attempts |
| Lesson picker | `GET /api/teacher/lessons` | own courses, all states | officialCode/part/unit/track/lifecycle per lesson; flat + grouped |
| Attendance | `GET/POST /api/teacher/attendance` | own groups; LiveSession must belong to own group; students must be in that group | upsert on (studentId, sessionId); statuses PRESENT/ABSENT/LATE/EXCUSED; per-student % over group sessions |
| Quizzes | `GET/POST /api/teacher/quizzes`, `GET/DELETE /api/teacher/quizzes/[id]` | own courses (quiz via its lesson) | create quiz + questions in one POST (Phase 18 limits, blueprint fields); GET includes Phase 6 analytics |
| Quiz questions | `POST /api/teacher/quizzes/[id]/questions`; `GET/PATCH/DELETE /api/teacher/questions/[id]` | via quiz→lesson→own course | shared validator; frozen-attempt edit guards (no answer/options/type/marks/schoolType edits once any attempt exists); delete refused when referenced (frozen answers, exam pins) |
| Quiz attempts | `GET /api/teacher/quizzes/[id]/attempts` | via quiz→lesson | finished-attempt review |
| Homework | `GET/POST /api/teacher/homework`; `PATCH /api/teacher/homework/[id]`; `POST /api/teacher/homework/[id]/grade` | own courses | create/edit (archived refused); grading sets GRADED + grade + feedback (can pre-grade a missing submission) |
| Student notes | `GET/POST /api/teacher/student-notes` | own groups' students | notes visible to parent (Phase: parent receives teacher-note notification) |
| Templates | `GET/POST /api/teacher/templates`, `DELETE /api/teacher/templates/[id]` | teacher-owned LessonPlanTemplate | free-form planning docs; no curriculum effect |
| Analytics | `GET /api/teacher/analytics` | own courses (student-universe scoped) | completion/weakness analytics |

### 8.3 Do Teacher actions affect readiness/progression?

- **Readiness: indirectly, yes.** A teacher-created quiz with zero questions makes
  `computeLessonReadiness` return `QUIZ_EMPTY` → blocks the admin's Mark Ready/OPEN. A
  teacher-created homework with empty instructions blocks as
  `HOMEWORK_INSTRUCTIONS_EMPTY`. Conversely teacher content is *never required* (quiz/homework are
  optional dimensions). The teacher UI has no readiness visibility, so this coupling is invisible
  to the teacher.
- **Progression: yes, by existence.** Creating a quiz on a lesson adds the "attempt all quizzes of
  the lesson" gate for every student; creating homework adds the "submit all assignments" gate.
  Since gates are existence-driven, a teacher's authoring action immediately changes student
  unlock behavior (even for PUBLISHED lessons the student is mid-way through — the student must
  then satisfy the new gate before advancing).
- **Lifecycle: never.** Teachers have no mark-ready/open/unpublish/archive routes.
- **Media: never.** No teacher route touches MediaAsset/SessionVideo/Material (teacher can only
  *download* materials and *stream* session videos through the staff branches of
  `/api/materials/[id]` and `/api/media/[id]`).
- **Curriculum structure: never.** No teacher route creates/edits Course/Part/Unit/Lesson.

### 8.4 Teacher → readiness/progression coupling summary

| Teacher action | Affects | Mechanism |
|---|---|---|
| create quiz (with questions) | student progression (gate appears); readiness (OK state) | existence of `Quiz` on lesson |
| create quiz (empty) | readiness **blocks** Mark Ready/OPEN | `QUIZ_EMPTY` |
| create homework (with instructions) | student progression (gate appears) | existence of `Homework` |
| create homework (no instructions) | readiness blocks | `HOMEWORK_INSTRUCTIONS_EMPTY` |
| grade homework | student progression **no** (submission suffices), parent/student grade view | `HomeworkSubmission.status=GRADED` |
| record attendance | dashboards/parent analytics only; **no progression effect** | `Attendance` row |
| student note | parent notification/portal | `TeacherNote` |

---

## 9. Quiz Workflow (ordinary/session quiz)

**Attachment: Lesson-scoped.** `Quiz.lessonId` is a required FK; there is no Group-scoped or
Teacher-owned quiz, and no separate quiz table. Teacher *authored*, but the row belongs to the
lesson (no `createdBy` column — ownership for writes is derived through the lesson's course + the
teacher's groups; Admin can also author via the admin question bank and AI-generate-quiz).

Flow:

```
Teacher: POST /api/teacher/quizzes  (lesson picker → own course lesson; trackScope inherits
         from lesson; FIXED or BLUEPRINT blueprint; questions validated by shared validator)
Student: GET  /api/quizzes/[id]            (canAccessQuiz = canAccessLesson(owning lesson)
                                            + quiz.trackScope eligibility)
         POST /api/quizzes/[id]/start       (ONE attempt by default: Quiz.maxAttempts=1;
             server selects questions per blueprint over the bank pool with track filter;
             FROZEN snapshot onto QuizAnswer rows incl. option order/answer key;
             server-started time limit; camera decision recorded;
             expired attempts are terminal → need Admin retry grant)
         POST /api/quizzes/[id]/submit      (grades exactly the frozen rows; writes score,
                                            percentage, passed (vs passMark), finishedAt;
                                            status SUBMITTED; resubmission not possible once
                                            terminal)
         POST /api/quizzes/[id]/evidence    (camera snapshots → QuizAttemptEvidence →
                                            MediaAsset; ADMIN-only read via /api/media/[id])
Admin:   GET  /api/admin/quiz-attempts*     (review), POST /api/admin/quiz-retries
                                            (the ONLY progression override: one-time extra
                                            attempt per (student, quiz), audited)
Teacher: GET  /api/teacher/quizzes/[id]/attempts (review finished attempts)
```

- **Completion semantics:** an attempt is "finished" when `finishedAt != null` (SUBMITTED or
  EXPIRED). Progression requires **any finished attempt per quiz** — **passing is NOT required**
  (the `passed` flag vs `passMark` is reported/stored but not consulted by the progression engine).
- **Retry:** default `maxAttempts = 1`, one attempt per student; only an Admin `QuizRetryGrant`
  raises the ceiling (single-use, consumed at next start, lineage on the attempt).
- **Sharing:** quizzes are shared content of the lesson; multiple quizzes may exist per lesson
  (track-scoped variants of a SHARED lesson are the documented pattern) and ALL of them must be
  attempted to satisfy the lesson's quiz gate.

---

## 10. Mock Exam Boundary

Mock Exams are a **separate Admin-controlled domain**, deliberately not a Session Quiz:

| | Session Quiz | Mock Exam |
|---|---|---|
| Models | `Quiz`, `Question`, `QuizAttempt`, `QuizAnswer`, `QuizRetryGrant` | `MockExam`, `MockExamQuestion`, `ExamAttempt`, `ExamQuestion` (bank) |
| Anchor | **Lesson** (required) | **schoolType bank** + optional courseId; NO lesson |
| Owner | Teacher-authored (or admin bank/AI) | **Admin only** (`/api/admin/mock-exams*`) |
| Lifecycle | lesson lifecycle governs student visibility | own `isPublished` flag |
| Attempts | `QuizAttempt` (one-attempt default, retry grants, frozen answers, camera evidence) | `ExamAttempt` (frozen paper via `mock-exam-pool.ts`, retakes append rows, display-only timing) |
| Progression | gates lesson unlock (attempted, per §13) | **no progression effect** |
| Teacher surface | authoring + attempt review | **none** |
| Student surface | lesson page / quiz runner | `/api/students/me/mock-exams` + `/api/exams/mock` (enrollment-gated; assigned/published exams) |
| Parent | finished attempts in curriculum universe | finished attempts block (read-only) |

The two attempt worlds never cross-write (`ExamAttempt` vs `QuizAttempt` — pinned by
`tests/mock-exam-grading-isolation.test.js`). Session quizzes feed the lesson gate; mock exams
feed reports only. **This boundary is clean and should be preserved** (per the audit brief, mock
exams are out of scope for redesign).

---

## 11. Homework Workflow

- **Who can create Homework today?** **Teachers only** (`POST /api/teacher/homework`,
  own-course lessons). **Admin has no homework creation route** (and no grading route). AI-generate
  covers quizzes only.
- **Scope protecting creation:** authenticated TEACHER → `loadOwnedLesson` (lesson → canonical
  course chain → ∈ teacher's group courses) → track scope containment (Phase 18) → archived
  lesson refused.
- **Attachment:** `Homework.lessonId` (required) — same canonical lesson node as the curriculum
  tree, quiz, and materials.
- **Student visibility:** `GET /api/students/me/homework` lists homework of the student's
  **unlocked** lessons only (`getUnlockedLessonIds` = the progression engine's unlocked set),
  PUBLISHED + not-archived lessons, own trackScope. Locked sessions' assignments are protected
  content, not to-dos.
- **Submission:** `POST /api/students/me/homework` — `canAccessHomework` gate; sets
  `SUBMITTED` (or `LATE` past deadline); GRADED submissions immutable; upsert on
  (homeworkId, studentId). Free text only (4000 chars) — no file uploads for homework.
- **Grading:** `POST /api/teacher/homework/[id]/grade` — teacher-only, sets `GRADED` + grade +
  feedback (may pre-grade before any submission).
- **Completion / progression:** progression requires **submission only**
  (`HomeworkSubmission.submittedAt != null`, any of SUBMITTED/LATE/GRADED). Grading is NOT
  required for unlock; passing does not exist for homework.
- **Admin override:** none (no admin homework routes at all; no admin re-grade).
- **Student page vs curriculum tree relationship:** SAME — both derive from
  `Homework.lessonId` + the lesson universe (tree inlines homeworks per lesson; the homework list
  is the lesson universe filtered to unlocked). No divergence (unlike video).

---

## 12. Attendance Workflow

### 12.1 Data model

```
Group 1──N LiveSession N──1 Teacher? (opt)
              │  N:1 Lesson? (optional, never enforced, not written by any current API)
              │
              └──N Attendance  (unique per student×session;
                                status PRESENT|ABSENT|LATE|EXCUSED; note)
```

- `LiveSession` = a *scheduled meeting* of a group (`startAt`, `duration`, `status`
  SCHEDULED/LIVE/COMPLETED/CANCELLED, `meetingUrl`, `recordingUrl`).
- `Attendance` hangs on `LiveSession` + `Student`. **Not on Lesson, not on date, not on Group
  directly** (group is reached through the session).
- Date/time semantics: `LiveSession.startAt` is the session time; `Attendance` has no date of its
  own (it inherits the session's). No "make-up" or per-date re-marking concept.

### 12.2 Endpoint contract & access

| Role | Read | Write |
|---|---|---|
| Teacher | `GET /api/teacher/attendance?groupId=&sessionId=` — group's LiveSessions (upcoming+past), group students, per-session records, per-student % | `POST /api/teacher/attendance` — upsert records for a session of own group; students must belong to that session's group |
| Admin | **no dedicated attendance route** (admin overview reads LiveSession counts; no attendance read/write surface) | none |
| Student | dashboard aggregate only (`total/present/percentage` over ALL own Attendance rows) — no per-session list route | none |
| Parent | dashboard aggregate + monthly buckets + recent-activity entries + "next session" (child's group's next LiveSession) | none |

### 12.3 Current flow

```
(Seed scripts create LiveSessions per group — this is the ONLY creation path in production code)
Teacher dashboard → "upcoming sessions" (own groups, next 7 days)
Teacher opens attendance for (groupId, sessionId) → roster + saved records + % → POST records
Student dashboard → attendance % + next session banner
Parent dashboard  → attendance % + monthly + activity timeline
```

### 12.4 Answers

- **Data model / FKs:** `Attendance.studentId`, `Attendance.sessionId → LiveSession.id`;
  `LiveSession.groupId`, `LiveSession.teacherId?`, `LiveSession.lessonId?`.
- **Group scope:** enforced on the teacher write (session must belong to teacher's group;
  students must be in that group). GET validates `groupId ∈ teacher.groups` but then also accepts
  a `sessionId` parameter whose session membership in that group is not re-verified (the record
  rows are mapped only onto the group's students, so cross-group exposure is limited to nothing
  material — students of other groups are not in the roster; minor hardening item).
- **Session/Lesson scope:** per LiveSession. The optional `LiveSession.lessonId` is never written
  by any current API (only seed scripts set it in places), so **attendance is effectively
  undifferentiated from the lesson curriculum**.
- **Attendance states:** PRESENT, ABSENT, LATE, EXCUSED ("present" for % purposes = PRESENT or LATE).
- **Admin read/edit:** no surface.
- **Student visibility:** aggregate % only.
- **Parent visibility:** aggregate + monthly + timeline (read-only).
- **Does Attendance affect progression?** **No.** No progression/readiness/curriculum code reads
  `Attendance` or `LiveSession` (verified: `getCourseSessionProgress`, `canAccessLesson`,
  `computeLessonReadiness` never touch them). Whether it *should* is a product decision (§23).

---
## 13. Student Progression Formula (exact, from code)

Source: `src/lib/session-progress.ts` (`getCourseSessionProgress`, `canAccessLesson`),
`src/lib/progress.ts` (`VIDEO_COMPLETION_THRESHOLD = 95`), `src/lib/subscription-entitlement.ts`.

### 13.1 The universe (what counts as "the course" for one student)

```
Universe(student, course) = { Lesson L :
      L.status = PUBLISHED                                  // Phase 13 lifecycle slice
  AND L.curriculumStatus != ARCHIVED                        // Phase 11 archive slice
  AND L.trackScope ∈ {SHARED} ∪ {student.schoolType (if recognised)}   // Phase 12, fail closed
  AND ( L.unitId → Unit.part.courseId = course
     OR L.topicId → Topic.unit.part.courseId = course ) }   // dual chain, canonical first

Order: Part.order → Unit.order → (Topic.order, unit-linked first) → Lesson.order → id
       (deterministic total order; `orderCourseLessons`)
```

### 13.2 The formula

```
entitled(student, course) =
      student.group.isActive = true AND student.group.courseId = course
  AND evaluateAccessDecision(groupActive, student.subscription).allowed
      // Subscription row (if any) is authoritative: PENDING/CANCELLED/lazily-expired deny;
      // no row = grandfathered (Phase 25 PR2a)

unlocked(first lesson)  = true
unlocked(L[n+1])        = completed(L[n])                // strictly sequential chain

completed(L)            = videoDone(L) AND quizDone(L) AND assignmentDone(L)

videoDone(L)           = NOT (L.videoUrl != null)
                       OR LessonProgress(L, student).videoCompleted
                       OR LessonProgress(L, student).videoPercent >= 95
       // NOTE: SessionVideo / SessionVideoView are NOT consulted at all.

quizDone(L)            = NOT ∃ Quiz(lessonId = L)
                       OR ∀ q ∈ L.quizzes : ∃ QuizAttempt(q, student, finishedAt != null)
       // "finished" = submitted OR expired. PASSING (q.passMark) is NOT consulted.

assignmentDone(L)      = NOT ∃ Homework(lessonId = L)
                       OR ∀ h ∈ L.homeworks : ∃ HomeworkSubmission(h, student, submittedAt != null)
       // SUBMITTED, LATE or GRADED all count. Grading is NOT consulted.

canAccessLesson(student, L) =
      L exists AND L.status = PUBLISHED AND L.curriculumStatus != ARCHIVED
      AND L resolves to a course (unit chain or topic chain)
      AND entitled(student, that course)
      AND L.trackScope eligible for student.schoolType
      AND unlocked(L) per the chain above
       → reasons: LESSON_NOT_FOUND (404, non-oracle) | NOT_ENROLLED (403)
                   | PREVIOUS_SESSION_INCOMPLETE (403)
```

### 13.3 Gate inventory (table form)

| Gate | Source table / field | API that reads it | Canonical? | Enforced today? |
|---|---|---|---|---|
| Lesson published | `Lesson.status` | all student/parent readers + `canAccessLesson` | ✔ (Phase 13) | **Yes** |
| Lesson not archived | `Lesson.curriculumStatus` | same + universe query | ✔ (Phase 11) | **Yes** |
| Track eligibility (lesson) | `Lesson.trackScope` vs `Student.schoolType` | same + `gateTrackedResource` | ✔ (Phase 12) | **Yes** |
| Track eligibility (resource) | `Quiz.trackScope` / `Homework.trackScope` | `canAccessQuiz/Homework` | ✔ (Phase 12/18) | **Yes** |
| Enrollment / entitlement | `Student.groupId → Group.isActive/courseId` + `Subscription` | `getEnrollment`, `canAccessLesson`, `getUnlockedLessonIds` | ✔ (Phase 25 PR2a) | **Yes** |
| **Video watched ≥ 95%** | `Lesson.videoUrl` (trigger) + `LessonProgress.videoPercent/videoCompleted` (written by `POST /api/lessons/[id]/video-progress`, wall-clock credited) | `getCourseSessionProgress`, `POST /api/lessons/[id]/progress` (blocks `isCompleted` until video satisfied) | **Partially** — only when the legacy `videoUrl` column is set, which no current API can do | **Effectively NO for all post-Phase-15 lessons** |
| **Session-video watched ≥ requiredPercent** | `SessionVideoView.percent/isCompleted` (written by `POST /api/students/me/session-videos/[id]/progress`) | **only the recordings list UI** | ✖ (not the progression relation) | **NO — dead for progression** |
| Quiz attempted (any finish) | `QuizAttempt.finishedAt != null` (per quiz of the lesson) | `getCourseSessionProgress` | ✔ | **Yes** |
| Quiz passed | `QuizAttempt.passed` vs `Quiz.passMark` | reports/analytics only | ✖ | **NO** |
| Homework submitted | `HomeworkSubmission.submittedAt != null` | `getCourseSessionProgress` | ✔ | **Yes** |
| Homework graded | `HomeworkSubmission.status = GRADED` | teacher/parent surfaces only | ✖ | **NO** |
| Attendance | `Attendance` / `LiveSession` | dashboards/parents only | ✖ | **NO** |
| Manual / Admin completion override | — | **no route writes `LessonProgress.isCompleted` except student routes** | ✖ | **NO (mechanism absent)** |
| Course track / group membership | see enrollment + track | as above | ✔ | **Yes** |

### 13.4 Consequences of the current formula (observed behavior, code-backed)

1. A lesson with a **legacy `videoUrl`** enforces: watch ≥95% → quiz finished → homework submitted →
   next unlocks. This matches the documented Phase 4 rule.
2. A lesson created after Phase 15 (video staged as batch `SessionVideo`, `videoUrl = null`)
   enforces: **quiz finished → homework submitted → next unlocks**, with **no video gate at all**,
   even though the student is shown a 95% progress bar on the batch video and the lesson page's
   "video requirement" row reports `required: false` (`hasVideo = !!lesson.videoUrl`).
3. The `SessionVideoView` completion state is shown to the student ("completed" tick on the
   recording) but has zero effect on unlock — the student can be told "video complete" and still
   unlock via doing nothing, or (for legacy lessons) be locked despite completing the *batch*
   video they were actually shown.
4. `LessonProgress.isCompleted` can only become true when the video rule is satisfied
   (`POST /api/lessons/[id]/progress`), so for legacy-video lessons "completed" implies watched;
   for modern lessons the same flag is reachable without any watching.

**CURRENT PROGRESSION FORMULA (the real one, as found):**

```
NextLessonUnlocked(L[n+1]) =
      entitled(student)
  AND L[n].status = PUBLISHED AND L[n] not ARCHIVED AND L[n] on student's track
  AND (L[n].videoUrl = null
       OR LessonProgress(L[n]).videoCompleted
       OR LessonProgress(L[n]).videoPercent >= 95)
  AND (no Quiz on L[n] OR every quiz of L[n] has a finished QuizAttempt)
  AND (no Homework on L[n] OR every homework of L[n] has a submittedAt HomeworkSubmission)
```

---

## 14. Student Experience (as it actually renders)

```
Login (Student) → dashboard
  ├─ continue lesson (unlocked, last-viewed-first)
  ├─ "next live session" banner = next LiveSession of the student's GROUP
  │    (calendar facet — unrelated to lesson unlock state)
  ├─ attendance % (aggregate over all own Attendance rows)
  ├─ latest quiz result, pending homework count (active curriculum universe only)
  └─ subscription/payment state
Course page (/api/courses/[slug])
  ├─ Part → Unit → Lesson rows: officialCode, presence badges (hasVideo=!!videoUrl ← legacy,
  │    hasPdf/materialCount ← materials, hasQuiz/hasAssignment), status locked/current/
  │    completed/available; locked = redacted skeleton
  └─ (no batch session videos anywhere in this tree)
Lesson page (/api/lessons/[id])
  ├─ main video player: renders ONLY when lesson.videoUrl != null (legacy external URL,
  │    iframe embed) — empty for modern staged lessons
  ├─ "recordings" section: GET /api/students/me/session-videos?lessonId=
  │    (batch videos linked to THIS lesson; empty when lessonId never set at upload)
  ├─ PDF(s): Material descriptors (authorized /api/materials/[id]) or legacy pdfUrl
  ├─ quizzes (all, with start/runner, one attempt, camera evidence)
  ├─ homework (first, with inline submit form)
  └─ requirements row: video/quiz/assignment from getCourseSessionProgress
  └─ prev/next (same ordered universe), bookmarks, notes
Session videos view (/api/students/me/session-videos)
  └─ ALL published videos of the student's batch (generic list; lesson shown only when linked)
  └─ per-video progress bar from SessionVideoView; playback via /api/media/[id] (uploads) or
     external URL; heartbeat POST per video
Mock exams, study plan, gamification, leaderboard, certificate, payments — separate views
```

Pain points mapped to code: the "session" the student is told to complete (curriculum lesson) and
the "session videos" the student watches (batch recordings) are two different lists; completion
ticks in one do not unlock the other (§13.4); the lesson page has no player for modern lessons
(§5.4/F7); attendance/next-session are group-calendar facts with no lesson tie.

---

## 15. Parent Experience

- **Scope:** `Parent.children` links; every read derives from linked children (no client-supplied
  ids). Course preview only for courses where a linked child is actively enrolled
  (`isParentAuthorizedForCourse`); track preview = union of enrolled children's tracks; lesson
  preview requires PUBLISHED + not-ARCHIVED + child track + child course
  (`isParentLessonPreviewAllowed` — the Phase 13 fix for the draft-lesson leak).
- **Surfaces:**
  - course tree preview (same `/api/courses/[slug]` with parent slice; no progression states
    beyond what the tree carries),
  - dashboard: per child — video progress (legacy `LessonProgress` universe only), lesson
    completion fraction, attendance % + monthly buckets, quiz averages + recent attempts
    (curriculum-universe filtered, Phase 26E), homework submissions, mock-exam results, next
    LiveSession, recent activity timeline (quiz/homework/attendance/lesson),
  - weekly/monthly reports (`/api/parents/me/weekly-report`, monthly in dashboard) — same
    universe-scoped helpers,
  - analytics view, notification prefs, teacher notes (delivered with notification).
- **Parent sees SessionVideo watch tracking:** **No** (only the legacy video universe via
  `getVideoProgressForStudents`). Parent sees **attendance** as aggregates only. Parent has **no**
  write access anywhere.

---

## 16. Current Role/Permission Matrix

Legend: — none · R read · C create · E edit · D delete · P publish · G grade · O override · A analytics

| Surface | Admin | Teacher | Student | Parent |
|---|---|---|---|---|
| **Course/Part/Unit structure** | R, C courses, E (reconcile-official, courses), D course | R (own courses, via lesson picker) | R (own, published slice) | R (children's, published slice) |
| **Lesson/Session (curriculum)** | R all states; C (DRAFT only, canonical chain, no officialCode); E title/desc/trackScope (placement immutable); D via ARCHIVE (RESTORE too) | R all states (own courses); no C/E/D | R published+unlocked only (locked = redacted skeleton) | R children's published only (preview) |
| **Lesson lifecycle (READY/PUBLISHED)** | C mark-ready, P open, P unpublish (ceremonies); A readiness | — (sees states, cannot act) | — | — |
| **Session video (SessionVideo)** | R (per batch), C (upload/URL + publish flag), E (title/desc/lessonId/requiredPercent/publish), D | R (stream via /api/media staff branch) | R own batch's published only; own watch progress (C views via heartbeat) | — |
| **Media bytes (MediaAsset)** | R (all, via /api/media + materials), C (uploads), D (refcount) | R (session videos stream; materials download; NO evidence) | R (own batch published videos via /api/media; own materials via /api/materials) | R (children's materials via /api/materials only) |
| **PDF/Material** | R, C (upload/replace), E (trackScope), D (deactivate) | R (any active material, staging review) | R own lesson's materials when unlocked | R children's lesson materials when published |
| **Quiz** | R all (incl. attempts, evidence, analytics); C (question bank, AI-generate); E bank; D bank; **O retry grant** (only override) | R own courses' quizzes + attempts + analytics; C quiz + questions (own course lessons); E questions (edit guards); D quiz, D questions (refcount guards) | R own unlocked lesson's quizzes (answers revealed only after own finish); C own attempt (1 by default); E — ; D — | R children's finished attempts (universe-scoped) |
| **Homework** | R (via export/overview only); **no C/E/D/grade routes** | R own courses; C (own course lessons); E; D — (no delete route); **G grade** | R own unlocked lessons' homework; C own submission; re-submit until graded | R children's submissions + grades |
| **Attendance** | — (no dedicated surface; overview reads session counts) | R own groups; C/E records (per LiveSession); no D | R own aggregate % only | R children's aggregate + monthly + timeline |
| **LiveSession (scheduling)** | — (no route; seed only) | R own groups' sessions; **no C/E (no creation route exists)** | R own group's next session banner | R children's next session |
| **Progress (LessonProgress/SessionVideoView)** | R (export-progress, analytics) | R (dashboard/analytics, video progress = legacy universe) | C own (heartbeats, progress POST); R own | R children's (legacy video universe, completion fractions) |
| **Readiness** | R (checklist), acts via ceremonies | — | — | — |
| **Publish/Unpublish** | P (open/unpublish ceremonies) | — | — | — |
| **Grade** | — (no grading routes) | G homework; quiz grading is server-side automatic | — | — |
| **Retry / Override** | O quiz retry grant; (no manual completion override, no homework override, no attendance override) | — | — | — |
| **Analytics** | R (overview, revenue, quiz attempts, export) | R (own groups: video/attendance/quiz/homework/completion) | R own (dashboard, gamification, certificate, leaderboard read) | R children's (analytics view, weekly/monthly) |
| **Mock Exam** | R, C, E, D, P (isPublished), question pins | — | R assigned/published exams; C own ExamAttempt | R children's finished attempts |
| **Groups/Batches/Students/Teachers** | full CRUD (incl. teacher applications, student assignment, batch create) | R own groups (roster via attendance/dashboard) | R own (me endpoints) | R children's |
| **Notifications** | R/C (notifications-center, broadcast) | R own feed (bell) | R own feed; prefs | R own feed (incl. teacher notes); prefs |

Notable asymmetries (current, not proposed): (1) Admin cannot grade or create homework — those are
teacher-only, with **no admin fallback** if a teacher account disappears; (2) Admin cannot create
LiveSessions, so admin cannot "rescue" attendance either; (3) Teacher cannot see readiness
outcomes of their own authoring (empty-quiz block is invisible to them); (4) Student can see
*other* students' names only via leaderboard; parent sees names of siblings only.

---

## 17. Broken Connections / Root Causes

Severity scale: CRITICAL = blocks the core academic workflow or silently changes student
progression semantics; HIGH = visible, recurring operator/student confusion with a real
correctness edge; MEDIUM = coupling/hardening gap; LOW = hygiene.

### CRITICAL

**C-1 — Video triple-relation split (media ↔ readiness ↔ progression).**
- *Symptom:* videos visible to students as generic recordings; Mark Ready fails with
  `VIDEO_MISSING` although the student watches a video; "course/sessions look empty of content"
  after uploads; 95% watch progress has no effect on unlocking.
- *Root cause:* `SessionVideo` is batch-home (`batchId` required, `lessonId` optional and
  never written by the admin UI) while readiness joins `Lesson.sessionVideos`, progression joins
  `Lesson.videoUrl` (a read-only legacy column), and the student reader joins
  `Student.batchId`. Four writers/readers, three relations, zero shared invariant.
- *Files/routes/models:* `prisma/schema.prisma` (SessionVideo, Lesson.videoUrl, Batch,
  Student.batchId); `src/app/api/admin/session-videos/route.ts`;
  `src/components/admin/session-videos-view.tsx` (no lessonId field);
  `src/lib/session-lifecycle.ts` (readiness VIDEO); `src/lib/session-progress.ts`
  (`hasVideo = !!lesson.videoUrl`); `src/app/api/students/me/session-videos/route.ts`;
  `src/app/api/students/me/session-videos/[id]/progress/route.ts`;
  `src/components/course/student-lesson.tsx` (player from `videoUrl`; recordings by lessonId);
  `src/app/api/courses/[slug]/route.ts` (`hasVideo` badge); `src/lib/progress.ts` (legacy
  universe).
- *Affected roles:* Admin (blocked ceremonies), Student (no unlock effect, no player), Teacher
  (indirect via readiness), Parent (dashboards read the legacy universe).
- *Risk:* progression semantics differ from the documented product rule; staged content silently
  "ready" or not-ready depending on which join you check; operator distrust of the readiness
  checklist.
- *Migration needed:* yes — data alignment (link existing `SessionVideo.lessonId`, decide the
  legacy `videoUrl` retirement, migrate `SessionVideoView` completions into the canonical watch
  record). Schema migration: only if the target model drops the dual relation (§18/§20).

**C-2 — Progression video gate inert for modern lessons.**
- *Symptom:* the "watch video ≥95%" unlock requirement does not exist for any lesson staged
  after Phase 15; students advance by quiz+homework alone.
- *Root cause:* `videoDone` is triggered by `Lesson.videoUrl != null`; the column is
  write-protected (`src/lib/admin-sessions.ts` rejects `videoUrl`/`pdfUrl`); the modern watcher
  (`SessionVideoView`) is not consulted by `getCourseSessionProgress`.
- *Files/routes/models:* `src/lib/session-progress.ts` L378 area;
  `src/app/api/lessons/[id]/video-progress/route.ts`; `src/lib/admin-sessions.ts`.
- *Affected roles:* Student (progression weaker than spec), Admin (believes the 95% rule applies).
- *Risk:* academic integrity of the unlock chain; certificate/progress claims overstate watching.
- *Migration needed:* data backfill decision only (no schema requirement; see §20).

### HIGH

**H-1 — Readiness/student video visibility divergence (SHARED two-batch rule + batch-staleness).**
- *Symptom:* SHARED lesson blocks on `SHARED_VIDEO_MISSING_BATCH:<track>` after one batch is
  published; or readiness OK while a stale-`batchId` student sees no video.
- *Root cause:* readiness's "both batches for SHARED" rule (§7.2) vs the batch-only student
  resolution; `Student.batchId` is sticky and only lazily reconciled; no invariant ties a
  lesson's readiness to each *student's* actual video availability.
- *Files:* `src/lib/session-lifecycle.ts` (VIDEO branch), `src/lib/enrollment.ts`
  (`reconcileStudentBatch`), `src/app/api/students/me/session-videos/route.ts`.
- *Roles:* Admin, Student. *Risk:* false "READY" for some students; operator confusion.
- *Migration:* no (behavior/config), unless the target model collapses batch into lesson scope.

**H-2 — PDF lifecycle-order trap (admin-staged PDF invisible to students).**
- *Symptom:* "PDF uploaded by Admin, student does not see it" while a batch video for the same
  session *is* visible.
- *Root cause:* Material visibility is lesson-scoped and gated by lesson PUBLISHED + unlock;
  `SessionVideo.isPublished` is an independent flag, so a DRAFT lesson can carry a student-visible
  video but a student-invisible PDF. Not a bug per se, but the two media lifecycles are decoupled
  without operator guidance (readiness never reports the asymmetry).
- *Files:* `src/lib/session-materials.ts`, `src/lib/session-lifecycle.ts`,
  `src/app/api/admin/lessons/[id]/materials/route.ts`, `src/app/api/students/me/session-videos/route.ts`.
- *Roles:* Admin, Student. *Risk:* "lost PDF" incidents; repeated support traffic.
- *Migration:* no.

**H-3 — LiveSession/Attendance disconnected from the Lesson and from production writes.**
- *Symptom:* attendance is recorded against meetings that only seed data creates; "session
  attendance" in dashboards has no lesson identity; teacher cannot schedule a session or link it
  to Lesson N.
- *Root cause:* `LiveSession.lessonId` optional and never written by any API; no
  create/update LiveSession route exists for any role; attendance % aggregates ignore lesson
  boundaries.
- *Files:* `prisma/schema.prisma` (LiveSession, Attendance), `src/app/api/teacher/attendance/route.ts`,
  `scripts/seed.ts`, dashboards (`/api/teacher/dashboard`, `/api/students/me/dashboard`,
  `/api/parents/me/dashboard`).
- *Roles:* Teacher (cannot extend the workflow), Student/Parent (calendar facts without lesson
  context), Admin (no rescue surface).
- *Risk:* the "attendance per Session" product concept cannot actually operate in production.
- *Migration:* no schema change strictly required (lessonId already exists); data cleanup of
  seed-created rows if they ever ran in production (they were dev/demo seeds — verify per env).

**H-4 — Dual video-watch systems with divergent "complete" facts.**
- *Symptom:* a student can be "video complete" in the recordings view (SessionVideoView) and
  0% in the lesson requirement row (LessonProgress), or vice versa; parent/teacher dashboards
  and reports reflect only the legacy system.
- *Root cause:* two heartbeats, two tables, two thresholds (fixed 95 vs per-video
  `requiredPercent`), no projection between them.
- *Files:* `src/app/api/lessons/[id]/video-progress/route.ts`,
  `src/app/api/students/me/session-videos/[id]/progress/route.ts`, `src/lib/progress.ts`,
  `src/app/api/lessons/[id]/route.ts` (requirements row).
- *Roles:* Student, Parent, Teacher, Admin (reports).
- *Risk:* conflicting "did they watch?" answers across surfaces.
- *Migration:* yes — decide the canonical watch record and reconcile existing
  `SessionVideoView`/`LessonProgress` rows (see §20).

### MEDIUM

**M-1 — Teacher authoring silently gates admin readiness** (empty quiz → `QUIZ_EMPTY` block)
with no teacher-side visibility. Files: `src/app/api/teacher/quizzes*`,
`src/lib/session-lifecycle.ts`. Roles: Teacher, Admin. Risk: unexplained Mark Ready failures.
Migration: no.

**M-2 — No Admin override for progression** (no manual completion, no homework waiver, no
attendance exemption). The only override is `QuizRetryGrant`. Files: `src/app/api/admin/*`
(only quiz-retries qualifies). Roles: Admin, Student. Risk: stuck students need DB surgery.
Migration: no (feature gap).

**M-3 — Read-side mutation:** `GET /api/students/me/session-videos` can write
`Student.batchId` (lazy `syncStudentBatch`); reconciliation can CLEAR batches, changing video
visibility on a read. Files: `src/lib/enrollment.ts`, the route. Roles: Student. Risk: surprise
state drift; hard to reason about "why did my videos disappear". Migration: no.

**M-4 — Dead schema and naming collisions:** `Enrollment`/`Track` models declared dead (but the
`Enrollment` TYPE in `src/lib/enrollment.ts` is a live, unrelated projection); `Lesson.isLocked`
inert; `Lesson.isPublished` mirror; `Material.storageKey` legacy; `SessionVideoView.durationSec`
per-row copy. Risk: onboarding confusion, future wrong reads. Migration: cleanup-only phase.

**M-5 — Teacher attendance GET** accepts `sessionId` without verifying the session belongs to the
queried `groupId` (exposure limited: records map only onto the group's own students). File:
`src/app/api/teacher/attendance/route.ts`. Roles: Teacher. Risk: low information confusion.
Migration: no.

**M-6 — Two curriculum universes (official 23 + archived legacy R1)** coexist in teacher/admin
scope with dual-chain plumbing everywhere; correct but a permanent cognitive tax and a source of
"which lesson is this?" errors in teacher pickers (mitigated by officialCode display).
Files: `src/lib/official-curriculum.ts`, all dual-chain readers. Roles: Admin, Teacher.
Risk: mis-attachment of quizzes/homework to legacy twins. Migration: optional archival cleanup.

### LOW

**L-1 — `SessionVideo.requiredPercent` (default 95) is editable per video (50–100) but only the
watcher reads it**; readiness/progression use the fixed 95. Files: session-videos PATCH,
watcher route, `src/lib/progress.ts`. Roles: Admin, Student.

**L-2 — `Lesson.duration` default 90 (minutes) is metadata only** (no gate reads it); quiz
`timeLimit` is enforced but lesson duration is decorative.

**L-3 — Mock exam "assigned exams" surface** (`/api/students/me/mock-exams`) and setup flow sit
outside the lesson world entirely — correct by design, flagged so the target model preserves the
boundary.

**L-4 — Notification fan-out targets course×track, not batch or group** — documented ("GROUP IS
NOT TRACK"); consistent with the model, listed for completeness.

---

## 18. Recommended Target Academic Model (proposal — not implemented)

### 18.1 Single source of truth

**Keep `Lesson` as THE canonical academic Session.** Do not introduce a new `Session` entity.
Rationale: (1) every governance system (lifecycle, readiness, progression, track, enrollment,
quiz, homework, materials, notifications, parent preview) is already Lesson-anchored and
defensively built; (2) the two satellites are *facets* whose back-links already exist in the
schema (`SessionVideo.lessonId`, `LiveSession.lessonId`) — the defect is that the links are
optional/unused, not that the entities are wrong; (3) a new Session entity would force a third
curriculum universe and duplicate the lifecycle/track machinery the platform has spent Phases
11–18 eliminating.

The target: **one `Lesson` row = one academic session**, with mandatory, first-class facet links.

```
Course → Part → Unit → Lesson  (officialCode 1-1..7-3; status; trackScope; curriculumStatus)
   │
   ├── SessionVideo  (lessonId MANDATORY; batchId stays = audience/segment)
   │       "the recording(s) of THIS session, published per track-batch"
   ├── Material      (PDF/materials, lesson-anchored — unchanged)
   ├── Quiz          (lesson-anchored — unchanged)
   ├── Homework      (lesson-anchored — unchanged)
   ├── LessonProgress (canonical per-student completion state + video watch record — unified)
   ├── LiveSession   (lessonId MANDATORY when it represents the session's live teaching;
   │       optional "extra meeting" allowed for make-ups — product decision)
   │       └── Attendance (per student, per meeting — unchanged)
   └── SessionPublication (unchanged)
```

### 18.2 How each question is answered in the target

- **Media attachment:** `SessionVideo.lessonId` becomes REQUIRED (new rows via API; existing
  rows backfilled/curated). `batchId` remains the *audience* dimension (which school type's
  students see it) — the video is "published once per track, attached to the session". The admin
  upload UI gains a lesson picker (default: the session being staged). A video can belong to
  exactly one lesson and exactly one batch (current unique semantics preserved).
  `Lesson.videoUrl`/`pdfUrl` become frozen legacy read-only (sunset after migration).
- **Teacher access to Sessions:** unchanged (Group→course→lesson) but the teacher session
  workspace (§18.4) shows readiness outcomes and gates authoring on non-archived lessons.
  Teachers still cannot publish or upload official media (product decision, §23).
- **Quiz attachment:** unchanged (lesson-anchored); empty-quiz creation blocked at creation time
  or flagged in the teacher UI so `QUIZ_EMPTY` never surprises the admin.
- **Homework attachment:** unchanged (lesson-anchored).
- **Attendance attachment:** `LiveSession.lessonId` becomes mandatory for "session meetings"
  (a new minimal admin/teacher scheduling route creates LiveSessions against a lesson; make-up
  meetings may stay lesson-less — flagged as product decision). Attendance keeps its current
  shape (per meeting, per student).
- **Student curriculum reads:** the course tree embeds the lesson's session videos (presence +
  the player resolves to the batch video of the student's track when `videoUrl` is empty), and
  the recordings list remains the flat batch view. One query family, one relation
  (`Lesson.sessionVideos` ∩ student batch ∩ published).
- **Readiness evaluates:** the SAME relation the student reads (lesson-linked, published,
  batch-applicable), plus an explicit report of per-track coverage; the SHARED two-batch rule
  stays (it is correct) but the checklist already names the missing batch — surfaced in the UI
  (done) and in the admin video view (add: "linked to session X" column + lesson picker).
- **Progression evaluates:** the canonical watch record for the lesson's session video(s) for the
  student's batch: `videoDone(L) = no eligible video OR watch ≥ max(requiredPercent of the
  student's video(s))`, read from the unified watch table (§18.3). Quiz/homework gates unchanged.
- **Admin overrides:** keep `QuizRetryGrant`; add (product decision) a narrow audited
  "manual completion/waiver" action per (student, lesson, gate) — recommended, because today a
  stuck student requires DB surgery.
- **Parent observes:** unchanged surfaces, now fed by the unified watch record (so parent "video
  watched" matches what the child did to the batch video).

### 18.3 Unified video watch record (the core fix)

Replace the dual system with ONE per (student, session-video) fact, exposed to progression:

- Canonical row: `SessionVideoView` (student × sessionVideo) — it is already keyed to the
  actual media and carries `requiredPercent` via the parent.
- Progression's `videoDone(L, student)` = over the lesson's PUBLISHED session videos applicable
  to the student's batch: none exist → not required (or: required=false, same as today's
  missing-component rule); at least one exists → the video for the student's batch (track) must
  be complete (percent ≥ its requiredPercent).
- `LessonProgress.video*` columns become the *projection* for lessons that still carry a legacy
  `videoUrl` (frozen behavior until sunset), or are retired after backfill (§20).
- Dashboards/reports (`src/lib/progress.ts`) read the same canonical rows, per student batch —
  parent/teacher "video progress" stops diverging from student truth.

### 18.4 Teacher Session workspace (target)

Teacher opens a lesson (own course) and sees in ONE surface: readiness checklist state (read-only
copy of the admin checklist), its videos per track, PDFs, quiz (create/edit/empty-warning),
homework (create/grade), the lesson's live meetings + attendance (create meeting for the lesson,
record attendance), and the per-student status against the lesson's gates (who's stuck on what).
This is a composition of existing endpoints plus one new (meeting creation) — no second data
model.

### 18.5 What is explicitly NOT changed

- The lifecycle state machine, ceremonies, and `SessionPublication` (they are correct).
- Track isolation, enrollment/entitlement, and the dual-chain curriculum (until the legacy
  archive cleanup decision).
- Mock Exam domain (separate, clean boundary — §10).
- The one-attempt quiz + admin retry grant architecture (Phase 26D).
- Frozen quiz answers / material 10-check download contract.

---

## 19. Recommended Role Model (proposal — compared to current)

| Responsibility | Proposed | Current code | Compatibility |
|---|---|---|---|
| **ADMIN** curriculum structure (Course/Part/Unit/Lesson create+edit, archive) | ✔ | ✔ (DRAFT-only create, placement immutable, archive/restore) | Fully compatible |
| ADMIN prepare Session: upload/publish official media (video per track, PDF) | ✔ | ✔ today via batch; needs lesson-link step (UI/API) | Compatible + C-1 fix |
| ADMIN assign groups/teachers | ✔ | ✔ (Group.teacherId, admin groups/students) | Compatible |
| ADMIN mark ready / publish / unpublish | ✔ | ✔ (ceremonies) | Compatible |
| ADMIN global oversight + safe override | ✔ override = narrow, audited manual gate-waiver + quiz retry | only quiz retry exists | Compatible; M-2 gap to close |
| ADMIN Mock Exams / central question bank | ✔ | ✔ | Compatible (boundary preserved) |
| **TEACHER** access assigned Session/Group | ✔ own-group courses, all lesson states | ✔ (no lifecycle filter — correct for management) | Compatible |
| TEACHER take Attendance | ✔ per session meeting | ⚠ per LiveSession but no meeting-creation route | H-3 fix needed |
| TEACHER create Session Quiz / Homework | ✔ own-course lessons, non-archived | ✔ (archived refused; DRAFT allowed — keep, with readiness visibility) | Compatible (+M-1 UX) |
| TEACHER grade Homework, review Quiz attempts | ✔ | ✔ | Compatible |
| TEACHER track assigned students | ✔ dashboard/analytics | ✔ (legacy video universe until §18.3) | Compatible after unification |
| TEACHER upload official media | **No** (proposal) | No (no routes) | Compatible as-is |
| TEACHER modify curriculum structure | **No** (proposal) | No (no routes) | Compatible as-is |
| **STUDENT** consume/watch/open/quiz/submit/progress | ✔ | ✔ (modulo C-1/C-2 fixes) | Compatible after fixes |
| **PARENT** read-only child progress/grades/homework/attendance/notes/completion | ✔ | ✔ (aggregates; per-session detail absent) | Compatible; optional per-session detail |

The proposed model is a **strict superset of the current architecture's intents** (it matches the
Phase 18/19 role docs) and requires no permission inversions; the only new grants are (a)
teacher/admin meeting creation (or admin-only — decision), (b) an audited admin gate-waiver, and
(c) admin ability to see teacher-authored readiness blockers.

---

## 20. Data Migration Considerations

All are data/behavior migrations; none require new entities. Each is scoped to its roadmap phase
(§21) and must be idempotent + reversible where possible.

| # | Migration | Data touched | Risk | Notes |
|---|---|---|---|---|
| M1 | **Link existing SessionVideos to lessons** (`SessionVideo.lessonId` backfill) | SessionVideo | Medium | No automatic rule is safe: matching by title is guesswork. Recommend an admin curation screen (video list + lesson picker + "link" action, PATCH already supports `lessonId`); unresolvable videos stay lesson-less (still student-visible as batch recordings). No destructive default. |
| M2 | **Decide the legacy `Lesson.videoUrl` rows** | Lesson, LessonProgress | Medium | Inventory rows with real (non-placeholder) `videoUrl`. Options: (a) retire — progression gate off for those lessons (matches today's behavior only for lessons that already have SessionVideos); (b) migrate each into a per-batch SessionVideo (duplicates bytes/URL rows). Decide per course content. Placeholder `"#"` rows are inert. |
| M3 | **Reconcile watch records** | SessionVideoView ↔ LessonProgress | Medium | After C-1/C-2 land, the canonical watch row is per (student, sessionVideo). For students who watched a legacy `videoUrl` (LessonProgress) on a lesson that now has a linked SessionVideo, the old completion does NOT automatically map to the new video (different media, possibly different duration) — recommend: no automatic credit; admin can issue per-student waivers (M-2 feature). Preserve all rows (history), add nothing destructive. |
| M4 | **LiveSession cleanup / lesson-link backfill** | LiveSession, Attendance | Low | Production LiveSessions (if any) are seed artifacts; verify per environment. When the meeting-creation route lands, new rows carry lessonId; old rows stay as-is (attendance history preserved). |
| M5 | **Dead schema cleanup** (Enrollment/Track models, isLocked column, Material.storageKey, isPublished mirror) | schema + data | High (destructive) | Recommend a LATER dedicated phase after the functional fixes prove out; keep read-only compatibility until external consumers (exports, raw SQL) are confirmed gone. |
| M6 | **Legacy R1 curriculum archival** (finalize Phase 11 intent) | Lesson.curriculumStatus | Low | Already done by the reconciler for code-less lessons; only residual LEGACY-status lessons (if any) need review. |

**No migration may:** rewrite quiz/homework history, delete attempts/submissions, or change
`officialCode`. All facet links above are additive (nullable→populated) and cascade-safe
(`SessionVideo.lessonId` is `SetNull` on lesson delete; `LiveSession.lessonId` optional).

---
## 21. Phased Implementation Roadmap (proposal — NOT implemented)

Small, mergeable phases. Each lists goal, likely affected files/models, migration?, risk,
required tests, acceptance criteria, and dependencies. Ordering is by dependency; A is the
foundation for B/C/D.

### Phase A — Canonical Session identity: make the video link real
- **Goal:** `SessionVideo.lessonId` becomes the load-bearing relation; admin can create/edit
  videos WITH a lesson; no new entity, no schema change (column exists).
- **Files:** `src/app/api/admin/session-videos/route.ts` (+`[id]`),
  `src/components/admin/session-videos-view.tsx` (lesson picker, default = staged session),
  `src/lib/admin-sessions.ts` (optional validation helper: lesson must belong to a course,
  non-archived), readiness notes already surface coverage.
- **Migration:** no (M1 curation UI rides along; no forced backfill).
- **Risk:** LOW. Pure additive write path + UI.
- **Tests:** API: create video with lessonId (valid/invalid/out-of-course/archived lesson);
  link/unlink via PATCH; readiness sees linked+published video per track; unlinked video remains
  student-visible but readiness-invisible (documented state).
- **Acceptance:** admin can, from the session detail screen, attach a video to that session and
  see it appear in the readiness VIDEO row; an unlinked video is explicitly labeled "batch
  recording (not attached to a session)".
- **Depends on:** none.

### Phase B — Media → Session alignment on the student side
- **Goal:** the lesson page + course tree render the session's video from
  `Lesson.sessionVideos` (batch-applicable, published) when `lesson.videoUrl` is absent; one
  canonical "video of this session for me" resolution shared by tree badge, lesson page, and
  recordings list.
- **Files:** `src/app/api/courses/[slug]/route.ts` (`hasVideo` + per-track video presence),
  `src/app/api/lessons/[id]/route.ts` (include eligible session videos after the gate),
  `src/components/course/student-lesson.tsx` (player fallback to batch video),
  `src/components/course/session-videos-view.tsx` (lesson context chip),
  `src/components/course/student-course.tsx` (badge), `src/lib/session-progress.ts` (no change
  yet — progression lands in Phase H).
- **Migration:** no (M1 helps completeness).
- **Risk:** MEDIUM (student-facing rendering; redaction rules must be preserved: locked lessons
  must not leak video ids/urls — presence booleans only).
- **Tests:** locked lesson exposes no video descriptor (ids/urls); unlocked lesson with linked
  video in own batch shows it; other-track video never appears; legacy `videoUrl` still wins when
  set (frozen behavior); external URL vs upload streaming both work.
- **Acceptance:** symptom 3/5/6 no longer reproducible: a linked+published video renders on the
  session page under its Session identity, the tree badge is true, and the recordings list is
  the same video (not a parallel one).
- **Depends on:** A.

### Phase C — Student curriculum aggregation
- **Goal:** the course tree is the single place a student sees Video/PDF/Quiz/Homework presence
  per lesson (already true for PDF/quiz/homework; extend to video), plus a per-lesson
  "requirements" consistency between tree and lesson page (both from
  `getCourseSessionProgress`).
- **Files:** `src/app/api/courses/[slug]/route.ts`, `src/components/course/*`; likely a shared
  payload builder in `src/lib/` (single mapper for lesson row → client payload used by tree AND
  lesson page).
- **Migration:** no.
- **Risk:** MEDIUM (payload shape change consumed by one SPA; version the client accordingly).
- **Tests:** payload parity (tree row vs lesson page) for the same lesson; redaction matrix
  (locked/unlocked × draft/published × track) extended with video fields.
- **Acceptance:** one student, one course: every badge on the tree matches the lesson page
  content exactly; no second video list diverges from the session.
- **Depends on:** B.

### Phase D — Readiness alignment
- **Goal:** readiness evaluates exactly what the student will read (same relation set as
  Phases B), reports per-track coverage with actionable codes, and the checklist UI shows the
  missing-batch / unlinked-video states plainly. Also: teacher-visible readiness state on the
  authoring screens (read-only) so `QUIZ_EMPTY`-style blocks are explained at the source.
- **Files:** `src/lib/session-lifecycle.ts` (keep pure; extend `notes`/`items` detail only if
  needed — the codes already exist), `src/app/api/admin/lessons/[id]/readiness/route.ts`,
  admin session views (`session-workflow-view`, `session-detail-view`, `session-open-dialog`),
  teacher authoring components (readiness chip), `src/app/api/teacher/lessons/route.ts` (attach
  readiness for own-course lessons, optional flag).
- **Migration:** no.
- **Risk:** LOW-MEDIUM (computation is frozen by tests; only reporting/UX changes).
- **Tests:** matrix: SHARED lesson × {0,1,2 batch videos} × {linked, unlinked} × {published,
  staged} → exact codes/notes; teacher chip reflects live computation (no second engine).
- **Acceptance:** Mark Ready can never fail for a reason the admin (or teacher) has not already
  seen in a checklist item; symptom 7 is diagnosable in one screen.
- **Depends on:** A (needs the link to exist to be meaningful).

### Phase E — Teacher Session workspace
- **Goal:** one teacher surface per lesson combining readiness chip, videos (view only), PDF
  (view only), quiz editor, homework editor/grading, meetings+attendance, and per-student gate
  status (who is stuck on which requirement of THIS lesson).
- **Files:** `src/components/teacher/*`, `src/app/api/teacher/lessons/[id]` (NEW — lesson detail
  with gate-status aggregation), reuse of `getCourseSessionProgress` per-student (batched),
  existing teacher routes unchanged.
- **Migration:** no.
- **Risk:** MEDIUM (new read endpoint; aggregation performance — batch queries, no N+1).
- **Tests:** scope (own courses only, other course → 403/404 split), no student PII beyond
  roster, gate-status correctness against `getCourseSessionProgress`, archived-lesson behavior.
- **Acceptance:** a teacher can answer "why is student X stuck after session 1-2?" without admin
  or DB; authoring actions show their readiness effect immediately.
- **Depends on:** D (readiness reporting), A (videos attached).

### Phase F — Attendance (meeting creation + lesson link)
- **Goal:** LiveSessions become schedulable and lesson-linked in production: minimal creation
  route (role decision: teacher for own group's lessons, and/or admin) with `lessonId` mandatory
  for session meetings; teacher attendance surface gains meeting creation; student/parent
  "next session" and dashboards gain the lesson identity.
- **Files:** `src/app/api/teacher/sessions` (NEW or extend `teacher/attendance`),
  `src/app/api/admin/sessions` (NEW, optional admin variant), `src/lib/` small helper for
  meeting validation (own group, own course lesson, future startAt, capacity), dashboards
  (teacher/student/parent) to surface lesson context; schema: none (column exists).
- **Migration:** no (M4 verification only).
- **Risk:** MEDIUM (new write surface; must scope strictly to own groups × own course lessons).
- **Tests:** scope matrix (foreign group → 403, foreign lesson → 404, archived lesson refused?),
  duplicate scheduling allowed (make-ups), attendance % unchanged semantics, student sees lesson
  title on next-session banner.
- **Acceptance:** a teacher can schedule "Session 1-3 live meeting", take attendance, and the
  student/parent surfaces show it under that session's identity.
- **Depends on:** none hard (independent of A–E); scheduled after E for UI coherence.

### Phase G — Quiz/Homework alignment
- **Goal:** close the residual coupling gaps: (1) block/flag empty-quiz creation at the teacher
  UI (server still enforces via readiness); (2) document+surface that passing is NOT a gate (or
  flip — product decision); (3) optional: admin homework fallback (create/grade) IF the role
  decision requires it (§23); (4) no changes to frozen-attempt/retry architecture.
- **Files:** `src/app/api/teacher/quizzes*`, `src/components/teacher/teacher-authoring.tsx`,
  optionally `src/app/api/admin/homework*` (NEW only if decided).
- **Migration:** no.
- **Risk:** LOW.
- **Tests:** empty-quiz refusal UX; readiness state after adding first question; (if decided)
  admin homework scope tests identical to teacher scope + audit rows.
- **Acceptance:** no readiness block is ever "surprising"; the pass-vs-complete semantics are
  the decided ones and shown consistently (student sees "completed" vs "passed" distinctly).
- **Depends on:** D (visibility), E (workspace) preferred.

### Phase H — Progression gate alignment (the semantic fix)
- **Goal:** `videoDone(L, student)` reads the canonical session-video watch record
  (`SessionVideoView` over the lesson's PUBLISHED, batch-applicable videos) instead of only
  `Lesson.videoUrl`; legacy `videoUrl` lessons keep today's behavior during transition
  (frozen fallback), then sunset per M2; dashboards/reports (`src/lib/progress.ts`) switch to
  the same canonical rows; optional gates (passing, grading, attendance, manual override)
  implemented ONLY per the product decisions (§23), each behind its own flag + tests.
- **Files:** `src/lib/session-progress.ts` (the gate), `src/lib/progress.ts` (universe +
  summaries), `src/app/api/lessons/[id]/route.ts` (requirements row), heartbeat routes
  (unchanged), admin override route (NEW, audited, if decided), certificates/export readers.
- **Migration:** YES — M3 (watch-record reconciliation policy; non-destructive, row-preserving).
- **Risk:** HIGH (progression semantics — the most sensitive code in the platform).
- **Tests:** exhaustive: legacy-video lesson frozen-behavior pin; modern lesson: no video → not
  required; video in own batch unwatched → locked; watched to requiredPercent → gate satisfied;
  other-track video irrelevant; unpublished video irrelevant; legacy+modern coexistence;
  entitlement/track/lifecycle interactions unchanged; performance (batched queries).
- **Acceptance:** the documented rule "watch video ≥ 95% (or the session's required percent) AND
  quiz attempted AND homework submitted ⇒ next unlocks" is TRUE for both legacy and modern
  lessons, and the requirements UI shows the real gate.
- **Depends on:** A, B (relation + reader alignment), D (readiness parity), G (gate semantics
  decided), M3 decision.

### Phase I — Parent visibility
- **Goal:** parent surfaces read the unified watch record (video progress matches child truth),
  show per-session completion states (not just fractions), and surface session meetings +
  attendance with lesson identity (after F). No new permissions.
- **Files:** `src/app/api/parents/me/dashboard|analytics|weekly-report`, `src/lib/progress.ts`
  (shared), `src/lib/parent-access.ts` (universe helpers — likely unchanged),
  `src/components/parent/*`.
- **Migration:** no (rides M3 effect).
- **Risk:** LOW-MEDIUM (reporting; universe predicates are frozen by Phase 26E tests).
- **Tests:** parent numbers equal child-universe truth (existing Phase 26E invariants extended);
  no cross-child leakage; locked/draft invisibility preserved.
- **Acceptance:** a parent's "video watched", "session completed", and "attendance" statements
  all reference the same session identity as the child's screen.
- **Depends on:** H, F.

### Phase J — End-to-End QA & hardening
- **Goal:** full-workflow verification + the medium/low fixes: M-3 (move batch reconciliation
  off the read path into write paths + an admin "reconcile" action), M-5 (attendance GET
  session-group check), L-1 (requiredPercent surfaced in readiness/progression consistently),
  performance pass (tree + progress batched queries), and a scripted end-to-end academic journey
  (register → enroll → admin stages video+PDF+quiz+homework per session → mark ready → open →
  student watches/quizzes/submits through 3 sessions → teacher grades + takes attendance →
  parent sees all) in the offline test harness style used by the Phase 26 suites.
- **Files:** cross-cutting; new `tests/academic-workflow-e2e.test.js` (offline, mocked Prisma,
  real handlers — same pattern as `tests/final-integration-phase22.test.js`).
- **Migration:** no (M5 cleanup phase is separate and later).
- **Risk:** LOW.
- **Tests:** the E2E journey itself + regression of every gate matrix from Phases B–I.
- **Acceptance:** one scripted journey passes from clean DB state; no role can observe a fact
  another role's truth contradicts (media, readiness, progression, attendance all agree on the
  same session).
- **Depends on:** A–I.

**Explicitly deferred (not in this roadmap):** mock exam redesign, payment/subscription flows,
the dead-schema cleanup (M5), legacy R1 content removal beyond archival, and any new Session
entity (rejected — see §18.1).

---

## 22. Test Strategy

### 22.1 Read-only checks performed in this audit

| Check | Command | Result |
|---|---|---|
| Full offline test suite | `node --test tests/*.test.js` (61 suites) | **60 pass, 1 fail** — the failure is `tests/final-integration-phase22.test.js`, which requires a local seeded `db/custom.db` + `backups/` directory (environment artifact, not a code defect; it fails at "db/custom.db missing for curriculum check" and a missing `backups/` scandir) |
| Core academic suites individually | `node --test` on session-progression, session-lifecycle-phase13, session-materials-phase14, session-media-publishing-audit, teacher-workflow-phase18, track-architecture-phase12 | all green (162 + 371 + 310 + 208 + 127 assertions across the sampled suites) |
| Schema inspection | read `prisma/schema.prisma` (1454 lines) + `prisma/postgres/schema.prisma` diff | postgres schema byte-identical modulo provider (derived artifact) |
| Migration inventory | `ls prisma/migrations` (12 migrations) | matches phase history; no unapplied drift observable statically |
| Route role inventory | grep of `requireRole`/`user.role` across `src/app/api` | used to build §16 matrix |
| No DB was created, no data written, no route executed against a server | — | audit is fully static + offline-test based |

### 22.2 Strategy for the future phases

The platform's proven pattern (used by Phases 13–26) is: **offline behavioural tests with a
mock Prisma that validates `where`/`orderBy` against the real schema**, plus **source-invariant
tests** that pin gate expressions into the HTTP surface. The roadmap phases must follow it:

1. **Gate matrices as data:** every predicate (visibility, readiness, progression, material
   download, teacher scope) is table-driven over the full state matrix
   (lifecycle × archive × track × enrollment × batch × component-presence). The existing
   suites already do this for lifecycle/progression/track — extend, don't duplicate.
2. **One-relation invariants:** new source-invariant tests asserting the student video reader,
   the readiness VIDEO branch, and the progression video gate all reference the SAME relation
   set (preventing C-1 regression), mirroring `tests/session-media-publishing-audit.test.js`.
3. **Frozen-behavior pins:** legacy `videoUrl` progression, legacy `pdfUrl` descriptors, and
   all Phase 4/5/13/16 semantics keep existing pinning tests unchanged (they are the contract).
4. **E2E academic journey** (Phase J): the full register→stage→publish→consume→grade→observe
   journey in the offline harness (real route handlers, mocked DB), asserting cross-role
   consistency of every fact (video seen = readiness sees = progression gates = parent reports).
5. **Performance guards:** batch-query assertions (no N+1) on the tree/progress/teacher
   aggregation endpoints (the codebase already carries this convention).
6. **Non-goals for tests:** no test may encode a proposed design before the corresponding phase
   lands (the audit brief forbids changing tests to match a proposed design); each phase's tests
   land WITH that phase.

---

## 23. Open Product Decisions (explicitly unresolved — NOT decided by this audit)

1. **Is `Lesson` the canonical Session?** — this audit RECOMMENDS yes (§18.1); final owner sign-off needed.
2. **Should PDF be required for READY or optional?** — currently OPTIONAL (NOT_APPLICABLE). Changing to required blocks every PDF-less session from publishing.
3. **Must every Session have a Quiz?** — currently NO (optional; but if present, non-empty).
4. **Must every Session have Homework?** — currently NO (optional; if present, must have instructions).
5. **Does Quiz require completion or passing for progression?** — currently **completion (any finished attempt)**; `passed`/`passMark` are stored and reported but NOT gated.
6. **Does Homework require submission or grading for progression?** — currently **submission only**; grading is never a gate.
7. **Does Attendance affect progression?** — currently NO. If yes: which state counts (PRESENT/LATE?), is one absence tolerated, does it gate the session or the course?
8. **Can Admin create/modify Teacher Quiz/Homework?** — currently NO (admin has no homework routes at all; admin quiz authoring goes through the question bank + AI generation, not the teacher routes). An admin fallback would also need a grading decision.
9. **Can Teacher upload official media?** — currently NO. Propose: keep NO (official media is an Admin act); teacher sees readiness, admin publishes.
10. **Can Teacher modify curriculum structure?** — currently NO. Propose: keep NO.
11. **Can one Session belong to multiple Groups/Batches?** — lessons are course-wide (all groups of the course share the same lesson); media are per-batch (track). Group-level lesson variants do not exist and would break the single-progression-universe rule. Recommend: keep lesson = course-level, batch = media audience only.
12. **Are media shared between Groups or duplicated per Batch?** — today: shared `MediaAsset` bytes, one `SessionVideo` row per batch (so "duplicated" as a publication row, shared as bytes). Recommend keeping exactly this.
13. **Should a manual Admin override unlock a Session?** — currently IMPOSSIBLE (no mechanism). Recommend: yes, narrow + audited + per-gate (§18.2) — decision needed.
14. **How does the Parent see Session completion?** — currently fractions/aggregates only. Decision: per-session completion list (recommended, Phase I) with the same lock/redaction semantics as the student tree.
15. **Meeting creation authority (Phase F):** teacher-only (own group × own lesson) vs admin-only vs both.
16. **Legacy sunset:** when to freeze `Lesson.videoUrl`/`pdfUrl` readers (after M2 decision) and when to drop dead schema (M5).
17. **`SHARED` lesson video coverage:** keep the both-batches requirement (recommended — it is correct) and only improve surfacing; or allow a single "shared" video mechanism (would need a schema decision — NOT recommended).

---

## 24. Final Audit Verdict

**READY FOR AUDIT REVIEW**

### Conclusion

1. **Lesson vs Session:** `Lesson` IS the canonical academic Session (option A). The platform
   uses one curriculum, one lifecycle, one progression engine, and one track system — all
   Lesson-anchored. The inconsistency is not a second curriculum but **split facets**: recorded
   media live on `SessionVideo` (batch-anchored, lesson-link unused by the UI) and live
   attendance lives on `LiveSession` (group-anchored, lesson-link unwritten, no production
   creation path). Fix by making the existing facet links mandatory and aligning
   readiness/progression to the student's actual read path — not by adding a Session entity.
2. **Current progression formula (as found in code):**
   `NextLessonUnlocked = entitled AND prev PUBLISHED/non-archived/on-track AND
   (no legacy videoUrl OR LessonProgress video ≥ 95%) AND (no quiz OR all quizzes have a
   finished attempt) AND (no homework OR all homework submitted)` — with the video clause
   **inert for all lessons staged after Phase 15** (critical finding C-2).
3. **Recommended target source of truth:** `Lesson` (single academic session), with
   `SessionVideo.lessonId` mandatory (batch = audience), `LiveSession.lessonId` mandatory for
   session meetings, one unified per-(student, sessionVideo) watch record feeding
   progression + dashboards + parents, and the existing lifecycle/readiness/ceremony machinery
   unchanged.
4. **Critical/High issues:** C-1 (video triple-relation split), C-2 (progression video gate
   inert for modern lessons), H-1 (readiness/student visibility divergence incl. SHARED
   two-batch rule + sticky batchId), H-2 (PDF lifecycle-order trap), H-3 (LiveSession/Attendance
   disconnected from Lesson and from production writes), H-4 (dual video-watch systems).
5. **Proposed implementation phases:** A (video link) → B (student media alignment) → C
   (curriculum aggregation) → D (readiness alignment) → E (teacher session workspace) → F
   (attendance/meetings) → G (quiz/homework coupling) → H (progression gate alignment, with
   migration M3) → I (parent visibility) → J (E2E QA + hardening). Each is small, mergeable,
   test-pinned, and dependency-ordered (§21).
6. **Unresolved product decisions:** 17 items listed in §23 — none were silently decided.
7. **Checks performed:** full offline test suite (60/61 green; 1 environment-dependent failure
   requiring a local seeded DB + backups dir), targeted academic suites, schema + migrations
   inspection, full route/role inventory, component-level render-path tracing. No data was
   written; no source code, schema, or migration was changed.

### Delivery confirmation

- Branch: `arena/01a0b179-codemind-academy`
- Changed files: `docs/ACADEMIC_SESSION_WORKFLOW_AUDIT.md` (this document) — the ONLY
  intentional repository change.
- No application source, Prisma schema, migration, or production behavior was modified.
- No PR opened, no merge, no deployment.
