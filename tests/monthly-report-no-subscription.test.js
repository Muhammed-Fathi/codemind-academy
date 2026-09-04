// CodeMind Academy — Monthly Report "no subscription" regression tests (offline).
// Compiles src/lib/monthly-report.ts with tsc and asserts the Monthly Report
// renders safely when a student has NO subscription — GET /api/parents/me/dashboard
// returns `subscription: null` in that case, which previously crashed the
// component with "TypeError: Cannot read properties of null (reading 'status')".
// Also pins the user-facing Egyptian Arabic labels for every SubscriptionStatus
// enum value (PENDING / ACTIVE / EXPIRED / CANCELLED) so raw English enum
// values never reach the parent-facing report.
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
ok(none.ok && none.value.noSubscription === true, "null → noSubscription flag set");
ok(
  none.ok && none.value.statusLabel === M.NO_SUBSCRIPTION_STATUS_LABEL,
  "null → fallback status label"
);
ok(
  none.ok && none.value.statusLabel === "ابنك لسه ما اشتركش في أي باقة.",
  "null → Egyptian Arabic no-subscription message"
);
ok(
  none.ok && none.value.hint === M.NO_SUBSCRIPTION_HINT && !!none.value.hint,
  "null → hint message provided"
);
ok(none.ok && /يشترك/.test(none.value.hint), "hint is Arabic, not English");
ok(none.ok && none.value.planName === null, "null → no plan name rendered");
ok(
  none.ok && none.value.daysLeftLabel === M.NO_VALUE_PLACEHOLDER,
  "null → placeholder days label"
);

// Defensive: undefined (loose JS callers / older cached payloads)
const undef = safeCall(() => M.formatSubscriptionStatus(undefined));
ok(undef.ok, "undefined subscription must not throw");
ok(
  undef.ok &&
    undef.value.noSubscription === true &&
    undef.value.statusLabel === M.NO_SUBSCRIPTION_STATUS_LABEL,
  "undefined → behaves like no subscription"
);

// --- Enum → user-facing Egyptian Arabic labels (never raw English) ---
const cases = [
  ["ACTIVE", "نشط"],
  ["PENDING", "مستني التفعيل"],
  ["EXPIRED", "منتهي"],
  ["CANCELLED", "ملغي"],
];
for (const [status, label] of cases) {
  const r = safeCall(() =>
    M.formatSubscriptionStatus({ status, planName: "6 Months", daysLeft: 120 })
  );
  ok(r.ok, `${status} must not throw`);
  ok(r.ok && r.value.statusLabel === label, `${status} → "${label}"`);
  ok(r.ok && r.value.noSubscription === false, `${status} → noSubscription false`);
  ok(r.ok && r.value.hint === null, `${status} → no empty-state hint`);
  ok(r.ok && r.value.statusLabel !== status, `${status} not rendered as raw enum`);
}

// --- Active subscription keeps plan name and days ---
const active = safeCall(() =>
  M.formatSubscriptionStatus({ status: "ACTIVE", planName: "6 Months", daysLeft: 120 })
);
ok(active.ok && active.value.planName === "6 Months", "plan name preserved");
ok(active.ok && active.value.daysLeftLabel === "120", "daysLeft rendered as string");

// --- Zero daysLeft is a real value, not "missing" ---
const zero = safeCall(() =>
  M.formatSubscriptionStatus({ status: "ACTIVE", planName: "1 Month", daysLeft: 0 })
);
ok(zero.ok && zero.value.daysLeftLabel === "0", "zero daysLeft is not treated as missing");

// --- Subscription row exists but has no endDate → daysLeft: null ---
const noEnd = safeCall(() =>
  M.formatSubscriptionStatus({ status: "ACTIVE", planName: "—", daysLeft: null })
);
ok(noEnd.ok, "null daysLeft must not throw");
ok(
  noEnd.ok && noEnd.value.daysLeftLabel === M.NO_VALUE_PLACEHOLDER,
  "null daysLeft → placeholder"
);
ok(noEnd.ok && noEnd.value.planName === null, "API '—' plan fallback is suppressed");

// --- Degenerate payload: empty strings degrade gracefully ---
const empty = safeCall(() =>
  M.formatSubscriptionStatus({ status: "", planName: "", daysLeft: 10 })
);
ok(empty.ok, "empty-string payload must not throw");
ok(
  empty.ok && empty.value.statusLabel === "",
  "unknown/empty status falls back to raw value (defensive only)"
);
ok(empty.ok && empty.value.planName === null, "empty plan name → suppressed");

// --- Unknown future enum value: passes through rather than throwing ---
const future = safeCall(() =>
  M.formatSubscriptionStatus({ status: "SUSPENDED", planName: "", daysLeft: null })
);
ok(future.ok && future.value.statusLabel === "SUSPENDED", "unknown status passes through safely");

console.log(`\nmonthly report (no subscription): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
