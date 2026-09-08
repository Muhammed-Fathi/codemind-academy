# CodeMind Academy — Master Platform Audit & Roadmap

> **Audit date:** 2026-09-08 · **Baseline:** `main` @ `adfdb67` (PR #27, Phase 10 merge)
> **Scope:** full platform audit + architecture review + master roadmap (planning only — no code changed)
> **Method:** exhaustive static inspection of `src/`, `prisma/` (schema + all 4 migrations), `scripts/`,
> `tests/`, `docs/` (all phase reports, guides, ADRs, curriculum knowledge model), plus API/component/lib tracing.
> **Git note:** this checkout is a shallow/squashed clone — `git rev-list --count HEAD` = 1, so only
> `adfdb67` is visible locally and the Phase 10 feature commit `b20e8e2` cannot be inspected here.
> Phase history below is therefore reconstructed from the authoritative in-repo records
> (`docs/PHASE_*.md`, `docs/PROJECT_STATE.md`, `docs/PLATFORM_UPGRADE_2026.md`, code comments) rather
> than from `git log`. Nothing in this report required history that only old commits could provide.

---

## Executive Summary

CodeMind Academy at `adfdb67` is a **single-tenant Next.js 16 + Prisma + SQLite** learning platform
(a single-page shell at `/` fed exclusively by `~68` API route files) with a **mature, well-hardened
student-progression and assessment core** (Phases 1–10 of the current cycle) sitting on top of a
**curriculum/content architecture that is only half-built**:

1. **The required official curriculum already exists — as data, not as database rows.**
   `docs/curriculum/knowledge-model.json` (v2.0.0, validated 2026-09-07 against the four committed
   Ministry PDFs) contains **exactly** the required structure: 2 parts, 7 units/chapters, 23 lessons
   (`1-1`…`7-3`) with EN+AR titles matching the product requirement nearly verbatim. But the database
   still holds the **synthetic 36-lesson Topic-based seed** (`What is IT?`, `UI vs UX`, …) from
   `src/lib/curriculum.ts`, and the reconciliation migration has never been written.
2. **The Phase 3 domain foundation (Track / Enrollment / Material / `Lesson.unitId` /
   `officialCode` / `curriculumStatus`) exists in the schema but has ZERO references in `src/`.**
   It is dead schema: enrollment still resolves via `Student.groupId → Group.courseId`, track
   isolation for session content does not exist, and `Material`/`MediaKind.DOCUMENT` are unused.
3. **Track isolation is partial and asymmetric.** It is *correct* for mock exams (bank filter in
   selection **and** grading) and for batch session videos (batch + `isPublished` gate). It is
   *absent* for lessons, lesson videos, PDFs, session quizzes, and homework: a `LANGUAGE` and an
   `ARABIC` student enrolled in the same course see byte-identical session content today.
4. **There is no publish workflow.** `Lesson.isPublished` (default `true`) only makes lessons
   *invisible* (not *locked*) and has no admin UI; `Lesson.isLocked` is inert legacy metadata;
   there is no lesson/session CRUD API at all, no PDF upload, no readiness model, no
   open/publish-and-notify action, and no homework-creation endpoint.
5. **Notifications are generic broadcast, not session lifecycle events.** No batch/track targeting,
   no deep-link handling in the client (notification `link` strings like `admin-payments` are stored
   but never navigated to — the notification list renders no links), and per-user fan-out via
   `createMany` with no batching guard.
6. **The security foundation is strong** (single-device sessions, scrypt, server-side progression
   gates, locked-session redaction, proxy defense-in-depth, bank isolation, monotonic video
   heartbeats) — the remaining risks are almost all *content-scope* risks (track leakage, premature
   access, unprotected PDFs), not auth-primitive risks.

**Bottom line:** the product requirements (track-specific curriculum, session PDFs, publish workflow,
targeted notifications, locked-but-visible curriculum) require **finishing the content half of the
platform** — roughly 12 dependency-ordered phases (proposed Phase 11 → Phase 22) — on top of a
learning/assessment core that should be **reused unchanged**. No schema redesign is needed; only
small additive migrations plus finally *wiring up* the domain foundation that Phase 3 already created.

---

## Current Baseline

| Item | State |
|---|---|
| Branch / commit | `main` @ `adfdb67` (Merge PR #27); working tree clean |
| Completed cycle | Current-cycle **Phase 1 → Phase 10** (all merged, docs in `docs/PHASE_*.md`) |
| Foundation lineage | Platform Upgrade 2026 → Knowledge Model v2.0.0 → Domain Foundation (PR #14) |
| Stack | Next.js 16.3.4 · React 19 · Prisma 6.11.1 · SQLite (`db/custom.db`) · Tailwind 4 · zustand SPA shell |
| Build | `prisma generate && next build && node scripts/copy-standalone-assets.mjs`; `output: standalone`; `tsc --noEmit` clean at last verified phase |
| Auth | Cookie sessions (`cm_session`) → `UserSession` table (SHA-256 token hash), scrypt passwords, single-device enforcement, `SUSPENDED_MULTI_DEVICE` |
| Tests | Offline suites in `tests/*.test.js` (13 suites: 723 assertions after Phase 4, + Phase 5/6/7/8 suites, +440 Phase 9, + Kodgy Phase 10) + i18n/Playwright evidence + visual harness |
| i18n | Bilingual AR (default, RTL) / EN (LTR); `cm-locale` cookie mirrors client locale for server messages |
| Curriculum in DB | Synthetic 36-lesson seed (2 parts / 7 units / ~17 topics / 36 lessons), Topic-linked |
| Curriculum contract | Official 23-lesson knowledge model (`docs/curriculum/knowledge-model.json`), never reconciled into DB |
| Deployment target | Standalone Node server behind Caddy (`Caddyfile` → `localhost:3000`); `scripts/start-production.mjs`; `scripts/setup-production.ts` (interactive CLEAN) |

### Dual phase-numbering — read this first

The repository contains **two overlapping numbering schemes**, which the roadmap must not confuse:

| Scheme | Phases | Artifacts |
|---|---|---|
| **A. Platform lineage** (product/data) | Platform Upgrade 2026 → “Phase 2” Knowledge Model → “Phase 3” Domain Foundation (PR #14) | `prisma/migrations/20260906120000_*`, `docs/curriculum/*`, `prisma/migrations/20260907100000_*`, `docs/decisions/ADR-003*` |
| **B. Current hardening cycle** (the task’s “Phase 1–10”) | P1 Deployment Audit → P2 Build/Type Safety → P3 Security Hardening → P4 Progression → P5 Session Quiz → P6 Teacher Analytics → P7 Parent Integration → P8 Mock Exam Cleanup → P9 Calendar/i18n → P10 Kodgy | `docs/PHASE_*.md`, `docs/DEPLOYMENT_READINESS_AUDIT.md`, `docs/PROJECT_STATE.md` |

Scheme B is what “Completed Phases 1–10” means below. Scheme A’s “Phase 2/3” are *foundation*
deliverables that Scheme B builds upon (and that the future roadmap must finally complete).
The recommended future phases continue Scheme B numbering (**Phase 11 → Phase 22**) to avoid a
third scheme; the justification is recorded in § Master Phase Roadmap.

---

## Completed Phases 1–10

(Scheme B. Each entry traced to real files, not just phase docs.)

### Phase 1 — Deployment Readiness Audit (baseline `635de56`)

- **Purpose:** find and fix deployment blockers (build, security, data integrity).
- **Implemented:**
  - **CRITICAL fix:** privilege escalation via public registration — `TEACHER`/`ADMIN` roles are now
    rejected in `POST /api/auth/register` (`src/app/api/auth/[action]/route.ts`); staff accounts are
    provisioned only by existing admins.
  - **HIGH fix:** quiz answer leakage — answers/explanations withheld from students until a finished
    attempt exists (`revealQuizAnswers` rule in `src/app/api/lessons/[id]/route.ts` and
    `src/app/api/quizzes/[id]/route.ts`).
  - **HIGH fix:** parent impersonation — parent registration now requires the triple match
    (student national ID + student code + parent phone, normalized) with identical 404 messages
    (`api.073`/`api.074`) so failures never oracle real students.
- **Important files:** `src/app/api/auth/[action]/route.ts`, `src/app/api/lessons/[id]/route.ts`,
  `src/app/api/quizzes/[id]/route.ts`, `src/lib/registration.ts`, `docs/DEPLOYMENT_READINESS_AUDIT.md`.
- **DB impact:** none. **API impact:** registration/login/quiz/lesson hardening. **UI impact:** none
  structural. **Security:** 1 critical + 2 high closed. **Tests:** 337 assertions green.
- **Status:** complete. **Limitations:** 5 medium + 7 low deferred (carried into P2/P3).
- **Depended on by:** everything — the role/answer/linking invariants are assumed by P4–P8.

### Phase 2 — Production Build & Type Safety (baseline `fce4821`)

- **Purpose:** make `next build` honest and cross-platform.
- **Implemented:** removed `ignoreBuildErrors` (67 hidden TS errors fixed, `tsc --noEmit` clean);
  build script `prisma generate && next build && node scripts/copy-standalone-assets.mjs`
  (replaces Unix-only `cp` chain, same standalone layout); `bun run typecheck`; excluded stray
  `examples/` from tsconfig.
- **Important files:** `package.json`, `next.config.ts`, `scripts/copy-standalone-assets.mjs`,
  `tsconfig.json`, `docs/PHASE_2_BUILD_TYPE_SAFETY.md`, `docs/PHASE_2_REPORT.md`.
- **DB/API/UI impact:** none (build-only). **Security:** none directly; honest builds unblock audits.
- **Tests:** 337 green; lint state unchanged (78 pre-existing deferred).
- **Status:** complete. **Limitations:** lint debt untouched; Prisma-engine download required at build.

### Phase 3 — Production Security Hardening (baseline `5bd041c`)

- **Purpose:** production secret discipline + defense-in-depth + dependency hygiene.
- **Implemented:**
  - `SECURITY_HASH_SECRET` **required** in production (`src/lib/env.ts` validates; `next.config.ts`
    fails the build and `src/instrumentation.ts` fails startup with value-free messages;
    `SKIP_PRODUCTION_ENV_CHECK=1` escape hatch for secret-less CI artifact builds).
  - `src/proxy.ts` (+ `src/lib/route-protection.ts`): cookie-presence 401 for 11 protected `/api/*`
    namespaces, no DB, routes remain the authorization source of truth; baseline security headers,
    `poweredByHeader: false`, no CSP (deliberately deferred — would break inline styles/video).
  - **HIGH fix:** public `/api/groups` no longer serializes teachers’ full `User` rows
    (explicit field selection; comment documents the prior hash/phone/email leak).
  - Deps: nodemailer 7→9.1.1, sharp 0.34→0.35.4, next 16.1→16.3.4; removed 6 unused deps;
    `npm audit` 12→4 high (remaining: `xlsx` no-fix + Prisma-CLI transitive).
  - `scripts/start-production.mjs` (dependency-free, Windows-portable).
- **Important files:** `src/lib/env.ts`, `src/lib/security.ts`, `src/proxy.ts`,
  `src/lib/route-protection.ts`, `src/app/api/groups/route.ts`, `docs/PHASE_3_SECURITY_HARDENING.md`.
- **Tests:** 337 + 242 new = **579** (`tests/security-hardening.test.js`); typecheck 0 errors.
- **Status:** complete. **Depended on by:** P4’s proxy/gate layering; all later phases assume the
  secret contract.

### Phase 4 — Student Learning Foundation + Session Progression (baseline `df81de4`)

- **Purpose:** one server-side definition of “may this student open this session”, with no leaks.
- **Implemented:**
  - `src/lib/session-progress.ts` — the progression source of truth:
    `canAccessLesson` (enrollment + sequential unlock), `canAccessQuiz`/`canAccessHomework`
    (resolve to owning lesson, re-use `canAccessLesson`), `getUnlockedLessonIds` (batch gate),
    `getCourseSessionProgress` (fixed query count, no N+1).
    Unlock rule (unchanged product rule, now enforced): next session unlocks iff current session’s
    **video ≥95% AND quiz attempted AND assignment submitted**; missing components are not required.
  - **CRITICAL fix:** quiz routes had no session gate — all four (`/quizzes/[id]`, `/start`,
    `/submit`, `/evidence`) now go through `canAccessQuiz` (a single crafted POST could previously
    pre-satisfy every future session’s quiz and harvest answer keys).
  - Locked-session redaction in `GET /api/courses/[slug]`: `videoUrl`, `pdfUrl`, `summary`,
    `description`, `quiz`/`homework` identities, `requirements` withheld; only title/order/duration +
    `hasQuiz`/`hasAssignment` presence flags; 403s never echo requirement rows; dashboard
    `continueLesson` and homework list gated.
  - **Deadlock fix:** `POST /api/students/me/homework` created (student-side submission was 405, so
    any lesson with an assignment locked the course forever). Session-derived `studentId`, gated,
    `SUBMITTED`/`LATE`, graded rows immutable, upsert on `@@unique([homeworkId, studentId])`.
  - `denyProgression()` in `src/lib/api.ts`: uniform 404 (unknown/unverifiable → existence never
    confirmed) vs 403 + machine `code`, never a status row.
  - **Progression-universe follow-up:** lessons discovered through **both** chains
    (`unit → part → course` OR `topic → unit → part → course`); deterministic total order in
    `orderCourseLessons()` (Part → Unit → Topic(−1 for unit-linked) → Lesson → id); canonical link
    wins when both exist (`resolveLessonCourseId`); `/api/courses/[slug]` serves `unit.lessons`
    alongside legacy `unit.topics[].lessons` so display position == enforcement position.
  - Heartbeat video tracking (`/lessons/[id]/video-progress`): wall-clock-credited, monotonic,
    capped (`MAX_CREDIT_PER_BEAT_SEC=60`); `progress:100`/`completed:true` cannot bypass the 95% rule.
- **Important files:** `src/lib/session-progress.ts`, `src/lib/api.ts`, `src/lib/progress.ts`,
  `src/app/api/courses/[slug]/route.ts`, `src/app/api/lessons/[id]/*`,
  `src/app/api/quizzes/[id]/*`, `src/app/api/students/me/homework/route.ts`,
  `docs/PHASE_4_STUDENT_PROGRESSION.md`.
- **DB impact:** none (uses existing `LessonProgress`/`QuizAttempt`/`HomeworkSubmission`).
- **Tests:** 579 + 144 = **723** (`tests/session-progression.test.js`); build 0 warnings.
- **Status:** complete and load-bearing. **Known limitations (carried forward):**
  `Lesson.isLocked` inert; `SessionVideo` deliberately **not** wired into gating (would be a second
  system); deleting Part/Unit/Topic orphans lessons (`onDelete: SetNull`, 17 orphans noted);
  several list endpoints still query the legacy topic chain only (see § Current Gaps).

### Phase 5 — Question Bank & Session Quiz

- **Purpose:** attempt immutability + server-authoritative grading for session quizzes.
- **Implemented:**
  - `src/lib/session-quiz.ts` — single selection+grading module: `seedAttemptQuestions` (freeze the
    quiz’s questions as `QuizAnswer` rows at `/start`), `loadAttemptQuestionSet` (frozen set; one-time
    pre-P5 upgrade path), `gradeAttemptQuestionSet` (server key, first-occurrence wins, client
    score/percentage never read), `sanitizeSelectedInput` (16-char bound), `safeParseOptions`.
  - `POST /api/quizzes/[id]/start`: idempotent resume, `cameraStatus` allow-list, pre-P5 set upgrade.
  - `POST /api/quizzes/[id]/submit`: finalizes the open attempt (evidence stays attached) or creates
    a retake; graded rows persisted transactionally; finished attempts immutable (re-submit = new row).
  - `GET /api/quizzes/[id]`: serves the open attempt’s frozen set when one exists.
  - `GET /api/lessons/[id]` returns **all** quizzes (`quizzes` array; `quiz` kept for compat) so the
    “every quiz attempted” requirement cannot deadlock on a hidden second quiz.
  - Migration `20260908120000_phase5_quiz_answer_unique`: dedup + `@@unique([attemptId, questionId])`.
- **Important files:** `src/lib/session-quiz.ts`, `src/app/api/quizzes/[id]/*`,
  `src/app/api/lessons/[id]/route.ts`, `src/components/course/quiz-runner.tsx`,
  `src/components/course/quiz-camera-monitor.tsx`, `docs/PHASE_5_QUESTION_BANK_SESSION_QUIZ.md`.
- **DB impact:** 1 unique index (+1 index). **Tests:** `tests/session-quiz.test.js`.
- **Status:** complete. **Limitations:** no per-student randomization (by design — mock-exam feature);
  teacher-created questions carry **no `schoolType`**; session-quiz flow never filters by bank.

### Phase 6 — Quiz Results & Teacher Analytics

- **Purpose:** deterministic, scope-safe teacher analytics that can never mutate assessment state.
- **Implemented:** `src/lib/quiz-analytics.ts` — pure, DB-free aggregations:
  `summarizeFinishedAttempts` (finished-only, **attempt-weighted**: every finished attempt = 1 point),
  `difficultyBreakdown`, `questionPerformance`, `weakestQuestions` (correctness asc, attempts desc,
  id tie-break), `attemptInQuizScope`. Teacher routes pre-scope attempts to the teacher’s own courses
  (both chains) before aggregating.
- **Important files:** `src/lib/quiz-analytics.ts`, `src/app/api/teacher/analytics/route.ts`,
  `src/app/api/teacher/quizzes/route.ts` (GET analytics block), `docs/PHASE_6_*.md`.
- **DB impact:** none. **Tests:** `tests/quiz-analytics.test.js`.
- **Status:** complete. **Limitations:** retakes each count (documented product rule); deleted
  questions vanish from analytics (cascade semantics); no track-split views.

### Phase 7 — Parent Dashboard Integration

- **Purpose:** parents see exactly their linked children’s data, and may preview only those courses.
- **Implemented:**
  - `src/lib/parent-access.ts`: `getLinkedStudentIds` → `getParentCourseIds` (via the *same*
    `getEnrollment` rule students use) → `isParentAuthorizedForCourse`.
  - Parent preview gates on `/api/courses/[slug]` (403, slug catalogue is public),
    `/api/lessons/[id]` + `/api/quizzes/[id]` (404, unguessable ids → existence never confirmed).
  - Dedicated `/api/parents/me/*` accept **no** student/course ids — every row derives from
    `Parent.children` links (`dashboard`, `analytics`, `weekly-report`, `notification-prefs`,
    `link-student`).
  - Parent quiz-answer visibility follows the Phase 1 staff rule (answers visible).
- **Important files:** `src/lib/parent-access.ts`, `src/lib/enrollment.ts`,
  `src/app/api/parents/me/*`, `src/components/parent/*`, `docs/PHASE_7_*.md`.
- **DB impact:** none. **Tests:** `tests/parent-dashboard-isolation.test.js`,
  `tests/parent-monthly-report.test.js`.
- **Status:** complete. **Limitations:** parent sees the *shared* course tree (no track dimension);
  `getParentCourseIds` loops enrollments per child (fine at family scale, not batch scale).

### Phase 8 — Mock Exam Cleanup & Integration

- **Purpose:** make mock exams stateless-safe, key-safe, and bank-isolated end to end.
- **Implemented:**
  - GET mints a **stateless draft** (no server in-progress state; refresh = fresh draft) carrying
    **no answer key**; POST creates one finished `ExamAttempt` with an immutable JSON snapshot
    (submit-atomic; retakes are history rows; no timeout enforcement by design).
  - Client answers with selected option **text** (display order shuffled per request); server
    re-grades from DB keys, accepts stored index as back-compat, recomputes marks.
  - `FIXED` = pinned set as-is (pinned order, no filter/shuffle/slice); `RANDOM` = re-sample per
    request under bank + course + difficulty rules; attribution requires published + same bank +
    same course (else degrades to unlinked practice instead of failing).
  - **Bank isolation in selection AND grading** (`questionBankFilter` both sides; typeless students
    grade against shared-only).
- **Important files:** `src/app/api/exams/mock/route.ts`, `src/app/api/admin/mock-exams/*`,
  `src/components/admin/mock-exams-view.tsx`, `src/components/student/mock-exam.tsx`,
  `docs/PHASE_8_*.md`.
- **DB impact:** none (uses upgrade tables). **Tests:** `tests/mock-exam-phase8.test.js`,
  `tests/mock-exam-grading-isolation.test.js`.
- **Status:** complete. **Limitations:** no server-side timer; no question-level evidence.

### Phase 9 — Calendar / i18n

- **Purpose:** localized, RTL-correct scheduling surface + translation-pipeline hardening.
- **Implemented:** scheduler weekday-header fix (`tr(d)` + `DAY_NAME_KEYS`/`MONTH_NAME_KEYS`);
  `translate()` never returns dotted keys (`looksLikeDictKey`/`hasDictKey`/`dictSize`);
  shell nav keys `shell.027`…`038`; scheduler a11y (`role="grid"`, localized labels, `localDayKey`,
  LTR-forced month nav, dark-mode styles); server dates via `serverLocale()`+`fmtDate`
  (weekly report, certificate); shadcn `CalendarDayButton` ISO `data-day`.
- **Important files:** `src/lib/i18n*.ts`, `src/components/student/study-scheduler.tsx`,
  `src/app/api/students/me/study-plan/route.ts`, `docs/PHASE_9_CALENDAR_I18N.md`,
  `tests/calendar-i18n-phase9.test.js` (+440).
- **Status:** complete modulo sandbox-blocked live verification (Prisma engines unreachable in that
  sandbox; `prisma generate`/`next build`/Playwright must be re-run where reachable).
- **Limitations:** DB-seed residue stays Arabic under EN (pre-existing); full Playwright audit
  deferred; week-start Sunday (product choice).

### Phase 10 — Kodgy AI Assistant

- **Purpose:** deterministic, offline-capable assistant UI with a replaceable engine contract.
- **Implemented:** scripted response engine (`src/lib/kodgy/response-engine.ts`: AR-orthography
  normalization, phrase/keyword scoring over curated bilingual knowledge, `{intent, matched, score,
  answer}` contract); controller (`use-kodgy-chat.ts`); chat panel + robot + assistant shell;
  positioning (`src/lib/kodgy/position.ts`); **no network, no LLM, no DB**; user input never rendered
  as HTML.
- **Important files:** `src/lib/kodgy/*`, `src/components/kodgy/*`, `docs/PHASE_10_KODGY_ASSISTANT.md`,
  `tests/kodgy-phase10.test.js`, `tests/visual/run-kodgy-visual.mjs`.
- **DB/API impact:** none. **Tests:** Kodgy suite green.
- **Status:** complete and locally verified (per task brief). **Limitations:** scripted only; future
  real-AI work must stay behind the `KodgyResponse` contract (Planning Principle 9).

---

## Current Architecture

### Runtime shape

```text
Browser (single page `/`, zustand ViewKey router, RTL/LTR, dark/light)
   │  fetch /api/* only — no server-rendered portals, no /admin page routes
   ▼
Next.js 16 standalone server (:3000) behind Caddy reverse proxy
   │  src/proxy.ts — cookie-presence 401 for protected /api/* (defense in depth)
   ▼
API routes — requireUser/requireRole + per-route scope checks (source of truth)
   │  lib: auth · enrollment · session-progress · session-quiz · quiz-analytics
   │       parent-access · school-type · media · notify · progress · security
   ▼
Prisma 6.11 → SQLite file (db/custom.db) + private media dir (storage/media)
```

### Domain map (as actually wired — dead schema marked ☠)

```text
User (email×unique, scrypt, Role, AccountStatus)
 ├── Student (schoolType: free String! · groupId · batchId · studentCode× · nationalId×)
 │    ├── group ──▶ Group ──▶ Course        ◀── THE enrollment path (getEnrollment)
 │    ├── batch ──▶ Batch(schoolType enum, courseId?)  ◀── video distribution path
 │    ├── enrollments ──▶ Enrollment ☠ (zero references in src)
 │    ├── LessonProgress / QuizAttempt / ExamAttempt / HomeworkSubmission / SessionVideoView
 │    └── subscription ──▶ Subscription (informational only — NOT an access gate, by design)
 ├── Parent ──▶ ParentStudentLink ──▶ Student   (server-derived scope only)
 └── Teacher ──▶ Group[] (course scope = teacher.groups[].courseId)

Course (slug× · trackId? ☠ ──▶ Track ☠)
 └── Part ──▶ Unit ──┬──▶ Lesson (unitId — canonical; ~0 rows use it)
                     └──▶ Topic ──▶ Lesson (topicId — legacy; holds ALL seeded rows)

Lesson (isPublished=true · isLocked=false-inert · videoUrl? · pdfUrl? — raw strings)
 ├── Quiz ──▶ Question (quizId? · schoolType? — nullable; session flow ignores it)
 ├── Homework ──▶ HomeworkSubmission
 ├── Material ☠ (lessonId · kind · storageKey · mediaAssetId — zero references)
 └── SessionVideo (batchId · lessonId? · mediaAssetId · isPublished · publishedAt)
      └── MediaAsset (VIDEO|IMAGE|☠DOCUMENT · EXTERNAL_URL|LOCAL_PRIVATE|S3 · storageKey|externalUrl)
           └── served ONLY via GET /api/media/[id] (batch+published gate, Range support)

Notification (userId · type · title · message · link? — free text, client ignores it)
NotificationPreference (per-type flags incl. announcements; quiet hours; email/push)
```

### Sources of truth (verified)

| Concept | Source of truth | Notes |
|---|---|---|
| Identity/session | `UserSession` + `cm_session` cookie | SHA-256 token hash; legacy `Setting:session:*` migrated on read |
| Enrollment | `getEnrollment()` = active group → course | `Enrollment` model unused; subscription deliberately not a gate |
| Unlock/progression | `getCourseSessionProgress` + `canAccess*` | Dual-chain universe, deterministic order, redaction |
| Video completion | Heartbeat-credited `videoPercent/videoCompleted` | 95% threshold shared const |
| Quiz grading | `session-quiz.ts` + stored keys | Attempt-frozen `QuizAnswer` sets |
| Mock exam bank | `questionBankFilter(schoolType)` both directions | Null = shared |
| Batch video access | `SessionVideo(batchId, isPublished)` + `/api/media/[id]` | Batch lazily synced |
| Parent scope | `Parent.children` links only | No client-supplied ids honored |
| Curriculum contract | `docs/curriculum/knowledge-model.json` v2.0.0 | Authoritative but not yet in DB |
| Curriculum in DB | Synthetic `CURRICULUM` seed | Legacy content, Topic-linked |

---

## Curriculum Architecture Audit

### The three curriculum representations (and their status)

| # | Representation | Location | Content | Status |
|---|---|---|---|---|
| R1 | Synthetic seed | `src/lib/curriculum.ts` + `src/lib/curriculum-seed.ts` + `scripts/seed*.ts` | 2 parts, 7 units, ~17 topics, **36 lessons** (`What is IT?`, `UI vs UX`, …) | **LIVE in DB** — what students actually see |
| R2 | Knowledge model | `docs/curriculum/knowledge-model.json` (+ schema + validator `scripts/validate-curriculum-knowledge.py`) | 2 parts, 7 units, **23 lessons** (`1-1`…`7-3`), objectives, concepts, page refs, integrity block | **Validated contract, never reconciled into DB** |
| R3 | Source PDFs | `docs/curriculum/{arabic,english}/*.pdf` (4 files, SHA-pinned in R2) | Ministry 2026/2027 textbooks | Ground truth for R2 |

### Hierarchy support in schema vs in code

| Level | Schema | Code reality |
|---|---|---|
| Course | `Course` + `slug` | Full CRUD-lite (admin create + list); one live course `programming-ai-2nd-sec` |
| Part | `Part(courseId, order)` | Rendered + ordered; **no admin CRUD** |
| Unit/Chapter | `Unit(partId, order, icon)` | Rendered + ordered; **no admin CRUD** |
| Topic | `Topic(unitId, order)` | Legacy compat layer; holds all seeded lessons; **must not receive new semantics** (ADR-003) |
| Lesson/Session | `Lesson(topicId?, unitId?, officialCode?×, curriculumStatus, order, …)` | Dual-chain reads everywhere in P4+ code; **no admin CRUD**, no publish toggle UI |
| Track | `Track` + `Course.trackId?` + `Enrollment` | **☠ Zero references in `src/`** — schema only |

### Critical findings

1. **R1 ≠ required curriculum.** R1’s units happen to share the 7 chapter *names*, but its topics and
   36 lesson titles are placeholders unrelated to the required `1-1…7-3` sessions. Shipping R1 as
   “the curriculum” misrepresents the academic contract.
2. **R2 == required curriculum** (see § Required Curriculum Mapping) and even exceeds it (objectives,
   concepts, Kodgy grounding). The cheapest correct move is a **reconciliation migration R2 → DB**,
   not a rewrite.
3. **The admin “seed” action is a footgun:** `POST /api/admin/courses` with `{action:"seed"}` restores
   **R1** (`seedCurriculumFromFile`). After R2 reconciliation, this action must be removed or
   repointed, or an admin click resurrects the legacy curriculum.
4. **ADR-003 already decided the end state:** canonical hierarchy `Track → Course → Part → Unit →
   Lesson`; Topic retained only as nullable legacy; official lessons use `unitId` + `officialCode` +
   `curriculumStatus=OFFICIAL`; “a future migration must explicitly map only evidence-backed lessons
   and archive the rest.” That future migration is now the critical path (§ Phase 11).

---

## Required Curriculum Mapping

R2 (`knowledge-model.json`) vs the product requirement in §3 of the brief — verified lesson by lesson:

### Part One / الجزء الأول (P1 — 14 sessions)

| Required | R2 code | R2 EN title | R2 AR title | Status |
|---|---|---|---|---|
| Ch 1: IT and Society | `1` | Information Technology and Society | تكنولوجيا المعلومات والمجتمع | ✅ Exists |
| 1-1 | `1-1` | Development of Information Technology and Social Transformation | تطور تكنولوجيا المعلومات والتحول الاجتماعي | ✅ Exact |
| 1-2 | `1-2` | How AI Works | كيف يعمل الذكاء الاصطناعي | ✅ Exact |
| 1-3 | `1-3` | AI in Daily Life and Industry | الذكاء الاصطناعي في الحياة اليومية والصناعة | ✅ Exact |
| 1-4 | `1-4` | Ethical Issues with AI | القضايا الأخلاقية للذكاء الاصطناعي | ✅ Exact (EN “with AI” vs req “with AI” — same) |
| Ch 2: Cybersecurity | `2` | Cybersecurity | الأمن السيبراني | ✅ Exists |
| 2-1 | `2-1` | Cryptographic Technologies and Authentication | تقنيات التشفير والمصادقة | ✅ Exact |
| 2-2 | `2-2` | Network Security Design | تصميم أمن الشبكات | ✅ Exact |
| 2-3 | `2-3` | Incident Response and Risk Management | الاستجابة للحوادث وإدارة المخاطر | ✅ Exact |
| Ch 3: Web Applications | `3` | Web Applications | تطبيقات الويب | ✅ Exists |
| 3-1 | `3-1` | The Overall Structure of Web Applications | البنية العامة لتطبيقات الويب | ✅ Exact |
| 3-2 | `3-2` | Web Application Communication Methods | طرق الاتصال في تطبيقات الويب | ✅ Exact |
| 3-3 | `3-3` | Fundamentals of Frontend Technology | أساسيات تكنولوجيا الواجهة الأمامية | ✅ Exact |
| Ch 4: Web and Media Design | `4` | Web and Media Design | تصميم الويب والوسائط | ✅ Exists |
| 4-1 | `4-1` | Types and Characteristics of Media | أنواع الوسائط وخصائصها | ✅ Exact |
| 4-2 | `4-2` | Information Design and User Experience for Websites | تصميم المعلومات وتجربة المستخدم للمواقع | ✅ Exact |
| 4-3 | `4-3` | Methods for Evaluating Websites | أساليب تقييم المواقع الإلكترونية | ✅ Exact |
| 4-4 | `4-4` | The Iterative Improvement Process for Websites | عملية التحسين التكراري للمواقع | ✅ Exact |

### Part Two / الجزء الثاني (P2 — 9 sessions)

| Required | R2 code | R2 EN title | R2 AR title | Status |
|---|---|---|---|---|
| Ch 5: Data Collection and Cleaning | `5` | Data Collection and Cleaning | جمع البيانات وتنقيتها | ✅ Exists |
| 5-1 | `5-1` | Methods of Data Collection | طرق جمع البيانات | ✅ Exact |
| 5-2 | `5-2` | Data Cleaning and Transformation | تنقية البيانات وتحويلها | ✅ Exact |
| 5-3 | `5-3` | Open Data and APIs | البيانات المفتوحة وواجهات برمجة التطبيقات | ✅ Exact |
| Ch 6: Analysis and Communication | `6` | Analysis and Communication | التحليل والتواصل | ✅ Exists |
| 6-1 | `6-1` | Statistical Inference | الاستدلال الإحصائي | ✅ Exact |
| 6-2 | `6-2` | Use and Evaluation of Regression Analysis | استخدام تحليل الانحدار وتقييمه | ✅ Exact |
| 6-3 | `6-3` | Data Visualization and Communication | تصور البيانات والتواصل | ✅ Exact |
| Ch 7: ML and AI | `7` | Machine Learning and Artificial Intelligence | التعلم الآلي والذكاء الاصطناعي | ✅ Exists |
| 7-1 | `7-1` | The Basics of Machine Learning | أساسيات التعلم الآلي | ✅ Exact |
| 7-2 | `7-2` | Neural Networks and Deep Learning | الشبكات العصبية والتعلم العميق | ✅ Exact |
| 7-3 | `7-3` | Large Language Models (LLM) and Generative AI | نماذج اللغة الكبيرة (LLM) والذكاء الاصطناعي التوليدي | ✅ Exact |

### Mapping verdict

| Required level | Current (DB/R1) | Contract (R2) | Required action |
|---|---|---|---|
| Part One/Two | Exists (titles match) | Exists (`P1`/`P2`) | Reconcile: keep/verify 2 parts |
| Chapters 1–7 | Exists as Units (names match) | Exists (`1`…`7`) | Reconcile: keep/verify 7 units |
| Sessions 1-1…7-3 (23) | **Missing** (36 placeholders instead) | Exists with stable `lesson-<u>-<n>` ids + `code` | **Create 23 official lessons** (`unitId`, `officialCode=code`, `curriculumStatus=OFFICIAL`) |
| AR localization | Partial (dialect-flavored placeholders) | Full MSA titles + objectives | Adopt R2 titles |
| Topic layer | Holds all content | N/A (Part→Unit→Lesson) | Archive; no new semantics |
| Track split (AR vs LANG) | Missing everywhere | N/A (locale dimension, not structural) | Decide in Phase 12 (single course + track dimension recommended — see § Recommended Future Architecture) |

**Net:** the academic mapping is 100% complete on paper. The work is *mechanical reconciliation*,
not curriculum design. No lesson content needs authoring for the structure itself; per-session
materials (video/PDF/quiz/assignment) are the later phases.

---

## Arabic vs Language Track Analysis

### Where `schoolType` lives today

| Layer | Field | Type | Enforcement |
|---|---|---|---|
| Registration | `Student.schoolType` | **Free `String?`** (validated `ARABIC`/`LANGUAGE` at write, denormalized thereafter) | `normalizeSchoolType()` everywhere it is read |
| Batch | `Batch.schoolType` | Enum (required) | `@@unique([schoolType, courseId])`; lazy `syncStudentBatch()` |
| Question bank | `Question.schoolType`, `ExamQuestion.schoolType` | Nullable enum (`null` = shared) | `questionBankFilter()` in mock-exam selection **and** grading; admin bank views |
| Mock exam def | `MockExam.schoolType` | Enum (required) | Type must match student; course binding 404s cross-course |
| Session video | via `SessionVideo.batchId` | (indirect) | `batchId + isPublished` gate in list, progress, and `/api/media/[id]` |
| **Lesson / Quiz / Homework / PDF** | — | **No field at all** | **None — shared by construction** |
| Course | `Course.trackId?` → `Track` | ☠ Unused | None |
| Enrollment | `Enrollment(student, course, track)` | ☠ Unused | None |

### The guarantee test: `LANGUAGE student → LANGUAGE content`?

| Surface | Verdict | Evidence |
|---|---|---|
| Registration | ✅ Correct | Strict `ARABIC`/`LANGUAGE` validation; stored on `Student` |
| Batch videos | ✅ Correct | Own-batch + published only; `/api/media/[id]` re-checks |
| Mock exams | ✅ Correct | Bank filter both directions; out-of-bank ids score 0 |
| Course tree | ⚠️ Shared | Both tracks see identical lessons (no track dimension) |
| Lesson page | ❌ No isolation | `videoUrl`/`pdfUrl`/summary identical for both tracks |
| Session quiz | ❌ No isolation | All quiz-owned questions served; `schoolType` never filtered; teacher POST doesn’t even set it |
| Homework | ❌ No isolation | Same assignment object for both tracks |
| PDFs | ❌ No isolation + no protection | Raw `pdfUrl` string; no auth on the bytes |
| Notifications | ❌ No targeting | `all`/`students`/`group`/`user` only; no batch/track/schoolType target |
| Teacher views | ⚠️ Course-scoped, track-blind | No per-track split; `teacher/homework` GET is topic-chain-only (misses canonical lessons) |
| Parent views | ⚠️ Inherits student scope | Correct *for the linked child*, but track-blind like the student |
| Analytics | ⚠️ Track-blind | No `schoolType` split in quiz/exam aggregates |

### Cross-track leakage risks (ranked in § Critical Risks)

1. **Session-quiz bank tags are unenforced:** an admin *can* tag a `Question` `LANGUAGE`, but the
   session flow (`/quizzes/[id]`, `/start`, `/submit`) serves and grades it for ARABIC students too.
   The tag is a mock-exam-only concept wearing a shared-model costume.
2. **No lesson variants:** when track-specific videos/PDFs arrive, there is nowhere to put the
   “other track’s” bytes except a second lesson or a second `SessionVideo` — the model decision
   (Phase 12) must precede any upload work.
3. **`Student.schoolType` is a free string** while everything downstream is an enum — every read
   depends on `normalizeSchoolType()` never being skipped. A single missed normalization (or a
   legacy lowercase row) silently drops a student out of their batch (`syncStudentBatch` returns
   `null`) and out of mock exams (400 `api.210`).

---

## Course / Enrollment / Batch Analysis

### Three enrollment-adjacent systems, one wired

| System | Mechanics | Status |
|---|---|---|
| **Group enrollment** (live) | `Student.groupId → Group(courseId, isActive)`; `getEnrollment()`; capacity + `isActive` checks in `/api/enroll` | ✅ Sole access gate; well-tested |
| **Batch membership** (live, partial) | `Student.batchId → Batch(schoolType, courseId?)`; lazy sync; `updateMany` attach on batch create | ✅ Works for videos; ⚠️ attach-on-create only fills `batchId: null` rows (a student whose type was *corrected* keeps the old batch — no re-sync path) |
| **Track + Enrollment** (dead) | `Track`, `Course.trackId`, `Enrollment(student, course, track, status)` | ☠ Zero reads/writes in `src/`; migration exists, nothing else |

### Findings

1. **Do not introduce a second gate.** `Enrollment` must either *replace* group-derived access in one
   deliberate cutover (with a backfill) or be formally deprecated. Running both gates in parallel is
   the highest-probability source of “enrolled but locked / unenrolled but open” bugs.
2. **Subscription is informational by documented design** (`enrollment.ts` header). Turning it into a
   paywall later is a business decision with a precise insertion point (`canAccessCourse`) — and a
   precise blast radius (every lapsed student loses content). Not in scope for the content roadmap.
3. **Batch attach is sticky in the wrong direction:** `POST /api/admin/batches` backfills only
   `batchId: null`; `syncStudentBatch` overwrites unconditionally when a batch exists — so list/read
   paths *can* heal a stale batch, but only if the student hits a syncing endpoint. A single
   authoritative “reconcile batch on schoolType/group change” (PATCH student, enroll success) is missing.
4. **Groups are course-scoped but track-blind** — a group mixes ARABIC + LANGUAGE students. Any
   “notify this group” fan-out crosses tracks. Future targeting must be `(course × track)`, not group.

---

## Session Lifecycle Analysis

### Required states vs current states

| Required state | Current representation | Gap |
|---|---|---|
| **Prepared** (materials exist, students can’t access) | *SessionVideo*: `isPublished=false` ✅ (but lesson-quiz/homework have no draft flag) | ⚠️ Partial — only videos can be staged |
| **Published / Open** (eligible students may enter) | *SessionVideo*: `isPublished=true` ✅ · *Lesson*: `isPublished=true` ⚠️ (default true, no UI, means “visible”) | ⚠️ Two flags, two meanings, no ceremony |
| **In Progress** (student started) | `LessonProgress` row / open `QuizAttempt` / `SessionVideoView` | ✅ Exists (three parallel signals, uncombined) |
| **Completed** (requirements satisfied) | `SessionStatusRow.completed` (video ∧ quiz ∧ assignment) | ✅ Exists, server-computed |
| **Locked** (visible skeleton, no content) | `SessionStatusRow.unlocked=false` + API redaction ✅ | ✅ Exists — **but only for prerequisite locks** |

### The core defect: visibility ≠ availability is not modeled

`Lesson.isPublished=false` **removes the lesson from the universe** (`getCourseSessionProgress`,
prev/next, and effectively the tree): an unpublished lesson is *invisible*, not *locked*.
The product requirement is the opposite:

```text
REQUIRED:  unpublished session → VISIBLE skeleton (title/chapter/session) + locked content
CURRENT:   unpublished session → ABSENT (as if it never existed)
```

Consequences:

1. **“Unlock” and “publish” are conflated.** Today `isPublished` is doing three jobs: (a) admin
   staging flag, (b) tree-visibility flag, (c) progression-universe membership. Any “publish” action
   flips all three at once with no readiness check and no notification.
2. **`isLocked` cannot fill the gap.** It is inert legacy metadata (the seed sets it on every
   non-first lesson — enforcing it would deadlock the course, per PROJECT_STATE). It must be
   retired, not revived.
3. **No “scheduled / opens-at” concept** exists anywhere (no `opensAt`/`publishedAt` on Lesson;
   `SessionVideo.publishedAt` is set-on-publish only). If the business wants timed releases, that is
   a new field + a new gate clause.
4. **Minimum viable lifecycle** (recommended, Phase 13): keep one Lesson row per session and split
   the conflated flag into two orthogonal dimensions —
   `status: DRAFT | READY | PUBLISHED` (admin lifecycle) × progression `unlocked` (student position).
   Tree shows PUBLISHED skeletons to every enrolled student of the segment; content requires
   PUBLISHED **and** unlocked **and** segment match. DRAFT/READY lessons are admin-visible only.

---

## Video / PDF / Quiz / Assignment Architecture

### Video — two parallel systems (intentional, but must converge in UX)

| | Lesson video (`Lesson.videoUrl`) | Batch session video (`SessionVideo` + `MediaAsset`) |
|---|---|---|
| Storage | External URL string (YouTube embed in seed) | Uploaded private file **or** external URL, stored **once** |
| Protection | ❌ None — raw URL to any unlocked student | ✅ Published+batch gate + authorized `/api/media/[id]` (Range, `no-store`) |
| Progress | `LessonProgress` heartbeat (95%) | `SessionVideoView` heartbeat (per-video `requiredPercent`, default 95) |
| Progression | ✅ Gates unlock | ❌ Deliberately excluded (P4: no second system) |
| Admin UX | ❌ No upload/edit UI at all | ✅ `SessionVideosView`: upload/URL, lesson link, publish flip, viewers |
| Track-aware | ❌ Shared | ✅ Via batch |

**Verdict:** the batch system is the architecturally correct one (store-once, authorized serve,
publish flag). The lesson-URL field is the progression-relevant one. The roadmap must not merge
their *data* (that would fork progression) but must converge their *admin UX* (one “session video”
slot backed by `SessionVideo`, with progression optionally reading its completion — a deliberate,
tested cutover, not a silent coupling).

### PDF — effectively nonexistent

| Aspect | State |
|---|---|
| Field | `Lesson.pdfUrl: String?` — raw string, seeded as `"#"` on first lessons |
| Upload | ❌ No endpoint, no UI, no validation |
| Storage | ❌ No bytes anywhere (external link assumed) |
| Authorization | ❌ None on the bytes; the *string* is redacted for locked lessons but any unlocked student gets the raw URL |
| Reuse | ❌ No asset dedup; a “same PDF for 500 students” is 500 identical strings at best |
| Candidates for reuse | ✅ `MediaAsset(kind=DOCUMENT)` + `Material(lessonId, kind, mediaAssetId)` — both exist, both **zero-use** |

**Verdict:** implement PDFs as `Material(ADMIN_UPLOADED) → MediaAsset(DOCUMENT, LOCAL_PRIVATE)` +
authorized download route (same pattern as `/api/media/[id]` + `?download=` disposition), **not** as
a second `pdfUrl`-style string column. One asset per session is the right default (session-scoped
PDFs); cross-session reuse falls out free via `mediaAssetId` without extra modeling.

### Quiz — strong core, missing configuration surface

- ✅ Attempt freezing, server grading, idempotent start, evidence, analytics, bank tagging *fields*.
- ❌ No admin UI to attach/configure a session quiz (teacher route creates quiz+questions but sets no
  `schoolType`, no `order` discipline documented, no validation that options/answer align beyond
  length checks; `timeLimit` accepted but unenforced anywhere).
- ❌ Session flow ignores `schoolType` (see § Track Analysis).
- ❌ No “quiz required for readiness” rule — readiness doesn’t exist yet.

### Assignment — the thinnest surface

- ✅ Submission model + student submit + teacher grade + progression wiring all exist and are tested.
- ❌ **No creation endpoint**: `teacher/homework` is GET-only; grade is PATCH-only. Homework rows can
  only appear via seed/scripts. Admin “configure the assignment” is currently impossible via product UI.
- ❌ No file-upload submissions (`fileUrl` exists on the model, no upload path); text-only (`4000` chars).
- ❌ No track dimension; deadline is the only lifecycle field (no draft/scheduled).

---

## Admin Workflow Analysis

Ideal workflow vs reality, step by step:

| Step | Ideal | Current | Gap class |
|---|---|---|---|
| 1. Create curriculum | Parts/chapters/sessions CRUD | Course create only (`POST /api/admin/courses`); **no Part/Unit/Lesson CRUD**; “seed” action restores *legacy* R1 | ❌ Missing |
| 2. Create session | New lesson in a chapter | Only via DB/seed scripts | ❌ Missing |
| 3. Upload video | File → private store, linked to session | ✅ Exists but **batch-scoped** (`SessionVideosView`), optional lesson link, no “session requires video” | ⚠️ Partial |
| 4. Upload PDF | File → private store, linked to session | Nothing (raw `pdfUrl` string) | ❌ Missing |
| 5. Attach/configure quiz | Pick/create quiz, pass mark, questions | Teacher-only create (no schoolType, no admin UI) | ⚠️ Partial |
| 6. Configure assignment | Title/instructions/deadline/marks | **No create endpoint at all** | ❌ Missing |
| 7. Validate readiness | Checklist: video ✓ PDF ✓ quiz ✓ assignment ✓ | No readiness concept | ❌ Missing |
| 8. Open/publish | One action, segment-scoped | Bare `isPublished` flips (video; mock exam); lesson flag has no UI | ❌ Missing |
| 9. Notify students | Targeted (course × track × batch), deep-linked | Generic broadcast, no targeting, no deep links | ❌ Missing |
| 10. Student access | Segment + unlock + publish enforced | Enrollment + unlock enforced; publish conflated; segment unenforced for lessons | ⚠️ Partial |

Admin surfaces that **do** exist and are solid: students/teachers/groups/payments/subscriptions/
coupons/question-bank/mock-exams/session-videos/quiz-review/notifications-center/settings/overview.
The gap is precisely **curriculum + session lifecycle** — the two domains the product requirements
center on.

---

## Student Workflow Analysis

Desired journey vs implemented behavior:

| Step | Desired | Current | Match? |
|---|---|---|---|
| Register | AR/LANG + identity validation, code issued | ✅ Exact (`auth/[action]`, strict validators) | ✅ |
| Select track | ARABIC / LANGUAGE captured | ✅ Stored (free string — normalization debt) | ⚠️ |
| Subscribe to course | Plan → payment → group → approval | ✅ Full flow (pending → admin approve → active) | ✅ |
| See correct curriculum | Track-appropriate tree | ⚠️ Same tree for both tracks (content undifferentiated) | ❌ |
| See all sessions | Full skeleton, future locked | ⚠️ Only *published* lessons appear; unpublished are invisible, not locked | ❌ |
| Future sessions locked | Titles visible, content redacted | ✅ For prerequisite locks (redaction verified) | ✅ |
| Admin opens session | Targeted open | ❌ No open action; `isPublished` has no UI/notification | ❌ |
| Notification arrives | “New session” + deep link | ❌ No session events; notification list has no links | ❌ |
| Open session | Video + PDF + quiz + assignment | ⚠️ Video(lesson URL) + quiz + homework; **no PDF delivery**; batch videos live on a separate page | ❌ |
| Complete session | 95% + quiz + assignment → next unlocks | ✅ Exact, server-enforced, tamper-resistant | ✅ |
| Progression | Sequential, deadlock-free | ✅ (all known deadlocks fixed in P4/P5) | ✅ |

**Reality differs at exactly the product-requirement seams:** track differentiation, publish
visibility, PDFs, and notifications. The *engine* (register → enroll → unlock → complete) is
production-grade; the *content supply chain* feeding it is not.

---

## Notification Architecture

### Current inventory

| Piece | Implementation | Assessment |
|---|---|---|
| Model | `Notification(userId, type[12], title, message, isRead, link?, createdAt)` + `@@index([userId, isRead])` | Adequate shape; `link` is unvalidated free text |
| Create (single) | `createNotificationIfAllowed()` — checks `NotificationPreference` + quiet hours, then `create` | ✅ Correct preference enforcement |
| Create (bulk) | `createNotificationsIfAllowed()` — **sequential per-user loop** (N pref reads + N creates) | ⚠️ No batching; N+1 by construction; fine at tens, dangerous at thousands |
| Admin send | `POST /api/admin/notifications` — targets `all`/`students`/`parents`/`teachers`/`group`/`user`, `createMany` | ⚠️ No batch/track/course targeting; **ignores preferences entirely** (direct `createMany`, bypasses `notify.ts`) |
| Fan-out triggers | Enroll (admins), payments (approve/reject paths) | Sparse; **no session/quiz/homework lifecycle triggers** |
| Read path | `GET /api/notifications` (50, desc), `GET /unread-count`, POST mark-one/mark-all (self-scoped `updateMany`) | ✅ Correct scoping |
| Center (user) | `NotificationsView` in student-dashboard | ❌ **No link rendering, no click-through** — `link` is write-only data |
| Center (admin) | `GET /api/admin/notifications-center` + `NotificationsView` (filter, stats, pagination) | ✅ Adequate for audit |
| Types | 12-type enum; `NEW_LESSON` exists but is **never emitted** by any session flow | ⚠️ Dead type for the key use case |

### Required targeting model

Targeting must be **derived dynamically from eligibility, not stored per recipient**:

```text
publish(session S, segment G)  →  recipients = enrolled(course(S)) ∩ track(G) ∩ active
        │                                   (computed at publish time from Student rows)
        ▼
Notification rows (one per recipient — read/unread is inherently per-user)
 + link = canonical deep link `lesson:<lessonId>` (validated scheme, resolved client-side)
```

Concretely: keep per-user rows (unread state demands them) but compute the recipient set with a
single eligibility query (`schoolType × group.courseId × isActive`, chunked `createMany`, e.g.
500/statement), route it through preference checks in bulk (one `NotificationPreference.findMany`
for the recipient set, not N queries), and introduce a validated link scheme
(`lesson:<id> | video:<id> | quiz:<id> | homework:<id>`) that the client resolves via
`setView`+`setNavParam` — with every deep-linked fetch re-authorized server-side (already true for
lesson/quiz/homework routes; PDFs must join that club).

---

## Authorization & Security Analysis

### The 10-check session-access contract (required) vs today

For a future `GET lesson/session + resource` request:

| # | Check | Today | Reuse |
|---|---|---|---|
| 1 | Authenticated | ✅ `requireUser` + proxy | As-is |
| 2 | Is a student | ✅ Per-route role check | As-is |
| 3 | Enrolled | ✅ `getEnrollment` (active group → course) | As-is |
| 4 | Correct course | ✅ `courseId` equality in `canAccessLesson` | As-is |
| 5 | Correct track | ❌ No check (no track on session content) | **New** — needs the Phase 12 model decision first |
| 6 | Session ∈ course | ✅ Dual-chain resolution | As-is |
| 7 | Session open/published | ⚠️ `isPublished` filter only (invisible≠locked) | **Harden** — Phase 13 lifecycle |
| 8 | Prerequisites satisfied | ✅ Sequential unlock | As-is |
| 9 | Resource ∈ session | ✅ Quiz/homework resolve to owning lesson | Extend to PDF/video materials |
| 10 | Resource available to *this* student | ⚠️ True for quiz/homework; **false for PDFs** (raw URL), partial for videos | **New** — authorized download route |

### What is already strong (do not rebuild)

- Session/token handling (hashed tokens, throttled `lastSeenAt`, legacy migration, single-device
  with 30-min idle grace — safe against Wi-Fi flips and UA churn).
- Password discipline (scrypt, timing-safe compare), reset flow (hashed single-use tokens, rate
  limits, redacted destinations, email-only by design).
- `denyProgression` semantics (404 vs 403 + code, never a status row).
- Locked-session redaction (server-side, presence-flags-only).
- Heartbeat anti-tamper (wall-clock credit, monotonic, completion timestamp preserved).
- Bank isolation (both directions), mock-exam key hygiene, evidence admin-only + audited.
- Parent scope derivation (links-only, no client ids).
- Proxy defense-in-depth + security headers + secret fail-fast.

### Gaps to close (mapped to roadmap phases)

1. No track check on session content (Phase 12/13). 2. PDFs unauthenticated (Phase 14).
3. Admin broadcast bypasses preferences (Phase 17). 4. `Student.schoolType` free-string fragility
   (Phase 12: enum-ify or constrain + backfill). 5. Orphan-lesson accumulation via `SetNull`
   (Phase 11 cleanup). 6. No rate limit on heartbeat/progress/notification endpoints beyond auth
   (Phase 20). 7. No CSP (Phase 20, tested). 8. Teacher `homework` GET + student dashboard +
   `progress.ts` still legacy-chain-only (Phase 18/19 correctness sweep).

---

## API Inventory

~68 route files. Auth: `requireUser` (401) / `requireRole` (401/403) + proxy cookie check.
Conventions: `ok()`/`err()` shapes, `denyProgression` for gated content, `getServerT` messages.

### Content & learning (student-facing)

| Endpoint | AuthZ | Input validation | Notes |
|---|---|---|---|
| `GET /api/courses` | auth | — | Catalogue (enrollment-aware) |
| `GET /api/courses/[slug]` | student: enrollment+course; parent: linked-course; staff: all | slug | **Redacts locked sessions**; dual-chain; presence flags |
| `GET /api/lessons/[id]` | student: `canAccessLesson`; parent: 404-scope; staff: open | id | Touches `lastViewedAt`; `revealQuizAnswers`; prev/next via `orderCourseLessons` |
| `POST /api/lessons/[id]/progress` | student + gate | clamped 0–100; 95% rule enforced | Cannot bypass video rule |
| `POST /api/lessons/[id]/video-progress` | student + gate | `durationSec>0`; wall-clock credit | Monotonic, capped |
| `GET /api/quizzes/[id]` | student: `canAccessQuiz`; parent: 404-scope | id | Frozen set when open attempt; answers hidden pre-attempt |
| `POST /api/quizzes/[id]/start` | student + gate | `cameraStatus` allow-list | Idempotent resume; seeds frozen set |
| `POST /api/quizzes/[id]/submit` | student + gate | answers array; 16-char sanitize | Server grading; immutable finished |
| `POST /api/quizzes/[id]/evidence` | student + gate (open attempt) | snapshot size/type allow-list | IMAGE assets, retention, STATUS rows |
| `GET /api/students/me/homework` | student; unlocked-only list | — | ⚠️ Legacy-chain lesson filter (canonical lessons’ homework hidden) |
| `POST /api/students/me/homework` | student + `canAccessHomework` | 4000-char; graded immutable | Upsert on unique pair |
| `GET /api/students/me/session-videos` | student; own batch + published | — | `src` = URL or `/api/media/[id]` |
| `POST /api/students/me/session-videos/[id]/progress` | student; batch+published | heartbeat | Same anti-tamper as lessons |
| `GET /api/media/[id]` | video: batch+published (student) / staff; evidence: admin-only+audited; orphan: admin-only | id | Range support, `no-store`; parents denied |
| `GET /api/exams/mock` + `POST` | student; enrolled + typed | clamped count; answers capped 200 | Stateless draft, no key; bank-isolated grade |
| `GET /api/students/me/mock-exams` | student | — | Published, own-bank, own-course list |
| `GET /api/students/me/dashboard` | student (self) | — | ⚠️ Legacy-chain lesson query; gated continue/last-viewed |
| `GET /api/students/me/enrollment` | student (self) | — | Enrollment + subscription snapshot |
| Misc self APIs | student (self) | varies | bookmarks, notes, study-plan, gamification, leaderboard, referral, certificate, export-progress, notification-prefs |

### Admin content management

| Endpoint | Capability | Gap |
|---|---|---|
| `POST /api/admin/courses` (+GET) | Create course (display fields); **`{action:"seed"}` restores legacy R1** | No Part/Unit/Lesson CRUD; seed footgun |
| `GET/POST /api/admin/batches` | List + ensure `(schoolType, course)` batch; backfill `batchId:null` | No re-sync on type change; no deactivate cascade |
| `GET/POST /api/admin/session-videos`, `PATCH/DELETE /[id]` | Upload/URL publish, lesson link, publish flip, refcounted media delete | No readiness; no notify-on-publish |
| `GET/POST /api/admin/question-bank` | Bank views (AR/LANG/shared/all), create (schoolType optional) | No update/delete; session flow ignores tags |
| `GET/POST /api/admin/mock-exams`, `PATCH/DELETE /[id]` | Typed, course-bound, RANDOM/FIXED, publish | Solid; reuse as the publish-pattern template |
| `POST /api/admin/ai-generate-quiz` | Draft questions for a lesson | Drafts only; review before attach |
| `GET /api/admin/quiz-evidence` | Admin review of proctoring evidence | Solid |
| `POST /api/admin/notifications` (+GET) | Broadcast (all/students/parents/teachers/group/user) | **No batch/track/course targeting; bypasses prefs** |
| `GET /api/admin/notifications-center` | Audit list + stats + pagination | Solid |
| Students/teachers/groups/payments/subscriptions/coupons/settings/overview/export/revenue | Full operational CRUD | Solid; out of content-roadmap scope |

### Teacher

| Endpoint | Scope | Gap |
|---|---|---|
| `GET /api/teacher/lessons` | Own courses | ⚠️ **Topic-chain-only** — canonical lessons invisible to the quiz editor’s lesson picker |
| `GET/POST /api/teacher/quizzes` | Own courses, dual-chain lesson verify | POST sets **no `schoolType`** on questions; no update/delete |
| `GET /api/teacher/homework` | Own courses | ⚠️ Topic-chain-only; **no POST (cannot create homework)** |
| `PATCH /api/teacher/homework/[id]/grade` | Own courses (verify) | Grading only |
| `GET /api/teacher/analytics`, `/dashboard`, `/attendance`, `/templates*` | Own groups/courses | Solid; track-blind aggregates |

### Parent / auth / public

| Endpoint | Notes |
|---|---|
| `GET /api/parents/me/dashboard|analytics|weekly-report` | Links-only derivation; batched shared `progress.ts` reads |
| `POST /api/parents/me/link-student`, `GET notification-prefs` (stub: 2-line route) | Link by code+identity; prefs route is a stub |
| `POST /api/auth/login|register|logout`, `GET /api/auth/me` | Hardened (P1/P3); single-device; detailed `me` reasons |
| `POST /api/auth/password-reset/*` | Hashed tokens, rate-limited, email-only |
| `GET /api/groups` (public) | Minimal picker fields (P3 leak fixed) |
| `GET /api/subscription-plans`, `/api/settings/public`, `GET /api` | Public catalogue/brand/health |
| `POST /api/enroll`, `POST /api/coupons/validate` | Transactional enroll (sub+payment+group+coupon+admin notify) |

### Future endpoints needed (do not implement yet)

`POST /api/admin/lessons` (+ PATCH publish/status, DELETE/archive) · `POST /api/admin/lessons/[id]/materials`
(PDF upload → Material+MediaAsset) · `GET /api/materials/[id]` (authorized download, `?download=1`) ·
`GET /api/admin/lessons/[id]/readiness` · `POST /api/admin/lessons/[id]/open` (publish + targeted notify,
idempotent) · `POST /api/admin/notifications/targeted` (course × track × batch, chunked, prefs-aware) ·
`POST /api/teacher/homework` (create) · notification `link` scheme validation (shared lib).

---

## Database Analysis

### Schema health (verified `schema.prisma` + all 4 migrations)

- **Migrations are exemplary:** additive-only, SQLite-safe (`ADD COLUMN` nullable/constant-default),
  `IF NOT EXISTS` guards, documented backfills, no DROP/DELETE of user data; the P5 dedup keeps
  `MAX(rowid)` per pair. `tests/migration-sql.test.js` + `platform-upgrade-2026-migration.test.js`
  pin the SQL.
- **Indexes:** good coverage on hot paths (`[userId, isRead]`, `[batchId, isPublished]`,
  `[schoolType, isPublished]`, `[studentId, lessonId]×`, `[attemptId, questionId]×`, token hashes,
  rate-limit buckets). Missing: `Lesson(isPublished, …)` composite for universe queries (currently
  filter + OR across relations — fine at 10² lessons, revisit at 10⁴), `Notification(createdAt)`
  for admin audit pagination (relies on default ordering scan).
- **Uniqueness:** correct invariants (`studentCode`, `nationalId`, attempt-answer pair,
  homework pair, batch per type+course, mock-exam pins, coupon redemption, referral pair).
- **Cascades:** mostly correct; two deliberate-but-sharp edges: (a) `Lesson.unit/topic onDelete:
  SetNull` orphans lessons on Part/Unit/Topic delete (17 orphans observed) — needs the Phase 11
  cleanup + future `Restrict`-or-archive policy; (b) `MockExamQuestion → Question CASCADE` deletes
  pins when a question is deleted (documented; FIXED exams silently shrink — admin UX must surface
  pin counts, Phase 15).
- **Portability:** no SQLite-specific types/functions; `String` JSON blobs; `DateTime` → `TIMESTAMP`;
  provider swap is mechanical (§11 of DATABASE_GUIDE). JSON-in-`String` (`options`, `answers`)
  is unqueryable by design — acceptable, do not “fix” with a JSON type during the Postgres move.

### Change-impact classification for the roadmap

| Requirement | Verdict | Change |
|---|---|---|
| Official 23-lesson curriculum in DB | **No schema change** | Data reconciliation via `unitId`+`officialCode`+`curriculumStatus` (all exist) |
| Track-specific session content | **Small additive** | Decision-gated: either `Lesson.schoolType?` (+ index) or lesson-variant rows; either way 1 field or 0 |
| Session lifecycle (draft/ready/published) | **Small additive** | `Lesson.status` enum (default maps current `isPublished`) **or** reuse `isPublished` + computed readiness — recommend the enum (1 field, 1 index) |
| PDF per session | **No schema change** | Reuse `Material` + `MediaAsset(DOCUMENT, LOCAL_PRIVATE)` (both exist, unused) |
| Publish + notify | **No schema change** | Uses `Notification` + new targeting query; optional `SessionPublication` log table (recommended, 1 table — idempotent opens, audit) |
| Homework creation | **No schema change** | Missing endpoint only |
| Quiz schoolType enforcement | **No schema change** | Filter + write-path tagging |
| Timed releases (`opensAt`) | **Small additive** | 1 nullable field + gate clause (only if business confirms) |
| `Student.schoolType` hardening | **Small additive** | Constrain to enum w/ backfill via `normalizeSchoolType` (risk: legacy rows — audit first) |
| `Enrollment` cutover | **No schema change** | Backfill + gate swap **or** formal deprecation (decision in Phase 12; no third state) |
| Postgres + media volumes | **Ops, not schema** | Provider swap + data move + storage mount + backup cron |

**Net: zero redesigns, ≤3 small additive migrations, one optional log table.** The schema is ready;
the code is not.

---

## Legacy / Duplication Analysis

| Pair | Source of truth | Legacy / compat | Recommendation |
|---|---|---|---|
| `Topic` vs direct `Lesson.unitId` | **`Lesson.unitId`** (canonical; ADR-003; P4 engine) | `Topic` holds all seeded rows | **Preserve reads, archive rows in P11, forbid new Topic semantics**; fix the 4 topic-chain-only queries (teacher/lessons, teacher/homework GET, student dashboard, `progress.ts`) |
| `Session` vs `Lesson` | **`Lesson`** = async session content | `LiveSession` = group calendar event (meeting URL, attendance) | **Preserve both** — different domains; never merge; rename in UI copy only (“Session” = Lesson, “Live class” = LiveSession) |
| `Enrollment` vs group-derived access | **Group-derived** (`getEnrollment`) | `Enrollment` model: schema-only | **Decide in P12: cut over or deprecate** — no parallel gates |
| `Track`/`Course.trackId` vs `schoolType` string | **`schoolType`** (live, normalized) | `Track`: schema-only | **Decide in P12** together with Enrollment; likely: keep `schoolType` as the student dimension, use `Track` only if multi-course-per-track arrives |
| `Batch` vs `Group` | **Both, different axes:** Group = course × schedule (enrollment); Batch = course × schoolType (distribution) | — | **Preserve**; document the axes; targeting = Group ∩ Batch, never Group alone |
| `MediaAsset` vs `videoUrl`/`pdfUrl` strings | **`MediaAsset`** (authorized, deduped) | URL strings on Lesson | **Migrate**: new uploads → MediaAsset; keep string fields as legacy/external-URL carriers with a sunset plan |
| `SessionVideo` vs lesson video | Split by design (distribution vs progression) | — | **Preserve split**; converge admin UX; optional completion-bridge only via tested cutover |
| `Material` vs `pdfUrl` | **`Material`** (designed, unused) | `pdfUrl` string | **Adopt Material** for PDFs (P14); leave `pdfUrl` read-only legacy |
| `publish` vs `unlock` | **`unlocked`** (computed, student position) | `isPublished` (conflated admin flag) | **Split** into lifecycle status × unlock (P13); retire `isLocked` |
| `Question` vs `ExamQuestion` | **`Question`** (canonical bank; ADR-003) | `ExamQuestion` (legacy compat, still sampled by mocks) | **Preserve**; all new questions → `Question`; do not merge banks mid-roadmap |
| `QuizAttempt` vs `ExamAttempt` | Split by design (session vs mock) | — | **Preserve**; never cross-write (P8 boundary) |
| `Setting:session:*` vs `UserSession` | **`UserSession`** | Setting-row hack, migrated on read | **Preserve migrator** one more release cycle, then delete the fallback (P20) |
| R1 seed vs R2 knowledge model | **R2** (validated contract) | R1 (live data) | **Reconcile R2→DB, archive R1, kill the seed action** (P11) |

---

## Current Gaps

### Categorized gap list (each mapped to a future phase)

**G1. Curriculum data (→ P11)**
- Official 23-lesson structure absent from DB; 36 placeholder lessons live; `officialCode`/
  `curriculumStatus` unset everywhere; 17 orphaned lessons; admin “seed” restores legacy R1.

**G2. Track model (→ P12)**
- No track dimension on session content; `Track`/`Enrollment`/`Course.trackId` dead schema;
  `Student.schoolType` free-string; teacher quiz POST untagged; session-quiz ignores bank tags;
  batch re-sync missing on type/group change; analytics track-blind.

**G3. Session lifecycle (→ P13)**
- Publish≡visibility conflation; no DRAFT/READY states; no readiness rules; no `opensAt`;
  `isLocked` inert; unpublished = invisible (violates visibility-vs-availability).

**G4. PDFs/materials (→ P14)**
- No upload/storage/auth/download for PDFs; `Material` + `DOCUMENT` unused; `pdfUrl` raw strings
  (seeded `"#"`); no per-session asset API; no download disposition control.

**G5. Admin publishing UX (→ P15)**
- No lesson CRUD; no session detail (video+PDF+quiz+assignment in one screen); no readiness
  checklist; no open/publish action; no pin-count surfacing for FIXED exams; no homework creation.

**G6. Student access UX (→ P16)**
- No locked-but-visible unpublished skeletons; batch videos on a separate page from the lesson;
  no deep-link handling (`setNavParam` exists, nothing routes notification links into it).

**G7. Notifications (→ P17)**
- No batch/track/course targeting; admin broadcast bypasses prefs; sequential fan-out loop;
  `NEW_LESSON` never emitted; `link` unvalidated and unrendered; parent notification-prefs route stub.

**G8. Teacher workflow (→ P18)**
- No homework creation endpoint; topic-chain-only lesson/homework queries hide canonical content;
  no question edit/delete; `timeLimit` unenforced; no track-split analytics.

**G9. Parent/analytics alignment (→ P19)**
- Parent tree inherits track-blindness; weekly/monthly reports predate official curriculum;
  `progress.ts` legacy-chain-only (canonical video lessons invisible to shared progress).

**G10. Security hardening II (→ P20)**
- 10-check contract items #5/#7(partial)/#10(PDF) open; heartbeat/progress endpoints un-rate-limited;
  no CSP; legacy session fallback still live; direct-URL guessing surface for future PDFs.

**G11. Production data layer (→ P21)**
- SQLite file on local disk; no backup cron verified; media under `storage/` on ephemeral disk;
  Postgres move planned-only; `setup-production.ts` predates new models (cleans quiz/homework/users
  but not batches/videos/mock-exams/enrollments/materials — must be updated before go-live).

**G12. Integration & go-live (→ P22)**
- No curriculum-seed strategy for prod (R2 reconcile vs R1 seed); no publish-runbook; no load
  rehearsal for publish fan-out; no rollback plan for lifecycle migration.

---

## Critical Risks

| # | Risk | Severity | Blast radius | Mitigation (phase) |
|---|---|---|---|---|
| R1 | Track-undifferentiated session content ships as “track-specific” (wrong-curriculum delivery) | **Critical** | All students, academic correctness | P12 model + enforcement before any content upload |
| R2 | Premature session access via publish≡visibility confusion (admin thinks “saved” means “staged”) | **Critical** | Content leakage, exam integrity | P13 lifecycle split; default-DRAFT for new lessons |
| R3 | Direct PDF URL access (unprotected bytes, shareable links) | **Critical** | IP leakage, subscription bypass | P14 authorized download; never raw URLs for new PDFs |
| R4 | Quiz bank-tag bypass (tagged questions served cross-track in session flow) | **High** | Assessment fairness | P12/P13: filter-or-forbid tags in session flow |
| R5 | Notification mistargeting (group broadcast crosses tracks; prefs bypassed) | **High** | Wrong students notified / spammed; quiet-hours violations | P17 targeting + prefs-aware fan-out |
| R6 | Curriculum duplication (R1 + R2 rows coexist; progression universe doubles lessons) | **High** | Broken ordering, double gating, analytics skew | P11 reconcile-then-archive in one migration; kill seed action |
| R7 | Legacy-chain-only queries hide canonical content (teacher picker, homework list, dashboard, shared progress) | **High** | Deadlocks, invisible assignments, wrong reports | P18/P19 chain sweep (4 known sites + grep audit) |
| R8 | `Student.schoolType` free-string drift (missed normalization → batch/exam dropout) | **High** | Silent loss of videos/exams for affected students | P12 enum-ify + backfill + write-path constraint |
| R9 | Large publish fan-out without chunking/backpressure (timeouts, partial delivery) | **Medium** | Publish action fails midway; some students uninformed | P17 chunked `createMany` + idempotent `SessionPublication` log |
| R10 | N+1 / full-table scans in new admin screens (materials × lessons × students) | **Medium** | Admin latency at scale | Per-phase query budgets; reuse batched `progress.ts` patterns |
| R11 | Media storage growth on ephemeral disk (uploads + evidence, no retention job) | **Medium** | Disk full; evidence over-retained (privacy) | P21 volume + `retainUntil` cleanup job (evidence) + quotas |
| R12 | Stale `batchId` after schoolType/group correction | **Medium** | Student keeps old batch’s videos | P12 reconcile-on-change hook |
| R13 | FIXED mock-exam shrinkage via question-delete cascade | **Medium** | Exams silently lose pins | P15 pin-count surfacing + delete guard |
| R14 | Parent/teacher scope drift as new content APIs arrive (new routes forget `parent-access`/course-scope) | **Medium** | Cross-course visibility | P20 authorization-invariant test sweep (`tests/authorization-invariants.test.js` pattern) |
| R15 | SQLite concurrency under publish + heartbeat write bursts | **Low→Medium** | `SQLITE_BUSY` on fan-out | P21 Postgres move; short-term: chunked writes, short transactions |
| R16 | `localStorage` theme/locale desync across tabs; stale zustand `view` after role change | **Low** | Cosmetic / wrong-landing-view | Already partly guarded in `app-shell`; P22 polish |
| R17 | Kodgy grounding drift (scripted answers vs new official curriculum) | **Low** | Wrong study guidance | P19/P22: re-ground `kodgyGrounding` from R2 (no engine change) |

---

## Recommended Future Architecture

### Principles applied (from §29 of the brief)

P1 reuse over duplication · P2 build on the P4/P5 engines · P3/P4 visibility ≠ authorization ≠
availability · P5 publish ≠ unlock · P6 server-side auth on every resource · P7 server-side track
isolation · P8 cohort operations, never per-student setup · P9 Kodgy contract untouched · P10 every
phase has a completion contract (see each phase’s “Completion criteria”).

### Target domain (delta from today — new/changed marked ★)

```text
Student(schoolType: ★enum) ──group──▶ Course ◀── THE course (single, shared)
   │                         ├── Part ──▶ Unit ──▶ ★Lesson ×23 OFFICIAL
   │                         │                     ├── officialCode × (1-1…7-3)
   │                         │                     ├── ★status: DRAFT|READY|PUBLISHED (+ ★opensAt?)
   │                         │                     ├── ★trackScope: SHARED|ARABIC|LANGUAGE (★decision P12)
   │                         │                     ├── Video: SessionVideo(batch × trackScope) [progression-bridged ★optional]
   │                         │                     ├── ★PDF: Material(ADMIN_UPLOADED) → MediaAsset(DOCUMENT, LOCAL_PRIVATE)
   │                         │                     ├── Quiz (questions ★tagged + filtered by trackScope)
   │                         │                     └── Homework (★creatable; ★trackScope-aware)
   │                         └── ★SessionPublication(session, segment, publishedAt, notifiedCount) [idempotency log]
   └──batch──▶ Batch(schoolType)  [unchanged mechanics + ★reconcile-on-change]

Eligibility(segment) = enrolled(course) ∩ trackMatch(trackScope) ∩ active
Access(resource)    = eligible ∩ PUBLISHED(+opensAt) ∩ unlocked(prereqs) ∩ resource∈session
Visibility(tree)    = eligible ∩ PUBLISHED skeletons (+ locked content redaction — existing)
```

### Key decisions (recommended; P11/P12 ratify or amend with written justification)

1. **Single shared course, track as a content dimension — NOT course copies.** The 23-session
   structure is identical for both tracks (only locale differs, and lessons are already bilingual
   `title/titleAr`). Duplicating the course would fork progression, analytics, and every future
   migration. Track-specific *materials* attach beneath the shared skeleton.
2. **`Lesson.status` enum over boolean surgery.** `DRAFT` (admin-only) → `READY` (staged, validated)
   → `PUBLISHED` (visible per rules). One field, one index, backfilled from `isPublished`.
3. **PDFs = `Material` + `MediaAsset(DOCUMENT)`**, exactly as Phase 3 designed. No new tables.
4. **Keep group-derived enrollment as the gate** unless P12 proves otherwise; `Enrollment`/`Track`
   get a binary verdict (adopt-with-backfill or deprecate-with-removal-plan), never a third state.
5. **Publish = status flip + eligibility-derived fan-out + log row**, idempotent on
   `(lessonId, segment)` so retries never double-notify.

---

## Master Phase Roadmap

> Numbering continues the current cycle (Phase 11+) — justified because (a) Phases 1–10 are the
> same cycle’s hardening/learning track with docs, tests, and baselines attached to those numbers,
> (b) the remaining work is the same cycle’s unfinished *content half*, and (c) minting a third
> scheme would collide with both existing schemes (§ Current Baseline). Each phase is
> dependency-ordered, single-responsibility, and carries a measurable completion contract.

### Phase 11 — Official Curriculum Reconciliation

- **Objective:** replace the synthetic R1 rows with the R2-official 23-lesson structure in the DB.
- **Why here:** everything downstream (lifecycle, PDFs, targeting, analytics) keys off stable
  official lessons; reconciling first prevents building on placeholder ids.
- **Gaps:** G1. **Scope:** R2→DB reconciliation migration (create/verify 2 parts + 7 units; create
  23 lessons with `unitId`, `officialCode`, `curriculumStatus=OFFICIAL`, `status=DRAFT` if P13’s field
  lands here as a pre-additive — otherwise `isPublished=false` staging + follow-up flip);
  archive R1 lessons (`ARCHIVED`, excluded from universe); delete/garbage-collect the 17 orphans;
  remove or repoint the admin `{action:"seed"}` R1 path; update `seed.ts`/docs.
- **Files:** `prisma/migrations/20260*/` (new), `scripts/reconcile-curriculum.*` (new),
  `src/app/api/admin/courses/route.ts`, `scripts/seed*.ts`, `src/lib/curriculum*.ts` (deprecate),
  `docs/PROJECT_STATE.md`.
- **DB:** data migration only (+ optional P13 field pre-add). **API:** seed-action removal.
  **Admin:** curriculum now shows official titles. **Student/Teacher/Parent:** tree titles change to
  official (bilingual). **Security:** archived rows must stay invisible (universe filter).
  **i18n:** adopt R2 MSA titles. **Tests:** reconcile idempotency, universe membership (23 only),
  ordering (`orderCourseLessons`), archive invisibility. **Deps:** none.
- **Completion:** DB contains exactly the R2 structure; progression universe = 23 official lessons;
  R1 unseedable; 0 orphans.

### Phase 12 — Track Architecture & Enforcement

- **Objective:** make `LANGUAGE → LANGUAGE / ARABIC → ARABIC` structurally true for session content.
- **Why here:** the content-dimension decision gates every material/lifecycle/notification design.
- **Gaps:** G2. **Scope:** ratify single-course + `trackScope` dimension (or justify course-per-track);
  constrain `Student.schoolType` (enum + backfill via `normalizeSchoolType` + audit of legacy rows);
  add `trackScope` to Lesson/Quiz/Homework/SessionVideo-link (nullable, default SHARED, indexed);
  verdict + execution for `Track`/`Enrollment` (adopt-with-backfill or deprecate);
  tag teacher-created questions (`schoolType` write path); session-quiz bank filter-or-forbid rule;
  batch reconcile-on-change (PATCH student, enroll success, admin type correction); track-split
  reporting primitives.
- **Files:** `prisma/schema.prisma` + migration, `src/lib/school-type.ts`, `src/lib/enrollment.ts`,
  `src/app/api/teacher/quizzes/route.ts`, `src/app/api/admin/students/*`, `src/app/api/enroll/route.ts`,
  `src/lib/session-quiz.ts` (filter), `src/lib/quiz-analytics.ts` (split helpers).
- **DB:** small additive (≤3 fields + enum constraint + backfill). **API:** tagging + reconcile hooks.
  **Security:** closes contract check #5 (design) — enforcement lands in P13/P14/P16. **Tests:**
  cross-track matrix (AR/LANG × shared/typed × lesson/quiz/video), backfill correctness, batch healing.
- **Completion:** guarantee table (§ Track Analysis) reads ✅ for lessons/quizzes/homework at the
  model layer; 0 free-string reads bypassing normalization.

### Phase 13 — Session Lifecycle & Publishing Core

- **Objective:** split publish from unlock; introduce readiness; make “open” a server ceremony.
- **Why here:** lifecycle is the precondition for PDFs (attach-to-staged), admin UX, visibility
  rules, and notifications.
- **Gaps:** G3. **Scope:** `Lesson.status` (DRAFT/READY/PUBLISHED) + optional `opensAt` (only if
  business confirms timed release); readiness computation (video?/PDF?/quiz?/assignment? per
  trackScope — pure, tested); `POST /api/admin/lessons/[id]/open` (validate readiness → flip →
  write `SessionPublication` log → enqueue fan-out; idempotent); universe = PUBLISHED(+opensAt) for
  students, all-status for admin; retire `isLocked` (stop writing; ignore in reads; later drop).
- **Files:** schema + migration, `src/lib/session-lifecycle.ts` (new), `src/lib/session-progress.ts`
  (universe filter), `src/app/api/admin/lessons/*` (new), `src/app/api/courses/[slug]/route.ts`,
  `src/app/api/lessons/[id]/route.ts`.
- **DB:** 1–2 fields + 1 log table. **API:** open endpoint + readiness endpoint. **Security:**
  closes checks #7/#8 interplay; open requires ADMIN + readiness-ok (or explicit override w/ audit).
  **Tests:** state machine (illegal transitions rejected), readiness matrix, idempotent open,
  invisible-DRAFT / locked-PUBLISHED distinction.
- **Completion:** an admin can stage → validate → open a session via API with zero student-visible
  change until open; DRAFT never leaks through any student route (fuzz-tested ids).

### Phase 14 — PDF & Session Materials

- **Objective:** session-scoped PDFs with store-once bytes and authorized downloads.
- **Why here:** first material type on the new lifecycle; proves the `Material` reuse pattern.
- **Gaps:** G4. **Scope:** `POST /api/admin/lessons/[id]/materials` (multipart PDF: MIME allow-list
  `application/pdf`, size cap env, magic-byte sniff, private `writePrivateFile`, `Material`
  ADMIN_UPLOADED → `MediaAsset(DOCUMENT, LOCAL_PRIVATE)`); `GET /api/materials/[id]` (10-check
  contract incl. trackScope + PUBLISHED + unlocked; `Content-Disposition` inline vs `?download=1`;
  `no-store`); replace `pdfUrl` in student payloads with material descriptors (keep `pdfUrl`
  read-only legacy, never written for new uploads); per-(lesson,trackScope) uniqueness; admin
  replace/deactivate (refcounted asset delete, same as session-video DELETE).
- **Files:** `src/lib/media.ts` (PDF validators), new routes, `src/app/api/courses/[slug]/route.ts`
  + `lessons/[id]` (payload swap), `src/components/course/*` (render path — P16 wires UI).
- **DB:** none (reuse). **Security:** closes check #10 for PDFs; MIME/extension/traversal hardening;
  upload rate limits. **Tests:** upload validation matrix, cross-track/cross-course/locked download
  denials, refcount delete, legacy-`pdfUrl` coexistence.
- **Completion:** PDF bytes unreachable except via authorized route; zero new `pdfUrl` writes.

### Phase 15 — Admin Publishing Workflow UI

- **Objective:** one session screen: stage materials → checklist → open → confirm notify.
- **Why here:** API exists (P13/P14); admins need the ceremony, not curl.
- **Gaps:** G5. **Scope:** `admin-lessons` view: lesson CRUD-lite (create DRAFT under chapter,
  edit titles/order/trackScope, archive), session detail (video slot via SessionVideo link/upload,
  PDF slot via P14, quiz attach via teacher flow shortcut, assignment create — needs P18’s endpoint
  or a minimal admin create here), readiness checklist (live from P13), Open button (confirm modal
  showing segment + recipient count + idempotency state), publication history; FIXED-exam pin counts
  + delete guard; remove legacy seed UI.
- **Files:** `src/components/admin/*` (new view), `src/lib/store.ts` (ViewKey), admin lesson APIs
  (CRUD-lite additions), `src/components/admin/mock-exams-view.tsx` (pins).
- **Security:** admin-only; recipient-count query must equal fan-out query (shared helper).
  **i18n:** full AR/EN. **Tests:** component + API contract tests; open-confirm shows exact counts.
- **Completion:** an admin completes stage→open→notified for a session without touching DB/scripts;
  usability pass with a real admin account on staging.

### Phase 16 — Student Locked Curriculum & Session Access

- **Objective:** full visible skeleton, locked content, deep-linkable sessions, unified lesson page.
- **Why here:** consumes P12–P15; must precede notification deep links (P17).
- **Gaps:** G6. **Scope:** tree shows all PUBLISHED skeletons per segment (unpublished invisible to
  students, DRAFT admin-only); locked sessions render title/chapter/material-badges with existing
  redaction extended to materials; lesson page unifies lesson video + batch video + PDF download +
  quiz + assignment (single “session” mental model; batch-videos page becomes an index, not a
  silo); `link`-scheme router (`lesson:<id>` etc. → `setView`+`setNavParam`) with server re-auth
  on every fetch (already true — verify, don’t rebuild).
- **Files:** `src/components/course/*`, `src/components/dashboard/shell.tsx`,
  `src/app/api/courses/[slug]/route.ts` (skeleton payload), `src/lib/store.ts`.
- **Security:** redaction extended to material descriptors/URLs; deep links never bypass gates.
  **i18n/RTL/mobile:** full pass. **Tests:** skeleton-vs-content matrix per status × track × unlock;
  deep-link auth re-checks; RTL/mobile snapshots.
- **Completion:** a student sees the whole official curriculum, opens only eligible sessions, and
  every session page shows exactly its segment’s materials.

### Phase 17 — Session Notifications

- **Objective:** targeted, preference-aware, deep-linked publish notifications.
- **Why here:** needs segments (P12), open ceremony (P13/P15), deep links (P16).
- **Gaps:** G7. **Scope:** eligibility query helper (course × trackScope × active — shared with P15
  counts); chunked prefs-aware fan-out (bulk pref fetch + chunked `createMany` + `SessionPublication`
  counts); `NEW_LESSON` emission on open (title/message templates AR/EN with chapter + session +
  `lesson:<id>` link); link-scheme validation (shared lib, server + client); admin broadcast
  prefs-compliance fix; parent notification-prefs route completion; quiet-hours semantics review.
- **Files:** `src/lib/notify.ts` (bulk path), `src/lib/notification-links.ts` (new),
  `src/app/api/admin/notifications/*`, open endpoint (emit), `NotificationsView` (render + navigate).
- **Security:** targeting correctness is a privacy property — mistarget = cross-track leak; fan-out
  must be transactional-per-chunk with resume from the log row. **Tests:** targeting matrix,
  prefs/quiet-hours compliance, idempotent retry (no double rows), link validation fuzz.
- **Completion:** opening a session notifies exactly the eligible segment; each notification
  deep-links; no prefs bypass anywhere.

### Phase 18 — Teacher Workflow Completion

- **Objective:** teachers can fully configure sessions’ assessments on canonical content.
- **Why here:** after the model settles (P12/P13); before parent/analytics alignment (P19).
- **Gaps:** G8. **Scope:** `POST /api/teacher/homework` (create under own-course lesson, validated);
  question edit/delete (with FIXED-pin + open-attempt guards); dual-chain fix for
  `teacher/lessons` + `teacher/homework` GET; `schoolType` tagging in teacher quiz UI + API;
  `timeLimit` verdict (enforce server-side or remove from the contract); track-split teacher
  analytics views.
- **Files:** teacher routes + `teacher-dashboard.tsx` (quiz editor, homework manager).
- **Security:** own-course verification on every write (existing pattern). **Tests:** write-scope
  matrix, chain-coverage (canonical-only fixtures), pin/attempt guards.
- **Completion:** a teacher authors a complete session assessment set on official lessons with zero
  admin/DB assistance.

### Phase 19 — Parent & Analytics Alignment

- **Objective:** every report reflects the official curriculum and track reality.
- **Why here:** consumes P11/P12/P16/P18; last functional phase before hardening.
- **Gaps:** G9. **Scope:** `progress.ts` dual-chain fix (shared video progress); student dashboard
  chain fix; parent dashboard/reports re-verified on official lessons + trackScope; track-split
  aggregates where the product wants them; Kodgy re-grounding data review (answers reference real
  `1-1…7-3` sessions — engine untouched per Principle 9).
- **Files:** `src/lib/progress.ts`, student/parent dashboards + reports, analytics routes.
- **Tests:** chain-parity fixtures (canonical-only course reports correctly everywhere); parent
  isolation re-run; Kodgy grounding spot-checks.
- **Completion:** dashboards, weekly/monthly reports, and analytics agree on official-lesson data.

### Phase 20 — Security Hardening II

- **Objective:** close the content-scope residual risks; prove the 10-check contract.
- **Why here:** after all functional surfaces exist — hardening last is measurable.
- **Gaps:** G10. **Scope:** 10-check contract test sweep (every content route × 10 checks);
  rate limits on heartbeat/progress/notify/open/material-download; tested CSP rollout;
  legacy `Setting:session:*` fallback removal; admin broadcast audit; upload antivirus/clamav
  decision (at minimum: MIME+magic+size+name hardening review); secrets/headers re-audit.
- **Files:** routes (limits), `proxy.ts`/headers, `security.ts`, tests.
- **Tests:** IDOR/cross-track/cross-course/premature-access/PDF-guess/link-bypass matrices;
  rate-limit behavior; CSP violation-free pass.
- **Completion:** contract matrix green; no HIGH-or-above open risks except accepted-and-documented.

### Phase 21 — Production Database & Storage

- **Objective:** Postgres + durable media + verified backups + retention jobs.
- **Why here:** data-layer cutover after functional freeze; before go-live rehearsal.
- **Gaps:** G11. **Scope:** provider swap rehearsal (SQLite→Postgres data move, `pgloader` or Prisma
  script, index/unique verification); media volume mount + `MEDIA_STORAGE_PATH` prod wiring;
  `sqlite3 .backup` cron replaced by Postgres backup + restore drill; `QuizAttemptEvidence`
  `retainUntil` cleanup job; upload quotas; `setup-production.ts` updated for all post-upgrade
  models; migration runbook (order, downtime window, rollback).
- **Files:** `prisma/*`, `scripts/*`, `docs/DATABASE_GUIDE.md`, `docs/DEPLOYMENT_GUIDE.md`, Caddy/host config.
- **Tests:** migration rehearsal on a prod-clone; restore drill; retention-job dry run.
- **Completion:** staging runs Postgres with restored prod-like data; backups restore cleanly.

### Phase 22 — Final Integration & Deployment

- **Objective:** rehearsed, reversible go-live.
- **Why here:** last; everything else is its input.
- **Gaps:** G12. **Scope:** prod curriculum seeding via P11 reconciler (never R1); publish-runbook +
  comms templates; fan-out load rehearsal (thousands of recipients); full AR/EN × RTL/LTR ×
  mobile/desktop × 4-role browser pass; monitoring/health-checks/logging review; rollback plan;
  `docs/PROJECT_STATE.md` + guides updated; go/no-go checklist signed.
- **Completion:** production deployment serving the official curriculum with the full
  register→track→enroll→curriculum→publish→notify→access→progress→report chain verified live.

---

## Phase Dependency Graph

```text
P11 Curriculum Reconciliation (data foundation — nothing else can key off placeholder ids)
 ││
 │└─▶ P12 Track Architecture (needs official lessons to scope; needs P11 ids stable)
 │      │
 │      ├─▶ P13 Lifecycle & Publishing Core (needs trackScope + official lessons)
 │      │      │
 │      │      ├─▶ P14 PDF/Materials (attaches to staged sessions; needs lifecycle + trackScope)
 │      │      │      │
 │      │      │      └─▶ P15 Admin Publishing UI (needs P13+P14 APIs; needs P18 homework-create
 │      │      │             or a minimal admin create — P15 may pull that endpoint forward)
 │      │      │
 │      │      └─▶ P16 Student Locked Curriculum (needs P13 visibility rules + P14 payloads + P12 segments)
 │      │             │
 │      │             └─▶ P17 Session Notifications (needs segments + open + deep links)
 │      │
 │      └─▶ P18 Teacher Workflow (needs P12 model/P13 status; parallelizable with P14–P17)
 │             │
 │             └─▶ P19 Parent/Analytics Alignment (needs P11+P12+P16+P18 outputs)
 │                    │
 │                    └─▶ P20 Security Hardening II (needs all surfaces final)
 │                           │
 │                           └─▶ P21 Production DB & Storage (needs functional freeze)
 │                                  │
 │                                  └─▶ P22 Final Integration & Deployment
 │
 └─▶ (P11 also unblocks Kodgy re-grounding data review — executed in P19, engine untouched)
```

**Parallelization notes:** P14 ∥ P18 after P13 lands; P15 ∥ P16 after their API inputs land;
P19 starts when P16+P18 merge; P20/P21/P22 strictly sequential.

---

## Testing Strategy

### Unit / pure logic (offline, `tests/*.test.js` style)

- Reconciler mapping (R2 code → `officialCode`, order, bilingual titles) + idempotency + archive
  exclusion · `normalizeSchoolType` matrices incl. legacy/dirty rows · readiness truth table
  (materials × trackScope × status) · lifecycle transition table (illegal flips rejected) ·
  eligibility targeting (course × track × active × edge cases) · link-scheme parse/validate fuzz ·
  unlock × publish interaction table (the P5 principle as executable tests).

### API (live-server suites, following `tests/authorization-invariants` + P4/P5 patterns)

- Auth (401/403 shapes) · role separation (student/parent/teacher/admin) · **track isolation**
  (AR⇄LANG both directions, shared-vs-typed) · cross-course isolation · DRAFT/READY invisibility ·
  locked-content redaction incl. material descriptors · PDF download denials (locked, wrong track,
  wrong course, unpublished, orphan id) · idempotent open (retry = no dupes) · prefs/quiet-hours
  compliance · chunked fan-out correctness at volume (seeded thousands).

### Integration (end-to-end flows on staging)

- Admin stages session (video+PDF+quiz+assignment) → readiness green → open → segment notified →
  student deep-link → correct materials → progress → next unlocks → parent sees progress →
  teacher sees attempts → analytics update. Each step asserts the *negative* too (wrong-track
  student sees nothing; pre-open link 404s/403s; double-open notifies once).

### Browser (AR/EN × RTL/LTR × mobile/desktop × 4 roles)

- Tree skeletons, locked states, lesson page unification, notification center navigation,
  admin ceremony (counts match delivery), teacher editors, parent reports; Playwright evidence
  archive like the P9 `tests/i18n/evidence` structure.

### Security (adversarial)

- IDOR (sequential/guessed ids across every new route) · cross-track/cross-course access ·
  premature access (DRAFT/READY/unpublished/locked) · direct PDF/media URL guessing + Range games ·
  notification-link bypass (link followed without eligibility) · hidden-session bypass (universe
  exclusion probes) · upload abuse (polyglot, oversize, traversal names, MIME lies) · rate-limit
  verification · CSP violation-free.

---

## Deployment Readiness

### Already production-grade ✅

Standalone build · cross-platform build/start scripts · `SECURITY_HASH_SECRET` fail-fast (build +
runtime) · proxy defense-in-depth + headers · cookie sessions + single-device · scrypt · hashed
reset tokens + rate limits · honest `tsc` + typecheck script · Caddy reverse-proxy sample ·
`setup-production.ts` flow (needs model updates, P21) · SQLite backup/restore docs · health `GET /api`.

### Remaining before production ☐ (deployment-readiness checklist)

- [ ] P11 reconciler run against staging; R1 seed path removed (else prod ships placeholders)
- [ ] P12 track enforcement live (else wrong-curriculum delivery at scale)
- [ ] P13 lifecycle live with default-DRAFT (else accidental publish on first admin click)
- [ ] P14 authorized PDF downloads (else IP/payment bypass via shared links)
- [ ] P17 fan-out load-tested (else publish-day outage/partial notify)
- [ ] P20 contract matrix green; CSP live; legacy session fallback removed
- [ ] P21 Postgres cutover rehearsed + restore drilled; media on durable volume; evidence retention job live
- [ ] `setup-production.ts` covers batches/videos/mock-exams/enrollments/materials/publications
- [ ] Backups: Postgres schedule + media snapshots + tested restore (SQLite `.backup` cron retired)
- [ ] Monitoring: error logging, slow-query visibility, disk/quota alerts, health-check wiring
- [ ] Rate limiting: heartbeat/progress/open/notify/download/material routes
- [ ] Upload caps + storage quotas verified against disk/volume sizing
- [ ] Full 4-role × 2-locale × 2-direction × mobile/desktop browser pass on staging
- [ ] Rollback plan: lifecycle/status migration rollback + reconciler reverse + Postgres fallback snapshot
- [ ] Go-live runbook: seed order, first-publish rehearsal, comms templates, on-call list

**Deployment blockers (must-fix, in order):** P11 → P12 → P13 → P14 → P17-load → P20 → P21.
Everything else is hardening/polish around that spine.

---

## Recommended Next Phase

**Phase 11 — Official Curriculum Reconciliation. Start it immediately; nothing else first.**

Why: (1) every downstream design (trackScope placement, readiness rules, targeting segments,
analytics splits) keys off stable official lesson ids — building on R1 placeholders guarantees
rework; (2) it is the lowest-risk phase (data-only, additive fields already exist, fully offline-
testable); (3) it visibly de-risks the program (the day it lands, staging shows the real Ministry
curriculum); (4) it removes the R1 seed footgun before more admins touch the system.

Explicit non-goals for P11 (to protect its boundary): no track model changes, no lifecycle fields
beyond pre-adding `status` as inert-if-unready (or staging via `isPublished=false` + documented
follow-up flip in P13), no UI redesign, no notification work.

---

## Final Conclusions

1. **The platform is two projects in one trench coat:** a finished, hardened *learning engine*
   (P1–P10: auth, progression, assessment, parents, mocks, i18n, Kodgy) and an unfinished *content
   supply chain* (curriculum data, tracks, lifecycle, PDFs, publishing UX, targeted notifications).
   The roadmap respects that split: reuse the engine untouched, build the supply chain in
   dependency order.
2. **The hardest intellectual work is already done.** The official curriculum is extracted, validated,
   and pinned (R2); the domain end-state is decided (ADR-003); the authorization patterns are proven
   (P4/P7/P8). Remaining work is *mechanical + careful*, not *research + redesign*.
3. **The schema needs no redesign.** ≤3 small additive migrations + one optional log table + finally
   using the tables Phase 3 already created. Any proposal to re-model courses/lessons/enrollments
   wholesale should be rejected under Principles 1–2.
4. **Publish ≠ unlock is the single most important conceptual fix.** Until the lifecycle split (P13)
   lands, every “open this session” conversation will keep collapsing into the `isPublished` flag
   and leaking. Make P13’s state machine the team’s shared vocabulary from P11 onward.
5. **Track isolation must be proven, not assumed.** The current partial isolation (mocks + batch
   videos) creates a false sense of coverage; session content is fully shared today. P12’s
   cross-track matrix is a release gate, not a nice-to-have.
6. **Do the phases in order.** The dependency graph has one spine (P11→P12→P13→{P14,P16→P17}→P19→
   P20→P21→P22) with P15/P18 parallelizable. Skipping ahead (e.g., notifications before lifecycle,
   PDFs before trackScope) manufactures exactly the leakage bugs this audit exists to prevent.
7. **Deployment is 12 phases away, not 12 months of unknown scope.** Each phase has a crisp boundary
   and a completion contract; the critical path is P11–P14 + P17-load + P20 + P21.

---

### Audit validation checklist (from the task brief §30)

- [x] Repository fully inspected (`src/`, `scripts/`, `tests/`, `docs/`, config)
- [x] Prisma schema fully inspected (all models, relations, indexes, uniques, cascades)
- [x] All migrations reviewed (4/4 SQL files + test pins)
- [x] Relevant git history reviewed (shallow clone: 1 commit visible; history reconstructed from
      in-repo phase docs, PROJECT_STATE, ADRs, and code comments — limitation noted)
- [x] Admin architecture reviewed (dashboard views, content APIs, broadcast, centers)
- [x] Student architecture reviewed (tree, lesson, quiz, homework, videos, dashboard, notifications)
- [x] Teacher architecture reviewed (dashboard, lessons/quizzes/homework/analytics/attendance/templates)
- [x] Parent architecture reviewed (dashboards, reports, linking, preview gates, prefs stub)
- [x] Notifications reviewed (model, prefs, fan-out, centers, link handling)
- [x] Media/video architecture reviewed (MediaAsset, SessionVideo, `/api/media/[id]`, evidence)
- [x] Curriculum architecture reviewed (R1 seed, R2 model, PDFs, ADR-003, Track/Enrollment/Material)
- [x] Track/schoolType logic reviewed (all layers incl. guarantee table)
- [x] Session progression reviewed (engine, gates, redaction, heartbeats, universe)
- [x] API inventory completed (~68 routes categorized with authZ/validation notes)
- [x] Authorization model reviewed (10-check contract vs reality)
- [x] Current gaps documented (G1–G12, phase-mapped)
- [x] New curriculum mapped (23/23 lessons verified against R2)
- [x] PDF architecture analyzed (reuse recommendation: Material + DOCUMENT)
- [x] Session publishing model analyzed (lifecycle split recommended)
- [x] Notification targeting analyzed (eligibility-derived fan-out recommended)
- [x] Future phases designed (P11–P22 with full design contracts)
- [x] Dependencies mapped (graph + parallelization notes)
- [x] Deployment gaps documented (checklist + blockers)
- [x] Only `docs/MASTER_PLATFORM_AUDIT_AND_ROADMAP.md` changed (verified below)

```text
$ git status --porcelain
?? docs/MASTER_PLATFORM_AUDIT_AND_ROADMAP.md
```
