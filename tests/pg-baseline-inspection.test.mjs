// Supplemental embedded-engine test, NOT the required real PostgreSQL 17 proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {PGlite} from '@electric-sql/pglite';
import {inspect,compareCatalog} from '../scripts/db/inspect-pg-baseline.mjs';
const db = new PGlite();
const client = {query:sql => db.query(sql)};
try {
  await db.exec(fs.readFileSync('prisma/postgres/migrations/0_init/migration.sql','utf8'));
  const expected = await inspect(client);
  assert.deepEqual(compareCatalog(expected.catalog,expected.catalog),[]);
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const historical = execFileSync('git',['show','137d35f^:scripts/db/postgres-baseline.sql'],{encoding:'utf8'});
  await db.exec(historical);
  await db.exec(fs.readFileSync('prisma/migrations/20260915120000_phase26b_group_track_scope/migration.sql','utf8'));
  const actual = await inspect(client);
  const diffs = compareCatalog(actual.catalog,expected.catalog);
  assert.equal(diffs.length,2,JSON.stringify(diffs,null,2));
  assert(diffs.every(d => d.section==='columns' && d.row.table_name==='Group' && d.row.column_name==='trackScope'));
  assert.equal(actual.catalog.columns.find(c => c.table_name==='Group' && c.column_name==='trackScope').type,'text');
  // Synthetic audience values are not production evidence.
  await db.exec(`CREATE TEMP TABLE audience_fixture(value text); INSERT INTO audience_fixture VALUES (NULL),('ARABIC'),('LANGUAGE'),('SHARED');`);
  const before = await db.query('SELECT value FROM audience_fixture ORDER BY value NULLS FIRST');
  await db.exec('ALTER TABLE audience_fixture ALTER COLUMN value TYPE public."TrackScope" USING value::public."TrackScope";');
  assert.deepEqual((await db.query('SELECT value::text AS value FROM audience_fixture ORDER BY value::text NULLS FIRST')).rows,before.rows);
  await db.exec('ALTER TABLE public."Group" ALTER COLUMN "trackScope" TYPE public."TrackScope" USING "trackScope"::public."TrackScope";');
  assert.deepEqual(compareCatalog((await inspect(client)).catalog,expected.catalog),[]);
  // Definitions, not just names; all differences must be reported together.
  await db.exec(`ALTER TABLE public."Group" ALTER COLUMN "trackScope" SET DEFAULT 'ARABIC';
    ALTER TABLE public."Group" ALTER COLUMN "trackScope" SET NOT NULL;
    DROP INDEX public."Group_trackScope_idx";
    CREATE INDEX "Group_trackScope_idx" ON public."Group"("isActive");
    ALTER TABLE public."Group" DROP CONSTRAINT "Group_courseId_fkey";
    ALTER TABLE public."Group" ADD CONSTRAINT "Group_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES public."Course"(id) ON DELETE RESTRICT;
    CREATE TABLE public.extra(id int);`);
  const drift = compareCatalog((await inspect(client)).catalog,expected.catalog);
  for (const section of ['columns','indexes','constraints','tables']) assert(drift.some(d => d.section===section),section);
  assert.throws(() => compareCatalog({},expected.catalog),/Incomplete catalog/);
  // Ensure the inspector requests database-enforced read-only mode before reads.
  const calls=[];
  await assert.rejects(inspect({query:async sql => { calls.push(sql); if(calls.length===2) throw new Error('test'); return {rows:[]}; }}));
  assert.equal(calls[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(calls.at(-1),'ROLLBACK');
  console.log('PG_BASELINE_INSPECTION_OK: historical TEXT lineage, enum convergence, exhaustive catalog differences, read-only transaction requested. Embedded PGlite only; NOT real PostgreSQL proof.');
} finally { await db.close(); }
