# CodeMind Academy — MVP Baseline Audit

> **Type:** Read-only audit + MVP gap analysis. No application behavior, schema, UI, or
> content was changed by this document. No features were implemented.
> **Auditor:** Arena agent session `arena/01a07d9e` — 2026-09-07.
> **Method:** Every finding below was verified against the source tree of the baseline
> commit (file paths + code inspected), not against prior plans, docs, or memory.
> Claims in older docs (`docs/PROJECT_AUDIT.md`, `worklog.md`, phase reports added
> after the baseline) were treated as leads only and re-checked against code.

---

# Executive Summary

CodeMind Academy at `635de56` is **not a skeleton — it is a surprisingly complete,
opinionated MVP already**. It ships a Next.js 16 single-page app with four role portals
(Student / Parent / Teacher / Admin), a custom cookie-session auth with server-side
device tracking, a deep curriculum tree (Course → Part → Unit → Topic → Lesson),
server-enforced session gating (95% video + quiz + assignment), a well-protected
private media pipeline (batch session videos with range streaming), manually-verified
subscriptions/payments, a school-type-isolated question bank + mock exam engine,
quiz camera-evidence collection, a full AR/EN i18n system with RTL, and an offline
test suite (319 checks passing at baseline in this sandbox).

The audit found **no need to rebuild the platform**. What the baseline actually lacks is:

1. **Two critical security holes** — anyone can self-register as ADMIN (role taken from
   the request body), and one public API (`GET /api/groups`) leaks teacher account rows
   including password hashes. Both must be fixed before anything else ships.
2. **Systemic answer leakage in assessment reads** — quiz answers (`answer`,
   `explanation`) and mock-exam `correctIndex` are returned by GET endpoints and merely
   hidden client-side.
3. **A broken video path on lessons** — lesson videos are rendered as raw iframes with no
   progress reporting, while the 95% gate is enforced server-side; with seeded content
   the progression chain deadlocks. The working video pipeline (private HTML5 +
   heartbeats) exists but only for batch `SessionVideo`s.
4. **Missing admin/teacher authoring APIs** — courses, parts, units, topics, lessons,
   homework, and live sessions can only be created by seed scripts. There is no UI/API
   content management at all (and no PDF material upload).
5. **Weak parent linking (email-only legacy mode)** and an **enrollment model that grants
   course access before any payment is approved** (documented as a deliberate decision,
   but it needs an explicit MVP policy).

The proposed roadmap below is **15 phases** (not 44), dependency-ordered, security first,
authoring second, polish last — every phase leaves the repo runnable and independently
mergeable.

| Verdict | Count |
|---|---|
| Subsystems KEEP AS-IS | 8 (media storage, gating engine, i18n/RTL, mock-exam grading isolation, security subsystem, notifications core, payments flow, offline test suite) |
| KEEP WITH SMALL FIXES | 6 (auth core, registration validators, quiz runtime, parent portal, teacher portal, enrollment) |
| REFACTOR | 4 (admin portal components, question bank tooling, AI chat backend, migration history) |
| REBUILD | 2 (lesson video/material path, role registration policy) |
| REMOVE / DEFER | 3 (unused heavy deps incl. `next-auth`/`next-intl`/`@sparticuz/chromium`, legacy Setting-session fallback, post-baseline "domain foundation" direction pending owner decision) |

---

# Baseline Commit

**Approved baseline:** `635de56c3b2884407fe22195205659075e0bfc90` —
`Merge pull request #11 … feat(auth): email-only password reset via Gmail SMTP`
(2026-09-07 10:59 UTC). 26 commits of history; all audit findings above were verified
against the tree of this exact commit.

### ⚠ Baseline discrepancy (important — requires owner decision)

The session instruction stated the working branch is `stable-base-635de56`. That branch
**does not exist** locally or on `origin`, and the sandbox checkout was a **shallow clone
(one commit)** of `main` at `02db012`. `635de56` was only reachable after unshallowing.
**`main` has moved 4 commits past the baseline** with experimental work that this
instruction says is *not approved*:

```
02db012  Merge PR #14  ← main HEAD (this session's base)
719d49a  feat: establish phase 3 domain foundation   ← adds Track/Enrollment/Material models + migration
6bbfd00  Merge PR #13
829a1d8  docs: complete phase 2 curriculum knowledge model  ← docs/curriculum/knowledge-model.json
e9b3771  docs: add curriculum and Kodgy reference materials ← 4 official curriculum PDFs (~18 MB)
635de56  ← APPROVED BASELINE (audit target)
```

Consequences of this drift (all live on `main`, none in the baseline):

- `prisma/schema.prisma` on `main` has **extra models (`Track`, `Enrollment`, `Material`)
  plus `prisma/migrations/2026…domain_foundation/`** that are NOT part of the baseline.
- `docs/PROJECT_STATE.md` existed on `main` describing that old phase plan; it is
  replaced by the new-cycle state file in this PR.

This audit therefore evaluated the extracted `635de56` tree (`git archive 635de56`), and
every "missing/broken" claim was re-verified to hold at `635de56`, not just at `main`.
The post-baseline schema migration must be explicitly **accepted or reverted** by the
owner before Phase 1 merges (see Risks, R1).

---

# Current Architecture

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript + Tailwind + shadcn/ui
  (~45 ui primitives). `output: "standalone"`; `typescript.ignoreBuildErrors: true` (⚠),
  `reactStrictMode: false`.
- **UI topology:** one server route — `src/app/page.tsx` (29 lines) dynamically imports
  `components/app-shell.tsx` (`ssr:false`). Everything else is client-side: a Zustand
  store (`src/lib/store.ts`) holds a `view: ViewKey` enum of 41 views (landing, login,
  register, enroll, 15 student views, 7 teacher, 4 parent, 14 admin) and renders them via
  a switch in `AppShell`. Role-aware redirect `isViewForRole()` prevents stale views,
  but is UX-only — real protection is in API routes.
- **State:** Zustand (`cm-app` localStorage persistence is limited to theme+locale; the
  session is always re-resolved from `GET /api/auth/me` — good). TanStack Query is
  installed and used in only 3 components; most data fetching is raw `fetch` + `useEffect`.
- **Server:** 80 route files (`route.ts`) under `src/app/api` (REST JSON, no server
  actions).
  Helpers in `src/lib/api.ts`: `requireUser()`, `requireRole(...roles)`, and
  profile loaders (`getStudentProfile`/`getParentProfile`/`getTeacherProfile`).
  **There is no `middleware.ts`** — protection is entirely per-route (see Security).
- **Auth/session:** custom — scrypt password hashes (`salt:hash`, timing-safe compare),
  httpOnly `cm_session` cookie holding a random token whose **SHA-256** is stored in
  `UserSession`, 7-day TTL, server-tracked single-device policy with automatic
  `SUSPENDED_MULTI_DEVICE`, legacy `Setting:session:*` fallback for pre-2026 sessions.
  `next-auth` and `next-intl` are **dependencies but never imported** (dead weight).
- **DB:** SQLite via Prisma 6.11 (`file:./db/custom.db` default). 49 models + 15 enums
  in one 955-line `schema.prisma` (full inventory in Database Findings).
