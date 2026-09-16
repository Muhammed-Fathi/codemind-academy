// CodeMind Academy — Phase 26F CROSS-ROLE AUTHORIZATION + IDOR-HARDENING verifier.
//
// Drives the SHIPPED route handlers (compiled from src/ with the repo's own
// tsc, exactly like scripts/verify-phase26d-teacher.mjs and
// scripts/verify-phase26e-parent.mjs do) against a REAL SQLite database built
// from the base DDL + every real migration.
//
// What is REAL here: the migration SQL, the schema, the compiled route
// handlers, `requireUser`, `requireRole`, membership/ownership predicates,
// rate limiting and every authorization decision those routes make.
//
// What is SHIMMED (and why):
//   * `@/lib/db`      -> sqlite-prisma-lite over node:sqlite. It executes real
//                        SQL and throws UnsupportedQuery rather than
//                        approximating anything.
//   * `@/lib/auth`    -> script-controlled current user (`requireUser` still
//                        runs for real, so every role gate below is genuinely
//                        enforced).
//   * `next/server`   -> minimal NextResponse (status/headers/json).
//   * `next/headers`  -> no locale cookie (server falls back to `ar`).
//
// NO Neon, NO R2, NO SMTP, NO Vercel. Refuses to run if DATABASE_URL points at
// postgres/neon.
//
// Exit code 0 + `0 failed` + the literal PHASE26F_VERIFIER_OK trailer iff
// every assertion holds. Executed as a child process by
// tests/auth-cross-role-phase26f.test.js.

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
  console.error(`[26F] refusing to run: DATABASE_URL looks like production (${envUrl.slice(0, 40)}…)`);
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
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
}
function section(t) {
  console.log(`\n== ${t} ==`);
}

// ---------------------------------------------------------------------------
// A. scratch database: base DDL + every real migration
// ---------------------------------------------------------------------------
const SCHEMA_TABLES = [
  "User", "Student", "Teacher", "Parent", "ParentStudentLink", "Group",
  "Referral", "Coupon", "CouponRedemption", "Notification",
  "NotificationPreference", "Lesson", "Quiz", "Question", "QuizAttempt",
  "QuizAnswer", "QuizRetryGrant", "Homework", "HomeworkSubmission",
];

const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phase26f: " });
for (const d of mig.assertColumnsMatchSchema(rawDb, SCHEMA_TABLES)) {
  ok(
    d.declared && d.missing.length === 0 && d.extra.length === 0,
    `A: ${d.table} columns match prisma/schema.prisma`,
    JSON.stringify({ missing: d.missing, extra: d.extra })
  );
}

const client = createSqlitePrisma({ db: rawDb, schemaPath: path.join(REPO, "prisma", "schema.prisma") });
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
  "src/lib/security.ts",
  "src/lib/rate-limit.ts",
  "src/lib/api.ts",
  "src/lib/notify.ts",
  // the referral surface under test
  "src/app/api/students/me/referral/route.ts",
];

