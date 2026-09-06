// CodeMind Academy — Media storage service.
//
// Media is stored ONCE as a `MediaAsset` and referenced by session videos and
// quiz evidence. Nothing is ever duplicated per student.
//
// Two storage back-ends are supported:
//   * EXTERNAL_URL  — an admin-provided URL (YouTube / Vimeo / CDN).
//   * LOCAL_PRIVATE — an uploaded file written OUTSIDE the public web root and
//                     only readable through an authorized API route.
//
// Private files are never placed in /public and their names are random, so
// they are not guessable.

import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";

export const MEDIA_ROOT =
  process.env.MEDIA_STORAGE_PATH || path.join(process.cwd(), "storage", "media");

export const MAX_VIDEO_BYTES = Number(
  process.env.MEDIA_MAX_VIDEO_BYTES || 512 * 1024 * 1024
);
export const MAX_IMAGE_BYTES = Number(
  process.env.MEDIA_MAX_IMAGE_BYTES || 5 * 1024 * 1024
);

const ALLOWED_VIDEO_MIME = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
]);
const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isAllowedVideoMime(mime: string) {
  return ALLOWED_VIDEO_MIME.has(mime);
}
export function isAllowedImageMime(mime: string) {
  return ALLOWED_IMAGE_MIME.has(mime);
}

/** Basic hardening for admin-supplied video URLs. */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    // Block obvious SSRF targets.
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

/** Generate an unguessable storage key: <scope>/<random>.<ext> */
export function makeStorageKey(scope: string, ext: string): string {
  const safeScope = scope.replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "misc";
  const name = `${Date.now().toString(36)}-${randomBytes(16).toString("hex")}`;
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return `${safeScope}/${name}${safeExt ? `.${safeExt}` : ""}`;
}

function resolveSafePath(storageKey: string): string {
  // `turbopackIgnore` keeps the bundler from treating this dynamic path as a
  // reason to trace the entire project into the server output. The path is
  // still resolved normally at runtime.
  const target = path.resolve(/*turbopackIgnore: true*/ MEDIA_ROOT, storageKey);
  const root = path.resolve(/*turbopackIgnore: true*/ MEDIA_ROOT);
  // Defend against path traversal in a stored key.
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Invalid storage key");
  }
  return target;
}

/** Persist bytes into private storage. Returns the storage key. */
export async function writePrivateFile(
  storageKey: string,
  data: Buffer | Uint8Array
): Promise<string> {
  const target = resolveSafePath(storageKey);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  return storageKey;
}

export async function readPrivateFile(storageKey: string): Promise<Buffer> {
  return fs.readFile(resolveSafePath(storageKey));
}

export async function deletePrivateFile(storageKey: string): Promise<void> {
  await fs.unlink(resolveSafePath(storageKey)).catch(() => {});
}

export async function privateFileStat(storageKey: string) {
  return fs.stat(resolveSafePath(storageKey)).catch(() => null);
}

export function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/ogg": "ogv",
    "video/quicktime": "mov",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  return map[mime] || "bin";
}
