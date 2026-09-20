// GET /api/teacher/quizzes/[id]/preview — Phase G
//
// The teacher's PRE-PUBLISH preview of a quiz. Two hard contracts:
//
//   1. ZERO WRITES. The route performs no mutation at all — no QuizAttempt,
//      no QuizAnswer, no retry grant, no audit row. A preview can never
//      consume a student's attempt entitlement or freeze anything.
//   2. STUDENT-FACING STRUCTURE. The question set is rendered through the
//      SAME blueprint authority the attempt start uses
//      (`resolveQuizBlueprint` + the live eligible pool), so the teacher
//      previews exactly what a student would receive — mode, attempt config,
//      pass mark, time limit, questions with options/marks/difficulty.
//
// For BLUEPRINT quizzes the selection is a DRY RUN with an injectable RNG:
// it shows one possible paper and says so, because the real paper is chosen
// per attempt. Answers ARE shown (this is a teacher surface).
//
// AUTHORIZATION: TEACHER role → quiz → lesson → course, canonical chain
// first, course must be one of the teacher's own.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import {
  LESSON_PLACEMENT_SELECT,
  lessonPlacement,
  questionPayload,
  teacherCourseIds,
  type ChainLesson,
} from "@/lib/teacher-content";
import { resolveQuizBlueprint, selectAttemptQuestions } from "@/lib/quiz-blueprint";
import { validateQuizForPublish, quizServedTracks } from "@/lib/quiz-lifecycle";
import { isQuestionEligible } from "@/lib/track-scope";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const tApi = await getServerT();
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const quiz = await db.quiz.findUnique({
    where: { id },
    include: { lesson: { select: LESSON_PLACEMENT_SELECT } },
  });
  if (!quiz) return err(tApi("api.248"), 404);
  const placement = lessonPlacement((quiz.lesson ?? null) as ChainLesson | null);
  if (!placement || !teacherCourseIds(teacher).includes(placement.courseId)) {
    return err(tApi("api.180"), 403);
  }

  const questions = await db.question.findMany({
    where: { quizId: id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const blueprint = resolveQuizBlueprint(quiz);
  const tracks = quizServedTracks(quiz.trackScope);

  // One representative paper per served track, chosen by the LIVE selection
  // service with a deterministic RNG — a dry run, never persisted.
  const samples = tracks.map((track) => {
    const eligible = questions.filter((q) => isQuestionEligible(track, q.schoolType));
    let selectedIds: string[];
    try {
      const { questions: chosen } = selectAttemptQuestions({
        pool: eligible,
        blueprint,
        schoolType: track,
        random: (() => {
          let s = 7;
          return () => {
            s = (s * 1103515245 + 12345) % 2147483648;
            return s / 2147483648;
          };
        })(),
      });
      selectedIds = chosen.map((q) => q.id);
    } catch {
      selectedIds = eligible.map((q) => q.id);
    }
    return { track, questionIds: selectedIds, eligibleCount: eligible.length };
  });
  // FIXED quizzes serve EVERY eligible question of the served track(s); the
  // sample draw already equals that set. BLUEPRINT quizzes get one
  // representative draw (the union over served tracks).
  const previewIds = new Set<string>(samples.flatMap((s) => s.questionIds));
  const previewQuestions = questions.filter((q) => previewIds.has(q.id));

  const publishCheck = validateQuizForPublish({
    quiz: {
      quizMode: quiz.quizMode,
      questionCount: quiz.questionCount,
      difficultyPlan: quiz.difficultyPlan,
      shuffleOptions: quiz.shuffleOptions,
      maxAttempts: quiz.maxAttempts,
      trackScope: quiz.trackScope,
    },
    questions,
  });

  return ok({
    preview: {
      quiz: {
        id: quiz.id,
        title: quiz.titleAr || quiz.title,
        titleRaw: quiz.title,
        description: quiz.description,
        status: quiz.status,
        publishedAt: quiz.publishedAt,
        passMark: quiz.passMark,
        timeLimit: quiz.timeLimit,
        trackScope: quiz.trackScope,
        blueprint: {
          ...blueprint,
          // The selection diagnostics a teacher cares about, plainly.
          eligiblePerTrack: samples.map((s) => ({
            track: s.track,
            eligible: s.eligibleCount,
            served: s.questionIds.length,
          })),
        },
        totalMarks: previewQuestions.reduce((sum, q) => sum + (q.marks || 0), 0),
        questionCount: previewQuestions.length,
        // BLUEPRINT papers vary per attempt — the preview is ONE possible draw.
        sampleNote: blueprint.mode === "BLUEPRINT",
      },
      questions: previewQuestions.map((q) => ({
        ...questionPayload(q),
      })),
      // The exact verdict the publish route will reach right now.
      publishable: publishCheck.ok,
      problems: publishCheck.ok
        ? []
        : publishCheck.problems.map((p) => ({
            code: p.code,
            questionIndex: p.questionIndex,
            reason: p.reason ?? null,
            track: p.track ?? null,
          })),
    },
  });
}
