# Phase 25 PR3 — Payment experience: student wizard + admin review UI (presentation layer)

PR3 is the **presentation layer** of Phase 25. It renders the payment journey on both
sides and it calls the APIs PR2a/PR2b already shipped. It contains **no new state
machine, no new transition, no new write path**. Everything a student can see and
everything an admin can decide is decided by `src/lib/payment-transitions.ts`; the UI
only reads contracts and posts the two existing decision calls.

---

## ⚠ 0. RELEASE COUPLING — READ BEFORE ANY DEPLOYMENT DISCUSSION

**PR2a + PR2b + PR3 ship as ONE atomic production release.**

- PR2a introduced the request columns (`senderPhone`, `requestedGroupId`,
  `requestedPlanId`) and the stale-payment ordering rule.
- PR2b introduced the closed transition guard + `approvePayment` / `rejectPayment`.
- PR3 is the only code that *collects* the request fields from a human and the only
  code that *calls* the decision endpoints.

Shipping PR3 without PR2b means the student wizard would collect a sender phone /
requested group / requested plan and a reference, and **nothing could ever approve
it** — the request would sit PENDING with no way out except a manual DB edit.
Shipping PR2a without PR2b produces the forbidden
`APPROVED` / `ACTIVE` / `groupId = NULL` false success. The three PRs are one
migration + one deploy. PR1 (the ledger) remains independently deployable because it
is additive, nullable, and unread.

---

## 1. What changed (file inventory)

New:

| File | Lines | Role |
| --- | --- | --- |
| `src/lib/payment-ux.ts` | 354 | Isomorphic, dependency-free presentation helpers: WhatsApp proof constants + `wa.me` href/message builders, per-method destination lookup + the shared `paymentMethodAvailable` availability rule (see §8), admin decision-error mapping, rejection-reason normalisation. No React, no `fetch`. |
| `src/components/shared/payment-proof.tsx` | 288 | The manual proof block: destination card, copy button, exactly two WhatsApp links, the "ONE number only" rule, review-time note, "attachment is manual" note. |
| `src/components/student/payment-status.tsx` | 465 | Student payment panel: current request state (pending / rejected / active), current entitlement, rejection reason + retry, history list. |
| `src/components/admin/payment-review-drawer.tsx` | 641 | Admin review drawer: full request + entitlement context, group override, approve, reject with mandatory reason (≤500), domain-error rendering, duplicate-reference warning. |
| `tests/helpers/payment-ux-harness.mts` | 1181 | jsdom harness that renders the **shipped** components (**215 assertions**), including section S1b for method availability. |
| `tests/payment-experience-phase25-pr3.test.js` | 549 | Plain-node suite: source pins + the shipped admin read handler over a fake db + harness driver (**128 assertions**). |

Modified:

| File | Change |
| --- | --- |
| `src/lib/i18n-dict-2026.ts` | +156 `pay.*` keys, each with `ar` + `en`. No raw copy in logic. |
| `src/components/auth/enroll-view.tsx` | Rewritten into the final wizard: real course/group/plan/amount, method instructions, sender phone, reference, proof step, submission, post-submit states. Method tiles and form validation both gate on the shared `paymentMethodAvailable` rule (§8). |
| `src/components/student/student-dashboard.tsx` | Payment panel type widening + renders `PaymentStatusPanel`. |
| `src/app/api/admin/payments/route.ts` | Read-only projection extended with the review context (see §5). Still zero writes. |
| `src/components/admin/admin-dashboard.tsx` | §7 `PaymentsView` rewritten as the review queue (columns, filters, drawer wiring). Bulk import untouched. |
| `tests/payment-lifecycle-phase25-ledger.test.js` | §0 re-pinned from "these fields must not appear" to "these fields may appear only in these files, for reading, never written" (134 → 138 assertions). |

Nothing else moved. No package changes, no lockfile churn, no schema change, no
migration, no `.env` change.

---

## 2. Student wizard (desktop two-column, mobile stacked, RTL)

`enroll-view.tsx` walks four steps — **Course → Plan → Transfer → Reference** — and a
post-submit state. Every value shown is the *actual selected* value:

- Course list from `/api/courses?catalog=1` (unchanged endpoint).
- Groups from `/api/groups?courseId=…`; changing the course clears the group list and
  the selection *during render* (React's documented "adjust state when a prop changes"
  pattern — no cascading effect writes, no new lint findings).
- Plan name / duration / price from the selected plan row; coupon discount and final
  amount rendered from the same row (`pay.originalPrice`, `pay.couponDiscount`,
  `pay.finalAmount`).
