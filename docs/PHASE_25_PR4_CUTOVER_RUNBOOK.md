# Phase 25 PR4 — Cutover / Operations / Neon Readiness Runbook

> **Status:** operational gate for the coordinated Phase 25 release (PR2a + PR2b + PR3 + UTC hotfix). Does not change business logic, does not add a migration, does not mutate production.
> **Audience:** the operator performing the Neon cutover from Windows (PowerShell/CMD) or WSL. Assumes PR1 ledger migration `20260914120000_payment_lifecycle_redesign` is already applied to production Neon.
> **Engine:** PostgreSQL 17 / Neon is the production authority. SQLite is for local verification only.

---

## 1. What PR4 does

PR4 is **not** a feature. It answers:

> *Can the new Phase 25 payment lifecycle go live against the existing production Neon data without corrupting entitlement / access?*

It delivers:

- read-only production inventory (this runbook + `scripts/phase25-pr4-inventory.mjs`)
- Neon-compatible operator queries (SELECT only)
- dry-run anomaly detection (14 checks A–N)
- cutover readiness checks (schema + migration + GO/NO-GO)
- rollback / recovery plan (app vs database)
- exact operator cutover sequence (12 steps)
- post-deploy Neon smoke plan (5 scenarios)
- cleanup plan for smoke-test data

**Safety rule:** every production-facing script defaults to **READ-ONLY**. No future repair may run without both `--apply` and `--confirm-production-cutover`. This PR ships **no** automatic repair script — it ships inventory, report, and a manual-repair policy (see §14).

---

## 2. Production release contract

The production release is **atomic**:

```
PR2a (submission + entitlement truth)
+ PR2b (approve / reject / capacity / atomic activation / stale guard / audit)
+ PR3  (student payment UX + WhatsApp proof + admin review)
+ PR2b UTC hotfix (calendar-month arithmetic in UTC)
= one Vercel deploy
```

`PR4` is the gate in front of that deploy. Do not deploy PR2a alone, PR2b alone, or PR3 alone. The inventory must be **GO** (or **GO WITH REVIEW** with accepted reviews) before deploy.

---

## 3. Inventory model

`scripts/phase25-pr4-inventory.mjs` is the single operator report. It:

- reads production `DATABASE_URL` from `process.env.DATABASE_URL` (production authority); `--target` / `--pglite` are for local/disposable testing only
- never prints the full URL — logs show only `engine: PostgreSQL` and `host: ep-xxxx.neon.tech/neondb` (credentials redacted)
- runs only `SELECT` queries (verified by the test suite)
- prints a human summary and a JSON report (`--json-out inventory.json`)

### 3.1 Counts produced

**Students:** total, withGroup, withoutGroup, withSubscription, withoutSubscription

**Subscriptions:** PENDING / ACTIVE / EXPIRED / CANCELLED, ACTIVE+endDate in past, ACTIVE+future (or null), ACTIVE without group, subscription with missing/inactive plan

**Payments:** PENDING / APPROVED / REJECTED / EXPIRED, legacy (no ledger fields), PENDING with subscriptionId null, PENDING with requestedGroupId null, PENDING with requestedPlanId null, APPROVED without reviewer, APPROVED without subscription link, REJECTED without reason, duplicate references, stale pending

**Groups:** active / inactive, current member counts, over-capacity, students in inactive groups

**Coupons:** redemptions tied to PENDING payments, to REJECTED payments, orphan redemptions

**Plans:** active / inactive

**Expected legacy states (INFO):** grandfathered (valid group, no Subscription), grandfathered no-pending, grandfathered with-pending, new-pending-no-group, active-renewal-pending

### 3.2 Group capacity & plan readiness

- Per-group: `capacity, members, free = capacity - members, pendingRequests, overCapacity, nearFull (free <=2), isActive`
- Pending requests are **not** counted as occupied seats — only `Student.groupId` consumes a seat.
- Per-plan: `active / inactive`, pending payments whose `requestedPlanId` points at a missing or inactive plan.

### 3.3 Output example

Human:

```
PHASE 25 PRODUCTION READINESS
Database:
  engine: PostgreSQL
  host: postgresql://ep-xxx.us-east-2.aws.neon.tech/neondb
  generatedAt: 2026-09-14T12:00:00.000Z
Counts:
  students: 124 (withGroup=98 withoutGroup=26 withSubscription=87 withoutSubscription=37)
  payments: pending=14 approved=62 rejected=8 expired=0 legacy=31
    pendingNoSub=7 pendingNoGroup=2 pendingNoPlan=1 approvedNoReviewer=2 approvedNoSub=1 rejectedNoReason=1 dupRefGroups=0 stalePending=3
  subscriptions: pending=14 active=71 expired=12 cancelled=2 activeExpired=4 activeFuture=67 activeNoGroup=1 planBad=0
  groups: active=6 inactive=1 studentsInInactive=0
  plans: active=3 inactive=1
  coupons: pendingRedemptions=2 rejectedRedemptions=1 orphan=0
Expected legacy states:
  grandfathered: 27 (noPending=19 withPending=8)
  new-pending-no-group: 5
  active-renewal-pending: 6
Blockers (2):
  APPROVED_PAYMENT_NO_ENTITLEMENT: 1 e.g. pay_abc
  GROUP_OVER_CAPACITY: 1 e.g. g2
Review (3):
  STALE_PENDING_PAYMENT: 3 e.g. pay_old1,pay_old2
  UNRESOLVABLE_PENDING_GROUP: 2
  UNRESOLVABLE_PENDING_PLAN: 1
Group capacity:
  g1 Group 1 cap=20 members=18 free=2 pending=3 OK
  g2 Tiny cap=2 members=3 free=0 pending=1 OVER (inactive=false)
Plan readiness:
  pendingRequestsTargetingBadPlan: 0
Schema: fields=OK indexes=OK
Verdict: NO-GO
```

