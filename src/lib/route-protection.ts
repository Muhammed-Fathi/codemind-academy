// CodeMind Academy — Route protection map shared by the request proxy
// (src/proxy.ts) and its tests.
//
// This is a DEFENSE-IN-DEPTH layer only. It answers one cheap question with no
// database access: "does this request even carry a session cookie?" Every
// protected API route still performs the real authorization (session lookup,
// role check, ownership/scope checks) server-side via `requireUser` /
// `requireRole`. Nothing here may ever be relied upon as the sole check.
//
// Why only API namespaces? The application is a single-page shell: the only
// page route is `/` and every portal (admin/teacher/student/parent) is a
// client-side view fed exclusively by `/api/*`. There are no `/admin`-style
// page routes to guard, so page-level redirects would be dead code.

export const SESSION_COOKIE_NAME = "cm_session";

/**
 * API path prefixes that are meaningful ONLY to an authenticated user.
 * A request without a session cookie is rejected up-front with 401.
 */
export const PROTECTED_API_PREFIXES: readonly string[] = [
  "/api/admin",
  "/api/teacher",
  "/api/students",
  "/api/parents",
  "/api/media",
  "/api/quizzes",
  "/api/lessons",
  "/api/exams",
  "/api/notifications",
  "/api/enroll",
  "/api/coupons/validate",
];

/**
 * Paths under a protected prefix that must stay reachable without a session.
 * (None today — listed explicitly so future exceptions are deliberate.)
 */
export const PROTECTED_API_EXCEPTIONS: readonly string[] = [];

/**
 * Public API surface (documented for clarity; NOT matched by the proxy):
 *   /api/auth/*               login, register, logout, me, password reset
 *   /api/settings/public      brand/public settings
 *   /api/subscription-plans   pricing catalogue for the enrolment flow
 *   /api/courses              requires auth inside the route itself
 *   /api/groups               public group picker for enrolment
 *   /api                      hello-world health endpoint
 */

export function isProtectedApiPath(pathname: string): boolean {
  if (PROTECTED_API_EXCEPTIONS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return false;
  }
  return PROTECTED_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  );
}

/**
 * Decide what the proxy should do for a request.
 *  - "pass":  not a protected path, or a session cookie is present.
 *  - "deny":  protected path with no session cookie → 401.
 */
export function decideApiAccess(
  pathname: string,
  hasSessionCookie: boolean
): "pass" | "deny" {
  if (!isProtectedApiPath(pathname)) return "pass";
  return hasSessionCookie ? "pass" : "deny";
}
