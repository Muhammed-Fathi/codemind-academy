// CodeMind Academy — CSP connect-src × direct browser upload (R2) tests.
//
// Pins the connect-src contract for the Phase 23 direct browser upload:
//
//   PRODUCTION INCIDENT (2026-09): with MEDIA_BACKEND=s3 the admin browser
//   received the presigned R2 URL from `POST /api/admin/media-uploads/init`
//   (→ 200 OK), but the PUT never left the tab — the browser blocked it:
//
//     "Connecting to https://<R2 endpoint>/… violates the following Content
//      Security Policy directive: connect-src 'self'."
//
//   Root cause: `src/lib/content-security-policy.ts` hardcoded
//   `connect-src: ["'self'"]` (the Phase 20 assumption "no client-side
//   cross-origin fetch exists" predates the direct-upload flow).
//
// THE CONTRACT pinned here (all offline, no network, no Prisma):
//   * `connect-src` always keeps 'self'.
//   * ONLY when MEDIA_BACKEND=s3 does it gain exactly ONE more source: the
//     trusted R2 origin derived from the SAME env the S3 client uses
//     (R2_S3_ENDPOINT, else https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com).
//   * NO wildcards, ever ('*', 'https:', 'https://*', 'http:').
//   * NO unrelated external origin is ever allowed.
//   * a missing or malformed endpoint contributes NOTHING — the policy stays
//     'self' (strictly no weaker than the pre-fix policy).
//   * every OTHER directive is byte-identical with and without the R2 origin.
//   * local development behaviour is unchanged (MEDIA_BACKEND=local).
//
// Run: node tests/csp-direct-upload-connect-src.test.js
// Exit code: 0 = all pass, 1 = failure.
//
// NOTE: sections 3–4 FAIL against main (where connect-src is hardcoded to
// 'self' and `resolveDirectUploadConnectOrigin` does not exist) and pass with
// the fix — exactly the regression this suite exists to pin.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");

let pass = 0;
let fail = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error("FAIL:", label);
  }
};
const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b, `${label} (got ${a}, want ${b})`);
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// Compile the PURE CSP module (same pattern as the Phase 20 suite).
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-csp-direct-upload-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      moduleResolution: "node",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      types: ["node"],
      typeRoots: [path.join(REPO, "node_modules/@types")],
      baseUrl: REPO,
      paths: { "@/*": ["src/*"] },
      rootDir: REPO,
      outDir: OUT,
    },
    files: [path.join(REPO, "src/lib/content-security-policy.ts")],
  })
);
execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, {
  cwd: REPO,
  stdio: "pipe",
});
const Csp = require(path.join(OUT, "src", "lib", "content-security-policy.js"));

/** Production CSP header for the given env (helper). */
const prodCsp = (env) => Csp.decideCspHeader({ NODE_ENV: "production", ...env });
const connectSrcOf = (env) => Csp.parseCsp(prodCsp(env).value)["connect-src"];

// The canonical trusted origin used across the scenarios below.
const ACCT = "acme123";
const R2_ORIGIN = `https://${ACCT}.r2.cloudflarestorage.com`;

// ---------------------------------------------------------------------------
section("1. 'self' always remains allowed (backend-independent baseline)");
// ---------------------------------------------------------------------------
{
  ok(
    connectSrcOf({}).includes("'self'"),
    "connect-src keeps 'self' (default deployment, no backend configured)"
  );
  ok(
    connectSrcOf({ MEDIA_BACKEND: "local" }).includes("'self'"),
    "connect-src keeps 'self' (MEDIA_BACKEND=local)"
  );
  // Even with R2 variables present, a non-s3 backend must not widen anything.
  eq(
    connectSrcOf({
      MEDIA_BACKEND: "local",
      R2_ACCOUNT_ID: ACCT,
      R2_S3_ENDPOINT: `https://${ACCT}.r2.cloudflarestorage.com`,
    }),
    ["'self'"],
    "MEDIA_BACKEND=local + R2 env present → connect-src is EXACTLY 'self' (local behaviour preserved)"
  );
  eq(
    connectSrcOf({ R2_ACCOUNT_ID: ACCT }),
    ["'self'"],
    "R2 env present but MEDIA_BACKEND unset → connect-src is EXACTLY 'self'"
  );
}

