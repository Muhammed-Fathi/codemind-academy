# Phase C — Curriculum Aggregation / Unified Lesson Content

Status: **implemented on `arena/01a0b577-codemind-academy` (from `main` @ `fb3c2d3`)** — no PR, no merge, no schema change, no migration, no seed change.

## 1. Problem

The platform already had every academic component individually implemented
(SessionVideo recordings, Materials/PDFs, Quizzes, Homework), but each student
surface answered *"does this lesson have X?"* with its own private query:

| Surface | video | material | quiz | homework |
|---|---|---|---|---|
| Course tree (`GET /api/courses/[slug]`) | Phase B inline SessionVideo query + legacy `videoUrl` | Phase 14 descriptors (unredacted presence) | **raw `lesson.quizzes.length` — NO track filter** | **raw `lesson.homeworks.length` — NO track filter** |
| Lesson page (`GET /api/lessons/[id]`) | (delegated to the session-video list) | Phase 14 descriptors | track-filtered | track-filtered |
| Dashboard (`GET /api/students/me/dashboard`) | **legacy `videoUrl` only** | — | — | — |

The concrete defect: a **SHARED** lesson hosting only a **LANGUAGE** quiz
showed a "Quiz" badge to an **ARABIC** student in the course tree while the
lesson page (which filters) said "لا يوجد اختبار". The same lesson looked
different depending on which screen rendered it.

## 2. The Phase C authority — `src/lib/lesson-content.ts`

One reusable **server-side** Lesson Content Summary module. It answers, for a
viewer and a lesson: *does this lesson contain student-visible videos /
materials / quiz / homework?* as

```
LessonContentSummary {
  lessonId
  video:    { state: ABSENT | AVAILABLE | LOCKED, count }
  material: { state, count }
  quiz:     { state, count }
  homework: { state, count }
}
```

