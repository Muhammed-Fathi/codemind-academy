# Group.trackScope production recovery investigation

## Decision: HOLD — NOT READY FOR GIT DELIVERY

Investigation date: 2026-09-15. Repository base: `39ba92ab010b5f951de83016127a40c5513490d5`, matching fetched `origin/main`. Full git history was fetched; work remains on `arena/01a0a75c-codemind-academy`. No commit, push or PR was created. No production connection, SQL, data change, resolve, deploy or db push was performed. Only disposable embedded test databases were mutated.

Repository causality is proven. The exact production execution path, current values, full live schema, and real PostgreSQL 17 recovery are **not yet proven**. This report does not authorize recovery.

## 1. Root cause and historical evidence

There was no later deliberate change from a PostgreSQL TEXT model to an enum model. Two deployment representations diverged **at the introduction of the column**:

| History | Evidence |
|---|---|
| Phase 12 | `docs/PHASE_12_TRACK_ARCHITECTURE.md`, `docs/PHASE_12_FINAL_REPORT.md`, `src/lib/track-scope.ts`: TrackScope is SHARED / ARABIC / LANGUAGE; content containment is separate from school identity. SQLite physically stores enum values as TEXT. |
| `0530edc` (Phase 21) | `scripts/db/pg-lib.mjs::pgTypeOf` already returns a quoted native enum type for `field.isEnum`. `make-postgres-schema.mjs` copies the source schema, swapping the provider only. The DDL emitter explicitly documents native PostgreSQL enums vs SQLite TEXT. |
| Phase 21 provisioning | `migrate-sqlite-to-postgres.mjs` expects an already provisioned baseline, then copies data; it is not an incremental schema reconciliation mechanism. Baseline generation does not inspect existing databases. Backup/restore scripts preserve the database schema they back up; restoration does not make incremental TEXT columns into enums. |
| `137d35fe7081bcdf727cc28bde68774f157dcd13` (Phase 26B) | Adds `Group.trackScope TrackScope?` and index to the source AND derived PG schema (then `prisma/schema.postgresql.prisma`). In the SAME commit, baseline DDL gets `"trackScope" "TrackScope"`, while the incremental migration gets `"trackScope" TEXT`. |
| Phase 26B report | `docs/PHASE_26B_STUDENT_FULL_FLOW_QA.md` §3 explicitly documents nullable enum semantics AND the TEXT migration. Its migration comment claims old SQLite migrations will never replay on PostgreSQL; this assumption was not enforced by the directory layout. |
| Pre-hotfix deploy layout | PG schema lived next to SQLite schema and shared `prisma/migrations`. Applying that directory on an existing PG database could execute the PostgreSQL-compatible 26B TEXT statement successfully; a subsequent 26D SQLite DATETIME statement then fails. |
| `00aee7a` (26D provider split) | Moves PG schema into its own directory and adds `0_init` with native enum `Group.trackScope`. It captures the generated model, not a verified production schema. |

**A. What created the Neon column?** The exact repository SQL capable of producing the reported state is below. This is the strongly supported lineage explanation, NOT a claim to possess production DDL logs. APPLIED migration rows alone cannot distinguish actual execution from `resolve --applied`; manual DDL could also produce identical state. Obtain the full checksum/steps/timestamps and deployment audit record before calling the exact Neon path proven.

**B. Intentionally TEXT?** Yes as a physical SQLite migration; no evidence of an intentional PostgreSQL TEXT exception. The migration itself calls this the existing TrackScope enum and incorrectly assumes it only executes on SQLite.

**C. When did PG authority become enum?** Phase 21 established the general rule; Phase 26B used it for this new field immediately. Not a later hotfix design change.

**D. Silent baseline conversion?** Generated DDL maps the logical enum to a native PG enum without checking the live database. It never executes a conversion. Thus it silently *disagreed with incremental deployment*, not silently mutated production.

**E. Only this column?** In the reproduced repository lineage, yes for the compared catalog sections. For production, not established; see §5.

## 2. Exact historical SQL

`prisma/migrations/20260915120000_phase26b_group_track_scope/migration.sql` executable statements:

```sql
ALTER TABLE "Group" ADD COLUMN "trackScope" TEXT;
CREATE INDEX "Group_trackScope_idx" ON "Group"("trackScope");
```

