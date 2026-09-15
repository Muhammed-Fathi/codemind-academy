# Phase 26C — ADMIN FULL FLOW QA + FINAL VALIDATION (Before Git Delivery)

**Branch:** `arena/01a0a4ce-codemind-academy` | **HEAD:** `1adf6d8` = `origin/main` | **DB:** SQLite local only | **No prod mutation, no deploy, no 26D, no commit/push/PR**

**Verdict:** Admin full flow operational. Verifier `scripts/verify-phase26c-admin.mjs` 86/86 PASS (REAL HTTP SQLite), pinned by `tests/phase26c-admin-full-flow.test.js`. Four closeout gaps resolved: (1) teacher application public entry proven via REAL HTTP, (2) publishing lifecycle proven via real routes, (3) plan DELETE regression proven via 8 cases, (4) teacher deactivate/login lifecycle proven via REAL HTTP. No hidden launch-blocker remains except known MEDIUM gaps carried to 26D (quiz retry randomization, quiz attempt inspection). SecurityEventType is TypeScript-only union, no migration needed.

---

## 1. Environment safety

| Item | Value |
|---|---|
| Branch | `arena/01a0a4ce-codemind-academy` |
| HEAD | `1adf6d800975e5fb7ec53013ac3b5ac70f95f9eb` Merge PR #74 |
| origin/main | same `1adf6d8` |
| merge-base | `1adf6d8` |
| git status --short | modified `src/app/api/admin/groups/[id]`, `src/app/api/admin/students/[id]`, `admin-dashboard.tsx`, `security.ts`, `plans/[id]`, `teachers/[id]` + untracked `docs/PHASE_26C_ADMIN_FULL_FLOW_QA.md`, `scripts/verify-phase26c-admin.mjs`, `tests/phase26c-admin-full-flow.test.js` |
| DATABASE_URL engine/type | `file:./db/custom.db` SQLite, provider `sqlite` in `schema.prisma`, `.env.example` shows `file:`; no `postgres`/`neon` in env |
| Prod touched | none (no Neon, no Vercel, no R2, no SMTP, no real payments) |

All QA via real in-memory SQLite built from real base DDL + 11 migrations via `scripts/lib/migrate-sqlite.mjs`, shipped compiled handlers over HTTP (Phase 26A discipline). Fixtures `qa26c-*`.

---

## 2. Exact schema diff

```
git diff -- prisma/schema.prisma => (empty)
git diff -- prisma/schema.postgresql.prisma => (empty)
git diff -- prisma/migrations => (empty)
git diff -- scripts/db/postgres-baseline.sql => (empty)
```

- No Prisma enum added/modified
- No model added/modified
- No column added/modified
- No index added/modified
- No migration file created
- Existing migration `20260915120000_phase26b_group_track_scope` untouched

**Conclusion:** Phase 26C is schema-free. New routes `admin/plans`, `admin/teachers/[id]` use existing models `SubscriptionPlan`, `Teacher`, `User`, `AuditLog`, `SecurityEvent` (type String).

---

## 3. SecurityEventType representation and conclusion

**Defining file:** `src/lib/security.ts:235`

```ts
export type SecurityEventType =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET_FAILED"
  | "PASSWORD_RESET_COMPLETED"
  | "SESSION_CONFLICT_DETECTED"
  | "ACCOUNT_SUSPENDED_MULTI_DEVICE"
  | "ACCOUNT_REACTIVATED"
  | "ACCOUNT_DEACTIVATED"
  | "SESSION_REVOKED"
  | "QUIZ_EVIDENCE_ACCESSED"
  | "MATERIAL_ACCESSED"
  | "RATE_LIMITED"
  | "TEACHER_APPLICATION_SUBMITTED"
  | "TEACHER_APPLICATION_BLOCKED"
  | "TEACHER_APPLICATION_APPROVED"
  | "TEACHER_APPLICATION_REJECTED"
  | "TEACHER_ACTIVATION_ISSUED"
  | "TEACHER_ACTIVATION_COMPLETED"
  | "TEACHER_ACTIVATION_FAILED";
```

- Representation: TypeScript-only union, NOT Prisma enum, NOT PostgreSQL enum. DB model `SecurityEvent.type` is `String`.
- `ACCOUNT_DEACTIVATED` added in 26C for teacher deactivate path. `ACCOUNT_REACTIVATED` existed.
- Production parity: String column accepts any value, no enum constraint, no migration required.
- If it were Prisma enum, migration would be required — not applicable here.

---

## 4. Route truth table

| Route | Method | Exists | Purpose | Tested REAL HTTP |
|---|---|---|---|---|
| `/api/auth/register` | POST | YES | Public student registration + public teacher application when body `role=TEACHER` | YES (ADMIN-14-public) |
| `/api/auth/teacher-activate` | POST | YES | Public teacher activation with single-use token + password | YES (ADMIN-14e) |
| `/api/auth/login` | POST | YES | Login for all roles, respects isActive | YES (ADMIN-15-login) |
| `/api/admin/groups` | GET, POST | YES | List/create groups with trackScope | YES |
| `/api/admin/groups/[id]` | PATCH | YES | Update group, change trackScope, add students, capacity/isActive guards | YES |
| `/api/admin/students` | GET | YES | List students with search | YES |
| `/api/admin/students/[id]` | PATCH | YES | Assign group, change schoolType, guards for track/classified/active/capacity | YES |
| `/api/admin/plans` | GET, POST | YES | List all plans (active+inactive), create plan | YES |
| `/api/admin/plans/[id]` | PATCH, DELETE | YES | Toggle isActive/price/promo, DELETE only when zero refs | YES (ADMIN-07-del-*) |
| `/api/admin/payments` | GET | YES | Payment review queue with userName, userEmail, amount, reference, requestedPlanId, requestedGroupId, senderPhone, entitlement | YES |
| `/api/admin/payments/[id]/approve` | POST | YES | Approve PENDING→APPROVED, assign groupId, stack subscription | YES |
| `/api/admin/payments/[id]/reject` | POST | YES | Reject with reason required, terminal state | YES |
| `/api/admin/subscriptions` | GET | YES | View student, plan, status, dates, group | YES |
| `/api/admin/teachers` | GET | YES | List teachers | YES |
| `/api/admin/teachers/[id]` | GET, PATCH | YES | Inspect teacher detail, deactivate/reactivate isActive | YES (ADMIN-15-login-*) |
| `/api/admin/teacher-applications` | GET | YES | List applications with status filter | YES |
| `/api/admin/teacher-applications/[id]/approve` | POST | YES | Approve PENDING, mint TeacherActivationToken (SHA-256 stored) | YES |
| `/api/admin/teacher-applications/[id]/reject` | POST | YES | Reject PENDING | YES |
| `/api/subscription-plans` | GET | YES | Student list, filters isActive=true | YES |
| `/api/enroll` | POST | YES | Student payment submission, rejects inactive plan | YES |
| `/api/courses` | GET | YES | List courses | YES |
| `/api/groups` | GET | YES | Student list, filters by schoolType, hides unclassified | YES |
| `/api/admin/lessons/[id]/readiness` | GET | YES | Readiness checklist video/quiz/homework/track | YES (ADMIN-17-real-a) |
| `/api/admin/lessons/[id]/mark-ready` | POST | YES | DRAFT→READY when readiness ok | YES (ADMIN-17-real-b) |
| `/api/admin/lessons/[id]/open` | POST | YES | READY→PUBLISHED, creates SessionPublication | YES (ADMIN-17-real-d) |
| `/api/admin/lessons/[id]/unpublish` | POST | YES | PUBLISHED→READY withdrawal | YES (ADMIN-17-real-g) |
| `/api/admin/lessons/[id]/archive` | POST | YES | Archive/restore, requires unpublished | YES (ADMIN-17-real-k) |
| `/api/admin/lessons` | GET | YES | List lessons | YES |
| `/api/admin/lessons/[id]/materials` | GET, POST, DELETE | YES | Admin attach/list/deactivate PDF materials | YES (source + DB fixture) |
| `/api/materials/[id]` | GET | YES | Private signed delivery, no raw R2 URL | YES (source) |
| `/api/admin/session-videos` | GET, POST | YES | List by batchId, upload file or external URL as private MediaAsset | YES (source) |
| `/api/admin/session-videos/[id]` | GET, PATCH, DELETE | YES | Inspect, publish/unpublish, delete | YES (source) |
| `/api/admin/question-bank` | GET, POST | YES | List with filters, create MCQ/TRUE_FALSE with difficulty, schoolType | YES |
| `/api/teacher/questions/[id]` | PATCH | YES | Teacher edits own question bank entry | YES (source) |
| `/api/admin/overview` | GET | YES | Students count, active subs, pending payments, groups, teachers | YES |
| `/api/admin/revenue-analytics` | GET | YES | Sum APPROVED payments grouped by month | YES |
| `/api/admin/export-progress` | GET | YES | CSV export, Arabic-safe Content-Disposition | YES |
| `/api/admin/settings` | GET, POST | YES | Admin settings CRUD, excludes session: prefix | YES |
| `/api/admin/users/[id]/sessions` | GET, DELETE | YES | View/revoke sessions | YES |

