/**
 * Phase 26D — PostgreSQL concurrency proof for history-preserving delete.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * ===============================
 * The SQLite harness CANNOT prove this invariant, for two concrete reasons:
 *
 *   1. `baseSchemaDdl()` in scripts/lib/migrate-sqlite.mjs emits NO foreign
 *      keys at all, so `onDelete: Cascade` has no effect there;
 *   2. `PRAGMA foreign_keys` is OFF by default, and SQLite permits at most one
 *      writer at a time, so the two concurrent write transactions this test
 *      needs cannot both be in flight.
 *
 * The race is a PostgreSQL READ COMMITTED race, so it must be proven on
 * PostgreSQL. This file does that, and SKIPS ITSELF (exit 0, clearly reported)
 * when no PostgreSQL is reachable — it never pretends to have proven something
 * it did not.
 *
 * WHAT IT PROVES
 * ==============
 * The required invariant: a concurrent attempt start must NOT be able to freeze
 * a question that a destructive delete then cascades away. Formally, the
 * FORBIDDEN end state is:
 *
 *     a QuizAttempt row EXISTS
 *     AND its frozen QuizAnswer row was created
 *     AND that QuizAnswer row disappeared because the delete cascaded it
 *
 * Acceptable outcomes are exactly two:
 *   A) the attempt wins -> the delete re-checks references UNDER THE LOCK,
 *      sees the frozen rows, and refuses (409);
 *   B) the delete wins -> the attempt's freeze cannot reference a deleted
 *      question, so it fails and no orphan attempt remains.
 *
 * It runs against the REAL production schema (scripts/db/postgres-baseline.sql)
 * and the REAL `Question` / `QuizAttempt` / `QuizAnswer` tables, so the
 * `QuizAnswer_questionId_fkey ... ON DELETE CASCADE` under test is the shipped
 * one — not a replica.
 *
 * HOW TO RUN
 * ==========
 *   createdb cm_phase26d_concurrency            # DISPOSABLE database only
 *   DATABASE_URL=postgresql://localhost:5432/cm_phase26d_concurrency \
 *     node tests/phase26d-concurrency-postgres.test.js
 *
 * In CI, `.github/workflows/phase26d-postgres-concurrency.yml` points
 * DATABASE_URL at a throwaway PostgreSQL service container. A CI gate must
 * treat PHASE26D_CONCURRENCY_SKIPPED as a FAILURE — a skip is not a pass.
 *
 * SAFETY
 * ======
 * Refuses to run against production/Neon-looking URLs, and only connects to a
 * local/service-container host unless explicitly told otherwise. It drops and
 * recreates the `public` schema, so it must never be pointed at real data.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

function skip(reason) {
  console.log(`\nphase26d-concurrency-postgres: SKIPPED — ${reason}`);
  console.log(
    "  This test proves a PostgreSQL READ COMMITTED race and cannot be proven on\n" +
      "  SQLite. Run it with DATABASE_URL pointing at a DISPOSABLE local/CI\n" +
      "  PostgreSQL (see the header of this file).\n" +
      "  A CI gate must treat this skip as a FAILURE."
  );
  console.log("PHASE26D_CONCURRENCY_SKIPPED");
}

function refuse(reason) {
  console.error(`\nREFUSING TO RUN: ${reason}`);
  process.exit(1);
}

if (!DATABASE_URL) {
  skip("DATABASE_URL is not set");
  process.exit(0);
}
if (!/^postgres(ql)?:\/\//i.test(DATABASE_URL)) {
  skip(
    `DATABASE_URL is not a PostgreSQL URL (got ${DATABASE_URL.replace(/:[^:@/]*@/, ":***@")})`
  );
  process.exit(0);
}

// --- SAFETY: never touch production, never wander to an external host -------
if (/neon\.tech|neondb|prod|production|vercel|aws\.com|supabase/i.test(DATABASE_URL)) {
  refuse(
    "DATABASE_URL looks like a PRODUCTION/Neon/hosted database.\n" +
      "  This test DROPS AND RECREATES the public schema. Point it at a\n" +
      "  disposable local or CI-service PostgreSQL instead."
  );
}
{
  const host = (() => {
    try {
      return new URL(DATABASE_URL).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const ALLOWED = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db", "0.0.0.0"]);
  const extra = String(process.env.PHASE26D_PG_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of extra) ALLOWED.add(h);
  if (!ALLOWED.has(host)) {
    refuse(
      `host "${host}" is not a local/CI-service host.\n` +
      `  Allowed by default: ${[...ALLOWED].join(", ")}.\n` +
      "  Set PHASE26D_PG_ALLOWED_HOSTS to extend this only for a known-disposable\n" +
      "  CI service container."
    );
  }
}

let pg;
try {
  pg = require("pg");
} catch {
  skip("the `pg` module is not installed");
  process.exit(0);
}

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log(`  ok - ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL - ${label}${extra ? ` :: ${extra}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every query in this test gets a hard ceiling so a deadlock cannot hang CI. */
const STATEMENT_TIMEOUT_MS = Number(process.env.PHASE26D_PG_STATEMENT_TIMEOUT_MS || 20000);

