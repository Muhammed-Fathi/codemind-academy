import { getServerT } from "@/lib/i18n-server";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  hashPassword,
  verifyPassword,
  createSession,
  getCurrentUser,
  getCurrentUserDetailed,
} from "@/lib/auth";
import { logSecurityEvent } from "@/lib/security";
import { headers } from "next/headers";
import {
  ok,
  err,
  applyRateLimitForIdentifier,
  rateLimitedResponse,
} from "@/lib/api";
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
import { requireSchoolType } from "@/lib/school-type";
import { reconcileStudentBatch } from "@/lib/enrollment";
import { submitTeacherApplication } from "@/lib/teacher-applications";

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const tApi = await getServerT();
  const { action } = await params;
  const body = await req.json().catch(() => ({}));

  if (action === "login") {
    const hdrs = await headers();
    const user = await db.user.findUnique({
      where: { email: String(body.email || "").toLowerCase().trim() },
    });
    if (!user || !verifyPassword(String(body.password || ""), user.password)) {
      await logSecurityEvent({
        userId: user?.id ?? null,
        type: "LOGIN_FAILED",
        detail: "Invalid credentials",
        headers: hdrs,
      });
      return err(tApi("api.057"), 401);
    }
    // Account suspended for concurrent multi-device use: the message is
    // explicit so the student knows to contact support (admin can reactivate).
    if (user.status === "SUSPENDED_MULTI_DEVICE") {
      return NextResponse.json(
        { error: tApi("api.207"), code: "ACCOUNT_SUSPENDED_MULTI_DEVICE" },
        { status: 403 }
      );
    }
    if (!user.isActive || user.status === "INACTIVE")
      return err(tApi("api.058"), 403);

    // Single-device enforcement happens server-side inside createSession().
    const { conflict } = await createSession(user.id);
    if (conflict) {
      return NextResponse.json(
        { error: tApi("api.207"), code: "ACCOUNT_SUSPENDED_MULTI_DEVICE" },
        { status: 403 }
      );
    }
    await logSecurityEvent({
      userId: user.id,
      type: "LOGIN_SUCCESS",
      headers: hdrs,
    });
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

    // ---------------- TEACHER — public APPLICATION (Phase 20) ----------------
    // A person applying to teach must NOT get an active Teacher account, a
    // Teacher session, or `User.role = TEACHER` here. They create a PENDING
    // `TeacherApplication`; an Admin approves, and the applicant later sets
    // their own password through a single-use activation token.
    if (role === "TEACHER") {
      const hdrs = await headers();
      if (!name || !email) return err(tApi("api.059"), 400);
      if (!isValidEmail(email)) return err(tApi("api.060"), 400);

      const applyLimit = await applyRateLimitForIdentifier("teacherApply", email);
      if (!applyLimit.allowed) return rateLimitedResponse(applyLimit);

      const phone = String(body.phone || "").trim();
      if (phone && !isValidEgyptianPhone(phone))
        return err(tApi("api.064"), 400);
      const specialty = String(body.specialty || "").trim().slice(0, 200) || null;
      const bio = String(body.bio || "").trim().slice(0, 1000) || null;

      const outcome = await submitTeacherApplication({
        email,
        name,
        phone: phone || null,
        specialty,
        bio,
      });
      if (!outcome.ok) {
        // One generic answer for every blocked case (existing account of ANY
        // role, existing pending/approved application, already activated) — the
        // caller learns nothing about which account/application state exists.
        await logSecurityEvent({
          userId: null,
          type: "TEACHER_APPLICATION_BLOCKED",
          detail: `reason=${outcome.reason}`,
          headers: hdrs,
        });
        return err(tApi("api.258"), 409);
      }

      await logSecurityEvent({
        userId: null,
        type: "TEACHER_APPLICATION_SUBMITTED",
        detail: `applicationId=${outcome.application.id} reapplied=${outcome.reapplied}`,
        headers: hdrs,
      });
      return ok({ applied: true, message: tApi("api.259") });
    }

    // Public admin registration stays prohibited (privilege escalation).
    if (role === "ADMIN") return err(tApi("api.059"), 400);

    if (!email || !password || !name)
      return err(tApi("api.059"), 400);
    if (!isValidEmail(email)) return err(tApi("api.060"), 400);
    if (password.length < 6) return err(tApi("api.061"), 400);

    const exists = await db.user.findUnique({ where: { email } });
    if (exists) return err(tApi("api.062"), 409);

    // ---------------- STUDENT ----------------
    if (role === "STUDENT") {
      const studentPhone = String(body.studentPhone || body.phone || "").trim();
      const parentPhone = String(body.parentPhone || "").trim();
      const nationalId = String(body.nationalId || "").trim();
      const schoolName = String(body.schoolName || "").trim();
      // Phase 12 — ONE validation mechanism for every school-type write path.
      // The raw value is never stored: it is normalised here and an
      // unrecognised value is rejected, so `Student.schoolType` can only ever
      // hold a canonical enum value.
      const schoolTypeCheck = requireSchoolType(body.schoolType);

      if (!isValidArabicThreePartName(name))
        return err(tApi("api.063"), 400);
      if (!studentPhone || !isValidEgyptianPhone(studentPhone))
        return err(tApi("api.064"), 400);
      if (!parentPhone || !isValidEgyptianPhone(parentPhone))
        return err(tApi("api.065"), 400);
      if (!isValidNationalId(nationalId))
        return err(tApi("api.066"), 400);
      if (!schoolName) return err(tApi("api.067"), 400);
      if (!schoolTypeCheck.ok) return err(tApi("api.068"), 400);
      const schoolType = schoolTypeCheck.value;

      const nationalTaken = await (db as any).student.findUnique({
        where: { nationalId },
      }).catch(() => null);
      if (nationalTaken) return err(tApi("api.069"), 409);

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

      // Phase 12 — attach the batch at creation time instead of waiting for
      // the student to open the session-videos page. Deterministic,
      // idempotent, and a no-op when no matching batch exists yet.
      await reconcileStudentBatch((student as { id: string }).id);

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
        return err(tApi("api.070"), 400);
      if (!parentPhone || !isValidEgyptianPhone(parentPhone))
        return err(tApi("api.065"), 400);
      if (!isValidNationalId(studentNationalId))
        return err(tApi("api.071"), 400);
      if (!isValidStudentCode(studentCode))
        return err(tApi("api.072"), 400);

      // Linking logic: match Parent Phone Number + Student National ID
      // (provided by the student during their registration) plus the
      // unique Student Code to verify the student exists.
      const matched = await (db as any).student.findFirst({
        where: { nationalId: studentNationalId, studentCode },
        include: { user: true },
      });
      // Phase 7: both failure branches answer 404 with the SAME message
      // (api.073 and api.074 are intentionally identical text) so a failed
      // parent registration never confirms that a guessed (national ID +
      // student code) pair belongs to a real student.
      if (!matched) return err(tApi("api.073"), 404);
      const storedParentPhone = normalizePhone(String(matched.parentPhone || ""));
      if (!storedParentPhone || storedParentPhone !== normalizePhone(parentPhone)) {
        return err(
          tApi("api.074"),
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

    // ---------------- TEACHER / ADMIN — registration blocked --------
    // (Phase 20: TEACHER now submits a PENDING application above; only the
    // public ADMIN self-registration remains blocked, as a privilege
    // escalation guard. Teacher/Admin accounts are provisioned through the
    // approved activation flow / the admin management API.)
    if (role === "ADMIN") {
      return err(tApi("api.059"), 400);
    }

    return err(tApi("api.059"), 400);
  }

  if (action === "logout") {
    const { destroySession } = await import("@/lib/auth");
    const current = await getCurrentUser().catch(() => null);
    await destroySession();
    if (current) {
      await logSecurityEvent({ userId: current.id, type: "LOGOUT" });
    }
    return ok({ ok: true });
  }

  return err("Not found", 404);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (action === "me") {
    const { user: u, reason } = await getCurrentUserDetailed();
    if (!u) {
      if (reason === "SUSPENDED") {
        const tApi = await getServerT();
        return NextResponse.json(
          { error: tApi("api.207"), code: "ACCOUNT_SUSPENDED_MULTI_DEVICE" },
          { status: 403 }
        );
      }
      return err("Unauthorized", 401);
    }
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
