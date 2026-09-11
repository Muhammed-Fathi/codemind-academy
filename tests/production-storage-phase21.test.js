// CodeMind Academy — Phase 21: production database & storage (offline suite).
//
// Proves, without credentials and without touching any real database:
//   1.  Pre-P21 Security Audit Gate verified as GO (prerequisite)
//   2.  Single-source schema (PostgreSQL artifacts derived, never competing)
//   3.  Schema portability (every column maps to PostgreSQL; order is a DAG)
//   4.  Teacher Application persistence (lifecycle is persistable as designed)
//   5.  Migration tooling (fail-closed operator CLI)
//   6.  Backup/restore scripts (verified procedure, not just commands)
//   7.  Durable media migration (inventory/copy/verify, tamper-detecting)
//   8.  Evidence retention (expired-only purge, protected tables untouched)
//   9.  Storage quotas (no-op by default, fail-closed when set, wired in)
//   10. setup-production (complete, provider-safe, no teacher provisioning)
//   11. Live drills (real rehearsal + real restore on disposable PostgreSQL)
//   12. Docs & environment contract
//
// Run: node tests/production-storage-phase21.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
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
const run = (cmd, opts = {}) =>
  execSync(cmd, { cwd: REPO, encoding: "utf8", timeout: 300000, ...opts });