- `formatPaymentAmount` deliberately avoids `ar-EG` so the amount is `1,250` and not
  `١٬٢٥٠` — the student retypes this number into a banking app, and Arabic-Indic
  digits get misread there. This is a deliberate presentation decision, pinned by test.

Layout: `lg:grid-cols-2` two-column on desktop (summary rail + form), single column
stacked on mobile, `dir="rtl"` copy coming from the ar dictionary. framer-motion
`mode="wait"` step transitions are ~300 ms; the harness waits 400 ms per click.

Validation is client-side UX only (`pay.needMethod`, `pay.methodUnavailable`,
`pay.needSenderPhone`, `pay.needReference`, `pay.senderPhoneInvalid`,
`pay.referenceInvalid`). **The server stays authoritative** — `/api/enroll`
re-validates and returns its own domain codes. One validation rule is a hard safety
gate rather than a courtesy: a payment method with no configured destination can never
be selected or submitted (§8.3).

---

## 3. Proof instructions — the manual WhatsApp flow

Constants live in `src/lib/payment-ux.ts`:

```ts
export const PAYMENT_PROOF_WHATSAPP_NUMBERS: readonly string[] = [
  "01147422177",
  "01099942942",
];
```

The first of these is also the confirmed transfer destination for InstaPay and e& Cash;
the second is proof/review only (§8.1–8.2).

- Exactly **two** `wa.me` links are rendered (`whatsapp-proof-link` appears exactly
  twice — pinned).
- Both numbers are normalised through `normalizeEgyptianWhatsappNumber` (handles
  `01xxxxxxxxx`, `+201xxxxxxxxx`, `201xxxxxxxxx`, spaces/dashes) so the href is always
  a valid international number.
- The student is told to send the proof to **ONE** number only, verbatim:
  `"مش محتاج تبعت الصورة على الرقمين — اختار رقم واحد فقط."` (`pay.oneNumberOnly`),
  rendered both in the proof block (`whatsapp-one-number-only`) and after submission.
- The prefilled message (`pay.proofMessage`) contains exactly: student name, amount,
  method label, transaction reference, sender phone. It contains **no** `CM-XXXXXX`
  student code and **no** internal id (`userId`, `paymentId`, `subscriptionId`,
  `planId`, `groupId`, `courseId`) — asserted per-id in the harness and against the
  dictionary template in the node suite.
- The attachment is described as **manual**: the student takes the screenshot in their
  banking app and sends it themselves. There is no upload anywhere: no `<input
  type="file">`, no R2, no presigned URL, no `MediaAsset`, no attachment API in any
  PR3 file (grep-verified).
- Review time is stated as "up to 24 hours":
  `"مراجعة طلب الدفع ممكن تستغرق لحد 24 ساعة"` (`pay.reviewTime`).

---

## 4. Student states (pending / rejected / active) + history

`payment-status.tsx` renders the student's current request from
`GET /api/students/me/payments` (unchanged contract):

- **PENDING** — `pending-state` / `pending-title` "طلب الدفع تحت المراجعة". If the
  student already has an active entitlement, the panel says explicitly that the current
  subscription **continues until its end date** (`pay.pendingAccessStillOn`,
  `panel-pending-end-date`, `rejected-access-kept` / `pendingCurrentEndsAt`) — a
  renewal under review never reads as "you lost access". New students see
  `pay.pendingNewStudent` instead. Pending is **never** rendered with active styling
  or active copy (pinned).
- **REJECTED** — "تم رفض طلب الدفع" (`pay.rejectedTitle`), the admin's rejection
  reason verbatim (`rejected-reason`, `panel-rejected-reason`), the current
  entitlement line when one still applies, and a retry path (`panel-retry` /
  `pay.openNewRequest`).
- **ACTIVE** — "تم تأكيد اشتراكك" (`pay.confirmedTitle`) with start/end dates.
- **History** — every request with status, method, amount, reference, date
  (`panel-history-list`), empty state via `pay.historyEmpty`.

Copy discipline: activation is phrased as *"تفعيل اشتراكك وفتح محتوى الكورس"*, renewal
as *"تجديد اشتراكك"*. The word **"grandfathered" is never shown to an end user** — the
admin queue may label it internally, the student surface never does.

---

## 5. Admin read contract — `GET /api/admin/payments` (still read-only)

