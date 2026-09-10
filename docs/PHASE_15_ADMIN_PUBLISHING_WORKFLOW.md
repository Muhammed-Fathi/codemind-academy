# Phase 15 — Admin Publishing Workflow (Create/Edit → Stage → Checklist → OPEN)

Date: 2026-09-10 (implemented and verified in-sandbox).
Roadmap reference: `docs/MASTER_PLATFORM_AUDIT_AND_ROADMAP.md` §17 (publication
lifecycle) — **this phase implements the ADMIN OPERATOR half: the screens and
thin API routes that drive the Phase 13 ceremony. It adds no lifecycle rules,
no state machine, no migration.**

This document is the contract. Where the brief was ambiguous, this file states
the decision, the reason, and what was measured.

---

## 1. What changed, in one page

Before Phase 15, the lifecycle ceremony existed but had no operator: staging a
session meant calling API routes by hand, and there was no screen that showed
*why* a session could not be opened yet. Phase 15 adds the coherent workflow:

```
Create/Edit → Stage Materials → Readiness Checklist → Review → OPEN
```

| surface | file | calls (never re-implements) |
|---|---|---|
| session list + create + archive | `src/components/admin/session-workflow-view.tsx` | `GET/POST /api/admin/lessons`, `POST …/archive` |
| session detail: edit, stage, checklist, review, OPEN | `src/components/admin/session-detail-view.tsx` | `GET/PATCH …/[id]`, `GET …/[id]/readiness`, `POST …/mark-ready`, `POST …/open`, `POST …/unpublish` |
| open confirmation | `src/components/admin/session-open-dialog.tsx` | shows the server verdict + expected effect |
| PDF staging | `src/components/admin/session-pdf-manager.tsx` | Phase 14 `…/[id]/materials` + `/api/materials/[id]` |
| video staging | existing `session-videos-view` | Phase 9 `session-videos` API (reuse = re-attach) |
| quiz/homework attach | navigates to existing bank surfaces | **no new endpoints** (Phase 18 owns quiz/homework authoring) |

API routes added (all ADMIN-only, all thin — parse, call the Phase 13/14
library, map the outcome):

- `GET /api/admin/lessons` — paginated list, optional `includeReadiness=1`
- `POST /api/admin/lessons` — DRAFT-only creation on the canonical chain
- `GET /api/admin/lessons/[id]` — full detail in ONE response
- `PATCH /api/admin/lessons/[id]` — seven safe keys only
- `GET /api/admin/lessons/[id]/readiness` — the checklist (`getLessonReadiness`)
- `POST …/mark-ready`, `POST …/open`, `POST …/unpublish` — the ceremony
- `POST …/archive` — archive/restore (never touches `status`)

Validators live in `src/lib/admin-sessions.ts` (compiled + unit-tested for
real in `tests/admin-publishing-phase15.test.js`).

---

## 2. Non-negotiable rules (and where they are enforced)

1. **The UI never computes lifecycle or readiness.** Every readiness value on
   screen comes from the server's `readiness` object. Importing
   `computeLessonReadiness` into a component is the defect the suite's
   section H exists to prevent (absence pins over every workflow file).
2. **The UI never writes `status`.** PATCH accepts seven keys; `status`,
   `isPublished`, `officialCode`, `curriculumStatus`, placement and legacy
   media URLs are `FORBIDDEN_FIELD` rejections. Proven by the PATCH e2e
   cases (Q17) and the validator unit tests.
3. **OPEN runs the Phase 13 ceremony.** The route calls `openLesson` and maps
   `LifecycleCode → HTTP` via `lifecycleHttpStatus`. No second implementation
   exists; section G pins the call sites.
4. **Readiness is previewed by the same computation the ceremony enforces.**
   `GET …/readiness`, `GET …/[id]` and `GET …?includeReadiness=1` all serve
   `getLessonReadiness` / `computeLessonReadiness` over live rows. The e2e
   proves preview and verdict agree (Q06/Q13/Q24) and that OPEN re-evaluates
   from live rows (Q28b: regress the video after READY → `READINESS_BLOCKED`).
5. **Archived lessons are immutable.** PATCH → `409 LESSON_ARCHIVED`, ceremony
   → `409 LESSON_ARCHIVED`, checklist names `CURRICULUM_ARCHIVED`, restore
   re-derives standing from `officialCode`. E2e Q33–Q36.
6. **Everything is idempotent.** Re-open returns the same publication id;
   re-mark-ready and re-archive are `NO_OP_*` with `changed: false` and write
   nothing. E2e Q26/Q29/Q33.
7. **No storage keys leave the server.** Material selects omit `storageKey`;
   the e2e asserts the key is absent from the object AND the raw payload (Q20).

---

