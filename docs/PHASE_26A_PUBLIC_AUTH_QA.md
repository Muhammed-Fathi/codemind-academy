# Phase 26A — PUBLIC & AUTH FULL QA (report)

**Scope:** public pages + authentication only. No deployment, no production Neon,
no R2, no commit/push/PR.

**Verdict:** every required flow PASSES. Three defects were found and fixed, each
with regression coverage. No unresolved critical/high auth bug remains.

---

## 1. Environment safety

| Item | Value |
|---|---|
| Branch | `arena/01a0a282-codemind-academy` |
| HEAD | `e5bc3a1fefab4062f666ed0f72c3ce0782d6d8fb` ("Merge pull request #71 …") |
| `DATABASE_URL` engine | **SQLite** (`file:…` — the value is never printed) |
| Postgres/Neon/R2/S3/SMTP variables | **none** (checked in `.env` and in the process environment) |
| Working tree at start | clean (only `.env.example` tracked; no `.env` existed) |

A local `.env` was created for the sandbox run (git-ignored, `.gitignore:22`). It
contains **only** the local SQLite URL, a local `SECURITY_HASH_SECRET`, the local
media backend and seeding passwords. Confirmed local SQLite only — no production
system was contacted at any point.

### Sandbox constraint (pre-existing, documented since Phase 6)

`binaries.prisma.sh` is unreachable from this sandbox, so `prisma generate`
cannot download the engines and `@prisma/client` cannot open a database here
(`docs/PHASE_22_FINAL_REPORT.md` "Q:"). Therefore:

* `next dev` **does** serve the real application — the full client bundle, the
  real components, the real store/router, the real CSS — and was used for all
  visual/interaction QA;
* `/api/*` cannot run inside `next dev`, so API-traffic QA runs the **shipped
  route handlers** (compiled byte-for-byte, unmodified) behind a real
  `node:http` server against a real SQLite database built from the real
  migrations, exactly like the existing `scripts/verify-security-audit-gate.mjs`.
  The only substitutions are the Prisma data source, the mail transport and
  Next's request plumbing.

## 2. Public QA

| Flow | Scenario | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|
| PUBLIC-01 | `/` renders for a guest | 200, full landing, no error | 200, hero + 6 sections + footer, 0 console errors | **PASS** | `verify-phase26a-browser.mjs` (ar+en × 1440/834/390) |
| PUBLIC-02 | Landing navigation | navbar scrolls to each section; CTAs open auth views | all five anchors reachable, real navbar click scrolls, login/register CTAs open the right forms | **PASS** | browser harness |
| PUBLIC-03 | Responsive | no overflow/clipping at 1440 / 834 / 390 | **FAIL → fixed** (see Bug 2/3), then PASS at 360–1440 in both directions | **PASS after fix** | browser harness + `edgeOverflow()` probe |
| PUBLIC-04 | No public Kodgy | assistant absent for guests | absent on landing/login/register/forgot/reset/activation, no flicker | **PASS** | browser harness (polled 700 ms–1 s after load) |
| — | Branding / pricing copy | public settings only | `brand_name`, tagline, academic year, prices; no secret-shaped key | **PASS** | `verify-phase26a-auth.mjs` |
| — | Raw translation keys | none visible | none in either locale, on every public/auth view | **PASS** | browser harness |

## 3. Registration QA

**Student (AUTH-01)** — required fields, Arabic server errors, email format,
8-char minimum, three-part Arabic name, Egyptian phone, 14-digit national ID,
canonical school type, public ADMIN refused — all enforced **server-side**
(400). Success returns `role=STUDENT` + a `CM-XXXXXX` student code, mints an
`HttpOnly; SameSite=Lax; Path=/` session, and **grants nothing else**: 0
`Subscription` rows, 0 `Payment` rows, `groupId = null`, and
`/api/students/me/enrollment` reports `enrolled=false`. **PASS**

**Duplicate identity (AUTH-02)** — duplicate e-mail → 409; duplicate national ID →
409; an existing account's e-mail cannot be re-registered; error text is
user-facing with no DB detail. **PASS**

**Parent (AUTH-04)** — public parent signup **is** supported and requires a
three-part linking proof: parent phone + student national ID + student code, all
three matching one student record. Wrong code, wrong ID and wrong phone all
return 404 with a byte-identical body (`api.073` == `api.074`), so a failed
attempt never confirms a guessed pair. Success creates role `PARENT` + a `Parent`
row + exactly one `ParentStudentLink` to the verified student only; no group, no
entitlement. **PASS**

