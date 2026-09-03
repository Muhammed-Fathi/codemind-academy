// CodeMind Academy — API helpers
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import type { Role } from "@prisma/client";

export async function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export async function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function requireUser() {
  const u = await getCurrentUser();
  if (!u) return null;
  return u;
}

export async function requireRole(...roles: Role[]) {
  const u = await getCurrentUser();
  if (!u) return { user: null, error: err("Unauthorized", 401) };
  if (!roles.includes(u.role)) {
    return { user: null, error: err("Forbidden", 403) };
  }
  return { user: u, error: null };
}

export async function getStudentProfile(userId: string) {
  return db.student.findUnique({
    where: { userId },
    include: {
      user: true,
      group: { include: { course: true, teacher: { include: { user: true } } } },
      subscription: { include: { plan: true, payments: true } },
    },
  });
}

export async function getParentProfile(userId: string) {
  return db.parent.findUnique({
    where: { userId },
    include: {
      user: true,
      children: { include: { student: { include: { user: true, group: { include: { course: true } } } } } },
    },
  });
}

export async function getTeacherProfile(userId: string) {
  return db.teacher.findUnique({
    where: { userId },
    include: {
      user: true,
      groups: { include: { course: true, students: { include: { user: true } } } },
    },
  });
}
