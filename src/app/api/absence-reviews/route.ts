// CodeMind Academy — Phase F: the absence-review collection.
//
//   GET /api/absence-reviews
//     ADMIN   → the review queue with operational filters: status
//               (PENDING_REASON | PENDING_REVIEW | EXCUSED | UNEXCUSED | ALL),
//               studentId, groupId, teacherId, sessionId, from/to. Every row
//               carries student / session / lesson / group / teacher / date /
//               status / reason / submitter / review state.
//     STUDENT → their OWN cases only.
//     PARENT  → their LINKED children's cases only (an unrelated child's case
//               is not merely hidden, it is never queried).
//
// The attendance FACT stays separate from this administrative interpretation:
// nothing in this endpoint can change an Attendance row.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, requireUser } from "@/lib/api";
import { ApiFailure, dateParam, failureResponse, intParam } from "@/lib/live-session-api";
import type { AbsenceQueueFilter } from "@/lib/absence-policy";
import {
  listAbsenceQueue,
  listAbsencesForParent,
  listAbsencesForStudent,
  parentChildIds,
} from "@/lib/absence-review";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) throw new ApiFailure(401, "UNAUTHORIZED", "Unauthorized");
  const url = new URL(req.url);
  const limit = intParam(url.searchParams.get("limit"), 100, 1, 500);
  const now = new Date();

  try {
    if (user.role === "ADMIN") {
      const cases = await listAbsenceQueue(
        {
          status: url.searchParams.get("status") as AbsenceQueueFilter | null,
          studentId: url.searchParams.get("studentId"),
          groupId: url.searchParams.get("groupId"),
          teacherId: url.searchParams.get("teacherId"),
          sessionId: url.searchParams.get("sessionId"),
          from: dateParam(url.searchParams.get("from")) ?? null,
          to: dateParam(url.searchParams.get("to")) ?? null,
          limit,
        },
        { now }
      );
      return ok({ cases, scope: "admin" });
    }

    if (user.role === "STUDENT") {
      const student = await db.student.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!student) throw new ApiFailure(404, "STUDENT_NOT_FOUND", "Student profile not found");
      return ok({ cases: await listAbsencesForStudent(student.id, { now, limit }), scope: "student" });
    }

    if (user.role === "PARENT") {
      const parent = await db.parent.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!parent) throw new ApiFailure(404, "PARENT_NOT_FOUND", "Parent profile not found");
      const childId = url.searchParams.get("childId");
      const children = await parentChildIds(parent.id);
      const cases = await listAbsencesForParent(parent.id, { now, limit, childId });
      const links = await db.parentStudentLink.findMany({
        where: { parentId: parent.id },
        select: { studentId: true, student: { select: { user: { select: { name: true } } } } },
      });
      return ok({
        cases,
        children: links.map((l) => ({ id: l.studentId, name: l.student?.user?.name ?? "" })),
        childId: childId && children.includes(childId) ? childId : null,
        scope: "parent",
      });
    }

    if (user.role === "TEACHER") {
      // A teacher sees the OPERATIONAL state of their own groups' absences
      // (who is missing, is there a reason) but never the review controls.
      const teacher = await db.teacher.findUnique({
        where: { userId: user.id },
        select: { id: true, groups: { select: { id: true } } },
      });
      if (!teacher) throw new ApiFailure(404, "TEACHER_NOT_FOUND", "Teacher profile not found");
      const cases = await listAbsenceQueue(
        { groupId: url.searchParams.get("groupId") ?? undefined, limit },
        { now }
      );
      const groupIds = new Set(teacher.groups.map((g) => g.id));
      return ok({
        cases: cases.filter((c) => (c.group ? groupIds.has(c.group.id) : false)),
        scope: "teacher",
        readOnly: true,
      });
    }

    throw new ApiFailure(403, "NOT_AUTHORIZED", "Forbidden");
  } catch (error) {
    return failureResponse(error);
  }
}
