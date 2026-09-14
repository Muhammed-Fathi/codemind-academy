// CodeMind Academy — Phase 25 PR3: PAYMENT EXPERIENCE / UI proof.
//
// Three legs, in the repo's own test style:
//
//   §1 SOURCE PINS — the scope + privacy + security invariants that must hold
//      in the shipped source: no hardcoded course/group, no screenshot upload,
//      exactly the two approved WhatsApp numbers, the PR2b decision endpoints
//      called from ONE place with ONE kind of body, no reviewer/spoof fields,
//      and every new UI string present in BOTH dictionaries.
//
//   §2 ADMIN READ CONTRACT — the SHIPPED `GET /api/admin/payments` handler
//      (compiled byte-for-byte) driven against a mutation-hostile fake db:
//      the review projection is truthful (sender phone, requested plan/group,
//      duplicate-reference + newer-request warnings, the student's CURRENT
//      entitlement via the shared pure policy) and writes NOTHING, never
//      exposing `reviewedByUserId`.
//
//   §3 RENDER HARNESS — tests/helpers/payment-ux-harness.mts renders the
//      SHIPPED components in jsdom (student payment page, submitted/pending /
//      renewal / grandfathered / rejected states, the dashboard panel, the
//      admin review drawer incl. approve / group override / rejection
//      validation / domain errors) and asserts the DOM.
//
// Run: node tests/payment-experience-phase25-pr3.test.js
// Exit: 0 = all pass, 1 = failure. Requires Node >= 22.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const { execFileSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

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
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// The PR3 surface under test.
const PR3_FILES = [
  "src/lib/payment-ux.ts",
  "src/components/shared/payment-proof.tsx",
  "src/components/auth/enroll-view.tsx",
  "src/components/student/payment-status.tsx",
  "src/components/student/student-dashboard.tsx",
  "src/components/admin/payment-review-drawer.tsx",
  "src/components/admin/admin-dashboard.tsx",
  "src/app/api/admin/payments/route.ts",
];

