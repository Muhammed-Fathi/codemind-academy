// CodeMind Academy — Phase 21: PostgreSQL verification (operator + drill).
//
//   node scripts/db/verify-postgres.mjs --target postgresql://user@host/db
//   node scripts/db/verify-postgres.mjs --pglite /tmp/disposable-pg
//   node scripts/db/verify-postgres.mjs --target … --expect-fixtures   (drill)
//
// Read-only, except section F which runs inside a rolled-back transaction
// (savepoint probe of the rate-limit UNIQUE foundation — zero residue).
//
// WHAT IT PROVES (catalog = source of truth, not pg-lib's opinion)
//   A. Presence: 55 tables, 21 enums (+ exact values), 73 FKs, 34 UNIQUE
//      constraints, 67 secondary indexes — all from information_schema.
//   B. Referential integrity: orphan scan per FK (0 rows may dangle).
//   C. Uniqueness: duplicate scan per UNIQUE (NULLs distinct, per SQL).
//   D. Teacher lifecycle coherence (application-maintained links): ACTIVATED
//      ⇒ TEACHER User exists; APPROVED ⇒ token minted; unused token ⇒
//      APPROVED application; REJECTED ⇒ no live token; reviewers exist.
//   E. Security/audit tables present with their constraints; token hashes
//      unique and non-null (single-use foundations).
//   F. Rate-limit primitive probe: duplicate bucket insert rejected by the
//      UNIQUE constraint; guarded increment admits exactly to the limit.
//   G. App-shaped regression queries (read-only): enrollment, progression
//      universe, activation lookup, session lookup, material authorization,
//      notifications. With --expect-fixtures, exact fixture values asserted.
//
// EXIT: 0 + VERIFY_POSTGRES_OK, else 1 with the failing checks listed.

import fs from "node:fs";
import pg from "pg";
import { parseSchema, scalarFields, pgBackend, pgliteBackend, redactDatabaseUrl } from "./pg-lib.mjs";

const { Pool } = pg;