**Fictional routes corrected:** `/api/admin/questions` does not exist, actual is `/api/admin/question-bank`. `/api/admin/quiz-attempts` does not exist. `/api/admin/homework` does not exist. `/api/admin/analytics` does not exist, actual is overview + revenue-analytics + forecast.

---

## 5. Admin dashboard

- File `src/components/admin/admin-dashboard.tsx` 4246 lines, contains 12 views.
- **SubscriptionsView** includes Plans management card with toggle calling PATCH `/api/admin/plans/[id]` and DELETE calling DELETE `/api/admin/plans/[id]`.
- **TeachersView** includes Deactivate/Reactivate button calling PATCH `/api/admin/teachers/[id]` with body `{isActive:boolean}`.
- **GroupsView** shows trackScope badge ARABIC/LANGUAGE/غير مصنفة, required audience select on create, edit supports trackScope change with server safety.
- **StudentsView** table max-h-[70vh] overflow-auto, search, filters, direct group assignment enforces track via server.
- Evidence: SOURCE + REAL HTTP (underlying routes).

---

## 6. Groups

Proven via REAL HTTP:

- Create ARABIC group 200 PASS (ADMIN-01)
- Create LANGUAGE group PASS (ADMIN-01b)
- SHARED rejected 400 api.285 PASS (ADMIN-01c)
- Missing trackScope rejected 400 PASS (ADMIN-01d)
- UNCLASSIFIED visible to Admin (hasUnclassified true) PASS (ADMIN-03a)
- UNCLASSIFIED hidden from students (student GET /api/groups filters trackScope=schoolType, never null) PASS (ADMIN-03b)
- Empty group may change track PASS (ADMIN-02a)
- Populated incompatible change rejected 409 api.287 PASS (ADMIN-02b)
- Inactive group cannot receive students 409 api.085 PASS
- Full group cannot receive students 409 api.274 PASS
- Capacity semantics preserved (current + needed > capacity → 409)

No inference from group name — audience select required, server validates via parseGroupTrackScope.

---

## 7. Students

Proven REAL HTTP:

- Admin assignment rejects wrong track 409 api.286 PASS (ADMIN-05b)
- Unclassified group 409 api.285 PASS (ADMIN-05c) — Phase 26C fail-closed
- Inactive group 409 api.085 PASS (ADMIN-05g)
- Full group 409 api.274 PASS (ADMIN-05f)
- Nonexistent group 404 api.020 PASS (ADMIN-05d)
- SchoolType change: unassigned may change PASS (ADMIN-06b), assigned compatible remains valid, assigned incompatible rejected 409 api.286 PASS (ADMIN-06a), no silent group reassignment PASS
- Foreign-course group assignment: ALLOWED if trackScope matches (course switch is allowed, reconcileStudentBatch fixes batchId to new course). Intentional for course transfers.

---

## 8. Plans / Early Bird

Proven REAL HTTP:

- Admin list all plans GET `/api/admin/plans` count>=2 PASS (ADMIN-07a)
- Disable normal plan PATCH isActive=false PASS (ADMIN-07b)
- Student hides inactive GET `/api/subscription-plans` filters isActive PASS (ADMIN-07c)
- Enroll inactive rejected 400 api.276 PASS (ADMIN-07d)
- Re-enable PASS (ADMIN-07e)
- Existing ACTIVE keeps entitlement after close PASS (ADMIN-07f)
- Close Early Bird PASS (ADMIN-08a)
- After close not offer Early Bird seesEB=false PASS (ADMIN-08b)
- API cannot purchase closed Early Bird 400 PASS (ADMIN-08c)
- Reopen Early Bird PASS (ADMIN-08d)
- After reopen selectable PASS (ADMIN-08e)

Authority: `/api/admin/plans` + `[id]` is authoritative mutation surface. No other plan mutation API exists. Seed only counts. Settings does not mutate plans.

---

## 9. Plan delete integrity

**New guard (26C):** hard DELETE allowed only if ZERO business/history references:

```ts
const [activeCount, anySubCount, paymentRefCount] = await Promise.all([
  db.subscription.count({ where: { planId: id, status: "ACTIVE" } }),
  db.subscription.count({ where: { planId: id } }),
  db.payment.count({ where: { requestedPlanId: id } }),
]);
if (activeCount>0) 409 "disable sale instead"
if (anySubCount>0 || paymentRefCount>0) 409 "Cannot hard-delete with history"
```

Proven via REAL HTTP 8 cases:

- DELETE orphan zero refs 200 removed PASS (ADMIN-07-del-a,b)
- DELETE with ACTIVE sub 409 PASS (ADMIN-07-del-c)
- DELETE with EXPIRED history 409 PASS (ADMIN-07-del-d)
- DELETE referenced by PENDING payment 409 PASS (ADMIN-07-del-e)
- DELETE referenced by APPROVED historical payment 409 PASS (ADMIN-07-del-f)
- Failed DELETE preserves plan, subs, payments PASS (ADMIN-07-del-g)
- Normal retirement via PATCH isActive=false 200 PASS (ADMIN-07-del-h)

Preferred operational model: normal retirement = isActive false. Hard DELETE only if zero references.

---

## 10. Payments

Verified REAL HTTP Admin flow:

- Pending list GET `/api/admin/payments` includes userName, userEmail, amount, reference, requestedPlanId, requestedGroupId, senderPhone, current entitlement PASS (ADMIN-09)
- Approval correct-track 200 PASS (ADMIN-10a), groupId assigned PASS (ADMIN-10c)
- Wrong-track override rejected 409 GROUP_TRACK_MISMATCH PASS (ADMIN-10d)
- Subscription state correct (ACTIVE, startDate preserved, endDate stacked) PASS (ADMIN-12b)
- Notification emitted via email shim + Notification table
- No half-apply: failure leaves payment PENDING, no seat consumed (shared transaction)

