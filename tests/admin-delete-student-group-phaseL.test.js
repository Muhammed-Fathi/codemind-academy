// CodeMind Academy — Admin DELETE Student / DELETE Group (Phase L manual-QA fix).
//
// WHAT IT PROVES
//   The two destructive admin actions are SAFE: they run server-side, are
//   ADMIN-only, transactional, leave no orphans, and REFUSE — rather than
//   silently erase — the records the schema declares must survive.
//
//   STUDENT (P)
//     1. Non-admin cannot delete (403, nothing removed).
//     2. Unknown student → 404.
//     3. A student with no financial history deletes successfully.
//     4. The student disappears from GET /api/admin/students (list + counters).
//     5. No orphan User/Student identity remains; every dependent table is
//        empty of rows pointing at the deleted ids — EXCEPT SecurityEvent,
//        which is preserved and detached (schema: onDelete SetNull).
//     6. An unrelated student is untouched.
//     7. The group they belonged to is untouched.
//     8. Parent links are removed; the PARENT account itself survives.
//     9. Subscription / Enrollment are removed; a PAYMENT blocks the delete.
//    10. Quiz attempts, homework submissions, progress, attendance, absence
//        records, notes, bookmarks, tasks and session views go with them.
//    11. A repeat delete is a clean 404 (never a double-delete).
//    12. A failure inside the transaction rolls back EVERYTHING.
//
//   GROUP (Q)
//     1. Non-admin cannot delete.
//     2. Unknown group → 404.
//     3. An empty group is deleted successfully.
//     4. The group disappears from GET /api/admin/groups.
//     5. The Course survives; the curriculum is untouched.
//     6. The Teacher survives (and is not detached).
//     7. Students are NEVER deleted — a populated group is REFUSED (409).
//     8. A group with sessions / absence cases is REFUSED (409).
//     9. No orphan rows after a successful delete.
//    10. An unrelated group is untouched.
//
// The REAL route modules are compiled with the repo's own tsc and executed
// against a REAL SQLite database (the repo's own migration harness, with
// `PRAGMA foreign_keys=ON`), so the assertions exercise the shipped handlers,
// the shipped schema and real transaction rollback semantics.
//
// Portable: no shell of any kind — runs unchanged on Windows and Linux CI.
//
// Run: node tests/admin-delete-student-group-phaseL.test.js

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { pathToFileURL } = require("url");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-delete-"));

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(actual, expected, msg) {
  ok(
    actual === expected,
    msg,
    actual === expected ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
  );
}
function section(t) {
  console.log(`\n${t}`);
}

