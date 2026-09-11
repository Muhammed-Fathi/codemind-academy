# PRE-PHASE-21 SECURITY AUDIT GATE

**Repository:** `Muhammed-Fathi/codemind-academy`
**Base commit:** `f3a46bd2c7bd42f6c57dba48d850f6a20b573fb` (`main`, Phases 11–20 merged)
**Audit branch:** `arena/01a08ded-codemind-academy`
**Date:** 2026-09-11
**Mode:** AUDIT → FINDINGS → REMEDIATION → TEST → REPORT → **STOP**
**Status:** complete, **not merged**, awaiting external review (draft PR #43)

This document is the gate report. It is **not** Phase 20 rework and it is **not** Phase 21 or 22 work. No schema change, no storage migration, no authentication redesign, no dependency churn, and no new roadmap phase was created.

---

## 1. Executive summary

The gate discovered **8 findings**: **2 Critical**, **3 High**, **3 Medium**. All 8 were remediated in the working tree. **Zero Critical and zero High findings remain open.** Two additional Medium-severity posture risks are **accepted and documented** rather than fixed, because each is an operator/deployment decision rather than a code defect, and fixing them would breach the "no speculative controls" constraint.

The single most severe finding was **F-01**: the database seeder created four demo accounts with passwords hardcoded in the repository (`admin123`, `teacher123`, `student123`, `parent123`), and `docs/DEPLOYMENT_GUIDE.md` made `bun run scripts/seed.ts` a **mandatory** first-deploy step. Every deployment that followed the documentation therefore shipped a **publicly known ADMIN password** — full platform compromise, including every student's national ID, phone number and academic record, and every admin mutation.

The second was **F-02**: `POST /api/auth/login` — the only unauthenticated endpoint that mints a session — had **no rate limit whatsoever**, while the two comparable unauthenticated credential endpoints (password reset, teacher activation) both did. The platform was one `for` loop away from credential stuffing.

**Verification totals** (all reproducible from a clean checkout; see §30–§33):

| Evidence | Result |
|---|---|
| `scripts/verify-security-audit-gate.mjs` (real HTTP) | **71 passed, 0 failed** — `SECURITY_AUDIT_GATE_HTTP_OK` |
| `scripts/verify-security-audit-gate-browser.mjs` (browser subsystems) | **43 passed, 0 failed** — `SECURITY_AUDIT_GATE_BROWSER_OK` |
| `tests/security-audit-gate.test.js` (new offline suite) | **103 passed, 0 failed** |
| `tests/*.test.js` — 27 suites | **all exit 0**, **4,570 assertions**, 0 failures |
| `scripts/verify-phase*.mjs` — 10 scripts | **all exit 0** |
| Typecheck | 27 `error TS` — **byte-identical to pre-change baseline** |
| Lint | 134 problems — **identical to pre-change baseline** |

---

## 2. Scope and method

**Source of truth:** the entire current repository — `src/`, `src/app/` (98 API route files), `src/lib/`, `scripts/`, `tests/`, `prisma/schema.prisma`, `prisma/migrations/*` (9 migrations), `package.json`, `next.config.ts`, `src/proxy.ts`, `Caddyfile`, `.env.example`, `docs/`.

**Method.** Discovery was a full read of the authorization, session, rate-limiting, upload, notification and enrollment primitives, then a route-by-route review of all 98 API handlers, then targeted exploitation attempts against the working tree. Every candidate finding was reproduced before it was written down and re-tested after it was fixed. Nothing in this report is inferred from a pattern match alone; §10 of the offline suite records the *verified non-exposures* — the things a checklist would have flagged that turned out, on inspection, not to be vulnerabilities.

**Severity model.** *Critical* = unauthenticated or trivially reachable full compromise, or mass exposure of student personal data. *High* = authenticated bypass of an authorization boundary, or exposure of another user's data. *Medium* = meaningful weakening of a control, or a defect that requires a precondition. *Low/Info* = posture, documentation, defence-in-depth.

**Constraints honoured.** No platform redesign. No new authentication architecture. No SQLite→PostgreSQL migration. No media-storage migration. No Phase 21 durable-storage/backup/retention work and no Phase 22 go-live work. No `db push` / `db reset`. No WAF, SIEM or AV. No dependency changes. Nothing merged.

---

## 3. Threat model

**Assets.** Student personal data (name, email, phone, national ID, school type, guardian linkage), academic performance (quizzes, mock exams, attendance, study plans, XP/leaderboard), teacher and admin accounts, session tokens, password-reset and teacher-activation tokens, uploaded media and session materials, payments and subscription records, the SMTP credential.

**Actors.**
- **A1 — Anonymous internet attacker.** Reaches only the unauthenticated endpoints: login, register, password-reset request/confirm, teacher application/activation, public settings.
- **A2 — Authenticated student.** The largest population and the most security-relevant: a paying minor with legitimate access to part of the platform and a strong incentive to read or alter other students' data and their own academic record. Every IDOR in this report is A2.
- **A3 — Authenticated teacher.** Legitimate access to their own courses; must not reach other courses or admin surfaces.
- **A4 — Authenticated parent.** Scoped strictly to their own linked children.
- **A5 — Insider / compromised low-privilege account.** Covers privilege escalation from STUDENT/TEACHER/PARENT to ADMIN.
- **A6 — Malicious or accidental operator.** Covers seeded credentials, `.env` handling, deployment defaults.

**Trust boundaries.**
1. **Client → Next.js app.** Everything from the browser is untrusted, including every header. `X-Forwarded-For` is attacker-controlled unless a trusted proxy rewrites it (see F-07).
2. **Next.js app → Caddy/nginx.** The reverse proxy terminates TLS and sets `X-Real-IP` unconditionally; the app must know which headers it may trust.
3. **App → SQLite / filesystem.** All persistence. Parameterized throughout; no raw SQL with concatenation exists anywhere in `src/` (verified in §10).
4. **App → external services.** SMTP for password reset, plus the YouTube/Vimeo lesson embeds and the AI quiz generator.
5. **App → media storage.** `/api/media/[id]` and `/api/materials/[id]` re-authorize on every request; storage is reference-counted.

**Out of scope by instruction:** DDoS at the network layer, physical/host security, and the Phase 21 durability work (backups, retention, PostgreSQL).

---

## 4. Findings register

| ID | Severity | Area | Finding | Status |
|---|---|---|---|---|
| **F-01** | **CRITICAL** | §15 Secrets / §23 Seeding | Seeder ships four hardcoded demo passwords; seeding is a mandatory documented deploy step → public ADMIN password on every deployment | **FIXED** + verified |
| **F-02** | **CRITICAL** | §1 Auth / §21 Rate limiting | `POST /api/auth/login` has no rate limit — unlimited credential stuffing against the session-minting endpoint | **FIXED** + verified |
| **F-03** | **HIGH** | §5 IDOR | `PATCH /api/students/me/study-plan` updates `StudyTask` by id alone — any student rewrites any other student's study plan and receives the victim's row back | **FIXED** + verified |
| **F-04** | **HIGH** | §2 Authorization | `POST /api/enroll` never binds `groupId` to `courseId` — cross-course enrollment, and a seat the group owner never sold | **FIXED** + verified |
| **F-06** | **HIGH** | §18 Privacy / §25 DoS | `GET /api/students/me/leaderboard` returns **every** student in the platform (name, email, avatar, XP, level, streak) to any authenticated student, with no bound and an `N+1` per row | **FIXED** + verified |
| **F-05** | MEDIUM | §9 Headers / §12 Transport | No HSTS — a downgrade/strip-SSL window on first contact and on any HTTP-only asset | **FIXED** + verified |
| **F-07** | MEDIUM | §24 IP trust | Client IP read as the **first** `X-Forwarded-For` hop — directly spoofable, weakening every IP-bucketed limiter | **FIXED** + verified |
| **F-09** | MEDIUM | §22 Password policy | Password minimum is 6 on register and on admin-provisioned accounts, 8 everywhere else — an admin-provisioned TEACHER is never forced to change it | **FIXED** + verified |
| F-08 | — | — | *Absorbed into F-02 during remediation* (it was the IP bucket of the same login limiter). Numbering left unchanged. | n/a |

**Accepted and documented (Medium, not fixed — see §36):**
- **R-1** — No explicit CSRF `Origin` check on cookie-authenticated mutations. Mitigated by `SameSite=Lax` **and** by the fact that every state-changing endpoint requires a JSON body, which a cross-site HTML `<form>` cannot produce. Both mitigations are now proven, not assumed (§31).
- **R-2** — The `Caddyfile` still exposes a plain-HTTP `:81` listener. HSTS is now emitted at the application (§9), so the app commits to HTTPS, but the operator should retire `:81` or keep it redirected only.

---

## 5. §1 — Authentication

**Audited.** `src/lib/auth.ts`, `src/app/api/auth/[action]/route.ts`, password reset, teacher activation, `src/proxy.ts`, `src/lib/route-protection.ts`.

**Confirmed strong (no change made).** Passwords use **scrypt** with a per-password random salt and a constant-time comparison. Sessions are opaque 32-byte random tokens; only the **SHA-256 hash** is stored, so a database read cannot be replayed as a session. There is no legacy/unsigned-token fallback path. Login returns an identical `401` body for "unknown account" and "wrong password", and it consumes the same rate-limit budget for both, so it is **not an account-existence oracle** (re-verified after F-02 in §10). Inactive and non-`ACTIVE` accounts are rejected with `403` before any session is minted.

**Finding F-02 (CRITICAL) — no login throttle.** Before this gate, `checkRateLimit` protected password-reset request and confirm, and teacher activation, but **not login**. Login is the only unauthenticated endpoint that *issues* a credential. Exploitability: trivial and anonymous; a single client could attempt thousands of password guesses per minute against any known or guessed email.

**Remediation.** Two independent buckets on the existing shared, DB-backed `SecurityRateLimit` primitive, applied **before** the credential is checked:

- `login:id` — keyed on the **SHA-256 of the lowercased submitted email**, whether or not that account exists. 10 attempts / 15 min, 10 min block. Non-spoofable, so it stops a distributed attack on one account. **Cleared on successful login** (`resetRateLimit`), so a legitimate user who mistypes is never penalised by their own history.
- `login:ip` — keyed on `hashIp(clientIpFromHeaders(...))`. 40 attempts / 10 min, 15 min block. Stops one source spraying many accounts.

Both return the **same** `429` shape as every other limiter in the platform — machine `code: RATE_LIMITED`, a human message (`api.202`), and a `Retry-After` header — so a client cannot fingerprint which limiter fired. Both write a `LOGIN_FAILED` `SecurityEvent`.

**Security benefit:** turns an unbounded anonymous guessing oracle into a bounded one, without weakening legitimate access. **Minimal scope:** reuses the shipped primitive, adds no new table, no new dependency, no new middleware. **Backward compatible:** the success path is byte-identical; only throttled requests see a new status code. **No business regression:** proven by the full regression suite (§32). **Test coverage:** HTTP §2 (10× 401 → 429 with `Retry-After`; no existence oracle; no collateral damage; success clears the bucket) and offline §2.

---

## 6. §2 — Authorization and privilege escalation

**Audited.** `src/lib/api.ts` (`requireUser`, `requireRole`, `requireAdmin`), `src/proxy.ts`, `src/lib/route-protection.ts`, all `/api/admin/*` handlers, `src/lib/track-scope.ts`, `src/lib/curriculum-visibility.ts`, `src/lib/parent-access.ts`, `src/lib/enrollment.ts`.

**Confirmed strong.** Authorization is re-derived **per request** from the session, never taken from a client-supplied role field. `requireAdmin` gates every `/api/admin/*` handler. Parent access resolves through the `ParentChild` link table rather than a posted `studentId`. Teachers are scoped to their own courses. Student content access is derived from `Student.group → Group.courseId` plus the school-type track scope, not from a posted id.

**Finding F-04 (HIGH) — unbound course/group pair in enrollment.** `POST /api/enroll` validated `planId` and checked that the group exists and is active, but **never checked that `groupId` belongs to `courseId`**. After this gate's tests: posting any active group id from *any* course succeeded. Because enrollment is subsequently derived from `Student.groupId → Group.courseId`, that single unchecked id immediately granted the curriculum of a different course (any lesson whose track scope the student's own school type admits), consumed a seat in a group the owner never sold, and mis-attributed the payment record.

