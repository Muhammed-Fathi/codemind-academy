// CodeMind Academy — Phase 6 Quiz Results & Teacher Analytics regression tests.
//
// Two layers, both offline (no database file, no network, no server):
//
//   A. BEHAVIOURAL — `src/lib/quiz-analytics.ts` is compiled with tsc and
//      exercised directly. That module is pure (no DB, no side effects), so
//      this runs the REAL aggregation arithmetic for finished-attempt
//      summarising, difficulty breakdown and weak-question ranking. A change
//      that lets an unfinished attempt into an average, mis-weights retakes,
//      or reads a non-authoritative score fails here.
//
//   B. ROUTE SOURCE INVARIANTS — the teacher analytics/quizzes route sources
//      are read and asserted in the same style as the other suites. This pins
//      the two Phase 6 gates into the actual HTTP surface the behavioural
//      layer cannot see:
//        * teacher analytics only aggregate FINISHED attempts;
//        * teacher analytics are scoped to the teacher's own authorised
//          courses (never every result the student ever produced).
//
// Run: node tests/quiz-analytics.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
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
const eq = (a, b, label) => {
  const equal = JSON.stringify(a) === JSON.stringify(b);
  ok(equal, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// Compile the analytics module to CommonJS in a temp dir. It is pure, so no
// db redirect is needed — unlike the session-quiz harness there is no `@/`
// import to rewrite. tsc must still RESOLVE nothing external (the file has no
// imports), so the emitted JS is exactly the code under test.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p6-test-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      strict: true,
      skipLibCheck: true,
      types: ["node"],
      outDir: OUT,
    },
    files: [path.join(REPO, "src/lib/quiz-analytics.ts")],
  })
);
try {
  execSync(
    `${process.execPath} ${path.join(REPO, "node_modules/typescript/lib/tsc.js")} -p ${path.join(OUT, "tsconfig.json")}`,
    { cwd: REPO, stdio: "pipe" }
  );
} catch {
  /* fall through: check the emitted file instead */
}
if (!fs.existsSync(path.join(OUT, "quiz-analytics.js"))) {
  throw new Error("tsc did not emit quiz-analytics.js");
}
const lib = require(path.join(OUT, "quiz-analytics.js"));

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------
let attemptSeq = 0;
function attempt(partial) {
  const base = {
    id: `a-${++attemptSeq}`,
    quizId: "q1",
    studentId: "s1",
    score: 0,
    totalMarks: 5,
    percentage: 0,
    passed: false,
    finishedAt: null,
  };
  return Object.assign(base, partial);
}
function finished(partial) {
  return attempt(Object.assign({ finishedAt: new Date("2026-01-01T00:00:00Z") }, partial));
}
function answer(questionId, isCorrect, difficulty) {
  return { questionId, isCorrect, difficulty };
}

section("A.1 Finished-attempt filtering");
{
  eq(lib.finishedAttempts([]).length, 0, "no attempts -> none finished");
  const open = attempt({ percentage: 0 });
  const done = finished({ percentage: 90 });
  eq(lib.isFinishedAttempt(open), false, "open attempt is not finished");
  eq(lib.isFinishedAttempt(done), true, "finished attempt is finished");
  eq(lib.finishedAttempts([open, done]).length, 1, "open attempt filtered out");
}

section("A.2 summarizeFinishedAttempts — empty / single");
{
  const empty = lib.summarizeFinishedAttempts([]);
  eq(empty, {
    attemptCount: 0, passCount: 0, passRate: 0, avgPercentage: 0,
    avgScore: 0, participantCount: 0, bestPercentage: 0, latestPercentage: 0,
  }, "empty summary is all zeros");

  const one = lib.summarizeFinishedAttempts([
    finished({ studentId: "s1", percentage: 80, score: 4, totalMarks: 5, passed: true }),
  ]);
  ok(one.attemptCount === 1 && one.passCount === 1, "one finished attempt counted");
  eq(one.passRate, 100, "single passed attempt -> 100% pass rate");
  eq(one.avgPercentage, 80, "single attempt avg = 80");
  eq(one.participantCount, 1, "single participant");
}

