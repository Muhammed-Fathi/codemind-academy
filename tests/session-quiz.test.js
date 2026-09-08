// CodeMind Academy — Phase 5 Question Bank & Session Quiz regression tests.
//
// Three layers, all offline (no database file, no network, no server):
//
//   A. BEHAVIOURAL — `src/lib/session-quiz.ts` is compiled with tsc and
//      exercised against a fake `@/lib/db`. This runs the REAL question-set
//      selection and the REAL grading arithmetic, so a change that lets a
//      client influence the question set or the score fails here.
//
//   B. ROUTE SOURCE INVARIANTS — the quiz route sources are read and
//      asserted, in the same style as tests/authorization-invariants.test.js
//      and tests/session-progression.test.js. This pins the Phase 5 gates
//      into the actual HTTP surface, which the behavioural layer cannot see.
//
//   C. CURRICULUM-CHAIN COVERAGE — the routes that resolve a lesson's course
//      must use BOTH chains (canonical unitId + legacy topicId), never the
//      topic chain alone (the Phase 4 "invisible lesson" bug class).
//
// Run: node tests/session-quiz.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
const { Module } = require("module");
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
// Compile the session-quiz service to CommonJS in a temp dir.
// `@/lib/db` is redirected to an in-memory fake via a resolver hook, because
// tsc does not rewrite path aliases in the emitted require() calls.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p5-test-"));
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
    files: [path.join(REPO, "src/lib/session-quiz.ts")],
  })
);
// tsc must RESOLVE `@/lib/db` for typing, but the emitted require() keeps the
// alias — it is redirected to the fake at load time below. Type errors in
// unrelated parts of the graph are tolerated here (`bun run typecheck` is the
// real gate); what matters is that the JS we are about to exercise was emitted.
try {
  execSync(
    `${process.execPath} ${path.join(__dirname, "..", "node_modules/typescript/lib/tsc.js")} -p ${path.join(OUT, "tsconfig.json")}`,
    { cwd: REPO, stdio: "pipe" }
  );
} catch {
  /* fall through: check the emitted files instead */
}
if (!fs.existsSync(path.join(OUT, "session-quiz.js"))) {
  throw new Error("tsc did not emit session-quiz.js");
}

// Fake @prisma/client types are compile-time only; at runtime the compiled
// service only touches the fake db we inject.
const FAKE_DB_PATH = path.join(OUT, "db.js");

