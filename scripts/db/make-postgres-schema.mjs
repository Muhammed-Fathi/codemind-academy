// CodeMind Academy — Phase 21: derive the PostgreSQL artifacts from the ONE schema.
//
//   node scripts/db/make-postgres-schema.mjs            regenerate both artifacts
//   node scripts/db/make-postgres-schema.mjs --check   fail if committed files drift
//
// There is exactly ONE schema source of truth (`prisma/schema.prisma`,
// provider sqlite). This script DERIVES, never authors:
//   1. prisma/schema.postgresql.prisma — byte-copy with ONLY the datasource
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

const HEADER = `// CodeMind Academy — Phase 21 PostgreSQL schema (DERIVED ARTIFACT).
//
// DO NOT EDIT. Generated from prisma/schema.prisma by
// scripts/db/make-postgres-schema.mjs — the ONLY difference from the source
// is the datasource provider below (sqlite -> postgresql). Every model, enum,
// index, unique and relation is byte-identical to the source.
//
// Regenerate: node scripts/db/make-postgres-schema.mjs
// Verify:     node scripts/db/make-postgres-schema.mjs --check
//
// Cutover use: point Prisma at THIS file on the production host
// (see docs/POSTGRES_CUTOVER_RUNBOOK.md), then baseline the migration history
// with \`prisma migrate resolve --applied\`. Old SQLite migrations are never
// rewritten or replayed on PostgreSQL.

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
        console.error("DRIFT: prisma/schema.postgresql.prisma differs from prisma/schema.prisma (run: node scripts/db/make-postgres-schema.mjs)");
        failed = true;
      } else {
        console.log("schema.postgresql.prisma: in sync");
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
