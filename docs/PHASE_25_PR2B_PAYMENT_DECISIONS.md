# Phase 25 PR2b — Payment decisions: approve / reject (the decision layer)

**Status:** implemented and verified in-repo (see §9). No commit, no push, no
PR, no migration, no production operation.

PR2b completes the Phase 25 v2 handoff from PR2a: a Payment is a REQUEST, and
an ADMIN DECISION is the only moment a request becomes (or fails to become)
an entitlement. This pull request adds ONE shared decision service, rewrites
the approve/reject routes as thin admin shells over it, constrains the import
route to PENDING ledger entries, generalizes the Phase 23 advisory-lock
primitive into a per-group seat lock, and proves the whole
submit → decide → entitlement chain over real HTTP + real SQLite.

The v2 rules this code enforces (see `PHASE_25_PR1_PAYMENT_LEDGER.md` §goals
and `PHASE_25_PR2A_PAYMENT_LIFECYCLE.md`):

> Subscription = the current student **ENTITLEMENT** (singleton,
> `studentId @unique`).
> Payment = an individual payment **REQUEST**.
> `Student.groupId` = the currently active group assignment.
> A PENDING payment request is NOT an entitlement — and an APPROVED payment
> is not one either, *by itself*: only the atomic decision service writes
> the entitlement.

---

## ⚠ 0. RELEASE COUPLING — READ BEFORE ANY DEPLOYMENT DISCUSSION

**PR2a is NOT independently production-deployable.
PR2a + PR2b + PR3 form ONE atomic production release.**

PR2a deliberately removed the legacy "`POST /api/enroll` assigns
`Student.groupId` immediately" behavior and left the legacy approval handler
as the handoff point. PR2b is what completes the handoff: with this pull
request merged, `POST /api/admin/payments/[id]/approve` reads
`Payment.requestedGroupId` / `Payment.requestedPlanId`, enforces capacity,
writes the reviewer audit fields, and — for a new student — assigns
`Student.groupId` in the SAME transaction that activates the Subscription.
The stranding state PR1's release rule forbids
(`Payment APPROVED / Subscription ACTIVE / Student.groupId NULL`) can no
longer be produced by the approve endpoint: a new-student approval either
assigns the seat or fails (GROUP_REQUIRED / GROUP_FULL /
INVALID_GROUP_CONTEXT / …) with the payment left PENDING.

Do NOT split this: deploying PR2a without PR2b strands new students;
deploying PR2b's import constraint without PR2b's review flow would hide
decisions; PR3 (student-facing payment UX, WhatsApp proof, admin screen
rework) is explicitly OUT of scope here.

---

## 1. What changed (file inventory)

