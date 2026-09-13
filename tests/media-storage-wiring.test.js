// CodeMind Academy — R2 APPLICATION WIRING suite (offline).
//
// The R2/S3 storage BACKEND is verified by tests/s3-storage-r2.test.js. This
// suite verifies the WIRING: that the application's media flows treat managed
// private storage as LOCAL_PRIVATE **or** S3, and that nothing else changed.
//
// WHAT IT PROVES
//   1. Repo-wide gate sweep — no read/delete/purge/upload site in src/ still
//      compares `storage` against a single LOCAL_PRIVATE literal; every gate
//      asks the shared `isManagedPrivateStorage` predicate (with negative
//      controls proving the sweep would catch a regression).
//   2. Upload metadata — `MediaAsset.storage` comes from the ACTIVE BACKEND
//      selector: LOCAL_PRIVATE when MEDIA_BACKEND=local/unset, S3 when
//      MEDIA_BACKEND=s3. Never inferred from a key or path.
//   3. Read gates — an S3-backed asset is ACCEPTED by the material 10-check
//      contract and by /api/media, and every pre-existing denial still denies
//      (anonymous, wrong role, foreign batch, EXTERNAL_URL, non-private,
//      missing key, unknown storage value, inactive material).
//   4. Streaming/Range — 200/206/416, Content-Range, Content-Length,
//      Content-Type, Content-Disposition and the cache/security headers are
//      byte-identical under both backends, and a Range request issues a RANGED
//      GET (`Range: bytes=…`) instead of buffering the whole object.
//   5. Delete gates — the object is deleted THROUGH the abstraction BEFORE the
//      MediaAsset row, for both backends; a failing object delete leaves the
//      row (and the bytes) in place so nothing is orphaned silently; a
//      referenced asset is never deleted; EXTERNAL_URL moves no bytes.
//   6. Purge/retention — expired-evidence purge deletes LOCAL_PRIVATE objects
//      from the volume and does NOT silently skip S3 objects (recorded,
//      fail-closed, exit 2 for a retry run).
//   7. No exposure — no route or client component references R2 config, no
//      signed/public URL is produced, and no response leaks the bucket, an
//      object key, or a credential.
//   8. Volume quota stays a LOCAL-volume control and says so under s3 instead
//      of measuring an unrelated directory.
//
// HOW
//   * Static source pins over the shipped files (with negative controls).
//   * Pure functions from the compiled shipped modules (src/lib/media.ts,
//     src/lib/storage-quotas.ts).
//   * Behavioural runs of the compiled shipped modules + route handlers in a
//     child process (tests/helpers/media-storage-wiring-harness.cjs) with an
//     in-memory fake Prisma client and an in-memory fake S3 client injected at
//     the SAME boundary tests/s3-storage-r2.test.js uses.
//   * Real runs of scripts/media/purge-expired-evidence.ts over scratch
//     SQLite databases.
//
// GUARANTEES: no real R2, no credentials, no network at all (the harness makes
// any socket connect throw and reports attempts), no database/schema change.
//
// Run: node tests/media-storage-wiring.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const REPO = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-media-wiring-"));
const LOCAL_ROOT = path.join(OUT, "local-volume");
const S3_ROOT = path.join(OUT, "s3-volume"); // must stay EMPTY in the s3 run
fs.mkdirSync(LOCAL_ROOT, { recursive: true });
fs.mkdirSync(S3_ROOT, { recursive: true });
const TSX_CLI = require.resolve("tsx/cli");

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
/** Positive pin + negative control (the pin must be load-bearing). */
function pinned(src, re, label) {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const globalRe = new RegExp(re.source, flags);
  ok(globalRe.test(src), label);
  globalRe.lastIndex = 0;
  const mutated = src.replace(globalRe, "");
  globalRe.lastIndex = 0;
  ok(!globalRe.test(mutated), `${label} — negative control`);
}

// --- ZERO-NETWORK guard for THIS process (harnesses guard themselves) --------
const networkAttempts = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  networkAttempts.push(JSON.stringify(args[0]));
  throw new Error("media-storage-wiring test attempted a network connection");
};
process.on("exit", () => {
  net.Socket.prototype.connect = realConnect;
});