section("A.3 Unfinished attempts never affect aggregates");
{
  const sum = lib.summarizeFinishedAttempts([
    attempt({ percentage: 0, finishedAt: null }),
    attempt({ percentage: 0, finishedAt: null }),
    finished({ studentId: "s1", percentage: 100, score: 5, totalMarks: 5, passed: true }),
  ]);
  eq(sum.attemptCount, 1, "two open + one finished -> attemptCount 1");
  eq(sum.avgPercentage, 100, "open attempts do not drag the average down");
  eq(sum.passRate, 100, "pass rate over finished only");
}

section("A.4 Retakes count as separate data points (attempt-weighted)");
{
  // One student, three finished retakes at 0 / 50 / 100.
  const sum = lib.summarizeFinishedAttempts([
    finished({ studentId: "s1", percentage: 0, passed: false, score: 0 }),
    finished({ studentId: "s1", percentage: 50, passed: false, score: 2, totalMarks: 5 }),
    finished({ studentId: "s1", percentage: 100, passed: true, score: 5, totalMarks: 5 }),
  ]);
  eq(sum.attemptCount, 3, "three retakes -> three data points");
  eq(sum.avgPercentage, 50, "attempt-weighted mean (0+50+100)/3");
  eq(sum.passRate, 33, "1 of 3 passed -> 33%");
  eq(sum.participantCount, 1, "still one student");
}

section("A.5 best / latest / participants");
{
  const sum = lib.summarizeFinishedAttempts([
    finished({ studentId: "s1", percentage: 40, passed: false, finishedAt: new Date("2026-01-01") }),
    finished({ studentId: "s1", percentage: 90, passed: true, finishedAt: new Date("2026-01-03") }),
    finished({ studentId: "s2", percentage: 70, passed: true, finishedAt: new Date("2026-01-02") }),
  ]);
  eq(sum.bestPercentage, 90, "best = 90");
  eq(sum.latestPercentage, 90, "latest = most recent finished attempt (s1 #3)");
  eq(sum.participantCount, 2, "two distinct students");
  eq(sum.avgPercentage, Math.round((40 + 90 + 70) / 3), "mean over all finished");
}

section("A.6 Stored `passed` is authoritative across differing pass marks");
{
  // Two quizzes with different pass boundaries, but the stored `passed` flag
  // already encodes each quiz's own decision — the helper trusts it.
  const sum = lib.summarizeFinishedAttempts([
    finished({ quizId: "lowBar", percentage: 45, passed: true, score: 4, totalMarks: 9 }),
    finished({ quizId: "highBar", percentage: 60, passed: false, score: 6, totalMarks: 10 }),
  ]);
  eq(sum.passCount, 1, "stored passed respected (45 passed on low bar)");
  eq(sum.passRate, 50, "1 of 2 finished passed");
}

section("B.1 difficultyBreakdown — stable shape + correctness");
{
  const bd = lib.difficultyBreakdown([
    answer("qA", true, "EASY"),
    answer("qA", false, "EASY"),
    answer("qB", true, "MEDIUM"),
    answer("qC", false, "HARD"),
  ]);
  ok(bd.EASY && bd.MEDIUM && bd.HARD, "all three difficulty keys always present");
  eq(bd.EASY, { difficulty: "EASY", attempts: 2, correct: 1, incorrect: 1, correctPercent: 50 }, "EASY slice");
  eq(bd.MEDIUM.correctPercent, 100, "MEDIUM 1/1 correct");
  eq(bd.HARD.correctPercent, 0, "HARD 0/1 correct");

  const empty = lib.difficultyBreakdown([]);
  eq(empty.HARD.correctPercent, 0, "empty breakdown zeroed, not missing");

  const list = lib.difficultyBreakdownList([answer("qB", true, "MEDIUM")]);
  eq(list.map((d) => d.difficulty), ["EASY", "MEDIUM", "HARD"], "list ordered EASY->MEDIUM->HARD");
}

