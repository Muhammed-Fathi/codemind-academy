/**
 * Shared pure contract for the R2 direct-upload origin.
 *
 * Used by:
 *   - src/lib/content-security-policy.ts  (CSP connect-src resolution)
 *   - src/lib/media-s3.ts                  (S3 client config / verification)
 *
 * FAIL CLOSED: any missing / malformed bucket/account / endpoint contributes
 * NOTHING — the caller must treat a null / invalid result as "do not add
 * anything to the policy" (strictly no weaker than the 'self' baseline).
 *
 * NO secrets, NO credentials, NO object paths, NO query params, NO
 * NEXT_PUBLIC leakage.
 */

export const R2_DEFAULT_HOST_SUFFIX = ".r2.cloudflarestorage.com";

export type R2UploadOriginDecision =
  | { status: "not-required"; origin: null; reason: string }
  | { status: "ok"; origin: string; reason: string }
  | { status: "invalid"; origin: null; reason: string };

/**
 * Minimal safe bucket-name validator (S3-compatible, virtual-hosted-safe).
 * Rejects anything that could inject host/path fragments or break DNS.
 */
function isValidBucketName(name: string): boolean {
  if (!name || name.length === 0 || name.length > 63) return false;
  // Only lowercase alphanumeric, hyphen, dot — no spaces, control chars,
  // no path/query/credential separators, no Unicode tricks.
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name) && !/^[a-z0-9]$/.test(name))
    return false;
  // Reject double-dot (path-traversal / host-confusion shape) and leading/trailing dot.
  if (name.includes("..") || name.startsWith(".") || name.endsWith("."))
    return false;
  return true;
}

/**
 * Minimal safe hostname-label validator (used for R2_ACCOUNT_ID and for
 * endpoint hostnames derived from it).
 */
