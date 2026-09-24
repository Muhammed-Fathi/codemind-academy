// CodeMind Academy — Official curriculum reconciliation (Phase 11).
//
// SERVER-ONLY. This module imports the per-level curriculum models
// (docs/curriculum/<level>/knowledge-model.json) — never import it from a
// client component.
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
import { LESSON_NEW_LIFECYCLE } from "@/lib/session-lifecycle";
import { normalizeAcademicLevel, type AcademicLevel } from "@/lib/academic-level";
import knowledgeModelFile from "../../docs/curriculum/second-secondary/knowledge-model.json";
// Phase L — the First Secondary curriculum model, generated from the approved
// bilingual extraction manifest that sits next to it. Same shape as its Second
// Secondary sibling, so the SAME loader and the SAME reconciler serve both.
import firstSecondaryModelFile from "../../docs/curriculum/first-secondary/knowledge-model.json";

/** Minimal surface of the Prisma client used here (allows mock injection in tests). */
export type ReconcileClient = any;

// ---------------------------------------------------------------------------
// Phase K2 — ONE engine, PARAMETERISED by a level-curriculum SPEC.
//
// Nothing in the reconciler below assumes "Second Secondary", one course
// slug, 2 parts, 7 units or 23 lessons: every such fact lives in a
// `LevelCurriculumSpec`. `SECOND_SECONDARY_SPEC` byte-pins the existing
// Second Secondary behaviour (same slug, same counts, same codes, same
// course metadata, same knowledge-model file) and remains the default, so
// every pre-K2 caller behaves identically. First Secondary is CAPABILITY
// only here: its spec/knowledge model are added in Phase L — no First
// Secondary curriculum row is created by anything in this module.
// ---------------------------------------------------------------------------

export type LevelCurriculumSpec = {
  academicLevel: AcademicLevel;
  courseSlug: string;
  course: { name: string; nameAr: string; description: string; color: string };
  expectedCounts: { parts: number; units: number; lessons: number };
  expectedCodes: readonly string[];
  /** Raw knowledge-model JSON for this level (validated by `loadLevelCurriculumModel`). */
  knowledgeModel: unknown;
};

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

/** Second Secondary — the byte-pinned existing official curriculum. */
export const SECOND_SECONDARY_SPEC: LevelCurriculumSpec = {
  academicLevel: "SECOND_SECONDARY",
  courseSlug: OFFICIAL_COURSE_SLUG,
  course: {
    name: "Programming & AI",
    nameAr: "البرمجة والذكاء الاصطناعي",
    description: "كورس Programming & AI لطلاب الصف الثاني الثانوي.",
    color: "#10b981",
  },
  expectedCounts: EXPECTED_OFFICIAL_COUNTS,
  expectedCodes: OFFICIAL_LESSON_CODES,
  knowledgeModel: knowledgeModelFile,
};

// ---------------------------------------------------------------------------
// Phase L — FIRST SECONDARY.
//
// APPROVED extraction checkpoint: 13 official chapters → 13 Units, 62 official
// lessons → 62 Lessons, ONE synthetic structural Part, ZERO Topics. Source of
// truth: docs/curriculum/first-secondary/first-secondary-curriculum.json (the
// bilingual manifest, extracted from the paired EN + AR Ministry PDFs and
// approved); `…/knowledge-model.json` is its compact runtime representation and
// a regression test re-derives it from the manifest, so the two cannot drift.
//
// The canonical lesson code is the ENGLISH CHAPTER-FIRST structure ("1-1" …
// "13-12"). The Arabic edition prints the REVERSE badge ("1-13"), and prints
// "1-2" twice (unit 1 lesson 2 and unit 2 lesson 1) — a source printing defect
// that makes the Arabic badge unusable as a platform identity. It is therefore
// provenance only, kept in the manifest and deliberately ABSENT from the
// runtime model: no lookup, uniqueness, progression, session, quiz or
// reconciliation path may ever see it.
// ---------------------------------------------------------------------------

