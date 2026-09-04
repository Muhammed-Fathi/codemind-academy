# CodeMind Academy — Production Database Migration Checklist

**Scope:** add 4 new `Student` columns (`studentCode`, `nationalId`, `parentPhone`,
`schoolType`) to the existing production SQLite database (`db/custom.db`).

**Rules followed:** the database file is NEVER committed to Git (already ignored:
`*.db`, `*.db-journal`, `/db/` in `.gitignore`; verified no `.db` file is tracked).
No reset / seed / overwrite of existing data. Everything below is additive-only.

---

## 0. Backup (do this first — rollback = restore this file)

```bash
cd /path/to/codemind-academy
cp db/custom.db "db/custom.db.bak-$(date +%Y%m%d)"
ls -la db/custom.db*
```

Verify the backup opens and row counts match (see §5 queries). Keep this file
until the migration is confirmed working in production.

---

## 1. Schema changes (what the migration adds)

| Table     | Change                                              | Nullable | Notes                                                    |
| --------- | --------------------------------------------------- | -------- | -------------------------------------------------------- |
| `Student` | `+ studentCode TEXT` + UNIQUE index                 | YES      | Auto `CM-XXXXXX` for new students; backfilled for old    |
| `Student` | `+ nationalId TEXT` + UNIQUE index                  | YES      | Egyptian 14-digit ID, validated at registration          |
| `Student` | `+ parentPhone TEXT`                                | YES      | Used for parent↔student verification                     |
| `Student` | `+ schoolType TEXT`                                 | YES      | `LANGUAGE` \| `ARABIC`                                   |

Why this is safe on SQLite:
- `ALTER TABLE … ADD COLUMN` **without a DEFAULT is metadata-only**: no table
  rewrite, no row is modified, existing values are untouched.
- All columns are **NULLABLE**, so every pre-existing row stays valid.
- SQLite permits **unlimited NULLs in UNIQUE indexes**, so the two new UNIQUE
  indexes succeed even though all existing rows are NULL there.
- The migration file contains **zero** `DROP` / `DELETE` / `TRUNCATE` / `UPDATE`
  statements (machine-checked in CI simulation, 15/15 assertions passing).

---

## 2. Migration command(s) — pick ONE

### Option A — Prisma (recommended when network allows engine download)

```bash
npx prisma db push
```

`db push` diffs `prisma/schema.prisma` against the database and applies only the
additive changes above. It never deletes data for additive diffs.

### Option B — Offline SQL (exact equivalent, no network needed)

```bash
# 0) Pre-check — skip already-applied columns (makes re-runs safe):
sqlite3 db/custom.db "PRAGMA table_info(Student);"
# If studentCode/nationalId/parentPhone/schoolType are already listed, STOP —
# the migration is already applied.

# 1) Apply (file: prisma/migrations/20260905_add_student_identity_fields/migration.sql):
sqlite3 db/custom.db < prisma/migrations/20260905_add_student_identity_fields/migration.sql

# 2) Confirm:
sqlite3 db/custom.db "PRAGMA table_info(Student); PRAGMA index_list(Student);"
```

No `sqlite3` CLI? Equivalent with Node ≥ 22 (uses the built-in `node:sqlite`):

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const fs=require('fs');
const db=new DatabaseSync('db/custom.db');
const cols=db.prepare('PRAGMA table_info(Student)').all().map(c=>c.name);
if(['studentCode','nationalId','parentPhone','schoolType'].every(c=>cols.includes(c))){
  console.log('Migration already applied — nothing to do.');process.exit(0);
}
const sql=fs.readFileSync('prisma/migrations/20260905_add_student_identity_fields/migration.sql','utf8')
  .split('\n').filter(l=>!l.trim().startsWith('--')).join('\n');
for(const s of sql.split(';').map(s=>s.trim()).filter(Boolean)) db.exec(s);
console.log('Migration applied.');
db.close();"
```

### Afterwards (required): regenerate the Prisma client

```bash
npx prisma generate
```

The new code reads/writes `studentCode` etc. An outdated generated client would
reject those fields at runtime (`Unknown argument`), so this step is mandatory
after either option.

---

## 3. Curriculum seed command (idempotent restore)

Only needed if the Admin → Courses panel is empty (accidentally deleted rows).
**Safe to run any number of times:** creates the course tree only when the
course has zero parts; otherwise reports `already seeded` and changes nothing.
Never updates/deletes unrelated rows. The student-code backfill only fills
`NULL`/`""` codes and never rewrites an existing code.

```bash
npx tsx scripts/seed-curriculum.ts
# …or: bun run scripts/seed-curriculum.ts
# …or in production UI: Admin → Courses → «استعادة المنهج»
```

### Expected records/counts after seeding

Parsed from `src/lib/curriculum.ts` (verified by test):

| Level   | Count |
| ------- | ----- |
| Course  | 1 (`slug = programming-ai-2nd-sec`) |
| Parts   | 2 |
| Units   | 7 |
| Topics  | 17 |
| Lessons | 36 |

Verify with (replace `db/custom.db` with your path):

```bash
sqlite3 db/custom.db \
  "SELECT (SELECT COUNT(*) FROM Course WHERE slug='programming-ai-2nd-sec') AS course,
          (SELECT COUNT(*) FROM Part WHERE courseId=(SELECT id FROM Course WHERE slug='programming-ai-2nd-sec')) AS parts,
          (SELECT COUNT(*) FROM Lesson WHERE topicId IN (SELECT id FROM Topic WHERE unitId IN (SELECT id FROM Unit WHERE partId IN (SELECT id FROM Part WHERE courseId=(SELECT id FROM Course WHERE slug='programming-ai-2nd-sec'))))) AS lessons;"
