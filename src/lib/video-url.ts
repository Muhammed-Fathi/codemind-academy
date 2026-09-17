// CodeMind Academy — External video URL contract (isomorphic: server + client).
//
// WHY THIS MODULE EXISTS (production bug — "video by URL saves but won't play"):
//   The admin "Session video by URL" form accepted ANY http(s) URL, stored it
//   verbatim on `MediaAsset.externalUrl`, and handed it to a bare
//   `<video src=...>` on the student side. A YouTube *watch* URL is an HTML
//   PAGE, not a media resource: the element rendered, the player stayed black,
//   and NO error was ever raised — not when the admin saved it, not when the
//   session was published, not for the student. Google Drive share links, Vimeo
//   page URLs and ordinary web pages failed the same silent way.
//
// THE CONTRACT (single source of truth for BOTH ends):
//   An external video URL is accepted ONLY when this module can prove the
//   student player can consume it. Exactly three kinds are supported, each with
//   a canonical stored form and a deterministic render method:
//
//     DIRECT   https URL whose PATH ends in a playable video extension
//              stored: the URL verbatim
//              render: <video src>   (the CDN keeps Range/seek support)
//
//     YOUTUBE  watch / youtu.be / embed / shorts / live with a valid 11-char id
//              stored: https://www.youtube-nocookie.com/embed/<id>
//              render: <iframe>      (privacy-enhanced host)
//
//     VIMEO    vimeo.com/<id>, /channels/<ch>/<id>, player.vimeo.com/video/<id>
//              stored: https://player.vimeo.com/video/<id>
//              render: <iframe>
//
//   Anything else is REJECTED at admin save time — before anything is stored or
//   published — with a specific reason code, so an admin can never stage a URL
//   that silently fails for students. This module never guesses: an
//   unrecognised provider fails CLOSED.
//
// HTTPS IS REQUIRED. The app serves HSTS plus a CSP of
// `media-src 'self' blob: data: https:` and an https-only `frame-src`, so an
// http:// media URL is mixed content the browser blocks outright. Accepting one
// would recreate exactly the bug this module exists to prevent.
//
// NO NODE IMPORTS. This file is imported by client components (the student
// player, the admin form) as well as API routes, so it must stay isomorphic.
// That is also why the SSRF host guard lives HERE and `src/lib/media.ts`
// delegates to it — one definition of "a host we may fetch media from", so the
// server-side and client-side decisions can never drift apart.

/** The three external video kinds the student player can actually render. */
export type ExternalVideoKind = "DIRECT" | "YOUTUBE" | "VIMEO";

/** How the student player must render a normalised external video. */
export type ExternalVideoPlayback =
  | { mode: "video"; src: string }
  | { mode: "iframe"; src: string; title: string };

/** Why an admin-supplied URL was refused. Surfaced as a distinct admin error. */
export type VideoUrlRejection =
  | "MALFORMED" // not a parseable absolute URL
  | "INSECURE_PROTOCOL" // anything but https:
  | "UNSAFE_HOST" // localhost / private range / .local
  | "UNSUPPORTED_PROVIDER"; // parseable + https, but not playable by us

export type NormalizedExternalVideo =
  | { ok: true; kind: ExternalVideoKind; url: string }
  | { ok: false; code: VideoUrlRejection };

/**
 * Extensions the `<video>` element can play directly.
 *
 * Deliberately the same family as `ALLOWED_VIDEO_MIME` / `extFromMime` in
 * `src/lib/media.ts` (mp4, webm, ogg/ogv, mov), so a URL and an upload of the
 * same content are subject to the same expectations.
 */
const DIRECT_VIDEO_EXTENSIONS = ["mp4", "webm", "ogv", "ogg", "mov"] as const;

/** Hosts we treat as YouTube for embed purposes. */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/** Hosts we treat as Vimeo for embed purposes. */
const VIMEO_HOSTS = new Set([
  "vimeo.com",
  "www.vimeo.com",
  "player.vimeo.com",
]);

/** YouTube video ids are exactly 11 URL-safe base64 characters. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
/** Vimeo ids are numeric. */
const VIMEO_ID = /^[0-9]+$/;

/**
 * Hosts a media URL must never point at. Mirrors the pre-existing SSRF guard
 * that lived in `isSafeExternalUrl` — kept as ONE definition so the server and
 * any client-side pre-check agree.
 */
export function isSafeMediaHost(hostname: string): boolean {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "0.0.0.0") return false;
  if (host.endsWith(".local")) return false;
  if (/^127\./.test(host)) return false; // loopback
  if (/^10\./.test(host)) return false; // private
  if (/^192\.168\./.test(host)) return false; // private
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false; // private
  if (host === "::1" || host.startsWith("fe80:")) return false; // IPv6 loop/link-local
  if (host.startsWith("169.254.")) return false; // link-local (cloud metadata)
  return true;
}

function pathExtension(pathname: string): string {
  const last = String(pathname || "").split("/").pop() || "";
  const dot = last.lastIndexOf(".");
  if (dot < 0) return "";
  return last.slice(dot + 1).toLowerCase();
}

