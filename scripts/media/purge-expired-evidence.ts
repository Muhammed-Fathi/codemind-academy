// CodeMind Academy — Phase 21: purge expired quiz camera evidence.
//
//   npx tsx scripts/media/purge-expired-evidence.ts --sqlite db/custom.db
//   npx tsx scripts/media/purge-expired-evidence.ts --target postgresql://… --live --yes
//   npx tsx scripts/media/purge-expired-evidence.ts --pglite /tmp/disposable-pg --live --yes
//
// WHAT IT DELETES — and what it can never delete:
//   * DELETES: QuizAttemptEvidence rows whose retainUntil has passed (the rule
//     in src/lib/evidence-retention.ts — NULL deadline = keep, forever), plus
//     the MediaAsset row + private file bytes ONLY when the asset is referenced
//     by nothing else (no other evidence row, no Material, no SessionVideo).
//   * NEVER: SecurityEvent, AuditLog, TeacherApplication, TeacherActivationToken,
//     UserSession, PasswordResetToken, SecurityRateLimit, QuizAttempt, Student,
//     User — the run snapshots these counts before/after and FAILS if any
//     moved. Evidence retention and security/audit retention are separate
//     systems; this job cannot blur them.
//
// SINGLE IMPLEMENTATION (Phase 24)
//   The purge operation itself — selection, transactional row delete,
//   reference-safe asset detach, storage-aware byte deletion (LOCAL_PRIVATE
//   and S3) and the protected-table assertion — lives in ONE place:
//   `runEvidencePurge()` in src/lib/evidence-retention.ts. This script is
//   the operator CLI around it (argument parsing, backend selection,
//   console output, metrics file, exit codes). The Vercel Cron endpoint
//   (src/app/api/cron/purge-evidence/route.ts) calls the SAME function.
//
// WHICH BACKEND HOLDS THE BYTES
//   A detached asset's `MediaAsset.storage` says where its bytes live, and the
//   shared purge operation deletes them through the SAME storage abstraction
//   the application uses (`src/lib/media.ts`), so BOTH managed private
//   backends are supported:
//     LOCAL_PRIVATE -> the private volume under --media-root (LocalStorageBackend)
//     S3            -> the S3/R2 bucket, configured by the server-side R2_* env
//                      vars (S3StorageBackend; no signed URL, no public access,
//                      no credential ever printed)
//   An S3-backed object is NEVER silently skipped: if the object store is not
//   configured in this environment, the failure is RECORDED per object and the
//   run exits 2 for a retry, exactly like a file that could not be unlinked.
//
// SAFETY
//   * DRY RUN IS THE DEFAULT. Deletion requires BOTH --live AND --yes.
//     Dry-run opens SQLite read-only and issues only SELECTs on PostgreSQL,
//     so a dry run literally cannot write.
//   * Evidence rows delete in ONE transaction (all-or-nothing); private objects
//     delete AFTER the commit, per-object best-effort with failures RECORDED in
//     the metrics (an object that fails to delete is retried on the next run —
//     the next run finds an unreferenced asset and finishes the job).
//   * Every LOCAL deletion is traversal-safe (resolved under --media-root;
//     keys escaping the root are refused and recorded). S3 keys are addressed
//     verbatim inside the configured bucket — there is no filesystem to escape.
//   * Deletions are VERIFIED (a stat after the delete), so an object that
//     survives is reported as a failure rather than counted as removed.
//   * Metrics JSON (--metrics path, default stdout-adjacent <db>.purge.json step
//     is skipped unless requested… default: printed to stdout only) records
//     scanned/expired/deleted/detached/failed + protected-table counts, so a
//     cron run is auditable. Nothing secret is ever logged (ids only).
//
// EXIT: 0 = success (dry-run or live); 1 = usage; 2 = protected-table moved or
// a live run hit an unexpected error (transaction rolled back).

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { runEvidencePurge, type PurgeSqlBackend } from "@/lib/evidence-retention";
import { MEDIA_ROOT } from "@/lib/media";

type Args = {
  sqlite?: string;
  target?: string;
  pglite?: string;
  mediaRoot: string;
  now: Date;
  live: boolean;
  yes: boolean;
  metrics?: string;
};

function usage(exit = 1): never {
  console.error(`usage: npx tsx scripts/media/purge-expired-evidence.ts (--sqlite <file> | --target <pg-url> | --pglite <dir>)
  [--media-root <dir>] [--now <iso>] [--metrics <path>] [--live --yes]

  Default is a DRY RUN (no writes). Deletion requires BOTH --live and --yes.`);
  process.exit(exit);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const o: Args = { mediaRoot: process.env.MEDIA_STORAGE_PATH || MEDIA_ROOT, now: new Date(), live: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sqlite") o.sqlite = argv[++i];
    else if (a === "--target") o.target = argv[++i];
    else if (a === "--pglite") o.pglite = argv[++i];
    else if (a === "--media-root") o.mediaRoot = argv[++i];
    else if (a === "--now") o.now = new Date(argv[++i]);
    else if (a === "--metrics") o.metrics = argv[++i];
    else if (a === "--live") o.live = true;
    else if (a === "--yes") o.yes = true;
    else if (a === "-h" || a === "--help") usage(0);
    else { console.error(`unknown argument: ${a}`); usage(1); }
  }
  const backends = [o.sqlite, o.target, o.pglite].filter(Boolean).length;
  if (backends !== 1) usage(1);
  if (Number.isNaN(o.now.getTime())) { console.error("--now must be a valid ISO date"); process.exit(1); }
  return o;
}

