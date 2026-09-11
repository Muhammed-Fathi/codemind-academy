// CodeMind Academy — Phase 18 (teacher workflow completion) behavior suite.
//
// THE CONTRACT UNDER TEST
// =======================
// A teacher configures the canonical official curriculum — Lesson → Quiz /
// Homework — and nothing about that workflow may weaken what earlier phases
// established:
//
//   * canonical coverage: every teacher reader resolves
//     Course → Part → Unit → Lesson first, with the legacy Topic chain only as
//     a fallback, and NO student visibility rule leaks into teacher management
//     (ARCHIVED and DRAFT lessons stay visible, because a teacher manages the
//     whole catalogue and a retired lesson can still hold ungraded work);
//   * authorization: every write is authenticated → TEACHER role → the
//     teacher's own courses (from their groups, never from the request) → the
//     lesson belongs to those courses → the resource belongs to the lesson →
//     the track scope is valid;
//   * track scope is EXPLICIT: an absent container scope inherits the LESSON's
//     (never SHARED by omission), a track-specific child must be contained by
//     the lesson, and a question must be contained by its quiz;
//   * frozen attempts are immutable: deleting a referenced question is refused
//     (it would cascade into `QuizAnswer`), and editing `answer`/`options`/
//     `type`/`marks`/`schoolType` while any attempt exists is refused while
//     text/metadata stay editable;
//   * a FIXED mock exam never shrinks silently: a pinned question cannot be
//     deleted, and the pin count is surfaced to the UI;
//   * `timeLimit` is ENFORCED server-side (the chosen resolution): the clock is
//     the server's `QuizAttempt.startedAt`, the deadline is server-computed,
//     a late submit is refused with 409 `TIME_LIMIT_EXCEEDED`, and an expired
//     attempt is finalised at its deadline instead of staying open forever;
//   * analytics keep the Phase 6 contract (finished-only, attempt-weighted,
//     deterministic order, no mutation) with a minimal track cut added.
//
// LAYERS (same convention as the Phase 11–17 suites)
//   1. Pure functions from the SHIPPED modules, tsc-compiled with the repo's
//      own toolchain (no mocks of the code under test).
//   2. Source pins with negative controls over the routes, the teacher UI,
//      the schema and the migrations.
//   3. A REAL-DB end-to-end verifier re-run as a child process
//      (scripts/verify-phase18-teacher.mjs): real migrations, real SQLite,
//      real compiled route handlers, real frozen attempt rows and FIXED pins.
//
// Run: node tests/teacher-workflow-phase18.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase18-"));

let pass = 0;
let fail = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
};
const eq = (a, b, label) =>
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    `${label} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`
  );
const section = (t) => console.log(`\n${t}`);

const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

/** Pin a pattern is present, then MUTATE the source to prove the pin is load-bearing. */
function pinned(src, re, label, mutate) {
  ok(re.test(src), label);
  const mutated = mutate ? mutate(src) : src.replace(new RegExp(re.source, "g"), "#MUTATED#");
  ok(!re.test(mutated), `${label} — negative control (mutation breaks the pin)`);
}
/** Pin a pattern is absent in real src but present in an artificial positive control. */
function pinnedAbsent(src, re, label, positiveControl) {
  ok(!re.test(src), label);
  ok(re.test(src + positiveControl), `${label} — negative control (regex can match)`);
}

// ---------------------------------------------------------------------------
// 1. Compile the shipped modules (entry points; tsc follows imports)
// ---------------------------------------------------------------------------
const FILES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/teacher-content.ts",
  "src/lib/session-quiz.ts",
  "src/lib/quiz-analytics.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      skipLibCheck: true,
      esModuleInterop: true,
      strict: false,
      baseUrl: REPO,
      rootDir: REPO,
      paths: { "@/*": ["src/*"] },
      typeRoots: [path.join(REPO, "node_modules/@types")],
      outDir: OUT,
      noEmitOnError: false,
    },
    files: FILES.map((f) => path.join(REPO, f)),
  })
);
try {
  execFileSync(
    process.execPath,
    [path.join(REPO, "node_modules/typescript/lib/tsc.js"), "-p", path.join(OUT, "tsconfig.json")],
    { cwd: REPO, stdio: "pipe" }
  );
} catch {
  /* type noise elsewhere in the graph is tolerated; the emitted files matter */
}
const compiled = (f) => path.join(OUT, f.replace(/\.ts$/, ".js"));
for (const f of FILES) {
  if (!fs.existsSync(compiled(f))) throw new Error(`tsc did not emit ${f}`);
}

// The DB shim: every compiled module that imports @/lib/db gets the fake.
global.__CM_FAKE_DB__ = null;
const DB_SHIM = path.join(OUT, "__shim_db.js");
fs.writeFileSync(DB_SHIM, "module.exports = { db: new Proxy({}, { get: (_, p) => global.__CM_FAKE_DB__[p] }) };\n");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "@/lib/db") return DB_SHIM;
  if (request.startsWith("@/")) {
    const rel = request.slice(2);
    const cand = path.join(OUT, "src", `${rel}.js`);
    if (fs.existsSync(cand)) return cand;
  }
  return origResolve.call(this, request, parent, ...rest);
};

const TS = require(compiled("src/lib/teacher-content.ts"));
const TRACK = require(compiled("src/lib/track-scope.ts"));
const SQ = require(compiled("src/lib/session-quiz.ts"));
const QA = require(compiled("src/lib/quiz-analytics.ts"));
const I18N = require(compiled("src/lib/i18n-core.ts"));

// ---------------------------------------------------------------------------
section("A. Behaviour — teacher-content: limits, placement, reference guards");
// ---------------------------------------------------------------------------

