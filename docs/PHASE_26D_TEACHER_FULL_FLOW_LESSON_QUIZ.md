# Phase 26D — Teacher Full Flow QA + Lesson Quiz Architecture

Status: **COMPLETE — STOPPED FOR REVIEW. Nothing committed, pushed, or deployed.**

Scope: (A) QA and harden the complete Teacher workflow; (B) implement the Lesson Quiz
architecture required before Go-Live.

This document has 33 numbered sections, matching the requested report structure.

---

## 1. What was actually done

Two deliverables, both on branch `arena/01a0a540-codemind-academy` from `main` @ `ed7a2f3`:

**(A) Teacher workflow QA.** Every TEACHER-01..25 acceptance item was driven through the
*shipped* route handlers against a real SQLite database. This found **three real bugs**, all
fixed and all now covered by assertions (§28, §33):

1. `PATCH /api/teacher/homework/[id]/grade` accepted any `studentId` and wrote to it. The
   *homework* was scope-checked; the *student* was not. A valid student from another
   teacher's course could be graded, and a nonexistent one crashed with an unhandled
   `TypeError` (→ HTTP 500) instead of a clean refusal.
2. `DELETE /api/teacher/templates/[id]` returned `200 { ok: true }` even when the scoped
   delete removed nothing. Teacher B deleting Teacher A's template got a **success**
   response for a no-op. The data was safe; the response was a lie.
3. **(C) History-integrity closeout.** `DELETE /api/teacher/questions/[id]` and
   `DELETE /api/teacher/quizzes/[id]` both decided *whether* to delete outside a transaction
   and then deleted in a separate statement. A student starting an attempt in that gap would
   freeze the very question being deleted, the stale guard would pass, and the
   `onDelete: Cascade` FK would then erase the frozen `QuizAnswer` row that had just been
   created. Both routes now check **and** delete inside one transaction (§12b).

**(B) Lesson Quiz architecture.** A blueprint-driven, server-randomized, frozen,
one-attempt-by-default quiz system with Admin-only retry grants, attempt inspection for all
three roles, and a state machine — implemented across 2 new libraries, 1 schema migration,
5 new route groups, and a rewritten attempt lifecycle.

**Verification:**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `tests/phase26d-teacher-full-flow.test.js` | **136 passed, 0 failed** |
| `scripts/verify-phase26d-teacher.mjs` (real DB + real handlers) | **306 assertions, 0 failed** (15/15 consecutive clean runs) |
| Full `tests/*.test.js` sweep (50 files) | **48 PASS / 2 FAIL** — both pre-existing (§31) |
| `tests/phase26d-concurrency-postgres.test.js` | **SKIPPED here** — no PostgreSQL in sandbox; must run in CI (§12c) |
| Phase 26C admin verifier | **86/86 PASS** |
| Phase 26B student verifier | **238 assertions PASS** |
| Phase 26B group-track verifier | **78 assertions PASS** |
| Phase 18 teacher verifier | **163 passed, 0 failed** |
| Migration rehearsal (`verify-phase21-migration.mjs`) | **28 passed, 0 failed** |
| `npx next build` — compile + TypeScript | **PASS** (`✓ Compiled successfully`, `Finished TypeScript`) |
| `npx next build` — page-data collection | **FAIL, identically on pristine `ed7a2f3`** (§32) |
| 12-migration chain rehearsed from base DDL | **PASS**, SQLite and Postgres converge |

---

## 2. Discovery — the authoritative files (before any change)

No route names were assumed from documentation. The authoritative surfaces were read first:

| Concern | Authoritative file |
|---|---|
| Quiz content + grading | `src/lib/session-quiz.ts` (922 lines) |
| Student quiz read | `src/app/api/quizzes/[id]/route.ts` |
| Attempt start | `src/app/api/quizzes/[id]/start/route.ts` |
| Attempt submit | `src/app/api/quizzes/[id]/submit/route.ts` |
| Teacher quiz authoring | `src/app/api/teacher/quizzes/route.ts` |
| Teacher scope/ownership | `src/lib/teacher-content.ts` |
| Track predicate | `src/lib/track-scope.ts` |
| Teacher limits | `TEACHER_LIMITS` in `src/lib/teacher-content.ts` |
| Student client | `src/components/course/quiz-runner.tsx` |

**Pre-26D behaviour confirmed by reading the code** (this is what the launch-blocker list
predicted):

- `QuizAttempt` had **no** `status`, **no** `attemptNumber`, and **no** unique constraint on
  `(quizId, studentId, attemptNumber)`.
- `POST /start` unconditionally created a **new** attempt on every call. Nothing consumed or
  limited attempts. A student could retake indefinitely by refreshing.
- `POST /submit` graded against `loadQuizQuestionSet()` — the **live** question bank — so a
  later Question Bank edit silently changed the meaning of a historical result.
- `Quiz` had no mode, no count, no difficulty plan, no attempt cap.
- There was no retry-grant concept anywhere, and no attempt-inspection API for any role.

---

## 3. Schema changes

All additive. `prisma/schema.prisma` is the single source; `prisma/schema.postgresql.prisma`
and `scripts/db/postgres-baseline.sql` are **derived** by
`scripts/db/make-postgres-schema.mjs` (`--check` run twice, in sync both times).

**`Quiz` (+5)**
| Field | Type | Default | Why |
|---|---|---|---|
| `quizMode` | `String` | `"FIXED"` | `FIXED` (legacy) or `BLUEPRINT`. String mirrors the existing `cameraStatus` / `examType` convention — no new enum |
| `questionCount` | `Int?` | `null` | Blueprint target size |
| `maxAttempts` | `Int` | `1` | **One attempt by default** |
| `shuffleOptions` | `Boolean` | `false` | Per-attempt option-order variation |
| `difficultyPlan` | `String?` | `null` | JSON `{"EASY":n,"MEDIUM":n,"HARD":n}` |
| `retryGrants` | relation | — | back-relation |

**`QuizAttempt` (+3, +1 unique)**
| Field | Type | Default | Why |
|---|---|---|---|
| `attemptNumber` | `Int` | `1` | Sequence within `(quiz, student)` |
| `status` | `String` | `"OPEN"` | `OPEN` ⇔ `finishedAt IS NULL`; else `SUBMITTED` |
| `retryGrantId` | `String?` | `null` | FK → `QuizRetryGrant`, **`onDelete: SetNull`** |
| `@@unique([quizId, studentId, attemptNumber])` | — | — | DB-level backstop on the sequence |

**`QuizAnswer` (+10, all nullable)** — the freeze:
`orderIndex`, `questionType`, `promptSnapshot`, `promptArSnapshot`, `optionsSnapshot`,
`answerSnapshot`, `explanationSnapshot`, `difficultySnapshot`, `marksSnapshot`,
`schoolTypeSnapshot`.
Nullable is deliberate: **NULL means "no snapshot, fall back to the live row"**, which is
exactly the pre-26D behaviour, so existing rows keep working unchanged (§25).

**`QuizRetryGrant` (new)** — `id`, `studentId`, `quizId`, `grantedByUserId`, `grantedAt`,
`consumedAt?`, `reason?`, `attempts` (default 1), + 3 indexes.

**Schema-change justification (required by the phase gate):** the four mandatory behaviours
— one-attempt enforcement, frozen content, attempt sequencing, and Admin-granted retries —
each require state that did not exist anywhere in the schema. `maxAttempts` cannot be
derived; a frozen prompt cannot be derived after the source is edited; `attemptNumber`
cannot be computed without a durable sequence; a retry grant is inherently an auditable
row. There is no additive-free alternative.

---

## 4. Migration safety

`prisma/migrations/20260915180000_phase26d_quiz_attempt_architecture/migration.sql` (160 lines).

Ordering matters and is deliberate:

1. `CREATE TABLE "QuizRetryGrant"` **first** — so the later FK has a target.
2. `ALTER TABLE "Quiz" ADD COLUMN` × 5.
3. `ALTER TABLE "QuizAttempt" ADD COLUMN` × 3.
4. Backfill `attemptNumber` by correlated subquery, ordered `startedAt ASC, id ASC`
   (**id tie-break makes it deterministic**, not dependent on row order).