function makeFakeDb() {
  // Minimal in-memory replica of the tables the service touches.
  const state = {
    questions: [], // { id, quizId, type, prompt, promptAr, options, answer, explanation, difficulty, marks, createdAt }
    quizzes: [], // { id, passMark }
    quizAttempts: [], // { id, quizId, studentId, finishedAt }
    quizAnswers: [], // { id, attemptId, questionId, selected, isCorrect }
    nextId: 1,
  };
  const id = () => `row-${state.nextId++}`;
  const q = (quizId, answer, marks, prompt) => {
    const row = {
      id: id(),
      quizId,
      type: "MCQ",
      prompt: prompt || `Q-${id()}`,
      promptAr: null,
      options: JSON.stringify(["a", "b", "c", "d"]),
      answer,
      explanation: null,
      difficulty: "MEDIUM",
      marks,
      createdAt: new Date(Date.now() + state.questions.length), // stable order
    };
    state.questions.push(row);
    return row;
  };
  const db = {
    __state: state,
    question: {
      async findMany({ where, orderBy }) {
        let rows = state.questions.filter((x) => x.quizId === where.quizId);
        if (orderBy) {
          rows = [...rows].sort((a, b) =>
            String(a.createdAt).localeCompare(String(b.createdAt)) ||
            a.id.localeCompare(b.id)
          );
        }
        return rows.map((r) => ({ ...r }));
      },
    },
    quizAnswer: {
      async findMany({ where, include }) {
        return state.quizAnswers
          .filter((a) => a.attemptId === where.attemptId)
          .map((a) => ({
            ...a,
            question: state.questions.find((x) => x.id === a.questionId),
          }));
      },
      async createMany({ data }) {
        for (const row of data) {
          if (
            state.quizAnswers.some(
              (a) =>
                a.attemptId === row.attemptId && a.questionId === row.questionId
            )
          ) {
            const err = new Error("Unique constraint violated");
            err.code = "P2002";
            throw err;
          }
          state.quizAnswers.push({ id: id(), ...row });
        }
        return { count: data.length };
      },
      async create({ data }) {
        if (
          state.quizAnswers.some(
            (a) =>
              a.attemptId === data.attemptId && a.questionId === data.questionId
          )
        ) {
          const err = new Error("Unique constraint violated");
          err.code = "P2002";
          throw err;
        }
        const row = { id: id(), ...data };
        state.quizAnswers.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = state.quizAnswers.find((a) => a.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return { ...row };
      },
    },
    quizAttempt: {
      async findUnique({ where, select }) {
        const row = state.quizAttempts.find((a) => a.id === where.id);
        if (!row) return null;
        // select: { quiz: { select: { questions: ... } } }
        const quizId = row.quizId;
        const questions = state.questions
          .filter((x) => x.quizId === quizId)
          .sort((a, b) =>
            String(a.createdAt).localeCompare(String(b.createdAt)) ||
            a.id.localeCompare(b.id)
          )
          .map((r) => ({ ...r }));
        return { quiz: { questions } };
      },
    },
  };
  return { db, helpers: { q } };
}

// Resolver hook: redirect @/lib/db to the fake.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "@/lib/db") return FAKE_DB_PATH;
  return originalResolve.call(this, request, ...args);
};
const loadServiceWith = (fakeDb) => {
  // Re-write the fake module so each load gets a fresh db reference.
  // The compiled service does `import { db } from "@/lib/db"`, which in CJS
  // reads the `.db` property — hence the export shape.
  fs.writeFileSync(
    FAKE_DB_PATH,
    `module.exports = { db: globalThis.__CM_P5_FAKE_DB__ };`
  );
  globalThis.__CM_P5_FAKE_DB__ = fakeDb;
  delete require.cache[FAKE_DB_PATH];
  const svcPath = path.join(OUT, "session-quiz.js");
  delete require.cache[svcPath];
  return require(svcPath);
};

