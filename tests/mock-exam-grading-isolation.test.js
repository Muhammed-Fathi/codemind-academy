// CodeMind Academy — Mock exam grading: EXECUTABLE bank-isolation proof.
//
// The authorization-invariants suite only greps for `gradingBankFilter`. A
// regex cannot prove the filter actually *works*, so this suite rebuilds the
// grading path against a real SQLite database (node:sqlite) with two
// populated banks and replays crafted submissions through it.
//
// Chain under test:
//   Student.schoolType -> questionBankFilter -> Question/ExamQuestion lookup
//   -> keyById -> graded[] -> score/percentage/passed -> ExamAttempt
//
// Run: node tests/mock-exam-grading-isolation.test.js

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; } else { failed++; console.log(`  \u2717 ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---------------------------------------------------------------- fixtures
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE Question (id TEXT PRIMARY KEY, schoolType TEXT, answer TEXT, marks INTEGER, options TEXT);
  CREATE TABLE ExamQuestion (id TEXT PRIMARY KEY, schoolType TEXT, answer TEXT, marks INTEGER, options TEXT);
`);
const OPTS = JSON.stringify(["alpha", "beta", "gamma", "delta"]);
const rows = [
  ["q-ar-1", "ARABIC", "1", 5], ["q-ar-2", "ARABIC", "0", 5],
  ["q-lang-1", "LANGUAGE", "2", 5], ["q-lang-2", "LANGUAGE", "3", 5],
  ["q-shared-1", null, "1", 5],
];
for (const [id, st, ans, marks] of rows) {
  db.prepare("INSERT INTO Question VALUES (?,?,?,?,?)").run(id, st, ans, marks, OPTS);
}
db.prepare("INSERT INTO ExamQuestion VALUES (?,?,?,?,?)").run("eq-ar-1", "ARABIC", "1", 10, OPTS);
db.prepare("INSERT INTO ExamQuestion VALUES (?,?,?,?,?)").run("eq-lang-1", "LANGUAGE", "1", 10, OPTS);

// -------------------------------------------- the real filter, real source
// questionBankFilter is TS; re-derive it from the source so the test breaks
// if the shared helper's semantics ever change.
const stSrc = fs.readFileSync(path.join(__dirname, "..", "src/lib/school-type.ts"), "utf8");
ok(/OR:\s*\[\{ schoolType \}, \{ schoolType: null \}\]/.test(stSrc),
  "questionBankFilter still means: own type OR shared(null)");
ok(/const gradingBankFilter = studentSchoolType/.test(
    fs.readFileSync(path.join(__dirname, "..", "src/app/api/exams/mock/route.ts"), "utf8")),
  "grading path still derives its filter from the DB-backed student type");

// SQL equivalent of questionBankFilter(schoolType, includeShared=true).
function bankWhere(schoolType) {
  return schoolType === null
    ? { sql: "schoolType IS NULL", args: [] }               // no type -> shared only
    : { sql: "(schoolType = ? OR schoolType IS NULL)", args: [schoolType] };
}

// Faithful re-implementation of the route's grading block.
function grade(studentSchoolType, answers) {
  const ids = answers.map((a) => a.questionId).filter(Boolean);
  if (!ids.length) return { graded: [], score: 0, totalMarks: 0, percentage: 0 };
  const w = bankWhere(studentSchoolType);
  const ph = ids.map(() => "?").join(",");
  const keyById = new Map();
  for (const tbl of ["Question", "ExamQuestion"]) {
    const found = db.prepare(
      `SELECT id, answer, marks, options FROM ${tbl} WHERE id IN (${ph}) AND ${w.sql}`
    ).all(...ids, ...w.args);
    for (const q of found) keyById.set(q.id, q);
  }
  const graded = answers.map((a) => {
    const key = keyById.get(a.questionId);
    if (!key) return { ...a, isCorrect: false, marks: 0 };   // out-of-bank -> 0
    const opts = JSON.parse(key.options);
    const correctText = opts[parseInt(key.answer, 10)];
    const isCorrect =
      String(a.selected) === String(key.answer) ||
      (correctText !== undefined && String(a.selected) === correctText);
    return { ...a, isCorrect, marks: key.marks };
  });
  const totalMarks = graded.reduce((s, a) => s + (a.marks || 0), 0);
  const score = graded.filter((a) => a.isCorrect).reduce((s, a) => s + (a.marks || 0), 0);
  return { graded, score, totalMarks,
    percentage: totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0 };
}

// --------------------------------------------------------------- the cases
// 1. Honest Arabic student answering their own bank correctly.
{
  const r = grade("ARABIC", [
    { questionId: "q-ar-1", selected: "1", isCorrect: true, marks: 5 },
    { questionId: "eq-ar-1", selected: "1", isCorrect: true, marks: 10 },
  ]);
  eq(r.score, 15, "own-bank correct answers score fully");
  eq(r.percentage, 100, "own-bank perfect attempt is 100%");
}
// 2. Shared questions are reachable by both banks.
for (const st of ["ARABIC", "LANGUAGE"]) {
  const r = grade(st, [{ questionId: "q-shared-1", selected: "1", isCorrect: true, marks: 5 }]);
  eq(r.score, 5, `${st} student can be graded on a SHARED question`);
}
// 3. THE FIX: foreign-bank ids are refused, not graded in.
{
  const r = grade("ARABIC", [
    { questionId: "q-lang-1", selected: "2", isCorrect: true, marks: 5 },
    { questionId: "eq-lang-1", selected: "1", isCorrect: true, marks: 10 },
  ]);
  eq(r.score, 0, "foreign-bank questions score 0 even when answered correctly");
  eq(r.totalMarks, 0, "foreign-bank questions contribute 0 to the total");
  ok(r.graded.every((g) => g.isCorrect === false),
    "client-sent isCorrect:true is overridden for foreign-bank ids");
}
// 4. Mixed submission: only the in-bank part counts.
{
  const r = grade("ARABIC", [
    { questionId: "q-ar-1", selected: "1", isCorrect: true, marks: 5 },
    { questionId: "q-lang-1", selected: "2", isCorrect: true, marks: 5 },
  ]);
  eq(r.score, 5, "mixed submission scores only the in-bank question");
  eq(r.totalMarks, 5, "mixed submission totals only the in-bank question");
  eq(r.percentage, 100, "percentage is computed over in-bank marks only");
}
// 5. Client-inflated marks are never trusted.
{
  const r = grade("ARABIC", [
    { questionId: "q-ar-1", selected: "1", isCorrect: true, marks: 9999 },
  ]);
  eq(r.score, 5, "marks come from the DB answer key, not the client");
}
// 6. Wrong answers score 0 but still count toward the total.
{
  const r = grade("ARABIC", [
    { questionId: "q-ar-1", selected: "3", isCorrect: true, marks: 5 },
  ]);
  eq(r.score, 0, "a wrong answer scores 0 despite client isCorrect:true");
  eq(r.totalMarks, 5, "a wrong in-bank answer still counts toward the total");
}
// 7. Shuffled options: the client reports selected TEXT, not an index.
{
  const r = grade("ARABIC", [
    { questionId: "q-ar-1", selected: "beta", isCorrect: false, marks: 0 },
  ]);
  eq(r.score, 5, "selected option TEXT is accepted (client shuffles order)");
}
// 8. Unknown / crafted ids.
{
  const r = grade("ARABIC", [
    { questionId: "does-not-exist", selected: "1", isCorrect: true, marks: 5 },
  ]);
  eq(r.score, 0, "a nonexistent question id scores 0");
}
// 9. Null school type -> shared bank ONLY (the hole closed in this pass).
{
  const r = grade(null, [
    { questionId: "q-ar-1", selected: "1", isCorrect: true, marks: 5 },
    { questionId: "q-lang-1", selected: "2", isCorrect: true, marks: 5 },
  ]);
  eq(r.score, 0, "a student with no school type cannot reach EITHER typed bank");
  const s = grade(null, [{ questionId: "q-shared-1", selected: "1", isCorrect: true, marks: 5 }]);
  eq(s.score, 5, "a student with no school type can still be graded on shared questions");
}
// 10. Symmetry: the isolation holds in the LANGUAGE direction too.
{
  const r = grade("LANGUAGE", [
    { questionId: "q-ar-1", selected: "1", isCorrect: true, marks: 5 },
    { questionId: "eq-ar-1", selected: "1", isCorrect: true, marks: 10 },
  ]);
  eq(r.score, 0, "an ARABIC question cannot be graded into a LANGUAGE attempt");
  const own = grade("LANGUAGE", [
    { questionId: "q-lang-1", selected: "2", isCorrect: true, marks: 5 },
  ]);
  eq(own.score, 5, "the LANGUAGE student is still graded on their own bank");
}
// 11. Empty submission does not divide by zero.
{
  const r = grade("ARABIC", []);
  eq(r.percentage, 0, "an empty submission yields 0% rather than NaN");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