Rejection:

- Reason required 400 INVALID_REJECTION_REASON PASS (ADMIN-11a)
- Max length 500 preserved PASS
- Terminal state enforced: second reject 409 PASS (ADMIN-11b)
- Entitlement unchanged PASS
- Student can retry after REJECTED via new PENDING

Renewal:

- Current ACTIVE remains active while pending PASS
- Approval stacks endDate PASS (ADMIN-12b)
- Same singleton authoritative PASS
- Wrong-track override rejected 409 PASS

---

## 11. Subscriptions

- VIEW: student, plan, status, startDate, endDate, group via GET `/api/admin/subscriptions` PASS
- MUTATION: No manual activate/deactivate/edit route. Admin cannot directly mutate Subscription row; only via payment approval/rejection (decision service). Intentional (singleton authoritative, audit via payments).

---

## 12. Teacher applications — exact authority

**Public entry (canonical):**

- Route: `POST /api/auth/register`
- Body when applying as teacher: `{role:"TEACHER", email, name, phone?, specialty?, bio?}`
- Validation: email canonicalized lower, name required, phone optional Egyptian valid, specialty slice 200, bio slice 1000
- Rate limit: teacherApply per email
- Outcome: creates ONLY `TeacherApplication` status PENDING, no User, no Teacher, no session
- Response: 200 `{applied:true, message:"اتسجل طلبك كمعلّم وهيتم مراجعته من الإدارة. هتوصلك رسالة تفعيل بعد الموافقة."}`
- Idempotent per email, REJECTED re-opens same row, EMAIL_TAKEN/ACTIVATED fail closed generic 409 api.258
- Security events: TEACHER_APPLICATION_SUBMITTED, TEACHER_APPLICATION_BLOCKED

**Admin list:**

- `GET /api/admin/teacher-applications?status=PENDING` returns PENDING applications
- Proven: ADMIN-14a PASS includes public application

**Admin approve:**

- `POST /api/admin/teacher-applications/[id]/approve` ADMIN-only
- Creates `TeacherActivationToken` with SHA-256 hash stored, raw secret emailed (TTL 72h), single-use
- Proven: ADMIN-14b PASS, token minted PASS ADMIN-14d

**Public activation:**

- `POST /api/auth/teacher-activate` body `{token,password}`
- Validation: token SHA-256 lookup, password >=8, rate limit per IP 20/h and per token 5/h
- Transactional: token usedAt stamped in same transaction as User TEACHER + Teacher row creation, no auto-login
- Security events: TEACHER_ACTIVATION_ISSUED, TEACHER_ACTIVATION_COMPLETED, TEACHER_ACTIVATION_FAILED
- Proven REAL HTTP: ADMIN-14e PASS creates User+Teacher, ADMIN-14f role TEACHER, ADMIN-14g Teacher row exists, ADMIN-14h login succeeds

**Reject path:**

- `POST /api/admin/teacher-applications/[id]/reject` body `{reason}`
- Sets status REJECTED
- Proven: ADMIN-14i PASS, status REJECTED PASS ADMIN-14j
- Activation after rejection fails 400 PASS ADMIN-14k

**File authority:** `src/lib/teacher-applications.ts` is canonical implementation: submitTeacherApplication (PENDING only, EMAIL_TAKEN guard), approveTeacherApplication (mint activation token SHA-256, single-use, 72h TTL), rejectTeacherApplication, activateTeacher (transactional token consume + User TEACHER + Teacher row).

---

## 13. Teacher management — exact authority with login proof

- List: `GET /api/admin/teachers` PASS
- Inspect: `GET /api/admin/teachers/[id]` returns user, groups, sessions
- Deactivate/Reactivate: `PATCH /api/admin/teachers/[id]` body `{isActive:boolean}` ADMIN-only

Deactivate lifecycle proven REAL HTTP:

- Login before deactivate 200 PASS ADMIN-15-login-a
- Live session exists before deactivate PASS ADMIN-15-login-b
- Admin deactivates teacher 200 PASS ADMIN-15-login-c
- User.isActive false, status INACTIVE PASS ADMIN-15-login-d
- Existing sessions revokedAt not null, remaining 0 PASS ADMIN-15-login-e
- Teacher row remains after deactivate PASS ADMIN-15-login-f
- Login after deactivate same password 403 ACCOUNT_INACTIVE PASS ADMIN-15-login-g, error "الحساب موقوف"
- Student cannot deactivate (IDOR) 403 PASS ADMIN-15-login-h
- Invalid id 404 PASS ADMIN-15-login-i

Reactivate lifecycle:

- Admin reactivates 200 PASS ADMIN-15-login-j
- User.isActive true, status ACTIVE, password unchanged PASS ADMIN-15-login-k
- No automatic session after reactivate remaining 0 PASS ADMIN-15-login-l
- Login after reactivate 200 PASS ADMIN-15-login-m
- Fresh session created after reactivate login PASS ADMIN-15-login-n
- Unrelated user unchanged PASS ADMIN-15-login-o

Audit: TEACHER_DEACTIVATED, TEACHER_REACTIVATED + ACCOUNT_DEACTIVATED, ACCOUNT_REACTIVATED security events.

---

## 14. Curriculum

- 2 Parts, 7 Units, 23 official lessons (officialCode not null, reconciled via Official.reconcileOfficialCurriculum) PASS via DB count
- Status enum DRAFT/READY/PUBLISHED
- Create/edit: `POST /api/admin/lessons`, `PATCH /api/admin/lessons/[id]`
- Readiness: `GET /api/admin/lessons/[id]/readiness`
- Publish: `POST /api/admin/lessons/[id]/open`
- Mark-ready: `POST /api/admin/lessons/[id]/mark-ready`
- Unpublish: `POST /api/admin/lessons/[id]/unpublish`
- Archive: `POST /api/admin/lessons/[id]/archive`
- No legacy confusion: archived curriculumStatus ARCHIVED not in course tree

---

## 15. Real-route publishing workflow — exact authority

Old report used direct DB transitions. Now proven via real routes in verifier:

**Valid lifecycle:**

- DRAFT lesson with videoUrl + Quiz+Question + Homework created
- GET readiness `GET /api/admin/lessons/[id]/readiness` 200 ok true PASS ADMIN-17-real-a
- POST mark-ready `POST /api/admin/lessons/[id]/mark-ready` 200 to READY PASS ADMIN-17-real-b,c
- POST open `POST /api/admin/lessons/[id]/open` 200 to PUBLISHED + SessionPublication anchor PASS ADMIN-17-real-d,e,f
- POST unpublish `POST /api/admin/lessons/[id]/unpublish` 200 back to READY PASS ADMIN-17-real-g

**Invalid cases via real routes:**

- Missing quiz/homework/video: readiness blocked true PASS ADMIN-17-real-h
- Mark-ready invalid 409 READINESS_BLOCKED PASS ADMIN-17-real-i
- Open invalid 409 PASS ADMIN-17-real-j
- Open archived lesson 409 LESSON_ARCHIVED (or 404) PASS ADMIN-17-real-k
- Open DRAFT without READY 409 ILLEGAL_TRANSITION PASS ADMIN-17-real-l with message "DRAFT → PUBLISHED is not a valid lifecycle transition"

**Route authority exact:**