JSON: same structure under `counts`, `expectedLegacy`, `anomalies`, `groupCapacity`, `planReadiness`, `blockers`, `review`, `schema`, `verdict`.

---

## 4. Anomaly definitions A–N

| Key | What it detects | Why it matters | Severity |
|-----|-----------------|----------------|----------|
| **A APPROVED_PAYMENT_NO_ENTITLEMENT** | `Payment APPROVED` but `subscriptionId` null or its Subscription not `ACTIVE` / not future (or null endDate) | Approval did not create entitlement | **BLOCKER** |
| **B ACTIVE_SUBSCRIPTION_NO_GROUP** | `Subscription ACTIVE` + future (or null) but `Student.groupId` null | Active entitlement without a group cannot open content | **BLOCKER** |
| **C ACTIVE_SUBSCRIPTION_EXPIRED** | `Subscription ACTIVE` but `endDate < now` | Lazy expiry row still stored as ACTIVE — renewal candidate, not necessarily corrupt | **REVIEW** |
| **D GROUP_OVER_CAPACITY** | `COUNT(Student.groupId) > Group.capacity` | More members than seats | **BLOCKER** |
| **E STUDENT_IN_INACTIVE_GROUP** | `Student.groupId -> Group.isActive = false` | Students in a disabled group | **REVIEW** |
| **F PAYMENT_APPROVED_NO_REVIEWER** | `APPROVED` with `reviewedAt` or `reviewedByUserId` null | Review audit incomplete; legacy rows (pre-PR2b) may legitimately be null | **REVIEW** |
| **G PAYMENT_REJECTED_NO_REASON** | `REJECTED` with null / blank `rejectionReason` | Admin decision without reason (required since PR3) | **REVIEW** |
| **H STALE_PENDING_PAYMENT** | Older `PENDING` superseded by a newer `PENDING` for same `userId` (`createdAt DESC, id DESC`) | Newest request wins; older must not be approved (PR2b already blocks) | **REVIEW** |
| **I UNRESOLVABLE_PENDING_GROUP** | `PENDING` with `requestedGroupId` null and `Student.groupId` null | No group intent anywhere — approval would be `GROUP_REQUIRED` | **REVIEW** |
| **J UNRESOLVABLE_PENDING_PLAN** | `PENDING` with `requestedPlanId` null and no valid ACTIVE current plan (missing / inactive / expired) | Approval would be `PLAN_REQUIRED` | **REVIEW** |
| **K PAYMENT_SUBSCRIPTION_OWNERSHIP_MISMATCH** | `Payment.subscriptionId -> Subscription.studentId -> Student.userId != Payment.userId` | Payment points at another student's subscription | **BLOCKER** |
| **L DUPLICATE_ACTIVE_SUBSCRIPTION** | `GROUP BY Subscription.studentId HAVING COUNT(*) > 1` | Singleton violated | **BLOCKER** |
| **M INVALID_REQUESTED_GROUP_CONTEXT** | `PENDING` `requestedGroupId` and `Student.groupId` both present but their `courseId` differ | Requested group is in a different course | **REVIEW** |
| **N ORPHAN_PAYMENT_USER** | `Payment.userId` has no `Student` row | Payment for a non-student account | **BLOCKER** |

Additional review counters:

- `DUPLICATE_REFERENCE_GROUPS` — same `reference` among `PENDING` payments (flaged on read, never a uniqueness constraint)
- `couponPendingRedemptions` / `couponRejectedStillHeld` / `orphanRedemptions`
- `GROUP_REQUIRED` (same as I) and `PLAN_REQUIRED` (same as J) queued separately for the operator
- `planPendingBad` — `PENDING` with `requestedPlanId` pointing at a missing / inactive plan

**Legitimate states that are NOT anomalies:**

- Grandfathered: `Student.groupId` set, group active + `courseId` not null, **no** `Subscription` row — reported as `grandfathered` (INFO).
- New-student pending: `Payment PENDING + Subscription PENDING + Student.groupId null` — reported as `new-pending-no-group` (INFO).
- Active renewal: `Subscription ACTIVE+future + group present + Payment PENDING` — reported as `active-renewal-pending` (INFO). Approval stacks dates; current access stays true.

---

## 5. Severity & verdict

- **BLOCKER** — unsafe to release. Produces wrong access / wrong entitlement / corruption. Must be resolved before deploy.
- **REVIEW** — requires operator inspection before release. Resolvable as manual repair or accepted legacy.
- **INFO** — legitimate legacy / expected state. No action.

**Deterministic verdict:**

- **NO-GO** if any BLOCKER count > 0 **or** schema check fails (missing ledger fields / indexes).
- **GO WITH REVIEW** if no BLOCKER but any REVIEW count > 0 (includes stale pending, GROUP_REQUIRED, PLAN_REQUIRED, expired ACTIVE rows, inactive-group students, etc.).
- **GO** if only INFO remains (no BLOCKER, no REVIEW).

