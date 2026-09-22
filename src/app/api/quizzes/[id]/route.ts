import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import { canAccessQuiz } from "@/lib/session-progress";
import { getStudentSchoolType } from "@/lib/enrollment";
import { canAccessTrackScope, isQuestionEligible } from "@/lib/track-scope";
import {
  loadAttemptQuestionSet,
  safeParseOptions,
  timeLimitState,
} from "@/lib/session-quiz";
import { resolveQuizBlueprint } from "@/lib/quiz-blueprint";
import { countPendingRetryGrants } from "@/lib/quiz-retry";
import {
  isParentAllowedTrackScope,
  isParentLessonPreviewAllowed,
} from "@/lib/parent-access";
// Phase I (contract correction) — the verified `?studentId=` selector, so a
// quiz OUTCOME is only ever reported for a child this parent is linked to.
import { readStudentIdParam, resolveLinkedChild } from "@/lib/parent-academics";
import type { SchoolType } from "@/lib/school-type";

// GET /api/quizzes/[id]
// Returns quiz + questions. Answers and explanations are withheld from
// students until they have submitted at least one attempt —
// the runner hides them until submission.
//
// AUTHORIZATION: a student may only read a quiz that belongs to a session they
// have unlocked. Without this the questions, options and (after any attempt)
// the answers of every future session are readable straight off the API.
//
// Phase 5 / Phase 26D — WHICH questions are served:
//   * OPEN attempt → that attempt's FROZEN set, read from the Phase 26D
//     snapshot on its QuizAnswer rows. A refresh, a navigation away and back, or
//     a logout/login therefore always returns the exact same paper — same
//     questions, same wording, same option order — even if the Question Bank was
//     edited in between.
//   * No attempt, BLUEPRINT quiz → NO questions. The paper does not exist until
//     /start selects and freezes it, so serving the pool here would show the
//     student a different (larger) set than the one they will be graded on, and
//     would hand them the whole bank to rehearse from. The response carries
//     `attemptRequired: true` and the runner starts the attempt first.
//   * No attempt, FIXED quiz → the live eligible questions, exactly as before
//     this phase. Legacy behaviour for legacy quizzes.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  // Phase I: a parent NEVER has the question bank selected into memory at all —
  // not "selected and then stripped", which is the mistake the first pass made.
  // The parent branch below needs the lesson chain for its authorization gate
  // and nothing else.
  const isParentViewer = user.role === "PARENT";
  const quiz = await db.quiz.findUnique({
    where: { id },
    include: {
      // BOTH curriculum chains: the canonical Lesson.unitId chain and the
      // legacy Lesson.topicId chain. The canonical link wins when a lesson
      // carries both (the same rule the Phase 4 progression engine uses);
      // legacy-only lessons resolve through their topic.
      lesson: {
        include: {
          unit: { include: { part: { include: { course: true } } } },
          topic: { include: { unit: { include: { part: { include: { course: true } } } } } },
        },
      },
      ...(isParentViewer
        ? {}
        : { questions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } }),
    },
  });
  if (!quiz) return err("Quiz not found", 404);

  // Phase G — a DRAFT quiz is authoring-only: students and parents get the
  // SAME 404 as a nonexistent id (existence must not leak). Teachers/admins
  // still pass for review/preview through their own surfaces.
  if ((user.role === "STUDENT" || user.role === "PARENT") && quiz.status !== "PUBLISHED") {
    return err("Quiz not found", 404);
  }

  // Phase 7 + 12 + 13, in ONE predicate (see `isParentLessonPreviewAllowed`):
  // a parent may open a quiz only when a linked, ENROLLED child is in the
  // quiz's course, the quiz and its lesson are on that child's TRACK, and the
  // OWNING LESSON IS PUBLISHED. Quiz ids are unguessable, so every refusal is a
  // plain 404, identical to a nonexistent id.
  if (user.role === "PARENT") {
    const quizCourseId =
      quiz.lesson?.unit?.part.courseId ??
      quiz.lesson?.topic?.unit.part.courseId ??
      null;
    const lessonAllowed = await isParentLessonPreviewAllowed(
      user.id,
      quiz.lesson
        ? {
            status: quiz.lesson.status,
            curriculumStatus: quiz.lesson.curriculumStatus,
            trackScope: quiz.lesson.trackScope,
          }
        : null,
      quizCourseId
    );
    if (!lessonAllowed) return err("Quiz not found", 404);
    // The QUIZ's own scope can be narrower than its lesson's (a SHARED lesson
    // may host an ARABIC-only quiz), so it is checked separately — the same
    // two-layer rule `gateTrackedResource` applies to students.
    if (!(await isParentAllowedTrackScope(user.id, quiz.trackScope))) {
      return err("Quiz not found", 404);
    }

    // ---- PHASE I (CONTRACT CORRECTION): PARENT = SUMMARY ONLY --------------
    // The Parent product is academic FOLLOW-UP, not assessment review. Withholding
    // only `answer` / `explanation` while still shipping the rest of the
    // question bank (prompt text, options, question ids, difficulty, marks, the
    // randomized blueprint) was NOT the approved contract — it left the parent
    // holding the assessment itself.
    //
    // A parent therefore receives a STRICTLY SHAPED SUMMARY:
    //   * quiz identity and lesson identity;
    //   * `questions: []` — the question bank is never selected, mapped or
    //     serialised for a parent, so no future field can leak through a
    //     partial strip;
    //   * outcome data (score / pass-fail / attempt count / completion time)
    //     ONLY for a child named with a verified `?studentId=`. A parent with
    //     two children in the same course must never be shown the other child's
    //     result, so with no (or an unlinked) `?studentId=` the summary is
    //     absent / the request is refused — never guessed.
    //
    // The child-scoped surface `GET /api/parents/me/academics?studentId=`
    // remains the authority for quiz outcomes.
    const requestedStudentId = readStudentIdParam(_req);
    let summary: {
      studentId: string;
      attempts: number;
      lastOutcome: "PASSED" | "FAILED" | null;
      lastPercentage: number | null;
      bestPercentage: number | null;
      lastCompletedAt: string | null;
    } | null = null;
    if (requestedStudentId) {
      const linked = await resolveLinkedChild(user.id, requestedStudentId);
      // Fail closed, identically to every other Phase I `?studentId=`: a child
      // this parent is not linked to is refused with 404, which never confirms
      // that the id exists.
      if (!linked) return err("Quiz not found", 404);
      const rows = await db.quizAttempt.findMany({
        where: { quizId: quiz.id, studentId: requestedStudentId, finishedAt: { not: null } },
        orderBy: { finishedAt: "asc" },
        select: { percentage: true, passed: true, finishedAt: true },
      });
      const last = rows.length > 0 ? rows[rows.length - 1] : null;
      summary = {
        studentId: requestedStudentId,
        attempts: rows.length,
        lastOutcome: last ? (last.passed ? "PASSED" : "FAILED") : null,
        lastPercentage: last ? last.percentage : null,
        bestPercentage:
          rows.length > 0 ? Math.max(...rows.map((r) => r.percentage ?? 0)) : null,
        lastCompletedAt: last?.finishedAt ? new Date(last.finishedAt).toISOString() : null,
      };
    }
    return ok({
      /** Marker: this is the parent-safe shape, not the runner payload. */
      parentView: true,
      /** True because detailed quiz content is withheld from a parent. */
      restricted: true,
      quiz: {
        id: quiz.id,
        title: quiz.title,
        titleAr: quiz.titleAr,
      },
      lesson: quiz.lesson
        ? {
            id: quiz.lesson.id,
            title: quiz.lesson.title,
            titleAr: quiz.lesson.titleAr,
            courseSlug:
              quiz.lesson.unit?.part.course.slug ??
              quiz.lesson.topic?.unit.part.course.slug ??
              null,
          }
        : null,
      /** NEVER populated for a parent — see the contract note above. */
      questions: [],
      bestAttempt: null,
      summary,
    });
  }

  const blueprint = resolveQuizBlueprint(quiz);

  // Pull the student's previous attempts (if student)
  let bestAttempt: {
    id: string;
    score: number;
    totalMarks: number;
    percentage: number;
    passed: boolean;
    finishedAt: Date | null;
  } | null = null;
  let studentHasAttempted = false;
  /** The frozen question set of the student's OPEN attempt, when there is one. */
  let attemptSet: Awaited<ReturnType<typeof loadAttemptQuestionSet>> | null = null;
  let studentSchoolType: SchoolType | null = null;
  // Phase 18 — the server-computed window of the OPEN attempt (if any), so a
  // reloaded page renders the SAME countdown instead of restarting one. Never
  // derived from a client clock; `expiresAt` is null for untimed quizzes.
  let attemptWindow: {
    startedAt: Date;
    expiresAt: Date | null;
    remainingSeconds: number | null;
    expired: boolean;
  } | null = null;
  /** Phase 26D — the student's attempt entitlement, so the UI can tell the truth. */
  let attemptState: {
    attemptsUsed: number;
    maxAttempts: number;
    hasOpenAttempt: boolean;
    pendingRetryGrants: number;
    /** True when POST /start would be allowed right now. */
    canStart: boolean;
  } | null = null;

  if (user.role === "STUDENT") {
    const s = await getStudentProfile(user.id);
    if (!s) return err("Student profile not found", 404);

    const access = await canAccessQuiz(s.id, id);
    if (!access.allowed) return denyProgression(access.reason, "Quiz not found", {
      state: access.evaluation?.state ?? null,
      reason: access.evaluation?.reason ?? null,
      reasonCode: access.evaluation?.reasonCode ?? null,
      unmet: access.evaluation?.unmet ?? [],
      holdBlocked: access.reason === "ABSENCE_HOLD",
    });

    // Deterministic set: an open attempt pins the exact question list, and
    // only the questions eligible for THIS student's school type are served.
    const schoolType = await getStudentSchoolType(s.id);
    studentSchoolType = schoolType;

    const attempts = await db.quizAttempt.findMany({
      where: { quizId: id, student: { userId: user.id } },
      orderBy: { percentage: "desc" },
    });
    if (attempts.length > 0) {
      const a = attempts[0];
      bestAttempt = {
        id: a.id,
        score: a.score,
        totalMarks: a.totalMarks,
        percentage: a.percentage,
        passed: a.passed,
        finishedAt: a.finishedAt,
      };
      studentHasAttempted = attempts.some((x) => x.finishedAt !== null);
    }

    const open = attempts.find((x) => x.finishedAt === null);
    if (open) {
      attemptSet = await loadAttemptQuestionSet(open.id, schoolType);
      const limit = timeLimitState(open.startedAt, quiz.timeLimit);
      attemptWindow = {
        startedAt: open.startedAt,
        expiresAt: limit.deadline,
        remainingSeconds: limit.remainingSeconds,
        expired: limit.expired,
      };
    }

    // Entitlement, computed with the SAME rule /start enforces, so the UI can
    // never offer a start that the server would refuse.
    const pendingRetryGrants = await countPendingRetryGrants(s.id, id);
    const attemptsUsed = attempts.length;
    attemptState = {
      attemptsUsed,
      maxAttempts: blueprint.maxAttempts,
      hasOpenAttempt: !!open,
      pendingRetryGrants,
      canStart:
        !!open ||
        attemptsUsed === 0 ||
        (attemptsUsed < blueprint.maxAttempts && pendingRetryGrants > 0) ||
        (attemptsUsed >= blueprint.maxAttempts && pendingRetryGrants > 0),
    };
  }

  // Teachers and admins always see answers (needed for review/creation).
  // Students see answers only after submitting at least one attempt.
  // (Staff answer visibility is the documented Phase 1 audit decision.)
  //
  // PHASE I — PARENT IS READ-ONLY AND IS NOT AN ANSWER-REVIEW SURFACE.
  // A PARENT never reaches this point at all: the parent branch above returns a
  // summary-only payload before the question bank is ever mapped. What remains
  // here is the documented Phase 1 rule for the roles that legitimately see the
  // key (staff for review/authoring, a student after their own submission).
  const revealAnswers =
    user.role === "ADMIN" || user.role === "TEACHER" || studentHasAttempted;

  // Canonical chain first, legacy topic chain as fallback.
  const courseSlug =
    quiz.lesson?.unit?.part.course.slug ??
    quiz.lesson?.topic?.unit.part.course.slug ??
    null;

  // Phase 12 — only questions eligible for the student's school type are ever
  // served. Phase 26D — when the student has an OPEN attempt the served list is
  // that attempt's frozen snapshot (already track-filtered and already in the
  // order the student saw), never the live bank.
  // The parent branch has already returned by now; `?? []` only satisfies the
  // type for the parent query, which deliberately omitted the relation.
  const eligibleQuestions = (quiz.questions ?? []).filter((q) =>
    user.role === "STUDENT"
      ? isQuestionEligible(studentSchoolType, q.schoolType)
      : true
  );

  // A BLUEPRINT quiz with no open attempt has no paper yet: the set is chosen at
  // /start. Serving the pool here would show a different, larger set than the
  // one the student will be graded on. Staff keep the full list for authoring.
  const suppressUntilStart =
    user.role === "STUDENT" && blueprint.mode === "BLUEPRINT" && !attemptSet;

  const servedQuestions = attemptSet
    ? attemptSet.map((entry) => entry.question)
    : suppressUntilStart
      ? []
      : eligibleQuestions;

  return ok({
    quiz: {
      id: quiz.id,
      title: quiz.title,
      titleAr: quiz.titleAr,
      description: quiz.description,
      passMark: quiz.passMark,
      timeLimit: quiz.timeLimit,
      /** Phase 18 — the running attempt's server-authoritative window. */
      attemptWindow,
      /** Phase 26D — selection mode, so the client knows whether to start first. */
      quizMode: blueprint.mode,
      /** True when the client must POST /start before any question is served. */
      attemptRequired: suppressUntilStart,
      /** Phase 26D — the student's remaining entitlement (students only). */
      attemptState,
    },
    lesson: quiz.lesson
      ? {
          id: quiz.lesson.id,
          title: quiz.lesson.title,
          titleAr: quiz.lesson.titleAr,
          courseSlug,
        }
      : null,
    questions: servedQuestions.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      promptAr: q.promptAr,
      options: safeParseOptions(q.options),
      answer: revealAnswers ? q.answer : undefined,
      explanation: revealAnswers ? q.explanation : undefined,
      difficulty: q.difficulty,
      marks: q.marks,
    })),
    bestAttempt,
  });
}
