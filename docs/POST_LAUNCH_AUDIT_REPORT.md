# Post-Launch Audit Report — CodeMind Academy

**Branch:** `arena/01a0aa38-codemind-academy` (base `7b0b6de` of `main`)
**Date:** 2026-09-16
**Status:** COMPLETE — awaiting review before PR (no PR opened, nothing pushed to `main`, no deploy).

---

## 1. Executive Summary

A full post-launch UX / Admin / Performance audit was performed on the latest
`main`. Highlights:

- **Footer & contacts (tasks 1, 3):** every "المنصة" footer link now works from
  any view; support contacts were centralized in `src/lib/brand.ts`
  (`SUPPORT_CONTACTS`) and split by responsibility: technical & subscription
  support = **Eng. Abdelrahman Mohamed — 01099942942**, teacher support =
  **Eng. Muhammed Fathi — 01147422177**. The standalone loose phone number was
  removed; all numbers are clickable (`tel:`).
- **Help card (task 4):** the dashboard "محتاج مساعدة؟" card was redesigned
  into a shared two-contact card with per-person WhatsApp actions, RTL/LTR
  care and mobile responsiveness.
- **Admin lifecycle (task 2):** Groups, Teachers, Courses and Question-bank
  questions gained **safe, server-guarded Edit/Deactivate/Delete** lifecycles
  with confirmation UI, dependency-aware 409 refusals and audit logging. A
  full CRUD matrix is in §7; guard semantics in §8.
- **Teacher sessions (task 5):** investigated end-to-end — **correct by
  design + an operational gap**, not a scoping bug. Verdict and the Arabic
  rule in §10; teacher isolation is regression-tested.
- **Performance (task 8):** measured first with a dedicated benchmark
  (`scripts/bench-post-launch-perf.mjs`), then applied three safe fixes.
  Admin overview went **19 → 13 DB queries/request**; teacher dashboard
  **29 → 27 queries** with serial depth cut **~25 → ~6** round-trip waves;
  login side-effects parallelized with **zero** weakening of scrypt or rate
  limiting. Payloads proven **byte-identical** before/after.
- **Tests (task 9):** new 57-check lifecycle verifier + test wrapper; full
  suite **54/55 green** — the single failure reproduces identically on the
  pristine base commit (pre-existing, environment-bound, untouched).
- **Docs (task 6):** `docs/PLATFORM_ROLE_GUIDE_AR.md` — Arabic role guide for
  Visitor/Student/Parent/Teacher/Admin documenting the actual implementation.

---

## 2. Audit Scope & Constraint Compliance

| Constraint | Compliance |
| --- | --- |
| No deploy / no production mutation | ✅ Nothing deployed; no production writes. The production-mode `next build`/`next start` run was local, sandbox-only, with throwaway env values (never committed). |
| No destructive SQL / no DB reset | ✅ All measurement/testing DBs are **in-memory SQLite** built by the repo's own harness. |
| No env var changes | ✅ No `.env*` file touched; sandbox-only build vars were passed inline. |
| No push to `main`, no PR before report review | ✅ Work only on the session branch; this report precedes any PR. |
| Zero DB/migration impact preferred | ✅ **No schema or migration file changed.** |
| Inspect before editing; no guessed routes/rules | ✅ Discovery pass first (§3); every guard mirrors the real schema relations. |
| Preserve security guarantees; never weaken hashing | ✅ scrypt parameters untouched and **pinned by test**; rate-limit ordering semantics preserved deliberately (§15). |
| Keep RTL / light theme / brand / Cairo-Inter / green accent | ✅ No theme or typography changes; all new UI follows existing tokens. |
| Don't weaken tests | ✅ Two pins were **adjusted at equal strength** after requested refactors moved strings into dict keys (§17) — none removed or loosened. |

---

## 3. Discovery & Methodology

- Read implementations before edits: landing/footer, brand config, auth
  routes, every `/api/admin/*` surface, teacher routes, `prisma/schema.prisma`
  relations, the phase-26 harness methodology and `docs/PLATFORM_ROLE_CAPABILITIES.md`.
