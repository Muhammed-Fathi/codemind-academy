import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getParentProfile } from "@/lib/api";
import { isValidStudentCode, normalizePhone } from "@/lib/registration";

// POST /api/parents/me/link-student
// Supports ONE mode:
//   Verified: { studentNationalId, parentPhone, studentCode } — link by
//     matching Parent Phone + Student National ID (+ Student Code), i.e. the
//     data the student provided at registration.
// The legacy email-only linking path was removed for security.
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
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
      return err(tApi("api.110"), 400);
    }
    if (!/^[0-9]{14}$/.test(studentNationalId))
      return err(tApi("api.111"), 400);
    if (!isValidStudentCode(studentCode))
      return err(tApi("api.112"), 400);

    const matched = await (db as any).student.findFirst({
      where: { nationalId: studentNationalId, studentCode },
      include: { user: true },
    });
    // Phase 7: both failure branches answer 404 with the SAME message
    // (api.113 and api.114 are intentionally identical text). A distinct
    // "phone mismatch" message would confirm that a guessed (national ID +
    // student code) pair is real, turning this endpoint into an oracle for
    // enumerating students.
    if (!matched) return err(tApi("api.113"), 404);
    const stored = normalizePhone(String(matched.parentPhone || ""));
    if (!stored || stored !== normalizePhone(parentPhone)) {
      return err(
        tApi("api.114"),
        404
      );
    }
    student = matched;
  } else if (studentEmail) {
    // Legacy email-based linking was removed for security: knowing a
    // student's email was sufficient to impersonate their parent.
    // All linking now requires the verified path (national ID + student
    // code + parent phone).
    return err(tApi("api.110"), 400);
  } else {
    return err(tApi("api.117"), 400);
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
