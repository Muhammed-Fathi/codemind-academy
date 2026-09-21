// CodeMind Academy — manual-QA stabilization pins.
//
// The Phase H suite proves ENGINE behavior against a mock db. This suite pins
// the stabilization CONTRACT around it: the UI renders server truth through
// the requirement trichotomy (never local derivation), prev/next navigation
// follows the engine's canonical chain (never a second order), and the hot
// student surfaces issue ONE canonical engine evaluation per request (no
// duplicate loads, no refetch loops). Source-invariant by design: these are
// the exact regressions manual QA reported, and a silent reintroduction must
// fail loudly here.
//
// Run: node tests/manual-qa-stabilization.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const fs = require("fs");
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
    console.error("FAIL:", label);
  }
};
const section = (t) => console.log(`\n${t}`);
const count = (src, sub) => src.split(sub).length - 1;
// Code-only view: documentation comments name excluded concepts on purpose.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

function main() {
  const lessonView = read("src/components/course/student-lesson.tsx");
  const treeView = read("src/components/course/student-course.tsx");
  const dashView = read("src/components/student/student-dashboard.tsx");
  const lessonRoute = read("src/app/api/lessons/[id]/route.ts");
  const courseRoute = read("src/app/api/courses/[slug]/route.ts");
  const dashRoute = read("src/app/api/students/me/dashboard/route.ts");
  const parentDashRoute = read("src/app/api/parents/me/dashboard/route.ts");
  const engine = read("src/lib/progression.ts");
  const facade = read("src/lib/session-progress.ts");
  const catchup = read("src/lib/catchup.ts");
  const dict = read("src/lib/i18n-dict-2026.ts");

  section("Navigation — one canonical chain, working Previous");
  // N1: prev/next moves the store's lessonId — the view's fetch key.
  const goto = /const gotoLesson = \(id: string\) => \{[\s\S]*?\n  \};/.exec(lessonView);
  ok(!!goto, "N1a: gotoLesson exists on the lesson view");
  ok(!!goto && goto[0].includes("setLessonId(id)"), "N1b: gotoLesson moves the store lessonId (the fetch key)");
  ok(!!goto && goto[0].includes('setView("student-lesson")'), "N1c: gotoLesson stays on the lesson view");
  ok(!!goto && !/unlocked|isLocked|requirements/.test(goto[0]), "N1d: the client never pre-filters targets — a locked target renders the server denial panel");
  ok(lessonView.includes("const activeLessonId = lessonId"), "N1e: the fetch key derives from the store lessonId");
  // N2: the server chain IS the engine order — never a second definition.
  ok(lessonRoute.includes("orderCourseLessons(found, courseId)"), "N2a: prev/next walks orderCourseLessons");
  ok(/from "@\/lib\/session-progress"/.test(lessonRoute) && lessonRoute.includes("orderCourseLessons,"), "N2b: the order comes from the progression façade");
  ok(facade.includes('} from "@/lib/progression"') && facade.includes("orderCourseLessons,"), "N2c: the façade re-exports the ENGINE's order (single definition)");
  // N3: the chain slice matches the unlock chain (status + archive + track + course).
  const chainBlock = lessonRoute.slice(lessonRoute.indexOf("const found = await db.lesson.findMany"), lessonRoute.indexOf("const ordered = orderCourseLessons"));
  ok(chainBlock.includes("LESSON_STUDENT_STATUS_FILTER"), "N3a: prev/next walks the PUBLISHED student curriculum only");
  ok(chainBlock.includes("EXCLUDE_ARCHIVED_LESSON"), "N3b: archived history is never a navigation target");
  ok(chainBlock.includes("viewerTrackFilter"), "N3c: prev/next never crosses the viewer's track");
  ok(chainBlock.includes("lessonCourseChainOr(courseId)"), "N3d: prev/next never crosses the course boundary");
  // N4: first-lesson behavior + direct neighbors (hold recovery stays reachable).
  ok(lessonRoute.includes("if (currentIdx > 0) prevLessonId = ordered[currentIdx - 1].id;"), "N4a: the first lesson has no Previous (null, not a wrap or a guess)");
  ok(lessonRoute.includes("nextLessonId = ordered[currentIdx + 1].id"), "N4b: Next is the direct chain neighbor");
  ok(!/ordered\.(filter|find)\(/.test(chainBlock + lessonRoute.slice(lessonRoute.indexOf("const ordered"), lessonRoute.indexOf("nextLessonId ="))), "N4c: no skip-over filtering — every neighbor (incl. hold-blocked recovery) stays reachable");
  const prevBlock = lessonView.slice(lessonView.indexOf("{data.prevLessonId ? ("), lessonView.indexOf("{data.nextLessonId ? ("));
  ok(prevBlock.includes("<span />") && !prevBlock.includes("disabled"), "N4d: no Previous button renders on the first lesson (no dead control)");

  section("Requirement trichotomy — server truth, rendered verbatim");
  // T1: the branch order is required-FIRST (absent components report done=true).
  ok(/const state = !req\.required\n    \? "absent"\n    : req\.done\n      \? "done"\n      : "pending";/.test(lessonView), "T1a: RequirementRow branches on required first");
  ok(lessonView.includes('{state === "done" ? (') && lessonView.includes('{state === "absent" ? ('), "T1b: the green check renders ONLY for REQUIRED_COMPLETE");
  ok(!lessonView.includes("{req.done ?"), "T1c: the old done-first ternary is gone (it checked absent components green)");
  ok(lessonView.includes('t("course.224")'), "T1d: NOT_REQUIRED renders the localized badge");
  ok(dict.includes('"course.224": { ar: "مش مطلوب", en: "Not required" }'), "T1e: the NOT_REQUIRED copy is exact");
  // T2: the video-percent bars are LABELED (no bare Completed + 0%).
  ok(dict.includes('"course.242"') && /"course\.242": \{\s*ar: "تقدم الفيديو",\s*en: "Video progress",\s*\}/.test(dict), "T2a: the video-progress label exists (ar/en)");
  ok(lessonView.includes('t("course.242")'), "T2b: the lesson header bar uses the video-progress label");
  ok(dashView.includes('t("course.242")') && dashView.includes('t("student.126")'), "T2c: Continue Learning labels the bar, completed keeps its own label");
  ok(!dashView.includes(': "Progress"'), "T2d: the unlabeled whole-lesson Progress string is gone");
  // T3: authority pins — video = Lesson.videoUrl, recordings display-only.
  ok(engine.includes("const videoRequired = lesson.hasLegacyVideo;"), "T3a: video requiredness is the legacy column only");
  ok(engine.includes("hasLegacyVideo: !!l.videoUrl,"), "T3b: the loader maps it from Lesson.videoUrl presence");
  ok(!/sessionvideo/i.test(stripComments(engine)), "T3c: the engine references no SessionVideo in code (telemetry/display only)");
  ok(!/sessionvideo/i.test(stripComments(facade)), "T3d: the façade references no SessionVideo in code either");
  // T4: quiz PASS + homework SUBMITTED semantics untouched.
  ok(engine.includes("lesson.quizIds.every((q) => facts.passedQuizIds.has(q))"), "T4a: quiz completion is still every-required-quiz PASSED");
  ok(engine.includes("lesson.homeworkIds.every((h) => facts.submittedHomeworkIds.has(h))"), "T4b: homework completion is still every-required-homework SUBMITTED");

  section("Empty-lesson boundary — backend authority (source mirror)");
  // Behavior is proven in the Phase H suite (CASE 1/35g-h/39–43); these pins
  // catch a silent reintroduction of vacuous completion at the source.
  ok(engine.includes("hasAnyRequirement && videoDone && quizDone && homeworkDone"), "E1a: completion requires ≥1 requirement");
  ok(engine.includes('| "NO_COMPLETION_REQUIREMENTS";'), "E1b: the boundary has its stable machine code");
  ok(engine.includes('NO_COMPLETION_REQUIREMENTS: "لا توجد متطلبات إكمال لهذا الدرس",'), "E1c: the boundary has its Arabic reason");
  ok(engine.includes('unmet.push("NO_COMPLETION_REQUIREMENTS")'), "E1d: the empty lesson reports its boundary (never a fabricated requirement)");
  const syncFn = engine.slice(engine.indexOf("export async function syncDerivedCompletion"));
  ok(syncFn.indexOf("if (!evaluation?.completed) return") < syncFn.indexOf("db.lessonProgress.upsert"), "E2a: the sync guard exits before any write (empty lessons sync nothing)");
  ok(!/isCompleted:\s*false/.test(syncFn), "E2b: the sync never writes isCompleted=false (monotonic mirror)");
  ok(engine.includes("eligible: unmet.length === 0,"), "E3a: catch-up eligibility is nothing-pending");
  ok(!engine.includes("eligible: evaluation.completed"), "E3b: eligibility never reads the completion fact (false for empty by contract)");

  section("Perf — one canonical evaluation per request, no refetch loops");
  // P1: the student dashboard loads the engine ONCE.
  ok(count(dashRoute, "getCourseSessionProgress(") === 1, "P1a: dashboard route — exactly ONE engine call");
  ok(!stripComments(dashRoute).includes("getUnlockedLessonIds"), "P1b: the retired second engine load is gone from code");
  ok(dashRoute.includes("if (row.unlocked) unlockedLessonIds.add(row.lessonId);"), "P1c: the open-set derives from the SAME evaluation");
  // P2: the course payload fans its three independent reads out concurrently.
  ok(courseRoute.includes("const [progresses, contentByLesson, sessionProgress] = await Promise.all(["), "P2a: progress + content + engine resolve concurrently");
  ok(count(courseRoute, "getCourseSessionProgress(") === 1, "P2b: course route — exactly ONE engine call (inside the fan-out)");
  ok(courseRoute.includes("if (sessionProgress) {"), "P2c: statuses consume the fanned-out evaluation (no second call)");
  // P3: the tree loads once per entry and ALWAYS clears its skeleton.
  ok(treeView.includes(".then(() => setLoading(false))"), "P3a: loading clears unconditionally on success");
  ok(!stripComments(treeView).includes("if (navParam)"), "P3b: no navParam gate can strand the skeleton (the Ctrl+F5 defect)");
  ok(treeView.includes("return fetch(`/api/courses/${encodeURIComponent(authoritativeSlug)}`)"), "P3c: the authoritative slug fetches immediately (no state round-trip)");
  ok(treeView.includes("}, [tr, setNavParam, setCourseSlug]);"), "P3d: the load effect depends on stable callbacks only (one load per entry)");
  ok(count(treeView, "reload();") === 1, "P3e: exactly one reload call site (no refetch loop)");

  section("Consistency — parent, hold/catch-up, direct-access gates");
  ok(lessonRoute.includes("isParentLessonPreviewAllowed("), "S1a: parents preview through the shared lifecycle+track+course gate");
  ok(parentDashRoute.includes("getCourseSessionProgress("), "S1b: the parent dashboard reads the SAME engine (parent consistency)");
  ok(dashRoute.includes("LESSON_STUDENT_STATUS_FILTER") && dashRoute.includes("viewerTrack") && dashRoute.includes("EXCLUDE_ARCHIVED_LESSON"), "S2a: the dashboard universe stays PUBLISHED + own-track + non-archived");
  ok(courseRoute.includes("if (!enrollment.isEnrolled || enrollment.courseId !== course.id) {") && courseRoute.includes("{ status: 403 }"), "S2b: direct course access still 403s for the unenrolled");
  ok(lessonRoute.includes("denyProgression") || lessonRoute.includes("canAccessLesson"), "S2c: direct lesson access still runs the progression gate");
  ok(catchup.includes('resolveHoldForCatchup } from "@/lib/absence-review"'), "S3a: catch-up resolves THROUGH the Phase F authority (no second lifecycle)");
  ok(engine.includes("export async function evaluateStudentCatchup") && engine.includes("toCatchupHoldView"), "S3b: the catch-up view stays engine-derived");

  console.log(`\nmanual-QA stabilization: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(`\n${fail} FAILURE(S):`);
    for (const f of failures) console.error(" -", f);
    process.exitCode = 1;
  }
}

main();
