// CodeMind Academy — POST-LAUNCH verifier: notifications, teacher→parent
// notes, plan management lifecycle.
//
// Drives the SHIPPED route handlers (compiled from src/ with the repo's own
// tsc, exactly like scripts/verify-phase26c-admin.mjs and
// scripts/verify-phase26e-parent.mjs) against a REAL SQLite database built
// from the base DDL + every real migration.
//
// What is REAL: the migration SQL, the schema, the compiled handlers, the
// preference contract (src/lib/notify.ts), the deep-link scheme
// (src/lib/deep-link.ts + notification-links.ts), the plan safe-delete
// guards, the entitlement resolver, and the enrollment plan-availability
// gate.
//
// What is SHIMMED (and why):
//   * `@/lib/db`    → sqlite-prisma-lite over node:sqlite (real SQL).
//   * `@/lib/auth`  → script-controlled current user (requireUser still
//                     runs for real, so every role gate is genuinely
//                     enforced).
//   * `next/server` / `next/headers` → minimal stand-ins.
//
// NO Neon, NO R2, NO SMTP, NO Vercel. Refuses to run if DATABASE_URL points
// at postgres/neon. Exit code 0 + "0 failed" iff every assertion holds.
// Executed as a child process by tests/post-launch-notifications.test.js.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const { DatabaseSync } = require("node:sqlite");
const mig = require("./lib/migrate-sqlite.mjs");
const { createSqlitePrisma } = require("./lib/sqlite-prisma-lite.mjs");

