// CodeMind Academy — Official curriculum reconciliation (Phase 11).
//
// SERVER-ONLY. This module imports docs/curriculum/knowledge-model.json
// (~142KB) — never import it from a client component.
//
// The knowledge model is the authoritative academic contract (validated
// against the committed Ministry source PDFs). This module reconciles it
// into the database as the canonical curriculum:
//
//   Course → Part → Unit → Lesson   (Lesson.unitId, officialCode, OFFICIAL)
//
// and archives every legacy (R1) lesson of the course that carries no
// officialCode, WITHOUT deleting any row: progress, attempts, submissions,
// bookmarks and notes keep referencing their original lesson ids.
//
// Safety properties (verified by tests/curriculum-reconciliation-phase11.test.js):
//  - Idempotent: re-running converges to the same state — parts/units are
//    matched positionally inside their parent, official lessons by the UNIQUE
//    officialCode, and the archive sweep only touches non-ARCHIVED rows.
//    A second run performs zero writes (field-compare skips no-op updates).
//  - Scoped: only the known course slug is touched; lessons of other courses
//    and lessons carrying an unknown officialCode are never modified.
//  - Create-mostly: the only UPDATEs target rows the reconciler owns by
//    position/code plus the archival flag flip. No DELETEs anywhere.
//  - Crash-safe by re-run: every step is independently idempotent, so an
//    interrupted run converges on the next run (no explicit transaction —
//    see reconcileOfficialCurriculum).

import { db } from "@/lib/db";
import knowledgeModelFile from "../../docs/curriculum/knowledge-model.json";

/** Minimal surface of the Prisma client used here (allows mock injection in tests). */
export type ReconcileClient = any;

export const OFFICIAL_COURSE_SLUG = "programming-ai-2nd-sec";

// ---------------------------------------------------------------------------
// Knowledge-model shape (structural subset we consume)
// ---------------------------------------------------------------------------

type KnowledgeLesson = {
  id: string;
  code: string;
  order: number;
  title: string;
  titleAr: string;
  knowledgeSummaryEn?: string;
  objectives?: { textEn: string; textAr: string }[];
};

type KnowledgeUnit = {
  id: string;
  code: string;
  order: number;
  title: string;
  titleAr: string;
  icon?: string;
  lessons: KnowledgeLesson[];
};

type KnowledgePart = {
  id: string;
  code: string;
  order: number;
  title: string;
  titleAr: string;
  descriptionEn?: string;
  descriptionAr?: string;
  units: KnowledgeUnit[];
};

export type OfficialLessonModel = {
  code: string;
  order: number;
  title: string;
  titleAr: string;
  description: string;
};

export type OfficialUnitModel = {
  code: string;
  order: number;
  title: string;
  titleAr: string;
  icon: string | null;
  lessons: OfficialLessonModel[];
};

export type OfficialPartModel = {
  code: string;
  order: number;
  title: string;
  titleAr: string;
  description: string | null;
  units: OfficialUnitModel[];
};

export type OfficialCurriculumModel = {
  schemaVersion: string;
  parts: OfficialPartModel[];
};

/** The exact official lesson code set. Any drift fails closed. */
export const OFFICIAL_LESSON_CODES: readonly string[] = [
  "1-1", "1-2", "1-3", "1-4",
  "2-1", "2-2", "2-3",
  "3-1", "3-2", "3-3",
  "4-1", "4-2", "4-3", "4-4",
  "5-1", "5-2", "5-3",
  "6-1", "6-2", "6-3",
  "7-1", "7-2", "7-3",
] as const;

export const EXPECTED_OFFICIAL_COUNTS = {
  parts: 2,
  units: 7,
  lessons: 23,
} as const;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Load + strictly validate the knowledge model. Throws (fail-closed) when the
 * contract drifts: wrong part/unit/lesson counts, missing fields, duplicate
 * or unexpected lesson codes. Accepts an injected source for tests.
 */
