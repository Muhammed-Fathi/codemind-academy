/**
 * M3.3 — Teacher attempt navigation and selected-attempt context regression pins.
 *
 * Source checks cover the Teacher-only app-shell path and visible context;
 * the Phase 26D real-SQLite verifier exercises the shipped nested route,
 * ownership/mismatched-ID denials, canonical duplicate-code identity, and the
 * shared open/finished answer-key policy.
 *
 * Run: node tests/teacher-attempt-navigation-m33.test.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const ok = (condition, message) => {
  if (!condition) {
    failures.push(message);
    console.error(`FAIL - ${message}`);
    return;
  }
  passed++;
  console.log(`ok - ${message}`);
};
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const failures = [];
let passed = 0;

const store = read("src/lib/store.ts");
const dashboard = read("src/components/teacher/teacher-dashboard.tsx");
const authoring = read("src/components/teacher/teacher-authoring.tsx");
const attemptRoute = read("src/app/api/teacher/quizzes/[id]/attempts/[attemptId]/route.ts");
const quizDetailRoute = read("src/app/api/teacher/quizzes/[id]/route.ts");
const quizListRoute = read("src/app/api/teacher/quizzes/route.ts");
const dashboardRoute = read("src/app/api/teacher/dashboard/route.ts");
const inspector = read("src/lib/session-quiz.ts");
const runtime = read("scripts/verify-phase26d-teacher.mjs");

console.log("\nM3.3 Teacher attempt navigation + context");
ok(/export type TeacherQuizAttemptTarget\s*=\s*\{\s*quizId:\s*string;\s*attemptId:\s*string\s*\};/.test(store), "store models a dedicated quizId + attemptId review target");
ok(/openTeacherQuizAttempt:\s*\(quizId, attemptId\)\s*=>\s*set\([\s\S]*?view:\s*"teacher-quizzes"[\s\S]*?teacherQuizAttempt:\s*\{\s*quizId,\s*attemptId\s*\}/.test(store), "review action enters the Teacher quizzes app-shell view with both canonical IDs");
ok(/clearTeacherQuizAttempt:\s*\(\)\s*=>\s*set\(\{\s*teacherQuizAttempt:\s*null\s*\}\)/.test(store), "closing the review clears its dedicated target");

const activityStart = dashboard.indexOf("function ActivityRow(");
const activityEnd = dashboard.indexOf("\nfunction OverviewSkeleton", activityStart);
const activityRow = stripComments(dashboard.slice(activityStart, activityEnd));
ok(activityStart >= 0 && activityEnd > activityStart, "dashboard attempt activity has a dedicated row component");
ok(/openTeacherQuizAttempt\(item\.quizId!,\s*item\.attemptId!\)/.test(activityRow), "dashboard click carries quizId and attemptId into Teacher navigation");
ok(/data-testid="dashboard-attempt-review-button"/.test(activityRow), "dashboard review control is directly testable");
ok(/data-course-id=\{item\.course\.id\}/.test(activityRow) && /data-lesson-id=\{item\.lesson\?\.id\}/.test(activityRow), "dashboard review control carries canonical course and lesson IDs");
ok(/AcademicLevelBadge level=\{item\.course\.academicLevel\}/.test(activityRow), "recent activity displays its canonical Course Academic Level");
ok(!/<a\b|\bhref\s*=|\/teacher\/sessions\?quizId/.test(activityRow), "dashboard attempt navigation is not a raw anchor or generic session deep link");
ok(/TeacherQuizAttemptReviewDialog[\s\S]*?quizId=\{reviewTarget\.quizId\}[\s\S]*?attemptId=\{reviewTarget\.attemptId\}/.test(dashboard), "Teacher quizzes view opens the selected-attempt review dialog with both IDs");

console.log("\nNested authorization + attempt inspection");
ok(/export async function GET\(/.test(attemptRoute) && !/export async function POST\(/.test(attemptRoute), "selected-attempt endpoint is read-only GET only");
ok(/user\.role !== "TEACHER"/.test(attemptRoute), "selected-attempt endpoint enforces the Teacher role");
ok(/db\.quiz\.findUnique\(\{\s*where:\s*\{\s*id:\s*quizId\s*\}/.test(attemptRoute), "route loads the quiz by canonical route ID before attempt data");
ok(/teacherCourseIds\(teacher\)\.includes\(placement\.courseId\)/.test(attemptRoute), "route independently reauthorizes canonical Teacher course ownership");
ok(/db\.quizAttempt\.findFirst\(\{\s*where:\s*\{\s*id:\s*attemptId,\s*quizId\s*\}/.test(attemptRoute), "attempt lookup binds selected attempt ID and quiz ID in one predicate");
ok(/buildAttemptInspection\(attempt/.test(attemptRoute) && /revealAnswerKey:\s*true/.test(attemptRoute), "selected review uses the shared inspection builder");
ok(/canGrantRetry:\s*false/.test(attemptRoute), "selected review explicitly has no Teacher retry grant authority");
ok(!/quizRetryGrant\.create|grantRetry|retryGrant\.create/.test(attemptRoute), "selected review route adds no retry grant mutation");
ok(/course:\s*\{[\s\S]*?id:\s*placement\.courseId[\s\S]*?academicLevel:\s*placement\.courseAcademicLevel/.test(attemptRoute), "review course identity and Academic Level come from canonical placement");
ok(/officialCode:\s*lesson\.officialCode[\s\S]*?title:\s*lesson\.title/.test(attemptRoute), "review lesson official code and title come from the selected lesson relation");
ok(/student:\s*\{[\s\S]*?id:\s*attempt\.student\.id[\s\S]*?email:\s*attempt\.student\.user\.email/.test(attemptRoute), "selected student identity is attached to the exact selected attempt");
ok(/const reveal = terminal && opts\.revealAnswerKey !== false/.test(inspector), "shared inspector always hides the answer key while the attempt is open");
ok(/attempt\.answerKeyRevealed\s*&&\s*question\.correctAnswer/.test(authoring), "review UI renders correct answers only when the server reveals the key");
ok(/data\.attempt\.questions\.map\(/.test(authoring), "review UI exposes meaningful per-question inspection");
ok(/data\??\.attempt\.finishedAt/.test(authoring) && /data\.attempt\.score/.test(authoring) && /data\.attempt\.passed/.test(authoring), "review UI uses persisted terminal score and pass semantics");
ok(!/\/api\/quizzes\/|\/teacher\/sessions\?quizId/.test(authoring), "Teacher review UI does not fetch a Student quiz runner or generic deep link");
const reviewStart = authoring.indexOf("export function TeacherQuizAttemptReviewDialog");
const reviewEnd = authoring.indexOf("\nfunction QuestionRow", reviewStart);
const reviewDialogCode = stripComments(authoring.slice(reviewStart, reviewEnd));
ok(reviewStart >= 0 && reviewEnd > reviewStart && !/retry|grant/i.test(reviewDialogCode), "review dialog exposes no retry/grant action");
ok(/AcademicLevelBadge level=\{data\.quiz\.course\.academicLevel/.test(reviewDialogCode), "review visibly displays the canonical Academic Level");
ok(/localized\(data\.quiz\.course\.name,\s*data\.quiz\.course\.nameAr\)/.test(reviewDialogCode), "review visibly displays the canonical Course name");
ok(/data\.quiz\.lesson\?\.officialCode/.test(reviewDialogCode), "review visibly displays the selected lesson official code");
ok(/localized\(data\.quiz\.lesson\?\.title,\s*data\.quiz\.lesson\?\.titleAr\)/.test(reviewDialogCode), "review visibly displays the selected lesson title");
ok(/localized\(data\.quiz\.title,\s*data\.quiz\.titleAr\)/.test(reviewDialogCode), "review visibly displays the selected quiz title");
ok(/data\.attempt\.student\.name/.test(reviewDialogCode) && /data\.attempt\.student\.email/.test(reviewDialogCode), "review visibly identifies the selected student");
ok(/data\.attempt\.attemptNumber/.test(reviewDialogCode) && /data\.attempt\.id\.slice/.test(reviewDialogCode), "review visibly identifies the selected attempt");

console.log("\nCanonical context propagation");
ok(/lesson:\s*\{\s*select:\s*LESSON_PLACEMENT_SELECT\s*\}/.test(attemptRoute), "attempt route resolves canonical lesson/course relations, not displayed labels");
ok(/academicLevel:\s*lessonCourse\.academicLevel/.test(quizListRoute), "quiz list preserves Course.academicLevel alongside canonical course ID");
ok(/AcademicLevelBadge level=\{quiz\.lesson\.course\.academicLevel\}/.test(dashboard), "quiz cards display the course level context");
ok(/courseId:\s*g\.courseId/.test(dashboardRoute) && /academicLevel:\s*g\.course\?\.academicLevel/.test(dashboardRoute), "recent activity carries canonical group-course ID and Course level");
ok(/lesson:\s*attempt\.quiz\.lesson/.test(dashboardRoute) && /officialCode:\s*true/.test(dashboardRoute), "recent activity carries the quiz's related lesson identity and official code");
ok(/data-testid="question-manager-context"/.test(authoring) && /detail\.data\.lesson\.course\.academicLevel/.test(authoring), "question manager shows canonical Academic Level/course/lesson context");
ok(/data-course-id=\{quiz\.lesson\?\.course\?\.id\}/.test(dashboard), "quiz card exposes canonical course identity for the review context");
ok(/same printed code|duplicate-code|sameCodeLesson\.id/.test(runtime) && /sameCodeCourse\.id/.test(runtime), "runtime coverage includes the same printed lesson code at different Academic Levels");
ok(/mismatchedPair\.status,\s*404/.test(runtime) && /tReviewForeign\.status,\s*403/.test(runtime), "runtime coverage exercises mismatched-ID and foreign-quiz refusals");
ok(/tReviewOpen\.json\.attempt\.answerKeyRevealed,\s*false/.test(runtime) && /tReviewFinished\.json\.attempt\.answerKeyRevealed,\s*true/.test(runtime), "runtime coverage checks open and finished answer-key behavior");

console.log(`\nteacher-attempt-navigation-m33: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
