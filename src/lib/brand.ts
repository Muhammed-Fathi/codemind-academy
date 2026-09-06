// CodeMind Academy — Central Brand Configuration
// Change anything here to rebrand the entire platform.

// Primary support / contact line used across the whole platform
// (contact sections, WhatsApp support, and manual payment gateways).
export const SUPPORT_PHONE_DISPLAY = "+20 1147422177";
export const SUPPORT_PHONE_INTL = "+201147422177";

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
    teacher: SUPPORT_PHONE_INTL,
    technical: SUPPORT_PHONE_INTL,
    subscription: SUPPORT_PHONE_INTL,
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