# Expected: course=1 parts=2 lessons=36
```

---

## 4. Backfill check — existing students receive codes safely

The seed script (and every new registration) assigns `CM-XXXXXX` codes with a
pre-check **plus** retry-on-`P2002`, so the UNIQUE index can never fail the run,
even with thousands of existing rows or concurrent executions.

```bash
# Before: how many students lack a code?
sqlite3 db/custom.db "SELECT COUNT(*) FROM Student WHERE studentCode IS NULL OR studentCode='';"
# After seeding: must be 0, and all codes unique + well-formed:
sqlite3 db/custom.db "SELECT COUNT(*), COUNT(DISTINCT studentCode) FROM Student WHERE studentCode IS NOT NULL AND studentCode<>'';"
# (the two numbers must be equal)
sqlite3 db/custom.db "SELECT studentCode FROM Student WHERE studentCode NOT GLOB 'CM-??????';"
# (must return zero rows)
```

---

## 5. Verification queries/checks (post-migration)

```bash
DB=db/custom.db
sqlite3 $DB "SELECT COUNT(*) AS users FROM User;"
sqlite3 $DB "SELECT COUNT(*) AS students FROM Student;"
sqlite3 $DB "SELECT COUNT(*) AS settings FROM Setting;"
sqlite3 $DB "SELECT COUNT(*) AS plans FROM SubscriptionPlan;"
# ^ Compare each against the numbers you recorded BEFORE migrating — must match.

sqlite3 $DB "PRAGMA table_info(Student);"
# ^ Must list studentCode, nationalId, parentPhone, schoolType (all, notnull=0).

sqlite3 $DB "PRAGMA index_list(Student);"
# ^ Must include Student_studentCode_key and Student_nationalId_key (unique=1).

# App-level smoke test (after `prisma generate` + restart):
#  1. Register a new STUDENT → succeeds, code CM-XXXXXX shown, visible in profile.
#  2. Register a PARENT with that student's national ID + parent phone + code → linked.
#  3. Wrong parent phone → rejected with mismatch error.
#  4. Admin → Students shows the code column; Teacher attendance shows codes.
#  5. Admin → Courses: tree opens; «استعادة المنهج» re-run reports already-seeded.
```

---

## 6. Rollback / backup instructions

- **Migration rollback:** the change is purely additive. If anything misbehaves,
  stop the app and restore the backup file:
  ```bash
  cp "db/custom.db.bak-YYYYMMDD" db/custom.db
  npx prisma generate   # re-sync client with restored DB state
  ```
  No down-migration script is needed (there is nothing to "un-delete").
- **Seed rollback:** the seeder only *adds* curriculum rows. If seeded by
  mistake on a DB that already had courses, it adds exactly one extra course
  tree (it never merges into existing courses). Remove it explicitly if needed:
  ```bash
  sqlite3 db/custom.db "PRAGMA foreign_keys=ON; DELETE FROM Course WHERE slug='programming-ai-2nd-sec';"
  ```
  (Cascades clean up its parts/units/topics/lessons. Backfilled student codes
  are intentionally kept — they are required for parent linking.)
- **Never run** `prisma migrate reset`, `prisma db push --accept-data-loss`
  with a destructive diff, or any `DELETE FROM User/Setting/SubscriptionPlan`
  against production.

---

## 7. Compatibility notes (code ↔ schema)

- All new-field reads/writes go through Prisma model fields that now exist in
  `prisma/schema.prisma`; queries use `findUnique` only on UNIQUE fields
  (`studentCode`, `nationalId`, `email`, `id`) and `findFirst` on the
  `(nationalId, studentCode)` pair — all index-backed.
- `nationalId`/`studentCode` lookups against pre-migration rows simply return
  no match (NULL ≠ value), so parent linking correctly reports "not found"
  until the student re-registers or an admin fills the fields — no crashes.
- Static/type/lint/unit verification for this change set:
  `npx tsc --noEmit` (zero new errors vs baseline),
  `npx eslint` on touched files (zero new findings),
  `node tests/seed-idempotency.test.js` (18/18),
  registration validator suite (24/24),
  scratch-DB migration simulation (15/15).
