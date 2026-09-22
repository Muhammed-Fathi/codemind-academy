// CodeMind Academy — Teacher Readiness reminder RECIPIENTS (audience choice).
//
// The teacher's `تذكير` sends to a CONTROLLED audience — STUDENT, PARENT, or
// BOTH (defaulting to the historical parent-only send when the field is
// absent). The request carries ONLY the mode: the student leg resolves the
// student's own user row server-side and notifies through the ONE idempotent
// insert primitive (per-student per-lesson per-day dedupe, preferences +
// quiet hours honoured, server-minted `lesson:` deep link); the parent leg
// is the byte-preserved teacher-note fan-out. No free-form text, no
// client-supplied destination, no generic teacher-messaging API.
//
// PINNED BEHAVIOR (T1–T16):
//   T1.  legacy (no audience) → 201, exact historical shape, parent-only.
//   T2.  audience=PARENT → identical to legacy.
//   T3.  audience=STUDENT → one READINESS_REMINDER for the student user row
//        (type/link/copy/dedupe), no note, no parent delivery.
//   T4.  audience=BOTH → note + parent ANNOUNCEMENT + student notification.
//   T5.  present-but-unknown audience → 400 api.367, nothing written.
//   T6.  STUDENT twice, same day → second is a 200 duplicate, one row total.
//   T7.  STUDENT in quiet hours → 200 skipped_quiet_hours, nothing written.
//   T8.  STUDENT inactive → 200 unavailable, nothing written.
//   T9.  BOTH with no linked parent → 201 partial (note + student, 0 parents).
//   T10. BOTH with a quiet student + linked parent → 201 partial (parent
//        sent, student skipped).
//   T11. READY student + any audience → 409 api.366, nothing written.
//   T12. guards: unknown student / foreign lesson → 404, student → 403,
//        anonymous → 401.
//   T13. parent leg byte-preserved: templated note, ANNOUNCEMENT, null link,
//        TEACHER_NOTE_CREATE audit.
//   T14. no duplicate recipient, no leak: exact row deltas, student link
//        resolves to the student lesson view, parent link stays null.
//   T15. schema/migration/label/dictionary pins (both providers + baseline).
//   T16. source pins + helper unit matrix (audience resolution, pending
//        bits incl. the video templates, empty-bits fallback).
//
// What is REAL here: the compiled shipped route handler + helper, the SQLite
// database built from the real migration SQL (including the recipients
// migration), the readiness engine, the teacher-notes fan-out, the
// idempotent insert primitive. What is SHIMMED: the Prisma engine
// (sqlite-prisma-lite over node:sqlite), auth (script-controlled user),
// next/server, next/headers.
//
// Run: node --test tests/teacher-readiness-reminder-recipients.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert");

const REPO = path.resolve(__dirname, "..");

// Media env MUST be set before the compiled media.js module loads (it reads
// these at import time, exactly like production).
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-remind-media-"));
process.env.MEDIA_STORAGE_PATH = MEDIA_DIR;
process.env.MEDIA_BACKEND = "local";
process.env.MEDIA_MAX_VIDEO_BYTES = String(1024 * 1024);
process.env.SECURITY_HASH_SECRET = "s".repeat(64);

// Empirical NO-NETWORK guard: any TCP connect attempt fails loudly.
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(`remind test made a network connection attempt: ${JSON.stringify(args[0])}`);
  };
  process.on("exit", () => {
    net.Socket.prototype.connect = realConnect;
  });
}

const { DatabaseSync } = require("node:sqlite");
const mig = require(path.join(REPO, "scripts", "lib", "migrate-sqlite.mjs"));
const { createSqlitePrisma } = require(path.join(REPO, "scripts", "lib", "sqlite-prisma-lite.mjs"));

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error("FAIL:", label);
  }
}
function eq(got, want, label) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b, `${label} (got ${a}, want ${b})`);
}
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ---------------------------------------------------------------------------
// Scratch database: base DDL + every real migration (incl. recipients).
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "remind: " });
const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

