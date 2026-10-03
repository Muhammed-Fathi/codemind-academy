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
import { listLinkedChildRefs } from "@/lib/parent-academics";
import { serverLocale } from "@/lib/i18n-server";

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
      // Authorization is unchanged and link-scoped: the case list is read
      // through `listAbsencesForParent`, which intersects the requested child
      // with THIS parent's own ParentStudentLink rows, and `childIds` below is
      // the same link-derived set the cursor is validated against.
      const childIds = await parentChildIds(parent.id);
      const cases = await listAbsencesForParent(parent.id, { now, limit, childId });
      // Phase M4.3 — the child references are the SHARED canonical shape
      // (`listLinkedChildRefs`): canonical `studentId`, name, the resolved
      // Academic Level and the localized course name. The selector and the
      // case headers render level + course from this, so two same-named
      // children (or two children in courses with one display name) can never
      // be confused. It replaces the previous `{ id, name }` shorthand; no id
      // beyond `studentId` is introduced.
      const children = await listLinkedChildRefs(user.id, await serverLocale());
      return ok({
        cases,
        children,
        childId: childId && childIds.includes(childId) ? childId : null,
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
