// CodeMind Academy — Session media upload & URL publishing regression suite.
//
// Added by the media upload / session publishing audit. Each section pins ONE
// production defect that shipped to real admins, so it cannot silently return.
//
// DEFECT 1 — "تعذّر بدء الرفع. حاول تاني." on EVERY desktop upload
//   `/api/admin/media-uploads/init` answers `ok(result.init)`, i.e. the grant
//   fields sit at the TOP LEVEL of the JSON body. The browser helper read
//   `body.upload`, a shape the endpoint never produced. So with
//   MEDIA_BACKEND=s3 (production) every video AND every PDF upload failed at
//   the init leg despite the server having issued a valid presigned URL. Under
//   MEDIA_BACKEND=local the endpoint answers 409 PRESIGNED_UNSUPPORTED first
//   and the client fell back to the buffered path, which is why the defect was
//   invisible in development. Proven here by running the REAL server function
//   and the REAL client function against each other — not a reimplementation.
//
// DEFECT 2 — a video URL that saves fine but never plays for students
//   Any http(s) URL was accepted and handed to a bare `<video src>`. A YouTube
//   watch URL is an HTML page, so the player stayed black with no error at
//   save, publish, or playback time. The contract in `src/lib/video-url.ts`
//   now accepts only forms the player can render, and normalises them.
//
// Run: node tests/session-media-publishing-audit.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-media-audit-"));

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
function section(t) {
  console.log(`\n${t}`);
}
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ---------------------------------------------------------------------------
// Compile the modules under test (same pattern as the Phase 14 / 23 suites)
// ---------------------------------------------------------------------------
const MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/video-url.ts",
  "src/lib/upload-error-text.ts",
  "src/lib/media.ts",
  "src/lib/media-s3.ts",
  "src/lib/env.ts",
  "src/lib/storage-quotas.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/enrollment.ts",
  "src/lib/parent-access.ts",
  "src/lib/session-materials.ts",
  "src/lib/media-upload.ts",
  "src/lib/db-serialization.ts",
  "src/lib/direct-upload.ts",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "es2020",
        module: "commonjs",
        moduleResolution: "node",
        strict: true,
        noImplicitAny: false,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")],
        baseUrl: REPO,
        paths: { "@/*": ["src/*"] },
        rootDir: REPO,
        outDir: OUT,
        lib: ["es2020", "dom"],
      },
      files: MODULES.map((f) => path.join(REPO, f)),
    },
    null,
    2
  )
);
execFileSync(
  process.execPath,
  [path.join(REPO, "node_modules", "typescript", "lib", "tsc.js"), "-p", path.join(OUT, "tsconfig.json")],
  { cwd: REPO, stdio: "pipe" }
);
const EMIT = path.join(OUT, "src", "lib");

// Injectable fake Prisma — never the real client or engine.
const FAKE_DB_PATH = path.join(OUT, "fake-db.js");
fs.writeFileSync(
  FAKE_DB_PATH,
  `module.exports = { db: {
    batch: { findUnique: async () => ({ id: "b1", isActive: true, archivedAt: null, courseId: "c1" }) },
    course: { findUnique: async () => ({ id: "c1", isActive: true, archivedAt: null }) },
    lesson: { findUnique: async () => ({ id: "l1", isActive: true, archivedAt: null, batchId: "b1" }) },
    mediaAsset: { findFirst: async () => null },
  } };`
);

const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "@/lib/db") return FAKE_DB_PATH;
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return originalResolveFilename.call(this, request, ...args);
};

const SECRET = "a".repeat(64); // hex-shaped test secret for SECURITY_HASH_SECRET
process.env.SECURITY_HASH_SECRET = SECRET;

const {
  normalizeExternalVideoUrl,
  resolveExternalVideoPlayback,
  isPlayableExternalVideoUrl,
  isSafeMediaHost,
} = require(path.join(EMIT, "video-url.js"));
const { uploadErrorCodeKey, isUploadCodeRetriable } = require(
  path.join(EMIT, "upload-error-text.js")
);
const { isSafeExternalUrl } = require(path.join(EMIT, "media.js"));

// ===========================================================================
section("1. External video URL contract — what the player can actually render");
// ===========================================================================

