# Phase 19 — Parent & Analytics Alignment

**Status:** implemented and verified (2026-09-10). Deliberately NOT merged (separate pre-merge audit follows, per the phase protocol).
**Depends on:** Phase 11 (official 23-lesson canonical curriculum: `Lesson.unitId` / `officialCode` / `curriculumStatus=OFFICIAL`), Phase 12 (`TrackScope`, `trackScopeWhere`/`canAccessTrackScope`, per-child slicing), Phase 13 (lifecycle `Lesson.status`, PUBLISHED universe), Phase 4 (progression engine + `orderCourseLessons`), Phase 6 (teacher analytics attempt weighting), Phase 7 (parent linkage scope + subscription payload).
**Closes:** roadmap gap **G9** (parent tree track-blindness, weekly/monthly reports pre-dat­ing the official curriculum, `progress.ts` legacy-chain-only).
**Verdict:** `PASS — SAFE TO MERGE` (with the documented sandbox limitation of §15).

---

## 1. Discovery

The audit (`docs/MASTER_PLATFORM_AUDIT_AND_ROADMAP.md` **G9**, 936‑939) and road­map spec (~line 1178) were confirmed against the source:

1. **`src/lib/progress.ts` (shared video progress) discovered the video universe by legacy chain only** — `lesson.topic.unit.part.courseId` — so canonical official lessons (`unitId`-linked, `topicId = null`) were **invisible to video progress everywhere** (student/parent dashboards, weekly report, teacher completion numbers). Worse, it sliced by at most ONE student's track, so a multi-child batch call could attribute a wrong-track universe to a sibling.
2. **Parent dashboard homework denominators still used the legacy topic chain**, understating the official universe; the payload did not expose `graded` (the monthly report contract field stayed `0`).
3. **Route orderings were legacy-chain-first**, so a canonical-only course mis-ordered sessions relative to the engine's `orderCourseLessons`.
4. **`parents/me/analytics` + `parents/me/weekly-report` sliced the universe to the UNION of the parent's children's tracks** (`trackScopeInWhere(getParentTrackScopes(...))`) — with children on different tracks, both siblings were measured against a union (SHARED + ARABIC + LANGUAGE = 22 of 23) instead of each child's own universe; denominators could include sessions of a track a child can never open, inflating denominators and collapsing sibling differences.
5. **Teacher overview lesson completion counted raw `lessonProgress` rows** (`isCompleted`), which includes archived (R1 legacy) history and any wrong-track rows — numerators could escape the official universe.
6. **Kodgy's scripted knowledge set referenced the pre-official curriculum**: a false learning path ("variables → conditions → loops → functions → arrays, then AI"), no answers on official Units 1–6 topics, and unverifiable structure claims.
7. **Export-progress CSV used the legacy `topic` title column only**, printing blanks for canonical lessons.

## 2. Design decisions

- **One universe, everywhere.** "Official curriculum universe for a student" = lessons of the student's enrolled course matched through the canonical chain (`unit → part → course`, legacy topic chain only as archived-history fallback) ∧ `trackScope` contains the student's track (`trackScopeWhere(schoolType)` — fail-closed) ∧ `status = PUBLISHED` ∧ `curriculumStatus ≠ ARCHIVED`. Every reporting surface in scope now derives from exactly that predicate; numerators are restricted to the same universe (never raw history).
- **Per CHILD, never a union.** A parent's reports key every universe by `student.id` and slice by that child's own `schoolType`. The Phase 12 union rule was deliberately superseded for the two measurement routes (analytics, weekly report) — the union is correct for *content browsing* (`/api/courses/[slug]`, `/api/lessons/[id]` previews stay union-scoped by design) but wrong for *measurement*.
- **Attempt weighting preserved (Phase 6).** Teacher analytics keeps finished-attempt-only, attempt-weighted aggregation; the new per-student lesson-completion pooling (sum numerators / sum denominators, then `Math.round`) mirrors the existing `avgQuizScore` strategy.
- **Shared-attempt classification, documented.** A SHARED quiz/homework's attempts land in the SHARED bucket of `trackSplit` — classified by the *content's* `trackScope`, never by the student's track. An ARABIC student's 90% on a SHARED session quiz counts in SHARED exactly once (no double-counting, no per-track replication).
- **History is data, not curriculum.** Nothing archived was deleted; R1 completions/submissions/attempts remain queryable history but never enter active reporting numerators or denominators. Progression rules untouched.
- **Kodgy: data grounding, zero engine change.** The deterministic contract (`match`, `pickAnswer`, `suggestedPrompts`, `supportedIntents`, `normalize`) is byte-for-byte preserved behaviorally; only knowledge content changed, plus a new exported, dependency-free `CURRICULUM_GROUNDING` table (23 sessions) that tests cross-check against `OFFICIAL_LESSON_CODES` and the knowledge model so drift fails loudly.

