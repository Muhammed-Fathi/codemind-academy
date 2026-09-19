# Phase F — Live-Session Lifecycle, Attendance Lock & Absence Review

> **Status:** implemented on branch `arena/01a0b7d1-codemind-academy` · **Type:** feature
> (cross-role: teacher + student + parent + admin) · **Migration:** additive
> (`20260919120000_phase_f_live_session_lifecycle`, SQLite + PostgreSQL) · **Enforcement of
> absence holds is deliberately NOT in this phase (Phase H).**

Phase F turns the platform's existing `LiveSession` row into a first-class **scheduled live
event** with its own lifecycle, its own authorization model, a server-side attendance window, an
immutable-with-correction attendance record, and an administrative **absence-review** workflow
that ends in an explicit `EXCUSED` / `UNEXCUSED` decision plus an `AbsenceHold` **state** whose
enforcement belongs to Phase H.

The full journey now exists end to end:

```
Lesson (academic)                 LiveSession (scheduled event)
Course → Part → Unit → Lesson  ─►  Teacher + Group + start/end + meeting link
                                        │
                                        ├─ student: upcoming session + Join window + link actions
                                        ├─ teacher: roster, marks, counter, "تأكيد الحضور"
                                        ├─ lock: attendance immutable, history readable
                                        ├─ absence: finalized ABSENT → case → reason → review
                                        ├─ decision: EXCUSED / UNEXCUSED (+ optional note)
                                        └─ hold: ACTIVE / RESOLVED  → consumed by Phase H
```

---

## 1. Discovery (what already existed — and what did not)

Phase F was implemented **after** a mandatory discovery pass over the shipping code. Findings:

| Area | Pre-Phase-F reality | Phase F decision |
|---|---|---|
| `LiveSession` model | Existed since Phase 13 (`groupId`, `teacherId`, `lessonId`, `title/titleAr`, `startAt`, `duration`, `status`, `meetingUrl`, `recordingUrl`, `notes`, `createdAt`) | **Extend it.** No second session concept was invented. |
| `SessionStatus` enum | `SCHEDULED`, `LIVE`, `COMPLETED`, `CANCELLED` | **Reused.** No `RESCHEDULED` value added (see §4.4). |
| `Attendance` | `(studentId, sessionId)` unique, `status` ∈ `AttendanceStatus`, `note` | **Extended** with `markedByUserId` / `markedAt`; **UNMARKED stays "no row"** (see §5.2). |
| Session creation routes | **None.** Teachers could see sessions (`/api/teacher/sessions`) and take attendance (`/api/teacher/attendance`) but nothing could create a session from the UI — the table was seeded/operated directly. | New `/api/live-sessions` write surface for Admin + scoped Teacher. |
| Notification framework | Phase 17 `Notification` + `NotificationPreference` + per-user fan-out, `link` deep-link strings (`lesson:`/`quiz:`/`homework:`/`video:`) | **Reused** (no parallel framework). Added `sessionId` + `dedupeKey` and 9 `NotificationType` values. |
| Deep links | `DEEP_LINK_KINDS` = 4 kinds, single student-first target map | Extended to **6 kinds** (`live`, `absence`) with role resolution. |
| Absence concept | Nothing. `AttendanceStatus.EXCUSED` existed as a *mark*, which conflated the teacher's fact with the academy's decision. | New `AbsenceReview` (administrative interpretation) + `AbsenceReasonSubmission` + `AbsenceHold`. |
| Attendance corrections | Nothing. A teacher could overwrite an attendance row at any time. | New append-only `AttendanceCorrection`, admin-only, mandatory reason. |
| Calendar | `student-scheduler`, `teacher-attendance`, `admin-sessions` views with partial schedule data | **One** upcoming-session authority (§6) + a unified upcoming list per role; no third calendar engine. |
| Audit | `AuditLog` with `action`/`entity`/`entityId`/`metadata` | Reused for every Phase F ceremony (§12). |

