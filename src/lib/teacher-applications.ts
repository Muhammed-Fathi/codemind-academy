// CodeMind Academy — Teacher application & admin approval (Phase 20).
//
// Identity provisioning hardening: the public "become a teacher" flow creates
// ONLY a PENDING `TeacherApplication`. A `User` with `role = TEACHER` is born
// LATER — by the applicant themselves — through a single-use activation token
// minted when an authorized Admin approves. This module owns the domain rules;
// the routes own HTTP mapping, rate limiting, audit, and email delivery.
//
// Reuse, not duplication (Phase 20 addendum §2): the activation token mirrors
// `PasswordResetToken` exactly (cryptographically random secret, SHA-256
// stored, short-lived, single-use via a guarded consume inside `$transaction`).
// Sessions/passwords stay in `src/lib/auth.ts`; abuse protection stays in
// `src/lib/security.ts` + `src/lib/rate-limit.ts`. The ONLY new primitive is
// the `TeacherApplication`/`TeacherActivationToken` rows, because no existing
// table can safely represent "a person who may later become a teacher" without
// creating an active account up front.

import { db } from "@/lib/db";
import { generateToken, sha256 } from "@/lib/security";
import { hashPassword } from "@/lib/auth";

export const TEACHER_ACTIVATION_TTL_HOURS = Number(
  process.env.TEACHER_ACTIVATION_TTL_HOURS || 72
);

