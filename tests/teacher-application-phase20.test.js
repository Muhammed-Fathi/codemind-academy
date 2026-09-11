// CodeMind Academy — Phase 20 addendum: teacher application & admin approval.
//
// Offline, source-level invariants in the same style as
// tests/authorization-invariants.test.js. Every content check is a SOURCE
// invariant (no Prisma engine, no network), plus a subprocess run of the
// real-database + real-HTTP verifier (scripts/verify-phase20-teacher.mjs).
//
// The contract under test:
//   public application → PENDING (no User, no role=TEACHER, no session)
//   admin approve      → APPROVED + single-use activation token (no password)
//   admin reject       → REJECTED + token rescinded
//   applicant activate → sets OWN password → User(role TEACHER) is born
//
// Run: node tests/teacher-application-phase20.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

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
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
section("1. Schema — smallest safe model, no new auth primitive");
// ---------------------------------------------------------------------------
{
  const schema = read("prisma/schema.prisma");
  ok(/enum TeacherApplicationStatus \{[\s\S]*?PENDING[\s\S]*?APPROVED[\s\S]*?REJECTED[\s\S]*?ACTIVATED[\s\S]*?\}/.test(schema),
    "TeacherApplicationStatus = PENDING/APPROVED/REJECTED/ACTIVATED");
  ok(/model TeacherApplication \{[\s\S]*?email\s+String\s+@unique/.test(schema),
    "one application per canonical email (unique)");
  ok(/model TeacherApplication \{[\s\S]*?status\s+TeacherApplicationStatus\s+@default\(PENDING\)/.test(schema),
    "applications are born PENDING");
  ok(/model TeacherApplication \{[\s\S]*?userId\s+String\?\s+@unique/.test(schema),
    "userId is set only at activation (nullable, unique)");
  ok(/model TeacherActivationToken \{[\s\S]*?tokenHash\s+String\s+@unique/.test(schema),
    "activation token stores a SHA-256 hash, unique");
  ok(/model TeacherActivationToken \{[\s\S]*?applicationId\s+String/.test(schema),
    "activation token points at its application");
  ok(!/applicationId\s+String\s+@unique/.test(schema),
    "applicationId is NOT @unique (reject → re-apply → re-approve re-mints)");
  ok(/model TeacherActivationToken \{[\s\S]*?@@index\(\[applicationId, usedAt\]\)/.test(schema),
    "token lookup is indexed by (applicationId, usedAt) — mirrors PasswordResetToken");
  ok(/model TeacherActivationToken \{[\s\S]*?usedAt\s+DateTime\?/.test(schema),
    "single-use is representable (usedAt)");
}

// ---------------------------------------------------------------------------
section("2. Migration — additive, idempotent, no destructive SQL");
// ---------------------------------------------------------------------------
{
  const files = fs
    .readdirSync(path.join(REPO, "prisma", "migrations"))
    .filter((d) => d.includes("phase20_teacher_applications"));
  ok(files.length === 1, "exactly one Phase 20 teacher-applications migration directory");
  const sql = read(path.join("prisma", "migrations", files[0], "migration.sql"));
  ok(/CREATE TABLE IF NOT EXISTS "TeacherApplication"/.test(sql), "creates TeacherApplication (guarded)");
  ok(/CREATE TABLE IF NOT EXISTS "TeacherActivationToken"/.test(sql), "creates TeacherActivationToken (guarded)");
  ok(!/\bDROP\b/i.test(sql), "no DROP statements");
  ok(!/\bALTER\s+TABLE/i.test(sql), "no ALTER statements");
  ok(!/\bDELETE\b/i.test(sql) && !/\bUPDATE\b/i.test(sql), "no data mutation");
  ok(/TeacherApplication_email_key/.test(sql), "unique index on application email");
  ok(/TeacherActivationToken_tokenHash_key/.test(sql), "unique index on token hash");
  ok(/TeacherActivationToken_applicationId_usedAt_idx/.test(sql),
    "non-unique (applicationId, usedAt) index — multiple issuance rounds supported");
  ok(!/TeacherActivationToken_applicationId_key/.test(sql),
    "applicationId is NOT unique (reject → re-apply → re-approve must re-mint)");

  // The migration chain's base-schema derivation must NOT pre-create these
  // tables (they are created by THIS migration, exactly once).
  const mig = read("scripts/lib/migrate-sqlite.mjs");
  ok(/TeacherApplication/.test(mig) && /TeacherActivationToken/.test(mig),
    "shared migration runner skips the new tables in its base derivation");
}

// ---------------------------------------------------------------------------
section("3. Public registration — application only, never an account");
// ---------------------------------------------------------------------------
{
  const route = read("src/app/api/auth/[action]/route.ts");
  const teacherBranch = route.slice(route.indexOf('if (role === "TEACHER")'), route.indexOf("// Public admin registration"));

  ok(/submitTeacherApplication\(/.test(teacherBranch), "TEACHER branch submits an application");
  ok(/applyRateLimitForIdentifier\("teacherApply", email\)/.test(teacherBranch),
    "public application is rate limited per email identity");
  ok(/rateLimitedResponse\(/.test(teacherBranch), "application refuses with the shared 429 shape");
  ok(!/createSession\(/.test(teacherBranch), "TEACHER branch never creates a session");
  ok(!/db\.user\.create/.test(teacherBranch), "TEACHER branch never creates a User");
  ok(!/role:\s*"TEACHER"/.test(teacherBranch), "TEACHER branch never assigns role=TEACHER");
  ok(!/body\.status/.test(teacherBranch), "TEACHER branch ignores any client status field");
  ok(!/body\.role/.test(teacherBranch.slice(teacherBranch.indexOf("submitTeacherApplication"))),
    "application submission ignores any client role field");
  ok(/TEACHER_APPLICATION_BLOCKED/.test(teacherBranch), "blocked application attempts are audited");
  ok(/TEACHER_APPLICATION_SUBMITTED/.test(teacherBranch), "submissions are audited");
  ok(/api\.258/.test(teacherBranch), "one generic 409 message for every blocked case (no enumeration)");

  // Public admin self-registration stays prohibited.
  ok(/if \(role === "ADMIN"\) return err\(tApi\("api\.059"\), 400\)/.test(route),
    "public ADMIN registration remains blocked");
  ok(/role === "STUDENT"/.test(route) && /role === "PARENT"/.test(route),
    "STUDENT and PARENT registration are untouched");
}

// ---------------------------------------------------------------------------
section("4. Admin approval — server-authorized, IDOR-safe, no password");
// ---------------------------------------------------------------------------
{
  const approve = read("src/app/api/admin/teacher-applications/[id]/approve/route.ts");
  ok(/requireRole\("ADMIN"\)/.test(approve), "approve requires the ADMIN role");
  ok(/approveTeacherApplication\(\{ id, adminUserId: user\.id \}\)/.test(approve),
    "approve uses the server-derived admin id (never a client id)");
  ok(!/hashPassword/.test(approve), "approve never hashes/assigns a password");
  ok(!/ok\(\{[^}]*password/.test(approve), "approve response never carries a password");
  ok(!/db\.user\.create/.test(approve), "approve never creates a User account");
  ok(/teacherActivation=/.test(approve), "approve emails an activation link");
  ok(/maskEmail\(/.test(approve), "approve masks the destination in audit");
  ok(/TEACHER_APPLICATION_APPROVED/.test(approve), "approval is audited");
  ok(/TEACHER_ACTIVATION_ISSUED/.test(approve), "activation issuance is audited");

  const reject = read("src/app/api/admin/teacher-applications/[id]/reject/route.ts");
  ok(/requireRole\("ADMIN"\)/.test(reject), "reject requires the ADMIN role");
  ok(/rejectTeacherApplication\(\{ id, adminUserId: user\.id, note \}\)/.test(reject),
    "reject uses the server-derived admin id");
  ok(/TEACHER_APPLICATION_REJECTED/.test(reject), "rejection is audited");

  const list = read("src/app/api/admin/teacher-applications/route.ts");
  ok(/requireRole\("ADMIN"\)/.test(list), "application list requires the ADMIN role");
  ok(/statusParam/.test(list) && /VALID_STATUS/.test(list), "list validates its status filter");
}

// ---------------------------------------------------------------------------
section("5. Activation — applicant's own password, single-use token");
// ---------------------------------------------------------------------------
{
  const activateRoute = read("src/app/api/auth/teacher-activate/route.ts");
  ok(/activateTeacher\(\{ token, password \}\)/.test(activateRoute), "activation delegates to the domain module");
  ok(/password\.length < 8/.test(activateRoute), "the applicant's own password is length-checked");
  ok(/checkRateLimit\("teacheract:ip"/.test(activateRoute), "activation is IP rate-limited");
  ok(/checkRateLimit\(\s*"teacheract:token"/.test(activateRoute), "activation is per-token rate-limited");
  ok(!/createSession/.test(activateRoute), "activation never auto-authenticates");
  ok(!/hashPassword/.test(activateRoute), "the route never sees a password hash (domain does it)");
  ok(/TEACHER_ACTIVATION_FAILED/.test(activateRoute), "invalid/expired/replayed attempts are audited");
  ok(/TEACHER_ACTIVATION_COMPLETED/.test(activateRoute), "successful activation is audited");

  const lib = read("src/lib/teacher-applications.ts");
  ok(/generateToken\(32\)/.test(lib), "activation token is cryptographically random (256-bit)");
  ok(/sha256\(secret\)/.test(lib), "only the SHA-256 of the token is stored");
  ok(/expiresAt: new Date\(Date\.now\(\) \+ TEACHER_ACTIVATION_TTL_HOURS \* 3600 \* 1000\)/.test(lib),
    "token is short-lived");
  ok(/where: \{ id: record\.id, usedAt: null \}/.test(lib), "consume is guarded (single-use, no replay)");
  ok(/consumed\.count !== 1/.test(lib), "a lost consume race fails closed");
  ok(/hashPassword\(input\.password\)/.test(lib), "the applicant's own password is hashed at activation");
  ok(/role: "TEACHER"/.test(lib), "the User role is assigned ONLY at activation");
  ok(/status: "ACTIVATED"/.test(lib), "activation finalizes the application as ACTIVATED");

  // The activation token is bound to its application (a token cannot create a
  // different account), and the submit path cannot reach the activation branch.
  const submitOnly = lib.slice(0, lib.indexOf("export async function approveTeacherApplication"));
  ok(!/role: "TEACHER"/.test(submitOnly), "submit/approve never assign role=TEACHER");
  ok(/status: "PENDING"/.test(submitOnly), "submit creates PENDING only");
}

// ---------------------------------------------------------------------------
section("6. Lifecycle & re-application rules");
// ---------------------------------------------------------------------------
{
  const lib = read("src/lib/teacher-applications.ts");
  ok(/existing\.status === "REJECTED"/.test(lib), "a rejected applicant may re-apply");
  ok(/status: "PENDING"/.test(lib), "re-application re-opens the SAME row as PENDING");
  ok(/existing\.status === "ACTIVATED"/.test(lib), "an activated applicant is refused (already a teacher)");
  ok(/APPLICATION_EXISTS/.test(lib), "PENDING/APPROVED duplicates are refused");
  ok(/EMAIL_TAKEN/.test(lib), "an existing User of any role blocks the application safely");
  ok(/where: \{ id: application\.id, status: "PENDING" \}/.test(lib),
    "approve is a guarded PENDING→APPROVED transition");
  ok(/application\.status === "ACTIVATED"/.test(lib) && /REJECTED/.test(lib),
    "illegal approve transitions (ACTIVATED/REJECTED) are refused");
  ok(/alreadyApproved/.test(lib), "approve is idempotent");
  ok(/teacherActivationToken\.updateMany[\s\S]*?usedAt: null/.test(lib),
    "reject rescinds any live activation token");
}

// ---------------------------------------------------------------------------
section("7. Real DB + real HTTP verification (full chain)");
// ---------------------------------------------------------------------------
{
  try {
    const out = execSync("node scripts/verify-phase20-teacher.mjs", {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    ok(/PHASE20_TEACHER_OK/.test(out), "real-DB + real-HTTP verification passed");
    if (!/PHASE20_TEACHER_OK/.test(out)) console.error(out);
  } catch (e) {
    fail++;
    failures.push("real-DB + real-HTTP verification crashed");
    console.error("FAIL: real-DB + real-HTTP verification crashed");
    console.error(String(e.stdout || ""));
    console.error(String(e.stderr || e.message || e));
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 20 teacher-application tests: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log("  -", f);
}
process.exit(fail ? 1 : 0);