async function main() {
  const pgLib = await import("../scripts/db/pg-lib.mjs");

  // ---------------------------------------------------------------------------
  section("1. Pre-P21 Security Audit Gate prerequisite (GO, nothing open)");
  // ---------------------------------------------------------------------------
  {
    const gate = read("docs/SECURITY_AUDIT_GATE_PRE_PHASE21.md");
    ok(/CONDITIONAL GO/.test(gate), "gate report records a GO verdict");
    ok(!/^NO-GO/m.test(gate), "gate report is not a NO-GO");
    ok(/\*\*Zero Critical and zero High findings remain open\.\*\*/.test(gate) ||
       /Zero open/.test(gate), "zero Critical/High findings remain open");
    // Every finding row in the register is FIXED (F-01..F-09 minus absorbed F-08).
    const fixedRows = (gate.match(/\|\s*\*\*F-\d+\*\*.*\*\*FIXED\*\*/g) || []).length;
    ok(fixedRows === 8, `all 8 findings FIXED in the register (found ${fixedRows})`);
    ok(/R-5.*Phase 21.*durability and retention work/.test(gate),
      "R-5 hands durability/retention to Phase 21 (this phase's scope)");
  }

  // ---------------------------------------------------------------------------
  section("2. Single-source schema (derived PostgreSQL, no competing schema)");
  // ---------------------------------------------------------------------------
  {
    try {
      const out = run("node scripts/db/make-postgres-schema.mjs --check");
      ok(/in sync/.test(out), "make-postgres-schema --check: committed artifacts in sync");
    } catch (e) {
      ok(false, "make-postgres-schema --check passes");
      console.error(String(e.stdout || e.message || e).slice(0, 500));
    }
    const src = read("prisma/schema.prisma");
    const derived = read("prisma/schema.postgresql.prisma");
    ok(/^\/\/ CodeMind Academy — Phase 21 PostgreSQL schema \(DERIVED ARTIFACT\)/m.test(derived),
      "derived schema carries the DO-NOT-EDIT header");
    ok(/provider\s*=\s*"postgresql"/.test(derived), "derived schema targets postgresql");
    ok(/provider\s*=\s*"sqlite"/.test(src), "source schema still targets sqlite (dev)");
    const stripHeader = derived.slice(derived.indexOf("generator client"));
    const expectSwapped = src.replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"');
    ok(stripHeader === expectSwapped, "derived schema is byte-identical to source except the provider line");
    // No other .prisma file may define models (no competing schema).
    const prismaFiles = fs.readdirSync(path.join(REPO, "prisma")).filter((f) => f.endsWith(".prisma"));
    ok(prismaFiles.length === 2, `exactly 2 .prisma files (source + derived), found ${prismaFiles.join(",")}`);
    // Migration history untouched: 9 migrations, all present.
    const migs = fs.readdirSync(path.join(REPO, "prisma", "migrations")).filter((d) =>
      fs.existsSync(path.join(REPO, "prisma", "migrations", d, "migration.sql")));
    ok(migs.length === 9, `9 SQLite migrations preserved (found ${migs.length})`);
  }

  // ---------------------------------------------------------------------------
  section("3. Schema portability (PostgreSQL compatibility)");
  // ---------------------------------------------------------------------------
  {
    const parsed = pgLib.parseSchema();
    ok(parsed.models.size === 55, `55 models parsed (found ${parsed.models.size})`);
    ok(parsed.enums.size === 21, `21 enums parsed (found ${parsed.enums.size})`);
    // No provider-specific column types or attributes anywhere. (Type check is
    // done on PARSED field types — a substring sweep would false-positive on
    // column names like `sizeBytes`.)
    const src = read("prisma/schema.prisma");
    const parsedTypes = new Set();
    for (const [, model] of parsed.models) {
      for (const f of pgLib.scalarFields(model)) parsedTypes.add(f.type);
    }
    for (const banned of ["Bytes", "Json", "Decimal", "BigInt"]) {
      ok(!parsedTypes.has(banned), `schema contains no "${banned}" column type`);
    }
    for (const banned of ["dbgenerated(", "@db.", "autoincrement(", "uuid()"]) {
      ok(!src.includes(banned), `schema contains no "${banned}"`);
    }
    // Every scalar field maps to a PostgreSQL type + translatable default.
    let mapped = 0;
    let defaultErrors = [];
    for (const [, model] of parsed.models) {
      for (const f of pgLib.scalarFields(model)) {
        pgLib.pgTypeOf(f);
        mapped++;
        try { pgLib.pgDefaultOf(f); } catch (e) { defaultErrors.push(`${model.name}.${f.name}: ${e.message}`); }
      }
    }
    ok(mapped > 300, `all ${mapped} scalar columns map to PostgreSQL types`);
    ok(defaultErrors.length === 0, `all column defaults translatable (${defaultErrors.slice(0, 2).join("; ")})`);
    // Every FK is balanced (fields/references pair up, target exists).
    let fks = 0;
    let unbalanced = 0;
    for (const [, model] of parsed.models) {
      for (const f of model.fields) {
        if (f.isRelation && f.relation?.fields?.length) {
          fks++;
          if (!parsed.models.has(f.type)) unbalanced++;
          if (f.relation.fields.length !== (f.relation.references || []).length) unbalanced++;
          if (f.relation.onDelete && !["Cascade", "SetNull", "Restrict", "SetDefault", "NoAction"].includes(f.relation.onDelete)) unbalanced++;
        }
      }
    }
    ok(fks === 73, `73 FK relations found (found ${fks})`);
    ok(unbalanced === 0, "every FK is balanced with a known referential action");
    // Migration order: total, deterministic, parents before children.
    const order1 = pgLib.migrationOrder(parsed);
    const order2 = pgLib.migrationOrder(pgLib.parseSchema());
    ok(order1.length === 55, "migration order covers all 55 tables");
    ok(JSON.stringify(order1) === JSON.stringify(order2), "migration order is deterministic");
    const pos = new Map(order1.map((m, i) => [m, i]));
    let violations = 0;
    for (const [name, model] of parsed.models) {
      for (const f of model.fields) {
        if (f.isRelation && f.relation?.fields?.length && pos.get(f.type) > pos.get(name)) violations++;
      }
    }
    ok(violations === 0, "parents precede children for every FK (no cycles)");
    // Baseline DDL: statement count + identifier length + enum coverage.
    const ddl = read("scripts/db/postgres-baseline.sql");
    const stmts = pgLib.splitSqlStatements(ddl);
    ok(stmts.length === 21 + 55 + 67, `baseline has 143 statements (found ${stmts.length})`);
    const longIdents = [...ddl.matchAll(/"([A-Za-z0-9_]{64,})"/g)];
    ok(longIdents.length === 0, "no identifier exceeds the 63-byte PostgreSQL limit");
    // String JSON blobs stay TEXT (explicit non-conversion).
    for (const blob of ['"options" TEXT', '"answers" TEXT', '"objectives" TEXT']) {
      ok(ddl.includes(blob), `JSON blob stays TEXT (${blob})`);
    }
    ok(!/\bJSONB\b/.test(ddl), "no JSONB conversion anywhere in the baseline");
    // No raw SQL in application code (the provider switch changes no query).
    let rawHits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!full.endsWith(".ts")) continue;
        const text = fs.readFileSync(full, "utf8");
        for (const pat of ["$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"]) {
          if (text.includes(pat)) rawHits.push(`${path.relative(REPO, full)}:${pat}`);
        }
      }
    };
    walk(path.join(REPO, "src"));
    ok(rawHits.length === 0, `no raw SQL in src/ (${rawHits.slice(0, 3).join(", ") || "clean"})`);
  }

  // ---------------------------------------------------------------------------
  section("4. Teacher Application persistence (Phase 20 lifecycle is storable)");
  // ---------------------------------------------------------------------------
  {
    const schema = read("prisma/schema.prisma");
    ok(/model TeacherApplication \{[\s\S]*?email\s+String\s+@unique/.test(schema), "one application per email (unique)");
    ok(/status\s+TeacherApplicationStatus\s+@default\(PENDING\)/.test(schema), "born PENDING");
    ok(/model TeacherApplication \{[\s\S]*?userId\s+String\?\s+@unique/.test(schema), "userId nullable+unique (set only at activation)");
    ok(/model TeacherActivationToken \{[\s\S]*?tokenHash\s+String\s+@unique/.test(schema), "activation token hash unique (single-use foundation)");
    ok(/model TeacherActivationToken \{[\s\S]*?onDelete: Cascade/.test(schema), "tokens cascade with their application");
    const ddl = read("scripts/db/postgres-baseline.sql");
    ok(/CREATE TABLE "TeacherApplication"/.test(ddl) && /CREATE TABLE "TeacherActivationToken"/.test(ddl),
      "both tables in the PostgreSQL baseline");
    ok(/"status" "TeacherApplicationStatus" NOT NULL DEFAULT 'PENDING'/.test(ddl),
      "PENDING default preserved in PostgreSQL DDL");
    ok(/FOREIGN KEY \("applicationId"\) REFERENCES "TeacherApplication"/.test(ddl),
      "token->application FK in PostgreSQL DDL");
    // The verifier enforces the lifecycle coherence rules (D1-D4).
    const verifier = read("scripts/db/verify-postgres.mjs");
    for (const rule of ["D1", "D2", "D3", "D4"]) {
      ok(verifier.includes(`"${rule}"`), `verifier enforces lifecycle rule ${rule}`);
    }
  }

  // ---------------------------------------------------------------------------
  section("5. Migration tooling (fail-closed operator CLI)");
  // ---------------------------------------------------------------------------
  {
    const cli = read("scripts/db/migrate-sqlite-to-postgres.mjs");
    ok(/BEGIN/.test(cli) && /COMMIT/.test(cli) && /ROLLBACK/.test(cli), "load runs in one transaction (all-or-nothing)");
    ok(/target is not empty/.test(cli), "refuses a non-empty target by default");
    ok(/MIGRATION_EXCLUDED_TABLES/.test(cli), "exclusion rule imported from pg-lib (single definition)");
    ok(/_prisma_migrations/.test(read("scripts/db/pg-lib.mjs")), "only _prisma_migrations excluded (documented)");
    ok(/post-verify|Post-verify|HASH MISMATCH/.test(cli), "post-load count+hash verification inside the transaction");
    ok(/redactDatabaseUrl/.test(cli), "credentials redacted in output");
    // Behavioral: missing source exits 2; degenerate source exits 2.
    const quiet = { stdio: ["ignore", "pipe", "pipe"] };
    try {
      run("node scripts/db/migrate-sqlite-to-postgres.mjs --source /tmp/p21-nope.db --target postgresql://u@h/db", quiet);
      ok(false, "missing source exits non-zero");
    } catch (e) {
      ok(e.status === 2, `missing source exits 2 (got ${e.status})`);
    }
    const { DatabaseSync } = require("node:sqlite");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p21-cli-"));
    const tiny = path.join(tmp, "tiny.db");
    new DatabaseSync(tiny).exec(`CREATE TABLE "User" ("id" TEXT PRIMARY KEY)`);
    try {
      run(`node scripts/db/migrate-sqlite-to-postgres.mjs --source ${tiny} --target postgresql://u@h/db`, quiet);
      ok(false, "degenerate source exits non-zero");
    } catch (e) {
      ok(e.status === 2, `source missing tables exits 2 (got ${e.status})`);
      ok(/migrate SQLite to head/.test(String(e.stderr || "")), "error tells the operator to migrate SQLite to head");
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------
  section("6. Backup/restore scripts (verified procedure)");
  // ---------------------------------------------------------------------------
  {
    for (const s of ["scripts/db/backup-postgres.sh", "scripts/db/restore-postgres.sh"]) {
      run(`bash -n ${s}`);
      ok(true, `${s} passes bash -n`);
      ok((fs.statSync(path.join(REPO, s)).mode & 0o111) !== 0, `${s} is executable`);
    }
    const backup = read("scripts/db/backup-postgres.sh");
    ok(/pg_dump.*--format=custom/.test(backup), "backup uses pg_dump custom format");
    ok(/sha256sum/.test(backup) && /hash mismatch/i.test(backup), "backup re-hashes and fails on mismatch");
    ok(/BACKUP_PASSPHRASE/.test(backup) && /openssl enc -aes-256-cbc -pbkdf2/.test(backup),
      "optional AES-256/PBKDF2 encryption from env only");
    ok(/KEEP_MIN|keep-min/.test(backup), "retention always keeps N newest (clock-fault safe)");
    ok(!/echo[^\n]*\$\{?(URL|BACKUP_PASSPHRASE)\}?/.test(backup), "backup never echoes credentials (only the redacted URL)");
    const restore = read("scripts/db/restore-postgres.sh");
    ok(!/echo[^\n]*\$\{?(URL|BACKUP_PASSPHRASE)\}?/.test(restore), "restore never echoes credentials (only the redacted URL)");
    ok(/sha256 MISMATCH.*refusing to restore/.test(restore), "restore refuses on sha256 mismatch");
    ok(/target is NOT empty/.test(restore), "restore aborts on a non-empty target");
    ok(/verify-postgres\.mjs.*--target/.test(restore), "restore REQUIRES the verification battery");
    ok(/trap.*shred/.test(restore), "decrypted scratch is shredded after restore");
  }

  // ---------------------------------------------------------------------------
  section("7. Durable media migration (behavioral)");
  // ---------------------------------------------------------------------------
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p21-media-"));
    const srcDir = path.join(tmp, "src");
    const dstDir = path.join(tmp, "dst");
    fs.mkdirSync(path.join(srcDir, "session-pdfs"), { recursive: true });
    fs.mkdirSync(path.join(srcDir, "evidence"), { recursive: true });
    fs.writeFileSync(path.join(srcDir, "session-pdfs", "a.pdf"), Buffer.from("%PDF-1.4-phase21-fixture"));
    fs.writeFileSync(path.join(srcDir, "evidence", "e1.jpg"), Buffer.from("fake-jpeg-bytes"));
    fs.writeFileSync(path.join(srcDir, "empty.bin"), Buffer.alloc(0));
    try { fs.symlinkSync(path.join(srcDir, "evidence", "e1.jpg"), path.join(srcDir, "link.jpg")); } catch { /* FS without symlink rights */ }
    const manifestPath = path.join(tmp, "manifest.json");
    const out = run(`node scripts/media/migrate-media.mjs --source ${srcDir} --dest ${dstDir} --manifest ${manifestPath}`);
    ok(/MEDIA_MIGRATE_OK/.test(out), "migration completes (MEDIA_MIGRATE_OK)");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    ok(manifest.totalFiles === 3, `manifest lists 3 files (symlink skipped, got ${manifest.totalFiles})`);
    ok(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), "every file has a SHA-256");
    ok(JSON.stringify(manifest.files.map((f) => f.key)) === JSON.stringify([...manifest.files.map((f) => f.key)].sort()),
      "manifest keys are in sorted (deterministic) order");
    // Source untouched.
    ok(fs.readFileSync(path.join(srcDir, "evidence", "e1.jpg"), "utf8") === "fake-jpeg-bytes",
      "source tree untouched by migration");
    const checkOut = run(`node scripts/media/migrate-media.mjs --check ${manifestPath} --dest ${dstDir}`);
    ok(/MEDIA_CHECK_OK/.test(checkOut), "--check verifies the destination (MEDIA_CHECK_OK)");
    // Tamper detection (same-length byte flip: size matches, hash must not).
    fs.writeFileSync(path.join(dstDir, "evidence", "e1.jpg"), Buffer.from("Xake-jpeg-bytes"));
    try {
      run(`node scripts/media/migrate-media.mjs --check ${manifestPath} --dest ${dstDir}`, { stdio: ["ignore", "pipe", "pipe"] });
      ok(false, "tampered file fails --check");
    } catch (e) {
      ok(e.status === 2, `tampered file exits 2 (got ${e.status})`);
      ok(/sha256 mismatch/.test(String(e.stdout || "") + String(e.stderr || "")), "tamper reported as sha256 mismatch");
    }
    // Determinism: re-inventory is stable.
    const invOut = run(`node scripts/media/migrate-media.mjs --source ${srcDir} --dest ${dstDir} --inventory-only`);
    ok(/MEDIA_INVENTORY_OK/.test(invOut), "--inventory-only mode works");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------
  section("8. Evidence retention (behavioral: rule + purge script)");
  // ---------------------------------------------------------------------------
  {
    // 8a. Pure-TS rule behavior via a tsx harness (canonical module, not a copy).
    const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p21-harness-"));
    const harness = path.join(harnessDir, "rule.mts");
    fs.writeFileSync(harness, `
import { selectExpiredEvidence, isEvidenceExpired, resolveRetentionDays, EVIDENCE_PURGE_PROTECTED_TABLES } from ${JSON.stringify(path.join(REPO, "src", "lib", "evidence-retention.ts"))};
import { parseBytesEnv, checkQuota, assertVolumeQuota } from ${JSON.stringify(path.join(REPO, "src", "lib", "storage-quotas.ts"))};
const now = new Date("2026-09-11T00:00:00.000Z");
const rows = [
  { id: "past", retainUntil: new Date("2026-01-01T00:00:00.000Z") },
  { id: "exact", retainUntil: new Date("2026-09-11T00:00:00.000Z") },
  { id: "future", retainUntil: new Date("2027-01-01T00:00:00.000Z") },
  { id: "null", retainUntil: null },
  { id: "undef", retainUntil: undefined },
  { id: "garbage", retainUntil: "not-a-date" },
  { id: "past-str", retainUntil: "2026-01-01T00:00:00.000Z" },
  { id: "past-ms", retainUntil: Date.parse("2026-01-01T00:00:00.000Z") },
];
const { expired, retained } = selectExpiredEvidence(rows, now);
const results = {
  expired: expired.map((r) => r.id).sort(),
  retained: retained.map((r) => r.id).sort(),
  exactIsExpired: isEvidenceExpired({ retainUntil: now }, now),
  defaultDays: resolveRetentionDays({}),
  protected: [...EVIDENCE_PURGE_PROTECTED_TABLES],
  bytes: [parseBytesEnv(null), parseBytesEnv(""), parseBytesEnv("0"), parseBytesEnv("1024"), parseBytesEnv("10GB"), parseBytesEnv("512 MB")],
  quotaUnset: checkQuota({ currentBytes: 10 ** 12, incomingBytes: 10 ** 12, quotaBytes: 0 }),
  quotaFit: checkQuota({ currentBytes: 100, incomingBytes: 50, quotaBytes: 200 }),
  quotaOver: checkQuota({ currentBytes: 100, incomingBytes: 101, quotaBytes: 200 }),
  quotaFull: checkQuota({ currentBytes: 200, incomingBytes: 0, quotaBytes: 200 }),
  assertUnset: await assertVolumeQuota(10 ** 12, { env: {} }),
};
let threw = false;
try { parseBytesEnv("ten gigabytes"); } catch { threw = true; }
results.bytesThrow = threw;
console.log("HARNESS_JSON " + JSON.stringify(results));
`);
    const hout = run(`npx tsx ${harness}`);
    const hjson = JSON.parse(/HARNESS_JSON (\{.*\})/s.exec(hout)[1]);
    ok(JSON.stringify(hjson.expired) === JSON.stringify(["exact", "past", "past-ms", "past-str"]),
      `expired = past/now-boundary only (${hjson.expired.join(",")})`);
    ok(JSON.stringify(hjson.retained) === JSON.stringify(["future", "garbage", "null", "undef"]),
      "future/null/undefined/unparseable are retained (fail-closed)");
    ok(hjson.exactIsExpired === true, "deadline == now counts as expired");
    ok(hjson.defaultDays === 30, "default retention is 30 days");
    for (const t of ["SecurityEvent", "AuditLog", "TeacherApplication", "TeacherActivationToken", "UserSession", "PasswordResetToken", "SecurityRateLimit"]) {
      ok(hjson.protected.includes(t), `purge protects ${t}`);
    }
    ok(JSON.stringify(hjson.bytes) === JSON.stringify([0, 0, 0, 1024, 10 * 1024 ** 3, 512 * 1024 ** 2]),
      "byte-size parsing (plain/human, unset=0)");
    ok(hjson.bytesThrow === true, "garbage byte size throws (fail-closed)");
    ok(hjson.quotaUnset.ok === true && hjson.quotaUnset.enforced === false, "unset quota allows everything (no-op default)");
    ok(hjson.quotaFit.ok === true && hjson.quotaOver.ok === false && hjson.quotaOver.code === "QUOTA_EXCEEDED" && hjson.quotaFull.ok === false,
      "quota decision: fit allows, over/full reject with QUOTA_EXCEEDED");
    ok(hjson.assertUnset.ok === true && hjson.assertUnset.enforced === false, "assertVolumeQuota is a no-op when unset");
    fs.rmSync(harnessDir, { recursive: true, force: true });

    // 8b. Purge script: dry-run changes nothing, live deletes only expired.
    const fixtures = await import("../scripts/db/fixtures-phase21.mjs");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p21-purge-"));
    const dbFile = path.join(tmp, "purge.db");
    fixtures.buildFixtureSqlite(dbFile);
    const { DatabaseSync } = require("node:sqlite");
    const countEvidence = () => {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try { return db.prepare(`SELECT COUNT(*) AS n FROM "QuizAttemptEvidence"`).get().n; } finally { db.close(); }
    };
    ok(countEvidence() === 3, "purge fixture starts with 3 evidence rows");
    const dryOut = run(`npx tsx scripts/media/purge-expired-evidence.ts --sqlite ${dbFile} --now 2026-09-11T00:00:00.000Z`);
    ok(/PURGE_DRY_RUN_OK expired=1/.test(dryOut), "dry run reports exactly 1 expired row");
    ok(countEvidence() === 3, "dry run changes nothing");
    // --live without --yes refuses.
    try {
      run(`npx tsx scripts/media/purge-expired-evidence.ts --sqlite ${dbFile} --now 2026-09-11T00:00:00.000Z --live`);
      ok(false, "--live without --yes refuses");
    } catch (e) {
      ok(e.status === 1, `--live without --yes exits 1 (got ${e.status})`);
    }
    ok(countEvidence() === 3, "refused run changes nothing");
    const metricsPath = path.join(tmp, "metrics.json");
    const liveOut = run(`npx tsx scripts/media/purge-expired-evidence.ts --sqlite ${dbFile} --now 2026-09-11T00:00:00.000Z --live --yes --metrics ${metricsPath}`);
    ok(/PURGE_LIVE_OK deleted=1/.test(liveOut), "live run deletes exactly 1 row");
    ok(countEvidence() === 2, "2 evidence rows survive (live + status-only)");
    const metrics = JSON.parse(fs.readFileSync(metricsPath, "utf8"));
    ok(metrics.ok === true && metrics.deletedEvidenceRows === 1, "metrics record the deletion");
    ok(metrics.protectedTables.SecurityEvent === metrics.protectedTablesAfter.SecurityEvent &&
       metrics.protectedTables.TeacherApplication === metrics.protectedTablesAfter.TeacherApplication,
      "protected-table counts identical before/after");
    // 8c. Detached-asset file deletion path (scratch DB + scratch media dir).
    const db2 = path.join(tmp, "detach.db");
    {
      const d = new DatabaseSync(db2);
      d.exec(`CREATE TABLE "QuizAttemptEvidence" ("id" TEXT PRIMARY KEY, "attemptId" TEXT, "mediaAssetId" TEXT, "kind" TEXT, "status" TEXT, "capturedAt" TEXT, "retainUntil" TEXT);
              CREATE TABLE "Material" ("id" TEXT PRIMARY KEY, "mediaAssetId" TEXT);
              CREATE TABLE "SessionVideo" ("id" TEXT PRIMARY KEY, "mediaAssetId" TEXT);
              CREATE TABLE "MediaAsset" ("id" TEXT PRIMARY KEY, "storage" TEXT, "storageKey" TEXT);
              ${["SecurityEvent", "AuditLog", "TeacherApplication", "TeacherActivationToken", "UserSession", "PasswordResetToken", "SecurityRateLimit", "QuizAttempt", "Student", "User"].map((t) => `CREATE TABLE "${t}" ("id" TEXT PRIMARY KEY);`).join("\n")}`);
      d.exec(`INSERT INTO "MediaAsset" VALUES ('ma-detach','LOCAL_PRIVATE','evidence/detach.jpg');
              INSERT INTO "QuizAttemptEvidence" VALUES ('ev-old','att1','ma-detach','SNAPSHOT',NULL,'2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')`);
      d.close();
    }
    const mediaRoot = path.join(tmp, "media");
    fs.mkdirSync(path.join(mediaRoot, "evidence"), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, "evidence", "detach.jpg"), Buffer.from("doomed-bytes"));
    const detachOut = run(`npx tsx scripts/media/purge-expired-evidence.ts --sqlite ${db2} --media-root ${mediaRoot} --now 2026-09-11T00:00:00.000Z --live --yes`);
    ok(/assets=1 files=1/.test(detachOut), "detached asset row + file both deleted");
    ok(!fs.existsSync(path.join(mediaRoot, "evidence", "detach.jpg")), "detached file removed from disk");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------
  section("9. Storage quotas (wired into every upload path)");
  // ---------------------------------------------------------------------------
  {
    const sites = [
      "src/lib/session-materials.ts",
      "src/app/api/admin/session-videos/route.ts",
      "src/app/api/quizzes/[id]/evidence/route.ts",
    ];
    for (const s of sites) {
      const text = read(s);
      const qi = text.indexOf("assertVolumeQuota");
      const wi = text.indexOf("writePrivateFile(");
      ok(qi !== -1 && wi !== -1 && qi < wi, `${s}: quota checked before any byte is written`);
    }
    const matRoute = read("src/app/api/admin/lessons/[id]/materials/route.ts");
    ok(/QUOTA_EXCEEDED.*413/s.test(matRoute), "materials route maps QUOTA_EXCEEDED to 413");
    ok(/Media storage quota exceeded/.test(read("src/app/api/admin/session-videos/route.ts")),
      "session-videos route rejects over-quota uploads");
    // Default-off proof lives in §8 (assertUnset); here: env contract documented.
    ok(/MEDIA_QUOTA_BYTES/.test(read(".env.example")), ".env.example documents MEDIA_QUOTA_BYTES");
  }

  // ---------------------------------------------------------------------------
  section("10. setup-production (complete, provider-safe, no teacher provisioning)");
  // ---------------------------------------------------------------------------
  {
    const setup = read("scripts/setup-production.ts");
    // Every destructive-table deleteMany present (55 models minus Setting/SubscriptionPlan/User-handled).
    const parsed = pgLib.parseSchema();
    const missingDeletes = [];
    for (const name of parsed.models.keys()) {
      if (name === "Setting" || name === "SubscriptionPlan") continue;
      if (!setup.includes(`prisma.${name[0].toLowerCase() + name.slice(1)}.deleteMany`)) {
        missingDeletes.push(name);
      }
    }
    ok(missingDeletes.length === 0, `setup-production deletes all 53 non-preserved models (${missingDeletes.slice(0, 4).join(", ") || "complete"})`);
    ok(!/prisma\.setting\.deleteMany/.test(setup) && !/prisma\.subscriptionPlan\.deleteMany/.test(setup),
      "Settings + SubscriptionPlans preserved (no deleteMany)");
    // New-table coverage (the Phase 21 additions).
    for (const t of ["sessionVideo", "mockExam", "enrollment", "material", "sessionPublication",
      "teacherApplication", "teacherActivationToken", "userSession", "passwordResetToken",
      "securityRateLimit", "securityEvent", "quizAttemptEvidence", "mediaAsset", "batch"]) {
      ok(setup.includes(`prisma.${t}.deleteMany`), `setup-production clears ${t}`);
    }
    // No teacher provisioning, no hardcoded secrets.
    const createBlock = /prisma\.user\.create\(\{[\s\S]*?\}\)/.exec(setup);
    ok(createBlock && /Role\.ADMIN/.test(createBlock[0]) && !/TEACHER/.test(createBlock[0]),
      "setup-production creates exactly one ADMIN (no TEACHER creation path)");
    ok(!/role:\s*"TEACHER"/.test(setup), "no TEACHER role literal in setup-production");
    ok(/password\.length < 8/.test(setup), "admin password floor is 8 (audit-gate minimum)");
    ok(/--dry-run/.test(setup), "--dry-run supported (report only)");
    ok(/TeacherApplications : .*must be 0/.test(setup) && /UserSessions.*must be 0/.test(setup) && /SecurityEvents.*must be 0/.test(setup),
      "final verification asserts zero provisioning/security rows");
    ok(/MediaAsset rows are deleted last/.test(setup), "Restrict-safe MediaAsset ordering documented");
  }

  // ---------------------------------------------------------------------------
  section("11. Live drills (disposable PostgreSQL: rehearsal + restore)");
  // ---------------------------------------------------------------------------
  {
    try {
      const mig = run("node scripts/verify-phase21-migration.mjs");
      ok(/PHASE21_MIGRATION_OK/.test(mig), "migration rehearsal passed (PHASE21_MIGRATION_OK)");
      ok(/row counts preserved on all 55 tables/.test(mig), "rehearsal preserved all row counts");
      ok(/canonical row hashes identical/.test(mig), "rehearsal proved byte-identity via hashes");
    } catch (e) {
      ok(false, "migration rehearsal passed");
      console.error(String(e.stdout || "").slice(-2000));
    }
    try {
      const rst = run("node scripts/verify-phase21-restore.mjs");
      ok(/PHASE21_RESTORE_OK/.test(rst), "restore drill passed (PHASE21_RESTORE_OK)");
      ok(/B is identical to A/.test(rst), "restored copy identical to backup source");
      ok(/sha256 detects the tamper/.test(rst), "tamper detection proved non-vacuous");
      ok(/all four application states survived/.test(rst), "teacher lifecycle survived the restore");
    } catch (e) {
      ok(false, "restore drill passed");
      console.error(String(e.stdout || "").slice(-2000));
    }
  }

  // ---------------------------------------------------------------------------
  section("12. Docs & environment contract");
  // ---------------------------------------------------------------------------
  {
    const phase = read("docs/PHASE_21_PRODUCTION_DATABASE_STORAGE.md");
    for (const h of ["PostgreSQL", "Schema Compatibility", "Data Migration", "Rehearsal",
      "Backup", "Restore Drill", "Durable Media", "Retention", "Quota", "Rollback",
      "Security Audit Gate", "GO"]) {
      ok(phase.includes(h), `phase doc covers "${h}"`);
    }
    const runbook = read("docs/POSTGRES_CUTOVER_RUNBOOK.md");
    for (const h of ["Freeze", "Snapshot", "Load", "Validation", "Switch", "Verification", "Rollback"]) {
      ok(new RegExp(h, "i").test(runbook), `runbook covers "${h}"`);
    }
    ok(/Teacher Application/.test(runbook), "runbook validates Teacher Application state");
    ok(/verify-postgres\.mjs/.test(runbook), "runbook requires the verification battery");
    ok(/PostgreSQL/.test(read("docs/DATABASE_GUIDE.md")), "DATABASE_GUIDE covers PostgreSQL");
    ok(/PostgreSQL|pg_dump/.test(read("docs/DEPLOYMENT_GUIDE.md")), "DEPLOYMENT_GUIDE covers PostgreSQL ops");
    ok(/Phase 21/.test(read("docs/PROJECT_STATE.md")), "PROJECT_STATE records Phase 21");
    const env = read(".env.example");
    for (const v of ["POSTGRES_URL", "MEDIA_QUOTA_BYTES", "BACKUP_PASSPHRASE"]) {
      ok(env.includes(v), `.env.example documents ${v}`);
    }
    ok(!/^DATABASE_URL="postgresql:\/\/[^"]*:[^"]+@/m.test(env), ".env.example contains no real database password");
    const gi = read(".gitignore");
    for (const pat of ["/backups/", "*.dump", "*.pg-load.json"]) {
      ok(gi.includes(pat), `.gitignore excludes ${pat}`);
    }
    // Credentials must never be committed (sweep the Phase 21 surface).
    const newFiles = ["scripts/db/pg-lib.mjs", "scripts/db/migrate-sqlite-to-postgres.mjs",
      "scripts/db/verify-postgres.mjs", "scripts/media/purge-expired-evidence.ts",
      "src/lib/storage-quotas.ts", "src/lib/evidence-retention.ts"];
    let secretHits = [];
    for (const f of newFiles) {
      const text = read(f);
      if (/password\s*=\s*"[^"]{3,}"|secret\s*=\s*"[^"]{8,}"|BEGIN PRIVATE KEY/i.test(text)) secretHits.push(f);
    }
    ok(secretHits.length === 0, `no committed secrets in Phase 21 files (${secretHits.join(",") || "clean"})`);
  }

  // ---------------------------------------------------------------------------
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Phase 21 production-storage tests: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log("  -", f);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
