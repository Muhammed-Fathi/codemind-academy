// CodeMind Academy — AI Assistant Chat API
// Backend-only. Uses z-ai-web-dev-sdk LLM with a CodeMind-tutor system prompt.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";

// In-memory conversation store keyed by sessionId (good enough for MVP).
// Persist across hot-reloads via globalThis.
type Msg = { role: "user" | "assistant"; content: string };
type Conversation = {
  userId: string;
  messages: Msg[];
  updatedAt: number;
};
const store = (globalThis as any).__cm_ai_convos ?? new Map<string, Conversation>();
(globalThis as any).__cm_ai_convos = store;

const MAX_HISTORY = 12; // keep last N messages per session

const SYSTEM_PROMPT = `إنت "CodeMind Assistant" — مساعد ذكاء اصطناعي لمنصة CodeMind Academy التعليمية.

دورك:
- تساعد طلاب الثانوية العامة (الصف الثاني) في فهم Programming & AI.
- تشرح المفاهيم Programming و Artificial Intelligence و Machine Learning و Neural Networks و LLMs.
- تجاوب على أسئلة الطلاب بطريقة بسيطة، مصرية لو طلب الطالب، أو MSA لو فضل.
- دايماً خليك مشجّع، صبور، وواضح.
- استخدم أمثلة كود برمجي متى ما كان مناسب (في code blocks).
- لو السؤال خارج نطاق Programming & AI، ردّ بلطف واطلب من الطالب يبقى في النطاق.

قواعد الرد:
- لو السؤال تقني، اشرحه بشكل عملي بأمثلة.
- لو السؤال عن المنهج، اشرح إزاي الـTopic ده بيفرق في حياته.
- لو الطالب محتاج مساعدة في Quiz أو Homework، ساعده بس متديش الجواب مباشرةً لو هو quiz — وجاوبه بطريقة تخليه يفكر.
- خلي الرد قصير ومرتب (paragraphs قصيرة + bullets لو محتاج).
- Technical terms ابقيها بالإنجليزي زي ما هي (Programming, AI, Quiz, Lesson, Neural Network, etc.).`;

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const { message, sessionId } = body as { message?: string; sessionId?: string };
  if (!message || typeof message !== "string")
    return err("Message is required", 400);

  const sid = sessionId || user.id;
  let convo = store.get(sid);
  if (!convo || convo.userId !== user.id) {
    convo = { userId: user.id, messages: [], updatedAt: Date.now() };
    store.set(sid, convo);
  }

  // Append user message
  convo.messages.push({ role: "user", content: message });

  // Trim history to last MAX_HISTORY messages
  if (convo.messages.length > MAX_HISTORY) {
    convo.messages = convo.messages.slice(-MAX_HISTORY);
  }

  // Build LLM messages: system + history
  const llmMessages: any[] = [
    { role: "assistant", content: SYSTEM_PROMPT },
    ...convo.messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  ];

  try {
    // Imported lazily: a top-level import of the SDK runs its initialisation
    // during Next.js build-time page-data collection, which fails outside the
    // sandbox. Loading it here keeps it strictly request-time.
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: llmMessages,
      thinking: { type: "disabled" },
    });
    const reply =
      completion?.choices?.[0]?.message?.content ||
      "معلش، مقدرتش أجاوب دلوقتي. حاول تاني.";

    // Append assistant reply to history
    convo.messages.push({ role: "assistant", content: reply });
    if (convo.messages.length > MAX_HISTORY) {
      convo.messages = convo.messages.slice(-MAX_HISTORY);
    }
    convo.updatedAt = Date.now();

    return ok({ reply, sessionId: sid });
  } catch (e: any) {
    console.error("[AI chat error]", e);
    return err("حصلت مشكلة في الـAI. حاول تاني.", 500);
  }
}

// GET /api/ai/chat?sessionId=... — returns conversation history
export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const url = new URL(req.url);
  const sid = url.searchParams.get("sessionId") || user.id;
  const convo = store.get(sid);
  return ok({
    sessionId: sid,
    messages: convo?.messages || [],
  });
}

// DELETE /api/ai/chat?sessionId=... — clears conversation
export async function DELETE(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const url = new URL(req.url);
  const sid = url.searchParams.get("sessionId") || user.id;
  store.delete(sid);
  return ok({ ok: true });
}
