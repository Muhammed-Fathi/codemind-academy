# Platform Role Capabilities — CodeMind Academy

> **Phase 26F — Cross-role security QA & hardening.** This file records ONLY
> capabilities that have been verifiably proven on a real database by the phase
> verifiers (`scripts/verify-phase26a-auth.mjs` … `scripts/verify-phase26f-auth.mjs`,
> `scripts/verify-phase26b-*.mjs`, `scripts/verify-phase26c-admin.mjs`,
> `scripts/verify-phase26d-teacher.mjs`, `scripts/verify-phase26e-parent.mjs`)
> and the suites in `tests/`. Anything not proven here is deliberately left out:
> an unverified capability listed in a capability document is a lie that
> auditors and successors will act on.
>
> Maintained by the Phase 26F cross-role audit. Every "Proven by" pointer names
> the assertion label(s) that actually executed the behaviour against the
> shipped, compiled route handlers on a real SQLite database (base DDL + every
> real migration).
>
> **Phase 26H (2026-09-16) extended this document into the full capability map
> required by the final deployment gate** — §9–§19 cover Public/Student/Parent/
> Teacher/Admin, Authentication, Curriculum, the Quiz system, Payments,
> Storage/media, Notifications and the production integrations. The
> role/authorization core above (§1–§8) is unchanged; every capability row
> below was re-executed during the Phase 26H regression sweep, whose per-suite
> counts are recorded in `docs/PHASE_26H_FINAL_REGRESSION_AND_GO_NO_GO.md` §4.
> Nothing aspirational is listed: §20 names what the platform deliberately does
> **not** do, so no reader can infer a capability that does not exist.

## 1. Roles and the session model

- Roles are the closed set in `prisma/schema.prisma`:

      enum Role { STUDENT, PARENT, TEACHER, ADMIN }

  There is no fifth role and no "super" variant. Anonymous access is the
  absence of a session.
- A single authenticated session (`src/lib/auth.ts` → `getCurrentUser`) carries
  ONE `id`, `email`, `name`, and `role` per request. Every server-side gate
  derives authority from it; nothing client-supplied can promote a role or
  impersonate another user.
- `requireUser()` / `requireRole(...roles)` in `src/lib/api.ts` are the
  single composition points for server-side authority. A route that asks for a
  role and does not get it returns 403 (`Forbidden`); a route that needs a
  session and does not have one returns 401 (`Unauthorized`).

## 2. Authorization contract (verified)

### 2.1 Session / content progression (`src/lib/session-progress.ts`)

Proven by the Phase 13 + 26 suites (session-lifecycle-phase13,
phase26a-public-auth, phase26b-student-flow, phase26d-teacher plus
authorization-invariants).

| Gate | Condition | Behavior |
| --- | --- | --- |
| Lifecycle | lesson `status ≠ PUBLISHED` **or** `ARCHIVED` | 404 `LESSON_NOT_FOUND` (non-oracle) |
| Course attachment | lesson not attached to a resolvable course | 404 (non-oracle) |
| Enrollment / entitlement | student not enrolled & no shared entitlement | 403 `NOT_ENROLLED` |
| Track scope | content not in the student's track | 404 `LESSON_NOT_FOUND` |
| Progression | previous session incomplete | 403 `PREVIOUS_SESSION_INCOMPLETE` |

`canAccessQuiz` and `canAccessHomework` delegate through the SAME lesson chain;
quizzes and homework can never be reached around a lesson gate. `LESSON_NOT_FOUND`
is answered as 404 everywhere so the response never confirms whether a
client-supplied id exists.

### 2.2 Role gating (sweep + verifiers)

Proven by: phase26a-public-auth (admin/teacher rejections), phase26c-admin,
phase26d-teacher, phase26e-parent, phase26f-auth, and the authorization-invariants
suite (`tests/authorization-invariants.test.js`).