**Consequence that shaped the design:** because no admin session CRUD existed, Phase F is the
first writer of `LiveSession`. Every route therefore had to *establish* the authorization model
rather than inherit one, and the legacy teacher attendance route had to keep working for the
screens that already used it (it now returns the same keys **plus** an additive `session` block).

---

## 2. Identity and authorities

### 2.1 Canonical identity (unchanged)

```
Course → Part → Unit → Lesson          (academic content; LessonStatus; progression)
LiveSession                            (scheduled event; SessionStatus; attendance)
```

`Lesson` and `LiveSession` are **separate models and stay separate**. One Lesson has many
LiveSessions (original + make-up), a LiveSession may exist without a Lesson (legacy/extra class),
and a LiveSession may be cancelled while the Lesson remains perfectly teachable.

### 2.2 Who may do what

| Action | Admin | Teacher (own scope) | Substitute (session-scoped) | Student | Parent |
|---|---|---|---|---|---|
| Create LiveSession | ✅ | ✅ only when the Lesson is inside `Group.courseId` of a group they **own** | ❌ | ❌ | ❌ |
| Read session | ✅ | own + substituted | own (that session) | own group only | linked children only |
| Edit timing/link | ✅ | before start, own scope | within the session window | ❌ | ❌ |
| Cancel | ✅ | own scope | ❌ | ❌ | ❌ |
| Reschedule | ✅ | own scope | ❌ | ❌ | ❌ |
| Assign substitute | ✅ **only** | ❌ | ❌ | ❌ | ❌ |
| Take attendance | ✅ (correction path) | ✅ in window | ✅ in window | ❌ | ❌ |
| Finalize attendance | ✅ | ✅ in window | ✅ in window | ❌ | ❌ |
| Correct locked attendance | ✅ **only** | ❌ (403) | ❌ | ❌ | ❌ |
| Submit absence reason | ✅ | ❌ | ❌ | ✅ own | ✅ linked child |
| Excuse / Unexcuse | ✅ **only** | ❌ | ❌ | ❌ (403 + audit) | ❌ |
| Resolve hold | ✅ only | ❌ | ❌ | ❌ | ❌ |

**Client-supplied identifiers never expand scope.** A `teacherId`, `courseId`, `groupId` or
`sessionId` in a request body is treated as *data*, never as authority: the request's identity
comes from the session cookie, and the row's scope is resolved server-side. A session outside the
caller's scope returns **404** (not 403) so the endpoint cannot be used to enumerate ids.

Where does the teacher's scope come from? `Teacher.groups` → `Group.courseId` → the Lesson must
belong to that course (`loadSessionForTeacher`, `src/lib/live-sessions.ts`). A teacher with no
group sees an empty schedule, not the whole platform.

---

## 3. Schema (additive, no resets)

One migration, applied on both providers:
`20260919120000_phase_f_live_session_lifecycle`.

**`LiveSession` (+18 columns)** — `createdByUserId`, `statusChangedAt`, `statusChangedByUserId`,
`conductedAt`, `endedAt`, `cancelledAt`, `cancelledByUserId`, `cancelReason`, `rescheduleCount`
(`NOT NULL DEFAULT 0`), `lastRescheduledAt`, `rescheduledByUserId`, `originalStartAt`,
`substituteTeacherId`, `substituteAssignedAt`, `substituteAssignedByUserId`,
`attendanceFinalizedAt`, `attendanceFinalizedByUserId`, `updatedAt`; indexes
`[teacherId, startAt]`, `[substituteTeacherId]`, `[status, startAt]`.

**`Attendance` (+3 columns)** — `markedByUserId`, `markedAt`, `updatedAt`.

**`Notification` (+2 columns)** — `sessionId`, `dedupeKey`; unique `[userId, dedupeKey]`.

**New tables** — `AttendanceCorrection`, `AbsenceReview`, `AbsenceReasonSubmission`, `AbsenceHold`.

