/**
 * Phase 26C verifier fail-closed self-test.
 *
 * PHASE26C_FORCE_FAILURE is a verifier-only test hook. The hook records one
 * failed assertion; it does not alter application code or production data.
 * This test exercises the public wrapper, not just the verifier directly:
 * verifier failure -> wrapper child failure -> non-zero process status.
 */
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const wrapper = path.join(ROOT, "tests", "phase26c-admin-full-flow.test.js");

let failedAsExpected = false;
try {
  execFileSync(process.execPath, [wrapper], {
    cwd: ROOT,
    env: {
      ...process.env,
      SECURITY_HASH_SECRET: "phase26c-test-secret-0123456789abcdef",
      PHASE26C_FORCE_FAILURE: "1",
    },
    stdio: "pipe",
    timeout: 180000,
  });
} catch (error) {
  failedAsExpected = error.status !== 0 && error.status != null;
  if (!failedAsExpected) {
    throw new Error(`expected a non-zero wrapper status, got ${error.status ?? "unknown"}`);
  }
  const output = `${error.stdout || ""}${error.stderr || ""}`;
  if (!output.includes("SELF-TEST-FORCED-FAILURE") || !output.includes("verifier failed closed")) {
    throw new Error("child failed, but not at the deterministic forced assertion/fail-closed summary");
  }
}

if (!failedAsExpected) {
  throw new Error("forced Phase26C assertion unexpectedly passed");
}

console.log("[26C-SELF-TEST] PASS — forced assertion failed verifier and wrapper with non-zero status");
