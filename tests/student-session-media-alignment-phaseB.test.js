// CodeMind Academy — Student media alignment (Phase B of the academic session
// workflow).
//
// Phase A made the Lesson the canonical academic Session for video LINKING
// (every new SessionVideo carries a validated lessonId). Phase B aligns the
// STUDENT experience with that relationship:
//
//   * the Lesson page is the canonical academic destination and its video
//     section loads the student's ELIGIBLE SessionVideo rows for the lesson
//     (one player, ordered playlist when several, legacy videoUrl fallback,
//     proper empty state);
//   * `GET /api/students/me/session-videos?lessonId=` — the one authorized
//     student video list — is now gated by the SAME lesson authorization the
//     lesson page uses (`canAccessLesson`: enrollment + course + PUBLISHED
//     lifecycle + non-archived + track + progression unlock). A media path
//     must never be a bypass: a lesson the student cannot open yields NO
//     videos for it, as an EMPTY list (no oracle).
//   * the course tree's "video available" indicator recognizes MODERN
//     SessionVideo rows (batch + published + track), keeping the legacy
//     `Lesson.videoUrl` as a documented fallback;
//   * the standalone "Session Videos" library remains a secondary surface on
//     the same authorized endpoint, now identifying each recording's lesson.
//
// PINNED BEHAVIOR (A–M, per the Phase B brief):
//   A. canonical Lesson linkage (?lessonId= serves the linked videos)
//   B. correct student Batch filtering
//   C. SHARED + Arabic student  → the Arabic video
//   D. SHARED + Language student → the Language video
//   E. no cross-batch leakage
//   F. no cross-course leakage
//   G. multiple videos returned correctly (ordered, both served)
//   H. publication/access filtering (unpublished, DRAFT-lesson, archived)
//   I. modern SessionVideo works without Lesson.videoUrl
//   J. legacy fallback behavior intentionally retained
//   K. direct-ID authorization failure (heartbeats)
//   L. archived/locked/inaccessible Lesson behavior
//   M. no progression rules changed (95% gate, unlock chain, and the
//      deliberate non-integration of SessionVideoView into progression)
//
// What is REAL here: the compiled shipped route handlers, the SQLite database
// built from the real migration SQL, the progression engine, the enrollment /
// entitlement / track modules, the batch reconcile. What is SHIMMED: the
// Prisma engine (sqlite-prisma-lite over node:sqlite), auth (script-
// controlled user), next/server, next/headers.
//
// Run: node --test tests/student-session-media-alignment-phaseB.test.js

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
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phaseB-media-"));
process.env.MEDIA_STORAGE_PATH = MEDIA_DIR;
process.env.MEDIA_BACKEND = "local";
process.env.SECURITY_HASH_SECRET = "b".repeat(64);

// Empirical NO-NETWORK guard: any TCP connect attempt fails loudly.
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(`phase B test made a network connection attempt: ${JSON.stringify(args[0])}`);
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
const ids = (rows) => rows.map((r) => r.id);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ---------------------------------------------------------------------------
// Scratch database: base DDL + every real migration (same as the Phase A e2e).
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phaseB: " });
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
  "src/app/api/students/me/session-videos/route.ts",
  "src/app/api/students/me/session-videos/[id]/progress/route.ts",
  "src/app/api/courses/[slug]/route.ts",
  "src/app/api/lessons/[id]/route.ts",
  "src/app/api/lessons/[id]/progress/route.ts",
];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phaseB-compile-"));
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
  async _readAll() {
    const body = this._body;
    if (body === null || body === undefined) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === "string") return Buffer.from(body);
    if (typeof body.getReader === "function") {
      const reader = body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
      return Buffer.concat(chunks);
    }
    return Buffer.from(body);
  }
  async json() {
    if (this._json !== undefined) return this._json;
    return JSON.parse((await this._readAll()).toString("utf8"));
  }
  async arrayBuffer() {
    const b = await this._readAll();
    return b.buffer.slice(b.byteOffset, b.byteLength);
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
  videos: route("students/me/session-videos/route.js"),
  videoProgress: route("students/me/session-videos/[id]/progress/route.js"),
  course: route("courses/[slug]/route.js"),
  lesson: route("lessons/[id]/route.js"),
  lessonProgress: route("lessons/[id]/progress/route.js"),
};

