#!/usr/bin/env node
// CodeMind Academy — legacy `Setting:session:*` audit & purge (Phase 20).
//
// WHY THIS EXISTS
// ===============
// Before the Platform Upgrade, sessions were stored as `Setting` rows keyed
// `session:<token>` with value `<userId>|<expiryISO>`. The upgrade introduced
// the `UserSession` table and migrated legacy sessions ON READ (see
// src/lib/auth.ts). Phase 20 REMOVED that read-time fallback, so any
// `session:*` row still present is now pure garbage — it can no longer be
// turned into a live session.
//
// THE PRECONDITION THE PHASE REQUIRES
// ===================================
// "Remove only if no valid production session depends on it." This script is
// the proof: it lists every legacy row, classifies each as EXPIRED or
// (unexpectedly) STILL-VALID by its embedded expiry, and reports the tally.
//   * a STILL-VALID row means the precondition FAILS — do not purge until you
//     understand why a live-looking legacy session was never migrated;
//   * an all-EXPIRED (or empty) result means the precondition holds and
//     `--purge` is safe.
//
// USAGE
// =====
//   node scripts/audit-legacy-sessions.mjs            # report only
//   node scripts/audit-legacy-sessions.mjs --purge    # delete expired rows
//   node scripts/audit-legacy-sessions.mjs --purge --all   # delete ALL rows
//
// DATABASE_URL (or `file:./db/custom.db` relative to the prisma schema dir,
// i.e. prisma/db/custom.db) locates the SQLite file. This script never writes
// unless `--purge` is passed, and it uses node:sqlite directly (no Prisma
// engine needed — the same constraint the verify-* scripts document).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

const DEFAULT_DB = path.join(REPO, "prisma", "db", "custom.db");

function resolveDbPath() {
  const raw = process.env.DATABASE_URL || "";
  const m = /^file:(.+)$/.exec(raw.trim());
  if (m) {
    const p = m[1];
    return path.isAbsolute(p) ? p : path.resolve(path.join(REPO, "prisma"), p);
  }
  if (raw.trim() && !raw.trim().startsWith("file:")) {
    console.error(
      "[audit-legacy-sessions] DATABASE_URL is not a file: URL — refusing to guess the database. Exiting."
    );
    process.exit(2);
  }
  return DEFAULT_DB;
}

const dbPath = resolveDbPath();
if (!fs.existsSync(dbPath)) {
  console.log(`[audit-legacy-sessions] no database at ${dbPath} — nothing to audit.`);
  console.log("LEGACY_SESSION_AUDIT_OK");
  process.exit(0);
}

const db = new DatabaseSync(dbPath, { readOnly: false });

// The legacy value layout, exactly as the removed auth.ts read it:
//   <userId>|<expiryISO>
// Any row that does not parse is treated as a legacy row of unknown shape
// (reported separately; never auto-purged without --all).
const rows = db
  .prepare(`SELECT id, key, value FROM "Setting" WHERE "key" LIKE 'session:%'`)
  .all();

const now = Date.now();
let expired = 0;
let stillValid = 0;
let malformed = 0;
const validIds = [];
const malformedIds = [];

for (const row of rows) {
  const [userId, expiryStr] = String(row.value).split("|");
  if (!userId || !expiryStr) {
    malformed++;
    malformedIds.push(row.id);
    continue;
  }
  const expiry = Date.parse(expiryStr);
  if (!Number.isFinite(expiry)) {
    malformed++;
    malformedIds.push(row.id);
    continue;
  }
  if (expiry < now) {
    expired++;
  } else {
    stillValid++;
    validIds.push({ id: row.id, key: row.key, expires: expiryStr });
  }
}

console.log("Legacy `Setting:session:*` audit");
console.log("================================");
console.log(`database        : ${dbPath}`);
console.log(`legacy rows     : ${rows.length}`);
console.log(`  expired       : ${expired}`);
console.log(`  STILL-VALID   : ${stillValid}`);
console.log(`  malformed     : ${malformed}`);
if (stillValid > 0) {
  console.log("\nPRECONDITION FAILS — still-valid legacy sessions:");
  for (const v of validIds.slice(0, 20)) {
    console.log(`  ${v.key}  expires=${v.expires}`);
  }
  console.log(
    "Do NOT purge. Investigate why these were never migrated before removing the fallback."
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const purge = args.includes("--purge");
const purgeAll = args.includes("--all");

if (!purge) {
  console.log(
    "\nNo --purge passed: report only. Re-run with --purge to delete the expired legacy rows (add --all to also delete malformed rows)."
  );
  console.log("LEGACY_SESSION_AUDIT_OK");
  process.exit(0);
}

if (stillValid > 0) {
  console.log("\nRefusing --purge: still-valid legacy sessions exist (see above).");
  process.exit(1);
}

let deleted = 0;
if (purgeAll) {
  const result = db
    .prepare(`DELETE FROM "Setting" WHERE "key" LIKE 'session:%'`)
    .run();
  deleted = Number(result.changes ?? 0);
} else {
  // Delete only well-formed, expired rows. Malformed rows are left untouched
  // (they are not proven to be safe to remove without --all).
  for (const row of rows) {
    const [userId, expiryStr] = String(row.value).split("|");
    if (!userId || !expiryStr) continue;
    const expiry = Date.parse(expiryStr);
    if (!Number.isFinite(expiry)) continue;
    if (expiry < now) {
      db.prepare(`DELETE FROM "Setting" WHERE id = ?`).run(row.id);
      deleted++;
    }
  }
}

console.log(`\nPurged ${deleted} legacy session row(s).`);
console.log("LEGACY_SESSION_AUDIT_OK");
