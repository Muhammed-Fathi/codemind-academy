// GET /api/materials/[id]
//
// The ONLY way to read a private session PDF. Bytes live outside the public
// web root under an unguessable random key; there is no public URL at all.
//
// Authorization is the Phase 14 10-check contract (see
// `authorizeMaterialDownload` in src/lib/session-materials.ts):
//   1. authenticated
//   2. correct role
//   3. enrollment / child scope
//   4. correct course
//   5. correct track (lesson + material)
//   6. lesson/session ownership
//   7. lifecycle availability (PUBLISHED for students/parents)
//   8. progression eligibility (students)
//   9. material belongs to lesson and is active
//  10. asset exists, is LOCAL_PRIVATE, isPrivate
//
// Query:
//   ?download=1  → Content-Disposition: attachment
//   (default)    → Content-Disposition: inline
//
// Headers always include Cache-Control: no-store and X-Content-Type-Options:
// nosniff. Range requests are supported for large documents.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, err } from "@/lib/api";
import { readPrivateFile, privateFileStat } from "@/lib/media";
import {
  authorizeMaterialDownload,
  materialAccessHttpStatus,
  materialContentDisposition,
} from "@/lib/session-materials";
import { logSecurityEvent } from "@/lib/security";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  const access = await authorizeMaterialDownload({
    materialId: id,
    user: { id: user.id, role: user.role },
  });

  if (!access.allowed) {
    const status = materialAccessHttpStatus(access.reason);
    // Uniform non-oracle body for 404s; machine code for 403s.
    if (status === 401) return err("Unauthorized", 401);
    if (status === 403) {
      return NextResponse.json(
        {
          error:
            access.reason === "NOT_ENROLLED"
              ? "Not enrolled"
              : access.reason === "PREVIOUS_SESSION_INCOMPLETE"
                ? "Previous session incomplete"
                : "Forbidden",
          code: access.reason,
        },
        { status: 403 }
      );
    }
    return err("Not found", 404);
  }

  const { asset, material } = access;

  const stat = await privateFileStat(asset.storageKey);
  if (!stat) return err("Not found", 404);

  const buffer = await readPrivateFile(asset.storageKey).catch(() => null);
  if (!buffer) return err("Not found", 404);

  const url = new URL(req.url);
  const asDownload =
    url.searchParams.get("download") === "1" ||
    url.searchParams.get("download") === "true";

  const total = buffer.length;
  const contentType = asset.mimeType || "application/pdf";
  const filename =
    asset.originalName ||
    `${material.title || "document"}.pdf`;

  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    // Sensitive delivery: never cache in shared caches; browsers may hold a
    // private copy briefly but intermediaries must not.
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-store",
    "Content-Disposition": materialContentDisposition(filename, asDownload),
    "X-Content-Type-Options": "nosniff",
  };

  // Soft audit for staff access (high-sensitivity content).
  if (user.role === "ADMIN" || user.role === "TEACHER") {
    await logSecurityEvent({
      userId: user.id,
      type: "MATERIAL_ACCESSED",
      detail: `materialId=${material.id};mediaAssetId=${asset.id};role=${user.role}`,
    }).catch(() => undefined);
  }

  const range = req.headers.get("range");
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end < 0 ||
        start >= total ||
        end >= total ||
        start > end
      ) {
        return new NextResponse(null, {
          status: 416,
          headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
        });
      }
      const chunk = buffer.subarray(start, end + 1);
      return new NextResponse(new Uint8Array(chunk), {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(chunk.length),
        },
      });
    }
  }

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(total) },
  });
}
