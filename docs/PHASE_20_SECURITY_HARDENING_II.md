# Phase 20 — Security Hardening II — Final Report

> Branch: `arena/01a08d88-codemind-academy` · Base commit: `fb8aee3`
> Scope: Phase 20 only, per `docs/MASTER_PLATFORM_AUDIT_AND_ROADMAP.md` (G10).
> This report has exactly 21 numbered sections.
> **Addendum (scope extension):** the Secure Teacher Application & Admin
> Approval flow is reported separately in
> `docs/PHASE_20_ADDENDUM_TEACHER_APPLICATIONS.md` (real DB + real HTTP
> verification of Application → Approval → Activation → Teacher Account).

---

## 1. Objective

Close the content-scope residual risks and **prove** the 10-check content
authorization contract across every content route, add deterministic and
tested rate limiting to the abuse-sensitive endpoints, roll out a CSP derived
from the application's *actual* runtime requirements, remove the legacy
`Setting:session:*` session fallback (with a provable precondition), harden the
media/material download paths, and record the upload antivirus decision —
without starting Postgres migration, durable-storage migration, backup
infrastructure, production deployment, or Phase 22 go-live (strict boundary,
§17).

## 2. Discovery

Read the live client/server surface to derive requirements rather than
assume them:

- **Video playback** — one legacy `<iframe>` (`src/components/course/student-lesson.tsx`,
  `lesson.videoUrl`, no `sandbox`) for admin-provided https embeds (YouTube/Vimeo),
  plus two native `<video>` surfaces fed by same-origin `/api/media/[id]` or an
  admin https URL → CSP needs `frame-src https:` **and** `media-src blob: https:`.
- **Inline styles** — framer-motion/recharts write inline `style` attributes and
  `src/components/ui/chart.tsx` injects a dynamic `<style>` block → `style-src 'unsafe-inline'`
  is required today (nonce/hash migration is future work).
- **Next.js App Router** — the bootstrap/RSC flight payload is delivered as inline
  `<script>` blocks → `script-src 'unsafe-inline'` is required; production never uses
  `eval` (only webpack HMR in `next dev` does).
- **No client cross-origin fetch/XHR/worker** — Kodgy is scripted and the AI SDK is
  server-only → `connect-src 'self'`.
- **One `dangerouslySetInnerHTML`** (`chart.tsx`, internal theme CSS vars only);
  20 inline `style={{` uses; local Cairo font (no external font CDN).
- **Rate-limit surface** — six abuse-sensitive endpoints were identified:
  heartbeat ×2, progress, open, notification broadcast, material download, PDF upload.

## 3. Content contract matrix (the 10 checks)

The 10-check contract and its single enforcement point per check:

