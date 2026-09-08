// CodeMind Academy — Phase 9 Calendar / i18n regression tests.
//
// Offline (no database, no network, no running server). Two layers:
//
//   A. BEHAVIOURAL — compile src/lib/i18n-core.ts (+ dict) with tsc and exercise
//      the real translate / fmtDate helpers against the real merged dictionary.
//
//   B. SOURCE-LEVEL INVARIANTS — pin the root-cause fix (weekday headers must
//      call tr()) and the shell-nav key integrity so the student.198…204 leak
//      and bare-English nav labels cannot reappear through the same mechanism.
//
// Run: node tests/calendar-i18n-phase9.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner */
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
// Compile i18n-core + both dictionaries to CommonJS in a temp dir.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p9-test-"));
const files = [
  "src/lib/i18n-core.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
];

for (const rel of files) {
  const src = read(rel);
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.React,
    },
    fileName: path.basename(rel),
  });
  // Rewrite @/lib/* path aliases used inside the modules.
  const rewritten = outputText.replace(
    /require\(["']@\/lib\/([^"']+)["']\)/g,
    (_m, p) => `require(${JSON.stringify(path.join(OUT, p + ".js"))})`
  );
  const outName = path.basename(rel).replace(/\.tsx?$/, ".js");
  fs.writeFileSync(path.join(OUT, outName), rewritten);
}

const i18n = require(path.join(OUT, "i18n-core.js"));
const {
  translate,
  fmtDate,
  fmtDateTime,
  pickL10n,
  looksLikeDictKey,
  hasDictKey,
  dictSize,
  applyLocale,
  readStoredLocale,
} = i18n;

// ---------------------------------------------------------------------------
section("A1. Dictionary integrity — day/month keys exist with AR + EN");
// ---------------------------------------------------------------------------
const DAY_KEYS = [
  "student.198",
  "student.199",
  "student.200",
  "student.201",
  "student.202",
  "student.203",
  "student.204",
];
const MONTH_KEYS = [
  "student.205",
  "student.206",
  "student.207",
  "student.208",
  "student.209",
  "student.210",
  "student.211",
  "student.212",
  "student.213",
  "student.214",
  "student.215",
  "student.216",
];

for (const k of [...DAY_KEYS, ...MONTH_KEYS]) {
  ok(hasDictKey(k), `dict has ${k}`);
  const ar = translate("ar", k);
  const en = translate("en", k);
  ok(ar.length > 0, `${k} ar non-empty`);
  ok(en.length > 0, `${k} en non-empty`);
  ok(ar !== k, `${k} ar is not the raw key`);
  ok(en !== k, `${k} en is not the raw key`);
}

// Known Arabic / English day names (product dictionary values).
ok(translate("ar", "student.198") === "الأحد", "ar Sunday = الأحد");
ok(translate("en", "student.198") === "Sunday", "en Sunday = Sunday");
ok(translate("ar", "student.204") === "السبت", "ar Saturday = السبت");
ok(translate("en", "student.199") === "Monday", "en Monday = Monday");
ok(translate("ar", "student.205") === "يناير", "ar January = يناير");
ok(translate("en", "student.216") === "December", "en December = December");

// ---------------------------------------------------------------------------
section("A2. Missing-key fallback — never leak raw dotted keys");
// ---------------------------------------------------------------------------
ok(looksLikeDictKey("student.198") === true, "looksLikeDictKey(student.198)");
ok(looksLikeDictKey("parent.123") === true, "looksLikeDictKey(parent.123)");
ok(looksLikeDictKey("calendar.55") === true, "looksLikeDictKey(calendar.55)");
ok(looksLikeDictKey("shell.030") === true, "looksLikeDictKey(shell.030)");
ok(looksLikeDictKey("Hello world") === false, "looksLikeDictKey(Hello world)=false");
ok(looksLikeDictKey("Study Plan") === false, "looksLikeDictKey(Study Plan)=false");
ok(looksLikeDictKey("") === false, "looksLikeDictKey('')=false");

const missing = translate("en", "student.99999");
ok(missing === "", `missing key → empty string (got ${JSON.stringify(missing)})`);
ok(missing !== "student.99999", "missing key does NOT return the raw key");
ok(translate("ar", "calendar.55") === "", "missing calendar.55 → empty");
ok(translate("en", "parent.999") === "", "missing parent.999 → empty");

// Human strings that are not keys still pass through (legacy shell labels).
ok(translate("en", "Study Plan") === "Study Plan", "non-key human string passthrough");

