// CodeMind Academy — compile-time regression: Phase H db contracts accept
// generic Prisma-style delegates.
//
// WHY THIS FILE EXISTS
//   The generated Prisma delegates are generic and parameter-constrained
//   (`findMany<T extends LiveSessionFindManyArgs>(...)`). The first Phase H
//   contracts typed every delegate as `(args: unknown) => ...`, which looks
//   permissive but is BACKWARDS under contravariance: a method that accepts
//   only Prisma args is NOT assignable to a slot demanding arbitrary
//   `unknown` — so the real PrismaClient was rejected at all 6 call sites (a
//   local typecheck failure the `any`-stubbed sandbox could not see).
//
//   This file replays that variance check offline: `SimulatedDb<...>`
//   rebuilds each contract with GENERIC methods (the callee chooses the type
//   argument, exactly like Prisma), and the helper calls below must still
//   compile. If a contract regresses to `(args: unknown)`, `unknown` fails
//   the `Record<string, unknown>` constraint and typecheck fails — the same
//   shape as the 6 local errors. The JS suites are untypechecked, so this is
//   the gate that protects the production signatures.
//
//   `npm run typecheck` runs this file (it is inside tsconfig `include`); it
//   is never imported, bundled, or executed.

import {
  loadVideoApplicability,
  loadVideoApplicabilityMany,
  type ApplicabilityDb,
} from "@/lib/video-applicability";
import { loadLessonReadiness, type LessonReadinessDb } from "@/lib/lesson-readiness";
import { createTeacherNoteWithFanout, type TeacherNoteDb } from "@/lib/teacher-notes";

/**
 * Each contract member rebuilt as a generic delegate: the `T extends
 * Record<string, unknown>` constraint plays the role of Prisma's
 * `T extends LiveSessionFindManyArgs` (every real args object is a string-
 * keyed record). Return payloads are inherited from the contract itself, so
 * this asserts ONLY the variance direction — never the row shapes.
 */
type SimulatedDb<Db> = {
  [K in keyof Db]: Db[K] extends { findMany: (...args: never[]) => Promise<infer R> }
    ? { findMany: <T extends Record<string, unknown>>(args: T) => Promise<R> }
    : Db[K] extends { findUnique: (...args: never[]) => Promise<infer R> }
      ? { findUnique: <T extends Record<string, unknown>>(args: T) => Promise<R> }
      : Db[K] extends { create: (...args: never[]) => Promise<infer R> }
        ? { create: <T extends Record<string, unknown>>(args: T) => Promise<R> }
        : never;
};

declare const simulatedApplicability: SimulatedDb<ApplicabilityDb>;
declare const simulatedReadiness: SimulatedDb<LessonReadinessDb>;
declare const simulatedNotes: SimulatedDb<TeacherNoteDb>;

/** Never invoked — its body is the assertion. Exported so no lint rule flags it. */
export async function __phaseHDelegateCompat(): Promise<void> {
  await loadVideoApplicability(simulatedApplicability, "student-id", []);
  await loadVideoApplicabilityMany(simulatedApplicability, ["student-id"], []);
  await loadLessonReadiness(simulatedReadiness, [], "lesson-id");
  await createTeacherNoteWithFanout(simulatedNotes, {
    teacherId: "teacher-id",
    actorUserId: "user-id",
    studentId: "student-id",
    note: "note",
    teacherName: "teacher",
    studentName: "student",
    tApi: (key: string) => key,
  });
}