// ---------------------------------------------------------------------------
section("2. MEDIA_BACKEND=s3 adds exactly the trusted R2 origin");
// ---------------------------------------------------------------------------
{
  ok(
    typeof Csp.resolveDirectUploadConnectOrigin === "function",
    "module exposes resolveDirectUploadConnectOrigin (fails on main)"
  );
  // Optional chaining so a run against main fails with clean assertions
  // (one per scenario) instead of crashing on the missing export.
  const decide = (env) =>
    Csp.resolveDirectUploadConnectOrigin?.({ ...env });

  // Derived from R2_ACCOUNT_ID (the same resolution resolveR2Config uses).
  const fromAccount = decide({ MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: ACCT });
  ok(fromAccount && fromAccount.status === "ok", "s3 + R2_ACCOUNT_ID → status ok");
  ok(
    fromAccount && fromAccount.origin === R2_ORIGIN,
    "s3 + R2_ACCOUNT_ID → origin is https://<account>.r2.cloudflarestorage.com"
  );
  eq(
    connectSrcOf({ MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: ACCT }),
    ["'self'", R2_ORIGIN],
    "connect-src = ['self', <R2 origin>] (exact list, in order)"
  );

  // Case-insensitive backend selector, case-normalised host (matches
  // resolveStorageBackendName / URL host normalisation).
  eq(
    connectSrcOf({ MEDIA_BACKEND: "S3", R2_ACCOUNT_ID: ACCT.toUpperCase() }),
    ["'self'", R2_ORIGIN],
    "MEDIA_BACKEND=S3 (case-insensitive) + uppercase account → same exact origin"
  );

  // Explicit R2_S3_ENDPOINT wins, mirroring resolveR2Config.
  eq(
    connectSrcOf({
      MEDIA_BACKEND: "s3",
      R2_ACCOUNT_ID: "other-account",
      R2_S3_ENDPOINT: R2_ORIGIN,
    }),
    ["'self'", R2_ORIGIN],
    "R2_S3_ENDPOINT overrides the account-derived default"
  );
  eq(
    connectSrcOf({
      MEDIA_BACKEND: "s3",
      R2_S3_ENDPOINT: `https://${ACCT}.eu.r2.cloudflarestorage.com`,
    }),
    ["'self'", `https://${ACCT}.eu.r2.cloudflarestorage.com`],
    "jurisdiction endpoint (eu.) is allowed as an exact origin"
  );
  eq(
    connectSrcOf({
      MEDIA_BACKEND: "s3",
      R2_S3_ENDPOINT: `${R2_ORIGIN}/`,
    }),
    ["'self'", R2_ORIGIN],
    "endpoint with a trailing slash → bare origin (no path inserted)"
  );

  // Serialized header contract, exactly as a browser parses it.
  ok(
    prodCsp({ MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: ACCT }).value.includes(
      `connect-src 'self' ${R2_ORIGIN}`
    ),
    "serialized header contains `connect-src 'self' <R2 origin>`"
  );
  ok(
    prodCsp({ MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: ACCT }).header ===
      "Content-Security-Policy",
    "with the R2 origin the CSP is still ENFORCED (not report-only)"
  );

  // Development keeps its exact one-directive widening — plus the origin when
  // the backend is s3 (dev behaviour otherwise unchanged).
  const dev = Csp.parseCsp(
    Csp.decideCspHeader({
      NODE_ENV: "development",
      MEDIA_BACKEND: "s3",
      R2_ACCOUNT_ID: ACCT,
    }).value
  );
  eq(
    dev["connect-src"],
    ["'self'", R2_ORIGIN],
    "development + s3 → connect-src includes the R2 origin"
  );
  ok(
    dev["script-src"].includes("'unsafe-eval'"),
    "development still widens script-src with 'unsafe-eval' (HMR) — untouched"
  );
}