**Exploitability:** one authenticated request, no guessing — group ids are visible to any student. **Impact:** paid-content bypass plus a denial of a seat to a legitimate buyer.

**Remediation.** The `Course` is now looked up first (404 if absent), the `Group` is fetched with `courseId`, and the pair is validated together: `if (group.courseId !== course.id) return err(tApi("api.085"), 400)`. The refusal reuses the existing "group not available" message so it never confirms which ids are real.

**Residual observation (documented, not changed):** `POST /api/admin/ai-generate-quiz` lives under `/api/admin` but permits `TEACHER`. It is course-checked, so it is **not** a privilege escalation, but the path is misleading. Left as-is: moving it is an API-shape change with no security benefit and would break the shipped client.

---

## 7. §3 — API and route audit

All **98** route handlers under `src/app/api` were reviewed for: authentication presence, role check presence, ownership scoping on every resource id, HTTP-method correctness, and response shape.

**Result.** Every handler either (a) calls `requireUser`/`requireRole`/`requireAdmin`, or (b) is deliberately public (`auth/login`, `auth/register`, `auth/teacher-apply`, `auth/password-reset/*`, `auth/teacher-activate`, `settings`, `public/*`). No handler was found that performs a privileged action without an authorization call. No handler reads a role from the request body. Mutations use `POST`/`PUT`/`PATCH`/`DELETE`; no state change happens on `GET`.

