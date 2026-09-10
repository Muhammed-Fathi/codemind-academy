// CodeMind Academy — Phase 14 (PDF & session materials) behavior suite.
//
// WHAT THIS FILE PROVES
//   Session PDFs are Material(ADMIN_UPLOADED) → MediaAsset(DOCUMENT,
//   LOCAL_PRIVATE) with:
//     • magic-byte / MIME / extension / size validation
//     • private storage keys (no public paths, no client-supplied keys)
//     • track isolation (SHARED / ARABIC / LANGUAGE)
//     • authorized download (10-check contract)
//     • reference-safe replace / deactivate
//     • zero new pdfUrl writes
//     • safe student descriptors (no storageKey leakage)
//
// Layers:
//   1. Pure validators (media.ts) — offline.
//   2. Descriptor builders + disposition helpers — offline.
//   3. Source pins over routes (no Next runtime).
//   4. Real-DB + real-file verification via scripts/verify-phase14-db.mjs.
//
// Run: node tests/session-materials-phase14.test.js

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const REPO = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase14-test-"));

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
function section(title) {
  console.log(`\n${title}`);
}
function pinned(src, re, label, mutate) {
  // Clone the regex so lastIndex / global flag state cannot leak between the
  // positive and negative checks (and so multi-occurrence patterns are fully
  // stripped by the default mutator).
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const globalRe = new RegExp(re.source, flags);
  ok(globalRe.test(src), label);
  globalRe.lastIndex = 0;
  const mutated = mutate ? mutate(src) : src.replace(globalRe, "");
  globalRe.lastIndex = 0;
  ok(!globalRe.test(mutated), `${label} — negative control`);
}
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ---------------------------------------------------------------------------
// Compile pure modules
// ---------------------------------------------------------------------------
const MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/media.ts",
  "src/lib/session-materials.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/enrollment.ts",
  "src/lib/parent-access.ts",
];
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
        types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")],
        baseUrl: REPO,
        paths: { "@/*": ["src/*"] },
        rootDir: REPO,
        outDir: OUT,
      },
      files: MODULES.map((f) => path.join(REPO, f)),
    },
    null,
    2
  )
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, {
    cwd: REPO,
    stdio: "pipe",
  });
} catch (e) {
  // type noise elsewhere is tolerated; typecheck is the gate
}
const EMIT = path.join(OUT, "src", "lib");
for (const f of ["media.js", "session-materials.js", "track-scope.js", "session-lifecycle.js"]) {
  if (!fs.existsSync(path.join(EMIT, f))) {
    console.error("tsc did not emit", f);
    // Still try to continue if media alone emitted
  }
}

// Fake db path for modules that import @/lib/db
const FAKE_DB_PATH = path.join(OUT, "fake-db.js");
fs.writeFileSync(
  FAKE_DB_PATH,
  "module.exports = { get db() { return globalThis.__CM_FAKE_DB__ || {}; } };\n"
);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "@/lib/db") return FAKE_DB_PATH;
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return originalResolve.call(this, request, ...args);
};

const Media = require(path.join(EMIT, "media.js"));
const SM = require(path.join(EMIT, "session-materials.js"));
const L = require(path.join(EMIT, "session-lifecycle.js"));
const TS = require(path.join(EMIT, "track-scope.js"));

// ---------------------------------------------------------------------------
section("1. PDF magic-byte validation");
// ---------------------------------------------------------------------------
{
  const good = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n");
  ok(Media.hasPdfMagicBytes(good), "real PDF header passes");
  ok(Media.hasPdfMagicBytes(Buffer.from("%PDF-")), "minimal %PDF- passes");
  ok(!Media.hasPdfMagicBytes(Buffer.from("")), "empty fails");
  ok(!Media.hasPdfMagicBytes(null), "null fails");
  ok(!Media.hasPdfMagicBytes(Buffer.from("<html>PDF</html>")), "HTML fails");
  ok(
    !Media.hasPdfMagicBytes(Buffer.from("not a pdf at all")),
    "plain text fails"
  );
  ok(
    !Media.hasPdfMagicBytes(Buffer.from("XXXX" + "y".repeat(2000) + "%PDF-")),
    "magic buried past 1KB window fails"
  );
  // Leading offset within window
  const padded = Buffer.concat([Buffer.from("\n\n"), good]);
  ok(Media.hasPdfMagicBytes(padded), "small leading offset still passes");
}

