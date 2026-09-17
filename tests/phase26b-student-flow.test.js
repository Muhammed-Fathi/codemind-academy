// CodeMind Academy — Phase 26B: STUDENT FULL FLOW regression pins.
//
// WHAT THIS FILE OWNS
//   Phase 26B audited the entire student lifecycle end-to-end (real HTTP over
//   the shipped route handlers, real SQLite, official 23-lesson curriculum).
//   This suite pins the defects found + fixed and the invariants the fixes
//   must never regress, in the same layers the repo's suites use:
//
//   A. SOURCE-LEVEL INVARIANTS — the Phase 26B fixes stay in the shipped code:
//        1. /api/enroll refuses an INACTIVE (closed-for-sale) plan server-side
//           (`plan.isActive` guard + the shared decision-layer copy api.276) —
//           a closed Early Bird can never be purchased by API tampering.
//        2. Payment APPROVE/REJECT notifications carry `link: null` (the
//           validated deep-link scheme) — never the dead literal "dashboard"
//           that the Phase 17 rejection corpus explicitly refuses.
//        3. /api/students/me/export-progress writes a latin1-safe
//           Content-Disposition (ASCII fallback + RFC 5987 filename*) — the
//           raw Arabic student name used to make Node reject the header and
//           the endpoint 500 for every real student.
//        4. The renewal-warning contract: EXPIRING_WINDOW_DAYS === 7 and the
//           dashboard exposes state/daysToExpiry/endDate; the student UI
//           renders the <=7-day badge + renew CTA.
//        5. The test adapter (`scripts/lib/sqlite-prisma-lite.mjs`) supports
//           `decrement` — PR2b's coupon release depends on it.
//
//   B. BEHAVIOURAL — compiled shipped code against real SQLite:
//        - the adapter's increment/decrement/set operators round-trip;
//        - the payment-ux proof message never contains a student code and the
//          destinations/proof numbers are the approved lines (student-facing
//          truth of §9/§10).
//
//   C. THE MASTER GATE — the full Phase 26B real-HTTP student-lifecycle
//      verifier runs as a child process and must exit 0
//      (scripts/verify-phase26b-student.mjs, PHASE26B_STUDENT_OK).
//
// Run: node tests/phase26b-student-flow.test.js
// Exit code: 0 = all pass, 1 = failure. Requires Node >= 22.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

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
const eq = (a, b, label) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (t) => console.log(`\n${t}`);

async function main() {
// ---------------------------------------------------------------------------
section("A1. /api/enroll — closed-for-sale plans are refused at submission");
// ---------------------------------------------------------------------------
{
  const src = read("src/app/api/enroll/route.ts");
  ok(src.includes("if (!plan.isActive)"), "A1: the isActive guard exists on the submitted plan");
  ok(
    /if \(!plan\) return err\(tApi\("api\.084"\), 404\);[\s\S]*?if \(!plan\.isActive\) return err\(tApi\("api\.276"\), 400\);/.test(src),
    "A1: guard order — missing plan → 404 api.084, INACTIVE plan → 400 api.276"
  );
  ok(
    src.includes("api.276"),
    "A1: the refusal reuses the approved decision-layer copy (api.276), not a new message"
  );
  // Post-launch: the catalogue no longer HIDES closed plans (owner decision:
  // a closed plan stays visible, flagged, unselectable). The pin now guards
  // the NEW contract: no active-only filter, active plans ordered first.
  const plansSrc = read("src/app/api/subscription-plans/route.ts");
  ok(!plansSrc.includes("isActive: true"), "A1: /api/subscription-plans no longer filters out closed plans");
  ok(plansSrc.includes('{ isActive: "desc" }'), "A1: /api/subscription-plans keeps active plans first (flagged closed stay visible)");
  // The decision layer already refused inactive plans (approval side).
  const transitions = read("src/lib/payment-transitions.ts");
  ok(
    /isActive !== true\) fail\("PLAN_NOT_FOUND"\)/.test(transitions),
    "A1: approval layer refuses an inactive plan (PLAN_NOT_FOUND) — submission and decision agree"
  );
}

// ---------------------------------------------------------------------------
section("A2. Payment decision notifications — links follow the validated scheme");
// ---------------------------------------------------------------------------
{
  const approve = read("src/app/api/admin/payments/[id]/approve/route.ts");
  const reject = read("src/app/api/admin/payments/[id]/reject/route.ts");
  ok(!approve.includes('link: "dashboard"'), "A2: approve notification no longer stores the dead 'dashboard' literal");
  ok(!reject.includes('link: "dashboard"'), "A2: reject notification no longer stores the dead 'dashboard' literal");
  ok(approve.includes("link: null") && reject.includes("link: null"), "A2: both decision notifications store NULL (no link)");
  // The scheme itself still rejects the literal (Phase 17 pin stays load-bearing).
  const links = read("src/lib/notification-links.ts");
  ok(links.includes("validateNotificationLink"), "A2: the validating module is still the link authority");
}

