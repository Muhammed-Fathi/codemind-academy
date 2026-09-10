# Phase 14 — PDF & Session Materials

> **Status:** complete (implementation + real-DB/file verification)  
> **Date:** 2026-09-10  
> **Baseline:** Phase 13 lifecycle on `main`  
> **Branch:** `arena/01a08b25-codemind-academy`

---

## Objective

Session-scoped PDFs with store-once bytes and authorized downloads, reusing the
existing Phase 3 domain foundation:

```text
Lesson
  └── Material(ADMIN_UPLOADED, trackScope, isActive, mediaAssetId)
        └── MediaAsset(DOCUMENT, LOCAL_PRIVATE, storageKey, isPrivate)
              └── private bytes under MEDIA_ROOT (never /public)
```

**No new PDF / Document / Attachment tables.**  
**Zero new `Lesson.pdfUrl` writes.**

---

## What shipped

### Storage & validation (`src/lib/media.ts`)

| Check | Rule |
|---|---|
| MIME | allow-list `application/pdf` (parameters stripped) |
| Extension | sanitised basename must end in `.pdf` (case-insensitive) |
| Magic bytes | buffer must contain `%PDF-` within the first 1 KB |
| Size | `MEDIA_MAX_PDF_BYTES` (default 25 MB) |
| Filename | path separators, null bytes, controls stripped; never used as storage key |
| Storage key | `makeStorageKey("session-pdfs", "pdf")` — unguessable, traversal-safe |

A file claiming `application/pdf` without the PDF signature is rejected (415).

### Material model (`src/lib/session-materials.ts`)

- **Upload / replace:** one active `ADMIN_UPLOADED` PDF per `(lesson × trackScope)`.
  Prior active rows of the same scope are deactivated; unreferenced MediaAssets
  are reference-count cleaned (Material + SessionVideo + QuizAttemptEvidence).
- **Track:** `Material.trackScope` (`SHARED` / `ARABIC` / `LANGUAGE`), default
  inherits the lesson’s scope when the admin omits it. Matching reuses
  Phase 12 `canAccessTrackScope` — never UI locale.
- **Descriptors:** student/parent payloads get `{ id, title, kind, trackScope,
  downloadUrl, mimeType, sizeBytes, legacy }` — never `storageKey`, never a
  filesystem path. Locked sessions get an empty list.
- **Legacy `pdfUrl`:** read-only compatibility. Usable non-placeholder values
  surface as a `LEGACY_URL` descriptor when no Material exists. Placeholders
  (`#`, empty, …) are ignored.

### Routes

| Method | Path | Auth |
|---|---|---|
| `POST` | `/api/admin/lessons/[id]/materials` | ADMIN · multipart PDF |
| `GET` | `/api/admin/lessons/[id]/materials` | ADMIN · list (active + inactive) |
| `DELETE` | `/api/admin/lessons/[id]/materials?materialId=` | ADMIN · deactivate + cleanup |
| `GET` | `/api/materials/[id]` | 10-check contract · `?download=1` |

Download headers:

```text
Content-Type: application/pdf
Content-Disposition: inline | attachment   (?download=1)
Cache-Control: private, no-store, max-age=0
X-Content-Type-Options: nosniff
Accept-Ranges: bytes
```

### Authorization (10-check contract)

`authorizeMaterialDownload` enforces, fail-closed:

1. Authenticated  
2. Role (STUDENT / PARENT / TEACHER / ADMIN)  
3. Enrollment / linked-child scope  
4. Correct course  
5. Correct track (lesson **and** material)  
6. Lesson ownership of the material  
7. Lifecycle (`PUBLISHED` for students/parents)  
8. Progression eligibility (`canAccessLesson`)  
9. Material active + belongs to lesson  
10. Asset exists, `LOCAL_PRIVATE`, `isPrivate`

Wrong-track and unknown ids answer **404** (non-oracle). Locked sessions answer
**403** with `PREVIOUS_SESSION_INCOMPLETE`. Unauthenticated → **401**.

Parents resolve through `isParentLessonPreviewAllowed` (child course + child
track + PUBLISHED + not archived). A parent account alone is never enough.

### Defense in depth

- `/api/materials` added to `PROTECTED_API_PREFIXES` (cookie presence).
- `GET /api/media/[id]` refuses `DOCUMENT` / material-linked assets for
  non-admins — guessing a MediaAsset id cannot bypass the material gate.

### Schema

Additive migration `20260910120000_phase14_session_materials`:

```sql
ALTER TABLE "Material" ADD COLUMN "trackScope" TEXT NOT NULL DEFAULT 'SHARED';
CREATE INDEX "Material_lessonId_trackScope_isActive_idx"
  ON "Material"("lessonId", "trackScope", "isActive");
```

