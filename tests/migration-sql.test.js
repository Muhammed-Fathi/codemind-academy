// CodeMind Academy — Migration SQL safety simulation (offline).
// Applies prisma/migrations/20260904090608_add_student_identity_fields/migration.sql
// to a SCRATCH SQLite database (in the OS temp dir — never the real DB) that
// mimics the pre-migration production schema + data, then verifies:
//   1. The SQL contains zero destructive statements.
//   2. All pre-existing rows (User/Student/Setting/SubscriptionPlan) survive
//      byte-identical, including old Student columns.
//   3. The 4 new columns exist and are NULL for old rows.
//   4. Both UNIQUE indexes exist; multiple NULLs are allowed; duplicate
//      non-null codes are rejected.
//   5. The backfill UPDATE pattern touches only NULL-code rows.
//
// Requires Node >= 22.5 (built-in node:sqlite).
// Run: node tests/migration-sql.test.js
// Exit code: 0 = all pass, 1 = failure.

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "cm-mig-test-")),
  "sim-prod.db"
);
const db = new DatabaseSync(DB_PATH);

let pass = 0,
  fail = 0;
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", label);
  }
};

// ---- 1. Build OLD schema (pre-migration) + production-like data ----
db.exec(`
CREATE TABLE "User" (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, role TEXT DEFAULT 'STUDENT', isActive BOOLEAN DEFAULT true, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "Student" (id TEXT PRIMARY KEY, userId TEXT UNIQUE NOT NULL, grade TEXT DEFAULT '2nd Secondary', schoolName TEXT, groupId TEXT, enrolledAt DATETIME DEFAULT CURRENT_TIMESTAMP, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (userId) REFERENCES "User"(id) ON DELETE CASCADE);
CREATE TABLE "Setting" (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "SubscriptionPlan" (id TEXT PRIMARY KEY, name TEXT NOT NULL, nameAr TEXT NOT NULL, durationMonths INTEGER NOT NULL, price REAL NOT NULL, isPromo BOOLEAN DEFAULT false, isActive BOOLEAN DEFAULT true, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP);
INSERT INTO "User" (id,email,password,name,phone,role) VALUES
 ('u-admin','admin@codemind.academy','h1','Admin User','+201147422177','ADMIN'),
 ('u-s1','s1@x.com','h2','Ahmed Hassan','01147422177','STUDENT'),
 ('u-s2','s2@x.com','h3','Mona Ali','01234567890','STUDENT'),
 ('u-p1','p1@x.com','h4','Mr Hassan','01011112222','PARENT');
INSERT INTO "Student" (id,userId,grade,schoolName) VALUES
 ('s-1','u-s1','2nd Secondary','STEM Cairo'),
 ('s-2','u-s2','2nd Secondary',NULL);
INSERT INTO "Setting" (id,key,value) VALUES ('set1','brand_name','CodeMind Academy'),('set2','whatsapp_technical','+201147422177');
INSERT INTO "SubscriptionPlan" (id,name,nameAr,durationMonths,price) VALUES ('pl1','Monthly','شهري',1,200),('pl2','6 Months','6 شهور',6,1000);
`);

const snap = (t) =>
  JSON.stringify(db.prepare(`SELECT * FROM "${t}" ORDER BY id`).all());
const before = {
  User: snap("User"),
  Student: snap("Student"),
  Setting: snap("Setting"),
  SubscriptionPlan: snap("SubscriptionPlan"),
};

// ---- 2. Migration file must contain zero destructive keywords ----
const sql = fs.readFileSync(
  path.join(REPO, "prisma/migrations/20260904090608_add_student_identity_fields/migration.sql"),
  "utf8"
);
ok(
  !/\b(DROP|DELETE\s+FROM|TRUNCATE|UPDATE\s+")/i.test(sql.replace(/^--.*$/gm, "")),
  "migration SQL has no destructive statements"
);

// ---- 3. Apply migration statement-by-statement ----
const noComments = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
for (const stmt of noComments.split(";").map((s) => s.trim()).filter(Boolean)) {
  db.exec(stmt);
}

// ---- 4. Data preservation ----
ok(snap("User") === before.User, "users preserved");
ok(snap("Setting") === before.Setting, "settings preserved");
ok(snap("SubscriptionPlan") === before.SubscriptionPlan, "plans preserved");
const studentsOld = db
  .prepare(`SELECT id,userId,grade,schoolName FROM "Student" ORDER BY id`)
  .all();
ok(
  JSON.stringify(studentsOld) ===
    JSON.stringify(
      JSON.parse(before.Student).map(({ id, userId, grade, schoolName }) => ({
        id,
        userId,
        grade,
        schoolName,
      }))
    ),
  "old student columns untouched"
);

// ---- 5. New columns exist, NULL for old rows ----
const cols = db.prepare(`PRAGMA table_info("Student")`).all().map((c) => c.name);
for (const c of ["studentCode", "nationalId", "parentPhone", "schoolType"])
  ok(cols.includes(c), `column ${c} exists`);
const nullCount = db
  .prepare(
    `SELECT COUNT(*) v FROM "Student" WHERE studentCode IS NULL AND nationalId IS NULL AND parentPhone IS NULL AND schoolType IS NULL`
  )
  .get().v;
ok(nullCount === 2, "existing rows have NULL new fields");

// ---- 6. UNIQUE indexes exist; multiple NULLs allowed; dup non-null rejected ----
const idx = db.prepare(`PRAGMA index_list("Student")`).all();
ok(idx.some((i) => i.name === "Student_studentCode_key" && i.unique), "unique index studentCode");
ok(idx.some((i) => i.name === "Student_nationalId_key" && i.unique), "unique index nationalId");
db.prepare(`INSERT INTO "Student" (id,userId) VALUES ('s-3','u-p1')`).run();
ok(true, "extra NULL-code row allowed");
db.prepare(`UPDATE "Student" SET studentCode='CM-AAAAAA' WHERE id='s-1'`).run();
let dupRejected = false;
try {
  db.prepare(`UPDATE "Student" SET studentCode='CM-AAAAAA' WHERE id='s-2'`).run();
} catch {
  dupRejected = true;
}
ok(dupRejected, "duplicate non-null studentCode rejected");

// ---- 7. Backfill pattern only touches NULL rows ----
db.prepare(`UPDATE "Student" SET studentCode='CM-BBBBBB' WHERE studentCode IS NULL AND id='s-2'`).run();
ok(
  db.prepare(`SELECT studentCode v FROM "Student" WHERE id='s-1'`).get().v === "CM-AAAAAA",
  "non-target row untouched by backfill"
);

console.log(`\nmigration SQL simulation: ${pass} passed, ${fail} failed`);
db.close();
process.exit(fail ? 1 : 0);
