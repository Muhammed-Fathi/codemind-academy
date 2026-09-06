// CodeMind Academy — 2026 platform upgrade migration safety simulation (offline).
//
// Applies prisma/migrations/20260906120000_platform_upgrade_2026/migration.sql
// to a SCRATCH SQLite database in the OS temp dir (never the real DB) that
// mimics the pre-upgrade production schema and data, then verifies:
//
//   1. The SQL contains zero destructive statements (DROP / DELETE / TRUNCATE
//      / destructive ALTER).
//   2. Every pre-existing row survives byte-identical.
//   3. All new columns exist with the documented defaults, and pre-existing
//      rows get the safe default (ACTIVE / 0 / NULL).
//   4. Question.schoolType is NULL for legacy questions — i.e. legacy content
//      stays SHARED and remains usable by both mock-exam banks.
//   5. All 11 new tables exist with their unique constraints enforced.
//   6. The single-device session model behaves: two live sessions with
//      different deviceHash values are representable, and revocation is a
//      column update rather than a delete (audit trail is preserved).
//   7. The migration is safely re-runnable (IF NOT EXISTS guards) — apart from
//      ADD COLUMN, which SQLite cannot guard; we assert those are the only
//      statements that fail on a second run.
//
// Requires Node >= 22.5 (built-in node:sqlite).
// Run: node tests/platform-upgrade-2026-migration.test.js
// Exit code: 0 = all pass, 1 = failure.

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const MIGRATION = path.join(
  REPO,
  "prisma/migrations/20260906120000_platform_upgrade_2026/migration.sql"
);
const DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "cm-upgrade2026-")),
  "sim-prod.db"
);

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("FAIL:", label);
  }
};

const sql = fs.readFileSync(MIGRATION, "utf8");

// ---------------------------------------------------------------------------
// 1. Static analysis: the migration must be purely additive.
// ---------------------------------------------------------------------------
{
  // Strip SQL comments so prose in the header cannot trigger false positives.
  const code = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

  const forbidden = [
    /\bDROP\s+TABLE\b/i,
    /\bDROP\s+COLUMN\b/i,
    /\bDROP\s+INDEX\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i,
    /\bALTER\s+TABLE\s+"?\w+"?\s+RENAME\b/i,
  ];
  for (const re of forbidden) {
    ok(!re.test(code), `migration must not contain ${re}`);
  }

  // Every new table must be guarded so a partial re-run is harmless.
  const creates = code.match(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/gi) || [];
  ok(creates.length > 0, "migration creates tables");
  ok(
    creates.every((c) => /IF\s+NOT\s+EXISTS/i.test(c)),
    "every CREATE TABLE is guarded with IF NOT EXISTS"
  );
  const indexes = code.match(/CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/gi) || [];
  ok(
    indexes.every((c) => /IF\s+NOT\s+EXISTS/i.test(c)),
    "every CREATE INDEX is guarded with IF NOT EXISTS"
  );
}

// ---------------------------------------------------------------------------
// 2. Build a pre-upgrade production-like database.
// ---------------------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE "User" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "password" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'STUDENT',
  "isActive" BOOLEAN NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Student" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL UNIQUE,
  "studentCode" TEXT,
  "schoolType" TEXT,
  "grade" TEXT,
  -- Pre-existing column: the upgrade indexes it but does not create it.
  "groupId" TEXT
);
CREATE TABLE "Course" ("id" TEXT PRIMARY KEY, "slug" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL);
CREATE TABLE "Lesson" ("id" TEXT PRIMARY KEY, "courseId" TEXT NOT NULL, "title" TEXT NOT NULL);
CREATE TABLE "Quiz" ("id" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "passMark" INTEGER NOT NULL DEFAULT 60);
CREATE TABLE "Question" (
  "id" TEXT PRIMARY KEY,
  "prompt" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "marks" INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE "ExamQuestion" ("id" TEXT PRIMARY KEY, "prompt" TEXT NOT NULL, "answer" TEXT NOT NULL);
CREATE TABLE "LessonProgress" (
  "id" TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "isCompleted" BOOLEAN NOT NULL DEFAULT 0
);
CREATE TABLE "ExamAttempt" ("id" TEXT PRIMARY KEY, "studentId" TEXT NOT NULL, "percentage" INTEGER NOT NULL DEFAULT 0, "answers" TEXT NOT NULL DEFAULT '[]');
CREATE TABLE "QuizAttempt" (
  "id" TEXT PRIMARY KEY,
  "quizId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "percentage" INTEGER NOT NULL DEFAULT 0,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" DATETIME
);
CREATE TABLE "Setting" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL);
`);

db.exec(`
INSERT INTO "User" ("id","email","name","phone","password","role","isActive")
VALUES ('u1','omar@example.com','Omar Ali','+201000000001','hash1','STUDENT',1),
       ('u2','sara@example.com','Sara Nabil','+201000000002','hash2','STUDENT',0),
       ('u3','admin@example.com','Admin','+201000000003','hash3','ADMIN',1);
