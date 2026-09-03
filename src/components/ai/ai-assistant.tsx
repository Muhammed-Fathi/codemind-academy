"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Sparkles,
  X,
  Send,
  Bot,
  User as UserIcon,
  Trash2,
  Loader2,
} from "lucide-react";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "اشرحلي إيه هو الـMachine Learning؟",
  "إزاي أبدأ أتعلم Programming؟",
  "إيه الفرق بين Supervised و Unsupervised Learning؟",
  "اعرف أكتر عن Neural Networks",
];

export function AiAssistant() {
  const user = useApp((s) => s.user);
  const view = useApp((s) => s.view);
  const [open, setOpen] = React.useState(false);
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Don't show the assistant on landing/login/register (no auth context)
  const hideOn = ["landing", "login", "register"];
  const shouldHide = !user || hideOn.includes(view);

  // Load history on mount (when user logs in)
  React.useEffect(() => {
    if (!user) {
      setMessages([]);
      setSessionId(null);
      return;
    }
    fetch("/api/ai/chat")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.messages?.length) {
          setMessages(d.messages);
          setSessionId(d.sessionId);
        }
      })
      .catch(() => {});
  }, [user]);

  // Auto-scroll to bottom when messages change
  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, loading, open]);

  const send = async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || loading) return;
    setInput("");
    const next = [...messages, { role: "user" as const, content: msg }];
    setMessages(next);
    setLoading(true);
    try {
      const r = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, sessionId }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || "حصلت مشكلة في الإرسال");
        return;
      }
      setMessages((m) => [...m, { role: "assistant", content: d.reply }]);
      if (d.sessionId) setSessionId(d.sessionId);
    } catch {
      toast.error("مفيش اتصال بالـAI. حاول تاني.");
    } finally {
      setLoading(false);
    }
  };

  const clear = async () => {
    if (sessionId) {
      await fetch(`/api/ai/chat?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
    setMessages([]);
    setSessionId(null);
    toast.success("اتمسحت المحادثة");
  };

  if (shouldHide) return null;

  return (
    <>
      {/* Floating button */}
      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.3, type: "spring", stiffness: 260, damping: 20 }}
        className="fixed bottom-5 left-5 z-50"
      >
        <motion.button
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.94 }}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "relative w-14 h-14 rounded-full shadow-xl flex items-center justify-center text-white",
            "bg-gradient-to-br from-primary via-teal-500 to-amber-500",
            "ring-4 ring-background"
          )}
          aria-label="CodeMind AI Assistant"
        >
          <AnimatePresence mode="wait">
            {open ? (
              <motion.span
                key="x"
                initial={{ rotate: -90, opacity: 0 }}
                animate={{ rotate: 0, opacity: 1 }}
                exit={{ rotate: 90, opacity: 0 }}
              >
                <X className="w-6 h-6" />
              </motion.span>
            ) : (
              <motion.span
                key="bot"
                initial={{ rotate: 90, opacity: 0 }}
                animate={{ rotate: 0, opacity: 1 }}
                exit={{ rotate: -90, opacity: 0 }}
              >
                <Sparkles className="w-6 h-6" />
              </motion.span>
            )}
          </AnimatePresence>
          {!open && (
            <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-400 ring-2 ring-background animate-pulse" />
          )}
        </motion.button>
      </motion.div>

      {/* Panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="fixed bottom-24 left-5 z-50 w-[min(92vw,26rem)] h-[min(70vh,32rem)] flex flex-col glass-strong rounded-2xl shadow-2xl border border-border/60 overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/60 bg-gradient-to-r from-primary/10 via-teal-500/10 to-amber-500/10">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-amber-500 flex items-center justify-center text-white">
                  <Bot className="w-4.5 h-4.5" />
                </div>
                <div>
                  <div className="text-sm font-bold flex items-center gap-1.5">
                    CodeMind Assistant
                    <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Programming & AI Tutor
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {messages.length > 0 && (
                  <button
                    onClick={clear}
                    className="p-1.5 rounded-md hover:bg-muted/60 text-muted-foreground hover:text-destructive transition-colors"
                    title="امسح المحادثة"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="p-1.5 rounded-md hover:bg-muted/60 text-muted-foreground transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-3 py-3 space-y-3 scrollbar-hide"
            >
              {messages.length === 0 && (
                <div className="text-center py-6 space-y-4">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary/20 to-amber-400/20 flex items-center justify-center mx-auto">
                    <Sparkles className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <div className="text-sm font-bold">أهلاً! أنا CodeMind Assistant 👋</div>
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed max-w-xs mx-auto">
                      اسألني أي حاجة عن Programming & AI، Quizzes، Homework، أو
                      الـLessons. أنا هنا أساعدك تتعلم أسرع.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 max-w-xs mx-auto">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => send(s)}
                        className="text-right text-xs px-3 py-2 rounded-lg bg-muted/50 hover:bg-primary/10 hover:text-primary border border-border/40 transition-colors"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((m, i) => (
                <MessageBubble key={i} role={m.role} content={m.content} />
              ))}

              {loading && (
                <div className="flex items-start gap-2">
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary to-amber-500 flex items-center justify-center text-white shrink-0">
                    <Bot className="w-3.5 h-3.5" />
                  </div>
                  <div className="bg-muted/60 rounded-2xl px-3 py-2.5 flex items-center gap-1.5">
                    {[0, 1, 2].map((d) => (
                      <motion.span
                        key={d}
                        className="w-1.5 h-1.5 rounded-full bg-muted-foreground"
                        animate={{ opacity: [0.3, 1, 0.3] }}
                        transition={{
                          duration: 1,
                          repeat: Infinity,
                          delay: d * 0.15,
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Input */}
            <div className="border-t border-border/60 p-2.5 bg-background/80 backdrop-blur-sm">
              <div className="flex items-end gap-2">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder="اكتب سؤالك..."
                  className="min-h-[40px] max-h-[120px] resize-none text-sm bg-muted/40 border-0 focus-visible:ring-1 focus-visible:ring-primary"
                  rows={1}
                />
                <Button
                  size="icon"
                  onClick={() => send()}
                  disabled={!input.trim() || loading}
                  className="shrink-0 h-10 w-10 rounded-xl bg-gradient-to-br from-primary to-teal-500 hover:opacity-90"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 flip-rtl" />
                  )}
                </Button>
              </div>
              <div className="text-[10px] text-muted-foreground mt-1.5 text-center">
                CodeMind Assistant · ممكن يغلط، اتأكد من المعلومات المهمة.
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function MessageBubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const isUser = role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("flex items-start gap-2", isUser && "flex-row-reverse")}
    >
      <div
        className={cn(
          "w-7 h-7 rounded-full flex items-center justify-center text-white shrink-0",
          isUser
            ? "bg-muted-foreground"
            : "bg-gradient-to-br from-primary to-amber-500"
        )}
      >
        {isUser ? (
          <UserIcon className="w-3.5 h-3.5" />
        ) : (
          <Bot className="w-3.5 h-3.5" />
        )}
      </div>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words",
          isUser
            ? "bg-primary text-primary-foreground rounded-tr-sm"
            : "bg-muted/60 rounded-tl-sm"
        )}
      >
        {renderContent(content)}
      </div>
    </motion.div>
  );
}

// Light markdown rendering: code blocks + bold + bullets
function renderContent(text: string) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((p, i) => {
    if (p.startsWith("```")) {
      const code = p.replace(/^```\w*\n?/, "").replace(/```$/, "");
      return (
        <pre
          key={i}
          dir="ltr"
          className="my-2 p-3 rounded-lg bg-background/80 border border-border/60 text-xs font-mono overflow-x-auto"
        >
          <code>{code}</code>
        </pre>
      );
    }
    return <span key={i}>{p}</span>;
  });
}