- **i18n:** bespoke dictionary system — `i18n-core.ts` (isomorphic `translate`,
  `pickL10n`, `fmtDate/fmtDateTime` with `ar-EG`/`en-GB`), generated dict
  `i18n-dict.ts` (1,130 UI keys) + hand-maintained 2026 additions, localized **server**
  API errors via `cm-locale` cookie (`getServerT`, 202 `api.*` keys). RTL flips
  `document.dir`; a logical-CSS codemod + audit tooling exist (`scripts/i18n/`).
- **Data model layering:** curriculum content (`Course/Part/Unit/Topic/Lesson`),
  delivery (`Group/LiveSession/Attendance/Batch/SessionVideo`), assessment
  (`Quiz/Question/QuizAttempt/QuizAnswer`, `Homework/Submission`, `MockExam/
  MockExamQuestion/ExamQuestion/ExamAttempt`), commerce (`SubscriptionPlan/
  Subscription/Payment/Coupon/Referral`), security (`UserSession/PasswordResetToken/
  SecurityRateLimit/SecurityEvent/AuditLog`), engagement (`Notification*/StudentBadge/
  StudyTask/LessonBookmark/LessonNote`, gamification lib).
- **Media:** `MediaAsset` abstraction (EXTERNAL_URL | LOCAL_PRIVATE | S3-enum-unused),
  private files under `MEDIA_STORAGE_PATH` outside the web root with random keys,
  streamed only through authorized `GET /api/media/[id]` (Range support,
  `Cache-Control: private, no-store`, nosniff). Path traversal guarded.
- **AI:** `z-ai-web-dev-sdk` (real npm package v0.0.18; its credentials are opaque
  "sandbox-configured" — production config is an open question). Two surfaces: student
  assistant chat + admin/teacher quiz generator. In-memory conversation map.
- **Deployment artifacts present (out of scope for this cycle):** `Caddyfile`,
  `DEPLOYMENT_GUIDE.md`, standalone build scripts. No CI workflows at all.

---

# Existing Features (what the baseline actually does)

Verified present and wired end-to-end (UI → API → DB) at `635de56`:

**Auth** — register (STUDENT with Egyptian 3-part name/phone/nationalId validation +
auto student code; PARENT via verified triple match; TEACHER/ADMIN *unvalidated* ⚠),
login, logout, `/api/auth/me`, email-only password reset (request + confirm) with
hashed single-use tokens, IP+identifier rate limits, session revocation on reset,
account suspension state machine, admin session listing/revocation
(`/api/admin/users/[id]/sessions`).

**Student** — dashboard (course, next-session gating status, attendance %, pending
homework, sessions, notifications); course tree with per-lesson lock/unlock badges;
lesson page (video iframe, PDF link, quiz/homework cards, bookmarks, notes, mark-complete);
quiz runner (camera consent/monitor, attempt lifecycle via `/start` → evidence → `/submit`);
mock exams (FIXED/RANDOM, countdown, review screen, result snapshot); study scheduler
(StudyTask CRUD); gamification (XP/levels/badges/leaderboard); referral; certificate
eligibility (≥80% lessons); per-student batch session-video player with real HTML5
heartbeats; progress export (JSON); notification prefs.

**Teacher** — dashboard (groups, per-student video progress via shared service,
upcoming sessions, recent grading); attendance register per session (4 statuses,
batch upsert); quiz creation for lessons in own courses + attempt list; homework
grading (server-validated 0–100, feedback, notification); lesson-plan templates;
analytics (per-group averages, trends).

**Parent** — dashboard per linked child (progress avg, attendance % + 6-month
breakdown, quiz stats, homework stats, subscription state); weekly report; monthly
report; analytics view; student linking (verified triple **and** legacy email ⚠);
notification preferences (reuses student route, keyed by userId — works).

**Admin** — overview metrics; student/teacher/group CRUD-lite (create + PATCH:
activate/suspend, group assign, school-type move→batch sync); course list/create;
payments queue (approve/reject → subscription activation + notification; CSV import);
subscriptions list; coupons (create/toggle/delete + per-user redeem limit); question
bank (list w/ filters + create; ⚠ no update/delete); mock exams (create/publish/FIXED
pinning); batches; session videos (upload-to-private-storage OR external URL, publish
per batch); quiz review (attempts + camera evidence); notifications (broadcast +
center); settings (key/value w/ public allowlist); revenue analytics + forecast;
export-progress; notification center.

**Assessment** — server-side grading of quizzes (never trusts client `isCorrect`),
school-type bank isolation applied to *both* selection and grading of mock exams,
answer snapshots on `ExamAttempt` so history survives question edits, pass-mark logic,
best-attempt surfacing.

**Platform** — AR/EN everywhere including server-rendered API errors; dark mode;
PWA manifest (no service worker); landing page (10 sections); security event audit log;
rate-limit primitives; quiz-evidence retention fields.

---

# Reusable Features (keep — do not rebuild)

See the classification table in Database/Testing sections and §10 summary; the highest
value assets to preserve verbatim:

1. **`session-progress.ts` gating engine** — clean, batched, single source of truth,
   tested by `authorization-invariants`. Missing component ⇒ not required (no
   deadlocks by design; the *video path* defect below is a data/pipeline issue, not a
   gating issue).
2. **Private media pipeline** (`media/[id]` + `MediaAsset` + path hardening + Range) —
   production-quality; reuse for PDFs by extending MIME/size policy to DOCUMENT kind.
3. **Password-reset subsystem** — exemplary (hashed tokens, uniform responses,
   rate limits, tx-based single use, session revocation). Pattern to copy for other flows.
4. **Server-verified heartbeats** (`video-progress`, `session-videos/[id]/progress`) —
   anti-cheat wall-clock credit model, works today for batch videos.
5. **School-type question bank isolation** (ARABIC/LANGUAGE + shared pool) — including
   grading-side isolation; matches the 2026/2027 Egyptian Baccalaureate split.
6. **i18n toolchain** — extract/merge/emit/codemod scripts + evidence-based audit; extend,
   don't replace.
7. **Offline test suites** (7 files, source-invariant + mock-DB runtime tests) —
   cheap regression net; extend in Phase 13.
8. **Registration validators** (names/phones/national IDs/student codes) — tested.
9. **Notifications + preferences + quiet hours core** — wired into payment flows.
10. **Manual-payments lifecycle** (PENDING → approve → subscription window + notify) —
    fits the business model (InstaPay/Vodafone/e&) with zero gateway integration cost.

---

# Broken Features

**B1. Lesson video progress is unreportable → gating deadlock.** `student-lesson.tsx`
renders `lesson.videoUrl` in an `<iframe>` (YouTube-embed style). No client ever POSTs
to `/api/lessons/[id]/video-progress` (0 call sites in `src` — verified by grep), so
`videoWatchedSec/videoPercent` can only stay 0; `/progress` deliberately refuses
`isCompleted`/`progress:100` without the 95% video rule. The seeder assigns
`videoUrl` (placeholder `youtube.com/embed/dQw4w9WgXcQ` — a rickroll) to the first
lesson of every topic; those lessons can **never** be completed, locking every
subsequent lesson (unlocking is strictly linear over the course).
→ Phase 6. (Batch `SessionVideo` path is NOT broken — real `<video>` + heartbeats.)

**B2. `GET /api/groups` leaks teacher credentials, unauthenticated.** No guard; returns
`db.group.findMany({ include: { course: true, teacher: { include: { user: true } } } })`
raw → every teacher's **scrypt password hash**, email, phone, status + enrollment
counts, to any anonymous caller. → Phase 2 (one-line fix, largest blast radius).

