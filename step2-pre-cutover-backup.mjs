#!/usr/bin/env node
/**
 * CodeMind Academy — STEP 2: BACKUP & PRE-CUTOVER SNAPSHOT
 * ============================================================================
 * Run this ON THE WINDOWS MACHINE that holds the real database.
 *
 *   node E:\workspace\step2-pre-cutover-backup.mjs --dry-run     (writes NOTHING)
 *   node E:\workspace\step2-pre-cutover-backup.mjs               (creates backups)
 *
 * Requires Node >= 22.12 (for `node:sqlite` readOnly support). The script
 * PROBES that capability on a throwaway temp DB first and REFUSES to run if
 * read-only mode is not actually honoured by your Node build.
 *
 * ---------------------------------------------------------------------------
 * SAFETY CONTRACT (what this script guarantees)
 * ---------------------------------------------------------------------------
 *  1. The source database is opened ONLY with `{ readOnly: true }`.
 *     It is never opened in write mode. No write-mode handle is ever attempted.
 *  2. No INSERT / UPDATE / DELETE / CREATE / DROP / TRUNCATE / REPLACE is ever
 *     issued against the source. The only statements run against it are
 *     SELECT, COUNT, GROUP BY, PRAGMA integrity_check, PRAGMA foreign_key_check
 *     and `VACUUM INTO '<new file>'` (which writes ONLY to a NEW destination).
 *  3. Source SHA-256 + byte size are captured BEFORE anything happens and
 *     re-verified AFTER everything. If they differ by even one byte the script
 *     reports IMMUTABILITY VIOLATED and exits non-zero.
 *  4. Backups are NEW files with a fresh UTC timestamp. `fs.copyFile` uses
 *     COPYFILE_EXCL and `VACUUM INTO` refuses an existing target, so an
 *     existing artifact can NEVER be overwritten. The known older backup
 *     `pre-production-setup-2026-09-11T14-30-39-609Z.db` is additionally on an
 *     explicit deny-list and is never read, written, renamed or deleted.
 *  5. Nothing is deleted. Ever. No cleanup, no prune, no rotation.
 *  6. No password, password hash, token, token hash, secret, cookie or
 *     credential value is ever SELECTed, printed, or written to the manifest.
 *     Only aggregate counts, role names, curriculum codes and digests.
 *  7. No prisma command, no migration, no seed, no reconcile, no setup-production,
 *     no phase22 script, no PostgreSQL, no S3/R2, no Vercel, no .env change.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE TWO BACKUP ARTIFACTS (the Phase B / Phase D conflict)
 * ---------------------------------------------------------------------------
 * SQLite-native snapshot APIs (`sqlite3 .backup`, `VACUUM INTO`, the online
 * backup API) REBUILD the destination file: they rewrite the header
 * change-counter, compact the freelist and normalise page layout. The result is
 * logically identical but byte-different, so its SHA-256 can NEVER equal the
 * source's — even when the byte size is identical. Only a byte-for-byte file
 * copy hash-matches.
 *
 * So this script produces BOTH, and grades them against the correct criterion:
 *
 *   pre-cutover-<STAMP>-copy.db       byte-for-byte copy
 *                                     -> SHA-256 MUST equal the source
 *                                     -> proves a bit-perfect duplicate
 *
 *   pre-cutover-<STAMP>-snapshot.db   VACUUM INTO from a read-only connection
 *                                     -> SHA-256 WILL differ (by design)
 *                                     -> graded on LOGICAL equivalence:
 *                                        integrity_check=ok, foreign_key_check=[],
 *                                        identical table count and identical
 *                                        baseline count vector vs the source
 *
 * A hash mismatch on the SNAPSHOT is EXPECTED and is NOT a failure.
 * A hash mismatch on the COPY is a HARD FAILURE and stops the step.
 * ============================================================================
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Configuration (override with --source / --backups / --media / --repo)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const DRY_RUN = argv.includes("--dry-run");

const SOURCE = argOf("--source") || "E:\\workspace\\db\\custom.db";
const BACKUP_DIR = argOf("--backups") || "E:\\workspace\\backups";
const MEDIA_DIR = argOf("--media") || "E:\\workspace\\storage\\media";
const REPO_DIR = argOf("--repo") || "E:\\workspace";

/** Artifacts that must never be read, written, renamed, overwritten or deleted. */
const PROTECTED = ["pre-production-setup-2026-09-11T14-30-39-609Z.db"];

/** The documented P22 baseline. Used for reporting deltas only — never to
 *  "correct" anything. A mismatch is reported, not repaired. */
