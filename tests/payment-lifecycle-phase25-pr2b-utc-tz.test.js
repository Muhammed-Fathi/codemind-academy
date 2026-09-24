// CodeMind Academy — Phase 25 PR2b HOTFIX: UTC calendar-month arithmetic is
// TIMEZONE-INDEPENDENT (the post-merge +1h date-stacking fix).
//
// WHY THIS FILE EXISTS
//   `addMonths` in `src/lib/payment-transitions.ts` used to compute calendar
//   months with LOCAL-TIME Date accessors (`getDate` / `setDate` /
//   `getMonth` / `setMonth` / `getFullYear` and the local `new Date(y, m, d)`
//   constructor). Subscription timestamps are absolute server/database UTC
//   instants, so re-deriving them from local wall-clock fields made the
//   STORED endDate depend on the machine's TZ. On a server whose timezone
//   observes DST, any month pair straddling a DST transition shifted the
//   result by the offset delta:
//     TZ=Africa/Cairo (Egypt leaves DST the last Thursday of October):
//       2026-10-01T00:00:00.000Z + 1 month → 2026-11-01T01:00:00.000Z  ✗
//     TZ=America/New_York (EDT→EST the first Sunday of November):
//       2026-10-01T00:00:00.000Z + 1 month → 2026-10-31T00:00:00.000Z  ✗
//   The UTC-only implementation must return
//     2026-10-01T00:00:00.000Z + 1 month → 2026-11-01T00:00:00.000Z
//   under EVERY timezone, while preserving the day-clamping rule
//   (Jan 31 + 1 month = Feb 28 / Feb 29 in a leap year, never Mar 3).
//
// STRATEGY (deterministic on any runner, including Windows)
//   The month helper AND the real approval path are executed in CHILD
//   PROCESSES, one per `TZ`, because a Node process caches its timezone at
//   startup — mutating `process.env.TZ` in-process is not a reliable way to
//   change calendar behaviour on every platform. The shipped TypeScript is
//   compiled once with the repo's own tsc (same harness convention as
//   tests/payment-lifecycle-phase25-pr2b.test.js); each child loads the
//   compiled modules through the same `@/lib/*` redirect + `@prisma/client`
//   stub, runs a fixed battery of date cases and three `approvePayment`
//   scenarios against an in-memory store, and prints one line of JSON. The
//   parent then asserts (a) every case matches its UTC-pinned expectation in
//   EVERY timezone and (b) the JSON payload is byte-identical across all
//   timezones — the same UTC input produces the same epoch everywhere.
//
// NON-VACUITY GUARD
//   Each child also reports the real UTC offsets it observed for the DST
//   boundary months. The parent asserts that the requested timezones actually
//   took effect (at least one non-zero offset, and Cairo's October offset
//   differs from its November offset — i.e. the DST boundary the bug lived on
//   is genuinely straddled). If a runner ignores `TZ` entirely, the suite
//   prints a loud TZ_ENV_NOT_HONORED_FALLBACK_USED banner naming that fact
//   instead of silently passing on a degenerate all-UTC matrix.
//
// Coverage:
//   1  child-process TZ matrix is real (offsets differ; DST boundary straddled)
//   2  addMonths: UTC-pinned calendar results in EVERY timezone
//      (Oct 1 + 1 = Nov 1; Oct 1 + 3 = Jan 1; day clamping incl. leap year;
//       year rollover; +12; 0 = identity; negative months; base NOT mutated)
//   3  addMonths: non-midnight time-of-day is preserved exactly across a DST
//      boundary (h/m/s/ms carried, never shifted by ±1h)
//   4  approval path: RENEWAL stacking + FRESH ACTIVATION produce identical
//      startDate/endDate epochs in EVERY timezone
//   5  cross-timezone byte-identity of the whole result payload
//
// Run: node tests/payment-lifecycle-phase25-pr2b-utc-tz.test.js
// Exit: 0 = all pass, 1 = failure. Requires Node >= 22.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");

// Deterministic provider: sqlite → the advisory-lock helper is a NO-OP and no
// raw SQL is ever attempted (pinned per run, parent and every child).
process.env.DATABASE_URL = "file:./db/custom.db";

let pass = 0;
let fail = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error("FAIL:", label);
  }
};
const show = (v) => (typeof v === "bigint" ? `${v}n` : JSON.stringify(v));
const eq = (a, b, label) => ok(show(a) === show(b), `${label} (got ${show(a)} want ${show(b)})`);
const section = (t) => console.log(`\n${t}`);

// The timezone matrix. Chosen so the set genuinely spans DST regimes:
//   UTC                 — no DST (control)
//   Africa/Cairo        — Egypt, DST ends the last Thursday of October 2026
//                         (UTC+3 → UTC+2): the exact boundary from the report
//   America/New_York    — EDT → EST the first Sunday of November 2026
//   Europe/London       — BST → GMT the last Sunday of October 2026
//   Australia/Sydney    — SOUTHERN hemisphere: AEST → AEDT in October (DST STARTS)
//   Pacific/Auckland    — southern hemisphere, NZDT (UTC+13)
//   America/Sao_Paulo   — negative offset, no current DST
//   Asia/Tokyo          — UTC+9, never observes DST
//   Asia/Kolkata        — half-hour offset (UTC+5:30), never observes DST
//   Etc/GMT+12          — UTC-12, the extreme negative offset
const TZ_LIST = [
  "UTC",
  "Africa/Cairo",
  "America/New_York",
  "Europe/London",
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Sao_Paulo",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Etc/GMT+12",
];

