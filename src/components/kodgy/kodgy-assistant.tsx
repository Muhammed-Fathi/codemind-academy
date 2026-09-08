"use client";

// CodeMind Academy — Kodgy floating AI assistant (Phase 10)
//
// Lantern on the structure:
//
//   Kodgy UI (this file + kodgy-robot + kodgy-chat-panel)
//      ↓
//   Kodgy Assistant Controller (use-kodgy-chat.ts)
//      ↓
//   Scripted Response Engine (src/lib/kodgy/response-engine.ts)
//      ↓
//   Matched Response
//
// Key product behaviors:
//   * Arabic locale  → Kodgy docks on the LEFT side of the screen.
//   * English locale → Kodgy docks on the RIGHT side.
//   * The user can drag Kodgy anywhere; the position is clamped to the
//     visible viewport and persisted per-locale in localStorage.
//   * No network, no AI API, no server endpoint — the assistant is fully
//     scripted in this phase.

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useApp } from "@/lib/store";
import { useT, useLocale } from "@/lib/i18n";
import { KodgyRobot } from "@/components/kodgy/kodgy-robot";
import { KodgyChatPanel } from "@/components/kodgy/kodgy-chat-panel";
import { useKodgyChat } from "@/components/kodgy/use-kodgy-chat";
import {
  clampPos,
  defaultPos,
  panelGeometry,
  posFromPointer,
  robotBox,
  robotHeight,
  robotSizeFor,
  defaultEdge,
  type KodgyPos,
  type Viewport,
} from "@/lib/kodgy/position";

const STORAGE_KEY = "cm-kodgy-pos";
const DRAG_THRESHOLD = 6;

type StoredPositions = Record<"ar" | "en", KodgyPos>;

function readStoredPositions(): StoredPositions | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPositions>;
    if (!parsed || typeof parsed !== "object") return null;
    const num = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;
    const pos = (v: unknown, fallback: KodgyPos): KodgyPos => {
      const p = (v ?? {}) as Partial<KodgyPos>;
      return { x: num(p.x, fallback.x), y: num(p.y, fallback.y) };
    };
    return {
      ar: pos(parsed.ar, defaultPos("ar")),
      en: pos(parsed.en, defaultPos("en")),
    };
  } catch {
    return null;
  }
}

function writeStoredPositions(positions: StoredPositions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    /* storage unavailable (private mode) — position just won't persist */
  }
}

export function KodgyAssistant() {
  const t = useT();
  const locale = useLocale();
  const user = useApp((s) => s.user);
  const view = useApp((s) => s.view);

  const [open, setOpen] = React.useState(false);
  const [viewport, setViewport] = React.useState<Viewport>(() =>
    typeof window === "undefined" ? { width: 1440, height: 900 } : { width: window.innerWidth, height: window.innerHeight }
  );
  const [positions, setPositions] = React.useState<StoredPositions>(() => {
    const stored = readStoredPositions();
    return { ar: stored?.ar ?? defaultPos("ar"), en: stored?.en ?? defaultPos("en") };
  });
  const [dragging, setDragging] = React.useState(false);

  const chat = useKodgyChat(locale);
  const robotRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    moved: boolean;
  } | null>(null);
  const didDragRef = React.useRef(false);

  const reducedMotion = useReducedMotion();

  // Hide on public surfaces only — same rule as the previous assistant
  // (landing/login/register have no auth context).
  const hideOn = ["landing", "login", "register"];
  const shouldHide = !user || hideOn.includes(view);

  // Re-anchor on locale change: x is measured from the locale-default edge
  // (Arabic → LEFT, English → RIGHT), so switching language moves Kodgy to
  // the required side automatically while keeping the user's saved offsets.
  const pos = clampPos(positions[locale], viewport, robotSizeFor(viewport));

  // Track viewport changes and re-clamp (keeps Kodgy reachable on resize/
  // rotation/mobile browser chrome changes).
  React.useEffect(() => {
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  // Escape closes the panel (no keyboard trap — Tab leaves normally).
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const resetPosition = React.useCallback(() => {
    setPositions((prev) => {
      const next = { ...prev, [locale]: defaultPos(locale) };
      writeStoredPositions(next);
      return next;
    });
  }, [locale]);

  // ------------------------------------------------------------------
  // Pointer dragging (mouse + touch). Click without movement opens Kodgy.
  // ------------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = robotRef.current;
    if (!el) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const size = robotSizeFor(viewport);
    const box = robotBox(pos, viewport, size, locale);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: box.left,
      startTop: box.top,
      moved: false,
    };
    didDragRef.current = false;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!d.moved) {
      d.moved = true;
      didDragRef.current = true;
      setDragging(true);
    }
    const size = robotSizeFor(viewport);
    e.preventDefault();
    const next = posFromPointer(d.startLeft + dx, d.startTop + dy, viewport, size, locale);
    setPositions((prev) => ({ ...prev, [locale]: next }));
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (!d.moved) return; // pointerup without movement → click handler toggles
    // Persist the dragged position (already applied to state).
    setPositions((prev) => {
      writeStoredPositions(prev);
      return prev;
    });
  };

  const onToggle = () => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    setOpen((o) => !o);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen((o) => !o);
    }
  };

  if (shouldHide) return null;

  const size = robotSizeFor(viewport);
  const box = robotBox(pos, viewport, size, locale);
  const side = defaultEdge(locale);
  const panelW = Math.min(viewport.width - 24, 416);
  const panelH = Math.min(viewport.height - 96, 544);
  const geometry = panelGeometry(pos, viewport, locale, panelW, panelH);

  return (
    <>
      {/* Robot — the visual anchor */}
      <div
        ref={robotRef}
        role="button"
        tabIndex={0}
        aria-label={`${t("kodgy.002")} — ${t("kodgy.013")}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="kodgy-panel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        className={`kodgy-anchor kodgy-float fixed z-[60] select-none outline-none focus-visible:ring-4 focus-visible:ring-emerald-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-full ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        style={{ left: box.left, top: box.top, width: size, height: robotHeight(size), touchAction: "none" }}
        data-kodgy-side={side}
        data-kodgy-locale={locale}
        data-kodgy-open={open ? "true" : "false"}
        data-kodgy-dragging={dragging ? "true" : "false"}
      >
        <div
          className={`kodgy-robot-stage transition-transform duration-200 ${
            dragging ? "scale-105" : ""
          }`}
        >
          <KodgyRobot size={size} open={open} dragging={dragging} />
        </div>
      </div>

      {/* Chat panel — always in the DOM while visible for a11y/focus flow */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="kodgy-panel"
            id="kodgy-panel"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.97 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="kodgy-panel-motion"
          >
            <KodgyChatPanel
              open={open}
              locale={locale}
              geometry={geometry}
              messages={chat.messages}
              input={chat.input}
              onInputChange={chat.setInput}
              thinking={chat.thinking}
              suggestions={chat.suggestions}
              onSend={chat.send}
              onClose={() => setOpen(false)}
              onClear={chat.clear}
              onResetPosition={resetPosition}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
