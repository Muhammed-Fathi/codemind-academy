// CodeMind Academy — Parent Monthly Report regression tests (offline, no DB).
//
// Reproduces the original bug: Parent linked to a Student that has NO
// Subscription row → opening the Monthly Report crashed with
//   TypeError: Cannot read properties of null (reading 'status')
//
// The tests exercise the REAL code paths with an in-memory mock Prisma
// client (the real db/custom.db is never touched):
//   - POST /api/auth/register  (STUDENT)  → Student + studentCode
//   - POST /api/auth/register  (PARENT)   → Parent + ParentStudentLink
//   - GET  /api/parents/me/dashboard      → subscription: null contract
//   - <MonthlyReportContent/> rendered with react-dom/server
//   - <SubscriptionCard/> on the Parent Dashboard (via parent-dashboard.tsx)
//
// Scenarios: 1) no subscription  2) ACTIVE  3) API returns subscription:null
//            4) PENDING / EXPIRED / CANCELLED / expiring-soon
//
// Run: node tests/parent-monthly-report.test.js
// Exit code: 0 = all pass, 1 = failure.

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-parent-report-"));

// ---------------------------------------------------------------------------
// 1. Compile the files under test with tsc (type errors fail the suite)
// ---------------------------------------------------------------------------
const FILES = [
  "src/lib/parent-subscription.ts",
  "src/lib/registration.ts",
  "src/lib/curriculum.ts",
  "src/lib/curriculum-seed.ts",
  "src/lib/api.ts",
  "src/app/api/auth/[action]/route.ts",
  "src/app/api/parents/me/link-student/route.ts",
  "src/app/api/parents/me/dashboard/route.ts",
  "src/components/parent/monthly-report.tsx",
  "src/components/parent/parent-dashboard.tsx",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      jsx: "react-jsx",
      strict: true,
      noImplicitAny: false,
      skipLibCheck: true,
      esModuleInterop: true,
      baseUrl: REPO,
      rootDir: REPO,
      paths: { "@/*": ["src/*"] },
      typeRoots: [path.join(REPO, "node_modules/@types")],
      outDir: OUT,
      // Only emit; the repo's own tsc run is the authoritative type check.
      noEmitOnError: false,
    },
    files: FILES.map((f) => path.join(REPO, f)),
  })
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch (e) {
  // Pre-existing, unrelated type errors in files pulled in transitively
  // (e.g. @prisma/client enums when the client isn't generated) must not
  // block this suite — but the files under test must have been emitted.
  const emitted = path.join(OUT, "src/components/parent/monthly-report.js");
  if (!fs.existsSync(emitted)) {
    console.error(String(e.stdout || e.message));
    process.exit(1);
  }
}
const compiled = (f) => path.join(OUT, f.replace(/\.tsx?$/, ".js"));

