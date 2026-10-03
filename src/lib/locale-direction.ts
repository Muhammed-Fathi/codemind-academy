export type AppLocale = "ar" | "en";
export type TextDirection = "rtl" | "ltr";

/** Direction for locale-level UI chrome; content-specific fields may use `dir="auto"`. */
export function localeDirection(locale: AppLocale): TextDirection {
  return locale === "ar" ? "rtl" : "ltr";
}
