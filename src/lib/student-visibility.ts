/** Canonical Student visibility rules for Phase G content readers. */
export const STUDENT_LESSON_PUBLISHED_FILTER = { status: { not: "DRAFT" } } as const;
export const STUDENT_HOMEWORK_LIST_FILTER = { status: { in: ["PUBLISHED", "CLOSED"] } } as const;

export function filterStudentLessonRows<T extends { status: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.status !== "DRAFT");
}
export function filterStudentHomeworkRows<T extends { status: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.status === "PUBLISHED" || row.status === "CLOSED");
}