| Surface | STUDENT | PARENT | TEACHER | ADMIN | Anonymous |
| --- | :-: | :-: | :-: | :-: | :-: |
| Student self (`/api/students/me/*`) | ✅ own | ❌ 403 | ❌ 401/403 | ❌ 403 | ❌ 401 |
| Parent scope (`/api/parents/me/*`) | ❌ 403 | ✅ link only | ❌ 403 | ❌ 403 | ❌ 401 |
| Teacher surfaces | ❌ 403 | ❌ 403 | ✅ own course | ❌ 403 | ❌ 401 |
| Admin surfaces (`/api/admin/*`) | ❌ 403 | ❌ 403 | ❌ 403 | ✅ | ❌ 401 |
| Student quiz attempt/retry/evidence | ✅ own | ❌ | ❌ | ✅ grants only | ❌ 401 |

- Anonymous access is confined to the public auth flows (`/api/auth/*`), the
  public settings allowlist route, `GET /api/subscription-plans`, and the cron
  purge route. Every other API route demands a session and, where it touches
  role-scoped data, a role.

### 2.3 The 404-vs-403 discipline (proven)

- A client-supplied id for an object the caller has no role to see **or** that
  is not attached to something the gate can verify → **404** (looks like
  "missing"), so the endpoint never confirms existence.
- A caller that is authenticated but prohibited by role/ownership/scope →
  **403** with a machine-readable `code` where the gate produces one
  (`NOT_ENROLLED`, `PREVIOUS_SESSION_INCOMPLETE`).

## 3. Phase 26F fixes (this phase)

### 3.1 Referral-code IDOR closed (GO-LIVE BLOCKER → FIXED)

Endpoint: `POST /api/students/me/referral` (`src/app/api/students/me/referral/route.ts`).

- **Before**: the referrer behind a submitted `CM-??????` code was resolved with
  `student.findFirst({ where: { id: { contains: suffix } } })` — a substring
  match. A suffix of fewer than six characters thus matched *correctly* and,
  for anything less than the full id length, also matched arbitrary interior
  substrings, so `findFirst` could select a stranger whose id merely contained
  the submitted tail. Component: the reward (a one-shot `REF-` discount coupon
  + XP) credited a wrong referrer, and two students could each mint a coupon
  against the same referrer.
- **After (uniqueness is PROVEN, not assumed)**: `Student.id` is a cUID string,
  so the final six characters are NOT guaranteed unique. Resolution is
  therefore exact **and** fail-closed:
  1. the code must be `CM-` + exactly six `[A-Za-z0-9]` chars (the format GET
     returns, preserved for legacy compatibility);
  2. **every** student whose id ends in the suffix is read
     (`findMany ... take: 2`), never `findFirst` on a non-unique predicate;
  3. `0` matches → 404 (the code names nobody);
  4. `>1` matches → 404 fail-closed: no XP, no referral row, no `REF-` coupon,
     no notification. An ambiguous code can neither misplace a reward nor be
     probed to learn that a collision exists;
  5. exactly `1` match → continue (a uniquely-identified referrer).
- **Uniqueness-via-`studentCode` was evaluated and rejected as a change**: a
  one-to-one mapping onto the UNIQUE nullable `studentCode` would remove the
  last-bit-of-entropy-loss the slice imposes, but the column is `@unique` only
  when non-null, is nullable across the schema, is optional at intake and
  admin-editable, and legacy `CM-<last6>` codes already out in the wild would
  change meaning — an attribution migration that itself risks mis-matching who
  existing codes belong to. The fail-closed algorithm above achieves
  correct-or-nothing attribution with NO migration. Raising `studentCode` to
  "required + assigned automatically at referral-code generation" is a
  FUTURE ENHANCEMENT, recorded at §3.3.
- **Proven by** (real DB, compiled handler): `scripts/verify-phase26f-auth.mjs`
  REF-01..REF-06, plus `tests/auth-cross-role-phase26f.test.js` source pins.
  Verifier assertions cover: anonymous→401, TEACHER/PARENT→403, owner→200,
  short-suffix guess rejected with no row written, exact-code resolution to the
  true referrer, coupon ownership, duplicate-pair and self-referral refusal,
  **and** the two-same-suffix COLLISION fixture: an ambiguous code → 404 with
  zero referrals / zero coupons / zero notifications written, while an
  exactly-one suffix referral still succeeds alongside the twins.
