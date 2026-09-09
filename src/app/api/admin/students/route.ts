import { getServerT } from "@/lib/i18n-server";
// GET /api/admin/students?search=&status=&page=1&pageSize=20
// POST /api/admin/students — create student (also creates user)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { createStudentWithCode } from "@/lib/curriculum-seed";
import { normalizeSchoolType, requireSchoolType } from "@/lib/school-type";
import { reconcileStudentBatch } from "@/lib/enrollment";
import { getVideoProgressForStudents } from "@/lib/progress";

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const search = url.searchParams.get("search")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  // School-type view (Arabic school / Language school). Filtering is done in
  // SQL against the real Student.schoolType column — never in the frontend.
  const schoolTypeParam = url.searchParams.get("schoolType");
  const schoolType = normalizeSchoolType(schoolTypeParam);
  // Explicit "no school type recorded yet" view. This must be a SQL filter:
  // filtering it on the client would only ever search the current page, so
  // unspecified students on later pages would silently disappear.
  const unspecifiedOnly = schoolTypeParam === "UNSPECIFIED";
  const withProgress = url.searchParams.get("withProgress") === "1";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const where: any = {};
  if (search) {
    where.OR = [
      { user: { name: { contains: search } } },
      { user: { email: { contains: search } } },
      { user: { phone: { contains: search } } },
      { studentCode: { contains: search } },
      { nationalId: { contains: search } },
    ];
  }
  if (status === "active") where.user = { isActive: true };
  if (status === "inactive") where.user = { isActive: false };
  if (status === "suspended") where.user = { status: "SUSPENDED_MULTI_DEVICE" };
  if (schoolType) where.schoolType = schoolType;
  else if (unspecifiedOnly) where.schoolType = null;

  const [total, students] = await Promise.all([
    db.student.count({ where }),
    db.student.findMany({
      where,
      include: {
        user: true,
        group: { select: { id: true, name: true, course: { select: { nameAr: true } } } },
        subscription: {
          select: {
            status: true,
            endDate: true,
            plan: { select: { nameAr: true } },
          },
        },
      },
      orderBy: { enrolledAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // Shared progress service — the SAME numbers the teacher/parent see.
  // Computed for the current page only (never for every student).
  const progressMap = withProgress
    ? await getVideoProgressForStudents(students.map((s: any) => s.id))
    : null;

  // Counts per school type, so the tabs can show totals without extra
  // round-trips and without loading all students.
  //
  // The counts must reflect the search/status filters but NOT the currently
  // selected school-type tab — otherwise selecting "Arabic" would report 0 for
  // the Language tab. `schoolType` is therefore stripped explicitly rather
  // than relying on spread-override ordering.
  const { schoolType: _ignoredSchoolType, ...countWhere } = where;
  const [arabicCount, languageCount, unspecifiedCount] = await Promise.all([
    db.student.count({ where: { ...countWhere, schoolType: "ARABIC" } }),
    db.student.count({ where: { ...countWhere, schoolType: "LANGUAGE" } }),
    db.student.count({ where: { ...countWhere, schoolType: null } }),
  ]);

  return ok({
    students: students.map((s: any) => ({
      id: s.id,
      userId: s.userId,
      name: s.user.name,
      email: s.user.email,
      phone: s.user.phone,
      isActive: s.user.isActive,
      grade: s.grade,
      schoolName: s.schoolName,
      schoolType: s.schoolType || null,
      nationalId: s.nationalId || null,
      parentPhone: s.parentPhone || null,
      studentCode: s.studentCode || null,
      enrolledAt: s.enrolledAt,
      group: s.group,
      subscription: s.subscription,
      accountStatus: s.user.status,
      videoProgress: progressMap?.get(s.id) || null,
    })),
    counts: {
      ARABIC: arabicCount,
      LANGUAGE: languageCount,
      UNSPECIFIED: unspecifiedCount,
    },
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page * pageSize < total,
    },
  });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const email = String(body.email || "").toLowerCase().trim();
  const password = String(body.password || "");
  const phone = body.phone ? String(body.phone) : null;
  const grade = body.grade ? String(body.grade) : "2nd Secondary";
  const schoolName = body.schoolName ? String(body.schoolName) : null;
  // Phase 12 — an admin creating a student MUST give a valid school type, or
  // explicitly none. `normalizeSchoolType` alone would silently turn a typo
  // into "unspecified" and quietly restrict the student to SHARED content.
  const schoolTypeCheck = requireSchoolType(body.schoolType);
  if (!schoolTypeCheck.ok && schoolTypeCheck.reason === "INVALID") {
    return err(tApi("api.210"), 400);
  }
  const schoolType = schoolTypeCheck.ok ? schoolTypeCheck.value : null;
  const nationalId = body.nationalId ? String(body.nationalId).trim() : null;
  const parentPhone = body.parentPhone ? String(body.parentPhone).trim() : null;
  const groupId = body.groupId ? String(body.groupId) : null;

  if (!name || !email || !password)
    return err(tApi("api.048"), 400);
  if (password.length < 6) return err(tApi("api.049"), 400);

  const exists = await db.user.findUnique({ where: { email } });
  if (exists) return err(tApi("api.050"), 409);

  const newUser = await db.user.create({
    data: {
      name,
      email,
      password: hashPassword(password),
      phone,
      role: "STUDENT",
    },
  });
  // Unique readable student code (CM-XXXXXX), P2002-safe under concurrency.
  const student = await createStudentWithCode(db, {
    userId: newUser.id,
    grade,
    schoolName,
    schoolType,
    nationalId: nationalId || null,
    parentPhone: parentPhone || null,
    groupId,
  }).then((s: any) =>
    (db as any).student.findUnique({
      where: { id: s.id },
      include: { user: true, group: { select: { name: true } } },
    })
  );

  return ok({
    student: {
      id: student.id,
      name: student.user.name,
      email: student.user.email,
      phone: student.user.phone,
      grade: student.grade,
      schoolName: student.schoolName,
      studentCode: student.studentCode,
      group: student.group,
    },
  });
}
