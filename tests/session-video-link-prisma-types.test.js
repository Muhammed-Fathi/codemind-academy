// Phase A — session-video-link ⇄ REAL Prisma client TYPE boundary (TS2345 regression gate).
//
// Background: the Phase A validator first declared a handcrafted structural
// delegate (lesson.findUnique with `select: unknown`) which is NOT assignable
// from the generated Prisma delegate under strictFunctionTypes → TS2345 at
// the production call site (media-upload.ts validateUploadTarget). The
// boundary is now `Pick<typeof db, "lesson" | "batch">` (the repo's `typeof
// db` convention) — this suite proves that boundary against the REAL
// generated @prisma/client types on this machine.
//
// WHY COMPILE-FIRST (v2): v1 of this suite *guessed* "generated vs stub" by
// text-matching `export declare class PrismaClient<` inside
// node_modules/.prisma/client/index.d.ts. That heuristic is unreliable — in
// 6.19.3 the shipped install stub is a 110-line file (const/type PrismaClient
// = any + a real `class PrismaClientExtends<...>` scaffold), the generated
// file's exact emission is not observable locally (the TS templates live in
// prisma_schema_build_bg.wasm), and on a machine where `prisma generate` HAD
// succeeded the heuristic still misread the file as "stub" and falsely
// skipped. v2 therefore never inspects file contents: it ALWAYS compiles a
// driver against whatever `@prisma/client` resolves to and lets the compiler
// decide, using a type-presence CANARY:
//
//   new PrismaClient().__cmTypeCanary_missingDelegate
//
//   - REAL generated types → this line CANNOT compile (TS2339 naming the
//     canary identifier). A compile run whose ONLY diagnostic is the canary
//     proves real typed surfaces were exercised → then the driver part
//     (exact production call + PrismaClient + TransactionClient probes)
//     must have produced ZERO diagnostics → PASS.
//   - any-typed install stub → the canary compiles silently and the driver
//     cannot produce type errors either (everything is `any`) → an empty
//     diagnostic set is unambiguous proof of the stub → SKIP with an
//     accurate reason.
//   - any other diagnostic combination → FAIL with the full compiler output
//     (this is exactly where a TS2345 boundary regression would surface).
//
// Nothing is hardcoded to pass; the skip paths quote what the compiler
// actually said; production code is not touched by this suite.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const REPO = path.resolve(__dirname, "..");

/** Marker the canary uses — tsc's TS2339 message will contain this exact text. */
const CANARY_MARKER = "__cmTypeCanary_missingDelegate";

/** The compiled driver: production call shape + boundary probes + canary. */
const DRIVER_TS = [
  'import { db } from "@/lib/db";',
  'import { validateSessionVideoLink } from "@/lib/session-video-link";',
  'import type { SessionVideoLinkClient } from "@/lib/session-video-link";',
  'import { PrismaClient } from "@prisma/client";',
  "",
  "// 1. The EXACT production call shape (the line that used to be TS2345):",
  "//    media-upload.ts validateUploadTarget(client: typeof db) calls",
  "//    validateSessionVideoLink(client, ...).",
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
  "// 4. TYPE-PRESENCE CANARY — a detector, not an assertion (see file header).",
  "//    Real generated types: TS2339 naming " + CANARY_MARKER + ".",
  "//    Any-typed install stub: compiles silently.",
  "export function __cmTypeCanary() {",
  "  return new PrismaClient()." + CANARY_MARKER + ";",
  "}",
  "",
].join("\n");

function runBoundaryCompile(extraPaths) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-prisma-types-"));
  fs.writeFileSync(path.join(dir, "driver.ts"), DRIVER_TS);

  // App tsconfig's exact stance: strict + noImplicitAny:false + skipLibCheck.
  // The driver itself lives in an OS tmpdir, so bare-specifier resolution
  // cannot walk to the repo's node_modules on its own — `@/lib/x` is mapped
  // by baseUrl+paths, and `@prisma/client` is pinned to the repo's ACTUAL
  // installed entry declaration. From there its own imports
  // (`.prisma/client/default`, `@prisma/client/runtime/library`) resolve
  // natively relative to that file — i.e. against whatever this machine
  // really has: the GENERATED client when `prisma generate` has run, or the
  // any-typed install stub otherwise. No overriding, no guessing.
  // `extraPaths` exists ONLY for local simulations of a generated
  // environment; production test runs pass nothing.
  const paths = {
    "@/*": ["src/*"],
    "@prisma/client": [
      path.join(REPO, "node_modules", "@prisma", "client", "index.d.ts"),
    ],
  };
  if (extraPaths) Object.assign(paths, extraPaths);

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
          paths,
        },
        files: [path.join(dir, "driver.ts")],
      },
      null,
      2
    )
  );

  let out = "";
  try {
    out = String(
      execFileSync(
        process.execPath,
        [
          path.join(REPO, "node_modules", "typescript", "lib", "tsc.js"),
          "-p",
          path.join(dir, "tsconfig.json"),
        ],
        { cwd: REPO, stdio: "pipe", encoding: "utf8" }
      ) || ""
    );
  } catch (err) {
    // tsc exits non-zero when diagnostics exist — that is expected signal,
    // not a harness crash. Harvest everything it printed.
    out = String((err && err.stdout) || "") + String((err && err.stderr) || "");
  }

  const diagnostics = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const canaryLines = diagnostics.filter((l) => l.includes(CANARY_MARKER));
  const otherLines = diagnostics.filter((l) => !l.includes(CANARY_MARKER));
  return { diagnostics, canaryLines, otherLines };
}

test("session-video-link compiles against the REAL generated Prisma client", (t) => {
  const { diagnostics, canaryLines, otherLines } = runBoundaryCompile();

  if (canaryLines.length > 0) {
    // REAL typed Prisma surfaces were compiled against. The driver + probes
    // must then have produced ZERO additional diagnostics.
    if (otherLines.length > 0) {
      console.error(
        "Type-boundary FAILED against the real generated Prisma client " +
          "(canary expected, unexpected extra diagnostics below):"
      );
      console.error(diagnostics.join("\n"));
      throw new Error(
        "session-video-link must type-check against the real generated Prisma client — see diagnostics above"
      );
    }
    console.log(
      "Type-boundary OK: canary confirmed real generated Prisma types; the exact " +
        "validateSessionVideoLink production call, PrismaClient and the $transaction " +
        "client all satisfy SessionVideoLinkClient under strict mode with zero diagnostics."
    );
    return;
  }

  // Canary silent → whatever @prisma/client resolved to is any-typed (or
  // missing). Decide honestly from what the compiler printed.
  if (diagnostics.length === 0) {
    t.skip(
      "@prisma/client resolves to an any-typed surface here (Prisma client not " +
        "generated in this environment) — the canary compiled silently and the " +
        "driver could not produce type errors, so there is nothing to prove. " +
        "Run `prisma generate` (e.g. `bun run db:generate`) to activate this gate."
    );
    return;
  }

  const resolutionFailure = diagnostics.some((l) =>
    /error TS(2307|2305|2792):/.test(l) && /prisma/i.test(l)
  );
  if (resolutionFailure) {
    t.skip(
      "Could not resolve typed @prisma/client surfaces in this environment — " +
        "compiler said:\n" +
        diagnostics.join("\n")
    );
    return;
  }

  console.error("Unexpected compiler diagnostics (no canary, not a stub signature):");
  console.error(diagnostics.join("\n"));
  throw new Error(
    "Type-boundary suite could not interpret the compile result — see diagnostics above"
  );
});