**Teacher (AUTH-05)** — public application only. Submitting creates a
`TeacherApplication(status=PENDING)` and **no** `User`, **no** session, **no**
role; the applicant cannot log in. Validation: bad e-mail 400, missing name 400,
bad phone 400, duplicate application 409, applying with an existing account's
e-mail 409. **PASS**

## 4. Login / logout QA

| Role | Login | Session | Role redirect | Wrong-role refusals | Logout | Result |
|---|---|---|---|---|---|---|
| STUDENT | 200 | real row, hashed token | `student-dashboard` | admin/teacher/parent 403 | cookie cleared + row revoked | **PASS** |
| PARENT | 200 | real row | `parent-dashboard` | student/admin 403 | revoked | **PASS** |
| TEACHER | 200 | real row | `teacher-dashboard` | admin/student 403 | revoked | **PASS** |
| ADMIN | 200 | real row | `admin-overview` | student/parent 403 | revoked | **PASS** |

* Invalid credentials: wrong password and unknown account return **identical**
  401 bodies (no enumeration); uppercase/whitespace e-mail is normalised.
* Deactivated account → 403; multi-device suspension → 403 with
  `code=ACCOUNT_SUSPENDED_MULTI_DEVICE`.
* **AUTH-15 role redirect matrix (derived from the shipped source and observed
  in the browser):** each role's client calls **only** its own top-level
  endpoints — verified over the real network log per role.

## 5. Password reset

| Scenario | Result |
|---|---|
| Request, known e-mail | 200, same generic body, token **only** in the e-mail |
| Request, unknown e-mail | 200, byte-identical body (anti-enumeration) |
| Request, malformed e-mail | 400 |
| Per-identifier rate limit | silently still 200 (never discloses the limit) |
| Per-IP limit | 429, never 5xx |
| Token storage | only SHA-256 persisted; raw token appears nowhere |
| Confirm, policy failure (<8) | 400 and the token is **not** consumed |
| Confirm, missing token | 400 |
| Confirm, valid token | 200; password changed; token stamped used |
| Confirm, reused token | 400 |
| Old / new password | old 401, new 200 |
| Sessions at reset time | revoked, `revokedReason = PASSWORD_RESET` |
| Invalid / expired token | 400, uniform body; expired token is consumed (not replayable) |
| Legacy SMS-channel token | 400 (recovery is e-mail only) |
| Error bodies | no stack traces, no DB/driver detail |

**PASS** (AUTH-11, AUTH-12, AUTH-13).

## 6. Session / security QA

* Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production, 7-day TTL;
  logout returns `cm_session=; Max-Age=0`.
* Only the SHA-256 of the token is stored; the raw cookie value never appears in
  the DB.
* Missing, malformed and unknown tokens all return the **same** 401 body (no
  existence leak); revoked and expired sessions return 401.
* **Single-device policy (AUTH-14):** a second device's login is refused (403 +
  `code`), every session of that user is revoked, `isActive=false`, and the
  suspension is written to `SecurityEvent`.
* **Throttling (AUTH-16):** per-identity bucket closes (429 + `RATE_LIMITED` +
  `Retry-After`); the per-IP bucket closes after 40 spray attempts across many
  identities; refusals are audited. Successful login clears the identity budget.
* Existing controls were **not** weakened — `security-audit-gate`,
  `security-hardening`, `security-hardening-phase20` and
  `authorization-invariants` are all still green.

## 7. Protected-route / API QA

* Unauthenticated: `/api/students/*`, `/api/admin/*`, `/api/teacher/*`,
  `/api/parents/*` → **401** with the uniform `{"error":"Unauthorized"}` body,
  refused by the proxy before any route code or DB access; no protected payload
  is echoed.
* Wrong role: every cross-role probe → **403**, body carries no role payload.
* Correct role: passes the auth layer (never 401/403).
* Protected **pages**: the public/auth routes are the only page route; a guest
  reaching a dashboard view gets a neutral loading shell and is returned to the
  landing view — no role component renders for a guest, and no `window.location`
  assignment exists, so there is no redirect loop.

## 8. Kodgy QA

| Surface | Result |
|---|---|
| Public landing (guest) | **absent** — ar/en, all three widths, no post-hydration flicker |
| Login / register / forgot / reset / teacher activation | **absent** |
| Authenticated STUDENT / PARENT / TEACHER / ADMIN shells | **present** |
| After logout | **absent**, and it does not coexist with a public/auth surface while auth resolves |

