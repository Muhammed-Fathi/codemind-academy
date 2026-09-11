# Phase 20 — Addendum: Secure Teacher Application & Admin Approval

> Branch: `arena/01a08d88-codemind-academy` · Base commit: `fb8aee3`
> This is an **extension of Phase 20 (Security Hardening II)** — it is not a new
> phase and does not restart Phase 20. It pairs with
> `docs/PHASE_20_SECURITY_HARDENING_II.md` (the original 21-section report).
> Scope: identity provisioning + authorization hardening + secure Teacher
> account activation — nothing else.

---

## 1. Objective & scope

The public "become a teacher" surface previously either blocked TEACHER
registration entirely or (legacy `POST /api/admin/teachers`) created an
**active** Teacher with an admin-supplied password. This addendum makes the
only legitimate path an auditable, privilege-safe chain:

**Application → Admin Approval → Secure Activation → Teacher Account**

- A public applicant creates a `PENDING` `TeacherApplication` — **never** a
  `User`, **never** `User.role = TEACHER`, **never** a Teacher session.
- Only an authorized Admin approves; approval mints a short-lived, single-use,
  cryptographically random activation token (emailed as a link).
- The applicant sets their **own** password through the activation link; only
  then is a `User(role = TEACHER)` + `Teacher` profile created. There is no
  hardcoded/default password, no password in any API response, and **no
  auto-authentication** on approval or activation.

Strict boundary honoured: no teacher curriculum authoring, lesson/homework
workflow, analytics, or dashboard UX beyond the review queue; no Postgres
migration, durable-storage migration, backup infrastructure, production
deployment, or Phase 22 work.

## 2. Files changed

New:

- `prisma/migrations/20260912000000_phase20_teacher_applications/migration.sql` — additive DDL.
- `src/lib/teacher-applications.ts` — domain module (`submit/approve/reject/activate`).
- `src/app/api/auth/teacher-activate/route.ts` — public single-use-token activation.
- `src/app/api/admin/teacher-applications/route.ts` — ADMIN-only list (`?status=`).
- `src/app/api/admin/teacher-applications/[id]/approve/route.ts` — ADMIN-only approve.
- `src/app/api/admin/teacher-applications/[id]/reject/route.ts` — ADMIN-only reject.
- `scripts/verify-phase20-teacher.mjs` — real-DB + real-HTTP verifier (71 checks).
- `tests/teacher-application-phase20.test.js` — source invariants + verifier subprocess (75 checks).

Modified:

- `prisma/schema.prisma` — `TeacherApplicationStatus`, `TeacherApplication`, `TeacherActivationToken`.
- `scripts/lib/migrate-sqlite.mjs`, `scripts/verify-phase13-db.mjs`, `scripts/verify-phase14-db.mjs` — new tables added to the skip/derivation lists.
- `src/lib/security.ts` — seven teacher application/activation `SecurityEvent` types.
- `src/lib/rate-limit.ts` — seventh limiter key `teacherApply` (+ env mapping, default `5/3600/3600`).
- `src/lib/api.ts` — `applyRateLimitForIdentifier` (public-surface limiter composition).
- `src/app/api/auth/[action]/route.ts` — TEACHER registration now submits a PENDING application; ADMIN registration stays blocked; STUDENT/PARENT untouched.
- `src/lib/i18n-dict-2026.ts` — `api.258`–`api.265`, `auth.218`–`auth.225`.
- `.env.example` — `TEACHER_ACTIVATION_TTL_HOURS`, `RATE_LIMIT_TEACHER_APPLY`.
- `src/components/auth/auth-view.tsx` — `activate` mode + `TeacherActivationForm`; TEACHER apply carries no password.
- `src/components/admin/admin-dashboard.tsx` — `TeacherApplicationsPanel` (PENDING/APPROVED/REJECTED/ACTIVATED filter + Approve/Reject).
- `tests/security-hardening-phase20.test.js` (limiter-key count 6→7), `tests/security-hardening.test.js` (TEACHER self-registration pin), `tests/teacher-workflow-phase18.test.js` (Phase-18 migration pin scoped to Phase 18 only).

## 3. Schema & migration

Three additive schema additions, no destructive DDL, no backfill:

- `enum TeacherApplicationStatus { PENDING APPROVED REJECTED ACTIVATED }`.
- `TeacherApplication` — `email @unique` (one application per canonical identity),
  `name/phone/specialty/bio`, `status @default(PENDING)`, `adminNote`,
  `reviewedByUserId/reviewedAt` (audit of who reviewed when), `userId String? @unique`
  (set **only** at activation), `createdAt/updatedAt`, index `[status, createdAt]`.
