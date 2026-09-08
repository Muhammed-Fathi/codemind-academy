// CodeMind Academy — request proxy (Next.js 16 name for "middleware").
//
// DEFENSE-IN-DEPTH ONLY. This layer rejects requests to authenticated API
// namespaces that do not even carry a session cookie. It performs NO database
// access and NO role/ownership logic: the presence of a cookie proves nothing
// about validity, so every protected route still runs `requireUser` /
// `requireRole` and its own scope checks. The value of this layer is that an
// accidentally unguarded route in a protected namespace is no longer reachable
// anonymously, and anonymous probing never reaches route code or the database.
//
// See `src/lib/route-protection.ts` for the prefix map and the rationale for
// why only API paths (and no page routes) are covered.

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, decideApiAccess } from "@/lib/route-protection";

export function proxy(req: NextRequest) {
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  const decision = decideApiAccess(req.nextUrl.pathname, hasSession);

  if (decision === "deny") {
    // Same shape as `err("Unauthorized", 401)` from src/lib/api.ts so clients
    // cannot distinguish the proxy from a route-level rejection.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  // Only API traffic is evaluated; pages and static assets are untouched.
  matcher: ["/api/:path*"],
};
