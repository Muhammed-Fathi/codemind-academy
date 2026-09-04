"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, Languages } from "lucide-react";
import { useApp } from "@/lib/store";
import { applyLocale, type Locale } from "@/lib/i18n";
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
      onClick={onClick}
      aria-label="تبديل الوضع / Toggle theme"
      title={isDark ? "Light mode" : "Dark mode"}
      className="p-2 rounded-md hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  );
}

export function LanguageToggle() {
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
        aria-label="Language / اللغة"
        className="p-2 rounded-md hover:bg-muted transition-colors"
      >
        <Languages className="w-4 h-4" />
      </button>
    );
  }

  const next: Locale = locale === "ar" ? "en" : "ar";
  return (
    <button
      onClick={() => {
        setLocale(next);
        applyLocale(next);
      }}
      aria-label={locale === "ar" ? "Switch to English" : "التبديل إلى العربية"}
      title={locale === "ar" ? "English" : "العربية"}
      className="h-8 px-2.5 rounded-md hover:bg-muted transition-colors flex items-center gap-1.5 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Languages className="w-4 h-4" />
      <span className="hidden sm:inline">{locale === "ar" ? "EN" : "عربي"}</span>
    </button>
  );
}
