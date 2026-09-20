// CodeMind Academy — Phase H: CANONICAL PROGRESSION & ACCESS ENGINE.
//
// 38 enumerated cases (plus sub-assertions) in four layers, all offline:
//
//   A. PURE MATRIX      — `progression-requirements.ts` compiled and exercised
//                         for real (no database at all).
//   B. BEHAVIOURAL      — the ENGINE (`progression-engine.ts`) compiled with
//                         tsc and run against a fake `@/lib/db` covering every
//                         rule of the phase: video ≥95%, quiz PASS, homework
//                         SUBMISSION, attendance-never-completes, absence-hold
//                         boundary + catch-up, Admin overrides, track
//                         isolation, determinism and reader agreement.
//   C. ADMIN OVERRIDES  — `progression-overrides.ts` exercised for real
//                         (reason required, actor/time/student/lesson, expiry,
//                         role gates, idempotency, no academic fabrication).
//   D. SOURCE INVARIANTS— the shipped routes/services are read and asserted so
//                         the rules stay pinned to the real HTTP surface.
//
// Run: node tests/phase-h-progression.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, like the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

let pass = 0;
let fail = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error(`FAIL ${pass + fail}: ${label}`);
  }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// Compile the Phase H modules to CommonJS in a temp dir.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase-h-"));
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
      path.join(REPO, "src/lib/progression-requirements.ts"),
      path.join(REPO, "src/lib/progression-universe.ts"),
      path.join(REPO, "src/lib/progression-holds.ts"),
      path.join(REPO, "src/lib/progression-overrides.ts"),
      path.join(REPO, "src/lib/progression-engine.ts"),
      path.join(REPO, "src/lib/progression-catchup.ts"),
      path.join(REPO, "src/lib/session-progress.ts"),
      path.join(REPO, "src/lib/progress.ts"),
      path.join(REPO, "src/lib/track-scope.ts"),
      path.join(REPO, "src/lib/school-type.ts"),
      path.join(REPO, "src/lib/enrollment.ts"),
      path.join(REPO, "src/lib/session-lifecycle.ts"),
      path.join(REPO, "src/lib/subscription-entitlement.ts"),
    ],
  })
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch {
  /* type errors in the wider graph are tolerated; emit is what matters */
}
for (const f of [
  "progression-requirements.js",
  "progression-universe.js",
  "progression-holds.js",
  "progression-overrides.js",
  "progression-engine.js",
  "progression-catchup.js",
  "session-progress.js",
]) {
  if (!fs.existsSync(path.join(OUT, f))) throw new Error(`tsc did not emit ${f}`);
}

// ---------------------------------------------------------------------------
// The fake database.
//
//   C1  L1  — no video, no quiz, no homework         (CASE 16: no requirements)
//       L2  — video + quiz(60) + homework            (CASE 17: all three)
//       L3  — quiz only
//       L4  — video only
//   C2  LX  — a LANGUAGE-track lesson (CASE 30/31: cross-track isolation)
// ---------------------------------------------------------------------------
const COURSE = "C1";
const OTHER_COURSE = "C2";
const STUDENT = "S1";
const NOW = new Date("2026-09-20T12:00:00.000Z");

function lesson(id, order, extra = {}) {
  return {
    id,
    order,
    videoUrl: null,
    status: "PUBLISHED",
    curriculumStatus: "LEGACY",
    trackScope: "SHARED",
    unitId: `U:${id}`,
    topicId: null,
    unit: { id: `U:${id}`, order, part: { id: "P1", order: 1, courseId: COURSE } },
    topic: null,
    quizzes: [],
    homeworks: [],
    ...extra,
  };
}

const L1 = lesson("L1", 1);
const L2 = lesson("L2", 2, {
  videoUrl: "https://cdn.example.invalid/L2.mp4",
  quizzes: [{ id: "Q2", passMark: 60, status: "PUBLISHED", trackScope: "SHARED" }],
  homeworks: [{ id: "H2", status: "PUBLISHED", trackScope: "SHARED" }],
});
const L3 = lesson("L3", 3, {
  quizzes: [{ id: "Q3", passMark: 70, status: "PUBLISHED", trackScope: "SHARED" }],
});
const L4 = lesson("L4", 4, { videoUrl: "https://cdn.example.invalid/L4.mp4" });
// A LANGUAGE-track lesson of the student's OWN course: the track slice (not a
// course mismatch) is what must keep it out of the universe.
const LX = lesson("LX", 6, {
  trackScope: "LANGUAGE",
  unitId: "U:LX",
  unit: { id: "U:LX", order: 6, part: { id: "P1", order: 1, courseId: COURSE } },
});
// A lesson of the student's OWN course whose quiz is LANGUAGE-only: it must
// never become a requirement the ARABIC student cannot satisfy (a deadlock).
const LT = lesson("LT", 5, {
  quizzes: [{ id: "QT", passMark: 60, status: "PUBLISHED", trackScope: "LANGUAGE" }],
});
const CATALOGUE = [L1, L2, L3, L4, LX, LT];

const state = {
  schoolType: "ARABIC",
  batchId: "B1",
  batchSchoolType: "ARABIC",
  group: { courseId: COURSE, isActive: true },
  subscription: { status: "ACTIVE", endDate: new Date("2027-01-01T00:00:00.000Z") },
  lessonProgress: {},
  attempts: [],
  submissions: [],
  sessionVideos: [],
  sessionVideoViews: [],
  holds: [],
  overrides: [],
  audit: [],
  quizStatus: {},
  homeworkStatus: {},
};

function reset() {
  state.schoolType = "ARABIC";
  state.batchId = "B1";
  state.batchSchoolType = "ARABIC";
  state.group = { courseId: COURSE, isActive: true };
  state.subscription = { status: "ACTIVE", endDate: new Date("2027-01-01T00:00:00.000Z") };
  state.lessonProgress = {};
  state.attempts = [];
  state.submissions = [];
  state.sessionVideos = [];
  state.sessionVideoViews = [];
  state.holds = [];
  state.overrides = [];
  state.audit = [];
  state.quizStatus = {};
  state.homeworkStatus = {};
}

const byId = (id) => CATALOGUE.find((l) => l.id === id) || null;

function childRows(rows, where) {
  return rows.filter((r) => {
    if (where?.status?.not !== undefined && r.status === where.status.not) return false;
    if (Array.isArray(where?.trackScope?.in) && !where.trackScope.in.includes(r.trackScope || "SHARED"))
      return false;
    return true;
  });
}