// ---------------------------------------------------------------------------
// 0. production safety gate
// ---------------------------------------------------------------------------
const envUrl = process.env.DATABASE_URL || "";
if (/postgres|neon/i.test(envUrl)) {
  console.error(
    `[POST-LAUNCH] refusing to run: DATABASE_URL looks like production (${envUrl.slice(0, 40)}…)`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// assertion plumbing
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) {
    passed += 1;
    console.log(`ok - ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL - ${label}${extra !== undefined ? ` :: ${extra}` : ""}`);
  }
}
function eq(a, b, label) {
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`
  );
}
function section(t) {
  console.log(`\n== ${t} ==`);
}

// ---------------------------------------------------------------------------
// A. scratch database: base DDL + every real migration
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "post-launch: " });

const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

// ---------------------------------------------------------------------------
// B. compile the shipped TypeScript; load with shims
// ---------------------------------------------------------------------------
const REAL_CODE_MODULES = [
  // pure contracts under test
  "src/lib/deep-link.ts",
  "src/lib/notification-links.ts",
  "src/lib/notify.ts",
  "src/lib/subscription-entitlement.ts",
  // notification surfaces
  "src/app/api/admin/notifications/route.ts",
  "src/app/api/notifications/route.ts",
  "src/app/api/notifications/unread-count/route.ts",
  // teacher -> parent notes
  "src/app/api/teacher/student-notes/route.ts",
  // parent read surface
  "src/app/api/parents/me/dashboard/route.ts",
  // plan management
  "src/app/api/admin/plans/route.ts",
  "src/app/api/admin/plans/[id]/route.ts",
  "src/app/api/subscription-plans/route.ts",
  "src/app/api/enroll/route.ts",
  // deep-link destination (authorization must hold on the target itself)
  "src/app/api/lessons/[id]/route.ts",
];

function compileRealCode() {
  const { execFileSync } = require("child_process");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cm-post-launch-real-"));
  fs.writeFileSync(
    path.join(out, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2020", module: "commonjs", moduleResolution: "node",
        strict: false, skipLibCheck: true, esModuleInterop: true,
        resolveJsonModule: true, allowJs: false, types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")],
        baseUrl: REPO, paths: { "@/*": ["src/*"] }, rootDir: REPO, outDir: out,
      },
      files: REAL_CODE_MODULES.map((f) => path.join(REPO, f)),
    }, null, 2)
  );
  const tscBin = require.resolve("typescript/bin/tsc");
  try {
    execFileSync(process.execPath, [tscBin, "-p", path.join(out, "tsconfig.json")], {
      cwd: REPO, stdio: "pipe",
    });
  } catch {
    /* type noise elsewhere in the graph is tolerated; the emitted files matter */
  }
  for (const f of REAL_CODE_MODULES) {
    if (!fs.existsSync(path.join(out, f.replace(/\.ts$/, ".js")))) {
      throw new Error(`tsc did not emit ${f}`);
    }
  }
  return out;
}

const NEXT_SERVER_SHIM = `
class NextResponse {
  constructor(body, init = {}) {
    this.status = init.status ?? 200;
    this._headers = new Map();
    for (const [k, v] of Object.entries(init.headers || {})) this._headers.set(String(k).toLowerCase(), String(v));
    this._body = body; this._json = undefined;
  }
  static json(data, init = {}) {
    const r = new NextResponse(JSON.stringify(data), { status: init.status ?? 200, headers: { "content-type": "application/json" } });
    r._json = data; return r;
  }
  get headers() { const m = this._headers; return { get: (k) => m.get(String(k).toLowerCase()) ?? null }; }
  async json() {
    if (this._json !== undefined) return this._json;
    return JSON.parse(Buffer.from(this._body || "").toString("utf8"));
  }
}
class NextRequest {}
module.exports = { NextResponse, NextRequest };
`;
const NEXT_HEADERS_SHIM = `module.exports = { cookies: async () => ({ get: () => undefined }) };`;
const AUTH_SHIM = `module.exports = { getCurrentUser: async () => globalThis.__CM_USER__ ?? null };`;
const DB_SHIM = `module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };`;

function loadRealCode(outDir) {
  const { Module } = require("module");
  const files = {
    db: path.join(outDir, "__db-shim.js"),
    auth: path.join(outDir, "__auth-shim.js"),
    nextServer: path.join(outDir, "__next-server-shim.js"),
    nextHeaders: path.join(outDir, "__next-headers-shim.js"),
  };
  fs.writeFileSync(files.db, DB_SHIM);
  fs.writeFileSync(files.auth, AUTH_SHIM);
  fs.writeFileSync(files.nextServer, NEXT_SERVER_SHIM);
  fs.writeFileSync(files.nextHeaders, NEXT_HEADERS_SHIM);
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "@/lib/db") return files.db;
    if (request === "@/lib/auth") return files.auth;
    if (request === "next/server") return files.nextServer;
    if (request === "next/headers") return files.nextHeaders;
    const m = /^@\/lib\/([\w-]+)$/.exec(request);
    if (m) {
      const compiled = path.join(outDir, "src/lib", `${m[1]}.js`);
      if (fs.existsSync(compiled)) return compiled;
    }
    const a = /^@\/app\/(.+)$/.exec(request);
    if (a) {
      const compiled = path.join(outDir, "src/app", `${a[1]}.js`);
      if (fs.existsSync(compiled)) return compiled;
    }
    return originalResolve.call(this, request, ...rest);
  };
  const route = (p) => require(path.join(outDir, "src/app/api", p));
  const lib = (p) => require(path.join(outDir, "src/lib", p));
  return {
    restore() { Module._resolveFilename = originalResolve; },
    notify: lib("notify.js"),
    deepLink: lib("deep-link.js"),
    notifLinks: lib("notification-links.js"),
    entitlement: lib("subscription-entitlement.js"),
    adminNotif: route("admin/notifications/route.js"),
    myNotif: route("notifications/route.js"),
    unreadCount: route("notifications/unread-count/route.js"),
    teacherNotes: route("teacher/student-notes/route.js"),
    parentDash: route("parents/me/dashboard/route.js"),
    plans: route("admin/plans/route.js"),
    planById: route("admin/plans/[id]/route.js"),
    publicPlans: route("subscription-plans/route.js"),
    enroll: route("enroll/route.js"),
    lessonById: route("lessons/[id]/route.js"),
  };
}

// ---------------------------------------------------------------------------
// HTTP-lite driver
// ---------------------------------------------------------------------------
function jsonReq(url, body, method) {
  return {
    url,
    method: method || "GET",
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
    formData: async () => { throw new Error("no form body"); },
  };
}
function asUser(u) {
  globalThis.__CM_USER__ = u
    ? { id: u.id, email: u.email, name: u.name, role: u.role }
    : null;
}
async function call(handler, req, params) {
  let res;
  try {
    res = await handler(req, { params: Promise.resolve(params || {}) });
  } catch (e) {
    return { status: 500, json: { error: String((e && e.message) || e) }, headers: { get: () => null } };
  }
  const ct = res.headers?.get?.("content-type") || "";
  if (ct.includes("application/json")) {
    return { status: res.status, json: await res.json(), headers: res.headers };
  }
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}
const GET = (r, url, params) => call(r.GET, jsonReq(url), params);
const POST = (r, url, body, params) => call(r.POST, jsonReq(url, body, "POST"), params);
const PATCH = (r, url, body, params) => call(r.PATCH, jsonReq(url, body, "PATCH"), params);
const DEL = (r, url, params) => call(r.DELETE, jsonReq(url, undefined, "DELETE"), params);
const url = (p) => `http://127.0.0.1${p}`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
const at = (days) => new Date(Date.now() + days * DAY);
const unreadFor = async (userId) => {
  const n = await client.notification.count({ where: { userId, isRead: false } });
  return n;
};
const notesFor = async (userId) =>
  client.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const outDir = compileRealCode();
  ok(true, "B: shipped TS compiled with the repo tsc");
  const R = loadRealCode(outDir);
  ok(true, "B: route handlers loaded with db/auth/next shims");
  R.restore();

  // ---- C. fixtures ---------------------------------------------------------
  section("C. fixtures");

  const mkUser = (email, name, role) =>
    client.user.create({ data: { email, password: "x", name, role } });

  const uAdmin = await mkUser("pl-admin@cm.test", "Post Launch Admin", "ADMIN");
  const uTeacherA = await mkUser("pl-ta@cm.test", "Teacher Alpha", "TEACHER");
  const uTeacherB = await mkUser("pl-tb@cm.test", "Teacher Bravo", "TEACHER");
  const uParentA = await mkUser("pl-pa@cm.test", "Parent Alpha", "PARENT");
  const uParentB = await mkUser("pl-pb@cm.test", "Parent Bravo", "PARENT");
  const uStudentA = await mkUser("pl-sa@cm.test", "Student Alpha", "STUDENT");
  const uStudentB = await mkUser("pl-sb@cm.test", "Student Bravo", "STUDENT");

  const teacherA = await client.teacher.create({ data: { userId: uTeacherA.id } });
  const teacherB = await client.teacher.create({ data: { userId: uTeacherB.id } });
  const parentA = await client.parent.create({ data: { userId: uParentA.id } });
  const parentB = await client.parent.create({ data: { userId: uParentB.id } });

  const course = await client.course.create({
    // Phase K2 — levelled course + levelled students (I1 gate on /api/enroll).
    data: { slug: "pl-course", name: "Post Launch Course", nameAr: "كورس", description: "d", academicLevel: "SECOND_SECONDARY" },
  });
  const part = await client.part.create({
    data: { courseId: course.id, title: "Part 1", titleAr: "جزء", order: 1 },
  });
  const unit = await client.unit.create({
    data: { partId: part.id, title: "Unit", titleAr: "وحدة", order: 1 },
  });
  const groupA = await client.group.create({
    data: { name: "Group A", courseId: course.id, teacherId: teacherA.id, trackScope: "ARABIC" },
  });
  const groupB = await client.group.create({
    data: { name: "Group B", courseId: course.id, teacherId: teacherB.id, trackScope: "ARABIC" },
  });
  const studentA = await client.student.create({
    data: { userId: uStudentA.id, groupId: groupA.id, schoolType: "ARABIC", academicLevel: "SECOND_SECONDARY", nationalId: "30011011234567", parentPhone: "01100000001", studentCode: "PL-STA001" },
  });
  const studentB = await client.student.create({
    data: { userId: uStudentB.id, groupId: groupB.id, schoolType: "ARABIC", academicLevel: "SECOND_SECONDARY", nationalId: "30011011234568", parentPhone: "01100000002", studentCode: "PL-STB001" },
  });
  await client.parentStudentLink.create({ data: { parentId: parentA.id, studentId: studentA.id } });
  await client.parentStudentLink.create({ data: { parentId: parentB.id, studentId: studentB.id } });

  const lesson = await client.lesson.create({
    data: { academicLevel: "SECOND_SECONDARY", unitId: unit.id, title: "Post Launch Session", titleAr: "حصة", order: 1, status: "PUBLISHED", trackScope: "ARABIC", videoUrl: "https://v/pl.mp4" },
  });

  // ---- D. notification deep-link contract (pure) ---------------------------
  section("D. deep-link contract (pure)");

  eq(
    R.notifLinks.validateNotificationLink("https://evil.example/x"),
    false,
    "D1: external URL link is REJECTED"
  );
  eq(
    R.notifLinks.validateNotificationLink("//evil.example"),
    false,
    "D2: protocol-relative link is REJECTED"
  );
  eq(
    R.notifLinks.validateNotificationLink("/admin/payments"),
    false,
    "D3: path link is REJECTED"
  );
  eq(
    R.notifLinks.validateNotificationLink("javascript:alert(1)"),
    false,
    "D4: javascript: link is REJECTED"
  );
  eq(
    R.notifLinks.validateNotificationLink("admin-payments"),
    false,
    "D5: legacy view-string link is REJECTED at write time"
  );
  eq(
    R.notifLinks.validateNotificationLink("lesson:" + lesson.id),
    "lesson:" + lesson.id,
    "D6: valid deep link canonicalized"
  );
  eq(
    R.notifLinks.validateNotificationLink(null),
    null,
    "D7: null link stays null (informational notification)"
  );
  eq(
    R.deepLink.parseDeepLink("lesson:" + lesson.id),
    { kind: "lesson", id: lesson.id },
    "D8: parseDeepLink strict"
  );
  eq(
    R.deepLink.resolveDeepLink("lesson:" + lesson.id),
    { view: "student-lesson", navParam: lesson.id },
    "D9: lesson deep link targets the STUDENT view only"
  );

  // ---- E. Admin → Teacher full chain ---------------------------------------
  section("E. Admin → Teacher notification chain");

  asUser(uAdmin);
  let r = await POST(R.adminNotif, url("/api/admin/notifications"), {
    target: "user",
    userId: uTeacherA.id,
    title: "Teacher notice title",
    message: "Teacher notice body",
    type: "ANNOUNCEMENT",
  });
  eq(r.status, 200, "E1: admin send to one teacher accepted");
  eq(r.json?.sent, 1, "E2: exactly one notification inserted");

  const rows = await notesFor(uTeacherA.id);
  eq(rows.length, 1, "E3: teacher has exactly one notification row");
  eq(rows[0].title, "Teacher notice title", "E4: title stored");
  eq(rows[0].message, "Teacher notice body", "E5: body stored");
  eq(rows[0].isRead, false, "E6: created unread");
  eq(rows[0].userId, uTeacherA.id, "E7: targeted at the right user");

  asUser(uTeacherA);
  r = await GET(R.unreadCount, url("/api/notifications/unread-count"));
  eq(r.json?.count, 1, "E8: teacher unread badge = 1");
  r = await GET(R.myNotif, url("/api/notifications"));
  eq(r.json?.notifications?.length, 1, "E9: teacher list contains it");
  eq(r.json?.notifications?.[0]?.title, "Teacher notice title", "E10: title visible");
  eq(r.json?.notifications?.[0]?.message, "Teacher notice body", "E11: body visible");

  // click = mark read
  r = await POST(R.myNotif, url("/api/notifications"), { id: rows[0].id });
  eq(r.status, 200, "E12: mark-read accepted");
  eq(await unreadFor(uTeacherA.id), 0, "E13: unread count decreased to 0");
  const after = await client.notification.findUnique({ where: { id: rows[0].id } });
  eq(after.isRead, true, "E14: row flipped to read");

  // ---- F. Admin → Student + Admin → Parent + group target -------------------
  section("F. Admin → Student / Parent / group targets");

  asUser(uAdmin);
  r = await POST(R.adminNotif, url("/api/admin/notifications"), {
    target: "user",
    userId: uStudentA.id,
    title: "Student notice",
    message: "Student body",
  });
  eq(r.json?.sent, 1, "F1: admin → student delivered");
  eq((await notesFor(uStudentA.id)).length, 1, "F2: student row exists");

  r = await POST(R.adminNotif, url("/api/admin/notifications"), {
    target: "parents",
    title: "Parent notice",
    message: "Parent body",
  });
  eq(r.json?.sent, 2, "F3: admin → ALL parents delivered (2)");
  eq((await notesFor(uParentA.id)).length, 1, "F4: parent A row exists");
  eq((await notesFor(uParentB.id)).length, 1, "F5: parent B row exists");

  r = await POST(R.adminNotif, url("/api/admin/notifications"), {
    target: "group",
    groupId: groupA.id,
    title: "Group A notice",
    message: "Group A body",
  });
  eq(r.json?.sent, 1, "F6: group target reaches only group A students");
  eq((await notesFor(uStudentA.id)).length, 2, "F7: student A (group A) got it");
  eq((await notesFor(uStudentB.id)).length, 0, "F8: student B (group B) did NOT get it");

  r = await POST(R.adminNotif, url("/api/admin/notifications"), {
    target: "teachers",
    title: "Teachers notice",
    message: "Teachers body",
  });
  eq(r.json?.sent, 2, "F9: all teachers reached");

  // ---- G. cross-user isolation / IDOR ---------------------------------------
  section("G. cross-user isolation (IDOR)");

  asUser(uTeacherB);
  r = await GET(R.myNotif, url("/api/notifications"));
  const tBList = r.json?.notifications || [];
  ok(
    tBList.every((n) => n.title === "Teachers notice"),
    "G1: teacher B sees ONLY their own notifications",
    JSON.stringify(tBList.map((n) => n.title))
  );
  // teacher B cannot flip teacher A's UNREAD notification (the "Teachers
  // notice" from F9 is still unread for A — the E-section row was read).
  const tARow = (await notesFor(uTeacherA.id)).find(
    (n) => n.title === "Teachers notice"
  );
  r = await POST(R.myNotif, url("/api/notifications"), { id: tARow.id });
  eq(r.status, 200, "G2: foreign mark-read returns ok (no crash)");
  const stillUnread = await client.notification.findUnique({ where: { id: tARow.id } });
  eq(stillUnread.isRead, false, "G3: teacher A's notification was NOT flipped by teacher B");

  // invalid / garbage id fails safely
  r = await POST(R.myNotif, url("/api/notifications"), { id: "not-a-real-id" });
  eq(r.status, 200, "G4: invalid id handled safely (no 500)");
  eq(await unreadFor(uTeacherB.id), 1, "G5: nothing changed by the invalid id");

  // parent B cannot see parent A's notification
  asUser(uParentB);
  r = await GET(R.myNotif, url("/api/notifications"));
  ok(
    (r.json?.notifications || []).every((n) => n.title === "Parent notice"),
    "G6: parent B sees only their own notifications",
    JSON.stringify((r.json?.notifications || []).map((n) => n.title))
  );

  // unauthenticated
  asUser(null);
  r = await GET(R.myNotif, url("/api/notifications"));
  eq(r.status, 401, "G7: no session → 401");
  r = await GET(R.unreadCount, url("/api/notifications/unread-count"));
  eq(r.json?.count, 0, "G8: no session → badge 0 (no leak)");

  // ---- H. write-time link validation via the admin route --------------------
  section("H. admin route rejects malformed links");

  asUser(uAdmin);
  r = await POST(R.adminNotif, url("/api/admin/notifications"), {
    target: "user",
    userId: uTeacherA.id,
    title: "Bad link",
    message: "x",
    link: "https://evil.example/phish",
  });
  eq(r.status, 400, "H1: external URL link → 400");
  r = await POST(R.adminNotif, url("/api/admin/notifications"), {
    target: "user",
    userId: uTeacherA.id,
    title: "Bad link",
    message: "x",
    link: "student-homework",
  });
  eq(r.status, 400, "H2: legacy view-string link → 400");
  r = await POST(R.adminNotif, url("/api/admin/notifications"), {
    target: "user",
    userId: uTeacherA.id,
    title: "Good link",
    message: "x",
    link: "lesson:" + lesson.id,
  });
  eq(r.status, 200, "H3: valid deep link accepted");
  const linked = (await notesFor(uTeacherA.id)).find((n) => n.title === "Good link");
  eq(linked?.link, "lesson:" + lesson.id, "H4: link stored in canonical form");

  // ---- I. deep link never bypasses destination authorization ----------------
  section("I. deep-link destination authorization");

  // Student A is enrolled in group A (course) → can open the lesson.
  asUser(uStudentA);
  r = await GET(R.lessonById, url("/api/lessons/" + lesson.id), { id: lesson.id });
  eq(r.status, 200, "I1: enrolled student opens the linked lesson");

  // Student B is in group B — same course here, so to prove the DESTINATION
  // gate (not the notification) we use a NON-enrolled student for a lesson in
  // a course they cannot open: create course-2 lesson + student in group A only.
  const course2 = await client.course.create({
    data: { slug: "pl-course2", name: "Post Launch Course 2", nameAr: "كورس ٢", description: "d", academicLevel: "SECOND_SECONDARY" },
  });
  const part2 = await client.part.create({
    data: { courseId: course2.id, title: "P2", titleAr: "ج٢", order: 1 },
  });
  const unit2 = await client.unit.create({
    data: { partId: part2.id, title: "U2", titleAr: "و٢", order: 1 },
  });
  const lesson2 = await client.lesson.create({
    data: { academicLevel: "SECOND_SECONDARY", unitId: unit2.id, title: "Foreign Session", titleAr: "حصة خارج", order: 1, status: "PUBLISHED", trackScope: "ARABIC" },
  });
  // Even with a VALID notification deep link to lesson2, student A cannot open
  // it: the destination API enforces enrollment, not the link.
  asUser(uAdmin);
  r = await POST(R.adminNotif, url("/api/admin/notifications"), {
    target: "user",
    userId: uStudentA.id,
    title: "Foreign lesson link",
    message: "x",
    link: "lesson:" + lesson2.id,
  });
  eq(r.status, 200, "I2: a well-formed foreign link is storable");
  asUser(uStudentA);
  r = await GET(R.lessonById, url("/api/lessons/" + lesson2.id), { id: lesson2.id });
  // The student progression gate denies with a 4xx — the point is that the
  // DESTINATION refuses the content, so a deep link can never bypass it.
  ok(
    r.status === 403 || r.status === 404,
    "I3: destination still refuses the foreign lesson (no 2xx)",
    `status=${r.status}`
  );

  // ---- J. notification preferences -------------------------------------------
  section("J. preference contract");

  // Parent B disables announcements → admin broadcast must skip them.
  await client.notificationPreference.upsert({
    where: { userId: uParentB.id },
    create: { userId: uParentB.id, announcements: false },
    update: { announcements: false },
  });
  asUser(uAdmin);
  r = await POST(R.adminNotif, url("/api/admin/notifications"), {
    target: "parents",
    title: "Prefs test",
    message: "x",
  });
  eq(r.json?.sent, 1, "J1: only the parent WITH announcements enabled got it");
  eq(r.json?.skipped?.preferences, 1, "J2: skipped breakdown reports the preference skip");
  eq((await notesFor(uParentB.id)).length, 1, "J3: disabled parent did NOT receive the row");

  // quiet hours suppress delivery — re-enable B's announcements so the ONLY
  // skip in this broadcast is A's quiet window.
  await client.notificationPreference.update({
    where: { userId: uParentB.id },
    data: { announcements: true },
  });
  await client.notificationPreference.upsert({
    where: { userId: uParentA.id },
    create: { userId: uParentA.id, announcements: true, quietHoursStart: "00:00", quietHoursEnd: "23:59" },
    update: { quietHoursStart: "00:00", quietHoursEnd: "23:59" },
  });
  r = await POST(R.adminNotif, url("/api/admin/notifications"), {
    target: "parents",
    title: "Quiet test",
    message: "x",
  });
  eq(r.json?.sent, 1, "J4: quiet-hours parent skipped, other parent delivered");
  eq(r.json?.skipped?.quietHours, 1, "J5: quiet-hours skip reported");
  await client.notificationPreference.update({
    where: { userId: uParentA.id },
    data: { quietHoursStart: null, quietHoursEnd: null },
  });

  // ---- K. Teacher → Student note → Parent ------------------------------------
  section("K. Teacher → Student note → Parent");

  const unreadParentBefore = await unreadFor(uParentA.id);

  asUser(uTeacherA);
  r = await POST(R.teacherNotes, url("/api/teacher/student-notes"), {
    studentId: studentA.id,
    note: "Student Alpha is improving steadily in algebra.",
  });
  eq(r.status, 201, "K1: in-scope note accepted");
  const noteId = r.json?.note?.id;
  ok(Boolean(noteId), "K2: note row created with id");
  const stored = await client.teacherNote.findUnique({ where: { id: noteId } });
  eq(stored.teacherId, teacherA.id, "K3: attributed to the teacher");
  eq(stored.studentId, studentA.id, "K4: attributed to the right student");

  // Parent A (linked to student A) sees it on their dashboard.
  asUser(uParentA);
  r = await GET(R.parentDash, url("/api/parents/me/dashboard"));
  const childA = (r.json?.children || []).find((c) => c.id === studentA.id);
  ok(Boolean(childA), "K5: parent dashboard returns child A");
  const noteSeen = (childA?.teacherNotes || []).find((n) => n.id === noteId);
  ok(Boolean(noteSeen), "K6: parent SEES the teacher note", JSON.stringify(childA?.teacherNotes || []).slice(0, 200));
  eq(noteSeen?.teacherName, "Teacher Alpha", "K7: note carries author name");

  // Parent A got a notification for the note (exactly +1 unread on top of
  // whatever the earlier sections already delivered).
  const parentNotif = (await notesFor(uParentA.id)).find(
    (n) => /Teacher Alpha|improving steadily/.test(n.title + " " + n.message)
  );
  ok(Boolean(parentNotif), "K8: parent received a note notification");
  eq(
    await unreadFor(uParentA.id),
    unreadParentBefore + 1,
    "K9: parent unread badge grew by exactly 1"
  );

  // Parent B must NOT see student A's note.
  asUser(uParentB);
  r = await GET(R.parentDash, url("/api/parents/me/dashboard"));
  const childB = (r.json?.children || []).find((c) => c.id === studentB.id);
  ok(
    (childB?.teacherNotes || []).every((n) => n.id !== noteId),
    "K10: parent B does NOT see student A's note"
  );
  ok(
    (await notesFor(uParentB.id)).every(
      (n) => !/Teacher Alpha|improving steadily/.test(n.title + " " + n.message)
    ),
    "K11: parent B got NO note notification"
  );

  // Teacher B (group B) cannot note student A — same refusal as a ghost id.
  asUser(uTeacherB);
  r = await POST(R.teacherNotes, url("/api/teacher/student-notes"), {
    studentId: studentA.id,
    note: "Trying to note another teacher's student.",
  });
  eq(r.status, 404, "K12: cross-teacher note refused (404)");
  const ghost = await POST(R.teacherNotes, url("/api/teacher/student-notes"), {
    studentId: "does-not-exist-123",
    note: "ghost note attempt",
  });
  eq(ghost.status, 404, "K13: identical refusal for a nonexistent student (no existence leak)");
  eq((await client.teacherNote.findMany({ where: { studentId: studentA.id } })).length, 1, "K14: no foreign note was stored");

  // validation bounds
  r = await POST(R.teacherNotes, url("/api/teacher/student-notes"), {
    studentId: studentA.id,
    note: "ab",
  });
  eq(r.status, 400, "K15: too-short note refused");
  r = await POST(R.teacherNotes, url("/api/teacher/student-notes"), {
    studentId: studentA.id,
    note: "x".repeat(2001),
  });
  eq(r.status, 400, "K16: too-long note refused");

  // role gate: a student cannot use the teacher endpoint
  asUser(uStudentA);
  r = await POST(R.teacherNotes, url("/api/teacher/student-notes"), {
    studentId: studentA.id,
    note: "student trying to write a teacher note",
  });
  eq(r.status, 403, "K17: non-teacher role refused (403)");

  // teacher A's own history (GET, scope-checked)
  asUser(uTeacherA);
  r = await GET(R.teacherNotes, url(`/api/teacher/student-notes?groupId=${groupA.id}&studentId=${studentA.id}`));
  eq((r.json?.notes || []).length, 1, "K18: teacher lists their own note");
  asUser(uTeacherB);
  r = await GET(R.teacherNotes, url(`/api/teacher/student-notes?groupId=${groupB.id}&studentId=${studentA.id}`));
  eq((r.json?.notes || []).length, 0, "K19: GET cannot read another teacher's note");

  // ---- L. plan lifecycle -------------------------------------------------------
  section("L. plan create / edit / close / delete lifecycle");

  asUser(uAdmin);
  r = await POST(R.plans, url("/api/admin/plans"), {
    name: "Monthly PL",
    nameAr: "شهري",
    durationMonths: 1,
    price: 250,
  });
  eq(r.status, 201, "L1: plan created");
  const planId = r.json?.plan?.id;
  ok(Boolean(planId), "L2: plan id returned");

  r = await GET(R.publicPlans, url("/api/subscription-plans"));
  const pubPlan = (r.json?.plans || []).find((p) => p.id === planId);
  ok(Boolean(pubPlan), "L3: new plan appears in the public catalogue");
  eq(pubPlan?.isActive, true, "L4: created active by default");

  // edit — and the PUBLIC source reflects it (landing pricing contract:
  // the landing PricingSection renders GET /api/subscription-plans, so an
  // admin price change must land here without a code change)
  r = await PATCH(R.planById, url(`/api/admin/plans/${planId}`), { price: 300, nameAr: "شهري جديد" }, { id: planId });
  eq(r.status, 200, "L5: plan edited");
  eq(r.json?.plan?.price, 300, "L6: price updated");
  r = await GET(R.publicPlans, url("/api/subscription-plans"));
  const pubAfterEdit = (r.json?.plans || []).find((p) => p.id === planId);
  eq(pubAfterEdit?.price, 300, "L6b: public source reflects the NEW price (landing contract)");
  eq(pubAfterEdit?.nameAr, "شهري جديد", "L6c: public source reflects the new name");
  eq(pubAfterEdit?.durationMonths, 1, "L6d: public source carries the duration");

  // dependency view (orphan → safe to delete)
  r = await GET(R.planById, url(`/api/admin/plans/${planId}`), { id: planId });
  eq(r.json?.dependencies?.deleteSafe, true, "L7: orphan plan reports deleteSafe");

  // close the plan → public catalogue STILL lists it (flagged inactive)
  r = await PATCH(R.planById, url(`/api/admin/plans/${planId}`), { isActive: false }, { id: planId });
  eq(r.status, 200, "L8: plan closed");
  r = await GET(R.publicPlans, url("/api/subscription-plans"));
  const closedPlan = (r.json?.plans || []).find((p) => p.id === planId);
  ok(Boolean(closedPlan), "L9: closed plan stays VISIBLE in the catalogue");
  eq(closedPlan?.isActive, false, "L10: flagged inactive");

  // enrollment against the closed plan is refused SERVER-side
  asUser(uStudentA);
  r = await POST(R.enroll, url("/api/enroll"), {
    courseId: course.id,
    groupId: groupA.id,
    planId,
    method: "INSTAPAY",
    senderPhone: "01100000001",
    reference: "REF-PL-1",
  });
  eq(r.status, 400, "L11: closed plan CANNOT be purchased (400)");

  // reactivate → purchasable again (creates a PENDING request, no access)
  asUser(uAdmin);
  r = await PATCH(R.planById, url(`/api/admin/plans/${planId}`), { isActive: true }, { id: planId });
  eq(r.status, 200, "L12: plan reactivated");
  r = await GET(R.publicPlans, url("/api/subscription-plans"));
  eq((r.json?.plans || []).find((p) => p.id === planId)?.isActive, true, "L12b: public source shows the plan available again");
  asUser(uStudentA);
  r = await POST(R.enroll, url("/api/enroll"), {
    courseId: course.id,
    groupId: groupA.id,
    planId,
    method: "INSTAPAY",
    senderPhone: "01100000001",
    reference: "REF-PL-2",
  });
  eq(r.status, 200, "L13: reactivated plan purchasable again");

  // entitlement survives plan closure: the student's ACTIVE subscription
  // stays valid when the admin closes the plan.
  asUser(uAdmin);
  r = await PATCH(R.planById, url(`/api/admin/plans/${planId}`), { isActive: false }, { id: planId });
  eq(r.status, 200, "L14: plan closed again");
  // Simulate an APPROVED entitlement for student A (what PR2b approval does):
  // the singleton Subscription becomes ACTIVE with a live window. Student A
  // is grandfathered, so the L13 submission created NO row (path C) — hence
  // upsert, never a 2nd row.
  await client.subscription.upsert({
    where: { studentId: studentA.id },
    create: { studentId: studentA.id, planId, status: "ACTIVE", startDate: at(-10), endDate: at(20) },
    update: { planId, status: "ACTIVE", startDate: at(-10), endDate: at(20) },
  });
  const entitlement = await R.entitlement.resolveStudentEntitlement(studentA.id, { db: client });
  eq(entitlement?.subscriptionStatus, "ACTIVE", "L15: existing ACTIVE entitlement survives plan closure");
  eq(entitlement?.accessAllowed, true, "L15b: access is still allowed (end date intact)");
  ok(Boolean(entitlement?.endDate), "L15c: entitlement still exposes its end date");

  // delete: the plan now has subscription + payment references → 409
  r = await DEL(R.planById, url(`/api/admin/plans/${planId}`), { id: planId });
  eq(r.status, 409, "L17: referenced plan CANNOT be hard-deleted");
  ok(
    /subscription|payment|disable/i.test(r.json?.error || ""),
    "L18: refusal explains the dependency",
    r.json?.error
  );
  eq(r.json?.error, "Cannot delete plan with active subscriptions — disable sale instead (isActive=false)", "L19: exact dependency message (active subs)");

  // history stays intact
  eq((await client.subscription.count({ where: { planId } })), 1, "L20: subscription history intact");
  eq((await client.payment.count({ where: { requestedPlanId: planId } })), 1, "L21: payment history intact");

  // dependency GET reflects the reference
  r = await GET(R.planById, url(`/api/admin/plans/${planId}`), { id: planId });
  eq(r.json?.dependencies?.deleteSafe, false, "L22: referenced plan reports NOT delete-safe");
  eq(r.json?.dependencies?.activeSubscriptions, 1, "L23: active-sub count surfaced");
  // after the refused delete the plan is STILL in the public source, intact
  r = await GET(R.publicPlans, url("/api/subscription-plans"));
  const pubAfterRefusedDelete = (r.json?.plans || []).find((p) => p.id === planId);
  ok(Boolean(pubAfterRefusedDelete), "L23b: referenced plan remains in the public source after refused delete");
  eq(pubAfterRefusedDelete?.price, 300, "L23c: its data is intact");
  // and the public source exposes NO admin-only dependency information
  eq(
    Object.keys(pubAfterRefusedDelete || {}).every(
      (k) => ["id", "name", "nameAr", "durationMonths", "price", "isPromo", "isActive", "description", "createdAt"].includes(k)
    ),
    true,
    "L23d: public source carries no admin-only dependency fields"
  );

  // a truly orphan plan CAN be hard-deleted
  r = await POST(R.plans, url("/api/admin/plans"), {
    name: "Orphan PL",
    nameAr: "يتيم",
    durationMonths: 2,
    price: 400,
  });
  const orphanId = r.json?.plan?.id;
  r = await DEL(R.planById, url(`/api/admin/plans/${orphanId}`), { id: orphanId });
  eq(r.status, 200, "L24: orphan plan hard-deleted");
  r = await GET(R.publicPlans, url("/api/subscription-plans"));
  ok(
    !(r.json?.plans || []).some((p) => p.id === orphanId),
    "L25: deleted plan gone from the catalogue"
  );

  // ---- summary ------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error("FAILED ASSERTIONS:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("POST-LAUNCH-VERIFY: PASS");
}

main().catch((e) => {
  console.error("\n[POST-LAUNCH-VERIFY] crashed:", e);
  process.exit(1);
});
