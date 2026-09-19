# Phase F — Manual QA Fix Round Report

Scope: the 11 findings raised by manual QA on the completed Phase F work.
This round is **fix-only**: no redesign, no schema change, no migration, no
weakening of any authorization or lifecycle rule.

Branch: `arena/01a0b7d1-codemind-academy` (continues the pushed Phase F tip
`94b7729`). No PR, no Neon, no production migration.

---

## 1. Findings — root cause and fix

### F1 — Admin Live Sessions teacher/group filters were raw ID inputs
*Root cause*: the two filter controls were `<Input placeholder="ID" />`, so an
operator had to type a cuid by hand; the filter matched nothing and looked
broken. Also no loading/empty/error state existed.
*Fix*: new shared `src/components/shared/entity-select.tsx` (Popover + Command,
searchable, RTL-aware, with loading skeleton, empty text and error-with-retry).
The Admin live-ops screen now selects the **teacher** and the **group** from the
authoritative `/api/admin/teachers` and `/api/admin/groups` lists. The value
sent to the API is still the internal id (`groupId` / `teacherId`) — the
filtering semantics are unchanged and a value can no longer be typed by hand, so
no client-supplied string can widen scope (the server re-filters anyway).
*Student Code (`CM-TNMRE6`) is intentionally untouched* — it is a platform
identifier, not a raw-ID defect.

### F2 — Sessions were not linked to a canonical Lesson
*Root cause*: `AdminScheduleDialog` never sent `lessonId`, so sessions carried
only a free-text title ("lesson 1 test") and had no academic identity.
*Fix*:
* Admin scheduling now **requires** a real Lesson, chosen from a list
  constrained to the selected group's course (`/api/admin/lessons?courseId=…`).
* Teacher scheduling already read the lesson list, but allowed `lessonId: null`
  and submitted a free-text title; it now requires the Lesson too (the list is
  the server-scoped `/api/teacher/lessons?groupId=…`).
* The free-text title survived as an **optional display override** only; it is
  never the academic identity, and leaving it blank makes the server derive the
  title from the Lesson (existing `buildSessionDraft` behaviour).
* New pure helpers `sessionLessonIdentity()` / `sessionDisplayOverride()`
  (`src/lib/live-session-policy.ts`) render `1-1 — <title>` from
  `Lesson.officialCode`; `officialCode` now travels in the session payload, and
  the Admin table, the Admin absence row, the Teacher workspace and the Student
  card all use the same helper. A legacy row with `lessonId = null` stays
  readable and is labelled "غير مرتبطة بدرس". No historical row was rewritten.
* Server-side validation was already in place (`LESSON_NOT_FOUND` 404,
  `LESSON_NOT_IN_GROUP_COURSE` 409) and is untouched — a forged body cannot
  attach a lesson from another course.

### F3 — A teacher could start a session before its scheduled time
*Root cause*: `startLiveSession()` flipped `SCHEDULED → LIVE` on the status
lattice alone. No time guard existed, so a session could be LIVE while its
attendance register was still `NOT_STARTED` (the register window is keyed to
`startAt`) — a self-contradictory state.
*Fix*: ONE new authority `decideSessionStart()` in the policy module.
**Rule: a session may go LIVE from its scheduled `startAt` until the attendance
window closes.** `startLiveSession()` now consults it *before* the status write
and refuses with `409 SESSION_START_TOO_EARLY` /
`SESSION_START_WINDOW_CLOSED`. Because the start window is a subset of the
attendance window, a startable session always has an open register — the QA
contradiction is impossible *by construction*. The join window is deliberately
still wider on the early side (students may settle in before the teacher may
start). The Teacher UI mirrors the rule (disabled button + visible reason) and
translates a server refusal into the same wording.
*The attendance window was NOT opened to "fix" this — the lifecycle authority
was fixed instead.*

### F4 — Join-window copy confused the configured rule with the remaining wait
*Root cause*: `session-link-actions.tsx` passed the **remaining wait** as `p1`
into `live.join.tooEarly`, whose copy states the **configured** window
("الرابط يفتح قبل الموعد بـ … دقيقة"), and the refusal toast hardcoded `p1: 15`.
*Fix*: the payload now carries `joinEarlyMinutes` (from the single server
authority `liveSessionJoinEarlyMinutes()`), and the component states two
distinct facts: the rule (`live.join.ruleEarly` → "يمكن الانضمام قبل الحصة بـ
15 دقيقة") and the wait (`live.join.waitsIn` → "يفتح رابط الحصة بعد 37 دقيقة",
`live.join.waitsInOne` for a single minute). No hardcoded 15 remains anywhere in
the join copy. Audit of the Admin / Teacher / Student / notification surfaces
found no other source of join-window copy.