// ---------------------------------------------------------------------------
// Compile the shipped TypeScript with the repo's own tsc; load with shims.
// ---------------------------------------------------------------------------
const REAL_CODE_MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n-server.ts",
  "src/lib/env.ts",
  "src/lib/security.ts",
  "src/lib/media.ts",
  "src/lib/video-url.ts",
  "src/lib/session-video-link.ts",
  "src/lib/video-applicability.ts",
  "src/lib/lesson-readiness.ts",
  "src/lib/teacher-notes.ts",
  "src/lib/notify.ts",
  "src/lib/storage-quotas.ts",
  "src/lib/subscription-entitlement.ts",
  "src/lib/enrollment.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/curriculum-visibility.ts",
  "src/lib/parent-access.ts",
  "src/lib/session-materials.ts",
  "src/lib/session-quiz.ts",
  "src/lib/quiz-blueprint.ts",
  "src/lib/rate-limit.ts",
  "src/lib/api.ts",
  // The student-leg closure: the deep-link scheme, the idempotent insert
  // primitive + its policy/label leaves, and the recipients helper itself.
  "src/lib/deep-link.ts",
  "src/lib/notification-links.ts",
  "src/lib/notification-labels.ts",
  "src/lib/live-session-policy.ts",
  "src/lib/live-session-notifications.ts",
  "src/lib/readiness-reminders.ts",
  // route handler under test
  "src/app/api/teacher/readiness/remind/route.ts",
];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-remind-compile-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "es2020",
        module: "commonjs",
        moduleResolution: "node",
        strict: false,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        allowJs: false,
        types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")],
        baseUrl: REPO,
        paths: { "@/*": ["src/*"] },
        rootDir: REPO,
        outDir: OUT,
      },
      files: REAL_CODE_MODULES.map((f) => path.join(REPO, f)),
    },
    null,
    2
  )
);
try {
  execFileSync(
    process.execPath,
    [path.join(REPO, "node_modules", "typescript", "lib", "tsc.js"), "-p", path.join(OUT, "tsconfig.json")],
    { cwd: REPO, stdio: "pipe" }
  );
} catch {
  /* type noise tolerated — the emitted files matter */
}
for (const f of REAL_CODE_MODULES) {
  const emitted = path.join(OUT, f.replace(/\.ts$/, ".js"));
  assert.ok(fs.existsSync(emitted), `tsc emitted ${f}`);
}
const EMIT = path.join(OUT, "src");

