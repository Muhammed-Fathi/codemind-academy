// CodeMind Academy — Content Security Policy (Phase 20).
//
// THE CONTRACT
// ============
// The CSP is derived from the application's ACTUAL runtime requirements, which
// were discovered by reading the real client surface (Phase 20 discovery):
//
//   * video playback — BOTH a legacy <iframe> embed (`Lesson.videoUrl`, an
//     admin-provided https URL that may be a YouTube/Vimeo embed) AND native
//     <video> elements fed by `/api/media/[id]` (same-origin) or an
//     admin-provided https URL → `frame-src` + `media-src` must allow https.
//   * camera proctoring — `getUserMedia` (same-origin; the stream is not a
//     URL, so it needs no media-src entry) → `Permissions-Policy` already
//     limits it to self.
//   * legitimate inline styles — framer-motion / recharts write inline
//     `style` attributes AND `chart.tsx` injects a dynamic `<style>` block →
//     `style-src 'unsafe-inline'` is required today (a nonce/hash migration
//     is future work, documented below).
//   * Next.js App Router — the bootstrap/RSC flight payload is delivered as
//     inline `<script>` blocks in the HTML → `script-src 'unsafe-inline'` is
//     required; production does NOT use `eval` (webpack HMR in `next dev`
//     does, which is why development alone widens script-src with
//     'unsafe-eval' and never ships it).
//   * no client-side cross-origin `fetch`/XHR/worker exists (the AI SDK is
//     server-only; Kodgy is scripted) → `connect-src 'self'`.
//
// RULES THIS MODULE OWNS
// ======================
//  1. NO `unsafe-eval` in production. The only place 'unsafe-eval' appears is
//     the DEVELOPMENT build (webpack HMR), gated on NODE_ENV and never
//     emitted by a production server.
//  2. `unsafe-inline` is present ONLY where the discovered runtime requires
//     it (script-src for the Next.js inline bootstrap, style-src for inline
//     styles). Every other directive is a source list.
//  3. Rollback is an operator decision, not a redeploy: `CSP_DISABLED=1`
//     removes the header, `CSP_REPORT_ONLY=1` downgrades it to
//     Content-Security-Policy-Report-Only so violations can be observed
//     before enforcement. Defaults are the SAFE state (enforced in
//     production).
//  4. This module is PURE (no I/O, no Next imports) so the offline suite can
//     compile and assert the exact directives — including that production
//     never contains 'unsafe-eval'.

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

export const CSP_DIRECTIVE_ORDER = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "frame-src",
  "media-src",
  "connect-src",
  "worker-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
] as const;

export type CspDirective = (typeof CSP_DIRECTIVE_ORDER)[number];

/**
 * The PRODUCTION directive set. `development` widens exactly one directive
 * (script-src) with 'unsafe-eval' for webpack HMR — see `buildCspDirectives`.
 */
const PRODUCTION_DIRECTIVES: Record<CspDirective, readonly string[]> = {
  "default-src": ["'self'"],
  // Next.js App Router inline bootstrap/RSC scripts + the app's own chunks.
  "script-src": ["'self'", "'unsafe-inline'"],
  // Inline style attributes (framer-motion) + dynamic <style> (chart.tsx).
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "font-src": ["'self'", "data:"],
  // Legacy lesson embeds (YouTube/Vimeo) + any other admin-approved https.
  "frame-src": ["'self'", "https:", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com"],
  // Native <video>: /api/media/[id] (self), blob: (camera re-encode), https
  // (legacy admin-provided video urls).
  "media-src": ["'self'", "blob:", "data:", "https:"],
  "connect-src": ["'self'"],
  "worker-src": ["'self'", "blob:"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'self'"],
};

export function buildCspDirectives(
  options: { development?: boolean } = {}
): Record<CspDirective, readonly string[]> {
  if (!options.development) return { ...PRODUCTION_DIRECTIVES };
  const dev: Record<CspDirective, readonly string[]> = { ...PRODUCTION_DIRECTIVES };
  // webpack HMR in `next dev` evaluates module code; this widening exists in
  // development ONLY and is never present in a production build.
  dev["script-src"] = [...PRODUCTION_DIRECTIVES["script-src"], "'unsafe-eval'"];
  return dev;
}

// ---------------------------------------------------------------------------
// Header construction
// ---------------------------------------------------------------------------

/** Serialise the directive map into a CSP header value (deterministic order). */
export function serializeCsp(directives: Record<CspDirective, readonly string[]>): string {
  return CSP_DIRECTIVE_ORDER.map((d) => `${d} ${directives[d].join(" ")}`).join("; ");
}

export type CspDecision =
  | { header: "Content-Security-Policy" | "Content-Security-Policy-Report-Only"; value: string }
  | null;

/**
 * Decide which CSP header (if any) to emit for the given environment.
 *
 *   production: enforced CSP (unless CSP_DISABLED=1), report-only when
 *               CSP_REPORT_ONLY=1 (observability-first rollout).
 *   development/test: enforced CSP widened with 'unsafe-eval' so the live
 *               dev server and its preview keep working.
 *
 * `CSP_DISABLED=1` is the explicit operator kill-switch (default off).
 */
export function decideCspHeader(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): CspDecision {
  if (String(env.CSP_DISABLED ?? "").trim() === "1") return null;

  const isProduction = env.NODE_ENV === "production";
  const reportOnly = String(env.CSP_REPORT_ONLY ?? "").trim() === "1";

  // Development/test: enforce with the dev widening. `report-only` is not
  // honoured outside production — a dev report-only header is noise.
  if (!isProduction) {
    const value = serializeCsp(buildCspDirectives({ development: true }));
    return { header: "Content-Security-Policy", value };
  }

  const value = serializeCsp(buildCspDirectives({ development: false }));
  return {
    header: reportOnly
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy",
    value,
  };
}

// ---------------------------------------------------------------------------
// Introspection helpers (used by the test suite)
// ---------------------------------------------------------------------------

/** True when a serialized CSP contains `unsafe-eval` anywhere. */
export function containsUnsafeEval(headerValue: string): boolean {
  return /'unsafe-eval'/.test(headerValue);
}

/** Parse a serialized CSP back into a directive map (for assertions). */
export function parseCsp(value: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    if (space <= 0) continue;
    const name = trimmed.slice(0, space).toLowerCase();
    out[name] = trimmed
      .slice(space + 1)
      .split(/\s+/)
      .filter(Boolean);
  }
  return out;
}