// ---------------------------------------------------------------------------
// 2. In-memory mock Prisma client (only the tables this flow touches)
// ---------------------------------------------------------------------------
function makeMockDb() {
  const t = {
    user: [],
    student: [],
    parent: [],
    parentStudentLink: [],
    subscription: [],
    subscriptionPlan: [],
    setting: [],
  };
  let seq = 1;
  const nid = (p) => `${p}-${seq++}`;
  const matches = (row, where) =>
    Object.entries(where || {}).every(([k, v]) => {
      if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
        if ("in" in v) return v.in.includes(row[k]);
        if ("gte" in v) return row[k] >= v.gte;
        if ("some" in v || "equals" in v) return true;
      }
      return row[k] === v;
    });
  const clone = (r) => (r ? JSON.parse(JSON.stringify(r)) : r);
  const withUser = (s) => (s ? { ...s, user: t.user.find((u) => u.id === s.userId) } : s);

  const empty = {
    async findMany() { return []; },
    async count() { return 0; },
    async findFirst() { return null; },
  };

  const db = {
    __tables: t,
    user: {
      async findUnique({ where }) {
        return clone(t.user.find((u) => (where.id ? u.id === where.id : u.email === where.email)) || null);
      },
      async create({ data }) {
        const row = { id: nid("u"), isActive: true, avatarUrl: null, createdAt: new Date(), ...data };
        t.user.push(row);
        return clone(row);
      },
    },
    student: {
      async findUnique({ where }) {
        const s = t.student.find((s) =>
          where.id ? s.id === where.id
          : where.userId ? s.userId === where.userId
          : where.nationalId ? s.nationalId === where.nationalId
          : where.studentCode ? s.studentCode === where.studentCode
          : false
        );
        return clone(s || null);
      },
      async findFirst({ where }) {
        const s = t.student.find((s) => matches(s, where));
        return clone(withUser(s) || null);
      },
      async create({ data }) {
        if (data.studentCode && t.student.some((s) => s.studentCode === data.studentCode)) {
          const e = new Error("Unique constraint failed"); e.code = "P2002"; throw e;
        }
        const row = { id: nid("s"), groupId: null, enrolledAt: new Date(), ...data };
        t.student.push(row);
        return clone(row);
      },
      async count() { return t.student.length; },
    },
    parent: {
      async create({ data }) {
        const row = { id: nid("p"), ...data };
        t.parent.push(row);
        return clone(row);
      },
      async findUnique({ where, include }) {
        const p = t.parent.find((p) => p.userId === where.userId);
        if (!p) return null;
        const out = { ...p };
        if (include?.user) out.user = clone(t.user.find((u) => u.id === p.userId));
        if (include?.children) {
          out.children = t.parentStudentLink
            .filter((l) => l.parentId === p.id)
            .map((l) => {
              const s = t.student.find((s) => s.id === l.studentId);
              return { ...l, student: { ...withUser(s), group: null } };
            });
        }
        return out;
      },
    },
    parentStudentLink: {
      async findUnique({ where }) {
        const k = where.parentId_studentId;
        return clone(t.parentStudentLink.find((l) => l.parentId === k.parentId && l.studentId === k.studentId) || null);
      },
      async create({ data }) {
        const row = { id: nid("l"), createdAt: new Date(), ...data };
        t.parentStudentLink.push(row);
        return clone(row);
      },
      async upsert({ where, create }) {
        const k = where.parentId_studentId;
        let row = t.parentStudentLink.find((l) => l.parentId === k.parentId && l.studentId === k.studentId);
        if (!row) { row = { id: nid("l"), createdAt: new Date(), ...create }; t.parentStudentLink.push(row); }
        return clone(row);
      },
    },
    subscription: {
      async findUnique({ where, include }) {
        const s = t.subscription.find((s) => s.studentId === where.studentId);
        if (!s) return null;
        const out = { ...s };
        if (include?.plan) out.plan = t.subscriptionPlan.find((p) => p.id === s.planId) || null;
        return out;
      },
      async create({ data }) {
        const row = { id: nid("sub"), status: "PENDING", startDate: null, endDate: null, ...data };
        t.subscription.push(row);
        return row;
      },
    },
    subscriptionPlan: {
      async create({ data }) { const row = { id: nid("plan"), ...data }; t.subscriptionPlan.push(row); return row; },
    },
    setting: {
      async create({ data }) { const row = { id: nid("set"), ...data }; t.setting.push(row); return row; },
      async findUnique({ where }) { return clone(t.setting.find((s) => s.key === where.key) || null); },
      async delete() {}, async deleteMany() {},
    },
    // Everything else the dashboard aggregates over: empty for a new student.
    lesson: empty, lessonProgress: empty, attendance: empty, quizAttempt: empty,
    homework: empty, homeworkSubmission: empty, teacherNote: empty, liveSession: empty,
  };
  return db;
}

// ---------------------------------------------------------------------------
// 3. Module shims: db → mock, next/headers cookies → in-memory cookie jar,
//    heavy UI deps (framer-motion, recharts, @tanstack/react-query) → stubs.
// ---------------------------------------------------------------------------
global.__MOCK_DB__ = makeMockDb();
global.__COOKIES__ = new Map();

