"use client";

// CodeMind Academy — Kodgy Assistant Controller (Phase 10)
//
// Owns conversation state only: messages, input, and the local
// "thinking" state. All answers come from the deterministic scripted
// engine (src/lib/kodgy/response-engine.ts) — there is NO network call,
// NO AI API and NO server endpoint behind this hook.
//
// The ~500ms thinking delay is a lightweight local animation (not a fake
// network request): it gives the reply a natural beat and the dots a
// chance to show, while staying honest about being scripted.

import * as React from "react";
import {
  match,
  suggestedPrompts,
  type KodgyLocale,
  type LocalizedText,
} from "@/lib/kodgy/response-engine";

export interface KodgyMessage {
  id: number;
  role: "user" | "assistant";
  /** Raw user text (rendered as plain text — never HTML). */
  text: string;
  /** Bilingual answer for assistant messages (re-renders on locale switch). */
  answer?: LocalizedText;
  /** Matched intent id, for diagnostics. */
  intent?: string;
}

export const KODGY_MAX_INPUT = 500;
export const KODGY_THINKING_MS = 500;

export function useKodgyChat(locale: KodgyLocale) {
  const [messages, setMessages] = React.useState<KodgyMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [thinking, setThinking] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = React.useRef(0);

  // Always clear pending timers on unmount (no leaks / no setState-after-unmount).
  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const send = React.useCallback(
    (raw?: string) => {
      const text = (raw ?? input).trim().slice(0, KODGY_MAX_INPUT);
      if (!text || thinking) return;
      setInput("");
      idRef.current += 1;
      const userMsg: KodgyMessage = { id: idRef.current, role: "user", text };
      setMessages((m) => [...m, userMsg]);
      setThinking(true);
      timerRef.current = setTimeout(() => {
        const res = match(text); // deterministic, local, offline
        idRef.current += 1;
        const reply: KodgyMessage = {
          id: idRef.current,
          role: "assistant",
          text: "",
          answer: res.answer,
          intent: res.intent,
        };
        setMessages((m) => [...m, reply]);
        setThinking(false);
      }, KODGY_THINKING_MS);
    },
    [input, thinking]
  );

  const clear = React.useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setThinking(false);
    setMessages([]);
    setInput("");
  }, []);

  return {
    messages,
    input,
    setInput,
    thinking,
    send,
    clear,
    suggestions: suggestedPrompts(locale),
  };
}
