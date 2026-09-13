// GET /api/cron/purge-evidence
//
// Phase 24 — Vercel Cron endpoint for the expired quiz-evidence retention
// purge. Vercel Cron (vercel.json → "0 3 * * *", 03:00 UTC daily) issues a
// GET carrying `Authorization: Bearer <CRON_SECRET>`; ONLY that bearer
// authorizes the run. The endpoint delegates to `runEvidencePurge()` in
// src/lib/evidence-retention.ts — the SAME shared core the operator CLI
// (scripts/media/purge-expired-evidence.ts) runs — so there is exactly one
// retention implementation in the repository.
//
// SECURITY CONTRACT
//   * CRON_SECRET missing/blank → 503 (fail closed; nothing can ever run).
//   * Authorization header absent or malformed → 401.
//   * Header present but wrong secret → 401. The comparison is constant-time
//     (both values sha-256-hashed to a fixed 32-byte digest, then
//     timingSafeEqual), so neither length nor content leaks timing.
//   * The secret is accepted ONLY from the Authorization header. It is never
//     read from the query string, and session/cookie state is deliberately
//     ignored: anonymous requests AND ordinary logged-in users cannot trigger
//     deletion — only the bearer can.
//   * No destructive operation runs before authorization succeeds.
//   * The secret is never logged or returned. Responses are fixed, minimal,
//     machine-readable shapes; error bodies name the class of failure, never
//     the data (no storage keys, ids, endpoints, credentials, stack traces).
//
// RUNTIME
//   Node runtime only (pg + node:crypto). Force-dynamic so Vercel never
//   caches the GET. The run is idempotent and bounded (maxDuration 300s): an
//   interrupted run is completed by the next day's run, because expired rows
//   stay expired and deleted objects are never re-listed.

import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import pg from "pg";
import { runEvidencePurge, type PurgeSqlBackend } from "@/lib/evidence-retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Explicit 300s: the current Vercel Hobby plan (Fluid compute) allows up to
// 300s of function execution, so the retention job gets the full Hobby
// execution window. The daily purge is a bounded, idempotent job: anything
// left over is picked up by the next day's run.
export const maxDuration = 300;

/** Reject absurdly long bearer tokens before doing any work with them. */
const MAX_TOKEN_LENGTH = 1024;

function constantTimeEqual(provided: string, expected: string): boolean {
  // Hash BOTH values to a fixed 32-byte digest first: the comparison then
  // depends on neither the length nor the content of either secret.
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Adapt a single-connection `pg.Client` to the shared purge backend contract.
 * ONE connection for the whole run ⇒ BEGIN/COMMIT/ROLLBACK are deterministic
 * (no pool connection-hopping), and the connection is always released by the
 * caller's `finally`, so a run can never outlive the request.
 */
function pgClientBackend(client: pg.Client): PurgeSqlBackend {
  return {
    dialect: "postgresql",
    all: async (sql, params = []) =>
      ((await client.query(sql, params as never[])).rows as Record<string, unknown>[]),
    run: async (sql, params = []) =>
      Number((await client.query(sql, params as never[])).rowCount ?? 0),
    begin: async () => {
      await client.query("BEGIN");
    },
    commit: async () => {
      await client.query("COMMIT");
    },
    rollback: async () => {
      await client.query("ROLLBACK").catch(() => {});
    },
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // 1. Fail closed when the SERVER is misconfigured: without a CRON_SECRET
  //    there is nothing to authorize against and no purge may ever run.
  //    Only the variable NAME can ever appear in an error — never a value.
  const rawSecret = process.env.CRON_SECRET;
  const expected = typeof rawSecret === "string" ? rawSecret : "";
  if (expected.trim() === "") {
    return json(
      { ok: false, error: "misconfigured", reason: "CRON_SECRET_NOT_SET" },
      503
    );
  }

  // 2. Bearer authorization — the ONLY credential this route accepts.
  //    Strict single-token form; sessions/cookies are ignored; the query
  //    string is never read (a ?secret=… request can only ever get 401).
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(header);
  const token = match ? match[1] : "";
  if (
    !token ||
    token.length > MAX_TOKEN_LENGTH ||
    !constantTimeEqual(token, expected)
  ) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  // 3. The production purge runs against PostgreSQL (the Phase 21 cutover
  //    target; a SQLite file cannot persist on Vercel). A non-Postgres
  //    DATABASE_URL is a server misconfiguration, not a user error: fail
  //    closed before touching anything.
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    return json(
      { ok: false, error: "misconfigured", reason: "DATABASE_URL_NOT_POSTGRES" },
      503
    );
  }

  // 4. Authorized — run the shared purge core. Connection failure and any
  //    purge exception map to a fixed 500 body; the message (never the stack
  //    or the connection string) goes to the server log only.
  let client: pg.Client;
  try {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
  } catch (e) {
    console.error(
      `[cron purge-evidence] failed to connect: ${e instanceof Error ? e.message : String(e)}`
    );
    return json({ ok: false, error: "purge failed" }, 500);
  }
  try {
    const report = await runEvidencePurge({
      backend: pgClientBackend(client),
      now: new Date(),
    });
    if (!report.ok) {
      // A protected table moved mid-run. The response names the class of
      // failure only; the operator investigates via the server log.
      console.error("[cron purge-evidence] protected-table invariant violated");
      return json({ ok: false, error: "purge invariant violation" }, 500);
    }
    console.log(
      `[cron purge-evidence] scanned=${report.scanned} deleted=${report.deletedEvidenceRows} assets=${report.deletedAssetRows} files=${report.deletedFiles} failed=${report.failedFiles.length}`
    );
    return json(
      {
        ok: true,
        deleted: report.deletedEvidenceRows,
        deletedAssets: report.deletedAssetRows,
        deletedFiles: report.deletedFiles,
        failed: report.failedFiles.length,
      },
      200
    );
  } catch (e) {
    console.error(
      `[cron purge-evidence] purge failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return json({ ok: false, error: "purge failed" }, 500);
  } finally {
    await client.end().catch(() => {});
  }
}

// GET is the only authorized method. Vercel Cron issues GET; everything else
// is refused before any purge logic can be reached.
function methodNotAllowed(): NextResponse {
  return json({ ok: false, error: "method not allowed" }, 405);
}
export function POST(): NextResponse {
  return methodNotAllowed();
}
export function PUT(): NextResponse {
  return methodNotAllowed();
}
export function PATCH(): NextResponse {
  return methodNotAllowed();
}
export function DELETE(): NextResponse {
  return methodNotAllowed();
}