**B3. Answer leakage in read APIs** (deliberate in-code "for MVP" shortcuts):
`GET /api/quizzes/[id]` ships `answer`+`explanation` for every question to any logged-in
user with **no enrollment check**; `GET /api/lessons/[id]` embeds the same into the
lesson payload (`lesson.quizzes[0].questions` incl. answers) *after* access checks — but
still before the student has attempted the quiz; `GET /api/exams/mock` returns
`correctIndex` + `explanation` per question and `mock-exam.tsx` grades locally from it.
→ Phase 2.

**B4. Content authoring is seed-only.** No API/UI to create/edit Part/Unit/Topic/Lesson
(admin `courses` is list+create of the Course row only), **no homework creation endpoint**
anywhere, **no LiveSession creation** (`liveSession.create` exists only in seed scripts),
no place to set `videoUrl`/`pdfUrl`/`isPublished`/`isLocked`. Attendance UI operates on
seeded sessions. → Phases 5–7.

**B5. Teacher-accessible admin route with no scope check.**
`POST /api/admin/ai-generate-quiz` is `requireRole("ADMIN","TEACHER")` and writes
`Question` rows into **any lesson's quiz** (find-or-create) with no teacher-course scope
check (contrast: `POST /api/teacher/quizzes` correctly verifies course ownership). Any
teacher can inject questions into any other teacher's course. → Phase 2 (+ move to
teacher namespace in Phase 9).

**B6. `retainUntil` has no enforcement.** Evidence rows carry a 30-day retention
deadline but nothing deletes them (no job/endpoint; grep confirmed) — biometric data
retention promise is currently fiction. → Phase 2 (minimal sweeper on read) or Phase 8.

**B7. Mock exam for legacy students.** Students without `schoolType` are refused
(`api.210`) — correct-by-design but leaves pre-upgrade accounts stuck until an admin
sets their school type; no admin flow surfaces this. Fold into Phase 4 UX.

**B8. Multi-device auto-suspension can lock out legitimate users.** Any second active
browser family (Chrome + Edge on the same PC ⇒ different device hash) within 30 min
suspends the account until admin reactivation. Policy decision needed (warn vs suspend);
currently no admin UI affordance to *pre*-configure it. → Phase 1 (policy) / Phase 4.

---

# Missing Features (absent at baseline, needed for a "real product")

Ranked by MVP necessity:

1. **Registration role policy** — server must refuse ADMIN (and gate TEACHER) at
   self-registration. (UI only offers STUDENT/PARENT/TEACHER; the API accepts all four ⚠)
2. **Curriculum authoring** (admin): lesson tree CRUD + publish/lock + media/PDF attach.
3. **Homework/assignment authoring** (admin/teacher) — grading exists, creation doesn't.
4. **Session scheduling** (admin/teacher): create/schedule LiveSessions, set
   meetingUrl, mark status; student-visible calendar of their group's sessions
   (today "calendar" is just attendance lists + a study-plan scheduler).
5. **Quiz/homework/parts lifecycle for teachers** — teacher can create quizzes (scoped)
   but not homework; can grade, cannot moderate retakes.
6. **Parent linking consent** — student-side approval code or admin-managed links.
7. **Enrollment/payment access policy** — decide & enforce (gate by approved+unexpired
   subscription, or keep access-first and enforce expiry).
8. **Password change while logged in** (only admin-created users get passwords set).
9. **Admin management of PARENT accounts** — none exists (students/teachers only).
10. **Question bank edit/delete + import** — create-only today.
11. **PDF materials** — upload/serve (schema slot `Lesson.pdfUrl` exists, pipeline absent).
12. **Conversation persistence + ownership for the assistant** ("Kodgy").
13. **CI pipeline** — none; all 7 test suites are manual `node tests/*.test.js`.
14. **Unit exams exposure** — API supports `examType=UNIT|MONTHLY|FINAL` from the
    existing `ExamQuestion` bank; no UI (decision: expose in P8 or defer — B-scope).
15. **Email delivery beyond password reset** — `emailEnabled` pref exists, but notify
    never sends email; no SMS/push (documented as out of scope in .env.example).

---

# Security Findings

Severity: CRITICAL / HIGH / MEDIUM / LOW. "Phase" = which roadmap phase should fix it.
(Not fixed here, per session scope.)

| # | Sev | Finding (evidence) | Phase |
|---|-----|--------------------|-------|
| S1 | **CRITICAL** | **Privilege escalation via self-registration**: `POST /api/auth/register` reads `body.role`; STUDENT/PARENT branches validate, the TEACHER/ADMIN branch creates the user (and Teacher profile) with **any role** and a live session. `curl`-level admin takeover of the academy. | 1 |
| S2 | **CRITICAL** | **Unauthenticated PII + password-hash export**: `GET /api/groups` (no guard) returns raw `teacher.user` rows incl. `password` scrypt hashes, emails, phones, `status`, plus `course` and student counts. | 2 |
| S3 | **HIGH** | **Quiz answer leakage / no content access on quiz reads**: `GET /api/quizzes/[id]` returns `answer`+`explanation` to *any authenticated user*, no enrollment check (IDOR over all quiz IDs incl. other courses). Server-side grading exists (`/submit`) — the leak is pure shortcut. | 2 |
| S4 | **HIGH** | **Mock exam answers to students**: `GET /api/exams/mock` includes `correctIndex` (+`explanation`); student UI grades from it. Grading is re-done server-side at submit (isolation-tested), so integrity fix = drop the field + submit-driven result fetch. | 2 |
| S5 | **HIGH** | **Parent takeover via email-only linking**: `POST /api/parents/me/link-student` "legacy mode" links any student knowing only the student's *email* → full progress/report access (child names, grades, subscription). Verified mode (nationalId+code+parentPhone) exists and is sound; legacy mode must die or require consent. | 3 |
| S6 | **HIGH (business-sec)** | **Course access before payment**: `POST /api/enroll` assigns `student.groupId` immediately in the same transaction that only *creates a PENDING subscription/payment*; access is group-membership-only (`enrollment.ts` documents subscription is *deliberately* not a gate) and reject does not revoke. Needs explicit policy for launch. | 4 |
| S7 | **MEDIUM** | **Login/register brute-force unbounded**: password reset is rate-limited, but `login` has no `checkRateLimit` call, only audit events; min password is 6 chars (register/admin-create) vs 8 (reset) — inconsistent; no lockout. | 1 |
| S8 | **MEDIUM** | **AI chat IDOR**: `GET/DELETE /api/ai/chat?sessionId=X` never compares `convo.userId` to the caller (POST does) — any logged-in user can read/clear any other user's conversation (default sessionId = userId, i.e. trivially enumerable). Memory-only impact today. | 2 |
| S9 | **MEDIUM** | **Teacher→any-course content injection** (B5, `ai-generate-quiz` missing scope check) — cross-teacher integrity of quizzes. | 2 |
| S10 | **MEDIUM** | **Teacher scope = course, not group**: `teacher/homework/[id]/grade`, `teacher/quizzes` (incl. per-student attempts), `teacher/analytics` authorize "owns the course"; a teacher sharing a course with others can see/grade *other teachers' students* (PII: names/emails in analytics; submissions in grading). Group-level scoping is a small query change. | 9 |
| S11 | **MEDIUM** | **`SECURITY_HASH_SECRET` undocumented/optional**: falls back to literal `"codemind-dev-hash-secret"` (not in `.env.example`); makes IP hashes and **device fingerprints** predictable — attacker who matches the coarse fingerprint class can steer the multi-device conflict policy (evasion of suspension). No auth bypass, but degrades a stated protection. | 1 |
| S12 | **MEDIUM** | **Retention enforcement missing** for quiz camera evidence (`retainUntil` ignored, B6) — biometric data accumulates indefinitely. | 8 |
| S13 | **LOW** | **`typescript.ignoreBuildErrors: true`** in `next.config.ts` — type errors ship silently (this also masks Prisma type drift). | 13 |
| S14 | **LOW** | **SSRF allowlist thin** in `isSafeExternalUrl` (blocks localhost/private-v4 only; no 169.254/IPv6/DNS-rebind) — mitigated: server never fetches these URLs, client embeds them. | 6 (hardening) |
| S15 | **LOW** | **No CSRF token** on cookie auth; mitigated by SameSite=Lax + JSON-only mutations + no state-changing GETs (verified across all 80 route files). | — |
| S16 | **LOW** | **Legacy `Setting:session:*` fallback** in `getCurrentUserDetailed` accepts any row matching the key format (still attacker-written only via admin settings PUT which excludes `session:` prefix — guarded). Remove in Phase 11 cleanup. | 11 |
| S17 | **LOW** | Demo credentials in `scripts/seed.ts` (`admin123`); `setup-production.ts` wipes demo data — must become a launch gate. | 15 |
| S18 | **INFO** | Session cookie flags correct (`httpOnly`, `secure` in prod, `lax`, 7d); server stores hashes only; logout revokes rows; reset revokes all sessions; `safeUser` strips hashes from auth responses. Password hashing scrypt (good), but **no pepper/KDF version prefix** (fine today; note for postgres move). | — |
| S19 | **INFO** | `z-ai-web-dev-sdk` credential handling is opaque ("configured in sandbox"); routes fail soft (500 generic). Verify real key/config in Phase 10 before relying on Kodgy. | 10 |

