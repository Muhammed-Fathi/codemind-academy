"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, Languages } from "lucide-react";
import { useApp } from "@/lib/store";
import { applyLocale, type Locale , useT, pickAuto } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Global theme (Light/Dark) + language (AR/EN) controls.
 * Rendered on BOTH public (landing, login, register) and authenticated
 * (dashboard header) surfaces so the toggles work before login too.
 */
export function GlobalControls({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <LanguageToggle />
      <ThemeToggleButton />
    </div>
  );
}

/** True on the client after hydration, false during SSR (no setState needed). */
function useMounted() {
  return React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

export function ThemeToggleButton() {
  const t = useT();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const storeTheme = useApp((s) => s.theme);
  const toggleStore = useApp((s) => s.toggleTheme);
  const mounted = useMounted();

  // Keep zustand store in sync with next-themes (dashboard legacy code
  // still reads useApp theme), and hydrate from persisted value.
  React.useEffect(() => {
    if (!mounted) return;
    const active = resolvedTheme || theme || storeTheme;
    if (typeof document !== "undefined" && active) {
      document.documentElement.classList.toggle("dark", active === "dark");
    }
  }, [mounted, theme, resolvedTheme, storeTheme]);

  const isDark = mounted
    ? (resolvedTheme || theme) === "dark"
    : storeTheme === "dark";

  const onClick = () => {
    const next = isDark ? "light" : "dark";
    try {
      setTheme(next);
    } catch {}
    // Sync legacy store if it disagrees.
    if ((useApp.getState().theme || "light") !== next) toggleStore();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("app.007")}
      title={t("app.007")}
      className="p-2 rounded-md hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {isDark ? (
        <Sun className="w-4 h-4" aria-hidden="true" />
      ) : (
        <Moon className="w-4 h-4" aria-hidden="true" />
      )}
    </button>
  );
}

export function LanguageToggle() {
  const t = useT();
  const locale = useApp((s) => s.locale);
  const setLocale = useApp((s) => s.setLocale);
  const mounted = useMounted();

  React.useEffect(() => {
    // Hydrate locale on first mount (persisted store may not have rehydrated yet).
    // Writes to the external zustand store + DOM only — no local setState.
    try {
      const stored = localStorage.getItem("cm-locale") as Locale | null;
      if ((stored === "ar" || stored === "en") && stored !== useApp.getState().locale) {
        useApp.getState().setLocale(stored);
      } else {
        applyLocale(useApp.getState().locale || "ar");
      }
    } catch {}
  }, []);

  if (!mounted) {
    return (
      <button
        type="button"
        aria-label={t("app.008")}
        className="p-2 rounded-md hover:bg-muted transition-colors"
      >
        <Languages className="w-4 h-4" aria-hidden="true" />
      </button>
    );
  }

  const next: Locale = locale === "ar" ? "en" : "ar";
  // Target-language labels: when UI is Arabic, offer "EN"/"English"; when
  // English, offer the Arabic label (app.009/010/011). This is intentional
  // bilingual UX so the control itself is readable in the destination language.
  const switchLabel = locale === "ar" ? "Switch to English" : t("app.009");
  const switchTitle = locale === "ar" ? "English" : t("app.010");
  const switchShort = locale === "ar" ? "EN" : t("app.011");
  return (
    <button
      type="button"
      onClick={() => {
        setLocale(next);
        applyLocale(next);
      }}
      aria-label={switchLabel}
      title={switchTitle}
      className="h-8 px-2.5 rounded-md hover:bg-muted transition-colors flex items-center gap-1.5 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Languages className="w-4 h-4" aria-hidden="true" />
      <span className="hidden sm:inline">{switchShort}</span>
    </button>
  );
}