- Supporting change: `scripts/lib/sqlite-prisma-lite.mjs` gained the
  `endsWith` filter (additive Prisma parity) so integration specs can exercise
  the production operator offline; production Prisma already supported it.

### 3.2 Referral reward coupon ownership

- The `REF-<last6>` discount coupon minted for the referrer is keyed and
  `createdById`-bound to the **resolved referrer's** user — and is only minted
  after uniqueness is proven (§3.1), so an ambiguous code can never mint one.
  Proven by verifier assertion `REF-03: the coupon is owned by the true
  referrer` and `REF-05: no REF- coupon was minted`.

### 3.3 FUTURE ENHANCEMENT (recorded, NOT a classification conflict)

- Move referral codes to a required, server-assigned `studentCode` (or an
  explicit full-length code column) so slice-based suffix matching can be
  retired entirely. Requires a schema change + migration + a backfill that maps
  in-flight `CM-<last6>` codes to their owner, so it is **not** done this
  phase. Until then, the fail-closed algorithm in §3.1 is the authority.

## 4. Verified write-authority inventory (read from source + suites)

These were confirmed during the Phase 26F audit; the crossed-role assertions
for the phase surfaces are exercised by the suites in parentheses.

- **Admin writes** — every `/api/admin/*` write inspected uses
  `requireRole("ADMIN")` (admin courses, groups, settings, users, sessions,
  question-bank, quiz-retries, quiz-attempts, coupons, notifications, media,
  materials, plans). No unguarded admin write found. (`phase26c-admin`,
  `phase26a-public-auth` cross-role assertions.)
- **Teacher writes** — lesson/quiz/homework create, grade, attendance, analytics
  are gated to `TEACHER` AND the teacher's own course/groups; foreign lessons
  and groups are refused 403. (`phase26d-teacher`, especially TEACHER-05/07/21/23.)
- **Student writes** — quiz attempt/start/submit, homework submission, bookmarks,
  notes, referral claim are gated to `STUDENT` AND the student's own rows
  (student id is never taken from the client; it is derived from the session).
  (`phase26b-student-flow`, `phase26d-teacher` student sides, `phase26f-auth`.)
- **Parent writes** — parent surfaces operate only on students linked to the
  parent via `ParentStudentLink`; unlinked student ids are refused.
  (`phase26e-parent`.)
- **Payment/coupon state** — coupon validation is per-user (redemptions keyed
  by `userId`), consumption happens atomically at payment submission, rejection
  releases the redemption within the same transaction. No client-mutable coupon
  or payment state was found. (`payment-*` suites.)
- **Mass assignment** — no inspected POST/PUT/PATCH mutates client-supplied
  ownership/role/status/score fields silently; ownership, role, status and
  score precedence is computed server-side from the session and re-validated
  (attendance upsert-in-place, immutable lessonId/maxMarks/trackScope on
  homework edit, teacher ownership re-check on every write).

## 5. Object-ID trust posture

- Student/homework-submission/attempt/question-bank ident ownership is derived
  server-side from `getCurrentUser()`; client-supplied ids are only ever the
  *subject* of a lookup, and every lookup is scoped by ownership or role.
- The only client-trusted id resolution found across all routes that relied on
  a **substring** predicate was the referral route — fixed in §3.1.
- Remaining `contains` usages are all search-style filters over admin-managed
  fields (course search, student/teacher email-or-code search), never
  authorization lookups for a claim/ownership decision.

## 6. Rate-limiting posture

- Shared DB-backed rate limiting: `src/lib/rate-limit.ts` (policy) +
  `src/lib/security.ts` (`checkRateLimit`/`logSecurityEvent`) + `src/lib/api.ts`
  (`applyRateLimit` / `applyRateLimitForIdentifier` / `rateLimitedResponse`).
- Per-user keys are hashed; public flows (e.g. teacher application by email)
  hash the identifier, never storing raw PII. Blocks are audited as
  `SecurityEvent` (`RATE_LIMITED`) and answered 429 with `Retry-After` and
  `X-RateLimit-*` headers.
