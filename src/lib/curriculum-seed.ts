// CodeMind Academy — Student-code helpers + RETIRED curriculum seeder.
//
// ⚠ PHASE 11 — seedCurriculumFromFile is RETIRED (the `/api/admin/courses`
// `{action:"seed"}` endpoint returns 410 Gone, and the scripts call
// reconcileOfficialCurriculum instead). It is kept, compiling and behavior-
// pinned by tests/seed-idempotency.test.js, for historical reference ONLY —
// never call it against live data.
//
// Still SUPPORTED (not deprecated): createStudentWithCode and
// backfillStudentCodes, used by registration and admin student management.
//
// Safety properties (verified by tests/seed-idempotency.test.js):
//  - CREATE-only: never UPDATEs or DELETEs unrelated rows (the single
//    upsert targets ONLY the known course slug; the update branch only
//    refreshes that same course's display fields).
//  - Re-running never duplicates: if ANY parts exist for the course,
//    content creation is skipped entirely.
//  - Code backfill only touches students whose studentCode IS NULL/"".
import { db } from "@/lib/db";
import { CURRICULUM } from "@/lib/curriculum";
import { generateStudentCode } from "@/lib/registration";

export const COURSE_SLUG = "programming-ai-2nd-sec";

/** Minimal surface of the Prisma client used here (allows mock injection in tests). */
export type SeedClient = any;

export async function seedCurriculumFromFile(client: SeedClient = db) {
  // Phase 11: loud trip-wire — this function is retired; any live invocation
  // (outside the pinning regression test) is a bug. Kept functional ONLY so
  // tests/seed-idempotency.test.js can pin its historical behavior.
  console.warn(
    "[RETIRED] seedCurriculumFromFile must not run against live data — " +
      "use reconcileOfficialCurriculum (@/lib/official-curriculum) instead."
  );
  // 1. Upsert the course (matched by UNIQUE slug — never touches other courses)
  const course = await client.course.upsert({
    where: { slug: COURSE_SLUG },
    update: {
      name: "Programming & AI",
      nameAr: "البرمجة والذكاء الاصطناعي",
      description: "كورس Programming & AI لطلاب الصف الثاني الثانوي.",
      color: "#10b981",
    },
    create: {
      slug: COURSE_SLUG,
      name: "Programming & AI",
      nameAr: "البرمجة والذكاء الاصطناعي",
      description: "كورس Programming & AI لطلاب الصف الثاني الثانوي.",
      color: "#10b981",
    },
  });

  // 2. If curriculum already seeded, skip re-creating (idempotent).
  const existingParts = await client.part.count({ where: { courseId: course.id } });
  if (existingParts > 0) {
    return { courseId: course.id, created: false, message: "Curriculum already seeded" };
  }

  // 3. Create parts / units / topics / lessons from CURRICULUM
  for (let pIdx = 0; pIdx < CURRICULUM.length; pIdx++) {
    const partData = CURRICULUM[pIdx];
    const part = await client.part.create({
      data: {
        courseId: course.id,
        title: partData.title,
        titleAr: partData.titleAr,
        description: partData.description,
        order: pIdx + 1,
      },
    });
    for (let uIdx = 0; uIdx < partData.units.length; uIdx++) {
      const unitData = partData.units[uIdx];
      const unit = await client.unit.create({
        data: {
          partId: part.id,
          title: unitData.title,
          titleAr: unitData.titleAr,
          icon: unitData.icon,
          order: uIdx + 1,
        },
      });
      for (let tIdx = 0; tIdx < unitData.topics.length; tIdx++) {
        const topicData = unitData.topics[tIdx];
        const topic = await client.topic.create({
          data: {
            unitId: unit.id,
            title: topicData.title,
            titleAr: topicData.titleAr,
            order: tIdx + 1,
          },
        });
        for (let lIdx = 0; lIdx < topicData.lessons.length; lIdx++) {
          const lessonData = topicData.lessons[lIdx];
          await client.lesson.create({
            data: {
              topicId: topic.id,
              title: lessonData.title,
              titleAr: lessonData.titleAr,
              description: lessonData.description || "",
              duration: lessonData.duration,
              order: lIdx + 1,
              isLocked: lIdx > 0,
            },
          });
        }
      }
    }
  }

  const counts = await Promise.all([
    client.part.count({ where: { courseId: course.id } }),
    client.lesson.count({ where: { topic: { unit: { part: { courseId: course.id } } } } }),
  ]);

  return {
    courseId: course.id,
    created: true,
    message: `Seeded ${counts[0]} parts / ${counts[1]} lessons`,
  };
}

function isUniqueConflict(e: any): boolean {
  return e?.code === "P2002" || /UNIQUE constraint failed/i.test(String(e?.message || ""));
}

/**
 * Backfill `studentCode` for pre-migration students that have none.
 * - Only rows with NULL/"" codes are touched; existing codes are NEVER rewritten.
 * - Uniqueness is enforced in two layers: a pre-check AND a retry-on-conflict
 *   around the UPDATE, so concurrent runs can never violate the UNIQUE index.
 * Returns the number of students backfilled.
 */
export async function backfillStudentCodes(client: SeedClient = db): Promise<number> {
  const withoutCode = await client.student.findMany({
    where: { OR: [{ studentCode: null }, { studentCode: "" }] },
    select: { id: true },
  });

  let done = 0;
  for (const s of withoutCode) {
    let updated = false;
    for (let attempt = 0; attempt < 12 && !updated; attempt++) {
      const code = generateStudentCode();
      const taken = await client.student
        .findUnique({ where: { studentCode: code } })
        .catch(() => null);
      if (taken) continue;
      try {
        await client.student.update({
          where: { id: s.id },
          data: { studentCode: code },
        });
        updated = true;
        done++;
      } catch (e) {
        // Lost a race with another writer → retry with a fresh code.
        if (!isUniqueConflict(e)) throw e;
      }
    }
    // Re-read: another concurrent run may have filled it already.
    if (!updated) {
      const fresh = await client.student
        .findUnique({ where: { id: s.id }, select: { studentCode: true } })
        .catch(() => null);
      if (fresh?.studentCode) {
        done++;
      } else {
        throw new Error(`Could not assign a unique student code for ${s.id}`);
      }
    }
  }
  return done;
}

/**
 * Generate a studentCode guaranteed unused at check time.
 * Callers must still handle P2002 on INSERT (see createStudentWithCode).
 */
export async function generateUniqueStudentCode(client: SeedClient = db): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const code = generateStudentCode();
    const taken = await client.student
      .findUnique({ where: { studentCode: code } })
      .catch(() => null);
    if (!taken) return code;
  }
  // Entropy fallback (still matches CM-XXXXXX and the validator).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `CM-${suffix}`;
}

/**
 * Create a Student row with a unique code, retrying once if a concurrent
 * insert wins the same code (P2002). `data` must NOT contain studentCode.
 */
export async function createStudentWithCode(
  client: SeedClient,
  data: Record<string, unknown>
) {
  let lastError: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.student.create({
        data: { ...data, studentCode: await generateUniqueStudentCode(client) },
      });
    } catch (e) {
      lastError = e;
      if (!isUniqueConflict(e)) throw e;
    }
  }
  throw lastError;
}