- `TeacherActivationToken` — `tokenHash @unique` (SHA-256 of the emailed secret;
  the raw token is never persisted), `expiresAt`, `usedAt`, `applicationId`
  (**not** unique — mirrors `PasswordResetToken`, so reject → re-apply →
  re-approve can re-mint), index `[applicationId, usedAt]` + `[expiresAt]`.

The migration is `CREATE TABLE IF NOT EXISTS` + guarded indexes only (no
`DROP`/`ALTER`/`DELETE`/`UPDATE`), and is re-entrant by construction
(`IF NOT EXISTS`). The two tables are excluded from the shared runner's base
derivation so they are created exactly once by this migration.

Re-use, not duplication: activation token storage/lookup/consumption mirrors
`PasswordResetToken` (cryptographically random secret, SHA-256 stored,
short-lived, single-use); sessions and password hashing remain in
`src/lib/auth.ts`; abuse protection remains the one shared limiter.

## 4. Application lifecycle (smallest safe model)

```
PENDING ──approve──▶ APPROVED ──activate──▶ ACTIVATED (User born, role TEACHER)
   │                    │
   └────reject──▶ REJECTED ◀──reject──────┘   (token rescinded on reject)
                     │
                     └──re-apply──▶ PENDING (same row, one identity forever)
```

Illegal transitions are impossible by construction (no code path exists):

- `PENDING → login` — no `User` row exists, so `login` answers 401.
- `PENDING → ACTIVATED` — activation requires an `APPROVED` application + live token.
- `REJECTED → APPROVED` — approve refuses `REJECTED` with 409 (`api.264`).
- `ACTIVATED → APPROVED/REJECTED` — both refuse `ALREADY_ACTIVATED` with 409.
- `ACTIVATED → same-token re-creation` — `usedAt` is stamped in the same
  transaction that creates the `User`; a consumed/expired/wrong token is 400.
- `public → APPROVED` — the public submit endpoint writes `PENDING` only and
  never reads a client-supplied status.

