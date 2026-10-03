# Phase M2 — Admin Multilevel Browser QA Checklist

This checklist covers the M2 admin surfaces that can mix First Secondary and Second Secondary data. It is a human/browser checklist; automated evidence is in `tests/phase-m2-admin-multilevel.test.js` and the Phase K regression suites.

## Preconditions

- [ ] Run the app with a real admin account and a configured database.
- [ ] Have two courses with the same display name, one `FIRST_SECONDARY` and one `SECOND_SECONDARY`.
- [ ] Have Arabic and Language groups for each course, at least one teacher, and students in each track/level.
- [ ] Have at least 125 groups available to exercise catalogue pagination, and a group with more than 20 compatible/assigned students for dialog pagination.
- [ ] Have published lessons with the same `officialCode` at both academic levels.
- [ ] Keep the browser console and Network panel open. Any React error, hydration warning, unexpected 4xx/5xx, or request without the selected scope is a finding.

## 1. Progression override safety

- [ ] Open the override section for a grouped First Secondary student. The lesson request contains that student id; the response contains only the student's Group → Course lessons.
- [ ] Verify a lesson with the same official code at both levels is identified by level, code, title, and course context; selecting it preserves its canonical lesson id.
- [ ] Verify an ungrouped student or a student with no active course receives no grantable lesson list rather than an all-curriculum list.
- [ ] Grant and revoke an override. Confirm the audit row displays the canonical Course-derived level and does not rely on a conflicting legacy `Lesson.academicLevel` value.
- [ ] Attempt a foreign lesson id through the Network panel or request replay. Confirm the server refuses it and creates no override.

## 2. Groups and compatible students

- [ ] Open Groups. Search, Academic Level, Track, and Active filters narrow the server request; changing a filter returns to page 1.
- [ ] Page through 125 groups. Confirm page size is bounded, later pages are reachable, total/page metadata is truthful, and no group disappears after the first 100.
- [ ] Verify every group card and edit dialog shows the derived Course level and Track; no `SHARED` Group option appears.
- [ ] Open a group with more than 20 members. Search and page through the member list; remove a member and confirm the server-backed list refreshes.
- [ ] Search the compatible-student panel. Confirm eligible students beyond the first global page appear, only unassigned students with the target Group's Course level and Track are offered, and adding one refreshes both lists.
- [ ] Attempt an incompatible assignment through request replay. Confirm the server rejects it without changing either student or group.

## 3. Live Ops / Live Sessions

- [ ] Switch the Academic Level filter between All, First, and Second. Confirm sessions, KPIs, review queue, absence queue, and repeated-absence flags all change server-side.
- [ ] In a mixed-level group selector, confirm options show level plus group/course context. Selecting a group narrows the same level-aware data set.
- [ ] Schedule/reschedule a session and confirm the selected group remains level-labelled and the existing authorization/lifecycle behavior is unchanged.

## 4. Mock Exams and Question Bank

- [ ] In Mock Exams, switch Track and Academic Level independently. Confirm each combination sends both filters and returns only course-scoped exams/pools.
- [ ] Confirm every mock exam row shows its required Course and derived Academic Level. Verify create/edit still requires `courseId`; no level field is invented on MockExam.
- [ ] In Question Bank, apply Track without a level, a level without Track, and both together. Confirm filters compose rather than replacing each other.
- [ ] Confirm lesson-linked questions show the derived level; free-bank questions remain explicitly level-unspecified.
- [ ] In quiz evidence/review, verify the level filter is server-side and each attempt displays the lesson-derived level.

## 5. Courses, Students, and Overview

- [ ] In Courses, apply All/First/Second. Confirm the request includes the shared `academicLevel` contract and the returned course identity/level remains canonical.
- [ ] In Students, combine Academic Level, Track, Status, and search. Confirm counts and pages remain truthful and group choices are compatible with both canonical dimensions.
- [ ] On Overview, verify identical group/course names remain separated by Course id and Academic Level; upcoming sessions show group/course/level context.
- [ ] Verify the integrity card loads from `/api/admin/level-mismatches`, displays healthy and warning states, and offers read-only refresh only—no repair action.

## 6. Locale, accessibility, and regression

- [ ] Repeat the mixed-level checks in Arabic and English. Confirm the shared labels are `أولى ثانوي` / `ثانية ثانوي` and `First Secondary` / `Second Secondary`.
- [ ] Tab through filters, selectors, pagination controls, dialogs, and integrity refresh. Confirm visible focus, usable labels, Escape-to-close, and no clipped action row at a laptop viewport.
- [ ] Verify Admin-only endpoints refuse a non-admin; invalid academic-level values return 400 rather than widening to All.
- [ ] Run the automated M1/M2 and directly affected regression commands listed in the final report.

## Execution record

- **Automated checklist:** covered by `tests/phase-m2-admin-multilevel.test.js` (57 checks passed on 2026-10-03) and the Phase K/M1 regression suites.
- **Browser execution in this sandbox:** not completed. Playwright Chromium installation was blocked by the environment's network/TLS failure (`ECONNRESET`); no browser-pass claim is made here.