- Classification carried into the Phase 26F report (§Rate-limiting) — no
  GO-LIVE BLOCKER found; uncovered surfaces are IMPORTANT NON-BLOCKING /
  FUTURE ENHANCEMENT only.

## 7. Non-goals of this document

- This is not a route catalogue. Route-level rows appear here only where a
  cross-role claim was actually proven; the full surface is enumerated in the
  Phase 26F report matrix.
- This is not a design doc. Behaviour explanations exist to make a proven row
  auditable, not to freeze implementation detail.

## 8. Added in this phase (files)

- `src/app/api/students/me/referral/route.ts` — exact suffix fix + length bound.
- `scripts/lib/sqlite-prisma-lite.mjs` — `endsWith` filter (additive).
- `scripts/verify-phase26f-auth.mjs` — Phase 26F cross-role verifier.
- `tests/auth-cross-role-phase26f.test.js` — source pins + real-DB verifier.

---

# Part II — Platform capability map (Phase 26H)

Everything below was executed during the Phase 26H final regression sweep on the
release candidate (`c467127`), on a real database, through the shipped,
compiled handlers. Counts are the Phase 26H numbers.

## 9. Public surface and authentication

| Capability | State | Proven by |
| --- | --- | --- |
| Public landing page, guest navigation, Arabic/English, RTL/LTR | SUPPORTED | phase26a-public-auth (121), calendar-i18n-phase9 (444) |
| Registration for STUDENT and PARENT; no role escalation via the public endpoint | SUPPORTED | phase26a-public-auth, registration-validators (24) |
| Login / logout; single-device session model; `HttpOnly` + `Secure` + `SameSite` cookies | SUPPORTED | phase26a-public-auth, security-audit-gate (116), security-hardening (368) |
| Unauthorized protected-route behaviour (redirect at the proxy, authoritative 401/403 from the API) | SUPPORTED | phase26a-public-auth, authorization-invariants (93) |
| Password reset: request → email → confirm; single-use, TTL-bound, token stored hashed, no account enumeration | SUPPORTED | phase26a-public-auth |
| Teacher activation: approve → email → applicant sets their own password; single-use, bound to the application, expiring | SUPPORTED | teacher-application-phase20 (75), phase26a-public-auth |
| Kodgy assistant hidden before authentication (fail-closed in the component) | SUPPORTED | phase26a-public-auth §2, kodgy-phase10 (231) |
| Absolute links are built from a production-validated HTTPS origin — a production deployment cannot emit `localhost` reset/activation links | SUPPORTED | security-hardening (368) + Phase 26H origin contract proof (51 cases, §5 of the 26H report) |
| Rate limiting on public flows (hashed identifiers, audited `SecurityEvent`, 429 + `Retry-After`) | SUPPORTED | security-hardening-phase20 (192), phase26a-public-auth |

## 10. Student

| Capability | State | Proven by |
| --- | --- | --- |
| Account/session; track selection; enrollment; group/batch scoping | SUPPORTED | phase26b-group-track (83), track-architecture-phase12 (310) |
| Payment request lifecycle (manual verification, ledger-backed) | SUPPORTED | payment-lifecycle-phase25-* (see §16) |
| Official curriculum visibility; track-safe content (SHARED + own track only) | SUPPORTED | track-architecture-phase12 (310), student-locked-curriculum-phase16 (366) |
| Lesson unlock/progression (lifecycle + enrollment + previous-session chain) | SUPPORTED | session-lifecycle-phase13 (302), session-progression (162), student-locked-curriculum-phase16 (366) |
| PDF / material access through the 10-check authorization contract | SUPPORTED | session-materials-phase14 (127) |
| Session video access (published + own batch + matching school type) | SUPPORTED | session-materials-phase14, production-storage-phase21 (180) |
| Quiz availability, start, attempt lock, submit, scoring, retry rules | SUPPORTED | session-quiz (70), phase26d-teacher-full-flow (136), §15 |
| Homework assignment, submission and grading visibility | SUPPORTED | teacher-workflow-phase18 (371), session-lifecycle-phase13 (302) |
| Study plan / calendar; notifications; progress export | SUPPORTED | calendar-i18n-phase9 (444), session-notifications-phase17 (319), phase26b-student-flow (39) |
| Leaderboard/gamification (XP, badges) | SUPPORTED — leaderboard scoped to the caller's course and row-bounded, payload carries no email address | security-audit-gate §6 (116) |
| Certificate | SUPPORTED — track-sliced denominator, archived completions excluded | parent-analytics-alignment-phase19 (176) |
| Referral codes with fail-closed collision handling (ambiguous code ⇒ nothing written) | SUPPORTED | phase26f-auth (`PHASE26F_VERIFIER_OK`), auth-cross-role-phase26f (20) |

