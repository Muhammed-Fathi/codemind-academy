// CodeMind Academy — Admin DELETE Student / DELETE Group (Phase L manual-QA fix).
//
// WHAT IT PROVES
//   The two destructive admin actions are SAFE: they run server-side, are
//   ADMIN-only, transactional, leave no orphans, and REFUSE — rather than
//   silently erase — the records the schema declares must survive.
//
//   STUDENT (P) — FIX #4 CORRECTION: the contract FAILS CLOSED
//     A hard delete is allowed ONLY for a genuinely clean identity. Having no
//     Payment row is NOT sufficient: academic history is as durable as
//     financial history, and the platform never erases it as a side effect of
//     removing a login.
//       A.  The deletion matrix is COMPLETE: every identity-carrying column in
//           the schema is classified exactly once (protected / safe /
//           detached), proven by re-deriving the list from `schema.prisma`.
//           No pair may appear in two lists; no archive/soft-delete column was
//           introduced; the machine-readable refusal code is pinned.
//       P1. A non-admin cannot delete (403, nothing removed).
//       P2. An unknown student → 404.
//       P-A. A student with NO protected row of any kind deletes successfully,
//            and the delete leaves no orphan identity row behind. SecurityEvent
//            is preserved and DETACHED (schema: SetNull), never deleted.
//       P-B. EVERY protected class refuses the request with 409 +
//            `STUDENT_HAS_PROTECTED_HISTORY` + the per-category breakdown — and
//            the refusal changes NOTHING: a full table-by-table snapshot is
//            byte-identical before and after (no partial delete), while the
//            Student, User, unrelated student and group all survive.
//            Covered classes: Payment, CouponRedemption, Subscription,
//            Enrollment, Attendance, AttendanceCorrection, AbsenceReview,
//            AbsenceHold, QuizAttempt, QuizRetryGrant (both as the taker and as
//            the GRANTER), HomeworkSubmission, ExamAttempt, LessonProgress,
//            ProgressionOverride, SessionVideoView, TeacherNote, LessonNote,
//            LessonBookmark, StudyTask, StudentBadge, Referral, Notification,
//            AuditLog.
//       P-I2. A fully-historied student is refused repeatedly, identically —
//            never a double-delete, never a partial one.
//       P12. A failure inside the transaction rolls back EVERYTHING (trigger
//            proof): the identity, the tokens and the preferences are all
//            restored, and no success audit entry is written.
//       L.  The message the admin reads is the REAL dictionary entry (api.382),
//           and the dialog shows the server's breakdown with one localized
//           label per class.
//
//   GROUP (Q) — unchanged and still conservative
//     The Prisma schema declares EXACTLY THREE relations pointing at a Group
//     (`Student.groupId`, `LiveSession.groupId`, `AbsenceReview.groupId`), and
//     each one is refused separately before anything is deleted. The guards and
//     the delete now run in ONE transaction, so a student cannot be assigned to
//     the group between the check and the delete.
//       Q1. Non-admin cannot delete.          Q2. Unknown group → 404.
//       Q3. An EMPTY group deletes successfully (Q4: gone from the list).
//       Q5. Course/curriculum survive.        Q6. Teacher + account survive.
//       Q7. A group with students is REFUSED (api.294) — students are NEVER
//           deleted, not even detached.
//       Q8. Sessions (api.295) / absence cases (api.381) refuse it too.
//       Q9. No student is harmed.             Q10. Unrelated group untouched.
//
// The REAL route modules are compiled with the repo's own tsc and executed
// against a REAL SQLite database (the repo's own migration harness, with
// `PRAGMA foreign_keys=ON`), so the assertions exercise the shipped handlers,
// the shipped schema and real transaction rollback semantics.
//
// NOTE the stub for `next/server` also provides `NextResponse.json`, because the
// refusal is a STRUCTURED 409 body (code + per-category counts), not a bare
// string.
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
  fs.writeFileSync(
    nextStub,
    "module.exports = { NextRequest: class {}, NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body, json: async () => body }) } };"
  );
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

  /**
   * Remove every PROTECTED row of the seeded s1 (and every row on the u1
   * account), leaving the identity scaffolding only — so a P-B scenario proves
   * that ONE specific protected row causes the refusal.
   */
  function stripStudentHistory(d) {
    const PLAN = [
      ["LessonProgress", "studentId='s1'"],
      ["QuizAttempt", "studentId='s1'"],
      ["QuizRetryGrant", "studentId='s1' OR grantedByUserId='u1'"],
      ["HomeworkSubmission", "studentId='s1'"],
      ["ExamAttempt", "studentId='s1'"],
      ["StudyTask", "studentId='s1'"],
      ["SessionVideoView", "studentId='s1'"],
      ["LessonBookmark", "studentId='s1'"],
      ["LessonNote", "studentId='s1'"],
      ["TeacherNote", "studentId='s1'"],
      ["AttendanceCorrection", "studentId='s1'"],
      ["AbsenceHold", "studentId='s1'"],
      ["AbsenceReview", "studentId='s1'"],
      ["Attendance", "studentId='s1'"],
      ["Enrollment", "studentId='s1'"],
      ["Subscription", "studentId='s1'"],
      ["ParentStudentLink", "studentId='s1'"],
      ["Notification", "userId='u1'"],
      ["NotificationPreference", "userId='u1'"],
      ["UserSession", "userId='u1'"],
      ["PasswordResetToken", "userId='u1'"],
      ["AuditLog", "userId='u1'"],
      ["StudentBadge", "studentId='s1'"],
      ["Referral", "referrerId='s1' OR referredId='s1'"],
      ["ProgressionOverride", "studentId='s1'"],
      ["Payment", "userId='u1'"],
      ["CouponRedemption", "userId='u1'"],
      ["SecurityEvent", "userId='u1'"],
    ];
    for (const [table, where] of PLAN) {
      d.prepare(`DELETE FROM "${table}" WHERE ${where}`).run();
    }
  }

  /** Every row of every table this contract could touch, as a comparable map. */
  function snapshot(d) {
    const tables = [
      "User", "Student", "Parent", "ParentStudentLink", "Subscription", "SubscriptionPlan",
      "Enrollment", "Attendance", "AttendanceCorrection", "AbsenceReview", "AbsenceHold",
      "QuizAttempt", "QuizRetryGrant", "HomeworkSubmission", "LessonProgress", "LessonBookmark",
      "LessonNote", "ExamAttempt", "StudyTask", "SessionVideoView", "Referral", "StudentBadge",
      "ProgressionOverride", "Payment", "CouponRedemption", "Notification", "NotificationPreference",
      "UserSession", "PasswordResetToken", "SecurityEvent", "AuditLog", "Group", "Teacher",
    ];
    const out = {};
    for (const t of tables) {
      try {
        out[t] = JSON.stringify(d.prepare(`SELECT * FROM "${t}" ORDER BY id`).all());
      } catch {
        out[t] = "n/a";
      }
    }
    return JSON.stringify(out);
  }

  const asAdmin = () => {
    global.__ROLE__ = () => ({ user: { id: "admin-1", role: "ADMIN" }, error: null });
  };
  const asNonAdmin = () => {
    global.__ROLE__ = () => ({ user: null, error: { status: 403, body: { error: "Forbidden" } } });
  };

  // =========================================================================
  section("A. Static contract — the delete dependency matrix is COMPLETE and valid");
  // =========================================================================
  // The E2E sections below run the route against a REAL database. This cheap
  // gate proves the one property a runtime test cannot: that the classification
  // in the route covers EVERY identity-carrying column in the schema, so no
  // future relation can be added and silently cascade a person's history away.
  //
  // It also catches the class of bug a database reports only as an opaque
  // transaction failure: a step naming a field that does not exist on the
  // model (which in production would abort EVERY delete with api.380).
  // =========================================================================
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

    const lists = {};
    for (const name of ["PROTECTED_HISTORY", "SAFE_IDENTITY_DELETE", "PRESERVED_DETACH"]) {
      const from = routeSrc.indexOf(`const ${name}`);
      ok(from >= 0, `A: the route declares ${name}`);
      if (from < 0) continue;
      const to = routeSrc.indexOf("] as const;", from);
      const body = routeSrc.slice(from, to < 0 ? undefined : to);
      lists[name] = [...body.matchAll(/\{\s*model:\s*"(\w+)",\s*field:\s*"(\w+)"/g)].map((m) => [
        m[1],
        m[2],
      ]);
    }

    const protectedPairs = lists.PROTECTED_HISTORY || [];
    const safePairs = lists.SAFE_IDENTITY_DELETE || [];
    const detachPairs = lists.PRESERVED_DETACH || [];
    ok(protectedPairs.length >= 20, "A: the protected-history matrix is present and non-trivial", `found ${protectedPairs.length}`);
    ok(safePairs.length >= 3, "A: the safe-scaffolding list is present", `found ${safePairs.length}`);
    ok(detachPairs.length >= 2, "A: the preserved-and-detached list is present", `found ${detachPairs.length}`);

    // Every classified pair must name a REAL model/column pair.
    const cap = (m) => m.charAt(0).toUpperCase() + m.slice(1);
    const allPairs = [...protectedPairs, ...safePairs, ...detachPairs];
    const badPairs = allPairs.filter(([model, field]) => !models.has(cap(model)) || !models.get(cap(model)).has(field));
    ok(badPairs.length === 0, "A: every classified step names an existing model field", badPairs.map((b) => `${b[0]}.${b[1]}`).join(", "));

    // No pair may appear in TWO lists — a row is either protected, safe, or
    // preserved; it can never be both erased and kept.
    const key = ([m, f]) => `${m.charAt(0).toLowerCase()}${m.slice(1)}.${f}`;
    const seen = new Map();
    for (const [listName, list] of Object.entries(lists)) {
      for (const pair of list) {
        const k = key(pair);
        ok(!seen.has(k), `A: ${k} is classified exactly once`, seen.get(k));
        seen.set(k, listName);
      }
    }

    // ---- THE COMPLETENESS PROOF -------------------------------------------
    // Derive every identity-carrying column in the schema:
    //   * `studentId` / `userId` on any model other than Student/User itself;
    //   * the extra student/user references the schema spells differently.
    const IDENTITY_COLUMNS = new Set(["studentId", "userId"]);
    const EXTRA_IDENTITY_REFS = [
      ["QuizRetryGrant", "grantedByUserId"], // the student who GRANTED a retry
      ["Referral", "referrerId"],
      ["Referral", "referredId"],
    ];
    // Columns that name the STAFF MEMBER who acted, never the deleted identity:
    // a doctor approving a payment, a teacher creating a session, an admin
    // authoring an override. Deleting a student must not (and does not) touch
    // the audit trail of who did what.
    const ACTOR_COLUMNS = [
      ["Payment", "reviewedByUserId"],
      ["TeacherApplication", "reviewedByUserId"],
      ["ProgressionOverride", "createdByUserId"],
      ["LiveSession", "createdByUserId"],
      ["AttendanceCorrection", "correctedByUserId"],
    ];
    // The PROFILE models a User row can also be: a parent profile (whose links
    // cascade to OTHER students' rows) or a teacher profile (a staff account is
    // never a deletable student). Both are guarded explicitly in the route, so
    // they are excluded from the row-classification lists on purpose.
    const PROFILE_MODEL_COLUMNS = [
      ["Parent", "userId"],
      ["Teacher", "userId"],
    ];
    // The two columns on the identity models themselves.
    const IDENTITY_MODEL_COLUMNS = [["Student", "userId"], ["User", "id"], ["Student", "id"]];

    const required = [];
    for (const [model, fields] of models.entries()) {
      if (model === "Student" || model === "User") continue;
      for (const field of fields) {
        if (IDENTITY_COLUMNS.has(field)) required.push([model, field]);
      }
    }
    for (const [model, field] of EXTRA_IDENTITY_REFS) required.push([model, field]);

    const classified = new Set(allPairs.map(key));
    const actorOk = new Set(
      [...ACTOR_COLUMNS.map(key), ...PROFILE_MODEL_COLUMNS.map(key)].map((k) => k.charAt(0).toLowerCase() + k.slice(1))
    );
    const uncovered = required.filter(([m, f]) => {
      const k = key([m, f]);
      return !classified.has(k) && !actorOk.has(k);
    });
    ok(
      uncovered.length === 0,
      "A: EVERY identity-carrying schema column is classified (protected / safe / detached)",
      uncovered.map(([m, f]) => `${m}.${f}`).join(", ")
    );
    ok(required.length >= 28, "A: the derived matrix is non-vacuous", `derived ${required.length} columns`);

    // The actor columns must REALLY exist, and none of them may be classified
    // as safe-to-delete (that would erase another person's actions).
    const badActor = ACTOR_COLUMNS.filter(([m, f]) => !models.has(m) || !models.get(m).has(f));
    ok(badActor.length === 0, "A: the actor-column exclusion list names real columns", badActor.map((b) => b.join(".")).join(", "));
    const actorInSafe = ACTOR_COLUMNS.filter(([m, f]) => safePairs.some(([a, b]) => a === m && b === f));
    ok(actorInSafe.length === 0, "A: no staff-actor column is ever deleted with a student", actorInSafe.map((b) => b.join(".")).join(", "));
    const badIdentityModels = IDENTITY_MODEL_COLUMNS.filter(([m, f]) => !models.has(m) || !models.get(m).has(f));
    ok(badIdentityModels.length === 0, "A: the identity models still carry the columns the delete reads", badIdentityModels.map((b) => b.join(".")).join(", "));

    // ---- the identity-shape guards (parent/teacher profiles) ---------------
    ok(
      PROFILE_MODEL_COLUMNS.every(([M, f]) => models.get(M).has(f)),
      "A: the profile-model exclusions name real columns",
      PROFILE_MODEL_COLUMNS.map((b) => b.join(".")).join(", ")
    );
    ok(/db\.parent\.count\(\{ where: \{ userId: student\.userId \} \}\)/.test(routeSrc), "A: a PARENT profile blocks the delete (its links would cascade to other students)");
    ok(/db\.teacher\.count\(\{ where: \{ userId: student\.userId \} \}\)/.test(routeSrc), "A: a TEACHER profile blocks the delete");
    // ---- the contract copy the admin actually reads ------------------------
    ok(routeSrc.includes('code: "STUDENT_HAS_PROTECTED_HISTORY"'), "A: the refusal carries a stable machine-readable code");
    const dictSrc = fs.readFileSync(path.join(REPO, "src/lib/i18n-dict-2026.ts"), "utf8");
    const rule = /"api\.382":\s*\{\s*\r?\n\s*ar:\s*"([^"]+)"/.exec(dictSrc);
    ok(!!rule, "A: the refusal rule message exists in the dictionary (api.382)");
    ok(
      !!rule && rule[1].includes("سجل أكاديمي أو مالي"),
      "A: …and states the academic-or-financial rule in Arabic",
      rule ? rule[1].slice(0, 40) : "missing"
    );
    ok(/"api\.379":\s*\{/.test(dictSrc), "A: the financial-history guidance is kept (api.379)");
    ok(/"api\.383":\s*\{/.test(dictSrc), "A: the breakdown heading exists (api.383)");
    // ---- no schema change, no archive table -------------------------------
    ok(!/model\s+StudentArchive|isDeleted|deletedAt\s+DateTime/.test(schemaSrc), "A: no archive/soft-delete schema was introduced");
    ok(!/STUDENT_DELETE_DEPENDENTS/.test(routeSrc), "A: the old cascade-driven delete list is gone for good");
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
  section("P-A. A pristine student (no history at all) deletes successfully");
  // =========================================================================
  {
    const d = freshDb();
    seed(d);
    // Strip s1 back to a pristine identity, then remove it entirely: this
    // scenario needs a student created the way the admin's "Add Student" would
    // create one — identity rows and nothing else.
    stripStudentHistory(d);
    d.prepare(`DELETE FROM "Student" WHERE id='s1'`).run();
    d.prepare(`DELETE FROM "User" WHERE id='u1'`).run();
    // A fresh, PRISTINE student: identity only, no history whatsoever.
    ins(d, "User", { id: "u3", name: "QA Pristine", email: "qa@x.test", password: "h", role: "STUDENT", createdAt: NOW, updatedAt: NOW });
    ins(d, "Student", { id: "s3", userId: "u3", grade: "1st Secondary", academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE", studentCode: "CM-QA0001", enrolledAt: NOW, createdAt: NOW, updatedAt: NOW });
    ins(d, "UserSession", { id: "us3", userId: "u3", tokenHash: "th", deviceHash: "dh", lastSeenAt: NOW, expiresAt: NOW + 1000 });
    ins(d, "PasswordResetToken", { id: "prt3", userId: "u3", tokenHash: "th", expiresAt: NOW + 1000 });
    ins(d, "NotificationPreference", { id: "np3", userId: "u3", updatedAt: NOW });
    ins(d, "SecurityEvent", { id: "se3", userId: "u3", type: "LOGIN", createdAt: NOW });

    asAdmin();
    const res = await studentRoute.DELETE(bareReq(), params("s3"));
    eq(res.status, 200, "A: a student with NO protected history deletes successfully");
    eq(res.body.deleted, true, "A: the response reports the deletion");

    // L: no orphan identity rows remain anywhere in the schema's identity set.
    const identityOrphans = [
      ["Student", "id='s3'"],
      ["User", "id='u3'"],
      ["UserSession", "userId='u3'"],
      ["PasswordResetToken", "userId='u3'"],
      ["NotificationPreference", "userId='u3'"],
      ["ParentStudentLink", "studentId='s3'"],
    ].filter(([t, w]) => count(d, t, w) !== 0);
    ok(identityOrphans.length === 0, "L: the clean delete leaves NO orphan identity rows", identityOrphans.map((o) => o[0]).join(", "));
    eq(count(d, "SecurityEvent", "id='se3' AND userId IS NULL"), 1, "L: security history is PRESERVED and detached (schema: SetNull)");
    eq(count(d, "Student", "id='s1'"), 0, "K: the scenario edit did not disturb the other scenarios' expectation");
    eq(count(d, "Student", "id='s2'"), 1, "K: the unrelated student is untouched");
    eq(count(d, "LessonProgress", "studentId='s2'"), 1, "K: …and so is their progress");
    eq(count(d, "Group", "id='g1'"), 1, "K: the group is untouched");
    eq(count(d, "AuditLog", "action='STUDENT_DELETED' AND userId='admin-1'"), 1, "the deletion is audited on the admin's own account");
    eq(count(d, "AuditLog", "action='STUDENT_DELETED' AND entityId='s3'"), 1, "…against the student that was deleted");
  }

  // =========================================================================
  section("P-B. Every PROTECTED class refuses the delete (409) and changes nothing");
  // =========================================================================
  // One scenario per protected class the contract must defend. Each asserts the
  // SAME three things: the 409, the rule in the message, and — crucially — that
  // NOT ONE protected row and NOT the identity itself was touched.
  const PROTECTED_CASES = [
    { id: "B", label: "Payment", category: "financial",
      seed: (d) => ins(d, "Payment", { id: "pay1", userId: "u1", amount: 100, method: "CASH", status: "APPROVED", createdAt: NOW, updatedAt: NOW }) },
    { id: "B2", label: "CouponRedemption", category: "financial",
      seed: (d) => {
        ins(d, "Coupon", { id: "cp1", code: "C1", type: "PERCENTAGE", value: 10, isActive: 1, createdAt: NOW, updatedAt: NOW });
        ins(d, "CouponRedemption", { id: "cr1", couponId: "cp1", userId: "u1", createdAt: NOW });
      } },
    { id: "C", label: "QuizAttempt", category: "assessments",
      seed: (d) => ins(d, "QuizAttempt", { id: "qa1", studentId: "s1", quizId: "qz1", score: 8, totalMarks: 10, percentage: 80, passed: 1, startedAt: NOW }) },
    { id: "D", label: "HomeworkSubmission", category: "assessments",
      seed: (d) => ins(d, "HomeworkSubmission", { id: "hs1", studentId: "s1", homeworkId: "hw1", status: "GRADED" }) },
    { id: "E", label: "Attendance", category: "attendance",
      seed: (d) => ins(d, "Attendance", { id: "att1", studentId: "s1", sessionId: "sess1", status: "PRESENT", createdAt: NOW }) },
    { id: "E2", label: "AbsenceReview", category: "attendance",
      seed: (d) => {
        ins(d, "Attendance", { id: "att1", studentId: "s1", sessionId: "sess1", status: "ABSENT", createdAt: NOW });
        ins(d, "AbsenceReview", { id: "ar1", attendanceId: "att1", studentId: "s1", sessionId: "sess1", groupId: "g2", status: "PENDING_REASON", createdAt: NOW, updatedAt: NOW });
      } },
    { id: "F", label: "ExamAttempt (mock)", category: "assessments",
      seed: (d) => ins(d, "ExamAttempt", { id: "ea1", studentId: "s1", examType: "MOCK", questionCount: 10, durationMin: 30, score: 5, totalMarks: 10, percentage: 50, passed: 0, answers: "[]", startedAt: NOW }) },
    { id: "G", label: "LessonProgress", category: "progress",
      seed: (d) => ins(d, "LessonProgress", { id: "lp1", studentId: "s1", lessonId: "l1", progress: 100, isCompleted: 1 }) },
    { id: "G2", label: "SessionVideoView", category: "progress",
      seed: (d) => ins(d, "SessionVideoView", { id: "svv1", sessionVideoId: "sv1", studentId: "s1" }) },
    { id: "G3", label: "ProgressionOverride", category: "progress",
      seed: (d) => ins(d, "ProgressionOverride", { id: "po1", studentId: "s1", lessonId: "l1", reason: "r", createdByUserId: "admin-1", createdAt: NOW }) },
    { id: "H", label: "Subscription", category: "subscription",
      seed: (d) => ins(d, "Subscription", { id: "sub1", studentId: "s1", planId: "plan1", status: "ACTIVE", createdAt: NOW, updatedAt: NOW }) },
    { id: "H2", label: "Enrollment", category: "subscription",
      seed: (d) => ins(d, "Enrollment", { id: "en1", studentId: "s1", courseId: "c1", trackId: "tr1", status: "ACTIVE", startsAt: NOW, createdAt: NOW }) },
    { id: "X1", label: "TeacherNote", category: "notes",
      seed: (d) => ins(d, "TeacherNote", { id: "tn1", teacherId: "t1", studentId: "s1", note: "n", createdAt: NOW }) },
    { id: "X2", label: "LessonNote", category: "notes",
      seed: (d) => ins(d, "LessonNote", { id: "ln1", studentId: "s1", lessonId: "l1", content: "c", createdAt: NOW, updatedAt: NOW }) },
    { id: "X3", label: "LessonBookmark", category: "notes",
      seed: (d) => ins(d, "LessonBookmark", { id: "lb1", studentId: "s1", lessonId: "l1", createdAt: NOW }) },
    { id: "X4", label: "StudyTask", category: "notes",
      seed: (d) => ins(d, "StudyTask", { id: "st1", studentId: "s1", title: "t", scheduledDate: NOW, durationMin: 30, status: "PENDING", createdAt: NOW, updatedAt: NOW }) },
    { id: "X5", label: "StudentBadge", category: "achievements",
      seed: (d) => ins(d, "StudentBadge", { id: "sb1", studentId: "s1", code: "STAR", earnedAt: NOW }) },
    { id: "X6", label: "Notification", category: "account",
      seed: (d) => ins(d, "Notification", { id: "n1", userId: "u1", type: "INFO", title: "t", message: "m", createdAt: NOW }) },
    { id: "X7", label: "AuditLog", category: "account",
      seed: (d) => ins(d, "AuditLog", { id: "al1", userId: "u1", action: "LOGIN", createdAt: NOW }) },
    { id: "X8", label: "QuizRetryGrant (as granter)", category: "assessments",
      seed: (d) => ins(d, "QuizRetryGrant", { id: "qrg9", studentId: "s2", quizId: "qz1", grantedByUserId: "u1", grantedAt: NOW }) },
    { id: "X9", label: "AttendanceCorrection", category: "attendance",
      seed: (d) => {
        ins(d, "Attendance", { id: "att1", studentId: "s1", sessionId: "sess1", status: "PRESENT", createdAt: NOW });
        ins(d, "AttendanceCorrection", { id: "ac1", attendanceId: "att1", sessionId: "sess1", studentId: "s1", previousStatus: "ABSENT", newStatus: "PRESENT", reason: "r", correctedByUserId: "tuser", correctedAt: NOW });
      } },
    { id: "X10", label: "AbsenceHold", category: "attendance",
      seed: (d) => {
        ins(d, "Attendance", { id: "att1", studentId: "s1", sessionId: "sess1", status: "ABSENT", createdAt: NOW });
        ins(d, "AbsenceReview", { id: "ar1", attendanceId: "att1", studentId: "s1", sessionId: "sess1", groupId: "g2", status: "PENDING_REASON", createdAt: NOW, updatedAt: NOW });
        ins(d, "AbsenceHold", { id: "ah1", absenceReviewId: "ar1", studentId: "s1", sessionId: "sess1", status: "ACTIVE", createdAt: NOW });
      } },
    { id: "X11", label: "Referral (as referrer)", category: "achievements",
      seed: (d) => ins(d, "Referral", { id: "rf1", referrerId: "s1", referredId: "s2", createdAt: NOW }) },
  ];

  for (const c of PROTECTED_CASES) {
    const d = freshDb();
    seed(d);
    // Start from the PRISTINE identity: the case below is the ONLY protected
    // row that exists, so the refusal is proven to be caused by it.
    stripStudentHistory(d);
    c.seed(d);
    const before = snapshot(d);
    asAdmin();
    const res = await studentRoute.DELETE(bareReq(), params("s1"));
    eq(res.status, 409, `P-B/${c.id}: a student with ${c.label} is REFUSED (409)`);
    eq(res.body.code, "STUDENT_HAS_PROTECTED_HISTORY", `P-B/${c.id}: …with the protected-history contract code`);
    ok(
      typeof res.body.error === "string" && res.body.error.startsWith("api.382"),
      `P-B/${c.id}: …and the admin-facing rule message`,
      String(res.body.error).slice(0, 60)
    );
    eq(res.body.blocked?.[c.category] >= 1, true, `P-B/${c.id}: …and the breakdown names the «${c.category}» class`);
    eq(res.body.blockedTotal >= 1, true, `P-B/${c.id}: …with a positive blocked total`);
    // I + J: NOTHING was removed — not one protected row, not the identity.
    eq(snapshot(d), before, `P-B/${c.id}: I/J: the refusal changed NOTHING (no partial delete)`);
    eq(count(d, "Student", "id='s1'"), 1, `P-B/${c.id}: J: the Student row is intact`);
    eq(count(d, "User", "id='u1'"), 1, `P-B/${c.id}: J: the User row is intact`);
    // K: an unrelated student and the group stay untouched.
    eq(count(d, "Student", "id='s2'"), 1, `P-B/${c.id}: K: the unrelated student is unchanged`);
    eq(count(d, "Group", "id='g1'"), 1, `P-B/${c.id}: K: the group is unchanged`);
  }

  // =========================================================================
  section("P-I2. A refusal is not a partial delete — proven on a FULL history");
  // =========================================================================
  {
    const d = freshDb();
    seed(d);
    const before = snapshot(d);
    asAdmin();
    const res = await studentRoute.DELETE(bareReq(), params("s1"));
    eq(res.status, 409, "I: a fully-historied student is refused");
    eq(snapshot(d), before, "I: EVERY table is byte-identical after the refusal");
    eq(res.body.blocked.assessments >= 3, true, "I: the breakdown counts the graded-work class");
    eq(res.body.blocked.attendance >= 2, true, "I: …the attendance class");
    eq(res.body.blocked.subscription >= 2, true, "I: …the enrollment/subscription class");
    // A repeat attempt stays refused, identically.
    const again = await studentRoute.DELETE(bareReq(), params("s1"));
    eq(again.status, 409, "I: a repeat attempt is refused the same way (never a double-delete)");
    eq(count(d, "Student", "id='s1'"), 1, "I: …and still nothing was removed");
  }

  // =========================================================================
  section("P12. STUDENT — a failure rolls the whole thing back");
  // =========================================================================
  {
    const d = freshDb();
    seed(d);
    stripStudentHistory(d);
    // A trigger that refuses the final Student delete: the transaction must
    // roll back EVERY explicit removal performed before it.
    ins(d, "UserSession", { id: "us1", userId: "u1", tokenHash: "th", deviceHash: "dh", lastSeenAt: NOW, expiresAt: NOW + 1000 });
    ins(d, "NotificationPreference", { id: "np1", userId: "u1", updatedAt: NOW });
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
    eq(count(d, "UserSession", "userId='u1'"), 1, "P12: the session tokens were restored by the rollback");
    eq(count(d, "NotificationPreference", "userId='u1'"), 1, "P12: the preferences were restored by the rollback");
    eq(count(d, "AuditLog", "action='STUDENT_DELETED'"), 0, "P12: no success audit entry was written");
    // …and a retry after the blocker is gone still works.
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
    for (const key of ["admin.643", "admin.644", "admin.645", "admin.648", "admin.642", "teacher.312", "api.379", "api.380", "api.381", "api.382", "api.383"]) {
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
    // ---- FIX #4 CORRECTION: the refusal is still ACTIONABLE in the UI ------
    ok(/setBlocked\(j\?\.blocked/.test(region), "i18n/UI: a refused delete surfaces the per-category breakdown from the server");
    ok(/tr\("api.383"\)/.test(region), "i18n/UI: …under the breakdown heading (api.383)");
    const categoryKeys = ["admin.660", "admin.661", "admin.662", "admin.663", "admin.664", "admin.665", "admin.666", "admin.667"];
    ok(
      categoryKeys.every((k) => region.includes(`"${k}"`)),
      "i18n/UI: …with one localized label per protected class",
      categoryKeys.filter((k) => !region.includes(`"${k}"`)).join(", ")
    );
    ok(
      !/api\.379/.test(region),
      "i18n/UI: the dialog does not hard-code the financial wording (the server composes the message)"
    );
    // The supported alternative for a protected student must genuinely exist:
    // the Students list exposes the deactivate/reactivate toggle that PATCHes
    // `isActive`, and the refusal copy names it.
    // The toggle lives on the student ROW component (rendered by the list), so
    // it is pinned as one PATCH call on the student resource whose body flips
    // `isActive` — the existing contract, not a new endpoint.
    ok(
      /fetch\(`\/api\/admin\/students\/\$\{student\.id\}`, \{\s*method: "PATCH"[\s\S]{0,160}isActive: !student\.isActive/.test(dash),
      "i18n/UI: the Students list really exposes the deactivate/reactivate toggle the refusal points at (one PATCH, nothing new)"
    );
    for (const key of ["api.382", "api.383", ...categoryKeys]) {
      ok(real(key), `i18n: «${key}» (the revised delete contract) resolves in both locales`);
    }
    const rule = label("api.382");
    ok(
      rule.ar.includes("سجل أكاديمي أو مالي"),
      "i18n: the refusal rule names academic history as well as financial",
      rule.ar.slice(0, 60)
    );
    ok(
      rule.ar.includes("إيقاف الحساب"),
      "i18n: …and points the admin at the supported deactivate flow"
    );
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
