// CodeMind Academy — grouping the teacher's session list by COURSE (Phase L
// final manual-QA polish).
//
// THE BUG THIS MODULE EXISTS TO PREVENT
// =====================================
// Phase L put TWO official curricula live at the same time:
//
//     FIRST_SECONDARY   → Course "البرمجة والذكاء الاصطناعي"
//     SECOND_SECONDARY  → Course "البرمجة والذكاء الاصطناعي"
//
// Both courses carry the SAME display name (and their lessons reuse the same
// printed `officialCode`s). A course NAME is therefore NOT an identity: it is
// presentation text that may repeat. The teacher's session list grouped its
// rows per course and keyed the rendered sections by `course.name`, so the two
// courses produced two identical React keys and the runtime reported:
//
//     Encountered two children with the same key, `البرمجة والذكاء الاصطناعي`.
//
// React is not being pedantic here — duplicate keys make reconciliation
// undefined behaviour, so the list may drop, duplicate or re-order a whole
// course section (with every session inside it).
//
// THE RULE
// ========
//   * The identity of a course group is `Course.id` — a canonical database id.
//   * The display name is carried alongside it (the UI still needs to print a
//     name) and is NEVER used as a key, an index, a comparison or a lookup.
//   * Two courses that share a name stay TWO groups; the same course never
//     splits into two groups.
//
// The function below is pure and framework-free on purpose: the regression
// test can execute it against two same-named courses, and the component can
// only render what this returns — so "grouping falls back to the name" is
// impossible to reintroduce without the test failing.

export type SessionCourseRow = {
  course: { id: string; name: string; academicLevel?: string | null };
};

export type SessionCourseGroup<T extends SessionCourseRow> = {
  /** Canonical `Course.id` — the ONLY valid identity for this group. */
  courseId: string;
  /**
   * The course's display name. NOT unique across levels: never a React key,
   * never an index, never a filter value.
   */
  name: string;
  /** `Course.academicLevel` (canonical enum) or null for legacy rows. */
  academicLevel: string | null;
  /** The rows belonging to this course, in the order they arrived. */
  rows: T[];
};

/**
 * The React key (and any other identity use) for a course group.
 *
 * Exported as a function rather than open-coded `key={group.name}` so there is
 * exactly ONE definition of "the identity of a course group", and so a test can
 * assert uniqueness through the same function the component renders with.
 */
export function courseGroupKey(group: Pick<SessionCourseGroup<never>, "courseId">): string {
  return group.courseId;
}

/**
 * Group session (or lesson) rows by their course.
 *
 * Deterministic: groups appear in first-appearance order, which preserves the
 * API's own ordering (courseId → part → unit → lesson) instead of imposing a
 * client-side sort.
 */
export function groupSessionsByCourse<T extends SessionCourseRow>(
  rows: readonly T[]
): Array<SessionCourseGroup<T>> {
  const byCourseId = new Map<string, SessionCourseGroup<T>>();
  for (const row of rows) {
    const courseId = row.course?.id;
    // Defensive: a row without a canonical course id cannot be grouped by an
    // identity it does not have, and inventing one from the name is exactly
    // the bug above. Such a row is skipped rather than mis-keyed.
    if (!courseId) continue;
    let group = byCourseId.get(courseId);
    if (!group) {
      group = {
        courseId,
        name: row.course.name ?? "",
        academicLevel: row.course.academicLevel ?? null,
        rows: [],
      };
      byCourseId.set(courseId, group);
    }
    group.rows.push(row);
  }
  return Array.from(byCourseId.values());
}
