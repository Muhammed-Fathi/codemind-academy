/**
 * Phase 26F — CROSS-ROLE AUTHORIZATION + IDOR-HARDENING test.
 *
 * Two layers, deliberately:
 *
 *   1. SOURCE PINS — cheap, fast assertions that the Phase 26F invariants are
 *      still *written* in the shipped code. They catch a refactor that quietly
 *      reverts the referral fix, without booting a database.
 *
 *   2. THE REAL VERIFIER — `scripts/verify-phase26f-auth.mjs` runs the SHIPPED
 *      `/api/students/me/referral` handler (compiled with the repo's own tsc)
 *      against a REAL SQLite database built from the base DDL + every real
 *      migration, over real HTTP-shaped calls. That is what actually proves
 *      behaviour; a string being present in a file is never treated as a
 *      workflow PASS here.
 *
 * Run: node tests/auth-cross-role-phase26f.test.js
 * Exit 0 = all pass.
 *
 * NO Neon, NO R2, NO SMTP, NO Vercel. SQLite in a temp dir only.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ok - ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL - ${label}`);
  }
}

// ---------------------------------------------------------------------------
// 0. production safety
// ---------------------------------------------------------------------------
{
  const envUrl = process.env.DATABASE_URL || "";
  ok(!/postgres|neon/i.test(envUrl), "DATABASE_URL does not point at postgres/neon");
  ok(fs.existsSync(path.join(ROOT, "prisma/schema.prisma")), "the SQLite source schema is the one under test");
}

// ---------------------------------------------------------------------------
// 1. source pins — the referral fix must exist in shipped code
// ---------------------------------------------------------------------------
{
  console.log("\n== 1. source pins ==\n");
  let route = read("src/app/api/students/me/referral/route.ts");
  // Strip comments before scanning: the fix's own explanatory prose mentions
  // the rejected predicate, and a naive scan would "find" what it denies.
  route = route
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "")) // line comments
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, ""); // block comments

  // Code-level facts that decide the endpoint's outcome.
  ok(/id:\s*\{\s*endsWith:\s*suffix/.test(route), "REF-01: referrer resolution uses an exact *suffix* predicate on id");
  ok(!/id:\s*\{\s*contains:\s*suffix/.test(route), "REF-02: the substring `contains` referrer lookup is gone (comment-stripped scan)");
  ok(/slice\(-6\)/.test(route), "REF-03: the code is derived from the last 6 chars of the id");
  ok(/\{6\}\$?\//.test(route), "REF-04: the suffix is length-bounded to exactly six chars");

  const adapter = read("scripts/lib/sqlite-prisma-lite.mjs");
  ok(/case "endsWith"/.test(adapter), "REF-05: the sqlite query adapter supports the `endsWith` filter");
}

// ---------------------------------------------------------------------------
// 2. real-DB end-to-end verifier
// ---------------------------------------------------------------------------
{
  console.log("\n== 2. real-DB verifier ==\n");
  let out = "";
  let exited = 0;
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, "scripts/verify-phase26f-auth.mjs")], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf8",
      timeout: 600000,
    });
  } catch (e) {
    exited = 1;
    out = `${e.stdout || ""}${e.stderr || ""}`;
  }
  ok(exited === 0, "the real-DB verifier exited 0");
  ok(/PHASE26F_VERIFIER_OK/.test(out), "the verifier reported success");
  const m = /(\d+) passed, (\d+) failed/.exec(out);
  ok(!!m, "the verifier reported its assertion counts");
  if (m) {
    ok(Number(m[1]) >= 40, `the verifier asserted at scale (${m[1]} assertions)`);
    ok(Number(m[2]) === 0, `the verifier reported zero failures (got ${m[2]})`);
  }
  // Spot-check that the security-critical assertions actually ran, so a silently
  // truncated verifier cannot pass by asserting nothing.
  ok(/REF-01: anonymous → 401/.test(out), "the anonymous-denial assertion ran");
  ok(/REF-01: TEACHER → 403/.test(out), "the teacher-denial assertion ran");
  ok(/REF-01: PARENT → 403/.test(out), "the parent-denial assertion ran");
  ok(/REF-05: a suffix-only \(endsWith\) resolution returns the exact referrer/.test(out), "the endsWith-regression-lock assertion ran");
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("PHASE26F_VERIFIER_OK");