**New enums** — `AbsenceReviewStatus`, `AbsenceHoldStatus`. **`NotificationType`** gained 9 values.

Notes that matter for operations:

* **No backfill is required.** Every new column is nullable or has a constant default; existing
  production rows are valid the instant the migration lands. `originalStartAt` stays NULL for
  pre-Phase-F sessions (it means "never rescheduled", and the read path falls back to `startAt`).
* **`prisma/postgres/migrations/0_init` is frozen** — the PostgreSQL edition of Phase F is a new
  directory, and `scripts/db/make-postgres-schema.mjs --check` fails the build on any drift.
* **One pre-existing divergence was closed additively:** `Attendance` has declared
  `@@index([sessionId])` since Phase 13, but neither the historical SQLite migrations nor the
  frozen PostgreSQL baseline ever created it. The Phase F migration adds it with
  `CREATE INDEX IF NOT EXISTS` in both providers (verified: it is the *only* structural difference
  the parity check found).
* **Documented provider asymmetry:** PostgreSQL also creates `LiveSession_substituteTeacherId_fkey`
  via `ALTER TABLE … ADD CONSTRAINT`. SQLite can only attach a foreign key by rebuilding
  `LiveSession`, which this migration deliberately does not do (production rows are referenced by
  `Attendance`, `SessionPublication`, …). On SQLite the substitute remains an indexed plain
  column; the constraint lives on the production provider. The asymmetry is asserted in
  `tests/migration-providers.test.js` (A5b) and printed by the parity script.
* **No `UNMARKED` enum value was added.** Expressing "not yet marked" as a stored status would
  eventually let the platform read it as `ABSENT`. It stays "no row", and the read path derives it
  (`rosterStatusOf`, `RosterStatusValue` in `src/lib/live-session-policy.ts`).

---

## 4. Lifecycle

### 4.1 States

`SCHEDULED → LIVE → COMPLETED`, or `SCHEDULED|LIVE → CANCELLED`. Transitions are enforced by
`canTransitionSession`; anything else is refused with `ILLEGAL_TRANSITION`. Terminal states are
`COMPLETED` and `CANCELLED`.

**`ENDED` is `COMPLETED`.** The task allowed "prefer the existing enum"; the existing enum already
had `COMPLETED`, so no value was added. The *phase* the UI shows (`UPCOMING` / `LIVE` / `ENDED` /
`CANCELLED`) is derived (`deriveSessionPhase`) — a session whose time has passed but which was
never finalized still reads as `ENDED`, and only the review state (§5.4) reveals that its register
is incomplete.

### 4.2 End time is derived

`endsAt = startAt + duration` minutes (`sessionEndsAt`). `duration` is never allowed to be 0 or
null on the read path: `sessionDurationMinutes` falls back to
`LIVE_SESSION_DEFAULT_DURATION_MINUTES = 120`. A stored end timestamp would be a second source of
truth for the attendance lock and the join window, so it is not stored.

### 4.3 Windows (one authority, configurable)

| Window | Default | Env override | Notes |
|---|---|---|---|
| Join opens | start − 15 min | `LIVE_SESSION_JOIN_EARLY_MINUTES` (max 240) | Before that: `TOO_EARLY` |
| Join closes | scheduled end | — | After: `SESSION_ENDED`; the link is then history |
| Attendance opens | `startAt` | — | Before: read-only (`NOT_STARTED`) |
| Attendance closes | scheduled end + 15 min | `LIVE_SESSION_ATTENDANCE_GRACE_MINUTES` (max 120) | After: `WINDOW_CLOSED` |

The grace period exists because a teacher marking the register at the moment class ends is normal;
it is centralized in `liveSessionWindows()` and used by the API, the teacher UI and the tests.

### 4.4 Rescheduling keeps history

A reschedule (`POST /api/live-sessions/[id]/reschedule`) updates `startAt` and appends to the
reschedule trail:

