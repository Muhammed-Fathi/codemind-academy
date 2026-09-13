-- CodeMind Academy — Phase 25 PR1: payment-lifecycle ledger (ADDITIVE ONLY).
--
-- Adds 6 NULLABLE columns (no defaults, no foreign keys) and 2 indexes to
-- "Payment". Behavior-neutral: no writer, reader, transition, validation, UI,
-- WhatsApp, expiry, cron, or R2 change ships with this migration.
--
-- DUAL-DIALECT: this file MUST remain valid on BOTH SQLite (local dev, applied
-- via `prisma migrate deploy` with the default schema.prisma) AND PostgreSQL
-- (production Neon, applied via `prisma migrate deploy --schema
-- prisma/schema.postgresql.prisma`). Rules that keep it dual-valid:
--   * TEXT is native on both engines (all 5 String columns).
--   * TIMESTAMPTZ(3) is the repo's canonical PostgreSQL DateTime rendering
--     (see scripts/db/pg-lib.mjs); SQLite accepts any type name, so the same
--     token parses on both. Do NOT use DATETIME (unknown type on PostgreSQL)
--     or plain ADD COLUMN IF NOT EXISTS (unsupported on SQLite).
--   * CREATE INDEX IF NOT EXISTS is supported by both engines (PostgreSQL 9.5+,
--     SQLite) and matches the repo's idempotent-object convention.
--   * Zero destructive statements: no DROP / DELETE / TRUNCATE / UPDATE,
--     no backfill, no data rewrite. ADD COLUMN without a DEFAULT is
--     metadata-only on both engines; every pre-existing row reads NULL here.
--
-- Fresh-provision convergence: after regenerating the derived artifacts, the
-- fresh-provision path (postgres-baseline.sql + resolve --applied) and the
-- incremental path (this file via migrate deploy) produce identical column
-- definitions and index names — see tests/payment-lifecycle-phase25-ledger.test.js.

ALTER TABLE "Payment" ADD COLUMN "senderPhone" TEXT;
ALTER TABLE "Payment" ADD COLUMN "requestedGroupId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "requestedPlanId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "Payment" ADD COLUMN "reviewedAt" TIMESTAMPTZ(3);
ALTER TABLE "Payment" ADD COLUMN "reviewedByUserId" TEXT;
CREATE INDEX IF NOT EXISTS "Payment_status_createdAt_idx" ON "Payment" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "Payment_subscriptionId_status_idx" ON "Payment" ("subscriptionId", "status");
