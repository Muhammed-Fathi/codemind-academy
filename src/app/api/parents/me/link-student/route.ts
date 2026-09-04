import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getParentProfile } from "@/lib/api";
import { isValidStudentCode, normalizePhone } from "@/lib/registration";

// POST /api/parents/me/link-student
// Supports TWO modes:
//  1. Legacy: { studentEmail } — link by email (kept for backward compat).
//  2. Verified: { studentNationalId, parentPhone, studentCode } — link by
//     matching Parent Phone + Student National ID (+ Student Code), i.e. the
//     data the student provided at registration.
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "PARENT") return err("Forbidden", 403);

  const body = await req.json().catch(() => ({}));
  const parent = await getParentProfile(user.id);
  if (!parent) return err("Parent profile not found", 404);

  let student: any = null;

  const studentEmail = String(body.studentEmail || "").toLowerCase().trim();
  const studentNationalId = String(
    body.studentNationalId || body.nationalId || ""
  ).trim();
  const parentPhone = String(body.parentPhone || "").trim();
  const studentCode = String(body.studentCode || "").trim().toUpperCase();

  if (studentNationalId || studentCode || parentPhone) {
    // Verified mode — all three required.
    if (!studentNationalId || !parentPhone || !studentCode) {
      return err("الرقم القومي للطالب + رقم تليفون ولي الأمر + كود الطالب مطلوبين", 400);
    }
    if (!/^[0-9]{14}$/.test(studentNationalId))
      return err("الرقم القومي للطالب لازم يكون 14 رقم", 400);
    if (!isValidStudentCode(studentCode))
      return err("كود الطالب غير صالح (مثال: CM-ABC123)", 400);

    const matched = await (db as any).student.findFirst({
      where: { nationalId: studentNationalId, studentCode },
      include: { user: true },
    });
    if (!matched) return err("مفيش طالب بالرقم القومي وكود الطالب دول", 404);
    const stored = normalizePhone(String(matched.parentPhone || ""));
    if (!stored || stored !== normalizePhone(parentPhone)) {
      return err(
        "رقم تليفون ولي الأمر غير مطابق للرقم المسجل مع بيانات الطالب",
        404
      );
    }
    student = matched;
  } else if (studentEmail) {
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
    student = studentUser.student;
  } else {
    return err("اكتب إيميل الطالب أو بيانات الربط (الرقم القومي + التليفون + الكود)", 400);
  }

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
  const children = (refreshed?.children || []).map((link: any) => ({
    id: link.student.id,
    linkId: link.id,
    relation: link.relation,
    name: link.student.user.name,
    email: link.student.user.email,
    avatarUrl: link.student.user.avatarUrl,
    grade: link.student.grade,
    schoolName: (link.student as any).schoolName ?? null,
    studentCode: (link.student as any).studentCode ?? null,
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