## 11. Parent

| Capability | State | Proven by |
| --- | --- | --- |
| Child linking workflow and ownership isolation | SUPPORTED | parent-dashboard-isolation (112), phase26e-parent-full-flow (380, `PHASE26E_TEST_OK`) |
| Parent dashboard and analytics aligned with the child's real progression | SUPPORTED | parent-analytics-alignment-phase19 (176) |
| Weekly/monthly report | SUPPORTED | parent-monthly-report (67) |
| Notification preferences | SUPPORTED | session-notifications-phase17 (319) |
| No cross-child / cross-family leakage (every read goes through `ParentStudentLink`) | SUPPORTED | parent-dashboard-isolation (112), phase26e-parent-full-flow (380) |

## 12. Teacher

| Capability | State | Proven by |
| --- | --- | --- |
| Public application → PENDING → admin approve/reject → secure activation → applicant sets own password → active login | SUPPORTED | teacher-application-phase20 (75), phase26a-public-auth |
| Teacher dashboard; scoped lessons, questions, quizzes and attempts | SUPPORTED | teacher-workflow-phase18 (371), phase26d-teacher-full-flow (136, `PHASE26D_TEST_OK`) |
| Homework authoring and grading | SUPPORTED | teacher-workflow-phase18 (371) |
| Attendance | SUPPORTED | teacher-workflow-phase18 (371), phase26c-admin-full-flow (86) |
| Analytics | SUPPORTED | phase26d-teacher-full-flow (136), parent-analytics-alignment-phase19 (176) |
| Templates / reusable content | SUPPORTED | teacher-workflow-phase18 (371) |
| No cross-teacher scope leakage (foreign lessons/groups refused) | SUPPORTED | phase26d-teacher-full-flow (136), authorization-invariants (93) |
| Server-side score authority — no client-supplied score, percentage or pass flag is read | SUPPORTED | phase26d-teacher-full-flow `QUIZ-14` |

## 13. Admin

| Capability | State | Proven by |
| --- | --- | --- |
| Admin dashboard; users, students, teachers; teacher applications | SUPPORTED | phase26c-admin-full-flow (86 + verifier), phase26a-public-auth |
| Groups, batches, courses | SUPPORTED | phase26c-admin-full-flow, phase26b-group-track (83) |
| Official curriculum workflow; lesson readiness; publish/open; archive/unpublish | SUPPORTED | admin-publishing-phase15 (384), curriculum-reconciliation-phase11 (56) |
| Notifications (targeted fan-out) | SUPPORTED | session-notifications-phase17 (319) |
| Plans, coupons, payments, subscriptions | SUPPORTED | payment-lifecycle-phase25-* (§16), phase25-pr4-inventory (203), phase25-pr4-release-gate (93) |
| Question bank; quizzes, attempts and audited retry grants | SUPPORTED | session-quiz (70), phase26d-teacher-full-flow (136) |
| Quiz evidence (camera snapshots) and retention | SUPPORTED | production-storage-phase21 (180), vercel-cron-retention-phase24 (161) |
| Media management (server-proxied reads; presigned large uploads) | SUPPORTED | presigned-uploads-phase23 (327), media-storage-wiring (318), s3-storage-r2 (184) |
| Analytics | SUPPORTED | quiz-analytics (44), phase26c-admin-full-flow |
| Settings | SUPPORTED | phase26c-admin-full-flow, security-hardening-phase20 (192) |
| Every admin write is role-gated (`requireRole("ADMIN")`) — no unguarded admin write found | SUPPORTED | authorization-invariants (93), phase26c-admin-full-flow |