## 3. Progress calculations — the shared service (`src/lib/progress.ts`)

- `videoLessonIdsByStudent(courseIds, students)` previously did one legacy-chain `lesson.findMany` per course and sliced by **one** student's track. It now batch-fetches the **canonical candidate set** per course (`TopicOrUnitChains(courseId)` + `status: PUBLISHED` + `EXCLUDE_ARCHIVED_LESSON`, `videoUrl != null`) **once**, then computes each student's universe with `canAccessTrackScope` over the student's own `schoolType`. Mixed batches (one ARABIC + one LANGUAGE sibling) resolve independently.
- `getVideoProgressForStudents` denominators/completed/averages/minutes now iterate per-student universes; `getVideoProgressInRange` (weekly window) restricts its `lessonId: { in: [...] }` numerators to the same universe. The import-cycle constraint (`session-progress.ts` imports `VIDEO_COMPLETION_THRESHOLD` from here) is respected — the module stays standalone; no `session-progress` import.

## 4. Student dashboard (`src/app/api/students/me/dashboard/route.ts`)

- Lessons are now ordered by `orderCourseLessons(fetched, courseId)` — the same deterministic total order the engine uses (Part → Unit → Topic → Lesson, unit-link chain wins) — replacing the legacy topic-chain-first `orderBy`. `continueLesson` therefore names the engine's current session with canonical Part/Unit provenance.
- Universes were already track + lifecycle sliced (Phase 12/13 work); this phase aligns ordering and consumes the re-grounded shared service for video numbers.

## 5. Parent dashboard (`src/app/api/parents/me/dashboard/route.ts`)

- Homework universe: canonical **dual-chain** (`lessonCourseChainOr(courseId)`) + `childTrack` + `PUBLISHED` + non-archived (previously legacy topic chain only — the Phase 12 debt). Numerators (`submitted`, `graded`) are restricted to the same universe, so archived-history and cross-track submissions (e.g. a GRADED row on an R1 homework) cannot inflate them. Denominator can never be exceeded (≤ 100% by construction).
- Payload now carries `homework: { total, submitted, graded, pending, completionPct, recent }` — `graded` was the missing contract field that froze the monthly report's graded count at 0.
- `strongTopics`/`weakTopics` group finished attempts by the lesson's **canonical container** (`topic ?? unit`) so official unit-linked lessons produce real unit labels (was: blank when `topic` was null).
- Per-child independence was already the shape (Phase 7); video per-child universe now truly differs by track (§3), and `sessionProgress` uses the engine's per-child derivation, so a 2-child parent sees child A = 20-official-session universe and child B = 19 in the fixture.

## 6. Weekly & monthly reports

