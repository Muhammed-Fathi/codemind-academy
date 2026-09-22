// CodeMind Academy — Teacher Readiness reminder recipients.
//
// The teacher's `تذكير` action on a not-ready student sends to a CONTROLLED
// audience — STUDENT, PARENT, or BOTH — chosen from three fixed options in
// the UI and re-validated here on the server. The request carries ONLY the
// mode: every recipient id is server-derived (the student's own user row for
// the student leg, the existing teacher→parent fan-out for the parent leg),
// so there is no client-supplied user list to smuggle an arbitrary
// destination through, and no generic teacher-messaging API.
//
// The two legs deliberately use the two EXISTING subsystems, unchanged:
//   * PARENT — `createTeacherNoteWithFanout` (teacher note + ANNOUNCEMENT to
//     the linked parents, preferences + quiet hours honoured, link NULL).
//     The note text below is shared so the parent template can never drift.
//   * STUDENT — the ONE idempotent insert primitive (`insertNotificationOnce`)
//     with a per-student per-lesson per-day dedupe key, NON-mandatory (the
//     student's preferences + quiet hours still apply — a teacher cannot
//     override them) and a server-minted `lesson:` deep link.
//
// Day-scoped dedupe is intentional (the ABSENCE_REMINDER precedent): a second
// remind for the same student + lesson on the same day reports DUPLICATE
// instead of writing a second row. Partial progress within the day does not
// re-arm the reminder — spam protection wins over re-notification.

import { insertNotificationOnce } from "@/lib/live-session-notifications";
import { mintNotificationLink } from "@/lib/notification-links";
import type { ReadinessStudentRow } from "@/lib/lesson-readiness";

/** The three controlled audience modes. Nothing else is addressable. */
export type ReminderAudience = "STUDENT" | "PARENT" | "BOTH";

export const REMINDER_AUDIENCES: readonly ReminderAudience[] = [
  "STUDENT",
  "PARENT",
  "BOTH",
];

/**
 * Resolve the raw `audience` request field to a mode.
 *
 * Absent (or an empty string, which legacy callers may send) means the
 * historical parent-only reminder. Anything present-but-unknown is NOT
 * coerced — the caller refuses it (400), fail-closed like the deep-link
 * parser: an audience the server did not mint is never guessed.
 */
export function resolveReminderAudience(raw: unknown): ReminderAudience | null {
  if (raw === undefined || raw === null || raw === "") return "PARENT";
  if (raw === "STUDENT" || raw === "PARENT" || raw === "BOTH") return raw;
  return null;
}

/**
 * The shared "exactly what is pending" bits, rendered from the LIVE
 * canonical readiness row. ONE builder feeds both the parent note and the
 * student message, so the two legs can never disagree about what is missing.
 * Templates are byte-identical to the historical parent note (pinned).
 */
export function buildReadinessPendingBits(row: ReadinessStudentRow): string[] {
  const pendingBits: string[] = [];
  if (row.video.required && !row.video.done) {
    const pendingVideos = row.video.items.filter((v) => !v.completed);
    if (pendingVideos.length > 0) {
      const first = pendingVideos[0];
      pendingBits.push(
        pendingVideos.length === 1
          ? `الفيديو: ${first.currentPercent}% من ${first.requiredPercent}%`
          : `الفيديو: ${pendingVideos.length} فيديوهات غير مكتملة`
      );
    } else {
      pendingBits.push("الفيديو: غير مكتمل");
    }
  }
  if (row.quiz.required && !row.quiz.done) {
    pendingBits.push(
      row.quiz.pending.length > 0
        ? `الاختبار: ${row.quiz.pending.map((q) => q.titleAr || q.title).join("، ")}`
        : "الاختبار: لم يُجتز"
    );
  }
  if (row.homework.required && !row.homework.done) {
    pendingBits.push(
      row.homework.pending.length > 0
        ? `الواجب: ${row.homework.pending.map((h) => h.titleAr || h.title).join("، ")}`
        : "الواجب: لم يُسلَّم"
    );
  }
  return pendingBits;
}

/**
 * The templated reminder text: the lesson + exactly what is pending, so the
 * reader sees an actionable list, not a bare nudge. Fixed structure (pinned
 * by the suite); content, not UI copy — Arabic like manual notes.
 */
export function buildReminderText(lessonTitle: string, pendingBits: readonly string[]): string {
  return (
    `تذكير بمتطلبات درس «${lessonTitle}»: ` +
    (pendingBits.length > 0 ? pendingBits.join("؛ ") + "." : "غير جاهز.")
  );
}

/** Every way the student leg can end — reported per-audience, never silent. */
export type StudentReminderStatus =
  | "sent"
  | "duplicate"
  | "skipped_quiet_hours"
  | "skipped_preference"
  | "unavailable";

export type StudentReminderResult = {
  status: StudentReminderStatus;
  /** 1 exactly when a notification row was written. */
  notified: 0 | 1;
};

/** The minimal student-user shape the leg needs (server-loaded, scoped). */
export type ReminderStudentUser = {
  id: string;
  isActive: boolean;
  status: string;
} | null;

/**
 * Send the STUDENT leg: one READINESS_REMINDER notification to the student's
 * own user row, idempotent per student per lesson per day.
 *
 * Guards (all server-side): the user row must resolve AND be active — an
 * inactive/unresolvable student reports `unavailable` (no write, no leak,
 * no throw). Delivery itself goes through the shared idempotent primitive,
 * non-mandatory, so quiet hours + preferences behave exactly as they do for
 * every other system reminder.
 */
export async function sendReadinessReminderToStudent(input: {
  /** The Student PROFILE id (scope-derived; the dedupe namespace). */
  studentId: string;
  studentUser: ReminderStudentUser;
  lessonId: string;
  lessonTitle: string;
  pendingBits: readonly string[];
  now?: Date;
}): Promise<StudentReminderResult> {
  const user = input.studentUser;
  if (!user || !user.id || user.isActive !== true || user.status !== "ACTIVE") {
    return { status: "unavailable", notified: 0 };
  }

  const now = input.now ?? new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const dedupeKey = `READINESS_REMINDER:${input.studentId}:${input.lessonId}:${dayKey}`;
  const title = `تذكير بمتطلبات درس «${input.lessonTitle}»`.slice(0, 200);
  const message = buildReminderText(input.lessonTitle, input.pendingBits).slice(0, 2000);
  // Server-minted AND validated: a bogus lesson id yields NULL (no link),
  // never a malformed pointer — and never blocks the send.
  const link = mintNotificationLink("lesson", input.lessonId);

  const result = await insertNotificationOnce(
    {
      userId: user.id,
      type: "READINESS_REMINDER",
      title,
      message,
      link,
      dedupeKey,
    },
    { now }
  );

  if (result === "INSERTED") return { status: "sent", notified: 1 };
  if (result === "DUPLICATE") return { status: "duplicate", notified: 0 };
  if (result === "QUIET_HOURS") return { status: "skipped_quiet_hours", notified: 0 };
  return { status: "skipped_preference", notified: 0 };
}