// ---------------------------------------------------------------------------
// The lock contract, mirrored from src/lib/db-serialization.ts and
// CROSS-CHECKED against the shipped module at runtime (see crossCheckLockId).
// ---------------------------------------------------------------------------
const NAMESPACE = "cm:phase26d:quiz-destructive";
const FNV_OFFSET_BASIS = BigInt("0xcbf29ce484222325");
const FNV_PRIME = BigInt("0x100000001b3");
const MASK_64 = BigInt("0xffffffffffffffff");
const MASK_63 = BigInt("0x7fffffffffffffff");
function fnv1a63(input) {
  let h = FNV_OFFSET_BASIS;
  for (const byte of Buffer.from(input, "utf8")) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK_64;
  }
  return h & MASK_63;
}
const lockId = (quizId) => fnv1a63(`${NAMESPACE}\u0000${quizId}`);

/** Assert the shipped module derives the same id this test locks on. */
function crossCheckLockId() {
  try {
    const script = `
      const ts = require('typescript');
      const fs = require('fs');
      const src = fs.readFileSync('src/lib/db-serialization.ts', 'utf8');
      const js = ts.transpileModule(src, {
        compilerOptions: { module: 'commonjs', target: 'es2020' },
      }).outputText;
      const m = { exports: {} };
      new Function('exports', 'module', 'require', js)(m.exports, m, require);
      process.stdout.write(String(m.exports.quizDestructiveLockId('quiz-A')));
    `;
    const out = execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      cwd: path.resolve(__dirname, ".."),
    }).trim();
    ok(
      out === String(lockId("quiz-A")),
      "the shipped quizDestructiveLockId matches the id this test locks on",
      `shipped=${out} test=${lockId("quiz-A")}`
    );
  } catch (e) {
    ok(
      false,
      "the shipped quizDestructiveLockId matches the id this test locks on",
      e.message
    );
  }
}

// ---------------------------------------------------------------------------
// Fixture identity
// ---------------------------------------------------------------------------
const QUIZ = "p26d-quiz-A";
const QID = "p26d-q1";
const STUDENT = "p26d-student-1";

/**
 * The REAL schema, applied verbatim from the repository's generated baseline.
 * This is the same DDL used for the documented PostgreSQL cutover, so the FK
 * under test is the shipped one.
 */
const BASELINE = path.resolve(__dirname, "..", "scripts/db/postgres-baseline.sql");

