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
    process.exit(1);
  }
}
