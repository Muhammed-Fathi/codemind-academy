// CodeMind Academy — STUDENT_HOMEWORK_LIST_FILTER vs the Prisma-generated types
// (offline, no DB, no network).
//
// Regression guard for a real production blocker: `STUDENT_HOMEWORK_LIST_FILTER`
// was declared `as const`, which makes `status.in` the READONLY tuple
//   readonly ["PUBLISHED", "CLOSED"]
// Prisma's generated `HomeworkWhereInput.status` is a `StringFilter` (Homework.status
// is a TEXT column, not an enum) whose `in` is a MUTABLE `string[]`. A readonly
// tuple is not assignable to a mutable array, so every call site that spread the
// constant into a `where` clause failed with TS2322 — the parent dashboard route,
// the parent academic reader and the shared parent-access helper.
//
// It could not be caught here: this sandbox has no network, `prisma generate`
// cannot run, and the stub client's types collapse so tsc sees nothing. This
// test therefore compiles the REAL source against a faithful copy of the shape
// Prisma 6 generates, and — crucially — includes a NEGATIVE CONTROL so the test
// can never pass vacuously.
//
// Run: node tests/student-visibility-prisma-typing.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-hw-filter-"));

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// A faithful copy of what `prisma generate` emits for a TEXT `status` column.
// ---------------------------------------------------------------------------
const PRISMA_SHAPE = `
type StringFieldRefInput = { _ref: string };
type StringFilter = {
  equals?: string | StringFieldRefInput;
  in?: string[];
  notIn?: string[];
  lt?: string | StringFieldRefInput;
  contains?: string;
  not?: string | StringFilter;
};
type LessonWhereInput = {
  status?: StringFilter | string;
  curriculumStatus?: StringFilter | string;
  unit?: { part?: { courseId?: StringFilter | string } };
  topic?: { unit?: { part?: { courseId?: StringFilter | string } } };
  OR?: LessonWhereInput[];
};
type HomeworkWhereInput = {
  id?: StringFilter | string;
  lessonId?: StringFilter | string;
  status?: StringFilter | string;
  lesson?: LessonWhereInput;
  trackScope?: unknown;
  AND?: HomeworkWhereInput | HomeworkWhereInput[];
  OR?: HomeworkWhereInput[];
};
`;

/**
 * Compile `snippet` (which imports ./student-visibility) with the repo's own tsc
 * and return { ok, diagnostics }.
 */