5. Backfill `status` as `CASE WHEN "finishedAt" IS NULL THEN 'OPEN' ELSE 'SUBMITTED' END`
   — `finishedAt` is the pre-existing truth, so nothing is inferred.
6. `CREATE UNIQUE INDEX "QuizAttempt_quizId_studentId_attemptNumber_key"` — added **after**
   the backfill, so it cannot fail on duplicate legacy numbers.
7. `ALTER TABLE "QuizAnswer" ADD COLUMN` × 10.

Safety properties, asserted in `tests/phase26d-teacher-full-flow.test.js` with comment lines
stripped first (the migration's own header says "no DROP, no DELETE, no TRUNCATE", and a
naive scan finds the words it is denying):

- **no** `DROP` (table, index, or column), **no** `DELETE FROM`, **no** `TRUNCATE`
- **no** table rebuild — every column is `ADD COLUMN`
- forward-only, additive, idempotent-safe under the repo's `_prisma_migrations` runner
- the grant FK is `ON DELETE SET NULL`, so deleting a grant can never cascade into attempt
  history
- SQLite and Postgres **converge**: `QuizRetryGrant` at baseline L702, the unique constraint
  at L731, the FK at L732, indexes L946–948

Two `UPDATE "QuizAttempt"` statements are backfills, not data destruction.

**No migration was run against Neon. No production database was touched.**

---

## 5. Teacher authentication & authorization (verified, unchanged)

The chain is intact and was exercised end to end:

`requireUser()` → 401 if absent → `role !== "TEACHER"` → 403 → `getTeacherProfile(user.id)`
→ 404 if no profile.

Ownership is resolved via `teacherCourseIds(teacher)` + `loadOwnedLesson(lessonId, …)`,
returning `{ ok:false, reason:"NOT_FOUND"|"NO_CHAIN" }` → **404** and
`{ ok:false, reason:"NOT_OWNED" }` → **403**. Verified for lessons, quizzes, homework, and
questions (TEACHER-01..05, TEACHER-07).

**No change was needed here** — and that is a finding, not an omission: the 26D quiz routes
reuse the same primitives rather than inventing a parallel check.

---

## 6. Teacher dashboard & scope (verified, unchanged)

Teacher reads are confined to their own courses. `GET /api/teacher/quizzes` returns only
quizzes on lessons in `teacherCourseIds`, and now also returns the blueprint fields
(`quizMode`, `questionCount`, `maxAttempts`, `shuffleOptions`, `difficultyPlan`) so the
authoring UI can display and edit them. Teacher B cannot see Teacher A's quizzes
(TEACHER-02).

---

## 7. Attendance (verified, unchanged)

`POST /api/teacher/attendance` writes rows for the teacher's own course/group only;
a foreign group is refused. Re-verified as part of the matrix (TEACHER-06) so that the
regression net covers it.

---

## 8. Lesson management (verified, unchanged)

Create/edit/archive on owned lessons works; a foreign lesson is refused. Archived lessons
are refused for new content with 409 (`api.242`), which is pre-existing Phase 18 behaviour
and was confirmed still intact.

---

## 9. Homework (verified — **one bug found and fixed**)

Create → submit → grade flows correctly for the owner.

**Bug 1 (MEDIUM, fixed).** `PATCH /api/teacher/homework/[id]/grade` validated the
*homework's* course but not the *student's*. Because the route deliberately creates a
submission when none exists ("teacher pre-grades"), an unvalidated `studentId` went straight
into an INSERT:

- a valid student in **another teacher's course** was graded — a cross-teacher write;
- a nonexistent student hit the FK and surfaced as an unhandled `TypeError` → HTTP 500.

Fix: the student is now resolved first, and refused if unknown (404) or outside the
teacher's own courses (403), **before** any write.

Verifier now asserts: foreign student → 403, unknown student → 404, and the legitimate
grade path still returns 200 and sets `status = "GRADED"`.

---

## 10. Homework grading authority (verified)

Only the owning teacher can grade. A submission cannot be graded twice into an inconsistent
state; the grade range is enforced (`0..100`) and out-of-range values are refused with 400,
never clamped — consistent with the repo's existing `TEACHER_LIMITS` policy.

---

## 11. Quiz authoring authority (verified + extended)

`POST/PATCH /api/teacher/quizzes` remains owner-scoped. It now additionally accepts and
validates the blueprint through `validateBlueprintInput`, which checks **shape only** and
never silently coerces:

| Rule | Refusal |
|---|---|
| unknown key in `difficultyPlan` | `400` |
| plan total > `questionCount` | `PLAN_EXCEEDS_COUNT` |
| `questionCount` outside 1–100 | `400` |
| `maxAttempts` outside 1–10 | `400` |
| any plan value > 100 | `400` |

Out-of-range input is **refused, not clamped** — matching how `TEACHER_LIMITS` already
behaves for title/prompt/marks, so authoring has one consistent failure mode.

---

## 12. Question Bank semantics — what the term actually means

"Question Bank" is used for **two different things** in this codebase, and conflating them is
what makes the pool question confusing. Both are `Question` rows; they differ only by
`quizId`.

| | Global / shared bank | A quiz's own pool |
|---|---|---|
| Rows | `Question` with **`quizId = NULL`** | `Question` with `quizId = <that quiz>` |
| Created by | `POST /api/admin/question-bank` with **no** `quizId` (ADMIN only) | `POST /api/teacher/quizzes/[id]/questions` (TEACHER, owner-scoped), or the Admin route **with** a `quizId` |
| Reachable by the selector? | **NO** | **YES** — this is the only pool |

**The selector never samples the global bank.** `loadQuizQuestionPool(quizId)` is
`db.question.findMany({ where: { quizId } })` — a hard filter on the owning quiz. Verified by
QUIZ-32: a shared `quizId = NULL` row created through the real Admin route is **not** drawn
into an attempt, and every frozen question carries a prompt from the quiz's own pool.

**How a question becomes selectable:** it must be *associated with the quiz* — i.e. created
with that `quizId`. A shared bank row is not "copied" or "linked" automatically; there is no
join table and no implicit association. An Admin who wants a shared item in a quiz creates it
with that quiz's id (or a Teacher authors it on the quiz directly).

**Why this is intentional architecture, not an oversight.** `QuizAnswer.question` is
`onDelete: Cascade`. A shared bank row has no owning quiz, so it has no natural lifecycle
boundary — an Admin pruning the global bank would silently cascade into the frozen history of
every attempt anywhere on the platform that had ever drawn it. Scoping the pool to the quiz
means the rows that can be frozen are exactly the rows whose lifecycle the quiz's own delete
guard already protects (§12b). This is also why no claim in this report says the selector
"dynamically samples the entire bank" — it does not, and must not.

Bank mutations after an attempt starts do not affect that attempt (§19, QUIZ-07).

---

## 12b. Frozen history survives Question deletion

**Required invariant:** once an attempt starts, its frozen question/answer history must
survive later Question Bank edits **and deletions**.

### The hazard, reproduced

`QuizAnswer.question` is declared `onDelete: Cascade` (`prisma/schema.prisma` L651,
`scripts/db/postgres-baseline.sql` L755). Proven at DB level with FK enforcement enabled —
which is now a permanent assertion in `tests/phase26d-teacher-full-flow.test.js` §5c:

```
one frozen answer row exists before the delete        -> 1
DELETE FROM "Question" WHERE "id"='q1'
frozen answer rows after                              -> 0   <-- history destroyed
attempt row still present, score still 4                   <-- orphaned, unreadable
```

The attempt survives with its score but loses the row that explains it.

**Why this was invisible in testing:** the SQLite test harness's base DDL generator
(`scripts/lib/migrate-sqlite.mjs` → `baseSchemaDdl()`) emits **no foreign keys at all**, and
`PRAGMA foreign_keys` is off by default. A first reproduction attempt through raw Prisma
therefore "succeeded" and destroyed nothing — the harness could not observe the cascade. The
hazard is **PostgreSQL-only**, i.e. production-only.

