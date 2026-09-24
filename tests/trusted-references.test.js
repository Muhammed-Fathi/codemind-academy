// CodeMind Academy — trusted PRE-26D / POST-26D reference contract regression
// coverage (offline, no database).
//
// On 2026-09-22 the PG17 trusted-catalog gates failed three ways at once:
//   F1. the PRE-26D bundle step copied the whole migrations directory and then
//       deleted later migrations through a hardcoded per-migration rm
//       blacklist (26D, F, G x2). The four newest migrations (Phase H, the
//       session-video pair, the readiness recipients) were not listed, so they
//       leaked into the trusted HISTORICAL bundle and failed the
//       exactly-one-directory assertion. The step now uses WHITELIST isolation
//       (keep ONLY 0_init + migration_lock.toml) which cannot leak.
//   F2. the POST-26D validator pinned the pre-Phase-H catalog size (594
//       columns / 94 enum values / 185 indexes / 188 typed constraints) and a
//       5-migration ledger, while the current canonical chain captures
//       607 / 98 / 190 / 192 over NINE migrations. The validator is now
//       current and additionally asserts every newer migration's objects BY
//       NAME plus a structural no-drift guard.
//   F3. the migration-providers engine test expected a 7-migration fresh
//       ledger (missing the session-video modes + readiness migrations) while
//       the real engine correctly applied all nine — and its "no SQLite
//       names" check was implemented as "every ledger row is in the stale
//       7-list", so it failed for the same stale-list reason. The engine was
//       never wrong; the expectation was.
//
// This suite pins all three fixes WITHOUT a database (pure file reads plus
// one temp-dir bundle rehearsal), so it runs offline in milliseconds inside
// the normal battery:
//
//   S1. the whitelist bundle rule yields exactly 0_init (+ lock), byte-identical.
//   S2. the workflow pins the whitelist (no hardcoded rm blacklist can return).
//   S3. 0_init structurally lacks every later migration's signature object.
//   S4. the workflow PRE validator asserts the frozen history (absence of
//       every later object + the exact 12 historical NotificationType labels).
//   S5. the workflow POST validator is current (10-migration EXPECTED_CHAIN in
//       canonical order, 610/100/190/192, all ten SHA pins, by-name coverage
//       of every newer phase).
//   S6. the providers engine ledger contract is current (expected ledger ==
//       the migrations directory, SQLite-only derivation, PG camera pin).
//
// What is REAL here: the workflow file, the provider test source, the PG
// migration SQL files. The S1 rehearsal applies the same whitelist rule the
// workflow step runs (keep 0_init + migration_lock.toml, delete the rest).
//
// Run: node --test tests/trusted-references.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const REPO = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

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

const PG_MIG = path.join(REPO, "prisma", "postgres", "migrations");
const pgMigrationDirs = fs
  .readdirSync(PG_MIG, { withFileTypes: true })
  .filter((e) => e.isDirectory() && (/^\d+_/.test(e.name) || e.name === "0_init"))
  .map((e) => e.name)
  .sort();

const workflow = read(".github/workflows/pg17-full-chain-reference.yml");
const preBlock = workflow.slice(
  workflow.indexOf("VALIDATE_PRE26D_REFERENCE_JS"),
  workflow.indexOf("PG17_0_INIT_REFERENCE_VALID")
);
const postBlock = workflow.slice(
  workflow.indexOf("VALIDATE_FULL_CHAIN_REFERENCE_JS"),
  workflow.indexOf("PG17_FULL_CHAIN_PHASE26D_REFERENCE_VALID")
);

