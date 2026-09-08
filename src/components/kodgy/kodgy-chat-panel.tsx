"use client";

// CodeMind Academy — Kodgy chat panel (Phase 10)
//
// The conversation surface is an extension of the robot, not a generic
// chat dashboard: it carries Kodgy's identity in the header, the empty
// state and the message bubbles. All chrome strings come from the shared
// i18n dictionary (`kodgy.*`); message CONTENT comes from the scripted
// engine as bilingual text. User input is rendered as plain text nodes
// (React escapes it) — there is no dangerouslySetInnerHTML anywhere.

import * as React from "react";
import { X, Send, Trash2, RotateCcw } from "lucide-react";
import { useT, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { KodgyRobot } from "@/components/kodgy/kodgy-robot";
import type { KodgyMessage } from "@/components/kodgy/use-kodgy-chat";
import { KODGY_MAX_INPUT } from "@/components/kodgy/use-kodgy-chat";
import type { PanelGeometry } from "@/lib/kodgy/position";

export interface KodgyChatPanelProps {
  open: boolean;
  locale: Locale;
  geometry: PanelGeometry;
  messages: KodgyMessage[];
  input: string;
  onInputChange: (v: string) => void;
  thinking: boolean;
  suggestions: string[];
  onSend: (text?: string) => void;
  onClose: () => void;
  onClear: () => void;
  onResetPosition: () => void;
}

export function KodgyChatPanel({
  locale,
  geometry,
  messages,
  input,
  onInputChange,
  thinking,
  suggestions,
  onSend,
  onClose,
  onClear,
  onResetPosition,
}: KodgyChatPanelProps) {
  const t = useT();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Focus the input when the panel mounts (it only mounts while open;
  // no focus trap — Tab leaves freely).
  React.useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, []);

  // Auto-scroll on new messages / thinking state.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, thinking, open]);

  const style: React.CSSProperties = {
    maxHeight: geometry.maxHeight,
    bottom: geometry.bottom,
    ...(geometry.left != null ? { left: geometry.left } : { right: geometry.right }),
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("kodgy.001")}
      aria-live="off"
      className="kodgy-panel fixed z-[65] w-[min(92vw,26rem)] flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-background/95 shadow-2xl shadow-emerald-900/20 backdrop-blur-xl"
      style={style}
    >
      {/* header */}
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-gradient-to-r from-emerald-500/10 via-teal-500/10 to-amber-500/10 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="shrink-0 drop-shadow-[0_0_10px_rgba(52,211,153,0.55)]">
            <KodgyRobot size={34} open />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-bold">
              <span className="truncate">{t("kodgy.001")}</span>
              <span className="kodgy-status-dot h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            </div>
            <div className="truncate text-[11px] text-muted-foreground">{t("kodgy.010")}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              aria-label={t("kodgy.008")}
              title={t("kodgy.008")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t("kodgy.007")}
            title={t("kodgy.007")}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* messages */}
      <div ref={scrollRef} className="scrollbar-hide flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center px-2 py-5 text-center">
            <div className="pointer-events-none select-none drop-shadow-[0_0_18px_rgba(52,211,153,0.5)]">
              <KodgyRobot size={72} open />
            </div>
            <div className="mt-3 text-sm font-bold">{t("kodgy.003")}</div>
            <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">
              {t("kodgy.004")}
            </p>
            <div className="mt-4 w-full max-w-xs">
              <div className="mb-1.5 text-start text-[11px] font-semibold text-muted-foreground">
                {t("kodgy.011")}
              </div>
              <div className="grid gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onSend(s)}
                    className="rounded-lg border border-border/50 bg-muted/40 px-3 py-2 text-start text-xs text-foreground/90 transition-colors hover:border-emerald-400/50 hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <KodgyBubble key={m.id} message={m} locale={locale} />
            ))}
            {thinking && (
              <div className="flex items-start gap-2">
                <div className="shrink-0 drop-shadow-[0_0_8px_rgba(52,211,153,0.55)]">
                  <KodgyRobot size={26} />
                </div>
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2 rounded-2xl rounded-tl-sm bg-muted/60 px-3 py-2.5"
                >
                  <span className="flex items-center gap-1" aria-hidden="true">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="kodgy-thinking-dot h-1.5 w-1.5 rounded-full bg-emerald-500" style={{ animationDelay: `${i * 0.16}s` }} />
                    ))}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{t("kodgy.009")}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* footer + input */}
      <div className="border-t border-border/60 bg-background/90 p-2.5">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            maxLength={KODGY_MAX_INPUT}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
              if (e.key === "Escape") onClose();
            }}
            placeholder={t("kodgy.005")}
            aria-label={t("kodgy.005")}
            rows={1}
            className="min-h-[40px] max-h-[110px] flex-1 resize-none rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
          />
          <button
            type="button"
            onClick={() => onSend()}
            disabled={!input.trim() || thinking}
            aria-label={t("kodgy.006")}
            title={t("kodgy.006")}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
          >
            <Send className="h-4 w-4 flip-rtl" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <p className="text-[10px] leading-snug text-muted-foreground">{t("kodgy.014")}</p>
          <button
            type="button"
            onClick={onResetPosition}
            aria-label={t("kodgy.012")}
            title={t("kodgy.012")}
            className="flex shrink-0 items-center gap-1 rounded-md p-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            <span>{t("kodgy.012")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function KodgyBubble({ message, locale }: { message: KodgyMessage; locale: Locale }) {
  const t = useT();
  const isUser = message.role === "user";
  const text = message.answer ? (locale === "ar" ? message.answer.ar : message.answer.en) : message.text;
  return (
    <div className={cn("flex items-start gap-2", isUser && "flex-row-reverse")}>
      <div
        aria-hidden="true"
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          isUser
            ? "bg-muted-foreground/20 text-muted-foreground"
            : "drop-shadow-[0_0_7px_rgba(52,211,153,0.5)]"
        )}
      >
        {isUser ? (
          <span className="text-[10px] font-bold">{t("kodgy.015")}</span>
        ) : (
          
          <KodgyRobot size={26} />
        )}
      </div>
      <div
        className={cn(
          "max-w-[82%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2.5 text-[13px] leading-relaxed",
          isUser
            ? "rounded-tr-sm bg-emerald-600 text-white"
            : "rounded-tl-sm border border-border/50 bg-muted/50"
        )}
      >
        <span dir="auto">{text}</span>
      </div>
    </div>
  );
}
