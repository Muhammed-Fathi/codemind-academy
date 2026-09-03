import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getParentProfile } from "@/lib/api";

// POST /api/parents/me/link-student
// Body: { studentEmail: string }
// Adds a ParentStudentLink between current parent and the student with that email.
// Returns the updated children list (basic profile).
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "PARENT") return err("Forbidden", 403);

  const body = await req.json().catch(() => ({}));
  const studentEmail = String(body.studentEmail || "").toLowerCase().trim();
  if (!studentEmail) return err("اكتب إيميل الطالب", 400);

  const parent = await getParentProfile(user.id);
  if (!parent) return err("Parent profile not found", 404);

  // Find the student by user email
  const studentUser = await db.user.findUnique({
    where: { email: studentEmail },
    include: { student: { include: { user: true } } },
  });
  if (!studentUser || !studentUser.student) {
    return err("مفيش طالب بالإيميل ده. تأكد من الإيميل وحاول تاني.", 404);
  }
  if (studentUser.role !== "STUDENT") {
    return err("الحساب ده مش طالب.", 400);
  }

  const student = studentUser.student;

  // Idempotent link
  const existing = await db.parentStudentLink.findUnique({
    where: {
      parentId_studentId: { parentId: parent.id, studentId: student.id },
    },
  });
  if (!existing) {
    await db.parentStudentLink.create({
      data: {
        parentId: parent.id,
        studentId: student.id,
        relation: String(body.relation || "parent"),
      },
    });
  }

  // Return updated children list
  const refreshed = await getParentProfile(user.id);
  const children = (refreshed?.children || []).map((link) => ({
    id: link.student.id,
    linkId: link.id,
    relation: link.relation,
    name: link.student.user.name,
    email: link.student.user.email,
    avatarUrl: link.student.user.avatarUrl,
    grade: link.student.grade,
    schoolName: link.student.schoolName,
  }));

  return ok({
    ok: true,
    linked: {
      id: student.id,
      name: student.user.name,
      email: student.user.email,
    },
    children,
  });
}