function isValidHostLabel(label: string): boolean {
  if (!label || label.length === 0 || label.length > 63) return false;
  if (label.startsWith(".") || label.endsWith(".") || label.includes(".."))
    return false;
  // Reject separators and control chars / whitespace / non-ASCII.
  if (/[\s\/\\?@:#\x00-\x1f\x7f]/.test(label)) return false;
  return true;
}

/**
 * Derive the exact HTTPS origin the browser's presigned PUT will target.
 *
 * The Cloudflare R2 S3 SDK defaults to virtual-hosted addressing, so when
 * the endpoint is the account endpoint (e.g. https://abc123.r2.cloudflarestorage.com)
 * the generated URL uses the bucket-prefixed host:
 *
 *   https://<bucket>.<account>.r2.cloudflarestorage.com
 *
 * CSP must allow that exact host; allowing only the account endpoint is
 * insufficient (browser blocks the PUT before transmission).
 */
export function resolveDirectUploadOrigin(
  env: Record<string, string | undefined> = process.env
): R2UploadOriginDecision {
  const backend = String(env.MEDIA_BACKEND ?? "").trim().toLowerCase();
  if (backend !== "s3") {
    return {
      status: "not-required",
      origin: null,
      reason:
        "MEDIA_BACKEND is not \"s3\" — the browser never connects to object " +
        "storage directly, so connect-src stays 'self'.",
    };
  }

  const bucketRaw = String(env.R2_BUCKET ?? "").trim();
  if (!bucketRaw || !isValidBucketName(bucketRaw)) {
    return {
      status: "invalid",
      origin: null,
      reason:
        "MEDIA_BACKEND=\"s3\" requires a valid R2_BUCKET (non-empty, " +
        "lowercase alphanumeric/hyphen/dot, 1-63 chars, no ..), but the " +
        "configured value is missing or malformed. connect-src stays 'self' " +
        "and direct browser uploads will be blocked by the CSP. Fix R2_BUCKET " +
        "and REBUILD.",
    };
  }

  const endpointRaw = String(env.R2_S3_ENDPOINT ?? "").trim();
  let endpointCandidate = endpointRaw;
  if (!endpointCandidate) {
    const accountId = String(env.R2_ACCOUNT_ID ?? "").trim();
    if (!accountId || !isValidHostLabel(accountId)) {
      return {
        status: "invalid",
        origin: null,
        reason:
          "MEDIA_BACKEND=\"s3\" but neither R2_S3_ENDPOINT nor a valid " +
          "R2_ACCOUNT_ID is set, so the trusted upload origin cannot be " +
          "derived. connect-src stays 'self' and direct browser uploads will " +
          "be blocked by the CSP. Set the R2 environment and REBUILD.",
      };
    }
    endpointCandidate = `https://${accountId}${R2_DEFAULT_HOST_SUFFIX}`;
  }

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpointCandidate);
  } catch {
    return {
      status: "invalid",
      origin: null,
      reason:
        "MEDIA_BACKEND=\"s3\" requires a usable upload origin, but " +
        `${endpointRaw ? "R2_S3_ENDPOINT" : "R2_ACCOUNT_ID"} is set to a ` +
        "value that does not parse as a bare https URL. connect-src stays " +
        "'self' and direct browser uploads will be blocked by the CSP. Fix " +
        "the variable and rebuild.",
    };
  }

  const isBareHttpsEndpoint =
    endpointUrl.protocol === "https:" &&
    endpointUrl.hostname.length > 0 &&
    !endpointUrl.hostname.startsWith(".") &&
    !endpointUrl.hostname.endsWith(".") &&
    !endpointUrl.hostname.includes("..") &&
    endpointUrl.username === "" &&
    endpointUrl.password === "" &&
    endpointUrl.pathname === "/" &&
    endpointUrl.search === "" &&
    endpointUrl.hash === "" &&
    endpointUrl.origin !== "null";

  if (!isBareHttpsEndpoint) {
    return {
      status: "invalid",
      origin: null,
      reason:
        "MEDIA_BACKEND=\"s3\" requires the upload endpoint in " +
        `${endpointRaw ? "R2_S3_ENDPOINT" : "R2_ACCOUNT_ID"} to be a BARE ` +
        "https origin (https://host — no path, no query, no credentials, no " +
        "non-https scheme). connect-src stays 'self' and direct browser " +
        "uploads will be blocked by the CSP. Fix the variable and rebuild.",
    };
  }

  const baseHost = endpointUrl.hostname;
  const uploadHost = `${bucketRaw}.${baseHost}`;
  const uploadCandidate = `https://${uploadHost}`;

  let uploadUrl: URL;
  try {
    uploadUrl = new URL(uploadCandidate);
  } catch {
    return {
      status: "invalid",
      origin: null,
      reason:
        "MEDIA_BACKEND=\"s3\" produced a malformed virtual-hosted origin " +
        "after combining R2_BUCKET with the endpoint host. connect-src stays " +
        "'self'. Fix R2_BUCKET or the endpoint and rebuild.",
    };
  }

  const isBareHttpsUpload =
    uploadUrl.protocol === "https:" &&
    uploadUrl.hostname.length > 0 &&
    !uploadUrl.hostname.startsWith(".") &&
    !uploadUrl.hostname.endsWith(".") &&
    !uploadUrl.hostname.includes("..") &&
    uploadUrl.username === "" &&
    uploadUrl.password === "" &&
    uploadUrl.pathname === "/" &&
    uploadUrl.search === "" &&
    uploadUrl.hash === "" &&
    uploadUrl.origin !== "null";

  if (!isBareHttpsUpload) {
    return {
      status: "invalid",
      origin: null,
      reason:
        "MEDIA_BACKEND=\"s3\" produced an invalid virtual-hosted upload " +
        "origin. connect-src stays 'self'. Fix R2_BUCKET or the endpoint " +
        "and rebuild.",
    };
  }

  // Extra guard: the upload host must contain at least the bucket label and
  // the original endpoint host (two labels minimum for virtual-hosted).
  // This catches pathological cases where baseHost is empty (already blocked)
  // or bucket contains embedded dots that split incorrectly.
  const labels = uploadUrl.hostname.split(".");
  if (labels.length < 2) {
    return {
      status: "invalid",
      origin: null,
      reason:
        "MEDIA_BACKEND=\"s3\" produced an upload origin with too few " +
        "hostname labels. connect-src stays 'self'. Fix the endpoint or " +
        "bucket and rebuild.",
    };
  }

  return {
    status: "ok",
    origin: uploadUrl.origin,
    reason:
      "MEDIA_BACKEND=\"s3\": the presigned browser PUT targets the " +
      "virtual-hosted upload origin derived from R2_BUCKET + " +
      `${endpointRaw ? "R2_S3_ENDPOINT" : "R2_ACCOUNT_ID"}.`,
  };
}