/** The exact First Secondary official lesson code set. Any drift fails closed. */
export const FIRST_SECONDARY_LESSON_CODES: readonly string[] = [
  "1-1", "1-2",
  "2-1", "2-2", "2-3",
  "3-1", "3-2", "3-3", "3-4", "3-5",
  "4-1",
  "5-1", "5-2", "5-3",
  "6-1", "6-2", "6-3", "6-4", "6-5", "6-6", "6-7", "6-8", "6-9", "6-10",
  "7-1", "7-2", "7-3",
  "8-1", "8-2", "8-3", "8-4", "8-5",
  "9-1", "9-2", "9-3",
  "10-1", "10-2", "10-3", "10-4", "10-5", "10-6",
  "11-1", "11-2", "11-3", "11-4",
  "12-1", "12-2", "12-3", "12-4", "12-5",
  "13-1", "13-2", "13-3", "13-4", "13-5", "13-6", "13-7", "13-8", "13-9",
  "13-10", "13-11", "13-12",
] as const;

export const FIRST_SECONDARY_EXPECTED_COUNTS = {
  parts: 1,
  units: 13,
  lessons: 62,
} as const;

/** First Secondary — the synthetic-Part official curriculum (Phase L). */
export const FIRST_SECONDARY_SPEC: LevelCurriculumSpec = {
  academicLevel: "FIRST_SECONDARY",
  courseSlug: "programming-ai-1st-sec",
  course: {
    name: "Programming & AI",
    nameAr: "البرمجة والذكاء الاصطناعي",
    description: "كورس Programming & AI لطلاب الصف الأول الثانوي.",
    color: "#10b981",
  },
  expectedCounts: FIRST_SECONDARY_EXPECTED_COUNTS,
  expectedCodes: FIRST_SECONDARY_LESSON_CODES,
  knowledgeModel: firstSecondaryModelFile,
};

/**
 * Phase L — every registered official curriculum, one per academic level.
 *
 * The reconciler stays SINGLE-ENGINE and spec-parameterised: this registry is
 * the only place that knows both levels exist, and `reconcileAllOfficialCurricula`
 * simply calls the one engine once per entry. Because each run is scoped to its
 * own `courseSlug` + level, reconciling one level can never touch the other.
 */
export const LEVEL_CURRICULUM_SPECS: readonly LevelCurriculumSpec[] = [
  SECOND_SECONDARY_SPEC,
  FIRST_SECONDARY_SPEC,
];

/** The spec for a level, or null when the level has no official curriculum. */
export function specForLevel(level: unknown): LevelCurriculumSpec | null {
  const normalized = normalizeAcademicLevel(level);
  if (!normalized) return null;
  return LEVEL_CURRICULUM_SPECS.find((s) => s.academicLevel === normalized) ?? null;
}


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
  return loadLevelCurriculumModel({ ...SECOND_SECONDARY_SPEC, knowledgeModel: source });
}

/**
 * Phase K2 — the level-aware loader: validates `spec.knowledgeModel` against
 * the spec's OWN expected counts and code set (no platform-wide constant).
 */
