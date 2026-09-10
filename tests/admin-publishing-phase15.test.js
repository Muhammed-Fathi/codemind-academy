// CodeMind Academy — Phase 15 (admin publishing workflow UI) behavior suite.
//
// WHAT THIS FILE PROVES
//   The admin session-management workflow is a UI over the EXISTING
//   server-side lifecycle/readiness/material APIs — it must never recreate
//   lifecycle rules locally, never write `status` from the client, and never
//   derive readiness in React. Concretely:
//
//     validators  • create is DRAFT-only metadata (no officialCode, no
//                   status, canonical chain); update touches the seven safe
//                   keys; sensitive fields are rejected with FORBIDDEN_FIELD;
//                   list filters fail closed; archive input is strict.
//     routes      • ADMIN-only; create uses LESSON_NEW_LIFECYCLE; the list
//                   computes readiness with computeLessonReadiness (the SAME
//                   helper the OPEN ceremony enforces); detail uses
//                   getLessonReadiness; no storageKey anywhere; PATCH writes
//                   only safe keys; archive refuses PUBLISHED + is idempotent.
//     UI contract • components never import the lifecycle computation; the
//                   checklist renders server fields (present/valid/required/
//                   state/code); detail makes ONE fetch (no second /readiness
//                   call, so no stale readiness); open/mark-ready/unpublish
//                   call the ceremonies and handle NO_OP/READINESS_BLOCKED;
//                   archived sessions cannot be opened; retries are guarded.
//     i18n/RTL    • every tr() key in the new/edited UI exists with non-empty
//                   AR+EN; layout uses logical properties only.
//     FIXED exams • the mock-exam list shows pinned counts for FIXED exams.
//
// Layers (same convention as the Phase 11–14 suites):
//   1. Pure validators from the SHIPPED module (tsc-compiled, no mocks).
//   2. Source pins with negative controls over routes + components.
//   3. Dictionary contract checks over the shipped catalogues (regex read,
//      no TS compile needed for the assertion itself).
//
// Run:  node tests/admin-publishing-phase15.test.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase15-test-"));

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error("FAIL:", label);
  }
}
function eq(got, want, label) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b, `${label} (got ${a}, want ${b})`);
}
function section(title) {
  console.log(`\n${title}`);
}

/**
 * A source pin with a built-in negative control (Phase 13 convention): the
 * pattern must match the real source, and must NOT match a source in which
 * the matched text has been removed.
 */
function pinned(src, re, label, mutate) {
  ok(re.test(src), label);
  // Remove EVERY occurrence: a pin over a repeated token must still flip.
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const mutated = mutate ? mutate(src) : src.replace(new RegExp(re.source, flags), "");
  ok(!re.test(mutated), `${label} — negative control: mutating it flips the pin`);
}

/**
 * Absence pin: the pattern must NOT appear. `bad` is a concrete snippet the
 * pattern is known to match, so the negative control proves the pattern CAN
 * match (an absence pin over a pattern that matches nothing proves nothing).
 */
function absent(src, re, label, bad) {
  ok(!re.test(src), label);
  ok(re.test(src + "\n" + bad), `${label} — negative control: the pattern CAN match`);
}

// ---------------------------------------------------------------------------
// Compile the real modules (same convention as the Phase 11–14 suites)
// ---------------------------------------------------------------------------
const MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/admin-sessions.ts",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "es2020",
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
      files: MODULES.map((f) => path.join(REPO, f)),
    },
    null,
    2
  )
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch {
  /* type noise elsewhere in the graph is tolerated; `npm run typecheck` is the gate */
}
const EMIT = path.join(OUT, "src", "lib");
for (const f of ["school-type.js", "track-scope.js", "session-lifecycle.js", "admin-sessions.js"]) {
  if (!fs.existsSync(path.join(EMIT, f))) throw new Error(`tsc did not emit ${f}`);
}

const FAKE_DB_PATH = path.join(OUT, "fake-db.js");
fs.writeFileSync(
  FAKE_DB_PATH,
  "module.exports = { get db() { return globalThis.__CM_FAKE_DB__; } };\n"
);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "@/lib/db") return FAKE_DB_PATH;
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return originalResolve.call(this, request, ...args);
};

const S = require(path.join(EMIT, "admin-sessions.js"));
const L = require(path.join(EMIT, "session-lifecycle.js"));

// ---------------------------------------------------------------------------
// A. Create validator — DRAFT-only metadata, canonical chain
// ---------------------------------------------------------------------------
section("A. parseCreateLessonInput");

{
  const r = S.parseCreateLessonInput({
    title: "  Neural Nets  ",
    titleAr: "الشبكات العصبية",
    unitId: "u1",
  });
  ok(r.ok === true, "A1: minimal valid create parses");
  eq(r.value.trackScope, "SHARED", "A2: trackScope defaults to SHARED");
  eq(r.value.title, "Neural Nets", "A3: title is trimmed");
  eq(r.value.order, null, "A4: order null means append-after-max");
  eq(r.value.duration, null, "A5: duration null means schema default");
}

