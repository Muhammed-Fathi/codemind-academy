# Phase 12 — Track Architecture & Enforcement

**Date:** 2026-09-09  
**Baseline:** `66f56f57b8e400cdac98bc2ebfbb2bb43de52926` (Phase 11 merge)  
**Branch:** `arena/01a085ed-codemind-academy`  
**Status: BLOCKED — REQUIRES FIXES. Prerequisite repair only; track implementation NOT started.**

This is a blocker report, **not a completed Phase 12 implementation report**.
The request explicitly prohibits starting track implementation until the official
reconciler succeeds twice against the actual local SQLite database. That gate
has not passed. No track security guarantee is claimed by this change.

## Discovery and prerequisite boundary

Inspected the master audit's track/enrollment recommendations, Phase 11 report,
project state, current Prisma schema and migration history, reconciler/CLI,
school-type/enrollment helpers, session-quiz selection, and existing curriculum
regression harness. Repository searches identified school-type/track/curriculum
references across API routes, libraries, components and scripts. The complete
route-by-route Phase 12 authorization/write-path audit is **not complete**; work
stopped at the mandatory prerequisite gate.

Confirmed from the checked-out code:

- `Part` and `Unit` have `order` and unique `id`, **not `createdAt`**.
- The official model defines 2 parts, 7 units and 23 unique lesson codes.
- `Student.schoolType` is nullable `String`; `Batch.schoolType` is `SchoolType`.
- `normalizeSchoolType` supports case/whitespace normalization and existing
  aliases (`AR`, `عربي`, `LANG`, `LANGUAGES`, `لغات`); unknown input returns null.
- `getEnrollment` resolves an active `Student.group → Group.course` relationship.
  Its comment claiming there is no Enrollment table is stale: the schema has one.
- `Track`, `Course.trackId`, and persisted `Enrollment` exist in the schema;
  searches found no active Prisma access to these models in application code.
- `syncStudentBatch` uses matching active batches and a global-course fallback;
  it does not clear an old assignment when there is no matching batch.
- Session quiz selection currently queries `{ quizId }`, without school-type
  filtering. Frozen answer rows remain the attempt question-set mechanism.
- This checkout initially had no installed dependencies, Bun executable, local
  `.env`/SQLite DB under the workspace, or configured `DATABASE_URL`.
- The four historical migrations are incremental; the first alters an existing
  `Student` table. They are not a fresh-database bootstrap history. No database
  was fabricated or reset to stand in for the user's actual local database.

Bun 1.4.2 was installed as a sandbox tool and `bun install --frozen-lockfile`
succeeded, resolving Prisma 6.19.2. No package manifest or lockfile changed.

## Phase 11 post-merge defect and repair

Both `client.part.findMany` and `client.unit.findMany` passed:

```ts
orderBy: [{ order: "asc" }, { createdAt: "asc" }]
```

The production Prisma Client correctly rejects `createdAt` on these models.
The old test double ignored the supplied `orderBy` and fabricated `createdAt`
properties, so its success did not establish compatibility with Prisma.

Both queries now use only existing fields:

```ts
orderBy: [{ order: "asc" }, { id: "asc" }]
```

This preserves positional adoption within each parent (including legacy Part 2
unit orders 1,2,3 becoming global orders 5,6,7). Unique, stable IDs resolve ties;
no title matching, course duplication, schema field, or migration was added.
Lesson/media/history mutation policy is unchanged.

The test double now validates ordered scalar fields against the actual checked-out
`prisma/schema.prisma`, obeys the supplied sort clauses, and no longer fabricates
Part/Unit timestamps. Eleven added assertions cover schema compatibility, invalid
ordering rejection, insertion-independent tie ordering, tied-position adoption,
and zero further semantic writes after that adoption. All 51 previous assertions
remain. Independently mutating either production query back to `createdAt`
causes the suite to exit 1 with `Unknown argument \`createdAt\``; restoring the
repair passes 62/62.

**Closure status:** source repair and offline regression verified; defect is
**NOT CLOSED under the requested release contract** because real local DB
reconciliation has not succeeded. Offline zero-semantic-write checks are not
proof of zero SQL writes: the existing course upsert remains unchanged.

## Track model decision

**Not ratified/implemented: prerequisite gate blocked.** The intended design to
resume evaluating is one shared Course → Part → Unit → 23 official Lessons, with
SHARED/ARABIC/LANGUAGE content eligibility underneath, never course copies.
`Track`/`Course.trackId` remain unchanged schema-only structures. No partial
runtime adoption or track authorization was introduced.

## Enrollment decision

**No cutover made.** Group-derived access remains the sole runtime enrollment
gate. Recommended eventual verdict is formal deprecation of the unused
persisted `Enrollment`/`Track` schema, retaining it non-destructively for historical
compatibility. That Phase 12 decision and full reader audit are not represented
as completed by this prerequisite-only patch. No parallel access gate was added.

## Student.schoolType decision

**Unchanged nullable String pending real-data audit.** No normalization backfill,
enum conversion, constraint, new validation, or write-path change was performed.
Before counts, unexpected values, null counts and after counts are **unavailable**,
not zero. Unknown legacy values must be resolved explicitly before migration.

## Batch decision

**Unchanged pending Phase 12.** No reconciliation helper or write hooks were added.
The sticky membership risk remains open. Course-specific, deterministic,
idempotent reconciliation still needs implementation and tests.

## TrackScope and enforcement status

