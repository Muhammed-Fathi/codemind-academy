// Copy the assets that Next.js standalone output does not bundle by default:
//
//   .next/static  ->  .next/standalone/.next/static
//   public        ->  .next/standalone/public
//
// This replaces the previous Unix-only `cp -r` chain so `bun run build`
// completes on Windows CMD, Linux, and macOS alike. Uses only node:fs, no
// external dependencies, and runs identically under node or bun:
//
//   node scripts/copy-standalone-assets.mjs
//
import { cpSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextDir = join(root, ".next");
const standaloneDir = join(nextDir, "standalone");

if (!existsSync(join(standaloneDir, "server.js"))) {
  console.error(
    "copy-standalone-assets: .next/standalone/server.js not found. Did `next build` complete with output: \"standalone\" enabled?"
  );
  process.exit(1);
}

const copies = [
  { from: join(nextDir, "static"), to: join(standaloneDir, ".next", "static") },
  { from: join(root, "public"), to: join(standaloneDir, "public") },
];

for (const { from, to } of copies) {
  if (!existsSync(from)) {
    console.error(`copy-standalone-assets: "${from}" is missing. Was the build output generated?`);
    process.exit(1);
  }
  cpSync(from, to, { recursive: true });
  console.log(`copy-standalone-assets: ${from} -> ${to}`);
}
