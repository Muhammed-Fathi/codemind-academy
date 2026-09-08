# Phase 11 — Official Curriculum Reconciliation (R1 → R2)

**Status:** completed (2026-09-09)
**Branch:** `arena/01a08305-codemind-academy`
**Baseline:** `adfdb67` (`main` HEAD at branch start)

---

## Objective

Replace the live **synthetic R1 curriculum** (36 hand-written lessons in
`src/lib/curriculum.ts`, topic-linked) with the **official R2 curriculum**
from `docs/curriculum/knowledge-model.json` (2 parts, 7 units, 23 lessons,
codes `1-1`…`7-3`, canonical `Lesson.unitId`) — idempotently, without
destroying any user history, and with the progression universe pinned to
exactly the 23 official lessons. The legacy `{action:"seed"}` footgun is
retired. No Phase 12+ work (tracks, PDFs, publishing, notifications,
redesigns, Postgres).

---

## Baseline

| Item | Value |
|---|---|
| `main` HEAD at start | `adfdb67` |
| Working tree | clean |
| Branch | `arena/01a08305-codemind-academy` |
| Prior phase | Phase 10 Kodgy assistant |
| Schema | already carries `Lesson.unitId`, `Lesson.officialCode @unique`, `CurriculumStatus` — **no migration needed** |

---

## 1. Discovery findings (what existed before)

| Item | Finding |
|---|---|
| R1 data | `src/lib/curriculum.ts` (`CURRICULUM`, 36 lessons) + `src/lib/curriculum-seed.ts` (`seedCurriculumFromFile`, create-only, pinned by `tests/seed-idempotency.test.js`) |
| R1 entry points | `POST /api/admin/courses {action:"seed"}` (CoursesView button), `scripts/seed.ts` (§4, raw `create` loop — **not** idempotent), `scripts/seed-curriculum.ts` |
| R2 contract | `docs/curriculum/knowledge-model.json` (~142 KB): Part 1 = units 1–4 (14 lessons), Part 2 = units 5–7 (9 lessons); unit `order` is **global** 1..7, so legacy P2 units (orders 1,2,3) must be matched **positionally**, never by order value |
| Reader inventory | ~19 `db.lesson` read sites; student/parent readers were topic-chain-only (official lessons invisible) or denominator/numerator-mismatched; teacher readers topic-only; admin tree/counts topic-only |
| Engine | `getCourseSessionProgress` already dual-chain (Phase 4 follow-up) but had no archived concept |
| i18n | generated dict is auto-emitted (`scripts/i18n/emit-dict.mjs`) — hand keys go in `DICT_2026`; maxes were `admin.317` / `api.225` |

---

## 2. Design decisions