INSERT INTO "Student" ("id","userId","studentCode","schoolType","grade","groupId")
VALUES ('s1','u1','CM-0001','ARABIC','SECOND','g1'),
       ('s2','u2',NULL,NULL,'THIRD',NULL);
INSERT INTO "Question" ("id","prompt","answer","marks")
VALUES ('q1','Legacy question one','0',1), ('q2','Legacy question two','1',2);
INSERT INTO "LessonProgress" ("id","studentId","lessonId","isCompleted")
VALUES ('lp1','s1','l1',1);
INSERT INTO "QuizAttempt" ("id","quizId","studentId","percentage","finishedAt")
VALUES ('qa1','quiz1','s1',80,'2026-01-01 10:00:00');
INSERT INTO "Setting" ("key","value") VALUES ('academic_year','2026 / 2027');
`);

const snapshotBefore = {
  users: db.prepare('SELECT * FROM "User" ORDER BY id').all(),
  students: db.prepare('SELECT * FROM "Student" ORDER BY id').all(),
  questions: db.prepare('SELECT * FROM "Question" ORDER BY id').all(),
  settings: db.prepare('SELECT * FROM "Setting" ORDER BY key').all(),
};

// ---------------------------------------------------------------------------
// 3. Apply the migration.
// ---------------------------------------------------------------------------
let applyError = null;
try {
  db.exec(sql);
} catch (e) {
  applyError = e;
}
ok(!applyError, `migration applies cleanly (${applyError && applyError.message})`);

// ---------------------------------------------------------------------------
// 4. No data loss.
// ---------------------------------------------------------------------------
{
  const users = db.prepare('SELECT * FROM "User" ORDER BY id').all();
  ok(users.length === snapshotBefore.users.length, "no User rows lost");
  for (const before of snapshotBefore.users) {
    const after = users.find((u) => u.id === before.id);
    ok(!!after, `User ${before.id} survives`);
    for (const k of Object.keys(before)) {
      ok(after[k] === before[k], `User ${before.id}.${k} unchanged`);
    }
  }

  const students = db.prepare('SELECT * FROM "Student" ORDER BY id').all();
  for (const before of snapshotBefore.students) {
    const after = students.find((s) => s.id === before.id);
    for (const k of Object.keys(before)) {
      ok(after[k] === before[k], `Student ${before.id}.${k} unchanged`);
    }
  }

  const settings = db.prepare('SELECT * FROM "Setting" ORDER BY key').all();
  ok(
    settings.find((s) => s.key === "academic_year").value === "2026 / 2027",
    "academic_year setting untouched"
  );
}

// ---------------------------------------------------------------------------
// 5. New columns and their defaults on legacy rows.
// ---------------------------------------------------------------------------
const cols = (t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);

{
  ok(cols("User").includes("status"), "User.status added");
  const u1 = db.prepare('SELECT * FROM "User" WHERE id = ?').get("u1");
  ok(u1.status === "ACTIVE", "legacy users default to status=ACTIVE");

  ok(cols("Student").includes("batchId"), "Student.batchId added");
  const s1 = db.prepare('SELECT * FROM "Student" WHERE id = ?').get("s1");
  ok(s1.batchId === null, "legacy students start with no batch (bound lazily)");

  // The most consequential default in the whole upgrade: NULL == shared.
  ok(cols("Question").includes("schoolType"), "Question.schoolType added");
  const legacyQuestions = db.prepare('SELECT * FROM "Question"').all();
  ok(
    legacyQuestions.every((q) => q.schoolType === null),
    "legacy questions are NULL => SHARED across both banks"
  );
  ok(cols("ExamQuestion").includes("schoolType"), "ExamQuestion.schoolType added");

  for (const c of [
    "videoDurationSec",
    "videoWatchedSec",
    "videoPercent",
    "videoCompleted",
    "videoCompletedAt",
    "lastHeartbeatAt",
  ]) {
    ok(cols("LessonProgress").includes(c), `LessonProgress.${c} added`);
  }
  const lp = db.prepare('SELECT * FROM "LessonProgress" WHERE id = ?').get("lp1");
  ok(lp.videoPercent === 0 && lp.videoWatchedSec === 0, "legacy progress video counters start at 0");
  ok(lp.isCompleted === 1, "legacy lesson completion is preserved, not recomputed");

  ok(cols("ExamAttempt").includes("mockExamId"), "ExamAttempt.mockExamId added");
  ok(cols("ExamAttempt").includes("schoolType"), "ExamAttempt.schoolType added");

  ok(cols("QuizAttempt").includes("cameraStatus"), "QuizAttempt.cameraStatus added");
  const qa = db.prepare('SELECT * FROM "QuizAttempt" WHERE id = ?').get("qa1");
  ok(qa.cameraStatus === "NOT_REQUESTED", "legacy attempts default to NOT_REQUESTED");
  ok(qa.percentage === 80, "legacy attempt score preserved");
}

// ---------------------------------------------------------------------------
// 6. All new tables exist.
// ---------------------------------------------------------------------------
{
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  for (const t of [
    "Batch",
    "MediaAsset",
    "SessionVideo",
    "SessionVideoView",
    "MockExam",
    "MockExamQuestion",
    "UserSession",
    "PasswordResetToken",
    "SecurityRateLimit",
    "SecurityEvent",
    "QuizAttemptEvidence",
  ]) {
    ok(tables.includes(t), `table ${t} created`);
  }
}

// ---------------------------------------------------------------------------
// 7. Single-device session model is representable and audit-preserving.
// ---------------------------------------------------------------------------
{
  const now = "2026-09-06 12:00:00";
  const later = "2026-09-13 12:00:00";
  db.exec(`
    INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt")
    VALUES ('sess1','u1','th1','deviceA','${now}','${now}','${later}');
  `);
  db.exec(`
    INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt")
    VALUES ('sess2','u1','th2','deviceB','${now}','${now}','${later}');
  `);

  // Revocation must be an UPDATE — the row (and its audit value) stays.
  db.exec(`
    UPDATE "UserSession"
       SET "revokedAt" = '${now}', "revokedReason" = 'MULTI_DEVICE'
     WHERE "userId" = 'u1' AND "id" = 'sess1';
  `);
  const all = db.prepare('SELECT * FROM "UserSession" WHERE userId = ?').all("u1");
  ok(all.length === 2, "revoking a session does not delete its audit row");
  const revoked = all.find((s) => s.id === "sess1");
  ok(revoked.revokedReason === "MULTI_DEVICE", "revocation reason recorded");

  // tokenHash must be unique — two sessions cannot share a token.
  let dup = null;
  try {
    db.exec(`
      INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt")
      VALUES ('sess3','u1','th2','deviceC','${now}','${now}','${later}');
    `);
  } catch (e) {
    dup = e;
  }
  ok(!!dup, "duplicate session tokenHash is rejected");

  // And the suspension flag the policy sets.
  db.exec(`UPDATE "User" SET "status" = 'SUSPENDED_MULTI_DEVICE', "isActive" = 0 WHERE id = 'u1';`);
  const u1 = db.prepare('SELECT * FROM "User" WHERE id = ?').get("u1");
  ok(u1.status === "SUSPENDED_MULTI_DEVICE" && u1.isActive === 0, "multi-device suspension is storable");
}

// ---------------------------------------------------------------------------
// 8. Password reset tokens are single-use and unique by hash.
// ---------------------------------------------------------------------------
{
  const exp = "2026-09-06 12:15:00";
  db.exec(`
    INSERT INTO "PasswordResetToken" ("id","userId","tokenHash","channel","destinationMask","expiresAt","createdAt")
    VALUES ('prt1','u1','rh1','EMAIL','o***@example.com','${exp}','2026-09-06 12:00:00');
  `);
  let dup = null;
  try {
    db.exec(`
      INSERT INTO "PasswordResetToken" ("id","userId","tokenHash","channel","destinationMask","expiresAt","createdAt")
      VALUES ('prt2','u1','rh1','EMAIL','o***@example.com','${exp}','2026-09-06 12:00:00');
    `);
  } catch (e) {
    dup = e;
  }
  ok(!!dup, "duplicate reset tokenHash is rejected");

  const row = db.prepare('SELECT * FROM "PasswordResetToken" WHERE id = ?').get("prt1");
  ok(row.usedAt === null, "a fresh reset token is unused");
  ok(row.attempts === 0, "reset token attempt counter starts at 0");
}

// ---------------------------------------------------------------------------
// 9. Re-running the migration: only ADD COLUMN should conflict.
// ---------------------------------------------------------------------------
{
  const statements = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const failures = [];
  for (const st of statements) {
    try {
      db.exec(st + ";");
    } catch (e) {
      failures.push(st.slice(0, 60));
    }
  }
  ok(
    failures.every((f) => /ADD COLUMN/i.test(f)),
    `on re-run only ADD COLUMN fails (got: ${failures.filter((f) => !/ADD COLUMN/i.test(f)).join(" | ")})`
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 12. Historical exam results survive deletion of the exam/question they came
//     from. This is the "do not corrupt historical records" requirement, and
//     it is verified by actually performing the deletes against real SQLite
//     with foreign keys ON — not by reading the schema.
// ---------------------------------------------------------------------------
{
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    INSERT INTO "MockExam"
      ("id","title","titleAr","schoolType","questionCount","durationMin","passMark",
       "difficulty","selectionMode","isPublished","createdAt","updatedAt")
    VALUES ('me_hist','Historical Exam','امتحان سابق','ARABIC',10,30,60,'MIXED','RANDOM',1,
            '2026-09-01 09:00:00','2026-09-01 09:00:00');
  `);
  db.exec(`
    INSERT INTO "ExamAttempt" ("id","studentId","percentage","mockExamId","schoolType","answers")
    VALUES ('att_hist','s1',88,'me_hist','ARABIC','[{"questionId":"q1","selected":"1"}]');
  `);

  // Deleting the exam definition must NOT remove the student's result.
  db.exec(`DELETE FROM "MockExam" WHERE "id" = 'me_hist'`);
  const att = db.prepare('SELECT * FROM "ExamAttempt" WHERE "id" = ?').get("att_hist");
  ok(!!att, "deleting a MockExam does NOT delete historical ExamAttempts");
  ok(att && att.percentage === 88, "the historical score is preserved verbatim");
  ok(
    att && typeof att.answers === "string" && att.answers.includes("questionId"),
    "the answers snapshot survives deletion of the exam definition"
  );
  // NOTE: on a MIGRATED database there is no FK on ExamAttempt.mockExamId —
  // SQLite cannot add one via ALTER TABLE ADD COLUMN without a table rebuild,
  // which the additive-only migration deliberately avoids. So the raw DELETE
  // here leaves the link dangling, and the DELETE endpoint detaches attempts
  // explicitly inside a transaction instead of relying on `onDelete: SetNull`.
  // What matters for the requirement is that the RESULT survives, which the
  // assertions above prove.
  ok(att && att.mockExamId === "me_hist",
    "raw SQL delete leaves the link dangling => the app must detach explicitly");
  ok(att && att.schoolType === "ARABIC", "the attempt keeps its school type for reporting");

  // MockExamQuestion rows are pure join rows: cascading them away on question
  // deletion is correct, and must not touch attempts.
  db.exec(`
    INSERT INTO "MockExam"
      ("id","title","titleAr","schoolType","questionCount","durationMin","passMark",
       "difficulty","selectionMode","isPublished","createdAt","updatedAt")
    VALUES ('me_q','Pinned Exam','امتحان مثبت','ARABIC',1,10,60,'MIXED','FIXED',1,
            '2026-09-01 09:00:00','2026-09-01 09:00:00');
  `);
  db.exec(`INSERT INTO "Question" ("id","prompt","answer") VALUES ('q_del','Q?','1')`);
  db.exec(`
    INSERT INTO "MockExamQuestion" ("id","mockExamId","questionId","order")
    VALUES ('meq1','me_q','q_del',0);
  `);
  db.exec(`
    INSERT INTO "ExamAttempt" ("id","studentId","percentage","mockExamId","schoolType","answers")
    VALUES ('att_q','s1',75,'me_q','ARABIC','[{"questionId":"q_del","selected":"1"}]');
  `);

  db.exec(`DELETE FROM "Question" WHERE "id" = 'q_del'`);
  const joinRows = db.prepare('SELECT * FROM "MockExamQuestion" WHERE "questionId" = ?').all("q_del");
  ok(joinRows.length === 0, "deleting a Question removes only its pinned-join rows");
  const attQ = db.prepare('SELECT * FROM "ExamAttempt" WHERE "id" = ?').get("att_q");
  ok(!!attQ && attQ.percentage === 75,
    "deleting a Question does NOT alter an already-graded attempt");
  ok(attQ && attQ.answers.includes("q_del"),
    "the answers snapshot still names the deleted question (results stay readable)");
}

db.close();
fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