const FIXTURE = `
  DELETE FROM "QuizAnswer"   WHERE "attemptId" LIKE 'p26d-%';
  DELETE FROM "QuizAttempt"  WHERE "id"        LIKE 'p26d-%';
  DELETE FROM "Question"     WHERE "id"        LIKE 'p26d-%';
  DELETE FROM "Quiz"         WHERE "id"        LIKE 'p26d-%';
  DELETE FROM "Lesson"       WHERE "id"        LIKE 'p26d-%';
  DELETE FROM "Student"      WHERE "id"        LIKE 'p26d-%';
  DELETE FROM "User"         WHERE "id"        LIKE 'p26d-%';

  INSERT INTO "User"    ("id","email","password","name","updatedAt")
    VALUES ('p26d-user-1','p26d-student@example.test','x','P26D Student', now());
  -- Phase K3 made Student.academicLevel / Lesson.academicLevel NOT NULL with
  -- no default (a level is never inferred). The fixture states the level the
  -- historical Phase 26D rows always were: Second Secondary. Schema
  -- conformance only — the concurrency proof below is unchanged.
  INSERT INTO "Student" ("id","userId","academicLevel","updatedAt")
    VALUES ('${STUDENT}','p26d-user-1','SECOND_SECONDARY', now());
  INSERT INTO "Lesson"  ("id","academicLevel","title","titleAr","order","updatedAt")
    VALUES ('p26d-lesson-1','SECOND_SECONDARY','P26D Lesson','درس',1, now());
  INSERT INTO "Quiz"    ("id","lessonId","title","titleAr","quizMode","maxAttempts")
    VALUES ('${QUIZ}','p26d-lesson-1','P26D Quiz','اختبار','FIXED',1);
  INSERT INTO "Question"("id","quizId","prompt","options","answer","difficulty","marks")
    VALUES ('${QID}','${QUIZ}','p','["a","b"]','a','MEDIUM',1);
`;

async function resetFixture(pool) {
  await pool.query(FIXTURE);
}

/**
 * The frozen row set a real attempt start writes, mirroring
 * `seedAttemptQuestions` in src/lib/session-quiz.ts (snapshot columns included).
 *
 * These are TWO separate parameterized statements on purpose: node-postgres
 * rejects multiple commands in a single prepared statement with
 * `42601 cannot insert multiple commands into a prepared statement`. Combining
 * them silently failed the whole freeze before it wrote anything.
 */
const SQL_INSERT_ATTEMPT = `
  INSERT INTO "QuizAttempt"
    ("id","quizId","studentId","attemptNumber","status","startedAt","cameraStatus")
  VALUES ($1,$2,$3,1,'OPEN', now(),'NOT_REQUESTED')
`;

const SQL_INSERT_ANSWER = `
  INSERT INTO "QuizAnswer"
    ("id","attemptId","questionId","selected","isCorrect","orderIndex",
     "questionType","promptSnapshot","optionsSnapshot","answerSnapshot","marksSnapshot")
  VALUES ('p26d-ans-1',$1,$2,'',FALSE,0,'MCQ','p','["a","b"]','a',1)
`;

const ATTEMPT_ID = "p26d-attempt-1";
const ANSWER_ID = "p26d-ans-1";

async function attemptCounts(pool) {
  const a = await pool.query(
    `SELECT COUNT(*)::int AS c FROM "QuizAttempt" WHERE "id" LIKE 'p26d-%'`
  );
  const ans = await pool.query(
    `SELECT COUNT(*)::int AS c FROM "QuizAnswer" WHERE "attemptId" LIKE 'p26d-%'`
  );
  const q = await pool.query(`SELECT COUNT(*)::int AS c FROM "Question" WHERE "id" LIKE 'p26d-%'`);
  return { attempts: a.rows[0].c, answers: ans.rows[0].c, questions: q.rows[0].c };
}

/**
 * One side of the race. `role` is either the attempt start or the destructive
 * delete. Both honour the shared advisory lock when `useLock` is set.
 *
 * `deleteScope` selects which shipped delete path is modelled:
 *   "question" — DELETE /api/teacher/questions/[id]  (1-level cascade)
 *   "quiz"     — DELETE /api/teacher/quizzes/[id]    (2-level cascade)
 */