### F5 — Finalize was disabled with no explanation
*Root cause*: `disabled={busy || (unmarked && !ack) || dirty}` with the reason
available only as a hover `title` (invisible on touch and to keyboard users).
*Fix*: one variable (`finalizeBlockedReason`) drives both the disabled state and
a visible, localized explanation: unsaved changes →
`teacher.live.finalizeNeedsSave` = **"احفظ تغييرات الحضور أولًا قبل تأكيد
الحضور."**, unmarked students → `teacher.live.finalizeNeedsAck`. The disabled
state stays safe and the finalized register stays locked.

### F6 — Mixed Arabic/English copy
*Fix*: `teacher.011` → "حصص الأسبوع ده", `teacher.020` → "حصص الأسبوع الجاي",
plus the sibling `teacher.008` / `teacher.021`. An audit of the new Phase F
teacher surfaces found no mixed copy (only intentional brand names —
Google Meet / Zoom / Microsoft Teams / `https`).

### F7 — "All Notifications" overflowed with no usable internal scroll
*Root cause*: Radix `ScrollArea`'s Root is `overflow-hidden`, so
`<ScrollArea className="max-h-80">` constrained the wrong element: the card grew
and the page scrolled, leaving the last rows and their actions unreachable.
*Fix*: the viewport is now bounded
(`max-h-[min(52dvh,calc(100dvh-22rem))] min-h-0 overscroll-contain`) with inner
`pb-1 pe-1`, matching the already-correct pattern used elsewhere. The shared
`notifications-panel.tsx` already had the correct bound and is unchanged. All
roles rendering this list are covered (it is the Admin notifications centre; the
shared panel serves Student/Teacher/Parent).

### F8 — Raw NotificationType enum names in the UI
*Root cause*: three `type.replace(/_/g, " ")` renders.
*Fix*: new pure module `src/lib/notification-labels.ts` maps **every** value of
the enum (all 21, not only the Phase F nine) to a dictionary key, with a generic
fallback so an unknown/legacy value can never leak the enum. The server
`live-session-notifications.ts` re-exports it (one authority, two import sites).
Arabic labels include ABSENCE_FINALIZED = "تم تسجيل الغياب",
ABSENCE_REASON_SUBMITTED = "تم إرسال عذر غياب", ABSENCE_EXCUSED = "تم قبول
العذر". No `replace(/_/g," ")` remains in `src/`.

### F9 — Parent Monthly Report rendered raw keys
*Root cause*: the local `generateRecommendations()` returns dictionary keys
(`parent.035`…`parent.042`) and the list rendered `{r}` verbatim.
*Fix*: the render site resolves through the dictionary (`{tr(r)}`) — the i18n
core never returns a dotted key, so a key is translated and an already-human
string passes through. The remaining hardcoded English labels inside the report
("Course Progress", "Quiz Average", "Subscription Status", "Strong Topics",
"Monthly Report — …") and the mixed-English recommendation copy were moved to
the dictionary (`parent.report.*`, Arabic-first). The weekly report and the
analytics view were audited: they already resolve all copy via `t()`.

### F10 — "حفظ كـ PDF" produced a blank PDF
*Mechanism*: `window.print()` + print CSS.
*Root cause*: `.print-report` was nested **inside** the `.no-print` toolbar
overlay, and `@media print` hides that ancestor with `display: none !important`.
A `visibility: visible` descendant can never come back from a `display: none`
ancestor, so every page printed empty.
*Fix*: the report body was extracted into one `ReportBody` component and the
printable copy is now **portaled straight into `<body>`** — outside every
wrapper that hides, scrolls or clips — and while printing it is the only
laid-out body child (`body > *:not(.cm-print-portal) { display: none }`). It
therefore flows normally and paginates instead of being cut at one viewport.
`print-color-adjust: exact` keeps the emerald header and cards readable on
paper; `break-inside: avoid` on rows/items plus `display: table-header-group`
give sensible page breaks; the `@media print` block survives RTL unchanged. The
on-screen copy is untouched (same component, same test ids), so the
server-rendered markup is unchanged. No dependency (html2canvas/jsPDF) was
added — the fix is the DOM structure, not a new library.