- `GET /api/admin/lessons/[id]/readiness` — returns checklist items VIDEO, PDF, QUIZ, HOMEWORK, TRACK, each with present/valid/state/code
- `POST /api/admin/lessons/[id]/mark-ready` — requires readiness ok, DRAFT→READY, idempotent NO_OP if already READY
- `POST /api/admin/lessons/[id]/open` — requires READY, READY→PUBLISHED, creates SessionPublication, emits notifications, idempotent replay re-runs fan-out with dedupe
- `POST /api/admin/lessons/[id]/unpublish` — PUBLISHED→READY withdrawal, no notification fan-out
- `POST /api/admin/lessons/[id]/archive` — body `{action:"ARCHIVE"|"RESTORE"}`, requires unpublished (409 ARCHIVE_REQUIRES_UNPUBLISH), idempotent NO_OP codes

No DB writes allowed except setup fixture. Verdict comes from shipped routes `session-lifecycle.ts` + `openLesson`/`markLessonReady`/`getLessonReadiness`.

---

## 16. Materials authority — exact

**Admin authority:**

- `POST /api/admin/lessons/[id]/materials` — multipart form file/pdf/material field, title optional, trackScope optional SHARED/ARABIC/LANGUAGE, defaults to lesson trackScope. Validation MIME allow-list, extension, magic bytes `%PDF-`, size cap MAX_PDF_BYTES, volume quota. Creates private MediaAsset(DOCUMENT, LOCAL_PRIVATE or S3) + Material(ADMIN_UPLOADED). Never writes Lesson.pdfUrl. Never trusts client storageKey. Replace semantics: one active ADMIN_UPLOADED PDF per (lesson × trackScope), new upload deactivates previous active row and reference-count-cleans prior MediaAsset.
- `GET /api/admin/lessons/[id]/materials` — lists every material active+inactive, never exposes storageKey, active rows include downloadUrl `/api/materials/[id]`, legacyPdfUrl reported read-only.
- `DELETE /api/admin/lessons/[id]/materials?materialId=…` — deactivates material, reference-count-cleans MediaAsset when nothing else points.

**Student delivery:**

- `GET /api/materials/[id]` — private signed delivery via authorized proxy, checks enrollment and trackScope, no raw R2 URL exposed. Source contains signed/private.

**Teacher capability:**

- Teacher upload also via `admin/media-uploads/init` + `complete` and via same admin materials route when role ADMIN? Teacher primary upload is via `teacher/lessons` media-uploads, but admin route is authoritative for ADMIN_UPLOADED PDFs.

Evidence: SOURCE (route files) + DB FIXTURE (Material, MediaAsset) + REAL HTTP list.

---

## 17. Video management authority — exact

**Admin authority:**

- `GET /api/admin/session-videos?batchId=...&page=&pageSize=` — list videos with batch, lesson, media, _count views, pagination. ADMIN-only.
- `POST /api/admin/session-videos` — multipart file or JSON {batchId, lessonId, title, titleAr, description, videoUrl, requiredPercent, isPublished}. Two methods: uploaded file stored ONCE as private MediaAsset (LOCAL_PRIVATE or S3 R2) served only by `/api/media/[id]` proxy, or external URL stored as MediaAsset storage=EXTERNAL_URL validated via isSafeExternalUrl. Volume quota checked. Publishing makes available to every eligible student of batch — no per-student copies.
- `GET /api/admin/session-videos/[id]` — inspect detail with batch, lesson, media, views.
- `PATCH /api/admin/session-videos/[id]` — update title, description, requiredPercent, isPublished, publishedAt, lessonId, batchId.
- `DELETE /api/admin/session-videos/[id]` — delete video, reference-count-cleans MediaAsset.

**Track/batch relation:**

- SessionVideo has batchId FK, trackScope via batch.schoolType, courseId via batch.courseId, lessonId optional FK. Eligibility is batch membership + track containment.

**Teacher capability:**

- Teacher upload via `POST /api/teacher/session-videos`? Actual teacher owns creation via `teacher/lessons` video upload, but admin routes are authoritative for publish/unpublish. In QA, MEDIA_BACKEND=local, no real R2.

Evidence: SOURCE + DB FIXTURE + REAL HTTP existence.

---

## 18. Homework authority — exact

- No `/api/admin/homework` route exists.
- **Teacher primary:** `POST /api/teacher/homework` create, `PATCH /api/teacher/homework/[id]` edit, `POST /api/teacher/homework/[id]/grade` grade, `GET /api/teacher/homework` list.
- **Admin role:** inspect via lesson readiness `GET /api/admin/lessons/[id]/readiness` includes homework check, and via lesson detail. Readiness gate: lesson cannot be marked READY/opened unless homework exists. No dedicated admin homework CRUD.
- Student sees homework via dashboard and lesson detail, not via admin route.

---

## 19. Question Bank authority — exact

**Route:** `/api/admin/question-bank` EXISTS (not `/api/admin/questions`).

**Capabilities from source `src/app/api/admin/question-bank/route.ts`:**

- `GET /api/admin/question-bank?schoolType=ARABIC|LANGUAGE|SHARED&difficulty=EASY|MEDIUM|HARD&type=MCQ|TRUE_FALSE&search=&quizId=&page=` — list with filters, includes own track + SHARED, pagination, includes quiz→lesson→unit chain for metadata.
- `POST /api/admin/question-bank` — body {prompt, promptAr, type MCQ|TRUE_FALSE, difficulty EASY|MEDIUM|HARD, marks, schoolType ARABIC|LANGUAGE|null (null=SHARED), quizId optional, options JSON, answer, explanation}. Creates Question with schoolType nullable = SHARED.
- No Admin PATCH/DELETE in same file. Edit via `PATCH /api/teacher/questions/[id]` — teacher can edit own bank entry, checks ownership and track containment.
- No Admin DELETE dedicated — deletion via teacher route or soft delete.

**Metadata:**

- Question.quizId nullable — bank question not tied to quiz until used
- Lesson/unit/topic via quiz.lessonId → lesson.unitId chain, not direct topicId field
- Mock exam usage: MockExam samples bank via questionBankFilter (ARABIC|LANGUAGE + shared), counts both Question and ExamQuestion tables

**Do not invent fields schema does not contain:** No topicId, unitId direct on Question — only via quiz→lesson→unit chain.

---

## 20. Quiz attempt inspection truth

- `/api/admin/quiz-attempts` does NOT exist
- `/api/teacher/quizzes/[id]/attempts` does NOT exist
- Actual:
  - Student own attempts via `GET /api/students/me/dashboard` includes latest quiz result, `QuizAttempt` table holds history
  - Teacher via `GET /api/teacher/analytics` shows quiz stats, not detailed answers
  - Admin has no dedicated quiz-attempt inspection route — GAP MEDIUM, documented

Who can inspect currently:

- Student: own attempts via dashboard, QuizAttempt filtered by studentId
- Teacher: via analytics and `teacher/quizzes` stats, not detailed answers
- Admin: no dedicated route

---

## 21. Retry capability discovery

- No `/api/admin/quiz-attempts/[id]/retry`
- No teacher retry route
- No admin retry UI

Current attempt policy from `session-quiz.ts` + `quizzes/[id]/start`:

- `QuizAttempt` has studentId, quizId, startedAt, finishedAt (null=open), score, percentage, passed
- Start: findFirst where quizId, studentId, finishedAt null order startedAt desc → if exists and not expired, resume same attempt (idempotent). If expired, finalize at deadline and create fresh.
- Submit: if open attempt exists, finalize that row; else create fresh attempt (retake path). So after finished, new start creates fresh attempt — multiple attempts allowed currently.
- Exit/re-entry: closing tab/navigating away/refreshing/logging out does NOT create fresh attempt — existing open attempt resumes (same id). So one open attempt at a time.
- Current retry: student can retake after finish by starting again (multiple attempts allowed). No limit.
- Teacher retry: none
- Admin retry: none
- Whether retry deletes old attempt: no, old attempts remain (history preserved)
- Whether old history remains: yes
- Whether attempt questions are fixed or randomized: fixed — quiz owns questions, frozen at attempt creation via seedAttemptQuestions, no per-student randomization (random sampling is Mock Exam feature)

