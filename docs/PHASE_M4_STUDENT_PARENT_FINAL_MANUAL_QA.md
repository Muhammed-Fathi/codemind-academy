# Phase M4.6 — Student / Parent Multi-Level FINAL Manual QA Checklist

Executable browser checklist for the **visible M4.1–M4.5 Student flows** plus a short **Parent smoke**.
M4.1/M4.2 shipped with automated verification only and M4.3 was closed with a manual-QA waiver, so this
document exists to close those browser gaps **before** Phase M4 can be declared closed.

Harness rules: browser console + Network panel open; any React error, hydration warning, unexpected
4xx/5xx, or request whose scope does not match the screen is a FAIL. Capture one screenshot per numbered
check. Arabic (RTL) first, then the same screen in English (LTR).

## Preconditions (one adversarial fixture, same shape the automated suites use)

- [ ] Two courses with the **same display name**, one `FIRST_SECONDARY` and one `SECOND_SECONDARY`.
- [ ] Two lessons/units that share the **same title** and the **same printed `officialCode`**, one per level.
- [ ] Student S1: active group → **current course (level L, course C1)**, plus PASSED/attended history in a
      **previous course** (different level) and in a **third course at the same level as C1** with the same name.
- [ ] First Secondary course present: 1 Part / 13 Units / 62 Lessons. Second Secondary course: 2 Parts / 7 Units / 23 Lessons.
- [ ] A bookmark, a `lesson:` notification, a homework item and a dashboard lesson CTA that all point at the
      **same exact lesson id** of the current course.
- [ ] Parent P linked to S1 (and S2 if the multi-child fixture is available — see Waiver).
- [ ] Locale switch available in the shell; DevTools device toolbar preset 360 × 800.

## 1. Student checks (16)

| # | Surface | Steps | Expected result |
|---|---------|-------|-----------------|
| S1 | Dashboard header | Open Student dashboard. | Academic level label shows S1's canonical `Student.academicLevel` (`أولى ثانوي`/`First Secondary` or `ثانية ثانوي`/`Second Secondary`) **and** the current course name. The two agree with the Group → Course level — never two different levels, never "2nd Secondary" hard-coded for a First Secondary student. |
| S2 | Attendance / latest quiz / recent activity | Compare "الحضور / Attendance", "آخر امتحان / latest quiz" and "آخر النشاطات / recent activity" against the seed history. | No row, count or percentage from the previous course, the same-level sibling course, or the other level. Numbers match the current-course universe only. |
| S3 | Course → Lesson | Open My Courses → current course → lesson tree → click a specific lesson (note its title and printed code). | The opened lesson is the **exact clicked lesson** (same title, code, level badge); store/URL lesson id is the canonical id; a reload of the same view keeps that lesson (no fallback to the first lesson, no stale previous lesson). |
| S4 | Dashboard lesson CTA | Dashboard → "continue lesson" card → open. | Same exact lesson as the card advertises; nothing resets to lesson 1. |
| S5 | Homework lesson CTA | Dashboard → Homework list → "open lesson" on an item. | Opens that homework's lesson, not the last-visited one. |
| S6 | Notification deep link | Click a `lesson:<id>` notification in the bell panel. | The lesson view opens that lesson and the Network panel shows the request **for that lesson id**; locked lessons show the denial panel instead of a different lesson. |
| S7 | Bookmark → lesson | Bookmarks → open a saved lesson. | The bookmarked lesson opens (its own id), never the previously viewed lesson. |
| S8 | Official curriculum shape | Open the course tree for the First Secondary course, then the Second Secondary one. | Unit-first containers: First = 1 Part / 13 Units / 62 Lessons; Second = 2 Parts / 7 Units / 23 Lessons. No "Topic" row replaces or precedes the Unit level. |
| S9 | Legacy Topic fallback | Open a bookmark / curriculum row whose container is a legacy Topic while the same-titled Unit exists. | The canonical Unit container is displayed; the legacy Topic never overrides it, and two same-titled containers stay two separate rows (no merging by title). |
| S10 | Session Videos | Open Session Videos for S1. | Only the current course's sessions; each row shows the current level + course context. No previous-course session, no other-level session. |
| S11 | Mock Exams | Open Mock Exams for S1. | Only exams whose `courseId` is the current course; level + course shown per exam; previous-course exams do not appear or move averages. |
| S12 | Study Plan | Open the Study Plan; also replay a request with a foreign / out-of-universe lesson id. | Only in-universe, published, on-track lessons are offered; the replayed foreign id is rejected with no schedule row created. |
| S13 | Certificate | Open the certificate for S1 (and re-open it). | Shows the current level + course; the reference/serial is deterministic (same reference on reload), never a random per-render value. |
| S14 | Lifetime vs current-course labelling | Dashboard gamification block (XP / badges / streak) next to attendance % and quiz counts. | XP/badges/streak are labelled as academy-lifetime totals; attendance %, current-course lessons and current-course quiz/homework counts stay current-course scoped; a previous-course activity never moves the current-course numbers. |
| S15 | Locale + direction | Switch AR → EN → AR on the dashboard, lesson view, session videos, mock exams, certificate. | `<html dir>` follows the locale (rtl/ltr) with no blurred/mirrored layout; level vocabulary is `أولى ثانوي`/`ثانية ثانوي` in Arabic and `First Secondary`/`Second Secondary` in English; system chrome is fully localised, while lesson/unit titles stay in their authored language (no fake translation). |
| S16 | 360 px smoke | Device toolbar 360 × 800, AR then EN, on dashboard + lesson view + lists. | No page-wide horizontal overflow (body does not scroll sideways), no clipped CTA/table action, bell/panel usable. |