* **ABSENT** — the component does not exist for this lesson **for this
  viewer** (no rows, or only rows of the other audience — cross-audience rows
  are never exposed nor counted, so they read ABSENT-for-you, exactly like
  the lesson page's track-filtered lists).
* **AVAILABLE** — at least one student-visible, authorized instance exists.
* **LOCKED** — defined for the UI, but **no producer emits it today**: the
  current application has no child-component access rule that fires *below*
  an accessible lesson (quiz/homework gates delegate to `canAccessLesson`;
  a track-ineligible row is hidden, not locked — the platform's documented
  non-oracle policy). A future phase can produce it without a contract
  change, and the lesson page renders it defensively (course.239).

Functions:

* `buildLessonContentSummary(input)` — pure, per-lesson, over already-loaded
  rows.
* `countVisibleSessionVideos({lessonIds, viewer})` — ONE query for the modern
  SessionVideo dimension (students: own batch + `isPublished` +
  `videoTrackFilter`; batch-less students fail closed; parent/staff preview:
  any published row — retained pre-Phase-C tree behaviour).
* `buildLessonContentSummaries({lessons, viewer})` — batched, bounded queries
  regardless of lesson count (the course-tree entry point).
* `toLessonContentPayload(summary)` — serializable `{state, count}` shape for
  API responses.
* `hasContentPart(summary, part)` — boolean convenience.

### What it deliberately is NOT

* Not a second progression engine: it never reads `LessonProgress`, never
  computes unlock state, never restates the 95% rule, never imports
  `session-progress.ts`.
* Not an authorization layer: callers keep applying `canAccessLesson` /
  enrollment / lifecycle exactly as before. The summary only describes
  content inside lesson rows the caller was already allowed to read.
* No new states, no new locking rules, no readiness/open/publish changes.

### Reused authorities (no re-implementation)

* Track: `eligibleTrackScopes` / `videoTrackFilter` / `normalizeTrackScope`
  (Phase 12).
* Materials: `buildMaterialDescriptors` (Phase 14) — active + downloadable +
  scope-eligible + the legacy `pdfUrl` fallback.
* Videos: the Phase A/B batch + publication + track rule.

## 3. Callers (all derive from the same authority)

1. **Course tree** `GET /api/courses/[slug]` — replaces the inline
   `videoLessonIds` query and the raw quiz/homework counts. The lesson
   payload now carries `content` (serialized summary) and the skeleton flags
   (`hasVideo`, `hasPdf`, `materialCount`, `hasQuiz`, `hasAssignment`) read
   from it. Locked lessons keep the Phase 16 lock-independent skeleton badges
   and the full `locked ? null` redaction contract.
2. **Lesson page** `GET /api/lessons/[id]` — computes the summary AFTER
   `canAccessLesson` passes (students), in the student's own audience
   (schoolType + batch via the SAME lazy `syncStudentBatch` reconcile the
   session-video list uses). Returns `content` next to `requirements`.
3. **Dashboard / Continue Learning** `GET /api/students/me/dashboard` —
   `continueLesson` now carries `content` from the same authority (one
   targeted load of the chosen lesson's rows). The legacy `videoUrl` field is
   retained (documented; its behavioral pins predate Phase C).

## 4. Student Lesson page (one coherent academic workspace)

`src/components/course/student-lesson.tsx` — the main column now follows the
approved order:

```
[ Lesson header ]  officialCode · title · unit context · completion status
[ Videos ]         Phase B player / playlist (unchanged)
[ Summary ]        (lesson prose, unchanged)
[ Materials ]      ALL authorized materials + download/open actions
[ Quiz ]           every quiz of the session (engine requires all)
[ Homework ]       existing homework entry
[ Mark complete ]  (unchanged mechanics)
[ Requirements ]   (unchanged, server-computed)
[ Prev / Next ]
Sidebar: quick tip + notes (unchanged)
```

Empty states (approved copy, `i18n-dict-2026.ts`):

* no video — `course.228` "لا يوجد فيديو متاح لهذه الحصة حاليًا" (Phase B)
* no materials — `course.230` "لا توجد ملفات متاحة لهذه الحصة حاليًا" (new)
* no quiz — `course.231` "لا يوجد اختبار لهذه الحصة حاليًا" (new; supersedes
  `course.076` on this page)
* no homework — `course.232` "لا يوجد واجب لهذه الحصة حاليًا" (new; supersedes
  `course.080` on this page)

Materials/Quiz/Homework section titles are Arabic-first dict keys
(`course.233/235/236`). Loading, error and locked states preserved; empty
states are one-line, never heavy.

## 5. Course tree indicators

`src/components/course/student-course.tsx` — the per-lesson badge row is now
four compact **icon chips** (video 🎥 / material 📄 with the natural ×N count /
quiz / homework), matching the lesson page accents (primary/amber), with
`aria-label` + `title` localized labels (course.220/221/237/238), RTL-safe
(icons only, logical layout utilities, wraps on narrow screens), no raw ids,
no titles. Chips read `lesson.content` (the serialized authority output);
the legacy boolean flags remain a defensive fallback only.

## 6. Continue Learning

The dashboard card renders the same four chips from
`continueLesson.content`. No dashboard redesign; only the content-summary
contradiction (legacy-video-only) was eliminated.

## 7. Track / audience matrix (as implemented)

| Lesson | Component rows | Arabic student sees | Language student sees |
|---|---|---|---|
| SHARED | Arabic-batch video + Language-batch video | AVAILABLE (Arabic row, count 1) | AVAILABLE (Language row, count 1) |
| SHARED | SHARED material + ARABIC material + LANGUAGE material | AVAILABLE (SHARED + ARABIC) | AVAILABLE (SHARED + LANGUAGE) |
| SHARED | SHARED quiz + ARABIC quiz + LANGUAGE quiz | AVAILABLE (SHARED + ARABIC) | AVAILABLE (SHARED + LANGUAGE) |
| ARABIC-only | Arabic-batch video | AVAILABLE | lesson absent from the tree entirely |
| LANGUAGE-only | Language-batch video | lesson absent from the tree entirely | AVAILABLE |

A PUBLISHED-but-locked lesson keeps its skeleton badges (presence is
lock-independent, Phase 16) with every protected field redacted.

## 8. Legacy compatibility (documented, retained — nothing migrated)

* **`Lesson.videoUrl`** — counts as at most ONE video when (and only when) no
  modern student-visible SessionVideo row exists for the viewer. Modern rows
  always win; the fallback never stacks on top of a modern count. The
  progression engine still derives video *required-ness* from the column
  alone (untouched, `T`).
* **`Lesson.pdfUrl`** — forwarded into `buildMaterialDescriptors`; a
  LEGACY_URL descriptor appears only when no real Material descriptor exists
  (the Phase 14 rule). Never stacks.
* **Legacy Topic chain** — untouched; callers pass whatever lessons their
  dual-chain curriculum query returns.
* **Legacy parent/staff video preview** — parents and staff still see the
  "video" badge for ANY published recording linked to the lesson (pre-Phase-C
  behaviour retained; badges carry no identities).
* **Dashboard `continueLesson.videoUrl`** — retained for compatibility
  (pinned by the Phase 19 suite); modern-only lessons show `null` there while
  `content.video` reports the truth.
* **Retired dict keys** `course.076` / `course.080` remain in the catalogue
  (no longer referenced by the lesson page).

## 9. Authorization / leakage protections

* The aggregation never bypasses `canAccessLesson`: the lesson-page summary is
  computed only after the gate; the tree serves summaries only for lessons its
  lifecycle/archive/track-filtered query returned; the dashboard's
  continueLesson is unlocked by construction.
* Student aggregation is audience-scoped: `schoolType` + own `batchId` for
  videos, `eligibleTrackScopes` for materials/quizzes/homeworks; a
  batch-less/unrecognised-school student fails closed.
* Summaries carry states + counts only — no ids, titles, URLs, storage keys.
* Locked lessons: badges only; `videoUrl/pdfUrl/summary/description/quiz/
  homework/requirements` stay `locked ? null`; material descriptors `[]`.
* Cross-course: enrollment gates unchanged (403); foreign lesson = 404.

## 10. Files changed

**Added**
* `src/lib/lesson-content.ts` — the authority.
* `tests/lesson-content-aggregation-phaseC.test.js` — the Phase C suite (A–U).
* `docs/PHASE_C_LESSON_CONTENT_AGGREGATION.md` — this document.

**Modified**
* `src/app/api/courses/[slug]/route.ts` — authority-backed badges + `content`.
* `src/app/api/lessons/[id]/route.ts` — `content` in the lesson payload.
* `src/app/api/students/me/dashboard/route.ts` — `continueLesson.content`.
* `src/components/course/student-lesson.tsx` — workspace order + empty states.
* `src/components/course/student-course.tsx` — indicator chips.
* `src/components/student/student-dashboard.tsx` — Continue Learning chips.
* `src/lib/i18n-dict-2026.ts` — keys course.230–course.239.
* `tests/session-progression.test.js`,
  `tests/student-locked-curriculum-phase16.test.js`,
  `tests/student-session-media-alignment-phaseB.test.js` — source-pin
  supersessions (contract intent preserved, documented in place).
* `tests/parent-analytics-alignment-phase19.test.js` — mock gains empty
  `batch` / `sessionVideo` tables (the same accommodation Phase B made in the
  parent-dashboard-isolation mock).

**Not changed:** `prisma/schema.prisma`, `prisma/postgres/*`, migrations,
seeds, `session-progress.ts`, `session-lifecycle.ts`, `session-materials.ts`,
`track-scope.ts`, the quiz/homework attempt & grading flows.

## 11. Manual QA checklist (local)

Prereq: `npm run dev` (SQLite dev client), one Arabic + one Language student
enrolled in the same course group; admin uploads audience-specific content.

1. **Video-only lesson** — lesson page shows the video section; materials /
   quiz / homework sections show their one-line empty states; the tree shows
   only the video chip.
2. **Video + PDF** — both visible in the workspace; tree shows video + file
   chips (×N for multiple materials).
3. **Video + PDF + Quiz** — all three represented; quiz section lists the
   quiz with its question count / pass mark; tree chips match.
4. **Full lesson** — order reads Videos → Materials → Quiz → Homework; the
   four tree chips match the page exactly.
5. **Arabic vs Language (SHARED lesson)** — audience-split videos/quizzes/
   materials: each student counts only their own side; the other side is
   invisible everywhere (tree chips, lesson sections, dashboard card).
6. **Empty lesson** — four clean empty states, no broken controls, no tree
   chips.
7. **Locked lesson** — locked-row panel unchanged; tree shows skeleton chips
   but no content; direct URL → locked panel.
8. **Refresh** — the same summary renders again (no client-side state).
9. **Mobile (≤ 640px)** — sections stack in order; chips wrap without
   overflow; RTL intact in both locales.
10. **Continue Learning card** — chips agree with the tree for the same
    lesson; switching locale toggles tooltips/labels only.

## 12. Known limitations / deferred

* LOCKED is defined but never produced (documented above) — Phase H's
  progression alignment may give it meaning.
* The progression engine still counts EVERY quiz/homework of a lesson
  regardless of the child's track (pre-existing, intentionally untouched —
  it is progression semantics, deferred to Phase H).
* `SessionVideoView` → lesson completion alignment remains Phase H.
* Publishing-modal scrolling (Phase D) untouched.