// ---------------------------------------------------------------------------
// HTTP-lite driver (same shape as the Phase A e2e).
// ---------------------------------------------------------------------------
function jsonReq(url, body) {
  return {
    url,
    method: "GET",
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
  };
}
function asUser(u) {
  globalThis.__CM_USER__ = u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null;
}
async function call(handler, req, params) {
  const res = await handler(req, { params: Promise.resolve(params || {}) });
  const ct = res.headers?.get?.("content-type") || "";
  if (ct.includes("application/json")) {
    return { status: res.status, json: await res.json() };
  }
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}
const GET = (r, url, params) => call(r.GET, jsonReq(url), params);
const POST_JSON = (r, url, body, params) => call(r.POST, jsonReq(url, body), params);

// ---------------------------------------------------------------------------
test("Phase B: student session media alignment", async () => {
  // ===========================================================================
  // Seed — two courses, three batches (two course-bound, one pool), four
  // students, eight lesson-linked videos, one legacy videoUrl-only lesson.
  //
  // Course A chain (one part/unit, ordered):
  //   L1 (1-1, SHARED)   — modern videos in BOTH batches, no legacy videoUrl
  //   L4 (1-2, SHARED)   — LEGACY videoUrl only (no SessionVideo)
  //   L2 (1-3, SHARED)   — TWO Arabic-batch videos (multi-video case)
  //   L3 (1-4, ARABIC)   — Arabic-batch video only
  //   L5 (1-5, SHARED)   — has a QUIZ → incomplete → locks L6
  //   L6 (1-6, SHARED)   — locked for students; legacy videoUrl + video
  //   L_ARCH (1-7)       — PUBLISHED status but ARCHIVED
  //   L_DRAFT (1-8)      — DRAFT lifecycle
  // Course B: LB1 (9-1, SHARED) — video lives on the POOL Arabic batch.
  // ===========================================================================
  const course = await client.course.create({
    data: { slug: "phaseb-a", name: "Course A", nameAr: "كورس أ", description: "phase B" },
  });
  const courseB = await client.course.create({
    data: { slug: "phaseb-b", name: "Course B", nameAr: "كورس ب", description: "other course" },
  });
  const partA = await client.part.create({
    data: { courseId: course.id, title: "P1", titleAr: "P1", order: 1 },
  });
  const partB = await client.part.create({
    data: { courseId: courseB.id, title: "PB", titleAr: "PB", order: 1 },
  });
  const unitA = await client.unit.create({
    data: { partId: partA.id, title: "U1", titleAr: "U1", order: 1 },
  });
  const unitB = await client.unit.create({
    data: { partId: partB.id, title: "UB", titleAr: "UB", order: 1 },
  });

  const mkLesson = (over) =>
    client.lesson.create({
      data: {
        unitId: unitA.id,
        trackScope: "SHARED",
        status: "PUBLISHED",
        curriculumStatus: "OFFICIAL",
        isPublished: true,
        ...over,
      },
    });
  const L1 = await mkLesson({ order: 1, officialCode: "1-1", title: "First session", titleAr: "الحصة الأولى" });
  const L4 = await mkLesson({
    order: 2, officialCode: "1-2", title: "Legacy session", titleAr: "حصة قديمة",
    videoUrl: "https://www.youtube.com/watch?v=legacyPhaseB",
  });
  const L2 = await mkLesson({ order: 3, officialCode: "1-3", title: "Multi session", titleAr: "حصة متعددة" });
  const L3 = await mkLesson({ order: 4, officialCode: "1-4", title: "Arabic session", titleAr: "حصة عربية", trackScope: "ARABIC" });
  const L5 = await mkLesson({ order: 5, officialCode: "1-5", title: "Quiz session", titleAr: "حصة كوي즈" });
  const L6 = await mkLesson({
    order: 6, officialCode: "1-6", title: "Locked session", titleAr: "حصة مقفولة",
    videoUrl: "https://legacy.example.com/locked.mp4",
  });
  const L_ARCH = await mkLesson({ order: 7, officialCode: "1-7", title: "Archived", titleAr: "مؤرشفة", curriculumStatus: "ARCHIVED" });
  const L_DRAFT = await mkLesson({ order: 8, officialCode: "1-8", title: "Draft", titleAr: "مسودة", status: "DRAFT", isPublished: false });
  const LB1 = await client.lesson.create({
    data: {
      unitId: unitB.id, order: 1, officialCode: "9-1", title: "Other course session", titleAr: "حصة كورس تاني",
      trackScope: "SHARED", status: "PUBLISHED", curriculumStatus: "OFFICIAL", isPublished: true,
    },
  });

  const batchArA = await client.batch.create({
    data: { name: "Batch AR-A", nameAr: "دفعة عربي أ", schoolType: "ARABIC", courseId: course.id },
  });
  const batchLangA = await client.batch.create({
    data: { name: "Batch LANG-A", nameAr: "دفعة لغات أ", schoolType: "LANGUAGE", courseId: course.id },
  });
  const poolAr = await client.batch.create({
    data: { name: "Pool AR", nameAr: "قاعدة عربي", schoolType: "ARABIC", courseId: null },
  });

  const groupA = await client.group.create({
    data: { name: "Group A", courseId: course.id, isActive: true },
  });
  const groupB = await client.group.create({
    data: { name: "Group B", courseId: courseB.id, isActive: true },
  });

  const mkStudent = async (tag, { schoolType, groupId, batchId }) => {
    const u = await client.user.create({
      data: { email: `${tag}@phaseb.test`, password: "x", name: tag, role: "STUDENT" },
    });
    const s = await client.student.create({
      data: { userId: u.id, schoolType, groupId: groupId ?? null, batchId: batchId ?? null },
    });
    return { user: u, student: s };
  };
  // No Subscription rows → legacy grandfathered access (entitlement policy
  // unchanged by Phase B): an ACTIVE group bound to a course is enough.
  const sAr = await mkStudent("s-arabic", { schoolType: "ARABIC", groupId: groupA.id, batchId: batchArA.id });
  const sLang = await mkStudent("s-language", { schoolType: "LANGUAGE", groupId: groupA.id, batchId: batchLangA.id });
  const sB = await mkStudent("s-courseb", { schoolType: "ARABIC", groupId: groupB.id, batchId: poolAr.id });
  const sNone = await mkStudent("s-nogroup", { schoolType: "ARABIC" });

  const mkVideo = async (tag, { batchId, lessonId, published = true, at = null }) => {
    const asset = await client.mediaAsset.create({
      data: {
        kind: "VIDEO", storage: "EXTERNAL_URL",
        externalUrl: `https://cdn.example.com/${tag}.mp4`,
        mimeType: "video/mp4", isPrivate: true,
      },
    });
    return client.sessionVideo.create({
      data: {
        batchId, lessonId, mediaAssetId: asset.id,
        title: `Video ${tag}`, titleAr: `تسجيل ${tag}`,
        isPublished: published, publishedAt: published ? (at ?? new Date()) : null,
      },
    });
  };
  const D = (h) => new Date(Date.UTC(2026, 8, 1, h, 0, 0));
  const vSharedAr = await mkVideo("sharedAr", { batchId: batchArA.id, lessonId: L1.id, at: D(1) });
  const vSharedLang = await mkVideo("sharedLang", { batchId: batchLangA.id, lessonId: L1.id, at: D(1) });
  const vUnpub = await mkVideo("unpub", { batchId: batchArA.id, lessonId: L1.id, published: false });
  const v2a = await mkVideo("multi-a", { batchId: batchArA.id, lessonId: L2.id, at: D(2) });
  const v2b = await mkVideo("multi-b", { batchId: batchArA.id, lessonId: L2.id, at: D(3) });
  const vArOnly = await mkVideo("arabicOnly", { batchId: batchArA.id, lessonId: L3.id, at: D(4) });
  const vLocked = await mkVideo("locked", { batchId: batchArA.id, lessonId: L6.id, at: D(5) });
  const vArch = await mkVideo("archived", { batchId: batchArA.id, lessonId: L_ARCH.id, at: D(6) });
  const vDraft = await mkVideo("draft", { batchId: batchArA.id, lessonId: L_DRAFT.id });
  const vCross = await mkVideo("crossCourse", { batchId: poolAr.id, lessonId: LB1.id, at: D(7) });

  // L5 carries a quiz → it stays incomplete (no attempt) → L6 is LOCKED.
  await client.quiz.create({
    data: { lessonId: L5.id, title: "L5 quiz", titleAr: "كوييز 1-5", trackScope: "SHARED" },
  });

  // ===========================================================================
  // M1 (run FIRST, before any video-progress seeding): the legacy 95% gate is
  // still enforced by the lesson progress route. L4 has a videoUrl and the
  // student has no video watch credit yet, so marking it complete is refused.
  // ===========================================================================
  asUser(sAr.user);
  const m1 = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${L4.id}/progress`, { completed: true }, { id: L4.id });
  eq(m1.status, 403, "M1: 95% video gate still refuses completion without watch credit");

  // Seed the legacy watch credit (simulates a fully watched legacy video) so
  // L4 is complete and the rest of the chain unlocks — for BOTH course-A
  // students, so their later denials cannot be explained away by a lock.
  for (const s of [sAr.student, sLang.student]) {
    await client.lessonProgress.create({
      data: {
        studentId: s.id, lessonId: L4.id,
        progress: 100, isCompleted: true,
        videoDurationSec: 100, videoWatchedSec: 100,
        videoPercent: 100, videoCompleted: true,
      },
    });
  }

  // ===========================================================================
  // A. Canonical Lesson linkage — ?lessonId= serves the linked videos, with
  //    the human-readable lesson identity, and ONLY those videos.
  // ===========================================================================
  asUser(sAr.user);
  const a1 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L1.id}`);
  eq(a1.status, 200, "A1: authorized list 200");
  eq(ids(a1.json.videos), [vSharedAr.id], "A1: L1 serves exactly its linked Arabic video");
  eq(a1.json.videos[0].lesson?.officialCode, "1-1", "A1: payload carries the lesson's human code");
  eq(a1.json.videos[0].lesson?.titleAr, L1.titleAr, "A1: payload carries the lesson title");
  eq(a1.json.videos[0].src, "https://cdn.example.com/sharedAr.mp4", "A1: external src is the stored URL");
  // A video linked to ANOTHER lesson must never leak into this lesson's list.
  ok(!ids(a1.json.videos).includes(v2a.id), "A2: a different lesson's video is not in L1's list");

  // ===========================================================================
  // B. Batch filtering — the standalone library serves the student's OWN
  //    batch's published videos only.
  // ===========================================================================
  const b1 = await GET(R.videos, "http://t/api/students/me/session-videos");
  const bArIds = ids(b1.json.videos);
  eq(
    bArIds,
    [vArch.id, vLocked.id, vArOnly.id, v2b.id, v2a.id, vSharedAr.id],
    "B1: Arabic student's library = own batch's published linked videos (publishedAt desc)"
  );
  ok(!bArIds.includes(vUnpub.id), "B2: unpublished video absent");
  ok(!bArIds.includes(vDraft.id), "B3: DRAFT-lesson video absent (lesson must be PUBLISHED)");
  ok(!bArIds.includes(vSharedLang.id), "B4: Language-batch video absent");
  ok(!bArIds.includes(vCross.id), "B5: pool-batch (other course) video absent");

  asUser(sLang.user);
  const b2 = await GET(R.videos, "http://t/api/students/me/session-videos");
  eq(ids(b2.json.videos), [vSharedLang.id], "B6: Language student's library = own batch only");

  // ===========================================================================
  // C. SHARED lesson + Arabic student → the Arabic video.
  // D. SHARED lesson + Language student → the Language video.
  // E. No cross-batch leakage (direct lesson query too).
  // ===========================================================================
  eq(ids(b2.json.videos), [vSharedLang.id], "D1: SHARED lesson → Language student gets the Language video");
  asUser(sAr.user);
  const c1 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L1.id}`);
  eq(ids(c1.json.videos), [vSharedAr.id], "C1: SHARED lesson → Arabic student gets ONLY the Arabic video");
  ok(!ids(c1.json.videos).includes(vSharedLang.id), "E1: no cross-batch leak through ?lessonId=");
  // L3 is an ARABIC lesson with an Arabic-batch video: the Language student's
  // lesson gate refuses it (track), so the media path cannot leak it.
  asUser(sLang.user);
  const e2 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L3.id}`);
  eq(e2.status, 200, "E2: track-refused lesson answers 200 (no oracle)");
  eq(e2.json.videos, [], "E2: track-refused lesson yields NO videos");

  // ===========================================================================
  // F. No cross-course leakage — even when the video sits on a batch the
  //    student does NOT own, and vice versa.
  // ===========================================================================
  asUser(sAr.user);
  const f1 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${LB1.id}`);
  eq(f1.status, 200, "F1: foreign-course lesson answers 200 (no oracle)");
  eq(f1.json.videos, [], "F1: another course's lesson yields NO videos");
  asUser(sB.user);
  const f2 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${LB1.id}`);
  eq(ids(f2.json.videos), [vCross.id], "F2: course-B student gets the pool-batch video of their own course");
  const f3 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L1.id}`);
  eq(f3.json.videos, [], "F3: course-B student gets NO course-A lesson videos");

  // ===========================================================================
  // G. Multiple videos — both returned, ordered (publishedAt desc), first is
  //    the default selection on the client.
  // ===========================================================================
  asUser(sAr.user);
  const g1 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L2.id}`);
  eq(ids(g1.json.videos), [v2b.id, v2a.id], "G1: both videos of the lesson returned, ordered");
  eq(g1.json.videos.map((v) => v.title), ["Video multi-b", "Video multi-a"], "G2: human titles, no raw ids in labels");

  // ===========================================================================
  // H. Publication / access filtering on the narrowed list.
  // ===========================================================================
  ok(!ids(c1.json.videos).includes(vUnpub.id), "H1: unpublished video never served");
  const h2 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L_DRAFT.id}`);
  eq(h2.json.videos, [], "H2: DRAFT lesson yields no videos");

  // ===========================================================================
  // I. Modern SessionVideo works with Lesson.videoUrl = null.
  // ===========================================================================
  eq(L1.videoUrl, null, "I0: L1 genuinely has no legacy videoUrl");
  eq(ids(c1.json.videos), [vSharedAr.id], "I1: the modern video is served without any legacy column");

  // ===========================================================================
  // J. Legacy fallback intentionally retained — a lesson whose ONLY media is
  //    Lesson.videoUrl: no SessionVideo rows (empty list), but the lesson
  //    route still serialises the legacy URL and the tree still badges it.
  // ===========================================================================
  const j1 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L4.id}`);
  eq(j1.json.videos, [], "J1: legacy-only lesson has no SessionVideo rows");
  const j2 = await GET(R.lesson, `http://t/api/lessons/${L4.id}`, { id: L4.id });
  eq(j2.status, 200, "J2: legacy-only lesson opens");
  eq(j2.json.lesson.videoUrl, "https://www.youtube.com/watch?v=legacyPhaseB", "J2: legacy videoUrl still serialised (fallback)");
  ok(Array.isArray(j2.json.quizzes), "J2: lesson payload shape intact");

  // ===========================================================================
  // K. Direct-ID authorization failure at the heartbeat boundary.
  // ===========================================================================
  asUser(sLang.user);
  const k1 = await POST_JSON(
    R.videoProgress, `http://t/api/students/me/session-videos/${vSharedAr.id}/progress`,
    { positionSec: 10, durationSec: 100 }, { id: vSharedAr.id }
  );
  eq(k1.status, 403, "K1: heartbeat on another batch's video → 403");
  asUser(sB.user);
  const k2 = await POST_JSON(
    R.videoProgress, `http://t/api/students/me/session-videos/${vSharedAr.id}/progress`,
    { positionSec: 10, durationSec: 100 }, { id: vSharedAr.id }
  );
  eq(k2.status, 403, "K2: heartbeat on a foreign course's audience video → 403");
  asUser(sAr.user);
  const k3 = await POST_JSON(
    R.videoProgress, `http://t/api/students/me/session-videos/${vUnpub.id}/progress`,
    { positionSec: 10, durationSec: 100 }, { id: vUnpub.id }
  );
  eq(k3.status, 404, "K3: heartbeat on an unpublished video → 404 (no oracle)");
  const k4 = await POST_JSON(
    R.videoProgress, `http://t/api/students/me/session-videos/${vSharedAr.id}/progress`,
    { positionSec: 30, durationSec: 100 }, { id: vSharedAr.id }
  );
  eq(k4.status, 200, "K4: the authorized heartbeat succeeds");
  ok(typeof k4.json.percent === "number", "K4: heartbeat returns server-computed percent");

  // ===========================================================================
  // L. Archived / locked / inaccessible lessons — the media path is never a
  //    bypass, and the answer is an empty list (no oracle).
  // ===========================================================================
  const l1 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L_ARCH.id}`);
  eq(l1.json.videos, [], "L1: archived lesson yields no videos");
  const l2 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L6.id}`);
  eq(l2.json.videos, [], "L2: LOCKED lesson yields no videos (progression gate)");
  asUser(sAr.user);
  const l3 = await GET(R.lesson, `http://t/api/lessons/${L6.id}`, { id: L6.id });
  eq(l3.status, 403, "L3: locked lesson refuses to open");
  eq(l3.json.code, "PREVIOUS_SESSION_INCOMPLETE", "L3: refusal carries the progression code");
  const l4 = await GET(R.lesson, `http://t/api/lessons/${L_ARCH.id}`, { id: L_ARCH.id });
  eq(l4.status, 404, "L4: archived lesson answers as nonexistent");
  const l5 = await GET(R.lesson, `http://t/api/lessons/${L_DRAFT.id}`, { id: L_DRAFT.id });
  eq(l5.status, 404, "L5: DRAFT lesson answers as nonexistent");
  asUser(sAr.user);
  const l6 = await GET(R.lesson, `http://t/api/lessons/${LB1.id}`, { id: LB1.id });
  // Pre-existing documented behaviour: a student who IS enrolled (elsewhere)
  // gets the explicit NOT_ENROLLED denial; only unknown ids 404.
  eq(l6.status, 403, "L6: another course's lesson is refused");
  eq(l6.json.code, "NOT_ENROLLED", "L6: refusal carries the NOT_ENROLLED code");

  // ===========================================================================
  // M2. Progression is READ for rendering but NOT redefined: a fully watched
  //     batch video (SessionVideoView 100%) must NOT create a video
  //     requirement and must NOT block completion of a modern lesson — the
  //     SessionVideoView → progression integration is deliberately deferred.
  // ===========================================================================
  // (upsert: K4's authorized heartbeat already created this pair's row)
  await client.sessionVideoView.upsert({
    where: {
      sessionVideoId_studentId: {
        sessionVideoId: vSharedAr.id, studentId: sAr.student.id,
      },
    },
    create: {
      sessionVideoId: vSharedAr.id, studentId: sAr.student.id,
      watchedSec: 100, durationSec: 100, percent: 100,
      isCompleted: true, completedAt: new Date(),
    },
    update: {
      watchedSec: 100, durationSec: 100, percent: 100,
      isCompleted: true, completedAt: new Date(),
    },
  });
  const m2 = await GET(R.lesson, `http://t/api/lessons/${L1.id}`, { id: L1.id });
  eq(m2.status, 200, "M2: modern lesson opens");
  eq(m2.json.requirements?.video?.required, false, "M2: a modern video creates NO progression video requirement");
  const m3 = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${L1.id}/progress`, { completed: true }, { id: L1.id });
  eq(m3.status, 200, "M2: completion of a modern lesson is not blocked by the video world");
  // Source pins: the progression engine and the 95% gate are UNCHANGED.
  const engine = read("src/lib/session-progress.ts");
  ok(/const hasVideo = !!lesson\.videoUrl;/.test(engine), "M3: the engine still derives the video requirement from Lesson.videoUrl only");
  const progressRoute = read("src/app/api/lessons/[id]/progress/route.ts");
  ok(/!lesson\.videoUrl \|\|/.test(progressRoute), "M3: the 95% completion gate expression is unchanged");
  const progressLib = read("src/lib/progress.ts");
  ok(/videoUrl: \{ not: null \}/.test(progressLib), "M3: the legacy video-progress summary filter is unchanged");

  // ===========================================================================
  // N. Course tree — the video indicator recognises modern SessionVideo rows
  //    (batch + published + track) and keeps the legacy fallback; lock
  //    redaction is untouched.
  // ===========================================================================
  asUser(sAr.user);
  const n1 = await GET(R.course, `http://t/api/courses/${course.slug}`, { slug: course.slug });
  eq(n1.status, 200, "N0: course tree 200");
  const treeLessons = {};
  for (const p of n1.json.parts)
    for (const u of p.units)
      for (const l of u.lessons) treeLessons[l.id] = l;
  eq(treeLessons[L1.id]?.hasVideo, true, "N1: modern-video lesson is badged (videoUrl is null)");
  eq(treeLessons[L1.id]?.videoUrl, null, "N1: ...while exposing no URL");
  eq(treeLessons[L4.id]?.hasVideo, true, "N2: legacy-only lesson keeps its badge (documented fallback)");
  eq(treeLessons[L4.id]?.videoUrl, "https://www.youtube.com/watch?v=legacyPhaseB", "N2: unlocked legacy URL still serialised");
  eq(treeLessons[L5.id]?.hasVideo, false, "N3: video-less lesson is not badged");
  eq(treeLessons[L6.id]?.status, "locked", "N4: L6 is locked (progression unchanged)");
  eq(treeLessons[L6.id]?.hasVideo, true, "N4: locked lesson still shows its skeleton video badge (lock-independent)");
  eq(treeLessons[L6.id]?.videoUrl, null, "N4: locked lesson's media URL stays redacted");
  eq(treeLessons[L3.id]?.hasVideo, true, "N5: Arabic student sees the Arabic-only lesson's video badge");
  // The Language student's tree: L1 badged from HER batch's video; the
  // ARABIC lesson L3 is not in her universe at all.
  asUser(sLang.user);
  const n2 = await GET(R.course, `http://t/api/courses/${course.slug}`, { slug: course.slug });
  const treeLang = {};
  for (const p of n2.json.parts)
    for (const u of p.units)
      for (const l of u.lessons) treeLang[l.id] = l;
  eq(treeLang[L1.id]?.hasVideo, true, "N6: Language student's tree badges L1 from her own batch");
  eq(treeLang[L3.id], undefined, "N6: the ARABIC lesson is absent from the Language tree");

  // ===========================================================================
  // O. Refresh persistence — the authorized list is stable across reloads
  //    (the client re-derives the same default selection).
  // ===========================================================================
  asUser(sAr.user);
  const o1 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L2.id}`);
  const o2 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L2.id}`);
  eq(ids(o2.json.videos), ids(o1.json.videos), "O1: reload returns the same eligible set (same order)");
  eq(o2.json.videos[0].progress.percent, o1.json.videos[0].progress.percent, "O1: per-video watch state is server-persisted");

  // ===========================================================================
  // P. Not enrolled / not authorized — the list answers an explicit
  //    not-enrolled shape with zero videos.
  // ===========================================================================
  asUser(sNone.user);
  const p1 = await GET(R.videos, "http://t/api/students/me/session-videos");
  eq(p1.status, 200, "P1: ungrouped student answers 200");
  eq(p1.json.isEnrolled, false, "P1: flagged as not enrolled");
  eq(p1.json.videos, [], "P1: zero videos");

  // ===========================================================================
  // Q. Phase A regression pins (source): the admin creation contract —
  //    Lesson REQUIRED, one shared validator — is intact.
  // ===========================================================================
  const adminVideos = read("src/app/api/admin/session-videos/route.ts");
  ok(/validateSessionVideoLink/.test(adminVideos), "Q1: admin creation still runs the Phase A validator");
  ok(/LESSON_REQUIRED/.test(read("src/lib/session-video-link.ts")), "Q2: the LESSON_REQUIRED contract still exists");
  const adminVideoById = read("src/app/api/admin/session-videos/[id]/route.ts");
  ok(/validateSessionVideoLink/.test(adminVideoById), "Q3: admin re-link still runs the Phase A validator");

  // ===========================================================================
  // R. Phase B gate wiring pins (source): the narrowed list runs the SAME
  //    lesson gate and keeps every pre-existing clause.
  // ===========================================================================
  const videosRoute = read("src/app/api/students/me/session-videos/route.ts");
  ok(/canAccessLesson\(student\.id, lessonId\)/.test(videosRoute), "R1: ?lessonId= runs canAccessLesson");
  ok(/\.\.\.\(lessonId \? \{ lessonId \} : \{\}\)/.test(videosRoute), "R2: the narrowing filter is preserved");
  ok(/isPublished: true,/.test(videosRoute), "R3: the publication gate is preserved");
  ok(/\.\.\.videoTrackFilter\(enrollment\.schoolType\)/.test(videosRoute), "R4: the track gate is preserved");
  ok(/\{ lesson: LESSON_STUDENT_STATUS_FILTER \}/.test(videosRoute), "R5: linked lessons must be PUBLISHED");
  const courseRoute = read("src/app/api/courses/[slug]/route.ts");
  ok(/hasVideo: !!lesson\.videoUrl \|\| videoLessonIds\.has\(lesson\.id\),/.test(courseRoute), "R6: tree badge = legacy OR modern");
  ok(!/hasVideo: locked/.test(courseRoute), "R6: the badge is never lock-gated");
  const lessonView = read("src/components/course/student-lesson.tsx");
  ok(/session-videos\?lessonId=\$\{encodeURIComponent\(lessonId\)\}/.test(lessonView), "R7: the lesson page loads through the narrowed authorized list");
  ok(/setActiveId\(v\.id\)/.test(lessonView), "R7: playlist selection swaps the main player in place");
  ok(/course\.228/.test(lessonView), "R7: the empty state is localised");
  ok(/import \{ SessionVideoPlayer \} from "@\/components\/course\/session-videos-view"/.test(lessonView), "R7: ONE shared student player");
  const videosView = read("src/components/course/session-videos-view.tsx");
  ok(/export function SessionVideoPlayer/.test(videosView), "R8: the shared player is exported from the library view");
  ok(/v\.lesson\.officialCode/.test(videosView), "R8: the library identifies each recording's lesson");

  console.log(`\nPhase B suite: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const f of failures) console.error(" -", f);
    assert.fail(`${fail} Phase B assertions failed`);
  }
});
