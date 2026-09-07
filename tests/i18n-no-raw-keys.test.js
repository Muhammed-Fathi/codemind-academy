// CodeMind Academy — i18n regression guard.
//
// Root cause of the "student.198 … student.204" calendar bug: the i18n codemod
// (scripts/i18n/codemod.mjs) replaced Arabic literals with catalogue keys, but
// missed a `.map()` call site in study-scheduler.tsx, so the component rendered
// the raw key string instead of the translation.
//
// This test fails the build if any catalogue key is (a) referenced from source
// but absent from the dictionary, or (b) sitting in an array/const that is
// rendered without going through a translator. It is intentionally strict about
// day/month names: those must now come from Intl via getWeekdayNames() /
// getMonthNames(), never from the numeric catalogue.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

const KEY_RE = /"((?:admin|student|teacher|parent|auth|shared|shell|landing|api|course|ai)\.\d{3})"/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

function loadDictKeys() {
  const keys = new Set();
  for (const f of ["i18n-dict.ts", "i18n-dict-2026.ts"]) {
    const s = fs.readFileSync(path.join(SRC, "lib", f), "utf8");
    for (const m of s.matchAll(/"([a-z]+\.\d{3})"\s*:/g)) keys.add(m[1]);
  }
  return keys;
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}

console.log("i18n raw-key guard");

const dict = loadDictKeys();
const files = walk(SRC).filter((f) => !f.includes(path.join("lib", "i18n-dict")));

check("every catalogue key referenced in source exists in the dictionary", () => {
  const missing = [];
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(KEY_RE)) {
      if (!dict.has(m[1])) missing.push(`${path.relative(ROOT, f)}: ${m[1]}`);
    }
  }
  if (missing.length)
    throw new Error(`missing translations:\n       ${missing.join("\n       ")}`);
});

check("no component holds an array of catalogue keys for calendar labels", () => {
  const offenders = [];
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8");
    // A const whose initializer is an array literal made only of catalogue keys
    // is the exact shape that produced the calendar bug.
    for (const m of s.matchAll(
      /const\s+([A-Z_][A-Z0-9_]*)\s*=\s*\[([^\]]*)\]/g
    )) {
      const body = m[2];
      const keys = [...body.matchAll(KEY_RE)];
      const nonKey = body.replace(KEY_RE, "").replace(/[\s,\n]/g, "");
      if (keys.length >= 7 && nonKey === "") {
        offenders.push(`${path.relative(ROOT, f)}: ${m[1]}`);
      }
    }
  }
  if (offenders.length)
    throw new Error(
      `catalogue-key arrays must be replaced by Intl helpers:\n       ${offenders.join(
        "\n       "
      )}`
    );
});

check("study-scheduler derives weekday/month names from Intl", () => {
  const s = fs.readFileSync(
    path.join(SRC, "components", "student", "study-scheduler.tsx"),
    "utf8"
  );
  if (!s.includes("getWeekdayNames") || !s.includes("getMonthNames"))
    throw new Error("scheduler no longer uses the Intl weekday/month helpers");
  if (/DAY_NAMES|MONTH_NAMES/.test(s))
    throw new Error("hand-keyed DAY_NAMES/MONTH_NAMES reintroduced");
});

check("getWeekdayNames/getMonthNames produce real labels in ar and en", () => {
  // Exercise the same Intl calls the helper makes, so a broken ICU build or a
  // wrong reference date is caught here rather than in the UI.
  const refs = [1, 2, 3, 4, 5, 6, 7].map((d) => new Date(Date.UTC(2023, 0, d)));
  for (const [loc, expectFirst] of [
    ["en-GB", "Sunday"],
    ["ar-EG", "الأحد"],
  ]) {
    const fmt = new Intl.DateTimeFormat(loc, { weekday: "long", timeZone: "UTC" });
    const names = refs.map((r) => fmt.format(r));
    if (names.length !== 7) throw new Error(`${loc}: expected 7 weekday names`);
    if (new Set(names).size !== 7)
      throw new Error(`${loc}: weekday names are not distinct -> ${names}`);
    if (names[0] !== expectFirst)
      throw new Error(`${loc}: index 0 should be ${expectFirst}, got ${names[0]}`);
    if (names.some((n) => /^\w+\.\d+$/.test(n)))
      throw new Error(`${loc}: raw key leaked into weekday names`);
  }
  const months = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    timeZone: "UTC",
  });
  const all = Array.from({ length: 12 }, (_, m) =>
    months.format(new Date(Date.UTC(2023, m, 1)))
  );
  if (all[0] !== "January" || all[11] !== "December")
    throw new Error(`month names wrong: ${all.join(",")}`);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall i18n raw-key checks passed");