function compileSnippet(label, snippet) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-snip-"));
  // The REAL module, read from disk at test time — not a hand-written copy.
  fs.copyFileSync(
    path.join(REPO, "src/lib/student-visibility.ts"),
    path.join(dir, "student-visibility.ts")
  );
  const entry = path.join(dir, "snippet.ts");
  fs.writeFileSync(entry, `${PRISMA_SHAPE}\n${snippet}\n`);
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2020",
        module: "commonjs",
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        noEmit: true,
      },
      files: [entry],
    })
  );
  // The repo's OWN tsc, invoked directly — `npx tsc` from a temp cwd resolves
  // to an unrelated uninstalled package.
  const tsc = path.join(REPO, "node_modules/typescript/lib/tsc.js");
  let diagnostics = "";
  let okCompile = true;
  try {
    execFileSync(process.execPath, [tsc, "-p", path.join(dir, "tsconfig.json")], {
      cwd: REPO,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (e) {
    okCompile = false;
    diagnostics = String(e.stdout || e.message || "").trim();
  }
  return { ok: okCompile, diagnostics, dir, entry };
}

// ---------------------------------------------------------------------------
section("A. The shared filter compiles against the Prisma-generated shape");
// ---------------------------------------------------------------------------
{
  // 1. The parent-academics / parent-dashboard pattern: spread + nested lesson.
  const r1 = compileSnippet(
    "spread",
    `import { STUDENT_HOMEWORK_LIST_FILTER } from "./student-visibility";
     const where: HomeworkWhereInput = {
       ...STUDENT_HOMEWORK_LIST_FILTER,
       lesson: {
         status: "PUBLISHED",
         curriculumStatus: { not: "ARCHIVED" },
         OR: [{ unit: { part: { courseId: "c1" } } }, { topic: { unit: { part: { courseId: "c1" } } } }],
       },
     };
     export const w = where;`
  );
  ok(r1.ok, `spreading the filter into a homework where clause type-checks${r1.ok ? "" : `\n${r1.diagnostics}`}`);

  // 2. The parent-access pattern: spread + lessonId in-list.
  const r2 = compileSnippet(
    "spread-ids",
    `import { STUDENT_HOMEWORK_LIST_FILTER } from "./student-visibility";
     const where: HomeworkWhereInput = {
       ...STUDENT_HOMEWORK_LIST_FILTER,
       lessonId: { in: ["h1", "h2"] },
     };
     export const w = where;`
  );
  ok(r2.ok, `spreading it alongside other where clauses type-checks${r2.ok ? "" : `\n${r2.diagnostics}`}`);

  // 3. The student homework route pattern: re-spread the in-list into a new array.
  const r3 = compileSnippet(
    "respread",
    `import { STUDENT_HOMEWORK_LIST_FILTER } from "./student-visibility";
     const where: HomeworkWhereInput = {
       status: { in: [...STUDENT_HOMEWORK_LIST_FILTER.status.in] },
       lessonId: { in: ["h1"] },
     };
     export const w = where;`
  );
  ok(r3.ok, `the student route's [...status.in] pattern type-checks${r3.ok ? "" : `\n${r3.diagnostics}`}`);

  // 4. The element type is still NARROW: a typo cannot compile.
  const r4 = compileSnippet(
    "narrow",
    `import { STUDENT_HOMEWORK_LIST_FILTER } from "./student-visibility";
     const bad: "PUBLISHED" | "CLOSED" = STUDENT_HOMEWORK_LIST_FILTER.status.in[0];
     const worse: "DRAFT" = STUDENT_HOMEWORK_LIST_FILTER.status.in[0];
     export const b = [bad, worse];`
  );
  ok(!r4.ok, "the element type is still the narrow union (a DRAFT assignment to it does not compile)");

  // -------------------------------------------------------------------------
  // NEGATIVE CONTROL — proves the harness really detects the reported TS2322.
  // -------------------------------------------------------------------------
  const control = compileSnippet(
    "control",
    `const OLD_STUDENT_HOMEWORK_LIST_FILTER = { status: { in: ["PUBLISHED", "CLOSED"] } } as const;
     const where: HomeworkWhereInput = { ...OLD_STUDENT_HOMEWORK_LIST_FILTER };
     export const w = where;`
  );
  ok(
    !control.ok,
    "negative control: the OLD `as const` readonly tuple still FAILS this check (the test is not vacuous)"
  );
  ok(
    /readonly|not assignable/i.test(control.diagnostics),
    `the control fails for the right reason (readonly tuple vs mutable string[])${control.ok ? "" : ` — ${control.diagnostics.split("\n")[0]}`}`
  );
}

// ---------------------------------------------------------------------------
section("B. Runtime value is unchanged");
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-hw-rt-"));
  fs.copyFileSync(
    path.join(REPO, "src/lib/student-visibility.ts"),
    path.join(dir, "student-visibility.ts")
  );
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "es2020", module: "commonjs", strict: true, skipLibCheck: true, outDir: dir },
      files: [path.join(dir, "student-visibility.ts")],
    })
  );
  execFileSync(
    process.execPath,
    [path.join(REPO, "node_modules/typescript/lib/tsc.js"), "-p", path.join(dir, "tsconfig.json")],
    { cwd: REPO, stdio: "pipe", encoding: "utf8" }
  );
  const mod = require(path.join(dir, "student-visibility.js"));

  ok(
    JSON.stringify(mod.STUDENT_HOMEWORK_LIST_FILTER) ===
      JSON.stringify({ status: { in: ["PUBLISHED", "CLOSED"] } }),
    `the value is exactly { status: { in: ["PUBLISHED", "CLOSED"] } } (got ${JSON.stringify(mod.STUDENT_HOMEWORK_LIST_FILTER)})`
  );
  ok(
    Array.isArray(mod.STUDENT_HOMEWORK_LIST_FILTER.status.in),
    "status.in is still a real Array at runtime"
  );
  ok(
    mod.STUDENT_HOMEWORK_LIST_FILTER.status.in.length === 2 &&
      mod.STUDENT_HOMEWORK_LIST_FILTER.status.in[0] === "PUBLISHED" &&
      mod.STUDENT_HOMEWORK_LIST_FILTER.status.in[1] === "CLOSED",
    "the two statuses and their ORDER are preserved"
  );
  ok(
    !mod.STUDENT_HOMEWORK_LIST_FILTER.status.in.includes("DRAFT"),
    "DRAFT is still excluded (the lifecycle filter was not widened)"
  );
  ok(
    mod.filterStudentHomeworkRows([
      { status: "DRAFT" }, { status: "PUBLISHED" }, { status: "CLOSED" }, { status: "PENDING" },
    ]).map((r) => r.status).join() === "PUBLISHED,CLOSED",
    "filterStudentHomeworkRows is unchanged (DRAFT and PENDING still filtered out)"
  );
  ok(
    mod.filterStudentLessonRows([{ status: "DRAFT" }, { status: "PUBLISHED" }]).length === 1,
    "filterStudentLessonRows is unchanged"
  );
}

// ---------------------------------------------------------------------------
section("C. The shared fix reached every consumer (no local re-declarations)");
// ---------------------------------------------------------------------------
{
  const src = (p) => fs.readFileSync(path.join(REPO, p), "utf8");
  const visibility = src("src/lib/student-visibility.ts");
  ok(
    !/STUDENT_HOMEWORK_LIST_FILTER[^\n]*as const/.test(visibility),
    "the shared constant is no longer `as const`"
  );

  const consumers = [
    "src/app/api/parents/me/dashboard/route.ts",
    "src/lib/parent-academics.ts",
    "src/lib/parent-access.ts",
    "src/app/api/students/me/homework/route.ts",
  ];
  for (const c of consumers) {
    const text = src(c);
    ok(/STUDENT_HOMEWORK_LIST_FILTER/.test(text), `${c} still uses the SHARED constant`);
    ok(
      !/in:\s*\[\s*"PUBLISHED"\s*,\s*"CLOSED"\s*\]\s*as const/.test(text),
      `${c} does not re-declare a local readonly tuple`
    );
    ok(!/@ts-ignore|@ts-expect-error|tslint:disable/.test(text), `${c} contains no suppression comments`);
  }
  // Scoped to the filter usage itself: the dashboard carries PRE-EXISTING
  // `as any` casts for `student.schoolName` / `schoolType` / `studentCode`
  // (line ~620) that have nothing to do with this fix and are left alone.
  for (const c of consumers) {
    const usageLines = src(c)
      .split("\n")
      .filter((line) => line.includes("STUDENT_HOMEWORK_LIST_FILTER"));
    ok(
      usageLines.length > 0 &&
        usageLines.every((line) => !/as any|as unknown|@ts-/.test(line)),
      `${c}: the filter is used with no cast and no suppression`
    );
  }
}

console.log(`\nstudent-visibility typing: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
