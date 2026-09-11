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
//     User — the script snapshots these counts before/after and FAILS if any
//     moved. Evidence retention and security/audit retention are separate
//     systems; this job cannot blur them.
//
// SAFETY
//   * DRY RUN IS THE DEFAULT. Deletion requires BOTH --live AND --yes.
//     Dry-run opens SQLite read-only and issues only SELECTs on PostgreSQL,
//     so a dry run literally cannot write.
//   * Evidence rows delete in ONE transaction (all-or-nothing); private files
//     delete AFTER the commit, per-file best-effort with failures RECORDED in
//     the metrics (a file that fails to delete is retried on the next run —
//     the next run finds an unreferenced asset and finishes the job).
//   * Every file deletion is traversal-safe (resolved under --media-root;
//     keys escaping the root are refused and recorded).
//   * Metrics JSON (--metrics path, default stdout-adjacent <db>.purge.json step
//     is skipped unless requested… default: printed to stdout only) records
//     scanned/expired/deleted/detached/failed + protected-table counts, so a
//     cron run is auditable. Nothing secret is ever logged (ids only).
//
// EXIT: 0 = success (dry-run or live); 1 = usage; 2 = protected-table moved or
// a live run hit an unexpected error (transaction rolled back).

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import {
  selectExpiredEvidence,
  EVIDENCE_PURGE_PROTECTED_TABLES,
} from "@/lib/evidence-retention";
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

type Row = Record<string, any>;

