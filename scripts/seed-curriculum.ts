// CodeMind Academy — Official curriculum reconciliation script.
//
// Phase 11: reconciles the database with the OFFICIAL curriculum
// (docs/curriculum/knowledge-model.json). The legacy synthetic seed
// (src/lib/curriculum.ts + seedCurriculumFromFile) is RETIRED and must never
// run against live data again — this script replaces it.
//
// SAFE: idempotent + archive-based. Re-running never duplicates content and
// never deletes anything: lessons that are not part of the official model
// are flipped to ARCHIVED (their progress, attempts and submissions stay
// intact), and official rows are updated in place only when they differ.
//
// Run with: npx tsx scripts/reconcile-curriculum.ts
// (this file is kept as the historical entry-point name and delegates to
// the same reconciler; prefer scripts/reconcile-curriculum.ts for new use.)
import { db } from "../src/lib/db";
import { backfillStudentCodes } from "../src/lib/curriculum-seed";
import { reconcileOfficialCurriculum } from "../src/lib/official-curriculum";

async function main() {
  console.log("🌱 Reconciling official curriculum from docs/curriculum/knowledge-model.json ...");
  const report = await reconcileOfficialCurriculum(db);
  console.log(`  ✓ Parts: ${report.partsReconciled} (${report.partsCreated} created)`);
  console.log(`  ✓ Units: ${report.unitsReconciled} (${report.unitsCreated} created)`);
  console.log(
    `  ✓ Lessons: ${report.officialLessonCodes.length} official ` +
      `(${report.lessonsCreated} created, ${report.lessonsUpdated} updated)`
  );
  console.log(`  ✓ Archived legacy lessons: ${report.archivedLessonIds.length}`);
  for (const w of report.warnings) console.log(`  ⚠ ${w}`);

  // Backfill missing student codes for pre-migration students.
  const filled = await backfillStudentCodes();
  console.log(`  ✓ Backfilled ${filled} student code(s) (0 = nothing to do)`);

  console.log("✅ Curriculum reconcile complete!");
}

main()
  .then(async () => {
    await db.$disconnect();
  })
  .catch(async (e) => {
    console.error("❌ Reconcile error:", e);
    await db.$disconnect();
    process.exit(1);
  });
