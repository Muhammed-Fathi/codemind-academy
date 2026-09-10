# Phase 13 — Session Lifecycle (`DRAFT → READY → PUBLISHED`)

Date: 2026-09-09/10 (implemented and verified in-sandbox). Branch baseline: `12b5685`.
Roadmap reference: `docs/MASTER_PLATFORM_AUDIT_AND_ROADMAP.md` §11 (data foundation)
and §17 (publication lifecycle) — **this phase implements the lifecycle half of §17
and explicitly defers its notification half** (see §"Deferred, by decision" below).

This document is the contract. Where the roadmap was ambiguous, this file states the
decision, the reason, and what was measured — it never leaves a rule to be "inferred
from the code".

---

## 1. What changed, in one page

`Lesson.isPublished: Boolean` was the whole publication model. It conflated two
different questions — *is this session complete?* and *may students see it?* — with one
bit, and it had three consequences the platform could not grow past:

1. There was no way to stage a finished-but-unreleased session: `isPublished: false`
   also meant "the quiz/assignment/video rows are not ready", so content review and
   release control shared a single flag.
2. The reconciler (Phase 11) created lessons with `isPublished: true`, i.e. **reconciling
   was publishing**.
3. The parent preview surface (Phase 12, Finding 2) checked course + track but not the
   publication state, so an in-scope parent could read a "draft" lesson's body, its quiz
   questions and its media URLs.

Phase 13 replaces the model with one lifecycle field and a ceremony:

| | before | after |
|---|---|---|
| student visibility | `isPublished === true` | `status === "PUBLISHED"` |
| staging a finished session | impossible | `status = "READY"` (invisible, admin-visible) |
| how a lesson becomes visible | any writer flips a boolean | `OPEN` ceremony, ADMIN only, transactional, idempotent |
| publication fan-out key (for Phase 17) | none | `SessionPublication` row (one per lesson, UNIQUE) |
| `isPublished` | authoritative | **deprecated compatibility mirror**, written only by the lifecycle module |
| `isLocked` | student-facing lock flag | **retired / inert**, no longer serialised by any API |

One field, one anchor table, existing `AuditLog`. **No** duplicate lifecycle tables, **no**
`opensAt`/`publishAt`/`scheduledAt` scheduling field (nothing in the product asks for
scheduled release yet, and inventing a half-implemented scheduler is exactly the kind of
speculative schema the phase brief forbids).

---

## 2. Schema contract

`prisma/schema.prisma`:

```prisma
enum LessonStatus {
  DRAFT
  READY
  PUBLISHED
}

model Lesson {
  …
  status        LessonStatus @default(DRAFT)  // the ONLY lifecycle field
  isPublished   Boolean      @default(true)    // DEPRECATED compat mirror — see §7
  isLocked      Boolean      @default(false)   // RETIRED — read by nothing
  publication   SessionPublication?           // the anchor; absent until first opened
  @@index([status])
}

model SessionPublication {
  id                String   @id @default(cuid())
  lessonId          String   @unique          // one publication per lesson: the idempotency key
  segment           TrackScope @default(SHARED)
  publishedAt       DateTime @default(now())
  publishedByUserId String?
  lesson            Lesson   @relation(fields: [lessonId], references: [id], onDelete: Cascade)
  @@index([publishedAt])
}
```

Decisions that were explicitly contested and are now fixed:

- **`status` is a real enum, not a `String`.** SQLite stores enums as plain `TEXT` with no
  `CHECK` constraint (measured in Phase 12 and again here), so the enum's value is in the
  Prisma client and in the migration's guarded `UPDATE`, not in a database constraint. The
  application layer therefore normalises defensively (`normalizeLessonStatus`), and any raw
  SQL that writes a fifth value is a data error the API refuses to act on (fail-closed: an
  unrecognised status ranks as `DRAFT` and is invisible).
- **`LESSON_DEFAULT` is `DRAFT`, not `PUBLISHED`.** A row created by any path that forgets
  the lifecycle must be invisible. This is why the dev seeder's retired fixture path
  (`seedCurriculumFromFile`) now yields student-invisible rows, which is the correct
  direction of failure for a function its own header marks RETIRED.