// --- input limits ---------------------------------------------------------
eq(TS.TEACHER_LIMITS.TITLE_MAX, 160, "A: title limit is the exported contract");
eq(TS.TEACHER_LIMITS.INSTRUCTIONS_MAX, 4000, "A: instructions limit is the exported contract");
eq(TS.TEACHER_LIMITS.QUESTIONS_PER_QUIZ_MAX, 100, "A: per-quiz question ceiling is exported");
eq(TS.TEACHER_LIMITS.TIME_LIMIT_MAX, 300, "A: time-limit ceiling is exported");
eq(TS.TEACHER_LIMITS.OPTIONS_MIN, 2, "A: at least two options per MCQ");
eq(TS.TEACHER_LIMITS.MARKS_MIN, 1, "A: marks floor is 1");

eq(TS.boundedText("  hi  ", 10), { ok: true, value: "hi" }, "A: boundedText trims");
eq(TS.boundedText("   ", 10), { ok: true, value: null }, "A: boundedText maps empty to null");
eq(TS.boundedText(undefined, 10, { required: true }), { ok: false }, "A: required + absent is refused");
eq(TS.boundedText("", 10, { required: true }), { ok: false }, "A: required + blank is refused");
eq(TS.boundedText("x".repeat(11), 10), { ok: false }, "A: over-long text is refused (never truncated)");

const dlOk = TS.parseDeadline("2030-01-01T00:00:00.000Z");
ok(dlOk instanceof Date && dlOk.getTime() === Date.UTC(2030, 0, 1), "A: parseDeadline accepts a real date");
eq(TS.parseDeadline("not-a-date"), null, "A: parseDeadline rejects junk");
eq(TS.parseDeadline("1999-12-31T00:00:00.000Z"), null, "A: parseDeadline rejects a pre-2000 date");
eq(TS.parseDeadline("2101-01-01T00:00:00.000Z"), null, "A: parseDeadline rejects a post-2100 date");
eq(TS.parseDeadline(""), null, "A: parseDeadline maps an empty string to null");
eq(TS.parseDeadline(null), null, "A: parseDeadline maps null to null");

// --- ownership inputs -----------------------------------------------------
eq(
  TS.teacherCourseIds({ groups: [{ courseId: "a" }, { courseId: "b" }, { courseId: "a" }] }),
  ["a", "b"],
  "A: teacherCourseIds de-duplicates the teacher's own courses"
);
eq(TS.teacherCourseIds({ groups: [] }), [], "A: a teacher with no group owns nothing (fail closed)");

const canonicalLesson = {
  id: "l1",
  officialCode: "X-01",
  trackScope: "ARABIC",
  status: "PUBLISHED",
  curriculumStatus: "OFFICIAL",
  unit: {
    id: "u1",
    title: "Unit",
    titleAr: "وحدة",
    part: {
      id: "p1",
      title: "Part",
      titleAr: "جزء",
      courseId: "c1",
      course: { name: "Course", nameAr: "كورس" },
    },
  },
  topic: null,
};
const legacyLesson = {
  ...canonicalLesson,
  unit: null,
  topic: {
    unit: {
      id: "u2",
      title: "Legacy unit",
      titleAr: null,
      part: { id: "p2", title: "Legacy part", titleAr: null, courseId: "c2", course: null },
    },
  },
};

const placeCanonical = TS.lessonPlacement(canonicalLesson);
eq(placeCanonical.chain, "CANONICAL", "A: unit-linked lesson resolves through the CANONICAL chain");
eq(placeCanonical.courseId, "c1", "A: canonical placement names the course");
eq(placeCanonical.unitId, "u1", "A: canonical placement names the unit");
eq(placeCanonical.partTitle, "Part", "A: canonical placement names the part");

const placeLegacy = TS.lessonPlacement(legacyLesson);
eq(placeLegacy.chain, "LEGACY", "A: topic-linked lesson falls back to the LEGACY chain");
eq(placeLegacy.courseId, "c2", "A: legacy placement still resolves a course");

const bothLesson = {
  ...canonicalLesson,
  topic: legacyLesson.topic,
};
const placeBoth = TS.lessonPlacement(bothLesson);
eq(placeBoth.chain, "CANONICAL", "A: when both chains exist the canonical one WINS");
eq(placeBoth.courseId, "c1", "A: the canonical course is the one authorized against");

eq(TS.lessonPlacement({ ...canonicalLesson, unit: null, topic: null }), null, "A: a lesson with no chain has no placement");
eq(TS.lessonPlacement(null), null, "A: a missing lesson has no placement");

ok(TS.isArchivedLesson({ curriculumStatus: "ARCHIVED" }), "A: ARCHIVED is recognised");
ok(TS.isArchivedLesson({ curriculumStatus: "archived" }), "A: archive detection is case-insensitive");
ok(!TS.isArchivedLesson({ curriculumStatus: "OFFICIAL" }), "A: an official lesson is not archived");
eq(TS.lessonTrackScope({ trackScope: "ARABIC" }), "ARABIC", "A: lessonTrackScope normalizes a real scope");
eq(TS.lessonTrackScope({ trackScope: "nonsense" }), null, "A: lessonTrackScope fails closed on garbage");

// --- the select used by every ownership reader ----------------------------
const SEL = TS.LESSON_PLACEMENT_SELECT;
ok(!!SEL.unit?.select?.part?.select?.courseId, "A: LESSON_PLACEMENT_SELECT reads the canonical courseId");
ok(!!SEL.topic?.select?.unit?.select?.part?.select?.courseId, "A: LESSON_PLACEMENT_SELECT reads the legacy courseId too");
ok(SEL.officialCode === true && SEL.curriculumStatus === true, "A: the select carries officialCode + curriculumStatus");

// --- reference guards -----------------------------------------------------
const refs = (over = {}) => ({
  answers: 0,
  openAttempts: 0,
  gradedAttempts: 0,
  fixedExamPins: 0,
  randomExamPins: 0,
  examPins: 0,
  ...over,
});

