/**
 * Phase 26D — TEACHER FULL FLOW + LESSON QUIZ ARCHITECTURE regression test.
 *
 * Two layers, deliberately:
 *
 *   1. SOURCE PINS — cheap, fast assertions that the Phase 26D invariants are
 *      still *written* in the shipped code. They catch a refactor that quietly
 *      removes a guard, without booting a database.
 *   2. THE REAL VERIFIER — `scripts/verify-phase26d-teacher.mjs` runs the
 *      SHIPPED route handlers (compiled with the repo's own tsc) against a REAL
 *      SQLite database built from the base DDL + every real migration, over real
 *      HTTP-shaped calls. That is what actually proves behaviour; a table
 *      existing or a string being present in a file is never treated as a
 *      workflow PASS here.
 *
 * Run: node tests/phase26d-teacher-full-flow.test.js
 * Exit 0 = all pass.
 *
 * NO Neon, NO R2, NO SMTP, NO Vercel. SQLite in a temp dir only.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(same, same ? label : `${label} :: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ok - ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL - ${label}`);
  }
}

// ---------------------------------------------------------------------------
// 0. production safety
// ---------------------------------------------------------------------------
{
  const envUrl = process.env.DATABASE_URL || "";
  ok(!/postgres|neon/i.test(envUrl), "DATABASE_URL does not point at postgres/neon");
  ok(fs.existsSync(path.join(ROOT, "prisma/schema.prisma")), "the SQLite source schema is the one under test");
}

// ---------------------------------------------------------------------------
// 1. schema + migration shape
// ---------------------------------------------------------------------------
{
  console.log("\n== 1. schema + migration ==");
  const schema = read("prisma/schema.prisma");
  ok(/model QuizRetryGrant \{/.test(schema), "QUIZ-16: the QuizRetryGrant model exists");
  ok(/model QuizAttempt[\s\S]*?attemptNumber\s+Int\s+@default\(1\)/.test(schema), "QUIZ-09: QuizAttempt.attemptNumber exists with default 1");
  ok(/model QuizAttempt[\s\S]*?@@unique\(\[quizId, studentId, attemptNumber\]\)/.test(schema), "QUIZ-09: (quizId, studentId, attemptNumber) is UNIQUE");
  ok(/model Quiz[\s\S]*?maxAttempts\s+Int\s+@default\(1\)/.test(schema), "QUIZ-08: Quiz.maxAttempts defaults to 1 (one attempt by default)");
  ok(/model Quiz[\s\S]*?quizMode\s+String\s+@default\("FIXED"\)/.test(schema), "QUIZ-29: Quiz.quizMode defaults to FIXED (legacy-compatible)");
  ok(/promptSnapshot\s+String\?/.test(schema), "QUIZ-06: QuizAnswer carries a nullable prompt snapshot");
  ok(/answerSnapshot\s+String\?/.test(schema), "QUIZ-06: QuizAnswer carries a nullable answer snapshot");
  ok(/optionsSnapshot\s+String\?/.test(schema), "QUIZ-06: QuizAnswer carries a nullable options snapshot");
  ok(/marksSnapshot\s+Int\?/.test(schema), "QUIZ-07: QuizAnswer carries a nullable marks snapshot");
  ok(/schoolTypeSnapshot\s+String\?/.test(schema), "QUIZ-05: QuizAnswer carries a nullable track snapshot");

  const migDir = "prisma/migrations/20260915180000_phase26d_quiz_attempt_architecture";
  ok(fs.existsSync(path.join(ROOT, migDir, "migration.sql")), "the Phase 26D migration file exists");
  const mig = read(path.join(migDir, "migration.sql"));
  // Strip comments before scanning for destructive keywords: this migration's
  // own SAFETY header says "no DROP, no DELETE, no TRUNCATE", and a naive scan
  // would "find" the words it is denying. Same approach as
  // tests/migration-sql.test.js.
  const migCode = mig
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  ok(!/\bDROP\s+TABLE\b/i.test(migCode), "the migration DROPs no table");
  ok(!/\bTRUNCATE\b/i.test(migCode), "the migration TRUNCATEs nothing");
  ok(!/\bDELETE\s+FROM\b/i.test(migCode), "the migration DELETEs no rows");
  ok(!/\bDROP\b/i.test(migCode), "the migration DROPs nothing at all (no index, no column)");
  ok(/ALTER TABLE "QuizAttempt" ADD COLUMN "attemptNumber"/.test(mig), "attemptNumber is added, not rebuilt");
  ok(/CREATE TABLE "QuizRetryGrant"/.test(mig), "QuizRetryGrant is created by the migration");
  ok(/ON DELETE SET NULL/.test(mig), "the retry-grant FK cannot cascade-delete attempt history");
  // The backfills must be present and deterministic.
  ok(/SET "attemptNumber" = \(/.test(mig), "attempt numbers are backfilled");
  ok(/ORDER BY|ORDER\s|"earlier"\."id" < "QuizAttempt"\."id"/.test(mig), "the backfill ordering is deterministic (id tie-break)");
  ok(/SET "status" = CASE WHEN "finishedAt" IS NULL THEN 'OPEN' ELSE 'SUBMITTED' END/.test(mig), "status is backfilled from finishedAt, the pre-existing truth");

  // PostgreSQL artifacts must stay derived from the ONE schema.
  const pg = read("scripts/db/postgres-baseline.sql");
  ok(/CREATE TABLE "QuizRetryGrant"/.test(pg), "the postgres baseline carries QuizRetryGrant");
  ok(/"QuizAttempt_quizId_studentId_attemptNumber_key" UNIQUE/.test(pg), "the postgres baseline carries the unique attempt-number constraint");
  ok(/"QuizAttempt_retryGrantId_fkey" FOREIGN KEY/.test(pg), "the postgres baseline carries the properly named grant FK");
  ok(/QuizRetryGrant/.test(read("prisma/postgres/schema.prisma")), "the derived postgres schema carries the new model");

  // Every harness that derives a base schema must skip the migration-added
  // columns, or the scratch DB would collide with the migration.
  for (const f of [
    "scripts/lib/migrate-sqlite.mjs",
    "scripts/verify-phase13-db.mjs",
    "scripts/verify-phase14-db.mjs",
  ]) {
    const src = read(f);
    ok(/"QuizRetryGrant"/.test(src) && /"answerSnapshot"/.test(src), `${f} knows the Phase 26D columns/table are migration-added`);
  }
}

// ---------------------------------------------------------------------------
// 2. one authoritative selection service (no duplicated selection logic)
// ---------------------------------------------------------------------------
{
  console.log("\n== 2. selection authority ==");
  const bp = read("src/lib/quiz-blueprint.ts");
  ok(/export function selectAttemptQuestions\(/.test(bp), "QUIZ-02: one exported selection service exists");
  ok(/export function resolveQuizBlueprint\(/.test(bp), "QUIZ-01: one exported blueprint resolver exists");
  ok(/random\?: \(\) => number/.test(bp), "randomness is injectable (deterministic tests, random production)");
  ok(/isQuestionEligible\(schoolType, q\.schoolType\)/.test(bp), "QUIZ-05: selection applies the track predicate");
  ok(/class BlueprintUnsatisfiableError/.test(bp), "QUIZ-04: an unsatisfiable pool fails loudly, not silently short");
  ok(/used\.has\(q\.id\) \? seen : fresh/.test(bp), "QUIZ-21: unused questions are preferred over already-seen ones");

  const sq = read("src/lib/session-quiz.ts");
  ok(/selectAttemptQuestions\(\{/.test(sq), "the quiz service delegates to the one selector");
  ok(/export function decideAttemptStart\(/.test(sq), "QUIZ-08: the attempt state machine is a single testable decision");
  ok(/ATTEMPT_LIMIT_REACHED/.test(sq), "QUIZ-13: the limit-reached state is named");
  ok(/export async function buildAttemptInspection\(/.test(sq), "QUIZ-23: one inspection payload builder for all three surfaces");
  ok(/const reveal = terminal && opts\.revealAnswerKey !== false/.test(sq), "QUIZ-26: the answer key is forced off for an OPEN attempt");

  // The routes must not re-implement selection or entitlement.
  const start = read("src/app/api/quizzes/[id]/start/route.ts");
  ok(/selectAttemptQuestionsForQuiz\(id, schoolType, blueprint, seen\)/.test(start), "QUIZ-02: /start selects through the shared service");
  ok(/decideAttemptStart\(\{/.test(start), "QUIZ-08: /start decides through the shared state machine");
  ok(!/Math\.random/.test(start), "/start does not hand-roll its own randomness");
  ok(!/body\.questionIds|body\.attemptNumber|body\.retry/.test(start), "QUIZ-03: /start reads no question ids, attempt number or retry metadata from the body");
}

// ---------------------------------------------------------------------------
// 3. submit is terminal; the retake hole is gone
// ---------------------------------------------------------------------------
{
  console.log("\n== 3. terminal submit ==");
  const submit = read("src/app/api/quizzes/[id]/submit/route.ts");
  ok(!/quizAttempt\.create/.test(submit), "QUIZ-13: /submit never creates an attempt");
  ok(!/loadQuizQuestionSet/.test(submit), "QUIZ-13: /submit never derives a set from the live bank");
  ok(/ATTEMPT_ALREADY_SUBMITTED/.test(submit), "QUIZ-28: a replay is refused machine-readably");
  ok(/ATTEMPT_NOT_STARTED/.test(submit), "QUIZ-13: submitting with no attempt cannot manufacture one");
  ok(/status: "SUBMITTED"/.test(submit), "QUIZ-12: the terminal transition is written");
  ok(!/body\.score|body\.percentage|body\.passed|body\.totalMarks/.test(submit), "QUIZ-14: no client score/percentage/passed/totalMarks is read");
  ok(/gradeAttemptQuestionSet\(set, answersRaw, quiz\.passMark, schoolType\)/.test(submit), "QUIZ-14: grading is server-side through the shared grader");

  // The client must not offer a retry the server will refuse.
  const runner = read("src/components/course/quiz-runner.tsx");
  ok(!/onRetry/.test(runner), "QUIZ-13: the client result screen no longer offers a Retry button");
  ok(/ATTEMPT_LIMIT_REACHED/.test(runner), "QUIZ-13: the client surfaces the attempt-limit refusal");
  ok(/course\.031/.test(runner), "the client explains that the attempt is final");
}

// ---------------------------------------------------------------------------
// 4. retry grant is Admin-only and audited
// ---------------------------------------------------------------------------
{
  console.log("\n== 4. retry grant authority ==");
  ok(fs.existsSync(path.join(ROOT, "src/app/api/admin/quiz-retries/route.ts")), "QUIZ-16: the Admin retry route exists");
  const retries = read("src/app/api/admin/quiz-retries/route.ts");
  ok(/requireRole\("ADMIN"\)/.test(retries), "QUIZ-16/17/18: the retry route is ADMIN-only");
  ok(!fs.existsSync(path.join(ROOT, "src/app/api/teacher/quiz-retries/route.ts")), "QUIZ-17: there is NO teacher retry route to call");

  const lib = read("src/lib/quiz-retry.ts");
  ok(/RETRY_AUDIT_ACTION = "QUIZ_RETRY_GRANTED"/.test(lib), "QUIZ-30: the audit action is QUIZ_RETRY_GRANTED");
  ok(/ALREADY_PENDING/.test(lib), "QUIZ-19: a duplicate unconsumed grant is refused");
  ok(/consumedAt: opts\.now \?\? new Date\(\)/.test(lib), "QUIZ-20: consumption stamps the grant");
  ok(/RETRY_REASON_MAX/.test(lib), "the grant reason is length-bounded");

  // No teacher route may create a grant.
  const teacherDir = path.join(ROOT, "src/app/api/teacher");
  const teacherFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) teacherFiles.push(p);
    }
  })(teacherDir);
  const leaking = teacherFiles.filter((f) => /quizRetryGrant\.create|issueRetryGrant/.test(fs.readFileSync(f, "utf8")));
  ok(leaking.length === 0, "QUIZ-17: no teacher route can create a retry grant");

  const tAttempts = read("src/app/api/teacher/quizzes/[id]/attempts/route.ts");
  ok(/canGrantRetry: false/.test(tAttempts), "QUIZ-17: the teacher inspection surface states it cannot grant retries");
  ok(!/export async function POST/.test(tAttempts), "QUIZ-17: the teacher attempt route is read-only (no POST)");
}

// ---------------------------------------------------------------------------
// 5. inspection surfaces + answer-key policy
// ---------------------------------------------------------------------------
{
  console.log("\n== 5. inspection ==");
  ok(fs.existsSync(path.join(ROOT, "src/app/api/admin/quiz-attempts/route.ts")), "QUIZ-23: the admin attempt list route exists");
  ok(fs.existsSync(path.join(ROOT, "src/app/api/admin/quiz-attempts/[id]/route.ts")), "QUIZ-23: the admin attempt detail route exists");
  ok(fs.existsSync(path.join(ROOT, "src/app/api/quizzes/[id]/attempts/route.ts")), "QUIZ-25: the student's own attempt route exists");

  const adminList = read("src/app/api/admin/quiz-attempts/route.ts");
  ok(!/buildAttemptInspection/.test(adminList), "QUIZ-26: the admin LIST does not embed question-level answer keys");

  const studentAtt = read("src/app/api/quizzes/[id]/attempts/route.ts");
  ok(/studentId: student\.id/.test(studentAtt), "QUIZ-25: the student route is scoped by the session profile, never a parameter");
  ok(!/searchParams\.get\("studentId"\)/.test(studentAtt), "QUIZ-25: the student route accepts no studentId parameter to forge");
  ok(/granted: true/.test(studentAtt), "QUIZ-25: the student sees THAT a retry was granted, not WHO granted it");

  const quizGet = read("src/app/api/quizzes/[id]/route.ts");
  ok(/answer: revealAnswers \? q\.answer : undefined/.test(quizGet), "QUIZ-26: the student quiz GET still withholds the key before submission");
  ok(/suppressUntilStart/.test(quizGet), "QUIZ-02: a blueprint quiz serves no pool before /start");
}

// ---------------------------------------------------------------------------
// 5b. frozen history survives Question EDIT and DELETE
// ---------------------------------------------------------------------------
{
  console.log("\n== 5b. history integrity under question deletion ==");
  const schema = read("prisma/schema.prisma");

  // The hazard is real and must stay DOCUMENTED, not silently "fixed" away:
  // QuizAnswer.question is onDelete: Cascade, so an unguarded delete of a
  // Question destroys the frozen snapshot rows of every attempt that drew it.
  // Proven at DB level in scripts/verify-phase26d-teacher.mjs (QUIZ-31) with FK
  // enforcement enabled.
  ok(/model QuizAnswer[\s\S]*?question\s+Question\s+@relation\([^)]*onDelete: Cascade\)/.test(schema),
    "the QuizAnswer->Question cascade is still declared (so the guard remains load-bearing)");

  // The guard itself.
  const tc = read("src/lib/teacher-content.ts");
  ok(/if \(refs\.answers > 0\) blockers\.push\("FROZEN_ANSWERS"\)/.test(tc),
    "QUIZ-31: canDeleteQuestion blocks on frozen answers");
  ok(/OPEN_ATTEMPT|GRADED_ATTEMPT/.test(tc), "QUIZ-31: the guard also reports attempt-level blockers");
  // The loader must be able to run inside a transaction, or the check-then-delete
  // race is back.
  ok(/client: Pick<typeof db, "quizAnswer" \| "mockExamQuestion"> = db/.test(tc),
    "QUIZ-31: loadQuestionReferences accepts a transaction client");

  const qDel = read("src/app/api/teacher/questions/[id]/route.ts");
  ok(/db\.\$transaction\(async \(tx\)/.test(qDel),
    "QUIZ-31: the question delete checks references and deletes in ONE transaction");
  ok(/loadQuestionReferences\(id, tx\)/.test(qDel),
    "QUIZ-31: the reference check runs on the TRANSACTION client, not the module db");
  ok(/tx\.question\.delete/.test(qDel),
    "QUIZ-31: the delete runs on the transaction client");
  ok(!/await db\.question\.delete/.test(qDel),
    "QUIZ-31: no out-of-transaction question delete remains");

  const quizDel = read("src/app/api/teacher/quizzes/[id]/route.ts");
  ok(/db\.\$transaction\(async \(tx\)/.test(quizDel),
    "QUIZ-31: the quiz delete is also atomic (Quiz->Question->QuizAnswer cascade)");
  ok(/loadQuestionReferences\(q\.id, tx\)/.test(quizDel),
    "QUIZ-31: the quiz delete checks pins on the transaction client");

  // The freeze must not be weakened: grading-relevant fields stay locked while
  // history exists.
  ok(/GRADING_FIELDS = \["answer", "options", "type", "marks"\]/.test(tc),
    "QUIZ-31: the grading-relevant field lock is intact");
  ok(/snapshot \?\? r\.question/.test(read("src/lib/session-quiz.ts")),
    "QUIZ-31: the attempt reader still prefers the snapshot over the live row");
}

// ---------------------------------------------------------------------------
// 5d. the CONCURRENCY protocol — the lock that actually closes the race
// ---------------------------------------------------------------------------
{
  console.log("\n== 5d. concurrency protocol for destructive delete ==");
  const ser = read("src/lib/db-serialization.ts");

  // A plain $transaction does NOT close this race under PostgreSQL READ
  // COMMITTED: a bare SELECT takes no lock conflicting with an INSERT into the
  // REFERENCING table. These pins are what make the earlier "atomic" claim true.
  ok(/pg_advisory_xact_lock/.test(ser),
    "QUIZ-33: the protocol uses the transaction-scoped PostgreSQL advisory lock");
  ok(!/[^_]pg_advisory_lock\s*\(/.test(ser),
    "QUIZ-33: the session-scoped lock variant is never used (it would leak past COMMIT)");
  ok(/export function quizDestructiveLockId/.test(ser), "QUIZ-33: the quiz lock id is exported");
  ok(/export async function acquireQuizDestructiveLock/.test(ser), "QUIZ-33: the acquire helper is exported");
  ok(/if \(provider !== "postgresql"\) return;/.test(ser),
    "QUIZ-33: SQLite is a deliberate NO-OP — local dev never depends on PostgreSQL");
  ok(/\$executeRaw`SELECT pg_advisory_xact_lock\(\$\{lockId\}\)`/.test(ser),
    "QUIZ-33: the lock id is BOUND via tagged template, never string-interpolated");
  ok(/cm:phase26d:quiz-destructive/.test(ser),
    "QUIZ-33: the quiz lock has its own namespace (cannot collide with other locks)");

  // Both sides of the race must take the SAME lock, or they never contend.
  const start = read("src/app/api/quizzes/[id]/start/route.ts");
  const qDel = read("src/app/api/teacher/questions/[id]/route.ts");
  const zDel = read("src/app/api/teacher/quizzes/[id]/route.ts");
  ok(/acquireQuizDestructiveLock\(tx, id\)/.test(start),
    "QUIZ-33: attempt start takes the per-quiz lock");
  ok(/acquireQuizDestructiveLock\(tx, id\)/.test(zDel),
    "QUIZ-33: quiz delete takes the SAME per-quiz lock");
  ok(/acquireQuizDestructiveLock\(tx, owned\.owner\.quiz\.id\)/.test(qDel),
    "QUIZ-33: question delete keys by its OWNING quiz, so it contends with start");

  // The freeze must happen UNDER the lock — i.e. inside the transaction.
  ok(/seedAttemptQuestions\(created\.id, id, schoolType, \{[\s\S]{0,160}?tx,/.test(start),
    "QUIZ-33: the create-path freeze is written through the transaction");
  ok(/seedAttemptQuestions\(existing\.id, id, schoolType, \{ blueprint, tx \}\)/.test(start),
    "QUIZ-33: the resume-path freeze is written through its transaction");
  ok(!/await seedAttemptQuestions\(attempt\.id/.test(start),
    "QUIZ-33: no post-COMMIT freeze remains (it would release the lock first)");

  const sq = read("src/lib/session-quiz.ts");
  ok(/tx\?: Pick<typeof db, "quizAnswer">/.test(sq),
    "QUIZ-33: seedAttemptQuestions accepts a transaction client");
  ok(/const writer = opts\.tx \?\? db;/.test(sq),
    "QUIZ-33: seedAttemptQuestions writes through the caller's transaction when given one");

  // The PostgreSQL-only proof must exist and must not be claimed from SQLite.
  const pgTest = read("tests/phase26d-concurrency-postgres.test.js");
  ok(/PHASE26D_CONCURRENCY_SKIPPED/.test(pgTest),
    "QUIZ-33: the PostgreSQL proof SKIPS ITSELF honestly when no PG is reachable");
  ok(/neon\.tech|neondb|prod|production/i.test(pgTest),
    "QUIZ-33: the PostgreSQL proof REFUSES to run against production/Neon");
  ok(/READ COMMITTED/.test(pgTest),
    "QUIZ-33: the PostgreSQL proof exercises the actual READ COMMITTED race");
}

// ---------------------------------------------------------------------------
// 5c. the DB-level cascade hazard, proven with FK enforcement ON
// ---------------------------------------------------------------------------
{
  console.log("\n== 5c. cascade hazard at the database level ==");
  // The application guard is what actually protects history, and QUIZ-31 in the
  // verifier proves it end to end. This block proves WHY the guard is
  // load-bearing: with foreign keys enforced (as they are on PostgreSQL, and as
  // they are NOT in the SQLite test harness, whose base DDL emits no FKs at
  // all), the declared cascade really does destroy frozen history.
  //
  // If this assertion ever starts passing differently, the schema changed and
  // the guard's necessity must be re-evaluated.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  ok(db.prepare("PRAGMA foreign_keys").get().foreign_keys === 1,
    "FK enforcement is ON for this proof");

  // Exactly the constraints scripts/db/postgres-baseline.sql declares.
  db.exec(`
    CREATE TABLE "Question" ("id" TEXT NOT NULL PRIMARY KEY, "prompt" TEXT NOT NULL);
    CREATE TABLE "QuizAttempt" ("id" TEXT NOT NULL PRIMARY KEY, "score" INTEGER);
    CREATE TABLE "QuizAnswer" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "attemptId" TEXT NOT NULL,
      "questionId" TEXT NOT NULL,
      "promptSnapshot" TEXT,
      CONSTRAINT "QuizAnswer_questionId_fkey" FOREIGN KEY ("questionId")
        REFERENCES "Question" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT "QuizAnswer_attemptId_fkey" FOREIGN KEY ("attemptId")
        REFERENCES "QuizAttempt" ("id") ON UPDATE CASCADE ON DELETE CASCADE
    );`);
  db.exec(`INSERT INTO "Question" VALUES ('q1','ORIGINAL PROMPT');`);
  db.exec(`INSERT INTO "QuizAttempt" VALUES ('a1', 4);`);
  db.exec(`INSERT INTO "QuizAnswer" VALUES ('ans1','a1','q1','ORIGINAL PROMPT');`);

  const before = db.prepare(`SELECT COUNT(*) c FROM "QuizAnswer" WHERE "attemptId"='a1'`).get().c;
  eq(before, 1, "one frozen answer row exists before the delete");

  db.exec(`DELETE FROM "Question" WHERE "id"='q1';`);

  const after = db.prepare(`SELECT COUNT(*) c FROM "QuizAnswer" WHERE "attemptId"='a1'`).get().c;
  const attempt = db.prepare(`SELECT * FROM "QuizAttempt" WHERE "id"='a1'`).get();
  eq(after, 0, "QUIZ-31: the CASCADE destroys the frozen answer row (hazard reproduced)");
  ok(!!attempt && attempt.score === 4,
    "QUIZ-31: the attempt survives with its score — orphaned, unreadable history");
}

// ---------------------------------------------------------------------------
// 6. the real end-to-end verifier
// ---------------------------------------------------------------------------
{
  console.log("\n== 6. real-DB end-to-end verifier ==");
  let out = "";
  let exited = 0;
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, "scripts/verify-phase26d-teacher.mjs")], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf8",
      timeout: 600000,
    });
  } catch (e) {
    exited = 1;
    out = `${e.stdout || ""}${e.stderr || ""}`;
  }
  ok(exited === 0, "the real-DB verifier exited 0");
  ok(/PHASE26D_VERIFIER_OK/.test(out), "the verifier reported success");
  const m = /(\d+) passed, (\d+) failed/.exec(out);
  ok(!!m, "the verifier reported its assertion counts");
  if (m) {
    ok(Number(m[1]) >= 300, `the verifier asserted at scale (${m[1]} assertions)`);
    ok(Number(m[2]) === 0, `the verifier reported zero failures (got ${m[2]})`);
  }
  // Spot-check that the security-critical assertions actually ran, so a silently
  // truncated verifier cannot pass by asserting nothing.
  for (const needle of [
    "TEACHER-15: teacher CANNOT grant a retry",
    "TEACHER-15: student CANNOT grant a retry",
    "QUIZ-08/13: a second start after submit is refused",
    "QUIZ-20: the grant is now CONSUMED",
    "QUIZ-13/20: a CONSUMED grant cannot be spent again",
    "QUIZ-07: the attempt kept the ORIGINAL answer key",
    "QUIZ-26: an OPEN attempt reveals no answer key",
    "QUIZ-27: the forged question never became an answer row",
    "QUIZ-29: a legacy FIXED quiz still starts",
    "QUIZ-30: the grant wrote a QUIZ_RETRY_GRANTED audit entry",
    "QUIZ-31: deleting a question referenced by frozen history is REFUSED",
    "QUIZ-31: the frozen prompt is UNCHANGED by the live edit",
    "QUIZ-31: NO QuizAnswer row disappeared because of the delete attempt",
    "QUIZ-31: the historical score is UNCHANGED",
    "QUIZ-31: a foreign teacher cannot reach the delete path",
    "QUIZ-31: the FIRST attempt's frozen rows survived the retry",
    "QUIZ-32: the shared (quizId=NULL) bank question was NOT sampled into the attempt",
    "QUIZ-33: the same quiz always maps to the same lock id",
    "QUIZ-33: the statement is a parameterized pg_advisory_xact_lock",
    "QUIZ-33: on SQLite the advisory call is skipped",
    "QUIZ-33: question delete order is LOCK -> check references -> delete",
    "QUIZ-33: start order is LOCK -> create attempt -> freeze rows",
    "QUIZ-33: question delete keys the lock by its OWNING quiz id",
  ]) {
    ok(out.includes(needle), `verifier ran: ${needle}`);
  }
}

console.log(`\nphase26d: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("PHASE26D_TEST_OK");