Nullable, no explicit default, no backfill. Existing rows receive NULL. The comments are part of the file checksum and must not be edited.

SHA-256 evidence:

- Historical 26B migration: `06cc038d4fc0f23b6fe63724f944f436c4007fc94ad4d04759c728bd893a4b39`
- Current PG `0_init`: `c7f5d3fa76931d02e48c5cd2c4bfdb972c0f25e528e3c0c116736d3729cefa80`
- Pre-26B baseline (`git show 137d35f^:scripts/db/postgres-baseline.sql`): `9ea178f385b603da64e7cae1062d77dfab1fbcde27f9c9b1dd6ee997be6570d3`

## 3. Which side is wrong?

- The reported live physical type disagrees with the checked-in Prisma PostgreSQL schema.
- The native-enum baseline correctly reflects declared application/Prisma semantics and fresh PG provisioning.
- Calling that baseline the already-existing production schema was wrong. It cannot truthfully be marked applied to the reported live TEXT state.
- The migration architecture and verification allowed incremental deployment and baseline provisioning to diverge. Do not characterize valid preserved production rows as corrupt without inspecting them.

## 4. Current production value safety: UNKNOWN

Only user-supplied evidence is available: live type TEXT; pre-26D ledger reportedly applied; failed 26D row; checked 26D objects absent. No independent connection was made.

Not known: row count, distinct values, NULL count, default, nullability, enum labels/order, additional dependencies, other live drift, full checksums or deployment logs. The old observation of zero groups is not current evidence.

Expected persisted group values: NULL (unclassified), ARABIC, LANGUAGE. SHARED is a valid enum value for content but is rejected for group authoring and ineligible for group selection. If SHARED exists in Group, it is cast-safe but a separate business-policy anomaly: stop for review, preserve it, do not silently reclassify. Any other literal (including blank, whitespace, lower-case labels, ALL/BOTH aliases, spelling variants) is not directly enum-cast-safe. Application normalization can accept aliases; that does not make them valid stored PostgreSQL enum labels. No automatic trim, uppercase, replacement or deletion is proposed.

### Exact read-only inspection prepared

New `scripts/db/inspect-pg-baseline.mjs` contains the exact SQL and emits structured JSON. The operator supplies the URL through their existing secure environment, never chat or command-line arguments. It does not load dotenv files or print connection strings, migration logs or routine bodies.

```sh
# Operator only; secure DATABASE_URL already configured. No URL in argv.
node scripts/db/inspect-pg-baseline.mjs > live-inventory.json
```

It explicitly opens a repeatable-read, READ ONLY transaction; sets statement/lock timeouts, stable search_path and row_security=off (fail instead of silently accepting RLS-filtered row counts); rolls back on completion. Run with SELECT/catalog access to all relevant objects. JSON contains:

- actual catalog type including type modifier, default, nullability and collation;
- all distinct Group values with counts (including NULL), total Group count;
- all public enum labels in declared order;
- all columns in all schemas directly using public.TrackScope;
- recursive recorded column dependencies via pg_depend;
- full public PK/unique/FK/check definitions, actions, validation and deferrability;
- indexes with definitions, predicates/expressions and readiness/validity;
- public table kinds, persistence and RLS flags; views and definitions;
- routine signatures requiring manual review, without sensitive bodies;
- full migration checksums, steps and timestamps, plus repository checksums.

Use PostgreSQL deployment/audit logs to establish whether 26B actually ran through Prisma. A matching checksum supports file identity, not proof of execution. Check ALL ledger rows, not just 26B; reject unrelated failed rows or already-applied 26D. Do not share URL, credentials or raw migration error logs.

Catalog dependency records are not a complete function-source analysis. PL/pgSQL/string-body SQL/dynamic SQL and external clients may reference the column without pg_depend records. A privileged operator must privately inspect routine bodies, cross-schema objects and application integrations before conversion. Do not paste bodies containing secrets.

## 5. Complete baseline comparison

The old checker does NOT stop at the first mismatch: it accumulates all differences across its limited inventory. It compares table/column presence, types and enum labels; constraints/indexes mostly by existence of names. It omits defaults, nullability, extra constraints/indexes and their definitions. Its claimed full-schema equivalence and exact-ledger gate were too strong.