- **One `SessionPublication` row per lesson, not one per track.** `PUBLISHED_ARABIC` /
  `PUBLISHED_LANGUAGE` is deliberately *not* a thing: publication is a property of the
  session, track visibility remains a property of `trackScope` (Phase 12). The `segment`
  column records the lesson's own segment at publication time for the notification
  audience; it is not a second axis of state.
- **`publishedAt` lives on the anchor, not on `Lesson`.** Adding `Lesson.publishedAt`
  would create a second, denormalised source of "when did this become visible" that can
  disagree with the anchor; and the anchor must be *deleted* on unpublish (see §4) so that
  "no live publication" is physically representable.
- **`Lesson.status` has an index** (`Lesson_status_idx`) because every student read now
  filters on it, on a table the curriculum tree walks per request.

---

## 3. Readiness — the full contract

`src/lib/session-lifecycle.ts :: computeLessonReadiness(input)` is **pure, total,
deterministic and UI-free**, and it is the *only* readiness computation in the
repository: the readiness endpoint and the `OPEN` ceremony both call it, over the same
loader (`getLessonReadiness`), so a preview can never disagree with its own ceremony.

Per resource:

| resource | required? | satisfied when | blocking cases |
|---|---|---|---|
| `VIDEO` | **yes** | a published `SessionVideo` whose `batch.schoolType` matches the lesson's track — **or** for lessons still carrying the legacy string `Lesson.videoUrl`, a usable URL | `VIDEO_MISSING` (nothing usable) · `VIDEO_TRACK_INCOMPLETE` (present, but not for the whole audience the lesson claims) |
| `PDF` | **no** — Phase 14 owns upload/auth; still optional for READY | informational only | never blocks; `PDF_ABSENT_NOT_REQUIRED` when absent, `PDF_PRESENT_NOT_REQUIRED` when a Material or usable legacy url is present |
| `QUIZ` | no | — | `QUIZ_EMPTY`: a quiz **with zero questions** (or an unreadable count) is *invalid*, not absent — an empty quiz is a live bug the admin must fix before opening |
| `HOMEWORK` | no | — | `HOMEWORK_INSTRUCTIONS_EMPTY`: homework whose `instructions` are empty/placeholder |

Track-awareness rules, stated exactly:

1. A resource counts only when `resourceAppliesToScope(lesson.trackScope, resource.trackScope)`:
   `SHARED` applies everywhere; a track-tagged resource applies only to its own lesson
   track; **an unrecognised tag applies nowhere** (fail closed, never coerced to SHARED).
2. A track-scoped resource can never *widen* a lesson: an ARABIC homework attached to a
   LANGUAGE lesson is somebody else's content — it is ignored for readiness and reported
   as a note (`HOMEWORK_PRESENT_BUT_OTHER_TRACK:1`) instead of silently vanishing.
3. `SHARED` lessons are held to their full audience: with **no** legacy `videoUrl`, a
   SHARED lesson needs a published video for **both** batches, else
   `VIDEO_TRACK_INCOMPLETE` + `SHARED_VIDEO_MISSING_BATCH:<TRACK>` notes. With a legacy
   `videoUrl` (the pre-Phase-12 single-video shape) that URL covers the whole lesson —
   otherwise every existing SHARED lesson in the dev data would be permanently unstageable.
4. `ARCHIVED` (`curriculumStatus`) blocks readiness outright (`CURRICULUM_ARCHIVED`):
   archived history is not curriculum (Phase 11 rule), and it outranks every other refusal.
5. `LEGACY` lessons follow the **same** rules as `OFFICIAL` ones. There is no "legacy
   exemption": an old topic-linked session reaches students by exactly the same door.
6. Placeholder tolerance is shared with the existing seed data: `""`, `"#"`, `"##"`,
   `"./#"`, `"null"`, `"none"`, `"-"` (and whitespace) are **not** usable URLs, so the
   `pdfUrl="#"`/`videoUrl=""` seeds do not fake their way to READY.
7. `blocking` is sorted in the fixed resource order (`VIDEO, PDF, QUIZ, HOMEWORK`) with
   lifecycle-level codes last, so two snapshots diff literally.
8. `canBeReady === canPublish === (blocking.length === 0)`. The *transition* rules (which
   state you may move **from**) are enforced by the ceremony, not by the computation, so
   the computation stays reusable for "what would it take" previews.