{
  const r = S.parseCreateLessonInput({
    title: "T",
    titleAr: "ت",
    unitId: "u1",
    trackScope: "language",
    description: "d",
    summary: "s",
    duration: 45,
    order: 3,
  });
  ok(r.ok === true, "A6: full valid create parses");
  eq(r.value.trackScope, "LANGUAGE", "A7: trackScope normalises case");
  eq(r.value.duration, 45, "A8: duration passes through");
  eq(r.value.order, 3, "A9: order passes through");
}

for (const field of [
  "status",
  "isPublished",
  "isLocked",
  "officialCode",
  "curriculumStatus",
  "topicId",
  "videoUrl",
  "pdfUrl",
  "id",
  "lessonId",
  "courseId",
]) {
  const r = S.parseCreateLessonInput({
    title: "T",
    titleAr: "ت",
    unitId: "u1",
    [field]: field === "status" ? "PUBLISHED" : "x",
  });
  ok(
    r.ok === false && r.code === "FORBIDDEN_FIELD" && r.field === field,
    `A10: create rejects client-supplied ${field}`
  );
}

{
  // Even a "harmless-looking" lifecycle value is rejected: the client never
  // gets a vote on lifecycle state, including DRAFT itself.
  const r = S.parseCreateLessonInput({ title: "T", titleAr: "ت", unitId: "u1", status: "DRAFT" });
  ok(r.ok === false && r.code === "FORBIDDEN_FIELD", "A11: create rejects status:DRAFT too");
}

{
  ok(S.parseCreateLessonInput(null).ok === false, "A12: null body rejected");
  ok(S.parseCreateLessonInput([]).ok === false, "A13: array body rejected");
  ok(
    S.parseCreateLessonInput({ titleAr: "ت", unitId: "u1" }).code === "TITLE_REQUIRED",
    "A14: missing title rejected"
  );
  ok(
    S.parseCreateLessonInput({ title: "   ", titleAr: "ت", unitId: "u1" }).code ===
      "TITLE_REQUIRED",
    "A15: blank title rejected"
  );
  ok(
    S.parseCreateLessonInput({ title: "T", titleAr: "ت" }).code === "UNIT_ID_REQUIRED",
    "A16: missing unitId rejected"
  );
  ok(
    S.parseCreateLessonInput({ title: "T", titleAr: "ت", unitId: "u1", trackScope: "FRENCH" })
      .code === "INVALID_TRACK_SCOPE",
    "A17: unknown trackScope rejected"
  );
  ok(
    S.parseCreateLessonInput({ title: "T", titleAr: "ت", unitId: "u1", duration: 0 }).code ===
      "INVALID_DURATION",
    "A18: zero duration rejected"
  );
  ok(
    S.parseCreateLessonInput({ title: "T", titleAr: "ت", unitId: "u1", duration: 2000 }).code ===
      "INVALID_DURATION",
    "A19: huge duration rejected"
  );
  ok(
    S.parseCreateLessonInput({ title: "T", titleAr: "ت", unitId: "u1", order: -1 }).code ===
      "INVALID_ORDER",
    "A20: negative order rejected"
  );
  ok(
    S.parseCreateLessonInput({ title: "x".repeat(201), titleAr: "ت", unitId: "u1" }).code ===
      "TITLE_TOO_LONG",
    "A21: overlong title rejected"
  );
}

// ---------------------------------------------------------------------------
// B. Update validator — the seven safe keys, nothing else
// ---------------------------------------------------------------------------
section("B. parseUpdateLessonInput");

{
  const r = S.parseUpdateLessonInput({ title: "New", trackScope: "ARABIC" });
  ok(r.ok === true, "B1: partial update parses");
  eq(r.touched.sort(), ["title", "trackScope"].sort(), "B2: touched lists edited keys");
  eq(r.value.trackScope, "ARABIC", "B3: trackScope change parses");
}

{
  const r = S.parseUpdateLessonInput({
    title: "T",
    titleAr: "ت",
    description: null,
    summary: "",
    duration: 60,
    order: 2,
    trackScope: "SHARED",
  });
  ok(r.ok === true, "B4: all seven safe keys parse together");
  eq(r.value.description, null, "B5: null description clears");
  eq(r.value.summary, null, "B6: blank summary clears to null");
}

for (const field of [
  "status",
  "isPublished",
  "isLocked",
  "officialCode",
  "curriculumStatus",
  "topicId",
  "unitId",
  "videoUrl",
  "pdfUrl",
  "id",
  "lessonId",
  "courseId",
  "createdAt",
  "updatedAt",
]) {
  const r = S.parseUpdateLessonInput({ title: "T", [field]: "x" });
  ok(
    r.ok === false && r.code === "FORBIDDEN_FIELD" && r.field === field,
    `B7: update rejects client-supplied ${field}`
  );
}

