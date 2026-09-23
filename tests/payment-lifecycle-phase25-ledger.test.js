// CodeMind Academy — Phase 25 PR1 ledger proof (offline, behavior-neutral).
//
// Proves the payment-lifecycle LEDGER ONLY:
//   * prisma/migrations/20260914120000_payment_lifecycle_redesign/migration.sql
//     is forward-only additive (6x ADD COLUMN nullable, 2x CREATE INDEX),
//     contains zero destructive statements, and applies byte-identical on BOTH
//     SQLite (local dev) and PostgreSQL (production Neon) via real engines.
//   * prisma/schema.prisma gains exactly the 6 nullable fields + 2 @@index
//     (no defaults, no relations), and the derived artifacts
//     (prisma/postgres/schema.prisma + postgres-baseline.sql) are regen-in-sync.
//   * §0 now enforces PR2a's FIELD-OWNORIZATION boundary instead of PR1's
//     "zero references": the request fields (senderPhone/requestedGroupId/
//     requestedPlanId) may be referenced ONLY by the enroll V2 submission +
//     student read-contract files, the review-read pair (reviewedAt/
//     rejectionReason) only by the read contract, and reviewedByUserId stays
//     unreferenced in src/ until PR2b/PR3 wire the audit write.
//   * The PR4 operator report queries (A-F, read-only) return the expected
//     rows on both engines.
//
// Engines: scratch SQLite via built-in node:sqlite (temp dir, never the real
// DB) + real PostgreSQL via @electric-sql/pglite (in-memory, devDependency).
// Run:  node tests/payment-lifecycle-phase25-ledger.test.js
// (dependency-less sandbox with a side-installed PGlite:
//  NODE_PATH=/path/to/pglite/node_modules node tests/payment-lifecycle-phase25-ledger.test.js)
// Exit code: 0 = all pass, 1 = failure.
//
// PGlite fallback policy: if @electric-sql/pglite cannot be imported (e.g. an
// air-gapped checkout without node_modules), the suite prints a loud
// PGLITE_MISSING_FALLBACK_USED banner and establishes PostgreSQL-dialect
// validity WITHOUT executing PG: (a) every migration statement shape is
// whitelisted to ADD-COLUMN / CREATE-INDEX, (b) every type token is PG-native
// (TEXT / TIMESTAMPTZ(3)), and (c) the column definitions + index DDL are
// byte-equivalent to the regenerated authoritative PG baseline emitter output
// (§3b). The fallback never silently passes — the banner names it.
//
// Requires Node >= 22.5 (built-in node:sqlite).

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("node:url");

const REPO = path.join(__dirname, "..");
const MIGRATION_DIR = "20260914120000_payment_lifecycle_redesign";
const MIGRATION_SQL = path.join(REPO, "prisma", "migrations", MIGRATION_DIR, "migration.sql");

const NEW_COLUMNS = [
  ["senderPhone", "TEXT"],
  ["requestedGroupId", "TEXT"],
  ["requestedPlanId", "TEXT"],
  ["rejectionReason", "TEXT"],
  ["reviewedAt", "TIMESTAMPTZ(3)"],
  ["reviewedByUserId", "TEXT"],
];
const NEW_INDEXES = [
  ["Payment_status_createdAt_idx", ["status", "createdAt"]],
  ["Payment_subscriptionId_status_idx", ["subscriptionId", "status"]],
];
const OLD_PAYMENT_COLS = [
  "id", "userId", "subscriptionId", "amount", "method",
  "status", "reference", "notes", "createdAt", "updatedAt",
];