async function runSide(pool, { role, useLock, deleteScope }) {
  const client = await pool.connect();
  const res = { role, status: null, error: null, refsSeen: null };
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");

    // The lock contract: FIRST statement, before any read or write.
    if (useLock) {
      await client.query("SELECT pg_advisory_xact_lock($1)", [String(lockId(QUIZ))]);
    }

    if (role === "delete") {
      // Mirrors loadQuestionReferences / the attempt count in the delete routes.
      const refs =
        deleteScope === "quiz"
          ? await client.query(
              `SELECT COUNT(*)::int AS c FROM "QuizAttempt" WHERE "quizId" = $1`,
              [QUIZ]
            )
          : await client.query(
              `SELECT COUNT(*)::int AS c FROM "QuizAnswer" WHERE "questionId" = $1`,
              [QID]
            );
      res.refsSeen = refs.rows[0].c;

      if (res.refsSeen === 0) {
        if (deleteScope === "quiz") {
          await client.query(`DELETE FROM "Quiz" WHERE "id" = $1`, [QUIZ]);
        } else {
          await client.query(`DELETE FROM "Question" WHERE "id" = $1`, [QID]);
        }
        res.status = "DELETED";
      } else {
        // The route returns 409 and touches nothing.
        res.status = "REFUSED_409";
      }
      await client.query("COMMIT");
    } else {
      await client.query(SQL_INSERT_ATTEMPT, [ATTEMPT_ID, QUIZ, STUDENT]);
      await client.query(SQL_INSERT_ANSWER, [ATTEMPT_ID, QID]);
      await client.query("COMMIT");
      res.status = "COMMITTED";
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    res.status = "FAILED";
    res.error = e.code || e.message;
  } finally {
    client.release();
  }
  return res;
}

const STAGGER_MS = Number(process.env.PHASE26D_PG_STAGGER_MS || 25);

/**
 * Drive both sides concurrently. The advisory lock — not a test-side barrier —
 * decides who goes first, which is the whole point. `winnerHint` only controls
 * WHICH side is launched first so that each of the two safe outcomes is
 * exercised deterministically; it never grants, bypasses or fakes a lock.
 *
 * The intended winner must be launched first: `runSide` awaits the advisory
 * lock as its first statement, so whichever task is created first reaches the
 * lock first and the other queues behind it.
 */
async function race(pool, { useLock, deleteScope, winnerHint }) {
  await resetFixture(pool);
  const launch = (role) => runSide(pool, { role, useLock, deleteScope });

  const startFirst = winnerHint === "start";
  const first = startFirst ? launch("start") : launch("delete");
  await sleep(STAGGER_MS);
  const second = startFirst ? launch("delete") : launch("start");

  const [a, b] = await Promise.all([first, second]);
  const start = startFirst ? a : b;
  const del = startFirst ? b : a;
  return { del, start, counts: await attemptCounts(pool) };
}

/**
 * CONTROL: force the exact dangerous interleaving with a barrier, deterministically.
 *
 *   delete: BEGIN, read references -> 0        [then WAIT]
 *   start : BEGIN, insert attempt + freeze, COMMIT
 *   delete: DELETE, COMMIT                      -> cascades the frozen row away
 *
 * This is only safe to barrier because NO advisory lock is taken — with the lock
 * enabled the same barrier would deadlock (the delete would hold the lock while
 * waiting for a start that is blocked on that very lock).
 */
