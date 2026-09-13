// CodeMind Academy — Phase 21: quiz-evidence retention policy.
//
// Camera evidence (QuizAttemptEvidence) is biometric personal data with a
// per-row retention deadline (`retainUntil`, stamped at capture as now +
// QUIZ_EVIDENCE_RETENTION_DAYS). This module owns the SELECTION RULE — which
// rows a cleanup job may delete — shared by the purge script
// (scripts/media/purge-expired-evidence.mjs) and the offline suite, so the
// rule is defined ONCE and tested in both places.
//
// THE RULE
//   A QuizAttemptEvidence row is purgeable iff:
//     retainUntil IS NOT NULL AND retainUntil <= now
//   * NULL retainUntil = retained indefinitely (STATUS rows and legacy rows
//     without a stamp are NEVER purged — fail-closed against data loss).
//   * "Expired" is evaluated at purge time against the database clock value
//     passed in, never against a client-supplied timestamp.
//   * Referenced METADATA is preserved: the purge deletes the evidence row and
//     (only when unreferenced elsewhere) its private file bytes — the parent
//     QuizAttempt, the Student, and every audit row are untouched.
//   * SECURITY SEPARATION: SecurityEvent, AuditLog, TeacherApplication,
//     TeacherActivationToken, UserSession, PasswordResetToken and
//     SecurityRateLimit are NEVER inputs to this module. Evidence retention
//     and security/audit retention are logically separate systems; the purge
//     script additionally asserts protected-table counts are unchanged.
//     (Security/audit retention policy itself is a Phase 22 decision — this
//     phase only guarantees evidence cleanup cannot touch it.)
//
// PHASE 24 — SHARED PURGE OPERATION
//   This module now also owns the actual PURGE OPERATION (row deletion,
//   reference-safe asset detach, storage-aware byte deletion, protected-table
//   assertion) as `runEvidencePurge()`. BOTH callers — the operator CLI
//   (scripts/media/purge-expired-evidence.ts) and the Vercel Cron endpoint
//   (src/app/api/cron/purge-evidence/route.ts) — call this one function.
//   There is exactly ONE retention implementation; the callers differ only
//   in the SQL backend they supply (SQLite / PostgreSQL for the CLI, a
//   dedicated PostgreSQL connection for the cron route) and in how they
//   report (console + metrics file vs. a minimal JSON response).

import path from "node:path";
import {
  MEDIA_ROOT,
  LocalStorageBackend,
  backendNameForStorageValue,
  createStorageBackend,
  isManagedPrivateStorage,
  type StorageBackend,
} from "./media";

export const QUIZ_EVIDENCE_DEFAULT_RETENTION_DAYS = 30;

/** Tables the evidence purge must never read-for-delete (asserted by tests). */
export const EVIDENCE_PURGE_PROTECTED_TABLES = [
  "SecurityEvent",
  "AuditLog",
  "TeacherApplication",
  "TeacherActivationToken",
  "UserSession",
  "PasswordResetToken",
  "SecurityRateLimit",
  "QuizAttempt",
  "Student",
  "User",
] as const;

export type EvidenceRow = {
  id: string;
  attemptId: string;
  mediaAssetId: string | null;
  kind: string;
  retainUntil: Date | string | number | null | undefined;
};

export function resolveRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.QUIZ_EVIDENCE_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return QUIZ_EVIDENCE_DEFAULT_RETENTION_DAYS;
  }
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 3650) {
    throw new Error(
      `QUIZ_EVIDENCE_RETENTION_DAYS must be an integer 1..3650 (got ${JSON.stringify(String(raw).slice(0, 16))})`
    );
  }
  return n;
}

/** Stamp a capture-time deadline (used by the evidence route + tests). */
export function retentionDeadlineFrom(now: Date, days?: number): Date {
  const d = days ?? QUIZ_EVIDENCE_DEFAULT_RETENTION_DAYS;
  return new Date(now.getTime() + d * 24 * 3600 * 1000);
}