section("B.2 questionPerformance + weakestQuestions");
{
  const perf = lib.questionPerformance([
    answer("qA", false, "HARD"),
    answer("qA", false, "HARD"),
    answer("qA", true, "HARD"),
    answer("qB", true, "EASY"),
    answer("qB", true, "EASY"),
  ]);
  const qA = perf.find((p) => p.questionId === "qA");
  const qB = perf.find((p) => p.questionId === "qB");
  ok(qA && qA.attempts === 3 && qA.correct === 1 && qA.correctPercent === 33, "qA aggregated across attempts");
  ok(qB && qB.attempts === 2 && qB.correctPercent === 100, "qB 100% correct");

  const weakest = lib.weakestQuestions(perf, 1);
  eq(weakest[0].questionId, "qA", "lowest correctness ranks first");
  eq(weakest[1].questionId, "qB", "highest correctness ranks last");

  // minAttempts filters low-observation questions out of the "weak" list.
  const min3 = lib.weakestQuestions(perf, 3);
  eq(min3.map((p) => p.questionId), ["qA"], "with minAttempts=3 only qA (3 attempts) qualifies");
}

section("B.3 attemptInQuizScope");
{
  const scope = new Set(["myQuiz"]);
  ok(lib.attemptInQuizScope({ quizId: "myQuiz" }, scope), "authorised quiz in scope");
  ok(!lib.attemptInQuizScope({ quizId: "otherQuiz" }, scope), "foreign quiz out of scope");
}

// ---------------------------------------------------------------------------
section("C. Route source invariants");
// ---------------------------------------------------------------------------

// C.1 Teacher quiz analytics only count FINISHED attempts.
{
  const quizzes = read("src/app/api/teacher/quizzes/route.ts");
  ok(
    /finishedAt:\s*\{\s*not:\s*null\s*\}/.test(quizzes) &&
      /where:\s*\{\s*finishedAt/.test(quizzes),
    "teacher/quizzes GET restricts attempts to finishedAt != null"
  );
  ok(
    /summarizeFinishedAttempts/.test(quizzes),
    "teacher/quizzes GET aggregates via summarizeFinishedAttempts"
  );

  const analytics = read("src/app/api/teacher/analytics/route.ts");
  ok(
    /quizAttempts\s*:\s*\{\s*where:\s*\{\s*finishedAt:\s*\{\s*not:\s*null\s*\}\s*\}/.test(analytics),
    "teacher/analytics GET restricts quizAttempts to finishedAt != null"
  );
}

// C.2 Teacher analytics are scoped to the teacher's own authorised courses.
{
  const analytics = read("src/app/api/teacher/analytics/route.ts");
  ok(
    /attemptInQuizScope/.test(analytics),
    "teacher/analytics GET filters attempts through attemptInQuizScope"
  );
  ok(
    /unit:\s*\{\s*part:\s*\{\s*courseId:\s*\{\s*in:\s*courseIds\s*\}\s*\}\s*\}/.test(analytics) &&
      /topic:\s*\{\s*unit:\s*\{\s*part:\s*\{\s*courseId:\s*\{\s*in:\s*courseIds\s*\}\s*\}\s*\}\s*\}/.test(analytics),
    "teacher/analytics resolves authorised quizzes through BOTH curriculum chains"
  );
  ok(
    !/teacher\.groups\.flatMap\(g => g\.students\)/.test(analytics),
    "teacher/analytics does not widen to students outside the teacher's groups"
  );
}

// C.3 Answer-leak protection is intact on the student quiz surface (Phase 1/5).
{
  const quizGet = read("src/app/api/quizzes/[id]/route.ts");
  ok(
    /revealAnswers\s*=/.test(quizGet) && /studentHasAttempted/.test(quizGet),
    "quiz GET keeps the post-first-attempt answer reveal rule"
  );
  const submit = read("src/app/api/quizzes/[id]/submit/route.ts");
  ok(
    /gradeAttemptQuestionSet/.test(submit) &&
      /user\.role !== "STUDENT"/.test(submit),
    "quiz submit is student-only and graded server-side"
  );
}

// C.4 Mock Exams stay fully separate from Session Quiz analytics.
{
  const analytics = read("src/app/api/teacher/analytics/route.ts");
  const quizzes = read("src/app/api/teacher/quizzes/route.ts");
  ok(
    !/ExamAttempt/.test(analytics) && !/ExamAttempt/.test(quizzes),
    "teacher analytics never read ExamAttempt (Mock Exam) rows"
  );
}

section(`\nquiz analytics: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
