// CodeMind Academy — Shared registration validation + student-code helpers.
// Used by both the API routes and client-side forms so rules stay in sync.

export const SUPPORT_PHONE_DISPLAY = "+20 1147422177";
export const SUPPORT_PHONE_DIGITS = "201147422177";

/**
 * Normalize an Egyptian phone to a canonical comparable form.
 * Local format (01147422177) and international format (+20 1147422177)
 * both collapse to the same digits so parent/student matching works
 * regardless of how each side typed the number.
 */
export function normalizePhone(phone: string): string {
  let d = (phone || "").replace(/[^0-9]/g, "");
  if (/^01[0-9]{9}$/.test(d)) d = `2${d}`; // 011… → 2011…
  return d;
}

/** Valid Egyptian mobile: 11 digits starting with 01, or 12 digits starting with 201. */
export function isValidEgyptianPhone(phone: string): boolean {
  const d = normalizePhone(phone);
  if (/^01[0-9]{9}$/.test(d)) return true;
  if (/^201[0-9]{9}$/.test(d)) return true;
  if (/^\+?201[0-9]{9}$/.test(phone.replace(/[\s-]/g, ""))) return true;
  return false;
}

/** Egyptian National ID: exactly 14 digits. */
export function isValidNationalId(id: string): boolean {
  return /^[0-9]{14}$/.test((id || "").trim());
}

const ARABIC_RE = /[\u0600-\u06FF]/;

/** Student full name: strictly three Arabic parts (matching official ID). */
export function isValidArabicThreePartName(name: string): boolean {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 3) return false;
  // Every part must contain at least one Arabic letter and be >= 2 chars.
  return parts.every((p) => p.length >= 2 && ARABIC_RE.test(p));
}

/** Parent full name: strictly three parts (Arabic or Latin letters). */
export function isValidThreePartName(name: string): boolean {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length >= 2 && /[\u0600-\u06FFA-Za-z]/.test(p));
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email || "").trim());
}

// ---------------------------------------------------------------------------
// Student Code — standard readable format: CM-XXXXXX
// (6 uppercase alphanumerics, unambiguous chars only: no 0/O, 1/I confusion)
// ---------------------------------------------------------------------------
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function buildStudentCode(randomPart: string): string {
  return `CM-${randomPart.toUpperCase()}`;
}

export function randomCodePart(length = 6): string {
  let out = "";
  // Use Math.random on the client; crypto on the server when available.
  const g: any = typeof globalThis !== "undefined" ? (globalThis as any).crypto : null;
  if (g?.getRandomValues) {
    const buf = new Uint32Array(length);
    g.getRandomValues(buf);
    for (let i = 0; i < length; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    return out;
  }
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

export function generateStudentCode(): string {
  return buildStudentCode(randomCodePart(6));
}

export function isValidStudentCode(code: string): boolean {
  // Accept any 6-char alphanumeric suffix (generated codes use the
  // unambiguous subset, but hand-entered / legacy codes may contain 0/1).
  return /^CM-[A-Z0-9]{6}$/i.test((code || "").trim());
}