The new inspector compares every row in BOTH directions for tables, columns, types, defaults, nullability, enums, constraints (PK/unique/FK/check) and indexes, plus views. It reports all differences, not just the first. Reference generation must be independently supervised:

1. Provision an EMPTY disposable PostgreSQL 17 database, load ONLY the exact current `0_init` SQL locally (never production).
2. Capture its JSON using the inspector. Name it `pg17-0-init.json`; retain SQL checksum and server version. A self-reported SQL checksum is provenance metadata, not proof that arbitrary reference JSON is trustworthy.
3. Run against live with secure env: `node scripts/db/inspect-pg-baseline.mjs --reference pg17-0-init.json > live-comparison.json`.
4. Exit 1 means differences; exit 2 means incomplete/unavailable inspection. Even exit 0 is only a catalog match, not ledger/data/dependency/recovery authorization.
5. Review full ledger, audience, dependencies and incident-state evidence separately. Do not use the current full `postgres-baseline.sql` as a pre-26D reference: it includes 26D.

**Actual result available now:** the embedded historical-lineage test has exactly one differing column, represented as two comparison rows (live TEXT and expected TrackScope). All other compared catalog sections match. **Production result: pending**, so no assertion that Neon has no other mismatches is justified.

Scope limitation: this is the public application baseline, not an entire database dump equivalence checker (roles/grants, extensions, sequences, triggers, policies, domain internals, partitions and cross-schema objects require separate review if present). Reference comparison assumes same PostgreSQL major version and stable catalog rendering.

## 6. Canonical model recommendation

**Recommend OPTION B: native PostgreSQL TrackScope enum, conditional on live evidence and successful real-server proof. Do not execute yet.**

Reasons are compatibility and history, not elegance:

- Both Prisma schemas explicitly declare TrackScope?, without a default; source semantics and generated PG schema agree.
- Phase 12 enum is SHARED, ARABIC, LANGUAGE, in that order. Existing content/segment fields already use it; no duplicate group enum or removal of SHARED is appropriate.
- Group reads/writes enforce exact ARABIC/LANGUAGE audience and NULL fail-closed behavior. Changing physical storage must preserve these rules, not broaden group eligibility to SHARED content semantics.
- Fresh PG installs, generated full baseline and restore-to-model verification already converge on enum. SQLite TEXT is its provider-specific physical equivalent, not proof that PostgreSQL should also use TEXT.
- Keeping TEXT would require a Group-specific derived-schema String? override (or weakening the shared source), generator exception, application typing audit, changed fresh-install baseline, and a reconciliation strategy for already-enum PG installations. Merely editing 0_init would leave Prisma and generator inconsistent.
- Do not edit historical SQLite migration bytes or rewrite an already-applied 0_init in other environments. Keep schema, generator and baseline enum representation; reconcile the legacy database before asserting that baseline.

Production data can block conversion even if enum remains the desired canonical model. If evidence instead establishes a deliberate supported arbitrary-text contract, reopen Option A rather than coercing data into Option B.

## 7. Repository changes

Implemented in this investigation:

1. New read-only catalog/data inspector with reference comparison and full checksum evidence.
2. New `tests/pg-baseline-inspection.test.mjs`: historical baseline + exact 26B SQL, full catalog comparison, enum convergence, synthetic-value preservation, simultaneous definition/default/nullability drift detection, incomplete-catalog rejection and read-only transaction request.
3. Legacy checker warning and narrowed equivalence wording (exit semantics otherwise unchanged).
4. Recovery-hold notice in cutover runbook and this report.

Still required AFTER review:

- Harden the final recovery checker to REQUIRE a trusted complete reference and exact ledger-state/checksum checks. The old exit-0 path is not a safe final gate.
- Author a separately versioned, guarded reconciliation script and its audit record. It must be explicit pre-baseline recovery, not a migration ordered after 0_init (that cannot fix a legacy DB before baseline resolution).
- Test the guarded script for TEXT, already-correct ENUM (verified no-op), invalid values, SHARED policy anomaly, unexpected defaults/nullability, dependencies, lock timeout, rollback and repeated invocation. Never silently skip arbitrary unexpected states.
- Replace/extend provider-test Neon simulation: it currently constructs 0_init directly and invents old ledger rows; this assumes away the defect. Use pre-26B provisioning plus historical 26B SQL first.
- Strengthen provider test catalog snapshots: they currently miss definition/default/nullability drift like the old checker.
- Update runbook final gate, restore branches and approved commands only after PG17 proof. No baseline/schema/generator or historical migration changes recommended for Option B.