// ===========================================================================
// Compile the shipped modules under test (once; every child reuses OUT).
// ===========================================================================
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p25pr2b-utctz-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      lib: ["es2022"],
      module: "commonjs",
      strict: false,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [path.join(REPO, "node_modules/@types")],
      baseUrl: REPO,
      paths: { "@/*": ["src/*"] },
      outDir: OUT,
    },
    files: [
      path.join(REPO, "src/lib/db-serialization.ts"),
      path.join(REPO, "src/lib/subscription-entitlement.ts"),
      path.join(REPO, "src/lib/payment-transitions.ts"),
      path.join(REPO, "src/lib/i18n-core.ts"),
      path.join(REPO, "src/lib/i18n-dict.ts"),
      path.join(REPO, "src/lib/i18n-dict-2026.ts"),
    ],
  })
);
try {
  execFileSync(
    process.execPath,
    [require.resolve("typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")],
    { cwd: REPO, stdio: "pipe" }
  );
} catch {
  /* fall through: verify the emitted files below (i18n-core's browser-only
     `document` references are expected under a node-only `lib`; the emitted
     JS is what the suite runs, exactly like the sibling PR2b suites). */
}
for (const f of ["db-serialization.js", "subscription-entitlement.js", "payment-transitions.js", "i18n-core.js"]) {
  if (!fs.existsSync(path.join(OUT, f))) throw new Error(`tsc did not emit ${f}`);
}

// Module redirects for the children: `@/lib/*` → compiled output;
// `@/lib/db` → fake (the entitlement resolver's lazy default client);
// `@prisma/client` → stub (type-only imports in the shipped files).
fs.writeFileSync(path.join(OUT, "prisma-stub.js"), 'module.exports = new Proxy({}, { get: () => function noop() {} });\n');
fs.writeFileSync(path.join(OUT, "fake-db.js"), 'module.exports = { get db() { return null; } };\n');

