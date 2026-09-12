#!/usr/bin/env node
// CodeMind Academy — STEP 4A: local Neon PostgreSQL SCHEMA-ONLY provisioning helper.
//
//   Windows (cmd):
//     set "NEON_DIRECT_URL=<your Neon DIRECT connection string>"
//     node step4-neon-provision.mjs
//
//   Windows (PowerShell):
//     $env:NEON_DIRECT_URL = "<your Neon DIRECT connection string>"
//     node step4-neon-provision.mjs
//
//   Rehearse without touching the target (recommended first run):
//     node step4-neon-provision.mjs --dry-run
//
// WHAT THIS SCRIPT DOES
//   Provisions the EMPTY Neon PostgreSQL target from the repository's EXISTING
//   artifacts only:
//     - scripts/db/postgres-baseline.sql   (the DDL that is applied)
//     - scripts/db/pg-lib.mjs              (parser / statement splitter / redactor)
//     - scripts/db/make-postgres-schema.mjs --check   (staleness gate)
//     - scripts/db/verify-postgres.mjs                (post-provision battery)
//   It creates NOTHING new: no schema is authored here, no model is edited, no
//   migration is generated, no file is written.
//
// WHAT THIS SCRIPT NEVER DOES
//   - Never reads NEON_DIRECT_URL from anywhere except process.env.NEON_DIRECT_URL.
//     No hardcoded connection string, no .env read, no fallback to DATABASE_URL /
//     POSTGRES_URL for the TARGET (the child verify run is given the target via
//     its own env — see runVerifyBattery).
//   - Never prints the full connection string or the password. Every line that
//     reaches stdout/stderr passes through scrub() (see below), which also
//     catches credentials leaking out of driver error messages.
//   - Never writes the connection string to any file. This script writes NO
//     files at all. The env var is not persisted.
//   - Never touches the SQLite source (E:\workspace\db\custom.db). The only
//     access is an optional READ-ONLY SHA-256 immutability proof.
//   - Never modifies prisma/schema.prisma, prisma/schema.postgresql.prisma,
//     scripts/db/postgres-baseline.sql, package.json or the lockfile. Fingerprints
//     of all of them are taken before and after and reported.
//   - Never runs: prisma migrate reset, prisma db push, prisma migrate dev/deploy,
//     migrate-sqlite-to-postgres.mjs, any seed/reconcile/setup script.
//   - Never executes destructive SQL. The baseline is scanned BEFORE it is
//     applied and every statement must be an allowlisted CREATE TYPE /
//     CREATE TABLE / CREATE INDEX. On any error the transaction is ROLLED BACK —
//     the target is left EMPTY, never partially provisioned, and nothing is
//     ever dropped to "clean up".
//   - No application data is inserted. Post-provision it asserts 0 rows in all
//     application tables and fails if that is not true.
//
// FAIL-CLOSED GATES (each one aborts with a non-zero exit and a report)
//   1. NEON_DIRECT_URL missing / unparseable / not postgres(ql):// / no role / no password
//   2. Pooled endpoint: hostname contains "-pooler" or "pgbouncer", or port 6543
//   3. sslmode=disable or sslmode=prefer (plaintext-capable) against production
//   4. make-postgres-schema.mjs --check fails (artifacts stale / drifted)
//   5. postgres-baseline.sql missing, empty, or not byte-identical to emitter output
//   6. Baseline contains any non-allowlisted or destructive statement
//   7. Target is NOT empty (any application table, any public enum, any
//      _prisma_migrations row/table) — reports exactly what was found, deletes nothing
//   8. Any SQL statement error (rolled back, exact failing statement reported)
//   9. Post-provision topology mismatch vs the parser-derived + documented counts
//  10. Any application row present after provisioning
//  11. verify-postgres.mjs exits non-zero or does not print VERIFY_POSTGRES_OK
//  12. Any protected file changed during the run
//
// ATOMICITY NOTE: the baseline is applied inside ONE transaction
// (BEGIN ... COMMIT). The task spec says "no transaction is required"; using one
// is strictly safer and satisfies "fail immediately on the first SQL error" —
// because ROLLBACK (not a DROP) leaves the Neon target provably EMPTY, so a
// failure can simply be re-run instead of needing manual object cleanup. This
// matters here because postgres-baseline.sql contains ZERO "IF NOT EXISTS"
// clauses, i.e. it is deliberately not idempotent.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  REPO,
  SCHEMA_PATH,
  PG_SCHEMA_PATH,
  BASELINE_SQL_PATH,
  MIGRATION_EXCLUDED_TABLES,
  parseSchema,
  scalarFields,
  fkEdges,
  emitPostgresDdl,
  splitSqlStatements,
  pgRowCounts,
  redactDatabaseUrl,
} from "./scripts/db/pg-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Documented expected topology for STEP 4. Cross-checked at runtime against the
// counts derived from prisma/schema.prisma — if the two disagree, that is schema
// drift and the script refuses to provision.
// ---------------------------------------------------------------------------
export const SPEC_EXPECTED = Object.freeze({
  enums: 21,
  tables: 55,
  secondaryIndexes: 67,
  foreignKeys: 73,
  uniqueConstraints: 34,
  primaryKeys: 55,
  applicationRows: 0,
  statements: 143, // 21 CREATE TYPE + 55 CREATE TABLE + 67 CREATE INDEX
});

// The SQLite source of truth (STEP 2). Read-only hash proof only.
const DEFAULT_SQLITE_PROOF_PATH = "E:\\workspace\\db\\custom.db";
const STEP2_EXPECTED_SQLITE_SHA256 =
  "883df488a5923fe7956c41497bba6eb8af030ac7eb2179244330f35a5ed53887";

// Files that must be byte-identical before and after the run.
const PROTECTED_FILES = [
  "prisma/schema.prisma",
  "prisma/schema.postgresql.prisma",
  "scripts/db/postgres-baseline.sql",
  "scripts/db/pg-lib.mjs",
  "scripts/db/verify-postgres.mjs",
  "scripts/db/make-postgres-schema.mjs",
  "scripts/db/migrate-sqlite-to-postgres.mjs",
  "package.json",
  "package-lock.json",
];

// Referential-action clauses that legitimately contain the words DELETE/UPDATE.
const ON_ACTION_CLAUSE = /\bON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)\b/gi;
const FORBIDDEN_TOKENS = [
  "DROP", "TRUNCATE", "DELETE", "UPDATE", "INSERT", "COPY", "ALTER",
  "GRANT", "REVOKE", "DO", "CALL", "EXECUTE", "VACUUM", "REINDEX", "CLUSTER",
];
const ALLOWED_STATEMENT = /^CREATE\s+(?:TYPE|TABLE|INDEX)\b/i;

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------
let RAW_URL = "";
let RAW_PASSWORD = "";

