#!/usr/bin/env node
// Explicit pre-baseline operation, NEVER a Prisma migration. No ledger writes.
// Default mode is disposable-local only; hosted operation needs an interactive
// operator, explicit acknowledgement, and a trusted PG17 0_init inventory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {queries, compareCatalog} from './inspect-pg-baseline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const init = path.join(root, 'prisma/postgres/migrations/0_init/migration.sql');
const labels = ['SHARED','ARABIC','LANGUAGE'];
const fail = message => { throw new Error(message); };
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function validateTarget(url, {operator=false, interactive=false, ci=false, acknowledged=false}={}) {
  let u;
  try { u = new URL(url); } catch { fail('Invalid PostgreSQL target'); }
  if (!['postgres:','postgresql:'].includes(u.protocol)) fail('PostgreSQL required');
  // Reject libpq connection overrides; host validation must describe actual host.
  if ([...u.searchParams.keys()].some(k => !['sslmode','schema','connection_limit','pool_timeout'].includes(k))) fail('Unexpected connection option');
  if (operator) {
    if (ci || !interactive || !acknowledged) fail('Operator mode requires interactive non-CI acknowledgement');
  } else {
    if (!['localhost','127.0.0.1','[::1]','postgres'].includes(u.hostname) || /neon|prod/i.test(url) || !/^codemind_.*(test|recovery|migrations)/.test(u.pathname.slice(1))) fail('Disposable local target required');
  }
  return url;
}
export function validateReference(reference) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(init)).digest('hex');
  if (reference?.format !== 1 || reference.schema !== 'public' || !/^17\./.test(reference.server || '') || reference.repositoryInitSha256 !== hash) fail('Untrusted or incompatible baseline metadata');
  for (const section of Object.keys(queries)) {
    if (!Array.isArray(reference.catalog?.[section])) fail('Incomplete baseline inspection');
  }
  const c = reference.catalog.columns.filter(c => c.table_name==='Group' && c.column_name==='trackScope');
  if (c.length!==1 || c[0].type!=='"TrackScope"' || c[0].not_null!==false || c[0].default_expression!==null || c[0].attidentity!=='' || c[0].attgenerated!=='' || c[0].collation!==null) fail('Unexpected reference column');
  if (!equal(reference.catalog.enums.find(e => e.name==='TrackScope')?.values,labels)) fail('Unexpected reference enum');
  return reference;
}
export async function catalog(client) {
  const result={};
  for (const [name,sql] of Object.entries(queries)) {
    const r=await client.query(sql);
    if (!Array.isArray(r.rows)) fail('Incomplete catalog inspection');
    result[name]=r.rows;
  }
  return result;
}
async function values(client) {
  const rows=(await client.query(`SELECT "trackScope"::text AS value,count(*)::text AS count FROM public."Group"
    GROUP BY "trackScope"::text ORDER BY "trackScope"::text COLLATE "C" NULLS FIRST`)).rows;
  if (!Array.isArray(rows)) fail('Incomplete value inspection');
  for (const r of rows) if ((r.value!==null && !['ARABIC','LANGUAGE'].includes(r.value)) || !/^\d+$/.test(r.count)) fail('Unexpected group audience (including SHARED)');
  const total=(await client.query('SELECT count(*)::text AS count FROM public."Group"')).rows;
  if (total?.length!==1 || !/^\d+$/.test(total[0].count) || rows.reduce((n,r)=>n+BigInt(r.count),0n)!==BigInt(total[0].count)) fail('Incomplete count inspection');
  return {rows,total:total[0].count};
}
async function dependencies(client) {
  // Check direct column dependencies by OID, never by a spoofable object name alone.
  const r=await client.query(`SELECT d.classid='pg_class'::regclass AS is_relation,
    d.objid=to_regclass('public."Group_trackScope_idx"') AS expected_index,
    d.objsubid,d.deptype FROM pg_depend d
    JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    WHERE d.refclassid='pg_class'::regclass AND a.attrelid='public."Group"'::regclass AND a.attname='trackScope'`);
  if (r.rows?.length!==1 || !r.rows.every(d=>d.is_relation===true && d.expected_index===true && d.objsubid===0 && d.deptype==='a')) fail('Unexpected column dependencies');
  const extra=(await client.query(`SELECT
    (SELECT count(*)::int FROM pg_trigger WHERE tgrelid='public."Group"'::regclass AND NOT tgisinternal) AS triggers,
    (SELECT count(*)::int FROM pg_rewrite WHERE ev_class='public."Group"'::regclass) AS rules,
    (SELECT count(*)::int FROM pg_inherits WHERE inhrelid='public."Group"'::regclass OR inhparent='public."Group"'::regclass) AS inheritance`)).rows;
  if (extra?.length!==1 || Object.values(extra[0]).some(n=>n!==0)) fail('Unexpected Group trigger/rule/inheritance');
}
function verifyCatalog(actual,reference,{allowText=false}={}) {
  const c=actual.columns?.filter(c=>c.table_name==='Group' && c.column_name==='trackScope');
  if (c?.length!==1) fail('Missing or ambiguous column inspection');
  const field=c[0];
  if (field.not_null!==false || field.default_expression!==null || field.attidentity!=='' || field.attgenerated!=='') fail('Unexpected default/nullability/generated state');
  if (!equal(actual.enums.find(e=>e.name==='TrackScope')?.values,labels)) fail('Unexpected or missing TrackScope enum');
  if (field.type==='text' && allowText) {
    if (field.collation!=='"default"') fail('Unexpected text collation');
  } else if (field.type!=='"TrackScope"' || field.collation!==null) fail('Unexpected column type');
  const normalized=structuredClone(actual);
  const n=normalized.columns.find(c=>c.table_name==='Group' && c.column_name==='trackScope');
  n.type='"TrackScope"'; n.collation=null;
  if (compareCatalog(normalized,reference.catalog).length) fail('Baseline drift beyond the permitted TEXT column');
  if (actual.indexes.some(i=>!i.indisvalid || !i.indisready) || actual.constraints.some(c=>!c.convalidated)) fail('Invalid index or constraint');
  return field.type;
}
export async function reconcile(client, reference) {
  validateReference(reference); // Before opening any mutation transaction.
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    await client.query('SET LOCAL search_path = pg_catalog, public');
    await client.query('SET LOCAL row_security = off');
    const version=(await client.query('SHOW server_version_num')).rows;
    if (version?.length!==1 || Math.floor(Number(version[0].server_version_num)/10000)!==17) fail('PostgreSQL 17 required');
    await client.query('LOCK TABLE public."Group" IN ACCESS EXCLUSIVE MODE');
    // READ COMMITTED ensures snapshots below are taken AFTER lock acquisition.
    const before=await catalog(client);
    const type=verifyCatalog(before,reference,{allowText:true});
    await dependencies(client);
    const data=await values(client);
    if (type==='text') await client.query(`ALTER TABLE public."Group"
      ALTER COLUMN "trackScope" TYPE public."TrackScope"
      USING "trackScope"::public."TrackScope"`);
    const after=await catalog(client);
    verifyCatalog(after,reference);
    await dependencies(client);
    if (!equal(await values(client),data)) fail('Row/value counts changed');
    await client.query('COMMIT');
    return {status:type==='text'?'RECONCILED':'VERIFIED_NOOP', rows:data.total, baselineDifferences:0};
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
async function main() {
  const args=process.argv.slice(2);
  const i=args.indexOf('--reference');
  if (i<0 || !args[i+1]) fail('Trusted --reference required');
  const operator=args.includes('--operator');
  const url=validateTarget(process.env.DATABASE_URL || '', {operator, interactive:!!process.stdin.isTTY && !!process.stdout.isTTY,ci:!!process.env.CI,acknowledged:args.includes('--acknowledge-backup-write-freeze-and-dependency-review')});
  const reference=validateReference(JSON.parse(fs.readFileSync(args[i+1],'utf8')));
  const {default:pg}=await import('pg');
  const client=new pg.Client({connectionString:url,connectionTimeoutMillis:10000});
  try { await client.connect(); console.log(JSON.stringify(await reconcile(client,reference))); }
  finally { await client.end(); }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(()=>{ console.error('RECONCILIATION_REFUSED_OR_FAILED: inspect locally; details suppressed to protect credentials. Do not resolve/deploy. If connection was lost at COMMIT, re-inspect before retry.'); process.exitCode=1; });
}