// --- ACCEPTED: direct media files ------------------------------------------
const directAccepted = [
  "https://cdn.example.com/lesson.mp4",
  "https://cdn.example.com/a/b/c/lesson.WEBM",
  "https://cdn.example.com/lesson.ogg",
  "https://cdn.example.com/lesson.ogv",
  "https://cdn.example.com/lesson.mov",
  // A signed CDN link: query string must not defeat the extension check.
  "https://cdn.example.com/lesson.mp4?sig=abc123&exp=999",
];
for (const url of directAccepted) {
  const r = normalizeExternalVideoUrl(url);
  ok(r.ok === true, `accepts direct media URL: ${url}`);
  if (r.ok) eq(r.kind, "DIRECT", `kind DIRECT for ${url}`);
}

// --- ACCEPTED: YouTube, normalised to the privacy-enhanced embed -----------
const youtubeCases = [
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  // Extra share params must not break id extraction.
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "dQw4w9WgXcQ"],
  ["https://youtu.be/dQw4w9WgXcQ?si=XYZ", "dQw4w9WgXcQ"],
];
for (const [input, id] of youtubeCases) {
  const r = normalizeExternalVideoUrl(input);
  ok(r.ok === true, `accepts YouTube URL: ${input}`);
  if (r.ok) {
    eq(r.kind, "YOUTUBE", `kind YOUTUBE for ${input}`);
    eq(r.url, `https://www.youtube-nocookie.com/embed/${id}`, `canonical embed for ${input}`);
  }
}

// --- ACCEPTED: Vimeo, normalised to the player embed -----------------------
const vimeoCases = [
  ["https://vimeo.com/76979871", "76979871"],
  ["https://www.vimeo.com/76979871", "76979871"],
  ["https://player.vimeo.com/video/76979871", "76979871"],
  ["https://vimeo.com/channels/staffpicks/76979871", "76979871"],
];
for (const [input, id] of vimeoCases) {
  const r = normalizeExternalVideoUrl(input);
  ok(r.ok === true, `accepts Vimeo URL: ${input}`);
  if (r.ok) {
    eq(r.kind, "VIMEO", `kind VIMEO for ${input}`);
    eq(r.url, `https://player.vimeo.com/video/${id}`, `canonical embed for ${input}`);
  }
}

// ===========================================================================
section("2. External video URL contract — what is REJECTED before publishing");
// ===========================================================================

const rejected = [
  // The exact production failure mode: a watch URL is an HTML page.
  ["https://drive.google.com/file/d/1abc/view", "UNSUPPORTED_PROVIDER"],
  ["https://docs.google.com/presentation/d/1abc/edit", "UNSUPPORTED_PROVIDER"],
  ["https://example.com/some/page", "UNSUPPORTED_PROVIDER"],
  ["https://example.com/", "UNSUPPORTED_PROVIDER"],
  ["https://example.com/video.php?id=7", "UNSUPPORTED_PROVIDER"],
  ["https://example.com/lesson.exe", "UNSUPPORTED_PROVIDER"],
  // A YouTube host with no usable video id is NOT a video.
  ["https://www.youtube.com/@channel", "UNSUPPORTED_PROVIDER"],
  ["https://www.youtube.com/playlist?list=PLabc", "UNSUPPORTED_PROVIDER"],
  ["https://www.youtube.com/results?search_query=foo", "UNSUPPORTED_PROVIDER"],
  ["https://vimeo.com/watchlater", "UNSUPPORTED_PROVIDER"],
  // Mixed content: an HSTS origin cannot play http media.
  ["http://cdn.example.com/lesson.mp4", "INSECURE_PROTOCOL"],
  ["ftp://cdn.example.com/lesson.mp4", "INSECURE_PROTOCOL"],
  // `javascript:` parses as a real URL whose protocol is not https:, so it is
  // refused on protocol — the important part is that it is refused at all and
  // can never reach an <iframe src> or a <video src>.
  ["javascript:alert(1)", "INSECURE_PROTOCOL"],
  ["data:text/html,<script>alert(1)</script>", "INSECURE_PROTOCOL"],
  ["", "MALFORMED"],
  ["   ", "MALFORMED"],
  ["not a url at all", "MALFORMED"],
  ["lesson.mp4", "MALFORMED"],
  // SSRF-shaped hosts.
  ["https://localhost/lesson.mp4", "UNSAFE_HOST"],
  ["https://127.0.0.1/lesson.mp4", "UNSAFE_HOST"],
  ["https://10.0.0.5/lesson.mp4", "UNSAFE_HOST"],
  ["https://192.168.1.5/lesson.mp4", "UNSAFE_HOST"],
  ["https://172.16.0.5/lesson.mp4", "UNSAFE_HOST"],
  ["https://intranet.local/lesson.mp4", "UNSAFE_HOST"],
  ["https://169.254.169.254/latest/meta-data", "UNSAFE_HOST"],
];
for (const [input, code] of rejected) {
  const r = normalizeExternalVideoUrl(input);
  ok(r.ok === false, `rejects ${JSON.stringify(input)}`);
  if (!r.ok) eq(r.code, code, `rejection code for ${JSON.stringify(input)}`);
  ok(isPlayableExternalVideoUrl(input) === false, `isPlayable false for ${JSON.stringify(input)}`);
}

