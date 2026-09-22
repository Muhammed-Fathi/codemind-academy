// CodeMind Academy — the localized label for every `NotificationType`
// (Manual-QA fix, Finding 8).
//
// WHY THIS EXISTS
// ===============
// The admin notifications screens rendered the raw enum with
// `type.replace(/_/g, " ")`, so users read "ABSENCE EXCUSED",
// "ABSENCE REASON SUBMITTED" and "ABSENCE FINALIZED" — internal vocabulary,
// never UI copy.
//
// This is the ONE mapping from `NotificationType` to a dictionary key, and it
// covers the WHOLE enum (all 22 values, not just the Phase F nine), so no
// surface can ever fall back to the raw code: an unknown/legacy value maps to
// a generic "notification" label instead of leaking the enum.
//
// It is deliberately PURE (no database import) so both the server emitters and
// the browser admin screens can share it — see `live-session-notifications.ts`,
// which re-exports it.

export const NOTIFICATION_TYPE_LABEL_KEYS: Record<string, string> = {
  NEW_LESSON: "notif.type.newLesson",
  NEW_QUIZ: "notif.type.newQuiz",
  QUIZ_RESULT: "notif.type.quizResult",
  NEW_HOMEWORK: "notif.type.newHomework",
  HOMEWORK_DEADLINE: "notif.type.homeworkDeadline",
  UPCOMING_SESSION: "notif.type.upcomingSession",
  LOW_ATTENDANCE: "notif.type.lowAttendance",
  MONTHLY_REPORT: "notif.type.monthlyReport",
  SUBSCRIPTION_EXPIRATION: "notif.type.subscriptionExpiration",
  ANNOUNCEMENT: "notif.type.announcement",
  PAYMENT_APPROVED: "notif.type.paymentApproved",
  PAYMENT_REJECTED: "notif.type.paymentRejected",
  // Phase F — the live-session lifecycle.
  SESSION_SCHEDULED: "notif.type.sessionScheduled",
  SESSION_LINK: "notif.type.sessionLink",
  SESSION_RESCHEDULED: "notif.type.sessionRescheduled",
  SESSION_CANCELLED: "notif.type.sessionCancelled",
  // Phase F — the absence workflow.
  ABSENCE_FINALIZED: "notif.type.absenceFinalized",
  ABSENCE_REASON_SUBMITTED: "notif.type.absenceReasonSubmitted",
  ABSENCE_EXCUSED: "notif.type.absenceExcused",
  ABSENCE_UNEXCUSED: "notif.type.absenceUnexcused",
  ABSENCE_REMINDER: "notif.type.absenceReminder",
  // Teacher Readiness — the teacher-triggered student nudge.
  READINESS_REMINDER: "notif.type.readinessReminder",
};

/** Never render `type` itself: always a label key, with a safe generic fallback. */
export function notificationTypeLabelKey(type: unknown): string {
  const key = typeof type === "string" ? type : "";
  return NOTIFICATION_TYPE_LABEL_KEYS[key] ?? "notif.type.generic";
}

