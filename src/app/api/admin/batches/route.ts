// Admin batches (school-type student distribution groups).
//   GET  /api/admin/batches  — list batches + eligible student counts
//   POST /api/admin/batches  — create/ensure a batch for a school type
//
// A batch does NOT copy students or media. It is a lightweight grouping so a
// session video can be published once and resolved for every eligible student
// of that school type.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { normalizeSchoolType, SCHOOL_TYPE_LABELS } from "@/lib/school-type";
import { getServerT } from "@/lib/i18n-server";

export async function GET() {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const batches = await db.batch.findMany({
    orderBy: [{ schoolType: "asc" }, { createdAt: "asc" }],
    include: {
      course: { select: { id: true, name: true, nameAr: true } },
      _count: { select: { students: true, videos: true } },
    },
  });

  // Eligible = active student accounts of that school type who belong to an
  // active group (i.e. actually enrolled). Counted in SQL, per type.
  const [arabicEligible, languageEligible] = await Promise.all([
    db.student.count({
      where: {
        schoolType: "ARABIC",
        user: { isActive: true },
        group: { isActive: true },
      },
    }),
    db.student.count({
      where: {
        schoolType: "LANGUAGE",
        user: { isActive: true },
        group: { isActive: true },
      },
    }),
  ]);

  return ok({
    batches: batches.map((b) => ({
      id: b.id,
      name: b.name,
      nameAr: b.nameAr,
      schoolType: b.schoolType,
      course: b.course,
      isActive: b.isActive,
      members: b._count.students,
      videos: b._count.videos,
    })),
    eligible: { ARABIC: arabicEligible, LANGUAGE: languageEligible },
  });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const schoolType = normalizeSchoolType(body.schoolType);
  if (!schoolType) return err(tApi("api.210"), 400);
  const courseId = body.courseId ? String(body.courseId) : null;

  const labels = SCHOOL_TYPE_LABELS[schoolType];
  const existing = await db.batch.findFirst({ where: { schoolType, courseId } });
  if (existing) return ok({ batch: existing, created: false });

  const batch = await db.batch.create({
    data: {
      name: body.name ? String(body.name) : `${labels.en} Batch`,
      nameAr: body.nameAr ? String(body.nameAr) : `مجموعة ${labels.ar}`,
      schoolType,
      courseId,
    },
  });

  // Attach every currently eligible student of this school type. This writes
  // one small FK per student — it never duplicates course/media data.
  await db.student.updateMany({
    where: {
      schoolType,
      batchId: null,
      ...(courseId ? { group: { courseId } } : {}),
    },
    data: { batchId: batch.id },
  });

  return ok({ batch, created: true });
}