**Positive security assets to keep:** token-hash session store; single-use reset tokens
with tx-consumed `usedAt`; uniform reset responses (no enumeration); rate-limit buckets
surviving restarts; `SecurityEvent` audit trail incl. evidence-access logging; school-type
bank isolation *on grading*, mock-exam answer snapshots; media path-traversal guard +
`nosniff` + no-store; invariant test suite that exists precisely to lock these in.

---

# Database Findings

`prisma/schema.prisma` @ `635de56`: **49 models, 15 enums, 955 lines** — full list:
User, Student, StudentBadge, Parent, ParentStudentLink, Teacher, Course, Part, Unit,
Topic, Lesson, Group, LiveSession, Attendance, Quiz, Question, QuizAttempt, QuizAnswer,
Homework, HomeworkSubmission, ExamQuestion, LessonProgress, TeacherNote, SubscriptionPlan,
Subscription, Payment, Notification, AuditLog, Setting, LessonBookmark, LessonNote,
ExamAttempt, Coupon, CouponRedemption, Referral, StudyTask, NotificationPreference,
LessonPlanTemplate, Batch, MediaAsset, SessionVideo, SessionVideoView, MockExam,
MockExamQuestion, UserSession, PasswordResetToken, SecurityRateLimit, SecurityEvent,
QuizAttemptEvidence (+ enums Role, SchoolType, AccountStatus, MediaKind/Storage,
SessionStatus, AttendanceStatus, QuestionType, Difficulty, HomeworkStatus, ExamType,
Subscription/Payment statuses, NotificationType).

**Overall verdict: KEEP — no redesign needed for MVP.** It is dense and occasionally
legacy-laden, but coherent, correctly indexed on hot paths (`@@unique` on
`[studentId,lessonId]`, `[sessionVideoId,studentId]`, `[parentId,studentId]`,
`[studentId,sessionId]`, `tokenHash`, `bucket+identifier`; `@@index` on all FK/filter
columns I checked), with the right cascade semantics (`onDelete: Cascade` on ownership
edges; `Restrict` on SessionVideo→MediaAsset).

Findings:

1. **Migration history is incomplete (REFACTOR, P11).** Only 2 migrations exist
   (`20260904090608_add_student_identity_fields`, `20260906120000_platform_upgrade_2026`);
   the first 40+ tables were `prisma db push`-ed. A fresh prod DB cannot be built with
   `migrate deploy`. Required *before implementation work*: an **initial snapshot
   migration** + documented baseline (no schema changes in this audit). Also note the
   `package.json` ships `db:push --accept-data-loss` as the primary workflow — replace
   with migrate flow.
2. **Two parallel video/progress systems (duplication, unify in P6):**
   `Lesson.videoUrl + LessonProgress.video*` (legacy, iframe, dead) vs
   `SessionVideo + SessionVideoView + MediaAsset` (current, working). The 95% rule exists
   in both. MVP should pick **MediaAsset-backed lesson media** and keep `LessonProgress`
   as the per-lesson rollup, retiring `Lesson.videoUrl` as a raw string.
3. **`Lesson.pdfUrl`** (string) has no upload/serve story; `MediaAsset(kind=DOCUMENT)` +
   `media/[id]` streaming already solves the access-control half → P6.
4. **`Student.groupId` (single group) ⇒ one course per student** and `Enrollment`
   absent — acceptable for MVP (business runs one course per student); the
   post-baseline `Enrollment/Track/Material` models on `main` are *the alternative
   direction* — **do not** adopt blindly (R1).
5. **Access model lives in code, not schema:** `isEnrolled = group.isActive && group.course`
   (`enrollment.ts`), subscription status explicitly documented as non-gating. Any
   enforcement change is business logic (P4), not migration.
6. **`Setting` table is a junk drawer** (brand keys, legacy sessions, arbitrary admin
   key/value). Fine now; the `session:*` fallback should be deleted after a migration
   window (P11).
7. **Untrusted-string enums:** `Payment.reference`, `Coupon.type`, `Referral.status`,
   `StudyTask.status`, `Homework` file URLs etc. are plain strings (not DB enums);
   validation is per-route. Low risk; normalize opportunistically.
8. **`ExamAttempt.answers` JSON + `QuizAnswer` rows** — two answer representations. The
   JSON snapshot is *deliberate* (history survives question deletion; tested). Keep.
9. **MockExamQuestion double-FK** with `@@unique([mockExamId, questionId/examQuestionId])`
   — under SQLite, NULLs don't collide in unique indexes, so multiple "unpinned" sides
   are fine, but a Postgres move keeps the same semantics (note it, no action).
10. **Missing light-touch entities for MVP** (each additive in its own phase, none
    structural): `ChatMessage` (persist Kodgy, P10), `SessionMaterial` join (or reuse
    `MediaAsset` + nullable `lessonId`, P6), parent-link **approval requests**
    (P3 — can be a `Setting`-free `ParentLinkRequest` model or reuse `relation` field +
    email code; minimal), `Homework` file-submission is `fileUrl` string (no media link)
    — tighten in P6.
11. **Capacity race:** `enroll` counts students then updates outside the transaction's
    row locks (SQLite single-writer hides it; still a correctness bug). Fix in P4.