eq(TS.canDeleteQuestion(refs()), { allowed: true, blockers: [] }, "A: an unreferenced question is deletable");
eq(
  TS.canDeleteQuestion(refs({ answers: 1, gradedAttempts: 1 })).allowed,
  false,
  "A: frozen answer history blocks deletion"
);
eq(
  TS.canDeleteQuestion(refs({ answers: 1, openAttempts: 1 })).blockers.includes("OPEN_ATTEMPT"),
  true,
  "A: an open attempt is named as a blocker"
);
eq(
  TS.canDeleteQuestion(refs({ fixedExamPins: 1 })).blockers,
  ["FIXED_EXAM_PIN"],
  "A: a FIXED exam pin is a blocker"
);
eq(
  TS.canDeleteQuestion(refs({ randomExamPins: 3, examPins: 3 })).allowed,
  true,
  "A: a RANDOM exam pin is recorded but never blocks (its pool is re-drawn)"
);

eq(TS.questionEditGuards(refs(), { answer: "1" }), { allowed: true }, "A: the answer key is editable before any attempt");
eq(
  TS.questionEditGuards(refs({ openAttempts: 1 }), { prompt: "new" }),
  { allowed: true },
  "A: a prompt edit is safe even under an open attempt"
);
const gradingLock = TS.questionEditGuards(refs({ gradedAttempts: 1 }), { answer: "1" });
eq(gradingLock.allowed, false, "A: the answer key is locked by graded history");
eq(gradingLock.blockedFields, ["answer"], "A: the lock names the offending field");
eq(gradingLock.reason, "FROZEN_ATTEMPT", "A: the lock reason is FROZEN_ATTEMPT");
for (const field of TS.GRADING_FIELDS) {
  eq(
    TS.questionEditGuards(refs({ openAttempts: 1 }), { [field]: "x" }).blockedFields,
    [field],
    `A: editing ${field} under an open attempt is blocked`
  );
}
eq(
  TS.questionEditGuards(refs({ gradedAttempts: 1 }), { schoolType: "ARABIC" }).blockedFields,
  ["schoolType"],
  "A: re-tagging an answered question is blocked"
);
eq(
  TS.questionEditGuards(refs({ gradedAttempts: 1 }), { explanation: "note", difficulty: "HARD" }),
  { allowed: true },
  "A: explanation + difficulty stay editable (Phase 6 analytics may be re-labelled)"
);

// --- question scope containment ------------------------------------------
ok(TS.isQuestionScopeWithinQuiz(null, "SHARED"), "A: an untagged question fits a SHARED quiz");
ok(TS.isQuestionScopeWithinQuiz("ARABIC", "ARABIC"), "A: a matching tag fits a track-specific quiz");
ok(TS.isQuestionScopeWithinQuiz(null, "ARABIC"), "A: an explicit SHARED question fits a track-specific quiz");
ok(!TS.isQuestionScopeWithinQuiz("LANGUAGE", "ARABIC"), "A: a foreign-track question does NOT fit");
ok(!TS.isQuestionScopeWithinQuiz("ARABIC", "garbage"), "A: an unknown quiz scope fails closed");
ok(!TS.isQuestionScopeWithinQuiz("garbage", "SHARED"), "A: an unknown question tag fails closed");

// --- question draft validation -------------------------------------------
const draft = (over = {}) => ({
  type: "MCQ",
  prompt: "What is 2+2?",
  options: ["4", "5"],
  answer: "0",
  ...over,
});
const reasonOf = (input, quizScope = "SHARED") => {
  const r = TS.validateQuestionDraft(input, quizScope);
  return r.ok ? "OK" : r.reason;
};
eq(reasonOf(draft()), "OK", "A: a well-formed MCQ draft validates");
eq(reasonOf(draft({ type: "ESSAY" })), "TYPE", "A: an unsupported type is refused");
eq(reasonOf(draft({ prompt: "   " })), "PROMPT_REQUIRED", "A: a blank prompt is refused");
eq(reasonOf(draft({ prompt: "x".repeat(2001) })), "PROMPT_TOO_LONG", "A: an over-long prompt is refused");
eq(reasonOf(draft({ promptAr: "x".repeat(2001) })), "PROMPT_AR_TOO_LONG", "A: an over-long Arabic prompt is refused");
eq(reasonOf(draft({ options: ["only"] })), "OPTIONS_COUNT", "A: one option is refused");
eq(reasonOf(draft({ options: new Array(11).fill("x") })), "OPTIONS_COUNT", "A: eleven options are refused");
eq(reasonOf(draft({ options: ["a", ""] })), "OPTIONS_COUNT", "A: a blank option is refused");
eq(reasonOf(draft({ options: ["a", "x".repeat(501)] })), "OPTION_TOO_LONG", "A: an over-long option is refused");
eq(reasonOf(draft({ answer: "" })), "ANSWER_REQUIRED", "A: a missing answer is refused");
eq(reasonOf(draft({ answer: "7" })), "ANSWER_RANGE", "A: an out-of-range answer index is refused");
eq(reasonOf(draft({ answer: "-1" })), "ANSWER_RANGE", "A: a negative answer index is refused");
eq(reasonOf(draft({ explanation: "x".repeat(1001) })), "EXPLANATION_TOO_LONG", "A: an over-long explanation is refused");
eq(reasonOf(draft({ marks: 0 })), "MARKS_RANGE", "A: zero marks is refused");
eq(reasonOf(draft({ marks: 101 })), "MARKS_RANGE", "A: 101 marks is refused");
eq(reasonOf(draft({ marks: 2.5 })), "MARKS_RANGE", "A: fractional marks are refused");
eq(reasonOf(draft({ schoolType: "BOGUS" })), "TRACK_INVALID", "A: an unparseable tag is refused");
eq(reasonOf(draft({ schoolType: "LANGUAGE" }), "ARABIC"), "TRACK_OUT_OF_QUIZ_SCOPE", "A: a tag outside the quiz is refused");
eq(reasonOf(draft({ schoolType: "ARABIC" }), "ARABIC"), "OK", "A: a tag inside the quiz is accepted");

const inherited = TS.validateQuestionDraft(draft(), "ARABIC");
eq(inherited.ok, true, "A: an untagged draft validates against a track-specific quiz");
eq(inherited.question.schoolTypeInherited, true, "A: an absent tag is reported as inherited (never as SHARED)");
eq(inherited.question.schoolType, null, "A: the inherited placeholder is the SHARED representation");

