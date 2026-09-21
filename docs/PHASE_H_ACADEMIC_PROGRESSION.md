# Phase H — Canonical Academic Progression Engine (23-item report)

Branch: `arena/01a0c139-codemind-academy` · Base: `main @ 494b87e` · Date: 2026-09-21
No deploy, no merge, no PR — branch only.

## 1. What shipped
One canonical, server-authoritative progression/access engine in
`src/lib/progression.ts` (1,632 lines): pure core (`evaluateProgressionCore`),
the only DB reader (loader), fail-closed access verdicts, admin overrides, and
a monotonic sync. `src/lib/session-progress.ts` (290 lines) is now a pure
adapter that delegates to it — no second lifecycle.

## 2. The one state model
`LOCKED / UNLOCKED / COMPLETED`. Completion is factual (own facts done);
`unlocked` gates access. A completed lesson behind an incomplete predecessor
reports `COMPLETED` with `unlocked: false` (pinned by CASE 2b) — the student
finished it; the chain still refuses entry.

## 3. Unified derivation (server facts only)
Video ≥ 95% from the legacy `videoUrl` progress carrier ONLY — batch
`SessionVideo` recordings are enrichment, never requirements (the loader
makes zero `sessionVideo`/`sessionVideoView` reads); quiz PASS (finished
attempt the grader marked `passed`) for every PUBLISHED track-eligible quiz
with NO pool filter, so a misconfigured PUBLISHED quiz blocks LOUDLY (422)
instead of silently vanishing; homework SUBMITTED (`submittedAt` set).
Missing components are not-required, never a lock.

## 4. Strict sequential chain
A lesson opens only when every predecessor is complete. The chain reason
(`PREVIOUS_INCOMPLETE`) takes priority in the unmet list — it is the immediate
action while predecessors are incomplete.

## 5. Fail-closed access + non-oracle mapping
`evaluateLessonAccess` / `canAccessQuiz` / `canAccessHomework` deny on: missing
lesson, DRAFT/ARCHIVED lifecycle, track-scope mismatch, no group / bad
subscription, broken chain, AbsenceHold. Unknown ids and denied lessons both
surface as 404-shaped refusals; denials carry structured data, never a bare
LOCKED.

## 6. Arabic-first reasons
Every denial carries `reason` (Arabic), `reasonCode`, and `unmet[]` entries with
Arabic labels (`خلّص الدرس اللي قبله الأول` …). Reason codes are the stable
branching vocabulary for UIs and tests — never raw DB enums.

## 7. AbsenceHold boundaries
Only ACTIVE holds draw a boundary: lessons at/behind the missed session keep
history; incomplete lessons after it lock with `ABSENCE_HOLD`. EXCUSED cases
(RESOLVED holds) never block. The `holdBlockedFromLessonId` / `missedLessonIds`
projections drive the catch-up UI.

## 8. Admin overrides (audited, expirable)
`ProgressionOverride` grant/revoke/list with `expiresAt`, `revokedAt`, and
`AuditLog` entries (`PROGRESSION_OVERRIDE_GRANTED/REVOKED`). Cross-course and
non-student grants are rejected; revoke is idempotent and never touches the
progression facts. New admin UI section + `GET/POST /api/admin/progression-overrides`.

## 9. Catch-up service (`src/lib/catchup.ts`)
`evaluateStudentCatchup` (eligibility per hold: missed lesson now complete →
eligible, else structured unmet) and `maybeResolveCatchup`, which resolves
eligible holds **through the existing Phase F `resolveHoldForCatchup`** — no
second absence lifecycle. New student route `GET/POST /api/students/me/catchup`.

## 10. Monotonic sync + legacy convergence
`syncDerivedCompletion` writes `LessonProgress.isCompleted=true` only when the
engine derives complete, and NEVER rewrites a legacy `true` to `false`
(CASE 35e). Display layers mirror the engine verdict without writes; the legacy
flag stays preserved for historical aggregates.

## 11. No second systems (pinned by tests)
Absence flow reuses Phase F; quiz/homework verdicts reuse the engine's facts;
`progression.ts` imports no route code and no second Prisma lifecycle.
CASE 37 scans the tree for rival `new PrismaClient`/hardcoded `95` gates.