12. **No `updatedAt` on a few tables** (Attendance, ExamAttempt, etc.) — cosmetic.

---

# Student Experience

Working today: register → get `CM-XXXXXX` code → pick course/group/plan in enroll view
(coupon validation, payment-reference instructions) → dashboard shows next locked/unlocked
session with the three requirements, attendance %, deadlines → lesson page (iframe video
⚠, PDF link, quiz card, homework card, bookmark/note) → quiz runner with camera consent
flow and evidence, server-graded result with per-question explanation → mock exams with
countdown & review → XP/badges/leaderboard, study-task calendar, certificate eligibility,
JSON progress export, in-app notifications with prefs. Arabic-first RTL, EN toggle.

Experience bugs to fix in MVP (not UX redesign):
- **E1** Video-less deadlock (B1) — first-topic lessons can't be marked complete →
  progression appears frozen. Fix: unified media player w/ heartbeats (P6) and a
  one-time data fix for placeholder URLs (P5).
- **E2** Answer visibility (S3/S4) destroys quiz validity — fix in P2 (server strips
  fields; result view comes from server after submit).
- **E3** Group/session visibility: students learn about scheduled LiveSessions only via
  teacher-entered attendance lists & dashboard "upcoming sessions"; no session creation
  pipeline means this list is seed-only in practice (P7).
- **E4** No self-service password change (P1).
- **E5** Unenrolled/pending state messaging exists (`api.208`) but there is no "pending
  approval / expired" state — access is binary (group or none) (P4).
- **E6** Multi-device suspension gives a dead-end error with no in-product appeal path
  (P1: soften policy; admin list shows suspended status already).

---

# Admin Experience

Genuinely operational for *cohort/business* management (students, teachers, groups,
payments, subscriptions, coupons, settings, notifications, batches, session videos,
mock exams, evidence review, analytics). Missing for a first real term:

- **A1** No curriculum CRUD (create/update lessons, reorder, publish/lock, set media) —
  biggest functional gap (P5).
- **A2** No parent-user management (only students/teachers) (P4-lite or P3).
- **A3** No role management / password reset *for* users; no admin ability to fix the
  B7 missing-schoolType state in one place (bulk tools view).
- **A4** Course edit/delete absent (create only) (P5).
- **A5** Question bank create-only; no update/delete/dedupe/CSV import (P8; import can
  be B-scope).
- **A6** `admin/settings` PUT accepts arbitrary keys — should deny-list `session:*`
  forever (it does exclude from *read*; writes are unrestricted) — small guard (P2).
- **A7** The admin UI is a single 152 KB `admin-dashboard.tsx` (plus 16 KB session-videos
  and 15 KB mock-exams views) — refactor for maintainability (P12), not behavior.

---

# Teacher Experience

Solid dashboards, attendance, quiz creation + results, homework grading, templates,
analytics. Gaps: **T1** can't create homework; **T2** can't create/schedule sessions
(P7); **T3** course-level scope instead of group-level (S10, P9); **T4** no way to view
a student's video progress per *batch video* (analytics only aggregates `LessonProgress`
— SessionVideoView is not surfaced teacher-side; small read join, P9); **T5** no
evidence access (admin-only by design — keep, but teachers currently have *no* integrity
review loop; optional B-scope); **T6** `teacher-dashboard.tsx` is 105 KB — refactor P12.

---

# Parent Experience

Linked-child dashboards, weekly/monthly reports, analytics, prefs — all scoped through
`ParentStudentLink` server-side (verified: every `parents/me/*` route resolves children
from session; no `studentId` parameter is ever trusted — the report routes iterate only
linked children). Gaps: **P1** legacy email-link hole (S5, P3); **P2** no consent/notify
step when a parent links (P3); **P3** parents cannot *see* quiz answers review (by design;
only scores — acceptable MVP); **P4** no parent-side alert when subscription lapses
(notifications exist but nothing targets parents on expiry — B-scope); **P5** multiple
children fully supported (good — keep).

---

# Assessment System

- **Session quizzes:** per-lesson `Quiz` → `Question` (MCQ/TRUE_FALSE, marks, difficulty,
  schoolType tag) → `QuizAttempt` lifecycle (start→evidence→submit), **server grading**,
  best-attempt display, retakes unlimited (no policy enforced), `timeLimit` stored but
  client-enforced only. Health: **keep with fixes** (S3 leak removal, enrollment check,
  optional server-side timing in P8; retake limit is B-scope).
- **Homework:** created only via seed (B4), submission (`content` or `fileUrl`) with
  `@@unique([homeworkId,studentId])`, teacher grading w/ feedback + notification, LATE
  status exists but no auto-marking past deadline (minor, P8). Keep.
- **Mock exams:** admin-defined (`FIXED` pinned | `RANDOM` bank-sample), published per
  school type, duration/pass-mark; attempts snapshot answers; **isolation tested both
  ways**. Keep; strip `correctIndex` (S4); expose to parents? no (already aggregates).