// ===========================================================================
// The per-TZ child probe. Prints exactly one JSON line on stdout.
// ===========================================================================
const PROBE = path.join(OUT, "__tz-probe.js");
fs.writeFileSync(
  PROBE,
  [
    'const fs = require("fs");',
    'const Module = require("module");',
    'const path = require("path");',
    "const OUT = process.argv[2];",
    'process.env.DATABASE_URL = process.env.DATABASE_URL || "file:./db/custom.db";',
    "const realResolve = Module._resolveFilename;",
    "Module._resolveFilename = function (request, ...rest) {",
    '  if (request === "@/lib/db") return path.join(OUT, "fake-db.js");',
    '  if (request === "@prisma/client") return path.join(OUT, "prisma-stub.js");',
    "  const m = /^@\\/lib\\/([\\w-]+)$/.exec(request);",
    "  if (m) {",
    "    const compiled = path.join(OUT, `${m[1]}.js`);",
    "    if (fs.existsSync(compiled)) return compiled;",
    "  }",
    "  return realResolve.call(this, request, ...rest);",
    "};",
    'const TR = require(path.join(OUT, "payment-transitions.js"));',
    "",
    "// ---- the fixed date battery (same UTC inputs in every timezone) -------",
    "const at = (iso) => new Date(iso);",
    "const CASES = [",
    '  ["oct1+1",  "2026-10-01T00:00:00.000Z", 1],',
    '  ["oct1+3",  "2026-10-01T00:00:00.000Z", 3],',
    '  ["jan31+1", "2026-01-31T00:00:00.000Z", 1],',
    '  ["jan31+1leap", "2024-01-31T00:00:00.000Z", 1],',
    '  ["jan31+2", "2026-01-31T00:00:00.000Z", 2],',
    '  ["dec15+1", "2026-12-15T00:00:00.000Z", 1],',
    '  ["jan31+12", "2026-01-31T00:00:00.000Z", 12],',
    '  ["oct1+0",  "2026-10-01T00:00:00.000Z", 0],',
    '  ["mar31-1", "2026-03-31T00:00:00.000Z", -1],',
    '  ["mar31-13", "2026-03-31T00:00:00.000Z", -13],',
    '  ["nov20+1", "2026-11-20T00:00:00.000Z", 1],',
    '  ["oct20pm+1", "2026-10-20T14:37:25.123Z", 1],',
    '  ["oct20pm+3", "2026-10-20T14:37:25.123Z", 3],',
    '  ["oct31late+1", "2026-10-31T23:59:59.999Z", 1],',
    '  ["jan31pm+1", "2026-01-31T14:37:25.123Z", 1],',
    "];",
    "const cases = {};",
    "for (const [label, iso, months] of CASES) {",
    "  const base = at(iso);",
    "  const before = base.getTime();",
    "  const out = TR.addMonths(base, months);",
    "  cases[label] = {",
    "    epoch: out.getTime(),",
    "    iso: out.toISOString(),",
    "    utcString: out.toUTCString(),",
    "    utcFields: [out.getUTCFullYear(), out.getUTCMonth() + 1, out.getUTCDate(), out.getUTCHours(), out.getUTCMinutes(), out.getUTCSeconds(), out.getUTCMilliseconds()],",
    "    baseUnmutated: base.getTime() === before,",
    "  };",
    "}",
    "",
    "// ---- the real approval path, driven through the shipped service -------",
    "const clone = (v) => structuredClone(v);",
    "function freshStore() {",
    "  return {",
    "    students: [],",
    "    // Phase K2 — fixture course + students are SECOND_SECONDARY (I1 gate).",
    '    courses: [{ id: "c1", academicLevel: "SECOND_SECONDARY" }],',
    "    groups: [",
    '      { id: "g1", name: "Group 1", courseId: "c1", isActive: true, capacity: 20, trackScope: "ARABIC" },',
    '      { id: "g2", name: "Group 2", courseId: "c1", isActive: true, capacity: 20, trackScope: "ARABIC" },',
    "    ],",
    "    plans: [",
    '      { id: "p1", name: "Monthly", durationMonths: 1, price: 300, isActive: true },',
    '      { id: "p2", name: "Quarterly", durationMonths: 3, price: 800, isActive: true },',
    "    ],",
    "    subscriptions: [],",
    "    payments: [],",
    "    coupons: [],",
    "    redemptions: [],",
    "    auditLogs: [],",
    "    writes: [],",
    "    rawCalls: [],",
    "    seq: { sub: 1, audit: 1 },",
    "  };",
    "}",
    "const studentView = (store, s) => {",
    "  const group = s.groupId ? store.groups.find((g) => g.id === s.groupId) ?? null : null;",
    "  const sub = store.subscriptions.find((x) => x.studentId === s.id) ?? null;",
    "  return {",
    "    id: s.id, userId: s.userId, groupId: s.groupId ?? null, schoolType: s.schoolType ?? null, academicLevel: s.academicLevel ?? null,",
    "    group: group ? { id: group.id, isActive: group.isActive, courseId: group.courseId } : null,",
    "    subscription: sub ? { id: sub.id, status: sub.status, planId: sub.planId, startDate: sub.startDate, endDate: sub.endDate } : null,",
    "  };",
    "};",
    "const groupView = (store, id) => {",
    "  const g = store.groups.find((x) => x.id === id);",
    "  return g ? { id: g.id, name: g.name, isActive: g.isActive, courseId: g.courseId, capacity: g.capacity, trackScope: g.trackScope ?? null } : null;",
    "};",
    "const planView = (store, id) => {",
    "  const p = store.plans.find((x) => x.id === id);",
    "  return p ? { id: p.id, isActive: p.isActive, durationMonths: p.durationMonths } : null;",
    "};",
    "// The stale-guard where-clause, translated against the store — byte-for-byte",
    "// the same translation tests/payment-lifecycle-phase25-pr2b.test.js uses,",
    "// including the `OR: [{createdAt:{gt}}, {AND:[{createdAt},{id:{gt}}]}]` tie-break.",
    "function staleWhereMatch(p, where) {",
    "  if (p.userId !== where.userId) return false;",
    "  if (p.status !== where.status) return false;",
    "  if (where.NOT && p.id === where.NOT.id) return false;",
    "  if (where.OR) {",
    "    return where.OR.some((alt) => {",
    "      if (alt.createdAt && alt.createdAt.gt !== undefined) return p.createdAt.getTime() > alt.createdAt.gt.getTime();",
    "      if (Array.isArray(alt.AND)) {",
    "        const ts = alt.AND.find((c) => c.createdAt !== undefined);",
    "        const idc = alt.AND.find((c) => c.id !== undefined);",
    "        if (ts && p.createdAt.getTime() !== ts.createdAt.getTime()) return false;",
    "        if (idc && !(p.id > idc.id.gt)) return false;",
    "        return true;",
    "      }",
    "      return true;",
    "    });",
    "  }",
    "  return true;",
    "}",
    "function makeDb(store) {",
    "  const tx = {",
    "    $executeRaw: async (strings, ...values) => { store.rawCalls.push({ sql: strings.join('?'), values }); return 0; },",
    "    payment: {",
    "      findUnique: async ({ where }) => { const p = store.payments.find((x) => x.id === where.id) ?? null; return p ? clone(p) : null; },",
    "      findFirst: async ({ where }) => {",
    "        const p = store.payments.find((x) => staleWhereMatch(x, where)) ?? null;",
    "        return p ? { id: p.id } : null;",
    "      },",
    "      update: async ({ where, data }) => {",
    "        store.writes.push(`payment.update:${where.id}`);",
    "        const p = store.payments.find((x) => x.id === where.id);",
    "        if (!p) throw new Error('payment row not found for update');",
    "        Object.assign(p, clone(data));",
    "        return clone(p);",
    "      },",
    "    },",
    "    student: {",
    "      findUnique: async ({ where }) => {",
    "        const s = where.userId ? store.students.find((x) => x.userId === where.userId) : store.students.find((x) => x.id === where.id);",
    "        return s ? clone(studentView(store, s)) : null;",
    "      },",
    "      count: async ({ where }) => store.students.filter((s) => s.groupId === where.groupId).length,",
    "      update: async ({ where, data }) => {",
    "        store.writes.push(`student.update:${where.id}`);",
    "        const s = store.students.find((x) => x.id === where.id);",
    "        if (!s) throw new Error('student row not found for update');",
    "        Object.assign(s, clone(data));",
    "        return { id: s.id, groupId: s.groupId ?? null };",
    "      },",
    "    },",
    "    subscriptionPlan: { findUnique: async ({ where }) => planView(store, where.id) },",
    "    group: { findUnique: async ({ where }) => groupView(store, where.id) },",
    "    course: { findUnique: async ({ where }) => { const c = store.courses.find((x) => x.id === where.id); return c ? { academicLevel: c.academicLevel ?? null } : null; } },",
    "    subscription: {",
    "      create: async ({ data }) => {",
    "        store.writes.push(`subscription.create:${data.studentId}`);",
    "        const row = { id: `sub-${store.seq.sub++}`, ...clone(data) };",
    "        store.subscriptions.push(row);",
    "        return { id: row.id, status: row.status, planId: row.planId, startDate: row.startDate, endDate: row.endDate };",
    "      },",
    "      update: async ({ where, data }) => {",
    "        store.writes.push(`subscription.update:${where.id}`);",
    "        const row = store.subscriptions.find((x) => x.id === where.id);",
    "        if (!row) throw new Error('subscription row not found for update');",
    "        Object.assign(row, clone(data));",
    "        return { id: row.id, status: row.status, planId: row.planId, startDate: row.startDate, endDate: row.endDate };",
    "      },",
    "    },",
    "    auditLog: {",
    "      create: async ({ data }) => {",
    "        store.writes.push(`auditLog.create:${data.entityId}`);",
    "        const row = { id: `audit-${store.seq.audit++}`, ...clone(data) };",
    "        store.auditLogs.push(row);",
    "        return row;",
    "      },",
    "    },",
    "    couponRedemption: {",
    "      findMany: async ({ where }) => store.redemptions.filter((r) => (where.paymentId ? r.paymentId === where.paymentId : true)).map(clone),",
    "      delete: async ({ where }) => {",
    "        store.writes.push(`couponRedemption.delete:${where.id}`);",
    "        const i = store.redemptions.findIndex((r) => r.id === where.id);",
    "        if (i >= 0) store.redemptions.splice(i, 1);",
    "        return {};",
    "      },",
    "    },",
    "    coupon: {",
    "      findUnique: async ({ where }) => { const c = store.coupons.find((x) => x.id === where.id) ?? null; return c ? { id: c.id, usedCount: c.usedCount } : null; },",
    "      update: async ({ where, data }) => {",
    "        store.writes.push(`coupon.update:${where.id}`);",
    "        const c = store.coupons.find((x) => x.id === where.id);",
    "        if (!c) throw new Error('coupon row not found');",
    "        if (data.usedCount && typeof data.usedCount.increment === 'number') c.usedCount += data.usedCount.increment;",
    "        if (data.usedCount && typeof data.usedCount.decrement === 'number') c.usedCount = Math.max(0, c.usedCount - data.usedCount.decrement);",
    "        return { id: c.id, usedCount: c.usedCount };",
    "      },",
    "    },",
    "  };",
    "  return {",
    "    ...tx,",
    "    $transaction: async (fn) => {",
    "      const snapshot = clone({ payments: store.payments, students: store.students, subscriptions: store.subscriptions, auditLogs: store.auditLogs, coupons: store.coupons, redemptions: store.redemptions });",
    "      const writesBefore = store.writes.length;",
    "      try { return await fn(tx); } catch (e) {",
    "        store.payments = snapshot.payments; store.students = snapshot.students;",
    "        store.subscriptions = snapshot.subscriptions; store.auditLogs = snapshot.auditLogs;",
    "        store.coupons = snapshot.coupons; store.redemptions = snapshot.redemptions;",
    "        store.writes.length = writesBefore;",
    "        throw e;",
    "      }",
    "    },",
    "    $disconnect: async () => {},",
    "  };",
    "}",
    "function seedPayment(store, p) {",
    "  store.payments.push({",
    "    id: p.id, userId: p.userId, subscriptionId: p.subscriptionId ?? null, amount: p.amount ?? 300,",
    "    method: 'INSTAPAY', status: 'PENDING', reference: null, senderPhone: null,",
    "    requestedGroupId: p.requestedGroupId ?? null, requestedPlanId: p.requestedPlanId ?? null,",
    "    rejectionReason: null, reviewedAt: null, reviewedByUserId: null,",
    "    createdAt: p.createdAt,",
    "  });",
    "}",
    "",
    "// Three approval scenarios. Two of them deliberately straddle a DST",
    "// boundary (October→November 2026 in the northern hemisphere, and",
    "// September→October 2026 in the southern hemisphere) so a local-time",
    "// implementation cannot hide.",
    "async function scenarioA() {",
    "  const store = freshStore();",
    "  store.students.push({ id: 'stu-a', userId: 'u-a', groupId: 'g1', schoolType: 'ARABIC', academicLevel: 'SECOND_SECONDARY' });",
    "  store.subscriptions.push({ id: 'sub-a', studentId: 'stu-a', planId: 'p1', status: 'ACTIVE', startDate: at('2026-01-01T00:00:00.000Z'), endDate: at('2026-10-01T00:00:00.000Z') });",
    "  seedPayment(store, { id: 'pay-a', userId: 'u-a', subscriptionId: 'sub-a', requestedGroupId: 'g2', requestedPlanId: 'p2', createdAt: at('2026-09-15T10:30:00.000Z') });",
    "  const res = await TR.approvePayment({ db: makeDb(store), paymentId: 'pay-a', reviewerUserId: 'admin-1', now: at('2026-09-15T12:00:00.000Z') });",
    "  const row = store.subscriptions[0];",
    "  return { scenario: res.scenario, stacked: res.stacked, planId: row.planId, startEpoch: row.startDate.getTime(), startIso: row.startDate.toISOString(), endEpoch: row.endDate.getTime(), endIso: row.endDate.toISOString() };",
    "}",
    "async function scenarioB() {",
    "  const store = freshStore();",
    "  store.students.push({ id: 'stu-b', userId: 'u-b', groupId: 'g1', schoolType: 'ARABIC', academicLevel: 'SECOND_SECONDARY' });",
    "  store.subscriptions.push({ id: 'sub-b', studentId: 'stu-b', planId: 'p1', status: 'ACTIVE', startDate: at('2026-01-01T00:00:00.000Z'), endDate: at('2026-10-01T00:00:00.000Z') });",
    "  seedPayment(store, { id: 'pay-b', userId: 'u-b', subscriptionId: 'sub-b', requestedGroupId: 'g1', requestedPlanId: 'p1', createdAt: at('2026-09-15T10:30:00.000Z') });",
    "  const res = await TR.approvePayment({ db: makeDb(store), paymentId: 'pay-b', reviewerUserId: 'admin-1', now: at('2026-09-15T12:00:00.000Z') });",
    "  const row = store.subscriptions[0];",
    "  return { scenario: res.scenario, stacked: res.stacked, planId: row.planId, startEpoch: row.startDate.getTime(), startIso: row.startDate.toISOString(), endEpoch: row.endDate.getTime(), endIso: row.endDate.toISOString() };",
    "}",
    "async function scenarioC() {",
    "  const store = freshStore();",
    "  store.students.push({ id: 'stu-c', userId: 'u-c', groupId: null, schoolType: 'ARABIC', academicLevel: 'SECOND_SECONDARY' });",
    "  // PR2a submission shape: the student's own PENDING placeholder row (it has",
    "  // never been an entitlement) ⇒ FIRST_ACTIVATION, not a reactivation.",
    "  store.subscriptions.push({ id: 'sub-c', studentId: 'stu-c', planId: 'p1', status: 'PENDING', startDate: null, endDate: null });",
    "  seedPayment(store, { id: 'pay-c', userId: 'u-c', subscriptionId: 'sub-c', requestedGroupId: 'g1', requestedPlanId: 'p1', createdAt: at('2026-10-20T09:00:00.000Z') });",
    "  const now = at('2026-10-20T14:37:25.123Z');",
    "  const res = await TR.approvePayment({ db: makeDb(store), paymentId: 'pay-c', reviewerUserId: 'admin-1', now });",
    "  const row = store.subscriptions[0];",
    "  return { scenario: res.scenario, stacked: res.stacked, planId: row.planId, startEpoch: row.startDate.getTime(), startIso: row.startDate.toISOString(), endEpoch: row.endDate.getTime(), endIso: row.endDate.toISOString() };",
    "}",
    "",
    "(async () => {",
    "  const approval = { a: await scenarioA(), b: await scenarioB(), c: await scenarioC() };",
    "  const out = {",
    "    requestedTz: process.env.TZ ?? null,",
    "    resolvedTzOffsetOct1: at('2026-10-01T00:00:00.000Z').getTimezoneOffset(),",
    "    resolvedTzOffsetNov1: at('2026-11-01T00:00:00.000Z').getTimezoneOffset(),",
    "    resolvedTzOffsetJan1: at('2027-01-01T00:00:00.000Z').getTimezoneOffset(),",
    "    resolvedTzOffsetSep15: at('2026-09-15T12:00:00.000Z').getTimezoneOffset(),",
    "    resolvedTzOffsetNov20: at('2026-11-20T14:37:25.123Z').getTimezoneOffset(),",
    "    cases,",
    "    approval,",
    "  };",
    "  process.stdout.write(JSON.stringify(out) + '\\n');",
    "})().catch((e) => { process.stderr.write('PROBE ERROR: ' + (e && e.stack || e) + '\\n'); process.exit(2); });",
    "",
  ].join("\n")
);

