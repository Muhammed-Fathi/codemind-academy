// CodeMind Academy — Safe deep-link resolution (Phase 16).
//
// THE CONTRACT
// ============
// A deep link is a SHORT, SERVER-MINTED pointer of exactly one of these forms:
//
//   lesson:<id>     → the unified session page (`student-lesson`)
//   video:<id>      → the batch recordings view (`student-session-videos`)
//   quiz:<id>       → the quiz runner (`student-quiz`)
//   homework:<id>   → the homework list, scrolled to the item (`student-homework`)
//
// A deep link is NAVIGATION, never authorization. Resolving one only decides
// which (view, navParam) pair the shell opens; every view then fetches through
// its normal API route, and every route re-authorizes server-side (auth,
// enrollment, course, track, lifecycle, progression). A deep link therefore
// cannot bypass anything — an unauthorized target renders the same locked /
// not-found state as opening it by hand.
//
// THE RULES THIS MODULE OWNS
// ==========================
//  1. PARSING IS STRICT AND FAILS CLOSED. The kind must be exactly one of the
//     four lowercase kinds, and the id must be 1–64 URL-safe characters
//     (`[A-Za-z0-9_-]`, the cuid alphabet plus `-`/`_`). Anything else —
//     unknown kinds, empty ids, slashes, dots, spaces, query strings,
//     non-strings, oversized input — yields `null`, never a best-effort guess.
//     There is deliberately no case-folding and no trimming beyond surrounding
//     whitespace: notification links are minted by the server in canonical
//     form, and anything else is treated as untrusted input.
//  2. THIS MODULE HAS NO IMPORTS. It is pure string handling, so it can be
//     unit-tested without a database, without Next, and without the zustand
//     store. Navigation is injected (`navigateDeepLink(raw, nav)`) instead of
//     importing `useApp`, for the same reason.
//  3. `setView` runs BEFORE `setNavParam`. The store's `setView` clears the
//     nav param by design, so reversing the order would drop the target id.
//     The order is asserted by the Phase 16 suite — do not "simplify" it.
//  4. Target views are plain strings that MUST stay members of `ViewKey`
//     (`src/lib/store.ts`). They are not imported as a type on purpose (see
//     rule 2); the suite pins each value against the store source instead.

/** The four deep-linkable resource kinds. Declaration order is stable. */
export const DEEP_LINK_KINDS = [
  "lesson",
  "video",
  "quiz",
  "homework",
] as const;

export type DeepLinkKind = (typeof DEEP_LINK_KINDS)[number];

export type DeepLink = {
  kind: DeepLinkKind;
  id: string;
};

/**
 * Where a deep link lands. `view` must stay a valid `ViewKey` (see rule 4);
 * `navParam` is the resource id the view fetches with its normal,
 * server-authorized API call.
 */
export type DeepLinkTarget = {
  view: string;
  navParam: string;
};

/** One kind → one landing view. Total: every kind is listed, exactly once. */
export const DEEP_LINK_VIEWS: Record<DeepLinkKind, string> = {
  lesson: "student-lesson",
  video: "student-session-videos",
  quiz: "student-quiz",
  homework: "student-homework",
};

/**
 * Resource ids are cuids in practice; the pattern additionally allows `-`
 * and `_` (uuid-shaped ids) but nothing that could escape into a path, a
 * query string, or a second deep-link segment.
 */
const DEEP_LINK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Hard cap on the whole link, so a hostile string cannot do harm by size. */
const MAX_DEEP_LINK_LENGTH = 80;

/**
 * Parse a deep link, or return `null` for anything that is not exactly one.
 * Never throws, never guesses.
 */
export function parseDeepLink(raw: unknown): DeepLink | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > MAX_DEEP_LINK_LENGTH) return null;
  const sep = text.indexOf(":");
  if (sep <= 0) return null;
  const kind = text.slice(0, sep);
  const id = text.slice(sep + 1);
  if (
    kind !== "lesson" &&
    kind !== "video" &&
    kind !== "quiz" &&
    kind !== "homework"
  ) {
    return null;
  }
  if (!DEEP_LINK_ID.test(id)) return null;
  return { kind, id };
}

/** True exactly when `parseDeepLink` would succeed. */
export function isDeepLink(raw: unknown): boolean {
  return parseDeepLink(raw) !== null;
}

/** Map an already-parsed link onto its landing view. Total over kinds. */
export function deepLinkTarget(link: DeepLink): DeepLinkTarget {
  return { view: DEEP_LINK_VIEWS[link.kind], navParam: link.id };
}

/** Parse and map in one step. `null` when the input is not a deep link. */
export function resolveDeepLink(raw: unknown): DeepLinkTarget | null {
  const link = parseDeepLink(raw);
  return link ? deepLinkTarget(link) : null;
}

/**
 * Resolve a deep link AND navigate the shell to it.
 *
 * `nav` is the store surface (`useApp.getState()`); it is injected so this
 * module stays dependency-free. Returns `true` when navigation happened and
 * `false` when the input was not a deep link (the shell is untouched).
 *
 * ORDER MATTERS: `setView` first, `setNavParam` second — `setView` resets the
 * nav param, so the reverse order would navigate to a view with no target.
 */
export function navigateDeepLink(
  raw: unknown,
  nav: {
    setView: (view: never) => void;
    setNavParam: (param: string | null) => void;
  }
): boolean {
  const target = resolveDeepLink(raw);
  if (!target) return false;
  nav.setView(target.view as never);
  nav.setNavParam(target.navParam);
  return true;
}