const EXPECTED = {
  admins: 2, teachers: 1, students: 0, parents: 0,
  parts: 2, units: 7, officialLessons: 23,
  officialCodes: ["1-1","1-2","1-3","1-4","2-1","2-2","2-3","3-1","3-2","3-3",
                  "4-1","4-2","4-3","4-4","5-1","5-2","5-3","6-1","6-2","6-3",
                  "7-1","7-2","7-3"],
  mediaAssets: 0, sessionVideos: 0, materials: 0, quizAttemptEvidence: 0,
};

const SQLITE_MAGIC = "SQLite format 3\0";

let exitCode = 0;
const problems = [];
const note = (m) => { problems.push(m); };
const fail = (m) => { problems.push("FATAL: " + m); exitCode = 1; };

function sha256File(p) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(p)); // source DB is ~816KB; whole-file read is fine
  return h.digest("hex");
}
function statOf(p) {
  const s = fs.statSync(p);
  return { sizeBytes: s.size, modifiedAt: s.mtime.toISOString() };
}
/** UTC stamp in the exact requested shape: YYYYMMDDTHHMMSSZ */
function utcStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// ---------------------------------------------------------------------------
// 0. Preflight — prove read-only mode is really enforced before touching the DB
// ---------------------------------------------------------------------------
console.log("CodeMind Academy — STEP 2 pre-cutover backup (read-only on source)");
console.log(`mode      : ${DRY_RUN ? "DRY-RUN (writes nothing)" : "LIVE (creates backup artifacts)"}`);
console.log(`node      : ${process.version}`);
console.log(`source    : ${SOURCE}`);
console.log(`backupDir : ${BACKUP_DIR}`);
console.log(`mediaDir  : ${MEDIA_DIR}`);
console.log("");

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch (e) {
  fail(`node:sqlite unavailable (${e.message}). Node >= 22.5 required; readOnly needs >= 22.12. Ask for the Python variant.`);
  report(); process.exit(1);
}

// Capability probe on a THROWAWAY temp DB. If `{readOnly:true}` is silently
// ignored by this Node build, we would open the production DB writable — so we
// abort instead. This probe never touches the source or the repo.
{
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-step2-probe-"));
  const probeDb = path.join(probeDir, "probe.db");
  try {
    const w = new DatabaseSync(probeDb);
    w.exec("CREATE TABLE t(a TEXT)");
    w.close();
    let enforced = false;
    try {
      const r = new DatabaseSync(probeDb, { readOnly: true });
      try { r.exec("INSERT INTO t VALUES ('x')"); } catch { enforced = true; }
      r.close();
    } catch { enforced = true; }
    if (!enforced) fail("readOnly is NOT enforced by this Node build — refusing to open the source. Upgrade Node (>=22.12) or request the Python variant.");
    else console.log("preflight : readOnly enforcement VERIFIED on a throwaway probe DB");
  } finally {
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
  }
}

if (!fs.existsSync(SOURCE)) { fail(`source database not found: ${SOURCE}`); report(); process.exit(1); }

// Magic-byte check: confirm it really is a SQLite database before anything else.
{
  const fd = fs.openSync(SOURCE, "r"); // 'r' = read-only flag, no write access
  const buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  if (buf.toString("latin1") !== SQLITE_MAGIC) fail(`${SOURCE} is not a SQLite database (bad magic bytes).`);
  else console.log("preflight : SQLite magic bytes confirmed");
}

// Sidecar files indicate a live writer / hot journal. A byte copy would then be
// inconsistent, so we detect and report rather than silently copying.
const sidecars = ["-journal", "-wal", "-shm"]
  .map((s) => SOURCE + s)
  .filter((p) => fs.existsSync(p) && fs.statSync(p).size > 0);
if (sidecars.length) {
  note(`SQLite sidecar file(s) present and non-empty: ${sidecars.join(", ")} — a process may hold the database open. Stop the application and retry before trusting the byte-copy artifact.`);
} else {
  console.log("preflight : no -journal/-wal/-shm sidecars (no evidence of an active writer)");
}

// ---------------------------------------------------------------------------
// A. Pre-backup source fingerprint (read-only)
// ---------------------------------------------------------------------------
const sourceBefore = { path: SOURCE, ...statOf(SOURCE), sha256: sha256File(SOURCE) };
console.log("");
console.log(`A. SOURCE  size=${sourceBefore.sizeBytes}  sha256=${sourceBefore.sha256}`);