// ---------------------------------------------------------------------------
section("3. Fail-closed: missing/malformed endpoint NEVER weakens the policy");
// ---------------------------------------------------------------------------
{
  const cases = [
    ["s3 backend with NO R2 env at all", { MEDIA_BACKEND: "s3" }, "R2_S3_ENDPOINT or R2_ACCOUNT_ID"],
    ["s3 backend with EMPTY R2_ACCOUNT_ID (would derive a leading-dot host)", { MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: "" }, null],
    ["s3 backend with WHITESPACE-only R2_ACCOUNT_ID", { MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: "   " }, null],
    ["http:// endpoint (HTTPS required)", { MEDIA_BACKEND: "s3", R2_S3_ENDPOINT: `http://${ACCT}.r2.cloudflarestorage.com` }, null],
    ["path in endpoint", { MEDIA_BACKEND: "s3", R2_S3_ENDPOINT: `${R2_ORIGIN}/prefix` }, null],
    ["query string in endpoint", { MEDIA_BACKEND: "s3", R2_S3_ENDPOINT: `${R2_ORIGIN}?X-Amz-Signature=x` }, null],
    ["fragment in endpoint", { MEDIA_BACKEND: "s3", R2_S3_ENDPOINT: `${R2_ORIGIN}#frag` }, null],
    ["credentials in endpoint", { MEDIA_BACKEND: "s3", R2_S3_ENDPOINT: "https://key:secret@storage.example.com" }, null],
    ["not a URL", { MEDIA_BACKEND: "s3", R2_S3_ENDPOINT: "not-a-url" }, null],
    ["javascript: pseudo-URL", { MEDIA_BACKEND: "s3", R2_S3_ENDPOINT: "javascript:alert(1)" }, null],
    ["empty host", { MEDIA_BACKEND: "s3", R2_S3_ENDPOINT: "https://" }, null],
    ["dot-only relative host", { MEDIA_BACKEND: "s3", R2_S3_ENDPOINT: "https://." }, null],
    ["empty-label host", { MEDIA_BACKEND: "s3", R2_S3_ENDPOINT: "https://a..b.example" }, null],
    ["path injection via R2_ACCOUNT_ID", { MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: "evil.com/inject" }, null],
    ["ftp scheme via R2_ACCOUNT_ID is impossible; endpoint ftp:", { MEDIA_BACKEND: "s3", R2_S3_ENDPOINT: `ftp://${ACCT}.r2.cloudflarestorage.com` }, null],
  ];
  for (const [label, env] of cases) {
    eq(connectSrcOf(env), ["'self'"], `${label} → connect-src is EXACTLY 'self' (fail closed)`);
  }

  // Reasons name VARIABLES, never values — safe for boot logs, no secret echo.
  const missing = { status: "invalid", reason: "" };
  const withCreds = (Csp.resolveDirectUploadConnectOrigin?.({
    MEDIA_BACKEND: "s3",
    R2_S3_ENDPOINT: "https://key:secret@storage.example.com",
  }) ?? missing);
  ok(
    withCreds.status === "invalid" &&
      !withCreds.reason.includes("key:secret") &&
      !withCreds.reason.includes("storage.example.com"),
    "invalid-endpoint reason names the VARIABLE, never echoes the value"
  );
  const notUrl = (Csp.resolveDirectUploadConnectOrigin?.({
    MEDIA_BACKEND: "s3",
    R2_S3_ENDPOINT: "not-a-url",
  }) ?? missing);
  ok(
    notUrl.status === "invalid" && !notUrl.reason.includes("not-a-url"),
    "unparseable-endpoint reason never echoes the value"
  );
}