// --- minimal backend interface (SELECT/DELETE + tx) over sqlite/pg/pglite ---
// The shared purge core (src/lib/evidence-retention.ts) programs against
// `PurgeSqlBackend`; this CLI adds `close()` because it owns the connection
// lifecycle. The core never closes a backend.

type Row = Record<string, any>;

interface Backend extends PurgeSqlBackend {
  kind: string;
  close(): Promise<void>;
}

function sqliteBackend(file: string, readOnly: boolean): Backend {
  const db = new DatabaseSync(file, { readOnly });
  // node:sqlite's DatabaseSync is typed against its own SQLInputValue union;
  // the shared backend contract is unknown[], so widen once at the boundary
  // (the values are the same strings/numbers the rest of the app binds).
  const bind = (params: unknown[]) => params as any[];
  return {
    kind: `sqlite:${file}`,
    dialect: "sqlite",
    all: async (sql, params = []) => db.prepare(sql).all(...bind(params)) as Row[],
    run: async (sql, params = []) => Number(db.prepare(sql).run(...bind(params)).changes),
    begin: async () => { db.exec("BEGIN"); },
    commit: async () => { db.exec("COMMIT"); },
    rollback: async () => { try { db.exec("ROLLBACK"); } catch { /* already failed */ } },
    close: async () => db.close(),
  };
}

function pgBackend(pool: pg.Pool): Backend {
  const q = (sql: string, params: any[] = []) => pool.query(sql, params);
  return {
    kind: "pg",
    dialect: "postgresql",
    all: async (sql, params = []) => (await q(sql, params)).rows as Row[],
    run: async (sql, params = []) => (await q(sql, params)).rowCount ?? 0,
    begin: async () => { await q("BEGIN"); },
    commit: async () => { await q("COMMIT"); },
    rollback: async () => { try { await q("ROLLBACK"); } catch { /* already failed */ } },
    close: async () => { await pool.end().catch(() => {}); },
  };
}

async function pgliteBackend(dir: string): Promise<Backend> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(dir);
  return {
    kind: `pglite:${dir}`,
    dialect: "postgresql",
    all: async (sql, params = []) => ((await db.query(sql, params)).rows as Row[]) || [],
    run: async (sql, params = []) => {
      const r = await db.query(sql, params);
      return (r as unknown as { affectedRows?: number }).affectedRows ?? 0;
    },
    begin: async () => { await db.query("BEGIN"); },
    commit: async () => { await db.query("COMMIT"); },
    rollback: async () => { try { await db.query("ROLLBACK"); } catch { /* already failed */ } },
    close: async () => { await db.close(); },
  };
}

async function main() {
  const o = parseArgs();
  const dryRun = !(o.live && o.yes);
  if ((o.live || o.yes) && dryRun) {
    console.error("refusing: deletion requires BOTH --live AND --yes (running nothing)");
    process.exit(1);
  }

  let backend: Backend;
  if (o.sqlite) backend = sqliteBackend(o.sqlite, dryRun);
  else if (o.target) {
    if (/^file:/.test(o.target) || o.target.endsWith(".db")) {
      console.error("--target must be a PostgreSQL URL");
      process.exit(1);
    }
    backend = pgBackend(new pg.Pool({ connectionString: o.target }));
  } else {
    backend = await pgliteBackend(o.pglite as string);
  }

  try {
    // The purge operation itself — identical to the one the Vercel Cron
    // endpoint (GET /api/cron/purge-evidence) runs — lives in the shared
    // core. This CLI only supplies the backend + operator settings.
    const report = await runEvidencePurge({
      backend,
      now: o.now,
      mediaRoot: o.mediaRoot,
      dryRun,
    });

    const metrics: Record<string, unknown> = {
      tool: "purge-expired-evidence (Phase 21)",
      createdAt: new Date().toISOString(),
      dryRun,
      now: report.now,
      scanned: report.scanned,
      expired: report.expired,
      retained: report.retained,
      expiredIds: report.expiredIds,
      deletedEvidenceRows: report.deletedEvidenceRows,
      detachedAssets: report.detachedAssets,
      deletedAssetRows: report.deletedAssetRows,
      deletedFiles: report.deletedFiles,
      failedFiles: report.failedFiles,
      protectedTables: report.protectedTables,
      ok: report.ok,
    };
    if (!dryRun) {
      metrics.detachedByStorage = report.detachedByStorage;
      metrics.protectedTablesAfter = report.protectedTablesAfter;
    }
    const writeMetrics = () => {
      if (o.metrics) fs.writeFileSync(o.metrics, `${JSON.stringify(metrics, null, 2)}\n`);
    };

    console.log(`${dryRun ? "DRY RUN" : "LIVE"}: scanned=${report.scanned} expired=${report.expired} retained=${report.retained} (now=${o.now.toISOString()})`);

    if (dryRun) {
      writeMetrics();
      console.log(`PURGE_DRY_RUN_OK expired=${report.expired}`);
      return;
    }

    if (report.protectedMoved.length) {
      writeMetrics();
      console.error(`FATAL: protected tables moved: ${report.protectedMoved.join("; ")}`);
      process.exit(2);
    }
    writeMetrics();
    console.log(`PURGE_LIVE_OK deleted=${report.deletedEvidenceRows} assets=${report.deletedAssetRows} files=${report.deletedFiles} failed=${report.failedFiles.length}`);
    if (report.failedFiles.length) process.exitCode = 2; // files need a retry run
  } finally {
    await backend.close();
  }
}

main().catch((e) => {
  console.error(`fatal: ${e?.message || e}`);
  process.exit(2);
});