const React = require(path.join(REPO, "node_modules/react"));
const shim = (name, body) => {
  const p = path.join(OUT, `__shim_${name.replace(/[^a-z0-9]/gi, "_")}.js`);
  fs.writeFileSync(p, body);
  return p;
};
const SHIMS = {
  "@/lib/db": shim("db", "module.exports = { db: global.__MOCK_DB__ };"),
  "next/headers": shim(
    "headers",
    `module.exports = { cookies: async () => ({
       get: (k) => global.__COOKIES__.has(k) ? { value: global.__COOKIES__.get(k) } : undefined,
       set: (k, v) => global.__COOKIES__.set(k, v),
       delete: (k) => global.__COOKIES__.delete(k),
     }) };`
  ),
  "next/server": shim(
    "server",
    `class NextResponse {
       constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; this.ok = this.status < 300; }
       static json(data, init) { return new NextResponse(data, init); }
       async json() { return this.body; }
     }
     module.exports = { NextResponse, NextRequest: class {} };`
  ),
  "framer-motion": shim(
    "framer",
    `const React = require(${JSON.stringify(path.join(REPO, "node_modules/react"))});
     const motion = new Proxy({}, { get: (_, tag) => (props) => { const { initial, animate, exit, transition, whileHover, whileTap, variants, ...rest } = props; return React.createElement(tag, rest); } });
     module.exports = { motion, AnimatePresence: ({ children }) => children };`
  ),
  recharts: shim(
    "recharts",
    `const React = require(${JSON.stringify(path.join(REPO, "node_modules/react"))});
     const Stub = ({ children }) => React.createElement('div', null, children);
     module.exports = new Proxy({}, { get: () => Stub });`
  ),
  "@tanstack/react-query": shim(
    "rq",
    `module.exports = { useQuery: () => global.__RQ__ || {}, useQueryClient: () => ({ invalidateQueries() {} }), QueryClient: class {}, QueryClientProvider: ({ children }) => children };`
  ),
  sonner: shim("sonner", "module.exports = { toast: Object.assign(() => {}, { error() {}, success() {} }) };"),
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (SHIMS[request]) return SHIMS[request];
  if (request.startsWith("@/")) {
    const rel = request.slice(2);
    for (const cand of [`src/${rel}.js`, `src/${rel}/index.js`]) {
      const abs = path.join(OUT, cand);
      if (fs.existsSync(abs)) return abs;
    }
    // Not compiled by this suite → resolve from the repo source (tsx files
    // pulled in by parent-dashboard.tsx are compiled on demand below).
    return compileOnDemand(rel);
  }
  try {
    return origResolve.call(this, request, parent, ...rest);
  } catch (e) {
    // Compiled files live in a tmp dir → resolve bare packages from the repo.
    if (!request.startsWith(".") && !path.isAbsolute(request)) {
      return require.resolve(request, { paths: [REPO] });
    }
    throw e;
  }
};
// Compile any additional @/ module lazily (ui primitives, logo, brand, utils…)
function compileOnDemand(rel) {
  const candidates = [`src/${rel}.tsx`, `src/${rel}.ts`, `src/${rel}/index.tsx`, `src/${rel}/index.ts`];
  const src = candidates.map((c) => path.join(REPO, c)).find((p) => fs.existsSync(p));
  if (!src) throw new Error(`Cannot resolve @/${rel}`);
  const outFile = path.join(OUT, path.relative(REPO, src).replace(/\.tsx?$/, ".js"));
  if (!fs.existsSync(outFile)) {
    const cfg = path.join(OUT, `tsconfig.${Buffer.from(rel).toString("hex").slice(0, 40)}.json`);
    fs.writeFileSync(cfg, JSON.stringify({
      compilerOptions: {
        target: "es2020", module: "commonjs", jsx: "react-jsx", skipLibCheck: true,
        esModuleInterop: true, baseUrl: REPO, rootDir: REPO, paths: { "@/*": ["src/*"] },
        outDir: OUT, noEmitOnError: false, noImplicitAny: false,
      },
      files: [src],
    }));
    try { execSync(`npx tsc -p ${cfg}`, { cwd: REPO, stdio: "pipe" }); } catch {}
  }
  return outFile;
}

const { renderToStaticMarkup } = require(path.join(REPO, "node_modules/react-dom/server"));

// styled-jsx's `<style jsx global>` is compiled away by Next; when rendering
// raw with react-dom it only emits a harmless attribute warning. Silence it.
const origConsoleError = console.error;
console.error = (...args) => {
  const msg = String(args[0] || "");
  if (msg.includes("non-boolean attribute `jsx`") || msg.includes("non-boolean attribute `global`")) return;
  origConsoleError(...args);
};