| # | Check | Enforced in |
|---|-------|-------------|
| 1 | authenticated | `requireUser()` at the top of every content route (`src/lib/api.ts`) |
| 2 | correct role | role branch in each route (`STUDENT`/`PARENT`/`TEACHER`/`ADMIN`) |
| 3 | enrolled | `canAccessLesson`: `student.group` must be an **active** group (`isActive`) |
| 4 | correct course | `canAccessLesson`: `student.group.courseId === courseId` (chain-resolved via `resolveLessonCourseId`) |
| 5 | correct track | `canAccessTrackScope(schoolType, lesson.trackScope)`; universe query narrowed by `trackScopeWhere` |
| 6 | session belongs to course | `resolveLessonCourseId` walks `unit → part → courseId` / `topic → unit → part → courseId` |
| 7 | lifecycle published/available | `isStudentVisibleStatus(lesson.status)` + `ARCHIVED` excluded (`session-lifecycle.ts`) |
| 8 | progression unlocked | `getCourseSessionProgress` — `status.unlocked` (sequential; `PREVIOUS_SESSION_INCOMPLETE` otherwise) |
| 9 | resource belongs to session | quiz/homework gate resolves the **owning lesson** and re-runs the full lesson gate; material resolves `material.lessonId` |
| 10 | resource available to this student | resource-own `trackScope` (may be narrower than the lesson's) + `material.isActive` + private asset |

Checks 3–8 have exactly **one** definition (`canAccessLesson` in
`src/lib/session-progress.ts`); quiz/homework (`canAccessQuiz` /
`canAccessHomework`) and materials (`authorizeMaterialDownload`) reuse it, so
there is no second, divergent authorization implementation.

## 4. Authorization matrix (route × check)

| Content route | 1 auth | 2 role | 3–8 gate | 9 belongs-to | 10 available |
|---|---|---|---|---|---|
| `GET /api/lessons/[id]` | `requireUser` | role branch | `canAccessLesson` | lesson id *is* the session | `canAccessLesson` |
| `POST /api/lessons/[id]/progress` | `requireUser` | `STUDENT` | `canAccessLesson` | — | — |
| `POST /api/lessons/[id]/video-progress` | `requireUser` | `STUDENT` | `canAccessLesson` | — | — |
| `GET /api/quizzes/[id]` | `requireUser` | role branch | `canAccessQuiz`→lesson gate | `quiz.lessonId` | `quiz.trackScope` |
| `POST /api/quizzes/[id]/start` | `requireUser` | `STUDENT` | `canAccessQuiz` | `quiz.lessonId` | `quiz.trackScope` |
| `POST /api/quizzes/[id]/submit` | `requireUser` | `STUDENT` | `canAccessQuiz` | `quiz.lessonId` | `quiz.trackScope` |
| `GET /api/quizzes/[id]/evidence` | `requireUser` | `STUDENT` | `canAccessQuiz` | `quiz.lessonId` | `quiz.trackScope` |
| `POST /api/students/me/homework` | `requireUser` | `STUDENT` | `canAccessHomework` | `homework.lessonId` | `homework.trackScope` |
| `GET /api/media/[id]` (video) | `requireUser` | role branch | batch + track + published | `sessionVideos` on asset | `isPublished` |
| `POST /api/students/me/session-videos/[id]/progress` | `requireUser` | `STUDENT` | batch match + `isPublished` | `video.id` | `isPublished` |
| `GET /api/materials/[id]` (PDF) | `requireUser` | role branch | `authorizeMaterialDownload` (full 10-check) | `material.lessonId` + `mediaAssetId` | `isActive` + `isPrivate` + `LOCAL_PRIVATE` |
| `GET/PATCH /api/notifications` | `requireUser` | any authenticated | scoped to `user.id` | `userId` | — |

## 5. IDOR — denials without existence leaks

- **Guessed lesson ids** — `canAccessLesson` answers `LESSON_NOT_FOUND` (→404) for a
  missing id *and* for wrong-track / unpublished / archived / chain-detached lessons,
  so probing cannot distinguish "does not exist" from "exists but not yours".
- **Quiz/homework ids** — `gateTrackedResource` collapses a track denial to
  `LESSON_NOT_FOUND` (non-oracle); `canAccessQuiz`/`canAccessHomework` return the
  same reason as the owning lesson.
- **Material ids** — `materialAccessHttpStatus` maps `MATERIAL_NOT_FOUND`,
  `ASSET_NOT_FOUND`, `MATERIAL_INACTIVE`, `TRACK_DENIED`, `LESSON_NOT_FOUND` → 404
  (never confirm the id is real); only `NOT_ENROLLED` / `PREVIOUS_SESSION_INCOMPLETE` /
  `FORBIDDEN_ROLE` → 403.
- **Media ids** — `GET /api/media/[id]` returns **404** for an external-URL asset
  (not 400), so `storage=EXTERNAL_URL` rows are indistinguishable from missing ids;
  DOCUMENT assets via this route are refused for non-admins (the authorized path is
  `/api/materials/[id]`).
- **Sequential ids** — ids are unguessable cuids; cross-batch video progress is
  refused (`video.batchId !== student.batchId` → 403).
- **Notifications** — mark-read is scoped to `(id, userId: user.id)`, so another
  user's notification id cannot be forged.

## 6. Rate limiting — deterministic, bounded, observable, tested

One shared mechanism: the **pure policy** module `src/lib/rate-limit.ts` composes
the **DB-backed atomic primitive** `checkRateLimit` in `src/lib/security.ts`
through `applyRateLimit` / `rateLimitedResponse` in `src/lib/api.ts`.

| Key | Default limit / window / block |
|---|---|
| `heartbeat` | 300 / 60 s / 60 s |
| `progress` | 120 / 60 s / 60 s |
| `materialDownload` | 120 / 60 s / 60 s |
| `open` | 20 / 60 s / 300 s |
| `notification` | 30 / 60 s / 300 s |
| `pdfUpload` | 30 / 60 s / 300 s |

- **Deterministic** — fixed window over a `SecurityRateLimit` row keyed by
  `(bucket, identifier)`; the identifier is `SHA-256("rl:<key>:<userId>")`, so no
  raw user id lands in the table.
- **Bounded** — env overrides `RATE_LIMIT_<KEY>=limit[/windowSec[/blockSec]]` are
  clamped into hard bounds (`limit≥1`, `window≥1`, `block≤86400`); a present-but-`0`
  component clamps to its minimum and an unparseable value falls back to the default —
  the limiter can never be disabled by misconfiguration.
- **Observable** — 429 carries `Retry-After` + `X-RateLimit-Limit` /
  `X-RateLimit-Remaining`, body code `RATE_LIMITED`, and every block is audited to
  a `SecurityEvent` row (`type=RATE_LIMITED`, `detail=limiter=<key>`).
- **Race-free (Phase 20 fix)** — the previous read-modify-write increment lost
  updates under contention. It is now three guarded statements: an idempotent
  `upsert(update:{})` (ensure row), a guarded window reset
  (`UPDATE … WHERE windowStart <= cutoff`), and a guarded claim
  (`UPDATE … SET count = count + 1 WHERE count < limit`). The real-DB verifier
  fires 40 concurrent requests at `limit=10` and asserts exactly 10 admit.

Wired into all six required surfaces: heartbeat (lesson video-progress +
batch-video progress), progress, open ceremony, notification broadcast, material
download, and admin PDF upload.

## 7. CSP — tested rollout, video and Next.js preserved

`src/lib/content-security-policy.ts` (pure) → `decideCspHeader()` → appended by
`next.config.ts` (`securityHeaders()`), on all paths, alongside the existing
X-Frame-Options / X-Content-Type-Options / Referrer-Policy / Permissions-Policy.

Production directives (summarised): `default-src 'self'`; `script-src 'self'
'unsafe-inline'`; `style-src 'self' 'unsafe-inline'`; `img-src 'self' data: blob:`;
`font-src 'self' data:`; `frame-src 'self' https: https://www.youtube.com
https://www.youtube-nocookie.com https://player.vimeo.com`; `media-src 'self' blob:
data: https:`; `connect-src 'self'`; `worker-src 'self' blob:`; `object-src 'none'`;
`base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'self'`.

- **No `unsafe-eval` in production** — the only occurrence is the development build
  (webpack HMR), gated on `NODE_ENV` and never emitted by a production server.
- **`unsafe-inline` is minimized and justified** — present only where discovery
  proved it necessary (Next.js inline bootstrap scripts + inline styles).
- **Incremental rollout is an operator decision, not a redeploy** —
  `CSP_REPORT_ONLY=1` downgrades to `Content-Security-Policy-Report-Only`;
  `CSP_DISABLED=1` removes the header. Defaults are the safe state (enforced).
- **Asserted at runtime over real HTTP** (§13): production CSP has no
  `unsafe-eval`, `object-src 'none'`, `frame-ancestors 'self'`.

## 8. Session legacy fallback — removed, not blindly

`src/lib/auth.ts` no longer reads `Setting:session:<token>` and no longer writes the
`Setting` table; a token with no `UserSession` row now returns
`NO_SESSION` immediately.

Justification for removing it now (and not before):

1. The read-time migrator *was* the migration, and it ran on every session used
   since the Platform Upgrade — those sessions are all `UserSession` rows.
2. Legacy rows carried a 7-day TTL, so any `Setting:session:*` row still
   un-migrated is expired by construction and cannot be a valid production session.
3. Rollback semantics are understood: removing the branch logs out any dormant
   legacy token holder (they log in again) — the intended, non-blind cleanup.

The precondition ("no valid session depends on it") is **provable**, not assumed:
`scripts/audit-legacy-sessions.mjs` classifies rows (`STILL-VALID` / expired /
malformed), exits non-zero on still-valid rows, and only `--purge` removes
well-formed expired rows (leaving malformed rows for manual review). Admin settings
keep excluding `session:` keys from the UI.

## 9. Media security

`GET /api/media/[id]` (the only private-media reader) and `GET /api/materials/[id]`
(the PDF path):

- **Authorization** — video streams require batch membership + track match +
  `isPublished` (track derived server-side from the student's own `schoolType`,
  never from a URL batch id — the sticky-batchId hole is closed). Quiz evidence is
  ADMIN-only. DOCUMENT assets cannot be read here by non-admins (they must go
  through the full 10-check material contract).
- **Range** — strict, regex-anchored parsing on both routes; non-numeric / negative /
  out-of-range bounds → **416** `bytes */<total>` (previously NaN coerced to 0 and
  produced a bogus `bytes NaN-NaN/…` 206). `Accept-Ranges: bytes`, `Content-Disposition`,
  and `Cache-Control: private, no-store` are set.
- **Cross-track / cross-course / unpublished / archived** coverage is inherited from
  `canAccessLesson` + `authorizeMaterialDownload` (see §3–§5).

## 10. Upload security

`src/lib/media.ts` (shared by the admin PDF upload route) enforces, before any
`writePrivateFile`:

- **MIME allow-list** — `application/pdf` only.
- **Magic bytes** — `%PDF-` signature check (`MAGIC_REJECTED` otherwise).
- **Extension** — coerced to `.pdf`; **filename** — `sanitizeOriginalFilename`
  strips path separators, null bytes, control characters and traversal segments.
- **Size cap** — `MAX_PDF_BYTES` (default 25 MB, `MEDIA_MAX_PDF_BYTES`).
- **No temp files** — buffers are validated and written atomically to private storage.

**Antivirus decision (ADR-004, `docs/decisions/ADR-004-antivirus-upload-security.md`)**
— this phase does **not** claim AV protection. The accepted posture is
defense-in-depth (size + MIME + magic + extension + filename + traversal) with a
documented future scanner insertion point between `writePrivateFile` and the DB
commit; no ClamAV integration yet. Storage **quota** is deferred to Phase 21 (it is
a volume/disk-sizing concern, not a validation concern).

## 11. Notification security

- **Links** — `mintNotificationLink` / `validateNotificationLink`
  (`src/lib/notification-links.ts`) go through the strict `parseDeepLink` parser;
  ids are restricted to 1–64 URL-safe chars; deep links are navigation only and
  never authorize by themselves (`src/lib/deep-link.ts`).
- **Scope** — authenticated notification reads and mark-read are scoped to the
  caller's `userId` (no cross-user read/forge).
- **Preferences** — admin broadcast honours `partitionByNotificationPreferences`
  (per-type + quiet-hours); the bypass is closed at the bulk layer (`notify.ts`).
- **Fan-out** — chunked (`chunkList`), batched (`createMany`), and deduped per user
  (no double notification on a retried open).

## 12. Security test suite

`tests/security-hardening-phase20.test.js` (new, offline) — 185 assertions in 12
sections: (1) rate-limit policy, (2) CSP, (3) authorization matrix, (4) IDOR,
(5) cross-track/cross-course/premature access, (6) notification security,
(7) rate-limit wiring, (8) legacy-fallback removal, (9) CSP + headers at the edge,
(10) real-DB verification, (11) legacy-session audit script, (12) real HTTP.

`scripts/verify-phase20-security.mjs` — real-SQLite verifier for `checkRateLimit`
determinism / boundedness / atomicity / window-reset / block / no-raw-ids / policy
math / CSP (42 assertions, `PHASE20_VERIFY_OK`).

`scripts/verify-phase20-http.mjs` — real HTTP server (§13).

## 13. Real HTTP — actual server, actual sessions, actual traffic

`next dev`/`next build` cannot start in this sandbox because
`binaries.prisma.sh` is unreachable (Prisma client cannot be generated; documented
across Phases 6–19). The real-HTTP requirement is therefore met the same way every
other verify script does: the shipped modules are compiled with tsc, only
`@/lib/db` is substituted with a real node:sqlite adapter (real tables, real rows,
real SQL), and they are served behind a real `node:http` server exercised with real
`fetch` over a real TCP socket. The modules under test are byte-for-byte the shipped
TypeScript.

Proven over the wire (`PHASE20_HTTP_OK`, 26/26):

- **CSP** — `Content-Security-Policy` present, no `unsafe-eval`, `frame-ancestors
  'self'`, `object-src 'none'`; `CSP_REPORT_ONLY=1` → report-only header;
  `CSP_DISABLED=1` → header absent.
- **Rate limiting** — `enforceRateLimit` → `checkRateLimit` chain: 3×200 then 2×429
  with `X-RateLimit-Limit: 3`, `X-RateLimit-Remaining: 0`, `Retry-After`, body code
  `RATE_LIMITED`; the refusal is audited to a real `SecurityEvent` row and the
  stored counter never exceeds the limit.
- **Sessions** — real `UserSession` rows + real `cm_session` cookies through the
  real `getCurrentUserDetailed`: valid → 200 `{id, role}`; missing/unknown → 401
  `NO_SESSION` (indistinguishable); revoked → 401 `REVOKED`; expired → 401 `EXPIRED`.

## 14. Browser security

- **Clickjacking** — `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'`.
- **MIME sniffing** — `X-Content-Type-Options: nosniff`.
- **Referrer** — `Referrer-Policy: strict-origin-when-cross-origin` (protects
  `?token=` reset links).
- **Camera** — `Permissions-Policy: camera=(self)` (quiz proctoring only);
  microphone/geolocation/payment/usb disabled.
- **CSP** — enforced (§7). The one `<iframe>` (lesson embed) is an admin-provided
  https URL under `frame-src`; no `sandbox`/`allow` regression introduced.
- Full AR/EN × RTL/LTR × 4-role browser pass is a **Phase 22** deliverable
  (strict boundary, §17); this phase ships the header layer and proves it over a
  real server.

## 15. Regression

- All 24 pre-existing offline suites **pass** (authorization-invariants,
  security-hardening, session-* , track-architecture, teacher-workflow,
  parent-analytics-alignment, …).
- `npx tsc --noEmit` — **26 errors, unchanged** from the recorded baseline
  (`/tmp/tsc-baseline.txt`); the only Phase 20 file touched is `api.ts(6,15)`
  (missing `Role` export from the un-generatable Prisma client) — a pre-existing
  environmental error, not a Phase 20 regression.
- `npx eslint .` — **134 problems (133 errors, 1 warning), unchanged**; zero
  problems in any Phase 20 file.
- `next.config.ts` still enforces the production-secret contract and preserves the
  existing headers.

## 16. Completion contract

| Brief item | Status |
|---|---|
| 10-check contract matrix green | ✅ `canAccessLesson` is the single definition; matrix in §4 |
| IDOR / cross-track / cross-course / premature / PDF-guess / link-bypass matrices | ✅ §5, §11, §12 |
| Rate limits (heartbeat/progress/open/notification/download/upload) | ✅ deterministic, bounded, observable, tested (§6, §13) |
| Tested CSP rollout preserving video + Next.js | ✅ §7, §13 |
| Legacy `Setting:session:*` fallback removed | ✅ with provable precondition (§8) |
| Media route hardening with Range/disposition/cross-track/course/unpublished/archived | ✅ §9 |
| Upload review + ClamAV/AV decision | ✅ ADR-004 (§10) |
| `tests/security-hardening-phase20.test.js` | ✅ 185/185 |
| Real HTTP server tests | ✅ §13, 26/26 |
| Browser verification | ✅ header layer proven over a real server; full pass is P22 (§14) |
| No regressions | ✅ §15 |
| Final verdict | ✅ §21 |

No HIGH-or-above open risk remains except the accepted-and-documented limitations
(§20).

## 17. Strict boundary

**Not** implemented, touched, or planned here: Postgres migration, durable storage
migration, backup infrastructure, production deployment, or Phase 22 go-live.
Storage quota and the full browser pass are explicitly deferred (Phase 21 / Phase
22). The CSP, rate limits, and session-fallback removal were implemented **only**
against discovered runtime requirements; no `unsafe-eval` was added to production
and no antivirus claim was made without an integration.

## 18. Secrets & headers re-audit

- `SECURITY_HASH_SECRET` fail-fast (build + runtime) unchanged — the hashed
  rate-limit identifiers and device/IP hashes all flow through it; no raw PII
  enters `SecurityRateLimit` or `SecurityEvent`.
- Header baseline (X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
  Permissions-Policy) preserved; CSP appended, with the `poweredByHeader: false`
  fingerprinting defense unchanged.
- `.env.example` now documents `RATE_LIMIT_*`, `CSP_REPORT_ONLY`, and
  `CSP_DISABLED`.

## 19. Test evidence & results

| Verifier | Result |
|---|---|
| `node tests/security-hardening-phase20.test.js` | **185 passed, 0 failed** |
| `node scripts/verify-phase20-security.mjs` | **42 passed, 0 failed — PHASE20_VERIFY_OK** |
| `node scripts/verify-phase20-http.mjs` | **26 passed, 0 failed — PHASE20_HTTP_OK** |
| 24 pre-existing offline suites | **all PASS** |
| `npx tsc --noEmit` | 26 errors = recorded baseline (no new errors) |
| `npx eslint .` | 134 problems = recorded baseline (0 in Phase 20 files) |

## 20. Known limitations & blockers

- **Prisma engine download is blocked** (`binaries.prisma.sh` TLS disconnect), so
  the client cannot be regenerated and `next dev`/`next build`/`prisma migrate`
  cannot run in this sandbox. The generated client is stale (missing `Role`).
  Consequence: real HTTP was verified by compiling the shipped modules against a
  real node:sqlite adapter (the only substitution is the Prisma data source), and
  `tsc`'s 26 errors are the pre-existing environmental baseline.
- **AV is not integrated** — the ADR-004 posture is documented defense-in-depth;
  a scanner insertion point is defined but unused until a real AV decision is made.
- **CSP `unsafe-inline` for script/style** remains until a nonce/hash migration
  (future work; not possible to remove without breaking Next.js bootstrap and the
  inline-style components).
- **Storage quota** is deferred to Phase 21.

## 21. Final verdict

Phase 20 is complete and verified: the 10-check authorization contract has one
authoritative implementation and a route-by-route matrix; IDOR denials are
non-oracle; rate limiting is deterministic, bounded, observable, and race-free;
the CSP is derived from real runtime requirements with an operator kill-switch;
the legacy session fallback is removed under a provable precondition; and media,
upload, and notification surfaces are hardened. All offline suites, the real-DB
verifier, and the real-HTTP verifier pass, with zero regressions.

Separate pre-merge audit required.
