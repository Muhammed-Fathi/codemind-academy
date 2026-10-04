// CodeMind Academy — Phase M4.6: session-video watch progress (short recordings).
//
// WHAT THIS SUITE PROVES (the manual-QA blocker: a 10-second recording watched
// to the end came back `percent: 0, isCompleted: false, satisfied: false`)
// =========================================================================
//   A. The SERVER credit rule is heartbeat-CADENCE INDEPENDENT. The anchor
//      (`SessionVideoView.lastHeartbeatAt`) advances by exactly the seconds
//      that were credited instead of jumping to the request clock on every
//      beat, so a burst of beats can no longer round every gap down to zero.
//      The anti-seek rule itself is untouched: credit is still bounded by REAL
//      elapsed wall-clock time, by the playhead and by the 60s cap.
//        A1  a 10s REQUIRED recording watched sequentially reaches >= 95% and
//            completes, and the "ended" flush is what persists it;
//        A2  the response carries the NEWLY persisted value (no stale read);
//        A3  repeated identical beats are idempotent;
//        A4  progress never decreases, not even at a lower playhead;
//        A5  seeking straight to the end earns only the seconds that passed
//            (< 95%) — no bypass;
//        A6  a beat burst credits the REAL elapsed time (the regression), no
//            beat can buy time by itself, and the 60s cap still drops the
//            clipped excess instead of banking it;
//        A7  another student cannot read or modify this student's progress,
//            not even in the same batch and not with an injected student id;
//        A8  OPTIONAL recordings stay telemetry-only (never a progression
//            input) and REQUIRED-vs-OPTIONAL semantics are unchanged;
//        A9  the progression engine sees the completed REQUIRED recording
//            (`requirements.video.done`, lesson completion accepted).
//   B. The SHIPPED player (`SessionVideoPlayer`) drives that rule correctly:
//        B1  playback anchors the server clock;
//        B2  a 10s recording played and ended end-to-end reaches >= 95% and
//            the player receives the fresh verdict (the reported bug);
//        B3  the beat count stays bounded while playing — the render→beat
//            feedback loop (400+ requests in half a second) is gone;
//        B4  a beat requested before metadata is measurable is DEFERRED and
//            flushed on metadata, never dropped;
//        B5  the ended flush carries the final playhead/duration and triggers
//            no further beats.
//
// The REAL route handler runs against the repository's migration-backed SQLite
// database with only the framework boundary shimmed (Prisma engine →
// sqlite-prisma-lite, auth → a script-controlled user, next/server shims), and
// the player is the real shipped TSX compiled by the repo's own tsc and
// mounted in jsdom. The wall clock is a controlled fake so the wall-clock
// credit rule can be exercised deterministically (no test sleeps for 10s).
//
// Run: node tests/phase-m46-video-watch-progress.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const REPO = path.resolve(__dirname, "..");

// Media env MUST be set before the compiled media.js module loads (it reads
// these at import time, exactly like production).
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m46-media-"));
process.env.MEDIA_STORAGE_PATH = MEDIA_DIR;
process.env.MEDIA_BACKEND = "local";
process.env.MEDIA_MAX_VIDEO_BYTES = String(1024 * 1024);
process.env.SECURITY_HASH_SECRET = "s".repeat(64);

// Empirical NO-NETWORK guard: any TCP connect attempt fails loudly.
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(`M4.6 test made a network connection attempt: ${JSON.stringify(args[0])}`);
  };
  process.on("exit", () => {
    net.Socket.prototype.connect = realConnect;
  });
}

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}
function eq(got, want, label) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b, `${label}${a === b ? "" : ` (got ${a}, want ${b})`}`);
}
function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Controlled wall clock — the credit rule is measured in REAL elapsed time, so
// the test owns the clock instead of sleeping.
// ---------------------------------------------------------------------------
const RealDate = Date;
let clockMs = RealDate.parse("2026-10-04T10:00:00.000Z");
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clockMs);
    else super(...args);
  }
  static now() {
    return clockMs;
  }
}
globalThis.Date = FakeDate;
const advanceClock = (ms) => {
  clockMs += ms;
};
const setClock = (ms) => {
  clockMs = ms;
};

// ---------------------------------------------------------------------------
// Scratch database: base DDL + every real migration.
// ---------------------------------------------------------------------------
const { DatabaseSync } = require("node:sqlite");
const mig = require(path.join(REPO, "scripts", "lib", "migrate-sqlite.mjs"));
const { createSqlitePrisma } = require(path.join(REPO, "scripts", "lib", "sqlite-prisma-lite.mjs"));

