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

/** Translate a dict key with optional {p} interpolation. Pure & isomorphic. */
export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, unknown>
): string {
  const entry = DICT[key];
  let s = entry ? entry[locale] || entry.ar : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(v == null ? "" : String(v));
    }
  }
  return s;
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

// ---------------------------------------------------------------------------
// Calendar labels
//
// Weekday/month labels used to be referenced as bare generated key strings
// ("student.198"…) held in component-local arrays. Nothing forced a call site
// to run them through translate(), so a single missed call rendered the raw
// key to end users. Exposing *resolved strings* through these helpers removes
// that failure mode entirely: there is no key left for a component to leak.
//
// Indexes follow Date#getDay() (0 = Sunday) and Date#getMonth() (0 = January).

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Full weekday name, e.g. "Sunday" / "الأحد". `day` is Date#getDay(). */
export function weekdayName(locale: Locale, day: number): string {
  const key = DAY_KEYS[((day % 7) + 7) % 7];
  return translate(locale, `calendar.day.${key}`);
}

/** Abbreviated weekday name for narrow grid headers, e.g. "Sun" / "أحد". */
export function weekdayShortName(locale: Locale, day: number): string {
  const key = DAY_KEYS[((day % 7) + 7) % 7];
  return translate(locale, `calendar.dayShort.${key}`);
}

/** Month name, e.g. "January" / "يناير". `month` is Date#getMonth() (0-based). */
export function monthName(locale: Locale, month: number): string {
  const m = ((month % 12) + 12) % 12;
  return translate(locale, `calendar.month.${m + 1}`);
}

/** The seven weekday headers in display order, already translated. */
export function weekdayHeaders(locale: Locale, short = true): string[] {
  return DAY_KEYS.map((_, i) => (short ? weekdayShortName : weekdayName)(locale, i));
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
