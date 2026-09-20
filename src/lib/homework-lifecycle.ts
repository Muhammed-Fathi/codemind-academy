// CodeMind Academy — Phase G: Homework lifecycle authority.
//
// THE ONE PLACE that answers which lifecycle state an assignment is in and
// which transitions are legal. Transitions are SERVER-authoritative (the
// publish/close routes are the only writers) and audited.
//
//   DRAFT     — teacher edits freely; the assignment does not exist for
//               students (list, progression and the submit gate all skip it).
//   PUBLISHED — visible to eligible students; submissions accepted and
//               classified ON_TIME/LATE against the deadline.
//   CLOSED    — historically visible; no NEW submission; submissions and
//               grades stay readable.
//
// Stored as TEXT on `Homework.status` (the Phase 26D convention — no new
// enum). The DEFAULT on the column is PUBLISHED so every pre-Phase-G row
// keeps its exact behaviour; teacher creation writes DRAFT explicitly.

/** Homework lifecycle states. */
export const HOMEWORK_STATUSES = ["DRAFT", "PUBLISHED", "CLOSED"] as const;
export type HomeworkLifecycleStatus = (typeof HOMEWORK_STATUSES)[number];

export function isHomeworkLifecycleStatus(
  value: unknown
): value is HomeworkLifecycleStatus {
  return (
    typeof value === "string" &&
    (HOMEWORK_STATUSES as readonly string[]).includes(value)
  );
}

/** Legal lifecycle transitions (the routes enforce + audit them). */
export function canTransitionHomework(
  from: string,
  to: HomeworkLifecycleStatus
): boolean {
  switch (to) {
    case "PUBLISHED":
      // Fresh publish AND re-open after close.
      return from === "DRAFT" || from === "CLOSED";
    case "CLOSED":
      return from === "PUBLISHED";
    case "DRAFT":
      // No unpublish: once students may have seen/attempted the assignment,
      // it stays historically visible. Deleting a submission-free assignment
      // (existing DELETE route) is the only way back.
      return false;
  }
}

/** The shared attachment payload used by teacher and student surfaces. */
export function homeworkAttachmentPayload(asset: {
  id: string;
  mimeType: string | null;
  sizeBytes: number | null;
  originalName: string | null;
} | null) {
  if (!asset) return null;
  return {
    id: asset.id,
    name: asset.originalName || "file",
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    downloadUrl: `/api/media/${asset.id}`,
  };
}
