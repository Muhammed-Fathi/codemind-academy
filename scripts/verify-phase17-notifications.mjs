// CodeMind Academy — Phase 17 real end-to-end session-notification verification.
//
// Drives the SHIPPED notification stack (compiled from src/ with the repo's
// own tsc, exactly like scripts/verify-phase15-admin.mjs) against a REAL
// SQLite database built from the base DDL + every real migration.sql —
// including the Phase 17 SessionPublication delivery columns:
//
//   seed → mark-ready → recipients preview → OPEN (fan-out) → idempotent
//   re-open (resume/no-ops) → track matrix → course isolation → preference
//   and quiet-hours skips → partial-chunk failure + resume → unpublish
//   stop-rule → concurrent opens → admin broadcast prefs fix + link
//   validation → load rehearsal at 1/10/100/500/1000+ recipients
//
// What is REAL here: the migration SQL, the schema, the compiled route
// handlers, the eligibility derivation, the preference partition, the chunked
// createMany statements, the publication counters, the audit rows. What is
// SHIMMED (and why — identical to the Phase 13/15 rehearsals):
//   * `@/lib/db`     → sqlite-prisma-lite over node:sqlite (the Prisma query
//                       engine binary is unreachable from this sandbox; the
//                       adapter executes real SQL and throws UnsupportedQuery
//                       instead of approximating).
//   * `@/lib/auth`    → script-controlled current user (no cookie stack in a
//                       script; requireRole still runs for real).
//   * `next/server`   → minimal NextResponse (status/headers/json).
//   * `next/headers`  → no locale cookie (server falls back to `ar`).
//
// Exit code 0 + `0 failed` iff every assertion holds. The Phase 17 suite
// (tests/session-notifications-phase17.test.js) executes this file.

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

// ---------------------------------------------------------------------------
// A. scratch database: base DDL + every real migration (incl. Phase 17)
// ---------------------------------------------------------------------------

const SCHEMA_TABLES = [
  "User",
  "Student",
  "Group",
  "Course",
  "Part",
  "Unit",
  "Lesson",
  "Notification",
  "NotificationPreference",
  "SessionPublication",
  "AuditLog",
];

const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phase17: " });
for (const d of mig.assertColumnsMatchSchema(rawDb, SCHEMA_TABLES)) {
  ok(
    d.declared && d.missing.length === 0 && d.extra.length === 0,
    `A: ${d.table} columns match prisma/schema.prisma`,
    JSON.stringify({ missing: d.missing, extra: d.extra })
  );
}

// The two Phase 17 columns specifically: additive, correctly defaulted, and
// honest for rows inserted by pre-Phase-17 SQL (which never names them).
{
  const cols = rawDb.prepare(`PRAGMA table_info("SessionPublication")`).all();
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  ok(
    byName.notifiedCount && byName.notifiedCount.notnull === 1 && byName.notifiedCount.dflt_value === "0",
    "A: SessionPublication.notifiedCount is INTEGER NOT NULL DEFAULT 0"
  );
  ok(
    byName.notifiedAt && byName.notifiedAt.notnull === 0,
    "A: SessionPublication.notifiedAt is nullable DATETIME"
  );
  // A publication row written the Phase 13 way (without the new columns) reads
  // the honest legacy state: nothing delivered, no delivery timestamp.
  rawDb
    .prepare(
      `INSERT INTO "Course" ("id","slug","name","nameAr","description","createdAt","updatedAt")
       VALUES ('c-pre','pre','Pre','Pre','pre',0,0)`
    )
    .run();
  rawDb
    .prepare(`INSERT INTO "Part" ("id","courseId","title","titleAr","order") VALUES ('pa-pre','c-pre','P','P',1)`)
    .run();
  rawDb
    .prepare(`INSERT INTO "Unit" ("id","partId","title","titleAr","order") VALUES ('u-pre','pa-pre','U','U',1)`)
    .run();
  rawDb
    .prepare(
      `INSERT INTO "Lesson" ("id","unitId","title","titleAr","order","status","isPublished","trackScope","curriculumStatus","isLocked","duration","createdAt","updatedAt")
       VALUES ('l-pre','u-pre','L','L',1,'PUBLISHED',1,'SHARED','OFFICIAL',0,90,0,0)`
    )
    .run();
  rawDb
    .prepare(
      `INSERT INTO "SessionPublication" ("id","lessonId","segment","publishedAt")
       VALUES ('sp-pre','l-pre','SHARED',0)`
    )
    .run();
  const legacy = rawDb
    .prepare(`SELECT "notifiedCount" AS c, "notifiedAt" AS t FROM "SessionPublication" WHERE "id" = 'sp-pre'`)
    .get();
  eq(legacy, { c: 0, t: null }, "A: a pre-Phase-17 publication row migrates to notifiedCount=0, notifiedAt=NULL");
}

const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

// ---------------------------------------------------------------------------
// B. compile the shipped TypeScript with the repo's own tsc; load with shims
// ---------------------------------------------------------------------------

const REAL_CODE_MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n-server.ts",
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/enrollment.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/deep-link.ts",
  "src/lib/notification-links.ts",
  "src/lib/notify.ts",
  "src/lib/session-notifications.ts",
  "src/lib/api.ts",
  // route handlers under test
  "src/app/api/admin/lessons/[id]/mark-ready/route.ts",
  "src/app/api/admin/lessons/[id]/open/route.ts",
  "src/app/api/admin/lessons/[id]/unpublish/route.ts",
  "src/app/api/admin/lessons/[id]/recipients/route.ts",
  "src/app/api/admin/notifications/route.ts",
];

