// CodeMind Academy — i18n CORE (isomorphic: safe on server AND client).
// No "use client" directive here — API routes import translate() from this
// module; client hooks live in src/lib/i18n.ts.
import { DICT as GENERATED_DICT } from "@/lib/i18n-dict";
import { DICT_2026 } from "@/lib/i18n-dict-2026";

export type Locale = "ar" | "en";

// The generated catalogue plus the hand-maintained 2026/2027 additions.
// Keeping them in two files means `scripts/i18n/emit-dict.mjs` can regenerate
// i18n-dict.ts without dropping the new keys.
const DICT = { ...GENERATED_DICT, ...DICT_2026 };

/**
 * True when `s` looks like an internal flat dict key (`ns.NNN` / `ns.name`).
 * Used so a missing translation never leaks the raw key into the UI.
 */
export function looksLikeDictKey(s: string): boolean {
  return /^[a-z][a-z0-9]*(\.[A-Za-z0-9_]+)+$/.test(s);
}

/**
 * Translate a dict key with optional {p}/{p1} interpolation. Pure & isomorphic.
 *
 * Fallback order (deterministic):
 *   1. entry[locale] if non-empty
 *   2. entry.ar if non-empty (Arabic is the product default)
 *   3. entry.en if non-empty
 *   4. empty string — never the raw key (UI must not show `student.198`)
 *
 * Empty dictionary values also fall through so a blank `en: ""` does not
 * blank the UI when Arabic still has a string.
 */
export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, unknown>
): string {
  const entry = DICT[key];
  let s = "";
  if (entry) {
    const primary = entry[locale];
    const secondary = locale === "en" ? entry.ar : entry.en;
    if (typeof primary === "string" && primary.length > 0) s = primary;
    else if (typeof secondary === "string" && secondary.length > 0) s = secondary;
    else if (typeof entry.ar === "string" && entry.ar.length > 0) s = entry.ar;
    else if (typeof entry.en === "string" && entry.en.length > 0) s = entry.en;
  }
  // Last-resort: if a caller somehow passes a human string (not a key), keep it.
  // Never return a dotted internal key — that is the known Phase 9 leak mode.
  if (!s) {
    s = looksLikeDictKey(key) ? "" : key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(v == null ? "" : String(v));
    }
  }
  return s;
}

/** Whether a key exists in the merged dictionary (generated + 2026). */
export function hasDictKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(DICT, key);
}

/** Expose the merged dict size for diagnostics / tests (read-only). */
export function dictSize(): number {
  return Object.keys(DICT).length;
}

/** Pick between a data-model ar/en field pair (e.g. `titleAr` / `title`). */
export function pickL10n(
  locale: Locale,
  ar: string | null | undefined,
  en: string | null | undefined
): string {
  if (locale === "en") return (en ?? ar ?? "") as string;
  return (ar ?? en ?? "") as string;
}

const DATE_LOCALE: Record<Locale, string> = { ar: "ar-EG", en: "en-GB" };

/** Locale-aware date formatting (ar-EG vs en-GB). */
export function fmtDate(
  date: Date | string | number,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString(DATE_LOCALE[locale], options);
}

/** Locale-aware date+time formatting. */
export function fmtDateTime(
  date: Date | string | number,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleString(DATE_LOCALE[locale], options);
}

/** Apply locale globally: <html lang/dir> + persist (localStorage + cookie). */
export function applyLocale(locale: Locale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale === "ar" ? "ar" : "en";
  document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
  try {
    localStorage.setItem("cm-locale", locale);
    // Mirror to a cookie so API routes can localize server-side strings too.
    document.cookie = `cm-locale=${locale}; path=/; max-age=31536000; samesite=lax`;
  } catch {}
}

export function readStoredLocale(): Locale {
  try {
    const v = localStorage.getItem("cm-locale");
    if (v === "en" || v === "ar") return v;
  } catch {}
  return "ar";
}