{
  const r = S.parseUpdateLessonInput({});
  ok(r.ok === false && r.code === "NOTHING_TO_UPDATE", "B8: empty update rejected");
  const r2 = S.parseUpdateLessonInput({ title: "   " });
  ok(r2.ok === false && r2.code === "TITLE_REQUIRED", "B9: blank title rejected");
  const r3 = S.parseUpdateLessonInput({ trackScope: "KLINGON" });
  ok(r3.ok === false && r3.code === "INVALID_TRACK_SCOPE", "B10: bad trackScope rejected");
  const r4 = S.parseUpdateLessonInput({ duration: 1.5 });
  ok(r4.ok === false && r4.code === "INVALID_DURATION", "B11: fractional duration rejected");
}

// ---------------------------------------------------------------------------
// C. List query grammar — strict filters, safe pagination
// ---------------------------------------------------------------------------
section("C. parseLessonListQuery");

{
  const q = (o) => S.parseLessonListQuery(o);
  const d = q({});
  ok(d.ok === true, "C1: empty query parses");
  eq(d.value.page, 1, "C2: default page is 1");
  eq(d.value.pageSize, 50, "C3: default pageSize is 50");
  eq(d.value.includeReadiness, false, "C4: readiness opt-in by default");

  const f = q({
    courseId: "c1",
    status: "published",
    trackScope: "arabic",
    curriculumStatus: "Official",
    q: "  1-1  ",
    includeReadiness: "1",
    page: "2",
    pageSize: "10",
  });
  ok(f.ok === true, "C5: full filter set parses");
  eq(f.value.status, "PUBLISHED", "C6: status normalises case");
  eq(f.value.trackScope, "ARABIC", "C7: trackScope normalises case");
  eq(f.value.curriculumStatus, "OFFICIAL", "C8: curriculumStatus normalises case");
  eq(f.value.q, "1-1", "C9: search trims");
  eq(f.value.includeReadiness, true, "C10: includeReadiness=1 opts in");

  ok(q({ status: "OPEN" }).code === "INVALID_STATUS", "C11: unknown status rejected");
  ok(q({ trackScope: "BOTH" }).ok === true, "C12: BOTH normalises to SHARED (track-scope alias)");
  ok(
    q({ trackScope: "XX" }).code === "INVALID_TRACK_SCOPE",
    "C13: unknown trackScope rejected"
  );
  ok(
    q({ curriculumStatus: "DELETED" }).code === "INVALID_CURRICULUM_STATUS",
    "C14: unknown curriculumStatus rejected"
  );
  ok(q({ page: "0" }).code === "INVALID_PAGE", "C15: page 0 rejected");
  ok(q({ page: "abc" }).code === "INVALID_PAGE", "C16: non-numeric page rejected");
  const capped = q({ pageSize: "99999" });
  eq(capped.value.pageSize, 200, "C17: pageSize capped at 200");

  // URLSearchParams input (the shape the route actually passes).
  const usp = new URLSearchParams("status=READY&includeReadiness=true");
  const u = q(usp);
  ok(u.ok === true && u.value.status === "READY", "C18: URLSearchParams input parses");
  eq(u.value.includeReadiness, true, "C19: includeReadiness=true opts in");
}

// ---------------------------------------------------------------------------
// D. Archive ceremony input + eligibility
// ---------------------------------------------------------------------------
section("D. archive input");

{
  eq(S.parseArchiveAction(null), "ARCHIVE", "D1: missing body defaults to ARCHIVE");
  eq(S.parseArchiveAction({}), "ARCHIVE", "D2: missing action defaults to ARCHIVE");
  eq(S.parseArchiveAction({ action: "restore" }), "RESTORE", "D3: restore parses (any case)");
  eq(S.parseArchiveAction({ action: "DELETE" }), null, "D4: unknown action rejected");
  eq(S.parseArchiveAction([]), null, "D5: array body rejected");
  eq(S.parseArchiveAction("ARCHIVE"), null, "D6: string body rejected");
}

{
  ok(S.canArchiveFromStatus("DRAFT") === true, "D7: DRAFT archivable");
  ok(S.canArchiveFromStatus("READY") === true, "D8: READY archivable");
  ok(S.canArchiveFromStatus("PUBLISHED") === false, "D9: PUBLISHED NOT archivable directly");
  ok(S.canArchiveFromStatus("BOGUS") === false, "D10: unknown status fails closed");
  ok(S.canArchiveFromStatus(null) === false, "D11: null status fails closed");
}

// ---------------------------------------------------------------------------
// E. Vocabulary consistency — one lattice, shared everywhere
// ---------------------------------------------------------------------------
section("E. vocabulary");

