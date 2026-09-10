// CodeMind Academy — Phase 16 (student locked curriculum & session access).
//
// WHAT THIS FILE PROVES
//   The student curriculum behaves as PUBLISHED + UNLOCKED → full access,
//   PUBLISHED + LOCKED → visible skeleton with redacted content, and
//   DRAFT / READY / ARCHIVED → invisible — under mandatory track isolation,
//   with one unified session page and safe deep links:
//
//     visibility  • the shared predicate (lifecycle + archive + track +
//                   course) answers every combination, and the single-id gate
//                   answers the same through a fake DB.
//     skeleton    • the course tree serialises identity + lock-independent
//                   presence (officialCode / hasVideo / hasPdf /
//                   materialCount) while STILL redacting every protected
//                   field of locked sessions (Phase 4 pins re-asserted).
//     unpublished • DRAFT/READY/ARCHIVED/wrong-track/wrong-course lessons are
//                   invisible to bookmarks, notes, prev/next, dashboard,
//                   session videos and direct-id fetches.
//     unified page• the lesson view renders title/video/PDF/quiz/homework/
//                   progress/requirements/recordings as one session, with
//                   content-free locked vs not-available skeletons.
//     deep links  • lesson:/video:/quiz:/homework: parse strictly, map onto
//                   the four views via (setView, setNavParam) in that order,
//                   and every landing view re-fetches through its authorized
//                   API — a link can never bypass auth/track/course/
//                   lifecycle/progression.
//     progression • no second unlock algorithm: the visibility module never
//                   reads video/quiz/assignment state, and the client never
//                   derives unlock.
//     parent      • preview stays lifecycle + track + course scoped.
//     i18n/RTL   • every new key exists with non-empty AR+EN; new markup uses
//                   logical properties and responsive stacks.
//
// Layers (same convention as the Phase 11–15 suites):
//   1. Pure functions from the SHIPPED modules (tsc-compiled, no mocks).
//   2. The single-id gate against a fake DB with real-shaped rows.
//   3. Source pins with negative controls over routes + components.
//   4. Dictionary contract checks over the shipped catalogues.
//
// Run:  node tests/student-locked-curriculum-phase16.test.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase16-test-"));

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
function read(rel) {
  // Source pins below contain multi-line literal needles written with LF
  // (e.g. J15's "\n    }\n    return ("). Git's core.autocrlf=true converts
  // text files to CRLF on Windows checkouts, which would otherwise make those
  // needles miss. Normalize CRLF → LF once here so every pin is
  // line-ending agnostic; the assertions and their negative controls are
  // otherwise unchanged.
  return fs.readFileSync(path.join(REPO, rel), "utf8").replace(/\r\n/g, "\n");
}

/**
 * A source pin with a built-in negative control (Phase 13 convention): the
 * pattern must match the real source, and must NOT match a source in which
 * the matched text has been removed.
 */