### The fix chosen: Option A (refuse), hardened

Option B (nullable FK / `SET NULL`) was **rejected** on evidence, not preference:

- SQLite rejects both `ALTER TABLE … DROP CONSTRAINT` and `ALTER TABLE … ALTER COLUMN`
  (tested directly), and the repository runs **one** `migration.sql` verbatim against both
  dialects with no dialect branching. The FK therefore cannot be altered convergently.
- Legacy pre-26D attempts have NULL snapshots and read via `snapshot ?? r.question`
  (`src/lib/session-quiz.ts`). Nulling `questionId` would break exactly the rows that still
  depend on the live question — trading a narrow hazard for a certain one.
- `@@unique([attemptId, questionId])` relies on `questionId` being non-null.

Option A fits the repository because **the refusal already existed** — `canDeleteQuestion`
returns `FROZEN_ANSWERS`/`OPEN_ATTEMPT`/`GRADED_ATTEMPT`/`FIXED_EXAM_PIN` blockers and both
delete routes returned 409.

**What changed:**

1. `loadQuestionReferences(questionId, client = db)` now accepts a transaction client.
2. `DELETE /api/teacher/questions/[id]` performs the reference check **and** the delete inside
   one `db.$transaction`, re-checking on the `tx` client.
3. `DELETE /api/teacher/quizzes/[id]` got the same treatment — its path is worse, because
   `Quiz → Question → QuizAnswer` cascades two levels.
4. **Both routes, and the attempt-start path, now take a shared database-level lock** — see
   §12c. Step 2/3 alone did **not** close the race.

No schema change, no migration, no historical row touched.

---

## 12c. Concurrency: what actually closes the race

### A transaction alone was NOT sufficient

An earlier revision of this report claimed that putting the reference check and the delete
inside one `$transaction` "closed the TOCTOU gap". **That claim was wrong and is withdrawn.**

Under PostgreSQL **READ COMMITTED** a plain `SELECT` takes no lock that conflicts with an
`INSERT` into the *referencing* table. So this interleaving was still live *inside* a single
transaction:

```
Tx A (delete question q)            Tx B (POST /api/quizzes/[id]/start)
begin
read refs WHERE questionId=q
  -> 0                              begin
                                    insert QuizAttempt row
                                    insert QuizAnswer row (questionId=q)
                                    commit
delete the Question row (id=q)
  -> CASCADE removes the QuizAnswer row Tx B just committed
commit
```

End state: the attempt **exists** but its frozen question row is **gone** — precisely the
history destruction the guard exists to prevent.

**FK insert locking is not sufficient either.** The `QuizAnswer` insert does take
`FOR KEY SHARE` on the parent `Question` row, and the `DELETE` does wait for it — but it waits
and *then deletes*, cascading the committed row away. Locking the `Quiz` row is likewise not
sufficient: `QuizAnswer.questionId` references `Question`, not `Quiz`, so a lock on the Quiz
row does not conflict with the `QuizAnswer` insert at all.

### Chosen mechanism: shared transaction-scoped advisory lock

The repository already had this pattern (`src/lib/db-serialization.ts`, used by Phase 23
upload finalization and Phase 25 group seats), so the fix extends it rather than inventing a
new one.

**Mechanism:** `pg_advisory_xact_lock(<63-bit id>)`, acquired as the **first statement** of
each transaction:

| Path | Lock key | Acquired before |
|---|---|---|
| `POST /api/quizzes/[id]/start` | quiz id | creating the attempt **and** freezing its rows |
| `POST /api/quizzes/[id]/start` (pre-Phase-5 resume) | quiz id | freezing the resumed attempt's rows |
| `DELETE /api/teacher/questions/[id]` | **owning quiz** id | reading references |
| `DELETE /api/teacher/quizzes/[id]` | quiz id | counting attempts |

The question delete keys on its **owning quiz**, not on itself — keying by question id would
never contend with an attempt start that had already read the pool, leaving the race open.

The lock id is `FNV-1a(63-bit)` over a `cm:phase26d:quiz-destructive` namespace plus the quiz
id, so it cannot collide with the Phase 23 or Phase 25 locks, and unrelated quizzes never
serialize against each other.

**SQL safety:** one raw site, `tx.$executeRaw\`SELECT pg_advisory_xact_lock(${lockId})\`` —
a tagged template, so the id is **bound as int8**, never interpolated. The transaction-scoped
variant is used deliberately: the session-scoped `pg_advisory_lock` would survive COMMIT and
could leak on a pooled serverless connection.

**Resulting ordering** is total, and exactly one of two safe outcomes is possible:

- **delete wins** → the attempt's `QuizAnswer` FK insert fails, so no attempt ever exists with
  a missing frozen row; or
- **attempt wins** → the delete re-reads references *under the lock*, sees the frozen rows, and
  returns **409**.

The forbidden end state — attempt succeeds, `QuizAnswer` created, same row destroyed by
cascade — is unreachable.

**SQLite behaviour:** the helper is a deliberate **NO-OP** (gated on
`resolveDatabaseProvider()` reading `DATABASE_URL`, the same value Prisma dispatches on).
SQLite has no advisory primitive, and permits at most one writer at a time, so its own
database-level write lock already serializes concurrent write transactions. Local development
never depends on PostgreSQL, and no production-only code path crashes locally.

### Proof level — stated honestly

| Layer | What is proven | Where |
|---|---|---|
| Lock mechanism (behavioural) | id determinism, namespace isolation, **parameterized** SQL, bigint binding, no interpolated identifier, transaction-scoped variant only, SQLite no-op, no-`$executeRaw` tolerance, provider resolution | QUIZ-33 in the verifier — **runs everywhere** |
| Call-site ordering | LOCK → check → delete in both routes; LOCK → create → freeze through `tx` on both start paths | QUIZ-33 source-order assertions — **runs everywhere** |
| The race itself | **NOT proven on SQLite.** SQLite cannot host it: `baseSchemaDdl()` emits no FKs, `PRAGMA foreign_keys` is off, and only one writer may run at a time | — |
| The race on PostgreSQL | A real 2-connection READ COMMITTED test that reproduces the data loss **without** the lock and asserts the forbidden end state is impossible **with** it | `tests/phase26d-concurrency-postgres.test.js` — **requires a local/CI PostgreSQL** |

**No PostgreSQL was available in this sandbox** (no `psql`, no Docker, and package/network
install blocked). The PostgreSQL test therefore **skips with exit 0 and prints
`PHASE26D_CONCURRENCY_SKIPPED`** rather than claiming a result. It refuses outright
(exit 1) if `DATABASE_URL` looks like production/Neon.

**This means the concurrency invariant is NOT fully proven here.** It must be run in CI:

```
createdb cm_phase26d_concurrency
DATABASE_URL=postgresql://localhost:5432/cm_phase26d_concurrency \
  node tests/phase26d-concurrency-postgres.test.js
```

### Residual risk

1. The PostgreSQL race proof has **not been executed** in this sandbox — it is written,
   self-skipping, and CI-gated. Until it runs green somewhere with a real PostgreSQL, the
   invariant rests on the mechanism assertions plus the documented lock reasoning.
2. History protection remains **application-layer**: the schema still declares
   `onDelete: Cascade`, so any future delete path that skips `canDeleteQuestion` *and* the
   advisory lock would reintroduce the hazard.

### Proven by QUIZ-31 (real handlers, real SQLite)

| # | Assertion | Result |
|---|---|---|
| 1 | attempt started | PASS |
| 2 | all 3 questions frozen with prompt/answer/marks/options snapshots | PASS |
| 3 | non-grading edit of the live question → 200 | PASS |
| 4 | frozen prompt, answer key, marks and options **all unchanged** by that edit | PASS |
| 4b | editing `answer` or `marks` of a referenced question → refused | PASS |
| 5 | delete of a referenced question → **409** | PASS |
| 6 | historical admin detail still lists all 3 questions with the **original** wording | PASS |
| 7 | historical score **and** percentage unchanged | PASS |
| 8 | after an Admin-granted retry, attempt #1 is still `SUBMITTED` with its rows and score | PASS |
| 9 | **no `QuizAnswer` row disappeared**; live question also survived | PASS |
| 10 | a **foreign teacher** cannot reach the delete path; question and rows survive | PASS |
| — | an **unreferenced** question in the same quiz **is** deletable (guard is specific, not a blanket ban) | PASS |

