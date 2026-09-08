// Portable production launcher — replaces the Unix-only start script
//
//   NODE_ENV=production bun .next/standalone/server.js 2>&1 | tee server.log
//
// which fails on Windows CMD (`NODE_ENV=production` is not a command there and
// `tee` does not exist). This file uses only node:* modules, runs identically
// under `node` and `bun`, and preserves the exact same behaviour on Linux:
//
//   * NODE_ENV=production is set for the child (never overrides an explicit
//     value already present in the environment, e.g. from systemd/PM2).
//   * stdout+stderr are mirrored to the console AND appended to server.log
//     (override the file with SERVER_LOG_FILE, or set SERVER_LOG_FILE=0 to
//     disable file logging when a process manager already captures output).
//   * Signals (SIGINT/SIGTERM) are forwarded so `Ctrl+C` / `systemctl stop`
//     terminate the real server, and the launcher exits with the server's code.
//
// The standalone server itself is unchanged; this only wraps its invocation.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(root, ".next", "standalone", "server.js");

if (!existsSync(serverEntry)) {
  console.error(
    `start-production: ${serverEntry} not found. Run \`bun run build\` first (output: "standalone" is required).`
  );
  process.exit(1);
}

const logSetting = process.env.SERVER_LOG_FILE ?? "server.log";
const logStream =
  logSetting && logSetting !== "0"
    ? createWriteStream(resolve(root, logSetting), { flags: "a" })
    : null;

// Use whichever runtime launched this script (bun or node) for the server too,
// so `bun run start` keeps using bun and `node scripts/start-production.mjs`
// keeps using node — identical to the previous behaviour on Linux.
const child = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" },
  stdio: ["inherit", "pipe", "pipe"],
});

const tee = (from, to) => {
  from.on("data", (chunk) => {
    to.write(chunk);
    if (logStream) logStream.write(chunk);
  });
};
tee(child.stdout, process.stdout);
tee(child.stderr, process.stderr);

let forwarded = null;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    forwarded = signal;
    if (child.exitCode === null && !child.killed) child.kill(signal);
    // Next.js shuts down gracefully; if it hangs, force-kill after 10s.
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 10_000).unref();
  });
}

child.on("exit", (code, signal) => {
  if (logStream) logStream.end();
  // Exit code semantics: server's own code, or 0 when we asked it to stop.
  if (forwarded) process.exit(0);
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
child.on("error", (error) => {
  console.error("start-production: failed to launch server:", error.message);
  if (logStream) logStream.end();
  process.exit(1);
});
