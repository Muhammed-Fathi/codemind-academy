import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Teacher Lesson Plan Templates API
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

// GET — list templates (public + teacher's own)
export async function GET() {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER" && user.role !== "ADMIN")
    return err(tApi("api.186"), 403);

  let teacherId: string | undefined;
  if (user.role === "TEACHER") {
    const teacher = await db.teacher.findUnique({ where: { userId: user.id } });
    teacherId = teacher?.id;
  }

  const where: any = {
    OR: [{ isPublic: true }],
  };
  if (teacherId) where.OR.push({ teacherId });

  const templates = await db.lessonPlanTemplate.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  return ok({
    templates: templates.map((t) => ({
      id: t.id,
      title: t.title,
      titleAr: t.titleAr,
      description: t.description,
      duration: t.duration,
      objectives: JSON.parse(t.objectives),
      materials: JSON.parse(t.materials),
      activities: JSON.parse(t.activities),
      homework: t.homework,
      assessment: t.assessment,
      isPublic: t.isPublic,
      createdAt: t.createdAt,
    })),
  });
}

// POST — create template
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER" && user.role !== "ADMIN")
    return err(tApi("api.186"), 403);

  const body = await req.json().catch(() => ({}));
  const {
    title,
    titleAr,
    description,
    duration,
    objectives,
    materials,
    activities,
    homework,
    assessment,
    isPublic,
  } = body as {
    title?: string;
    titleAr?: string;
    description?: string;
    duration?: number;
    objectives?: string[];
    materials?: string[];
    activities?: { title: string; description: string; duration: number }[];
    homework?: string;
    assessment?: string;
    isPublic?: boolean;
  };

  if (!title || !titleAr) return err(tApi("api.187"), 400);

  let teacherId: string | undefined;
  if (user.role === "TEACHER") {
    const teacher = await db.teacher.findUnique({ where: { userId: user.id } });
    teacherId = teacher?.id;
  }

  const template = await db.lessonPlanTemplate.create({
    data: {
      teacherId,
      title,
      titleAr,
      description: description || null,
      duration: duration || 90,
      objectives: JSON.stringify(objectives || []),
      materials: JSON.stringify(materials || []),
      activities: JSON.stringify(activities || []),
      homework: homework || null,
      assessment: assessment || null,
      isPublic: isPublic ?? true,
    },
  });

  return ok({ template });
}
