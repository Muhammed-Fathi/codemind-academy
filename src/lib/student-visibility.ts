/** Canonical Student visibility rules for Phase G content readers. */
export const STUDENT_LESSON_PUBLISHED_FILTER = { status: { not: "DRAFT" } } as const;

/**
 * The only Homework lifecycle states a Student — or a Parent reading on a
 * linked child's behalf — may see.
 *
 * `Homework.status` is a TEXT column (Phase G, deliberately NOT an enum:
 * DRAFT → PUBLISHED → CLOSED), so Prisma generates a `StringFilter` for it and
 * `StringFilter.in` is a MUTABLE `string[]`.
 *
 *   * PUBLISHED — live assignment; submissions accepted.
 *   * CLOSED    — historically visible (the list and grades stay readable).
 *   * DRAFT     — deliberately absent: authoring-only, never a student fact
 *                 and therefore never a progression requirement.
 */
export type StudentVisibleHomeworkStatus = "PUBLISHED" | "CLOSED";

/**
 * Spread into any `db.homework` `where` to keep DRAFT assignments out of a
 * student-visible list. ONE definition, shared by the student homework list,
 * the parent dashboard, the parent academic reader and the analytics/weekly
 * universes — a second copy of this predicate is how DRAFT content leaks.
 *
 * WHY THIS IS NOT `as const` (it is the bug this shape fixes):
 * `as const` turns the array into the READONLY tuple
 *   readonly ["PUBLISHED", "CLOSED"]
 * and a readonly tuple is NOT assignable to the mutable `string[]` that
 * Prisma's generated `StringFilter.in` declares. Every call site spreading this
 * constant into a `where` clause therefore failed with TS2322 — the parent
 * dashboard route, the parent academic reader and the shared parent-access
 * helper. It never showed up in a sandbox whose generated client is a stub
 * (the types collapse), only against a REAL `prisma generate`.
 *
 * So: the ELEMENT type stays a narrow union (a typo still cannot compile), and
 * only the ARRAY itself is mutable. The runtime value is byte-for-byte the
 * same object it has always been.
 */
export const STUDENT_HOMEWORK_LIST_FILTER: {
  status: { in: StudentVisibleHomeworkStatus[] };
} = { status: { in: ["PUBLISHED", "CLOSED"] } };

export function filterStudentLessonRows<T extends { status: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.status !== "DRAFT");
}
export function filterStudentHomeworkRows<T extends { status: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.status === "PUBLISHED" || row.status === "CLOSED");
}