Three handlers were fixed as a result of this pass — F-03 (§8), F-04 (§6), F-06 (§12) — plus three for F-09 (§22).

---

## 8. §4 — Input validation and mass assignment

**Confirmed strong.** Every handler that persists user input builds an **explicit field allow-list** rather than spreading `req.json()` into a `create`/`update` — there is no mass-assignment sink in the codebase. Role, `isActive`, `status`, `emailVerified` and balance-style fields are never accepted from a client. Zod is used on the structured validation paths (`src/lib/validation.ts`) and `isValidEmail` gates every email input. `src/lib/registration.ts` enforces the school-type and track rules. Ids are validated for presence and shape; enum-ish values are checked against the allowed set.

**Finding F-09 (MEDIUM) — inconsistent password floor.** The server accepted **6** characters on `POST /api/auth/register`, `POST /api/admin/students` and `POST /api/admin/teachers`, while `password-reset/confirm` and `teacher-activate` required 8, and the client-side registration form already refuses fewer than 8. `scripts/setup-production.ts` also accepted 6 for the **production admin**.

**Impact:** the client-side floor was advisory only — a direct API call bypassed it. An admin-provisioned teacher account is privileged and is **never forced to change this password**, so a 6-character credential could persist indefinitely.

**Remediation.** One platform minimum of **8 characters**, enforced server-side at: register, `admin/students`, `admin/teachers`, `password-reset/confirm`, `teacher-activate`, and `scripts/setup-production.ts`. The client forms already matched. The message key `api.204` is reused so the wording is identical everywhere.

---

## 9. §5 — Insecure Direct Object Reference (IDOR)

**Finding F-03 (HIGH) — `PATCH /api/students/me/study-plan`.** The route resolved the caller's `Student` row correctly and *then* called `db.studyTask.update({ where: { id: taskId } })`, with no ownership predicate. Any authenticated student could PATCH another student's task id to rewrite its title, date and duration **and receive the victim's full row back in the response** — a read primitive and a write primitive in one call. A guessed id also raised an unhandled Prisma `P2025`.

This was the last write in the student surface that updated a row by id alone; the sibling operations in the *same file* (`DELETE`) and in `/api/students/me/notes` (`PATCH`) already scoped by `studentId`. It had simply drifted.

**Remediation.** `updateMany({ where: { id: taskId, studentId: student.id }, data })` — atomic, and non-enumerable: a task that is not the caller's own answers `404` exactly like one that does not exist. The row is then re-read for the response.

**Verification.** HTTP §4 proves the **victim's row is provably unchanged** after the attack, that the attacker gets `404`, and that the legitimate owner can still PATCH (no regression).

**Everything else in this class was already correct.** `/api/media/[id]` and `/api/materials/[id]` re-authorize on every request. `/api/students/me/notes` scopes by `studentId`. Parent dashboard, parent analytics and parent monthly report resolve through `ParentChild`. Teacher handlers scope quizzess, questions, attendance and analytics to the teacher's own courses. Mock-exam grading is isolated by the existing `mock-exam-grading-isolation` suite (22 assertions, passing).

---

## 10. §6 — Teacher application and activation

**Audited.** `src/lib/teacher-applications.ts`, `/api/auth/teacher-apply`, `/api/auth/teacher-activate`, `/api/admin/teacher-applications*`, and the `TeacherApplication` / `TeacherActivationToken` models.

**Confirmed strong (no change made).** The application flow is unauthenticated but rate-limited and validated. Activation tokens are 32 random bytes, stored **only as a SHA-256 hash**, single-use, and consumed with a **conditional atomic update** (`updateMany` on a non-consumed, non-expired token) so two concurrent redemptions cannot both succeed. Expiry is enforced server-side against `TEACHER_ACTIVATION_TTL_HOURS`. Replay, expired-token and rejected-application paths all fail closed.

**Verification.** HTTP §7 exercises the complete chain end-to-end: submit → approve → activate → **replay rejected** → expired rejected → rejected-application rejected.

**Change made here:** `teacher-activate` now derives its rate-limit IP key through `clientIpFromHeaders` (F-07). No behavioural change to the flow itself.

---

## 11. §7 — Session, cookie and CSRF

**Confirmed strong (no change made).** Session cookies are set with `httpOnly`, `sameSite: "lax"`, `path: "/"`, and `secure` when `NODE_ENV === "production"`. There is no `document.cookie`-readable session material. Logout deletes the row server-side; `revokeAllSessions` is invoked on password reset and password change, so a stolen password cannot keep an old session alive. `deviceHash` binds a session to a UA fingerprint for anomaly visibility.

**CSRF analysis (R-1, accepted).** The question the gate was asked to answer — *do cookie-authenticated state-changing requests require token protection?* — is answered **no, and here is the proof**:

1. The session cookie is `SameSite=Lax`, so it is **not sent on any cross-site POST**. Proven in §31 with a real RFC-6265bis cookie engine (`tough-cookie` v6) fed a **real `Set-Cookie`** produced by the **real compiled login handler**: a same-site request carries the session; a cross-site POST sends an **empty** `Cookie` header.
2. Independently, **every** state-changing endpoint requires a JSON body (`Content-Type: application/json`), which a cross-site HTML `<form>` cannot produce, and the served shell contains **no HTML form at all**. A cross-origin `fetch` with a JSON content type is blocked by CORS preflight (§13).

Both controls must fail before an attack is possible; neither is bypassable by the attacker. Adding a token framework would therefore be a speculative control with no threat behind it, and was **not** added.

---

## 12. §8 — CORS, origin and host