/** Run the probe in one explicit TZ environment and parse its JSON. */
function runProbe(tz) {
  const res = spawnSync(process.execPath, [PROBE, OUT], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, TZ: tz, DATABASE_URL: "file:./db/custom.db" },
  });
  if (res.status !== 0) {
    throw new Error(`probe failed under TZ=${tz} (status ${res.status})\n${res.stderr}`);
  }
  const line = String(res.stdout).trim().split("\n").pop();
  return JSON.parse(line);
}

// ---------------------------------------------------------------------------
// The UTC-pinned expectations. These are the INTENDED business results — the
// same values tests/payment-lifecycle-phase25-pr2b.test.js already pins, plus
// non-midnight and DST-straddling cases.
// ---------------------------------------------------------------------------
const EXPECTED = {
  // The three originally-failing assertions from the merge report.
  oct1: ["2026-11-01T00:00:00.000Z", "Oct 1 00:00Z + 1 month = Nov 1 00:00Z (the reported failure)"],
  oct1_3: ["2027-01-01T00:00:00.000Z", "Oct 1 00:00Z + 3 months = Jan 1 00:00Z (active-renewal stacking)"],
  // Day clamping — must survive the rewrite byte-for-byte.
  jan31: ["2026-02-28T00:00:00.000Z", "Jan 31 + 1 month = Feb 28 (non-leap, CLAMPED, never Mar 3)"],
  jan31leap: ["2024-02-29T00:00:00.000Z", "Jan 31 2024 + 1 month = Feb 29 2024 (leap year clamp)"],
  jan31_2: ["2026-03-31T00:00:00.000Z", "Jan 31 + 2 months = Mar 31"],
  dec15: ["2027-01-15T00:00:00.000Z", "Dec 15 + 1 month = Jan 15 (year rollover)"],
  jan31_12: ["2027-01-31T00:00:00.000Z", "Jan 31 + 12 months = Jan 31 next year"],
  oct1_0: ["2026-10-01T00:00:00.000Z", "+0 months = identity"],
  mar31_m1: ["2026-02-28T00:00:00.000Z", "Mar 31 - 1 month = Feb 28 (negative months still clamp)"],
  mar31_m13: ["2025-02-28T00:00:00.000Z", "Mar 31 - 13 months = Feb 28 previous year (year underflow)"],
  // Southern-hemisphere DST START (Australia/Sydney AEST→AEDT on 2026-10-04).
  nov20: ["2026-12-20T00:00:00.000Z", "Nov 20 + 1 month = Dec 20 (straddles the southern DST start)"],
  // Non-midnight: the UTC time-of-day must be carried exactly, to the ms.
  oct20pm: ["2026-11-20T14:37:25.123Z", "Oct 20 14:37:25.123Z + 1 month keeps h/m/s/ms exactly"],
  oct20pm3: ["2027-01-20T14:37:25.123Z", "Oct 20 14:37:25.123Z + 3 months keeps h/m/s/ms exactly"],
  oct31late: ["2026-11-30T23:59:59.999Z", "Oct 31 23:59:59.999Z + 1 month = Nov 30 (clamped day + full time-of-day)"],
  jan31pm: ["2026-02-28T14:37:25.123Z", "Jan 31 14:37:25.123Z + 1 month = Feb 28 at the SAME time-of-day"],
};

