"use strict";

// CodeMind Academy — Windows-safe temp-dir cleanup for the compile-and-run
// test harnesses (the Phase K/L suites that compile the REAL routes and run
// them against a REAL SQLite database).
//
// THE PROBLEM THIS EXISTS FOR
//   Those harnesses create a temp dir, compile into it, and open a SQLite
//   database FILE inside it with `node:sqlite` `DatabaseSync`. On POSIX an
//   open file can still be unlinked, so a leaked handle is invisible: the
//   `fs.rmSync(OUT, { recursive: true, force: true })` at the end succeeds.
//   On Windows the open database file is a MANDATORY lock, so removing the
//   directory fails with `EPERM` — after every assertion has already passed —
//   and the harness reports a HARNESS ERROR and exits 1.
//
// THE ORDER THIS ENFORCES (handles first, filesystem second)
//   1. `releaseDatabase(handle)` closes every `DatabaseSync`. Closing is the
//      only thing that actually releases the lock; retrying the delete first
//      would just spin against a handle that is still open.
//   2. `releaseClient(client)` awaits `$disconnect()` on a Prisma-shaped
//      client. The SQLite lite shim's `$disconnect` is deliberately a no-op
//      today, but this is the contract and it costs nothing to honour.
//   3. `removeTempDir(dir)` deletes with bounded retries (`maxRetries` /
//      `retryDelay`, which Node applies to EBUSY / EMFILE / ENFILE /
//      ENOTEMPTY / EPERM) and then VERIFIES the directory is gone.
//
// NOTHING IS SWALLOWED
//   * A close/disconnect failure is RETHROWN with the handle name and errno.
//     The single tolerated case is `ERR_INVALID_STATE` ("database is not
//     open"), which IS the goal state — the handle was already released.
//   * If the directory still exists after the bounded retries,
//     `removeTempDir` throws with the path, the entries still present and the
//     last OS error. A cleanup that genuinely failed must fail the harness
//     loudly rather than leave a silent temp leak.

const fs = require("fs");

/** `DatabaseSync.close()` on an already-closed handle; that is success for us. */
const ALREADY_CLOSED = "ERR_INVALID_STATE";

/** Describe an error without assuming it is an Error instance. */
function describe(e) {
  if (!e) return "unknown failure";
  const code = e.code ? `${e.code}: ` : "";
  return `${code}${e.message || String(e)}`;
}

/**
 * Close one `node:sqlite` `DatabaseSync` handle.
 *
 * Returns `true` when this call closed it and `false` when it was already
 * closed (both mean "the file lock is released"). Any other failure throws.
 */
function releaseDatabase(handle, label = "DatabaseSync") {
  if (!handle || typeof handle.close !== "function") return false;
  try {
    handle.close();
  } catch (e) {
    if (e && e.code === ALREADY_CLOSED) return false;
    throw new Error(`[temp-dir-cleanup] could not close ${label}: ${describe(e)}`);
  }
  // The invariant Windows actually enforces: the file lock must be gone before
  // the directory is touched. `DatabaseSync.isOpen` is the observable form of
  // it, so assert it whenever the runtime exposes the property — a handle that
  // is somehow still open must fail HERE, with a message that names the cause,
  // instead of surfacing later as a mysterious EPERM from `fs.rmSync`.
  if (handle.isOpen === true) {
    throw new Error(
      `[temp-dir-cleanup] ${label} still reports isOpen after close() — the ` +
        "file lock is NOT released and the temp dir is not removable on Windows"
    );
  }
  return true;
}

/**
 * Await `client.$disconnect()` when the client has one (Prisma contract).
 * Returns `true` when a disconnect was performed, `false` when there was
 * nothing to disconnect. A failing disconnect throws.
 */
async function releaseClient(client, label = "Prisma-like client") {
  const disconnect = client && client.$disconnect;
  if (typeof disconnect !== "function") return false;
  try {
    await disconnect.call(client);
    return true;
  } catch (e) {
    throw new Error(
      `[temp-dir-cleanup] could not disconnect ${label}: ${describe(e)}`
    );
  }
}

/**
 * Remove a temp directory with bounded retry semantics, then verify.
 *
 * `maxRetries` / `retryDelay` are the standard `fs.rmSync` options: Node
 * retries the operation on EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM, which
 * is exactly the Windows "an indexer/AV still has the directory" window that
 * remains AFTER every handle the harness owns has been closed.
 *
 * A missing directory is not an error (force: true). A directory that is
 * still there afterwards IS an error and is raised with full context.
 */
function removeTempDir(dir, { maxRetries = 20, retryDelay = 100 } = {}) {
  let lastError = null;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries, retryDelay });
  } catch (e) {
    lastError = e;
  }

  if (fs.existsSync(dir)) {
    let remaining = [];
    try {
      remaining = fs.readdirSync(dir).slice(0, 10);
    } catch {
      /* the directory may itself be unreadable — the path is enough */
    }
    throw new Error(
      `[temp-dir-cleanup] ${dir} still exists after ${maxRetries} retries` +
        (remaining.length ? ` (entries: ${remaining.join(", ")})` : "") +
        (lastError ? `; last error: ${describe(lastError)}` : "")
    );
  }
}

/**
 * The teardown the harnesses call: release the handles, then remove the dir.
 *
 *   await cleanupTempDir(OUT, { databases: [d], clients: [global.__CM_DB__] });
 *
 * `databases` are closed in order, then `clients` are disconnected, and only
 * then is the directory removed. The first failure aborts teardown with its
 * own message (never a silent success).
 */
async function cleanupTempDir(
  dir,
  { databases = [], clients = [], maxRetries = 20, retryDelay = 100 } = {}
) {
  for (const [i, handle] of databases.entries()) {
    releaseDatabase(handle, `SQLite database #${i + 1}`);
  }
  for (const [i, client] of clients.entries()) {
    await releaseClient(client, `client #${i + 1}`);
  }
  removeTempDir(dir, { maxRetries, retryDelay });
}

module.exports = {
  releaseDatabase,
  releaseClient,
  removeTempDir,
  cleanupTempDir,
};
