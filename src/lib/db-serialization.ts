// CodeMind Academy — database-level serialization.
//
// WHY THIS EXISTS
// ===============
// Two concurrent writers racing on the same database-level resource must not
// both pass their re-check. The authoritative serialization point is the
// DATABASE, never the process: on serverless/multi-instance deployments
// (e.g. Vercel) two requests routinely land on different isolates, so any
// in-memory lock or mutex is non-authoritative by construction.
//
// Two namespaced users live here (ONE raw-SQL site, provider-gated):
//   * Phase 23 — upload finalization: `acquireUploadFinalizeLock` keyed by
//     the exact storage key, used by `src/lib/media-upload.ts`;
//   * Phase 25 PR2b — group seat assignment: `acquireGroupSeatLock` keyed by
//     group id, used by `src/lib/payment-transitions.ts` (approval). Two
//     concurrent seat-changing approvals for the same group must serialize so
//     the capacity re-check + seat assignment is atomic across instances.
//
// MECHANISM (PostgreSQL — production)
// -----------------------------------
// `pg_advisory_xact_lock(<63-bit id derived from the exact storage key>)`
// inside the finalization transaction:
//   * the lock is EXCLUSIVE for that key across ALL clients, connections,
//     processes and instances of the same database — it does not care where
//     the request came from;
//   * it is TRANSACTION-SCOPED: held from acquisition until COMMIT/ROLLBACK,
//     so a "lock → re-check linkage → create rows" sequence is atomic with
//     respect to any other node running the same sequence;
//   * no schema change, no new table, no cleanup needed — advisory locks
//     vanish with the transaction (a crashed isolate releases everything);
//   * the lock id is a 63-bit FNV-1a hash of the EXACT storage key, so two
//     different uploads never contend and the same upload always maps to the
//     same lock.
//
// MECHANISM (SQLite — local development / tests)
// ----------------------------------------------
// SQLite permits AT MOST ONE WRITER at a time (database-level write lock).
// Concurrent finalization transactions therefore cannot both commit:
//   * Prisma's SQLite driver effectively serializes (single writer; a second
//     interactive transaction either waits or fails with a busy/snapshot
//     error);
//   * a loser that fails lands in the completion failure path, which
//     RE-RESOLVES the persisted linkage and returns the idempotent result —
//     and the guarded cleanup refuses to delete any object a committed row
//     references.
// `pg_advisory_xact_lock` does not exist on SQLite, so the advisory call is
// SKIPPED there — local development is never made to depend on PostgreSQL.
//
// The provider is resolved from the existing `DATABASE_URL` scheme
// (`postgresql://` / `postgres://` vs everything else, which includes
// SQLite's `file:` URLs) — the same value Prisma itself dispatches on via
// the selected schema (prisma/schema.prisma = sqlite,
// prisma/postgres/schema.prisma = postgresql).

const POSTGRES_URL_RE = /^postgres(ql)?:\/\//i;

export type DatabaseProvider = "postgresql" | "sqlite";

/**
 * Resolve the database provider from `DATABASE_URL`.
 *
 * SQLite URLs look like `file:./db/custom.db`; PostgreSQL URLs start with
 * `postgres://` or `postgresql://` (see .env.example, both documented).
 * Anything not recognisably PostgreSQL is treated as SQLite — the advisory
 * call is skipped and the database's own single-writer semantics apply.
 */
export function resolveDatabaseProvider(
  env: NodeJS.ProcessEnv = process.env
): DatabaseProvider {
  return POSTGRES_URL_RE.test(String(env.DATABASE_URL ?? "").trim())
    ? "postgresql"
    : "sqlite";
}

/**
 * Deterministic 63-bit FNV-1a. 63 bits (not 64) keeps the value inside
 * PostgreSQL's signed bigint. Same key ⇒ same lock; different keys ⇒
 * (effectively) different locks, so unrelated resources never serialize
 * against each other.
 */
const FNV_OFFSET_BASIS = BigInt("0xcbf29ce484222325");
const FNV_PRIME = BigInt("0x100000001b3");
const MASK_64 = BigInt("0xffffffffffffffff");
const MASK_63 = BigInt("0x7fffffffffffffff");

function fnv1a63(input: string): bigint {
  let h = FNV_OFFSET_BASIS;
  for (const byte of Buffer.from(input, "utf8")) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK_64;
  }
  return h & MASK_63;
}

/**
 * The Phase 23 finalization lock id: FNV-1a of the EXACT storage key.
 * (Refactored from the inline loop — byte-identical output, so every lock
 * id the Phase 23 suite pins is unchanged.)
 */