async function controlRace(pool, { deleteScope }) {
  await resetFixture(pool);

  const delClient = await pool.connect();
  const startClient = await pool.connect();
  const del = { role: "delete", status: null, refsSeen: null, error: null };
  const start = { role: "start", status: null, error: null };

  let releaseDelete;
  let releaseStart;
  const deleteHasChecked = new Promise((r) => (releaseStart = r));
  const startHasFrozen = new Promise((r) => (releaseDelete = r));

  try {
    const deleteTask = (async () => {
      await delClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const refs =
        deleteScope === "quiz"
          ? await delClient.query(
              `SELECT COUNT(*)::int AS c FROM "QuizAttempt" WHERE "quizId" = $1`,
              [QUIZ]
            )
          : await delClient.query(
              `SELECT COUNT(*)::int AS c FROM "QuizAnswer" WHERE "questionId" = $1`,
              [QID]
            );
      del.refsSeen = refs.rows[0].c;
      releaseStart();                 // let the start slip into the gap
      await startHasFrozen;
      if (del.refsSeen === 0) {
        if (deleteScope === "quiz") {
          await delClient.query(`DELETE FROM "Quiz" WHERE "id" = $1`, [QUIZ]);
        } else {
          await delClient.query(`DELETE FROM "Question" WHERE "id" = $1`, [QID]);
        }
        del.status = "DELETED";
      } else {
        del.status = "REFUSED_409";
      }
      await delClient.query("COMMIT");
    })();

    const startTask = (async () => {
      await deleteHasChecked;         // wait for the stale reference read
      try {
        await startClient.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await startClient.query(SQL_INSERT_ATTEMPT, [ATTEMPT_ID, QUIZ, STUDENT]);
        await startClient.query(SQL_INSERT_ANSWER, [ATTEMPT_ID, QID]);
        await startClient.query("COMMIT");
        start.status = "COMMITTED";
      } catch (e) {
        await startClient.query("ROLLBACK").catch(() => {});
        start.status = "FAILED";
        start.error = e.code || e.message;
      }
      releaseDelete();
    })();

    await Promise.all([deleteTask, startTask]);
    return { del, start, counts: await attemptCounts(pool) };
  } finally {
    delClient.release();
    startClient.release();
  }
}

/**
 * The FORBIDDEN end state, stated once and used everywhere.
 *
 * "The attempt start succeeded, and its frozen history is not intact." That
 * covers both shipped delete scopes with one predicate:
 *   - question delete: the attempt row survives but its QuizAnswer was
 *     cascaded away (attempts > 0, answers === 0);
 *   - quiz delete: the two-level cascade takes the QuizAttempt too, so the
 *     tell is that the DELETE SUCCEEDED even though the start had already
 *     committed — the delete acted on a stale zero reference count.
 *
 * If the start never committed, it created no history, so nothing was lost.
 */
function forbidden(r) {
  if (r.start.status !== "COMMITTED") return false;
  return r.counts.answers === 0 || r.del.status === "DELETED";
}

function describe(r) {
  return (
    `delete=${r.del.status}(refs=${r.del.refsSeen}) ` +
    `start=${r.start.status}${r.start.error ? `(${r.start.error})` : ""} ` +
    `attempts=${r.counts.attempts} answers=${r.counts.answers} questions=${r.counts.questions}`
  );
}

