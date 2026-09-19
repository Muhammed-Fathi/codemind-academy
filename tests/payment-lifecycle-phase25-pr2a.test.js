// CodeMind Academy — Phase 25 PR2a: payment submission V2 + entitlement access.
//
// TWO LAYERS, both offline (no database, no network, no running server) —
// the same structure as tests/session-progression.test.js:
//
//   A. BEHAVIOURAL — the SHIPPED TypeScript is compiled with tsc and exercised
//      against fakes: `src/lib/subscription-entitlement.ts` (the policy),
//      `src/lib/payment-submission.ts` (validation, transactional submission,
//      student read contract), `src/lib/enrollment.ts` + `src/lib/session-progress.ts`
//      (the two central authorization paths + the batch unlock gate), and
//      `src/lib/i18n-core.ts` (the new server-message keys resolve in BOTH
//      locales, so the Arabic surface never receives a raw key or hardcoded
//      English). Fake `@/lib/db` records ANY mutation and throws — proving the
//      authorization path is side-effect free (no lazy EXPIRED writes).
//
//   B. SOURCE-LEVEL INVARIANTS — pins the HTTP wiring the behavioural layer
//      cannot see: /api/enroll carries the V2 contract (senderPhone/reference/
//      requested* fields, NO Student.groupId assignment, no batch mutation),
//      /api/students/me/payments derives ownership from the session only, the
//      dashboard labels a PENDING request as PENDING, PR2b's approval path is
//      untouched, PR1's ledger + migration count are intact, and no unique
//      constraint ever lands on Payment.reference.
//
// Run: node tests/payment-lifecycle-phase25-pr2a.test.js
// Exit code: 0 = all pass, 1 = failure. Requires Node >= 22.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const { execSync } = require("child_process");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const ts = require(path.join(__dirname, "..", "node_modules/typescript/lib/typescript.js"));

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", label);
  }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// Compile the modules under test to CommonJS in a temp dir. `@/lib/db` is
// redirected to a mutation-hostile fake via a resolver hook (tsc does not
// rewrite path aliases in emitted require() calls); `@prisma/client` is
// redirected to a permissive stub because the sandbox cannot download the
// engines to run `prisma generate` (type-only import in every file here, the
// redirect is belt-and-braces).
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p25pr2a-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
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
      path.join(REPO, "src/lib/subscription-entitlement.ts"),
      path.join(REPO, "src/lib/payment-submission.ts"),
      path.join(REPO, "src/lib/enrollment.ts"),
      path.join(REPO, "src/lib/session-progress.ts"),
      path.join(REPO, "src/lib/progress.ts"),
      path.join(REPO, "src/lib/session-lifecycle.ts"),
      path.join(REPO, "src/lib/track-scope.ts"),
      path.join(REPO, "src/lib/school-type.ts"),
      path.join(REPO, "src/lib/registration.ts"),
      path.join(REPO, "src/lib/i18n-core.ts"),
      path.join(REPO, "src/lib/i18n-dict.ts"),
      path.join(REPO, "src/lib/i18n-dict-2026.ts"),
    ],
  })
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch {
  /* fall through: check the emitted files instead (repo harness convention) */
}
for (const f of [
  "subscription-entitlement.js",
  "payment-submission.js",
  "enrollment.js",
  "session-progress.js",
  "i18n-core.js",
]) {
  if (!fs.existsSync(path.join(OUT, f))) throw new Error(`tsc did not emit ${f}`);
}
fs.writeFileSync(path.join(OUT, "fake-db.js"), "module.exports = globalThis.__P25_FAKE_DB__;\n");
fs.writeFileSync(
  path.join(OUT, "prisma-stub.js"),
  'module.exports = new Proxy({}, { get: () => function noop() {} });\n'
);

