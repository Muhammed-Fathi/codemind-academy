// CodeMind Academy — Phase 21: quiz-evidence retention policy.
//
// Camera evidence (QuizAttemptEvidence) is biometric personal data with a
// per-row retention deadline (`retainUntil`, stamped at capture as now +
// QUIZ_EVIDENCE_RETENTION_DAYS). This module owns the SELECTION RULE — which
// rows a cleanup job may delete — shared by the purge script
// (scripts/media/purge-expired-evidence.mjs) and the offline suite, so the
// rule is defined ONCE and tested in both places.
//
// THE RULE
//   A QuizAttemptEvidence row is purgeable iff:
//     retainUntil IS NOT NULL AND retainUntil <= now
//   * NULL retainUntil = retained indefinitely (STATUS rows and legacy rows
//     without a stamp are NEVER purged — fail-closed against data loss).
//   * "Expired" is evaluated at purge time against the database clock value
//     passed in, never against a client-supplied timestamp.
//   * Referenced METADATA is preserved: the purge deletes the evidence row and
//     (only when unreferenced elsewhere) its private file bytes — the parent
//     QuizAttempt, the Student, and every audit row are untouched.
//   * SECURITY SEPARATION: SecurityEvent, AuditLog, TeacherApplication,
//     TeacherActivationToken, UserSession, PasswordResetToken and
//     SecurityRateLimit are NEVER inputs to this module. Evidence retention
//     and security/audit retention are logically separate systems; the purge
//     script additionally asserts protected-table counts are unchanged.
//     (Security/audit retention policy itself is a Phase 22 decision — this
//     phase only guarantees evidence cleanup cannot touch it.)

export const QUIZ_EVIDENCE_DEFAULT_RETENTION_DAYS = 30;

/** Tables the evidence purge must never read-for-delete (asserted by tests). */
export const EVIDENCE_PURGE_PROTECTED_TABLES = [
  "SecurityEvent",
  "AuditLog",
  "TeacherApplication",
  "TeacherActivationToken",
  "UserSession",
  "PasswordResetToken",
  "SecurityRateLimit",
  "QuizAttempt",
  "Student",
  "User",
] as const;

export type EvidenceRow = {
  id: string;
  attemptId: string;
  mediaAssetId: string | null;
  kind: string;
  retainUntil: Date | string | number | null | undefined;
};

export function resolveRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.QUIZ_EVIDENCE_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return QUIZ_EVIDENCE_DEFAULT_RETENTION_DAYS;
  }
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 3650) {
    throw new Error(
      `QUIZ_EVIDENCE_RETENTION_DAYS must be an integer 1..3650 (got ${JSON.stringify(String(raw).slice(0, 16))})`
    );
  }
  return n;
}

/** Stamp a capture-time deadline (used by the evidence route + tests). */
export function retentionDeadlineFrom(now: Date, days?: number): Date {
  const d = days ?? QUIZ_EVIDENCE_DEFAULT_RETENTION_DAYS;
  return new Date(now.getTime() + d * 24 * 3600 * 1000);
}

/** True iff the row's deadline has passed. NULL/undefined deadline = keep. */
export function isEvidenceExpired(
  row: Pick<EvidenceRow, "retainUntil">,
  now: Date = new Date()
): boolean {
  const r = row.retainUntil;
  if (r === null || r === undefined) return false;
  const deadline = r instanceof Date ? r : new Date(typeof r === "number" ? r : String(r));
  if (Number.isNaN(deadline.getTime())) return false; // unparseable = keep (fail-closed)
  return deadline.getTime() <= now.getTime();
}

/** Partition rows into { expired, retained } — the purge set + its complement. */
export function selectExpiredEvidence<T extends Pick<EvidenceRow, "retainUntil">>(
  rows: T[],
  now: Date = new Date()
): { expired: T[]; retained: T[] } {
  const expired: T[] = [];
  const retained: T[] = [];
  for (const row of rows) {
    (isEvidenceExpired(row, now) ? expired : retained).push(row);
  }
  return { expired, retained };
}