// Canonical PR4 operator report queries. Single SELECT each, portable across
// SQLite and PostgreSQL. $1 = "now" cutoff (ISO-8601); on SQLite the runner
// binds it as `?`. Operators replace $1 with their timestamp literal.
const REPORT_QUERIES = {
  A: `SELECT s."id", s."studentId", s."planId", s."endDate" FROM "Subscription" s WHERE s."status" = 'ACTIVE' AND s."endDate" IS NOT NULL AND s."endDate" < $1 ORDER BY s."endDate", s."id"`,
  B: `SELECT p."id", p."userId", p."amount", p."method", p."createdAt", p."senderPhone", p."requestedGroupId", p."requestedPlanId" FROM "Payment" p WHERE p."status" = 'PENDING' ORDER BY p."createdAt", p."id"`,
  C: `SELECT s."id", s."studentId", s."planId", s."createdAt" FROM "Subscription" s WHERE s."status" = 'PENDING' ORDER BY s."createdAt", s."id"`,
  D: `SELECT st."id", st."userId", st."groupId" FROM "Student" st WHERE st."groupId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."studentId" = st."id" AND s."status" = 'ACTIVE') ORDER BY st."id"`,
  E: `SELECT p."id", p."userId", p."amount", p."createdAt" FROM "Payment" p WHERE p."status" = 'PENDING' AND p."subscriptionId" IS NULL AND p."senderPhone" IS NULL AND p."requestedGroupId" IS NULL AND p."requestedPlanId" IS NULL ORDER BY p."createdAt", p."id"`,
  F: `SELECT p."id", p."userId", p."rejectionReason", p."reviewedAt", p."reviewedByUserId", r."couponId" FROM "Payment" p JOIN "CouponRedemption" r ON r."paymentId" = p."id" WHERE p."status" = 'REJECTED' ORDER BY p."id"`,
};
const REPORT_NOW = "2026-09-14T12:00:00.000Z";
const REPORT_EXPECTED_IDS = { A: ["s1"], B: ["q1", "q2"], C: ["s3", "s5"], D: ["st4"], E: ["q2"], F: ["q3"] };

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ok - ${msg}`); }
  else { fail++; console.error(`  FAIL - ${msg}`); }
}
function section(title) { console.log(`\n== ${title} ==`); }
function canon(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}
function canonRows(rows) {
  return rows.map((r) => {
    const o = {};
    for (const k of Object.keys(r).sort()) o[k] = canon(r[k]);
    return o;
  });
}
function stripSqlComments(sql) {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}
function walkFiles(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, exts, out);
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

async function main() {
  const pgLib = await import(pathToFileURL(path.join(REPO, "scripts", "db", "pg-lib.mjs")).href);
  const migrationSql = fs.readFileSync(MIGRATION_SQL, "utf8");

  // ---------------------------------------------------------------------------
  section("0. Field ownership: PR2a wrote exactly its slice, no further");
  // ---------------------------------------------------------------------------
  // PR3 note: the same deliberate-re-pin protocol PR2a/PR2b used. The pins now
  // assert the PR3 contract (presentation may READ the request/review fields,
  // never write them; intent ids stay server-side; no reviewer identity is
  // rendered) instead of the fields' mere absence.
  //
  // PR1 originally pinned this as "zero references" (behavior-neutral ledger).
  // PR2a RE-PINS — not relaxes — the invariant: the REQUEST fields are now
  // written by /api/enroll (via src/lib/payment-submission.ts) and read by the
  // student payments contract, and the fields may appear in NO other file;
  // the REVIEW-writer side (rejectionReason/reviewedAt writers, reviewedByUserId
  // at all) stays un-wired until PR2b/PR3. A new file touching either half of
  // this list fails here until its phase re-pins it deliberately.
  const srcFiles = walkFiles(path.join(REPO, "src"), [".ts", ".tsx"]);
  ok(srcFiles.length > 0, `src tree scanned (${srcFiles.length} TS files)`);
  const REL = (f) => path.relative(REPO, f).split(path.sep).join("/");
  const REQUEST_FIELDS = ["senderPhone", "requestedGroupId", "requestedPlanId"];
  // PR3 RE-PIN (deliberate, not a relaxation — the PR2a/PR2b protocol):
  // the presentation layer now renders the request intent, so the allowlist
  // gains the PR3 read/display files. The invariant gets STRICTER at the same
  // time: (a) the intent IDS may appear in server files only — no component
  // ever sends or decides a group/plan id; (b) every newly allowlisted file is
  // proven read-only (no Payment mutation, no transaction).
  const PR2A_REQUEST_ALLOWLIST = new Set([
    "src/lib/payment-submission.ts", // writer (enroll V2) + student read contract
    "src/app/api/enroll/route.ts", // route wiring + the release-coupling warning
    "src/app/api/students/me/payments/route.ts", // read API
    "src/app/api/students/me/dashboard/route.ts", // pending/rejected request block
    "src/components/auth/enroll-view.tsx", // PR3 payment page: senderPhone input + summary
    "src/lib/payment-transitions.ts", // PR2b decision service (reads the request intent)
    // --- PR3 (presentation / operator review, read-only) ---
    "src/lib/payment-ux.ts", // proof-message facts (senderPhone is a display fact)
    "src/components/student/payment-status.tsx", // student request panel
    "src/components/admin/payment-review-drawer.tsx", // admin review drawer
    "src/components/admin/admin-dashboard.tsx", // admin queue columns
    "src/app/api/admin/payments/route.ts", // admin queue READ projection
    // --- Phase 26G RE-PIN (deliberate, not a relaxation) ---
    // Phase 26F shipped PATCH/DELETE /api/admin/plans/[id], which guards plan
    // deletion with `db.payment.count({ where: { requestedPlanId: id } })`.
    // That is the FIRST reference to a request INTENT field outside the
    // allowlist, so this suite has been RED on main since that merge. The
    // file is allowlisted here and PINNED READ-ONLY over Payment immediately
    // below (same proof shape as the admin queue route), so the invariant gets
    // a new guarantee rather than losing one: the intent field may be read for
    // a referential-integrity guard, never written outside the decision
    // service (src/lib/payment-transitions.ts remains the sole writer).
    "src/app/api/admin/plans/[id]/route.ts", // plan delete guard: counts referencing payments
  ]);
  const uniqueHits = srcFiles.filter((f) =>
    REQUEST_FIELDS.some((n) => new RegExp(`\\b${n}\\b`).test(fs.readFileSync(f, "utf8"))));
  ok(
    uniqueHits.every((f) => PR2A_REQUEST_ALLOWLIST.has(REL(f))) && uniqueHits.length > 0,
    `request fields referenced ONLY by the PR3 allowlist (${uniqueHits.map(REL).join(", ") || "none"})`
  );
  // PR3 tightening #1: the group/plan INTENT IDS stay server-side. A component
  // that names them could send an intent the server never asked for.
  const INTENT_IDS = ["requestedGroupId", "requestedPlanId"];
  const intentIdHits = srcFiles.filter((f) =>
    INTENT_IDS.some((n) => new RegExp(`\\b${n}\\b`).test(fs.readFileSync(f, "utf8"))));
  ok(
    intentIdHits.length > 0 && intentIdHits.every((f) => !REL(f).startsWith("src/components/")),
    `requested group/plan ids appear in server files only (${intentIdHits.map(REL).join(", ") || "none"})`
  );
  // PR3 tightening #2: the presentation layer writes nothing.
  const PR3_PRESENTATION_FILES = [
    "src/lib/payment-ux.ts",
    "src/components/student/payment-status.tsx",
    "src/components/admin/payment-review-drawer.tsx",
    "src/components/admin/admin-dashboard.tsx",
  ];
  ok(
    PR3_PRESENTATION_FILES.every((rel) => {
      const text = fs.readFileSync(path.join(REPO, rel), "utf8");
      return (
        !/payment\.(update|create|delete)\(/.test(text) && !/\$transaction\(/.test(text)
      );
    }),
    "PR3 presentation files never mutate a Payment (read + decision API only)"
  );
  const adminReadRoute = fs.readFileSync(
    path.join(REPO, "src/app/api/admin/payments/route.ts"),
    "utf8"
  );
  ok(
    !/payment\.(update|create|delete)\(/.test(adminReadRoute) &&
      !/\$transaction\(/.test(adminReadRoute),
    "the admin queue route is a pure read projection (no write, no transaction)"
  );
  // Phase 26G: the same read-only proof for the newly allowlisted plans route.
  // It may READ a request intent field to refuse deleting a plan that payments
  // still reference; it must never write a Payment or open a Payment
  // transaction. `db.payment.count(...)` is the only Payment access allowed.
  const adminPlansRoute = fs.readFileSync(
    path.join(REPO, "src/app/api/admin/plans/[id]/route.ts"),
    "utf8"
  );
  ok(
    !/payment\.(update|create|delete|upsert)\(/.test(adminPlansRoute) &&
      !/\$transaction\(/.test(adminPlansRoute) &&
      /db\.payment\.count\(/.test(adminPlansRoute),
    "the admin plans route only counts referencing payments (read-only, no Payment write, no transaction)"
  );
  // reviewedAt/reviewedByUserId pre-exist on TeacherApplication, so scope the
  // check: files that touch the payment delegate must not carry review WRITERS.
  const paymentFiles = srcFiles.filter((f) => /\.payment\b/.test(fs.readFileSync(f, "utf8")));
  ok(paymentFiles.length > 0, `payment-delegate files found (${paymentFiles.length})`);
  const PR2A_REVIEW_READER_ALLOWLIST = new Set([
    "src/lib/payment-submission.ts", // selects reviewedAt for the student's own history
    "src/app/api/students/me/payments/route.ts", // payload comments for the same rows
    "src/lib/payment-transitions.ts", // PR2b: writes reviewedAt/rejectionReason/reviewedByUserId
    "src/app/api/admin/payments/[id]/reject/route.ts", // PR2b: echoes result.payment.rejectionReason into the notification
    // --- PR3: read-only display of the decision outcome ---
    "src/app/api/admin/payments/route.ts", // admin queue exposes reviewedAt + rejectionReason
    "src/components/auth/enroll-view.tsx", // student rejection banner shows the reason
  ]);
  const reviewHits = paymentFiles.filter((f) => {
    const t = fs.readFileSync(f, "utf8");
    return /\breviewedAt\b/.test(t) || /\brejectionReason\b/.test(t);
  });
  ok(reviewHits.every((f) => PR2A_REVIEW_READER_ALLOWLIST.has(REL(f))),
    `review fields appear ONLY in the PR2a/PR3 read-contract files (${reviewHits.map(REL).join(", ") || "none"})`);
  // PR3 tightening #3: the student-facing rejection copy may show the REASON,
  // never who wrote it.
  ok(
    !/\breviewedBy\w*\b/.test(fs.readFileSync(path.join(REPO, "src/components/auth/enroll-view.tsx"), "utf8")) &&
      !/\breviewedBy\w*\b/.test(fs.readFileSync(path.join(REPO, "src/components/student/payment-status.tsx"), "utf8")) &&
      !/\breviewedBy\w*\b/.test(fs.readFileSync(path.join(REPO, "src/components/admin/payment-review-drawer.tsx"), "utf8")),
    "no PR3 surface names or renders a reviewer identity"
  );
  // reviewedByUserId may exist for OTHER review features (TeacherApplication
  // precedent). PR2b RE-PINS — not relaxes — the reviewer-audit invariant:
  // the reviewer write on Payment is now owned by exactly ONE file, the
  // decision service (the routes derive the reviewer from the session and
  // never read/write the field themselves). Any new file touching it fails
  // here until its phase re-pins it deliberately.
  const PR2B_REVIEWER_WRITER_ALLOWLIST = new Set([
    "src/lib/payment-transitions.ts", // PR2b: the sole Payment review-field writer
  ]);
  const reviewerHits = paymentFiles.filter((f) => /\breviewedByUserId\b/.test(fs.readFileSync(f, "utf8")));
  ok(
    reviewerHits.length > 0 && reviewerHits.every((f) => PR2B_REVIEWER_WRITER_ALLOWLIST.has(REL(f))),
    `reviewedByUserId referenced ONLY by the PR2b decision service (${reviewerHits.map(REL).join(", ") || "none"})`
  );

  // ---------------------------------------------------------------------------
  section("1. Migration SQL is forward-only additive (static scan)");
  // ---------------------------------------------------------------------------
  const codeOnly = stripSqlComments(migrationSql);
  for (const kw of ["DROP", "DELETE", "TRUNCATE", "UPDATE", "REFERENCES", "FOREIGN", "NOT NULL", "DEFAULT"]) {
    ok(!new RegExp(`\\b${kw.replace(/ /g, "\\s+")}\\b`, "i").test(codeOnly), `zero '${kw}' outside comments`);
  }
  const stmts = pgLib.splitSqlStatements(migrationSql);
  ok(stmts.length === 8, `exactly 8 statements (found ${stmts.length})`);
  // splitSqlStatements keeps leading comments attached; classify on stripped text.
  const bare = stmts.map((s) => stripSqlComments(s).trim()).filter(Boolean);
  const addCols = bare.filter((s) => /^\s*ALTER\s+TABLE/i.test(s));
  const createIdx = bare.filter((s) => /^\s*CREATE\s+INDEX/i.test(s));
  ok(addCols.length === 6 && createIdx.length === 2, "6x ADD COLUMN + 2x CREATE INDEX, nothing else");
  NEW_COLUMNS.forEach(([name, type], i) => {
    const re = new RegExp(`^ALTER\\s+TABLE\\s+"Payment"\\s+ADD\\s+COLUMN\\s+"${name}"\\s+${type.replace(/[()]/g, (c) => `\\${c}`)}\\s*;?\\s*$`, "i");
    ok(re.test(addCols[i] || ""), `ADD COLUMN "${name}" ${type} (#${i + 1})`);
  });
  NEW_INDEXES.forEach(([name, cols]) => {
    const re = new RegExp(`^CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+"${name}"\\s+ON\\s+"Payment"\\s+\\(${cols.map((c) => `"${c}"`).join("\\s*,\\s*")}\\)\\s*;?\\s*$`, "i");
    ok(createIdx.some((s) => re.test(s)), `CREATE INDEX "${name}" (${cols.join(", ")})`);
  });

  // ---------------------------------------------------------------------------
  section("2. schema.prisma: exactly the 6 fields + 2 indexes, nullable, bare");
  // ---------------------------------------------------------------------------
  const srcSchema = fs.readFileSync(path.join(REPO, "prisma", "schema.prisma"), "utf8");
  const paymentBlock = srcSchema.split("model Payment {")[1].split("\n}\n")[0];
  const fieldTypes = { senderPhone: "String?", requestedGroupId: "String?", requestedPlanId: "String?", rejectionReason: "String?", reviewedAt: "DateTime?", reviewedByUserId: "String?" };
  for (const [name, type] of Object.entries(fieldTypes)) {
    const line = paymentBlock.split("\n").find((l) => new RegExp(`^\\s*${name}\\s+`).test(l));
    ok(!!line, `Payment.${name} declared`);
    ok(!!line && new RegExp(`^\\s*${name}\\s+${type.replace("?", "\\?")}\\s*$`).test(line),
      `Payment.${name} is bare '${type}' (no default/relation)`);
  }
  ok(/^\s*@@index\(\[status,\s*createdAt\]\)\s*$/m.test(paymentBlock), "@@index([status, createdAt])");
  ok(/^\s*@@index\(\[subscriptionId,\s*status\]\)\s*$/m.test(paymentBlock), "@@index([subscriptionId, status])");
  ok((paymentBlock.match(/@relation/g) || []).length === 2, "relation count unchanged (2, pre-existing)");

  // ---------------------------------------------------------------------------
  section("3. Derived artifacts regen-in-sync + carry the ledger");
  // ---------------------------------------------------------------------------
  try {
    const checkOut = execFileSync("node", [path.join("scripts", "db", "make-postgres-schema.mjs"), "--check"], { cwd: REPO, encoding: "utf8" });
    ok(/in sync/.test(checkOut), "make-postgres-schema --check: committed artifacts in sync");
  } catch (e) {
    ok(false, `make-postgres-schema --check passes (${String((e && e.message) || e).slice(0, 200)})`);
  }
  const baseline = fs.readFileSync(path.join(REPO, "scripts", "db", "postgres-baseline.sql"), "utf8");
  for (const [name, type] of NEW_COLUMNS) {
    ok(new RegExp(`^\\s*"${name}"\\s+${type.replace(/[()]/g, (c) => `\\${c}`)},\\s*$`, "m").test(baseline),
      `baseline carries "${name}" ${type}`);
  }
  for (const [name, cols] of NEW_INDEXES) {
    ok(baseline.includes(`CREATE INDEX "${name}" ON "Payment" (${cols.map((c) => `"${c}"`).join(", ")});`),
      `baseline carries index "${name}"`);
  }
  const derived = fs.readFileSync(path.join(REPO, "prisma", "postgres", "schema.prisma"), "utf8");
  const derivedBlock = derived.split("model Payment {")[1].split("\n}\n")[0];
  ok(Object.keys(fieldTypes).every((n) => new RegExp(`^\\s*${n}\\s+`, "m").test(derivedBlock)),
    "derived PG schema carries all 6 fields");

  // ---------------------------------------------------------------------------
  section("3b. Fresh-provision / incremental convergence (offline PG proof)");
  // ---------------------------------------------------------------------------
  // The fresh-provision path (baseline DDL) and the incremental path (this
  // migration via `migrate deploy`) must converge on identical definitions.
  for (const [name, type] of NEW_COLUMNS) {
    const migType = new RegExp(`ADD\\s+COLUMN\\s+"${name}"\\s+([A-Za-z0-9_()]+)`, "i").exec(codeOnly)[1];
    const baseType = new RegExp(`"${name}"\\s+([A-Za-z0-9_()]+),`, "").exec(baseline)[1];
    ok(migType.toUpperCase() === baseType.toUpperCase() && migType.toUpperCase() === type,
      `"${name}": migration type == baseline type (${type})`);
  }
  for (const [name, cols] of NEW_INDEXES) {
    const migIdx = createIdx.find((s) => s.includes(`"${name}"`))
      .replace(/\s+IF\s+NOT\s+EXISTS\s+/i, " ").replace(/;\s*$/, "").trim();
    const baseIdx = `CREATE INDEX "${name}" ON "Payment" (${cols.map((c) => `"${c}"`).join(", ")})`;
    ok(migIdx === baseIdx, `index "${name}": migration DDL == baseline DDL (modulo IF NOT EXISTS)`);
  }

  // ---------------------------------------------------------------------------
  section("4. SQLite leg: real apply on a scratch pre-migration database");
  // ---------------------------------------------------------------------------
  const { DatabaseSync } = require("node:sqlite");
  const sqliteFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cm-p25-sqlite-")), "scratch.db");
  const lite = new DatabaseSync(sqliteFile);
  lite.exec("PRAGMA foreign_keys = ON;");
  lite.exec(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY);`);
  lite.exec(`CREATE TABLE "Subscription" ("id" TEXT NOT NULL PRIMARY KEY);`);
  lite.exec(`CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "subscriptionId" TEXT,
    "amount" REAL NOT NULL, "method" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reference" TEXT, "notes" TEXT, "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TEXT NOT NULL,
    FOREIGN KEY ("userId") REFERENCES "User"("id"),
    FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id"));`);
  lite.exec(`INSERT INTO "User" ("id") VALUES ('u1'), ('u2'), ('u3');`);
  lite.exec(`INSERT INTO "Subscription" ("id") VALUES ('s-x1');`);
  const seed4 = [
    ["p1", "u1", null, 500, "INSTAPAY", "PENDING", "REF-1", null, "2026-09-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z"],
    ["p2", "u2", "s-x1", 750, "VODAFONE_CASH", "PENDING", "REF-2", "call first", "2026-09-02T10:00:00.000Z", "2026-09-02T10:00:00.000Z"],
    ["p3", "u2", "s-x1", 750, "VODAFONE_CASH", "APPROVED", "REF-2", null, "2026-09-02T10:00:00.000Z", "2026-09-03T10:00:00.000Z"],
    ["p4", "u3", null, 300, "INSTAPAY", "REJECTED", "REF-4", "bad receipt", "2026-09-04T10:00:00.000Z", "2026-09-05T10:00:00.000Z"],
  ];
  const insOld = lite.prepare(`INSERT INTO "Payment" ("id","userId","subscriptionId","amount","method","status","reference","notes","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const r of seed4) insOld.run(...r);
  const beforeSqlite = lite.prepare(`SELECT ${OLD_PAYMENT_COLS.map((c) => `"${c}"`).join(",")} FROM "Payment" ORDER BY "id"`).all();
  lite.exec(migrationSql); // raw file bytes, comments included
  const afterSqlite = lite.prepare(`SELECT ${OLD_PAYMENT_COLS.map((c) => `"${c}"`).join(",")} FROM "Payment" ORDER BY "id"`).all();
  ok(JSON.stringify(afterSqlite) === JSON.stringify(beforeSqlite), "all 4 pre-existing rows byte-identical after apply");
  const nulls = lite.prepare(`SELECT "senderPhone","requestedGroupId","requestedPlanId","rejectionReason","reviewedAt","reviewedByUserId" FROM "Payment"`).all();
  ok(nulls.length === 4 && nulls.every((r) => Object.values(r).every((v) => v === null)),
    "new columns read NULL for all pre-existing rows");
  const liteIdx = lite.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='Payment'`).all();
  for (const [name, cols] of NEW_INDEXES) {
    const row = liteIdx.find((r) => r.name === name);
    ok(!!row, `index "${name}" created`);
    const info = lite.prepare(`PRAGMA index_info("${name}")`).all().sort((a, b) => a.seqno - b.seqno).map((r) => r.name);
    ok(JSON.stringify(info) === JSON.stringify(cols), `index "${name}" covers (${cols.join(", ")}) in order`);
  }
  const liteCols = lite.prepare(`PRAGMA table_info("Payment")`).all();
  ok(liteCols.length === 16, "Payment now has 16 columns (was 10, +6)");
  for (const [name, type] of NEW_COLUMNS) {
    const c = liteCols.find((x) => x.name === name);
    ok(!!c && c.notnull === 0 && c.dflt_value === null, `"${name}" nullable, no default`);
    ok(!!c && String(c.type).toUpperCase() === type, `"${name}" stored as ${type}`);
  }
  // New-style write (incl. garbage FK-less ids) + legacy write both succeed.
  lite.prepare(`INSERT INTO "Payment" ("id","userId","amount","method","status","createdAt","updatedAt","senderPhone","requestedGroupId","requestedPlanId")
    VALUES ('p-new','u1',500,'INSTAPAY','PENDING','2026-09-13T10:00:00.000Z','2026-09-13T10:00:00.000Z','01001234567','grp-does-not-exist','plan-does-not-exist')`).run();
  ok(lite.prepare(`SELECT "requestedGroupId" FROM "Payment" WHERE "id"='p-new'`).get().requestedGroupId === "grp-does-not-exist",
    "FK-less request columns accept arbitrary ids (no FK enforcement)");
  lite.prepare(`INSERT INTO "Payment" ("id","userId","amount","method","createdAt","updatedAt") VALUES ('p-leg','u2',100,'INSTAPAY','2026-09-13T10:00:00.000Z','2026-09-13T10:00:00.000Z')`).run();
  ok(lite.prepare(`SELECT "status" FROM "Payment" WHERE "id"='p-leg'`).get().status === "PENDING",
    "legacy-style insert still defaults to PENDING");
  let fkIntact = false;
  try {
    lite.prepare(`INSERT INTO "Payment" ("id","userId","amount","method","createdAt","updatedAt") VALUES ('p-bad','ghost',100,'INSTAPAY','2026-09-13T10:00:00.000Z','2026-09-13T10:00:00.000Z')`).run();
  } catch { fkIntact = true; }
  ok(fkIntact, "pre-existing userId FK still enforced (bad insert rejected)");
  lite.close();

  // ---------------------------------------------------------------------------
  section("5. PostgreSQL leg: the SAME bytes applied on real PG (PGlite)");
  // ---------------------------------------------------------------------------
  let PGlite = null;
  try {
    // require() first: it honors NODE_PATH (dynamic import does not), which
    // lets dependency-less sandboxes point at a side-installed PGlite.
    PGlite = require("@electric-sql/pglite").PGlite;
  } catch {
    try {
      ({ PGlite } = await import("@electric-sql/pglite"));
    } catch {
      console.log("  !! PGLITE_MISSING_FALLBACK_USED: @electric-sql/pglite not importable;");
      console.log("     PG-dialect validity rests on §1 (whitelist) + §3b (baseline equivalence).");
    }
  }
  let pg = null; // §5 scratch (migration mechanics)
  if (PGlite) {
    pg = new PGlite();
    await pg.query(`CREATE TYPE "PaymentMethod" AS ENUM ('INSTAPAY','VODAFONE_CASH','ETISALAT_CASH');`);
    await pg.query(`CREATE TYPE "PaymentStatus" AS ENUM ('PENDING','APPROVED','REJECTED','EXPIRED');`);
    await pg.query(`CREATE TABLE "User" ("id" TEXT NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id"));`);
    await pg.query(`CREATE TABLE "Subscription" ("id" TEXT NOT NULL, CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id"));`);
    await pg.query(`CREATE TABLE "Payment" (
      "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "subscriptionId" TEXT,
      "amount" DOUBLE PRECISION NOT NULL, "method" "PaymentMethod" NOT NULL,
      "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING', "reference" TEXT, "notes" TEXT,
      "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
      CONSTRAINT "Payment_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON UPDATE CASCADE,
      CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON UPDATE CASCADE);`);
    await pg.query(`INSERT INTO "User" ("id") VALUES ('u1'), ('u2'), ('u3');`);
    await pg.query(`INSERT INTO "Subscription" ("id") VALUES ('s-x1');`);
    for (const r of seed4) {
      await pg.query(`INSERT INTO "Payment" ("id","userId","subscriptionId","amount","method","status","reference","notes","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, r);
    }
    const beforePg = canonRows((await pg.query(`SELECT ${OLD_PAYMENT_COLS.map((c) => `"${c}"`).join(",")} FROM "Payment" ORDER BY "id"`)).rows);
    for (const s of stmts) await pg.query(s); // SAME bytes as §4, statement-split
    const afterPg = canonRows((await pg.query(`SELECT ${OLD_PAYMENT_COLS.map((c) => `"${c}"`).join(",")} FROM "Payment" ORDER BY "id"`)).rows);
    ok(JSON.stringify(afterPg) === JSON.stringify(beforePg), "PG: all 4 pre-existing rows identical after apply");
    const pgNulls = (await pg.query(`SELECT "senderPhone","requestedGroupId","requestedPlanId","rejectionReason","reviewedAt","reviewedByUserId" FROM "Payment"`)).rows;
    ok(pgNulls.length === 4 && pgNulls.every((r) => Object.values(r).every((v) => v === null)),
      "PG: new columns read NULL for all pre-existing rows");
    const pgCols = (await pg.query(`SELECT column_name, is_nullable, udt_name FROM information_schema.columns WHERE table_name='Payment'`)).rows;
    ok(pgCols.length === 16, "PG: Payment now has 16 columns (was 10, +6)");
    for (const [name] of NEW_COLUMNS) {
      const c = pgCols.find((x) => x.column_name === name);
      const wantUdt = name === "reviewedAt" ? "timestamptz" : "text";
      ok(!!c && c.is_nullable === "YES" && c.udt_name === wantUdt, `PG: "${name}" nullable ${wantUdt}`);
    }
    const pgIdx = (await pg.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename='Payment'`)).rows;
    for (const [name, cols] of NEW_INDEXES) {
      const row = pgIdx.find((r) => r.indexname === name);
      ok(!!row && cols.every((c) => row.indexdef.includes(c)), `PG: index "${name}" on (${cols.join(", ")})`);
    }
    await pg.query(`INSERT INTO "Payment" ("id","userId","amount","method","status","createdAt","updatedAt","senderPhone","requestedGroupId","requestedPlanId")
      VALUES ('p-new','u1',500,'INSTAPAY','PENDING','2026-09-13T10:00:00.000Z','2026-09-13T10:00:00.000Z','01001234567','grp-does-not-exist','plan-does-not-exist')`);
    ok(((await pg.query(`SELECT "requestedPlanId" FROM "Payment" WHERE "id"='p-new'`)).rows[0] || {}).requestedPlanId === "plan-does-not-exist",
      "PG: FK-less request columns accept arbitrary ids");
    await pg.query(`INSERT INTO "Payment" ("id","userId","amount","method","createdAt","updatedAt") VALUES ('p-leg','u2',100,'INSTAPAY','2026-09-13T10:00:00.000Z','2026-09-13T10:00:00.000Z')`);
    ok(((await pg.query(`SELECT "status" FROM "Payment" WHERE "id"='p-leg'`)).rows[0] || {}).status === "PENDING",
      "PG: legacy-style insert still defaults to PENDING");
    let pgFk = false;
    try {
      await pg.query(`INSERT INTO "Payment" ("id","userId","amount","method","createdAt","updatedAt") VALUES ('p-bad','ghost',100,'INSTAPAY','2026-09-13T10:00:00.000Z','2026-09-13T10:00:00.000Z')`);
    } catch (e) { pgFk = /23503|foreign key/i.test(String((e && e.message) || e)); }
    ok(pgFk, "PG: pre-existing userId FK still enforced (23503 on bad insert)");
  }

  // ---------------------------------------------------------------------------
  section("6. Operator report queries A-F: read-only + expected rows, both engines");
  // ---------------------------------------------------------------------------
  const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|VACUUM)\b/i;
  for (const [key, sql] of Object.entries(REPORT_QUERIES)) {
    ok(/^\s*SELECT\b/i.test(sql), `${key}: starts with SELECT`);
    ok(!FORBIDDEN.test(sql), `${key}: zero write/DDL keywords`);
    ok(!/[;]/.test(sql) && !/--|\/\*/.test(sql), `${key}: single statement, no comments`);
  }
  // Fixture (fresh scratch DBs so §4/§5 seeds cannot leak into reports).
  const OLD_PAYMENT_SQLITE = `CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "subscriptionId" TEXT,
    "amount" REAL NOT NULL, "method" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reference" TEXT, "notes" TEXT, "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TEXT NOT NULL,
    FOREIGN KEY ("userId") REFERENCES "User"("id"), FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id"));`;
  const FIX_USERS = ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u-admin"];
  const FIX_STUDENTS = [["st1", "u1", "g1"], ["st2", "u2", "g1"], ["st3", "u3", null], ["st4", "u4", "g2"]];
  const FIX_SUBS = [
    ["s1", "st1", "pl1", "ACTIVE", "2026-09-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
    ["s2", "st2", "pl1", "ACTIVE", "2026-10-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"],
    ["s3", "st3", "pl2", "PENDING", null, "2026-09-10T00:00:00.000Z"],
    ["s4", "st2", "pl2", "EXPIRED", "2026-08-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"],
    ["s5", "st4", "pl1", "PENDING", null, "2026-09-11T00:00:00.000Z"],
  ];
  const FIX_PAYMENTS = [
    ["q1", "u4", null, 500, "INSTAPAY", "PENDING", null, null, "2026-09-12T10:00:00.000Z", "2026-09-12T10:00:00.000Z", "01001234567", "g2", "pl1", null, null, null],
    ["q2", "u5", null, 500, "VODAFONE_CASH", "PENDING", "LEGACY-9", null, "2026-09-12T11:00:00.000Z", "2026-09-12T11:00:00.000Z", null, null, null, null, null, null],
    ["q3", "u6", "s4", 500, "INSTAPAY", "REJECTED", null, null, "2026-09-12T09:00:00.000Z", "2026-09-13T08:00:00.000Z", null, null, null, "Receipt unreadable", "2026-09-13T08:00:00.000Z", "u-admin"],
    ["q4", "u7", null, 300, "VODAFONE_CASH", "REJECTED", null, null, "2026-09-12T09:30:00.000Z", "2026-09-12T09:30:00.000Z", null, null, null, "Wrong amount", null, null],
  ];
  const buildSqliteFixture = () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cm-p25-rep-")), "rep.db");
    const db = new DatabaseSync(f);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY);`);
    db.exec(`CREATE TABLE "Student" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "groupId" TEXT);`);
    db.exec(`CREATE TABLE "Subscription" ("id" TEXT NOT NULL PRIMARY KEY, "studentId" TEXT NOT NULL, "planId" TEXT NOT NULL, "status" TEXT NOT NULL, "endDate" TEXT, "createdAt" TEXT NOT NULL);`);
    db.exec(OLD_PAYMENT_SQLITE);
    db.exec(`CREATE TABLE "Coupon" ("id" TEXT NOT NULL PRIMARY KEY, "code" TEXT NOT NULL);`);
    db.exec(`CREATE TABLE "CouponRedemption" ("id" TEXT NOT NULL PRIMARY KEY, "couponId" TEXT NOT NULL, "userId" TEXT NOT NULL, "paymentId" TEXT);`);
    db.exec(migrationSql); // old shape created above, then migrated — same bytes
    const iu = db.prepare(`INSERT INTO "User" ("id") VALUES (?)`);
    for (const u of FIX_USERS) iu.run(u);
    const ist = db.prepare(`INSERT INTO "Student" ("id","userId","groupId") VALUES (?,?,?)`);
    for (const r of FIX_STUDENTS) ist.run(...r);
    const is = db.prepare(`INSERT INTO "Subscription" ("id","studentId","planId","status","endDate","createdAt") VALUES (?,?,?,?,?,?)`);
    for (const r of FIX_SUBS) is.run(...r);
    const ip = db.prepare(`INSERT INTO "Payment" ("id","userId","subscriptionId","amount","method","status","reference","notes","createdAt","updatedAt","senderPhone","requestedGroupId","requestedPlanId","rejectionReason","reviewedAt","reviewedByUserId") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of FIX_PAYMENTS) ip.run(...r);
    db.exec(`INSERT INTO "Coupon" ("id","code") VALUES ('c1','RAMADAN20');`);
    db.exec(`INSERT INTO "CouponRedemption" ("id","couponId","userId","paymentId") VALUES ('cr1','c1','u6','q3'), ('cr2','c1','u5',NULL);`);
    return db;
  };
  const runReport = (rows) => rows.map((r) => r.id);
  const repLite = buildSqliteFixture();
  const sqliteResults = {};
  for (const [key, sql] of Object.entries(REPORT_QUERIES)) {
    const params = sql.includes("$1") ? [REPORT_NOW] : [];
    const rows = canonRows(repLite.prepare(sql.replaceAll("$1", "?")).all(...params));
    sqliteResults[key] = rows;
    ok(JSON.stringify(runReport(rows)) === JSON.stringify(REPORT_EXPECTED_IDS[key]),
      `SQLite report ${key}: rows [${runReport(rows).join(",")}] (expected [${REPORT_EXPECTED_IDS[key].join(",")}])`);
  }
  ok(sqliteResults.A[0] && sqliteResults.A[0].planId === "pl1" && sqliteResults.A[0].endDate === "2026-09-01T00:00:00.000Z",
    "SQLite report A: past-due row carries plan + endDate");
  ok(sqliteResults.F[0] && sqliteResults.F[0].couponId === "c1" && sqliteResults.F[0].reviewedByUserId === "u-admin",
    "SQLite report F: rejected row carries coupon + reviewer");
  repLite.close();

  let pgRep = null;
  if (PGlite) {
    pgRep = new PGlite();
    await pgRep.query(`CREATE TYPE "PaymentMethod" AS ENUM ('INSTAPAY','VODAFONE_CASH','ETISALAT_CASH');`);
    await pgRep.query(`CREATE TYPE "PaymentStatus" AS ENUM ('PENDING','APPROVED','REJECTED','EXPIRED');`);
    await pgRep.query(`CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING','ACTIVE','EXPIRED','CANCELLED');`);
    await pgRep.query(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY);`);
    await pgRep.query(`CREATE TABLE "Student" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "groupId" TEXT);`);
    await pgRep.query(`CREATE TABLE "Subscription" ("id" TEXT NOT NULL PRIMARY KEY, "studentId" TEXT NOT NULL, "planId" TEXT NOT NULL, "status" "SubscriptionStatus" NOT NULL, "endDate" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL);`);
    await pgRep.query(`CREATE TABLE "Payment" (
      "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "subscriptionId" TEXT,
      "amount" DOUBLE PRECISION NOT NULL, "method" "PaymentMethod" NOT NULL,
      "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING', "reference" TEXT, "notes" TEXT,
      "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
      CONSTRAINT "Payment_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON UPDATE CASCADE,
      CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON UPDATE CASCADE);`);
    await pgRep.query(`CREATE TABLE "Coupon" ("id" TEXT NOT NULL PRIMARY KEY, "code" TEXT NOT NULL);`);
    await pgRep.query(`CREATE TABLE "CouponRedemption" ("id" TEXT NOT NULL PRIMARY KEY, "couponId" TEXT NOT NULL, "userId" TEXT NOT NULL, "paymentId" TEXT);`);
    for (const s of stmts) await pgRep.query(s); // SAME migration bytes again
    for (const u of FIX_USERS) await pgRep.query(`INSERT INTO "User" ("id") VALUES ($1)`, [u]);
    for (const r of FIX_STUDENTS) await pgRep.query(`INSERT INTO "Student" ("id","userId","groupId") VALUES ($1,$2,$3)`, r);
    for (const r of FIX_SUBS) await pgRep.query(`INSERT INTO "Subscription" ("id","studentId","planId","status","endDate","createdAt") VALUES ($1,$2,$3,$4,$5,$6)`, r);
    for (const r of FIX_PAYMENTS) {
      await pgRep.query(`INSERT INTO "Payment" ("id","userId","subscriptionId","amount","method","status","reference","notes","createdAt","updatedAt","senderPhone","requestedGroupId","requestedPlanId","rejectionReason","reviewedAt","reviewedByUserId")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, r);
    }
    await pgRep.query(`INSERT INTO "Coupon" ("id","code") VALUES ('c1','RAMADAN20');`);
    await pgRep.query(`INSERT INTO "CouponRedemption" ("id","couponId","userId","paymentId") VALUES ('cr1','c1','u6','q3'), ('cr2','c1','u5',NULL);`);
    for (const [key, sql] of Object.entries(REPORT_QUERIES)) {
      const pgParams = sql.includes("$1") ? [REPORT_NOW] : [];
      const rows = canonRows((await pgRep.query(sql, pgParams)).rows);
      ok(JSON.stringify(runReport(rows)) === JSON.stringify(REPORT_EXPECTED_IDS[key]),
        `PG report ${key}: rows [${runReport(rows).join(",")}] (expected [${REPORT_EXPECTED_IDS[key].join(",")}])`);
      ok(JSON.stringify(rows) === JSON.stringify(sqliteResults[key]),
        `PG report ${key}: full result identical to SQLite result`);
    }
  } else {
    console.log("  !! PG report leg skipped (no PGlite) — SQLite results above + §3b equivalence stand in.");
  }

  // ---------------------------------------------------------------------------
  section("7. Ledger position: one new migration, sorted last, history intact");
  // ---------------------------------------------------------------------------
  const migs = fs.readdirSync(path.join(REPO, "prisma", "migrations"))
    .filter((d) => fs.existsSync(path.join(REPO, "prisma", "migrations", d, "migration.sql")))
    .sort();
  // Phase 26D appended the Lesson Quiz attempt-architecture migration, so the
  // history is 12. The invariant here is that the ledger migration is intact and
  // correctly positioned, not the literal total.
  // Phase F appended one authorized additive migration (the live-session
  // lifecycle); the ledger migration's POSITION (10th) is asserted just below
  // and is unaffected by an append at the end.
  // Phase G appended two workflow migrations and Phase H the audited
  // progression-override table — all authorized, all additive, all after F.
  ok(migs.length === 20, `20 migrations in history (found ${migs.length}) — Phase 26B added the group-audience migration, Phase 26D the quiz attempt-architecture migration, Phase F the live-session lifecycle, Phase G two workflow migrations, Phase H the override table, session-video requirement the flag, requirement modes the mode + link, readiness-reminder recipients the student nudge type, and K1 the academic-level capability + backfill`);
  ok(migs[migs.length - 1] === "20260923100000_k1_academic_level_capability", "the K1 academic-level capability migration sorts last (append-only history)");
  ok(migs.includes(MIGRATION_DIR), `new migration '${MIGRATION_DIR}' present`);
  ok(migs[9] === MIGRATION_DIR, "ledger migration still applies after its 9 predecessors (10th position)");
  ok(migs.includes("20260915120000_phase26b_group_track_scope"), "the Phase 26B group-audience migration is present (Phase 26D appended a later one)");
  ok(fs.statSync(MIGRATION_SQL).size > 0, "migration.sql non-empty");

  if (pg) await pg.close();
  if (pgRep) await pgRep.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
