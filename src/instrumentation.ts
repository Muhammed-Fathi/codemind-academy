// Next.js instrumentation hook — runs ONCE when the server process starts,
// before any request is served (both `next start` and the standalone
// `server.js`). Used here purely as a production fail-fast guard: a deployment
// with a missing/placeholder SECURITY_HASH_SECRET must refuse to boot instead
// of silently hashing IPs and device fingerprints with a predictable key.
//
// Nothing here touches the database, and no environment VALUES are ever logged.

export async function register() {
  // Only the Node.js server runtime has access to the real process env; the
  // edge runtime bundle never carries server secrets.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertProductionEnv } = await import("@/lib/env");
  try {
    assertProductionEnv();
  } catch (error) {
    // Next.js would otherwise log "Failed to prepare server" and keep the
    // process alive answering 500s. A misconfigured production deployment must
    // terminate so the process manager (systemd/PM2) surfaces it immediately.
    console.error(error instanceof Error ? error.message : String(error));
    terminateProcess();
  }
}

/**
 * Terminate the server process.
 *
 * WHY THE INDIRECTION: Next.js compiles `instrumentation.ts` into BOTH server
 * bundles — the Node.js one and the Edge one — because `src/proxy.ts` (the
 * Next 16 name for middleware) runs on the Edge runtime. Webpack's edge
 * checker flags every `process.<anything>` member call it finds in that layer
 * (only `process.env` is exempt), so the literal `process.exit(1)` above
 * produced a build warning:
 *
 *   src/instrumentation.ts: process.exit(1) is not supported in the Edge Runtime
 *
 * The warning was cosmetic — the `NEXT_RUNTIME !== "nodejs"` guard above means
 * this code cannot execute in the Edge bundle — but a permanently ignored
 * warning is how a real one gets missed later. Reading `process` off
 * `globalThis` states the intent accurately (this is a Node-only call site,
 * not an Edge API usage) and makes the Edge bundle contain no direct Node
 * process API call at all.
 *
 * Behaviour is unchanged in the Node runtime: `globalThis.process` IS
 * `process`. In the (unreachable) Edge case the property is simply absent and
 * the optional call is a no-op rather than a crash.
 *
 * The production fail-fast itself is untouched: `assertProductionEnv()` still
 * throws, the message is still logged, and the process still exits non-zero so
 * the process manager restarts/reports it.
 */
function terminateProcess(): void {
  const nodeProcess = (globalThis as { process?: NodeJS.Process }).process;
  nodeProcess?.exit?.(1);
}
