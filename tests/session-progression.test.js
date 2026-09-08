// CodeMind Academy — Phase 4 student session progression regression tests.
//
// Two layers, both offline (no database, no network, no running server):
//
//   A. BEHAVIOURAL — `src/lib/session-progress.ts` is compiled with tsc and
//      exercised against a fake `@/lib/db`. This runs the REAL progression
//      arithmetic and the REAL access-control helpers, so a change that lets a
//      student skip a requirement (or that leaks a locked session) fails here.
//
//   B. SOURCE-LEVEL INVARIANTS — the route sources are read and asserted, in
//      the same style as tests/authorization-invariants.test.js. This is what
//      pins the gates into the actual HTTP surface, which the behavioural
//      layer cannot see.
//
// The fixture covers BOTH curriculum chains the platform actually uses:
//   * canonical  Course → Part → Unit → Lesson   (`Lesson.unitId`, Topic = null)
//   * legacy     Course → Part → Unit → Topic → Lesson (`Lesson.topicId`)
// plus a mixed unit that carries both, and an orphan lesson attached to
// neither.
//
// Run: node tests/session-progression.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
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
// Compile the progression service to CommonJS in a temp dir.
// `@/lib/db` is redirected to an in-memory fake via a resolver hook, because
// tsc does not rewrite path aliases in the emitted require() calls.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p4-test-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      strict: false,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [path.join(REPO, "node_modules/@types")],
      baseUrl: REPO,
      paths: { "@/*": ["src/*"] },
      outDir: OUT,
    },
    files: [
      path.join(REPO, "src/lib/session-progress.ts"),
      path.join(REPO, "src/lib/progress.ts"),
    ],
  })
);
// tsc must RESOLVE `@/lib/db` for typing, but the emitted require() keeps the
// alias — it is redirected to the fake at load time below. Type errors in
// unrelated parts of the graph are tolerated here (`bun run typecheck` is the
// real gate); what matters is that the JS we are about to exercise was emitted.
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch {
  /* fall through: check the emitted files instead */
}
for (const f of ["session-progress.js", "progress.js"]) {
  if (!fs.existsSync(path.join(OUT, f))) {
    throw new Error(`tsc did not emit ${f}`);
  }
}

// ---------------------------------------------------------------------------
// The fake database.
//
// THREE courses, deliberately stored in a scrambled order so that the ordering
// under test is provably done by `orderCourseLessons()` and not by the store:
//
//   course-canonical  P1 → U1 → L1,L2,L3            (unitId set, topicId null)
//   course-legacy     P1 → U1 → T1 → LG1,LG2,LG3    (topicId set, unitId null)
//   course-mixed      P1 → U1 → MX-C (canonical, order 5)
//                             → MX-B (BOTH links, order 6)
//                             → topic T1 (order 1) → MX-T (order 1)
//   ORPHAN            no unitId and no topicId — must be in no universe
// ---------------------------------------------------------------------------
const COURSE = "course-canonical";
const LESSONS = ["L1", "L2", "L3"];
const LEGACY_COURSE = "course-legacy";
const LEGACY_LESSONS = ["LG1", "LG2", "LG3"];
const MIXED_COURSE = "course-mixed";

const QUIZZES = {
  L1: "Q1", L2: "Q2", L3: "Q3",
  LG1: "LQ1", LG2: "LQ2", LG3: "LQ3",
  "MX-C": "MQ1",
};
const HOMEWORKS = {
  L1: "H1", L2: "H2", L3: "H3",
  LG1: "LH1", LG2: "LH2", LG3: "LH3",
  "MX-C": "MH1",
};

const state = {
  studentGroup: { courseId: COURSE, isActive: true },
  /** lessonId -> { videoPercent, videoCompleted, isCompleted } */
  lessonProgress: {},
  /** finished quiz ids */
  attemptedQuizzes: new Set(),
  /** submitted homeworks ids */
  submittedHomeworks: new Set(),
};

function reset() {
  state.studentGroup = { courseId: COURSE, isActive: true };
  state.lessonProgress = {};
  state.attemptedQuizzes = new Set();
  state.submittedHomeworks = new Set();
}

const components = (id) => ({
  quizzes: QUIZZES[id] ? [{ id: QUIZZES[id] }] : [],
  homeworks: HOMEWORKS[id] ? [{ id: HOMEWORKS[id] }] : [],
});

