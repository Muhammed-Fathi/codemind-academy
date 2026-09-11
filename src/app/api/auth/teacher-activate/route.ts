// POST /api/auth/teacher-activate
// Body: { token: string, password: string }
//
// Completes a Teacher application that an Admin APPROVED. The `token` is the
// high-entropy secret emailed by the approval step (same architecture as the
// password-reset token: SHA-256 stored, raw value never persisted or logged).
//
// Security properties:
//  * Token is looked up by SHA-256.
//  * Single use: `usedAt` is stamped inside the same transaction that creates
//    the Teacher `User`, so a token can never be replayed.
//  * Expired tokens are rejected (and consumed).
//  * The applicant sets their OWN password here — no default/hardcoded one.
//  * A token can only activate ITS OWN application (bound by applicationId).
//  * Public endpoint: rate limited per IP and per token to stop guessing.

import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { ok, err } from "@/lib/api";
import {
  hashIp,
  clientIpFromHeaders,
  sha256,
  checkRateLimit,
  logSecurityEvent,
} from "@/lib/security";
import { activateTeacher } from "@/lib/teacher-applications";
import { getServerT } from "@/lib/i18n-server";

const PER_IP_LIMIT = 20;
const PER_IP_WINDOW_SEC = 60 * 60;
const PER_TOKEN_LIMIT = 5;
const PER_TOKEN_WINDOW_SEC = 60 * 60;

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const hdrs = await headers();
  const body = await req.json().catch(() => ({}));

  const token = String(body.token || "").trim();
  const password = String(body.password || "");

  if (!token) return err(tApi("api.260"), 400);
  if (password.length < 8) return err(tApi("api.204"), 400);

  const ip = clientIpFromHeaders(hdrs as Headers);
  const ipKey = hashIp(ip) || "unknown";
  const tokenKey = sha256(token);

  const ipLimit = await checkRateLimit("teacheract:ip", ipKey, PER_IP_LIMIT, PER_IP_WINDOW_SEC);
  if (!ipLimit.allowed) {
    await logSecurityEvent({
      type: "TEACHER_ACTIVATION_FAILED",
      detail: "IP rate limit exceeded",
      headers: hdrs,
    });
    return err(tApi("api.202"), 429);
  }
  const tokenLimit = await checkRateLimit(
    "teacheract:token",
    tokenKey,
    PER_TOKEN_LIMIT,
    PER_TOKEN_WINDOW_SEC
  );
  if (!tokenLimit.allowed) {
    await logSecurityEvent({
      type: "TEACHER_ACTIVATION_FAILED",
      detail: "Per-token rate limit exceeded",
      headers: hdrs,
    });
    return err(tApi("api.202"), 429);
  }

  const outcome = await activateTeacher({ token, password });

  // Uniform error for unknown / used / expired / wrong-application tokens.
  const invalid = () => err(tApi("api.261"), 400);

  if (!outcome.ok) {
    await logSecurityEvent({
      type: "TEACHER_ACTIVATION_FAILED",
      detail: `reason=${outcome.reason}`,
      headers: hdrs,
    });
    if (outcome.reason === "EMAIL_CONFLICT") {
      return err(tApi("api.258"), 409);
    }
    return invalid();
  }

  await logSecurityEvent({
    userId: outcome.userId,
    type: "TEACHER_ACTIVATION_COMPLETED",
    detail: "Teacher account activated via single-use token",
    headers: hdrs,
  });

  // Never auto-login: the new teacher signs in themselves afterwards.
  return ok({ ok: true, message: tApi("api.262") });
}
