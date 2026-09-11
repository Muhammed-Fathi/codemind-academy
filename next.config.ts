import type { NextConfig } from "next";
import { assertProductionEnv } from "./src/lib/env";
import { decideCspHeader } from "./src/lib/content-security-policy";

// Fail the PRODUCTION BUILD early when the production secret contract is not
// met. `next build` always runs with NODE_ENV=production, so this check only
// fires for real production builds — `next dev` is unaffected. The runtime
// server performs the same check again in `src/instrumentation.ts` (the build
// host and the runtime host are not always the same machine).
//
// Set SKIP_PRODUCTION_ENV_CHECK=1 to build an artifact on a CI machine that
// intentionally does not hold production secrets; the runtime guard still
// enforces them when the server actually starts.
if (
  process.env.NODE_ENV === "production" &&
  process.env.SKIP_PRODUCTION_ENV_CHECK !== "1"
) {
  assertProductionEnv();
}

/**
 * Baseline security headers (defense-in-depth).
 *
 * Phase 20 adds a Content-Security-Policy derived from the application's REAL
 * runtime requirements (see src/lib/content-security-policy.ts): no
 * `unsafe-eval` in production, `unsafe-inline` only where the discovered
 * runtime demands it (Next.js inline bootstrap scripts + inline styles), video
 * playback preserved, and an operator kill-switch / report-only toggle
 * (CSP_DISABLED=1 / CSP_REPORT_ONLY=1). In development the same policy is
 * widened with 'unsafe-eval' for webpack HMR only (never shipped).
 */
const securityHeaders = () => {
  const headers = [
    // Never let the app be framed by another origin (clickjacking).
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    // Stop browsers from MIME-sniffing responses (e.g. served media).
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Do not leak full URLs (which may include ?token= reset links) to third parties.
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Camera is required for quiz proctoring on the same origin only; everything
    // else the app never uses is disabled outright.
    {
      key: "Permissions-Policy",
      value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
    },
    // HSTS (Security Audit Gate, pre-P21). Every supported deployment
    // terminates TLS in front of the app (Caddy / nginx / Vercel —
    // docs/DEPLOYMENT_GUIDE.md §6) and redirects HTTP → HTTPS, so the app only
    // ever answers on an HTTPS origin and can commit to it. Browsers honour
    // the header only on a secure response, so emitting it unconditionally is
    // safe; `preload` is deliberately omitted because it is a one-way door
    // submitted to browser vendor lists. `HSTS_DISABLED=1` is the operator
    // kill-switch, shaped like the existing `CSP_DISABLED`.
    ...(String(process.env.HSTS_DISABLED ?? "")
      .trim() === "1"
      ? []
      : [
          {
            key: "Strict-Transport-Security",
            value: "max-age=15552000; includeSubDomains",
          },
        ]),
  ];
  const csp = decideCspHeader();
  if (csp) {
    headers.push({ key: csp.header, value: csp.value });
  }
  return headers;
};

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  reactStrictMode: false,
  // Remove the X-Powered-By: Next.js banner (framework fingerprinting).
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(),
      },
    ];
  },
};

export default nextConfig;
