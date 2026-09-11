import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Study Scheduler API
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

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

  const task = await db.studyTask.create({
    data: {
      studentId: student.id,
      title,
      description: description || null,
      lessonId: lessonId || null,
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
  const { taskId, status, title, description, scheduledDate, durationMin } = body as {
    taskId?: string;
    status?: string;
    title?: string;
    description?: string;
    scheduledDate?: string;
    durationMin?: number;
  };
  if (!taskId) return err(tApi("api.153"), 400);

  const data: any = {};
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