// ---------------------------------------------------------------------------
// Shims: db → the real sqlite client, auth → script-controlled user.
// ---------------------------------------------------------------------------
const NEXT_SERVER_SHIM = `
class NextResponse {
  constructor(body, init = {}) {
    this.status = init.status ?? 200;
    this._headers = new Map();
    const h = init.headers || {};
    for (const [k, v] of Object.entries(h)) this._headers.set(String(k).toLowerCase(), String(v));
    this._body = body;
    this._json = undefined;
  }
  static json(data, init = {}) {
    const r = new NextResponse(JSON.stringify(data), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
    r._json = data;
    return r;
  }
  get headers() {
    const m = this._headers;
    return { get: (k) => m.get(String(k).toLowerCase()) ?? null };
  }
  async json() {
    if (this._json !== undefined) return this._json;
    return JSON.parse(String(this._body ?? ""));
  }
}
class NextRequest {}
module.exports = { NextResponse, NextRequest };
`;
const SHIM_FILES = {
  "__db-shim.js": `module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };`,
  "__auth-shim.js": `module.exports = { getCurrentUser: async () => globalThis.__CM_USER__ ?? null };`,
  "__next-server-shim.js": NEXT_SERVER_SHIM,
  "__next-headers-shim.js": `module.exports = { cookies: async () => ({ get: () => undefined }) };`,
};
for (const [name, code] of Object.entries(SHIM_FILES)) {
  fs.writeFileSync(path.join(OUT, name), code);
}
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return path.join(OUT, "__db-shim.js");
  if (request === "@/lib/auth") return path.join(OUT, "__auth-shim.js");
  if (request === "next/server") return path.join(OUT, "__next-server-shim.js");
  if (request === "next/headers") return path.join(OUT, "__next-headers-shim.js");
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, "lib", `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  try {
    return originalResolve.call(this, request, ...rest);
  } catch (err) {
    if (request.startsWith(".") || path.isAbsolute(request)) throw err;
    return require.resolve(request, { paths: [path.join(REPO, "node_modules")] });
  }
};
const route = (p) => require(path.join(OUT, "src/app/api", p));
const R = {
  remind: route("teacher/readiness/remind/route.js"),
};
// The compiled helper + deep-link parser (unit pins, T14/T16).
const RR = require(path.join(EMIT, "lib", "readiness-reminders.js"));
const DL = require(path.join(EMIT, "lib", "deep-link.js"));

// ---------------------------------------------------------------------------
// HTTP-lite driver (same shape as the Phase A/B e2e).
// ---------------------------------------------------------------------------
function jsonReq(url, body) {
  return {
    url,
    method: "POST",
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
    formData: async () => {
      throw new Error("no form body");
    },
  };
}
function asUser(u) {
  globalThis.__CM_USER__ = u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null;
}
async function call(handler, req, params) {
  const res = await handler(req, { params: Promise.resolve(params || {}) });
  return { status: res.status, json: await res.json() };
}
const POST_JSON = (r, url, body, params) => call(r.POST, jsonReq(url, body), params);

// ---------------------------------------------------------------------------
test("Teacher readiness reminder recipients (T1–T16)", async () => {
  // ===========================================================================
  // Seed — one course, one lesson with a published quiz + homework (both
  // required, so a fresh student is NOT READY), one teacher group:
  //   sA — active, linked parent pA (happy paths)
  //   sB — active, NO parent (no-parent partial)
  //   sC — active, quiet-hours prefs + linked parent pC (skip partial)
  //   sD — INACTIVE user (unavailable)
  //   sE — active (student-only send)
  //   sReady — quiz passed + homework submitted (409 target)
  // ===========================================================================
  const course = await client.course.create({
    data: { slug: "remind-a", name: "Course A", nameAr: "كورس أ", description: "remind" },
  });
  const part = await client.part.create({
    data: { courseId: course.id, title: "P1", titleAr: "P1", order: 1 },
  });
  const unit = await client.unit.create({
    data: { partId: part.id, title: "U1", titleAr: "U1", order: 1 },
  });
  const L1 = await client.lesson.create({
    data: {
      unitId: unit.id, order: 1, officialCode: "1-1",
      title: "Fractions", titleAr: "الكسور",
      trackScope: "SHARED", status: "PUBLISHED",
      curriculumStatus: "OFFICIAL", isPublished: true,
    },
  });
  const batch = await client.batch.create({
    data: { name: "Batch", nameAr: "دفعة", schoolType: "ARABIC", courseId: course.id },
  });
  const teacherUser = await client.user.create({
    data: { email: "t@remind.test", password: "x", name: "T Mona", role: "TEACHER" },
  });
  const teacher = await client.teacher.create({ data: { userId: teacherUser.id } });
  const group = await client.group.create({
    data: { name: "G1", courseId: course.id, teacherId: teacher.id, trackScope: "ARABIC", isActive: true },
  });
  // A second teacher's group in a FOREIGN course (scope-closed lesson).
  const course2 = await client.course.create({
    data: { slug: "remind-b", name: "Course B", nameAr: "كورس ب", description: "remind" },
  });
  const part2 = await client.part.create({
    data: { courseId: course2.id, title: "P1", titleAr: "P1", order: 1 },
  });
  const unit2 = await client.unit.create({
    data: { partId: part2.id, title: "U1", titleAr: "U1", order: 1 },
  });
  const Lother = await client.lesson.create({
    data: {
      unitId: unit2.id, order: 1, officialCode: "9-9",
      title: "Foreign", titleAr: "أجنبي",
      trackScope: "SHARED", status: "PUBLISHED",
      curriculumStatus: "OFFICIAL", isPublished: true,
    },
  });
  const mkStudent = async (tag, userOver = {}) => {
    const u = await client.user.create({
      data: { email: `${tag}@remind.test`, password: "x", name: tag, role: "STUDENT", ...userOver },
    });
    const s = await client.student.create({
      data: { userId: u.id, schoolType: "ARABIC", groupId: group.id, batchId: batch.id },
    });
    return { user: u, student: s };
  };
  const sA = await mkStudent("s-a");
  const sB = await mkStudent("s-b");
  const sC = await mkStudent("s-c");
  const sD = await mkStudent("s-d", { isActive: false });
  const sE = await mkStudent("s-e");
  const sReady = await mkStudent("s-ready");
  const mkParent = async (tag, student) => {
    const u = await client.user.create({
      data: { email: `${tag}@remind.test`, password: "x", name: tag, role: "PARENT" },
    });
    const p = await client.parent.create({ data: { userId: u.id } });
    await client.parentStudentLink.create({ data: { parentId: p.id, studentId: student.student.id } });
    return { user: u, parent: p };
  };
  const pA = await mkParent("p-a", sA);
  const pC = await mkParent("p-c", sC);
  // sC sits inside quiet hours RIGHT NOW (a ±60min local window).
  const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  await client.notificationPreference.create({
    data: {
      userId: sC.user.id,
      quietHoursStart: hhmm(new Date(Date.now() - 60 * 60 * 1000)),
      quietHoursEnd: hhmm(new Date(Date.now() + 60 * 60 * 1000)),
    },
  });
  const Q1 = await client.quiz.create({
    data: { lessonId: L1.id, title: "Quiz One", titleAr: "اختبار واحد", status: "PUBLISHED" },
  });
  const H1 = await client.homework.create({
    data: {
      lessonId: L1.id, title: "HW One", titleAr: "واجب واحد",
      deadline: new Date("2026-10-01T00:00:00Z"), status: "PUBLISHED",
    },
  });
  await client.quizAttempt.create({
    data: { quizId: Q1.id, studentId: sReady.student.id, finishedAt: new Date(), passed: true, percentage: 90 },
  });
  await client.homeworkSubmission.create({
    data: { homeworkId: H1.id, studentId: sReady.student.id, submittedAt: new Date() },
  });

  const REMIND_URL = "http://t/api/teacher/readiness/remind";
  const remindAs = (user, body) => {
    asUser(user);
    return POST_JSON(R.remind, REMIND_URL, body);
  };
  const notesFor = (studentId) => client.teacherNote.findMany({ where: { studentId } });
  const notifsFor = (userId) => client.notification.findMany({ where: { userId } });
  const dayKey = new Date().toISOString().slice(0, 10);

  // ===========================================================================
  // T1. Legacy (no audience) → 201, exact historical shape, parent-only.
  // ===========================================================================
  const t1 = await remindAs(teacherUser, { studentId: sA.student.id, lessonId: L1.id });
  eq(t1.status, 201, "T1: legacy remind → 201");
  eq(t1.json.audience, "PARENT", "T1: absent audience resolves to PARENT");
  eq(t1.json.notifiedParents, 1, "T1: exactly the linked parent is notified");
  ok(!!t1.json.note?.id, "T1: the legacy top-level note shape is present");
  eq(t1.json.student, { status: "not_requested", notified: 0 }, "T1: the student leg is explicitly not requested");
  eq(t1.json.parent.status, "sent", "T1: the parent leg reports sent");
  eq((await notifsFor(sA.user.id)).length, 0, "T1: NO notification row for the student");

  // ===========================================================================
  // T2. audience=PARENT → identical to legacy.
  // ===========================================================================
  const t2 = await remindAs(teacherUser, { studentId: sA.student.id, lessonId: L1.id, audience: "PARENT" });
  eq(t2.status, 201, "T2: explicit PARENT → 201");
  eq(t2.json.audience, "PARENT", "T2: the effective audience is echoed");
  eq(t2.json.notifiedParents, 1, "T2: exactly the linked parent is notified");
  eq(t2.json.student, { status: "not_requested", notified: 0 }, "T2: the student leg is explicitly not requested");
  eq((await notesFor(sA.student.id)).length, 2, "T2: the second parent send writes its second note");
  eq((await notifsFor(sA.user.id)).length, 0, "T2: still NO notification row for the student");

  // ===========================================================================
  // T3. audience=STUDENT → one READINESS_REMINDER for the student user row.
  // ===========================================================================
  const t3 = await remindAs(teacherUser, { studentId: sE.student.id, lessonId: L1.id, audience: "STUDENT" });
  eq(t3.status, 201, "T3: STUDENT → 201");
  eq(t3.json.audience, "STUDENT", "T3: the effective audience is echoed");
  eq(t3.json.note, null, "T3: no teacher note is written");
  eq(t3.json.notifiedParents, 0, "T3: no parent is notified");
  eq(t3.json.student, { status: "sent", notified: 1 }, "T3: the student leg reports sent");
  eq(t3.json.parent.status, "not_requested", "T3: the parent leg is explicitly not requested");
  const t3rows = await notifsFor(sE.user.id);
  eq(t3rows.length, 1, "T3: ONE notification row for the student");
  eq(t3rows[0].type, "READINESS_REMINDER", "T3: the new student-nudge type");
  eq(t3rows[0].title, "تذكير بمتطلبات درس «الكسور»", "T3: the title names the lesson (exact)");
  ok(
    t3rows[0].message.startsWith("تذكير بمتطلبات درس «الكسور»: ") &&
    t3rows[0].message.includes("الاختبار: اختبار واحد") &&
    t3rows[0].message.includes("الواجب: واجب واحد"),
    "T3: the message lists the server-derived pending requirements"
  );
  eq(t3rows[0].link, `lesson:${L1.id}`, "T3: the server-minted lesson deep link");
  eq(t3rows[0].dedupeKey, `READINESS_REMINDER:${sE.student.id}:${L1.id}:${dayKey}`, "T3: the per-student per-lesson per-day dedupe key");

  // ===========================================================================
  // T4. audience=BOTH → note + parent ANNOUNCEMENT + student notification.
  // ===========================================================================
  const t4 = await remindAs(teacherUser, { studentId: sA.student.id, lessonId: L1.id, audience: "BOTH" });
  eq(t4.status, 201, "T4: BOTH → 201");
  eq(t4.json.audience, "BOTH", "T4: the effective audience is echoed");
  ok(!!t4.json.note?.id, "T4: the teacher note is written");
  eq(t4.json.notifiedParents, 1, "T4: the linked parent is notified");
  eq(t4.json.student, { status: "sent", notified: 1 }, "T4: the student leg reports sent");
  eq(t4.json.parent.status, "sent", "T4: the parent leg reports sent");
  eq((await notesFor(sA.student.id)).length, 3, "T4: the third note for sA exists");
  eq((await notifsFor(sA.user.id)).length, 1, "T4: ONE notification row for the student");

  // ===========================================================================
  // T5. Present-but-unknown audience → 400 api.367, nothing written.
  // ===========================================================================
  const notesBefore = (await client.teacherNote.findMany({})).length;
  const notifsBefore = (await client.notification.findMany({})).length;
  for (const bad of ["SMS", 123, ["BOTH"]]) {
    const t5 = await remindAs(teacherUser, { studentId: sA.student.id, lessonId: L1.id, audience: bad });
    eq(t5.status, 400, `T5: audience ${JSON.stringify(bad)} → 400`);
    eq(t5.json.error, "وضع الإرسال غير صالح.", `T5: the Arabic message is exact (api.367) for ${JSON.stringify(bad)}`);
  }
  eq((await client.teacherNote.findMany({})).length, notesBefore, "T5: no note is written for a bad audience");
  eq((await client.notification.findMany({})).length, notifsBefore, "T5: no notification is written for a bad audience");

  // ===========================================================================
  // T6. STUDENT twice, same day → the second is a 200 duplicate, one row.
  // ===========================================================================
  const t6 = await remindAs(teacherUser, { studentId: sA.student.id, lessonId: L1.id, audience: "STUDENT" });
  eq(t6.status, 200, "T6: the same-day repeat → 200 (nothing new written)");
  eq(t6.json.student, { status: "duplicate", notified: 0 }, "T6: the duplicate is reported, not silent");
  eq((await notifsFor(sA.user.id)).length, 1, "T6: still ONE notification row for the student");

  // ===========================================================================
  // T7. STUDENT in quiet hours → 200 skipped_quiet_hours, nothing written.
  // ===========================================================================
  const t7 = await remindAs(teacherUser, { studentId: sC.student.id, lessonId: L1.id, audience: "STUDENT" });
  eq(t7.status, 200, "T7: quiet-hours student → 200 (nothing new written)");
  eq(t7.json.student, { status: "skipped_quiet_hours", notified: 0 }, "T7: the quiet-hours skip is reported, not silent");
  eq((await notifsFor(sC.user.id)).length, 0, "T7: NO notification row for the quiet student");

  // ===========================================================================
  // T8. STUDENT inactive → 200 unavailable, nothing written.
  // ===========================================================================
  const t8 = await remindAs(teacherUser, { studentId: sD.student.id, lessonId: L1.id, audience: "STUDENT" });
  eq(t8.status, 200, "T8: inactive student → 200 (nothing new written)");
  eq(t8.json.student, { status: "unavailable", notified: 0 }, "T8: the unavailability is reported, not silent");
  eq((await notifsFor(sD.user.id)).length, 0, "T8: NO notification row for the inactive student");

  // ===========================================================================
  // T9. BOTH with no linked parent → 201 partial (note + student, 0 parents).
  // ===========================================================================
  const t9 = await remindAs(teacherUser, { studentId: sB.student.id, lessonId: L1.id, audience: "BOTH" });
  eq(t9.status, 201, "T9: BOTH with no parent → 201 (partial, explicit)");
  ok(!!t9.json.note?.id, "T9: the teacher note is still written");
  eq(t9.json.notifiedParents, 0, "T9: zero parents notified (safe no-parent handling)");
  eq(t9.json.student, { status: "sent", notified: 1 }, "T9: the student leg reports sent");
  eq((await notifsFor(sB.user.id)).length, 1, "T9: ONE notification row for the student");

  // ===========================================================================
  // T10. BOTH with a quiet student + linked parent → 201 partial.
  // ===========================================================================
  const t10 = await remindAs(teacherUser, { studentId: sC.student.id, lessonId: L1.id, audience: "BOTH" });
  eq(t10.status, 201, "T10: BOTH with a quiet student → 201 (partial, explicit)");
  eq(t10.json.notifiedParents, 1, "T10: the linked parent IS notified");
  eq(t10.json.student, { status: "skipped_quiet_hours", notified: 0 }, "T10: the student skip is reported alongside");
  eq((await notifsFor(sC.user.id)).length, 0, "T10: still NO notification row for the quiet student");

  // ===========================================================================
  // T11. READY student + any audience → 409 api.366, nothing written.
  // ===========================================================================
  for (const aud of ["BOTH", "STUDENT"]) {
    const t11 = await remindAs(teacherUser, { studentId: sReady.student.id, lessonId: L1.id, audience: aud });
    eq(t11.status, 409, `T11: READY + ${aud} → 409`);
    eq(t11.json.error, "لا يمكن التذكير — الطالب جاهز.", `T11: the Arabic message is exact (api.366) for ${aud}`);
  }
  eq((await notesFor(sReady.student.id)).length, 0, "T11: no note for the ready student");
  eq((await notifsFor(sReady.user.id)).length, 0, "T11: no notification for the ready student");

  // ===========================================================================
  // T12. Guards: unknown student / foreign lesson → 404, student → 403,
  // anonymous → 401.
  // ===========================================================================
  const t12a = await remindAs(teacherUser, { studentId: "nope", lessonId: L1.id, audience: "BOTH" });
  eq(t12a.status, 404, "T12: unknown student → 404");
  eq(t12a.json.error, "الطالب ده غير متاح", "T12: the Arabic message is exact (api.299)");
  const t12b = await remindAs(teacherUser, { studentId: sA.student.id, lessonId: Lother.id, audience: "STUDENT" });
  eq(t12b.status, 404, "T12: foreign lesson → 404");
  const t12c = await remindAs(sA.user, { studentId: sA.student.id, lessonId: L1.id, audience: "BOTH" });
  eq(t12c.status, 403, "T12: a student → 403");
  const t12d = await remindAs(null, { studentId: sA.student.id, lessonId: L1.id, audience: "BOTH" });
  eq(t12d.status, 401, "T12: anonymous → 401");

  // ===========================================================================
  // T13. Parent leg byte-preserved: templated note, ANNOUNCEMENT, null link,
  // TEACHER_NOTE_CREATE audit.
  // ===========================================================================
  const t13note = await client.teacherNote.findUnique({ where: { id: t1.json.note.id } });
  ok(t13note.note.startsWith("تذكير بمتطلبات درس"), "T13: the reminder IS a teacher note (templated, fixed structure)");
  ok(
    t13note.note.includes("«الكسور»") &&
    t13note.note.includes("الاختبار: اختبار واحد") &&
    t13note.note.includes("الواجب: واجب واحد"),
    "T13: the note lists the lesson + exactly what is pending"
  );
  const t13notif = await notifsFor(pA.user.id);
  eq(t13notif.length, 3, "T13: three parent notifications (T1 + T2 + T4)");
  eq(t13notif[0].type, "ANNOUNCEMENT", "T13: the EXISTING announcement type (no new subsystem)");
  eq(t13notif[0].link ?? null, null, "T13: no deep link (scope-safe, like manual notes)");
  const t13audit = await client.auditLog.findMany({ where: { action: "TEACHER_NOTE_CREATE", entityId: t1.json.note.id } });
  eq(t13audit.length, 1, "T13: the send is audited (TEACHER_NOTE_CREATE)");

  // ===========================================================================
  // T14. No duplicate recipient, no leak: exact row deltas, student link
  // resolves to the student lesson view, parent link stays null.
  // ===========================================================================
  const t4studentRows = await client.notification.findMany({
    where: { userId: sA.user.id, type: "READINESS_REMINDER" },
  });
  eq(t4studentRows.length, 1, "T14: BOTH wrote EXACTLY one student notification");
  const t4parentRows = await client.notification.findMany({
    where: { userId: pA.user.id, type: "ANNOUNCEMENT" },
  });
  eq(t4parentRows.length, 3, "T14: the three parent sends wrote EXACTLY three parent notifications");
  const parsed = DL.parseDeepLink(t4studentRows[0].link);
  eq(parsed, { kind: "lesson", id: L1.id }, "T14: the student link parses to the lesson deep link");
  eq(
    DL.resolveDeepLinkForRole(t4studentRows[0].link, "STUDENT"),
    { view: "student-lesson", navParam: L1.id },
    "T14: the link lands the student on the unified lesson page"
  );
  ok(!t4studentRows[0].message.includes("p-a"), "T14: the student copy carries no parent info");
  ok(!t13notif[0].message.includes("lesson:"), "T14: the parent copy carries no deep link");

  // ===========================================================================
  // T15. Schema / migration / label / dictionary pins (both providers +
  // baseline).
  // ===========================================================================
  for (const schema of ["prisma/schema.prisma", "prisma/postgres/schema.prisma"]) {
    const src = read(schema);
    ok(/ABSENCE_REMINDER\n(?:\s*\/\/\/[^\n]*\n)*\s*READINESS_REMINDER\n\}/.test(src), `T15: ${schema} appends READINESS_REMINDER last in NotificationType`);
  }
  const labels = read("src/lib/notification-labels.ts");
  ok(labels.includes('READINESS_REMINDER: "notif.type.readinessReminder"'), "T15: the label map covers the new type");
  const dict = read("src/lib/i18n-dict-2026.ts");
  ok(dict.includes('"notif.type.readinessReminder": { ar: "تذكير بمتطلبات الدرس", en: "Lesson readiness reminder" }'), "T15: the type label is localized");
  ok(dict.includes('"api.367": { ar: "وضع الإرسال غير صالح.", en: "Invalid reminder audience." }'), "T15: api.367 is localized");
  for (const key of ["remindTo", "remindStudent", "remindParent", "remindBoth", "remindSend", "remindCancel", "remindedStudent", "remindedBoth", "remindDuplicate", "remindSkipped", "remindUnavailable", "remindNoParent"]) {
    ok(dict.includes(`"teacher.readiness.${key}"`), `T15: teacher.readiness.${key} exists (ar+en)`);
  }
  const migSqlite = read("prisma/migrations/20260922090000_readiness_reminder_recipients/migration.sql");
  const migPg = read("prisma/postgres/migrations/20260922090000_readiness_reminder_recipients/migration.sql");
  const stripComments = (s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  eq(stripComments(migSqlite).trim(), "", "T15: the SQLite edition is DDL-free (enums are TEXT)");
  ok(/READINESS_REMINDER/.test(migSqlite), "T15: the SQLite edition documents the new label");
  eq((stripComments(migPg).match(/ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'READINESS_REMINDER';/g) || []).length, 1, "T15: the PG edition appends exactly the new label");
  ok(migSqlite !== migPg, "T15: the two editions are distinct provider-specific files");
  const baseline = read("scripts/db/postgres-baseline.sql");
  ok(/'ABSENCE_REMINDER', 'READINESS_REMINDER'\)/.test(baseline), "T15: the PG baseline carries the new label last");

  // ===========================================================================
  // T16. Source pins + helper unit matrix.
  // ===========================================================================
  const remindSrc = read("src/app/api/teacher/readiness/remind/route.ts");
  ok(/createTeacherNoteWithFanout/.test(remindSrc), "T16: the parent leg sends through the SHARED notes helper");
  ok(/sendReadinessReminderToStudent/.test(remindSrc), "T16: the student leg sends through the recipients helper");
  ok(!/notification\.create|createNotification\(/.test(remindSrc), "T16: no direct notification write in the remind route");
  const helperSrc = read("src/lib/readiness-reminders.ts");
  ok(/insertNotificationOnce/.test(helperSrc), "T16: the helper uses the ONE idempotent insert primitive");
  ok(/mintNotificationLink\("lesson"/.test(helperSrc), "T16: the helper mints the lesson deep link canonically");
  ok(!/mandatory:\s*true/.test(helperSrc), "T16: the student leg is never mandatory (prefs + quiet hours apply)");
  const viewSrc = read("src/components/teacher/readiness-view.tsx");
  ok(/teacher\.readiness\.remindTo/.test(viewSrc), "T16: the dialog names its audience question");
  ok(/teacher\.readiness\.remindStudent/.test(viewSrc) && /teacher\.readiness\.remindParent/.test(viewSrc) && /teacher\.readiness\.remindBoth/.test(viewSrc), "T16: the dialog offers exactly the three controlled options");
  ok(/useState<"(STUDENT|PARENT|BOTH)"[^>]*>\("BOTH"\)/.test(viewSrc), "T16: the dialog defaults to BOTH");
  ok(/from "@\/components\/ui\/dialog"/.test(viewSrc), "T16: the dialog is the themed component (never native)");
  // Audience resolution: absent → PARENT, valid → itself, garbage → null.
  eq(RR.resolveReminderAudience(undefined), "PARENT", "T16: absent audience → PARENT");
  eq(RR.resolveReminderAudience(null), "PARENT", "T16: null audience → PARENT");
  eq(RR.resolveReminderAudience(""), "PARENT", "T16: empty audience → PARENT");
  for (const aud of ["STUDENT", "PARENT", "BOTH"]) {
    eq(RR.resolveReminderAudience(aud), aud, `T16: ${aud} resolves to itself`);
  }
  for (const bad of ["SMS", "student", "both ", 0, 123, {}, [], true]) {
    eq(RR.resolveReminderAudience(bad), null, `T16: ${JSON.stringify(bad)} is refused (null)`);
  }
  // Pending bits: the video templates + the empty fallback (pure units).
  const rowWith = (over) => ({
    video: { required: false, done: false, items: [] },
    quiz: { required: false, done: false, pending: [] },
    homework: { required: false, done: false, pending: [] },
    ...over,
  });
  eq(
    RR.buildReadinessPendingBits(rowWith({ video: { required: true, done: false, items: [{ completed: false, currentPercent: 40, requiredPercent: 95 }] } })),
    ["الفيديو: 40% من 95%"],
    "T16: one pending video renders its percents"
  );
  eq(
    RR.buildReadinessPendingBits(rowWith({ video: { required: true, done: false, items: [{ completed: false }, { completed: false }, { completed: true }] } })),
    ["الفيديو: 2 فيديوهات غير مكتملة"],
    "T16: several pending videos render their count"
  );
  eq(
    RR.buildReadinessPendingBits(rowWith({ video: { required: true, done: false, items: [] } })),
    ["الفيديو: غير مكتمل"],
    "T16: required-but-itemless video renders the fallback bit"
  );
  eq(RR.buildReminderText("الكسور", []), "تذكير بمتطلبات درس «الكسور»: غير جاهز.", "T16: empty bits render the not-ready fallback");

  if (fail > 0) throw new Error(`${fail} assertion(s) failed:\n- ` + failures.join("\n- "));
});