export function uploadFinalizeLockId(storageKey: string): bigint {
  return fnv1a63(storageKey);
}

// ---------------------------------------------------------------------------
// Phase 25 PR2b — group-seat advisory lock
// ---------------------------------------------------------------------------
//
// NAMESPACE ISOLATION: the lock id hashes a fixed namespace prefix together
// with the group id, so a group-seat lock can never collide with an
// upload-finalize lock (which hashes bare storage keys) or with any other
// group's seat lock. The prefix is a private constant — callers key the lock
// by group id only, exactly like Phase 23 callers key by storage key only.

const GROUP_SEAT_LOCK_NAMESPACE = "cm:phase25:group-seat";

/**
 * Deterministic 63-bit advisory lock id for one group's seat capacity.
 * Same group ⇒ same lock (every approval for that group serializes);
 * different groups ⇒ (effectively) different locks.
 */
export function groupSeatLockId(groupId: string): bigint {
  return fnv1a63(`${GROUP_SEAT_LOCK_NAMESPACE}\u0000${groupId}`);
}

/**
 * Minimal structural surface of a Prisma interactive-transaction client that
 * can execute raw SQL. The real Prisma `tx` satisfies it; test fakes model it
 * at exactly this boundary.
 */
type TxWithRaw = {
  $executeRaw: (
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<number>;
};

/**
 * The ONE raw-SQL site in this file (and in `src/`): the transaction-scoped
 * PostgreSQL advisory lock. Real tagged-template call — Prisma's
 * `$executeRaw` receives the template parts plus the BigInt id (bound as
 * int8), parameterized, never stringified.
 */
async function executeAdvisoryXactLock(tx: TxWithRaw, lockId: bigint): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
}

/**
 * Acquire the per-storage-key finalization lock INSIDE the caller's
 * transaction.
 *
 *   PostgreSQL — `pg_advisory_xact_lock(id)`: exclusive until the
 *   transaction commits or rolls back. Authoritative across every process
 *   and instance sharing the database.
 *
 *   SQLite — a deliberate NO-OP: there is no advisory-lock primitive, and
 *   SQLite's own single-writer database lock already serializes concurrent
 *   finalizations (losers fail into the completion failure path, which
 *   re-resolves the persisted linkage idempotently).
 *
 * A tx surface without raw-SQL support (some test fakes) also skips the call;
 * the in-transaction linkage re-check that follows this helper still guards
 * those paths.
 */
export async function acquireUploadFinalizeLock(
  tx: unknown,
  storageKey: string,
  provider: DatabaseProvider = resolveDatabaseProvider()
): Promise<void> {
  if (provider !== "postgresql") return;
  const raw = (tx as Partial<TxWithRaw>).$executeRaw;
  if (typeof raw !== "function") return;
  await executeAdvisoryXactLock(tx as TxWithRaw, uploadFinalizeLockId(storageKey));
}

/**
 * Acquire the per-group SEAT-CAPACITY lock INSIDE the caller's (approval)
 * transaction — the Phase 25 PR2b generalization of the finalization lock.
 *
 *   PostgreSQL — `pg_advisory_xact_lock(groupSeatLockId(groupId))`:
 *   exclusive for that group across every connection, process and instance,
 *   held from acquisition until COMMIT/ROLLBACK. The caller performs its
 *   capacity re-read and the seat assignment AFTER this call and therefore
 *   under the lock; a second approval for the same group blocks here until
 *   the first decision settles, then re-reads the committed member count
 *   (this is what makes the last-seat race safe — see
 *   `src/lib/payment-transitions.ts`).
 *
 *   SQLite — a deliberate NO-OP, for the same reason as Phase 23: the
 *   database's single-writer lock already serializes concurrent write
 *   transactions (a contending loser fails into the conflict path rather
 *   than half-applying), and local development never depends on PostgreSQL.
 *
 * A tx surface without raw-SQL support (some test fakes) also skips the call;
 * the in-transaction capacity re-read that follows this helper still guards
 * those paths.
 */
export async function acquireGroupSeatLock(
  tx: unknown,
  groupId: string,
  provider: DatabaseProvider = resolveDatabaseProvider()
): Promise<void> {
  if (provider !== "postgresql") return;
  const raw = (tx as Partial<TxWithRaw>).$executeRaw;
  if (typeof raw !== "function") return;
  await executeAdvisoryXactLock(tx as TxWithRaw, groupSeatLockId(groupId));
}