(async () => {
// ---------------------------------------------------------------------------
section("A. Behaviour — attempt question-set selection & persistence");

{
  const { db, helpers } = makeFakeDb();
  const svc = loadServiceWith(db);
  const H = helpers;
  const quizId = "quiz-1";
  const q1 = H.q(quizId, "0", 2);
  const q2 = H.q(quizId, "1", 1);
  const q3 = H.q(quizId, "2", 3);

  // A new attempt freezes the CURRENT questions as answer rows.
  db.__state.quizAttempts.push({
    id: "attempt-1",
    quizId,
    studentId: "student-A",
    finishedAt: null,
  });
  const seeded = await svc.seedAttemptQuestions("attempt-1", quizId);
  ok(seeded === undefined, "seedAttemptQuestions resolves");
  eq(
    db.__state.quizAnswers
      .filter((a) => a.attemptId === "attempt-1")
      .map((a) => a.questionId),
    [q1.id, q2.id, q3.id],
    "attempt question set persisted at creation, in quiz order"
  );
  ok(
    db.__state.quizAnswers.every((a) => a.selected === "" && !a.isCorrect),
    "seeded rows start unanswered"
  );

  // Mid-attempt bank change: a NEW question must NOT join the open attempt.
  const late = H.q(quizId, "0", 5);
  const set = await svc.loadAttemptQuestionSet("attempt-1");
  eq(
    set.map((x) => x.questionId),
    [q1.id, q2.id, q3.id],
    "late-added question does not join the open attempt"
  );
  ok(
    !set.some((x) => x.questionId === late.id),
    "late question absent from persisted set"
  );

  // Refresh: same set, stable order.
  const setAgain = await svc.loadAttemptQuestionSet("attempt-1");
  eq(
    setAgain.map((x) => x.questionId),
    set.map((x) => x.questionId),
    "repeated loads return the identical set (refresh stability)"
  );

  // Seeding the same attempt again is rejected by the unique constraint.
  let p2002 = null;
  try {
    await svc.seedAttemptQuestions("attempt-1", quizId);
  } catch (e) {
    p2002 = e.code;
  }
  eq(p2002, "P2002", "double-seed hits the unique constraint (one row per question)");
}

{
  section("A2. Behaviour — per-student isolation of the frozen set");
  const { db, helpers } = makeFakeDb();
  const svc = loadServiceWith(db);
  const H = helpers;
  const quizId = "quiz-shared";
  const q1 = H.q(quizId, "0", 1);
  const q2 = H.q(quizId, "1", 1);

  // Student A and student B each open their own attempt on the same quiz.
  for (const [attemptId, studentId] of [
    ["attempt-A", "student-A"],
    ["attempt-B", "student-B"],
  ]) {
    db.__state.quizAttempts.push({
      id: attemptId,
      quizId,
      studentId,
      finishedAt: null,
    });
    await svc.seedAttemptQuestions(attemptId, quizId);
  }
  const setA = await svc.loadAttemptQuestionSet("attempt-A");
  const setB = await svc.loadAttemptQuestionSet("attempt-B");
  eq(setA.map((x) => x.questionId), [q1.id, q2.id], "student A set");
  eq(setB.map((x) => x.questionId), [q1.id, q2.id], "student B set");
  // Bank change AFTER both attempts exist: neither attempt is affected.
  H.q(quizId, "0", 9);
  eq(
    (await svc.loadAttemptQuestionSet("attempt-A")).length,
    2,
    "student A attempt unaffected by later bank addition"
  );
  eq(
    (await svc.loadAttemptQuestionSet("attempt-B")).length,
    2,
    "student B attempt unaffected by later bank addition"
  );

  // Deleting a question from the bank cascades its answer rows away
  // (schema onDelete: Cascade) — the set shrinks but stays consistent.
  db.__state.questions = db.__state.questions.filter((x) => x.id !== q2.id);
  db.__state.quizAnswers = db.__state.quizAnswers.filter((a) => a.questionId !== q2.id);
  eq(
    (await svc.loadAttemptQuestionSet("attempt-A")).map((x) => x.questionId),
    [q1.id],
    "deleted question leaves the set with its (cascade-deleted) row"
  );
}

{
  section("A3. Behaviour — pre-Phase-5 in-flight attempt adopts live questions");
  const { db, helpers } = makeFakeDb();
  const svc = loadServiceWith(db);
  const H = helpers;
  const quizId = "quiz-legacy";
  const q1 = H.q(quizId, "0", 1);
  const q2 = H.q(quizId, "1", 1);
  db.__state.quizAttempts.push({
    id: "old-attempt",
    quizId,
    studentId: "student-A",
    finishedAt: null,
  });
  // NO seeded rows — an attempt opened before the Phase 5 deploy.
  const set = await svc.loadAttemptQuestionSet("old-attempt");
  eq(set.map((x) => x.questionId), [q1.id, q2.id], "adopted live quiz questions");
  ok(
    set.every((x) => x.answerId === null),
    "adopted entries are marked un-persisted (answerId = null)"
  );
}

// ---------------------------------------------------------------------------
section("B. Behaviour — server-side grading");
{
  const { db, helpers } = makeFakeDb();
  const svc = loadServiceWith(db);
  const H = helpers;
  const quizId = "quiz-g";
  const q1 = H.q(quizId, "0", 2); // correct answer option 0
  const q2 = H.q(quizId, "1", 3); // correct answer option 1
  const q3 = H.q(quizId, "2", 4); // left unanswered

  const set = [
    { answerId: "a1", questionId: q1.id, selected: "", question: q1 },
    { answerId: "a2", questionId: q2.id, selected: "", question: q2 },
    { answerId: "a3", questionId: q3.id, selected: "", question: q3 },
  ];

  const result = svc.gradeAttemptQuestionSet(
    set,
    [
      { questionId: q1.id, selected: "0" }, // correct
      { questionId: q2.id, selected: "0" }, // wrong
      // q3: no answer
      { questionId: "FOREIGN", selected: "0" }, // not in the attempt
    ],
    50
  );

  eq(result.score, 2, "only the correct answer earns marks");
  eq(result.totalMarks, 9, "total marks from the attempt's questions only");
  eq(result.percentage, 22, "percentage computed server-side (round(2/9*100))");
  eq(result.passed, false, "below pass mark");
  ok(
    !result.graded.some((g) => g.questionId === "FOREIGN"),
    "answers for questions outside the attempt are ignored"
  );
  eq(
    result.graded.find((g) => g.questionId === q3.id).selected,
    "",
    "unanswered question graded as empty selection"
  );
  ok(
    result.graded.find((g) => g.questionId === q3.id).isCorrect === false,
    "unanswered question is incorrect"
  );
  eq(
    result.graded.find((g) => g.questionId === q1.id).correctAnswer,
    "0",
    "graded row carries the authoritative correct answer (post-submit review)"
  );

  // All-correct attempt passes.
  const perfect = svc.gradeAttemptQuestionSet(
    set,
    [
      { questionId: q1.id, selected: "0" },
      { questionId: q2.id, selected: "1" },
      { questionId: q3.id, selected: "2" },
    ],
    50
  );
  eq(perfect.score, 9, "perfect attempt scores full marks");
  eq(perfect.percentage, 100, "perfect attempt is 100%");
  eq(perfect.passed, true, "perfect attempt passes");
}

{
  section("B2. Behaviour — client tampering cannot influence grading");
  const { db, helpers } = makeFakeDb();
  const svc = loadServiceWith(db);
  const H = helpers;
  const quizId = "quiz-t";
  const q1 = H.q(quizId, "0", 1);
  const set = [{ answerId: "a1", questionId: q1.id, selected: "", question: q1 }];

  // The grading function accepts ONLY questionId + selected; forged
  // score/percentage/isCorrect/marks fields are not even parameters.
  const forged = svc.gradeAttemptQuestionSet(
    set,
    [
      {
        questionId: q1.id,
        selected: "0",
        score: 999,
        percentage: 100,
        isCorrect: true,
        marks: 999,
        totalMarks: 0,
      },
    ],
    60
  );
  eq(forged.score, 1, "forged marks/score fields are ignored");
  eq(forged.totalMarks, 1, "total marks come from the question row");
  eq(forged.percentage, 100, "percentage recomputed server-side");

  // A submitted "selected" that is not a plain short option index is
  // normalised, never stored raw.
  eq(svc.sanitizeSelectedInput("0"), "0", "plain index passes");
  eq(svc.sanitizeSelectedInput(2), "2", "integer index passes");
  eq(svc.sanitizeSelectedInput(""), "", "empty stays empty");
  eq(svc.sanitizeSelectedInput({ hack: 1 }), "", "object payload rejected");
  eq(
    svc.sanitizeSelectedInput("A".repeat(64)),
    "",
    "overlong payload rejected (bounded storage)"
  );

  // Duplicate submissions of the same question: FIRST occurrence wins
  // (the pre-Phase-5 `answersRaw.find` semantics).
  const dup = svc.gradeAttemptQuestionSet(
    set,
    [
      { questionId: q1.id, selected: "0" },
      { questionId: q1.id, selected: "1" },
    ],
    60
  );
  eq(dup.score, 1, "duplicate question submission keeps the first answer");
}

{
  section("B3. Behaviour — empty / degenerate question sets");
  const svc = loadServiceWith(makeFakeDb().db);
  const empty = svc.gradeAttemptQuestionSet([], [], 60);
  eq(empty.score, 0, "empty set scores 0");
  eq(empty.totalMarks, 0, "empty set has 0 total marks");
  eq(empty.percentage, 0, "empty set percentage is 0 (no divide-by-zero)");
  eq(empty.passed, false, "empty set does not pass a 60% pass mark");
}

// ---------------------------------------------------------------------------
section("C. Route source invariants — gates, persistence, no leaks");

const quizGet = read("src/app/api/quizzes/[id]/route.ts");
const quizStart = read("src/app/api/quizzes/[id]/start/route.ts");
const quizSubmit = read("src/app/api/quizzes/[id]/submit/route.ts");
const quizEvidence = read("src/app/api/quizzes/[id]/evidence/route.ts");
const lessonRoute = read("src/app/api/lessons/[id]/route.ts");

// 1. Every quiz route re-verifies the Phase 4 session gate.
for (const [name, src] of [
  ["GET /api/quizzes/[id]", quizGet],
  ["POST /api/quizzes/[id]/start", quizStart],
  ["POST /api/quizzes/[id]/submit", quizSubmit],
  ["POST /api/quizzes/[id]/evidence", quizEvidence],
]) {
  ok(
    /canAccessQuiz\(/.test(src),
    `${name} enforces the Phase 4 session gate (canAccessQuiz)`
  );
}

// 2. Answers withheld before submission.
ok(
  /revealAnswers/.test(quizGet) &&
    /studentHasAttempted/.test(quizGet) &&
    /answer: revealAnswers \? q\.answer : undefined/.test(quizGet),
  "GET quiz withholds answer until a finished attempt exists"
);
ok(
  /answer: revealQuizAnswers \? q2?\.answer : undefined/.test(lessonRoute),
  "GET lesson withholds quiz answer until a finished attempt exists"
);

// 3. Attempt question set persistence (Phase 5 core).
ok(
  /seedAttemptQuestions\(/.test(quizStart),
  "/start persists the attempt's question set at creation"
);
ok(
  /loadAttemptQuestionSet\(/.test(quizGet),
  "GET quiz serves the open attempt's persisted set"
);
ok(
  /loadAttemptQuestionSet\(/.test(quizSubmit),
  "/submit grades the open attempt's persisted set"
);
ok(
  !/deleteMany: \{\}/.test(quizSubmit),
  "/submit no longer wipes and recreates answer rows (updates them in place)"
);

// 4. Grading is server-side.
ok(
  /gradeAttemptQuestionSet\(/.test(quizSubmit) &&
    /gradeAttemptQuestionSet/.test(read("src/lib/session-quiz.ts")),
  "/submit grades through the shared server-side grader"
);
ok(
  !/body\.score|body\.percentage|body\.passed|body\.totalMarks/.test(quizSubmit),
  "/submit never reads score/percentage/passed/totalMarks from the body"
);

// 5. Attempt ownership: the attempt's studentId always comes from the session.
ok(
  /student: \{ userId: user\.id \}/.test(quizGet),
  "GET quiz looks up attempts through the session user, not a body param"
);
ok(
  /attempt\.studentId !== student\.id/.test(quizEvidence),
  "evidence route verifies attempt ownership"
);

// 6. Unique constraint: one answer per (attempt, question).
const schema = read("prisma/schema.prisma");
ok(
  /model QuizAnswer[\s\S]*?@@unique\(\[attemptId, questionId\]\)/.test(schema),
  "schema enforces @@unique([attemptId, questionId]) on QuizAnswer"
);
const migrationDir = "prisma/migrations/20260908120000_phase5_quiz_answer_unique";
ok(
  fs.existsSync(path.join(REPO, migrationDir, "migration.sql")),
  "focused Phase 5 migration exists"
);
ok(
  /CREATE UNIQUE INDEX "?QuizAnswer_attemptId_questionId_key"?/.test(
    read(`${migrationDir}/migration.sql`)
  ),
  "migration creates the unique index"
);
{
  // Comments may MENTION dangerous SQL; only executable statements matter.
  const executable = read(`${migrationDir}/migration.sql`)
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  ok(
    !/DROP TABLE|ALTER TABLE .*DROP|DELETE FROM (?!QuizAnswer)/i.test(executable),
    "migration drops nothing outside the QuizAnswer dedup"
  );
}

// ---------------------------------------------------------------------------
section("D. Curriculum-chain coverage — both chains, canonical first");

// Phase 4 lesson: canonical lessons are attached through Lesson.unitId. Every
// route that resolves a lesson's course from its curriculum links must use
// BOTH chains; a topic-only query hides canonical lessons entirely.
// (Prisma expresses nested reads either as `unit: { part: ... }` or
// `unit: { include: { part: ... } }` — both shapes count.)
const bothChains = (src) =>
  /unit:\s*\{\s*(include:\s*\{\s*)?part:\s*\{\s*(include:\s*\{\s*)?course/.test(
    src
  ) &&
  /topic:\s*\{\s*(include:\s*\{\s*)?unit:\s*\{\s*(include:\s*\{\s*)?part:\s*\{\s*(include:\s*\{\s*)?course/.test(
    src
  );

ok(
  bothChains(quizGet),
  "GET quiz resolves the lesson course through both chains"
);
ok(
  /unit\?\.part\.course\.slug\s*\?\?\s*[\s\S]*topic\?\.unit\.part\.course\.slug/.test(
    quizGet
  ),
  "GET quiz prefers the canonical chain for courseSlug"
);
ok(
  bothChains(lessonRoute),
  "GET lesson resolves part/unit/course through both chains"
);
ok(
  /quizzes: lesson\.quizzes\.map\(toQuizPayload\)/.test(lessonRoute),
  "GET lesson returns ALL quizzes of the session (engine requires every one)"
);

const teacherQuizzes = read("src/app/api/teacher/quizzes/route.ts");
ok(
  bothChains(teacherQuizzes),
  "teacher quizzes listing/creation resolves lessons through both chains"
);
ok(
  /lesson\.unit\?\.part\.courseId \?\? lesson\.topic\?\.unit\.part\.courseId/.test(
    teacherQuizzes
  ),
  "teacher quiz creation checks course ownership through both chains"
);

const mockExam = read("src/app/api/exams/mock/route.ts");
ok(
  bothChains(mockExam),
  "mock exam question pool includes both chains' lessons"
);

const aiGenerate = read("src/app/api/admin/ai-generate-quiz/route.ts");
ok(
  bothChains(aiGenerate),
  "AI quiz generation resolves the lesson through both chains"
);
ok(
  /user\.role === "TEACHER"/.test(aiGenerate) &&
    /teacherCourseIds\.includes\(lessonCourseId\)/.test(aiGenerate),
  "AI quiz generation scopes TEACHERs to their own courses"
);

// Mock exam / session quiz separation.
ok(
  /examAttempt\.create/.test(mockExam) && !/quizAttempt\.create/.test(mockExam),
  "mock exams persist ExamAttempt rows only (no Session Quiz attempt state)"
);
ok(
  !/mockExam|examAttempt/i.test(quizSubmit),
  "session quiz submit never touches mock exam state"
);

// ---------------------------------------------------------------------------
section("E. Baseline protections still in place (Phase 4 carry-over)");

const sessionProgress = read("src/lib/session-progress.ts");
ok(
  /OR:\s*\[\s*\{\s*unit:\s*\{\s*part:\s*\{\s*courseId\s*\}\s*\}\s*\},\s*\{\s*topic:/.test(
    sessionProgress
  ),
  "progression universe still matches both chains"
);
ok(
  /attemptedQuizzes\.has/.test(sessionProgress),
  "quiz completion requirement unchanged (finished attempt exists)"
);
ok(
  /VIDEO_COMPLETION_THRESHOLD/.test(sessionProgress),
  "95% video threshold unchanged"
);

// ---------------------------------------------------------------------------
// Restore the resolver hook.
Module._resolveFilename = originalResolve;

console.log(
  `\nsession quiz: ${pass} passed, ${fail} failed`
);
process.exit(fail > 0 ? 1 : 0);
})();