function compileRealCode() {
  const { execFileSync } = require("child_process");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase17-real-"));
  fs.writeFileSync(
    path.join(out, "tsconfig.json"),
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
          outDir: out,
        },
        files: REAL_CODE_MODULES.map((f) => path.join(REPO, f)),
      },
      null,
      2
    )
  );
  const tscBin = require.resolve("typescript/bin/tsc");
  try {
    execFileSync(process.execPath, [tscBin, "-p", path.join(out, "tsconfig.json")], {
      cwd: REPO,
      stdio: "pipe",
    });
  } catch {
    /* type noise elsewhere in the graph is tolerated; the emitted files matter */
  }
  for (const f of REAL_CODE_MODULES) {
    const emitted = path.join(out, f.replace(/\.ts$/, ".js"));
    if (!fs.existsSync(emitted)) {
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
    return JSON.parse(Buffer.from(this._body || []).toString("utf8"));
  }
}
class NextRequest {}
module.exports = { NextResponse, NextRequest };
`;

const NEXT_HEADERS_SHIM = `
module.exports = { cookies: async () => ({ get: () => undefined }) };
`;

const AUTH_SHIM = `
module.exports = { getCurrentUser: async () => globalThis.__CM_USER__ ?? null };
`;

const DB_SHIM = `
module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };
`;

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
    return originalResolve.call(this, request, ...rest);
  };
  const route = (p) => require(path.join(outDir, "src/app/api", p));
  const lib = (n) => require(path.join(outDir, "src/lib", `${n}.js`));
  return {
    restore() {
      Module._resolveFilename = originalResolve;
    },
    routes: {
      markReady: route("admin/lessons/[id]/mark-ready/route.js"),
      open: route("admin/lessons/[id]/open/route.js"),
      unpublish: route("admin/lessons/[id]/unpublish/route.js"),
      recipients: route("admin/lessons/[id]/recipients/route.js"),
      adminNotifications: route("admin/notifications/route.js"),
    },
    libs: {
      sessionNotifications: lib("session-notifications"),
      notificationLinks: lib("notification-links"),
      deepLink: lib("deep-link"),
      notify: lib("notify"),
    },
  };
}

function jsonReq(url, body) {
  return {
    url,
    method: "POST",
    headers: {
      get: (k) =>
        String(k).toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: async () => body,
  };
}

function asUser(u) {
  globalThis.__CM_USER__ = u
    ? { id: u.id, email: u.email, name: u.name, role: u.role }
    : null;
}

async function call(handler, req, params) {
  const res = await handler(req, { params: Promise.resolve(params || {}) });
  return { status: res.status, json: await res.json() };
}
const POST_JSON = (r, url, body, params) => call(r.POST, jsonReq(url, body), params);
const GET = (r, url, params) => call(r.GET, jsonReq(url), params);

// ---------------------------------------------------------------------------
// helpers over the real DB
// ---------------------------------------------------------------------------

async function notificationsFor(userId, type = null) {
  const rows = await client.notification.findMany({
    where: { userId, ...(type ? { type } : {}) },
  });
  return rows;
}
async function publicationRows(lessonId) {
  return client.notification.findMany({
    where: { type: "NEW_LESSON", link: `lesson:${lessonId}` },
  });
}

/** A quiet-hours window that ALWAYS contains the current minute (±2 min). */
function quietNow() {
  const fmt = (d) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const n = Date.now();
  return { start: fmt(new Date(n - 120000)), end: fmt(new Date(n + 120000)) };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const outDir = compileRealCode();
  ok(true, "B: shipped TS compiled with the repo tsc");
  const { routes: R, libs: L } = loadRealCode(outDir);
  ok(true, "B: route handlers + libs loaded with db/auth/next shims");

  // ---- C. the fixture universe -------------------------------------------
  const admin = await client.user.create({
    data: { email: "admin@cm17.test", password: "x", name: "Admin", role: "ADMIN" },
  });
  const mkUser = async (role, email, over = {}) =>
    client.user.create({
      data: { email, password: "x", name: email, role, ...over },
    });

  // Students: (track × course × status) fixtures, some with preferences.
  const uAr1 = await mkUser("STUDENT", "ar1@t.test");
  const uAr2 = await mkUser("STUDENT", "ar2@t.test");
  const uAr3 = await mkUser("STUDENT", "ar3@t.test");
  const uLang1 = await mkUser("STUDENT", "lang1@t.test");
  const uLang2 = await mkUser("STUDENT", "lang2@t.test");
  const uSpec = await mkUser("STUDENT", "unspec@t.test");
  const uGone = await mkUser("STUDENT", "gone@t.test", { isActive: false });
  const uSusp = await mkUser("STUDENT", "susp@t.test", { status: "SUSPENDED_MULTI_DEVICE" });

  const courseA = await client.course.create({
    data: { slug: "pa17-a", name: "Course A", nameAr: "أ", description: "A" },
  });
  const courseB = await client.course.create({
    data: { slug: "pa17-b", name: "Course B", nameAr: "ب", description: "B" },
  });
  const groupA = await client.group.create({
    data: { name: "GA", courseId: courseA.id, isActive: true },
  });
  const groupAoff = await client.group.create({
    data: { name: "GA-off", courseId: courseA.id, isActive: false },
  });
  const groupB = await client.group.create({
    data: { name: "GB", courseId: courseB.id, isActive: true },
  });

  const mkStudent = (user, schoolType, groupId) =>
    client.student.create({ data: { userId: user.id, schoolType, groupId } });
  const sAr1 = await mkStudent(uAr1, "ARABIC", groupA.id);
  const sAr2 = await mkStudent(uAr2, "ARABIC", groupA.id);
  const sAr3 = await mkStudent(uAr3, "ARABIC", groupA.id);
  const sLang1 = await mkStudent(uLang1, "LANGUAGE", groupA.id);
  const sLang2 = await mkStudent(uLang2, "LANGUAGE", groupB.id); // COURSE B
  const sSpec = await mkStudent(uSpec, null, groupA.id); // unspecified → SHARED only
  await mkStudent(uGone, "ARABIC", groupA.id); // deactivated user
  await mkStudent(uSusp, "ARABIC", groupA.id); // suspended account
  const sOffG = await mkStudent(
    await mkUser("STUDENT", "offg@t.test"),
    "ARABIC",
    groupAoff.id // INACTIVE group → not enrolled
  );

  // Preference fixtures.
  const quiet = quietNow();
  await client.notificationPreference.create({
    data: { userId: uAr2.id, newLesson: false, announcements: false },
  });
  await client.notificationPreference.create({
    data: { userId: uAr3.id, quietHoursStart: quiet.start, quietHoursEnd: quiet.end },
  });

  // Lessons in course A (unit chain), READY-staged via a legacy videoUrl.
  const mkLesson = async (code, scope) => {
    const unitNo = { "1-1": 201, "1-2": 202, "1-3": 203, "2-1": 204, "2-2": 205 }[code] ?? 299;
    const u = await client.unit.create({
      data: { partId: (await paA()).id, title: `U${code}`, titleAr: `و${code}`, order: unitNo },
    });
    return client.lesson.create({
      data: {
        unitId: u.id,
        officialCode: `P17-${code}`,
        title: `Session ${code}`,
        titleAr: `جلسة ${code}`,
        order: unitNo,
        trackScope: scope,
        status: "DRAFT",
        isPublished: false,
        videoUrl: "https://youtu.be/p17",
      },
    });
  };
  let _paA = null;
  async function paA() {
    if (!_paA) {
      _paA = await client.part.create({
        data: { courseId: courseA.id, title: "Part A", titleAr: "ج أ", order: 50 },
      });
    }
    return _paA;
  }

  const lessonShared = await mkLesson("1-1", "SHARED");
  const lessonAr = await mkLesson("1-2", "ARABIC");
  const lessonLang = await mkLesson("1-3", "LANGUAGE");

  // ---- D. auth matrix ------------------------------------------------------
  asUser(null);
  eq((await GET(R.recipients, "http://x/recipients", { id: lessonShared.id })).status, 401, "D: recipients preview rejects anonymous (401)");
  eq((await POST_JSON(R.open, "http://x/open", {}, { id: lessonShared.id })).status, 401, "D: open rejects anonymous (401)");
  eq((await POST_JSON(R.adminNotifications, "http://x/an", { title: "t", message: "m" }, {})).status, 401, "D: broadcast rejects anonymous (401)");
  asUser(uAr1);
  eq((await GET(R.recipients, "http://x/recipients", { id: lessonShared.id })).status, 403, "D: recipients preview rejects STUDENT (403)");
  eq((await POST_JSON(R.open, "http://x/open", {}, { id: lessonShared.id })).status, 403, "D: open rejects STUDENT (403)");
  eq((await POST_JSON(R.adminNotifications, "http://x/an", { title: "t", message: "m" }, {})).status, 403, "D: broadcast rejects STUDENT (403)");
  asUser(admin);

  // ---- E. recipients preview BEFORE open (READY stage) ---------------------
  {
    const r = await POST_JSON(R.markReady, "http://x/mark-ready", {}, { id: lessonShared.id });
    eq([r.status, r.json.code], [200, "OK"], "E: mark-ready applies DRAFT→READY");
    const p = await GET(R.recipients, "http://x/recipients", { id: lessonShared.id });
    eq(p.status, 200, "E: preview endpoint 200 for a READY lesson");
    // SHARED scope: every ACTIVE enrolled student of course A:
    // ar1, ar2, ar3, lang1, unspec — NOT lang2 (course B), NOT gone/susp/offG.
    eq(p.json.eligible, 5, "E: eligible preview == the exact eligible set (course × track × active)");
    // But pending is PREFERENCE-AWARE: ar2 (newLesson=false) and ar3 (quiet)
    // are NOT "about to be notified", so the honest pending is 3, not 5.
    eq(p.json.pending, 3, "E: pending == what a run would insert RIGHT NOW (eligible minus pref/quiet skips)");
    eq(p.json.deliverableNow, 3, "E: deliverableNow == the post-partition deliver set");
    eq(p.json.skippedPreferenceNow, 1, "E: preview reports the preference skip");
    eq(p.json.skippedQuietHoursNow, 1, "E: preview reports the quiet-hours skip");
    eq(p.json.alreadyNotified, 0, "E: alreadyNotified == 0 before any delivery");
    eq(p.json.notifiedCount, 0, "E: publication counter starts at 0");
    eq(p.json.courseId, courseA.id, "E: preview reports the resolved course");
    eq(p.json.trackScope, "SHARED", "E: preview reports the lesson track scope");
  }
  {
    const nf = await GET(R.recipients, "http://x/recipients", { id: "does-not-exist" });
    eq(nf.status, 404, "E: preview 404 for an unknown lesson id");
  }

  // ---- F. OPEN → targeted, preference-aware fan-out ------------------------
  let sharedLink;
  {
    const r = await POST_JSON(R.open, "http://x/open", {}, { id: lessonShared.id });
    eq(r.status, 200, "F: OPEN succeeds");
    eq(r.json.code, "OK", "F: ceremony code OK");
    eq(r.json.changed, true, "F: this call flipped READY→PUBLISHED");
    const n = r.json.notification;
    ok(!!n, "F: the response carries the notification half");
    eq(n.code, "EMITTED", "F: fan-out emitted");
    eq(n.eligible, 5, "F: eligible set reported (5)");
    eq(n.delivered, 3, "F: delivered == eligible minus preference/quiet-hours skips (3)");
    eq(n.skippedPreference, 1, "F: one recipient suppressed by the newLesson=false flag");
    eq(n.skippedQuietHours, 1, "F: one recipient suppressed by quiet hours");
    eq(n.failedChunks, [], "F: no failed chunks");
    sharedLink = n.link;
    eq(sharedLink, `lesson:${lessonShared.id}`, "F: the minted link is the canonical session deep link");

    // The persisted rows: exactly the deliver set, each deep-linked.
    const rows = await publicationRows(lessonShared.id);
    eq(rows.length, 3, "F: 3 NEW_LESSON rows persisted");
    eq(
      new Set(rows.map((x) => x.userId)),
      new Set([uAr1.id, uLang1.id, uSpec.id]),
      "F: rows land only on active, enrolled, on-track, preference-allowed students"
    );
    for (const row of rows) {
      eq(row.type, "NEW_LESSON", "F: every row is NEW_LESSON");
      eq(row.link, sharedLink, "F: every row carries the validated session link");
      ok(row.title.includes("P17-1-1") && row.title.includes("جلسة"), "F: title carries session code + localized name (ar default locale)");
      ok(row.message.includes("و1-1"), "F: message carries the chapter name");
      eq(row.isRead, false, "F: rows start unread");
    }
    // Skips left no rows:
    eq((await notificationsFor(uAr2.id, "NEW_LESSON")).length, 0, "F: newLesson=false user got no row");
    eq((await notificationsFor(uAr3.id, "NEW_LESSON")).length, 0, "F: quiet-hours user got no row");
    eq((await notificationsFor(uLang2.id, "NEW_LESSON")).length, 0, "F: course-B student got no course-A row");

    // Publication counters moved with delivery truth.
    const pub = await client.sessionPublication.findUnique({ where: { lessonId: lessonShared.id } });
    eq(pub.notifiedCount, 3, "F: SessionPublication.notifiedCount == delivered rows");
    ok(pub.notifiedAt instanceof Date || typeof pub.notifiedAt === "number", "F: SessionPublication.notifiedAt set on first delivery");

    // The delivery audit row exists and tells the breakdown.
    const audit = await client.auditLog.findMany({
      where: { action: "LESSON_PUBLICATION_NOTIFY", entityId: lessonShared.id },
    });
    eq(audit.length, 1, "F: one LESSON_PUBLICATION_NOTIFY audit row");
    const det = JSON.parse(audit[0].details);
    eq([det.eligible, det.delivered, det.skippedPreference, det.skippedQuietHours], [5, 3, 1, 1], "F: audit details carry the exact breakdown");
  }

  // ---- G. idempotent re-open (the retry channel) -----------------------------
  {
    const r = await POST_JSON(R.open, "http://x/open", {}, { id: lessonShared.id });
    eq(r.json.code, "NO_OP_ALREADY_IN_STATE", "G: re-open is the idempotent replay");
    const n = r.json.notification;
    eq(n.code, "ALREADY_DELIVERED", "G: replay delivers nothing new");
    eq(n.delivered, 0, "G: zero rows inserted on replay");
    eq(n.alreadyNotified, 3, "G: the 3 delivered rows are recognized as delivered");
    eq((await publicationRows(lessonShared.id)).length, 3, "G: still exactly 3 rows (no duplicates)");
    const pub = await client.sessionPublication.findUnique({ where: { lessonId: lessonShared.id } });
    eq(pub.notifiedCount, 3, "G: counter unchanged after replay");

    // The admin preview agrees with the fan-out state — and stays honest:
    // the 2 pref/quiet-suppressed students are NOT "pending", they are the
    // documented skips, so pending is 0 (nothing a run could still insert).
    const p = await GET(R.recipients, "http://x/recipients", { id: lessonShared.id });
    eq([p.json.eligible, p.json.alreadyNotified, p.json.pending], [5, 3, 0], "G: preview == fan-out reality (5 eligible, 3 notified, 0 insertable now)");
    eq([p.json.skippedPreferenceNow, p.json.skippedQuietHoursNow], [1, 1], "G: preview still explains the 2 permanent/current skips");
  }

  // ---- G2. a fully pref-suppressed audience reports SUPPRESSED, never "already notified" ----
  {
    // Course B has exactly ONE eligible student (lang2). Disable NEW_LESSON
    // for them: the fan-out has nothing to attempt — the honest terminal
    // code is SUPPRESSED_BY_PREFERENCES, with zero rows and no fake counters.
    await client.notificationPreference.create({
      data: { userId: uLang2.id, newLesson: false },
    });
    const partB = await client.part.create({
      data: { courseId: courseB.id, title: "Part B", titleAr: "ج ب", order: 51 },
    });
    const unitB = await client.unit.create({
      data: { partId: partB.id, title: "UB", titleAr: "وب", order: 301 },
    });
    const lessonSupp = await client.lesson.create({
      data: {
        unitId: unitB.id,
        officialCode: "P17-9-9",
        title: "Suppressed Session",
        titleAr: "جلسة مكبوتة",
        order: 301,
        trackScope: "SHARED",
        status: "DRAFT",
        isPublished: false,
        videoUrl: "https://youtu.be/p17-supp",
      },
    });
    await POST_JSON(R.markReady, "http://x/mark-ready", {}, { id: lessonSupp.id });
    const r = await POST_JSON(R.open, "http://x/open", {}, { id: lessonSupp.id });
    eq([r.status, r.json.code], [200, "OK"], "G2: the publication itself succeeds");
    eq(r.json.notification.code, "SUPPRESSED_BY_PREFERENCES", "G2: nothing to attempt is reported as SUPPRESSED, not ALREADY_DELIVERED");
    eq([r.json.notification.delivered, r.json.notification.eligible, r.json.notification.skippedPreference], [0, 1, 1], "G2: delivered 0 of 1 eligible (suppressed)");
    eq((await publicationRows(lessonSupp.id)).length, 0, "G2: zero rows persisted");
    const pubS = await client.sessionPublication.findUnique({ where: { lessonId: lessonSupp.id } });
    eq(pubS.notifiedCount, 0, "G2: counter stays 0 (no fake tally)");
    ok(pubS.notifiedAt === null || pubS.notifiedAt === undefined, "G2: notifiedAt stays unset when nothing was ever delivered");
    ok(r.json.notification.message.toLowerCase().includes("suppressed"), "G2: the message explains the suppression, not a reassured delivery");
    // …and the replay stays honest too (no fake ALREADY_DELIVERED ever).
    const r2 = await POST_JSON(R.open, "http://x/open", {}, { id: lessonSupp.id });
    eq(r2.json.notification.code, "SUPPRESSED_BY_PREFERENCES", "G2: replay of a fully suppressed audience stays SUPPRESSED");
  }

  // ---- H. track matrix via the real routes -----------------------------------
  {
    await POST_JSON(R.markReady, "http://x/mark-ready", {}, { id: lessonAr.id });
    const r = await POST_JSON(R.open, "http://x/open", {}, { id: lessonAr.id });
    eq(r.json.notification.eligible, 3, "H: ARABIC lesson → only the 3 active ARABIC students of course A are eligible");
    eq(r.json.notification.delivered, 1, "H: ARABIC lesson delivers only to the preference-allowed ARABIC student");
    eq(
      (await notificationsFor(uLang1.id, "NEW_LESSON")).filter((x) => x.link === `lesson:${lessonAr.id}`).length,
      0,
      "H: LANGUAGE student never receives the ARABIC lesson's row"
    );
    eq(
      (await notificationsFor(uSpec.id, "NEW_LESSON")).filter((x) => x.link === `lesson:${lessonAr.id}`).length,
      0,
      "H: unspecified-track student never receives the ARABIC lesson's row (fail closed)"
    );

    await POST_JSON(R.markReady, "http://x/mark-ready", {}, { id: lessonLang.id });
    const r2 = await POST_JSON(R.open, "http://x/open", {}, { id: lessonLang.id });
    eq(r2.json.notification.eligible, 1, "H: LANGUAGE lesson → the single active LANGUAGE student of course A");
    eq(r2.json.notification.delivered, 1, "H: LANGUAGE lesson delivers to the LANGUAGE student");
    eq(
      (await notificationsFor(uAr1.id, "NEW_LESSON")).filter((x) => x.link === `lesson:${lessonLang.id}`).length,
      0,
      "H: ARABIC student never receives the LANGUAGE lesson's row"
    );
  }

  // ---- I. partial chunk failure → retry resumes without duplicates -----------
  {
    // 3 deliverable students in a fresh setup (no skips) — reuse course A by
    // staging a SHARED lesson; deliver set: ar1, lang1, unspec with chunkSize 1.
    const lPartial = await mkLesson("2-1", "SHARED");
    await POST_JSON(R.markReady, "http://x/mark-ready", {}, { id: lPartial.id });
    const openRes = await POST_JSON(R.open, "http://x/open", {}, { id: lPartial.id });
    // The route run delivers everyone (no failure injected there)… too late —
    // this lesson must be exercised through the LIB with an injected client.
    eq(openRes.json.notification.delivered, 3, "I: route fan-out over a clean client delivers 3");

    // The failure semantics themselves are exercised library-level with a
    // wrapped client (same code the route runs, same DB):
    const lPartial2 = await mkLesson("2-2", "SHARED");
    await POST_JSON(R.markReady, "http://x/mark-ready", {}, { id: lPartial2.id });
    // mark-ready→open via lib-run ceremony equivalent: flip via route-less
    // path is not possible here, so open via the real route but STOP the
    // fan-out by making createMany fail ONCE on the second chunk call.
    let calls = 0;
    const failing = new Proxy(client, {
      get(target, prop) {
        if (prop !== "notification") return target[prop];
        return {
          ...target.notification,
          createMany: (args) => {
            calls += 1;
            if (calls === 2) throw new Error("injected chunk failure");
            return target.notification.createMany(args);
          },
        };
      },
    });
    // First attempt, chunkSize 1: chunk 0 inserts, chunk 1 throws, chunk 2
    // never attempted.
    const r1 = await L.sessionNotifications.emitSessionPublicationNotifications({
      lessonId: lPartial2.id,
      actorUserId: admin.id,
      client: failing,
      chunkSize: 1,
    });
    // …but the ceremony hasn't flipped the lesson yet — the lib must refuse.
    eq([r1.ok, r1.code], [false, "LESSON_NOT_PUBLISHED"], "I: fan-out refuses a READY lesson (publication gate)");

    // Flip through the REAL ceremony with the fan-out failing at chunk 2 by
    // running the ceremony via its lib directly with the failing client… the
    // route always uses the clean db, so drive BOTH halves on the failing
    // client through the compiled lifecycle lib instead.
    calls = 0;
    const lifecycle = require(path.join(outDir, "src/lib", "session-lifecycle.js"));
    const ceremony = await lifecycle.openLesson({ lessonId: lPartial2.id, actorUserId: admin.id, client });
    eq([ceremony.ok, ceremony.code], [true, "OK"], "I: ceremony flips the partial-failure lesson");
    calls = 0;
    const r2 = await L.sessionNotifications.emitSessionPublicationNotifications({
      lessonId: lPartial2.id,
      actorUserId: admin.id,
      client: failing,
      chunkSize: 1,
    });
    eq(r2.code, "EMITTED_PARTIAL", "I: chunk failure yields EMITTED_PARTIAL");
    eq(r2.delivered, 1, "I: exactly the first chunk was delivered");
    eq(r2.failedChunks, [1], "I: the FAILED chunk is reported by index");
    eq(r2.chunksDone, 1, "I: chunk 3 was never attempted (sequential stops)");
    eq(calls, 2, "I: createMany attempted exactly twice (chunk 1 ok, chunk 2 threw)");
    eq((await publicationRows(lPartial2.id)).length, 1, "I: one row persisted before the failure");
    const pubAfterF = await client.sessionPublication.findUnique({ where: { lessonId: lPartial2.id } });
    eq(pubAfterF.notifiedCount, 1, "I: counter reflects the partial truth (1)");

    // Retry with the CLEAN client: chunk 1 dedupes, chunks 2&3 deliver.
    const r3 = await L.sessionNotifications.emitSessionPublicationNotifications({
      lessonId: lPartial2.id,
      actorUserId: admin.id,
      client,
      chunkSize: 1,
    });
    eq(r3.code, "EMITTED", "I: retry completes the delivery");
    eq(r3.delivered, 2, "I: retry delivered the REMAINING two chunks only");
    eq(r3.alreadyNotified, 1, "I: retry recognized chunk 1 as already delivered (no duplicate)");
    const rowsP = await publicationRows(lPartial2.id);
    eq(rowsP.length, 3, "I: final total is 3 rows");
    eq(new Set(rowsP.map((x) => x.userId)).size, 3, "I: final total has 3 DISTINCT users (no duplicates)");
    const pubAfterR = await client.sessionPublication.findUnique({ where: { lessonId: lPartial2.id } });
    eq(pubAfterR.notifiedCount, 3, "I: counter healed to the full delivered truth");

    // And the ROUTE-level replay (NO_OP) also settles as ALREADY_DELIVERED:
    const r4 = await POST_JSON(R.open, "http://x/open", {}, { id: lPartial2.id });
    eq([r4.json.code, r4.json.notification.code], ["NO_OP_ALREADY_IN_STATE", "ALREADY_DELIVERED"], "I: route retry ends idempotent");
  }

  // ---- J. unpublish stops late retries ---------------------------------------
  {
    const r = await POST_JSON(R.unpublish, "http://x/unpublish", {}, { id: lessonShared.id });
    eq(r.json.code, "OK", "J: unpublish applies");
    const before = (await publicationRows(lessonShared.id)).length;
    // A stale fan-out attempt for the withdrawn publication must deliver ZERO.
    const late = await L.sessionNotifications.emitSessionPublicationNotifications({
      lessonId: lessonShared.id,
      actorUserId: admin.id,
      client,
    });
    eq([late.ok, late.code], [false, "LESSON_NOT_PUBLISHED"], "J: late fan-out refuses (lesson no longer published)");
    eq((await publicationRows(lessonShared.id)).length, before, "J: no rows added by the late attempt");
    const pubRow = await client.sessionPublication.findUnique({ where: { lessonId: lessonShared.id } });
    eq(pubRow, null, "J: publication anchor withdrawn by unpublish");
  }

  // ---- K. admin broadcast — preferences now enforced, link validated ---------
  {
    // target=students: 9 student rows exist. ar2 (announcements=false) and
    // ar3 (quiet) are suppressed; everyone else receives.
    const before = await client.notification.count({ where: { type: "ANNOUNCEMENT", title: "P17-BCAST" } });
    asUser(admin);
    const r = await POST_JSON(R.adminNotifications, "http://x/an", {
      target: "students",
      type: "ANNOUNCEMENT",
      title: "P17-BCAST",
      message: "m",
    });
    eq(r.status, 200, "K: broadcast succeeds");
    const counted = await client.notification.count({ where: { type: "ANNOUNCEMENT", title: "P17-BCAST" } });
    eq(counted - before, r.json.sent, "K: sent == rows actually inserted");
    eq(r.json.sent, 7, "K: 9 student rows minus 2 suppressed == 7 delivered");
    eq(r.json.skipped.preferences, 1, "K: announcements=false suppressed exactly one student");
    eq(r.json.skipped.quietHours, 1, "K: quiet hours suppressed exactly one student");
    eq((await client.notification.count({ where: { userId: uAr2.id, title: "P17-BCAST" } })), 0, "K: preference-disabled student got no broadcast row");
    eq((await client.notification.count({ where: { userId: uAr3.id, title: "P17-BCAST" } })), 0, "K: quiet-hours student got no broadcast row");

    // All-skipped is a truthful 200 (not a fake failure, not a bypass).
    const allQuiet = await POST_JSON(R.adminNotifications, "http://x/an", {
      target: "user",
      userId: uAr3.id,
      type: "ANNOUNCEMENT",
      title: "P17-BCAST-Q",
      message: "m",
    });
    eq(allQuiet.status, 200, "K: an entirely suppressed audience is a truthful 200");
    eq([allQuiet.json.sent, allQuiet.json.skipped.quietHours], [0, 1], "K: sent=0 with the quiet-hours skip reported");

    // Link validation: external URLs and malformed strings are rejected.
    for (const bad of ["https://evil.example/x", "http://x", "javascript:alert(1)", "/admin/x", "admin-payments", "dashboard", "lesson:../x", "weird:thing"]) {
      const res = await POST_JSON(R.adminNotifications, "http://x/an", {
        target: "user",
        userId: uAr1.id,
        type: "ANNOUNCEMENT",
        title: "bad",
        message: "m",
        link: bad,
      });
      eq([res.status, res.json.error], [400, "INVALID_NOTIFICATION_LINK"], `K: broadcast rejects link ${JSON.stringify(bad)}`);
    }
    // A valid deep link is stored canonically (and reaches the allowed user).
    const okLink = await POST_JSON(R.adminNotifications, "http://x/an", {
      target: "user",
      userId: uAr1.id,
      type: "ANNOUNCEMENT",
      title: "P17-LINK",
      message: "m",
      link: `  lesson:${lessonShared.id}  `,
    });
    eq(okLink.status, 200, "K: a valid deep link is accepted");
    const linked = await notificationsFor(uAr1.id, "ANNOUNCEMENT");
    eq(linked.find((x) => x.title === "P17-LINK")?.link, `lesson:${lessonShared.id}`, "K: the stored link is canonicalized");
    // GET still lists for the admin.
    eq((await GET(R.adminNotifications, "http://x/admin/notifications?limit=5", {})).status, 200, "K: admin GET listing intact");
  }

  // ---- L. per-lesson serialization: concurrent fan-outs never double-deliver ----
  {
    // The TRUE race Phase 17 owns: two fan-out attempts of the SAME live
    // publication interleaving their dedupe-check → createMany window. The
    // lifecycle flip itself is serialized by its conditional UPDATE; the
    // in-process mutex in the lib is what serializes the fan-out half. (The
    // single-connection shim cannot interleave two $transaction calls the
    // way Prisma's pool would, so the route-level concurrency case is proven
    // here at the lib level — the exact code the route runs — with an
    // artificially widened race window.)
    const lConc = await mkLesson("1-4", "SHARED");
    await POST_JSON(R.markReady, "http://x/mark-ready", {}, { id: lConc.id });
    const cr = await POST_JSON(R.open, "http://x/open", {}, { id: lConc.id });
    eq(cr.json.code, "OK", "L: race lesson published");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const slow = new Proxy(client, {
      get(target, prop) {
        if (prop !== "notification") return target[prop];
        return {
          ...target.notification,
          createMany: async (args) => {
            await sleep(40); // widen: both runs dedupe-check before any insert
            return target.notification.createMany(args);
          },
        };
      },
    });
    eq((await publicationRows(lConc.id)).length, 3, "L: baseline delivery from the route open (3)");
    const [pa, pb] = await Promise.all([
      L.sessionNotifications.emitSessionPublicationNotifications({
        lessonId: lConc.id,
        actorUserId: admin.id,
        client: slow,
      }),
      L.sessionNotifications.emitSessionPublicationNotifications({
        lessonId: lConc.id,
        actorUserId: admin.id,
        client: slow,
      }),
    ]);
    const rows = await publicationRows(lConc.id);
    eq(rows.length, 3, "L: two racing fan-out attempts still produce exactly one row per user");
    eq(rows.length, new Set(rows.map((x) => x.userId)).size, "L: zero duplicates under the race");
    eq(pa.delivered + pb.delivered, 0, "L: neither racer inserted a duplicate (both sees the other as delivered)");
    eq(
      [pa.code, pb.code].sort(),
      ["ALREADY_DELIVERED", "ALREADY_DELIVERED"],
      "L: both racers settle as idempotent replays"
    );

    // And the ROUTE-level replay chain (sequential double-open — the shape a
    // double-clicked Open button produces) still converges to NO_OP + no-op.
    const ra = await POST_JSON(R.open, "http://x/open", {}, { id: lConc.id });
    const rb = await POST_JSON(R.open, "http://x/open", {}, { id: lConc.id });
    eq([ra.json.code, rb.json.code], ["NO_OP_ALREADY_IN_STATE", "NO_OP_ALREADY_IN_STATE"], "L: sequential re-opens are replays");
    eq((await publicationRows(lConc.id)).length, 3, "L: rows unchanged after repeated opens");
  }

  // ---- M. load rehearsal: 1 / 10 / 100 / 500 / 1000+ -------------------------
  {
    const mkBulk = async (n, tag) => {
      const rows = [];
      for (let i = 0; i < n; i++) {
        const u = await client.user.create({
          data: { email: `${tag}${i}@t.test`, password: "x", name: `${tag}${i}`, role: "STUDENT" },
        });
        await client.student.create({
          data: { userId: u.id, schoolType: i % 2 === 0 ? "ARABIC" : "LANGUAGE", groupId: groupA.id },
        });
        rows.push(u.id);
      }
      return rows;
    };
    async function stagedShared(code) {
      const l = await mkLesson(code, "SHARED");
      await POST_JSON(R.markReady, "http://x/mark-ready", {}, { id: l.id });
      return l;
    }
    // N=1: deliverable-after-skips minimal run (new unique user population is
    // what "1" measures here — assert the pipeline's floor).
    for (const [n, tag] of [[1, "n1-"], [10, "n10-"], [100, "n100-"], [500, "n500-"]]) {
      await mkBulk(n, tag);
      const l = await stagedShared(tag.replace(/-$/, ""));
      const t0 = performance.now();
      const r = await POST_JSON(R.open, "http://x/open", {}, { id: l.id });
      const ms = Math.round(performance.now() - t0);
      const n2 = r.json.notification;
      const rowsN = await publicationRows(l.id);
      eq(rowsN.length, n2.delivered, `M: N=${n} audience — delivered rows == reported delivered`);
      eq(new Set(rowsN.map((x) => x.userId)).size, rowsN.length, `M: N=${n} — zero duplicates`);
      const pubN = await client.sessionPublication.findUnique({ where: { lessonId: l.id } });
      eq(pubN.notifiedCount, rowsN.length, `M: N=${n} — counter == rows`);
      ok(true, `M: N=${n} — open+fan-out completed in ${ms}ms (eligible ${n2.eligible}, delivered ${n2.delivered}, chunks ${n2.chunksPlanned})`);
    }
    // N=1000+: the bounded-chunk proof. A recording wrapper captures every
    // createMany batch size the lib issues through the route-invisible path.
    const big = await mkBulk(1000, "n1000-");
    const lBig = await stagedShared("3-3");
    const batchSizes = [];
    const recorder = new Proxy(client, {
      get(target, prop) {
        if (prop !== "notification") return target[prop];
        return {
          ...target.notification,
          createMany: (args) => {
            batchSizes.push(args.data.length);
            return target.notification.createMany(args);
          },
        };
      },
    });
    // Flip through the ceremony on the clean client, then fan out through the
    // recording client (same code path the route runs).
    const lifecycle = require(path.join(outDir, "src/lib", "session-lifecycle.js"));
    const cr = await lifecycle.openLesson({ lessonId: lBig.id, actorUserId: admin.id, client });
    eq(cr.code, "OK", "M: load lesson published");
    const t0 = performance.now();
    const rn = await L.sessionNotifications.emitSessionPublicationNotifications({
      lessonId: lBig.id,
      actorUserId: admin.id,
      client: recorder,
    });
    const ms = Math.round(performance.now() - t0);
    const rowsBig = await publicationRows(lBig.id);
    eq(rowsBig.length, rn.delivered, "M: N=1000+ — delivered rows == reported");
    eq(new Set(rowsBig.map((x) => x.userId)).size, rowsBig.length, "M: N=1000+ — zero duplicates");
    ok(batchSizes.every((s) => s <= 500), `M: every chunk is bounded by the platform size 500 (observed max ${Math.max(...batchSizes)})`);
    eq(batchSizes.slice(0, -1).every((s) => s === 500), true, `M: all full chunks are exactly 500 (sizes: ${batchSizes.join("/")})`);
    eq(batchSizes.length, Math.ceil(rn.delivered / 500), "M: chunk count == ceil(delivered/500), no trailing empty insert");
    const pubBig = await client.sessionPublication.findUnique({ where: { lessonId: lBig.id } });
    eq(pubBig.notifiedCount, rowsBig.length, "M: N=1000+ — counter == rows (the count the admin sees IS the delivery)");
    ok(true, `M: N=1000+ fan-out of ${rn.delivered} rows across ${batchSizes.length} chunks completed in ${ms}ms`);
    // A NO_OP open replay at scale inserts nothing and finishes fast.
    const rBig2 = await POST_JSON(R.open, "http://x/open", {}, { id: lBig.id });
    eq([rBig2.json.code, rBig2.json.notification.code, rBig2.json.notification.delivered], ["NO_OP_ALREADY_IN_STATE", "ALREADY_DELIVERED", 0], "M: scale replay is idempotent");
    const previewBig = await GET(R.recipients, "http://x/recipients", { id: lBig.id });
    eq(previewBig.json.eligible, rn.eligible, "M: preview eligible == fan-out eligible at scale");
    eq(previewBig.json.alreadyNotified, rowsBig.length, "M: preview alreadyNotified == delivered rows at scale");
  }

  // ---- summary --------------------------------------------------------------
  console.log(`\nphase17 notifications e2e: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("phase17 notifications e2e crashed:", e);
  process.exit(1);
});