// ---------------------------------------------------------------------------
section("4. No wildcards, no unrelated origins, other directives intact");
// ---------------------------------------------------------------------------
{
  const env = { MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: ACCT };
  const prod = prodCsp(env);
  const withR2 = Csp.parseCsp(prod.value);
  const baseline = Csp.parseCsp(prodCsp({}).value); // same build, backend off

  // (a) 'self' remains allowed WITH the R2 origin present.
  ok(withR2["connect-src"].includes("'self'"), "'self' remains allowed alongside the R2 origin");

  // (b) The configured R2 origin is allowed…
  ok(withR2["connect-src"].includes(R2_ORIGIN), "configured R2 origin is allowed in connect-src");

  // …and it is the ONLY cross-origin source added.
  eq(
    withR2["connect-src"].filter((s) => s !== "'self'" && s !== R2_ORIGIN),
    [],
    "connect-src contains NOTHING beyond 'self' + the configured R2 origin"
  );

  // (c) Wildcard origins are NOT introduced — in connect-src or anywhere new.
  for (const token of ["*", "https:", "http:", "https://*", "http://*", "'unsafe-inline'", "data:", "blob:"]) {
    ok(
      !withR2["connect-src"].includes(token),
      `connect-src never contains the wildcard/loose token ${JSON.stringify(token)}`
    );
  }
  ok(
    !/\bconnect-src[^;]*\*/.test(prod.value),
    "serialized connect-src carries no '*' at all"
  );

  // (d) Unrelated arbitrary external origins are NOT allowed.
  for (const evil of ["https://evil.example", "https://evil.example:443", "http://localhost:9000"]) {
    ok(
      !withR2["connect-src"].includes(evil),
      `unrelated external origin ${evil} is NOT allowed in connect-src`
    );
  }
  ok(
    !prod.value.includes("evil.example"),
    "no unrelated external origin appears anywhere in the header"
  );

  // (e) Every OTHER directive is byte-identical to the baseline policy.
  for (const directive of Object.keys(baseline)) {
    if (directive === "connect-src") continue;
    eq(
      withR2[directive],
      baseline[directive],
      `${directive} is unchanged when the R2 origin is added`
    );
  }
  eq(
    Object.keys(withR2).sort(),
    Object.keys(baseline).sort(),
    "no directive was added or removed"
  );

  // (f) Operator switches behave exactly as before, R2 backend or not.
  ok(
    Csp.decideCspHeader({ NODE_ENV: "production", CSP_DISABLED: "1", ...env }) === null,
    "CSP_DISABLED=1 still removes the header entirely (kill-switch intact)"
  );
  eq(
    Csp.decideCspHeader({ NODE_ENV: "production", CSP_REPORT_ONLY: "1", ...env }).header,
    "Content-Security-Policy-Report-Only",
    "CSP_REPORT_ONLY=1 still downgrades to report-only (rollout path intact)"
  );
  ok(
    !Csp.containsUnsafeEval(prod.value),
    "production CSP still never contains 'unsafe-eval' (R2 origin or not)"
  );

  // (g) Purity: a decision must never mutate shared module state — the next
  // call with NO env must still be the plain 'self' baseline.
  eq(
    Csp.parseCsp(Csp.decideCspHeader({ NODE_ENV: "production" }).value)["connect-src"],
    ["'self'"],
    "module state stays pristine after an s3 decision (no cross-call leakage)"
  );
}

// ---------------------------------------------------------------------------
section("5. Deployment requirement is documented (source pin)");
// ---------------------------------------------------------------------------
{
  const moduleSrc = fs.readFileSync(
    path.join(REPO, "src/lib/content-security-policy.ts"),
    "utf8"
  );
  ok(
    /DEPLOYMENT REQUIREMENT/.test(moduleSrc) &&
      /BUILD time/.test(moduleSrc),
    "CSP module documents the build-time env requirement for operators"
  );
  const envExample = fs.readFileSync(path.join(REPO, ".env.example"), "utf8");
  ok(
    /connect-src/.test(envExample),
    ".env.example documents the CSP connect-src effect of the R2 variables"
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(64)}`);
console.log(`csp-direct-upload-connect-src: ${pass} passed, ${fail} failed`);
console.log(`${"=".repeat(64)}`);
if (fail > 0) {
  console.error("\nFailed assertions:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
