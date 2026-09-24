// CodeMind Academy — Phase K micro-fix: the Create/Manage Group "audience"
// helper must never render raw `{p1}` / `{p2}`.
//
// ROOT CAUSE (regression test): admin.318–320 were defined in BOTH
// dictionaries — Phase 26B group-audience strings in src/lib/i18n-dict.ts and
// Phase 11 reconcile strings ("… {p1} active lessons ({p2} archived)") in
// src/lib/i18n-dict-2026.ts. The merge `{ ...GENERATED, ...DICT_2026 }` lets
// 2026 win, so the parameterless group helper `tr("admin.320")` rendered the
// reconcile template with its placeholders leaking. The reconcile strings
// now live at admin.652–654; admin.318–320 resolve to the audience texts.
//
//   A. Behavioural — compile the REAL i18n core + both dictionaries and
//      exercise translate() for ar/en: group keys carry no placeholders; the
//      reconcile key interpolates zero and non-zero counts in both languages.
//   B. Source pins — no cross-dictionary collision for these keys; the group
//      dialogs use admin.318–320; the reconcile UI passes p1/p2 to admin.654.
//
// Run: node tests/i18n-group-audience-reconcile-keys.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const fs = require("fs");
const os = require("os");
const path = require("path");
const ts = require(path.join(__dirname, "..", "node_modules/typescript/lib/typescript.js"));

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    failures.push(label);
    console.error("FAIL:", label);
  }
};
const eq = (a, b, label) => ok(a === b, `${label} :: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
section("A. Behavioural — real translate() over the real merged dictionary");
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-i18n-audience-"));
for (const rel of ["src/lib/i18n-core.ts", "src/lib/i18n-dict.ts", "src/lib/i18n-dict-2026.ts"]) {
  const { outputText } = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: path.basename(rel),
  });
  const rewritten = outputText.replace(
    /require\(["']@\/lib\/([^"']+)["']\)/g,
    (_m, p) => `require(${JSON.stringify(path.join(OUT, p + ".js"))})`
  );
  fs.writeFileSync(path.join(OUT, path.basename(rel).replace(/\.tsx?$/, ".js")), rewritten);
}
const { translate } = require(path.join(OUT, "i18n-core.js"));
const hasPlaceholder = (s) => /\{p\d*\}/.test(s);

// Group audience keys (Phase 26B) — parameterless, must be the audience texts.
for (const locale of ["ar", "en"]) {
  for (const key of ["admin.318", "admin.319", "admin.320"]) {
    const s = translate(locale, key);
    ok(s.length > 0 && !hasPlaceholder(s), `A1 [${locale}] ${key} renders without {p1}/{p2}: ${JSON.stringify(s)}`);
  }
}
eq(translate("ar", "admin.318"), "جمهور المجموعة (نوع المدرسة)", "A2 [ar] admin.318 is the group-audience label");
eq(translate("en", "admin.318"), "Group audience (school type)", "A2 [en] admin.318 is the group-audience label");
eq(translate("ar", "admin.319"), "غير مصنفة", "A2 [ar] admin.319 is Unclassified");
eq(translate("en", "admin.319"), "Unclassified", "A2 [en] admin.319 is Unclassified");
ok(/مدارس عربي/.test(translate("ar", "admin.320")), "A2 [ar] admin.320 is the audience helper");
ok(/Arabic or Language school/.test(translate("en", "admin.320")), "A2 [en] admin.320 is the audience helper");

// Reconcile result key (Phase 11) — parameterised; both languages, zero + non-zero.
eq(translate("ar", "admin.654", { p1: 23, p2: 0 }), "تمت مطابقة المنهج: 23 درس نشط (0 مؤرشف)", "A3 [ar] non-zero/zero counts interpolate");
eq(translate("en", "admin.654", { p1: 23, p2: 0 }), "Curriculum reconciled: 23 active lessons (0 archived)", "A3 [en] non-zero/zero counts interpolate");
eq(translate("ar", "admin.654", { p1: 0, p2: 0 }), "تمت مطابقة المنهج: 0 درس نشط (0 مؤرشف)", "A3 [ar] zero counts render as 0 (not blank)");
eq(translate("en", "admin.654", { p1: 0, p2: 0 }), "Curriculum reconciled: 0 active lessons (0 archived)", "A3 [en] zero counts render as 0 (not blank)");
eq(translate("ar", "admin.654", { p1: 23, p2: 4 }), "تمت مطابقة المنهج: 23 درس نشط (4 مؤرشف)", "A3 [ar] non-zero archived count");
eq(translate("en", "admin.654", { p1: 23, p2: 4 }), "Curriculum reconciled: 23 active lessons (4 archived)", "A3 [en] non-zero archived count");
ok(!hasPlaceholder(translate("ar", "admin.654", { p1: 1, p2: 2 })) && !hasPlaceholder(translate("en", "admin.654", { p1: 1, p2: 2 })), "A3 no placeholder survives interpolation");
eq(translate("ar", "admin.652"), "مطابقة المنهج الرسمي", "A4 [ar] reconcile button label moved to admin.652");
eq(translate("en", "admin.653"), "Reconciling…", "A4 [en] reconciling label moved to admin.653");

// ---------------------------------------------------------------------------
section("B. Source pins — no collision, correct keys at each surface");
// ---------------------------------------------------------------------------
const extractKeys = (src) => {
  const keys = [];
  const re = /"((?:[a-z][a-z0-9]*)(?:\.[A-Za-z0-9_]+)+)"\s*:\s*\{/g;
  let m;
  while ((m = re.exec(src))) keys.push(m[1]);
  return keys;
};
const base = new Set(extractKeys(read("src/lib/i18n-dict.ts")));
const hand = new Set(extractKeys(read("src/lib/i18n-dict-2026.ts")));
for (const k of ["admin.318", "admin.319", "admin.320"]) {
  ok(base.has(k) && !hand.has(k), `B1 ${k} is defined ONLY in the base dictionary (no 2026 override)`);
}
for (const k of ["admin.652", "admin.653", "admin.654"]) {
  ok(hand.has(k) && !base.has(k), `B1 ${k} is defined ONLY in the 2026 dictionary`);
}

const ui = read("src/components/admin/admin-dashboard.tsx");
const groups = ui.slice(ui.indexOf("function CreateGroupDialog"), ui.indexOf("// 5. Courses"));
const courses = ui.slice(ui.indexOf("function CoursesView"), ui.indexOf("function AddCourseDialog"));
ok(/<Label>\{tr\("admin\.318"\)\}<\/Label>/.test(groups) && /\{tr\("admin\.320"\)\}<\/p>/.test(groups), "B2 Create/Manage Group use the audience label + helper keys");
ok(!/admin\.65[234]/.test(groups), "B2 the group dialogs never use the reconcile keys");
ok(/tr\("admin\.654", \{\s*p1: report\.officialLessonCodes\?\.length \?\? 0,\s*p2: report\.archivedLessonIds\?\.length \?\? 0,\s*\}\)/.test(courses), "B3 the reconcile toast passes the real report counts as p1/p2 to admin.654");
ok(/tr\("admin\.652"\)/.test(courses) && /tr\("admin\.653"\)/.test(courses), "B3 the reconcile button uses admin.652/653");
ok(!/tr\("admin\.3(18|19|20)"/.test(courses), "B3 the courses view no longer references admin.318–320");
// Any OTHER parameterless use of a {p}-template key would leak the same way.
ok(!/tr\("admin\.654"\)(?!\s*,)/.test(ui), "B4 admin.654 is never called without params");

console.log(`\ni18n-group-audience-reconcile-keys: ${pass} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