// ---------------------------------------------------------------------------
section("A3. Export progress — Content-Disposition is latin1-safe");
// ---------------------------------------------------------------------------
{
  const src = read("src/app/api/students/me/export-progress/route.ts");
  ok(src.includes("filename*=UTF-8''"), "A3: RFC 5987 filename* parameter present (real UTF-8 name preserved)");
  ok(
    /[^\s!-~]/g.test(src) === false || src.includes("replace(/["),
    "A3: the ASCII fallback strips non-printable/non-latin1 characters from the plain filename"
  );
  ok(
    !src.includes('filename="my-progress-${user.name'),
    "A3: the raw student name is NO LONGER interpolated straight into the header value"
  );
  ok(
    /attachment; filename="/.test(src),
    "A3: still a standards-shaped attachment header"
  );
}

// ---------------------------------------------------------------------------
section("A4. Renewal warning contract — <= 7 days, dashboard truth, UI CTA");
// ---------------------------------------------------------------------------
{
  const ent = read("src/lib/subscription-entitlement.ts");
  ok(ent.includes("EXPIRING_WINDOW_DAYS = 7"), "A4: the expiring window is exactly 7 days");
  eq(
    /EXPIRING_WINDOW_DAYS = (\d+)/.exec(ent)?.[1],
    "7",
    "A4: window literal is 7 (not 6, not 8)"
  );
  const dash = read("src/app/api/students/me/dashboard/route.ts");
  for (const key of ["daysToExpiry", "endDate", "EXPIRING"]) {
    ok(dash.includes(key), `A4: dashboard exposes ${key}`);
  }
  const ui = read("src/components/student/student-dashboard.tsx");
  ok(ui.includes("EXPIRING"), "A4: student UI handles the EXPIRING state");
  ok(ui.includes("student.168") && ui.includes("student.169"), "A4: the <=7-day badge renders the localized 'Ends in N day · renew' copy");
  ok(ui.includes("student.170"), "A4: the EXPIRED state renders the localized 'Subscription ended — renew' CTA");
  ok(/onRenew=\{\(\) => setView\("enroll"\)\}/.test(ui), "A4: the renew CTA navigates to the payment/enroll flow");
}