This contradicted the product rule ("unauthenticated → no Kodgy"): the component
only hid itself on login/register, so guests saw it on the landing page. Fixed by
making the rule **fail closed inside the component** (see Bug 1).

## 9. Visual / responsive QA

Measured on the live DOM at 1440 / 834 / 390 (plus a 360–1440 sweep after the
fixes), Arabic RTL and English LTR:

* no horizontal document overflow anywhere;
* no visible button/control/link box outside the viewport (including an
  in-flow `edgeOverflow()` probe that excludes fixed-position elements);
* correct `html[lang]` and computed `direction`, logical RTL icon alignment,
  password reveal controls inside their inputs, no dropdown/toast clipping;
* **§17:** the authenticated shell shows no right-side / right-edge overflow at
  1440px for any of the four roles — no visible repeat of the previously
  reported dashboard overflow;
* 0 console `error`/`pageerror` events across every page, locale and role.

## 10. Bugs found

### Bug 1 — Kodgy leaked onto the public landing page (severity: **HIGH**)

* **Root cause:** `src/components/kodgy/kodgy-assistant.tsx` computed
  `shouldHide = hideOn.includes(view)` where `hideOn = ["login", "register"]`,
  i.e. a guest on `landing` was deliberately allowed to see a floating
  assistant. The product rule is authenticated-only.
* **Fix:** fail closed in the component — `shouldHide = !user || hideOn.includes(view)`.
  The mount point was already authenticated-only, so this is defense in depth
  against a shell refactor, and it also removes any hydration flicker.
* **Coverage:** browser harness (6 public surfaces × 2 locales × 3 widths + a
  1-second flicker poll), `tests/phase26a-public-auth.test.js` §2.

### Bug 2 — Approved teacher's activation link landed on the public page (severity: **HIGH**, functional dead end)

* **Root cause:** the approval e-mail links to `/?teacherActivation=<token>`, and
  `AuthView` reads that parameter — but `AppShell` only switched to the auth view
  for a **reset** token (`?token=`). With no other trigger, the shell stayed on
  `landing`, so `AuthView` never mounted and the applicant had no way to set a
  password and reach the role they were just approved for.
* **Fix:** `AppShell` now recognises both link types
  (`hasLinkToken = Boolean(resetToken || teacherActivationToken)`), the minimal
  change that makes both e-mails work.
* **Coverage:** browser harness (both locales: the activation link now opens the
  set-password form and does **not** land on the login form),
  `tests/phase26a-public-auth.test.js` §3 (both link builders and both consumers).

### Bug 3 — Landing header pushed its CTAs outside the viewport on tablet/phone (severity: **MEDIUM**)

* **Root cause:** the header is a single row holding the logo + wordmark, the
  theme/language controls, the login button, the primary CTA **and** five nav
  links. Measured: the row needs ~1024px in Arabic and ~1080px in English. The
  nav links appeared from `md:` (768px), so at 768–900px the primary "start free"
  CTA was clipped **entirely off-screen** (Arabic: fully outside at 768px, ~60%
  outside at 834px; English at 390px: 27px past the right edge). `body {
  overflow-x: hidden }` hid the symptom, so `scrollWidth` alone reported "no
  overflow" — only per-element geometry exposed it.
* **Fix (two lines of intent):** the five nav links now show from `lg:` (the
  breakpoint the dashboard sidebar already uses) instead of `md:`, and the header
  wordmark is hidden below `sm:`. Both CTAs and all controls are inside the
  viewport from 360px to 1440px in both directions.
* **Coverage:** browser harness per-element viewport assertions at 6
  locale×viewport combinations; `tests/phase26a-public-auth.test.js` §4.

### Observations (not bugs, reported for completeness)

* Student/parent **registration** asks for the password once (no confirm field);
  the reset and teacher-activation forms **do** require confirmation. Both were
  verified; no defect.
* `tests/final-integration-phase22.test.js` fails in this sandbox for
  **pre-existing, environmental** reasons (`db/custom.db` and `backups/` cannot
  exist while the Prisma engine is unavailable). Reproduced identically on the
  untouched baseline — **not** a Phase 26A regression.

## 11. Files changed

Modified (4):

* `src/components/kodgy/kodgy-assistant.tsx` — Bug 1
* `src/components/app-shell.tsx` — Bug 2
* `src/components/landing/hero.tsx` — Bug 3 (nav breakpoint + wordmark)
* `src/components/logo.tsx` — Bug 3 (`wordmarkClassName` prop)