**Confirmed strong.** There is no blanket `Access-Control-Allow-Origin: *`. No wildcard `Access-Control-Allow-Credentials` pair exists — the classic credentialed-CORS mistake is absent. `src/lib/redirects.ts` validates every redirect/deep-link target against an allow-list instead of echoing a posted URL, which closes both open-redirect and the OAuth-style leak. Notification deep links are validated the same way. `next.config.ts` sets `poweredByHeader: false`, and §31 asserts the `X-Powered-By` header is absent on a real response. No complexity was added here — the existing posture is correct and self-consistent.

---

## 13. §9 — Security headers

**Audited.** `next.config.ts` and `src/lib/content-security-policy.ts`.

**Already present and correct:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, and a structured, configurable CSP with `CSP_REPORT_ONLY` and `CSP_DISABLED` operator switches.

**Finding F-05 (MEDIUM) — no HSTS.** Absent HSTS, a browser's very first contact and any HTTP-only asset can be served over cleartext, and an active network attacker can strip TLS before the redirect to HTTPS happens.

**Remediation.** `Strict-Transport-Security: max-age=15552000; includeSubDomains` (180 days) emitted for **every** response, matching the shape of the existing header block. Justification for emitting it unconditionally: every supported deployment terminates TLS in front of the app (Caddy / nginx / Vercel — `docs/DEPLOYMENT_GUIDE.md` §6) and redirects HTTP → HTTPS, so the app only ever answers on an HTTPS origin; and browsers honour HSTS **only** on a secure response, so emitting it on a hypothetical cleartext response is inert rather than harmful. **`preload` is deliberately omitted** — it is a one-way door submitted to browser vendor lists and is not reversible by the operator. An `HSTS_DISABLED=1` kill-switch is provided, shaped exactly like the existing `CSP_DISABLED`.

**Verification.** HTTP §5 asserts the header is present, and that `HSTS_DISABLED=1` removes it (so the operator is never trapped). Browser §1 asserts it arrives on a real document response.

**CSP calibration (§31).** `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`, `default-src 'self'`, `connect-src 'self'`, `media-src 'self'` (so `/api/media/[id]` playback keeps working), `frame-src` restricted to the YouTube/Vimeo hosts the legacy lesson embeds use, and **no `unsafe-eval` in production**. `script-src` retains `'unsafe-inline'` because the Next.js RSC bootstrap requires it — this is a documented, deliberate calibration, not an oversight, and §31 proves it is genuinely required by executing a real inline bootstrap script in a real document.

---

## 14. §10 — File upload and storage

**Audited.** `/api/media/*`, `/api/materials/*`, `src/lib/media.ts`, `src/lib/session-materials.ts`, `src/lib/uploads.ts`.

**Confirmed strong (no change made).** Uploads are gated by role (teacher/admin). Size and MIME type are validated server-side against an allow-list; the client's `Content-Type` is not trusted as the sole authority. Uploaded bytes are written under a **generated** name, never a client-supplied path — there is no path-traversal sink. Serving goes through `/api/media/[id]`, which **re-authorizes on every request** rather than exposing a static directory, so knowing a URL is not authorization. Media cleanup is **reference-counted**, so deleting a lesson does not orphan or leak a still-referenced asset, and does not silently retain a deleted one.

No AV integration exists and none was added — claiming scanning without a real engine would be a false control, and adding one was explicitly out of scope.

---

## 15. §11 — SSRF

**Audited.** Every outbound `fetch` in `src/`.

**Confirmed strong.** Outbound requests are limited to (a) the SMTP relay for password reset, (b) the AI quiz-generation provider, and (c) `isSafeExternalUrl()`-validated external URLs. `src/lib/redirects.ts` and the deep-link validator reject anything that is not relative or allow-listed, so no user-supplied URL is fetched. There is no webhook feature, no "fetch this URL and show me" endpoint, and no image-proxy endpoint. No speculative URL filtering was added where none was needed; §10 of the offline suite records this as a **verified non-exposure** rather than an untested assumption.

---

## 16. §12 — XSS and injection

**Confirmed strong.** All database access goes through Prisma with parameterized queries. A repo-wide search for raw SQL found **no string-concatenated SQL** anywhere in `src/`. React escapes by default; a search for `dangerouslySetInnerHTML` and `eval` found no unsafe sink fed by user input. The one intentional inline-style generator (`src/lib/chart-colors.ts`) derives values from a fixed palette with no user text.

Injection vectors are additionally contained by the CSP in §13 (`object-src 'none'`, no `unsafe-eval` in production, `script-src` restricted to `'self'`), and §31 asserts the served document contains **no** inline event-handler attributes and **no** `javascript:` URLs.

---

## 17. §13 — Database security

**Audited.** `prisma/schema.prisma`, all 9 migrations, `src/lib/db.ts`, and every model write path.

**Confirmed strong.** Parameterized access throughout (§16). Cascade behaviour is declared in the schema and matches the intent. Soft-delete / status flags are used consistently. `SecurityRateLimit` is keyed by an **opaque hash**, never by a raw email or IP (verified explicitly in HTTP §12), so even a full table read does not reconstruct who was throttled.

**Migration safety (see also §34).** `git diff --stat -- prisma/` is **empty**. No model was changed, no migration was added, and **no `db push` or `db reset` was run**. The 9 existing migrations remain the single source of truth, and the real-HTTP harness builds its database by applying that **real migration history** to a real `node:sqlite` instance — so every HTTP assertion in this report ran against the genuine production schema, not a hand-rolled approximation.

---

## 18. §14 — Race conditions, replay and idempotency

**Confirmed strong (no change made).** `checkRateLimit` in `src/lib/security.ts` performs its read-modify-write inside a transaction-compatible critical section, so concurrent requests cannot both observe and increment the same counter — there is no classic check-then-act window. Password-reset and teacher-activation tokens are single-use and consumed with a **conditional atomic update**, so two simultaneous redemptions cannot both win (HTTP §7 proves the second is rejected). Seeding is idempotent (`seed-idempotency` suite, 18 assertions, passing). Payment and enrollment creation are guarded by uniqueness constraints rather than application-level checks.

The F-03 remediation deliberately used `updateMany` rather than `findUnique` + `update` precisely so that the ownership check and the write are one atomic operation.

---

## 19. §15 — Secrets and configuration

**Finding F-01 (CRITICAL) — seeded default credentials.** `scripts/seed.ts` created `admin@codemind.academy` / `admin123`, plus `teacher123`, `student123`, `parent123`. `docs/DEPLOYMENT_GUIDE.md` listed `bun run scripts/seed.ts` as a **mandatory** deployment step, and `docs/PROJECT_AUDIT.md` republished the credentials. `tests/i18n/audit-ui.mjs` also hardcoded them.