/** Canonical chain: the lesson hangs straight off the Unit. */
function canonLesson(id, order, courseId, partOrder = 1, unitOrder = 1, unitId = `U:${courseId}:${unitOrder}`) {
  return {
    id,
    order,
    isPublished: true,
    videoUrl: QUIZZES[id] ? `https://cdn.example.invalid/${id}.mp4` : null,
    pdfUrl: `https://cdn.example.invalid/${id}.pdf`,
    unitId,
    topicId: null,
    unit: {
      id: unitId,
      order: unitOrder,
      part: { id: `P:${courseId}`, order: partOrder, courseId },
    },
    topic: null,
    ...components(id),
  };
}

/** Legacy chain: the lesson hangs off a Topic inside the Unit. */
function legacyLesson(id, order, courseId, topicOrder, topicId, unitOrder = 1, partOrder = 1) {
  return {
    id,
    order,
    isPublished: true,
    videoUrl: `https://cdn.example.invalid/${id}.mp4`,
    pdfUrl: `https://cdn.example.invalid/${id}.pdf`,
    unitId: null,
    topicId,
    unit: null,
    topic: {
      order: topicOrder,
      unit: {
        id: `U:${courseId}:${unitOrder}`,
        order: unitOrder,
        part: { id: `P:${courseId}`, order: partOrder, courseId },
      },
    },
    ...components(id),
  };
}

function defaultCatalogue() {
  const bothLinks = canonLesson("MX-B", 6, MIXED_COURSE, 1, 1, "U:mixed:1");
  // …and the SAME lesson is also attached to a legacy Topic in that unit.
  bothLinks.topicId = "T:mixed:1";
  bothLinks.topic = {
    order: 1,
    unit: { id: "U:mixed:1", order: 1, part: { id: `P:${MIXED_COURSE}`, order: 1, courseId: MIXED_COURSE } },
  };
  // A video but no quiz/assignment: still a real requirement, so the mixed
  // sequence stays strictly sequential instead of auto-completing.
  bothLinks.videoUrl = "https://cdn.example.invalid/MX-B.mp4";

  return [
    // scrambled on purpose
    legacyLesson("LG3", 3, LEGACY_COURSE, 1, "T:legacy:1"),
    canonLesson("MX-C", 5, MIXED_COURSE, 1, 1, "U:mixed:1"),
    canonLesson("L2", 2, COURSE),
    { id: "ORPHAN", order: 1, isPublished: true, videoUrl: "x", pdfUrl: null, unitId: null, topicId: null, unit: null, topic: null, quizzes: [], homeworks: [] },
    legacyLesson("MX-T", 1, MIXED_COURSE, 1, "T:mixed:1"),
    canonLesson("L3", 3, COURSE),
    bothLinks,
    legacyLesson("LG1", 1, LEGACY_COURSE, 1, "T:legacy:1"),
    canonLesson("L1", 1, COURSE),
    legacyLesson("LG2", 2, LEGACY_COURSE, 1, "T:legacy:1"),
  ];
}

let CATALOGUE = defaultCatalogue();

const byId = (id) => CATALOGUE.find((l) => l.id === id) || null;

/** Minimal, honest implementation of the two `where` shapes the service uses. */
function matchesWhere(lesson, where) {
  if (!where) return true;
  if (where.isPublished !== undefined && lesson.isPublished !== where.isPublished) return false;
  // Phase 11: honor the archived-history exclusion. Fixtures without the
  // field behave like live LEGACY rows (the non-nullable column default):
  // included, because they are not ARCHIVED.
  if (where.curriculumStatus?.not !== undefined && lesson.curriculumStatus === where.curriculumStatus.not) return false;
  const viaUnit = (courseId) => !!lesson.unit && lesson.unit.part.courseId === courseId;
  const viaTopic = (courseId) => !!lesson.topic && lesson.topic.unit.part.courseId === courseId;
  if (Array.isArray(where.OR)) {
    return where.OR.some((branch) => {
      if (branch.unit?.part?.courseId) return viaUnit(branch.unit.part.courseId);
      if (branch.topic?.unit?.part?.courseId) return viaTopic(branch.topic.unit.part.courseId);
      return false;
    });
  }
  if (where.unit?.part?.courseId) return viaUnit(where.unit.part.courseId);
  if (where.topic?.unit?.part?.courseId) return viaTopic(where.topic.unit.part.courseId);
  return false;
}

