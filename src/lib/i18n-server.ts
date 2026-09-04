// Server-side i18n helper for API routes.
// Reads the cm-locale cookie (kept in sync by the client in applyLocale /
// the zustand setLocale action) and returns a translator bound to it.
import { cookies } from "next/headers";
import { translate, type Locale } from "@/lib/i18n-core";

export const LOCALE_COOKIE = "cm-locale";

export async function serverLocale(): Promise<Locale> {
  try {
    const c = await cookies();
    return c?.get(LOCALE_COOKIE)?.value === "en" ? "en" : "ar";
  } catch {
    return "ar";
  }
}

/** Translator bound to the request locale. */
export async function getServerT() {
  const loc = await serverLocale();
  return (key: string, params?: Record<string, unknown>) =>
    translate(loc, key, params);
}

/** Pick the right side of a data-model ar/en pair on the server. */
export function serverPick(
  loc: Locale,
  ar: string | null | undefined,
  en: string | null | undefined
): string {
  return loc === "en" ? (en ?? ar ?? "") : (ar ?? en ?? "");
}