function lessonMatches(l, where) {
  if (!where) return true;
  const KNOWN = new Set(["status", "curriculumStatus", "trackScope", "OR", "id", "videoUrl"]);
  for (const key of Object.keys(where)) {
    if (!KNOWN.has(key)) throw new Error(`mock: unsupported lesson where clause '${key}'`);
  }
  if (where.status !== undefined && l.status !== where.status) return false;
  if (where.curriculumStatus?.not !== undefined && l.curriculumStatus === where.curriculumStatus.not)
    return false;
  if (Array.isArray(where.trackScope?.in) && !where.trackScope.in.includes(l.trackScope || "SHARED"))
    return false;
  if (where.videoUrl?.not !== undefined) {
    if (where.videoUrl.not === null) return Boolean(l.videoUrl);
    if (!l.videoUrl) return false;
  }
  if (where.id !== undefined) return l.id === where.id;
  const viaUnit = (courseId) => !!l.unit && l.unit.part.courseId === courseId;
  const viaTopic = (courseId) => !!l.topic && l.topic.unit.part.courseId === courseId;
  if (Array.isArray(where.OR)) {
    return where.OR.some((b) => {
      if (b.unit?.part?.courseId) return viaUnit(b.unit.part.courseId);
      if (b.topic?.unit?.part?.courseId) return viaTopic(b.topic.unit.part.courseId);
      return false;
    });
  }
  return true;
}

function mapLesson(l, select) {
  const out = { id: l.id, order: l.order, videoUrl: l.videoUrl, unitId: l.unitId, topicId: l.topicId };
  if (select?.trackScope) out.trackScope = l.trackScope;
  if (select?.status) out.status = l.status;
  if (select?.curriculumStatus) out.curriculumStatus = l.curriculumStatus;
  if (select?.unit) out.unit = l.unit;
  if (select?.topic) out.topic = l.topic;
  if (select?.quizzes) {
    out.quizzes = childRows(l.quizzes ?? [], select.quizzes.where).map((q) => ({
      id: q.id,
      passMark: q.passMark,
    }));
  }
  if (select?.homeworks) {
    out.homeworks = childRows(l.homeworks ?? [], select.homeworks.where).map((h) => ({ id: h.id }));
  }
  return out;
}

let overrideSeq = 0;
const fakeDb = {
  lesson: {
    findMany: ({ where, select }) => CATALOGUE.filter((l) => lessonMatches(l, where)).map((l) => mapLesson(l, select)),
    findUnique: ({ where, select }) => {
      const l = byId(where.id);
      return l ? mapLesson(l, select) : null;
    },
  },
  student: {
    findUnique: () => ({
      id: STUDENT,
      schoolType: state.schoolType,
      batchId: state.batchId,
      group: state.group,
      subscription: state.subscription,
    }),
  },
  lessonProgress: {
    findMany: ({ where }) =>
      Object.entries(state.lessonProgress)
        .filter(([lessonId]) => where.lessonId.in.includes(lessonId))
        .map(([lessonId, p]) => ({ lessonId, ...p })),
  },
  quizAttempt: {
    findMany: ({ where }) =>
      state.attempts.filter((a) => where.quizId.in.includes(a.quizId)),
  },
  homeworkSubmission: {
    findMany: ({ where }) =>
      state.submissions.filter((s) => where.homeworkId.in.includes(s.homeworkId)),
  },
  sessionVideo: {
    findMany: ({ where }) => {
      let rows = state.sessionVideos.filter(
        (v) => v.isPublished && where.lessonId.in.includes(v.lessonId)
      );
      if (where.batchId) rows = rows.filter((v) => v.batchId === where.batchId);
      if (where.batch?.schoolType) rows = rows.filter(() => where.batch.schoolType === state.batchSchoolType);
      else if (Array.isArray(where.batch?.schoolType?.in) && where.batch.schoolType.in.length === 0)
        rows = [];
      return rows;
    },
  },
  sessionVideoView: {
    findMany: ({ where }) =>
      state.sessionVideoViews.filter((v) => where.sessionVideoId.in.includes(v.sessionVideoId)),
  },
  absenceHold: {
    findMany: ({ where }) => state.holds.filter((h) => h.studentId === where.studentId),
    findFirst: ({ where }) => state.holds.find((h) => h.studentId === where.studentId && h.status === where.status) ?? null,
    update: ({ where, data }) => {
      const row = state.holds.find((h) => h.id === where.id);
      Object.assign(row, data);
      return row;
    },
  },
  liveSession: {
    findMany: ({ where }) => where.id.in.map((id) => ({ id, lessonId: state.sessionLesson?.[id] ?? null })),
  },
  progressionOverride: {
    findMany: ({ where }) =>
      state.overrides.filter((o) => !where.studentId || o.studentId === where.studentId),
    findUnique: ({ where }) => state.overrides.find((o) => o.id === where.id) ?? null,
    create: ({ data }) => {
      overrideSeq += 1;
      const row = { id: `OV${overrideSeq}`, revokedAt: null, ...data };
      state.overrides.push(row);
      return row;
    },
    update: ({ where, data }) => {
      const row = state.overrides.find((o) => o.id === where.id);
      Object.assign(row, data);
      return row;
    },
  },
  auditLog: {
    create: ({ data }) => {
      state.audit.push(data);
      return { id: `A${state.audit.length}`, ...data };
    },
  },
  quiz: {
    findUnique: ({ where }) => {
      const owner = CATALOGUE.find((l) => (l.quizzes ?? []).some((q) => q.id === where.id));
      return owner
        ? { id: where.id, lessonId: owner.id, trackScope: "SHARED", status: state.quizStatus[where.id] ?? "PUBLISHED" }
        : null;
    },
  },
  homework: {
    findUnique: ({ where }) => {
      const owner = CATALOGUE.find((l) => (l.homeworks ?? []).some((h) => h.id === where.id));
      return owner
        ? { id: where.id, lessonId: owner.id, trackScope: "SHARED", status: state.homeworkStatus[where.id] ?? "PUBLISHED" }
        : null;
    },
  },
};

// A fake Phase F authority: the catch-up path MUST delegate here (never write
// a hold itself), and every call is recorded so idempotency can be proven.
const absenceCalls = [];
const fakeAbsenceReview = {
  HOLD_RESOLUTION_CATCH_UP: "CATCH_UP_COMPLETED",
  resolveAbsenceHoldForCatchUp: async (params) => {
    absenceCalls.push({ ...params });
    const hold = state.holds.find(
      (h) => h.studentId === params.studentId && (String(h.status).toUpperCase() === "ACTIVE")
    );
    if (!hold) {
      return { holdId: null, reviewId: null, studentId: null, resolved: false, alreadyResolved: false, skipped: true };
    }
    if (String(hold.status).toUpperCase() !== "ACTIVE") {
      return { holdId: hold.id, reviewId: hold.absenceReviewId ?? null, studentId: hold.studentId, resolved: false, alreadyResolved: true, skipped: false };
    }
    hold.status = "RESOLVED";
    hold.resolvedAt = params.now ?? NOW;
    hold.resolution = params.resolution ?? "CATCH_UP_COMPLETED";
    return {
      holdId: hold.id,
      reviewId: hold.absenceReviewId ?? null,
      studentId: hold.studentId,
      resolved: true,
      alreadyResolved: false,
      skipped: false,
    };
  },
};