* `originalStartAt` records the **first** scheduled instant and is never overwritten by a second
  reschedule (a `PATCH` of `startAt` sets it only if it is still NULL);
* `rescheduleCount` increments, `lastRescheduledAt` / `rescheduledByUserId` are stamped;
* an `AuditLog` row carries the previous instant;
* **no status change**: a rescheduled session is still `SCHEDULED`. A `RESCHEDULED` status would
  make "is it live? cancellable? attendance-able?" ambiguous and would force every reader to treat
  two states as one. "It was rescheduled" is an *event*, and events live in the trail.

Students (and parents where appropriate) are notified (§9).

### 4.5 Cancellation never penalizes

`POST /api/live-sessions/[id]/cancel`:

* sets `CANCELLED` + `cancelledAt` / `cancelledByUserId` / `cancelReason`;
* **creates no attendance rows and no absence cases.** A cancelled session can never produce an
  `ABSENT` record, an `AbsenceReview`, or a hold;
* the join endpoint refuses with `SESSION_CANCELLED`;
* the attendance endpoint refuses writes with `SESSION_CANCELLED` (reads still work);
* students/parents are notified; the session stays visible in history.

### 4.6 Teacher no-show

If the class window closes with **no** `conductedAt` and **no** attendance marks, the session is
flagged `TEACHER_NO_SHOW`. Phase F **never invents student absences** from a missing teacher
action — the flag goes to the admin queue as an operational item ("the register was never
started"), not as 30 absent students. If the teacher *did* start the class (or marked at least one
student) but never finalized, the state is `ATTENDANCE_INCOMPLETE`: some students are marked, some
are not, and an admin decides. Both states appear in the admin live-operations console.

### 4.7 Make-up sessions

A make-up is an ordinary new `LiveSession` referencing the **same Lesson + Group** with its own
time. The original session's history and its attendance facts are untouched, and no progression
exception is created: the make-up is an event, not an academic bypass.

---

## 5. Attendance

### 5.1 The roster is derived server-side, always

`loadSessionRoster` resolves the roster from `LiveSession.groupId → Group students`. A client
never supplies the list of students; a client-supplied student id that is not in the group is
refused. This is the same rule for the teacher workspace, the API and the verifier.

### 5.2 Marks

`PRESENT` / `LATE` / `ABSENT` (+ the legacy `EXCUSED` **mark**, retained for compatibility — the
administrative `EXCUSED` lives in `AbsenceReview`). `UNMARKED` is the absence of a row and is
rendered as "لم يُسجَّل" — it is **never** counted as absent and never triggers the absence
workflow.

### 5.3 Finalization is explicit and quantified

`POST /api/live-sessions/[id]/attendance/finalize`:

* shows and requires acknowledgement of the true count — the UI displays **"28 / 30 طالباً
  تم تسجيلهم"** and the server returns the same numbers;
* refuses with **409 `UNMARKED_REMAIN`** while any roster member is unmarked, unless the caller
  sends `acknowledgeUnmarked: true`;
* **never writes `ABSENT` for an unmarked student** (that is the whole point of the ack — it
  records "I am finishing with unmarked students", not "they were absent");
* when acknowledgement is given with unmarked students remaining, the session is finalized **and**
  flagged `ATTENDANCE_INCOMPLETE` so the admin queue sees it;
* is idempotent: a second call returns the same finalized state instead of double-emitting
  notifications;
* stamps `attendanceFinalizedAt` / `attendanceFinalizedByUserId` and writes an `AuditLog` row.

**Why acknowledgement rather than a hard block?** A register with a genuine gap (a student who
transferred mid-term, a data error) must not be impossible to close. The safer behavior was
chosen deliberately: *block by default, allow only with an explicit, audited acknowledgement, and
then flag the session for admin review.* The alternative (allowing finalize silently) would let
"the teacher forgot" produce absence cases.

### 5.4 Review state lattice

`deriveSessionReviewState(session, counts, now)` returns exactly one of:

