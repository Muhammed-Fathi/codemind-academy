// CodeMind Academy — i18n CLIENT layer (hooks + store-bound helpers).
// Pure/isomorphic pieces live in src/lib/i18n-core.ts (importable from
// API routes); this module adds React bindings that subscribe to the
// global locale in the zustand store.
"use client";

import * as React from "react";
import { useApp } from "@/lib/store";
import {
  translate as _translate,
  type Locale,
} from "@/lib/i18n-core";

// Re-export the isomorphic surface for existing imports.
export {
  translate,
  pickL10n,
  fmtDate,
  fmtDateTime,
  applyLocale,
  readStoredLocale,
  getStrings,
  STRINGS,
} from "@/lib/i18n-core";
export type { Locale } from "@/lib/i18n-core";

import { pickL10n, fmtDate as _fmtDate, fmtDateTime as _fmtDateTime } from "@/lib/i18n-core";

/**
 * React hook: returns a translator bound to the active locale.
 * Re-renders automatically when the user toggles AR/EN.
 */
export function useT() {
  const locale = useApp((s) => s.locale);
  const loc: Locale = locale === "en" ? "en" : "ar";
  return React.useCallback(
    (key: string, params?: Record<string, unknown>) =>
      _translate(loc, key, params),
    [loc]
  );
}

/** Current locale as a reactive hook. */
export function useLocale(): Locale {
  const locale = useApp((s) => s.locale);
  return locale === "en" ? "en" : "ar";
}

/**
 * Store-reading variant for plain (non-hook) helpers and quick inline use:
 * picks the localized side of a data-model field pair based on the CURRENT
 * global locale. Components re-render on toggle (they subscribe via useT),
 * so helpers using this re-execute with fresh state.
 */
export function pickAuto(
  ar: string | null | undefined,
  en: string | null | undefined
): string {
  const locale = useApp.getState().locale;
  return pickL10n(locale === "en" ? "en" : "ar", ar, en);
}