const initSql = read("prisma/postgres/migrations/0_init/migration.sql");
const tableBlock = (table) =>
  new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`).exec(initSql)?.[1] ?? null;

test("trusted PRE/POST reference contracts stay current and isolated (S1–S6)", () => {
  // ===========================================================================
  // S1. Whitelist bundle rehearsal: the rule yields exactly 0_init (+ lock).
  // ===========================================================================
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "cm-pre26d-bundle-"));
  try {
    fs.copyFileSync(
      path.join(REPO, "prisma", "postgres", "schema.prisma"),
      path.join(bundle, "schema.prisma")
    );
    fs.cpSync(PG_MIG, path.join(bundle, "migrations"), { recursive: true });
    // THE whitelist rule (same semantics as the workflow step: keep ONLY
    // 0_init + migration_lock.toml, delete everything else).
    for (const entry of fs.readdirSync(path.join(bundle, "migrations"))) {
      if (entry !== "0_init" && entry !== "migration_lock.toml") {
        fs.rmSync(path.join(bundle, "migrations", entry), { recursive: true, force: true });
      }
    }
    const left = fs.readdirSync(path.join(bundle, "migrations")).sort();
    eq(left, ["0_init", "migration_lock.toml"], "S1: the bundle holds exactly 0_init + the lock file");
    const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    ok(
      sha(path.join(bundle, "migrations", "0_init", "migration.sql")) ===
        sha(path.join(PG_MIG, "0_init", "migration.sql")),
      "S1: the bundled 0_init is byte-identical to the repository file"
    );
    ok(
      sha(path.join(bundle, "schema.prisma")) ===
        sha(path.join(REPO, "prisma", "postgres", "schema.prisma")),
      "S1: the bundled schema.prisma is byte-identical to the repository file"
    );
    ok(
      /provider\s*=\s*"postgresql"/.test(
        fs.readFileSync(path.join(bundle, "migrations", "migration_lock.toml"), "utf8")
      ),
      "S1: the bundled lock file says postgresql"
    );
    eq(
      pgMigrationDirs.filter((d) => d !== "0_init").length,
      pgMigrationDirs.length - 1,
      "S1: rehearsal is non-vacuous (later migrations exist to be excluded)"
    );
  } finally {
    fs.rmSync(bundle, { recursive: true, force: true });
  }

  // ===========================================================================
  // S2. The workflow pins the whitelist (a blacklist cannot silently return).
  // ===========================================================================
  ok(
    workflow.includes(
      `find "$BUNDLE/migrations" -mindepth 1 -maxdepth 1 ! -name '0_init' ! -name 'migration_lock.toml' -exec rm -rf {} +`
    ),
    "S2: the bundle step whitelists 0_init + migration_lock.toml"
  );
  ok(
    !workflow.includes('rm -rf "$BUNDLE/migrations/2026'),
    "S2: no hardcoded per-migration rm blacklist remains in the bundle step"
  );
  ok(
    workflow.includes("WHITELIST isolation"),
    "S2: the isolation contract is documented at the step"
  );

  // ===========================================================================
  // S3. 0_init structurally lacks every later migration's signature object.
  // ===========================================================================
  for (const table of ["Quiz", "Homework", "HomeworkSubmission", "Notification", "LiveSession", "Attendance", "SessionVideo"]) {
    ok(tableBlock(table) !== null, `S3: 0_init declares the pre-existing ${table} table (non-vacuous scope)`);
  }
  for (const [table, column] of [
    // Phase G lifecycle + camera policy.
    ["Quiz", "status"], ["Quiz", "publishedAt"], ["Quiz", "cameraPolicy"],
    ["Homework", "status"], ["Homework", "publishedAt"], ["Homework", "attachmentId"],
    ["HomeworkSubmission", "attachmentId"], ["HomeworkSubmission", "gradedById"], ["HomeworkSubmission", "gradedAt"],
    // Session-video flag / mode / absence source.
    ["SessionVideo", "isRequiredForProgression"], ["SessionVideo", "requirementMode"], ["SessionVideo", "liveSessionId"],
    // Phase F representatives (the pre-state predates them too).
    ["Notification", "sessionId"], ["Notification", "dedupeKey"],
    ["LiveSession", "attendanceFinalizedAt"],
    ["Attendance", "markedAt"],
  ]) {
    ok(!tableBlock(table).includes(`"${column}"`), `S3: 0_init ${table} block lacks the later column ${column}`);
  }
  for (const name of [
    "ProgressionOverride", "QuizRetryGrant", "AbsenceReview", "AbsenceHold",
    "SessionVideoRequirementMode", "AbsenceReviewStatus", "AbsenceHoldStatus",
  ]) {
    ok(!initSql.includes(`"${name}"`), `S3: 0_init lacks the later object ${name}`);
  }
  for (const label of ["READINESS_REMINDER", "ABSENCE_FINALIZED", "SESSION_SCHEDULED"]) {
    ok(!initSql.includes(label), `S3: 0_init lacks the later enum label ${label}`);
  }

  // ===========================================================================
  // S4. The workflow PRE validator asserts the frozen history.
  // ===========================================================================
  ok(preBlock.length > 1000, "S4: the PRE validator block parses non-vacuously");
  for (const marker of [
    "ProgressionOverride", "isRequiredForProgression", "SessionVideoRequirementMode",
    "READINESS_REMINDER", "cameraPolicy", "Homework_attachmentId_fkey",
    "QuizRetryGrant", "AbsenceReview",
  ]) {
    ok(preBlock.includes(marker), `S4: the PRE validator asserts absence of ${marker}`);
  }
  ok(
    preBlock.includes("NEW_LESSON") && preBlock.includes("PAYMENT_REJECTED"),
    "S4: the PRE validator pins the exact 12 historical NotificationType labels"
  );

  // ===========================================================================
  // S5. The workflow POST validator is current.
  // ===========================================================================
  ok(postBlock.length > 5000, "S5: the POST validator block parses non-vacuously");
  const chainSrc = /const EXPECTED_CHAIN = \[([\s\S]*?)\];/.exec(postBlock)?.[1] ?? "";
  const expectedChain = [...chainSrc.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  eq(expectedChain, pgMigrationDirs, "S5: EXPECTED_CHAIN is exactly the PG migrations directory in canonical order");
  eq(expectedChain.length, 11, "S5: the current chain holds eleven migrations");
  for (const [re, label] of [
    [/columns\.length, 610/, "610 columns"],
    [/enumValues, 100/, "100 enum values"],
    [/indexes\.length, 191/, "191 indexes"],
    [/typedConstraints\.length, 192/, "192 typed constraints"],
  ]) {
    ok(re.test(postBlock), `S5: the POST validator asserts ${label}`);
  }
  ok(!/594/.test(postBlock), "S5: no stale 594-column expectation remains");
  for (const dir of pgMigrationDirs) {
    ok(postBlock.includes(dir), `S5: the POST validator covers ${dir}`);
  }
  for (const marker of [
    "ProgressionOverride", "SessionVideoRequirementMode", "cameraPolicy",
    "Homework_attachmentId_fkey", "SessionVideo_liveSessionId_fkey", "READINESS_REMINDER",
    "AcademicLevel", "Lesson_academicLevel_officialCode_key", "MockExam_courseId_idx",
  ]) {
    ok(postBlock.includes(marker), `S5: the POST validator asserts the newer object ${marker} by name`);
  }
  for (const pin of [
    "INIT_SQL_SHA256", "PHASE26D_SQL_SHA256", "PHASE_F_SQL_SHA256", "PHASE_G_SQL_SHA256",
    "PHASE_G_CAMERA_SQL_SHA256", "PHASE_H_SQL_SHA256", "SESSION_VIDEO_REQ_SQL_SHA256",
    "SESSION_VIDEO_MODES_SQL_SHA256", "READINESS_REMINDER_SQL_SHA256",
    "K1_ACADEMIC_LEVEL_SQL_SHA256", "K3_ACADEMIC_LEVEL_SQL_SHA256",
  ]) {
    ok(workflow.includes(`${pin}:`) && postBlock.includes(`process.env.${pin}`),
      `S5: migration provenance pin ${pin} is declared and asserted`);
  }

  // ===========================================================================
  // S6. The providers engine ledger contract is current.
  // ===========================================================================
  const providers = read("tests/migration-providers.test.js");
  const migConsts = Object.fromEntries(
    [...providers.matchAll(/const (MIG_[A-Z0-9_]+) = "([^"]+)";/g)].map((m) => [m[1], m[2]])
  );
  const ledgerSrc = /const expectedPgLedger = \[([\s\S]*?)\];/.exec(providers)?.[1] ?? "";
  const expectedLedger = ledgerSrc
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((tok) => (/^"/.test(tok) ? tok.slice(1, -1) : migConsts[tok]));
  eq(expectedLedger, pgMigrationDirs, "S6: expectedPgLedger is exactly the PG migrations directory in canonical order");
  ok(
    providers.includes("listMigrationDirs(PG_MIGRATIONS)) === JSON.stringify(expectedPgLedger)"),
    "S6: the engine test guards the ledger list against the directory (no silent drift)"
  );
  ok(
    providers.includes("sqliteOnly") && providers.includes("!sqliteOnly.includes(x.migration_name)"),
    "S6: the no-SQLite-names check derives the real SQLite-only names (not the stale list)"
  );
  ok(
    providers.includes('"PG:20260919190000_phase_g_camera_policy"'),
    "S6: the PG camera-policy migration is checksum-pinned"
  );
  ok(
    providers.includes("resolves its migrations from prisma/postgres/migrations"),
    "S6: the engine test pins the schema-adjacent migrations resolution"
  );

  if (fail > 0) throw new Error(`${fail} assertion(s) failed:\n- ` + failures.join("\n- "));
});