async function main() {
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 6,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });

  console.log("\n== Phase 26D PostgreSQL concurrency proof ==");
  console.log(`  target: ${DATABASE_URL.replace(/:[^:@/]*@/, ":***@")}`);

  const ver = await pool.query("SHOW server_version");
  console.log(`  server: PostgreSQL ${ver.rows[0].server_version}`);
  const iso = await pool.query("SHOW default_transaction_isolation");
  console.log(`  default isolation: ${iso.rows[0].default_transaction_isolation}`);
  ok(ver.rows[0].server_version.length > 0, "connected to a real PostgreSQL");
  ok(
    iso.rows[0].default_transaction_isolation === "read committed",
    "the server default isolation is READ COMMITTED (the isolation the race needs)",
    iso.rows[0].default_transaction_isolation
  );

  // --- Apply the REAL schema ------------------------------------------------
  if (!fs.existsSync(BASELINE)) {
    console.error(`\nmissing baseline DDL: ${BASELINE}`);
    process.exit(1);
  }
  const ddl = fs.readFileSync(BASELINE, "utf8");
  console.log(`\n-- applying real schema: ${path.relative(process.cwd(), BASELINE)} --`);
  // Disposable CI database: drop and recreate public so a re-run is clean.
  await pool.query(`DROP SCHEMA IF EXISTS public CASCADE`);
  await pool.query(`CREATE SCHEMA public`);
  await pool.query(ddl);

  // Prove the shipped cascade is really present before relying on it.
  const fk = await pool.query(`
    SELECT con.conname, con.confdeltype
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'QuizAnswer' AND con.conname = 'QuizAnswer_questionId_fkey'
  `);
  ok(fk.rows.length === 1, "the shipped QuizAnswer_questionId_fkey exists in the real schema");
  ok(
    fk.rows[0] && fk.rows[0].confdeltype === "c",
    "QuizAnswer.questionId is ON DELETE CASCADE (confdeltype 'c')",
    fk.rows[0] ? `confdeltype=${fk.rows[0].confdeltype}` : "constraint missing"
  );

  crossCheckLockId();

  // ==========================================================================
  // 1. CONTROL — without the lock the race must reproduce.
  // ==========================================================================
  for (const deleteScope of ["question", "quiz"]) {
    console.log(`\n-- 1${deleteScope === "quiz" ? "b" : "a"}. CONTROL, ${deleteScope} delete, NO lock --`);
    const r = await controlRace(pool, { deleteScope });
    console.log(`  ${describe(r)}`);
    // The control MUST reproduce data loss, otherwise the "with lock" sections
    // below would be passing vacuously — nothing was ever at risk.
    ok(
      forbidden(r),
      `CONTROL (${deleteScope} delete): without the lock, a committed attempt loses its frozen history to the cascade`,
      describe(r)
    );
    ok(
      r.start.status === "COMMITTED" && r.del.status === "DELETED",
      `CONTROL (${deleteScope} delete): the delete acted on a stale zero reference count`,
      describe(r)
    );
  }

  // ==========================================================================
  // 2. WITH the lock — the forbidden end state must be impossible.
  // ==========================================================================
  for (const deleteScope of ["question", "quiz"]) {
    for (const winnerHint of ["delete", "start"]) {
      const label = `${deleteScope} delete / ${winnerHint} scheduled first`;
      console.log(`\n-- 2. WITH lock: ${label} --`);
      const r = await race(pool, { useLock: true, deleteScope, winnerHint });
      console.log(`  ${describe(r)}`);

      ok(!forbidden(r), `INVARIANT (${label}): no attempt whose frozen rows were destroyed`, describe(r));

      const outcomeA =
        r.del.status === "DELETED" && r.start.status === "FAILED";
      const outcomeB =
        r.del.status === "REFUSED_409" && r.counts.attempts > 0 && r.counts.answers > 0;
      ok(
        outcomeA || outcomeB,
        `exactly one safe outcome (${label}): delete won and the freeze failed, OR start won and the delete refused`,
        describe(r)
      );
      if (outcomeA) {
        console.log("  observed: DELETE won — the freeze could not reference the deleted question");
      } else {
        console.log("  observed: START won — the delete re-checked under the lock and refused");
      }
    }
  }

  // ==========================================================================
  // 3. STRESS — repeat concurrently; the forbidden state must never appear.
  // ==========================================================================
  {
    const ITERATIONS = Number(process.env.PHASE26D_PG_ITERATIONS || 20);
    console.log(`\n-- 3. stress: ${ITERATIONS} concurrent locked races (question delete) --`);
    let forbiddenHits = 0;
    let safeA = 0;
    let safeB = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const r = await race(pool, {
        useLock: true,
        deleteScope: "question",
        winnerHint: i % 2 === 0 ? "delete" : "start",
      });
      if (forbidden(r)) {
        forbiddenHits++;
        console.log(`  iteration ${i}: FORBIDDEN STATE ${describe(r)}`);
      } else if (r.del.status === "DELETED") safeA++;
      else safeB++;
    }
    ok(forbiddenHits === 0, `stress: the forbidden state never occurred in ${ITERATIONS} races`, `hits=${forbiddenHits}`);
    ok(
      safeA > 0 && safeB > 0,
      "stress: BOTH safe outcomes were observed (not just one path passing vacuously)",
      `deleteWon=${safeA} startWon=${safeB}`
    );
  }

  // ==========================================================================
  // 4. The lock contract itself.
  // ==========================================================================
  console.log("\n-- 4. lock contract --");
  const c1 = await pool.connect();
  const c2 = await pool.connect();
  try {
    await c1.query("BEGIN");
    await c1.query("SELECT pg_advisory_xact_lock($1)", [String(lockId(QUIZ))]);

    const got = await c2.query("SELECT pg_try_advisory_lock($1) AS acquired", [
      String(lockId(QUIZ)),
    ]);
    ok(
      got.rows[0].acquired === false,
      "a second session cannot acquire the same quiz lock while the first holds it"
    );

    const other = await c2.query("SELECT pg_try_advisory_lock($1) AS acquired", [
      String(lockId("p26d-quiz-B")),
    ]);
    ok(
      other.rows[0].acquired === true,
      "a different quiz does not contend (no accidental global serialization)"
    );
    await c2.query("SELECT pg_advisory_unlock($1)", [String(lockId("p26d-quiz-B"))]);

    // The attempt-start side and BOTH delete paths must use the SAME key, or
    // they would never contend. Assert the shipped call sites agree.
    const startSrc = fs.readFileSync(
      path.resolve(__dirname, "..", "src/app/api/quizzes/[id]/start/route.ts"),
      "utf8"
    );
    const qDelSrc = fs.readFileSync(
      path.resolve(__dirname, "..", "src/app/api/teacher/questions/[id]/route.ts"),
      "utf8"
    );
    const zDelSrc = fs.readFileSync(
      path.resolve(__dirname, "..", "src/app/api/teacher/quizzes/[id]/route.ts"),
      "utf8"
    );
    ok(
      /acquireQuizDestructiveLock\(tx, id\)/.test(startSrc) &&
        /acquireQuizDestructiveLock\(tx, id\)/.test(zDelSrc) &&
        /acquireQuizDestructiveLock\(tx, owned\.owner\.quiz\.id\)/.test(qDelSrc),
      "attempt start, question delete and quiz delete all key the SAME per-quiz lock"
    );
    ok(
      (startSrc.match(/acquireQuizDestructiveLock\(/g) || []).length === 2,
      "both start write paths (create and resume/freeze) take the lock",
      `found ${(startSrc.match(/acquireQuizDestructiveLock\(/g) || []).length}`
    );
    ok(
      /seedAttemptQuestions\(created\.id, id, schoolType, \{[\s\S]{0,200}?tx,/.test(startSrc),
      "the create-path freeze is written through the transaction, under the lock"
    );

    await c1.query("ROLLBACK");
    const after = await c2.query("SELECT pg_try_advisory_lock($1) AS acquired", [
      String(lockId(QUIZ)),
    ]);
    ok(
      after.rows[0].acquired === true,
      "the lock is transaction-scoped: released on ROLLBACK, never leaked past the transaction"
    );
    await c2.query("SELECT pg_advisory_unlock($1)", [String(lockId(QUIZ))]);
  } finally {
    c1.release();
    c2.release();
  }

  // --- cleanup --------------------------------------------------------------
  await pool.query(`DROP SCHEMA IF EXISTS public CASCADE`);
  await pool.end();

  console.log(`\nphase26d-concurrency-postgres: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("PHASE26D_CONCURRENCY_POSTGRES_OK");
}

main().catch((e) => {
  console.error(
    "\nphase26d-concurrency-postgres crashed:",
    e && e.stack ? e.stack : String(e)
  );
  process.exit(1);
});