const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "m46: " });
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
  "src/lib/utils.ts",
  "src/lib/session-video-link.ts",
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
  "src/lib/academic-level.ts",
  "src/lib/academic-level-labels.ts",
  // the player under test (section B) and its UI/i18n dependencies
  "src/lib/store.ts",
  "src/lib/i18n.ts",
  "src/components/ui/card.tsx",
  "src/components/ui/badge.tsx",
  "src/components/ui/progress.tsx",
  "src/components/ui/skeleton.tsx",
  "src/components/ui/button.tsx",
  "src/components/course/session-videos-view.tsx",
  // route handlers under test
  "src/app/api/students/me/session-videos/route.ts",
  "src/app/api/students/me/session-videos/[id]/progress/route.ts",
  "src/app/api/lessons/[id]/route.ts",
  "src/app/api/lessons/[id]/progress/route.ts",
];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m46-compile-"));
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
        jsx: "react-jsx",
        resolveJsonModule: true,
        allowJs: false,
        types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")],
        baseUrl: REPO,
        paths: { "@/*": ["src/*"] },
        rootDir: REPO,
        outDir: OUT,
        noEmitOnError: false,
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
  const emitted = path.join(OUT, f.replace(/\.tsx?$/, ".js"));
  if (!fs.existsSync(emitted)) {
    console.error(`tsc did not emit ${f}`);
    process.exit(1);
  }
}
const EMIT = path.join(OUT, "src");

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
  "__sonner-shim.js": `module.exports = { toast: { error() {}, success() {}, info() {} } };`,
};
for (const [name, code] of Object.entries(SHIM_FILES)) {
  fs.writeFileSync(path.join(OUT, name), code);
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return path.join(OUT, "__db-shim.js");
  if (request === "@/lib/auth") return path.join(OUT, "__auth-shim.js");
  if (request === "next/server") return path.join(OUT, "__next-server-shim.js");
  if (request === "next/headers") return path.join(OUT, "__next-headers-shim.js");
  if (request === "sonner") return path.join(OUT, "__sonner-shim.js");
  const m = /^@\/(lib|components)\/(.+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, m[1], `${m[2]}.js`);
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
  lesson: route("lessons/[id]/route.js"),
  lessonProgress: route("lessons/[id]/progress/route.js"),
};

// ---------------------------------------------------------------------------
// HTTP-lite driver.
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
function asUser(u) {
  globalThis.__CM_USER__ = u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null;
}
async function call(handler, req, params) {
  const res = await handler(req, { params: Promise.resolve(params || {}) });
  const ct = res.headers?.get?.("content-type") || "";
  if (ct.includes("application/json")) return { status: res.status, json: await res.json() };
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}
const GET = (r, url, params) => call(r.GET, jsonReq(url), params);
const POST_JSON = (r, url, body, params) => call(r.POST, jsonReq(url, body), params);

