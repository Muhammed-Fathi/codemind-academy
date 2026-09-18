// CodeMind Academy — Course-tree Unit summary counts (Phase C representation
// fix). PURE presentation-shape helper: it counts what a Unit payload ALREADY
// contains — it never queries the database, never filters by viewer, and has
// no opinion about progression, readiness, publication or content states
// (those live in session-progress / session-lifecycle / lesson-content).
//
// Why it exists: the old Unit summary in the student course tree rendered
//
//   `{unit.topics.length} Topics · {unitLessons(unit).length} Lessons`
//
// UNCONDITIONALLY and in hardcoded English. A purely CANONICAL unit (the
// official Course → Part → Unit → Lesson chain) therefore advertised a
// meaningless "0 Topics" beside its visibly rendered Lesson 1-1 — a summary
// that contradicts the rows under it. Official canonical Lessons must never
// be presented as if they were legacy Topics.
//
// Contract (mirrors exactly what the tree renders):
//   * canonical     — `unit.lessons` rows (the course payload already applied
//                     the viewer's lifecycle / archive / track filters; a
//                     legacy lesson that is ALSO unit-linked is listed here,
//                     never under a topic — no double counting).
//   * legacyTopics  — legacy Topic containers that still own ≥ 1 VISIBLE
//                     lesson row. The API already drops row-less topics; this
//                     helper re-enforces it so a container count can never
//                     reach the UI without the rows to back it.
//   * legacyLessons — the rows actually rendered under those Topics.
//   * total         — canonical + legacyLessons = the EXACT number of visible
//                     lesson rows in the Unit. Summary and rendered list
//                     therefore cannot contradict each other.
//   * kind          — which summary shape the UI renders:
//                       "empty"     → render no summary at all (zero segments
//                                     never render — the defect's core),
//                       "canonical" → Lessons count only (course.240),
//                       "legacy" /
//                       "mixed"     → Topics · Lessons (course.241).
//
// A canonical Lesson is NEVER counted as a Topic, and every number this
// helper reports for a non-empty unit is > 0, so a zero segment can never
// reach the student UI.

export type UnitCountLesson = { id: string };
export type UnitCountTopic = { lessons: UnitCountLesson[] };

export type UnitCountInput = {
  lessons?: UnitCountLesson[] | null;
  topics?: UnitCountTopic[] | null;
};

export type UnitCountKind = "empty" | "canonical" | "legacy" | "mixed";

export type UnitCounts = {
  canonical: number;
  legacyTopics: number;
  legacyLessons: number;
  total: number;
  kind: UnitCountKind;
};

export function countUnitContent(unit: UnitCountInput): UnitCounts {
  const canonical = Array.isArray(unit?.lessons) ? unit.lessons.length : 0;
  const topics = Array.isArray(unit?.topics) ? unit.topics : [];
  const realTopics = topics.filter(
    (t) => Array.isArray(t?.lessons) && t.lessons.length > 0
  );
  const legacyTopics = realTopics.length;
  const legacyLessons = realTopics.reduce(
    (n, t) => n + (Array.isArray(t.lessons) ? t.lessons.length : 0),
    0
  );
  const total = canonical + legacyLessons;
  const kind: UnitCountKind =
    total === 0
      ? "empty"
      : legacyTopics === 0
        ? "canonical"
        : canonical === 0
          ? "legacy"
          : "mixed";
  return { canonical, legacyTopics, legacyLessons, total, kind };
}
