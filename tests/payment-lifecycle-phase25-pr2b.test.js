// CodeMind Academy — Phase 25 PR2b: the payment DECISION layer (core
// behavioural suite).
//
// THE SHIPPED TypeScript (`src/lib/payment-transitions.ts` +
// `src/lib/db-serialization.ts` + `src/lib/subscription-entitlement.ts`) is
// compiled with tsc and exercised against an in-memory store through the
// service's injected `db` (same harness convention as
// tests/payment-lifecycle-phase25-pr2a*.test.js). The store really persists
// (or refuses) the writes the shipped code attempts, a failed transaction
// rolls the store back to its pre-transaction snapshot (so "atomic" is
// proven, not assumed), and a fault-injection hook turns any chosen write
// into a database error to prove NONE of the business writes commit.
//
// Coverage (spec §36 A–J + date/stale/atomicity detail):
//   A  approval — new student (PENDING-only, singleton, group, plan, dates,
//      review fields, access false→true, audit)
//   B  approval — active renewal (singleton reused, startDate preserved,
//      FUTURE endDate stacking, requested plan/group applied at approval)
//   B2 same-group renewal approves even at capacity (no seat consumed)
//   C  approval — legacy grandfathered (subscriptionId null accepted,
//      singleton created + linked, group preserved, access uninterrupted,
//      truthful CONFIRMED notification kind)
//   C2 legacy already-seated (no requestedGroupId → current group fallback)
//   D  rejection (reason required/trimmed/capped; PENDING→REJECTED;
//      entitlement byte-for-byte preserved for all three student kinds;
//      coupon released atomically + idempotent under forbidden repeats)
//   E  invalid transitions (APPROVED/REJECTED/EXPIRED in every combination;
//      not-found; review fields never written on a failed decision)
//   F  stale payments (newer pending blocks older; newest wins; equal
//      createdAt → id DESC tie-break; a newer REJECTED row does NOT stale)
//   G  group/plan resolution (GROUP_REQUIRED / PLAN_REQUIRED /
//      GROUP_NOT_FOUND / INVALID_GROUP_CONTEXT / PLAN_NOT_FOUND / NO_STUDENT
//      / unambiguous current-plan fallback / admin override recovery)
//   H  capacity (GROUP_FULL leaves the payment PENDING with zero partial
//      writes; same-group renewal at capacity approves)
//   J  post-commit effects (notification/reconciliation failure never
//      un-commits; fixed order)
//   K  atomicity fault injection (a failed write rolls back EVERYTHING)
//   +  date math pins, scenario labels (first / renewal / reactivation /
//      grandfathered), reviewer-field truthfulness, SQLite no-lock mode,
//      domain error model + status map, i18n key resolution (ar+en).
//
// Concurrency (spec §18) is proven in
// tests/payment-lifecycle-phase25-pr2b-concurrency.test.js; the full
// PR2a→PR2b chain over real HTTP + real SQLite is proven in
// tests/payment-lifecycle-phase25-pr2b-fullchain.test.js.
//
// Run: node tests/payment-lifecycle-phase25-pr2b.test.js
// Exit: 0 = all pass, 1 = failure. Requires Node >= 22.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const { execSync } = require("child_process");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const ts = require(path.join(__dirname, "..", "node_modules/typescript/lib/typescript.js"));

const REPO = path.join(__dirname, "..");

// Deterministic provider: sqlite → the advisory-lock helper is a NO-OP and
// no raw SQL is ever attempted (pinned per run).
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

// ---------------------------------------------------------------------------
// Compile the shipped modules under test.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p25pr2b-"));
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
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch {
  /* fall through: verify the emitted files below */
}
for (const f of ["db-serialization.js", "subscription-entitlement.js", "payment-transitions.js", "i18n-core.js"]) {
  if (!fs.existsSync(path.join(OUT, f))) throw new Error(`tsc did not emit ${f}`);
}

// Module redirects: `@/lib/*` → compiled output; `@/lib/db` → fake (the
// entitlement resolver's lazy default client); `@prisma/client` → stub
// (type-only imports in the shipped files; the sandbox cannot download the
// engine binaries to run `prisma generate`).
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@prisma/client") return path.join(OUT, "prisma-stub.js");
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(OUT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return realResolve.call(this, request, ...rest);
};
fs.writeFileSync(
  path.join(OUT, "prisma-stub.js"),
  'module.exports = new Proxy({}, { get: () => function noop() {} });\n'
);
fs.writeFileSync(
  path.join(OUT, "fake-db.js"),
  'module.exports = { get db() { return null; } };\n'
);
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return path.join(OUT, "fake-db.js");
  if (request === "@prisma/client") return path.join(OUT, "prisma-stub.js");
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(OUT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return realResolve.call(this, request, ...rest);
};

const SER = require(path.join(OUT, "db-serialization.js"));
const ENT = require(path.join(OUT, "subscription-entitlement.js"));
const TR = require(path.join(OUT, "payment-transitions.js"));
const I18N = require(path.join(OUT, "i18n-core.js"));

// ---------------------------------------------------------------------------
// The shared store + fake Prisma surface.
// ---------------------------------------------------------------------------
const NOW = new Date("2026-09-15T12:00:00.000Z"); // the approval "now"
const at = (iso) => new Date(iso);

function freshStore() {
  return {
    students: [], // {id, userId, groupId}
    groups: [
      // Phase 26B — groups carry an explicit audience (trackScope). These
      // fixtures are ARABIC groups; every student fixture below is ARABIC, so
      // the exact-match eligibility rule behaves exactly as before for them.
      { id: "g1", name: "Group 1", courseId: "c1", isActive: true, capacity: 20, trackScope: "ARABIC" },
      { id: "g2", name: "Group 2", courseId: "c1", isActive: true, capacity: 20, trackScope: "ARABIC" },
      { id: "g3", name: "Group 3 (course 2)", courseId: "c2", isActive: true, capacity: 20, trackScope: "ARABIC" },
      { id: "g4", name: "Inactive Group", courseId: "c1", isActive: false, capacity: 20, trackScope: "ARABIC" },
      { id: "g5", name: "Tiny Group", courseId: "c1", isActive: true, capacity: 2, trackScope: "ARABIC" },
    ],
    plans: [
      { id: "p1", name: "Monthly", durationMonths: 1, price: 300, isActive: true },
      { id: "p2", name: "Quarterly", durationMonths: 3, price: 800, isActive: true },
      { id: "p3", name: "Disabled", durationMonths: 1, price: 100, isActive: false },
      { id: "p4", name: "Bimonthly", durationMonths: 2, price: 500, isActive: true },
    ],
    subscriptions: [],
    payments: [],
    coupons: [],
    redemptions: [],
    auditLogs: [],
    writes: [], // every mutation op attempted (model.op:id)
    rawCalls: [], // $executeRaw attempts (SQL + values)
    faults: {}, // "model.op" → Error to throw (fault injection)
    seq: { sub: 1, audit: 1 },
  };
}

const clone = (v) => structuredClone(v);

function maybeFault(store, key) {
  if (store.faults[key]) throw store.faults[key];
}

function addStudent(store, id, userId, groupId, schoolType = "ARABIC") {
  store.students.push({ id, userId, groupId: groupId ?? null, schoolType });
}
function addSub(store, studentId, planId, status, startDate, endDate) {
  const row = {
    id: `sub-${store.seq.sub++}`,
    studentId,
    planId,
    status,
    startDate: startDate ?? null,
    endDate: endDate ?? null,
  };
  store.subscriptions.push(row);
  return row;
}
function addPayment(store, p) {
  const row = {
    id: p.id,
    userId: p.userId,
    subscriptionId: p.subscriptionId ?? null,
    amount: p.amount ?? 300,
    method: "INSTAPAY",
    status: p.status ?? "PENDING",
    reference: p.reference ?? null,
    senderPhone: p.senderPhone ?? null,
    requestedGroupId: p.requestedGroupId ?? null,
    requestedPlanId: p.requestedPlanId ?? null,
    rejectionReason: p.rejectionReason ?? null,
    reviewedAt: p.reviewedAt ?? null,
    reviewedByUserId: p.reviewedByUserId ?? null,
    createdAt: p.createdAt ?? at("2026-09-15T11:00:00.000Z"),
  };
  store.payments.push(row);
  return row;
}