(async () => {
// ---------------------------------------------------------------------------
// Fixture — one course, one batch, three students, and the recordings:
//   v10    10s REQUIRED (95%)   on L1  — the reported case
//   vSeek  10s REQUIRED (95%)   on L1  — the seek target
//   vBurst 10s REQUIRED (95%)   on L1  — the cadence probe
//   vOpt   10s OPTIONAL         on L1  — telemetry only
// ---------------------------------------------------------------------------
const course = await client.course.create({
  data: {
    slug: "m46-watch",
    name: "M4.6 Course",
    nameAr: "كورس M4.6",
    description: "m46",
    academicLevel: "SECOND_SECONDARY",
  },
});
const part = await client.part.create({ data: { courseId: course.id, title: "P1", titleAr: "P1", order: 1 } });
const unit = await client.unit.create({ data: { partId: part.id, title: "U1", titleAr: "U1", order: 1 } });
const L1 = await client.lesson.create({
  data: {
    academicLevel: "SECOND_SECONDARY",
    unitId: unit.id,
    trackScope: "SHARED",
    status: "PUBLISHED",
    curriculumStatus: "OFFICIAL",
    isPublished: true,
    order: 1,
    officialCode: "1-1",
    title: "Session one",
    titleAr: "الحصة الأولى",
  },
});
const batch = await client.batch.create({
  data: { name: "M4.6 Batch", nameAr: "دفعة", schoolType: "ARABIC", courseId: course.id },
});
const group = await client.group.create({ data: { name: "M4.6 Group", courseId: course.id, isActive: true } });
async function mkStudent(tag) {
  const u = await client.user.create({
    data: { email: `${tag}@m46.test`, password: "x", name: tag, role: "STUDENT" },
  });
  const s = await client.student.create({
    data: { userId: u.id, academicLevel: "SECOND_SECONDARY", schoolType: "ARABIC", groupId: group.id, batchId: batch.id },
  });
  return { user: u, student: s };
}
const s1 = await mkStudent("m46-one");
const s2 = await mkStudent("m46-two");
const s3 = await mkStudent("m46-three");
const media = await client.mediaAsset.create({
  data: { kind: "VIDEO", storage: "LOCAL_PRIVATE", storageKey: "k-m46", isPrivate: true },
});
const mkVideo = (over) =>
  client.sessionVideo.create({
    data: {
      batchId: batch.id,
      lessonId: L1.id,
      mediaAssetId: media.id,
      title: "Recording",
      titleAr: "تسجيل",
      requiredPercent: 95,
      requirementMode: "ALL_STUDENTS",
      isRequiredForProgression: true,
      isPublished: true,
      publishedAt: new Date(),
      ...over,
    },
  });
const v10 = await mkVideo({ title: "Ten seconds" });
// The credit rule under test (A5/A6) is requirement-MODE independent: it is
// the same arithmetic for every recording. Only ONE row stays REQUIRED so the
// lesson's requirement verdict (A8/A9) has a single, unambiguous input.
const vSeek = await mkVideo({
  title: "Seek target",
  requirementMode: "OPTIONAL",
  isRequiredForProgression: false,
});
const vBurst = await mkVideo({
  title: "Cadence probe",
  requirementMode: "OPTIONAL",
  isRequiredForProgression: false,
});
const vOpt = await mkVideo({
  title: "Optional clip",
  requirementMode: "OPTIONAL",
  isRequiredForProgression: false,
});

const beat = (video, user, body) => {
  asUser(user);
  return POST_JSON(
    R.videoProgress,
    `http://t/api/students/me/session-videos/${video.id}/progress`,
    body,
    { id: video.id }
  );
};
const viewOf = (video, student) =>
  client.sessionVideoView.findUnique({
    where: { sessionVideoId_studentId: { sessionVideoId: video.id, studentId: student.id } },
  });

// ===========================================================================
// A. Server credit rule
// ===========================================================================
section("A. Server — cadence-independent credit, anti-seek preserved");

// A1 — a 10s recording watched sequentially reaches the threshold. The client
// beats at 2s cadence with the playhead where it really is (this is what a
// normal, uninterrupted watch looks like).
{
  const beats = [
    { positionSec: 0, durationSec: 10 }, // play → anchor
    { positionSec: 2, durationSec: 10 },
    { positionSec: 4, durationSec: 10 },
    { positionSec: 6, durationSec: 10 },
    { positionSec: 8, durationSec: 10 },
    { positionSec: 10, durationSec: 10 }, // ended → final flush
  ];
  const percents = [];
  let last = null;
  for (const [i, body] of beats.entries()) {
    if (i > 0) advanceClock(2000);
    last = await beat(v10, s1.user, body);
    eq(last.status, 200, `A1: beat ${i + 1} of the sequential watch answers 200`);
    percents.push(last.json.percent);
  }
  eq(percents, [0, 20, 40, 60, 80, 100], "A1: a 10s recording watched in 2s steps reaches 100% (monotonic)");
  ok(
    percents.every((p, i) => i === 0 || p >= percents[i - 1]),
    "A1: progress increases monotonically"
  );
  eq(last.json.isCompleted, true, "A1: the final (ended) flush reports completion");
  eq(last.json.satisfied, true, "A1: the live verdict is satisfied at 100% >= 95%");
  eq(last.json.requiredPercent, 95, "A1: the response names the video's own threshold");
  const row = await viewOf(v10, s1.student);
  eq([row.watchedSec, row.durationSec, row.percent, row.isCompleted], [10, 10, 100, true], "A1: the ended flush PERSISTED the completion");
  ok(!!row.completedAt, "A1: completedAt is stamped");
  eq(last.json.percent, row.percent, "A2: the response carries the newly persisted percent (no stale read)");
  eq(last.json.isCompleted, row.isCompleted, "A2: the response carries the persisted completion flag");
}

// A3 — idempotency: the same beat again changes nothing.
{
  const before = await viewOf(v10, s1.student);
  const again = await beat(v10, s1.user, { positionSec: 10, durationSec: 10 });
  const after = await viewOf(v10, s1.student);
  eq(again.json.percent, 100, "A3: a repeated identical beat stays at 100%");
  eq(
    [after.watchedSec, after.percent, after.isCompleted],
    [before.watchedSec, before.percent, before.isCompleted],
    "A3: repeated progress calls are idempotent (no row rewrite)"
  );
}

// A4 — never decreases, even at a lower playhead.
{
  advanceClock(5000);
  const back = await beat(v10, s1.user, { positionSec: 3, durationSec: 10 });
  eq(back.json.percent, 100, "A4: a lower playhead never reduces progress");
  eq(back.json.isCompleted, true, "A4: completion is sticky");
  const row = await viewOf(v10, s1.student);
  eq(row.watchedSec, 10, "A4: watched seconds never decrease");
}

// A5 — seeking straight to the end cannot bypass the wall-clock rule.
{
  const first = await beat(vSeek, s2.user, { positionSec: 10, durationSec: 10 });
  eq(first.json.percent, 0, "A5: the very first beat is an anchor — 0% (no-spoof)");
  eq(first.json.isCompleted, false, "A5: seeking to the end does not complete on the first beat");
  advanceClock(1000);
  const one = await beat(vSeek, s2.user, { positionSec: 10, durationSec: 10 });
  eq(one.json.percent, 10, "A5: one second of real time credits one second, not the playhead");
  advanceClock(3000);
  const four = await beat(vSeek, s2.user, { positionSec: 10, durationSec: 10 });
  eq(four.json.percent, 40, "A5: after 4s only 40% — the threshold stays out of reach");
  eq(four.json.isCompleted, false, "A5: a direct seek-to-end never completes");
  ok(four.json.percent < 95, "A5: the anti-seek rule is preserved (never 95%+ by seeking)");
}

// A6 — the regression: a BEAT BURST still credits real elapsed time; beats
// themselves buy nothing, and the 60s cap still drops the clipped excess.
{
  const t0 = clockMs;
  const first = await beat(vBurst, s3.user, { positionSec: 0, durationSec: 10 });
  eq(first.json.percent, 0, "A6: the burst's first beat anchors at 0%");
  const percents = [0];
  for (let i = 1; i <= 20; i++) {
    advanceClock(250);
    const pos = Math.min(10, Math.round(((clockMs - t0) / 1000) * 1));
    const r = await beat(vBurst, s3.user, { positionSec: pos, durationSec: 10 });
    eq(r.status, 200, `A6: burst beat ${i} answers 200`);
    percents.push(r.json.percent);
  }
  ok(
    percents.every((p, i) => i === 0 || p >= percents[i - 1]),
    "A6: the burst's percent never decreases"
  );
  eq(percents[percents.length - 1], 50, "A6: 5s of real time in 20 fast beats credits 50% (not 0%)");
  const row = await viewOf(vBurst, s3.student);
  eq(row.watchedSec, 5, "A6: credited seconds equal REAL elapsed seconds (cadence independent)");

  // Beats alone buy nothing: 20 more beats, no time passes, no playhead moves.
  for (let i = 0; i < 20; i++) {
    const r = await beat(vBurst, s3.user, { positionSec: 5, durationSec: 10 });
    eq(r.json.percent, 50, `A6: extra beat ${i + 1} with no elapsed time credits nothing`);
  }
  eq((await viewOf(vBurst, s3.student)).watchedSec, 5, "A6: a beat storm cannot bank time");

  // The 60s cap still applies, and the clipped excess is DROPPED (never banked
  // into later beats).
  advanceClock(300000);
  const capped = await beat(vBurst, s3.user, { positionSec: 600, durationSec: 600 });
  eq(capped.json.percent, 11, "A6: a 300s gap credits at most 60s of the 600s claim (cap intact)");
  const capped2 = await beat(vBurst, s3.user, { positionSec: 600, durationSec: 600 });
  eq(capped2.json.percent, 11, "A6: the clipped excess is dropped, not deferred to the next beat");
  eq((await viewOf(vBurst, s3.student)).watchedSec, 65, "A6: watched seconds stop at 60s + the carried remainder");
}

// A7 — another student cannot read or modify this student's progress.
{
  asUser(s2.user);
  const list = await GET(R.videos, "http://t/api/students/me/session-videos");
  eq(list.status, 200, "A7: the peer student's own list answers 200");
  const peerRow = (list.json.videos || []).find((v) => v.id === v10.id);
  ok(!!peerRow, "A7: the same-batch recording is listed for the peer");
  eq(peerRow.progress.percent, 0, "A7: the peer sees 0% — another student's progress is not readable");
  eq(peerRow.progress.isCompleted, false, "A7: the peer does not inherit the completion flag");

  // Id injection: the peer names the owner in the body — it must be ignored.
  const inject = await beat(v10, s2.user, {
    positionSec: 10,
    durationSec: 10,
    studentId: s1.student.id,
  });
  eq(inject.status, 200, "A7: the peer's own beat succeeds");
  eq(inject.json.percent, 0, "A7: the injected studentId is ignored (no elapsed window yet)");
  const owner = await viewOf(v10, s1.student);
  eq([owner.watchedSec, owner.percent, owner.isCompleted], [10, 100, true], "A7: the owner's row is untouched by the peer");
  const rows = await client.sessionVideoView.findMany({ where: { sessionVideoId: v10.id } });
  eq(rows.length, 2, "A7: exactly one row per student exists for the recording");
  advanceClock(2000);
  await beat(v10, s2.user, { positionSec: 10, durationSec: 10 });
  eq((await viewOf(v10, s1.student)).percent, 100, "A7: the peer's later beats still cannot modify the owner's progress");
}

// A8 — OPTIONAL stays telemetry-only; REQUIRED-vs-OPTIONAL semantics unchanged.
{
  asUser(s1.user);
  const before = await GET(R.lesson, `http://t/api/lessons/${L1.id}`, { id: L1.id });
  eq(before.status, 200, "A8: the lesson opens for the owner");
  const vid = before.json.requirements.video;
  eq(vid.required, true, "A8: the REQUIRED recording gates the lesson");
  eq(vid.requiredCount, 1, "A8: only the REQUIRED recording is an input");
  eq((vid.items || []).map((i) => i.id), [v10.id], "A8: the OPTIONAL recording is not listed as an input");
  ok(!(vid.items || []).some((i) => i.id === vOpt.id), "A8: OPTIONAL never gates");

  // The OPTIONAL recording is still tracked (telemetry) when watched fully:
  // first beat anchors the clock, the second one (10s later) is the watch.
  await beat(vOpt, s1.user, { positionSec: 0, durationSec: 10 });
  advanceClock(10000);
  const opt = await beat(vOpt, s1.user, { positionSec: 10, durationSec: 10 });
  eq(opt.json.percent, 100, "A8: the OPTIONAL recording accrues watch time");
  eq(opt.json.isCompleted, true, "A8: OPTIONAL completion is still stored");
  const after = await GET(R.lesson, `http://t/api/lessons/${L1.id}`, { id: L1.id });
  eq(after.json.requirements.video.requiredCount, 1, "A8: OPTIONAL completion adds no requirement");
  eq(after.json.requirements.video.done, true, "A8: the lesson requirement is satisfied by the REQUIRED recording alone");
}

// A9 — progression sees the completed REQUIRED recording.
{
  asUser(s1.user);
  const lesson = await GET(R.lesson, `http://t/api/lessons/${L1.id}`, { id: L1.id });
  eq(lesson.json.requirements.video.done, true, "A9: the engine reports the required video as done");
  eq(
    lesson.json.requirements.state,
    "COMPLETED",
    "A9: the satisfied required recording converges the lesson's requirement state to COMPLETED"
  );
  const complete = await POST_JSON(
    R.lessonProgress,
    `http://t/api/lessons/${L1.id}/progress`,
    { completed: true },
    { id: L1.id }
  );
  eq(complete.status, 200, "A9: the lesson completion is accepted now that the video requirement is met");
  const progressRow = await client.lessonProgress.findUnique({
    where: { studentId_lessonId: { studentId: s1.student.id, lessonId: L1.id } },
  });
  eq(progressRow.isCompleted, true, "A9: the lesson completion persisted");
}

// ===========================================================================
// B. The shipped player
// ===========================================================================
section("B. Shipped SessionVideoPlayer — anchor, bounded beats, ended flush");

const { JSDOM } = require(path.join(REPO, "node_modules/jsdom"));
const dom = new JSDOM("<!doctype html><html lang='ar' dir='rtl'><head></head><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "CustomEvent", "getComputedStyle"]) {
  global[k] = dom.window[k];
}
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in global) continue;
  if (/^(HTML|SVG|CSS|DOM|XML|Text|Image|Range|Selection|Mutation|Intersection)/.test(k)) {
    try {
      global[k] = dom.window[k];
    } catch {
      /* read-only global */
    }
  }
}
global.SVGElement = dom.window.SVGElement;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.matchMedia =
  dom.window.matchMedia ||
  (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const React = require(path.join(REPO, "node_modules/react"));
const { createRoot } = require(path.join(REPO, "node_modules/react-dom/client"));
const { SessionVideoPlayer } = require(path.join(EMIT, "components/course/session-videos-view.js"));

// ---------------------------------------------------------------------------
// The browser model: a fake server clock that follows REAL time, and a media
// element whose playhead follows that clock while it is actually playing. A
// delayed request therefore behaves exactly like the field case: the payload
// leaves the client now and the server receives it `delay` later.
// ---------------------------------------------------------------------------
let mediaState = null;
let lastPumpTs = RealDate.now();
function pumpClock() {
  const now = RealDate.now();
  const step = now - lastPumpTs;
  if (step <= 0) return;
  lastPumpTs = now;
  advanceClock(step); // wall-clock time always flows
  if (mediaState?.playing) {
    mediaState.position = Math.min(mediaState.duration, mediaState.position + step / 1000);
  }
}
/** Let `ms` of REAL time flow through the model (browser-faithful pacing). */
async function flowRealTime(ms) {
  const t0 = RealDate.now();
  while (RealDate.now() - t0 < ms) {
    pumpClock();
    await new Promise((r) => setTimeout(r, 5));
  }
  pumpClock();
}
/** Deterministic playback: the wall clock and the playhead advance together. */
function compressPlayback(seconds) {
  pumpClock();
  advanceClock(seconds * 1000);
  if (mediaState) {
    mediaState.position = Math.min(mediaState.duration, mediaState.position + seconds);
  }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// The player's fetch goes through the REAL route handler (same DB, same auth).
let beatPosts = [];
let lastResponse = null;
let requestStarts = [];
let requestDelays = [];
let nextRequestDelayMs = 0;
let failNextRequest = false;
global.fetch = async (url, init) => {
  const body = JSON.parse(init?.body || "{}");
  const id = /\/session-videos\/([^/]+)\/progress$/.exec(String(url))?.[1];
  requestStarts.push(body);
  const delay = nextRequestDelayMs;
  nextRequestDelayMs = 0;
  if (failNextRequest) {
    failNextRequest = false;
    throw new Error("simulated network failure");
  }
  if (delay > 0) {
    const t0 = RealDate.now();
    await flowRealTime(delay); // the cold request is in flight for `delay` ms
    requestDelays.push({
      delay: RealDate.now() - t0,
      positionAtDelivery: mediaState ? mediaState.position : 0,
      playingAtDelivery: Boolean(mediaState?.playing),
    });
  } else {
    requestDelays.push({ delay: 0, positionAtDelivery: mediaState ? mediaState.position : 0, playingAtDelivery: Boolean(mediaState?.playing) });
  }
  asUser(s1.user);
  const res = await R.videoProgress.POST(jsonReq(String(url), body), { params: Promise.resolve({ id }) });
  const json = await res.json();
  beatPosts.push(body);
  lastResponse = json;
  return { ok: res.status < 300, status: res.status, json: async () => json };
};

/**
 * jsdom implements no media playback at all, so the test supplies the browser
 * behaviour the component is written against: `play()`/`pause()` fire their
 * events, the playhead is a real property, and metadata can arrive later than
 * the first `play()` click (exactly the race the field hit).
 */
function wireMedia(el, duration) {
  const state = { playing: false, position: 0, duration: Number.NaN, fullDuration: duration };
  Object.defineProperty(el, "duration", { configurable: true, get: () => state.duration });
  Object.defineProperty(el, "currentTime", {
    configurable: true,
    get: () => state.position,
    set: (v) => {
      state.position = Math.min(Math.max(0, Number(v) || 0), state.fullDuration);
    },
  });
  el.play = () => {
    if (!state.playing) {
      state.playing = true;
      el.dispatchEvent(new dom.window.Event("play"));
    }
    return Promise.resolve();
  };
  el.pause = () => {
    if (state.playing) {
      state.playing = false;
      el.dispatchEvent(new dom.window.Event("pause"));
    }
  };
  mediaState = state;
  return {
    state,
    knowMetadata() {
      state.duration = state.fullDuration;
    },
    async end() {
      if (state.playing) {
        state.playing = false;
        el.dispatchEvent(new dom.window.Event("pause"));
      }
      state.position = state.fullDuration;
      el.dispatchEvent(new dom.window.Event("ended"));
    },
  };
}

const playerVideo = (video) => ({
  id: video.id,
  title: "Ten seconds",
  titleAr: "عشر ثوان",
  description: null,
  lesson: null,
  requiredPercent: video.requiredPercent,
  publishedAt: null,
  src: `/api/media/${media.id}`,
  isExternal: false,
  isRequiredForProgression: true,
  requirementMode: "ALL_STUDENTS",
  applicable: true,
  trackable: true,
  progress: { percent: 0, isCompleted: false, watchedSec: 0, satisfied: false },
});

const roots = [];
const progressCalls = [];
async function mountPlayer(video) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  // The host mirrors the shipped hosts exactly: an INLINE onProgress that
  // updates state — the shape that used to rebuild `beat` on every response.
  function Host() {
    const [state, setState] = React.useState(() => playerVideo(video));
    return React.createElement(SessionVideoPlayer, {
      video: state,
      onProgress: (percent, isCompleted, satisfied) => {
        progressCalls.push({ percent, isCompleted, satisfied });
        setState((prev) => ({ ...prev, progress: { ...prev.progress, percent, isCompleted, satisfied } }));
      },
    });
  }
  await React.act(async () => {
    root.render(React.createElement(Host));
    await tick(50);
  });
  const el = container.querySelector("video");
  return { container, el };
}
const mountMedia = async (video, { withMetadata = true } = {}) => {
  const { container, el } = await mountPlayer(video);
  const media = wireMedia(el, 10);
  if (withMetadata) media.knowMetadata();
  return { container, el, media };
};
const fire = async (el, type, ms = 60) => {
  await React.act(async () => {
    el.dispatchEvent(new dom.window.Event(type));
    await tick(ms);
  });
};

// ---------------------------------------------------------------------------
// B1/B2/B3/B5 — the reported flow: a fresh 10s recording, played and ended.
// ---------------------------------------------------------------------------
{
  const vShort = await mkVideo({ title: "Reported case" });
  const { el, media } = await mountMedia(vShort);
  beatPosts = [];
  requestStarts = [];
  requestDelays = [];
  // Metadata = the player is measurable → the trusted window is armed BEFORE
  // the student can press play (Phase M4.6b).
  await fire(el, "loadedmetadata");
  eq(beatPosts.length, 1, "B1: metadata arms the watch window with exactly one anchor beat");
  eq(beatPosts[0], { positionSec: 0, durationSec: 10 }, "B1: the anchor carries the real playhead/duration");
  ok(!!(await viewOf(vShort, s1.student)), "B1: the anchor created the progress row");

  await React.act(async () => {
    media.state.playing = false;
    el.play();
    await tick(60);
  });
  ok(media.state.playing, "B1: an armed player is NOT held — playback runs");
  eq(beatPosts.length, 2, "B1: the play beat follows the anchor");

  // 1.2s of continuous playback (well inside the 15s interval) must stay quiet:
  // the old render→beat loop sent hundreds of beats here and reset the server
  // anchor every few milliseconds.
  await flowRealTime(1200);
  ok(beatPosts.length <= 4, `B3: playing does not storm the heartbeat route (got ${beatPosts.length} beats in 1.2s)`);

  // Watch it to the end: the playhead reaches 10s and the window is 10s wide.
  compressPlayback(10 - media.state.position);
  beatPosts = [];
  await fire(el, "ended", 80);
  eq(beatPosts[beatPosts.length - 1], { positionSec: 10, durationSec: 10 }, "B5: the ended flush carries the final playhead/duration");
  ok(beatPosts.length <= 2, `B5: the end flush is bounded (got ${beatPosts.length} beats)`);
  const row = await viewOf(vShort, s1.student);
  eq(row.watchedSec, 10, "B2: the full 10s is credited");
  eq(row.percent, 100, "B2: a 10s recording watched normally reaches 100% (>= 95%)");
  eq(row.isCompleted, true, "B2: the ended flush persisted the completion");
  eq(lastResponse.percent, row.percent, "B2: the player received the freshly persisted percent");
  eq(lastResponse.satisfied, true, "B2: the player received the satisfied verdict");
  const lastCall = progressCalls[progressCalls.length - 1];
  eq([lastCall.percent, lastCall.satisfied], [100, true], "B2: the parent's onProgress saw the completion (no stale UI state)");

  const after = beatPosts.length;
  await React.act(async () => {
    await tick(250);
  });
  eq(beatPosts.length, after, "B5: no beats fire after the ended flush");

  // C9 (completion) — completion is monotonic and idempotent.
  media.state.position = 5;
  await fire(el, "play", 40);
  await fire(el, "pause", 40);
  const repeat = await beat(vShort, s1.user, { positionSec: 10, durationSec: 10 });
  const done = await viewOf(vShort, s1.student);
  eq(repeat.json.percent, 100, "C9: repeating the completion beat keeps 100%");
  eq([done.watchedSec, done.percent, done.isCompleted], [10, 100, true], "C9: completion is monotonic and idempotent after re-watching");
}

// ---------------------------------------------------------------------------
// B4 — a play attempt before metadata is measurable: held, deferred, resumed.
// ---------------------------------------------------------------------------
{
  const vDefer = await mkVideo({ title: "Deferred anchor" });
  const { el, media } = await mountMedia(vDefer, { withMetadata: false });
  beatPosts = [];
  await React.act(async () => {
    el.play(); // duration still NaN — the student clicked immediately
    await tick(60);
  });
  eq(beatPosts.length, 0, "B4: an unmeasurable play attempt sends no bogus request");
  ok(!media.state.playing, "B4: the attempt is held until the window can be armed");
  media.knowMetadata();
  await fire(el, "loadedmetadata");
  eq(beatPosts.length, 2, "B4: metadata arms the window and flushes the held play beat");
  eq(beatPosts[0], { positionSec: 0, durationSec: 10 }, "B4: the arm beat is the anchor");
  ok(!!(await viewOf(vDefer, s1.student)), "B4: the anchor row exists, so the final flush has an elapsed window");
  ok(media.state.playing, "B4: the held play attempt resumes automatically");
}

// ---------------------------------------------------------------------------
// C. Cold start — the first request takes ~2.3s (the field timing)
// ---------------------------------------------------------------------------
section("C. Cold start — first request delayed ~2.3s, playback must not lose its start");

{
  const vCold = await mkVideo({ title: "Cold start" });
  const { el, media } = await mountMedia(vCold);
  beatPosts = [];
  requestStarts = [];
  requestDelays = [];
  nextRequestDelayMs = 2300; // the exact browser-like cold request

  // The player is measurable and arms immediately; the student presses play
  // ~30ms later, while that first request is still in flight.
  await React.act(async () => {
    el.dispatchEvent(new dom.window.Event("loadedmetadata"));
    await tick(30);
  });
  await React.act(async () => {
    el.play();
    await tick(30);
  });
  ok(!media.state.playing, "C1/C4: the play attempt is held while the window is unarmed");
  eq(requestStarts.length, 1, "C1: the hold fires no extra beat — the anchor is the only request in flight");
  eq(requestStarts[0], { positionSec: 0, durationSec: 10 }, "C1: the in-flight request is the anchor");

  await flowRealTime(2500); // the cold request finally lands (server clock follows)
  ok(requestDelays[0].delay >= 2200, `C1: the first request really took ~2.3s (${requestDelays[0].delay}ms)`);
  eq(requestDelays[0].positionAtDelivery, 0, "C4: no playback happened inside the unarmed window");
  eq(requestDelays[0].playingAtDelivery, false, "C4: playback was still held when the anchor was received");
  ok(media.state.playing, "C4: playback resumes automatically once the anchor lands");

  // Playback proceeds for the complete real duration: 10s of wall clock and 10s
  // of playhead, then the recording ends.
  const startedAt = media.state.position;
  compressPlayback(10 - startedAt);
  await fire(el, "ended", 80);
  const row = await viewOf(vCold, s1.student);
  eq(row.durationSec, 10, "C2: the recording's real duration is the credited denominator");
  eq(row.watchedSec, 10, "C2/C3: the whole recording is credited (nothing lost to the cold start)");
  eq(row.percent, 100, "C3: a genuinely watched 10s recording reaches 100% (>= 95%) despite the 2.3s cold start");
  eq(row.isCompleted, true, "C3: the delayed-start flow still persists completion");
  eq(lastResponse.satisfied, true, "C3: the player is told the requirement is satisfied");
  ok(beatPosts.length <= 5, `C10: no heartbeat storm in the cold-start flow (got ${beatPosts.length} beats)`);
}

// C5/C6 — a cold anchor followed by a seek still cannot bank fake watch time.
{
  const vColdSeek = await mkVideo({ title: "Cold seek" });
  const { el, media } = await mountMedia(vColdSeek);
  beatPosts = [];
  requestStarts = [];
  requestDelays = [];
  nextRequestDelayMs = 2300;
  await React.act(async () => {
    el.dispatchEvent(new dom.window.Event("loadedmetadata"));
    await tick(20);
  });
  await React.act(async () => {
    el.play();
    await tick(20);
  });
  media.state.position = 10; // the student drags the bar to the very end
  await flowRealTime(2500); // the anchor lands; the held play is honored at 10s
  ok(requestDelays[0].delay >= 2200, "C5: the seek happens under a cold anchor too");
  await fire(el, "ended", 80);
  const row = await viewOf(vColdSeek, s1.student);
  ok(row.percent < 95, `C5: seeking to the end under a cold anchor never completes (got ${row.percent}%)`);
  eq(row.isCompleted, false, "C5: no completion flag is granted");
  ok(row.watchedSec <= 1, `C6: the seek banks at most the real seconds that passed (watched ${row.watchedSec}s)`);
  eq(lastResponse.satisfied, false, "C6: the live verdict stays unsatisfied");
}

// C7 — paused time and playback rate do not buy wall-clock credit.
{
  const vPaused = await mkVideo({ title: "Paused time" });
  const { el, media } = await mountMedia(vPaused);
  await fire(el, "loadedmetadata");
  await React.act(async () => {
    el.play();
    await tick(40);
  });
  compressPlayback(3);
  await fire(el, "pause", 60);
  const paused = await viewOf(vPaused, s1.student);
  eq([paused.watchedSec, paused.percent], [3, 30], "C7: three watched seconds credit three seconds");

  // 60s of REAL time with the recording paused (a break): the playhead does not
  // move, so the wall clock must not inflate the credited watch time.
  advanceClock(60000);
  await React.act(async () => {
    media.state.playing = false;
    el.play();
    await tick(60);
  });
  const resumed = await viewOf(vPaused, s1.student);
  eq([resumed.watchedSec, resumed.percent], [3, 30], "C7: idle time cannot earn watch credit beyond the playhead");
  media.state.playing = false;
}

// C7b — playback rate: 2x playhead, 1x credit (wall-clock rule intact).
{
  const vRate = await mkVideo({ title: "Double rate" });
  const { el, media } = await mountMedia(vRate);
  await fire(el, "loadedmetadata");
  await React.act(async () => {
    el.play();
    await tick(40);
  });
  advanceClock(2000); // 2 real seconds pass …
  media.state.position = 4; // … while the playhead ran at 2x
  await fire(el, "pause", 60);
  const row = await viewOf(vRate, s1.student);
  eq([row.watchedSec, row.percent], [2, 20], "C7b: credit follows the wall clock, not a fast playhead");
  media.state.playing = false;
}

// C8 — repeated play/pause cycles do not duplicate credit.
{
  const vCycles = await mkVideo({ title: "Cycles" });
  const { el, media } = await mountMedia(vCycles);
  await fire(el, "loadedmetadata");
  for (let i = 0; i < 5; i++) {
    await React.act(async () => {
      el.play();
      await tick(15);
      el.pause();
      await tick(15);
    });
  }
  const none = await viewOf(vCycles, s1.student);
  eq([none.watchedSec, none.percent], [0, 0], "C8: five instant play/pause cycles credit nothing");
  await React.act(async () => {
    media.state.playing = false;
    el.play();
    await tick(20);
  });
  compressPlayback(1); // one real second of playback: clock and playhead together
  await fire(el, "pause", 60);
  const one = await viewOf(vCycles, s1.student);
  eq([one.watchedSec, one.percent], [1, 10], "C8: one real second credits exactly one second, once");
  await React.act(async () => {
    el.play();
    await tick(20);
    el.pause();
    await tick(20);
    el.play();
    await tick(20);
    el.pause();
    await tick(20);
  });
  const still = await viewOf(vCycles, s1.student);
  eq([still.watchedSec, still.percent], [1, 10], "C8: the extra cycles add no credit");
  media.state.playing = false;
}

// C11 — a failing anchor request must never lock the student out of playback.
{
  const vOffline = await mkVideo({ title: "Offline anchor" });
  const { el, media } = await mountMedia(vOffline);
  beatPosts = [];
  requestStarts = [];
  requestDelays = [];
  failNextRequest = true;
  await fire(el, "loadedmetadata"); // the anchor attempt fails
  await React.act(async () => {
    el.play();
    await tick(60);
  });
  ok(media.state.playing, "C11: a failed anchor never locks the student out of their own recording");
  media.state.playing = false;
}

for (const root of roots) {
  try {
    await React.act(async () => {
      root.unmount();
    });
  } catch {
    /* unmounted */
  }
}

// ---------------------------------------------------------------------------
console.log(`\nM4.6 video watch-progress suite: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.error(" -", f);
}
globalThis.Date = RealDate;
process.exit(fail > 0 ? 1 : 0);
})();
