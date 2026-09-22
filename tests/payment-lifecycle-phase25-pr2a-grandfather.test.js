// CodeMind Academy — Phase 25 PR2a: LEGACY GRANDFATHERING ACROSS SUBMISSION.
//
// THE SCENARIO (audit request, 2026-09-14):
//   A legacy student has Student.groupId pointing at a valid ACTIVE group
//   bound to a course and NO Subscription row. Access exists ONLY because of
//   the Phase 25 grandfather rule. The student now submits a manual payment
//   request through the PR2a submission path. What happens on the NEXT
//   authorization read?
//
//   The Phase 25 requirement under test: submitting a payment/renewal request
//   must never LOCK OUT a legitimately-accessible legacy student. Because a
//   Subscription row, once it exists, is AUTHORITATIVE (PENDING ⇒ deny), the
//   only architecture-consistent way to satisfy this at submission time is to
//   NOT CREATE a Subscription row for a grandfathered student: the request is
//   recorded on the Payment alone, and row creation/activation is PR2b's job
//   on approval.
//
// This test is BEHAVIOURAL: the shipped TypeScript modules are compiled with
// tsc and exercised (same pattern as payment-lifecycle-phase25-pr2a.test.js).
// One mutable in-memory store backs BOTH sides:
//   * the submission core runs through its injected `db` and really writes
//     (or does not) to the store, and
//   * getEnrollment / canAccessLesson / getUnlockedLessonIds /
//     resolveStudentEntitlement read the SAME store through the module-level
//     `@/lib/db` fake — so "after submit" is the true post-effect state, not a
//     hand-written fixture.
// The authorization fake still throws on ANY mutation, so the store proves
// the authz path never writes even in this flow.
//
// RUN: node tests/payment-lifecycle-phase25-pr2a-grandfather.test.js
// EXIT: 0 = contract holds; 1 = the requirement assertions failed.
//
// STATUS: the fix is implemented (LEGACY_GRANDFATHERED submission path), so
// this file is the permanent GREEN regression pin for the audit contract — it
// was written red-first against the pre-fix tree, where REQ-* fail and the
// store observably shows a manufactured PENDING row revoking legacy access.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const { execSync } = require("child_process");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const ts = require(path.join(__dirname, "..", "node_modules/typescript/lib/typescript.js"));

const REPO = path.join(__dirname, "..");

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
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// Compile the shipped modules under test (identical list/flags to the main
// PR2a suite so both exercise the same emitted code).
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p25grand-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      strict: false,
      skipLibCheck: true,
      esModuleInterop: true,
      types: ["node"],
      typeRoots: [path.join(REPO, "node_modules/@types")],
      baseUrl: REPO,
      paths: { "@/*": ["src/*"] },
      outDir: OUT,
    },
    files: [
      path.join(REPO, "src/lib/subscription-entitlement.ts"),
      path.join(REPO, "src/lib/payment-submission.ts"),
      path.join(REPO, "src/lib/enrollment.ts"),
      path.join(REPO, "src/lib/session-progress.ts"),
      path.join(REPO, "src/lib/progress.ts"),
      path.join(REPO, "src/lib/session-lifecycle.ts"),
      path.join(REPO, "src/lib/track-scope.ts"),
      path.join(REPO, "src/lib/school-type.ts"),
      path.join(REPO, "src/lib/registration.ts"),
    ],
  })
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch {
  /* fall through: check the emitted files instead (repo harness convention) */
}
for (const f of ["subscription-entitlement.js", "payment-submission.js", "enrollment.js", "session-progress.js"]) {
  if (!fs.existsSync(path.join(OUT, f))) throw new Error(`tsc did not emit ${f}`);
}