## 8. Proposed production recovery — NOT EXECUTED / NOT APPROVED

1. Obtain reviewed read-only inventory and historical deployment evidence. Confirm PostgreSQL version, exact enums, no unexpected drift, exact ledger, no partial 26D state, audience policy and dependencies. Any unknown blocks progress.
2. Verify backup/PITR and rehearse its restoration locally. Freeze writes and automated deploys. Schedule maintenance: TEXT→ENUM may rewrite the table and rebuild indexes; estimate duration, disk/WAL and lock impact on the restored copy. Do not assume empty Group.
3. Approved guarded reconciliation runs in one transaction with short lock/statement timeouts and an ACCESS EXCLUSIVE lock on public.Group. Re-read values and schema AFTER lock to prevent validation/write races. Assert exact TEXT/nullable/no-default historical precondition and exact enum labels/order. Abort on any other shape; already-enum is only a verified no-op after full checks.
4. Assert every non-NULL stored value exactly matches an enum label; independently stop for SHARED business anomaly. Assert no unreviewed dependency blocks conversion. Preserve all values and NULLs.
5. For proven nullable/no-default state, proposed core DDL is:

   ```sql
   -- DESIGN ONLY: not an approved standalone production script.
   ALTER TABLE public."Group"
     ALTER COLUMN "trackScope" TYPE public."TrackScope"
     USING "trackScope"::public."TrackScope";
   ```

   No SET NOT NULL, backfill, row deletion or invented default. If inspection finds a default, STOP: review and explicitly drop/restore a semantically identical enum-typed default inside the transaction; a USING clause does not convert defaults automatically. Unexpected NOT NULL also requires review, not silent removal. Review/recreate blocking dependent objects only under a separately approved plan.
6. Within the locked transaction verify type, default, nullability, total count and per-value counts match the captured pre-state; check indexes/constraints. Roll back on discrepancy. Record script revision/checksum and before/after evidence outside the migration ledger.
7. After approved commit, rerun full catalog comparison against 0_init and incident/ledger checker. Only exact convergence permits the next step. Never mark 0_init applied on TEXT or with any other difference.
8. Only THEN, and with separate operator approval, proposed Prisma sequence (secure environment, no URL argv):

   ```sh
   npx prisma migrate resolve --rolled-back 20260915180000_phase26d_quiz_attempt_architecture --schema prisma/postgres/schema.prisma
   npx prisma migrate resolve --applied 0_init --schema prisma/postgres/schema.prisma
   npx prisma migrate deploy --schema prisma/postgres/schema.prisma
   npx prisma migrate status --schema prisma/postgres/schema.prisma
   ```

   Skip rolled-back resolution only after verifying the exact approved already-rolled-back state. Existing inert SQLite-era ledger checksums remain unchanged. Never edit/delete old rows manually. Fresh PG installs use normal 0_init + PG-native 26D deploy with no recovery resolution.
9. Compare recovered schema against a disposable full migration-chain reference; validate Phase26D objects, no unresolved failures, Prisma clean status and idempotent deploy locally first, then production health/read-write smoke under explicit approval.
10. Restore paths: pre-26B backup needs reviewed historical upgrade then reconciliation; TEXT-era backup needs this reconciliation; enum pre-26D backup needs exact baseline verification only; already-post-26D backup needs post-26D verification, NOT incident recovery. Preserve restored ledger and inspect rather than blindly replaying this sequence. Do not reverse-convert after a failed 26D deploy by default; investigate and use verified transactional/PITR rollback procedures.

## 9. Reproduction / proof status

**Supplemental embedded engine test PASSED, not the requested real PostgreSQL 17 proof.**

`node tests/pg-baseline-inspection.test.mjs`:

- provisions exact pre-26B baseline from git history;
- applies exact historical 26B migration file;
- reproduces TEXT versus enum catalog mismatch;
- finds no other mismatch in all compared catalog sections;
- performs proposed core conversion on this disposable database;
- obtains exact 0_init catalog convergence;
- proves NULL/ARABIC/LANGUAGE/SHARED preservation with synthetic temporary data (not production data and not permission to allow SHARED groups);
- injects simultaneous column default/nullability, same-name index definition, same-name FK action and extra-table drift; confirms all categories reported;
- verifies inspector requests read-only transaction and rollback on error. PGlite testing alone does not prove server-enforced role behavior.

Real PG17 unavailable: no preinstalled psql/PostgreSQL/docker. Attempted local PostgreSQL 17 installation; Debian/PGDG package sources failed network/TLS access and package could not be located. Prisma engine generation also failed downloading from binaries.prisma.sh. No substitute was represented as real PostgreSQL.

Required uncompleted proof on a disposable real PG17 server: steps above with actual historical ledger fixture and failure reproduction in legacy checker; execute fully guarded reconciliation; simulate failed 26D ledger; run reviewed resolve→baseline→deploy via real Prisma engine; assert clean status, exact full-schema convergence, ledger coherence and second deploy no-op. Also test fresh installs and representative restores. Existing provider B/C simulations alone are insufficient because they start at 0_init rather than the historical TEXT lineage.

## 10. Test results

All commands were run with no production URL; verification harnesses used local disposable fixtures. Dependencies installed with `npm ci --ignore-scripts` (no lockfile changes).

| Requested command | Result |
|---|---|
| `node tests/migration-providers.test.js` | PASS 54; real PG and Prisma-engine sections SKIPPED |
| `node scripts/verify-phase26d-teacher.mjs` | PASS 306 |
| `node tests/phase26d-teacher-full-flow.test.js` | PASS 136 |
| `node scripts/verify-phase26b-group-track.mjs` | PASS 78 |
| `node scripts/verify-phase26b-student.mjs` | PASS 238 |
| `node tests/track-architecture-phase12.test.js` | PASS 308 |
| `node scripts/verify-phase21-migration.mjs` | PASS 28 (PGlite rehearsal) |
| `node tests/migration-sql.test.js` | PASS 15 |
| `npx tsc --noEmit` | FAIL exit 2; generated Prisma exports unavailable, plus reported type errors; NOT declared clean |
| `npm run build:postgres` | BLOCKED/FAIL exit 1 at Prisma engine download, before Next build |
| Real PostgreSQL provider/recovery tests | NOT RUN: server/engine unavailable; skips are NOT passes |
| New `node tests/pg-baseline-inspection.test.mjs` | PASS, embedded only |
| `node scripts/db/make-postgres-schema.mjs --check` | PASS; schema and generated DDL in sync |
| `git diff --check` | PASS |

Local raw regression logs: `/home/user/recovery-results/`; excluded from Git delivery. Type-check failures have not been independently classified against a successfully generated pristine client, so no claim that all are pre-existing is made.

## 11. Remaining risks and evidence needed

- Actual production SQL execution route remains inferential; obtain audit/deploy evidence and full ledger checksums.
- Current production values, row counts, default/nullability, dependencies and full catalog comparison remain unknown.
- Arbitrary historical TEXT aliases may be application-readable but not enum-cast-safe.
- SHARED is enum-valid but group-policy-invalid; requires review, not data cleanup during recovery.
- Table rewrite/lock duration and dependencies cannot be estimated from old zero-row inventory.
- Function/dynamic SQL references, cross-schema objects, RLS and external consumers need privileged review.
- Trusted reference provenance and matching server major version are operator responsibilities.
- Legacy checker remains a limited incident inventory; recovery hold overrides its exit 0.
- Guarded reconciliation, real Prisma history recovery, PG17, fresh/restore convergence, generated-client typecheck and production build are pending.

## 12. READY FOR GIT DELIVERY?

**NO.** Investigation artifacts and a read-only inspection candidate are available for review. Repository-level causality and embedded reproduction are established; exact production lineage and required production safety evidence are not. The user must review this report before a PR; the missing real-PG17/Prisma proof and build/typecheck gates must also be completed. Production Neon remains untouched.