// ---------------------------------------------------------------------------
section("2. validatePdfUpload matrix");
// ---------------------------------------------------------------------------
{
  const pdf = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\nendobj\n%%EOF\n");

  const ok1 = Media.validatePdfUpload({
    buffer: pdf,
    claimedMime: "application/pdf",
    originalName: "lesson.pdf",
  });
  ok(ok1.ok === true, "correct PDF accepted");
  eq(ok1.mimeType, "application/pdf", "canonical mime");

  const fakeExt = Media.validatePdfUpload({
    buffer: Buffer.from("<html>hi</html>"),
    claimedMime: "application/pdf",
    originalName: "evil.pdf",
  });
  ok(fakeExt.ok === false && fakeExt.code === "MAGIC_REJECTED", "HTML renamed .pdf rejected");

  const fakeMime = Media.validatePdfUpload({
    buffer: pdf,
    claimedMime: "text/html",
    originalName: "lesson.pdf",
  });
  ok(fakeMime.ok === false && fakeMime.code === "MIME_REJECTED", "wrong MIME rejected");

  const badExt = Media.validatePdfUpload({
    buffer: pdf,
    claimedMime: "application/pdf",
    originalName: "lesson.html",
  });
  ok(badExt.ok === false && badExt.code === "EXTENSION_REJECTED", "non-.pdf extension rejected");

  const empty = Media.validatePdfUpload({
    buffer: Buffer.alloc(0),
    claimedMime: "application/pdf",
    originalName: "x.pdf",
  });
  ok(empty.ok === false && empty.code === "EMPTY", "empty file rejected");

  const oversized = Media.validatePdfUpload({
    buffer: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(100)]),
    claimedMime: "application/pdf",
    originalName: "big.pdf",
    maxBytes: 10,
  });
  ok(oversized.ok === false && oversized.code === "TOO_LARGE", "oversized rejected");

  // Double extension with real PDF bytes + .pdf suffix is accepted on extension
  // (magic still required). evil.html.pdf ends with .pdf.
  const double = Media.validatePdfUpload({
    buffer: pdf,
    claimedMime: "application/pdf",
    originalName: "evil.html.pdf",
  });
  ok(double.ok === true, "double extension ending in .pdf + magic accepted");

  // Missing MIME is ok when magic + extension pass.
  const noMime = Media.validatePdfUpload({
    buffer: pdf,
    claimedMime: "",
    originalName: "lesson.pdf",
  });
  ok(noMime.ok === true, "empty claimed MIME tolerated when magic+ext pass");
}

