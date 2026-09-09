import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import {
  canAccessHomework,
  EXCLUDE_ARCHIVED_LESSON,
  getUnlockedLessonIds,
} from "@/lib/session-progress";
import { getServerT } from "@/lib/i18n-server";
import { getStudentSchoolType } from "@/lib/enrollment";
import { trackScopeWhere } from "@/lib/track-scope";

/** Longest accepted free-text answer. Generous, but not an upload channel. */
const MAX_ANSWER_CHARS = 4000;

function publicSubmission(sub: {
  status: string;
  grade: number | null;
  feedback: string | null;
  submittedAt: Date | null;
} | null) {
  if (!sub) return null;
  return {
    status: sub.status,
    grade: sub.grade,
    feedback: sub.feedback,
    submittedAt: sub.submittedAt,
  };
}

// GET /api/students/me/homework
// Lists the assignments of the student's course, with their submissions.
//
// Only assignments belonging to sessions the student has UNLOCKED are returned:
// the title, the instructions and the deadline of a future session's assignment
// are protected content, not a to-do item.
export async function GET(_req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const s = await getStudentProfile(user.id);
  if (!s) return err("Student profile not found", 404);

  const courseId = s.group?.course?.id ?? null;
  const unlocked =
    courseId && s.group?.isActive
      ? await getUnlockedLessonIds(s.id, courseId)
      : new Set<string>();

  // Phase 12 — the unlocked-lesson set already excludes the other track's
  // lessons (the progression engine filters the universe), but a SHARED lesson
  // may legitimately carry an ARABIC and a LANGUAGE assignment, so the
  // assignment's OWN trackScope is filtered here too. Server-side, from the
  // student's row — never from a request parameter.
  const schoolType = await getStudentSchoolType(s.id);

  // The unlocked-lesson set (from the exclusion-aware engine) is the scope;
  // the legacy topic-chain guard below it used to drop every unit-linked
  // official lesson, so it is now just an archived-history backstop.
  const homeworks = await db.homework.findMany({
    where: {
      lessonId: { in: [...unlocked] },
      lesson: { ...EXCLUDE_ARCHIVED_LESSON },
      ...trackScopeWhere(schoolType),
    },
    include: {
      lesson: { select: { id: true, titleAr: true, title: true } },
      submissions: { where: { studentId: s.id } },
    },
    orderBy: { deadline: "asc" },
  });

  const items = homeworks.map((h) => {
    const sub = h.submissions[0];
    return {
      id: h.id,
      title: h.titleAr || h.title,
      instructions: h.instructions,
      deadline: h.deadline,
      maxMarks: h.maxMarks,
      lessonId: h.lesson.id,
      lessonTitle: h.lesson.titleAr || h.lesson.title,
      submission: publicSubmission(sub),
    };
  });

  return ok({ items });
}

// POST /api/students/me/homework
// Body: { homeworkId: string, content: string }
//
// Submits (or re-submits) the student's OWN answer for an assignment.
//
// Why this exists: the progression rule requires an assignment to be submitted
// before the next session unlocks, but nothing in the product could ever write
// a HomeworkSubmission for a student — the only writer was the teacher grading
// route. Any lesson carrying an assignment was therefore permanently locked.
//
// Rules:
//   * the studentId always comes from the session, never from the body, so
//     nobody can submit on somebody else's behalf;
//   * the assignment must belong to a session the student has unlocked;
//   * submitting sets SUBMITTED (or LATE past the deadline) — grading stays
//     teacher-only, this route never assigns a grade;
//   * an already-GRADED assignment is immutable, so a grade cannot be reset by
//     re-submitting;
//   * @@unique([homeworkId, studentId]) plus an upsert make rapid duplicate
//     submissions collapse onto one row.
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const s = await getStudentProfile(user.id);
  if (!s) return err("Student profile not found", 404);

  const body = await req.json().catch(() => ({}));
  const homeworkId = String(body.homeworkId || "").trim();
  if (!homeworkId) return err(tApi("api.221"), 400);

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return err(tApi("api.222"), 400);
  if (content.length > MAX_ANSWER_CHARS)
    return err(tApi("api.223", { p1: MAX_ANSWER_CHARS }), 413);

  // Server-side progression gate — the same rule that unlocks the session.
  const access = await canAccessHomework(s.id, homeworkId);
  if (!access.allowed) return denyProgression(access.reason, "Homework not found");

  const homework = await db.homework.findUnique({
    where: { id: homeworkId },
    select: { id: true, title: true, titleAr: true, deadline: true, maxMarks: true },
  });
  if (!homework) return err("Homework not found", 404);

  const existing = await db.homeworkSubmission.findUnique({
    where: { homeworkId_studentId: { homeworkId, studentId: s.id } },
    select: { id: true, status: true },
  });
  if (existing?.status === "GRADED") return err(tApi("api.224"), 409);

  const now = new Date();
  const status = now > homework.deadline ? "LATE" : "SUBMITTED";

  // Upsert on the (homeworkId, studentId) unique pair: two parallel submits
  // converge on the same row instead of racing into a duplicate.
  const submission = await db.homeworkSubmission.upsert({
    where: { homeworkId_studentId: { homeworkId, studentId: s.id } },
    create: {
      homeworkId,
      studentId: s.id,
      content,
      submittedAt: now,
      status,
    },
    update: {
      content,
      submittedAt: now,
      status,
      // A re-submission clears the previous verdict; the teacher re-grades.
      grade: null,
      feedback: null,
    },
  });

  return ok({
    message: tApi("api.225"),
    submission: publicSubmission(submission),
  });
}