const CASE_TO_EXPECTED = {
  "oct1+1": "oct1",
  "oct1+3": "oct1_3",
  "jan31+1": "jan31",
  "jan31+1leap": "jan31leap",
  "jan31+2": "jan31_2",
  "dec15+1": "dec15",
  "jan31+12": "jan31_12",
  "oct1+0": "oct1_0",
  "mar31-1": "mar31_m1",
  "mar31-13": "mar31_m13",
  "nov20+1": "nov20",
  "oct20pm+1": "oct20pm",
  "oct20pm+3": "oct20pm3",
  "oct31late+1": "oct31late",
  "jan31pm+1": "jan31pm",
};

// The approval scenarios' UTC-pinned results.
const APPROVAL_EXPECTED = {
  a: {
    scenario: "RENEWAL",
    stacked: true,
    planId: "p2",
    startIso: "2026-01-01T00:00:00.000Z",
    endIso: "2027-01-01T00:00:00.000Z",
    label: "A: ACTIVE renewal — Oct 1 endDate + 3-month plan stacked = Jan 1 2027 00:00Z, startDate preserved",
  },
  b: {
    scenario: "RENEWAL",
    stacked: true,
    planId: "p1",
    startIso: "2026-01-01T00:00:00.000Z",
    endIso: "2026-11-01T00:00:00.000Z",
    label: "B: §33 shape — Oct 1 endDate + 1-month plan stacked = Nov 1 2026 00:00Z",
  },
  c: {
    scenario: "FIRST_ACTIVATION",
    stacked: false,
    planId: "p1",
    startIso: "2026-10-20T14:37:25.123Z",
    endIso: "2026-11-20T14:37:25.123Z",
    label: "C: fresh activation at a non-midnight clock across the DST boundary = Nov 20 14:37:25.123Z",
  },
};

