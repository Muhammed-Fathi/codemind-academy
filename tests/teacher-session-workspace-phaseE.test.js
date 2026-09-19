/**
 * CodeMind Academy — Phase E teacher session workspace verifier executive test.
 *
 * The interactive suite lives in scripts/verify-phaseE-teacher.mjs (a real-DB,
 * real-compiled-route walk of the whole Phase E contract: list/workspace,
 * manage-own materials, quiz PATCH, homework DELETE, readiness authority and
 * the fail-closed security boundary). This file is the thin Jest-free runner
 * every other suite uses.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "..", "scripts", "verify-phaseE-teacher.mjs");

const out = execFileSync(process.execPath, [script], {
  cwd: path.join(__dirname, ".."),
  stdio: "pipe",
  timeout: 600000,
}).toString();

process.stdout.write(out);

const m = /PHASE-E-TEACHER-SESSIONS:\s*(\d+) passed,\s*(\d+) failed/.exec(out);
if (!m) {
  console.error("FAIL - verifier summary line missing");
  process.exit(1);
}
const failed = Number(m[2]);
if (failed !== 0) {
  console.error(`FAIL - verifier reported ${failed} failure(s)`);
  process.exit(1);
}
console.log(`[PHASE-E-TEST] PASS — teacher session workspace is green (${m[1]} assertions)`);
