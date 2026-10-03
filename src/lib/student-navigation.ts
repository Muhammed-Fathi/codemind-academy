// CodeMind Academy — Phase M4.2 — the ONE student lesson-navigation rule.
//
// THE DEFECT THIS CLOSES (M4 audit finding F4)
// ===========================================
// The student lesson view re-fetches by the store's `lessonId`
// (`src/components/course/student-lesson.tsx`: `const activeLessonId = lessonId;`
//  then a request for `/api/lessons/<activeLessonId>`), while the
// deep-link contract hands a target to its landing view through `navParam`
// (`src/lib/deep-link.ts`). A `lesson:<id>` notification therefore used to
// travel ONLY as `navParam` — and `navParam` moves nothing when the lesson view
// has already been entered once: the view kept re-fetching the store's
// `lessonId`, i.e. the PREVIOUS selection. The same class of bug existed at
// every other entry point that set one key and not the other (the Homework
// list's "open lesson" button set only `view` + `navParam`).
//
// THE RULE (one implementation, used by every student lesson entry point)
// ======================================================================
// Opening a lesson means moving THREE things, in this order:
//
//   1. `setLessonId(id)`  — the view's fetch key (load-bearing);
//   2. `setView("student-lesson")` — `setView` deliberately resets `navParam`,
//      which is exactly why it must run BEFORE the param is written;
//   3. `setNavParam(id)`  — the recorded deep-link target, kept so the existing
//      deep-link contract (`lesson:<id>` ⇒ `navParam = id`) still holds.
//
// The order is the same one `src/lib/deep-link.ts` documents and the Phase 16
// suite pins for `navigateDeepLink`; the difference is that the lesson key is
// moved FIRST here, because the lesson view reads it and NOT `navParam`.
//
// WHAT THIS MODULE IS NOT
// =======================
//   * NOT an authorization. It only decides which (view, lesson id) pair the
//     shell opens; `/api/lessons/[id]` re-authorizes every request (enrollment,
//     course, lifecycle, track, progression, re-derived server-side).
//   * NOT an id factory. The caller always passes the server's canonical
//     `lessonId` (a relation-key), never an `officialCode`, a title, an order
//     number or any other label — the same lesson code exists at more than one
//     Academic Level, so only the id is identity.
//   * NOT a deep-link parser. Parsing/role-mapping stays in `deep-link.ts` +
//     `view-roles.ts`; `studentLessonIdFromNotificationLink` merely composes
//     them, so the notification path cannot drift from the pinned contract.

import { parseDeepLink, resolveDeepLinkForRole } from "@/lib/deep-link";
import { isViewForRole } from "@/lib/view-roles";

/** The student lesson view. Must stay a member of `ViewKey` (src/lib/store.ts). */
export const STUDENT_LESSON_VIEW = "student-lesson";

/**
 * Resource ids are cuids in practice; the pattern additionally allows `-` and
 * `_` (uuid-shaped ids). It is deliberately the SAME alphabet `deep-link.ts`
 * accepts, so an id that can arrive through a notification link can also be
 * opened by hand, and nothing that could escape into a path or a query string
 * is ever written into the store.
 */
const LESSON_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The store surface this rule writes to (injected, so the module stays pure). */
export type StudentLessonNavSurface = {
  setLessonId: (id: string | null) => void;
  setView: (view: never) => void;
  setNavParam: (param: string | null) => void;
};

/** Normalise an incoming lesson id, or `null` when it is not one. */
export function normalizeLessonTargetId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return LESSON_ID_PATTERN.test(raw) ? raw : null;
}

/**
 * Open one canonical lesson on the student lesson view — the shared entry
 * point for the course tree, the dashboard, the Homework list, bookmarks,
 * prev/next and `lesson:<id>` notifications.
 *
 * Returns `true` when navigation happened. A missing / malformed id returns
 * `false` and leaves the shell untouched (fail closed: never open "whatever was
 * selected before" because a link was unreadable).
 */
export function openStudentLesson(
  nav: StudentLessonNavSurface,
  lessonId: unknown
): boolean {
  const id = normalizeLessonTargetId(lessonId);
  if (!id) return false;
  // ORDER IS LOAD-BEARING (see the header): the fetch key first, then the view
  // (which clears navParam), then the recorded target.
  nav.setLessonId(id);
  nav.setView(STUDENT_LESSON_VIEW as never);
  nav.setNavParam(id);
  return true;
}

/**
 * The canonical lesson id behind a notification link, or `null` when the link
 * is not a `lesson:<id>` link the reader's ROLE may open.
 *
 * This is the notification path's half of the shared rule: it reuses the
 * existing strict parser and the existing per-role landing table
 * (`deep-link.ts`) and the existing role gate (`view-roles.ts`) unchanged — it
 * only answers "which lesson id must the shell fetch?". A teacher/parent link
 * (role gating), a malformed link, or a `video:`/`quiz:`/`homework:`/`live:`/
 * `absence:` link returns `null`, and the caller keeps the old behaviour.
 */
export function studentLessonIdFromNotificationLink(
  raw: unknown,
  role: string | null | undefined
): string | null {
  if (!role) return null;
  const link = parseDeepLink(raw);
  if (!link || link.kind !== "lesson") return null;
  const target = resolveDeepLinkForRole(raw, role);
  if (!target) return null;
  if (!isViewForRole(target.view, role)) return null;
  return link.id;
}