(async () => {
  // -------------------------------------------------------------------------
  // 1. Compile the REAL routes with the repo's own tsc
  // -------------------------------------------------------------------------
  const ROUTES = [
    "src/app/api/admin/students/route.ts",
    "src/app/api/admin/students/[id]/route.ts",
    "src/app/api/admin/groups/route.ts",
    "src/app/api/admin/groups/[id]/route.ts",
  ];
  fs.writeFileSync(
    path.join(OUT, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2020", module: "commonjs", strict: false, skipLibCheck: true,
        esModuleInterop: true, resolveJsonModule: true, types: ["node"],
        baseUrl: REPO, paths: { "@/*": ["src/*"] },
        typeRoots: [path.join(REPO, "node_modules/@types")],
        rootDir: REPO, outDir: OUT, noEmitOnError: false,
      },
      // i18n-core is compiled explicitly: the refusal/dialog copy the admin
      // actually reads is verified from the REAL dictionary, not a re-parse.
      files: [...ROUTES.map((r) => path.join(REPO, r)), path.join(REPO, "src/lib/i18n-core.ts")],
    })
  );
  const TSC_BIN = path.join(REPO, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(TSC_BIN)) {
    console.error("typescript is not installed — run npm install");
    process.exit(1);
  }
  spawnSync(process.execPath, [TSC_BIN, "-p", path.join(OUT, "tsconfig.json")], { cwd: REPO, encoding: "utf8" });
  const EMIT = path.join(OUT, "src");
  const STUDENT_JS = path.join(EMIT, "app/api/admin/students/[id]/route.js");
  const STUDENTS_JS = path.join(EMIT, "app/api/admin/students/route.js");
  const GROUPS_JS = path.join(EMIT, "app/api/admin/groups/route.js");
  const GROUP_JS = path.join(EMIT, "app/api/admin/groups/[id]/route.js");
  for (const f of [STUDENT_JS, STUDENTS_JS, GROUPS_JS, GROUP_JS]) {
    if (!fs.existsSync(f)) {
      console.error(`tsc did not emit ${f}`);
      process.exit(1);
    }
  }

  // -------------------------------------------------------------------------
  // 2. The REAL database + the real handlers
  // -------------------------------------------------------------------------
  const { DatabaseSync } = require("node:sqlite");
  const { applyMigrations } = await import(pathToFileURL(path.join(REPO, "scripts/lib/migrate-sqlite.mjs")).href);
  const { createSqlitePrisma } = await import(pathToFileURL(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs")).href);

  global.__CM_DB__ = null;
  const shim = path.join(OUT, "__db-shim__.js");
  fs.writeFileSync(shim, "module.exports = { get db() { return global.__CM_DB__; } };");
  const apiStub = path.join(OUT, "__api__.js");
  fs.writeFileSync(
    apiStub,
    "module.exports = { ok:(d,s)=>({status:s||200,body:d}), err:(e,s)=>({status:s||400,body:{error:e}}), requireRole: async()=>global.__ROLE__() };"
  );
  const i18nStub = path.join(OUT, "__i18n__.js");
  fs.writeFileSync(i18nStub, "module.exports = { getServerT: async () => (k) => k };");
  const nextStub = path.join(OUT, "__next__.js");
  fs.writeFileSync(nextStub, "module.exports = { NextRequest: class {} };");
  const authStub = path.join(OUT, "__auth__.js");
  fs.writeFileSync(authStub, "module.exports = { hashPassword:(p)=>'h', revokeAllSessions: async()=>{} };");
  const secStub = path.join(OUT, "__sec__.js");
  fs.writeFileSync(secStub, "module.exports = { logSecurityEvent: async()=>{} };");

  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "@/lib/db") return shim;
    if (request === "@/lib/api") return apiStub;
    if (request === "@/lib/i18n-server") return i18nStub;
    if (request === "@/lib/auth") return authStub;
    if (request === "@/lib/security") return secStub;
    if (request === "next/server") return nextStub;
    const alias = /^@\/lib\/([\w/-]+)$/.exec(request);
    if (alias) {
      const compiled = path.join(EMIT, "lib", `${alias[1]}.js`);
      if (fs.existsSync(compiled)) return compiled;
    }
    return origResolve.call(this, request, ...rest);
  };

  const quiet = (fn) => {
    const orig = console.log;
    console.log = () => {};
    try {
      return fn();
    } finally {
      console.log = orig;
    }
  };

  let scenario = 0;
  function freshDb() {
    scenario++;
    const file = path.join(OUT, `db-${scenario}.db`);
    const d = new DatabaseSync(file);
    quiet(() => applyMigrations(d, { withBaseSchema: true, label: "" }));
    global.__CM_DB__ = createSqlitePrisma({ db: d, schemaPath: path.join(REPO, "prisma/schema.prisma") });
    global.__CM_DB__.__raw = d;
    if (process.env.CM_DEBUG_DELETE === "1") {
      const inner = global.__CM_DB__.$transaction;
      global.__CM_DB__.$transaction = async (arg) => {
        try {
          return await inner(arg);
        } catch (e) {
          console.error("  [debug] transaction error:", e && e.message ? e.message : e);
          throw e;
        }
      };
    }
    return d;
  }

  global.__ROLE__ = () => ({ user: { id: "admin-1", role: "ADMIN" }, error: null });
  const studentRoute = require(STUDENT_JS);
  const studentsRoute = require(STUDENTS_JS);
  const groupsRoute = require(GROUPS_JS);
  const groupRoute = require(GROUP_JS);

  const params = (id) => ({ params: Promise.resolve({ id }) });
  const getReq = (url) => ({ url: url || "http://localhost/api/admin/students", json: async () => ({}) });
  const bareReq = () => ({ json: async () => ({}) });

  const NOW = Date.now();
  function ins(d, table, values) {
    const cols = Object.keys(values);
    d.prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`
    ).run(...cols.map((c) => values[c]));
  }
  const count = (d, table, where, ...args) =>
    d.prepare(`SELECT COUNT(*) c FROM "${table}"${where ? ` WHERE ${where}` : ""}`).get(...args).c;

  /**
   * One student (s1) with a full academic history, one unrelated bystander
   * (s2), two groups (g1 = s1's group, g2 = a group with a live session) and
   * a third group that only owns an absence case (g3).
   */
  function seed(d) {
    // --- curriculum -------------------------------------------------------
    ins(d, "Track", { id: "tr1", code: "ARABIC", name: "Arabic", nameAr: "عربي", isActive: 1, createdAt: NOW, updatedAt: NOW });
    ins(d, "Course", { id: "c1", slug: "programming-ai-1st-sec", academicLevel: "FIRST_SECONDARY", name: "P&AI", nameAr: "البرمجة", description: "d", color: "#000000", createdAt: NOW, updatedAt: NOW });
    ins(d, "Part", { id: "p1", courseId: "c1", title: "Part", titleAr: "جزء", order: 1 });
    ins(d, "Unit", { id: "u1", partId: "p1", title: "Unit", titleAr: "وحدة", order: 1 });
    ins(d, "Lesson", { id: "l1", unitId: "u1", title: "Lesson", titleAr: "درس", order: 1, academicLevel: "FIRST_SECONDARY", trackScope: "SHARED", status: "PUBLISHED", createdAt: NOW, updatedAt: NOW });
    ins(d, "Quiz", { id: "qz1", lessonId: "l1", trackScope: "SHARED", title: "Quiz", titleAr: "اختبار" });
    ins(d, "Homework", { id: "hw1", lessonId: "l1", trackScope: "SHARED", title: "HW", titleAr: "واجب", deadline: NOW });
    ins(d, "Batch", { id: "b1", name: "Batch", nameAr: "دفعة", schoolType: "LANGUAGE", courseId: "c1", isActive: 1, createdAt: NOW, updatedAt: NOW });
    ins(d, "MediaAsset", { id: "ma1", kind: "VIDEO", storage: "EXTERNAL_URL", externalUrl: "https://example.test/v.mp4" });
    ins(d, "SessionVideo", { id: "sv1", batchId: "b1", lessonId: "l1", mediaAssetId: "ma1", title: "Video", titleAr: "فيديو" });

    // --- people -----------------------------------------------------------
    // The acting admin is a REAL row: QuizRetryGrant.grantedByUserId carries an
    // FK to User (onDelete Cascade), and the post-commit audit entry is written
    // against this account — so it must survive the student's deletion.
    ins(d, "User", { id: "admin-1", name: "Admin", email: "admin@x.test", password: "h", role: "ADMIN", createdAt: NOW, updatedAt: NOW });
    ins(d, "User", { id: "tuser", name: "Teacher", email: "t@x.test", password: "h", role: "TEACHER", createdAt: NOW, updatedAt: NOW });
    ins(d, "Teacher", { id: "t1", userId: "tuser", specialty: "CS", createdAt: NOW, updatedAt: NOW });
    ins(d, "Group", { id: "g1", name: "FS Language", courseId: "c1", teacherId: "t1", capacity: 20, schedule: "Sat", isActive: 1, trackScope: "LANGUAGE", createdAt: NOW, updatedAt: NOW });
    ins(d, "Group", { id: "g2", name: "FS Arabic (has a session)", courseId: "c1", capacity: 20, schedule: "Sat", isActive: 1, trackScope: "ARABIC", createdAt: NOW, updatedAt: NOW });
    ins(d, "Group", { id: "g3", name: "Absence only", courseId: "c1", capacity: 20, schedule: "Sat", isActive: 1, trackScope: "ARABIC", createdAt: NOW, updatedAt: NOW });

    // --- the student to delete (with a real, FK-valid history) -------------
    ins(d, "User", { id: "u1", name: "Omar Ahmed", email: "omar@x.test", password: "h", role: "STUDENT", createdAt: NOW, updatedAt: NOW });
    ins(d, "Student", { id: "s1", userId: "u1", grade: "1st Secondary", academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE", groupId: "g1", studentCode: "CM-AAA111", enrolledAt: NOW, createdAt: NOW, updatedAt: NOW });
    ins(d, "Parent", { id: "par1", userId: "puser", createdAt: NOW, updatedAt: NOW });
    ins(d, "User", { id: "puser", name: "Parent", email: "p@x.test", password: "h", role: "PARENT", createdAt: NOW, updatedAt: NOW });
    ins(d, "ParentStudentLink", { id: "psl1", parentId: "par1", studentId: "s1", relation: "parent", createdAt: NOW });
    ins(d, "SubscriptionPlan", { id: "plan1", name: "Plan", nameAr: "خطة", durationMonths: 1, price: 100, createdAt: NOW });
    ins(d, "Subscription", { id: "sub1", studentId: "s1", planId: "plan1", status: "ACTIVE", createdAt: NOW, updatedAt: NOW });
    ins(d, "Enrollment", { id: "en1", studentId: "s1", courseId: "c1", trackId: "tr1", status: "ACTIVE", startsAt: NOW, createdAt: NOW });
    ins(d, "LiveSession", { id: "sess1", groupId: "g2", title: "S", titleAr: "جلسة", startAt: NOW, duration: 60, status: "SCHEDULED", createdAt: NOW });
    ins(d, "Attendance", { id: "att1", studentId: "s1", sessionId: "sess1", status: "PRESENT", createdAt: NOW });
    ins(d, "AttendanceCorrection", { id: "ac1", attendanceId: "att1", sessionId: "sess1", studentId: "s1", previousStatus: "ABSENT", newStatus: "PRESENT", reason: "r", correctedByUserId: "tuser", correctedAt: NOW });
    ins(d, "TeacherNote", { id: "tn1", teacherId: "t1", studentId: "s1", note: "n", createdAt: NOW });
    ins(d, "QuizAttempt", { id: "qa1", studentId: "s1", quizId: "qz1", score: 8, totalMarks: 10, percentage: 80, passed: 1, startedAt: NOW });
    ins(d, "QuizRetryGrant", { id: "qrg1", studentId: "s1", quizId: "qz1", grantedByUserId: "admin-1", grantedAt: NOW });
    ins(d, "HomeworkSubmission", { id: "hs1", studentId: "s1", homeworkId: "hw1", status: "GRADED" });
    ins(d, "LessonProgress", { id: "lp1", studentId: "s1", lessonId: "l1", progress: 100, isCompleted: 1 });
    ins(d, "LessonBookmark", { id: "lb1", studentId: "s1", lessonId: "l1", createdAt: NOW });
    ins(d, "LessonNote", { id: "ln1", studentId: "s1", lessonId: "l1", content: "c", createdAt: NOW, updatedAt: NOW });
    ins(d, "ExamAttempt", { id: "ea1", studentId: "s1", examType: "MOCK", questionCount: 10, durationMin: 30, score: 5, totalMarks: 10, percentage: 50, passed: 0, answers: "[]", startedAt: NOW });
    ins(d, "StudyTask", { id: "st1", studentId: "s1", title: "t", scheduledDate: NOW, durationMin: 30, status: "PENDING", createdAt: NOW, updatedAt: NOW });
    ins(d, "SessionVideoView", { id: "svv1", sessionVideoId: "sv1", studentId: "s1" });
    ins(d, "Notification", { id: "n1", userId: "u1", type: "INFO", title: "t", message: "m", createdAt: NOW });
    ins(d, "UserSession", { id: "us1", userId: "u1", tokenHash: "th", deviceHash: "dh", lastSeenAt: NOW, expiresAt: NOW + 1000 });
    ins(d, "PasswordResetToken", { id: "prt1", userId: "u1", tokenHash: "th", expiresAt: NOW + 1000 });
    ins(d, "SecurityEvent", { id: "se1", userId: "u1", type: "LOGIN", createdAt: NOW });
    ins(d, "AuditLog", { id: "al1", userId: "u1", action: "X", createdAt: NOW });
    // The absence chain: a review owned by g3, a hold on top of it. (Its own
    // session — Attendance is @@unique([studentId, sessionId]).)
    ins(d, "LiveSession", { id: "sess2", groupId: "g2", title: "S2", titleAr: "جلسة ٢", startAt: NOW, duration: 60, status: "SCHEDULED", createdAt: NOW });
    ins(d, "Attendance", { id: "att3", studentId: "s1", sessionId: "sess2", status: "ABSENT", createdAt: NOW });
    ins(d, "AbsenceReview", { id: "ar1", attendanceId: "att3", studentId: "s1", sessionId: "sess2", groupId: "g3", status: "PENDING_REASON", createdAt: NOW, updatedAt: NOW });
    ins(d, "AbsenceHold", { id: "ah1", absenceReviewId: "ar1", studentId: "s1", sessionId: "sess2", status: "ACTIVE", createdAt: NOW });

    // --- the bystander (must survive every scenario untouched) -------------
    ins(d, "User", { id: "u2", name: "Sara Mostafa", email: "sara@x.test", password: "h", role: "STUDENT", createdAt: NOW, updatedAt: NOW });
    ins(d, "Student", { id: "s2", userId: "u2", grade: "2nd Secondary", academicLevel: "SECOND_SECONDARY", schoolType: "ARABIC", studentCode: "CM-BBB222", enrolledAt: NOW, createdAt: NOW, updatedAt: NOW });
    ins(d, "LessonProgress", { id: "lp2", studentId: "s2", lessonId: "l1", progress: 10, isCompleted: 0 });
    ins(d, "QuizAttempt", { id: "qa2", studentId: "s2", quizId: "qz1", score: 5, totalMarks: 10, percentage: 50, passed: 0, startedAt: NOW });
  }

  const asAdmin = () => {
    global.__ROLE__ = () => ({ user: { id: "admin-1", role: "ADMIN" }, error: null });
  };
  const asNonAdmin = () => {
    global.__ROLE__ = () => ({ user: null, error: { status: 403, body: { error: "Forbidden" } } });
  };

  // =========================================================================
  section("A. Static contract — every delete step names a REAL schema field");
  // =========================================================================
  // The E2E sections below run the route against a REAL database. This cheap
  // gate catches the one class of bug a database would otherwise report as an
  // opaque transaction failure: a delete step naming a field that does not
  // exist on the model (which in production would abort EVERY delete with
  // api.380 — it must never be possible to ship that).
  {
    const schemaSrc = fs.readFileSync(path.join(REPO, "prisma/schema.prisma"), "utf8");
    const models = new Map();
    let cur = null;
    for (const line of schemaSrc.split(/\r?\n/)) {
      const open = /^model\s+(\w+)\s*\{/.exec(line);
      if (open) {
        cur = open[1];
        models.set(cur, new Set());
        continue;
      }
      if (/^\}/.test(line)) {
        cur = null;
        continue;
      }
      if (cur) {
        const f = /^\s*(\w+)\s+\S/.exec(line);
        if (f) models.get(cur).add(f[1]);
      }
    }
    const routeSrc = fs.readFileSync(path.join(REPO, "src/app/api/admin/students/[id]/route.ts"), "utf8");
    const listBody = routeSrc.slice(routeSrc.indexOf("STUDENT_DELETE_DEPENDENTS"));
    const pairs = [...listBody.matchAll(/\{\s*model:\s*"(\w+)",\s*field:\s*"(\w+)"/g)].map((m) => [m[1], m[2]]);
    ok(pairs.length >= 25, "A: the delete-step list is present and non-trivial", `found ${pairs.length}`);
    const bad = pairs.filter(([model, field]) => {
      const M = model.charAt(0).toUpperCase() + model.slice(1);
      return !models.has(M) || !models.get(M).has(field);
    });
    ok(bad.length === 0, "A: every delete step names an existing model field", bad.map((b) => `${b[0]}.${b[1]}`).join(", "));

    // The explicit detach steps must name real columns too.
    const detaches = [
      ["Payment", "subscriptionId"],
      ["Payment", "userId"],
      ["SecurityEvent", "userId"],
      ["TeacherApplication", "userId"],
      ["CouponRedemption", "userId"],
    ];
    const badDetach = detaches.filter(([M, f]) => !models.has(M) || !models.get(M).has(f));
    ok(badDetach.length === 0, "A: every detach/refusal step names an existing column", badDetach.map((b) => `${b[0]}.${b[1]}`).join(", "));

    // The student's identity fields the contract relies on.
    const studentFields = ["id", "userId", "studentCode", "academicLevel", "groupId"];
    const badStudent = studentFields.filter((f) => !models.get("Student").has(f));
    ok(badStudent.length === 0, "A: Student still carries the identity fields the delete reads", badStudent.join(", "));
  }

  // =========================================================================
  section("P1–P2. STUDENT — authz + not found");
  // =========================================================================
  {
    const d = freshDb();
    seed(d);
    asNonAdmin();
    const denied = await studentRoute.DELETE(bareReq(), params("s1"));
    eq(denied.status, 403, "P1: a non-admin cannot delete a student");
    eq(count(d, "Student", "id='s1'"), 1, "P1: nothing was removed");
    eq(count(d, "User", "id='u1'"), 1, "P1: the login survives too");

    asAdmin();
    const missing = await studentRoute.DELETE(bareReq(), params("does-not-exist"));
    eq(missing.status, 404, "P2: an unknown student returns 404");
  }

  // =========================================================================
  section("P3–P11. STUDENT — the delete contract");
  // =========================================================================
  {
    const d = freshDb();
    seed(d);

    // P9 — a PAYMENT blocks the delete (financial history is preserved).
    ins(d, "Payment", { id: "pay1", userId: "u1", amount: 100, method: "CASH", status: "APPROVED", createdAt: NOW, updatedAt: NOW });
    const blocked = await studentRoute.DELETE(bareReq(), params("s1"));
    eq(blocked.status, 409, "P9: a student with a payment is REFUSED (409)");
    eq(blocked.body.error, "api.379", "P9: the refusal is the financial-history contract");
    eq(count(d, "Student", "id='s1'"), 1, "P9: the student survives the refusal");
    eq(count(d, "Payment", "id='pay1'"), 1, "P9: the payment is preserved");
    eq(count(d, "User", "id='u1'"), 1, "P9: the login survives the refusal");
    eq(count(d, "LessonProgress", "studentId='s1'"), 1, "P9: nothing else was touched either");
    d.prepare(`DELETE FROM "Payment" WHERE id='pay1'`).run();

    // P3 — now the delete succeeds.
    const res = await studentRoute.DELETE(bareReq(), params("s1"));
    eq(res.status, 200, "P3: a student with no financial history deletes successfully");
    eq(res.body.deleted, true, "P3: the response reports the deletion");

    // P5 — no orphan identity rows.
    eq(count(d, "Student", "id='s1'"), 0, "P5: the Student row is gone");
    eq(count(d, "User", "id='u1'"), 0, "P5: the User row is gone");

    // P10 / P8 / P9 — every dependent table is clean of the deleted ids.
    const dependents = [
      ["ParentStudentLink", "studentId='s1'"],
      ["Enrollment", "studentId='s1'"],
      ["Attendance", "studentId='s1'"],
      ["AttendanceCorrection", "studentId='s1'"],
      ["AbsenceHold", "studentId='s1'"],
      ["AbsenceReview", "studentId='s1'"],
      ["TeacherNote", "studentId='s1'"],
      ["QuizAttempt", "studentId='s1'"],
      ["QuizRetryGrant", "studentId='s1'"],
      ["HomeworkSubmission", "studentId='s1'"],
      ["LessonProgress", "studentId='s1'"],
      ["LessonBookmark", "studentId='s1'"],
      ["LessonNote", "studentId='s1'"],
      ["ExamAttempt", "studentId='s1'"],
      ["StudyTask", "studentId='s1'"],
      ["SessionVideoView", "studentId='s1'"],
      ["Subscription", "studentId='s1'"],
      ["Notification", "userId='u1'"],
      ["UserSession", "userId='u1'"],
      ["PasswordResetToken", "userId='u1'"],
      ["AuditLog", "userId='u1'"],
    ];
    const orphans = dependents.filter(([t, w]) => count(d, t, w) !== 0);
    ok(
      orphans.length === 0,
      "P5/P10: no dependent row survives the deleted student",
      orphans.map((o) => o[0]).join(", ")
    );
    eq(count(d, "ParentStudentLink", "id='psl1'"), 0, "P8: the parent link is removed (it cannot outlive the student)");
    eq(count(d, "Parent", "id='par1'"), 1, "P8: the PARENT account itself is untouched");
    eq(count(d, "User", "id='puser'"), 1, "P8: …and can still sign in");

    // PRESERVED — SecurityEvent is detached, never deleted (onDelete: SetNull).
    eq(count(d, "SecurityEvent", "id='se1'"), 1, "P5: the security event is PRESERVED");
    eq(count(d, "SecurityEvent", "id='se1' AND userId IS NULL"), 1, "P5: …and detached from the deleted account");

    // The records the student never owned are untouched.
    eq(count(d, "Quiz", "id='qz1'"), 1, "P10: the quiz itself survives");
    eq(count(d, "Homework", "id='hw1'"), 1, "P10: the homework itself survives");
    eq(count(d, "SessionVideo", "id='sv1'"), 1, "P10: the session video itself survives");

    // P6 — the bystander is untouched.
    eq(count(d, "Student", "id='s2'"), 1, "P6: the unrelated student survives");
    eq(count(d, "User", "id='u2'"), 1, "P6: …with their account");
    eq(count(d, "LessonProgress", "studentId='s2'"), 1, "P6: …and their progress");
    eq(count(d, "QuizAttempt", "studentId='s2'"), 1, "P6: …and their attempts");

    // P7 — the group is NOT touched (s1 was its only member).
    eq(count(d, "Group", "id='g1'"), 1, "P7: the group survives");
    eq(count(d, "Group", "id='g1' AND trackScope='LANGUAGE'"), 1, "P7: …unchanged (audience intact)");

    // P4 — the list (and its counters) no longer contain the student.
    asAdmin();
    const list = await studentsRoute.GET(getReq("http://localhost/api/admin/students?schoolType=LANGUAGE&pageSize=50"));
    eq(list.body.students.length, 0, "P4: the student disappears from the Language tab");
    eq(list.body.counts.LANGUAGE, 0, "P4: the Language counter refreshes to 0");
    eq(list.body.counts.ARABIC, 1, "P4: …while the unrelated Arabic student is still counted");
    eq(list.body.pagination.total, 0, "P4: the pagination total refreshes");

    // P11 — a repeat delete is a clean not-found.
    const again = await studentRoute.DELETE(bareReq(), params("s1"));
    eq(again.status, 404, "P11: a repeat delete returns 404 (never a double-delete)");

    // The audit trail records the deletion against the ADMIN, so it survives.
    eq(count(d, "AuditLog", "action='STUDENT_DELETED' AND userId='admin-1'"), 1, "the deletion is audited on the admin's own account");
  }

  // =========================================================================
  section("P12. STUDENT — a failure rolls the whole thing back");
  // =========================================================================
  {
    const d = freshDb();
    seed(d);
    // A trigger that refuses the final Student delete: the transaction must
    // roll back EVERY explicit removal performed before it.
    d.exec(
      `CREATE TRIGGER block_student_delete BEFORE DELETE ON "Student" ` +
        `WHEN OLD.id = 's1' BEGIN SELECT RAISE(ABORT, 'rollback proof'); END;`
    );
    asAdmin();
    const res = await studentRoute.DELETE(bareReq(), params("s1"));
    eq(res.status, 409, "P12: the failure surfaces as a 409, never a partial success");
    eq(res.body.error, "api.380", "P12: the failure uses the deletion-failure contract");
    eq(count(d, "Student", "id='s1'"), 1, "P12: the Student row survives");
    eq(count(d, "User", "id='u1'"), 1, "P12: the User row survives");
    eq(count(d, "ParentStudentLink", "studentId='s1'"), 1, "P12: the parent link was restored by the rollback");
    eq(count(d, "LessonProgress", "studentId='s1'"), 1, "P12: progress was restored by the rollback");
    eq(count(d, "QuizAttempt", "studentId='s1'"), 1, "P12: attempts were restored by the rollback");
    eq(count(d, "Subscription", "studentId='s1'"), 1, "P12: the subscription was restored by the rollback");
    eq(count(d, "Enrollment", "studentId='s1'"), 1, "P12: the enrollment was restored by the rollback");
    eq(count(d, "AbsenceReview", "studentId='s1'"), 1, "P12: the absence review was restored by the rollback");
    eq(count(d, "AbsenceHold", "studentId='s1'"), 1, "P12: the absence hold was restored by the rollback");
    eq(count(d, "Notification", "userId='u1'"), 1, "P12: notifications were restored by the rollback");
    eq(count(d, "AuditLog", "action='STUDENT_DELETED'"), 0, "P12: no success audit entry was written");
    // …and a retry after the blocker is gone still works (rollback left a
    // consistent record: no half-deleted rows to trip over).
    d.exec(`DROP TRIGGER block_student_delete;`);
    const retry = await studentRoute.DELETE(bareReq(), params("s1"));
    eq(retry.status, 200, "P12: once the blocker is gone the delete still succeeds");
    eq(count(d, "Student", "id='s1'"), 0, "P12: …and leaves no Student row behind");
  }

  // =========================================================================
  section("Q1–Q10. GROUP — the delete contract");
  // =========================================================================
  {
    const d = freshDb();
    seed(d);

    asNonAdmin();
    const denied = await groupRoute.DELETE(bareReq(), params("g1"));
    eq(denied.status, 403, "Q1: a non-admin cannot delete a group");
    eq(count(d, "Group", "id='g1'"), 1, "Q1: the group survives");

    asAdmin();
    const missing = await groupRoute.DELETE(bareReq(), params("nope"));
    eq(missing.status, 404, "Q2: an unknown group returns 404");

    // Q7 — a populated group is refused and its students are NEVER deleted.
    const populated = await groupRoute.DELETE(bareReq(), params("g1"));
    eq(populated.status, 409, "Q7: a group with students is REFUSED (409)");
    eq(populated.body.error, "api.294", "Q7: …with the student-history contract");
    eq(count(d, "Student", "id='s1'"), 1, "Q7: the student was NOT deleted");
    eq(count(d, "Student", "groupId='g1'"), 1, "Q7: …and is still in the group");

    // Q8 — a group with sessions is refused.
    const withSessions = await groupRoute.DELETE(bareReq(), params("g2"));
    eq(withSessions.status, 409, "Q8: a group with sessions is REFUSED (409)");
    eq(withSessions.body.error, "api.295", "Q8: …with the session-history contract");
    eq(count(d, "LiveSession", "id='sess1'"), 1, "Q8: the session history is intact");

    // Q8b — a group referenced only by absence cases is ALSO refused (the
    // third dependent class: AbsenceReview.groupId is onDelete Cascade).
    const withAbsence = await groupRoute.DELETE(bareReq(), params("g3"));
    eq(withAbsence.status, 409, "Q8b: a group with recorded absence cases is REFUSED (409)");
    eq(withAbsence.body.error, "api.381", "Q8b: …with an explicit reason");
    eq(count(d, "AbsenceReview", "id='ar1'"), 1, "Q8b: the absence case is NOT silently cascade-deleted");

    // Q3/Q4/Q5/Q6/Q9/Q10 — an empty group deletes cleanly.
    ins(d, "Group", { id: "g4", name: "Empty group", courseId: "c1", teacherId: "t1", capacity: 20, schedule: "Sat", isActive: 1, trackScope: "ARABIC", createdAt: NOW, updatedAt: NOW });
    const okRes = await groupRoute.DELETE(bareReq(), params("g4"));
    eq(okRes.status, 200, "Q3: an empty group deletes successfully");
    eq(count(d, "Group", "id='g4'"), 0, "Q4: the group is gone");

    const groupList = await groupsRoute.GET();
    const ids = (groupList.body.groups || []).map((g) => g.id);
    ok(!ids.includes("g4"), "Q4: the deleted group disappears from the groups list");
    ok(ids.includes("g1"), "Q10: the unrelated group is still listed");

    eq(count(d, "Course", "id='c1'"), 1, "Q5: the course survives");
    eq(count(d, "Part", "courseId='c1'"), 1, "Q5: the curriculum survives");
    eq(count(d, "Unit", "partId='p1'"), 1, "Q5: …including the unit");
    eq(count(d, "Lesson", "unitId='u1'"), 1, "Q5: …and the lesson");
    eq(count(d, "Teacher", "id='t1'"), 1, "Q6: the teacher survives");
    eq(count(d, "User", "id='tuser'"), 1, "Q6: …with their account");
    eq(count(d, "Student", "id='s1'"), 1, "Q9: no student was harmed");
    eq(count(d, "Student", "id='s2'"), 1, "Q9: …including the unrelated one");
    eq(count(d, "Student", "groupId='g1'"), 1, "Q9: …and both keep their group membership");
    eq(count(d, "AuditLog", "action='GROUP_DELETED' AND entityId='g4'"), 1, "Q: the deletion is audited");
  }

  // =========================================================================
  section("M. i18n — the copy the admin actually reads");
  // =========================================================================
  {
    const i18n = require(path.join(EMIT, "lib", "i18n-core.js"));
    const label = (key) => ({ ar: i18n.translate("ar", key), en: i18n.translate("en", key) });
    const real = (key) => {
      const l = label(key);
      return l.ar.length > 0 && l.en.length > 0 && !i18n.looksLikeDictKey(l.ar) && !i18n.looksLikeDictKey(l.en);
    };

    // Delete STUDENT (this fix): action, irreversible warning, success.
    for (const key of ["admin.655", "admin.656", "admin.657"]) {
      ok(real(key), `i18n: «${key}» resolves to real text in both locales`);
    }
    // Delete GROUP (reuses the existing group-lifecycle copy).
    for (const key of ["admin.509", "admin.510", "admin.517", "admin.038"]) {
      ok(real(key), `i18n: «${key}» (group delete + cancel) resolves in both locales`);
    }
    // Level vocabulary + the failure/refusal contracts.
    for (const key of ["admin.643", "admin.644", "admin.645", "admin.648", "admin.642", "teacher.312", "api.379", "api.380", "api.381"]) {
      ok(real(key), `i18n: «${key}» resolves to real text in both locales`);
    }
    eq(label("admin.643").ar, "أولى ثانوي", "i18n: الأول level label is the canonical Arabic wording");
    eq(label("admin.644").ar, "ثانية ثانوي", "i18n: …and the second level label too");
    eq(label("admin.648").ar, "كل الصفوف", "i18n: …and the All chip");

    // The confirmation dialog must NAME the student — the UI renders the name
    // from the row it was opened for.
    const dash = fs.readFileSync(path.join(REPO, "src/components/admin/admin-dashboard.tsx"), "utf8");
    const start = dash.indexOf("const [confirmDelete, setConfirmDelete]");
    // The drawer is one component: slice generously from the state declaration
    // that belongs to the STUDENT delete flow to the progression section that
    // follows its dialog.
    const end = dash.indexOf("ProgressionOverrideSection", start);
    const region = dash.slice(start, end > start ? end : start + 20000);
    ok(region.includes('tr("admin.655")') && region.includes('tr("admin.656")'),
      "i18n/UI: the student-delete region was located in the dashboard");
    ok(/deleteStudent/.test(region), "i18n/UI: the delete dialog calls the DELETE route");
    ok(/student\.name/.test(region), "i18n/UI: the dialog names the student");
    ok(/student\.email/.test(region) && /studentCode/.test(region), "i18n/UI: …and shows the identifying email/code");
    ok(region.includes('tr("admin.656")'), "i18n/UI: …and states that it cannot be undone");
    ok(/onUpdated\(\)/.test(region), "i18n/UI: the list/counters refresh through the shared mutation hook (no hard reload)");
  }

  // -------------------------------------------------------------------------
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(`\nadmin delete student/group (phase L): ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nHARNESS ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