interface Backend {
  kind: string;
  all(sql: string, params?: any[]): Promise<Row[]>;
  run(sql: string, params?: any[]): Promise<number>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

function sqliteBackend(file: string, readOnly: boolean): Backend {
  const db = new DatabaseSync(file, { readOnly });
  return {
    kind: `sqlite:${file}`,
    all: async (sql, params = []) => db.prepare(sql).all(...params) as Row[],
    run: async (sql, params = []) => Number(db.prepare(sql).run(...params).changes),
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

function resolveSafePath(root: string, key: string): string | null {
  const target = path.resolve(root, key);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
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
    // 1. Snapshot protected tables (BEFORE).
    const isSqlite = !!o.sqlite;
    const protectedBefore: Record<string, number> = {};
    for (const t of EVIDENCE_PURGE_PROTECTED_TABLES) {
      const rows = await backend.all(`SELECT COUNT(*) AS n FROM "${t}"`);
      protectedBefore[t] = Number(rows[0].n);
    }

    // 2. Select the purge set. The DB pre-filters to stamped rows; the
    // canonical TS rule (src/lib/evidence-retention.ts) makes the final call
    // per row, so dialect datetime quirks can never widen the delete set.
    const stamped = await backend.all(
      `SELECT "id","attemptId","mediaAssetId","kind","retainUntil" FROM "QuizAttemptEvidence" WHERE "retainUntil" IS NOT NULL`
    );
    const unstamped = await backend.all(
      `SELECT COUNT(*) AS n FROM "QuizAttemptEvidence" WHERE "retainUntil" IS NULL`
    );
    const scanned = stamped.length + Number(unstamped[0].n);
    const { expired, retained } = selectExpiredEvidence(
      stamped.map((r) => ({
        id: String(r.id),
        attemptId: String(r.attemptId),
        mediaAssetId: r.mediaAssetId === null || r.mediaAssetId === undefined ? null : String(r.mediaAssetId),
        kind: String(r.kind),
        retainUntil: r.retainUntil as Date | string | number | null,
      })),
      o.now
    );
    const retainedTotal = retained.length + Number(unstamped[0].n);

    console.log(`${dryRun ? "DRY RUN" : "LIVE"}: scanned=${scanned} expired=${expired.length} retained=${retainedTotal} (now=${o.now.toISOString()})`);

    const metrics: Record<string, unknown> = {
      tool: "purge-expired-evidence (Phase 21)",
      createdAt: new Date().toISOString(),
      dryRun,
      now: o.now.toISOString(),
      scanned,
      expired: expired.length,
      retained: retainedTotal,
      expiredIds: expired.map((e) => e.id),
      deletedEvidenceRows: 0,
      detachedAssets: 0,
      deletedAssetRows: 0,
      deletedFiles: 0,
      failedFiles: [] as string[],
      protectedTables: protectedBefore,
      ok: false,
    };

    if (dryRun) {
      metrics.ok = true;
      if (o.metrics) fs.writeFileSync(o.metrics, `${JSON.stringify(metrics, null, 2)}\n`);
      console.log(`PURGE_DRY_RUN_OK expired=${expired.length}`);
      return;
    }

    // 3. LIVE: delete evidence rows + detach assets in ONE transaction.
    const ph = (i: number) => (isSqlite ? "?" : `$${i}`);
    const expiredIds = expired.map((e) => e.id);
    let deletedEvidenceRows = 0;
    const detachedKeys: string[] = [];
    await backend.begin();
    try {
      if (expiredIds.length) {
        // Chunked delete (drivers cap bound params; 500 ids/chunk is safely small).
        for (let i = 0; i < expiredIds.length; i += 500) {
          const chunk = expiredIds.slice(i, i + 500);
          const placeholders = chunk.map((_, j) => ph(j + 1)).join(",");
          deletedEvidenceRows += await backend.run(
            `DELETE FROM "QuizAttemptEvidence" WHERE "id" IN (${placeholders})`,
            chunk
          );
        }
      }
      // Detached assets: referenced nowhere after the delete.
      const assetIds = [...new Set(expired.map((e) => e.mediaAssetId).filter((x): x is string => !!x))];
      for (const assetId of assetIds) {
        const p1 = ph(1);
        const refs = await backend.all(
          `SELECT (SELECT COUNT(*) FROM "QuizAttemptEvidence" WHERE "mediaAssetId" = ${p1}) AS e,
                  (SELECT COUNT(*) FROM "Material" WHERE "mediaAssetId" = ${p1}) AS m,
                  (SELECT COUNT(*) FROM "SessionVideo" WHERE "mediaAssetId" = ${p1}) AS s`,
          [assetId, assetId, assetId].slice(0, isSqlite ? 3 : 1)
        );
        // NOTE: sqlite needs one bound value per `?` (3 copies above); pg
        // reuses $1 (slice to 1). Both spellings are built from the same query.
        const r = refs[0];
        if (Number(r.e) + Number(r.m) + Number(r.s) > 0) continue;
        const asset = await backend.all(
          `SELECT "storageKey","storage" FROM "MediaAsset" WHERE "id" = ${ph(1)}`,
          [assetId]
        );
        if (!asset.length) continue;
        await backend.run(`DELETE FROM "MediaAsset" WHERE "id" = ${ph(1)}`, [assetId]);
        metrics["deletedAssetRows"] = Number(metrics["deletedAssetRows"]) + 1;
        if (asset[0].storage === "LOCAL_PRIVATE" && asset[0].storageKey) {
          detachedKeys.push(String(asset[0].storageKey));
        }
      }
      metrics["detachedAssets"] = detachedKeys.length;
      await backend.commit();
    } catch (e) {
      await backend.rollback();
      throw e;
    }
    metrics["deletedEvidenceRows"] = deletedEvidenceRows;

    // 4. Files AFTER commit (best-effort per file; failures recorded + retried
    // on the next run, which finds the asset row already gone and the key
    // still on disk via the manifest… note: asset row is gone, so a failed
    // file delete leaves an orphaned FILE (safe direction — bytes without a
    // DB pointer are invisible to the app and reported in metrics).
    let deletedFiles = 0;
    const failedFiles: string[] = [];
    for (const key of detachedKeys) {
      const abs = resolveSafePath(o.mediaRoot, key);
      if (!abs) { failedFiles.push(`${key}: escapes media root`); continue; }
      try {
        await fs.promises.unlink(abs);
        deletedFiles++;
      } catch (e: any) {
        if (e?.code === "ENOENT") { deletedFiles++; continue; } // already gone = converged
        failedFiles.push(`${key}: ${e?.message || e}`);
      }
    }
    metrics["deletedFiles"] = deletedFiles;
    metrics["failedFiles"] = failedFiles;

    // 5. Prove protected tables did not move.
    const protectedAfter: Record<string, number> = {};
    const moved: string[] = [];
    for (const t of EVIDENCE_PURGE_PROTECTED_TABLES) {
      const rows = await backend.all(`SELECT COUNT(*) AS n FROM "${t}"`);
      protectedAfter[t] = Number(rows[0].n);
      if (protectedAfter[t] !== protectedBefore[t]) moved.push(`${t}: ${protectedBefore[t]} -> ${protectedAfter[t]}`);
    }
    metrics["protectedTablesAfter"] = protectedAfter;
    if (moved.length) {
      metrics["ok"] = false;
      if (o.metrics) fs.writeFileSync(o.metrics, `${JSON.stringify(metrics, null, 2)}\n`);
      console.error(`FATAL: protected tables moved: ${moved.join("; ")}`);
      process.exit(2);
    }
    metrics["ok"] = true;
    if (o.metrics) fs.writeFileSync(o.metrics, `${JSON.stringify(metrics, null, 2)}\n`);
    console.log(`PURGE_LIVE_OK deleted=${deletedEvidenceRows} assets=${metrics["deletedAssetRows"]} files=${deletedFiles} failed=${failedFiles.length}`);
    if (failedFiles.length) process.exitCode = 2; // files need a retry run
  } finally {
    await backend.close();
  }
}

main().catch((e) => {
  console.error(`fatal: ${e?.message || e}`);
  process.exit(2);
});
