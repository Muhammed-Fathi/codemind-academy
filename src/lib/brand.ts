// CodeMind Academy — Central Brand Configuration
// Change anything here to rebrand the entire platform.

// Primary support / contact line used across the whole platform
// (contact sections, WhatsApp support, and manual payment gateways).
export const SUPPORT_PHONE_DISPLAY = "+20 1147422177";
export const SUPPORT_PHONE_INTL = "+201147422177";

// ---------------------------------------------------------------------------
// Post-launch support roster (single source of truth).
//
// Every support surface — the landing footer, the auth pages and the
// dashboard "need help?" card — reads its people/numbers from HERE, so a
// contact change is a one-line edit and no view can drift out of sync.
//
//   * Eng. Abdelrahman Mohamed (01099942942) — technical + subscription support.
//   * Eng. Muhammed Fathi (01147422177)      — teacher/academic support line.
//     This is the SAME line as SUPPORT_PHONE_DISPLAY (kept unchanged on
//     purpose: it is pinned by the payment-proof contract in payment-ux.ts).
// ---------------------------------------------------------------------------
export type SupportContact = {
  /** Stable key used by support surfaces to pick the right person. */
  id: "technical" | "teacher" | "subscription";
  /** Display name (English — rendered LTR inside the Arabic UI). */
  name: string;
  /** Local Egyptian format shown to users. */
  phoneDisplay: string;
  /** International format for tel:/wa.me links. */
  phoneIntl: string;
};

export const SUPPORT_CONTACTS = {
  technical: {
    id: "technical",
    name: "Eng. Abdelrahman Mohamed",
    phoneDisplay: "01099942942",
    phoneIntl: "+201099942942",
  },
  teacher: {
    id: "teacher",
    name: "Eng. Muhammed Fathi",
    phoneDisplay: "01147422177",
    phoneIntl: SUPPORT_PHONE_INTL,
  },
  subscription: {
    id: "subscription",
    name: "Eng. Abdelrahman Mohamed",
    phoneDisplay: "01099942942",
    phoneIntl: "+201099942942",
  },
} as const satisfies Record<string, SupportContact>;

/** Both distinct support people, in display order (technical first). */
export const SUPPORT_PEOPLE: readonly SupportContact[] = [
  SUPPORT_CONTACTS.technical,
  SUPPORT_CONTACTS.teacher,
];

/** `tel:` href for any stored phone format. */
export const telLink = (phone: string) =>
  `tel:${phone.replace(/[^+0-9]/g, "")}`;

export const brand = {
  name: "CodeMind Academy",
  shortName: "CodeMind",
  tagline: "Learn. Build. Think.",
  taglineAr: "اتعلم. ابنى. فكّر.",
  description:
    "منصة تعليمية متخصصة في Programming & AI لطلاب الثانوية العامة - الصف الثاني.",
  logoUrl: "/logo.svg",
  primaryColor: "#10b981", // emerald-500
  secondaryColor: "#f59e0b", // amber-500
  accentColor: "#14b8a6", // teal-500
  whatsapp: {
    // Post-launch roster: technical + subscription support moved to
    // Eng. Abdelrahman Mohamed (01099942942); the teacher/academic line
    // stays Eng. Muhammed Fathi (01147422177). Source of truth:
    // SUPPORT_CONTACTS below — these three fields mirror it for existing
    // callers of brand.whatsapp.*.
    teacher: SUPPORT_CONTACTS.teacher.phoneIntl,
    technical: SUPPORT_CONTACTS.technical.phoneIntl,
    subscription: SUPPORT_CONTACTS.subscription.phoneIntl,
  },
  payments: {
    instapay: SUPPORT_PHONE_DISPLAY,
    eCash: SUPPORT_PHONE_DISPLAY,
    // Vodafone Cash is temporarily disabled (Coming Soon).
    vodafoneCash: null as string | null,
  },
  contact: {
    email: "hello@codemind.academy",
    phone: SUPPORT_PHONE_DISPLAY,
    address: "Cairo, Egypt",
  },
  social: {
    facebook: "https://facebook.com/codemind",
    instagram: "https://instagram.com/codemind",
    youtube: "https://youtube.com/@codemind",
    telegram: "https://t.me/codemind",
  },
  currency: "EGP",
  defaultPrice: 200,
  academicYear: "2026 / 2027",
} as const;

export type Brand = typeof brand;

export const whatsappLink = (number: string, message?: string) => {
  const clean = number.replace(/[^0-9]/g, "");
  const text = message ? `?text=${encodeURIComponent(message)}` : "";
  return `https://wa.me/${clean}${text}`;
};
