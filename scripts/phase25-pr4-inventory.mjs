// CodeMind Academy — Phase 25 PR4: production inventory + dry-run anomaly detection
// READ-ONLY operator report for Neon / PostgreSQL 17 + SQLite fallback.
//   node scripts/phase25-pr4-inventory.mjs [--target <url>] [--pglite <dir>] [--now <iso>] [--json] [--json-out <path>]
//   DATABASE_URL env is used when --target is absent.
// Every query is a single SELECT. No write operation is issued.
// Engine is detected from the URL; SQLite fallback is for local verification only.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_FIELDS = ["senderPhone", "requestedGroupId", "requestedPlanId", "rejectionReason", "reviewedAt", "reviewedByUserId"];
const EXPECTED_INDEXES = ["Payment_status_createdAt_idx", "Payment_subscriptionId_status_idx"];

function redactDatabaseUrl(url) {
  if (!url) return "(none)";
  try {
    const u = new URL(String(url));
    const host = u.host || "(local)";
    const db = u.pathname && u.pathname !== "/" ? u.pathname : "";
    return `${u.protocol}//${host}${db}`;
  } catch {
    const s = String(url);
    if (s.startsWith("file:")) return s.split("?")[0];
    return "(unparseable)";
  }
}
function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
function hasFlag(argv, name) { return argv.includes(name); }