// ---------------------------------------------------------------------------
section("A3. Empty-string fallback across locales");
// ---------------------------------------------------------------------------
// Simulate by translating a real key and checking both sides are non-empty for
// all day/month keys (already covered). Also verify interpolation.
ok(
  translate("en", "student.051", { p1: "10", p2: "30" }).includes("10"),
  "interpolation p1 works"
);
ok(
  translate("ar", "api.223", { p1: "500" }).includes("500"),
  "ar interpolation works"
);

// ---------------------------------------------------------------------------
section("A4. Arabic / English parity for Phase 9 keys");
// ---------------------------------------------------------------------------
const P9_KEYS = [
  "student.243",
  "student.244",
  "student.245",
  "student.246",
  "shell.027",
  "shell.028",
  "shell.029",
  "shell.030",
  "shell.031",
  "shell.032",
  "shell.033",
  "shell.034",
  "shell.035",
  "shell.036",
  "shell.037",
  "shell.038",
];
for (const k of P9_KEYS) {
  ok(hasDictKey(k), `P9 dict has ${k}`);
  const ar = translate("ar", k);
  const en = translate("en", k);
  ok(ar.length > 0 && ar !== k, `${k} ar resolved`);
  ok(en.length > 0 && en !== k, `${k} en resolved`);
  // Arabic must contain Arabic script for these UI labels.
  ok(/[\u0600-\u06FF]/.test(ar), `${k} ar contains Arabic script`);
  // English must be Latin (no Arabic script).
  ok(!/[\u0600-\u06FF]/.test(en), `${k} en has no Arabic script`);
}

ok(translate("en", "shell.030") === "Study Plan", "shell.030 en = Study Plan");
ok(translate("ar", "shell.030") === "خطة الدراسة", "shell.030 ar = خطة الدراسة");
ok(translate("en", "student.243") === "Study Scheduler", "student.243 en title");
ok(/مخطط/.test(translate("ar", "student.243")), "student.243 ar title");

// ---------------------------------------------------------------------------
section("A5. Date localization — locale-independent identity");
// ---------------------------------------------------------------------------
// Fixed UTC noon so local day boundaries are stable across common timezones.
const fixed = new Date(Date.UTC(2024, 1, 29, 12, 0, 0)); // leap-year Feb 29
const arDate = fmtDate(fixed, "ar", { year: "numeric", month: "long", day: "numeric" });
const enDate = fmtDate(fixed, "en", { year: "numeric", month: "long", day: "numeric" });
ok(arDate.length > 0, "fmtDate ar non-empty");
ok(enDate.length > 0, "fmtDate en non-empty");
ok(arDate !== enDate, "fmtDate ar ≠ en (presentation differs)");
// Both must still refer to the same calendar day components.
ok(/2024/.test(arDate) || /٢٠٢٤/.test(arDate), "ar date includes year 2024");
ok(/2024/.test(enDate), "en date includes year 2024");

const arMonth = fmtDate(new Date(2026, 0, 15), "ar", { month: "long" });
const enMonth = fmtDate(new Date(2026, 0, 15), "en", { month: "long" });
ok(arMonth.length > 0 && enMonth.length > 0, "month long labels resolve");
ok(arMonth !== enMonth, "month labels differ by locale");

const arWeekday = fmtDate(new Date(2026, 8, 6), "ar", { weekday: "long" }); // Sun
const enWeekday = fmtDate(new Date(2026, 8, 6), "en", { weekday: "long" });
ok(arWeekday.length > 0 && enWeekday.length > 0, "weekday long labels resolve");

// pickL10n is locale-aware presentation of data-model pairs.
ok(pickL10n("ar", "عنوان", "Title") === "عنوان", "pickL10n ar prefers ar");
ok(pickL10n("en", "عنوان", "Title") === "Title", "pickL10n en prefers en");
ok(pickL10n("en", "عنوان", null) === "عنوان", "pickL10n en falls back to ar");
ok(pickL10n("ar", null, "Title") === "Title", "pickL10n ar falls back to en");

// ---------------------------------------------------------------------------
section("A6. Dictionary size & no duplicate key definitions in sources");
// ---------------------------------------------------------------------------
ok(dictSize() > 1000, `dictSize() = ${dictSize()} (>1000)`);