### F11 — Parent notification entry was visually inconsistent
*Root cause*: the parent header's bell button opened notification
**preferences** (not notifications), the label was a bare "parent.053", and the
sibling quick actions were hardcoded English in an Arabic-first dashboard.
*Fix*: the bell is now a real notifications entry that opens the **shared**
`NotificationsPanel` and carries a live unread badge (mount + the
`cm:notifications-changed` event, no polling loop); preferences moved to its own
clearly-labelled `Settings2` control. All quick actions are localized
(`parent.action.*`). No Parent-only notification system was introduced.

---

## 2. Schema / migrations

**None.** The fix round changed no Prisma model and no migration; `lessonId`
already existed on `LiveSession` and was already validated. SQLite and
PostgreSQL migration SHA-256 pins are unchanged, `make-postgres-schema.mjs
--check` reports both schemas in sync, and the Phase F migrations were not
touched.

## 3. Automated verification

* Phase F suite: **336 passed / 0 failed** (was 221). Section G (49–66) adds
  the 17+ required assertions: selector contracts, mandatory canonical Lesson,
  early-start refusal (policy + server + no bypass), consistency between
  lifecycle and attendance, join-window copy distinction, finalize reason, no
  mixed copy, bounded notification scroll, no raw enum, no raw report keys,
  PDF content contract, shared Parent notification surface, absence flow
  unchanged, and accepted absence never touching progression.
* Regression battery: **31 green / 3 red**.
  * The 3 reds are pre-existing and byte-identical on clean `1bda6d1`:
    `session-notifications-phase17` (319/2 — the §K real-DB verifier),
    `final-integration-phase22` (`ENOENT …/backups`), `phase26c-admin-full-flow`
    (81 pass / 5 fail — the same `ADMIN-17-real-b…f`).
    All three were re-run in a clean worktree of `1bda6d1` and produced the same
    signatures — Phase F and this round change none of them.
  * `npx tsc --noEmit` → exit 0.
  * `npm run build:postgres` (with `SKIP_PRODUCTION_ENV_CHECK=1` + local engine
    stubs) → build succeeded; the SQLite Prisma client was regenerated
    afterwards and the suite re-verified.
  * `verify-phase-f-pg-parity.mjs` → `PHASE_F_PG_CATALOG_IDENTICAL_OK`.

## 4. Manual re-verification (focused, 12 items)

1. Admin Live Sessions — teacher/group are searchable selectors (no ID typing).
2. Admin scheduling — choose group → lesson list is that group's course, option
   shows `1-1 — <title>`; blank title is allowed and the session shows the
   canonical identity in the table.
3. Teacher start before the scheduled time — refused, with the reason on screen.
4. Teacher start at/after the scheduled time — succeeds, register writable.
5. Join-window copy — the rule ("يمكن الانضمام قبل الحصة بـ 15 دقيقة") and the
   wait ("يفتح رابط الحصة بعد 37 دقيقة") are both correct and distinct.
6. Finalize with unsaved attendance — blocked with the Arabic reason visible;
   after saving it becomes available.
7. Teacher copy — "حصص الأسبوع الجاي" (no mixed English).
8. All Notifications — bounded scroll, last row and its actions reachable.
9. Notification labels — Arabic labels for all nine Phase F types.
10. Parent Monthly Report — no `parent.0xx` keys; Arabic-first copy.
11. Parent PDF export — "حفظ كـ PDF" contains the whole report (header, student
    details, metrics, topics, quizzes, notes, recommendations), RTL correct, no
    blank first page, readable colors.
12. Parent notification entry — clean bell + label + unread badge, opens the
    shared panel; preferences are a separate control.

## 5. CI workflow

`.github/workflows/pg17-full-chain-reference.yml` remains untouched (the Agent
token has no `workflows` permission). The pending patch is still stored **outside
the repository** at `/home/user/phase-f-workflow-ci.patch` and must be applied by
a workflow-capable identity. Migration verification was not downgraded: local
PostgreSQL parity is green.

**READY FOR LOCAL RE-VERIFICATION**