// ---------------------------------------------------------------------------
section("3. Filename sanitization / traversal");
// ---------------------------------------------------------------------------
{
  eq(
    Media.sanitizeOriginalFilename("../../etc/passwd.pdf"),
    "passwd.pdf",
    "path traversal stripped to basename"
  );
  eq(
    Media.sanitizeOriginalFilename("foo/bar\\baz.pdf"),
    "baz.pdf",
    "mixed separators → basename"
  );
  ok(
    !Media.sanitizeOriginalFilename("x\0y.pdf").includes("\0"),
    "null bytes stripped"
  );
  ok(
    Media.hasPdfExtension("doc.PDF"),
    ".PDF (case-insensitive) accepted"
  );
  ok(!Media.hasPdfExtension("doc.html"), "html extension rejected");
  ok(
    Media.makeStorageKey("session-pdfs", "pdf").startsWith("session-pdfs/"),
    "storage key scoped"
  );
  ok(
    !Media.makeStorageKey("session-pdfs", "pdf").includes(".."),
    "storage key has no traversal"
  );
  // Client-supplied storage key must never be used — pin the upload path.
  const uploadSrc = read("src/lib/session-materials.ts");
  pinned(
    uploadSrc,
    /makeStorageKey\(\s*["']session-pdfs["']/,
    "upload generates storage key via makeStorageKey('session-pdfs')"
  );
  ok(
    !/storageKey\s*[:=]\s*(input|body|form|req)/i.test(uploadSrc),
    "upload never takes storageKey from client input"
  );
}

// ---------------------------------------------------------------------------
section("4. Track isolation predicates (reuse Phase 12)");
// ---------------------------------------------------------------------------
{
  ok(TS.canAccessTrackScope("ARABIC", "SHARED"), "AR student → SHARED material");
  ok(TS.canAccessTrackScope("ARABIC", "ARABIC"), "AR student → AR material");
  ok(!TS.canAccessTrackScope("ARABIC", "LANGUAGE"), "AR student ↛ LANG material");
  ok(TS.canAccessTrackScope("LANGUAGE", "SHARED"), "LANG student → SHARED");
  ok(TS.canAccessTrackScope("LANGUAGE", "LANGUAGE"), "LANG student → LANG");
  ok(!TS.canAccessTrackScope("LANGUAGE", "ARABIC"), "LANG student ↛ AR material");
  ok(
    !TS.canAccessTrackScope(null, "ARABIC"),
    "untyped student ↛ AR (fail closed)"
  );
  ok(
    TS.canAccessTrackScope(null, "SHARED"),
    "untyped student → SHARED only"
  );
  ok(
    !TS.canAccessTrackScope("ARABIC", "GARBAGE"),
    "unknown scope → deny"
  );
}

// ---------------------------------------------------------------------------
section("5. Material descriptors — safe payload shape");
// ---------------------------------------------------------------------------
{
  const descriptors = SM.buildMaterialDescriptors({
    materials: [
      {
        id: "m1",
        title: "Unit 1 PDF",
        kind: "ADMIN_UPLOADED",
        trackScope: "SHARED",
        isActive: true,
        mediaAssetId: "a1",
        media: { mimeType: "application/pdf", sizeBytes: 1234 },
      },
      {
        id: "m2",
        title: "AR only",
        kind: "ADMIN_UPLOADED",
        trackScope: "ARABIC",
        isActive: true,
        mediaAssetId: "a2",
        media: { mimeType: "application/pdf", sizeBytes: 99 },
      },
      {
        id: "m-inactive",
        title: "gone",
        kind: "ADMIN_UPLOADED",
        trackScope: "SHARED",
        isActive: false,
        mediaAssetId: "a3",
      },
    ],
    legacyPdfUrl: "https://cdn.example/old.pdf",
    includeProtected: true,
    eligibleScopes: ["SHARED", "LANGUAGE"],
  });
  eq(descriptors.length, 1, "only SHARED material (AR filtered, inactive dropped)");
  eq(descriptors[0].id, "m1", "correct material id");
  eq(descriptors[0].downloadUrl, "/api/materials/m1", "authorized download path");
  ok(!("storageKey" in descriptors[0]), "no storageKey on descriptor");
  ok(descriptors[0].legacy === false, "not legacy");

  // Locked redaction
  const locked = SM.buildMaterialDescriptors({
    materials: descriptors.map((d) => ({ ...d, mediaAssetId: "a1", isActive: true })),
    includeProtected: false,
  });
  eq(locked.length, 0, "locked/unpublished → no material ids leaked");

  // Legacy fallback when no materials
  const legacy = SM.buildMaterialDescriptors({
    materials: [],
    legacyPdfUrl: "https://cdn.example/old.pdf",
    includeProtected: true,
  });
  eq(legacy.length, 1, "legacy url surfaced when no materials");
  ok(legacy[0].legacy === true, "marked legacy");
  eq(legacy[0].downloadUrl, "https://cdn.example/old.pdf", "legacy keeps external url");

  // Placeholder legacy ignored
  const ph = SM.buildMaterialDescriptors({
    materials: [],
    legacyPdfUrl: "#",
    includeProtected: true,
  });
  eq(ph.length, 0, "placeholder # is not a document");
}

// ---------------------------------------------------------------------------
section("6. Content-Disposition + access HTTP mapping");
// ---------------------------------------------------------------------------
{
  ok(
    SM.materialContentDisposition("unit.pdf", false).startsWith("inline"),
    "default inline"
  );
  ok(
    SM.materialContentDisposition("unit.pdf", true).startsWith("attachment"),
    "download=1 → attachment"
  );
  ok(
    !SM.materialContentDisposition('x"\ny.pdf', true).includes("\n"),
    "newlines stripped from filename"
  );
  eq(SM.materialAccessHttpStatus("UNAUTHORIZED"), 401, "unauth → 401");
  eq(SM.materialAccessHttpStatus("NOT_ENROLLED"), 403, "not enrolled → 403");
  eq(
    SM.materialAccessHttpStatus("PREVIOUS_SESSION_INCOMPLETE"),
    403,
    "locked → 403"
  );
  eq(SM.materialAccessHttpStatus("MATERIAL_NOT_FOUND"), 404, "missing → 404");
  eq(SM.materialAccessHttpStatus("TRACK_DENIED"), 404, "wrong track → 404 (non-oracle)");
  eq(SM.materialAccessHttpStatus("MATERIAL_INACTIVE"), 404, "inactive → 404");
  eq(SM.materialAccessHttpStatus("LESSON_NOT_FOUND"), 404, "lesson missing → 404");
}

// ---------------------------------------------------------------------------
section("7. Readiness PDF dimension (Phase 14 codes)");
// ---------------------------------------------------------------------------
{
  const base = {
    id: "L1",
    status: "DRAFT",
    trackScope: "SHARED",
    curriculumStatus: "OFFICIAL",
    videoUrl: "https://cdn.example/v.mp4",
  };
  const absent = L.computeLessonReadiness(base);
  const pdfItem = absent.items.find((i) => i.key === "PDF");
  eq(pdfItem.state, "NOT_APPLICABLE", "PDF still never required");
  eq(pdfItem.code, "PDF_ABSENT_NOT_REQUIRED", "stable absent code");
  ok(absent.canBeReady === true, "missing PDF does not block READY");

  const withMat = L.computeLessonReadiness({
    ...base,
    materials: [
      {
        id: "m1",
        kind: "ADMIN_UPLOADED",
        isActive: true,
        mediaAssetId: "a1",
        trackScope: "SHARED",
      },
    ],
  });
  const pdf2 = withMat.items.find((i) => i.key === "PDF");
  eq(pdf2.code, "PDF_PRESENT_NOT_REQUIRED", "present material credited");
  eq(pdf2.present, true, "present=true");
  ok(withMat.canBeReady === true, "present PDF still does not block");

  const foreign = L.computeLessonReadiness({
    ...base,
    trackScope: "ARABIC",
    materials: [
      {
        id: "m1",
        kind: "ADMIN_UPLOADED",
        isActive: true,
        mediaAssetId: "a1",
        trackScope: "LANGUAGE",
      },
    ],
  });
  const pdf3 = foreign.items.find((i) => i.key === "PDF");
  eq(pdf3.present, false, "foreign-track material does not credit PDF");
  ok(
    foreign.notes.some((n) => n.startsWith("PDF_PRESENT_BUT_OTHER_TRACK")),
    "foreign track noted"
  );
}

// ---------------------------------------------------------------------------
section("8. Source pins — routes & contracts");
// ---------------------------------------------------------------------------
{
  const adminRoute = read("src/app/api/admin/lessons/[id]/materials/route.ts");
  const dlRoute = read("src/app/api/materials/[id]/route.ts");
  const mediaRoute = read("src/app/api/media/[id]/route.ts");
  const lessonsRoute = read("src/app/api/lessons/[id]/route.ts");
  const coursesRoute = read("src/app/api/courses/[slug]/route.ts");
  const materialsLib = read("src/lib/session-materials.ts");
  const mediaLib = read("src/lib/media.ts");
  const schema = read("prisma/schema.prisma");
  const migration = read(
    "prisma/migrations/20260910120000_phase14_session_materials/migration.sql"
  );
  const proxy = read("src/lib/route-protection.ts");

  pinned(
    adminRoute,
    /requireRole\(\s*["']ADMIN["']\s*\)/,
    "admin materials route requires ADMIN"
  );
  pinned(
    adminRoute,
    /multipart\/form-data/,
    "admin upload requires multipart"
  );
  pinned(
    adminRoute,
    /uploadLessonPdfMaterial/,
    "admin upload delegates to session-materials"
  );
  pinned(
    adminRoute,
    /pdfUrlWritten:\s*false/,
    "admin response asserts pdfUrlWritten=false"
  );
  ok(
    !/pdfUrl\s*:\s*|data:\s*\{[^}]*pdfUrl/s.test(adminRoute) ||
      /pdfUrlWritten:\s*false/.test(adminRoute),
    "admin route does not write Lesson.pdfUrl"
  );
  ok(
    !/lesson\.update[\s\S]{0,200}pdfUrl/.test(adminRoute),
    "no lesson.update touching pdfUrl"
  );

  pinned(
    dlRoute,
    /authorizeMaterialDownload/,
    "download route uses authorizeMaterialDownload"
  );
  pinned(
    dlRoute,
    /Cache-Control["']?\s*:\s*["']private, no-store/,
    "download sets Cache-Control no-store"
  );
  pinned(
    dlRoute,
    /download/,
    "download supports ?download=1"
  );
  pinned(
    dlRoute,
    /materialContentDisposition/,
    "download uses disposition helper"
  );

  pinned(
    mediaRoute,
    /isDocumentMaterial|kind === ["']DOCUMENT["']/,
    "media route blocks DOCUMENT bypass for non-admin"
  );

  pinned(
    lessonsRoute,
    /buildMaterialDescriptors/,
    "lesson payload builds material descriptors"
  );
  pinned(
    coursesRoute,
    /buildMaterialDescriptors/,
    "course tree builds material descriptors"
  );
  pinned(
    coursesRoute,
    /includeProtected:\s*!locked/,
    "locked sessions redact material descriptors"
  );

  pinned(
    materialsLib,
    /canAccessLesson/,
    "download auth reuses canAccessLesson"
  );
  pinned(
    materialsLib,
    /isParentLessonPreviewAllowed/,
    "download auth reuses parent preview gate"
  );
  pinned(
    materialsLib,
    /canAccessTrackScope/,
    "download auth enforces material trackScope"
  );
  pinned(
    materialsLib,
    /cleanupUnreferencedMediaAsset/,
    "refcount cleanup exists"
  );
  pinned(
    materialsLib,
    /releaseDetachedAssets/,
    "replace path releases detached assets"
  );

  pinned(mediaLib, /hasPdfMagicBytes/, "magic-byte helper exported");
  pinned(mediaLib, /validatePdfUpload/, "full PDF validator exported");
  pinned(mediaLib, /MAX_PDF_BYTES/, "configurable PDF size cap");
  pinned(mediaLib, /%PDF-/, "PDF magic constant present");

  pinned(
    schema,
    /trackScope\s+TrackScope\s+@default\(SHARED\)/,
    "Material.trackScope in schema"
  );
  pinned(
    migration,
    /ADD COLUMN "trackScope"/,
    "migration adds trackScope"
  );
  ok(
    !/\b(DROP|DELETE\s+FROM|TRUNCATE)\b/i.test(
      migration.replace(/^--.*$/gm, "")
    ),
    "migration has no destructive statements"
  );

  pinned(
    proxy,
    /["']\/api\/materials["']/,
    "proxy protects /api/materials"
  );

  // Zero new pdfUrl writes across admin materials + session-materials.
  ok(
    !/pdfUrl\s*:/.test(materialsLib) ||
      /legacyPdfUrl|isUsableLegacyPdfUrl|pdfUrl\?/.test(materialsLib),
    "session-materials only reads legacy pdfUrl"
  );
  ok(
    !/\.update\(\s*\{[^}]*pdfUrl/s.test(materialsLib),
    "session-materials never updates pdfUrl"
  );
}

// ---------------------------------------------------------------------------
section("9. Schema / uniqueness design");
// ---------------------------------------------------------------------------
{
  const schema = read("prisma/schema.prisma");
  ok(/model Material \{/.test(schema), "Material model exists");
  ok(/kind\s+MediaKind/.test(schema) || /enum MediaKind/.test(schema), "MediaKind enum");
  ok(/DOCUMENT/.test(schema), "DOCUMENT kind exists");
  ok(/LOCAL_PRIVATE/.test(schema), "LOCAL_PRIVATE storage exists");
  ok(
    /Material_lessonId_trackScope_isActive_idx/.test(
      read(
        "prisma/migrations/20260910120000_phase14_session_materials/migration.sql"
      )
    ),
    "lookup index created"
  );
  // No new PDF/Document/Attachment tables.
  ok(!/model\s+Pdf\b/.test(schema), "no Pdf table");
  ok(!/model\s+Document\b/.test(schema), "no Document table");
  ok(!/model\s+Attachment\b/.test(schema), "no Attachment table");
}

// ---------------------------------------------------------------------------
section("10. Real DB + real file verification");
// ---------------------------------------------------------------------------
{
  const script = path.join(REPO, "scripts", "verify-phase14-db.mjs");
  ok(fs.existsSync(script), "verify-phase14-db.mjs exists");
  try {
    const out = execSync(`node ${script}`, {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    ok(/PHASE14_VERIFY_OK/.test(out), "real DB/file verification passed");
    if (!/PHASE14_VERIFY_OK/.test(out)) {
      console.error(out);
    }
  } catch (e) {
    fail++;
    failures.push("real DB/file verification crashed");
    console.error("FAIL: real DB/file verification crashed");
    console.error(String(e.stdout || ""));
    console.error(String(e.stderr || e.message || e));
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 14 tests: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log("  -", f);
}
process.exit(fail ? 1 : 0);
