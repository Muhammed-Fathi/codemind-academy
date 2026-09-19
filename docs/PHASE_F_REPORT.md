# Phase F — Structured Report (35 items)

**Branch:** `arena/01a0b7d1-codemind-academy` (base: `main` @ `1bda6d1`) · **Date:** 2026-09-19 ·
**No merge, no deploy, no PR** (not authorized) · **No production migration executed.**

---

## 1. Scope delivered

The complete live-session lifecycle: Lesson → `LiveSession` scheduling (Teacher + Group + time) →
session link → student upcoming session → live period → attendance → explicit finalization → lock →
absence detection → student/parent notification → reason submission → admin review →
`EXCUSED`/`UNEXCUSED` → `AbsenceHold` **state** → history/reporting. Canonical identity stays
`Course → Part → Unit → Lesson`; `Lesson` (academic) and `LiveSession` (scheduled event) remain
separate models.

## 2. What the repository looked like before Phase F

Discovery found **no** session-creation route and no absence concept at all: `LiveSession` rows had
to be created outside the app, `Attendance` had no attribution, and `AttendanceStatus.EXCUSED`
conflated *the teacher's fact* with *the academy's decision*. Phase F therefore had to establish
the write surface **and** its authorization model, while keeping the existing teacher attendance
route and every existing consumer working. Full findings: `docs/PHASE_F_LIVE_SESSION_LIFECYCLE.md` §1.

## 3. Design decisions taken (and the reasoning)

* **Extend, never duplicate.** One `LiveSession`, one `Attendance`, one notification framework, one
  upcoming-session authority. No second session/attendance/notification architecture was invented.
* **`ENDED` is `COMPLETED`.** The existing `SessionStatus` enum covered the lifecycle, so no value
  was added; the UI phase (`UPCOMING`/`LIVE`/`ENDED`/`CANCELLED`) is *derived*, not stored.
* **No `RESCHEDULED` status.** A rescheduled session is still `SCHEDULED`; "it was rescheduled" is an
  event recorded by `originalStartAt`/`rescheduleCount`/`lastRescheduledAt` + the AuditLog. A status
  value would have made the state machine ambiguous for every reader.
* **`UNMARKED` is not a status.** It is the absence of an `Attendance` row, derived on read. This is
  the structural guarantee behind `UNMARKED ≠ ABSENT`.
* **End time is derived** (`startAt + duration`), so the lock instant and the join window have one
  arithmetic and one source of truth.

## 4. Schema changes — additive only, no resets

`LiveSession` +18 columns (provenance, lifecycle stamps, reschedule trail, session-scoped
substitute, attendance lock, `updatedAt`), `Attendance` +3 (`markedByUserId`, `markedAt`,
`updatedAt`), `Notification` +2 (`sessionId`, `dedupeKey` with `UNIQUE(userId, dedupeKey)`), four
new tables (`AttendanceCorrection`, `AbsenceReview`, `AbsenceReasonSubmission`, `AbsenceHold`), two
new enums (`AbsenceReviewStatus`, `AbsenceHoldStatus`) and 9 new `NotificationType` values. Every
added column is nullable or has a constant default ⇒ **no backfill required**, existing production
rows valid at apply time. `prisma/postgres/migrations/0_init` untouched (frozen).

## 5. Migrations and rehearsal

SQLite `20260919120000_phase_f_live_session_lifecycle` + PostgreSQL twin, both additive, no
`DROP`/`DELETE`. `node tests/migration-sql.test.js` → 15/0. `node
tests/production-storage-phase21.test.js` → 181/0 and `node scripts/verify-phase21-migration.mjs`
→ **`PHASE21_MIGRATION_OK`, 28 checks, 0 failures**, copying **60 tables / 104 rows** (the four new
tables included, with realistic rows) onto a disposable PostgreSQL and proving row-count and hash
equality. `node tests/migration-providers.test.js` → 83/0 with both new migration files
**byte-frozen** by SHA-256 (SQLite `480a5327…`, PostgreSQL `186f921f…`).

## 6. PostgreSQL chain parity — proved offline on a real engine

`scripts/db/verify-phase-f-pg-parity.mjs` (PGlite = real PostgreSQL, WASM) applies
`0_init + Phase 26D + Phase F` and diffs the catalog against the generated baseline:
`cols 585/585, enums 94/94, idx 185/185, cons 593/593` →
**`PHASE_F_PG_CATALOG_IDENTICAL_OK`**. The same comparison runs on a real PostgreSQL 17 service
container in CI (`.github/workflows/pg17-full-chain-reference.yml`, updated this phase).

