// CodeMind Academy — Authorization & gating invariants (offline, source-level).
//
// These are STATIC invariant checks over the real route/lib sources. They
// cannot replace runtime tests, but they do catch the specific regressions
// this audit found, and they fail loudly if someone re-introduces them:
//
//   1. Every route that returns or mutates lesson/course content calls the
//      shared server-side authorization helper — no route relies on the UI
//      hiding a locked lesson.
//   2. The lesson-progress route cannot set isCompleted without satisfying
//      the 95% video rule (both the `completed` flag AND the `progress:100`
//      path are guarded).
//   3. canAccessLesson and getEnrollment agree on what "enrolled" means
//      (an ACTIVE group bound to the course).
//   4. /api/courses does not hand a student the whole catalogue.
//   5. The admin students list filters school type in SQL for all three tabs.
//   6. Mock-exam question selection always applies the school-type bank
//      filter, and never trusts a client-supplied school type.
//   7. Quiz evidence is admin-only and never reachable by a parent.
//   8. Exam attempts snapshot their answers so historical results survive
//      later question edits/deletions.
//
// Run: node tests/authorization-invariants.test.js

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("FAIL:", label);
  }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
section("1. Lesson/course routes enforce server-side authorization");
// ---------------------------------------------------------------------------
{
  const gated = [
    "src/app/api/lessons/[id]/route.ts",
    "src/app/api/lessons/[id]/progress/route.ts",
    "src/app/api/lessons/[id]/video-progress/route.ts",
  ];
  for (const rel of gated) {
    const src = read(rel);
    ok(
      /canAccessLesson\s*\(/.test(src),
      `${rel} calls canAccessLesson (backend gating, not UI-only)`
    );
    ok(
      /requireUser\s*\(/.test(src),
      `${rel} requires an authenticated user`
    );
  }

  const courseSrc = read("src/app/api/courses/[slug]/route.ts");
  ok(
    /getEnrollment\s*\(/.test(courseSrc),
    "courses/[slug] resolves enrollment server-side"
  );
  ok(
    /NOT_ENROLLED/.test(courseSrc) && /403/.test(courseSrc),
    "courses/[slug] returns 403 NOT_ENROLLED for an unenrolled student"
  );
  ok(
    /getCourseSessionProgress\s*\(/.test(courseSrc),
    "courses/[slug] derives lock state from the shared progression service"
  );
}

// ---------------------------------------------------------------------------
section("2. 95% video rule cannot be bypassed");
// ---------------------------------------------------------------------------
{
  const src = read("src/app/api/lessons/[id]/progress/route.ts");

  ok(
    /VIDEO_COMPLETION_THRESHOLD/.test(src),
    "progress route imports the shared threshold constant"
  );
  ok(
    /const videoSatisfied\s*=/.test(src),
    "progress route computes a single videoSatisfied gate"
  );

  // The regression this audit found: `progress: 100` used to complete a
  // lesson without consulting the video threshold at all.
  const hundredBranch = /progressValue\s*>=\s*100\s*\)\s*\{([\s\S]{0,240}?)\}/.exec(src);
  ok(!!hundredBranch, "progress>=100 branch is present");
  ok(
    hundredBranch && /videoSatisfied/.test(hundredBranch[1]),
    "progress>=100 branch is guarded by videoSatisfied (no silent bypass)"
  );

  const flagBranch = /if\s*\(completedFlag\)\s*\{([\s\S]{0,240}?)\n\s{4}\}/.exec(src);
  ok(
    flagBranch && /videoSatisfied/.test(flagBranch[1]),
    "completed:true branch is guarded by videoSatisfied"
  );

  // Both guarded paths must actually reject, not just skip the flag.
  ok(
    (src.match(/if \(!videoSatisfied\) return err\(/g) || []).length >= 2,
    "both completion paths return 403 when the video is not satisfied"
  );

  const heartbeat = read("src/app/api/lessons/[id]/video-progress/route.ts");
  ok(
    /MAX_CREDIT_PER_BEAT_SEC/.test(heartbeat),
    "heartbeat caps credit per beat (cannot fast-forward to complete)"
  );
  ok(
    /Math\.max\(\s*previousWatched/.test(heartbeat),
    "watched time is monotonic (refresh/seek-back never loses progress)"
  );
  ok(
    /Math\.min\(\s*elapsedSec/.test(heartbeat) ||
      /Math\.min\(elapsedSec/.test(heartbeat),
    "credit is bounded by REAL elapsed wall-clock time"
  );
  ok(
    /Math\.min\(previousWatched \+ credit, positionSec\)/.test(heartbeat),
    "credit is additionally bounded by the reported playhead"
  );
}

// ---------------------------------------------------------------------------
section("3. Session locking treats missing components as not-required");
// ---------------------------------------------------------------------------
{
  const src = read("src/lib/session-progress.ts");
  ok(/const hasVideo = !!lesson\.videoUrl;/.test(src), "video presence is detected");
  ok(
    /const videoDone = hasVideo[\s\S]{0,120}: true;/.test(src),
    "a lesson with NO video does not require a video (no permanent lock)"
  );
  ok(
    /const quizDone = hasQuiz[\s\S]{0,140}: true;/.test(src),
    "a lesson with NO quiz does not require a quiz"
  );
  ok(
    /const assignmentDone = hasHomework[\s\S]{0,160}: true;/.test(src),
    "a lesson with NO assignment does not require an assignment"
  );
  ok(
    /completed = videoDone && quizDone && assignmentDone/.test(src),
    "a session completes only when all REQUIRED components are done"
  );
  ok(
    /let previousCompleted = true;/.test(src),
    "the first lesson is always unlocked"
  );
  ok(
    /unlocked: previousCompleted/.test(src),
    "lesson N+1 unlocks only when lesson N is complete"
  );
  ok(
    /videoPercent >= VIDEO_COMPLETION_THRESHOLD/.test(src),
    "the unlock rule uses the same 95% threshold"
  );
}

// ---------------------------------------------------------------------------
section("4. Enrollment definition is consistent across authorization paths");
// ---------------------------------------------------------------------------
{
  const enrollment = read("src/lib/enrollment.ts");
  const sessionProgress = read("src/lib/session-progress.ts");

  ok(
    /group\?\.isActive/.test(enrollment) || /group\.isActive/.test(enrollment),
    "getEnrollment requires an ACTIVE group"
  );
  // The regression: canAccessLesson used to ignore isActive, so a deactivated
  // group still granted lesson access even though the course route refused.
  const fn = /export async function canAccessLesson[\s\S]*$/.exec(sessionProgress)[0];
  ok(
    /isActive: true/.test(fn) || /!student\.group\.isActive/.test(fn),
    "canAccessLesson also requires an ACTIVE group (agrees with getEnrollment)"
  );
  ok(
    /NOT_ENROLLED/.test(fn),
    "canAccessLesson reports NOT_ENROLLED rather than silently allowing"
  );
}

// ---------------------------------------------------------------------------
section("5. /api/courses does not leak the catalogue to students");
// ---------------------------------------------------------------------------
{
  const src = read("src/app/api/courses/route.ts");
  ok(/requireUser\s*\(/.test(src), "GET /api/courses requires authentication");
  ok(
    /user\.role === "STUDENT"/.test(src),
    "GET /api/courses branches on role"
  );
  ok(
    /getEnrollment\s*\(/.test(src),
    "the student branch resolves real enrollment"
  );
  ok(
    /isEnrolled: false/.test(src),
    "an unenrolled student gets an explicit empty state"
  );
  // The student branch must not be able to return findMany() over all courses.
  const studentBranch =
    /if \(user\.role === "STUDENT"\)[\s\S]*?\n  \}/.exec(src)?.[0] || "";
  ok(
    !/course\.findMany/.test(studentBranch),
    "the student branch never lists all courses"
  );

  // The enroll picker must explicitly opt into the catalogue.
  const enrollView = read("src/components/auth/enroll-view.tsx");
  ok(
    /\/api\/courses\?catalog=1/.test(enrollView),
    "the enroll course picker requests the explicit catalogue variant"
  );
}

// ---------------------------------------------------------------------------
section("6. School-type separation is enforced in SQL");
// ---------------------------------------------------------------------------
{
  const students = read("src/app/api/admin/students/route.ts");
  ok(
    /normalizeSchoolType\(/.test(students),
    "students list normalises the school type server-side"
  );
  ok(
    /where\.schoolType = schoolType/.test(students),
    "ARABIC/LANGUAGE tabs filter in SQL"
  );
  // The regression: UNSPECIFIED was filtered on the client, over one page only.
  ok(
    /unspecifiedOnly/.test(students) && /where\.schoolType = null/.test(students),
    "the UNSPECIFIED tab also filters in SQL (schoolType IS NULL)"
  );

  const dash = read("src/components/admin/admin-dashboard.tsx");
  ok(
    !/all\.filter\(\(s\) => !s\.schoolType\)/.test(dash),
    "the admin UI no longer narrows the school-type tab on the client"
  );

  // Counts must ignore the selected tab, else the other tabs read 0.
  ok(
    /schoolType: _ignoredSchoolType, \.\.\.countWhere/.test(students),
    "tab counts strip the selected school type explicitly"
  );
}

// ---------------------------------------------------------------------------
section("7. Question bank -> mock exam binding");
// ---------------------------------------------------------------------------
{
  const schoolType = read("src/lib/school-type.ts");
  ok(
    /OR: \[\{ schoolType \}, \{ schoolType: null \}\]/.test(schoolType),
    "questionBankFilter = own bank OR shared (schoolType null)"
  );
  ok(
    /includeShared = true/.test(schoolType),
    "sharing is explicit and can be switched off"
  );

  const exam = read("src/app/api/exams/mock/route.ts");
  ok(
    /normalizeSchoolType\(student\.schoolType\)/.test(exam),
    "the student's bank comes from the DB, never from the client"
  );
  ok(
    !/searchParams\.get\("schoolType"\)/.test(exam),
    "the student exam route does NOT accept a client-supplied school type"
  );
  ok(
    /mockExam\.schoolType !== studentSchoolType/.test(exam),
    "a mock exam of the wrong school type is rejected (403)"
  );
  // Every question query in the attempt path must carry the bank filter.
  const questionQueries = exam.match(/db\.(question|examQuestion)\.findMany\(\{[\s\S]*?\n  \}\)/g) || [];
  ok(questionQueries.length >= 2, "both question sources are queried");
  ok(
    questionQueries.every((q) => /bankFilter/i.test(q)),
    "EVERY question query applies a school-type bank filter (selection AND grading)"
  );
  ok(
    /gradingBankFilter/.test(exam),
    "grading rejects out-of-bank question ids (they score 0)"
  );
  ok(
    /getEnrollment\(student\.id\)/.test(exam),
    "an unenrolled student cannot pull an exam"
  );

  const admin = read("src/app/api/admin/mock-exams/route.ts");
  ok(
    /if \(!schoolType\) return err/.test(admin),
    "creating a mock exam REQUIRES a school type"
  );
  ok(
    /questionBankFilter\(schoolType\)/.test(admin),
    "pool sufficiency is checked against the matching bank"
  );
  ok(
    /available < questionCount/.test(admin),
    "an unsatisfiable exam is refused up front"
  );
}

// ---------------------------------------------------------------------------
section("8. Historical attempt data survives question changes");
// ---------------------------------------------------------------------------
{
  const schema = read("prisma/schema.prisma");

  // ExamAttempt keeps a JSON snapshot and only nulls the exam link.
  const examAttempt = /model ExamAttempt \{[\s\S]*?\n\}/.exec(schema)[0];
  ok(
    /mockExam\s+MockExam\?\s+@relation\([^)]*onDelete: SetNull/.test(examAttempt),
    "deleting a MockExam nulls the link instead of deleting attempts"
  );
  ok(
    /answers\s+String/.test(examAttempt),
    "ExamAttempt stores an immutable answers snapshot"
  );

  const mockRoute = read("src/app/api/exams/mock/route.ts");
  ok(
    /answers: JSON\.stringify\(graded\)/.test(mockRoute),
    "the graded snapshot is persisted, so results survive question edits"
  );
  ok(
    /Re-grade on the server/.test(mockRoute) && /keyById/.test(mockRoute),
    "scoring is re-derived server-side from stored answer keys"
  );
  ok(
    !/isCorrect: a\.isCorrect \}/.test(mockRoute),
    "client-sent isCorrect is not used for scoring"
  );

  // MockExamQuestion is only a pin list — cascading it is intentional and
  // must NOT touch attempts.
  const meq = /model MockExamQuestion \{[\s\S]*?\n\}/.exec(schema)[0];
  ok(
    /onDelete: Cascade/.test(meq),
    "pinned-question links cascade (they are pointers, not results)"
  );
  ok(
    !/ExamAttempt/.test(meq),
    "MockExamQuestion has no relation that could cascade into attempts"
  );
}

// ---------------------------------------------------------------------------
section("9. Quiz evidence privacy");
// ---------------------------------------------------------------------------
{
  const media = read("src/app/api/media/[id]/route.ts");
  ok(
    /isQuizEvidence[\s\S]{0,200}user\.role !== "ADMIN"[\s\S]{0,60}403/.test(media),
    "quiz evidence is ADMIN-only in the media route"
  );
  ok(
    /QUIZ_EVIDENCE_ACCESSED/.test(media),
    "every evidence read is audit-logged"
  );
  ok(
    /user\.role === "PARENT"[\s\S]{0,120}Forbidden/.test(media),
    "parents cannot stream private media"
  );
  ok(
    /no-store/.test(media),
    "sensitive media is not cacheable"
  );

  const evidence = read("src/app/api/quizzes/[id]/evidence/route.ts");
  ok(
    /role !== "STUDENT"/.test(evidence),
    "only the student can submit their own evidence"
  );
  ok(
    /retainUntil/.test(evidence),
    "evidence rows carry a retention deadline"
  );

  const adminList = read("src/app/api/admin/quiz-evidence/route.ts");
  ok(
    /requireRole\("ADMIN"\)/.test(adminList),
    "the evidence review list is ADMIN-only"
  );
  ok(
    /\/api\/media\//.test(adminList),
    "the list emits authorized stream URLs, not filesystem paths"
  );

  const monitor = read("src/components/course/quiz-camera-monitor.tsx");
  ok(/audio: false/.test(monitor), "the camera monitor never captures audio");
  ok(
    /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/.test(monitor),
    "the media stream is stopped on unmount (no lingering camera)"
  );
  ok(
    /QuizCameraConsent/.test(monitor),
    "a consent gate component exists"
  );

  const runner = read("src/components/course/quiz-runner.tsx");
  ok(
    /cameraAllowed === null \? \(\s*<QuizCameraConsent/.test(runner),
    "questions are not rendered until the student has decided"
  );
  ok(
    /onDecision=\{beginAttempt\}/.test(runner),
    "declining is a real, handled decision"
  );
}

// ---------------------------------------------------------------------------
section("10. Single-device control quality");
// ---------------------------------------------------------------------------
{
  const security = read("src/lib/security.ts");
  const auth = read("src/lib/auth.ts");

  ok(
    /deviceHashFromHeaders/.test(security),
    "device identity is derived from request headers (server-side)"
  );
  ok(
    !/localStorage/.test(security) && !/localStorage/.test(auth),
    "device identity does NOT depend on localStorage"
  );
  ok(
    /browser family \+ OS family|Reduce the UA/.test(security),
    "the UA is coarsened so patch bumps do not look like a new device"
  );
  ok(
    /SECURITY_HASH_SECRET/.test(security),
    "the device hash is keyed with a server secret (not guessable)"
  );

  ok(
    /IDLE_GRACE_MS/.test(auth),
    "an idle grace window prevents false positives on reconnect"
  );
  ok(
    /SUPERSEDED/.test(auth),
    "same-device re-login supersedes instead of suspending"
  );
  ok(
    /s\.deviceHash !== deviceHash/.test(auth),
    "only a DIFFERENT device counts as a conflict"
  );
  ok(
    /SUSPENDED_MULTI_DEVICE/.test(auth),
    "a real conflict suspends the account"
  );
  ok(
    /user\.status === "SUSPENDED_MULTI_DEVICE"[\s\S]{0,80}reason: "SUSPENDED"/.test(auth),
    "a suspended user is rejected at the session layer (blocks ALL content)"
  );

  const reactivate = read("src/app/api/admin/students/[id]/route.ts");
  ok(
    /revokeAllSessions/.test(reactivate),
    "admin reactivation revokes stale sessions so the student starts clean"
  );
  ok(
    /ACCOUNT_REACTIVATED/.test(reactivate),
    "reactivation is audit-logged"
  );
}

// ---------------------------------------------------------------------------
section("11. Password reset security");
// ---------------------------------------------------------------------------
{
  const request = read("src/app/api/auth/password-reset/request/route.ts");
  const confirm = read("src/app/api/auth/password-reset/confirm/route.ts");

  ok(/checkRateLimit\(/.test(request), "reset requests are rate limited");
  ok(
    /sha256\(/.test(request) && !/tokenHash: token\b/.test(request),
    "only a hash of the token is stored"
  );
  ok(
    /Unknown identifier \(no account\)/.test(request),
    "a missing account still returns the generic success response"
  );
  ok(
    !/console\.log\(\s*token/.test(request),
    "the raw token is not logged directly"
  );

  ok(/attempts/.test(confirm), "confirm enforces a per-token attempt limit");
  ok(/usedAt/.test(confirm), "tokens are single-use");
  ok(
    /revokeAllSessions/.test(confirm),
    "a successful reset revokes every existing session"
  );
  ok(
    /password\.length < 8/.test(confirm),
    "a minimum password length is enforced"
  );
  ok(
    /hashPassword|bcrypt/.test(confirm),
    "the new password is hashed, never stored in plaintext"
  );
}


// ---------------------------------------------------------------------------
// 9. Quiz answer-key confidentiality + session gating on the quiz routes.
//
//    Regression: GET /api/quizzes/[id] used to serialize `answer` and
//    `explanation` for every question and rely on the runner to hide them,
//    so any student could read the full answer key from the browser console
//    before submitting. It also performed no session-lock check, so the
//    questions of a locked future session were readable by id.
// ---------------------------------------------------------------------------
{
  const quizGet = read("src/app/api/quizzes/[id]/route.ts");
  const quizStart = read("src/app/api/quizzes/[id]/start/route.ts");
  const quizSubmit = read("src/app/api/quizzes/[id]/submit/route.ts");
  const runner = read("src/components/course/quiz-runner.tsx");

  ok(
    /canAccessLesson/.test(quizGet),
    "GET /api/quizzes/[id] gates on canAccessLesson"
  );
  ok(
    /canAccessLesson/.test(quizStart),
    "POST /api/quizzes/[id]/start gates on canAccessLesson"
  );
  ok(
    /canAccessLesson/.test(quizSubmit),
    "POST /api/quizzes/[id]/submit gates on canAccessLesson"
  );

  // The only place `answer:` may appear in the GET payload is behind the
  // non-student branch.
  ok(
    /isStudent \? \{\} : \{ answer: q\.answer, explanation: q\.explanation \}/.test(
      quizGet
    ),
    "the answer key is only serialized for non-student (staff) callers"
  );
  ok(
    !/^\s*answer: q\.answer,\s*$/m.test(quizGet),
    "no unconditional `answer: q.answer` in the quiz payload"
  );
  ok(
    !/^\s*explanation: q\.explanation,\s*$/m.test(quizGet),
    "no unconditional `explanation: q.explanation` in the quiz payload"
  );

  // The client type must not declare the fields either — that is what made
  // the leak look intentional to reviewers.
  const qType = runner.slice(
    runner.indexOf("type Question = {"),
    runner.indexOf("type QuizData = {")
  );
  ok(
    !/\banswer:\s*string/.test(qType),
    "the runner's Question type no longer expects a correct answer"
  );
  ok(
    !/\bexplanation:/.test(qType),
    "the runner's Question type no longer expects an explanation"
  );

  // Explanations must still reach the student AFTER grading, otherwise the
  // results screen loses its educational value.
  ok(
    /explanation: a\.explanation/.test(quizSubmit),
    "graded /submit response still returns per-question explanations"
  );
}


// ---------------------------------------------------------------------------
// 12. Stage 2 — locked-session content must not leak from ANY route, and the
//     progress heartbeats must be race-safe.
//
//     Securing the lesson page alone is not enough: the course tree, the
//     assignment list, the batch video list, the video heartbeats and the raw
//     media stream each returned or accepted locked-session data.
// ---------------------------------------------------------------------------
section("12. Locked-session leakage across every content route");
{
  const courseRoute = read("src/app/api/courses/[slug]/route.ts");
  const homeworkRoute = read("src/app/api/students/me/homework/route.ts");
  const videosRoute = read("src/app/api/students/me/session-videos/route.ts");
  const videoBeat = read(
    "src/app/api/students/me/session-videos/[id]/progress/route.ts"
  );
  const lessonBeat = read("src/app/api/lessons/[id]/video-progress/route.ts");
  const mediaRoute = read("src/app/api/media/[id]/route.ts");
  const lib = read("src/lib/session-progress.ts");

  ok(
    /export function redactLockedLesson/.test(lib),
    "a shared locked-lesson redaction helper exists"
  );
  // The helper must actually strip the content fields, not just exist.
  for (const field of ["videoUrl", "pdfUrl", "summary", "description", "quiz"]) {
    ok(
      new RegExp(`${field}: null`).test(lib),
      `redactLockedLesson nulls \`${field}\``
    );
  }

  ok(
    /redactLockedLesson/.test(courseRoute),
    "the course tree redacts locked sessions"
  );
  ok(
    /statusById\[lesson\.id\] === "locked"/.test(courseRoute),
    "redaction is keyed off the server-computed locked status"
  );

  ok(
    /getCourseSessionProgress/.test(homeworkRoute),
    "the assignment list resolves session progression"
  );
  ok(
    /unlocked\.has\(h\.lesson\.id\)/.test(homeworkRoute),
    "assignments of locked sessions are filtered out"
  );

  ok(
    /getCourseSessionProgress/.test(videosRoute),
    "the batch video list resolves session progression"
  );
  ok(
    /!v\.lessonId \|\| unlocked\.has\(v\.lessonId\)/.test(videosRoute),
    "videos of locked sessions are filtered out, unbound videos stay visible"
  );

  ok(
    /canAccessLesson/.test(videoBeat),
    "the batch video heartbeat refuses locked sessions"
  );
  ok(
    /canAccessLesson/.test(mediaRoute),
    "the media stream checks session unlock, not just batch membership"
  );

  // Race safety on both heartbeats.
  for (const [name, src] of [
    ["batch session video", videoBeat],
    ["lesson video", lessonBeat],
  ]) {
    ok(
      /db\.\$transaction/.test(src),
      `${name} heartbeat computes and writes inside a transaction`
    );
    ok(
      /watchedSec: \{ lte: watchedSec \}|videoWatchedSec: \{ lte: watchedSec \}/.test(
        src
      ),
      `${name} heartbeat only ever advances watched time (monotonic guard)`
    );
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