`LessonReadinessSnapshot` = the above plus the two stored facts the admin payload reports:
`isPublished` (the mirror, **reported, never obeyed**) and `publication` (the anchor or
`null`).

---

## 4. The state machine, and the ceremony

```
                 MARK_READY (needs readiness)
      DRAFT  ────────────────────────────────▶  READY
        ▲          ◀──── READY→DRAFT ──────────┤
                                              │  OPEN (needs readiness, ADMIN only)
                                              ▼
                                        PUBLISHED  ── UNPUBLISH ──▶ READY
```

Table, exactly (`ALLOWED_TRANSITIONS`):

```
DRAFT     → READY
READY     → DRAFT, PUBLISHED
PUBLISHED → READY
```

Rules that are part of the contract, each with its reason:

- **`DRAFT → PUBLISHED` is forbidden.** Staging is not a rubber stamp; the operator must
  look at the checklist once. This is the single most important edge *not* in the table.
- **`PUBLISHED → DRAFT` is forbidden.** Withdrawing a live session means making it
  invisible, which is `→ READY`; jumping back to DRAFT would erase the distinction between
  "not built yet" and "built and withdrawn", and would make a re-open require re-staging
  for no security benefit.
- **Nothing may transition `ARCHIVED` lessons.** Archiving/unarchiving is Phase 11's
  reconciler concern; the lifecycle has no opinion about history. `LESSON_ARCHIVED` for all
  three actions, and **no write is attempted**.
- **No self-loops.** Re-applying an action that already holds returns
  `NO_OP_ALREADY_IN_STATE` (`ok: true`, `changed: false`, HTTP 200) — that is the
  idempotency contract, and it is a *response*, not a table edge. For `OPEN` it means: no
  second write, no duplicate anchor row, **no notification**, and the *existing* publication
  (id + `publishedAt`) is returned unchanged.
- **There is no generic `PATCH {status}`.** No endpoint, no helper, no exported
  "setLessonStatus". `transitionLesson({lessonId, action, actorUserId, client})` and its
  three named wrappers (`markLessonReady`, `openLesson`, `unpublishLesson`) are the only
  writers of `Lesson.status` and of the `isPublished` mirror.
- **Readiness is re-evaluated at `OPEN`,** from live rows — never from the snapshot that
  earned the `READY` stamp. A lesson that lost its video between staging and opening cannot
  be opened (`READINESS_BLOCKED`). A stale `READY` is not a warrant.
- **Order of refusal checks is contractual** (archived → course ownership → idempotent
  replay → transition table → readiness), because it decides *which* refusal a caller sees
  for a lesson that breaks several rules. Tests pin this order deliberately.
- **`OPEN` requires the lesson to be in a curriculum.** A lesson attached to neither the
  canonical `unitId` chain nor the legacy `topicId` chain is refused with
  `LESSON_NOT_IN_COURSE` — you cannot publish a session into no course, and the ceremony
  resolves the chain in the same canonical-first order the progression engine uses, so the
  two can never disagree.
- **Atomicity + concurrency.** The flip, the anchor row and the audit row run inside one
  `$transaction`. The flip is *conditional*: `updateMany({ where: { id, status: from } })`
  and `count !== 1 ⇒ CONCURRENT_CHANGE` with nothing further written. A retried double-click
  therefore cannot double-publish, and a lost race is a retryable 409, not a 500.
  (The conditional predicate is load-bearing: the test suite contains the mutation control
  that removes it and shows the write clobbering a state it should not touch.)
- **`UNPUBLISH` deletes the `SessionPublication` row.** Not "mark it withdrawn": Phase 17's
  fan-out must be driven by *live* anchors only, and a row that exists but is ignored is a
  future bug. The full history of both acts stays in `AuditLog` (`LESSON_OPEN`,
  `LESSON_UNPUBLISH`, with `from`/`to`/`blocking`/`publicationId` in `details`).

---

## 5. The student/parent universe

One definition, in one place: `LESSON_STUDENT_STATUS_FILTER = { status: "PUBLISHED" }`.

A student sees a lesson iff **all three** hold, and progression is then applied on top:

```
status === "PUBLISHED"                     (Phase 13, lifecycle)
AND curriculumStatus !== "ARCHIVED"         (Phase 11, history is not curriculum)
AND trackScope ∈ eligible(viewer's track)   (Phase 12, track)
→ then: Part → Unit → Lesson chain order, sequential unlock (Phase 4 — untouched)
```