- **Sandbox limitation (documented, not worked around):** Prisma engine
  binaries cannot be downloaded here (`binaries.prisma.sh` blocked) and the
  WASM engine only speaks Data-Proxy URLs — so a real Next+PrismaClient run
  against a database is impossible in this environment. The repo itself
  documents this in `scripts/lib/sqlite-prisma-lite.mjs` and every phase
  verifier uses the same harness: **real route handlers compiled with tsc +
  real SQLite (base DDL + every real migration) + a Prisma-surface client**.
  All performance and lifecycle verification uses that established
  methodology; the Next.js serving layer was additionally measured with a
  real `next build` + `next start` (§13).
- Every change batch was typechecked (`npx tsc --noEmit` — exit 0 throughout).

---

## 4. Footer Links & Centralized Contacts (Task 1)

- **Footer "المنصة" links** (`src/components/landing/sections.tsx`): wired via
  the canonical navigation mechanism (zustand `setView` + `scrollTo`, no
  invented routes): تسجيل الدخول → login view · إنشاء حساب → register view ·
  الأسعار → landing pricing section (scroll) · المنهج → landing curriculum
  section (scroll) — **from any view** (dashboard views return to the landing
  view for the role, then scroll).
- **Contact section:** Technical Support and Subscription Support both show
  **01099942942** (Eng. Abdelrahman Mohamed); teacher support ("اسأل الـ
  Teacher") keeps **01147422177** (Eng. Muhammed Fathi); the standalone loose
  phone number was **removed**; every number is a clickable `tel:` link.
- **Single source of truth:** `SUPPORT_CONTACTS` / `SUPPORT_PEOPLE` /
  `telLink()` in `src/lib/brand.ts`. The legacy `brand.whatsapp.*` fields now
  mirror the same config so no screen can disagree.
- **Pinned values preserved:** `SUPPORT_PHONE_DISPLAY = "+20 1147422177"`
  (payment test suites pin it) unchanged; the payment-experience PR3 file
  list constraint (no literal `01099942942` inside `PR3_FILES`) respected.

## 5. Auth/Register Support Contact (Task 3)

`src/components/auth/auth-view.tsx` now presents the registration/login
support contact as **"Eng. Abdelrahman Mohamed — 01099942942"** (technical &
subscription support) instead of the old teacher-line display, rendered
cleanly with an LTR-pinned number inside the RTL layout.

## 6. "محتاج مساعدة؟" Card Redesign (Task 4)

New shared component `src/components/shared/support-card.tsx`, rendered in
the dashboard sidebar for **every role** (`src/components/dashboard/shell.tsx`):

- **Two contacts, each self-contained:** role label (dict keys `shell.039`
  "الدعم الفني والاشتراكات" / `shell.040` "دعم المدرسين والدراسة"), English
  name pinned `dir="ltr"`, clickable `tel:` line, and its **own WhatsApp
  button** (`shell.042`) with the pre-filled message — users can no longer be
  silently routed to the wrong person.
- **RTL/LTR care:** numbers and names are forced LTR inside the RTL card;
  icons and spacing flip correctly (`ms-`/`me-` utilities).
- **Mobile responsive & compact:** stacked person blocks, truncation guards,
  same visual language (primary/amber gradient, green accent) as before.
- Numbers come **only** from `SUPPORT_CONTACTS` — nothing hardcoded.

## 7. Admin CRUD Audit — Full Matrix (Task 2)

State **before → after** this audit (API + UI):

| Entity | Create | Read | Update | Deactivate/Archive | Delete | Notes |
| --- | :-: | :-: | :-: | :-: | :-: | --- |
| Groups | ✅ | ✅ | ✅ (existed) | ✅ isActive (existed) + inactive badge in list (added) | ❌ → ✅ **added** (guarded) | DELETE refused while students (api.294) or sessions (api.295) exist |
| Teachers | ✅ | ✅ | ❌ → ✅ **added** (profile PATCH) | ✅ (existed; kept) | ❌ → ✅ **added** (guarded) | DELETE refused while groups/sessions/notes exist (api.296); applications unlinked, never erased |
| Students | ✅ | ✅ | ✅ (existed) | ✅ (existed) | **none — intentional** | financial/educational history must survive; deactivation is the safe path |
| Courses | ✅ | ✅ | ❌ → ✅ **added** (metadata-only PATCH) | via lesson lifecycle | ❌ → ✅ **added** (guarded) | DELETE refused while groups/parts/enrollments/mockExams/batches reference it (api.298) |
| Lessons | ✅ | ✅ | ✅ | ✅ draft/ready/publish/unpublish/archive (existed) | ✅ (existed, lifecycle-gated) | unchanged — already complete |
| Batches | ✅ | ✅ | **GET/POST only — INTENTIONAL** | — | — | students reference batches; lifecycle left as-is and documented (§8) |
| Plans | ✅ | ✅ | ✅ | ✅ enable/disable (existed) | ✅ guarded (existed) | unchanged |
| Coupons | ✅ | ✅ | ✅ | ✅ | ✅ (existed) | unchanged |
| Mock exams / Session videos | ✅ | ✅ | ✅ | ✅ | ✅ (existed) | unchanged |
| Notifications | ✅ (POST fan-out) | ✅ | — | — | **none — intentional** | delivery history is immutable |
| Media | ✅ upload | ✅ | ✅ | ✅ | ✅ (existed) | unchanged |
| Question bank | ✅ (existed) | ✅ list → ✅ **+per-question GET** | ❌ → ✅ **added** (guarded PATCH) | — | ❌ → ✅ **added** (guarded DELETE) | grading fields frozen under attempts; FIXED exam pins block delete |
| Quiz attempts | read + audited retry grants (existed) | ✅ | — | — | **read-only — intentional** | frozen-history contract |

New UI (all in `src/components/admin/admin-dashboard.tsx` +
`src/components/shared/confirm-dialog.tsx`): EditTeacherDialog, teacher
delete confirm, ManageGroupDialog (rename/deactivate/delete group),
EditCourseDialog + course delete confirm, EditQuestionDialog + question
delete confirm — destructive buttons are **pre-disabled with the reason**
from the per-question GET (`canDelete`/`deleteBlockers`), confirm dialogs
replace browser confirms, and server 409 explanations surface verbatim.

## 8. Lifecycle Guard Semantics (server-side, ADMIN-only, audited)

- **Group DELETE** — 409 `api.294` (student count) / `api.295` (session
  count); success → audit `GROUP_DELETED`.
- **Teacher PATCH** — name (`api.297`), email format (`api.060`), email clash
  409 (`api.053`), Egyptian phone validation (`api.064`); **email change
  revokes all teacher sessions** (`ADMIN_TEACHER_EMAIL_CHANGED`) so the
  identity change forces re-authentication; audit `TEACHER_PROFILE_UPDATED`.
- **Teacher DELETE** — 409 `api.296` with (groups, sessions, notes) counts
  while any history exists (deactivation is the safe alternative); allowed
  only for a zero-history account: application rows **unlinked** (`userId →
  null`) but preserved, user deleted (own dependent rows cascade per
  schema), audit `TEACHER_DELETED` + `ACCOUNT_DELETED` security event.
- **Course PATCH** — metadata only (name/nameAr/description/color,
  `api.018` validation); the slug and curriculum structure are **never**
  editable here (public links + the official-curriculum reconciler key off
  them); audit `COURSE_UPDATED`.
- **Course DELETE** — 409 `api.298` with (groups, parts, mockExams) counts
  while referenced by groups/parts/enrollments/mockExams/batches (a delete
  would cascade through Parts→Units→Lessons destroying quizzes and
  progress); in-use content is archived via the lesson lifecycle instead;
  audit `COURSE_DELETED`.
- **Question GET** — returns reference counts (frozen answers, open/graded
  attempts, FIXED/RANDOM exam pins) + `canDelete`/`canEditAnswerKey` so the
  UI disables instead of discovering a 409.
- **Question PATCH** — grading fields (`answer/options/type/marks` +
  `schoolType`) locked with 409 `api.245` while any attempt references the
  question; non-grading text edits remain allowed; full re-validation
  through the shared `validateQuestionDraft`. **Bug found & fixed during
  verification:** bank-only questions (`quizId = NULL`) failed closed in the
  scope check — they now validate against `SHARED` scope, matching the
  create route's semantics.
- **Question DELETE** — reference check + delete in **one transaction**
  behind the Phase-26D quiz destructive lock; 409 `api.246` (FIXED exam pin)
  / `api.247` (frozen answer history).
- **Batches stay GET/POST-only — intentional:** students reference batches
  and no safe rename/deactivate semantic exists yet; adding one would be a
  feature, not an audit fix. Recorded in the matrix instead of silently
  "fixed".
- Every refusal message is localized (new dict keys `api.294`–`api.298`);
  every mutation is authorized server-side (`requireRole("ADMIN")`) and
  audited under the acting admin.

## 9. New i18n Keys

- `api.294`–`api.298` — lifecycle refusal messages (server).
- `admin.509`–`admin.533` — lifecycle UI (dialogs, buttons, toasts, badges).
- `shell.039`–`shell.042` — support-card role labels & WhatsApp action.
- `teacher.021` override (DICT_2026) — clearer sessions empty state (§10).
- All keys resolve in Arabic + English (checked by the calendar-i18n suite).

## 10. Teacher Group Assignment vs Session Visibility (Task 5) — VERDICT

**The chain, traced end-to-end:** admin creates a Group (POST
`/api/admin/groups`) and assigns a teacher → the teacher's dashboard
(`GET /api/teacher/dashboard`) loads `teacher.groups` and, per group, its
`LiveSession` rows (`where: { groupId }`) → upcoming sessions are those
group sessions within the next 7 days.

**Finding:** `LiveSession` rows are created **only** by seeds/operational
scripts — there is **no admin UI or API anywhere in `src/` that creates,
updates or deletes live sessions** (verified by exhaustive grep: zero
`liveSession.create/update/delete` call sites in application code). So a
newly assigned group legitimately shows **no sessions**: the group→teacher
link works, the session list is correctly scoped, and the empty list is the
truth about the data.

**Verdict: correct-by-design + operational gap** (not a scoping bug).
Actions taken:

1. **Empty-state text improved** (`teacher.021` override) so the state reads
   as "no sessions scheduled for your groups yet" instead of looking broken.
2. **The rule, in Arabic** (also recorded in the role guide §4):

   > **القاعدة:** إسناد مجموعة لمدرس يجعله يرى المجموعة وطلابها وإحصاءاتها
   > فورًا — لكن الحصص المباشرة كيان مستقل مرتبط بالمجموعة. لا تظهر أي حصة
   > في لوحة المدرس إلا إذا كانت مسجَّلة لإحدى مجموعاته المسندة إليه، ولا
   > يظهر للمدرس أي حصة أو مجموعة تخص مدرسًا آخر (عزل تام مُختبَر). إنشاء
   > الحصص حاليًا مسؤولية تشغيلية (فريق التشغيل) وليست من شاشة المنصة،
   > لذلك «مجموعة جديدة بلا حصص» حالة صحيحة بتصميم النظام وليست عطلًا.

3. **Isolation regression-tested** (verifier checks SCOPE-01…SCOPE-08: own
   groups only, other teacher's groups/sessions never appear in the payload,
   attendance/quiz stats scoped to own sessions).
4. **Follow-up recommendation** (out of audit scope): an admin live-session
   management screen would close the operational gap (§16).

## 11. Arabic Role Guide (Task 6)

`docs/PLATFORM_ROLE_GUIDE_AR.md` — visitor / student / parent / teacher /
admin, built strictly from the verified capability map
(`docs/PLATFORM_ROLE_CAPABILITIES.md`) and the actual routes: payments are
manual (no gateway), one quiz attempt by default (admin-granted retries),
frozen attempts, sequential lesson unlock, single-device sessions, the
safe-delete lifecycle rules from §8, the teacher-sessions rule from §10, the
support roster, and the platform's deliberate non-features. Contains **no
secrets, credentials or security internals**.

## 12. UX Polish (Task 7)

- Light theme, Cairo/Inter typography and the green primary accent kept
  everywhere; new UI reuses existing tokens/components only.
- Destructive actions: red-tinted icon buttons + confirm dialogs with the
  entity's identity (name · email) and the safety rule explained before
  confirmation; server refusals surface **verbatim** in toasts (users learn
  *why*, e.g. "انقل الطلاب أولًا").
- Inactive groups get an explicit badge + explanation string (`admin.518`).
- All phone numbers clickable; English names/numbers pinned LTR inside RTL.
- Edit dialogs prefill current values; email edits warn (via the guide and
  dialog copy) that the teacher will be signed out.

## 13. Performance — Methodology & Findings (Task 8)

**Measurement before optimization**, with `scripts/bench-post-launch-perf.mjs`
(committed): real compiled route handlers + real in-memory SQLite (repo
harness — see §3 for why PrismaClient cannot run in this sandbox), realistic
fixtures (admin, 2-group teacher, 40 students, 4 live sessions + attendance,
quiz + 30 attempts, homework + 25 submissions, 180 payments over 6 months),
a query-counting client proxy, cold + 10 warm runs per endpoint, plus a real
`next build`/`next start` infra baseline:

| Endpoint | cold ms (before → after) | warm avg ms | DB queries/req | payload |
| --- | --- | --- | --- | --- |
| POST /api/auth/login | 83.7 → 82.3 | 46.9 → 48.0 | 14 → 14 | 115 B |
| GET /api/auth/me | 2.1 → 3.2 | 1.1 → 1.4 | 2 → 2 | 124 B |
| GET /api/admin/overview | 19.3 → 22.0 | 4.7 → 4.7 | **19 → 13** | 766 B |
| GET /api/teacher/dashboard | 13.0 → 12.8 | 10.1 → 8.0 | **29 → 27** | 16 KB |

- **scrypt cost (measured, attribution only):** hash 42.9 ms, verify 41.7 ms
  ⇒ **~92% of warm login time is the password KDF** — the security floor.
- **Next.js serving baseline (real build):** `GET /` = 2.6–6.6 ms warm
  (static 14.8 KB HTML, RTL, Cairo preloaded); proxy-401 rejection = 14 ms;
  build time ≈ 46 s. The framework layer is negligible.
- Local SQLite has ~0 network latency, so warm ms barely moves for the
  parallelization fixes — **the query count and serial depth are the
  production-relevant numbers** (§14). Payload parity: overview and
  dashboard responses are **byte-identical** before/after once volatile
  fixture values are normalized (`--dump-bodies` diff).

## 14. Performance — Root Cause & Top 3 Bottlenecks

**Latency model in production (Vercel Hobby + Neon free tier):**

```
perceived latency ≈
    Vercel function cold start        (first hit after idle: ~hundreds of ms–s)
  + Neon endpoint wake-up             (one-time, first query after idle: ~hundreds of ms)
  + Σ (Neon round-trips × ~1–5 ms)    (warm RTT, eu-central; SEQUENTIAL chains sum up)
  + app logic (scrypt ≈ 42 ms on login, JSON, render)
```

The sandbox cannot measure Vercel/Neon directly (no access) — so the audit
attacked the **controllable multiplier**: the number of round-trips each
request issues and how many of them are serialized.

**Top 3 bottlenecks found:**

1. **Admin overview's sequential monthly revenue loop** — 7 payment scans
   (1 monthly + 6 trend months queried one-by-one in a `for` loop) inside a
   19-query request, all serialized ⇒ up to ~7 × RTT of pure wait per
   dashboard open, growing with the Payment table.
2. **Teacher dashboard's deep serial chains** — 29 queries with a serial
   depth of ~25 awaits (per group: video progress → sessions → attendance →
   quiz attempts → lessons → homeworks → pending count, each waiting on the
   last; plus a redundant per-group `nextSession` query re-reading data
   already fetched, and a whole-teacher pending chain duplicating the
   per-group scans). Cost scales linearly with the number of groups.
3. **Infrastructure cold starts** — Vercel Hobby function cold start + Neon
   free-tier endpoint suspension dominate *first-hit* latency in production.
   This is platform economics, not code: it cannot be fixed safely without
   paid infra (an explicit constraint), so it is documented, and the code
   side was minimized to shorten the post-wake work.

(Login's warm ~46 ms is **not** a bottleneck to fix: ~92% of it is scrypt —
the deliberate security parameter.)

## 15. Performance — Fixes Applied & Before/After

All fixes are behavior-preserving (proven by the payload-parity diff) and
touch no security parameter:

1. **`GET /api/admin/overview`** — one `findMany` over APPROVED payments
   since the trend start (indexed by the existing
   `Payment(status, createdAt)` index), bucketed in JS; **all** remaining
   reads (6 counts, groups, attendance groupBy, quiz aggregate, upcoming
   sessions) run concurrently in a single `Promise.all`.
   **19 → 13 queries; 7 serialized payment round-trips → 1; response
   byte-identical.**
2. **`GET /api/teacher/dashboard`** — restructured into concurrent waves:
   per-group independent reads in parallel (video progress, sessions, quiz
   attempts, course lessons), dependent reads in a second wave (attendance,
   homeworks), the whole-teacher pending chain, upcoming sessions and
   recent activity all launched concurrently; `nextSession` **derived in JS**
   from the already-fetched group sessions (same filter/order the old
   `findFirst` used). **29 → 27 queries; serial depth ~25 → ~6 waves;
   response byte-identical.**
3. **`POST /api/auth/login`** — the two independent post-success side
   effects (`resetRateLimit` + `logSecurityEvent`) now run concurrently
   (−1 round-trip on the success path). **Deliberately NOT changed:** the
   rate-limit *checks* stay sequential (IP check first, so an IP-blocked
   attacker cannot burn a victim's per-identity budget — parallelizing would
   subtly weaken that), and scrypt stays at full strength (both pins are
   asserted in `tests/post-launch-admin-lifecycle.test.js`).

**Expected production effect** (from the RTT model, since Neon is
unreachable from the sandbox): overview saves ~6 RTT (~10–30 ms warm) per
open and removes 6 serialized scans; dashboard saves ~19 serialized RTT
(~20–95 ms warm, growing with group count); login saves ~1 RTT on success.

**Also verified (no action needed):** `GET /api/auth/me` is already lean
(2 queries, ~1 ms); the teacher-dashboard client tabs share one React Query
key (`["teacher-dashboard"]`) so tab switching does **not** refetch; the
AppShell restores sessions without duplicate `me` calls.

## 16. Performance — Remaining Recommendations & Verdict

**Remaining (deliberately not done — each needs a decision or a migration):**

- Batch the teacher dashboard's per-group reads across groups (one
  video-progress + one quiz-attempt query for all students, split per group
  in JS) — saves another ~4×(G−1) queries for G groups; a larger semantic
  refactor of `getVideoProgressForStudents` callers.
