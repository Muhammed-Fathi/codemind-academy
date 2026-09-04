import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  hashPassword,
  verifyPassword,
  createSession,
  getCurrentUser,
} from "@/lib/auth";
import { ok, err } from "@/lib/api";
import {
  isValidArabicThreePartName,
  isValidEgyptianPhone,
  isValidEmail,
  isValidNationalId,
  isValidStudentCode,
  isValidThreePartName,
  normalizePhone,
} from "@/lib/registration";
import { createStudentWithCode } from "@/lib/curriculum-seed";

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const body = await req.json().catch(() => ({}));

  if (action === "login") {
    const user = await db.user.findUnique({
      where: { email: String(body.email || "").toLowerCase().trim() },
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
    if (!isValidEmail(email)) return err("البريد الإلكتروني غير صالح", 400);
    if (password.length < 6) return err("كلمة السر لازم 6 أحرف على الأقل", 400);

    const exists = await db.user.findUnique({ where: { email } });
    if (exists) return err("البريد الإلكتروني مستخدم بالفعل", 409);

    // ---------------- STUDENT ----------------
    if (role === "STUDENT") {
      const studentPhone = String(body.studentPhone || body.phone || "").trim();
      const parentPhone = String(body.parentPhone || "").trim();
      const nationalId = String(body.nationalId || "").trim();
      const schoolName = String(body.schoolName || "").trim();
      const schoolType = String(body.schoolType || "").trim().toUpperCase();

      if (!isValidArabicThreePartName(name))
        return err("الاسم الكامل لازم يكون ثلاثي باللغة العربية (مطابق للبطاقة)", 400);
      if (!studentPhone || !isValidEgyptianPhone(studentPhone))
        return err("رقم تليفون الطالب غير صالح (مثال: 01147422177)", 400);
      if (!parentPhone || !isValidEgyptianPhone(parentPhone))
        return err("رقم تليفون ولي الأمر غير صالح (مثال: 01147422177)", 400);
      if (!isValidNationalId(nationalId))
        return err("الرقم القومي لازم يكون 14 رقم", 400);
      if (!schoolName) return err("اسم المدرسة مطلوب", 400);
      if (schoolType !== "LANGUAGE" && schoolType !== "ARABIC")
        return err("اختار نوع المدرسة: لغات أو عربي", 400);

      const nationalTaken = await (db as any).student.findUnique({
        where: { nationalId },
      }).catch(() => null);
      if (nationalTaken) return err("الرقم القومي ده مسجل بالفعل", 409);

      const user = await db.user.create({
        data: {
          email,
          name,
          password: hashPassword(password),
          phone: studentPhone,
          role,
        },
      });

      const student = await createStudentWithCode(db, {
        userId: user.id,
        grade: "2nd Secondary",
        schoolName,
        schoolType,
        nationalId,
        parentPhone,
      });

      await createSession(user.id);
      return ok({
        user: { ...safeUser(user), studentCode: (student as any).studentCode },
      });
    }

    // ---------------- PARENT ----------------
    if (role === "PARENT") {
      const parentPhone = String(body.parentPhone || body.phone || "").trim();
      const studentNationalId = String(
        body.studentNationalId || body.nationalId || ""
      ).trim();
      const studentCode = String(body.studentCode || "").trim().toUpperCase();

      if (!isValidThreePartName(name))
        return err("الاسم الكامل لازم يكون ثلاثي", 400);
      if (!parentPhone || !isValidEgyptianPhone(parentPhone))
        return err("رقم تليفون ولي الأمر غير صالح (مثال: 01147422177)", 400);
      if (!isValidNationalId(studentNationalId))
        return err("الرقم القومي للطالب لازم يكون 14 رقم", 400);
      if (!isValidStudentCode(studentCode))
        return err("كود الطالب غير صالح (مثال: CM-ABC123)", 400);

      // Linking logic: match Parent Phone Number + Student National ID
      // (provided by the student during their registration) plus the
      // unique Student Code to verify the student exists.
      const matched = await (db as any).student.findFirst({
        where: { nationalId: studentNationalId, studentCode },
        include: { user: true },
      });
      if (!matched) return err("مفيش طالب بالرقم القومي وكود الطالب دول", 404);
      const storedParentPhone = normalizePhone(String(matched.parentPhone || ""));
      if (!storedParentPhone || storedParentPhone !== normalizePhone(parentPhone)) {
        return err(
          "رقم تليفون ولي الأمر غير مطابق للرقم المسجل مع بيانات الطالب",
          404
        );
      }

      const user = await db.user.create({
        data: {
          email,
          name,
          password: hashPassword(password),
          phone: parentPhone,
          role,
        },
      });

      const parent = await db.parent.create({ data: { userId: user.id } });
      await db.parentStudentLink.upsert({
        where: {
          parentId_studentId: { parentId: parent.id, studentId: matched.id },
        },
        update: {},
        create: { parentId: parent.id, studentId: matched.id, relation: "parent" },
      });

      await createSession(user.id);
      return ok({ user: safeUser(user) });
    }

    // ---------------- TEACHER / ADMIN (unchanged) ----------------
    if (!name) return err("كل الحقول مطلوبة", 400);
    const user = await db.user.create({
      data: {
        email,
        name,
        password: hashPassword(password),
        phone: body.phone ? String(body.phone) : null,
        role,
      },
    });

    if (role === "TEACHER") {
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
    // Attach studentCode for students so it is visible globally.
    if ((u as any).role === "STUDENT") {
      try {
        const s = await (db as any).student.findUnique({
          where: { userId: (u as any).id },
          select: { studentCode: true },
        });
        return NextResponse.json({ ...(u as any), studentCode: s?.studentCode || null });
      } catch {}
    }
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