## 2. Parent smoke (short — 4 checks)

| # | Surface | Steps | Expected result |
|---|---------|-------|-----------------|
| P1 | Child identity/context | Open the parent portal; switch between linked children if the fixture exists. | Every card is titled with the **child's own identity**; a child with no active course shows the no-active-course state, not another child's numbers. |
| P2 | Level + course | On dashboard / analytics / weekly / monthly reports. | Each child card shows that child's level and course; siblings in different levels never share a universe, and no level leaks between cards. |
| P3 | English localisation (M4.5 fix) | Switch AR → EN after data has loaded. | System text (grades, progression reasons, month names, metric labels) re-renders in English **without a reload/new fetch**; no Arabic system string remains. Authored content (lesson title, teacher note) keeps its authored language. |
| P4 | 360 px overflow | Device toolbar 360 × 800 on parent dashboard + weekly report. | No page-wide horizontal overflow, no clipped metric tiles or week strip; weekly/day cells stay readable. |

## 3. Waivers and coverage notes

- **M4.3 multi-child browser verification: WAIVED.** If the two-children-in-different-levels fixture is not
  available in the environment, run P1/P2 on the single linked child and record the waiver — do **not** report
  multi-child browser coverage as tested.
- Attendance/quiz/homework numbers asserted by S2/S10/S11/S14 are backed by
  `tests/phase-m44-parent-metric-scope.test.js` (parent) and `tests/phase-m41-student-context-scope.test.js`
  (student); the browser pass is what those suites cannot prove.
- Lesson-open convergence (S3–S7) is pinned by `tests/phase-m42-student-content-flows.test.js` §A.
- Direction/vocabulary (S15) and overflow rules (S16/P4) are pinned by
  `tests/phase-m45-parent-i18n-responsive.test.js` and `tests/teacher-m34-i18n-responsive.test.js` patterns.

## Execution record

- **Automated evidence:** `tests/phase-m41…m45` + the M4.6 gate suites (see the Phase M4.6 report for the exact counts).
- **Browser execution:** _pending_ — fill in date, environment, per-check PASS/FAIL and screenshots.
  Any FAIL must name the check id, the exact screen, locale, viewport and the observed vs expected value.
