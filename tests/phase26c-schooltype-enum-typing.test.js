// CodeMind Academy — Phase 26C POST-MERGE HOTFIX: `Student.schoolType` write
// typing — regression pins.
//
// WHAT THIS FILE OWNS
//   Post-merge local verification on Windows (`npx.cmd tsc --noEmit`) failed on
//   `src/app/api/admin/students/[id]/route.ts`:
//
//     TS2322: Type 'string' is not assignable to type
//     'SchoolType | NullableEnumSchoolTypeFieldUpdateOperationsInput | null | undefined'
//     data: { schoolType: pendingSchoolType }
//
//   ROOT CAUSE: the Phase 26C pre-parse holder was annotated
//   `let pendingSchoolType: string | null | undefined`, which THREW AWAY the
//   narrowing that `requireSchoolType` had already proven. `requireSchoolType`
//   can only ever return a canonical `ARABIC | LANGUAGE`, so the `string`
//   annotation was pure widening: it kept the runtime behaviour identical while
//   making the value unassignable to Prisma's `StudentUpdateInput.schoolType`.
//   The holder is now typed with the GENERATED enum
//   (`import type { SchoolType } from "@prisma/client"`).
//
//   THE TRAP IT SLIPPED THROUGH: `tsc --noEmit` on a checkout where the Prisma
//   client was never generated typechecks against the `.prisma/client` STUB
//   (loosely typed), so this error only appears once `prisma generate` has run.
//   A. and D. below pin the fix at the layer that is cheap to check without a
//   database; the full `npx tsc --noEmit` remains the real gate.
//
//   A. SOURCE-LEVEL INVARIANTS — the holder is typed with the generated enum,
//      never `string`/`any`, never an assertion, and the ONLY values ever
//      assigned to it are the initial `undefined` and the validated
//      `check.value` (so nothing unvalidated can reach the Prisma write).
//
//   B. ENUM PARITY — the members of `enum SchoolType` in the schema and the
//      `SCHOOL_TYPES` accepted by the shipped `src/lib/school-type.ts` are the
//      SAME set. This drift is exactly what makes a hand-written union unsafe
//      to persist, and it is what would silently reintroduce this class of bug.
//
//   C. BEHAVIOURAL — `requireSchoolType` (compiled from the SHIPPED TypeScript)
//      accepts exactly the enum members (in every accepted spelling) and
//      rejects null / undefined / blank / garbage, so only ARABIC | LANGUAGE
//      can ever be handed to the update.
//
//   D. TYPECHECK MICRO-GATE (runs only when the Prisma client IS generated) —
//      the holder's declared type really is assignable to
//      `Prisma.StudentUpdateInput["schoolType"]`, and a widened `string` really
//      is not. Without a generated client this section is SKIPPED, never
//      silently passed.
//
// Run: node tests/phase26c-schooltype-enum-typing.test.js
// Exit code: 0 = all pass, 1 = failure. Requires Node >= 22.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

const ROUTE_REL = "src/app/api/admin/students/[id]/route.ts";
const LIB_REL = "src/lib/school-type.ts";

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log("  PASS:", label);
  } else {
    fail++;
    console.error("  FAIL:", label);
  }
};
const eq = (a, b, label) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (t) => console.log(`\n${t}`);

// ===========================================================================
// A. SOURCE-LEVEL INVARIANTS — the holder keeps the generated enum type
// ===========================================================================
section("A. student PATCH types pendingSchoolType with the GENERATED enum");
const route = read(ROUTE_REL);

ok(
  /import type \{[^}]*\bSchoolType\b[^}]*\} from "@prisma\/client";/.test(route),
  `${ROUTE_REL} imports the generated SchoolType type-only from @prisma/client`
);
ok(
  /let pendingSchoolType:\s*SchoolType \| undefined\s*=\s*undefined;/.test(route),
  "pendingSchoolType is declared `SchoolType | undefined` (the generated enum)"
);
ok(
  !/let pendingSchoolType:\s*string/.test(route),
  "pendingSchoolType is NOT widened to `string` (the TS2322 regression)"
);
ok(
  !/let pendingSchoolType[^;]*\bany\b/.test(route),
  "pendingSchoolType is NOT typed `any`"
);
ok(
  !/\bas any\b/.test(route) && !/as unknown as/.test(route),
  "the route uses no `as any` / `as unknown as` escape hatch"
);
ok(
  /data: \{ schoolType: pendingSchoolType \}/.test(route),
  "the persisted value is still the pre-parsed holder (no behaviour change)"
);
ok(
  /requireSchoolType\(body\.schoolType\)/.test(route) && /api\.210/.test(route),
  "an unrecognised school type is still rejected with api.210 before any write"
);

// Every assignment to the holder must be either the initial `undefined` or the
// validated `check.value` — nothing else may ever reach the Prisma write.
// (The optional `: Type` group lets this see the declaration's initialiser too.)
const assignments = [...route.matchAll(/pendingSchoolType(?:\s*:\s*[^=;]+?)?\s*=\s*([^;\n]+)/g)].map((m) =>
  m[1].trim()
);
eq(assignments, ["undefined", "check.value"], "the ONLY values assigned to pendingSchoolType");

// ===========================================================================
// B. ENUM PARITY — schema enum === the set the shared validator accepts
// ===========================================================================
section("B. schema `enum SchoolType` and lib SCHOOL_TYPES are the same set");
const schema = read("prisma/schema.prisma").replace(/\/\/[^\n]*/g, "");
const enumBlock = /enum\s+SchoolType\s*\{([^}]*)\}/.exec(schema);
if (!enumBlock) throw new Error("prisma/schema.prisma no longer declares `enum SchoolType`");
const schemaMembers = enumBlock[1].split(/[\s,]+/).filter(Boolean);
eq(schemaMembers, ["ARABIC", "LANGUAGE"], "schema enum members (this hotfix must not change them)");