/** Canonicalize exactly like the existing auth system. */
export function canonicalTeacherEmail(raw: unknown): string {
  return String(raw ?? "").toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// Result types (structural, so routes + tests share one vocabulary)
// ---------------------------------------------------------------------------

export type SubmitOutcome =
  | { ok: true; application: { id: string; email: string; status: string }; reapplied: boolean }
  | { ok: false; reason: "EMAIL_TAKEN" | "APPLICATION_EXISTS" | "ACTIVATED" };

export type ApproveOutcome =
  | { ok: true; alreadyApproved: boolean; activationToken?: string; application: { id: string; email: string } }
  | { ok: false; reason: "NOT_FOUND" | "ALREADY_ACTIVATED" | "REJECTED" };

export type RejectOutcome =
  | { ok: true; alreadyRejected: boolean }
  | { ok: false; reason: "NOT_FOUND" | "ALREADY_ACTIVATED" };

export type ActivateOutcome =
  | { ok: true; userId: string }
  | { ok: false; reason: "INVALID_TOKEN" | "EMAIL_CONFLICT" };

// ---------------------------------------------------------------------------
// Submit (public) — never creates a User, never a session, never role=TEACHER.
// ---------------------------------------------------------------------------

export async function submitTeacherApplication(
  input: {
    email: string;
    name: string;
    phone?: string | null;
    specialty?: string | null;
    bio?: string | null;
  },
  client: any = db
): Promise<SubmitOutcome> {
  const email = canonicalTeacherEmail(input.email);

  // A User already owns this email (any role). Fail closed and DO NOT mutate
  // it — a pending application must never overwrite or merge another account.
  const existingUser = await client.user.findUnique({ where: { email } });
  if (existingUser) return { ok: false, reason: "EMAIL_TAKEN" };

  const existing = await client.teacherApplication.findUnique({ where: { email } });
  if (existing) {
    if (existing.status === "REJECTED") {
      // Re-application policy: re-open the SAME row as PENDING (one row per
      // email identity forever — no conflicting duplicate applications).
      const reapplied = await client.teacherApplication.update({
        where: { id: existing.id },
        data: {
          name: input.name,
          phone: input.phone || null,
          specialty: input.specialty || null,
          bio: input.bio || null,
          status: "PENDING",
          adminNote: null,
          reviewedByUserId: null,
          reviewedAt: null,
        },
      });
      return {
        ok: true,
        reapplied: true,
        application: { id: reapplied.id, email: reapplied.email, status: reapplied.status },
      };
    }
    if (existing.status === "ACTIVATED") return { ok: false, reason: "ACTIVATED" };
    // PENDING or APPROVED — one live application per identity.
    return { ok: false, reason: "APPLICATION_EXISTS" };
  }

  const created = await client.teacherApplication.create({
    data: {
      email,
      name: input.name,
      phone: input.phone || null,
      specialty: input.specialty || null,
      bio: input.bio || null,
      status: "PENDING",
    },
  });
  return {
    ok: true,
    reapplied: false,
    application: { id: created.id, email: created.email, status: created.status },
  };
}

// ---------------------------------------------------------------------------
// Approve (admin) — mints the activation token; still NO User created.
// ---------------------------------------------------------------------------

export async function approveTeacherApplication(
  input: { id: string; adminUserId: string },
  client: any = db
): Promise<ApproveOutcome> {
  const application = await client.teacherApplication.findUnique({
    where: { id: input.id },
  });
  if (!application) return { ok: false, reason: "NOT_FOUND" };
  if (application.status === "ACTIVATED") return { ok: false, reason: "ALREADY_ACTIVATED" };
  if (application.status === "REJECTED") return { ok: false, reason: "REJECTED" };

  // Idempotent: an APPROVED application already has (or had) its token — a
  // retry never re-mints/invalidates the link. Re-issue = reject → re-approve.
  if (application.status === "APPROVED") {
    return { ok: true, alreadyApproved: true, application: { id: application.id, email: application.email } };
  }

  // Guarded transition: exactly one concurrent approver wins.
  const flipped = await client.teacherApplication.updateMany({
    where: { id: application.id, status: "PENDING" },
    data: {
      status: "APPROVED",
      reviewedByUserId: input.adminUserId,
      reviewedAt: new Date(),
    },
  });
  if (flipped.count !== 1) {
    // Lost a race — re-read and report the now-current state idempotently.
    const fresh = await client.teacherApplication.findUnique({ where: { id: input.id } });
    if (!fresh) return { ok: false, reason: "NOT_FOUND" };
    if (fresh.status === "APPROVED") {
      return { ok: true, alreadyApproved: true, application: { id: fresh.id, email: fresh.email } };
    }
    return { ok: false, reason: "REJECTED" };
  }

  // One live token per application: retire any prior unused token.
  await client.teacherActivationToken.updateMany({
    where: { applicationId: application.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const secret = generateToken(32);
  await client.teacherActivationToken.create({
    data: {
      applicationId: application.id,
      tokenHash: sha256(secret),
      expiresAt: new Date(Date.now() + TEACHER_ACTIVATION_TTL_HOURS * 3600 * 1000),
    },
  });

  return {
    ok: true,
    alreadyApproved: false,
    activationToken: secret,
    application: { id: application.id, email: application.email },
  };
}

// ---------------------------------------------------------------------------
// Reject (admin) — never creates a Teacher account; rescinds a live token.
// ---------------------------------------------------------------------------

export async function rejectTeacherApplication(
  input: { id: string; adminUserId: string; note?: string | null },
  client: any = db
): Promise<RejectOutcome> {
  const application = await client.teacherApplication.findUnique({
    where: { id: input.id },
  });
  if (!application) return { ok: false, reason: "NOT_FOUND" };
  if (application.status === "ACTIVATED") return { ok: false, reason: "ALREADY_ACTIVATED" };
  if (application.status === "REJECTED") return { ok: true, alreadyRejected: true };

  // From PENDING or APPROVED → REJECTED. If it was APPROVED, its activation
  // link must die with it.
  await client.teacherApplication.update({
    where: { id: application.id },
    data: {
      status: "REJECTED",
      adminNote: input.note || null,
      reviewedByUserId: input.adminUserId,
      reviewedAt: new Date(),
    },
  });
  await client.teacherActivationToken.updateMany({
    where: { applicationId: application.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return { ok: true, alreadyRejected: false };
}

// ---------------------------------------------------------------------------
// Activate (public) — the applicant sets their own password; NOW a User is born.
// ---------------------------------------------------------------------------

export async function activateTeacher(
  input: { token: string; password: string },
  client: any = db
): Promise<ActivateOutcome> {
  const record = await client.teacherActivationToken.findUnique({
    where: { tokenHash: sha256(input.token) },
    include: { application: true },
  });

  const invalid = (): ActivateOutcome => ({ ok: false, reason: "INVALID_TOKEN" });

  if (!record) return invalid();
  if (record.usedAt) return invalid();
  if (record.expiresAt.getTime() < Date.now()) {
    await client.teacherActivationToken
      .update({ where: { id: record.id }, data: { usedAt: new Date() } })
      .catch(() => {});
    return invalid();
  }
  const application = record.application;
  if (!application || application.status !== "APPROVED") return invalid();

  try {
    await client.$transaction(async (tx: any) => {
      // Single-use: consume THIS token only if still unused.
      const consumed = await tx.teacherActivationToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) throw new Error("ACTIVATION_TOKEN_CONSUMED");

      const user = await tx.user.create({
        data: {
          email: application.email,
          name: application.name,
          phone: application.phone || null,
          password: hashPassword(input.password),
          role: "TEACHER",
        },
      });

      await tx.teacher.create({
        data: {
          userId: user.id,
          bio: application.bio || null,
          specialty: application.specialty || null,
        },
      });

      await tx.teacherApplication.update({
        where: { id: application.id },
        data: { status: "ACTIVATED", userId: user.id },
      });
    });
  } catch (e: any) {
    // A lost consume race, or the email was taken between approval and
    // activation — both fail closed with the same non-informative answer.
    if (String(e?.message).includes("UNIQUE") || String(e?.code) === "P2002") {
      return { ok: false, reason: "EMAIL_CONFLICT" };
    }
    return invalid();
  }

  const activated = await client.teacherApplication.findUnique({
    where: { id: application.id },
    select: { userId: true },
  });
  return { ok: true, userId: activated?.userId ?? "" };
}
