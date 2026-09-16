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
