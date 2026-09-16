// /api/admin/question-bank/[id] — post-launch admin lifecycle for questions.
//
// The admin could CREATE bank questions (POST /api/admin/question-bank) but
// had no way to edit or remove one — a mistake stayed in the pool forever.
// This route closes that gap with the SAME frozen-history safety the teacher
// route uses (src/lib/teacher-content.ts):
//
//   GET    — the question + its REFERENCE COUNTS (frozen answers, open/graded
//            attempts, FIXED mock-exam pins) so the UI can disable a
//            destructive action instead of discovering the refusal from a 409.
//   PATCH  — safe edit; grading-relevant fields (answer/options/type/marks/
//            schoolType) are locked while any attempt references the question.
//   DELETE — refused while the question is referenced (attempt history or a
//            FIXED exam pin); the check and the delete are ONE transaction
//            behind the shared quiz destructive lock (Phase 26D protocol).
//
// AUTHORIZATION: ADMIN only, server-side (requireRole) — never UI-gated.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import {
  canDeleteQuestion,
  loadQuestionReferences,
  questionEditGuards,
  questionPayload,
  questionValidationMessage,
  validateQuestionDraft,
} from "@/lib/teacher-content";
import { acquireQuizDestructiveLock } from "@/lib/db-serialization";

async function loadQuestion(id: string) {
  const question = await db.question.findUnique({ where: { id } });
  if (!question) return null;
  const quiz = question.quizId
    ? await db.quiz.findUnique({
        where: { id: question.quizId },
        select: { id: true, title: true, titleAr: true, trackScope: true },
      })
    : null;
  return { question, quiz };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const loaded = await loadQuestion(id);
  if (!loaded) return err(tApi("api.244"), 404);

  const { references, pins } = await loadQuestionReferences(id);
  const guards = canDeleteQuestion(references);

  return ok({
    question: questionPayload(loaded.question),
    quiz: loaded.quiz,
    references,
    mockExamPins: pins,
    canDelete: guards.allowed,
    deleteBlockers: guards.blockers,
    canEditAnswerKey:
      references.openAttempts === 0 && references.gradedAttempts === 0,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const loaded = await loadQuestion(id);
  if (!loaded) return err(tApi("api.244"), 404);

  const body = await req.json().catch(() => ({}));

  // Only touched fields are candidates; `undefined` means "leave it".
  const patch: Record<string, unknown> = {};
  for (const key of [
    "type",
    "prompt",
    "promptAr",
    "options",
    "answer",
    "explanation",
    "difficulty",
    "marks",
    "schoolType",
  ] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) return err(tApi("api.244"), 400);

  const { references } = await loadQuestionReferences(id);
  const guard = questionEditGuards(references, patch);
  if (!guard.allowed) {
    return err(tApi("api.245"), 409);
  }

  const current = loaded.question;
  const merged = {
    type: patch.type ?? current.type,
    prompt: patch.prompt ?? current.prompt,
    promptAr: patch.promptAr !== undefined ? patch.promptAr : current.promptAr,
    options:
      patch.options !== undefined ? patch.options : safeOptions(current.options),
    answer: patch.answer !== undefined ? patch.answer : current.answer,
    explanation:
      patch.explanation !== undefined ? patch.explanation : current.explanation,
    difficulty: patch.difficulty ?? current.difficulty,
    marks: patch.marks ?? current.marks,
    schoolType: patch.schoolType !== undefined ? patch.schoolType : undefined,
  };

  // Bank-only questions have no owning quiz to be contained by — the free
  // bank serves both tracks and selection filters per schoolType at attempt
  // time (same semantics as POST /api/admin/question-bank, which accepts
  // ARABIC / LANGUAGE / SHARED bank questions). Passing "SHARED" for them
  // keeps the validator's fail-closed behaviour for invalid schoolType
  // inputs while not rejecting every bank-only edit.
  const validated = validateQuestionDraft(
    merged,
    loaded.quiz ? loaded.quiz.trackScope : "SHARED"
  );
  if (!validated.ok) {
    return err(questionValidationMessage(tApi, validated.reason), 400);
  }
  const v = validated.question;

  const data: Record<string, unknown> = {
    type: v.type,
    prompt: v.prompt,
    promptAr: v.promptAr,
    options: JSON.stringify(v.options),
    answer: v.answer,
    explanation: v.explanation,
    difficulty: v.difficulty,
    marks: v.marks,
  };
  // Never silently re-tag: schoolType is rewritten only when explicitly sent.
  if (patch.schoolType !== undefined) data.schoolType = v.schoolType;

  const updated = await db.question.update({ where: { id }, data });
  return ok({ question: questionPayload(updated), references });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const loaded = await loadQuestion(id);
  if (!loaded) return err(tApi("api.244"), 404);

  // Phase 26D protocol: reference check + delete in ONE transaction, with the
  // quiz destructive lock taken FIRST when the question belongs to a quiz (a
  // bank-only question has no quiz to lock; the mock-exam pin check below is
  // still transactional).
  let references;
  try {
    references = await db.$transaction(async (tx) => {
      if (loaded.quiz) {
        await acquireQuizDestructiveLock(tx, loaded.quiz.id);
      }
      const refs = await loadQuestionReferences(id, tx);
      const guard = canDeleteQuestion(refs.references);
      if (!guard.allowed) {
        throw new QuestionDeleteBlockedError(guard.blockers);
      }
      await tx.question.delete({ where: { id } });
      return refs.references;
    });
  } catch (e) {
    if (e instanceof QuestionDeleteBlockedError) {
      const fixPin = e.blockers.includes("FIXED_EXAM_PIN");
      return err(fixPin ? tApi("api.246") : tApi("api.247"), 409);
    }
    throw e;
  }

  return ok({ deleted: true, id, references });
}

/** Carries the guard's blockers out of the delete transaction. */
class QuestionDeleteBlockedError extends Error {
  readonly blockers: string[];
  constructor(blockers: string[]) {
    super(`question deletion blocked: ${blockers.join(", ")}`);
    this.name = "QuestionDeleteBlockedError";
    this.blockers = blockers;
  }
}

/** Parse a stored options blob defensively (legacy rows may be malformed). */
function safeOptions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((o) => String(o)) : [];
  } catch {
    return [];
  }
}