Consequences that were decided, not discovered:

- **`READY` is not student-visible.** It is an admin workbench state.
- **`PUBLISHED` + locked is normal and reachable**: lifecycle decides *existence*,
  progression decides *sequence*. `getCourseSessionProgress` returns
  `unlocked: false` for it, and `canAccessLesson` answers
  `PREVIOUS_SESSION_INCOMPLETE` — never a lifecycle code. Proven against real rows
  (§"Verification", layer 4).
- **Non-visible lessons answer `LESSON_NOT_FOUND` (404), not 403.** A `DRAFT`/`READY`
  lesson is indistinguishable from a nonexistent id, so the lifecycle layer does not become
  an existence oracle for staged content. This applies uniformly to the lesson reader, the
  prev/next list, and the direct-id quiz/homework/video surfaces.
- **Progression semantics were not rewritten.** The Phase 4 algorithm (ordering,
  completion, `currentLessonId`, unlock set, batch healing) is untouched apart from the
  universe/lifecycle clause, as the brief required.
- **Teachers, admins and the admin surfaces are deliberately unrestricted** on the
  catalogue (they review content that is not yet visible), so the lifecycle filter is
  applied with an empty-object widening for staff rather than by branching inside the
  shared queries.
- **Parents** now go through **one** predicate for **all three** clauses:
  `isParentLessonPreviewAllowed(parentUserId, lessonRowData, courseId)` in
  `src/lib/parent-access.ts` — lifecycle → not-ARCHIVED → the child's track → the child's
  enrolled course, fail-closed, and it takes the row's *data* (not an id) so a caller cannot
  pass a check with a bare identifier. It short-circuits: a `READY`/`DRAFT` lesson is
  refused before any enrollment query runs (asserted). **This closes Phase 12 Finding 2.**
  The quiz surface (`/api/quizzes/[id]`) uses the same helper for the *owning lesson* plus
  `isParentAllowedTrackScope(quiz.trackScope)` for the quiz's own tag — the previously
  reachable answer-key leak through a staged lesson's quiz is closed.

Readers audited and wired (11 route files; enumerated, not sampled, in
`tests/session-lifecycle-phase13.test.js` §16): `api/courses/[slug]`, `api/lessons/[id]`,
`api/quizzes/[id]`, `api/exams/mock`, `api/students/me/{dashboard,homework,session-videos,certificate}`,
`api/parents/me/{dashboard,analytics,weekly-report}`.

---

## 6. Admin API surface

Four thin routes, all `requireRole("ADMIN")` (and `/api/admin/*` is already
proxy-protected as defense-in-depth). They contain no policy: they parse, call the
ceremony, and map the outcome.

| route | method | purpose |
|---|---|---|
| `/api/admin/lessons/[id]/readiness` | GET | the checklist, and why it is blocked |
| `/api/admin/lessons/[id]/mark-ready` | POST | `DRAFT → READY` (refused unless ready) |
| `/api/admin/lessons/[id]/open` | POST | `READY → PUBLISHED` + anchor (idempotent) |
| `/api/admin/lessons/[id]/unpublish` | POST | `PUBLISHED → READY`, anchor deleted |

The three mutations share one body shape, so no client has to special-case an action:

```jsonc
{ "ok": true, "code": "OK", "action": "OPEN", "changed": true,
  "lessonId": "…", "from": "READY", "to": "PUBLISHED",
  "message": "Lesson published",
  "readiness": { "canBeReady": true, "blocking": [], "items": [ … ] },
  "publication": { "id": "…", "segment": "SHARED", "publishedAt": "…" } }
```

`lifecycleHttpStatus(code)` is the single mapping — `OK`/`NO_OP_ALREADY_IN_STATE` → **200**,
`LESSON_NOT_FOUND` → **404**, every other refusal (`READINESS_BLOCKED`,
`ILLEGAL_TRANSITION`, `LESSON_ARCHIVED`, `LESSON_NOT_IN_COURSE`, `CONCURRENT_CHANGE`) →
**409**. `code` is always in the body: the number is for HTTP semantics, the code is for
programs. A client never parses prose.

`GET …/readiness` never touches student data: no enrollment, progress, attempt or
submission rows — it describes the lesson's own completeness.

