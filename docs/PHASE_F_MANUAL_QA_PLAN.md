# Phase F — Manual QA Plan (Local Verification)

> **Scope:** the human verification script for the live-session lifecycle, attendance lock,
> absence review and the notification surfaces. Automated evidence is in
> `docs/PHASE_F_REPORT.md`; the design record is `docs/PHASE_F_LIVE_SESSION_LIFECYCLE.md`.
>
> **Not claimed anywhere in this document:** mobile QA. Every step below is a desktop/laptop
> (keyboard + mouse) check. No mobile testing was performed for this phase, and the report says so.

---

## 0. Preconditions

```bash
# 1. Database: use the existing local SQLite dev database. NEVER reset it.
npx prisma migrate deploy --schema prisma/schema.prisma   # applies the additive Phase F migration
npx prisma migrate status --schema prisma/schema.prisma   # must be "up to date"

# 2. Passwords come from the environment (the seeder has no defaults)
export SEED_ADMIN_PASSWORD='…' SEED_DEMO_PASSWORD='…'

# 3. Run the app
npm run dev            # http://localhost:3000
```

Accounts needed: one **admin**, one **teacher** (owning a group with ≥ 2 students), two
**students** in that group, and one **parent** linked to one of them.

Data needed: at least one `Group` with a course, ≥ 2 `Lesson`s in that course, and — for the
absence flow — a session whose end + grace has already passed.

**Before every role block:** open the browser console and keep it visible. Any React error,
hydration warning or `500` during these steps is a finding.

---

## 1. Admin — operational overview

| # | Step | Expected |
|---|---|---|
| 1.1 | Sign in as admin → sidebar → **"الحصص ومتابعة الغياب"** (last admin item) | The live-ops console opens with 4 tabs; no console error |
| 1.2 | Tab **"اليوم"** | Today's sessions with teacher, group, time, status; the KPI strip shows sessions-not-finalized, incomplete, no-show, cancelled counts |
| 1.3 | Tab **"القادمة"** | Upcoming sessions, chronological, each with its group/lesson; times in the local timezone (Africa/Cairo) |
| 1.4 | Tab **"الحضور غير المؤكد"** | Sessions whose register was never finalized — including a session that was finalized *with* unmarked students (it must appear as **"حضور غير مكتمل"**, not as clean) |
| 1.5 | Tab **"مراجعة الغياب"** | Absence queue, default filter = pending reason + pending review. Every row shows **student name, session, lesson, group, teacher, date/time, status, reason, submitter, review state** — and **no raw ids or enum codes anywhere** |
| 1.6 | Apply each filter (pending reason / pending review / excused / unexcused / student / group / teacher / from–to) | The list narrows correctly; the empty state renders when nothing matches; clearing restores the full list |
| 1.7 | Resize the window to ~1280×720 and to ~1024×700 | The console and every dialog stay inside the viewport; the bottom action row of each dialog is **reachable by scrolling**; the page body does not scroll behind a dialog |
| 1.8 | Tab through the first dialog with the keyboard only (Tab / Shift+Tab / Esc) | Focus is visible, Esc closes, no focus trap that strands the cursor |

**Admin scheduling (same console):** create a session (see §2.1 equivalent from the admin side) with
a `javascript:` URL, then with `http://`, then with a valid `https://meet.google.com/…`. The first
two must be rejected with a plain-Arabic message; the third accepted. The URL must never be echoed
as a clickable link when invalid.

---

## 2. Teacher

