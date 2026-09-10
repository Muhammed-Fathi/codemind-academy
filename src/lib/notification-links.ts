// CodeMind Academy — Notification link scheme (Phase 17).
//
// THE CONTRACT
// ============
// A notification `link` is either NULL or a VALIDATED deep link in exactly
// one of these forms (the Phase 16 scheme — this module OWNS the
// notification-side minting and validation; `src/lib/deep-link.ts` owns the
// client-side parsing and navigation):
//
//   lesson:<id>     → the unified session page
//   video:<id>      → the batch recordings view
//   quiz:<id>       → the quiz runner
//   homework:<id>   → the homework list, scrolled to the item
//
// THE RULES THIS MODULE OWNS
// ==========================
//  1. NO ARBITRARY STRINGS. An external URL (`https://…`), a protocol-relative
//     URL (`//…`), a path (`/admin/…`), a javascript: payload, an unknown
//     scheme, a malformed id — all REJECTED. A notification link can only
//     ever point at one of the four in-app resources, by id.
//  2. VALIDATION IS PARSE-EXACT. `validateNotificationLink` accepts only what
//     `parseDeepLink` accepts (the Phase 16 strict parser), so a link the
//     server stores is a link the client can navigate. There is one parser,
//     in one module, used by both sides.
//  3. MINTING IS CANONICAL. `mintNotificationLink` builds the store form; it
//     returns null for a bogus id rather than emitting a link that would be
//     rejected later.
//  4. A LINK IS NEVER AUTHORIZATION. Storing a valid link means "this pointer
//     is well-formed", not "this user may open it". Every destination
//     enforces enrollment / course / track / lifecycle / progression
//     server-side when the client fetches it (Phases 4/12/13/16).
//  5. LIKE deep-link.ts, THIS MODULE PERFORMS NO I/O and imports only the
//     pure parser, so server routes and the test-suite compile it without a
//     database, Next, or the store.

import {
  DEEP_LINK_KINDS,
  deepLinkTarget,
  isDeepLink,
  parseDeepLink,
  resolveDeepLink,
  type DeepLink,
  type DeepLinkKind,
  type DeepLinkTarget,
} from "@/lib/deep-link";

// Re-export the client-side surface so notification consumers have ONE import
// site for the scheme (`import { parseDeepLink } from "@/lib/notification-links"`).
export {
  DEEP_LINK_KINDS,
  deepLinkTarget,
  isDeepLink,
  parseDeepLink,
  resolveDeepLink,
};
export type { DeepLink, DeepLinkKind, DeepLinkTarget };

/**
 * Mint a canonical notification link, or null when the id is not usable.
 * The minted form is byte-identical to what `parseDeepLink` yields for the
 * same input, so storing the return value of this function is the only
 * sanctioned way to produce a link.
 */
export function mintNotificationLink(
  kind: DeepLinkKind | string,
  id: unknown
): string | null {
  if (typeof id !== "string") return null;
  const trimmedId = id.trim();
  const candidate = `${String(kind)}:${trimmedId}`;
  const parsed = parseDeepLink(candidate);
  if (!parsed || parsed.kind !== kind || parsed.id !== trimmedId) return null;
  return `${parsed.kind}:${parsed.id}`;
}

/** The phase's one mandatory link: a session publication deep link. */
export function sessionPublicationLink(lessonId: unknown): string | null {
  return mintNotificationLink("lesson", lessonId);
}

/**
 * Validate a raw stored/incoming notification link.
 *
 *   null / undefined / ""   → null   (link-less notification: fine)
 *   a valid deep link       → the canonical form (`<kind>:<id>`)
 *   anything else           → false  (REJECT: caller must respond 400, not
 *                                     store the string)
 *
 * The tri-state return is deliberate: "no link" and "a valid link" are both
 * acceptable persisted values, while a malformed one is a contract violation
 * the writer must not silently pass through (e.g. by storing it, which would
 * carry an external-URL payload into every notification centre).
 */
export function validateNotificationLink(raw: unknown): string | null | false {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") return false;
  const text = raw.trim();
  if (!text) return null;
  const parsed = parseDeepLink(text);
  if (!parsed) return false;
  return `${parsed.kind}:${parsed.id}`;
}

/** True exactly when `validateNotificationLink` would accept the value. */
export function isValidNotificationLink(raw: unknown): boolean {
  return validateNotificationLink(raw) !== false;
}
