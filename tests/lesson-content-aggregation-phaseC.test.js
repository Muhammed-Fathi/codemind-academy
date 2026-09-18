// CodeMind Academy — Lesson Content Aggregation (Phase C).
//
// Phase C makes the Lesson the ONE coherent academic workspace and gives the
// student curriculum a single content-summary authority:
// `src/lib/lesson-content.ts`. Before Phase C every surface answered
// "does this lesson have X?" with its own query: the course tree counted
// quizzes/homeworks WITHOUT the viewer's track filter (a SHARED lesson with
// only a LANGUAGE quiz showed a "Quiz" badge to an ARABIC student while the
// lesson page said "no quiz"), the dashboard exposed only the legacy
// `Lesson.videoUrl`, and the tree carried its own private SessionVideo query.
//
// PINNED BEHAVIOR (A–U, per the Phase C brief):
//   A. modern SessionVideo only → video AVAILABLE even when videoUrl is null
//   B. legacy videoUrl only → the documented compatibility fallback holds
//   C. SHARED lesson, Arabic student → the Language-only SessionVideo is
//      neither exposed nor counted
//   D. SHARED lesson, Language student → the Arabic-only SessionVideo is
//      neither exposed nor counted
//   E. multiple eligible SessionVideos → AVAILABLE, count reflects them all
//   F. material exists → material AVAILABLE
//   G. inactive / other-track / asset-less materials are NOT exposed
//   H. quiz exists → quiz AVAILABLE
//   I. no quiz → ABSENT, never LOCKED
//   J. homework exists → homework AVAILABLE
//   K. no homework → ABSENT, never LOCKED
//   L. full lesson (video + PDF + quiz + homework) → one coherent summary
//   M. empty lesson → every component ABSENT without a crash
//   N. locked lesson → aggregation does NOT bypass the lesson access policy
//   O. cross-course → no leakage
//   P. cross-track → no leakage
//   Q. archived / DRAFT lessons → no student content leakage
//   R. course tree + lesson page + dashboard use the SAME authority
//   S. Continue Learning carries the consistent content summary
//   T. no progression rules changed (engine source pins + behavioral lock)
//   U. no readiness rules changed (lifecycle module untouched)
//
// What is REAL here: the compiled shipped route handlers AND the shipped
// authority module, the SQLite database built from the real migration SQL,
// the progression engine, the enrollment / entitlement / track modules. What
// is SHIMMED: the Prisma engine (sqlite-prisma-lite over node:sqlite), auth
// (script-controlled user), next/server, next/headers.
//
// Run: node --test tests/lesson-content-aggregation-phaseC.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert");

const REPO = path.resolve(__dirname, "..");

process.env.SECURITY_HASH_SECRET = "c".repeat(64);