| # | Step | Expected |
|---|---|---|
| 2.1 | Sign in as the teacher → sidebar **"الحصص المباشرة"** | Sessions of the teacher's own groups; each row shows group, lesson, timing, status |
| 2.2 | Schedule a new session for a lesson **inside** the teacher's course | Succeeds; appears immediately in the list; status "مجدولة" |
| 2.3 | Try to reference a lesson of **another** course (via the UI if offered, otherwise by replaying the request with a foreign `lessonId`/`groupId`/`teacherId`) | Refused (404/403); **nothing is created**; the response never leaks the foreign lesson title |
| 2.4 | Open the session before it starts | The register is **read-only** with a clear reason ("تبدأ الحصة في …"); the link actions are disabled with the 15-minute reason |
| 2.5 | Start the session (mark it live) at/after the start time | Status becomes "جارية الآن"; the roster becomes editable |
| 2.6 | Mark one student **حاضر**, one **متأخر**, one **غائب** | Each change is reflected in the completion counter (`x / N تم تسجيلهم`); the unsaved state is visible until saved |
| 2.7 | Use the search box to filter the roster by name | Only matching students remain; clearing restores everyone |
| 2.8 | Use **"تسجيل الجميع حاضرين"** | Confirmation appears first; after confirming, all rows become "حاضر" and the counter is complete — **the bulk action never marks anyone absent** |
| 2.9 | Press **"تأكيد الحضور"** while some students are still unmarked | A warning lists the unmarked count; the dialog offers the explicit acknowledgement ("تأكيد مع وجود غير مسجّلين"); cancelling leaves everything editable |
| 2.10 | Confirm the finalize (with the acknowledgement if needed) | Success message; the register becomes **read-only** with "تم تأكيد الحضور"; a finalized-with-gaps session shows the incomplete state |
| 2.11 | After finalizing, try to edit attendance again (UI + a replayed API write) | Refused (`ALREADY_FINALIZED`); the row does not change |
| 2.12 | Look for an admin correction capability in the teacher UI | **Absent.** There is no "correct attendance" action; the API returns 403 for the correction route |
| 2.13 | Reschedule a session | The new time is shown; the original instant is preserved in history; the reschedule count/trail is visible to admins |
| 2.14 | Cancel a session | Status "ملغاة" with the reason; the register shows no marks and no absences are created; the student list shows it as cancelled |
| 2.15 | Open the session history list | Past sessions remain readable (including their attendance), and the student actions are the ended/history variant |

---

## 3. Student

| # | Step | Expected |
|---|---|---|
| 3.1 | Sign in as a student in the group → **"حصصي المباشرة"** | Only this student's own group's upcoming sessions; title, date, start–end, teacher name, status |
| 3.2 | Check a session more than 15 minutes before the start | Actions disabled with the reason ("يبدأ الانضمام قبل الحصة بـ 15 دقيقة") |
| 3.3 | Inside the join window, press **"انضم للحصة"** | Opens the meeting URL in a new tab; the URL host matches the provider label shown (Google Meet / Zoom / Teams / رابط حصة) |
| 3.4 | Press **"نسخ الرابط"** | The clipboard contains the **actual meeting URL** (paste it somewhere to confirm) and a "تم النسخ" confirmation appears |
| 3.5 | After the session ends | The join actions are gone; the session moved to history with its final status |
| 3.6 | Open **"أعذار الغياب"** | Only this student's own absence cases; no other student's name/id is visible anywhere |
| 3.7 | Submit a reason for a pending case | Success; the case moves to "بانتظار المراجعة"; the text appears in the case view |
| 3.8 | Submit a replacement reason for the same case | Allowed while not decided; both submissions are recorded (admins see the trace); the case shows the newest |
| 3.9 | For a decided case, try to submit again | Refused with a clear message (`ABSENCE_ALREADY_DECIDED`); the field is not offered |
| 3.10 | After an admin decides EXCUSED / UNEXCUSED | The review state updates; **the next Lesson must NOT become available** because of it |

---

## 4. Parent

| # | Step | Expected |
|---|---|---|
| 4.1 | Sign in as the linked parent → **"أعذار الغياب"** | Only the linked child's cases; other families never appear |
| 4.2 | Submit a reason for the child | Succeeds; the submitter is recorded as the parent (name + role shown to admins) |
| 4.3 | Look for attendance editing / excuse / unlock controls | **None exist**; replaying an attendance write or a decision call returns 403 |
| 4.4 | Wait for (or trigger) a decision | The parent receives `ABSENCE_EXCUSED` / `ABSENCE_UNEXCUSED` and can see the state |
| 4.5 | Check an unrelated child's case id (replayed request) | 404 — no scope expansion |

---

## 5. Notifications (all roles, includes the Bug T check)

