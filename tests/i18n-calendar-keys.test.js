// CodeMind Academy — Calendar / i18n key-leak invariants (offline, source-level).
//
// Background
// ----------
// The study scheduler rendered "student.198" … "student.204" to end users
// instead of weekday names. The catalogue entries were CORRECT; the bug was
// that the component held an array of raw dict KEYS and rendered one of them
// directly ({d}) instead of passing it through the translator ({tr(d)}).
//
// The fix removes the failure mode rather than patching the symptom: calendar
// labels are now produced by helpers that return already-translated strings,
// so there is no key left for a component to leak.
//
// These checks fail loudly if the pattern is re-introduced.
//
// Run: node tests/i18n-calendar-keys.test.js

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("FAIL:", label);
  }
};

// ---------------------------------------------------------------------------
// 1. The regression itself: no component may hold an array of numeric dict
//    keys. That construct is the only way the raw-key leak happened.
// ---------------------------------------------------------------------------
function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const sourceFiles = walk(path.join(REPO, "src"));
// An array literal whose first element is a "<namespace>.<number>" dict key.
const KEY_ARRAY = /=\s*\[\s*(?:\/\/[^\n]*\n\s*)*"(?:student|admin|teacher|parent|common|auth|landing)\.\d+"/;

const offenders = sourceFiles.filter((f) => {
  // The dictionaries themselves legitimately contain these keys.
  if (/i18n-dict/.test(f)) return false;
  return KEY_ARRAY.test(fs.readFileSync(f, "utf8"));
});
ok(
  offenders.length === 0,
  "no component holds a raw array of numeric dict keys" +
    (offenders.length ? ` (found: ${offenders.map((f) => path.relative(REPO, f)).join(", ")})` : "")
);

// ---------------------------------------------------------------------------
// 2. The study scheduler specifically must not reference the old key arrays,
//    and must source its labels from the shared helper.
// ---------------------------------------------------------------------------
const scheduler = read("src/components/student/study-scheduler.tsx");
ok(!/DAY_NAMES/.test(scheduler), "study-scheduler no longer defines DAY_NAMES");
ok(!/MONTH_NAMES/.test(scheduler), "study-scheduler no longer defines MONTH_NAMES");
ok(
  /useCalendarLabels/.test(scheduler),
  "study-scheduler sources calendar labels from useCalendarLabels()"
);
ok(
  /cal\.dayHeaders\.map/.test(scheduler),
  "study-scheduler renders translated weekday headers (not raw keys)"
);
ok(
  !/student\.(19[89]|20[0-9]|21[0-6])/.test(scheduler),
  "study-scheduler contains no calendar dict-key literals at all"
);

// ---------------------------------------------------------------------------
// 3. The helpers exist and return translated strings, in both locales.
// ---------------------------------------------------------------------------
const core = read("src/lib/i18n-core.ts");
for (const fn of ["weekdayName", "weekdayShortName", "monthName", "weekdayHeaders"]) {
  ok(new RegExp(`export function ${fn}`).test(core), `i18n-core exports ${fn}()`);
}
ok(
  /export function useCalendarLabels/.test(read("src/lib/i18n.ts")),
  "i18n exports the useCalendarLabels() hook"
);

// ---------------------------------------------------------------------------
// 4. Catalogue completeness: every calendar key resolves in BOTH ar and en.
//    A missing entry would make translate() echo the key — i.e. the original
//    bug, re-introduced through the catalogue instead of the call site.
// ---------------------------------------------------------------------------
const dict2026 = read("src/lib/i18n-dict-2026.ts");
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const hasBilingualEntry = (key) => {
  // Matches:  "key": { ar: "…", en: "…" }
  const re = new RegExp(
    `"${key.replace(".", "\\.")}"\\s*:\\s*\\{[^}]*\\bar\\s*:\\s*"[^"]+"[^}]*\\ben\\s*:\\s*"[^"]+"[^}]*\\}`
  );
  return re.test(dict2026);
};

for (const d of DAYS) {
  ok(hasBilingualEntry(`calendar.day.${d}`), `calendar.day.${d} has ar+en text`);
  ok(hasBilingualEntry(`calendar.dayShort.${d}`), `calendar.dayShort.${d} has ar+en text`);
}
for (let m = 1; m <= 12; m++) {
  ok(hasBilingualEntry(`calendar.month.${m}`), `calendar.month.${m} has ar+en text`);
}

// ---------------------------------------------------------------------------
// 5. Arabic values must actually be Arabic (a copy-paste of the English label
//    would silently ship an untranslated calendar to RTL users).
// ---------------------------------------------------------------------------
const arabicRe = /[\u0600-\u06FF]/;
const entryRe = /"(calendar\.(?:day|dayShort|month)\.[a-z0-9]+)"\s*:\s*\{\s*ar:\s*"([^"]+)",\s*en:\s*"([^"]+)"/g;
let m2;
let checked = 0;
let badArabic = [];
let badEnglish = [];
while ((m2 = entryRe.exec(dict2026))) {
  checked++;
  if (!arabicRe.test(m2[2])) badArabic.push(m2[1]);
  if (arabicRe.test(m2[3])) badEnglish.push(m2[1]);
}
ok(checked === 26, `all 26 calendar entries parsed (got ${checked})`);
ok(badArabic.length === 0, `every calendar ar value is Arabic script (bad: ${badArabic.join(", ")})`);
ok(badEnglish.length === 0, `no calendar en value contains Arabic (bad: ${badEnglish.join(", ")})`);

// ---------------------------------------------------------------------------
// 6. The emitter owns the "student.*" namespace; calendar keys must live in
//    the hand-maintained file so regeneration cannot drop them.
// ---------------------------------------------------------------------------
ok(
  !/calendar\.day\./.test(read("src/lib/i18n-dict.ts")),
  "calendar keys live in i18n-dict-2026.ts, not the generated catalogue"
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
