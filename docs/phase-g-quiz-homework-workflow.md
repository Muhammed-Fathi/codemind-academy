# Phase G — Quiz / Homework Operational Workflow

**Status:** implementation record (discovery findings + approved design).
**Base:** `main` @ bb600e1 (Phase F closed and merged).
**Branch:** `arena/01a0ba29-codemind-academy`.

---

## 1. Discovery findings

### 1.1 Quiz authority (existing)

| Concern | Authority | Location |
| --- | --- | --- |
| Blueprint (selection rule) | `Quiz.quizMode / questionCount / difficultyPlan / shuffleOptions / maxAttempts` (Phase 26D, TEXT/INT columns) | `prisma/schema.prisma`, `src/lib/quiz-blueprint.ts` |
| Attempt state machine | `QuizAttempt.attemptNumber / status / retryGrantId` + `@@unique([quizId, studentId, attemptNumber])` | schema, `src/lib/session-quiz.ts` |
| Frozen question snapshot | `QuizAnswer.*Snapshot` columns written once at attempt start | schema, `seedAttemptQuestions` |
| Retry grants | `QuizRetryGrant` (admin-only via `/api/admin/quiz-retries`, audited `QUIZ_RETRY_GRANTED`) | `src/lib/quiz-retry.ts` |
| Concurrency | `acquireQuizDestructiveLock` (PG advisory lock / SQLite single-writer) taken by `POST /api/quizzes/[id]/start`, quiz DELETE and question DELETE | `src/lib/db-serialization.ts` |
| Question edit guards | `questionEditGuards` (grading fields + schoolType locked once any answer row exists) | `src/lib/teacher-content.ts` |
| Teacher scope | canonical `Course → Part → Unit → Lesson` chain from `Group.courseId`, never client-supplied | `src/lib/teacher-content.ts` |

**What was MISSING:** a Quiz had no lifecycle state at all. A quiz created by a
teacher was instantly student-visible through any unlocked lesson; there was no
draft, no publish validation, no preview endpoint, no duplication workflow.

### 1.2 Homework authority (existing)

| Concern | Authority | Location |
| --- | --- | --- |
| Model | `Homework` (title/titleAr/instructions/deadline/maxMarks/trackScope) | schema |
| Submission | `HomeworkSubmission` with `@@unique([homeworkId, studentId])`, statuses `PENDING/SUBMITTED/GRADED/LATE`, `submittedAt`, `grade`, `feedback` | schema |
| Student submit | `POST /api/students/me/homework` (text content only, upsert on unique pair, LATE past deadline, GRADED immutable) | route |
| Teacher grading | `PATCH /api/teacher/homework/[id]/grade` (validates 0..100 — **not** maxMarks; no grader identity; no audit) | route |
| Student visibility | unlocked-lesson gate + track scope (`canAccessHomework`) | `src/lib/session-progress.ts` |
| Progression | every homework of a lesson must be submitted before the next lesson unlocks (`getCourseSessionProgress`) | `src/lib/session-progress.ts` |

**What was MISSING:** lifecycle (draft/published/closed), teacher assignment
attachment, student file submission, late visibility in teacher payloads,
maxMarks-bounded grading, grader identity, audit.

### 1.3 Attachment / media authority (existing)

- `MediaAsset` (kind VIDEO/IMAGE/DOCUMENT, storage EXTERNAL_URL/LOCAL_PRIVATE/S3,
  `storageKey`, `mimeType`, `sizeBytes`, `originalName`, `isPrivate`).
- Presigned direct upload (`src/lib/media-upload.ts`): purposes
  `SESSION_VIDEO` / `LESSON_PDF` only; intent token HMAC-bound to key/user/purpose/
  size/MIME; object verified BEFORE any DB row; idempotent completion;
  teacher leg `/api/teacher/media-uploads/init|complete` pinned to `LESSON_PDF`.
- Local dev fallback: `MEDIA_BACKEND=local` ⇒ `PRESIGNED_UNSUPPORTED` and the
  client falls back to a buffered endpoint (same pattern reused here).
- Authorized download proxies: `/api/media/[id]` (videos/evidence) and
  `/api/materials/[id]` (lesson PDFs, 10-check contract). No signed GET URLs.
- `MAX_PDF_BYTES` already defaults to 25 MB; PDF MIME allow-list is
  `application/pdf` only with `%PDF-` magic verification.

### 1.4 Audit / notifications / i18n (existing)

- `AuditLog` (userId/action/entity/entityId/details) — written by session
  lifecycle, payments, quiz retries, attendance corrections, absence review.
- `notify.ts` — preference- and quiet-hours-aware single + bulk emission;
  `session-notifications.ts` — recipient derivation (`getEligibleSessionRecipients`)
  and chunked deduped fan-out. `NotificationType` already includes
  `NEW_HOMEWORK`, `HOMEWORK_DEADLINE`, `NEW_QUIZ`, `QUIZ_RESULT`.
- i18n — flat dict keys (`api.NNN`, `teacher.NNN`, `student.NNN`, `course.NNN`)
  in `src/lib/i18n-dict-2026.ts`; `translate()` never leaks raw keys.

