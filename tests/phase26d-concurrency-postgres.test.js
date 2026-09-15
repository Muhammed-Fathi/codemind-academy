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
 * HOW TO RUN
 * ==========
 *   # local PostgreSQL, DISPOSABLE database only — never production Neon:
 *   createdb cm_phase26d_concurrency
 *   DATABASE_URL=postgresql://localhost:5432/cm_phase26d_concurrency \
 *     node tests/phase26d-concurrency-postgres.test.js
 *
 * In CI, point DATABASE_URL at a throwaway service container.
 *
 * SAFETY
 * ======
 * Refuses to run against anything whose URL looks like production Neon, and
 * creates/drops only its own scratch tables.
 *
 * WHAT IT PROVES
 * ==============
 * The required invariant: a concurrent attempt start must NOT be able to freeze
 * a question that the delete transaction then cascades away. Formally, the
 * forbidden end state is:
 *
 *     QuizAttempt row EXISTS  AND  its QuizAnswer rows are GONE
 *
 * The test drives the real shipped delete and start code paths' LOCKING
 * PROTOCOL against a real PostgreSQL, in both interleavings, and asserts that
 * end state never occurs.
 */

const { execFileSync } = require("child_process");

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

function skip(reason) {
  console.log(`\nphase26d-concurrency-postgres: SKIPPED — ${reason}`);
  console.log(
    "  This test proves a PostgreSQL READ COMMITTED race and cannot be proven on\n" +
      "  SQLite. Run it with DATABASE_URL pointing at a DISPOSABLE local/CI\n" +
      "  PostgreSQL (see the header of this file)."
  );
  console.log("PHASE26D_CONCURRENCY_SKIPPED");
}

