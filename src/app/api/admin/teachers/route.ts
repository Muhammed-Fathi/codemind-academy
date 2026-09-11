import { getServerT } from "@/lib/i18n-server";
// GET /api/admin/teachers — list teachers
// POST /api/admin/teachers — create teacher (also creates user)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { hashPassword } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const search = url.searchParams.get("search")?.trim() || "";

  const where: any = {};
  if (search) {
    where.OR = [
      { user: { name: { contains: search } } },
      { user: { email: { contains: search } } },
      { specialty: { contains: search } },
    ];
  }

  const teachers = await db.teacher.findMany({
    where,
    include: {
      user: true,
      groups: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return ok({
    teachers: teachers.map((t) => ({
      id: t.id,
      userId: t.userId,
      name: t.user.name,
      email: t.user.email,
      phone: t.user.phone,
      isActive: t.user.isActive,
      bio: t.bio,
      specialty: t.specialty,
      groups: t.groups,
      groupsCount: t.groups.length,
    })),
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
  const bio = body.bio ? String(body.bio) : null;
  const specialty = body.specialty ? String(body.specialty) : null;

  if (!name || !email || !password)
    return err(tApi("api.051"), 400);
  // Security Audit Gate (pre-P21): the platform minimum is 8 everywhere
  // else (self-service reset, teacher activation, and the client-side
  // registration form). An admin-provisioned TEACHER account is privileged,
  // is never forced to change this password, and used to accept 6.
  if (password.length < 8) return err(tApi("api.204"), 400);

  const exists = await db.user.findUnique({ where: { email } });
  if (exists) return err(tApi("api.053"), 409);

  const newUser = await db.user.create({
    data: {
      name,
      email,
      password: hashPassword(password),
      phone,
      role: "TEACHER",
    },
  });
  const teacher = await db.teacher.create({
    data: { userId: newUser.id, bio, specialty },
  });

  return ok({ teacher: { id: teacher.id, name, email } });
}