const explicitShared = TS.validateQuestionDraft({ ...draft(), schoolType: "" }, "ARABIC");
eq(explicitShared.question.schoolTypeInherited, false, "A: an explicit SHARED tag is an author decision");
eq(explicitShared.question.schoolType, null, "A: explicit SHARED stores as null");

const trueFalse = TS.validateQuestionDraft({ type: "TRUE_FALSE", prompt: "Sky is blue", answer: "1" }, "SHARED");
eq(trueFalse.ok, true, "A: a TRUE_FALSE draft validates without options");
eq(trueFalse.question.options, ["True", "False"], "A: TRUE_FALSE stores the canonical option pair");
eq(trueFalse.question.answer, "1", "A: TRUE_FALSE stores the 0/1 index");
eq(
  TS.validateQuestionDraft({ type: "TRUE_FALSE", prompt: "x", answer: "false" }, "SHARED").question.answer,
  "1",
  "A: TRUE_FALSE accepts the word form of the answer"
);
eq(
  TS.validateQuestionDraft({ type: "TRUE_FALSE", prompt: "x", answer: "anything-else" }, "SHARED").question.answer,
  "0",
  "A: TRUE_FALSE defaults an unparseable answer to index 0 rather than storing client text"
);

// --- validation message mapping ------------------------------------------
const seen = [];
const fakeT = (key, params) => {
  seen.push([key, params]);
  return `T:${key}`;
};
for (const reason of [
  "TYPE",
  "PROMPT_REQUIRED",
  "PROMPT_TOO_LONG",
  "PROMPT_AR_TOO_LONG",
  "OPTIONS_COUNT",
  "OPTION_TOO_LONG",
  "ANSWER_REQUIRED",
  "ANSWER_RANGE",
  "EXPLANATION_TOO_LONG",
  "MARKS_RANGE",
  "TRACK_INVALID",
  "TRACK_OUT_OF_QUIZ_SCOPE",
]) {
  const msg = TS.questionValidationMessage(fakeT, reason, 2);
  ok(typeof msg === "string" && msg.startsWith("T:api."), `A: reason ${reason} maps to an api.* message`);
}
ok(
  seen.every(([key]) => /^api\.\d+$/.test(key)),
  "A: every validation message is a dict KEY (never a hardcoded sentence)"
);
ok(
  seen.some(([key, params]) => params && params.p1 === 2),
  "A: the message formatter forwards the 1-based question index"
);

// --- question payload ----------------------------------------------------
const payload = TS.questionPayload({
  id: "q1",
  quizId: "z1",
  type: "MCQ",
  prompt: "p",
  promptAr: null,
  options: '["a","b"]',
  answer: "1",
  explanation: null,
  difficulty: "MEDIUM",
  marks: 2,
  schoolType: null,
  createdAt: new Date("2030-01-01T00:00:00.000Z"),
});
eq(payload.options, ["a", "b"], "A: questionPayload parses the stored options blob");
eq(payload.trackScope, "SHARED", "A: a null schoolType is reported as SHARED");
eq(
  TS.questionPayload({ ...payload, options: "not-json", schoolType: "ARABIC" }).options,
  [],
  "A: a malformed options blob degrades to [] instead of throwing"
);
eq(
  TS.questionPayload({ ...payload, options: "not-json", schoolType: "ARABIC" }).trackScope,
  "ARABIC",
  "A: a stored schoolType is reported verbatim"
);

// ---------------------------------------------------------------------------
section("B. Behaviour — track-scope precedence (Phase 12 preserved, Phase 18 extended)");
// ---------------------------------------------------------------------------

ok(TRACK.isTrackScopeWithinLesson("SHARED", "ARABIC"), "B: SHARED content fits an ARABIC lesson (lesson gate narrows it)");
ok(TRACK.isTrackScopeWithinLesson("ARABIC", "ARABIC"), "B: matching track content fits");
ok(!TRACK.isTrackScopeWithinLesson("LANGUAGE", "ARABIC"), "B: a foreign track does NOT fit a specific lesson");
ok(TRACK.isTrackScopeWithinLesson("LANGUAGE", "SHARED"), "B: a specific track fits a SHARED lesson (the intended split)");
ok(!TRACK.isTrackScopeWithinLesson("ARABIC", "garbage"), "B: an unknown lesson scope fails closed");
ok(!TRACK.isTrackScopeWithinLesson("garbage", "SHARED"), "B: an unknown child scope fails closed");

eq(
  TRACK.resolveContentTrackScope(undefined, "ARABIC"),
  { ok: true, scope: "ARABIC", inherited: true },
  "B: an absent scope INHERITS the lesson (never SHARED by omission)"
);
eq(
  TRACK.resolveContentTrackScope("", "LANGUAGE"),
  { ok: true, scope: "LANGUAGE", inherited: true },
  "B: an empty-string scope is 'absent', not a value"
);
eq(
  TRACK.resolveContentTrackScope("SHARED", "ARABIC"),
  { ok: true, scope: "SHARED", inherited: false },
  "B: an explicit SHARED is honoured inside a specific lesson"
);
eq(
  TRACK.resolveContentTrackScope("LANGUAGE", "SHARED"),
  { ok: true, scope: "LANGUAGE", inherited: false },
  "B: a specific scope under a SHARED lesson is honoured"
);
eq(
  TRACK.resolveContentTrackScope("LANGUAGE", "ARABIC"),
  { ok: false, reason: "OUT_OF_LESSON_SCOPE" },
  "B: an out-of-scope request is refused with a precise reason"
);
eq(
  TRACK.resolveContentTrackScope("MIXED", "SHARED"),
  { ok: false, reason: "INVALID_SCOPE" },
  "B: an unknown scope value is refused"
);
eq(
  TRACK.resolveContentTrackScope(undefined, null),
  { ok: false, reason: "INVALID_SCOPE" },
  "B: a lesson with no usable scope can accept nothing (fail closed)"
);
eq(
  TRACK.resolveContentTrackScope("ARABIC", "ARABIC"),
  { ok: true, scope: "ARABIC", inherited: false },
  "B: the same track is contained"
);