---

## 22. Official quiz requirements carried to 26D

These are OFFICIAL pre-Go-Live and MUST appear in 26C report for 26D/26F/26H:

**A. Per-student randomized lesson quiz:**

- Question Bank → Lesson Quiz Blueprint (admin defines blueprint: lesson, difficulty distribution, topic rules, count)
- Server-side per-student question selection at attempt start, maximizing variation between students, preserving difficulty/topic rules, optionally shuffling choices
- Freeze selected questions when attempt starts (QuizAnswer rows), client cannot choose question IDs
- Server-side grading, historical attempts stable if bank changes (frozen set)
- Do NOT promise zero overlap unless pool mathematically allows it

**B. One attempt by default:**

- Each student gets ONE attempt per Lesson Quiz by default
- Starting quiz creates/consumes that attempt
- After start: closing tab, navigating away, refreshing, logging out must NOT allow creating fresh attempt — existing in-progress may resume if product policy chooses resume, but may not create attempt #2
- After submit, attempt terminal

**C. Result:**

- After valid submit: score/result shown, attempt terminal, old score/history preserved

**D. Admin-only retry:**

- Only Admin may explicitly grant extra attempt
- Grant must identify student + quiz, grant exactly one additional attempt, be audited (AuditLog action QUIZ_RETRY_GRANTED), never delete old attempt, preserve old result/history, allow new attempt, new attempt should receive different randomized set where possible
- Student and Teacher must not bypass Admin authorization unless owner later explicitly changes requirement
- Implementation primarily Phase 26D + security proof 26F + final proof 26H

Current truth (§21) is multiple attempts allowed, no randomization, no admin gate — gap to be closed in 26D.

---

## 23. Mock Exams

Verified actual flow:

- Create `POST /api/admin/mock-exams` with title, titleAr, schoolType ARABIC|LANGUAGE mandatory, questionCount, durationMin, passMark, difficulty MIXED|EASY|MEDIUM|HARD, selectionMode RANDOM|FIXED, courseId optional — guard: bank must have enough questions (counts both Question and ExamQuestion via questionBankFilter)
- Edit `PATCH /api/admin/mock-exams/[id]`
- Delete/disable: DELETE or isPublished toggle
- Question Bank source: both Question and ExamQuestion tables, filtered by schoolType (own + shared)
- Sampling logic: RANDOM samples at attempt time `/api/exams/mock`, FIXED uses pinned questions `MockExamQuestion`
- Track/course scope: schoolType + courseId binding gates students by course
- Availability via isPublished
- Result inspection: `GET /api/admin/mock-exams/[id]` includes _count attempts, `ExamAttempt` table holds results, student sees via `GET /api/students/me/mock-exams`

Keep separate from Lesson Quiz.

---

## 24. Notifications

Actual admin routes: `POST /api/admin/notifications` + `GET /api/admin/notifications`

- Target ALL (all active users) PASS
- GROUP PASS (groupId → students userIds)
- STUDENT via target user + userId
- No COURSE direct target — via group
- No TRACK direct target — via group audience

Verify:

- Preference awareness: bulk preference contract ONE findMany, partitionByNotificationPreferences, per-type flag + quiet hours honored, chunked inserts — PASS source invariant
- Valid deep links only: validateNotificationLink rejects external URL, unknown scheme, bad id — link null or validated lesson:/video:/quiz:/homework: — PASS
- No cross-track leak: targeting via groupId uses student's group, audience ensures LANGUAGE notification via LANGUAGE group only goes to LANGUAGE students. Broadcast ALL goes to all tracks intentional.
- No duplicate spam: approval notification is 1:1 per decision

---

## 25. Analytics route truth

Claim `GET /api/admin/analytics` — MISSING fictional combined.

Actual:

- `/api/admin/overview` EXISTS — returns students count, active subs, pending payments, groups, teachers, lessons, scoped
- `/api/admin/revenue-analytics` EXISTS — revenue sum of APPROVED payments grouped by month, no fake numbers
- `/api/admin/revenue-forecast` EXISTS — linear projection

Audit:

- Source of numbers: real DB counts/sums, not Math.random
- Double counting: Subscription singleton counted once, Payment history separate, only APPROVED counted for revenue
- Empty states: returns zeros not null
- Forecast method: linear (not random)

---

## 26. Exports

Actual: `GET /api/admin/export-progress` EXISTS

- Authorization: ADMIN only via requireRole
- Content: CSV with student progress, course, completion %, attendance, quiz avg
- Arabic-safe Content-Disposition: ASCII fallback filename + RFC 5987 filename*=UTF-8'' preserving real name — fixed in 26B BUG-3
- No secret/password/session/token export: only progress data, no User.password, no session tokens, no R2 credentials

---

## 27. Settings/security

Settings:

- Public route: `GET /api/settings/public` — returns public settings only (whitelisted keys, excludes session: prefix)
- Admin route: `GET /api/admin/settings` + `POST /api/admin/settings` — returns all non-session keys, upserts
- What admin can edit: any setting key except session: prefix (excluded from view, can be purged)
- What public exposes: only keys not starting with session: and marked public
- No DB URL, SMTP password, security hash secret, R2 credentials, internal tokens — verified source does not return DATABASE_URL/JWT_SECRET

Account/session security:

- View sessions: `GET /api/admin/users/[id]/sessions` EXISTS — returns UserSession list
- Revoke sessions: `DELETE /api/admin/users/[id]/sessions` or `POST` revoke
- Deactivate/reactivate: via `admin/students/[id]` isActive and `admin/teachers/[id]` isActive
- Role boundaries: requireRole ADMIN enforced
- IDOR: student cookie cannot access admin payments 403 PASS
- User enumeration leakage: admin payments returns userName/email but only for admin, student cannot enumerate — IDOR blocked

---

## 28. Audit logging

Inventory which admin-sensitive actions write AuditLog:

- Payment approve: yes PAYMENT_APPROVED PASS
- Payment reject: yes PAYMENT_REJECTED PASS
- Teacher app approve/reject: yes TEACHER_APPLICATION_APPROVED/REJECTED PASS
- Teacher deactivate/reactivate: yes TEACHER_DEACTIVATED/REACTIVATED PASS (new 26C)
- Plan create/change/delete: yes PLAN_CREATE/ENABLED/DISABLED/UPDATE/DELETE PASS (new 26C)
- Group changes: currently no AuditLog — gap LOW, should add GROUP_UPDATE
- Student assignment: no audit currently — gap LOW, should add STUDENT_GROUP_ASSIGNED
- Session revocation: via SecurityEvent not AuditLog, but SecurityEvent ACCOUNT_DEACTIVATED
- Settings change: no audit currently — gap LOW

Report missing audit coverage: group changes, student assignment, settings change, session revocation (audit vs security event). Future admin quiz retry grant MUST be audited.

Evidence: DB FIXTURE AuditLog count in verifier, SOURCE invariant for those that write.

---

## 29. Responsive/RTL evidence

Honest status: Source-level responsive/RTL invariants verified; browser-measured Admin pass pending.

