# Phase 25 PR2a — Payment lifecycle: submit / read / access groundwork

**Status:** implemented and verified in-repo (see §6). No commit, no push, no
PR, no migration, no production operation.

PR2a converts the enrollment pipeline to the Phase 25 v2 architecture —

> Subscription = the current student **ENTITLEMENT**.
> Payment = an individual payment **REQUEST**.
> `Student.groupId` = the currently active group assignment.
> A pending payment request is NOT an entitlement.

— WITHOUT touching what approval does. It refactors submission to record
intent on the Payment row, makes the two central authorization paths
entitlement-aware (with legacy grandfathering preserved), fixes the student
dashboard's entitlement labeling, and adds a truthful student payment read
API so PR2b (decisions) and PR3 (experience) can build on honest data.

---

## ⚠ 0. RELEASE COUPLING — READ BEFORE ANY DEPLOYMENT DISCUSSION

**PR2a is NOT independently production-deployable.
PR2a + PR2b + PR3 form ONE atomic production release.**

PR2a removes the legacy "`POST /api/enroll` assigns `Student.groupId`
immediately" behavior. The CURRENT (legacy) approval handler
(`POST /api/admin/payments/[id]/approve`) does not read
`Payment.requestedGroupId` / `Payment.requestedPlanId` and does not assign
`Student.groupId`. Deploying PR2a without PR2b would therefore strand every
new student in exactly the state PR1's release rule forbids:
`Payment APPROVED / Subscription ACTIVE / Student.groupId NULL`.

This is intentional. Do NOT "fix" it by extending the legacy approval handler
inside PR2a — that belongs to PR2b and PR2a deliberately leaves the clean
handoff described in §5. A coordinated full-chain test
(new student → submit → PENDING + no group + no access → approve → APPROVED +
ACTIVE + group assigned → access true) is authored once PR2b exists.

---

## 1. What changed (file inventory)