## 7. Pre-existing divergence found and closed additively

`Attendance` has declared `@@index([sessionId])` since Phase 13, but **neither** the historical
SQLite migrations **nor** the frozen PostgreSQL `0_init` ever created it — so a database built from
the migration chain could not reproduce `prisma/postgres/schema.prisma`. The parity check above is
what surfaced it (it was the *only* structural difference). Phase F adds
`CREATE INDEX IF NOT EXISTS "Attendance_sessionId_idx"` in both providers; it is additive, changes
no data, and makes the chain self-consistent.

## 8. Documented provider asymmetry (not hidden)

PostgreSQL also creates `LiveSession_substituteTeacherId_fkey` (`ALTER TABLE … ADD CONSTRAINT …
ON DELETE SET NULL`). SQLite can only attach a foreign key by **rebuilding** `LiveSession`, which
this migration deliberately does not do (production rows are referenced by `Attendance`,
`SessionPublication`, …). On SQLite the substitute stays an indexed plain column and the constraint
is re-created by any future `migrate dev`; the asymmetry is asserted in
`tests/migration-providers.test.js` (A5b) and stated in the migration comments and in
`docs/PHASE_F_LIVE_SESSION_LIFECYCLE.md` §3.

## 9. One lifecycle/window authority

`src/lib/live-session-policy.ts`: join opens 15 min before start (`LIVE_SESSION_JOIN_EARLY_MINUTES`,
max 240) and closes at the scheduled end; attendance opens at `startAt` and closes at
end + 15 min (`LIVE_SESSION_ATTENDANCE_GRACE_MINUTES`, max 120); `sessionDurationMinutes` falls back
to `LIVE_SESSION_DEFAULT_DURATION_MINUTES = 120` and **never returns 0**. Every surface (API, teacher
UI, tests) reads the same functions.

## 10. Scheduling authority

`POST /api/live-sessions` for **Admin + scoped Teacher**. A teacher may schedule only when the
Lesson is inside `Group.courseId` of a group they own (`loadSessionForTeacher`); client-supplied
`teacherId`/`courseId`/`groupId` are treated as data, never authority, and a foreign scope returns
**404** (no enumeration).

## 11. Session link: validated, first-class, never unsafe

`validateMeetingUrl`: **https only**, no embedded credentials, dotted DNS host, ≤1024 chars,
fragment stripped; the provider is detected (Meet / Zoom / Teams / other) for the UI label. Anything
else — including `javascript:` — is refused at write **and re-validated at read**, so a stored value
that later fails validation is never rendered as a link. The URL is never stored in a notification
(§26) and never returned by a list endpoint.

## 12. One upcoming-session authority reused by all roles

`listUpcomingSessions` / `toLiveSessionPayload` is the single authority: students see
title/date/start–end/teacher/status/Join; teachers see sessions + group + lesson + timing + link +
attendance state; admins see sessions + teacher + group + timing + completion + review state. No
per-role schedule engine was written; the legacy calendar surfaces link into it (deferral documented).

## 13. Join window and server-authorized link

`decideJoin` returns `SESSION_CANCELLED | LINK_NOT_SET | TOO_EARLY | SESSION_ENDED` or allows.
**The URL is served only by `GET/POST /api/live-sessions/[id]/join` after authorization**, so
bypassing the UI yields no link; a student outside the group gets 404. After the session ends the
actions disappear and the session moves to history.

## 14. Teacher roster derived server-side

`loadSessionRoster` resolves the roster from `LiveSession.groupId → Group students`. A
client-supplied student id that is not in the group is refused; the client never supplies the list.
Statuses are `UNMARKED` (no row) / `PRESENT` / `LATE` / `ABSENT` (+ the legacy `EXCUSED` mark).

## 15. Attendance window behaviour

Read-only before start (`NOT_STARTED`), editable during the session, blocked after end plus grace
(`WINDOW_CLOSED`), blocked after finalization (`ALREADY_FINALIZED`), blocked on a cancelled session
(`SESSION_CANCELLED`, reads still work). The grace period is documented and centralized (§9).

## 16. Finalize ceremony: `28 / 30` and the `UNMARKED` rule