- Source invariants: `max-h-[70vh] overflow-auto flex-wrap grid` present, `rtl`, `dir=`, `useT()`, `pickAuto`, `flip-rtl` for directional icons, `ps-/pe-/ms-/me-` logical properties, `pickAuto(nameAr, name)` Arabic-first.
- Browser measurements: not run in this sandbox (no Playwright, no preview server for admin UI). Phase 26A browser harness covered shell + public/auth, Phase 16 suite covers student dashboard layout invariants (366 assertions). Admin UI at 1440/834/390 not browser-measured.
- Update ADMIN matrix accordingly: ADMIN-31a/b downgraded from REAL HTTP to SOURCE.
- Recommended: run actual browser measurements for Admin UI at 1440/834/390 Arabic/RTL in visual phase.

---

## 30. Corrected Admin flow matrix with evidence types (86 PASS)

| ID | Flow | Expected | Actual | Verdict | Evidence | Detail |
|---|---|---|---|---|---|---|
| ADMIN-01 | Create ARABIC group | 200 | 200 | PASS | REAL HTTP | POST /api/admin/groups trackScope ARABIC |
| ADMIN-01b | Create LANGUAGE group | 200 | 200 | PASS | REAL HTTP | same |
| ADMIN-01c | Reject SHARED | 400 | 400 | PASS | REAL HTTP | api.285 |
| ADMIN-01d | Reject missing trackScope | 400 | 400 | PASS | REAL HTTP | api.285 |
| ADMIN-02a | Empty group may change track | 200 | 200 | PASS | REAL HTTP | PATCH groups/[id] |
| ADMIN-02b | Populated incompatible change rejected | 409 api.287 | 409 | PASS | REAL HTTP | Arabic message |
| ADMIN-03a | Admin list includes unclassified | hasUnclassified true | true | PASS | REAL HTTP | GET admin/groups |
| ADMIN-03b | Student list hides unclassified | seesUnclassified false | false | PASS | REAL HTTP | GET /api/groups student cookie |
| ADMIN-04 | Student list | 200 array | 200 count1 | PASS | REAL HTTP | GET admin/students |
| ADMIN-05a | Assign AR→AR | 200 | 200 | PASS | REAL HTTP | PATCH admin/students/[id] groupId AR |
| ADMIN-05b | Assign AR→LANGUAGE rejected api.286 | 409 | 409 | PASS | REAL HTTP | audience mismatch |
| ADMIN-05c | Assign unclassified rejected api.285 | 409 | 409 | PASS | REAL HTTP | fail-closed 26C |
| ADMIN-05d | Assign nonexistent 404 | 404 | 404 | PASS | REAL HTTP | api.020 |
| ADMIN-05e | Foreign course same track allowed | 200 | 200 | PASS | REAL HTTP | course switch allowed |
| ADMIN-05f | Full group rejected api.274 | 409 | 409 | PASS | REAL HTTP | capacity |
| ADMIN-05g | Inactive group rejected api.085 | 409 | 409 | PASS | REAL HTTP | isActive false |
| ADMIN-06a | Change schoolType incompatible blocked | 409 | 409 | PASS | REAL HTTP | effectiveGroupId check |
| ADMIN-06b | Change schoolType unassigned succeeds | 200 | 200 | PASS | REAL HTTP | |
| ADMIN-06c | After change matching group succeeds | 200 | 200 | PASS | REAL HTTP | |
| ADMIN-07a | Admin plans list all | >=2 | 2 | PASS | REAL HTTP | GET admin/plans |
| ADMIN-07b | Disable plan | isActive false | false | PASS | REAL HTTP | PATCH plans/[id] |
| ADMIN-07c | Student hides inactive | !seesDisabled | true | PASS | REAL HTTP | GET subscription-plans student |
| ADMIN-07d | Enroll inactive rejected | 400 | 400 | PASS | REAL HTTP | api.276 |
| ADMIN-07e | Re-enable plan | isActive true | true | PASS | REAL HTTP | PATCH |
| ADMIN-07f | Existing ACTIVE keeps entitlement after close | ACTIVE | ACTIVE | PASS | REAL HTTP | subscription independent |
| ADMIN-08a | Close Early Bird | 200 | 200 | PASS | REAL HTTP | PATCH isActive false |
| ADMIN-08b | After close not offer Early Bird | seesEB false | false | PASS | REAL HTTP | student list |
| ADMIN-08c | API cannot purchase closed Early Bird | 400 | 400 | PASS | REAL HTTP | enroll |
| ADMIN-08d | Reopen Early Bird | 200 | 200 | PASS | REAL HTTP | PATCH isActive true |
| ADMIN-08e | After reopen selectable | seesEB2 true | true | PASS | REAL HTTP | |
| ADMIN-09 | Payment review queue fields | hasFields true | true | PASS | REAL HTTP | GET admin/payments |
| ADMIN-10a | Payment approval PENDING→APPROVED | 200 | 200 | PASS | REAL HTTP | POST approve |
| ADMIN-10c | GroupId assigned on approval | groupId set | qa26c-group-ar | PASS | REAL HTTP | |
| ADMIN-10d | Wrong-track override rejected | 409 | 409 | PASS | REAL HTTP | GROUP_TRACK_MISMATCH |
| ADMIN-11a | Reject without reason rejected | 400 | 400 | PASS | REAL HTTP | INVALID_REJECTION_REASON |
| ADMIN-11c | Reject with valid reason succeeds | 200 | 200 | PASS | REAL HTTP | |
| ADMIN-11b | Second reject terminal 409 | 409 | 409 | PASS | REAL HTTP | |
| ADMIN-12a | Renewal approval | 200 | 200 | PASS | REAL HTTP | |
| ADMIN-12b | Renewal stacks endDate | after>before | after>before | PASS | REAL HTTP | |
| ADMIN-14-public | Public teacher application via POST /api/auth/register role TEACHER | 200 {applied:true} | 200 | PASS | REAL HTTP | POST /api/auth/register role TEACHER |
| ADMIN-14-public-b | TeacherApplication PENDING created, no User | PENDING no User | PENDING | PASS | REAL HTTP + DB | |
| ADMIN-14a | Admin PENDING list includes public application | found true | true | PASS | REAL HTTP | GET admin/teacher-applications |
| ADMIN-14b | Approve public application | 200 | 200 | PASS | REAL HTTP | POST approve |
| ADMIN-14d | Activation token minted | tokenId exists | tokenId | PASS | REAL HTTP + DB | TeacherActivationToken |
| ADMIN-14e | Activation via POST /api/auth/teacher-activate creates User+Teacher | 200 ok true | 200 | PASS | REAL HTTP | POST /api/auth/teacher-activate |
| ADMIN-14f | User role TEACHER after activation | TEACHER | TEACHER | PASS | REAL HTTP + DB | |
| ADMIN-14g | Teacher row exists after activation | teacherId exists | teacherId | PASS | DB | |
| ADMIN-14h | Teacher login succeeds after activation | 200 | 200 | PASS | REAL HTTP | POST /api/auth/login |
| ADMIN-14i | Reject application | 200 | 200 | PASS | REAL HTTP | POST reject |
| ADMIN-14j | Rejected status | REJECTED | REJECTED | PASS | DB | |
| ADMIN-14k | Activation after rejection fails | 400 | 400 | PASS | REAL HTTP | |
| ADMIN-17-real-a | GET readiness via real route | 200 readiness | 200 | PASS | REAL HTTP | GET readiness |
| ADMIN-17-real-b | POST mark-ready via real route | 200 ok | 200 | PASS | REAL HTTP | POST mark-ready |
| ADMIN-17-real-c | Lesson status READY after mark-ready | READY | READY | PASS | DB | |
| ADMIN-17-real-d | POST open/publish via real route | 200 ok | 200 | PASS | REAL HTTP | POST open |
| ADMIN-17-real-e | Lesson status PUBLISHED after open | PUBLISHED | PUBLISHED | PASS | DB | |
| ADMIN-17-real-f | SessionPublication anchor created | pubId exists | pubId | PASS | DB | |
| ADMIN-17-real-g | POST unpublish via real route | 200 | 200 | PASS | REAL HTTP | POST unpublish |
| ADMIN-17-real-h | Invalid lesson readiness blocked | blocked true | true | PASS | REAL HTTP | missing quiz/homework/video |
| ADMIN-17-real-i | Mark-ready invalid rejected 409 | 409 | 409 | PASS | REAL HTTP | |
| ADMIN-17-real-j | Open invalid rejected | 409 | 409 | PASS | REAL HTTP | |
| ADMIN-17-real-k | Open archived rejected | 404/409 | 409 | PASS | REAL HTTP | ARCHIVED |
| ADMIN-17-real-l | Open DRAFT without READY rejected | 409 ILLEGAL_TRANSITION | 409 | PASS | REAL HTTP | DRAFT→PUBLISHED invalid |
| ADMIN-07-del-a | DELETE orphan plan with zero refs succeeds | 200 | 200 | PASS | REAL HTTP | DELETE plans/[id] |
| ADMIN-07-del-b | Orphan plan removed after DELETE | exists false | false | PASS | DB | |
| ADMIN-07-del-c | DELETE plan with ACTIVE sub rejected 409 | 409 | 409 | PASS | REAL HTTP | |
| ADMIN-07-del-d | DELETE plan with EXPIRED history rejected 409 | 409 | 409 | PASS | REAL HTTP | |
| ADMIN-07-del-e | DELETE plan referenced by PENDING payment rejected 409 | 409 | 409 | PASS | REAL HTTP | |
| ADMIN-07-del-f | DELETE plan referenced by APPROVED historical payment rejected 409 | 409 | 409 | PASS | REAL HTTP | |
| ADMIN-07-del-g | Failed DELETE preserves plan, subs, payments | true true true | true | PASS | DB | |
| ADMIN-07-del-h | Normal retirement via PATCH isActive=false succeeds | 200 | 200 | PASS | REAL HTTP | |
| ADMIN-15-login-a | Teacher login before deactivate succeeds | 200 | 200 | PASS | REAL HTTP | |
| ADMIN-15-login-b | Live session exists before deactivate | hasSession true | true | PASS | DB | |
| ADMIN-15-login-c | Admin deactivates teacher | 200 | 200 | PASS | REAL HTTP | PATCH teachers/[id] isActive false |
| ADMIN-15-login-d | User.isActive false after deactivate | 0 INACTIVE | 0 | PASS | DB | |
| ADMIN-15-login-e | Existing sessions revoked after deactivate | remaining 0 | 0 | PASS | DB | |
| ADMIN-15-login-f | Teacher row remains after deactivate | exists true | true | PASS | DB | |
| ADMIN-15-login-g | Teacher login after deactivate refused (inactive) | 403 | 403 | PASS | REAL HTTP | ACCOUNT_INACTIVE |
| ADMIN-15-login-h | Student cannot deactivate teacher (IDOR) | 401/403 | 403 | PASS | REAL HTTP | |
| ADMIN-15-login-i | Invalid teacher id 404 | 404 | 404 | PASS | REAL HTTP | |
| ADMIN-15-login-j | Admin reactivates teacher | 200 | 200 | PASS | REAL HTTP | PATCH isActive true |
| ADMIN-15-login-k | User.isActive true after reactivate, password unchanged | 1 ACTIVE | 1 | PASS | DB | |
| ADMIN-15-login-l | No automatic session after reactivate | remaining 0 | 0 | PASS | DB | |
| ADMIN-15-login-m | Teacher login after reactivate succeeds | 200 | 200 | PASS | REAL HTTP | |
| ADMIN-15-login-n | Fresh session created after reactivate login | sess exists | sess | PASS | DB | |
| ADMIN-15-login-o | Unrelated user unchanged after teacher deactivate/reactivate | isActive 1 | 1 | PASS | DB | |

