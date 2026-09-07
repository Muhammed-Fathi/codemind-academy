# ADR-004: Baseline the migration history and reconcile ALTER-added foreign keys

## Status

Accepted (Phase 3 correction).

## Context

The production schema was created and evolved with `prisma db push`
(`package.json` `db:push` script, `docs/DATABASE_MIGRATION.md` §2). The
migration folders committed later (`20260904090608_add_student_identity_fields`,
`20260906120000_platform_upgrade_2026`, `20260907100000_phase3_domain_foundation`)
were written as *manual, offline-applyable SQL* for existing databases; they
were never replayable from an empty database because no migration created the
core tables (`User`, `Student`, `Course`, …). Consequences:

1. `npx prisma migrate dev` on a clean database failed with **P3006**
   (first migration `ALTER`s a `Student` table that does not exist in the
   shadow database), so a fresh environment could not be created from the
   repository.
2. SQLite `ALTER TABLE` cannot add `FOREIGN KEY` constraints, so the four
   relation columns added by the additive migrations (`Student.batchId`,
   `ExamAttempt.mockExamId`, `Course.trackId`, `Lesson.unitId`) existed without
   the FK constraints that `prisma/schema.prisma` declares — replaying the
   history did not converge with the schema (drift), and hand-written default
   syntax differed from Prisma's canonical `db push` output.

There is no `_prisma_migrations` table in any environment (all existing
databases are `db push`-managed), so **no checksum is recorded anywhere** and
correcting migration files cannot invalidate recorded history.

## Decision

1. **Add a baseline migration** `20260901000000_baseline_core_schema` that
   creates exactly the pre-2026-09-04 core schema, derived — not invented — by
   reversing the documented additive changes of the three later migrations.
   DDL follows Prisma's canonical SQLite output (`DEFAULT true/false`, no SQL
   default on `@updatedAt`), so replay and `db push` environments converge.
2. **Add `prisma/migrations/migration_lock.toml`** (`provider = "sqlite"`).
3. **Add one correction migration** `20260907130000_phase3_fk_reconciliation`
   that adds the four missing FK constraints using Prisma's canonical SQLite
   table-redefinition pattern (copy → drop → rename → recreate indexes),
   preserving every row. It is the only migration that rewrites tables; on
   `db push`-produced databases (FKs already present) it is a harmless no-op.
4. **Normalize semantics-identical syntax** in the two hand-written additive
   migrations (`BOOLEAN ... DEFAULT 1/0` → `true/false`; remove SQL defaults
   from `@updatedAt` columns) so the replayed state matches `db push` state.
5. **Declare `@@index([trackId])` on `Course`** in `schema.prisma` to match
   the index the (approved) Phase 3 migration already creates.
6. **Do not rewrite the additive contracts** of the existing migrations: their
   tested invariant ("no `DROP TABLE`/`RENAME`, every `CREATE` guarded,
   metadata-only `ALTER`s") stays intact — that is why the FK redefinitions
   live in a *separate* migration rather than inside them.
7. **Reconcile existing databases by baselining**, never by reset:
   `prisma migrate resolve --applied <each of the first four migrations>`,
   then `migrate dev`/`deploy` applies the FK reconciliation migration. Data
   is never deleted or reset.

## Alternatives considered

- **Squash everything into one init migration** — rejected: silently rewrites
  published history and discards the reviewed/test-documented additive
  migration contracts.
- **`prisma db push` as the permanent workflow** — rejected: no repeatable
  from-empty bootstrap, no audit trail, and is exactly what produced P3006.
- **`prisma migrate reset`** — rejected: destructive to local `custom.db`
  data; explicitly forbidden.
- **Embedding the table redefinitions inside the existing migrations** —
  rejected: would violate their (test-enforced) "no table rewrite" safety
  contract and make manual Option-B application on production risky.

## Consequences

- `prisma migrate dev` / `migrate deploy` work from a clean database and for
  all future migrations; the shadow database replays cleanly (no P3006).
- Existing `db push`-managed databases transition to migration management with
  five one-time commands and zero data loss (procedure in
  `docs/DATABASE_MIGRATION.md` §8).
- Consistency is machine-verified offline by
  `tests/migration-history-consistency.test.js` (replay ≡ `schema.prisma`,
  including FKs and defaults; data-preservation and P3006 regression checks).