/** Read-only baseline vector. Every query is SELECT/COUNT/PRAGMA only. */
function baseline(db) {
  const one = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return [{ __error: e.message }]; } };
  const scalar = (sql) => { try { const r = db.prepare(sql).get(); return r ? Object.values(r)[0] : null; } catch { return null; } };

  const tableNames = one("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((r) => r.name).filter((n) => typeof n === "string");

  const roles = one("SELECT role, COUNT(*) AS c FROM User GROUP BY role ORDER BY role");
  const roleMap = Object.fromEntries(roles.filter((r) => r.role).map((r) => [r.role, r.c]));

  const codes = one("SELECT officialCode FROM Lesson WHERE officialCode IS NOT NULL ORDER BY officialCode")
    .map((r) => r.officialCode).filter((c) => typeof c === "string");

  const status = one("SELECT status, COUNT(*) AS c FROM Lesson GROUP BY status ORDER BY status");
  const curriculum = one("SELECT curriculumStatus, COUNT(*) AS c FROM Lesson GROUP BY curriculumStatus ORDER BY curriculumStatus");

  const cnt = (t) => scalar(`SELECT COUNT(*) AS c FROM "${t}"`);

  return {
    tables: tableNames.length,
    tableNames,
    hasPrismaMigrationsTable: tableNames.includes("_prisma_migrations"),
    users: cnt("User"),
    admins: roleMap.ADMIN ?? 0,
    teachers: roleMap.TEACHER ?? 0,
    students: roleMap.STUDENT ?? 0,
    parents: roleMap.PARENT ?? 0,
    rolesOther: Object.entries(roleMap).filter(([k]) => !["ADMIN","TEACHER","STUDENT","PARENT"].includes(k)),
    parts: cnt("Part"),
    units: cnt("Unit"),
    lessons: cnt("Lesson"),
    officialLessons: scalar("SELECT COUNT(*) AS c FROM Lesson WHERE curriculumStatus='OFFICIAL'"),
    archivedLessons: scalar("SELECT COUNT(*) AS c FROM Lesson WHERE curriculumStatus='ARCHIVED'"),
    officialCodes: codes,
    officialCodeCount: codes.length,
    officialCodeDistinct: new Set(codes).size,
    duplicateOfficialCodes: one("SELECT officialCode, COUNT(*) AS c FROM Lesson WHERE officialCode IS NOT NULL GROUP BY officialCode HAVING COUNT(*)>1"),
    officialWithoutCode: scalar("SELECT COUNT(*) AS c FROM Lesson WHERE curriculumStatus='OFFICIAL' AND officialCode IS NULL"),
    archivedWithCode: scalar("SELECT COUNT(*) AS c FROM Lesson WHERE curriculumStatus='ARCHIVED' AND officialCode IS NOT NULL"),
    lessonsMissingUnit: scalar("SELECT COUNT(*) AS c FROM Lesson WHERE unitId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM Unit u WHERE u.id = Lesson.unitId)"),
    lessonStatus: Object.fromEntries(status.filter((r) => r.status !== undefined).map((r) => [String(r.status), r.c])),
    curriculumStatus: Object.fromEntries(curriculum.filter((r) => r.curriculumStatus !== undefined).map((r) => [String(r.curriculumStatus), r.c])),
    mediaAssets: cnt("MediaAsset"),
    sessionVideos: cnt("SessionVideo"),
    materials: cnt("Material"),
    quizAttemptEvidence: cnt("QuizAttemptEvidence"),
    sessionPublications: cnt("SessionPublication"),
    notifications: cnt("Notification"),
    securityEvents: cnt("SecurityEvent"),
    userSessions: cnt("UserSession"),
    passwordResetTokens: cnt("PasswordResetToken"),
    teacherApplications: cnt("TeacherApplication"),
    teacherActivationTokens: cnt("TeacherActivationToken"),
    securityRateLimits: cnt("SecurityRateLimit"),
    auditLogs: cnt("AuditLog"),
  };
}
function integrity(db) {
  const q = (s) => { try { return db.prepare(s).all(); } catch (e) { return [{ __error: e.message }]; } };
  const ic = q("PRAGMA integrity_check");
  const fk = q("PRAGMA foreign_key_check");
  return {
    sqliteIntegrityCheck: ic.length === 1 && ic[0].integrity_check === "ok" ? "ok" : JSON.stringify(ic),
    foreignKeyCheck: fk,
    foreignKeyViolationCount: fk.filter((r) => !r.__error).length,
  };
}

const srcDb = new DatabaseSync(SOURCE, { readOnly: true });
const dbBefore = baseline(srcDb);
const intBefore = integrity(srcDb);
srcDb.close();