`POST …/attendance/finalize` shows and requires the true counts; refuses with **409
`UNMARKED_REMAIN`** unless `acknowledgeUnmarked: true` is sent. **Acknowledging never writes
`ABSENT`** — it records "finishing with unmarked students" and flags the session
`ATTENDANCE_INCOMPLETE` for admin follow-up. Chosen safer behaviour: *block by default, allow only
with an explicit audited acknowledgement, then flag.* Idempotent on repeat.

## 17. Review-state lattice

`NOT_DUE → ATTENDANCE_OPEN → AWAITING_TEACHER → (window closed) ATTENDANCE_INCOMPLETE |
TEACHER_NO_SHOW`, plus `FINALIZED` and `CANCELLED`. A finalized session with unmarked students is
`ATTENDANCE_INCOMPLETE`, **never** `FINALIZED`. The admin overview's "not finalized" counter reads
`attendanceFinalizedAt`, so an incomplete-but-finalized session never inflates it.

## 18. The lock

After `attendanceFinalizedAt` the register is immutable to teachers (server-side), readable forever,
and the teacher UI becomes read-only with the reason shown. **A teacher can never gain the
correction capability** (route-level 403, pinned by the suite).

## 19. Admin-only correction, fully audited

`AttendanceCorrection` is append-only (no update/delete route): previous status, new status,
**mandatory reason**, correcting admin identity, timestamp + an `AuditLog` row. Correcting an
`ABSENT` row away from `ABSENT` voids the case as `NO_ACTION_REQUIRED` and resolves its hold — the
case is closed, never deleted, and never silently relabelled `EXCUSED`.

## 20. Absence workflow: input and idempotency

Cases are materialized **only** from finalized/locked `ABSENT` rows. `AbsenceReview.attendanceId` is
`UNIQUE` — the database-level idempotency key of the whole workflow. A temporary `ABSENT` clicked
while the register is still editable creates nothing. The attendance **fact** and the administrative
**interpretation** live in different tables.

## 21. Reason submission: student or linked parent, traceable

`POST /api/absence-reviews/[id]/reason` accepts 3–1000 chars from the student or a linked parent
(no uploads — the platform has no absence-attachment storage; inventing one was out of scope). Every
submission is appended to `AbsenceReasonSubmission` (nothing destroyed) while the review mirrors the
newest text, giving full **traceability on replacement**. After a decision: **409
`ABSENCE_ALREADY_DECIDED`**. Admins are notified.

## 22. Admin review queue and decisions

Filters: pending reason, pending review, excused, unexcused, student, group, teacher, date range,
session. Rows show student/session/lesson/group/teacher/date-time/status/reason/submitter/review
state with **display names, never raw ids or enum codes**. `EXCUSE` → `EXCUSED` (no hold);
`UNEXCUSE` → `UNEXCUSED` (ACTIVE hold); optional note; admin identity + timestamp; audited; student
and parents notified.

## 23. Hold semantics and the Phase H boundary

`AbsenceHold` is created/managed/resolved in Phase F, exposed to authorized consumers, notified and
audited — and **enforces nothing**: no progression gate, no content lock, no join block, no
recording gate. **`EXCUSED` never auto-unlocks the next academic Lesson** and never completes
academics; administrative approval ≠ academic completion.

## 24. Repeated-absence signal

Non-punitive, factual: ≥3 finalized `ABSENT` in 30 days (both configurable) produces an admin flag
with counts only. **No auto-ban, no suspension, no unenrollment.**

## 25. Notifications: nine events, idempotent, preference-respecting

`SESSION_SCHEDULED`, `SESSION_LINK`, `SESSION_RESCHEDULED`, `SESSION_CANCELLED`,
`ABSENCE_FINALIZED`, `ABSENCE_REASON_SUBMITTED`, `ABSENCE_EXCUSED`, `ABSENCE_UNEXCUSED`,
`ABSENCE_REMINDER` — all through the existing Phase 17 framework. Recipients are resolved
server-side (`sessionStudentUserIds`, `parentUserIdsForStudents`, `adminUserIds`). Session events
respect `upcomingSession` + quiet hours; absence/admin events are mandatory. Idempotency comes from
`insertNotificationOnce` + the unique `(userId, dedupeKey)` with keys of the form
`EVENT:subjectId[:revision]`, so retries and double-submits insert once.

## 26. `SESSION_LINK` is structured — and the URL is never stored

The session-link notification carries `sessionId` and renders `SessionLinkActions`:
**"انضم للحصة"** (POSTs to the authorized join endpoint and opens the validated URL) and
**"نسخ الرابط"** (copies the URL that same endpoint returned — so a user who cannot join cannot
copy). Outside the window both are disabled **with the reason rendered**; no dead button. The
meeting URL never enters `Notification.link` or any notification payload.