/** True iff the row's deadline has passed. NULL/undefined deadline = keep. */
export function isEvidenceExpired(
  row: Pick<EvidenceRow, "retainUntil">,
  now: Date = new Date()
): boolean {
  const r = row.retainUntil;
  if (r === null || r === undefined) return false;
  const deadline = r instanceof Date ? r : new Date(typeof r === "number" ? r : String(r));
  if (Number.isNaN(deadline.getTime())) return false; // unparseable = keep (fail-closed)
  return deadline.getTime() <= now.getTime();
}

/** Partition rows into { expired, retained } — the purge set + its complement. */
export function selectExpiredEvidence<T extends Pick<EvidenceRow, "retainUntil">>(
  rows: T[],
  now: Date = new Date()
): { expired: T[]; retained: T[] } {
  const expired: T[] = [];
  const retained: T[] = [];
  for (const row of rows) {
    (isEvidenceExpired(row, now) ? expired : retained).push(row);
  }
  return { expired, retained };
}

// ---------------------------------------------------------------------------
// Phase 24 — the shared purge operation (CLI + Vercel Cron route)
// ---------------------------------------------------------------------------
//
// WHAT IT DOES — the purge semantics that were historically inline in the
// operator CLI, now the single implementation every caller runs:
//   1. Snapshot the protected tables (BEFORE).
//   2. Select the purge set with the canonical rule above (DB pre-filters to
//      stamped rows; `selectExpiredEvidence` makes the final call per row).
//   3. LIVE only, in ONE transaction: delete the expired evidence rows, then
//      delete each MediaAsset row referenced by NOTHING else (no other
//      evidence row, no Material, no SessionVideo) and collect the private
//      objects whose bytes must go. COMMIT is all-or-nothing.
//   4. AFTER the commit, delete the collected objects through the SAME
//      storage abstraction the application uses:
//        LOCAL_PRIVATE → the private volume under `mediaRoot` (LocalStorage-
//        Backend, traversal-guarded, verified after delete);
//        S3            → the S3/R2 bucket via `createStorageBackend("s3")`
//        (fail-closed per object when unconfigured — recorded, never
//        silently skipped).
//      Deletions are VERIFIED (a stat after the delete): an object that
//      survives is a recorded failure for the next run, never counted as
//      removed.
//   5. Re-count the protected tables (AFTER). If ANY count moved, the report
//      is `ok: false` with the movements named — the caller MUST treat that
//      as a hard failure (CLI exits 2, cron route answers 500).
//
// The operation is IDEMPOTENT: a second run finds fewer (or zero) expired
// rows and safely no-ops; an object whose delete failed is re-found on the
// next run. Nothing in this module deletes any table outside the purge set,
// and the expiry rule, exact-row targeting and reference-safe detach are
// byte-for-byte the behaviour the Phase 21 suites pin.