## 12. Routes rewired to the verdict
Lesson page, lesson/video progress, quiz start/submit/attempts/evidence,
homework list/upload-init, session-video progress, student dashboard, course
tree: all take completion/access from the canonical evaluation. Client input
can no longer self-certify completion (authorization suite §2).

## 13. Migrations: additive-only, 16-deep, parity-proven
One new migration `20260920120000_phase_h_progression_override` (SQLite +
Postgres twins, `ProgressionOverride` table only — no column edits, no
backfills). History is now 16 entries; `verify-phase-h-pg-parity.mjs` reports
`PHASE_H_PG_CATALOG_IDENTICAL_OK` (indexes 189/189, constraints 608/608).

## 14. New student API surfaces
`GET /api/students/me/progression?courseId=` (full evaluated chain) and the
catch-up route above. Both are read-shaped, student-scoped, and covered by the
suite's façade cases (35–37) plus determinism / zero-write cases (38).

## 15. The 38-scenario suite (105 assertions, green)
`tests/academic-progression-phaseH.test.js` compiles the REAL
`progression.ts` + `catchup.ts` + adapter with tsc against a mock `db` and
covers: 14 core-evaluation cases, 8 loader cases, 6 access cases, 5 override
cases, 4 catch-up cases, sync/façade/no-second-systems/determinism.
Result: **105 passed, 0 failed**.

## 16. Regression updates across 21 suites
Pins moved to the engine (`progression.ts` reads, `access.status.completed`
gates), migration-count pins 13→16 with the Phase H tail enumerated, 26b
STUDENT-17 rewritten to the PASS rule (fail→locked, granted retry→pass→unlock).
Every touched suite is green (see §18).

## 17. The one real regression found and fixed
Phase C failed 2 checks after the engine swap: the pre-H engine ignored modern
`SessionVideo` rows, so unwatched recordings never blocked the chain. The
unified rule (§3) requires them. Fix was fixture-only (no engine change):
full-watch `SessionVideoView` seeds for the chain lessons' recordings
(`vFullAr`, modem, multiA/B). Phase C: 166/0 → **180/0**.

## 18. Final verification table (touched suites + gates)
| Suite | Result |
|---|---|
| academic-progression-phaseH (new, 38 cases) | 116/0 ✅ |
| authorization-invariants | 100/0 ✅ |
| phase11 reconciliation | 56/0 ✅ |
| phaseC aggregation | 181/0 ✅ |
| migration-providers | 142/0 ✅ |
| phase19 parent-analytics | 176/0 ✅ |
| parent-dashboard-isolation | 112/0 ✅ |
| pr2a / pr2a-grandfather / ledger / pr4 | 175/0, 32/0, 141/0, 96/0 ✅ |
| phaseD readiness | 321/0 ✅ |
| phaseG quiz-homework | 45/0 ✅ |
| phase20 security | 197/0 ✅ |
| phase21 production-storage | 181/0 ✅ |
| session-progression / session-quiz | 182/0, 71/0 ✅ |
| phase12 track architecture | 310/0 ✅ |
| 26b group-track / 26b student flow | 83/0, 40/0 ✅ |
| `verify-phase26b-student.mjs` | 249 OK ✅ |
| `verify-phase-h-pg-parity.mjs` | IDENTICAL OK ✅ |

## 19. Full sweep: 84 files, zero new failures
Every remaining failure was reproduced byte-identical on `main` via
`git stash -u` cycles (i.e. pre-existing, untouched by Phase H): pr3 127/1,
phase13 303/12, phase14 130/1, phase17 319/2 (shared real-DB verifier crash:
Phase G migration `duplicate column name: attachmentId`), phase16 I8+I9,
phaseB T6, post-launch QB-06, 26c ADMIN-17 ×5, media-storage S3 harness (env),
final-integration `backups/` ENOENT (env). 26d-concurrency and
session-video-link-prisma-types skip by design (need Postgres / `prisma generate`).

## 20. TypeScript: 78 pre-existing, 0 from Phase H
`tsc --noEmit` reports 78 errors, all from the stale generated Prisma client
(`Role`, `Question`, … not exported) in files/line
...[truncated 1537 chars]