The inventory exit code is `2` for NO-GO, `0` otherwise, so CI can gate on it.

---

## 6. Operator commands

All commands are **read-only** and **never log the password**.

### 6.1 Windows PowerShell (recommended on Windows)

Open **PowerShell** (not CMD). Paste line by line — **do not** `echo $env:DATABASE_URL`.

```powershell
# 1. Set production DATABASE_URL without echoing it (input is masked/hidden)
$env:DATABASE_URL = Read-Host "Paste production DATABASE_URL"
# Alternative if Read-Host is unavailable: set via Windows Environment Variables UI
# or: $env:DATABASE_URL = [System.Net.NetworkCredential]::new("", (Read-Host "Paste production DATABASE_URL" -AsSecureString)).Password

# 2. Verify it is set without revealing it (host only, via redaction)
node -e "const u=process.env.DATABASE_URL; const {URL}=require('url'); try{const x=new URL(u); console.log('host:', x.host, 'db:', x.pathname)} catch{ console.log('URL set')}"

# 3. Prisma migration status — must be "Database schema is up to date"
#    If ANY migration is pending or history differs → STOP / NO-GO — do not deploy.
npx.cmd prisma migrate status --schema prisma/schema.postgresql.prisma

# 4. PR4 read-only inventory — human + JSON (reads DATABASE_URL from env)
node scripts/phase25-pr4-inventory.mjs --json-out inventory.json
# Local/disposable testing only: --target file:./db/custom.db or --pglite /tmp/pg-pr4
# Production must NOT use --target with real credentials — it leaks into argv.

# 5. PostgreSQL catalog verification (reads DATABASE_URL from env)
node scripts/db/verify-postgres.mjs

# 6. Inspect results (JSON never contains the password)
type inventory.json
```

**PowerShell notes:**

- Use `npx.cmd` (not bare `npx`) on Windows — `npx` is a `.cmd` shim.
- ` $env:DATABASE_URL="..." ` sets the variable for this window only; closing PowerShell clears it.
- Never run `echo $env:DATABASE_URL` or paste the URL into chat / tickets.
- Do not weaken `ExecutionPolicy` — these commands need no policy change.

### 6.2 Windows CMD

```cmd
REM Set DATABASE_URL without echoing it (use SET /P to avoid logging)
set /p DATABASE_URL="Paste production DATABASE_URL: "
npx.cmd prisma migrate status --schema prisma/schema.postgresql.prisma
REM Production reads DATABASE_URL from env — do NOT use --target with real credentials
node scripts\phase25-pr4-inventory.mjs --json-out inventory.json
node scripts\db\verify-postgres.mjs
type inventory.json
```

### 6.3 WSL / Git Bash

```bash
# Set without echoing (read from tty)
read -s -p "Paste production DATABASE_URL: " DATABASE_URL; export DATABASE_URL; echo
npx prisma migrate status --schema prisma/schema.postgresql.prisma
# Production reads DATABASE_URL from env — do NOT use --target with real credentials
node scripts/phase25-pr4-inventory.mjs --json-out inventory.json
node scripts/db/verify-postgres.mjs
cat inventory.json | jq .verdict
```

### 6.4 Offline verification (no Neon, no network)

Uses PGlite (real PostgreSQL 17 engine in-process) and a scratch SQLite file. No credentials needed.

```bash
# SQLite (local dev)
node scripts/phase25-pr4-inventory.mjs --target file:./db/custom.db --json-out inventory.sqlite.json

# PGlite (PostgreSQL semantics, disposable)
node scripts/phase25-pr4-inventory.mjs --pglite /tmp/pg-pr4 --json-out inventory.pg.json
node scripts/db/verify-postgres.mjs --pglite /tmp/pg-pr4
```

CI: `node tests/phase25-pr4-inventory.test.js` runs both engines against deterministic fixtures and asserts identical classifications.

---

## 7. Engine safety

- If `DATABASE_URL` starts with `postgresql://` → engine is **PostgreSQL** (Neon). Queries use `TIMESTAMPTZ(3)`, `information_schema`, `pg_indexes`.
- If `DATABASE_URL` is `file:./db/custom.db` → engine is **SQLite**. Queries use `TEXT` dates, `pragma_table_info`, `sqlite_master`.
- `--pglite <dir>` forces the PostgreSQL engine via `@electric-sql/pglite` (real PG 17) even without a server.
- The script **never** silently runs SQLite assumptions against PostgreSQL — every time-sensitive check receives `now` as an ISO parameter (`$1` vs `?`).

Logs always show `engine: PostgreSQL` vs `engine: SQLite` and a **redacted** host.

---

## 8. Neon migration verification (exact future commands)

Run these **locally** against Neon (do not run in the sandbox). All are read-only.