```
NOT_DUE            ── class has not started
ATTENDANCE_OPEN    ── inside the marking window
AWAITING_TEACHER   ── class is over, register window still open
  ↓ (window closed)
ATTENDANCE_INCOMPLETE  ── started/marked, but unmarked students remain
TEACHER_NO_SHOW        ── never started, no marks
FINALIZED              ── finalized with a complete register
CANCELLED              ── always cancelled, regardless of anything else
```

`ATTENDANCE_INCOMPLETE` is also the state of a *finalized* session that acknowledged unmarked
students — administrative follow-up is expected, and the session must not look clean.

### 5.5 The lock

After `attendanceFinalizedAt`, attendance is **immutable to teachers** (`ALREADY_FINALIZED`) and
readable forever. The teacher UI becomes read-only and says so; the API refuses the write. A
teacher can never gain the correction capability (§7). The lock is server-side: bypassing the UI
changes nothing.

---

## 6. One upcoming-session authority

`listUpcomingSessions` / `toLiveSessionPayload` (`src/lib/live-sessions.ts`) is the single
authority every surface reads:

| Role | Sees |
|---|---|
| Student | title + Lesson identity, date, start–end, teacher name, status, Join/Copy actions, reason when the join is closed |
| Teacher | sessions + group + lesson + timing + link + attendance state (marked/unmarked counter, finalize state) |
| Admin | sessions + teacher + group + timing + conducted/completion + review state + repeated-absence flags |

The student join decision is computed by `decideJoin`, which returns
`SESSION_CANCELLED | LINK_NOT_SET | TOO_EARLY | SESSION_ENDED` or allows. **The link itself is
served only by `GET/POST /api/live-sessions/[id]/join` under authorization** — a student can never
obtain another group's URL from a list endpoint, and a UI bypass changes nothing.

**Calendar deferral:** the platform already had a student scheduler, a teacher attendance screen
and admin sessions. Phase F ships **one** unified upcoming/schedule list per role backed by the one
authority above and documents the rest as deferred (no third calendar engine was built). The
legacy views keep working; where they show schedule data they now link to the Phase F surface.

---

## 7. Admin correction (post-lock)

`POST /api/live-sessions/[id]/attendance/correction` — **ADMIN only** (a teacher receives 403 and
the test suite pins it):

* requires `studentId`, `newStatus`, and a **mandatory reason**;
* records previous status, new status, reason, correcting admin identity and timestamp in
  `AttendanceCorrection` (append-only: there is no update and no delete route);
* writes an `AuditLog` row;
* if the corrected row was `ABSENT` and had an open absence case, the case is closed as
  `NO_ACTION_REQUIRED` (never silently relabelled `EXCUSED`) and its hold is `RESOLVED`;
* if the correction *creates* an absence after the fact, the case materializes like any other.

No silent history edits are possible: the fact (`Attendance`) and the trail
(`AttendanceCorrection`) are different tables.

---

## 8. Absence workflow

### 8.1 Input — locked absences only

Cases are materialized only from **finalized** `Attendance.status = ABSENT`
(`materializeAbsenceCases`). A temporary `ABSENT` clicked while the register is still editable
creates nothing. `AbsenceReview.attendanceId` is **UNIQUE**, which is the database-level
idempotency key of the whole workflow.

### 8.2 States

```
PENDING_REASON  ── nobody submitted a reason yet
PENDING_REVIEW  ── a reason exists; an admin must decide
EXCUSED         ── accepted (no hold)
UNEXCUSED       ── refused  (ACTIVE hold)
NO_ACTION_REQUIRED ── superseded (e.g. the attendance row was corrected), never presented as a
                      judgement about the student
```

The **attendance fact** (`Attendance.status`) and the **administrative interpretation**
(`AbsenceReview.status`) are separate rows in separate tables. Deciding a case never rewrites the
attendance record.

### 8.3 Reason submission