/** The stale-guard where-clause, translated against the store. */
function staleWhereMatch(p, where) {
  if (p.userId !== where.userId) return false;
  if (p.status !== where.status) return false;
  if (where.NOT && p.id === where.NOT.id) return false;
  if (where.OR) {
    return where.OR.some((alt) => {
      if (alt.createdAt && alt.createdAt.gt !== undefined) {
        return p.createdAt.getTime() > alt.createdAt.gt.getTime();
      }
      if (Array.isArray(alt.AND)) {
        const ts = alt.AND.find((c) => c.createdAt !== undefined);
        const idc = alt.AND.find((c) => c.id !== undefined);
        if (ts && p.createdAt.getTime() !== ts.createdAt.getTime()) return false;
        if (idc && !(p.id > idc.id.gt)) return false;
        return true;
      }
      return false;
    });
  }
  return true;
}

function studentView(store, student) {
  const group = student.groupId ? store.groups.find((g) => g.id === student.groupId) ?? null : null;
  const sub = store.subscriptions.find((s) => s.studentId === student.id) ?? null;
  return {
    id: student.id,
    userId: student.userId,
    groupId: student.groupId ?? null,
    // Phase 26B — the audience-eligibility inputs (exact-match rule).
    schoolType: student.schoolType ?? null,
    group: group
      ? { id: group.id, isActive: group.isActive, courseId: group.courseId }
      : null,
    subscription: sub
      ? { id: sub.id, status: sub.status, planId: sub.planId, startDate: sub.startDate, endDate: sub.endDate }
      : null,
  };
}

function groupView(store, id) {
  const g = store.groups.find((x) => x.id === id);
  return g ? { id: g.id, name: g.name, isActive: g.isActive, courseId: g.courseId, capacity: g.capacity, trackScope: g.trackScope ?? null } : null;
}
function planView(store, id) {
  const p = store.plans.find((x) => x.id === id);
  return p ? { id: p.id, isActive: p.isActive, durationMonths: p.durationMonths } : null;
}

/**
 * The fake Prisma surface the service's injected `db` drives. `db.$transaction`
 * snapshots the store and RESTORES it when the callback throws — the fake
 * models the real database's atomicity, so "none of the business writes
 * commit" is an observable property, not a promise.
 */
function makeDb(store) {
  const tx = {
    $executeRaw: async (strings, ...values) => {
      store.rawCalls.push({ sql: strings.join("?"), values });
      return 0;
    },
    payment: {
      findUnique: async ({ where }) => {
        const p = store.payments.find((x) => x.id === where.id) ?? null;
        return p ? clone(p) : null;
      },
      findFirst: async ({ where }) => {
        const p = store.payments.find((x) => staleWhereMatch(x, where)) ?? null;
        return p ? { id: p.id } : null;
      },
      update: async ({ where, data }) => {
        store.writes.push(`payment.update:${where.id}`);
        maybeFault(store, "payment.update");
        const p = store.payments.find((x) => x.id === where.id);
        if (!p) throw new Error("payment row not found for update");
        Object.assign(p, clone(data));
        return clone(p);
      },
    },
    student: {
      findUnique: async ({ where }) => {
        const s = where.userId
          ? store.students.find((x) => x.userId === where.userId)
          : store.students.find((x) => x.id === where.id);
        return s ? clone(studentView(store, s)) : null;
      },
      count: async ({ where }) =>
        Promise.resolve(store.students.filter((s) => s.groupId === where.groupId).length),
      update: async ({ where, data }) => {
        store.writes.push(`student.update:${where.id}`);
        maybeFault(store, "student.update");
        const s = store.students.find((x) => x.id === where.id);
        if (!s) throw new Error("student row not found for update");
        Object.assign(s, clone(data));
        return { id: s.id, groupId: s.groupId ?? null };
      },
    },
    subscriptionPlan: { findUnique: async ({ where }) => Promise.resolve(planView(store, where.id)) },
    group: { findUnique: async ({ where }) => Promise.resolve(groupView(store, where.id)) },
    subscription: {
      create: async ({ data }) => {
        store.writes.push(`subscription.create:${data.studentId}`);
        maybeFault(store, "subscription.create");
        const row = { id: `sub-${store.seq.sub++}`, createdAt: new Date(), ...clone(data) };
        store.subscriptions.push(row);
        return { id: row.id, status: row.status, planId: row.planId, startDate: row.startDate, endDate: row.endDate };
      },
      update: async ({ where, data }) => {
        store.writes.push(`subscription.update:${where.id}`);
        maybeFault(store, "subscription.update");
        const row = store.subscriptions.find((x) => x.id === where.id);
        if (!row) throw new Error("subscription row not found for update");
        Object.assign(row, clone(data));
        return { id: row.id, status: row.status, planId: row.planId, startDate: row.startDate, endDate: row.endDate };
      },
    },
    auditLog: {
      create: async ({ data }) => {
        store.writes.push(`auditLog.create:${data.entityId}`);
        maybeFault(store, "auditLog.create");
        const row = { id: `audit-${store.seq.audit++}`, createdAt: new Date(), ...clone(data) };
        store.auditLogs.push(row);
        return row;
      },
    },
    couponRedemption: {
      findMany: async ({ where }) =>
        store.redemptions.filter((r) => (where.paymentId ? r.paymentId === where.paymentId : true)).map(clone),
      delete: async ({ where }) => {
        store.writes.push(`couponRedemption.delete:${where.id}`);
        maybeFault(store, "couponRedemption.delete");
        const i = store.redemptions.findIndex((r) => r.id === where.id);
        if (i >= 0) store.redemptions.splice(i, 1);
        return {};
      },
    },
    coupon: {
      findUnique: async ({ where }) => {
        const c = store.coupons.find((x) => x.id === where.id) ?? null;
        return c ? { id: c.id, usedCount: c.usedCount } : null;
      },
      update: async ({ where, data }) => {
        store.writes.push(`coupon.update:${where.id}`);
        maybeFault(store, "coupon.update");
        const c = store.coupons.find((x) => x.id === where.id);
        if (!c) throw new Error("coupon row not found");
        if (data.usedCount && typeof data.usedCount.increment === "number") c.usedCount += data.usedCount.increment;
        if (data.usedCount && typeof data.usedCount.decrement === "number") c.usedCount = Math.max(0, c.usedCount - data.usedCount.decrement);
        return { id: c.id, usedCount: c.usedCount };
      },
    },
  };

  return {
    ...tx,
    $transaction: async (fn) => {
      const snapshot = clone({
        payments: store.payments,
        students: store.students,
        subscriptions: store.subscriptions,
        auditLogs: store.auditLogs,
        coupons: store.coupons,
        redemptions: store.redemptions,
      });
      const writesBefore = store.writes.length;
      try {
        return await fn(tx);
      } catch (e) {
        // The database rolled back — restore the pre-transaction state.
        store.payments = snapshot.payments;
        store.students = snapshot.students;
        store.subscriptions = snapshot.subscriptions;
        store.auditLogs = snapshot.auditLogs;
        store.coupons = snapshot.coupons;
        store.redemptions = snapshot.redemptions;
        store.writes.length = writesBefore;
        throw e;
      }
    },
    $disconnect: async () => {},
  };
}

const admin = "admin-1";
const approve = (store, paymentId, overrides = {}) =>
  TR.approvePayment({ db: makeDb(store), paymentId, reviewerUserId: admin, now: NOW, ...overrides });
const reject = (store, paymentId, reason, overrides = {}) =>
  TR.rejectPayment({ db: makeDb(store), paymentId, reviewerUserId: admin, reason, now: NOW, ...overrides });

async function expectCode(promise, code, label) {
  try {
    await promise;
    ok(false, `${label} (expected ${code}, none thrown)`);
  } catch (e) {
    if (!(e instanceof TR.PaymentTransitionError)) {
      ok(false, `${label} (expected ${code}, threw ${e?.name}: ${e?.message})`);
      return;
    }
    ok(e.code === code, `${label} (expected ${code}, got ${e.code})`);
  }
}