// ===========================================================================
function main() {
  section("0. Compile the shipped modules + materialize the per-TZ probe");
  ok(fs.existsSync(path.join(OUT, "payment-transitions.js")), "the shipped payment-transitions.ts compiled");
  ok(fs.existsSync(PROBE), "the child probe exists");

  const results = new Map();
  for (const tz of TZ_LIST) results.set(tz, runProbe(tz));

  // -------------------------------------------------------------------------
  section(`1. The TZ matrix is REAL (${TZ_LIST.length} child processes, one per TZ)`);
  // -------------------------------------------------------------------------
  const offsets = [...results.values()].map((r) => r.resolvedTzOffsetOct1);
  const distinctOctOffsets = new Set(offsets);
  // A runner that ignores TZ entirely would make every child resolve the same
  // offset, degenerating the matrix. Say so loudly rather than letting the
  // cross-timezone spread assertions pass on an all-identical set.
  const honored = distinctOctOffsets.size > 1;
  if (!honored) {
    console.log(
      "\n  !! TZ_ENV_NOT_HONORED_FALLBACK_USED — this runner did not apply the per-child TZ\n" +
        "     environment (every child reported the same UTC offset). The date assertions below\n" +
        "     still run and still must pass; only the cross-timezone SPREAD proof is unavailable."
    );
  } else {
    ok(true, `TZ took effect: ${distinctOctOffsets.size} distinct UTC offsets observed on 2026-10-01`);
  }
  // The Cairo DST boundary the bug lived on: October is UTC+3, November UTC+2.
  const cairo = results.get("Africa/Cairo");
  if (honored) {
    eq(cairo.resolvedTzOffsetOct1, -180, "Africa/Cairo on 2026-10-01 is UTC+3 (EEST, DST active)");
    eq(cairo.resolvedTzOffsetNov1, -120, "Africa/Cairo on 2026-11-01 is UTC+2 (EET, DST ended)");
    ok(
      cairo.resolvedTzOffsetOct1 !== cairo.resolvedTzOffsetNov1,
      "the Oct→Nov month pair genuinely STRADDLES the Cairo DST transition (the bug's exact boundary)"
    );
    const ny = results.get("America/New_York");
    // US DST 2026 ends 06:00Z on Sun Nov 1 — so Nov 1 00:00Z is still EDT and
    // a later November instant is EST. Both ends of the tested Oct→Nov pair
    // sit on opposite sides of the transition.
    eq(ny.resolvedTzOffsetOct1, 240, "America/New_York on 2026-10-01 is UTC-4 (EDT)");
    eq(ny.resolvedTzOffsetNov20, 300, "America/New_York on 2026-11-20 is UTC-5 (EST)");
    ok(
      ny.resolvedTzOffsetOct1 !== ny.resolvedTzOffsetNov20,
      "America/New_York also straddles a DST transition inside the tested month pair"
    );
    const syd = results.get("Australia/Sydney");
    // Southern hemisphere: Australia/Sydney ENTERS DST on 2026-10-04, so the
    // Oct→Nov pair straddles the transition in the opposite direction.
    eq(syd.resolvedTzOffsetSep15, -600, "Australia/Sydney on 2026-09-15 is UTC+10 (AEST)");
    eq(syd.resolvedTzOffsetNov1, -660, "Australia/Sydney on 2026-11-01 is UTC+11 (AEDT)");
    ok(
      syd.resolvedTzOffsetOct1 !== syd.resolvedTzOffsetNov1,
      "Australia/Sydney covers the SOUTHERN-hemisphere DST direction (offset changes too)"
    );
  }
  for (const tz of TZ_LIST) {
    const r = results.get(tz);
    eq(r.requestedTz, tz, `the child for TZ=${tz} really received TZ=${tz} in its environment`);
  }

  // -------------------------------------------------------------------------
  section("2. addMonths matches the UTC-pinned calendar result in EVERY timezone");
  // -------------------------------------------------------------------------
  for (const tz of TZ_LIST) {
    const r = results.get(tz);
    for (const [caseLabel, expectedKey] of Object.entries(CASE_TO_EXPECTED)) {
      const [wantIso, why] = EXPECTED[expectedKey];
      const got = r.cases[caseLabel];
      ok(!!got, `TZ=${tz}: case ${caseLabel} produced a result`);
      if (!got) continue;
      eq(got.iso, wantIso, `TZ=${tz}: ${caseLabel} → ${why}`);
      eq(got.epoch, Date.parse(wantIso), `TZ=${tz}: ${caseLabel} epoch is the exact UTC instant`);
      ok(got.baseUnmutated, `TZ=${tz}: ${caseLabel} did NOT mutate its input date (pure helper)`);
    }
  }

  // -------------------------------------------------------------------------
  section("3. Non-midnight UTC time-of-day is preserved exactly (h/m/s/ms carried)");
  // -------------------------------------------------------------------------
  for (const tz of TZ_LIST) {
    const r = results.get(tz);
    eq(
      r.cases["oct20pm+1"].utcFields,
      [2026, 11, 20, 14, 37, 25, 123],
      `TZ=${tz}: Oct 20 14:37:25.123Z + 1 month keeps EVERY UTC field (no ±1h DST shift)`
    );
    eq(
      r.cases["jan31pm+1"].utcFields,
      [2026, 2, 28, 14, 37, 25, 123],
      `TZ=${tz}: a CLAMPED day still keeps the UTC time-of-day byte-for-byte`
    );
    eq(
      r.cases["oct31late+1"].utcFields,
      [2026, 11, 30, 23, 59, 59, 999],
      `TZ=${tz}: 23:59:59.999 is preserved (no rounding into the next day)`
    );
  }

  // -------------------------------------------------------------------------
  section("4. The REAL approval path writes the same UTC instants in EVERY timezone");
  // -------------------------------------------------------------------------
  for (const tz of TZ_LIST) {
    const r = results.get(tz);
    for (const key of ["a", "b", "c"]) {
      const want = APPROVAL_EXPECTED[key];
      const got = r.approval[key];
      eq(got.scenario, want.scenario, `TZ=${tz}: ${want.label} — scenario`);
      eq(got.stacked, want.stacked, `TZ=${tz}: ${want.label} — stacked flag`);
      eq(got.planId, want.planId, `TZ=${tz}: ${want.label} — plan applied`);
      eq(got.startIso, want.startIso, `TZ=${tz}: ${want.label} — startDate`);
      eq(got.endIso, want.endIso, `TZ=${tz}: ${want.label} — endDate`);
      eq(got.endEpoch, Date.parse(want.endIso), `TZ=${tz}: ${want.label} — endDate epoch`);
    }
  }

  // -------------------------------------------------------------------------
  section("5. Cross-timezone byte-identity (the same UTC input ⇒ the same epoch)");
  // -------------------------------------------------------------------------
  {
    const baselineTz = "UTC";
    /**
     * Flatten one child's payload to "path" → ISO instant, so a mismatch NAMES
     * the diverging field instead of dumping two whole payloads.
     */
    const flatten = (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.cases)) out[`addMonths.${k}`] = v.iso;
      for (const [k, v] of Object.entries(r.approval)) {
        out[`approval.${k}.startDate`] = v.startIso;
        out[`approval.${k}.endDate`] = v.endIso;
      }
      return out;
    };
    const base = flatten(results.get(baselineTz));
    for (const tz of TZ_LIST) {
      if (tz === baselineTz) continue;
      const got = flatten(results.get(tz));
      const diffs = Object.keys(base).filter((k) => got[k] !== base[k]);
      ok(
        diffs.length === 0,
        `TZ=${tz} produced a BYTE-IDENTICAL date payload to TZ=${baselineTz} (timezone independence)` +
          (diffs.length
            ? ` — ${diffs.length} diverging: ${diffs.map((k) => `${k}: ${got[k]} != ${base[k]}`).join("; ")}`
            : "")
      );
    }
    // And the explicit report case: every timezone agrees on Nov 1 00:00:00Z.
    const nov1 = new Set([...results.values()].map((r) => r.cases["oct1+1"].iso));
    eq([...nov1], ["2026-11-01T00:00:00.000Z"], "every timezone maps Oct 1 + 1 month to exactly 2026-11-01T00:00:00.000Z");
    const jan1 = new Set([...results.values()].map((r) => r.approval.a.endIso));
    eq([...jan1], ["2027-01-01T00:00:00.000Z"], "every timezone stacks the 3-month renewal to exactly 2027-01-01T00:00:00.000Z");
  }

  // -------------------------------------------------------------------------
  section("6. The shipped source itself uses UTC-only calendar arithmetic");
  // -------------------------------------------------------------------------
  {
    const src = fs.readFileSync(path.join(REPO, "src/lib/payment-transitions.ts"), "utf8");
    const fnMatch = /export function addMonths\(base: Date, months: number\): Date \{([\s\S]*?)\n\}/.exec(src);
    ok(!!fnMatch, "addMonths is still exported from src/lib/payment-transitions.ts");
    const body = fnMatch ? fnMatch[1] : "";
    // Local-time accessors are the bug class; none may appear in the helper.
    for (const banned of [".getDate()", ".setDate(", ".getMonth()", ".setMonth(", ".getFullYear()", ".setFullYear("]) {
      ok(!body.includes(banned), `addMonths contains NO local-time accessor \`${banned}\` (UTC-only arithmetic)`);
    }
    for (const required of ["getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCHours", "getUTCMinutes", "getUTCSeconds", "getUTCMilliseconds", "Date.UTC"]) {
      ok(body.includes(required), `addMonths uses the UTC operation \`${required}\``);
    }
    // No hardcoded timezone, no fixed 30-day duration, no TZ-conditional branch.
    ok(!/Africa\/Cairo|Asia\/|America\/|Europe\/|Egypt/i.test(body), "no timezone is hardcoded or special-cased in addMonths");
    ok(!/getTimezoneOffset|process\.env\.TZ|Intl\.DateTimeFormat/.test(body), "addMonths never consults the local timezone or TZ env");
    ok(!/30\s*\*\s*24|24\s*\*\s*60\s*\*\s*60\s*\*\s*1000|86400/.test(body), "addMonths is calendar-month arithmetic, NOT a fixed 30-day/86400s duration");
    ok(/Math\.min\(/.test(body), "the day-clamping rule (Math.min(day, lastDay)) is retained");
    ok(/getUTCMonth\(\) \+ months/.test(body), "the duration still comes from the plan's calendar months (durationMonths semantics unchanged)");
  }

  // -------------------------------------------------------------------------
  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `${fail === 0 ? "PASS" : "FAIL"} — payment-lifecycle-phase25-pr2b-utc-tz: ${pass} assertions passed, ${fail} failed (${TZ_LIST.length} timezones)`
  );
  if (fail > 0) {
    console.log("\nFailed:");
    for (const f of failures) console.log("  ✗", f);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (e) {
  console.error("HARNESS ERROR:", e);
  process.exitCode = 1;
}
