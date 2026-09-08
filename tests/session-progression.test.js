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
// Run: node tests/session-progression.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

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
// The fake database. One course, one part/unit/topic chain, three lessons in
// order — each with a video, one quiz and one assignment, i.e. every
// requirement of the product rule is present.
// ---------------------------------------------------------------------------
const COURSE = "course-1";
const LESSONS = ["L1", "L2", "L3"];
const QUIZZES = { L1: "Q1", L2: "Q2", L3: "Q3" };
const HOMEWORKS = { L1: "H1", L2: "H2", L3: "H3" };

const state = {
  studentGroup: { courseId: COURSE, isActive: true },
  /** lessonId -> { videoPercent, videoCompleted, isCompleted } */
  lessonProgress: {},
  /** finished quiz ids */
  attemptedQuizzes: new Set(),
  /** submitted homework ids */
  submittedHomeworks: new Set(),
};

function reset() {
  state.studentGroup = { courseId: COURSE, isActive: true };
  state.lessonProgress = {};
  state.attemptedQuizzes = new Set();
  state.submittedHomeworks = new Set();
}

const lessonRow = (id, order) => ({
  id,
  order,
  isPublished: true,
  videoUrl: `https://cdn.example.invalid/${id}.mp4`,
  pdfUrl: `https://cdn.example.invalid/${id}.pdf`,
  quizzes: [{ id: QUIZZES[id] }],
  homeworks: [{ id: HOMEWORKS[id] }],
  topic: { id: "T1", title: "Topic", titleAr: "T", unit: { id: "U1", part: { courseId: COURSE, order: 1 } } },
});

const fakeDb = {
  lesson: {
    findMany: ({ where }) =>
      LESSONS.map((id, i) => lessonRow(id, i + 1)).filter(
        (l) => where?.topic?.unit?.part?.courseId === COURSE && where?.isPublished !== false
      ),
    findUnique: ({ where }) =>
      LESSONS.includes(where.id) ? lessonRow(where.id, LESSONS.indexOf(where.id) + 1) : null,
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
      const lessonId = LESSONS.find((l) => QUIZZES[l] === where.id);
      return lessonId ? { id: where.id, lessonId } : null;
    },
  },
  homework: {
    findUnique: ({ where }) => {
      const lessonId = LESSONS.find((l) => HOMEWORKS[l] === where.id);
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

// ===========================================================================
async function main() {
  section("1. Unlock rule: video AND assignment AND quiz");
  reset();
  let prog = await SP.getCourseSessionProgress("S1", COURSE);
  ok(prog.sessions.length === 3, "three sessions computed");
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

  section("7. canAccessLesson");
  reset();
  let a = await SP.canAccessLesson("S1", "L1");
  ok(a.allowed === true && a.reason === null, "L1 is accessible");
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

  section("8. canAccessQuiz / canAccessHomework (the Phase 4 bypass fix)");
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

  section("11. A lesson with no components can never lock a student forever");
  // Swap in a lesson chain where L1 has no video, quiz or assignment.
  const bareLesson = { ...lessonRow("L1", 1), videoUrl: null, quizzes: [], homeworks: [] };
  fakeDb.lesson.findMany = () => [bareLesson, lessonRow("L2", 2), lessonRow("L3", 3)];
  fakeDb.lesson.findUnique = ({ where }) =>
    where.id === "L1" ? bareLesson : LESSONS.includes(where.id) ? lessonRow(where.id, 2) : null;
  reset();
  prog = await SP.getCourseSessionProgress("S1", COURSE);
  ok(prog.sessions[0].completed === true, "an empty session counts as complete");
  ok(prog.sessions[0].video.required === false, "missing video is not a requirement");
  ok(prog.sessions[0].quiz.required === false, "missing quiz is not a requirement");
  ok(prog.sessions[0].assignment.required === false, "missing assignment is not a requirement");
  ok(prog.sessions[1].unlocked === true, "the next session unlocks");

  // ---------------------------------------------------------------------------
  section("12. Source invariants: every quiz route is gated");
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

  section("13. Source invariants: the denial response leaks nothing");
  const api = read("src/lib/api.ts");
  ok(/export async function denyProgression/.test(api), "denyProgression exists");
  ok(!/requirements/.test(api), "denyProgression never serialises a requirement/status row");
  const lessonRoute = read("src/app/api/lessons/[id]/route.ts");
  ok(!/requirements: access\.status/.test(lessonRoute), "the lesson 403 no longer echoes access.status");

  section("14. Source invariants: the course tree redacts locked sessions");
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

  section("15. Source invariants: dashboard + homework list are gated");
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

  section("16. Source invariants: the progress routes still enforce the 95% rule");
  const progressRoute = read("src/app/api/lessons/[id]/progress/route.ts");
  ok(/videoSatisfied/.test(progressRoute), "the progress route still consults the video threshold");
  ok(/progressValue >= 100/.test(progressRoute) && /if \(!videoSatisfied\)/.test(progressRoute), "progress:100 cannot complete an unwatched lesson");
  const videoRoute = read("src/app/api/lessons/[id]/video-progress/route.ts");
  ok(/MAX_CREDIT_PER_BEAT_SEC/.test(videoRoute), "heartbeat credit is still wall-clock capped");
  ok(/Math\.max\(previousWatched/.test(videoRoute), "watched time is still monotonic");
  ok(videoRoute.includes("canAccessLesson"), "a locked lesson cannot accrue video progress");

  section("17. Edge Runtime carry-over: no Node process API in the edge bundle");
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
