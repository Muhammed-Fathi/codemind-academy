// CodeMind Academy — Admin media upload UX & real-progress regression suite.
//
// Covers the media-upload polish phase (video AND PDF):
//   1. real byte progress over the direct (presigned PUT) flow,
//   2. the multi-stage state machine (preparing → uploading → confirming →
//      succeeded / failed) and that "completed" is never claimed before the
//      complete leg answered,
//   3. progress math safety (no division by zero, never > 100),
//   4. human-readable byte formatting,
//   5. per-stage failure resolution and wording,
//   6. duplicate-submission protection,
//   7. cancellation,
//   8. the unchanged media contract (video MIME list + 512 MB, PDF
//      application/pdf + .pdf + %PDF- magic + 25 MB),
//   9. the unchanged R2/CSP exact-origin behaviour,
//  10. that no secret (presigned URL, token, credential) can leak through the
//      new progress/diagnostics surface.
//
// Everything under test is the SHIPPED TypeScript, compiled unmodified and
// driven against a fake XMLHttpRequest / fetch — no reimplementation, no
// network, no credentials, no database.
//
// Run: node tests/media-upload-progress.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-upload-progress-"));

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
// Compile the shipped modules under test
// ---------------------------------------------------------------------------
const MODULES = [
  "src/lib/video-url.ts",
  "src/lib/media.ts",
  "src/lib/r2-upload-origin.ts",
  "src/lib/upload-progress.ts",
  "src/lib/upload-error-text.ts",
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

const P = require(path.join(EMIT, "upload-progress.js"));
const E = require(path.join(EMIT, "upload-error-text.js"));
const { directUpload } = require(path.join(EMIT, "direct-upload.js"));
const Media = require(path.join(EMIT, "media.js"));
const { resolveDirectUploadOrigin } = require(path.join(EMIT, "r2-upload-origin.js"));

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Fake transport: a scripted XMLHttpRequest + a scripted fetch
// ---------------------------------------------------------------------------

/** Minimal File-like body (the helper only reads name/size/type). */
function fakeFile(name, size, type) {
  return { name, size, type };
}

/**
 * Install a fake XMLHttpRequest whose `send()` runs `script(xhr)`.
 * Returns the constructed instances so the test can assert the wire shape.
 */
function installFakeXHR(script) {
  const instances = [];
  class FakeXHR {
    constructor() {
      this.upload = {};
      this.headers = {};
      this.status = 0;
      this.method = null;
      this.url = null;
      this.async = null;
      this.body = null;
      this.aborted = false;
      // Mirrors the browser default: the presigned PUT must carry no cookie.
      this.withCredentials = false;
    }
    open(method, url, async) {
      this.method = method;
      this.url = url;
      this.async = async;
    }
    setRequestHeader(k, v) {
      this.headers[k] = v;
    }
    abort() {
      this.aborted = true;
      this.status = 0;
      if (this.onabort) this.onabort();
      if (this.onloadend) this.onloadend();
    }
    send(body) {
      this.body = body;
      instances.push(this);
      script(this);
    }
  }
  const previous = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR;
  return {
    instances,
    restore() {
      if (previous === undefined) delete globalThis.XMLHttpRequest;
      else globalThis.XMLHttpRequest = previous;
    },
  };
}

/** Remove XHR entirely → the helper must use its pinned fetch fallback. */
function removeXHR() {
  const previous = globalThis.XMLHttpRequest;
  delete globalThis.XMLHttpRequest;
  return {
    restore() {
      if (previous !== undefined) globalThis.XMLHttpRequest = previous;
    },
  };
}

const GRANT = {
  uploadUrl: "https://bucket.account.r2.invalid/session-videos/x-1.mp4?X-Amz-Signature=deadbeef",
  method: "PUT",
  token: "payload.mac",
  contentType: "video/mp4",
  maxBytes: 512 * MB,
  expiresInSec: 600,
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  purpose: "SESSION_VIDEO",
};
const PDF_GRANT = { ...GRANT, uploadUrl: "https://bucket.account.r2.invalid/session-pdfs/x-1.pdf?X-Amz-Signature=deadbeef", contentType: "application/pdf", maxBytes: 25 * MB, purpose: "LESSON_PDF" };

/**
 * Script the two app legs (init/complete). `initBody` / `completeBody` are the
 * JSON bodies; `completeStatus` proves the "not completed until confirmed"
 * rule. Records every call.
 */
function installFetch({ initStatus = 200, initBody = GRANT, completeStatus = 200, completeBody = { purpose: "SESSION_VIDEO", mediaAssetId: "ma_1" } } = {}) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || "GET", body: opts && opts.body });
    if (u.endsWith("/media-uploads/init")) {
      return { ok: initStatus < 400, status: initStatus, json: async () => initBody };
    }
    if (u.endsWith("/media-uploads/complete")) {
      return { ok: completeStatus < 400, status: completeStatus, json: async () => completeBody };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return {
    calls,
    restore() {
      if (previous === undefined) delete globalThis.fetch;
      else globalThis.fetch = previous;
    },
  };
}

/** Emit progress samples, then finish with `status` (0 → network error). */
function transferScript(samples, status = 200) {
  return (xhr) => {
    const total = samples.length ? samples[samples.length - 1] : 0;
    for (const loaded of samples) {
      if (xhr.upload.onprogress) {
        xhr.upload.onprogress({ lengthComputable: total > 0, loaded, total });
      }
    }
    xhr.status = status;
    if (status === 0) {
      if (xhr.onerror) xhr.onerror();
    }
    if (xhr.onloadend) xhr.onloadend();
  };
}

/** Emit one sample and then hang — the test aborts it. */
function hangingScript(sample, total) {
  return (xhr) => {
    if (xhr.upload.onprogress) {
      xhr.upload.onprogress({ lengthComputable: true, loaded: sample, total });
    }
    xhr.pending = true;
  };
}