/** Legacy nested strings for the few components that predate the flat dict. */
export const STRINGS = {
  ar: {
    nav: {
      why: "ليه CodeMind؟",
      curriculum: "المنهج",
      features: "المميزات",
      pricing: "الأسعار",
      faq: "الأسئلة",
      login: "تسجيل الدخول",
      startFree: "ابدأ مجاناً",
      startJourney: "ابدأ رحلتك",
      seeCurriculum: "شوف المنهج",
      backHome: "رجوع للرئيسية",
    },
    auth: {
      welcomeBack: "أهلاً بعودتك 👋",
      createAccount: "اخلق حسابك",
      loginHint: "ادخل بياناتك عشان تكمّل من حيث ما وقفت.",
      registerHint: "اختار نوع الحساب وادخل بياناتك عشان تبدأ.",
      haveAccount: "عندك حساب بالفعل؟",
      noAccount: "ماعندكش حساب؟",
      doLogin: "ادخل",
      doRegister: "اعمل حسابي",
      makeOne: "اعمل واحد",
      email: "البريد الإلكتروني",
      password: "كلمة السر",
      showPassword: "إظهار كلمة السر",
      hidePassword: "إخفاء كلمة السر",
      fullNameAr: "الاسم الكامل بالعربية (ثلاثي — مطابق للبطاقة)",
      fullName: "الاسم الكامل (ثلاثي)",
      studentPhone: "رقم تليفون الطالب",
      parentPhone: "رقم تليفون ولي الأمر",
      phone: "رقم الهاتف",
      nationalId: "الرقم القومي",
      studentNationalId: "الرقم القومي للطالب",
      studentCode: "كود الطالب",
      schoolName: "اسم المدرسة",
      schoolType: "نوع المدرسة",
      schoolTypeLang: "لغات",
      schoolTypeAr: "عربي",
      loading: "استنى شوية…",
      enter: "ادخل",
      create: "اعمل حسابي",
      contactSupport: "للدعم والتواصل",
    },
    theme: { light: "فاتح", dark: "ليلي", toggle: "تبديل الوضع" },
    lang: { label: "اللغة", ar: "العربية", en: "English" },
  },
  en: {
    nav: {
      why: "Why CodeMind?",
      curriculum: "Curriculum",
      features: "Features",
      pricing: "Pricing",
      faq: "FAQ",
      login: "Log in",
      startFree: "Start for free",
      startJourney: "Start your journey",
      seeCurriculum: "See curriculum",
      backHome: "Back to home",
    },
    auth: {
      welcomeBack: "Welcome back 👋",
      createAccount: "Create your account",
      loginHint: "Enter your details to pick up where you left off.",
      registerHint: "Pick an account type and enter your details to start.",
      haveAccount: "Already have an account?",
      noAccount: "Don't have an account?",
      doLogin: "Log in",
      doRegister: "Create account",
      makeOne: "Create one",
      email: "Email",
      password: "Password",
      showPassword: "Show password",
      hidePassword: "Hide password",
      fullNameAr: "Full name in Arabic (3 parts — as in official ID)",
      fullName: "Full name (3 parts)",
      studentPhone: "Student phone number",
      parentPhone: "Parent phone number",
      phone: "Phone number",
      nationalId: "National ID",
      studentNationalId: "Student national ID",
      studentCode: "Student code",
      schoolName: "School name",
      schoolType: "School type",
      schoolTypeLang: "Languages",
      schoolTypeAr: "Arabic",
      loading: "One moment…",
      enter: "Log in",
      create: "Create my account",
      contactSupport: "Support & contact",
    },
    theme: { light: "Light", dark: "Night", toggle: "Toggle theme" },
    lang: { label: "Language", ar: "العربية", en: "English" },
  },
} as const;

export function getStrings(locale: Locale) {
  return STRINGS[locale] || STRINGS.ar;
}