// Non-string input fails closed rather than throwing.
for (const bad of [null, undefined, 42, {}, [], true]) {
  const r = normalizeExternalVideoUrl(bad);
  ok(r.ok === false && r.code === "MALFORMED", `non-string rejected: ${JSON.stringify(bad)}`);
}

// ===========================================================================
section("3. Student render mode is derived from the stored URL");
// ===========================================================================

eq(
  resolveExternalVideoPlayback("https://cdn.example.com/lesson.mp4"),
  { mode: "video", src: "https://cdn.example.com/lesson.mp4" },
  "direct file renders as <video>"
);
eq(
  resolveExternalVideoPlayback("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
  {
    mode: "iframe",
    src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    title: "YOUTUBE",
  },
  "a legacy stored YouTube WATCH url renders as <iframe> (no migration needed)"
);
eq(
  resolveExternalVideoPlayback("https://vimeo.com/76979871"),
  { mode: "iframe", src: "https://player.vimeo.com/video/76979871", title: "VIMEO" },
  "a legacy stored Vimeo url renders as <iframe>"
);
eq(
  resolveExternalVideoPlayback("https://drive.google.com/file/d/1abc/view"),
  null,
  "an unplayable stored URL yields null (explicit message, not a black player)"
);
eq(resolveExternalVideoPlayback(null), null, "null src yields null");

// ===========================================================================
section("4. SSRF host guard — one definition shared by server and client");
// ===========================================================================

for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "x.local", "169.254.169.254", ""]) {
  ok(isSafeMediaHost(host) === false, `isSafeMediaHost rejects ${JSON.stringify(host)}`);
}
for (const host of ["cdn.example.com", "www.youtube.com", "player.vimeo.com"]) {
  ok(isSafeMediaHost(host) === true, `isSafeMediaHost allows ${host}`);
}
// The generic fetch guard in media.ts must now agree with the contract module.
ok(isSafeExternalUrl("https://cdn.example.com/a.mp4") === true, "isSafeExternalUrl allows a public https URL");
ok(isSafeExternalUrl("http://cdn.example.com/a.mp4") === false, "isSafeExternalUrl rejects http (mixed content)");
ok(isSafeExternalUrl("https://127.0.0.1/a.mp4") === false, "isSafeExternalUrl rejects loopback");

// ===========================================================================
section("5. DEFECT 1 REGRESSION — init response shape vs the browser helper");
// ===========================================================================

const { initPresignedUpload } = require(path.join(EMIT, "media-upload.js"));
const { directUpload } = require(path.join(EMIT, "direct-upload.js"));

const fakeBackend = {
  createPresignedPutUrl: async ({ key, contentType, expiresInSec }) => ({
    url: `https://r2.invalid/${key}?X-Amz-Signature=deadbeef`,
    method: "PUT",
    key,
    contentType,
    expiresInSec,
    expiresAt: new Date(Date.now() + expiresInSec * 1000),
  }),
};

/**
 * Drive the REAL client against the REAL server response.
 * `wire` is exactly what `ok(result.init)` puts on the wire.
 */
async function runFlow(purpose, initFields, completeFields, wire, { status = 200 } = {}) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/media-uploads/init")) {
      return { ok: status < 400, status, json: async () => wire };
    }
    if (u.startsWith("https://r2.invalid/")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (u.endsWith("/media-uploads/complete")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, mediaAssetId: "ma_1" }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const out = await directUpload({
    purpose,
    file: { name: purpose === "LESSON_PDF" ? "notes.pdf" : "lesson.mp4", size: 1024, type: purpose === "LESSON_PDF" ? "application/pdf" : "video/mp4" },
    initFields,
    completeFields,
    sha256: null,
  });
  return { out, calls };
}

