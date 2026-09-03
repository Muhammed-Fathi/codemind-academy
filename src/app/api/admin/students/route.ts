// GET /api/admin/students?search=&status=&page=1&pageSize=20
// POST /api/admin/students — create student (also creates user)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { hashPassword } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const search = url.searchParams.get("search")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const where: any = {};
  if (search) {
    where.OR = [
      { user: { name: { contains: search } } },
      { user: { email: { contains: search } } },
      { user: { phone: { contains: search } } },
    ];
  }
  if (status === "active") where.user = { isActive: true };
  if (status === "inactive") where.user = { isActive: false };

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

  return ok({
    students: students.map((s) => ({
      id: s.id,
      userId: s.userId,
      name: s.user.name,
      email: s.user.email,
      phone: s.user.phone,
      isActive: s.user.isActive,
      grade: s.grade,
      schoolName: s.schoolName,
      enrolledAt: s.enrolledAt,
      group: s.group,
      subscription: s.subscription,
    })),
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
  const groupId = body.groupId ? String(body.groupId) : null;

  if (!name || !email || !password)
    return err("الاسم والإيميل والباسورد مطلوبين", 400);
  if (password.length < 6) return err("كلمة السر لازم 6 أحرف على الأقل", 400);

  const exists = await db.user.findUnique({ where: { email } });
  if (exists) return err("البريد الإلكتروني مستخدم بالفعل", 409);

  const newUser = await db.user.create({
    data: {
      name,
      email,
      password: hashPassword(password),
      phone,
      role: "STUDENT",
    },
  });
  const student = await db.student.create({
    data: { userId: newUser.id, grade, schoolName, groupId },
    include: { user: true, group: { select: { name: true } } },
  });

  return ok({
    student: {
      id: student.id,
      name: student.user.name,
      email: student.user.email,
      phone: student.user.phone,
      grade: student.grade,
      schoolName: student.schoolName,
      group: student.group,
    },
  });
}