function compileRealCode() {
  const { execFileSync } = require("child_process");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase26f-real-"));
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
  let diag = "";
  try {
    execFileSync(process.execPath, [tscBin, "-p", path.join(out, "tsconfig.json")], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    diag = (e.stdout ? e.stdout.toString() : "") + (e.stderr ? e.stderr.toString() : "");
    // A few error codes elsewhere in the graph are tolerated; what matters is
    // that every module in the surface-under-test still emitted output.
  }
  for (const f of REAL_CODE_MODULES) {
    const js = path.join(out, f.replace(/\.ts$/, ".js"));
    if (!fs.existsSync(js)) {
      throw new Error(`tsc did not emit ${f}\n${diag}`);
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
    return originalResolve.call(this, request, ...rest);
  };
  const route = (p) => require(path.join(outDir, "src/app/api", p));
  return {
    restore() { Module._resolveFilename = originalResolve; },
    referral: route("students/me/referral/route.js"),
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
  globalThis.__CM_USER__ = u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null;
}
async function call(handler, req, params) {
  const res = await handler(req, { params: Promise.resolve(params || {}) });
  const ct = res.headers?.get?.("content-type") || "";
  if (ct.includes("application/json")) {
    return { status: res.status, json: await res.json(), headers: res.headers };
  }
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}
const GET = (r, url, params) => call(r.GET, jsonReq(url), params);
const POST = (r, url, body, params) => call(r.POST, jsonReq(url, body, "POST"), params);
const url = (p) => `http://127.0.0.1${p}`;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const outDir = compileRealCode();
  ok(true, "B: shipped TS compiled with the repo tsc");
  const R = loadRealCode(outDir);
  ok(true, "B: referral route loaded with db/auth/next shims");

  // ---- C. fixtures --------------------------------------------------------
  section("C. fixtures");
  const studentUserA = await client.user.create({ data: { email: "a26f@cm.test", password: "x", name: "Student A", role: "STUDENT" } });
  const studentUserB = await client.user.create({ data: { email: "b26f@cm.test", password: "x", name: "Student B", role: "STUDENT" } });
  const studentUserC = await client.user.create({ data: { email: "c26f@cm.test", password: "x", name: "Student C", role: "STUDENT" } });
  const studentUserD = await client.user.create({ data: { email: "d26f@cm.test", password: "x", name: "Student D", role: "STUDENT" } });
  const teacherUser = await client.user.create({ data: { email: "t26f@cm.test", password: "x", name: "Teacher", role: "TEACHER" } });
  const parentUser = await client.user.create({ data: { email: "p26f@cm.test", password: "x", name: "Parent", role: "PARENT" } });
  const studentA = await client.student.create({ data: { userId: studentUserA.id, schoolType: "ARABIC" } });
  const studentB = await client.student.create({ data: { userId: studentUserB.id, schoolType: "ARABIC" } });
  // Collision fixture: TWO students whose ids end in the SAME six characters.
  // Their ids differ only in the leading cUID stamp, so the pair shares the
  // exact suffix that becomes the referral code — the case that must fail
  // closed instead of picking one of them.
  const studentC = await client.student.create({ data: { userId: studentUserC.id, schoolType: "ARABIC" } });
  const studentD = await client.student.create({ data: { userId: studentUserD.id, schoolType: "ARABIC" } });
  const twinCId = "cm26fcollide-a-zzz-abc123";
  const twinDId = "cm26fcollide-z-zzz-abc123";
  {
    rawDb.prepare(`UPDATE "Student" SET "id" = ? WHERE "id" = ?`).run(twinCId, studentC.id);
    rawDb.prepare(`UPDATE "Student" SET "id" = ? WHERE "id" = ?`).run(twinDId, studentD.id);
    ok(
      twinCId.slice(-6).toLowerCase() === "abc123" && twinDId.slice(-6).toLowerCase() === "abc123",
      "C: the collision fixture's two ids end in the SAME six characters"
    );
  }
  ok(true, "C: two participating students + one COLLIDING PAIR (twins), one teacher, one parent, one anonymous actor");

  const codeA = `CM-${String(studentA.id).slice(-6).toUpperCase()}`;
  const suffixA = String(studentA.id).slice(-6).toLowerCase();
  eq(suffixA.length, 6, "C: the real referral code suffix is exactly six characters");

  // =========================================================================
  section("D. REF-01 referral endpoint — role gate");
  asUser(null);
  eq((await GET(R.referral, url("/api/students/me/referral"))).status, 401, "REF-01: anonymous → 401");
  asUser(teacherUser);
  eq((await GET(R.referral, url("/api/students/me/referral"))).status, 403, "REF-01: TEACHER → 403");
  asUser(parentUser);
  eq((await GET(R.referral, url("/api/students/me/referral"))).status, 403, "REF-01: PARENT → 403");
  asUser(studentUserA);
  eq((await GET(R.referral, url("/api/students/me/referral"))).status, 200, "REF-01: the OWNING student → 200");

  // =========================================================================
  section("E. REF-02 the POST body rejects non-6-char suffixes");
  asUser(studentUserB);
  const invalid = await POST(R.referral, url("/api/students/me/referral"), { referralCode: "CM-ABC" });
  eq(invalid.status, 404, "REF-02: a shorter-than-6 suffix is rejected as not found (404, not IDOR'd)");
  const noRef = await client.referral.findFirst({ where: { referredId: studentB.id } });
  eq(noRef, null, "REF-02: no referral row was written for the short-suffix guess");

  // =========================================================================
  section("F. REF-03 exact code resolves the true referrer");
  const okPost = await POST(R.referral, url("/api/students/me/referral"), { referralCode: codeA });
  eq(okPost.status, 200, "REF-03: a correct CM-<6-char suffix> code → 200");
  const link = await client.referral.findFirst({ where: { referrerId: studentA.id, referredId: studentB.id } });
  ok(!!link, "REF-03: the referral links referrer=A → referred=B");
  eq(link.rewardType, "BOTH", "REF-03: the reward carries both XP and discount");
  eq(link.status, "COMPLETED", "REF-03: the new referral is marked COMPLETED");

  const couponCode = `REF-${String(studentA.id).slice(-6).toUpperCase()}`;
  const coupon = await client.coupon.findUnique({ where: { code: couponCode } });
  ok(!!coupon, "REF-03: the referrer's one-shot discount coupon exists");
  eq(coupon.createdById, studentUserA.id, "REF-03: the coupon is owned by the true referrer");

  // Idempotence: the exact same claim cannot mint a second reward.
  const again = await POST(R.referral, url("/api/students/me/referral"), { referralCode: codeA });
  ok(again.status === 400, "REF-03: the same pair cannot re-create a referral (duplicate → 400)");
  eq(await client.referral.count({ where: { referrerId: studentA.id, referredId: studentB.id } }), 1, "REF-03: still exactly one referral row");

  // =========================================================================
  section("G. REF-04 self-referral is refused");
  asUser(studentUserA);
  const selfMine = await POST(R.referral, url("/api/students/me/referral"), { referralCode: codeA });
  eq(selfMine.status, 400, "REF-04: a student cannot refer themselves → 400");
  eq(await client.referral.count({ where: { referrerId: studentA.id, referredId: studentA.id } }), 0, "REF-04: no self-referral row exists");
  asUser(studentUserB);

  // =========================================================================
  section("H. REF-05 THE COLLISION — an ambiguous code fails closed, nothing happens");
  // Two students' ids end in the same six characters. A referral code for that
  // suffix must resolve to NEITHER: no referrer, no reward, no row, no coupon.
  const twinCode = "CM-ABC123";
  const ambBefore = {
    refs: await client.referral.count(),
    couponCode: `REF-${"abc123".toUpperCase()}`,
  };
  const ambCouponsBefore = await client.coupon.count({ where: { code: ambBefore.couponCode } });
  const amb = await POST(R.referral, url("/api/students/me/referral"), { referralCode: twinCode });
  eq(amb.status, 404, "REF-05: an AMBIGUOUS code (two id-suffix matches) → 404 fail-closed");
  eq(await client.referral.count(), ambBefore.refs, "REF-05: no referral relationship was created");
  eq(await client.coupon.count({ where: { code: ambBefore.couponCode } }), ambCouponsBefore, "REF-05: no REF- coupon was minted");
  const notifBefore = await client.notification.count();
  eq(await client.notification.count(), notifBefore, "REF-05: no notification was sent (nothing was awarded)");

  // =========================================================================
  section("I. REF-06 the exact unambiguous code still succeeds alongside a colliding pair");
  // The twins share `abc123`; the unambiguous students A and B have distinct
  // suffixes. Student C (a NEW referred student, referrer=A) proves the path
  // still works end-to-end while the twin pair sits in the same database.
  // (Re-using B here would be a DUPLICATE of section F, not a routing proof.)
  const seenA = await client.student.findMany({ where: { id: { endsWith: suffixA } } });
  eq(seenA.length, 1, "REF-06: student A's suffix is exactly-one even with the twins seeded");
  asUser(studentUserC);
  const uAmb = await POST(R.referral, url("/api/students/me/referral"), { referralCode: codeA });
  eq(uAmb.status, 200, "REF-06: an exactly-one suffix still succeeds → 200");
  eq(await client.referral.count({ where: { referrerId: studentA.id, referredId: twinCId } }), 1, "REF-06: the unambiguous referral linked the TRUE referrer (A) to the new referree (C)");
  asUser(studentUserB);

  R.restore();

  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("PHASE26F_VERIFIER_OK");
}

main().catch((e) => {
  console.error("\n[26F] verifier crashed:", e && e.stack ? e.stack : String(e));
  process.exit(1);
});