### 1.5 UI surfaces (existing)

- Teacher session workspace (`src/components/teacher/teacher-sessions.tsx`):
  QuizzesCard (create/edit metadata/QuestionManagerDialog/delete) and
  HomeworkCard per lesson — the Phase E operational surface.
- Teacher dashboard tabs (`teacher-dashboard.tsx`): legacy QuizzesView +
  HomeworkView with grading form.
- Student: `student-dashboard.tsx` HomeworkView (text-only submit form),
  `course/student-lesson.tsx` homework card, quiz runner (attempts through the
  frozen architecture).
- Shared UI kit: Dialog/Select/Badge/Tabs/ScrollArea/Toasts in `src/components/ui`.

### 1.6 Duplicate / parallel implementations

None found to consolidate: exactly one quiz attempt pipeline, one homework
submission writer (student route) + one grading writer (teacher route), one
storage stack. Phase G extends them; it builds no parallel system.

### 1.7 Is a schema migration required?

**Yes — a single additive migration.** The required lifecycle (draft/published/
closed), teacher attachment, student file submission and grader identity cannot
be expressed by the current schema. Everything else (attempt freezing, locks,
late classification, uniqueness) already exists and is reused untouched.

---

## 2. Phase G design (approved decisions mapped)

### 2.1 Schema (additive only — no rebuild, no destructive default)

`Homework`:
- `status String @default("PUBLISHED")` — `DRAFT | PUBLISHED | CLOSED`, stored
  as TEXT (house style: `QuizAttempt.status`, `Quiz.quizMode`). Default
  `PUBLISHED` keeps **every existing row** visible/operational — zero
  behavioural change for existing data. New teacher-created rows start `DRAFT`
  (the create route writes it explicitly).
- `attachmentId String? → MediaAsset` (`onDelete: SetNull`) — teacher file.
- `publishedAt DateTime?`.

`HomeworkSubmission`:
- `attachmentId String? → MediaAsset` (`SetNull`) — student file.
- `gradedById String? → User` (`SetNull`), `gradedAt DateTime?`.

`Quiz`:
- `status String @default("PUBLISHED")` — `DRAFT | PUBLISHED` (same reasoning:
  existing quizzes stay live; new ones are drafts until validated publish).
- `publishedAt DateTime?`.

MediaAsset gains back-relations only (`homeworkAttachments`,
`homeworkSubmissions`). User gains `homeworkGraded`.

Migration `20260919180000_phase_g_quiz_homework_workflow` (SQLite edition in
`prisma/migrations/`, PostgreSQL twin in `prisma/postgres/migrations/`, baseline
regenerated via `scripts/db/make-postgres-schema.mjs`, parity proven offline via
PGlite exactly like Phase F).

### 2.2 Homework lifecycle (server-authoritative)

- `POST /api/teacher/homework` → creates **DRAFT** (unchanged validation).
- `POST /api/teacher/homework/[id]/publish` — `DRAFT→PUBLISHED` or
  `CLOSED→PUBLISHED` (re-open); idempotent for PUBLISHED. Audited
  `HOMEWORK_PUBLISHED`; `NEW_HOMEWORK` fan-out to eligible students through the
  existing preference-aware machinery (dedupeKey per publish event).
- `POST /api/teacher/homework/[id]/close` — `PUBLISHED→CLOSED`; audited
  `HOMEWORK_CLOSED`. CLOSED stays historically visible; new submissions refused.
- Metadata PATCH kept in every state; edits after publish are audited
  (`HOMEWORK_UPDATED` with the changed field list). Deleting stays refused once
  any submission exists (unchanged).
- Student list: only `PUBLISHED`/`CLOSED`. Student submit: only `PUBLISHED`
  (CLOSED → 409, DRAFT → 404 as nonexistent).

### 2.3 Late policy

`submittedAt > deadline ⇒ status LATE` (existing enum value, existing rule in
the student route). The deadline stays on the Homework row, `submittedAt` is
the actual timestamp, teacher payloads now carry `lateCount` and per-submission
`late` flags; the UI shows متأخر badges. No auto-reject, no progression change.

### 2.4 Homework files (one storage system)

- Teacher assignment attachment: new presigned purpose
  `HOMEWORK_ATTACHMENT` in the Phase 23 flow (teacher leg, lesson-ownership
  chain before any grant, intent token bound to the teacher + homework), plus a
  buffered fallback route used only when `MEDIA_BACKEND=local`
  (`PRESIGNED_UNSUPPORTED`), mirroring the lesson-PDF pattern.
- Student submission file: presigned purpose `HOMEWORK_SUBMISSION` on a new
  student leg (`/api/students/me/homework-upload/init|complete`) with the
  access gate (unlocked lesson + PUBLISHED + track) checked at init AND at
  completion; buffered multipart accepted on the same JSON route for local dev.
- Allow-lists (extension + declared MIME, both enforced; magic bytes where a
  stable signature exists):
  - teacher: PDF (`application/pdf`), DOCX, PPTX, ZIP — 25 MB max.
  - student: PDF, DOCX, JPG/JPEG, PNG, ZIP — 25 MB max.