## 14. Curriculum and lesson lifecycle

| Capability | State | Proven by |
| --- | --- | --- |
| Official curriculum provisioning (idempotent, reconciliation-based: 2 Parts / 7 Units / 23 official lessons) | SUPPORTED | curriculum-reconciliation-phase11 (56) |
| Lifecycle DRAFT → READY → PUBLISHED, idempotent open, no DRAFT→PUBLISHED bypass | SUPPORTED | admin-publishing-phase15 (384), session-lifecycle-phase13 (302) |
| Track scope SHARED / ARABIC / LANGUAGE enforced on content, questions and quizzes | SUPPORTED | track-architecture-phase12 (310), phase26b-group-track (83) |
| Locked curriculum: unpublished/unready/archived content is invisible and non-oracle (404) | SUPPORTED | student-locked-curriculum-phase16 (366) |
| Session materials (PDF) readiness gate before publishing | SUPPORTED | admin-publishing-phase15 (384), session-materials-phase14 (127) |

## 15. Quiz system (Phase 26D architecture)

| Guarantee | State | Proven by |
| --- | --- | --- |
| Blueprint-driven / randomized per-attempt question selection | SUPPORTED | session-quiz (70), phase26d-teacher-full-flow (136) |
| Question set frozen per attempt (prompt, options, answer, marks, difficulty snapshotted) | SUPPORTED | session-quiz (70) |
| Default one attempt per quiz; further attempts only via an audited admin grant | SUPPORTED | session-quiz (70), phase26d-teacher-full-flow (136) |
| Starting an attempt consumes/locks it; the attempt number is server-computed | SUPPORTED | session-quiz (70), `@@unique([quizId, studentId, attemptNumber])` |
| Server-side scoring is authoritative | SUPPORTED | phase26d-teacher-full-flow `QUIZ-14` |
| Attempt history and scores are retained (retry lineage, no history rewrite) | SUPPORTED | phase26d-teacher-full-flow (136) |
| Retry generates a new set when the pool allows | SUPPORTED | session-quiz (70) |
| Concurrency safety — a concurrent start cannot freeze a question that a destructive delete then cascades away | SUPPORTED | phase26d-concurrency-postgres on **real PostgreSQL 17** (25 assertions, `PHASE26D_CONCURRENCY_POSTGRES_OK`) |
| Cross-role / cross-student isolation of attempts, evidence and results | SUPPORTED | authorization-invariants (93), phase26d-teacher-full-flow (136) |
| Global question bank (`quizId = NULL`) is intentional and unchanged | SUPPORTED | session-quiz (70), quiz-analytics (44) |
| Mock exams (randomized, school-type isolated, cleanup) | SUPPORTED | mock-exam-phase8 (135), mock-exam-grading-isolation (22) |

## 16. Payments and subscriptions

| Capability | State | Proven by |
| --- | --- | --- |
| Manual payment verification lifecycle with a ledger and explicit state transitions | SUPPORTED | payment-lifecycle-phase25-ledger (140), pr2a (169) |
| Decision handling: approval, rejection, expiry, notification linkage | SUPPORTED | payment-lifecycle-phase25-pr2a (169), phase25-pr3 (128) |
| Grandfathered plans | SUPPORTED | payment-lifecycle-phase25-pr2a-grandfather (32) |
| Concurrency safety of payment decisions | SUPPORTED | payment-lifecycle-phase25-pr2b-concurrency (114) |
| Full chain from request to entitlement | SUPPORTED | payment-lifecycle-phase25-pr2b-fullchain (135) |
| Time-zone / UTC correctness (10 timezones) | SUPPORTED | payment-lifecycle-phase25-pr2b-utc-tz (863) |
| Payment experience (student-facing UX contract) | SUPPORTED | payment-experience-phase25-pr3 (128) |
| No payment gateway / card data anywhere (manual methods only) | SUPPORTED | payment-lifecycle-phase25-pr2b (252), phase25-pr4-inventory (203) |

## 17. Storage and media