// ---------------------------------------------------------------------------
// Compile the shipped modules (same pattern as the other offline suites)
// ---------------------------------------------------------------------------
const MODULES = [
  "src/lib/media.ts",
  "src/lib/media-s3.ts",
  "src/lib/storage-quotas.ts",
  "src/lib/session-materials.ts",
  "src/lib/track-scope.ts",
  "src/lib/school-type.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/enrollment.ts",
  "src/lib/parent-access.ts",
  "src/app/api/media/[id]/route.ts",
  "src/app/api/materials/[id]/route.ts",
  "src/app/api/admin/session-videos/[id]/route.ts",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "es2022",
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
// tsc exits non-zero on unrelated type noise produced by THIS harness config
// (the repo's own `npx tsc --noEmit` is the real typecheck gate); it still
// emits, so tolerate the exit code and assert the emit below — the same
// convention tests/session-materials-phase14.test.js uses.
let tscOutput = "";
try {
  execFileSync(
    process.execPath,
    [path.join(REPO, "node_modules", "typescript", "lib", "tsc.js"), "-p", path.join(OUT, "tsconfig.json")],
    { cwd: REPO, stdio: "pipe" }
  );
} catch (e) {
  tscOutput = String((e && e.stdout) || "") + String((e && e.stderr) || "");
}
const EMIT = path.join(OUT, "src");
for (const rel of ["lib/media.js", "lib/session-materials.js", "app/api/media/[id]/route.js", "app/api/materials/[id]/route.js"]) {
  ok(fs.existsSync(path.join(EMIT, rel)), `tsc emitted ${rel}${fs.existsSync(path.join(EMIT, rel)) ? "" : ` — tsc said: ${tscOutput.slice(0, 400)}`}`);
}

// Bare imports (the AWS SDK) and @/lib/* must resolve for the parent process
// too; the harness installs its own richer patch.
process.env.MEDIA_STORAGE_PATH = LOCAL_ROOT;
delete process.env.MEDIA_BACKEND;
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, "lib", `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  try {
    return originalResolve.call(this, request, ...args);
  } catch (err) {
    if (request.startsWith(".") || path.isAbsolute(request)) throw err;
    return require.resolve(request, { paths: [path.join(REPO, "node_modules")] });
  }
};
const Media = require(path.join(EMIT, "lib", "media.js"));
const Quotas = require(path.join(EMIT, "lib", "storage-quotas.js"));

// The exact bytes the harness uploads (kept identical on both sides; the
// sizeBytes assertions below cross-check them).
const PDF_BYTES = Buffer.from(
  "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
);

function runHarness(scenario, env) {
  const out = execFileSync(
    process.execPath,
    [path.join(REPO, "tests", "helpers", "media-storage-wiring-harness.cjs")],
    {
      cwd: REPO,
      encoding: "utf8",
      env: Object.assign({}, process.env, env, {
        CM_REPO: REPO,
        CM_EMIT: EMIT,
        CM_LOCAL_ROOT: scenario === "s3" ? S3_ROOT : LOCAL_ROOT,
        CM_SCENARIO: scenario,
        NODE_PATH: path.join(REPO, "node_modules"),
        // No credential ever reaches a harness.
        R2_ACCOUNT_ID: "",
        R2_ACCESS_KEY_ID: "",
        R2_SECRET_ACCESS_KEY: "",
        R2_BUCKET: "",
        R2_REGION: "",
        R2_S3_ENDPOINT: "",
      }),
      timeout: 180000,
    }
  );
  const m = /RESULT_JSON (\{[\s\S]*\})/.exec(out);
  if (!m) throw new Error(`harness produced no result for ${scenario}:\n${out}`);
  return JSON.parse(m[1]);
}

// ---------------------------------------------------------------------------
section("1. Repo-wide gate sweep — no local-only storage assumptions left");
// ---------------------------------------------------------------------------
{
  // Every source file that mentions MediaAsset.storage in src/.
  const walk = (dir, acc = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(p);
    }
    return acc;
  };
  const srcFiles = walk(path.join(REPO, "src")).map((p) =>
    path.relative(REPO, p).split(path.sep).join("/")
  );
  const singleLiteral = [];
  for (const rel of srcFiles) {
    const text = read(rel);
    // A comparison of a storage value against ONE literal is the regression
    // this phase removes. `=== "EXTERNAL_URL"` (the non-managed marker) is
    // legitimate and stays.
    const hits = text.match(/storage\s*[!=]==?\s*"(?:LOCAL_PRIVATE|S3)"/g) || [];
    if (hits.length) singleLiteral.push(`${rel}: ${hits.join(", ")}`);
    const literalRow = text.match(/storage:\s*"(?:LOCAL_PRIVATE|S3)"/g) || [];
    if (literalRow.length) singleLiteral.push(`${rel}: writes ${literalRow.join(", ")}`);
  }
  eq(singleLiteral, [], "no src/ file compares or writes a single managed-storage literal");

  // The gates that must use the shared predicate.
  const gates = {
    "src/lib/session-materials.ts": [
      [/!isManagedPrivateStorage\(asset\.storage\)/, "material read gate (check #10) uses the shared predicate"],
      [/isManagedPrivateStorage\(asset\.storage\) && asset\.storageKey/, "material delete gate uses the shared predicate"],
      [/deletePrivateFile\(asset\.storageKey, asset\.storage\)/, "material delete passes the recorded storage to the abstraction"],
      [/storage = activeMediaStorageValue\(\)/, "upload metadata comes from the active backend selector"],
      [/storage,/, "upload writes the resolved storage value to MediaAsset"],
    ],
    "src/app/api/media/[id]/route.ts": [
      [/!isManagedPrivateStorage\(asset\.storage\) \|\| !asset\.storageKey/, "media read gate uses the shared predicate"],
      [/privateFileStat\(asset\.storageKey, asset\.storage\)/, "media stat targets the recorded backend"],
      [/readPrivateFileStream\(/, "media route streams instead of buffering"],
      [/storageStreamToWebResponseBody\(result\.stream\)/, "media route pipes the backend stream into the response"],
    ],
    "src/app/api/materials/[id]/route.ts": [
      [/readPrivateFileStream\(/, "material route streams instead of buffering"],
      [/privateFileStat\(asset\.storageKey, asset\.storage\)/, "material range validation targets the recorded backend"],
      [/storageStreamToWebResponseBody\(result\.stream\)/, "material route pipes the backend stream into the response"],
    ],
    "src/app/api/admin/session-videos/[id]/route.ts": [
      [/isManagedPrivateStorage\(video\.media\.storage\)/, "session-video delete gate uses the shared predicate"],
      [/deletePrivateFile\(video\.media\.storageKey, video\.media\.storage\)/, "session-video delete passes the recorded storage"],
    ],
    "src/app/api/admin/session-videos/route.ts": [
      [/storage = activeMediaStorageValue\(\)/, "video upload metadata comes from the active backend selector"],
      [/storage,/, "video upload writes the resolved storage value"],
    ],
    "src/app/api/quizzes/[id]/evidence/route.ts": [
      [/storage = activeMediaStorageValue\(\)/, "evidence upload metadata comes from the active backend selector"],
      [/storage,/, "evidence upload writes the resolved storage value"],
    ],
    "scripts/media/purge-expired-evidence.ts": [
      [/isManagedPrivateStorage\(asset\[0\]\.storage\)/, "purge gate uses the shared predicate (S3 objects are collected)"],
      [/backendNameForStorageValue\(/, "purge dispatches on the recorded storage value"],
      [/new LocalStorageBackend\(o\.mediaRoot\)/, "purge deletes local objects through the storage abstraction"],
      [/createStorageBackend\(name\)/, "purge deletes S3 objects through the storage abstraction"],
    ],
  };
  for (const [rel, pins] of Object.entries(gates)) {
    const text = read(rel);
    for (const [re, label] of pins) pinned(text, re, `${rel}: ${label}`);
  }

  // The shared predicate itself is the single definition.
  const media = read("src/lib/media.ts");
  pinned(media, /export function isManagedPrivateStorage/, "lib/media exports the single managed-private predicate");
  pinned(media, /export function activeMediaStorageValue/, "lib/media exports the upload-metadata selector");
  pinned(media, /export function mediaStorageValueForBackend/, "lib/media maps backend → MediaStorage value");
  pinned(media, /export function backendNameForStorageValue/, "lib/media maps MediaStorage value → backend");
  ok(/case "local":\s*\n\s*return "LOCAL_PRIVATE";\s*\n\s*case "s3":\s*\n\s*return "S3";/.test(media),
    "backend → storage mapping is exhaustive (local→LOCAL_PRIVATE, s3→S3)");
  ok(!/storageKey\.includes\(|startsWith\("session-|\.startsWith\("materials\//.test(media),
    "storage value is never inferred from a key/path shape");

  // Delete order: object BEFORE row, in every delete path.
  const orderChecks = [
    ["src/lib/session-materials.ts", /deletePrivateFile\(asset\.storageKey, asset\.storage\)/, /client\.mediaAsset\.delete/],
    ["src/app/api/admin/session-videos/[id]/route.ts", /deletePrivateFile\(video\.media\.storageKey, video\.media\.storage\)/, /db\.mediaAsset\.delete/],
  ];
  for (const [rel, objectRe, rowRe] of orderChecks) {
    const text = read(rel);
    const oi = text.search(objectRe);
    const ri = text.search(rowRe);
    ok(oi !== -1 && ri !== -1 && oi < ri, `${rel}: object deleted before the MediaAsset row (no orphaning)`);
  }
  const purge = read("scripts/media/purge-expired-evidence.ts");
  ok(/await storage\.delete\(key\)/.test(purge) && /still present after delete/.test(purge),
    "purge verifies convergence after deleting an object (no silent skip)");
}

// ---------------------------------------------------------------------------
section("2. No R2 URL, key or credential exposure anywhere");
// ---------------------------------------------------------------------------
{
  const walk = (dir, acc = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) acc.push(p);
    }
    return acc;
  };
  const filesUnder = (rel) =>
    walk(path.join(REPO, rel)).map((p) => path.relative(REPO, p).split(path.sep).join("/"));

  // R2 configuration is server-only and lives in exactly one module.
  const r2Refs = [];
  for (const rel of [...filesUnder("src/app"), ...filesUnder("src/components")]) {
    if (/R2_(ACCOUNT_ID|ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET|REGION|S3_ENDPOINT)/.test(read(rel))) {
      r2Refs.push(rel);
    }
  }
  eq(r2Refs, [], "no route/page/component references R2_* configuration");
  const libRefs = filesUnder("src/lib").filter((rel) => /R2_(ACCOUNT_ID|BUCKET)/.test(read(rel)));
  eq(libRefs, ["src/lib/media-s3.ts"], "R2_* referenced only by the server-side s3 backend module");

  // Signed/public URL construction is now a CONFINED capability (Phase 23):
  // only the s3 storage backend may sign URLs (a short-lived presigned PUT),
  // and the upload orchestrator may NAME the backend's presign method — but
  // neither may sign anything PUT-shaped beyond one exact key, and no other
  // file in src/ may touch signing at all. Reads stay server-proxied: there
  // is still no presigned GET and no bucket LIST anywhere.
  const signed = [];
  const hosts = [];
  for (const rel of filesUnder("src")) {
    const text = read(rel);
    if (/getSignedUrl|s3-request-presigner|createPresigned|PresignedPost|X-Amz-Signature/i.test(text)) signed.push(rel);
    if (/r2\.cloudflarestorage\.com/.test(text) && rel !== "src/lib/media-s3.ts") hosts.push(rel);
    if (/NEXT_PUBLIC[A-Z0-9_]*(R2|S3|AWS)[A-Z0-9_]*/.test(text)) hosts.push(rel + " (NEXT_PUBLIC)");
  }
  eq(signed.sort(), ["src/lib/media-s3.ts", "src/lib/media-upload.ts"],
    "signed-URL surface confined to the s3 backend + the upload orchestrator");
  // The orchestrator only DELEGATES to the backend's presign method — it
  // never signs URLs itself and never imports the presigner.
  const orchestrator = read("src/lib/media-upload.ts");
  ok(!/getSignedUrl|s3-request-presigner|X-Amz-Signature|PresignedPost/i.test(orchestrator),
    "the upload orchestrator never constructs signed URLs itself");
  eq(hosts, [], "no bucket hostname or NEXT_PUBLIC storage credential outside the backend module");

  // The byte-serving routes stay proxies: they answer with bytes, never a URL.
  for (const rel of ["src/app/api/media/[id]/route.ts", "src/app/api/materials/[id]/route.ts"]) {
    const text = read(rel);
    ok(!/NextResponse\.redirect|headers\.set\(\s*["']location|["']Location["']|externalUrl/.test(text),
      `${rel}: no redirect / Location header / externalUrl (server proxy only)`);
    // `storageKey` may only ever appear as an argument to the storage
    // abstraction — never as a response field (that would leak the private
    // object path to the browser).
    const keyLines = text.split("\n").filter((line) => /storageKey/.test(line));
    ok(keyLines.length > 0, `${rel}: the storageKey is used (pin is load-bearing)`);
    for (const line of keyLines) {
      const allowed =
        /privateFileStat\(|readPrivateFileStream\(|deletePrivateFile\(/.test(line) || // an abstraction call
        /^\s*[\w.[\]]*storageKey,\s*$/.test(line) ||                                  // a multi-line call argument
        /!\s*[\w.]*storageKey\b/.test(line) ||                                          // a presence gate
        /^\s*(\/\/|\*|\/)\s/.test(line);                                              // a comment
      ok(allowed,
        `${rel}: storageKey only reaches the abstraction → ${line.trim().slice(0, 70)}`);
    }
    ok(!/storageKey\s*:/.test(text), `${rel}: no storageKey object property in any payload`);
    ok(/private, no-store/.test(text), `${rel}: keeps Cache-Control private, no-store`);
    ok(/nosniff/.test(text), `${rel}: keeps X-Content-Type-Options nosniff`);
    ok(/Accept-Ranges/.test(text), `${rel}: keeps Accept-Ranges`);
  }
  // Safe descriptors still never carry a key.
  const sm = read("src/lib/session-materials.ts");
  ok(!/downloadUrl:[^\n]*storageKey/.test(sm), "material descriptors never embed a storageKey");
  ok(/downloadUrl: m\.mediaAssetId \? `\/api\/materials\/\$\{m\.id\}` : null/.test(sm),
    "material descriptors still point at the authorized route");
}

async function main() {
  // ---------------------------------------------------------------------------
  section("3. Storage ↔ MediaAsset.storage mapping (pure, shipped code)");
  // ---------------------------------------------------------------------------
  {
    eq(Media.MEDIA_STORAGE_VALUES, ["EXTERNAL_URL", "LOCAL_PRIVATE", "S3"], "MediaStorage values mirrored (schema untouched)");
    eq(Media.MANAGED_PRIVATE_STORAGE_VALUES, ["LOCAL_PRIVATE", "S3"], "managed private storage = LOCAL_PRIVATE + S3");

    for (const v of ["LOCAL_PRIVATE", "S3", " LOCAL_PRIVATE ", "s3", "local_private"]) {
      ok(Media.isManagedPrivateStorage(v), `isManagedPrivateStorage(${JSON.stringify(v)}) → true`);
    }
    for (const v of ["EXTERNAL_URL", "", null, undefined, 0, "SOMETHING_ELSE", "PUBLIC", {}]) {
      ok(!Media.isManagedPrivateStorage(v), `isManagedPrivateStorage(${JSON.stringify(v)}) → false (fail closed)`);
    }
    eq(Media.normalizeMediaStorageValue(" s3 "), "S3", "normalizeMediaStorageValue trims/upper-cases");
    eq(Media.normalizeMediaStorageValue("nope"), null, "normalizeMediaStorageValue rejects unknown values");

    eq(Media.mediaStorageValueForBackend("local"), "LOCAL_PRIVATE", "local backend → LOCAL_PRIVATE");
    eq(Media.mediaStorageValueForBackend("s3"), "S3", "s3 backend → S3");
    eq(Media.backendNameForStorageValue("LOCAL_PRIVATE"), "local", "LOCAL_PRIVATE → local backend");
    eq(Media.backendNameForStorageValue("S3"), "s3", "S3 → s3 backend");
    eq(Media.backendNameForStorageValue("EXTERNAL_URL"), null, "EXTERNAL_URL has no managed backend");
    eq(Media.backendNameForStorageValue("junk"), null, "unknown value has no managed backend");

    // Upload metadata = the ACTIVE backend, resolved through the fail-closed selector.
    eq(Media.activeMediaStorageValue({}), "LOCAL_PRIVATE", "MEDIA_BACKEND unset → LOCAL_PRIVATE (default preserved)");
    eq(Media.activeMediaStorageValue({ MEDIA_BACKEND: "" }), "LOCAL_PRIVATE", "empty MEDIA_BACKEND → LOCAL_PRIVATE");
    eq(Media.activeMediaStorageValue({ MEDIA_BACKEND: "local" }), "LOCAL_PRIVATE", "MEDIA_BACKEND=local → LOCAL_PRIVATE");
    eq(Media.activeMediaStorageValue({ MEDIA_BACKEND: "s3" }), "S3", "MEDIA_BACKEND=s3 → S3");
    eq(Media.activeMediaStorageValue({ MEDIA_BACKEND: " S3 " }), "S3", "MEDIA_BACKEND is case/space tolerant");
    for (const bad of ["azure", "gcs", "r2", "minio"]) {
      let threw = null;
      try {
        Media.activeMediaStorageValue({ MEDIA_BACKEND: bad });
      } catch (e) {
        threw = String(e.message);
      }
      ok(threw !== null, `MEDIA_BACKEND="${bad}" → upload metadata fails closed (throws)`);
      ok(threw && /Refusing to fall/.test(threw), `MEDIA_BACKEND="${bad}" never degrades to local`);
    }

    // Bytes only move for managed values.
    for (const bad of ["EXTERNAL_URL", "junk", ""]) {
      let threw = null;
      try {
        await Media.deletePrivateFile("some/key.bin", bad);
      } catch (e) {
        threw = String(e.message);
      }
      ok(threw && /Refusing to move bytes/.test(threw), `deletePrivateFile(storage=${JSON.stringify(bad)}) refuses (fail closed)`);
    }
    // s3 backend construction without credentials fails closed BEFORE any client.
    let s3Err = null;
    try {
      await Media.getStorageBackend("s3");
    } catch (e) {
      s3Err = String(e.message);
    }
    ok(s3Err && /R2_ACCOUNT_ID/.test(s3Err), "s3 backend without R2 env fails closed naming missing vars only");
    ok(s3Err && !/[A-Za-z0-9+/]{30,}/.test(s3Err), "the failure message carries no secret-looking value");
    eq(networkAttempts, [], "no network attempt while resolving a misconfigured s3 backend");
  }

  // ---------------------------------------------------------------------------
  section("4. Volume quota stays a LOCAL-volume control (backend aware)");
  // ---------------------------------------------------------------------------
  {
    const quotaRoot = path.join(OUT, "quota-volume");
    fs.mkdirSync(quotaRoot, { recursive: true });
    fs.writeFileSync(path.join(quotaRoot, "a.bin"), Buffer.alloc(100));

    const unset = await Quotas.assertVolumeQuota(10, { env: {} });
    ok(unset.ok === true && unset.enforced === false, "unset MEDIA_QUOTA_BYTES is still a no-op");

    const localEnforced = await Quotas.assertVolumeQuota(10, { env: { MEDIA_QUOTA_BYTES: "150" }, root: quotaRoot });
    ok(localEnforced.ok === true && localEnforced.enforced === true, "local volume under quota allows the upload");
    const localOver = await Quotas.assertVolumeQuota(1000, { env: { MEDIA_QUOTA_BYTES: "150" }, root: quotaRoot });
    ok(localOver.ok === false && localOver.code === "QUOTA_EXCEEDED", "local volume over quota still refuses (unchanged)");

    // With MEDIA_BACKEND=s3 the bytes are objects, so a MEDIA_ROOT walk would
    // measure the wrong store (and could charge uploads for stale local bytes).
    const s3NoRoot = await Quotas.assertVolumeQuota(10 ** 9, { env: { MEDIA_QUOTA_BYTES: "150", MEDIA_BACKEND: "s3" } });
    ok(s3NoRoot.ok === true && s3NoRoot.enforced === false, "s3 backend: local-volume quota reports not-enforced (never mis-measured)");
    eq(s3NoRoot.reason, "BACKEND_NOT_LOCAL_VOLUME", "the verdict says WHY it was not enforced");
    const localWithReason = await Quotas.assertVolumeQuota(1, { env: { MEDIA_QUOTA_BYTES: "150", MEDIA_BACKEND: "local" }, root: quotaRoot });
    eq(localWithReason.reason, undefined, "local enforcement keeps its existing verdict shape");
    let quotaThrew = null;
    try {
      await Quotas.assertVolumeQuota(1, { env: { MEDIA_QUOTA_BYTES: "150", MEDIA_BACKEND: "azure" } });
    } catch (e) {
      quotaThrew = String(e.message);
    }
    ok(quotaThrew && /not a supported storage backend/.test(quotaThrew), "quota check fails closed on a bogus MEDIA_BACKEND");
  }

  // ---------------------------------------------------------------------------
  section("5. LOCAL_PRIVATE remains fully supported (MEDIA_BACKEND unset)");
  // ---------------------------------------------------------------------------
  const local = runHarness("local", { MEDIA_BACKEND: "" });
  {
    eq(local.scenario, "local", "harness ran the local scenario");
    eq(local.networkAttempts, [], "local scenario made zero network attempts");

    // Upload metadata.
    ok(local.upload.ok === true, "PDF upload succeeds on the local backend");
    eq(local.upload.storage, "LOCAL_PRIVATE", "MediaAsset.storage = LOCAL_PRIVATE when MEDIA_BACKEND is local/unset");
    eq(local.upload.kind, "DOCUMENT", "kind stays DOCUMENT");
    eq(local.upload.isPrivate, true, "asset stays private");
    eq(local.upload.keyScope, "session-pdfs", "storage key scope unchanged");
    eq(local.upload.mimeType, "application/pdf", "mime unchanged");
    eq(local.upload.sizeBytes, PDF_BYTES.length, "sizeBytes = the uploaded bytes (harness/parent fixtures agree)");
    eq(local.upload.originalName, "unit-1.pdf", "originalName preserved");
    eq(local.upload.materialStorageKey, null, "Material.storageKey stays null (the asset owns the key)");
    ok(local.upload.fileOnVolume === true, "bytes written to the private volume");
    eq(local.upload.bucketSize, 0, "no object written to the s3 bucket");
    eq(local.upload.s3Calls, 0, "zero S3 calls on the local path");

    // Read gate.
    ok(local.gates.admin.allowed === true, "ADMIN passes check #10 for a LOCAL_PRIVATE asset");
    eq(local.gates.admin.storage, "LOCAL_PRIVATE", "the gate reports the recorded storage value");
    eq(local.gates.anonymous, { allowed: false, reason: "UNAUTHORIZED", status: 401 }, "anonymous still 401");
    eq(local.gates.studentWithoutProfile, { allowed: false, reason: "FORBIDDEN_ROLE", status: 403 }, "student without a profile still 403");
    ok(local.gates.parentWithoutChildren.allowed === false, "parent without linked children still denied");
    eq(local.gates.unknownRole, { allowed: false, reason: "FORBIDDEN_ROLE", status: 403 }, "unknown role still 403");
    eq(local.gates.missingMaterial, { allowed: false, reason: "MATERIAL_NOT_FOUND", status: 404 }, "unknown material still 404");
    eq(local.gates.externalUrl.reason, "ASSET_NOT_FOUND", "EXTERNAL_URL asset still refused by check #10");
    eq(local.gates.notPrivate.reason, "ASSET_NOT_FOUND", "non-private document asset still refused");
    eq(local.gates.noKey.reason, "ASSET_NOT_FOUND", "asset without a storageKey still refused");
    eq(local.gates.unknownStorage.reason, "ASSET_NOT_FOUND", "unknown storage value still refused (fail closed)");
    eq(local.gates.inactive.reason, "MATERIAL_INACTIVE", "inactive material still refused");
    ok(local.gates.s3AssetAccepted.allowed === true && local.gates.s3AssetAccepted.storage === "S3",
      "the read gate accepts an S3-recorded asset (gate follows the row, not the env)");

    // Download route: statuses, headers, bytes.
    const d = local.download;
    eq(d.full.status, 200, "full download 200");
    eq(d.full.headers["content-type"], "application/pdf", "Content-Type preserved");
    eq(d.full.headers["content-length"], String(PDF_BYTES.length), "Content-Length = object size");
    eq(d.full.headers["cache-control"], "private, no-store, max-age=0", "Cache-Control preserved");
    eq(d.full.headers["pragma"], "no-store", "Pragma preserved");
    eq(d.full.headers["x-content-type-options"], "nosniff", "nosniff preserved");
    eq(d.full.headers["accept-ranges"], "bytes", "Accept-Ranges preserved");
    eq(d.full.headers["content-disposition"], 'inline; filename="unit-1.pdf"', "Content-Disposition inline preserved");
    ok(Buffer.from(d.full.body.data).equals(PDF_BYTES), "full body = the stored bytes");
    eq(d.range.status, 206, "valid range → 206");
    eq(d.range.headers["content-range"], `bytes 0-4/${PDF_BYTES.length}`, "Content-Range preserved");
    eq(d.range.headers["content-length"], "5", "partial Content-Length preserved");
    eq(Buffer.from(d.range.body.data).toString(), "%PDF-", "partial body = the requested window");
    eq(d.openEnded.status, 206, "open-ended range → 206");
    eq(d.openEnded.headers["content-range"], `bytes 5-${PDF_BYTES.length - 1}/${PDF_BYTES.length}`, "open-ended Content-Range preserved");
    eq(d.endPastEof.status, 416, "end past EOF → 416 (strict behaviour preserved)");
    eq(d.endPastEof.headers["content-range"], `bytes */${PDF_BYTES.length}`, "416 carries Content-Range: bytes */TOTAL");
    eq(d.startPastEof.status, 416, "start past EOF → 416");
    eq(d.inverted.status, 416, "start > end → 416");
    eq(d.unparseable.status, 200, "unparseable Range header ignored → full 200 (unchanged)");
    eq(d.downloadFlag.status, 200, "?download=1 → 200");
    eq(d.downloadFlag.headers["content-disposition"], 'attachment; filename="unit-1.pdf"', "?download=1 → attachment");
    eq(d.unknownId.status, 404, "unknown material id → 404");
    eq(d.anonymous.status, 401, "anonymous download → 401 (authorization before bytes)");
    eq(d.studentWithoutProfile.status, 403, "unauthorized student → 403 (authorization before bytes)");
    eq(d.s3CallsForFullRead, 0, "no S3 call while serving local bytes");

    // Cross-backend addressing (an S3 row served while the active backend is local).
    eq(local.crossBackend.readLength, local.crossBackend.statSize, "S3-recorded object read through the S3 backend");
    eq(local.crossBackend.rangeStart, 4, "cross-backend ranged read start");
    eq(local.crossBackend.rangeEnd, 9, "cross-backend ranged read end");
    eq(local.crossBackend.rangeContentLength, 6, "cross-backend ranged read length");
    ok(local.crossBackend.s3Ops > 0, "cross-backend read used the object store");
    ok(local.crossBackend.onLocalVolume === false, "the S3 object was never written to the local volume");
    ok(local.crossBackend.deletedFromBucket === true, "cross-backend delete removed the object");
    ok(local.crossBackend.localVolumeUntouched === true, "cross-backend delete never touched the volume");

    // Delete gate + ordering.
    ok(local.deleteLocal.removed === true, "unreferenced LOCAL_PRIVATE asset cleaned up");
    ok(local.deleteLocal.fileGone === true, "its bytes were deleted from the volume");
    ok(local.deleteLocal.rowGone === true, "its row was deleted");
    eq(local.deleteLocal.s3Calls, 0, "no S3 call while deleting local bytes");
    eq(local.deleteLocal.ops[local.deleteLocal.ops.length - 1], "db.mediaAsset.delete", "the row delete is the LAST operation (object first)");
    ok(local.deleteExternal.removed === true && local.deleteExternal.s3Calls === 0, "EXTERNAL_URL asset: row removed, no bytes moved");
    ok(local.deleteReferenced.removed === false, "a referenced asset is never deleted");
    ok(local.deleteReferenced.rowSurvives && local.deleteReferenced.bytesSurvive, "referenced asset keeps row AND bytes");

    // Session-video DELETE route.
    eq(local.videoDelete.status, 200, "admin video delete 200");
    ok(local.videoDelete.fileGone && local.videoDelete.rowGone && local.videoDelete.videoRowGone, "video delete removed bytes + asset row + video row");
    eq(local.videoDelete.ops[local.videoDelete.ops.length - 1], "db.mediaAsset.delete", "video delete removes the asset row last");
    eq(local.videoDelete.teacherStatus, 403, "TEACHER still cannot delete session videos (ADMIN only)");

    ok(/Refusing to move bytes/.test(local.nonManagedRefused), "non-managed storage value never reaches a backend");
  }

  // ---------------------------------------------------------------------------
  section("6. S3 assets are accepted end-to-end (MEDIA_BACKEND=s3)");
  // ---------------------------------------------------------------------------
  const s3 = runHarness("s3", { MEDIA_BACKEND: "s3" });
  {
    eq(s3.scenario, "s3", "harness ran the s3 scenario");
    eq(s3.networkAttempts, [], "s3 scenario made zero network attempts (fake client only)");
    eq(s3.leaks, [], "no response leaked the bucket, an object key, or a credential");

    // Upload metadata.
    ok(s3.upload.ok === true, "PDF upload succeeds on the s3 backend");
    eq(s3.upload.storage, "S3", "MediaAsset.storage = S3 when MEDIA_BACKEND=s3");
    eq(s3.upload.kind, "DOCUMENT", "kind stays DOCUMENT");
    eq(s3.upload.isPrivate, true, "asset stays private");
    eq(s3.upload.keyScope, "session-pdfs", "the SAME key scheme is used in the bucket");
    ok(s3.upload.objectInBucket === true, "the object landed in the bucket");
    eq(s3.upload.bucketBytes, PDF_BYTES.length, "the stored object is exactly the uploaded bytes");
    ok(s3.upload.bytesMatch === true, "stored bytes match byte-for-byte");
    eq(s3.upload.bucketContentType, "application/pdf", "mimeType carried to the object (ContentType)");
    ok(s3.upload.onLocalVolume === false, "nothing was written to the local volume under s3");
    eq(s3.upload.putCalls, 1, "exactly one PUT for the upload");

    // Read gate.
    ok(s3.gates.admin.allowed === true, "ADMIN passes check #10 for an S3 asset");
    eq(s3.gates.admin.storage, "S3", "the gate reports S3");
    eq(s3.gates.admin.isPrivate, true, "the gate still requires isPrivate");
    eq(s3.gates.anonymous, { allowed: false, reason: "UNAUTHORIZED", status: 401 }, "anonymous still 401 for an S3 asset");
    eq(s3.gates.studentWithoutProfile, { allowed: false, reason: "FORBIDDEN_ROLE", status: 403 }, "student without a profile still 403");
    ok(s3.gates.parentWithoutChildren.allowed === false, "parent without linked children still denied");
    eq(s3.gates.externalUrl.reason, "ASSET_NOT_FOUND", "EXTERNAL_URL still refused under the s3 backend");

    // Download route over S3.
    const d = s3.download;
    eq(d.full.status, 200, "S3-backed material download 200");
    eq(d.full.headers["content-type"], "application/pdf", "Content-Type preserved over S3");
    eq(d.full.headers["content-length"], String(PDF_BYTES.length), "Content-Length preserved over S3");
    eq(d.full.headers["cache-control"], "private, no-store, max-age=0", "Cache-Control preserved over S3");
    eq(d.full.headers["content-disposition"], 'inline; filename="unit-1.pdf"', "Content-Disposition preserved over S3");
    eq(d.full.headers["x-content-type-options"], "nosniff", "nosniff preserved over S3");
    ok(Buffer.from(d.full.body.data).equals(PDF_BYTES), "S3 body = the stored bytes");
    eq(d.range.status, 206, "S3 range → 206");
    eq(d.range.headers["content-range"], `bytes 0-4/${PDF_BYTES.length}`, "S3 Content-Range preserved");
    eq(d.range.headers["content-length"], "5", "S3 partial Content-Length preserved");
    eq(Buffer.from(d.range.body.data).toString(), "%PDF-", "S3 partial body = the requested window");
    eq(d.openEnded.status, 206, "S3 open-ended range → 206");
    eq(d.openEnded.headers["content-range"], `bytes 5-${PDF_BYTES.length - 1}/${PDF_BYTES.length}`, "S3 open-ended Content-Range preserved");
    eq(d.endPastEof.status, 416, "S3 end past EOF → 416 (identical strictness)");
    eq(d.endPastEof.headers["content-range"], `bytes */${PDF_BYTES.length}`, "S3 416 carries Content-Range: bytes */TOTAL");
    eq(d.startPastEof.status, 416, "S3 start past EOF → 416");
    eq(d.inverted.status, 416, "S3 start > end → 416");
    eq(d.unparseable.status, 200, "S3 unparseable Range ignored → full 200");
    eq(d.downloadFlag.headers["content-disposition"], 'attachment; filename="unit-1.pdf"', "S3 ?download=1 → attachment");
    eq(d.unknownId.status, 404, "unknown id → 404 over S3");
    eq(d.anonymous.status, 401, "authorization happens BEFORE any S3 read (401)");
    eq(d.studentWithoutProfile.status, 403, "authorization happens BEFORE any S3 read (403)");
    eq(d.parent.status, 404, "parent denial is the same non-oracle 404");
    eq(d.rangedGets, 2, "each 206 issued a RANGED GET (bytes were streamed, not buffered)");
    ok(d.ops.some((o) => /^s3:GetObjectCommand\[bytes=0-4\]/.test(o)), "the object store received `Range: bytes=0-4`");
    ok(d.ops.some((o) => new RegExp(`^s3:GetObjectCommand\\[bytes=5-${PDF_BYTES.length - 1}\\]`).test(o)), "the object store received the open-ended range as bytes=5-LAST");
    ok(!d.ops.slice(0, 2).some((o) => o.startsWith("s3:")), "no byte is fetched before the authorization verdict");

    // Streaming media route over S3.
    const m = s3.media;
    eq(m.full.status, 200, "S3-backed video stream 200");
    eq(m.full.headers["content-type"], "video/mp4", "video Content-Type preserved");
    eq(m.full.headers["accept-ranges"], "bytes", "video Accept-Ranges preserved");
    eq(m.full.headers["cache-control"], "private, no-store, max-age=0", "video Cache-Control preserved");
    eq(m.full.headers["content-disposition"], "inline", "video Content-Disposition preserved");
    eq(m.full.headers["content-length"], String(m.full.body.data.length), "video Content-Length matches the streamed bytes");
    eq(m.range.status, 206, "video range → 206");
    eq(m.range.headers["content-range"], `bytes 100-199/${m.full.body.data.length}`, "video Content-Range preserved");
    eq(m.range.headers["content-length"], "100", "video partial Content-Length preserved");
    eq(m.range.body.data.length, 100, "video partial body is exactly the window");
    eq(m.openEnded.status, 206, "video open-ended range → 206");
    eq(m.openEnded.headers["content-range"], `bytes 4000-${m.full.body.data.length - 1}/${m.full.body.data.length}`, "video open-ended Content-Range clamped to EOF");
    eq(m.startPastEof.status, 416, "video start past EOF → 416");
    eq(m.endPastEof.status, 416, "video end past EOF → 416");
    eq(m.inverted.status, 416, "video inverted range → 416");
    eq(m.malformed.status, 200, "video malformed range ignored → full 200");
    eq(m.rangedGets, 2, "video ranges issued RANGED GETs (no full-object buffering)");
    eq(m.otherBatchStudent.status, 403, "student of another batch/track still 403 (track isolation preserved)");
    eq(m.parent.status, 403, "parents still cannot stream session media");
    eq(m.anonymous.status, 401, "anonymous still 401");
    eq(m.unknownId.status, 404, "unknown media id still 404");
    eq(m.missingObject.status, 404, "an S3 asset whose object is missing → the same non-oracle 404");
    eq(m.evidenceAdmin.status, 200, "ADMIN may read quiz evidence over S3");
    eq(m.evidenceSecurityEvent, 1, "the evidence read is still audit-logged (QUIZ_EVIDENCE_ACCESSED)");
    eq(m.evidenceTeacher.status, 403, "TEACHER still cannot read quiz evidence");

    // Delete gate + ordering over S3.
    eq(s3.videoDelete.status, 200, "admin video delete 200 over S3");
    ok(s3.videoDelete.objectGone === true, "the S3 object was deleted through the abstraction");
    ok(s3.videoDelete.rowGone === true, "the MediaAsset row was deleted");
    ok(s3.videoDelete.objectDeletedBeforeRow === true, "OBJECT deleted BEFORE the row (no orphaning)");
    ok(s3.videoDeleteShared.objectSurvives && s3.videoDeleteShared.rowSurvives, "a still-referenced S3 asset is never deleted");
    eq(s3.videoDeleteShared.deleteCalls, 0, "no delete issued while another row references the asset");
    ok(s3.deleteFailure.threw === true, "a failing object delete surfaces (never silent)");
    ok(s3.deleteFailure.rowSurvives === true, "the MediaAsset row SURVIVES a failed object delete");
    ok(s3.deleteFailure.objectSurvives === true, "the bytes survive with it (nothing orphaned)");
    ok(s3.deleteFailure.retryRemoved === true, "the retry converges once the service recovers");
    ok(s3.deleteFailure.retryRowGone && s3.deleteFailure.retryObjectGone, "the retry removed both object and row");
  }

  // ---------------------------------------------------------------------------
  section("7. Retention purge — LOCAL_PRIVATE and S3 objects both handled");
  // ---------------------------------------------------------------------------
  {
    const { DatabaseSync } = require("node:sqlite");
    const PROTECTED = ["SecurityEvent", "AuditLog", "TeacherApplication", "TeacherActivationToken", "UserSession", "PasswordResetToken", "SecurityRateLimit", "QuizAttempt", "Student", "User"];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm-wiring-purge-"));
    const makeDb = (file, assets) => {
      const d = new DatabaseSync(file);
      d.exec(
        `CREATE TABLE "QuizAttemptEvidence" ("id" TEXT PRIMARY KEY, "attemptId" TEXT, "mediaAssetId" TEXT, "kind" TEXT, "status" TEXT, "capturedAt" TEXT, "retainUntil" TEXT);
         CREATE TABLE "Material" ("id" TEXT PRIMARY KEY, "mediaAssetId" TEXT);
         CREATE TABLE "SessionVideo" ("id" TEXT PRIMARY KEY, "mediaAssetId" TEXT);
         CREATE TABLE "MediaAsset" ("id" TEXT PRIMARY KEY, "storage" TEXT, "storageKey" TEXT);
         ${PROTECTED.map((t) => `CREATE TABLE "${t}" ("id" TEXT PRIMARY KEY);`).join("\n")}`
      );
      for (const a of assets) {
        d.prepare(`INSERT INTO "MediaAsset" VALUES (?,?,?)`).run(a.id, a.storage, a.key);
        d.prepare(`INSERT INTO "QuizAttemptEvidence" VALUES (?,?,?,?,NULL,?,?)`).run(
          "ev-" + a.id, "att-" + a.id, a.id, "SNAPSHOT", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"
        );
      }
      d.close();
    };
    const runPurge = (args, env) => {
      try {
        const stdout = execFileSync(process.execPath, [TSX_CLI, "scripts/media/purge-expired-evidence.ts", ...args], {
          cwd: REPO,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: Object.assign({}, process.env, env || {}, {
            NODE_NO_WARNINGS: "1",
            R2_ACCOUNT_ID: "",
            R2_ACCESS_KEY_ID: "",
            R2_SECRET_ACCESS_KEY: "",
            R2_BUCKET: "",
          }),
          timeout: 180000,
        });
        return { status: 0, stdout, stderr: "" };
      } catch (e) {
        return { status: e.status, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
      }
    };

    // 7a. LOCAL_PRIVATE object on the volume → deleted through the abstraction.
    const mediaRoot = path.join(tmp, "media");
    fs.mkdirSync(path.join(mediaRoot, "quiz-evidence"), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, "quiz-evidence", "local-snap.jpg"), Buffer.from("doomed"));
    const dbLocal = path.join(tmp, "local.db");
    makeDb(dbLocal, [{ id: "ma-local", storage: "LOCAL_PRIVATE", key: "quiz-evidence/local-snap.jpg" }]);
    const metricsLocal = path.join(tmp, "local-metrics.json");
    const localRun = runPurge(
      ["--sqlite", dbLocal, "--media-root", mediaRoot, "--now", "2026-09-11T00:00:00.000Z", "--live", "--yes", "--metrics", metricsLocal],
      { MEDIA_BACKEND: "" }
    );
    eq(localRun.status, 0, "local purge run exits 0");
    ok(/PURGE_LIVE_OK deleted=1 assets=1 files=1 failed=0/.test(localRun.stdout), "local object deleted through the storage abstraction");
    ok(!fs.existsSync(path.join(mediaRoot, "quiz-evidence", "local-snap.jpg")), "the local file is gone");
    const localMetrics = JSON.parse(fs.readFileSync(metricsLocal, "utf8"));
    eq(localMetrics.detachedByStorage, { LOCAL_PRIVATE: 1 }, "metrics record the storage of every detached object");
    eq(localMetrics.protectedTables.SecurityEvent, localMetrics.protectedTablesAfter.SecurityEvent, "protected tables untouched");

    // 7b. S3 object with no R2 configuration → recorded, NOT silently skipped.
    const dbS3 = path.join(tmp, "s3.db");
    makeDb(dbS3, [{ id: "ma-s3", storage: "S3", key: "quiz-evidence/s3-snap.jpg" }]);
    const metricsS3 = path.join(tmp, "s3-metrics.json");
    const s3Run = runPurge(
      ["--sqlite", dbS3, "--media-root", mediaRoot, "--now", "2026-09-11T00:00:00.000Z", "--live", "--yes", "--metrics", metricsS3],
      { MEDIA_BACKEND: "" }
    );
    eq(s3Run.status, 2, "an S3 object that could not be deleted exits 2 (retry run)");
    ok(/files=0 failed=1/.test(s3Run.stdout), "the S3 object is counted as a FAILURE, not skipped");
    const s3Metrics = JSON.parse(fs.readFileSync(metricsS3, "utf8"));
    eq(s3Metrics.detachedByStorage, { S3: 1 }, "the purge recognised the S3-backed object");
    eq(s3Metrics.detachedAssets, 1, "the S3 object was collected for deletion");
    ok(s3Metrics.failedFiles.length === 1 && /quiz-evidence\/s3-snap\.jpg: MEDIA_BACKEND=s3 requires server-side env vars/.test(s3Metrics.failedFiles[0]),
      "the failure names the missing configuration (fail closed, no bucket contacted)");
    ok(!/[A-Za-z0-9+/]{30,}/.test(s3Metrics.failedFiles[0]), "no secret-looking value in the metrics");

    // 7c. Traversal guard for the local volume is unchanged.
    const dbEsc = path.join(tmp, "escape.db");
    makeDb(dbEsc, [{ id: "ma-esc", storage: "LOCAL_PRIVATE", key: "../escape.jpg" }]);
    const metricsEsc = path.join(tmp, "escape-metrics.json");
    const escRun = runPurge(
      ["--sqlite", dbEsc, "--media-root", mediaRoot, "--now", "2026-09-11T00:00:00.000Z", "--live", "--yes", "--metrics", metricsEsc],
      { MEDIA_BACKEND: "" }
    );
    eq(escRun.status, 2, "an escaping key exits 2");
    const escMetrics = JSON.parse(fs.readFileSync(metricsEsc, "utf8"));
    ok(escMetrics.failedFiles.some((f) => /escapes media root/.test(f)),
      "escaping keys are still refused and recorded (traversal guard unchanged)");
    eq(escMetrics.deletedFiles, 0, "an escaping key deletes nothing");

    // 7d. Dry run still changes nothing (default safety preserved).
    const dbDry = path.join(tmp, "dry.db");
    makeDb(dbDry, [{ id: "ma-dry", storage: "S3", key: "quiz-evidence/dry.jpg" }]);
    const dryRun = runPurge(["--sqlite", dbDry, "--now", "2026-09-11T00:00:00.000Z"], { MEDIA_BACKEND: "" });
    eq(dryRun.status, 0, "dry run exits 0");
    ok(/PURGE_DRY_RUN_OK expired=1/.test(dryRun.stdout), "dry run reports the expired row without deleting");
    const d = new DatabaseSync(dbDry, { readOnly: true });
    eq(Number(d.prepare(`SELECT COUNT(*) AS n FROM "MediaAsset"`).get().n), 1, "dry run deleted nothing");
    d.close();

    eq(networkAttempts, [], "no network attempt in the parent process either");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------
  section("8. Wiring summary pins (docs + env contract)");
  // ---------------------------------------------------------------------------
  {
    ok(/LOCAL_PRIVATE \| S3|LOCAL_PRIVATE or S3|LOCAL_PRIVATE \(the private volume\) OR S3/i.test(read("src/lib/session-materials.ts")),
      "session-materials documents both managed backends");
    ok(/LOCAL_PRIVATE|S3/.test(read("src/app/api/media/[id]/route.ts")), "media route documents both managed backends");
    ok(/MEDIA_BACKEND/.test(read(".env.example")) && /R2_BUCKET/.test(read(".env.example")), ".env.example still documents the backend switch + R2 names");
    ok(/enum MediaStorage \{\s*EXTERNAL_URL\s*LOCAL_PRIVATE\s*S3\s*\}/.test(read("prisma/schema.prisma")), "Prisma schema unchanged (S3 already existed)");
  }

  // ---------------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log(`Media storage wiring suite: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:");
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }

}

main().catch((e) => {
  console.error("SUITE ERROR:", e);
  process.exit(1);
});
