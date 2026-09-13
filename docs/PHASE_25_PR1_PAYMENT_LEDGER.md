# Phase 25 PR1 — Payment-lifecycle ledger (database only, behavior-neutral)

**Status:** implemented, verified, ready to merge. No production apply performed
(scratch-only proof; see §6).

PR1 lays the database foundation for the payment-lifecycle redesign (v2
architecture) and changes **nothing else**: no enroll/approve/reject/access
logic, no UI, no WhatsApp, no validation, no transitions, no expiry, no cron,
no R2, no AI, no `vercel.json`. After PR1, every pre-existing row reads `NULL`
in the new columns, every pre-existing write behaves identically, and no
application code references the new fields (proven by test §0).

**Release rule (standing):** PR1 is independently deployable — it is additive,
nullable, and unread. The later PRs (PR2a + PR2b + PR3) ship as ONE atomic
production release; PR2a without PR2b would produce a forbidden
APPROVED/ACTIVE/`groupId`-NULL false success. PR1 never creates that state.

---

## 1. What changed (file inventory)

| File | Change |
| ---- | ------ |
| `prisma/schema.prisma` | `model Payment` + 6 nullable fields, + 2 `@@index` (§2). ONLY schema edit. |
| `prisma/schema.postgresql.prisma` | Regenerated via `node scripts/db/make-postgres-schema.mjs` (derived, do not hand-edit). |
| `scripts/db/postgres-baseline.sql` | Regenerated via the same generator (derived). |
| `prisma/migrations/20260914120000_payment_lifecycle_redesign/migration.sql` | NEW. One forward-only migration: 6× `ADD COLUMN`, 2× `CREATE INDEX` (§3). |
| `tests/payment-lifecycle-phase25-ledger.test.js` | NEW. 133-assertion dual-engine proof (§6). |
| `tests/production-storage-phase21.test.js` | Ledger-count pin `9` → `10`, baseline-statement pin `143` → `145` (2 pins + comments). Nothing else touched. |
| `scripts/lib/migrate-sqlite.mjs`, `scripts/verify-phase13-db.mjs`, `scripts/verify-phase14-db.mjs` | `BASE_SKIP_COLUMNS.Payment` += the 6 columns (repo protocol for a growing history — see §6). |
| `docs/GO_LIVE_RUNBOOK.md`, `docs/DEPLOYMENT_GUIDE.md` | Added the missing `--schema prisma/schema.postgresql.prisma` to 4 `migrate deploy`/`migrate status` commands in PostgreSQL-production context (3 one-line fixes; §7). |

No `src/**`, migration-history, or config file was modified.

## 2. Schema change

```prisma
model Payment {
  // ... 10 pre-existing fields, untouched ...
  senderPhone      String?    // sender-declared phone (PR2a writes)
  requestedGroupId String?    // requested group, FK-less by design (PR2a writes)
  requestedPlanId  String?    // requested plan, FK-less by design (PR2a writes)
  rejectionReason  String?    // admin reason (PR3 writes)
  reviewedAt       DateTime?  // admin decision time (PR3 writes)
  reviewedByUserId String?    // deciding admin, FK-less by design (PR3 writes)
  // ... 2 pre-existing relations, untouched ...

  @@index([status, createdAt])        // review queue + operator reports
  @@index([subscriptionId, status])  // per-subscription payment lookups
}
```

Design constraints (all enforced by the test):

- **Nullable, no defaults.** Every pre-existing row stays valid; `ADD COLUMN`
  without a `DEFAULT` is metadata-only on both engines (no rewrite, no
  backfill, zero data movement).
- **No foreign keys, no relations.** Request fields must accept ids that fail
  closed at the application layer (unknown group/plan/user must never hard-fail
  a payment write); review fields mirror `TeacherApplication`'s FK-less
  `reviewedByUserId` precedent. Relation count on `Payment` stays at 2.
- **Field order:** the 6 fields sit after `updatedAt`, so the fresh-provision
  column order (baseline DDL) is identical to the incremental order (`ALTER
  TABLE … ADD COLUMN` appends) — zero ordinal drift between the two
  provisioning paths (proven by test §3b).

## 3. The migration (dual-dialect)

`20260914120000_payment_lifecycle_redesign` sorts after all 9 predecessors and
contains exactly 8 statements — no `DROP` / `DELETE` / `TRUNCATE` / `UPDATE` /
backfill. It is the **first migration that replays on PostgreSQL**: the 9 older
files are SQLite-dialect and were baselined on Neon via
`migrate resolve --applied` (never replayed). This file MUST stay valid on
both engines:

| Rule | Why |
| ---- | --- |
| `TEXT` for the 5 String columns | Native on both engines. |
| `TIMESTAMPTZ(3)` for `reviewedAt` | The repo's canonical PG DateTime rendering (`scripts/db/pg-lib.mjs`); SQLite accepts any type name. Never `DATETIME` (unknown type on PG). |
| Plain `ADD COLUMN` (no `IF NOT EXISTS`) | PG has it, SQLite does not — dual-dialect forbids it. |
| `CREATE INDEX IF NOT EXISTS` | Supported by both (PG 9.5+, SQLite); matches the repo's idempotent-object convention. |
| Index names `Payment_status_createdAt_idx`, `Payment_subscriptionId_status_idx` | Exactly Prisma's convention and byte-identical to the baseline emitter output, so incremental-Neon and fresh-provision converge (test §3b). |

Known, accepted trade-off: `TIMESTAMPTZ(3)` is not Prisma's SQLite-canonical
`DATETIME` spelling, so a future `migrate dev` shadow-diff may show cosmetic
noise on this column. The author of the next migration reviews that diff as
usual; convergence between Neon's incremental state and a fresh baseline
provision (the property that actually protects production) takes precedence.

## 4. Exact future commands (Neon safety)

PR1 performs **no** production apply. When the release train reaches Neon, run
from the repo root with the production `DATABASE_URL` (Neon Postgres):

```bash
# 1. Apply the ONE pending migration to Neon (NOT bare `migrate deploy`:
#    the default schema.prisma targets sqlite and fails against a PG URL).
npx prisma migrate deploy --schema prisma/schema.postgresql.prisma

# 2. Verify — must report "Database schema is up to date".
npx prisma migrate status --schema prisma/schema.postgresql.prisma

# 3. Regenerate the client against the PG schema (deploy pipeline step).
npx prisma generate --schema prisma/schema.postgresql.prisma
```

Local SQLite development is unchanged (default schema):

```bash
npx prisma migrate deploy    # applies the same file to local SQLite
npx prisma migrate status
```

Fresh-provision path (empty PG, e.g. staging): apply the regenerated
`scripts/db/postgres-baseline.sql` (it already contains the 6 columns + 2
indexes), load data, then baseline the ledger for **all 10** names:

```bash
psql "$DATABASE_URL" -f scripts/db/postgres-baseline.sql
# ... load data per docs/POSTGRES_CUTOVER_RUNBOOK.md ...
for m in $(ls prisma/migrations); do
  npx prisma migrate resolve --applied "$m" --schema prisma/schema.postgresql.prisma
done
# (marks all 10, incl. 20260914120000_payment_lifecycle_redesign, applied WITHOUT
# replay — the baseline already contains their DDL)
```

Rollback: PR1 has no application readers, so rollback is "deploy the previous
app build" (schema stays; unread columns are inert). A schema-level revert
would be a NEW migration dropping the columns — never edit history, never
`db push`, never reset production.

## 5. Operator report queries (PR4 read-only kit)

Canonical text lives in `tests/payment-lifecycle-phase25-ledger.test.js`
(`REPORT_QUERIES`) and is executed there on both engines against a
deterministic fixture. All six are single `SELECT`s with zero write/DDL
keywords (asserted). `$1` = "now" cutoff (ISO-8601); replace with a timestamp
literal when running by hand (`psql`/`sqlite3`).

- **A — past-due ACTIVE subscriptions** (renewal candidates):
  `SELECT s."id", s."studentId", s."planId", s."endDate" FROM "Subscription" s WHERE s."status" = 'ACTIVE' AND s."endDate" IS NOT NULL AND s."endDate" < $1 ORDER BY s."endDate", s."id"`
- **B — PENDING payments** (review queue):
  `SELECT p."id", p."userId", p."amount", p."method", p."createdAt", p."senderPhone", p."requestedGroupId", p."requestedPlanId" FROM "Payment" p WHERE p."status" = 'PENDING' ORDER BY p."createdAt", p."id"`
- **C — PENDING subscriptions**:
  `SELECT s."id", s."studentId", s."planId", s."createdAt" FROM "Subscription" s WHERE s."status" = 'PENDING' ORDER BY s."createdAt", s."id"`
- **D — grouped but unsubscribed students** (in a group, no ACTIVE sub):
  `SELECT st."id", st."userId", st."groupId" FROM "Student" st WHERE st."groupId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."studentId" = st."id" AND s."status" = 'ACTIVE') ORDER BY st."id"`
- **E — legacy NULL rows** (PENDING, no subscription, none of the new request fields):
  `SELECT p."id", p."userId", p."amount", p."createdAt" FROM "Payment" p WHERE p."status" = 'PENDING' AND p."subscriptionId" IS NULL AND p."senderPhone" IS NULL AND p."requestedGroupId" IS NULL AND p."requestedPlanId" IS NULL ORDER BY p."createdAt", p."id"`