```powershell
# Pre-check: migration status (READ-ONLY) — must be "Database schema is up to date"
# ANY pending migration or history mismatch → STOP / NO-GO — do not run migrate deploy.
npx.cmd prisma migrate status --schema prisma/schema.postgresql.prisma
# Expected: "Database schema is up to date."
# If it reports pending (e.g. "1 migration pending: 20260914120000_payment_lifecycle_redesign")
# or drift: STOP — investigate history mismatch, do NOT run prisma migrate deploy as part of normal PR4 cutover.

# Schema + data verification (reads DATABASE_URL from env)
node scripts/db/verify-postgres.mjs
# Expected: all A1–G7 PASS, ends with VERIFY_POSTGRES_OK

# Phase 25 inventory (reads DATABASE_URL from env)
node scripts/phase25-pr4-inventory.mjs --json-out inventory.json
# Inspect Verdict: GO / GO WITH REVIEW / NO-GO (see §5)
# If NO-GO: STOP — do not deploy. Resolve blockers, re-run inventory.
# If GO WITH REVIEW: resolve or formally accept each Review item, record acceptance, re-run inventory.

# Ledger columns spot-check (optional, read-only)
# PowerShell:
node -e "const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL}); p.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='Payment' ORDER BY 1`).then(r=>{console.log(r.rows.map(x=>x.column_name).join(', ')); p.end()})"
# Must contain: senderPhone, requestedGroupId, requestedPlanId, rejectionReason, reviewedAt, reviewedByUserId

