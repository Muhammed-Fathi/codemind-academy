# Phase 16 — Student Locked Curriculum & Session Access

> Visible curriculum skeleton, unified session page & deep-linkable access.
> Baseline: Phases 11 (official curriculum) → 12 (track isolation) → 13
> (lifecycle/publishing) → 14 (secure materials) → 15 (admin workflow).

## 1. The rule

A student's curriculum answers one question per session — *does this session
exist for me, and may I open it?* — with exactly three outcomes:

| State | Visibility | Content |
|---|---|---|
| `PUBLISHED` + unlocked | full tree row | full access (video, PDF, quiz, homework, progress, requirements) |
| `PUBLISHED` + locked | skeleton row (title, chapter/unit, `officialCode`, presence badges) | redacted (no URLs, no ids, no summary, no requirements) |
| `DRAFT` / `READY` / `ARCHIVED` / wrong track / wrong course | invisible everywhere | — |

Track isolation is mandatory: `ARABIC` students see `SHARED + ARABIC`,
`LANGUAGE` students see `SHARED + LANGUAGE`. No cross-track leaks by any
path: tree, direct id, prev/next, search (none exists), dashboard,
notifications, bookmarks, notes, or cached frontend state.

## 2. What changed

### 2.1 New: `src/lib/curriculum-visibility.ts`

The shared visibility predicate — lifecycle (`PUBLISHED`) + archive
(not `ARCHIVED`) + track (own scope) + course (enrolled, active group).
It is **not** a second curriculum source: every clause is imported from the
module that owns it and only ANDed here. It is also **not** a second unlock
engine: it never reads video progress, quiz attempts, or submissions.

- `studentLessonVisibilityWhere(schoolType)` — Prisma `where` fragment.
- `isLessonVisibleToViewer(row, { schoolType, courseId })` — pure predicate.
- `canStudentSeeLesson(studentId, lessonId)` — full single-id gate.

### 2.2 New: `src/lib/deep-link.ts`

Strict, dependency-free deep-link handling for `lesson:<id>`,
`video:<id>`, `quiz:<id>`, `homework:<id>`:

- kinds are exactly the four lowercase words; ids match
  `[A-Za-z0-9_-]{1,64}`; anything else → `null` (fail closed);
- targets are `(student-lesson | student-session-videos | student-quiz |
  student-homework, id)`;
- `navigateDeepLink` calls `setView` **before** `setNavParam` (the store
  clears the param on view change — order is load-bearing and pinned).

A deep link is navigation, never authorization: every landing view fetches
through its normal API route, which re-authorizes server-side.

### 2.3 Course tree (`GET /api/courses/[slug]`)

Locked skeleton gained identity + lock-independent presence:

- `officialCode` (session identity, e.g. `1-2`) for every status;
- `hasVideo`, `hasPdf`, `materialCount` computed over the **unredacted**
  descriptor list, so locked rows carry badges (booleans + a count — no
  URLs, no ids, no titles);
- every Phase 4 redaction kept: `videoUrl`, `pdfUrl`, `summary`,
  `description`, `quiz`, `homework`, `requirements` stay `locked ? null`,
  `materials` stays `locked ? []`. All Phase 4 split-count pins hold.

### 2.4 Lesson route (`GET /api/lessons/[id]`)

Serialises `officialCode`. Gates unchanged (`canAccessLesson`,
lifecycle/track/curriculum scoping, PUBLISHED-only prev/next).

### 2.5 Cached state sealed: bookmarks, notes, session videos

- **Bookmarks**: list filters to the visible curriculum + enrolled course;
  creation gates on `canStudentSeeLesson` (invisible → plain 404).