| # | Step | Expected |
|---|---|---|
| 5.1 | Trigger the session events: schedule → set a link → reschedule → cancel | Each produces **one** notification per recipient, with the correct Arabic copy |
| 5.2 | Open the bell → **"كل الإشعارات"** with enough rows to overflow the panel (trigger several events) | The list scrolls to the very bottom; the **last row and its action buttons are reachable**; the page body does not scroll instead of the panel (Bug T regression check) |
| 5.3 | Repeat 5.2 on a short laptop viewport (~1280×720, browser zoom 100 %, then 125 %) | The panel is still bounded, nothing is clipped, the action row of the last item is clickable |
| 5.4 | In a `SESSION_LINK` notification press **"انضم للحصة"** outside the window | The button is disabled and explains why (or the click returns the reason) — no dead button, no error |
| 5.5 | Press **"نسخ الرابط"** on the same notification | Copies only after the server authorizes; the copied value is the real URL (never a `javascript:` or empty string) |
| 5.6 | Sign in as an unrelated teacher/student and inspect their notifications | They received **nothing** about that group's session |
| 5.7 | Trigger the same event twice (double-submit / refresh-then-retry) | Still exactly one notification per user (idempotency); no duplicate rows |
| 5.8 | In notification preferences, disable "upcoming session" and schedule another session | Session events are skipped for that user (respecting preferences), while **absence** notifications still arrive (mandatory) |
| 5.9 | Trigger an absence finalize, a reason submission and a decision | Student + parents get the absence events; admins get the reason-submitted event |
| 5.10 | Inspect a notification's raw payload (React devtools / network) | It carries a `sessionId`, **never** the meeting URL |

---

## 6. Security verification (replayed requests; a second session or a REST client)

Use the student's/parent's/teacher's cookie against the endpoints below. Every "forbidden" case must
be answered by the **server**, not by a hidden button.

| # | Attempt | Expected |
|---|---|---|
| 6.1 | Teacher reads/modifies a session of another group (`GET/PATCH /api/live-sessions/[id]`) | 404 |
| 6.2 | Teacher schedules a session with a foreign `groupId`/`lessonId`/`teacherId` in the body | 404/403; nothing created; the foreign scope is not echoed |
| 6.3 | Teacher writes attendance after the lock (`POST /api/live-sessions/[id]/attendance`) | `ALREADY_FINALIZED` (409); the row is unchanged |
| 6.4 | Teacher writes attendance after the window (`WINDOW_CLOSED`) | 409; the row is unchanged |
| 6.5 | Teacher calls `POST /api/live-sessions/[id]/attendance/correction` | **403** (admin-only) |
| 6.6 | Student/parent calls any attendance write | 403 |
| 6.7 | Student calls the absence decision route | 403 |
| 6.8 | Student requests another group's session join (`/join`) | 404 — no link leak (this is the "no cross-group link leak" check) |
| 6.9 | Student requests an unrelated teacher's session list | Only their own group's sessions appear |
| 6.10 | Admin assigns a substitute to one session, then checks the substitute's authority | Substitute can view/join/take attendance for **that** session only; other sessions of the group are still 404; the original teacher's `Group`/`Course` ownership is unchanged; the assignment is audited |
| 6.11 | Submit a `javascript:` URL as a meeting link (API + UI) | Rejected; nothing is stored; no notification is emitted |
| 6.12 | Submit a session with an empty link, then a student tries to join | `LINK_NOT_SET` with a readable message; no dead button |
| 6.13 | Trigger a cancelled session's join | `SESSION_CANCELLED`; no attendance row and no absence case exists for that session |
| 6.14 | Cause a teacher no-show (a past session with no marks, never finalized) | Admin sees `TEACHER_NO_SHOW`; **no student absence records are created** |
| 6.15 | Cause a finalize with unmarked students (acknowledge) | `ATTENDANCE_INCOMPLETE` for the admin; unmarked students get **no** absence case and no notification |
| 6.16 | Check the audit trail after each ceremony above | `AuditLog` rows exist for creation, reschedule, cancel, substitute, finalize, correction, reason submission, decision and hold changes |

---

## 7. Sign-off checklist

- [ ] Every row above executed and matching (note any deviation with the exact step number).
- [ ] No console errors/hydration warnings during the whole pass.
- [ ] Arabic copy is correct and complete; no untranslated key or raw enum code appears anywhere.
- [ ] Keyboard-only pass through the schedule, the attendance workspace and the absence queue.
- [ ] `.next` production build (SQLite provider) still serves the Phase F routes.
- [ ] Desktop/laptop only — **mobile was not tested** and must not be claimed.

Record the result in `docs/PHASE_F_REPORT.md` §Verification, replacing the automated line with the
date, the browser/OS, the viewport sizes used and any deviation found.
