// CodeMind Academy — Phase 26H: Vercel standalone+adapter release gate (offline suite).
//
// WHY THIS TEST EXISTS
// --------------------
// Upstream bug vercel/next.js#96646: Next.js 16.3.0–16.3.4 crash the build when
// `output: "standalone"` is combined with a deployment adapter:
//
//     Running onBuildComplete from <adapter>
//     > Build error occurred
//     Error: ENOENT: no such file or directory, open '.next/next-server.js.nft.json'
//
// Next 16.3.0 (vercel/next.js#93684) stopped emitting the whole-app NFT when an
// adapter is configured, while the `output: "standalone"` finalizer and the
// platform builder still read it. Vercel's Next.js builder injects its adapter
// via `NEXT_ADAPTER_PATH` during the platform rollout, so **every Vercel
// deployment of a standalone-configured app on 16.3.0–16.3.4 fails at
// onBuildComplete** — reproduced locally for this repo with a two-line stub
// adapter (exit 1 on 16.3.4, exit 0 on 16.3.5; identical standalone file count).
// Fixed upstream by vercel/next.js#97287, backported to the 16.3 line and
// released in **16.3.5** (published 2026-09-15).
//
// This suite is a static release gate: it fails loudly if the repo is ever
// downgraded back into the broken window (or if the standalone config is
// changed in a way that silently drops the fix), so the production build cannot
// regress into a non-building deployment without a visible test failure.
//
// Two acceptable states:
//   A. `output: "standalone"` unconditionally + Next resolved >= 16.3.5.
//   B. `output` guarded by `process.env.VERCEL` (drops standalone on Vercel),
//      in which case `scripts/copy-standalone-assets.mjs` must also know about
//      VERCEL instead of hard-failing when no standalone dir was produced.
//
// GUARANTEES: pure static analysis of tracked files. No network, no build, no
// credentials, no database, no deployment.
//
// Run: node tests/vercel-standalone-adapter-gate.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(REPO, rel));

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

/** Minimum Next.js release that contains the #97287 backport. */
const FIXED_MIN = [16, 3, 5];

