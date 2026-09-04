// CodeMind Academy — Monthly Report "no subscription" regression tests (offline).
// Compiles src/lib/monthly-report.ts with tsc and asserts the Monthly Report
// renders safely when a student has NO subscription — GET /api/parents/me/dashboard
// returns `subscription: null` in that case, which previously crashed the
// component with "TypeError: Cannot read properties of null (reading 'status')".
//
// Run: node tests/monthly-report-no-subscription.test.js
// Exit code: 0 = all pass, 1 = failure.

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-monthly-report-test-"));

const TSCONFIG = path.join(OUT, "tsconfig.json");
fs.writeFileSync(
  TSCONFIG,
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      strict: true,
      skipLibCheck: true,
      noImplicitReturns: true,
      outDir: OUT,
    },
    files: [path.join(REPO, "src/lib/monthly-report.ts")],
  })
);
execSync(`npx tsc -p ${TSCONFIG}`, { cwd: REPO, stdio: "pipe" });

const M = require(path.join(OUT, "monthly-report.js"));

let pass = 0,
  fail = 0;
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", label);
  }
};
const safeCall = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: e };
  }
};

// --- Regression: student with NO subscription (API payload: null) ---
const none = safeCall(() => M.formatSubscriptionStatus(null));
ok(none.ok, "null subscription must not throw");
ok(
  none.ok && none.value.statusLabel === M.NO_SUBSCRIPTION_STATUS_LABEL,
  "null → fallback status label"
);
ok(none.ok && none.value.planName === null, "null → no plan name rendered");
ok(
  none.ok && none.value.daysLeftLabel === M.NO_VALUE_PLACEHOLDER,
  "null → placeholder days label"
);

// Defensive: undefined (loose JS callers / older cached payloads)
const undef = safeCall(() => M.formatSubscriptionStatus(undefined));
ok(undef.ok, "undefined subscription must not throw");
ok(
  undef.ok && undef.value.statusLabel === M.NO_SUBSCRIPTION_STATUS_LABEL,
  "undefined → fallback status label"
);

// --- Active subscription behaves exactly like the old render path ---
const active = safeCall(() =>
  M.formatSubscriptionStatus({ status: "ACTIVE", planName: "6 Months", daysLeft: 120 })
);
ok(active.ok, "active subscription must not throw");
ok(active.ok && active.value.statusLabel === "Active", "ACTIVE maps to 'Active'");
ok(active.ok && active.value.planName === "6 Months", "plan name preserved");
ok(active.ok && active.value.daysLeftLabel === "120", "daysLeft rendered as string");

// --- Non-ACTIVE status passes through verbatim (old behavior) ---
const pending = safeCall(() =>
  M.formatSubscriptionStatus({ status: "PENDING", planName: "1 Month", daysLeft: 0 })
);
ok(pending.ok && pending.value.statusLabel === "PENDING", "non-ACTIVE status passes through");
ok(pending.ok && pending.value.daysLeftLabel === "0", "zero daysLeft is not treated as missing");

// --- Subscription row exists but has no endDate → daysLeft: null ---
const noEnd = safeCall(() =>
  M.formatSubscriptionStatus({ status: "ACTIVE", planName: "—", daysLeft: null })
);
ok(noEnd.ok, "null daysLeft must not throw");
ok(
  noEnd.ok && noEnd.value.daysLeftLabel === M.NO_VALUE_PLACEHOLDER,
  "null daysLeft → placeholder"
);

// --- Degenerate payload: empty strings degrade gracefully ---
const empty = safeCall(() =>
  M.formatSubscriptionStatus({ status: "", planName: "", daysLeft: 10 })
);
ok(empty.ok, "empty-string payload must not throw");
ok(
  empty.ok && empty.value.statusLabel === M.NO_SUBSCRIPTION_STATUS_LABEL,
  "empty status → fallback label"
);
ok(empty.ok && empty.value.planName === null, "empty plan name → suppressed");

console.log(`\nmonthly report (no subscription): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