- **F — REJECTED + coupon rows** (coupon-repair input for PR4):
  `SELECT p."id", p."userId", p."rejectionReason", p."reviewedAt", p."reviewedByUserId", r."couponId" FROM "Payment" p JOIN "CouponRedemption" r ON r."paymentId" = p."id" WHERE p."status" = 'REJECTED' ORDER BY p."id"`

Query F joins via the real `CouponRedemption.paymentId` link (added pre-PR1);
all queries reference only shipped columns — no inferred fields.

## 6. Proof summary

`tests/payment-lifecycle-phase25-ledger.test.js` — **133 passed, 0 failed**
(PGlite 0.5.8 / PostgreSQL 18.3 leg executed for real; `node:sqlite` leg;
scratch temp dirs only — production Neon untouched):

| § | What it proves |
| - | -------------- |
| 0 | Zero `src/` references to the 4 Payment-unique new names; zero `reviewedAt/reviewedByUserId` in payment-delegate files (behavior-neutrality) |
| 1 | Migration file: exactly 8 statements (6× ADD COLUMN + 2× CREATE INDEX), zero destructive tokens, exact names/types |
| 2 | `schema.prisma`: exactly the 6 bare nullable fields + 2 `@@index`; relation count still 2 |
| 3 | `--check` drift gate passes; baseline + derived schema carry the ledger |
| 3b | Fresh-provision DDL == incremental DDL (types + index definitions converge) |
| 4 | SQLite: 4 legacy rows byte-identical, new cols NULL, indexes correct, new-style + legacy writes OK, old FK intact |
| 5 | PostgreSQL (PGlite): same bytes, same assertions, `information_schema`/`pg_indexes` verified |
| 6 | Reports A–F read-only, expected rows on BOTH engines, PG results identical to SQLite |
| 7 | History intact: 10 migrations, new file sorts last |

Migration-history protocol (§1 scripts): the repo derives its scratch
pre-migration base from the CURRENT `schema.prisma` minus `BASE_SKIP_COLUMNS`
(see the header of `scripts/lib/migrate-sqlite.mjs`: "If the migration history
grows, update the skip lists"). All three copies (shared runner +
`verify-phase13/14-db.mjs`) gained the 6 Payment columns; without this, every
real-DB rehearsal fails with `duplicate column name: senderPhone`. Proven by
Phase 21's fixture build plus both standalone verifiers applying all 10 files.

Regression battery (same sandbox, `pg` + `@electric-sql/pglite` side-installed
via git-ignored `node_modules` symlinks): ledger **133/0**; `phase21`
**178/0** (incl. the `--check` drift gate); `migration-sql` 15/0;
`platform-upgrade-2026-migration` 98/0. The remaining suites
(`session-lifecycle-phase13`, `session-materials-phase14`,
`admin-publishing-phase15`, `session-notifications-phase17`,
`teacher-workflow-phase18`, `teacher-application-phase20`,
`security-hardening-phase20`, `security-audit-gate`,
`presigned-uploads-phase23`, `vercel-cron-retention-phase24`,
`final-integration-phase22`) fail IDENTICALLY on the clean-tree baseline
(stash-compared): missing `tsc` toolchain or missing `db/custom.db` +
`backups/` data files — pre-existing environmental walls, none touched by PR1.
`tsc` / ESLint / `next build` cannot run here (no full `node_modules`, Prisma
engines unreachable — same standing blocker as Phases 6–24); the substitute is
`git diff --name-only` proving zero `.ts`/`.tsx`/`src/**` changes plus
`node --check` on every touched JS/MJS file.

## 7. Runbook corrections in this PR

Three pre-existing commands were objectively wrong for Neon (bare `migrate
deploy`/`migrate status` read the sqlite `schema.prisma` and fail against a
PostgreSQL URL); each gained `--schema prisma/schema.postgresql.prisma`:

- `docs/GO_LIVE_RUNBOOK.md` — "Already on PostgreSQL" block (2 lines).
- `docs/DEPLOYMENT_GUIDE.md` — "Prisma migrations (recommended for PostgreSQL
  production)" block (1 line) + the VPS-update PostgreSQL parenthetical
  (1 line).

Untouched on purpose: `DEPLOYMENT_GUIDE.md` §F.4 (SQLite-local context — bare
commands correct there), `POSTGRES_CUTOVER_RUNBOOK.md` (already `--schema`d;
its "9 names" records the completed cutover), all historical phase reports.

## 8. Out of scope (explicitly NOT in PR1)

No sender/reference validation, no drawer, no transitions, no locking, no
renewal logic, no coupon repair, no backfill, no `src/**` behavior change, no
Neon apply, no reset/recreate of any database, no edits to old migrations, no
production data reads/writes, no credential handling. PR2a writes the request
columns; PR3 writes the review columns; PR4 operationalizes the §5 queries.