// ---------------------------------------------------------------------------
// Compile the module under test to CommonJS in a temp dir (repo convention).
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-26c-hotfix-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      strict: true,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [path.join(REPO, "node_modules/@types")],
      baseUrl: REPO,
      paths: { "@/*": ["src/*"] },
      outDir: OUT,
    },
    files: [path.join(REPO, LIB_REL)],
  })
);
try {
  execFileSync(process.execPath, [
    path.join(REPO, "node_modules/typescript/bin/tsc"),
    "-p",
    path.join(OUT, "tsconfig.json"),
  ], { cwd: REPO, stdio: "pipe" });
} catch {
  /* fall through: the emitted JS is what matters, `npm run typecheck` is the real gate */
}
if (!fs.existsSync(path.join(OUT, "school-type.js"))) throw new Error("tsc did not emit school-type.js");
const ST = require(path.join(OUT, "school-type.js"));

eq(ST.SCHOOL_TYPES, schemaMembers, "lib SCHOOL_TYPES === schema enum members (no drift)");

// ===========================================================================
// C. BEHAVIOURAL — only enum members can reach the write
// ===========================================================================
section("C. requireSchoolType accepts exactly the enum members");
for (const member of schemaMembers) {
  eq(ST.requireSchoolType(member), { ok: true, value: member }, `requireSchoolType("${member}")`);
}
for (const legacy of ["arabic", " Arabic ", "AR", "ar", "عربي"]) {
  eq(ST.requireSchoolType(legacy).value, "ARABIC", `requireSchoolType(${JSON.stringify(legacy)}) → ARABIC`);
}
for (const legacy of ["language", "Language", "LANGUAGES", "lang", "لغات"]) {
  eq(ST.requireSchoolType(legacy).value, "LANGUAGE", `requireSchoolType(${JSON.stringify(legacy)}) → LANGUAGE`);
}
for (const empty of [null, undefined, "", "   "]) {
  const r = ST.requireSchoolType(empty);
  ok(r.ok === false && r.reason === "EMPTY", `requireSchoolType(${JSON.stringify(empty)}) → EMPTY (never persisted)`);
}
for (const garbage of ["FRENCH", "AMERICAN", "ARABIC2", "arabic-ish", {}, [], 42, true]) {
  const r = ST.requireSchoolType(garbage);
  ok(r.ok === false && r.reason === "INVALID", `requireSchoolType(${JSON.stringify(garbage)}) → INVALID (never persisted)`);
}
for (const v of ["ARABIC", "language", "عربي", "nope", null, 42, ""]) {
  const n = ST.normalizeSchoolType(v);
  ok(n === null || schemaMembers.includes(n), `normalizeSchoolType(${JSON.stringify(v)}) is an enum member or null`);
}

// ===========================================================================
// D. TYPECHECK MICRO-GATE — the declared holder type fits the Prisma write
// ===========================================================================
section("D. holder type is assignable to Prisma.StudentUpdateInput['schoolType']");
const generatedDts = path.join(REPO, "node_modules/.prisma/client/index.d.ts");
const isGenerated =
  fs.existsSync(generatedDts) && /export const SchoolType: \{/.test(fs.readFileSync(generatedDts, "utf8"));

if (!isGenerated) {
  console.log("  SKIP: Prisma client is not generated in this checkout.");
  console.log("        Run `npx prisma generate --schema prisma/schema.prisma` (then `npx tsc --noEmit`).");
} else {
  const TSC_BIN = path.join(REPO, "node_modules/typescript/bin/tsc");
  const probe = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-26c-probe-"));
    const file = path.join(dir, "probe.ts");
    fs.writeFileSync(file, `import type { Prisma, SchoolType } from "@prisma/client";\n${body}\n`);
    // `paths` is a tsconfig-only option, so the probe gets its own tiny config
    // that resolves @prisma/client against THIS repo's generated client.
    const config = {
      compilerOptions: {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        target: "es2020",
        module: "esnext",
        moduleResolution: "bundler",
        baseUrl: REPO,
        paths: { "@prisma/client": ["node_modules/@prisma/client"] },
        types: [],
      },
      files: [file],
    };
    const configPath = path.join(dir, "tsconfig.json");
    fs.writeFileSync(configPath, JSON.stringify(config));
    try {
      execFileSync(process.execPath, [TSC_BIN, "-p", configPath], { cwd: REPO, stdio: "pipe" });
      return { code: 0, out: "" };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
    }
  };

  // The FIX: a value typed with the generated enum is accepted by the write.
  const good = probe(`
declare const pendingSchoolType: SchoolType | undefined;
export const write: Prisma.StudentUpdateInput = { schoolType: pendingSchoolType };
`);
  ok(good.code === 0, `enum-typed holder compiles against StudentUpdateInput (tsc exit ${good.code})`);

  // The REGRESSION: the same holder widened to `string` must NOT compile.
  const bad = probe(`
declare const pendingSchoolType: string | null | undefined;
export const write: Prisma.StudentUpdateInput = { schoolType: pendingSchoolType };
`);
  ok(
    bad.code !== 0 && /TS2322/.test(bad.out),
    `widening the holder to \`string\` still fails with TS2322 (tsc exit ${bad.code})`
  );
}

// ===========================================================================
console.log(`\n[26C-HOTFIX] ${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
