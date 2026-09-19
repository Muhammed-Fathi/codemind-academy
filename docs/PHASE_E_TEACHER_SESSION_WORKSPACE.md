# Phase E — Teacher Session Workspace

> **Status:** implemented on branch `arena/01a0b663-codemind-academy` · **Type:** feature (teacher portal) · **Readiness authority:** unchanged (Phase D)

Phase E gives the teacher **one coherent workspace per academic Session** (a
`Lesson` — `Course → Part → Unit → Lesson`) so a session's content can be
completed and checked **without touching any admin ceremony**.

The teacher journey is: **Dashboard → الحصص (Sessions) → pick a session →
work it to جاهزة (READY).**

---

## 1. What the workspace is — and is not

The workspace is a **re-render of server payloads**. Every indicator,
ownership flag and readiness verdict on screen is computed **server-side by
the same authorities the admin ceremony uses** — the UI contains no
readiness logic of its own.

| Section | Authority | Teacher power |
|---|---|---|
| 1 Session overview | `loadOwnedLesson` + `lessonPlacement` | **Read-only** (lifecycle is the admin's ceremony) |
| 2 Video status | SessionVideo rows + Phase D VIDEO item | **Read-only**, counts + track coverage only |
| 3 Materials (PDF) | Phase 14 `Material` + `MediaAsset` | **Manage-own**: upload (replace own), deactivate own |
| 4 Quiz | Phase 18 teacher quiz architecture | Create (metadata + questions), PATCH metadata, delete (guarded), question manager |
| 5 Homework | Phase 18 teacher homework architecture | Create/edit via the shared dialog, delete when no submissions |
| 6 Readiness summary | **Phase D `getLessonReadiness`** | View only — Mark Ready / Open / Publish are never offered |

### What a teacher may NEVER do (enforced server-side, not just hidden UI)

- Mutate the video (`SessionVideo`) in any way.
- Mark Ready, Open/Publish, Unpublish, Archive, or run an Override.
- Edit the curriculum (Course/Part/Unit/Lesson structure).
- Reach a lesson outside their own `Group.courseId` scope.
- Replace or delete an **admin-uploaded** (or unproven-owner) material.
- Exceed lesson track containment when scoping content.

These are all **denied by the routes** (401/403/404/409), and the UI
additionaly never renders the actions. The deny is the contract; the hidden
button is only ergonomics.

---

## 2. Architecture

```
┌─ UI ─────────────────────────────────────────────────────────────┐
│ src/components/teacher/teacher-sessions.tsx                       │
│   TeacherSessions                                                 │
│   ├─ SessionListView      (search/course/readiness filters)       │
│   └─ SessionWorkspaceView (the 6 sections, keyed invalidation)    │
│      ├─ MaterialsCard   ── teacher endpoints only                  │
│      ├─ QuizzesCard     ── Phase 18 quiz routes + Phase E PATCH   │
│      ├─ HomeworkCard    ── shared HomeworkDialog + Phase E DELETE │
│      └─ ReadinessChecklist (reused from admin/session-workflow-* )│
└──────────────┬───────────────────────────────────────────────────┘
               │ /api/teacher/… (NEVER /api/admin/…)
┌──────────────▼───────────────────────────────────────────────────┐
│ Routes                                                            │
│   GET  /api/teacher/sessions                    → list            │
│   GET  /api/teacher/sessions/[id]               → workspace       │
│   GET|POST|DELETE /api/teacher/sessions/[id]/materials            │
│   PATCH  /api/teacher/quizzes/[id]    (Phase E addition)          │
│   DELETE /api/teacher/homework/[id]   (Phase E addition)          │
│   (existing Phase 18 routes are reused unchanged: quiz create,    │
│    question manager, homework create/edit)                        │
└──────────────┬───────────────────────────────────────────────────┘
┌──────────────▼───────────────────────────────────────────────────┐
│ src/lib/teacher-sessions.ts   (Phase E service)                   │
│   listTeacherSessions · loadTeacherSessionWorkspace               │
│   teacherUploadLessonPdfMaterial · teacherDeactivateLessonMaterial│
│                                                                  │
│ Re-used single authorities (NOT re-implemented):                  │
│   session-lifecycle.ts  — computeLessonReadiness/getLessonReadiness│
│   session-materials.ts  — buildMaterialDescriptors, storage,      │
│                           cleanupUnreferencedMediaAsset,          │
│                           isUsableLegacyPdfUrl, authorizeDownload │
│   teacher-content.ts    — loadOwnedLesson, TEACHER_LIMITS,        │
│                           boundedText, question validation        │
│   track-scope.ts        — resolveContentTrackScope (fail closed)  │
│   media.ts              — validatePdfUpload (MIME+magic bytes)    │
└──────────────────────────────────────────────────────────────────┘
```

### Scope resolution (the one rule)

A teacher sees/works exactly the lessons of courses attached to their active
groups: `Teacher → Group.teacherId → Group.courseId → (canonical chain OR
legacy topic chain)`. Every route derives this from the **authenticated**
user; no `teacherId`/`courseId`/`groupId`/`lesson ownership` is ever taken
from the request. Cross-scope answers are the same as Phase 18: **404** when
the resource shouldn't be revealed, **403** when the resource boundary is
already established (and **409** for state-based refusals).

---

## 3. Readiness consumption (never a second calculation)

- The LIST calls `computeLessonReadiness` (pure, in-memory) per row — the
  SAME function the admin OPEN ceremony runs.
- The WORKSPACE calls `getLessonReadiness(lessonId)` — the SAME loader the
  admin route serves; the `ReadinessChecklist` component renders it as-is.
- The workspace never computes "READY" itself: it renders
  `readiness.canBeReady` / `items` / `blocking` directly.
- The workspace never lets the teacher act on readiness transitions: the
  STUDENT-visible impact only ever flips through the admin ceremony.

Video/PDF/Quiz/Homework counts shown in the workspace come from the same
include set the readiness loader selected; the readiness verdict a teacher
sees is **identical** to the one that would gate an admin OPEN.

---

## 4. Materials — manage-own semantics (the only new behavior rule)

Phase 14 storage is untouched: bytes on the private volume, unguessable
`storageKey`, `MediaAsset(DOCUMENT, isPrivate)` + `Material(ADMIN_UPLOADED)`,
MIME + magic-byte validation, volume quota, reference-counted cleanup after
commit. Phase E only changes **WHO may act** on rows:

| Situation | Upload | Deactivate |
|---|---|---|
| No active material for (lesson × track) | allowed (201) | — |
| Active material created by **this teacher** | allowed → own prior is soft-deactivated (replace) | allowed (soft deactivate; asset cleanup is reference-counted) |
| Active material created by **someone else / unproven** (`MediaAsset.createdById ≠ me` or `null`) | **409 `api.318`** — never silently replaced | **403 `api.319`** |

- Ownership proof is ALWAYS the asset's `createdById` — never a client flag.
- `MediaAsset.createdById = null` (legacy/seeded rows) counts as **foreign**
  (fail closed).
- Teacher uploads default to the **lesson** track scope (absent `trackScope`
  input = inherit — never a client-side `SHARED` substitution); an explicit
  scope must satisfy lesson containment (`OUT_OF_LESSON_SCOPE` → 400
  `api.243`).
- Uploads on **ARCHIVED** lessons are refused (409 `api.242`, same lesson
  lifecycle rule as Phase 18 homework/quiz create).
- The legacy `Lesson.pdfUrl` is **never written** by teacher endpoints
  (read-only mirror, exactly like the admin GET).
- Files are always "PDF kind"; the response never leaks `storageKey`,
  `mediaAssetId`, or bucket/volume paths (`pdfUrlWritten:false` is explicit).

Downloads do **not** go through a new route: the workspace surfaces the Phase
14 `/api/materials/[id]` route, whose own 10-check authorization decides per
viewer (teacher = staff review, student = enrollment/track/lifecycle/
progression gate).

### 4b. Production upload path (Phase 23 presigned leg) — ADDITIVE

The buffered `POST /api/teacher/sessions/[id]/materials` endpoint above is
correct on any backend, but carrying up to 64 MB through the serverless
function is bounded by the platform's request-body limit. The **production
upload path** therefore reuses the Phase 23 presigned architecture — bytes
stream straight from the browser into the private R2 bucket — with a
teacher-scoped twin of the admin legs:

```
browser ── init ──▶ POST /api/teacher/media-uploads/init      (TEACHER role,
                    rate-limited, Group.courseId scope check, loadOwnedLesson,
                    not ARCHIVED → initPresignedUpload(LESSON_PDF) — purpose
                    server-pinned; NEVER a video grant)
        ◀───────── { uploadUrl, method: PUT, token, contentType, maxBytes }
browser ── PUT bytes ──▶ private R2 (minutes-short, one exact key)
browser ── done ─▶ POST /api/teacher/media-uploads/complete   (TEACHER role,
                    verifyUploadIntent locally → payload LESSON_PDF only →
                    re-authorize the SIGNED lessonId (scope + not ARCHIVED) →
                    completePresignedUpload → HEAD/size/MIME/magic/sha256 →
                    finalizeLessonPdfMaterial with manageOwn)
```

- **Purpose is server-pinned to LESSON_PDF** on both routes; a teacher
  receives no SESSION_VIDEO grant anywhere (intents whose payload carries a
  video purpose are refused at `complete` before any work).
- **Ownership is derived from the signed intent payload, never the request
  body**: `complete` re-runs `loadOwnedLesson` against the
  `payload.lessonId`, plus the ARCHIVED guard. A token issued to one teacher
  is useless to another account (`sub` is bound; user-mismatch → refused).
- **Manage-own crosses into the SHARED finalizer additively**:
  `finalizeLessonPdfMaterial` accepts an optional `manageOwn: { userId }`.
  When set, the ownership partition is re-evaluated **inside the
  transaction**: any ACTIVE material of the same (lesson × track) whose
  `MediaAsset.createdById ≠ userId` (null included) fails closed with
  `FOREIGN_ACTIVE` (409) **before any write** — the refusal runs after the
  stored bytes are verified, so the just-uploaded object is cleaned up
  immediately. When absent, the Phase 23 admin path is byte-identical
  (additive destructuring; the admin route passes nothing).
- **The Material payload returned to the teacher is exactly the reconstruct
  of the admin one** (`title` is full and always present) so the workspace
  can merge it straight into the list — verified byte-identical in the
  verifier.
- **No reliance on transient storage links**: after finalize, downloads go
  through the Phase 14 `/api/materials/[id]` authority — the presigned PUT
  URL is single-purpose write-only and expires; the workspace never stores
  or reuses it.
- `MEDIA_BACKEND=local` ⇒ `409 code=PRESIGNED_UNSUPPORTED` from `init` — the
  client then transparently uses the buffered teacher endpoint (§4b keeps
  the local dev flow intact; the UI pipes through `useMediaUpload`'s
  native fallback leg).

New dictionary keys: `api.324` (intent window expired / invalid upload
request), `api.325` (already recorded with different data).

---

## 5. Quiz management

- **Create** — unchanged Phase 18 `POST /api/teacher/quizzes` (metadata +
  ≥1 valid question in one call; the readiness QUIZ item therefore flips
  through exactly that product path).
- **PATCH** ` /api/teacher/quizzes/[id]` *(new, additive)*:
  - `title` (required when present), `titleAr` (falls back to title),
    `description`, `passMark` (0–100, `api.257`), `timeLimit` (1..300 min or
    null, `api.233`) — always editable, even after attempts exist
    (metadata-only, mirrors the homework-PATCH precedent).
  - `trackScope` — resolvable only empty/inherited or an explicit valid
    scope (400 `api.228`/`api.243`). A **move** is refused `409 api.321`
    when any attempt row exists (frozen audience) and `409 api.322` when an
    existing question's own tag would fall outside the new scope
    (question-containment, `isQuestionScopeWithinQuiz`).
  - Empty body → 400 (`api.320`). No blueprint/lesson/question rewrite here;
    the question manager remains the only question surface; frozen attempts
    are never recomputed.
- **Delete** — unchanged Phase 18 DELETE (attempts / FIXED-exam pins → 409).
- **Question manager** — the existing `QuestionManagerDialog`, embedded with
  an optional `onChanged` callback so the workspace refreshes after any
  question mutation (additive prop; legacy embeds unaffected).

## 6. Homework management

- **Create/edit** — the shared `HomeworkDialog`, with two NEW optional
  props (both additive): `onChanged` (refresh hook) and `fixedLessonId`
  (seeds the create target to the workspace's lesson; the picker's lesson
  list is scoped to that single lesson, so the target can never drift).
- **DELETE** `/api/teacher/homework/[id]` *(new, additive)*:
  - 404 (`api.238`) unknown id; 403 (`api.180`) out of scope;
  - **409 (`api.323`) when any `HomeworkSubmission` row exists** — deleting
    would cascade student work and its grades; refuse instead of erasing
    history;
  - otherwise plain delete → `{deleted:true}`.

---

## 7. UI/UX contract

- **Arabic-first RTL**, all copy in `i18n-dict-2026.ts` (`teacher.215`–
  `teacher.302`, `api.318`–`api.323`, nav label `shell.043`). Nothing is
  hard-coded; no raw ids on screen (title + officialCode = identity).
- List rows (per session): title, officialCode, track badge, lifecycle
  badge (read-only), Unit/Part/Course chain, the four **content indicators**
  (readiness-derived, with count), and the server verdict **جاهزة /
  غير جاهزة**. Filters: text search, course, readiness state.
- Workspace sections are `SectionCard`s; each has loading (skeleton),
  empty (dedicated copy), error (retry) and success states. Destructive
  actions (material deactivate, quiz delete, homework delete) go through
  the shared `ConfirmDialog` — no silent deletes.
- Video section is **deliberately read-only**: counts + per-track coverage
  badges + the "الفيديو يتم إدارته من خلال الأدمن" admin-managed notice; a
  missing/invalid video renders the "ask the admin" hint instead of any
  action.
- **State refresh after mutations**: every mutation invalidates the
  `["teacher-session", id]` and `["teacher-sessions"]` query keys (no full
  reload, no polling); dialogs only remount on change.
- Admin-owned materials are still listed, flagged **"من الأدمن"**, with no
  deactivate affordance (the server would refuse it anyway).

---

## 8. API surface (Phase E additions)

| Route | Method | Success | Fail-closed cases |
|---|---|---|---|
| `/api/teacher/sessions` | GET | `{sessions:[…]}` | 401 no-auth / non-teacher |
| `/api/teacher/sessions/[id]` | GET | workspace payload | 401, 403 foreign scope, 404 unknown |
| `/api/teacher/sessions/[id]/materials` | GET | `{materials, legacyPdfUrl}` | 401, 403, 404 |
| 〃 | POST | 201 `{material, replaced…}` | 401, 403, 404, 409 archived, 400 scope, 413/415 invalid upload, 409 `api.318` foreign active |
| 〃 | DELETE | `{deactivated:true…}` | 400 missing id, 403 own-only (`api.319`), 404 pairing |
| `/api/teacher/media-uploads/init` | POST | `{uploadUrl, method, token…}` | 401, 403 (non-teacher / foreign lesson), 404, 409 archived, 409 `PRESIGNED_UNSUPPORTED` local backend |
| `/api/teacher/media-uploads/complete` | POST | `{material, replay…}` | 401, 403, 404, 409 archived, 409 `FOREIGN_ACTIVE` (api.318), 4xx intent/verification (`api.324/325/215/216/213`) |
| `/api/teacher/quizzes/[id]` | PATCH | updated quiz payload | 400 empty/invalid, 403, 404, 409 `api.321` attempts, 409 `api.322` questions out-of-scope |
| `/api/teacher/homework/[id]` | DELETE | `{deleted:true}` | 403, 404, 409 `api.323` submissions |
| `/api/materials/[id]` | GET | proxied bytes (Phase 14) | unchanged 10-check authorization |

No admin route was added, widened, or copied; no storage system was
introduced; no migration was added.

---

## 9. Ownership and edit semantics (explicit)

- **Lesson lifecycle**: exclusively the admin ceremony (READY / PUBLISHED /
  ARCHIVED transitions, override, video management). The workspace is only
  a viewer of these facts.
- **Materials**: row-level management follows `MediaAsset.createdById`.
  Admin-owned and owner-unprovable (`createdById = null`) materials are
  view-only to teachers; teacher-owned active rows are replaceable (soft
  replace) / removable. There is no "co-own" state: exactly one actor is
  the provable owner of a row.
- **Quiz/homework**: ownership follows the LESSON scope (Phase 18 rule).
  Teacher uploads do not grant any special claim over content other
  teachers of the same course created — same scope, same rights.
- **Upload replace semantics**: replacing means "soft-deactivate my prior
  active + create a new active" in one transaction; replaced rows stay in
  the journal (`replaced`), replaced assets are cleaned up only when no
  other row references them (Phase 14 reference counting).

---

## 10. Verification

- `scripts/verify-phaseE-teacher.mjs` — 157 real-DB assertions over the
  compiled SHIPPED routes: list/workspace payloads, manage-own material
  matrix (upload/replace/foreign-active/own-only deactivate/pairing),
  track containment matrix, archived refusals, quiz PATCH guards incl.
  frozen-audience and question-containment, homework DELETE guards, the
  FULL readiness sequence (invalid→valid per resource, READY only when all
  four valid), Phase 14 download authorization from a workspace row, and
  13 security checks (no-auth, wrong role, cross-scope on every surface,
  admin ceremony + admin materials + video mutation denial for TEACHER
  identities, storage-key non-leak). Phase K addition: teacher presigned
  legs — init/complete route matrix (401 no-teacher, 403 cross-scope /
  non-LESSON_PDF intent, PRESIGNED_UNSUPPORTED fallback contract on the
  local backend, garbage sizes/content-types fail closed, NEVER 200s) and
  the service-level manage-own partition matrix over a fake presigning
  backend (foreign-active reference row refusal with NO writes and bucket
  cleanup, own-prior replace with deactivation + reporting, exact Material
  payload reconstruction = byte-identical to the admin completion path,
  same-token replay idempotency, cross-teacher boundary enforcement).
- Runner: `tests/teacher-session-workspace-phaseE.test.js`.
- Regressions: Phases B, C, D(13), 12, 14, 15, 16, 18, notifications,
  lifecycle, A (session-video lesson link), 23 (presigned uploads), media
  publishing audit, post-launch notifications + admin lifecycle, Phase D
  readiness, auth cross-role, security-hardening + audit gate — all green.
  `npx tsc --noEmit` clean; `npm run build:postgres` succeeds.

*Deferred by design (never part of Phase E):* Phase F live sessions /
attendance / meeting links / notifications; Phase G homework attachments /
submission redesign and grading UI; Phase H SessionVideo progression, quiz
PASS semantics and grading progression policy. This workspace calls none of
them.