/** Redact the target connection string and password out of ANY text. */
export function scrub(text) {
  if (typeof text !== "string") return text;
  let out = text;
  if (RAW_URL) out = out.split(RAW_URL).join("[REDACTED-CONNECTION-STRING]");
  if (RAW_PASSWORD && RAW_PASSWORD.length >= 4) {
    out = out.split(RAW_PASSWORD).join("[REDACTED-PASSWORD]");
  }
  // Defence in depth: any credential-bearing postgres URL that reached us by
  // another route (driver error text, child-process output).
  out = out.replace(
    /(postgres(?:ql)?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    (_m, proto, user) => `${proto}${user}:[REDACTED-PASSWORD]@`,
  );
  return out;
}

const say = (...args) => console.log(scrub(args.map(String).join(" ")));
const warn = (...args) => console.error(scrub(args.map(String).join(" ")));
const rule = (title) => say(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);

/** Fatal, fail-closed abort. Always prints the report block. */
class StepError extends Error {
  constructor(stage, message, extra = {}) {
    super(message);
    this.stage = stage;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------------------
// Catalog SQL (identical to the queries validated against a real PostgreSQL
// engine during the STEP 4 disposable-target rehearsal)
// ---------------------------------------------------------------------------
export const CATALOG_SQL = Object.freeze({
  version: "SELECT current_setting('server_version') AS server_version, version() AS version_full",
  database: "SELECT current_database() AS db, current_user AS usr, inet_server_port() AS server_port",
  schema: "SELECT current_schema() AS current_schema, current_schemas(false) AS search_path_schemas",
  publicTables: "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
  publicEnums: `SELECT t.typname AS name
                  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'public' AND t.typtype = 'e'
                 ORDER BY 1`,
  publicOthers: `SELECT c.relname AS name, c.relkind AS kind
                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relkind IN ('v','m','S','f')
                  ORDER BY 1`,
  nonSystemSchemas: `SELECT nspname AS name FROM pg_namespace
                      WHERE nspname <> 'public'
                        AND nspname <> 'information_schema'
                        AND nspname NOT LIKE 'pg\\_%'
                      ORDER BY 1`,
  secondaryIndexes: `SELECT c.relname AS name, t.relname AS table_name
                       FROM pg_index i
                       JOIN pg_class c ON c.oid = i.indexrelid
                       JOIN pg_class t ON t.oid = i.indrelid
                       JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'public' AND NOT i.indisunique AND NOT i.indisprimary
                      ORDER BY 1`,
  allIndexRelations: `SELECT count(*)::int AS n
                        FROM pg_index i
                        JOIN pg_class c ON c.oid = i.indexrelid
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'public'`,
  constraintsByType: `SELECT c.contype AS kind, count(*)::int AS n
                        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                       WHERE n.nspname = 'public'
                       GROUP BY c.contype ORDER BY 1`,
  foreignKeys: `SELECT c.conname AS name,
                       c.conrelid::regclass::text AS table_name,
                       f.relname AS references_table,
                       array_length(c.conkey, 1) AS column_count
                  FROM pg_constraint c
                  JOIN pg_namespace n ON n.oid = c.connamespace
                  LEFT JOIN pg_class f ON f.oid = c.confrelid
                 WHERE n.nspname = 'public' AND c.contype = 'f'
                 ORDER BY 1`,
  // enumlabel is `name`-typed, so array_agg(enumlabel) yields name[] (OID 1003),
  // which pg does NOT parse into a JS array. The ::text cast makes it text[]
  // (OID 1009), which pg DOES parse; toArray() remains as a second layer.
  enumValues: `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
                 FROM pg_type t
                 JOIN pg_namespace n ON n.oid = t.typnamespace
                 JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE n.nspname = 'public' AND t.typtype = 'e'
                GROUP BY t.typname ORDER BY 1`,
});

// ---------------------------------------------------------------------------
// PostgreSQL array-column normalization
//
// WHY THIS EXISTS: `pg` (via pg-types@2.2.0) registers array parsers for OIDs
// 1000/1001/1005/1007/1009/1014/1015/1016/1017/1021/1022/1028/1115/1231/651/718
// — but NOT for OID 1003 (`name[]`). Both `current_schemas(false)` and
// `array_agg(<name-typed column>)` return `name[]`, so over a REAL `pg`
// connection the driver hands back the raw PostgreSQL array literal as a
// STRING — e.g. "{public}" — which has no .join() and no .map().
//
// PGlite returns a genuine JS array instead, which is why this never showed up
// in offline rehearsal and only appeared against live Neon (PostgreSQL 17.11).
//
// These helpers are used for DISPLAY / REPORTING ONLY. They are never used by
// the emptiness gate, the destructive-SQL scan, or any provisioning decision,
// so no safety gate is weakened.
// ---------------------------------------------------------------------------

/** Parse a PostgreSQL array literal such as `{public}`, `{a,b}`, `{"x y",NULL}`. */
export function parsePgArrayLiteral(text) {
  const s = String(text).trim();
  if (!s) return [];
  if (!s.startsWith("{") || !s.endsWith("}")) {
    // Not an array literal (defensive): treat it as a bare comma-separated list.
    return s.split(",").map((x) => x.trim()).filter((x) => x !== "" && x !== "NULL");
  }
  const inner = s.slice(1, -1);
  if (!inner.trim()) return []; // "{}" is the empty array
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inQuotes) {
      if (c === "\\") { const nx = inner[i + 1]; if (nx !== undefined) { cur += nx; i++; } continue; }
      if (c === '"') {
        if (inner[i + 1] === '"') { cur += '"'; i++; continue; } // escaped quote
        inQuotes = false;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.filter((x) => x !== "NULL");
}

/**
 * Normalize an array-typed column value into a JS array of strings.
 * Handles: JS Array | PostgreSQL array literal string | null | undefined |
 * any other shape. Never throws.
 */
export function toArray(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.filter((v) => v !== null && v !== undefined).map((v) => String(v));
  }
  if (typeof value === "string") return parsePgArrayLiteral(value);
  return [String(value)]; // object/number/boolean: degrade to one element
}

// ---------------------------------------------------------------------------
// Target URL assessment (no I/O — pure, unit-testable)
// ---------------------------------------------------------------------------
export function assessTargetUrl(raw) {
  const problems = [];
  const notices = [];
  const base = {
    ok: false, problems, notices,
    protocol: null, host: null, port: null, database: null, user: null,
    sslmode: null, sslmodeDefaulted: false, pooled: false, direct: false,
    effectiveUrl: null,
  };
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    problems.push("NEON_DIRECT_URL is empty or not set in the environment");
    return base;
  }
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    problems.push("NEON_DIRECT_URL is not a parseable URL (expected postgresql://user:password@host/db?sslmode=require)");
    return base;
  }
  base.protocol = u.protocol;
  if (!/^postgres(ql)?:$/.test(u.protocol)) {
    problems.push(`unsupported protocol "${u.protocol}" — expected postgres:// or postgresql://`);
  }
  const host = (u.hostname || "").toLowerCase();
  const port = u.port ? Number(u.port) : 5432;
  const database = u.pathname.replace(/^\//, "") || null;
  if (!host) problems.push("hostname is empty");
  if (!u.username) problems.push("connection string contains no user/role");
  if (!u.password) problems.push("connection string contains no password");

  // Pooled-endpoint detection (hard fail — DDL must go to the DIRECT endpoint).
  const pooled = host.includes("-pooler") || host.includes("pgbouncer") || port === 6543;
  if (host.includes("-pooler")) {
    problems.push(`hostname "${host}" contains "-pooler": this is a Neon POOLED endpoint`);
  }
  if (host.includes("pgbouncer")) {
    problems.push(`hostname "${host}" contains "pgbouncer": this is a pooled endpoint`);
  }
  if (port === 6543) {
    problems.push("port 6543 is the PgBouncer/pooled port; schema DDL requires the DIRECT endpoint (5432)");
  }

  // TLS. Neon requires it; pg's default with no sslmode is PLAINTEXT.
  const sslmode = (u.searchParams.get("sslmode") || "").toLowerCase();
  let effectiveUrl = trimmed;
  if (!sslmode) {
    notices.push("sslmode absent — pg would connect in PLAINTEXT; defaulting to sslmode=require (Neon requires TLS)");
    effectiveUrl += (effectiveUrl.includes("?") ? "&" : "?") + "sslmode=require";
    base.sslmodeDefaulted = true;
  } else if (sslmode === "disable") {
    problems.push("sslmode=disable is not permitted against a production Neon target");
  } else if (sslmode === "prefer") {
    problems.push("sslmode=prefer can silently fall back to plaintext; use require or verify-full");
  } else if (!["require", "verify-ca", "verify-full"].includes(sslmode)) {
    problems.push(`unsupported sslmode "${sslmode}"`);
  }

  return {
    ...base,
    ok: problems.length === 0,
    host, port, database, user: u.username || null,
    sslmode: sslmode || "require (defaulted by this script)",
    pooled,
    direct: !pooled,
    effectiveUrl,
  };
}

// ---------------------------------------------------------------------------
// Baseline safety scan
// ---------------------------------------------------------------------------
// Comments are replaced with a space and the result is TRIMMED: splitSqlStatements
// attaches a section's leading `-- ...` comment to the first statement that
// follows it, so without the trim that statement would begin with whitespace and
// the ^CREATE anchor would miss it (misclassifying a valid CREATE TYPE/TABLE/INDEX).
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim();
}

/**
 * Allowlist + blocklist scan of the baseline. Returns
 * { statements, attempted, blank, violations }.
 * `violations` non-empty => refuse to provision.
 */
export function scanBaseline(sql) {
  const raw = splitSqlStatements(sql);
  const statements = [];
  const violations = [];
  let blank = 0;
  raw.forEach((stmt, i) => {
    const body = stripSqlComments(stmt);
    if (!body.replace(/;/g, "").trim()) {
      blank++;
      return;
    }
    const index = statements.length + 1;
    if (!ALLOWED_STATEMENT.test(body)) {
      violations.push({ index, statement: i + 1, reason: "statement is not CREATE TYPE / CREATE TABLE / CREATE INDEX", text: body.slice(0, 160) });
    }
    const withoutActions = body.replace(ON_ACTION_CLAUSE, " ");
    for (const token of FORBIDDEN_TOKENS) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`, "i");
      if (re.test(withoutActions)) {
        violations.push({ index, statement: i + 1, reason: `forbidden SQL token "${token}"`, text: body.slice(0, 160) });
      }
    }
    statements.push({ index, text: stmt });
  });
  return { statements, attempted: statements.length, blank, violations };
}

// ---------------------------------------------------------------------------
// Topology expectations derived from prisma/schema.prisma via the repo's parser
// ---------------------------------------------------------------------------
export function expectedTopology(parsed) {
  let primaryKeys = 0;
  let fieldUnique = 0;
  let blockUnique = 0;
  let foreignKeys = 0;
  let secondaryIndexes = 0;
  for (const name of parsed.order) {
    const model = parsed.models.get(name);
    const cols = scalarFields(model);
    primaryKeys += cols.filter((c) => c.isId).length;
    fieldUnique += cols.filter((c) => c.unique && !c.isId).length;
    blockUnique += model.uniques.length;
    foreignKeys += fkEdges(model).length;
    secondaryIndexes += model.indexes.length;
  }
  return {
    enums: parsed.enums.size,
    tables: parsed.models.size,
    primaryKeys,
    uniqueConstraints: fieldUnique + blockUnique,
    uniqueFieldLevel: fieldUnique,
    uniqueBlockLevel: blockUnique,
    foreignKeys,
    secondaryIndexes,
    statements: parsed.enums.size + parsed.models.size + secondaryIndexes,
    modelNames: [...parsed.models.keys()],
    enumNames: [...parsed.enums.keys()],
  };
}

// ---------------------------------------------------------------------------
// Live topology measurement. `q` is any async (sql, params) => { rows } executor
// — a pg Client.query for Neon, or the repo's pgliteBackend for testing.
// ---------------------------------------------------------------------------
export async function measureTopology(q) {
  const rowsOf = async (sql, params) => (await q(sql, params || [])).rows;

  const tables = (await rowsOf(CATALOG_SQL.publicTables)).map((r) => r.name);
  const enums = (await rowsOf(CATALOG_SQL.publicEnums)).map((r) => r.name);
  const others = await rowsOf(CATALOG_SQL.publicOthers);
  const extraSchemas = (await rowsOf(CATALOG_SQL.nonSystemSchemas)).map((r) => r.name);
  const secondaryIndexes = await rowsOf(CATALOG_SQL.secondaryIndexes);
  const allIndexRelations = (await rowsOf(CATALOG_SQL.allIndexRelations))[0].n;
  const constraints = await rowsOf(CATALOG_SQL.constraintsByType);
  const fks = await rowsOf(CATALOG_SQL.foreignKeys);

  const cmap = {};
  for (const r of constraints) cmap[r.kind] = Number(r.n);

  const applicationTables = tables.filter((t) => !MIGRATION_EXCLUDED_TABLES.has(t));
  const hasPrismaMigrationsTable = tables.some((t) => MIGRATION_EXCLUDED_TABLES.has(t));
  const counts = applicationTables.length ? await pgRowCounts(q, applicationTables) : {};
  const applicationRows = Object.values(counts).reduce((a, b) => a + Number(b), 0);
  const nonEmptyTables = Object.entries(counts).filter(([, n]) => Number(n) > 0);

  return {
    tables,
    applicationTables,
    tableCount: applicationTables.length,
    hasPrismaMigrationsTable,
    enums,
    enumCount: enums.length,
    otherObjects: others,
    extraSchemas,
    secondaryIndexCount: secondaryIndexes.length,
    secondaryIndexes,
    allIndexRelations: Number(allIndexRelations),
    primaryKeys: cmap.p || 0,
    uniqueConstraints: cmap.u || 0,
    foreignKeys: cmap.f || 0,
    foreignKeyColumnCount: fks.reduce((a, r) => a + Number(r.column_count || 0), 0),
    foreignKeyDetail: fks,
    checkConstraints: cmap.c || 0,
    counts,
    applicationRows,
    nonEmptyTables,
  };
}

/** Compare a measured topology against expectations; returns mismatch strings. */
export function diffTopology(measured, expected) {
  const mismatches = [];
  const cmp = (label, got, want) => {
    if (Number(got) !== Number(want)) mismatches.push(`${label}: expected ${want}, found ${got}`);
  };
  // Defensive default: expectedTopology() describes SCHEMA only, so it carries no
  // row expectation. A schema-only provisioning step must always find 0 rows.
  const wantRows = expected.applicationRows === undefined ? SPEC_EXPECTED.applicationRows : expected.applicationRows;
  cmp("enums", measured.enumCount, expected.enums);
  cmp("application tables", measured.tableCount, expected.tables);
  cmp("secondary indexes", measured.secondaryIndexCount, expected.secondaryIndexes);
  cmp("primary keys", measured.primaryKeys, expected.primaryKeys);
  cmp("foreign keys", measured.foreignKeys, expected.foreignKeys);
  cmp("unique constraints", measured.uniqueConstraints, expected.uniqueConstraints);
  cmp("application rows", measured.applicationRows, wantRows);

  const expectedSet = new Set(expected.modelNames);
  const gotSet = new Set(measured.applicationTables);
  const missing = [...expectedSet].filter((t) => !gotSet.has(t)).sort();
  const extra = [...gotSet].filter((t) => !expectedSet.has(t)).sort();
  if (missing.length) mismatches.push(`missing tables (${missing.length}): ${missing.join(", ")}`);
  if (extra.length) mismatches.push(`unexpected tables (${extra.length}): ${extra.join(", ")}`);
  return { mismatches, missing, extra };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function sha256FileStream(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (d) => hash.update(d));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function fingerprints() {
  const out = {};
  for (const rel of PROTECTED_FILES) {
    const abs = path.join(SCRIPT_DIR, rel);
    out[rel] = fs.existsSync(abs) ? sha256File(abs) : null;
  }
  return out;
}

function gitStatusLines() {
  try {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: SCRIPT_DIR, encoding: "utf8", timeout: 60000 });
    if (r.status !== 0) return [`git status unavailable (exit ${r.status})`];
    const lines = String(r.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines : ["(clean: no modified or untracked files)"];
  } catch (e) {
    return [`git status unavailable (${e?.message || e})`];
  }
}

function runNodeChild(args, { env = process.env, timeout = 600000 } = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd: SCRIPT_DIR,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return {
    status: r.status,
    error: r.error ? String(r.error.message || r.error) : null,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || ""),
  };
}

// ---------------------------------------------------------------------------
// Report state (accumulated so the block always prints, even on failure)
// ---------------------------------------------------------------------------
const R = {
  status: "FAIL",
  mode: "provision",
  stage: "init",
  fatal: null,
  connection: { direct_connection: null, pooled_hostname_detected: null, database_name: null, postgres_version: null },
  before: { application_tables: null, application_enums: null, application_rows: null },
  provisioning: { baseline_file: "scripts/db/postgres-baseline.sql", statements_attempted: null, statements_succeeded: 0, statements_failed: null },
  after: { enums: null, tables: null, secondary_indexes: null, primary_keys: null, foreign_keys: null, unique_constraints: null, application_rows: null },
  verification: { "verify-postgres status": null, "checks passed": null },
  safety: {
    sqlite_modified: "NO",
    data_migration_performed: "NO",
    destructive_sql_executed: "NO",
    secrets_written: "NO",
    secrets_printed: "NO",
  },
  git_status: [],
};

function printReport() {
  const L = [];
  L.push("===CM-STEP4-REPORT-BEGIN===");
  L.push("");
  L.push(`STEP4A_SCRIPT_STATUS: ${R.status}`);
  L.push(`mode: ${R.mode}`);
  if (R.fatal) L.push(`failed_at_stage: ${R.stage}`);
  if (R.fatal) L.push(`failure_reason: ${R.fatal}`);
  L.push("");
  const section = (name, obj) => {
    L.push(`${name}:`);
    for (const [k, v] of Object.entries(obj)) {
      L.push(`- ${k}: ${Array.isArray(v) ? (v.length ? "" : "(none)") : v === null || v === undefined ? "NOT MEASURED" : v}`);
      if (Array.isArray(v)) for (const item of v) L.push(`    ${item}`);
    }
    L.push("");
  };
  section("connection", R.connection);
  section("before", R.before);
  section("provisioning", R.provisioning);
  section("after", R.after);
  section("verification", R.verification);
  section("safety", R.safety);
  section("git_status", { modified_or_untracked_files: R.git_status });
  L.push("===CM-STEP4-REPORT-END===");
  say(L.join("\n"));
}

// ---------------------------------------------------------------------------
// verify-postgres.mjs battery — EMPTY-TARGET mode (never --expect-fixtures)
// ---------------------------------------------------------------------------
function runVerifyBattery(effectiveUrl) {
  // The secret is handed to the child through its OWN environment, never via
  // argv: verify-postgres.mjs resolves its target as
  //   argOf(argv,"--target") || process.env.DATABASE_URL || process.env.POSTGRES_URL
  // so DATABASE_URL is functionally identical to --target "$NEON_DIRECT_URL"
  // while keeping the connection string out of the process listing and out of
  // any shell history. --expect-fixtures is NEVER passed: that is the migrated-
  // data drill mode and would be wrong for a schema-only empty target.
  const childEnv = { ...process.env, DATABASE_URL: effectiveUrl };
  delete childEnv.POSTGRES_URL;
  delete childEnv.NEON_DIRECT_URL;

  const args = [path.join("scripts", "db", "verify-postgres.mjs")];
  say(`\nrunning: node ${args[0]}   (target supplied via child env DATABASE_URL; --expect-fixtures NOT passed)`);
  const r = runNodeChild(args, { env: childEnv, timeout: 600000 });
  const out = `${r.stdout}\n${r.stderr}`;
  say("--- verify-postgres output (scrubbed) ---");
  for (const line of out.split("\n")) if (line.trim()) say(`  ${line}`);
  say("--- end verify-postgres output ---");

  if (r.error) throw new StepError("verify", `verify-postgres.mjs could not be executed: ${r.error}`);
  const m = /(\d+)\/(\d+)\s+checks passed/.exec(out);
  R.verification["checks passed"] = m ? `${m[1]}/${m[2]}` : null;
  const okToken = /\bVERIFY_POSTGRES_OK\b/.test(out);
  R.verification["verify-postgres status"] = okToken ? "VERIFY_POSTGRES_OK" : `exit ${r.status} (no VERIFY_POSTGRES_OK)`;

  if (r.status !== 0 || !okToken) {
    const failed = /VERIFY FAILED:([^\n]*)/.exec(out);
    throw new StepError("verify", `verify-postgres.mjs did not pass (exit ${r.status})${failed ? ` — failing checks:${failed[1]}` : ""}`);
  }
  if (!m || m[1] !== m[2]) {
    throw new StepError("verify", `verify-postgres.mjs reported partial success: ${m ? `${m[1]}/${m[2]}` : "unparsed"}`);
  }
  return { passed: Number(m[1]), total: Number(m[2]) };
}

// ---------------------------------------------------------------------------
// Immutability / safety finalization. Module-level and idempotent so it runs
// EXACTLY once no matter where main() aborts — including the early gates
// (target-url, artifacts) that fail before the database try/finally is entered.
// ---------------------------------------------------------------------------
const SAFETY = { reported: false, fpBefore: null, sqlitePath: null, sqliteBefore: null, sqliteNote: null };

async function finalizeSafety() {
  if (SAFETY.reported) return;
  SAFETY.reported = true;
  const { fpBefore, sqlitePath, sqliteBefore, sqliteNote } = SAFETY;

  R.stage = R.fatal ? R.stage : "immutability";
  rule("7. IMMUTABILITY / SAFETY PROOF");
  const fpAfter = fingerprints();
  const changed = fpBefore ? PROTECTED_FILES.filter((rel) => fpBefore[rel] !== fpAfter[rel]) : [];
  for (const rel of PROTECTED_FILES) {
    say(`${changed.includes(rel) ? "CHANGED " : "unchanged"}  ${rel.padEnd(42)} ${fpAfter[rel] ? fpAfter[rel].slice(0, 16) + "..." : "(missing)"}`);
  }
  if (changed.length) {
    if (!R.fatal) { R.fatal = `protected repository file(s) changed during the run: ${changed.join(", ")}`; R.stage = "immutability"; }
    else warn(`ALSO: protected repository file(s) changed during the run: ${changed.join(", ")}`);
  } else {
    say("OK  every protected repository file is byte-identical before and after");
  }

  let sqliteAfter = null;
  try {
    if (sqliteBefore) sqliteAfter = await sha256FileStream(sqlitePath);
  } catch (e) {
    say(`sqlite re-hash unavailable (${e?.code || e?.message || e})`);
  }
  if (sqliteBefore && sqliteAfter) {
    const same = sqliteBefore === sqliteAfter;
    say(`sqlite source sha256 before : ${sqliteBefore}`);
    say(`sqlite source sha256 after  : ${sqliteAfter}`);
    say(`sqlite source unchanged     : ${same ? "YES" : "NO — STOP AND INVESTIGATE"}`);
    say(`matches STEP 2 expected     : ${sqliteBefore === STEP2_EXPECTED_SQLITE_SHA256 ? "YES" : "NO (differs from the STEP 2 digest)"}`);
    R.safety.sqlite_modified = same ? "NO" : "YES";
    if (!same && !R.fatal) { R.fatal = "the SQLite source changed during the run"; R.stage = "immutability"; }
  } else {
    say(`sqlite source               : never opened for writing; ${sqliteNote || "immutability proof not started"}`);
    R.safety.sqlite_modified = "NO";
  }
  say(`data migration performed    : NO (migrate-sqlite-to-postgres.mjs was never executed)`);
  say(`destructive SQL executed    : NO (only allowlisted CREATE TYPE/TABLE/INDEX were sent)`);
  say(`secrets written to disk     : NO (this script writes no files)`);
  say(`secrets printed             : NO (all output passes through scrub())`);

  R.git_status = gitStatusLines();
  say(`\ngit status --porcelain (${R.git_status.length} line(s)):`);
  for (const l of R.git_status) say(`  ${l}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  R.mode = dryRun ? "dry-run" : "provision";
  SAFETY.fpBefore = fingerprints();
  SAFETY.sqlitePath = process.env.CM_SQLITE_PROOF_PATH || DEFAULT_SQLITE_PROOF_PATH;
  const sqlitePath = SAFETY.sqlitePath;
  let sqliteBefore = null;
  let sqliteNote = null;

  rule("STEP 4A — NEON POSTGRESQL SCHEMA PROVISIONING (schema-only, no data)");
  say(`script        : ${path.join(SCRIPT_DIR, "step4-neon-provision.mjs")}`);
  say(`repo root     : ${REPO}`);
  say(`mode          : ${R.mode}${dryRun ? "  (precheck + validation only; NO DDL will be applied)" : ""}`);
  say(`node          : ${process.version}`);
  say(`platform      : ${process.platform}`);

  // ---- Read-only SQLite immutability proof (never opens it for writing) ----
  try {
    if (fs.existsSync(sqlitePath) && fs.statSync(sqlitePath).isFile()) {
      sqliteBefore = await sha256FileStream(sqlitePath);
      sqliteNote = `read-only SHA-256 captured for ${sqlitePath}`;
    } else {
      sqliteNote = `${sqlitePath} not present on this machine — immutability proof unavailable (file was never opened)`;
    }
  } catch (e) {
    sqliteNote = `${sqlitePath} could not be read (${e?.code || e?.message || e}) — immutability proof unavailable (file was never opened)`;
  }
  say(`sqlite source : ${sqliteNote}`);
  SAFETY.sqliteBefore = sqliteBefore;
  SAFETY.sqliteNote = sqliteNote;

  // ---------------------------------------------------------------- 1. TARGET
  R.stage = "target-url";
  rule("1. TARGET CONNECTION STRING (from process.env.NEON_DIRECT_URL only)");
  const raw = process.env.NEON_DIRECT_URL;
  RAW_URL = String(raw ?? "").trim();
  try {
    RAW_PASSWORD = RAW_URL ? new URL(RAW_URL).password : "";
  } catch {
    RAW_PASSWORD = "";
  }
  if (RAW_PASSWORD) {
    try { RAW_PASSWORD = decodeURIComponent(RAW_PASSWORD); } catch { /* keep as-is */ }
  }
  if (!RAW_URL) {
    throw new StepError("target-url",
      "NEON_DIRECT_URL is not set. Set it in the current shell only, e.g.\n" +
      '  cmd:        set "NEON_DIRECT_URL=<Neon DIRECT connection string>"\n' +
      "  PowerShell: $env:NEON_DIRECT_URL = \"<Neon DIRECT connection string>\"\n" +
      "Then re-run: node step4-neon-provision.mjs");
  }

  const target = assessTargetUrl(RAW_URL);
  for (const n of target.notices) say(`NOTICE: ${n}`);
  R.connection.pooled_hostname_detected = target.host ? target.pooled : null;
  R.connection.direct_connection = target.host ? !target.pooled : null;
  R.connection.database_name = target.database;
  say(`protocol      : ${target.protocol || "(unparseable)"}`);
  say(`host          : ${target.host}`);
  say(`port          : ${target.port}`);
  say(`database      : ${target.database}`);
  say(`role          : ${target.user}`);
  say(`sslmode       : ${target.sslmode}`);
  say(`pooled host   : ${target.pooled ? "YES — FAIL CLOSED" : "no"}`);
  say(`direct usable : ${target.direct ? "yes" : "no"}`);
  say(`redacted      : ${redactDatabaseUrl(target.effectiveUrl)}`);
  if (!target.ok) {
    throw new StepError("target-url", `target connection string rejected:\n  - ${target.problems.join("\n  - ")}`);
  }
  const effectiveUrl = target.effectiveUrl;
  R.connection.direct_connection = true;
  R.connection.pooled_hostname_detected = false;
  R.connection.database_name = target.database;

  // ------------------------------------------------- 2. ARTIFACT VALIDATION
  R.stage = "artifacts";
  rule("2. REPOSITORY ARTIFACT VALIDATION (read-only)");
  for (const rel of ["prisma/schema.prisma", "prisma/schema.postgresql.prisma", "scripts/db/postgres-baseline.sql",
    "scripts/db/pg-lib.mjs", "scripts/db/make-postgres-schema.mjs", "scripts/db/verify-postgres.mjs"]) {
    const abs = path.join(SCRIPT_DIR, rel);
    if (!fs.existsSync(abs)) throw new StepError("artifacts", `required artifact missing: ${rel}`);
    say(`PRESENT  ${rel.padEnd(42)} ${String(fs.statSync(abs).size).padStart(7)} bytes`);
  }

  // 2a. staleness gate — the repository's own checker, --check is read-only
  const check = runNodeChild([path.join("scripts", "db", "make-postgres-schema.mjs"), "--check"], { timeout: 300000 });
  const checkOut = `${check.stdout}\n${check.stderr}`;
  for (const line of checkOut.split("\n")) if (line.trim()) say(`  ${line.trim()}`);
  const schemaInSync = /schema\.postgresql\.prisma:\s*in sync/.test(checkOut);
  const baselineInSync = /postgres-baseline\.sql:\s*in sync/.test(checkOut);
  if (check.status !== 0 || !schemaInSync || !baselineInSync) {
    throw new StepError("artifacts",
      `make-postgres-schema.mjs --check failed (exit ${check.status}; schema in sync=${schemaInSync}, baseline in sync=${baselineInSync}). ` +
      "The derived artifacts are stale — resolve the drift before provisioning. This script does NOT regenerate them.");
  }
  say("OK  prisma/schema.postgresql.prisma in sync; scripts/db/postgres-baseline.sql in sync (neither is stale)");

  // 2b. provider + baseline byte-equality
  const pgSchemaText = fs.readFileSync(PG_SCHEMA_PATH, "utf8");
  const providerMatches = pgSchemaText.match(/provider\s*=\s*"postgresql"/g) || [];
  if (providerMatches.length !== 1) throw new StepError("artifacts", `schema.postgresql.prisma must contain exactly 1 postgresql provider line, found ${providerMatches.length}`);
  if (/provider\s*=\s*"sqlite"/.test(pgSchemaText)) throw new StepError("artifacts", "schema.postgresql.prisma still contains a sqlite provider line");
  say("OK  schema.postgresql.prisma provider = postgresql (exactly 1)");

  const baselineSql = fs.readFileSync(BASELINE_SQL_PATH, "utf8");
  if (!baselineSql.trim()) throw new StepError("artifacts", "postgres-baseline.sql is empty");
  let parsed;
  try {
    parsed = parseSchema(SCHEMA_PATH);
  } catch (e) {
    throw new StepError("artifacts", `prisma/schema.prisma could not be parsed: ${e?.message || e}`);
  }
  const emitted = emitPostgresDdl(parsed);
  if (emitted !== baselineSql) {
    throw new StepError("artifacts", "postgres-baseline.sql is NOT byte-identical to emitPostgresDdl(parseSchema()) — baseline is stale or hand-edited");
  }
  say(`OK  postgres-baseline.sql is byte-identical to emitter output (${Buffer.byteLength(baselineSql)} bytes)`);

  // 2c. derived expectations vs documented expectations
  const expected = expectedTopology(parsed);
  const drift = [];
  const cmpExp = (label, got, want) => { if (got !== want) drift.push(`${label}: parser-derived ${got} != documented ${want}`); };
  cmpExp("enums", expected.enums, SPEC_EXPECTED.enums);
  cmpExp("tables", expected.tables, SPEC_EXPECTED.tables);
  cmpExp("secondary indexes", expected.secondaryIndexes, SPEC_EXPECTED.secondaryIndexes);
  cmpExp("foreign keys", expected.foreignKeys, SPEC_EXPECTED.foreignKeys);
  cmpExp("unique constraints", expected.uniqueConstraints, SPEC_EXPECTED.uniqueConstraints);
  cmpExp("primary keys", expected.primaryKeys, SPEC_EXPECTED.primaryKeys);
  cmpExp("statements", expected.statements, SPEC_EXPECTED.statements);
  if (drift.length) throw new StepError("artifacts", `schema drift — derived topology does not match the documented STEP 4 topology:\n  - ${drift.join("\n  - ")}`);
  say(`OK  derived topology matches the documented expectation exactly:`);
  say(`      enums=${expected.enums} tables=${expected.tables} secondary_indexes=${expected.secondaryIndexes}`);
  say(`      foreign_keys=${expected.foreignKeys} unique=${expected.uniqueConstraints} (${expected.uniqueFieldLevel} field @unique + ${expected.uniqueBlockLevel} @@unique) primary_keys=${expected.primaryKeys}`);

  // 2d. destructive-SQL scan
  const scan = scanBaseline(baselineSql);
  R.provisioning.statements_attempted = scan.attempted;
  say(`OK  splitSqlStatements -> ${scan.attempted} statements (${scan.blank} blank/comment-only skipped)`);
  const census = {};
  for (const s of scan.statements) {
    const kind = (ALLOWED_STATEMENT.exec(stripSqlComments(s.text)) || ["", "?"])[0].replace(/\s+/g, " ").toUpperCase();
    census[kind] = (census[kind] || 0) + 1;
  }
  for (const [k, v] of Object.entries(census).sort()) say(`      ${String(v).padStart(4)} x ${k}`);
  if (scan.attempted !== SPEC_EXPECTED.statements) {
    throw new StepError("artifacts", `baseline statement count ${scan.attempted} != expected ${SPEC_EXPECTED.statements}`);
  }
  if (scan.violations.length) {
    const detail = scan.violations.slice(0, 8).map((v) => `stmt #${v.index}: ${v.reason} :: ${v.text}`).join("\n  ");
    throw new StepError("artifacts", `destructive/disallowed SQL found in postgres-baseline.sql — refusing to apply:\n  ${detail}`);
  }
  say("OK  destructive scan clean: 0 DROP / TRUNCATE / DELETE / UPDATE / INSERT / COPY / ALTER / GRANT / REVOKE / DO");
  say("      (65 x 'ON DELETE …' and 73 x 'ON UPDATE …' referential-action clauses correctly excluded)");
  if (/\bIF NOT EXISTS\b/i.test(baselineSql)) {
    say("NOTE baseline contains IF NOT EXISTS — it is idempotent");
  } else {
    say("NOTE baseline contains 0 'IF NOT EXISTS' — it is deliberately NOT idempotent, so it is only ever applied to a proven-empty target");
  }

  // ---------------------------------------------------------------- 3. CONNECT
  R.stage = "connect";
  rule("3. NEON TARGET PRECHECK (read-only, before any DDL)");
  let pg;
  try {
    pg = (await import("pg")).default;
  } catch (e) {
    throw new StepError("connect", `the 'pg' package is not available (${e?.message || e}). Run 'npm ci' in the repository root first.`);
  }
  const { Client } = pg;
  const client = new Client({ connectionString: effectiveUrl, connectionTimeoutMillis: 20000 });
  let connected = false;
  let committed = false; // true ONLY after COMMIT succeeded — gates the verify battery
  try {
    await client.connect();
    connected = true;
    say("OK  connected to the Neon DIRECT endpoint");
  } catch (e) {
    const hint = /ssl|certificate|handshake/i.test(String(e?.message || ""))
      ? " (TLS problem — confirm the connection string carries sslmode=require)"
      : /timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(String(e?.message || ""))
        ? " (network/DNS/egress problem — confirm the host resolves and outbound 5432 is allowed)"
        : /authentication|password/i.test(String(e?.message || ""))
          ? " (authentication problem — confirm the role and password)"
          : "";
    throw new StepError("connect", `connection to the Neon target failed${hint}: ${e?.code ? `[${e.code}] ` : ""}${e?.message || e}`);
  }

  const q = (sql, params) => client.query(sql, params || []);
  try {
    const v = (await q(CATALOG_SQL.version)).rows[0];
    const d = (await q(CATALOG_SQL.database)).rows[0];
    const s = (await q(CATALOG_SQL.schema)).rows[0];
    R.connection.postgres_version = v.server_version;
    say(`server version      : ${v.server_version}`);
    say(`server version_full : ${v.version_full}`);
    say(`current_database()  : ${d.db}`);
    say(`current_user        : ${d.usr}`);
    say(`inet_server_port()  : ${d.server_port}`);
    say(`current_schema()    : ${s.current_schema}`);
    // current_schemas(false) is name[] (OID 1003): over a real `pg` connection
    // this arrives as the raw literal string "{public}", not a JS array.
    // Display/reporting only — never used by any safety gate.
  say(`search_path schemas : ${toArray(s.search_path_schemas).join(", ") || "(none)"}`);
    R.connection.database_name = d.db;
    if (d.db && target.database && d.db !== target.database) {
      say(`NOTICE: connected database "${d.db}" differs from the URL path "${target.database}"`);
    }

    // ---- emptiness gate ----
    R.stage = "precheck-empty";
    const before = await measureTopology(q);
    R.before.application_tables = before.tableCount;
    R.before.application_enums = before.enumCount;
    R.before.application_rows = before.applicationRows;
    say(`\npublic tables (${before.tables.length} total, ${before.tableCount} application):`);
    say(before.tables.length ? before.tables.map((t) => `  - ${t}`).join("\n") : "  (none)");
    say(`public enum types (${before.enumCount}):`);
    say(before.enums.length ? before.enums.map((t) => `  - ${t}`).join("\n") : "  (none)");
    if (before.hasPrismaMigrationsTable) say("  ! _prisma_migrations table IS present");
    say(`other public objects (views/matviews/sequences): ${before.otherObjects.length}` +
      (before.otherObjects.length ? "\n" + before.otherObjects.map((o) => `  - ${o.name} (${o.kind})`).join("\n") : ""));
    say(`non-system schemas besides public: ${before.extraSchemas.length ? before.extraSchemas.join(", ") : "(none)"}`);
    say(`application rows: ${before.applicationRows}`);

    // Blocking criteria are EXACTLY the task definition of an empty target:
    // zero application tables and zero application enum types (plus zero rows
    // and a pristine migration ledger). Extra schemas/objects are reported as
    // warnings, not blockers — they are not application tables or enums.
    const blockers = [];
    if (before.tableCount > 0) blockers.push(`${before.tableCount} application table(s) already exist: ${before.applicationTables.slice(0, 60).join(", ")}`);
    if (before.hasPrismaMigrationsTable) blockers.push("a _prisma_migrations table already exists (migration ledger is not pristine)");
    if (before.enumCount > 0) blockers.push(`${before.enumCount} public enum type(s) already exist: ${before.enums.slice(0, 40).join(", ")}`);
    if (before.applicationRows > 0) blockers.push(`${before.applicationRows} application row(s) already present`);
    if (before.extraSchemas.length) warn(`WARNING: non-system schema(s) besides public exist: ${before.extraSchemas.join(", ")} (not application tables/enums — not blocking)`);
    if (before.otherObjects.length) warn(`WARNING: ${before.otherObjects.length} non-table object(s) exist in public: ${before.otherObjects.map((o) => `${o.name}(${o.kind})`).join(", ")} (not blocking)`);

    if (blockers.length) {
      throw new StepError("precheck-empty",
        "TARGET IS NOT EMPTY — refusing to provision and deleting nothing.\n  - " + blockers.join("\n  - "));
    }
    say("\nOK  target proven EMPTY (0 application tables, 0 public enums, 0 rows, no _prisma_migrations, no extra schemas/objects)");

    if (dryRun) {
      R.stage = "dry-run";
      rule("DRY RUN — stopping before any DDL");
      say("The target is empty and every artifact validated. Re-run without --dry-run to provision.");
      R.provisioning.statements_attempted = scan.attempted;
      R.provisioning.statements_succeeded = 0;
      R.provisioning.statements_failed = 0;
      R.after = { enums: null, tables: null, secondary_indexes: null, primary_keys: null, foreign_keys: null, unique_constraints: null, application_rows: null };
      R.verification["verify-postgres status"] = "SKIPPED (dry-run)";
      R.verification["checks passed"] = "SKIPPED (dry-run)";
      R.status = "PASS";
      return { scan, expected, dryRun: true };
    }

    // ------------------------------------------------------------ 4. PROVISION
    R.stage = "provision";
    rule("4. PROVISIONING (scripts/db/postgres-baseline.sql, single transaction)");
    say(`baseline_file       : scripts/db/postgres-baseline.sql`);
    say(`statements_attempted: ${scan.attempted}`);
    say("transaction         : BEGIN ... COMMIT (ROLLBACK on the first error — target stays EMPTY)");
    await client.query("BEGIN");
    let succeeded = 0;
    try {
      for (const st of scan.statements) {
        try {
          await client.query(st.text);
        } catch (e) {
          R.provisioning.statements_failed = scan.attempted - succeeded;
          R.provisioning.statements_succeeded = succeeded;
          const firstLine = stripSqlComments(st.text).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2).join(" ");
          throw new StepError("provision",
            `statement ${st.index}/${scan.attempted} FAILED — rolled back, nothing was dropped.\n` +
            `  statement : ${firstLine.slice(0, 220)}\n` +
            `  pg error  : ${e?.code ? `[${e.code}] ` : ""}${e?.message || e}` +
            `${e?.detail ? `\n  detail    : ${e.detail}` : ""}${e?.hint ? `\n  hint      : ${e.hint}` : ""}` +
            `${e?.position ? `\n  position  : ${e.position}` : ""}`);
        }
        succeeded++;
        if (succeeded % 25 === 0 || succeeded === scan.attempted) say(`  ... ${succeeded}/${scan.attempted} statements applied`);
      }
      await client.query("COMMIT");
      committed = true;
    } catch (e) {
      try { await client.query("ROLLBACK"); say("  ROLLBACK issued — target left EMPTY"); } catch { /* already aborted */ }
      throw e;
    }
    R.provisioning.statements_succeeded = succeeded;
    R.provisioning.statements_failed = 0;
    say(`OK  ${succeeded}/${scan.attempted} statements applied and committed, 0 failed`);

    // ------------------------------------------------------- 5. POST-VALIDATION
    R.stage = "post-validate";
    rule("5. POST-PROVISION VALIDATION");
    const after = await measureTopology(q);
    R.after.enums = after.enumCount;
    R.after.tables = after.tableCount;
    R.after.secondary_indexes = after.secondaryIndexCount;
    R.after.primary_keys = after.primaryKeys;
    R.after.foreign_keys = after.foreignKeys;
    R.after.unique_constraints = after.uniqueConstraints;
    R.after.application_rows = after.applicationRows;

    say(`enums              : ${after.enumCount}   (expected ${SPEC_EXPECTED.enums})`);
    say(`application tables : ${after.tableCount}   (expected ${SPEC_EXPECTED.tables})`);
    say(`secondary indexes  : ${after.secondaryIndexCount}   (expected ${SPEC_EXPECTED.secondaryIndexes})`);
    say(`primary keys       : ${after.primaryKeys}   (expected ${SPEC_EXPECTED.primaryKeys})`);
    say(`foreign keys       : ${after.foreignKeys}   (expected ${SPEC_EXPECTED.foreignKeys})` +
      `   [FK columns: ${after.foreignKeyColumnCount}]`);
    say(`unique constraints : ${after.uniqueConstraints}   (expected ${SPEC_EXPECTED.uniqueConstraints})`);
    say(`index relations    : ${after.allIndexRelations} total in public = ${after.primaryKeys} PK + ${after.uniqueConstraints} UNIQUE-backing + ${after.secondaryIndexCount} plain secondary`);
    say(`application rows   : ${after.applicationRows}   (expected ${SPEC_EXPECTED.applicationRows})`);
    say(`_prisma_migrations : ${after.hasPrismaMigrationsTable ? "present (unexpected at this step)" : "absent (correct — the baseline does not create it)"}`);
    if (after.nonEmptyTables.length) {
      say(`NON-EMPTY TABLES   : ${after.nonEmptyTables.map(([t, n]) => `${t}=${n}`).join(", ")}`);
    }

    const diff = diffTopology(after, expected);
    if (diff.mismatches.length) {
      throw new StepError("post-validate", `post-provision topology does not match expectations:\n  - ${diff.mismatches.join("\n  - ")}`);
    }
    say("OK  every count matches the parser-derived and the documented STEP 4 topology exactly");

    const ev = (await q(CATALOG_SQL.enumValues)).rows;
    say(`\nenum definitions (${ev.length}):`);
    for (const r of ev) say(`  - ${r.name}: ${toArray(r.values).join(" | ")}`);
    const srcEnums = [...parsed.enums.entries()].map(([n, v]) => `${n}:${v.join("|")}`).sort();
    const liveEnums = ev.map((r) => `${r.name}:${toArray(r.values).join("|")}`).sort();
    if (srcEnums.join(",") !== liveEnums.join(",")) {
      throw new StepError("post-validate", "live enum labels do not match prisma/schema.prisma enum definitions");
    }
    say("OK  all 21 enum types carry exactly the labels declared in prisma/schema.prisma");
    return { scan, expected, dryRun: false };
  } finally {
    if (connected) { try { await client.end(); } catch { /* ignore */ } }

    // ------------------------------------------------------ 6. REPO BATTERY
    // Runs only if the baseline actually COMMITted. A rolled-back attempt leaves
    // the target empty, so running the battery then would be meaningless.
    if (committed) {
      try {
        R.stage = "verify-battery";
        rule("6. REPOSITORY VERIFICATION BATTERY (empty-target mode)");
        runVerifyBattery(effectiveUrl);
        say("OK  verify-postgres.mjs passed in EMPTY-TARGET mode");
      } catch (e) {
        R.fatal = scrub(e?.message || String(e));
        R.stage = e?.stage || R.stage;
      }
    }

    // ------------------------------------------- 7. IMMUTABILITY / SAFETY
    await finalizeSafety();
  }
}

function usage() {
  say(`step4-neon-provision.mjs — CodeMind Academy STEP 4A

Provisions the EMPTY Neon PostgreSQL target from the repository's existing
scripts/db/postgres-baseline.sql. Schema only. No application data is ever
inserted, and the SQLite source is never modified.

Usage:
  set "NEON_DIRECT_URL=<Neon DIRECT connection string>"   (cmd)
  node step4-neon-provision.mjs [--dry-run]

Options:
  --dry-run   Run every read-only gate (URL assessment, artifact validation,
              staleness check, destructive scan, Neon precheck + emptiness
              proof) and STOP before any DDL. Nothing is written.
  --help      Show this text.

Environment:
  NEON_DIRECT_URL         REQUIRED. The Neon DIRECT (not -pooler) connection
                          string. Read from the environment only; never
                          printed in full, never written to a file.
  CM_SQLITE_PROOF_PATH    Optional. Overrides the SQLite path used for the
                          read-only immutability hash proof
                          (default ${DEFAULT_SQLITE_PROOF_PATH}).

Exit code: 0 on PASS, 1 on any fail-closed condition.`);
}

const isMain = process.argv[1] && fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  usage();
  process.exit(0);
}

if (isMain) {
  main(process.argv.slice(2)).then(
    async () => {
      // Idempotent: normally already run from main()'s finally.
      await finalizeSafety().catch(() => {});
      if (!R.fatal) R.status = "PASS";
      printReport();
      process.exit(R.status === "PASS" ? 0 : 1);
    },
    async (e) => {
      R.fatal = scrub(e?.message || String(e));
      if (e?.stage) R.stage = e.stage;
      R.status = "FAIL";
      warn(`\nSTEP 4A ABORTED at stage "${R.stage}" — fail-closed.`);
      warn(R.fatal);
      if (!(e instanceof StepError)) warn(String(e?.stack || "").split("\n").slice(0, 6).join("\n"));
      // Guarantees the immutability/git section is reported even when main()
      // aborted at an early gate, before the database try/finally was entered.
      await finalizeSafety().catch(() => {});
      printReport();
      process.exit(1);
    },
  );
}