Re-application policy: a `REJECTED` application re-opens the **same** row as
`PENDING` (one row per canonical email identity for the table's lifetime), so
there can never be two conflicting active/pending applications for one email.
An email already owned by a `User` of **any** role (Student, Parent, Admin,
Teacher) is refused without mutating that account.

## 5. Public registration behavior

`POST /api/auth/register` with `role = TEACHER`:

- Validates name/email (same canonicalization: lowercase + trim), rate-limits
  per canonical email (`teacherApply`), optionally validates an Egyptian phone.
- Calls `submitTeacherApplication` → `PENDING` row. **No** `db.user.create`,
  **no** `createSession`, **no** role assignment. The client-provided `status`
  and `role` fields are ignored (the response echoes `applied: true` only).
- Every refusal returns the **same** generic 409 `api.258`
  ("already registered or has a pending application") whether the email is an
  existing account, a pending application, an approved application, or an
  activated teacher — no existence/enumeration oracle.
- `role = ADMIN` stays blocked (400, `api.059`); `STUDENT`/`PARENT` flows are
  untouched (unchanged code path, re-pinned by tests).

## 6. Approval & rejection authorization

Both mutations run `requireRole("ADMIN")` first (401 anonymous / 403 any other
role), then use the **server-derived** `user.id` as `reviewedByUserId` — never a
client-supplied id/role/status. They are:

- **IDOR-safe**: authorization runs before existence, so a non-admin probing a
  bogus id gets 403 (not 404) — the endpoint does not confirm existence.
- **Idempotent**: re-approving an `APPROVED` application returns
  `alreadyApproved: true` and does **not** re-mint the token or re-send email;
  re-rejecting a `REJECTED` application returns `alreadyRejected: true`.
- **Auditable**: `TEACHER_APPLICATION_APPROVED` / `TEACHER_ACTIVATION_ISSUED` /
  `TEACHER_APPLICATION_REJECTED` events with the application id and a
  **masked** destination (`maskEmail`) — never the secret, never SMTP credentials.
- **Privilege-preserving**: approval creates **no** User, assigns **no**
  password; rejection creates **no** Teacher and rescinds any live token.
- **No self-approval**: the applicant is anonymous pre-activation (no account),
  so they cannot approve themselves; a Teacher account cannot approve anything
  (no administrative capability is granted — default NO).

The legacy `POST /api/admin/teachers` (admin provisioned active Teacher with a
password) remains untouched and is now **not** the public path; the public path
is exclusively Application → Approval → Activation.

## 7. Activation mechanism

`POST /api/auth/teacher-activate` (public) takes `{ token, password }`:

- Token looked up by `sha256(token)`; raw token never persisted or logged.
- Single-use: `usedAt` is stamped by a guarded `updateMany` **inside the same
  transaction** that creates the `User`/`Teacher` and flips the application to
  `ACTIVATED` — a concurrent or replayed consume loses the race and fails.
- Expired tokens are rejected (and consumed) — `expiresAt` from
  `TEACHER_ACTIVATION_TTL_HOURS` (default 72 h).
- The applicant sets their **own** password (min length enforced) via
  `hashPassword` — no default/hardcoded password, no password in any response.
- A token can only activate **its own** application (`applicationId` binding),
  and only while that application is `APPROVED`.
- **No auto-login**: the response is `{ ok: true, message }`; the new teacher
  signs in afterwards (verified: the activation response carries no user and no
  session cookie).
- Uniform 400 `api.261` for unknown / used / expired / wrong-application tokens
  (indistinguishable); per-IP and per-token rate limits cap guessing.

## 8. Rate-limit protection

Reuses the existing Phase 20 architecture — no second system:

- Public submission: `applyRateLimitForIdentifier("teacherApply", email)` →
  the shared pure policy + DB-backed `checkRateLimit`; identifier SHA-256-hashed
  (`rl:teacherApply:<hash>`), default `5 / 3600 s / 3600 s`, env
  `RATE_LIMIT_TEACHER_APPLY`, clamped, never disableable.
- Activation: `checkRateLimit("teacheract:ip", hashIp(ip), 20, 3600)` and
  `checkRateLimit("teacheract:token", sha256(token), 5, 3600)` — invalid-token
  guessing and bulk attempts are bounded; refusals are 429 with `Retry-After`
  + `X-RateLimit-*` and audited as `TEACHER_ACTIVATION_FAILED`.

## 9. Audit events

Seven `SecurityEvent` types added (all written through the existing
`logSecurityEvent`, never a password, never a raw token):

| Event | When |
|---|---|
| `TEACHER_APPLICATION_SUBMITTED` | public application created / re-opened |
| `TEACHER_APPLICATION_BLOCKED` | duplicate / existing-account / activated refusal |
| `TEACHER_APPLICATION_APPROVED` | admin approval (masked destination, delivery outcome) |
| `TEACHER_ACTIVATION_ISSUED` | activation link minted + emailed |
| `TEACHER_APPLICATION_REJECTED` | admin rejection (with `alreadyRejected` flag) |
| `TEACHER_ACTIVATION_COMPLETED` | applicant's account created via token |
| `TEACHER_ACTIVATION_FAILED` | invalid/expired/replayed token or rate-limit block |

Verified: no event detail contains a password or the raw `teacherActivation=`
token.

## 10. Duplicate & replay protection

- One application per canonical email (`email @unique`); existing `User`
  (any role) refuses; a live PENDING/APPROVED application refuses; a REJECTED
  application re-opens in place.
- One live token per application at a time (unused tokens are retired when a
  new one is minted or when the application is rejected); the token is
  SHA-256 stored, single-use, expiring, and bound to its application.
- Replay: consumed/expired/wrong tokens all answer 400 and never create a
  second account (verified against a real DB).

## 11. Authorization matrix (extended)

| Actor | Submit application | Create Teacher account | Approve | Reject | List applications |
|---|---|---|---|---|---|
| Public (anonymous) | ✅ (PENDING only) | ❌ (only via own activation token) | ❌ 401 | ❌ 401 | ❌ 401 |
| Student / Parent | — (already has an account) | ❌ | ❌ 403 | ❌ 403 | ❌ 403 |
| Teacher | ❌ (email already owned) | ❌ | ❌ 403 | ❌ 403 | ❌ 403 |
| Admin | — | ❌ (cannot set anyone's password) | ✅ server-side | ✅ server-side | ✅ |

Public can **only** submit; no actor can assign `role = TEACHER` or a password
other than the applicant themselves; no non-admin can approve/reject or reach
the review queue; a Teacher holds no administrative capability.

## 12. IDOR & mutation-proof tests

Source invariants (`tests/teacher-application-phase20.test.js`) + behavioural
checks in the verifier cover:

- Non-admin approve/reject → 401/403; non-admin list → 403.
- Bogus application id from a non-admin → 403 (no existence oracle).
- Approve/reject use the server-derived admin id, never a client id/role/status.
- TEACHER registration never calls `createSession`, never `db.user.create`,
  never assigns `role: "TEACHER"`, never reads `body.status`/`body.role`.
- Approve never calls `hashPassword`, never returns a password, never creates a
  User; the approve response and audit contain no secret.
- Changing application ids / role / status fields does not escalate (enforced
  server-side; client values ignored).
- Applicants cannot approve themselves (anonymous pre-activation) or activate
  before approval (token is only minted on approval).
- Activation token cannot be reused, used after expiry, or used for another
  application.

## 13. Real database verification

`scripts/verify-phase20-teacher.mjs` applies the **real** base DDL + every real
migration (including `20260912000000_phase20_teacher_applications`) to a real
`node:sqlite` database, compiles the shipped `teacher-applications.ts`,
`auth.ts`, `security.ts`, `rate-limit.ts`, `api.ts` and the five route handlers
(`auth/[action]`, `auth/teacher-activate`, and the three `admin/teacher-applications`
routes) with `tsc`, and drives them over a real `node:http` server with real
`fetch` traffic. The only substitutions are the transport shims (`@/lib/db` → the real
SQLite Prisma-lite adapter; `@/lib/delivery` → an email capture that reads the
raw activation link back the way an inbox would; `next/server`/`next/headers`
→ minimal equivalents). The shipped logic runs unmodified.

Asserts against real rows: PENDING application with no `User`/session; one
application row across duplicates; existing STUDENT not mutated; ADMIN
registration blocked; approve → `APPROVED` + `reviewedByUserId` + one email with
a link + a `TeacherActivationToken` row whose `tokenHash === sha256(secret)`;
idempotent re-approve (no second email, still one live token); reject →
`REJECTED` + no account; re-apply reopens the same row as `PENDING`; activation
→ `User(role TEACHER)` + `Teacher` + `ACTIVATED` + consumed token; token replay
→ 400 with still exactly one account; expired token → 400 with no account;
login fails before activation (401) and succeeds after (200 + session cookie +
`/me` role TEACHER); the new teacher cannot approve others; the seven audit
event types exist and no event leaks a password/raw token.

**Result: 71 passed, 0 failed — `PHASE20_TEACHER_OK`.**

## 14. Real HTTP verification

The same verifier's HTTP layer exercises the real endpoints end-to-end:

- `POST /api/auth/register` (TEACHER) → 200 `{applied:true}`, no user/session.
- duplicate/existing/ADMIN cases → 409 / 409 / 400.
- anonymous/STUDENT/TEACHER approve, reject, list → 401 / 403.
- `POST …/approve` (ADMIN) → 200, email captured, token extractable.
- `POST /api/auth/teacher-activate` → 200 for the valid token, 400 for
  unknown/expired/replayed/short-password.
- `POST /api/auth/login` → 401 pre-activation, 200 post-activation (real
  `UserSession` row + `cm_session` cookie through the real `createSession`).
- `GET /api/auth/me` → 200 with `role = TEACHER` after login.

**Result: the full chain (submit → approve → activate → login) is proven over
real HTTP with real cookies and real sessions — not unit-only.**

## 15. Full regression status

All top-level suites re-run, all green (0 failures across 26 files):

- `tests/teacher-application-phase20.test.js` — **75 passed**.
- `tests/security-hardening-phase20.test.js` — **188 passed** (limiter-key pin 6→7).
- `tests/security-hardening.test.js` — **274 passed** (TEACHER self-registration pin).
- `tests/teacher-workflow-phase18.test.js` — **365 passed** (Phase-18 migration pin scoped).
- `tests/authorization-invariants.test.js` — 93; `tests/migration-sql.test.js` — 15;
  `tests/seed-idempotency.test.js` — 18; plus the remaining 19 suites unchanged and green.

Verifiers: `verify-phase20-security.mjs` 42/42 (`PHASE20_VERIFY_OK`),
`verify-phase20-http.mjs` 26/26 (`PHASE20_HTTP_OK`),
`verify-phase20-teacher.mjs` 71/71 (`PHASE20_TEACHER_OK`).

## 16. Typecheck / build / migration / lint status

- `tsc --noEmit`: **baseline-identical** — 26 pre-existing errors, all caused by
  the stale generated Prisma client (e.g. `api.ts(6,15)` missing `Role`) and the
  sandbox's missing DOM/Next ambient context; the new files add no new
  error class. (The verifiers compile the shipped modules cleanly enough to
  emit and execute them.)
- `prisma generate` / `prisma migrate` / full `next build`: **sandbox-blocked**
  identically to Phases 6–19 (`binaries.prisma.sh` TLS disconnect). The
  migration itself is applied and column-checked by the real verifier.
- `npm run lint`: unchanged baseline (134 problems, none in the new files).

## 17. Known pre-existing failures

Identical to the original Phase 20 report §20: Prisma engine download blocked
(no client regeneration; `next dev`/`build`/`migrate` unavailable here);
26 `tsc` / 134 eslint findings are the environmental baseline; AV not
integrated (ADR-004 posture only); CSP `unsafe-inline` retained for Next.js
bootstrap + inline styles.

## 18. Strict boundary

This addendum provisions identity and hardens authorization only. It does not
implement teacher curriculum authoring, lesson/homework workflow, analytics, or
dashboard UX beyond the review queue, and it does not touch Phase 18
functionality. The production baseline still provisions a real Teacher
legitimately and auditably through Application → Admin Approval → Secure
Activation → Teacher Account — nothing is bypassed and no password is
hardcoded.

---

Separate pre-merge audit required.
