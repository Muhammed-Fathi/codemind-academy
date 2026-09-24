// CodeMind Academy — SessionVideo requirement MODES + attendance-aware gating.
//
// OPTIONAL recordings are content only; ALL_STUDENTS recordings gate every
// eligible student; ABSENT_STUDENTS recordings gate ONLY students with a
// PROVEN unexcused absence (finalized ABSENT + review not EXCUSED /
// NO_ACTION_REQUIRED) for the explicitly-linked LiveSession. Present /
// excused / unmarked students are EXEMPT — rendered explicitly, never gated.
//
// PINNED BEHAVIOR (T1–T31):
//   T1–T3.  admin create: ALL persists, ABSENT persists with session link,
//            OPTIONAL default; legacy flag-only writes map to ALL/OPTIONAL.
//   T4.      threshold 50–100, no clamping (refuse, never rewrite).
//   T5.      admin edit: mode transitions persist; leaving ABSENT clears the
//            link; ABSENT without session/lesson refused.
//   T6.      eligible-sessions lists matching sessions; empty degrades.
//   T7.      invalid session links refused (missing/cancelled/wrong course/
//            wrong lesson).
//   T8.      untrackable (external) + ALL/ABSENT → 422, nothing written.
//   T9–T10.  engine slices per student through the lesson route (8 attendance
//            states, explicit fixtures).
//   T11–T15. present/excused/unmarked/unfinalized EXEMPT; unexcused + pending
//            GATED (claim refused until the recording is satisfied).
//   T16.     quiz PASS + homework SUBMITTED mandatory regardless of
//            attendance (incl. excused).
//   T17.     threshold default 95, custom honored per video.
//   T18.     0 → 94 (incomplete) → 95 (complete) → claim 200 (server truth).
//   T19.     short content completes via play-anchor + ended-flush beats.
//   T20.     canonical refresh wiring (no Ctrl+F5) + header (T21) + dashboard
//            continue card (T22) read the canonical video value.
//   T23.     teacher readiness: per-student states, scope-closed.
//   T24.     remind: not-ready → 201 teacher-note + parent fan-out (existing
//            subsystem); ready → 409; out-of-scope → 404.
//   T25.     redaction: locked lessons leak no content (lesson/tree-adjacent
//            denial, heartbeat, readiness scope).
//   T26.     garbage mode / linkless ABSENT / lesson-less ABSENT refused.
//   T27.     migration: additive-only, meaning-preserving backfill, provider
//            parity.
//   T28.     readiness is batched (bounded queries, no N+1).
//   T29.     admin selector: theme tokens only (light/dark safe).
//   T30.     exact Arabic copy (admin selector, student states, api errors).
//   T31.     regression guards: notes extraction identical, legacy compat,
//            engine core untouched.
//
// What is REAL here: the compiled shipped route handlers, the SQLite database
// built from the real migration SQL (including the new modes migration), the
// progression engine, the Phase F attendance tables, the teacher-notes
// fan-out. What is SHIMMED: the Prisma engine (sqlite-prisma-lite over
// node:sqlite), auth (script-controlled user), next/server, next/headers.
//
// Run: node --test tests/session-video-absence-requirement.test.js

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
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-avreq-media-"));
process.env.MEDIA_STORAGE_PATH = MEDIA_DIR;
process.env.MEDIA_BACKEND = "local";
process.env.MEDIA_MAX_VIDEO_BYTES = String(1024 * 1024);
process.env.SECURITY_HASH_SECRET = "s".repeat(64);

// Empirical NO-NETWORK guard: any TCP connect attempt fails loudly.
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(`avreq test made a network connection attempt: ${JSON.stringify(args[0])}`);
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
// Scratch database: base DDL + every real migration (incl. requirement modes).
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "avreq: " });
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
  // route handlers under test
  "src/app/api/admin/session-videos/route.ts",
  "src/app/api/admin/session-videos/[id]/route.ts",
  "src/app/api/admin/session-videos/eligible-sessions/route.ts",
  "src/app/api/students/me/session-videos/route.ts",
  "src/app/api/students/me/session-videos/[id]/progress/route.ts",
  "src/app/api/lessons/[id]/route.ts",
  "src/app/api/lessons/[id]/progress/route.ts",
  "src/app/api/students/me/dashboard/route.ts",
  "src/app/api/teacher/lessons/[id]/readiness/route.ts",
  "src/app/api/teacher/readiness/remind/route.ts",
  "src/app/api/teacher/student-notes/route.ts",
];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-avreq-compile-"));
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
  adminVideos: route("admin/session-videos/route.js"),
  adminVideo: route("admin/session-videos/[id]/route.js"),
  eligibleSessions: route("admin/session-videos/eligible-sessions/route.js"),
  videos: route("students/me/session-videos/route.js"),
  videoProgress: route("students/me/session-videos/[id]/progress/route.js"),
  lesson: route("lessons/[id]/route.js"),
  lessonProgress: route("lessons/[id]/progress/route.js"),
  dashboard: route("students/me/dashboard/route.js"),
  readiness: route("teacher/lessons/[id]/readiness/route.js"),
  remind: route("teacher/readiness/remind/route.js"),
  studentNotes: route("teacher/student-notes/route.js"),
};

// ---------------------------------------------------------------------------
// HTTP-lite driver (same shape as the Phase A/B e2e).
// ---------------------------------------------------------------------------
function jsonReq(url, body) {
  return {
    url,
    method: "GET",
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
    formData: async () => {
      throw new Error("no form body");
    },
  };
}
function formReq(url, form) {
  return {
    url,
    method: "POST",
    headers: {
      get: (k) =>
        String(k).toLowerCase() === "content-type"
          ? "multipart/form-data; boundary=----cma"
          : null,
    },
    json: async () => ({}),
    formData: async () => form,
  };
}
// The eligible-sessions + dashboard routes read req.nextUrl — attach a URL.
function getReq(url, body) {
  const r = jsonReq(url, body);
  r.nextUrl = new URL(url);
  return r;
}
function asUser(u) {
  globalThis.__CM_USER__ = u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null;
}
async function call(handler, req, params) {
  const res = await handler(req, { params: Promise.resolve(params || {}) });
  return { status: res.status, json: await res.json() };
}
const GET = (r, url, params) => call(r.GET, getReq(url), params);
const POST_JSON = (r, url, body, params) => call(r.POST, jsonReq(url, body), params);
const POST_FORM = (r, url, form, params) => call(r.POST, formReq(url, form), params);
const PATCH_JSON = (r, url, body, params) => call(r.PATCH, jsonReq(url, body), params);