**Roadmap conflict resolved explicitly.** §17 sketches a single `PATCH /api/admin/sessions/[id]/status`
style endpoint; §11 demands that publishing be an auditable *event*. A generic
`PATCH {status}` cannot honour §4's rules (the legal target depends on the current state and
on readiness), so it is **rejected on purpose** in favour of three named actions whose legal
predecessor states are the API. The `PATCH`-shaped convenience can be added later as a thin
projection over `transitionLesson`; it must not become a second engine.

Not implemented here, by decision: `notification: true|false` flags, per-track audience
selection, or any notification insert. Publishing writes exactly the anchor row that
Phase 17 will consume.

---

## 7. `isPublished` and `isLocked` — disposition

**`isPublished` = deprecated compatibility mirror.**

- Kept in the schema with its existing `@default(true)` — **not** renamed, **not** dropped,
  **not** re-defaulted. Changing the default without rebuilding the column is exactly the
  schema/DB drift that SQLite-backed Prisma projects cannot detect, and `db push`-based
  dev flows would then differ from migration-based ones.
- Written by **only** `session-lifecycle.ts` (`publishedMirror(status)`), on every
  transition and at row creation (`LESSON_NEW_LIFECYCLE = { status: "DRAFT", isPublished: false }`),
  so the mirror never drifts by accident. The reconciler no longer writes it (see §8).
- Read by **nothing that decides access**. It is reported in admin payloads
  (`lifecycle.isPublishedCompat`) so drift stays *visible* instead of silently corrected.
- Removed from every student/parent serialisation (the course tree and the lesson reader no
  longer emit it), so no client can start obeying it again.

**`isLocked` = retired and inert.** The flag was a *progression* state (locked until the
previous session is complete) that the server already computes correctly from the chain;
storing it per lesson was how a stale bit could disagree with reality. In this phase the
column stays physically (no destructive DDL) but: the reconciler no longer writes it, the
course tree and lesson reader no longer serialise it, and the two client components dropped
it from their prop types (`student-course.tsx`, `student-lesson.tsx`) so a client cannot
reintroduce the behaviour. `status === "locked"` (computed by `getCourseSessionProgress`)
remains the only lock signal, and the retired component-local variable name is unchanged so
the UI's behaviour is byte-identical. `tests/session-progression.test.js` pins the
inertness: inverting `isLocked` on two lessons changes no unlock verdict.

---

## 8. Migration and backfill

`prisma/migrations/20260909180000_phase13_session_lifecycle/migration.sql`.

The backfill is **deterministic and guarded**, derived after inspecting real data rather
than guessed:

```sql
ALTER TABLE "Lesson" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DRAFT';

UPDATE "Lesson" SET "status" = 'PUBLISHED'
WHERE "status" = 'DRAFT'
  AND COALESCE(CAST("isPublished" AS INTEGER), 0) = 1;

CREATE INDEX "Lesson_status_idx" ON "Lesson"("status");
CREATE TABLE "SessionPublication" ( … );
CREATE UNIQUE INDEX "SessionPublication_lessonId_key" ON "SessionPublication"("lessonId");
CREATE INDEX "SessionPublication_publishedAt_idx" ON "SessionPublication"("publishedAt");
```

Why that exact shape:

- `DEFAULT 'DRAFT'` means the column can be added NOT NULL without a data rewrite pass; the
  backfill then moves the live rows, instead of the reverse.
- **`WHERE "status" = 'DRAFT'`** makes the statement a no-op on replay — which is what keeps
  a re-applied migration from *resurrecting* a lesson an admin has since unpublished. It is
  also what makes `NULL`-mirrored rows (`COALESCE`) impossible to misread.
- A `READY` state is never invented: no row is backfilled into it, because there is no
  honest way to know whether a `isPublished: false` lesson was "staged" or "abandoned".
- Publication anchors are **not** backfilled for pre-existing lessons. They predate the
  ceremony; fabricating `publishedAt = createdAt` rows would invent audit data. Consequence,
  stated plainly: `…/open` on such a lesson creates the first anchor, and Phase 17's
  fan-out will only ever see lessons published from Phase 13 onward — which is the correct
  behaviour for a notification feature, not a gap to paper over.
