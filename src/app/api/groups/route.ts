import { NextRequest, NextResponse } from "next/server";
import { ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const courseId = url.searchParams.get("courseId");
  const where: any = { isActive: true };
  if (courseId) where.courseId = courseId;
  const groups = await db.group.findMany({
    where,
    include: {
      course: true,
      teacher: { include: { user: true } },
      _count: { select: { students: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return ok({ groups });
}