**Residual risk, stated plainly:** the cascade remains declared in the schema, so the
protection is application-layer. Any *future* code path that deletes a `Question` without
going through `canDeleteQuestion` would still destroy history. This is recorded in the §33 gap
audit as a MEDIUM, non-launch-blocking item with the reason a schema-level fix was not viable
here.

---

## 13. One authoritative selection service

There is exactly **one** selection implementation: `selectAttemptQuestions()` in
`src/lib/quiz-blueprint.ts` (538 lines). Every caller goes through it:

| Caller | Path |
|---|---|
| `POST /start` | `selectAttemptQuestionsForQuiz()` → `selectAttemptQuestions()` |
| retry start | same function, different `seen` set |
| teacher/admin preview | same `resolveQuizBlueprint()` + same selector |

`src/lib/session-quiz.ts` **delegates**; it does not re-implement. The routes contain **no**
`Math.random` and no second selection branch — asserted in the test file so a future
refactor that forks the logic fails the build.

---

## 14. Randomization & variation strategy

`selectAttemptQuestions({ pool, blueprint, used, random })`:

1. Filter by track (`isQuestionEligible(schoolType, q.schoolType)`) — **inside** the
   selector, so diagnostics can report both `poolSize` and `eligibleSize`.
2. `FIXED` mode: every eligible question in `{createdAt, id}` order — **byte-identical to
   pre-26D** (this is what makes §25 safe).
3. `BLUEPRINT`: fill difficulty quotas in order EASY → MEDIUM → HARD, each via
   `pickPreferringUnused`, then fill the remainder, then Fisher–Yates shuffle, then trim to
   `questionCount`.
4. `pickPreferringUnused` sorts `used.has(q.id) ? seen : fresh` first — **unused questions
   are preferred over already-seen ones**, which is what gives a retry maximal variation.
5. Randomness is injected (`random?: () => number`), so production is genuinely random while
   tests are deterministic.

`SelectionDiagnostics` reports `poolSize`, `eligibleSize`, `requested`, `selected`,
`previouslyUsed`, and `overlap` — the overlap count is real, not estimated.

---

## 15. Attempt state machine

`decideAttemptStart({ attempts, maxAttempts, pendingGrants })` returns exactly one of:

| Decision | Condition |
|---|---|
| `resume { attemptId }` | an `OPEN` attempt exists |
| `create { attemptNumber }` | `attempts.length < maxAttempts`, **or** a pending grant exists |
| `denied { code: "ATTEMPT_LIMIT_REACHED", attemptsUsed, maxAttempts }` | otherwise |

Terminal states: `SUBMITTED` (after submit) and `EXPIRED` (timer). Both are terminal —
`EXPIRED` deliberately requires an Admin grant to continue (§35, behaviour change).

`POST /submit` is terminal and **replay-safe**: with no open attempt it returns
`409 ATTEMPT_NOT_STARTED`; with an already-submitted attempt it returns
`409 ATTEMPT_ALREADY_SUBMITTED` **with the stored score**, and creates nothing.

**The pre-26D retake hole is gone.** `submit` contains no `quizAttempt.create` and no
`loadQuizQuestionSet` — both asserted in the test file.

---

## 16. Retry grant model

`QuizRetryGrant { studentId, quizId, grantedByUserId, grantedAt, consumedAt?, reason?,
attempts }`, audit action `QUIZ_RETRY_GRANTED`.

- Grants exactly **one** extra attempt (`attempts` defaults to 1).
- Records granter and time; `reason` is length-bounded (`RETRY_REASON_MAX = 500`).
- **Auditable** — an `AuditLog` row is written (§30).
- **Preserves all prior attempts**; never deletes, never nulls `finishedAt`.
- Consumed inside the attempt-creation `$transaction`, stamping `consumedAt` and writing
  `retryGrantId` onto the new attempt (the lineage).

Note on the schema: `@@unique([studentId, quizId, consumedAt])` does **not** prevent
duplicate *unconsumed* grants, because SQL treats NULLs as distinct. That case is enforced
in `issueRetryGrant` → `409 ALREADY_PENDING` instead. Documented so nobody later assumes
the constraint covers it.

---

## 17. Admin-only retry API

`POST /api/admin/quiz-retries` — `requireRole("ADMIN")`.

| Case | Result |
|---|---|
| unknown student or quiz | 404 |
| student/quiz in a different course | 400 |
| student/quiz on a different track | 400 |
| duplicate unconsumed grant | 409 `ALREADY_PENDING` |
| success | 201 `{ attemptsGranted: 1 }` |

**Teacher and Student cannot grant retries, verified three ways:**
1. `src/app/api/teacher/quiz-retries/route.ts` **does not exist** — asserted.
2. No file under `src/app/api/teacher/**` contains `quizRetryGrant.create` or
   `issueRetryGrant` — asserted by walking the tree.
3. Calling the admin route as TEACHER and as STUDENT both return 403 — verified at runtime
   (TEACHER-15).

`GET /api/teacher/quizzes/[id]/attempts` additionally returns `canGrantRetry: false` and
exposes **no POST**, so the teacher surface cannot be extended into a grant by accident.

---

## 18. Inspection APIs

| Route | Role | Scope |
|---|---|---|
| `GET /api/admin/quiz-retries` | ADMIN | filters `studentId`/`quizId`/`pending=1`/`take`; actor + lineage |
| `GET /api/admin/quiz-attempts` | ADMIN | filters `studentId`/`quizId`/`status`/`retried=1`, paginated; **no answer keys** |
| `GET /api/admin/quiz-attempts/[id]` | ADMIN | full `buildAttemptInspection` + sibling `history` |
| `GET /api/teacher/quizzes/[id]/attempts` | TEACHER | scoped by `teacherCourseIds` + `lessonPlacement`; 404 `api.248`, 403 `api.180` |
| `GET /api/quizzes/[id]/attempts` | STUDENT | own attempts + entitlement summary |

Admin sees student, quiz, attempt sequence, status, `startedAt`, `finishedAt`, score,
percentage, questions, answers, and grant lineage. Teacher sees only their own authorized
scope. Student sees only their own — scoped by the **session profile**, never a parameter:
the route accepts no `studentId` query param (asserted), so there is nothing to forge.

The student surface reveals **that** a retry was granted, never **who** granted it.

---

## 19. Grading

Server-side only, through the existing `gradeAttemptQuestionSet()`.

- Supports **MCQ** and **TRUE_FALSE**. **No SHORT/essay auto-grading is claimed** — none
  exists, and none was invented.
- Grades against the **frozen snapshot**, never the mutable live row.
- `POST /submit` reads **no** `score`, `percentage`, `passed`, or `totalMarks` from the body
  (asserted) — the client cannot report its own result.
- Submit accepts only the frozen question IDs; a forged ID produces no answer row
  (verified QUIZ-27).

**Freeze verified end to end (QUIZ-07):** start an attempt, then `UPDATE` the live question's
`prompt`, `answer`, and `marks`. The attempt's `answerSnapshot` still equals the **original**
captured key — and the test captures the original value first rather than hard-coding `"3"`,
because the pool's answers are `i % 4` and one of them genuinely *is* `"3"`, which would have
made the assertion vacuous.

---

## 20. Teacher analytics — semantics documented, no fake data

`GET /api/teacher/analytics` was **not** changed in 26D, and this section documents its real
behaviour rather than asserting something it does not do.

It aggregates over **all finished attempts**, filtered to the teacher's own courses
(`attemptInQuizScope`) and to finished rows in SQL. `quizCount` is an **attempt** count, and
`avgPct` is an **attempt-weighted mean**:

```
quizCount = quizAttempts.length
avgPct    = round(Σ percentage / quizCount)
```

