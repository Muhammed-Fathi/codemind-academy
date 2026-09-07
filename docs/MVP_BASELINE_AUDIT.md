# CodeMind Academy — MVP Baseline Audit

**Audit date:** 2026-09-07
**Audited baseline commit:** `635de56` (Merge PR #11 — "feat(auth): email-only password reset via Gmail SMTP")
**Audit type:** Read-only baseline audit + MVP gap analysis. No application code was modified in this session.

---

# Executive Summary

CodeMind Academy at `635de56` is a **substantially working, Arabic-first bilingual EdTech platform** — far more complete than a typical "baseline". Registration, login, session management, password reset, role-based portals for all four roles (Student, Parent, Teacher, Admin), course/session progression with server-enforced gating, quizzes with server-side grading, batch-published session videos with tamper-resistant watch tracking, mock exams, payments/subscriptions (manual verification model), and a full AR/EN RTL/LTR i18n layer are all implemented and covered by 337 passing offline checks.

However, the platform is **not yet a safe, operable educational product** for three reasons:

1. **Two critical/high security holes** — anyone can self-register as ADMIN or TEACHER, and an unauthenticated endpoint leaks teacher password hashes and PII.
2. **Assessment integrity is broken by design** — quiz correct answers and explanations are shipped to the client before submission, quiz time limits are not enforced server-side, and quiz routes don't check enrollment.
3. **The admin cannot actually manage the curriculum** — there is no CRUD for parts/units/topics/lessons, no way to attach a video URL or PDF to a lesson, no way to author homework, and students cannot submit homework at all. The runtime curriculum is a hardcoded seed file; two lesson fields the student UI renders (`videoUrl`, `pdfUrl`) have **no writer anywhere in the codebase**.

The recommended path is therefore a **12-phase MVP roadmap** that (a) fixes security first, (b) closes the content-management and materials gaps, (c) completes the homework loop, and (d) verifies each portal end-to-end — while **preserving** the large amount of working functionality rather than rebuilding it.

A second key finding: **`main` is no longer at the baseline.** PRs #12–#14 (merged after `635de56`) added ~18 MB of curriculum PDFs, a 4,309-line knowledge-model JSON, two phase reports, and a Phase-3 "domain foundation" Prisma schema change (new `Track`, `Enrollment`, `Material` models + migration). Per the cycle decision, that post-baseline work is **not part of the approved implementation cycle**; it is additive-only, has no runtime code depending on it, and this audit recommends keeping it **dormant** on main (documented) rather than reverting — see *Database Findings*.

---

# Baseline Commit

| Item | Value |
| --- | --- |
| Baseline commit | `635de56` — "Merge pull request #11 from Muhammed-Fathi/arena/01a07980-codemind-academy" ("feat(auth): email-only password reset via Gmail SMTP") |
| Baseline branch (user environment) | `stable-base-635de56` |
| `main` at audit time | `02db012` — Merge PR #14 (contains post-baseline PRs #12, #13, #14) |
| Post-baseline delta | docs only + `prisma/schema.prisma` (+77 lines) + migration `20260907100000_phase3_domain_foundation` — **no runtime code changes**, no API/UI changes |
| Code delta baseline → main | 14 files, +5,155 / −2 lines (schema, migration, PDFs, JSON model, reports, `docs/PROJECT_STATE.md` from the old plan) |

This audit was performed against the **exact tree of `635de56`** (checked out via a git worktree), cross-verified against the current `main` tree where noted. Since the only baseline→main code change is the additive Prisma schema, all runtime findings apply identically to both trees.

**Explicit decision for this cycle:** work merged after `635de56` (PRs #12–#14: curriculum reference PDFs, knowledge model, Phase-2/3 reports, Track/Enrollment/Material schema) is **experimental, unapproved, and NOT part of the approved implementation cycle**. No phase in the new roadmap builds on it.

---

# Current Architecture

## Stack

- **Next.js 16 (App Router)** + **React 19** + **TypeScript 5** + **Tailwind CSS 4** with shadcn/radix components
- **Prisma 6.11** + **SQLite** (`file:./db/custom.db`), 2 migrations at baseline (both additive, hand-written, heavily documented)
- Zustand for client state, TanStack Query not used (custom `useApi` hook), framer-motion animations, recharts charts
- `output: "standalone"` build; Caddyfile reverse-proxy config present
- **`typescript.ignoreBuildErrors: true`** in `next.config.ts` — builds never type-check (finding)
- No `middleware.ts`; no next-intl usage despite dependency; **`next-auth` is an unused dependency**

## Application shape: single-page client app

- One route only: `src/app/page.tsx` → dynamically-imported `AppShell` (`ssr: false`)
- All "pages" are **view states in a Zustand store** (`src/lib/store.ts`, ~40 view keys), rendered by `renderView()` in `app-shell.tsx` with a per-role view whitelist (`isViewForRole`)
- **No URL routing** — refresh/back always returns to landing (or the role home). Password-reset links work via `/?token=…`
- Consequences: no deep links, no per-page server rendering, but a very fast SPA feel and simple auth UX. Acceptable for MVP; URL sync is a later enhancement.

## API architecture

- **75 route files** under `src/app/api/**` — server-side only, all data access via Prisma
- Consistent helper layer (`src/lib/api.ts`): `requireUser()`, `requireRole(...roles)`, `getStudentProfile/getParentProfile/getTeacherProfile`
- **Every `/api/admin/*` route uses `requireRole("ADMIN")`** (verified by grep across all 33 admin route files; one also allows TEACHER: `ai-generate-quiz`)
- Student/parent/teacher routes use `requireUser()` + explicit role check + ownership scoping from the session (never from request body)
- i18n is isomorphic (`i18n-core.ts`): API routes localize error strings via the `cm-locale` cookie

## Auth architecture (custom, no next-auth)

- scrypt password hashing (16-byte salt, 64-byte key, timing-safe compare)
- DB-backed sessions: httpOnly cookie holds a random 32-byte token; only its SHA-256 is stored (`UserSession` table) with device hash, UA, hashed IP, expiry, revocation
- **Single-device enforcement** with auto-suspension (`SUSPENDED_MULTI_DEVICE`) on genuine cross-device conflict; same-device re-login just rotates the token; 30-min idle grace
- Legacy `Setting`-row sessions are transparently migrated
- Password reset: email-only, SHA-256-hashed tokens, 15-min TTL, per-email + per-IP DB-backed rate limits, generic anti-enumeration responses, Gmail SMTP via nodemailer (`delivery.ts` + `mailer.ts` — refuses to fake delivery when unconfigured)
- Security infra: `SecurityRateLimit` (fixed-window, DB-backed), `SecurityEvent` audit log, IP hashing with server secret, masked emails

## State management & data flow

- Client: Zustand store (view/nav/theme/locale) + local `useApi` fetch hooks per component
- Server: Prisma direct queries in routes; shared domain services in `src/lib/` (enrollment, session-progress, progress, media, security, delivery, gamification, parent-subscription)
- Localization data model: bilingual column pairs (`title`/`titleAr` etc.) + `pickL10n`

---

# Existing Features

Verified present and functional at the baseline (static audit + passing test suites; runtime behavior per worklog QA notes):

## Authentication & accounts
- Student registration with Egyptian-market validation: Arabic 3-part name, Egyptian mobile, 14-digit national ID (unique), school name + school type (LANGUAGE/ARABIC), auto-generated student code (`CM-XXXXXX`)
- Parent registration with **verified linking** (parent phone + student national ID + student code must match the student's registration data); additional post-registration `link-student` endpoint (verified mode + legacy email mode)
- Login / logout / `me`; suspension messaging; multi-device suspension flow with admin reactivation (revokes stale sessions)
- Email-only password reset (rate-limited, hashed tokens, Gmail SMTP) — merged in the baseline commit itself

## Enrollment & payments
- Enrollment model = **active group membership** (`Student.groupId → Group.courseId`); subscription status is deliberately NOT an access gate (documented business decision in `enrollment.ts`)
- Enroll flow: catalog endpoint (public marketing fields only) → group picker → plan + payment method (Instapay/Vodafone Cash/Etisalat Cash, manual verification) → PENDING subscription + payment; admin approve/reject; CSV payment import; coupons (percentage/fixed, usage caps, per-user redemption); referral coupons
- Subscription plans, 4 seeded

## Student learning
- Course tree view (parts → units → topics → lessons) with per-lesson status (completed/current/locked/available)
- Lesson view: video player (from `lesson.videoUrl`), PDF link (`lesson.pdfUrl`), quiz, homework, prev/next navigation
- **Server-enforced sequential progression** (`session-progress.ts`): next session unlocks only after video ≥ 95% + quiz attempted + homework submitted (components that don't exist are not required); anti-bypass guards on the progress route (`progress: 100` can no longer fake completion)
- **Batch session videos** (`SessionVideo` per school-type batch): admin upload (private storage, 512 MB cap, MIME allowlist, SSRF-checked external URLs) or external URL; publish per batch; student watch heartbeat credits real wall-clock time (monotonic, capped per beat); 95% completion rule; `SessionVideoView` tracking
- Quizzes: `start` (idempotent attempt open/resume), camera-consent monitor + private snapshot evidence (12/attempt cap, 30-day retention, admin-only access), `submit` with **server-side grading**, attempt history + best attempt, review with explanations after submit
- Mock exams: randomized from the question bank with **school-type bank isolation** (client can never choose the bank), admin-defined FIXED or RANDOM exams, snapshot answers for history
- Dashboards: course progress, last-viewed lesson, upcoming sessions, homework list, quiz results, XP/levels/badges (gamification), leaderboard, bookmarks, notes, certificate, study scheduler, referral, progress export
- Notifications + per-user notification preferences

## Admin portal (one 3,994-line component with sub-views)
- Overview with KPIs, revenue analytics, **revenue forecast** (linear regression)
- Students: list/filter (school-type tabs, SQL-filtered), add, profile drawer, activate/deactivate, group assignment, school-type change (auto-batch move), session management per user
- Teachers: list + add
- Groups: create, manage (assign teacher/students, capacity)
- Courses: list (tree view) + create + "seed curriculum from file"
- Question bank: list/filter/search (bank selector ARABIC/LANGUAGE/shared) + create
- Session videos: upload/publish to batches
- Mock exams: create/publish (FIXED/RANDOM)
- Quiz review: attempts + camera evidence (admin-only)
- Payments: approve/reject/import; subscriptions; coupons; notifications center; settings (branding/WhatsApp/prices stored in `Setting`)

## Teacher portal (3,224-line component)
- Dashboard (groups, students); quiz authoring (create quiz + questions for own-course lessons, validated); homework list + **grading** (own-course scope enforced); attendance marking (own-group scope enforced, student validation); analytics; lesson-plan templates

## Parent portal
- Dashboard: per-child progress (video progress via shared service), attendance % + 6-month breakdown, quiz/homework results, subscription status
- Weekly report (7-day heatmap), monthly report, analytics view; all scoped to linked children only

## Cross-cutting
- Full AR/EN i18n: ~1,585 dictionary keys, isomorphic core, cookie-mirrored server locale, RTL/LTR switching, ar-EG/en-GB date formatting, i18n audit evidence (Playwright screenshots for 44 views × 2 locales)
- Private media system: files outside web root, random storage keys, authorized serving with Range support, `no-store`, SSRF checks, MIME/size ceilings
- Security event logging, DB-backed rate limiting (used by password reset)

---

# Reusable Features

Classification of every major subsystem (goal: **avoid rebuilding working functionality**):

| Subsystem | Verdict | Notes |
| --- | --- | --- |
| Auth core (scrypt, DB sessions, single-device) | **KEEP WITH SMALL FIXES** | Fix open role registration (Phase 2); otherwise solid |
| Password reset + SMTP delivery | **KEEP AS-IS** | Well engineered; verify SMTP live in Phase 12 |
| i18n AR/EN + RTL/LTR | **KEEP AS-IS** | |
| Private media storage + authorized serving | **KEEP AS-IS** | Extend (not rewrite) for lesson PDFs |
| Batch session videos + heartbeat + 95% rule | **KEEP AS-IS** | |
| Session progression gating (`session-progress.ts`) | **KEEP AS-IS** | Server-enforced, well tested |
| Enrollment model (group-based) + catalog gating | **KEEP AS-IS** | Documented decision; see risk R-4 |
| Quiz runtime (start/submit/grading/evidence) | **KEEP WITH SMALL FIXES** | Strip answers from GET, enrollment check, time limit (Phase 3) |
| Mock exams + school-type bank isolation | **KEEP AS-IS** | |
| Question data model (`Question` + schoolType) | **KEEP AS-IS** | Add edit/delete + bank→quiz selection (Phase 8) |
| Teacher portal + scoping | **KEEP AS-IS** | |
| Parent portal + scoping | **KEEP AS-IS** | |
| Admin portal (all existing views) | **KEEP WITH SMALL FIXES / INCREMENTAL REFACTOR** | Monolith file; refactor only sections touched by new phases |
| Gamification / leaderboard / referral / certificate / scheduler | **KEEP AS-IS** (defer polish) | |
| Payments/subscriptions/coupons (manual model) | **KEEP AS-IS** | Enforcement gate is a later business decision |
| Kodgy AI chat | **KEEP WITH SMALL FIXES** | Add rate limit; advanced features deferred |
| Curriculum seed file (`curriculum.ts` + idempotent seeder) | **KEEP AS-IS** for MVP | Official-PDF transition deferred (needs Phase 5 tooling) |
| Offline test suites (7) | **KEEP WITH SMALL FIXES** | Unified runner + 3 suites need installed toolchain (Phase 1) |
| `ExamQuestion` / `ExamAttempt` legacy entities | **REMOVE/DEFER** | Legacy parallel assessment system; keep dormant, don't build on |
| `Lesson.videoUrl` / `Lesson.pdfUrl` fields | **KEEP WITH SMALL FIXES** | Dormant (no writer); wire them up in Phase 6 |
| `next-auth` dependency | **REMOVE** | Unused; trivial cleanup |
| Legacy `Setting`-based session rows | **KEEP (dormant)** | Backward-compat path; remove after migration window |

---

# Broken Features

1. **Open role registration (CRITICAL — see S-1).** Public `POST /api/auth/register` accepts `role: "TEACHER" | "ADMIN"` from the request body and creates the account + session. Anyone can become ADMIN.
2. **Unauthenticated group listing leaks teacher `User` rows incl. password hashes (HIGH — S-2).** `GET /api/groups` has no auth and `include: { teacher: { include: { user: true } } }` returns full user scalars (id, email, **password hash**, phone, role, status).
3. **Quiz answers + explanations returned pre-submission (HIGH — S-3).** `GET /api/quizzes/[id]` and the embedded quiz in `GET /api/lessons/[id]` include `answer` and `explanation` for every question. The code comment admits "For MVP". A student opening devtools sees every correct answer. (The submit route does grade server-side — the leak is in the read path.)
4. **Quiz routes skip enrollment/lesson-access checks.** Any authenticated student can GET/start/submit any quiz by ID (future-session quiz content included once IDs are known); no attempt cap; `timeLimit` is display-only (not enforced at submit).
5. **`Lesson.videoUrl` / `Lesson.pdfUrl` are dead fields.** The student lesson UI renders a video player and PDF link from them, but **no API, admin UI, or seed ever writes them**. The student lesson page therefore shows an empty player area for every lesson; the *real* working video system is the separate batch `SessionVideo` library.
6. **Students cannot submit homework.** `GET /api/students/me/homework` exists; there is **no POST** anywhere. The only `HomeworkSubmission.create` is inside the teacher grading route. Consequence: any lesson with a homework can never satisfy the progression rule via the student — the next session stays locked until a teacher grades (creating a submission on their behalf).
7. **Homework can only be created by the seed script.** No admin/teacher API authors homework. Homework is effectively read-only demo data.
8. **No curriculum CRUD.** Courses: create-only (no update/delete). Parts/units/topics/lessons: no management at all — only the file seeder. No reorder, no publish/lock toggles, no title edits from the UI.
9. **No quiz/question edit or delete.** Quizzes and questions can be created (teacher/admin/AI) but never modified or removed; the question bank has no update/delete endpoints.
10. **`/api/lessons/[id]` bypasses gating for non-students.** Parents receive full lesson content incl. quiz answers; any teacher (not just the course's teacher) gets full content. (Admins legitimately get everything.)
11. **Type safety is off.** `next.config.ts` sets `ignoreBuildErrors: true`; `tsc --noEmit` reports 21 errors (most are artifacts of a blocked `prisma generate` in this sandbox, but at least one is a genuine bug: duplicate `status` key in `admin/payments/import/route.ts` ~line 96–103, where the second key silently overwrites the first).
12. **Lint is not clean.** `eslint .` = 77 errors / 31 files: 38 × `no-require-imports` (all in `tests/*.test.js` — config sweeps the test folder), 37 × `react-hooks/set-state-in-effect` in src components, 2 misc.

---

# Missing Features

Gaps that block a real MVP (beyond the breakages above):

1. **Admin content management** for the full course tree (the single biggest gap) — CRUD + ordering + publish/lock for parts/units/topics/lessons, course editing.
2. **Lesson materials pipeline** — admin upload of session PDFs, attachment to lessons, authorized student access. (The media infrastructure exists; only the document kind + lesson linkage + UI are missing.)
3. **Homework authoring + student submission + full grading loop.**
4. **Quiz/question lifecycle management** (edit, delete/archive, bank selection into quizzes).
5. **Server-side assessment controls** — time-limit enforcement, attempt policy.
6. **Unified test command** (`npm test`) — the 7 suites must be run manually; 3 require the TS toolchain; nothing gates PRs.
7. **Production hardening basics** — security headers/CSP, rate limit on AI chat, verified SMTP, non-demo seed for production, backup procedure.

---

# Security Findings

Classification: CRITICAL / HIGH / MEDIUM / LOW. **Nothing was fixed in this audit** — each finding maps to a roadmap phase.

| ID | Severity | Finding | Location | MVP phase |
| --- | --- | --- | --- | --- |
| S-1 | **CRITICAL** | **Privilege escalation via open role registration.** `POST /api/auth/register` writes the body-supplied `role` directly; the TEACHER/ADMIN branch has no invite/approval. Anyone can self-register as ADMIN (full admin portal + all `/api/admin/*` data) or TEACHER. | `src/app/api/auth/[action]/route.ts` (register, "TEACHER / ADMIN" branch) | Phase 2 |
| S-2 | **HIGH** | **Unauthenticated password-hash + PII disclosure.** `GET /api/groups` (no auth) returns group data incl. `teacher.user` full rows — scrypt **password hashes**, emails, phones. | `src/app/api/groups/route.ts` | Phase 2 |
| S-3 | **HIGH** | **Quiz answer & explanation leakage pre-submission** to any authenticated user; undermines every quiz and mock exam. | `api/quizzes/[id]/route.ts`, `api/lessons/[id]/route.ts` (question mapping includes `answer`, `explanation`) | Phase 3 |
| S-4 | **HIGH** | **Missing authorization on quiz routes**: no enrollment/lesson-access check on quiz GET/start/submit for students (future-session quiz content reachable by ID); unlimited attempts; `timeLimit` not enforced server-side. | `api/quizzes/[id]/{route,start,submit}` | Phase 3 |
| S-5 | **MEDIUM** | **Lesson content access for non-students**: parents get full lesson content + quiz answers; teachers are not scoped to their own courses on `GET /api/lessons/[id]`. | `api/lessons/[id]/route.ts` | Phase 4 |
| S-6 | **MEDIUM** | **Content unlocked before payment confirmation**: enroll assigns the group immediately (PENDING payment); subscription is deliberately not a gate. Revenue-leak risk if admin doesn't police pending payments. | `api/enroll/route.ts`, `lib/enrollment.ts` (documented decision) | Business decision; revisit post-MVP |
| S-7 | **MEDIUM** | **Quiz deletion would cascade attempts** (`QuizAttempt.quiz` onDelete: Cascade). Once real attempts exist, quiz delete destroys student history; needs archive semantics. | `prisma/schema.prisma` | Phase 8 |
| S-8 | **MEDIUM** | **Account-suspension DoS**: anyone holding a victim's password can trigger multi-device suspension (locks the account until admin reactivates). Also suspends legitimate credential-sharing families (product decision). | `lib/auth.ts` `createSession` | Post-MVP (policy) |
| S-9 | **MEDIUM** | **Demo credentials seeded by default** (`admin@codemind.academy` / `admin123` etc.). Must never reach production; `scripts/setup-production.ts` exists but flow is manual. | `scripts/seed.ts` | Phase 11/12 |
| S-10 | **MEDIUM** | **Type checking disabled in builds** (`ignoreBuildErrors: true`); no CI gates; genuine type bug already present (duplicate key in payments import). | `next.config.ts`, `api/admin/payments/import/route.ts` | Phase 11 |
| S-11 | **LOW** | No CSRF tokens/Origin checks (SameSite=Lax + JSON bodies mitigate classic CSRF; harden later). | all mutating routes | Post-MVP |
| S-12 | **LOW** | No security headers/CSP; no middleware. | `next.config.ts` | Phase 12 |
| S-13 | **LOW** | AI chat: no rate limiting, in-memory history (lost on restart, breaks with multiple instances). | `api/ai/chat/route.ts` | Phase 11 |
| S-14 | **LOW** | Student code generation falls back to `Math.random()` on the client (server path uses crypto; codes are not secrets). | `lib/registration.ts` | Post-MVP |

**Verified non-findings (good):** all 33 admin routes enforce ADMIN; teacher routes consistently verify own-course/own-group scope (quizzes, homework grading, attendance); parent routes scope strictly to linked children; student routes derive identity from the session only; media serving authorizes per asset (quiz evidence admin-only, session videos batch-scoped, parents blocked); mock-exam bank isolation is server-side; password reset is rate-limited, hashed, and anti-enumeration; `.env` is gitignored and `.env.example` contains placeholders only; IP addresses stored only as salted hashes.

---

# Database Findings

**Schema at baseline:** 42 models + 12 enums, SQLite, 955 lines. Two migrations, both additive-only, hand-documented, with SQL-simulation tests (15 checks) and an offline migration test suite (98 checks).

**Structure quality:** the core hierarchy `Course → Part → Unit → Topic → Lesson` is clean, with bilingual columns, `order` fields, sensible indexes (`@@index` on hot paths: `lesson.topicId`, `quizAttempt.[quizId,studentId]`, `sessionVideo.[batchId,isPublished]`, etc.), appropriate uniques (`LessonProgress.studentId_lessonId`, `SessionVideoView.[sessionVideoId,studentId]`, `ParentStudentLink.[parentId,studentId]`), and careful FK behaviors (`SessionVideo.media` onDelete: Restrict protects media referenced by published videos).

**Duplication / legacy (keep temporarily, do not build on):**
- `ExamQuestion` + `ExamAttempt` — a parallel legacy assessment projection competing with `Question`/`QuizAttempt`/`MockExamQuestion`. Dormant; the Phase-3 report itself flags it as legacy.
- `Lesson.videoUrl`/`pdfUrl` vs `MediaAsset`/`SessionVideo` — competing video concepts; the media path is the authoritative one.
- Legacy `Setting`-based session rows — backward-compat path in `auth.ts`.

**Missing entities for MVP:** none strictly required. Lesson PDFs can reuse `MediaAsset` (add a DOCUMENT kind) + authorized `/api/media/[id]` serving with `Lesson.pdfUrl` pointing at the media route URL — **no schema change needed**. Homework file submissions can likewise reuse `MediaAsset`.

**Unsafe relationships:** `Quiz → QuizAttempt` cascade delete (S-7) is the one that needs archive semantics before quiz deletion is exposed. Course deletion cascades the whole tree (no course-delete route exists today; Phase 5 must add soft-archive instead).

**Post-baseline schema drift on `main` (PRs #12–#14):** adds `Track`, `Enrollment` (a second, explicit enrollment concept competing with the group-based model the whole runtime uses), `Material`, plus `Lesson.unitId`/`officialCode`/`curriculumStatus` and migration `20260907100000_phase3_domain_foundation` (additive-only, 51 lines). **Recommendation: keep it dormant.** It is additive, no runtime code references it, and SQLite migration history is append-only (reverting means another migration + churn). Document it as off-limits; a future approved phase may adopt or remove it deliberately. The 18 MB of curriculum PDFs and the knowledge-model JSON in `docs/` are harmless reference material — keep as reference, do not treat as runtime curriculum.

**Migrations required before implementation:** **none.** The MVP roadmap needs no schema change until optionally adding a `MediaKind.DOCUMENT` enum value (additive) in Phase 6 and archive flags in Phase 8.

---

# Student Experience

**Working today:** register (with Egyptian validation) → login → enroll (group + plan + manual payment) → course tree with locked/current/completed states → lesson page (content, prev/next) → quiz (attempt, camera consent, server-graded result with explanations) → mock exams → batch session-video library with real watch tracking → dashboards (progress, XP/levels, leaderboard, bookmarks, notes, certificate, study scheduler, referral) → notifications.

**Broken/missing for MVP:** lesson page has no real video/PDF because nothing can set those fields; homework cannot be submitted (and a lesson with homework deadlocks progression until a teacher grades); quiz answers are visible to a determined student via devtools; refresh loses the student's place (SPA navigation).

**MVP target:** course → unit → session with **materials (PDF) + video + session quiz**, clean progression, honest results. All of it gated server-side (the gating logic itself already exists and is good).

# Admin Experience

**Working:** full admin portal shell with overview/revenue, students (incl. reactivation after multi-device suspension), teachers, groups, courses (create + seed), question bank (create/list), session videos (upload/publish per batch), mock exams, quiz review + camera evidence, payments/subscriptions/coupons, notifications, settings.

**Missing for MVP:** the admin **cannot run the educational product day-to-day** — no curriculum CRUD (typos in a lesson title are unfixable from the UI), no lesson video/PDF attachment, no homework authoring, no quiz/question editing, no course editing.

# Teacher Experience

**Working and correctly scoped:** dashboard over own groups/students; quiz authoring for own-course lessons; homework grading; attendance (own group + student validation); analytics; lesson-plan templates.

**Missing:** homework authoring (can't create the assignments they grade); no visibility into student session-video progress (analytics may cover quiz data only); quizzes can't be edited after creation.

# Parent Experience

**Working:** verified child linking at registration (or later), per-child progress/attendance/results dashboards, weekly + monthly reports, analytics — all strictly scoped to linked children (verified in code; covered by the monthly-report test suite, 67 checks).

**Gaps for MVP:** none blocking. Parents currently receive full lesson content on `/api/lessons/[id]` if they obtain an ID (S-5) — close in Phase 4. Attendance depends on teachers marking `LiveSession` attendance, which is seeded demo data today; verify the operational flow in Phase 10.

# Assessment System

- **Session quiz (per lesson):** runtime complete (start → camera evidence → server-graded submit → review), but answers leak pre-submission (S-3), no time-limit/attempt enforcement (S-4), no authoring lifecycle (create-only).
- **Mock exams:** solid design — school-type-isolated banks, admin-defined FIXED/RANDOM exams, answer snapshots; 22-check isolation test suite passes. **Keep as-is**; it is a "should have" that already exists.
- **Unit exams: NOT essential for the initial MVP.** Lesson quizzes + mock exams cover assessment needs; a Unit Exam feature would duplicate the mock-exam machinery. Defer (Category B).
- **Question system usability:** the `Question` model (MCQ/TRUE_FALSE, bilingual, difficulty, marks, schoolType bank tags) is **usable for MVP as-is**. Required changes: edit/delete endpoints, bank→quiz selection UI, archive-not-delete for attempted quizzes. **Central Question Bank content population is postponed** — no content generation in this cycle; the architecture evolution (shared pool + assessments referencing it) is documented for a later phase.

# Curriculum System

**What the app runs on today:** the hardcoded seed in `src/lib/curriculum.ts` (2 parts, ~36 synthetic lessons) restored idempotently by `seedCurriculumFromFile` (18-check idempotency suite). The admin "seed" button re-runs it.

**What exists but is not runtime:** the official curriculum PDFs (Arabic + English, ~18 MB, merged post-baseline in `docs/`) and the Phase-2 `knowledge-model.json` (23 official lessons, Track→Course→Part→Unit→Lesson hierarchy). **Do NOT assume the PDFs must immediately become the runtime curriculum.**

**Required transition path (later, not MVP-blocking):** after Phase 5 (content CRUD) exists, a dedicated phase can enter the official 23-lesson structure as real content and retire synthetic lessons — deliberately, with the admin tooling, not via a schema-first redesign. Until then the seed curriculum is the runtime curriculum.

# PDF/Materials

- **Session PDF support is NOT present today** (beyond the dormant `Lesson.pdfUrl` string).
- **Infrastructure that already exists and should be reused:** `MediaAsset` + private local storage (random keys outside web root) + authorized `/api/media/[id]` serving with Range support; upload hardening (MIME allowlist, size ceilings, SSRF checks).
- **Required for MVP (Phase 6):** extend `MediaKind` with DOCUMENT, admin upload UI in the lesson editor, lesson→materials linkage (simplest: `Lesson.pdfUrl = /api/media/{id}`; richer: a materials list), authorize enrolled students on the media route, and a materials section in the student lesson view.
- **Admin upload is necessary for MVP** (teachers distribute session sheets); **PDF generation is postponed**; per-student material personalization is not needed.

# Kodgy

**Current state:** a floating chat assistant (`ai-assistant.tsx`) backed by `POST /api/ai/chat` using `z-ai-web-dev-sdk` with an Arabic tutoring system prompt (Programming & AI scope, refuses to hand out quiz answers). Any authenticated role can use it. History is in-memory (12 messages, lost on restart).

**Essential assistant functionality for MVP:** exactly what exists — a scope-guarded Q&A tutor — plus a rate limit and message cap (Phase 11 hardening; no new capability needed for MVP).

**Optional advanced intelligence (postponed):** curriculum-aware context (injecting the student's current lesson/topic), progress-aware hints, quiz authoring assistance (the existing `ai-generate-quiz` route already covers basic generation), adaptive study plans. None of these block the MVP.

# Testing

**Existing suites (all offline, no DB server needed):**

| Suite | Checks | Status at audit |
| --- | --- | --- |
| `tests/authorization-invariants.test.js` (static source invariants over routes/libs) | 93 | ✅ pass |
| `tests/platform-upgrade-2026-migration.test.js` | 98 | ✅ pass |
| `tests/parent-monthly-report.test.js` | 67 | ✅ pass (needs installed TS toolchain) |
| `tests/mock-exam-grading-isolation.test.js` | 22 | ✅ pass |
| `tests/registration-validators.test.js` | 24 | ✅ pass (needs installed TS toolchain) |
| `tests/seed-idempotency.test.js` | 18 | ✅ pass (needs installed TS toolchain) |
| `tests/migration-sql.test.js` (SQL simulation) | 15 | ✅ pass |
| `tests/i18n/audit-ui.mjs` + visual harness (Playwright) | evidence | not run this session (needs dev server) |

**Total: 337 checks, 0 failures** (run 2026-09-07 with `npm ci` + `npx tsx` available).

**Gaps:** no unified `npm test` script; no runtime/API tests against a live server (the invariants are static); no CI; type checking disabled in build; lint currently red (77 errors, mostly test-folder config + react-hooks rule). Roadmap Phase 1 adds the runner; Phase 11 adds typecheck/lint gates; Phases 2–4 extend the invariants suite for the new security rules.

**Checks performed in this audit session:** `npm ci` (891 pkgs), all 7 offline suites (337/337), `npx tsc --noEmit` (21 errors — mostly artifacts of network-blocked `prisma generate`; ≥1 genuine), `npx eslint .` (77 errors characterized), full static review of all 75 API routes, schema review, baseline↔main diff review. No dev server / build / DB migration was executed (audit-only).

---

# MVP Must-Have Features

**Category A — required for the platform to function as a real educational product:**

1. **Security fixes:** registration role lock (STUDENT/PARENT only; staff accounts via admin), `/api/groups` auth + PII/password stripping *(Phases 2)*
2. **Assessment integrity:** answers never sent pre-submission, enrollment checks on quiz routes, server-side time limit, attempt policy *(Phase 3)*
3. **Content access consistency:** lesson routes scoped by role (parents out, teachers own-course only) *(Phase 4)*
4. **Admin curriculum management:** CRUD + ordering + publish/lock for parts/units/topics/lessons; course editing *(Phase 5)*
5. **Session materials:** PDF upload/attach + authorized access; lesson video URL management *(Phase 6)*
6. **Homework loop:** authoring, student submission, grading (grading exists) *(Phase 7)*
7. **Quiz/question lifecycle:** edit, archive, bank selection *(Phase 8)*
8. **Verified core journeys:** student session flow, parent visibility, teacher scope *(Phases 9–10)*
9. **Quality gates:** one-command offline tests + typecheck *(Phases 1, 11)*
10. Already working and simply kept: auth/session/password reset, enrollment+payments, session videos, progression gating, mock exams, i18n, all four portals' existing views.

# Features to Postpone

**Category B — useful, safely postponed:**

- Unit Exams (mock exams + lesson quizzes suffice initially)
- Central Question Bank content population + architecture evolution
- Curriculum transition from seed file to the official 23-lesson structure (requires Phase 5 tooling first)
- Kodgy curriculum-aware intelligence; AI quiz generation investment (route exists, leave dormant)
- Subscription/payment enforcement gate (S-6 business decision)
- Revenue forecast/analytics refinement; CSV export expansion
- URL routing/deep links; PWA/offline; service worker
- PostgreSQL migration (SQLite is fine for MVP scale)
- Email notifications beyond password reset
- Gamification/leaderboard/referral polish (working — just don't invest)
- Multi-device policy tuning (S-8)

# Features Not Needed Now

**Category C — complexity without MVP value:**

- `Track` / `Enrollment` / `Material` entities and the knowledge-model JSON as runtime constructs (post-baseline experimental schema — keep dormant)
- Advanced Kodgy curriculum intelligence / adaptive learning
- Multi-course catalog commerce, marketing pages beyond the current landing
- Deployment automation beyond a refreshed guide + backup procedure
- xlsx import expansion (payments CSV import exists and is enough)
- Live-session meeting integrations (Zoom/Meet automation) — `LiveSession` CRUD and attendance already cover the MVP need

---

# New MVP Phase Roadmap

Twelve phases, ordered by technical dependency. **Every phase ends in a stable, shippable state** (tests green, no half-wired features) and follows: implement → test → validate → commit → push → PR → **STOP for manual review/merge**.

---

**Phase 1 — Baseline Reconciliation & Test Tooling**
- **Objective:** make the working baseline explicit and one-command verifiable.
- **Features:** `npm run test:offline` script running all 7 suites (with tsx); eslint config stops sweeping `tests/*.js`; record the "phase-3 schema stays dormant" decision in `docs/PROJECT_STATE.md`; optional removal of unused `next-auth` dependency.
- **Dependencies:** none.
- **Intentionally excluded:** any app-behavior change; schema changes; reverting post-baseline docs.
- **Acceptance criteria:** from a clean clone: `npm ci && npm run test:offline` → 337/337 green; `eslint src` error count documented (no new errors); PROJECT_STATE updated.
- **Risk:** LOW.

**Phase 2 — Critical Auth & Registration Security**
- **Objective:** close both CRITICAL/HIGH account holes.
- **Features:** public registration restricted to STUDENT/PARENT (reject TEACHER/ADMIN with 403); staff creation only via authenticated admin routes; `GET /api/groups` requires auth + returns only safe fields (no user rows); extend authorization-invariants with regression checks for both.
- **Dependencies:** Phase 1.
- **Excluded:** teacher invite codes; password policy changes; login rate limiting (already have security events; add later if needed).
- **Acceptance:** registering with `role:"ADMIN"`/`"TEACHER"` → 403; anonymous `GET /api/groups` → 401; no `password`/email/phone in any group payload; enroll flow still works E2E; all suites green.
- **Risk:** MEDIUM (enroll UI consumes the groups endpoint — must re-verify).

**Phase 3 — Assessment Integrity**
- **Objective:** make quizzes and exams honestly cheat-resistant.
- **Features:** strip `answer`/`explanation` from `GET /api/quizzes/[id]` and the lesson payload (serve them only in the submit response); add `canAccessLesson`-based enrollment checks to quiz GET/start/submit for students; enforce `timeLimit` server-side (startedAt + limit + grace at submit); configurable max attempts per quiz.
- **Dependencies:** Phase 1 (Phase 2 recommended first for clean auth semantics).
- **Excluded:** proctoring upgrades; camera-evidence changes (working); question shuffling (already randomized).
- **Acceptance:** no `answer` field in any pre-submit payload; late submits rejected; unenrolled student blocked on all three quiz routes; quiz runner E2E still works (UI adjusted for missing pre-submit answers); invariants extended.
- **Risk:** MEDIUM (client `quiz-runner` changes required).

**Phase 4 — Lesson & Course Content Access Consistency**
- **Objective:** one authorization story for content routes.
- **Features:** `GET /api/lessons/[id]` role scoping (students: existing gating; teachers: own courses only; parents: 403; admins: all); same treatment for `/api/courses/[slug]`; invariants extended.
- **Dependencies:** Phase 1; can proceed in parallel with Phase 3.
- **Excluded:** new content APIs.
- **Acceptance:** parent cannot fetch lesson content; out-of-scope teacher → 403; student flow unchanged; suites green.
- **Risk:** LOW.

**Phase 5 — Admin Curriculum Content Management**
- **Objective:** let the admin actually run the course.
- **Features:** CRUD APIs + admin UI for Part/Unit/Topic/Lesson (create, edit, reorder, publish/unpublish, lock/unlock); course edit (name/description/color); soft-archive instead of hard delete where enrollments/attempts exist; incrementally extract the touched admin views from the monolith.
- **Dependencies:** Phases 2–4.
- **Excluded:** bulk import; official-curriculum migration; Track/Material entities; lesson media attachment (Phase 6).
- **Acceptance:** admin can build and edit the full course tree from the UI; student course view reflects changes; the seeded curriculum is not damaged (seed idempotency suite still green); reordering is safe.
- **Risk:** MEDIUM-HIGH (largest phase).

**Phase 6 — Session Materials (PDF) & Lesson Video Management**
- **Objective:** every session has its video and sheet.
- **Features:** `MediaKind.DOCUMENT` (additive enum); admin upload/attach of lesson PDFs (private storage, served via `/api/media/[id]`); media-route authorization for lesson materials (enrolled students); admin can set/edit `lesson.videoUrl` (external) and see linked batch session videos; materials section in the student lesson view.
- **Dependencies:** Phase 5.
- **Excluded:** PDF generation; per-student personalization; materials on mock exams.
- **Acceptance:** admin uploads a PDF → only enrolled students of that course can open it; student lesson page shows materials + working video; unenrolled/parent access → 403.
- **Risk:** MEDIUM.

**Phase 7 — Assignment (Homework) Loop**
- **Objective:** complete the author → submit → grade → unlock cycle.
- **Features:** homework authoring (teacher own-course lessons + admin); student submission API + UI (text + optional file via MediaAsset) with resubmission policy; teacher grading UI wired to real submissions; parent visibility of homework status; progression rule satisfied by submission (deadlock removed).
- **Dependencies:** Phases 5, 6 (file upload infra).
- **Excluded:** rubrics, auto-grading, peer review.
- **Acceptance:** full loop works E2E and unlocks the next session; teacher sees submissions for own courses only; parent sees child's status; suites green.
- **Risk:** MEDIUM.

**Phase 8 — Quiz Authoring Completeness & Question Bank MVP**
- **Objective:** assessments are maintainable.
- **Features:** quiz edit + archive (never hard-delete once attempts exist — fixes S-7); question edit/archive; insert questions from the bank when composing; quiz ordering per lesson.
- **Dependencies:** Phases 3, 5.
- **Excluded:** central bank content population; import/export formats.
- **Acceptance:** full authoring lifecycle works within teacher scope; archiving preserves attempt history; bank selector inserts questions into quizzes.
- **Risk:** MEDIUM.

**Phase 9 — Student Experience E2E Verification & Polish**
- **Objective:** prove the core journey.
- **Features:** scripted E2E walkthrough in **both locales** (register → enroll → course → session: video/PDF/quiz/homework → progression → results/dashboard); fix defects found; RTL/LTR verification; refresh/navigation UX check.
- **Dependencies:** Phases 5–8.
- **Excluded:** new features; URL routing redesign.
- **Acceptance:** checklist passes AR + EN with no blocking console errors; progression math verified against the API.
- **Risk:** LOW-MEDIUM (unknown defect count).

**Phase 10 — Parent & Teacher Portals Verification**
- **Objective:** prove role isolation and the staff experience.
- **Features:** role-matrix verification (parent child-scope across dashboard/reports/analytics; teacher scope across students/quizzes/homework/attendance/analytics); fix defects; confirm attendance operational flow.
- **Dependencies:** Phases 7–9.
- **Excluded:** new reports.
- **Acceptance:** role-matrix test passes; every cross-scope access attempt → 403.
- **Risk:** LOW.

**Phase 11 — Hardening & Quality Gates**
- **Objective:** make regressions visible before merge.
- **Features:** `tsc --noEmit` clean (fix the 21 errors incl. the payments-import duplicate key); add `typecheck` + `lint` + `test:offline` as the phase-gate command set; clean the 37 react-hooks lint errors in touched files; AI chat rate limit + message cap; production seed hardening (no demo passwords in production mode).
- **Dependencies:** after Phases 9–10 (or earlier if scoped to untouched files).
- **Excluded:** CI platform setup (can be manual gates initially).
- **Acceptance:** one command runs typecheck + lint + offline tests, all green.
- **Risk:** LOW-MEDIUM.

**Phase 12 — Production Readiness (Lightweight)**
- **Objective:** a safe go-live.
- **Features:** deployment guide refresh (standalone build + Caddy); SQLite + media backup/restore procedure (rehearsed once); SMTP live verification; security headers/CSP; go-live checklist.
- **Dependencies:** Phase 11.
- **Excluded:** orchestration, Docker, managed DB migration, monitoring stack.
- **Acceptance:** checklist complete; backup restore rehearsed; SMTP delivery confirmed end-to-end.
- **Risk:** LOW.

---

# Dependencies

```
Phase 1 (tooling)
  └─> Phase 2 (auth security)
        └─> Phase 3 (assessment integrity) ─┐
        └─> Phase 4 (content access) ───────┤
                                             v
                  Phase 5 (curriculum CRUD)
                    ├─> Phase 6 (materials/PDF)
                    │     └─> Phase 7 (homework loop)
                    └─> Phase 8 (quiz authoring) <─ Phase 3
                          Phase 9 (student E2E)  <─ 6,7,8
                          Phase 10 (parent/teacher verify) <─ 7,9
                          Phase 11 (hardening/gates)
                          Phase 12 (production readiness)
```

Key external dependencies: Prisma engine downloads (were network-blocked in this audit sandbox — needed for `prisma generate`/builds), Gmail SMTP credentials for password reset, `z-ai-web-dev-sdk` for Kodgy/AI generation (works in the sandbox environment).

# Risks

| # | Risk | Impact | Mitigation |
| --- | --- | --- | --- |
| R-1 | Security holes are publicly exploitable **today** (S-1, S-2) if any instance is deployed | Critical | Phase 2 is the second phase precisely for this; do not deploy before Phase 2 |
| R-2 | Quiz-runner UI depends on pre-submission answers (Phase 3) — client refactor may surface hidden assumptions | Medium | Phase 3 acceptance includes E2E quiz run; submit response already returns graded answers |
| R-3 | Phase 5 is the largest build; admin monolith (3,994 lines) raises regression risk | Medium-High | Incremental extraction of only the touched views; existing suites as guardrails; consider splitting into 5a/5b if PR size demands |
| R-4 | Content-before-payment (S-6) leaks revenue if admins don't police PENDING payments | Medium | Documented business decision; revisit post-MVP with an explicit gate |
| R-5 | Homework gating deadlock is latent: any seeded homework locks progression until graded | Medium | Phase 7 removes it; until then avoid seeding homework on lessons |
| R-6 | Post-baseline schema drift may confuse future agents into building on Track/Enrollment | Medium | PROJECT_STATE.md marks it dormant/off-limits; invariants could assert no runtime references |
| R-7 | No runtime test coverage (all suites are static/offline) — runtime regressions only surface manually | Medium | Phases 9–10 scripted E2E; Phase 11 gates; add a minimal live-server smoke script post-MVP |
| R-8 | SQLite single-writer + local-file media storage limits scale/HA | Low (MVP) | Accepted for MVP; PostgreSQL + object storage are documented post-MVP moves |
| R-9 | Sandbox/network constraints (Prisma engine download blocked here) may differ from the user's environment | Low | Verify `prisma generate` + build in the real environment during Phase 1 |

# Recommended Starting Implementation Phase

**Start with Phase 1 (Baseline Reconciliation & Test Tooling)** — it is deliberately tiny, zero-risk, and makes every later phase verifiable with one command. **Immediately follow with Phase 2 (Critical Auth & Registration Security)**, because S-1/S-2 are exploitable on any deployed instance and everything else builds on a trustworthy account model. No implementation was started in this audit session.