async function main() {
  // =========================================================================
  section("1. Progress math — real numbers, never > 100, never a division by zero");
  // =========================================================================
  eq(P.uploadPercent(0, 80 * MB), 0, "starts safely at 0%");
  eq(P.uploadPercent(Math.round(32.4 * MB), 80 * MB), 40.5, "intermediate percentage (32.4 of 80 MB)");
  eq(P.uploadPercent(80 * MB, 80 * MB), 100, "reaches exactly 100%");
  eq(P.uploadPercent(200 * MB, 80 * MB), 100, "an over-reporting transport can never exceed 100%");
  eq(P.uploadPercent(40 * MB, 80 * MB), 50, "half of a 512 MB-scale upload");
  eq(P.uploadPercent(1024, 0), 0, "unknown total (0) → 0%, no division by zero");
  eq(P.uploadPercent(1024, -1), 0, "negative total → 0%");
  eq(P.uploadPercent(NaN, 100), 0, "NaN loaded → 0%");
  eq(P.uploadPercent(10, NaN), 0, "NaN total → 0%");
  eq(P.uploadPercent(Infinity, 100), 0, "Infinity loaded → 0%");
  eq(P.uploadPercent(null, 100), 0, "null loaded → 0%");
  eq(P.uploadPercent(undefined, undefined), 0, "both missing → 0%");
  eq(P.uploadPercent(-5, 100), 0, "negative loaded → 0%");
  eq(P.clampPercent(150), 100, "clampPercent caps at 100");
  eq(P.clampPercent(-3), 0, "clampPercent floors at 0");
  eq(P.clampPercent(NaN), 0, "clampPercent rejects NaN");
  eq(P.clampPercent(41.26), 41.3, "clampPercent keeps one decimal");

  {
    const snapshot = P.makeUploadProgress(8 * MB, 8 * MB);
    eq(snapshot.percent, 100, "makeUploadProgress: a fully sent file is 100%");
    ok(snapshot.computable === true, "makeUploadProgress: a known total is computable");
    eq(snapshot.loadedBytes, 8 * MB, "makeUploadProgress: loadedBytes is the real count");
    const unknown = P.makeUploadProgress(1024, 0);
    ok(unknown.computable === false, "makeUploadProgress: an unknown total is NOT computable");
    eq(unknown.percent, 0, "makeUploadProgress: an unknown total never invents a percentage");
    const over = P.makeUploadProgress(99 * MB, 8 * MB);
    eq(over.percent, 100, "makeUploadProgress: loaded > total caps at 100%");
    eq(over.loadedBytes, 8 * MB, "makeUploadProgress: loaded is capped at the total");
  }

  // =========================================================================
  section("2. Human-readable byte formatting");
  // =========================================================================
  eq(P.formatUploadBytes(0), "0 B", "0 bytes");
  eq(P.formatUploadBytes(512), "512 B", "512 bytes");
  eq(P.formatUploadBytes(1023), "1023 B", "just under a KB");
  eq(P.formatUploadBytes(1024), "1.0 KB", "1 KB");
  eq(P.formatUploadBytes(1536), "1.5 KB", "1.5 KB");
  eq(P.formatUploadBytes(8 * MB), "8.0 MB", "the reported ~8 MB video");
  eq(P.formatUploadBytes(Math.round(32.4 * MB)), "32.4 MB", "32.4 MB");
  eq(P.formatUploadBytes(80 * MB), "80.0 MB", "80.0 MB");
  eq(P.formatUploadBytes(512 * MB), "512 MB", "the 512 MB video ceiling");
  eq(P.formatUploadBytes(25 * MB), "25.0 MB", "the 25 MB PDF ceiling");
  eq(P.formatUploadBytes(1.5 * 1024 * MB), "1.5 GB", "1.5 GB");
  eq(P.formatUploadBytes(NaN), "—", "NaN renders an em dash, never 'NaN MB'");
  eq(P.formatUploadBytes(-1), "—", "a negative size renders an em dash");
  eq(P.formatUploadBytes(null), "—", "null renders an em dash");
  eq(P.formatUploadBytes(undefined), "—", "undefined renders an em dash");
  // The two admin surfaces must not drift: the material row formatter and the
  // live progress formatter are the same function.
  ok(
    /return formatUploadBytes\(n\);/.test(read("src/components/admin/session-workflow-shared.tsx")),
    "the shared formatBytes delegates to the single upload-progress definition"
  );

  // =========================================================================
  section("3. Phase machine — the three legs are visually distinct");
  // =========================================================================
  eq(P.phaseForUploadStage("init"), "preparing", "init leg → preparing");
  eq(P.phaseForUploadStage("transfer"), "uploading", "transfer leg → uploading");
  eq(P.phaseForUploadStage("complete"), "confirming", "complete leg → confirming");
  eq(P.phaseForUploadStage("nonsense"), "uploading", "an unknown leg falls back to a busy phase");
  ok(P.isBusyUploadPhase("preparing"), "preparing is busy");
  ok(P.isBusyUploadPhase("uploading"), "uploading is busy");
  ok(P.isBusyUploadPhase("confirming"), "confirming is busy");
  ok(!P.isBusyUploadPhase("idle"), "idle is not busy");
  ok(!P.isBusyUploadPhase("succeeded"), "succeeded is not busy");
  ok(!P.isBusyUploadPhase("failed"), "failed is not busy");
  eq(P.UPLOAD_PHASE_LABEL_KEY.idle, null, "idle has no label (nothing renders)");
  for (const phase of ["preparing", "uploading", "confirming", "succeeded", "failed"]) {
    ok(typeof P.UPLOAD_PHASE_LABEL_KEY[phase] === "string" && P.UPLOAD_PHASE_LABEL_KEY[phase].length > 0, `${phase} has a label key`);
  }
  eq(P.UPLOAD_PHASE_LABEL_KEY.confirming, "admin.565", "confirming has its OWN wording (not the uploading one)");
  ok(P.UPLOAD_PHASE_LABEL_KEY.uploading !== P.UPLOAD_PHASE_LABEL_KEY.confirming, "uploading and confirming are distinguishable");

  // =========================================================================
  section("4. Client state transitions — including 'never claim success early'");
  // =========================================================================
  {
    let s = P.initialUploadState();
    eq(s.phase, "idle", "starts idle");
    eq(s.percent, 0, "starts at 0%");

    s = P.reduceUploadState(s, { type: "start", fileName: "lesson.mp4", totalBytes: 80 * MB });
    eq(s.phase, "preparing", "start → preparing");
    eq(s.fileName, "lesson.mp4", "the file name is carried");
    eq(s.totalBytes, 80 * MB, "the real file size is the bar's total");
    eq(s.percent, 0, "preparing shows 0% — nothing has moved yet");
    ok(s.computable === true, "preparing already knows the total, so the first byte is measurable");
    eq(s.loadedBytes, 0, "preparing has moved 0 bytes — no invented progress");

    s = P.reduceUploadState(s, { type: "stage", stage: "transfer" });
    eq(s.phase, "uploading", "stage(transfer) → uploading");

    s = P.reduceUploadState(s, { type: "progress", loadedBytes: Math.round(32.4 * MB), totalBytes: 80 * MB });
    eq(s.percent, 40.5, "progress is the real byte ratio");
    eq(s.loadedBytes, Math.round(32.4 * MB), "loadedBytes mirror the transport");

    s = P.reduceUploadState(s, { type: "progress", loadedBytes: 80 * MB, totalBytes: 80 * MB });
    eq(s.percent, 100, "the final sample reaches 100%");

    s = P.reduceUploadState(s, { type: "stage", stage: "complete" });
    eq(s.phase, "confirming", "stage(complete) → confirming");
    eq(s.percent, 100, "confirming keeps the honest 100% (bytes are sent, not saved)");

    s = P.reduceUploadState(s, { type: "succeeded", timings: { initMs: 120, transferMs: 4300, completeMs: 900, totalMs: 5320, prepareMs: 0 } });
    eq(s.phase, "succeeded", "succeeded only after the complete leg reported success");
    eq(s.percent, 100, "succeeded shows a full bar");
    eq(s.timings.transferMs, 4300, "per-leg timings are kept for diagnostics");
    eq(s.timings.initMs, 120, "init timing kept");
    eq(s.timings.completeMs, 900, "complete timing kept");

    const stale = P.reduceUploadState(s, { type: "progress", loadedBytes: 1, totalBytes: 80 * MB });
    eq(stale.phase, "succeeded", "a late progress sample cannot walk a finished upload back");
    eq(stale.percent, 100, "a late progress sample cannot move the bar");
    const staleStage = P.reduceUploadState(s, { type: "stage", stage: "transfer" });
    eq(staleStage.phase, "succeeded", "a late stage callback cannot resurrect a finished upload");
  }
  {
    let s = P.reduceUploadState(P.initialUploadState(), { type: "start", fileName: "notes.pdf", totalBytes: 4 * MB });
    s = P.reduceUploadState(s, { type: "stage", stage: "transfer" });
    s = P.reduceUploadState(s, { type: "progress", loadedBytes: 2 * MB, totalBytes: 4 * MB });
    const failure = E.resolveUploadFailure({ stage: "complete", status: 500, code: "DB_CREATE_FAILED", error: "boom" });
    s = P.reduceUploadState(s, { type: "failed", failure });
    eq(s.phase, "failed", "a failure lands in the failed phase");
    eq(s.failure.messageKey, "admin.536", "the failure carries its resolved message key");
    eq(s.percent, 50, "the failure keeps HOW FAR the upload got");
    eq(P.reduceUploadState(s, { type: "stage", stage: "transfer" }).phase, "failed", "a late stage cannot clear a failure");
    eq(P.reduceUploadState(s, { type: "reset" }).phase, "idle", "reset clears the panel");
    eq(P.reduceUploadState(s, { type: "cancelled" }).phase, "idle", "cancellation clears the panel");
  }
  {
    // Buffered fallback (MEDIA_BACKEND=local): the size is known, the byte
    // counter is not — the state must say so instead of showing a fake 0%.
    let s = P.reduceUploadState(P.initialUploadState(), { type: "start", fileName: "lesson.mp4", totalBytes: 8 * MB });
    s = P.reduceUploadState(s, { type: "buffered", totalBytes: 8 * MB });
    eq(s.phase, "uploading", "the buffered fallback is still an upload");
    ok(s.computable === false, "the buffered fallback does NOT claim a computable percentage");
    eq(s.percent, 0, "the buffered fallback shows no invented percentage");
    eq(s.totalBytes, 8 * MB, "the buffered fallback still shows the file size");
  }
  {
    // A start with a missing/zero size must not produce NaN anywhere.
    const s = P.reduceUploadState(P.initialUploadState(), { type: "start", fileName: null, totalBytes: undefined });
    eq(s.percent, 0, "an unknown file size still yields 0%");
    eq(s.totalBytes, 0, "an unknown file size yields totalBytes 0");
    ok(Number.isFinite(s.percent), "percent is always finite");
  }

  // =========================================================================
  section("5. Render throttling — real progress without a re-render storm");
  // =========================================================================
  {
    const first = P.makeUploadProgress(1 * MB, 80 * MB);
    ok(P.shouldReportProgress(null, first, 0) === true, "the first sample always renders");
    const prev = first;
    const tiny = P.makeUploadProgress(1 * MB + 1024, 80 * MB);
    ok(P.shouldReportProgress(prev, tiny, 10) === false, "a sub-interval sample with no visible change is dropped");
    ok(P.shouldReportProgress(prev, tiny, 500) === true, "the same sample renders once the interval elapsed");
    const jump = P.makeUploadProgress(20 * MB, 80 * MB);
    ok(P.shouldReportProgress(prev, jump, 5) === true, "a ≥1 point jump renders immediately");
    const done = P.makeUploadProgress(80 * MB, 80 * MB);
    ok(P.shouldReportProgress(prev, done, 1) === true, "the 100% sample is never dropped");
    const unknown = P.makeUploadProgress(1024, 0);
    ok(P.shouldReportProgress(prev, unknown, 1) === true, "a change in computability renders");
    ok(P.shouldReportProgress(prev, prev, NaN) === false, "a NaN elapsed time cannot force a render");
  }

  // =========================================================================
  section("6. Duplicate-submission protection (double click / double init)");
  // =========================================================================
  {
    const guard = P.createUploadRunGuard();
    ok(guard.acquire() === true, "the first run acquires the latch");
    ok(guard.isBusy() === true, "the latch reports busy");
    ok(guard.acquire() === false, "a second, simultaneous run is refused");
    ok(guard.acquire() === false, "…and keeps being refused while in flight");
    guard.release();
    ok(guard.isBusy() === false, "release clears the latch");
    ok(guard.acquire() === true, "a later run may proceed");
  }
  {
    // The hook must take that latch synchronously, before any request exists.
    const hook = read("src/hooks/use-media-upload.ts");
    ok(/if \(!guardRef\.current\.acquire\(\)\) return \{ ok: false, duplicate: true \};/.test(hook),
      "the hook refuses a concurrent run before creating a request");
    ok(/guardRef\.current\.release\(\)/.test(hook), "the hook releases the latch on every terminal path");
    ok(/if \(guardRef\.current\.isBusy\(\)\) return;/.test(hook), "reset() cannot clear the state of a running upload");
  }

  // =========================================================================
  section("7. VIDEO upload success — init → real progress → complete → success");
  // =========================================================================
  {
    const samples = [0, 2 * MB, Math.round(32.4 * MB), 60 * MB, 80 * MB];
    const xhr = installFakeXHR(transferScript(samples, 200));
    const net = installFetch({ initBody: GRANT });
    const stages = [];
    const progress = [];
    try {
      const out = await directUpload({
        purpose: "SESSION_VIDEO",
        file: fakeFile("lesson.mp4", 80 * MB, "video/mp4"),
        initFields: { batchId: "b1" },
        completeFields: { batchId: "b1", title: "Lesson", publish: true },
        sha256: null,
        onStage: (stage) => stages.push(stage),
        onProgress: (p) => progress.push(p),
      });
      ok(out.ok === true, "video upload completes end-to-end");
      eq(stages, ["init", "transfer", "complete"], "the three legs are reported in order");
      eq(progress.length, samples.length, "one real progress event per transport sample");
      eq(progress[progress.length - 1].percent, 100, "the last progress event is 100%");
      eq(progress[2].percent, 40.5, "an intermediate event reports the real byte ratio");
      ok(progress.every((p) => p.percent >= 0 && p.percent <= 100), "no progress event exceeds 100%");
      ok(
        progress.every((p, i) => i === 0 || p.loadedBytes >= progress[i - 1].loadedBytes),
        "progress is monotonic in real bytes"
      );
      ok(progress.every((p) => p.computable === true), "every event is computable (the total is known)");

      // The wire shape of leg 2 must be exactly the granted PUT.
      eq(xhr.instances.length, 1, "exactly one transfer request");
      const put = xhr.instances[0];
      eq(put.method, "PUT", "the transfer uses the server-granted method");
      eq(put.url, GRANT.uploadUrl, "the transfer targets the init-granted presigned URL");
      eq(put.async, true, "the transfer is asynchronous");
      eq(put.headers["Content-Type"], "video/mp4", "the granted Content-Type is sent byte for byte");
      eq(Object.keys(put.headers), ["Content-Type"], "no other header is added to the cross-origin PUT");
      ok(put.withCredentials === false, "the PUT carries no credential/cookie to the storage origin");
      eq(put.body.size, 80 * MB, "the body is the admin's file");

      // The app legs are the two fixed same-origin POSTs.
      const posts = net.calls.filter((c) => c.method === "POST");
      eq(posts.length, 2, "exactly two app-server calls (init + complete)");
      ok(posts[0].url.endsWith("/api/admin/media-uploads/init"), "leg 1 is the init endpoint");
      ok(posts[1].url.endsWith("/api/admin/media-uploads/complete"), "leg 3 is the complete endpoint");
      const initBody = JSON.parse(posts[0].body);
      eq(initBody.purpose, "SESSION_VIDEO", "init carries the purpose");
      eq(initBody.sizeBytes, 80 * MB, "init carries the real size");
      eq(initBody.contentType, "video/mp4", "init carries the declared type");
      eq(initBody.batchId, "b1", "init carries the purpose-specific field");
      const completeBody = JSON.parse(posts[1].body);
      eq(completeBody.token, GRANT.token, "complete confirms with the signed intent token");
      eq(completeBody.title, "Lesson", "complete carries the completion fields");
      ok(!("uploadUrl" in completeBody), "complete never echoes the presigned URL");

      // Diagnostics are durations only.
      for (const key of ["initMs", "transferMs", "completeMs", "totalMs"]) {
        ok(typeof out.timings[key] === "number" && Number.isFinite(out.timings[key]) && out.timings[key] >= 0, `timings.${key} is a safe duration`);
      }
      const serialized = JSON.stringify(out);
      ok(!serialized.includes("X-Amz-Signature"), "the outcome never carries the presigned URL");
      ok(!serialized.includes(GRANT.token), "the outcome never carries the intent token");
      ok(!serialized.includes("uploadUrl"), "the outcome has no uploadUrl field at all");
    } finally {
      xhr.restore();
      net.restore();
    }
  }

  // =========================================================================
  section("8. PDF upload success — the SAME flow, the SAME progress contract");
  // =========================================================================
  {
    const samples = [0, 1 * MB, 2 * MB, 4 * MB];
    const xhr = installFakeXHR(transferScript(samples, 200));
    const net = installFetch({ initBody: PDF_GRANT, completeBody: { purpose: "LESSON_PDF", mediaAssetId: "ma_2", pdfUrlWritten: false } });
    const stages = [];
    const progress = [];
    try {
      const out = await directUpload({
        purpose: "LESSON_PDF",
        file: fakeFile("notes.pdf", 4 * MB, "application/pdf"),
        initFields: { lessonId: "l1" },
        completeFields: { lessonId: "l1", trackScope: "ARABIC" },
        sha256: "a".repeat(64),
        onStage: (stage) => stages.push(stage),
        onProgress: (p) => progress.push(p),
      });
      ok(out.ok === true, "PDF upload completes end-to-end");
      eq(stages, ["init", "transfer", "complete"], "PDF reports the same three legs in order");
      eq(progress.length, samples.length, "PDF reports one progress event per transport sample");
      eq(progress[progress.length - 1].percent, 100, "PDF progress reaches 100%");
      eq(progress[1].percent, 25, "PDF progress is the real byte ratio (1 of 4 MB)");
      ok(progress.every((p) => p.percent <= 100), "PDF progress never exceeds 100%");
      eq(xhr.instances[0].headers["Content-Type"], "application/pdf", "the PDF grant's Content-Type is sent");
      eq(xhr.instances[0].url, PDF_GRANT.uploadUrl, "the PDF PUT targets its own granted URL");
      const completeBody = JSON.parse(net.calls.filter((c) => c.method === "POST")[1].body);
      eq(completeBody.sha256, "a".repeat(64), "the PDF integrity hash reaches the complete leg");
      eq(completeBody.lessonId, "l1", "the PDF completion fields reach the complete leg");
      eq(completeBody.trackScope, "ARABIC", "the track scope reaches the complete leg");
      ok(typeof out.timings.transferMs === "number", "PDF timings are reported too");
      ok(!JSON.stringify(out).includes("X-Amz-Signature"), "the PDF outcome carries no presigned URL");
    } finally {
      xhr.restore();
      net.restore();
    }
  }

  // =========================================================================
  section("9. Failure legs — init, direct PUT, complete (and what each says)");
  // =========================================================================
  {
    // 9a. INIT failure: no transfer is ever attempted.
    const xhr = installFakeXHR(transferScript([1024], 200));
    const net = installFetch({ initStatus: 415, initBody: { error: "MIME type is not allowed for this upload", code: "INVALID_CONTENT_TYPE" } });
    try {
      const out = await directUpload({
        purpose: "SESSION_VIDEO",
        file: fakeFile("movie.avi", 10 * MB, "video/x-msvideo"),
        initFields: { batchId: "b1" },
        sha256: null,
      });
      ok(out.ok === false, "a rejected init fails the flow");
      eq(out.stage, "init", "the failing leg is init");
      eq(out.status, 415, "the HTTP status is preserved");
      eq(out.code, "INVALID_CONTENT_TYPE", "the server code is preserved");
      eq(xhr.instances.length, 0, "no PUT is attempted after a rejected init");
      eq(net.calls.filter((c) => c.url.endsWith("/complete")).length, 0, "complete is never called");
      const failure = E.resolveUploadFailure(out);
      eq(failure.messageKey, "admin.534", "a wrong file type says so specifically");
      eq(failure.detail, null, "the specific reason replaces the raw server text");
      ok(failure.retriable === false, "a wrong file type is not retriable");
    } finally {
      xhr.restore();
      net.restore();
    }
  }
  {
    // 9b. INIT unreachable → a network message, retriable.
    const previous = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    try {
      const out = await directUpload({
        purpose: "LESSON_PDF",
        file: fakeFile("notes.pdf", 1024, "application/pdf"),
        initFields: { lessonId: "l1" },
        sha256: null,
      });
      ok(out.ok === false && out.stage === "init" && out.status === 0, "an unreachable init is a stage=init status=0 failure");
      const failure = E.resolveUploadFailure(out);
      eq(failure.messageKey, "admin.567", "a network failure gets the network message");
      ok(failure.network === true, "the failure is flagged as a network failure");
      ok(failure.retriable === true, "a network failure is retriable");
    } finally {
      if (previous === undefined) delete globalThis.fetch;
      else globalThis.fetch = previous;
    }
  }
  {
    // 9c. PRESIGNED_UNSUPPORTED must stay branchable (buffered fallback).
    const net = installFetch({ initStatus: 409, initBody: { error: "Direct uploads are not available for the active storage backend", code: "PRESIGNED_UNSUPPORTED" } });
    try {
      const out = await directUpload({
        purpose: "SESSION_VIDEO",
        file: fakeFile("lesson.mp4", 8 * MB, "video/mp4"),
        initFields: { batchId: "b1" },
        sha256: null,
      });
      ok(out.ok === false, "the local backend refuses to presign");
      eq(out.code, "PRESIGNED_UNSUPPORTED", "the fallback code is preserved for callers");
      eq(E.resolveUploadFailure(out).stage, "init", "it is reported as an init-stage outcome");
    } finally {
      net.restore();
    }
  }
  {
    // 9d. DIRECT PUT failures: 403 (grant rejected/expired), 5xx, network.
    for (const [status, retriable, label] of [[403, true, "403 grant rejected"], [500, true, "500 storage error"], [400, false, "400 bad request"]]) {
      const xhr = installFakeXHR(transferScript([4 * MB, 8 * MB], status));
      const net = installFetch({ initBody: GRANT });
      try {
        const out = await directUpload({
          purpose: "SESSION_VIDEO",
          file: fakeFile("lesson.mp4", 8 * MB, "video/mp4"),
          initFields: { batchId: "b1" },
          sha256: null,
        });
        ok(out.ok === false, `${label}: the flow fails`);
        eq(out.stage, "transfer", `${label}: the failing leg is the direct upload`);
        eq(out.status, status, `${label}: the storage status is preserved`);
        eq(out.retriable, retriable, `${label}: retriability is derived from the status`);
        eq(net.calls.filter((c) => c.url.endsWith("/complete")).length, 0, `${label}: complete is never called`);
        const failure = E.resolveUploadFailure(out);
        eq(failure.messageKey, "admin.507", `${label}: the admin is told the storage upload failed`);
        eq(failure.detail, null, `${label}: no raw storage text is surfaced to the admin`);
      } finally {
        xhr.restore();
        net.restore();
      }
    }
    const xhr = installFakeXHR(transferScript([4 * MB], 0));
    const net = installFetch({ initBody: GRANT });
    try {
      const out = await directUpload({
        purpose: "SESSION_VIDEO",
        file: fakeFile("lesson.mp4", 8 * MB, "video/mp4"),
        initFields: { batchId: "b1" },
        sha256: null,
      });
      ok(out.ok === false && out.stage === "transfer" && out.status === 0, "a transport error mid-PUT is a transfer-stage failure");
      const failure = E.resolveUploadFailure(out);
      eq(failure.messageKey, "admin.567", "a dropped connection gets the retryable network message");
      ok(failure.retriable === true, "a dropped connection is retriable");
    } finally {
      xhr.restore();
      net.restore();
    }
  }
  {
    // 9e. COMPLETE failure: the bytes are up, the save is NOT confirmed.
    const xhr = installFakeXHR(transferScript([8 * MB], 200));
    const net = installFetch({ initBody: GRANT, completeStatus: 500, completeBody: { error: "could not connect to server", code: "DB_CREATE_FAILED" } });
    try {
      const out = await directUpload({
        purpose: "SESSION_VIDEO",
        file: fakeFile("lesson.mp4", 8 * MB, "video/mp4"),
        initFields: { batchId: "b1" },
        completeFields: { batchId: "b1", title: "L", publish: true },
        sha256: null,
      });
      ok(out.ok === false, "a failed confirmation fails the flow");
      eq(out.stage, "complete", "the failing leg is the confirmation");
      eq(out.code, "DB_CREATE_FAILED", "the server code survives");
      eq(xhr.instances.length, 1, "the PUT did happen");
      const failure = E.resolveUploadFailure(out);
      eq(failure.messageKey, "admin.536", "an infrastructure failure is named as such");
      ok(failure.retriable === true, "an infrastructure failure is retriable");
      ok(failure.messageKey !== "admin.566", "the UI can never read this as a success");
    } finally {
      xhr.restore();
      net.restore();
    }
  }
  {
    // 9f. A malformed grant still fails closed at init (no PUT attempted).
    const xhr = installFakeXHR(transferScript([1024], 200));
    const net = installFetch({ initBody: { uploadUrl: "", token: "" } });
    try {
      const out = await directUpload({
        purpose: "LESSON_PDF",
        file: fakeFile("notes.pdf", 1024, "application/pdf"),
        initFields: { lessonId: "l1" },
        sha256: null,
      });
      ok(out.ok === false && out.stage === "init", "a malformed grant fails at init");
      eq(xhr.instances.length, 0, "a malformed grant never produces a PUT");
    } finally {
      xhr.restore();
      net.restore();
    }
  }

  // =========================================================================
  section("10. Cancellation — abort mid-transfer, nothing is confirmed");
  // =========================================================================
  {
    const xhr = installFakeXHR(hangingScript(2 * MB, 80 * MB));
    const net = installFetch({ initBody: GRANT });
    const controller = new AbortController();
    const progress = [];
    try {
      const pending = directUpload({
        purpose: "SESSION_VIDEO",
        file: fakeFile("lesson.mp4", 80 * MB, "video/mp4"),
        initFields: { batchId: "b1" },
        sha256: null,
        signal: controller.signal,
        onProgress: (p) => progress.push(p),
      });
      // Let init + the first progress sample happen, then cancel.
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      const out = await pending;
      ok(out.ok === false, "a cancelled upload is a failure outcome (never an exception)");
      eq(out.stage, "transfer", "the cancellation is attributed to the transfer leg");
      ok(out.cancelled === true, "the outcome is explicitly flagged as cancelled");
      eq(out.code, "ABORTED", "the cancellation carries a machine code");
      ok(xhr.instances[0].aborted === true, "the XHR was really aborted");
      eq(net.calls.filter((c) => c.url.endsWith("/complete")).length, 0, "a cancelled upload is NEVER confirmed");
      eq(progress.length, 1, "progress reported before the cancellation is preserved");
      const failure = E.resolveUploadFailure(out);
      ok(failure.cancelled === true, "the resolver recognises a cancellation");
      eq(failure.messageKey, "admin.569", "a cancellation says 'upload cancelled', not an error");
    } finally {
      xhr.restore();
      net.restore();
    }
  }
  {
    // An already-aborted signal must not open a request at all.
    const xhr = installFakeXHR(transferScript([1024], 200));
    const net = installFetch({ initBody: GRANT });
    const controller = new AbortController();
    controller.abort();
    try {
      const out = await directUpload({
        purpose: "SESSION_VIDEO",
        file: fakeFile("lesson.mp4", 8 * MB, "video/mp4"),
        initFields: { batchId: "b1" },
        sha256: null,
        signal: controller.signal,
      });
      ok(out.ok === false && out.cancelled === true, "a pre-aborted signal cancels the flow");
      eq(xhr.instances.length, 0, "a pre-aborted signal never opens the PUT");
    } finally {
      xhr.restore();
      net.restore();
    }
  }

  // =========================================================================
  section("11. Runtimes without XHR — the pinned fetch fallback still uploads");
  // =========================================================================
  {
    const noXhr = removeXHR();
    const previous = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      seen.push({
        url: u,
        method: (opts && opts.method) || "GET",
        headers: opts && opts.headers,
        body: opts && opts.body,
        optionKeys: Object.keys(opts || {}),
      });
      if (u.startsWith("https://bucket.account.r2.invalid/")) return { ok: true, status: 200, json: async () => ({}) };
      if (u.endsWith("/media-uploads/init")) return { ok: true, status: 200, json: async () => GRANT };
      if (u.endsWith("/media-uploads/complete")) return { ok: true, status: 200, json: async () => ({ mediaAssetId: "ma_3" }) };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      const progress = [];
      const out = await directUpload({
        purpose: "SESSION_VIDEO",
        file: fakeFile("lesson.mp4", 8 * MB, "video/mp4"),
        initFields: { batchId: "b1" },
        sha256: null,
        onProgress: (p) => progress.push(p),
      });
      ok(out.ok === true, "the fetch fallback completes the upload");
      eq(progress.length, 0, "the fallback reports NO progress rather than a fake one");
      const put = seen.find((c) => c.url.startsWith("https://bucket.account.r2.invalid/"));
      ok(!!put, "the fallback PUTs to the granted URL");
      eq(put.method, "PUT", "the fallback keeps the PUT method");
      eq(put.headers["Content-Type"], "video/mp4", "the fallback keeps the granted Content-Type");
      ok(!put.optionKeys.includes("credentials"), "the fallback attaches no credentials option");
      ok(!put.optionKeys.includes("redirect"), "the fallback does not override redirect handling");
      eq(put.body.size, 8 * MB, "the fallback sends the admin's file as the body");
    } finally {
      if (previous === undefined) delete globalThis.fetch;
      else globalThis.fetch = previous;
      noXhr.restore();
    }
  }

  // =========================================================================
  section("12. Error mapping — one specific message per cause");
  // =========================================================================
  {
    const cases = [
      [{ stage: "init", status: 0, code: null }, "admin.567", true, "init unreachable → network"],
      [{ stage: "init", status: 415, code: "INVALID_CONTENT_TYPE" }, "admin.534", false, "wrong type"],
      [{ stage: "init", status: 413, code: "INVALID_SIZE" }, "admin.535", false, "too large at init"],
      [{ stage: "init", status: 413, code: "TOO_LARGE" }, "admin.535", false, "too large (complete-style code)"],
      [{ stage: "init", status: 403, code: "QUOTA_EXCEEDED" }, "admin.535", false, "quota exceeded"],
      [{ stage: "init", status: 404, code: "BATCH_NOT_FOUND" }, "admin.537", false, "wrong group"],
      [{ stage: "init", status: 404, code: "LESSON_NOT_FOUND" }, "admin.537", false, "wrong session"],
      [{ stage: "init", status: 409, code: "LESSON_ARCHIVED" }, "admin.537", false, "archived session"],
      [{ stage: "init", status: 503, code: "STORAGE_UNAVAILABLE" }, "admin.536", true, "storage down"],
      [{ stage: "transfer", status: 403, code: null }, "admin.507", true, "grant rejected/expired (a fresh init fixes it)"],
      [{ stage: "transfer", status: 500, code: null }, "admin.507", true, "storage 5xx"],
      [{ stage: "transfer", status: 0, code: null }, "admin.567", true, "connection dropped mid-upload"],
      [{ stage: "complete", status: 500, code: "DB_CREATE_FAILED" }, "admin.536", true, "db write failed"],
      [{ stage: "complete", status: 503, code: "DB_UNAVAILABLE" }, "admin.536", true, "db unavailable"],
      [{ stage: "complete", status: 415, code: "MAGIC_REJECTED" }, "admin.574", false, "not a real PDF"],
      [{ stage: "complete", status: 415, code: "EXTENSION_REJECTED" }, "admin.575", false, "missing .pdf extension"],
      [{ stage: "complete", status: 415, code: "MIME_MISMATCH" }, "admin.534", false, "stored type mismatch"],
      [{ stage: "complete", status: 413, code: "EMPTY_OBJECT" }, "admin.576", false, "empty file"],
      [{ stage: "complete", status: 400, code: "SHA256_MISMATCH" }, "admin.577", true, "corrupted in transit"],
      [{ stage: "complete", status: 500, code: "VERIFICATION_FAILED" }, "admin.577", true, "verification failed"],
      [{ stage: "complete", status: 409, code: "MISSING_OBJECT" }, "admin.577", true, "object vanished"],
      [{ stage: "complete", status: 410, code: "INTENT_EXPIRED" }, "admin.578", true, "grant expired"],
      [{ stage: "complete", status: 400, code: "INTENT_INVALID" }, "admin.578", true, "bad grant"],
      [{ stage: "complete", status: 409, code: "ALREADY_LINKED" }, "admin.579", false, "key linked differently"],
      [{ stage: "complete", status: 400, code: "TITLE_REQUIRED" }, "admin.580", false, "missing title"],
      [{ stage: "complete", status: 400, code: null, error: "SOMETHING_ODD" }, "admin.508", false, "uncoded complete failure → stage text"],
      [{ stage: "init", status: 400, code: null, error: "Bad request" }, "admin.506", false, "uncoded init failure → stage text"],
    ];
    for (const [input, key, retriable, label] of cases) {
      const f = E.resolveUploadFailure(input);
      eq(f.messageKey, key, `${label} → ${key}`);
      eq(f.retriable, retriable, `${label} retriability`);
      eq(f.stage, input.stage, `${label} keeps the failing stage`);
    }
    // The transfer leg never appends raw text (it would be storage internals
    // or an English fallback inside an Arabic toast).
    const transfer = E.resolveUploadFailure({ stage: "transfer", status: 400, code: null, error: "AccessDenied: signature" });
    eq(transfer.detail, null, "the transfer leg surfaces no raw storage text");
    // The app legs keep useful contract text.
    const init = E.resolveUploadFailure({ stage: "init", status: 400, code: null, error: "trackScope must be SHARED, ARABIC, or LANGUAGE" });
    eq(init.detail, "trackScope must be SHARED, ARABIC, or LANGUAGE", "an init contract message is preserved");
    // Cancellation is not an error.
    const cancelled = E.resolveUploadFailure({ stage: "transfer", status: 0, code: "ABORTED", cancelled: true });
    ok(cancelled.cancelled === true && cancelled.messageKey === "admin.569", "cancellation resolves to the cancelled message");
    // The buffered fallback keeps the endpoint's own (already localized) text.
    const buffered = E.resolveUploadFailure({ stage: "buffered", status: 413, code: null, error: "الملف كبير جداً" });
    eq(buffered.rawError, "الملف كبير جداً", "the buffered fallback keeps the server's message");
    eq(E.uploadFailureMessage(buffered, (k) => `T(${k})`), "الملف كبير جداً", "the server's own message wins");
    eq(E.uploadFailureMessage(init, (k) => `T(${k})`), "T(admin.506) — trackScope must be SHARED, ARABIC, or LANGUAGE", "stage text plus the contract detail");
    eq(E.uploadFailureMessage(transfer, (k) => `T(${k})`), "T(admin.507)", "a transfer failure renders only the stage text");
    eq(
      E.uploadFailureMessage(E.resolveUploadFailure({ stage: "buffered", status: 0, code: "NETWORK_ERROR", error: "admin.001" }), (k) => `T(${k})`),
      "T(admin.567)",
      "a generic admin.001 never masks the network message"
    );
    eq(E.uploadFailureMessage({ messageKey: "nope.missing", detail: null, rawError: null }, (k) => (k === "admin.001" ? "generic" : "")), "generic", "a missing dictionary entry falls back to admin.001");
    // Existing behaviour that must not regress.
    eq(E.uploadErrorCodeKey("INVALID_CONTENT_TYPE"), "admin.534", "uploadErrorCodeKey(INVALID_CONTENT_TYPE) unchanged");
    eq(E.uploadErrorCodeKey("SOMETHING_NEW"), null, "an unknown code still resolves to null");
    ok(E.isUploadCodeRetriable("STORAGE_UNAVAILABLE") === true, "storage failure still retriable");
    ok(E.isUploadCodeRetriable("INVALID_CONTENT_TYPE") === false, "a bad file type is still not retriable");
  }

  // =========================================================================
  section("13. Media contract unchanged (video + PDF rules are server-side)");
  // =========================================================================
  eq(Media.MAX_VIDEO_BYTES, 512 * MB, "video ceiling is still 512 MB");
  eq(Media.MAX_PDF_BYTES, 25 * MB, "PDF ceiling is still 25 MB");
  for (const mime of ["video/mp4", "video/webm", "video/ogg", "video/quicktime"]) {
    ok(Media.isAllowedVideoMime(mime) === true, `${mime} is still accepted`);
  }
  for (const mime of ["video/x-msvideo", "video/x-matroska", "application/x-msdownload", "application/pdf", ""]) {
    ok(Media.isAllowedVideoMime(mime) === false, `${mime || "(empty)"} is still rejected as a video`);
  }
  ok(Media.isAllowedPdfMime("application/pdf") === true, "application/pdf is still accepted");
  ok(Media.isAllowedPdfMime("application/pdf; charset=binary") === true, "a parameterised PDF type is still accepted");
  ok(Media.isAllowedPdfMime("text/html") === false, "text/html is still rejected as a PDF");
  ok(Media.hasPdfExtension("notes.pdf") === true, ".pdf extension still required");
  ok(Media.hasPdfExtension("notes.PDF") === true, ".PDF extension still accepted");
  ok(Media.hasPdfExtension("notes.pdf.exe") === false, "a disguised extension is still rejected");
  ok(Media.hasPdfMagicBytes(Buffer.from("%PDF-1.7\n...")) === true, "%PDF- magic at offset 0 is still accepted");
  ok(Media.hasPdfMagicBytes(Buffer.from("<html><body>%PDF-")) === true, "the shipped scan window still finds %PDF- inside the first 1 KB");
  ok(Media.hasPdfMagicBytes(Buffer.concat([Buffer.from("<html>".padEnd(2048, "x")), Buffer.from("%PDF-1.7")])) === false, "a %PDF- hidden beyond the 1 KB window is still rejected");
  ok(Media.hasPdfMagicBytes(Buffer.from("<html>")) === false, "HTML without the magic is still rejected");
  ok(Media.hasPdfMagicBytes(Buffer.from("")) === false, "an empty buffer is still rejected");
  ok(Media.hasPdfMagicBytes(null) === false, "null bytes are still rejected");
  {
    // The browser surfaces must not have widened the accepted types.
    const videos = read("src/components/admin/session-videos-view.tsx");
    ok(/accept="video\/mp4,video\/webm,video\/ogg,video\/quicktime"/.test(videos), "the video picker still accepts exactly the four supported types");
    const pdfs = read("src/components/admin/session-pdf-manager.tsx");
    eq((pdfs.match(/accept="application\/pdf,\.pdf"/g) || []).length, 2, "both PDF pickers still accept application/pdf,.pdf only");
  }

  // =========================================================================
  section("14. R2 / CSP exact-origin behaviour unchanged (no wildcards)");
  // =========================================================================
  {
    const notRequired = resolveDirectUploadOrigin({ MEDIA_BACKEND: "local" });
    eq(notRequired.status, "not-required", "MEDIA_BACKEND=local adds nothing to connect-src");
    eq(notRequired.origin, null, "no origin is derived without the s3 backend");

    const good = resolveDirectUploadOrigin({
      MEDIA_BACKEND: "s3",
      R2_BUCKET: "codemind-media",
      R2_ACCOUNT_ID: "abc123def456",
    });
    eq(good.status, "ok", "a valid R2 config derives the upload origin");
    eq(good.origin, "https://codemind-media.abc123def456.r2.cloudflarestorage.com", "the origin is the EXACT bucket virtual-host");
    ok(!good.origin.includes("*"), "the derived origin contains no wildcard");

    const explicit = resolveDirectUploadOrigin({
      MEDIA_BACKEND: "s3",
      R2_BUCKET: "codemind-media",
      R2_S3_ENDPOINT: "https://abc123def456.r2.cloudflarestorage.com",
    });
    eq(explicit.origin, good.origin, "an explicit endpoint derives the same exact origin");

    for (const [label, env] of [
      ["missing bucket", { MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: "abc123" }],
      ["missing account", { MEDIA_BACKEND: "s3", R2_BUCKET: "codemind-media" }],
      ["http endpoint", { MEDIA_BACKEND: "s3", R2_BUCKET: "codemind-media", R2_S3_ENDPOINT: "http://abc123.r2.cloudflarestorage.com" }],
      ["endpoint with a path", { MEDIA_BACKEND: "s3", R2_BUCKET: "codemind-media", R2_S3_ENDPOINT: "https://abc123.r2.cloudflarestorage.com/bucket" }],
      ["bucket with a slash", { MEDIA_BACKEND: "s3", R2_BUCKET: "bad/bucket", R2_ACCOUNT_ID: "abc123" }],
    ]) {
      const bad = resolveDirectUploadOrigin(env);
      eq(bad.status, "invalid", `${label} → invalid`);
      eq(bad.origin, null, `${label} → nothing added (fail closed)`);
    }
    // The policy module itself is untouched by this phase.
    const csp = read("src/lib/content-security-policy.ts");
    ok(csp.includes("resolveDirectUploadOrigin"), "connect-src still derives the upload origin from the shared contract");
    // The exhaustive CSP pins live in tests/csp-direct-upload-connect-src.test.js
    // and tests/r2-csp-exact-origin-followup.test.js (both re-run for this
    // phase); this suite only proves the decision is still derived from the
    // shared exact-origin contract and never widened by hand.
    ok(!/"\*"|'\*'/.test(csp), "the CSP module hardcodes no wildcard source");
    ok(read("src/lib/r2-upload-origin.ts").includes('R2_DEFAULT_HOST_SUFFIX = ".r2.cloudflarestorage.com"'), "the exact-origin contract module is unchanged in shape");
  }

  // =========================================================================
  section("15. No secret can ride the new progress/diagnostics surface");
  // =========================================================================
  {
    const files = [
      "src/lib/upload-progress.ts",
      "src/lib/upload-error-text.ts",
      "src/lib/direct-upload.ts",
      "src/hooks/use-media-upload.ts",
      "src/components/admin/upload-progress-panel.tsx",
      "src/components/admin/session-videos-view.tsx",
      "src/components/admin/session-pdf-manager.tsx",
    ];
    for (const rel of files) {
      const t = read(rel);
      ok(!/R2_(ACCOUNT_ID|ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET|REGION|S3_ENDPOINT)/.test(t), `${rel}: no R2_* configuration reference`);
      ok(!/NEXT_PUBLIC[A-Z0-9_]*(R2|S3|AWS)[A-Z0-9_]*/.test(t), `${rel}: no NEXT_PUBLIC storage variable`);
      ok(!/accessKeyId|secretAccessKey/i.test(t), `${rel}: no credential field`);
      ok(!/r2\.cloudflarestorage\.com/.test(t), `${rel}: no hardcoded storage endpoint`);
      ok(!/storageKey/.test(t), `${rel}: no storage key handling`);
    }
    // The dev-only timing log prints durations and nothing else.
    const progressSrc = read("src/lib/upload-progress.ts");
    const logger = /export function logUploadTimings\([\s\S]*?\n\}\n/.exec(progressSrc);
    ok(!!logger, "the timing logger exists");
    const loggerSrc = logger ? logger[0] : "";
    ok(!/uploadUrl|token|signature|Authorization|cookie/i.test(loggerSrc), "the timing logger never prints a URL, token or credential");
    ok(/NODE_ENV === "production"/.test(loggerSrc), "the timing logger is a no-op in production");
    ok(!/setInterval/.test(progressSrc), "progress is never driven by an interval timer");
    ok(!/setInterval/.test(read("src/hooks/use-media-upload.ts")), "the hook never fakes progress with a timer");
    ok(!/setInterval/.test(read("src/lib/direct-upload.ts")), "the transport never fakes progress with a timer");
    ok(/successTimerRef\.current = setTimeout\(/.test(read("src/hooks/use-media-upload.ts")), "the only timer in the hook is the success-state hold");
    // Progress reaches the UI only from a transport event.
    const du = read("src/lib/direct-upload.ts");
    ok(/xhr\.upload\.onprogress = /.test(du), "progress comes from the XHR upload event");
    ok(/input\.onProgress\(makeUploadProgress\(/.test(du), "the reported progress is derived from real byte counters");
    const hookSrc = read("src/hooks/use-media-upload.ts");
    ok(/onProgress: \(progress\) =>/.test(hookSrc), "the hook forwards transport progress only");
    ok(/shouldReportProgress\(/.test(hookSrc), "the hook throttles renders with the shared gate");
  }

  // =========================================================================
  section("16. Both surfaces share ONE uploader (video/PDF parity)");
  // =========================================================================
  {
    for (const rel of ["src/components/admin/session-videos-view.tsx", "src/components/admin/session-pdf-manager.tsx"]) {
      const t = read(rel);
      ok(t.includes("useMediaUpload"), `${rel} uses the shared upload state machine`);
      ok(t.includes("UploadProgressPanel"), `${rel} renders the shared progress panel`);
      ok(t.includes("uploadFailureMessage"), `${rel} presents failures through the shared resolver`);
      ok(t.includes("onCancel"), `${rel} offers cancellation`);
      ok(/onRetry=\{retryUpload\}/.test(t), `${rel} offers a retry of the same file`);
      ok(/disabled=\{(?:busy|uploading|!file \|\| uploading)\}/.test(t), `${rel} disables its action while busy`);
      ok(!/fake|simulate/i.test(t), `${rel} contains no simulated progress`);
    }
    const videos = read("src/components/admin/session-videos-view.tsx");
    ok(videos.includes('purpose: "SESSION_VIDEO"'), "the video surface uploads with purpose SESSION_VIDEO");
    ok(!/out\.code === "PRESIGNED_UNSUPPORTED"/.test(videos), "the video surface no longer branches on the fallback code inline (the hook owns it)");
    ok(/normalizeExternalVideoUrl\(videoUrl\)/.test(videos), "the external URL contract check is unchanged");
    ok(/admin\.538/.test(videos), "the supported-URL hint is unchanged");
    const pdfs = read("src/components/admin/session-pdf-manager.tsx");
    ok(pdfs.includes('purpose: "LESSON_PDF"'), "the PDF surface uploads with purpose LESSON_PDF");
    ok(!/out\.code === "PRESIGNED_UNSUPPORTED"/.test(pdfs), "the PDF surface no longer branches on the fallback code inline (the hook owns it)");
    ok(/sha256HexOfFile/.test(pdfs), "the PDF integrity hash is still computed");
    ok(/prepare: async \(\) => \(\{ sha256: await sha256HexOfFile\(f\) \}\)/.test(pdfs), "the hash runs inside the visible preparing phase");
    ok(pfsIncludesMaterials(pdfs), "the PDF surface still calls the material API");
    ok(/new FormData\(\)/.test(pdfs), "the buffered fallback is still multipart");
    ok(/method: "DELETE"/.test(pdfs), "deactivation is unchanged");
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Media upload progress suite: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(" -", f);
    process.exit(1);
  }
}

function pfsIncludesMaterials(src) {
  return src.includes("/api/admin/lessons/${encodeURIComponent(lessonId)}/materials");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