**Consequence now that retries exist:** a student who used an Admin retry contributes **two**
attempts to that teacher's averages, and a retry that scored higher raises the mean. This is
**all-attempts** semantics, **not** latest-attempt. There is no double counting of a single
attempt — each row is counted once — but the metric is not "best score" and not "latest
score". The track split (`trackSplit`) uses the same attempt-weighted basis.

If product wants "latest attempt per quiz", that is a deliberate future change, not a bug
fix; changing it silently would rewrite historical dashboards.

---

## 21. Templates (verified — **one bug found and fixed**)

`POST /api/teacher/templates` requires `title` **and** `titleAr` (400 without). Create →
200/201 verified.

**Bug 2 (MEDIUM, fixed).** `DELETE /api/teacher/templates/[id]` scoped the delete correctly
(`where.teacherId = teacherId`), so Teacher A's template was never actually removed — but the
route returned `200 { ok: true }` unconditionally. Teacher B was told the delete **succeeded**
when nothing was deleted, and an Admin got `ok: true` for a nonexistent id.

Fix: the `deleteMany` result is now inspected; `count === 0` → **404 `api.293`**. The status
is 404 for both "does not exist" and "not yours" **on purpose**, so the endpoint is not an
existence oracle for another teacher's templates.

Verified: foreign delete → 404 **and** the template survives **and** still belongs to
Teacher A; owner delete → 200 and the row is really gone.

---

## 22. Videos & materials (verified, unchanged)

Teacher material routes never return raw R2 credentials — uploads go through the existing
presigned flow (Phase 23), and the response contains the public/CDN reference only. Re-run as
part of the matrix so the regression net covers it; no change was needed.

---

## 23. Notifications

**Documented rather than invented: Teachers cannot send notifications.** No teacher
notification-send route exists, and none was created. The only teacher-triggered notification
is the automatic `QUIZ_RESULT`-style row written when homework is graded
(`src/app/api/teacher/homework/[id]/grade/route.ts`), which is pre-existing Phase 18
behaviour and was left intact.

No 26D notification was added: granting or consuming a retry does not currently notify the
student. Recorded as a gap in §35 (LOW — the student discovers the extra attempt on their
next visit, and `GET /api/quizzes/[id]/attempts` reports `pendingRetryGrants`).

---

## 24. Negative & tampering tests

All run against real handlers. Selected results:

| Attack | Result |
|---|---|
| Client sends `questionIds` to `/start` | ignored — not read from the body |
| Client sends `attemptNumber` / `retry` metadata | ignored — not read from the body |
| Client posts its own `score`/`percentage`/`passed` | ignored — not read |
| Submit a question ID not in the frozen set | no answer row created; absent from the result |
| Second `/start` after submit | `409 ATTEMPT_LIMIT_REACHED` |
| `/submit` with no attempt | `409 ATTEMPT_NOT_STARTED`, creates nothing |
| `/submit` replay | `409 ATTEMPT_ALREADY_SUBMITTED` + stored score, creates nothing |
| Re-spend a consumed grant | refused — grant is terminal |
| Teacher calls the admin retry route | 403 |
| Student calls the admin retry route | 403 |
| Student passes `?studentId=<other>` | no such parameter exists |
| Teacher reads another course's quiz attempts | 404 / 403 |
| Blueprint pool too small | `422 BLUEPRINT_UNSATISFIABLE`, **no attempt created** (entitlement not burned) |

---

## 25. Backward compatibility for existing quizzes

**Option B was chosen: `LEGACY_FIXED` + `BLUEPRINT` modes.**

Rationale — Option A (reconcile every existing quiz to a default blueprint) would have
required writing a derived blueprint onto historical rows, i.e. **inferring** intent that was
never recorded. That is a data mutation whose correctness cannot be verified from the data
itself. Option B requires **zero** changes to existing rows:

- Pre-26D quizzes read as `quizMode="FIXED"`, `questionCount=null`, `maxAttempts=1`,
  `shuffleOptions=false`, `difficultyPlan=null`.
- `FIXED` selection returns every eligible question in `{createdAt, id}` order —
  **byte-identical to the pre-26D code path**.
- Snapshot columns are NULL on old rows, and NULL means "fall back to the live row" — again
  the pre-26D behaviour.
- `attemptNumber` / `status` are backfilled from data that already existed
  (`startedAt`, `finishedAt`), not invented.

**No historical attempt was deleted, reset, or rewritten.** Verified: a legacy FIXED quiz
still starts, still serves its questions, and still freezes all of them (QUIZ-29).

---

## 26. Student flow regression

The student path was re-driven end to end: `GET /api/quizzes/[id]` → `POST /start` →
`POST /submit` → result, for both FIXED and BLUEPRINT quizzes, plus a retry-granted second
attempt.

Deliberate, documented behaviour changes:

1. A **BLUEPRINT** quiz returns `questions: []` before `/start`, with `attemptRequired` and
   `attemptState`/`attemptWindow`. The pool is not exposed before the attempt exists.