`POST /api/absence-reviews/[id]/reason` — **the student OR a linked parent** may submit free text
(3…1000 chars). There are no uploads (the platform has no absence-attachment storage; inventing one
was out of scope). Rules:

* only from `PENDING_REASON` / `PENDING_REVIEW` (`canSubmitReason`);
* after a decision the endpoint returns **409 `ABSENCE_ALREADY_DECIDED`**;
* every submission is appended to `AbsenceReasonSubmission` (previous text is never destroyed),
  while `AbsenceReview.reason*` mirrors the newest one for cheap reads → full **traceability on
  replacement**;
* admins are notified (`ABSENCE_REASON_SUBMITTED`, idempotent per case + revision);
* the submitting user and their role are recorded.

### 8.4 Decision

`POST /api/absence-reviews/[id]/decision` — **ADMIN only**:

* `EXCUSE` → `EXCUSED`, no hold, hold state `RESOLVED` if one existed;
* `UNEXCUSE` → `UNEXCUSED`, an `AbsenceHold` is created (`ACTIVE`);
* optional note (≤1000 chars); deciding admin + timestamp recorded; `AuditLog` written;
* the student and the linked parents are notified (`ABSENCE_EXCUSED` / `ABSENCE_UNEXCUSED`);
* **`EXCUSED` does not unlock the next academic Lesson and does not complete any academics.** It is
  an administrative decision about the absence; progression stays exactly where Phase D/16 left it.
  Phase H is where catch-up access and enforcement are designed.

### 8.5 Queue and filters

`GET /api/absence-reviews` (owner-scoped: student sees own, parent sees children, admin sees all)
with filters `pendingReason`, `pendingReview`, `excused`, `unexcused`, `studentId`, `groupId`,
`teacherId`, `from`/`to`, `sessionId`. Each row carries student, session, lesson, group, teacher,
date/time, attendance status, reason, submitter (user + role) and review state — **display names,
never raw ids or enum codes** (the label helpers in `absence-policy.ts` +
`live-session-policy.ts` map every value).

### 8.6 Repeated-absence signal (non-punitive)

`evaluateRepeatedAbsence` flags ≥ **3 finalized ABSENT in 30 days** (both configurable via
`REPEATED_ABSENCE_THRESHOLD` / `REPEATED_ABSENCE_WINDOW_DAYS`). The flag is **factual counts only**
shown to admins in the live-ops console. There is **no auto-ban, no suspension, no
unenrollment** — the platform never punishes automatically.

### 8.7 Hold semantics (and what Phase F deliberately does not do)

`AbsenceHold` is created / managed / resolved in Phase F, exposed to authorized consumers, notified
and audited. **Phase F does not enforce it**: no progression gate, no content lock, no join block,
no recording gate. `ACTIVE` means "an unexcused absence exists and Phase H will act on it";
`RESOLVED` means the review closed (excused, corrected, or manually resolved by an admin).

---

## 9. Notifications

Reuses the Phase 17 framework — no second dispatcher. Nine event types:

| Type | Audience | Preference | Idempotency key |
|---|---|---|---|
| `SESSION_SCHEDULED` | group students | `upcomingSession` + quiet hours | `SESSION_SCHEDULED:{sessionId}` |
| `SESSION_LINK` | group students | `upcomingSession` + quiet hours | `SESSION_LINK:{sessionId}:{revision}` |
| `SESSION_RESCHEDULED` | students (+ parents) | `upcomingSession` + quiet hours | `SESSION_RESCHEDULED:{sessionId}:{revision}` |
| `SESSION_CANCELLED` | students (+ parents) | `upcomingSession` + quiet hours | `SESSION_CANCELLED:{sessionId}` |
| `ABSENCE_FINALIZED` | student + linked parents | **mandatory** | `ABSENCE_FINALIZED:{attendanceId}` |
| `ABSENCE_REASON_SUBMITTED` | admins | **mandatory** | `ABSENCE_REASON_SUBMITTED:{reviewId}:{submissionId}` |
| `ABSENCE_EXCUSED` | student + parents | **mandatory** | `ABSENCE_EXCUSED:{reviewId}` |
| `ABSENCE_UNEXCUSED` | student + parents | **mandatory** | `ABSENCE_UNEXCUSED:{reviewId}` |
| `ABSENCE_REMINDER` | student + parents | **mandatory** | `ABSENCE_REMINDER:{reviewId}:{yyyy-mm-dd}` |