function normalizeYouTube(url: URL): string | null {
  const path = url.pathname.replace(/\/+$/, "");
  let id: string | null = null;

  if (url.hostname === "youtu.be" || url.hostname === "www.youtu.be") {
    // https://youtu.be/<id>
    id = path.replace(/^\//, "").split("/")[0] || null;
  } else if (
    path === "/watch" ||
    path.startsWith("/embed/") ||
    path.startsWith("/shorts/") ||
    path.startsWith("/live/") ||
    path.startsWith("/v/")
  ) {
    // /watch takes the id from ?v=; the rest carry it in the path.
    id = path === "/watch" ? url.searchParams.get("v") : path.split("/")[2] || null;
  }

  if (!id) return null;
  // Some share links append a suffix (`<id>.html`); keep only a clean id.
  id = id.split(".")[0];
  if (!YOUTUBE_ID.test(id)) return null;
  // Always the privacy-enhanced host, and always the /embed/ form — the ONLY
  // YouTube representation that is both frameable and stable.
  return `https://www.youtube-nocookie.com/embed/${id}`;
}

function normalizeVimeo(url: URL): string | null {
  if (url.hostname === "player.vimeo.com") {
    // https://player.vimeo.com/video/<id>
    const m = /^\/video\/([0-9]+)/.exec(url.pathname);
    return m ? `https://player.vimeo.com/video/${m[1]}` : null;
  }
  // https://vimeo.com/<id>  or  https://vimeo.com/channels/<channel>/<id>
  const segments = url.pathname.split("/").filter(Boolean);
  const candidate = segments[segments.length - 1];
  if (!candidate || !VIMEO_ID.test(candidate)) return null;
  return `https://player.vimeo.com/video/${candidate}`;
}

/**
 * Validate + normalise an admin-supplied external video URL.
 *
 * Pure and side-effect free: it parses and pattern-matches only, performs no
 * network request, and never resolves a redirect. A URL is accepted on SHAPE
 * (protocol, host, extension or recognised provider id) — the platform cannot
 * prove a remote object is genuinely a video without fetching it, so the
 * contract is "a form the student player is known to consume", and every form
 * outside that contract is rejected rather than stored.
 */
export function normalizeExternalVideoUrl(raw: unknown): NormalizedExternalVideo {
  if (typeof raw !== "string") return { ok: false, code: "MALFORMED" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, code: "MALFORMED" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, code: "MALFORMED" };
  }

  // https only — see the mixed-content note in the header.
  if (url.protocol !== "https:") return { ok: false, code: "INSECURE_PROTOCOL" };
  if (!isSafeMediaHost(url.hostname)) return { ok: false, code: "UNSAFE_HOST" };

  const host = url.hostname.toLowerCase();

  if (YOUTUBE_HOSTS.has(host)) {
    const embed = normalizeYouTube(url);
    // A YouTube host with no usable id (a channel page, a playlist, a search
    // URL) is NOT a video. Reject it instead of embedding something broken.
    return embed
      ? { ok: true, kind: "YOUTUBE", url: embed }
      : { ok: false, code: "UNSUPPORTED_PROVIDER" };
  }

  if (VIMEO_HOSTS.has(host)) {
    const embed = normalizeVimeo(url);
    return embed
      ? { ok: true, kind: "VIMEO", url: embed }
      : { ok: false, code: "UNSUPPORTED_PROVIDER" };
  }

  // Every other host must be a DIRECT media file the <video> element can play.
  const ext = pathExtension(url.pathname);
  if ((DIRECT_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: true, kind: "DIRECT", url: trimmed };
  }

  return { ok: false, code: "UNSUPPORTED_PROVIDER" };
}

/**
 * Decide how the student player must render a stored external URL.
 *
 * Re-derives the kind from the URL itself rather than trusting a stored flag,
 * which means rows written BEFORE this contract existed (a raw YouTube watch
 * URL, for example) are normalised at read time and start playing — no data
 * migration required. Returns `null` for a URL outside the contract so the UI
 * can say so plainly instead of rendering a permanently black player.
 */
export function resolveExternalVideoPlayback(
  raw: unknown
): ExternalVideoPlayback | null {
  const normalized = normalizeExternalVideoUrl(raw);
  if (!normalized.ok) return null;
  if (normalized.kind === "DIRECT") {
    return { mode: "video", src: normalized.url };
  }
  return { mode: "iframe", src: normalized.url, title: normalized.kind };
}

/** True when `raw` is a URL the student player can actually consume. */
export function isPlayableExternalVideoUrl(raw: unknown): boolean {
  return normalizeExternalVideoUrl(raw).ok;
}

/**
 * Human-readable list of what the URL field accepts, for admin-facing hints.
 * Kept here so the form help text, the Arabic operator guide and the validation
 * error can never disagree about the contract.
 */
export const SUPPORTED_EXTERNAL_VIDEO_HINTS = [
  "Direct MP4/WebM/OGG/MOV file link (https)",
  "YouTube watch / youtu.be / shorts link",
  "Vimeo video link",
] as const;