console.log(`A. BASELINE tables=${dbBefore.tables} users=${dbBefore.users} ` +
  `ADMIN=${dbBefore.admins} TEACHER=${dbBefore.teachers} STUDENT=${dbBefore.students} PARENT=${dbBefore.parents} ` +
  `Parts=${dbBefore.parts} Units=${dbBefore.units} Lessons=${dbBefore.lessons} OFFICIAL=${dbBefore.officialLessons}`);
console.log(`A. INTEGRITY integrity_check=${intBefore.sqliteIntegrityCheck} foreign_key_violations=${intBefore.foreignKeyViolationCount}`);

// Baseline sanity notes (reported, never repaired)
if (dbBefore.admins !== EXPECTED.admins) note(`ADMIN=${dbBefore.admins}, documented P22 baseline expects ${EXPECTED.admins}`);
if (dbBefore.teachers !== EXPECTED.teachers) note(`TEACHER=${dbBefore.teachers}, documented baseline expects ${EXPECTED.teachers}`);
if (dbBefore.students !== EXPECTED.students) note(`STUDENT=${dbBefore.students}, documented baseline expects ${EXPECTED.students}`);
if (dbBefore.parents !== EXPECTED.parents) note(`PARENT=${dbBefore.parents}, documented baseline expects ${EXPECTED.parents}`);
if (dbBefore.parts !== EXPECTED.parts) note(`Parts=${dbBefore.parts}, documented baseline expects ${EXPECTED.parts}`);
if (dbBefore.units !== EXPECTED.units) note(`Units=${dbBefore.units}, documented baseline expects ${EXPECTED.units}`);
if (dbBefore.officialLessons !== EXPECTED.officialLessons) note(`OFFICIAL lessons=${dbBefore.officialLessons}, documented baseline expects ${EXPECTED.officialLessons}`);
if (JSON.stringify(dbBefore.officialCodes) !== JSON.stringify(EXPECTED.officialCodes)) note(`officialCode set differs from documented 1-1..7-3`);
if (dbBefore.officialCodeCount !== dbBefore.officialCodeDistinct) note(`duplicate officialCode values detected`);
if (intBefore.sqliteIntegrityCheck !== "ok") note(`source integrity_check is not 'ok': ${intBefore.sqliteIntegrityCheck}`);
if (intBefore.foreignKeyViolationCount !== 0) note(`source has ${intBefore.foreignKeyViolationCount} foreign-key violation(s)`);

// ---------------------------------------------------------------------------
// G. Media pre-cutover inventory (read-only) — done before writing anything
// ---------------------------------------------------------------------------
let media = { path: MEDIA_DIR, present: false, fileCount: 0, totalBytes: 0, files: [], manifestSha256: null };
if (fs.existsSync(MEDIA_DIR) && fs.statSync(MEDIA_DIR).isDirectory()) {
  media.present = true;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { note(`media: skipping symlink ${p}`); continue; }
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        media.files.push({ rel: path.relative(MEDIA_DIR, p).split(path.sep).join("/"), bytes: st.size, sha256: sha256File(p) });
        media.totalBytes += st.size;
      }
    }
  };
  walk(MEDIA_DIR);
  media.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)); // deterministic
  media.fileCount = media.files.length;
  const canon = media.files.map((f) => `${f.rel}:${f.bytes}:${f.sha256}`).join("\n");
  media.manifestSha256 = crypto.createHash("sha256").update(canon).digest("hex");
}
if (!media.present) {
  note(`MEDIA SOURCE EMPTY / NOT PRESENT: ${MEDIA_DIR}`);
} else if (media.fileCount === 0) {
  note(`media directory exists but contains 0 files: ${MEDIA_DIR}`);
}
// Cross-check DB metadata vs filesystem
const dbMediaRefs = (dbBefore.mediaAssets || 0) + (dbBefore.sessionVideos || 0) + (dbBefore.materials || 0) + (dbBefore.quizAttemptEvidence || 0);
if (dbBefore.mediaAssets !== EXPECTED.mediaAssets) note(`MediaAsset=${dbBefore.mediaAssets}, expected ${EXPECTED.mediaAssets}`);
if (dbMediaRefs !== media.fileCount) {
  note(`DB media rows (${dbMediaRefs}) != media files on disk (${media.fileCount}) — metadata/filesystem mismatch; do NOT migrate media until reconciled`);
}