// ---------------------------------------------------------------------------
// THE SHARED STORE — one source of truth for submission writes + authz reads.
// ---------------------------------------------------------------------------
const NOW = new Date("2026-09-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
// DB-path entitlements use the REAL clock (the shipped helpers default to it),
// so future/past fixture dates are real-relative.
const FUTURE = (days) => new Date(Date.now() + days * DAY);
const PAST = (days) => new Date(Date.now() - days * DAY);

const store = {
  students: [
    {
      id: "stu-1",
      userId: "u-1",
      grade: "2nd Secondary",
      schoolType: "ARABIC",
      groupId: "g1",
      batchId: null,
    },
  ],
  groups: [
    { id: "g1", name: "Legacy Group A", isActive: true, courseId: "course-1", course: { id: "course-1", slug: "legacy-course" } },
    { id: "g2", name: "Closed Group", isActive: false, courseId: "course-1", course: { id: "course-1", slug: "legacy-course" } },
  ],
  subscriptions: [], // THE legacy student starts with NO row
  payments: [],
  // mutation ledgers (submission side)
  studentWrites: [],
  subsCreated: 0,
  subsUpdated: 0,
  notifications: 0,
  authzWrites: [],
  nextSubId: 1,
  nextPayId: 1,
};

function joinStudent(id) {
  const s = store.students.find((x) => x.id === id);
  if (!s) return null;
  const group = s.groupId ? store.groups.find((g) => g.id === s.groupId) ?? null : null;
  const sub = store.subscriptions.find((x) => x.studentId === s.id) ?? null;
  return {
    ...s,
    group: group
      ? { id: group.id, name: group.name, isActive: group.isActive, courseId: group.courseId, course: group.course }
      : null,
    subscription: sub
      ? {
          id: sub.id,
          status: sub.status,
          planId: sub.planId,
          startDate: sub.startDate,
          endDate: sub.endDate,
          plan: { id: sub.planId, name: sub.planId, nameAr: null },
        }
      : null,
  };
}

function joinStudentByUserId(userId) {
  const s = store.students.find((x) => x.userId === userId);
  return s ? joinStudent(s.id) : null;
}

// Canonical one-lesson-chain fixtures (same shapes as the main PR2a suite).
function lessonFixtures() {
  const mk = (id, order) => ({
    id,
    order,
    status: "PUBLISHED",
    curriculumStatus: "ACTIVE",
    trackScope: "SHARED",
    // L1 must satisfy the progression requirement itself; L2 stays behind it.
    videoUrl: id === "L1" ? `https://cdn.example.invalid/${id}.mp4` : null,
    unitId: "U1",
    topicId: null,
    unit: { id: "U1", order: 1, part: { id: "P1", order: 1, courseId: "course-1" } },
    topic: null,
    quizzes: [],
    homeworks: [],
  });
  return [mk("L1", 1), mk("L2", 2)];
}

function lessonMatchesWhere(lesson, where) {
  if (!where) return true;
  const KNOWN = new Set(["status", "curriculumStatus", "trackScope", "OR"]);
  for (const key of Object.keys(where)) {
    if (!KNOWN.has(key)) throw new Error(`mock: unsupported lesson where clause '${key}'`);
  }
  if (where.status !== undefined && lesson.status !== where.status) return false;
  if (where.curriculumStatus && where.curriculumStatus.not !== undefined) {
    if (lesson.curriculumStatus === where.curriculumStatus.not) return false;
  }
  if (Array.isArray(where.trackScope?.in) && !where.trackScope.in.includes(lesson.trackScope)) return false;
  const viaUnit = (courseId) => !!lesson.unit && lesson.unit.part.courseId === courseId;
  if (Array.isArray(where.OR)) {
    return where.OR.some((b) => (b.unit?.part?.courseId ? viaUnit(b.unit.part.courseId) : false));
  }
  return true;
}

// The module-level db the AUTHZ paths see. Reads hit the shared store; EVERY
// mutation throws — authorization (even right after a submission) may never
// write, create or lazily flip anything.
function authzMutationSpy(name) {
  return () => {
    store.authzWrites.push(name);
    throw new Error(`side-effect during authorization: ${name}`);
  };
}
const fakeDb = {
  student: {
    findUnique: ({ where } = {}) => {
      if (where?.id) return Promise.resolve(joinStudent(where.id));
      if (where?.userId) return Promise.resolve(joinStudentByUserId(where.userId));
      return Promise.resolve(null);
    },
    update: authzMutationSpy("student.update"),
    updateMany: authzMutationSpy("student.updateMany"),
    create: authzMutationSpy("student.create"),
    count: ({ where } = {}) =>
      Promise.resolve(store.students.filter((s) => s.groupId === where?.groupId).length),
  },
  lesson: {
    findMany: ({ where }) => Promise.resolve(lessonFixtures().filter((l) => lessonMatchesWhere(l, where))),
    findUnique: ({ where }) => Promise.resolve(lessonFixtures().find((l) => l.id === where.id) || null),
  },
  lessonProgress: { findMany: () => Promise.resolve([]) },
  quizAttempt: { findMany: () => Promise.resolve([]) },
  homeworkSubmission: { findMany: () => Promise.resolve([]) },
  // Canonical progression-engine reads (empty world: no videos served,
  // no holds, no overrides — the suite's lessons carry no requirements
  // beyond L1's unwatched videoUrl).
  sessionVideo: { findMany: () => Promise.resolve([]) },
  sessionVideoView: { findMany: () => Promise.resolve([]) },
  question: { findMany: () => Promise.resolve([]) },
  absenceHold: { findMany: () => Promise.resolve([]) },
  progressionOverride: { findMany: () => Promise.resolve([]) },
  batch: { findMany: () => Promise.resolve([]), findFirst: () => Promise.resolve(null) },
  group: { findMany: async () => store.groups.map((g) => ({ id: g.id, name: g.name, isActive: g.isActive })) },
  subscriptionPlan: { findMany: async () => [{ id: "plan-req", name: "plan-req", nameAr: null }] },
};
globalThis.__P25_FAKE_DB__ = { db: fakeDb };

const realResolve = Module._resolveFilename;
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
fs.writeFileSync(path.join(OUT, "fake-db.js"), "module.exports = globalThis.__P25_FAKE_DB__;\n");
fs.writeFileSync(
  path.join(OUT, "prisma-stub.js"),
  'module.exports = new Proxy({}, { get: () => function noop() {} });\n'
);

const ENT = require(path.join(OUT, "subscription-entitlement.js"));
const SUB = require(path.join(OUT, "payment-submission.js"));
const ENR = require(path.join(OUT, "enrollment.js"));
const SP = require(path.join(OUT, "session-progress.js"));

// The SUBMISSION db: the real write side, applied to the same store. So the
// "after" reads observe exactly what the shipped submission code persisted.
function makeSubmitDb() {
  const tx = {
    student: {
      findUnique: async ({ where }) => joinStudent(where.id),
      update: async ({ where, data }) => {
        store.studentWrites.push(data);
        const s = store.students.find((x) => x.id === where.id);
        if (s) Object.assign(s, data);
        return joinStudent(where.id);
      },
    },
    subscription: {
      create: async ({ data }) => {
        const row = { id: `sub-${store.nextSubId++}`, startDate: null, endDate: null, ...data };
        store.subscriptions.push(row);
        store.subsCreated++;
        return { id: row.id, status: row.status, planId: row.planId };
      },
      update: async ({ where, data }) => {
        store.subsUpdated++;
        const row = store.subscriptions.find((s) => s.id === where.id);
        if (row) Object.assign(row, data);
        return { id: where.id, ...row, ...data };
      },
    },
    payment: {
      create: async ({ data }) => {
        const row = { id: `pay-${store.nextPayId++}`, createdAt: new Date(), ...data };
        store.payments.push(row);
        return { id: row.id, status: row.status };
      },
    },
    coupon: { update: async () => ({}) },
    couponRedemption: { create: async ({ data }) => data },
    user: { findMany: async () => [{ id: "admin-1" }] },
    notification: {
      createMany: async ({ data }) => {
        store.notifications += data.length;
        return { count: data.length };
      },
    },
  };
  return { db: { $transaction: async (fn) => fn(tx) } };
}

const baseParams = {
  userId: "u-1",
  studentId: "stu-1",
  groupId: "g1",
  plan: { id: "plan-req", price: 300 },
  amount: 300,
  notes: null,
  coupon: null,
  method: "INSTAPAY",
  senderPhone: "01147422177",
  reference: "REF-GF-1",
  notify: { title: "New subscription request", message: "submitted", link: "admin-payments" },
  now: NOW,
};

const describeAfter = async () => {
  const snap = await ENT.resolveStudentEntitlement("stu-1", { db: fakeDb });
  const enr = await ENR.getEnrollment("stu-1");
  const lesson = await SP.canAccessLesson("stu-1", "L1");
  const unlocked = await SP.getUnlockedLessonIds("stu-1", "course-1");
  const sub = store.subscriptions.find((s) => s.studentId === "stu-1") ?? null;
  const payment = store.payments[store.payments.length - 1] ?? null;
  return { snap, enr, lesson, unlocked, sub, payment, groupId: store.students[0].groupId };
};

// ===========================================================================
async function main() {
  // -------------------------------------------------------------------------
  section("1. BEFORE submit — the grandfathered baseline (must be TRUE)");
  // -------------------------------------------------------------------------
  const before = await describeAfter();
  ok(before.enr.isEnrolled === true, "baseline: getEnrollment isEnrolled (ACTIVE group, no row)");
  ok(before.enr.grandfathered === true && before.enr.hasSubscription === false, "baseline: grandfathered flag set, no subscription row");
  ok(before.snap.accessAllowed === true && before.snap.grandfathered === true && before.snap.state === "NONE", "baseline: resolveStudentEntitlement grants legacy access");
  ok(before.lesson.allowed === true, "baseline: canAccessLesson(L1) opens the paid lesson");
  ok(before.unlocked.has("L1"), "baseline: the unlock gate contains L1");
  ok(store.subscriptions.length === 0, "baseline: NO Subscription row exists");

  // -------------------------------------------------------------------------
  section("2. SUBMIT the payment request (shipped submitPaymentRequest)");
  // -------------------------------------------------------------------------
  const { db } = makeSubmitDb();
  const res = await SUB.submitPaymentRequest({ ...baseParams, db });
  console.log(`  scenario returned: ${res.scenario}`);

  const after = await describeAfter();

  // --- REPORT (exact observed behavior) -----------------------------------
  const fmt = (b) => ({
    "Subscription row": b.sub ? `${b.sub.id} status=${b.sub.status} planId=${b.sub.planId}` : "NONE",
    groupId: b.groupId,
    "accessAllowed (getEnrollment)": b.enr.isEnrolled,
    "accessAllowed (resolver)": b.snap.accessAllowed,
    grandfathered: b.snap.grandfathered,
    "state (dashboard label)": b.snap.state,
    "canAccessLesson(L1)": `${b.lesson.allowed}${b.lesson.reason ? " (" + b.lesson.reason + ")" : ""}`,
    "unlocked set size": b.unlocked.size,
    "payment": b.payment ? `${b.payment.id} status=${b.payment.status} subscriptionId=${b.payment.subscriptionId ?? "null"} requestedGroupId=${b.payment.requestedGroupId ?? "null"} requestedPlanId=${b.payment.requestedPlanId ?? "null"}` : "NONE",
  });
  console.log("\n  ============ OBSERVED ============");
  console.log("  BEFORE:", fmt(before));
  console.log("  AFTER :", fmt(after));
  console.log("  ==================================\n");

  // -------------------------------------------------------------------------
  section("3. INVARIANTS that must hold before AND after any fix");
  // -------------------------------------------------------------------------
  ok(store.studentWrites.length === 0 && after.groupId === "g1", "Student.groupId is never touched at submission (remains g1)");
  ok(after.payment && after.payment.status === "PENDING", "a PENDING Payment was recorded");
  ok(after.payment.subscriptionId == null, "Payment.subscriptionId is NULL on the legacy path (no row linked, none fabricated)");
  ok(after.payment.requestedGroupId === "g1" && after.payment.requestedPlanId === "plan-req", "intent lives on the Payment (requestedGroupId/requestedPlanId)");
  ok(after.payment.senderPhone === "01147422177" && after.payment.reference === "REF-GF-1", "senderPhone + reference captured");
  ok(store.authzWrites.length === 0, "the post-submit authorization reads caused ZERO mutations");

  // -------------------------------------------------------------------------
  section("4. REQUIREMENT (Phase 25): submitting must NOT revoke grandfathered access");
  // -------------------------------------------------------------------------
  // The subscription row, once present, is authoritative ⇒ a grandfathered
  // submission must therefore NOT create one (creation/activation is PR2b's
  // approval job). These are the assertions the audit was asked to verify:
  ok(store.subscriptions.length === 0, "REQ-1 no Subscription row may be created at submission for a grandfathered student");
  ok(after.snap.accessAllowed === true, "REQ-2 resolveStudentEntitlement: accessAllowed stays TRUE after submit");
  ok(after.snap.grandfathered === true, "REQ-3 the student remains grandfathered after submit");
  ok(after.enr.isEnrolled === true, "REQ-4 getEnrollment still resolves the paid course after submit");
  ok(after.lesson.allowed === true, "REQ-5 canAccessLesson(L1) still allowed after submit");
  ok(after.unlocked.has("L1"), "REQ-6 the unlock gate still contains L1 after submit");
  ok(after.snap.state === "NONE", "REQ-7 entitlement label stays NONE (no ACTIVE fabricated, no PENDING entitlement)");
  ok(res.scenario === "LEGACY_GRANDFATHERED" && store.subscriptions.length === 0, "REQ-8 scenario is the dedicated LEGACY_GRANDFATHERED label and no row exists — never reported as a PENDING entitlement");

  // A second submission (retry) must be equally harmless.
  await SUB.submitPaymentRequest({ ...baseParams, db: makeSubmitDb().db, reference: "REF-GF-2" });
  const after2 = await describeAfter();
  ok(store.subscriptions.length === 0, "REQ-9 retry also creates no Subscription row");
  ok(after2.snap.accessAllowed === true && after2.lesson.allowed === true, "REQ-10 access survives the retry too");
  ok(store.payments.length === 2, "both requests recorded (Payment is history)");

  // -------------------------------------------------------------------------
  section("5. CONTROLS — semantics that must NOT change either way");
  // -------------------------------------------------------------------------
  {
    // Genuinely NEW student (no group, no row): submission DOES create the
    // PENDING singleton and DOES deny (pending is never entitlement).
    store.students.push({ id: "stu-new", userId: "u-new", grade: "2nd Secondary", schoolType: "ARABIC", groupId: null, batchId: null });
    const { db: dbNew } = makeSubmitDb();
    const resNew = await SUB.submitPaymentRequest({ ...baseParams, db: dbNew, userId: "u-new", studentId: "stu-new", reference: "REF-NEW" });
    const snapNew = await ENT.resolveStudentEntitlement("stu-new", { db: fakeDb });
    ok(resNew.scenario === "NEW_REQUEST", "control: brand-new student takes NEW_REQUEST");
    ok(store.subscriptions.some((s) => s.studentId === "stu-new" && s.status === "PENDING"), "control: new student's singleton Subscription is created PENDING");
    ok(snapNew.accessAllowed === false && snapNew.state === "PENDING", "control: PENDING subscription denies the new student (unchanged)");
    // cleanup so grandfathered store assertions above remain meaningful
    store.students.pop();
    store.subscriptions.length = 0;
    store.payments.length = 0;
    store.nextPayId = 1;
  }
  {
    // ACTIVE renewal control on a fresh student: row untouched, groupId kept.
    store.students[0].groupId = "g1";
    const renewEnd = FUTURE(20);
    store.subscriptions.push({ id: "sub-live", studentId: "stu-1", status: "ACTIVE", planId: "plan-cur", startDate: PAST(10), endDate: renewEnd });
    const { db: dbRen } = makeSubmitDb();
    const resRen = await SUB.submitPaymentRequest({ ...baseParams, db: dbRen, reference: "REF-REN" });
    const live = store.subscriptions.find((s) => s.id === "sub-live");
    ok(resRen.scenario === "RENEWAL", "control: ACTIVE+unexpired still takes RENEWAL");
    ok(live.status === "ACTIVE" && live.planId === "plan-cur" && live.endDate.getTime() === renewEnd.getTime(), "control: live subscription not mutated (status/plan/dates intact)");
    const snapRen = await ENT.resolveStudentEntitlement("stu-1", { db: fakeDb });
    ok(snapRen.accessAllowed === true && snapRen.grandfathered === false, "control: ACTIVE renewal keeps access via the row, never via grandfathering");
    store.subscriptions.length = 0;
    store.payments.length = 0;
    store.nextPayId = 1;
  }
  {
    // Grandfathered-looking but the GROUP IS INACTIVE: there is no legitimate
    // access to preserve — a PENDING row must still be the representation.
    store.groups.push({ id: "g3", name: "Dead group", isActive: false, courseId: "course-1", course: { id: "course-1", slug: "legacy-course" } });
    store.students[0].groupId = "g3";
    const { db: dbDead } = makeSubmitDb();
    const resDead = await SUB.submitPaymentRequest({ ...baseParams, db: dbDead, groupId: "g3", reference: "REF-DEAD" });
    ok(resDead.scenario === "NEW_REQUEST", "control: inactive-group legacy student is NOT treated as an entitlement (NEW_REQUEST)");
    ok(store.subscriptions.length === 1 && store.subscriptions[0].status === "PENDING", "control: PENDING singleton created for the inactive-group student");
    const snapDead = await ENT.resolveStudentEntitlement("stu-1", { db: fakeDb });
    ok(snapDead.accessAllowed === false, "control: inactive group never grants access, request or no request");
    // restore pristine scenario for any rerun of the report block
    store.students[0].groupId = "g1";
    store.subscriptions.length = 0;
    store.payments.length = 0;
    store.nextPayId = 1;
  }

  // -------------------------------------------------------------------------
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} assertions passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailed (Phase-25 grandfathering contract violation):");
    for (const f of failures) console.log("  ✗", f);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exitCode = 1;
});