| Capability | State | Proven by |
| --- | --- | --- |
| Two backends behind one interface: `local` (dev) and `s3` (Cloudflare R2, `MEDIA_BACKEND=s3`) | SUPPORTED | media-storage-wiring (318), s3-storage-r2 (184), production-storage-phase21 (180) |
| Private bucket; no public-read ACL; every read server-proxied (`/api/media/[id]`, `/api/materials/[id]`) | SUPPORTED | s3-storage-r2 (184), production-storage-phase21 (180) |
| Server-generated object keys; clients can never choose a key | SUPPORTED | presigned-uploads-phase23 (327) |
| Short-lived presigned **PUT** uploads for large admin media, verified server-side before any DB row exists | SUPPORTED | presigned-uploads-phase23 (327) |
| MIME / size / magic-byte validation and path safety | SUPPORTED | presigned-uploads-phase23 (327), session-materials-phase14 (127) |
| Retention: expired quiz evidence purged by a fail-closed, idempotent job | SUPPORTED | vercel-cron-retention-phase24 (161), production-storage-phase21 (180) |

## 18. Notifications

| Capability | State | Proven by |
| --- | --- | --- |
| 12 notification types (lesson, quiz, homework, session, attendance, report, subscription, announcement, payment approved/rejected) | SUPPORTED | session-notifications-phase17 (319), `NotificationType` enum |
| Preference-aware, targeted fan-out; chunked; idempotent; deep links validated server-side | SUPPORTED | session-notifications-phase17 (319) |
| In-app only — no email is sent for notification events (see §20) | SUPPORTED | notify.ts has no mail import; mail surface is the two flows in §9 |

## 19. Production integrations

| Integration | State | Evidence |
| --- | --- | --- |
| Vercel Hobby build runs the PostgreSQL client generation (`build:postgres`), pinned in `vercel.json` | SUPPORTED | `vercel.json` `buildCommand`; CI build step green on the release tree |
| No migration runs inside the build | SUPPORTED | build command composition; Phase 26G build log (`grep migrate` = 0) |
| Neon PostgreSQL 17 — migration-provider split, 0_init + Phase 26D chain, fresh provisioning and incremental application | SUPPORTED | PG17 CI workflows; Phase 26H real-PG17 proofs (report §9) |
| Cloudflare R2 — private bucket, exact-origin CORS is an operator step | SUPPORTED | §17 above; runbook §6 |
| Gmail SMTP (Nodemailer) — two mail flows, credentials server-only, link origins production-validated | SUPPORTED | report §11; mailer redacts credentials from errors |
| Vercel Cron — GET-only, Bearer `CRON_SECRET`, constant-time compare, fail-closed, once-daily schedule | SUPPORTED | vercel-cron-retention-phase24 (161), report §12 |
| Production fail-fast: missing/placeholder `SECURITY_HASH_SECRET` or an unusable `NEXT_PUBLIC_URL` refuses the build and the boot | SUPPORTED | report §5 (build-time config guard + runtime instrumentation guard) |

## 20. Deliberately NOT supported (do not assume otherwise)

* **No payment gateway.** Payments are manually verified; no card data is
  stored or transmitted.
* **No email for in-app events.** Only password reset and teacher activation
  send mail. Notifications are in-app rows.
* **No public media bucket and no presigned GET.** All reads are
  server-proxied; large uploads may go direct, downloads never do.
* **No automatic database backup on Vercel.** `scripts/db/backup-postgres.sh`
  needs a shell and a filesystem; an offsite `pg_dump` job is a post-launch
  follow-up.
* **No readiness/health endpoint that reports dependency state.** `/api` is a
  liveness stub; exposing DB/R2/SMTP state unauthenticated would be an
  information leak.
* **No second factor, no social login, no OAuth provider.**
* **No external AI in the request path for users.** Kodgy is a deterministic
  client-side assistant. The ADMIN/TEACHER-only AI quiz-generation route uses
  `z-ai-web-dev-sdk`; if that provider is unavailable in production the route
  fails gracefully and manual question authoring is unaffected.
* **No multi-region deployment, no background worker, no queue.**
* **No automated schema rollback.** Migrations are additive; recovery is
  roll-forward or restore-to-branch.