/** Parse "16.3.5" / "^16.3.5" / "16.4.0-canary.32" into a numeric tuple. */
function versionTuple(v) {
  const m = String(v).trim().replace(/^[\^~>=<\s]+/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function gte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
section("1. next.config.ts — standalone output is still configured");
// ---------------------------------------------------------------------------
const nextConfig = read("next.config.ts");
{
  ok(
    /output:\s*["']standalone["']/.test(nextConfig),
    "next.config.ts sets output: \"standalone\" (required for the self-host/standalone artifact)"
  );
  // The Vercel-conditional escape hatch (state B) — must be explicit.
  const conditional = /process\.env\.VERCEL/.test(nextConfig);
  ok(
    true,
    conditional
      ? "next.config.ts guards standalone output with process.env.VERCEL (state B)"
      : "next.config.ts applies standalone output unconditionally (state A)"
  );
  ok(
    !/NEXT_IGNORE_STANDALONE_ADAPTER_GATE/.test(nextConfig),
    "no ad-hoc bypass flag was smuggled into next.config.ts"
  );
  console.log(`   standalone conditional on VERCEL: ${conditional}`);
}

// ---------------------------------------------------------------------------
section("2. Next.js version floor — the #96646 standalone+adapter fix");
// ---------------------------------------------------------------------------
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const lockedNext = lock.packages["node_modules/next"] && lock.packages["node_modules/next"].version;
const nextConfigConditional = /process\.env\.VERCEL/.test(nextConfig);
{
  const range = pkg.dependencies && pkg.dependencies.next;
  const locked = lockedNext;
  ok(typeof range === "string", "package.json declares a next dependency");
  ok(typeof locked === "string", "package-lock.json pins a resolved next version");
  console.log(`   package.json next range: ${range}`);
  console.log(`   lockfile next version:   ${locked}`);

  const rt = versionTuple(range);
  const lt = versionTuple(locked);
  ok(rt !== null, "the next range parses as a semver tuple");
  ok(lt !== null, "the locked next version parses as a semver tuple");
  if (rt && lt) {
    ok(
      gte(rt, FIXED_MIN),
      `package.json next range allows only >= ${FIXED_MIN.join(".")} (got ${range})`
    );
    ok(
      gte(lt, FIXED_MIN),
      `lockfile next resolves to >= ${FIXED_MIN.join(".")} — 16.3.0–16.3.4 break Vercel builds (got ${locked})`
    );
  }

  // State A (unconditional standalone) REQUIRES the version floor. State B
  // (standalone disabled on Vercel) makes the floor unnecessary but then the
  // asset-copy step must tolerate a missing standalone directory.
  if (!nextConfigConditional) {
    ok(
      lt && gte(lt, FIXED_MIN),
      "unconditional standalone output ⇒ locked Next must be >= 16.3.5"
    );
  } else {
    const copy = read("scripts/copy-standalone-assets.mjs");
    ok(
      /VERCEL/.test(copy),
      "VERCEL-conditional standalone ⇒ scripts/copy-standalone-assets.mjs must handle the no-standalone case"
    );
  }
}

// ---------------------------------------------------------------------------
section("3. Matching @next tooling — no split-brain version drift");
// ---------------------------------------------------------------------------
{
  const eslintCfg = pkg.devDependencies && pkg.devDependencies["eslint-config-next"];
  const lockedEslint =
    lock.packages["node_modules/eslint-config-next"] &&
    lock.packages["node_modules/eslint-config-next"].version;
  const lockedEnv = lock.packages["node_modules/@next/env"] && lock.packages["node_modules/@next/env"].version;
  ok(typeof eslintCfg === "string", "eslint-config-next is declared");
  if (eslintCfg) {
    const et = versionTuple(eslintCfg);
    ok(et !== null && gte(et, FIXED_MIN), `eslint-config-next >= ${FIXED_MIN.join(".")} (got ${eslintCfg})`);
  }
  console.log(`   eslint-config-next: ${lockedEslint || "(absent)"}; @next/env: ${lockedEnv || "(absent)"}`);
  // @next/env ships inside the next dependency tree — it must match the runtime.
  if (lockedEnv && lockedNext) {
    ok(
      versionTuple(lockedEnv) && versionTuple(lockedNext) &&
        gte(versionTuple(lockedEnv), FIXED_MIN) && gte(versionTuple(lockedNext), FIXED_MIN),
      "@next/env and next are both at/above the fixed release (no mixed versions)"
    );
  }
}

// ---------------------------------------------------------------------------
section("4. Vercel build path — PostgreSQL build pinned, no migration, no silent default");
// ---------------------------------------------------------------------------
{
  const vj = JSON.parse(read("vercel.json"));
  eq(
    vj.buildCommand,
    "npm run build:postgres",
    "vercel.json pins the PostgreSQL build command (never the SQLite `npm run build`)"
  );
  ok(!/migrate/i.test(String(vj.buildCommand)), "the Vercel build runs no migration step");
  eq(
    pkg.scripts && pkg.scripts["build:postgres"],
    "prisma generate --schema prisma/postgres/schema.prisma && next build && node scripts/copy-standalone-assets.mjs",
    "build:postgres generates the PG client, builds, then copies standalone assets"
  );
}

// ---------------------------------------------------------------------------
section("5. Operator escape hatch documented (runbook)");
// ---------------------------------------------------------------------------
{
  const runbookRel = "docs/VERCEL_PRODUCTION_RUNBOOK.md";
  ok(exists(runbookRel), `${runbookRel} exists`);
  if (exists(runbookRel)) {
    const rb = read(runbookRel);
    ok(
      /next-server\.js\.nft\.json/.test(rb) && /NEXT_ADAPTER_PATH/.test(rb),
      "runbook documents the standalone+adapter ENOENT failure and the NEXT_ADAPTER_PATH contingency"
    );
    ok(
      /16\.3\.5/.test(rb),
      "runbook records the minimum fixed Next release for the Vercel target"
    );
  }
}

// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(60));
console.log(`Phase 26H vercel-standalone-adapter gate: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("Failures:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