function pinned(src, re, label, mutate) {
  ok(re.test(src), label);
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
// Compile the real modules (same convention as the Phase 11–15 suites)
// ---------------------------------------------------------------------------
const MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/progress.ts",
  "src/lib/enrollment.ts",
  "src/lib/session-progress.ts",
  "src/lib/curriculum-visibility.ts",
  "src/lib/deep-link.ts",
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
for (const f of MODULES.map((m) => path.basename(m).replace(/\.ts$/, ".js"))) {
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

const DL = require(path.join(EMIT, "deep-link.js"));
const CV = require(path.join(EMIT, "curriculum-visibility.js"));

async function main() {
  // -------------------------------------------------------------------------
  // A. Deep-link parser — strict, fail-closed
  // -------------------------------------------------------------------------
  section("A. parseDeepLink — the four canonical forms");

  eq(DL.parseDeepLink("lesson:cm123abc"), { kind: "lesson", id: "cm123abc" }, "A1: lesson link parses");
  eq(DL.parseDeepLink("video:vid-1_x"), { kind: "video", id: "vid-1_x" }, "A2: video link parses (- and _ allowed)");
  eq(DL.parseDeepLink("quiz:Q9"), { kind: "quiz", id: "Q9" }, "A3: quiz link parses");
  eq(DL.parseDeepLink("homework:hw0"), { kind: "homework", id: "hw0" }, "A4: homework link parses");
  eq(
    DL.parseDeepLink("  lesson:cm123abc  "),
    { kind: "lesson", id: "cm123abc" },
    "A5: surrounding whitespace is trimmed"
  );
  eq(DL.DEEP_LINK_KINDS.slice().sort(), ["homework", "lesson", "quiz", "video"], "A6: exactly the four kinds exist");

  section("B. parseDeepLink — everything else is null (fail closed)");

  const bad = [
    ["B1", null],
    ["B2", undefined],
    ["B3", 123],
    ["B4", {}],
    ["B5", ""],
    ["B6", "   "],
    ["B7", "lesson"],
    ["B8", "lesson:"],
    ["B9", ":cm123abc"],
    ["B10", "Lesson:cm123abc"],
    ["B11", "LESSON:cm123abc"],
    ["B12", "admin:cm123abc"],
    ["B13", "course:cm123abc"],
    ["B14", "admin-payments"],
    ["B15", "lesson:../secret"],
    ["B16", "lesson:a/b"],
    ["B17", "lesson:a.b"],
    ["B18", "lesson:a b"],
    ["B19", "video:a?b=1"],
    ["B20", "quiz:a#b"],
    ["B21", "homework:a:b"],
    ["B22", "lesson:" + "a".repeat(65)],
    ["B23", "x".repeat(81)],
    ["B24", "lesson:cm123abc\nvideo:other"],
  ];
  for (const [label, input] of bad) {
    eq(DL.parseDeepLink(input), null, `${label}: ${JSON.stringify(input)} rejected`);
    ok(DL.isDeepLink(input) === false, `${label}: isDeepLink false`);
  }
  ok(DL.isDeepLink("quiz:abc") === true, "B25: isDeepLink true for a valid link");

  section("C. resolveDeepLink / deepLinkTarget / navigateDeepLink");

  eq(DL.deepLinkTarget({ kind: "lesson", id: "L1" }), { view: "student-lesson", navParam: "L1" }, "C1: lesson target");
  eq(DL.deepLinkTarget({ kind: "video", id: "V1" }), { view: "student-session-videos", navParam: "V1" }, "C2: video target");
  eq(DL.deepLinkTarget({ kind: "quiz", id: "Q1" }), { view: "student-quiz", navParam: "Q1" }, "C3: quiz target");
  eq(DL.deepLinkTarget({ kind: "homework", id: "H1" }), { view: "student-homework", navParam: "H1" }, "C4: homework target");
  eq(DL.resolveDeepLink("quiz:Q1"), { view: "student-quiz", navParam: "Q1" }, "C5: resolve parses and maps");
  eq(DL.resolveDeepLink("nope"), null, "C6: resolve returns null for junk");

  {
    const calls = [];
    const nav = {
      setView: (v) => calls.push(["setView", v]),
      setNavParam: (p) => calls.push(["setNavParam", p]),
    };
    eq(DL.navigateDeepLink("lesson:L9", nav), true, "C7: navigate returns true");
    eq(calls, [["setView", "student-lesson"], ["setNavParam", "L9"]], "C8: setView runs BEFORE setNavParam (setView clears the param)");
  }
  {
    const calls = [];
    const nav = {
      setView: (v) => calls.push(["setView", v]),
      setNavParam: (p) => calls.push(["setNavParam", p]),
    };
    eq(DL.navigateDeepLink("admin:x", nav), false, "C9: navigate returns false for junk");
    eq(calls, [], "C10: junk touches neither setView nor setNavParam");
  }

  // Every target view must be a real ViewKey — pinned against the store
  // source, because the module stays dependency-free on purpose.
  const storeSrc = read("src/lib/store.ts");
  for (const kind of DL.DEEP_LINK_KINDS) {
    const view = DL.DEEP_LINK_VIEWS[kind];
    pinned(storeSrc, new RegExp(`"${view}"`), `C11: deep-link view "${view}" is a ViewKey in the store`);
  }
  pinned(
    storeSrc,
    /setView: \(view\) => set\(\{ view, navParam: null \}\)/,
    "C12: setView clears navParam — the order pinned in C8 is load-bearing"
  );

  // -------------------------------------------------------------------------
  // D. Visibility predicate — the full matrix, no I/O
  // -------------------------------------------------------------------------
  section("D. isLessonVisibleToViewer — lifecycle x archive x track x course");

  const chain = (courseId) => ({
    id: "l1",
    order: 1,
    videoUrl: null,
    unitId: "u1",
    topicId: null,
    unit: { id: "u1", order: 1, part: { id: "p1", order: 1, courseId } },
    topic: null,
  });
  const L = (over = {}) => ({
    ...chain("c1"),
    status: "PUBLISHED",
    curriculumStatus: "OFFICIAL",
    trackScope: "SHARED",
    ...over,
  });
  const legacyChain = (courseId) => ({
    id: "l1",
    order: 1,
    videoUrl: null,
    unitId: null,
    topicId: "t1",
    unit: null,
    topic: { order: 1, unit: { id: "u1", order: 1, part: { id: "p1", order: 1, courseId } } },
  });

  eq(CV.isLessonVisibleToViewer(L(), { schoolType: "ARABIC", courseId: "c1" }), true, "D1: PUBLISHED + SHARED is visible");
  eq(CV.isLessonVisibleToViewer(L({ status: "DRAFT" }), { schoolType: "ARABIC", courseId: "c1" }), false, "D2: DRAFT is invisible");
  eq(CV.isLessonVisibleToViewer(L({ status: "READY" }), { schoolType: "ARABIC", courseId: "c1" }), false, "D3: READY is invisible");
  eq(CV.isLessonVisibleToViewer(L({ status: "WAT" }), { schoolType: "ARABIC", courseId: "c1" }), false, "D4: unknown status fails closed");
  eq(CV.isLessonVisibleToViewer(L({ status: "published" }), { schoolType: "ARABIC", courseId: "c1" }), true, "D5: status normalises case");
  eq(
    CV.isLessonVisibleToViewer(L({ curriculumStatus: "ARCHIVED" }), { schoolType: "ARABIC", courseId: "c1" }),
    false,
    "D6: ARCHIVED is invisible even when PUBLISHED"
  );
  eq(
    CV.isLessonVisibleToViewer(L({ curriculumStatus: "archived" }), { schoolType: "ARABIC", courseId: "c1" }),
    false,
    "D7: archive check is case-insensitive"
  );
  eq(
    CV.isLessonVisibleToViewer(L({ trackScope: "ARABIC" }), { schoolType: "ARABIC", courseId: "c1" }),
    true,
    "D8: ARABIC lesson visible to ARABIC student"
  );
  eq(
    CV.isLessonVisibleToViewer(L({ trackScope: "ARABIC" }), { schoolType: "LANGUAGE", courseId: "c1" }),
    false,
    "D9: ARABIC lesson invisible to LANGUAGE student"
  );
  eq(
    CV.isLessonVisibleToViewer(L({ trackScope: "LANGUAGE" }), { schoolType: "ARABIC", courseId: "c1" }),
    false,
    "D10: LANGUAGE lesson invisible to ARABIC student"
  );
  eq(
    CV.isLessonVisibleToViewer(L({ trackScope: "LANGUAGE" }), { schoolType: "LANGUAGE", courseId: "c1" }),
    true,
    "D11: LANGUAGE lesson visible to LANGUAGE student"
  );
  eq(CV.isLessonVisibleToViewer(L(), { schoolType: "LANGUAGE", courseId: "c1" }), true, "D12: SHARED visible to LANGUAGE student");
  eq(
    CV.isLessonVisibleToViewer(L({ trackScope: "WAT" }), { schoolType: "ARABIC", courseId: "c1" }),
    false,
    "D13: unknown trackScope fails closed"
  );
  eq(CV.isLessonVisibleToViewer(L(), { schoolType: "WAT", courseId: "c1" }), true, "D14: unknown school type still sees SHARED");
  eq(
    CV.isLessonVisibleToViewer(L({ trackScope: "ARABIC" }), { schoolType: "WAT", courseId: "c1" }),
    false,
    "D15: unknown school type never sees track content"
  );
  eq(CV.isLessonVisibleToViewer(L(), { schoolType: "ARABIC", courseId: "other" }), false, "D16: wrong course is invisible");
  eq(CV.isLessonVisibleToViewer(L(), { schoolType: "ARABIC", courseId: null }), false, "D17: no enrollment is invisible");
  eq(
    CV.isLessonVisibleToViewer({ ...L(), unit: null, topic: null, unitId: null, topicId: null }, { schoolType: "ARABIC", courseId: "c1" }),
    false,
    "D18: a lesson attached to no course is invisible"
  );
  eq(
    CV.isLessonVisibleToViewer(
      { ...L(), ...legacyChain("c1"), status: "PUBLISHED", curriculumStatus: "OFFICIAL", trackScope: "SHARED" },
      { schoolType: "ARABIC", courseId: "c1" }
    ),
    true,
    "D19: legacy topic-chain lessons resolve through the fallback"
  );
  eq(
    CV.isLessonVisibleToViewer(
      { ...L(), ...legacyChain("other"), status: "PUBLISHED", curriculumStatus: "OFFICIAL", trackScope: "SHARED" },
      { schoolType: "ARABIC", courseId: "c1" }
    ),
    false,
    "D20: legacy fallback still enforces the course"
  );
  eq(CV.isLessonVisibleToViewer(null, { schoolType: "ARABIC", courseId: "c1" }), false, "D21: null row is invisible");
  eq(CV.isLessonVisibleToViewer(undefined, { schoolType: "ARABIC", courseId: "c1" }), false, "D22: undefined row is invisible");

  // The where-fragment composes the three owned filters — and nothing else.
  const where = CV.studentLessonVisibilityWhere("ARABIC");
  eq(where.status, "PUBLISHED", "D23: where-fragment pins the lifecycle");
  eq(where.curriculumStatus, { not: "ARCHIVED" }, "D24: where-fragment excludes archived history");
  eq(where.trackScope, { in: ["SHARED", "ARABIC"] }, "D25: where-fragment slices the track");
  eq(
    CV.studentLessonVisibilityWhere("WAT").trackScope,
    { in: ["SHARED"] },
    "D26: where-fragment fails closed to SHARED-only"
  );

  // -------------------------------------------------------------------------
  // E. Single-id gate through a fake DB
  // -------------------------------------------------------------------------
  section("E. canStudentSeeLesson — visibility + enrollment + course, one id");

  const studentRow = (over = {}) => ({
    schoolType: "ARABIC",
    group: { courseId: "c1", isActive: true },
    ...over,
  });
  const LESSONS = {
    pub: L({ id: "pub" }),
    draft: L({ id: "draft", status: "DRAFT" }),
    ready: L({ id: "ready", status: "READY" }),
    archived: L({ id: "archived", curriculumStatus: "ARCHIVED" }),
    lang: L({ id: "lang", trackScope: "LANGUAGE" }),
    otherCourse: { ...L({ id: "otherCourse" }), ...chain("c2") },
    orphan: { ...L({ id: "orphan" }), unit: null, topic: null, unitId: null, topicId: null },
  };
  const STUDENTS = {
    s1: studentRow(),
    inactive: studentRow({ group: { courseId: "c1", isActive: false } }),
    nogroup: studentRow({ group: null }),
    otherCourse: studentRow({ group: { courseId: "c2", isActive: true } }),
    lang: studentRow({ schoolType: "LANGUAGE" }),
  };
  globalThis.__CM_FAKE_DB__ = {
    lesson: { findUnique: async ({ where: w }) => LESSONS[w.id] || null },
    student: { findUnique: async ({ where: w }) => STUDENTS[w.id] || null },
  };

  eq(await CV.canStudentSeeLesson("s1", "pub"), true, "E1: PUBLISHED + own track + own course → visible");
  eq(await CV.canStudentSeeLesson("s1", "draft"), false, "E2: DRAFT → invisible");
  eq(await CV.canStudentSeeLesson("s1", "ready"), false, "E3: READY → invisible");
  eq(await CV.canStudentSeeLesson("s1", "archived"), false, "E4: ARCHIVED → invisible");
  eq(await CV.canStudentSeeLesson("s1", "lang"), false, "E5: wrong track → invisible");
  eq(await CV.canStudentSeeLesson("lang", "lang"), true, "E6: same track → visible");
  eq(await CV.canStudentSeeLesson("s1", "otherCourse"), false, "E7: wrong course → invisible");
  eq(await CV.canStudentSeeLesson("otherCourse", "otherCourse"), true, "E8: enrolled in that course → visible");
  eq(await CV.canStudentSeeLesson("s1", "orphan"), false, "E9: courseless lesson → invisible");
  eq(await CV.canStudentSeeLesson("inactive", "pub"), false, "E10: inactive group → invisible");
  eq(await CV.canStudentSeeLesson("nogroup", "pub"), false, "E11: no group → invisible");
  eq(await CV.canStudentSeeLesson("s1", "nope"), false, "E12: unknown lesson → invisible");
  eq(await CV.canStudentSeeLesson("nope", "pub"), false, "E13: unknown student → invisible");
  eq(await CV.canStudentSeeLesson("", "pub"), false, "E14: empty student id → invisible");
  eq(await CV.canStudentSeeLesson("s1", ""), false, "E15: empty lesson id → invisible");

  // -------------------------------------------------------------------------
  // F. Course tree — skeleton added, redaction kept
  // -------------------------------------------------------------------------
  section("F. Course tree — locked skeleton without protected content");

  const courseRoute = read("src/app/api/courses/[slug]/route.ts");
  pinned(courseRoute, /officialCode: lesson\.officialCode \?\? null,/, "F1: session identity is serialised");
  pinned(courseRoute, /hasVideo: !!lesson\.videoUrl,/, "F2: video presence is lock-independent");
  absent(courseRoute, /hasVideo: locked/, "F2-neg: video presence is never lock-gated", "      hasVideo: locked ? false : true,");
  pinned(courseRoute, /hasPdf: downloadableCount > 0,/, "F3: file presence is lock-independent");
  absent(courseRoute, /hasPdf:\s*!locked/, "F3-neg: file presence is never lock-gated", "      hasPdf: !locked && true,");
  pinned(courseRoute, /materialCount: downloadableCount,/, "F4: material count is serialised (a count, not identities)");
  pinned(courseRoute, /includeProtected: true,/, "F5: presence is computed over the unredacted descriptor list");
  pinned(courseRoute, /materials: locked \? \[\] : materials,/, "F6: locked sessions still get an empty descriptor list");
  // Phase 4 redaction re-asserted: every protected field stays locked→null.
  for (const field of ["videoUrl", "pdfUrl", "summary", "description", "quiz", "homework", "requirements"]) {
    pinned(courseRoute, new RegExp(`${field}: locked \\? null`), `F7: redaction kept for ${field}`);
  }
  // The Phase 4 split-count contract still holds inside the mapper.
  {
    const dtoStart = courseRoute.indexOf("const toLesson = (lesson: LessonRow) => {");
    ok(dtoStart > 0, "F8: the lesson payload is still built by a single named mapper");
    const dto = courseRoute.slice(dtoStart, courseRoute.indexOf("\n  };", dtoStart));
    for (const key of ["videoUrl:", "pdfUrl:", "summary:", "description:", "progress:", "isCompleted:", "requirements:", "quiz:", "homework:"]) {
      eq(dto.split(key).length, 2, `F9: ${key} defined exactly once`);
    }
    for (const key of ["officialCode:", "hasVideo:", "hasPdf:", "materialCount:"]) {
      eq(dto.split(key).length, 2, `F10: new skeleton key ${key} defined exactly once`);
    }
  }
  pinned(
    courseRoute,
    /lessons: \{\s*where: \{\s*\.\.\.viewerLifecycleFilter,\s*\.\.\.EXCLUDE_ARCHIVED_LESSON,\s*\.\.\.viewerTrackFilter,/,
    "F11: the tree still fetches lifecycle + archive + track in one clause"
  );

  // -------------------------------------------------------------------------
  // G. Lesson route — identity added, gates kept
  // -------------------------------------------------------------------------
  section("G. Lesson route — session identity, same authorization");

  const lessonRoute = read("src/app/api/lessons/[id]/route.ts");
  pinned(lessonRoute, /officialCode: lesson\.officialCode \?\? null,/, "G1: session identity is serialised");
  pinned(lessonRoute, /canAccessLesson\(s\.id, id\)/, "G2: the student gate is still canAccessLesson");
  pinned(lessonRoute, /denyProgression\(access\.reason/, "G3: denial still funnels through denyProgression");
  pinned(lessonRoute, /isParentLessonPreviewAllowed\(\s*user\.id,/, "G4: parents still preview through the shared predicate");
  pinned(lessonRoute, /\.\.\.LESSON_STUDENT_STATUS_FILTER,/, "G5: prev/next still walks the PUBLISHED chain only");
  pinned(lessonRoute, /\.\.\.EXCLUDE_ARCHIVED_LESSON,/, "G6: prev/next still excludes archived history");
  pinned(lessonRoute, /\.\.\.viewerTrackFilter,/, "G7: prev/next still stays on the viewer's track");

  // -------------------------------------------------------------------------
  // H. Cached state — bookmarks, notes, videos
  // -------------------------------------------------------------------------
  section("H. Cached state can no longer surface unpublished sessions");

  const bookmarksRoute = read("src/app/api/students/me/bookmarks/route.ts");
  pinned(bookmarksRoute, /studentLessonVisibilityWhere\(/, "H1: bookmark list filters by the visibility predicate");
  pinned(bookmarksRoute, /OR: lessonCourseChainOr\(courseId\)/, "H2: bookmark list stays in the enrolled course");
  pinned(bookmarksRoute, /canStudentSeeLesson\(student\.id, lessonId\)/, "H3: bookmark creation gates on visibility");
  pinned(bookmarksRoute, /if \(!visible\) return err\("Lesson not found", 404\);/, "H4: invisible bookmark target answers as nonexistent");

  const notesRoute = read("src/app/api/students/me/notes/route.ts");
  pinned(notesRoute, /isLessonVisibleToViewer\(n\.lesson, viewer\)/, "H5: note titles redact when the lesson is invisible");
  pinned(notesRoute, /\? \{ id: n\.lesson\.id, title: n\.lesson\.title/, "H6: visible titles keep their shape");
  pinned(notesRoute, /canStudentSeeLesson\(student\.id, lessonId\)/, "H7: note creation gates on visibility");
  pinned(
    notesRoute,
    /findFirst\(\{\s*where: \{ id: noteId, studentId: student\.id \},/,
    "H8: note updates are scoped to (noteId, studentId) — the IDOR is closed"
  );

  const videosRoute = read("src/app/api/students/me/session-videos/route.ts");
  pinned(videosRoute, /\.\.\.\(lessonId \? \{ lessonId \} : \{\}\)/, "H9: ?lessonId= narrows the authorized set");
  pinned(videosRoute, /isPublished: true,/, "H10: the narrowing keeps the publication gate");
  pinned(videosRoute, /\.\.\.videoTrackFilter\(enrollment\.schoolType\)/, "H11: the narrowing keeps the track gate");
  pinned(videosRoute, /\{ lesson: LESSON_STUDENT_STATUS_FILTER \}/, "H12: linked sessions still must be PUBLISHED");

  // No student-facing lesson search exists that could name unpublished rows.
  ok(!fs.existsSync(path.join(REPO, "src/app/api/search")), "H13: no /api/search route exists");
  {
    const studentApis = ["src/app/api/students/me/dashboard/route.ts", "src/app/api/students/me/homework/route.ts"];
    for (const f of studentApis) {
      absent(read(f), /\bcontains\b/, `H14: ${f} performs no title search`, 'where: { title: { contains: "x" } }');
    }
  }

  // -------------------------------------------------------------------------
  // I. Deep-link wiring — navigation only, authorization stays server-side
  // -------------------------------------------------------------------------
  section("I. Deep links land on views whose fetches re-authorize");

  const dash = read("src/components/student/student-dashboard.tsx");
  pinned(dash, /parseDeepLink\(n\.link\)/, "I1: notifications render Open only for well-formed links");
  pinned(dash, /navigateDeepLink\(n\.link, useApp\.getState\(\)\)/, "I2: Open navigates through the shared resolver");
  pinned(dash, /student\.247/, "I3: the Open button is localized");
  pinned(dash, /id=\{`homework-\$\{h\.id\}`\}/, "I4: homework rows are addressable for deep-link landing");
  pinned(dash, /getElementById\(`homework-\$\{navParam\}`\)/, "I5: homework:<id> scrolls to its item");

  const videosView = read("src/components/course/session-videos-view.tsx");
  pinned(videosView, /const navParam = useApp\(\(s\) => s\.navParam\);/, "I6: the recordings view reads navParam");
  pinned(videosView, /navParam && list\.some\(\(v\) => v\.id === navParam\)/, "I7: video:<id> activates its recording when authorized");

  const quizRunner = read("src/components/course/quiz-runner.tsx");
  pinned(quizRunner, /fetch\(`\/api\/quizzes\/\$\{encodeURIComponent\(navParam\)\}/, "I8: quiz:<id> re-fetches through the authorized quiz API");

  const lessonView = read("src/components/course/student-lesson.tsx");
  pinned(lessonView, /fetch\(`\/api\/lessons\/\$\{encodeURIComponent\(navParam\)\}/, "I9: lesson:<id> re-fetches through the authorized lesson API");

  const quizRoute = read("src/app/api/quizzes/[id]/route.ts");
  pinned(quizRoute, /canAccessQuiz\(/, "I10: the quiz landing fetch is progression-gated server-side");
  const materialsRoute = read("src/app/api/materials/[id]/route.ts");
  pinned(materialsRoute, /authorizeMaterialDownload\(/, "I11: the PDF landing fetch runs the 10-check contract");

  // -------------------------------------------------------------------------
  // J. Unified session page
  // -------------------------------------------------------------------------
  section("J. Unified session page — one session, every component");

  pinned(lessonView, /data\.requirements\.video/, "J1: video requirement renders from the server row");
  pinned(lessonView, /course\.205/, "J2: requirements checklist is headed + localized");
  pinned(lessonView, /course\.206/, "J3: video rule label (95%) is present");
  pinned(lessonView, /course\.207/, "J4: quiz rule label is present");
  pinned(lessonView, /course\.208/, "J5: assignment rule label is present");
  pinned(lessonView, /session-videos\?lessonId=\$\{encodeURIComponent\(lessonId\)\}/, "J6: recordings load through the narrowed authorized list");
  pinned(lessonView, /course\.214/, "J7: recordings block is headed + localized");
  pinned(lessonView, /setNavParam\(v\.id\)/, "J8: a recording opens in the recordings view (no content silo)");
  pinned(lessonView, /data\.lesson\.officialCode/, "J9: session identity shows in the header");
  pinned(lessonView, /PREVIOUS_SESSION_INCOMPLETE/, "J10: locked denials render the locked skeleton");
  pinned(lessonView, /course\.203/, "J11: locked skeleton is titled + localized");
  pinned(lessonView, /course\.217/, "J12: missing sessions render the not-available skeleton");
  pinned(lessonView, /course\.225/, "J13: skeletons offer a safe way home");
  {
    // The locked/missing skeletons render from the denial alone: the branch
    // that decides them never dereferences session content.
    const errBranch = lessonView.indexOf('if (error || !data) {');
    ok(errBranch > 0, "J14: the error branch guards before any content renders");
    const lockedStart = lessonView.indexOf('errorKind === "locked"', errBranch);
    const lockedEnd = lessonView.indexOf("\n    }\n    return (", lockedStart);
    ok(lockedStart > 0 && lockedEnd > lockedStart, "J15: locked panel slice extracted");
    absent(
      lessonView.slice(lockedStart, lockedEnd),
      /data\./,
      "J16: the locked panel dereferences no session content",
      "{data.lesson.title}"
    );
  }

  const courseView = read("src/components/course/student-course.tsx");
  pinned(courseView, /lesson\.officialCode/, "J17: the tree shows session identity chips");
  pinned(courseView, /lesson\.hasVideo/, "J18: the tree shows video presence badges");
  pinned(courseView, /lesson\.materialCount/, "J19: the tree shows material presence badges");
  pinned(courseView, /course\.220/, "J20: presence badges are localized");

  // -------------------------------------------------------------------------
  // K. No second unlock algorithm
  // -------------------------------------------------------------------------
  section("K. Progression is still owned by exactly one module");

  const cvSrc = read("src/lib/curriculum-visibility.ts");
  absent(cvSrc, /videoPercent|videoCompleted/, "K1: visibility never reads video state", "if (lp.videoPercent > 1) {}");
  absent(cvSrc, /QuizAttempt|quizAttempt/, "K2: visibility never reads quiz attempts", "db.quizAttempt.findMany({})");
  absent(cvSrc, /HomeworkSubmission|homeworkSubmission/, "K3: visibility never reads submissions", "db.homeworkSubmission.findMany({})");
  absent(cvSrc, /\b(getCourseSessionProgress|canAccessLesson)\s*\(/, "K4: visibility never calls the progression engine", "getCourseSessionProgress()");
  pinned(cvSrc, /resolveLessonCourseId/, "K4b: visibility reuses the engine's course resolution (no second chain rule)");
  absent(cvSrc, /VIDEO_COMPLETION_THRESHOLD/, "K5: visibility never restates the 95% rule", "VIDEO_COMPLETION_THRESHOLD");

  const dlSrc = read("src/lib/deep-link.ts");
  absent(dlSrc, /(?:^|\n)import |require\(/, "K6: deep links are pure string handling (no imports)", 'import { x } from "y";');
  absent(dlSrc, /fetch\(/, "K7: deep links perform no fetch", "fetch(url)");
  absent(dlSrc, /canAccess|unlocked/, "K8: deep links derive no unlock state", "if (unlocked) {}");

  absent(lessonView, /videoPercent\s*>=/, "K9: the lesson page never derives the video rule", "if (videoPercent >= 95) {}");
  absent(courseView, /\b(getCourseSessionProgress|canAccessLesson)\s*\(/, "K10: the tree never derives unlock", "canAccessLesson()");
  pinned(courseView, /lesson\.status === "locked"/, "K11: the tree reads lock state from the server row only");

  // -------------------------------------------------------------------------
  // L. Parent preview stays scoped
  // -------------------------------------------------------------------------
  section("L. Parent preview — applicable track, lifecycle enforced");

  const parentAccess = read("src/lib/parent-access.ts");
  pinned(parentAccess, /isStudentVisibleStatus|status.*PUBLISHED/, "L1: parent preview enforces the lifecycle");
  pinned(parentAccess, /ARCHIVED/, "L2: parent preview excludes archived history");
  pinned(parentAccess, /trackScope/, "L3: parent preview enforces the track");
  pinned(courseRoute, /getParentTrackScopes\(user\.id\)/, "L4: the parent tree slices to the children's tracks");
  pinned(lessonRoute, /Lesson not found", 404/, "L5: out-of-scope parent lessons answer as nonexistent");

  // -------------------------------------------------------------------------
  // M. i18n contract — every new key exists, AR + EN, non-empty
  // -------------------------------------------------------------------------
  section("M. i18n — new keys are complete in both locales");

  const dict2026 = read("src/lib/i18n-dict-2026.ts");
  const entry = (key) => {
    const m = new RegExp(`"${key}":\\s*\\{[^}]*?ar:\\s*"([^"]*)"[^}]*?en:\\s*"([^"]*)"`, "s").exec(dict2026);
    return m ? { ar: m[1], en: m[2] } : null;
  };
  const NEW_KEYS = [
    "course.214", "course.215", "course.216", "course.217", "course.218",
    "course.220", "course.221", "course.222", "course.223", "course.224", "course.225",
    "student.247", "student.248",
  ];
  for (const key of NEW_KEYS) {
    const e = entry(key);
    ok(!!e, `M1: ${key} exists in DICT_2026`);
    ok(!!e && e.ar.length > 0 && e.en.length > 0, `M2: ${key} has non-empty AR + EN`);
  }
  // Every Phase 16 key referenced by the edited components resolves.
  {
    const used = new Set();
    for (const src of [courseView, lessonView, videosView, dash]) {
      for (const m of src.matchAll(/(?:tr?|t)\("((?:course|student)\.\d+)"\)/g)) used.add(m[1]);
    }
    const mainDict = read("src/lib/i18n-dict.ts");
    for (const key of [...used].filter((k) => /^(course\.2|student\.24)/.test(k))) {
      const in2026 = new RegExp(`"${key}"`).test(dict2026);
      const inMain = new RegExp(`"${key}"`).test(mainDict);
      ok(in2026 !== inMain, `M3: ${key} is defined in exactly one catalogue`);
    }
    ok(used.size > 0, `M4: scanned ${used.size} referenced keys`);
  }

  // -------------------------------------------------------------------------
  // N. RTL + mobile — logical properties, responsive stacks
  // -------------------------------------------------------------------------
  section("N. RTL + mobile — no physical layout in the new blocks");

  const sliceOf = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
  {
    // LessonRow: the whole row must avoid physical left/right/margin utilities.
    const row = sliceOf(courseView, "function LessonRow", "function LegendDot");
    ok(row.length > 100, "N1: LessonRow slice extracted");
    absent(row, /\bml-|\bmr-|\bpl-|\bpr-|\bleft-|\bright-|\btext-left|\btext-right/, "N2: LessonRow uses logical properties only", '<div className="ml-2" />');
    ok(/flex-wrap/.test(row), "N3: badge row wraps on narrow screens");
  }
  {
    const req = sliceOf(lessonView, "function RequirementRow", "function LessonSkeleton");
    ok(req.length > 100, "N4: requirement/recordings slice extracted");
    absent(req, /\bml-|\bmr-|\bpl-|\bpr-|\bleft-|\bright-|\btext-left|\btext-right/, "N5: new session blocks use logical properties only", '<div className="mr-2" />');
    ok(/flex-col[\s\S]*sm:flex-row/.test(req), "N6: recording rows stack on mobile, sit side-by-side on desktop");
  }
  {
    const panel = sliceOf(lessonView, 'if (error || !data) {', "function LessonSkeleton");
    ok(/flex-col sm:flex-row/.test(panel), "N7: skeleton actions stack on mobile");
    ok(/flip-rtl/.test(panel), "N8: skeleton icons mirror in RTL");
  }
  {
    const notif = sliceOf(dash, "function NotificationsView", "function ProgressView");
    absent(notif, /\bml-|\bmr-|\btext-left|\btext-right/, "N9: notification rows use logical properties only", '<div className="ml-2" />');
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\nstudent locked curriculum (phase 16): ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(`\n${fail} failure(s):`);
    for (const f of failures) console.error(` - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
});