export function loadLevelCurriculumModel(spec: LevelCurriculumSpec): OfficialCurriculumModel {
  const source = spec.knowledgeModel;
  const expectedCounts = spec.expectedCounts;
  const file = source as {
    schemaVersion?: unknown;
    parts?: KnowledgePart[];
  };
  if (!file || !Array.isArray(file.parts)) {
    throw new Error("Official curriculum model is missing `parts`");
  }
  if (file.parts.length !== expectedCounts.parts) {
    throw new Error(
      `Official curriculum must define exactly ${expectedCounts.parts} parts`
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
  if (unitCount !== expectedCounts.units) {
    throw new Error(
      `Official curriculum must define exactly ${expectedCounts.units} units`
    );
  }
  if (seenCodes.size !== expectedCounts.lessons) {
    throw new Error(
      `Official curriculum must define exactly ${expectedCounts.lessons} lessons`
    );
  }
  const expected = new Set<string>(spec.expectedCodes);
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
  /** Phase K2 — the level this run reconciled (== spec.academicLevel). */
  academicLevel: AcademicLevel;
  courseCreated: boolean;
  modelVersion: string;
  partsReconciled: number;
  partsCreated: number;
  unitsReconciled: number;
  unitsCreated: number;
  lessonsCreated: number;
  /**
   * Phase 13: how many of the created rows started life DRAFT (all of them —
   * the reconciler never publishes). Surfaced so the admin screen can say
   * "N sessions staged, open them when ready" instead of looking broken.
   */
  lessonsCreatedAsDraft: number;
  /** PUBLISHED vs still-staged split of the official set after reconciling. */
  lessonsPublished: number;
  lessonsAwaitingOpen: number;
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
 *  4. Upsert official lessons by the LEVEL-SCOPED unique
 *     (academicLevel, officialCode) — Phase K3 replaced the global
 *     officialCode unique, so a code is looked up together with the spec's
 *     level, never alone. On match only the
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
  modelOrSpec: OfficialCurriculumModel | LevelCurriculumSpec = SECOND_SECONDARY_SPEC
): Promise<ReconcileReport> {
  // Phase K2 — accept either a SPEC (level-aware) or, for backward
  // compatibility with pre-K2 callers/tests that inject a pre-validated
  // Second Secondary model, a bare model (reconciled under the Second
  // Secondary spec exactly as before).
  const spec: LevelCurriculumSpec =
    "academicLevel" in modelOrSpec ? modelOrSpec : SECOND_SECONDARY_SPEC;
  const model: OfficialCurriculumModel =
    "academicLevel" in modelOrSpec ? loadLevelCurriculumModel(modelOrSpec) : modelOrSpec;
  const warnings: string[] = [];
  const level = spec.academicLevel;

  // 1. Course (matched by UNIQUE slug — never touches other courses).
  //
  // G7 / I3 — LEVEL AUTHORITY CHECK before any write: a course that already
  // exists under this slug with a DIFFERENT stored level is a configuration
  // conflict (the spec would silently re-level an entire curriculum, its
  // groups and its students). Refuse. A legacy NULL level is adopted (the
  // K1 backfill sets every existing course; NULL means "never levelled").
  const existingCourse = await client.course
    .findUnique({ where: { slug: spec.courseSlug }, select: { id: true, academicLevel: true } })
    .catch(() => null);
  const storedLevel = normalizeAcademicLevel(existingCourse?.academicLevel);
  if (existingCourse && storedLevel && storedLevel !== level) {
    throw new Error(
      `Reconciliation refused: course ${spec.courseSlug} is ${storedLevel}, spec is ${level}`
    );
  }
  const course = await client.course.upsert({
    where: { slug: spec.courseSlug },
    update: {
      name: spec.course.name,
      nameAr: spec.course.nameAr,
      description: spec.course.description,
      color: spec.course.color,
      academicLevel: level,
    },
    create: {
      slug: spec.courseSlug,
      name: spec.course.name,
      nameAr: spec.course.nameAr,
      description: spec.course.description,
      color: spec.course.color,
      academicLevel: level,
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

  // 4. Official lessons by the LEVEL-SCOPED unique (academicLevel, officialCode).
  let lessonsCreated = 0;
  let lessonsUpdated = 0;
  const officialCodes: string[] = [];
  for (const partModel of model.parts) {
    for (const unitModel of partModel.units) {
      const unitId = unitIdByModelKey.get(`${partModel.code}:${unitModel.code}`);
      if (!unitId) throw new Error(`Internal error: unresolved unit ${unitModel.code}`);
      for (const lessonModel of unitModel.lessons) {
        officialCodes.push(lessonModel.code);
        // Phase 13: `data` is the CURRICULUM contract only. The reconciler no
        // longer writes `isPublished` (nor the retired `isLocked`): an
        // idempotent structural sync that also forced the lifecycle flag would
        // make it a second publisher, silently re-opening a session an admin
        // had unpublished and flipping a staged one open without the
        // ceremony. `status` belongs to the OPEN ceremony alone.
        // Phase K2 — `academicLevel` is the DERIVED level of the owning
        // course (I2): it is written from the spec (== course level, proven
        // above), never from the model file or a caller.
        const data = {
          unitId,
          title: lessonModel.title,
          titleAr: lessonModel.titleAr,
          order: lessonModel.order,
          description: lessonModel.description || null,
          curriculumStatus: "OFFICIAL",
          academicLevel: level,
        };
        // Lookup by code is LEVEL-SCOPED through the K3 compound unique
        // `academicLevel_officialCode`: the same code at ANOTHER level is a
        // different, legitimate row (FIRST "1-1" ≠ SECOND "1-1") and is
        // never adopted, never touched. No global officialCode lookup remains.
        const existing = await client.lesson.findUnique({
          where: { academicLevel_officialCode: { academicLevel: level, officialCode: lessonModel.code } },
        });
        if (existing) {
          if (!sameRecord(existing, data)) {
            await client.lesson.update({ where: { id: existing.id }, data });
            lessonsUpdated++;
          }
        } else {
          // A brand-new official session starts DRAFT and invisible: content
          // is published by an admin decision (readiness + ceremony), never as
          // a side effect of a structural sync. This is the R2 mitigation in
          // the roadmap ("default-DRAFT for new lessons") — without it the
          // first admin click that runs a reconcile would publish a syllabus.
          await client.lesson.create({
            data: {
              ...data,
              officialCode: lessonModel.code,
              topicId: null,
              ...LESSON_NEW_LIFECYCLE,
            },
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
    where: { academicLevel: level, officialCode: { in: officialCodes } },
    select: {
      id: true,
      officialCode: true,
      unitId: true,
      curriculumStatus: true,
      // Phase 13: read for reporting only. The reconciler NEVER writes
      // lifecycle state, and nothing here derives access from it.
      status: true,
    },
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
  // Scoped to THIS course's chain (Phase K2): another level's official
  // lessons are not strays of this run.
  const strayOfficial = await client.lesson.findMany({
    where: {
      academicLevel: level,
      officialCode: { not: null },
      curriculumStatus: "OFFICIAL",
      NOT: { officialCode: { in: officialCodes } },
      OR: [
        { unit: { part: { courseId: course.id } } },
        { topic: { unit: { part: { courseId: course.id } } } },
      ],
    },
    select: { officialCode: true },
  });
  for (const s of strayOfficial) {
    warnings.push(
      `Lesson with unknown officialCode left untouched: ${s.officialCode}`
    );
  }

  const lessonsPublished = officialRows.filter(
    (r: { status?: unknown }) => String(r.status).toUpperCase() === "PUBLISHED"
  ).length;

  return {
    courseId: course.id,
    courseSlug: spec.courseSlug,
    academicLevel: level,
    courseCreated: !existingCourse,
    modelVersion: model.schemaVersion,
    partsReconciled: model.parts.length,
    partsCreated,
    unitsReconciled: model.parts.reduce((n, p) => n + p.units.length, 0),
    unitsCreated,
    lessonsCreated,
    lessonsCreatedAsDraft: lessonsCreated,
    lessonsPublished,
    lessonsAwaitingOpen: officialRows.length - lessonsPublished,
    lessonsUpdated,
    officialLessonCodes: officialCodes,
    archivedLessonIds,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Phase L — multi-level entry point + summary.
//
// There is still exactly ONE reconciler (above). This helper only fans it out
// over the registry, one fully-scoped run per level, so that "reconcile the
// official curriculum" stays a single, deterministic, reproducible operation
// now that two official curricula exist. No cross-level write is possible:
// every run is pinned to its own spec's slug AND its own level, and the engine
// refuses to write when a course's stored level disagrees with the spec.
//
// The summary keeps the flat fields the existing callers already read
// (`officialLessonCodes`, `archivedLessonIds`) so no caller silently degrades,
// while `levels` carries the per-level detail.
// ---------------------------------------------------------------------------
export interface ReconcileSummary {
  /** Per-level reports, in registry (spec) order. */
  levels: ReconcileReport[];
  courseSlugs: string[];
  /** Every official code reconciled across the levels, level by level. */
  officialLessonCodes: string[];
  /** Every archived legacy lesson id, across the levels. */
  archivedLessonIds: string[];
  warnings: string[];
}

export function summarizeReconcileReports(reports: ReconcileReport[]): ReconcileSummary {
  return {
    levels: reports,
    courseSlugs: reports.map((r) => r.courseSlug),
    officialLessonCodes: reports.flatMap((r) => r.officialLessonCodes),
    archivedLessonIds: reports.flatMap((r) => r.archivedLessonIds),
    warnings: reports.flatMap((r) =>
      r.warnings.map((w) => `${r.academicLevel}/${r.courseSlug}: ${w}`)
    ),
  };
}

export async function reconcileAllOfficialCurricula(
  client: ReconcileClient = db,
  specs: readonly LevelCurriculumSpec[] = LEVEL_CURRICULUM_SPECS
): Promise<ReconcileSummary> {
  const reports: ReconcileReport[] = [];
  for (const spec of specs) {
    reports.push(await reconcileOfficialCurriculum(client, spec));
  }
  return summarizeReconcileReports(reports);
}
