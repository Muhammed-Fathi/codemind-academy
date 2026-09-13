// CodeMind Academy — database-level serialization for finalization (Phase 23).
//
// WHY THIS EXISTS
// ===============
// Two concurrent completions of the same upload intent (same exact storage
// key) must not both finalize. The authoritative serialization point is the
// DATABASE, never the process: on serverless/multi-instance deployments
// (e.g. Vercel) two requests routinely land on different isolates, so any
// in-memory lock or mutex is non-authoritative by construction.
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
// prisma/schema.postgresql.prisma = postgresql).

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
 * Deterministic 63-bit FNV-1a of the exact storage key — the advisory lock
 * id. 63 bits (not 64) keeps the value inside PostgreSQL's signed bigint.
 * Same key ⇒ same lock; different keys ⇒ (effectively) different locks, so
 * unrelated uploads never serialize against each other.
 */
const FNV_OFFSET_BASIS = BigInt("0xcbf29ce484222325");
const FNV_PRIME = BigInt("0x100000001b3");
const MASK_64 = BigInt("0xffffffffffffffff");
const MASK_63 = BigInt("0x7fffffffffffffff");

export function uploadFinalizeLockId(storageKey: string): bigint {
  let h = FNV_OFFSET_BASIS;
  for (const byte of Buffer.from(storageKey, "utf8")) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK_64;
  }
  return h & MASK_63;
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
  const id = uploadFinalizeLockId(storageKey);
  // Real tagged-template call — Prisma's $executeRaw receives the template
  // parts plus the BigInt id (bound as int8), parameterized, never stringified.
  await (tx as TxWithRaw).$executeRaw`SELECT pg_advisory_xact_lock(${id})`;
}