- **Documented widening:** the pre-G infrastructure only admitted
  `application/pdf` documents (verified by magic bytes). OOXML/ZIP share the
  ZIP container signature, so magic verification distinguishes container family
  only; JPEG/PNG/PDF keep full magic verification. Mitigations: private bucket,
  server-generated unguessable keys, authorized proxy download only,
  `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`, no
  executable/script extension admitted, filename sanitisation unchanged.
- Download authorization added to `/api/media/[id]` (assignment file: owning
  teacher / admin / eligible student of a non-DRAFT homework; submission file:
  submitting student / owning teacher / admin). No signed URLs introduced.

### 2.5 Grading

- `PATCH /api/teacher/homework/[id]/grade` now enforces `0 ≤ grade ≤ maxMarks`
  (was 0..100), records `gradedById`/`gradedAt`, refuses DRAFT homework, and
  audits `HOMEWORK_GRADED` / `HOMEWORK_REGRADED`. The existing student
  notification (reusing `QUIZ_RESULT`-style copy) is preserved.

### 2.6 Quiz preview

- `GET /api/teacher/quizzes/[id]/preview` — teacher scope only. Returns the
  student-facing structure (title, description, mode/blueprint, attempts config,
  pass mark, time limit, questions with type/options/marks/difficulty) plus a
  publish-readiness report. **Creates zero attempts** (pure read; no writes at
  all).

### 2.7 Quiz publish validation

`POST /api/teacher/quizzes/[id]/publish` refuses structurally invalid quizzes:
- ≥1 question; every stored question re-validated through the SAME
  `validateQuestionDraft` the write routes use (options present for MCQ, answer
  index in range, marks in range);
- blueprint re-validated through `validateBlueprintInput` + cross-field rule;
- BLUEPRINT mode: the plan must be satisfiable for EVERY track the quiz serves
  (pool size + difficulty quotas);
- FIXED mode: ≥1 eligible question for every track the quiz serves.
On success: `status=PUBLISHED`, `publishedAt`, audit `QUIZ_PUBLISHED`,
`NEW_QUIZ` fan-out (preference-aware, deduped). Re-publish is idempotent.

### 2.8 Quiz lock after first attempt (race-safe, server-side)

Once the FIRST `QuizAttempt` exists, the question blueprint is immutable:
- question PATCH refuses ALL fields (tightened: prompt/explanation/difficulty
  were previously still editable),
- question DELETE refused (unchanged),
- question APPEND refused (new),
- quiz DELETE refused (unchanged),
- blueprint columns are not exposed to any teacher PATCH path (documented: the
  only post-attempt editable metadata is title/titleAr/description/passMark/
  timeLimit; trackScope was already locked after attempts — both are safe:
  historical attempts store frozen snapshots and their own `passed` verdict).
All guarded mutations take `acquireQuizDestructiveLock` as the FIRST statement
of a transaction and re-check the attempt count inside it — the same lock
`POST /api/quizzes/[id]/start` takes before freezing, so the first-attempt/
edit race is totally ordered on both providers.

### 2.9 Quiz duplicate / new version

`POST /api/teacher/quizzes/[id]/duplicate` — copies metadata + blueprint +
questions (new ids, order preserved) into a NEW `DRAFT` quiz. Never copies
attempts, answers, retry grants or results. Audited `QUIZ_DUPLICATED`.

### 2.10 Student visibility & progression (non-goal respected)

Student quiz reads (GET/start/submit/attempts/evidence) return 404 for
non-PUBLISHED quizzes. Student lesson-content and the progression universe only
count student-real rows: quizzes `PUBLISHED`, homework `PUBLISHED|CLOSED`.
This is a VISIBILITY-consistency rule, not a progression redesign: a DRAFT
assessment does not exist for students, therefore it cannot be a unlock
requirement (a draft left unpublished would otherwise lock the course forever —
the one critical bug the lifecycle itself would introduce). CLOSED homework
remains a requirement exactly as today (submissions still satisfy it).
**Phase H dependency documented:** progression still requires submitted
homework + attempted quiz per lesson; Phase G changed only which rows are
student-visible.

### 2.11 Notifications

Reused, not extended: `NEW_HOMEWORK` (homework publish), `NEW_QUIZ` (quiz
publish), grading keeps the existing student notification. Preference flags and
quiet hours enforced by the shared `notify.ts` machinery. The
`HOMEWORK_DEADLINE` type stays reserved: no deadline-approaching cron is added
in Phase G (would require a new Vercel cron entry pinned by the Phase 24 cron
gate) — documented as follow-up. Phase F absence notifications untouched.

### 2.12 Audit events (existing AuditLog, no new infra)

`HOMEWORK_PUBLISHED`, `HOMEWORK_CLOSED`, `HOMEWORK_UPDATED` (post-publish
edits), `HOMEWORK_GRADED`, `HOMEWORK_REGRADED`, `QUIZ_PUBLISHED`,
`QUIZ_DUPLICATED`. No audit rows for reads or harmless UI interactions.