{
  eq([...S.LESSON_STATUSES], ["DRAFT", "READY", "PUBLISHED"], "E1: status lattice pinned");
  eq(
    [...S.LESSON_STATUSES],
    [...L.LESSON_STATUSES],
    "E2: admin module re-exports the lifecycle lattice (no second list)"
  );
  eq(S.normalizeLessonStatus("ready"), L.normalizeLessonStatus("ready"), "E3: same normaliser");
  eq(
    [...S.CURRICULUM_STATUSES].sort(),
    ["ARCHIVED", "LEGACY", "OFFICIAL"],
    "E4: curriculum standing vocabulary pinned"
  );
  const codes = [...S.ADMIN_SESSION_ERROR_CODES];
  ok(new Set(codes).size === codes.length, "E5: error codes unique");
  for (const c of ["FORBIDDEN_FIELD", "INVALID_TRACK_SCOPE", "LESSON_ARCHIVED", "ARCHIVE_REQUIRES_UNPUBLISH"]) {
    ok(codes.includes(c), `E6: error catalogue lists ${c}`);
  }
}

// ---------------------------------------------------------------------------
// Sources under test
// ---------------------------------------------------------------------------
section("F. route + component sources load");

const read = (p) => fs.readFileSync(path.join(REPO, p), "utf8");
const SRC = {
  list: read("src/app/api/admin/lessons/route.ts"),
  detail: read("src/app/api/admin/lessons/[id]/route.ts"),
  archive: read("src/app/api/admin/lessons/[id]/archive/route.ts"),
  lib: read("src/lib/admin-sessions.ts"),
  shared: read("src/components/admin/session-workflow-shared.tsx"),
  listView: read("src/components/admin/session-workflow-view.tsx"),
  detailView: read("src/components/admin/session-detail-view.tsx"),
  openDialog: read("src/components/admin/session-open-dialog.tsx"),
  pdfManager: read("src/components/admin/session-pdf-manager.tsx"),
  mockExams: read("src/components/admin/mock-exams-view.tsx"),
  dashboard: read("src/components/admin/admin-dashboard.tsx"),
  shell: read("src/components/dashboard/shell.tsx"),
  appShell: read("src/components/app-shell.tsx"),
  store: read("src/lib/store.ts"),
};
ok(Object.values(SRC).every((s) => s.length > 100), "F1: all sources readable");

// ---------------------------------------------------------------------------
// G. Routes are ADMIN-only and reuse the shared machinery
// ---------------------------------------------------------------------------
section("G. route authorization + reuse");

{
  const adminCalls = (SRC.list.match(/requireRole\("ADMIN"\)/g) || []).length;
  eq(adminCalls, 2, "G1: list route guards GET and POST as ADMIN");
  const detailCalls = (SRC.detail.match(/requireRole\("ADMIN"\)/g) || []).length;
  eq(detailCalls, 2, "G2: detail route guards GET and PATCH as ADMIN");
  ok(/requireRole\("ADMIN"\)/.test(SRC.archive), "G3: archive route guards POST as ADMIN");
}