- No `DELETE`, no `DROP TABLE`, no `DROP COLUMN`, no historical migration edited.
- The retired `isLocked` and the demoted `isPublished` columns are left in place: this is a
  retire-in-place phase, not a cleanup phase.

Measured, from real data (see §10): the pre-Phase-13 reconciler wrote `isPublished: true,
isLocked: false` for all 23 official lessons (`git show 12b5685:src/lib/official-curriculum.ts`
lines 439–440), so a dev database created before this phase comes up with **all 23 lessons
`PUBLISHED`** and zero visible behaviour change; the 6 staged/`false` rows in the fixture stay
`DRAFT`; 10 placeholder `pdfUrl="#"` rows and 1 stale `isLocked=1` row survive untouched.

**Repo-history caveat, recorded because it affects any future from-empty verification:** this
repository's migration history is **not** reproducible from an empty file — the earliest
migration (`20260904090608_add_student_identity_fields`) only `ALTER`s `Student`, and the
base schema predates the migrations (`docs/DATABASE_MIGRATION.md` documents `npx prisma db
push`). `scripts/verify-phase13-db.mjs` therefore lays down a base schema derived from
`prisma/schema.prisma` first, then applies the real `.sql` files in order. A baseline
migration should be introduced deliberately in its own phase, not silently invented here.

---

## 9. Deferred, by decision (reported, not "fixed")

| item | why not in this phase |
|---|---|
| Notifications / fan-out on publish | §17's other half. This phase ships the `SessionPublication` anchor it needs. Zero `Notification` rows are created by the ceremony (asserted). |
| `GET /api/media/[id]` | It still authorises a video by `SessionVideo.isPublished` and never consults `Lesson.status`. Changing it needs the media-visibility model of **Phase 20**, which also owns the pre-existing `pinCount`/`originalFilename` oracle in that route (Phase 12 Finding 3). Touching only half of that route here would leave an oracle plus a half-migrated rule. Documented in §5 of this file and pinned as "deliberately unchanged" in the test suite. |
| PDF readiness | Phase 14 owns document handling. Here `PDF` is `NOT_APPLICABLE`/deferred — **never** required, **never** faked into blocking. |
| `students/me/dashboard` → `recentLessonProgress` | Still lists a student's *own* history for lessons that a later admin unpublished. Own-data, titles only, no new content; leaving it avoids inventing a "revocation" semantics this phase does not own. |
| `api/exams/mock` question pool | Now lifecycle-scoped (staged content can no longer reach an exam through the shared bank) but **still** includes questions from `ARCHIVED` lessons — Phase 11's deliberate pool choice, unrelated to lifecycle. |
| Admin catalogue UI | Phase 15 renders the checklist; the endpoints and payload shape are its input. |
| `seedCurriculumFromFile` (retired) | Its rows now land in `DRAFT` under the new default — the safe direction for a function whose header says "must not run against live data", and whose behaviour is pinned by `tests/seed-idempotency.test.js`. Left untouched. |

---

## 10. Verification — what was run, and what could not be

Sandbox capabilities were measured before designing the verification, and they bound every
claim below:

| capability | status |
|---|---|
| `npx prisma generate` (client) | **works** — with placeholder engine files + `PRISMA_QUERY_ENGINE_LIBRARY` / `PRISMA_SCHEMA_ENGINE_BINARY` |
| `prisma migrate status/deploy/dev/diff` | **unavailable** — the schema-engine binary cannot be downloaded (`binaries.prisma.sh` and every mirror tested reset TLS; prisma GitHub releases ship no engine assets; no usable wasm engine for this version) |
| Live `PrismaClient` queries | **unavailable** — same reason; therefore no HTTP-live-against-real-DB run was possible, and none is claimed |
| Real SQLite file manipulation | **available** via `node:sqlite` |
| `bun` / `bunx` | **absent** — every command below is `npm run …` / `npx …` / `node …` |

So the real-data verification is performed by `scripts/verify-phase13-db.mjs`, which
**applies the actual migration files itself** through `node:sqlite`, with real
`_prisma_migrations` bookkeeping (SHA-256 of each `.sql`), `PRAGMA foreign_keys=ON`, and an
anti-drift guard that re-derives the expected table/column set from `prisma/schema.prisma`.
It states in its own output that it applies the SQL because the schema engine is
unobtainable. It never claims `prisma migrate deploy` ran.