// ---------------------------------------------------------------------------
section("1. Source pins — scope, privacy, security, i18n completeness");
// ---------------------------------------------------------------------------
{
  const enroll = read("src/components/auth/enroll-view.tsx");
  ok(!enroll.includes("Programming & AI"), "1.1 no hardcoded course name in the payment UI");
  ok(!/"Group A"/.test(enroll), "1.2 no hardcoded group name in the payment UI");
  ok(!enroll.includes("brand.defaultPrice"), "1.3 no assumed default price — the amount comes from the selected plan");
  ok(enroll.includes("/api/courses?catalog=1"), "1.4 the course picker still requests the explicit catalogue variant");
  ok(
    /courseName: course \? pickAuto\(course\.nameAr, course\.name\)/.test(enroll),
    "1.5 the summary uses the ACTUAL selected course object"
  );
  ok(/groupName: group\?\.name/.test(enroll), "1.6 the summary uses the ACTUAL selected group object");
  ok(/planName: plan \? pickAuto\(plan\.nameAr, plan\.name\)/.test(enroll), "1.7 the summary uses the ACTUAL selected plan object");

  // No screenshot upload anywhere in the payment experience.
  for (const f of PR3_FILES) {
    const src = read(f);
    ok(!/type="file"/.test(src) || f === "src/components/admin/admin-dashboard.tsx", `${f}: no file input in the payment experience`);
    ok(!src.includes("MediaAsset"), `${f}: no MediaAsset`);
    ok(!src.includes("/api/admin/media-uploads"), `${f}: no upload endpoint`);
    ok(!/\bR2_[A-Z_]+\b/.test(src) && !/presign/i.test(src), `${f}: no R2/presigned upload wiring`);
  }
  // The only file input in the admin dashboard is the pre-existing xlsx import.
  const adminSrc = read("src/components/admin/admin-dashboard.tsx");
  ok(
    (adminSrc.match(/type="file"/g) || []).length === 1 &&
      adminSrc.includes('accept=".xlsx,.xls"'),
    "1.8 the single admin file input remains the xlsx payment import"
  );

  // WhatsApp numbers: exactly the two approved lines, declared once.
  const ux = read("src/lib/payment-ux.ts");
  const numbersBlock = /PAYMENT_PROOF_WHATSAPP_NUMBERS[^=]*=\s*\[([\s\S]*?)\]/.exec(ux)?.[1] || "";
  const numbers = (numbersBlock.match(/"\d+"/g) || []).map((n) => n.replace(/"/g, ""));
  ok(
    JSON.stringify(numbers) === JSON.stringify(["01147422177", "01099942942"]),
    `1.9 exactly the two approved WhatsApp proof numbers (got ${numbers.join(",")})`
  );
  for (const f of PR3_FILES) {
    if (f === "src/lib/payment-ux.ts") continue;
    ok(
      !read(f).includes("01099942942"),
      `${f}: proof numbers are not re-declared outside payment-ux`
    );
  }

  // The decision endpoints are called from ONE place, with ONE body shape.
  const decisionCallers = PR3_FILES.filter((f) =>
    /\/api\/admin\/payments\/[^"'`]*\/(?:approve|reject|\$\{action\})/.test(read(f))
  );
  ok(
    JSON.stringify(decisionCallers) === JSON.stringify(["src/components/admin/payment-review-drawer.tsx"]),
    `1.10 approve/reject are called ONLY from the review drawer (got ${decisionCallers.join(",") || "none"})`
  );
  const drawer = read("src/components/admin/payment-review-drawer.tsx");
  ok(!drawer.includes("reviewedByUserId"), "1.11 the drawer never sends or reads a reviewer id");
  ok(
    !/scenario/.test(/const body =[\s\S]*?;/.exec(drawer)?.[0] || ""),
    "1.12 the decision body never carries a scenario"
  );
  ok(
    /overrideGroupId\s*\n?\s*\?\s*\{\s*groupId: overrideGroupId\s*\}\s*\n?\s*:\s*\{\}/.test(drawer),
    "1.13 approve sends {} — or { groupId } only when an override was selected"
  );
  ok(
    /\{\s*reason: normalizeRejectionReasonForUi\(reason\) \?\? ""\s*\}/.test(drawer),
    "1.14 reject sends exactly { reason }"
  );
  for (const forbidden of ["userId:", "studentId:", "subscriptionId:", "status:"]) {
    const bodyRegion = /const body =[\s\S]*?;/.exec(drawer)?.[0] || "";
    ok(!bodyRegion.includes(forbidden), `1.15 the decision body never carries ${forbidden}`);
  }
  ok(!adminSrc.includes("/approve`") && !adminSrc.includes("/reject`"), "1.16 the queue view no longer calls the decision endpoints directly");

  // No client-side re-implementation of the decision rules.
  for (const f of PR3_FILES.filter((f) => !f.startsWith("src/app/api/"))) {
    const src = read(f);
    ok(!/\bdb\./.test(src), `${f}: no direct database access from the presentation layer`);
  }
  ok(
    !ux.includes("approvePayment") && !ux.includes("rejectPayment"),
    "1.17 the presentation module never touches the decision service"
  );

  // Backend transition service untouched by PR3 (the PR2b authority).
  const transitions = read("src/lib/payment-transitions.ts");
  ok(transitions.includes("export async function approvePayment"), "1.18 approvePayment still exists unchanged in shape");
  ok(transitions.includes("export async function rejectPayment"), "1.19 rejectPayment still exists unchanged in shape");
  ok(
    transitions.includes('STALE_PAYMENT') && transitions.includes("GROUP_FULL"),
    "1.20 the domain-error set is intact"
  );

  // ---- Method availability safety: a destination-less method can never be
  //      selected or submitted (defense in depth; the server stays authority).
  const brandSrc = read("src/lib/brand.ts");
  ok(/SUPPORT_PHONE_DISPLAY = "\+20 1147422177"/.test(brandSrc), "1.40 the payment/support line constant is unchanged");
  ok(/instapay: SUPPORT_PHONE_DISPLAY/.test(brandSrc), "1.41 the InstaPay destination is unchanged");
  ok(/eCash: SUPPORT_PHONE_DISPLAY/.test(brandSrc), "1.42 the e& Cash destination is unchanged");
  ok(/vodafoneCash: null/.test(brandSrc), "1.43 Vodafone Cash still has no configured destination");
  ok(
    /export function paymentMethodAvailable\(method: unknown\): boolean \{[\s\S]{0,400}isLaunchPaymentMethod\(method\)[\s\S]{0,400}paymentDestinationFor\(method\)[\s\S]{0,400}trim\(\)\.length > 0/.test(ux),
    "1.44 availability = launch method AND a non-empty configured destination"
  );
  ok(
    /else if \(!paymentMethodAvailable\(method\)\)\s*next\.method = t\("pay\.methodUnavailable"\);/.test(enroll),
    "1.45 validation blocks an unavailable method before /api/enroll is called"
  );
  ok(
    /const available = paymentMethodAvailable\(m\.key\);[\s\S]{0,120}const disabled = comingSoon \|\| !available;/.test(enroll),
    "1.46 the selector disables a destination-less method"
  );
  ok(
    /comingSoon \? t\("pay\.methodComingSoon"\) : t\("pay\.methodUnavailable"\)/.test(enroll),
    "1.47 the disabled tile states why it is unavailable"
  );
  ok(
    !/paymentDestinationFor\(/.test(enroll),
    "1.48 the component never re-implements the destination rule — one shared helper"
  );
  ok(
    /"pay\.methodUnavailable":\s*\{\s*ar:\s*"مش متاحة حاليًا"/.test(read("src/lib/i18n-dict-2026.ts")),
    "1.49 the unavailable-method copy exists in Arabic"
  );

  // i18n: every key the PR3 UI asks for exists with non-empty ar + en.
  const dict = {};
  const dictSrc = read("src/lib/i18n-dict-2026.ts") + read("src/lib/i18n-dict.ts");
  for (const m of dictSrc.matchAll(/"([a-z][\w]*(?:\.[A-Za-z0-9_]+)+)":\s*\{\s*ar:\s*"((?:[^"\\]|\\.)*)",\s*en:\s*"((?:[^"\\]|\\.)*)"/g)) {
    dict[m[1]] = { ar: m[2], en: m[3] };
  }
  const usedKeys = new Set();
  for (const f of PR3_FILES) {
    const src = read(f);
    for (const m of src.matchAll(/\b(?:t|tr)\(\s*"([a-z][\w]*\.[A-Za-z0-9_.]+)"/g)) usedKeys.add(m[1]);
    for (const m of src.matchAll(/desc: "([a-z][\w]*\.[A-Za-z0-9_.]+)"/g)) usedKeys.add(m[1]);
  }
  for (const m of ux.matchAll(/"(pay\.[A-Za-z0-9_.]+)"/g)) usedKeys.add(m[1]);
  const missing = [...usedKeys].filter((k) => !dict[k]);
  const empty = [...usedKeys].filter((k) => dict[k] && (!dict[k].ar.trim() || !dict[k].en.trim()));
  ok(usedKeys.size > 100, `1.21 PR3 UI keys collected (${usedKeys.size})`);
  ok(missing.length === 0, `1.22 every PR3 key exists in the dictionary (missing: ${missing.join(",") || "none"})`);
  ok(empty.length === 0, `1.23 every PR3 key has non-empty ar + en (empty: ${empty.join(",") || "none"})`);

  // The product-language rules.
  const allStudentCopy = Object.values(dict)
    .map((v) => `${v.ar} ${v.en}`)
    .join("\n");
  ok(!allStudentCopy.includes("تفعيل الأكونت"), "1.24 no dictionary string says 'activate the account'");
  ok(dict["pay.activateMeaning"]?.ar === "تفعيل اشتراكك وفتح محتوى الكورس", "1.25 activation wording is subscription-first");
  ok(dict["pay.pendingTitle"]?.ar === "طلب الدفع تحت المراجعة", "1.26 pending wording");
  ok(dict["pay.rejectedTitle"]?.ar === "تم رفض طلب الدفع", "1.27 rejected wording");
  ok(dict["pay.confirmedTitle"]?.ar === "تم تأكيد اشتراكك", "1.28 approved wording");
  ok(dict["pay.renewMeaning"]?.ar === "تجديد اشتراكك", "1.29 renewal wording");
  ok(
    (dict["pay.oneNumberOnly"]?.ar || "").includes("رقم واحد فقط"),
    "1.30 the ONE-number-only rule is stated in Arabic"
  );
  ok(
    /export const PAYMENT_REVIEW_WINDOW_HOURS = 24;/.test(ux),
    "1.31a the review window is 24 hours (a single constant, never a shorter promise)"
  );
  ok(
    (dict["pay.reviewTime"]?.ar || "").includes("{p1}") &&
      (dict["pay.reviewTime"]?.ar || "").includes("ساعة"),
    "1.31b the review-window copy is parameterized by that constant"
  );
  ok(
    (dict["pay.errorGroupFull"]?.ar || "").includes("اختار جروب تاني"),
    "1.32 GROUP_FULL copy tells the admin to choose another group"
  );
  ok(
    (dict["pay.errorStale"]?.ar || "").includes("أحدث"),
    "1.33 STALE_PAYMENT copy points at the newer request"
  );
  ok(
    (dict["pay.proofMessage"]?.ar || "").includes("رقم العملية"),
    "1.34 the WhatsApp proof message carries the transaction reference"
  );
  ok(!(dict["pay.proofMessage"]?.ar || "").includes("CM-"), "1.35 the proof message template carries no student code");
}

// ---------------------------------------------------------------------------
section("2. Admin read contract — the SHIPPED handler over a mutation-hostile db");
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p25pr3-"));
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
      path.join(REPO, "src/app/api/admin/payments/route.ts"),
      path.join(REPO, "src/lib/payment-submission.ts"),
      path.join(REPO, "src/lib/subscription-entitlement.ts"),
      path.join(REPO, "src/lib/registration.ts"),
    ],
  })
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch {
  /* the emitted files are checked next (repo harness convention) */
}
const COMPILED = {
  route: path.join(OUT, "app/api/admin/payments/route.js"),
  paymentSubmission: path.join(OUT, "lib/payment-submission.js"),
  entitlement: path.join(OUT, "lib/subscription-entitlement.js"),
};
for (const [name, file] of Object.entries(COMPILED)) {
  if (!fs.existsSync(file)) throw new Error(`tsc did not emit ${name} (${file})`);
}

// Minimal shims: `next/server` (type-only in the route), `@/lib/db` (the
// mutation-hostile fake below) and `@/lib/api` (the ADMIN gate is asserted
// separately by the security suites; here it is a pass-through).
fs.writeFileSync(path.join(OUT, "next-server-stub.js"), "module.exports = { NextRequest: class {} };\n");
fs.writeFileSync(
  path.join(OUT, "api-stub.js"),
  "module.exports = { ok: (d) => d, err: (m, s) => ({ error: m, status: s }), requireRole: async () => globalThis.__P3_ROLE__() };\n"
);
fs.writeFileSync(path.join(OUT, "fake-db.js"), "module.exports = globalThis.__P3_DB__;\n");
fs.writeFileSync(
  path.join(OUT, "prisma-stub.js"),
  'module.exports = new Proxy({}, { get: () => function noop() {} });\n'
);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const PAYMENTS = [
  {
    id: "pay-new",
    userId: "u1",
    subscriptionId: "sub-1",
    amount: 1250,
    method: "INSTAPAY",
    status: "PENDING",
    reference: "REF-1",
    notes: "Coupon: WELCOME10 (-100 EGP)",
    createdAt: new Date(NOW - 1 * DAY),
    senderPhone: "01147422177",
    requestedGroupId: "g1",
    requestedPlanId: "plan1",
    rejectionReason: null,
    reviewedAt: null,
    reviewedByUserId: "admin-1",
    user: { id: "u1", name: "أحمد محمد", email: "a@example.com", phone: "01000000000", role: "STUDENT" },
    subscription: { id: "sub-1", status: "PENDING", plan: { nameAr: null } },
  },
  {
    id: "pay-dup",
    userId: "u1",
    subscriptionId: "sub-1",
    amount: 900,
    method: "ETISALAT_CASH",
    status: "PENDING",
    reference: "ref-1", // same reference, different case → duplicate warning
    notes: null,
    createdAt: new Date(NOW - 5 * DAY),
    senderPhone: "01099942942",
    requestedGroupId: "g1",
    requestedPlanId: "plan1",
    rejectionReason: null,
    reviewedAt: null,
    reviewedByUserId: null,
    user: { id: "u1", name: "أحمد محمد", email: "a@example.com", phone: "01000000000", role: "STUDENT" },
    subscription: { id: "sub-1", status: "PENDING", plan: { nameAr: null } },
  },
  {
    id: "pay-rejected",
    userId: "u2",
    subscriptionId: null,
    amount: 700,
    method: "INSTAPAY",
    status: "REJECTED",
    reference: "REF-9",
    notes: null,
    createdAt: new Date(NOW - 9 * DAY),
    senderPhone: "01099942942",
    requestedGroupId: "g-deleted",
    requestedPlanId: "plan-deleted",
    rejectionReason: "المبلغ المحول أقل من المطلوب",
    reviewedAt: new Date(NOW - 8 * DAY),
    reviewedByUserId: "admin-1",
    user: { id: "u2", name: "سارة علي", email: "s@example.com", phone: null, role: "STUDENT" },
    subscription: null,
  },
];
const STUDENTS = [
  {
    id: "stu-1",
    userId: "u1",
    groupId: "g1",
    parentPhone: "01222222222",
    group: { id: "g1", name: "مجموعة النخبة المسائية", isActive: true, courseId: "course-x" },
    subscription: {
      id: "sub-1",
      status: "ACTIVE",
      startDate: new Date(NOW - 30 * DAY),
      endDate: new Date(NOW + 300 * DAY),
      plan: { id: "plan1", name: "Gold Plan", nameAr: "الباقة الذهبية" },
    },
  },
  {
    id: "stu-2",
    userId: "u2",
    groupId: null,
    parentPhone: null,
    group: null,
    subscription: null,
  },
];
const GROUPS = [
  { id: "g1", name: "مجموعة النخبة المسائية", isActive: true, capacity: 20, courseId: "course-x", schedule: "Sat & Tue", _count: { students: 19 } },
];
const PLANS = [
  { id: "plan1", name: "Gold Plan", nameAr: "الباقة الذهبية", durationMonths: 3, price: 1250, isActive: true },
];

const mutations = [];
const mutationSpy = (name) => () => {
  mutations.push(name);
  throw new Error(`unexpected write from the admin read route: ${name}`);
};
globalThis.__P3_DB__ = {
  db: {
    payment: {
      count: async ({ where }) =>
        PAYMENTS.filter((p) => !where?.status || p.status === where.status).length,
      findMany: async (args = {}) => {
        const rows = PAYMENTS.filter((p) => !args.where?.status || p.status === args.where.status);
        if (args.select) {
          // the whole-queue PENDING projection (duplicate + newer-request hints)
          return rows.map((p) => ({
            id: p.id,
            userId: p.userId,
            reference: p.reference,
            createdAt: p.createdAt,
          }));
        }
        const skip = args.skip ?? 0;
        const take = args.take ?? rows.length;
        return [...rows]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(skip, skip + take);
      },
      update: mutationSpy("payment.update"),
      updateMany: mutationSpy("payment.updateMany"),
      create: mutationSpy("payment.create"),
      delete: mutationSpy("payment.delete"),
    },
    subscriptionPlan: {
      findMany: async ({ where }) => PLANS.filter((p) => where.id.in.includes(p.id)),
      update: mutationSpy("subscriptionPlan.update"),
    },
    group: {
      findMany: async ({ where }) => GROUPS.filter((g) => where.id.in.includes(g.id)),
      update: mutationSpy("group.update"),
    },
    student: {
      findMany: async ({ where }) => STUDENTS.filter((s) => where.userId.in.includes(s.userId)),
      update: mutationSpy("student.update"),
      count: async () => 0,
    },
    subscription: { update: mutationSpy("subscription.update"), create: mutationSpy("subscription.create") },
    $transaction: mutationSpy("$transaction"),
  },
};
globalThis.__P3_ROLE__ = () => ({ user: { id: "admin-1", role: "ADMIN" } });

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "next/server") return path.join(OUT, "next-server-stub.js");
  if (request === "@/lib/db") return path.join(OUT, "fake-db.js");
  if (request === "@/lib/api") return path.join(OUT, "api-stub.js");
  if (request === "@prisma/client") return path.join(OUT, "prisma-stub.js");
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(OUT, "lib", `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return realResolve.call(this, request, ...rest);
};

const adminPaymentsRoute = require(COMPILED.route);

async function readQueue(query = "") {
  const req = { url: `http://localhost/api/admin/payments${query}` };
  return adminPaymentsRoute.GET(req);
}

(async () => {
  const data = await readQueue("");
  const rows = data.payments;
  ok(rows.length === 3, `2.1 all rows returned (${rows.length})`);
  ok(mutations.length === 0, `2.2 the read route performed no writes (${mutations.join(",") || "none"})`);

  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const newest = byId["pay-new"];
  const dup = byId["pay-dup"];
  const rejected = byId["pay-rejected"];

  ok(newest.senderPhone === "01147422177", "2.3 sender phone exposed for review");
  ok(newest.requestedPlan?.nameAr === "الباقة الذهبية", "2.4 requested plan resolved with its Arabic name");
  ok(newest.requestedPlan?.durationMonths === 3, "2.5 requested plan duration exposed");
  ok(newest.requestedGroup?.name === "مجموعة النخبة المسائية", "2.6 requested group resolved");
  ok(newest.requestedGroup?.seatsUsed === 19 && newest.requestedGroup?.capacity === 20, "2.7 group capacity exposed (convenience only)");
  ok(newest.requestedGroup?.courseId === "course-x", "2.8 requested group course context exposed (scopes the override list)");
  ok(newest.duplicateReference === true, "2.9 duplicate reference flagged across case/whitespace variants");
  ok(dup.duplicateReference === true, "2.10 both sides of a duplicate pair are flagged");
  ok(newest.isLatestPending === true, "2.11 the newest pending request is authoritative");
  ok(dup.isLatestPending === false, "2.12 an older pending request is badged as non-authoritative");
  ok(rejected.isLatestPending === null, "2.13 decided rows carry no stale hint");
  ok(rejected.rejectionReason === "المبلغ المحول أقل من المطلوب", "2.14 rejection reason exposed");
  ok(rejected.reviewedAt instanceof Date, "2.15 reviewedAt exposed");
  ok(rejected.requestedPlan === null && rejected.requestedGroup === null, "2.16 dangling plan/group ids read null, never an error");

  const ctx1 = newest.studentContext;
  ok(!!ctx1 && ctx1.id === "stu-1", "2.17 student context resolved");
  ok(ctx1.groupName === "مجموعة النخبة المسائية", "2.18 current group exposed");
  ok(ctx1.currentPlanName === "الباقة الذهبية", "2.19 current plan exposed");
  ok(ctx1.state === "ACTIVE" && ctx1.accessAllowed === true, "2.20 current entitlement labelled by the shared policy");
  ok(ctx1.hasSubscription === true && ctx1.grandfathered === false, "2.21 entitlement flags truthful");
  ok(ctx1.courseId === "course-x", "2.22 current group course exposed");
  const ctx2 = rejected.studentContext;
  ok(!!ctx2 && ctx2.accessAllowed === false && ctx2.state === "NONE", "2.23 an unentitled student reads as unentitled");
  ok(ctx2.groupName === null, "2.24 no group reads null");

  const serialized = JSON.stringify(data);
  ok(!serialized.includes("reviewedByUserId"), "2.25 the reviewer id is never exposed to the admin UI");
  ok(!serialized.includes("admin-1"), "2.26 no reviewer identity leaks through any field");
  ok(data.pagination.total === 3 && data.pagination.page === 1, "2.27 pagination contract unchanged");

  const pendingOnly = await readQueue("?status=PENDING");
  ok(pendingOnly.payments.length === 2, "2.28 status filter still works");
  ok(mutations.length === 0, "2.29 still zero writes");

  // The ADMIN gate is the route's only authorization input.
  globalThis.__P3_ROLE__ = () => ({ error: { error: "Forbidden", status: 403 } });
  const denied = await readQueue("");
  ok(denied && denied.status === 403, "2.30 a non-admin is refused by the route gate");
  globalThis.__P3_ROLE__ = () => ({ user: { id: "admin-1", role: "ADMIN" } });

  // -------------------------------------------------------------------------
  section("3. Render harness (jsdom, shipped components)");
  // -------------------------------------------------------------------------
  let hout = "";
  try {
    hout = execFileSync(
      process.execPath,
      [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "tests/helpers/payment-ux-harness.mts")],
      { cwd: REPO, encoding: "utf8", env: { ...process.env, NODE_ENV: "development" } }
    );
  } catch (e) {
    hout = `${e.stdout || ""}${e.stderr || ""}`;
  }
  const hj = /HARNESS_JSON (\{[\s\S]*?\})\s*$/m.exec(hout.trim());
  ok(!!hj, "3.1 the render harness reported a result");
  if (hj) {
    const result = JSON.parse(hj[1]);
    ok(result.fail === 0, `3.2 render harness assertions all pass (${result.pass} passed, ${result.fail} failed: ${(result.failures || []).join(" | ")})`);
    ok(result.pass >= 170, `3.3 render harness coverage is substantial (${result.pass} assertions)`);
  }

  Module._resolveFilename = realResolve;

  console.log("\n" + "=".repeat(60));
  if (fail > 0) {
    console.error(`payment-experience-phase25-pr3: ${pass} passed, ${fail} FAILED`);
    failures.forEach((f) => console.error("  -", f));
    process.exit(1);
  }
  console.log(`payment-experience-phase25-pr3: ${pass} passed, 0 failed`);
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
