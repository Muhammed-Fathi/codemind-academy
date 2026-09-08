import type { NextConfig } from "next";
import { assertProductionEnv } from "./src/lib/env";

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
 * Baseline security headers (defense-in-depth). These are deliberately
 * conservative and framework-agnostic; a Content-Security-Policy is NOT set
 * here because the app renders client-side with inline styles/scripts and an
 * embedded video iframe, and an untested CSP would break the product.
 */
const securityHeaders = [
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
];

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
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