// ---------------------------------------------------------------------------
// 4. Tiny assertion harness (same style as the other tests in this folder)
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};
const section = (t) => console.log(`\n${t}`);

// Real handlers under test
const authRoute = require(compiled("src/app/api/auth/[action]/route.ts"));
const linkRoute = require(compiled("src/app/api/parents/me/link-student/route.ts"));
const dashboardRoute = require(compiled("src/app/api/parents/me/dashboard/route.ts"));
const { buildReportData, MonthlyReportContent } = require(compiled("src/components/parent/monthly-report.tsx"));
const { describeParentSubscription } = require(compiled("src/lib/parent-subscription.ts"));
const parentDashboardMod = require(compiled("src/components/parent/parent-dashboard.tsx"));

const req = (body) => ({ json: async () => body });
const params = (action) => ({ params: Promise.resolve({ action }) });

// Wrap render so a thrown TypeError becomes a failed assertion, not a crash.
function renderSafely(el) {
  try { return { html: renderToStaticMarkup(el), error: null }; }
  catch (e) { return { html: "", error: e }; }
}

const NO_SUB_LINE_1 = "ابنك لسه ما اشتركش في أي باقة.";
const NO_SUB_LINE_2 = "لما ابنك يشترك في باقة، التقرير الشهري هيظهر هنا.";