- **Notes**: note content (the student's own words) stays readable, but the
  attached lesson title redacts to `null` outside the visible curriculum;
  creation gates on `canStudentSeeLesson`.
- **Notes IDOR fix**: `PATCH` was scoped by note id alone — any student
  could rewrite any other student's note. It now verifies
  `(noteId, studentId)` ownership first.
- **Session videos**: optional `?lessonId=` narrowing filter under the full
  existing authorization (batch + published + track + linked-PUBLISHED).

### 2.6 Unified lesson page (`student-lesson.tsx`)

One coherent session: title/video/PDF/quiz/homework/progress **plus**
server-computed requirements checklist and linked batch recordings
(`?lessonId=`, opening in the recordings view — no content silo).
Denials render content-free skeletons: locked (`403
PREVIOUS_SESSION_INCOMPLETE`) vs not-available (`404`) vs not-enrolled.
Neither skeleton dereferences session content (pinned).

### 2.7 Deep-link landings

- Notifications with a well-formed link render **Open** (`student.247`);
  legacy/malformed links render no button. Opening marks the notification
  read and navigates; the view's fetch re-authorizes.
- `homework:<id>` highlights + scrolls to its row; `video:<id>` activates
  its recording; `quiz:`/`lesson:` ride the existing navParam fetches.

### 2.8 i18n

New keys in `DICT_2026` (hand-maintained catalogue): `course.214–218`,
`course.220–225`, `student.247–248` — all with non-empty AR + EN. New
markup uses logical properties only and responsive stacks (pinned).

## 3. What did NOT change (boundaries)

- Progression (`video ≥95%`, quiz attempted, assignment submitted) untouched;
  no second unlock algorithm (pinned by absence).
- No notification fan-out, no teacher/parent redesign, no Postgres, no
  Phase 20–22 work.
- Parent preview: same gates (lifecycle + track + course); unpublished
  stays denied.

## 4. Verification

- `tests/student-locked-curriculum-phase16.test.js` — **365 assertions**,
  all green: parser matrix, visibility matrix, fake-DB gate, skeleton vs
  redaction pins, cached-state pins, deep-link wiring pins, unified-page
  pins, no-second-engine pins, parent pins, i18n contract, RTL/mobile pins.
- Full regression: all 21 suites green (3 322 assertions total).
- Render verification: `npx tsx scripts/verify-phase16-render.mts` —
  **34/34** real-DOM assertions (AR/EN skeleton, locked/missing/full
  lesson, notification navigation, homework + recording landings).
- Typecheck: error set **identical to baseline** (23 pre-existing errors,
  all from the sandbox's missing Prisma engines — zero in touched files).
- Lint: identical to baseline on touched files; new modules clean.
- Build: `✓ Compiled successfully` (module graph validated); page-data
  collection stops at Prisma-client initialization — the documented
  sandbox limitation (see §5).

## 5. Sandbox limitations (must be re-run where reachable)

1. `prisma generate` — `binaries.prisma.sh` unreachable (TLS disconnect);
   no engines on disk, no Rust toolchain. Same wall Phase 9 recorded.
2. Real Chromium — Playwright CDN unreachable; `tests/visual/*` and the
   checklist below need a browser host.
3. Full `next build` page-data collection — blocked by (1).

## 6. Browser verification checklist (for a browser host)

Matrix: `AR/EN × RTL/LTR × mobile(390px)/desktop(1440px) ×
student/parent`.

- [ ] Student, AR mobile: course tree shows locked skeletons with `1-2`
      chips + فيديو/ملف badges; locked rows disabled with toast on tap.
- [ ] Student, EN desktop: same in LTR; badges read Video/PDF.
- [ ] Locked lesson via guessed URL → locked panel, no content, way home.
- [ ] Unpublished id via guessed URL → not-available panel (identical for
      foreign ids — no oracle).
- [ ] Full lesson: video + PDF + quiz + homework + requirements + recordings
      on one page; recording button lands on the recording, highlighted.
- [ ] Notification with `quiz:<id>` → Open → runner loads (authorized) or
      locked state (unauthorized) — never raw content.
- [ ] Stale link to an unpublished-then-published session behaves per its
      current lifecycle (re-authorized, never cached-open).
- [ ] Parent preview: child's track tree only; unpublished direct id → 404.
- [ ] No horizontal overflow on 390px in any new block; cards, sidebars,
      modals, material blocks, locked states intact in both directions.

## 7. Files changed

```
src/lib/curriculum-visibility.ts          (new)
src/lib/deep-link.ts                      (new)
src/app/api/courses/[slug]/route.ts
src/app/api/lessons/[id]/route.ts
src/app/api/students/me/bookmarks/route.ts
src/app/api/students/me/notes/route.ts
src/app/api/students/me/session-videos/route.ts
src/components/course/student-course.tsx
src/components/course/student-lesson.tsx
src/components/course/session-videos-view.tsx
src/components/student/student-dashboard.tsx
src/lib/i18n-dict-2026.ts
tests/student-locked-curriculum-phase16.test.js   (new)
scripts/verify-phase16-render.mts                 (new)
package.json / package-lock.json                  (jsdom devDependency)
```