Added (4):

* `scripts/verify-phase26a-auth.mjs` — real-HTTP public/auth verifier (also the browser bridge)
* `scripts/verify-phase26a-browser.mjs` — real-Chromium public/auth/visual verifier
* `tests/phase26a-public-auth.test.js` — regression suite (behavioural + structural)
* `docs/PHASE_26A_PUBLIC_AUTH_QA.md` — this report

No schema change, no migration, no payment/entitlement code touched.

## 12. Tests — exact commands and counts

```bash
node scripts/verify-phase26a-auth.mjs      # 191 passed, 0 failed → PHASE26A_AUTH_OK
node scripts/verify-phase26a-browser.mjs   # 226 passed, 0 failed → PHASE26A_BROWSER_OK
node tests/phase26a-public-auth.test.js    #  72 passed, 0 failed
node tests/authorization-invariants.test.js        #  93 passed, 0 failed
node tests/security-audit-gate.test.js             # 116 passed, 0 failed
node tests/security-hardening.test.js              # 279 passed, 0 failed
node tests/security-hardening-phase20.test.js      # 192 passed, 0 failed
node tests/session-lifecycle-phase13.test.js       # 299 passed, 0 failed
node tests/teacher-application-phase20.test.js     #  75 passed, 0 failed
node tests/registration-validators.test.js         #  24 passed, 0 failed
node tests/kodgy-phase10.test.js                   # 231 passed, 0 failed
node tests/calendar-i18n-phase9.test.js            # 444 passed, 0 failed
node tests/platform-upgrade-2026-migration.test.js #  98 passed, 0 failed
npx eslint <changed files>                         # clean (exit 0)
```

Full battery: **44 of 45** suites green. The 45th
(`final-integration-phase22`) fails identically on the untouched baseline
(missing local `db/custom.db` + `backups/`) — environmental, pre-existing.

## 13. Prisma / typecheck / build

| Command | Result |
|---|---|
| `npx prisma generate --schema prisma/schema.prisma` | **fails** — `binaries.prisma.sh` unreachable (TLS disconnect), same as the baseline. Cannot run in this sandbox. |
| `npx tsc --noEmit` | **10 errors — byte-identical to the baseline** (all `TS2305: Module "@prisma/client" has no exported member …`, caused by the un-generatable client). Verified by diffing a pristine `HEAD` checkout against the working tree. |
| `npx next build` | **fails — identical to the baseline**, and for the **same 10 Prisma-stub errors** ("Failed to type check"); everything before type-checking succeeds ("✓ Compiled successfully in 17.2s"). |

No new type or build error was introduced by Phase 26A. On a host where the Prisma
engines are reachable, `prisma generate` must be re-run before typecheck/build are
authoritative (same instruction as every previous phase report).

## 14. Remaining risks / not fully proven

1. **`prisma generate` / `next build` / `tsc --noEmit` are unverifiable here.**
   All three are blocked by the sandbox network, and all three are
   baseline-identical. Must be re-run on the Windows-local follow-up
   (`npx.cmd …`).
2. **The `/api/*` layer was exercised through the project's own compile-and-run
   harness, not inside `next dev`.** The harness runs the shipped handlers
   unmodified over real HTTP and real SQLite, but it is not the Next runtime: a
   Next-specific middleware/proxy ordering issue that only appears inside
   `next dev` would not be caught here. (`src/proxy.ts` is replicated
   faithfully — the "no session cookie → 401 before route code" path was tested
   explicitly.)
3. **Mail delivery** was replaced by an in-memory capture (no SMTP in the
   sandbox). The token-generation, storage and consumption logic is the shipped
   code; only the transport is substituted.
4. **Single-device enforcement** was proven with two distinct User-Agent
   families. Real-world device fingerprints depend on `sec-ch-ua-*` hints and a
   production `SECURITY_HASH_SECRET`; the sandbox uses a non-secret local value.
5. **§17 dashboard overflow** was verified as "no overflow at 1440px for all four
   roles" plus "no in-flow element crosses the viewport edges". A full dashboard
   visual/layout QA belongs to the later phases and was deliberately not attempted.
6. **Browsers other than Chromium 149** (Firefox/Safari) were not exercised.
7. Only the **public/auth** surface was QA'd; admin/teacher/parent feature QA and
   Student QA (26B) were intentionally not started.

## 15. Git status (exact)

