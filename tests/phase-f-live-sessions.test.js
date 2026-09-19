// CodeMind Academy — Phase F LIVE SESSION LIFECYCLE test suite.
//
//   48 numbered cases across six sections:
//     §A 1–7    scheduling authority and validation
//     §B 8–12   the Session Link and the student surface
//     §C 13–24  the attendance register, the window and THE LOCK
//     §D 25–35  absence review, holds and admin correction
//     §E 36–42  notifications (structured + idempotent)
//     §F 43–48  UI source contracts, wiring and i18n
//
// THREE LAYERS, all offline (no network, no dev server):
//   1. BEHAVIOURAL — `src/lib/live-session-policy.ts` and
//      `src/lib/absence-policy.ts` are compiled with tsc and exercised for
//      real (window arithmetic, URL validation, lifecycle lattice, UNMARKED
//      semantics, review state, absence state machine, idempotency keys).
//      `@/lib/i18n-core` is redirected to a two-function stub so the compiler
//      does not have to pull the whole dictionary into the test run.
//   2. REAL SQLITE — the migration chain (base + every migration, Phase F
//      included) is applied to a fresh in-memory database through the SAME
//      runner the other verifiers use, then the Phase F invariants are checked
//      against actual SQL: the columns exist, the unique keys exist, and a
//      duplicate dedupeKey / a second absence case per attendance row are
//      refused by the DATABASE (not merely by application code).
//   3. SOURCE-LEVEL INVARIANTS — the shipped route/service sources are read and
//      asserted, in the style of tests/authorization-invariants.test.js. This
//      is what pins the rules into the real HTTP surface (teacher scope from
//      the database, admin-only decision/correction, the server-side lock, the
//      URL never travelling inside a notification, the bug-T scroll fix).
//
// Run: node tests/phase-f-live-sessions.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, like the other suites */
const { execFileSync } = require("child_process");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(REPO, rel));

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("FAIL:", label);
  }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// 1. Compile + load the pure policy modules
// ---------------------------------------------------------------------------

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phasef-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      strict: false,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [path.join(REPO, "node_modules/@types")],
      baseUrl: REPO,
      paths: { "@/*": ["src/*"] },
      outDir: OUT,
    },
    files: [
      path.join(REPO, "src/lib/live-session-policy.ts"),
      path.join(REPO, "src/lib/absence-policy.ts"),
    ],
  })
);
// PORTABILITY (Windows / Linux / CI / sandbox). The compiler is invoked as
// `node <typescript>/bin/tsc` with an ARGUMENT ARRAY — no shell is involved, so
// a temp path containing a space (the normal Windows case:
// `C:\Users\John Doe\AppData\Local\Temp`) cannot break the command line, and no
// `npx`/`npx.cmd` shell resolution is required. The previous form
//   execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`)
// interpolated an UNQUOTED path into a shell string and silently degraded into
// the misleading "tsc did not emit the Phase F policy modules" error below.
const TSC_JS = path.join(REPO, "node_modules", "typescript", "bin", "tsc");
try {
  execFileSync(process.execPath, [TSC_JS, "-p", path.join(OUT, "tsconfig.json")], {
    cwd: REPO,
    stdio: "pipe",
  });
} catch {
  /* type errors elsewhere in the graph are not this suite's business */
}