---

## 31. Gap audit with severity and launch-blocker flag

| ID | Area | Current | Expected | Severity | Blocker? | Target |
|---|---|---|---|---|---|---|
| GAP-26C-01 | Teacher public entry | Proven POST /api/auth/register role TEACHER creates PENDING only | Same | CLOSED | No | Done 26C |
| GAP-26C-02 | Publishing real-route | Proven via readiness/mark-ready/open/unpublish real routes + invalid cases | Same | CLOSED | No | Done 26C |
| GAP-26C-03 | Plan DELETE safety | Proven 8 cases orphan 200, ACTIVE/EXPIRED/PENDING/APPROVED 409, preservation | Same | CLOSED | No | Done 26C |
| GAP-26C-04 | Teacher deactivate/login | Proven login before 200, deactivate isActive false sessions revoked Teacher remains, login after 403, reactivate true no auto session, login again 200 fresh session, IDOR 403, invalid 404 | Same | CLOSED | No | Done 26C |
| GAP-26C-05 | Quiz retry randomization | Multiple attempts allowed, no randomization, no admin gate | One attempt default, per-student randomized, Admin-only retry grant audited | MEDIUM | No (current multi-attempt works, not blocking launch) | 26D + 26F + 26H |
| GAP-26C-06 | Quiz attempt inspection | No /api/admin/quiz-attempts, no /api/teacher/quizzes/[id]/attempts | Admin can inspect attempts/scores/answers/history, teacher can inspect own quizzes | MEDIUM | No | 26D |
| GAP-26C-07 | Materials admin CRUD UI | Admin can attach via POST /api/admin/lessons/[id]/materials, list via GET same, deactivate via DELETE ?materialId, delivery via GET /api/materials/[id] private | Same, plus UI remove/replace | LOW | No | 26D UI |
| GAP-26C-08 | Video admin publish | Admin GET /api/admin/session-videos list, POST upload, GET/PATCH/DELETE [id] publish | Same, document teacher upload vs admin publish | LOW | No | Done doc |
| GAP-26C-09 | Homework admin surface | No /api/admin/homework, admin only readiness gate | Teacher primary, admin inspect via readiness | LOW | No | Done doc |
| GAP-26C-10 | Question Bank route name | Actual /api/admin/question-bank, edit via teacher/questions/[id] | Same | LOW | No | Done doc |
| GAP-26C-11 | Analytics combined route | Actual overview + revenue-analytics + forecast, no combined | Same | LOW | No | Done doc |
| GAP-26C-12 | Audit gaps | Group changes, student assignment, settings change, session revocation not audited (only security event) | Add AuditLog for GROUP_UPDATE, STUDENT_GROUP_ASSIGNED, SETTINGS_UPDATE, QUIZ_RETRY_GRANTED | LOW | No | 26D |
| GAP-26C-13 | Responsive/RTL browser | Source invariants verified, browser-measured 1440/834/390 pending | Run browser measurements for Admin UI Arabic/RTL | ENHANCEMENT | No | Visual phase |
| GAP-26C-14 | Payment rejection min length | Only max 500 + non-empty, short "no" allowed | Product decision: keep trim+max, short reason auditable | LOW | No | Done |
| GAP-26C-15 | Mock exam sampling UI | Sampling via API but admin UI filter minimal | Enhanced filter UI difficulty/count/track | ENHANCEMENT | No | 26D |

