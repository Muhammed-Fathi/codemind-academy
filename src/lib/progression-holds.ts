// CodeMind Academy — Phase H: the AbsenceHold BRIDGE (never a second absence
// lifecycle).
//
// THE BOUNDARY THIS FILE RESPECTS
// ===============================
// Phase F owns the absence domain end to end: `Attendance.status` is the fact,
// `AbsenceReview` is the administrative case, `AbsenceHold` is the authoritative
// OUTPUT. Phase F decides when a hold is created and resolved, and it never
// enforces it (`AbsenceHold` doc comment: "that is Phase H's job").
//
// This module therefore does exactly two things:
//
//   1. READ the holds Phase F produced and translate them into a PROGRESSION
//      BOUNDARY (which lesson does the hold stop at? does it block *now*?).
//   2. Decide, from ACADEMIC FACTS ONLY, whether the student has satisfied the
//      catch-up requirements of the affected lesson.
//
// It never writes a hold, never reinterprets an absence status and never
// resolves a case: resolution goes through `progression-catchup.ts`, which
// calls the Phase F authority (`src/lib/absence-review.ts`). It imports
// nothing from that module on purpose, so the read path stays free of the
// notification/mailer graph and stays testable offline.
//
// THE RULE (approved decision #8)
// ===============================
//   * an ACTIVE hold blocks progression to the NEXT Lesson only;
//   * it NEVER blocks the affected/current Lesson, its recording, its quiz,
//     its homework, or any historical completed Lesson — the system must never
//     block the exact content required to resolve the hold;
//   * EXCUSED absences produce a RESOLVED hold (Phase F) → never a block;
//   * once the affected lesson's ACADEMIC requirements are satisfied, the hold
//     stops blocking, so a student can never be trapped (decision #7). The
//     administrative resolution is recorded separately and idempotently.

import { db } from "@/lib/db";
import {
  catchUpRequirements,
  isCatchUpSatisfied,
  orderUnmet,
  type RequirementFacts,
  type UnmetCode,
} from "@/lib/progression-requirements";

type Client = typeof db;

export const HOLD_ACTIVE = "ACTIVE";
export const HOLD_RESOLVED = "RESOLVED";

/** The hold row shape the progression engine consumes. */
export type AbsenceHoldRecord = {
  id: string;
  studentId: string;
  sessionId: string;
  /** `ACTIVE` | `RESOLVED` — the Phase F vocabulary, never reinterpreted. */
  status: string;
  reason: string | null;
  createdAt: Date | null;
  resolvedAt: Date | null;
  /** The administrative decision behind the hold (EXCUSED / UNEXCUSED / …). */
  reviewStatus: string | null;
  /** The academic lesson the missed session mapped to, if it could be mapped. */
  lessonId: string | null;
};

/** Phase F's own predicate — mirrored, never reinvented. */
export function isHoldActive(status: unknown): boolean {
  return String(status ?? "").trim().toUpperCase() === HOLD_ACTIVE;
}

/**
 * Does this hold block FORWARD progression right now?
 *
 * A RESOLVED hold never blocks (an EXCUSED absence is administratively closed).
 * An ACTIVE hold blocks only while the affected lesson's catch-up requirements
 * are outstanding — "a student under an absence hold must never be trapped".
 */
export function holdBlocksProgression(input: {
  status: unknown;
  catchUpSatisfied: boolean | null;
}): boolean {
  if (!isHoldActive(input.status)) return false;
  // `null` = the affected lesson could not be mapped to this course's
  // universe, so there is nothing to catch up here and nothing to block.
  if (input.catchUpSatisfied === null) return false;
  return !input.catchUpSatisfied;
}

/** The catch-up requirements that ACTUALLY exist for the affected lesson. */
export function catchUpFor(facts: RequirementFacts): {
  satisfied: boolean;
  unmet: UnmetCode[];
} {
  return {
    satisfied: isCatchUpSatisfied(facts),
    unmet: orderUnmet(catchUpRequirements(facts)),
  };
}

/**
 * Load every hold of a student (Phase F rows only — this never writes them).
 *
 * The affected LESSON is resolved Phase-F-first (`AbsenceReview.lessonId`, the
 * denormalized curriculum reference the case was opened with) and falls back
 * to the missed `LiveSession.lessonId`. Either can legitimately be null (a
 * session with no lesson link, or a legacy case): the hold then has no
 * progression boundary in any course, which `holdBlocksProgression` treats as
 * "does not block" rather than as "blocks everything".
 */
/**
 * The delegate of an ADDITIVE Phase F/H table, or null when the client does
 * not carry it.
 *
 * `AbsenceHold` (Phase F), `ProgressionOverride`, `SessionVideo` and
 * `SessionVideoView` (Phase A/H) are additive tables. When one is unreachable
 * — a partially migrated database, or an offline test double written before it
 * existed — the honest progression answer is "no hold / no override / no
 * modern recording", i.e. the exact pre-Phase-H behaviour. A MISSING delegate
 * therefore degrades; a delegate that exists and throws is a real database
 * error and still propagates (this helper never swallows one).
 */