const fakeDb = {
  lesson: {
    findMany: ({ where }) => CATALOGUE.filter((l) => matchesWhere(l, where)),
    findUnique: ({ where }) => byId(where.id),
  },
  lessonProgress: {
    findMany: ({ where }) =>
      Object.entries(state.lessonProgress)
        .filter(([lessonId]) => where.lessonId.in.includes(lessonId))
        .map(([lessonId, p]) => ({ lessonId, ...p })),
  },
  quizAttempt: {
    findMany: ({ where }) =>
      [...state.attemptedQuizzes]
        .filter((q) => where.quizId.in.includes(q))
        .map((quizId) => ({ quizId, percentage: 100 })),
  },
  homeworkSubmission: {
    findMany: ({ where }) =>
      [...state.submittedHomeworks]
        .filter((h) => where.homeworkId.in.includes(h))
        .map((homeworkId) => ({ homeworkId })),
  },
  student: {
    findUnique: () => ({ id: "S1", group: state.studentGroup }),
  },
  quiz: {
    findUnique: ({ where }) => {
      const lessonId = Object.keys(QUIZZES).find((l) => QUIZZES[l] === where.id);
      return lessonId ? { id: where.id, lessonId } : null;
    },
  },
  homework: {
    findUnique: ({ where }) => {
      const lessonId = Object.keys(HOMEWORKS).find((l) => HOMEWORKS[l] === where.id);
      return lessonId ? { id: where.id, lessonId } : null;
    },
  },
};

fs.writeFileSync(
  path.join(OUT, "fake-db.js"),
  "module.exports = globalThis.__P4_FAKE_DB__;\n"
);
globalThis.__P4_FAKE_DB__ = { db: fakeDb };

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return path.join(OUT, "fake-db.js");
  // Any other aliased sibling of the module under test resolves to its own
  // compiled output in the temp dir (e.g. `@/lib/progress`).
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(OUT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return realResolve.call(this, request, ...rest);
};

const SP = require(path.join(OUT, "session-progress.js"));

const ids = (prog) => prog.sessions.map((s) => s.lessonId).join(",");