## 3. API contract (stable codes)

Creation / update / list parsing (`src/lib/admin-sessions.ts`):

- `INVALID_BODY`, `TITLE_REQUIRED`, `TITLE_TOO_LONG`, `INVALID_DESCRIPTION`,
  `INVALID_SUMMARY`, `INVALID_DURATION`, `INVALID_ORDER`,
  `INVALID_TRACK_SCOPE`, `UNIT_ID_REQUIRED`, `UNIT_NOT_FOUND` (404),
  `FORBIDDEN_FIELD:<field>`, `NOTHING_TO_UPDATE`
- List: `INVALID_STATUS`, `INVALID_TRACK_SCOPE`, `INVALID_CURRICULUM_STATUS`,
  `INVALID_PAGE`, `INVALID_PAGE_SIZE` (all with `:field` suffix). `pageSize`
  is **clamped** to 200, not rejected; `pageSize=0` is rejected.
- Archive: `INVALID_ARCHIVE_ACTION`, `ARCHIVE_REQUIRES_UNPUBLISH` (409),
  `NO_OP_ALREADY_ARCHIVED`, `NO_OP_NOT_ARCHIVED`.

Ceremony (`src/lib/session-lifecycle.ts`, unchanged semantics):

- `OK` → 200, `NO_OP_ALREADY_IN_STATE` → 200, `LESSON_NOT_FOUND` → 404,
  everything else → 409 (`READINESS_BLOCKED`, `ILLEGAL_TRANSITION`,
  `LESSON_ARCHIVED`, `LESSON_NOT_IN_COURSE`, `CONCURRENT_CHANGE`).
- Check order is structural: archived → in-course → already-in-state →
  **state machine** → readiness. OPEN from DRAFT is therefore
  `ILLEGAL_TRANSITION` even when the lesson is also blocked (e2e Q30) —
  "READY cannot be bypassed" is a machine property, not a message.

---

## 4. End-to-end verification (the strongest gate)

`scripts/verify-phase15-admin.mjs` (216 assertions, all green) drives the
**shipped route handlers** — compiled from `src/` with the repo's own `tsc`,
exactly like `scripts/verify-phase13-db.mjs` — against **real SQLite** built
from the base DDL + every real `migration.sql`, with **real media bytes** on
a scratch disk:

- A: all 19 touched tables match `prisma/schema.prisma` exactly.
- Q01–Q06: list ordering (canonical + legacy chains), filters, search,
  pagination, clamp, `includeReadiness`, auth matrix (ADMIN/TEACHER/STUDENT/
  anonymous).
- Q07–Q12: DRAFT-only creation, all 400s, 404 unit, `max+1` order, audit.
- Q13–Q17: detail payload (quizzes/homeworks/videos/materials/readiness/
  publication/history), empty-quiz + missing-instructions blockers, PATCH
  safe-keys + refusals.
- Q18–Q21: PDF upload (kind, scope inheritance, `pdfUrlWritten: false`,
  bytes on disk, `Lesson.pdfUrl` untouched), 415/400s, `storageKey` absence,
  byte-identical download (inline + `?download=1` attachment), 401/404.
- Q22–Q24: video upload + publish, 404/400/413, **reuse by re-attach**
  (PATCH `lessonId`), SHARED two-batch rule + missing-batch note, full item
  codes (`VIDEO_OK`, `PDF_PRESENT_NOT_REQUIRED`, `QUIZ_OK`, `HOMEWORK_OK`).
- Q25–Q32: mark-ready → open → double-open (same publication id) →
  blocked-DRAFT refusal → unpublish (mirror flips back) → teacher/anon 403/401.
- Q28b: OPEN re-checks readiness from live rows (regress → refuse → restore).
- Q33–Q36: archive (incl. `ARCHIVE_REQUIRES_UNPUBLISH`), archived
  immutability, restore re-derivation, invalid action, 404.
- Q37–Q40: FIXED pins (3) vs RANDOM (0), pool math (`null` schoolType joins
  both pools: ARABIC 6, LANGUAGE 5), video batch filter + lesson join,
  external-URL video, DELETE refcount cleanup.
- F1–F3: publication withdrawn by unpublish; full audit trail
  (`LESSON_CREATE/UPDATE/MATERIAL_UPLOAD/MARK_READY/OPEN/UNPUBLISH/ARCHIVE/RESTORE`);
  exactly the PDF + mp4 bytes on disk.

Shimmed (documented in the script header): `@/lib/db` (real-SQL adapter —
the Prisma engine binary is unreachable from the sandbox),
`@/lib/auth` (script user; `requireRole` still runs), `next/server`
(status/headers/json/bytes), `next/headers` (no cookie → `ar`).

Section Q of `tests/admin-publishing-phase15.test.js` executes this script
(384/384 with the e2e gate included).

