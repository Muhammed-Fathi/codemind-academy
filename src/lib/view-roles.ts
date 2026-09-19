// CodeMind Academy — role → view whitelist (post-launch notification fix).
//
// THE CONTRACT
// ============
// `isViewForRole(view, role)` answers: "may a session with `role` ever render
// this view key?" It is used in TWO places that must agree:
//
//   1. the app shell (src/components/app-shell.tsx) — on session restore, a
//      stale/illegal persisted view (e.g. a student view surviving an admin
//      login) redirects to the role home instead of rendering a component
//      that would 403;
//   2. the shared notifications panel (src/components/shared/notifications-panel.tsx)
//      — a notification deep link may only offer its "Open" button when the
//      target view is legal for the CURRENT role. A teacher receiving a
//      `lesson:<id>` notification must NOT be handed the student lesson view
//      (it would render the student shell and hit `/api/lessons/…` as a
//      teacher — a dead, misleading screen). For every other role the
//      notification stays informational: clicking it reads it, and nothing
//      navigates to nowhere.
//
// The lists must stay in sync with:
//   * `ViewKey` (src/lib/store.ts)
//   * `NAV_BY_ROLE` (src/components/dashboard/shell.tsx)
//   * `renderView` (src/components/app-shell.tsx)
// A test pins the three against each other (tests/post-launch-notifications.test.js).

export const VIEWS_BY_ROLE: Record<string, string[]> = {
  STUDENT: [
    "student-dashboard",
    "student-course",
    "student-lesson",
    "student-quiz",
    "student-homework",
    "student-notifications",
    "student-progress",
    "student-exam",
    "student-session-videos",
    "student-bookmarks",
    "student-scheduler",
    "student-referral",
    "student-leaderboard",
    "student-achievements",
    "student-certificate",
  ],
  PARENT: [
    "parent-dashboard",
    "parent-report",
    "parent-notifications",
  ],
  TEACHER: [
    "teacher-dashboard",
    "teacher-sessions",
    "teacher-attendance",
    "teacher-quizzes",
    "teacher-homework",
    "teacher-templates",
    "teacher-analytics",
    "teacher-notifications",
  ],
  ADMIN: [
    "admin-overview",
    "admin-students",
    "admin-teachers",
    "admin-groups",
    "admin-courses",
    "admin-sessions",
    "admin-payments",
    "admin-subscriptions",
    "admin-coupons",
    "admin-question-bank",
    "admin-notifications",
    "admin-session-videos",
    "admin-mock-exams",
    "admin-quiz-review",
    "admin-settings",
  ],
};

/** Public / auth / enrollment pages are valid before/after login. */
export const PUBLIC_VIEWS: readonly string[] = [
  "landing",
  "login",
  "register",
  "enroll",
];

export function isViewForRole(view: string, role: string): boolean {
  if ((PUBLIC_VIEWS as readonly string[]).includes(view)) return true;
  return (VIEWS_BY_ROLE[role] || []).includes(view);
}