// single SELECT per entry; $1 is the "now" cutoff ISO for time checks
const Q = {
  // counts
  studentTotal: `SELECT COUNT(*) AS n FROM "Student"`,
  studentWithGroup: `SELECT COUNT(*) AS n FROM "Student" WHERE "groupId" IS NOT NULL`,
  studentWithoutGroup: `SELECT COUNT(*) AS n FROM "Student" WHERE "groupId" IS NULL`,
  studentWithSub: `SELECT COUNT(*) AS n FROM "Student" s WHERE EXISTS (SELECT 1 FROM "Subscription" sub WHERE sub."studentId" = s."id")`,
  studentWithoutSub: `SELECT COUNT(*) AS n FROM "Student" s WHERE NOT EXISTS (SELECT 1 FROM "Subscription" sub WHERE sub."studentId" = s."id")`,
  subPending: `SELECT COUNT(*) AS n FROM "Subscription" WHERE "status" = 'PENDING'`,
  subActive: `SELECT COUNT(*) AS n FROM "Subscription" WHERE "status" = 'ACTIVE'`,
  subExpired: `SELECT COUNT(*) AS n FROM "Subscription" WHERE "status" = 'EXPIRED'`,
  subCancelled: `SELECT COUNT(*) AS n FROM "Subscription" WHERE "status" = 'CANCELLED'`,
  subActiveExpired: `SELECT COUNT(*) AS n FROM "Subscription" WHERE "status" = 'ACTIVE' AND "endDate" IS NOT NULL AND "endDate" < $1`,
  subActiveFuture: `SELECT COUNT(*) AS n FROM "Subscription" WHERE "status" = 'ACTIVE' AND ("endDate" IS NULL OR "endDate" > $1)`,
  subActiveNoGroup: `SELECT COUNT(*) AS n FROM "Subscription" sub JOIN "Student" s ON s."id" = sub."studentId" WHERE sub."status" = 'ACTIVE' AND s."groupId" IS NULL`,
  subPlanBad: `SELECT COUNT(*) AS n FROM "Subscription" sub LEFT JOIN "SubscriptionPlan" p ON p."id" = sub."planId" WHERE p."id" IS NULL OR NOT p."isActive"`,
  payPending: `SELECT COUNT(*) AS n FROM "Payment" WHERE "status" = 'PENDING'`,
  payApproved: `SELECT COUNT(*) AS n FROM "Payment" WHERE "status" = 'APPROVED'`,
  payRejected: `SELECT COUNT(*) AS n FROM "Payment" WHERE "status" = 'REJECTED'`,
  payExpired: `SELECT COUNT(*) AS n FROM "Payment" WHERE "status" = 'EXPIRED'`,
  payLegacy: `SELECT COUNT(*) AS n FROM "Payment" WHERE "senderPhone" IS NULL AND "requestedGroupId" IS NULL AND "requestedPlanId" IS NULL`,
  payPendingNoSub: `SELECT COUNT(*) AS n FROM "Payment" WHERE "status" = 'PENDING' AND "subscriptionId" IS NULL`,
  payPendingNoGroup: `SELECT COUNT(*) AS n FROM "Payment" WHERE "status" = 'PENDING' AND "requestedGroupId" IS NULL`,
  payPendingNoPlan: `SELECT COUNT(*) AS n FROM "Payment" WHERE "status" = 'PENDING' AND "requestedPlanId" IS NULL`,
  payApprovedNoReviewer: `SELECT COUNT(*) AS n FROM "Payment" WHERE "status" = 'APPROVED' AND ("reviewedAt" IS NULL OR "reviewedByUserId" IS NULL)`,
  payApprovedNoSub: `SELECT COUNT(*) AS n FROM "Payment" WHERE "status" = 'APPROVED' AND "subscriptionId" IS NULL`,
  payRejectedNoReason: `SELECT COUNT(*) AS n FROM "Payment" WHERE "status" = 'REJECTED' AND ("rejectionReason" IS NULL OR TRIM("rejectionReason") = '')`,
  payDupRefGroups: `SELECT COUNT(*) AS n FROM (SELECT "reference" FROM "Payment" WHERE "status" = 'PENDING' AND "reference" IS NOT NULL GROUP BY "reference" HAVING COUNT(*) > 1) d`,
  stalePending: `SELECT COUNT(*) AS n FROM "Payment" p WHERE p."status" = 'PENDING' AND EXISTS (SELECT 1 FROM "Payment" newer WHERE newer."userId" = p."userId" AND newer."status" = 'PENDING' AND newer."id" <> p."id" AND (newer."createdAt" > p."createdAt" OR (newer."createdAt" = p."createdAt" AND newer."id" > p."id")))`,
  groupActive: `SELECT COUNT(*) AS n FROM "Group" WHERE "isActive"`,
  groupInactive: `SELECT COUNT(*) AS n FROM "Group" WHERE NOT "isActive"`,
  studentsInInactive: `SELECT COUNT(*) AS n FROM "Student" s JOIN "Group" g ON g."id" = s."groupId" WHERE NOT g."isActive"`,
  couponPendingRedemptions: `SELECT COUNT(*) AS n FROM "CouponRedemption" r JOIN "Payment" p ON p."id" = r."paymentId" WHERE p."status" = 'PENDING'`,
  couponRejectedRedemptions: `SELECT COUNT(*) AS n FROM "CouponRedemption" r JOIN "Payment" p ON p."id" = r."paymentId" WHERE p."status" = 'REJECTED'`,
  couponOrphan: `SELECT COUNT(*) AS n FROM "CouponRedemption" r LEFT JOIN "Payment" p ON p."id" = r."paymentId" WHERE r."paymentId" IS NOT NULL AND p."id" IS NULL`,
  // legacy / expected
  grandfathered: `SELECT COUNT(*) AS n FROM "Student" s JOIN "Group" g ON g."id" = s."groupId" WHERE g."isActive" AND g."courseId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Subscription" sub WHERE sub."studentId" = s."id")`,
  grandfatheredWithPending: `SELECT COUNT(*) AS n FROM "Student" s JOIN "Group" g ON g."id" = s."groupId" JOIN "User" u ON u."id" = s."userId" WHERE g."isActive" AND g."courseId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Subscription" sub WHERE sub."studentId" = s."id") AND EXISTS (SELECT 1 FROM "Payment" p WHERE p."userId" = u."id" AND p."status" = 'PENDING')`,
  newPendingNoGroup: `SELECT COUNT(*) AS n FROM "Payment" p JOIN "User" u ON u."id" = p."userId" JOIN "Student" s ON s."userId" = u."id" JOIN "Subscription" sub ON sub."studentId" = s."id" WHERE p."status" = 'PENDING' AND sub."status" = 'PENDING' AND s."groupId" IS NULL`,
  activeRenewalPending: `SELECT COUNT(*) AS n FROM "Payment" p JOIN "User" u ON u."id" = p."userId" JOIN "Student" s ON s."userId" = u."id" JOIN "Subscription" sub ON sub."studentId" = s."id" WHERE p."status" = 'PENDING' AND sub."status" = 'ACTIVE' AND ("endDate" IS NULL OR sub."endDate" > $1) AND s."groupId" IS NOT NULL`,
  planActive: `SELECT COUNT(*) AS n FROM "SubscriptionPlan" WHERE "isActive"`,
  planInactive: `SELECT COUNT(*) AS n FROM "SubscriptionPlan" WHERE NOT "isActive"`,
  // anomalies sample ids (limit 20)
  A_ids: `SELECT p."id" AS id FROM "Payment" p LEFT JOIN "Subscription" s ON s."id" = p."subscriptionId" WHERE p."status" = 'APPROVED' AND (s."id" IS NULL OR s."status" <> 'ACTIVE' OR (s."endDate" IS NOT NULL AND s."endDate" < $1)) ORDER BY p."createdAt" LIMIT 20`,
  B_ids: `SELECT sub."id" AS id FROM "Subscription" sub JOIN "Student" s ON s."id" = sub."studentId" WHERE sub."status" = 'ACTIVE' AND (sub."endDate" IS NULL OR sub."endDate" > $1) AND s."groupId" IS NULL ORDER BY sub."id" LIMIT 20`,
  C_ids: `SELECT "id" AS id FROM "Subscription" WHERE "status" = 'ACTIVE' AND "endDate" IS NOT NULL AND "endDate" < $1 ORDER BY "endDate" LIMIT 20`,
  E_ids: `SELECT s."id" AS id FROM "Student" s JOIN "Group" g ON g."id" = s."groupId" WHERE NOT g."isActive" ORDER BY s."id" LIMIT 20`,
  F_ids: `SELECT "id" AS id FROM "Payment" WHERE "status" = 'APPROVED' AND ("reviewedAt" IS NULL OR "reviewedByUserId" IS NULL) ORDER BY "createdAt" LIMIT 20`,
  G_ids: `SELECT "id" AS id FROM "Payment" WHERE "status" = 'REJECTED' AND ("rejectionReason" IS NULL OR TRIM("rejectionReason") = '') ORDER BY "createdAt" LIMIT 20`,
  H_ids: `SELECT p."id" AS id FROM "Payment" p WHERE p."status" = 'PENDING' AND EXISTS (SELECT 1 FROM "Payment" newer WHERE newer."userId" = p."userId" AND newer."status" = 'PENDING' AND newer."id" <> p."id" AND (newer."createdAt" > p."createdAt" OR (newer."createdAt" = p."createdAt" AND newer."id" > p."id"))) ORDER BY p."createdAt" LIMIT 20`,
  I_ids: `SELECT p."id" AS id FROM "Payment" p JOIN "User" u ON u."id" = p."userId" JOIN "Student" s ON s."userId" = u."id" WHERE p."status" = 'PENDING' AND p."requestedGroupId" IS NULL AND s."groupId" IS NULL ORDER BY p."createdAt" LIMIT 20`,
  J_ids: `SELECT p."id" AS id FROM "Payment" p JOIN "User" u ON u."id" = p."userId" LEFT JOIN "Student" s ON s."userId" = u."id" LEFT JOIN "Subscription" sub ON sub."studentId" = s."id" LEFT JOIN "SubscriptionPlan" pl ON pl."id" = sub."planId" WHERE p."status" = 'PENDING' AND p."requestedPlanId" IS NULL AND (sub."id" IS NULL OR sub."status" <> 'ACTIVE' OR (sub."endDate" IS NOT NULL AND sub."endDate" < $1) OR pl."id" IS NULL OR NOT pl."isActive") ORDER BY p."createdAt" LIMIT 20`,
  K_ids: `SELECT p."id" AS id FROM "Payment" p JOIN "Subscription" sub ON sub."id" = p."subscriptionId" JOIN "Student" st ON st."id" = sub."studentId" WHERE st."userId" <> p."userId" ORDER BY p."createdAt" LIMIT 20`,
  L_dups: `SELECT "studentId" AS id, COUNT(*) AS c FROM "Subscription" GROUP BY "studentId" HAVING COUNT(*) > 1 ORDER BY c DESC LIMIT 20`,
  M_ids: `SELECT p."id" AS id FROM "Payment" p JOIN "Group" req ON req."id" = p."requestedGroupId" JOIN "User" u ON u."id" = p."userId" JOIN "Student" s ON s."userId" = u."id" JOIN "Group" cur ON cur."id" = s."groupId" WHERE p."status" = 'PENDING' AND p."requestedGroupId" IS NOT NULL AND s."groupId" IS NOT NULL AND req."courseId" <> cur."courseId" ORDER BY p."createdAt" LIMIT 20`,
  N_ids: `SELECT p."id" AS id FROM "Payment" p LEFT JOIN "Student" s ON s."userId" = p."userId" WHERE s."id" IS NULL ORDER BY p."createdAt" LIMIT 20`,
  // group capacity details: one row per group
  groupCapacity: `SELECT g."id" AS id, g."name" AS name, g."capacity" AS capacity, g."isActive" AS isActive, g."courseId" AS courseId FROM "Group" g ORDER BY g."id"`,
  groupMembers: `SELECT "groupId" AS gid, COUNT(*) AS n FROM "Student" WHERE "groupId" IS NOT NULL GROUP BY "groupId"`,
  pendingByGroup: `SELECT "requestedGroupId" AS gid, COUNT(*) AS n FROM "Payment" WHERE "status" = 'PENDING' AND "requestedGroupId" IS NOT NULL GROUP BY "requestedGroupId"`,
  // plan detail
  planPendingBad: `SELECT p."id" AS id FROM "Payment" p LEFT JOIN "SubscriptionPlan" pl ON pl."id" = p."requestedPlanId" WHERE p."status" = 'PENDING' AND p."requestedPlanId" IS NOT NULL AND (pl."id" IS NULL OR NOT pl."isActive") ORDER BY p."createdAt" LIMIT 20`,
};