function findEmitted(name) {
  const stack = [OUT];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

const policyPath = findEmitted("live-session-policy.js");
const absencePolicyPath = findEmitted("absence-policy.js");
if (!policyPath || !absencePolicyPath) {
  throw new Error("tsc did not emit the Phase F policy modules");
}

// `@/lib/i18n-core` → minimal stub: the label helpers must return KEYS, and the
// test asserts exactly that (a missing dictionary entry can never leak a raw
// code into the UI because the helpers only ever produce a key).
const i18nStub = {
  translate: (_locale, key) => key,
  pickL10n: (_locale, ar, en) => ar || en || "",
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/i18n-core") return "cm-phase-f-i18n-stub";
  return originalResolve.call(this, request, ...rest);
};
require.cache["cm-phase-f-i18n-stub"] = {
  id: "cm-phase-f-i18n-stub",
  filename: "cm-phase-f-i18n-stub",
  loaded: true,
  exports: i18nStub,
};

const P = require(policyPath);
const A = require(absencePolicyPath);

// ---------------------------------------------------------------------------
// 2. Real SQLite: base schema + the FULL migration chain, including Phase F
// ---------------------------------------------------------------------------

let db = null;
try {
  const { DatabaseSync } = require("node:sqlite");
  const { applyMigrations, assertColumnsMatchSchema } = require(
    path.join(REPO, "scripts/lib/migrate-sqlite.mjs")
  );
  db = new DatabaseSync(":memory:");
  // quiet the migration runner's own logging
  const log = console.log;
  applyMigrations(db, { withBaseSchema: true, label: "  [phase F] " });
  console.log = log;
  const report = assertColumnsMatchSchema(db, [
    "LiveSession",
    "Attendance",
    "Notification",
    "AttendanceCorrection",
    "AbsenceReview",
    "AbsenceReasonSubmission",
    "AbsenceHold",
  ]);
  global.__phaseFColumnReport = report;
} catch (error) {
  console.error("SQLite rehearsal could not run:", error.message);
  global.__phaseFColumnReport = null;
}

const columnReport = global.__phaseFColumnReport;
const columnOk = (table) => {
  const row = (columnReport || []).find((r) => r.table === table);
  return Boolean(row && row.declared && row.missing.length === 0 && row.extra.length === 0);
};

// ===========================================================================
section("A. Scheduling authority and validation (1–7)");
// ===========================================================================

// 1. The teacher's group set comes from the DATABASE, never from the request.
{
  const src = read("src/lib/live-sessions.ts");
  const route = read("src/app/api/live-sessions/route.ts");
  ok(
    src.includes("export async function loadTeacherScope") &&
      src.includes("teacher.findUnique") &&
      src.includes("groups: { select: { id: true, name: true, courseId: true } }"),
    "1. teacher scope is loaded from Teacher.groups (server-side)"
  );
  ok(
    src.includes("if (!scope || !scope.groupIds.includes(group.id))") &&
      src.includes('"TEACHER_NOT_IN_SCOPE"'),
    "1b. buildSessionDraft refuses a group outside the teacher's scope"
  );
  ok(
    route.includes("requireTeacherActor") && route.includes('role: "TEACHER"'),
    "1c. the collection route builds the actor through the server resolver"
  );
}

// 2. The Lesson must belong to the GROUP's course (canonical or legacy chain).
{
  const src = read("src/lib/live-sessions.ts");
  ok(
    src.includes("LESSON_NOT_IN_GROUP_COURSE") &&
      src.includes("lessonChainForCourse") &&
      src.includes("unit: { part: { courseId } }") &&
      src.includes("topic: { unit: { part: { courseId } } }"),
    "2. the lesson is validated against the group's course on BOTH chains"
  );
}

// 3. Duration is bounded (15..600) and defaults to 120 minutes.
{
  const src = read("src/lib/live-sessions.ts");
  ok(
    src.includes("durationParsed < 15 || durationParsed > 600"),
    "3. duration outside 15..600 is refused"
  );
  ok(P.sessionDurationMinutes({ duration: null }) === 120, "3b. a missing duration reads as 120 minutes");
  ok(P.sessionDurationMinutes({ duration: 45 }) === 45, "3c. an explicit duration is honoured");
}

// 4. The meeting URL is validated at creation time.
{
  const src = read("src/lib/live-sessions.ts");
  ok(
    src.includes("validateMeetingUrl(body.meetingUrl)") && src.includes('"INVALID_MEETING_URL"'),
    "4. creation validates the meeting URL and refuses an unusable one"
  );
  ok(!P.validateMeetingUrl("javascript:alert(1)").ok, "4b. javascript: is refused");
}

// 5. Creation is attributed and audited.
{
  const src = read("src/lib/live-sessions.ts");
  ok(
    src.includes("createdByUserId: params.actor.userId") &&
      src.includes('action: "LIVE_SESSION_CREATE"'),
    "5. creation stores createdByUserId and audits LIVE_SESSION_CREATE"
  );
}

// 6. Only an admin or a teacher may schedule.
{
  const route = read("src/app/api/live-sessions/route.ts");
  ok(
    route.includes('"Only an admin or a teacher may schedule a session"') &&
      route.includes('throw new ApiFailure(403, "NOT_AUTHORIZED"'),
    "6. students/parents are refused with 403 NOT_AUTHORIZED"
  );
}

// 7. A client-supplied teacherId can never widen a teacher's authority.
{
  const src = read("src/lib/live-sessions.ts");
  ok(
    src.includes("teacherId = params.actor.scope?.teacherId ?? null;"),
    "7. a teacher's sessions use the scope's teacherId, ignoring the request body"
  );
  ok(
    src.includes("if (!teacher) throw new LiveSessionError(\"TEACHER_NOT_FOUND\"") &&
      src.includes("teacherId = teacher.id;"),
    "7b. an admin-supplied teacherId is re-verified in the database"
  );
}

// ===========================================================================
section("B. The Session Link and the student surface (8–12)");
// ===========================================================================

// 8. https-only, no credentials, dotted host, length cap, fragment stripped.
{
  ok(P.validateMeetingUrl("https://meet.google.com/abc-defg-hij").ok, "8. a Meet URL is accepted");
  ok(!P.validateMeetingUrl("http://meet.google.com/x").ok, "8b. plain http is refused");
  ok(!P.validateMeetingUrl("data:text/html,hi").ok, "8c. data: is refused");
  ok(!P.validateMeetingUrl("file:///etc/passwd").ok, "8d. file: is refused");
  ok(!P.validateMeetingUrl("https://user:pass@zoom.us/j/1").ok, "8e. embedded credentials are refused");
  ok(!P.validateMeetingUrl("https://localhost").ok, "8f. a host without a dot is refused");
  ok(!P.validateMeetingUrl("https://").ok, "8g. an empty host is refused");
  const long = "https://zoom.us/" + "a".repeat(P.MEETING_URL_MAX_LENGTH);
  ok(!P.validateMeetingUrl(long).ok, "8h. an over-long URL is refused");
  const withFragment = P.validateMeetingUrl("https://zoom.us/j/123#frag");
  ok(withFragment.ok && !withFragment.url.includes("#"), "8i. the fragment is stripped");
  ok(!P.validateMeetingUrl({}).ok && !P.validateMeetingUrl(null).ok, "8j. non-strings are refused");
}

// 9. Provider detection is informational and total.
{
  const meet = P.validateMeetingUrl("https://meet.google.com/abc");
  const zoom = P.validateMeetingUrl("https://us02web.zoom.us/j/123");
  const teams = P.validateMeetingUrl("https://teams.microsoft.com/l/meetup-join/1");
  const other = P.validateMeetingUrl("https://example.org/live/room");
  ok(meet.provider === "GOOGLE_MEET", "9. meet.google.com → GOOGLE_MEET");
  ok(zoom.provider === "ZOOM", "9b. *.zoom.us → ZOOM");
  ok(teams.provider === "MICROSOFT_TEAMS", "9c. teams.microsoft.com → MICROSOFT_TEAMS");
  ok(other.provider === "OTHER", "9d. any other https host → OTHER (never a hard failure)");
  ok(
    P.meetingProviderLabelKey("GOOGLE_MEET") === "live.provider.meet" &&
      P.meetingProviderLabelKey("OTHER") === "live.provider.other",
    "9e. providers map to dictionary keys, never to raw codes"
  );
}

// 10. The join window is bounded on both sides.
{
  const start = new Date("2026-09-20T10:00:00.000Z");
  const session = { startAt: start, duration: 60, status: "SCHEDULED", meetingUrl: "https://meet.google.com/x" };
  const beforeWindow = P.decideJoin(session, new Date("2026-09-20T09:00:00.000Z"));
  ok(!beforeWindow.allowed && beforeWindow.code === "TOO_EARLY", "10. 60 min early → TOO_EARLY");
  const atOpen = P.decideJoin(session, new Date("2026-09-20T09:45:00.000Z"));
  ok(atOpen.allowed, "10b. 15 min early → allowed (default early window)");
  const during = P.decideJoin(session, new Date("2026-09-20T10:30:00.000Z"));
  ok(during.allowed, "10c. during the live period → allowed");
  const after = P.decideJoin(session, new Date("2026-09-20T11:05:00.000Z"));
  ok(!after.allowed && after.code === "SESSION_ENDED", "10d. after the scheduled end → SESSION_ENDED");
}

// 11. Cancelled / missing / unsafe links are refused with stable codes.
{
  const start = new Date("2026-09-20T10:00:00.000Z");
  const cancelled = P.decideJoin(
    { startAt: start, duration: 60, status: "CANCELLED", meetingUrl: "https://meet.google.com/x" },
    start
  );
  ok(!cancelled.allowed && cancelled.code === "SESSION_CANCELLED", "11. a cancelled session never joins");
  const noLink = P.decideJoin({ startAt: start, duration: 60, status: "SCHEDULED", meetingUrl: null }, start);
  ok(!noLink.allowed && noLink.code === "LINK_NOT_SET", "11b. no link → LINK_NOT_SET");
  const unsafe = P.decideJoin(
    { startAt: start, duration: 60, status: "SCHEDULED", meetingUrl: "javascript:alert(1)" },
    start
  );
  ok(!unsafe.allowed && unsafe.code === "LINK_NOT_SET", "11c. an unsafe legacy row is treated as NO LINK");
}

// 12. The student/other-role surface is authorized server-side, and a meeting
//     URL never travels inside a notification.
{
  const joinRoute = read("src/app/api/live-sessions/[id]/join/route.ts");
  ok(
    joinRoute.includes("loadSessionForStudent") && joinRoute.includes("loadSessionForParent"),
    "12. join resolves the actor through the role's own loader"
  );
  ok(
    read("src/lib/live-sessions.ts").includes("session.groupId !== student.groupId") &&
      read("src/lib/live-sessions.ts").includes("groupId: session.groupId"),
    "12b. a student may only reach a session of their OWN group"
  );
  const notifLib = read("src/lib/live-session-notifications.ts");
  ok(!/meetingUrl\s*:/.test(notifLib), "12c. the notification payload never carries a meeting URL");
  ok(notifLib.includes("sessionId"), "12d. it carries the structured sessionId instead");
  const notifRoute = read("src/app/api/notifications/route.ts");
  ok(
    notifRoute.includes("sessionId: true") && !/meetingUrl/.test(notifRoute),
    "12e. the notifications API exposes sessionId and never a URL"
  );
}

// ===========================================================================
section("C. The attendance register, the window and THE LOCK (13–24)");
// ===========================================================================

// 13. UNMARKED is the ABSENCE OF A ROW, never an ABSENT status.
{
  ok(P.rosterStatusOf(null) === "UNMARKED", "13. a missing row reads as UNMARKED");
  ok(P.rosterStatusOf({}) === "UNMARKED", "13b. a null status reads as UNMARKED");
  ok(P.ATTENDANCE_STATUSES.join(",") === "PRESENT,LATE,ABSENT,EXCUSED", "13c. the fact enum has no UNMARKED");
  ok(
    P.ROSTER_STATUSES.join(",") === "UNMARKED,PRESENT,LATE,ABSENT,EXCUSED",
    "13d. UNMARKED exists only on the ROSTER side"
  );
}

// 14–17. The window decisions.
{
  const start = new Date("2026-09-20T10:00:00.000Z");
  const session = { startAt: start, duration: 60, status: "SCHEDULED", attendanceFinalizedAt: null };
  const early = P.decideAttendanceWrite(session, new Date("2026-09-20T09:59:00.000Z"));
  ok(!early.allowed && early.code === "NOT_STARTED", "14. before the start the register is read-only");
  const open = P.decideAttendanceWrite(session, new Date("2026-09-20T10:15:00.000Z"));
  ok(open.allowed, "15. during the session the register is editable");
  const grace = P.decideAttendanceWrite(session, new Date("2026-09-20T11:10:00.000Z"));
  ok(grace.allowed, "15b. inside the grace period it is still editable (default 15 min)");
  const closed = P.decideAttendanceWrite(session, new Date("2026-09-20T11:20:00.000Z"));
  ok(!closed.allowed && closed.code === "WINDOW_CLOSED", "16. after the grace the register is closed");
  const finalized = P.decideAttendanceWrite(
    { ...session, attendanceFinalizedAt: new Date("2026-09-20T10:30:00.000Z") },
    new Date("2026-09-20T10:35:00.000Z")
  );
  ok(!finalized.allowed && finalized.code === "ALREADY_FINALIZED", "17. finalization wins inside the window");
  const cancelled = P.decideAttendanceWrite({ ...session, status: "CANCELLED" }, new Date("2026-09-20T10:15:00.000Z"));
  ok(!cancelled.allowed && cancelled.code === "SESSION_CANCELLED", "17b. a cancelled session has no register");
  ok(P.isAttendanceLocked({ ...session, attendanceFinalizedAt: new Date() }), "17c. isAttendanceLocked follows the lock");
}

// 18–19. The window is derived ONLY from (startAt, duration): `endedAt` is
// operational, and the grace is configurable/disable-able.
{
  const start = new Date("2026-09-20T10:00:00.000Z");
  const withEnded = {
    startAt: start,
    duration: 60,
    status: "COMPLETED",
    endedAt: new Date("2026-09-20T10:20:00.000Z"),
  };
  const decision = P.decideAttendanceWrite(withEnded, new Date("2026-09-20T11:05:00.000Z"));
  ok(decision.allowed, "18. an early teacher-ended session does NOT shorten the window");
  const windows = P.liveSessionWindows(withEnded);
  ok(
    windows.attendanceClosesAt.getTime() === start.getTime() + 75 * 60000,
    "18b. the window closes at start + duration + grace"
  );
  const src = read("src/lib/live-session-policy.ts");
  const fn = src.slice(src.indexOf("export function liveSessionWindows"));
  const body = fn.slice(0, fn.indexOf("\nexport function detectMeetingProvider"));
  ok(!body.includes("endedAt"), "18c. liveSessionWindows never reads endedAt");
  ok(P.liveSessionAttendanceGraceMinutes({ LIVE_SESSION_ATTENDANCE_GRACE_MINUTES: "0" }) === 0, "19. grace 0 is honoured (disabled)");
  ok(P.liveSessionJoinEarlyMinutes({ LIVE_SESSION_JOIN_EARLY_MINUTES: "-5" }) === 15, "19b. invalid values fall back to the default");
  ok(P.liveSessionJoinEarlyMinutes({ LIVE_SESSION_JOIN_EARLY_MINUTES: "999" }) === 240, "19c. the early window is clamped to 240");
}

// 20. The roster is derived from Group.students, active users only.
{
  const src = read("src/lib/live-sessions.ts");
  ok(
    src.includes("where: { groupId: session.groupId, user: { isActive: true } }"),
    "20. loadSessionRoster reads the group's students from the database"
  );
  ok(
    src.includes("const rosterIds = new Set(") && src.includes("where: { groupId: session.groupId }"),
    "20b. saveAttendance re-derives the roster instead of trusting the body"
  );
}

// 21. A student outside the roster is refused (403 STUDENT_NOT_IN_ROSTER).
{
  const src = read("src/lib/live-sessions.ts");
  ok(
    src.includes("if (!rosterIds.has(studentId))") && src.includes('throw new LiveSessionError("STUDENT_NOT_IN_ROSTER"'),
    "21. a forged studentId is refused by the roster check"
  );
}

// 22. Finalization with unmarked students: refused, or acknowledged WITHOUT
//     inventing absences for them.
{
  const src = read("src/lib/live-sessions.ts");
  ok(
    src.includes("counts.unmarked > 0 && !params.acknowledgeUnmarked") &&
      src.includes('"UNMARKED_REMAIN"'),
    "22. UNMARKED_REMAIN refuses a silent finalize"
  );
  ok(
    src.includes("acknowledgedUnmarked: Boolean(params.acknowledgeUnmarked && counts.unmarked > 0)"),
    "22b. the acknowledged finalize records the count it left unmarked"
  );
  const finalizeSection = src.slice(src.indexOf("export async function finalizeAttendance"));
  ok(
    !/status: "ABSENT"|status: 'ABSENT'/.test(finalizeSection.slice(0, finalizeSection.indexOf("materializeAbsenceCases"))),
    "22c. the finalize path never WRITES an ABSENT status"
  );
  ok(
    src.includes("derived from the schedule") || src.includes("never converts them to ABSENT"),
    "22d. the policy comment states the UNMARKED ≠ ABSENT rule"
  );
}

// 23. The lock is server-side: after finalization a teacher write is refused.
{
  const src = read("src/lib/live-sessions.ts");
  const save = src.slice(src.indexOf("export async function saveAttendance"));
  ok(
    save.includes("const decision = decideAttendanceWrite(session, now)") &&
      save.includes("if (!decision.allowed)"),
    "23. saveAttendance is gated by the window/lock decision"
  );
  ok(
    save.includes('["ATTENDANCE_ALREADY_FINALIZED", 409, "Attendance was finalized and is now locked"]'),
    "23b. the refusal names the lock explicitly"
  );
  const route = read("src/app/api/live-sessions/[id]/attendance/route.ts");
  ok(
    route.includes("decideAttendanceWrite") || route.includes("saveAttendance"),
    "23c. the register route goes through the same gate"
  );
  ok(
    route.includes('"Only the session\'s teacher may mark attendance; admins correct a locked register"'),
    "23d. a non-teacher cannot mark attendance at all"
  );
}

// 24. The review state is DERIVED (never a stale flag), including no-show.
{
  const start = new Date("2026-09-20T10:00:00.000Z");
  const base = { startAt: start, duration: 60, status: "SCHEDULED", attendanceFinalizedAt: null, conductedAt: null };
  ok(
    P.deriveSessionReviewState(base, { marked: 0 }, new Date("2026-09-20T09:00:00.000Z")) === "NOT_DUE",
    "24. before the start → NOT_DUE"
  );
  ok(
    P.deriveSessionReviewState(base, { marked: 3 }, new Date("2026-09-20T10:10:00.000Z")) === "ATTENDANCE_OPEN",
    "24b. during the session → ATTENDANCE_OPEN"
  );
  ok(
    P.deriveSessionReviewState(base, { marked: 3 }, new Date("2026-09-20T11:05:00.000Z")) === "AWAITING_TEACHER",
    "24c. class over but the register window is still open → AWAITING_TEACHER"
  );
  ok(
    P.deriveSessionReviewState(base, { marked: 3 }, new Date("2026-09-20T11:30:00.000Z")) === "ATTENDANCE_INCOMPLETE",
    "24c2. window closed, teacher active, register unfinalized → ATTENDANCE_INCOMPLETE"
  );
  ok(
    P.deriveSessionReviewState(base, { marked: 0 }, new Date("2026-09-20T11:30:00.000Z")) === "TEACHER_NO_SHOW",
    "24d. nothing happened at all → TEACHER_NO_SHOW (never student absences)"
  );
  ok(
    P.deriveSessionReviewState(
      { ...base, status: "COMPLETED", attendanceFinalizedAt: start },
      { marked: 3 },
      new Date("2026-09-20T11:30:00.000Z")
    ) === "FINALIZED",
    "24e. a finalized register → FINALIZED"
  );
  ok(
    P.deriveSessionReviewState(
      { ...base, attendanceFinalizedAt: start },
      { marked: 2, unmarked: 1 },
      new Date("2026-09-20T11:30:00.000Z")
    ) === "ATTENDANCE_INCOMPLETE",
    "24f. finalized with unmarked students → ATTENDANCE_INCOMPLETE (for admin review)"
  );
  ok(
    P.deriveSessionReviewState(
      { ...base, attendanceFinalizedAt: start },
      { marked: 3, unmarked: 0 },
      new Date("2026-09-20T11:30:00.000Z")
    ) === "FINALIZED",
    "24f2. finalized with everyone classified → FINALIZED"
  );
  const src = read("src/lib/live-sessions.ts");
  ok(
    !src.includes("noShowFlaggedAt") && !src.includes("incompleteFlaggedAt"),
    "24g. no persistence flag is used — the state cannot go stale"
  );
}

// ===========================================================================
section("D. Absence review, holds and admin correction (25–35)");
// ===========================================================================

// 25. A case is born ONLY from a finalized ABSENT row, exactly once.
{
  const src = read("src/lib/absence-review.ts");
  ok(
    src.includes('where: { sessionId: params.sessionId, status: "ABSENT" }') &&
      src.includes("if (!session || !session.attendanceFinalizedAt) return { created: 0, existing: 0 };"),
    "25. only finalized absences materialize, and only from ABSENT rows"
  );
  ok(
    src.includes("have.has(row.id)") && src.includes("catch (error)"),
    "25b. the unique index is the idempotency key, with an explicit pre-check"
  );
  const schema = read("prisma/schema.prisma");
  const review = schema.slice(schema.indexOf("model AbsenceReview"));
  ok(review.slice(0, review.indexOf("@@index")).includes("attendanceId String              @unique"), "25c. the DB enforces one case per attendance row");
}

// 26. UNMARKED students never appear in the workflow at all.
{
  const src = read("src/lib/absence-review.ts");
  ok(
    !/status: \{ in: \[.*"UNMARKED"/.test(src) && !src.includes('"UNMARKED"'),
    "26. the absence service never mentions UNMARKED — there is no row to review"
  );
}

// 27. Reason validation: 3..1000 characters, trimmed.
{
  ok(!A.validateAbsenceReason(" ab ").ok, "27. a 2-character reason is refused");
  ok(A.validateAbsenceReason("  مريض  ").reason === "مريض", "27b. the reason is trimmed");
  const long = "x".repeat(A.ABSENCE_REASON_MAX_LENGTH + 1);
  ok(!A.validateAbsenceReason(long).ok, "27c. a 1001-character reason is refused");
  ok(A.validateAbsenceReason("x".repeat(1000)).ok, "27d. exactly 1000 characters is accepted");
  ok(!A.validateAbsenceReason(42).ok, "27e. a non-string is refused");
}

// 28. Only the student or a LINKED parent may submit.
{
  const route = read("src/app/api/absence-reviews/[id]/reason/route.ts");
  ok(
    route.includes('student.id !== payload.student.id') &&
      route.includes("children.includes(payload.student.id)"),
    "28. the submitting actor is the case's own student or a linked parent"
  );
  ok(
    route.includes('"Only the student or a linked parent may submit a reason"'),
    "28b. teachers and admins are refused on this endpoint"
  );
}

// 29. A decided case refuses a new reason (409) instead of looking reopened.
{
  ok(!A.canSubmitReason("EXCUSED") && !A.canSubmitReason("UNEXCUSED"), "29. decided cases accept no reason");
  ok(!A.canDecide("EXCUSED") && A.canDecide("PENDING_REASON"), "29b. only pending cases can be decided");
  const route = read("src/app/api/absence-reviews/[id]/reason/route.ts");
  ok(route.includes('"ABSENCE_ALREADY_DECIDED"'), "29c. the refusal has a stable code");
}

// 30. Reasons are append-only; the case mirrors the newest one.
{
  const src = read("src/lib/absence-review.ts");
  ok(
    src.includes("absenceReasonSubmission.create") && src.includes("reason: validated.reason,"),
    "30. every submission is stored as its own row"
  );
  const schema = read("prisma/schema.prisma");
  const submissionStart = schema.indexOf("model AbsenceReasonSubmission");
  const submission = schema.slice(submissionStart, schema.indexOf("\n}", submissionStart));
  ok(!submission.includes("@updatedAt"), "30b. submissions are immutable (no update timestamp)");
  ok(src.includes("previous") && src.includes("history"), "30c. replacement keeps the previous text as history");
}

// 31. The admin queue supports the operational filters.
{
  ok(A.normalizeAbsenceQueueFilter("ALL") === "ALL", "31. ALL is a valid filter");
  ok(A.normalizeAbsenceQueueFilter("PENDING_REASON") === "PENDING_REASON", "31b. PENDING_REASON is a valid filter");
  ok(A.normalizeAbsenceQueueFilter("nonsense") === null, "31c. an unknown filter is refused");
  const src = read("src/lib/absence-review.ts");
  ok(
    src.includes("if (query.studentId) where.studentId") &&
      src.includes("if (query.groupId) where.groupId") &&
      src.includes("if (query.teacherId) where.teacherId") &&
      src.includes("if (query.sessionId) where.sessionId"),
    "31d. student/group/teacher/session filters are all honoured"
  );
  ok(src.includes("startAt: {") && src.includes("gte: query.from"), "31e. the date range filters the session start");
}

// 32. Decisions write the hold in the right state.
{
  ok(A.statusForDecision("EXCUSE") === "EXCUSED" && A.holdStatusForDecision("EXCUSE") === "RESOLVED", "32. EXCUSE → EXCUSED + RESOLVED hold");
  ok(A.statusForDecision("UNEXCUSE") === "UNEXCUSED" && A.holdStatusForDecision("UNEXCUSE") === "ACTIVE", "32b. UNEXCUSE → UNEXCUSED + ACTIVE hold");
  const src = read("src/lib/absence-review.ts");
  ok(src.includes("absenceHold.create") && src.includes("absenceHold.update"), "32c. the hold is created/updated in the decision ceremony");
}

// 33. Only an admin decides.
{
  const route = read("src/app/api/absence-reviews/[id]/decision/route.ts");
  ok(
    route.includes('user.role !== "ADMIN"') && route.includes('"Only an admin may decide an absence case"'),
    "33. the decision endpoint is ADMIN-only"
  );
}

// 34. Correction: admin-only, mandatory reason, audited, voids the case, and a
//     teacher can never reach it.
{
  const src = read("src/lib/live-sessions.ts");
  ok(
    src.includes("reason.length < 3") && src.includes('"CORRECTION_REASON_REQUIRED"'),
    "34. a correction without a reason (≥3 chars) is refused"
  );
  ok(
    src.includes("attendanceCorrection.create") &&
      src.includes('action: "LIVE_SESSION_ATTENDANCE_CORRECTION"'),
    "34b. the correction is stored AND audited"
  );
  ok(
    src.includes("voidAbsenceCaseForCorrection") && read("src/lib/absence-review.ts").includes('status: "NO_ACTION_REQUIRED"'),
    "34c. correcting an ABSENT away voids the case as NO_ACTION_REQUIRED"
  );
  const route = read("src/app/api/live-sessions/[id]/attendance/correction/route.ts");
  // The route uses the platform's canonical admin guard (`requireRole("ADMIN")`)
  // — the same call every /api/admin route uses and the one the security
  // hardening contract asserts. A teacher is refused by the guard itself.
  ok(
    route.includes('requireRole("ADMIN")') && !/requireUser\s*\(/.test(route),
    "34d. the correction route is ADMIN-only through the canonical guard (teachers never reach it)"
  );
}

// 35. Phase F introduces NO progression side effect: EXCUSED does not unlock.
{
  // Comments are stripped first: the file DOCUMENTS at length that it must not
  // unlock anything, and that prose must not be mistaken for code.
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const src = stripComments(read("src/lib/absence-review.ts"));
  ok(
    !/lessonProgress|LessonProgress|unlock|markLessonComplete/i.test(src),
    "35. the absence workflow never writes progression"
  );
  const policy = read("src/lib/absence-policy.ts");
  ok(policy.includes("EXCUSED") && policy.includes("administrative"), "35b. EXCUSED is documented as administrative only");
}

// ===========================================================================
section("E. Notifications: structured, scoped, idempotent (36–42)");
// ===========================================================================

// 36. The new notification types exist in BOTH provider schemas.
{
  const sqlite = read("prisma/schema.prisma");
  const postgres = read("prisma/postgres/schema.prisma");
  const types = [
    "SESSION_SCHEDULED",
    "SESSION_LINK",
    "SESSION_RESCHEDULED",
    "SESSION_CANCELLED",
    "ABSENCE_FINALIZED",
    "ABSENCE_REASON_SUBMITTED",
    "ABSENCE_EXCUSED",
    "ABSENCE_UNEXCUSED",
    "ABSENCE_REMINDER",
  ];
  for (const type of types) {
    ok(sqlite.includes(`  ${type}\n`) || sqlite.includes(`${type}\n`), `36. ${type} exists in the SQLite schema`);
    ok(postgres.includes(type), `36b. ${type} exists in the derived PostgreSQL schema`);
  }
}

// 37. Structured payload + no URL + dedupe columns.
{
  const schema = read("prisma/schema.prisma");
  const notif = schema.slice(schema.indexOf("model Notification"));
  ok(notif.includes("sessionId String?"), "37. Notification.sessionId exists");
  ok(notif.includes("dedupeKey String?"), "37b. Notification.dedupeKey exists");
  ok(notif.includes("@@unique([userId, dedupeKey])"), "37c. the idempotency key is unique per user");
  ok(!/meetingUrl/.test(notif), "37d. no URL column is added to Notification");
}

// 38. The dedupe key is stable, deterministic and revision-aware.
{
  const session = {
    id: "s1",
    startAt: new Date("2026-09-20T10:00:00.000Z"),
    duration: 60,
    meetingUrl: "https://meet.google.com/x",
    status: "SCHEDULED",
    teacherId: "t1",
    substituteTeacherId: null,
  };
  const key1 = P.sessionEventDedupeKey("SESSION_SCHEDULED", "s1", P.sessionRevision(session));
  const key2 = P.sessionEventDedupeKey("SESSION_SCHEDULED", "s1", P.sessionRevision(session));
  ok(key1 === key2, "38. the same event+revision produces the same key (retry-safe)");
  const moved = { ...session, startAt: new Date("2026-09-20T12:00:00.000Z") };
  const key3 = P.sessionEventDedupeKey("SESSION_SCHEDULED", "s1", P.sessionRevision(moved));
  ok(key1 !== key3, "38b. a reschedule changes the revision (and therefore the key)");
  ok(!key1.includes("u:"), "38c. the key carries no user id (uniqueness is already per user)");
}

// 39. insertNotificationOnce is a pre-check plus a unique-violation catch.
{
  const src = read("src/lib/live-session-notifications.ts");
  ok(
    src.includes("findFirst") && src.includes("dedupeKey") && src.includes("DUPLICATE"),
    "39. the emitter pre-checks and still tolerates a unique violation"
  );
  ok(
    /catch[\s\S]{0,400}dedupe|duplicate/i.test(src),
    "39b. a race is swallowed as a duplicate instead of failing the ceremony"
  );
}

// 40. Recipients are resolved server-side, from the database.
{
  const src = read("src/lib/live-session-notifications.ts");
  ok(
    src.includes("group.students") || src.includes("where: { groupId"),
    "40. session audiences come from the session's group"
  );
  ok(src.includes("parentStudentLink") || src.includes("parentUserIdsForStudents"), "40b. parents come from ParentStudentLink");
  ok(/role:\s*"ADMIN"|role: \{ equals: "ADMIN" \}|ADMIN/.test(src), "40c. admins are resolved by role");
}

// 41. Preferences are respected for session events; absence/admin events are
//     mandatory and say so.
{
  const src = read("src/lib/live-session-notifications.ts");
  ok(src.includes('mandatory: false') && src.includes("partitionByNotificationPreferences"), "41. session events respect preferences");
  ok(src.includes("mandatory: true"), "41b. absence/admin events are mandatory");
  ok(src.includes("quiet"), "41c. quiet hours are applied (not silently ignored)");
}

// 42. Every ceremony emits its event (and the finalize path emits absence events).
{
  const src = read("src/lib/live-sessions.ts");
  for (const [label, needle] of [
    ["schedule", 'kind: "SESSION_SCHEDULED"'],
    ["link", "notifySessionLink"],
    ["reschedule", 'kind: "SESSION_RESCHEDULED"'],
    ["cancel", 'kind: "SESSION_CANCELLED"'],
  ]) {
    ok(src.includes(needle), `42. the ${label} ceremony emits its event`);
  }
  ok(read("src/lib/absence-review.ts").includes("notifyAbsenceFinalized"), "42b. finalization notifies the absence");
  ok(read("src/lib/absence-review.ts").includes("notifyAbsenceReasonSubmitted"), "42c. a reason notifies the admins");
  ok(read("src/lib/absence-review.ts").includes("notifyAbsenceDecision"), "42d. a decision notifies the student/parents");
}

// ===========================================================================
section("F. UI source contracts, wiring and i18n (43–48)");
// ===========================================================================

// 43. Bug T — the notification surfaces scroll inside a bounded viewport and
//     never trap the page scroll.
{
  const panel = read("src/components/shared/notifications-panel.tsx");
  ok(
    !/className="[^"]*max-h-\[70vh\] overflow-y-auto/.test(panel),
    "43. the old inert scroll class is gone from every rendered element"
  );
  ok(
    panel.includes("max-h-[min(60dvh,calc(100dvh-15rem))]") && panel.includes("overscroll-contain"),
    "43b. the panel is bounded by the VIEWPORT and contains its overscroll"
  );
  ok(panel.includes("pb-1"), "43c. the last row's actions are reachable (bottom padding)");
  const admin = read("src/components/admin/admin-dashboard.tsx");
  ok(
    admin.includes("max-h-[min(52dvh,calc(100dvh-22rem))] min-h-0 overscroll-contain"),
    "43d. the admin notification list uses the same pattern"
  );
  for (const file of [
    "src/components/student/live-sessions-view.tsx",
    "src/components/teacher/live-sessions-workspace.tsx",
    "src/components/admin/live-ops-view.tsx",
  ]) {
    ok(read(file).includes("overscroll-contain"), `43e. ${file} contains its scroll`);
  }
}

// 44. Every Phase F view is wired in all four places that must agree.
{
  const store = read("src/lib/store.ts");
  const roles = read("src/lib/view-roles.ts");
  const shell = read("src/components/dashboard/shell.tsx");
  const appShell = read("src/components/app-shell.tsx");
  const views = [
    "student-sessions",
    "student-absences",
    "parent-absences",
    "teacher-live-sessions",
    "admin-live-sessions",
  ];
  for (const view of views) {
    ok(store.includes(`"${view}"`), `44. ${view} is a ViewKey`);
    ok(roles.includes(`"${view}"`), `44b. ${view} is in VIEWS_BY_ROLE`);
    ok(shell.includes(`key: "${view}"`), `44c. ${view} is in NAV_BY_ROLE`);
  }
  ok(appShell.includes("StudentLiveSessionsView") && appShell.includes("<StudentLiveSessionsView />"), "44d. the student schedule renders");
  ok(appShell.includes("TeacherLiveSessionsWorkspace") && appShell.includes("<TeacherLiveSessionsWorkspace />"), "44e. the teacher workspace renders");
  ok(appShell.includes("AdminLiveOpsView") && appShell.includes("<AdminLiveOpsView />"), "44f. the admin console renders");
  ok(appShell.includes("ParentAbsencesView") && appShell.includes("<ParentAbsencesView />"), "44g. the parent absence view renders");
  ok(appShell.includes("StudentAbsencesView"), "44h. the student absence view renders");
  // The live i18n/UI audit (tests/i18n/audit-ui.mjs) walks a hard-coded view
  // list. A view that renders but is never audited is a view whose Arabic,
  // console errors and layout are unverified — so the list must carry all five.
  const audit = read("tests/i18n/audit-ui.mjs");
  for (const view of views) {
    ok(audit.includes(`"${view}"`), `44i. ${view} is covered by the live UI audit`);
  }
}

// 45. Deep links: six kinds, role-aware Phase F targets, navigation order kept.
{
  const dl = read("src/lib/deep-link.ts");
  ok(dl.includes('"live"') && dl.includes('"absence"'), "45. the live/absence kinds parse");
  ok(dl.includes("DEEP_LINK_VIEWS_BY_ROLE") && dl.includes("resolveDeepLinkForRole"), "45b. role-aware resolution exists");
  ok(dl.includes("setView") && dl.indexOf("nav.setView") < dl.indexOf("nav.setNavParam"), "45c. setView still runs before setNavParam");
  const panel = read("src/components/shared/notifications-panel.tsx");
  ok(panel.includes("resolveDeepLinkForRole") && panel.includes("SessionLinkActions"), "45d. the panel uses the role-aware link and the structured actions");
}

// 46. Every Phase F dictionary key referenced in shipped code EXISTS.
{
  const files = [
    "src/lib/live-session-policy.ts",
    "src/lib/absence-policy.ts",
    "src/lib/live-session-notifications.ts",
    "src/lib/absence-review.ts",
    "src/components/shared/session-link-actions.tsx",
    "src/components/student/live-sessions-view.tsx",
    "src/components/teacher/live-sessions-workspace.tsx",
    "src/components/admin/live-ops-view.tsx",
  ];
  const dict = read("src/lib/i18n-dict.ts") + read("src/lib/i18n-dict-2026.ts");
  const missing = new Set();
  for (const file of files) {
    const src = read(file);
    for (const match of src.matchAll(/"((?:live|absence|teacher\.live|student\.live|student\.absences|parent\.absences|admin\.live|shell)\.[A-Za-z0-9_.]+)"/g)) {
      const key = match[1];
      if (!dict.includes(`"${key}"`)) missing.add(key);
    }
  }
  ok(missing.size === 0, `46. every referenced dictionary key exists (missing: ${[...missing].join(", ")})`);
}

// 47. No raw enum code is rendered: the label helpers cover EVERY enum value.
{
  const statuses = ["SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"];
  for (const status of statuses) {
    const key = P.sessionStatusLabelKey(status);
    ok(typeof key === "string" && key.startsWith("live.status."), `47. ${status} → ${key}`);
  }
  for (const status of ["PRESENT", "LATE", "ABSENT", "EXCUSED", "UNMARKED"]) {
    ok(P.attendanceStatusLabelKey(status).startsWith("live.attendance."), `47b. ${status} has a label key`);
  }
  for (const status of A.ABSENCE_REVIEW_STATUSES) {
    ok(A.absenceReviewStatusLabelKey(status).startsWith("absence.status."), `47c. ${status} has a label key`);
  }
  ok(A.absenceHoldStatusLabelKey("ACTIVE") === "absence.hold.active", "47d. hold states have label keys");
}

// 48. No dead buttons: the join/copy control always explains itself when it is
//     disabled, and the teacher's finalize explains the unmarked case.
{
  const actions = read("src/components/shared/session-link-actions.tsx");
  ok(
    actions.includes("denialLabel") && actions.includes("title={disabled ? denialLabel() : undefined}"),
    "48. a disabled join button always carries a reason"
  );
  ok(actions.includes("live.join.copyFailed") && actions.includes("document.execCommand"), "48b. the copy action degrades gracefully");
  const teacher = read("src/components/teacher/live-sessions-workspace.tsx");
  ok(teacher.includes("teacher.live.ackUnmarked") && teacher.includes("teacher.live.unmarkedWarn"), "48c. the finalize dialog states the unmarked rule");
  ok(teacher.includes("teacher.live.unsaved"), "48d. unsaved attendance is signalled");
  ok(teacher.includes("teacher.live.completion"), "48e. the completion counter is always visible");
  const adminView = read("src/components/admin/live-ops-view.tsx");
  ok(adminView.includes("admin.live.correctionReasonHint"), "48f. the correction dialog explains the mandatory reason");
  ok(adminView.includes("admin.live.repeatedAbsenceHint"), "48g. the repeated-absence signal is declared non-punitive");
}

// ---------------------------------------------------------------------------
// Real-SQLite invariants (part of §C/§D/§E, reported here so a missing node
// runtime degrades to a VISIBLE failure rather than a silent skip).
// ---------------------------------------------------------------------------
section("Real SQLite migration rehearsal (Phase F schema)");
if (!db) {
  ok(false, "DB1. the SQLite rehearsal could not run");
} else {
  ok(columnOk("LiveSession"), "DB1. LiveSession gains exactly the Phase F columns");
  ok(columnOk("Attendance"), "DB2. Attendance gains markedByUserId/markedAt/updatedAt");
  ok(columnOk("Notification"), "DB3. Notification gains sessionId/dedupeKey");
  ok(columnOk("AbsenceReview"), "DB4. AbsenceReview exists with the schema's columns");
  ok(columnOk("AbsenceReasonSubmission"), "DB5. AbsenceReasonSubmission exists");
  ok(columnOk("AbsenceHold"), "DB6. AbsenceHold exists (Phase H's state input)");
  ok(columnOk("AttendanceCorrection"), "DB7. AttendanceCorrection exists");

  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
    .all()
    .map((r) => r.name);
  ok(indexes.includes("Notification_userId_dedupeKey_key"), "DB8. the dedupe unique index exists");
  ok(indexes.includes("LiveSession_status_startAt_idx"), "DB9. the status/start index exists");
  ok(indexes.includes("AbsenceReview_attendanceId_key") || indexes.some((i) => i.includes("sqlite_autoindex_AbsenceReview")), "DB10. AbsenceReview.attendanceId is unique");

  db.exec(
    `INSERT INTO "User" ("id","email","password","name","role","isActive","createdAt","updatedAt")
     VALUES ('u1','a@b.c','x','A','STUDENT',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
  );
  db.exec(
    `INSERT INTO "Notification" ("id","userId","type","title","message","createdAt")
     VALUES ('n1','u1','SESSION_LINK','t','m',CURRENT_TIMESTAMP),
            ('n2','u1','SESSION_LINK','t','m',CURRENT_TIMESTAMP)`
  );
  ok(
    db.prepare(`SELECT COUNT(*) AS c FROM "Notification"`).get().c === 2,
    "DB11. NULL dedupe keys stay distinct (pre-Phase-F rows are untouched)"
  );
  db.exec(
    `INSERT INTO "Notification" ("id","userId","type","title","message","dedupeKey","createdAt")
     VALUES ('n3','u1','SESSION_LINK','t','m','SESSION_LINK:s1',CURRENT_TIMESTAMP)`
  );
  let duplicateRefused = false;
  try {
    db.exec(
      `INSERT INTO "Notification" ("id","userId","type","title","message","dedupeKey","createdAt")
       VALUES ('n4','u1','SESSION_LINK','t','m','SESSION_LINK:s1',CURRENT_TIMESTAMP)`
    );
  } catch {
    duplicateRefused = true;
  }
  ok(duplicateRefused, "DB12. the DATABASE refuses a duplicate (user, dedupeKey)");

  let secondCaseRefused = false;
  try {
    db.exec(`INSERT INTO "LiveSession" ("id","groupId","title","titleAr","startAt","duration") VALUES ('s1','g1','t','ت',CURRENT_TIMESTAMP,60)`);
    db.exec(`INSERT INTO "Attendance" ("id","studentId","sessionId","status") VALUES ('a1','stu1','s1','ABSENT')`);
    db.exec(`INSERT INTO "AbsenceReview" ("id","attendanceId","studentId","sessionId","groupId","status") VALUES ('r1','a1','stu1','s1','g1','PENDING_REASON')`);
    db.exec(`INSERT INTO "AbsenceReview" ("id","attendanceId","studentId","sessionId","groupId","status") VALUES ('r2','a1','stu1','s1','g1','PENDING_REASON')`);
  } catch {
    secondCaseRefused = true;
  }
  ok(secondCaseRefused, "DB13. a second case for the same attendance row is impossible (idempotency by DB)");
}

// ---------------------------------------------------------------------------
console.log(`\nPhase F suite: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