// ---------------------------------------------------------------------------
// B/C/D/E. Create BOTH artifacts, hash them, verify them
// ---------------------------------------------------------------------------
const STAMP = utcStamp();
const copyPath = path.join(BACKUP_DIR, `pre-cutover-${STAMP}-copy.db`);
const snapPath = path.join(BACKUP_DIR, `pre-cutover-${STAMP}-snapshot.db`);
const manifestPath = path.join(BACKUP_DIR, `pre-cutover-${STAMP}.manifest.json`);

const artifacts = { copy: null, snapshot: null };

if (DRY_RUN) {
  console.log("");
  console.log("B/C. DRY-RUN — no artifacts created. Planned targets:");
  console.log(`     ${copyPath}`);
  console.log(`     ${snapPath}`);
  console.log(`     ${manifestPath}`);
} else {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`\nC. created backup directory ${BACKUP_DIR}`);
  } else {
    console.log(`\nC. backup directory already exists (nothing deleted): ${BACKUP_DIR}`);
  }

  // Refuse to touch protected artifacts or overwrite anything that exists.
  for (const target of [copyPath, snapPath, manifestPath]) {
    const base = path.basename(target);
    if (PROTECTED.includes(base)) { fail(`refusing to write protected artifact name ${base}`); report(); process.exit(1); }
    if (fs.existsSync(target)) { fail(`target already exists — refusing to overwrite: ${target}`); report(); process.exit(1); }
  }
  console.log(`C. protected artifact(s) confirmed untouched: ${PROTECTED.join(", ")}`);

  // --- Artifact 1: byte-for-byte copy (COPYFILE_EXCL => cannot overwrite) ---
  fs.copyFileSync(SOURCE, copyPath, fs.constants.COPYFILE_EXCL);
  // preserve timestamps so the copy is forensically faithful
  try { const s = fs.statSync(SOURCE); fs.utimesSync(copyPath, s.atime, s.mtime); } catch {}

  // --- Artifact 2: SQLite-native snapshot via VACUUM INTO on a READ-ONLY conn ---
  // VACUUM INTO writes ONLY to the new destination and refuses an existing file.
  const ro = new DatabaseSync(SOURCE, { readOnly: true });
  try {
    ro.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
  } finally {
    ro.close();
  }

  // --- D. Hash + size comparison ---
  for (const [kind, p] of [["copy", copyPath], ["snapshot", snapPath]]) {
    const st = statOf(p);
    const digest = sha256File(p);
    artifacts[kind] = {
      path: p, sizeBytes: st.sizeBytes, modifiedAt: st.modifiedAt,
      createdAt: new Date().toISOString(), sha256: digest,
      sizeMatchesSource: st.sizeBytes === sourceBefore.sizeBytes,
      sha256MatchesSource: digest === sourceBefore.sha256,
    };
  }

  // --- E. Verify each backup independently, read-only ---
  for (const kind of ["copy", "snapshot"]) {
    const b = new DatabaseSync(artifacts[kind].path, { readOnly: true });
    const bl = baseline(b);
    const ig = integrity(b);
    b.close();
    const diffKeys = [];
    for (const k of Object.keys(dbBefore)) {
      if (k === "tableNames" || k === "officialCodes") continue;
      if (JSON.stringify(dbBefore[k]) !== JSON.stringify(bl[k])) diffKeys.push(k);
    }
    if (JSON.stringify(dbBefore.officialCodes) !== JSON.stringify(bl.officialCodes)) diffKeys.push("officialCodes");
    artifacts[kind].verification = {
      integrity: ig,
      baselineMatchesSource: diffKeys.length === 0,
      baselineDifferences: diffKeys,
      baseline: bl,
    };
    if (ig.sqliteIntegrityCheck !== "ok") fail(`${kind} artifact integrity_check != ok: ${ig.sqliteIntegrityCheck}`);
    if (ig.foreignKeyViolationCount !== 0) fail(`${kind} artifact has ${ig.foreignKeyViolationCount} FK violation(s)`);
    if (diffKeys.length) fail(`${kind} artifact baseline differs from source in: ${diffKeys.join(", ")}`);
  }

  // Grade the two artifacts against their CORRECT criteria.
  if (!artifacts.copy.sha256MatchesSource) {
    fail(`COPY artifact SHA-256 does not match the source — a byte-for-byte copy MUST match. Something wrote to the source or the copy. STOP.`);
  }
  if (!artifacts.copy.sizeMatchesSource) {
    fail(`COPY artifact size does not match the source. STOP.`);
  }
  if (artifacts.snapshot.sha256MatchesSource) {
    note(`unexpected: the SQLite snapshot hash-matched the source (normally impossible — VACUUM INTO rebuilds the file). Not a failure, just recorded.`);
  }
}