No uniqueness constraint on `(lessonId, trackScope)` — deactivated history must
survive for refcounting; the one-active rule is enforced in
`uploadLessonPdfMaterial`.

### Readiness

PDF remains **optional** for READY. Codes:

| State | Code |
|---|---|
| absent | `PDF_ABSENT_NOT_REQUIRED` |
| present (Material or usable legacy) | `PDF_PRESENT_NOT_REQUIRED` |

Foreign-track materials are noted (`PDF_PRESENT_BUT_OTHER_TRACK:N`) and do not
credit the lesson.

---

## Student / parent payloads

`GET /api/lessons/[id]` and `GET /api/courses/[slug]` now include:

```json
{
  "materials": [
    {
      "id": "…",
      "title": "Unit 1 PDF",
      "kind": "ADMIN_UPLOADED",
      "trackScope": "SHARED",
      "downloadUrl": "/api/materials/…",
      "mimeType": "application/pdf",
      "sizeBytes": 12345,
      "legacy": false
    }
  ],
  "pdfUrl": "/api/materials/…"
}
```

`pdfUrl` is a back-compat alias of the first authorized material path (or a
legacy external URL). Locked sessions: `pdfUrl: null`, `materials: []`.

The student lesson UI renders material descriptors and appends `?download=1`
for non-legacy links.

---

## Tests

| Suite | Result |
|---|---|
| `tests/session-materials-phase14.test.js` | 127 passed |
| `scripts/verify-phase14-db.mjs` | `PHASE14_VERIFY_OK` (58 assertions, real SQLite + real PDF bytes) |
| Phase 11 curriculum | 56 passed |
| Phase 12 track | 302 passed |
| Phase 13 lifecycle | 294 passed |
| Session progression | 162 passed |
| Session quiz | 70 passed |
| Parent isolation | 112 passed |
| Security hardening | 253 passed |
| Authorization invariants | 93 passed |
| Mock exam / grading | 135 + 22 passed |
| Quiz analytics | 44 passed |
| Calendar/i18n | 440 passed |
| Kodgy | 231 passed |

### Real-file proof (verify script)

```text
upload → private storage under MEDIA_ROOT/session-pdfs/<random>.pdf
      → Material(ADMIN_UPLOADED) + MediaAsset(DOCUMENT, LOCAL_PRIVATE)
      → authorize AR student SHARED = allow
      → authorize AR student LANGUAGE = deny (LESSON_NOT_FOUND)
      → authorize parent of AR child LANGUAGE = deny
      → authorize draft material student = deny
      → replace → old asset deleted, new asset retained
      → shared-ref asset retained while second Material points at it
      → HTML-as-PDF / empty / traversal rejected
      → Lesson.pdfUrl remains NULL (zero new writes)
```

---

## Environment

```bash
MEDIA_STORAGE_PATH="./storage/media"   # outside web root
MEDIA_MAX_PDF_BYTES="26214400"         # 25 MB default
```

---

## Explicit non-goals (phase boundary)

- Admin publishing UI (Phase 15)
- Notification fan-out / session notification links (Phase 17)
- Full student locked-curriculum redesign (Phase 16)
- Teacher workflow redesign (Phase 18)
- Postgres / production media migration (Phase 21)
- Phase 20 security sweep

---

## Known limitations

1. **Prisma engine download** is blocked in this sandbox (`binaries.prisma.sh`
   unreachable), so `prisma generate` / `migrate deploy` / `migrate status`
   cannot run here. Migration SQL is applied and verified via `node:sqlite`
   (same approach as Phase 13). Re-run `bun run db:generate` and
   `bunx prisma migrate deploy` where the engine is reachable.
2. **PDF is still optional for READY** — readiness never blocks on a missing
   PDF. Product may flip `required: true` later without a schema change.
3. **No antivirus / ClamAV** — MIME + extension + magic + size only. Full
   content scanning is Phase 20.
4. **Range requests** are supported on the download route; they re-authorize
   every request (no cached range bypass).
5. **Admin UI** for upload is out of scope — API only in this phase.

---

## Completion checklist

```text
✅ PDFs use Material + MediaAsset
✅ New PDFs do not use pdfUrl
✅ PDFs stored privately
✅ PDF magic-byte validation exists
✅ size/MIME/extension validation exists
✅ secure storage keys exist
✅ track isolation works
✅ lifecycle rules apply
✅ progression rules apply
✅ parent scope works
✅ authorized download exists
✅ inline/download disposition works
✅ no-store behavior verified
✅ replacement is reference-safe
✅ unauthorized direct IDs fail
✅ no public PDF URLs are created
✅ real local DB verified
✅ real file upload/download verified
✅ Phase 11–13 + security regressions pass
✅ documentation updated
```