| File | Change |
| ---- | ------ |
| `src/lib/subscription-entitlement.ts` | **NEW.** The ONE entitlement policy: `isSubscriptionValidForAccess`, `evaluateAccessDecision`, `describeSubscriptionState`, `resolveStudentEntitlement` (read model). Pure + side-effect free; lazy expiry (no stored EXPIRED transition required, no writes, no cron). |
| `src/lib/payment-submission.ts` | **NEW.** V2 submission core: method/senderPhone/reference validation + normalization (uses the project's Egyptian phone helpers in `registration.ts`), the single `$transaction` body (`submitPaymentRequest`) for the three scenarios (§2 A/B/C — incl. the audit-fix LEGACY_GRANDFATHERED path: no Subscription row manufactured, `Payment.subscriptionId = null`), and the student payment read contract (`fetchStudentPayments`). `db` injected → the shipped code is what the tests execute. |
| `src/lib/enrollment.ts` | `getEnrollment` now applies the shared decision: `isEnrolled` = ACTIVE group + course **and** current entitlement valid (or legacy grandfathered). Additive fields: `hasSubscription`, `grandfathered`. The stale "DELIBERATELY NOT AN ACCESS GATE" comment replaced with the PR25 contract. |
| `src/lib/session-progress.ts` | `canAccessLesson` reads the subscription singleton on the student row it already loads and denies via the SAME `evaluateAccessDecision`; `getUnlockedLessonIds` (the batch gate the dashboard + homework list + course tree derive from) applies the identical decision → denied ⇒ empty set. Quizzes/homework/materials inherit via delegation; zero local date logic anywhere. |
| `src/app/api/enroll/route.ts` | REWRITTEN as submission V2 (see §2). Carries the release-coupling warning inline. |
| `src/app/api/students/me/payments/route.ts` | **NEW.** `GET /api/students/me/payments` — the authenticated student's own request history + entitlement snapshot (§3). |
| `src/app/api/students/me/dashboard/route.ts` | Subscription block re-sourced from the central policy (§4): PENDING is labeled PENDING, lazily-expired ACTIVE is labeled EXPIRED, CANCELLED no longer falls through to "ACTIVE". Adds `paymentRequests.pending/rejected` and `accessAllowed/grandfathered/rawStatus/hasSubscription` to the payload — data contract only, no UI redesign. |
| `src/components/student/student-dashboard.tsx` | Minimal honesty fix ONLY: the subscription pill gains a dedicated PENDING badge branch ("request under review"). PR3 owns the real payment UX. |
| `src/components/auth/enroll-view.tsx` | Minimal contract hook ONLY: a sender-phone field on the payment step + `senderPhone` in the POST body + confirmation row. No wizard redesign, no WhatsApp-proof changes (PR3). |
| `src/lib/i18n-dict-2026.ts` | NEW KEYS ONLY (hand-maintained dict, per the file header rule): `api.266` (method not supported), `api.267` (sender phone required/invalid), `api.268` (reference required), `auth.226/227` (sender-phone label/placeholder), `student.249` (pending badge). ar+en for every key. |
| `tests/payment-lifecycle-phase25-pr2a.test.js` | **NEW.** 162 assertions: behavioural (compiled shipped TS vs fakes) + source-level pins (§5). |
| `tests/payment-lifecycle-phase25-pr2a-grandfather.test.js` | **NEW (pre-commit audit).** 32 assertions on a shared mutable store driving the shipped submit + ALL central read paths (getEnrollment / canAccessLesson / getUnlockedLessonIds / resolveStudentEntitlement): grandfathered access survives submission and retries; Payment carries the intent with `subscriptionId = NULL`; controls pin that new students still get the PENDING row, ACTIVE renewals stay untouched, and an inactive legacy group does NOT qualify for grandfather preservation. |
| `tests/payment-lifecycle-phase25-ledger.test.js` | §0 RE-PIN (PR1 protocol): request fields referenced ONLY by the PR2a allowlist; reviewedAt/rejectionReason only in the read-contract files; `reviewedByUserId` unreferenced by payment code. Nothing else touched. 134/0. |
| `tests/security-audit-gate.test.js` | One F-04 ordering assertion re-pointed at the transaction boundary (`submitPaymentRequest(` is where the `$transaction` now runs). 116/0 incl. the real-HTTP leg. |
| `scripts/verify-security-audit-gate.mjs` | §5 (real SQLite + real HTTP, `/api/enroll`): extended for the V2 contract — missing senderPhone/reference → 400; a valid submission creates PENDING payment (senderPhone/reference/requestedGroupId/requestedPlanId persisted on real rows) + PENDING subscription and provably does NOT assign `Student.groupId`. |
| `tests/parent-analytics-alignment-phase19.test.js` | Fixture line added: `payment: []` table for the generic mock (the student dashboard route now reads request history). No assertion changes. |

**No schema/migration changes. No changes to:**
`prisma/**`, `scripts/db/**`, approval/rejection/import routes, R2/storage,
Vercel, cron, notifications lib, lockfiles, `.env*`.

## 2. Enrollment V2 — submission semantics

`POST /api/enroll` (STUDENT-role, session identity only — the body can carry
no userId/studentId; nothing client-supplied selects status, plan of the
ENTITLEMENT, group of the STUDENT, or approval):

Shared validations kept: course exists; group exists ACTIVE and bound to the
course (F-04); group capacity PRE-CHECK (advisory — the authoritative capacity
decision with locking is PR2b's); coupon rules unchanged (amount, notes,
redemption inside the same transaction).

New V2 contract fields: `senderPhone` REQUIRED (validated + normalized via the
project's `isValidEgyptianPhone`/`normalizePhone`; stored canonical local form
`01XXXXXXXXX`); `reference` REQUIRED (trim + whitespace collapse, 3–64 chars,
deliberately loose — no charset/format gate, and **no uniqueness rule ever**;
duplicates are flagged on READ, never rejected); `method` restricted to the
manual launch (`INSTAPAY`, `ETISALAT_CASH`; `VODAFONE_CASH` is a known enum
member with its own not-available message; unknown values reuse the existing
required-fields refusal).

**Scenario A — new / unentitled student** (no valid entitlement: no group, or
no Subscription row and no grandfather-qualifying group, or a row that is
PENDING / CANCELLED / stored-EXPIRED / lazily-expired):
- singleton Subscription: CREATED PENDING (no row) or UPDATED to PENDING with
  the requested planId (stale row) — never a second row (retry/idempotency
  safe under the `studentId @unique` singleton);
- Payment: PENDING with `senderPhone`, `reference`, `requestedGroupId`,
  `requestedPlanId`, coupon-adjusted amount, `subscriptionId` linking the
  entitlement row the request targets;
- `Student.groupId` **not written** — submitting payment does NOT open the
  course. No batch mutation on the student row occurs because no group
  changed (the Phase 12 heal `reconcileStudentBatch` remains wired post-commit
  — idempotent, can never attach a student to an unapproved course: content
  stays gated by the entitlement-aware `getEnrollment`).

**Scenario B — ACTIVE + unexpired renewal:**
- a new PENDING Payment carrying the renewal intent (`requestedGroupId`,
  `requestedPlanId`, `senderPhone`, `reference`, `subscriptionId` = current
  row) for PR2b's atomic approval (stack dates / switch plan+group AT
  APPROVAL TIME);