export interface PurgeSqlBackend {
  /** Placeholder dialect: "sqlite" binds `?`; "postgresql" binds `$1, $2, …`. */
  dialect: "sqlite" | "postgresql";
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** Returns the number of affected rows. */
  run(sql: string, params?: unknown[]): Promise<number>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface PurgeOptions {
  backend: PurgeSqlBackend;
  /** Evaluation clock for the expiry rule (defaults to now). Never client input. */
  now?: Date;
  /** Root of the LOCAL_PRIVATE volume (defaults to MEDIA_ROOT, like the app). */
  mediaRoot?: string;
  /**
   * Dry run (operator-CLI semantics): SELECTs only, nothing is written, and
   * the report carries the would-be purge set. The cron route always runs
   * LIVE — a Vercel Cron trigger is an operator decision, not an operator
   * keyboard.
   */
  dryRun?: boolean;
}

export interface PurgeReport {
  dryRun: boolean;
  /** ISO clock the expiry rule was evaluated at. */
  now: string;
  scanned: number;
  expired: number;
  retained: number;
  expiredIds: string[];
  deletedEvidenceRows: number;
  detachedAssets: number;
  /** Detached objects by recorded storage value (LOCAL_PRIVATE / S3). */
  detachedByStorage: Record<string, number>;
  deletedAssetRows: number;
  deletedFiles: number;
  /** Objects that could not be verified as deleted (retry on the next run). */
  failedFiles: string[];
  /** Protected-table counts BEFORE the run (always). */
  protectedTables: Record<string, number>;
  /** Protected-table counts AFTER a live run (empty on a dry run). */
  protectedTablesAfter: Record<string, number>;
  /** `"table: before -> after"` for every protected table that moved. */
  protectedMoved: string[];
  /**
   * False ONLY when a protected table moved mid-run. A caller MUST treat a
   * `false` as a hard failure even though the report is returned (not
   * thrown) so the full picture can be logged/metrics-ified.
   */
  ok: boolean;
}

/**
 * Traversal guard for LOCAL_PRIVATE keys: resolve `key` under `root`; return
 * the absolute path only when it stays inside the volume, else `null` (the
 * caller refuses the delete and records it). S3 keys have no filesystem to
 * escape — they are addressed verbatim inside the configured bucket.
 */
export function resolvePurgeSafePath(root: string, key: string): string | null {
  const target = path.resolve(root, key);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/**
 * Run the expired quiz-evidence purge. See the section header for the
 * exact semantics. Throws on unexpected backend/DB errors (the transaction,
 * if started, is rolled back before the throw) — but returns `ok: false`
 * (no throw) when a protected table moved, so callers can report the full
 * picture.
 */
export async function runEvidencePurge(options: PurgeOptions): Promise<PurgeReport> {
  const backend = options.backend;
  const dryRun = options.dryRun === true;
  const now = options.now ?? new Date();
  const mediaRoot = options.mediaRoot || MEDIA_ROOT;
  const isSqlite = backend.dialect === "sqlite";
  const ph = (i: number) => (isSqlite ? "?" : `$${i}`);

  // 1. Snapshot protected tables (BEFORE).
  const protectedTables: Record<string, number> = {};
  for (const t of EVIDENCE_PURGE_PROTECTED_TABLES) {
    const rows = await backend.all(`SELECT COUNT(*) AS n FROM "${t}"`);
    protectedTables[t] = Number(rows[0].n);
  }

  // 2. Select the purge set. The DB pre-filters to stamped rows; the
  // canonical TS rule (above) makes the final call per row, so dialect
  // datetime quirks can never widen the delete set.
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
      mediaAssetId:
        r.mediaAssetId === null || r.mediaAssetId === undefined ? null : String(r.mediaAssetId),
      kind: String(r.kind),
      retainUntil: r.retainUntil as Date | string | number | null,
    })),
    now
  );
  const retainedTotal = retained.length + Number(unstamped[0].n);

  const report: PurgeReport = {
    dryRun,
    now: now.toISOString(),
    scanned,
    expired: expired.length,
    retained: retainedTotal,
    expiredIds: expired.map((e) => e.id),
    deletedEvidenceRows: 0,
    detachedAssets: 0,
    detachedByStorage: {},
    deletedAssetRows: 0,
    deletedFiles: 0,
    failedFiles: [],
    protectedTables,
    protectedTablesAfter: {},
    protectedMoved: [],
    ok: false,
  };

  if (dryRun) {
    // A dry run issues only SELECTs (the caller opens a read-only backend
    // where possible); it literally cannot write.
    report.ok = true;
    return report;
  }

  // 3. LIVE: delete evidence rows + detach assets in ONE transaction.
  const expiredIds = expired.map((e) => e.id);
  let deletedEvidenceRows = 0;
  // Detached managed-private objects: { key, storage } — `storage` decides
  // WHICH backend has to delete the bytes (LOCAL_PRIVATE volume vs S3/R2).
  const detachedObjects: { key: string; storage: string }[] = [];
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
    const assetIds = [
      ...new Set(expired.map((e) => e.mediaAssetId).filter((x): x is string => !!x)),
    ];
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
      report.deletedAssetRows = report.deletedAssetRows + 1;
      // BOTH managed private backends are collected. A non-managed value
      // (EXTERNAL_URL, empty, unknown) has no bytes of ours to remove.
      if (isManagedPrivateStorage(asset[0].storage) && asset[0].storageKey) {
        detachedObjects.push({
          key: String(asset[0].storageKey),
          storage: String(asset[0].storage).trim().toUpperCase(),
        });
      }
    }
    report.detachedAssets = detachedObjects.length;
    report.detachedByStorage = detachedObjects.reduce<Record<string, number>>((acc, o) => {
      acc[o.storage] = (acc[o.storage] ?? 0) + 1;
      return acc;
    }, {});
    await backend.commit();
  } catch (e) {
    await backend.rollback();
    throw e;
  }
  report.deletedEvidenceRows = deletedEvidenceRows;

  // 4. Objects AFTER commit (best-effort per object; failures recorded and
  // retried on the next run. An object that survives a failed delete is
  // orphaned BYTES without a DB pointer — the safe direction: invisible to
  // the app and reported in the report, never skipped silently).
  const backendCache = new Map<string, Promise<StorageBackend>>();
  const backendFor = (storageValue: string): Promise<StorageBackend> => {
    const name = backendNameForStorageValue(storageValue) ?? "local";
    let promise = backendCache.get(name);
    if (!promise) {
      promise =
        name === "local"
          ? // The operator's volume override (CLI) or the app's volume (route).
            Promise.resolve(new LocalStorageBackend(mediaRoot))
          : // S3/R2: built from server env (fail-closed when unconfigured —
            // recorded per object below, so nothing is skipped silently).
            createStorageBackend(name);
      backendCache.set(name, promise);
    }
    return promise;
  };

  let deletedFiles = 0;
  const failedFiles: string[] = [];
  for (const object of detachedObjects) {
    const key = object.key;
    let storage: StorageBackend;
    try {
      storage = await backendFor(object.storage);
    } catch (e: unknown) {
      failedFiles.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (storage.name === "local") {
      // Traversal guard for the filesystem volume (unchanged behaviour).
      const abs = resolvePurgeSafePath(mediaRoot, key);
      if (!abs) {
        failedFiles.push(`${key}: escapes media root`);
        continue;
      }
    }
    try {
      await storage.delete(key);
      // `delete` is idempotent and the local backend swallows I/O errors, so
      // VERIFY convergence instead of trusting the call: an object that
      // survives is a recorded failure (the caller retries), never a silent
      // skip. A missing object (already gone) is convergence, as before.
      if (await storage.stat(key)) {
        failedFiles.push(`${key}: still present after delete`);
        continue;
      }
      deletedFiles++;
    } catch (e: unknown) {
      failedFiles.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  report.deletedFiles = deletedFiles;
  report.failedFiles = failedFiles;

  // 5. Prove protected tables did not move.
  const protectedTablesAfter: Record<string, number> = {};
  for (const t of EVIDENCE_PURGE_PROTECTED_TABLES) {
    const rows = await backend.all(`SELECT COUNT(*) AS n FROM "${t}"`);
    protectedTablesAfter[t] = Number(rows[0].n);
    if (protectedTablesAfter[t] !== protectedTables[t]) {
      report.protectedMoved.push(`${t}: ${protectedTables[t]} -> ${protectedTablesAfter[t]}`);
    }
  }
  report.protectedTablesAfter = protectedTablesAfter;
  if (report.protectedMoved.length) {
    report.ok = false;
    return report;
  }
  report.ok = true;
  return report;
}
