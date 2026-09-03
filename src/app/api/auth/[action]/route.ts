import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  hashPassword,
  verifyPassword,
  createSession,
  getCurrentUser,
} from "@/lib/auth";
import { ok, err } from "@/lib/api";

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const body = await req.json().catch(() => ({}));

  if (action === "login") {
    const user = await db.user.findUnique({
      where: { email: String(body.email || "").toLowerCase() },
    });
    if (!user || !verifyPassword(String(body.password || ""), user.password)) {
      return err("بيانات الدخول مش صحيحة", 401);
    }
    if (!user.isActive) return err("الحساب موقوف", 403);
    await createSession(user.id);
    return ok({ user: safeUser(user) });
  }

  if (action === "register") {
    const email = String(body.email || "").toLowerCase().trim();
    const name = String(body.name || "").trim();
    const password = String(body.password || "");
    const role = (body.role || "STUDENT") as
      | "STUDENT"
      | "PARENT"
      | "TEACHER"
      | "ADMIN";
    if (!email || !password || !name)
      return err("كل الحقول مطلوبة", 400);
    if (password.length < 6) return err("كلمة السر لازم 6 أحرف على الأقل", 400);

    const exists = await db.user.findUnique({ where: { email } });
    if (exists) return err("البريد الإلكتروني مستخدم بالفعل", 409);

    const user = await db.user.create({
      data: {
        email,
        name,
        password: hashPassword(password),
        phone: body.phone ? String(body.phone) : null,
        role,
      },
    });

    if (role === "STUDENT") {
      await db.student.create({
        data: { userId: user.id, grade: "2nd Secondary" },
      });
    } else if (role === "PARENT") {
      await db.parent.create({ data: { userId: user.id } });
    } else if (role === "TEACHER") {
      await db.teacher.create({ data: { userId: user.id } });
    }

    await createSession(user.id);
    return ok({ user: safeUser(user) });
  }

  if (action === "logout") {
    const { destroySession } = await import("@/lib/auth");
    await destroySession();
    return ok({ ok: true });
  }

  return err("Not found", 404);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (action === "me") {
    const u = await getCurrentUser();
    if (!u) return err("Unauthorized", 401);
    return ok(u);
  }
  return err("Not found", 404);
}

function safeUser(u: any) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    avatarUrl: u.avatarUrl,
  };
}