// ===========================================================================
async function main() {
  // -------------------------------------------------------------------------
  // Sections 1-11 run against the CANONICAL (unit-linked, Topic = null)
  // curriculum, which is the authoritative hierarchy.
  // -------------------------------------------------------------------------
  section("1. Canonical curriculum: video AND assignment AND quiz unlock the next session");
  reset();
  let prog = await SP.getCourseSessionProgress("S1", COURSE);
  ok(prog.sessions.length === 3, "three OFFICIAL sessions are in the progression universe");
  ok(ids(prog) === "L1,L2,L3", "canonical order is Part → Unit → Lesson");
  ok(prog.sessions[0].unlocked === true, "session 1 starts unlocked");
  ok(prog.sessions[1].unlocked === false, "session 2 starts locked");
  ok(prog.sessions[2].unlocked === false, "session 3 starts locked");
  ok(prog.sessions[0].completed === false, "session 1 is not complete with nothing done");
  ok(prog.currentLessonId === "L1", "current session is the first incomplete one");

  section("2. Video alone does not unlock");
  state.lessonProgress.L1 = { videoPercent: 100, videoCompleted: true, isCompleted: true };
  prog = await SP.getCourseSessionProgress("S1", COURSE);
  ok(prog.sessions[0].video.done === true, "video requirement satisfied at 100%");
  ok(prog.sessions[0].completed === false, "video alone does NOT complete the session");
  ok(prog.sessions[1].unlocked === false, "session 2 still locked after video only");

  section("3. 94% is not 95%");
  state.lessonProgress.L1 = { videoPercent: 94, videoCompleted: false, isCompleted: false };
  prog = await SP.getCourseSessionProgress("S1", COURSE);
  ok(prog.sessions[0].video.done === false, "94% does not satisfy the video requirement");
  state.lessonProgress.L1 = { videoPercent: 95, videoCompleted: false, isCompleted: false };
  prog = await SP.getCourseSessionProgress("S1", COURSE);
  ok(prog.sessions[0].video.done === true, "95% satisfies the video requirement");

  section("4. Video + assignment still needs the quiz");
  state.lessonProgress.L1 = { videoPercent: 100, videoCompleted: true, isCompleted: true };
  state.submittedHomeworks.add("H1");
  prog = await SP.getCourseSessionProgress("S1", COURSE);
  ok(prog.sessions[0].assignment.done === true, "assignment requirement satisfied");
  ok(prog.sessions[0].quiz.done === false, "quiz requirement still outstanding");
  ok(prog.sessions[0].completed === false, "video + assignment does NOT complete the session");
  ok(prog.sessions[1].unlocked === false, "session 2 still locked without the quiz");

  section("5. Video + assignment + quiz unlocks the next session");
  state.attemptedQuizzes.add("Q1");
  prog = await SP.getCourseSessionProgress("S1", COURSE);
  ok(prog.sessions[0].completed === true, "session 1 complete when all three are satisfied");
  ok(prog.sessions[1].unlocked === true, "SESSION 2 UNLOCKS");
  ok(prog.sessions[2].unlocked === false, "session 3 stays locked (strictly sequential)");
  ok(prog.currentLessonId === "L2", "current session advances to L2");

  section("6. An unfinished attempt does not count as completion");
  reset();
  state.lessonProgress.L1 = { videoPercent: 100, videoCompleted: true, isCompleted: true };
  state.submittedHomeworks.add("H1");
  // The route-level query filters finishedAt != null; mirror that here by simply
  // not adding Q1 to the attempted set.
  prog = await SP.getCourseSessionProgress("S1", COURSE);
  ok(prog.sessions[0].quiz.done === false, "an un-finished attempt does not satisfy the quiz gate");
  ok(prog.sessions[1].unlocked === false, "session 2 stays locked");

  section("7. canAccessLesson (official lesson)");
  reset();
  let a = await SP.canAccessLesson("S1", "L1");
  ok(a.allowed === true && a.reason === null, "the first official lesson is accessible");
  a = await SP.canAccessLesson("S1", "L2");
  ok(a.allowed === false && a.reason === "PREVIOUS_SESSION_INCOMPLETE", "L2 denied while L1 is incomplete");
  ok(a.status !== null, "denial still carries the status row for the owner of the session");
  a = await SP.canAccessLesson("S1", "NOPE");
  ok(a.allowed === false && a.reason === "LESSON_NOT_FOUND", "unknown lesson -> LESSON_NOT_FOUND");

  state.studentGroup = { courseId: "other-course", isActive: true };
  a = await SP.canAccessLesson("S1", "L1");
  ok(a.allowed === false && a.reason === "NOT_ENROLLED", "student of another course -> NOT_ENROLLED");

  state.studentGroup = { courseId: COURSE, isActive: false };
  a = await SP.canAccessLesson("S1", "L1");
  ok(a.allowed === false && a.reason === "NOT_ENROLLED", "deactivated group -> NOT_ENROLLED");

  section("8. canAccessQuiz / canAccessHomework resolve the owning OFFICIAL lesson");
  state.studentGroup = { courseId: COURSE, isActive: true };
  reset();
  ok((await SP.canAccessQuiz("S1", "Q1")).allowed === true, "quiz of an unlocked session is allowed");
  let q = await SP.canAccessQuiz("S1", "Q2");
  ok(q.allowed === false && q.reason === "PREVIOUS_SESSION_INCOMPLETE", "quiz of a LOCKED session is denied");
  ok(!("status" in q), "quiz denial carries NO requirement metadata about the locked session");
  q = await SP.canAccessQuiz("S1", "Q3");
  ok(q.allowed === false, "quiz of a session two steps ahead is denied");
  ok((await SP.canAccessQuiz("S1", "UNKNOWN")).reason === "LESSON_NOT_FOUND", "unknown quiz -> LESSON_NOT_FOUND");

  let h = await SP.canAccessHomework("S1", "H1");
  ok(h.allowed === true, "assignment of an unlocked session is allowed");
  h = await SP.canAccessHomework("S1", "H2");
  ok(h.allowed === false && h.reason === "PREVIOUS_SESSION_INCOMPLETE", "assignment of a LOCKED session is denied");
  ok(!("status" in h), "assignment denial carries NO requirement metadata");

  section("9. Completing L1 opens L2's resources, not L3's");
  state.lessonProgress.L1 = { videoPercent: 100, videoCompleted: true, isCompleted: true };
  state.submittedHomeworks.add("H1");
  state.attemptedQuizzes.add("Q1");
  ok((await SP.canAccessQuiz("S1", "Q2")).allowed === true, "L2 quiz reachable once L1 is complete");
  ok((await SP.canAccessQuiz("S1", "Q3")).allowed === false, "L3 quiz still unreachable");
  ok((await SP.canAccessHomework("S1", "H2")).allowed === true, "L2 assignment reachable once L1 is complete");
  ok((await SP.canAccessHomework("S1", "H3")).allowed === false, "L3 assignment still unreachable");

  section("10. getUnlockedLessonIds (used by the list endpoints)");
  const unlocked = await SP.getUnlockedLessonIds("S1", COURSE);
  ok(unlocked.has("L1") && unlocked.has("L2") && !unlocked.has("L3"), "only L1 and L2 are unlocked");
  ok(!unlocked.has("LG1") && !unlocked.has("MX-C"), "the unlock set is scoped to the requested course");

  section("11. A lesson with no components can never lock a student forever");
  // Swap in a catalogue where L1 has no video, quiz or assignment.
  CATALOGUE = defaultCatalogue().map((l) =>
    l.id === "L1" ? { ...l, videoUrl: null, quizzes: [], homeworks: [] } : l
  );
  reset();
  prog = await SP.getCourseSessionProgress("S1", COURSE);
  ok(prog.sessions[0].completed === true, "an empty session counts as complete");
  ok(prog.sessions[0].video.required === false, "missing video is not a requirement");
  ok(prog.sessions[0].quiz.required === false, "missing quiz is not a requirement");
  ok(prog.sessions[0].assignment.required === false, "missing assignment is not a requirement");
  ok(prog.sessions[1].unlocked === true, "the next session unlocks");
  CATALOGUE = defaultCatalogue();

  section("11b. Archived lessons leave the progression universe (Phase 11)");
  // Swap in a catalogue where the middle session L2 is archived history.
  CATALOGUE = defaultCatalogue().map((l) =>
    l.id === "L2" ? { ...l, curriculumStatus: "ARCHIVED" } : l
  );
  reset();
  prog = await SP.getCourseSessionProgress("S1", COURSE);
  ok(prog.sessions.length === 2, "the archived session is gone from the universe (3 -> 2)");
  ok(prog.sessions.map((s) => s.lessonId).join(",") === "L1,L3", "L1 and L3 remain in prerequisite order");
  ok(prog.sessions[0].unlocked === true, "the first surviving session is still unlocked");
  ok(prog.byLessonId.has("L1") && !prog.byLessonId.has("L2"), "universe membership excludes the archived lesson");
  const unlockedNoL2 = await SP.getUnlockedLessonIds("S1", COURSE);
  ok(!unlockedNoL2.has("L2"), "the archived session is never unlocked");
  CATALOGUE = defaultCatalogue();

  // -------------------------------------------------------------------------
  // Curriculum-universe regressions (the Phase 4 review finding).
  // -------------------------------------------------------------------------
  section("12. Legacy TOPIC-linked curriculum still works unchanged");
  reset();
  state.studentGroup = { courseId: LEGACY_COURSE, isActive: true };
  prog = await SP.getCourseSessionProgress("S1", LEGACY_COURSE);
  ok(prog.sessions.length === 3, "three legacy sessions are in the progression universe");
  ok(ids(prog) === "LG1,LG2,LG3", "legacy order is Part → Unit → Topic → Lesson");
  ok(prog.sessions[0].unlocked === true, "the first legacy session is unlocked");
  ok(prog.sessions[1].unlocked === false && prog.sessions[2].unlocked === false, "later legacy sessions are locked");
  a = await SP.canAccessLesson("S1", "LG1");
  ok(a.allowed === true, "legacy L1 accessible");
  a = await SP.canAccessLesson("S1", "LG2");
  ok(a.allowed === false && a.reason === "PREVIOUS_SESSION_INCOMPLETE", "legacy L2 denied while L1 is incomplete");
  ok((await SP.canAccessQuiz("S1", "LQ3")).allowed === false, "legacy quiz of a locked session is denied");
  ok((await SP.canAccessHomework("S1", "LH3")).allowed === false, "legacy assignment of a locked session is denied");
  // the same completion sequence unlocks the next legacy session
  state.lessonProgress.LG1 = { videoPercent: 100, videoCompleted: true, isCompleted: true };
  state.submittedHomeworks.add("LH1");
  state.attemptedQuizzes.add("LQ1");
  prog = await SP.getCourseSessionProgress("S1", LEGACY_COURSE);
  ok(prog.sessions[0].completed === true, "legacy session 1 completes on all three requirements");
  ok(prog.sessions[1].unlocked === true, "legacy session 2 unlocks");
  ok(prog.sessions[2].unlocked === false, "legacy session 3 stays locked");
  ok((await SP.canAccessQuiz("S1", "LQ2")).allowed === true, "legacy L2 quiz reachable once L1 is complete");

  section("13. A lesson attached to NEITHER chain is in no progression universe");
  reset();
  for (const courseId of [COURSE, LEGACY_COURSE, MIXED_COURSE]) {
    const p = await SP.getCourseSessionProgress("S1", courseId);
    ok(!p.sessions.some((s) => s.lessonId === "ORPHAN"), `ORPHAN is absent from ${courseId}`);
  }
  a = await SP.canAccessLesson("S1", "ORPHAN");
  ok(a.allowed === false && a.reason === "LESSON_NOT_FOUND", "ORPHAN -> LESSON_NOT_FOUND");

  section("14. Mixed unit: canonical chain wins, and sorts before legacy topics");
  reset();
  state.studentGroup = { courseId: MIXED_COURSE, isActive: true };
  prog = await SP.getCourseSessionProgress("S1", MIXED_COURSE);
  // MX-C (order 5) and MX-B (order 6) are unit-linked, so they sort BEFORE the
  // legacy topic's MX-T (order 1) — the canonical hierarchy is authoritative.
  ok(ids(prog) === "MX-C,MX-B,MX-T", `mixed unit ordered canonically, got ${ids(prog)}`);
  ok(prog.sessions.length === 3, "MX-B appears exactly ONCE despite carrying both links");
  ok(prog.sessions[0].unlocked === true, "the canonical lesson at the head of the mixed unit is unlocked");
  ok(prog.sessions[1].unlocked === false && prog.sessions[2].unlocked === false, "the rest of the mixed unit is locked");
  ok((await SP.canAccessLesson("S1", "MX-B")).reason === "PREVIOUS_SESSION_INCOMPLETE", "a both-linked lesson behind the head is gated");
  ok((await SP.canAccessLesson("S1", "MX-T")).reason === "PREVIOUS_SESSION_INCOMPLETE", "the legacy lesson behind the canonical ones is gated too");
  // completing MX-C (the only one with components) opens MX-B
  state.lessonProgress["MX-C"] = { videoPercent: 100, videoCompleted: true, isCompleted: true };
  state.submittedHomeworks.add("MH1");
  state.attemptedQuizzes.add("MQ1");
  prog = await SP.getCourseSessionProgress("S1", MIXED_COURSE);
  ok(prog.sessions[0].completed === true, "the canonical session of a mixed unit completes normally");
  ok(prog.sessions[1].unlocked === true, "the next session of a mixed unit unlocks");
  ok(prog.sessions[2].unlocked === false, "and the one after it stays locked");

  section("15. Ordering is deterministic regardless of storage order");
  reset();
  const forward = ids(await SP.getCourseSessionProgress("S1", COURSE));
  CATALOGUE = [...defaultCatalogue()].reverse();
  const reversed = ids(await SP.getCourseSessionProgress("S1", COURSE));
  CATALOGUE = [...defaultCatalogue()].sort(() => 0.5 - Math.random());
  const shuffled = ids(await SP.getCourseSessionProgress("S1", COURSE));
  CATALOGUE = defaultCatalogue();
  ok(forward === "L1,L2,L3" && reversed === forward && shuffled === forward, "the same sequence every time");
  const legacyForward = ids(await SP.getCourseSessionProgress("S1", LEGACY_COURSE));
  ok(legacyForward === "LG1,LG2,LG3", "legacy ordering is deterministic too");

  section("16. resolveLessonCourseId prefers the canonical chain");
  ok(SP.resolveLessonCourseId(byId("L1")) === COURSE, "unit-linked lesson -> its course");
  ok(SP.resolveLessonCourseId(byId("LG1")) === LEGACY_COURSE, "topic-linked lesson -> its course");
  ok(SP.resolveLessonCourseId(byId("MX-B")) === MIXED_COURSE, "both links -> canonical course");
  ok(SP.resolveLessonCourseId(byId("ORPHAN")) === null, "neither link -> null (closed)");

  section("17. Cross-course isolation on the canonical curriculum");
  reset();
  state.studentGroup = { courseId: LEGACY_COURSE, isActive: true };
  a = await SP.canAccessLesson("S1", "L1");
  ok(a.allowed === false && a.reason === "NOT_ENROLLED", "a legacy-course student cannot open an official lesson");
  ok((await SP.canAccessQuiz("S1", "Q1")).allowed === false, "…nor its quiz");
  ok((await SP.canAccessHomework("S1", "H1")).allowed === false, "…nor its assignment");

  // -------------------------------------------------------------------------
  section("18. Source invariants: every quiz route is gated");
  const quizRoutes = {
    "GET /api/quizzes/[id]": "src/app/api/quizzes/[id]/route.ts",
    "POST /api/quizzes/[id]/start": "src/app/api/quizzes/[id]/start/route.ts",
    "POST /api/quizzes/[id]/submit": "src/app/api/quizzes/[id]/submit/route.ts",
    "POST /api/quizzes/[id]/evidence": "src/app/api/quizzes/[id]/evidence/route.ts",
  };
  for (const [label, rel] of Object.entries(quizRoutes)) {
    const src = read(rel);
    ok(src.includes("canAccessQuiz"), `${label} imports/calls canAccessQuiz`);
    const gateIdx = src.indexOf("canAccessQuiz(");
    const handlerIdx = src.search(/export async function (GET|POST)/);
    ok(gateIdx > handlerIdx, `${label} gate sits inside the handler`);
    ok(/if \(!access\.allowed\) return denyProgression/.test(src), `${label} denies through denyProgression`);
  }

  section("19. Source invariants: the denial response leaks nothing");
  const api = read("src/lib/api.ts");
  ok(/export async function denyProgression/.test(api), "denyProgression exists");
  ok(!/requirements/.test(api), "denyProgression never serialises a requirement/status row");
  const lessonRoute = read("src/app/api/lessons/[id]/route.ts");
  ok(!/requirements: access\.status/.test(lessonRoute), "the lesson 403 no longer echoes access.status");

  section("20. Source invariants: the progression universe covers BOTH chains");
  const sp = read("src/lib/session-progress.ts");
  ok(/\{ unit: \{ part: \{ courseId \} \} \}/.test(sp), "the universe query follows the canonical Unit chain");
  ok(/\{ topic: \{ unit: \{ part: \{ courseId \} \} \} \}/.test(sp), "the universe query still follows the legacy Topic chain");
  ok(/OR: \[/.test(sp), "both chains are combined with OR (one query, one system)");
  ok(/const found = await db\.lesson\.findMany\(\{\s*where: \{\s*isPublished: true,\s*\.\.\.EXCLUDE_ARCHIVED_LESSON,/.test(sp), "the universe query excludes archived lessons (Phase 11)");
  ok(sp.includes("orderCourseLessons(found, courseId)"), "ordering is applied explicitly, not left to SQL");
  ok(!/orderBy: \[\s*\{ topic:/.test(sp), "the old topic-only orderBy is gone");
  ok(/lesson\.unit\?\.part\.courseId \?\?/.test(sp), "canAccessLesson resolves the course canonical-first");
  ok(/select: LESSON_CHAIN_SELECT/.test(sp), "the chain shape is shared, so both paths see the same lesson");

  section("21. Source invariants: the course tree redacts locked sessions");
  const courseRoute = read("src/app/api/courses/[slug]/route.ts");
  for (const field of ["videoUrl", "pdfUrl", "summary", "description", "quiz", "homework"]) {
    ok(
      new RegExp(`${field}: locked \\? null`).test(courseRoute),
      `course tree redacts ${field} for locked sessions`
    );
  }
  ok(/hasQuiz: lesson\.quizzes\.length > 0/.test(courseRoute), "course tree keeps a quiz PRESENCE flag");
  ok(/hasAssignment: lesson\.homeworks\.length > 0/.test(courseRoute), "course tree keeps an assignment PRESENCE flag");
  ok(/requirements: locked \? null/.test(courseRoute), "course tree redacts the requirement breakdown");

  section("22. Source invariants: the course tree represents BOTH chains");
  // Phase 11: both fetches additionally exclude archived lessons (the legacy
  // R1 rows stay in the DB as history but are no longer curriculum). The
  // patterns below assert the FULL fetch shape — chain + order + payload +
  // exclusion — so neither the chain coverage nor the exclusion can regress.
  ok(/EXCLUDE_ARCHIVED_LESSON/.test(courseRoute), "the course tree imports the archived-lesson exclusion");
  ok(/lessons: \{\s*where: \{ \.\.\.EXCLUDE_ARCHIVED_LESSON \},\s*orderBy: \{ order: "asc" \},\s*include: LESSON_INCLUDE,/.test(courseRoute), "the unit's canonical lessons are fetched (archived history excluded)");
  ok(/topics: \{[\s\S]*?lessons: \{\s*where: \{ \.\.\.EXCLUDE_ARCHIVED_LESSON \},\s*orderBy: \{ order: "asc" \},\s*include: LESSON_INCLUDE,/.test(courseRoute), "legacy topics still fetch their lessons (archived history excluded)");
  ok(/lessons: unit\.lessons\.map\(toLesson\)/.test(courseRoute), "canonical lessons are serialised at unit level");
  ok(/\.filter\(\(lesson\) => !lesson\.unitId\)/.test(courseRoute), "a both-linked lesson is not rendered twice");
  ok(/if \(lesson\.unitId\) continue;/.test(courseRoute), "the flat status list matches the engine's canonical-first rule");

  section("23. The lesson payload defines every property exactly once");
  // Parse the route with the TypeScript compiler and count the keys of every
  // object literal, so a re-introduced duplicate key fails the suite.
  const courseFile = "src/app/api/courses/[slug]/route.ts";
  const sf = ts.createSourceFile(courseFile, courseRoute, ts.ScriptTarget.Latest, true);
  let checked = 0;
  let dupes = [];
  (function walk(n) {
    if (ts.isObjectLiteralExpression(n)) {
      const keys = n.properties
        .map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null))
        .filter(Boolean);
      if (keys.length >= 5) {
        checked++;
        const seen = new Set();
        for (const k of keys) {
          if (seen.has(k)) dupes.push(`${courseFile}:${k}`);
          seen.add(k);
        }
      }
    }
    ts.forEachChild(n, walk);
  })(sf);
  ok(checked >= 5, `parsed the route's object literals (found ${checked})`);
  ok(dupes.length === 0, `no duplicate object keys${dupes.length ? `: ${dupes.join(", ")}` : ""}`);
  const dtoStart = courseRoute.indexOf("const toLesson = (lesson: LessonRow) => {");
  ok(dtoStart > 0, "the lesson payload is built by a single named mapper");
  const dto = courseRoute.slice(dtoStart, courseRoute.indexOf("\n  };", dtoStart));
  ok(/videoUrl: locked \? null : lesson\.videoUrl,/.test(dto) && dto.split("videoUrl:").length === 2, "videoUrl is defined exactly once in the lesson payload");
  ok(dto.split("pdfUrl:").length === 2 && dto.split("summary:").length === 2 && dto.split("description:").length === 2, "pdfUrl/summary/description are each defined exactly once");
  ok(dto.split("progress:").length === 2 && dto.split("isCompleted:").length === 2, "progress/isCompleted are each defined exactly once");
  ok(dto.split("requirements:").length === 2 && dto.split("quiz:").length === 2 && dto.split("homework:").length === 2, "requirements/quiz/homework are each defined exactly once");

  section("24. Source invariants: dashboard + homework list are gated");
  const dashRoute = read("src/app/api/students/me/dashboard/route.ts");
  ok(dashRoute.includes("getUnlockedLessonIds"), "dashboard uses the shared unlock set");
  ok(/isOpen\(continueLesson\.id\) \? continueLesson\.videoUrl : null/.test(dashRoute), "continueLesson.videoUrl is gated");
  ok(/if \(!isOpen\(h\.lessonId\)\) return false;/.test(dashRoute), "pending homework skips locked sessions");
  ok(/lastViewedAt && isOpen\(x\.lesson\.id\)/.test(dashRoute), "last-viewed fallback skips locked sessions");

  const hwRoute = read("src/app/api/students/me/homework/route.ts");
  ok(/lessonId: \{ in: \[\.\.\.unlocked\] \}/.test(hwRoute), "homework list filters by unlocked lessons");
  ok(hwRoute.includes("canAccessHomework"), "homework submission is gated by canAccessHomework");
  ok(/studentId: s\.id/.test(hwRoute) && !/studentId: String\(body/.test(hwRoute), "submission studentId comes from the session, never the body");
  ok(/existing\?\.status === "GRADED"/.test(hwRoute), "a graded assignment is immutable");
  ok(/homeworkId_studentId/.test(hwRoute), "submission upserts on the (homeworkId, studentId) unique pair");

  section("25. Source invariants: the progress routes still enforce the 95% rule");
  const progressRoute = read("src/app/api/lessons/[id]/progress/route.ts");
  ok(/videoSatisfied/.test(progressRoute), "the progress route still consults the video threshold");
  ok(/progressValue >= 100/.test(progressRoute) && /if \(!videoSatisfied\)/.test(progressRoute), "progress:100 cannot complete an unwatched lesson");
  const videoRoute = read("src/app/api/lessons/[id]/video-progress/route.ts");
  ok(/MAX_CREDIT_PER_BEAT_SEC/.test(videoRoute), "heartbeat credit is still wall-clock capped");
  ok(/Math\.max\(previousWatched/.test(videoRoute), "watched time is still monotonic");
  ok(videoRoute.includes("canAccessLesson"), "a locked lesson cannot accrue video progress");

  section("26. Edge Runtime carry-over: no Node process API in the edge bundle");
  const instr = read("src/instrumentation.ts");
  // Only CODE lines count — the file documents the old warning, so the phrase
  // `process.exit(1)` legitimately appears inside its comments.
  const instrCode = instr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
  ok(
    !instrCode.some((l) => /(^|[^.\w])process\.exit\s*\(/.test(l)),
    "instrumentation.ts contains no static process.exit() call in code"
  );
  ok(instrCode.length > 3, "the instrumentation module still contains real code");
  ok(instr.includes("assertProductionEnv"), "the production env assertion is still called");
  ok(/NEXT_RUNTIME !== "nodejs"/.test(instr), "the Node-only guard is still there");
  ok(/nodeProcess\?\.exit\?\.\(1\)/.test(instr), "the process still terminates non-zero through globalThis");
  ok(!/SKIP|bypass|return; \/\//.test(instr), "the fail-fast was not weakened into a no-op");
}

main().then(() => {
  console.log(`\nsession progression: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
