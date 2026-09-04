// CodeMind Academy — Curriculum restoration script.
// Parses src/lib/curriculum.ts and seeds it back into the database,
// restoring accidentally deleted course records.
//
// SAFE: create-only + idempotent. Re-running never duplicates content,
// never deletes anything, and the code backfill only fills NULL codes.
// See docs/DATABASE_MIGRATION.md for the full migration checklist.
//
// Run with: npx tsx scripts/seed-curriculum.ts
// (or: bun run scripts/seed-curriculum.ts)
import { db } from "../src/lib/db";
import { backfillStudentCodes, seedCurriculumFromFile } from "../src/lib/curriculum-seed";

async function main() {
  console.log("🌱 Restoring curriculum from src/lib/curriculum.ts ...");
  const result = await seedCurriculumFromFile();
  console.log(`  ✓ ${result.message} (course: ${result.courseId})`);

  // Backfill missing student codes for pre-migration students.
  const filled = await backfillStudentCodes();
  console.log(`  ✓ Backfilled ${filled} student code(s) (0 = nothing to do)`);

  console.log("✅ Curriculum restore complete!");
}

main()
  .then(async () => {
    await db.$disconnect();
  })
  .catch(async (e) => {
    console.error("❌ Seed error:", e);
    await db.$disconnect();
    process.exit(1);
  });
