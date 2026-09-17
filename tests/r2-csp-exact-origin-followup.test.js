// R2 CSP Exact-Origin Follow-up — regression proof (Phase 90 follow-up).
// Synthetic only — never uses production account IDs, bucket URLs, secrets.
//
// Proves the CSP matches the actual SDK presign host (virtual-hosted) and
// does NOT allow only the account endpoint when R2_BUCKET is configured.

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-r2-csp-followup-"));
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
    files: [path.join(REPO, "src/lib/content-security-policy.ts"), path.join(REPO, "src/lib/r2-upload-origin.ts")],
  })
);
execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, {
  cwd: REPO,
  stdio: "pipe",
});
const Csp = require(path.join(OUT, "src", "lib", "content-security-policy.js"));

let pass = 0;
let fail = 0;
const errors = [];
function ok(cond, label) {
  if (cond) pass++;
  else { fail++; errors.push(label); console.error("FAIL:", label); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)} want ${JSON.stringify(b)})`);

const ACCT = "abc123";
const BUCKET = "codemind-academy-media";
const VIRTUAL_HOSTED_ORIGIN = `https://${BUCKET}.${ACCT}.r2.cloudflarestorage.com`;
const ACCOUNT_ONLY_ORIGIN = `https://${ACCT}.r2.cloudflarestorage.com`;

function connectSrcOf(env) {
  const csp = Csp.decideCspHeader({ NODE_ENV: "production", ...env });
  return Csp.parseCsp(csp.value)["connect-src"];
}

// ---------------------------------------------------------------------------
// Synthetic contract proof
// ---------------------------------------------------------------------------
console.log("\n=== R2 CSP Exact-Origin Follow-up (synthetic) ===");

// 1. Virtual-hosted origin is present when bucket + account configured.
ok(
  connectSrcOf({ MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: ACCT, R2_BUCKET: BUCKET }).includes(VIRTUAL_HOSTED_ORIGIN),
  "CSP contains exact virtual-hosted upload origin (bucket + account)"
);

// 2. CSP does NOT contain only account endpoint when bucket is present.
ok(
  !connectSrcOf({ MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: ACCT, R2_BUCKET: BUCKET }).includes(ACCOUNT_ONLY_ORIGIN),
  "CSP does NOT merely contain account endpoint when bucket-prefixed target is active"
);

// 3. No wildcards anywhere.
{
  const header = Csp.decideCspHeader({ NODE_ENV: "production", MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: ACCT, R2_BUCKET: BUCKET }).value;
  ok(!header.includes("*"), "CSP has no wildcard '*'");
  ok(!header.includes("https://*"), "CSP has no 'https://*'");
}

// 4. Unrelated bucket hostname is NOT allowed.
ok(
  !connectSrcOf({ MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: ACCT, R2_BUCKET: BUCKET }).includes(`https://other-bucket.${ACCT}.r2.cloudflarestorage.com`),
  "unrelated bucket hostname is not allowed"
);

// 5. Local backend stays self-only.
ok(
  JSON.stringify(connectSrcOf({})) === JSON.stringify(["'self'"]),
  "local / default backend → connect-src exactly ['self']"
);
ok(
  JSON.stringify(connectSrcOf({ MEDIA_BACKEND: "local", R2_ACCOUNT_ID: ACCT, R2_BUCKET: BUCKET })) === JSON.stringify(["'self'"]),
  "MEDIA_BACKEND=local + R2 env → connect-src stays exactly ['self']"
);

// 6. Malformed bucket fails closed (no origin added, stays 'self').
ok(
  connectSrcOf({ MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: ACCT, R2_BUCKET: "" }).includes("'self'") && connectSrcOf({ MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: ACCT, R2_BUCKET: "" }).length === 1,
  "empty R2_BUCKET → fail closed (only 'self')"
);
ok(
  connectSrcOf({ MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: ACCT, R2_BUCKET: "bad../bucket" }).length === 1,
  "malformed R2_BUCKET (bad../bucket) → fail closed"
);

// 7. Malformed account fails closed.
ok(
  connectSrcOf({ MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: "", R2_BUCKET: BUCKET }).length === 1,
  "empty R2_ACCOUNT_ID → fail closed"
);
ok(
  connectSrcOf({ MEDIA_BACKEND: "s3", R2_ACCOUNT_ID: "evil..com", R2_BUCKET: BUCKET }).length === 1,
  "malformed R2_ACCOUNT_ID (double-dot) → fail closed"
);

// 8. Explicit endpoint still derives virtual-hosted with bucket.
{
  const endpoint = `https://${ACCT}.eu.r2.cloudflarestorage.com`;
  const expected = `https://${BUCKET}.${ACCT}.eu.r2.cloudflarestorage.com`;
  ok(
    connectSrcOf({ MEDIA_BACKEND: "s3", R2_S3_ENDPOINT: endpoint, R2_BUCKET: BUCKET }).includes(expected),
    "explicit jurisdiction endpoint derives correct virtual-hosted origin"
  );
}

// 9. Verify against actual SDK-produced hostname (not guessed independently).
{
  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  // We only assert the host shape produced by the SDK matches CSP — no network.
  (async () => {
    const client = new S3Client({ region: "auto", endpoint: `https://${ACCT}.r2.cloudflarestorage.com`, credentials: { accessKeyId: "X", secretAccessKey: "Y" } });
    const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: "t.jpg", ContentType: "image/jpeg" });
    const url = await getSignedUrl(client, cmd, { expiresIn: 60 });
    const sdkHost = new URL(url).hostname;
    ok(sdkHost === VIRTUAL_HOSTED_ORIGIN.replace("https://", ""), `SDK hostname matches CSP: ${sdkHost}`);
    if (fail > 0) {
      console.error("FAILURES:", errors);
      process.exit(1);
    }
    console.log(`\nResults: ${pass} pass, ${fail} fail`);
    console.log("VERDICT: READY FOR GIT DELIVERY — synthetic contract proven, no production secrets, no schema change.");
  })();
}