## 27. Parent role boundaries

A linked parent may view the absence, submit a reason and see the review state. A parent **may not**
change attendance, excuse an absence, resolve a hold or unlock content — all 403 server-side.
Visibility is limited to their own children by query (`parentChildIds`), not by UI.

## 28. Cancel / reschedule / substitute / make-up

* **Cancel:** `CANCELLED` + reason/actor/timestamp; **no attendance rows and no absence cases are
  ever created** for a cancelled session; join refuses; writes refuse; students/parents notified.
* **Reschedule:** `startAt` moves, `originalStartAt` preserves the **first** instant, count/trail
  stamped, previous instant audited, status unchanged; notified.
* **Substitute:** Admin-only, **session-scoped** — may view/join/take attendance for that session
  only; `Group`/`Course`/`Teacher.groups` ownership is untouched; audited.
* **Make-up:** an ordinary new `LiveSession` for the same Lesson + Group; the original history and
  its attendance facts are preserved; **no progression exception**.

## 29. Explicit bug fix T — notification vertical scroll

**Root cause:** Radix `ScrollArea`'s root is `overflow-hidden` and the *Viewport* is the scroller, so
bounding the list alone left nothing scrollable and the last rows/actions were unreachable while the
page body scrolled instead. **Fix:** the shared notifications panel root is now bounded
(`max-h-[min(60dvh,calc(100dvh-15rem))] min-h-0 overscroll-contain`) with inner padding; the admin
"Recent Notifications" panel mirrors it (`max-h-[min(52dvh,calc(100dvh-22rem))]`); Phase F views and
dialogs use `max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col` with an inner
`overflow-y-auto overscroll-contain`. `dvh` + `calc()` ceilings were chosen over a bare `70vh`
because short laptop viewports overflow with the latter. **Audited surfaces:** shared panel (all
roles), admin dashboard notifications block and its two plain lists, all Phase F views and dialogs;
the classes are pinned by `tests/phase-f-live-sessions.test.js` §43.

## 30. UI/UX and Arabic/RTL coverage

Arabic-first RTL with design-system components, loading/empty/error/success/disabled states
everywhere, confirmations for destructive and bulk actions, no raw ids/enum codes (label helpers
cover **every** enum value, §47 of the suite), keyboard-accessible dialogs with visible focus and
Esc. The teacher register has search, Present/Late/Absent buttons, a **confirmed** "تسجيل الجميع
حاضرين" bulk action, visible unsaved state and a live `x / N` completion counter. Every Phase F
dictionary key referenced in shipped code exists in the 2026 dictionary (§46 scans both locales);
the notification/dialog scroll regression is fixed and pinned (§29).

## 31. Security verification

The authorization matrix (§2.2 of the design doc) is enforced server-side and covered by tests:
teacher cannot read/modify foreign sessions or schedule outside scope (404); locked attendance
writes refused; teacher correction refused (403, now through the canonical `requireRole("ADMIN")`
guard); students/parents cannot mutate attendance or decide cases; no cross-group link leak (join is
404 outside scope); substitute authority is session-scoped; request ids never expand scope;
recipient resolution is server-authoritative. `tests/authorization-invariants.test.js` 94/0;
`tests/security-hardening.test.js` **385/0**; `tests/parent-dashboard-isolation.test.js` 112/0.

## 32. Automated evidence (all green)

* **Dedicated Phase F suite:** `node tests/phase-f-live-sessions.test.js` → **221 passed, 0 failed**
  (48 numbered cases across scheduling, student link, attendance, absence review, notifications,
  UI/source contracts, plus the real-SQLite schema rehearsal).
* **Regression battery (26 suites):** **25 green**, including Phase E workspace (170), Phase D
  readiness (321), Phase C aggregation (166), `session-progression` (163), `track-architecture-phase12`
  (310), `session-lifecycle-phase13` (314), `session-materials-phase14` (131),
  `admin-publishing-phase15` (386), `student-locked-curriculum-phase16` (385),
  `teacher-workflow-phase18` (371), `parent-analytics-alignment-phase19` (176),
  `production-storage-phase21` (181), `phase26d-teacher-full-flow`, `phase26e-parent-full-flow`,
  `phase26a-public-auth` (121), `session-media-publishing-audit` (218), `migration-providers` (83),
  `migration-sql` (15), `payment-lifecycle-phase25-*`, `phase25-pr4-release-gate` (95),
  `post-launch-notifications`.