Rules:

* **Recipients are resolved server-side** (`sessionStudentUserIds`, `parentUserIdsForStudents`,
  `adminUserIds`) — never from the request body. Unrelated teachers/parents/students receive
  nothing.
* **Idempotent by construction.** `insertNotificationOnce` relies on the unique
  `(userId, dedupeKey)`; a retried request, a double-submitted form or a re-run fan-out inserts
  once and reports the rest as skipped. Pre-Phase-F rows keep `dedupeKey = NULL` and are unaffected
  (SQL treats NULLs as distinct).
* **The meeting URL is never stored in a notification.** `Notification.link` carries a deep link
  minted by `mintNotificationLink("live" | "absence", id)`; the client resolves the actual URL
  through the authorized join endpoint when the student clicks **"انضم للحصة"**. **"نسخ الرابط"**
  copies the URL returned by that same endpoint, so a user who cannot join also cannot copy.
* The **session-link notification is structured**, not plain text: it carries `sessionId` and the
  panel renders `SessionLinkActions` (Join / Copy) with a disabled reason ("يبدأ الانضمام قبل
  الحصة بـ 15 دقيقة") instead of a dead button.

---

## 10. Parent role

A linked parent may: see the absence, submit a reason, and see the review state. A parent may
**not**: change attendance, excuse an absence, resolve a hold, or unlock content (all refused
server-side with 403 and audited as an authorization failure). Parents receive the finalized-absence,
decision and reminder notifications. Parent visibility is limited to their own linked children
(`parentChildIds`), enforced in the query, not the UI.

---

## 11. UI/UX

Arabic-first, RTL, design-system components, no raw ids/enum codes.

* **Teacher workspace** (`teacher-live-sessions`): upcoming + live + ended, roster with search,
  Present/Late/Absent buttons, an explicit and confirmed **"تسجيل الجميع حاضرين"** bulk action,
  visible unsaved state, a live **completion counter**, and an explicit
  **"تأكيد الحضور"** confirmation showing `28 / 30`. Read-only after lock with the reason shown.
* **Student** (`student-sessions`): the upcoming list with Join/Copy, a disabled state with its
  reason outside the window, and ended sessions in history.
* **Student/parent absences** (`student-absences`, `parent-absences`): the case, the reason form,
  and the review state — no attendance editing.
* **Admin live-ops** (`admin-live-sessions`, 4 tabs + 5 dialogs): today's sessions, upcoming,
  unfinalized attendance, absences pending review, cancelled/rescheduled, repeated-absence flags,
  and the correction/review ceremonies with mandatory-reason forms.
* Every Phase F dialog is bounded (`max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col` with an
  inner `overflow-y-auto overscroll-contain`), so no bottom action is ever clipped.
* Loading / empty / error / success / disabled states exist on every fetch; the shared
  `use-json` hook surfaces them.

### 11.1 Bug T — "All Notifications" vertical scroll (explicit fix)

**Symptom:** the "كل الإشعارات" (All Notifications) surface could not be scrolled to the bottom;
the last rows and their actions were unreachable, and the page body scrolled instead.

**Root cause:** the shared `ScrollArea` root is `overflow-hidden`, and the Radix *Viewport* is the
real scroller. The previous class bounded nothing meaningful once the panel grew, so the content
overflowed the viewport while the outer list could not scroll.

**Fix:** the root of the shared notifications panel is bounded
(`max-h-[min(60dvh,calc(100dvh-15rem))] min-h-0 overscroll-contain`) with inner padding so the last
row and its action buttons are reachable; the admin dashboard's "Recent Notifications" panel gets
the same treatment (`max-h-[min(52dvh,calc(100dvh-22rem))]`). Bare `70vh` was avoided on purpose
because on short laptop screens it overflows; `dvh` + a `calc()` ceiling keeps the region inside
the viewport.

**Surfaces audited:** shared notifications panel (all roles), admin dashboard notifications block,
Phase F views and dialogs, and both raw notification lists in the admin dashboard (kept as
`max-h-[70vh] overflow-auto` because they are plain divs, not ScrollAreas). The Phase F suite pins
the classes (`tests/phase-f-live-sessions.test.js` §43) so the regression cannot come back silently.

---

## 12. Audit

Every ceremony writes an `AuditLog` row with actor, action, entity and a metadata payload:
LiveSession creation, reschedule (previous instant), cancellation, substitute assignment,
meeting-link change, attendance finalization, admin attendance correction, absence reason
submission, `EXCUSED`/`UNEXCUSED` decision, hold creation and hold resolution.

---

## 13. Deferred to Phase H (explicitly out of scope here)

* Enforcing an `ACTIVE` hold (next-Lesson gate, future live-session link gate, recordings gate).
* Catch-up access for the missed session.
* `SessionVideo` 95 % integration and any content-unlock semantics.
* Homework/quiz progression policy changes and admin manual unlock.
* Family/historical absence analytics and weekly/monthly summaries (Phase I).
* Final E2E, hardening and ops review (Phase J).

Phase F stops at producing, exposing and auditing the **state**.

---

## 14. Migration operations

1. `node scripts/db/make-postgres-schema.mjs` (regenerates the PG schema + baseline) and
   `--check` must pass.
2. `node scripts/db/verify-phase-f-pg-parity.mjs` — proves the PostgreSQL chain
   (`0_init` + Phase 26D + Phase F) is catalog-identical to the generated baseline: columns, enum
   values (in order), indexes and constraints. Current result: `585/585 cols`, `94/94 enums`,
   `185/185 indexes`, `593/593 constraints`, `PHASE_F_PG_CATALOG_IDENTICAL_OK`.
3. `node tests/migration-providers.test.js` — offline contracts + byte-frozen checksums
   (SQLite `480a5327…`, PG `186f921f…`).
4. `node tests/production-storage-phase21.test.js` + `node scripts/verify-phase21-migration.mjs` —
   the rehearsal copies the four new tables with real rows onto a disposable PostgreSQL.
5. **No production migration was run in this phase.** Applying to production is an operator action
   governed by `docs/POSTGRES_CUTOVER_RUNBOOK.md`.

---

## 15. Verification map

| Concern | Proof |
|---|---|
| Lifecycle, windows, lock, absence states, notifications, UI contracts | `tests/phase-f-live-sessions.test.js` (48 numbered cases + DB rehearsal) |
| Teacher scope + legacy attendance compatibility | `scripts/verify-phase26d-teacher.mjs` §F, `tests/phase26d-teacher-full-flow.test.js` |
| Admin registration/navigation order, deep links | `tests/admin-publishing-phase15.test.js`, `tests/student-locked-curriculum-phase16.test.js` |
| Migration SQL, provider chain, baseline parity | `tests/migration-sql.test.js`, `tests/migration-providers.test.js`, `scripts/db/verify-phase-f-pg-parity.mjs` |
| Production storage rehearsal | `tests/production-storage-phase21.test.js`, `scripts/verify-phase21-migration.mjs` |
| Notification framework regression | `tests/session-notifications-phase17.test.js`, `tests/post-launch-notifications.test.js` |
| Cross-role authorization | `tests/authorization-invariants.test.js`, `tests/parent-dashboard-isolation.test.js` |

The step-by-step human verification script (Admin / Teacher / Student / Parent / Notifications /
Security) lives in `docs/PHASE_F_MANUAL_QA_PLAN.md`.
