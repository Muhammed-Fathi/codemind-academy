// CodeMind Academy — media storage-value predicates (CLIENT-SAFE).
//
// Pure string comparisons over `MediaAsset.storage`: NO node imports, NO
// backend code, so client components may reach these through
// `@/lib/session-video-link` without dragging the node-only storage backend
// (`@/lib/media`) into the browser bundle. `@/lib/media` re-exports every
// name here, so server importers keep importing from `@/lib/media` unchanged.

/** Every `MediaStorage` enum value (mirrors prisma/schema.prisma — unchanged). */
export const MEDIA_STORAGE_VALUES = [
  "EXTERNAL_URL",
  "LOCAL_PRIVATE",
  "S3",
] as const;
export type MediaStorageValue = (typeof MEDIA_STORAGE_VALUES)[number];

/**
 * The `MediaAsset.storage` values that mean "private bytes THIS SERVER manages
 * through the StorageBackend abstraction":
 *   LOCAL_PRIVATE — the private filesystem volume under MEDIA_ROOT;
 *   S3            — an S3-compatible object store (Cloudflare R2).
 *
 * `EXTERNAL_URL` is deliberately NOT managed: it is a third-party URL the
 * client fetches directly and this server never proxies, reads or deletes.
 *
 * EVERY read gate, delete gate and purge gate in the application asks
 * `isManagedPrivateStorage(asset.storage)` instead of comparing against one
 * literal, so accepting S3 can never mean relaxing privacy: the bytes stay
 * behind the same authorized routes whichever backend holds them.
 */
export const MANAGED_PRIVATE_STORAGE_VALUES = [
  "LOCAL_PRIVATE",
  "S3",
] as const;
export type ManagedPrivateStorageValue =
  (typeof MANAGED_PRIVATE_STORAGE_VALUES)[number];

/**
 * Normalise a stored `MediaAsset.storage` value to the enum spelling, or
 * `null` when it is not one of ours. Tolerates case/whitespace drift from raw
 * SQL fixtures without ever inventing a value.
 */
export function normalizeMediaStorageValue(
  storage: unknown
): MediaStorageValue | null {
  if (storage === null || storage === undefined) return null;
  const v = String(storage).trim().toUpperCase();
  return (MEDIA_STORAGE_VALUES as readonly string[]).includes(v)
    ? (v as MediaStorageValue)
    : null;
}

/**
 * True iff `storage` marks a MANAGED PRIVATE object (LOCAL_PRIVATE or S3).
 * Fail-closed: null / undefined / empty / EXTERNAL_URL / anything unknown →
 * false, so an unexpected row value can never be served or deleted as if it
 * were private managed bytes.
 */
export function isManagedPrivateStorage(storage: unknown): boolean {
  const v = normalizeMediaStorageValue(storage);
  return v !== null && (MANAGED_PRIVATE_STORAGE_VALUES as readonly string[]).includes(v);
}
