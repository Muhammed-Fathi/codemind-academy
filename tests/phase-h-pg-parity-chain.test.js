// CodeMind Academy — Phase H PG parity verifier: CHAIN registration + enum
// reconstruction regression coverage.
//
// On 2026-09-22 the parity verifier reported `enums: baseline=98 chain=97`
// with `NotificationType[22]=READINESS_REMINDER` missing — NOT because the
// migration was wrong (it appends exactly the label) but because the
// verifier's hardcoded CHAIN had not registered the newest migration, so the
// chain rebuilt the enum without its last label. The catalog diff blamed the
// schema for what was a registration omission.
//
// This suite pins the fix WITHOUT PGlite (pure file reads + the same
// append-fold PostgreSQL applies for ALTER TYPE ... ADD VALUE), so it runs
// offline in milliseconds inside the normal battery:
//
//   R1. every PG migration dir is registered in the verifier's CHAIN (and
//       every CHAIN entry exists on disk, in apply order).
//   R2. the baseline NotificationType carries READINESS_REMINDER last.
//   R3. the chained migration SQL appends the label exactly once.
//   R4. the order-aware reconstruction fold reproduces the baseline labels
//       byte-for-byte (exactly-once + ordering in one assertion).
//   R5. the nine Phase F labels still reconstruct in order.
//   R6. no duplicate label in the reconstructed or baseline enum.
//   R7. the verifier's verdict contract (OK line + chain-incomplete guard).
//
// What is REAL here: the verifier source, the PG migration SQL files, the
// generated baseline. What is DERIVED: the fold, which mirrors the single
// PostgreSQL semantic the chain relies on (ADD VALUE appends; IF NOT EXISTS
// skips a present label).
//
// Run: node --test tests/phase-h-pg-parity-chain.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const REPO = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error("FAIL:", label);
  }
}
function eq(got, want, label) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b, `${label} (got ${a}, want ${b})`);
}