No TrackScope enum/columns/indexes were added. Intended matching remains:
SHARED allows both valid school types; ARABIC allows only ARABIC; LANGUAGE allows
only LANGUAGE; unknown student types must fail closed. This describes the requested
future contract, **not the current implementation**.

The following Phase 12 work is deliberately unimplemented because the prerequisite
failed: lesson/prev-next/dashboard/progress filtering, quiz selection and grading
bank enforcement, explicit teacher question tagging, homework scope enforcement,
video/batch/media isolation, parent child-track enforcement, teacher/admin scope
management, analytics track primitives, school-type migration/backfill, and batch
healing. No claim of cross-track IDOR protection or combined Phase 11 + Phase 12
coverage is made. Existing progression, parent, teacher/admin and analytics behavior
was not changed. The full Phase 12 dedicated suite has not been created.

## Database/migration/backfill result

- No schema changes, migration additions/edits, backfills, deletes, resets or DB pushes.
- No actual local DB writes or student-data inspection were possible.
- 2/7/23 hierarchy, exact codes, archival isolation and idempotency pass in the
  existing offline model/mocked-DB suite only; **actual DB counts are unverified**.
- Invalid-school-type count, duplicate-code count and schema drift are unverified.
- No `.env`, secrets, database, generated artifacts, or dependency changes in patch.

## Verification results

Commands were run after the repair, using the repository's real scripts:

| Command | Exit | Result |
|---|---:|---|
| `bun install --frozen-lockfile` | 0 | PASS; tooling setup only |
| `bun run db:generate` | 1 | FAIL environmental: TLS connection to `binaries.prisma.sh` disconnected before establishment |
| `bunx prisma migrate status` | 1 | FAIL environmental: Prisma schema-engine download failed; cannot claim schema is up to date |
| `bun run scripts/reconcile-curriculum.ts` run 1 | 1 | FAIL environmental: `@prisma/client did not initialize yet` |
| Same reconciler, run 2 | 1 | Same failure, before any DB verification |
| `bun run typecheck` | 2 | FAIL: 22 diagnostics with missing generated Prisma exports/types |
| `bun run lint` | 1 | FAIL: 50 errors, 1 warning |
| `bun run build` | 1 | FAIL environmental at `prisma generate`; Next build never reached |
| `git diff --check` | 0 | PASS |

Prisma download failure URLs identify commit
`c2990dca591cba766e3b7ef5d9e8a84796e47ab7`, `debian-openssl-3.0.x` engine/checksum
files. Repeated generate/status attempts reproduced the network failure.
**The production `createdAt` defect is separate from this environment failure.**

Baseline comparison used a `git archive` of `66f56f5` outside the checkout, with
the same installed dependencies; no branch switch. Baseline typecheck also
returned 2 with 22 diagnostics and baseline lint returned 1 with 50 errors/1
warning. Outputs are identical after normalizing the repository path: **zero
additional typecheck or lint failures**. Existing lint findings include five React
hook errors, CommonJS test imports, and one navigation warning. No lint rules were
weakened and no generated stub was substituted to claim a passing typecheck.

### Offline regression matrix

Each command was `node tests/<name>.test.js`; every process returned 0.

| Test file | Passed | Failed |
|---|---:|---:|
| `tests/curriculum-reconciliation-phase11.test.js` | 62 | 0 |
| `tests/session-progression.test.js` | 151 | 0 |
| `tests/session-quiz.test.js` | 70 | 0 |
| `tests/quiz-analytics.test.js` | 44 | 0 |
| `tests/parent-dashboard-isolation.test.js` | 112 | 0 |
| `tests/parent-monthly-report.test.js` | 67 | 0 |
| `tests/mock-exam-phase8.test.js` | 135 | 0 |
| `tests/mock-exam-grading-isolation.test.js` | 22 | 0 |
| `tests/calendar-i18n-phase9.test.js` | 440 | 0 |
| `tests/kodgy-phase10.test.js` | 231 | 0 |
| `tests/security-hardening.test.js` | 239 | 0 |
| `tests/authorization-invariants.test.js` | 93 | 0 |
| `tests/seed-idempotency.test.js` | 18 | 0 |
| `tests/registration-validators.test.js` | 24 | 0 |
| `tests/migration-sql.test.js` | 15 | 0 |
| `tests/platform-upgrade-2026-migration.test.js` | 98 | 0 |
| **Total** | **1,821** | **0** |

**Combined Phase 11 + Phase 12 verdict: NOT SATISFIED.** This is the existing
regression matrix plus prerequisite assertions, not a Phase 12 track test suite.
No real-student/manual browser access matrix was run. No parent cross-track or
ARABIC/LANGUAGE resource-isolation guarantee was tested against live application data.

## Required unblock and next steps

1. Make the Prisma engine download reachable in this environment.
2. Provision the actual local SQLite database (or an approved representative backup)
   and configure `DATABASE_URL` through the workspace environment, not chat.
3. Run generation and migration status, then the repaired reconciler twice.
4. Inspect actual 2/7/23 hierarchy, unique exact codes, active/archived universe,
   and semantic state before/after the second run. Resolve any discrepancies.
5. Only after that succeeds, resume the full Phase 12 discovery, stored-value audit,
   architecture ratification, implementation and track release matrix.

No Phase 13+ work began. No PR may be treated as merge-ready from these results;
any draft for this patch is prerequisite-only and must remain unmerged.