// ---------------------------------------------------------------------------
// The shared authorization fake. Every read returns data; EVERY mutation
// throws — the suite proves authorization never writes (lazy expiry without
// side effects, per PR2a §16).
// ---------------------------------------------------------------------------
const NOW = new Date("2026-09-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
// The DB-path assertions run against the SHIPPED helpers, which default to the
// real server clock — future/past fixtures must therefore be real-relative.
const FUTURE = (days = 30) => new Date(Date.now() + days * DAY);
const PAST = (days = 1) => new Date(Date.now() - days * DAY);

const state = {
  /** row returned by student.findUnique (null = no student row at all) */
  studentRow: null,
  writes: [],
  queries: [],
};

function mutationSpy(name) {
  return () => {
    state.writes.push(name);
    throw new Error(`side-effect during authorization: ${name}`);
  };
}

// A one-lesson canonical chain (Course → Part → Unit → Lesson L1) is enough
// to observe "would normally be unlocked" vs "entitlement denies it".
function lessonFixtures() {
  const mk = (id, order) => ({
    id,
    order,
    status: "PUBLISHED",
    curriculumStatus: "ACTIVE",
    trackScope: "SHARED",
    // L1 needs an unsatisfied requirement, or "locked L2" is unobservable.
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

const fakeDb = {
  student: {
    findUnique: ({ where } = {}) => {
      state.queries.push(`student.findUnique:${where?.id ?? "?"}`);
      return Promise.resolve(state.studentRow);
    },
    update: mutationSpy("student.update"),
    updateMany: mutationSpy("student.updateMany"),
    create: mutationSpy("student.create"),
    count: () => Promise.resolve(0),
  },
  lesson: {
    findMany: ({ where }) => Promise.resolve(lessonFixtures().filter((l) => lessonMatchesWhere(l, where))),
    findUnique: ({ where }) => Promise.resolve(lessonFixtures().find((l) => l.id === where.id) || null),
  },
  lessonProgress: { findMany: () => Promise.resolve([]) },
  quizAttempt: { findMany: () => Promise.resolve([]) },
  homeworkSubmission: { findMany: () => Promise.resolve([]) },
  batch: { findMany: () => Promise.resolve([]), findFirst: () => Promise.resolve(null) },
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

const ENT = require(path.join(OUT, "subscription-entitlement.js"));
const SUB = require(path.join(OUT, "payment-submission.js"));
const ENR = require(path.join(OUT, "enrollment.js"));
const SP = require(path.join(OUT, "session-progress.js"));
const I18N = require(path.join(OUT, "i18n-core.js"));

function setStudent(over) {
  state.studentRow = {
    id: "stu-1",
    groupId: "g1",
    batchId: null,
    schoolType: "ARABIC",
    group: { id: "g1", isActive: true, courseId: "course-1", course: { id: "course-1", slug: "c1" } },
    subscription: null,
    ...over,
  };
}

// ===========================================================================
async function main() {
  // -------------------------------------------------------------------------
  section("1. isSubscriptionValidForAccess — the entitlement predicate (pure)");
  // -------------------------------------------------------------------------
  ok(ENT.isSubscriptionValidForAccess(null, NOW) === false, "no subscription row is NOT itself valid (grandfathering is the caller's decision)");
  ok(ENT.isSubscriptionValidForAccess(undefined, NOW) === false, "undefined row likewise false");
  ok(ENT.isSubscriptionValidForAccess({ status: "ACTIVE", endDate: new Date(NOW.getTime() + 30 * DAY) }, NOW) === true, "ACTIVE + future endDate => valid");
  ok(ENT.isSubscriptionValidForAccess({ status: "ACTIVE", endDate: new Date(NOW.getTime() - DAY) }, NOW) === false, "ACTIVE + PAST endDate => invalid (LAZY expiry, no stored transition needed)");
  ok(ENT.isSubscriptionValidForAccess({ status: "ACTIVE", endDate: NOW }, NOW) === false, "endDate exactly 'now' is not in the future => expired");
  ok(ENT.isSubscriptionValidForAccess({ status: "ACTIVE", endDate: null }, NOW) === true, "ACTIVE with no endDate: nothing has expired (approval always writes one)");
  ok(ENT.isSubscriptionValidForAccess({ status: "PENDING", endDate: null }, NOW) === false, "PENDING is never access");
  ok(ENT.isSubscriptionValidForAccess({ status: "EXPIRED", endDate: new Date(NOW.getTime() + 30 * DAY) }, NOW) === false, "stored EXPIRED denies even with a future date");
  ok(ENT.isSubscriptionValidForAccess({ status: "CANCELLED", endDate: null }, NOW) === false, "CANCELLED denies");
  ok(ENT.isSubscriptionValidForAccess({ status: "WEIRD", endDate: null }, NOW) === false, "unknown status fails closed");
  ok(ENT.isSubscriptionValidForAccess({ status: "active", endDate: new Date(NOW.getTime() + DAY) }, NOW) === true, "status comparison is casing-tolerant (enum values are upper-case; garbage still denies)");
  ok(ENT.isSubscriptionValidForAccess({ status: "ACTIVE", endDate: "2026-10-01T00:00:00.000Z" }, NOW) === true, "ISO string dates are accepted (server-side UTC convention)");
  ok(ENT.isSubscriptionValidForAccess({ status: "ACTIVE", endDate: "not a date" }, NOW) === false, "unparseable NON-NULL date FAILS CLOSED");

  // -------------------------------------------------------------------------
  section("2. evaluateAccessDecision — the whole matrix incl. grandfathering");
  // -------------------------------------------------------------------------
  const dec = (groupActive, subscription) => ENT.evaluateAccessDecision({ groupActive, subscription }, NOW);
  let d = dec(false, null);
  ok(d.allowed === false && d.reason === "NO_GROUP", "no valid group => denied (no paid course access)");
  d = dec(false, { status: "ACTIVE", endDate: new Date(NOW.getTime() + 30 * DAY) });
  ok(d.allowed === false && d.reason === "NO_GROUP", "group half is not overruled by an ACTIVE row alone");
  d = dec(true, null);
  ok(d.allowed === true && d.grandfathered === true && d.hasSubscription === false && d.reason === "OK_GRANDFATHERED", "group + NO Subscription => legacy grandfathered access preserved");
  d = dec(true, { status: "ACTIVE", endDate: new Date(NOW.getTime() + 30 * DAY) });
  ok(d.allowed === true && d.grandfathered === false && d.reason === "OK_ACTIVE", "group + ACTIVE unexpired => allowed");
  d = dec(true, { status: "ACTIVE", endDate: new Date(NOW.getTime() - DAY) });
  ok(d.allowed === false && d.reason === "SUBSCRIPTION_EXPIRED", "group + ACTIVE but expired => DENIED");
  d = dec(true, { status: "PENDING", endDate: null });
  ok(d.allowed === false && d.reason === "SUBSCRIPTION_PENDING", "group + PENDING subscription => DENIED (pending is not entitlement)");
  d = dec(true, { status: "CANCELLED", endDate: null });
  ok(d.allowed === false && d.reason === "SUBSCRIPTION_NOT_ACTIVE", "group + CANCELLED => DENIED");
  d = dec(true, { status: "EXPIRED", endDate: new Date(NOW.getTime() + 30 * DAY) });
  ok(d.allowed === false && d.reason === "SUBSCRIPTION_NOT_ACTIVE", "group + stored EXPIRED => DENIED");

  // -------------------------------------------------------------------------
  section("3. describeSubscriptionState — the UI-truth label");
  // -------------------------------------------------------------------------
  ok(ENT.describeSubscriptionState(null, NOW).state === "NONE", "no row => NONE");
  let s = ENT.describeSubscriptionState({ status: "PENDING", endDate: null }, NOW);
  ok(s.state === "PENDING", "PENDING is labeled PENDING — THE PR2a REGRESSION PIN: never 'Active'");
  ok(s.daysToExpiry === 0, "a pending request carries no expiry math");
  s = ENT.describeSubscriptionState({ status: "ACTIVE", endDate: new Date(NOW.getTime() + 30 * DAY) }, NOW);
  ok(s.state === "ACTIVE" && s.daysToExpiry === 30, "far-future ACTIVE => ACTIVE with day count");
  s = ENT.describeSubscriptionState({ status: "ACTIVE", endDate: new Date(NOW.getTime() + 3 * DAY) }, NOW);
  ok(s.state === "EXPIRING", "ACTIVE within 7 days => EXPIRING");
  s = ENT.describeSubscriptionState({ status: "ACTIVE", endDate: new Date(NOW.getTime() - DAY) }, NOW);
  ok(s.state === "EXPIRED", "lazily expired ACTIVE reads EXPIRED even though the row still says ACTIVE");
  ok(s.rawStatus === "ACTIVE", "rawStatus keeps the stored value visible (raw is never relabeled)");
  s = ENT.describeSubscriptionState({ status: "CANCELLED" }, NOW);
  ok(s.state === "CANCELLED", "CANCELLED has its own label");
  ok(ENT.EXPIRING_WINDOW_DAYS === 7, "expiring window is 7 days (dashboard parity)");

  // -------------------------------------------------------------------------
  section("4. getEnrollment — the central path applies the policy");
  // -------------------------------------------------------------------------
  state.writes = [];
  setStudent({ subscription: null });
  let e = await ENR.getEnrollment("stu-1");
  ok(e.isEnrolled === true && e.grandfathered === true && e.hasSubscription === false, "group + no Subscription: still enrolled (legacy)");
  ok(e.courseId === "course-1", "legacy course resolution unchanged (regression: existing legacy enrollment still resolves)");

  setStudent({ groupId: null, group: null, subscription: null });
  e = await ENR.getEnrollment("stu-1");
  ok(e.isEnrolled === false && e.groupId === null, "no group => no access");

  setStudent({ subscription: { status: "PENDING", endDate: null } });
  e = await ENR.getEnrollment("stu-1");
  ok(e.isEnrolled === false && e.subscriptionStatus === "PENDING" && e.hasSubscription === true, "PENDING subscription => NOT enrolled; raw status still visible");

  setStudent({ subscription: { status: "REJECTED-equivalent" /* enum has no REJECTED; garbage fails closed */, endDate: null } });
  e = await ENR.getEnrollment("stu-1");
  ok(e.isEnrolled === false, "non-ACTIVE / unrecognized entitlement => NOT enrolled");

  setStudent({ subscription: { status: "CANCELLED", endDate: null } });
  e = await ENR.getEnrollment("stu-1");
  ok(e.isEnrolled === false, "CANCELLED => NOT enrolled");

  setStudent({ subscription: { status: "ACTIVE", endDate: FUTURE(10) } });
  e = await ENR.getEnrollment("stu-1");
  ok(e.isEnrolled === true && e.grandfathered === false, "ACTIVE unexpired => enrolled");

  setStudent({ subscription: { status: "ACTIVE", endDate: PAST(1) } });
  e = await ENR.getEnrollment("stu-1");
  ok(e.isEnrolled === false && e.subscriptionStatus === "ACTIVE", "expired ACTIVE => NOT enrolled, raw status untouched");

  setStudent({ group: { id: "g1", isActive: false, courseId: "course-1", course: null }, subscription: null });
  e = await ENR.getEnrollment("stu-1");
  ok(e.isEnrolled === false, "INACTIVE group half of the rule is unchanged");

  ok(state.writes.length === 0, "getEnrollment caused ZERO database mutations");

  // -------------------------------------------------------------------------
  section("5. canAccessLesson / getUnlockedLessonIds — inheritance + no mutation");
  // -------------------------------------------------------------------------
  state.writes = [];
  setStudent({ subscription: null });
  let a = await SP.canAccessLesson("stu-1", "L1");
  ok(a.allowed === true, "grandfathered student still opens the unlocked lesson");
  a = await SP.canAccessLesson("stu-1", "L2");
  ok(a.allowed === false && a.reason === "PREVIOUS_SESSION_INCOMPLETE", "progression semantics untouched by PR2a (L2 still locked behind L1)");

  setStudent({ subscription: { status: "PENDING", endDate: null } });
  a = await SP.canAccessLesson("stu-1", "L1");
  ok(a.allowed === false && a.reason === "NOT_ENROLLED", "PENDING request denies the FIRST lesson too (submission never opens the course)");
  a = await SP.canAccessLesson("stu-1", "L2");
  ok(a.allowed === false && a.reason === "NOT_ENROLLED", "denial answers NOT_ENROLLED for every lesson (no leak beyond the gate)");

  setStudent({ subscription: { status: "ACTIVE", endDate: PAST(1) } });
  a = await SP.canAccessLesson("stu-1", "L1");
  ok(a.allowed === false && a.reason === "NOT_ENROLLED", "expired ACTIVE denies lesson access lazily");

  setStudent({ groupId: null, group: null, subscription: { status: "ACTIVE", endDate: FUTURE(30) } });
  a = await SP.canAccessLesson("stu-1", "L1");
  ok(a.allowed === false && a.reason === "NOT_ENROLLED", "no group => no lesson access even with an ACTIVE row (group half preserved)");

  setStudent({ subscription: { status: "ACTIVE", endDate: FUTURE(30) } });
  a = await SP.canAccessLesson("stu-1", "L1");
  ok(a.allowed === true, "ACTIVE unexpired => lesson access allowed");

  let set = await SP.getUnlockedLessonIds("stu-1", "course-1");
  ok(set.has("L1"), "batch unlock gate returns the unlocked set while entitled");
  setStudent({ subscription: { status: "PENDING", endDate: null } });
  set = await SP.getUnlockedLessonIds("stu-1", "course-1");
  ok(set.size === 0, "batch unlock gate (dashboard + homework list) returns the EMPTY set while PENDING");
  setStudent({ subscription: { status: "ACTIVE", endDate: PAST(1) } });
  set = await SP.getUnlockedLessonIds("stu-1", "course-1");
  ok(set.size === 0, "…and while lazily expired");

  ok(state.writes.length === 0, "canAccessLesson + getUnlockedLessonIds caused ZERO database mutations");

  // -------------------------------------------------------------------------
  section("6. validateEnrollmentSubmission — V2 contract");
  // -------------------------------------------------------------------------
  const tStub = (key) => `t:${key}`;
  const V = SUB.validateEnrollmentSubmission;
  let r = V({ method: "INSTAPAY", senderPhone: "01147422177", reference: "1234567890" }, tStub);
  ok(r.input && r.input.method === "INSTAPAY" && r.input.senderPhone === "01147422177" && r.input.reference === "1234567890", "valid InstaPay submission passes with normalized values");
  ok(r.input && r.input.senderPhone === "01147422177", "canonical local form kept");
  r = V({ method: "ETISALAT_CASH", senderPhone: "+20 114-742-2177", reference: "9 8 7 6 5 4 3 2 1" }, tStub);
  ok(r.input && r.input.senderPhone === "01147422177", "+20 / spaced forms normalize to the same 01 number (existing phone helpers)");
  ok(r.input && r.input.reference === "9 8 7 6 5 4 3 2 1", "reference inner spaces collapse but content is kept (loose on purpose)");
  r = V({ method: "INSTAPAY", reference: "1234567890" }, tStub);
  ok(r.error && r.error.message === "t:api.267" && r.error.status === 400, "missing senderPhone rejected with the localized V2 key");
  r = V({ method: "INSTAPAY", senderPhone: "0114742217" }, tStub);
  ok(r.error && r.error.message === "t:api.267", "short/invalid Egyptian phone rejected");
  r = V({ method: "INSTAPAY", senderPhone: "01147422177" }, tStub);
  ok(r.error && r.error.message === "t:api.268", "missing reference rejected");
  r = V({ method: "INSTAPAY", senderPhone: "01147422177", reference: "12" }, tStub);
  ok(r.error && r.error.message === "t:api.268", "2-char reference rejected by length floor");
  r = V({ method: "INSTAPAY", senderPhone: "01147422177", reference: "1".repeat(65) }, tStub);
  ok(r.error && r.error.message === "t:api.268", "65-char reference rejected by length ceiling");
  r = V({ method: "INSTAPAY", senderPhone: "01147422177", reference: "9".repeat(40) }, tStub);
  ok(r.input, "long numeric InstaPay-style reference is ACCEPTED (no over-strict format rule)");
  r = V({ method: "VODAFONE_CASH", senderPhone: "01147422177", reference: "1234567890" }, tStub);
  ok(r.error && r.error.message === "t:api.266", "known-but-disabled method gets its own unsupported message");
  r = V({ method: "STRIPE", senderPhone: "01147422177", reference: "1234567890" }, tStub);
  ok(r.error && r.error.message === "t:api.082", "unknown method rejected via the existing required-fields message");
  r = V({ method: " instapay ", senderPhone: "01147422177", reference: "1234567890" }, tStub);
  ok(r.input && r.input.method === "INSTAPAY", "method is case/format tolerant for legit values");
  ok(SUB.SUPPORTED_PAYMENT_METHODS.join(",") === "INSTAPAY,ETISALAT_CASH", "launch method allowlist is exactly InstaPay + e& Cash");

  // -------------------------------------------------------------------------
  section("7. submitPaymentRequest — scenario A: NEW / unentitled student");
  // -------------------------------------------------------------------------
  function makeSubmitDb({ subscription }) {
    const store = {
      payments: [],
      subsCreated: [],
      subsUpdated: [],
      studentUpdates: [],
      redemptions: [],
      couponUpdates: [],
      notifications: [],
    };
    const tx = {
      student: {
        findUnique: async () => ({ subscription }),
        update: async (args) => {
          store.studentUpdates.push(args);
          throw new Error("scenario forbids touching Student rows at submission");
        },
      },
      subscription: {
        create: async ({ data }) => {
          store.subsCreated.push(data);
          return { id: "sub-1", ...data };
        },
        update: async ({ where, data }) => {
          store.subsUpdated.push({ where, data });
          return { id: where.id, ...data };
        },
      },
      payment: {
        create: async ({ data }) => {
          const row = { id: `pay-${store.payments.length + 1}`, createdAt: new Date(), ...data };
          store.payments.push(row);
          return { id: row.id, status: row.status };
        },
      },
      coupon: {
        update: async (args) => {
          store.couponUpdates.push(args);
          return {};
        },
      },
      couponRedemption: {
        create: async ({ data }) => {
          store.redemptions.push(data);
          return data;
        },
      },
      user: { findMany: async () => [{ id: "admin-1" }, { id: "admin-2" }] },
      notification: {
        createMany: async ({ data }) => {
          store.notifications.push(...data);
          return { count: data.length };
        },
      },
    };
    const db = { $transaction: async (fn) => fn(tx) };
    return { db, store };
  }

  const baseParams = {
    db: null,
    userId: "u-1",
    studentId: "stu-1",
    groupId: "grp-req",
    plan: { id: "plan-req", price: 300 },
    amount: 300,
    notes: null,
    coupon: null,
    method: "INSTAPAY",
    senderPhone: "01147422177",
    reference: "REF-42",
    notify: { title: "New subscription request", message: "p1 submitted", link: "admin-payments" },
    now: NOW,
  };

  {
    const { db, store } = makeSubmitDb({ subscription: null });
    const res = await SUB.submitPaymentRequest({ ...baseParams, db });
    ok(res.scenario === "NEW_REQUEST", "no-entitlement submission takes the NEW_REQUEST path");
    const p = store.payments[0];
    ok(store.payments.length === 1 && p.status === "PENDING", "Payment created as PENDING");
    ok(p.senderPhone === "01147422177", "Payment.senderPhone persisted (normalized)");
    ok(p.reference === "REF-42", "Payment.reference persisted");
    ok(p.requestedGroupId === "grp-req", "Payment.requestedGroupId persisted (intent on the Payment)");
    ok(p.requestedPlanId === "plan-req", "Payment.requestedPlanId persisted");
    ok(p.userId === "u-1" && p.amount === 300 && p.method === "INSTAPAY", "amount/method/user unchanged from the legacy contract");
    const sc = store.subsCreated[0];
    ok(store.subsCreated.length === 1 && sc.status === "PENDING" && sc.planId === "plan-req" && sc.studentId === "stu-1", "Subscription created PENDING for the requested plan");
    ok(p.subscriptionId === "sub-1", "Payment is linked to the pending entitlement row (index [subscriptionId,status] design)");
    ok(store.studentUpdates.length === 0, "CRITICAL: Student.groupId is NOT assigned on submission");
    ok(store.notifications.length === 2, "admin review notification fan-out preserved inside the transaction");
  }

  {
    // Retry safety (§21): a second submission must not create a second row.
    const { db, store } = makeSubmitDb({ subscription: { id: "sub-1", status: "PENDING", planId: "plan-old", endDate: null } });
    const res = await SUB.submitPaymentRequest({ ...baseParams, db });
    ok(res.scenario === "NEW_REQUEST", "re-submission stays on the request path");
    ok(store.subsCreated.length === 0, "singleton respected: no second Subscription row created");
    ok(store.subsUpdated.length === 1 && store.subsUpdated[0].data.status === "PENDING" && store.subsUpdated[0].data.planId === "plan-req", "existing stale row is MAINTAINED to PENDING with the new plan");
    ok(store.payments.length === 1, "a second Payment row is created — Payment is request history, duplicates allowed");
    ok(store.studentUpdates.length === 0, "still no group assignment on retry");
  }

  {
    // Stored-EXPIRED re-enrollment: downgraded-to-PENDING representation.
    const { db, store } = makeSubmitDb({ subscription: { id: "sub-9", status: "EXPIRED", planId: "plan-old", endDate: new Date(NOW.getTime() - 10 * DAY) } });
    const res = await SUB.submitPaymentRequest({ ...baseParams, db });
    ok(res.scenario === "NEW_REQUEST", "expired entitlement re-submit is a NEW request, not a renewal");
    ok(store.subsUpdated.length === 1 && store.subsUpdated[0].data.status === "PENDING", "EXPIRED singleton updated to PENDING (no second row, no create)");
    ok(store.studentUpdates.length === 0, "expired student does NOT regain the group by paying again — approval does");
  }

  // -------------------------------------------------------------------------
  section("8. submitPaymentRequest — scenario B: ACTIVE + unexpired renewal");
  // -------------------------------------------------------------------------
  {
    const activeSub = { id: "sub-live", status: "ACTIVE", planId: "plan-cur", endDate: new Date(NOW.getTime() + 20 * DAY) };
    const { db, store } = makeSubmitDb({ subscription: activeSub });
    const res = await SUB.submitPaymentRequest({ ...baseParams, db });
    ok(res.scenario === "RENEWAL", "active-unexpired student takes the RENEWAL path");
    ok(store.subsCreated.length === 0 && store.subsUpdated.length === 0, "current Subscription is NOT mutated (no downgrade, no plan swap, no date change)");
    ok(store.studentUpdates.length === 0, "Student.groupId preserved (no group switch before approval)");
    const p = store.payments[0];
    ok(store.payments.length === 1 && p.status === "PENDING", "new Payment created PENDING");
    ok(p.requestedGroupId === "grp-req" && p.requestedPlanId === "plan-req", "the renewal INTENT (group + plan) lives on the Payment");
    ok(p.senderPhone === "01147422177" && p.reference === "REF-42", "senderPhone + reference captured on the renewal too");
    ok(p.subscriptionId === "sub-live", "renewal Payment links the CURRENT entitlement for per-subscription lookup");
    ok(res.subscription.status === "ACTIVE" && res.subscription.planId === "plan-cur", "response echoes the UNCHANGED entitlement, not the request");
  }

  {
    // Coupon flow stays wired into the SAME transaction (legacy rule kept).
    const { db, store } = makeSubmitDb({ subscription: null });
    await SUB.submitPaymentRequest({
      ...baseParams,
      db,
      amount: 240,
      notes: "Coupon: WELCOME (-60 EGP)",
      coupon: { id: "cp-1", code: "WELCOME" },
    });
    ok(store.redemptions.length === 1 && store.redemptions[0].couponId === "cp-1" && store.redemptions[0].paymentId === "pay-1", "coupon redemption tied to the new payment");
    ok(store.couponUpdates.length === 1 && JSON.stringify(store.couponUpdates[0].data).includes("increment"), "coupon usedCount incremented in the same transaction");
    ok(store.payments[0].notes === "Coupon: WELCOME (-60 EGP)" && store.payments[0].amount === 240, "discounted amount + notes preserved");
  }

  // -------------------------------------------------------------------------
  section("9. fetchStudentPayments — the read contract");
  // -------------------------------------------------------------------------
  {
    const rows = [
      { id: "p3", status: "REJECTED", amount: 300, method: "INSTAPAY", reference: "REF-9", senderPhone: "01147422177", requestedPlanId: "plan-a", requestedGroupId: "grp-a", rejectionReason: "Reference mismatch on the bank statement", reviewedAt: new Date(NOW.getTime() - 2 * DAY), createdAt: new Date(NOW.getTime() - 1 * DAY) },
      { id: "p2", status: "PENDING", amount: 300, method: "ETISALAT_CASH", reference: "REF-9", senderPhone: "01147422177", requestedPlanId: "plan-a", requestedGroupId: "grp-a", rejectionReason: null, reviewedAt: null, createdAt: new Date(NOW.getTime() - 3 * DAY) },
      { id: "p1", status: "PENDING", amount: 300, method: "INSTAPAY", reference: "REF-9", senderPhone: "01147422177", requestedPlanId: "plan-x-deleted", requestedGroupId: "grp-y-deleted", rejectionReason: null, reviewedAt: null, createdAt: new Date(NOW.getTime() - 3 * DAY) },
      { id: "p0", status: "APPROVED", amount: 200, method: "INSTAPAY", reference: "REF-1", senderPhone: null, requestedPlanId: null, requestedGroupId: null, rejectionReason: null, reviewedAt: null, createdAt: new Date(NOW.getTime() - 40 * DAY) },
    ];
    const readDb = {
      payment: { findMany: async (args) => { readDb.lastSelect = args.select; return rows; } },
      subscriptionPlan: { findMany: async () => [{ id: "plan-a", name: "Month", nameAr: "شهر" }] },
      group: { findMany: async () => [{ id: "grp-a", name: "Group A", isActive: true }] },
    };
    const out = await SUB.fetchStudentPayments(readDb, "u-1");
    ok(out.payments.map((p) => p.id).join(",") === "p3,p2,p1,p0", "newest-first ordering preserved for PR2b's latest-request rule");
    ok(out.latestPending && out.latestPending.id === "p2", "latestPending = the newest PENDING request");
    ok(out.latestRejected && out.latestRejected.id === "p3", "latestRejected surfaced with its admin reason");
    ok(out.latestRejected.rejectionReason.includes("mismatch"), "rejectionReason represented safely for the owner (plain string)");
    ok(out.latestRejected.reviewedAt instanceof Date, "reviewedAt surfaces when present");
    ok(out.payments[0].requestedPlan && out.payments[0].requestedPlan.nameAr === "شهر", "requested plan resolved to display names");
    ok(out.payments[2].requestedPlan === null && out.payments[2].requestedGroup === null, "FK-less requested ids to deleted rows read null, never crash");
    ok(out.payments[1].duplicateReference === true && out.payments[2].duplicateReference === true, "the two same-reference PENDING rows are both FLAGGED");
    ok(out.payments[0].duplicateReference === false, "the REJECTED row shares the reference but is not a pending collision");
    ok(out.payments[3].duplicateReference === false, "APPROVED rows are not part of the duplicate-pending flag");
    ok(readDb.lastSelect && !("notes" in readDb.lastSelect) && !("updatedAt" in readDb.lastSelect), "read NEVER selects Payment.notes / updatedAt (admin scratch stays admin-side)");
    ok(readDb.lastSelect && readDb.lastSelect.rejectionReason === true, "the student's own rejection reason IS selected (explicit field list)");
  }

  // -------------------------------------------------------------------------
  section("10. resolveStudentEntitlement — the read-side snapshot");
  // -------------------------------------------------------------------------
  {
    const mk = (row) => ({ now: NOW, db: { student: { findUnique: async () => row } } });
    let snap = await ENT.resolveStudentEntitlement("stu-1", mk({
      id: "stu-1", groupId: "g1", group: { id: "g1", name: "A", isActive: true, courseId: "c1" },
      subscription: { status: "ACTIVE", startDate: new Date(NOW.getTime() - 10 * DAY), endDate: new Date(NOW.getTime() + 5 * DAY), plan: { id: "p1", name: "Month", nameAr: "شهر" } },
    }));
    ok(snap.accessAllowed === true && snap.state === "EXPIRING" && snap.daysToExpiry === 5 && snap.plan.nameAr === "شهر", "ACTIVE near-expiry snapshot");
    snap = await ENT.resolveStudentEntitlement("stu-1", mk({
      id: "stu-1", groupId: "g1", group: { id: "g1", name: "A", isActive: true, courseId: "c1" },
      subscription: { status: "PENDING", startDate: null, endDate: null, plan: { id: "p2", name: "Month", nameAr: null } },
    }));
    ok(snap.accessAllowed === false && snap.state === "PENDING" && snap.hasSubscription === true && snap.grandfathered === false, "PENDING snapshot: never active, never grandfathered");
    snap = await ENT.resolveStudentEntitlement("stu-1", mk({
      id: "stu-1", groupId: "g1", group: { id: "g1", name: "A", isActive: true, courseId: "c1" },
      subscription: null,
    }));
    ok(snap.accessAllowed === true && snap.grandfathered === true && snap.state === "NONE" && snap.subscriptionStatus === null, "grandfathered snapshot keeps legacy access while honestly reporting NO paid state");
    snap = await ENT.resolveStudentEntitlement("stu-1", mk(null));
    ok(snap === null, "missing student resolves to null (route maps to 404, never a crash)");
  }

  // -------------------------------------------------------------------------
  section("11. i18n — the new server keys translate in BOTH locales");
  // -------------------------------------------------------------------------
  for (const key of ["api.266", "api.267", "api.268", "auth.226", "auth.227", "student.249"]) {
    for (const loc of ["ar", "en"]) {
      const v = I18N.translate(loc, key);
      ok(typeof v === "string" && v.length > 0 && v !== key, `${key} resolves for ${loc} (no raw key, no hardcoded English in the Arabic surface)`);
    }
  }

  // -------------------------------------------------------------------------
  section("12. /api/enroll route wiring (source-level)");
  // -------------------------------------------------------------------------
  {
    const src = read("src/app/api/enroll/route.ts");
    ok(/requireUser\s*\(/.test(src) && /user\.role !== "STUDENT"/.test(src), "route keeps session-auth + STUDENT role gate");
    ok(/where:\s*{\s*userId:\s*user\.id\s*}/.test(src), "student identity resolved from the SESSION, not the body");
    ok(!/studentId\s*[:=]/.test(/const\s*{[^}]*}/.exec(src)?.[0] || ""), "body destructuring carries no studentId/userId");
    ok(/validateEnrollmentSubmission\s*\(/.test(src), "route applies the V2 validation contract");
    ok(/submitPaymentRequest\s*\(/.test(src), "submission goes through the shared transactional core");
    ok(!/student\.update/.test(src), "route contains NO direct student write — groupId is never assigned at submission");
    ok(/reconcileStudentBatch\(student\.id\)/.test(src), "Phase 12 batch-healing stays wired (an idempotent heal; the group never changes here)");
    ok(src.indexOf("submitPaymentRequest(") < src.indexOf("reconcileStudentBatch(student.id)"), "the heal runs AFTER the submission transaction commits (post-commit reconciliation, Phase 12 rule)");
    ok(/RELEASE COUPLING/.test(src) && /PR2b/.test(src), "route carries the not-independently-deployable warning inline");
  }

  // -------------------------------------------------------------------------
  section("13. Read API ownership + dashboard truthfulness (source-level)");
  // -------------------------------------------------------------------------
  {
    const payments = read("src/app/api/students/me/payments/route.ts");
    ok(/requireUser\s*\(/.test(payments) && /user\.role !== "STUDENT"/.test(payments), "/me/payments is session-authenticated, students only");
    ok(/where:\s*{\s*userId:\s*user\.id\s*}/.test(payments), "payments are scoped to the SESSION user id");
    ok(/export async function GET\(\s*\)/.test(payments) && !/\{\s*params\s*\}/.test(payments), "the handler takes no request/params — no id can target another user");
    ok(/fetchStudentPayments\s*\(\s*db,\s*user\.id\s*\)/.test(payments), "reads pass the SESSION user id");
    ok(/select:\s*{\s*id:\s*true\s*}/.test(payments) && !/notes: true/.test(payments), "route selects only the student id — no admin scratch field is re-added");

    const dash = read("src/app/api/students/me/dashboard/route.ts");
    ok(!/else\s*{\s*subscriptionStatus\s*=\s*"ACTIVE";/.test(dash), "THE DASHBOARD LIE IS GONE: PENDING can no longer fall through to an ACTIVE label");
    ok(/resolveStudentEntitlement\s*\(/.test(dash) && /fetchStudentPayments\s*\(/.test(dash), "dashboard derives from the central policy + payment read");
    ok(/paymentRequests/.test(dash) && /accessAllowed/.test(dash) && /grandfathered/.test(dash), "dashboard carries entitlement-vs-request separation for PR3");
    ok(/"PENDING"/.test(dash), "PENDING is a representable dashboard state");

    const pill = read("src/components/student/student-dashboard.tsx");
    ok(/status === "PENDING"/.test(pill), "the pill renders a dedicated PENDING badge (request-under-review), not the ACTIVE badge");
  }

  // -------------------------------------------------------------------------
  section("14. Central paths only — no scattered checks, no bypass left open");
  // -------------------------------------------------------------------------
  {
    const enr = read("src/lib/enrollment.ts");
    const sp = read("src/lib/session-progress.ts");
    ok(/subscription-entitlement/.test(enr) && /evaluateAccessDecision\s*\(/.test(enr), "getEnrollment delegates to the shared policy");
    ok(/subscription-entitlement/.test(sp) && /evaluateAccessDecision\s*\(/.test(sp), "canAccessLesson + getUnlockedLessonIds delegate to the shared policy");
    ok((sp.match(/evaluateAccessDecision\s*\(/g) || []).length === 2, "exactly two decision points inside the progression module (lesson gate + batch gate) — one policy, applied centrally");

    // The list surfaces that DO NOT go through canAccessLesson inherit via
    // getEnrollment / getUnlockedLessonIds — verified they still only read
    // those helpers (no hand-rolled subscription logic anywhere else):
    const suspects = [
      "src/app/api/students/me/homework/route.ts",
      "src/app/api/students/me/session-videos/route.ts",
      "src/app/api/courses/[slug]/route.ts",
      "src/app/api/lessons/[id]/route.ts",
      "src/lib/session-materials.ts",
      "src/lib/parent-access.ts",
    ];
    for (const rel of suspects) {
      const src = read(rel);
      ok(!/subscription\.(findUnique|findFirst|update|create)/.test(src), `${rel} contains NO second subscription check (inherits the central paths)`);
    }
    // Session videos & homework derive their verdict from getEnrollment /
    // getUnlockedLessonIds — prove the delegation is still there:
    ok(/getEnrollment\s*\(/.test(read("src/app/api/students/me/session-videos/route.ts")), "session-videos still delegates enrollment (now entitlement-aware)");
    ok(/getUnlockedLessonIds\s*\(/.test(read("src/app/api/students/me/homework/route.ts")), "homework list still delegates unlocks (now entitlement-aware)");
  }

  // -------------------------------------------------------------------------
  section("15. PR2b boundary — decision routes delegate to the shared service; schema intact");
  // -------------------------------------------------------------------------
  {
    const approve = read("src/app/api/admin/payments/[id]/approve/route.ts");
    const reject = read("src/app/api/admin/payments/[id]/reject/route.ts");

    // PR2b RE-PIN (the deliberate-protocol replacement for the old
    // "legacy route NOT rewritten" pins, which PR2b intentionally breaks):
    // the decision logic lives in EXACTLY ONE place — @/lib/payment-
    // transitions. The routes (1) authenticate the ADMIN, (2) forward the
    // narrow client inputs (group override / rejection reason), (3) map the
    // service's domain errors to HTTP. No route carries a second copy of
    // the rules (no in-route transaction, no payment.update).
    ok(/from "@\/lib\/payment-transitions"/.test(approve), "approve route delegates to the PR2b shared service");
    ok(/approvePayment\s*\(/.test(approve), "approve route calls approvePayment (the service, not an in-route copy)");
    ok(/runApprovalPostCommitEffects\s*\(/.test(approve), "approve route runs the shared failure-tolerant post-commit helper");
    ok(!/\$transaction\s*\(/.test(approve) && !/payment\.update\s*\(/.test(approve), "approve route carries NO decision logic (no transaction, no payment.update)");
    ok(/from "@\/lib\/payment-transitions"/.test(reject), "reject route delegates to the PR2b shared service");
    ok(/rejectPayment\s*\(/.test(reject), "reject route calls rejectPayment (the service, not an in-route copy)");
    ok(/normalizeRejectionReason\s*\(/.test(reject), "reject route validates the reason with the shared normalizer (route and service can never disagree)");
    ok(!/\$transaction\s*\(/.test(reject) && !/payment\.update\s*\(/.test(reject), "reject route carries NO decision logic (no transaction, no payment.update)");

    const lib = read("src/lib/payment-submission.ts");
    ok(!/status:\s*"APPROVED"/.test(lib) && !/status:\s*"REJECTED"/.test(lib), "PR2a writes ONLY PENDING — no approval/rejection transitions");
    ok(!/pg_advisory|\$queryRaw|\$executeRaw|FOR UPDATE["'`]/.test(lib), "no raw SQL / advisory-lock code in PR2a (PR2b owns locking)");

    const schema = read("prisma/schema.prisma");
    const payBlock = /model Payment \{[\s\S]*?\n\}/.exec(schema)[0];
    ok(/reference\s+String\?/.test(payBlock) && !/@@unique/.test(payBlock), "NO unique constraint on Payment.reference (PR1 rule preserved)");
    ok(/senderPhone\s+String\?/.test(schema) && /requestedGroupId\s+String\?/.test(schema) && /requestedPlanId\s+String\?/.test(schema), "PR1 ledger fields still present in schema.prisma");
    const pg = read("prisma/postgres/schema.prisma");
    ok(/senderPhone\s+String\?/.test(pg) && /rejectionReason\s+String\?/.test(pg), "and in the derived PostgreSQL schema");
    const migrations = fs.readdirSync(path.join(REPO, "prisma/migrations"));
    // Phase 26D added the Lesson Quiz attempt-architecture migration, so the
    // history is now 12. The invariant this gate protects is "no migration was
    // silently removed or reordered", not the literal number 11.
    // Phase F appended one authorized additive migration (the live-session
    // lifecycle) at the END of the history; the PR2a-era ordering asserted by
    // the neighbouring checks is unchanged.
    ok(migrations.length === 13, `migration history: exactly 13 migrations (found ${migrations.length}) — the 10 PR2a-era migrations, the Phase 26B group-audience migration, the Phase 26D quiz attempt-architecture migration, and the Phase F live-session lifecycle`);
    ok(migrations.includes("20260914120000_payment_lifecycle_redesign"), "PR1's ledger migration remains in history");
    ok(migrations.includes("20260915120000_phase26b_group_track_scope"), "the Phase 26B group-audience migration is in history");
  }

  section("\n" + "=".repeat(60));
  console.log(`payment-lifecycle-phase25-pr2a: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