The handler now returns, per row: `userPhone` (registered), `senderPhone`,
`requestedGroupId`, `requestedPlanId`, `requestedPlan{id,name,nameAr,durationMonths,
price,isActive}`, `requestedGroup{id,name,isActive,capacity,courseId,schedule,
seatsUsed}`, `reviewedAt`, `rejectionReason`, `duplicateReference` (reference matches
another PENDING row under `referenceComparisonKey` — the **server's** normalisation,
imported, not re-implemented), `isLatestPending` (newest PENDING per user, `null` for
decided rows), and `studentContext{groupId,groupName,courseId,currentPlanName,
subscriptionStatus,hasSubscription,accessAllowed,grandfathered,state,startDate,
endDate,daysToExpiry,parentPhone}` labelled by the **shared pure policy**
(`evaluateAccessDecision` / `describeSubscriptionState`), resolved with ONE batched
`db.student.findMany` (no N+1).

Guarantees proven by the test against a **mutation-hostile fake db** (every write
method throws): zero writes, `reviewedByUserId` is never serialised to the client,
dangling plan/group ids resolve to `null` instead of throwing, stale pending rows are
ordered correctly, duplicate references are detected across *all* pending rows, and a
non-admin gets `403`.

---

## 6. Admin review drawer + the two decision calls

`payment-review-drawer.tsx` posts only to the existing PR2b endpoints:

- **Approve** → `POST /api/admin/payments/[id]/approve` with body `{}` or `{ groupId }`
  (group override only — nothing else).
- **Reject** → `POST /api/admin/payments/[id]/reject` with body `{ reason }`. The
  reason is required, trimmed, and capped at `REJECTION_REASON_MAX_LENGTH = 500`
  (mirrors the server constant) with a live counter and inline errors
  (`pay.rejectReasonRequired`, `pay.rejectReasonTooLong`).

Context shown before deciding: student, registered phone, sender phone, reference
(+ duplicate warning `warning-duplicate`), requested plan, requested group, current
group/plan/subscription, entitlement state (`drawer-entitlement`), seats left in the
target group, schedule. The group override Select lists only active groups of the
same course with capacity context; the server still re-checks everything.

Behaviour rules, all pinned by the harness:

- Double-submit is blocked by an `inFlight` ref (`pay.approving`).
- Failures render `role="alert"` with `data-code` and **never** flip the row's status
  locally — the queue is re-read from the server.
- Already-decided payments show `already-decided` instead of action buttons.
- The drawer resets per **payment id**, not per object identity, so the admin's
  in-progress override/reason survives the queue refresh that follows a decision.

---

## 7. Domain-error UX (`src/lib/payment-ux.ts`)

13 server codes map to one i18n key each, unknown codes fall back to
`pay.errorGeneric` (never a raw server string, never a stack):

| Server code | Key | Extra UI behaviour |
| --- | --- | --- |
| `GROUP_REQUIRED` | `pay.errorGroupRequired` | group-recovery: force the override Select open |
| `GROUP_FULL` | `pay.errorGroupFull` | group-recovery |
| `GROUP_NOT_FOUND` | `pay.errorGroupNotFound` | group-recovery |
| `INVALID_GROUP_CONTEXT` | `pay.errorInvalidGroupContext` | group-recovery |
| `PLAN_REQUIRED` | `pay.errorPlanRequired` | plan-blocked: tells the admin the student has no valid plan |
| `PLAN_NOT_FOUND` | `pay.errorPlanNotFound` | plan-blocked |
| `STALE_PAYMENT` | `pay.errorStale` | refresh: queue is re-read (newer request exists) |
| `INVALID_TRANSITION` | `pay.errorInvalidTransition` | refresh |
| `PAYMENT_NOT_FOUND` | `pay.paymentNotFound` | refresh |
| `DB_CONFLICT` | `pay.errorDbConflict` | refresh |
| `NO_STUDENT` | `pay.errorNoStudent` | — |
| `INVALID_REJECTION_REASON` | `pay.errorInvalidRejectionReason` | — |
| (other) | `pay.errorInternal` / `pay.errorGeneric` | — |

`PAYMENT_DECISION_REFRESH_CODES` and `PAYMENT_DECISION_GROUP_RECOVERY_CODES` drive the
"refresh the queue" vs "ask for a group" behaviour, so a stale decision never leaves
the admin looking at a row the server already moved on from.

---

## 8. Payment destinations — confirmed truth + the availability guard

### 8.1 The destination truth (confirmed by the business owner)

`01147422177` — rendered as `+20 1147422177` / `+201147422177` — is **intentionally**
the real receiving destination for **both** launch methods:

| Method | Destination | Status |
| --- | --- | --- |
| `INSTAPAY` | `+20 1147422177` | confirmed receiving destination |
| `ETISALAT_CASH` (e& Cash) | `+20 1147422177` | confirmed receiving destination — **the same line, by design** |
| `VODAFONE_CASH` | `null` | no destination, not launch-enabled |

The single shared line is a deliberate launch decision, not an unresolved gap:
`brand.payments.instapay` and `brand.payments.eCash` both reference the same
`SUPPORT_PHONE_DISPLAY` constant in `src/lib/brand.ts`, whose header comment already
scoped that line to "contact sections, WhatsApp support, and manual payment
gateways", and the pre-PR3 landing copy (`landing.087` / `landing.093` and the pricing
section) published the same number for both methods in Arabic and English.

`01147422177` is therefore **both** a real payment destination **and** one of the two
approved WhatsApp proof/review numbers. That dual role is intentional.

### 8.2 WhatsApp proof numbers (unchanged)

```ts
export const PAYMENT_PROOF_WHATSAPP_NUMBERS: readonly string[] = [
  "01147422177",  // also the confirmed transfer destination
  "01099942942",  // proof / review ONLY — NOT a payment destination
];
```

`01099942942` is **not** a transfer destination and is never rendered as one. It
appears only as the second approved proof/review line. The student sends the
screenshot to **one** number only.

### 8.3 The availability guard (final UI safety rule)

A payment method is available **only when both** hold:

1. it is an allowed launch payment method (`LAUNCH_PAYMENT_METHODS`), **and**
2. `paymentDestinationFor(method)` resolves to a **non-empty** configured destination.

That rule lives in exactly one place — `paymentMethodAvailable()` in
`src/lib/payment-ux.ts` — and both consumers read it, so the selector and the form
validation can never disagree:

- **Selector:** an unavailable method renders **disabled** (`disabled` +
  `aria-disabled="true"`, never `aria-pressed`) with the `pay.methodUnavailable` badge
  ("مش متاحة حاليًا"); a known not-yet-launched method keeps `pay.methodComingSoon`
  ("قريبًا"). It cannot be selected, so no destination block and no transfer
  instructions are shown for it.
- **Validation:** `validateForm` refuses an unavailable method with
  `pay.methodUnavailable` **before** any network call, so **no `/api/enroll` request is
  sent** — even if component state somehow already holds that method (e.g. the
  configuration changed while the page was open).

Current final behaviour:

| Method | Destination | Available? | Selectable? | Submit? |
| --- | --- | --- | --- | --- |
| `INSTAPAY` | exists | **yes** | yes | allowed |
| `ETISALAT_CASH` | exists | **yes** | yes | allowed |
| `VODAFONE_CASH` | `null` / not launch-enabled | **no** | no (disabled) | blocked |

No method ever borrows another method's destination: an unconfigured method is simply
unavailable. Destination **values** were never changed by PR3 — `src/lib/brand.ts` is
untouched. This is presentation-layer defense in depth; the server stays the authority
(`/api/enroll` re-validates, and it independently refuses `VODAFONE_CASH` with
`api.266`).

### 8.4 Genuine PR4 / cutover handoff items

1. **No plan-override parameter.** `approvePayment` resolves the plan as
   `payment.requestedPlanId` → the student's currently valid plan → `PLAN_REQUIRED`.
   The review drawer can override the *group* but cannot override the *plan*. This is
   a real backend contract gap and belongs to PR4.
2. **`VODAFONE_CASH` is in the enum but has no destination and is not launch-enabled.**
   Correctly rendered as unavailable today; opening it needs a configured destination
   plus a decision to add it to `LAUNCH_PAYMENT_METHODS` and to the server's
   `SUPPORTED_PAYMENT_METHODS`.

### 8.5 Optional operations / configuration improvement (NOT a PR3 blocker)

Payment destinations are compiled constants in `src/lib/brand.ts`, so changing one is
a config-only code edit plus a redeploy; an admin cannot change it from the Settings
UI. Moving them into admin-managed `Setting` rows (e.g. `payment_instapay`,
`payment_ecash`, with `brand.ts` as fallback) would make them operationally
configurable without a deploy — and needs **no schema migration**, because `Setting`
is already a generic key/value table.

This is an **OPTIONAL OPERATIONS/CONFIGURATION IMPROVEMENT**. It is **not** required
for launch correctness and **not** a PR3 blocker: the business owner has confirmed the
current destination, so PR3 ships as-is.

---

## 9. Security surface