- the current Subscription is NOT touched at all: no ACTIVE→PENDING downgrade,
  no planId/startDate/endDate change, no group switch; access continues
  uninterrupted while the renewal is pending.

**Scenario C — LEGACY GRANDFATHERED (pre-commit audit fix, 2026-09-14):**
the student has NO Subscription row and their group half of the central
policy passes — `Student.groupId` set, group EXISTS, `isActive`, bound to a
course (`courseId != null`). That grandfathered access IS their current
entitlement, and the policy makes any Subscription row authoritative the
moment it exists (PENDING ⇒ deny). Behavior at submission:
- **no Subscription row is created or updated** (creating one would revoke
  access instantly — the exact lockout the Phase 25 requirement forbids);
- a PENDING Payment is created with the full intent (`senderPhone`,
  `reference`, `requestedGroupId`, `requestedPlanId`) and
  **`subscriptionId = NULL`** — schema-legal since PR1, no migration;
- `Student.groupId` untouched; access stays fully intact on every central
  path (`getEnrollment`, `canAccessLesson`, `getUnlockedLessonIds`,
  `resolveStudentEntitlement` all keep reporting allowed + `grandfathered`,
  entitlement label `NONE` — nothing is dressed up as ACTIVE);
- retries append Payment history only, and still never manufacture a row.
The grandfather predicate is not re-derived: submission calls the SAME
`evaluateAccessDecision` the authorization paths use and takes its
`grandfathered` verdict, so submit and access cannot drift. This is purely a
submission-path fact — the access matrix in §4 is byte-for-byte unchanged,
PENDING subscriptions still deny, and a row (whenever one exists) is still
authoritative. Pinned behaviorally by
`tests/payment-lifecycle-phase25-pr2a-grandfather.test.js` (shared mutable
store: the same shipped code performs the writes the authz reads observe).

Stale/multiple pending requests: repeated submissions append Payment history
(by design) and never cancel, expire, or supersede older PENDING rows — read
payloads are newest-first (`createdAt desc, id desc`) so PR2b's
"latest request wins / refuse stale approval" rule is directly representable.
No payment destruction, no transition logic here.

## 3. Payment read contract (`/api/students/me/payments`)

Ownership: no route parameter exists; `userId` comes from the session, so
another student's rows are unreachable. Payload:

- `payments[]` newest-first (capped 50): id, status, amount, method,
  reference, senderPhone, `requestedPlanId`/`requestedGroup` resolved to
  display objects (FK-less ids pointing at deleted rows read `null`),
  `rejectionReason` (owner's own), `reviewedAt`, `createdAt`,
  `duplicateReference` flag (same normalized reference among PENDING rows).
  NEVER selected: `notes` (admin scratch), `updatedAt`, `reviewedByUserId`.
- `latestPending` / `latestRejected` — the REQUEST side.
- `entitlement` — the CURRENT entitlement: `hasGroup/groupActive/groupId/
  groupName/courseId`, `subscriptionStatus` (raw), `hasSubscription`,
  `accessAllowed` (policy verdict incl. lazy expiry), `grandfathered`, `state`
  (UI-truth label), `daysToExpiry`, dates, plan.

Dashboard payload (`/api/students/me/dashboard`) carries the same
distinction: `subscription.status` ∈ ACTIVE|EXPIRING|PENDING|EXPIRED|NONE
(CANCELLED maps to NONE — "no live entitlement", never "Active") +
`rawStatus/accessAllowed/grandfathered/hasSubscription`, plus
`paymentRequests.pending` / `paymentRequests.rejected`. A PENDING request can
no longer be presented as an active paid entitlement at either layer (the
pre-25 dashboard's final `else` literally labeled PENDING rows "ACTIVE" —
that line is now a pinned regression).

## 4. Access matrix as enforced

| state | paid course access |
| ----- | ------------------ |
| no group | ✗ |
| group + no Subscription (legacy) | ✓ grandfathered (access only; never labeled as a PAID state in any payload) |
| group + PENDING subscription | ✗ |
| group + ACTIVE, endDate future (or null) | ✓ |
| group + ACTIVE, endDate past | ✗ (lazy — row NOT rewritten) |
| group + stored EXPIRED / CANCELLED / unknown | ✗ |
| Payment PENDING/APPROVED/REJECTED/EXPIRED alone | grants nothing — the Subscription row is the sole entitlement lever |

Authorization reads are side-effect free (the tests turn ANY write into a
hard failure). Denials reuse `NOT_ENROLLED` so the response shape of the
existing progression contract is unchanged (403 + code); richer
payment-specific copy is PR3's UI concern.

## 5. Deliberate non-goals → PR2b/PR3 handoff

NOT implemented (by design, PR2b): approve/reject rewrites; approval/rejection
transactions; activation on approval; `Student.groupId` assignment; capacity
locking (advisory locks); GROUP_FULL / GROUP_REQUIRED / PLAN_REQUIRED
resolution; admin group override; coupon release on rejection; reviewer audit
fields write (`reviewedByUserId` — unreferenced in payment code, pinned);
post-decision notifications; import-transition rewrite; stale-pending
auto-supersede; renewal date stacking; approval-time plan/group switching.
NOT implemented (PR3): payment wizard redesign, WhatsApp proof buttons/prefill
(numbers `01147422177` / `01099942942`, one number, no `CM-` code in the
message — preserved for PR3), admin review drawer, pending/rejected page UX.
NOT implemented at all: screenshot upload, R2 payment proof, gateways
(Stripe/Paymob/Fawry), automatic InstaPay/e& Cash verification.

**Mandatory PR2b addition (from the §2 Scenario-C fix):** approval of a
LEGACY_GRANDFATHERED Payment arrives with `payment.subscriptionId === null`.
The current legacy handler is crash-safe for it (activation is guarded by
`if (payment.subscription)`) but does the WRONG thing silently: approval with
no effect. PR2b approval MUST therefore, in one atomic transaction: resolve
the Student via `payment.userId`; resolve the plan via
`payment.requestedPlanId`; CREATE the singleton Subscription (studentId,
planId, ACTIVE, dated) when no row exists — otherwise update+activate it;
assign `Student.groupId` from `payment.requestedGroupId` (with the existing
capacity/locking and `reconcileStudentBatch` post-commit); keep the Payment
APPROVED. Rejection of such a Payment needs no compensation — no row was ever
made, and grandfathered access was never contingent on the request.

Known, inherited-by-design (reported per §7): `GET /api/media/[id]` authorizes
session-video bytes by BATCH membership + publication + track (Phase 12/16/21
contract, predates the paywall and is untouched by PR2a). It cannot expose
course/lesson content (everything else inherits `getEnrollment` /
`canAccessLesson`), but if the release train wants recordings gated by
entitlement too, that merge belongs in the coordinated PR2b+PR3 review, not
sneaked into PR2a.

## 6. Verification (this sandbox)

- `node tests/payment-lifecycle-phase25-pr2a.test.js` → **162 / 0**
- `node tests/payment-lifecycle-phase25-ledger.test.js` → **134 / 0**
- `node tests/security-audit-gate.test.js` (incl. real-HTTP script leg) → **116 / 0**
- `session-progression` 162/0 · `authorization-invariants` 93/0 ·
  `track-architecture-phase12` 304/0 · `session-lifecycle-phase13` 299/0 ·
  `session-materials-phase14` 127/0 · `admin-publishing-phase15` 384/0 ·
  `student-locked-curriculum-phase16` 366/0 · `session-notifications-phase17` 319/0 ·
  `teacher-workflow-phase18` 365/0 · `parent-analytics-alignment-phase19` 176/0 ·
  `teacher-application-phase20` 75/0 · `security-hardening-phase20` 192/0 ·
  `security-hardening` 279/0 · `production-storage-phase21` 178/0 ·
  `migration-sql` 15/0 · `platform-upgrade-2026-migration` 98/0 ·
  `mock-exam-phase8` 135/0 · `calendar-i18n-phase9` 444/0 · `kodgy-phase10` 231/0 ·
  `curriculum-reconciliation-phase11` 56/0 · `registration-validators` 24/0 ·
  `seed-idempotency` 18/0 · `media-storage-wiring` 318/0 · `s3-storage-r2` 184/0 ·
  `quiz-analytics` 44/0 · `session-quiz` 70/0 · `parent-dashboard-isolation` 112/0 ·
  `mock-exam-grading-isolation` 22/0 · `presigned-uploads-phase23` 327/0 ·
  `vercel-cron-retention-phase24` 161/0
- `final-integration-phase22`: fails IDENTICALLY on baseline and PR2a tree —
  `db/custom.db` environmental wall (documented since PR1); untouched by this PR.
- `npx tsc --noEmit`: byte-identical error set to baseline (10 errors, all
  from the ungenerated `@prisma/client` — `binaries.prisma.sh` unreachable in
  this sandbox, the PR1-documented standing blocker; `prisma generate` was
  attempted and is the sole blocker). With a temporary non-committed type-shim
  for the ungenerated module, the FULL repo (src+scripts) typechecks with
  **0 errors**, including every PR2a file.
- `npx next build` (scratch copy, shimmed client): **Compiled successfully** +
  **Full TypeScript validation finished**; both trees then stop identically at
  page-data collection instantiating the ungenerated Prisma client runtime —
  the same environmental wall, not a PR2a defect. Baseline parity proven on the
  identical setup.
- ESLint: no new problems (3 pre-existing `react-hooks/set-state-in-effect`
  findings unchanged; all other touched files clean).
- `node --check` on every touched .mjs/.test.js.

## 7. Dual-engine notes

Everything added is plain Prisma CRUD + pure date math: no `FOR UPDATE`, no
advisory locks, no raw SQL, no PG-only constructs (pinned by the test). The
single `$transaction` shape matches both SQLite (local/test) and Neon
PostgreSQL. Date handling normalizes only Date/epoch/ISO-UTC and FAILS CLOSED
on unparseable non-null values (no locale parsing anywhere). No cron added
(expiry is lazy; Phase 24's Hobby-cron budget untouched). No schema change —
PR1's migration `20260914120000_payment_lifecycle_redesign` already ships every
column PR2a writes, and the ledger test still counts exactly 10 migrations.
