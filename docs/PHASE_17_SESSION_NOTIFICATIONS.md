# Phase 17 — Session Publication Notifications

**Status:** implemented and verified (2026-09-11). Deliberately NOT merged (separate pre-merge audit follows, per the phase protocol).
**Depends on:** Phase 13 (lifecycle + `SessionPublication` anchor), Phase 12 (`trackScope` + `canAccessTrackScope`), Phase 16 (deep-link scheme + notification centre navigation), Phase 9 (i18n dictionary), the existing `createNotificationIfAllowed` preference contract.
**Verdict:** `PASS — SAFE TO MERGE` (with the documented sandbox-environment limitations of §11).

---

## 1. The one event

Publishing a session through the Phase 13 OPEN ceremony produces exactly one
targeted notification event: a `NEW_LESSON` notification delivered to the
students eligible **at the moment of publishing**, partitioned by the shared
notification-preference contract, inserted in bounded chunks, idempotent under
every retry, and deep-linked to the session itself.

```
OPEN SESSION (Phase 13 ceremony persists the publication)
  → derive eligible recipients    (getEligibleSessionRecipients — the ONE derivation)
  → respect preferences           (partitionByNotificationPreferences — ONE bulk read)
  → chunked fan-out               (chunkList, 500 default, sequential)
  → per-chunk (type, link) dedupe (delivery state IS the rows users hold)
  → deep link lesson:<lessonId>   (notification-links.ts, validated scheme)
  → counters + audit              (SessionPublication.notifiedCount/notifiedAt)
```

The lifecycle engine (`src/lib/session-lifecycle.ts`) stays notification-free:
the fan-out is **route-level orchestration** in `POST /api/admin/lessons/[id]/open`,
which runs only when the ceremony returned a live publication (`result.ok &&
!!result.publication` — the OK flip and the NO_OP replay). Every refusal path
(404/409/any `!result.ok`) emits nothing, forever.

## 2. Recipient derivation (the shared helper)

`getEligibleSessionRecipients({ courseId, trackScope }, client?)` in
`src/lib/session-notifications.ts` is the ONLY computation of the audience —
the fan-out, the admin preview endpoint `/api/admin/lessons/[id]/recipients`,
and both test layers call it, so a count can never disagree with a delivery.

```ts
eligible =
  Student.group.isActive === true AND Student.group.courseId === lessonCourseId   // enrollment (same definition as enrollment.ts)
  AND User.isActive === true AND User.status === "ACTIVE"                          // account-state security gate
  AND (trackScope === "SHARED" ? any schoolType : student.schoolType === trackScope) // the Phase 12 rule
```

- **Group is never the audience.** A group mixes ARABIC and LANGUAGE
  students; the audience is (course × trackScope × active). Groups only prove
  enrollment in the course (the same active-group rule `getEnrollment` uses).
- **Eligibility is dynamic, computed at publish time.** No segment snapshot,
  no backfill on enrollment change, no stored audience. A student who joins
  the course an hour after publishing is NOT notified retroactively; a student
  who joined before publishing but got pref-suppressed IS NOT notified later
  automatically. Manual retry (re-OPEN) re-derives everything fresh.
- **`canAccessTrackScope` is the track truth — the SAME helper** the shared
  course universe uses (`session-progress.ts` §11a). The runtime predicate
  `isEligibleSessionRecipient` mirrors the SQL fragment
  `sessionRecipientsWhere` bit for bit; the suite proves both mirrors agree
  AND agree with the Phase 12 helper on every matrix cell.
- **Unknown scope fails closed on BOTH sides.** An unrecognized lesson
  `trackScope` notifies nobody (`getEligibleSessionRecipients` returns `[]`
  before querying); an unrecognized student `schoolType` is SHARED-only
  (Phase 12 fail-closed normalization).