```
node scripts/verify-phase13-db.mjs all   →   PASS — 157 assertions, 0 failures
```

Layer 1–3 (data): **rehearsal** on a scratch DB built from the pre-migration base schema and
populated with a representative fixture (23 official + 4 legacy/archived rows; 21 mirror-true
/ 6 staged; the seeded `pdfUrl="#"` and `isLocked=1` shapes; progress/attempt/submission rows;
Arabic titles; 10 `MediaAsset`/`SessionVideo` rows) —
*every* table's row count identical before/after; lesson ids identical **and in order** (no
rebuild, no renumbering); an arbitrary Arabic title byte-identical; backfill counts exactly
the pre-mirror `true` set with **0 invented `READY`** and **0 archived rows re-staged**;
mirror parity 0 mismatches; `status` is `TEXT NOT NULL DEFAULT 'DRAFT'`; `Lesson_status_idx`
exists; the anchor table + its UNIQUE index exist and a second publication row for the same
lesson is rejected by the database; `PRAGMA foreign_key_check` = `[]`, `integrity_check` =
`ok`; all `LessonProgress`/`QuizAttempt`/`HomeworkSubmission` rows still resolve to live
parents; a **backfill replay is a no-op**, including for a lesson the fixture *unpublished*
before the replay (it stays `READY`; it is not resurrected) — that replay control replaced an
earlier vacuous version of this check.

Layer 2 (universe): cross-checked against an **independent JS-side filter** over all `Lesson`
rows rather than against the same predicate — plus explicit "orphan excluded" and
"no staged row included" assertions.

Layer 3 (**shipped code on real rows**): `scripts/lib/sqlite-prisma-lite.mjs` — a SQLite-backed
client with Prisma's query surface (it **throws** on any query shape it does not model, so
nothing is silently approximated). The compiled-with-`tsc`, unmodified modules are executed
against the real rows: `reconcileOfficialCurriculum` (twice: 23 created, all DRAFT, second run
zero writes, no duplicate `officialCode`), `getLessonReadiness`, `markLessonReady`/`openLesson`
(incl. refusal-with-no-write, `NO_OP_ALREADY_IN_STATE` replay, single anchor row, correct
`segment`, **zero** notifications), `unpublishLesson` (anchor deleted, mirror follows),
`getCourseSessionProgress`/`canAccessLesson` (universe = PUBLISHED only; `PUBLISHED`+locked
reachable-but-gated; wrong-track → 404), `isParentLessonPreviewAllowed` (full matrix,
Phase 12 Finding 2 closed on real rows), the ARCHIVED/orphan/unknown-id refusals, and two
**mutation controls** (neuter the universe clause → the unpublished lesson enters the
universe; remove the readiness gate → an incomplete lesson gets published).
→ **70 assertions, 0 failures.**

Layer 4 (`local` mode): the real file `prisma/db/custom.db` — did not exist in the clone, so it
was created from the base schema + all six migrations, verified column-for-column against
`prisma/schema.prisma` (21 tables, exact match), then populated by the **real reconciler**
(the only supported populator here; `npm run db:seed` cannot run without the engine) and
inventoried: 23 official lessons, `{"DRAFT": 23}`, mirror 1→0 rows, `publications: 0`,
`awaitingOpen: 23`.

Test suite: `tests/session-lifecycle-phase13.test.js` — **294 assertions, 0 failures**, in
five layers (pure contract · ceremony over a *strict* fake client that throws on unknown
`where` clauses · reader source pins **each with a negative control** · schema/migration pins ·
the whole real-DB verifier re-executed as a child process, which **fails** rather than skipping
if `node:sqlite` is missing). Mutation-verified end to end: inverting
`LESSON_STUDENT_STATUS_FILTER` → 10 failures; deleting the ARCHIVED freeze → 7 failures.
The fake clients in the repaired suites now also evaluate `where.status` strictly, and
student-visible fixtures gained `status: "PUBLISHED"` — exactly the repair Phase 12 applied
for `trackScope`.

Regression, all 18 suites, 0 failures (2,430 assertions total; 2,136 excluding this phase's
new file):