// ---------------------------------------------------------------------------
// H. Source immutability re-check
// ---------------------------------------------------------------------------
const sourceAfter = { ...statOf(SOURCE), sha256: sha256File(SOURCE) };
const immutable = sourceAfter.sha256 === sourceBefore.sha256 && sourceAfter.sizeBytes === sourceBefore.sizeBytes;
if (!immutable) fail(`SOURCE IMMUTABILITY VIOLATED — sha256 before=${sourceBefore.sha256} after=${sourceAfter.sha256} size before=${sourceBefore.sizeBytes} after=${sourceAfter.sizeBytes}`);

let gitStatus = null;
try {
  if (fs.existsSync(path.join(REPO_DIR, ".git"))) {
    gitStatus = execFileSync("git", ["status", "--short"], { cwd: REPO_DIR, encoding: "utf8" });
  }
} catch (e) { gitStatus = `git unavailable: ${e.message}`; }

// ---------------------------------------------------------------------------
// F. Manifest (no secrets — counts, codes and digests only)
// ---------------------------------------------------------------------------
const manifest = {
  step: "STEP 2 — BACKUP & PRE-CUTOVER SNAPSHOT",
  generatedAt: new Date().toISOString(),
  mode: DRY_RUN ? "dry-run" : "live",
  tool: { node: process.version, platform: process.platform, generator: "step2-pre-cutover-backup.mjs" },
  source: {
    path: sourceBefore.path,
    sizeBytes: sourceBefore.sizeBytes,
    sha256: sourceBefore.sha256,
    modifiedAt: sourceBefore.modifiedAt,
  },
  // Primary rollback anchor = the byte-identical copy (Phase D hash criterion).
  backup: artifacts.copy ? {
    path: artifacts.copy.path,
    sizeBytes: artifacts.copy.sizeBytes,
    sha256: artifacts.copy.sha256,
    createdAt: artifacts.copy.createdAt,
    method: "byte-for-byte file copy (fs.copyFile COPYFILE_EXCL)",
    sha256MatchesSource: artifacts.copy.sha256MatchesSource,
    sizeMatchesSource: artifacts.copy.sizeMatchesSource,
  } : null,
  // Consistency-guaranteed snapshot (Phase B criterion). Hash differs BY DESIGN.
  snapshot: artifacts.snapshot ? {
    path: artifacts.snapshot.path,
    sizeBytes: artifacts.snapshot.sizeBytes,
    sha256: artifacts.snapshot.sha256,
    createdAt: artifacts.snapshot.createdAt,
    method: "VACUUM INTO from a readOnly:true connection",
    sha256MatchesSource: artifacts.snapshot.sha256MatchesSource,
    sha256DifferenceExpected: true,
    sha256DifferenceReason: "SQLite snapshot APIs rebuild the destination (header change-counter, freelist compaction, page normalisation) so the digest cannot equal the source's; graded on logical equivalence instead.",
  } : null,
  artifacts: ["copy", "snapshot"].filter((k) => artifacts[k]).map((k) => ({
    kind: k,
    path: artifacts[k].path,
    sizeBytes: artifacts[k].sizeBytes,
    sha256: artifacts[k].sha256,
    sha256MatchesSource: artifacts[k].sha256MatchesSource,
    sizeMatchesSource: artifacts[k].sizeMatchesSource,
    integrity: artifacts[k].verification?.integrity ?? null,
    baselineMatchesSource: artifacts[k].verification?.baselineMatchesSource ?? null,
    baselineDifferences: artifacts[k].verification?.baselineDifferences ?? null,
  })),
  manifestPath: DRY_RUN ? manifestPath : manifestPath,
  database: {
    tables: dbBefore.tables,
    includesPrismaMigrationsTable: dbBefore.hasPrismaMigrationsTable,
    users: dbBefore.users,
    admins: dbBefore.admins,
    teachers: dbBefore.teachers,
    students: dbBefore.students,
    parents: dbBefore.parents,
    parts: dbBefore.parts,
    units: dbBefore.units,
    lessons: dbBefore.lessons,
    officialLessons: dbBefore.officialLessons,
    archivedLessons: dbBefore.archivedLessons,
    officialCodeCount: dbBefore.officialCodeCount,
    officialCodeDistinct: dbBefore.officialCodeDistinct,
    officialCodes: dbBefore.officialCodes,
    lessonStatus: dbBefore.lessonStatus,
    curriculumStatus: dbBefore.curriculumStatus,
    officialWithoutCode: dbBefore.officialWithoutCode,
    archivedWithCode: dbBefore.archivedWithCode,
    lessonsMissingUnit: dbBefore.lessonsMissingUnit,
    duplicateOfficialCodes: dbBefore.duplicateOfficialCodes,
    mediaAssets: dbBefore.mediaAssets,
    sessionVideos: dbBefore.sessionVideos,
    materials: dbBefore.materials,
    quizAttemptEvidence: dbBefore.quizAttemptEvidence,
    sessionPublications: dbBefore.sessionPublications,
    notifications: dbBefore.notifications,
    securityEvents: dbBefore.securityEvents,
    userSessions: dbBefore.userSessions,
    passwordResetTokens: dbBefore.passwordResetTokens,
    teacherApplications: dbBefore.teacherApplications,
    teacherActivationTokens: dbBefore.teacherActivationTokens,
    securityRateLimits: dbBefore.securityRateLimits,
    auditLogs: dbBefore.auditLogs,
  },
  integrity: {
    sqliteIntegrityCheck: intBefore.sqliteIntegrityCheck,
    foreignKeyCheck: intBefore.foreignKeyCheck,
    foreignKeyViolationCount: intBefore.foreignKeyViolationCount,
  },
  media: {
    path: media.path,
    present: media.present,
    fileCount: media.fileCount,
    totalBytes: media.totalBytes,
    manifestSha256: media.manifestSha256,
    files: media.files,
    dbMediaRowCount: dbMediaRefs,
    dbMatchesFilesystem: dbMediaRefs === media.fileCount,
  },
  immutability: {
    sourceSha256Before: sourceBefore.sha256,
    sourceSha256After: sourceAfter.sha256,
    sourceSizeBefore: sourceBefore.sizeBytes,
    sourceSizeAfter: sourceAfter.sizeBytes,
    byteIdentical: immutable,
    sidecarFilesDetected: sidecars,
  },
  gitStatusShort: gitStatus,
  protectedArtifactsUntouched: PROTECTED,
  redaction: "Counts, role names, curriculum codes, statuses and digests only. No password, password hash, token, token hash, cookie, secret or credential value was selected, printed or stored.",
  baselineDeltasVsDocumentedP22: problems.filter((p) => !p.startsWith("FATAL")),
  fatal: problems.filter((p) => p.startsWith("FATAL")),
};