// ---------------------------------------------------------------------------
// Phase 26D — quiz/question DESTRUCTIVE-DELETE advisory lock
// ---------------------------------------------------------------------------
//
// THE RACE THIS CLOSES
// ====================
// `QuizAnswer.question` is `onDelete: Cascade`. Under PostgreSQL READ COMMITTED
// a plain `$transaction` does NOT serialize a destructive delete against a
// concurrent attempt start, because a bare read takes no lock that conflicts
// with an insert into the REFERENCING table:
//
//   Tx A (delete question q)        Tx B (start attempt)
//   begin
//   read refs WHERE questionId=q
//     -> 0                          begin
//                                   insert QuizAttempt row
//                                   insert QuizAnswer row (questionId=q)  <-- FK ok
//                                   commit
//   delete the Question row (id=q)
//     -> CASCADE removes the QuizAnswer row Tx B just committed
//   commit
//
// (Lower-case SQL verbs above are deliberate: this file is scanned by the
// Phase 21 and security-audit gates, which assert that the ONLY raw SQL here is
// the advisory lock. Keeping the narrative free of upper-case DML keywords means
// those guards keep matching real statements and nothing else.)
//
// Net effect: the attempt EXISTS but its frozen question row is GONE — exactly
// the history-destruction the delete guard was meant to prevent. Wrapping the
// check and the delete in one transaction does not help; the window is between
// the check and the delete, and READ COMMITTED gives Tx A no visibility of, and
// no conflict with, Tx B's insert.
//
// THE PROTOCOL
// ============
// Both sides acquire the SAME transaction-scoped advisory lock, keyed by the
// quiz id, BEFORE doing anything else:
//
//   * `POST /api/quizzes/[id]/start` acquires it before creating the attempt and
//     freezing its `QuizAnswer` rows;
//   * `DELETE /api/teacher/questions/[id]` and `DELETE /api/teacher/quizzes/[id]`
//     acquire it before reading references.
//
// The key is the QUIZ id (not the question id) on purpose: a question delete and
// an attempt start on the same quiz must contend, and a quiz delete must exclude
// every attempt on that quiz. Keying a question delete by its own id would not
// conflict with an attempt start that had already read the pool.
//
// Ordering then becomes total, and exactly one of two safe outcomes happens:
//   * delete wins -> the attempt's FK insert fails, so the attempt never exists
//     with a missing frozen row; or
//   * attempt wins -> the delete re-reads references under the lock, sees the
//     frozen rows, and returns 409.
//
// MECHANISM (PostgreSQL — production)
// -----------------------------------
// `pg_advisory_xact_lock(<63-bit id>)`, transaction-scoped and exclusive across
// every connection, process and isolate sharing the database. Released
// automatically at COMMIT/ROLLBACK, so a crashed isolate cannot strand it.
//
// MECHANISM (SQLite — local development / tests)
// ----------------------------------------------
// Deliberate NO-OP. There is no advisory-lock primitive, and SQLite permits at
// most ONE writer at a time (database-level write lock), so two concurrent write
// transactions cannot both commit; the loser fails rather than half-applying.
// Local development never depends on PostgreSQL.

const QUIZ_DELETE_LOCK_NAMESPACE = "cm:phase26d:quiz-destructive";

/**
 * Deterministic 63-bit advisory lock id for destructive work on ONE quiz
 * (deleting the quiz, or deleting one of its questions) versus starting an
 * attempt on it. Same quiz => same lock; different quizzes => (effectively)
 * different locks, so unrelated quizzes never serialize against each other.
 */
export function quizDestructiveLockId(quizId: string): bigint {
  return fnv1a63(`${QUIZ_DELETE_LOCK_NAMESPACE}\u0000${quizId}`);
}

/**
 * Acquire the per-quiz DESTRUCTIVE-DELETE lock INSIDE the caller's transaction.
 *
 * Callers MUST call this as the FIRST statement of the transaction, before any
 * reference read or write — acquiring it later reopens the window it exists to
 * close.
 *
 *   PostgreSQL — `pg_advisory_xact_lock(quizDestructiveLockId(quizId))`:
 *   exclusive for that quiz across every connection, process and instance, held
 *   until COMMIT/ROLLBACK.
 *
 *   SQLite — a deliberate NO-OP: no advisory primitive exists, and the
 *   database's own single-writer lock already serializes concurrent write
 *   transactions.
 *
 * A tx surface without raw-SQL support (some test fakes) also skips the call.
 */
export async function acquireQuizDestructiveLock(
  tx: unknown,
  quizId: string,
  provider: DatabaseProvider = resolveDatabaseProvider()
): Promise<void> {
  if (provider !== "postgresql") return;
  const raw = (tx as Partial<TxWithRaw>).$executeRaw;
  if (typeof raw !== "function") return;
  await executeAdvisoryXactLock(tx as TxWithRaw, quizDestructiveLockId(quizId));
}