// ---------------------------------------------------------------------------
test("SessionVideo requirement modes + attendance-aware gating (T1–T31)", async () => {
  // ===========================================================================
  // Seed — one course, one batch, one teacher group, eight attendance states:
  //   L1 (order 1) — one ALL_STUDENTS recording + one ABSENT_STUDENTS recording
  //     (linked to lv1) + quiz Q1 + homework H1
  //   L2 (order 2) — empty, chain-locked behind L1 (redaction target)
  // Students (all batch B-ar, group G1): sPresent / sAbsentU (UNEXCUSED) /
  //   sAbsentE (EXCUSED) / sAbsentP (PENDING_REASON) / sUnmarked (no row) /
  //   sLate (LATE) / sExcusedFact (EXCUSED) / sAbsentOpen (ABSENT, unfinalized)
  // ===========================================================================
  const course = await client.course.create({
    data: { slug: "avreq-a", name: "Course A", nameAr: "كورس أ", description: "avreq", academicLevel: "SECOND_SECONDARY" },
  });
  const partA = await client.part.create({
    data: { courseId: course.id, title: "P1", titleAr: "P1", order: 1 },
  });
  const unitA = await client.unit.create({
    data: { partId: partA.id, title: "U1", titleAr: "U1", order: 1 },
  });
  const mkLesson = (over) =>
    client.lesson.create({
      data: {
        academicLevel: "SECOND_SECONDARY",
        unitId: unitA.id,
        trackScope: "SHARED",
        status: "PUBLISHED",
        curriculumStatus: "OFFICIAL",
        isPublished: true,
        ...over,
      },
    });
  const L1 = await mkLesson({ order: 1, officialCode: "1-1", title: "Gated session", titleAr: "حصة مشروطة" });
  const L2 = await mkLesson({ order: 2, officialCode: "1-2", title: "Next session", titleAr: "الحصة التالية" });

  const batchAr = await client.batch.create({
    data: { name: "Batch AR", nameAr: "دفعة عربي", schoolType: "ARABIC", courseId: course.id },
  });
  const teacherUser = await client.user.create({
    data: { email: "t@avreq.test", password: "x", name: "T Mona", role: "TEACHER" },
  });
  const teacher = await client.teacher.create({ data: { userId: teacherUser.id } });
  const groupG1 = await client.group.create({
    data: { name: "Group G1", courseId: course.id, teacherId: teacher.id, trackScope: "ARABIC", isActive: true },
  });
  // A second teacher's group (scope-closed for T23/T25).
  const teacherUser2 = await client.user.create({
    data: { email: "t2@avreq.test", password: "x", name: "T Other", role: "TEACHER" },
  });
  const teacher2 = await client.teacher.create({ data: { userId: teacherUser2.id } });
  const groupG2 = await client.group.create({
    data: { name: "Group G2", courseId: course.id, teacherId: teacher2.id, trackScope: "ARABIC", isActive: true },
  });
  const mkStudent = async (tag) => {
    const u = await client.user.create({
      data: { email: `${tag}@avreq.test`, password: "x", name: tag, role: "STUDENT" },
    });
    const s = await client.student.create({
      data: { userId: u.id, academicLevel: "SECOND_SECONDARY", schoolType: "ARABIC", groupId: groupG1.id, batchId: batchAr.id },
    });
    return { user: u, student: s };
  };
  const sPresent = await mkStudent("s-present");
  const sAbsentU = await mkStudent("s-absent-u");
  const sAbsentE = await mkStudent("s-absent-e");
  const sAbsentP = await mkStudent("s-absent-p");
  const sUnmarked = await mkStudent("s-unmarked");
  const sLate = await mkStudent("s-late");
  const sExcusedFact = await mkStudent("s-excused-fact");
  const sAbsentOpen = await mkStudent("s-absent-open");
  const admin = await client.user.create({
    data: { email: "admin@avreq.test", password: "x", name: "A", role: "ADMIN" },
  });
  // A linked parent for the unexcused student (remind fan-out target).
  const parentUser = await client.user.create({
    data: { email: "p@avreq.test", password: "x", name: "Parent U", role: "PARENT" },
  });
  const parent = await client.parent.create({ data: { userId: parentUser.id } });
  await client.parentStudentLink.create({
    data: { parentId: parent.id, studentId: sAbsentU.student.id },
  });

  // LiveSessions: lv1 (finalized, lesson L1 — the absence source), lvOpen
  // (same lesson, register NOT finalized), lvCancelled, lvWrongLesson (L2),
  // lvOtherCourse (a foreign course).
  const mkSession = (over) =>
    client.liveSession.create({
      data: {
        groupId: groupG1.id,
        teacherId: teacher.id,
        title: "S",
        titleAr: "ح",
        startAt: new Date("2026-09-01T10:00:00Z"),
        ...over,
      },
    });
  const lv1 = await mkSession({
    lessonId: L1.id, status: "COMPLETED",
    attendanceFinalizedAt: new Date("2026-09-01T12:00:00Z"),
    attendanceFinalizedByUserId: teacherUser.id,
  });
  const lvOpen = await mkSession({ lessonId: L1.id, status: "LIVE" });
  const lvCancelled = await mkSession({ lessonId: L1.id, status: "CANCELLED" });
  const lvWrongLesson = await mkSession({
    lessonId: L2.id, status: "COMPLETED",
    attendanceFinalizedAt: new Date("2026-09-02T12:00:00Z"),
  });
  const course2 = await client.course.create({
    data: { slug: "avreq-b", name: "Course B", nameAr: "كورس ب", description: "avreq", academicLevel: "SECOND_SECONDARY" },
  });
  const groupForeign = await client.group.create({
    data: { name: "Foreign", courseId: course2.id, isActive: true },
  });
  const lvOtherCourse = await client.liveSession.create({
    data: {
      groupId: groupForeign.id, title: "F", titleAr: "أ",
      startAt: new Date("2026-09-01T10:00:00Z"), status: "COMPLETED",
      attendanceFinalizedAt: new Date("2026-09-01T12:00:00Z"),
    },
  });

  // Attendance facts on lv1 (one row per state; sUnmarked deliberately has
  // NO row) + one unfinalized ABSENT on lvOpen.
  const mkAttendance = (student, sessionId, status) =>
    client.attendance.create({ data: { studentId: student.student.id, sessionId, status } });
  await mkAttendance(sPresent, lv1.id, "PRESENT");
  const attU = await mkAttendance(sAbsentU, lv1.id, "ABSENT");
  const attE = await mkAttendance(sAbsentE, lv1.id, "ABSENT");
  const attP = await mkAttendance(sAbsentP, lv1.id, "ABSENT");
  await mkAttendance(sLate, lv1.id, "LATE");
  await mkAttendance(sExcusedFact, lv1.id, "EXCUSED");
  await mkAttendance(sAbsentOpen, lvOpen.id, "ABSENT");
  const mkReview = (attendance, student, status) =>
    client.absenceReview.create({
      data: {
        attendanceId: attendance.id, studentId: student.student.id,
        sessionId: lv1.id, groupId: groupG1.id, lessonId: L1.id, status,
      },
    });
  await mkReview(attU, sAbsentU, "UNEXCUSED");
  await mkReview(attE, sAbsentE, "EXCUSED");
  await mkReview(attP, sAbsentP, "PENDING_REASON");

  // Quiz Q1 + homework H1 on L1 (both PUBLISHED requirements).
  const Q1 = await client.quiz.create({
    data: { lessonId: L1.id, title: "Q1", titleAr: "س1", status: "PUBLISHED" },
  });
  const H1 = await client.homework.create({
    data: {
      lessonId: L1.id, title: "H1", titleAr: "و1",
      deadline: new Date("2026-10-01T00:00:00Z"), status: "PUBLISHED",
    },
  });

  const MP4_BYTES = Buffer.from(`cm-avreq-mp4-${"x".repeat(1024)}`);
  const mp4File = () => new File([MP4_BYTES], "clip.mp4", { type: "video/mp4" });
  const uploadForm = ({ lessonId, mode, flag, percent, sessionId, publish = true }) => {
    const f = new FormData();
    f.set("batchId", batchAr.id);
    f.set("lessonId", lessonId);
    f.set("title", `Recording ${lessonId}-${mode || flag || "opt"}`);
    f.set("publish", publish ? "true" : "false");
    f.set("file", mp4File());
    if (mode !== undefined) f.set("requirementMode", mode);
    if (flag !== undefined) f.set("isRequiredForProgression", flag);
    if (percent !== undefined) f.set("requiredPercent", percent);
    if (sessionId !== undefined) f.set("liveSessionId", sessionId);
    return f;
  };
  const lessonVideoOf = async (u, lessonId) => {
    asUser(u);
    const r = await GET(R.lesson, `http://t/api/lessons/${lessonId}`, { id: lessonId });
    return r;
  };
  // ===========================================================================
  // T1–T3. Admin create: ALL persists, ABSENT persists with its session link,
  // OPTIONAL + 95 defaults, legacy flag-only writes map to ALL/OPTIONAL.
  // ===========================================================================
  asUser(admin);
  const t1 = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: L1.id, mode: "ALL_STUDENTS", percent: "95" })
  );
  eq(t1.status, 200, "T1: upload + ALL_STUDENTS → 200");
  eq(t1.json.video.requirementMode, "ALL_STUDENTS", "T1: the response carries the mode");
  eq(t1.json.video.isRequiredForProgression, true, "T1: the legacy flag is dual-written true");
  eq(t1.json.video.liveSessionId ?? null, null, "T1: ALL carries no session link");
  const vAll = await client.sessionVideo.findUnique({ where: { id: t1.json.video.id } });
  eq(vAll.requirementMode, "ALL_STUDENTS", "T1: the PERSISTED row carries ALL_STUDENTS");
  eq(vAll.isRequiredForProgression, true, "T1: the PERSISTED flag is dual-written true");

  const t2 = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: L1.id, mode: "ABSENT_STUDENTS", percent: "95", sessionId: lv1.id })
  );
  eq(t2.status, 200, "T2: upload + ABSENT_STUDENTS + session → 200");
  eq(t2.json.video.requirementMode, "ABSENT_STUDENTS", "T2: the response carries the mode");
  eq(t2.json.video.liveSessionId, lv1.id, "T2: the response carries the linked session");
  const vAbsent = await client.sessionVideo.findUnique({ where: { id: t2.json.video.id } });
  eq(vAbsent.requirementMode, "ABSENT_STUDENTS", "T2: the PERSISTED row carries ABSENT_STUDENTS");
  eq(vAbsent.liveSessionId, lv1.id, "T2: the PERSISTED row links lv1");
  eq(vAbsent.isRequiredForProgression, true, "T2: the PERSISTED flag is dual-written true");

  const t3 = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: L1.id })
  );
  eq(t3.status, 200, "T3: upload without requirement fields → 200");
  eq(t3.json.video.requirementMode, "OPTIONAL", "T3: the default mode is OPTIONAL");
  eq(t3.json.video.requiredPercent, 95, "T3: the default threshold is 95");
  const vOpt = await client.sessionVideo.findUnique({ where: { id: t3.json.video.id } });
  eq(vOpt.requirementMode, "OPTIONAL", "T3: the PERSISTED default is OPTIONAL");
  eq(vOpt.isRequiredForProgression, false, "T3: the PERSISTED flag default is false");
  // Legacy clients (flag only, no mode) keep working byte-for-byte.
  const t3b = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: L1.id, flag: "true" })
  );
  eq(t3b.status, 200, "T3: legacy flag-only true → 200");
  eq(t3b.json.video.requirementMode, "ALL_STUDENTS", "T3: legacy true maps to ALL_STUDENTS");
  // The legacy-compat row must not pollute L1's gating — move it aside via
  // PATCH back to OPTIONAL (also exercises the flag→mode PATCH path).
  const t3bPatch = await PATCH_JSON(R.adminVideo, `http://t/api/admin/session-videos/${t3b.json.video.id}`, { requirementMode: "OPTIONAL" }, { id: t3b.json.video.id });
  eq(t3bPatch.status, 200, "T3: legacy row returned to OPTIONAL → 200");

  // ===========================================================================
  // T4. Threshold 50–100, no clamping: out-of-range + non-numeric refused.
  // ===========================================================================
  for (const [tag, pct] of [["floor", "50"], ["cap", "100"]]) {
    const r = await POST_FORM(
      R.adminVideos, "http://t/api/admin/session-videos",
      uploadForm({ lessonId: L1.id, mode: "ALL_STUDENTS", percent: pct })
    );
    eq(r.status, 200, `T4: ALL + ${pct}% → 200 (${tag})`);
    // Keep L1's gating pair intact — return boundary probes to OPTIONAL.
    await PATCH_JSON(R.adminVideo, `http://t/api/admin/session-videos/${r.json.video.id}`, { requirementMode: "OPTIONAL" }, { id: r.json.video.id });
  }
  for (const [tag, pct] of [["below", "49"], ["above", "101"], ["decimal-low", "49.9"], ["text", "abc"]]) {
    const before = await client.sessionVideo.count({});
    const r = await POST_FORM(
      R.adminVideos, "http://t/api/admin/session-videos",
      uploadForm({ lessonId: L1.id, mode: "ALL_STUDENTS", percent: pct })
    );
    eq(r.status, 422, `T4: ALL + ${pct} → 422 (${tag}, never clamped)`);
    eq(r.json.code, "INVALID_REQUIRED_PERCENT", `T4: the machine code names the contract (${tag})`);
    eq(await client.sessionVideo.count({}), before, `T4: the refused create wrote NOTHING (${tag})`);
  }

  // ===========================================================================
  // T5. Admin edit: mode transitions persist; leaving ABSENT clears the link;
  // ABSENT without session/lesson refused (row unchanged).
  // ===========================================================================
  const t5a = await PATCH_JSON(R.adminVideo, `http://t/api/admin/session-videos/${vOpt.id}`, { requirementMode: "ALL_STUDENTS" }, { id: vOpt.id });
  eq(t5a.status, 200, "T5: OPTIONAL → ALL_STUDENTS → 200");
  let t5row = await client.sessionVideo.findUnique({ where: { id: vOpt.id } });
  eq([t5row.requirementMode, t5row.isRequiredForProgression], ["ALL_STUDENTS", true], "T5: mode + dual-written flag persist");
  const t5b = await PATCH_JSON(R.adminVideo, `http://t/api/admin/session-videos/${vOpt.id}`, { requirementMode: "ABSENT_STUDENTS", liveSessionId: lv1.id }, { id: vOpt.id });
  eq(t5b.status, 200, "T5: ALL → ABSENT + session → 200");
  t5row = await client.sessionVideo.findUnique({ where: { id: vOpt.id } });
  eq([t5row.requirementMode, t5row.liveSessionId], ["ABSENT_STUDENTS", lv1.id], "T5: absent mode + link persist");
  const t5c = await PATCH_JSON(R.adminVideo, `http://t/api/admin/session-videos/${vOpt.id}`, { requirementMode: "OPTIONAL" }, { id: vOpt.id });
  eq(t5c.status, 200, "T5: ABSENT → OPTIONAL → 200");
  t5row = await client.sessionVideo.findUnique({ where: { id: vOpt.id } });
  eq([t5row.requirementMode, t5row.isRequiredForProgression, t5row.liveSessionId], ["OPTIONAL", false, null], "T5: leaving ABSENT clears the flag AND the stale link");
  const t5d = await PATCH_JSON(R.adminVideo, `http://t/api/admin/session-videos/${vOpt.id}`, { requirementMode: "ABSENT_STUDENTS" }, { id: vOpt.id });
  eq(t5d.status, 422, "T5: ABSENT without session → 422");
  eq(t5d.json.code, "ABSENT_REQUIRES_SESSION", "T5: the machine code names the contract");
  t5row = await client.sessionVideo.findUnique({ where: { id: vOpt.id } });
  eq(t5row.requirementMode, "OPTIONAL", "T5: the refused edit left the row OPTIONAL");
  const t5e = await PATCH_JSON(R.adminVideo, `http://t/api/admin/session-videos/${vOpt.id}`, { lessonId: null, requirementMode: "ABSENT_STUDENTS", liveSessionId: lv1.id }, { id: vOpt.id });
  eq(t5e.status, 422, "T5: lesson unlink + ABSENT → 422 (no lesson-less absent requirement)");
  eq(t5e.json.code, "ABSENT_REQUIRES_LESSON", "T5: the machine code names the contract");
  t5row = await client.sessionVideo.findUnique({ where: { id: vOpt.id } });
  eq([t5row.requirementMode, t5row.lessonId], ["OPTIONAL", L1.id], "T5: the refused edit changed NEITHER mode nor lesson");

  // ===========================================================================
  // T6. Eligible sessions: matching sessions listed; empty degrades.
  // ===========================================================================
  const t6 = await GET(R.eligibleSessions, `http://t/api/admin/session-videos/eligible-sessions?batchId=${batchAr.id}&lessonId=${L1.id}`);
  eq(t6.status, 200, "T6: eligible-sessions → 200");
  const t6ids = (t6.json.sessions || []).map((s) => s.id).sort();
  eq(t6ids, [lv1.id, lvOpen.id].sort(), "T6: exactly the compatible sessions (cancelled/wrong-lesson/wrong-course excluded)");
  const L3 = await mkLesson({ order: 3, officialCode: "1-3", title: "Validation-only", titleAr: "تحقق فقط" });
  const t6empty = await GET(R.eligibleSessions, `http://t/api/admin/session-videos/eligible-sessions?batchId=${batchAr.id}&lessonId=${L3.id}`);
  eq(t6empty.status, 200, "T6: no matching sessions → 200 with an empty list");
  eq(t6empty.json.sessions, [], "T6: the empty list (the UI disables ABSENT_STUDENTS with admin.641)");

  // ===========================================================================
  // T7. Invalid session links refused with api.365 (row unchanged / nothing
  // written).
  // ===========================================================================
  const badLinks = [
    ["missing", "sess-does-not-exist"],
    ["cancelled", lvCancelled.id],
    ["wrong-lesson", lvWrongLesson.id],
    ["wrong-course", lvOtherCourse.id],
  ];
  for (const [tag, sessionId] of badLinks) {
    const r = await PATCH_JSON(R.adminVideo, `http://t/api/admin/session-videos/${vOpt.id}`, { requirementMode: "ABSENT_STUDENTS", liveSessionId: sessionId }, { id: vOpt.id });
    eq(r.status, 422, `T7: ABSENT + ${tag} session → 422`);
    eq(r.json.code, "ABSENT_SESSION_INVALID", `T7: the machine code names the contract (${tag})`);
  }
  t5row = await client.sessionVideo.findUnique({ where: { id: vOpt.id } });
  eq([t5row.requirementMode, t5row.liveSessionId], ["OPTIONAL", null], "T7: every refused link left the row untouched");
  const t7post = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: L1.id, mode: "ABSENT_STUDENTS", sessionId: lvCancelled.id })
  );
  eq(t7post.status, 422, "T7: POST ABSENT + cancelled session → 422");
  eq(t7post.json.error, "الحصة المختارة غير صالحة لهذا الفيديو.", "T7: the Arabic message is exact (api.365)");

  // ===========================================================================
  // T8. Untrackable (external) + ALL/ABSENT → 422, nothing written.
  // ===========================================================================
  const t8before = await client.sessionVideo.count({});
  const t8a = await POST_JSON(R.adminVideos, "http://t/api/admin/session-videos", {
    batchId: batchAr.id, lessonId: L1.id, title: "Ext ALL",
    videoUrl: "https://cdn.example.com/a.mp4", publish: false,
    requirementMode: "ALL_STUDENTS", requiredPercent: 80,
  });
  eq(t8a.status, 422, "T8: external + ALL_STUDENTS → 422");
  eq(t8a.json.code, "EXTERNAL_CANNOT_BE_REQUIRED", "T8: the machine code names the contract");
  const t8b = await POST_JSON(R.adminVideos, "http://t/api/admin/session-videos", {
    batchId: batchAr.id, lessonId: L1.id, title: "Ext absent",
    videoUrl: "https://cdn.example.com/b.mp4", publish: false,
    requirementMode: "ABSENT_STUDENTS", liveSessionId: lv1.id, requiredPercent: 80,
  });
  eq(t8b.status, 422, "T8: external + ABSENT_STUDENTS → 422 (untrackability beats the mode)");
  eq(t8b.json.code, "EXTERNAL_CANNOT_BE_REQUIRED", "T8: the machine code names the contract");
  eq(await client.sessionVideo.count({}), t8before, "T8: the refused creates wrote NOTHING");

  // Direct-seeded ABSENT video WITHOUT a session link (unreachable via the
  // app — every write path refuses it): the engine must fail OPEN with the
  // loud NO_SESSION_LINK reason, never trap students, never silently gate.
  const mediaLinkless = await client.mediaAsset.create({
    data: { kind: "VIDEO", storage: "LOCAL_PRIVATE", storageKey: "k-linkless", isPrivate: true },
  });
  await client.sessionVideo.create({
    data: {
      batchId: batchAr.id, lessonId: L1.id, mediaAssetId: mediaLinkless.id,
      title: "Linkless", titleAr: "بدون ربط", requiredPercent: 95,
      requirementMode: "ABSENT_STUDENTS", isRequiredForProgression: true,
      liveSessionId: null, isPublished: true, publishedAt: new Date(),
    },
  });

  // ===========================================================================
  // T9–T10. The engine slices per student (lesson route): the unexcused
  // absentee is gated by BOTH videos; every fixture state is explicit.
  // ===========================================================================
  const lu = await lessonVideoOf(sAbsentU.user, L1.id);
  eq(lu.status, 200, "T9: the lesson opens for the unexcused absentee");
  const luv = lu.json.requirements.video;
  eq(luv.required, true, "T9: video is required for the absentee");
  eq(luv.requiredCount, 2, "T9: BOTH recordings gate (ALL + ABSENT)");
  eq(luv.completedCount, 0, "T9: none satisfied yet");
  eq(luv.items.map((i) => i.id).sort(), [vAll.id, vAbsent.id].sort(), "T9: the items are exactly the two gating recordings");
  const absentItem = luv.items.find((i) => i.id === vAbsent.id);
  eq([absentItem.requirementMode, absentItem.applicability, absentItem.currentPercent, absentItem.completed], ["ABSENT_STUDENTS", "REQUIRED_ABSENT", 0, false], "T9: the absent item carries mode + verdict + live 0%");
  const allItem = luv.items.find((i) => i.id === vAll.id);
  eq([allItem.requirementMode, allItem.applicability], ["ALL_STUDENTS", "ALL_STUDENTS"], "T9: the ALL item carries its verdict");
  ok((lu.json.requirements.unmet || []).some((u) => u.kind === "VIDEO_INCOMPLETE"), "T9: VIDEO_INCOMPLETE is in the structured unmet");
  // The linkless ABSENT row exempts LOUDLY (present in exempt, never gating).
  const linklessExempt = (luv.exempt || []).find((e) => e.title === "Linkless");
  eq(linklessExempt?.applicability, "NO_SESSION_LINK", "T10: the linkless row is EXEMPT with NO_SESSION_LINK (fail-open, loud)");

  // ===========================================================================
  // T11–T12. Present / excused / fact-excused students: the ALL video still
  // gates, the ABSENT video EXEMPTS with its explicit reason.
  // ===========================================================================
  const lp = await lessonVideoOf(sPresent.user, L1.id);
  const lpv = lp.json.requirements.video;
  eq([lpv.required, lpv.requiredCount], [true, 1], "T11: only the ALL video gates the present student");
  eq(lpv.items.map((i) => i.id), [vAll.id], "T11: the items carry exactly the ALL video");
  const lpExempt = (lpv.exempt || []).find((e) => e.id === vAbsent.id);
  eq(lpExempt?.applicability, "EXEMPT_PRESENT", "T11: the ABSENT video exempts with EXEMPT_PRESENT");
  const le = await lessonVideoOf(sAbsentE.user, L1.id);
  const leExempt = ((le.json.requirements.video.exempt) || []).find((e) => e.id === vAbsent.id);
  eq(leExempt?.applicability, "EXEMPT_EXCUSED", "T12: review-EXCUSED exempts with EXCUSED (never conflated)");
  const lf = await lessonVideoOf(sExcusedFact.user, L1.id);
  const lfExempt = ((lf.json.requirements.video.exempt) || []).find((e) => e.id === vAbsent.id);
  eq(lfExempt?.applicability, "EXEMPT_PRESENT", "T12: fact-level EXCUSED exempts (attended-or-excused)");

  // ===========================================================================
  // T13. The gated absentee cannot claim with the recordings unwatched.
  // ===========================================================================
  asUser(sAbsentU.user);
  const t13 = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${L1.id}/progress`, { completed: true }, { id: L1.id });
  eq(t13.status, 403, "T13: claim with 0% recordings → 403");
  ok(((t13.json.unmet) || []).some((u) => u.kind === "VIDEO_INCOMPLETE"), "T13: the refusal names VIDEO_INCOMPLETE");

  // ===========================================================================
  // T14–T15. Pending stays GATED (fail-closed); unmarked / unfinalized / late
  // EXEMPT (absence never invented, drafts never feed gating).
  // ===========================================================================
  const lpend = await lessonVideoOf(sAbsentP.user, L1.id);
  const lpendV = lpend.json.requirements.video;
  eq(lpendV.requiredCount, 2, "T14: PENDING_REASON keeps BOTH videos gating (fail-closed)");
  eq(lpendV.items.find((i) => i.id === vAbsent.id)?.applicability, "REQUIRED_ABSENT", "T14: the pending verdict is REQUIRED_ABSENT");
  const lunm = await lessonVideoOf(sUnmarked.user, L1.id);
  eq(((lunm.json.requirements.video.exempt) || []).find((e) => e.id === vAbsent.id)?.applicability, "EXEMPT_UNMARKED", "T15: UNMARKED (no row) exempts — never ABSENT by default");
  // The unfinalized draft needs its own absence source: a recording linked
  // to lvOpen (unfinalized). Nobody gates on it (a draft never feeds
  // gating), so L1's counts are untouched — it only grows exempt buckets.
  asUser(admin);
  const tOpen = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: L1.id, mode: "ABSENT_STUDENTS", percent: "95", sessionId: lvOpen.id })
  );
  eq(tOpen.status, 200, "T15: ABSENT linked to an unfinalized session stages (200)");
  const vAbsentOpen = await client.sessionVideo.findUnique({ where: { id: tOpen.json.video.id } });
  const lopen = await lessonVideoOf(sAbsentOpen.user, L1.id);
  const lopenV = lopen.json.requirements.video;
  eq(lopenV.requiredCount, 1, "T15: the draft-linked recording gates nobody (counts untouched)");
  eq((lopenV.exempt || []).find((e) => e.id === vAbsentOpen.id)?.applicability, "EXEMPT_NOT_FINALIZED", "T15: unfinalized ABSENT exempts — drafts never gate");
  eq((lopenV.exempt || []).find((e) => e.id === vAbsent.id)?.applicability, "EXEMPT_UNMARKED", "T15: no row on lv1 still exempts as UNMARKED (per-session proof)");
  const llate = await lessonVideoOf(sLate.user, L1.id);
  eq(((llate.json.requirements.video.exempt) || []).find((e) => e.id === vAbsent.id)?.applicability, "EXEMPT_PRESENT", "T15: LATE exempts (they were there)");

  // ===========================================================================
  // T18. 0 → 94 (incomplete, claim refused) → 95 (satisfied) on the ABSENT
  // recording, through REAL heartbeat beats with wall-clock seeding. Only
  // server-trusted watch progress moves the requirement — no 100% faking.
  // ===========================================================================
  const beat = async (u, videoId, positionSec, durationSec) => {
    asUser(u);
    return POST_JSON(R.videoProgress, `http://t/api/students/me/session-videos/${videoId}/progress`, { positionSec, durationSec }, { id: videoId });
  };
  // First beat of a fresh row anchors the clock (credits 0 — the no-spoof
  // rule); then 94 elapsed seconds accrue via a backdated heartbeat.
  const b0 = await beat(sAbsentU.user, vAbsent.id, 0, 100);
  eq(b0.status, 200, "T18: the anchor beat lands (200)");
  eq(b0.json.percent, 0, "T18: the anchor beat credits 0 (fresh row, no free progress)");
  await client.sessionVideoView.update({
    where: { sessionVideoId_studentId: { sessionVideoId: vAbsent.id, studentId: sAbsentU.student.id } },
    data: { lastHeartbeatAt: new Date(Date.now() - 94 * 1000) },
  });
  const bCap = await beat(sAbsentU.user, vAbsent.id, 94, 100);
  eq(bCap.status, 200, "T18: the +94s beat lands (200)");
  eq(bCap.json.percent, 60, "T18: one beat credits AT MOST 60s (server anti-spoof cap)");
  await client.sessionVideoView.update({
    where: { sessionVideoId_studentId: { sessionVideoId: vAbsent.id, studentId: sAbsentU.student.id } },
    data: { lastHeartbeatAt: new Date(Date.now() - 34 * 1000) },
  });
  const b94 = await beat(sAbsentU.user, vAbsent.id, 94, 100);
  eq(b94.status, 200, "T18: the +34s beat lands (200)");
  eq(b94.json.percent, 94, "T18: server-trusted watch reaches exactly 94%");
  eq(b94.json.satisfied, false, "T18: 94% < 95% is NOT satisfied (no faking)");
  const l94 = await lessonVideoOf(sAbsentU.user, L1.id);
  const l94item = l94.json.requirements.video.items.find((i) => i.id === vAbsent.id);
  eq([l94item.currentPercent, l94item.completed], [94, false], "T18: the canonical card shows live 94%, incomplete");
  asUser(sAbsentU.user);
  const c94 = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${L1.id}/progress`, { completed: true }, { id: L1.id });
  eq(c94.status, 403, "T18: claim at 94% → 403 (threshold enforced)");
  // One more real second + the ended flush cross the threshold.
  await client.sessionVideoView.update({
    where: { sessionVideoId_studentId: { sessionVideoId: vAbsent.id, studentId: sAbsentU.student.id } },
    data: { lastHeartbeatAt: new Date(Date.now() - 1 * 1000) },
  });
  const b95 = await beat(sAbsentU.user, vAbsent.id, 95, 100);
  eq(b95.json.percent, 95, "T18: the flush beat reaches exactly 95%");
  eq(b95.json.satisfied, true, "T18: 95% satisfies the 95% threshold");
  const l95 = await lessonVideoOf(sAbsentU.user, L1.id);
  const l95item = l95.json.requirements.video.items.find((i) => i.id === vAbsent.id);
  eq([l95item.currentPercent, l95item.completed], [95, true], "T18: the canonical card shows 95%, complete");
  // vAll still gates (0%) — one recording cannot ungate the other.
  eq(l95.json.requirements.video.completedCount, 1, "T18: counts name 1 of 2 (no cross-video leakage)");
  asUser(sAbsentU.user);
  const c95 = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${L1.id}/progress`, { completed: true }, { id: L1.id });
  eq(c95.status, 403, "T18: claim with vAll at 0% → still 403");

  // ===========================================================================
  // T19. Short content completes: the CLIENT's play-anchor + ended-flush beat
  // sequence for a 10s clip accrues the FULL duration server-side (the
  // server half of the 0%-forever fix; the client half is pinned in T20).
  // ===========================================================================
  const s19 = await beat(sAbsentP.user, vAll.id, 0, 10);
  eq(s19.status, 200, "T19: the play-anchor beat lands (200)");
  eq(s19.json.percent, 0, "T19: the anchor credits 0 (no free progress)");
  await client.sessionVideoView.update({
    where: { sessionVideoId_studentId: { sessionVideoId: vAll.id, studentId: sAbsentP.student.id } },
    data: { lastHeartbeatAt: new Date(Date.now() - 10 * 1000) },
  });
  const s19end = await beat(sAbsentP.user, vAll.id, 10, 10);
  eq(s19end.json.percent, 100, "T19: anchor + 10s elapsed + ended flush = 100% (nothing lost)");
  eq(s19end.json.satisfied, true, "T19: the short clip satisfies its threshold");

  // ===========================================================================
  // T16. Quiz PASS + homework SUBMITTED are mandatory REGARDLESS of
  // attendance — the excused student is gated by them exactly like everyone
  // else (Phase F "approval is not completion", preserved).
  // ===========================================================================
  // sAbsentU: satisfy vAll (watched state), quiz/hw still missing → refused.
  await client.sessionVideoView.create({
    data: { sessionVideoId: vAll.id, studentId: sAbsentU.student.id, watchedSec: 95, durationSec: 100, percent: 95, isCompleted: true },
  });
  asUser(sAbsentU.user);
  const t16a = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${L1.id}/progress`, { completed: true }, { id: L1.id });
  eq(t16a.status, 403, "T16: videos done but quiz/hw missing → 403");
  const t16aUnmet = ((t16a.json.unmet) || []).map((u) => u.kind);
  ok(t16aUnmet.includes("QUIZ_NOT_PASSED") && t16aUnmet.includes("HOMEWORK_NOT_SUBMITTED"), "T16: the refusal names quiz + homework");
  ok(!t16aUnmet.includes("VIDEO_INCOMPLETE"), "T16: video is no longer in the unmet");
  await client.quizAttempt.create({
    data: { quizId: Q1.id, studentId: sAbsentU.student.id, finishedAt: new Date(), passed: true, percentage: 90 },
  });
  await client.homeworkSubmission.create({
    data: { homeworkId: H1.id, studentId: sAbsentU.student.id, submittedAt: new Date() },
  });
  const t16b = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${L1.id}/progress`, { completed: true }, { id: L1.id });
  eq(t16b.status, 200, "T16: videos + PASS + SUBMITTED → claim 200");
  eq(t16b.json.completed, true, "T16: the lesson completes for the absentee");
  // sAbsentE (EXCUSED): videos done, quiz/hw missing → STILL refused.
  await client.sessionVideoView.create({
    data: { sessionVideoId: vAll.id, studentId: sAbsentE.student.id, watchedSec: 100, durationSec: 100, percent: 100, isCompleted: true },
  });
  asUser(sAbsentE.user);
  const t16c = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${L1.id}/progress`, { completed: true }, { id: L1.id });
  eq(t16c.status, 403, "T16: the EXCUSED student is still gated by quiz/hw (approval ≠ completion)");
  await client.quizAttempt.create({
    data: { quizId: Q1.id, studentId: sAbsentE.student.id, finishedAt: new Date(), passed: true, percentage: 88 },
  });
  await client.homeworkSubmission.create({
    data: { homeworkId: H1.id, studentId: sAbsentE.student.id, submittedAt: new Date() },
  });
  const t16d = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${L1.id}/progress`, { completed: true }, { id: L1.id });
  eq(t16d.status, 200, "T16: excused + PASS + SUBMITTED → claim 200");

  // The QA contradiction, reconstructed: a stale whole-lesson legacy marker
  // at 100% while the canonical requirement sits at 0%.
  await client.lessonProgress.upsert({
    where: { studentId_lessonId: { studentId: sPresent.student.id, lessonId: L1.id } },
    update: { progress: 100 },
    create: { studentId: sPresent.student.id, lessonId: L1.id, progress: 100 },
  });

  // ===========================================================================
  // T21. The header reads the CANONICAL video value when video is required
  // (route half: both numbers; client half: the selection, source-pinned).
  // ===========================================================================
  const t21 = await lessonVideoOf(sPresent.user, L1.id);
  eq(t21.json.progress.progress, 100, "T21: the stale legacy marker reads 100 (contradiction input)");
  eq(t21.json.requirements.video.required, true, "T21: video is required for the present student");
  eq(t21.json.requirements.video.value, 0, "T21: the canonical video value reads 0 (binding bottleneck)");
  const lessonSrc = read("src/components/course/student-lesson.tsx");
  ok(/videoReq\?\.required[\s\S]{0,200}\?[\s\S]{0,200}videoReq\.value/.test(lessonSrc), "T21: the header selects the canonical value when video is required (source pin)");
  ok(/data\.progress\?\.progress \|\| 0/.test(lessonSrc), "T21: non-video lessons keep the historical marker (source pin)");

  // ===========================================================================
  // T22. The dashboard Continue card reads the SAME canonical value.
  // ===========================================================================
  asUser(sPresent.user);
  const t22 = await GET(R.dashboard, "http://t/api/students/me/dashboard");
  eq(t22.status, 200, "T22: dashboard → 200");
  eq(t22.json.continueLesson.id, L1.id, "T22: the Continue card points at L1");
  eq(t22.json.continueLesson.progress, 0, "T22: the Continue bar shows the canonical 0% (not the stale 100%)");
  asUser(sAbsentU.user);
  const t22b = await GET(R.dashboard, "http://t/api/students/me/dashboard");
  // Last-viewed wins (pre-existing Continue rule): sAbsentU viewed L1, so
  // Continue stays on L1 — completed, with the CANONICAL video value.
  eq(t22b.json.continueLesson.id, L1.id, "T22: Continue stays on the last-viewed lesson");
  eq(t22b.json.continueLesson.isCompleted, true, "T22: the completed lesson reads completed");
  eq(t22b.json.continueLesson.progress, 95, "T22: the completed lesson shows the canonical 95% (min of the two recordings)");

  // ===========================================================================
  // T20. Canonical refresh wiring: beats refresh the card + header WITHOUT
  // Ctrl+F5 (source pins — the route half is T18's l95 read-after-beats).
  // ===========================================================================
  const playerSrc = read("src/components/course/session-videos-view.tsx");
  ok(/onPlay=\{\(\) => \{\s+playingRef\.current = true;\s+[^}]*beat\(\);/.test(playerSrc), "T20: the player anchors the server clock on PLAY (source pin)");
  ok(/onWatchProgress=\{refreshCanonical\}/.test(lessonSrc), "T20: the section feeds beats into the lesson refresh (source pin)");
  ok(/refreshCanonical[\s\S]{0,400}fetch\(`\/api\/lessons\//.test(lessonSrc), "T20: the refresh re-reads the canonical payload (source pin)");
  ok(!/refreshCanonical[\s\S]{0,600}setLoading\(true\)/.test(lessonSrc.split("refreshCanonical")[1].split("React.useEffect")[0]), "T20: the refresh is silent (no skeleton flash)");

  // ===========================================================================
  // T17. Custom thresholds honored per video (create + PATCH + engine read).
  // ===========================================================================
  asUser(admin);
  const t17 = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: L3.id, mode: "ALL_STUDENTS", percent: "50" })
  );
  eq(t17.status, 200, "T17: ALL + 50% on the validation-only lesson → 200");
  const vT17 = await client.sessionVideo.findUnique({ where: { id: t17.json.video.id } });
  eq(vT17.requiredPercent, 50, "T17: the custom 50% persists EXACTLY");
  const t17p = await PATCH_JSON(R.adminVideo, `http://t/api/admin/session-videos/${vT17.id}`, { requiredPercent: "100" }, { id: vT17.id });
  eq(t17p.status, 200, "T17: PATCH 50 → 100 → 200");
  eq((await client.sessionVideo.findUnique({ where: { id: vT17.id } })).requiredPercent, 100, "T17: the patched 100% persists");
  asUser(teacherUser);
  const t17r = await GET(R.readiness, `http://t/api/teacher/lessons/${L3.id}/readiness`, { id: L3.id });
  eq(t17r.status, 200, "T17: readiness for L3 → 200");
  const t17row = t17r.json.students.find((s) => s.studentId === sAbsentU.student.id);
  eq(t17row.video.items[0].requiredPercent, 100, "T17: the engine reads THIS video's own threshold (100, not 95)");

  // ===========================================================================
  // T23. Teacher readiness: per-student canonical states, scope-closed.
  // ===========================================================================
  asUser(teacherUser);
  const t23 = await GET(R.readiness, `http://t/api/teacher/lessons/${L1.id}/readiness`, { id: L1.id });
  eq(t23.status, 200, "T23: readiness for a taught lesson → 200");
  eq(t23.json.lesson.id, L1.id, "T23: the payload names the lesson");
  eq(t23.json.students.length, 8, "T23: all 8 students of the teacher's group");
  const rU = t23.json.students.find((s) => s.studentId === sAbsentU.student.id);
  const rP = t23.json.students.find((s) => s.studentId === sPresent.student.id);
  const rE = t23.json.students.find((s) => s.studentId === sAbsentE.student.id);
  eq(rU.ready, true, "T23: the completed absentee is READY");
  eq(rP.ready, false, "T23: the present student (vAll 0% + quiz/hw missing) is NOT READY");
  eq(rP.video.items.map((i) => i.id), [vAll.id], "T23: the present row gates exactly vAll");
  eq(rP.video.exempt.find((e) => e.id === vAbsent.id)?.applicability, "EXEMPT_PRESENT", "T23: the present row exempts vAbsent explicitly");
  eq(rE.ready, true, "T23: the completed excused student is READY");
  eq(rP.quiz.pending.map((q) => q.id), [Q1.id], "T23: the pending quiz is named");
  eq(rP.homework.pending.map((h) => h.id), [H1.id], "T23: the pending homework is named");
  // No lesson CONTENT crosses: no bytes, no urls, no questions.
  const t23flat = JSON.stringify(t23.json);
  ok(!/storageKey|externalUrl|question|attachmentId/.test(t23flat), "T23: states only — no content fields leak");
  // Scope: a lesson outside every taught course → 404 (confirms nothing).
  const partF = await client.part.create({ data: { courseId: course2.id, title: "PF", titleAr: "PF", order: 1 } });
  const unitF = await client.unit.create({ data: { partId: partF.id, title: "UF", titleAr: "UF", order: 1 } });
  const Lforeign = await client.lesson.create({
    data: { unitId: unitF.id, academicLevel: "SECOND_SECONDARY", order: 1, title: "Foreign", titleAr: "أجنبي", trackScope: "SHARED", status: "PUBLISHED", curriculumStatus: "OFFICIAL", isPublished: true },
  });
  const t23f = await GET(R.readiness, `http://t/api/teacher/lessons/${Lforeign.id}/readiness`, { id: Lforeign.id });
  eq(t23f.status, 404, "T23: a foreign lesson → 404 (scope-closed)");
  asUser(teacherUser2);
  const t23e = await GET(R.readiness, `http://t/api/teacher/lessons/${L1.id}/readiness`, { id: L1.id });
  eq(t23e.status, 200, "T23: same course, no students → 200 with an empty roster");
  eq(t23e.json.students, [], "T23: the empty roster (never another teacher's students)");
  asUser(sPresent.user);
  eq((await GET(R.readiness, `http://t/api/teacher/lessons/${L1.id}/readiness`, { id: L1.id })).status, 403, "T23: a student → 403");
  asUser(admin);
  eq((await GET(R.readiness, `http://t/api/teacher/lessons/${L1.id}/readiness`, { id: L1.id })).status, 403, "T23: an admin → 403 (teacher surface)");

  // ===========================================================================
  // T24. Remind: not-ready → 201 teacher-note + EXISTING parent fan-out;
  // ready → 409; out-of-scope → 404. No new notification subsystem.
  // ===========================================================================
  const parentUserP = await client.user.create({
    data: { email: "pp@avreq.test", password: "x", name: "Parent P", role: "PARENT" },
  });
  const parentP = await client.parent.create({ data: { userId: parentUserP.id } });
  await client.parentStudentLink.create({
    data: { parentId: parentP.id, studentId: sPresent.student.id },
  });
  asUser(teacherUser);
  const t24 = await POST_JSON(R.remind, "http://t/api/teacher/readiness/remind", { studentId: sPresent.student.id, lessonId: L1.id });
  eq(t24.status, 201, "T24: remind a not-ready student → 201");
  eq(t24.json.notifiedParents, 1, "T24: exactly the linked parent is notified");
  const t24note = await client.teacherNote.findUnique({ where: { id: t24.json.note.id } });
  ok(t24note.note.startsWith("تذكير بمتطلبات درس"), "T24: the reminder IS a teacher note (templated, fixed structure)");
  ok(t24note.note.includes("الفيديو:") && t24note.note.includes("الاختبار:") && t24note.note.includes("الواجب:"), "T24: the note lists exactly what is pending");
  const t24audit = await client.auditLog.findMany({ where: { action: "TEACHER_NOTE_CREATE", entityId: t24note.id } });
  eq(t24audit.length, 1, "T24: the send is audited (TEACHER_NOTE_CREATE)");
  const t24notif = await client.notification.findMany({ where: { userId: parentUserP.id } });
  eq(t24notif.length, 1, "T24: ONE notification row for the parent");
  eq(t24notif[0].type, "ANNOUNCEMENT", "T24: the EXISTING announcement type (no new subsystem)");
  eq(t24notif[0].link ?? null, null, "T24: no deep link (scope-safe, like manual notes)");
  const t24ready = await POST_JSON(R.remind, "http://t/api/teacher/readiness/remind", { studentId: sAbsentU.student.id, lessonId: L1.id });
  eq(t24ready.status, 409, "T24: remind a READY student → 409 (never spammed)");
  eq(t24ready.json.error, "لا يمكن التذكير — الطالب جاهز.", "T24: the Arabic message is exact (api.366)");
  eq((await POST_JSON(R.remind, "http://t/api/teacher/readiness/remind", { studentId: "nope", lessonId: L1.id })).status, 404, "T24: unknown student → 404");
  eq((await POST_JSON(R.remind, "http://t/api/teacher/readiness/remind", { studentId: sPresent.student.id, lessonId: Lforeign.id })).status, 404, "T24: foreign lesson → 404");
  asUser(sPresent.user);
  eq((await POST_JSON(R.remind, "http://t/api/teacher/readiness/remind", { studentId: sPresent.student.id, lessonId: L1.id })).status, 403, "T24: a student → 403");
  const remindSrc = read("src/app/api/teacher/readiness/remind/route.ts");
  ok(/createTeacherNoteWithFanout/.test(remindSrc), "T24: the remind sends through the SHARED notes helper (source pin)");
  ok(!/notification\.create|createNotification\(/.test(remindSrc), "T24: no direct notification write in the remind route (source pin)");

  // ===========================================================================
  // T25. Redaction: locked lessons leak NOTHING (denial shape, no titles, no
  // items); locked lessons' recordings accrue nothing.
  // ===========================================================================
  const t25 = await lessonVideoOf(sPresent.user, L2.id);
  eq(t25.status, 403, "T25: the chain-locked lesson denies (403)");
  ok(((t25.json.unmet) || []).some((u) => u.kind === "PREVIOUS_INCOMPLETE"), "T25: the denial names the chain");
  const t25flat = JSON.stringify(t25.json);
  ok(!/items|Recording|Next session/.test(t25flat), "T25: the denial carries NO items, NO video titles, NO lesson titles");
  asUser(admin);
  const t25v = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: L2.id, mode: "ALL_STUDENTS", percent: "95" })
  );
  eq(t25v.status, 200, "T25: a recording on the locked lesson stages (200)");
  const t25b = await beat(sPresent.user, t25v.json.video.id, 10, 100);
  eq(t25b.status, 403, "T25: a beat for a locked lesson's recording → 403 (never silently stored)");
  eq(await client.sessionVideoView.count({ where: { sessionVideoId: t25v.json.video.id } }), 0, "T25: the refused beat stored NO row");

  // ===========================================================================
  // T26. Garbage / incomplete absent configurations refused (api.362/364).
  // ===========================================================================
  asUser(admin);
  const t26a = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: L3.id, mode: "SOMETIMES" })
  );
  eq(t26a.status, 422, "T26: garbage mode on create → 422");
  eq(t26a.json.code, "INVALID_REQUIREMENT_MODE", "T26: the machine code names the contract");
  eq(t26a.json.error, "وضع المتطلب غير صالح.", "T26: the Arabic message is exact (api.362)");
  const t26b = await PATCH_JSON(R.adminVideo, `http://t/api/admin/session-videos/${vOpt.id}`, { requirementMode: "EVERYONE" }, { id: vOpt.id });
  eq(t26b.status, 422, "T26: garbage mode on edit → 422");
  const t26c = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: L3.id, mode: "ABSENT_STUDENTS" })
  );
  eq(t26c.status, 422, "T26: ABSENT without session on create → 422");
  eq(t26c.json.code, "ABSENT_REQUIRES_SESSION", "T26: the machine code names the contract");
  eq(t26c.json.error, "وضع الغائبين يتطلب اختيار الحصة المرتبطة.", "T26: the Arabic message is exact (api.364)");

  // ===========================================================================
  // T27. Migration: additive-only, meaning-preserving backfill, provider
  // parity (executed against scratch SQLite + content pins on both files).
  // ===========================================================================
  {
    const migSqlite = read("prisma/migrations/20260921180000_session_video_requirement_modes/migration.sql");
    const migPg = read("prisma/postgres/migrations/20260921180000_session_video_requirement_modes/migration.sql");
    const stripComments = (s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const [tag, sql] of [["sqlite", migSqlite], ["pg", migPg]]) {
      const code = stripComments(sql);
      ok(!/\bDROP\s+TABLE|\bDROP\s+COLUMN|\bDELETE\s+FROM|\bTRUNCATE\b/i.test(code), `T27: the ${tag} migration has zero destructive statements`);
      ok(/UPDATE\s+"SessionVideo"\s+SET\s+"requirementMode"\s*=\s*'ALL_STUDENTS'\s+WHERE\s+"isRequiredForProgression"/i.test(code), `T27: the ${tag} backfill maps legacy-required → ALL_STUDENTS only`);
    }
    ok(/CREATE TYPE "SessionVideoRequirementMode" AS ENUM \('OPTIONAL', 'ALL_STUDENTS', 'ABSENT_STUDENTS'\)/.test(migPg), "T27: the PG edition declares the native enum (provider parity)");
    ok(/FOREIGN KEY \("liveSessionId"\) REFERENCES "LiveSession"\("id"\) ON DELETE SET NULL/.test(migPg), "T27: the PG edition carries the FK (provider parity)");
    ok(migSqlite !== migPg, "T27: the two editions are distinct provider-specific files");
    // Execute the SQLite edition against a pre-migration-shaped scratch DB.
    const scratch = new DatabaseSync(":memory:");
    scratch.exec('CREATE TABLE "SessionVideo" (id TEXT PRIMARY KEY, "isRequiredForProgression" BOOLEAN DEFAULT false);');
    scratch.exec(`INSERT INTO "SessionVideo" (id, "isRequiredForProgression") VALUES ('r1', 1), ('r2', 0);`);
    for (const stmt of stripComments(migSqlite).split(";").map((s) => s.trim()).filter(Boolean)) scratch.exec(stmt);
    const rows = scratch.prepare('SELECT id, "requirementMode", "liveSessionId" FROM "SessionVideo" ORDER BY id').all();
    eq(rows, [
      { id: "r1", requirementMode: "ALL_STUDENTS", liveSessionId: null },
      { id: "r2", requirementMode: "OPTIONAL", liveSessionId: null },
    ], "T27: executed — legacy-required → ALL_STUDENTS, optional → OPTIONAL, no links invented");
    scratch.exec(`INSERT INTO "SessionVideo" (id) VALUES ('r3');`);
    eq(scratch.prepare('SELECT "requirementMode" FROM "SessionVideo" WHERE id = ?').get("r3"), { requirementMode: "OPTIONAL" }, "T27: executed — new rows default to OPTIONAL");
    scratch.close();
    for (const schema of ["prisma/schema.prisma", "prisma/postgres/schema.prisma"]) {
      const src = read(schema);
      ok(/enum SessionVideoRequirementMode \{\s+OPTIONAL\s+ALL_STUDENTS\s+ABSENT_STUDENTS\s+\}/.test(src), `T27: ${schema} declares the enum`);
      ok(/requirementMode SessionVideoRequirementMode @default\(OPTIONAL\)/.test(src), `T27: ${schema} carries the mode column`);
      ok(/liveSessionId String\?/.test(src), `T27: ${schema} carries the session link`);
    }
  }

  // ===========================================================================
  // T28. Readiness is batched: bounded queries for the whole roster (no N+1).
  // A naive per-student loader would issue 8 × ~12 ≈ 96+ calls here.
  // ===========================================================================
  {
    asUser(teacherUser);
    let calls = 0;
    const raw = globalThis.__CM_DB_CLIENT__;
    const counted = Object.create(Object.getPrototypeOf(raw));
    Object.assign(counted, raw);
    for (const key of Object.keys(raw)) {
      const delegate = raw[key];
      if (!delegate || typeof delegate !== "object") continue;
      counted[key] = new Proxy(delegate, {
        get(d, m) {
          const v = d[m];
          if (typeof v !== "function") return v;
          return (...a) => {
            calls++;
            return v.apply(d, a);
          };
        },
      });
    }
    globalThis.__CM_DB_CLIENT__ = counted;
    try {
      const r = await GET(R.readiness, `http://t/api/teacher/lessons/${L1.id}/readiness`, { id: L1.id });
      eq(r.status, 200, "T28: the counted readiness read → 200");
    } finally {
      globalThis.__CM_DB_CLIENT__ = raw;
    }
    ok(calls <= 40, `T28: ${calls} db calls for 8 students (bounded — no N+1)`);
  }

  // ===========================================================================
  // T29. Admin selector: theme tokens only (light/dark safe by construction).
  // ===========================================================================
  {
    const adminSrc = read("src/components/admin/session-videos-view.tsx");
    ok(!/text-gray-|bg-white|bg-gray-|text-black|border-gray-/.test(adminSrc), "T29: zero hardcoded palette classes in the admin view");
    // The selectors are the themed ui/select (token-driven popover), never
    // native: a native option popup ignores the dark theme. Comments may
    // name the forbidden tags while explaining the rule, so strip them.
    const adminCode = adminSrc.replace(/\/\*[\s\S]*?\*\//g, "");
    ok(adminSrc.includes('from "@/components/ui/select"'), "T29: the selector uses the themed Select component");
    ok(adminSrc.includes("SelectTrigger") && adminSrc.includes("SelectContent") && adminSrc.includes("SelectItem"), "T29: the selector renders trigger + content + items");
    ok(!/<select[\s>]/.test(adminCode) && !/<option[\s>]/.test(adminCode) && !/<optgroup[\s>]/.test(adminCode), "T29: no native select/option popups (dark-mode hostile)");
  }

  // ===========================================================================
  // T30. Exact Arabic copy (admin selector, student states, api errors).
  // ===========================================================================
  {
    const dict = read("src/lib/i18n-dict-2026.ts");
    const pin = (key, ar) => ok(dict.includes(`"${key}": { ar: "${ar}"`), `T30: ${key} is verbatim «${ar}»`);
    pin("admin.635", "اختياري");
    pin("admin.636", "مطلوب من كل الطلاب");
    pin("admin.637", "مطلوب من الطلاب الغائبين فقط");
    pin("course.247", "مطلوب منك لتعويض غيابك عن الحصة");
    pin("course.248", "غير مطلوب منك — حضرت الحصة");
    pin("course.249", "غير مطلوب منك — غيابك بعذر مقبول");
    pin("course.251", "غير مطلوب منك");
    const apiPin = (key, ar) => ok(dict.includes(`"${key}": { ar: "${ar}"`), `T30: ${key} is verbatim «${ar}»`);
    apiPin("api.362", "وضع المتطلب غير صالح.");
    apiPin("api.363", "وضع الغائبين يتطلب ربط الفيديو بدرس.");
    apiPin("api.364", "وضع الغائبين يتطلب اختيار الحصة المرتبطة.");
    apiPin("api.365", "الحصة المختارة غير صالحة لهذا الفيديو.");
    apiPin("api.366", "لا يمكن التذكير — الطالب جاهز.");
    const adminSrc = read("src/components/admin/session-videos-view.tsx");
    ok(/admin\.635/.test(adminSrc) && /admin\.636/.test(adminSrc) && /admin\.637/.test(adminSrc), "T30: the selector renders the three exact options");
  }

  // ===========================================================================
  // T31. Regression guards: the notes extraction is identical, legacy
  // flag-only rows still gate as ALL, OPTIONAL never gates, the core is
  // untouched.
  // ===========================================================================
  asUser(teacherUser);
  const t31n = await POST_JSON(R.studentNotes, "http://t/api/teacher/student-notes", { studentId: sPresent.student.id, note: "ملاحظة يدوية بعد الاستخراج" });
  eq(t31n.status, 201, "T31: manual notes still send after the extraction (201)");
  ok(t31n.json.notifiedParents >= 1, "T31: the manual note still fans out to linked parents");
  // Legacy flag-only row (direct-seeded, mode default): gates as ALL.
  const mediaFlag = await client.mediaAsset.create({
    data: { kind: "VIDEO", storage: "LOCAL_PRIVATE", storageKey: "k-flag", isPrivate: true },
  });
  const vFlag = await client.sessionVideo.create({
    data: {
      batchId: batchAr.id, lessonId: L1.id, mediaAssetId: mediaFlag.id,
      title: "Flag only", titleAr: "علم فقط", requiredPercent: 95,
      isRequiredForProgression: true, isPublished: true, publishedAt: new Date(),
    },
  });
  const t31f = await lessonVideoOf(sPresent.user, L1.id);
  const flagItem = t31f.json.requirements.video.items.find((i) => i.id === vFlag.id);
  eq([flagItem?.requirementMode, flagItem?.currentPercent], ["ALL_STUDENTS", 0], "T31: a flag-only row gates as ALL_STUDENTS (legacy fallback)");
  await client.sessionVideo.delete({ where: { id: vFlag.id } });
  const t31o = await lessonVideoOf(sUnmarked.user, L1.id);
  const oIds = [
    ...(t31o.json.requirements.video.items || []).map((i) => i.id),
    ...((t31o.json.requirements.video.exempt) || []).map((e) => e.id),
  ];
  ok(!oIds.includes(vOpt.id), "T31: the OPTIONAL row appears in NEITHER items NOR exempt (never an input)");
  const coreSrc = read("src/lib/progression.ts");
  ok(/requiredVideos\.every\(\s+\(v\) => v\.trackable && \(watchPercent\?\.get\(v\.id\) \?\? 0\) >= v\.requiredPercent/.test(coreSrc), "T31: the core's video rule is byte-identical (untouched)");
  ok(/videoRequired = lesson\.hasLegacyVideo \|\| requiredVideos\.length > 0/.test(coreSrc), "T31: the core's requiredness rule is byte-identical (untouched)");
  if (fail > 0) throw new Error(`${fail} assertion(s) failed:\n- ` + failures.join("\n- "));
});
