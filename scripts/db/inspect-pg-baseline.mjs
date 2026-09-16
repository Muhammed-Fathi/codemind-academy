#!/usr/bin/env node
// READ ONLY. No dotenv loading, no URLs in output, no mutation or recovery.
// DATABASE_URL=<provided securely by operator> node scripts/db/inspect-pg-baseline.mjs
// --reference <JSON snapshot from a disposable PG17 database containing ONLY 0_init>
// Compare on the same PostgreSQL major version. Ledger and audience are evidence,
// not schema comparison inputs. A match does NOT authorize migration recovery.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const queries = {
  tables: `SELECT c.relname AS name, c.relkind, c.relpersistence, c.relrowsecurity,
    c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
    AND c.relname <> '_prisma_migrations' ORDER BY c.relname`,
  columns: `SELECT c.relname AS table_name, a.attname AS column_name,
    format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null,
    pg_get_expr(d.adbin,d.adrelid) AS default_expression, a.attidentity, a.attgenerated,
    CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END AS collation
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
    AND c.relname <> '_prisma_migrations' AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attname`,
  enums: `SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
    WHERE n.nspname='public' GROUP BY t.typname ORDER BY t.typname`,
  constraints: `SELECT c.relname AS table_name, k.conname AS name, k.contype,
    pg_get_constraintdef(k.oid,false) AS definition, k.convalidated,
    k.condeferrable,k.condeferred FROM pg_constraint k
    JOIN pg_namespace n ON n.oid=k.connamespace LEFT JOIN pg_class c ON c.oid=k.conrelid
    WHERE n.nspname='public' AND (c.relname IS NULL OR c.relname <> '_prisma_migrations')
    ORDER BY c.relname,k.conname`,
  indexes: `SELECT t.relname AS table_name, i.relname AS name,
    pg_get_indexdef(i.oid) AS definition, x.indisvalid, x.indisready, x.indisunique,
    x.indisprimary FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
    JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname <> '_prisma_migrations'
    ORDER BY t.relname,i.relname`,
  views: `SELECT c.relname AS name, pg_get_viewdef(c.oid,false) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('v','m') ORDER BY c.relname`,
};
export function compareCatalog(actual, expected) {
  const diffs = [];
  for (const section of Object.keys(queries)) {
    if (!Array.isArray(actual[section]) || !Array.isArray(expected[section])) throw new Error('Incomplete catalog');
    const a = new Set(actual[section].map(r => JSON.stringify(r)));
    const b = new Set(expected[section].map(r => JSON.stringify(r)));
    for (const row of a) if (!b.has(row)) diffs.push({section, side:'live-only', row:JSON.parse(row)});
    for (const row of b) if (!a.has(row)) diffs.push({section, side:'reference-only', row:JSON.parse(row)});
  }
  return diffs;
}
export async function inspect(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL search_path = pg_catalog, public");
    // Fail rather than silently return an RLS-filtered audience inventory.
    await client.query('SET LOCAL row_security = off');
    const result = { format:1, schema:'public', server:(await client.query('SHOW server_version')).rows[0].server_version, catalog:{} };
    for (const [name,sql] of Object.entries(queries)) result.catalog[name] = (await client.query(sql)).rows;
    const group = result.catalog.columns.some(r => r.table_name==='Group' && r.column_name==='trackScope');
    if (group) {
      result.audience = (await client.query(`SELECT "trackScope"::text AS value, count(*)::text AS rows
        FROM public."Group" GROUP BY "trackScope"::text ORDER BY value NULLS FIRST`)).rows;
      result.groupRows = (await client.query('SELECT count(*)::text AS count FROM public."Group"')).rows[0].count;
      result.dependencies = (await client.query(`WITH RECURSIVE deps(classid,objid,objsubid) AS (
        SELECT 'pg_class'::regclass::oid, a.attrelid,a.attnum::int FROM pg_attribute a
        WHERE a.attrelid='public."Group"'::regclass AND a.attname='trackScope'
        UNION SELECT d.classid,d.objid,d.objsubid FROM pg_depend d JOIN deps p
        ON d.refclassid=p.classid AND d.refobjid=p.objid AND d.refobjsubid=p.objsubid)
        SELECT pg_describe_object(classid,objid,objsubid) AS object FROM deps ORDER BY object`)).rows;
    }
    result.trackScopeUsers = (await client.query(`SELECT n.nspname AS schema,c.relname AS table_name,a.attname AS column_name
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE a.atttypid=to_regtype('public."TrackScope"') AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY n.nspname,c.relname,a.attname`)).rows;
    // Signatures only: function bodies can contain secrets. Dynamic SQL and
    // unparsed function bodies are NOT reliably represented by pg_depend.
    result.routinesRequiringManualReview = (await client.query(`SELECT n.nspname AS schema,p.proname AS name,
      pg_get_function_identity_arguments(p.oid) AS arguments,l.lanname AS language
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY n.nspname,p.proname,arguments`)).rows;
    const ledgerExists = (await client.query("SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists")).rows[0].exists;
    result.ledger = ledgerExists ? (await client.query(`SELECT migration_name,checksum,started_at,finished_at,rolled_back_at,applied_steps_count
      FROM public._prisma_migrations ORDER BY started_at,id`)).rows : [];
    await client.query('ROLLBACK');
    return result;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
}
async function main() {
  const {default:pg} = await import('pg');
  const client = new pg.Client({connectionString:process.env.DATABASE_URL, connectionTimeoutMillis:10000});
  if (!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL || '')) throw new Error('Missing URL');
  try {
    await client.connect();
    const result = await inspect(client);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    result.repositoryInitSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'prisma/postgres/migrations/0_init/migration.sql'))).digest('hex');
    result.repositoryMigrationChecksums = {};
    for (const provider of ['prisma/migrations','prisma/postgres/migrations']) {
      for (const entry of fs.readdirSync(path.join(root,provider),{withFileTypes:true})) {
        const sql = path.join(root,provider,entry.name,'migration.sql');
        if (entry.isDirectory() && fs.existsSync(sql)) result.repositoryMigrationChecksums[`${provider}/${entry.name}`] = crypto.createHash('sha256').update(fs.readFileSync(sql)).digest('hex');
      }
    }
    const i = process.argv.indexOf('--reference');
    if (i !== -1) {
      const reference = JSON.parse(fs.readFileSync(process.argv[i+1], 'utf8'));
      if (reference.format !== 1 || reference.schema !== 'public' || reference.repositoryInitSha256 !== result.repositoryInitSha256 || reference.server.split('.')[0] !== result.server.split('.')[0]) throw new Error('Incompatible reference');
      result.differences = compareCatalog(result.catalog,reference.catalog);
      process.exitCode = result.differences.length ? 1 : 0;
    }
    console.log(JSON.stringify(result,null,2));
  } finally { await client.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Read-only baseline inspection failed; no recovery is authorized. Check access, reference format and connectivity locally. Details suppressed to protect credentials.'); process.exitCode=2; });
}
