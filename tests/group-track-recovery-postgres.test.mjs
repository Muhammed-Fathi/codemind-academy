// REAL PostgreSQL17 + Prisma hard gate. Never imports a production URL from files.
// DATABASE_URL must be disposable/local; --sql-only is diagnostic, forbidden in CI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import pg from 'pg';
import {inspect,compareCatalog} from '../scripts/db/inspect-pg-baseline.mjs';
import {reconcile,validateTarget,validateReference} from '../scripts/db/reconcile-group-track-scope.mjs';
const url=validateTarget(process.env.DATABASE_URL || '');
const sqlOnly=process.argv.includes('--sql-only');
assert(!sqlOnly || !process.env.CI,'CI must run the Prisma engine portion');
const prisma=process.env.MIGRATION_PROVIDERS_PRISMA_BIN || 'node_modules/.bin/prisma';
const read=p=>fs.readFileSync(p,'utf8');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const init=read('prisma/postgres/migrations/0_init/migration.sql');
const historical=execFileSync('git',['show','137d35fe7081bcdf727cc28bde68774f157dcd13^:scripts/db/postgres-baseline.sql'],{encoding:'utf8'});
assert.equal(hash(historical),'9ea178f385b603da64e7cae1062d77dfab1fbcde27f9c9b1dd6ee997be6570d3');
const b='20260915120000_phase26b_group_track_scope';
const d='20260915180000_phase26d_quiz_attempt_architecture';
const phaseB=read(`prisma/migrations/${b}/migration.sql`);
assert.equal(hash(phaseB),'06cc038d4fc0f23b6fe63724f944f436c4007fc94ad4d04759c728bd893a4b39');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'group-recovery-'));
const client=new pg.Client({connectionString:url});
const referenceUrl=new URL(url); referenceUrl.pathname='/codemind_recovery_reference_test';
assert.notEqual(new URL(url).pathname,referenceUrl.pathname);
const ref=new pg.Client({connectionString:referenceUrl.toString()});
let refConnected=false;
const reset=async()=>{await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');await client.query(historical);await client.query(phaseB);};
const take=()=>inspect(client);
const seed=async value=>{
  await client.query(`INSERT INTO public."Course" (id,slug,name,"nameAr",description,"updatedAt") VALUES ('fixture','fixture','fixture','fixture','fixture',now()) ON CONFLICT DO NOTHING`);
  await client.query(`INSERT INTO public."Group" (id,name,"courseId","updatedAt","trackScope") VALUES ($1,'fixture','fixture',now(),$2)`,[crypto.randomUUID(),value]);
};
const runNode=(script,...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',env:{...process.env,DATABASE_URL:url},timeout:60000});
const runPrisma=(...args)=>{
  const r=spawnSync(prisma,['migrate',...args,'--schema','prisma/postgres/schema.prisma'],{encoding:'utf8',env:{...process.env,DATABASE_URL:url},timeout:120000});
  const downloadFailure=/binaries\.prisma\.sh|engine.*download/i.test((r.stderr || '')+(r.stdout || ''));
  assert.equal(r.status,0,downloadFailure ? 'Prisma engine download unavailable (environment failure)' : `Prisma ${args[0]} failed (details withheld; examine disposable CI environment)`);
  return r.stdout;
};
const ledger=async failed=>{
  await client.query(`CREATE TABLE public._prisma_migrations (
    id varchar(36) PRIMARY KEY,checksum varchar(64) NOT NULL,finished_at timestamptz,
    migration_name varchar(255) NOT NULL,logs text,rolled_back_at timestamptz,
    started_at timestamptz NOT NULL DEFAULT now(),applied_steps_count integer NOT NULL DEFAULT 0)`);
  for(const name of fs.readdirSync('prisma/migrations').filter(n=>n!==d && fs.existsSync(`prisma/migrations/${n}/migration.sql`)).sort()) {
    await client.query(`INSERT INTO public._prisma_migrations (id,checksum,finished_at,migration_name,applied_steps_count) VALUES ($1,$2,now(),$3,1)`,[crypto.randomUUID(),hash(read(`prisma/migrations/${name}/migration.sql`)),name]);
  }
  if(failed) await addFailure();
};
const addFailure=()=>client.query(`INSERT INTO public._prisma_migrations (id,checksum,migration_name,applied_steps_count) VALUES ($1,$2,$3,0)`,[crypto.randomUUID(),hash(read(`prisma/migrations/${d}/migration.sql`)),d]);
try {
  await client.connect();
  assert.equal(Math.floor(Number((await client.query('SHOW server_version_num')).rows[0].server_version_num)/10000),17);
  await client.query('DROP DATABASE IF EXISTS codemind_recovery_reference_test');
  await client.query('CREATE DATABASE codemind_recovery_reference_test');
  await ref.connect(); refConnected=true;
  await ref.query(init);
  const reference=await inspect(ref);
  reference.repositoryInitSha256=hash(init);
  validateReference(reference);
  const referenceFile=path.join(tmp,'reference.json');fs.writeFileSync(referenceFile,JSON.stringify(reference));
  // Each negative must leave its starting catalog and values unchanged.
  async function negative(name,mutation,referenceOverride=reference) {
    await reset(); await mutation();
    const before=await take();
    await assert.rejects(()=>reconcile(client,referenceOverride),undefined,name);
    const after=await take();
    assert.deepEqual(compareCatalog(after.catalog,before.catalog),[],name+' rollback catalog');
    assert.deepEqual(after.audience,before.audience,name+' rollback values');
    console.log('PASS refusal: '+name);
  }
  for(const v of ['UNEXPECTED','arabic',' ARABIC','LANGUAGE ','SHARED']) await negative('literal '+JSON.stringify(v),()=>seed(v));
  await negative('non-null default',()=>client.query(`ALTER TABLE public."Group" ALTER COLUMN "trackScope" SET DEFAULT 'ARABIC'`));
  await negative('NOT NULL',()=>client.query('ALTER TABLE public."Group" ALTER COLUMN "trackScope" SET NOT NULL'));
  await negative('missing enum',()=>client.query('ALTER TYPE public."TrackScope" RENAME TO "OtherTrackScope"'));
  await negative('enum labels',()=>client.query(`ALTER TYPE public."TrackScope" ADD VALUE 'OTHER'`));
  await negative('enum order',()=>client.query(`ALTER TYPE public."TrackScope" RENAME VALUE 'SHARED' TO 'TEMP'; ALTER TYPE public."TrackScope" RENAME VALUE 'ARABIC' TO 'SHARED'; ALTER TYPE public."TrackScope" RENAME VALUE 'TEMP' TO 'ARABIC'`));
  await negative('unrelated type',()=>client.query('ALTER TABLE public."Group" ALTER COLUMN "trackScope" TYPE integer USING NULL::integer'));
  await negative('view dependency',()=>client.query('CREATE VIEW public.group_scope_view AS SELECT "trackScope" FROM public."Group"'));
  await negative('check dependency',()=>client.query(`ALTER TABLE public."Group" ADD CONSTRAINT custom_scope CHECK ("trackScope" <> 'bad')`));
  await negative('same-name wrong index',()=>client.query('DROP INDEX public."Group_trackScope_idx"; CREATE INDEX "Group_trackScope_idx" ON public."Group"("isActive")'));
  await negative('incomplete reference',async()=>{}, {...reference,catalog:{...reference.catalog,indexes:undefined}});
  await negative('partial Phase26D state',()=>client.query('ALTER TABLE public."Quiz" ADD COLUMN "quizMode" text'));
  await negative('already-enum but wrong default',()=>client.query(`ALTER TABLE public."Group" ALTER COLUMN "trackScope" TYPE public."TrackScope" USING "trackScope"::public."TrackScope"; ALTER TABLE public."Group" ALTER COLUMN "trackScope" SET DEFAULT 'ARABIC'`));
  await reset();
  const blocker=new pg.Client({connectionString:url});await blocker.connect();
  try {
    await blocker.query('BEGIN; LOCK TABLE public."Group" IN ACCESS SHARE MODE');
    const start=Date.now(); await assert.rejects(()=>reconcile(client,reference),e=>e.code==='55P03');
    assert(Date.now()-start<10000,'lock timeout bounded');
  } finally {await blocker.query('ROLLBACK');await blocker.end();}
  assert.equal((await take()).catalog.columns.find(c=>c.table_name==='Group'&&c.column_name==='trackScope').type,'text');
  console.log('PASS refusal: lock timeout and rollback');
  await assert.rejects(()=>reconcile({query:async sql=>sql.startsWith('SHOW')?{rows:[]}:{rows:[]}},reference),/PostgreSQL 17 required/);
  console.log('PASS refusal: incomplete live inspection');
  for(const target of ['file:test.db','postgresql://example.neon.tech/codemind_recovery_test','postgresql://localhost/production','postgresql://localhost/codemind_recovery_test?host=example.neon.tech']) assert.throws(()=>validateTarget(target));
  assert.throws(()=>validateTarget('postgresql://example.neon.tech/db',{operator:true,interactive:true,acknowledged:true,ci:true}));
  console.log('PASS target guards');
  // Deliberately lose the post-ALTER column inspection: conversion must roll back.
  await reset();
  let columnReads=0;
  const incompleteAfter={query:async(sql,...args)=>{
    const result=await client.query(sql,...args);
    if(sql.includes('format_type(a.atttypid,a.atttypmod)') && ++columnReads===2) return {rows:[]};
    return result;
  }};
  await assert.rejects(()=>reconcile(incompleteAfter,reference),/Missing or ambiguous column/);
  assert.equal((await take()).catalog.columns.find(c=>c.table_name==='Group'&&c.column_name==='trackScope').type,'text');
  console.log('PASS post-conversion verification failure rolls back ALTER');

  // Populated valid synthetic data: NULLs and exact audiences survive; repeat no-op.
  await reset(); for(const v of [null,'ARABIC','LANGUAGE','ARABIC']) await seed(v);
  const before=await take();
  assert.equal((await reconcile(client,reference)).status,'RECONCILED');
  assert.deepEqual((await take()).audience,before.audience);
  assert.equal((await reconcile(client,reference)).status,'VERIFIED_NOOP');
  console.log('PASS populated conversion, value preservation and VERIFIED_NOOP');
  // Exact operator-reported empty lineage + checksummed historical ledger.
  await reset(); await ledger(true);
  const pre=await take();
  const diff=compareCatalog(pre.catalog,reference.catalog);
  assert.equal(diff.length,2);assert(diff.every(d=>d.section==='columns'&&d.row.table_name==='Group'&&d.row.column_name==='trackScope'));
  const incident=runNode('scripts/db/check-pg-migration-state.mjs');
  assert.equal(incident.status,1);assert.match(incident.stdout,/Group.trackScope type differs/);assert.match(incident.stdout,/ALL ABSENT/);
  const mismatch=runNode('scripts/db/inspect-pg-baseline.mjs','--reference',referenceFile);assert.equal(mismatch.status,1);
  const conversion=runNode('scripts/db/reconcile-group-track-scope.mjs','--reference',referenceFile);
  assert.equal(conversion.status,0,conversion.stderr);assert.match(conversion.stdout,/RECONCILED/);
  const post=await take();assert.deepEqual(post.ledger,pre.ledger,'reconciliation must not write ledger');
  assert.deepEqual(compareCatalog(post.catalog,reference.catalog),[]);
  assert.equal(runNode('scripts/db/inspect-pg-baseline.mjs','--reference',referenceFile).status,0);
  assert.equal(runNode('scripts/db/check-pg-migration-state.mjs').status,0);
  console.log('GROUP_TRACK_RECOVERY_PG17_OK: exact lineage, inspector/checker mismatch, CLI reconciliation, unchanged ledger, ZERO baseline differences');
  if(sqlOnly) console.log('GROUP_TRACK_RECOVERY_ENGINE_SKIPPED: diagnostic --sql-only; NOT authoritative CI proof');
  else {
    // Existing failed row deliberately preserved through reconciliation above.
    runPrisma('resolve','--rolled-back',d);
    runPrisma('resolve','--applied','0_init');
    runPrisma('deploy');
    assert.match(runPrisma('status'),/Database schema is up to date/);
    assert.match(runPrisma('deploy'),/No pending migrations/);
    await ref.query(read(`prisma/postgres/migrations/${d}/migration.sql`));
    const final=await take();assert.deepEqual(compareCatalog(final.catalog,(await inspect(ref)).catalog),[]);
    assert(final.catalog.tables.some(t=>t.name==='QuizRetryGrant'));
    assert.equal(final.ledger.filter(r=>!r.finished_at&&!r.rolled_back_at).length,0);
    assert.equal(final.ledger.filter(r=>r.migration_name===d&&r.finished_at).length,1);
    assert.equal(final.ledger.filter(r=>r.migration_name===d&&r.rolled_back_at).length,1);
    console.log('GROUP_TRACK_RECOVERY_ENGINE_OK: resolve/resolve/deploy/status/redeploy, preserved audit trail and ZERO post-26D differences');
  }
} finally {
  if(refConnected) await ref.end();
  await client.end();
  fs.rmSync(tmp,{recursive:true,force:true});
}
