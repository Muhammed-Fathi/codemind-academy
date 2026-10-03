import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Study Scheduler API
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { canStudentAttachLesson } from "@/lib/curriculum-visibility";

// GET /api/students/me/study-plan?from=&to= — list tasks in date range
export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.151"), 404);

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const now = new Date();
  const start = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
  const end = to ? new Date(to) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const tasks = await db.studyTask.findMany({
    where: {
      studentId: student.id,
      scheduledDate: { gte: start, lte: end },
    },
    orderBy: { scheduledDate: "asc" },
  });

  return ok({
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      lessonId: t.lessonId,
      scheduledDate: t.scheduledDate,
      durationMin: t.durationMin,
      status: t.status,
      createdAt: t.createdAt,
    })),
  });
}

// POST — create task
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.151"), 404);

  const body = await req.json().catch(() => ({}));
  const { title, description, lessonId, scheduledDate, durationMin } = body as {
    title?: string;
    description?: string;
    lessonId?: string;
    scheduledDate?: string;
    durationMin?: number;
  };
  if (!title || !scheduledDate) return err(tApi("api.152"), 400);

  // Phase M4.2 — SERVER-SIDE `lessonId` VALIDATION (owner decision D6).
  //
  // `StudyTask.lessonId` stays in the API contract, but it is never trusted:
  // an id that is not part of THIS student's visible CURRENT-course curriculum
  // is refused before any row is written. The gate is the shared
  // `canStudentAttachLesson` (PUBLISHED + non-archived + own track + own
  // enrolled course through the canonical chain + the lesson's derived level
  // matching its course's canonical level), so an id from another course,
  // another Academic Level, an archived/unpublished/foreign-track lesson, or a
  // non-existent id all fail closed with the same plain 400. Labels, codes and
  // titles are never consulted: identity is the canonical lesson id.
  const attachedLessonId =
    typeof lessonId === "string" && lessonId.length > 0 ? lessonId : null;
  if (attachedLessonId && !(await canStudentAttachLesson(student.id, attachedLessonId))) {
    return err(tApi("api.384"), 400);
  }

  const task = await db.studyTask.create({
    data: {
      studentId: student.id,
      title,
      description: description || null,
      // Only a validated (or absent) id ever reaches the column.
      lessonId: attachedLessonId,
      scheduledDate: new Date(scheduledDate),
      durationMin: durationMin || 60,
    },
  });
  return ok({ task });
}

// PATCH — update task (status, title, etc.)
export async function PATCH(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.151"), 404);

  const body = await req.json().catch(() => ({}));
  const { taskId, status, title, description, lessonId, scheduledDate, durationMin } =
    body as {
      taskId?: string;
      status?: string;
      title?: string;
      description?: string;
      lessonId?: string | null;
      scheduledDate?: string;
      durationMin?: number;
    };
  if (!taskId) return err(tApi("api.153"), 400);

  // Phase M4.2 — an update may re-point the task at a lesson, so the SAME
  // server-side gate as create applies whenever `lessonId` is supplied.
  // `null` / `""` clears the link (no lesson to validate); any non-empty string
  // must pass `canStudentAttachLesson` BEFORE the update runs, so a rejected id
  // can never be stored by a PATCH. Fail closed: no labels, no codes, no
  // client-supplied level ever decide here.
  const patchHasLesson = Object.prototype.hasOwnProperty.call(body, "lessonId");
  let patchLessonId: string | null = null;
  if (patchHasLesson) {
    const raw = typeof lessonId === "string" ? lessonId : null;
    patchLessonId = raw && raw.length > 0 ? raw : null;
    if (patchLessonId && !(await canStudentAttachLesson(student.id, patchLessonId))) {
      return err(tApi("api.384"), 400);
    }
  }

  const data: any = {};
  // Only written when supplied, and only ever a validated id (or an explicit
  // clear). The ownership-scoped `updateMany` below is unchanged.
  if (patchHasLesson) data.lessonId = patchLessonId;
  if (status) data.status = status;
  if (title) data.title = title;
  if (description !== undefined) data.description = description;
  if (scheduledDate) data.scheduledDate = new Date(scheduledDate);
  if (durationMin) data.durationMin = durationMin;

  // Security Audit Gate (pre-P21) — OWNERSHIP-SCOPED WRITE.
  //
  // This was the last write in the student surface that updated a row by id
  // alone: any authenticated student could PATCH another student's task id and
  // have the route rewrite it AND hand the victim's row back in the response.
  // The sibling operations in this very file (DELETE) and in
  // /api/students/me/notes (PATCH) already scope by `studentId` — this branch
  // had simply drifted.
  //
  // `updateMany` with the owner in the WHERE clause makes the whole operation
  // atomic and non-enumerable: a task that is not the caller's own answers
  // exactly like one that does not exist (404), which also removes the
  // unhandled Prisma P2025 a guessed id used to raise.
  const result = await db.studyTask.updateMany({
    where: { id: taskId, studentId: student.id },
    data,
  });
  if (result.count !== 1) return err("Not found", 404);

  const task = await db.studyTask.findUnique({ where: { id: taskId } });
  return ok({ task });
}

// DELETE /api/students/me/study-plan?taskId=X
export async function DELETE(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.151"), 404);

  const url = new URL(req.url);
  const taskId = url.searchParams.get("taskId");
  if (!taskId) return err(tApi("api.153"), 400);

  await db.studyTask.deleteMany({
    where: { id: taskId, studentId: student.id },
  });
  return ok({ ok: true });
}