- **Lesson → course** resolves through `resolveLessonCourseId`: canonical
  `unit → part.courseId` FIRST, legacy `topic.unit.part.courseId` as fallback —
  identical precedence to the progression engine, so the notification can
  never target a course the students' curriculum doesn't show the session in.

## 3. Preferences & quiet hours

`src/lib/notify.ts` now exposes the existing single-create contract in bulk
form — **same rules, one read**:

1. the per-type flag (`NotificationPreference.newLesson` for `NEW_LESSON`)
   must be enabled — a missing preference row = schema defaults = ALLOWED;
2. quiet hours suppress the notification for this run (skip, not defer);
3. unknown/unmapped types default to allow.

`partitionByNotificationPreferences(userIds, prefRows, type, now)`
- pure: quiet hours are evaluated ONCE per run against the injected `now`
  (a run's chunks can never disagree about what time it was);
- returns the deliver list (recipient order preserved) and the exact skip
  reasons (`PREFERENCE_DISABLED` / `QUIET_HOURS`).
- `isInQuietHoursAt(start, end, now)` = inclusive start, EXCLUSIVE end,
  same-day and cross-midnight windows, malformed window fails OPEN to
  delivery (the legacy helper's behaviour, preserved).
- The legacy helpers (`isNotificationEnabled`, `createNotificationIfAllowed`,
  `createNotificationsIfAllowed`) are behaviour-identical; the suite proves
  partition-parity against them row by row.

A quiet-hours skip means **not delivered by THIS run**. Like the single-create
path, there is no queue: the row never exists unless a later manual OPEN
replay happens while the user is outside their window (then the dedupe lets
it land exactly once).

## 4. Chunking

- `chunkList(items, size)` — deterministic slicing; recipients are sorted by
  `userId` BEFORE chunking, so every retry of the same run slices identically
  and a partial-failure retry can only ever resume at the same boundary.
- Default 500 (`NOTIFICATION_FANOUT_DEFAULT_CHUNK_SIZE`), hard-clamped to
  [1, 1000]; override via `NOTIFICATION_FANOUT_CHUNK_SIZE` or the `chunkSize`
  param (garbage/zero values degrade to the default, never to a zero-step
  loop or an oversized statement). 500 binds 2,500 variables per statement
  (13× headroom under SQLite's 32,766 and Postgres's 32,767 limits).
- Chunks run **sequentially**; a failed chunk stops the run (chunk N+1 is
  never attempted in that run) and the outcome is `EMITTED_PARTIAL` with the
  exact `failedChunks` index.

## 5. Idempotency (deliver exactly once)

No separate delivery-tracking table. The Phase 13 `SessionPublication` row is
the identity anchor; **the notification rows users already hold ARE the
delivery state**:

1. **Publication-gated:** the fan-out runs only against a lesson that is
   currently `PUBLISHED` *with a live anchor*. `UNPUBLISH` deletes the anchor,
   so a late retry of a withdrawn publication refuses
   (`LESSON_NOT_PUBLISHED` / `PUBLICATION_MISSING`) with **zero** rows.
2. **Per-chunk dedupe:** before inserting chunk C, the engine loads existing
   `(userId ∈ C, type = NEW_LESSON, link = lesson:<lessonId>)` rows and
   inserts only the fresh remainder — trivially satisfied for a first run,
   and exactly what makes a replay (fresh OPEN, NO_OP re-OPEN, partial-chunk
   retry) deliver only what is missing. The dedupe window is per chunk
   (bounded IN list, never a whole-table scan).
3. **Retry channels all converge:** first OPEN → `EMITTED`; re-OPEN on the
   NO_OP path re-runs the SAME pipeline (`ALREADY_DELIVERED` or the fresh
   remainder); a heal-after-`EMITTED_PARTIAL` retry re-runs the whole
   pipeline and the already-inserted chunks become cost-one dedupe checks.

Honest terminal codes (never a reassuring lie):

| code                       | meaning                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `EMITTED`                  | run delivered ≥1 row                                               |
| `ALREADY_DELIVERED`        | run delivered 0 because the dedupe found held rows                  |
| `SUPPRESSED_BY_PREFERENCES`| eligible > 0 but the partition suppressed EVERYTHING — nothing attempted, **not** "already notified" |
| `EMITTED_PARTIAL`          | a chunk failed; earlier chunks delivered; rest never attempted     |
| `NO_RECIPIENTS`            | eligible = 0 (informative; audited)                                |
| `LESSON_NOT_FOUND` / `LESSON_NOT_PUBLISHED` / `PUBLICATION_MISSING` / `LESSON_NOT_IN_COURSE` | refusals (ok=false) |

## 6. Counters & audit

- `SessionPublication.notifiedCount` is recomputed on every run as the true
  `count(NEW_LESSON, link)` — the count the admin sees IS the delivery.
- `SessionPublication.notifiedAt` moves ONLY when a run delivered ≥1 row; a
  fully suppressed run leaves it NULL forever (honest "never delivered").
- One `AuditLog(action = "LESSON_PUBLICATION_NOTIFY", entity = "SessionPublication", entityId = lessonId)`
  row per run carries the full breakdown (code, eligible, delivered,
  alreadyNotified, skippedPreference, skippedQuietHours, chunk plan/done,
  failedChunks, totalDelivered). A failed audit insert never fails a
  publication (same rule the ceremony uses); the actor is the admin who
  opened the session. `NO_RECIPIENTS` runs are audited too.

## 7. Deep links & the client path

- `src/lib/notification-links.ts` owns the server/minting side of the Phase
  16 scheme: `lesson:|video:|quiz:|homework:` + the same strict parser —
  **there is one parser** (`parseDeepLink` is re-exported from
  `deep-link.ts`, not re-implemented). `mintNotificationLink` returns null
  for a bogus input rather than emitting a link that would be rejected
  later; `validateNotificationLink` is tri-state (absent-link → null,
  valid → canonical string, anything else → false) so a writer can refuse a
  malformed link instead of storing a `javascript:` payload.
- The publication notification stores `link = lesson:<lessonId>` — minted,
  never string-concatenated.
- **Click handling was already Phase-16-complete** (pinned by this phase's
  suite): notification centre → `navigateDeepLink(link, store)` →
  `setView` (clears `navParam`) then `setNavParam(target)` (order is
  load-bearing, so Phase 13's setView contract is pinned again here) → the
  destination route **re-authorizes server-side** (enrollment × track ×
  lifecycle × progression). A stale link to an unpublished/foreign session
  lands on the locked/not-available state, never on content.
- The link is a pointer, not a grant: destinations enforce the same rules as
  opening by hand.

## 8. The OPEN ceremony outcome (two halves, both honest)

`POST /api/admin/lessons/[id]/open` response now carries the ceremony's own
fields (`code`, `readiness`, `publication`, …) **unchanged** plus the
delivery half:

```jsonc
"notification": {
  "ok": true, "code": "EMITTED",
  "eligible": 5, "delivered": 3, "alreadyNotified": 0,
  "skippedPreference": 1, "skippedQuietHours": 1,
  "chunksPlanned": 1, "chunksDone": 1, "failedChunks": [],
  "link": "lesson:<id>", "message": "Notified 3 students"
}
```

- Publication success is the **lifecycle transaction's** success. A
  notification problem can never roll back, hide, or downgrade it: chunk
  failures arrive as `EMITTED_PARTIAL`; a whole-pipeline infrastructure throw
  is caught in the route and surfaces as an explicit synthetic
  `EMITTED_PARTIAL` outcome ("publication is live, delivery retryable by
  re-opening"), while the HTTP status stays the ceremony's 200.
- A notification code never upgrades a refused ceremony either: refusal
  responses are exactly as before, with `notification: null`.

### Dialog (`session-open-dialog.tsx`)

- A recipients preview (`data-testid="open-recipients-preview"`) fetched at
  dialog-open from `GET /api/admin/lessons/[id]/recipients`:
  eligible / already-notified / **pending** (preference-aware: suppressed
  students are NOT "about to be notified") / total delivered / current skip
  breakdown. It is strictly informational — it never gates the ceremony, and
  both sides agree by construction (same derivation).
- NO_OP replay says "already published" (admin.392) first, then "everyone
  was already notified" (admin.501) only when the code is
  `ALREADY_DELIVERED`. A real delivery toasts the count (admin.498); any
  suppression toasts the breakdown (admin.499); `EMITTED_PARTIAL` toasts the
  partial state (admin.500) and **keeps the dialog open** so the retry is
  one click (the documented resume path); refresh propagates via `onDone()`.

## 9. The admin broadcast no longer bypasses preferences (§16 review)

`POST /api/admin/notifications` previously created one row per targeted user
unconditionally (`createMany`, "sent = target count", no preference check) —
a direct path around the very contract `createNotificationIfAllowed`
enforces everywhere else, and it accepted arbitrary `link` strings verbatim.

Now, with the same target/audience resolution as before:

1. ONE bulk `notificationPreference.findMany({ userId in target })` +
   `partitionByNotificationPreferences(...)` with the broadcast's type;
2. the deliver set inserts chunked (same `chunkList` + bound);
3. the optional `link` is validated by `validateNotificationLink`
   (absent → null; valid → canonical stored form; malformed → **400
   `INVALID_NOTIFICATION_LINK`**, using `api.232`);
4. the response is honest: `{ ok: true, sent, skipped: { preferences,
   quietHours } }` where `sent` counts actual inserted rows. An entirely
   suppressed audience is a truthful **200 with `sent: 0`** plus the skip
   counts — not a fake success, not a spurious 400 (the admin UI's
   `notif.sent` toast keys off `sent` and shows 0 correctly).

Compatibility note: clients posting `target/title/message/type[/link]` see
the same 200 shape as before for deliverable audiences; the only intentional
behaviour change is that preference-disabled/quiet-hours users no longer
receive broadcast rows (that bypass was the flagged defect), plus the new
400 for malformed links (previously stored verbatim).

## 10. Concurrency

- Two fan-outs of the same lesson serialize on a per-lesson in-process mutex
  (`FAN_OUT_RUNS`), so the dedupe-check → createMany window can never
  interleave with itself (proven with a 40 ms-widened createMany window:
  two parallel runs, 3 rows total, zero duplicates; the interleaved pair
  reports `EMITTED` + `ALREADY_DELIVERED`, by sum exactly the deliver set).
- The documented deployment is ONE standalone Node server (Phases 2/13); the
  process lock is the whole guarantee there. A multi-instance deployment
  would additionally need a database advisory lock around the emit (noted as
  a known multi-instance limitation).
- The lifecycle flip itself is already serialized at the DB level
  (Phase 13's conditional `updateMany`); the two mechanisms compose.

## 11. Environment limitations (unchanged from Phases 9–16)

`prisma generate` / `prisma migrate status` / live Prisma-engine queries
remain impossible in this sandbox (`binaries.prisma.sh` unreachable; the
generated client is a type-only stub). Verification substitutes — the same
proven harness as Phases 13–16, no approximation:

- base DDL + EVERY real `prisma/migrations/*/migration.sql` applied verbatim
  by `scripts/lib/migrate-sqlite.mjs` (zero harness edits for Phase 17; the
  schema/migration column assertions pass, including for the two new
  columns — verified against a legacy pre-Phase-17 anchor row: `notifiedCount = 0`,
  `notifiedAt = NULL`, exactly the documented semantics);
- the real SQL executed by `scripts/lib/sqlite-prisma-lite.mjs` (createMany
  added this phase — real INSERT-per-row);
- the shipped modules compiled from `src/` with the repo's own tsc, real
  route handlers driven with real auth/response shims.
- `npm run build`: `next build` compiles the full graph (`✓ Compiled
  successfully`) then stops at the TypeScript gate showing exactly the 22
  pre-existing missing-Prisma-client errors (zero new from Phase 17);
  identical class to Phases 14–16 in this sandbox. Where engines are
  reachable: run `prisma generate && npm run build && bunx prisma migrate
  status` as the release gate, unchanged.

## 12. Load rehearsal (real DB, 2026-09-11)

OPEN (ceremony) + full fan-out against the migrated real-SQLite database,
with the 500-default chunking untouched:

| N (new eligible students) | eligible | delivered | chunks | time |
| ------------------------- | -------- | --------- | ------ | ---- |
| 1                         | 6        | 4         | 1      | 1 ms |
| 10                        | 16       | 14        | 1      | 2 ms |
| 100                       | 116      | 114       | 1      | 10 ms |
| 500                       | 616      | 614       | 2      | 26 ms |
| 1000 (total 1,616)        | 1,616    | 1,614     | 4      | **66 ms** |

Chunk sizes observed at N=1000+: exactly `500 / 500 / 500 / 114` (every full
chunk bounded; every insert a single `createMany`). Zero duplicates at every
size (distinct-user check per run); the scale replay inserts 0 rows; the
preview equals the fan-out at scale (eligible 1,616, delivered rows 1,614).

Delivered == eligible − 2 at every size, because two of the five pre-seeded
eligible students stay perma-skipped (one `newLesson=false`, one inside
quiet hours) — the preference contract holds at scale, as pinned.

No absolute performance claim is made beyond these measurements (sandbox,
in-memory seam at the shim boundary): the invariant they prove is
**bounded-work** — rows-per-statement and chunk count scale linearly with
recipient count, and the dedupe makes the replay path read-only-cheap.

## 13. Explicitly out of scope (strict phase boundary)

No parent auto-notification on session publish (parents keep the direct
enroll→admin alert path; parent-side consolidated refresh is a later phase's
brief). No teacher workflow completion, no parent redesign, no Postgres, no
CSP, no rate-limit program, no storage migration, no Phase 21/22 work, no
second notification type (`SESSION_OPENED` etc. were NOT invented — the
suite pins the absence), no `Lesson.status`/`isPublished` mirror writes, no
per-track publication segment state.

## 14. Files

```
src/lib/session-notifications.ts           (new — eligibility, templates, emit, preview)
src/lib/notification-links.ts              (new — validated link scheme over deep-link.ts)
src/lib/notify.ts                          (+ bulk partition/chunk/clock helpers; legacy helpers untouched)
src/app/api/admin/lessons/[id]/open/route.ts        (fan-out after live publication outcome)
src/app/api/admin/lessons/[id]/recipients/route.ts  (new — ADMIN preview, 404/409/200)
src/app/api/admin/notifications/route.ts            (prefs partition + chunked + validated link + honest sent)
src/components/admin/session-open-dialog.tsx        (preview + delivery-aware toasts)
src/lib/i18n-dict-2026.ts                           (api.230/231/232, admin.494–505 — ar+en)
prisma/schema.prisma                         (SessionPublication + notifiedCount/notifiedAt)
prisma/migrations/20260911000000_phase17_session_notifications/migration.sql (two additive ALTERs)
scripts/lib/sqlite-prisma-lite.mjs           (+ createMany delegate)
scripts/verify-phase17-notifications.mjs     (new — real-DB e2e)
tests/session-notifications-phase17.test.js  (new — 319-assertion suite)
tests/session-lifecycle-phase13.test.js      (1 pin amended by APPROVED plan: the Phase 13 forward-guard
                                              "publishing creates NO notification (Phase 17's job)" now
                                              pins the Phase 17-era route contract instead)
```