```
## arena/01a0a282-codemind-academy
 M src/components/app-shell.tsx
 M src/components/kodgy/kodgy-assistant.tsx
 M src/components/landing/hero.tsx
 M src/components/logo.tsx
?? docs/PHASE_26A_PUBLIC_AUTH_QA.md
?? scripts/verify-phase26a-auth.mjs
?? scripts/verify-phase26a-browser.mjs
?? tests/phase26a-public-auth.test.js
```

No commit, no push, no PR (as instructed).

---

# Phase 26A — GAP CLOSEOUT (local runtime, repository hygiene, README, guest shell)

This section supersedes §11 (files changed), §12 (tests) and §14 (risks) for the
closeout scope. Core QA results in §1–§10 are unchanged.

## A. Local runtime contract — root cause, not a guess

**Reported symptom reproduced exactly** (real `bun`-run dev server, real Chromium,
no test harness in the path): logging in with valid-looking credentials in the UI
returns `POST /api/auth/login → 500` and the user sees only
**"حصلت مشكلة في الاتصال. حاول تاني."** — which is dictionary key `auth.007`
("Connection problem. Try again.").

Why that message: `src/components/auth/auth-view.tsx` shows
`data.error || tr("auth.005")` for a *parsed* error body, but a 500 from Next is an
**HTML** error page, so `r.json()` throws, the outer `catch` runs, and the generic
`auth.007` toast is shown. So "generic connection error" ⇒ **the API returned a
500**, never a wrong-password case (that one is a JSON 401 with a specific message).

**Root cause chain, proven in this sandbox:**

1. `bun run dev` = `next dev -p 3000` — it does **not** run `prisma generate`.
2. With no generated client, every route that imports `@/lib/db` throws
   `@prisma/client did not initialize yet. Please run "prisma generate" and try to
   import it again.` at `src/lib/db.ts:9` (captured verbatim from the dev server log).
3. → `/api/auth/login` 500 → generic toast.

**The three causes that produce "login fails locally", and how to tell them apart:**

| Cause | API result | UI message | Fix |
| --- | --- | --- | --- |
| Prisma Client not generated (engines blocked / `generate` never ran) | **500** | generic `auth.007` | `bun run db:generate`, restart dev |
| DB missing/uninitialized **at the path Prisma resolves** | **500** | generic `auth.007` | `bun run db:push` |
| No account seeded (there is no default password) | 401 | specific "invalid credentials" (`api.057`) | re-run the seeder with `SEED_ADMIN_PASSWORD`/`SEED_DEMO_PASSWORD` |

**Path resolution (the documented-vs-actual gap):** Prisma resolves a relative
`file:` URL against the **schema directory**, so `DATABASE_URL="file:./db/custom.db"`
means `<repo>/prisma/db/custom.db`. The repo already knew this in places
(`scripts/audit-legacy-sessions.mjs`, `scripts/verify-phase13-db.mjs`,
`scripts/setup-production.ts` lists both candidates) while README, the docs set and
some Phase 22 scripts assumed the repo root. The DATABASE_URL **value was left
unchanged** (changing it would silently repoint an existing local database at an
empty file); instead README and `.env.example` now state the true location and the
absolute-path escape hatch. Consequence of the same inconsistency: the committed
`tests/final-integration-phase22.test.js` hardcodes repo-root `db/custom.db` and can
therefore never find the default database (see §D).

## B. Exact supported local startup sequence

```bash
bun install
bun run db:generate          # if `bun install` did not already run it
cp .env.example .env
bun run db:push              # creates prisma/db/custom.db + all tables
SEED_ADMIN_PASSWORD="..." SEED_DEMO_PASSWORD="..." bun run scripts/seed.ts
bun run dev                  # http://localhost:3000
```

Local production run:

```bash
bun run build                                    # REQUIRED before `start`
SECURITY_HASH_SECRET="<32+ random chars>" bun run start
```

Measured results (bun 1.4.2):

| Command | Result |
| --- | --- |
| `bun run dev` | **works** — `▲ Next.js 16.3.4 (Turbopack) ✓ Ready in 396ms`, serves `/` 200 on 0.0.0.0:3000, and the full 240-assertion browser suite passes against it |
| `bun run build` | **fails in this sandbox** at the `prisma generate` step with `request to https://binaries.prisma.sh/... failed … TLS` — identical to the npm baseline; not a script defect |
| `bun run start` (no build) | **exits 1** with `start-production: …/.next/standalone/server.js not found. Run \`bun run build\` first (output: "standalone" is required).` — the start-requires-build contract, proven |