async function createBackend(target, pgliteDir) {
  if (pgliteDir) {
    const { PGlite } = await import("@electric-sql/pglite");
    const pglite = new PGlite(pgliteDir);
    return {
      engine: "PostgreSQL",
      hostLabel: `pglite:${pgliteDir}`,
      query: async (sql, params = []) => {
        const r = await pglite.query(sql, params);
        return { rows: r.rows };
      },
      close: async () => pglite.close(),
    };
  }
  let url = target || process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
  if (!url) throw new Error("No DATABASE_URL and no --target / --pglite provided");
  const isFile = url.startsWith("file:") || url.endsWith(".db") || (!url.includes("://") && url.includes("/"));
  const isPostgres = url.startsWith("postgres://") || url.startsWith("postgresql://");
  if (isPostgres) {
    const pg = await import("pg");
    const { Pool } = pg.default || pg;
    const pool = new Pool({ connectionString: url });
    return {
      engine: "PostgreSQL",
      hostLabel: redactDatabaseUrl(url),
      query: async (sql, params = []) => {
        const r = await pool.query(sql, params);
        return { rows: r.rows };
      },
      close: async () => { try { await pool.end(); } catch {} },
    };
  }
  // sqlite
  let filePath = url;
  if (url.startsWith("file:")) {
    filePath = url.replace(/^file:/, "").split("?")[0];
    if (!path.isAbsolute(filePath)) filePath = path.resolve(REPO, filePath);
  } else if (!path.isAbsolute(filePath)) {
    filePath = path.resolve(REPO, filePath);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(filePath);
  return {
    engine: "SQLite",
    hostLabel: `sqlite:${path.relative(REPO, filePath) || filePath}`,
    query: async (sql, params = []) => {
      const sqliteSql = sql.replace(/\$\d+/g, "?");
      const stmt = db.prepare(sqliteSql);
      const rows = params.length ? stmt.all(...params) : stmt.all();
      return { rows };
    },
    close: async () => { try { db.close(); } catch {} },
  };
}

async function getCount(backend, sql, params = []) {
  const r = await backend.query(sql, params);
  if (!r.rows.length) return 0;
  const v = r.rows[0].n ?? r.rows[0].count ?? r.rows[0].N ?? Object.values(r.rows[0])[0];
  return Number(v) || 0;
}
async function getIds(backend, sql, params = []) {
  try {
    const r = await backend.query(sql, params);
    return r.rows.map((row) => row.id ?? row.ID ?? Object.values(row)[0]).filter((v) => v != null).map(String);
  } catch {
    return [];
  }
}
async function checkLedgerSchema(backend) {
  const missingFields = [];
  const missingIndexes = [];
  let hasFields = true;
  let hasIdx = true;
  try {
    if (backend.engine === "PostgreSQL") {
      const cols = await backend.query(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Payment'`);
      const names = new Set(cols.rows.map((r) => r.name));
      for (const f of EXPECTED_FIELDS) if (!names.has(f)) { missingFields.push(f); hasFields = false; }
      const idx = await backend.query(`SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Payment'`);
      const idxNames = new Set(idx.rows.map((r) => r.name));
      for (const i of EXPECTED_INDEXES) if (!idxNames.has(i)) { missingIndexes.push(i); hasIdx = false; }
    } else {
      const cols = await backend.query(`SELECT name FROM pragma_table_info('Payment')`);
      const names = new Set(cols.rows.map((r) => r.name));
      for (const f of EXPECTED_FIELDS) if (!names.has(f)) { missingFields.push(f); hasFields = false; }
      const idx = await backend.query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='Payment'`);
      const idxNames = new Set(idx.rows.map((r) => r.name));
      for (const i of EXPECTED_INDEXES) if (!idxNames.has(i)) { missingIndexes.push(i); hasIdx = false; }
    }
  } catch (e) {
    return { hasFields: false, missingFields: EXPECTED_FIELDS.slice(), hasIdx: false, missingIndexes: EXPECTED_INDEXES.slice(), error: String(e?.message || e) };
  }
  return { hasFields, missingFields, hasIdx, missingIndexes };
}

export async function runInventory(opts = {}) {
  const nowIso = opts.nowIso || new Date().toISOString();
  const backend = opts.backend || await createBackend(opts.target, opts.pgliteDir);
  const engine = backend.engine;
  const hostLabel = backend.hostLabel || redactDatabaseUrl(opts.target || process.env.DATABASE_URL || "");
  // helper for now-param queries
  const withNow = (sql) => sql.includes("$1") ? [nowIso] : [];
  const counts = {};
  const anomalies = {};
  let schema = { hasFields: true, missingFields: [], hasIdx: true, missingIndexes: [] };

  // counts
  counts.studentsTotal = await getCount(backend, Q.studentTotal);
  counts.studentsWithGroup = await getCount(backend, Q.studentWithGroup);
  counts.studentsWithoutGroup = await getCount(backend, Q.studentWithoutGroup);
  counts.studentsWithSubscription = await getCount(backend, Q.studentWithSub);
  counts.studentsWithoutSubscription = await getCount(backend, Q.studentWithoutSub);
  counts.subPending = await getCount(backend, Q.subPending);
  counts.subActive = await getCount(backend, Q.subActive);
  counts.subExpired = await getCount(backend, Q.subExpired);
  counts.subCancelled = await getCount(backend, Q.subCancelled);
  counts.subActiveExpired = await getCount(backend, Q.subActiveExpired, withNow(Q.subActiveExpired));
  counts.subActiveFuture = await getCount(backend, Q.subActiveFuture, withNow(Q.subActiveFuture));
  counts.subActiveNoGroup = await getCount(backend, Q.subActiveNoGroup, []);
  // subPlanBad needs now? no
  counts.subPlanMissingOrInactive = await getCount(backend, Q.subPlanBad);
  counts.payPending = await getCount(backend, Q.payPending);
  counts.payApproved = await getCount(backend, Q.payApproved);
  counts.payRejected = await getCount(backend, Q.payRejected);
  counts.payExpired = await getCount(backend, Q.payExpired);
  counts.payLegacy = await getCount(backend, Q.payLegacy);
  counts.payPendingNoSub = await getCount(backend, Q.payPendingNoSub);
  counts.payPendingNoGroup = await getCount(backend, Q.payPendingNoGroup);
  counts.payPendingNoPlan = await getCount(backend, Q.payPendingNoPlan);
  counts.payApprovedNoReviewer = await getCount(backend, Q.payApprovedNoReviewer);
  counts.payApprovedNoSub = await getCount(backend, Q.payApprovedNoSub);
  counts.payRejectedNoReason = await getCount(backend, Q.payRejectedNoReason);
  counts.payDupRefGroups = await getCount(backend, Q.payDupRefGroups);
  counts.stalePending = await getCount(backend, Q.stalePending);
  counts.groupActive = await getCount(backend, Q.groupActive);
  counts.groupInactive = await getCount(backend, Q.groupInactive);
  counts.studentsInInactiveGroup = await getCount(backend, Q.studentsInInactive);
  counts.couponPendingRedemptions = await getCount(backend, Q.couponPendingRedemptions);
  counts.couponRejectedRedemptions = await getCount(backend, Q.couponRejectedRedemptions);
  counts.couponOrphan = await getCount(backend, Q.couponOrphan);
  counts.grandfathered = await getCount(backend, Q.grandfathered);
  counts.grandfatheredWithPending = await getCount(backend, Q.grandfatheredWithPending);
  counts.grandfatheredNoPending = Math.max(0, counts.grandfathered - counts.grandfatheredWithPending);
  counts.newPendingNoGroup = await getCount(backend, Q.newPendingNoGroup);
  counts.activeRenewalPending = await getCount(backend, Q.activeRenewalPending, withNow(Q.activeRenewalPending));
  counts.planActive = await getCount(backend, Q.planActive);
  counts.planInactive = await getCount(backend, Q.planInactive);

  // anomalies with ids
  const ana = {};
  async function collect(key, countSql, idsSql, severity) {
    const c = await getCount(backend, countSql, withNow(countSql));
    const ids = c > 0 ? await getIds(backend, idsSql, withNow(idsSql)) : [];
    ana[key] = { severity, count: c, ids };
  }
  await collect("APPROVED_PAYMENT_NO_ENTITLEMENT", Q.A_ids.replace("LIMIT 20",""), Q.A_ids, "BLOCKER");
  // need count separately: use same A_ids but without limit for count - we already have count via Q.A_ids wrapper count query
  // Instead compute counts directly via count queries for each anomaly; we have counts above for some but not all.
  // For A, build count sql
  const countA = `SELECT COUNT(*) AS n FROM "Payment" p LEFT JOIN "Subscription" s ON s."id" = p."subscriptionId" WHERE p."status" = 'APPROVED' AND (s."id" IS NULL OR s."status" <> 'ACTIVE' OR (s."endDate" IS NOT NULL AND s."endDate" < $1))`;
  const countB = `SELECT COUNT(*) AS n FROM "Subscription" sub JOIN "Student" s ON s."id" = sub."studentId" WHERE sub."status" = 'ACTIVE' AND (sub."endDate" IS NULL OR sub."endDate" > $1) AND s."groupId" IS NULL`;
  const countC = `SELECT COUNT(*) AS n FROM "Subscription" WHERE "status" = 'ACTIVE' AND "endDate" IS NOT NULL AND "endDate" < $1`;
  const countE = `SELECT COUNT(*) AS n FROM "Student" s JOIN "Group" g ON g."id" = s."groupId" WHERE NOT g."isActive"`;
  const countF = `SELECT COUNT(*) AS n FROM "Payment" WHERE "status" = 'APPROVED' AND ("reviewedAt" IS NULL OR "reviewedByUserId" IS NULL)`;
  const countG = `SELECT COUNT(*) AS n FROM "Payment" WHERE "status" = 'REJECTED' AND ("rejectionReason" IS NULL OR TRIM("rejectionReason") = '')`;
  const countH = `SELECT COUNT(*) AS n FROM "Payment" p WHERE p."status" = 'PENDING' AND EXISTS (SELECT 1 FROM "Payment" newer WHERE newer."userId" = p."userId" AND newer."status" = 'PENDING' AND newer."id" <> p."id" AND (newer."createdAt" > p."createdAt" OR (newer."createdAt" = p."createdAt" AND newer."id" > p."id")))`;
  const countI = `SELECT COUNT(*) AS n FROM "Payment" p JOIN "User" u ON u."id" = p."userId" JOIN "Student" s ON s."userId" = u."id" WHERE p."status" = 'PENDING' AND p."requestedGroupId" IS NULL AND s."groupId" IS NULL`;
  const countJ = `SELECT COUNT(*) AS n FROM "Payment" p JOIN "User" u ON u."id" = p."userId" LEFT JOIN "Student" s ON s."userId" = u."id" LEFT JOIN "Subscription" sub ON sub."studentId" = s."id" LEFT JOIN "SubscriptionPlan" pl ON pl."id" = sub."planId" WHERE p."status" = 'PENDING' AND p."requestedPlanId" IS NULL AND (sub."id" IS NULL OR sub."status" <> 'ACTIVE' OR (sub."endDate" IS NOT NULL AND sub."endDate" < $1) OR pl."id" IS NULL OR NOT pl."isActive")`;
  const countK = `SELECT COUNT(*) AS n FROM "Payment" p JOIN "Subscription" sub ON sub."id" = p."subscriptionId" JOIN "Student" st ON st."id" = sub."studentId" WHERE st."userId" <> p."userId"`;
  const countL = `SELECT COUNT(*) AS n FROM (SELECT "studentId" FROM "Subscription" GROUP BY "studentId" HAVING COUNT(*) > 1) d`;
  const countM = `SELECT COUNT(*) AS n FROM "Payment" p JOIN "Group" req ON req."id" = p."requestedGroupId" JOIN "User" u ON u."id" = p."userId" JOIN "Student" s ON s."userId" = u."id" JOIN "Group" cur ON cur."id" = s."groupId" WHERE p."status" = 'PENDING' AND p."requestedGroupId" IS NOT NULL AND s."groupId" IS NOT NULL AND req."courseId" <> cur."courseId"`;
  const countN = `SELECT COUNT(*) AS n FROM "Payment" p LEFT JOIN "Student" s ON s."userId" = p."userId" WHERE s."id" IS NULL`;
  const countD = `SELECT COUNT(*) AS n FROM (SELECT g."id" FROM "Group" g LEFT JOIN "Student" s ON s."groupId" = g."id" GROUP BY g."id", g."capacity" HAVING COUNT(s."id") > g."capacity") d`;

  const anomaliesDetailed = {};
  const defs = [
    ["APPROVED_PAYMENT_NO_ENTITLEMENT", countA, Q.A_ids, "BLOCKER"],
    ["ACTIVE_SUBSCRIPTION_NO_GROUP", countB, Q.B_ids, "BLOCKER"],
    ["ACTIVE_SUBSCRIPTION_EXPIRED", countC, Q.C_ids, "REVIEW"],
    ["GROUP_OVER_CAPACITY", countD, `SELECT g."id" AS id FROM "Group" g LEFT JOIN "Student" s ON s."groupId" = g."id" GROUP BY g."id", g."capacity" HAVING COUNT(s."id") > g."capacity" ORDER BY g."id" LIMIT 20`, "BLOCKER"],
    ["STUDENT_IN_INACTIVE_GROUP", countE, Q.E_ids, "REVIEW"],
    ["PAYMENT_APPROVED_NO_REVIEWER", countF, Q.F_ids, "REVIEW"],
    ["PAYMENT_REJECTED_NO_REASON", countG, Q.G_ids, "REVIEW"],
    ["STALE_PENDING_PAYMENT", countH, Q.H_ids, "REVIEW"],
    ["UNRESOLVABLE_PENDING_GROUP", countI, Q.I_ids, "REVIEW"],
    ["UNRESOLVABLE_PENDING_PLAN", countJ, Q.J_ids, "REVIEW"],
    ["PAYMENT_SUBSCRIPTION_OWNERSHIP_MISMATCH", countK, Q.K_ids, "BLOCKER"],
    ["DUPLICATE_ACTIVE_SUBSCRIPTION", countL, Q.L_dups, "BLOCKER"],
    ["INVALID_REQUESTED_GROUP_CONTEXT", countM, Q.M_ids, "REVIEW"],
    ["ORPHAN_PAYMENT_USER", countN, Q.N_ids, "BLOCKER"],
  ];
  for (const [key, cSql, iSql, sev] of defs) {
    const cnt = await getCount(backend, cSql, withNow(cSql));
    const ids = cnt > 0 ? await getIds(backend, iSql, withNow(iSql)) : [];
    anomaliesDetailed[key] = { severity: sev, count: cnt, ids };
  }

  // group capacity details
  let groupCapacity = [];
  try {
    const groups = (await backend.query(Q.groupCapacity)).rows;
    const membersMap = new Map();
    const membRows = (await backend.query(Q.groupMembers)).rows;
    for (const r of membRows) membersMap.set(String(r.gid), Number(r.n));
    const pendMap = new Map();
    const pendRows = (await backend.query(Q.pendingByGroup)).rows;
    for (const r of pendRows) pendMap.set(String(r.gid), Number(r.n));
    for (const g of groups) {
      const members = membersMap.get(String(g.id)) || 0;
      const capacity = Number(g.capacity) || 0;
      const pending = pendMap.get(String(g.id)) || 0;
      const free = Math.max(0, capacity - members);
      const over = members > capacity;
      const nearFull = !over && free <= 2;
      groupCapacity.push({ id: String(g.id), name: String(g.name || ""), courseId: String(g.courseId || ""), capacity, members, free, pendingRequests: pending, overCapacity: over, nearFull, isActive: !!g.isActive });
    }
  } catch {}

  // plan readiness: pending requests targeting inactive/missing plans
  let planBadIds = [];
  try { planBadIds = await getIds(backend, Q.planPendingBad); } catch {}
  const planPendingBadCount = planBadIds.length ? await getCount(backend, `SELECT COUNT(*) AS n FROM "Payment" p LEFT JOIN "SubscriptionPlan" pl ON pl."id" = p."requestedPlanId" WHERE p."status" = 'PENDING' AND p."requestedPlanId" IS NOT NULL AND (pl."id" IS NULL OR NOT pl."isActive")`) : 0;

  // schema
  schema = await checkLedgerSchema(backend);

  // severity totals
  const blockers = Object.entries(anomaliesDetailed).filter(([, v]) => v.severity === "BLOCKER" && v.count > 0);
  const reviews = Object.entries(anomaliesDetailed).filter(([, v]) => v.severity === "REVIEW" && v.count > 0);
  // also schema blocker
  const schemaBlocker = (!schema.hasFields || !schema.hasIdx);
  const totalBlockers = blockers.length + (schemaBlocker ? 1 : 0);
  const totalReviews = reviews.length;

  let verdict = "GO";
  if (totalBlockers > 0) verdict = "NO-GO";
  else if (totalReviews > 0 || counts.stalePending > 0 || anomaliesDetailed["UNRESOLVABLE_PENDING_GROUP"].count > 0 || anomaliesDetailed["UNRESOLVABLE_PENDING_PLAN"].count > 0) verdict = "GO WITH REVIEW";
  else verdict = "GO";
  // edge: pending no reviewer but legacy may be expected? Still REVIEW leads to GO WITH REVIEW, not NO-GO.

  const report = {
    meta: { generatedAt: new Date().toISOString(), now: nowIso, engine, host: hostLabel },
    counts,
    expectedLegacy: {
      grandfathered: counts.grandfathered,
      grandfatheredWithPending: counts.grandfatheredWithPending,
      grandfatheredNoPending: counts.grandfatheredNoPending,
      newPendingNoGroup: counts.newPendingNoGroup,
      activeRenewalPending: counts.activeRenewalPending,
    },
    anomalies: anomaliesDetailed,
    groupCapacity,
    planReadiness: {
      activePlans: counts.planActive,
      inactivePlans: counts.planInactive,
      pendingRequestsTargetingBadPlan: planPendingBadCount,
      pendingBadPlanIds: planBadIds,
    },
    groupRequired: anomaliesDetailed["UNRESOLVABLE_PENDING_GROUP"],
    planRequired: anomaliesDetailed["UNRESOLVABLE_PENDING_PLAN"],
    stalePending: { count: counts.stalePending, ids: anomaliesDetailed["STALE_PENDING_PAYMENT"].ids },
    blockers: { count: totalBlockers, details: blockers.map(([k, v]) => ({ key: k, ...v })), schemaBlocker: schemaBlocker ? { missingFields: schema.missingFields, missingIndexes: schema.missingIndexes } : null },
    review: { count: totalReviews, details: reviews.map(([k, v]) => ({ key: k, ...v })) },
    schema,
    verdict,
  };
  return { backend, report };
}

function renderHuman(report) {
  const c = report.counts;
  const e = report.expectedLegacy;
  const a = report.anomalies;
  const lines = [];
  lines.push("PHASE 25 PRODUCTION READINESS");
  lines.push("");
  lines.push(`Database:`);
  lines.push(`  engine: ${report.meta.engine}`);
  lines.push(`  host: ${report.meta.host}`);
  lines.push(`  generatedAt: ${report.meta.generatedAt}`);
  lines.push(`  now: ${report.meta.now}`);
  lines.push("");
  lines.push(`Counts:`);
  lines.push(`  students: ${c.studentsTotal} (withGroup=${c.studentsWithGroup} withoutGroup=${c.studentsWithoutGroup} withSubscription=${c.studentsWithSubscription} withoutSubscription=${c.studentsWithoutSubscription})`);
  lines.push(`  payments: pending=${c.payPending} approved=${c.payApproved} rejected=${c.payRejected} expired=${c.payExpired} legacy=${c.payLegacy}`);
  lines.push(`    pendingNoSub=${c.payPendingNoSub} pendingNoGroup=${c.payPendingNoGroup} pendingNoPlan=${c.payPendingNoPlan} approvedNoReviewer=${c.payApprovedNoReviewer} approvedNoSub=${c.payApprovedNoSub} rejectedNoReason=${c.payRejectedNoReason} dupRefGroups=${c.payDupRefGroups} stalePending=${c.stalePending}`);
  lines.push(`  subscriptions: pending=${c.subPending} active=${c.subActive} expired=${c.subExpired} cancelled=${c.subCancelled} activeExpired=${c.subActiveExpired} activeFuture=${c.subActiveFuture} activeNoGroup=${c.subActiveNoGroup} planBad=${c.subPlanMissingOrInactive}`);
  lines.push(`  groups: active=${c.groupActive} inactive=${c.groupInactive} studentsInInactive=${c.studentsInInactiveGroup}`);
  lines.push(`  plans: active=${c.planActive} inactive=${c.planInactive}`);
  lines.push(`  coupons: pendingRedemptions=${c.couponPendingRedemptions} rejectedRedemptions=${c.couponRejectedRedemptions} orphan=${c.couponOrphan}`);
  lines.push("");
  lines.push(`Expected legacy states:`);
  lines.push(`  grandfathered: ${e.grandfathered} (noPending=${e.grandfatheredNoPending} withPending=${e.grandfatheredWithPending})`);
  lines.push(`  new-pending-no-group: ${e.newPendingNoGroup}`);
  lines.push(`  active-renewal-pending: ${e.activeRenewalPending}`);
  lines.push("");
  const blockerKeys = Object.entries(a).filter(([, v]) => v.severity === "BLOCKER" && v.count > 0);
  const reviewKeys = Object.entries(a).filter(([, v]) => v.severity === "REVIEW" && v.count > 0);
  lines.push(`Blockers (${blockerKeys.length}):`);
  if (!blockerKeys.length && !report.blockers.schemaBlocker) lines.push(`  (none)`);
  for (const [k, v] of blockerKeys) lines.push(`  ${k}: ${v.count} ${v.ids.length ? `e.g. ${v.ids.slice(0,5).join(",")}` : ""}`);
  if (report.blockers.schemaBlocker) lines.push(`  SCHEMA_MISMATCH: missingFields=[${report.schema.missingFields.join(",")}] missingIndexes=[${report.schema.missingIndexes.join(",")}]`);
  lines.push("");
  lines.push(`Review (${reviewKeys.length}):`);
  if (!reviewKeys.length) lines.push(`  (none)`);
  for (const [k, v] of reviewKeys) lines.push(`  ${k}: ${v.count} ${v.ids.length ? `e.g. ${v.ids.slice(0,5).join(",")}` : ""}`);
  if (c.payDupRefGroups) lines.push(`  DUPLICATE_REFERENCE_GROUPS: ${c.payDupRefGroups}`);
  if (c.couponRejectedRedemptions) lines.push(`  couponRejectedStillHeld: ${c.couponRejectedRedemptions} (review coupon release)`);
  lines.push("");
  lines.push(`Group capacity:`);
  if (!report.groupCapacity.length) lines.push(`  (no groups)`);
  else {
    for (const g of report.groupCapacity) {
      const flag = g.overCapacity ? "OVER" : g.nearFull ? "NEAR_FULL" : g.free <= 0 ? "FULL" : "OK";
      lines.push(`  ${g.id} ${g.name} cap=${g.capacity} members=${g.members} free=${g.free} pending=${g.pendingRequests} ${flag} ${g.isActive ? "" : "(inactive)"}`);
    }
  }
  lines.push("");
  lines.push(`Plan readiness:`);
  lines.push(`  pendingRequestsTargetingBadPlan: ${report.planReadiness.pendingRequestsTargetingBadPlan} ${report.planReadiness.pendingBadPlanIds.length ? `e.g. ${report.planReadiness.pendingBadPlanIds.slice(0,5).join(",")}` : ""}`);
  lines.push("");
  lines.push(`Schema: fields=${report.schema.hasFields ? "OK" : "MISSING ["+report.schema.missingFields.join(",")+"]"} indexes=${report.schema.hasIdx ? "OK" : "MISSING ["+report.schema.missingIndexes.join(",")+"]"}`);
  lines.push("");
  lines.push(`Verdict: ${report.verdict}`);
  lines.push("");
  if (report.verdict === "NO-GO") lines.push("ACTION: STOP — resolve blockers before release. Do not deploy.");
  else if (report.verdict === "GO WITH REVIEW") lines.push("ACTION: Review required items, resolve or accept, then re-run inventory. Deploy only after GO or accepted review.");
  else lines.push("ACTION: GO — safe to proceed to cutover steps 6-12.");
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    console.log(`Usage: node scripts/phase25-pr4-inventory.mjs [--target <DATABASE_URL>] [--pglite <dir>] [--now <iso>] [--json] [--json-out <path>]`);
    console.log(`  --target   PostgreSQL URL or SQLite file: URL (default: DATABASE_URL env)`);
    console.log(`  --pglite   PGlite directory for offline PG verification`);
    console.log(`  --now      ISO cutoff for time checks (default: now)`);
    console.log(`  --json     emit JSON to stdout after human summary`);
    console.log(`  --json-out <path>  write JSON report to file`);
    console.log(`Read-only: all queries are SELECT. No write operation is performed.`);
    process.exit(0);
  }
  const target = argOf(argv, "--target");
  const pgliteDir = argOf(argv, "--pglite");
  const nowIso = argOf(argv, "--now") || new Date().toISOString();
  const wantJson = hasFlag(argv, "--json");
  const jsonOut = argOf(argv, "--json-out");
  let backend;
  try {
    const created = await createBackend(target, pgliteDir);
    backend = created;
  } catch (e) {
    console.error(`Failed to open database: ${e?.message || e}`);
    process.exit(1);
  }
  try {
    const { report } = await runInventory({ backend, nowIso });
    const human = renderHuman(report);
    console.log(human);
    // JSON handling
    const json = JSON.stringify(report, null, 2);
    if (wantJson) {
      console.log("\n---JSON---");
      console.log(json);
    }
    if (jsonOut) {
      fs.writeFileSync(jsonOut, json, "utf8");
      console.log(`\nJSON written to ${jsonOut}`);
    }
    // exit code reflects verdict
    if (report.verdict === "NO-GO") process.exitCode = 2;
    else if (report.verdict === "GO WITH REVIEW") process.exitCode = 0;
    else process.exitCode = 0;
  } catch (e) {
    console.error(`Inventory failed: ${e?.message || e}`);
    console.error(e?.stack || "");
    process.exit(1);
  } finally {
    try { await backend.close(); } catch {}
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) main();