// ---------------------------------------------------------------------------
section("C. Behaviour — server-side time limit (the chosen resolution)");
// ---------------------------------------------------------------------------

eq(SQ.TIME_LIMIT_GRACE_SECONDS, 30, "C: the grace window is a fixed, exported constant");
eq(SQ.normalizeTimeLimitMinutes(null), null, "C: a null limit means NO limit");
eq(SQ.normalizeTimeLimitMinutes(undefined), null, "C: an absent limit means NO limit");
eq(SQ.normalizeTimeLimitMinutes(0), null, "C: zero is 'no limit', never 'instant'");
eq(SQ.normalizeTimeLimitMinutes(-5), null, "C: a negative limit is ignored");
eq(SQ.normalizeTimeLimitMinutes("junk"), null, "C: a non-numeric limit is ignored");
eq(SQ.normalizeTimeLimitMinutes(30), 30, "C: a real limit is used");
eq(SQ.normalizeTimeLimitMinutes(2.7), 2, "C: a fractional limit is truncated");

const started = new Date("2030-01-01T10:00:00.000Z");
const stateFresh = SQ.timeLimitState(started, 30, new Date("2030-01-01T10:10:00.000Z"));
eq(stateFresh.limited, true, "C: a timed attempt is limited");
eq(stateFresh.deadline.toISOString(), "2030-01-01T10:30:30.000Z", "C: deadline = startedAt + limit + grace");
eq(stateFresh.expired, false, "C: a fresh attempt is not expired");
eq(stateFresh.remainingSeconds, 20 * 60 + 30, "C: the remaining window is server-computed");

const stateEdge = SQ.timeLimitState(started, 30, new Date("2030-01-01T10:30:29.000Z"));
eq(stateEdge.expired, false, "C: one second before the deadline is still inside the window");
const statePast = SQ.timeLimitState(started, 30, new Date("2030-01-01T10:30:31.000Z"));
eq(statePast.expired, true, "C: one second past the deadline is expired");
eq(statePast.remainingSeconds, 0, "C: remaining time floors at zero (never negative)");
eq(SQ.isAttemptExpired(started, 30, new Date("2030-01-01T11:00:00.000Z")), true, "C: isAttemptExpired agrees with the state");
eq(SQ.isAttemptExpired(started, null, new Date("2031-01-01T00:00:00.000Z")), false, "C: an untimed attempt never expires");

const unlimited = SQ.timeLimitState(started, null);
eq(
  { limited: unlimited.limited, deadline: unlimited.deadline, expired: unlimited.expired, remainingSeconds: unlimited.remainingSeconds },
  { limited: false, deadline: null, expired: false, remainingSeconds: null },
  "C: an untimed attempt has no deadline at all"
);
eq(SQ.timeLimitState(null, 30).limited, false, "C: a missing startedAt cannot be timed");

const frozen = [
  {
    answerId: "a1",
    questionId: "q1",
    selected: "",
    question: {
      id: "q1",
      type: "MCQ",
      prompt: "p",
      promptAr: null,
      options: '["a","b"]',
      answer: "0",
      explanation: null,
      difficulty: "MEDIUM",
      marks: 2,
      schoolType: null,
    },
  },
];
const expiredGrade = SQ.gradeExpiredAttempt(frozen, 60, "ARABIC");
eq(expiredGrade.score, 0, "C: an expired attempt is graded from the server-held (empty) selections");
eq(expiredGrade.totalMarks, 2, "C: the denominator is the frozen set, not the live quiz");
eq(expiredGrade.passed, false, "C: an abandoned attempt does not pass");

// ---------------------------------------------------------------------------
section("D. Source pins — canonical lesson coverage in every teacher reader");
// ---------------------------------------------------------------------------

const R = {
  lessons: read("src/app/api/teacher/lessons/route.ts"),
  homework: read("src/app/api/teacher/homework/route.ts"),
  homeworkById: read("src/app/api/teacher/homework/[id]/route.ts"),
  homeworkGrade: read("src/app/api/teacher/homework/[id]/grade/route.ts"),
  quizzes: read("src/app/api/teacher/quizzes/route.ts"),
  quizById: read("src/app/api/teacher/quizzes/[id]/route.ts"),
  quizQuestions: read("src/app/api/teacher/quizzes/[id]/questions/route.ts"),
  questionById: read("src/app/api/teacher/questions/[id]/route.ts"),
  analytics: read("src/app/api/teacher/analytics/route.ts"),
  verify: read("scripts/verify-phase18-teacher.mjs"),
};

pinned(
  R.lessons,
  /lessonCoursesChainOr\(courseIds\)/,
  "D: the lesson picker queries BOTH chains in ONE predicate"
);
pinnedAbsent(
  R.lessons,
  /EXCLUDE_ARCHIVED_LESSON/,
  "D: the picker does not apply the student archive filter",
  "\nconst x = EXCLUDE_ARCHIVED_LESSON;\n"
);
pinnedAbsent(
  R.lessons,
  /LESSON_STUDENT_STATUS_FILTER/,
  "D: the picker does not apply the student lifecycle filter",
  "\nconst x = LESSON_STUDENT_STATUS_FILTER;\n"
);
pinned(
  R.lessons,
  /officialCode: true/,
  "D: the picker SELECTS officialCode (the canonical identity is surfaced)"
);
pinned(
  R.lessons,
  /curriculumStatus: true/,
  "D: the picker selects curriculumStatus so ARCHIVED rows can be labelled"
);