- **Unit/Monthly/Final exams:** `ExamQuestion` bank + `examType` plumbing + `ExamType`
  enum exist end-to-end *server-side*; no admin UI for `ExamQuestion` CRUD and no student
  UI beyond mock. **Decision for MVP: NOT must-have** (B-scope Phase 8 optional exposure)
  — per-session quizzes already assess every lesson; unit exams add authoring burden
  (bank content doesn't exist yet, and content generation is explicitly out of scope).

---

# Curriculum System

**What the runtime uses:** the DB tree seeded from `src/lib/curriculum.ts` — ONE course
(`programming-ai-2nd-sec`, "Programming & AI — 2nd Secondary, Egyptian Baccalaureate"),
**2 parts → units → topics → 36 lessons** (EN + AR titles, 90-min durations, placeholder
rickroll videoUrl on first lesson of each topic, descriptions short). `scripts/seed.ts`
and `scripts/seed-curriculum.ts` share `seedCurriculumFromFile` (idempotent, tested).

**What it is NOT:** the official ministry PDFs are **absent from the baseline** (they were
added to `main` *after* `635de56` in e9b3771, ~18 MB, alongside a 4.3 k-line
"knowledge-model.json" and the `Track/Enrollment/Material` schema — all non-approved).
Nothing at baseline reads PDFs at runtime; there is no curriculum-versioning, no
per-lesson content beyond title/summary/duration, no unit exam content.

**Safe transition (no rebuild):** keep the seeded tree as the runtime skeleton; give the
admin CRUD (P5) to edit/extend it to match the official 23-lesson reality once the owner
approves; keep PDFs as *reference material in docs/* only until (a) the content decision
is made and (b) P6 gives each lesson a real media+PDF attach. The post-baseline schema
direction (Track/Enrollment/Material + officialCode) may or may not be the right endgame —
it is **deferred pending R1 decision**, not assumed.

---

# PDF / Materials

At baseline: **a schema slot and a UI link, nothing else.** `Lesson.pdfUrl` is returned by
lesson/course APIs and rendered as an `<a>` in `student-lesson.tsx` (`Course materials`
card); no endpoint ever sets it; `MediaKind.DOCUMENT` exists but `media.ts` MIME allowlists
cover video/image only; `@sparticuz/chromium`+`react-pdf`-style tooling is **absent**
(chromium dep is unused — grep 0 imports); `download/` dir contains a placeholder README.
Certificate "PDF" is data-only (client prints).

**MVP needs exactly:** (1) admin upload of a PDF (or any document) attached to a Lesson
(or SessionVideo), stored as `MediaAsset(kind=DOCUMENT, storage=LOCAL_PRIVATE)` and served
via the existing authorized `media/[id]` route (add DOCUMENT MIME + size cap); (2) admin
attach/detach UI in P5/P6. **Postponed:** server-side PDF *generation* (curriculum packs,
certificates-as-files), watermarking, streaming viewers, per-page analytics. Question
bank/curriculum *content* generation: out of scope by instruction §6/§7.

---

# Kodgy

**There is no "Kodgy" in the code.** The only AI surfaces at baseline:

1. `ai-assistant.tsx` (12 KB, every portal) + `POST/GET/DELETE /api/ai/chat` — an
   Arabic-tutor "CodeMind Assistant" (system prompt injected as an `assistant` turn —
   weak prompting structure), `z-ai-web-dev-sdk`, 12-message in-memory history, no
   rate limit, GET/DELETE ownership bug (S8), zero curriculum/DB awareness, no answer-
   leak guard beyond a prompt sentence ("don't give quiz answers").
2. `POST /api/admin/ai-generate-quiz` (ADMIN+TEACHER, scope bug S9) — generates 1–10
   MCQ/TF questions from a lesson's title/summary and **writes them straight to the DB**
   (find-or-create the lesson quiz). Output quality is unprompted for schoolType tags
   (defaults to none ⇒ shared bank).

**Minimum useful Kodgy for MVP (Phase 10):** rename/brand to Kodgy with persona +
bilingual responses; persist conversations (small `ChatMessage`-style model or reuse
`Notification`-like table — additive migration in the same phase); fix ownership + add
per-user rate limit + message length caps; structured system role; "tutor mode"
refusals for live-quiz answers (server-side: block while attempt unfinished is
trivially checkable — nice, keep); per-role context (student sees only *their own*
progress via one read-only context fetch server-side).
**Explicitly deferred (C):** curriculum-aware RAG over PDFs/knowledge model,
question generation as the *primary* bank tool, voice, agentic actions (submit
homework etc.), model switching.

---

# Testing

Baseline suites (offline, `node tests/*.test.js`), **run in this audit against the
extracted baseline tree**:

| Suite | Result | Coverage |
|---|---|---|
| authorization-invariants | **93/93 pass** | static invariants over route/lib sources (guards, gating, bank isolation, evidence admin-only, snapshots) |
| platform-upgrade-2026-migration | 98/98 pass | migration SQL semantics (simulated) |
| parent-monthly-report | 67/67 pass | report math with mock DB (incl. no-subscription crash regression) |
| registration-validators | 24/24 pass | validators incl. code-uniqueness 500-sample |
| mock-exam-grading-isolation | 22/22 pass | grading bank isolation with mock client |
| migration-sql | 15/15 pass | SQL simulation |
| seed-idempotency | **not runnable in sandbox** | needs `tsc` compile of files importing `@prisma/client`; prisma engine download blocked here (network). 5/6 runnable suites + this one's design verified by reading |

Total verified in sandbox: **319 checks green**. `tests/visual/` (harness + runner) and
`tests/i18n/audit-ui.mjs` + evidence dirs exist; both need a running server (not run here).
**No `npm test` script, no CI, no runtime API tests, no authz *runtime* tests** (the
invariants suite is deliberately static). `eslint` config exists; build not runnable here
(prisma binary fetch blocked; `ignoreBuildErrors` would skip type errors anyway).

Phase 13 = test infrastructure: CI (typecheck + eslint + node suites), a minimal
runtime authz test layer (spin sqlite db, hit real handlers) for the P1–P4 fixes,
`npm test` aggregation, drop `ignoreBuildErrors`.

---

# MVP Must-Have Features (Category A)

Everything below is *fix-or-complete, never greenfield*:

1. **Account security**: registration role policy, login rate limits, password policy
   unification, change-password, documented `SECURITY_HASH_SECRET`, suspension policy
   decision (S1, S7, S11, E4).
2. **API authorization & content protection**: groups-route lockdown, quiz/exam answer
   stripping, quiz access checks, ai-chat ownership, ai-gen scoping, settings write
   guard (S2–S5 reads, S8–S9).
3. **Parent linking consent** (S5).
4. **Enrollment lifecycle policy**: pending/approved/expired states surfaced to student
   + admin; capacity race; expiry job or check (S6, E5).
5. **Curriculum authoring** (admin): Part/Unit/Topic/Lesson CRUD, publish/lock,
   reorder, homework creation, course edit/delete (B4, A1).
6. **Materials & video unification**: lesson media via `MediaAsset` (HTML5 + heartbeat
   path), PDF DOCUMENT uploads + attach + serve, retire iframe/placeholder data (B1,
   E1, PDF §MVP item).
7. **Scheduling & attendance for real**: LiveSession create/edit/cancel API + admin/
   teacher UI, meetingUrl, status transitions, student calendar view (T2, E3).
8. **Assessment integrity**: quizzes (server-graded ✓) with answers never crossing the
   wire pre-submit; mock exam UI consumes server results; evidence retention sweeper
   (B3/S12); quiz result already good.
9. **Teacher scoping tightening** to group level (S10).
10. **Kodgy minimum** (branding, persistence, ownership, limits, refusal) (AI §).
11. **DB migration baseline**: initial snapshot migration; `db:push --accept-data-loss`
    removed from the documented workflow (DB-1).
12. **Quality gates**: CI running all suites + typecheck + lint; new routes covered by
    invariant additions; `npm test` script (Testing §).
13. **Launch hygiene**: demo-data purge script wired to setup, admin runbook, E2E smoke
    checklist (S17).

# Features to Postpone (Category B — should have, later)

Unit/Monthly/Final exam surfaces (generator API exists; UI + `ExamQuestion` admin CRUD);
question-bank CSV import & dedupe; certificate PDF rendering; email/SMS delivery for
notifications (prefs schema already ready); referral/coupon campaign polish; gamification
expansion (seasons, store); teacher access to quiz evidence (integrity loop); parent
subscription reminders; offline PWA service worker; lesson transcript search;
SessionVideoView teacher analytics join (until admins need it); admin "reset user
password" one-click email; per-file homework media pipeline beyond PDFs (audio/code);
multi-device policy configuration UI.

# Features Not Needed Now (Category C)

NextAuth/JWT rewrite (custom sessions work and are tested); replacing the
single-page-client-routed shell with App Router pages (explicitly excluded by session
brief §16 spirit — it works; a targeted P12 refactor is enough); payment gateway
integration (manual InstaPay is the business model); S3 media backend (enum exists,
SQLite-scale is fine); Postgres migration (same); microservices (`mini-services/` is
an empty dir — remove); `@mdxeditor` rich-text lesson editor; real-time chat/WebSocket;
AI curriculum intelligence/RAG/knowledge-graph runtime (post-baseline direction —
pending owner); mobile apps; multi-language beyond AR/EN; i18n "logical CSS" re-sweep;
proctoring ML; `@tanstack/react-table`, `date-fns`, `@reactuses/core`, `next-intl`,
`next-auth`, `@sparticuz/chromium`, `sharp` **unused dependencies → remove in P13**
(installed-but-imported 0×: verified by grep; keeps install/build surface honest).

---

# New MVP Phase Roadmap (15 phases, dependency-ordered)

Principle: each phase = one PR = repo stable afterwards; security before features;
authoring before content; no schema churn except where marked ADDITIVE.
(Phases deliberately mergeable in ≤2-file-risk isolation; "Files touched" lists are
planning targets, not this audit's changes.)

| P | Title | Objective | Features | Depends on | Excluded (→ phase) | Acceptance | Risk |
|---|-------|-----------|----------|------------|--------------------|------------|------|
| **1** | Account security hardening | Close registration takeover + password/limits hygiene | server role policy (ADMIN self-reg impossible; TEACHER ⇒ admin-invite code or admin-create only); login+register rate limits via existing `checkRateLimit`; password min 8 everywhere + strength check; `POST /api/auth/change-password`; document `SECURITY_HASH_SECRET` (env + example) & make unset = fatal in prod; suspension warning mode (config `SUSPEND_ON_CONFLICT=0/1`, default warn) | — | parent linking (3) | S1/S7/S11 tests: runtime authz suite proves role injection refused; login throttle 429s; change-password revokes other sessions; suites green | **LOW** (auth core touched — high test bar) |
| **2** | API authorization & content protection | Lock read paths; stop answer/PII leakage | remove guard-less `GET /api/groups` (require role; select fields); `quizzes/[id]`, `lessons/[id]`, `exams/mock`: strip `answer`/`explanation`/`correctIndex` from student reads, require enrollment for quiz GET/start/submit/evidence; quiz result returned by `/submit` post-grading; ai/chat GET/DELETE ownership; ai-generate-quiz: ADMIN-only **or** TEACHER-with-scope (interim: enforce scope) | 1 | Kodgy rework (10) | invariant tests extended to lock each; client quiz/mock flows still pass (manual e2e); PII endpoints return selected fields only | **MEDIUM** (touches hot UX paths; UI fallbacks needed) |
| **3** | Parent linking consent | Kill email-only link; verified/consented flows | remove legacy `studentEmail` mode (admin can force-link via new admin-parent route); student-generated time-boxed "share code" (6-digit, rate-limited, single use) as the primary parent link path; admin view of links (list/unlink) | 1,2 | parent notifications (B) | only code/verified-triple links succeed; old email mode 410s; tests for enumeration limits | **LOW-MED** |
| **4** | Enrollment & access lifecycle | Make the pay/attend policy real | decision implemented: enroll → group assignment only on payment APPROVED (or keep immediate + `pending` view; pick one, default = approval-gate); subscription expiry check inside `getEnrollment` (`endDate` in past ⇒ `isEnrolled:false` + banner code); enroll capacity race → transaction + recheck; surface pending/rejected/expired states in student dashboard + admin queue filters; schoolType backfill admin action (fixes B7) | 1,2 | revenue analytics changes | paid-pending student sees enrollment UI, not lessons; approving payment unlocks; expiring demo test; capacity race test | **HIGH** (business-behavior change — owner sign-off gate inside phase) |
| **5** | Curriculum authoring (admin) | CRUD for the teaching tree | `admin/courses/[id]` PATCH/DELETE; Part/Unit/Topic/Lesson CRUD (reorder via `order`, publish `isPublished`, `isLocked`, duration, EN/AR fields); homework create/edit/delete (per lesson); admin UI: tree editor panel in admin-dashboard (tabs) reusing existing form patterns; purge placeholder rickroll URLs (one-time admin action, not code migration) | 2 | media attach UI (6) | admin can build a course+unit+lesson+homework without touching scripts; gating engine consumes new lessons untouched; tests: idempotency of new seeds + invariants extended | **MEDIUM** (large surface, low coupling) |
| **6** | Media & materials unification | Fix E1/B1 + PDF support | lesson `videoAssetId` → MediaAsset-backed HTML5 player in student-lesson (reuse session-videos heartbeat component); `MEDIA_MAX_DOC_BYTES` + DOCUMENT MIME allowlist; `POST /api/admin/lessons/[id]/media` (video/pdf multipart or URL) w/ attach/detach; `media/[id]` serves DOCUMENT to enrolled students/teachers/admins; harden `isSafeExternalUrl` (S14); keep iframe for external YouTube as *optional non-gating* mode (video requirement = "any configured media") | 2,5 | transcripts/search (B) | lesson with local mp4: watch → percent advances → 95% unlocks next; PDF downloads via authed route; unenrolled 403s; suites green | **MEDIUM-HIGH** (core learning loop — feature-flagable per lesson) |
| **7** | Scheduling & attendance pipeline | Live sessions become operable | `admin/sessions` CRUD (create for group+lesson optional, teacherId default=group's, meetingUrl, status PATCH); teacher: mark COMPLETED, attendance (exists ✓); student: group's upcoming/past list + join link; cancel/notify | 5 (lesson links),1 | video recording automation | admin schedules session in 3 clicks; attendance flow unchanged for existing sessions (back-compat); student calendar shows it AR/EN | **LOW-MED** |
| **8** | Assessment operations | Bank + lifecycle polish | Question update/delete (+quiz detach) admin UI; mock exam unpublish guard; retake policy field on Quiz (maxAttempts, client+server); server-side time budget enforcement on `/submit` (startedAt+timeLimit soft check); homework late auto-status at deadline check (on read); evidence retention sweeper (purge rows past `retainUntil` on admin list read + `scripts/purge-evidence.ts` cron doc) | 2,5,6 | CSV import (B) | edit a question without corrupting attempts (snapshot rule); retake limit enforced; evidence purge verified in test | **LOW** |
| **9** | Teacher scope + loop closure | Group-level scoping; missing reads | scope grade/analytics/quizzes/attempts to *groups taught* (not any course group); teacher view of per-student SessionVideo progress (join); move ai-generate to `teacher/` namespace (shared lib); teacher-visible attendance export (CSV) | 2,6,7 | evidence access for teachers (B) | two-teacher course fixture: cross-group access 403s; own-group flows OK | **LOW-MED** |
| **10** | Kodgy MVP | Branded, persisted, bounded assistant | `ChatSession`+`ChatMessage` models (**additive migration** in-phase) replacing memory map; ownership enforced; 12-msg window per session; system-role prompt; refusal rules (no live-quiz answers: check unfinished `QuizAttempt` for linked lesson server-side; block answer-format override attempts); per-user rate limit (existing bucket); read-only personal context block (name, current lesson, progress %) assembled server-side, never client-supplied; role access (students default; admin/teacher toggle); z-ai SDK health-check config + graceful degrade notice; UI: rename assistant to "Kodgy" (Arabic persona) | 1,2 | curriculum RAG, voice (C) | conversations survive restart (test); cross-user read 403; refusal test; rate-limit 429 | **MEDIUM** (external dep uncertainty — must degrade gracefully) |
| **11** | DB hygiene & migrations baseline | Reproducible schema | initial snapshot migration for pre-20260904 models (squash docs + `migrate resolve` procedure); remove `--accept-data-loss` push from README/scripts; delete legacy `Setting:session:*` fallback code (after deploy note); optional index review; document Postgres path only | — (independent; before heavy schema work P6/P10 land cleanly: run after 10) | Postgres switch (C) | fresh `migrate deploy` on empty DB builds whole schema; suites green | **LOW** |
| **12** | Portal code refactor | Split god components, zero behavior change | admin-dashboard.tsx (152 KB) → `components/admin/*` view modules by tab; teacher-dashboard.tsx (105 KB) similarly; shared data hooks; no visual/UX change | 2,5,7 (stable surfaces first) | design system rewrite (C) | all admin/teacher flows e2e checklist pass; bundle size neutral/better; tsc clean | **LOW** (pure refactor, mechanical) |
| **13** | Quality gates & CI | Automated safety net | `.github/workflows`: install → prisma generate → suites (all 7, incl. seed-idempotency) → `tsc --noEmit` → eslint → `next build`; remove `ignoreBuildErrors`; `npm test` script; runtime-API test harness (sqlite tmp db) + 10 starter tests covering P1–P4 fixes; drop unused deps (next-auth, next-intl, mdxeditor, sparticuz, sharp, react-table, date-fns, @reactuses, dnd-kit, embla-if-unimported…) | all prior (validates them) | e2e browser suite (B) | CI green on PR; red on deliberate regression (test the test) | **LOW** |
| **14** | i18n/RTL completion pass | Localize everything P1–P10 added | run extraction/merge/emit for new strings (all phases added ~100+ keys); verify new admin tree editor, scheduler, Kodgy, enrollment states in both locales; logical-CSS sweep on new components; date/time in session calendar + enrollment notices; AR/EN error code copy per S3 changes | 10,5,6,7 | new locales (C) | `audit-ui.mjs` zero-residue target met for changed surfaces; manual toggle check | **LOW** |
| **15** | Launch stabilization & runbook | Freeze to first real term | demo-data purge gate in `setup-production.ts` (+ refuse to run with default brand prices?); admin runbook (`docs/ADMIN_RUNBOOK.md`): suspend/reactivate, payment queue, enrollment approval, curriculum editing, Kodgy config; E2E happy-path checklist executed on staging build; smoke seed for a fresh 23-lesson curriculum import (data, not code — content generation still per §6/7 brief limits) | all | actual deployment work | checklist signed; fresh-DB walkthrough creates course→enroll→attend→quiz→result→parent report end-to-end | **LOW** |

**Order rationale:** P1–P2 are the only *urgent* items (takeover + PII on the network);
P3–P4 fix the two account-lifecycle doors (parents, money); P5–P7 give the academy its
hands (author, materials, schedule) — P6 needs P5's lesson management to attach media;
P8–P10 are operations/branding on top; P11–P13 make it durable; P14–P15 ship it.
Phases 1,2,3 are independently mergeable in any order after P1; P4 requires a product
decision recorded in PROJECT_STATE before code (default chosen here: approval-gated).

---

# Dependencies

- **Runtime:** Node ≥ 20 (sandbox 22), bun.lock AND package-lock (single one in P13),
  npm registry reachable in sandbox; **Prisma engine binaries are download-blocked in
  this sandbox** → full `build`/runtime tests need the owner machine or CI with access
  (documented limitation, Testing §).
- **External:** Gmail SMTP (reset mail — only hard external dependency today);
  `z-ai-web-dev-sdk` (AI — unverified production credentials path); WhatsApp deep links
  (manual support line — no API).
- **Data flow:** seed scripts are the ONLY content pipeline at baseline (P5 unblocks);
  `MEDIA_STORAGE_PATH` must be a persistent volume at deploy (Caddyfile hints exist).
- **Cross-phase:** P6↔P5 (attach), P8↔P2 (result flow), P10↔P1 (rate-limit lib),
  P13 must land after P1–P12 to lock all invariants; P14 after every UI phase.

# Risks

| ID | Risk | Mitigation |
|----|------|-----------|
| R1 | **Baseline drift:** `main` carries 4 post-baseline commits incl. a schema migration + ~18 MB PDFs + the "phase 2/3" docs. The new cycle's PR base therefore contains non-approved work. | Owner decision before P1: (a) revert `719d49a`/merge-base the docs to a baseline-only branch, or (b) formally fold them in. This audit assumes (a)-until-told; P1 PR must not touch schema so either choice stays clean. |
| R2 | P4 changes access semantics → students mid-course could lose access if subscription rows are inconsistent. | Feature-flag `ENFORCE_SUBSCRIPTION_GATE` (default off on day 1, on after data audit); backfill audit query in phase acceptance. |
| R3 | P2's answer-stripping breaks the client quiz/mock runners (they read `answer`/`correctIndex` today). | Same-PR client updates (both flows are two files); invariant tests pin the contract. |
| R4 | z-ai SDK opacity could sink Kodgy (P10) and quiz-gen. | Degrade gracefully (route returns 503 + banner; app fully usable), config probe in P10 acceptance; quiz-gen stays admin-only tooling. |
| R5 | God-component refactors (P12) can silently break admin flows. | Only after P13 exists? No — P12 precedes P13 for sequencing reasons; so: keep P12 purely mechanical (move, don't change), manual checklist + invariants diff as gate; optionally reorder P12/P13 (documented in P12 note). |
| R6 | Prisma/SQLite `db push` history → an unlucky `--accept-data-loss` on a prod clone could destroy data. | P11 baseline migration ASAP; never run `db:push` against non-scratch DBs (README warning now; P13 CI enforces migrate-only). |
| R7 | No CI means regressions between phases are human-verified only. | Acceptance criteria per phase include *running the 7 suites + typecheck*; P13 closes the gap permanently. |
| R8 | Quiz camera evidence is personal/biometric data; retention job (P8) and admin-only access are the whole policy. | Keep evidence **optional** (decline is first-class ✓); document legal review need in runbook (P15); consider disabling snapshots per group setting (P8, tiny). |
| R9 | Old docs (PROJECT_AUDIT, README, phase reports) describe aspirational states and the non-approved phase plan — agents will over-trust them. | This audit + PROJECT_STATE mark per-doc staleness; P13 adds a docs-freshness note. |
| R10 | Single-course seed vs "real academy" expectations: everything assumes the seeded tree until P5. | Explicit MVP scope: one course at launch; multi-course is schema-ready already. |

---

# Recommended Starting Implementation Phase

**Phase 1 — Account security hardening**, immediately followed by **Phase 2**
(both are small, disjoint, and everything else builds on a trustworthy authz surface).
If only one PR can be reviewed this week, merge P1+P2 as a single security phase.
No phase before them should add features; nothing in them blocks the owner's
R1 decision (schema untouched in P1–P3).

---

## Appendix — Verification performed (read-only)

- `git archive 635de56` extracted to an isolated dir; all findings re-confirmed there
  (not against `main`'s mutated tree).
- Commands run: full route-guard enumeration over all 76 API files; grep-level
  serialization checks (`include: { user: true }`, `answer`, `video-progress`,
  `liveSession.create`, `retainUntil`, dependency imports); 6/7 offline test suites
  executed (319 checks pass; 1 blocked by sandboxed prisma binary download,
  cause verified); `.env`/secret scan of tracked files (none committed);
  `npm install` (891 pkgs) then `prisma generate` attempt (blocked — documented).
- Not performed (deliberately or by sandbox limits): `next build` (prisma engine),
  dev-server smoke, `tests/visual`, i18n audit (need running app), dependency
  `npm audit` (noise, P13 covers CI hygiene).

*This file is the audit record for the new cycle. Implementation status lives in
`docs/PROJECT_STATE.md`.*