| File | Change |
| ---- | ------ |
| `src/lib/payment-transitions.ts` | **NEW — the ONE decision service.** Closed domain-error set (11 codes) + deterministic HTTP status map + i18n key map + `transitionErrorDecision` (route-import-free error → `{status, message, code}`); `normalizeRejectionReason` (trim + collapse, ≤ 500); `addMonths` (day-CLAMPED calendar months, the plan's own duration representation); `approvePayment` / `rejectPayment` — each ONE `db.$transaction` (all reads that drive a write inside it); `runApprovalPostCommitEffects` (the failure-tolerant post-commit ordering: reconcile → notify). `db` injected → the tests execute the shipped code. |
| `src/lib/db-serialization.ts` | Generalized from Phase 23: `fnv1a63` extracted (byte-identical output — every Phase 23 pinned lock id is unchanged), NEW `GROUP_SEAT_LOCK_NAMESPACE` + `groupSeatLockId(groupId)` (FNV-1a of `namespace \0 groupId` — namespaced so it can never collide with an upload-finalize lock), NEW `acquireGroupSeatLock(tx, groupId, provider)` — the Phase 25 per-group seat lock, `pg_advisory_xact_lock`-backed, transaction-scoped, a deliberate NO-OP on SQLite. Still exactly ONE `$executeRaw` tagged-template call in `src/`, provider-gated (Phase 21 carve-out preserved). |
| `src/app/api/admin/payments/[id]/approve/route.ts` | REWRITTEN as a thin shell: `requireRole("ADMIN")`; reviewer from the session ONLY; the sole client input is the optional `groupId` admin override (spec §21 — the recovery path for GROUP_REQUIRED / dangling requested groups, fully validated in the service); maps service domain errors to HTTP via `transitionErrorDecision`; runs `runApprovalPostCommitEffects` (Phase 12 `reconcileStudentBatch`, then the truthful post-decision notification) strictly after commit, failure-tolerant with `warnings[]`. No in-route `$transaction`, no `payment.update`, no business rules. |
| `src/app/api/admin/payments/[id]/reject/route.ts` | REWRITTEN as a thin shell: `requireRole("ADMIN")`; the reason is the sole client input, validated with the SHARED `normalizeRejectionReason` BEFORE the service (400 `INVALID_REJECTION_REASON`); post-commit rejection notification (carries the admin's reason), failure-tolerant. |
| `src/app/api/admin/payments/import/route.ts` | CONSTRAINED TO PENDING: a row that requests another decision status is still created — as PENDING for later review (result row reports `importedAs: "PENDING"` + a note). Import can never mint a decided state, never writes review fields, never touches Subscription / Student rows. The GET template now teaches the contract (both sample rows PENDING). |
| `src/lib/i18n-dict-2026.ts` | NEW KEYS ONLY: `api.269`–`api.284` (the 11 domain errors' messages minus the existing `api.025` PAYMENT_NOT_FOUND, plus DB_CONFLICT, the three truthful approval notification texts, the rejection notification, and the generic internal error). ar+en for every key. |
| `tests/payment-lifecycle-phase25-pr2b.test.js` | **NEW.** 252 assertions against the COMPILED shipped service: scenario classification (first / renewal / reactivation / grandfathered, incl. the PENDING-row-is-not-a-re-activation rule), date/stacking pins, stale guard (incl. `createdAt` tie-break), every domain error, capacity, atomicity fault-injection (a failed write rolls back EVERYTHING), post-commit effect ordering + failure tolerance, reviewer-field truthfulness, SQLite no-lock mode, i18n resolution, lock-key properties. |
| `tests/payment-lifecycle-phase25-pr2b-concurrency.test.js` | **NEW.** 114 assertions, three legs: (1) the shipped service under a deterministic per-key advisory-lock mutex — 6 randomized last-seat trials, exactly one winner, loser zero-write PENDING; (2) the SQLite single-writer leg — the loser's first write after the winner's commit fails SQLITE_BUSY → rollback → 409 DB_CONFLICT mapping; (3) REAL PostgreSQL engine (PGlite, full baseline): the shipped lock SQL + parameter run inside BEGIN/COMMIT are visible in `pg_locks` and vanish at COMMIT. Honest single-user limitation stated in-file and in §6. |
| `tests/payment-lifecycle-phase25-pr2b-fullchain.test.js` | **NEW.** 135 assertions over a REAL `node:http` server + REAL `fetch` against a REAL node:sqlite database built from the REAL migration history, driving the SHIPPED enroll / import / approve / reject / queue routes byte-for-byte: the complete new-student chain, rejection chain, grandfather chain, stale pair, 401/403/anti-spoofing, GROUP_REQUIRED + override recovery, PLAN_REQUIRED, GROUP_FULL at approval + same-group renewal at capacity, import-constraint (APPROVED/REJECTED rows imported as PENDING, entitlement untouched). |
| `tests/payment-lifecycle-phase25-ledger.test.js` | §0 RE-PIN (PR1 protocol, not relaxation): the request-field allowlist and the review-field reader allowlist gain `src/lib/payment-transitions.ts` (+ the reject route's reason echo); the `reviewedByUserId` pin re-points to a closed allowlist of exactly ONE file — the decision service (the sole Payment review-field writer). 134/0. |
| `tests/payment-lifecycle-phase25-pr2a.test.js` | §15 RE-PIN (deliberate protocol): the "legacy route NOT rewritten" pins are replaced by delegation pins — both decision routes import from `@/lib/payment-transitions`, call `approvePayment(`/`rejectPayment(`, and carry NO in-route decision logic (no `$transaction(`, no `payment.update(`). Submission-side + schema + 10-migration pins unchanged. 168/0. |

**No schema/migration changes** (every column written here exists since
PR1's `20260914120000_payment_lifecycle_redesign` — the ledger was built
for exactly this). **No changes to:** `prisma/**`, `scripts/db/**`,
enroll/read routes (PR2a), session-progress/enrollment access gates (PR2a),
R2/storage, Vercel, cron, notification preferences, lockfiles, `.env*`,
admin UI (PR3).

---

## 2. The transition guard (the closed state machine)

A Payment moves exactly once, and only a PENDING payment may move:

```
PENDING → APPROVED     (approve: atomic activation / renewal / (re)seat)
PENDING → REJECTED     (reject:  atomic rejection + coupon release)
```

Everything else is `INVALID_TRANSITION` — `APPROVED → REJECTED`,
`REJECTED → APPROVED`, `APPROVED → APPROVED`, `REJECTED → REJECTED`,
`EXPIRED → APPROVED`, `EXPIRED → REJECTED`. A repeated decision is NEVER
silently treated as success, and a failed decision writes NOTHING (no
review fields, no entitlement, no audit). The re-read of the payment row
happens INSIDE the transaction, so the guard sees committed state.

`PAYMENT_NOT_FOUND` (404) is the only not-found; `INVALID_REJECTION_REASON`
(400) is the only body-validation error; every other domain failure is a
409 CONFLICT — the payment exists but cannot be decided in this state, and
the admin can correct the context and retry:

| Code | Meaning (what the admin should do) |
| ---- | ---- |
| `PAYMENT_NOT_FOUND` | id unknown (404) |
| `INVALID_TRANSITION` | already decided / expired — do nothing |
| `STALE_PAYMENT` | a newer pending request exists — decide the newest one |
| `NO_STUDENT` | the payment's user has no Student row (approval never creates one) |
| `GROUP_REQUIRED` | no group intent anywhere — retry WITH the `groupId` override |
| `GROUP_NOT_FOUND` | requested/override group missing or inactive |
| `GROUP_FULL` | no capacity at approval time (same-group renewals are exempt) |
| `PLAN_REQUIRED` | no requested plan AND no unambiguous (valid) current plan |
| `PLAN_NOT_FOUND` | requested plan missing or inactive |
| `INVALID_GROUP_CONTEXT` | the target group is in a different course than the request's context |

Error bodies are `{ error: <localized message>, code }` — deterministic,
i18n-resolved (ar+en), never containing Prisma/SQL internals. Unrecognized
transient SQLite contention maps to 409 `DB_CONFLICT` (api.279, honest
"retry"); anything else maps to 500 `INTERNAL` (api.284, generic).

---

## 3. Approval — what the service does, in order, inside ONE transaction

1. Re-read the payment; enforce the guard (PENDING only).
2. Resolve the Student from `Payment.userId` (ownership from the row, never
   the client; `NO_STUDENT` when absent).
3. Stale guard (below, §5).
4. Plan resolution: `requestedPlanId` → (must exist + be ACTIVE, else
   `PLAN_NOT_FOUND`); when absent, the student's CURRENT plan ONLY while
   that entitlement is still valid (the shared policy
   `isSubscriptionValidForAccess`), else `PLAN_REQUIRED` — legacy rows
   without plan intent can never produce a false successful activation.
5. Target-group resolution: admin override → `requestedGroupId` →
   `Student.groupId` → `GROUP_REQUIRED`. The target must exist + be ACTIVE
   (`GROUP_NOT_FOUND`), and must stay inside the request's COURSE CONTEXT
   (the course of the requested group and/or of the student's current group,
   whichever differs from the target) — `INVALID_GROUP_CONTEXT` otherwise.
   The override is fully validated exactly like any other candidate.
6. Snapshot the prior state with the SAME shared policy every
   authorization path uses (`evaluateAccessDecision`) — scenario label,
   notification truth and audit all derive from one verdict.
7. Seat decision: `needsSeat = student.groupId !== target.id`. Only a group
   CHANGE consumes a seat. When a seat is needed, the service takes the
   per-group advisory lock (PostgreSQL; §6), RE-READS the capacity under
   the lock, and fails `GROUP_FULL` when there is no room. Same-group
   approvals skip the lock and the count entirely — a renewal approves even
   at capacity.
8. The Subscription singleton (spec §11–§15):
   - **RENEWAL** (row valid/ACTIVE): same row stays ACTIVE, `startDate`
     PRESERVED, `endDate` STACKED on the current (future) `endDate` using
     the plan's own `durationMonths` (day-overflow CLAMPED: Jan 31 + 1 mo =
     Feb 28, never Mar 3);
   - **REACTIVATION** (a row that was PAID before — stored ACTIVE/EXPIRED/
     CANCELLED — now invalid): same row re-activated, fresh dates from now;
   - **FIRST_ACTIVATION** (no prior paid entitlement — including the
     student's own PENDING submission row, which has never been an
     entitlement) / **GRANDFATHERED_ACTIVATION** (no row at all, legacy
     access): the row is created/activated with fresh dates from now.
   A second row is impossible by the `studentId @unique` constraint and is
   never attempted.
9. Assign `Student.groupId` ONLY when a seat changed.
10. Write the decision: `status APPROVED`, `rejectionReason null`,
    `reviewedAt`, `reviewedByUserId` (the SESSION admin), `subscriptionId`
    (ensured — the grandfathered payment arrives with `subscriptionId =
    null` and the freshly created row is linked).
11. Audit log — INSIDE the transaction: admin, payment, student,
    subscription, previous group/plan/status, resulting group/plan/status,
    and the EXPLICIT scenario (`details.scenario`). A failed audit aborts
    the decision like any other failed step.

Every write happens after every read that drives it; if ANY step fails
(domain error, constraint, DB error) NONE of the business writes commit
(proven by fault-injection tests, §9).

**Post-commit** (the route, strictly after the transaction settles — so
side effects observe committed state only and can never un-commit the
decision): Phase 12 `reconcileStudentBatch` (batch healing on the write
path), then the TRUTHFUL post-decision notification:

| `accessNotification` | When | Message (ar+en) |
| ---- | ---- | ---- |
| `ACTIVATED` | no valid entitlement before (first / reactivation) | "subscription activated / content available" (api.280) |
| `RENEWED` | a valid ACTIVE entitlement before | "renewed — valid until …" (api.281) — never "course opened" |
| `CONFIRMED` | grandfathered access before | "confirmed — valid until …" (api.282) — access already existed |

Each step is failure-tolerant: a failure logs and adds a `warnings[]`
entry (`reconciliation_failed` / `notification_failed`) — the response is
still 200 with `ok: true` and the committed decision.

---

## 4. Rejection — what the service does, in order, inside ONE transaction

1. Normalize the reason (trim + inner-whitespace collapse; required, ≤ 500
   chars) → `INVALID_REJECTION_REASON` otherwise. The route validates with
   the SAME normalizer before calling the service, so route and service can
   never disagree.
2. Re-read the payment; enforce the guard (PENDING only).
3. Coupon release: the submission consumed the coupon atomically (PR2a:
   redemption row + `usedCount` increment). Rejection REVERSES that in the
   same transaction — redemption deleted, `usedCount` decremented — so a
   rejected payment never double-blocks a coupon. Idempotency under
   forbidden repeated decisions is guaranteed by the guard: a second
   decision fails before this code runs, so a coupon can never be released
   twice.
4. Write the decision: `status REJECTED`, `rejectionReason`, `reviewedAt`,
   `reviewedByUserId`.
5. Audit log (admin, payment, user/student context, reason) — inside the
   transaction.

The student's entitlement is NEVER touched: no `groupId`, no Subscription
row (a grandfathered student's legacy access is byte-for-byte preserved —
rejection never manufactures a row), no dates, no plan. Post-commit: the
`PAYMENT_REJECTED` notification carries the admin's reason (api.283),
failure-tolerant.

---

## 5. Stale-payment protection (PR2a's newest-first read made authoritative)

A PENDING payment may only be decided while it is the NEWEST pending
request of its user — ordered `createdAt DESC`, tie-broken `id DESC`,
byte-for-byte the ordering PR2a's student read API uses. If any other
PENDING row of the same user sorts strictly before the target, the
decision is refused `STALE_PAYMENT`: nothing is mutated, the older row
stays PENDING (history preserved, not destroyed), and the newer request
remains authoritative. A newer DECIDED row (APPROVED/REJECTED) does not
stale — only pending requests supersede.

---

## 6. Concurrency — the last-seat race

Two concurrent seat-changing approvals for the same group must not both
pass their capacity re-check. The serialization point is the DATABASE:

- **PostgreSQL (production):** each seat-changing approval takes
  `pg_advisory_xact_lock(groupSeatLockId(groupId))` INSIDE its
  transaction — exclusive for that group across every connection, process
  and instance, held until COMMIT/ROLLBACK (a crashed instance releases
  everything). The capacity re-read and the seat assignment run AFTER the
  lock, so they are atomic with respect to any other node running the same
  sequence. The key is a deterministic FNV-1a63 of
  `cm:phase25:group-seat \0 <groupId>`: same group ⇒ same lock, different
  groups never block each other, and the namespace makes collision with
  the Phase 23 upload-finalize lock impossible. Same-group approvals take
  no lock at all (they never consume a seat).
- **SQLite (local dev / tests):** a deliberate NO-OP — `pg_advisory_xact_lock`
  does not exist there, and SQLite's own single-writer database lock already
  serializes concurrent write transactions: the contending loser fails into
  the busy path, the transaction rolls back (nothing partial), and the
  client receives 409 `DB_CONFLICT` (api.279) — an honest retry.

**Honest scope of the concurrency proof** (stated in the test file too):
the in-process environment cannot run two truly independent PostgreSQL
sessions (PGlite is single-user; advisory locks are re-entrant within one
session). The proof therefore has three legs: (1) the SHIPPED service run
under a deterministic per-key mutex with exact `pg_advisory_xact_lock`
semantics (wait for key, hold for the transaction, release at
commit/rollback) — 6 randomized last-seat trials, each ending with exactly
one APPROVED, one GROUP_FULL, the group at exactly capacity, and the loser
zero-write PENDING; (2) the SQLite single-writer leg with a deterministic
interleave proving the busy → rollback → 409 `DB_CONFLICT` mapping;
(3) a REAL PostgreSQL engine (PGlite, full platform baseline applied)
executing the SHIPPED statement + parameter inside BEGIN/COMMIT, with the
lock visible in `pg_locks` (`locktype = 'advisory'`) while held and gone
after COMMIT, and a different group's key not blocking. Production
PostgreSQL provides the same primitive.

---

## 7. Anti-spoofing / security surface

- Reviewer identity comes from the authenticated SESSION only
  (`requireRole("ADMIN")` → 401 anonymous, 403 non-admin on all four
  endpoints). Client body fields `userId`, `studentId`, `subscriptionId`,
  `reviewedByUserId`, `status`, `scenario` are structurally ignored — the
  service has no parameter for them; the only accepted client input is the
  optional admin `groupId` override (approve) and `reason` (reject), both
  fully validated.
- Error bodies are `{ error, code }` with localized messages — no
  Prisma/SQL/database internals leak (pinned in the full-chain suite).
- The import route (now PENDING-only) is admin-only as before and never
  writes review fields or entitlements.

---

## 8. Deliberate non-goals → PR3 handoff

- **Admin payment review UI** (approve/reject buttons, stale badge,
  capacity hints, the override dialog) — the API supports it; the UI is
  PR3. The current admin dashboard still calls the endpoints with no body,
  which is exactly the "approve as submitted" behavior.
- **Student payment UX** (payment-request wizard polish, WhatsApp/transfer
  proof upload, pending-reminder messaging) — PR3.
- **EXPIRED payment lifecycle** (cron/expiry of PENDING requests) — out of
  scope; EXPIRED payments simply cannot be decided (INVALID_TRANSITION),
  which is the safe default.
- **Bulk decision import** — explicitly refused by design (§1 import row):
  decisions are per-payment admin acts with audit + capacity + stale
  guards; a bulk decision would bypass exactly those.

---

## 9. Verification (this sandbox)

New suites (all green, run with `node <file>`):

| Suite | Assertions | What it proves |
| ---- | ---- | ---- |
| `tests/payment-lifecycle-phase25-pr2b.test.js` | 252 | The COMPILED shipped service against an in-memory store with per-transaction rollback + fault injection: all four scenarios, date/stacking pins (incl. §33 "Oct 1 + 1 mo = Nov 1" and Jan 31 clamp), the stale guard (incl. tie-break), all 11 domain errors, capacity + same-group exemption, rejection preservation for all three student kinds + coupon release idempotency, atomicity (a failed write rolls back EVERYTHING), post-commit ordering/tolerance, reviewer-field truthfulness, SQLite no-lock mode, i18n (ar+en, no raw-key leak), lock-key properties. |
| `tests/payment-lifecycle-phase25-pr2b-concurrency.test.js` | 114 | §6's three legs: modeled advisory-lock mutual exclusion (6 randomized last-seat trials on the shipped service), the SQLite single-writer busy → rollback → 409 DB_CONFLICT leg, and the real-PostgreSQL (PGlite) lifecycle of the shipped lock SQL. |
| `tests/payment-lifecycle-phase25-pr2b-fullchain.test.js` | 135 | The complete journey over REAL HTTP + REAL migrated SQLite with the SHIPPED routes byte-for-byte: submit → PENDING (no group) → approve → APPROVED + ACTIVE + group + audit + "activated" notification; rejection chain; grandfather chain (row born + linked, "confirmed"); stale pair; 401/403/anti-spoofing (body fields ignored, clean error bodies); GROUP_REQUIRED + override recovery; PLAN_REQUIRED; GROUP_FULL at approval + same-group renewal at capacity; import xlsx requesting APPROVED/REJECTED statuses → PENDING rows only, entitlement untouched. |

Re-pins (PR1 deliberate-re-pin protocol — the pins now assert the NEW
contract, not its absence): `tests/payment-lifecycle-phase25-ledger.test.js`
§0 (134/0), `tests/payment-lifecycle-phase25-pr2a.test.js` §15 (168/0).

Environment notes (unchanged from PR1/PR2a): `npx prisma generate` is
unreachable in this sandbox (binaries.prisma.sh), so `@prisma/client` types
are ungenerated (the 10 baseline `tsc` errors in unrelated route files);
full-repo `tsc --noEmit` shows EXACTLY those 10 — the new files add zero.
`next build` parity follows the PR2a precedent (temporary non-committed
type shim).