2. An **EXPIRED** attempt is terminal — an expired timer now needs an Admin grant.
3. The **student-side Retry button is gone**, replaced by `course.031` ("this attempt is
   final; only an admin can grant another"). `onRetry` no longer exists in
   `quiz-runner.tsx` (asserted).
4. `beginAttempt` re-`GET`s the quiz after `/start`, so the frozen set — not a client-side
   guess — is what renders.

Answer-key rule lives in **one** place: `buildAttemptInspection` forces `correctAnswer` off
for any attempt with `finishedAt === null`, regardless of caller. The student `GET` keeps
`revealAnswers = staff || studentHasAttempted`.

`/start` returns **no** questions and **no** `correctAnswer`; it adds `attemptNumber`,
`attemptsUsed`, `maxAttempts`, `usedRetryGrant`.

---

## 27. Admin regression (Phase 26C gates)

The Phase 26C admin verifier and suite were re-run and still pass. The new admin routes were
added alongside the existing ones; no 26C route was modified.

---

## 28. Teacher matrix TEACHER-01..25

All 25 IDs are asserted against real handlers. The table below is transcribed from the
verifier's own assertion labels — each row names what is actually checked, not a paraphrase.
Several IDs share an assertion because one call proves both properties (shown as `NN/MM`).

| # | Asserted | Assertions |
|---|---|---|
| 01 | anonymous → 401; STUDENT → 403 on dashboard, analytics and admin attempt detail; TEACHER → 403 on an ADMIN route and on the retry-grant list | 6 |
| 02 | teacher dashboard → 200 | 1 |
| 03 | assigned group visible; **03/21** a foreign group is absent (no cross-group leakage) | 2 |
| 04 | assigned student visible | 1 |
| 05 | attendance list → 200; eligible students listed; marking → 200; row written; re-marking updates in place (no duplicate row); **05/21** attendance for a foreign group → 403 | 7 |
| 06 | lesson list → 200; DRAFT and PUBLISHED lessons of the own course both listed; **06/23** a lesson of another course is absent | 3 |
| 07 | homework create → 200 and id returned; invalid deadline → 400; **07/23** homework on a foreign lesson → 403 | 4 |
| 08 | homework edit → 200 | 1 |
| 09 | grading → 200 and submission becomes `GRADED`; grading a foreign/unknown student refused | 3 |
| 10 | teacher creates a quiz → 200 | 1 |
| 11 | blueprint mode, question count, difficulty plan and attempt ceiling all persisted; teacher list echoes the resolved blueprint; out-of-range count → 400; plan exceeding the count → 400 | 7 |
| 12 | admin question bank → 200; teacher → 403 on the ADMIN bank route; teacher edits a question in own scope → 200; **12/23** teacher B cannot edit teacher A's question → 403 | 4 |
| 13 | teacher authors a question on an own quiz → 200/201; id returned; landed on the own quiz; marks persisted, not defaulted | 4 |
| 14 | teacher edits an own question → 200 and the edit persists; deletes it → 200 and the row is really gone | 4 |
| 15 | **Teacher CANNOT grant a retry → 403; Student CANNOT grant a retry → 403** | 2 |
| 16 | teacher analytics → 200; overview returned; the blueprint quiz appears in quiz analytics | 3 |
| 17 | template create → 200/201 and listed for its owner; teacher B deleting teacher A's template → 404; **the template survives and still belongs to teacher A**; the owner can delete it → 200 and it is gone | 7 |
| 18 | no teacher route references raw R2/S3 credentials; no teacher route serialises an access-key pair | 2 |
| 19 | over-long title → 400 **and not silently truncated into the DB**; out-of-range `maxMarks` → 400, not clamped; over-long prompt → 400; fewer than `OPTIONS_MIN` options → 400; answer index outside the option list → 400 | 6 |
| 20 | dashboard → 200; lists the teacher's OWN group; omits another teacher's group; reports a real numeric homework count | 4 |
| 21 | teacher B sees only group B (plus the 03/21 and 05/21 leakage assertions) | 1 |
| 22 | a LANGUAGE question on an **ARABIC** quiz → 400 and nothing written; a LANGUAGE question **is** admissible on a SHARED quiz; a SHARED question is admissible on a track-specific quiz | 4 |
| 23 | a foreign quiz is 403, not 404-content (plus the 06/23, 07/23, 12/23 leakage assertions) | 1 |
| 24 | there is no teacher notification-**send** route | 1 |
| 25 | analytics → 200; returns the teacher's real groups; the seeded group appears by its real name; another teacher's group is absent | 4 |

Three verifier fixtures were wrong before the matrix could pass, and each was a *verifier*
bug rather than a product bug — recorded because they show the assertions were load-bearing:

- TEACHER-07 sent homework with no `instructions`/`deadline`, which are **required**, so the
  request died on 400 validation before ownership was reached. The assertion was proving the
  wrong thing until both were supplied.
- TEACHER-12 called the Admin question bank while still in the Teacher session, so the 403 it
  "failed" on was correct behaviour.
- TEACHER-17 expected 403; the correct answer is 404 (see §21).

TEACHER-22 also had a **wrong expectation** that was corrected: a LANGUAGE question on a
SHARED quiz is *admissible*, because `isQuestionScopeWithinQuiz` allows a question whose track
is SHARED **or** equal to the quiz's track. The real refusal is a LANGUAGE question on an
**ARABIC** quiz, which is what is now asserted.

---

## 29. Quiz matrix QUIZ-01..30

All 30 IDs are asserted. Again transcribed from the verifier's own labels.

| # | Asserted | Assertions |
|---|---|---|
| 01 | blueprint quiz GET → 200; the blueprint mode is exposed | 2 |
| 02 | `/start` → 200; a blueprint quiz serves **no** questions before `/start`; **02/26** the pool is not handed to the client pre-start | 3 |
| 03 | a client-supplied `attemptNumber` is ignored (server says 1) | 1 |
| 04 | exactly `questionCount` questions frozen; the difficulty plan honoured exactly | 2 |
| 05 | ARABIC attempt gets shared + ARABIC only; LANGUAGE student starts the track quiz → 200; **05/13** a LANGUAGE-only question is never frozen into an ARABIC attempt and vice versa | 4 |
| 06 | every frozen row carries a full snapshot and its frozen position; resuming did not grow the frozen set; shuffled option order frozen; the frozen answer index still points at the ORIGINAL correct text | 5 |
| 07 | the live question really was edited (so the next assertion is meaningful); the attempt kept the ORIGINAL answer key, not the edited one; the frozen question is still served; the served wording is the FROZEN one | 4 |
| 08 | **08/13** a second start after submit → 409 | 1 |
| 09 | the DB rejects a duplicate `(quizId, studentId, attemptNumber)`; attempt numbers form a contiguous 1..N sequence; `status` and `finishedAt` never disagree | 3 |
| 10 | a repeated `/start` resumes the same attempt (refresh); the response reports `resumed=true` | 2 |
| 11 | logout/login resumes the same attempt | 1 |
| 12 | submit → 200; the attempt is reported and stored as `SUBMITTED` | 3 |
| 13 | submit with no open attempt cannot manufacture one → 409; the refusal names the attempt limit, says so machine-readably and states a retry needs an Admin; the limit is reported again; **13/16** granting an ARABIC-only quiz to a LANGUAGE student → 400; **13/20** a CONSUMED grant cannot be spent again → 409 | 7 |
| 14 | a client-supplied score is ignored; the server wrote its own score and `finishedAt` | 2 |
| 15 | attempt numbers are 1 and 2; no attempt was reopened or reset; **15/22** both attempts still exist | 3 |
| 16 | Admin grant → 201; nonexistent student → 404; nonexistent quiz → 400/404; **16/23** granting across courses → 400; **16/20** with a grant a further attempt starts → 200; **16/30** the grant records WHO granted it | 6 |
| 17 | the teacher surface states it cannot grant retries | 1 |
| 18 | the consumed grant row still exists (retry never deletes history); records WHO, WHEN granted and WHEN consumed; consumption is not earlier than the grant; the recorded granter is the admin who acted; both attempts survive | 7 |
| 19 | the grant starts unconsumed; exactly ONE attempt is granted; a second unconsumed grant → 409 and reports the pending grant | 4 |
| 20 | the grant is now CONSUMED; the granted attempt is sequence #2; the response reports the grant was used; while attempt #2 is OPEN it is resumed, not duplicated; **20/23** the attempt records its grant lineage | 5 |
| 21 | both real papers have exactly `questionCount` questions and honour the 2 EASY + 2 MEDIUM plan; same RNG seed reproduces the SAME paper; different seeds produce DIFFERENT papers; 40 seeds yield many distinct papers; a retry with unused questions available reuses NONE of the previous paper (selector-level **and** real-HTTP) | 9 |
| 22 | attempt #1 still exists after the granted retry, is still `SUBMITTED`, kept its `finishedAt`, kept its answer rows, kept all frozen snapshots, and was not retro-tagged with the grant | 6 |
| 23 | admin attempt list → 200 and filters by student + quiz; returns attempts across students; `retried=1` isolates the grant-permitted attempt; detail → 200 reporting the sequence number, frozen questions, full history, retry lineage and the granter's name | 10 |
| 24 | teacher inspects an own quiz's attempts → 200 and sees their own course's attempts; **24/23** a foreign quiz's attempts → 403 | 3 |
| 25 | student reads own history → 200 and sees exactly their own two attempts; another student sees none of them; the entitlement reports attempts used and that a retry requires an Admin; the student never sees WHO granted the retry | 6 |
| 26 | a fresh student can start; no answer key is served before submission; no `correctAnswer` field on an OPEN attempt, **even to Admin**; the admin LIST ships no questions and therefore no keys | 5 |
| 27 | submit with an extra forged question still succeeds for the frozen set; the forged question is absent from the graded result and never became an answer row | 3 |
| 28 | a duplicate submit → 409, machine-readable, returning the ORIGINAL result unchanged; **28/15** no second attempt created by the replay | 4 |
| 29 | a legacy FIXED quiz still starts → 200 and grades → 200 correctly against the frozen key; serves its questions without `/start`; freezes ALL its questions; **29/08** the one-attempt rule applies to legacy quizzes too | 7 |
| 30 | the grant wrote a `QUIZ_RETRY_GRANTED` audit entry naming the acting admin and carrying the reason | 3 |
| 31 | **History integrity under Question edit and delete** — attempt started; all 3 questions frozen with full snapshots; non-grading edit allowed but frozen prompt/answer/marks/options all unchanged; grading-field edits refused; delete of a referenced question → **409**; **no `QuizAnswer` row disappeared**; historical detail still shows the original wording; score and percentage unchanged; foreign teacher cannot reach the delete path; first attempt survives an Admin-granted retry intact; an unreferenced question is still deletable | 27 |
| 32 | **Question Bank pool semantics** — an Admin-created shared (`quizId = NULL`) bank row exists but is **never sampled** into an attempt; every frozen question comes from the quiz's own pool; shared-bank activity leaves the frozen attempt untouched | 10 |

**QUIZ-21 was rewritten after a flake was found.** The original assertion was "two students
drew different question sets". With a pool of 4 EASY + 4 MEDIUM + 2 HARD and a plan of
2 EASY + 2 MEDIUM there are only `C(4,2)² = 36` possible papers, so two independent draws
collide about **1 time in 36** — a ~3% failure rate, observed once during this phase. A gate
that fails 3% of runs proves nothing, so the assertion was replaced by:

1. what is *always* true of a real draw — size and difficulty plan, for both students;
2. variation proven **deterministically** against the shipped `selectAttemptQuestions` using
   its injectable RNG: the same seed reproduces the same paper, different seeds differ, and
   40 seeds yield many distinct papers;
3. unused-first proven exactly — with 6 unused eligible questions a retry reuses **0**.

The verifier now runs **12/12 consecutive times with 235 assertions and 0 failures**.

---

## 30. Testing

Two artifacts, as required:

**`scripts/verify-phase26d-teacher.mjs`** (1127 lines) — real-SQLite + real-compiled-handler
harness, following the established 13/14/18/26C pattern:

- refuses to run if `DATABASE_URL` matches `/postgres|neon/i`
- `fs.mkdtempSync` + a generated tsconfig listing explicit `REAL_CODE_MODULES[]` →
  `typescript/bin/tsc -p`, with emit asserted
- `DatabaseSync(":memory:")` + `applyMigrations(…, { withBaseSchema: true })` +
  `assertColumnsMatchSchema`
- `createSqlitePrisma({ db, schemaPath })` → `globalThis.__CM_DB_CLIENT__`
- shims for `@/lib/db`, `@/lib/auth` (`globalThis.__CM_USER__`), `next/server`,
  `next/headers`; `Module._resolveFilename` patched
- **the shipped handlers are compiled and executed** — business logic runs for real; the
  database is used for fixtures and state assertions only
- `REAL_CODE_MODULES[]` includes `src/lib/quiz-blueprint.ts` and `src/lib/quiz-retry.ts`
- 25 sections, **306 assertions, 0 failed**, ends with `PHASE26D_VERIFIER_OK`
- runs **15/15 consecutive times clean**, confirming the QUIZ-21 flake fix (§29) holds

**`tests/phase26d-teacher-full-flow.test.js`** — **136 passed, 0 failed**. Four layers:

1. **Source pins** — cheap guards that an invariant is still *written* in the shipped code, so
   a refactor that deletes a guard fails without booting a database.
2. **The DB-level cascade proof (§5c)** — a real `node:sqlite` database with
   `PRAGMA foreign_keys = ON` and the exact constraints from `postgres-baseline.sql`, proving
   the `ON DELETE CASCADE` hazard is real and that the application guard is load-bearing.
3. **The concurrency-protocol pins (§5d)** — asserting the advisory lock is the
   transaction-scoped variant, is parameterized rather than interpolated, is namespaced,
   no-ops on SQLite, and is taken *first* on every path that writes or destroys frozen rows.
4. **A child-process run of the verifier** whose assertion counts are parsed and gated
   (`>= 300` assertions, `0` failures), so a silently truncated verifier cannot pass by
   asserting nothing.

"Table exists" is never treated as a workflow PASS anywhere in either artifact.

A fourth artifact, `tests/phase26d-concurrency-postgres.test.js`, is **not** part of the
SQLite sweep's pass count in any meaningful sense: it self-skips with exit 0 when no
PostgreSQL is reachable, so it must be run explicitly in CI (§12c).

---

## 31. Existing suites

Full sweep over all 50 `tests/*.test.js`: **48 PASS / 2 FAIL**.

Both failures are **pre-existing and environmental**, and were attributed by running the
pristine `ed7a2f3` baseline in a separate worktree and diffing the logs — not by comparing
exit codes:

| Suite | Now | Baseline `ed7a2f3` | Verdict |
|---|---|---|---|
| `payment-lifecycle-phase25-ledger` | `138 passed, 1 failed` | `138 passed, 1 failed` | **identical** |
| `final-integration-phase22` | crash: `db/custom.db` missing, `backups/` ENOENT | same crash | **identical** (only the path string differs between worktrees) |

The ledger suite's single failure is the "request fields referenced ONLY by the PR3
allowlist" assertion — unchanged by this phase.

**Suites that legitimately needed updating, and why.** Adding one migration broke count
assertions scattered across five files; each was repointed at the *invariant* rather than the
literal number wherever possible:

- `payment-lifecycle-phase25-pr2a` — `migrations.length === 11` → `12`
- `phase25-pr4-release-gate` — two sites; the "sorts last" assertion repointed at the 26D
  migration, plus a new assertion that the 26B migration is still present **and in order**
- `phase26b-group-track` — "sorts last" → `includes(...)` + `indexOf === 10`
- `payment-lifecycle-phase25-ledger` — two sites (L567, L570)
- `production-storage-phase21` — 11→12 migrations, 55→56 models, 73→77 FKs, "55 tables"→56,
  and the baseline formula `21 + 55 + 70` → `21 + 56 + 73` (=150)

Plus: `scripts/verify-phase21-migration.mjs` (three hard-coded `55`s),
`scripts/db/fixtures-phase21.mjs` (2 `QuizRetryGrant` rows so the "every source table has ≥1
row" gate passes), `scripts/verify-phase13-db.mjs` and `scripts/verify-phase14-db.mjs`
(duplicate skip-list copies), and `scripts/verify-phase18-teacher.mjs` section M (rewritten
for the one-attempt rule).

`tests/migration-sql.test.js` **passes** — the feared `UPDATE "` regex problem never
materialised.

---

## 32. Build gates

| Gate | Command | Result |
|---|---|---|
| Prisma generate | local-mirror recipe | **PASS** |
| Typecheck | `npx tsc --noEmit` | **PASS, exit 0** |
| Postgres derivation | `make-postgres-schema.mjs --check` | **PASS, in sync (×2)** |
| Build — compile | `npx next build` | **PASS** (`✓ Compiled successfully in 25.9s`) |
| Build — TypeScript | `npx next build` | **PASS** (`Finished TypeScript in 23.6s`) |
| Build — page data | `npx next build` | **FAIL — environmental** |

**The page-data failure is not caused by this phase.** It fails with:

```
PrismaClientInitializationError: Missing configured driver adapter.
Engine type `client` requires an active driver adapter.
    at module evaluation (src/lib/db.ts:9:3)
```

`src/lib/db.ts` is **unmodified** by this phase. The cause is that `binaries.prisma.sh` and
`objects.githubusercontent.com` are unreachable from this sandbox (TLS blocked, HTTP `000`),
so the Prisma client had to be generated with `PRISMA_CLIENT_ENGINE_TYPE=client` and no query
engine binary. Verified: `node_modules/@prisma/engines/` contains only a 17-byte dummy
`schema-engine` and **no** `query-engine` or `.so` at all.

**Attributed by building the pristine baseline.** `ed7a2f3` was checked out into a separate
worktree with a real (hard-linked) `node_modules` and built with the identical command and
environment. It failed at the **same route** (`/api/admin/ai-generate-quiz`) with the
**same error** and the same `clientVersion: '6.19.3'` / `errorCode: 'P2038'`. Both branches
passed compile and TypeScript first.

`no skipLibCheck` was substituted for the typecheck or build result.

Note: `next build` also refuses to start without `SECURITY_HASH_SECRET` when
`NODE_ENV=production` — the repo's own production guard working correctly. A locally
generated 64-hex value was used for the build gate only; no environment variable was set
anywhere persistent, and no production env was touched.

---

## 33. Fix policy, gaps, and stop conditions

**No STOP condition was triggered.** No destructive migration was needed, and no major
architecture conflict was found. The freeze was implemented as additive nullable columns
rather than by changing the meaning of existing ones, so no reconciliation pass was required.

**Deliberate behaviour changes** (not bugs — each is pinned by an assertion):

1. `EXPIRED` is terminal → an expired timer now needs an Admin grant.
2. A `BLUEPRINT` quiz serves `questions: []` pre-`/start`.
3. The student retry button is removed, replaced by `course.031`.
4. `POST /submit` has no retake path and never creates an attempt.

**Gap audit:**

| # | Gap | Severity | Launch blocker? |
|---|---|---|---|
| 1 | Teacher analytics is **all-attempts**, not latest-attempt; a retry moves the teacher's average | MEDIUM | **No** — documented (§20), no fake data, no double counting. Product decision, not a defect |
| 2 | No notification when a retry is granted or consumed | LOW | **No** — student learns on next visit via `pendingRetryGrants` |
| 3 | `EXPIRED` attempts are terminal, so an expired timer needs Admin intervention | LOW | **No** — intended by the one-attempt rule; needs an ops note |
| 4 | `next build` page-data collection cannot run in this sandbox | MEDIUM | **No** — pre-existing at baseline; **must be re-run in CI/Vercel before Go-Live** |
| 5 | Count assertions are scattered across five files, not centralised | LOW | **No** — tech debt; adding one migration touched six suites |
| 6 | Three copies of the migration skip list exist (`migrate-sqlite.mjs`, `verify-phase13-db.mjs`, `verify-phase14-db.mjs`) | LOW | **No** — all three were updated; a future schema change must patch all three |
| 7 | The 26D verifier's original QUIZ-21 variation assertion was **flaky (~3%)** | MEDIUM | **No** — found and fixed during this phase; it now runs 15/15 clean (§29). Worth noting because it was invisible until it fired |
| 8 | `QuizAnswer.question` is still `onDelete: Cascade`, so history protection is **application-layer only**. Any future path that deletes a `Question` without `canDeleteQuestion` would destroy frozen history. A schema-level fix (`SET NULL`/`RESTRICT`) is **not expressible here**: SQLite rejects `DROP CONSTRAINT`/`ALTER COLUMN` and one `migration.sql` runs verbatim on both dialects; `SET NULL` would also break legacy NULL-snapshot rows that still read the live question | MEDIUM | **No** — the only two delete routes are guarded and lock-serialized (§12c); the hazard is proven and pinned by a test so it cannot be forgotten (§12b, §5c) |
| 9 | The SQLite test harness emits **no foreign keys** and leaves `PRAGMA foreign_keys` off, so it cannot observe cascade behaviour at all | MEDIUM | **No** — this is why the hazard was invisible; worked around by asserting the cascade directly against a FK-enabled SQLite DB (§5c). Worth fixing properly in the harness later |
| 10 | **The PostgreSQL concurrency proof has not been executed** — no PostgreSQL, Docker, or package/network install was available in this sandbox | **HIGH** | **No, but it must run in CI before Go-Live.** `tests/phase26d-concurrency-postgres.test.js` is written, self-skipping (exit 0 + `PHASE26D_CONCURRENCY_SKIPPED`), and refuses production/Neon URLs. Until it is green against a real PostgreSQL, the concurrency invariant rests on the mechanism assertions and documented lock reasoning, **not** on an observed race (§12c) |

**Launch-blocker checklist from the brief — all cleared:**

| Blocker | Status |
|---|---|
| Unlimited normal retakes | **REMOVED** — `/start` decides via `decideAttemptStart`; `submit` cannot create |
| No one-attempt enforcement | **DONE** — `maxAttempts` default 1 + unique `(quizId, studentId, attemptNumber)` |
| Client-controlled question selection | **DONE** — `/start` reads no ids; pool withheld pre-start |
| Non-frozen attempts | **DONE** — 10 snapshot columns, graded against the freeze |
| No Admin-only retry gate | **DONE** — no teacher route exists; 403 verified for Teacher and Student |
| History destruction on retry | **DONE** — additive grant row; prior attempts preserved |
| Wrong-track question leakage | **DONE** — track filter inside the selector; `eligibleSize` reported |
| Answer-key leakage | **DONE** — one rule in `buildAttemptInspection`; forced off while OPEN |
| Unauthorized attempt inspection | **DONE** — Admin/Teacher/Student surfaces each scope-checked |
| **Frozen history destroyed by Question deletion** | **DONE (sequentially)** — delete refused (409) while referenced; proven by QUIZ-31 across all 10 required cases (§12b) |
| **Frozen history destroyed by a CONCURRENT delete + start** | **MECHANISM DONE, PG PROOF PENDING** — shared `pg_advisory_xact_lock` on both sides, asserted behaviourally and at every call site (QUIZ-33). The race itself cannot be hosted on SQLite; `tests/phase26d-concurrency-postgres.test.js` must run green in CI (§12c, gap 10) |

**Additional defects found by the QA half of this phase and fixed:**

1. Cross-teacher homework grading (§9) — a real authorization gap plus an unhandled 500.
2. The lying template-delete response (§21) — a write endpoint reporting success for a no-op.
3. A **flaky assertion in this phase's own verifier** (§29) — replaced with a deterministic
   proof. Recorded because a gate that fails 3% of runs is worse than no gate: it teaches
   people to re-run instead of read.

**Schema / migration status of the history-integrity closeout:** **no schema change, no new
migration.** The `QuizAnswer.question` relation line is byte-identical to `HEAD`
(`git diff HEAD -- prisma/schema.prisma` shows no change to it). The fix is confined to
`src/lib/teacher-content.ts` and the two delete routes. The 12-migration chain still rehearses
clean (`verify-phase21-migration.mjs` → 28 passed, 0 failed) and
`make-postgres-schema.mjs --check` still reports both Postgres artifacts in sync.

**Files changed by the history-integrity closeout (C):**

| File | Change |
|---|---|
| `src/lib/teacher-content.ts` | `loadQuestionReferences` now takes an optional transaction client |
| `src/app/api/teacher/questions/[id]/route.ts` | reference check + delete wrapped in one `db.$transaction`; blockers carried out via `QuestionDeleteBlockedError` |
| `src/app/api/teacher/quizzes/[id]/route.ts` | same transactional treatment for the `Quiz → Question → QuizAnswer` cascade path (the concurrency lock that actually closes the race is added in closeout D — see §12c) |
| `scripts/verify-phase26d-teacher.mjs` | new sections X (QUIZ-31, 27 assertions) and Y (QUIZ-32, 10 assertions) |
| `tests/phase26d-teacher-full-flow.test.js` | new §5b source pins, §5c FK-enabled cascade proof, verifier floor raised to 270 |
| `tests/teacher-workflow-phase18.test.js` | three source pins repointed from the pre-refactor shape to the transactional one (same invariants) |

**Files changed by the concurrency closeout (D):**

| File | Change |
|---|---|
| `src/lib/db-serialization.ts` | new `quizDestructiveLockId` + `acquireQuizDestructiveLock` (namespaced, parameterized, provider-gated) |
| `src/lib/session-quiz.ts` | `seedAttemptQuestions` accepts a `tx` client and writes through it |
| `src/app/api/quizzes/[id]/start/route.ts` | takes the lock as the transaction's first statement; freeze moved **inside** the transaction on both the create and resume paths |
| `src/app/api/teacher/questions/[id]/route.ts` | takes the lock (keyed by owning quiz) before reading references |
| `src/app/api/teacher/quizzes/[id]/route.ts` | takes the lock (keyed by quiz) before counting attempts |
| `scripts/verify-phase26d-teacher.mjs` | new section Z (QUIZ-33, 29 assertions) |
| `tests/phase26d-concurrency-postgres.test.js` | **new** — real 2-connection READ COMMITTED proof; self-skipping, CI-gated |
| `tests/phase26d-teacher-full-flow.test.js` | new §5d concurrency pins; verifier floor raised to 300 |
| `tests/production-storage-phase21.test.js`, `tests/security-audit-gate.test.js` | unchanged — the lock-only raw-SQL guards were kept strict; the new helper's prose was reworded so it does not trip them |
| `tests/track-architecture-phase12.test.js` | one pin repointed at the in-transaction freeze (same invariant, asserted on both paths) |

**Not started (out of scope):** `docs/PLATFORM_ROLE_CAPABILITIES.md` (belongs to Phase 26H).
Phase 26E was not started.

**Nothing was committed, pushed, or opened as a PR. No deploy. Neon, R2, SMTP, and Vercel
were not touched. All writes were to local SQLite in temp directories.**