// ---------------------------------------------------------------------------
section("B. BEHAVIOURAL — adapter operators + payment UX truth (compiled)");
// ---------------------------------------------------------------------------
{
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p26b-test-"));
  fs.writeFileSync(
    path.join(OUT, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2020",
        lib: ["es2022"],
        module: "commonjs",
        moduleResolution: "node",
        strict: false,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")],
        baseUrl: REPO,
        paths: { "@/*": ["src/*"] },
        rootDir: REPO,
        outDir: OUT,
      },
      files: [
        path.join(REPO, "src/lib/payment-ux.ts"),
        path.join(REPO, "src/lib/i18n-dict.ts"),
        path.join(REPO, "src/lib/i18n-dict-2026.ts"),
        path.join(REPO, "src/lib/i18n-core.ts"),
      ],
    })
  );
  try {
    // Cross-platform: execFileSync passes argv directly to the child — no
    // shell, so no quoting/whitespace issues when the Node binary or the temp
    // dir lives under a path with spaces (the default Windows layout, e.g.
    // C:\Program Files\nodejs + C:\Users\<name>\AppData\Local\Temp). A shell
    // command string silently failed to START tsc there and the old catch
    // swallowed it, leaving OUT without any emitted modules.
    execFileSync(
      process.execPath,
      [require.resolve("typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")],
      { cwd: REPO, stdio: "pipe" }
    );
  } catch {
    // expected with a stub Prisma client (type errors only); tsc still emits
  }
  // Never run B on missing output: verify every module B2 loads was actually
  // emitted (payment-ux pulls in @/lib/brand, so it is pinned too). This is
  // what turns a failed tsc spawn into a clear error instead of a confusing
  // "Cannot find module .../payment-ux.js" downstream.
  for (const f of [
    "src/lib/payment-ux.js",
    "src/lib/brand.js",
    "src/lib/i18n-core.js",
    "src/lib/i18n-dict.js",
    "src/lib/i18n-dict-2026.js",
  ]) {
    if (!fs.existsSync(path.join(OUT, f))) {
      throw new Error(`tsc did not emit ${f} — cannot run section B (compile step failed to produce output)`);
    }
  }

  // B1. sqlite-prisma-lite: increment/decrement/set round-trip (real SQLite).
  {
    const DatabaseSync = require("node:sqlite").DatabaseSync;
    const mig = require(path.join(REPO, "scripts/lib/migrate-sqlite.mjs"));
    const { createSqlitePrisma } = require(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs"));
    const rawDb = new DatabaseSync(":memory:");
    mig.applyMigrations(rawDb, { withBaseSchema: true, label: "p26b-test: " });
    const client = createSqlitePrisma({
      db: rawDb,
      schemaPath: path.join(REPO, "prisma", "schema.prisma"),
    });
    const now = Date.now();
    rawDb
      .prepare(
        `INSERT INTO "Coupon" ("id","code","type","value","maxUses","usedCount","isActive","createdAt","updatedAt")
         VALUES ('c_t','P26BTEST','FIXED',10,10,5,1,?,?)`
      )
      .run(now, now);
    await5:
    for (let i = 0; i < 5; i++) {
      await client.coupon.update({ where: { id: "c_t" }, data: { usedCount: { increment: 1 } } });
    }
    const afterInc = rawDb.prepare(`SELECT "usedCount" FROM "Coupon" WHERE "id"='c_t'`).get().usedCount;
    eq(afterInc, 10, "B1: adapter increment round-trips (5 + 5 = 10)");
    await client.coupon.update({ where: { id: "c_t" }, data: { usedCount: { decrement: 1 } } });
    const afterDec = rawDb.prepare(`SELECT "usedCount" FROM "Coupon" WHERE "id"='c_t'`).get().usedCount;
    eq(afterDec, 9, "B1: adapter DECREMENT round-trips (10 - 1 = 9) — PR2b coupon release works");
    await client.coupon.update({ where: { id: "c_t" }, data: { usedCount: { set: 3 } } });
    const afterSet = rawDb.prepare(`SELECT "usedCount" FROM "Coupon" WHERE "id"='c_t'`).get().usedCount;
    eq(afterSet, 3, "B1: adapter set round-trips");
  }

  // B2. Payment UX: the student-facing proof truth (§9/§10).
  {
    const resolved = path.join(OUT, "__resolve.js");
    fs.writeFileSync(
      resolved,
      `const Module = require("module"); const orig = Module._resolveFilename;
       Module._resolveFilename = function (request, ...rest) {
         const m = /^@\\/lib\\/([\\w-]+)$/.exec(request);
         if (m) { const c = ${JSON.stringify(path.join(OUT, "src", "lib"))} + "/" + m[1] + ".js";
           if (require("fs").existsSync(c)) return c; }
         return orig.call(this, request, ...rest); };`
    );
    require(resolved);
    const Ux = require(path.join(OUT, "src/lib/payment-ux.js"));
    const I18N = require(path.join(OUT, "src/lib/i18n-core.js"));
    const t = (k, p) => I18N.translate("ar", k, p);
    eq(Ux.paymentDestinationFor("INSTAPAY"), "+20 1147422177", "B2: InstaPay destination is 01147422177");
    eq(Ux.paymentDestinationFor("ETISALAT_CASH"), "+20 1147422177", "B2: e& Cash destination is 01147422177");
    eq([...Ux.PAYMENT_PROOF_WHATSAPP_NUMBERS], ["01147422177", "01099942942"], "B2: proof numbers are the two approved lines");
    eq(Ux.PAYMENT_REVIEW_WINDOW_HOURS, 24, "B2: review window copy = up to 24h");
    eq(I18N.translate("ar", "pay.pendingTitle"), "طلب الدفع تحت المراجعة", "B2: pending state copy is the approved Arabic wording");
    const msg = Ux.buildPaymentProofMessage(
      { studentName: "أحمد محمد علي", amount: 100, method: "INSTAPAY", reference: "REF-1", senderPhone: "01012345678" },
      t
    );
    ok(!/CM-[A-Z0-9]{6}/.test(msg), "B2: proof message NEVER contains a student code");
    ok(msg.includes("100") && msg.includes("01012345678"), "B2: proof message carries the approved user-facing facts");
    const href = Ux.whatsappProofHref("01147422177", msg);
    ok(href.startsWith("https://wa.me/201147422177?text="), "B2: WhatsApp href is a safe wa.me deep link");
  }
}

// ---------------------------------------------------------------------------
section("C. MASTER GATE — the Phase 26B real-HTTP student lifecycle verifier");
// ---------------------------------------------------------------------------
{
  const script = path.join(REPO, "scripts", "verify-phase26b-student.mjs");
  ok(fs.existsSync(script), "C: scripts/verify-phase26b-student.mjs exists");
  let outStr = "";
  let code = 0;
  try {
    // execFileSync (no shell) — the verifier path and the Node binary are
    // argv entries, so spaces in either cannot break the spawn on Windows.
    outStr = execFileSync(process.execPath, [script], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    code = e.status ?? 1;
    outStr = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }
  eq(code, 0, "C: real-HTTP student lifecycle verifier exits 0");
  ok(outStr.includes("PHASE26B_STUDENT_OK"), "C: verifier printed PHASE26B_STUDENT_OK");
  const m = /PHASE26B_STUDENT_OK — (\d+) assertions passed/.exec(outStr);
  if (m) ok(Number(m[1]) >= 180, `C: verifier coverage is load-bearing (${m[1]} ≥ 180 assertions)`);
  // The two BUSINESS-FLOW GAP rows must stay honest in the matrix output.
  ok(outStr.includes("STUDENT-03"), "C: matrix reports STUDENT-03 (eligible groups / GAP-1)");
  ok(outStr.includes("STUDENT-04"), "C: matrix reports STUDENT-04 (ineligible group rejection / GAP-1)");
}

// ---------------------------------------------------------------------------
console.log(`\n============================================================`);
console.log(`phase26b student flow: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("failures:");
  for (const f of failures) console.log("  -", f);
}
process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
