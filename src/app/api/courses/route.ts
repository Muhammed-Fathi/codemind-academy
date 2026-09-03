import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

export async function GET() {
  const courses = await db.course.findMany({
    orderBy: { createdAt: "asc" },
  });
  return ok({ courses });
}
