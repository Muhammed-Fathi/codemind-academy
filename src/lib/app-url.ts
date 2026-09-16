// CodeMind Academy — application origin / absolute URL building (Phase 26G).
//
// WHY THIS MODULE EXISTS
//   Three shipped call sites built absolute links with the SAME expression:
//
//       process.env.NEXT_PUBLIC_URL || "http://localhost:3000"
//
//   That fallback is correct for `next dev` and for the offline verifiers, and
//   it is WRONG in production: a deployment that never set NEXT_PUBLIC_URL
//   emails password-reset and teacher-activation links pointing at
//   `http://localhost:3000`, while `appUrl()` silently reports success. The
//   mail is delivered, the token is valid, the link simply goes nowhere — and
//   nothing in the logs says why. Neither flow can be completed by a real
//   person, so this is a launch-blocking misconfiguration, not a cosmetic one.
//
//   It is caught at BUILD and at STARTUP (see `validateProductionEnv` in
//   src/lib/env.ts) rather than at request time. NEXT_PUBLIC_* is additionally
//   inlined into any CLIENT bundle that reads it, so the build environment
//   needs the value too.
//
// THE CONTRACT
//   * Non-production (dev / test / unset NODE_ENV): NEXT_PUBLIC_URL when set,
//     else the localhost development origin. Behaviour is unchanged.
//   * Production: NEXT_PUBLIC_URL is MANDATORY and must be an absolute
//     **HTTPS** origin. There is deliberately no production fallback —
//     `resolveAppUrl()` throws, and `validateProductionEnv()`
//     (src/lib/env.ts) refuses to build or boot a deployment that would
//     have shipped dead email links.
//
//   WHY HTTPS-ONLY (Phase 26G review, tightened from http(s)):
//     The origin is not cosmetic — it is the prefix of every password-reset
//     link and every teacher-activation link, i.e. of URLs that carry a
//     long-lived single-use credential in the query string. A plaintext
//     `http://` origin puts that token on the wire, readable and rewritable by
//     anyone on the path, and any https→http hop leaks it in a Referer. Both
//     flows are account-takeover / account-creation surfaces. There is no
//     legitimate reason for a production deployment of this app to be served
//     over plain HTTP, so the validator FAILS CLOSED rather than "allowing it
//     but with a warning". A misconfiguration must stop the build, not ship
//     and quietly mint insecure credential URLs.
//   * Paths are APPENDED, never concatenated from user input: `appUrl()` is
//     the only way to mint an absolute link, so no call site can drift back
//     to string-building one. It is also the single place that decides what
//     an acceptable origin looks like — there is no open redirect here because
//     nothing client-supplied ever reaches the origin half of the URL.
//
// SECRETS
//   NEXT_PUBLIC_URL is PUBLIC by definition (it is inlined into the client
//   bundle). It is validated for SHAPE, never treated as a secret, and never
//   logged as a value by this module — problems name the variable only.

/** The development origin. Never accepted in production. */
export const DEV_APP_URL = "http://localhost:3000";

/** Variable name surfaced in problems (never its value). */
export const APP_URL_ENV_VAR = "NEXT_PUBLIC_URL";

function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production";
}

/** Hostnames that mean "this machine" — a shipped origin is never one of them. */
function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    // The whole 127/8 block is loopback, not just .0.1.
    h.startsWith("127.") ||
    h === "::1" ||
    h === "[::1]" ||
    h === "0.0.0.0" ||
    // IPv4-mapped IPv6 loopback. WHATWG URL normalises the dotted-quad form,
    // so both spellings are listed: "[::ffff:127.0.0.1]" as typed and
    // "[::ffff:7f00:1]" as the URL parser emits it.
    h.startsWith("[::ffff:127.") ||
    h.startsWith("[::ffff:7f00:") ||
    h.endsWith(".localhost") ||
    h.endsWith(".local")
  );
}

/**
 * Return a human-readable problem for NEXT_PUBLIC_URL, or `null` when the
 * value is acceptable for the given environment. Never includes the value.
 */