# Indexes spot-check (read-only)
node -e "const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL}); p.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='Payment' ORDER BY 1`).then(r=>{console.log(r.rows.map(x=>x.indexname).join(', ')); p.end()})"
# Must contain: Payment_status_createdAt_idx, Payment_subscriptionId_status_idx
```

**Migrations are already applied on production Neon** — `20260914120000_payment_lifecycle_redesign` was applied as part of PR1. The `status` check must be `up to date` (10/10, `20260914120000_payment_lifecycle_redesign` last).

- `Database schema is up to date` → continue.
- ANY pending migration, history mismatch, or missing PR1 ledger migration → **STOP / NO-GO** — do not run `prisma migrate deploy` as part of the normal PR4 cutover. Pending at this point is unexpected production drift and requires explicit investigation.
- Missing ledger columns/indexes (`inventory` reports `SCHEMA_MISMATCH`) → **STOP / NO-GO**.

Do not create a migration, do not `prisma db push --accept-data-loss`, do not edit `schema.prisma`. Report the gap for manual triage.

---

## 9. Cutover runbook — 12 steps

> Do not execute these production steps now (this PR is operational safety, not the cutover itself).

| Step | Operator action | Verification |
|------|-----------------|--------------|
| **1** | Freeze risky admin payment decisions if necessary (announce payment review pause). No student submission freeze — submissions are request-only and never corrupt entitlement. | Team notified; admin drawer shows pending queue but operators instructed not to approve until GO |
| **2** | Record Git SHA to be deployed: `git rev-parse HEAD` and the Vercel deployment id. | SHA written to `cutover.log` |
| **3** | Verify Neon migration status: `npx prisma migrate status --schema prisma/schema.postgresql.prisma` | Must be `up to date` (10/10, ledger last) |
| **4** | Run read-only Phase 25 inventory: `node scripts/phase25-pr4-inventory.mjs --json-out inventory.json` + `node scripts/db/verify-postgres.mjs` (both read `DATABASE_URL` from env) | Capture `inventory.json` + battery output |
| **5** | Evaluate blockers: open `inventory.json`, check `verdict` | **NO-GO** → STOP, go to §12 rollback plan. **GO WITH REVIEW** → resolve or formally accept each Review with a written reason, then **re-run** step 4. Only **GO** proceeds |
| **6** | Take / confirm production DB recovery point: Neon restore capability (see §11) **and** logical backup: `scripts/db/backup-postgres.sh --out-dir /var/backups/codemind --label pre-phase25` | Backup `.dump` + `.sha256` + `.manifest.json` verified (`sha256sum -c`) |
| **7** | Resolve required blockers (if any Review was accepted without code change, re-run inventory; if a DB repair was needed, it is done manually in a transaction with a `SELECT` plan first — no automatic repair script) | Blocker count 0 on re-run |
| **8** | Re-run inventory: same commands as step 4 | Verdict now **GO** |
| **9** | Deploy coordinated `PR2a + PR2b + PR3 + UTC hotfix` as **one** atomic Vercel deployment (do not deploy PR2a alone) | Vercel shows live deployment with that SHA |
| **10** | Run post-deploy smoke tests ( §10 ) with **dedicated test accounts** (see §13) | All 5 scenarios show correct DB state transitions |
| **11** | Verify DB state after each smoke test: `node scripts/phase25-pr4-inventory.mjs` + targeted `psql` SELECTs (e.g. pending queue, subscription state) | No new anomalies introduced |
| **12** | Enable normal payment operations (announce review resumed) | Admin review drawer operational; notifications flowing |

**Cutover window:** 30–60 minutes. Steps 4–8 are repeatable in <2 minutes.

---

## 10. Post-deploy Neon smoke plan

Use **dedicated test accounts only** — never real students. Identify them by a stable prefix, e.g. `smoke-phase25-*@codemind.test` or `smoke+<stamp>@codemind.test`. Capture their `userId / studentId / paymentId` at creation.

All smoke checks assert both the API response **and** the Neon row via read-only SELECT.

### A. NEW PAYMENT

1. Create `smoke-new-*@codemind.test` via the normal STUDENT registration (or seed a minimal User+Student with `groupId = null` and no Subscription).
2. As that student, `POST /api/enroll` with `courseId, groupId, planId, method=INSTAPAY, senderPhone=010..., reference=SMOKE-NEW-<ts>`.
3. Assert:
   - Neon `Payment` row: `status = PENDING`, `senderPhone` normalized `01...`, `requestedGroupId` = chosen group, `requestedPlanId` = chosen plan, `subscriptionId` not null (PR2a NEW_REQUEST) **or** null if the student was grandfathered (PR2a LEGACY path — check the scenario).
   - Neon `Subscription` row: `status = PENDING` for the new student, **or** no row for grandfathered.
   - `Student.groupId` still `null`.
   - `GET /api/students/me/payments` + entitlement: `accessAllowed = false`, `state = PENDING` (never *Active*).

### B. APPROVE

1. As `ADMIN`, `POST /api/admin/payments/{paymentId}/approve` with optional `groupId` override **only if** the request was GROUP_REQUIRED.
2. Assert:
   - `Payment.status = APPROVED`, `reviewedAt` not null, `reviewedByUserId` = admin.
   - `Subscription.status = ACTIVE`, `startDate`/`endDate` set ( календар-month, UTC day-clamped).
   - `Student.groupId` now equals the requested/override group.
   - Entitlement `accessAllowed = true`, `hasSubscription = true`, `grandfathered = false`.
   - Notification sent to student (optional check).

### C. REJECT

1. Create a fresh `smoke-reject-*@codemind.test`, submit a `PENDING` payment.
2. As `ADMIN`, `POST /api/admin/payments/{id}/reject` with `rejectionReason = "Smoke test rejection <ts>"` (1–500 chars, non-blank).
3. Assert:
   - `Payment.status = REJECTED`, `rejectionReason` stored trimmed, `reviewedAt`/`reviewedByUserId` set.
   - **No** entitlement change: `Student.groupId` unchanged, `Subscription` row unchanged (ACTIVE stays ACTIVE, PENDING stays PENDING), `accessAllowed` unchanged.
   - Coupon (if one was used on that Payment) is released (redemption removed / reusable).

### D. ACTIVE RENEWAL

1. Create `smoke-renew-*@codemind.test` with `Subscription ACTIVE` (future `endDate`) and `Student.groupId` set (active student).
2. Submit a renewal `PENDING` payment with a **different** `requestedPlanId` / `requestedGroupId` if desired.
3. Assert before approval: entitlement unchanged (`ACTIVE`, same `planId`/`endDate`/`groupId`, `accessAllowed = true`).
4. Approve that renewal.
5. Assert: `Subscription` still singleton, `startDate` preserved, `endDate` **stacked** on the prior future `endDate` (not on `now`) when `future endDate` exists, else on `now`; `planId` switched if requested; `Student.groupId` switched if requested; `accessNotification = RENEWED`.

### E. GRANDFATHERED (if production test data permits)

1. Create `smoke-grand-*@codemind.test` with `Student.groupId = g1` (active, course-bound) and **no** `Subscription` row — legacy access.
2. Assert pre-payment: `resolveStudentEntitlement` / `getEnrollment` = `accessAllowed = true, grandfathered = true, state = NONE`.
3. Submit a `PENDING` payment.
4. Assert: **no** `Subscription` row was created, `Student.groupId` unchanged, access still `true/grandfathered`.
5. Approve that payment.
6. Assert: singleton `Subscription` now `ACTIVE`, `Student.groupId` assigned (same group or overridden), `accessNotification = CONFIRMED`, access still `true` but now `hasSubscription = true` (truthful).

**After each scenario:** run `node scripts/phase25-pr4-inventory.mjs --json-out inventory.json` (reads `DATABASE_URL` from env) and confirm no new Blocker appeared and the expected counters moved by exactly one.

---

## 11. Backup / recovery readiness

### 11.1 What the project already has (Phase 21)

- `scripts/db/backup-postgres.sh` — `pg_dump --format=custom` + SHA-256 sidecar + JSON manifest + retention (`--retain-days 30 --keep-min 7`). Directory `0700`, files `0600`. Optional AES-256-CBC encryption via `BACKUP_PASSPHRASE` from the secret manager.
- `scripts/db/restore-postgres.sh` — decrypt-to-shredded-scratch → empty-target preflight → `pg_restore --no-owner` → **required** `verify-postgres.mjs` battery (`RESTORE_OK` only if the battery passes).
- `scripts/db/verify-postgres.mjs` — A1–G7 battery (55 tables, 21 enums, 73 FKs, 34 UNIQUE, 67 indexes, orphan/duplicate scans, teacher lifecycle, security foundations, rate-limit probe in a rolled-back transaction, app-shaped queries).
- `docs/POSTGRES_CUTOVER_RUNBOOK.md` — the full SQLite→PG cutover (freeze, load, battery, ledger baseline, switch, rollback).

For Vercel + Neon, the **Neon provider** also gives:

- Automated backups and **point-in-time recovery (PITR)** via the Neon dashboard (branch restore / time-travel). Availability depends on the project's Neon plan — **verify manually before cutover**:
  - Open the Neon project → **Branches** → confirm `Restore` / `Create branch from point in time` is present and which retention window applies.
  - Note the plan's PITR window (e.g. 7 days) and whether branch restore is a paid feature — **do not assume**.
  - Record the recovery procedure (dashboard clicks + CLI `neon branches restore`) in `cutover.log`.

If the plan has no PITR, the **logical backup** (`backup-postgres.sh`) is the sole RPO — schedule it **immediately before** step 6 and again after step 9.

**Pre-cutover check:**

```powershell
# Confirm backup dir is a different volume than the DB host
dir $env:BACKUP_DIR
# Run a disposable restore drill (quarterly, and once during the pre-freeze):
# DATABASE_URL is read from env — set via Read-Host without echo; never paste credentials literal
# scripts/db/restore-postgres.sh --backup /var/backups/codemind/<latest>.dump
# (or: DATABASE_URL=<restore-target> scripts/db/restore-postgres.sh --backup /var/backups/codemind/<latest>.dump)
# Must end with RESTORE_OK (battery passed)
```

Never proceed past step 5 without a verified, restorable recovery point.

---

## 12. Rollback / recovery plan

### 12.1 Application rollback

- **Trigger:** any smoke scenario fails (wrong entitlement, group not assigned on approve, rejection mutated valid entitlement, over-capacity race, access-gate mismatch, 5xx surge, schema mismatch, payment queue stuck).
- **Procedure:** Vercel → **Deployments** → select the deployment **before** the Phase 25 SHA → **Promote** / **Rollback**. No database change — the PR1 migration (`senderPhone` etc.) is additive and already live, so the old app build is compatible (extra nullable columns are ignored).
- **Do not** drop Phase 25 columns as the default rollback. Dropping columns is destructive and needs a new migration plus a data-loss review.
- **Verify:** re-run the smoke assertions against the old build (they will fail for NEW payment scenarios that expect the new lifecycle — that is expected; the rollback assertion is that **existing** students' entitlement/access is exactly as before the deploy).

### 12.2 Database rollback

- **Default:** do not roll back the database. PR4 ships no schema change; the database is compatible with both old and new app builds.
- **When database rollback is needed:** only if genuine data corruption is proven (e.g. ownership mismatch `K`, duplicate singleton `L`, or a failed manual repair wrote wrong rows). Then:
  1. Stop the app (maintenance mode).
  2. Restore the **pre-cutover** recovery point into a **fresh Neon branch/database** (not over the live one) via `scripts/db/restore-postgres.sh` or Neon branch restore — verify `RESTORE_OK`.
  3. Point `DATABASE_URL` at the restored branch, smoke-test (step 10), then promote it.
  4. Keep the corrupted live branch **as-is** for forensics until the post-mortem is written.

**Data-loss window:** writes accepted on PostgreSQL between the restore point and the rollback decision are not in the backup. If that window accepted real payments, fix-forward is preferred over a destructive restore.

---

## 13. Post-smoke cleanup

- Smoke test data is identified by the **dedicated account prefix** `smoke-phase25-*@codemind.test` **and** by the exact `id`s captured during the smoke run (log them).
- **Never** run a broad `DELETE` (e.g. `DELETE FROM "Payment" WHERE "status"='PENDING'` — it would delete real student requests).
- **Preferred option (safe):** retain tagged smoke data and document it. The inventory reports it as `REVIEW` (e.g. extra stale or GROUP_REQUIRED if the smoke left a pending) — that is acceptable for a tagged prefix. The next inventory run filters by email prefix when reporting for operator triage: `SELECT * FROM "Payment" p JOIN "User" u ON u.id=p."userId" WHERE u."email" LIKE 'smoke-phase25-%'`.
- If deletion is truly needed (e.g. to keep Neon row counts clean), do it **after verification** and **after a fresh backup**, with a targeted transaction and an audit row:

```sql
-- preview (READ-ONLY, the operator runs first)
SELECT p."id", p."status", u."email" FROM "Payment" p JOIN "User" u ON u."id"=p."userId" WHERE u."email" LIKE 'smoke-phase25-%' ORDER BY p."createdAt";
-- delete only the exact captured ids, in FK-safe order, after a backup
-- (run inside a transaction, confirm row counts before COMMIT; operator types the ids):
BEGIN;
DELETE FROM "CouponRedemption" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "email" LIKE 'smoke-phase25-%');
DELETE FROM "Payment" WHERE "id" IN ('pay_smoke_1','pay_smoke_2');
DELETE FROM "Subscription" WHERE "studentId" IN (SELECT "id" FROM "Student" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "email" LIKE 'smoke-phase25-%'));
DELETE FROM "Student" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "email" LIKE 'smoke-phase25-%');
DELETE FROM "User" WHERE "email" LIKE 'smoke-phase25-%';
-- SELECT counts; -- verify
-- COMMIT; -- only after verification, or ROLLBACK
```

If cleanup is risky, **retain** and document.

---

## 14. Cutover data repair policy

Do **not** automatically normalize legacy production data. For each anomaly type:

| Anomaly | Action |
|---------|--------|
| `grandfathered` (valid group, no Subscription) | **NO ACTION** — legitimate legacy |
| `new-pending-no-group` / `active-renewal-pending` | **NO ACTION** — legitimate PR2a state |
| `A APPROVED_PAYMENT_NO_ENTITLEMENT` | **BLOCK RELEASE** — manual repair: create/activate the missing `Subscription` + assign `Student.groupId` in one transaction, or revert the payment to `PENDING` if approval was erroneous (record in `AuditLog`) |
| `B ACTIVE_SUBSCRIPTION_NO_GROUP` | **BLOCK RELEASE** — assign a valid group to `Student.groupId` or cancel the ACTIVE row if it was stale |
| `C ACTIVE_SUBSCRIPTION_EXPIRED` | **MANUAL REVIEW** — lazily expired; no automatic `EXPIRED` rewrite. Operator may leave as-is (access already denied) or schedule a renewal |
| `D GROUP_OVER_CAPACITY` | **BLOCK or REVIEW** depending on cause: if members > capacity due to a race, move the excess student; if capacity is simply too low, raise `Group.capacity` with owner approval |
| `E STUDENT_IN_INACTIVE_GROUP` | **MANUAL REVIEW** — reactivate the group or move the student to an active group |
| `F PAYMENT_APPROVED_NO_REVIEWER` | **MANUAL REVIEW** — for legacy rows (created before PR2b) accept as-is; for new rows fill `reviewedAt/reviewedByUserId` from the audit log if determinable |
| `G PAYMENT_REJECTED_NO_REASON` | **MANUAL REVIEW** — fill a reason from the admin's communication log, or leave as `REVIEW` with documentation |
| `H STALE_PENDING_PAYMENT` | **NO ACTION** — already protected by PR2b (approval of stale is `409 STALE_PAYMENT`); operator may leave stale rows as history |
| `I GROUP_REQUIRED` / `J PLAN_REQUIRED` | **MANUAL REVIEW** — queue for admin: approve with `groupId` override (the only supported override) or, for `PLAN_REQUIRED`, create a Pending subscription with an explicit plan before retry |
| `K OWNERSHIP_MISMATCH` | **BLOCK RELEASE** — fix `Payment.subscriptionId` to the correct subscription or null it |
| `L DUPLICATE_ACTIVE_SUBSCRIPTION` | **BLOCK RELEASE** — merge / delete the duplicate row (keep the ACTIVE one, audit the deletion) |
| `M INVALID_GROUP_CONTEXT` | **MANUAL REVIEW** — re-approve with the correct group (same course) |
| `N ORPHAN_PAYMENT_USER` | **BLOCK RELEASE** — create the missing `Student` row or delete the orphan payment if it was a test artifact |
| `duplicate references` | **INFO** — flagged on read, never a uniqueness constraint |
| `couponPending / rejected / orphan` | **MANUAL REVIEW** — orphan `CouponRedemption` should be removed; rejected-still-held is `REVIEW` |

**Never** run a bulk `UPDATE` / `DELETE` / `TRUNCATE` to "clean" production. Every repair is a single, explicit, auditable transaction whose `SELECT` plan is previewed first.

---

## 15. Coupon consistency

- A `CouponRedemption` tied to a `PENDING` payment is **not** automatically wrong — PR2a creates the redemption inside the submission transaction and PR2b releases it on rejection. Pending + redemption = expected.
- `REJECTED` payments that still hold a `CouponRedemption` are flagged as `couponRejectedRedemptions` (REVIEW) — PR2b should have released the coupon atomically; if that release failed, the redemption must be inspected.
- `orphanRedemptions` (`paymentId` points at a non-existent `Payment`) are flagged as `couponOrphan` (BLOCKER if >0) — remove after verification.
- Tests cover: pending coupon state, approval preserved, rejection release, retry behavior (the submission transaction already guards duplicate `(couponId, userId)`).

---

## 16. Stale pending requests

Ordering is canonical: `createdAt DESC, id DESC` (the same order `GET /api/students/me/payments` uses). A `PENDING` payment is **stale** when any other `PENDING` for the same `userId` sorts strictly before it. The older rows remain `PENDING` as history (never auto-cancelled). PR2b's `assertNotStalePendingPayment` refuses to approve a stale id with `409 STALE_PAYMENT` and `pay.errorStale`. The inventory reports `stalePending` so the operator can see which queue items are superseded and approve the **newest** one.

---

## 17. Group capacity readiness

Report (from inventory `groupCapacity`):

```
g1  cap=20 members=18 free=2 pending=3 OK
g2  cap=2  members=3 free=0 pending=1 OVER
```

- `members` = `COUNT(Student.groupId = g.id)` — the **only** seat occupation signal.
- `pending` = `COUNT(Payment.requestedGroupId = g.id WHERE status=PENDING)` — does **not** consume a seat.
- `OVER` = `members > capacity` (BLOCKER).
- `NEAR_FULL` = `free <= 2 && !OVER` (REVIEW — warn before approving more into this group).
- Pending payments requesting a near-full or over-capacity group are visible so the admin can pick a different group (via the `groupId` override on approve).

---

## 18. Plan readiness

- `activePlans / inactivePlans` — from `SubscriptionPlan`.
- `requestedPlanId` references from `PENDING` payments: the inventory lists any `PENDING` with `requestedPlanId` pointing at a missing or inactive plan (`pendingRequestsTargetingBadPlan`).
- A `PENDING` with no `requestedPlanId` and no valid current plan (missing subscription, or subscription `PENDING`/`EXPIRED`/`CANCELLED`, or plan inactive) is flagged as `PLAN_REQUIRED` — approval must then supply a plan (currently no plan-override param; PR4 documents this as a real backend gap — see §19).

---

## 19. GROUP_REQUIRED / PLAN_REQUIRED queue

Pre-release operator report:

- **Potential `GROUP_REQUIRED`**: `PENDING` where `requestedGroupId` null **and** `Student.groupId` null. Approve will return `409 GROUP_REQUIRED` until the admin retries with `groupId`.
- **Potential `PLAN_REQUIRED`**: `PENDING` where `requestedPlanId` null and no valid current plan fallback. Approve will return `409 PLAN_REQUIRED`.

These are **REVIEW** items. The inventory's `groupRequired` / `planRequired` arrays give the exact `paymentId`s. The admin recovers with:

```json
POST /api/admin/payments/{id}/approve
{ "groupId": "g_valid_in_same_course" }
```

Plan override is **not** supported — that gap is documented, not fabricated.

---

## 20. Payment destination config — operations note

Confirmed launch truth (do not change):

| Item | Value | Notes |
|------|-------|-------|
| InstaPay destination | `01147422177` (`+20 1147422177`) | `brand.payments.instapay` |
| e& Cash (Etisalat Cash) destination | `01147422177` (same line by design) | `brand.payments.eCash` |
| Vodafone Cash destination | `null` (not launch-enabled) | `brand.payments.vodafoneCash` — rendered disabled |
| WhatsApp proof / review | `01147422177`, `01099942942` | `PAYMENT_PROOF_WHATSAPP_NUMBERS`; student sends screenshot to **one** number only |

`01147422177` is both a real transfer destination **and** one of the two WhatsApp proof lines — intentional.

**Optional future improvement (NOT a launch blocker):** move destinations into admin-managed `Setting` rows (e.g. `payment_instapay`, `payment_ecash` with `brand.ts` as fallback). No schema migration — `Setting` is already a generic key/value table. Changing a destination today is a one-line `brand.ts` edit plus a redeploy.

---

## 21. Cutover verdict and next operator step

### Recommended next operator step (after this PR is reviewed/merged, before deploy)

On the operator's Windows machine (not in the sandbox):

```powershell
# 1. Set production DATABASE_URL without echoing it (input hidden)
$env:DATABASE_URL = Read-Host "Paste production DATABASE_URL"