- Short-TTL caching for the admin overview (30–60 s `staleTime` client-side
  or an ETag) — the numbers tolerate minutes of staleness.
- If attempt volume grows: consider `QuizAttempt(studentId)` and
  `HomeworkSubmission(homeworkId, status)` indexes (**requires a migration**
  — out of this audit's zero-DB-impact scope).
- Infra (owner decisions, no code): keep the Neon **pooler** URL; if Hobby
  cold starts hurt, evaluate Vercel Fluid compute or a keep-warm schedule;
  add latency monitoring (Vercel Analytics / Neon metrics).
- Product: an **admin live-session management screen** would close the §10
  operational gap (teachers seeing sessions without an out-of-band process).

**Verdict:** the application layer is healthy — warm endpoint work is
1–10 ms plus login's intentional ~42 ms scrypt floor, framework overhead is
negligible (~3–7 ms), and the controllable DB-latency multiplier was cut
(overview −32% queries, dashboard −75% serial depth) with **proven
byte-identical responses and zero security relaxation**. The residual
slowness users perceive in production is dominated by **Vercel Hobby cold
starts + Neon free-tier wake-ups** — an infrastructure characteristic,
documented above, that no safe code change can remove on the free tier.

## 17. Tests, Regression Results & Changed Files (Tasks 9–11)

**New:**

- `scripts/verify-post-launch-admin-lifecycle.mjs` — **57 checks, all
  passing**: every guard in §8 (status + exact localized message), audit
  rows, application-history preservation, session revocation on email
  change, ADMIN-only authorization (403/401), teacher-session isolation
  (SCOPE-01…08) and post-optimization payload pins (PERF-01…04).
- `tests/post-launch-admin-lifecycle.test.js` — source pins (guards stay in
  the codebase; overview keeps ONE payment scan; dashboard keeps its
  concurrent plan; login keeps sequential checks; **scrypt never weakened**;
  schema cascade intact) + runs the verifier.
- `scripts/bench-post-launch-perf.mjs` — the committed benchmark
  (`--runs`, `--json`, `--dump-bodies`).

**Full suite:** `tests/*.test.js` → **54/55 pass** (including all payment,
security-hardening, authorization-invariants, phase26a–f, teacher-workflow,
calendar-i18n 452/452, phase26c 86/86 + verifier). The single failure,
`final-integration-phase22`, requires a gitignored runtime `backups/`
directory and **fails identically on the pristine base commit `7b0b6de`**
(proven in a detached worktree) — pre-existing and environment-bound; not
touched, not weakened. `npx tsc --noEmit`: exit 0.

**Two pins adjusted at equal strength** (both were invalidated by
user-requested refactors, not loosened):

- `calendar-i18n-phase9` B2: the support button moved into the shared
  SupportCard — the pin now asserts shell renders `SupportCard`, the card's
  labels are dict keys (`shell.039/040/042` + `shell.038` fallback), all
  resolve in the dict, and no hardcoded "Support" text exists in either file.
- `phase26c-admin-full-flow`: bare-English "Deactivate"/"Reactivate" became
  dict keys — the pin now asserts `tr("admin.298")`/`tr("admin.299")` in the
  dashboard **and** their English dict values remain exactly
  "Deactivate"/"Activate".

**Changed files:**

| File | Change |
| --- | --- |
| `src/lib/brand.ts` | `SUPPORT_CONTACTS`/`SUPPORT_PEOPLE`/`telLink`; whatsapp fields mirror it |
| `src/components/landing/sections.tsx` | footer links wired; contact section rebuilt |
| `src/components/auth/auth-view.tsx` | support contact = Eng. Abdelrahman Mohamed / 01099942942 |
| `src/components/shared/support-card.tsx` | **new** two-contact help card |
| `src/components/dashboard/shell.tsx` | renders SupportCard |
| `src/components/shared/confirm-dialog.tsx` | **new** shared confirm dialog |
| `src/app/api/admin/groups/[id]/route.ts` | guarded DELETE |
| `src/app/api/admin/teachers/[id]/route.ts` | profile PATCH + guarded DELETE |
| `src/app/api/admin/courses/[id]/route.ts` | **new** metadata PATCH + guarded DELETE |
| `src/app/api/admin/question-bank/[id]/route.ts` | **new** GET/PATCH/DELETE with frozen-history guards |
| `src/components/admin/admin-dashboard.tsx` | teacher/group/course/question lifecycle UI |
| `src/lib/security.ts` | `ACCOUNT_DELETED` security-event type |
| `src/lib/i18n-dict-2026.ts` | `api.298`, `admin.509–533`, `shell.039–042`, `teacher.021` override |
| `src/app/api/admin/overview/route.ts` | perf: single payment scan + concurrent reads |
| `src/app/api/teacher/dashboard/route.ts` | perf: concurrent waves + derived nextSession |
| `src/app/api/auth/[action]/route.ts` | perf: parallel post-success side effects (checks stay sequential) |
| `docs/PLATFORM_ROLE_GUIDE_AR.md` | **new** Arabic role guide |
| `docs/POST_LAUNCH_AUDIT_REPORT.md` | **new** this report |
| `scripts/bench-post-launch-perf.mjs` | **new** benchmark |
| `scripts/verify-post-launch-admin-lifecycle.mjs` | **new** 57-check verifier |
| `tests/post-launch-admin-lifecycle.test.js` | **new** pins + verifier runner |
| `tests/calendar-i18n-phase9.test.js`, `tests/phase26c-admin-full-flow.test.js` | equal-strength pin adjustments (above) |

**Next step:** upon your approval of this report — commit is already staged
on the branch (work is preserved automatically); a PR from
`arena/01a0aa38-codemind-academy` can be opened on request. No merge, no
deploy.
