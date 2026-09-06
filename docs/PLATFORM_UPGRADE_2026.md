# CodeMind Academy — Platform Upgrade (Academic Year 2026 / 2027)

This document is the engineering record for the integrated platform upgrade:
architecture audit → design → implementation → migration → testing.

---

## 1. Architecture audit (state BEFORE this change)

### 1.1 Identity & roles

```
User (id, email unique, password scrypt, role Role, isActive)
 ├── Student   (1-1, userId unique)  grade, schoolName, schoolType?, nationalId?, studentCode?, groupId?
 ├── Parent    (1-1)  → ParentStudentLink (parentId, studentId) unique pair
 ├── Teacher   (1-1)  → Group[] , LiveSession[]
 └── ADMIN has no profile table (role only)
```

* `Student.schoolType` **already existed** as a nullable `String` and is already
  written by registration (`ARABIC` / `LANGUAGE`, validated in
  `src/app/api/auth/[action]/route.ts`) and by the admin create-student route.
  → **No new school-type field was created.** It was reused everywhere and only
  indexed + normalised.

### 1.2 Course / content tree

```
Course → Part → Unit → Topic → Lesson
Lesson → Quiz[] → Question[]           (quiz questions)
Lesson → Homework[] → HomeworkSubmission[]
Lesson → ExamQuestion[]                (standalone exam-only questions)
Lesson → LessonProgress[]              (per student: progress 0-100, isCompleted)
Group  → Course, Teacher?, Student[], LiveSession[]
```

**Enrollment is expressed by `Student.groupId → Group.courseId`.** There is no
separate `Enrollment` table; `Subscription` (1-1 with Student) carries the paid
state. → **No new enrollment model was created**; the existing group/subscription
pair is the source of truth and is now enforced server-side.

### 1.3 Question bank / mock exams (state before)

* "Question Bank" was **not a model** — it was a *view* over `Question`
  (`/api/admin/question-bank` lists `Question` rows) plus `ExamQuestion`.
* Mock exams were **not persisted as a definition** at all. `/api/exams/mock`
  generated a random exam on the fly from `Question` + `ExamQuestion` of the
  student's course, and stored only the result in `ExamAttempt`
  (`answers` = JSON snapshot, so history survives question deletion).
* There was **no relation capable of representing school type** on questions.

→ Minimum structural change chosen: **tag the existing `Question` and
`ExamQuestion` models with `schoolType`** (nullable = shared bank) and add a
persisted `MockExam` definition + `MockExamQuestion` join. No second question
model, no question duplication.

### 1.4 Sessions / videos (state before)

* `Lesson.videoUrl` (single URL, rendered in an `<iframe>`).
* `LiveSession` (group scheduled session) with `recordingUrl`.
* No upload pipeline, no per-student video progress (only a coarse
  `LessonProgress.progress` written by a "Mark as complete" button).

### 1.5 Auth / sessions (state before)

* Cookie `cm_session` → random token stored as a **`Setting` row**
  (`key = "session:<token>"`, `value = "<userId>|<expiry>"`).
* No password reset. No device tracking. No rate limiting.

---

## 2. Design decisions

| Requirement | Decision | Why |
|---|---|---|
| Arabic/Language student split | reuse `Student.schoolType` + index | field already existed & is populated at registration |
| Separate question banks | `Question.schoolType` / `ExamQuestion.schoolType` (`null` = shared) | extends the existing bank instead of duplicating questions |
| Mock exam student type | new `MockExam.schoolType` + `MockExamQuestion` join | exams need a persisted definition to guarantee bank isolation |
| Session videos | `Batch` (one per school type) + `SessionVideo` + `MediaAsset` | media stored **once**, published to a batch, access resolved per student |
| 95 % video rule | extend `LessonProgress` with heartbeat fields | avoids a parallel progress table; one source of truth |
| Session progression | server-side `session-progress` service | no hardcoded ids; derives from the real lesson order |
| Password reset | `PasswordResetToken` (hashed, single use) + `SecurityRateLimit` | tokens are never stored or logged in plaintext |
| Single device | `UserSession` rows + `User.status` | replaces the `Setting` hack, allows revocation & audit |
| Quiz camera | `QuizAttemptEvidence` + private `MediaAsset` storage | snapshots only, RBAC-gated, never public URLs |

---

## 3. Deployment

See `## F. Deployment / Migration Guide` in `docs/DEPLOYMENT_GUIDE.md` and the
migration `prisma/migrations/20260906120000_platform_upgrade_2026/migration.sql`.