export async function runChecks(query, parsed, { expectFixtures = false } = {}) {
  const results = [];
  const check = (id, label, ok, detail = "") => {
    results.push({ id, label, ok: !!ok, detail: String(detail || "") });
  };

  // ---- A. catalog presence (information_schema / pg_catalog) ----
  const tables = (await query(
    `SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`
  )).rows.map((r) => r.n);
  const missingTables = [...parsed.models.keys()].filter((t) => !tables.includes(t));
  const extraTables = tables.filter((t) => !parsed.models.has(t));
  check("A1", `55 schema tables present (found ${tables.length})`,
    missingTables.length === 0, missingTables.length ? `missing: ${missingTables.join(",")}` : `extra(non-schema): ${extraTables.join(",") || "(none)"}`);

  const enumRows = (await query(
    `SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
     FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' GROUP BY 1 ORDER BY 1`
  )).rows;
  const enumMap = new Map(enumRows.map((r) => [r.name, r.values]));
  let enumBad = [];
  for (const [name, values] of parsed.enums) {
    const got = enumMap.get(name);
    if (!got || got.length !== values.length || got.some((v, i) => v !== values[i])) {
      enumBad.push(`${name}(want [${values.join(",")}] got [${(got || []).join(",")}])`);
    }
  }
  check("A2", `21 enums with exact values`, enumBad.length === 0, enumBad.join("; "));

  const fkCount = (await query(
    `SELECT COUNT(*)::int AS n FROM information_schema.table_constraints
     WHERE constraint_type = 'FOREIGN KEY' AND table_schema = 'public'`
  )).rows[0].n;
  // Expected FK count DERIVED from the current schema (not hardcoded).
  let wantFk = 0;
  for (const [, m] of parsed.models) {
    for (const f of m.fields) {
      if (f.isRelation && f.relation?.fields?.length) wantFk++;
    }
  }
  check("A3", `foreign keys present (${fkCount}/${wantFk})`, fkCount === wantFk, fkCount === wantFk ? "" : `found ${fkCount}`);

  const uqCount = (await query(
    `SELECT COUNT(*)::int AS n FROM information_schema.table_constraints
     WHERE constraint_type = 'UNIQUE' AND table_schema = 'public'`
  )).rows[0].n;
  let wantUq = 0;
  for (const [, m] of parsed.models) {
    wantUq += m.uniques.length;
    for (const c of scalarFields(m)) if (c.unique && !c.isId) wantUq++;
  }
  check("A4", `unique constraints present (${uqCount}/${wantUq})`, uqCount === wantUq);

  const idxCount = (await query(
    `SELECT COUNT(*)::int AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%_idx'`
  )).rows[0].n;
  let wantIdx = 0;
  for (const [, m] of parsed.models) wantIdx += m.indexes.length;
  check("A5", `secondary indexes present (${idxCount}/${wantIdx})`, idxCount === wantIdx);

  // ---- B. orphan scan per FK (catalog-driven) ----
  const fkRows = (await query(
    `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent,
            a1.attname AS child_col, a2.attname AS parent_col
     FROM pg_constraint c
     JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
     JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
     JOIN pg_attribute a1 ON a1.attrelid = c.conrelid AND a1.attnum = k.attnum
     JOIN pg_attribute a2 ON a2.attrelid = c.confrelid AND a2.attnum = fk.attnum
     JOIN pg_class cl ON cl.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE c.contype = 'f' AND n.nspname = 'public'
     ORDER BY 1, 2, 3`
  )).rows;
  let orphans = 0;
  let orphanDetail = "";
  for (const fk of fkRows) {
    // regclass::text may quote mixed-case names ("User") — use as-is.
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM ${fk.child} c LEFT JOIN ${fk.parent} p ON p."${fk.parent_col}" = c."${fk.child_col}" WHERE c."${fk.child_col}" IS NOT NULL AND p."${fk.parent_col}" IS NULL`
    );
    if (r.rows[0].n > 0) {
      orphans += r.rows[0].n;
      if (!orphanDetail) orphanDetail = `${fk.child}.${fk.child_col} -> ${fk.parent}.${fk.parent_col}: ${r.rows[0].n}`;
    }
  }
  check("B1", `orphan scan over ${fkRows.length} FK columns (0 orphans)`, orphans === 0, orphanDetail);

  // ---- C. duplicate scan per UNIQUE (catalog-driven, NULLs distinct) ----
  const uqRows = (await query(
    `SELECT conrelid::regclass::text AS tbl, c.conname AS name,
            (SELECT array_agg(a.attname ORDER BY u.ord)
             FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) AS cols
     FROM pg_constraint c
     JOIN pg_class cl ON cl.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE c.contype = 'u' AND n.nspname = 'public' ORDER BY 1, 2`
  )).rows;
  let dupGroups = 0;
  let dupDetail = "";
  for (const u of uqRows) {
    const cols = u.cols;
    const nonNull = cols.map((c) => `"${c}" IS NOT NULL`).join(" AND ");
    const grp = cols.map((c) => `"${c}"`).join(", ");
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM (SELECT ${grp} FROM ${u.tbl} WHERE ${nonNull} GROUP BY ${grp} HAVING COUNT(*) > 1) d`
    );
    if (r.rows[0].n > 0) {
      dupGroups += r.rows[0].n;
      if (!dupDetail) dupDetail = `${u.tbl} (${cols.join(",")}): ${r.rows[0].n} duplicate group(s)`;
    }
  }
  // PK duplicates are impossible by construction; still scan PKs for completeness.
  const pkRows = (await query(
    `SELECT conrelid::regclass::text AS tbl,
            (SELECT array_agg(a.attname ORDER BY u.ord)
             FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum) AS cols
     FROM pg_constraint c
     JOIN pg_class cl ON cl.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE c.contype = 'p' AND n.nspname = 'public'`
  )).rows;
  for (const u of pkRows) {
    const grp = u.cols.map((c) => `"${c}"`).join(", ");
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM (SELECT ${grp} FROM ${u.tbl} GROUP BY ${grp} HAVING COUNT(*) > 1) d`
    );
    if (r.rows[0].n > 0) { dupGroups += r.rows[0].n; if (!dupDetail) dupDetail = `PK dup in ${u.tbl}`; }
  }
  check("C1", `duplicate scan over ${uqRows.length} UNIQUE + ${pkRows.length} PK (0 dup groups)`, dupGroups === 0, dupDetail);

  // ---- D. teacher lifecycle coherence ----
  const d1 = (await query(
    `SELECT COUNT(*)::int AS n FROM "TeacherApplication" a
     WHERE a."status" = 'ACTIVATED' AND (a."userId" IS NULL OR NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = a."userId" AND u."role" = 'TEACHER'))`
  )).rows[0].n;
  check("D1", "ACTIVATED application ⇒ live TEACHER User", d1 === 0, d1 ? `${d1} incoherent` : "");

  const d2 = (await query(
    `SELECT COUNT(*)::int AS n FROM "TeacherApplication" a
     WHERE a."status" = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM "TeacherActivationToken" t WHERE t."applicationId" = a."id")`
  )).rows[0].n;
  check("D2", "APPROVED application ⇒ activation token minted", d2 === 0, d2 ? `${d2} without token` : "");

  const d3 = (await query(
    `SELECT COUNT(*)::int AS n FROM "TeacherActivationToken" t JOIN "TeacherApplication" a ON a."id" = t."applicationId"
     WHERE t."usedAt" IS NULL AND a."status" <> 'APPROVED'`
  )).rows[0].n;
  check("D3", "unused activation token ⇒ APPROVED application (rejection rescinds)", d3 === 0, d3 ? `${d3} live on non-approved` : "");

  const d4 = (await query(
    `SELECT COUNT(*)::int AS n FROM "TeacherApplication" a
     WHERE a."reviewedByUserId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = a."reviewedByUserId")`
  )).rows[0].n;
  check("D4", "reviewer ids reference live Users", d4 === 0, d4 ? `${d4} dangling` : "");

  // ---- E. security/audit foundations ----
  const eTables = ["UserSession", "PasswordResetToken", "SecurityRateLimit", "SecurityEvent", "TeacherApplication", "TeacherActivationToken", "AuditLog"];
  const eCounts = {};
  for (const t of eTables) {
    eCounts[t] = (await query(`SELECT COUNT(*)::int AS n FROM "${t}"`)).rows[0].n;
  }
  const e1 = (await query(
    `SELECT COUNT(*)::int AS n FROM "TeacherActivationToken" WHERE "tokenHash" IS NULL`
  )).rows[0].n;
  const e2 = (await query(
    `SELECT COUNT(*)::int AS n FROM "PasswordResetToken" WHERE "tokenHash" IS NULL`
  )).rows[0].n;
  const e3 = (await query(
    `SELECT COUNT(*)::int AS n FROM "UserSession" WHERE "tokenHash" IS NULL`
  )).rows[0].n;
  check("E1", `security tables readable (${eTables.map((t) => `${t}=${eCounts[t]}`).join(" ")})`, true);
  check("E2", "no NULL token hashes (single-use foundations intact)", e1 + e2 + e3 === 0);

  // ---- F. rate-limit primitive probe (rolled back — zero residue) ----
  let fOk = false;
  let fDetail = "";
  await query("BEGIN");
  try {
    const bucket = "__p21_probe__";
    const ident = `probe-${Date.now()}`;
    await query(`INSERT INTO "SecurityRateLimit" ("id","bucket","identifier","count","windowStart") VALUES ('__p21_probe_row__',$1,$2,0,CURRENT_TIMESTAMP)`, [bucket, ident]);
    // Idempotent ensure (Phase 20 step 1): second insert must be ignorable.
    const again = await query(
      `INSERT INTO "SecurityRateLimit" ("id","bucket","identifier","count","windowStart") VALUES ('__p21_probe_row2__',$1,$2,0,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`,
      [bucket, ident]
    );
    const conflictIgnored = (again.rowCount ?? 0) === 0;
    // Guarded claim (Phase 20 step 3): exactly `limit` claims land.
    const limit = 3;
    let admitted = 0;
    for (let i = 0; i < limit + 2; i++) {
      const r = await query(
        `UPDATE "SecurityRateLimit" SET "count" = "count" + 1 WHERE "bucket" = $1 AND "identifier" = $2 AND "count" < $3`,
        [bucket, ident, limit]
      );
      if ((r.rowCount ?? 0) === 1) admitted++;
    }
    const stored = (await query(`SELECT "count" AS c FROM "SecurityRateLimit" WHERE "bucket" = $1 AND "identifier" = $2`, [bucket, ident])).rows[0].c;
    // Plain duplicate insert (no ON CONFLICT) must be REJECTED by the UNIQUE.
    let dupRejected = false;
    try {
      await query(`INSERT INTO "SecurityRateLimit" ("id","bucket","identifier","count","windowStart") VALUES ('__p21_probe_row3__',$1,$2,0,CURRENT_TIMESTAMP)`, [bucket, ident]);
    } catch {
      dupRejected = true;
    }
    fOk = conflictIgnored && admitted === limit && Number(stored) === limit && dupRejected;
    fDetail = `onConflictIgnored=${conflictIgnored} admitted=${admitted}/${limit} stored=${stored} dupRejected=${dupRejected}`;
  } catch (e) {
    fDetail = `probe error: ${e.message}`;
  } finally {
    await query("ROLLBACK");
  }
  const residue = (await query(`SELECT COUNT(*)::int AS n FROM "SecurityRateLimit" WHERE "bucket" = '__p21_probe__'`)).rows[0].n;
  check("F1", "rate-limit UNIQUE foundation (idempotent ensure + guarded claims + dup reject)", fOk && residue === 0, residue ? `RESIDUE ${residue}` : fDetail);

  // ---- G. app-shaped regression queries (read-only) ----
  // G1: enrollment (Student -> Group -> Course), the SINGLE enrollment gate.
  const g1 = await query(
    `SELECT s."id" AS sid, g."id" AS gid, c."slug" AS slug
     FROM "Student" s JOIN "Group" g ON g."id" = s."groupId" JOIN "Course" c ON c."id" = g."courseId"
     ORDER BY s."id"`
  );
  check("G1", `enrollment join resolves (${g1.rows.length} enrolled students)`, g1.rows.length > 0 || !expectFixtures,
    expectFixtures && g1.rows.length !== 2 ? `want 2 got ${g1.rows.length}` : "");

  // G2: progression universe (PUBLISHED official sessions, deterministic order).
  const g2 = await query(
    `SELECT l."officialCode" AS code FROM "Lesson" l
     JOIN "Unit" u ON u."id" = l."unitId" JOIN "Part" p ON p."id" = u."partId" JOIN "Course" c ON c."id" = p."courseId"
     WHERE c."slug" = 'programming-ai-2nd-sec' AND l."status" = 'PUBLISHED' AND l."curriculumStatus" = 'OFFICIAL'
     ORDER BY p."order", u."order", l."order"`
  );
  const g2codes = g2.rows.map((r) => r.code).join(",");
  check("G2", `progression universe query (${g2codes || "0 rows"})`,
    expectFixtures ? g2codes === "1-1,1-2" : true, expectFixtures && g2codes !== "1-1,1-2" ? `got ${g2codes}` : "");

  // G3: activation lookup (token hash -> APPROVED application), the Phase 20 path.
  const g3 = await query(
    `SELECT a."email" AS email FROM "TeacherActivationToken" t JOIN "TeacherApplication" a ON a."id" = t."applicationId"
     WHERE t."tokenHash" = $1 AND t."usedAt" IS NULL AND a."status" = 'APPROVED'`,
    ["f".repeat(64)]
  );
  check("G3", "activation lookup by token hash",
    expectFixtures ? (g3.rows.length === 1 && g3.rows[0].email === "approved@example.com") : true);

  // G4: session lookup (token hash -> live session -> user), the auth path.
  const g4 = await query(
    `SELECT u."role" AS role FROM "UserSession" s JOIN "User" u ON u."id" = s."userId"
     WHERE s."tokenHash" = $1 AND s."revokedAt" IS NULL AND s."expiresAt" > CURRENT_TIMESTAMP`,
    ["a".repeat(64)]
  );
  check("G4", "session lookup by token hash",
    expectFixtures ? (g4.rows.length === 1 && g4.rows[0].role === "STUDENT") : true);

  // G5: material authorization join (active material -> private DOCUMENT asset).
  const g5 = await query(
    `SELECT m."id" AS mid FROM "Material" m JOIN "MediaAsset" a ON a."id" = m."mediaAssetId"
     WHERE m."lessonId" = 'p21-l1' AND m."isActive" = TRUE AND a."storage" = 'LOCAL_PRIVATE' AND a."kind" = 'DOCUMENT'`
  );
  check("G5", "material authorization join",
    expectFixtures ? (g5.rows.length === 1 && g5.rows[0].mid === "p21-mat1") : true);

  // G6: unread notifications per user.
  const g6 = await query(
    `SELECT COUNT(*)::int AS n FROM "Notification" WHERE "userId" = 'p21-u-s1' AND "isRead" = FALSE`
  );
  check("G6", "unread notification count",
    expectFixtures ? g6.rows[0].n === 1 : true, expectFixtures ? `got ${g6.rows[0].n}` : "");

  // G7: track isolation shape (LANGUAGE student must not match ARABIC-only rows
  // through the shared progression join — the join itself resolves; the app
  // applies trackScope server-side. Here: the data distinguishes scopes).
  const g7 = await query(`SELECT COUNT(*)::int AS n FROM "Lesson" WHERE "trackScope" = 'LANGUAGE'`);
  check("G7", "track-scoped content distinguishable in data", expectFixtures ? g7.rows[0].n === 1 : true);

  return results;
}