**Impact:** a public, guessable **ADMIN** password on every deployment that followed the documentation. Full compromise: every student record (name, email, phone, national ID), every academic record, every admin mutation, and the ability to provision further accounts. **Exploitability:** zero — the credentials are in a public repository's documentation.

**Remediation — a three-part contract, now enforced in code:**
1. `SEED_ADMIN_PASSWORD` / `SEED_DEMO_PASSWORD`, when set, are used **verbatim** and are **never printed back** to the console.
2. With `NODE_ENV=production` and no value for either variable, the seeder **refuses to create the account and exits 1**, with a message that shows the `openssl rand -hex 24` invocation. A production admin password is an operator secret, not a default.
3. Anywhere else (local dev, a throw-away database), a **cryptographically random** password (`randomBytes(16).toString("base64url")`, ≈128 bits) is generated and printed **once**, usable only on the database that was just seeded.

Both passwords are resolved **before** any database write, so a half-configured production run aborts without leaving demo rows behind. The seeder additionally warns, in production, that demo accounts exist and must be removed.

**Purge.** All four literals were removed from `scripts/seed.ts`, `scripts/setup-production.ts`, `docs/DEPLOYMENT_GUIDE.md`, `docs/PROJECT_AUDIT.md`, `docs/ADMIN_GUIDE.md`, `docs/DEVELOPMENT_GUIDE.md`, `docs/ADDING_FEATURES.md`, `docs/TROUBLESHOOTING.md`, `README.md` and `tests/i18n/audit-ui.mjs` — including inside explanatory comments, which the first pass missed and the test suite caught. `tests/i18n/audit-ui.mjs` now **reads** the two variables and exits `2` with a clear message if they are unset. A repo-wide grep (excluding `node_modules`) confirms **zero** remaining occurrences anywhere except the new audit suite's own assertion strings. `.env.example` documents the contract without any value.

**Other secrets — confirmed strong.** No secret is committed: `.env` is gitignored and untracked, and §35 asserts via `git ls-files` that **no** `.env*` file other than `.env.example` is tracked. `src/lib/env.ts` **fails closed** — it throws when `SECURITY_HASH_SECRET`, `DATABASE_URL` or the production SMTP set is missing or still set to the documented placeholder, so a misconfigured deployment refuses to start rather than silently degrading. `next.config.ts` runs `assertProductionEnv()` on load. No secret is logged; tokens are hashed before they touch the database or an event row.

**No real production secret was rotated** during this task, per instruction.

---

## 20. §16 — Error handling and information leakage

**Confirmed strong.** Handlers return structured errors from `src/lib/api.ts` with a stable machine `code` plus a localized human message; stack traces are not returned to clients. Login, password-reset request and teacher-application responses are deliberately **uniform**, so no response distinguishes "account exists" from "account does not exist". `maskEmail()` is used in reset responses rather than the full address. F-03's remediation also removed an unhandled Prisma `P2025` that previously surfaced as a 500 on a guessed id.

**Verified in HTTP §12:** no token value, no raw email and no raw IP is written to `SecurityEvent` or `SecurityRateLimit`.

---

## 21. §17 — Dependencies and supply chain

**Audited.** `package.json` (64 dependencies, 13 devDependencies) and the lockfile.

**No dependency was added, removed, upgraded or downgraded.** There is no dependency with a known Critical or High advisory that is reachable from an unauthenticated path, and no dependency churn was justified by any finding in this gate — every fix used code already shipping in the repository. A lockfile is committed and installs are reproducible (`npm ci`-equivalent). TODO/FIXME and `http://` literals were swept; no actionable finding.

---

## 22. §18 — Privacy and data exposure

**Finding F-06 (HIGH) — platform-wide student directory via the leaderboard.** `GET /api/students/me/leaderboard` executed an **unbounded `db.student.findMany()`** with no `where` clause, then ran `buildStats` per row, then returned the roster — including **name, email, avatar URL, badges, XP, level, streak, passes and completion counts** — to *any* authenticated student.

**Impact (two distinct harms).**
1. **Privacy:** a platform-wide directory of minors' identities and academic performance, across every course and both school tracks. This is the largest single data-exposure surface in the codebase, and it was reachable by the lowest-privilege, highest-population actor (A2).
2. **Availability:** an unbounded `N+1` (`buildStats` per row) over a table that grows with the whole platform, on an endpoint any student can call — a cheap resource-exhaustion lever.

A **secondary correctness defect** was found in the same handler: the caller's rank was computed by *matching the caller's display name against the roster* (`entries.find(e => e.name === user.name)`). Any student sharing a name with a higher-ranked peer was handed that peer's rank and stats.

**Remediation.** A leaderboard is a **class** board. It is now scoped to the students enrolled in the caller's **own course**, using the exact `Student.group → Group.courseId` rule that already decides content access, and capped at `LEADERBOARD_MAX_ROWS = 200`. Rank and stats now match on **`student.id`**, not display name.

**Security benefit:** the surface now exposes exactly the peers the student shares a classroom with — the minimum the feature needs — and the cost per request is bounded. **Minimal scope:** one `where` clause, one `take`, two id comparisons. **Backward compatible:** the response shape is unchanged. **No business regression:** a student with no active group gets an empty board (`200`) rather than an error. **Test coverage:** offline §6 and HTTP §6.

**Confirmed strong elsewhere.** `/api/admin/students` is admin-gated. Parent surfaces resolve through `ParentChild` and are covered by three isolation suites (112 + 176 + 67 assertions, all passing). `logSecurityEvent` hashes IPs.

---

## 23. §19 — Security logging and monitoring

**Audited.** `logSecurityEvent`, the `SecurityEvent` model, and every call site.

**Confirmed strong.** The platform already logs the events that matter: `LOGIN_SUCCESS`, `LOGIN_FAILED`, password-reset request/confirm, teacher-application submission/approval/activation, and rate-limit breaches. Every row stores a **hashed** IP and a truncated user-agent, never raw personal data (verified in HTTP §12). F-02 added two `LOGIN_FAILED` events on the throttle paths, so a credential-stuffing campaign is now visible in the data rather than silent.

No SIEM, alerting pipeline or external log shipping was added — explicitly out of scope, and adding one would be a speculative control.

**Destroyed observability: none.** Every fix in this gate is additive to logging or neutral to it.

---

## 24. §20 — Data retention and privacy operations

**Audited** for the gate; **no implementation work**, because retention and backup infrastructure is Phase 21 and was explicitly excluded.