## C. `.gitignore` findings (smallest correct update made)

Ignored correctly already: `.env`, `node_modules`, `.next/`, `*.db`, `/db/`,
`/backups/`, `storage/`, `*.log`, `dev.log`, `server.log`, `*.tsbuildinfo`,
`.DS_Store`, `agent-ctx/`, `examples/`.

Gaps found and closed:

| Gap | Risk | Change |
| --- | --- | --- |
| `.env.test`, `.env.development`, `.env.production`, `.env.staging` were **not** ignored (only `.env` and `*.local` were) | an environment file holding production `DATABASE_URL` / SMTP credentials could be committed | `.env` + `.env.*` with `!.env.example` restored |
| `inventory.json` / `inventory.pg.json` (written by the committed `scripts/phase25-pr4-inventory.mjs`) were not ignored | pre-cutover operational dumps with production-shaped identifiers could be committed | both names added |
| `.verify/` (Phase 12 Prisma-engine/compile scratch) was not ignored | scratch harness could be committed | `/.verify/` added |

`.env.example` remains tracked (verified). No tracked file matched a secret
pattern: all `postgresql://…` / `ep-*.neon.tech` / `AKIA…` occurrences in tracked
files are placeholders (`user:password@host`, `ep-xxxx.neon.tech`, `u:p@h/db`,
localhost harness URLs) or *assertions* that such literals are absent. No private
key material, no live Neon/R2/SMTP credential, no local DB, no backup, no build
output, no `node_modules` is tracked.

## D. README findings (updated minimally and truthfully)

Corrected: SQLite location (`prisma/db/custom.db`, not the repo root) in the
architecture diagram, the tree and the reset command; the env-var note that wrongly
said "relative to project root"; the "logs to dev.log" claim; and the production
section, which now states explicitly that `bun run start` **requires**
`bun run build` first and requires `SECURITY_HASH_SECRET`.

Added: a **Local runtime contract** section (per-command prerequisites), the exact
supported startup sequence, a **"If local login fails"** triage list (500 vs 401,
generate vs `db:push` vs seed), a Windows note (`set VAR=… &&`, `$env:VAR=…`,
`npx.cmd`), and an explicit **"Never point local write-QA at production"** warning.
`.env.example` gained a comment explaining the schema-relative resolution, the
absolute-path form for both platforms, and the same production warning.

Reported but deliberately **not** changed: `tests/final-integration-phase22.test.js`
hardcodes repo-root `db/custom.db` while the default setup creates
`prisma/db/custom.db`, so it fails on "db/custom.db missing" in any default
checkout (it also needs a `backups/` directory that a fresh clone does not have).
Same for the Phase 22 scripts under `scripts/`. This is a stale-path artifact, not
a Phase 26A regression — fixing it belongs with the Phase 22 integration work.

## E. Guest protected-shell conclusion

**Intentional, and it behaves correctly.** Proven in a real browser (dedicated
§4 section of `scripts/verify-phase26a-browser.mjs`, 14 assertions):

* no role shell ever renders for a guest — no `aside`, no account e-mail/identity,
  no role navigation, sampled 25× across the whole auth-resolution window;
* the session probe is refused with 401, and the boot **resolves** to the public
  landing view within 8 s (an 8 s `waitForFunction` that throws on timeout is the
  assertion — an infinite loading state fails the suite);
* no redirect loop: the **document is never reloaded** (proved with a boot token
  injected via `addInitScript` and compared after settling), the URL never changes,
  no extra history entries accumulate, and `/api/auth/me` is not retried.

Design context that makes this safe: the app exposes exactly **one page route**
(`/`), so there is no dashboard URL a guest could request, and `view` is
deliberately **not persisted** (`partialize` keeps only theme + locale), so every
fresh document starts on `landing`. The "protected shell" branch is therefore a
defensive guard rather than a reachable-by-URL state. Its two resolution paths both
terminate: a resolved session redirects to the role home; no session falls back to
the initial (public or reset) view.

One deliberate, documented limit (pinned in the regression test, not a defect): if
`/api/auth/me` **rejects** (transport failure) the effect's `.catch(() => {})`
swallows it, so nothing calls `setView`. Harmless today because the boot view is
already `landing`; it could only strand a user if a future change both persisted
`view` and cleared `user`.

Pinned by the new sections 4b–4d of `tests/phase26a-public-auth.test.js`
(37 additional assertions covering the guest shell, the runtime contract, the
README/.env.example truth and the `.gitignore` rules).
