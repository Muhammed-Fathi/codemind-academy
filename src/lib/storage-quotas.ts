// CodeMind Academy — Phase 21: storage quotas for durable media.
//
// Per-FILE ceilings already exist (MEDIA_MAX_VIDEO_BYTES / MEDIA_MAX_IMAGE_BYTES
// / MEDIA_MAX_PDF_BYTES, enforced in src/lib/media.ts + the upload routes).
// This module adds the production VOLUME quota: a cap on the total bytes under
// MEDIA_ROOT, so one tenant's uploads can never fill the production volume.
//
// CONTRACT
//   * UNSET (default) = unlimited. Every check is a no-op unless the operator
//     sets MEDIA_QUOTA_BYTES — wiring this module into the upload paths changes
//     NOTHING until the operator opts in (proven by the offline suite).
//   * SET = fail-closed. When the volume already holds >= quota bytes, or the
//     incoming file would push it over, the upload is rejected BEFORE any byte
//     is written (413 QUOTA_EXCEEDED), the DB is untouched, and the rejection
//     is observable (machine code, no PII).
//   * No unsafe infrastructure assumptions: the quota is a plain byte count
//     over MEDIA_ROOT (whatever it is — local dir, mounted volume, or the
//     staging dir in front of object storage). It never assumes a filesystem
//     type, never shells out (no `du`), and never follows symlinks out of the
//     root (see getDirectoryBytes).
//
// ENV
//   MEDIA_QUOTA_BYTES="10737418240"    total volume cap (plain bytes, or a
//       human size like "10GB" / "512 MB"). Unset / blank / "0" = unlimited.
//       Unparseable = startup-visible throw at first enforcement (fail-closed),
//       never a silent unlimited.

import { promises as fs } from "fs";
import path from "path";
import { MEDIA_ROOT } from "@/lib/media";

export type QuotaConfig = {
  /** 0 = unlimited. */
  quotaBytes: number;
  /** True when the operator configured a finite cap. */
  enforced: boolean;
  /** The raw env value (for diagnostics; never a secret). */
  raw: string | null;
};

const UNIT_MULTIPLIER: Record<string, number> = {
  b: 1,
  kb: 1024,
  k: 1024,
  mb: 1024 * 1024,
  m: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  g: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
  t: 1024 * 1024 * 1024 * 1024,
};

/**
 * Parse "10737418240" | "10GB" | "512 MB" | "" into bytes.
 * Returns 0 for blank/unset (= unlimited). Throws on garbage (fail-closed).
 */
export function parseBytesEnv(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).trim();
  if (s === "" || s === "0") return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(s);
  if (!m) throw new Error(`Invalid byte size: ${JSON.stringify(s.slice(0, 32))}`);
  const num = Number(m[1]);
  const unit = (m[2] || "b").toLowerCase();
  const mult = UNIT_MULTIPLIER[unit];
  if (!Number.isFinite(num) || num < 0 || mult === undefined) {
    throw new Error(`Invalid byte size: ${JSON.stringify(s.slice(0, 32))}`);
  }
  const bytes = Math.floor(num * mult);
  if (!Number.isSafeInteger(bytes)) throw new Error(`Byte size out of range`);
  return bytes;
}

export function resolveQuotaConfig(env: NodeJS.ProcessEnv = process.env): QuotaConfig {
  const raw = env.MEDIA_QUOTA_BYTES ?? null;
  const quotaBytes = parseBytesEnv(raw);
  return { quotaBytes, enforced: quotaBytes > 0, raw };
}

export type QuotaVerdict =
  | { ok: true; enforced: false }
  | { ok: true; enforced: true; currentBytes: number; incomingBytes: number; quotaBytes: number }
  | {
      ok: false;
      code: "QUOTA_EXCEEDED";
      currentBytes: number;
      incomingBytes: number;
      quotaBytes: number;
    };

/**
 * Pure decision: would `incomingBytes` fit under the quota given `currentBytes`?
 * quotaBytes <= 0 (unset) always allows — the default path does no I/O at all.
 */
export function checkQuota(input: {
  currentBytes: number;
  incomingBytes: number;
  quotaBytes: number;
}): QuotaVerdict {
  const { currentBytes, incomingBytes, quotaBytes } = input;
  if (!(quotaBytes > 0)) return { ok: true, enforced: false };
  if (currentBytes >= quotaBytes || currentBytes + incomingBytes > quotaBytes) {
    return {
      ok: false,
      code: "QUOTA_EXCEEDED",
      currentBytes,
      incomingBytes,
      quotaBytes,
    };
  }
  return { ok: true, enforced: true, currentBytes, incomingBytes, quotaBytes };
}

/**
 * Byte size of everything under `root` (regular files only, no symlink
 * following, missing dir = 0). Bounded: iterative walk, skips unreadable
 * entries rather than failing the upload on a stray permission.
 */
export async function getDirectoryBytes(root: string = MEDIA_ROOT): Promise<number> {
  let total = 0;
  let pending: string[] = [root];
  try {
    while (pending.length) {
      const next: string[] = [];
      for (const dir of pending) {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue; // missing/unreadable dir contributes 0
        }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          try {
            if (e.isSymbolicLink()) continue; // never follow links out of root
            if (e.isDirectory()) next.push(full);
            else if (e.isFile()) total += (await fs.stat(full)).size;
          } catch {
            continue;
          }
        }
      }
      pending = next;
    }
  } catch {
    return total;
  }
  return total;
}

/**
 * Enforce the volume quota for an incoming upload of `incomingBytes`.
 * Zero I/O when MEDIA_QUOTA_BYTES is unset (the default). Call BEFORE writing
 * any file or DB row.
 */
export async function assertVolumeQuota(
  incomingBytes: number,
  opts: { root?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<QuotaVerdict> {
  const { quotaBytes } = resolveQuotaConfig(opts.env);
  if (!(quotaBytes > 0)) return { ok: true, enforced: false };
  const currentBytes = await getDirectoryBytes(opts.root ?? MEDIA_ROOT);
  return checkQuota({ currentBytes, incomingBytes, quotaBytes });
}