export function getAppUrlProblem(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!isProductionEnv(env)) return null;

  const raw = env[APP_URL_ENV_VAR];
  const value = typeof raw === "string" ? raw.trim() : "";

  if (!value) {
    return (
      `${APP_URL_ENV_VAR} is required when NODE_ENV=production. Set it to the ` +
      `public https origin of the deployment (for example ` +
      `https://codemind.academy). Without it every password-reset and ` +
      `teacher-activation email links to ${DEV_APP_URL} — the message is ` +
      `delivered, the token is valid, and the link goes nowhere. Set it in the ` +
      `host environment AND in the build environment (NEXT_PUBLIC_* is ` +
      `inlined into any client bundle that reads it — see .env.example). On a ` +
      `CI box that intentionally holds no production configuration use ` +
      `SKIP_PRODUCTION_ENV_CHECK=1, which skips the BUILD check only.`
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return (
      `${APP_URL_ENV_VAR} is not a valid absolute URL in production. ` +
      `Expected an https origin such as https://codemind.academy.`
    );
  }

  // ---- HTTPS-ONLY (Phase 26G review). See the header comment for the threat
  // model: this origin prefixes password-reset and teacher-activation links,
  // which carry a single-use credential in the query string.
  if (url.protocol !== "https:") {
    return (
      `${APP_URL_ENV_VAR} must use the https scheme in production — ` +
      `plain http is rejected. This origin becomes the prefix of every ` +
      `password-reset and teacher-activation link, and those URLs carry a ` +
      `single-use credential in the query string: over http the token is ` +
      `readable and rewritable by anyone on the path, and any https->http ` +
      `hop leaks it in a Referer. Set it to the deployed https origin ` +
      `(for example https://codemind.academy).`
    );
  }

  if (isLoopbackHostname(url.hostname)) {
    return (
      `${APP_URL_ENV_VAR} must not be a loopback/localhost origin in ` +
      `production — email links built from it would be unusable for real ` +
      `users. Set it to the deployed public https origin.`
    );
  }

  // A configured ORIGIN is a scheme + host (+ optional port/path). Anything
  // else is a copy-paste error that would silently corrupt every minted link
  // (a stray `?` or `#` in the base would swallow or truncate the token).
  if (url.username || url.password) {
    return (
      `${APP_URL_ENV_VAR} must not embed credentials. Configure the origin ` +
      `as https://host (optionally with a port) and nothing else.`
    );
  }
  if (url.search) {
    return (
      `${APP_URL_ENV_VAR} must be a bare origin — remove the query string. ` +
      `Query parameters appended by appUrl() would collide with it.`
    );
  }
  if (url.hash) {
    return (
      `${APP_URL_ENV_VAR} must be a bare origin — remove the fragment. A ` +
      `fragment in the base URL would discard everything appUrl() appends.`
    );
  }

  return null;
}

/**
 * Resolve the application origin.
 *
 *   production      -> NEXT_PUBLIC_URL, validated; THROWS when unusable.
 *   anything else   -> NEXT_PUBLIC_URL when set, else the dev origin.
 *
 * The returned value never ends in `/`, so `appUrl("/x")` cannot produce `//x`.
 */
export function resolveAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  const problem = getAppUrlProblem(env);
  if (problem) throw new Error(problem);

  const raw = env[APP_URL_ENV_VAR];
  const value = typeof raw === "string" ? raw.trim() : "";
  const resolved = value || DEV_APP_URL;
  return resolved.replace(/\/+$/, "");
}

/**
 * Build an absolute application URL from a server-owned path.
 *
 * `pathAndQuery` is always authored by the server (it carries a freshly minted
 * token, a referral code, or a fixed route) — it is never taken from the
 * request body, so this helper cannot be turned into an open redirect.
 */
export function appUrl(
  pathAndQuery: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const base = resolveAppUrl(env);
  const p = String(pathAndQuery ?? "");
  if (!p) return base;
  return `${base}${p.startsWith("/") ? p : `/${p}`}`;
}