* **Verifiers:** `verify-phase13-db` 158 assertions / 0 failures, `verify-phase14-db`
  `PHASE14_VERIFY_OK`, `verify-phase21-migration` 28/0, `verify-phase26d-teacher` 306/0
  `PHASE26D_VERIFIER_OK`, `verify-phase-f-pg-parity` `PHASE_F_PG_CATALOG_IDENTICAL_OK`.
* **Full repository run:** every suite was executed; see item 33 for the five non-green ones.

## 33. The five non-green suites — root-caused, none caused by Phase F

Proven by running each on a clean export of the **base commit** (`1bda6d1`) in `/tmp/base-tree`:

| Suite | My tree | Base commit | Verdict |
|---|---|---|---|
| `session-notifications-phase17` | 319/2 (§K only) + verifier 33 ok / 5 FAIL | **identical** (same failures, same crash at `verify-phase17-notifications.mjs:509`) | **Pre-existing**, byte-identical fingerprint; not hidden, not "fixed" |
| `phase26c-admin-full-flow` | 81/86 (5 × `ADMIN-17-real-b…f`) | **identical** (same 5 assertions, same messages) | **Pre-existing** (readiness/publish contract) |
| `final-integration-phase22` | `ENOENT …/backups` | **identical** `ENOENT` | **Environmental** (requires a local `backups/` dir) |
| `pg-baseline-inspection` | `fatal: invalid object name '137d35f^'` | same | **Base-clone artifact** (commit absent locally) — CI-only |
| `group-track-recovery-postgres` | `Invalid PostgreSQL target` | same | **Requires a disposable PostgreSQL `DATABASE_URL`** — CI-only |

Two Phase-F-introduced reds were found during this proof and **fixed** (they are green now): two
payment suites pinned the migration count at 12 (updated to 13 with the ordering invariants kept),
and `security-hardening` caught the new admin route not using the canonical `requireRole("ADMIN")`
guard (route refactored). Both are recorded here rather than quietly passed over.

## 34. Build and type verification

* `npx tsc --noEmit` → **exit 0** (after every edit, including the final ones).
* `npm run build:postgres` → **succeeds** (PostgreSQL schema generate + `next build` + standalone
  asset copy), with all Phase F routes present in the route table
  (`/api/live-sessions/**`, `/api/absence-reviews/**`, `/api/admin/live-ops`). The production-env
  guard requires `SKIP_PRODUCTION_ENV_CHECK=1` on a box that intentionally holds no production
  configuration (documented escape hatch) — no production secret was fabricated for the build.
* The local **SQLite Prisma client was restored** after the PostgreSQL build
  (`prisma generate` → provider `sqlite`, v6.19.3).
* Prisma engine downloads are blocked in this sandbox (`binaries.prisma.sh` TLS reset); generation
  used the documented stub-engine variables. **Real-engine `migrate deploy` proofs are therefore not
  possible locally** and remain CI-only (`pg17-full-chain-reference.yml`).

## 35. Known limitations, deferrals and what the human must still do

* **Manual QA has not been executed.** `docs/PHASE_F_MANUAL_QA_PLAN.md` is the step-by-step script
  (Admin / Teacher / Student / Parent / Notifications / Security). **No mobile QA is claimed.**
* The live i18n/UI audit (`tests/i18n/audit-ui.mjs`) **was extended** to cover all five new views
  (`student-sessions`, `student-absences`, `parent-absences`, `teacher-live-sessions`,
  `admin-live-sessions`) so the human pass includes them, but it could not be executed here: it
  needs a seeded database, `SEED_ADMIN_PASSWORD`/`SEED_DEMO_PASSWORD`, Playwright chromium and a
  running app on `localhost:3000`. The offline equivalent (every referenced dictionary key exists,
  in both locales, and every enum value has a label) is green in the Phase F suite.
* **Production migration is not run** and must follow `docs/POSTGRES_CUTOVER_RUNBOOK.md`.
* Deferred to Phase H (unchanged from the plan): hold enforcement on the next Lesson / recordings /
  future session links, catch-up access, SessionVideo 95 % integration, quiz/homework progression
  policy, admin manual unlock. Deferred to I/J: family & historical analytics, weekly/monthly
  summaries, final E2E/hardening/ops review. **No Phase G/H/I/J work was started.**

READY FOR LOCAL VERIFICATION
