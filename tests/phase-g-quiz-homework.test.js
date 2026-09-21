// Phase G dedicated acceptance pins: 45 enumerated, offline/source-level checks.
const fs = require("fs"), path = require("path");
const R = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(R, p), "utf8");
let pass=0, fail=0;
function ok(v, label){ if(v) pass++; else { fail++; console.error(`FAIL ${pass+fail}: ${label}`); } }
const schema=read("prisma/schema.prisma"), pg=read("prisma/postgres/schema.prisma");
const quiz=read("src/app/api/teacher/quizzes/route.ts"), qpub=read("src/app/api/teacher/quizzes/[id]/publish/route.ts");
const qdup=read("src/app/api/teacher/quizzes/[id]/duplicate/route.ts"), qprev=read("src/app/api/teacher/quizzes/[id]/preview/route.ts");
const hw=read("src/app/api/teacher/homework/route.ts"), hpub=read("src/app/api/teacher/homework/[id]/publish/route.ts"), hclose=read("src/app/api/teacher/homework/[id]/close/route.ts");
const grade=read("src/app/api/teacher/homework/[id]/grade/route.ts"), media=read("src/app/api/media/[id]/route.ts");
const sp=read("src/lib/session-progress.ts"), content=read("src/lib/lesson-content.ts");
const qpatch=read("src/app/api/teacher/questions/[id]/route.ts"), qappend=read("src/app/api/teacher/quizzes/[id]/questions/route.ts");
const migration=read("prisma/migrations/20260919180000_phase_g_quiz_homework_workflow/migration.sql");
// 01-08 schema/lifecycle
ok(schema.includes('status      String        @default("PUBLISHED")'),'01 quiz status default');
ok(schema.includes('publishedAt DateTime?'),'02 publishedAt exists');
ok(schema.includes('attachmentId String?'),'03 homework attachment relation');
ok(schema.includes('homeworkAttachments Homework[]'),'04 media attachment reverse relation');
ok(schema.includes('homeworkSubmissions HomeworkSubmission[]'),'05 media submission reverse relation');
ok(schema.includes('LATE'),'06 late status exists');
ok(pg.includes('status') && pg.includes('PUBLISHED'),'07 PG lifecycle column');
ok(migration.includes('Phase G'),'08 additive Phase G migration');
// 09-16 quiz workflow
ok(quiz.includes('status: "DRAFT"'),'09 new quizzes start draft');
ok(qpub.includes('QUIZ_PUBLISHED'),'10 publish audit');
ok(qpub.includes('validateQuizForPublish'),'11 structural publish validation');
ok(qpub.includes('notifyAssessmentPublished'),'12 publish notification');
ok(qprev.includes('QuizAttempt'),'13 preview considers attempt model');
ok(qprev.includes('export async function GET'),'14 preview route exists');
ok(qdup.includes('DRAFT'),'15 duplicate starts draft');
ok(qdup.includes('QuizDuplicated') || qdup.includes('QUIZ_DUPLICATED'),'16 duplicate audit');
// 17-24 homework lifecycle/files/grading
ok(hw.includes('status: "DRAFT"'),'17 new homework starts draft');
ok(hpub.includes('HOMEWORK_PUBLISHED'),'18 homework publish audit');
ok(hclose.includes('HOMEWORK_CLOSED'),'19 homework close audit');
ok(hclose.includes('CLOSED'),'20 close transition');
ok(grade.includes('maxMarks'),'21 grade cap authority');
ok(grade.includes('gradedById'),'22 grader recorded');
ok(grade.includes('gradedAt'),'23 grade timestamp recorded');
ok(hw.includes('deadline'),'24 original deadline retained');
// 25-31 visibility/progression
// Phase H: the requirement filters moved into the canonical engine as
// allowlists (quizzes PUBLISHED-only, homework PUBLISHED-or-CLOSED) — DRAFT
// is excluded by construction, with no second filter in the adapter.
const eng=read("src/lib/progression.ts");
ok(eng.includes('where: { status: "PUBLISHED" }')&&eng.includes('status: { in: ["PUBLISHED", "CLOSED"] }'),'25 draft excluded from requirements');
ok(sp.includes('status !== "PUBLISHED"'),'26 quiz access requires published');
ok(sp.includes('status === "DRAFT"'),'27 homework draft gate');
ok(content.includes('rowLifecycleVisible'),'28 shared visibility authority');
ok(content.includes('STAFF'),'29 staff sees drafts');
ok(read("src/app/api/lessons/[id]/route.ts").includes('filterStudentLessonRows'),'30 lesson payload hides drafts');
ok(read("src/app/api/quizzes/[id]/start/route.ts").includes('PUBLISHED'),'31 start route hides drafts');
// 32-37 lock/race safety
ok(qpatch.includes('acquireQuizDestructiveLock'),'32 patch acquires lock');
ok(qappend.includes('acquireQuizDestructiveLock'),'33 append acquires lock');
ok(qpatch.includes('QuestionPatchValidationError'),'34 patch lock refusal');
ok(qappend.includes('QuizLockedError'),'35 append lock refusal');
ok(qpatch.includes('transaction'),'36 patch transaction');
ok(qappend.includes('transaction'),'37 append transaction');
// 38-42 media security
ok(media.includes('homeworkAttachments'),'38 attachment authorization');
ok(media.includes('homeworkSubmissions'),'39 submission authorization');
ok(media.includes('canAccessHomework'),'40 student homework gate');
ok(media.includes('teacherCourseIds'),'41 teacher chain scope');
ok(media.includes('Forbidden'),'42 fail-closed media');
// 43-45 regression/tooling
ok(read("scripts/db/verify-phase-g-pg-parity.mjs").includes('PHASE_G_PG_CATALOG_IDENTICAL_OK'),'43 PG parity verifier');
ok(read("tests/migration-providers.test.js").includes('MIG_PHASE_G'),'44 migration provider coverage');
ok(read("src/components/teacher/teacher-sessions.tsx").includes('lifecycleLabel'),'45 teacher lifecycle UI');
console.log(`phase-g-quiz-homework-workflow: ${pass} passed, ${fail} failed`);
process.exitCode=fail?1:0;
