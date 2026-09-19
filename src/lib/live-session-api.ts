// CodeMind Academy — Phase F route plumbing.
//
// Every live-session / absence route needs the same three things: the actor
// (with the teacher scope resolved from the DATABASE, never from the request),
// a uniform error translation, and a role-aware scope guard. Keeping them here
// means the routes stay thin and — more importantly — that a route can never
// disagree with another one about what an actor is allowed to see.

import { NextResponse } from "next/server";
import { AbsenceError } from "@/lib/absence-review";
import { LiveSessionError, loadTeacherScope, type TeacherScope } from "@/lib/live-sessions";
import type { Role } from "@prisma/client";

export type Actor = {
  userId: string;
  role: Role;
  /** Present for TEACHER actors only; resolved from Teacher.groups. */
  scope?: TeacherScope | null;
};

export class ApiFailure extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Resolve a TEACHER actor's scope; refuses a user without a teacher profile. */
export async function requireTeacherActor(user: { id: string; role: Role }): Promise<Actor> {
  const scope = await loadTeacherScope(user.id);
  if (!scope) throw new ApiFailure(404, "TEACHER_NOT_FOUND", "Teacher profile not found");
  return { userId: user.id, role: "TEACHER", scope };
}

export function adminActor(user: { id: string; role: Role }): Actor {
  return { userId: user.id, role: "ADMIN" };
}

export function studentActor(user: { id: string; role: Role }): Actor {
  return { userId: user.id, role: "STUDENT" };
}

export function parentActor(user: { id: string; role: Role }): Actor {
  return { userId: user.id, role: "PARENT" };
}

/**
 * Translate a service-layer failure into the API's only error shape:
 * `{ error, code, details? }`, with the domain code preserved so the UI can
 * show the right Arabic message (and the tests can assert the contract).
 */
export function failureResponse(error: unknown): NextResponse {
  if (error instanceof LiveSessionError) {
    return NextResponse.json(
      { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) },
      { status: error.status }
    );
  }
  if (error instanceof AbsenceError) {
    return NextResponse.json(
      { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) },
      { status: error.status }
    );
  }
  if (error instanceof ApiFailure) {
    return NextResponse.json(
      { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) },
      { status: error.status }
    );
  }
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

/** `parseBody` with an empty-object fallback (never throws on a bad body). */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A bounded integer query param. */
export function intParam(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** A bounded date query param (returns undefined when absent/invalid). */
export function dateParam(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