# 2. Migration status — must be "Database schema is up to date"
#    ANY pending or history mismatch → STOP / NO-GO — do NOT run migrate deploy.
npx.cmd prisma migrate status --schema prisma/schema.postgresql.prisma

# 3. Read-only inventory (reads DATABASE_URL from env)
node scripts/phase25-pr4-inventory.mjs --json-out inventory.json

# 4. Full catalog verification (reads DATABASE_URL from env)
node scripts/db/verify-postgres.mjs

# 5. Inspect
type inventory.json
# Check inventory.json > verdict
#   NO-GO  -> STOP, resolve blockers (see §14), re-run from step 2
#   GO WITH REVIEW -> resolve or formally accept each Review with a written reason, re-run from step 2
#   GO -> proceed to cutover step 6 (recovery point)
```

Do **not** paste the URL into chat. Do not `echo $env:DATABASE_URL`. Do not commit `inventory.json` if it contains row counts you consider sensitive — it contains no passwords, but treat it as operational.

If the inventory reports `SCHEMA_MISMATCH` (missing ledger columns or indexes), **STOP** — PR4 has no migration; report the gap for triage.

---

## 22. Files in this PR

- `scripts/phase25-pr4-inventory.mjs` — read-only inventory + anomaly detection (SELECT only, PostgreSQL + SQLite, redacted logging)
- `tests/phase25-pr4-inventory.test.js` — deterministic fixtures against SQLite + PGlite (both engines), read-only enforcement, GO/NO-GO rules, legitimate-state guards
- `tests/phase25-pr4-release-gate.test.js` — release composition gate (PR2a/PR2b/PR3/UTC/PR1 ledger/inventory presence, no new migration)
- `docs/PHASE_25_PR4_CUTOVER_RUNBOOK.md` — this runbook

No `src/` logic, no `prisma/` schema, no `.env` is modified.

---

## 23. Test & build matrix

```bash
node tests/phase25-pr4-inventory.test.js          # 179+ assertions
node tests/phase25-pr4-release-gate.test.js       # 50+ assertions
node tests/payment-lifecycle-phase25-ledger.test.js
node tests/payment-lifecycle-phase25-pr2a.test.js
node tests/payment-lifecycle-phase25-pr2a-grandfather.test.js
node tests/payment-lifecycle-phase25-pr2b.test.js
node tests/payment-lifecycle-phase25-pr2b-concurrency.test.js
node tests/payment-lifecycle-phase25-pr2b-fullchain.test.js
node tests/payment-lifecycle-phase25-pr2b-utc-tz.test.js
node tests/payment-experience-phase25-pr3.test.js
node tests/security-audit-gate.test.js
node tests/authorization-invariants.test.js
node tests/production-storage-phase21.test.js
node tests/final-integration-phase22.test.js   # expected env-specific non-zero if db/custom.db missing
npx prisma generate --schema prisma/schema.prisma
npx tsc --noEmit
# Windows PowerShell: npx.cmd prisma generate / npx.cmd tsc
```

Sandbox: `prisma generate` needs `binaries.prisma.sh` (network to the Prisma engines CDN). Where offline it reports the honest `Client network socket disconnected` wall — the same wall as Phases 21–22. The inventory and security suites do not need a generated client.

---

## 24. Out of scope (explicitly not done)

No deploy, no Neon mutation, no production seeding, no production row cleanup, no real payment approval/rejection, no production user creation, no payment destination change, no screenshot upload, no R2 touch, no cron change, no migration, no destructive SQL, no Phase 26 QA.

---

*End of runbook.*