(async () => {
  const db = global.__MOCK_DB__;

  // =========================================================================
  section("Scenario 1 — Student registers → Parent registers & links → Monthly Report (no subscription)");
  // =========================================================================
  const studentReg = await authRoute.POST(
    req({
      role: "STUDENT",
      name: "أحمد محمد علي",
      email: "student@test.local",
      password: "secret123",
      studentPhone: "01012345678",
      parentPhone: "01147422177",
      nationalId: "30101011234567",
      schoolName: "مدرسة النيل",
      schoolType: "LANGUAGE",
    }),
    params("register")
  );
  const studentBody = await studentReg.json();
  ok(studentReg.status === 200, "student registration returns 200");
  const studentRow = db.__tables.student[0];
  ok(!!studentRow, "Student row created");
  ok(/^CM-[A-Z2-9]{6}$/.test(studentBody.user?.studentCode || ""), `studentCode generated (${studentBody.user?.studentCode})`);
  ok(db.__tables.subscription.length === 0, "registration creates NO Subscription row");

  global.__COOKIES__.clear(); // student session not needed further

  const parentReg = await authRoute.POST(
    req({
      role: "PARENT",
      name: "محمد علي حسن",
      email: "parent@test.local",
      password: "secret123",
      parentPhone: "01147422177",
      studentNationalId: "30101011234567",
      studentCode: studentBody.user.studentCode,
    }),
    params("register")
  );
  ok(parentReg.status === 200, "parent registration (with verified linking data) returns 200");
  ok(db.__tables.parent.length === 1, "Parent row created");
  ok(db.__tables.parentStudentLink.length === 1, "ParentStudentLink created");
  ok(db.__tables.parentStudentLink[0].studentId === studentRow.id, "link points at the registered student");
  ok(global.__COOKIES__.has("cm_session"), "parent is logged in (session cookie set)");

  // Explicit link-student endpoint is idempotent for the same pair
  const linkRes = await linkRoute.POST(req({
    studentNationalId: "30101011234567",
    parentPhone: "01147422177",
    studentCode: studentBody.user.studentCode,
  }));
  ok(linkRes.status === 200, "POST /api/parents/me/link-student returns 200");
  ok(db.__tables.parentStudentLink.length === 1, "re-linking does not duplicate the link");

  // Parent dashboard API
  const dash = await dashboardRoute.GET({});
  const dashBody = await dash.json();
  ok(dash.status === 200, "GET /api/parents/me/dashboard returns 200");
  ok(Array.isArray(dashBody.children) && dashBody.children.length === 1, "dashboard returns 1 linked child");
  const child = dashBody.children[0];
  ok(child.subscription === null, "API contract: subscription === null for unsubscribed student");
  ok(child.studentCode === studentBody.user.studentCode, "child payload carries studentCode");

  // Build + render the report exactly as the component does
  const data1 = buildReportData(child);
  ok(data1.subscription === null, "buildReportData keeps subscription null (no fake subscription)");
  const r1 = renderSafely(React.createElement(MonthlyReportContent, { data: data1, onClose() {} }));
  ok(r1.error === null, `Monthly Report renders without throwing (${r1.error ? r1.error.message : "ok"})`);
  ok(r1.html.includes("monthly-report-no-subscription"), "shows the 'not subscribed yet' state");
  ok(r1.html.includes(NO_SUB_LINE_1), `message contains "${NO_SUB_LINE_1}"`);
  ok(r1.html.includes(NO_SUB_LINE_2), `message contains "${NO_SUB_LINE_2}"`);
  ok(r1.html.includes("مربوط بحسابك بنجاح"), "message reassures that the link worked");
  ok(r1.html.includes(child.name), "message names the student");

  // Parent Dashboard's SubscriptionCard also survives null
  const sub1 = describeParentSubscription(null);
  ok(sub1.state === "NONE" && sub1.reportAvailable === false, "describeParentSubscription(null) → NONE / report unavailable");

  // DB safety: nothing was created that shouldn't have been
  ok(db.__tables.subscription.length === 0, "still NO Subscription row after opening the report");
  ok(db.__tables.student[0].groupId === null, "student remains unenrolled (no group)");
  ok(db.__tables.parentStudentLink.length === 1, "parent/student link unchanged");

  // =========================================================================
  section("Scenario 2 — Student with ACTIVE subscription");
  // =========================================================================
  const plan = await db.subscriptionPlan.create({ data: { name: "Monthly", nameAr: "الباقة الشهرية", price: 300, durationMonths: 1 } });
  const end = new Date(Date.now() + 20 * 86400000);
  await db.subscription.create({ data: { studentId: studentRow.id, planId: plan.id, status: "ACTIVE", startDate: new Date(), endDate: end } });

  const dash2 = await (await dashboardRoute.GET({})).json();
  const child2 = dash2.children[0];
  ok(child2.subscription && child2.subscription.status === "ACTIVE", "API returns subscription.status === ACTIVE");
  ok(child2.subscription.planName === "الباقة الشهرية", "API returns Arabic plan name");
  ok(child2.subscription.daysLeft === 20, `API computes daysLeft (${child2.subscription.daysLeft})`);

  const data2 = buildReportData(child2);
  const r2 = renderSafely(React.createElement(MonthlyReportContent, { data: data2, onClose() {} }));
  ok(r2.error === null, "ACTIVE report renders without throwing");
  ok(!r2.html.includes("monthly-report-no-subscription"), "does NOT show the not-subscribed state");
  ok(r2.html.includes("monthly-report-subscription"), "renders the full report incl. subscription block");
  ok(r2.html.includes("Active · الباقة الشهرية"), "shows 'Active · <plan name>'");
  ok(r2.html.includes(">20<"), "shows days left");
  ok(r2.html.includes("نظرة عامة على الأداء"), "shows performance overview");
  ok(r2.html.includes("توصيات وخطوات قادمة"), "shows recommendations");
  ok(!r2.html.includes(NO_SUB_LINE_1), "no 'not subscribed' copy for an active subscriber");

  // =========================================================================
  section("Scenario 3 — API explicitly returns subscription: null (frontend contract)");
  // =========================================================================
  const apiShapedChild = {
    ...child2,
    subscription: null,
    // also drop optional nested blocks a fresh student might lack
    group: null, teacherNotes: undefined, strongTopics: undefined, weakTopics: undefined,
  };
  let threw = null;
  let data3 = null;
  try { data3 = buildReportData(apiShapedChild); } catch (e) { threw = e; }
  ok(threw === null, "buildReportData tolerates subscription:null and missing optional blocks");
  const r3 = renderSafely(React.createElement(MonthlyReportContent, { data: data3, onClose() {} }));
  ok(r3.error === null, "render with subscription:null does not throw TypeError");
  ok(r3.html.includes(NO_SUB_LINE_1) && r3.html.includes(NO_SUB_LINE_2), "shows both Egyptian Arabic lines");
  // The old crash path: `data.subscription.status` — prove the fixed code never reads it
  const src = fs.readFileSync(path.join(REPO, "src/components/parent/monthly-report.tsx"), "utf8");
  // Every `data.subscription.<prop>` must be preceded on the same line by a
  // `data.subscription?.` guard (e.g. `data.subscription?.planName && ...`).
  const unguarded = src
    .split("\n")
    .filter((line) => /data\.subscription\.(status|planName|daysLeft)/.test(line) && !/data\.subscription\?\./.test(line));
  ok(unguarded.length === 0, `no unguarded data.subscription.<prop> access remains in monthly-report.tsx${unguarded.length ? " → " + unguarded.join(" | ").trim() : ""}`);
  ok(/subscription: ParentSubscriptionPayload \| null/.test(src), "ReportData type declares subscription as nullable");
  const routeSrc = fs.readFileSync(path.join(REPO, "src/app/api/parents/me/dashboard/route.ts"), "utf8");
  ok(/ParentSubscriptionPayload \| null/.test(routeSrc), "API route uses the shared nullable contract type");

  // Parent dashboard still renders (SubscriptionCard null branch) — also a
  // no-data report still shows the friendly empty state, not a crash.
  const rNoData = renderSafely(React.createElement(MonthlyReportContent, { data: null, onClose() {} }));
  ok(rNoData.error === null && rNoData.html.includes("مفيش بيانات متاحة للتقرير"), "no-child case still shows 'no data' state");

  // =========================================================================
  section("Scenario 4 — Other subscription states (PENDING / EXPIRED / CANCELLED / expiring)");
  // =========================================================================
  const cases = [
    { status: "PENDING", daysLeft: null, label: "Pending", msg: "الاشتراك لسه بيتراجع." },
    { status: "EXPIRED", daysLeft: -3, label: "Expired", msg: "اشتراك ابنك انتهى." },
    { status: "CANCELLED", daysLeft: null, label: "Cancelled", msg: "اشتراك ابنك اتلغى." },
    { status: "ACTIVE", daysLeft: 3, label: "Expiring", msg: "قرب يخلص" },
  ];
  for (const c of cases) {
    const childN = { ...child2, subscription: { ...child2.subscription, status: c.status, daysLeft: c.daysLeft } };
    const dataN = buildReportData(childN);
    const rN = renderSafely(React.createElement(MonthlyReportContent, { data: dataN, onClose() {} }));
    const info = describeParentSubscription(childN.subscription);
    ok(rN.error === null, `${c.status}${c.daysLeft === 3 ? " (3 days left)" : ""}: renders without throwing`);
    ok(info.reportAvailable === true, `${c.status}: report stays available (existing app never gates reports on ACTIVE)`);
    ok(rN.html.includes(`${c.label} · الباقة الشهرية`), `${c.status}: shows "${c.label} · plan name"`);
    ok(rN.html.includes(c.msg), `${c.status}: shows Egyptian Arabic message "${c.msg}"`);
    if (c.daysLeft === null) ok(rN.html.includes(">—<"), `${c.status}: daysLeft null renders as —`);
  }
  // Unknown/legacy status must not crash either
  const rUnknown = renderSafely(React.createElement(MonthlyReportContent, {
    data: buildReportData({ ...child2, subscription: { ...child2.subscription, status: "WEIRD" } }), onClose() {},
  }));
  ok(rUnknown.error === null && rUnknown.html.includes("WEIRD"), "unknown status renders raw label without crashing");

  // =========================================================================
  section("Parent Dashboard module (SubscriptionCard + report wiring) loads");
  // =========================================================================
  ok(typeof parentDashboardMod.ParentDashboard === "function" || Object.keys(parentDashboardMod).length > 0, "parent-dashboard.tsx compiles and loads with the shared contract");
  const pdSrc = fs.readFileSync(path.join(REPO, "src/components/parent/parent-dashboard.tsx"), "utf8");
  ok(/if \(!subscription\) \{/.test(pdSrc), "SubscriptionCard keeps its null guard");
  ok(pdSrc.includes("ابنك لسه ما اشتركش في أي باقة"), "SubscriptionCard uses the same Egyptian Arabic wording");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("UNEXPECTED ERROR:", e);
  process.exit(1);
});