---

## 5. Bugs found by verification (fixed in this phase)

**5.1 SHIPPED BUG — `QUIZ_EMPTY` blocked every quiz-carrying lesson.**
`READINESS_LESSON_INCLUDE` selects quizzes as `{ _count: { questions: N } }`,
but `questionCountOf` only read `questionCount` / `questions[]` — the count
the loader selected was ignored, read as "unknown", failed closed to
`QUIZ_EMPTY`, and made the lesson un-openable. The pure-function tests never
caught it because they hand-shaped inputs with `questionCount`. Fix (minimal,
in `src/lib/session-lifecycle.ts`): the input type now declares the `_count`
member and the reader accepts it (precedence: explicit count → loader `_count`
→ array length). Regression: e2e Q24/Q25 + suite Q1–Q5.

**5.2 Harness bugs (verification tooling, not shipped code).**
`scripts/lib/sqlite-prisma-lite.mjs` gained: `groupBy`, `aggregate`,
nested-relation `orderBy` (correlated subselects), bound-parameter `_count`,
and correct to-one back-relation cardinality (`Lesson.publication` projected
as `[]` instead of `null`, faking a phantom publication). Every newly
supported shape previously threw `UnsupportedQuery`, so no existing suite
could regress — confirmed by the full 20-suite run below. Shared migration
helpers were extracted verbatim to `scripts/lib/migrate-sqlite.mjs`.

---

## 6. Browser verification (real Chromium, geometric)

Two scenes added to the visual harness — `admin-session-workflow` (populated
list: DRAFT/READY/PUBLISHED rows, long AR/EN titles) and
`admin-session-detail` (populated detail via store `navParam`) — with fetch
stubs mirroring the real payloads. Run in real Chromium 149 (sparticuz
binary + its `al2023` libs, `LD_LIBRARY_PATH`-loaded; no system browser or
package network in the sandbox):

**`node tests/visual/run-visual-tests.mjs`: 822 passed, 0 failed**
(14 scenes × 3 viewports × RTL/LTR: no overflow, no clipped controls,
direction matches locale, icons clear of text, panels inside viewport,
no runtime errors).

---

## 7. Regression status

All 20 suites green (2,957 assertions, 0 failures), including the suites that
share the touched code (`session-lifecycle-phase13`: 294, incl. its own
real-DB layer; `session-materials-phase14`: 127; `track-architecture-phase12`:
302; `session-progression`: 162; `session-quiz`: 70; `security-hardening`:
259; `authorization-invariants`: 93).

- `tsc --noEmit`: 22 errors before and after — all pre-existing (stub
  `@prisma/client` enum imports + older surfaces), **zero in Phase 15 scope**.
- ESLint on touched/new Phase 15 files: clean.
- `next build`: Turbopack compiles successfully; the build's type gate fails
  only on the same 22 pre-existing errors. `npm run build` additionally needs
  `prisma generate`, which is unreachable in-sandbox (`binaries.prisma.sh`
  TLS) — the documented all-phases environment limitation, unchanged.

---

## 8. Deferred, by decision

- **Quiz/homework authoring endpoints (Phase 18).** The workflow links to the
  existing question-bank and videos surfaces; it does not invent
  create/update endpoints for quizzes or homework. Suite section P pins this.
- **Teacher content review.** All admin lessons routes are ADMIN-only; the
  readiness route header records that teacher review is not claimed here.
- **Notifications on OPEN (Phase 17).** The ceremony writes the
  `SessionPublication` row and stops — no fan-out, verified by absence (no
  notification writes in the e2e audit trail).
- **Student locked UI, parent redesign, Postgres.** Untouched, per the brief's
  strict boundary.

---

## 9. Files

New: `src/lib/admin-sessions.ts`, `src/app/api/admin/lessons/**` (8 routes),
`src/components/admin/session-{workflow-view,detail-view,workflow-shared,open-dialog,pdf-manager}.tsx`,
`tests/admin-publishing-phase15.test.js`,
`scripts/verify-phase15-admin.mjs`, `scripts/lib/migrate-sqlite.mjs`,
`docs/PHASE_15_ADMIN_PUBLISHING_WORKFLOW.md`.

Modified: `src/lib/session-lifecycle.ts` (reader/loader contract fix only),
`scripts/lib/sqlite-prisma-lite.mjs` (additive query support + 2 harness
bug fixes), `tests/visual/{harness.tsx,run-visual-tests.mjs}` (2 scenes +
stubs), `src/components/{app-shell,admin/admin-dashboard,admin/mock-exams-view,dashboard/shell}.tsx`
(view wiring), `src/lib/{i18n-dict-2026.ts,store.ts}` (keys + view keys).