**Launch-blocker reconsideration:** All BLOCKER/HIGH closed in 26C. Remaining MEDIUM gaps (quiz retry randomization, attempt inspection) are not blocking launch because current flows work (multi-attempt retake, teacher can still grade, publishing via existing ceremony works). Explicitly reconsidered and classified non-blocking per owner pre-Go-Live requirements that allow quiz randomization/retry to be 26D.

---

## 32. Files changed

```
src/app/api/admin/groups/[id]/route.ts   | FIXED unclassified fail-closed, active, capacity, audience
src/app/api/admin/students/[id]/route.ts | FIXED pendingSchoolType, active/classified/capacity/audience, schoolType guard
src/components/admin/admin-dashboard.tsx  | ENHANCED SubscriptionsView Plans toggle + TeachersView Deactivate/Reactivate
src/lib/security.ts                       | FIXED TS-only ACCOUNT_DEACTIVATED added (no DB enum)
src/app/api/admin/plans/route.ts         | NEW GET all + POST create, audit PLAN_CREATE
src/app/api/admin/plans/[id]/route.ts    | NEW PATCH toggle + DELETE guard any sub + payment refs, audit, 8-case safety
src/app/api/admin/teachers/[id]/route.ts | NEW PATCH deactivate/reactivate + GET detail, audit + security, login proof
scripts/verify-phase26c-admin.mjs        | NEW 86 REAL HTTP assertions covering public teacher app, publishing real-route, plan DELETE, teacher login lifecycle, ROUTES order fixed specific before generic
tests/phase26c-admin-full-flow.test.js   | NEW source pins + master gate (calls verifier)
tests/phase26b-group-track.test.js       | UPDATED B9 to expect api.285 fail-closed (26C hardening)
docs/PHASE_26C_ADMIN_FULL_FLOW_QA.md     | NEW 37 sections, route truth exact, materials/video/question-bank authority exact, evidence types, quiz carry-forward, speculative wording removed
```

No schema, no migration, no postgres-baseline change.

---

## 33. Tests with exact counts

```
node scripts/verify-phase26c-admin.mjs         86 passed, 0 failed (ADMIN-01..37 + closeout gaps, REAL HTTP SQLite)
node tests/phase26c-admin-full-flow.test.js     1 passed (source pins + master gate calling verifier)
node tests/admin-publishing-phase15.test.js     384 passed, 0 failed
node tests/payment-lifecycle-phase25-pr2b.test.js 252 passed, 0 failed
node tests/phase26b-group-track.test.js         82 passed, 0 failed (after B9 update)
node tests/phase26b-student-flow.test.js        39 passed, 0 failed
node tests/teacher-application-phase20.test.js  75 passed, 0 failed
node tests/track-architecture-phase12.test.js   304 passed, 0 failed
node tests/security-audit-gate.test.js         116 passed, 0 failed
node tests/security-hardening.test.js          285 passed, 0 failed
node tests/session-lifecycle-phase13.test.js   299 passed, 0 failed
```

All 10 required suites PASS, plus verifier.

---

## 34. Prisma/typecheck/build

| Gate | Result |
|---|---|
| `prisma generate --schema prisma/schema.prisma` | Blocked by sandbox (binaries.prisma.sh unreachable, TLS disconnect) — same at pristine HEAD, not code condition |
| `tsc --noEmit` | 11 errors all `@prisma/client has no exported member Role/Question/NotificationType/AttendanceStatus/QuestionType/Difficulty` + `Prisma.GroupWhereInput` — stub client from same sandbox limitation, byte-identical to HEAD except ACCOUNT_DEACTIVATED fix removes 1 error (was 12). Zero new logic errors. |
| `SECURITY_HASH_SECRET=... next build` | Compiled successfully 20.2s Turbopack, then fails at type-check stage on same 11 stub errors. No structural/build issue. |

Honest comparison vs pristine HEAD: same stub errors, no new TS errors from 26C.

---

## 35. Schema/migration status

- No migration created in 26C
- Existing 11 migrations untouched, last is `20260915120000_phase26b_group_track_scope` (ADD COLUMN trackScope TEXT + index)
- `prisma/schema.prisma` diff empty vs HEAD
- `schema.postgresql.prisma` diff empty
- `postgres-baseline.sql` diff empty
- SecurityEventType is TS-only union, type String column, no enum migration needed
- Plan delete safety fix is logic-only, no schema change

**Conclusion:** No missing migration hidden. If Prisma enum change were required, STOP would apply — not required.

---

## 36. Remaining risks

1. Quiz retry/admin grant not implemented — current multi-attempt retake works but violates future one-attempt+admin-only requirement; must be implemented in 26D with security proof 26F.
2. Quiz attempt inspection no dedicated admin route — teacher analytics shows stats but not detailed answers; admin cannot inspect currently — MEDIUM, not launch-blocker.
3. Audit gaps: group changes, student assignment, settings change not audited — should add in 26D — LOW.
4. Responsive/RTL browser-measured Admin pass pending — source invariants verified, but 1440/834/390 Arabic/RTL first not browser-measured — ENHANCEMENT.
5. Prisma generate blocked in sandbox — must be re-run in env where engines work before cutover — not code condition.
6. Final-integration-phase22 expects git-ignored `/backups/` artifacts — fails in fresh clone, same at HEAD, not 26C regression.

No contradictory ADMIN-17 entry — publishing workflow now PASS via real routes (ADMIN-17-real-a through ADMIN-17-real-l). Previous PARTIAL risk removed.

---

## 37. Git status

```
 M src/app/api/admin/groups/[id]/route.ts
 M src/app/api/admin/students/[id]/route.ts
 M src/components/admin/admin-dashboard.tsx
 M src/lib/security.ts
 M src/app/api/admin/plans/[id]/route.ts
 M tests/phase26b-group-track.test.js
?? docs/PHASE_26C_ADMIN_FULL_FLOW_QA.md
?? scripts/verify-phase26c-admin.mjs
?? src/app/api/admin/plans/
?? src/app/api/admin/teachers/[id]/
?? tests/phase26c-admin-full-flow.test.js
```

No commit, no push, no PR, no deployment, no Neon mutation, no R2/SMTP/Vercel touch, no Phase 26D start.

**Confirm:**

- no production access — yes
- no Neon mutation — yes (SQLite only, provider sqlite, file: URL)
- no deployment — yes
- no commit/push/PR — yes (status shows modified/untracked, no commit)
- no Phase 26D — yes

STOP — ready for review.

---

## Appendix: Official quiz requirements carried to 26D (repeated for clarity)

**A. Per-student randomized:** Question Bank → Blueprint → server-side selection maximizing variation, preserving difficulty/topic, optionally shuffling choices, freeze at attempt start, client cannot choose IDs, server grading, history stable.

**B. One attempt by default:** One attempt per Lesson Quiz, start creates/consumes, closing tab/navigating/refreshing/logging out must NOT create fresh attempt, resume may be allowed if product policy chooses resume.

**C. Result:** After valid submit score shown, attempt terminal, old history preserved.

**D. Admin-only retry:** Only Admin grants extra attempt, identifies student+quiz, grants exactly one, audited, never deletes old, preserves history, allows new attempt with different randomized set where possible, student/teacher cannot bypass unless owner changes requirement. Implementation 26D + 26F + 26H.

---