```
authorization-invariants 93 · calendar-i18n-phase9 440 · curriculum-reconciliation-phase11 56*
kodgy-phase10 231 · migration-sql 15 · mock-exam-grading-isolation 22 · mock-exam-phase8 135*
parent-dashboard-isolation 112* · parent-monthly-report 67 · platform-upgrade-2026-migration 98
quiz-analytics 44 · registration-validators 24 · security-hardening 247 · seed-idempotency 18
session-lifecycle-phase13 294 · session-progression 162* · session-quiz 70
track-architecture-phase12 302*        (* repaired for Phase 13 — see below)
```

**Nothing was weakened.** The five repaired suites were changed only as follows, and every
change is a *fixture* catching up with the schema or a regex *narrowed* to the new shape:

- `session-progression` 151 → 162: fixtures gained `status: "PUBLISHED"`; the fake `where`
  evaluator now **fails closed** on unknown clauses (it previously ignored them); a new
  section 14b pins that the lifecycle field — not the mirror — decides visibility, in both
  directions (mirror-true+DRAFT invisible, mirror-false+PUBLISHED visible, READY invisible,
  ARCHIVED excluded by the Phase 11 clause); two source pins retightened.
- `curriculum-reconciliation-phase11` 51 → 56: "official rows are published" retargeted to
  "official rows are `DRAFT` (staged, not published)" + "the reconciler writes neither the
  demoted mirror nor the retired `isLocked`"; the universe query now uses the lifecycle
  filter and additionally asserts an unopened curriculum is invisible **and** becomes exactly
  23 after the ceremony.
- `track-architecture-phase12` 301 → 302: the parent-preview pin now requires the *combined*
  helper call (`status` + `trackScope` + course) and forbids the old inline re-implementation.
- `mock-exam-phase8` 135 → 135 and `parent-dashboard-isolation` 112 → 112: `status` added to
  lesson fixtures only; counts identical to baseline.

Static checks: `npx tsc --noEmit` → **0 errors** (also via `npm run typecheck`).
`npm run lint` → **94 problems (93 errors, 1 warning)** vs baseline `12b5685` measured at
**83 (82 errors, 1 warning)**: production `src/**` and the new `scripts/**` contribute
**zero** new problems (the six `eslint-disable` directives initially added to
`session-lifecycle.ts` were removed as unused, and the two
`no-unused-expressions` warnings in the adapter were fixed); the +11 delta is
`@typescript-eslint/no-require-imports` in the new test file, the same rule already violated
by 9 of the repo's existing test harnesses (this repo has no `test` script — suites are run
with `node tests/*.test.js`). **`npm run build` → exit 0**: `✓ Compiled successfully in
13.7s`, 62/62 static pages, standalone bundle produced, all four new admin routes present in
the route manifest. One environmental caveat, identical to Phase 12's record: a
`PrismaClientInitializationError` is printed while collecting page data because the sandbox's
query-engine file is a placeholder — the build still completes and exits 0. `SECURITY_HASH_SECRET`
must be present for `next build` (Phase 3's fail-fast guard); the recorded run supplied a
throwaway value in the environment rather than using the `SKIP_PRODUCTION_ENV_CHECK` escape hatch.

---

## 11. Operator runbook

- **Publish a session:** `POST /api/admin/lessons/{id}/mark-ready` (409 `READINESS_BLOCKED`
  returns `readiness.blocking` + per-item `code`s to show in the UI) → `POST …/open`.
  Re-running `open` is safe. **Withdraw:** `POST …/unpublish` (deletes the anchor; the
  lesson leaves the student universe immediately, progression relocks the tail).
- **"Student can't see a published lesson"** is nearly always correct behaviour: either
  progression has not reached it (`PREVIOUS_SESSION_INCOMPLETE` — check the previous
  session's video watch %, every quiz, every submission), or its `trackScope` is not the
  child's track (Phase 12), or `curriculumStatus` is `ARCHIVED` (Phase 11).
- **After a raw-SQL fix that touched `Lesson.isPublished`:** parity is restored by the next
  ceremony, or by `UPDATE "Lesson" SET "status"='PUBLISHED' WHERE "status"='DRAFT' AND
  COALESCE(CAST("isPublished" AS INTEGER),0)=1;` — the same guarded statement, deliberately
  replayable.
- **Do not** add `PATCH {status}`, do not read `isPublished`/`isLocked` to decide anything,
  and do not write `Lesson.status` outside `transitionLesson`. Those three prohibitions are
  what keep this model from collapsing back into a boolean.