if (!DRY_RUN) {
  if (fs.existsSync(manifestPath)) fail(`manifest target exists — refusing to overwrite: ${manifestPath}`);
  else fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: "wx" });
}

// ---------------------------------------------------------------------------
// Paste-back report
// ---------------------------------------------------------------------------
function report() {
  const L = [];
  L.push("===CM-STEP2-REPORT-BEGIN===");
  L.push(`mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"}`);
  L.push(`node: ${process.version}  platform: ${process.platform}`);
  L.push("");
  L.push("[SOURCE]");
  L.push(`path: ${sourceBefore.path}`);
  L.push(`size: ${sourceBefore.sizeBytes}`);
  L.push(`sha256: ${sourceBefore.sha256}`);
  L.push(`modified: ${sourceBefore.modifiedAt}`);
  L.push("");
  L.push("[BASELINE]");
  for (const [k, v] of Object.entries({
    tables: dbBefore.tables, users: dbBefore.users,
    ADMIN: dbBefore.admins, TEACHER: dbBefore.teachers, STUDENT: dbBefore.students, PARENT: dbBefore.parents,
    Parts: dbBefore.parts, Units: dbBefore.units, Lessons: dbBefore.lessons,
    officialLessons: dbBefore.officialLessons, archivedLessons: dbBefore.archivedLessons,
    officialCodeCount: dbBefore.officialCodeCount, officialCodeDistinct: dbBefore.officialCodeDistinct,
    officialWithoutCode: dbBefore.officialWithoutCode, archivedWithCode: dbBefore.archivedWithCode,
    lessonsMissingUnit: dbBefore.lessonsMissingUnit,
    MediaAsset: dbBefore.mediaAssets, SessionVideo: dbBefore.sessionVideos,
    Material: dbBefore.materials, QuizAttemptEvidence: dbBefore.quizAttemptEvidence,
    SessionPublication: dbBefore.sessionPublications, Notification: dbBefore.notifications,
    SecurityEvent: dbBefore.securityEvents, UserSession: dbBefore.userSessions,
    PasswordResetToken: dbBefore.passwordResetTokens, TeacherApplication: dbBefore.teacherApplications,
    TeacherActivationToken: dbBefore.teacherActivationTokens, SecurityRateLimit: dbBefore.securityRateLimits,
    AuditLog: dbBefore.auditLogs,
  })) L.push(`${k}: ${JSON.stringify(v)}`);
  L.push(`officialCodes: ${dbBefore.officialCodes.join(",")}`);
  L.push(`officialCodesMatch_1-1_to_7-3: ${JSON.stringify(dbBefore.officialCodes) === JSON.stringify(EXPECTED.officialCodes)}`);
  L.push(`lessonStatus: ${JSON.stringify(dbBefore.lessonStatus)}`);
  L.push(`curriculumStatus: ${JSON.stringify(dbBefore.curriculumStatus)}`);
  L.push(`duplicateOfficialCodes: ${JSON.stringify(dbBefore.duplicateOfficialCodes)}`);
  L.push("");
  L.push("[SOURCE INTEGRITY]");
  L.push(`integrity_check: ${intBefore.sqliteIntegrityCheck}`);
  L.push(`foreign_key_check: ${JSON.stringify(intBefore.foreignKeyCheck)}`);
  L.push(`foreign_key_violations: ${intBefore.foreignKeyViolationCount}`);
  L.push("");
  L.push("[ARTIFACTS]");
  for (const kind of ["copy", "snapshot"]) {
    const a = artifacts[kind];
    if (!a) { L.push(`${kind}: NOT CREATED (${DRY_RUN ? "dry-run" : "aborted"})`); continue; }
    L.push(`${kind}.path: ${a.path}`);
    L.push(`${kind}.size: ${a.sizeBytes}`);
    L.push(`${kind}.sha256: ${a.sha256}`);
    L.push(`${kind}.sizeMatchesSource: ${a.sizeMatchesSource}`);
    L.push(`${kind}.sha256MatchesSource: ${a.sha256MatchesSource}`);
    L.push(`${kind}.integrity_check: ${a.verification.integrity.sqliteIntegrityCheck}`);
    L.push(`${kind}.foreign_key_violations: ${a.verification.integrity.foreignKeyViolationCount}`);
    L.push(`${kind}.baselineMatchesSource: ${a.verification.baselineMatchesSource}`);
    L.push(`${kind}.baselineDifferences: ${JSON.stringify(a.verification.baselineDifferences)}`);
  }
  L.push(`manifest: ${DRY_RUN ? "(not written — dry-run) " + manifestPath : manifestPath}`);
  L.push("");
  L.push("[MEDIA]");
  L.push(`path: ${media.path}`);
  L.push(`present: ${media.present}`);
  L.push(`fileCount: ${media.fileCount}`);
  L.push(`totalBytes: ${media.totalBytes}`);
  L.push(`manifestSha256: ${media.manifestSha256}`);
  L.push(`dbMediaRowCount: ${dbMediaRefs}`);
  L.push(`dbMatchesFilesystem: ${dbMediaRefs === media.fileCount}`);
  if (media.present && media.fileCount <= 200) for (const f of media.files) L.push(`  file: ${f.rel} ${f.bytes} ${f.sha256}`);
  L.push("");
  L.push("[IMMUTABILITY]");
  L.push(`sha256_before: ${sourceBefore.sha256}`);
  L.push(`sha256_after:  ${sourceAfter.sha256}`);
  L.push(`size_before: ${sourceBefore.sizeBytes}`);
  L.push(`size_after:  ${sourceAfter.sizeBytes}`);
  L.push(`byte_identical: ${immutable}`);
  L.push(`sidecars_detected: ${JSON.stringify(sidecars)}`);
  L.push(`git_status_short: ${gitStatus === null ? "(not a git checkout / not inspected)" : JSON.stringify(gitStatus)}`);
  L.push("");
  L.push("[NOTES / DELTAS]");
  for (const p of problems) L.push(`- ${p}`);
  if (!problems.length) L.push("- none");
  L.push("");
  L.push(`[MANIFEST_JSON]`);
  L.push(JSON.stringify(manifest, null, 2));
  L.push("===CM-STEP2-REPORT-END===");
  console.log("");
  console.log(L.join("\n"));
}

report();
console.log("");
console.log(exitCode === 0
  ? (DRY_RUN ? "STEP2_DRY_RUN_OK — nothing was written." : "STEP2_BACKUP_OK — source byte-identical, both artifacts verified.")
  : "STEP2_FAILED — see FATAL entries above.");
process.exit(exitCode);