**Weekly (`src/app/api/parents/me/weekly-report/route.ts`):**
- For EACH linked child: universe = `trackScopeWhere(child.schoolType)` + `lessonCourseChainOr(child.courseId)` + `PUBLISHED` + non-archived — replacing the union-of-children denominator. Same course, different tracks ⇒ different denominators (ARABIC 20 vs LANGUAGE 19 in the fixture: 10% vs 11% instead of an identical collapsed 2/22 = 9%).
- `getVideoProgressInRange` is invoked per child (was: first child's track applied to all); `videosWatched/`watchedMinutes`/`videosCompleted` derive from in-universe rows only.
- No `> 100%`, no negatives, no legacy/archived lessons, no wrong-track lessons — by the shared predicate, not by clamps.

**Monthly (`src/components/parent/monthly-report.tsx`):** unchanged file — the report derives from the dashboard payload by construction; with `homework.graded` now supplied by the server, the whole mapping flows (verified by assertion). Agreement by construction: one payload, one mapper.

## 7. Certificate & export-progress

- Certificate (`students/me/certificate`) was **already aligned** (dual-chain + track + `PUBLISHED` + 80% threshold); the suite now pins it against the canonical-only fixture: eligible student = 16/20 (archived extra completion excluded), ineligible = 2/20, `pct ≤ 100`, certificate id only when eligible.
- Export-progress CSV: the Topic column falls back to the canonical **unit** title (`topic ?? unit`, `titleAr ?? title`) so unit-linked official sessions print a container instead of a blank.

## 8. Teacher & track analytics (`src/app/api/teacher/analytics/route.ts`)

- Overview lesson completion is now measured against **per-student official universes**: universe lessons batch-fetched per course (dual-chain + `PUBLISHED` + non-archived), sliced per student with `canAccessTrackScope`, counting only in-universe `isCompleted` rows. Pooled per `avgQuizScore`-style: `Σcompleted / Σuniverse` rounded. Archived R1 completions no longer count (fixture: raw rows say 3, aligned answer: 2).
- `trackSplit` (SHARED / ARABIC / LANGUAGE) is **untouched** by design — Phase 18 pins hold — and the suite now proves the three buckets always exist, in order, with attempts classified exactly once by content scope (SHARED attempts never replicated into ARABIC/LANGUAGE buckets).
- Per-group split uses the same authorized population; a different teacher's group/course contributes nothing (cross-course isolation asserted).

## 9. Parent authorization

- Verified contract: every parent measurement surface derives child set from **server-side linkage only** (`ParentStudentLink.parentId = session parent`). No route accepts a client-supplied child/track identifier — a request body carrying forged `studentId`/`track` fields yields a byte-identical response (asserted by deep-equality).
- Role matrix re-verified: student → 403 on all three parent routes; parent → 403 on student/certificate/teacher routes; anonymous → 401. Content-preview routes keep the union-of-tracks rule (§2) and `isParentAuthorizedForCourse` linkage gates (Phase 7) — untouched.

## 10. Kodgy grounding (`src/lib/kodgy/response-engine.ts`)

- **Data, not system** (Principle 9): deterministic matcher, examples-corpus invariants, precedence (phrases > keywords, substring guards, earliest-entry ties) and the fallback path are unchanged. No LLM, no network, no DB, no secrets — confirmed by source inspection and pinned by test.
- **New exported `CURRICULUM_GROUNDING`** — 23 entries `{ code, intent, titleAr, titleEn }` in curriculum order, codes exactly `1-1…7-3`, titles copied verbatim from `docs/curriculum/knowledge-model.json`. The phase test cross-compiles `src/db/official-curriculum.ts`/`src/lib/official-curriculum.ts` and asserts `grounding.codes === OFFICIAL_LESSON_CODES` and per-code AR/EN title equality with the live model — future curriculum edits that forget Kodgy fail CI loudly.
- **Re-grounded answers** (AR + EN) for `help`, `getting-started`, `courses`, `lessons`, `programming`, `ai-basics`, `ml-basics`, `neural-network`, `llm`: every reference names real sessions (e.g. *"الجلسات 1-2 و1-3 و1-4"* for AI basics, *"الجلسة 7-2"* for neural networks). The old **false learning path** ("variables → conditions → loops → functions → arrays…") is replaced by the official unit sequence (IT & Society 1-x → Cybersecurity 2-x → Web Applications 3-x → Web & Media Design 4-x → Data 5-x → Statistics 6-x → AI 7-x).
- **Six new education intents** covering the missing units — `edu.it-society` (1-x), `edu.cybersecurity` (2-x), `edu.web-applications` (3-x), `edu.web-media-design` (4-x), `edu.data` (5-x), `edu.statistics` (6-x) — each answer naming its sessions + codes in both locales. Keyword design respects the Phase 10 tie/precedence pins (smoke-tested: all pinned queries unchanged; the 231-assertion Phase 10 suite still passes byte-comparably).

## 11. Historical data preservation

- Zero deletes, zero updates to historical rows: archived R1 lessons, their `lessonProgress`/quiz-attempt/homework-submission history, and all DRAFT staged sessions remain exactly as stored. They are excluded from ACTIVE reporting by the shared predicate (ARCHIVED/lifecycle/track), never by mutation. Progression rules (`getUnlockedLessonIds`, gating, unlock propagation) were not touched.

## 12. Read-only & security notes

- All measurement routes are GET and perform **zero DB writes** (asserted by mock write-tracking on every scenario). No schema/migration/dependency change; no new endpoints; parent UI untouched.
- The student dashboard's existing answer-leak/locked-content gates (Phase 4) and quiz gates (Phase 5) were not modified.

## 13. Test suite added — `tests/parent-analytics-alignment-phase19.test.js` (176 assertions)

Mirrors the isolation-harness style (offline `tsc` transpile of real route/lib sources + in-memory Prisma-subset mock with relation resolution). **Representative populated data, never zero-row:**

- Canonical-only official course: 2 parts / 7 units / **23 unit-linked OFFICIAL lessons** (`1-1…7-3`), zero `Topic` rows; 18 SHARED (one DRAFT — lifecycle exclusion), 3 ARABIC-only, 2 LANGUAGE-only ⇒ ARABIC universe 20, LANGUAGE 19; 6 video lessons distributed by track.
- R1-style archived distractors (2 archived lessons, one with a 100%-completed progress row + graded homework submission + quiz), a second decoy course with its own teacher/student/attempts — all of which must be invisible to the numbers.
- **The required multi-child scenario**: one parent linked to an ARABIC child AND a LANGUAGE child on the same course (+ single-child parent, + childless parent robustness); finished AND open quiz attempts; submitted/graded/PENDING homework including **archived** and **cross-track** submissions; attendance; active subscription on one child, none on the other.
- 11 sections (A–K): Kodgy grounding×model cross-check + structure claims + contract invariants; student dashboard totals/ordering/gating; certificate 80% rule; shared service video universes (overall + weekly window); parent dashboard per-child totals/homework/video/session-progress/strong-weak; weekly per-child denominators (10% vs 11% — union collapse would print 9% twice); monthly mapping incl. `homework.graded`; parent analytics per-child + canonical grouping; teacher trackSplit / pooled universes / cross-course isolation; CSV unit fallback; authorization matrix + forged-input byte-identity; global percentage bounds.

## 14. Regression sweep

All 24 suites green (4,195 assertions): Phase 11 (56) · Phase 12 (**304** — the 2 union pins updated to 4 per-child pins, see below) · Phase 13 (299) · Phase 14 (127) · Phase 15 (384) · Phase 16 (365) · Phase 17 (319) · Phase 18 (365) · Phase 10 Kodgy (**231**, unchanged grounding behavior on pinned queries) · session-progression (162) · session-quiz (70) · quiz-analytics (44) · parent-dashboard-isolation (112) · parent-monthly-report (67) · calendar-i18n (444) · admin/authorization/migration/registration/seed/mock-exam suites · **phase-19 new suite (176)**.

**Earlier-suite touch, per protocol:** `tests/track-architecture-phase12.test.js` pinned the two measurement routes' union slice (`trackScopeInWhere(getParentTrackScopes(...))`). Phase 19 **supersedes** that rule for measurement (§2): those two assertions were replaced by four stronger ones (`trackScopeWhere(s.schoolType)` present + union helper absent). The dashboard's per-child pin and every behavioral assertion elsewhere are untouched.

## 15. Typecheck / Lint / Build

- **`tsc --noEmit`: baseline-identical** — 29 pre-existing findings before and after (same list; only line numbers moved with added lines). The findings stem from the stale generated Prisma client; the sandbox cannot run `prisma generate` (binaries.prisma.sh unreachable — same as Phases 6–17; **re-run where engines are reachable**).
- **eslint:** zero new findings — the only finding on touched files (react-hooks ref-write in `monthly-report.tsx` line 126) exists identically on the base commit.
- **`next build`:** aborts at the type gate on the *same* pre-existing findings as the base commit (verified by running the build on both states with env supplied). Outcome-informed: blocked by environment, not this change; runtime behavior is covered by the compiled-real-code harness above.

## 16. Documentation

- This report; `docs/PROJECT_STATE.md` Phase-status entry appended. Roadmap gap G9 is the candidate for closure on merge.

## 17. Strict phase boundary — explicitly NOT done

- **No Phase 20 security overhaul** (no rate-limit/CSP/contract-matrix work, no legacy `Setting:session:*` removal).
- **No Postgres/production-storage/deployment work** (Phase 21+). No schema, migration, dependency, or i18n-key changes.
- **No parent UI redesign** — the only UI contract change is additive (`homework.graded` now real); zero component edits.
- **No progression-engine, grading, lifecycle, or notification changes**; teacher question/quiz surfaces untouched; mock exams untouched.

## 18. Final verdict

**G9 closed. PASS — SAFE TO MERGE.** Dashboards, weekly/monthly reports, certificate, teacher analytics, and the shared progress service now agree on the same official-lesson universe per student — canonical chain, fail-closed track slice, `PUBLISHED` lifecycle — and a parent with one ARABIC and one LANGUAGE child sees two independently, correctly measured children. Kodgy speaks in real `1-1…7-3` session codes with the engine contract untouched, and the drift tripwire (grounding ↔ `OFFICIAL_LESSON_CODES` ↔ knowledge model) makes future curriculum edits that skip Kodgy a failing test, not stale copy.