// Parse both dict files for "key": patterns and assert uniqueness across merge.
function extractKeys(src) {
  const keys = [];
  const re = /"((?:[a-z][a-z0-9]*)(?:\.[A-Za-z0-9_]+)+)"\s*:\s*\{/g;
  let m;
  while ((m = re.exec(src))) keys.push(m[1]);
  return keys;
}
const genKeys = extractKeys(read("src/lib/i18n-dict.ts"));
const handKeys = extractKeys(read("src/lib/i18n-dict-2026.ts"));
const genSet = new Set(genKeys);
ok(genKeys.length === genSet.size, "no duplicate keys inside i18n-dict.ts");
const handSet = new Set(handKeys);
ok(handKeys.length === handSet.size, "no duplicate keys inside i18n-dict-2026.ts");
// 2026 keys intentionally OVERRIDE generated ones when they collide — that is
// by design (merge order). We only require that the Phase 9 day/month keys are
// unique to the generated file and the new shell/student keys are unique to 2026.
for (const k of DAY_KEYS) {
  ok(genSet.has(k), `${k} lives in generated dict`);
  ok(!handSet.has(k), `${k} is not duplicated in 2026 dict`);
}
for (const k of P9_KEYS) {
  ok(handSet.has(k), `${k} lives in 2026 dict`);
  ok(!genSet.has(k), `${k} is not duplicated in generated dict`);
}

// ---------------------------------------------------------------------------
section("B1. Root-cause regression — study-scheduler never renders raw keys");
// ---------------------------------------------------------------------------
const schedSrc = read("src/components/student/study-scheduler.tsx");

// The weekday header map MUST call tr(key). The original bug was `{d}` bare.
ok(
  /DAY_NAME_KEYS\.map\(\(key\)\s*=>/.test(schedSrc) ||
    /DAY_NAME_KEYS\.map\(\(d\)\s*=>/.test(schedSrc) === false,
  "DAY_NAME_KEYS is the canonical array name"
);
ok(
  /DAY_NAME_KEYS\.map\(\(key\)[\s\S]{0,400}\{tr\(key\)\}/.test(schedSrc),
  "weekday headers call tr(key) — root-cause fix"
);
// Guard against the original bare render `{d}` of a key string inside the header map.
ok(
  !/\.map\(\(d\)\s*=>\s*\([\s\S]{0,200}\{d\}/.test(schedSrc),
  "no bare {d} render of day-key array (original leak pattern)"
);
// Month header also goes through tr().
ok(
  /tr\(MONTH_NAME_KEYS\[month\]\)/.test(schedSrc),
  "month header uses tr(MONTH_NAME_KEYS[month])"
);
ok(
  /tr\(DAY_NAME_KEYS\[selectedDate\.getDay\(\)\]\)/.test(schedSrc),
  "selected-day title uses tr(DAY_NAME_KEYS[…])"
);
// Title is translated, not hardcoded English.
ok(
  /tr\("student\.243"\)/.test(schedSrc),
  'page title uses tr("student.243") not hardcoded "Study Scheduler"'
);
ok(
  !/>Study Scheduler</.test(schedSrc),
  'no hardcoded "Study Scheduler" text node'
);
// Month nav is direction-stable (dir="ltr") so prev/next stay left/right.
ok(/dir="ltr"/.test(schedSrc), 'month navigation group is dir="ltr"');
ok(/student\.244/.test(schedSrc) && /student\.245/.test(schedSrc), "prev/next a11y labels");
ok(/student\.246/.test(schedSrc), "Today control present");
// Accessibility on day cells.
ok(/aria-label=\{dayAria\}/.test(schedSrc) || /aria-label=\{/.test(schedSrc), "day cells have aria-label");
ok(
  /aria-selected=/.test(schedSrc) || /data-selected=/.test(schedSrc),
  "selected day uses aria-selected/data-selected"
);
ok(/role="grid"/.test(schedSrc), 'calendar grid has role="grid"');
// data-testid for manual/e2e hooks.
ok(/data-testid="study-scheduler"/.test(schedSrc), "study-scheduler test id");

// ---------------------------------------------------------------------------
section("B2. Shell nav — all labels are dict keys (no bare English)");
// ---------------------------------------------------------------------------
const shellSrc = read("src/components/dashboard/shell.tsx");
const labelRe = /label:\s*"([^"]+)"/g;
let lm;
const shellLabels = [];
while ((lm = labelRe.exec(shellSrc))) shellLabels.push(lm[1]);
ok(shellLabels.length >= 20, `shell has ${shellLabels.length} nav labels`);
for (const lab of shellLabels) {
  ok(looksLikeDictKey(lab), `shell label is a dict key: ${lab}`);
  ok(hasDictKey(lab), `shell label resolves in dict: ${lab}`);
  const ar = translate("ar", lab);
  const en = translate("en", lab);
  ok(ar !== lab && ar.length > 0, `shell ${lab} ar resolved`);
  ok(en !== lab && en.length > 0, `shell ${lab} en resolved`);
}
// Specific calendar-related nav item.
ok(shellLabels.includes("shell.030"), "Study Plan nav uses shell.030");
ok(shellLabels.includes("shell.034"), "Attendance nav uses shell.034");
ok(/tr\("shell\.038"\)/.test(shellSrc), "Support button uses shell.038");
ok(!/>\s*Support\s*</.test(shellSrc), "no hardcoded Support text");

// ---------------------------------------------------------------------------
section("B3. i18n core still exports the public surface");
// ---------------------------------------------------------------------------
ok(typeof translate === "function", "translate export");
ok(typeof fmtDate === "function", "fmtDate export");
ok(typeof fmtDateTime === "function", "fmtDateTime export");
ok(typeof pickL10n === "function", "pickL10n export");
ok(typeof looksLikeDictKey === "function", "looksLikeDictKey export");
ok(typeof hasDictKey === "function", "hasDictKey export");
ok(typeof dictSize === "function", "dictSize export");
ok(typeof applyLocale === "function", "applyLocale export");
ok(typeof readStoredLocale === "function", "readStoredLocale export");

// Client re-exports the new helpers.
const clientSrc = read("src/lib/i18n.ts");
ok(/looksLikeDictKey/.test(clientSrc), "i18n.ts re-exports looksLikeDictKey");
ok(/hasDictKey/.test(clientSrc), "i18n.ts re-exports hasDictKey");
ok(/"use client"/.test(clientSrc), "i18n.ts remains client module");
const coreSrc = read("src/lib/i18n-core.ts");
// Directive must not appear as a real module directive (first non-comment line).
// A comment may mention the string; strip block/line comments before checking.
const coreNoComments = coreSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
ok(
  !/^["']use client["']\s*;?/m.test(coreNoComments.trimStart()) &&
    !/\n["']use client["']\s*;?/.test(coreNoComments),
  "i18n-core.ts stays isomorphic (no use client directive)"
);

// ---------------------------------------------------------------------------
section("B4. Server date localization uses locale helpers (not hardcoded ar-EG)");
// ---------------------------------------------------------------------------
const weeklySrc = read("src/app/api/parents/me/weekly-report/route.ts");
ok(/serverLocale/.test(weeklySrc), "weekly-report reads serverLocale");
ok(/fmtDate\(/.test(weeklySrc), "weekly-report formats via fmtDate");
ok(
  !/toLocaleDateString\(\s*["']ar-EG["']/.test(weeklySrc),
  "weekly-report no longer hardcodes ar-EG"
);
const certSrc = read("src/app/api/students/me/certificate/route.ts");
ok(/serverLocale/.test(certSrc), "certificate reads serverLocale");
ok(/fmtDate\(/.test(certSrc), "certificate formats via fmtDate");
ok(
  !/toLocaleDateString\(\s*["']ar-EG["']/.test(certSrc),
  "certificate no longer hardcodes ar-EG"
);

// ---------------------------------------------------------------------------
section("B5. Calendar day-button identity is locale-independent");
// ---------------------------------------------------------------------------
const calSrc = read("src/components/ui/calendar.tsx");
ok(
  /toISOString\(\)\.slice\(0,\s*10\)/.test(calSrc),
  "CalendarDayButton data-day uses ISO date (locale-independent)"
);
ok(
  !/data-day=\{day\.date\.toLocaleDateString\(\)\}/.test(calSrc),
  "CalendarDayButton no longer uses toLocaleDateString() for identity"
);

// ---------------------------------------------------------------------------
section("B6. No second i18n or calendar system introduced");
// ---------------------------------------------------------------------------
ok(fs.existsSync(path.join(REPO, "src/lib/i18n-core.ts")), "keeps i18n-core");
ok(fs.existsSync(path.join(REPO, "src/lib/i18n.ts")), "keeps i18n client");
ok(fs.existsSync(path.join(REPO, "src/lib/i18n-server.ts")), "keeps i18n-server");
ok(fs.existsSync(path.join(REPO, "src/lib/i18n-dict.ts")), "keeps generated dict");
ok(fs.existsSync(path.join(REPO, "src/lib/i18n-dict-2026.ts")), "keeps 2026 dict");
// No new parallel i18n packages / folders.
ok(!fs.existsSync(path.join(REPO, "src/i18n")), "no src/i18n/ parallel system");
ok(!fs.existsSync(path.join(REPO, "locales")), "no /locales parallel system");
ok(!fs.existsSync(path.join(REPO, "src/lib/calendar-i18n.ts")), "no second calendar-i18n module");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nPhase 9 calendar/i18n: ${pass} passed, ${fail} failed`);
try {
  fs.rmSync(OUT, { recursive: true, force: true });
} catch {}
process.exit(fail ? 1 : 0);
