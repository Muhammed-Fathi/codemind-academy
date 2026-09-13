// CodeMind Academy — Phase 24: shared-core behavioural harness (OFFLINE).
//
// Run by tests/vercel-cron-retention-phase24.test.js as a child process:
//
//   npx tsx tests/helpers/core-direct-harness.mts \
//     <dbLocal> <dbDry> <dbMoved> <dbS3> <mediaRoot> <localFile> <keepFile> <dryFile> <nowIso>
//
// Drives the SHIPPED runEvidencePurge() (src/lib/evidence-retention.ts) over
// scratch SQLite databases and a scratch LOCAL_PRIVATE volume, with the R2_*
// variables explicitly cleared so the S3 path can only fail closed.
// Prints one `HARNESS_JSON {...}` line.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

// Fail closed on the S3 path: no credential or configuration ever set.
for (const v of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_REGION", "R2_S3_ENDPOINT"]) {
  delete process.env[v];
}

const [dbLocal, dbDry, dbMoved, dbS3, mediaRoot, localFile, keepFile, dryFile, nowIso] = process.argv.slice(2);
if (!dbLocal || !dbDry || !dbMoved || !dbS3 || !mediaRoot || !localFile || !keepFile || !dryFile || !nowIso) {
  console.error("usage: core-direct-harness.mts <dbLocal> <dbDry> <dbMoved> <dbS3> <mediaRoot> <localFile> <keepFile> <dryFile> <nowIso>");
  process.exit(1);
}
// The LOCAL_PRIVATE volume root is captured at media.ts module load.
process.env.MEDIA_STORAGE_PATH = mediaRoot;

const { runEvidencePurge } = await import("../../src/lib/evidence-retention.ts");

function sqliteBackend(file: string, readOnly: boolean, injectProtectedMove: boolean) {
  const db = new DatabaseSync(file, { readOnly });
  return {
    dialect: "sqlite" as const,
    all: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
    run: async (sql: string, params: unknown[] = []) => {
      const changes = Number(db.prepare(sql).run(...(params as never[])).changes);
      if (injectProtectedMove && /^DELETE FROM "QuizAttemptEvidence"/.test(sql)) {
        // Simulate an external writer touching a protected table mid-run:
        // the run must detect it and report ok=false.
        db.exec("INSERT INTO \"SecurityEvent\" VALUES ('intruder-1')");
      }
      return changes;
    },
    begin: async () => {
      db.exec("BEGIN");
    },
    commit: async () => {
      db.exec("COMMIT");
    },
    rollback: async () => {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already failed */
      }
    },
  };
}
const now = new Date(nowIso);
const count = (file: string, table: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n);
  } finally {
    db.close();
  }
};

// 7a. LOCAL: expired-only targeting + reference-safe detach + verified delete.
const r1 = await runEvidencePurge({ backend: sqliteBackend(dbLocal, false, false), now });
// 7b. Dry run: SELECTs only, nothing written.
const r2 = await runEvidencePurge({ backend: sqliteBackend(dbDry, true, false), now, dryRun: true });
// 7c. Protected table moves mid-run → the report flips to ok=false.
const r3 = await runEvidencePurge({ backend: sqliteBackend(dbMoved, false, true), now });
// 7d. S3 object with no R2 configuration: recorded failure, fail closed.
const r4 = await runEvidencePurge({ backend: sqliteBackend(dbS3, false, false), now });

const ma3Rows = Number(
  new DatabaseSync(dbLocal, { readOnly: true })
    .prepare("SELECT COUNT(*) AS n FROM \"MediaAsset\" WHERE id = 'ma3'")
    .get().n
);
const results = {
  r1: {
    ok: r1.ok,
    deletedEvidenceRows: r1.deletedEvidenceRows,
    deletedAssetRows: r1.deletedAssetRows,
    deletedFiles: r1.deletedFiles,
    failedFiles: r1.failedFiles,
    detachedByStorage: r1.detachedByStorage,
    expiredIds: r1.expiredIds,
    scanned: r1.scanned,
    retained: r1.retained,
  },
  r1After: {
    evidence: count(dbLocal, "QuizAttemptEvidence"),
    mediaAssets: count(dbLocal, "MediaAsset"),
    ma3Rows,
    localFileGone: !fs.existsSync(localFile),
    keepFileGone: !fs.existsSync(keepFile),
  },
  r2: {
    ok: r2.ok,
    dryRun: r2.dryRun,
    deletedEvidenceRows: r2.deletedEvidenceRows,
    deletedAssetRows: r2.deletedAssetRows,
    expired: r2.expired,
    expiredIds: r2.expiredIds,
  },
  r2After: {
    evidence: count(dbDry, "QuizAttemptEvidence"),
    assets: count(dbDry, "MediaAsset"),
    dryFileGone: !fs.existsSync(dryFile),
  },
  r3: {
    ok: r3.ok,
    deletedEvidenceRows: r3.deletedEvidenceRows,
    protectedMoved: r3.protectedMoved,
    evidenceAfter: count(dbMoved, "QuizAttemptEvidence"),
    securityAfter: count(dbMoved, "SecurityEvent"),
  },
  r4: {
    ok: r4.ok,
    deletedEvidenceRows: r4.deletedEvidenceRows,
    deletedAssetRows: r4.deletedAssetRows,
    deletedFiles: r4.deletedFiles,
    failedFiles: r4.failedFiles,
    detachedByStorage: r4.detachedByStorage,
  },
};
console.log("HARNESS_JSON " + JSON.stringify(results));