// ===========================================================================
async function main() {
  // -------------------------------------------------------------------------
  section("0. Domain error model + deterministic status map");
  // -------------------------------------------------------------------------
  eq(
    [...TR.PAYMENT_TRANSITION_ERROR_CODES].sort(),
    [
      "GROUP_FULL", "GROUP_NOT_FOUND", "GROUP_REQUIRED", "GROUP_TRACK_MISMATCH",
      "INVALID_GROUP_CONTEXT", "INVALID_REJECTION_REASON", "INVALID_TRANSITION",
      "NO_STUDENT", "PAYMENT_NOT_FOUND", "PLAN_NOT_FOUND", "PLAN_REQUIRED",
      "STALE_PAYMENT",
    ].sort(),
    "the closed domain-error set is exactly the 12 required codes (Phase 26B adds GROUP_TRACK_MISMATCH)"
  );
  eq(TR.TRANSITION_ERROR_STATUS.PAYMENT_NOT_FOUND, 404, "PAYMENT_NOT_FOUND maps to 404 (a real not-found)");
  eq(TR.TRANSITION_ERROR_STATUS.INVALID_REJECTION_REASON, 400, "INVALID_REJECTION_REASON maps to 400 (body validation)");
  ok(
    ["INVALID_TRANSITION", "STALE_PAYMENT", "NO_STUDENT", "GROUP_REQUIRED", "GROUP_NOT_FOUND", "GROUP_FULL", "PLAN_REQUIRED", "PLAN_NOT_FOUND", "INVALID_GROUP_CONTEXT"].every(
      (c) => TR.TRANSITION_ERROR_STATUS[c] === 409
    ),
    "every other domain conflict maps to 409 (deterministic conflict, retryable after context fix)"
  );
  {
    const e = new TR.PaymentTransitionError("STALE_PAYMENT");
    ok(e instanceof Error && e instanceof TR.PaymentTransitionError, "PaymentTransitionError is an Error with a code");
    eq(e.code, "STALE_PAYMENT", "the code survives on the instance");
  }
  ok(SER.resolveDatabaseProvider({ DATABASE_URL: process.env.DATABASE_URL }) === "sqlite", "provider is sqlite in this harness (no advisory lock may run)");
  ok(SER.resolveDatabaseProvider({ DATABASE_URL: "postgresql://u:p@h/db" }) === "postgresql", "postgresql URLs resolve to postgresql");
  ok(SER.resolveDatabaseProvider({ DATABASE_URL: "postgres://u:p@h/db" }) === "postgresql", "postgres:// URLs resolve to postgresql");

  // -------------------------------------------------------------------------
  section("1. Date math — the plan's own duration representation");
  // -------------------------------------------------------------------------
  const d = (y, m, day) => new Date(Date.UTC(y, m - 1, day, 0, 0, 0, 0));
  eq(TR.addMonths(d(2026, 10, 1), 1).toUTCString(), d(2026, 11, 1).toUTCString(), "Oct 1 + 1 month = Nov 1 (stacking base, not approval date)");
  eq(TR.addMonths(d(2026, 1, 31), 1).toUTCString(), d(2026, 2, 28).toUTCString(), "Jan 31 + 1 month = Feb 28 (day overflow CLAMPED, never Mar 3)");
  eq(TR.addMonths(d(2024, 1, 31), 1).toUTCString(), d(2024, 2, 29).toUTCString(), "leap year: Jan 31 2024 + 1 month = Feb 29 2024");
  eq(TR.addMonths(d(2026, 1, 31), 2).toUTCString(), d(2026, 3, 31).toUTCString(), "Jan 31 + 2 months = Mar 31");
  eq(TR.addMonths(d(2026, 12, 15), 1).toUTCString(), d(2027, 1, 15).toUTCString(), "Dec 15 + 1 month = Jan 15 (year rollover)");
  eq(TR.addMonths(d(2026, 1, 31), 12).toUTCString(), d(2027, 1, 31).toUTCString(), "Jan 31 + 12 months = Jan 31 next year");
  eq(TR.addMonths(NOW, 0).getTime(), NOW.getTime(), "0 months = identity");

  // -------------------------------------------------------------------------
  section("2. Rejection reason normalization");
  // -------------------------------------------------------------------------
  eq(TR.normalizeRejectionReason("  "), null, "blank reason is invalid");
  eq(TR.normalizeRejectionReason(null), null, "missing reason is invalid");
  eq(TR.normalizeRejectionReason(42), null, "non-string reason is invalid");
  eq(TR.normalizeRejectionReason("x".repeat(501)), null, "501 chars is invalid");
  eq(TR.normalizeRejectionReason("x".repeat(500)).length, 500, "exactly 500 chars is valid");
  eq(TR.normalizeRejectionReason("  double   space  "), "double space", "trim + inner whitespace collapse (normalized reason stored)");

  // -------------------------------------------------------------------------
  section("3. A — APPROVAL: new student (PENDING subscription, no group)");
  // -------------------------------------------------------------------------
  {
    const store = freshStore();
    addStudent(store, "stu-1", "u-1", null);
    const sub = addSub(store, "stu-1", "p1", "PENDING", null, null); // PR2a submission shape
    addPayment(store, { id: "pay-1", userId: "u-1", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: "p1", createdAt: at("2026-09-15T10:00:00.000Z") });

    const before = ENT.evaluateAccessDecision({ groupActive: false, subscription: { status: "PENDING", endDate: null } }, NOW);
    ok(before.allowed === false, "before approval: no group + PENDING subscription ⇒ access FALSE");

    const res = await approve(store, "pay-1");
    eq(res.scenario, "FIRST_ACTIVATION", "scenario is FIRST_ACTIVATION (explicit)");
    eq(res.stacked, false, "first activation is not stacked");
    eq(res.needsSeat, true, "a seat is needed (group was null)");

    const subs = store.subscriptions.filter((s) => s.studentId === "stu-1");
    eq(subs.length, 1, "exactly ONE subscription row exists after approval (singleton, never a second row)");
    eq(subs[0].id, sub.id, "the EXISTING PENDING row was activated (same id)");
    eq(subs[0].status, "ACTIVE", "the same subscription is now ACTIVE");
    eq(subs[0].planId, "p1", "the requested plan is authoritative after approval");
    eq(subs[0].startDate.getTime(), NOW.getTime(), "startDate = approval now (fresh activation)");
    eq(subs[0].endDate.getTime(), TR.addMonths(NOW, 1).getTime(), "endDate = now + plan duration (1 month)");

    const student = store.students.find((s) => s.id === "stu-1");
    eq(student.groupId, "g1", "Student.groupId is assigned to the approved (requested) group");

    const payment = store.payments.find((p) => p.id === "pay-1");
    eq(payment.status, "APPROVED", "payment is APPROVED");
    eq(payment.reviewedAt.getTime(), NOW.getTime(), "reviewedAt = decision time");
    eq(payment.reviewedByUserId, admin, "reviewedByUserId = the deciding admin (from the session, never the body)");
    eq(payment.rejectionReason, null, "rejectionReason is null on approval");
    eq(payment.subscriptionId, sub.id, "payment is linked to the resulting subscription");

    const audits = store.auditLogs.filter((a) => a.action === "PAYMENT_APPROVED");
    eq(audits.length, 1, "exactly one PAYMENT_APPROVED audit row (inside the transaction)");
    const details = JSON.parse(audits[0].details);
    eq(audits[0].entityId, "pay-1", "audit carries the payment id");
    eq(audits[0].userId, admin, "audit carries the deciding admin");
    eq(details.studentId, "stu-1", "audit captures the student");
    eq(details.subscriptionId, sub.id, "audit captures the subscription");
    eq(details.scenario, "FIRST_ACTIVATION", "audit captures the scenario (decision type)");
    eq(details.prior.groupId, null, "audit captures the previous group (null)");
    eq(details.after.groupId, "g1", "audit captures the resulting group");

    const after = ENT.evaluateAccessDecision(
      { groupActive: true, subscription: { status: "ACTIVE", endDate: subs[0].endDate } },
      NOW
    );
    ok(after.allowed === true, "after approval: access TRUE");
    eq(res.accessNotification, "ACTIVATED", "truthful notification kind: ACTIVATED (access newly opens)");
    eq(res.payment.userId, "u-1", "the notification target is the payment's user (derived, not client-supplied)");
    eq(store.rawCalls.length, 0, "SQLite mode: NO advisory-lock SQL attempted");
    ok(
      store.writes.some((w) => w === "payment.update:pay-1") &&
        store.writes.some((w) => w.startsWith("subscription.update:")) &&
        store.writes.some((w) => w === "student.update:stu-1") &&
        store.writes.some((w) => w.startsWith("auditLog.create:")),
      "every business write happened (payment + subscription + student + audit)"
    );
  }

  // -------------------------------------------------------------------------
  section("4. B — APPROVAL: active renewal (startDate preserved, endDate STACKED)");
  // -------------------------------------------------------------------------
  {
    const store = freshStore();
    addStudent(store, "stu-2", "u-2", "g1");
    // startDate Jan 1, endDate Oct 1 2026 — unexpired at NOW (Sep 15 2026).
    const sub = addSub(store, "stu-2", "p1", "ACTIVE", d(2026, 1, 1), d(2026, 10, 1));
    addPayment(store, { id: "pay-2", userId: "u-2", subscriptionId: sub.id, requestedGroupId: "g2", requestedPlanId: "p2", createdAt: at("2026-09-15T10:30:00.000Z") });

    const before = ENT.evaluateAccessDecision(
      { groupActive: true, subscription: { status: "ACTIVE", endDate: d(2026, 10, 1) } },
      NOW
    );
    ok(before.allowed === true, "before approval: active renewal keeps access TRUE");

    const res = await approve(store, "pay-2");
    eq(res.scenario, "RENEWAL", "scenario is RENEWAL (explicit)");
    eq(res.stacked, true, "the extension is STACKED on the current endDate");

    const subs = store.subscriptions.filter((s) => s.studentId === "stu-2");
    eq(subs.length, 1, "the existing singleton was reused (no second row)");
    eq(subs[0].id, sub.id, "same subscription id before and after");
    eq(subs[0].status, "ACTIVE", "stays ACTIVE");
    eq(subs[0].planId, "p2", "the REQUESTED plan is applied only on approval");
    eq(subs[0].startDate.getTime(), d(2026, 1, 1).getTime(), "startDate remains the ORIGINAL entitlement start (never reset to now)");
    eq(subs[0].endDate.getTime(), d(2027, 1, 1).getTime(), "endDate = current endDate (Oct 1) + 3 months = Jan 1 2027 — NOT approval date + duration");
    ok(subs[0].endDate.getTime() !== TR.addMonths(NOW, 3).getTime(), "the result is provably NOT now+duration (the §33 'not Oct 15' rule)");

    const student = store.students.find((s) => s.id === "stu-2");
    eq(student.groupId, "g2", "the REQUESTED group is applied only on approval (same course)");
    eq(store.payments.find((p) => p.id === "pay-2").status, "APPROVED", "payment APPROVED");
    const after = ENT.evaluateAccessDecision(
      { groupActive: true, subscription: { status: "ACTIVE", endDate: subs[0].endDate } },
      NOW
    );
    ok(after.allowed === true, "access uninterrupted across the approval");
    eq(res.accessNotification, "RENEWED", "truthful notification kind: RENEWED (never 'course opened')");
  }

  // 1-month plan variant — the spec §33 example shape (base + 1 month).
  {
    const store = freshStore();
    addStudent(store, "stu-2b", "u-2b", "g1");
    addSub(store, "stu-2b", "p1", "ACTIVE", d(2026, 1, 1), d(2026, 10, 1));
    addPayment(store, { id: "pay-2b", userId: "u-2b", subscriptionId: "sub-1", requestedGroupId: "g1", requestedPlanId: "p1", createdAt: at("2026-09-15T10:30:00.000Z") });
    const res = await approve(store, "pay-2b");
    const subs = store.subscriptions.filter((s) => s.studentId === "stu-2b");
    eq(subs[0].endDate.getTime(), d(2026, 11, 1).getTime(), "§33: Oct 1 end + 1-month plan = Nov 1 (stacked on the current end, not the approval date)");
    eq(res.scenario, "RENEWAL", "1-month renewal is still RENEWAL");
  }

  // -------------------------------------------------------------------------
  section("5. B2 — same-group renewal approves even at capacity (no seat consumed)");
  // -------------------------------------------------------------------------
  {
    const store = freshStore();
    // g5 has capacity 2 and is FULL.
    addStudent(store, "stu-5a", "u-5a", "g5");
    addStudent(store, "stu-5b", "u-5b", "g5");
    const sub = addSub(store, "stu-5a", "p1", "ACTIVE", d(2026, 1, 1), d(2026, 10, 1));
    addPayment(store, { id: "pay-5a", userId: "u-5a", subscriptionId: sub.id, requestedGroupId: "g5", requestedPlanId: "p1", createdAt: at("2026-09-15T10:30:00.000Z") });

    const res = await approve(store, "pay-5a");
    eq(res.scenario, "RENEWAL", "same-group renewal is a RENEWAL");
    eq(res.needsSeat, false, "no seat change ⇒ no seat required");
    eq(store.payments.find((p) => p.id === "pay-5a").status, "APPROVED", "APPROVED even though the group is at capacity (2/2)");
    eq(store.students.filter((s) => s.groupId === "g5").length, 2, "member count unchanged (no phantom seat consumed)");
  }

  // -------------------------------------------------------------------------
  section("6. C — APPROVAL: legacy grandfathered (subscriptionId = null, no row)");
  // -------------------------------------------------------------------------
  {
    const store = freshStore();
    addStudent(store, "stu-3", "u-3", "g1"); // valid group, NO subscription
    addPayment(store, { id: "pay-3", userId: "u-3", subscriptionId: null, requestedGroupId: "g1", requestedPlanId: "p1", createdAt: at("2026-09-15T10:45:00.000Z") });

    const before = ENT.evaluateAccessDecision({ groupActive: true, subscription: null }, NOW);
    ok(before.allowed === true && before.grandfathered === true, "before: grandfathered access is TRUE (group, no row)");

    const res = await approve(store, "pay-3");
    eq(res.scenario, "GRANDFATHERED_ACTIVATION", "scenario is GRANDFATHERED_ACTIVATION (explicit)");
    eq(res.priorAccessAllowed, true, "prior access was allowed (truthful audit input)");
    eq(res.priorGrandfathered, true, "prior access was grandfathered");

    const subs = store.subscriptions.filter((s) => s.studentId === "stu-3");
    eq(subs.length, 1, "the singleton Subscription is CREATED on approval (no gap)");
    eq(subs[0].status, "ACTIVE", "created row is ACTIVE");
    eq(subs[0].planId, "p1", "approved plan set");
    eq(subs[0].startDate.getTime(), NOW.getTime(), "fresh paid activation: startDate = now");
    eq(subs[0].endDate.getTime(), TR.addMonths(NOW, 1).getTime(), "fresh paid activation: endDate = now + duration");

    const payment = store.payments.find((p) => p.id === "pay-3");
    eq(payment.status, "APPROVED", "payment APPROVED");
    eq(payment.subscriptionId, subs[0].id, "Payment.subscriptionId linked to the newly created singleton (was null)");

    const student = store.students.find((s) => s.id === "stu-3");
    eq(student.groupId, "g1", "group preserved (requested == current; no seat churn)");
    eq(res.needsSeat, false, "no seat consumed (already seated)");

    const after = ENT.evaluateAccessDecision(
      { groupActive: true, subscription: { status: "ACTIVE", endDate: subs[0].endDate } },
      NOW
    );
    ok(after.allowed === true, "access remains TRUE — the grandfathered access transitions cleanly into paid entitlement");
    eq(res.accessNotification, "CONFIRMED", "truthful notification kind: CONFIRMED (not 'course newly opened')");
  }

  // -------------------------------------------------------------------------
  section("7. C2 — legacy already-seated payment (no requestedGroupId → current group fallback)");
  // -------------------------------------------------------------------------
  {
    const store = freshStore();
    addStudent(store, "stu-4", "u-4", "g1"); // valid group, no row
    // Legacy row: the requested-group intent simply does not exist on it.
    addPayment(store, { id: "pay-4", userId: "u-4", subscriptionId: null, requestedGroupId: null, requestedPlanId: "p1", createdAt: at("2026-08-01T09:00:00.000Z") });
    const res = await approve(store, "pay-4");
    eq(res.scenario, "GRANDFATHERED_ACTIVATION", "fallback to the current group succeeds truthfully (plan resolvable)");
    eq(store.students.find((s) => s.id === "stu-4").groupId, "g1", "group unchanged via the fallback");
    eq(store.payments.find((p) => p.id === "pay-4").status, "APPROVED", "APPROVED (no false failure for legacy data)");
    eq(res.accessNotification, "CONFIRMED", "notification is 'confirmed/valid' — never 'seat newly opened'");
  }

  // -------------------------------------------------------------------------
  section("8. D — REJECTION (reason, preservation, coupon)");
  // -------------------------------------------------------------------------
  {
    const store0 = () => {
      const s = freshStore();
      addStudent(s, "stu-0", "u-0", null);
      addPayment(s, { id: "pay-x", userId: "u-0" });
      return s;
    };
    await expectCode(reject(store0(), "pay-x", ""), "INVALID_REJECTION_REASON", "D1 empty reason");
    await expectCode(reject(store0(), "pay-x", "    "), "INVALID_REJECTION_REASON", "D2 whitespace-only reason");
    await expectCode(reject(store0(), "pay-x", "x".repeat(501)), "INVALID_REJECTION_REASON", "D3 over-500-char reason");
  }
  {
    // D5 — new student rejection: no entitlement may accidentally become ACTIVE.
    const store = freshStore();
    addStudent(store, "stu-6", "u-6", null);
    const sub = addSub(store, "stu-6", "p1", "PENDING", null, null);
    addPayment(store, { id: "pay-6", userId: "u-6", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: "p1" });
    const writesBefore = store.writes.length;
    const res = await reject(store, "pay-6", "  Reference   mismatch  ");
    eq(res.payment.status, "REJECTED", "PENDING → REJECTED");
    eq(res.payment.rejectionReason, "Reference mismatch", "reason normalized (trim + collapse) and stored");
    eq(res.payment.reviewedAt.getTime(), NOW.getTime(), "reviewedAt written on rejection");
    eq(res.payment.reviewedByUserId, admin, "reviewedByUserId = the deciding admin");
    eq(store.subscriptions.find((s) => s.id === sub.id).status, "PENDING", "the subscription stays PENDING (never accidentally ACTIVE)");
    eq(store.students.find((s) => s.id === "stu-6").groupId, null, "no group is assigned by a rejection");
    const after = ENT.evaluateAccessDecision({ groupActive: false, subscription: { status: "PENDING", endDate: null } }, NOW);
    ok(after.allowed === false, "access remains FALSE for the rejected new student");
    ok(!store.writes.slice(writesBefore).some((w) => w.startsWith("subscription.") || w.startsWith("student.")), "NO subscription/student mutation on rejection");
    const audit = store.auditLogs.find((a) => a.action === "PAYMENT_REJECTED");
    ok(audit && JSON.parse(audit.details).reason === "Reference mismatch", "rejection audit captures admin + payment + reason");
    eq(res.couponReleased, false, "no coupon was consumed ⇒ couponReleased false");
  }
  {
    // D6 — active renewal rejection preserves the live entitlement byte-for-byte.
    const store = freshStore();
    addStudent(store, "stu-7", "u-7", "g1");
    const sub = addSub(store, "stu-7", "p1", "ACTIVE", d(2026, 1, 1), d(2026, 10, 1));
    addPayment(store, { id: "pay-7", userId: "u-7", subscriptionId: sub.id, requestedGroupId: "g2", requestedPlanId: "p2" });
    await reject(store, "pay-7", "Bank reference does not match");
    const row = store.subscriptions.find((s) => s.id === sub.id);
    eq(row.status, "ACTIVE", "live entitlement stays ACTIVE after rejection");
    eq(row.planId, "p1", "current plan untouched");
    eq(row.startDate.getTime(), d(2026, 1, 1).getTime(), "startDate untouched");
    eq(row.endDate.getTime(), d(2026, 10, 1).getTime(), "endDate untouched (no rollback of paid time)");
    eq(store.students.find((s) => s.id === "stu-7").groupId, "g1", "group untouched");
    const after = ENT.evaluateAccessDecision({ groupActive: true, subscription: { status: "ACTIVE", endDate: row.endDate } }, NOW);
    ok(after.allowed === true, "access remains TRUE after a rejected renewal");
  }
  {
    // D7 — grandfathered rejection: still no Subscription row, access intact.
    const store = freshStore();
    addStudent(store, "stu-8", "u-8", "g1");
    addPayment(store, { id: "pay-8", userId: "u-8", subscriptionId: null, requestedGroupId: "g1", requestedPlanId: "p1" });
    await reject(store, "pay-8", "Amount does not match the plan");
    eq(store.subscriptions.filter((s) => s.studentId === "stu-8").length, 0, "rejection NEVER manufactures a Subscription row");
    eq(store.students.find((s) => s.id === "stu-8").groupId, "g1", "group untouched");
    const after = ENT.evaluateAccessDecision({ groupActive: true, subscription: null }, NOW);
    ok(after.allowed === true && after.grandfathered === true, "grandfathered access remains TRUE after rejection");
  }
  {
    // D8/D9 — coupon release (atomic with rejection; idempotent under repeats).
    const store = freshStore();
    addStudent(store, "stu-9", "u-9", null);
    const sub = addSub(store, "stu-9", "p1", "PENDING", null, null);
    addPayment(store, { id: "pay-9", userId: "u-9", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: "p1" });
    store.coupons.push({ id: "c1", code: "SAVE10", usedCount: 1, maxUses: 10, isActive: true });
    store.redemptions.push({ id: "r1", couponId: "c1", userId: "u-9", paymentId: "pay-9" });

    const res = await reject(store, "pay-9", "Duplicate payment");
    eq(res.couponReleased, true, "the submission-time coupon consumption is released on rejection");
    eq(store.redemptions.filter((r) => r.paymentId === "pay-9").length, 0, "the redemption row is deleted (the user may reuse the coupon — no double-use)");
    eq(store.coupons.find((c) => c.id === "c1").usedCount, 0, "coupon usedCount decremented back");

    await expectCode(reject(store, "pay-9", "again"), "INVALID_TRANSITION", "D8b rejecting the already-rejected payment is a forbidden transition");
    eq(store.coupons.find((c) => c.id === "c1").usedCount, 0, "the forbidden repeat did NOT release the coupon a second time (idempotent)");
  }

  // -------------------------------------------------------------------------
  section("9. E — INVALID TRANSITIONS (never silently succeed)");
  // -------------------------------------------------------------------------
  {
    const store = freshStore();
    addStudent(store, "stu-e", "u-e", null);
    const sub = addSub(store, "stu-e", "p1", "PENDING", null, null);
    addPayment(store, { id: "pay-appr", userId: "u-e", subscriptionId: sub.id, status: "APPROVED", reviewedAt: at("2026-09-01T10:00:00.000Z"), reviewedByUserId: "admin-0" });
    addPayment(store, { id: "pay-rej", userId: "u-e", status: "REJECTED", rejectionReason: "old", reviewedAt: at("2026-09-01T10:00:00.000Z"), reviewedByUserId: "admin-0" });
    addPayment(store, { id: "pay-exp", userId: "u-e", status: "EXPIRED" });

    await expectCode(approve(store, "pay-appr"), "INVALID_TRANSITION", "APPROVED cannot be approved again");
    await expectCode(reject(store, "pay-appr", "nope"), "INVALID_TRANSITION", "APPROVED cannot be rejected");
    await expectCode(approve(store, "pay-rej"), "INVALID_TRANSITION", "REJECTED cannot be approved");
    await expectCode(reject(store, "pay-rej", "nope"), "INVALID_TRANSITION", "REJECTED cannot be rejected again");
    await expectCode(approve(store, "pay-exp"), "INVALID_TRANSITION", "EXPIRED cannot be approved");
    await expectCode(reject(store, "pay-exp", "nope"), "INVALID_TRANSITION", "EXPIRED cannot be rejected");

    eq(store.payments.find((p) => p.id === "pay-appr").status, "APPROVED", "the APPROVED row is untouched by the forbidden attempts");
    eq(store.payments.find((p) => p.id === "pay-rej").rejectionReason, "old", "the REJECTED row's reason is untouched (no overwrite)");
    ok(!store.auditLogs.length, "no audit rows for forbidden transitions");
    eq(store.writes.length, 0, "ZERO writes for forbidden transitions");
    await expectCode(approve(store, "ghost"), "PAYMENT_NOT_FOUND", "unknown payment id → PAYMENT_NOT_FOUND (approve)");
    await expectCode(reject(store, "ghost", "r"), "PAYMENT_NOT_FOUND", "unknown payment id → PAYMENT_NOT_FOUND (reject)");
  }

  // -------------------------------------------------------------------------
  section("10. F — STALE PENDING PAYMENT PROTECTION");
  // -------------------------------------------------------------------------
  {
    // F1 — older PENDING blocked while a newer PENDING exists; newest wins.
    const store = freshStore();
    addStudent(store, "stu-f", "u-f", null);
    const sub = addSub(store, "stu-f", "p1", "PENDING", null, null);
    const p1 = addPayment(store, { id: "pay-f1", userId: "u-f", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: "p1", createdAt: at("2026-09-15T10:00:00.000Z") });
    addPayment(store, { id: "pay-f2", userId: "u-f", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: "p2", createdAt: at("2026-09-15T11:00:00.000Z") });

    const writesBefore = store.writes.length;
    await expectCode(approve(store, "pay-f1"), "STALE_PAYMENT", "approving the OLDER pending request is refused (newer exists)");
    eq(store.writes.length, writesBefore, "STALE_PAYMENT mutates NOTHING (no review fields, no entitlement)");
    eq(p1.status, "PENDING", "the stale request stays PENDING (history preserved, not destroyed)");
    eq(store.subscriptions.find((s) => s.id === sub.id).status, "PENDING", "subscription untouched by the stale attempt");
    eq(store.payments.find((x) => x.id === "pay-f1").reviewedAt, null, "no reviewer fields on a refused stale attempt");

    const res = await approve(store, "pay-f2");
    eq(res.scenario, "FIRST_ACTIVATION", "the NEWEST pending request approves successfully");
    eq(store.subscriptions.find((s) => s.id === sub.id).planId, "p2", "the newest request's intent (p2) is what becomes authoritative");
    eq(p1.status, "PENDING", "the older request is left PENDING — the newer one is authoritative; nothing auto-rejected");
  }
  {
    // F2 — equal createdAt: id DESC tie-break (deterministic, consistent with
    // PR2a's newest-first reader `[{createdAt:"desc"},{id:"desc"}]`).
    const store = freshStore();
    addStudent(store, "stu-fb", "u-fb", null);
    const sub = addSub(store, "stu-fb", "p1", "PENDING", null, null);
    const T = at("2026-09-15T10:00:00.000Z");
    addPayment(store, { id: "pay-fb-a", userId: "u-fb", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: "p1", createdAt: T });
    addPayment(store, { id: "pay-fb-b", userId: "u-fb", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: "p2", createdAt: T });

    await expectCode(approve(store, "pay-fb-a"), "STALE_PAYMENT", "tie-break: with equal createdAt the LOWER id is stale (pay-fb-b > pay-fb-a)");
    const res = await approve(store, "pay-fb-b");
    eq(res.scenario, "FIRST_ACTIVATION", "tie-break: the HIGHER id approves (deterministic, id DESC)");
    eq(store.subscriptions.find((s) => s.id === sub.id).planId, "p2", "the tie-break winner's intent wins");
  }
  {
    // F3 — a newer REJECTED (or APPROVED) row does NOT stale the pending one:
    // only PENDING requests supersede.
    const store = freshStore();
    addStudent(store, "stu-fc", "u-fc", null);
    const sub = addSub(store, "stu-fc", "p1", "PENDING", null, null);
    addPayment(store, { id: "pay-fc-old", userId: "u-fc", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: "p1", createdAt: at("2026-09-14T10:00:00.000Z") });
    addPayment(store, { id: "pay-fc-new", userId: "u-fc", status: "REJECTED", rejectionReason: "x", reviewedAt: at("2026-09-15T09:00:00.000Z"), createdAt: at("2026-09-15T09:00:00.000Z") });
    const res = await approve(store, "pay-fc-old");
    eq(res.scenario, "FIRST_ACTIVATION", "a newer DECIDED row does not stale the pending request");
  }

  // -------------------------------------------------------------------------
  section("11. G — GROUP / PLAN RESOLUTION (no false approvals for legacy data)");
  // -------------------------------------------------------------------------
  {
    const s = freshStore();
    addStudent(s, "stu-g1", "u-g1", null);
    addSub(s, "stu-g1", "p1", "PENDING", null, null);
    addPayment(s, { id: "pay-g1", userId: "u-g1", subscriptionId: "sub-1", requestedGroupId: null, requestedPlanId: "p1" });
    await expectCode(approve(s, "pay-g1"), "GROUP_REQUIRED", "G1 no requested group + no current group → GROUP_REQUIRED (fail safe, no fake intent)");
    eq(s.payments.find((p) => p.id === "pay-g1").status, "PENDING", "the payment stays PENDING for admin to fix the context and retry");
    eq(s.subscriptions.find((x) => x.studentId === "stu-g1").status, "PENDING", "no entitlement mutation on GROUP_REQUIRED");
  }
  {
    const s = freshStore();
    addStudent(s, "stu-g2", "u-g2", "g1"); // grandfathered, no row
    addPayment(s, { id: "pay-g2", userId: "u-g2", subscriptionId: null, requestedGroupId: "g1", requestedPlanId: null });
    await expectCode(approve(s, "pay-g2"), "PLAN_REQUIRED", "G2 legacy row without plan intent + no valid current plan → PLAN_REQUIRED");
    eq(s.subscriptions.filter((x) => x.studentId === "stu-g2").length, 0, "no false activation on PLAN_REQUIRED (no row manufactured)");
  }
  {
    const s = freshStore();
    addStudent(s, "stu-g3", "u-g3", null);
    addSub(s, "stu-g3", "p1", "PENDING", null, null);
    addPayment(s, { id: "pay-g3", userId: "u-g3", subscriptionId: "sub-1", requestedGroupId: "ghost-group", requestedPlanId: "p1" });
    await expectCode(approve(s, "pay-g3"), "GROUP_NOT_FOUND", "G3 dangling requested group id → GROUP_NOT_FOUND");
    addPayment(s, { id: "pay-g3b", userId: "u-g3", subscriptionId: "sub-1", requestedGroupId: "g4", requestedPlanId: "p1", createdAt: at("2026-09-15T11:30:00.000Z") });
    await expectCode(approve(s, "pay-g3b"), "GROUP_NOT_FOUND", "G4 inactive requested group → GROUP_NOT_FOUND (never a seat in a dead group)");
  }
  {
    const s = freshStore();
    addStudent(s, "stu-g4", "u-g4", "g1"); // course c1
    addPayment(s, { id: "pay-g4", userId: "u-g4", subscriptionId: null, requestedGroupId: "g3", requestedPlanId: "p1" }); // g3 = course c2
    await expectCode(approve(s, "pay-g4"), "INVALID_GROUP_CONTEXT", "G5 requested group of a DIFFERENT course → INVALID_GROUP_CONTEXT");
  }
  {
    const s = freshStore();
    addStudent(s, "stu-g5", "u-g5", "g1"); // course c1
    addPayment(s, { id: "pay-g5", userId: "u-g5", subscriptionId: null, requestedGroupId: "g1", requestedPlanId: "p1" });
    await expectCode(approve(s, "pay-g5", { overrideGroupId: "g3" }), "INVALID_GROUP_CONTEXT", "G6 admin override into a foreign course → INVALID_GROUP_CONTEXT (the override is fully validated)");
  }
  {
    // G7 — the override IS the GROUP_REQUIRED recovery path (spec §21).
    const s = freshStore();
    addStudent(s, "stu-g6", "u-g6", null);
    addSub(s, "stu-g6", "p1", "PENDING", null, null);
    addPayment(s, { id: "pay-g6", userId: "u-g6", subscriptionId: "sub-1", requestedGroupId: null, requestedPlanId: "p1" });
    await expectCode(approve(s, "pay-g6"), "GROUP_REQUIRED", "G7a without override → GROUP_REQUIRED");
    const res = await approve(s, "pay-g6", { overrideGroupId: "g1" });
    eq(res.needsSeat, true, "G7b override g1 assigns the seat");
    eq(s.students.find((x) => x.id === "stu-g6").groupId, "g1", "G7c the student is seated in the override group");
    eq(s.payments.find((p) => p.id === "pay-g6").status, "APPROVED", "G7d the payment approves through the recovered context");
  }
  {
    const s = freshStore();
    addStudent(s, "stu-g7", "u-g7", null);
    addSub(s, "stu-g7", "p1", "PENDING", null, null);
    addPayment(s, { id: "pay-g7", userId: "u-g7", subscriptionId: "sub-1", requestedGroupId: "g1", requestedPlanId: "ghost-plan" });
    await expectCode(approve(s, "pay-g7"), "PLAN_NOT_FOUND", "G8a dangling plan id → PLAN_NOT_FOUND");
    addPayment(s, { id: "pay-g7b", userId: "u-g7", subscriptionId: "sub-1", requestedGroupId: "g1", requestedPlanId: "p3", createdAt: at("2026-09-15T11:30:00.000Z") });
    await expectCode(approve(s, "pay-g7b"), "PLAN_NOT_FOUND", "G8b inactive plan → PLAN_NOT_FOUND (never approve with an unusable plan)");
  }
  {
    // G9 — the unambiguous current-plan fallback (only while the current
    // entitlement is valid).
    const s = freshStore();
    addStudent(s, "stu-g8", "u-g8", "g1");
    const sub = addSub(s, "stu-g8", "p1", "ACTIVE", d(2026, 1, 1), d(2026, 10, 1));
    addPayment(s, { id: "pay-g8", userId: "u-g8", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: null });
    const res = await approve(s, "pay-g8");
    eq(res.scenario, "RENEWAL", "G9a legacy row without plan intent + valid current plan → unambiguous RENEWAL");
    eq(s.subscriptions.find((x) => x.id === sub.id).planId, "p1", "G9b the CURRENT plan is the truthful fallback");
    const s2 = freshStore();
    addStudent(s2, "stu-g9", "u-g9", "g1");
    const sub2 = addSub(s2, "stu-g9", "p1", "ACTIVE", d(2025, 1, 1), d(2025, 10, 1)); // lazily EXPIRED
    addPayment(s2, { id: "pay-g9", userId: "u-g9", subscriptionId: sub2.id, requestedGroupId: "g1", requestedPlanId: null });
    await expectCode(approve(s2, "pay-g9"), "PLAN_REQUIRED", "G10 current plan fallback REFUSED when the current entitlement is not valid (expired ⇒ ambiguous)");
  }
  {
    const s = freshStore();
    addPayment(s, { id: "pay-g10", userId: "u-nostudent", requestedGroupId: "g1", requestedPlanId: "p1" });
    await expectCode(approve(s, "pay-g10"), "NO_STUDENT", "G11 payment user without a Student row → NO_STUDENT (approval never creates a student)");
    eq(s.students.length, 0, "no student row was created");
  }

  // -------------------------------------------------------------------------
  section("12. H — CAPACITY at approval (pre-check is advisory only)");
  // -------------------------------------------------------------------------
  {
    const store = freshStore();
    addStudent(store, "stu-h1", "u-h1", "g5");
    addStudent(store, "stu-h2", "u-h2", "g5"); // g5 capacity 2 → FULL
    addStudent(store, "stu-h3", "u-h3", null); // wants the impossible 3rd seat
    const sub = addSub(store, "stu-h3", "p1", "PENDING", null, null);
    addPayment(store, { id: "pay-h3", userId: "u-h3", subscriptionId: sub.id, requestedGroupId: "g5", requestedPlanId: "p1" });

    const writesBefore = store.writes.length;
    await expectCode(approve(store, "pay-h3"), "GROUP_FULL", "full group → GROUP_FULL (capacity enforced at APPROVAL, not only submission)");
    eq(store.payments.find((p) => p.id === "pay-h3").status, "PENDING", "the payment remains PENDING after GROUP_FULL");
    eq(store.payments.find((p) => p.id === "pay-h3").reviewedAt, null, "no review fields on GROUP_FULL");
    eq(store.payments.find((p) => p.id === "pay-h3").reviewedByUserId, null, "no reviewer on GROUP_FULL");
    eq(store.subscriptions.find((s) => s.id === sub.id).status, "PENDING", "no Subscription mutation on GROUP_FULL");
    eq(store.students.find((s) => s.id === "stu-h3").groupId, null, "no group mutation on GROUP_FULL");
    eq(store.auditLogs.filter((a) => a.action === "PAYMENT_APPROVED").length, 0, "no 'approved' audit event on GROUP_FULL");
    eq(store.writes.length, writesBefore, "GROUP_FULL produces ZERO writes (no partial state)");
  }

  // -------------------------------------------------------------------------
  section("13. 14 — EXPIRED / INACTIVE entitlement reactivation (explicit scenario)");
  // -------------------------------------------------------------------------
  {
    const store = freshStore();
    addStudent(store, "stu-r", "u-r", "g1");
    // Stored ACTIVE but lazily expired (endDate in the past).
    const sub = addSub(store, "stu-r", "p1", "ACTIVE", d(2025, 1, 1), d(2025, 10, 1));
    addPayment(store, { id: "pay-r", userId: "u-r", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: "p4" });
    const res = await approve(store, "pay-r");
    eq(res.scenario, "REACTIVATION", "expired/inactive row reactivation is REACTIVATION (explicit — distinct from RENEWAL)");
    eq(res.stacked, false, "reactivation does NOT stack on a past endDate");
    const row = store.subscriptions.find((s) => s.id === sub.id);
    eq(row.status, "ACTIVE", "the singleton is re-activated (reused, not recreated)");
    eq(row.startDate.getTime(), NOW.getTime(), "fresh activation base = now");
    eq(row.endDate.getTime(), TR.addMonths(NOW, 2).getTime(), "endDate = now + approved plan duration (2 months)");
    eq(row.planId, "p4", "approved plan applied");
    eq(res.accessNotification, "ACTIVATED", "access was closed before ⇒ ACTIVATED (truthful)");
    const c = freshStore();
    addStudent(c, "stu-c", "u-c", "g1");
    const subC = addSub(c, "stu-c", "p1", "CANCELLED", d(2025, 1, 1), d(2025, 10, 1));
    addPayment(c, { id: "pay-c", userId: "u-c", subscriptionId: subC.id, requestedGroupId: "g1", requestedPlanId: "p1" });
    const resC = await approve(c, "pay-c");
    eq(resC.scenario, "REACTIVATION", "stored CANCELLED also reactivates (invalid entitlement, single row)");
    eq(c.subscriptions.length, 1, "still exactly one row (singleton)");
  }

  // -------------------------------------------------------------------------
  section("14. J — post-commit side effects (failure-tolerant, fixed order)");
  // -------------------------------------------------------------------------
  {
    const order = [];
    const warnings = await TR.runApprovalPostCommitEffects({
      studentId: "stu-1",
      reconcile: async (sid) => {
        order.push(`reconcile:${sid}`);
      },
      notify: async () => {
        order.push("notify");
      },
    });
    eq(order, ["reconcile:stu-1", "notify"], "fixed order: reconciliation first, then notification");
    eq(warnings, [], "no warnings when both succeed");
  }
  {
    const warnings = await TR.runApprovalPostCommitEffects({
      studentId: "stu-1",
      reconcile: async () => {
        throw new Error("reconcile boom");
      },
      notify: async () => "sent",
    });
    eq(warnings, ["reconciliation_failed"], "reconciliation failure → warning, never an exception");
  }
  {
    const order = [];
    const warnings = await TR.runApprovalPostCommitEffects({
      studentId: "stu-1",
      reconcile: async () => {
        order.push("reconcile");
        throw new Error("boom");
      },
      notify: async () => {
        order.push("notify");
        throw new Error("boom");
      },
    });
    eq(order, ["reconcile", "notify"], "a failed reconciliation still runs the notification (each step independent)");
    eq(warnings, ["reconciliation_failed", "notification_failed"], "both failures are reported as warnings");
  }
  {
    const warnings = await TR.runApprovalPostCommitEffects({
      studentId: "stu-1",
      reconcile: async () => {},
      notify: async () => {
        throw new Error("smtp down");
      },
    });
    eq(warnings, ["notification_failed"], "notification failure alone → warning (the committed approval is never rolled back)");
  }

  // -------------------------------------------------------------------------
  section("15. K — ATOMICITY: a failed write rolls back EVERYTHING");
  // -------------------------------------------------------------------------
  {
    const store = freshStore();
    addStudent(store, "stu-k1", "u-k1", null);
    const sub = addSub(store, "stu-k1", "p1", "PENDING", null, null);
    addPayment(store, { id: "pay-k1", userId: "u-k1", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: "p1" });
    const before = clone({
      payments: store.payments,
      students: store.students,
      subscriptions: store.subscriptions,
      auditLogs: store.auditLogs,
    });
    store.faults["auditLog.create"] = new Error("audit storage down");
    let threw = false;
    try {
      await approve(store, "pay-k1");
    } catch (e) {
      threw = e instanceof Error && /audit storage down/.test(e.message);
    }
    ok(threw, "a failed audit write aborts the decision (audit is a critical step)");
    eq(clone({ payments: store.payments, students: store.students, subscriptions: store.subscriptions, auditLogs: store.auditLogs }), before, "NONE of the business writes committed (payment/subscription/student/audit all rolled back)");
    eq(store.payments.find((p) => p.id === "pay-k1").status, "PENDING", "the payment is still PENDING after the rolled-back attempt");
    eq(store.subscriptions.find((s) => s.id === sub.id).status, "PENDING", "the subscription is still PENDING (no partial activation)");
    eq(store.students.find((s) => s.id === "stu-k1").groupId, null, "the student was not seated (no partial group write)");
  }
  {
    const store = freshStore();
    addStudent(store, "stu-k2", "u-k2", "g1");
    const sub = addSub(store, "stu-k2", "p1", "ACTIVE", d(2026, 1, 1), d(2026, 10, 1));
    addPayment(store, { id: "pay-k2", userId: "u-k2", subscriptionId: sub.id, requestedGroupId: "g2", requestedPlanId: "p2" });
    store.faults["subscription.update"] = new Error("db gone mid-tx");
    let raw = null;
    try {
      await approve(store, "pay-k2");
    } catch (e) {
      raw = e;
    }
    ok(raw && /db gone mid-tx/.test(raw.message), "a mid-transaction DB error propagates (the route maps it — no fake success)");
    eq(store.payments.find((p) => p.id === "pay-k2").status, "PENDING", "the payment is still PENDING (rolled back)");
    eq(store.subscriptions.find((s) => s.id === sub.id).endDate.getTime(), d(2026, 10, 1).getTime(), "the live entitlement is byte-for-byte unchanged (rolled back)");
  }
  {
    const store = freshStore();
    addStudent(store, "stu-k3", "u-k3", null);
    addPayment(store, { id: "pay-k3", userId: "u-k3" });
    store.coupons.push({ id: "c1", code: "X", usedCount: 1, maxUses: 5, isActive: true });
    store.redemptions.push({ id: "r1", couponId: "c1", userId: "u-k3", paymentId: "pay-k3" });
    store.faults["couponRedemption.delete"] = new Error("coupon store down");
    let raw = null;
    try {
      await reject(store, "pay-k3", "reason");
    } catch (e) {
      raw = e;
    }
    ok(raw && /coupon store down/.test(raw.message), "a failed coupon release aborts the REJECTION (atomic with it)");
    eq(store.payments.find((p) => p.id === "pay-k3").status, "PENDING", "the payment is still PENDING (the rejection rolled back)");
    eq(store.redemptions.length, 1, "the redemption is still present (nothing half-released)");
    eq(store.coupons.find((c) => c.id === "c1").usedCount, 1, "usedCount unchanged");
  }

  // -------------------------------------------------------------------------
  section("16. Reviewer-field truthfulness across decision outcomes");
  // -------------------------------------------------------------------------
  {
    const store = freshStore();
    addStudent(store, "stu-t", "u-t", null);
    const sub = addSub(store, "stu-t", "p1", "PENDING", null, null);
    addPayment(store, { id: "pay-t-stale", userId: "u-t", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: "p1", createdAt: at("2026-09-15T10:00:00.000Z") });
    addPayment(store, { id: "pay-t-new", userId: "u-t", subscriptionId: sub.id, requestedGroupId: "g1", requestedPlanId: "p1", createdAt: at("2026-09-15T11:00:00.000Z") });
    addStudent(store, "stu-t2", "u-t2", null);
    const sub2 = addSub(store, "stu-t2", "p1", "PENDING", null, null);
    addPayment(store, { id: "pay-t-full", userId: "u-t2", subscriptionId: sub2.id, requestedGroupId: "g5", requestedPlanId: "p1" });
    addStudent(store, "stu-h1", "u-h1", "g5");
    addStudent(store, "stu-h2", "u-h2", "g5"); // g5 full

    await expectCode(approve(store, "pay-t-stale"), "STALE_PAYMENT", "stale attempt");
    await expectCode(approve(store, "pay-t-full"), "GROUP_FULL", "full attempt");
    const stale = store.payments.find((p) => p.id === "pay-t-stale");
    const full = store.payments.find((p) => p.id === "pay-t-full");
    for (const [name, p] of [["STALE_PAYMENT", stale], ["GROUP_FULL", full]]) {
      eq(p.status, "PENDING", `${name}: status untouched`);
      eq(p.reviewedAt, null, `${name}: reviewedAt NOT written`);
      eq(p.reviewedByUserId, null, `${name}: reviewedByUserId NOT written`);
      eq(p.rejectionReason, null, `${name}: rejectionReason NOT written`);
    }
    await approve(store, "pay-t-new");
    const won = store.payments.find((p) => p.id === "pay-t-new");
    eq(won.reviewedAt.getTime(), NOW.getTime(), "successful decision: reviewedAt written");
    eq(won.reviewedByUserId, admin, "successful decision: reviewedByUserId written");
  }

  // -------------------------------------------------------------------------
  section("17. i18n — every new key resolves in BOTH locales (no raw key leak)");
  // -------------------------------------------------------------------------
  {
    const keys = [
      "api.269", "api.270", "api.271", "api.272", "api.273", "api.274",
      "api.275", "api.276", "api.277", "api.278", "api.279", "api.280",
      "api.281", "api.282", "api.283", "api.284",
    ];
    for (const key of keys) {
      for (const loc of ["ar", "en"]) {
        const s = I18N.translate(loc, key);
        ok(typeof s === "string" && s.length > 0 && s !== key, `${key} resolves in ${loc} (no raw key, non-empty)`);
      }
    }
    ok(
      Object.values(TR.TRANSITION_ERROR_I18N_KEY).every((k) => I18N.hasDictKey(k)),
      "every domain error code maps to an EXISTING i18n key"
    );
    eq(I18N.translate("en", "api.281", { p1: "31/10/2026" }), "Your subscription was renewed — valid until 31/10/2026", "renewal message interpolates the valid-until date (en)");
  }

  // -------------------------------------------------------------------------
  section("18. Lock-helper behavior (shared serialization primitive)");
  // -------------------------------------------------------------------------
  {
    eq(SER.groupSeatLockId("g1"), SER.groupSeatLockId("g1"), "group seat lock id is deterministic");
    ok(SER.groupSeatLockId("g1") !== SER.groupSeatLockId("g2"), "different groups → different lock ids");
    ok(typeof SER.groupSeatLockId("g1") === "bigint", "lock id is a bigint (pg_advisory_xact_lock int8)");
    ok(SER.groupSeatLockId("g1") < (1n << 63n), "lock id fits PostgreSQL's signed 63-bit bigint");
    ok(SER.groupSeatLockId("g1") !== SER.uploadFinalizeLockId("g1"), "NAMESPACED: the group-seat lock can never collide with the upload-finalize lock for the same string");
    // SQLite mode: the helper is a deliberate no-op — nothing is attempted.
    const calls = [];
    const fakeTx = { $executeRaw: async (strings) => calls.push(strings.join("?")) };
    await SER.acquireGroupSeatLock(fakeTx, "g1", "sqlite");
    eq(calls.length, 0, "acquireGroupSeatLock is a NO-OP on SQLite (no PG dependency locally)");
    // PG mode: the tagged-template call with the deterministic bigint key.
    await SER.acquireGroupSeatLock(fakeTx, "g1", "postgresql");
    eq(calls.length, 1, "acquireGroupSeatLock issues exactly one raw call on PostgreSQL");
    ok(calls[0].startsWith("SELECT pg_advisory_xact_lock("), "the raw call is the transaction-scoped advisory lock");
    // A tx without raw support (some fakes) skips gracefully.
    await SER.acquireGroupSeatLock({}, "g1", "postgresql");
    ok(true, "no $executeRaw surface → graceful skip (the in-transaction re-read still guards)");
    // Upload finalization lock behavior is byte-identical (Phase 23 contract).
    const calls2 = [];
    await SER.acquireUploadFinalizeLock({ $executeRaw: async (strings) => calls2.push(strings.join("?")) }, "session-videos/a.mp4", "postgresql");
    ok(calls2[0].startsWith("SELECT pg_advisory_xact_lock("), "Phase 23 upload-finalize lock SQL unchanged");
  }

  // -------------------------------------------------------------------------
  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `${fail === 0 ? "PASS" : "FAIL"} — payment-lifecycle-phase25-pr2b: ${pass} assertions passed, ${fail} failed`
  );
  if (fail > 0) {
    console.log("\nFailed:");
    for (const f of failures) console.log("  ✗", f);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exitCode = 1;
});