- **Archive, don't delete (ADR):** legacy lessons flip to `curriculumStatus:
  ARCHIVED`; rows, ids, media and all relations (progress, attempts,
  submissions, videos, bookmarks, notes) are preserved untouched.
- **Positional adoption (ADR):** parts/units match by position inside their
  parent (sorted by `order, createdAt`), then official titles/order are
  written in place. No duplicate units; no `Topic` rows ever created.
- **Reader rule per audience:**
  - student/parent/progression universe = dual-chain `OR` + `NOT ARCHIVED`;
  - teacher/admin management scopes = dual-chain, **no** exclusion (a pending
    legacy submission still needs grading; admins manage the full catalogue).
- **Numerator hygiene:** every completion fraction restricts BOTH sides to
  the active universe, so preserved legacy history can neither inflate an
  average nor push it past 100%.
- **No migration:** additive schema already in place; `prisma migrate status`
  run attempted (sandbox-blocked, see §8).

---

## 3. The reconciler

**New:** `src/lib/official-curriculum.ts` (server-only — imports the ~142 KB
JSON; never import from a client component) + CLI `scripts/reconcile-curriculum.ts`.

- `loadOfficialCurriculumModel(source?)` — strict, fail-closed validation:
  exactly 2 parts / 7 units / 23 lessons, exact code set
  (`OFFICIAL_LESSON_CODES`), `N-M` format, uniqueness, bilingual titles,
  non-empty knowledge summaries. Accepts an injected source for tests.
- `reconcileOfficialCurriculum(client?, model?)` — idempotent, six steps:
  1. upsert the course by unique slug `programming-ai-2nd-sec` (display fields only);
  2–3. positional part/unit match, in-place official rewrite (field-compare skips no-op updates);
  4. lesson upsert by unique `officialCode` — writes ONLY canonical fields (`unitId`, titles, `order`, `description`, `OFFICIAL`, published, unlocked); media, topic links and relations preserved;
  5. archive sweep: in-course lessons through EITHER chain with no `officialCode` and not already archived → `ARCHIVED` (single `updateMany`);
  6. post-state assertions (all 23 present, unit-linked, `OFFICIAL`) + warnings for unknown `officialCode`s (never touched) and extra parts/units (left untouched).
- Returns a `ReconcileReport` (`parts/units/lessonsCreated…`,
  `officialLessonCodes`, `archivedLessonIds`, `warnings`); a second run
  performs **zero writes** (asserted by the test suite).
- Crash-safe by re-run: every step is independently idempotent (no explicit
  transaction — same rationale as the retired seeder).

---

## 4. Reader changes (per route)

Shared predicates in `src/lib/session-progress.ts`: `EXCLUDE_ARCHIVED_LESSON`,
`lessonCourseChainOr(courseId)`, `lessonCoursesChainOr(courseIds)`.

| Surface | Change |
|---|---|
| Engine universe (`session-progress.ts`) | `+ NOT ARCHIVED` (universe is now exactly the official 23) |
| `GET /api/courses/[slug]` | both lesson includes `+ NOT ARCHIVED`; empty legacy topics dropped from the tree |
| `GET /api/lessons/[id]` prev/next | shared dual-chain helper `+ NOT ARCHIVED` |
| Student dashboard | lessons + pending-homework universes dual-chain `+ NOT ARCHIVED`; `continueLesson` part/unit/courseSlug canonical-first (`continuePart`/`continueUnit` now defined — the response previously referenced undefined bindings) |
| Student homework list | legacy topic-chain guard replaced with `NOT ARCHIVED` backstop (unlocked-set from the engine is the scope) |
| Student certificate | totals + completions dual-chain `+ NOT ARCHIVED` (80% rule unchanged) |
| Parent dashboard / analytics / weekly | denominators dual-chain `+ NOT ARCHIVED`; numerators restricted to universe ids (no >100%) |
| `src/lib/progress.ts` (video %) | dual-chain `+ NOT ARCHIVED` + canonical-first attribution, inline (avoids a `progress ↔ session-progress` import cycle) |
| Teacher lessons/homework/dashboard | dual-chain, **no** exclusion; quiz-selector groups unit lessons under their unit (additive `lessons` array); course attribution canonical-first |
| Teacher quizzes/analytics | already dual-chain — no change |
| Admin tree + counts | `unit.lessons` included (full catalogue incl. archived); `lessonsCount` deduped across chains; new additive `activeLessonsCount` |
| Mock-exam pool, bookmarks, course catalog | audited — no change (pool curation / null-safe / marketing-only) |
| `POST /api/admin/ai-generate-quiz` | 410 guard for `ARCHIVED` targets (already dual-chain) |

---

## 5. Retired seed

| Item | Change |
|---|---|
| `POST /api/admin/courses {action:"seed"}` | **410 Gone** with `api.226` (not 404 — old callers learn it is intentionally retired) |
| `POST /api/admin/courses {action:"reconcile-official"}` | **new** — runs the reconciler, returns the report |
| CoursesView | button now posts `reconcile-official`, toasts `admin.320` with report counts; cards show active/total lessons; tree dialog renders `unit.lessons` with `officialCode` + Archived badges; AI-generator picker flattens both chains, dedupes, skips archived |
| `scripts/seed.ts` §4 | R1 `create` loop replaced with `reconcileOfficialCurriculum(db)`; sample quiz/homework attach to official lesson `1-1`, guarded against re-run dupes |
| `scripts/seed-curriculum.ts` | rewritten to delegate to the reconciler (keeps the student-code backfill) |
| `src/lib/curriculum.ts` / `curriculum-seed.ts` | deprecation headers; `seedCurriculumFromFile` kept compiling + behavior-pinned by `tests/seed-idempotency.test.js`, with a runtime `[RETIRED]` trip-wire warning; `createStudentWithCode` / `backfillStudentCodes` stay supported |

---

## 6. i18n keys (all in `DICT_2026`)

`api.226` seed-retired (410), `api.227` archived quiz target (410),
`admin.318` reconcile button, `admin.319` busy state, `admin.320` success
toast (`{p1}` active / `{p2}` archived), `admin.321` “Archived” badge,
`admin.322` “Unit lessons” section. No generated-dict edit (auto-emitted
file left untouched).

---

## 7. Tests

**New:** `tests/curriculum-reconciliation-phase11.test.js` — **51/51 pass.**
Same offline pattern as the pinned suites (tsc-compile the TS under test,
in-memory mock Prisma with a real `where` evaluator incl. `OR`/`NOT`/`in`/
relation chains). Covers: model contract (2/7/23, exact codes, global unit
order, descriptions) + six fail-closed loader cases; fresh-DB create counts
and row shape; re-run **zero writes**; legacy-R1 DB (positional adoption,
P2 orders 1,2,3→5,6,7 with reused ids, 17 archived with media/history
intact, other course + unknown code untouched, unknown code warned);
extra parts/units (untouched + warned, code-less lessons still archive);
reader universe = exactly the 23 official codes.

**Updated (strengthened, not weakened):**
`tests/session-progression.test.js` §22 — the two course-tree fetch-shape
invariants now assert the FULL shape (chain + order + payload + archived
exclusion) plus the exclusion import: **145/145 pass** (was 144).

**Full offline matrix — 1,804 assertions, 0 failures:**

| Suite | Result |
|---|---|
| curriculum-reconciliation-phase11 (new) | 51/51 |
| seed-idempotency (pinned R1 behavior) | 18/18 |
| session-progression | 145/145 |
| session-quiz | 70/70 |
| quiz-analytics | 44/44 |
| mock-exam-phase8 / grading-isolation | 135/135, 22/22 |
| authorization-invariants | 93/93 |
| parent-dashboard-isolation / monthly-report | 112/112, 67/67 |
| registration-validators | 24/24 |
| security-hard
...[truncated 3655 chars]