export function additiveDelegate(client: unknown, name: string): any | null {
  const delegate = (client as any)?.[name];
  return delegate && typeof delegate.findMany === "function" ? delegate : null;
}

export async function loadStudentHolds(
  studentId: string,
  client: Client = db
): Promise<AbsenceHoldRecord[]> {
  const holds = additiveDelegate(client, "absenceHold");
  if (!holds) return [];
  const rows = await holds.findMany({
    where: { studentId },
    select: {
      id: true,
      studentId: true,
      sessionId: true,
      status: true,
      reason: true,
      createdAt: true,
      resolvedAt: true,
      absenceReview: { select: { status: true, lessonId: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const missing = rows
    .filter((r: any) => !r.absenceReview?.lessonId)
    .map((r: any) => r.sessionId);

  const sessionLesson = new Map<string, string | null>();
  const sessionsDelegate = additiveDelegate(client, "liveSession");
  if (missing.length && sessionsDelegate) {
    const sessions = await sessionsDelegate.findMany({
      where: { id: { in: [...new Set(missing)] } },
      select: { id: true, lessonId: true },
    });
    for (const s of sessions) sessionLesson.set(s.id, s.lessonId ?? null);
  }

  return rows.map((r: any) => ({
    id: r.id,
    studentId: r.studentId,
    sessionId: r.sessionId,
    status: String(r.status ?? ""),
    reason: r.reason ?? null,
    createdAt: r.createdAt ?? null,
    resolvedAt: r.resolvedAt ?? null,
    reviewStatus: r.absenceReview?.status ?? null,
    lessonId: r.absenceReview?.lessonId ?? sessionLesson.get(r.sessionId) ?? null,
  }));
}

/**
 * A hold translated into a progression boundary inside ONE ordered universe.
 *
 * `boundaryIndex` is the index of the affected lesson in the course sequence:
 * everything AFTER it is forward progression and therefore blocked; the
 * affected lesson itself and everything before it stays reachable (decision
 * #8). `null` means the affected lesson is not part of this universe (another
 * course, another track, or historically archived) — the hold then has no
 * effect here rather than a blanket one.
 */
export type HoldBoundary = {
  holdId: string;
  status: string;
  active: boolean;
  sessionId: string;
  lessonId: string | null;
  reviewStatus: string | null;
  reason: string | null;
  createdAt: Date | null;
  boundaryIndex: number | null;
  blocks: boolean;
  catchUp: { satisfied: boolean; unmet: UnmetCode[] } | null;
};

/**
 * Place every hold of the student inside `universe` (the ordered lesson ids of
 * ONE course) and decide which of them block forward progression.
 *
 * `factsByLesson` supplies the academic facts of the affected lesson so the
 * catch-up verdict comes from the same matrix as ordinary progression — the
 * requirements are whatever actually exists, never an invented list.
 */
export function buildHoldBoundaries(input: {
  holds: readonly AbsenceHoldRecord[];
  universe: readonly string[];
  factsByLesson?: ReadonlyMap<string, RequirementFacts>;
}): HoldBoundary[] {
  const index = new Map(input.universe.map((id, i) => [id, i]));
  return input.holds.map((hold) => {
    const boundaryIndex =
      hold.lessonId && index.has(hold.lessonId) ? index.get(hold.lessonId)! : null;
    const facts =
      hold.lessonId && boundaryIndex !== null
        ? input.factsByLesson?.get(hold.lessonId) ?? null
        : null;
    const catchUp = facts ? catchUpFor(facts) : null;
    return {
      holdId: hold.id,
      status: hold.status,
      active: isHoldActive(hold.status),
      sessionId: hold.sessionId,
      lessonId: hold.lessonId,
      reviewStatus: hold.reviewStatus,
      reason: hold.reason,
      createdAt: hold.createdAt,
      boundaryIndex,
      blocks: holdBlocksProgression({
        status: hold.status,
        catchUpSatisfied: catchUp ? catchUp.satisfied : null,
      }),
      catchUp,
    };
  });
}

/** The single boundary that blocks the furthest-ahead lesson wins. */
export function blockingBoundary(
  boundaries: readonly HoldBoundary[]
): HoldBoundary | null {
  const blocking = boundaries.filter((b) => b.blocks && b.boundaryIndex !== null);
  if (!blocking.length) return null;
  return blocking.reduce((a, b) => ((b.boundaryIndex ?? -1) > (a.boundaryIndex ?? -1) ? b : a));
}

/** Holds worth showing to a human (an ACTIVE one, or the newest known one). */
export function visibleHold(
  boundaries: readonly HoldBoundary[]
): HoldBoundary | null {
  const active = boundaries.find((b) => b.active) ?? null;
  if (active) return active;
  return boundaries.length ? boundaries[boundaries.length - 1] : null;
}
