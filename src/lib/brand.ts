// CodeMind Academy — Central Brand Configuration
// Change anything here to rebrand the entire platform.

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
    teacher: "+201000000000",
    technical: "+201000000001",
    subscription: "+201000000002",
  },
  contact: {
    email: "hello@codemind.academy",
    phone: "+20 100 000 0000",
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
  academicYear: "2024 / 2025",
} as const;

export type Brand = typeof brand;

export const whatsappLink = (number: string, message?: string) => {
  const clean = number.replace(/[^0-9]/g, "");
  const text = message ? `?text=${encodeURIComponent(message)}` : "";
  return `https://wa.me/${clean}${text}`;
};
