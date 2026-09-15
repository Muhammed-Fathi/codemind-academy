// CodeMind Academy — Phase 21: derive the PostgreSQL artifacts from the ONE schema.
//
//   node scripts/db/make-postgres-schema.mjs            regenerate both artifacts
//   node scripts/db/make-postgres-schema.mjs --check   fail if committed files drift
//
// There is exactly ONE schema source of truth (`prisma/schema.prisma`,
// provider sqlite). This script DERIVES, never authors:
//   1. prisma/postgres/schema.prisma — byte-copy with ONLY the datasource
//      provider swapped to postgresql (+ a derivation header). The cutover
//      operator points Prisma at this file; no model is ever edited here.
//   2. scripts/db/postgres-baseline.sql — baseline DDL emitted by pg-lib from
//      the current schema (enums, tables, constraints, indexes).
//
// The offline suite runs --check on every run: any drift between the source
// schema and the committed artifacts fails the build instead of shipping a
// stale cutover.

import fs from "node:fs";
import { SCHEMA_PATH, PG_SCHEMA_PATH, BASELINE_SQL_PATH, parseSchema, emitPostgresDdl } from "./pg-lib.mjs";

const HEADER = `// CodeMind Academy — PostgreSQL schema (DERIVED ARTIFACT).
//
// DO NOT EDIT. Generated from prisma/schema.prisma by
// scripts/db/make-postgres-schema.mjs — the ONLY difference from the source
// is the datasource provider below (sqlite -> postgresql). Every model, enum,
// index, unique and relation is byte-identical to the source.
//
// Regenerate: node scripts/db/make-postgres-schema.mjs
// Verify:     node scripts/db/make-postgres-schema.mjs --check
//
// WHY THIS FILE LIVES IN prisma/postgres/ (2026-09-15 Phase 26D hotfix)
//   Prisma reads the migrations directory NEXT TO the schema file. When this
//   schema lived directly in prisma/ it shared prisma/migrations with SQLite,
//   and \`migrate deploy --schema <this file>\` replayed SQLite-flavoured SQL
//   (DATETIME, …) on PostgreSQL — the Phase 26D production deploy failed with
//   \`type "datetime" does not exist\`. The schema now lives in prisma/postgres/
//   and owns prisma/postgres/migrations (provider = postgresql, baselined at
//   0_init = the pre-26D production schema); the SQLite schema keeps
//   prisma/migrations. NEVER move this file back next to schema.prisma and
//   NEVER point the PostgreSQL provider at prisma/migrations.
//
// Deploy use (see docs/POSTGRES_CUTOVER_RUNBOOK.md):
//   bunx prisma migrate deploy --schema prisma/postgres/schema.prisma

`;

export function renderPostgresSchema() {
  const src = fs.readFileSync(SCHEMA_PATH, "utf8");
  const matches = src.match(/provider\s*=\s*"sqlite"/g) || [];
  if (matches.length !== 1) {
    throw new Error(`make-postgres-schema: expected exactly 1 sqlite provider line, found ${matches.length}`);
  }
  const swapped = src.replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"');
  return HEADER + swapped;
}

function main() {
  const check = process.argv.includes("--check");
  const wantSchema = !process.argv.includes("--emit-ddl");
  const wantDdl = !process.argv.includes("--emit-schema");
  let failed = false;

  if (wantSchema) {
    const rendered = renderPostgresSchema();
    if (check) {
      const committed = fs.existsSync(PG_SCHEMA_PATH) ? fs.readFileSync(PG_SCHEMA_PATH, "utf8") : null;
      if (committed !== rendered) {
        console.error(`DRIFT: ${PG_SCHEMA_PATH} differs from prisma/schema.prisma (run: node scripts/db/make-postgres-schema.mjs)`);
        failed = true;
      } else {
        console.log("prisma/postgres/schema.prisma: in sync");
      }
    } else {
      fs.writeFileSync(PG_SCHEMA_PATH, rendered);
      console.log(`wrote ${PG_SCHEMA_PATH}`);
    }
  }

  if (wantDdl) {
    const ddl = emitPostgresDdl(parseSchema(SCHEMA_PATH));
    if (check) {
      const committed = fs.existsSync(BASELINE_SQL_PATH) ? fs.readFileSync(BASELINE_SQL_PATH, "utf8") : null;
      if (committed !== ddl) {
        console.error("DRIFT: scripts/db/postgres-baseline.sql differs from emitter output (run: node scripts/db/make-postgres-schema.mjs)");
        failed = true;
      } else {
        console.log("postgres-baseline.sql: in sync");
      }
    } else {
      fs.writeFileSync(BASELINE_SQL_PATH, ddl);
      console.log(`wrote ${BASELINE_SQL_PATH}`);
    }
  }

  if (failed) process.exit(1);
}

main();