// The verifier's registered chain, parsed from its own source (single source
// of truth — this suite never re-lists the migrations by hand).
const verifierSrc = read("scripts/db/verify-phase-h-pg-parity.mjs");
const chainBlock = /const CHAIN = \[([\s\S]*?)\];/.exec(verifierSrc)?.[1] ?? "";
const CHAIN = [...chainBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

const PG_MIG = path.join(REPO, "prisma", "postgres", "migrations");
const pgMigrationDirs = fs
  .readdirSync(PG_MIG, { withFileTypes: true })
  .filter((e) => e.isDirectory() && (/^\d+_/.test(e.name) || e.name === "0_init"))
  .map((e) => e.name)
  .sort();

const enumLabelsOf = (sql, typeName) => {
  const m = new RegExp(`CREATE TYPE "${typeName}" AS ENUM \\(([^)]*)\\);`).exec(sql);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};
const enumAddsOf = (sql, typeName) => {
  const out = [];
  const re = new RegExp(`ALTER TYPE "${typeName}" ADD VALUE (?:IF NOT EXISTS )?'([^']+)'`, "g");
  for (const m of sql.matchAll(re)) out.push(m[1]);
  return out;
};

test("Phase H PG parity chain registration + enum reconstruction (R1–R7)", () => {
  // ===========================================================================
  // R1. Chain registration: every PG migration dir is in CHAIN, every CHAIN
  // entry exists on disk, apply order is lexicographic.
  // ===========================================================================
  ok(CHAIN.length > 0, "R1: the CHAIN block parses to a non-empty list (non-vacuous)");
  for (const dir of pgMigrationDirs) {
    ok(CHAIN.includes(dir), `R1: ${dir} is registered in the verifier CHAIN`);
  }
  for (const name of CHAIN) {
    ok(
      fs.existsSync(path.join(PG_MIG, name, "migration.sql")),
      `R1: CHAIN entry ${name} exists on disk`
    );
  }
  eq(CHAIN, [...CHAIN].sort(), "R1: CHAIN is in lexicographic apply order");

  // ===========================================================================
  // R2. Baseline: NotificationType carries READINESS_REMINDER last.
  // ===========================================================================
  const baseline = read("scripts/db/postgres-baseline.sql");
  const baselineLabels = enumLabelsOf(baseline, "NotificationType");
  ok(Array.isArray(baselineLabels), "R2: the baseline declares the NotificationType enum");
  eq(baselineLabels.length, 22, "R2: the baseline enum has 22 labels");
  ok(baselineLabels.includes("READINESS_REMINDER"), "R2: the baseline contains READINESS_REMINDER");
  eq(
    baselineLabels[baselineLabels.length - 1],
    "READINESS_REMINDER",
    "R2: the new label lands last (ADD VALUE append order)"
  );

  // ===========================================================================
  // R3. Chain SQL: the label is appended exactly once across the chain.
  // ===========================================================================
  const chainSql = CHAIN.map((name) =>
    read(`prisma/postgres/migrations/${name}/migration.sql`)
  ).join("\n");
  const readinessAdds = enumAddsOf(chainSql, "NotificationType").filter(
    (l) => l === "READINESS_REMINDER"
  );
  eq(readinessAdds.length, 1, "R3: the chain appends READINESS_REMINDER exactly once");
  ok(
    chainSql.includes(
      `ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'READINESS_REMINDER';`
    ),
    "R3: the append uses the canonical IF NOT EXISTS form"
  );

  // ===========================================================================
  // R4. Reconstruction fold: 0_init labels + ordered ADD VALUEs reproduce the
  // baseline labels byte-for-byte (exactly-once + ordering, one assertion).
  // ===========================================================================
  const initLabels = enumLabelsOf(
    read("prisma/postgres/migrations/0_init/migration.sql"),
    "NotificationType"
  );
  ok(Array.isArray(initLabels) && initLabels.length > 0, "R4: 0_init declares the base enum");
  const reconstructed = [...initLabels];
  for (const name of CHAIN) {
    if (name === "0_init") continue;
    for (const label of enumAddsOf(
      read(`prisma/postgres/migrations/${name}/migration.sql`),
      "NotificationType"
    )) {
      // Mirrors IF NOT EXISTS: a present label is skipped, never duplicated.
      if (!reconstructed.includes(label)) reconstructed.push(label);
    }
  }
  eq(reconstructed, baselineLabels, "R4: the reconstructed enum equals the baseline labels in order");

  // ===========================================================================
  // R5. The nine Phase F labels still reconstruct in order.
  // ===========================================================================
  const PHASE_F_LABELS = [
    "SESSION_SCHEDULED",
    "SESSION_LINK",
    "SESSION_RESCHEDULED",
    "SESSION_CANCELLED",
    "ABSENCE_FINALIZED",
    "ABSENCE_REASON_SUBMITTED",
    "ABSENCE_EXCUSED",
    "ABSENCE_UNEXCUSED",
    "ABSENCE_REMINDER",
  ];
  const fStart = reconstructed.indexOf("SESSION_SCHEDULED");
  ok(fStart >= 0, "R5: the Phase F block is present in the reconstruction");
  eq(
    reconstructed.slice(fStart, fStart + PHASE_F_LABELS.length),
    PHASE_F_LABELS,
    "R5: the nine Phase F labels reconstruct contiguously in order"
  );

  // ===========================================================================
  // R6. No duplicate label in the reconstructed or baseline enum.
  // ===========================================================================
  eq(
    new Set(reconstructed).size,
    reconstructed.length,
    "R6: the reconstruction has no duplicate labels"
  );
  eq(
    new Set(baselineLabels).size,
    baselineLabels.length,
    "R6: the baseline enum has no duplicate labels"
  );

  // ===========================================================================
  // R7. Verdict contract: the OK line plus the chain-incomplete guard.
  // ===========================================================================
  ok(
    verifierSrc.includes('"PHASE_H_PG_CATALOG_IDENTICAL_OK"'),
    "R7: the success verdict line is pinned"
  );
  ok(
    verifierSrc.includes("unregisteredMigrations") &&
      verifierSrc.includes("PHASE_H_PG_CHAIN_INCOMPLETE="),
    "R7: an unregistered migration gets its own loud verdict (not a catalog diff)"
  );
  ok(
    verifierSrc.includes("danglingChainEntries"),
    "R7: a CHAIN entry with no migration.sql on disk is reported"
  );

  if (fail > 0) throw new Error(`${fail} assertion(s) failed:\n- ` + failures.join("\n- "));
});