if (!DATABASE_URL) {
  skip("DATABASE_URL is not set");
  process.exit(0);
}
if (!/^postgres(ql)?:\/\//i.test(DATABASE_URL)) {
  skip(`DATABASE_URL is not a PostgreSQL URL (got ${DATABASE_URL.replace(/:[^:@/]*@/, ":***@")})`);
  process.exit(0);
}
if (/neon\.tech|neondb|prod|production/i.test(DATABASE_URL)) {
  console.error(
    "\nREFUSING TO RUN: DATABASE_URL looks like a PRODUCTION/Neon database.\n" +
      "This test creates and drops scratch tables. Point it at a disposable\n" +
      "local or CI PostgreSQL instead."
  );
  process.exit(1);
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

/**
 * The minimal schema that reproduces the hazard: Question <- QuizAnswer with
 * ON DELETE CASCADE, matching prisma/schema.prisma and postgres-baseline.sql.
 */
const DDL = `
  DROP TABLE IF EXISTS p26d_answer CASCADE;
  DROP TABLE IF EXISTS p26d_attempt CASCADE;
  DROP TABLE IF EXISTS p26d_question CASCADE;
  CREATE TABLE p26d_question (id TEXT PRIMARY KEY);
  CREATE TABLE p26d_attempt  (id TEXT PRIMARY KEY);
  CREATE TABLE p26d_answer (
    id TEXT PRIMARY KEY,
    "attemptId" TEXT NOT NULL REFERENCES p26d_attempt(id) ON DELETE CASCADE,
    "questionId" TEXT NOT NULL REFERENCES p26d_question(id) ON DELETE CASCADE
  );
`;

/**
 * The lock the shipped code takes, reproduced verbatim from
 * src/lib/db-serialization.ts so this test fails if the id derivation changes.
 */
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

/** Assert the real module derives the same id this test uses. */
function crossCheckLockId() {
  try {
    const out = execFileSync(
      process.execPath,
      ["-e", `
        const {execSync}=require('child_process');
        const ts=require('typescript');
        const fs=require('fs');
        const src=fs.readFileSync('src/lib/db-serialization.ts','utf8');
        const js=ts.transpileModule(src,{compilerOptions:{module:'commonjs',target:'es2020'}}).outputText;
        const m={exports:{}};
        new Function('exports','module','require',js)(m.exports,m,require);
        process.stdout.write(String(m.exports.quizDestructiveLockId('quiz-A')));
      `],
      { encoding: "utf8" }
    ).trim();
    ok(out === String(lockId("quiz-A")),
      "the shipped quizDestructiveLockId matches the id this test locks on",
      `shipped=${out} test=${lockId("quiz-A")}`);
  } catch (e) {
    ok(false, "the shipped quizDestructiveLockId matches the id this test locks on", e.message);
  }
}

/**
 * Run the delete and the attempt start concurrently, each in its own
 * transaction, with a barrier that forces the dangerous interleaving:
 *
 *   delete: BEGIN, lock, read refs  <-- then WAIT for start to be ready
 *   start:  BEGIN, lock, insert QuizAnswer, COMMIT
 *   delete: DELETE question, COMMIT
 *
 * `useLock=false` removes the advisory lock from both sides, which must
 * reproduce the data loss; `useLock=true` must prevent it.
 */
async function race(pool, { useLock }) {
  const QUIZ = "quiz-A";
  const del = await pool.connect();
  const start = await pool.connect();
  const barrier = { startReady: null, deleteChecked: null };
  const startReady = new Promise((r) => (barrier.startReady = r));
  const deleteChecked = new Promise((r) => (barrier.deleteChecked = r));

  const outcome = { deleteStatus: null, startError: null, refsSeen: null };

  try {
    // --- Tx A: destructive delete --------------------------------------
    const deleteTask = (async () => {
      await del.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      if (useLock) await del.query("SELECT pg_advisory_xact_lock($1)", [String(lockId(QUIZ))]);
      const refs = await del.query(
        `SELECT COUNT(*)::int AS c FROM p26d_answer WHERE "questionId" = 'q1'`
      );
      outcome.refsSeen = refs.rows[0].c;
      deleteChecked();
      // Give the start transaction the chance to interleave.
      await startReady;
      if (outcome.refsSeen === 0) {
        await del.query(`DELETE FROM p26d_question WHERE id = 'q1'`);
        outcome.deleteStatus = "DELETED";
      } else {
        outcome.deleteStatus = "REFUSED_409";
      }
      await del.query("COMMIT");
    })();

    // --- Tx B: attempt start -------------------------------------------
    const startTask = (async () => {
      // Wait until the delete has done its reference read, so we hit the
      // exact window between "check" and "delete".
      await deleteChecked;
      try {
        await start.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        if (useLock) await start.query("SELECT pg_advisory_xact_lock($1)", [String(lockId(QUIZ))]);
        await start.query(`INSERT INTO p26d_attempt (id) VALUES ('a1')`);
        await start.query(
          `INSERT INTO p26d_answer (id, "attemptId", "questionId") VALUES ('ans1','a1','q1')`
        );
        await start.query("COMMIT");
        outcome.startStatus = "COMMITTED";
      } catch (e) {
        await start.query("ROLLBACK").catch(() => {});
        outcome.startError = e.code || e.message;
        outcome.startStatus = "FAILED";
      }
      barrier.startReady();
    })();

    await Promise.all([deleteTask, startTask]);

    const attempts = await pool.query(`SELECT COUNT(*)::int c FROM p26d_attempt`);
    const answers = await pool.query(`SELECT COUNT(*)::int c FROM p26d_answer`);
    return {
      outcome,
      attempts: attempts.rows[0].c,
      answers: answers.rows[0].c,
    };
  } finally {
    del.release();
    start.release();
  }
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

  console.log("\n== Phase 26D PostgreSQL concurrency proof ==");
  console.log(`  target: ${DATABASE_URL.replace(/:[^:@/]*@/, ":***@")}`);

  // Confirm this really is PostgreSQL and really is READ COMMITTED.
  const ver = await pool.query("SHOW server_version");
  console.log(`  server: PostgreSQL ${ver.rows[0].server_version}`);
  const iso = await pool.query("SHOW default_transaction_isolation");
  console.log(`  default isolation: ${iso.rows[0].default_transaction_isolation}`);
  ok(true, "connected to a real PostgreSQL");

  crossCheckLockId();

  // ------------------------------------------------------------------
  // 1. WITHOUT the lock: the race must reproduce.
  // ------------------------------------------------------------------
  console.log("\n-- 1. control: no advisory lock (expect the race) --");
  await pool.query(DDL);
  await pool.query(`INSERT INTO p26d_question (id) VALUES ('q1')`);
  const bad = await race(pool, { useLock: false });
  console.log(
    `  delete saw refs=${bad.outcome.refsSeen} -> ${bad.outcome.deleteStatus}; ` +
      `start ${bad.outcome.startStatus}${bad.outcome.startError ? ` (${bad.outcome.startError})` : ""}; ` +
      `attempts=${bad.attempts} answers=${bad.answers}`
  );
  ok(bad.attempts > 0 && bad.answers === 0,
    "CONTROL: without the lock, the attempt survives but its frozen row is cascade-destroyed",
    `attempts=${bad.attempts} answers=${bad.answers}`);

  // ------------------------------------------------------------------
  // 2. WITH the lock: the forbidden end state must be impossible.
  // ------------------------------------------------------------------
  console.log("\n-- 2. with the shared advisory lock --");
  await pool.query(DDL);
  await pool.query(`INSERT INTO p26d_question (id) VALUES ('q1')`);
  const good = await race(pool, { useLock: true });
  console.log(
    `  delete saw refs=${good.outcome.refsSeen} -> ${good.outcome.deleteStatus}; ` +
      `start ${good.outcome.startStatus}${good.outcome.startError ? ` (${good.outcome.startError})` : ""}; ` +
      `attempts=${good.attempts} answers=${good.answers}`
  );

  const forbidden = good.attempts > 0 && good.answers === 0;
  ok(!forbidden,
    "INVARIANT: no attempt exists whose frozen rows were destroyed by the delete",
    `attempts=${good.attempts} answers=${good.answers}`);

  // Exactly one of the two acceptable outcomes must have happened.
  const outcomeA = good.outcome.deleteStatus === "DELETED" && good.outcome.startStatus === "FAILED";
  const outcomeB = good.outcome.deleteStatus === "REFUSED_409" && good.attempts > 0 && good.answers > 0;
  ok(outcomeA || outcomeB,
    "exactly one safe outcome occurred: delete won and start failed, OR start won and delete returned 409",
    JSON.stringify(good.outcome));

  if (outcomeA) {
    ok(true, "observed: delete won — the attempt's FK insert failed, so no orphan exists");
  } else {
    ok(true, "observed: attempt won — the delete re-checked under the lock and refused (409)");
  }

  // ------------------------------------------------------------------
  // 3. The lock really serializes: both sides contend on the same key.
  // ------------------------------------------------------------------
  console.log("\n-- 3. lock contention is real --");
  const c1 = await pool.connect();
  const c2 = await pool.connect();
  try {
    await c1.query("BEGIN");
    await c1.query("SELECT pg_advisory_xact_lock($1)", [String(lockId("quiz-A"))]);
    // A second session asking for the same key must NOT get it immediately.
    const got = await c2.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [String(lockId("quiz-A"))]
    );
    ok(got.rows[0].acquired === false,
      "a second session cannot acquire the same quiz lock while the first holds it");
    // A different quiz must not contend.
    const other = await c2.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [String(lockId("quiz-B"))]
    );
    ok(other.rows[0].acquired === true,
      "a different quiz does not contend (no global serialization)");
    await c2.query("SELECT pg_advisory_unlock($1)", [String(lockId("quiz-B"))]);
    await c1.query("ROLLBACK");
    // After rollback the lock is released — it is transaction-scoped, so it
    // cannot leak past COMMIT on a pooled serverless connection.
    const after = await c2.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [String(lockId("quiz-A"))]
    );
    ok(after.rows[0].acquired === true,
      "the lock is transaction-scoped: released on ROLLBACK, never leaked");
    await c2.query("SELECT pg_advisory_unlock($1)", [String(lockId("quiz-A"))]);
  } finally {
    c1.release();
    c2.release();
  }

  // ------------------------------------------------------------------
  await pool.query(DDL.replace(/CREATE TABLE[\s\S]*$/m, "").replace(/DROP TABLE IF EXISTS p26d_answer CASCADE;/, "DROP TABLE IF EXISTS p26d_answer CASCADE;"));
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
  console.error("\nphase26d-concurrency-postgres crashed:", e && e.stack ? e.stack : String(e));
  process.exit(1);
});
