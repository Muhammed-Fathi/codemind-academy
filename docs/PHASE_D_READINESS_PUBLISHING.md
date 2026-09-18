# Phase D — Readiness & Publishing Aligned to the Real Academic Session

> Status: implemented, all gates green. Dedicated suite: `tests/phase-D-readiness-publishing.test.js` (321 assertions).
> Branch: `arena/01a0b5fb-codemind-academy` (the dedicated Phase D branch for this work).
> Date: 2026-09-18.

## 1. The decision, in one paragraph

A Lesson **is** the academic Session. A real session is only teachable when it has
its **video**, its **PDF/material**, its **quiz**, and its **homework**. Phase D makes
`computeLessonReadiness` — the single server-side readiness authority in
`src/lib/session-lifecycle.ts` — require **all four components** before a lesson can
be normally staged (READY) or opened (PUBLISHED), and adds a loud, audited,
Admin-only **emergency override** for the exceptional case where an admin must open a
session anyway. No second readiness implementation exists anywhere; the UI renders
the server verdict verbatim.

## 2. The readiness contract (Phase D)

`computeLessonReadiness(input)` returns four items, keys `VIDEO | PDF | QUIZ |
HOMEWORK`, **all `required: true`**. An item has `state ∈ {OK, MISSING, INVALID}`
(no `NOT_APPLICABLE` for these four any more), `present`, `valid`, `required`,
`code`, and machine `notes[]`. `canBeReady` is true iff no item blocks and the
curriculum is not archived. `blocking` lists codes in a fixed order
(`CURRICULUM_ARCHIVED` first, then VIDEO, PDF, QUIZ, HOMEWORK) so two snapshots diff
literally.

### 2.1 VIDEO — modern SessionVideo is the authority

A session video counts when a **published `SessionVideo`** linked to the lesson
covers the lesson's audience:

- audience = `ARABIC` for `trackScope: ARABIC`, `LANGUAGE` for `trackScope:
  LANGUAGE`, **both** for `SHARED` (`audienceTracksForScope`);
- a `SessionVideo` covers a track iff it is `isPublished` and its batch's
  `schoolType` is that track;
- per-track state is `OK | MISSING | PARTIAL` → item `OK | MISSING | INVALID`
  (`VIDEO_TRACK_INCOMPLETE`).