**Current posture.** Quiz evidence is governed by `QUIZ_EVIDENCE_RETENTION_DAYS` (default 30). Password-reset tokens expire per `PASSWORD_RESET_TTL_MINUTES` (default 15). Teacher activation tokens expire per `TEACHER_ACTIVATION_TTL_HOURS` (default 72). Expired sessions and consumed tokens are not deleted by a scheduled job — they accumulate and are simply never accepted.

**Documented for Phase 21:** there is no scheduled purging of `SecurityEvent`, `SecurityRateLimit`, expired `UserSession`, or consumed reset/activation tokens, and no database backup or point-in-time recovery. These are durability and retention concerns, correctly assigned to Phase 21, and are **not** a security defect introduced or worsened by this gate.

---

## 25. §21 — Rate limiting and abuse

**Finding F-02** — see §5. This section records why the fix stops at login.

Every other abuse-sensitive unauthenticated endpoint was **already** throttled: password-reset request and confirm (IP + identifier buckets), teacher activation (IP + token buckets), and teacher application. Login was the gap, and it was the worst possible gap because it is the session mint. No other endpoint was found that both accepts unauthenticated input and performs an expensive or credential-issuing operation without a limiter.

---

## 26. §22 — Password policy

**Finding F-09** — see §8. One platform minimum of **8 characters**, enforced server-side everywhere, including `scripts/setup-production.ts` for the production admin. Complexity rules (character classes) were deliberately **not** added: they push users toward predictable substitutions and there is no evidence in the threat model that length is insufficient — especially now that login is throttled (F-02), which is the control that actually stops guessing.

---

## 27. §23 — Seeding and demo accounts

**Finding F-01** — see §19 for the fix.

**Residual risk (documented, not a code change).** The seeder still *creates* the four demo accounts, because they are the documented acceptance-test fixtures. They are now created with a non-guessable password, and the seeder warns in production to remove them. Removing the demo accounts entirely would break `tests/i18n/audit-ui.mjs` and the documented acceptance walkthrough — a business-rule change, not a security fix — so it was left alone and documented.

> **Operator action required after this change is deployed:** any deployment seeded *before* it still has the old well-known passwords. **Rotate the admin credential** and delete or re-seed the demo accounts. See `docs/DEPLOYMENT_GUIDE.md` §8.

---

## 28. §24 — Client-IP trust and proxy boundaries

**Finding F-07 (MEDIUM) — spoofable client IP.** Four call sites derived the client IP as `headers.get("x-forwarded-for")?.split(",")[0]`. `X-Forwarded-For` is **appended to** by every hop, so its first entry is whatever the outermost client chose to send, unless a trusted proxy rewrites the header. An attacker could therefore set `X-Forwarded-For: <arbitrary>` and choose their own rate-limit bucket, defeating the IP bucket on password reset, teacher activation and (after F-02) login.

**Remediation.** A single, documented function in `src/lib/security.ts`:

```ts
export function clientIpFromHeaders(headers: Headers): string | null {
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || null;
}
```

**Why `X-Real-IP` is preferred.** The documented deployment (`Caddyfile`, `docs/DEPLOYMENT_GUIDE.md` §1B) sets it **unconditionally** with `header_up X-Real-IP {remote_host}`. A proxy that emits it therefore also *overwrites* any client-supplied value, and a request that reaches the app without the proxy carries no `X-Real-IP` at all — so its presence is meaningful and its value is not attacker-chosen. The first-XFF fallback preserves correct behaviour behind proxies that only set XFF.

**Trust boundary, stated explicitly in the code comment:** a spoofed IP can only ever weaken an IP-bucketed **throttle**. It is **never** an authorization input. Every abuse-sensitive endpoint also keys a second, **non-spoofable** bucket — the hashed account identity or the hashed token — so defeating the IP bucket does not defeat the limiter. The function is now the single place this decision lives, used by `createSession`, `logSecurityEvent`, login, both password-reset routes and teacher activation.

**Verification.** Offline §7 compiles and `require`s the **real** `security.ts` and asserts the precedence behaviourally (X-Real-IP wins; XFF hop is the fallback; no header → `null`), rather than asserting on source text.

---

## 29. §25 — Denial of service and resource exhaustion

Beyond F-06's unbounded `N+1` (§22), the gate reviewed every list endpoint for an unbounded scan. The remaining list endpoints are either admin/teacher-scoped to a specific course, or bounded by a parent-child link. `LEADERBOARD_MAX_ROWS` sets the precedent for a hard ceiling. Network-layer DoS is out of scope.

---

## 30. Verification — real HTTP

**`scripts/verify-security-audit-gate.mjs` → `SECURITY_AUDIT_GATE_HTTP_OK`, 71 passed, 0 failed.**

This is the primary evidence. It is **not** a mock exercise:

- It compiles the **real shipped modules** with `tsc` — `src/lib/{env,security,rate-limit,i18n-*,registration,school-type,enrollment,teacher-applications,api,auth}` — plus **8 real route handlers** and `next.config.ts`. It does not reimplement them.
- It builds a **real database** by applying the **real 9-migration history** to a real `node:sqlite` instance (via the repo's own `scripts/lib/migrate-sqlite.mjs`), so every assertion runs against the genuine production schema.
- It serves over a **real `node:http` socket** and drives it with **real `fetch`**, so headers, cookies, status codes and bodies are the ones a client would actually receive.

**Assertions:** login throttle (10× `401` → `429` + `Retry-After` + `RATE_LIMITED`, no existence oracle, `SecurityEvent` rows written, no collateral damage to other identities, success clears the identity bucket); the six security headers including the new HSTS plus the `HSTS_DISABLED=1` kill-switch; F-03 study-plan ownership (`404`, **victim row provably unchanged**, owner regression); F-04 enroll cross-course (`400`, no enrollment move, no `Payment` row); the 8-character floor on register and admin/teachers (5 and 7 rejected, 12 accepted, student → `403`); the full teacher-application chain including replay, expired and rejected paths; `clientIpFromHeaders` precedence; and that **no token value, raw email or raw IP** lands in `SecurityEvent` / `SecurityRateLimit`.

---

## 31. Verification — browser subsystems

**`scripts/verify-security-audit-gate-browser.mjs` → `SECURITY_AUDIT_GATE_BROWSER_OK`, 43 passed, 0 failed.**

**Stated plainly: a real Chromium could not be started in this environment.** `npx playwright install chromium` fails (Playwright's CDN is unreachable — the same class of network restriction that blocks `binaries.prisma.sh`), and no system browser is installed. The script says so in its own header.

Rather than skip the check or fake it, the two browser subsystems the audit actually depends on are exercised with the **same engines real browsers and browser test-suites use**:

- **Cookies — `tough-cookie` v6**, a full RFC 6265bis implementation (`HttpOnly`, `Secure`, `SameSite`), fed a **real `Set-Cookie`** emitted by the **real compiled login handler**. The CSRF conclusion is therefore the *browser's* decision, computed by a real cookie engine, not an assertion we wrote.
- **Document — `jsdom`**, parsing a real HTML shell served over a **real socket** with the **real** `next.config.ts` headers, with `runScripts: "dangerously"` so scripts genuinely execute.

**Proven:**
1. All six security headers, **including the new HSTS**, arrive on a real document response; no `X-Powered-By`.
2. The CSP is calibrated and closes the classic vectors: `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`, `default-src 'self'`, `connect-src 'self'`, **no `unsafe-eval` in production**; `media-src 'self'` keeps media playback working; `frame-src` keeps the legacy YouTube/Vimeo embeds working; and `script-src`'s `'unsafe-inline'` is **proven required** by actually executing the inline Next.js bootstrap in a real document.
3. The session cookie from a real login is `HttpOnly` (so `document.cookie` exposes nothing), `SameSite=Lax`, scoped to `/`, and carries a high-entropy value.
4. **CSRF (R-1):** a same-site request carries the session; **a cross-site POST sends an empty `Cookie` header**; and the shell ships no HTML form at all, so no cross-site form can produce the JSON body a mutation requires.
5. Under `NODE_ENV=production` the cookie is additionally `Secure`.

This is **not** a rendered Chromium, and this report does not claim one.

---

## 32. Verification — offline suite and full regression

**`tests/security-audit-gate.test.js` → 103 passed, 0 failed** (new; CommonJS, matches every other suite in `tests/`).

Twelve sections: 1 F-01 seeder credentials; 2 F-02 dual-bucket login throttle; 3 F-03 study-plan PATCH ownership; 4 F-04 enroll course/group binding; 5 F-05 HSTS; 6 F-06 leaderboard scoping; 7 F-07 client-IP trust (**behavioural** — it compiles and `require`s the real `security.ts`); 8 F-09 8-character floor; 9 authentication invariants re-verified so the fixes cannot silently regress them; 10 **verified non-exposures** (SSRF, raw SQL, `child_process`, XSS sinks, git-tracked secrets) so the report's "confirmed strong" claims are test-backed rather than asserted; 11 shells out to the HTTP script; 12 shells out to the browser script.

**Full regression — all 27 `tests/*.test.js` suites exit 0, 4,570 assertions, 0 failures:**

| Suite | | Suite | |
|---|---|---|---|
| admin-publishing-phase15 | 384 | security-audit-gate **(new)** | **103** |
| authorization-invariants | 93 | security-hardening-phase20 | 188 |
| calendar-i18n-phase9 | 444 | security-hardening | 274 |
| curriculum-reconciliation-phase11 | 56 | seed-idempotency | 18 |
| kodgy-phase10 | 231 | session-lifecycle-phase13 | 299 |
| migration-sql | 15 | session-materials-phase14 | 127 |
| mock-exam-grading-isolation | 22 | session-notifications-phase17 | 319 |
| mock-exam-phase8 | 135 | session-progression | 162 |
| parent-analytics-alignment-phase19 | 176 | session-quiz | 70 |
| parent-dashboard-isolation | 112 | student-locked-curriculum-phase16 | 365 |
| parent-monthly-report | 67 | teacher-application-phase20 | 75 |
| platform-upgrade-2026-migration | 98 | teacher-workflow-phase18 | 365 |
| quiz-analytics | 44 | track-architecture-phase12 | 304 |
| registration-validators | 24 | | |

**All 10 `scripts/verify-*.mjs` harnesses exit 0** — including the 8 pre-existing phase harnesses (13, 14, 15, 17, 18, 20×3), which confirms no prior phase is regressed.

---

## 33. Typecheck, lint and build

**Typecheck** — `node node_modules/typescript/bin/tsc --noEmit` → **exit 2, 27 `error TS` lines**. All 27 are pre-existing and **none is in a file this gate touched**. They decompose as: 8 × `TS2305` "no exported member" from `@prisma/client` (`Role`, `Question`, `QuestionType`, `Difficulty`, `AttendanceStatus`, `NotificationType`), 12 × `{}` / `LessonChain` shape errors, 3 × `Set<unknown>`, 1 × `student` vs `studentId`, and 1 × `TS2304: Cannot find name 'setMode'` in `src/components/auth/auth-view.tsx(371,9)`.

**Lint** — `node node_modules/eslint/bin/eslint.js .` → **exit 1, 134 problems (133 errors, 1 warning)**. Identical to baseline: 96 × `@typescript-eslint/no-require-imports` (the test suites are CommonJS by design) and 35 × `react-hooks/set-state-in-effect`.

**Build** — `next build` → **exit 1**. It fails during type checking with the **same 27 errors**. This was proven to be pre-existing rather than assumed: the original tree was restored via `git stash`, `next build` was run, the error lists were sorted and diffed, and they are **byte-identical** (27 = 27, zero differences).

**Root cause of all of the above (environmental, not a code defect):** `prisma generate` cannot run — `https://binaries.prisma.sh/...` is unreachable from this sandbox (curl exit 35, `SSL_ERROR_SYSCALL`). The installed `@prisma/client` is therefore a **stub** whose `.d.ts` files declare `PrismaClient: any`, which is what produces every `TS2305` and the downstream `{}` / `LessonChain` / `Set<unknown>` errors. No source edit can fix them, and none was attempted.

The one genuine code defect in the baseline is **`src/components/auth/auth-view.tsx(371,9): TS2304: Cannot find name 'setMode'`** — a likely runtime `ReferenceError` in the auth view's mode switch. It is **pre-existing (present at `f3a46bd`), unrelated to security, and outside this gate's scope**. It is reported here for the record and was deliberately **not** fixed: it is a behavioural change to a shipped auth UI component with no security benefit, and fixing it would breach the minimal-scope constraint.

---

## 34. Database and migration safety

- `git diff --stat -- prisma/` — **empty**. No model changed, no migration added, no migration edited.
- 9 migrations present; latest `20260912000000_phase20_teacher_applications`. Unchanged.
- **`db push` was never run. `db reset` was never run.** No database was reset or recreated.
- `bun run db:generate` (`prisma generate`) and `bunx prisma migrate status` both **fail in this sandbox** because the Prisma engine CDN is unreachable. This is the same environmental blocker as §33.
- **Substitute evidence:** `tests/migration-sql.test.js` (15 assertions) and `tests/platform-upgrade-2026-migration.test.js` (98 assertions) both pass, and every HTTP/browser harness builds its database by applying the **real migration history** through the repo's own `scripts/lib/migrate-sqlite.mjs` — which means the real schema was exercised end-to-end even though `prisma migrate status` could not report on it.
- PostgreSQL migration remains Phase 21 and was not started.

---

## 35. Dependency, secret and artifact hygiene

- **Dependencies:** zero added, removed, upgraded or downgraded. Lockfile untouched. (§21)
- **Secrets:** `.env` is gitignored and untracked. Verified via `git ls-files` that **no `.env*` file other than `.env.example` is tracked**. A repo-wide scan for literal secret assignments found only documentation placeholders. No real production secret was rotated or reproduced in this report. (§19)
- **Artifacts:** no database file, no `.next/` output, no `node_modules/`, no storage directory and no log file is tracked or staged. `git status` shows exactly **23 modified files and 3 new files** — every one attributable to F-01…F-09 or to the new verification scripts.
- **Diff size:** 476 insertions, 62 deletions across 23 files, plus the three new verification files.

---

## 36. Remediation plan, residual risk and pre-merge checklist

### Remediation plan (all complete)

| # | Action | Security benefit | Minimal scope | Backward compatible | No regression | Test coverage |
|---|---|---|---|---|---|---|
| 1 | F-01 seeder credential contract | Removes a public ADMIN password from every deployment | One new resolver + 4 call sites | Same accounts, new password source | Seed idempotency suite passes | Offline §1, HTTP §1 |
| 2 | F-02 dual-bucket login throttle | Bounds anonymous credential guessing | Reuses shipped limiter; no new table | Success path unchanged | Full regression (4,570 assertions) | Offline §2, HTTP §2 |
| 3 | F-03 ownership-scoped PATCH | Closes read+write IDOR on study plans | One `updateMany` | Owner behaviour unchanged | Owner regression in HTTP §4 | Offline §3, HTTP §4 |
| 4 | F-04 course/group binding | Stops cross-course enrollment and seat theft | One predicate | Valid enrollments unchanged | HTTP §6 (no `Payment`, no move) | Offline §4, HTTP §6 |
| 5 | F-05 HSTS | Closes the TLS-downgrade window | One header + kill-switch | Additive | Header suite | Offline §5, HTTP §5, Browser §1 |
| 6 | F-06 leaderboard scoping + bound | Removes a platform-wide directory of minors; bounds cost | One `where`, one `take`, id-based rank | Same response shape | Parent/teacher/analytics suites pass | Offline §6, HTTP §6 |
| 7 | F-07 `clientIpFromHeaders` | Makes IP buckets non-spoofable behind the documented proxy | One function, 6 call sites | Same values behind Caddy | All limiter suites pass | Offline §7 (behavioural), HTTP §8 |
| 8 | F-09 8-character floor | One enforced minimum, server-side | Six predicates | Client already enforced 8 | Registration suite passes | Offline §8, HTTP §9 |

### Residual risk (accepted, documented, not fixed)

| ID | Risk | Why accepted | Mitigation in place |
|---|---|---|---|
| R-1 | No explicit CSRF `Origin` check on cookie-auth mutations | Would be a speculative control: both real bypass routes are closed, and the gate was asked to verify this rather than assume it | `SameSite=Lax` **and** JSON-only mutation bodies — **both proven** in §31 with a real cookie engine |
| R-2 | `Caddyfile` plain-HTTP `:81` listener | Infrastructure change; the app-side control is now in place | HSTS emitted at the app (§13). Operator should retire `:81` or make it redirect-only |
| R-3 | CSP `script-src 'unsafe-inline'` | Required by the Next.js RSC bootstrap; tightening it is a framework-level change, not a gate fix | Proven **required** in §31 (a real inline bootstrap executes). Contained by `object-src 'none'`, no `unsafe-eval`, `base-uri 'self'`, `form-action 'self'` |
| R-4 | Demo accounts are still seeded | They are the documented acceptance fixtures; removing them is a business-rule change | Non-guessable random passwords; production refuses to guess; seeder warns to remove them |
| R-5 | No scheduled purge of `SecurityEvent` / `SecurityRateLimit` / expired sessions; no backup | **Phase 21** durability and retention work, explicitly excluded from this gate | Documented in §24 for Phase 21 |
| R-6 | `POST /api/admin/ai-generate-quiz` permits TEACHER under an `/api/admin` path | Course-checked, so not a privilege escalation; moving it is an API-shape change with no security benefit | Documented in §6 |
| R-7 | Pre-existing `setMode` `TS2304` in `src/components/auth/auth-view.tsx` | Pre-existing at `f3a46bd`, unrelated to security, and fixing it is a behavioural change to a shipped auth UI | Reported in §33 for the record |

### Pre-merge checklist

- [x] **Critical / High:** all 5 (F-01, F-02, F-03, F-04, F-06) fixed and verified. **Zero open.**
- [x] **Medium:** all 3 (F-05, F-07, F-09) fixed and verified.
- [x] **No unrelated architecture change:** no redesign, no new auth architecture, no SQLite→PostgreSQL, no media migration, no dependency change, no new roadmap phase.
- [x] **Real HTTP verification:** 71/0 against the real schema on a real socket (§30).
- [x] **Browser verification:** 43/0 with a real cookie engine and real document parsing, with the Chromium limitation stated honestly (§31).
- [x] **Full regression:** 27/27 suites exit 0 (4,570 assertions); 10/10 verify harnesses exit 0 (§32).
- [x] **Typecheck / lint / build:** 27 and 134, identical to baseline; build error list **byte-identical** before and after, proven by an A/B run (§33).
- [x] **Migration status:** `prisma/` diff empty, 9 migrations untouched, no `db push` / `db reset` (§34).
- [x] **No secrets or artifacts:** none tracked; 23 modified + 3 new files, all attributable (§35).
- [x] **Not merged.** Committed to `arena/01a08ded-codemind-academy`, pushed, and opened as **draft PR #43** for external review.

### Required operator actions after merge

1. **Rotate the admin credential on any deployment seeded before this change** — it may still carry a publicly known password.
2. Delete or re-seed the demo accounts in production (`docs/DEPLOYMENT_GUIDE.md` §8).
3. Retire the plain-HTTP `:81` Caddy listener or make it redirect-only (R-2).

---

CONDITIONAL GO — MEDIUM RISKS DOCUMENTED
