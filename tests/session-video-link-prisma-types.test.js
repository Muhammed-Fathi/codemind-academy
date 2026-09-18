// Phase A — session-video-link ⇄ REAL Prisma client TYPE boundary (TS2345 regression gate).
//
// Root cause of the local-verification TS2345: the Phase A validator first
// declared a handcrafted structural delegate
//   lesson.findUnique: (args: { where: { id: string }; select: unknown }) => Promise<unknown>
// which is NOT assignable from the generated Prisma delegate
//   <T extends LessonFindUniqueArgs>(args: SelectSubset<T, LessonFindUniqueArgs>)
// under strictFunctionTypes (`select: unknown` does not satisfy the generated
// LessonSelect). Fix: the boundary is now the repository convention —
// `Pick<typeof db, "lesson" | "batch">` (src/lib/session-video-link.ts), the
// same `typeof db` abstraction validateUploadTarget uses in media-upload.ts.
//
// THIS SUITE is the proof the fix holds against the REAL generated client:
// it strict-compiles the exact production call shape (client: typeof db →
// validateSessionVideoLink) plus two assignability probes (PrismaClient and
// the interactive $transaction client) against the generated types on this
// machine. Where the Prisma client is NOT generated (CI/sandbox stub:
// `export declare const PrismaClient: any`), everything is any-typed and the
// check would prove nothing — the suite reports SKIP there instead.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const REPO = path.resolve(__dirname, "..");

function isPrismaClientGenerated() {
  try {
    const dts = fs.readFileSync(
      path.join(REPO, "node_modules", ".prisma", "client", "index.d.ts"),
      "utf8"
    );
    // Install-time stub: "export declare const PrismaClient: any".
    // Generated client: a real class declaration with type parameters.
    return /export declare class PrismaClient\s*</.test(dts);
  } catch {
    return false;
  }
}

test("session-video-link compiles against the REAL generated Prisma client", (t) => {
  if (!isPrismaClientGenerated()) {
    t.skip("Prisma client not generated in this environment (any-typed stub) — nothing to prove here");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-prisma-types-"));

  // The exact production call shape that failed locally (media-upload.ts
  // validateUploadTarget → validateSessionVideoLink) + boundary probes for
  // PrismaClient AND the transaction client.
  fs.writeFileSync(
    path.join(dir, "driver.ts"),
    [
      'import { db } from "@/lib/db";',
      'import { validateSessionVideoLink } from "@/lib/session-video-link";',
      'import type { SessionVideoLinkClient } from "@/lib/session-video-link";',
      "",
      "// 1. The exact production call shape (the line that used to be TS2345).",
      "export async function productionCallShape(lessonId: unknown, batchId: unknown) {",
      "  return validateSessionVideoLink(db, { lessonId, batchId });",
      "}",
      "",
      "// 2. The real PrismaClient must satisfy the validator's client boundary.",
      "export function probeClient(): SessionVideoLinkClient {",
      "  return db;",
      "}",
      "",
      "// 3. So must the interactive-transaction client (identical delegates).",
      "export async function probeTransaction(): Promise<SessionVideoLinkClient> {",
      "  return db.$transaction(async (tx) => tx);",
      "}",
      "",
    ].join("\n")
  );

  // App tsconfig's exact stance: strict + noImplicitAny:false + skipLibCheck.
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2020",
          module: "commonjs",
          moduleResolution: "node",
          strict: true,
          noImplicitAny: false,
          skipLibCheck: true,
          esModuleInterop: true,
          noEmit: true,
          types: ["node"],
          typeRoots: [path.join(REPO, "node_modules", "@types")],
          baseUrl: REPO,
          paths: { "@/*": ["src/*"] },
        },
        // @prisma/client resolves through node_modules → the GENERATED client.
        files: [path.join(dir, "driver.ts")],
      },
      null,
      2
    )
  );

  let tsc;
  try {
    tsc = execFileSync(
      process.execPath,
      [
        path.join(REPO, "node_modules", "typescript", "lib", "tsc.js"),
        "-p",
        path.join(dir, "tsconfig.json"),
      ],
      { cwd: REPO, stdio: "pipe", encoding: "utf8" }
    );
  } catch (err) {
    console.error("Type-boundary compile FAILED with the real generated Prisma client:");
    console.error(String(err.stdout || ""));
    console.error(String(err.stderr || ""));
    throw new Error(
      "session-video-link must type-check against the real generated Prisma client — see diagnostics above"
    );
  }

  const noise = String(tsc || "").trim();
  if (noise) {
    throw new Error(`Unexpected tsc diagnostics:\n${noise}`);
  }
  console.log(
    "Type-boundary OK: PrismaClient, $transaction client and the exact production call shape all satisfy SessionVideoLinkClient under strict mode."
  );
});