Codes & notes: `VIDEO_OK`, `VIDEO_MISSING`, `VIDEO_TRACK_INCOMPLETE`; notes
`VIDEO_PRESENT_BUT_UNPUBLISHED` (rows exist but none published — "a video exists,
publish it", not "add a video"), `SHARED_VIDEO_MISSING_BATCH:<track>`, and
`VIDEO_LEGACY_URL_NOT_COUNTED` when the lesson carries a legacy `videoUrl`.

**The legacy `Lesson.videoUrl` is never a readiness authority.** It is still a valid
column and is still read by student-facing readers/compat layers exactly as before —
it simply does not satisfy readiness, and the admin is told so via the note.

### 2.2 PDF / Material — Phase 14 architecture, now REQUIRED

A material qualifies when **at least one `Material` row** on the lesson is:

1. **active** (`isActive: true`),
2. **a document for the audience**: `kind: ADMIN_UPLOADED` with `mediaAssetId` set,
   or `kind: GENERATED` with `mediaAssetId` set (a GENERATED row with no asset is
   not a document),
3. **track-valid for the audience**: `trackScope: SHARED` or the lesson's own track
   (foreign-track-only rows earn a `PDF_PRESENT_BUT_OTHER_TRACK:<n>` note and give no
   credit).

Codes: `PDF_OK`, `PDF_MISSING`, `PDF_TRACK_INCOMPLETE` (audience only partially
covered). Legacy `pdfUrl` never satisfies; note `PDF_LEGACY_URL_NOT_COUNTED`. No new
storage system was introduced — the Phase 14 `Material`/`MediaAsset` architecture is
the sole mechanism.

### 2.3 QUIZ — exists and has questions

A quiz counts when it is track-valid for the audience **and has ≥1 question** (read
via `_count.questions`; an unreadable count fails closed → INVALID).

Codes: `QUIZ_OK`, `QUIZ_MISSING` (nothing usable for the audience), `QUIZ_EMPTY`
(covering quizzes exist but none has questions), `QUIZ_TRACK_INCOMPLETE`. Notes:
`QUIZ_INVALID_FOR_TRACK:<T>` (empty/broken quiz for a covered track),
`QUIZ_MISSING_TRACK:<T>` (audience track with no quiz while others exist),
`QUIZ_PRESENT_BUT_OTHER_TRACK:<n>`. Quiz attempts, scoring, retries and progression
are untouched.

### 2.4 HOMEWORK — exists and has instructions

A homework counts when it is track-valid for the audience and its `instructions` are
non-empty after trimming (placeholder `"#"` does not count).

Codes: `HOMEWORK_OK`, `HOMEWORK_MISSING`, `HOMEWORK_INSTRUCTIONS_EMPTY`,
`HOMEWORK_TRACK_INCOMPLETE`; notes mirror the quiz section
(`HOMEWORK_INVALID_FOR_TRACK:<T>`, `HOMEWORK_MISSING_TRACK:<T>`,
`HOMEWORK_PRESENT_BUT_OTHER_TRACK:<n>`). Submission, grading and progression are
untouched.

### 2.5 Track-safety summary ("present" = present FOR THE AUDIENCE)

All four dimensions share one convention: content that exists **only on another
track** never gives partial credit — the requirement stays `MISSING` with a
`*_PRESENT_BUT_OTHER_TRACK:<n>` note so the admin sees the observation. Partial
audience coverage (something applicable exists but not for every audience track) is
`INVALID` (`*_TRACK_INCOMPLETE`). This is the Phase A/B track-isolation guarantee
carried into readiness.

## 3. The ceremonies (unchanged shape, stricter gate)

`markLessonReady` / `openLesson` / `unpublishLesson` / `archiveLesson` /
`transitionLesson` keep their exact API. Readiness is computed **live** from the rows
at ceremony time (never cached, never client-trusted); a stale READY stamp cannot open
a lesson whose content was deleted afterwards. Guard order (each before readiness):
lesson exists → belongs to the course (when provided) → not archived → idempotent
no-op → transition legality → readiness gate.

`lifecycleHttpStatus`: `OK`/`NO_OP_ALREADY_IN_STATE` → 200, `NOT_FOUND` family → 404,
`READINESS_BLOCKED`/`ILLEGAL_TRANSITION`/`CONCURRENT_CHANGE` → 409,
`OVERRIDE_REASON_INVALID` → 400.

## 4. The emergency override (Admin-only, never silent)

- `openLessonWithOverride({ lessonId, actorUserId, reason, courseId?, client })`
  runs when readiness blocks and the admin insists.
- **Reason validation**: trimmed, non-empty, ≤ 1000 chars
  (`OVERRIDE_REASON_MAX_LENGTH`). Empty → `OVERRIDE_REASON_REQUIRED`, too long →
  `OVERRIDE_REASON_TOO_LONG`, surfaced as ceremony `OVERRIDE_REASON_INVALID`
  (HTTP 400).
- **Override-engaged opens ALWAYS execute `applyOverrideOpen`**, even when readiness
  happens to pass, so the override itself is recorded: conditional DRAFT→READY
  staging inside the same transaction when needed, publication upsert (the
  `update: {}` arm never clobbers an existing row), and audits:
  - `LESSON_MARK_READY` with `via: "EMERGENCY_OVERRIDE"` (only when staged),
  - `LESSON_OPEN` with `override: true` + `overrideUsed` + `missing[]`,
  - **`LESSON_OPEN_OVERRIDE`** with `from`, `to`, `used`, `missing[]` (the missing
    requirement codes at override time), the `reason` (truncated to 4000 chars in
    `details`), and `publicationId`.
- **Nothing is bypassed**: archived, cross-course, not-found, concurrency
  (conditional `updateMany`), and idempotent-already-published all still refuse
  first. `MARK_READY`/`UNPUBLISH` ignore any smuggled `override` param. The normal
  `openLesson` path still enforces readiness.
- Result carries `override: { used, reason, missing }`; `used = !canBeReady`
  (a requested-but-unneeded override reports `used: false, missing: []`). Normal
  ceremonies return `override: null`.
- Repeated override attempts are traceable: one `LESSON_OPEN_OVERRIDE` audit row per
  override-engaged open.

### Route

`POST /api/admin/lessons/[id]/open-override` (body `{ reason }`):
`requireRole("ADMIN")` → rate limit (`"open"`) → `openLessonWithOverride` →
`lifecycleHttpStatus` mapping. Success mirrors the normal open route exactly:
200 `{ code, from, to, changed, readiness, publication, override }` plus
`emitSessionPublicationNotifications(...)` fan-out (with the `courseId: null`
fallback since open routes read no courseId input — same as `[id]/open`). Invalid
reason → 400 `{ error: code }` and a best-effort `LESSON_OPEN_OVERRIDE_REJECTED`
audit row. Teacher/Student/Parent → 403 (route is ADMIN-only), anonymous → 401.

## 5. Admin UI changes

- **Scroll fix (the critical one)**: `OpenSessionDialog` and `MarkReadyDialog` are
  now a bounded flex column — header & footer `shrink-0`, one
  `flex-1 min-h-0 overflow-y-auto` middle region
  (`data-testid=open-dialog-scroll-region`) — so the action buttons are always
  reachable on desktop, small laptops, and mobile. The nested `ScrollArea` (the
  clipping bug) is gone entirely, including from imports.
- **Open control available on DRAFT as well as READY** (non-archived), because the
  override path lives inside the dialog. When readiness blocks, the normal confirm
  button stays disabled and a warning panel appears (missing requirements with human
  Arabic labels via `readinessReasonText`, admin.596/597), a mandatory reason
  textarea (`open-override-reason`, ≤1000 chars + counter) and a destructive confirm
  (`open-override-confirm`). `canOverride = readinessBlocked && !archived`.
- 409 keeps the dialog open with a refreshed server checklist; hints admin.606/607
  explain both modes; archived shows admin.623.
- `ReadinessChecklist` renders human reason lines for every blocking code (Arabic
  first; the raw codes remain for logs/tests). Homework/quiz labels no longer say
  "اختياري" — `admin.432`/`admin.434` now read "(مطلوب للجاهزية)".
- **State consistency without polling**: every ceremony completion calls the parent
  `load()` refetch (single GET for detail; list refetches on navigation/mutation).
- New i18n keys `admin.595`–`admin.624` (override warning, reason placeholder,
  missing-item labels, per-code human reasons).

## 6. Security model (verified by suites)

- Role gates: `requireRole("ADMIN")` on every lifecycle route; the dedicated suite
  pins that teacher/student/parent lessons routes never reference
  `openLesson`/`transitionLesson`/`openLessonWithOverride`.
- Cross-course denial: `openLesson({ courseId })` still refuses with
  `LESSON_NOT_IN_COURSE` (the override path inherits the same guard).
- Cross-track safety: readiness never credits other-track content (2.5).
- No client-trusted state: readiness is recomputed server-side at every ceremony.
- Audit reuse: everything goes through the existing `AuditLog` (details JSON
  strings); no second audit system.

## 7. What changed for older suites (contract migration)

- `tests/session-lifecycle-phase13.test.js` — sections 4–7 rewritten in place for the
  four-requirement contract (legacy `videoUrl` no longer counts; PDF/quiz/homework
  required); ceremony `ready()` fixture stages all four components via
  SessionVideo/Material/Quiz/Homework; blocking order now
  `["VIDEO_MISSING","PDF_MISSING","QUIZ_EMPTY","HOMEWORK_INSTRUCTIONS_EMPTY"]`.
  314/0.
- `scripts/verify-phase13-db.mjs` — stages the full Phase D content set against the
  real SQLite DB (batches, media assets, session videos, material, quiz+question,
  homework); mutation control breaks readiness by deleting the homework row. 314/0
  (same run).
- `tests/session-materials-phase14.test.js` §7 — Material is now REQUIRED; codes
  `PDF_OK`/`PDF_MISSING`; foreign-track behaviour preserved. 131/0.
- `tests/admin-publishing-phase15.test.js` + `scripts/verify-phase15-admin.mjs` —
  blocking expectations include `PDF_MISSING`; item codes expect `PDF_OK`; I15 pin
  updated for the `(isDraft || isReady) && !archived` open control. 386/0 (e2e
  220/0).
- Phase A/B/C, phase16, phase12, phase20, media-audit, progression,
  parent-isolation, authz, quiz suites: **no changes needed**, all green.

## 8. Verification snapshot (2026-09-18)

- `npx tsc --noEmit` → exit 0.
- `tests/phase-D-readiness-publishing.test.js` → **321 passed, 0 failed** (sections
  1–20: readiness matrix, ceremonies, override validation + audit, role denials,
  cross-course/cross-track, modern vs legacy video, deletion re-blocks, Phase C and
  progression untouched, schema/data integrity, UX pins, route wiring).
- Regression battery: phase13 314/0 · phase14 131/0 · phase15 386/0 · phase16 381/0
  · phase12 310/0 · phase20 193/0 · media-audit 218/0 · progression 163/0 ·
  parent-isolation 112/0 · authz 94/0 · quiz 70/0 · phaseA/B/C node:test all pass.
- `SKIP_PRODUCTION_ENV_CHECK=1 npm run build:postgres` → exit 0 (route
  `/api/admin/lessons/[id]/open-override` present in the build output); local SQLite
  Prisma client re-generated afterwards.
- No schema changes, no migrations, no seed changes, no changes to attempts/scoring,
  homework grading/submission, progression rules, attendance, LiveSession,
  notifications fan-out semantics, or the Teacher Session Workspace.
