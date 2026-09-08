// CodeMind Academy — Official curriculum reconciliation runner (Phase 11).
//
// Reconciles docs/curriculum/knowledge-model.json (the authoritative R2
// contract) into the database as the canonical curriculum and archives the
// legacy R1 lessons WITHOUT deleting any row.
//
// SAFE: idempotent (re-running converges to the same state), scoped to the
// known course slug, create-mostly (the only UPDATEs are canonical-field
// alignment + the archival flag flip). Crash-safe by re-run.
//
// Run with: npx tsx scripts/reconcile-curriculum.ts
// (or: bun run scripts/reconcile-curriculum.ts)
import { db } from "../src/lib/db";
import { reconcileOfficialCurriculum } from "../src/lib/official-curriculum";

async function main() {
  console.log("🧭 Reconciling official curriculum from knowledge-model.json ...");
  const report = await reconcileOfficialCurriculum();
  console.log(`  ✓ Course: ${report.courseSlug} (${report.courseId})${report.courseCreated ? " [created]" : ""}`);
  console.log(`  ✓ Model version: ${report.modelVersion}`);
  console.log(`  ✓ Parts reconciled: ${report.partsReconciled} (${report.partsCreated} created)`);
  console.log(`  ✓ Units reconciled: ${report.unitsReconciled} (${report.unitsCreated} created)`);
  console.log(
    `  ✓ Official lessons: ${report.officialLessonCodes.length} ` +
      `(${report.lessonsCreated} created, ${report.lessonsUpdated} updated)`
  );
  console.log(`  ✓ Legacy lessons archived (rows preserved): ${report.archivedLessonIds.length}`);
  for (const w of report.warnings) console.log(`  ! WARNING: ${w}`);
  console.log("✅ Official curriculum reconciliation complete!");
}

main()
  .then(async () => {
    await db.$disconnect();
  })
  .catch(async (e) => {
    console.error("❌ Reconciliation failed:", e);
    await db.$disconnect();
    process.exit(1);
  });