fs.writeFileSync(path.join(OUT, "fake-db.js"), "module.exports = globalThis.__PH_FAKE_DB__;\n");
fs.writeFileSync(path.join(OUT, "fake-absence.js"), "module.exports = globalThis.__PH_FAKE_ABSENCE__;\n");
globalThis.__PH_FAKE_DB__ = { db: fakeDb };
globalThis.__PH_FAKE_ABSENCE__ = fakeAbsenceReview;

const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return path.join(OUT, "fake-db.js");
  if (request === "@/lib/absence-review") return path.join(OUT, "fake-absence.js");
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(OUT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return realResolve.call(this, request, ...rest);
};

const REQ = require(path.join(OUT, "progression-requirements.js"));
const ENGINE = require(path.join(OUT, "progression-engine.js"));
const HOLDS = require(path.join(OUT, "progression-holds.js"));
const OVERRIDES = require(path.join(OUT, "progression-overrides.js"));
const CATCHUP = require(path.join(OUT, "progression-catchup.js"));
const SP = require(path.join(OUT, "session-progress.js"));

// ===========================================================================
async function main() {
  // -------------------------------------------------------------------------
  section("A. The pure requirement matrix (no database)");
  // -------------------------------------------------------------------------
  const mkFacts = (video = {}, quiz = {}, homework = {}) => ({
    video: { required: false, done: true, percent: 0, threshold: 95, source: "NONE", count: 0, completedCount: 0, ...video },
    quiz: { required: false, done: true, requiredCount: 0, passedCount: 0, attemptedCount: 0, bestPercent: null, passMark: null, ...quiz },
    homework: { required: false, done: true, requiredCount: 0, submittedCount: 0, gradedCount: 0, ...homework },
  });

  // CASE 1 — video < 95% does not satisfy a required video.
  ok(
    REQ.evaluateRequirements(
      mkFacts({ required: true, done: false, percent: 94, source: "LEGACY", count: 1 })
    ).completed === false,
    "CASE 1: a required video at 94% does NOT satisfy the video requirement"
  );
  // CASE 2 — video >= 95% satisfies it.
  ok(
    REQ.evaluateRequirements(
      mkFacts({ required: true, done: false, percent: 95, source: "LEGACY", count: 1 })
    ).completed === true,
    "CASE 2: a required video at 95% satisfies the video requirement"
  );
  ok(
    REQ.evaluateRequirements(mkFacts({ required: true, done: false, percent: 95, threshold: 96, count: 1 }))
      .completed === false,
    "CASE 2b: the row's own threshold wins (95% < requiredPercent 96)"
  );
  // CASE 4 — a submitted quiz that did not pass does not satisfy.
  ok(
    REQ.evaluateRequirements(
      mkFacts({}, { required: true, done: false, requiredCount: 1, passedCount: 0, attemptedCount: 1, bestPercent: 40, passMark: 60 })
    ).completed === false,
    "CASE 4: a finished but FAILED quiz attempt does not satisfy the quiz requirement"
  );
  // CASE 5 — a passed quiz satisfies.
  ok(
    REQ.evaluateRequirements(
      mkFacts({}, { required: true, done: true, requiredCount: 1, passedCount: 1, attemptedCount: 1, bestPercent: 80, passMark: 60 })
    ).completed === true,
    "CASE 5: a PASSED quiz satisfies the quiz requirement"
  );
  // CASE 6/7 — homework submission satisfies; grading is irrelevant.
  ok(
    REQ.evaluateRequirements(
      mkFacts({}, {}, { required: true, done: true, requiredCount: 1, submittedCount: 1, gradedCount: 0 })
    ).completed === true,
    "CASE 6/7: a submitted-but-UNGRADED homework satisfies progression (grading is never required)"
  );
  // CASE 16 — a lesson with no requirements is complete.
  ok(
    REQ.evaluateRequirements(mkFacts()).completed === true,
    "CASE 16: a lesson with no video/quiz/homework is COMPLETE (a missing component is not a requirement)"
  );
  // CASE 17 — multiple requirements combine (all must be satisfied).
  {
    const all = mkFacts(
      { required: true, done: true, percent: 100, source: "LEGACY", count: 1, completedCount: 1 },
      { required: true, done: true, requiredCount: 2, passedCount: 2, attemptedCount: 2, passMark: 60 },
      { required: true, done: false, requiredCount: 1, submittedCount: 0 }
    );
    const ev = REQ.evaluateRequirements(all);
    ok(ev.completed === false && ev.unmet.join(",") === "HOMEWORK", "CASE 17: every required component must be satisfied (one missing blocks)");
    ok(
      REQ.orderUnmet(["HOMEWORK", "VIDEO", "QUIZ", "ABSENCE_HOLD"]).join(",") === "ABSENCE_HOLD,VIDEO,QUIZ,HOMEWORK",
      "CASE 17b: unmet codes are ordered by what the student must do first"
    );
  }
  ok(REQ.VIDEO_COMPLETION_THRESHOLD === 95, "the canonical video threshold is 95%");
  ok(REQ.stateFor({ completed: false, boundaryAllowed: false }) === "LOCKED", "state: blocked boundary => LOCKED");
  ok(REQ.stateFor({ completed: false, boundaryAllowed: true }) === "UNLOCKED", "state: reachable and unfinished => UNLOCKED");
  ok(REQ.stateFor({ completed: true, boundaryAllowed: true }) === "COMPLETED", "state: complete => COMPLETED");
  ok(REQ.stateFor({ completed: true, boundaryAllowed: false }) === "LOCKED", "state: a completed lesson behind a boundary is still LOCKED");

  // -------------------------------------------------------------------------
  section("B. The canonical engine (behavioural)");
  // -------------------------------------------------------------------------
  const course = () => ENGINE.evaluateCourseProgression({ studentId: STUDENT, courseId: COURSE, now: NOW });
  const rowOf = async (id) => (await course()).byLessonId.get(id);
  const codesOf = (row) => row.unmet.map((u) => u.code).join(",");
  /** Satisfy every component of L2 (video 100%, quiz PASSED, homework submitted). */
  const completeL2 = () => {
    state.lessonProgress.L2 = { videoPercent: 100, videoCompleted: true, isCompleted: false };
    state.attempts.push({ quizId: "Q2", percentage: 90, passed: true, finishedAt: NOW });
    state.submissions.push({ homeworkId: "H2", submittedAt: NOW, grade: null });
  };

  // CASE 16 (behavioural) — L1 has nothing: it completes and unlocks L2.
  reset();
  let row = await rowOf("L1");
  ok(row.state === "COMPLETED" && row.unlocked, "CASE 16: a lesson with no requirements completes and unlocks the next one");
  ok(!row.requirements.video.required && !row.requirements.quiz.required && !row.requirements.homework.required,
    "CASE 16b: no component is reported as required when none exists");

  // CASE 1/2 (behavioural) — the video bar.
  reset();
  state.lessonProgress.L2 = { videoPercent: 94, videoCompleted: false, isCompleted: false };
  state.attempts.push({ quizId: "Q2", percentage: 90, passed: true, finishedAt: NOW });
  state.submissions.push({ homeworkId: "H2", submittedAt: NOW, grade: null });
  row = await rowOf("L2");
  ok(row.completed === false && codesOf(row) === "VIDEO", "CASE 1: video 94% keeps the session incomplete (quiz passed, homework submitted)");
  ok((await rowOf("L3")).state === "LOCKED", "CASE 1b: the next session stays locked");
  state.lessonProgress.L2 = { videoPercent: 95, videoCompleted: false, isCompleted: false };
  row = await rowOf("L2");
  ok(row.completed === true, "CASE 2: video 95% completes the session");
  ok((await rowOf("L3")).unlocked === true, "CASE 2b: and unlocks the next session");

  // CASE 3 — a client cannot spoof video completion.
  reset();
  state.lessonProgress.L2 = { videoPercent: 20, videoCompleted: false, isCompleted: true };
  state.attempts.push({ quizId: "Q2", percentage: 100, passed: true, finishedAt: NOW });
  state.submissions.push({ homeworkId: "H2", submittedAt: NOW, grade: null });
  row = await rowOf("L2");
  ok(row.completed === false, "CASE 3: a stored isCompleted flag never overrides the server-tracked percentage");
  ok(row.requirements.video.done === false && row.requirements.video.value === 20,
    "CASE 3b: the engine reports the SERVER-tracked watch percentage, not a client claim");

  // CASE 4/5 (behavioural) — quiz: submitted ≠ passed.
  reset();
  state.lessonProgress.L2 = { videoPercent: 100, videoCompleted: true, isCompleted: false };
  state.submissions.push({ homeworkId: "H2", submittedAt: NOW, grade: null });
  state.attempts.push({ quizId: "Q2", percentage: 30, passed: false, finishedAt: NOW });
  row = await rowOf("L2");
  ok(row.completed === false && codesOf(row) === "QUIZ", "CASE 4: a submitted-but-failed quiz does NOT satisfy progression");
  ok((await rowOf("L3")).state === "LOCKED", "CASE 4b: the next session stays locked after a failed quiz");
  state.attempts = [{ quizId: "Q2", percentage: 75, passed: true, finishedAt: NOW }];
  row = await rowOf("L2");
  ok(row.completed === true, "CASE 5: a PASSED quiz satisfies progression");
  ok((await rowOf("L3")).unlocked === true, "CASE 5b: and unlocks the next session");

  // CASE 6/7 (behavioural) — homework submission, grading irrelevant.
  reset();
  state.lessonProgress.L2 = { videoPercent: 100, videoCompleted: true, isCompleted: false };
  state.attempts.push({ quizId: "Q2", percentage: 100, passed: true, finishedAt: NOW });
  row = await rowOf("L2");
  ok(row.completed === false && codesOf(row) === "HOMEWORK", "CASE 6: an unsubmitted homework blocks progression");
  state.submissions.push({ homeworkId: "H2", submittedAt: NOW, grade: null });
  row = await rowOf("L2");
  ok(row.completed === true, "CASE 6b: SUBMITTING the homework satisfies progression");
  ok(row.requirements.homework.detail.graded === 0, "CASE 7: grading is reported but never required (graded = 0 is still complete)");

  // CASE 8 — attendance never completes a lesson.
  reset();
  row = await rowOf("L2");
  ok(row.completed === false, "CASE 8: no attendance row can complete a lesson (the engine reads no attendance at all)");
  ok(
    !/db\.attendance|attendance\.find(Many|Unique|First)/i.test(read("src/lib/progression-engine.ts")),
    "CASE 8b: the engine reads no attendance rows (attendance is not a completion signal)"
  );

  // CASE 9 — an EXCUSED absence (RESOLVED hold) does not block.
  reset();
  // L2 is fully satisfied, so the ONLY thing that could lock L3 is the hold.
  completeL2();
  state.holds.push({
    id: "HOLD1",
    studentId: STUDENT,
    sessionId: "SESS1",
    status: "RESOLVED",
    reason: "EXCUSED_ABSENCE",
    absenceReview: { status: "EXCUSED", lessonId: "L2" },
    absenceReviewId: "REV1",
  });
  row = await rowOf("L3");
  ok(row.state !== "LOCKED", "CASE 9: an EXCUSED absence (RESOLVED hold) does not lock the next session");
  ok(HOLDS.holdBlocksProgression({ status: "RESOLVED", catchUpSatisfied: false }) === false,
    "CASE 9b: a RESOLVED hold never blocks forward progression");

  // CASE 10 — an ACTIVE unexcused hold blocks the NEXT session.
  // L2 is deliberately INCOMPLETE: the missed session's own academics are what
  // the hold waits for, and the boundary code proves the HOLD is what blocks
  // (ABSENCE_HOLD outranks PREVIOUS_LESSON in the priority order).
  reset();
  // L3's OWN quiz is already passed, so the only thing that can lock it is the
  // hold — the assertion below then proves the HOLD is the blocking rule.
  state.attempts.push({ quizId: "Q3", percentage: 90, passed: true, finishedAt: NOW });
  state.lessonProgress.L2 = { videoPercent: 50, videoCompleted: false, isCompleted: false };
  state.holds.push({
    id: "HOLD2",
    studentId: STUDENT,
    sessionId: "SESS2",
    status: "ACTIVE",
    reason: "UNEXCUSED_ABSENCE",
    absenceReview: { status: "UNEXCUSED", lessonId: "L2" },
    absenceReviewId: "REV2",
  });
  row = await rowOf("L3");
  ok(row.state === "LOCKED" && codesOf(row) === "ABSENCE_HOLD", "CASE 10: an ACTIVE unexcused hold locks the NEXT session");
  const cp = await course();
  ok(cp.boundary?.lessonId === "L3", "CASE 10b: the effective progression boundary is the first blocked session");
  ok(cp.hold?.blocks === true && cp.hold?.lessonId === "L2", "CASE 10c: the boundary names the hold that causes it");

  // CASE 11 — the hold does NOT block the affected/current session.
  row = await rowOf("L2");
  ok(row.unlocked === true, "CASE 11: the affected session itself stays open (never the content needed to recover)");
  ok((await ENGINE.canAccessLesson(STUDENT, "L2", { now: NOW })).allowed === true,
    "CASE 11b: direct access to the affected session is still allowed while the hold is active");
  ok((await ENGINE.canAccessQuiz ? true : true) && (await SP.canAccessQuiz(STUDENT, "Q2")).allowed === true,
    "CASE 11c: the affected session's QUIZ stays reachable while the hold is active");
  ok((await SP.canAccessHomework(STUDENT, "H2")).allowed === true,
    "CASE 11d: the affected session's HOMEWORK stays reachable while the hold is active");
  ok((await rowOf("L1")).unlocked === true, "CASE 11e: historical completed sessions stay open");

  // CASE 12 — the recording needed for recovery stays reachable.
  const videoRoute = read("src/app/api/students/me/session-videos/[id]/progress/route.ts");
  ok(/canAccessLesson\(student\.id, video\.lessonId\)/.test(videoRoute),
    "CASE 12: a batch recording's heartbeat is gated by the same lesson verdict (open while held)");
  ok(/canAccessLesson\(/.test(read("src/app/api/media/[id]/route.ts")),
    "CASE 12b: media access delegates to the same lesson verdict");

  // CASE 13 — catch-up lists ONLY the requirements that actually exist.
  reset();
  state.holds.push({
    id: "HOLD3",
    studentId: STUDENT,
    sessionId: "SESS3",
    status: "ACTIVE",
    reason: "UNEXCUSED_ABSENCE",
    absenceReview: { status: "UNEXCUSED", lessonId: "L2" },
    absenceReviewId: "REV3",
  });
  let withHold = await course();
  ok(withHold.catchUp?.unmet.map((u) => u.code).join(",") === "VIDEO,QUIZ,HOMEWORK",
    "CASE 13: the catch-up of a lesson with all three components lists all three");
  state.holds[0].absenceReview.lessonId = "L3";
  state.holds[0].lessonId = "L3";
  withHold = await course();
  ok(withHold.catchUp?.unmet.map((u) => u.code).join(",") === "QUIZ",
    "CASE 13b: a lesson with ONLY a quiz lists just the quiz — nothing is invented");

  // CASE 14 — catch-up can resolve the progression block through Phase F.
  absenceCalls.length = 0;
  state.holds[0].absenceReview.lessonId = "L3";
  state.attempts.push({ quizId: "Q3", percentage: 90, passed: true, finishedAt: NOW });
  let before = await course();
  ok(before.catchUp?.satisfied === true, "CASE 14: the catch-up is satisfied once the missed session's academics are done");
  ok(before.hold === null, "CASE 14b: a satisfied catch-up stops the hold from blocking (the student is never trapped)");
  const resolution = await CATCHUP.resolveCatchUpIfSatisfied({ studentId: STUDENT, courseId: COURSE, now: NOW });
  ok(resolution.resolution === "RESOLVED", "CASE 14c: the hold is resolved through the Phase F authority");
  ok(absenceCalls.length === 1 && absenceCalls[0].lessonId === "L3", "CASE 14d: the resolution DELEGATES to the absence authority (never writes a hold itself)");
  ok(state.holds[0].status === "RESOLVED", "CASE 14e: the hold row is RESOLVED (history preserved — the review stays UNEXCUSED)");
  ok(state.holds[0].absenceReview.status === "UNEXCUSED", "CASE 14f: the absence review status is NEVER rewritten by catch-up");

  // CASE 15 — the resolution is idempotent.
  const second = await CATCHUP.resolveCatchUpIfSatisfied({ studentId: STUDENT, courseId: COURSE, now: NOW });
  ok(second.resolution === "NO_HOLD" || second.resolution === "ALREADY_RESOLVED",
    `CASE 15: a second resolution is a no-op (got ${second.resolution})`);
  ok(absenceCalls.length === 2 && state.holds[0].resolvedAt.getTime() === NOW.getTime(),
    "CASE 15b: no duplicate resolution write is performed (the resolved instant is untouched)");

  // CASE 26 — a direct lesson URL cannot bypass progression.
  reset();
  let access = await ENGINE.canAccessLesson(STUDENT, "L3", { now: NOW });
  ok(access.allowed === false && access.reason === "PREVIOUS_SESSION_INCOMPLETE",
    "CASE 26: a direct call for a locked lesson is refused (UI hiding is not security)");
  ok(access.status && access.status.unmet.some((u) => u.code === "PREVIOUS_LESSON"),
    "CASE 26b: the refusal carries structured unmet codes, not a bare LOCKED");
  ok(!access.status.unmet.some((u) => /_ID|id$/i.test(u.code)), "CASE 26c: the refusal exposes no internal ids or DB enums");

  // CASE 27 — direct quiz / homework / media access cannot bypass progression.
  ok((await SP.canAccessQuiz(STUDENT, "Q3")).allowed === false, "CASE 27: the quiz of a locked session is refused");
  ok((await SP.canAccessHomework(STUDENT, "H3")).allowed === false, "CASE 27b: a nonexistent/locked homework is refused");

  // CASE 28 — existing COMPLETED lessons stay valid.
  reset();
  state.lessonProgress.L1 = { videoPercent: 0, videoCompleted: false, isCompleted: true };
  row = await rowOf("L1");
  ok(row.state === "COMPLETED", "CASE 28: a legacy COMPLETED lesson stays COMPLETED (no requirement is invented for it)");

  // CASE 29 — legacy rows with none of the new optional metadata stay valid.
  reset();
  const legacy = await course();
  ok(legacy.lessons.length === 5, `CASE 29: every legacy lesson is still evaluated (got ${legacy.lessons.length})`);
  ok(legacy.overrides.length === 0 && legacy.hold === null && legacy.catchUp === null,
    "CASE 29b: absent override/hold/session-video rows read as 'none', never as a block");
  ok(legacy.lessons.every((l) => l.state === "COMPLETED" || l.state === "UNLOCKED" || l.state === "LOCKED"),
    "CASE 29c: every lesson still resolves to exactly one of the three canonical states");

  // CASE 30/31 — Phase 12 track isolation stays intact and composes.
  reset();
  const universe = await course();
  ok(!universe.lessons.some((l) => l.lessonId === "LX"),
    "CASE 30: a LANGUAGE-track lesson is absent from an ARABIC student's universe");
  access = await ENGINE.canAccessLesson(STUDENT, "LX", { now: NOW });
  ok(access.allowed === false && access.reason === "LESSON_NOT_FOUND",
    "CASE 31: progression never unlocks another track (404, not 403 — no oracle)");
  ok((await SP.canAccessQuiz(STUDENT, "QT")).allowed === false,
    "CASE 31d: a cross-track quiz stays unreachable even through the direct gate");
  row = await rowOf("LT");
  ok(row.requirements.quiz.required === false,
    "CASE 31b: a LANGUAGE quiz on a SHARED lesson is never a requirement for an ARABIC student (no deadlock)");

  // CASE 32 — concurrent evaluation is deterministic.
  reset();
  state.lessonProgress.L2 = { videoPercent: 50, videoCompleted: false, isCompleted: false };
  state.attempts.push({ quizId: "Q2", percentage: 20, passed: false, finishedAt: NOW });
  const [a1, a2, a3] = await Promise.all([
    course(),
    ENGINE.evaluateCourseProgression({ studentId: STUDENT, courseId: COURSE, now: NOW }),
    course(),
  ]);
  const shape = (p) => JSON.stringify(p.lessons.map((l) => [l.lessonId, l.state, l.unmet.map((u) => u.code)]));
  ok(shape(a1) === shape(a2) && shape(a2) === shape(a3), "CASE 32: concurrent evaluations agree byte for byte");

  // CASE 33 — repeated evaluation is idempotent (no writes, no drift).
  const first = shape(await course());
  const secondEval = shape(await course());
  ok(first === secondEval, "CASE 33: repeated evaluation is idempotent");
  ok(state.overrides.length === 0 && state.audit.length === 0, "CASE 33b: evaluating progression writes nothing");

  // CASE 34 — every progression reader agrees with the canonical authority.
  const canonical = await course();
  const facade = await SP.getCourseSessionProgress(STUDENT, COURSE);
  ok(
    canonical.lessons.every((l) => {
      const f = facade.byLessonId.get(l.lessonId);
      return f && f.completed === l.completed && f.unlocked === l.unlocked;
    }),
    "CASE 34: the historical reader (session-progress facade) agrees with the engine"
  );

  // CASE 35 — the student dashboard's unlock set agrees with the course tree.
  const unlocked = await SP.getUnlockedLessonIds(STUDENT, COURSE);
  const canonicalUnlocked = new Set(canonical.lessons.filter((l) => l.unlocked).map((l) => l.lessonId));
  ok(
    unlocked.size === canonicalUnlocked.size && [...unlocked].every((id) => canonicalUnlocked.has(id)),
    "CASE 35: getUnlockedLessonIds (dashboard / homework list) == the canonical unlocked set"
  );

  // CASE 36 — lesson navigation agrees with direct API access.
  for (const l of canonical.lessons) {
    const direct = await ENGINE.canAccessLesson(STUDENT, l.lessonId, { now: NOW });
    ok(direct.status?.unlocked === l.unlocked, `CASE 36: navigation state of ${l.lessonId} == direct access verdict`);
  }

  // -------------------------------------------------------------------------
  section("C. Admin progression overrides");
  // -------------------------------------------------------------------------
  // CASE 18 — a reason is mandatory.
  reset();
  ok(OVERRIDES.validateOverrideReason("").ok === false, "CASE 18: an empty reason is refused");
  ok(OVERRIDES.validateOverrideReason("  ").ok === false, "CASE 18b: a whitespace reason is refused");
  ok(OVERRIDES.validateOverrideReason("ab").ok === false, "CASE 18c: a too-short reason is refused");
  ok(OVERRIDES.validateOverrideReason("طالب متفوق").ok === true, "CASE 18d: a real reason is accepted");

  // CASE 23/24/25 — role gates.
  ok(OVERRIDES.canIssueProgressionOverride("ADMIN") === true, "CASE 23: an ADMIN may issue an override");
  ok(OVERRIDES.canIssueProgressionOverride("TEACHER") === false, "CASE 23: a TEACHER may NOT issue an override");
  ok(OVERRIDES.canIssueProgressionOverride("STUDENT") === false, "CASE 24: a STUDENT may NOT issue an override");
  ok(OVERRIDES.canIssueProgressionOverride("PARENT") === false, "CASE 25: a PARENT may NOT issue an override");
  let threw = null;
  try {
    await OVERRIDES.createProgressionOverride({
      studentId: STUDENT, lessonId: "L3", reason: "because", actorUserId: "T1", actorRole: "TEACHER", now: NOW,
    });
  } catch (e) {
    threw = e;
  }
  ok(threw && threw.code === "NOT_AUTHORIZED", "CASE 23b: the write path itself refuses a TEACHER (not just the route)");
  threw = null;
  try {
    await OVERRIDES.createProgressionOverride({
      studentId: STUDENT, lessonId: "L3", reason: "a perfectly good reason", actorUserId: "S1", actorRole: "STUDENT", now: NOW,
    });
  } catch (e) {
    threw = e;
  }
  ok(threw && threw.code === "NOT_AUTHORIZED", "CASE 24b: a STUDENT with a valid reason is still refused (role gate wins)");
  threw = null;
  try {
    await OVERRIDES.createProgressionOverride({
      studentId: STUDENT, lessonId: "L3", reason: "a perfectly good reason", actorUserId: "P1", actorRole: "PARENT", now: NOW,
    });
  } catch (e) {
    threw = e;
  }
  ok(threw && threw.code === "NOT_AUTHORIZED", "CASE 25b: a PARENT with a valid reason is still refused");
  threw = null;
  try {
    await OVERRIDES.createProgressionOverride({
      studentId: STUDENT, lessonId: "L3", reason: "x", actorUserId: "A1", actorRole: "ADMIN", now: NOW,
    });
  } catch (e) {
    threw = e;
  }
  ok(threw && threw.code === "REASON_TOO_SHORT", "CASE 18e2: an ADMIN with a too-short reason is refused");
  threw = null;
  try {
    await OVERRIDES.createProgressionOverride({
      studentId: STUDENT, lessonId: "L3", reason: "", actorUserId: "A1", actorRole: "ADMIN", now: NOW,
    });
  } catch (e) {
    threw = e;
  }
  ok(threw && threw.code === "REASON_REQUIRED", "CASE 18e: an ADMIN write without a reason is refused by the authority itself");

  // CASE 19 — actor / time / student / lesson are recorded.
  reset();
  const created = await OVERRIDES.createProgressionOverride({
    studentId: STUDENT,
    lessonId: "L3",
    courseId: COURSE,
    reason: "استثناء بسبب ظروف خاصة",
    actorUserId: "ADMIN1",
    actorRole: "ADMIN",
    now: NOW,
  });
  ok(created.created === true, "CASE 19: an admin override is created");
  ok(created.override.createdByUserId === "ADMIN1", "CASE 19b: the actor is recorded");
  ok(created.override.createdAt.getTime() === NOW.getTime(), "CASE 19c: the instant is recorded");
  ok(created.override.studentId === STUDENT && created.override.lessonId === "L3", "CASE 19d: the student and the affected lesson are recorded");
  ok(created.override.reason === "استثناء بسبب ظروف خاصة", "CASE 19e: the mandatory reason is stored verbatim");
  ok(state.audit.some((a) => a.action === "PROGRESSION_OVERRIDE_CREATED" && a.entityId === created.override.id),
    "CASE 19f: the override is mirrored into the platform AuditLog");

  // idempotency — a retried create does not stack a second exception.
  const again = await OVERRIDES.createProgressionOverride({
    studentId: STUDENT, lessonId: "L3", courseId: COURSE, reason: "again", actorUserId: "ADMIN1", actorRole: "ADMIN", now: NOW,
  });
  ok(again.created === false && again.override.id === created.override.id && state.overrides.length === 1,
    "CASE 19g: issuing twice is idempotent (one valid override per student+lesson)");

  // CASE 26/27 — the override lets the boundary open, nothing else changes.
  let afterOverride = await course();
  ok(afterOverride.byLessonId.get("L3").unlocked === true, "CASE 26d: a valid override opens the blocked session");
  ok(afterOverride.byLessonId.get("L3").override?.id === created.override.id, "CASE 26e: the payload names the override in force");
  ok(afterOverride.byLessonId.get("L4").unlocked === false, "CASE 26f: the override opens ONE boundary — future content stays locked");

  // CASE 22 — the override rewrites no academic fact.
  ok(afterOverride.byLessonId.get("L2").completed === false, "CASE 22: the underlying session stays incomplete");
  ok(state.attempts.length === 0 && state.submissions.length === 0 && Object.keys(state.lessonProgress).length === 0,
    "CASE 22b: no attempt, submission or watch row was fabricated by the override");
  ok(afterOverride.byLessonId.get("L3").requirements.quiz.required === true,
    "CASE 22c: the overridden session's own requirements are still reported (nothing is marked done)");

  // CASE 10 + override — the hold survives an override.
  reset();
  state.holds.push({
    id: "HOLD4", studentId: STUDENT, sessionId: "SESS4", status: "ACTIVE", reason: "UNEXCUSED_ABSENCE",
    absenceReview: { status: "UNEXCUSED", lessonId: "L2" }, absenceReviewId: "REV4",
  });
  const held = await course();
  ok(held.byLessonId.get("L3").state === "LOCKED", "CASE 10d: the hold locks the next session before any override");
  await OVERRIDES.createProgressionOverride({
    studentId: STUDENT, lessonId: "L3", courseId: COURSE, reason: "استثناء إداري", actorUserId: "ADMIN1", actorRole: "ADMIN", now: NOW,
  });
  const heldAfter = await course();
  ok(heldAfter.byLessonId.get("L3").unlocked === true, "CASE 11f: a valid override may open a hold-blocked boundary");
  ok(state.holds[0].status === "ACTIVE", "CASE 22d: the AbsenceHold is NOT destroyed by the override (still ACTIVE)");
  ok(heldAfter.activeHold?.active === true, "CASE 22e: the hold stays visible to every reader while the override is in force");

  // CASE 20/21 — optional expiry.
  reset();
  const expiry = new Date("2026-09-21T12:00:00.000Z");
  ok(OVERRIDES.validateOverrideExpiry(null, NOW).ok === true, "CASE 20: an override may have no expiry");
  ok(OVERRIDES.validateOverrideExpiry("2026-09-19T00:00:00.000Z", NOW).ok === false, "CASE 20b: a past expiry is refused");
  ok(OVERRIDES.validateOverrideExpiry(expiry.toISOString(), NOW).ok === true, "CASE 20c: a future expiry is accepted");
  const expiring = await OVERRIDES.createProgressionOverride({
    studentId: STUDENT, lessonId: "L3", courseId: COURSE, reason: "استثناء مؤقت",
    expiresAt: expiry.toISOString(), actorUserId: "ADMIN1", actorRole: "ADMIN", now: NOW,
  });
  ok(expiring.override.expiresAt.getTime() === expiry.getTime(), "CASE 20d: the expiry is stored");
  ok(OVERRIDES.isOverrideValid(expiring.override, new Date("2026-09-20T18:00:00.000Z")) === true,
    "CASE 20e: the override is valid before its expiry");
  ok(OVERRIDES.isOverrideValid(expiring.override, new Date("2026-09-22T00:00:00.000Z")) === false,
    "CASE 21: the override is invalid after its expiry");
  const beforeExpiry = await ENGINE.evaluateCourseProgression({ studentId: STUDENT, courseId: COURSE, now: new Date("2026-09-20T18:00:00.000Z") });
  ok(beforeExpiry.byLessonId.get("L3").unlocked === true, "CASE 20f: the session is open while the override is valid");
  const afterExpiry = await ENGINE.evaluateCourseProgression({ studentId: STUDENT, courseId: COURSE, now: new Date("2026-09-22T00:00:00.000Z") });
  ok(afterExpiry.byLessonId.get("L3").unlocked === false, "CASE 21b: an EXPIRED override no longer bypasses the boundary");
  ok(state.overrides.length === 1, "CASE 21c: the expired row is kept (the history of the decision survives)");

  // Revocation.
  reset();
  const toRevoke = await OVERRIDES.createProgressionOverride({
    studentId: STUDENT, lessonId: "L3", courseId: COURSE, reason: "for revocation", actorUserId: "ADMIN1", actorRole: "ADMIN", now: NOW,
  });
  const revoked = await OVERRIDES.revokeProgressionOverride({
    overrideId: toRevoke.override.id, actorUserId: "ADMIN2", actorRole: "ADMIN", reason: "خلص السبب", now: NOW,
  });
  ok(revoked.revoked === true && revoked.override.revokedByUserId === "ADMIN2", "CASE 20g: revocation records the actor");
  ok(state.audit.some((a) => a.action === "PROGRESSION_OVERRIDE_REVOKED"), "CASE 20h: revocation is audited");
  const revokedAgain = await OVERRIDES.revokeProgressionOverride({
    overrideId: toRevoke.override.id, actorUserId: "ADMIN2", actorRole: "ADMIN", now: NOW,
  });
  ok(revokedAgain.revoked === false && state.audit.filter((a) => a.action === "PROGRESSION_OVERRIDE_REVOKED").length === 1,
    "CASE 20i: revoking twice is idempotent (no duplicate audit event)");
  threw = null;
  try {
    await OVERRIDES.revokeProgressionOverride({
      overrideId: toRevoke.override.id, actorUserId: "T1", actorRole: "TEACHER", now: NOW,
    });
  } catch (e) {
    threw = e;
  }
  ok(threw && threw.code === "NOT_AUTHORIZED", "CASE 23c: a TEACHER cannot revoke an override either");
  ok((await course()).byLessonId.get("L3").unlocked === false, "CASE 21d: a revoked override stops applying immediately");

  // CASE 38 — the boundary blocks forward progression only.
  reset();
  state.holds.push({
    id: "HOLD5", studentId: STUDENT, sessionId: "SESS5", status: "ACTIVE", reason: "UNEXCUSED_ABSENCE",
    absenceReview: { status: "UNEXCUSED", lessonId: "L2" }, absenceReviewId: "REV5",
  });
  const final = await course();
  ok(final.byLessonId.get("L1").unlocked === true, "CASE 38: historical sessions stay open under a hold");
  ok(final.byLessonId.get("L2").unlocked === true, "CASE 38b: the affected session stays open under a hold");
  ok(final.byLessonId.get("L3").unlocked === false, "CASE 38c: the NEXT session is blocked");
  ok(final.byLessonId.get("L4").unlocked === false, "CASE 38d: everything beyond the boundary is blocked");

  // -------------------------------------------------------------------------
  section("D. Source invariants (the rules pinned to the HTTP surface)");
  // -------------------------------------------------------------------------
  const engineSrc = read("src/lib/progression-engine.ts");
  const spSrc = read("src/lib/session-progress.ts");
  const adminRoute = read("src/app/api/admin/progression/overrides/route.ts");
  const revokeRoute = read("src/app/api/admin/progression/overrides/[id]/revoke/route.ts");
  const catchupRoute = read("src/app/api/students/me/catch-up/route.ts");
  const lessonRoute = read("src/app/api/lessons/[id]/route.ts");
  const treeRoute = read("src/app/api/courses/[slug]/route.ts");
  const dashRoute = read("src/app/api/students/me/dashboard/route.ts");
  const parentRoute = read("src/app/api/parents/me/dashboard/route.ts");
  const holdsSrc = read("src/lib/progression-holds.ts");
  const catchupSrc = read("src/lib/progression-catchup.ts");

  // CASE 12/34 — one authority, everywhere.
  ok(/evaluateCourseProgression\(/.test(treeRoute), "CASE 34b: the course tree reads the canonical engine");
  ok(/evaluateCourseProgression\(/.test(dashRoute), "CASE 34c: the student dashboard reads the canonical engine");
  ok(/evaluateCourseProgression\(/.test(parentRoute), "CASE 37: the parent reader reads the SAME canonical engine (no parent-only logic)");
  ok(/canAccessLessonWithCourse\(|canAccessLesson\(/.test(lessonRoute), "CASE 36b: the lesson page is gated by the canonical engine");
  ok(/progression-engine/.test(spSrc), "CASE 12c: session-progress delegates to the canonical engine (no second implementation)");
  ok(!/const found = await db\.lesson\.findMany/.test(spSrc), "CASE 12d: the facade carries no universe query of its own");

  // CASE 8 — attendance is not a completion signal.
  for (const [label, src] of [
    ["engine", engineSrc],
    ["requirements", read("src/lib/progression-requirements.ts")],
  ]) {
    ok(!/db\.attendance|attendance\.find(Many|Unique|First)/i.test(src), `CASE 8c: ${label} never reads attendance to complete a lesson`);
  }
  ok(/absenceHold/.test(holdsSrc) && /findMany/.test(holdsSrc) && !/from "@\/lib\/absence-review"/.test(holdsSrc),
    "CASE 14g: hold READS live in Phase H's bridge (it never imports the Phase F writer)");
  ok(/absence-review/.test(catchupSrc) && /resolveAbsenceHoldForCatchUp/.test(catchupSrc),
    "CASE 14g2: hold WRITES are delegated to the Phase F authority");

  // CASE 22 — an override may never fabricate academic facts.
  const overridesSrc = read("src/lib/progression-overrides.ts");
  ok(!/quizAttempt\.(create|update|upsert)/.test(overridesSrc), "CASE 22e: the override never writes a quiz attempt");
  ok(!/homeworkSubmission\.(create|update|upsert)/.test(overridesSrc), "CASE 22f: the override never writes a homework submission");
  ok(!/lessonProgress\.(create|update|upsert)/.test(overridesSrc), "CASE 22g: the override never writes video watch progress");
  ok(!/absenceHold\.(update|delete)/.test(overridesSrc), "CASE 22h: the override never touches an AbsenceHold");
  ok(!/db\.attendance|attendance\.(update|delete|create|upsert)/i.test(overridesSrc),
    "CASE 22i: the override never touches attendance");

  // CASE 18/23 — the admin surface is admin-only and reason-mandatory.
  for (const [label, src] of [["POST /api/admin/progression/overrides", adminRoute], ["revoke", revokeRoute]]) {
    // The repo's canonical gate (`requireRole`) authenticates AND authorises
    // in one call — the same helper every other admin route uses, so a Teacher
    // can never reach this surface (and no weaker role gate is accepted here).
    ok(/await requireRole\("ADMIN"\)/.test(src), `${label} requires an authenticated ADMIN`);
    ok(!/requireRole\("(TEACHER|STUDENT|PARENT)"\)/.test(src), `${label} is ADMIN-only (no weaker gate)`);
  }
  ok(/canIssueProgressionOverride\(input\.actorRole\)/.test(overridesSrc),
    "CASE 23d0: the role the route passes down is re-checked inside the authority, not only in the route");
  ok(/actorRole: user\.role/.test(adminRoute), "CASE 23d: the route passes the role down so the authority re-checks it");
  ok(/reason: body\?\.reason/.test(adminRoute), "CASE 18f: the reason comes from the request and is validated server-side");
  ok(/ProgressionOverrideError/.test(adminRoute), "CASE 18g: validation failures are surfaced, never swallowed");

  // CASE 24/25 — the student surface never accepts someone else's catch-up.
  ok(/user\.role !== "STUDENT"/.test(catchupRoute), "CASE 24c: the catch-up endpoint is student-only");
  ok(/getStudentProfile\(user\.id\)/.test(catchupRoute), "CASE 24d: the catch-up resolves the student SERVER-side (no studentId parameter)");
  ok(/resolveCatchUpIfSatisfied/.test(catchupRoute), "CASE 14h: the catch-up resolution goes through the Phase F bridge");

  // CASE 26 — the denial explains itself through the shared helper.
  const apiSrc = read("src/lib/api.ts");
  ok(/export async function denyProgression/.test(apiSrc), "CASE 26g: denials go through the shared helper");
  ok(/detail\?: ProgressionDenialDetail/.test(apiSrc), "CASE 26h: the denial may carry a human reason + blockers");
  ok(/blockers/.test(apiSrc), "CASE 26i: the denial carries structured blockers");
  ok(/body\.reason = detail\.reason/.test(apiSrc) && /code === "PREVIOUS_SESSION_INCOMPLETE"/.test(apiSrc),
    "CASE 26j: the detail is added for progression refusals only (never for an enrollment refusal)");

  // CASE 30 — track composition, never override.
  ok(/trackScopeWhere\(schoolType\)/.test(read("src/lib/progression-universe.ts")),
    "CASE 30b: the universe keeps the Phase 12 track slice (progression composes with it, never replaces it)");
  ok(/canAccessTrackScope\(schoolType, lesson\.trackScope\)/.test(engineSrc),
    "CASE 31c: the direct gate keeps the Phase 12 track check");

  // CASE 3 — the write path credits real time only.
  const videoProgress = read("src/app/api/lessons/[id]/video-progress/route.ts");
  ok(/MAX_CREDIT_PER_BEAT_SEC/.test(videoProgress), "CASE 3c: the heartbeat caps credited time per beat");
  ok(/Math\.min\(elapsedSec, MAX_CREDIT_PER_BEAT_SEC\)/.test(videoProgress), "CASE 3d: credit can never exceed REAL elapsed wall-clock time");
  ok(/canAccessLesson\(student\.id, id\)/.test(videoProgress), "CASE 3e: a locked lesson cannot accrue watch time at all");
  const progressRoute = read("src/app/api/lessons/[id]/progress/route.ts");
  ok(/videoSatisfied/.test(progressRoute), "CASE 3f: the `completed` flag path consults the server-tracked video state first");

  // i18n — every reason the engine can emit has an Arabic sentence.
  const dict = read("src/lib/i18n-dict-2026.ts");
  for (const key of [
    "progression.reason.video",
    "progression.reason.quiz",
    "progression.reason.homework",
    "progression.reason.hold",
    "progression.reason.previous",
    "progression.reason.override",
    "progression.state.locked",
    "progression.state.unlocked",
    "progression.state.completed",
  ]) {
    ok(dict.includes(`"${key}"`), `i18n: ${key} has an Arabic-first entry`);
  }

  // -------------------------------------------------------------------------
  console.log(`\nphase-h-progression: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.error("\nFailures:");
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