- The admin route stays read-only and admin-gated (403 proven by test).
- `reviewedByUserId` is written only by `src/lib/payment-transitions.ts` and is never
  serialised to any client — the ledger §0 invariant holds (scoped to files that touch
  `db.payment`; `src/lib/teacher-applications.ts` legitimately owns the same column
  name for teacher approvals and is out of that scope).
- No new endpoint, no new write path, no new secret, no gateway, no OCR, no WhatsApp
  Business API, no automatic sending — the `wa.me` links are plain links the student
  taps.
- Client-side validation is a courtesy; `/api/enroll` and the decision endpoints
  re-validate everything.

---

## 10. Non-goals (deliberately NOT in PR3)

No payment gateway, no automatic InstaPay/e& verification, no Stripe/Paymob/Fawry,
no OCR of screenshots, no screenshot upload / R2 proof storage / attachment API /
`MediaAsset` / proof table, no automatic WhatsApp sending, no plan override, no change
to `approvePayment` / `rejectPayment` / stale logic / capacity locking / advisory
locks / date stacking / coupon release / audit decisions.

---

## 11. Verification (this sandbox)

Run commands and results:

| Command | Result |
| --- | --- |
| `node tests/payment-experience-phase25-pr3.test.js` | **128 passed, 0 failed** |
| `node node_modules/tsx/dist/cli.mjs tests/helpers/payment-ux-harness.mts` | **215 passed, 0 failed** |
| `node tests/payment-lifecycle-phase25-ledger.test.js` | **138 passed, 0 failed** (was 134 before the deliberate §0 re-pin) |
| `node tests/payment-lifecycle-phase25-pr2a.test.js` | 168 passed, 0 failed |
| `node tests/payment-lifecycle-phase25-pr2a-grandfather.test.js` | 32 passed, 0 failed |
| `node tests/payment-lifecycle-phase25-pr2b.test.js` | 252 passed, 0 failed |
| `node tests/payment-lifecycle-phase25-pr2b-concurrency.test.js` | 114 passed, 0 failed |
| `node tests/payment-lifecycle-phase25-pr2b-fullchain.test.js` | 135 passed, 0 failed |
| `node tests/payment-lifecycle-phase25-pr2b-utc-tz.test.js` | 863 passed, 0 failed (10 timezones) |
| `node tests/security-audit-gate.test.js` | 116 passed, 0 failed |
| `node tests/authorization-invariants.test.js` | 93 passed, 0 failed |
| All other `tests/*.test.js` (phases 8–24) | all exit 0 |
| `npx tsc --noEmit` | exactly the **10 pre-existing** `TS2305` errors from the ungenerated `@prisma/client`; **0** errors with a local type shim |
| `npx next build` | **✓ Compiled successfully** + **✓ Finished TypeScript**, then stops at page-data collection instantiating the ungenerated Prisma client (`src/lib/db.ts:9`) — **identical** to a stashed baseline build on the same setup |
| `npx eslint` on all touched files | **no new findings** — the 9 `react-hooks/set-state-in-effect` hits in the two dashboards are the pre-existing set (verified by a stashed baseline run) |
| `npx prisma generate` | **blocked** in this sandbox (TLS to the engines CDN refused; the proxy allows only the npm registry) — hence the shim + the build wall above |

The counts above include the **destination-safety guard** verification added after the
PR3 audit: harness section **S1b** renders the shipped `EnrollView` and proves that
InstaPay and e& Cash stay selectable and submittable while a configured destination
exists, that Vodafone Cash is disabled, that a method whose destination disappears at
runtime posts **nothing** to `/api/enroll` and surfaces "مش متاحة حاليًا", that an
empty destination disables the tile, and that no method ever borrows another's
destination; the node suite pins the helper's shape, both call sites, and that the four
destination values in `src/lib/brand.ts` are unchanged (pins 1.40–1.49).

Two honest walls, both environmental and both pre-existing:

1. `prisma generate` cannot run offline → 10 standing `tsc` errors and a `next build`
   that cannot finish page-data collection. Baseline parity was proven by stashing
   PR3 and rebuilding.
2. `tests/final-integration-phase22.test.js` exits non-zero on
   `db/custom.db missing for curriculum check` — the local dev database file is not in
   the repository (`/db/` is gitignored) and PR3 touches no database file. Every other
   suite passes.

Playwright/Chromium is not installed here, so `tests/visual/*` and
`tests/i18n/audit-ui.mjs` were not run; visual/RTL verification is covered
structurally by the jsdom harness (rendered shipped components, both locales).