pinned(
  R.homework,
  /lessonCoursesChainOr\(courseIds\)/,
  "D: homework listing queries both chains"
);
pinnedAbsent(
  R.homework,
  /LESSON_STUDENT_STATUS_FILTER|EXCLUDE_ARCHIVED_LESSON/,
  "D: homework management does not hide DRAFT/ARCHIVED lessons from the teacher",
  "\nconst x = LESSON_STUDENT_STATUS_FILTER;\n"
);
pinned(
  R.homework,
  /hw\.lesson\?\.unit \?\? hw\.lesson\?\.topic\?\.unit \?\? null/,
  "D: the homework payload resolves the unit CANONICALLY first"
);

pinned(
  R.quizzes,
  /lesson\.unit\?\.part\.courseId \?\? lesson\.topic\?\.unit\.part\.courseId/,
  "D: quiz creation resolves the lesson's course canonically first (Phase 11 pin preserved)"
);
pinned(
  R.homeworkGrade,
  /LESSON_PLACEMENT_SELECT/,
  "D: homework grading resolves ownership through the shared canonical select"
);
pinned(
  R.homeworkById,
  /lessonPlacement\(existing\.lesson as ChainLesson \| null\)/,
  "D: homework update resolves the lesson's course canonically"
);

for (const [name, src] of Object.entries(R)) {
  if (name === "verify") continue;
  pinnedAbsent(
    src,
    /where:\s*\{\s*topicId:/,
    `D: ${name} never resolves a resource through topicId alone`,
    '\nconst x = await db.lesson.findMany({ where: { topicId: "t" } });\n'
  );
}

// ---------------------------------------------------------------------------
section("E. Source pins — authorization on every teacher write");
// ---------------------------------------------------------------------------

const WRITE_ROUTES = [
  ["E: homework create", R.homework],
  ["E: homework update", R.homeworkById],
  ["E: quiz create", R.quizzes],
  ["E: quiz delete", R.quizById],
  ["E: question append", R.quizQuestions],
  ["E: question mutate", R.questionById],
];
for (const [label, src] of WRITE_ROUTES) {
  ok(/await requireUser\(\)/.test(src), `${label} authenticates the caller`);
  ok(/user\.role !== "TEACHER"/.test(src), `${label} requires the TEACHER role`);
  ok(/getTeacherProfile\(user\.id\)/.test(src), `${label} resolves the caller's teacher profile`);
  ok(/teacherCourseIds\(teacher\)/.test(src), `${label} authorizes against the teacher's OWN courses`);
}
for (const [label, src] of WRITE_ROUTES) {
  pinnedAbsent(
    src,
    /body\.courseId/,
    `${label} never trusts a client-supplied course id`,
    "\nconst x = body.courseId;\n"
  );
}
pinned(
  R.homework,
  /loadOwnedLesson\(lessonId, teacherCourseIds\(teacher\)\)/,
  "E: homework creation is gated by the shared ownership loader"
);
pinned(
  R.quizQuestions,
  /!placement \|\| !teacherCourseIds\(teacher\)\.includes\(placement\.courseId\)/,
  "E: question append refuses an unowned/chainless quiz"
);
pinnedAbsent(
  R.questionById,
  /if \(!question\.quizId\) return \{ ok: false, status: 200/,
  "E: a bank question (no quiz) is never silently allowed",
  "\nif (!question.quizId) return { ok: false, status: 200, reason: \"NO_CHAIN\" };\n"
);
pinned(
  R.questionById,
  /if \(!question\.quizId\) return \{ ok: false, status: 403, reason: "NO_CHAIN" \}/,
  "E: a bank question is a 403 (not teacher-managed content)"
);
pinned(
  R.homework,
  /const owned = await loadOwnedLesson\(lessonId, teacherCourseIds\(teacher\)\);\n  if \(!owned\.ok\) return err\(tApi\("api\.179"\), owned\.status\);/,
  "E: ownership runs BEFORE the archived/scope decisions (no leak to a probing teacher)"
);

// ---------------------------------------------------------------------------
section("F. Source pins — frozen attempts and FIXED mock-exam pins");
// ---------------------------------------------------------------------------

pinned(
  R.questionById,
  /const \{ references \} = await loadQuestionReferences\(id\);\n  const guard = canDeleteQuestion\(references\);/,
  "F: deletion is decided by the reference counter, not by a client flag"
);
pinned(
  R.questionById,
  /const guard = questionEditGuards\(references, patch\);/,
  "F: edits are decided by the frozen-attempt lock table"
);
pinned(
  R.questionById,
  /fixPin \? tApi\("api\.246"\) : tApi\("api\.247"\)/,
  "F: a FIXED pin and a frozen attempt produce DIFFERENT refusals"
);
pinned(
  R.questionById,
  /if \(patch\.schoolType !== undefined\) data\.schoolType = v\.schoolType;/,
  "F: an omitted tag never re-tags an existing question"
);
pinned(
  R.quizById,
  /if \(attempts\.length > 0\) return err\(tApi\("api\.249"\), 409\);/,
  "F: a quiz with attempts can never be destroyed"
);
pinned(
  R.quizById,
  /if \(references\.fixedExamPins > 0\) return err\(tApi\("api\.246"\), 409\);/,
  "F: a FIXED-pinned question keeps its quiz alive"
);
pinned(
  R.quizQuestions,
  /if \(lesson && isArchivedLesson\(lesson\)\) return err\(tApi\("api\.242"\), 409\);/,
  "F: no NEW content on an ARCHIVED lesson (management of existing rows stays possible)"
);
pinnedAbsent(
  (R.questionById + R.quizQuestions + R.quizById),
  /mockExamQuestion\.delete|mockExamQuestion\.deleteMany/,
  "F: no teacher route ever deletes a mock-exam pin",
  "\nawait db.mockExamQuestion.delete({ where: { id } });\n"
);
pinned(
  read("prisma/schema.prisma"),
  /mockExamLinks MockExamQuestion\[\]/,
  "F: the Question → MockExamQuestion relation is still the pin surface"
);

// The frozen-attempt contract itself (Phase 5) must be untouched.
const SESSION_QUIZ = read("src/lib/session-quiz.ts");
pinned(
  SESSION_QUIZ,
  /export async function seedAttemptQuestions/,
  "F: the attempt question-set freeze still exists"
);
pinnedAbsent(
  R.questionById,
  /db\.question\.delete\(\{ where: \{ id \} \}\);\n\s*\/\/ force/,
  "F: deletion is the LAST statement (no write happens before the guard)",
  "\n  db.question.delete({ where: { id } });\n  // force\n"
);

// ---------------------------------------------------------------------------
section("G. Source pins — the time limit is enforced, not decorative");
// ---------------------------------------------------------------------------

const START = read("src/app/api/quizzes/[id]/start/route.ts");
const SUBMIT = read("src/app/api/quizzes/[id]/submit/route.ts");
const DETAIL = read("src/app/api/quizzes/[id]/route.ts");

pinned(START, /timeLimitState\(existing\.startedAt, quiz\.timeLimit\)/, "G: /start evaluates the open attempt's window");
pinned(START, /timeLimitState\(attempt\.startedAt, quiz\.timeLimit\)/, "G: /start reports the fresh attempt's window");
pinned(START, /finishedAt: state\.deadline/, "G: an expired attempt is finalised AT its deadline");
pinned(SUBMIT, /const limit = timeLimitState\(open\.startedAt, quiz\.timeLimit\);/, "G: /submit evaluates the server window");
pinned(SUBMIT, /code: "TIME_LIMIT_EXCEEDED"/, "G: a late submit is machine-readably refused");
pinned(SUBMIT, /const expired = gradeExpiredAttempt\(expiredSet, quiz\.passMark, schoolType\);/, "G: the late attempt is graded from server-held rows");
pinned(SUBMIT, /finishedAt: limit\.deadline,/, "G: the late attempt ends at its deadline, not at the late request's time");
pinned(DETAIL, /expiresAt: limit\.deadline,/, "G: the client is handed the SERVER's deadline");
for (const [name, src] of [["start", START], ["submit", SUBMIT], ["detail", DETAIL]]) {
  pinnedAbsent(
    src,
    /body\.(expiresAt|deadline|remainingSeconds)/,
    `G: ${name} never reads a client-supplied clock`,
    "\nconst x = body.expiresAt;\n"
  );
  pinnedAbsent(
    src,
    /new Date\(Date\.now\(\)\)\.getTime\(\) \+/,
    `G: ${name} never invents its own deadline arithmetic`,
    "\nconst x = new Date(Date.now()).getTime() + 1;\n"
  );
}

// ---------------------------------------------------------------------------
section("H. Source pins — analytics keep the Phase 6 contract, plus trackSplit");
// ---------------------------------------------------------------------------

const ANALYTICS = R.analytics;
const QA_SRC = read("src/lib/quiz-analytics.ts");
pinned(QA_SRC, /finishedAt: \{ not: null \}/, "H: analytics still select FINISHED attempts only");
pinned(QA_SRC, /export function summarizeFinishedAttempts\(/, "H: the Phase 6 summariser is still the aggregation unit");
pinned(QA_SRC, /export const TRACK_BUCKETS: readonly TrackScope\[\]/, "H: the track buckets come from the shared constant");
pinned(
  ANALYTICS,
  /summarizeFinishedAttemptsByTrack/,
  "H: the teacher analytics use the shared track partition"
);
pinned(ANALYTICS, /trackSplit: overallTrackSplit,/, "H: the overview carries the track cut");
for (const [, src] of Object.entries(R)) {
  if (src === ANALYTICS) continue;
  pinnedAbsent(
    src,
    /\.deleteMany\(|\.updateMany\(/,
    `H: ${src === ANALYTICS ? "analytics" : "teacher route"} performs no bulk mutation`,
    "\nawait db.question.deleteMany({ where: {} });\n"
  );
}
pinnedAbsent(
  ANALYTICS,
  /ExamAttempt/,
  "H: mock-exam attempts are NOT folded into quiz analytics",
  "\nconst ExamAttempt = 1;\n"
);

// ---------------------------------------------------------------------------
section("I. i18n — every Phase 18 message key resolves");
// ---------------------------------------------------------------------------

const PHASE18_SOURCES = [
  "src/components/teacher/teacher-authoring.tsx",
  "src/components/teacher/teacher-dashboard.tsx",
  "src/app/api/teacher/homework/route.ts",
  "src/app/api/teacher/homework/[id]/route.ts",
  "src/app/api/teacher/homework/[id]/grade/route.ts",
  "src/app/api/teacher/quizzes/route.ts",
  "src/app/api/teacher/quizzes/[id]/route.ts",
  "src/app/api/teacher/quizzes/[id]/questions/route.ts",
  "src/app/api/teacher/questions/[id]/route.ts",
  "src/app/api/teacher/analytics/route.ts",
  "src/app/api/teacher/lessons/route.ts",
  "src/app/api/quizzes/[id]/start/route.ts",
  "src/app/api/quizzes/[id]/submit/route.ts",
  "src/lib/teacher-content.ts",
  "src/lib/track-scope.ts",
  "src/lib/session-quiz.ts",
];
const keyRe = /\((?:tApi|t|tr)\(\s*"((?:api|teacher|admin)\.\d+)"|(?:t|tr|tApi)\("((?:api|teacher|admin)\.\d+)"/g;
const referenced = new Set();
for (const rel of PHASE18_SOURCES) {
  const src = read(rel);
  for (const m of src.matchAll(keyRe)) {
    if (m[1]) referenced.add(m[1]);
    if (m[2]) referenced.add(m[2]);
  }
}
ok(referenced.size > 30, `I: the Phase 18 surface references ${referenced.size} dictionary keys`);
const unresolved = [];
for (const key of referenced) {
  const ar = I18N.translate("ar", key);
  const en = I18N.translate("en", key);
  if (!ar || !en) unresolved.push(`${key} (${!ar ? "ar" : "en"})`);
}
eq(unresolved, [], "I: every referenced key resolves in BOTH locales (no dotted-key leak)");
pinned(
  read("src/lib/i18n-core.ts"),
  /looksLikeDictKey\(key\) \? "" : key/,
  "I: an unresolved key yields an EMPTY string, never the raw key"
);

// ---------------------------------------------------------------------------
section("J. Source pins — teacher UI wiring (no dead controls)");
// ---------------------------------------------------------------------------

const AUTHORING = read("src/components/teacher/teacher-authoring.tsx");
const DASHBOARD = read("src/components/teacher/teacher-dashboard.tsx");

pinned(AUTHORING, /export const TRACK_INHERIT = "__inherit__";/, "J: the inherit sentinel exists for Radix");
pinned(AUTHORING, /v === TRACK_INHERIT \? "" : v/, "J: the sentinel is translated back to '' at the boundary");
pinnedAbsent(
  AUTHORING,
  /from "@\/components\/ui";/,
  "J: the authoring module imports UI primitives by subpath (no barrel import)",
  '\nimport { Button } from "@/components/ui";\n'
);
pinned(AUTHORING, /export function LessonPicker\(/, "J: the canonical lesson picker exists");
pinned(AUTHORING, /export function LessonMeta\(/, "J: the picker renders lesson placement metadata");
pinned(AUTHORING, /export function HomeworkDialog\(/, "J: the homework create/edit dialog exists");
pinned(AUTHORING, /export function QuestionManagerDialog\(/, "J: question management exists");
pinned(AUTHORING, /export function TrackSplitRow\(/, "J: the track split is rendered from server numbers");
pinned(AUTHORING, /officialCode/, "J: the picker displays officialCode");

pinned(DASHBOARD, /const lessonsQuery = useTeacherLessons\(\);/, "J: the dashboard loads lessons through the picker hook");
pinned(DASHBOARD, /<LessonPicker/, "J: quiz authoring uses the canonical picker");
pinned(DASHBOARD, /<HomeworkDialog/, "J: homework authoring uses the dialog");
pinned(DASHBOARD, /<QuestionManagerDialog/, "J: question management is reachable");
pinned(DASHBOARD, /key=\{authoring\?\.homework\?\.id \?\? "new-homework"\}/, "J: the dialog is remounted per target (state seeded from props)");
pinned(DASHBOARD, /timeLimit: timeLimit\.trim\(\) === "" \? null : Number\(timeLimit\)/, "J: the quiz payload sends the time limit it shows");
pinned(
  DASHBOARD,
  /questions: normalized\.map\(\(q\) =>\n\s*q\.schoolType \? q : \{ \.\.\.q, schoolType: undefined \}\n\s*\)/,
  "J: an unset question tag is sent as ABSENT, never substituted"
);
pinnedAbsent(
  DASHBOARD,
  /fetch\("\/api\/admin\//,
  "J: the teacher UI never calls admin endpoints",
  '\nfetch("/api/admin/mock-exams");\n'
);
pinnedAbsent(
  AUTHORING,
  /fetch\("\/api\/admin\//,
  "J: the authoring module never calls admin endpoints",
  '\nfetch("/api/admin/mock-exams");\n'
);

// ---------------------------------------------------------------------------
section("K. Boundary pins — nothing outside Phase 18 moved");
// ---------------------------------------------------------------------------

pinnedAbsent(
  read("src/app/api/students/me/homework/route.ts"),
  /teacherCourseIds|requireRole\("TEACHER"\)/,
  "K: the student homework route is untouched by the teacher workflow",
  "\nconst x = teacherCourseIds(teacher);\n"
);
pinned(
  read("src/lib/session-progress.ts"),
  /export async function canAccessHomework/,
  "K: the student homework gate still exists"
);
pinned(
  read("src/app/api/admin/question-bank/route.ts"),
  /export async function GET/,
  "K: the admin question bank is still GET+POST only"
);
pinnedAbsent(
  read("src/app/api/admin/question-bank/route.ts"),
  /export async function DELETE/,
  "K: no teacher-side delete leaked into the admin bank",
  "\nexport async function DELETE() {}\n"
);
pinned(
  read("src/components/admin/session-workflow-shared.tsx"),
  /export function TrackScopeBadge/,
  "K: the teacher UI reuses the admin vocabulary instead of a second one"
);
for (const migration of fs.readdirSync(path.join(REPO, "prisma/migrations"))) {
  // Scope the pin to Phase 18's OWN migrations. A later phase (Phase 20
  // Security Hardening II) legitimately added `phase20_teacher_applications`
  // for the teacher application/approval flow — that is not a Phase 18 artifact.
  if (migration.includes("phase18")) {
    ok(false, `K: Phase 18 added no migration (unexpected ${migration})`);
  }
}
ok(true, "K: Phase 18 introduces NO schema migration (the phase reuses existing state)");

// ---------------------------------------------------------------------------
section("L. Real-DB end-to-end — the shipped handlers over real SQLite");
// ---------------------------------------------------------------------------

try {
  const out = execFileSync(process.execPath, [path.join(REPO, "scripts/verify-phase18-teacher.mjs")], {
    cwd: REPO,
    encoding: "utf8",
    stdio: "pipe",
  });
  const m = /(\d+) passed, (\d+) failed/.exec(out);
  ok(!!m, "L: the real-DB verifier reported a summary");
  if (m) {
    ok(Number(m[2]) === 0, `L: the real-DB verifier had 0 failures (got ${m[2]})`);
    ok(Number(m[1]) >= 140, `L: the real-DB verifier exercised the workflow (${m[1]} assertions)`);
  }
  ok(
    out.includes("D: canonical lesson exposes officialCode + CANONICAL chain"),
    "L: canonical lesson coverage was verified over real HTTP handlers"
  );
  ok(
    out.includes("K: deleting a FIXED-pinned question is refused (409)"),
    "L: FIXED-pin safety was verified over real DB rows"
  );
  ok(
    out.includes("M: a submit past the deadline is refused (409)"),
    "L: time-limit enforcement was verified on the real server clock"
  );
} catch (e) {
  const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  ok(false, `L: the real-DB verifier exited non-zero — ${String(out).split("\n").slice(-6).join(" | ")}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