// Empirical NO-NETWORK guard: any TCP connect attempt fails loudly.
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(`phase C test made a network connection attempt: ${JSON.stringify(args[0])}`);
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
// Scratch database: base DDL + every real migration (same as the Phase A/B e2e).
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phaseC: " });
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
  // the Phase C authority under test
  "src/lib/lesson-content.ts",
  // route handlers under test
  "src/app/api/courses/[slug]/route.ts",
  "src/app/api/lessons/[id]/route.ts",
  "src/app/api/students/me/dashboard/route.ts",
  "src/app/api/students/me/session-videos/route.ts",
];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phaseC-compile-"));
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
} catch (e) {
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
    return Buffer.from(body);
  }
  async json() {
    if (this._json !== undefined) return this._json;
    return JSON.parse((await this._readAll()).toString("utf8"));
  }
  async arrayBuffer() {
    const b = await this._readAll();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
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
const authority = require(path.join(EMIT, "lib/lesson-content.js"));
const R = {
  course: route("courses/[slug]/route.js"),
  lesson: route("lessons/[id]/route.js"),
  dashboard: route("students/me/dashboard/route.js"),
  videos: route("students/me/session-videos/route.js"),
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

// The DICT_2026 keys Phase C added (approved empty-state copy + titles).
test("Phase C: lesson content aggregation", async () => {
  // ===========================================================================
  // Seed — one course, two school-type batches, an Arabic and a Language
  // student, and a lesson grid covering every behavior below:
  //
  //   L_FULL   1-1 SHARED — video(Arabic batch) + LANGUAGE video + material
  //            (SHARED) + ARABIC material + LANGUAGE material + quiz(SHARED)
  //            + ARABIC quiz + homework(SHARED) + LANGUAGE homework
  //   L_MODERN 1-2 SHARED — modern Arabic-batch video ONLY (videoUrl NULL)
  //   L_LEGACY 1-3 SHARED — LEGACY videoUrl ONLY (no SessionVideo, no PDF)
  //   L_MULTI  1-4 SHARED — TWO Arabic-batch videos (multi-video case)
  //   L_MAT    1-5 SHARED — material(SHARED) only
  //   L_HW     1-6 SHARED — homework(SHARED) only
  //   L_EMPTY  1-7 SHARED — NOTHING attached
  //   L_ARABIC 1-8 ARABIC — Arabic-batch video only (track-specific lesson)
  //   L_LANG   1-9 LANGUAGE — Language-batch video only
  //   L_QUIZ   1-10 SHARED — quiz(SHARED) only → stays incomplete → locks L_LOCK
  //   L_LOCK   1-11 SHARED — video + quiz; LOCKED behind L_QUIZ for students
  //   L_ARCH   — SHARED but ARCHIVED (video attached; outside the chain)
  //   L_DRAFT  — SHARED but DRAFT (video attached; outside the chain)
  //   Course B: LB1 — its own lesson (cross-course probe target)
  //
  // The gate quiz sits LATE in the chain so every earlier lesson is reachable
  // (auto-completed or seeded), and L_LOCK is the ONLY lesson locked behind
  // it — exactly the Phase N scenario.
  // ===========================================================================
  const course = await client.course.create({
    data: { slug: "phasec-a", name: "Course A", nameAr: "كورس أ", description: "phase C" },
  });
  const courseB = await client.course.create({
    data: { slug: "phasec-b", name: "Course B", nameAr: "كورس ب", description: "other course" },
  });
  const partA = await client.part.create({
    data: { courseId: course.id, title: "P1", titleAr: "الجزء الأول", order: 1 },
  });
  const partB = await client.part.create({
    data: { courseId: courseB.id, title: "PB", titleAr: "الجزء ب", order: 1 },
  });
  const unitA = await client.unit.create({
    data: { partId: partA.id, title: "U1", titleAr: "الوحدة الأولى", order: 1 },
  });
  const unitB = await client.unit.create({
    data: { partId: partB.id, title: "UB", titleAr: "الوحدة ب", order: 1 },
  });

  const mkLesson = (over) =>
    client.lesson.create({
      data: {
        unitId: unitA.id,
        trackScope: "SHARED",
        status: "PUBLISHED",
        curriculumStatus: "OFFICIAL",
        isPublished: true,
        duration: 90,
        ...over,
      },
    });

  let order = 0;
  const nextOrder = () => ++order;
  const L_FULL = await mkLesson({ order: nextOrder(), officialCode: "1-1", title: "Full session", titleAr: "حصة كاملة" });
  const L_MODERN = await mkLesson({ order: nextOrder(), officialCode: "1-2", title: "Modern video", titleAr: "فيديو حديث" });
  const L_LEGACY = await mkLesson({
    order: nextOrder(), officialCode: "1-3", title: "Legacy session", titleAr: "حصة قديمة",
    videoUrl: "https://www.youtube.com/watch?v=phaseClegacy",
  });
  const L_MULTI = await mkLesson({ order: nextOrder(), officialCode: "1-4", title: "Multi video", titleAr: "فيديوهان" });
  const L_MAT = await mkLesson({ order: nextOrder(), officialCode: "1-5", title: "Material session", titleAr: "حصة ملفات" });
  const L_HW = await mkLesson({ order: nextOrder(), officialCode: "1-6", title: "Homework session", titleAr: "حصة واجب" });
  const L_EMPTY = await mkLesson({ order: nextOrder(), officialCode: "1-7", title: "Empty session", titleAr: "حصة فارغة" });
  const L_ARABIC = await mkLesson({ order: nextOrder(), officialCode: "1-8", title: "Arabic session", titleAr: "حصة عربية", trackScope: "ARABIC" });
  const L_LANG = await mkLesson({ order: nextOrder(), officialCode: "1-9", title: "Language session", titleAr: "حصة لغات", trackScope: "LANGUAGE" });
  const L_QUIZ = await mkLesson({ order: nextOrder(), officialCode: "1-10", title: "Quiz session", titleAr: "حصة اختبار" });
  const L_LOCK = await mkLesson({ order: nextOrder(), officialCode: "1-11", title: "Locked session", titleAr: "حصة مقفولة" });
  const L_ARCH = await mkLesson({
    order: nextOrder(), officialCode: "1-12", title: "Archived", titleAr: "مؤرشفة",
    curriculumStatus: "ARCHIVED", videoUrl: "https://legacy.example.com/arch.mp4",
  });
  const L_DRAFT = await mkLesson({
    order: nextOrder(), officialCode: "1-13", title: "Draft", titleAr: "مسودة",
    status: "DRAFT", isPublished: false, videoUrl: "https://legacy.example.com/draft.mp4",
  });
  const LB1 = await client.lesson.create({
    data: {
      unitId: unitB.id, order: 1, officialCode: "9-1", title: "Other course session", titleAr: "حصة كورس تاني",
      trackScope: "SHARED", status: "PUBLISHED", curriculumStatus: "OFFICIAL", isPublished: true,
    },
  });

  const batchAr = await client.batch.create({
    data: { name: "Batch AR", nameAr: "دفعة عربي", schoolType: "ARABIC", courseId: course.id },
  });
  const batchLang = await client.batch.create({
    data: { name: "Batch LANG", nameAr: "دفعة لغات", schoolType: "LANGUAGE", courseId: course.id },
  });

  const groupA = await client.group.create({
    data: { name: "Group A", courseId: course.id, isActive: true },
  });
  const groupB = await client.group.create({
    data: { name: "Group B", courseId: courseB.id, isActive: true },
  });

  const mkStudent = async (tag, { schoolType, groupId, batchId }) => {
    const u = await client.user.create({
      data: { email: `${tag}@phasec.test`, password: "x", name: tag, role: "STUDENT" },
    });
    const s = await client.student.create({
      data: { userId: u.id, schoolType, groupId: groupId ?? null, batchId: batchId ?? null },
    });
    return { user: u, student: s };
  };
  // No Subscription rows → grandfathered access (ACTIVE group is enough), the
  // entitlement policy untouched by Phase C.
  const sAr = await mkStudent("s-arabic", { schoolType: "ARABIC", groupId: groupA.id, batchId: batchAr.id });
  const sLang = await mkStudent("s-language", { schoolType: "LANGUAGE", groupId: groupA.id, batchId: batchLang.id });
  const sB = await mkStudent("s-courseb", { schoolType: "ARABIC", groupId: groupB.id, batchId: batchAr.id });

  const mkVideo = async (tag, { batchId, lessonId, published = true }) => {
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
        isPublished: published, publishedAt: published ? new Date() : null,
      },
    });
  };

  // L_FULL: audience-split videos + materials + quiz + homework (SHARED lesson).
  const vFullAr = await mkVideo("fullAr", { batchId: batchAr.id, lessonId: L_FULL.id });
  const vFullLang = await mkVideo("fullLang", { batchId: batchLang.id, lessonId: L_FULL.id });
  await mkVideo("fullArUnpub", { batchId: batchAr.id, lessonId: L_FULL.id, published: false });
  const matFullShared = await client.material.create({
    data: {
      lessonId: L_FULL.id, kind: "ADMIN_UPLOADED", title: "Shared PDF",
      trackScope: "SHARED", isActive: true, storageKey: null,
    },
  });
  // Give the shared material a real asset so the descriptor authority counts it.
  const matAsset = await client.mediaAsset.create({
    data: { kind: "DOCUMENT", storage: "LOCAL_PRIVATE", storageKey: "phasec/full-shared.pdf", mimeType: "application/pdf", sizeBytes: 10, isPrivate: true },
  });
  await client.material.update({ where: { id: matFullShared.id }, data: { mediaAssetId: matAsset.id } });
  // ARABIC material WITHOUT an asset → exists but not downloadable → the
  // descriptor authority skips it (never a broken control) — pinned in G.
  await client.material.create({
    data: { lessonId: L_FULL.id, kind: "ADMIN_UPLOADED", title: "Arabic PDF", trackScope: "ARABIC", isActive: true },
  });
  // LANGUAGE material, active with asset → invisible to the Arabic student.
  const matLang = await client.material.create({
    data: { lessonId: L_FULL.id, kind: "ADMIN_UPLOADED", title: "Lang PDF", trackScope: "LANGUAGE", isActive: true },
  });
  const matLangAsset = await client.mediaAsset.create({
    data: { kind: "DOCUMENT", storage: "LOCAL_PRIVATE", storageKey: "phasec/full-lang.pdf", mimeType: "application/pdf", sizeBytes: 10, isPrivate: true },
  });
  await client.material.update({ where: { id: matLang.id }, data: { mediaAssetId: matLangAsset.id } });
  const quizFullShared = await client.quiz.create({
    data: { lessonId: L_FULL.id, title: "Full shared quiz", titleAr: "اختبار مشترك", trackScope: "SHARED" },
  });
  const quizFullArabic = await client.quiz.create({
    data: { lessonId: L_FULL.id, title: "Full arabic quiz", titleAr: "اختبار عربي", trackScope: "ARABIC" },
  });
  const hwFullShared = await client.homework.create({
    data: {
      lessonId: L_FULL.id, title: "Full shared homework", titleAr: "واجب مشترك",
      trackScope: "SHARED", deadline: new Date(Date.UTC(2026, 11, 1)),
    },
  });
  const hwFullLang = await client.homework.create({
    data: {
      lessonId: L_FULL.id, title: "Full language homework", titleAr: "واجب لغات",
      trackScope: "LANGUAGE", deadline: new Date(Date.UTC(2026, 11, 1)),
    },
  });

  // L_MODERN: modern Arabic-batch video only; videoUrl stays NULL.
  await mkVideo("modern", { batchId: batchAr.id, lessonId: L_MODERN.id });
  // L_MULTI: two Arabic-batch videos.
  await mkVideo("multiA", { batchId: batchAr.id, lessonId: L_MULTI.id });
  await mkVideo("multiB", { batchId: batchAr.id, lessonId: L_MULTI.id });
  // L_ARABIC / L_LANG: audience-specific lessons with their own videos.
  await mkVideo("arabicOnly", { batchId: batchAr.id, lessonId: L_ARABIC.id });
  await mkVideo("langOnly", { batchId: batchLang.id, lessonId: L_LANG.id });
  // Locked / archived / draft lessons have videos attached (must stay hidden).
  await mkVideo("locked", { batchId: batchAr.id, lessonId: L_LOCK.id });
  await mkVideo("arch", { batchId: batchAr.id, lessonId: L_ARCH.id });
  await mkVideo("draft", { batchId: batchAr.id, lessonId: L_DRAFT.id });
  // Course B video (cross-course probe target).
  await mkVideo("crossCourse", { batchId: batchAr.id, lessonId: LB1.id });
  // Unpublished video on L_MAT (must not satisfy "has video").
  await mkVideo("matUnpub", { batchId: batchAr.id, lessonId: L_MAT.id, published: false });

  // L_MAT: SHARED material with asset (material-only lesson).
  const matOnly = await client.material.create({
    data: { lessonId: L_MAT.id, kind: "ADMIN_UPLOADED", title: "Only PDF", trackScope: "SHARED", isActive: true },
  });
  const matOnlyAsset = await client.mediaAsset.create({
    data: { kind: "DOCUMENT", storage: "LOCAL_PRIVATE", storageKey: "phasec/mat-only.pdf", mimeType: "application/pdf", sizeBytes: 10, isPrivate: true },
  });
  await client.material.update({ where: { id: matOnly.id }, data: { mediaAssetId: matOnlyAsset.id } });
  // …plus an INACTIVE twin that must never count.
  await client.material.create({
    data: { lessonId: L_MAT.id, kind: "ADMIN_UPLOADED", title: "Inactive PDF", trackScope: "SHARED", isActive: false },
  });

  // L_QUIZ carries the gate quiz → L_LOCK stays locked for both students.
  await client.quiz.create({
    data: { lessonId: L_QUIZ.id, title: "Gate quiz", titleAr: "اختبار البوابة", trackScope: "SHARED" },
  });
  // L_LOCK carries its own quiz + homework (visible only once unlocked).
  await client.quiz.create({
    data: { lessonId: L_LOCK.id, title: "Locked quiz", titleAr: "اختبار مقفول", trackScope: "SHARED" },
  });
  await client.homework.create({
    data: {
      lessonId: L_LOCK.id, title: "Locked homework", titleAr: "واجب مقفول",
      trackScope: "SHARED", deadline: new Date(Date.UTC(2026, 11, 1)),
    },
  });
  // L_HW: homework-only lesson.
  await client.homework.create({
    data: {
      lessonId: L_HW.id, title: "Only homework", titleAr: "واجب فقط",
      trackScope: "SHARED", deadline: new Date(Date.UTC(2026, 11, 1)),
    },
  });

  // ---------------------------------------------------------------------------
  // Progression seeds (Phase T — the engine semantics are untouched; these rows
  // merely SATISFY the existing requirements so the chain reaches the gate):
  //   * L_FULL for the Arabic student: BOTH its quizzes attempted and BOTH its
  //     homeworks submitted (the engine counts every quiz/homework of the
  //     lesson — a documented pre-Phase-C behaviour Phase C does not change);
  //   * L_LEGACY: the legacy 95% watch credit (a fully watched videoUrl).
  // L_QUIZ keeps its quiz UNATTEMPTED → L_LOCK stays locked (the N scenario).
  // ---------------------------------------------------------------------------
  for (const quizId of [quizFullShared.id, quizFullArabic.id]) {
    await client.quizAttempt.create({
      data: { quizId, studentId: sAr.student.id, finishedAt: new Date(), attemptNumber: 1 },
    });
  }
  for (const homeworkId of [hwFullShared.id, hwFullLang.id]) {
    await client.homeworkSubmission.create({
      data: { homeworkId, studentId: sAr.student.id, submittedAt: new Date() },
    });
  }
  await client.lessonProgress.create({
    data: {
      studentId: sAr.student.id, lessonId: L_LEGACY.id,
      progress: 100, isCompleted: true,
      videoDurationSec: 100, videoWatchedSec: 100,
      videoPercent: 100, videoCompleted: true,
    },
  });

  const treeLessons = {};
  const lessonContent = {};
  const flattenTree = (d) => {
    for (const p of d.parts) {
      for (const u of p.units) {
        for (const l of u.lessons) {
          treeLessons[l.id] = l;
          lessonContent[l.id] = l.content ?? null;
        }
        for (const t of u.topics) {
          for (const l of t.lessons) {
            treeLessons[l.id] = l;
            lessonContent[l.id] = l.content ?? null;
          }
        }
      }
    }
  };

  const summaryStates = (s) =>
    s
      ? {
          video: s.video.state,
          material: s.material.state,
          quiz: s.quiz.state,
          homework: s.homework.state,
        }
      : null;

  // ===========================================================================
  asUser(sAr.user);
  const treeAr = await GET(R.course, "http://t/api/courses/phasec-a", { slug: "phasec-a" });
  eq(treeAr.status, 200, "Arabic student opens the course tree");
  flattenTree(treeAr.json);

  // --- A. modern SessionVideo only → AVAILABLE without any legacy videoUrl ---
  eq(summaryStates(lessonContent[L_MODERN.id]), { video: "AVAILABLE", material: "ABSENT", quiz: "ABSENT", homework: "ABSENT" },
    "A: modern-video-only lesson → video AVAILABLE, everything else ABSENT");
  eq(treeLessons[L_MODERN.id].videoUrl, null, "A: the lesson carries no legacy videoUrl");
  eq(treeLessons[L_MODERN.id].hasVideo, true, "A: the tree still badges the modern-only lesson");

  // --- B. legacy videoUrl only → the documented compatibility fallback ---
  eq(summaryStates(lessonContent[L_LEGACY.id]), { video: "AVAILABLE", material: "ABSENT", quiz: "ABSENT", homework: "ABSENT" },
    "B: legacy-videoUrl-only lesson → video AVAILABLE via the fallback");
  eq(lessonContent[L_LEGACY.id].video.count, 1, "B: the fallback counts as exactly one video");
  eq(treeLessons[L_LEGACY.id].hasVideo, true, "B: the tree keeps the legacy badge");

  // --- C/D. SHARED lesson, audience-split videos: own audience only ---
  eq(lessonContent[L_FULL.id].video.state, "AVAILABLE", "C: SHARED lesson video AVAILABLE for the Arabic student");
  eq(lessonContent[L_FULL.id].video.count, 1, "C: exactly ONE video counted (own batch; the Language row and the unpublished row never count)");
  eq(lessonContent[L_ARABIC.id].video.state, "AVAILABLE", "C: the ARABIC-only lesson is visible to the Arabic student");
  ok(!(L_LANG.id in treeLessons) || treeLessons[L_LANG.id] === undefined,
    "C: the LANGUAGE-only lesson is not even in the Arabic student's tree");

  // --- E. multiple eligible SessionVideos ---
  eq(lessonContent[L_MULTI.id].video.state, "AVAILABLE", "E: multi-video lesson stays AVAILABLE");
  eq(lessonContent[L_MULTI.id].video.count, 2, "E: the summary counts BOTH eligible recordings");
  {
    asUser(sAr.user);
    const vids = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L_MULTI.id}`, {});
    eq(vids.status, 200, "E: the lesson video list loads");
    eq(vids.json.videos.length, 2, "E: the lesson page can render BOTH recordings");
  }

  // --- F. material exists → AVAILABLE ---
  eq(lessonContent[L_MAT.id].material.state, "AVAILABLE", "F: material-bearing lesson → material AVAILABLE");
  eq(lessonContent[L_MAT.id].material.count, 1, "F: exactly one downloadable material (inactive twin never counts)");
  eq(treeLessons[L_MAT.id].materialCount, 1, "F: the tree serialises the material count");

  // --- G. unauthorized / non-downloadable materials are NOT exposed ---
  eq(lessonContent[L_FULL.id].material.count, 1,
    "G: the Arabic student counts ONLY the SHARED downloadable material (ARABIC-no-asset skipped, LANGUAGE invisible, shared reachable)");
  eq(treeLessons[L_FULL.id].materials.length, 1, "G: exactly one material descriptor leaves the route");
  eq(treeLessons[L_FULL.id].materials[0].id, matFullShared.id, "G: the descriptor is the student's own material");
  ok(!JSON.stringify(treeLessons[L_FULL.id].materials).includes("storageKey"), "G: no storageKey ever leaves the route");
  eq(lessonContent[L_MAT.id].video.state, "ABSENT", "G: an UNPUBLISHED video does not satisfy video presence");

  // --- H/I. quiz presence vs absence ---
  eq(lessonContent[L_MAT.id].quiz.state, "ABSENT", "I: a lesson without a quiz is ABSENT — never LOCKED");
  eq(lessonContent[L_QUIZ.id].quiz.state, "AVAILABLE", "H: the quiz-bearing lesson is AVAILABLE");
  eq(lessonContent[L_FULL.id].quiz.count, 2, "H: the Arabic student counts the SHARED quiz AND the ARABIC quiz (the LANGUAGE track is the only one hidden here)");

  // --- J/K. homework presence vs absence ---
  eq(lessonContent[L_MAT.id].homework.state, "ABSENT", "K: a lesson without homework is ABSENT — never LOCKED");
  eq(lessonContent[L_HW.id].homework.state, "AVAILABLE", "J: the homework-bearing lesson is AVAILABLE");
  eq(lessonContent[L_FULL.id].homework.count, 1, "J: only the SHARED homework counts for the Arabic student (LANGUAGE homework invisible)");

  // --- L. full lesson → one coherent summary ---
  eq(summaryStates(lessonContent[L_FULL.id]), { video: "AVAILABLE", material: "AVAILABLE", quiz: "AVAILABLE", homework: "AVAILABLE" },
    "L: the full lesson summarises all four components as AVAILABLE in one shape");

  // --- M. empty lesson → all ABSENT, no crash ---
  eq(summaryStates(lessonContent[L_EMPTY.id]), { video: "ABSENT", material: "ABSENT", quiz: "ABSENT", homework: "ABSENT" },
    "M: the empty lesson is all-ABSENT without a crash");
  eq(treeLessons[L_EMPTY.id].hasVideo, false, "M: no false video badge");
  eq(treeLessons[L_EMPTY.id].hasQuiz, false, "M: no false quiz badge");
  eq(treeLessons[L_EMPTY.id].hasAssignment, false, "M: no false homework badge");
  eq(treeLessons[L_EMPTY.id].materialCount, 0, "M: no false material badge");

  // --- Language student mirrors C/D on the SAME shared lesson ---
  asUser(sLang.user);
  const treeLang = await GET(R.course, "http://t/api/courses/phasec-a", { slug: "phasec-a" });
  eq(treeLang.status, 200, "Language student opens the course tree");
  const treeLessonsLang = {};
  const contentLang = {};
  for (const p of treeLang.json.parts) {
    for (const u of p.units) {
      for (const l of u.lessons) { treeLessonsLang[l.id] = l; contentLang[l.id] = l.content ?? null; }
      for (const t of u.topics) for (const l of t.lessons) { treeLessonsLang[l.id] = l; contentLang[l.id] = l.content ?? null; }
    }
  }
  eq(contentLang[L_FULL.id].video.state, "AVAILABLE", "D: SHARED lesson video AVAILABLE for the Language student");
  eq(contentLang[L_FULL.id].video.count, 1, "D: exactly ONE video (the Language row; the Arabic row never counts)");
  eq(contentLang[L_FULL.id].material.count, 2, "D/P: the Language student counts SHARED + LANGUAGE materials (the ARABIC one is invisible)");
  eq(contentLang[L_FULL.id].quiz.count, 1, "D/P: only the SHARED quiz counts for the Language student (the ARABIC quiz is invisible)");
  eq(contentLang[L_FULL.id].homework.count, 2, "D/P: the Language student counts SHARED + LANGUAGE homework (the ARABIC one is invisible)");
  eq(contentLang[L_LANG.id].video.state, "AVAILABLE", "D: the LANGUAGE-only lesson is visible to the Language student");
  ok(treeLessonsLang[L_ARABIC.id] === undefined, "D: the ARABIC-only lesson is not in the Language student's tree");
  ok(treeLessonsLang[L_MODERN.id] === undefined || contentLang[L_MODERN.id].video.state === "ABSENT",
    "D: the Arabic-batch recording of L_MODERN is NOT counted for the Language student");

  // --- Language student lesson page on the SAME shared lesson ---
  {
    const lp = await GET(R.lesson, `http://t/api/lessons/${L_FULL.id}`, { id: L_FULL.id });
    eq(lp.status, 200, "Language student opens the shared lesson page");
    eq(lp.json.content.quiz.count, 1, "R: the lesson page quiz count matches the tree (SHARED only)");
    eq(lp.json.content.quiz.state, "AVAILABLE", "R: the lesson page quiz state matches the tree");
    // The rendered quiz LIST agrees with the summary (one quiz, the shared one).
    eq(lp.json.quizzes.length, 1, "R: the lesson page quiz list length equals the authority count");
    eq(lp.json.quizzes[0].id, quizFullShared.id, "R: the listed quiz IS the shared quiz");
  }

  // --- Arabic student lesson page — same authority, own audience ---
  {
    asUser(sAr.user);
    const lp = await GET(R.lesson, `http://t/api/lessons/${L_FULL.id}`, { id: L_FULL.id });
    eq(lp.status, 200, "Arabic student opens the shared lesson page");
    eq(lp.json.content.video.count, 1, "R: lesson-page video count matches the tree badge (own batch)");
    eq(lp.json.content.material.count, treeLessons[L_FULL.id].materialCount, "R: lesson-page material count matches the tree");
    eq(lp.json.content.quiz.count, 2, "H: the Arabic student is served BOTH the SHARED and the ARABIC quiz");
    eq(lp.json.quizzes.length, 2, "H: the lesson page lists both eligible quizzes");
    eq(lp.json.homework.id, hwFullShared.id, "J: the homework card carries the student's own homework");
  }

  // --- O. cross-course: no leakage ---
  {
    asUser(sB.user);
    const treeB = await GET(R.course, "http://t/api/courses/phasec-b", { slug: "phasec-b" });
    eq(treeB.status, 200, "course-B student opens their own course");
    const lb1 = treeB.json.parts[0].units[0].lessons[0];
    eq(lb1.content.video.state, "AVAILABLE", "O: the course-B lesson has its own video");
    eq(lb1.id, LB1.id, "O: sanity — the flat lesson is LB1");
    const foreign = await GET(R.course, "http://t/api/courses/phasec-a", { slug: "phasec-a" });
    eq(foreign.status, 403, "O: course-A content is refused to the course-B student");
    const cross = await GET(R.lesson, `http://t/api/lessons/${L_FULL.id}`, { id: L_FULL.id });
    eq(cross.status, 403, "O: a foreign lesson page is refused (no summary of any kind)");
  }

  // --- N. locked lesson: aggregation never bypasses the lesson policy ---
  {
    asUser(sAr.user);
    const lp = await GET(R.lesson, `http://t/api/lessons/${L_LOCK.id}`, { id: L_LOCK.id });
    eq(lp.status, 403, "N: the locked lesson page stays refused (progression untouched)");
    eq(lp.json.content, undefined, "N: no content/summary accompanies the refusal");
    // The tree keeps the Phase 16 lock-independent skeleton badges…
    eq(treeLessons[L_LOCK.id].status, "locked", "N: the tree row is locked");
    eq(treeLessons[L_LOCK.id].hasVideo, true, "N: the locked row keeps its skeleton video badge");
    eq(treeLessons[L_LOCK.id].hasQuiz, true, "N: the locked row keeps its skeleton quiz badge");
    eq(treeLessons[L_LOCK.id].hasAssignment, true, "N: the locked row keeps its skeleton homework badge");
    // …while every protected field stays redacted.
    for (const field of ["videoUrl", "pdfUrl", "summary", "description", "quiz", "homework", "requirements"]) {
      eq(treeLessons[L_LOCK.id][field], null, `N: locked row redacts ${field}`);
    }
    eq(treeLessons[L_LOCK.id].materials, [], "N: locked row exposes no material descriptors");
  }

  // --- Q. archived / DRAFT lessons: no student content leakage ---
  {
    ok(treeLessons[L_ARCH.id] === undefined, "Q: the ARCHIVED lesson is absent from the student tree");
    ok(treeLessons[L_DRAFT.id] === undefined, "Q: the DRAFT lesson is absent from the student tree");
    asUser(sAr.user);
    const arch = await GET(R.lesson, `http://t/api/lessons/${L_ARCH.id}`, { id: L_ARCH.id });
    eq(arch.status, 404, "Q: the archived lesson page is a non-oracle 404");
    const draft = await GET(R.lesson, `http://t/api/lessons/${L_DRAFT.id}`, { id: L_DRAFT.id });
    eq(draft.status, 404, "Q: the draft lesson page is a non-oracle 404");
    const vidsArch = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L_ARCH.id}`, {});
    eq(vidsArch.json.videos.length, 0, "Q: no videos leak for the archived lesson");
    const vidsDraft = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${L_DRAFT.id}`, {});
    eq(vidsDraft.json.videos.length, 0, "Q: no videos leak for the draft lesson");
  }

  // --- T. no progression rules changed — the locked chain still behaves ---
  {
    asUser(sAr.user);
    // L_QUIZ has an untouched quiz → still incomplete → L_LOCK still locked
    // (already pinned above) and L_HW is reachable (before the gate).
    const lp = await GET(R.lesson, `http://t/api/lessons/${L_HW.id}`, { id: L_HW.id });
    eq(lp.status, 200, "T: earlier lessons stay reachable (order semantics untouched)");
  }

  // ===========================================================================
  // S. Continue Learning — the dashboard card carries the SAME summary.
  // ===========================================================================
  {
    asUser(sAr.user);
    // Touch L_FULL so it becomes the last-viewed lesson (it is the FIRST
    // session, so it is unlocked regardless of the chain's gate).
    await client.lessonProgress.upsert({
      where: { studentId_lessonId: { studentId: sAr.student.id, lessonId: L_FULL.id } },
      update: { lastViewedAt: new Date() },
      create: { studentId: sAr.student.id, lessonId: L_FULL.id, progress: 0, isCompleted: false, lastViewedAt: new Date() },
    });
    const dash = await GET(R.dashboard, "http://t/api/students/me/dashboard", {});
    eq(dash.status, 200, "S: the student dashboard loads");
    eq(dash.json.continueLesson.id, L_FULL.id, "S: continueLesson resolves the last-viewed session");
    eq(dash.json.continueLesson.content.video.state, "AVAILABLE", "S: the card's video state matches the tree badge (own batch)");
    eq(dash.json.continueLesson.content.video.count, 1, "S: the card's video count matches the tree (the Language row never counts)");
    eq(dash.json.continueLesson.content.material.state, "AVAILABLE", "S: the card's material state matches the tree");
    eq(dash.json.continueLesson.content.quiz.state, "AVAILABLE", "S: the card's quiz state matches the tree");
    eq(dash.json.continueLesson.content.homework.state, "AVAILABLE", "S: the card's homework state matches the tree");
    // The legacy videoUrl compatibility field is untouched (and null here —
    // this lesson's video is a modern SessionVideo row).
    eq(dash.json.continueLesson.videoUrl, null, "S: the legacy videoUrl field is preserved (null for a modern-only lesson)");
  }

  // ===========================================================================
  // Authority unit checks (the pure core, exercised directly):
  // states, legacy fallbacks, audience isolation, empty inputs.
  // ===========================================================================
  {
    const empty = await authority.buildLessonContentSummaries({ lessons: [], viewer: { role: "STAFF" } });
    eq(empty.size, 0, "authority: empty lesson list → empty map, no crash");

    const staffAll = await authority.buildLessonContentSummaries({
      lessons: [{
        id: L_FULL.id, videoUrl: null, pdfUrl: null,
        quizzes: [{ id: "q1", trackScope: "ARABIC" }, { id: "q2", trackScope: "LANGUAGE" }],
        homeworks: [{ id: "h1", trackScope: "ARABIC" }],
        materials: [
          { id: "m1", title: "ar", kind: "ADMIN_UPLOADED", trackScope: "ARABIC", isActive: true, mediaAssetId: "a1", media: { mimeType: "application/pdf", sizeBytes: 1 } },
          { id: "m2", title: "lang", kind: "ADMIN_UPLOADED", trackScope: "LANGUAGE", isActive: true, mediaAssetId: "a2", media: { mimeType: "application/pdf", sizeBytes: 1 } },
        ],
      }],
      viewer: { role: "STAFF" },
    });
    eq(staffAll.get(L_FULL.id).quiz.count, 2, "authority: staff previews count every track's quizzes");
    eq(staffAll.get(L_FULL.id).material.count, 2, "authority: staff previews count every track's materials");

    const arSlice = await authority.buildLessonContentSummaries({
      lessons: [{
        id: L_FULL.id, videoUrl: null, pdfUrl: "https://legacy.example.com/fallback.pdf",
        quizzes: [{ id: "q1", trackScope: "ARABIC" }, { id: "q2", trackScope: "LANGUAGE" }],
        homeworks: [{ id: "h1", trackScope: "ARABIC" }, { id: "h2", trackScope: "LANGUAGE" }],
        materials: [
          { id: "m1", title: "ar", kind: "ADMIN_UPLOADED", trackScope: "ARABIC", isActive: true, mediaAssetId: "a1", media: { mimeType: "application/pdf", sizeBytes: 1 } },
          { id: "m2", title: "lang", kind: "ADMIN_UPLOADED", trackScope: "LANGUAGE", isActive: true, mediaAssetId: "a2", media: { mimeType: "application/pdf", sizeBytes: 1 } },
        ],
      }],
      viewer: { role: "STUDENT", schoolType: "ARABIC", batchId: batchAr.id },
    });
    const ar = arSlice.get(L_FULL.id);
    eq(ar.quiz.count, 1, "authority: the Arabic student counts ONLY the ARABIC quiz (LANGUAGE invisible)");
    eq(ar.quiz.state, "AVAILABLE", "authority: quiz AVAILABLE");
    eq(ar.homework.count, 1, "authority: the Arabic student counts ONLY the ARABIC homework");
    eq(ar.material.count, 1, "authority: the ARABIC material counts; the legacy pdfUrl fallback does NOT stack when a real descriptor exists (the Phase 14 rule)");
    eq(ar.video.state, "AVAILABLE", "authority: legacy pdfUrl/videoUrl fallback works through the pure core");

    const none = await authority.buildLessonContentSummaries({
      lessons: [{ id: "lx", videoUrl: null, pdfUrl: null, quizzes: [], homeworks: [], materials: [] }],
      viewer: { role: "STUDENT", schoolType: "ARABIC", batchId: null },
    });
    eq(summaryStates(none.get("lx")), { video: "ABSENT", material: "ABSENT", quiz: "ABSENT", homework: "ABSENT" },
      "authority: a batch-less student fails closed — nothing is visible");

    const payload = authority.toLessonContentPayload(none.get("lx"));
    eq(Object.keys(payload).sort(), ["homework", "material", "quiz", "video"], "authority: the payload carries exactly the four components");
    for (const key of ["video", "material", "quiz", "homework"]) {
      eq(payload[key].state, "ABSENT", `authority: payload ${key} is ABSENT (never LOCKED without a real rule)`);
    }
    ok(authority.hasContentPart(none.get("lx"), "video") === false, "authority: hasContentPart is false for ABSENT");
  }

  // ===========================================================================
  // R/T/U source invariants — one authority, progression + readiness intact.
  // ===========================================================================
  {
    const courseRoute = read("src/app/api/courses/[slug]/route.ts");
    const lessonRoute = read("src/app/api/lessons/[id]/route.ts");
    const dashRoute = read("src/app/api/students/me/dashboard/route.ts");
    const libSrc = read("src/lib/lesson-content.ts");
    const engine = read("src/lib/session-progress.ts");
    const lifecycle = read("src/lib/session-lifecycle.ts");

    ok(/buildLessonContentSummaries/.test(courseRoute), "R: the course tree calls the shared authority");
    ok(/buildLessonContentSummaries/.test(lessonRoute), "R: the lesson page calls the shared authority");
    ok(/buildLessonContentSummaries/.test(dashRoute), "R: the dashboard calls the shared authority");
    ok(!/db\.sessionVideo\.findMany/.test(courseRoute), "R: the tree no longer carries its own SessionVideo query");
    ok(!/hasQuiz:\s*lesson\.quizzes\.length/.test(courseRoute), "R: the tree no longer counts raw quiz rows (track-unfiltered)");
    ok(!/hasAssignment:\s*lesson\.homeworks\.length/.test(courseRoute), "R: the tree no longer counts raw homework rows (track-unfiltered)");
    ok(/toLessonContentPayload\(content\)/.test(courseRoute), "R: the tree serialises the SAME summary the lesson page returns");

    // The authority reuses the established predicates instead of re-implementing.
    ok(/eligibleTrackScopes/.test(libSrc) && /videoTrackFilter/.test(libSrc), "T: the authority reuses the Phase 12 track predicates");
    ok(/buildMaterialDescriptors/.test(libSrc), "T: the authority reuses the Phase 14 material authority");
    ok(!/db\.lessonProgress/.test(libSrc), "T: the authority never reads progress rows (NOT a second progression engine)");
    ok(!/VIDEO_COMPLETION_THRESHOLD/.test(libSrc), "T: the authority never restates the 95% rule");
    ok(!/from "@\/lib\/session-progress"|require\("@\/lib\/session-progress"\)/.test(libSrc), "T: the authority never imports the progression module (callers keep their gates)");

    // T/U: the engines are byte-intact where Phase C is concerned.
    ok(/const hasVideo = !!lesson\.videoUrl;/.test(engine), "T: the progression engine still derives video REQUIRED-ness from the legacy column only");
    ok(/const hasQuiz = lesson\.quizzes\.length > 0;/.test(engine), "T: the progression engine quiz requirement unchanged");
    ok(/const hasHomework = lesson\.homeworks\.length > 0;/.test(engine), "T: the progression engine homework requirement unchanged");
    ok(/VIDEO_COMPLETION_THRESHOLD = 95/.test(read("src/lib/progress.ts")), "T: the 95% threshold literal untouched");
    ok(/DRAFT → READY/.test(lifecycle), "U: the lifecycle module is untouched (readiness contract intact)");
    ok(!/lesson-content/.test(lifecycle), "U: the lifecycle module does not import the authority (no readiness coupling)");

    // i18n: the approved Arabic empty-state copy ships in the 2026 catalogue.
    const dict2026 = read("src/lib/i18n-dict-2026.ts");
    ok(dict2026.includes("لا توجد ملفات متاحة لهذه الحصة حاليًا"), "UI: the approved materials empty-state copy exists");
    ok(dict2026.includes("لا يوجد اختبار لهذه الحصة حاليًا"), "UI: the approved quiz empty-state copy exists");
    ok(dict2026.includes("لا يوجد واجب لهذه الحصة حاليًا"), "UI: the approved homework empty-state copy exists");
    ok(dict2026.includes("لا يوجد فيديو متاح لهذه الحصة حاليًا"), "UI: the approved video empty-state copy exists (Phase B key retained)");

    // The lesson page renders the four sections in the canonical order and
    // keeps every section's empty state localised.
    const lessonView = read("src/components/course/student-lesson.tsx");
    const iVideos = lessonView.indexOf("LessonVideoSection");
    const iMaterials = lessonView.indexOf("course.230");
    const iQuiz = lessonView.indexOf("course.231");
    const iHw = lessonView.indexOf("course.232");
    ok(iVideos > -1 && iVideos < iMaterials && iMaterials < iQuiz && iQuiz < iHw,
      "UI: the workspace renders Videos → Materials → Quiz → Homework");
    ok(!lessonView.includes("course.076") && !lessonView.includes("course.080"),
      "UI: the legacy lesson empty-state keys are superseded by the approved copy");
  }

  // ===========================================================================
  console.log(`\nphaseC: ${pass} assertions passed, ${fail} failed`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(" -", f);
  }
  eq(fail, 0, "phaseC: zero assertion failures");
});