{
  pinned(
    SRC.list,
    /LESSON_NEW_LIFECYCLE/,
    "G4: create uses LESSON_NEW_LIFECYCLE (no invented initial state)"
  );
  pinned(
    SRC.list,
    /computeLessonReadiness\(/,
    "G5: list readiness uses computeLessonReadiness — the SAME helper the OPEN ceremony enforces"
  );
  pinned(
    SRC.list,
    /READINESS_LESSON_INCLUDE/,
    "G6: list loads the shared readiness include shape"
  );
  pinned(
    SRC.detail,
    /getLessonReadiness\(/,
    "G7: detail readiness uses getLessonReadiness (same loader as the ceremony)"
  );
  pinned(
    SRC.detail,
    /parseUpdateLessonInput\(/,
    "G8: PATCH validates through the shared parser"
  );
  pinned(
    SRC.list,
    /parseCreateLessonInput\(/,
    "G9: POST validates through the shared parser"
  );
}

{
  // Creation can never mint official identity or lifecycle state: the pins
  // assert the literal safe values in the create call.
  pinned(SRC.list, /officialCode:\s*null/, "G10: create writes officialCode null");
  pinned(SRC.list, /topicId:\s*null/, "G11: create writes topicId null (canonical chain only)");
  pinned(
    SRC.list,
    /curriculumStatus:\s*"LEGACY"/,
    "G12: created rows are LEGACY, never OFFICIAL"
  );
  absent(
    SRC.list,
    /status:\s*"(DRAFT|READY|PUBLISHED)"/,
    "G13: create spells no literal status (LESSON_NEW_LIFECYCLE owns it)",
    `status: "DRAFT"`
  );
}

{
  // PATCH writes only the seven safe keys: extract the `data` assignments
  // and forbid every sensitive field inside that region.
  const m = /const data[^=]*=\s*\{\};([\s\S]*?)const updated = await db\.lesson\.update/.exec(
    SRC.detail
  );
  ok(!!m, "G14: PATCH builds an explicit data object");
  const region = m ? m[1] : "";
  for (const f of [
    "status",
    "isPublished",
    "isLocked",
    "officialCode",
    "curriculumStatus",
    "videoUrl",
    "pdfUrl",
    "unitId",
    "topicId",
  ]) {
    ok(
      !new RegExp(`data\\.${f}\\b|data\\[.${f}.\\]`).test(region),
      `G15: PATCH data never assigns ${f}`
    );
  }
  for (const f of ["title", "titleAr", "description", "summary", "duration", "order", "trackScope"]) {
    ok(new RegExp(`data\\.${f}\\b`).test(region), `G16: PATCH data assigns safe key ${f}`);
  }
}

{
  // Comments may NAME the forbidden field (to document its absence); code may
  // not. Strip comments before asserting.
  const stripComments = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  absent(
    stripComments(SRC.detail),
    /storageKey/,
    "G17: detail select/exposure never mentions storageKey",
    "storageKey"
  );
  absent(
    stripComments(SRC.list),
    /storageKey/,
    "G18: list select/exposure never mentions storageKey",
    "storageKey"
  );
  pinned(SRC.detail, /LESSON_ARCHIVED/, "G19: PATCH refuses archived lessons");
  pinned(SRC.archive, /ARCHIVE_REQUIRES_UNPUBLISH/, "G20: archive refuses PUBLISHED");
  pinned(SRC.archive, /NO_OP_ALREADY_ARCHIVED/, "G21: archive is idempotent");
  pinned(SRC.archive, /NO_OP_NOT_ARCHIVED/, "G22: restore is idempotent");
  pinned(
    SRC.archive,
    /lesson\.officialCode \? "OFFICIAL" : "LEGACY"/,
    "G23: restore re-derives standing from officialCode (never invents it)"
  );
}

// ---------------------------------------------------------------------------
// H. UI never computes lifecycle/readiness locally
// ---------------------------------------------------------------------------
section("H. no client-side lifecycle");

{
  for (const [name, src] of [
    ["shared", SRC.shared],
    ["listView", SRC.listView],
    ["detailView", SRC.detailView],
    ["openDialog", SRC.openDialog],
    ["pdfManager", SRC.pdfManager],
  ]) {
    absent(src, /computeLessonReadiness/, `H1: ${name} never imports the readiness computation`, "computeLessonReadiness");
    absent(src, /getLessonReadiness/, `H2: ${name} never imports the readiness loader`, "getLessonReadiness");
    absent(src, /transitionLesson|openLesson|markLessonReady/, `H3: ${name} never imports the ceremony`, "transitionLesson");
    // A line importing session-lifecycle that is NOT type-only is the defect;
    // `import type` is erased at build and is the sanctioned shape sharing.
    const runtimeImport = src
      .split("\n")
      .some(
        (l) =>
          l.includes('from "@/lib/session-lifecycle"') && !l.includes("import type")
      );
    ok(!runtimeImport, `H4: ${name} has no runtime import of session-lifecycle`);
    const withBad =
      src + '\nimport { x } from "@/lib/session-lifecycle";';
    ok(
      withBad
        .split("\n")
        .some(
          (l) =>
            l.includes('from "@/lib/session-lifecycle"') && !l.includes("import type")
        ),
      `H4: ${name} — negative control: a runtime import trips the check`
    );
  }
  // Type-only imports are erased at build and are the sanctioned way to share
  // the wire shapes.
  pinned(
    SRC.shared,
    /import type[\s\S]*?from "@\/lib\/admin-sessions"/,
    "H5: shared module imports admin contracts type-only"
  );
}

{
  // The checklist renders the server fields — pin each field access.
  for (const field of ["item.present", "item.valid", "item.required", "item.state", "item.code"]) {
    pinned(SRC.shared, new RegExp(field.replace(".", "\\.")), `H6: checklist renders ${field}`);
  }
  pinned(SRC.shared, /readiness\.blocking/, "H7: checklist renders server blocking codes");
  pinned(SRC.shared, /readiness\.notes/, "H8: checklist renders server notes");
  pinned(SRC.listView, /readiness\.canBeReady/, "H9a: list verdict renders server canBeReady");
  pinned(
    SRC.detailView,
    /detail\.readiness\.canBeReady/,
    "H9b: detail verdict renders server canBeReady"
  );
}

{
  // ONE fetch per screen: the detail payload already carries readiness, so
  // no component may call the standalone readiness endpoint (that second
  // call is exactly how stale readiness happens).
  for (const [name, src] of [
    ["listView", SRC.listView],
    ["detailView", SRC.detailView],
    ["openDialog", SRC.openDialog],
    ["pdfManager", SRC.pdfManager],
  ]) {
    absent(src, /\/readiness/, `H10: ${name} never fetches the standalone readiness endpoint`, "/readiness");
  }
  pinned(
    SRC.detailView,
    /\/api\/admin\/lessons\/\$\{encodeURIComponent\(lessonId\)\}["`]/,
    "H11: detail loads from the single detail endpoint"
  );
}

// ---------------------------------------------------------------------------
// I. Ceremony calls + outcome handling
// ---------------------------------------------------------------------------
section("I. lifecycle ceremony calls");

{
  pinned(
    SRC.openDialog,
    /\/api\/admin\/lessons\/\$\{encodeURIComponent\(lessonId\)\}\/\$\{action\}/,
    "I1: ceremonies POST to …/lessons/[id]/<action>"
  );
  for (const a of ["open", "mark-ready", "unpublish"]) {
    pinned(SRC.openDialog, new RegExp(`"${a}"`), `I2: ${a} ceremony is wired`);
  }
  pinned(
    SRC.openDialog,
    /NO_OP_ALREADY_IN_STATE/,
    "I3: idempotent replay is handled (no fake second publish)"
  );
  pinned(
    SRC.openDialog,
    /READINESS_BLOCKED/,
    "I4: readiness refusal surfaces live blocking codes"
  );
  pinned(SRC.openDialog, /if \(confirming\) return/, "I5: in-flight guard blocks double submit");
  const disabledCount = (SRC.openDialog.match(/disabled=\{confirming\}/g) || []).length;
  ok(disabledCount >= 3, `I6: confirm buttons disable while in flight (${disabledCount})`);
}

{
  // The open confirmation shows session + status + scope + readiness +
  // target segment + expected effect.
  pinned(SRC.openDialog, /StatusBadge/, "I7: open dialog shows status");
  pinned(SRC.openDialog, /TrackScopeBadge/, "I8: open dialog shows track scope");
  pinned(SRC.openDialog, /ReadinessChecklist/, "I9: open dialog shows server readiness");
  pinned(SRC.openDialog, /admin\.399/, "I10: open dialog shows the target segment");
  pinned(SRC.openDialog, /admin\.401/, "I11: open dialog shows the expected effect");
  pinned(SRC.openDialog, /segmentLabelKey/, "I12: segment derives from scope (SHARED→both)");
}

{
  // Archived sessions cannot be opened: the UI gates every lifecycle action.
  pinned(SRC.detailView, /archived/, "I13: detail tracks archived state");
  pinned(SRC.detailView, /admin\.452/, "I14: archived sessions show the cannot-open notice");
  ok(
    /isDraft && !archived/.test(SRC.detailView) &&
      /isReady && !archived/.test(SRC.detailView) &&
      /isPublished && !archived/.test(SRC.detailView),
    "I15: mark-ready/open/unpublish buttons all require !archived"
  );
  pinned(SRC.detailView, /disabled=\{archived\}/, "I16: edit is disabled while archived");
}

// ---------------------------------------------------------------------------
// J. Badges + track/status/curriculum rendering
// ---------------------------------------------------------------------------
section("J. rendering contracts");

{
  pinned(SRC.shared, /admin\.343/, "J1: DRAFT label");
  pinned(SRC.shared, /admin\.344/, "J2: READY label");
  pinned(SRC.shared, /admin\.345/, "J3: PUBLISHED label");
  pinned(SRC.shared, /admin\.349/, "J4: SHARED label");
  pinned(SRC.shared, /admin\.350/, "J5: ARABIC label");
  pinned(SRC.shared, /admin\.351/, "J6: LANGUAGE label");
  pinned(SRC.shared, /admin\.346/, "J7: OFFICIAL label");
  pinned(SRC.shared, /admin\.347/, "J8: LEGACY label");
  pinned(SRC.shared, /admin\.321/, "J9: ARCHIVED label");
}

{
  // Create/edit payloads carry only safe keys.
  const createBody = /body: JSON\.stringify\(\{([\s\S]*?)\}\)/.exec(SRC.listView);
  ok(!!createBody, "J10: create dialog stringifies an explicit body");
  const region = createBody ? createBody[1] : "";
  for (const f of ["status", "officialCode", "isPublished", "curriculumStatus", "topicId"]) {
    ok(!new RegExp(`\\b${f}\\b`).test(region), `J11: create body never carries ${f}`);
  }
  pinned(SRC.listView, /trackScope: form\.trackScope/, "J12: create body carries trackScope");
}

// ---------------------------------------------------------------------------
// K. PDF manager reuses the Phase 14 API (no second upload system)
// ---------------------------------------------------------------------------
section("K. PDF reuse");

{
  pinned(
    SRC.pdfManager,
    /\/api\/admin\/lessons\/\$\{encodeURIComponent\(lessonId\)\}\/materials/,
    "K1: PDF manager calls the material API"
  );
  pinned(SRC.pdfManager, /method: "POST"/, "K2: upload via POST");
  pinned(SRC.pdfManager, /method: "DELETE"/, "K3: deactivate via DELETE");
  pinned(SRC.pdfManager, /new FormData\(\)/, "K4: multipart upload");
  pinned(SRC.pdfManager, /accept="application\/pdf/, "K5: file picker accepts PDFs");
  absent(SRC.pdfManager, /storageKey/, "K6: PDF UI never touches storage internals", "storageKey");
  pinned(SRC.pdfManager, /onChanged/, "K7: mutations refresh the detail payload");
}

// ---------------------------------------------------------------------------
// L. FIXED mock-exam pin counts
// ---------------------------------------------------------------------------
section("L. FIXED exam safety display");

{
  pinned(SRC.mockExams, /selectionMode === "FIXED"/, "L1: FIXED exams get a pin-count row");
  pinned(SRC.mockExams, /pinnedQuestions/, "L2: server pinnedQuestions is rendered");
  pinned(SRC.mockExams, /admin\.460/, "L3: pinned label is localized");
  pinned(SRC.mockExams, /admin\.461/, "L4: '{p1} of {p2} pinned' is localized");
  pinned(SRC.mockExams, /admin\.462/, "L5: incomplete pinned set warns");
  pinned(SRC.mockExams, /admin\.463/, "L6: selection mode label is localized");
  pinned(SRC.mockExams, /admin\.464/, "L7: Fixed label is localized");
  pinned(SRC.mockExams, /admin\.465/, "L8: Random label is localized");
  absent(SRC.mockExams, />Fixed</, "L9: no hardcoded 'Fixed'", ">Fixed<");
  absent(SRC.mockExams, />Random</, "L10: no hardcoded 'Random'", ">Random<");
}

// ---------------------------------------------------------------------------
// M. View wiring
// ---------------------------------------------------------------------------
section("M. navigation wiring");

{
  pinned(SRC.store, /"admin-sessions"/, "M1: store carries the admin-sessions view key");
  pinned(SRC.appShell, /case "admin-sessions":/, "M2: app shell routes admin-sessions");
  ok(
    /"admin-courses",\s*"admin-sessions",\s*"admin-payments"/.test(SRC.appShell),
    "M3: admin-sessions is whitelisted for ADMIN"
  );
  pinned(SRC.shell, /key: "admin-sessions"/, "M4: sidebar links admin-sessions");
  pinned(SRC.shell, /label: "admin\.323"/, "M5: nav label is the localized workflow title");
  pinned(SRC.dashboard, /SessionWorkflowView/, "M6: dashboard renders the workflow view");
  pinned(
    SRC.dashboard,
    /view === "admin-sessions" && <SessionWorkflowView \/>/,
    "M7: workflow renders exactly on admin-sessions"
  );
  pinned(SRC.dashboard, /bankNavParam/, "M8: question bank preselects the deep-linked lesson");
}

// ---------------------------------------------------------------------------
// N. i18n: every used key exists with non-empty AR+EN
// ---------------------------------------------------------------------------
section("N. dictionary contract");

{
  // Read the shipped catalogues without a TS compile: entries are
  // `"ns.nnn": { ar: "…", en: "…" }` (possibly multiline).
  const dictSrc = read("src/lib/i18n-dict.ts") + "\n" + read("src/lib/i18n-dict-2026.ts");
  const entries = new Map();
  const re = /"([a-z][a-z0-9]*(?:\.[A-Za-z0-9_]+)+)"\s*:\s*\{\s*ar:\s*"((?:[^"\\]|\\.)*)"\s*,\s*en:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(dictSrc))) entries.set(m[1], { ar: m[2], en: m[3] });
  ok(entries.size > 1000, `N1: catalogues parsed (${entries.size} entries)`);

  // Every tr("…") call in the new/edited UI must resolve with both locales.
  const uiFiles = {
    shared: SRC.shared,
    listView: SRC.listView,
    detailView: SRC.detailView,
    openDialog: SRC.openDialog,
    pdfManager: SRC.pdfManager,
  };
  const used = new Set();
  for (const src of Object.values(uiFiles)) {
    const trRe = /tr\("([a-z][a-z0-9]*(?:\.[A-Za-z0-9_]+)+)"\)/g;
    let t;
    // `admin.3xx` appears only in a doc comment (never a real call) — skip it.
    while ((t = trRe.exec(src))) if (t[1] !== "admin.3xx") used.add(t[1]);
  }
  // Dynamic label maps (not literal tr() calls) — pinned explicitly.
  for (const k of [
    "admin.380",
    "admin.381",
    "admin.382",
    "admin.383",
    "admin.455",
    "admin.408",
    "admin.409",
    "admin.410",
    "admin.411",
    "admin.412",
    "admin.490",
    "admin.491",
    "admin.492",
    "admin.344",
    "admin.321",
  ]) {
    used.add(k);
  }
  let missing = 0;
  let empty = 0;
  for (const k of used) {
    const e = entries.get(k);
    if (!e) {
      missing++;
      console.error("FAIL: N2 missing key", k);
      continue;
    }
    if (!e.ar || !e.en) {
      empty++;
      console.error("FAIL: N3 empty locale for", k, JSON.stringify(e));
    }
  }
  ok(missing === 0, `N2: all ${used.size} used keys exist in the catalogues`);
  ok(empty === 0, "N3: every used key has non-empty AR and EN");
  if (missing > 0) fail += missing;
  if (empty > 0) fail += empty;
}

// ---------------------------------------------------------------------------
// O. RTL: logical properties only in the new UI
// ---------------------------------------------------------------------------
section("O. RTL safety");

{
  for (const [name, src] of [
    ["shared", SRC.shared],
    ["listView", SRC.listView],
    ["detailView", SRC.detailView],
    ["openDialog", SRC.openDialog],
    ["pdfManager", SRC.pdfManager],
  ]) {
    // Physical spacing/position utilities inside class strings…
    absent(
      src,
      /className="[^"]*\b(ml|mr|pl|pr)-/,
      `O1: ${name} uses no physical ml/mr/pl/pr utilities`,
      'className="x ml-2"'
    );
    absent(
      src,
      /className="[^"]*\btext-(left|right)\b/,
      `O2: ${name} uses no physical text-left/right`,
      'className="x text-left"'
    );
    absent(
      src,
      /className="[^"]*\b(left|right)-[0-9]/,
      `O3: ${name} uses no physical left-/right- offsets`,
      'className="x left-2"'
    );
    // …while logical utilities ARE used (the pin must prove the habit).
    ok(
      /(ms-|me-|ps-|pe-|start-|end-)/.test(src),
      `O4: ${name} uses logical (ms/me/ps/pe/start/end) utilities`
    );
  }
}

// ---------------------------------------------------------------------------
// P. Quiz/homework honesty — no invented endpoints
// ---------------------------------------------------------------------------
section("P. deferred-backend honesty");

{
  pinned(SRC.detailView, /admin\.435/, "P1: homework section carries the Phase 18 notice");
  absent(SRC.detailView, /\/api\/admin\/homework/, "P2: no invented homework endpoint is called", "/api/admin/homework");
  absent(
    SRC.detailView,
    /\/api\/teacher\/quizzes/,
    "P3: admin UI never calls the teacher-only quiz endpoint",
    "/api/teacher/quizzes"
  );
  pinned(
    SRC.detailView,
    /setView\("admin-question-bank"\)/,
    "P4: quiz management navigates to the existing bank surface"
  );
  pinned(
    SRC.detailView,
    /setView\("admin-session-videos"\)/,
    "P5: video staging navigates to the existing videos surface"
  );
}

// ---------------------------------------------------------------------------
// Q. Reader/loader contract + real end-to-end admin workflow
// ---------------------------------------------------------------------------
section("Q. Reader/loader contract + real end-to-end admin workflow");
{
  // The loader (`READINESS_LESSON_INCLUDE`) selects quizzes as
  // `{ id, trackScope, _count: { questions: N } }`. The reader MUST accept
  // exactly that: a `_count` the loader selected but the reader ignored used
  // to fail closed to QUIZ_EMPTY and made every quiz-carrying lesson
  // un-openable (found by the Phase 15 e2e; fixed in session-lifecycle.ts).
  const base = {
    id: "q",
    status: "DRAFT",
    curriculumStatus: "LEGACY",
    trackScope: "SHARED",
    officialCode: null,
    videoUrl: null,
    pdfUrl: null,
    sessionVideos: [],
    materials: [],
    homeworks: [],
  };
  const withCount = L.computeLessonReadiness({
    ...base,
    quizzes: [{ id: "z", trackScope: "SHARED", _count: { questions: 2 } }],
  });
  ok(
    withCount.items.find((i) => i.key === "QUIZ").code === "QUIZ_OK",
    "Q1: the _count loader shape reads QUIZ_OK"
  );
  ok(
    !withCount.blocking.includes("QUIZ_EMPTY"),
    "Q2: no phantom QUIZ_EMPTY for a quiz with questions"
  );
  const emptyCount = L.computeLessonReadiness({
    ...base,
    quizzes: [{ id: "z", trackScope: "SHARED", _count: { questions: 0 } }],
  });
  ok(
    emptyCount.items.find((i) => i.key === "QUIZ").code === "QUIZ_EMPTY",
    "Q3: a _count of 0 still reads QUIZ_EMPTY"
  );
  ok(
    emptyCount.blocking.includes("QUIZ_EMPTY"),
    "Q4: a genuinely-empty quiz still blocks"
  );
  ok(
    L.READINESS_LESSON_INCLUDE.quizzes.select._count.select.questions === true,
    "Q5: the loader still selects the quiz _count (reader+loader reviewed together)"
  );
}
{
  // The full workflow against real migrated SQLite + compiled shipped routes
  // + real media bytes. This is the suite's strongest gate: it fails if any
  // lifecycle rule, readiness verdict, auth check or byte on disk disagrees.
  const script = path.join(REPO, "scripts", "verify-phase15-admin.mjs");
  ok(fs.existsSync(script), "Q6: verify-phase15-admin.mjs exists");
  let out = "";
  let code = -1;
  try {
    out = execSync(`${process.execPath} ${script}`, {
      cwd: REPO,
      stdio: "pipe",
      timeout: 240000,
      encoding: "utf8",
    });
    code = 0;
  } catch (e) {
    out = String((e.stdout || "") + (e.stderr || ""));
    code = e.status ?? 1;
  }
  ok(code === 0, "Q7: the e2e script exits 0");
  const m = /phase15 admin e2e: (\d+) passed, (\d+) failed/.exec(out);
  ok(
    !!m && Number(m[2]) === 0 && Number(m[1]) > 200,
    `Q8: the e2e script is green (${m ? m[0] : "no summary in output"})`
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("failures:");
  for (const f of failures) console.log(" -", f);
}
process.exit(fail ? 1 : 0);
