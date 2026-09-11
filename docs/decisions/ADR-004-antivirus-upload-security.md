# ADR-004: Upload security posture & the antivirus decision

## Status
Accepted for Phase 20 (Security Hardening II)

## Context
The platform accepts file uploads on two surfaces: session videos and quiz
camera evidence (Phase 3+) and session PDFs (Phase 14). Phase 20 required a
review of the upload pipeline (MIME, magic bytes, extension, filename, path
traversal, size, storage quota, temporary files) and an explicit decision on
antivirus integration ("do not claim AV protection without actual integration").

## Decision

1. **Defense-in-depth WITHOUT an AV claim.** The upload pipeline enforces, in
   order, and fail-closed:
   - **Size cap** — `MEDIA_MAX_PDF_BYTES` (25 MB), `MEDIA_MAX_VIDEO_BYTES`
     (512 MB), `MEDIA_MAX_IMAGE_BYTES` (5 MB); `file.size` is rejected before
     buffering, and the real byte length is re-checked after reading.
   - **MIME allow-list** — `application/pdf` (videos: mp4/webm/ogg/quicktime;
     images: jpeg/png/webp). A wrong claimed MIME fails closed; a missing
     MIME is tolerated only when magic bytes + extension pass.
   - **Magic bytes** — PDFs must start with `%PDF-` within the first 1024
     bytes; an HTML file renamed `.pdf` is rejected.
   - **Extension** — sanitised filename must end `.pdf` (defense in depth;
     the magic check is the real gate).
   - **Filename sanitisation** — null bytes/control chars stripped, path
     separators and traversal segments removed, length capped; the name is
     metadata only, never a storage key.
   - **Path traversal** — storage keys are generated server-side
     (`makeStorageKey`), never taken from the client, and `resolveSafePath`
     rejects any stored key that escapes the media root.
   - **No temporary files** — uploads are read into memory and written
     directly under a random key (`writePrivateFile`); there is no temp-file
     cleanup window to exploit.

2. **No ClamAV / antivirus integration in this phase.** The platform has no
   AV infrastructure, and claiming protection without an integrated scanner
   would be dishonest. The residual risk (a PDF that is a valid PDF AND
   carries a payload for a vulnerable PDF reader) is mitigated by:
   - serving PDFs with `Content-Type: application/pdf` +
     `X-Content-Type-Options: nosniff` (never executed as HTML/script);
   - `Content-Disposition: inline|attachment` (browser PDF sandbox);
   - magic-byte verification preventing the "HTML smuggled as PDF" vector.
   The documented insertion point for a real scanner is
   `validatePdfUpload`/the upload route (add a scan step after `writePrivateFile`,
   before the DB rows are committed, and quarantine on positive).

3. **Storage quota is a Phase 21 concern.** Per-file caps and reference-counted
   byte cleanup exist today; a global quota / retention job depends on the
   durable-storage and production data-layer work, which is out of Phase 20
   scope by the strict boundary.

## Consequences
- Uploads remain bounded and validated at every layer; no false AV guarantee
  is made to operators.
- A future ClamAV (or equivalent) integration has a single, tested insertion
  point and does not require re-architecting the upload path.
- Residual risk is documented as accepted until a scanner is wired (Phase 21+).