export function loadOfficialCurriculumModel(
  source: unknown = knowledgeModelFile
): OfficialCurriculumModel {
  const file = source as {
    schemaVersion?: unknown;
    parts?: KnowledgePart[];
  };
  if (!file || !Array.isArray(file.parts)) {
    throw new Error("Official curriculum model is missing `parts`");
  }
  if (file.parts.length !== EXPECTED_OFFICIAL_COUNTS.parts) {
    throw new Error(
      `Official curriculum must define exactly ${EXPECTED_OFFICIAL_COUNTS.parts} parts`
    );
  }

  const seenCodes = new Set<string>();
  const parts: OfficialPartModel[] = file.parts.map((p, pIdx) => {
    if (!isNonEmptyString(p.code)) throw new Error(`Part #${pIdx + 1} is missing \`code\``);
    if (!isNonEmptyString(p.title) || !isNonEmptyString(p.titleAr)) {
      throw new Error(`Part ${p.code} is missing bilingual titles`);
    }
    if (!Array.isArray(p.units) || p.units.length === 0) {
      throw new Error(`Part ${p.code} defines no units`);
    }
    const units: OfficialUnitModel[] = p.units.map((u, uIdx) => {
      if (!isNonEmptyString(u.code)) {
        throw new Error(`Part ${p.code} unit #${uIdx + 1} is missing \`code\``);
      }
      if (!isNonEmptyString(u.title) || !isNonEmptyString(u.titleAr)) {
        throw new Error(`Unit ${u.code} is missing bilingual titles`);
      }
      if (!Array.isArray(u.lessons) || u.lessons.length === 0) {
        throw new Error(`Unit ${u.code} defines no lessons`);
      }
      const lessons: OfficialLessonModel[] = u.lessons.map((l) => {
        if (!isNonEmptyString(l.code)) throw new Error("A lesson is missing `code`");
        if (!/^\d+-\d+$/.test(l.code)) {
          throw new Error(`Lesson code is malformed: ${l.code}`);
        }
        if (seenCodes.has(l.code)) {
          throw new Error(`Duplicate lesson code in model: ${l.code}`);
        }
        seenCodes.add(l.code);
        if (!isNonEmptyString(l.title) || !isNonEmptyString(l.titleAr)) {
          throw new Error(`Lesson ${l.code} is missing bilingual titles`);
        }
        const summary = typeof l.knowledgeSummaryEn === "string" ? l.knowledgeSummaryEn.trim() : "";
        const objectives = Array.isArray(l.objectives)
          ? l.objectives.map((o) => o.textEn).filter(isNonEmptyString).join(" · ")
          : "";
        return {
          code: l.code,
          order: Number.isInteger(l.order) ? l.order : 0,
          title: l.title.trim(),
          titleAr: l.titleAr.trim(),
          description: summary || objectives || "",
        };
      });
      return {
        code: u.code,
        order: Number.isInteger(u.order) ? u.order : 0,
        title: u.title.trim(),
        titleAr: u.titleAr.trim(),
        icon: typeof u.icon === "string" && u.icon ? u.icon : null,
        lessons,
      };
    });
    return {
      code: p.code,
      order: Number.isInteger(p.order) ? p.order : 0,
      title: p.title.trim(),
      titleAr: p.titleAr.trim(),
      description:
        typeof p.descriptionEn === "string" && p.descriptionEn.trim()
          ? p.descriptionEn.trim()
          : null,
      units,
    };
  });

  const unitCount = parts.reduce((n, p) => n + p.units.length, 0);
  if (unitCount !== EXPECTED_OFFICIAL_COUNTS.units) {
    throw new Error(
      `Official curriculum must define exactly ${EXPECTED_OFFICIAL_COUNTS.units} units`
    );
  }
  if (seenCodes.size !== EXPECTED_OFFICIAL_COUNTS.lessons) {
    throw new Error(
      `Official curriculum must define exactly ${EXPECTED_OFFICIAL_COUNTS.lessons} lessons`
    );
  }
  const expected = new Set<string>(OFFICIAL_LESSON_CODES);
  for (const code of seenCodes) {
    if (!expected.has(code)) throw new Error(`Unexpected lesson code in model: ${code}`);
  }

  // Deterministic traversal order: parts, units and lessons by `order`.
  for (const p of parts) {
    p.units.sort((a, b) => a.order - b.order);
    for (const u of p.units) u.lessons.sort((a, b) => a.order - b.order);
  }
  parts.sort((a, b) => a.order - b.order);

  return {
    schemaVersion: typeof file.schemaVersion === "string" ? file.schemaVersion : "unknown",
    parts,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type ReconcileReport = {
  courseId: string;
  courseSlug: string;
  courseCreated: boolean;
  modelVersion: string;
  partsReconciled: number;
  partsCreated: number;
  unitsReconciled: number;
  unitsCreated: number;
  lessonsCreated: number;
  lessonsUpdated: number;
  officialLessonCodes: string[];
  archivedLessonIds: string[];
  warnings: string[];
};

/**
 * Deterministic read order for `Part` and `Unit` rows.
 *
 * Both models carry exactly one ordering column (`order`) plus a stable
 * immutable primary key (`id`). `order ASC, id ASC` is therefore a TOTAL and
 * STABLE order: it never depends on a column that does not exist, and it does
 * not change when the reconciler rewrites `order`/titles in place — which is
 * what makes positional adoption idempotent across runs.
 *
 * Exported so the regression test can assert that every key here really is a
 * field of the corresponding Prisma model.
 */
export const PART_UNIT_ORDER_BY = [
  { order: "asc" },
  { id: "asc" },
] as const;

function sameRecord(row: Record<string, any>, data: Record<string, any>): boolean {
  return Object.keys(data).every((k) => (row[k] ?? null) === (data[k] ?? null));
}

/**
 * Reconcile the official curriculum into the database (idempotent).
 *
 * Strategy (evidence-based, archive-safe):
 *  1. Upsert the known course by UNIQUE slug (display fields only).
 *  2. Match parts positionally inside the course (sorted by order,id —
 *     see PART_UNIT_ORDER_BY; Part/Unit have no createdAt column);
 *     update official titles/order or create missing ones. Extra parts (e.g.
 *     from a double-run dev seed) are left untouched — their lessons are
 *     archived by step 5 and the tree skips empty groups.
 *  3. Same positional match for units inside each part. Positional (not
 *     order-value) matching is REQUIRED: the legacy P2 units carry orders
 *     1,2,3 while the official model numbers chapters globally (5,6,7).
 *     No new Topic rows are ever created (ADR-003).
 *  4. Upsert official lessons by UNIQUE officialCode. On match only the
 *     canonical fields are written (unitId, titles, order, description,
 *     status, published, locked) — media, topic links and every relation
 *     (progress, quizzes, homework, videos, bookmarks, notes) are preserved.
 *  5. Archive sweep: every lesson reachable from the course through EITHER
 *     chain that carries no officialCode and is not already ARCHIVED is
 *     flipped to ARCHIVED (rows preserved, ids stable). Lessons with an
 *     officialCode outside the model are NEVER touched (warned instead).
 */
export async function reconcileOfficialCurriculum(
  client: ReconcileClient = db,
  model: OfficialCurriculumModel = loadOfficialCurriculumModel()
): Promise<ReconcileReport> {
  const warnings: string[] = [];

  // 1. Course (matched by UNIQUE slug — never touches other courses).
  const existingCourse = await client.course
    .findUnique({ where: { slug: OFFICIAL_COURSE_SLUG }, select: { id: true } })
    .catch(() => null);
  const course = await client.course.upsert({
    where: { slug: OFFICIAL_COURSE_SLUG },
    update: {
      name: "Programming & AI",
      nameAr: "البرمجة والذكاء الاصطناعي",
      description: "كورس Programming & AI لطلاب الصف الثاني الثانوي.",
      color: "#10b981",
    },
    create: {
      slug: OFFICIAL_COURSE_SLUG,
      name: "Programming & AI",
      nameAr: "البرمجة والذكاء الاصطناعي",
      description: "كورس Programming & AI لطلاب الصف الثاني الثانوي.",
      color: "#10b981",
    },
  });

  // 2+3. Parts and units, matched positionally (see docblock).
  //
  // ORDERING CONTRACT (Phase 12 repair). Neither `Part` nor `Unit` has a
  // `createdAt` column in prisma/schema.prisma — only `id`, the parent fk,
  // `title`, `titleAr`, `order` (+ `description` / `icon`). An earlier
  // revision ordered by `{ createdAt: "asc" }`, which the real Prisma client
  // rejects with `PrismaClientValidationError: Unknown argument \`createdAt\``
  // the moment this runs against an actual database (it survived review only
  // because the offline mock client ignored `orderBy`).
  //
  // `order ASC, id ASC` is the deterministic replacement: `order` is the
  // curriculum sequence and `id` (a stable cuid, assigned once at insert and
  // never rewritten) is a total, stable tie-break. Positional adoption,
  // determinism and idempotency are all preserved — see
  // PART_UNIT_ORDER_BY below and tests/curriculum-reconciliation-phase11.test.js.
  const existingParts = await client.part.findMany({
    where: { courseId: course.id },
    orderBy: [...PART_UNIT_ORDER_BY],
  });
  let partsCreated = 0;
  let unitsCreated = 0;
  const unitIdByModelKey = new Map<string, string>(); // `${partCode}:${unitCode}` → unit id

  for (let pIdx = 0; pIdx < model.parts.length; pIdx++) {
    const partModel = model.parts[pIdx];
    let part = existingParts[pIdx] ?? null;
    if (part) {
      const data = {
        title: partModel.title,
        titleAr: partModel.titleAr,
        description: partModel.description,
        order: partModel.order,
      };
      if (!sameRecord(part, data)) {
        part = await client.part.update({ where: { id: part.id }, data });
      }
    } else {
      part = await client.part.create({
        data: {
          courseId: course.id,
          title: partModel.title,
          titleAr: partModel.titleAr,
          description: partModel.description,
          order: partModel.order,
        },
      });
      partsCreated++;
    }

    const existingUnits = await client.unit.findMany({
      where: { partId: part.id },
      orderBy: [...PART_UNIT_ORDER_BY],
    });
    for (let uIdx = 0; uIdx < partModel.units.length; uIdx++) {
      const unitModel = partModel.units[uIdx];
      let unit = existingUnits[uIdx] ?? null;
      if (unit) {
        const data = {
          title: unitModel.title,
          titleAr: unitModel.titleAr,
          order: unitModel.order,
          icon: unitModel.icon,
        };
        if (!sameRecord(unit, data)) {
          unit = await client.unit.update({ where: { id: unit.id }, data });
        }
      } else {
        unit = await client.unit.create({
          data: {
            partId: part.id,
            title: unitModel.title,
            titleAr: unitModel.titleAr,
            order: unitModel.order,
            icon: unitModel.icon,
          },
        });
        unitsCreated++;
      }
      unitIdByModelKey.set(`${partModel.code}:${unitModel.code}`, unit.id);
    }
    if (existingUnits.length > partModel.units.length) {
      warnings.push(
        `Part ${partModel.code} has ${existingUnits.length} units, model defines ${partModel.units.length}; extras left untouched.`
      );
    }
  }
  if (existingParts.length > model.parts.length) {
    warnings.push(
      `Course has ${existingParts.length} parts, model defines ${model.parts.length}; extras left untouched.`
    );
  }

  // 4. Official lessons by UNIQUE officialCode.
  let lessonsCreated = 0;
  let lessonsUpdated = 0;
  const officialCodes: string[] = [];
  for (const partModel of model.parts) {
    for (const unitModel of partModel.units) {
      const unitId = unitIdByModelKey.get(`${partModel.code}:${unitModel.code}`);
      if (!unitId) throw new Error(`Internal error: unresolved unit ${unitModel.code}`);
      for (const lessonModel of unitModel.lessons) {
        officialCodes.push(lessonModel.code);
        const data = {
          unitId,
          title: lessonModel.title,
          titleAr: lessonModel.titleAr,
          order: lessonModel.order,
          description: lessonModel.description || null,
          curriculumStatus: "OFFICIAL",
          // Phase 13: lifecycle source of truth is status. Keep isPublished as
          // a compatibility mirror that stays in sync with status. New official
          // lessons are published (status=PUBLISHED) so the established 23-
          // lesson curriculum remains visible after the Phase 13 migration;
          // future lessons should be created DRAFT and opened via the ceremony.
          isPublished: true,
          isLocked: false,
          status: "PUBLISHED",
          // publishedAt is managed by the OPEN ceremony; the reconciler does
          // not overwrite it on existing rows, and for creates it is set via
          // the DB default (or left null and backfilled by the status sync).
        };
        const existing = await client.lesson
          .findUnique({ where: { officialCode: lessonModel.code } })
          .catch(() => null);
        if (existing) {
          // For updates, preserve publishedAt if already set — it is managed by
          // the OPEN ceremony. Only set it when backfilling a draft.
          const patch: Record<string, any> = { ...data };
          if (existing.publishedAt) {
            delete (patch as any).publishedAt;
          } else if (patch.status === "PUBLISHED") {
            patch.publishedAt = new Date();
          }
          if (!sameRecord(existing, patch)) {
            await client.lesson.update({ where: { id: existing.id }, data: patch });
            lessonsUpdated++;
          }
        } else {
          await client.lesson.create({
            data: { ...data, officialCode: lessonModel.code, topicId: null, publishedAt: new Date() },
          });
          lessonsCreated++;
        }
      }
    }
  }

  // 5. Archive sweep — legacy lessons of THIS course only. Rows are preserved
  // (no deletes): historical progress/attempts/submissions keep working as
  // history, while the active curriculum universe excludes ARCHIVED rows.
  const legacyCandidates = await client.lesson.findMany({
    where: {
      officialCode: null,
      curriculumStatus: { not: "ARCHIVED" },
      OR: [
        { unit: { part: { courseId: course.id } } },
        { topic: { unit: { part: { courseId: course.id } } } },
      ],
    },
    select: { id: true },
  });
  const archivedLessonIds: string[] = legacyCandidates.map((l: { id: string }) => l.id);
  if (archivedLessonIds.length > 0) {
    await client.lesson.updateMany({
      where: { id: { in: archivedLessonIds } },
      data: { curriculumStatus: "ARCHIVED" },
    });
  }

  // 6. Post-state assertions (fail-closed: a partial reconcile never reports success).
  const officialRows = await client.lesson.findMany({
    where: { officialCode: { in: officialCodes } },
    select: { id: true, officialCode: true, unitId: true, curriculumStatus: true },
  });
  const seen = new Set(officialRows.map((r: { officialCode: string }) => r.officialCode));
  const missing = officialCodes.filter((c) => !seen.has(c));
  if (missing.length > 0) {
    throw new Error(`Reconciliation incomplete: missing official lessons: ${missing.join(", ")}`);
  }
  for (const row of officialRows) {
    if (!row.unitId || row.curriculumStatus !== "OFFICIAL") {
      throw new Error(`Official lesson ${row.officialCode} is misconfigured after reconcile`);
    }
  }
  const strayOfficial = await client.lesson.findMany({
    where: {
      officialCode: { not: null },
      curriculumStatus: "OFFICIAL",
      NOT: { officialCode: { in: officialCodes } },
    },
    select: { officialCode: true },
  });
  for (const s of strayOfficial) {
    warnings.push(
      `Lesson with unknown officialCode left untouched: ${s.officialCode}`
    );
  }

  return {
    courseId: course.id,
    courseSlug: OFFICIAL_COURSE_SLUG,
    courseCreated: !existingCourse,
    modelVersion: model.schemaVersion,
    partsReconciled: model.parts.length,
    partsCreated,
    unitsReconciled: model.parts.reduce((n, p) => n + p.units.length, 0),
    unitsCreated,
    lessonsCreated,
    lessonsUpdated,
    officialLessonCodes: officialCodes,
    archivedLessonIds,
    warnings,
  };
}