function printResults(results) {
  let pass = 0;
  for (const r of results) {
    if (r.ok) pass++;
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.id} ${r.label}${r.ok && !r.detail ? "" : ` — ${r.detail}`}`);
  }
  return pass;
}

async function main() {
  const argv = process.argv.slice(2);
  const target = argOf(argv, "--target") || process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
  const pgliteDir = argOf(argv, "--pglite");
  const expectFixtures = argv.includes("--expect-fixtures");
  if (!target && !pgliteDir) {
    console.error("usage: node scripts/db/verify-postgres.mjs --target <postgres-url> | --pglite <dir> [--expect-fixtures]");
    process.exit(1);
  }
  let backend;
  let pool = null;
  if (pgliteDir) {
    const { PGlite } = await import("@electric-sql/pglite");
    backend = pgliteBackend(new PGlite(pgliteDir));
    console.log(`verify-postgres: PGlite at ${pgliteDir}`);
  } else {
    if (/^file:/.test(target) || target.endsWith(".db")) {
      console.error("verify-postgres: target must be a PostgreSQL URL (got a SQLite path)");
      process.exit(1);
    }
    pool = new Pool({ connectionString: target });
    backend = pgBackend(pool);
    console.log(`verify-postgres: ${redactDatabaseUrl(target)}${expectFixtures ? " (expect-fixtures)" : ""}`);
  }
  try {
    const parsed = parseSchema();
    const results = await runChecks(backend.query, parsed, { expectFixtures });
    const pass = printResults(results);
    const failed = results.filter((r) => !r.ok);
    console.log(`${pass}/${results.length} checks passed`);
    if (failed.length) {
      console.error(`VERIFY FAILED: ${failed.map((r) => r.id).join(", ")}`);
      process.exit(1);
    }
    console.log("VERIFY_POSTGRES_OK");
  } finally {
    if (pool) await pool.end().catch(() => {});
    else await backend.close().catch(() => {});
  }
}

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((e) => {
    console.error(`fatal: ${e?.message || e}`);
    process.exit(1);
  });
}