// 5a. The documented top-level contract (what the endpoint really returns).
async function main() {
{
  process.env.MEDIA_BACKEND = "s3";
  const res = await initPresignedUpload(
    {
      purpose: "SESSION_VIDEO",
      actorUserId: "admin-1",
      sizeBytes: 1024,
      contentType: "video/mp4",
      fileName: "lesson.mp4",
      batchId: "b1",
    },
    { backend: fakeBackend, hmacSecret: SECRET }
  );
  ok(res.ok === true, "server issues a presigned grant");
  const wire = JSON.parse(JSON.stringify(res.init));

  // The grant MUST be at the top level — this is the shape the client parses.
  ok(typeof wire.uploadUrl === "string" && wire.uploadUrl.length > 0, "wire carries uploadUrl at top level");
  ok(typeof wire.token === "string" && wire.token.length > 0, "wire carries token at top level");
  ok(!("upload" in wire), "wire does NOT nest the grant under 'upload'");

  const { out, calls } = await runFlow("SESSION_VIDEO", { batchId: "b1" }, { batchId: "b1", title: "L", publish: true }, wire);
  ok(out.ok === true, "VIDEO upload completes end-to-end over the real client (was: init-stage failure)");
  ok(
    calls.some((c) => c.startsWith("https://r2.invalid/")),
    "bytes were PUT straight to the presigned URL"
  );
  ok(
    calls.some((c) => c.endsWith("/media-uploads/complete")),
    "completion leg was called"
  );
  if (!out.ok) console.error("   → outcome:", JSON.stringify(out));
}

// 5b. Same, for the PDF purpose that failed with the identical message.
{
  const wire = {
    uploadUrl: "https://r2.invalid/session-pdfs/x-abc.pdf?X-Amz-Signature=deadbeef",
    method: "PUT",
    token: "payload.mac",
    contentType: "application/pdf",
    maxBytes: 26214400,
    expiresInSec: 600,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    purpose: "LESSON_PDF",
  };
  const { out } = await runFlow("LESSON_PDF", { lessonId: "l1" }, { lessonId: "l1" }, wire);
  ok(out.ok === true, "PDF upload completes end-to-end over the real client (was: init-stage failure)");
}

// 5c. Forward-compatibility: a namespaced `upload` payload must also work.
{
  const wire = {
    upload: {
      uploadUrl: "https://r2.invalid/session-videos/x-abc.mp4?X-Amz-Signature=deadbeef",
      method: "PUT",
      token: "payload.mac",
      contentType: "video/mp4",
      maxBytes: 536870912,
      expiresInSec: 600,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      purpose: "SESSION_VIDEO",
    },
  };
  const { out } = await runFlow("SESSION_VIDEO", { batchId: "b1" }, { batchId: "b1", title: "L" }, wire);
  ok(out.ok === true, "a nested {upload:{...}} payload is also accepted");
}

// 5d. A genuinely malformed grant must still fail closed, not throw.
{
  for (const wire of [{}, { uploadUrl: "https://r2.invalid/x" }, { token: "t" }, { uploadUrl: "", token: "" }]) {
    const { out } = await runFlow("SESSION_VIDEO", { batchId: "b1" }, {}, wire);
    ok(out.ok === false && out.stage === "init", `malformed grant rejected: ${JSON.stringify(wire)}`);
  }
}

// 5e. The local-backend fallback path must be preserved unchanged.
{
  const { out } = await runFlow(
    "SESSION_VIDEO",
    { batchId: "b1" },
    {},
    { error: "Direct uploads are not available for the active storage backend", code: "PRESIGNED_UNSUPPORTED" },
    { status: 409 }
  );
  ok(out.ok === false, "local backend: init is refused");
  eq(out.code, "PRESIGNED_UNSUPPORTED", "local backend: code lets the client fall back to the buffered path");
}

// ===========================================================================
section("6. Admin error UX — a specific reason per failure code");
// ===========================================================================

eq(uploadErrorCodeKey("INVALID_CONTENT_TYPE"), "admin.534", "unsupported file type → admin.534");
eq(uploadErrorCodeKey("INVALID_SIZE"), "admin.535", "file too large → admin.535");
eq(uploadErrorCodeKey("QUOTA_EXCEEDED"), "admin.535", "quota exceeded → admin.535");
eq(uploadErrorCodeKey("STORAGE_UNAVAILABLE"), "admin.536", "storage down → admin.536");
eq(uploadErrorCodeKey("DB_UNAVAILABLE"), "admin.536", "db down → admin.536");
eq(uploadErrorCodeKey("LESSON_NOT_FOUND"), "admin.537", "wrong session → admin.537");
eq(uploadErrorCodeKey("BATCH_NOT_FOUND"), "admin.537", "wrong group → admin.537");
eq(uploadErrorCodeKey("SOMETHING_NEW"), null, "unknown code → null (caller falls back to stage text)");
eq(uploadErrorCodeKey(null), null, "null code → null");
ok(isUploadCodeRetriable("STORAGE_UNAVAILABLE") === true, "storage failure is retriable");
ok(isUploadCodeRetriable("INVALID_CONTENT_TYPE") === false, "a bad file type is NOT retriable (retrying cannot help)");

// Every referenced key must exist in the dictionary, so no admin ever sees a
// raw key or an empty toast.
{
  const dict = read("src/lib/i18n-dict-2026.ts");
  for (const key of ["admin.534", "admin.535", "admin.536", "admin.537", "admin.538", "api.303", "api.304", "api.305", "course.226", "course.227", "admin.506", "admin.507", "admin.508"]) {
    ok(dict.includes(`"${key}"`), `dictionary defines ${key}`);
  }
  // No key may be defined twice — a duplicate silently shadows the earlier one.
  const keys = [...dict.matchAll(/"(api|admin|course)\.\d+"/g)].map((m) => m[0]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  eq([...new Set(dupes)], [], "no duplicate dictionary keys");
}

// ===========================================================================
section("7. Source pins — the fixes stay wired into the real endpoints");
// ===========================================================================

{
  const route = read("src/app/api/admin/session-videos/route.ts");
  ok(route.includes("normalizeExternalVideoUrl"), "session-videos POST validates the external URL contract");
  ok(!route.includes("isSafeExternalUrl(externalUrl"), "session-videos POST no longer accepts any http(s) URL");
  ok(route.includes("externalUrl: external.url"), "the CANONICAL url is stored, not the raw pasted link");
  ok(route.includes("api.305"), "an unsupported provider gets a distinct admin error");
}
{
  const player = read("src/components/course/session-videos-view.tsx");
  ok(player.includes("resolveExternalVideoPlayback"), "student player derives the render mode from the URL");
  ok(player.includes('playback?.mode === "iframe"'), "student player can render an embed");
  ok(player.includes("course.226"), "an unplayable URL shows an explicit message");
  ok(player.includes("trackable"), "watch progress is only claimed where a playhead exists");
}
{
  const client = read("src/lib/direct-upload.ts");
  ok(client.includes("extractUploadGrant"), "the browser helper parses the grant via the shared extractor");
  ok(!/init\.data\.upload\b/.test(client), "the browser helper no longer reads the non-existent body.upload");
}
{
  // Both admin upload surfaces go through ONE state machine and ONE failure
  // resolver, so a video upload and a PDF upload can never drift apart. The
  // code → specific-reason map itself is defined once (upload-error-text.ts)
  // and is what the resolver consults — the components no longer duplicate it.
  for (const f of ["src/components/admin/session-videos-view.tsx", "src/components/admin/session-pdf-manager.tsx"]) {
    const s = read(f);
    ok(s.includes("useMediaUpload"), `${f} drives uploads through the shared upload state machine`);
    ok(s.includes("UploadProgressPanel"), `${f} renders the shared upload progress panel`);
    ok(s.includes("uploadFailureMessage"), `${f} presents failures through the shared stage/code resolver`);
  }
  const errText = read("src/lib/upload-error-text.ts");
  ok(/const reasonKey = uploadErrorCodeKey\(code\)/.test(errText),
    "resolveUploadFailure consults the single code → specific-reason map");
  ok(/export function uploadFailureMessage/.test(errText),
    "the resolver renders ONE message shape for every admin surface");
  const hook = read("src/hooks/use-media-upload.ts");
  ok(/resolveUploadFailure\(/.test(hook), "the shared hook resolves every failure through the resolver");
  ok(/^"use client";/m.test(hook), "the upload hook stays inside the client boundary");
}
{
  const csp = read("src/lib/content-security-policy.ts");
  ok(csp.includes("youtube-nocookie.com"), "CSP frame-src permits the YouTube privacy-enhanced embed");
  ok(csp.includes("player.vimeo.com"), "CSP frame-src permits the Vimeo player embed");
}

// ===========================================================================
console.log("\n" + "=".repeat(60));
console.log(`Session media audit suite: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
}

// Top-level await is not available in CommonJS, so the async sections run
// inside main(); nothing below it executes before the suite has finished.
main().catch((e) => {
  console.error("\nSuite crashed:", e);
  process.exit(1);
});
